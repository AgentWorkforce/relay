//! The reply line a Relay Connect message carries, so the guest answers in
//! its room over this core's session socket.

use crate::relay::outbound::{probe_client, query_encode, shell_quote};
use crate::relay::store::SessionKind;
use std::path::Path;

/// The reply line for a Relay Connect message, then the route line that
/// keeps the answer on it (`hosted_mcp::ROUTE_LINE`).
pub(super) fn connect_reply_hint(
    socket: &Path,
    sender: &str,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    connect_reply_line(socket, sender, kind, needs_probe)
        .map(|line| format!("{line}\n{}", crate::relay::hosted_mcp::ROUTE_LINE))
}

pub(super) fn connect_reply_line(
    socket: &Path,
    sender: &str,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    let socket = socket.to_str()?;
    let request_path = format!("/connect/send?to={}", query_encode(sender));
    // macOS hides the environment of /usr/bin/curl from KERN_PROCARGS2.
    // Use the probe executable so an app-server command keeps its thread ID,
    // and a Cursor editor tool its `CURSOR_CONVERSATION_ID`.
    // On Windows the socket is a named pipe curl cannot reach, so every
    // session gets the probe client.
    // Claude Code's permission rules from Agent Relay allow the probe's
    // client (`outbound::prefers_probe_client`); curl only when it is unknown.
    let required = cfg!(windows)
        || (matches!(kind, SessionKind::Codex | SessionKind::CursorCli)
            && probe_client(needs_probe));
    if required || crate::relay::outbound::prefers_probe_client(kind) {
        let reply = crate::relay::session_cli::SessionCommand::ConnectSend {
            to: Some(sender.to_string()),
        };
        let command = crate::relay::outbound::probe_session_command(
            Path::new(socket),
            &reply,
            Some("your reply"),
        );
        if command.is_some() || required {
            return Some(format!("[reply: {}]", command?));
        }
    }
    let url = format!("http://relay{request_path}");
    let parts = [
        "curl",
        "-s",
        "--unix-socket",
        socket,
        &url,
        "--data-binary",
        "@-",
    ];
    Some(format!(
        "[reply: {}]",
        parts
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" ")
    ))
}
