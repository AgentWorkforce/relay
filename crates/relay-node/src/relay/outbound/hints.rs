//! The commands an injected message hands a session for replying, finding
//! peers and fetching attachments over this core's session socket: the
//! probe's own client where curl cannot serve (`super::probe_client`) or
//! Agent Relay's rules allow it (`super::prefers_probe_client`), else curl.

use super::{fetch, prefers_probe_client, probe_client};
use crate::relay::session_cli::{Recipient, SessionCommand};
use crate::relay::store::SessionKind;
use std::path::Path;

/// The line an injected message carries so the session can answer beneath
/// it, and find other participants. The recipient comes from the sender,
/// so it is percent-encoded and every argument shell-quoted: a name cannot
/// break out of the suggested command.
pub fn reply_hint(
    socket: &Path,
    to: Option<&str>,
    address: Option<&str>,
    reply_to: &str,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    let (key, recipient) = match (to, address) {
        (Some(to), None) => ("to", to),
        (None, Some(address)) => ("address", address),
        _ => return None,
    };
    if reply_to.is_empty() {
        return None;
    }
    let path = socket.to_str()?;
    let request_path = format!(
        "/send?{key}={}&reply_to={}",
        query_encode(recipient),
        query_encode(reply_to)
    );
    if probe_client(needs_probe) || prefers_probe_client(kind) {
        let probe = (|| {
            let recipient = match key {
                "to" => Recipient::To(recipient.to_string()),
                _ => Recipient::Address(recipient.to_string()),
            };
            let reply = SessionCommand::Send {
                recipient,
                reply_to: Some(reply_to.to_string()),
                thread: None,
            };
            let send = probe_session_command(socket, &reply, Some("your reply"))?;
            let agents = probe_session_command(socket, &SessionCommand::Agents, None)?;
            Some(format!("[reply: {send}]\n[agents: {agents}]"))
        })();
        // Only where curl cannot reach the socket is there no fallback.
        if probe.is_some() || probe_client(needs_probe) {
            return probe;
        }
    }
    let url = format!("http://relay{request_path}");
    let send = [
        "curl",
        "-s",
        "--unix-socket",
        path,
        &url,
        "--data-binary",
        "your reply",
    ];
    let agents = ["curl", "-s", "--unix-socket", path, "http://relay/agents"];
    let quoted = |parts: &[&str]| {
        parts
            .iter()
            .map(|p| shell_quote(p))
            .collect::<Vec<_>>()
            .join(" ")
    };
    Some(format!(
        "[reply: {}]\n[agents: {}]",
        quoted(&send),
        quoted(&agents)
    ))
}

/// The command a session runs to fetch an attachment it could not get in
/// time, through `POST /attachments/fetch` on the session socket. Built like
/// [`reply_hint`]: the probe on macOS where Apple's curl hides the session's
/// environment, curl elsewhere; the id was checked to be a plain token.
pub fn fetch_hint(
    socket: &Path,
    file_id: &str,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    let path = socket.to_str()?;
    let request_path = format!("/attachments/fetch?file_id={}", query_encode(file_id));
    if probe_client(needs_probe) || prefers_probe_client(kind) {
        let fetch = SessionCommand::FetchAttachment {
            file_id: file_id.to_string(),
        };
        let probe = probe_session_command(socket, &fetch, None);
        if probe.is_some() || probe_client(needs_probe) {
            return probe;
        }
    }
    let url = format!("http://relay{request_path}");
    Some(
        ["curl", "-s", "-X", "POST", "--unix-socket", path, &url]
            .iter()
            .map(|p| shell_quote(p))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// `command` through the current probe executable, as a hint names it: one
/// of the self-limiting session commands (`session_cli`) that Codex's
/// sandbox rules and Claude Code's permission rules allow.
pub(crate) fn probe_session_command(
    socket: &Path,
    command: &SessionCommand,
    body: Option<&str>,
) -> Option<String> {
    command.command_line(&fetch::probe_executable()?, socket, body)
}

/// `relay socket-request` through the current probe executable, whose
/// environment remains inspectable on macOS when Apple's system curl does
/// not expose CODEX_THREAD_ID or AGENT_RELAY_OPENCODE_SESSION. For a route
/// no session command serves (`/register`, `/whoami`, a channel
/// subscription); no rule allows it, so it asks.
pub(crate) fn probe_socket_command(socket: &Path, method: &str, path: &str) -> Option<String> {
    probe_command(socket, method, path, None)
}

/// [`probe_socket_command`] with its request body as `--body`.
pub(crate) fn probe_socket_command_with_body(
    socket: &Path,
    method: &str,
    path: &str,
    body: &str,
) -> Option<String> {
    probe_command(socket, method, path, Some(body))
}

fn probe_command(socket: &Path, method: &str, path: &str, body: Option<&str>) -> Option<String> {
    probe_command_for(&fetch::probe_executable()?, socket, method, path, body)
}

/// [`probe_command`] through `executable`.
pub(crate) fn probe_command_for(
    executable: &Path,
    socket: &Path,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Option<String> {
    let mut parts = vec![
        executable.to_str()?,
        "relay",
        "socket-request",
        "--socket",
        socket.to_str()?,
        "--method",
        method,
        "--path",
        path,
    ];
    if let Some(body) = body {
        parts.extend(["--body", body]);
    }
    Some(
        parts
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

pub(crate) fn query_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~@".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub fn shell_quote(value: &str) -> String {
    let safe = |c: char| c.is_ascii_alphanumeric() || "%+,-./:=@_".contains(c);
    if !value.is_empty() && value.chars().all(safe) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}
