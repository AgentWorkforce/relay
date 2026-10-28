//! `agent-relay-probe relay settings`: read or change Agent Relay's settings
//! from inside a Codex or Claude session, through the session socket's
//! `GET /settings` and `PATCH /settings` (`outbound::settings`). Like
//! `relay subscribe`, the session is told from this process, so a macOS
//! Codex session that `curl` cannot identify can still use it.

use crate::relay::cli::{pointed_socket, socket_exchange, SOCKET_TIMEOUT};
use crate::relay::daemon::SafeError;
use crate::relay::paths;
use anyhow::Result;
use serde_json::{Map, Value};
use std::path::Path;

/// Prints every setting, or with `changes` (`key=value` each) changes them
/// and prints what changed.
pub fn settings(socket: Option<&Path>, development: bool, changes: &[String]) -> Result<()> {
    let socket = match socket {
        Some(socket) => socket.to_path_buf(),
        None => pointed_socket(&paths::home()?, development)?,
    };
    if changes.is_empty() {
        return socket_exchange(&socket, "GET", "/settings", b"", SOCKET_TIMEOUT);
    }
    let body = change_body(changes)?;
    socket_exchange(&socket, "PATCH", "/settings", &body, SOCKET_TIMEOUT)
}

/// The JSON object `key=value` pairs name. A value is read as JSON
/// (`true`, `8`, `["a/b"]`) and otherwise kept as text (`api`).
fn change_body(changes: &[String]) -> Result<Vec<u8>> {
    let mut body = Map::new();
    for change in changes {
        let (key, value) = change
            .split_once('=')
            .filter(|(key, _)| !key.trim().is_empty())
            .ok_or_else(|| {
                SafeError(format!(
                    "Name each change as key=value, such as auto_join_general=true; got {change}."
                ))
            })?;
        let value = serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.into()));
        body.insert(key.trim().to_string(), value);
    }
    Ok(serde_json::to_vec(&body)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body(changes: &[&str]) -> Value {
        let changes: Vec<String> = changes.iter().map(|c| c.to_string()).collect();
        serde_json::from_slice(&change_body(&changes).unwrap()).unwrap()
    }

    #[test]
    fn values_are_json_where_they_parse_and_text_otherwise() {
        assert_eq!(
            body(&[
                "auto_join_general=true",
                "spawn_max_agents=4",
                "spawn_billing_codex=api"
            ]),
            json!({"auto_join_general": true, "spawn_max_agents": 4, "spawn_billing_codex": "api"})
        );
        assert_eq!(
            body(&["spawn_repositories=[\"o/r\"]"]),
            json!({"spawn_repositories": ["o/r"]})
        );
    }

    #[test]
    fn a_change_without_a_key_is_refused_before_the_socket() {
        for bad in ["auto_join_general", "=true"] {
            let error = change_body(&[bad.to_string()]).unwrap_err();
            let message = &error.downcast_ref::<SafeError>().unwrap().0;
            assert!(message.contains("key=value"), "{message}");
        }
    }
}
