//! Native Connect entry point. Host credentials belong only to this command;
//! the desktop account and other CLI refresh tokens are never read or changed.
use crate::platform;
use crate::relay::{
    cli, cloud_http, cloud_login::DeviceLogin, cloud_session, daemon::SafeError, paths,
    store::CloudSession,
};
use anyhow::{ensure, Result};
use clap::Subcommand;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command as Process, Stdio},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(90);

mod host_state;
mod send;

#[derive(Subcommand)]
pub enum Command {
    /// Create and join a room. Only the host signs in, through the browser.
    Create {
        #[arg(long)]
        task: String,
        #[arg(long, default_value_t = 60, value_parser = clap::value_parser!(u32).range(1..=43200))]
        expires_in_minutes: u32,
        #[arg(long)]
        name: Option<String>,
    },
    /// Join a public invite without signing in.
    Join {
        link: String,
        #[arg(long)]
        name: Option<String>,
    },
    /// Send text from stdin to one participant, or everyone when --to is absent.
    Send {
        #[arg(long)]
        to: Option<String>,
        /// Reconcile a prior uncertain send without sending it twice.
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    Status,
    Leave,
    /// Close the hosted room for everyone. Only its host can do this.
    End,
    /// Keep the hosted room open longer. Only its host can do this.
    Extend {
        /// Minutes to add to the room's current expiry (at most 7 days).
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..=MAX_EXTEND_MINUTES as i64))]
        minutes: u32,
    },
}

/// Cloud extends a room by at most 7 days per call.
const MAX_EXTEND_MINUTES: u32 = 10_080;

#[derive(Serialize, Deserialize)]
struct HostState {
    session: String,
    request: String,
    auth: Option<CloudSession>,
    task: String,
    minutes: u32,
    name: Option<String>,
    link: Option<String>,
    expires_at: Option<String>,
    #[serde(default)]
    host_claim: Option<crate::relay::workspace::Secret>,
}

/// A bounded protocol code, and whether the failed command was a send.
#[derive(Debug)]
struct SocketError(String, bool, Option<String>);
impl std::fmt::Display for SocketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: Relay Connect could not complete this command.",
            self.0
        )?;
        if self.1 {
            if let Some(hint) = send::outcome_hint(&self.0, self.2.as_deref()) {
                write!(f, " {hint}")?;
            }
        }
        Ok(())
    }
}
impl std::error::Error for SocketError {}

/// Cloud's answer that the hosted room is gone for good: it expired, its host
/// ended it, or Cloud no longer knows it. The saved host state can only be
/// discarded; nothing can revive the room.
#[derive(Debug)]
struct RoomGone(String);
impl std::fmt::Display for RoomGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = match self.0.as_str() {
            "connect_expired" => "has expired",
            "connect_ended" => "was ended",
            _ => "no longer exists",
        };
        write!(
            f,
            "This Relay Connect room {what}. Create a new one with connect create."
        )
    }
}
impl std::error::Error for RoomGone {}
fn room_gone(cause: &anyhow::Error) -> bool {
    cause.downcast_ref::<RoomGone>().is_some()
}

/// The terminal Connect error code in a tool result, read from its
/// structured content or, when a server omits that, from its JSON text.
fn terminal_code(body: &Value) -> Option<&'static str> {
    let structured = body["result"]["structuredContent"]["error"]["code"].as_str();
    let text = body["result"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["text"].as_str())
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
        .find_map(|value| value["error"]["code"].as_str().map(str::to_owned));
    let code = structured.map(str::to_owned).or(text)?;
    ["connect_expired", "connect_ended", "connect_not_found"]
        .into_iter()
        .find(|terminal| *terminal == code)
}
/// Whether the saved room's own expiry has passed on this computer's clock.
fn expired_locally(state: &HostState, now_ms: i64) -> bool {
    state
        .expires_at
        .as_deref()
        .and_then(parse_iso_ms)
        .is_some_and(|expiry| expiry <= now_ms)
}
fn valid_name(name: &str) -> bool {
    crate::relay::agents::normalize_name(name).as_deref() == Some(name)
}
fn error(message: impl Into<String>) -> anyhow::Error {
    SafeError(message.into()).into()
}
fn parse_iso_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

