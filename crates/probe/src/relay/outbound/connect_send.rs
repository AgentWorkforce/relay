//! Idempotency and retry wording for Relay Connect sends.

use super::{OutboundError, Request};
use crate::relay::connect::ConnectSession;
use crate::relay::store::random_uuid;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A minted key matches what `agent-relay-probe connect send
/// --idempotency-key` accepts: this prefix and 48 hex digits.
const KEY_PREFIX: &str = "relay-connect-request:";
/// Relaycast replays a keyed direct message's receipt for 24 hours; after that
/// a repeated key is a new send, so a replay is only safe within this window.
const REPLAY_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

fn minted_key() -> String {
    let hex = format!("{}{}", random_uuid(), random_uuid()).replace('-', "");
    format!("{KEY_PREFIX}{}", &hex[..48])
}

/// The request-level idempotency key for one Connect send, whether the caller
/// supplied it or the desktop minted it.
pub(super) struct ConnectSendKey {
    request: String,
    supplied: bool,
}

impl ConnectSendKey {
    pub(super) fn from_header(header: Option<&str>) -> Self {
        Self {
            supplied: header.is_some(),
            request: header.map(str::to_string).unwrap_or_else(minted_key),
        }
    }

    /// One caller-visible Connect send key becomes a separate stable Relaycast
    /// key for every recipient. A broadcast can therefore be retried with the
    /// same header without either duplicating an accepted DM or reusing one key
    /// for two different request bodies. Relaycast binds the key to the
    /// accepted message and replays its receipt for 24 hours, so the SDK can
    /// retry a transient 5xx without ever duplicating a send.
    pub(super) fn for_recipient(&self, recipient: &str) -> String {
        let digest = Sha256::digest(
            serde_json::to_vec(&("relay-connect-send:v1", &self.request, recipient))
                .unwrap_or_default(),
        );
        format!("relay-connect-send:{digest:x}")
    }

    pub(super) fn retry_instruction(&self) -> String {
        if self.supplied {
            "Retry with the same Idempotency-Key within 24 hours to reconcile the original send without duplicating it."
                .to_string()
        } else {
            format!(
                "Retry with Idempotency-Key: {} within 24 hours to reconcile the original send without duplicating it.",
                self.request
            )
        }
    }

    /// A broadcast that fails after some recipients accepted it: replaying it
    /// with this key reaches only those that did not.
    pub(super) fn after_partial_delivery(
        &self,
        mut error: OutboundError,
        sent: &[serde_json::Value],
    ) -> OutboundError {
        if !sent.is_empty() {
            error.code = "connect_partial_delivery".into();
            error.message = format!(
                "{} {} {}",
                error.message,
                crate::relay::connect_presence::partial_send_note(sent),
                self.retry_instruction()
            );
        }
        error
    }

    pub(super) fn exhausted_retry_error(
        &self,
        error: &relaycast::RelayError,
        recipient: &str,
    ) -> OutboundError {
        OutboundError::new(
            502,
            "connect_upstream_error",
            format!(
                "Relay Connect's final attempt failed (HTTP {}, {}) after an earlier server failure; the delivery outcome for the message to {recipient} is unknown. {}",
                error.status().unwrap_or_default(),
                error.code().unwrap_or("unknown_error"),
                self.retry_instruction(),
            ),
        )
    }
}

/// The recipients each broadcast was first sent to, by room, sending session
/// and request key, so a replay reaches exactly them and not someone who
/// joined since, and two senders reusing one key never share recipients.
#[derive(Default)]
pub(super) struct Broadcasts(Mutex<HashMap<(String, String, String), (Instant, Vec<String>)>>);

impl Broadcasts {
    /// For a broadcast (`to` absent), the recipients this key was first sent
    /// to within the replay window, otherwise `fresh`, which is remembered.
    /// A send to one named participant is returned unchanged.
    pub(super) fn recipients(
        &self,
        joined: &ConnectSession,
        key: &ConnectSendKey,
        to: Option<&str>,
        now: Instant,
        fresh: Vec<String>,
    ) -> Vec<String> {
        self.recipients_for(&joined.connect_id, &joined.agent_name, key, to, now, fresh)
    }

