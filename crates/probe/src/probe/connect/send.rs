//! `connect send`: one keyed message, and what to tell the caller when its
//! outcome is uncertain.

use anyhow::{ensure, Result};
use serde_json::Value;
use std::io::Read;
use std::path::Path;

use super::{random_id, socket_call_with_headers, SafeError, SocketError};

const KEY_PREFIX: &str = "relay-connect-request:";

fn valid_key(value: &str) -> bool {
    value
        .strip_prefix(KEY_PREFIX)
        .is_some_and(|suffix| suffix.len() == 48 && suffix.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Send stdin to one participant, or everyone when `to` is absent. Every send
/// carries an idempotency key; a failed send reports it so the exact send can
/// be repeated without duplicating what was already accepted.
pub(super) fn run(
    socket: &Path,
    to: Option<String>,
    idempotency_key: Option<String>,
) -> Result<Value> {
    if let Some(key) = &idempotency_key {
        ensure!(
            valid_key(key),
            SafeError("Use the relay-connect-request key printed by the failed send.".into())
        );
    }
    let mut text = Vec::new();
    std::io::stdin().take(16_001).read_to_end(&mut text)?;
    ensure!(
        !text.is_empty() && text.len() <= 16_000,
        SafeError("Send 1–16000 bytes of message text on stdin.".into())
    );
    let path = to
        .map(|to| {
            format!(
                "/connect/send?to={}",
                url::form_urlencoded::byte_serialize(to.as_bytes()).collect::<String>()
            )
        })
        .unwrap_or_else(|| "/connect/send".into());
    let request_key = match idempotency_key {
        Some(key) => key,
        None => format!("{KEY_PREFIX}{}", random_id()?),
    };
    socket_call_with_headers(
        socket,
        "POST",
        &path,
        &text,
        &[("Idempotency-Key", &request_key)],
    )
    .map_err(|cause| -> anyhow::Error {
        let code = match cause.downcast::<SocketError>() {
            Ok(SocketError(code, _, _)) => code,
            Err(_) => "connect_unreachable".into(),
        };
        SocketError(code, true, Some(request_key.clone())).into()
    })
}

/// What a failed send's caller must know before trying again. The server's
/// message is never printed, so this preserves whether a retry is safe.
pub(super) fn outcome_hint(code: &str, key: Option<&str>) -> Option<String> {
    let ambiguous = matches!(
        code,
        "connect_unreachable" | "connect_upstream_error" | "connect_internal_error"
    );
    match (code, key) {
        ("connect_partial_delivery", Some(key)) => Some(format!(
            "Some recipients already accepted the message. Repeat the exact send with --idempotency-key {key} within 24 hours; it will not duplicate those recipients."
        )),
        ("connect_partial_delivery", None) => Some(
            "Some recipients already accepted the message. Check the socket response before resending.".into(),
        ),
        (_, Some(key)) if ambiguous => Some(format!(
            "The delivery outcome is unknown. Repeat the exact send with --idempotency-key {key} within 24 hours to reconcile it without duplication."
        )),
        (_, None) if ambiguous => {
            Some("A message may already have been delivered; check before resending.".into())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_send_says_how_to_retry_it_safely() {
        let key = format!("{KEY_PREFIX}{}", "a".repeat(48));
        let interrupted = outcome_hint("connect_unreachable", Some(&key)).unwrap();
        assert!(interrupted.contains(&format!("--idempotency-key {key}")));
        assert!(interrupted.contains("without duplication"));
        assert!(interrupted.contains("within 24 hours"));
        let partial = outcome_hint("connect_partial_delivery", Some(&key)).unwrap();
        assert!(partial.contains("Some recipients already accepted"));
        assert!(partial.contains("within 24 hours"));
        assert!(partial.contains(&format!("--idempotency-key {key}")));
        assert!(outcome_hint("connect_auth_rejected", Some(&key)).is_none());

        assert!(valid_key(&key));
        assert!(!valid_key("another-key"));
        assert!(!valid_key(&format!("{KEY_PREFIX}{}", "z".repeat(48))));
    }
}