fn random_id() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| error("Could not generate a Connect identifier."))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Owned by this user and with no bits in `mask` for anyone else. On
/// Windows both hold for files in the profile (see `platform::fs`).
fn owned_and_private(meta: &fs::Metadata, mask: u32) -> bool {
    platform::fs::owned_by_current_user(meta) && platform::fs::private_to_owner(meta, mask)
}
fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir() && owned_and_private(&meta, 0o022),
        SafeError("Connect directory must be owned by you and not writable by others.".into())
    );
    platform::fs::set_mode(path, 0o700)?;
    Ok(())
}
fn private_file(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_file() && owned_and_private(&meta, 0o077),
        SafeError("Connect state must be a private file owned by you.".into())
    );
    Ok(())
}
/// `options` creating a private file, refusing a symbolic link (Unix).
fn private_options(options: &mut fs::OpenOptions) -> &mut fs::OpenOptions {
    platform::fs::no_follow(platform::fs::private(options))
}
/// Whether the core's socket at `socket` is one this user may trust: a
/// socket file this user owns that no one else may write. On Windows the
/// core listens on a named pipe derived from that path, not a file there;
/// the pipe's access list admits only this user, so the path itself is not
/// checked and the call decides.
#[cfg(unix)]
fn trusted_socket(socket: &Path) -> Result<Option<PathBuf>> {
    use std::os::unix::fs::FileTypeExt;
    if !socket.try_exists()? {
        return Ok(None);
    }
    let m = fs::symlink_metadata(socket)?;
    ensure!(
        m.file_type().is_socket() && owned_and_private(&m, 0o022),
        SafeError("Unsafe Agent Relay socket.".into())
    );
    Ok(Some(socket.to_path_buf()))
}
#[cfg(windows)]
fn trusted_socket(socket: &Path) -> Result<Option<PathBuf>> {
    Ok(Some(socket.to_path_buf()))
}
fn save(path: &Path, state: &HostState) -> Result<()> {
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    // Windows keeps the profile's owner-only access list (see `platform::fs`).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    serde_json::to_writer(&mut tmp, state)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)
        .map_err(|_| error("Could not save the Connect host state."))?;
    Ok(())
}

