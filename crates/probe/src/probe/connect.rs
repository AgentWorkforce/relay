//! Native Connect entry point. Host credentials belong only to this command;
//! the desktop account and other CLI refresh tokens are never read or changed.
use agent_relay_probe::platform;
use agent_relay_probe::relay::{
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
    io::Read,
    path::{Path, PathBuf},
    process::{Command as Process, Stdio},
    time::Duration,
};

const SITE: &str = "https://agentrelay.com";
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
}

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
    host_claim: Option<agent_relay_probe::relay::workspace::Secret>,
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
fn valid_name(name: &str) -> bool {
    agent_relay_probe::relay::agents::normalize_name(name).as_deref() == Some(name)
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
    let pointer = home.join(".agentworkforce/desktop/relay-socket");
    if !pointer.try_exists()? {
        return Ok(None);
    }
    let m = fs::symlink_metadata(&pointer)?;
    ensure!(
        m.is_file() && owned_and_private(&m, 0o022),
        SafeError("Unsafe Agent Relay socket pointer.".into())
    );
    trusted_socket(&cli::pointed_socket(home, false)?)
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
        .args(["relay", "serve", "--headless", "--connect-ephemeral"])
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
    ensure!(
        session.site_url == SITE,
        SafeError("Host credentials belong to another site.".into())
    );
    let answer = cloud_http::send_blocking_with_headers("POST", &format!("{SITE}/cloud/api/v1/mcp/shared-sessions"),
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
    if tool == "end_connect"
        && matches!(
            answer.body["result"]["structuredContent"]["error"]["code"].as_str(),
            Some("connect_ended" | "connect_expired")
        )
    {
        return Ok(json!({"ended":true}));
    }
    mcp_result(answer.body)
}
fn login(path: &Path, state: &mut HostState) -> Result<()> {
    let rt = tokio::runtime::Runtime::new()?;
    if let Some(session) = &state.auth {
        if cloud_session::access_is_fresh(
            session,
            Duration::from_secs(120),
            agent_relay_probe::relay::state::now_ms(),
        ) {
            return Ok(());
        }
        if cloud_session::can_refresh(session, agent_relay_probe::relay::state::now_ms()) {
            state.auth = Some(rt.block_on(cloud_session::refresh(session)).map_err(|_| error("Host sign-in could not be refreshed. Retry, or sign in again after the room expires."))?);
            return save(path, state);
        }
    }
    let grant = rt
        // Relay Connect's host is not the desktop installation: an
        // ordinary device login, without the desktop proof.
        .block_on(DeviceLogin::begin(SITE, None))
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
        state.host_claim = Some(agent_relay_probe::relay::workspace::Secret::new(
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
            state.host_claim = Some(agent_relay_probe::relay::workspace::Secret::new(
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
    services.authenticate(path, state)?;
    let ended = services.call(state, "end_connect", json!({}))?;
    ensure!(
        ended["ended"] == true,
        SafeError("Cloud did not confirm the room ended.".into())
    );
    fs::remove_file(path)?;
    Ok(ended)
}

pub fn run(command: Command) -> Result<()> {
    run_inner(command).map_err(|cause| {
        if let Some(socket) = cause.downcast_ref::<SocketError>() {
            error(socket.to_string())
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
        Command::Create { .. } | Command::Join { .. } | Command::End
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
        command @ (Command::Create { .. } | Command::End) => {
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
        fail_join: bool,
        invalid_claim: bool,
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
            match tool {
                "create_connect" => Ok(
                    json!({"link":format!("https://agentrelay.com/connect/{}", "a".repeat(43)),"expires_at":"2099-01-01T00:00:00Z","host_claim":"private-claim"}),
                ),
                "connect_status" => Ok(json!({"host_claim":"replacement-claim"})),
                "end_connect" => Ok(json!({"ended":true})),
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
            fail_join: false,
            invalid_claim: false,
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