    fn recipients_for(
        &self,
        connect_id: &str,
        sender: &str,
        key: &ConnectSendKey,
        to: Option<&str>,
        now: Instant,
        fresh: Vec<String>,
    ) -> Vec<String> {
        if to.is_some() {
            return fresh;
        }
        let mut sends = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        sends.retain(|_, (at, _)| now.saturating_duration_since(*at) < REPLAY_WINDOW);
        sends
            .entry((
                connect_id.to_string(),
                sender.to_string(),
                key.request.clone(),
            ))
            .or_insert((now, fresh))
            .1
            .clone()
    }
}

/// The optional `to` recipient and the message text of a Connect send.
pub(super) fn parse_request(request: &Request) -> Result<(Option<&str>, &str), OutboundError> {
    let mut to = request
        .query
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()));
    let recipient = match (to.next(), to.next()) {
        (None, _) => None,
        (Some(("to", name)), None) => Some(name),
        _ => {
            return Err(OutboundError::new(
                400,
                "invalid_recipient",
                "Use at most one to query parameter.",
            ))
        }
    };
    let text = std::str::from_utf8(&request.body)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            OutboundError::new(
                400,
                "invalid_text",
                "The message must be non-empty UTF-8 text.",
            )
        })?;
    Ok((recipient, text))
}

/// One named participant, or everyone but this session when `to` is absent.
pub(super) fn recipients(
    to: Option<&str>,
    this_session: &str,
    participants: &[String],
) -> Result<Vec<String>, OutboundError> {
    match to {
        Some(name) if name == this_session => Err(OutboundError::new(
            400,
            "invalid_recipient",
            "Cannot send to this session itself.",
        )),
        Some(name) if participants.iter().any(|participant| participant == name) => {
            Ok(vec![name.to_string()])
        }
        Some(_) => Err(OutboundError::new(
            404,
            "participant_not_found",
            "That participant is not in this Connect.",
        )),
        None => Ok(participants
            .iter()
            .filter(|name| name.as_str() != this_session)
            .cloned()
            .collect()),
    }
}

