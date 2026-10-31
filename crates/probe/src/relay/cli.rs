//! `agent-relay-probe relay call`: one request to a running core, for
//! scripts and support. It speaks the same bridge as the apps.

use crate::relay::daemon::SafeError;
use crate::relay::delivery::policy::relayfile_glob;
use crate::relay::files::FETCH_TIMEOUT;
use crate::relay::integrations::CONNECT_WAIT;
use crate::relay::paths::{self, CorePaths};
use crate::relay::peer::current_uid;
use crate::relay::protocol::{Response, BRIDGE_VERSION, MAX_REPLY_BYTES};
use crate::relay::transport::BlockingCoreStream;
use anyhow::Result;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::Duration;

/// Sends `hello` then `method` with `params`, and returns the result.
pub fn call(
    socket: Option<&Path>,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value> {
    let home = paths::home()?;
    let paths = CorePaths::resolve(socket, |key| std::env::var(key).ok(), &home)
        .map_err(|error| SafeError(error.to_string()))?;
    let stream = BlockingCoreStream::connect(&paths.socket).map_err(|_| {
        SafeError(format!(
            "Agent Relay core is not running at {}.",
            paths.socket.display()
        ))
    })?;
    // The same trust boundary as the daemon's admission: only a daemon run
    // by this user is spoken to.
    if stream.peer_credentials().map(|peer| peer.uid).ok() != Some(current_uid()) {
        return Err(SafeError(format!(
            "{} is not served by your own Agent Relay core.",
            paths.socket.display()
        ))
        .into());
    }
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut request = |id: u64, method: &str, params: Value| -> Result<Value> {
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writer.write_all(format!("{line}\n").as_bytes())?;
        loop {
            let mut line = Vec::new();
            (&mut reader)
                .take(MAX_REPLY_BYTES as u64 + 2)
                .read_until(b'\n', &mut line)?;
            if line.is_empty() {
                return Err(SafeError("Agent Relay core closed the connection.".into()).into());
            }
            if line.last() != Some(&b'\n') || line.len() - 1 > MAX_REPLY_BYTES {
                return Err(SafeError("Agent Relay core sent an oversized reply.".into()).into());
            }
            let value: Value = serde_json::from_slice(&line)?;
            // Events can arrive between responses; only this id answers.
            if value.get("id") != Some(&json!(id)) {
                continue;
            }
            let response: Response = serde_json::from_value(value)?;
            return match (response.result, response.error) {
                (Some(result), _) => Ok(result),
                (None, Some(error)) => Err(SafeError(error.message).into()),
                (None, None) => Ok(Value::Null),
            };
        }
    };
    // `daemon.shutdown` needs no handshake, so a stale daemon on another
    // bridge version can still be retired.
    if method != "daemon.shutdown" {
        request(1, "hello", json!({"bridge_version": BRIDGE_VERSION}))?;
    }
    request(2, method, params)
}

/// A small socket client for session-scoped requests, for people and
/// debugging. Apple's /usr/bin/curl does not expose CODEX_THREAD_ID to
/// KERN_PROCARGS2; this executable does, so the core can identify its
/// calling thread. No sandbox or permission rule allows it: it can reach
/// setting and registration routes, so the hints a session is handed name
/// the self-limiting commands in `session_cli` instead.
fn socket_request_allowed(method: &str, path: &str) -> bool {
    if path.bytes().any(|byte| byte <= b' ' || byte == 0x7f) {
        return false;
    }
    match method {
        "POST" => {
            path == "/send"
                || path.starts_with("/send?")
                || path.starts_with("/attachments/fetch?file_id=")
                || path == "/connect/send"
                || path.starts_with("/connect/send?")
                || path.starts_with("/channels/subscribe?channel=")
                || matches!(
                    path,
                    "/register" | "/connect/leave" | "/integrations/subscribe"
                )
        }
        "GET" => {
            path.starts_with("/messages?ref=")
                || matches!(
                    path,
                    "/agents" | "/setup/status" | "/whoami" | "/connect/status" | "/settings"
                )
        }
        "PATCH" => path == "/settings",
        "DELETE" => {
            path.starts_with("/channels/subscribe?channel=")
                || matches!(
                    path,
                    "/register" | "/integrations/subscribe" | "/connect/join"
                )
        }
        _ => false,
    }
}

/// `relay socket-request`: `body` is the request body (`--body`); without
/// it a POST, DELETE or PATCH reads its body from standard input.
pub fn socket_request(socket: &Path, method: &str, path: &str, body: Option<&str>) -> Result<()> {
    if !socket_request_allowed(method, path) {
        return Err(SafeError("Unsupported relay socket request.".into()).into());
    }
    let sends_body = matches!(method, "POST" | "DELETE" | "PATCH");
    let body = match body {
        Some(_) if !sends_body => {
            return Err(SafeError(format!("A {method} request takes no --body.")).into());
        }
        Some(body) => body.as_bytes().to_vec(),
        None => {
            let mut body = Vec::new();
            if sends_body {
                std::io::stdin().read_to_end(&mut body)?;
            }
            body
        }
    };
    socket_exchange(socket, method, path, &body, socket_request_timeout(path))
}

/// `relay read <ref>`: prints a relayed message this session was handed as a
/// pointer, then its note (`message_pointer::read_note`). Like the other
/// session commands (`session_cli`), the session is told from this process,
/// so it reads only its own messages.
pub fn read_message(socket: Option<&Path>, development: bool, message_ref: &str) -> Result<()> {
    let socket = match socket {
        Some(socket) => socket.to_path_buf(),
        None => pointed_socket(&paths::home()?, development)?,
    };
    let text = read_text(&socket, message_ref)?;
    let note = crate::relay::message_pointer::read_note(&text);
    std::io::stdout().write_all(format!("{text}\n\n{note}\n").as_bytes())?;
    Ok(())
}

/// The text of message `message_ref` kept for the calling session.
fn read_text(socket: &Path, message_ref: &str) -> Result<String> {
    let request = crate::relay::session_cli::SessionCommand::Read {
        message_ref: message_ref.to_string(),
    }
    .request()?;
    let (status, body) =
        socket_response(socket, request.method, &request.path, b"", SOCKET_TIMEOUT)?;
    let answer: Value = serde_json::from_slice(&body).unwrap_or_default();
    match answer["data"]["text"].as_str() {
        Some(text) if (200..300).contains(&status) => Ok(text.to_string()),
        _ => Err(SafeError(match answer["error"]["message"].as_str() {
            Some(message) => format!("Agent Relay could not read message {message_ref}: {message}"),
            None => format!("Agent Relay could not read message {message_ref} ({status})."),
        })
        .into()),
    }
}

fn socket_request_timeout(path: &str) -> Duration {
    if path.starts_with("/attachments/fetch?file_id=") {
        // The server may use the entire attachment-fetch budget. Leave time
        // for it to serialize the successful response instead of making the
        // recovery command report a client-side timeout first.
        FETCH_TIMEOUT.saturating_add(Duration::from_secs(10))
    } else {
        SOCKET_TIMEOUT
    }
}

/// How long `relay socket` waits for the core to answer. The core bounds its
/// own slow upstreams (a Relaycast roster read waits at most five seconds
/// before serving the last-known roster), so this only trips when the core
/// itself is stuck; it is long enough not to give up on a slow but working
/// answer.
pub const SOCKET_TIMEOUT: Duration = Duration::from_secs(60);

/// Whether an I/O error is a socket read or write timing out. A timed-out
/// read reports `WouldBlock` on macOS and `TimedOut` on Linux.
fn timed_out(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

/// What to say when the core does not answer in time. It names the route
/// (without its query, which can carry addresses) and says this is not a
/// setup problem, so a caller retries instead of re-running setup.
fn timeout_error(method: &str, path: &str, timeout: Duration) -> SafeError {
    let route = path.split('?').next().unwrap_or(path);
    SafeError(format!(
        "Agent Relay did not answer {method} {route} within {} seconds. \
This is not a setup problem; the core is still running. Try again shortly.",
        timeout.as_secs()
    ))
}

/// How long a subscription may take. The core waits up to five minutes for
/// a person to connect the provider in the browser
/// (`integrations::CONNECT_WAIT`), then makes several cloud requests; a
/// shorter wait here would report a failure the core goes on to complete.
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(CONNECT_WAIT.as_secs() + 120);

/// The request `relay subscribe` sends for `pull`, or why it names no pull
/// request. Checked here so a mistyped argument never reaches the socket.
fn pull_subscription(pull: &str) -> Result<Vec<u8>> {
    let pull = pull.trim();
    // Judged on the glob's shape, not on finding "pulls" in it: a whole
    // repository named `pulls`, or owned by `pulls`, is not a pull request.
    let numbered = !pull.starts_with('/')
        && relayfile_glob("github", pull).is_some_and(|glob| {
            matches!(
                glob.split('/').collect::<Vec<_>>()[..],
                ["", "github", "repos", _, _, "pulls", number, "**"]
                    if number.bytes().all(|byte| byte.is_ascii_digit())
            )
        });
    if !numbered {
        return Err(SafeError(
            "Name one pull request as owner/repo#123 or https://github.com/owner/repo/pull/123."
                .into(),
        )
        .into());
    }
    Ok(serde_json::to_vec(
        &json!({"provider": "github", "resource": pull}),
    )?)
}

/// The session socket named by the app's pointer file: Agent Relay's, or
/// with `development` Agent Relay Dev's (`outbound::pointer_path`). Which
/// build a session belongs to cannot be told from here, so the other
/// build's pointer is never tried in its place.
pub fn pointed_socket(home: &Path, development: bool) -> Result<std::path::PathBuf> {
    let directory = home.join(".agentworkforce/desktop");
    let (name, other, hint) = if development {
        ("relay-socket.dev", "relay-socket", "Omit --dev")
    } else {
        ("relay-socket", "relay-socket.dev", "Pass --dev")
    };
    let path = std::fs::read_to_string(directory.join(name)).map_err(|_| {
        SafeError(if directory.join(other).exists() {
            format!("This build of Agent Relay is not running, but the other one is. {hint} to subscribe through it.")
        } else {
            "Agent Relay is not running: its session socket pointer is missing. Start the app or service.".to_string()
        })
    })?;
    let path = Path::new(path.trim());
    if !path.is_absolute() {
        return Err(SafeError("Agent Relay's session socket pointer is unreadable.".into()).into());
    }
    Ok(path.to_path_buf())
}

/// `agent-relay-probe relay subscribe <pull>`: subscribes (or, with
/// `remove`, unsubscribes) the calling Codex or Claude session to one GitHub
/// pull request. The core identifies the session from this process; nothing
/// names it and no credential is sent.
/// How long Agent Relay's Codex Stop hook waits for the core.
const STOP_HOOK_TIMEOUT: Duration = Duration::from_secs(5);

/// How long it waits at SessionStart, where the core may first put the
/// session on the relay (`outbound::codex_hook`); within the hook's own
/// ten-second limit in `hooks.json`.
const SESSION_START_TIMEOUT: Duration = Duration::from_secs(8);

/// Agent Relay's Codex hook (`codex::stop_hook`), run after each tool call
/// (PostToolUse), as a turn ends (Stop) and as a session starts
/// (SessionStart): reads Codex's hook input, asks the core what this
/// thread's running turn should be given (at SessionStart, its Agent Relay
/// preamble), and prints Codex's hook output. Only the thread, turn, event,
/// working folder and whether the turn already continued are sent, so a
/// long tool output or last message cannot exceed the socket's body limit.
/// Any failure prints `{}`, so Codex goes on as it would without the hook.
pub fn codex_stop_hook(socket: Option<&Path>, development: bool) -> Result<()> {
    let mut input = Vec::new();
    let _ = std::io::stdin().take(4 << 20).read_to_end(&mut input);
    let answer = (|| -> Result<Value> {
        let hook: Value = serde_json::from_slice(&input)?;
        let body = serde_json::to_vec(&json!({
            "session_id": hook["session_id"],
            "turn_id": hook["turn_id"],
            "hook_event_name": hook["hook_event_name"],
            "stop_hook_active": hook["stop_hook_active"],
            "cwd": hook["cwd"],
        }))?;
        let timeout = if hook["hook_event_name"] == "SessionStart" {
            SESSION_START_TIMEOUT
        } else {
            STOP_HOOK_TIMEOUT
        };
        let socket = match socket {
            Some(socket) => socket.to_path_buf(),
            None => pointed_socket(&paths::home()?, development)?,
        };
        let (status, response) =
            socket_response(&socket, "POST", "/codex/stop-hook", &body, timeout)?;
        anyhow::ensure!((200..300).contains(&status), "refused");
        let response: Value = serde_json::from_slice(&response)?;
        Ok(response["data"].clone())
    })()
    .ok()
    .filter(Value::is_object)
    .unwrap_or_else(|| json!({}));
    let mut stdout = std::io::stdout();
    stdout.write_all(&serde_json::to_vec(&answer)?)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

/// How long one `GET /setup/status` from the SessionStart hook may take.
const SESSION_HOOK_TIMEOUT: Duration = Duration::from_secs(2);

/// Agent Relay's Claude Code SessionStart hook (`claude::session_hook`).
/// Reads and discards Claude's hook input, asks whether this session is on
/// the relay, and prints Claude's hook output. The only request is
/// `GET /setup/status` with `X-Agent-Relay-Observe: 1`, so the read does not
/// apply the agent-led defaults. Claude in a session that is not registered
/// is told to ask the person first, and how to `POST /register` if they say
/// yes, when that is allowed, and otherwise which setting
/// is off. A session with no person to answer (`claude -p`, the Agent SDK,
/// a structured pipe) is not told that. A session already on the relay gets
/// the preamble (`hosted_mcp::preamble`). This command never registers it.
/// Any failure prints `{}`, so the session still starts.
pub fn claude_session_hook(socket: Option<&Path>, development: bool) -> Result<()> {
    let mut input = Vec::new();
    let _ = std::io::stdin().take(4 << 20).read_to_end(&mut input);
    drop(input);
    let table = crate::relay::process::SystemProcesses::default();
    #[cfg(unix)]
    let parent = std::os::unix::process::parent_id() as i32;
    // std has no parent id on Windows; the process table records it.
    #[cfg(not(unix))]
    let parent = {
        use crate::relay::process::ProcessTable;
        table
            .process(std::process::id() as i32)
            .map_or(0, |process| process.parent)
    };
    // Cursor CLI also runs the hooks in Claude's settings.json: a hook that
    // no Claude Code process owns says nothing, even when a Claude session
    // further up started that agent.
    let claude = crate::relay::claude::session_hook::claude_ancestor(&table, parent);
    let interactive = crate::relay::claude::session_hook::has_person(&table, parent);
    let output = match session_hook_socket(socket, development).filter(|_| claude.is_some()) {
        Some(socket) => {
            let (registered, probe) = session_registered(&socket);
            // The core names its rules' probe; an older one does not, and
            // this probe is the one it runs.
            let probe = probe.or_else(crate::relay::outbound::fetch::probe_executable);
            crate::relay::claude::session_hook::hook_output(
                registered,
                &socket,
                interactive,
                probe.as_deref(),
            )
        }
        None => json!({}),
    };
    let mut stdout = std::io::stdout();
    stdout.write_all(&serde_json::to_vec(&output)?)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

/// Agent Relay's Devin lifecycle hook (`devin::DevinSettings` installs it).
/// Reads Devin's hook payload on stdin and prints the injection for the
/// event — pending inbox messages as `additionalContext` while the session
/// works, or a `block` decision when it stops. The files are removed only
/// once the answer is fully written, so a failed or partial write keeps
/// the queue for a later boundary. An empty inbox, an event that does not
/// inject or any failure prints nothing and exits 0, so a hook boundary
/// can never break the session it observes. `--dev` selects Agent Relay
/// Dev's own inbox, never production's.
pub fn devin_hook(development: bool) -> Result<()> {
    let mut input = Vec::new();
    let _ = std::io::stdin().take(4 << 20).read_to_end(&mut input);
    let payload = serde_json::from_slice::<Value>(&input).unwrap_or_else(|_| json!({}));
    let home = match paths::home() {
        Ok(home) => home,
        Err(_) => return Ok(()),
    };
    let config = crate::relay::devin::DevinConfig::from_env(&|key| std::env::var(key).ok(), &home)
        .development(development);
    if let Some((output, consumed)) = crate::relay::devin::hook_answer(&config, &payload) {
        let mut stdout = std::io::stdout();
        let written = serde_json::to_vec(&output)
            .map_err(std::io::Error::other)
            .and_then(|bytes| {
                stdout.write_all(&bytes)?;
                stdout.write_all(b"\n")?;
                stdout.flush()
            });
        if written.is_ok() {
            crate::relay::devin::settle(&consumed);
        }
    }
    Ok(())
}

/// Agent Relay's Cursor CLI hook (`cursor_cli::CursorSettings` installs it
/// for `postToolUse` and `stop`). Reads Cursor's hook payload and, only
/// when this process runs under the `cursor-agent` holding the payload's
/// conversation, claims that session's staged messages and prints them:
/// `additional_context` after a tool call, `followup_message` when the turn
/// completes. A claim is tombstoned once the answer is written and put back
/// if it is not. Anything else prints `{}` and exits 0, so a hook can never
/// break the session it runs in. `--dev` selects Agent Relay Dev's inbox.
pub fn cursor_hook(development: bool) -> Result<()> {
    let mut input = Vec::new();
    let _ = std::io::stdin().take(4 << 20).read_to_end(&mut input);
    let payload = serde_json::from_slice::<Value>(&input).unwrap_or_else(|_| json!({}));
    let answer = paths::home().ok().and_then(|home| {
        let config =
            crate::relay::cursor_cli::CursorConfig::from_env(&|key| std::env::var(key).ok(), &home)
                .development(development);
        let session = crate::relay::cursor_cli::payload_session(&payload)?;
        let table = crate::relay::process::SystemProcesses::default();
        #[cfg(unix)]
        let parent = std::os::unix::process::parent_id() as i32;
        #[cfg(not(unix))]
        let parent = {
            use crate::relay::process::ProcessTable;
            table
                .process(std::process::id() as i32)
                .map_or(0, |process| process.parent)
        };
        if !crate::relay::cursor_cli::hook_caller_holds(&config, &table, parent, session) {
            return None;
        }
        crate::relay::cursor_cli::hook_answer(&config, &payload).map(|answer| (config, answer))
    });
    let mut stdout = std::io::stdout();
    let Some((config, answer)) = answer else {
        stdout.write_all(b"{}\n")?;
        return Ok(());
    };
    let written = serde_json::to_vec(&answer.output)
        .map_err(std::io::Error::other)
        .and_then(|bytes| {
            stdout.write_all(&bytes)?;
            stdout.write_all(b"\n")?;
            stdout.flush()
        });
    match written {
        Ok(()) => crate::relay::cursor_cli::drain(&answer.claimed),
        Err(_) => crate::relay::cursor_cli::unclaim(&config, &answer.claimed),
    }
    Ok(())
}

fn session_hook_socket(socket: Option<&Path>, development: bool) -> Option<std::path::PathBuf> {
    match socket {
        Some(socket) => Some(socket.to_path_buf()),
        None => pointed_socket(&paths::home().ok()?, development).ok(),
    }
}

/// `session.registered`, asking once more when Claude has not written its
/// session file yet, and the probe the core's rules name. `None` when the
/// status cannot be read: the hook then stays quiet rather than registering
/// the session.
fn session_registered(
    socket: &Path,
) -> (
    Option<crate::relay::claude::session_hook::StatusRead>,
    Option<std::path::PathBuf>,
) {
    let mut probe = None;
    let status = session_status(socket, &mut probe);
    (status, probe)
}

fn session_status(
    socket: &Path,
    probe: &mut Option<std::path::PathBuf>,
) -> Option<crate::relay::claude::session_hook::StatusRead> {
    let mut attempts = 0;
    loop {
        attempts += 1;
        let (status, body) = socket_response_with(
            socket,
            "GET",
            "/setup/status",
            b"",
            SESSION_HOOK_TIMEOUT,
            &[(
                "X-Agent-Relay-Observe",
                crate::relay::claude::session_hook::OBSERVE_VALUE,
            )],
        )
        .ok()?;
        *probe = crate::relay::claude::session_hook::read_probe(&body);
        match crate::relay::claude::session_hook::read_status(status, &body) {
            registered @ (crate::relay::claude::session_hook::StatusRead::Registered { .. }
            | crate::relay::claude::session_hook::StatusRead::Joining
            | crate::relay::claude::session_hook::StatusRead::OnRelay { .. }) => {
                return Some(registered);
            }
            crate::relay::claude::session_hook::StatusRead::Unknown => return None,
            crate::relay::claude::session_hook::StatusRead::Again if attempts < 2 => {
                std::thread::sleep(Duration::from_millis(200));
            }
            crate::relay::claude::session_hook::StatusRead::Again => return None,
        }
    }
}

pub fn subscribe(socket: Option<&Path>, development: bool, pull: &str, remove: bool) -> Result<()> {
    let body = pull_subscription(pull)?;
    let socket = match socket {
        Some(socket) => socket.to_path_buf(),
        None => pointed_socket(&paths::home()?, development)?,
    };
    let method = if remove { "DELETE" } else { "POST" };
    socket_exchange(
        &socket,
        method,
        "/integrations/subscribe",
        &body,
        SUBSCRIBE_TIMEOUT,
    )
}

pub(crate) fn socket_exchange(
    socket: &Path,
    method: &str,
    path: &str,
    body: &[u8],
    timeout: Duration,
) -> Result<()> {
    let (status, response) = socket_response_with(socket, method, path, body, timeout, &[])?;
    std::io::stdout().write_all(&response)?;
    std::io::stdout().write_all(b"\n")?;
    if !(200..300).contains(&status) {
        return Err(SafeError(format!(
            "The session socket refused this request ({status})."
        ))
        .into());
    }
    Ok(())
}

pub fn socket_response(
    socket: &Path,
    method: &str,
    path: &str,
    body: &[u8],
    timeout: Duration,
) -> Result<(u16, Vec<u8>)> {
    socket_response_with(socket, method, path, body, timeout, &[])
}

/// Sends one request to the session socket with additional bounded headers.
/// Callers own validation of header names and values before using this seam.
pub fn socket_response_with_headers(
    socket: &Path,
    method: &str,
    path: &str,
    body: &[u8],
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<(u16, Vec<u8>)> {
    socket_response_with(socket, method, path, body, timeout, headers)
}

fn socket_response_with(
    socket: &Path,
    method: &str,
    path: &str,
    body: &[u8],
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<(u16, Vec<u8>)> {
    let mut stream = BlockingCoreStream::connect(socket)
        .map_err(|_| SafeError("Agent Relay's session socket is unavailable.".into()))?;
    if stream.peer_credentials().map(|peer| peer.uid).ok() != Some(current_uid()) {
        return Err(SafeError(
            "The session socket is not served by your own Agent Relay core.".into(),
        )
        .into());
    }
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let content_type = if matches!(
        path,
        "/register"
            | "/integrations/subscribe"
            | "/connect/join"
            | "/codex/stop-hook"
            | "/settings"
    ) {
        "application/json"
    } else {
        "text/plain; charset=utf-8"
    };
    let on_timeout = |error: std::io::Error| -> anyhow::Error {
        if timed_out(&error) {
            timeout_error(method, path, timeout).into()
        } else {
            error.into()
        }
    };
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: relay\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n",
        body.len()
    )
    .map_err(on_timeout)?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n").map_err(on_timeout)?;
    }
    write!(stream, "Connection: close\r\n\r\n").map_err(on_timeout)?;
    stream.write_all(body).map_err(on_timeout)?;
    let mut response = Vec::new();
    (&mut stream)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut response)
        .map_err(on_timeout)?;
    if response.len() > 4 * 1024 * 1024 {
        return Err(SafeError("The session socket response was too large.".into()).into());
    }
    let split = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or_else(|| SafeError("The session socket returned an unreadable response.".into()))?;
    let status = std::str::from_utf8(&response[..split])?
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| SafeError("The session socket returned an unreadable status.".into()))?;
    Ok((status, response[split + 4..].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::relay::transport::{CoreListener, CoreStream};
    use std::future::Future;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    /// Serves one connection at a fresh socket, on a runtime of its own in a
    /// thread, as `serve` decides.
    fn serve_once<F, Fut, T>(
        serve: F,
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::thread::JoinHandle<T>,
    )
    where
        F: FnOnce(CoreStream) -> Fut + Send + 'static,
        Fut: Future<Output = T>,
        T: Send + 'static,
    {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("s.sock");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut listener = {
            let _entered = runtime.enter();
            CoreListener::bind(&socket).unwrap()
        };
        let served = std::thread::spawn(move || {
            runtime.block_on(async move {
                let stream = listener.accept().await.unwrap();
                serve(stream).await
            })
        });
        (directory, socket, served)
    }

    #[test]
    fn a_silent_core_times_out_as_a_named_route_not_a_setup_failure() {
        // Accept and hold the connection without ever answering.
        let (_directory, socket, held) = serve_once(|stream| async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            drop(stream);
        });
        let error = socket_response(
            &socket,
            "GET",
            "/agents?address=alice",
            b"",
            Duration::from_millis(200),
        )
        .unwrap_err();
        let safe = error
            .downcast_ref::<SafeError>()
            .expect("a timeout is reported as a SafeError");
        assert!(safe.0.contains("GET /agents"), "{}", safe.0);
        assert!(
            !safe.0.contains("alice"),
            "the query is not echoed: {}",
            safe.0
        );
        assert!(safe.0.contains("not a setup problem"), "{}", safe.0);
        held.join().unwrap();
    }

    /// A socket that answers one request with `status` and `body`, and
    /// hands back the request line it read.
    fn answer_once(
        status: u16,
        body: &str,
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::thread::JoinHandle<String>,
    ) {
        let body = body.to_string();
        serve_once(move |stream| async move {
            let (read, mut write) = stream.into_split();
            let mut request = String::new();
            let mut reader = tokio::io::BufReader::new(read);
            reader.read_line(&mut request).await.unwrap();
            // Closing a Unix socket with unread request bytes can reset the
            // client's connection instead of delivering this fixture's error.
            loop {
                let mut header = String::new();
                assert_ne!(reader.read_line(&mut header).await.unwrap(), 0);
                if header == "\r\n" {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            write.write_all(response.as_bytes()).await.unwrap();
            request
        })
    }

    #[test]
    fn relay_read_prints_the_kept_message_or_says_why_not() {
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nCheck CI.";
        let ok =
            json!({"ok": true, "data": {"message_id": "m1", "ref": "0123456789ab", "text": text}});
        let (_dir, socket, served) = answer_once(200, &ok.to_string());
        assert_eq!(read_text(&socket, "0123456789ab").unwrap(), text);
        assert!(served
            .join()
            .unwrap()
            .starts_with("GET /messages?ref=0123456789ab "));

        let missing = json!({"ok": false, "error": {"code": "message_not_found",
            "message": "No message 0123456789ab was kept for this session, or it expired."}});
        let (_dir, socket, served) = answer_once(404, &missing.to_string());
        let error = read_text(&socket, "0123456789ab").unwrap_err();
        let safe = error.downcast_ref::<SafeError>().unwrap();
        assert!(safe.0.contains("was kept for this session"), "{}", safe.0);
        served.join().unwrap();

        let error = read_text(Path::new("/unused"), "../etc").unwrap_err();
        assert!(error
            .downcast_ref::<SafeError>()
            .unwrap()
            .0
            .contains("12-character ref"));
    }

    #[test]
    fn the_socket_client_waits_longer_than_the_core_bounds_its_upstreams() {
        assert!(SOCKET_TIMEOUT >= Duration::from_secs(60));
    }

    #[test]
    fn socket_client_allows_only_named_session_routes() {
        for (method, path) in [
            ("POST", "/send"),
            ("POST", "/send?address=alice"),
            ("POST", "/attachments/fetch?file_id=file_1"),
            ("POST", "/connect/send"),
            ("POST", "/connect/send?to=alice"),
            ("POST", "/register"),
            ("DELETE", "/register"),
            ("POST", "/connect/leave"),
            ("POST", "/integrations/subscribe"),
            ("DELETE", "/integrations/subscribe"),
            ("GET", "/agents"),
            ("GET", "/setup/status"),
            ("GET", "/whoami"),
            ("GET", "/connect/status"),
            ("GET", "/messages?ref=0123456789ab"),
            ("GET", "/settings"),
            ("PATCH", "/settings"),
            ("POST", "/channels/subscribe?channel=swarm"),
            ("DELETE", "/channels/subscribe?channel=swarm"),
        ] {
            assert!(socket_request_allowed(method, path), "{method} {path}");
        }
        for (method, path) in [
            ("GET", "/setup/sign-in"),
            ("POST", "/attachments/fetch"),
            ("GET", "/messages"),
            ("POST", "/messages?ref=0123456789ab"),
            ("POST", "/connect/join"),
            ("POST", "/whoami"),
            ("DELETE", "/connect/leave"),
            ("GET", "/setup/status?extra=1"),
            ("POST", "/integrations/subscribe?extra=1"),
            ("GET", "/agents\r\nInjected: yes"),
            ("post", "/register"),
            ("PATCH", "/settings?extra=1"),
            ("PATCH", "/register"),
            ("PUT", "/settings"),
            ("POST", "/channels/subscribe"),
            ("GET", "/channels/subscribe?channel=swarm"),
        ] {
            assert!(!socket_request_allowed(method, path), "{method} {path}");
        }
        let error =
            socket_request(Path::new("/unused"), "GET", "/setup/sign-in", None).unwrap_err();
        assert!(error
            .to_string()
            .contains("Unsupported relay socket request"));
    }

    #[test]
    fn attachment_fetch_outlives_the_servers_fetch_budget() {
        assert!(socket_request_timeout("/attachments/fetch?file_id=file_1") > FETCH_TIMEOUT);
        assert_eq!(socket_request_timeout("/send?to=alice"), SOCKET_TIMEOUT);
    }

    #[test]
    fn subscribe_sends_only_one_named_pull_request() {
        for pull in [
            "acme/api#42",
            " acme/api#42 ",
            "https://github.com/acme/api/pull/42",
            "https://github.com/acme/api/pull/42/files",
        ] {
            let body: Value = serde_json::from_slice(&pull_subscription(pull).unwrap()).unwrap();
            assert_eq!(
                body,
                json!({"provider": "github", "resource": pull.trim()}),
                "{pull}"
            );
        }
        // A whole repository, another provider's tree, a raw glob and an
        // address elsewhere are refused before any socket is opened.
        for bad in [
            "",
            "acme/api",
            "acme/api#",
            "42",
            "pulls/api",
            "acme/pulls",
            "pulls/pulls",
            "https://github.com/acme/pulls",
            "/github/repos/acme/api/pulls/42/**",
            "/github/repos/acme/api/**",
            "https://example.com/acme/api/pull/42",
            "https://github.com/acme/api/issues/42",
            "acme/api#42\",\"to\":\"@other",
        ] {
            let error = pull_subscription(bad).unwrap_err().to_string();
            assert!(error.contains("owner/repo#123"), "{bad}: {error}");
            let error = subscribe(Path::new("/unused").into(), false, bad, false).unwrap_err();
            assert!(error.to_string().contains("owner/repo#123"), "{bad}");
        }
    }

    #[test]
    fn subscribe_accepts_a_pull_request_of_a_repository_named_pulls() {
        for pull in [
            "pulls/api#7",
            "acme/pulls#7",
            "https://github.com/pulls/pulls/pull/7",
        ] {
            assert!(pull_subscription(pull).is_ok(), "{pull}");
        }
    }

    #[test]
    fn subscribe_waits_longer_than_the_core_waits_for_a_provider() {
        assert!(SUBSCRIBE_TIMEOUT > CONNECT_WAIT + Duration::from_secs(60));
    }

    #[test]
    fn subscribe_finds_the_socket_through_its_own_builds_pointer() {
        let home = tempfile::tempdir().unwrap();
        let missing = pointed_socket(home.path(), false).unwrap_err().to_string();
        assert!(missing.contains("is not running: its"), "{missing}");
        let directory = home.path().join(".agentworkforce/desktop");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("relay-socket"), "relative.sock\n").unwrap();
        assert!(pointed_socket(home.path(), false).is_err());
        // Absolute on this platform.
        let absolute = |path: &str| {
            if cfg!(windows) {
                format!("C:{path}")
            } else {
                path.to_string()
            }
        };
        let live = absolute("/run/user/1/relay.sock");
        std::fs::write(directory.join("relay-socket"), format!("{live}\n")).unwrap();
        assert_eq!(
            pointed_socket(home.path(), false).unwrap(),
            Path::new(&live)
        );
        // The other build's pointer is named, never used in its place.
        let other = pointed_socket(home.path(), true).unwrap_err().to_string();
        assert!(other.contains("Omit --dev"), "{other}");
        let dev = absolute("/tmp/dev/relay.sock");
        std::fs::write(directory.join("relay-socket.dev"), format!("{dev}\n")).unwrap();
        assert_eq!(pointed_socket(home.path(), true).unwrap(), Path::new(&dev));
        std::fs::remove_file(directory.join("relay-socket")).unwrap();
        let other = pointed_socket(home.path(), false).unwrap_err().to_string();
        assert!(other.contains("Pass --dev"), "{other}");
    }
}