fn pointed(home: &Path) -> Result<Option<PathBuf>> {
    // Connect hosts belong to Agent Relay itself: a profile or Dev build's
    // pointer is never read here.
    let build = crate::relay::outbound::Build::Production;
    let pointer = crate::relay::outbound::pointer_directory(home).join(build.pointer_name());
    if !pointer.try_exists()? {
        return Ok(None);
    }
    let m = fs::symlink_metadata(&pointer)?;
    ensure!(
        m.is_file() && owned_and_private(&m, 0o022),
        SafeError("Unsafe Agent Relay socket pointer.".into())
    );
    trusted_socket(&cli::pointed_socket(home, &build)?)
}
fn socket_call(socket: &Path, method: &str, path: &str, body: &[u8]) -> Result<Value> {
    socket_call_with_headers(socket, method, path, body, &[])
}
fn socket_call_with_headers(
    socket: &Path,
    method: &str,
    path: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> Result<Value> {
    let (status, bytes) =
        cli::socket_response_with_headers(socket, method, path, body, TIMEOUT, headers)?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| error("Unreadable Connect response."))?;
    if !(200..300).contains(&status) || value["ok"] != true {
        let code = value["error"]["code"]
            .as_str()
            .unwrap_or("connect_unavailable");
        // Only a bounded protocol code is printed, never a response body/token.
        let code = if code.len() <= 80 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        {
            code
        } else {
            "connect_unavailable"
        };
        return Err(SocketError(code.to_owned(), false, None).into());
    }
    Ok(value["data"].clone())
}
fn ensure_probe(home: &Path, start: bool) -> Result<PathBuf> {
    if let Some(socket) = pointed(home)? {
        if socket_call(&socket, "GET", "/setup/status", &[]).is_ok() {
            return Ok(socket);
        }
        // Never kill an existing daemon or delete its socket. Its instance lock
        // arbitrates a stale pointer against a concurrently starting core.
    }
    ensure!(
        start,
        SafeError("No running relay. Use connect create or connect join first.".into())
    );
    let dir = home.join(".agentworkforce/connect-cli");
    private_directory(&dir)?;
    let log = private_options(fs::OpenOptions::new().append(true).create(true))
        .open(dir.join("probe.log"))?;
    let mut command = Process::new(std::env::current_exe()?);
    command
        .args(["serve", "--headless", "--connect-ephemeral"])
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // This child owns only its new session; existing cores are never signalled.
    platform::process::new_session(&mut command);
    let mut child = command.spawn()?;
    for _ in 0..100 {
        if let Some(socket) = pointed(home)? {
            if socket_call(&socket, "GET", "/setup/status", &[]).is_ok() {
                return Ok(socket);
            }
        }
        let _ = child.try_wait()?; // a competing core may own the lock
        std::thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(error(
        "The headless probe did not become ready. Check ~/.agentworkforce/connect-cli/probe.log.",
    ))
}

fn mcp_result(value: Value) -> Result<Value> {
    if value.get("error").is_some() || value["result"]["isError"] == true {
        return Err(error("Cloud could not complete the Connect operation. Retry the same command; host state was retained."));
    }
    value["result"]["structuredContent"]
        .as_object()
        .map(|_| value["result"]["structuredContent"].clone())
        .ok_or_else(|| error("Cloud returned an unreadable Connect result."))
}
fn mcp(state: &HostState, tool: &str, arguments: Value) -> Result<Value> {
    let session = state
        .auth
        .as_ref()
        .ok_or_else(|| error("Host sign-in is missing."))?;
    let site = crate::relay::links::built_in_site_url();
    ensure!(
        session.site_url == site,
        SafeError("Host credentials belong to another site.".into())
    );
    let answer = cloud_http::send_blocking_with_headers("POST", &format!("{site}/cloud/api/v1/mcp/shared-sessions"),
        Some(session.access_token.expose()),
        &[("Mcp-Session-Id", &state.session), ("MCP-Protocol-Version", "2025-03-26"), ("Accept", "application/json, text/event-stream")],
        Some(&json!({"jsonrpc":"2.0","id":state.request,"method":"tools/call","params":{"name":tool,"arguments":arguments}})), TIMEOUT)
        .map_err(|_| error("Cloud request was interrupted. Retry the same command; host state was retained."))?;
    ensure!(
        answer.ok(),
        SafeError(format!(
            "Cloud refused Connect (HTTP {}). Host state was retained.",
            answer.status
        ))
    );
    tool_result(tool, answer.body)
}
/// A tool's answer. A room that is already gone counts as ended for
/// `end_connect`; for any other tool it is a [`RoomGone`] error.
fn tool_result(tool: &str, body: Value) -> Result<Value> {
    if let Some(code) = terminal_code(&body) {
        if tool == "end_connect" {
            return Ok(json!({"ended":true}));
        }
        return Err(RoomGone(code.to_owned()).into());
    }
    mcp_result(body)
}
fn login(path: &Path, state: &mut HostState) -> Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    if let Some(session) = &state.auth {
        if cloud_session::access_is_fresh(
            session,
            Duration::from_secs(120),
            crate::relay::state::now_ms(),
        ) {
            return Ok(());
        }
        if cloud_session::can_refresh(session, crate::relay::state::now_ms()) {
            state.auth = Some(rt.block_on(cloud_session::refresh(session)).map_err(|_| error("Host sign-in could not be refreshed. Retry, or sign in again after the room expires."))?);
            return save(path, state);
        }
    }
    let grant = rt
        // Relay Connect's host is not the desktop installation: an
        // ordinary device login, without the desktop proof.
        .block_on(DeviceLogin::begin(
            crate::relay::links::built_in_site_url(),
            None,
        ))
        .map_err(|e| error(e.to_string()))?;
    let approval = grant
        .verification_url_complete
        .as_ref()
        .unwrap_or(&grant.verification_url);
    eprintln!("Approve Relay Connect host sign-in: {approval}");
    if let Some(code) = &grant.user_code {
        eprintln!("Check this code: {code}");
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = Process::new(opener)
        .arg(approval)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    state.auth = Some(
        rt.block_on(grant.poll())
            .map_err(|e| error(e.to_string()))?,
    );
    save(path, state)
}
fn join(socket: &Path, link: &str, name: Option<&str>, claim: Option<&str>) -> Result<Value> {
    let mut body = json!({"link":link});
    if let Some(name) = name {
        body["name"] = json!(name);
    }
    if let Some(claim) = claim {
        body["host_claim"] = json!(claim);
    }
    socket_call(socket, "POST", "/connect/join", &serde_json::to_vec(&body)?)
}

trait HostServices {
    fn authenticate(&mut self, path: &Path, state: &mut HostState) -> Result<()>;
    fn call(&mut self, state: &HostState, tool: &str, args: Value) -> Result<Value>;
    fn join(&mut self, link: &str, name: Option<&str>, claim: &str) -> Result<Value>;
}
struct LiveHost<'a>(&'a Path);
impl HostServices for LiveHost<'_> {
    fn authenticate(&mut self, path: &Path, state: &mut HostState) -> Result<()> {
        login(path, state)
    }
    fn call(&mut self, state: &HostState, tool: &str, args: Value) -> Result<Value> {
        mcp(state, tool, args)
    }
    fn join(&mut self, link: &str, name: Option<&str>, claim: &str) -> Result<Value> {
        join(self.0, link, name, Some(claim))
    }
}
fn complete_create(
    path: &Path,
    state: &mut HostState,
    services: &mut impl HostServices,
) -> Result<Value> {
    services.authenticate(path, state)?;
    let mut args = json!({"task":state.task,"expires_in_minutes":state.minutes});
    if let Some(name) = &state.name {
        args["agent_name"] = json!(name);
    }
    if state.link.is_none() || state.host_claim.is_none() {
        let created = services.call(state, "create_connect", args)?;
        state.link = Some(
            created["link"]
                .as_str()
                .ok_or_else(|| error("Cloud returned no invite link."))?
                .to_owned(),
        );
        state.host_claim = Some(crate::relay::workspace::Secret::new(
            created["host_claim"]
                .as_str()
                .ok_or_else(|| error("Cloud returned no private host claim."))?,
        ));
        state.expires_at = Some(
            created["expires_at"]
                .as_str()
                .filter(|expiry| parse_iso_ms(expiry).is_some())
                .ok_or_else(|| error("Cloud returned no room expiry."))?
                .to_owned(),
        );
        save(path, state)?;
    }
    let link = state.link.as_deref().unwrap();
    let claim = state.host_claim.as_ref().unwrap().expose();
    let joined = match services.join(link, state.name.as_deref(), claim) {
        Err(cause)
            if cause
                .downcast_ref::<SocketError>()
                .is_some_and(|e| e.0 == "connect_claim_invalid") =>
        {
            // A definitive invalid-claim response clears the probe's pending
            // join. Unlike a timeout, it is safe to rotate and retry once.
            let fresh = services.call(state, "connect_status", json!({}))?;
            state.host_claim = Some(crate::relay::workspace::Secret::new(
                fresh["host_claim"]
                    .as_str()
                    .ok_or_else(|| error("Cloud returned no replacement host claim."))?,
            ));
            save(path, state)?;
            services.join(
                state.link.as_deref().unwrap(),
                state.name.as_deref(),
                state.host_claim.as_ref().unwrap().expose(),
            )?
        }
        result => result?,
    };
    ensure!(
        joined["role"] == "host",
        SafeError("The probe did not attach the host identity. Retry create.".into())
    );
    Ok(
        json!({"link":link,"expires_at":state.expires_at,"agent_name":joined["agent_name"],"share_text":format!("Go to https://agentrelay.com/connect and join {link} for me. Install the headless relay if needed.")}),
    )
}
fn complete_end(
    path: &Path,
    state: &mut HostState,
    services: &mut impl HostServices,
) -> Result<Value> {
    // Cloud decides when a room ends, not this computer's clock: a host clock
    // running ahead must not discard the authority to end a live room. Cloud
    // answers a room that is already gone with a terminal code, which counts
    // as ended.
    services.authenticate(path, state)?;
    let ended = services.call(state, "end_connect", json!({}))?;
    ensure!(
        ended["ended"] == true,
        SafeError("Cloud did not confirm the room ended.".into())
    );
    fs::remove_file(path)?;
    Ok(ended)
}
/// Extend the hosted room by `minutes` and record the expiry Cloud reports.
/// A room that is already gone cannot be extended, so its state is discarded
/// and the host is told to create a new one.
fn complete_extend(
    path: &Path,
    state: &mut HostState,
    minutes: u32,
    services: &mut impl HostServices,
) -> Result<Value> {
    ensure!(
        state.link.is_some(),
        SafeError("This coding session's room was never created. Run connect create.".into())
    );
    ensure!(
        (1..=MAX_EXTEND_MINUTES).contains(&minutes),
        SafeError(format!(
            "A Relay Connect room can be extended by at most {MAX_EXTEND_MINUTES} minutes (7 days)."
        ))
    );
    // As with end, Cloud decides whether the room is still open.
    services.authenticate(path, state)?;
    let extended = match services.call(
        state,
        "extend_connect",
        json!({"extend_by_minutes":minutes}),
    ) {
        Err(cause) if room_gone(&cause) => {
            fs::remove_file(path)?;
            return Err(cause);
        }
        result => result?,
    };
    // A success without a readable expiry cannot be recorded, so it is not
    // reported as an extension.
    let expiry = extended["expires_at"]
        .as_str()
        .filter(|expiry| parse_iso_ms(expiry).is_some())
        .ok_or_else(|| {
            error("Cloud did not report the room's new expiry. Run connect status to check it.")
        })?;
    state.expires_at = Some(expiry.to_owned());
    save(path, state)?;
    Ok(json!({"link":state.link,"expires_at":state.expires_at}))
}
/// Drop a saved room Cloud reports gone, so `connect create` can start a new
/// one. Only a created room asked to change (another task, duration or name)
/// is checked: repeating the original command resumes it as before, and a
/// room past its own expiry is dropped by [`host_state::for_create`].
/// Cloud's clock decides, not this computer's: a room can close before the
/// expiry saved here.
fn discard_if_gone(
    path: &Path,
    saved: Option<HostState>,
    task: &str,
    minutes: u32,
    name: &Option<String>,
    services: &mut impl HostServices,
) -> Result<Option<HostState>> {
    let Some(mut state) = saved else {
        return Ok(None);
    };
    let unchanged = state.task == task && state.minutes == minutes && &state.name == name;
    if state.link.is_none() || unchanged || expired_locally(&state, crate::relay::state::now_ms()) {
        return Ok(Some(state));
    }
    services.authenticate(path, &mut state)?;
    match services.call(&state, "connect_status", json!({})) {
        Err(cause) if room_gone(&cause) => {
            fs::remove_file(path)?;
            Ok(None)
        }
        Err(cause) => Err(cause),
        Ok(status) => {
            // Each host status issues a new claim and invalidates the saved one.
            if let Some(claim) = status["host_claim"].as_str() {
                state.host_claim = Some(crate::relay::workspace::Secret::new(claim));
                save(path, &state)?;
            }
            Ok(Some(state))
        }
    }
}