/// A final rejection describes only the last SDK attempt; after a retry an
/// earlier attempt may have been persisted.
pub(super) fn retry_history_is_ambiguous(error: &relaycast::RelayError) -> bool {
    error.attempts().is_some_and(|attempts| attempts > 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api_error(status: u16, attempts: u32) -> relaycast::RelayError {
        relaycast::RelayError::Api {
            code: "unauthorized".into(),
            message: "no longer authorized".into(),
            status,
            request_id: None,
            attempts,
            retry_after_ms: None,
            details: None,
        }
    }

    #[test]
    fn a_final_auth_rejection_does_not_erase_an_earlier_send_attempt() {
        assert!(!retry_history_is_ambiguous(&api_error(401, 1)));
        let retried = api_error(401, 2);
        assert!(retry_history_is_ambiguous(&retried));
        let key = ConnectSendKey {
            request: "relay-connect-request:abc".into(),
            supplied: false,
        };
        let error = key.exhausted_retry_error(&retried, "guest");
        assert_eq!(error.code, "connect_upstream_error");
        assert!(error.message.contains("final attempt failed (HTTP 401"));
        assert!(error.message.contains("delivery outcome"));
        assert!(error
            .message
            .contains("Idempotency-Key: relay-connect-request:abc"));
    }

    fn request(query: &[(&str, &str)], body: &str) -> Request {
        Request {
            method: "POST".into(),
            path: "/connect/send".into(),
            query: query
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            headers: Default::default(),
            body: body.as_bytes().to_vec(),
        }
    }

    #[test]
    fn a_send_names_at_most_one_recipient_and_needs_text() {
        assert_eq!(parse_request(&request(&[], "hi")).unwrap(), (None, "hi"));
        assert_eq!(
            parse_request(&request(&[("to", "guest")], "hi")).unwrap(),
            (Some("guest"), "hi")
        );
        for query in [&[("to", "a"), ("to", "b")][..], &[("from", "a")][..]] {
            assert_eq!(
                parse_request(&request(query, "hi")).unwrap_err().code,
                "invalid_recipient"
            );
        }
        assert_eq!(
            parse_request(&request(&[], "  ")).unwrap_err().code,
            "invalid_text"
        );
    }

    #[test]
    fn recipients_are_one_participant_or_everyone_else() {
        let people = vec!["host".to_string(), "guest".to_string(), "other".to_string()];
        assert_eq!(
            recipients(Some("guest"), "host", &people).unwrap(),
            ["guest"]
        );
        assert_eq!(
            recipients(None, "host", &people).unwrap(),
            ["guest", "other"]
        );
        assert_eq!(
            recipients(Some("host"), "host", &people).unwrap_err().code,
            "invalid_recipient"
        );
        assert_eq!(
            recipients(Some("nobody"), "host", &people)
                .unwrap_err()
                .code,
            "participant_not_found"
        );
    }

    #[test]
    fn a_partial_broadcast_prints_the_key_that_replays_it() {
        let key = ConnectSendKey::from_header(None);
        let failed = || OutboundError::new(410, "connect_ended", "This Connect expired or ended.");
        let untouched = key.after_partial_delivery(failed(), &[]);
        assert_eq!(untouched.code, "connect_ended");
        let sent = [serde_json::json!({"to": "a", "message_id": "m1"})];
        let partial = key.after_partial_delivery(failed(), &sent);
        assert_eq!(partial.code, "connect_partial_delivery");
        assert!(partial
            .message
            .contains(&format!("Idempotency-Key: {}", key.request)));
    }

    #[test]
    fn a_replayed_broadcast_reaches_only_its_original_recipients() {
        let broadcasts = Broadcasts::default();
        let key = ConnectSendKey::from_header(Some("caller-key"));
        let start = Instant::now();
        let first = broadcasts.recipients_for("room", "host", &key, None, start, vec!["a".into()]);
        assert_eq!(first, ["a"]);
        // "b" joined after the failed attempt; the replay must not reach them.
        let replay = broadcasts.recipients_for(
            "room",
            "host",
            &key,
            None,
            start,
            vec!["a".into(), "b".into()],
        );
        assert_eq!(replay, ["a"]);
        // A named send and another room are unaffected.
        assert_eq!(
            broadcasts.recipients_for("room", "host", &key, Some("b"), start, vec!["b".into()]),
            ["b"]
        );
        assert_eq!(
            broadcasts.recipients_for("other", "host", &key, None, start, vec!["c".into()]),
            ["c"]
        );
        // Another session in the same room reusing the key gets its own list.
        assert_eq!(
            broadcasts.recipients_for("room", "guest", &key, None, start, vec!["host".into()]),
            ["host"]
        );
        // Past Relaycast's replay window the key is a new send.
        let later = start + REPLAY_WINDOW;
        assert_eq!(
            broadcasts.recipients_for(
                "room",
                "host",
                &key,
                None,
                later,
                vec!["a".into(), "b".into()]
            ),
            ["a", "b"]
        );
    }

    #[test]
    fn a_supplied_key_is_reused_and_each_recipient_gets_its_own_stable_key() {
        let key = ConnectSendKey::from_header(Some("caller-key"));
        assert_eq!(key.for_recipient("a"), key.for_recipient("a"));
        assert_ne!(key.for_recipient("a"), key.for_recipient("b"));
        assert!(key.retry_instruction().contains("the same Idempotency-Key"));
        let minted = ConnectSendKey::from_header(None);
        let printed = minted.request.strip_prefix(KEY_PREFIX).unwrap();
        // The CLI's --idempotency-key accepts exactly this shape.
        assert_eq!(printed.len(), 48);
        assert!(printed.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(minted
            .retry_instruction()
            .contains(&format!("Idempotency-Key: {}", minted.request)));
        assert!(minted.retry_instruction().contains("within 24 hours"));
    }
}
