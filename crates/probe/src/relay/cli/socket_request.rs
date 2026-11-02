//! `relay socket-request`: the probe's own client for this core's session
//! socket, limited to the routes sessions use.

use super::{socket_exchange, socket_request_timeout};
use crate::relay::daemon::SafeError;
use anyhow::Result;
use std::io::Read;
use std::path::Path;

/// A small socket client for session-scoped requests, for people and
/// debugging. Apple's /usr/bin/curl does not expose CODEX_THREAD_ID to
/// KERN_PROCARGS2; this executable does, so the core can identify its
/// calling thread. No sandbox or permission rule allows it: it can reach
/// setting, setup and registration routes, so the hints a session is handed
/// name the self-limiting commands in `session_cli` instead. On
/// Windows the session socket is a named pipe, which curl cannot open, so
/// this is the only client there: it also carries the agent-led setup
/// routes ("The relay-send socket" in `docs/relay-core.md`) that a script drives with curl over
/// the Unix socket elsewhere.
pub(super) fn socket_request_allowed(method: &str, path: &str) -> bool {
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
                    "/register"
                        | "/connect/leave"
                        | "/integrations/subscribe"
                        | "/setup/sign-in"
                        | "/setup/sharing"
                        | "/setup/auto-activate"
                        | "/setup/direct-delivery"
                        | "/webhooks"
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
                || matches!(path, "/register" | "/integrations/subscribe" | "/webhooks")
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