pub fn run(command: Command) -> Result<()> {
    run_inner(command).map_err(|cause| {
        if let Some(socket) = cause.downcast_ref::<SocketError>() {
            error(socket.to_string())
        } else if let Some(gone) = cause.downcast_ref::<RoomGone>() {
            error(gone.to_string())
        } else {
            cause
        }
    })
}
fn run_inner(command: Command) -> Result<()> {
    match &command {
        Command::Create { task, name, .. } => {
            ensure!(
                !task.trim().is_empty() && task.len() <= 16_000,
                SafeError("The task must contain 1–16000 bytes.".into())
            );
            ensure!(name.as_deref().is_none_or(valid_name), SafeError("Use a name of 2–48 lowercase letters, numbers or hyphens, starting and ending with a letter or number.".into()));
        }
        Command::Join { name, .. } => ensure!(
            name.as_deref().is_none_or(valid_name),
            SafeError("Use a valid 2–48 character agent name.".into())
        ),
        _ => {}
    }
    let home = paths::home()?;
    let start = matches!(
        &command,
        Command::Create { .. } | Command::Join { .. } | Command::End | Command::Extend { .. }
    );
    let socket = ensure_probe(&home, start)?;
    let result = match command {
        Command::Join { link, name } => join(&socket, &link, name.as_deref(), None)?,
        Command::Status => socket_call(&socket, "GET", "/connect/status", &[])?,
        Command::Leave => socket_call(&socket, "POST", "/connect/leave", &[])?,
        Command::Send {
            to,
            idempotency_key,
        } => send::run(&socket, to, idempotency_key)?,
        command @ (Command::Create { .. } | Command::End | Command::Extend { .. }) => {
            let who = socket_call(&socket, "GET", "/whoami", &[])?;
            let target = who["session_id"]
                .as_str()
                .ok_or_else(|| error("Run Connect from your coding agent's own terminal."))?;
            let dir = home.join(".agentworkforce/connect-cli");
            private_directory(&dir)?;
            let key = format!("{:x}", Sha256::digest(target.as_bytes()));
            let path = dir.join(format!("{key}.json"));
            let lock = private_options(fs::OpenOptions::new().read(true).write(true).create(true))
                .open(dir.join(format!("{key}.lock")))?;
            lock.try_lock_exclusive()
                .map_err(|_| error("Another Connect host command is running in this session."))?;
            let saved: Option<HostState> = if path.try_exists()? {
                private_file(&path)?;
                Some(serde_json::from_slice(&fs::read(&path)?)?)
            } else {
                None
            };
            match command {
                Command::Create {
                    task,
                    expires_in_minutes,
                    name,
                } => {
                    ensure!(
                        !task.trim().is_empty() && task.len() <= 16_000,
                        SafeError("The task must contain 1–16000 bytes.".into())
                    );
                    let saved = discard_if_gone(
                        &path,
                        saved,
                        &task,
                        expires_in_minutes,
                        &name,
                        &mut LiveHost(&socket),
                    )?;
                    let mut state = host_state::for_create(saved, task, expires_in_minutes, name)?;
                    if let Ok(current) = socket_call(&socket, "GET", "/connect/status", &[]) {
                        ensure!(
                            state
                                .link
                                .as_deref()
                                .and_then(|link| link.rsplit('/').next())
                                == current["connect_id"].as_str()
                                && current["role"] == "host",
                            SafeError("Leave the current room before creating another.".into())
                        );
                    }
                    save(&path, &state)?;
                    complete_create(&path, &mut state, &mut LiveHost(&socket))?
                }
                Command::End => {
                    let mut state = saved
                        .ok_or_else(|| error("This coding session has no hosted Connect room."))?;
                    let ended = complete_end(&path, &mut state, &mut LiveHost(&socket))?;
                    // Never leave a different room the host joined after leaving
                    // its own room. Terminal reconciliation may already have left.
                    if let Ok(current) = socket_call(&socket, "GET", "/connect/status", &[]) {
                        if state
                            .link
                            .as_deref()
                            .and_then(|link| link.rsplit('/').next())
                            == current["connect_id"].as_str()
                        {
                            let _ = socket_call(&socket, "POST", "/connect/leave", &[]);
                        }
                    }
                    ended
                }
                Command::Extend { minutes } => {
                    let mut state = saved
                        .ok_or_else(|| error("This coding session has no hosted Connect room."))?;
                    complete_extend(&path, &mut state, minutes, &mut LiveHost(&socket))?
                }
                _ => unreachable!(),
            }
        }
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ambiguous_send_failures_warn_before_a_resend() {
        for code in [
            "connect_unreachable",
            "connect_upstream_error",
            "connect_internal_error",
        ] {
            assert!(SocketError(code.into(), true, None)
                .to_string()
                .contains("check before resending"));
            // Join, create, status and leave send nothing to warn about.
            assert!(!SocketError(code.into(), false, None)
                .to_string()
                .contains("resending"));
        }
        assert!(!SocketError("connect_auth_rejected".into(), true, None)
            .to_string()
            .contains("resending"));
    }
    #[test]
    fn tool_errors_never_print_private_results() {
        let result =
            mcp_result(json!({"result":{"isError":true,"content":[{"text":"secret-token"}]}}));
        assert!(!result.unwrap_err().to_string().contains("secret-token"));
        assert!(
            mcp_result(json!({"result":{"structuredContent":{"ended":true}}})).unwrap()["ended"]
                == true
        );
    }
    #[test]
    fn host_state_is_private_and_reusable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let state = HostState {
            session: random_id().unwrap(),
            request: random_id().unwrap(),
            auth: None,
            task: "test".into(),
            minutes: 60,
            name: None,
            link: None,
            expires_at: None,
            host_claim: None,
        };
        save(&path, &state).unwrap();
        private_file(&path).unwrap();
        let read: HostState = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(read.session, state.session);
        assert_eq!(read.request, state.request);
        // Windows has no mode to widen.
        #[cfg(unix)]
        {
            platform::fs::set_mode(&path, 0o644).unwrap();
            assert!(private_file(&path).is_err());
        }
    }
    struct FakeHost {
        calls: Vec<(String, String, String)>,
        claims: Vec<String>,
        fail_call: bool,
        extend_without_expiry: bool,
        fail_join: bool,
        invalid_claim: bool,
        /// Answer every tool as Cloud does once the room is gone.
        gone: Option<&'static str>,
    }
    impl HostServices for FakeHost {
        fn authenticate(&mut self, _: &Path, _: &mut HostState) -> Result<()> {
            Ok(())
        }
        fn call(&mut self, state: &HostState, tool: &str, _: Value) -> Result<Value> {
            self.calls
                .push((tool.into(), state.session.clone(), state.request.clone()));
            if self.fail_call {
                self.fail_call = false;
                return Err(error("interrupted"));
            }
            if let Some(code) = self.gone {
                return tool_result(
                    tool,
                    json!({"result":{"isError":true,"structuredContent":{"error":{"code":code}}}}),
                );
            }
            match tool {
                "create_connect" => Ok(
                    json!({"link":format!("https://agentrelay.com/connect/{}", "a".repeat(43)),"expires_at":"2099-01-01T00:00:00Z","host_claim":"private-claim"}),
                ),
                "connect_status" => Ok(json!({"host_claim":"replacement-claim"})),
                "end_connect" => Ok(json!({"ended":true})),
                "extend_connect" if self.extend_without_expiry => Ok(json!({"extended":true})),
                "extend_connect" => Ok(json!({"expires_at":"2099-01-02T00:00:00.000Z"})),
                _ => panic!("unexpected tool"),
            }
        }
        fn join(&mut self, _: &str, _: Option<&str>, claim: &str) -> Result<Value> {
            self.claims.push(claim.into());
            if self.invalid_claim {
                self.invalid_claim = false;
                return Err(SocketError("connect_claim_invalid".into(), false, None).into());
            }
            if self.fail_join {
                self.fail_join = false;
                return Err(error("interrupted join"));
            }
            Ok(json!({"role":"host","agent_name":"test-host"}))
        }
    }
    fn fake() -> FakeHost {
        FakeHost {
            calls: vec![],
            claims: vec![],
            fail_call: false,
            extend_without_expiry: false,
            fail_join: false,
            invalid_claim: false,
            gone: None,
        }
    }
    /// A saved room Cloud created, expiring at `expires_at`.
    fn created(expires_at: &str) -> HostState {
        HostState {
            link: Some(format!("https://agentrelay.com/connect/{}", "a".repeat(43))),
            expires_at: Some(expires_at.into()),
            host_claim: Some(crate::relay::workspace::Secret::new("saved-claim")),
            ..host()
        }
    }
    fn host() -> HostState {
        HostState {
            session: "stable-session".into(),
            request: "stable-request".into(),
            auth: None,
            task: "test".into(),
            minutes: 60,
            name: None,
            link: None,
            expires_at: None,
            host_claim: None,
        }
    }
    fn reload(path: &Path) -> HostState {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }
    #[test]
    fn interrupted_create_reuses_identity_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut state = host();
        save(&path, &state).unwrap();
        let mut api = fake();
        api.fail_call = true;
        assert!(complete_create(&path, &mut state, &mut api).is_err());
        let output = complete_create(&path, &mut reload(&path), &mut api).unwrap();
        assert_eq!(api.calls[0], api.calls[1]);
        assert!(!output.to_string().contains("private-claim"));
        assert!(!output.to_string().contains("stable-session"));
    }
    #[test]
    fn interrupted_join_retries_exact_claim_without_allocating_room() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut api = fake();
        api.fail_join = true;
        assert!(complete_create(&path, &mut host(), &mut api).is_err());
        complete_create(&path, &mut reload(&path), &mut api).unwrap();
        assert_eq!(api.calls.len(), 1);
        assert_eq!(api.claims, vec!["private-claim", "private-claim"]);
    }
    #[test]
    fn rejoining_after_leave_rotates_only_a_definitively_invalid_claim() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut api = fake();
        let mut state = host();
        complete_create(&path, &mut state, &mut api).unwrap();
        api.invalid_claim = true;
        complete_create(&path, &mut state, &mut api).unwrap();
        assert_eq!(
            api.calls.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
            vec!["create_connect", "connect_status"]
        );
        assert_eq!(api.claims.last().unwrap(), "replacement-claim");
    }
    #[test]
    fn failed_end_keeps_host_authority_until_server_confirms() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut state = host();
        save(&path, &state).unwrap();
        let mut api = fake();
        api.fail_call = true;
        assert!(complete_end(&path, &mut state, &mut api).is_err());
        assert_eq!(reload(&path).session, "stable-session");
        assert_eq!(
            complete_end(&path, &mut reload(&path), &mut api).unwrap()["ended"],
            true
        );
        assert!(!path.exists());
    }
    #[test]
    fn a_gone_room_reads_as_ended_for_end_and_as_gone_otherwise() {
        let structured = |code: &str| json!({"result":{"isError":true,"structuredContent":{"error":{"code":code,"status":410}}}});
        // Some answers carry the error only as JSON text.
        let text_only = json!({"result":{"isError":true,"content":[{"type":"text",
            "text":"{\"error\":{\"code\":\"connect_expired\",\"status\":410}}"}]}});
        for body in [
            structured("connect_expired"),
            structured("connect_ended"),
            structured("connect_not_found"),
            text_only,
        ] {
            assert_eq!(
                tool_result("end_connect", body.clone()).unwrap()["ended"],
                true
            );
            let gone = tool_result("extend_connect", body).unwrap_err();
            assert!(room_gone(&gone));
            assert!(gone.to_string().contains("connect create"));
        }
        // Any other failure is retryable and keeps the host state.
        let other = tool_result("end_connect", structured("connect_forbidden")).unwrap_err();
        assert!(!room_gone(&other));
        assert!(other.to_string().contains("host state was retained"));
    }
    #[test]
    fn create_drops_a_room_cloud_closed_before_its_saved_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        // Cloud closed the room although its saved expiry is still ahead.
        save(&path, &created("2099-01-01T00:00:00Z")).unwrap();
        let mut api = fake();
        api.gone = Some("connect_expired");
        let kept = discard_if_gone(
            &path,
            Some(reload(&path)),
            "new task",
            1440,
            &None,
            &mut api,
        )
        .unwrap();
        assert!(kept.is_none());
        assert!(!path.exists());
        // So a new room can be created with the new request.
        assert!(host_state::for_create(kept, "new task".into(), 1440, None).is_ok());
    }
    #[test]
    fn create_keeps_a_live_room_and_its_rotated_claim() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        save(&path, &created("2099-01-01T00:00:00Z")).unwrap();
        let mut api = fake();
        let kept = discard_if_gone(
            &path,
            Some(reload(&path)),
            "new task",
            1440,
            &None,
            &mut api,
        )
        .unwrap();
        // The live room still refuses a different request,
        assert!(host_state::for_create(kept, "new task".into(), 1440, None).is_err());
        // and the claim the status call issued replaces the invalidated one.
        assert_eq!(
            reload(&path).host_claim.unwrap().expose(),
            "replacement-claim"
        );
    }
    #[test]
    fn repeating_the_original_create_never_asks_cloud() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let state = created("2099-01-01T00:00:00Z");
        save(&path, &state).unwrap();
        let mut api = fake();
        let kept = discard_if_gone(&path, Some(state), "test", 60, &None, &mut api).unwrap();
        assert!(kept.is_some());
        assert!(api.calls.is_empty());
    }
    #[test]
    fn ending_a_room_past_its_saved_expiry_still_asks_cloud() {
        // This computer's clock may run ahead of Cloud's, so a saved expiry in
        // the past is no proof the room is over: the host keeps its authority
        // until Cloud confirms the end.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut state = created("2020-01-01T00:00:00Z");
        save(&path, &state).unwrap();
        let mut api = fake();
        api.fail_call = true;
        assert!(complete_end(&path, &mut state, &mut api).is_err());
        assert!(path.exists());
        let mut api = fake();
        assert_eq!(
            complete_end(&path, &mut state, &mut api).unwrap()["ended"],
            true
        );
        assert!(api.calls.iter().any(|call| call.0 == "end_connect"));
        assert!(!path.exists());
    }
    #[test]
    fn ending_a_room_cloud_already_closed_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut state = created("2099-01-01T00:00:00Z");
        save(&path, &state).unwrap();
        let mut api = fake();
        api.gone = Some("connect_not_found");
        assert_eq!(
            complete_end(&path, &mut state, &mut api).unwrap()["ended"],
            true
        );
        assert!(!path.exists());
    }
    #[test]
    fn extend_records_the_new_expiry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut state = created("2099-01-01T00:00:00Z");
        save(&path, &state).unwrap();
        let mut api = fake();
        let output = complete_extend(&path, &mut state, 120, &mut api).unwrap();
        assert_eq!(output["expires_at"], "2099-01-02T00:00:00.000Z");
        assert_eq!(
            reload(&path).expires_at.as_deref(),
            Some("2099-01-02T00:00:00.000Z")
        );
        assert!(!output.to_string().contains("saved-claim"));
        assert!(complete_extend(&path, &mut state, MAX_EXTEND_MINUTES + 1, &mut api).is_err());
    }
    #[test]
    fn extending_a_gone_room_clears_it_and_says_to_create_a_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        // Closed by Cloud before its saved expiry.
        let mut state = created("2099-01-01T00:00:00Z");
        save(&path, &state).unwrap();
        let mut api = fake();
        api.gone = Some("connect_expired");
        let failed = complete_extend(&path, &mut state, 60, &mut api).unwrap_err();
        assert!(failed.to_string().contains("expired"));
        assert!(!path.exists());
    }
    #[test]
    fn an_extension_without_a_readable_expiry_is_not_reported_as_done() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut state = created("2099-01-01T00:00:00Z");
        save(&path, &state).unwrap();
        let mut api = fake();
        api.extend_without_expiry = true;
        assert!(complete_extend(&path, &mut state, 60, &mut api).is_err());
        assert_eq!(
            reload(&path).expires_at.as_deref(),
            Some("2099-01-01T00:00:00Z")
        );
    }
    #[test]
    fn extending_past_the_saved_expiry_asks_cloud() {
        // A saved expiry in the past may only mean this clock runs ahead:
        // Cloud decides, and a room it still holds open is extended.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let mut state = created("2020-01-01T00:00:00Z");
        save(&path, &state).unwrap();
        let mut api = fake();
        let output = complete_extend(&path, &mut state, 60, &mut api).unwrap();
        assert_eq!(output["expires_at"], "2099-01-02T00:00:00.000Z");
        assert!(api.calls.iter().any(|call| call.0 == "extend_connect"));
    }
    #[test]
    fn extend_minutes_are_bounded_on_the_command_line() {
        use clap::Parser;
        #[derive(Parser)]
        struct Cli {
            #[command(subcommand)]
            command: Command,
        }
        let parse = |minutes: &str| Cli::try_parse_from(["probe", "extend", "--minutes", minutes]);
        assert!(parse("10080").is_ok());
        assert!(parse("10081").is_err());
        assert!(parse("0").is_err());
    }
    #[test]
    fn names_are_rejected_before_creating_private_state() {
        for name in ["a", "-host", "host-", "Host", "a b", "a--b", "éé"] {
            assert!(!valid_name(name));
        }
        assert!(valid_name("host-2"));
        assert!(run_inner(Command::Create {
            task: "test".into(),
            expires_in_minutes: 60,
            name: Some("a".into())
        })
        .unwrap_err()
        .to_string()
        .contains("2–48"));
    }
}
