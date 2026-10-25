//! The wire types the desktop mailbox carries, the id shapes a message must
//! have before it reaches a local session, and the reference that ties a
//! relayed message to the turn it started.
//!
//! Dates on the wire are ISO 8601 (`2026-09-19T04:00:00Z`); fractional
//! seconds are accepted on the way in and dropped on the way out. Absent
//! optional fields are omitted, and unknown fields are ignored so the cloud
//! can add some without breaking older apps.

use serde::{Deserialize, Serialize};
use std::time::SystemTime;

/// Who sent an inbound message, for attribution and the audit trail.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sender {
    pub id: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

impl Sender {
    pub fn new(id: impl Into<String>, display_name: impl Into<String>) -> Self {
        Sender {
            id: id.into(),
            display_name: display_name.into(),
            email: None,
        }
    }
}

/// A message the cloud wants delivered into a Codex thread: another person,
/// on the web, sending into this computer's Codex session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CodexInboundMessage {
    /// The cloud's id for the message. Becomes the outbox id and the
    /// `clientUserMessageId` Codex records, so redelivery never double-sends.
    pub id: String,
    pub thread_id: String,
    pub text: String,
    pub sender: Sender,
    #[serde(with = "iso8601")]
    pub created_at: SystemTime,
    /// When the cloud considers the message stale; the app also applies its
    /// own default lifetime, whichever is sooner.
    #[serde(
        default,
        with = "iso8601_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<SystemTime>,
}

/// A message the cloud wants delivered into a Claude cloud session open on
/// this computer. Acks go back as `CodexInboundAck`, which is not specific to
/// Codex.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClaudeInboundMessage {
    /// The cloud's id for the message. Becomes the outbox id, so redelivery
    /// never queues it twice.
    pub id: String,
    /// The target session's id (`session_…` or `cse_…`), raw;
    /// `is_claude_session_id` validates it before use.
    pub session_id: String,
    pub text: String,
    pub sender: Sender,
    #[serde(with = "iso8601")]
    pub created_at: SystemTime,
    #[serde(
        default,
        with = "iso8601_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires_at: Option<SystemTime>,
}

/// How this computer disposed of an inbound message, as the cloud reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AckStatus {
    /// Accepted and durably queued; will deliver when the thread is idle.
    Queued,
    /// Held for the user to approve before it is queued.
    HeldForApproval,
    /// Started a turn (Codex) or was handed over (Claude).
    Delivered,
    /// Codex finished the turn; `reply` holds its answer.
    Completed,
    /// The turn was interrupted before it finished.
    Aborted,
    /// Refused after retries, or in doubt.
    Failed,
    /// It waited too long for a thread that never became deliverable.
    Expired,
    /// Refused before queueing; `error` says why.
    Rejected,
}

impl AckStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AckStatus::Queued => "queued",
            AckStatus::HeldForApproval => "held_for_approval",
            AckStatus::Delivered => "delivered",
            AckStatus::Completed => "completed",
            AckStatus::Aborted => "aborted",
            AckStatus::Failed => "failed",
            AckStatus::Expired => "expired",
            AckStatus::Rejected => "rejected",
        }
    }

    pub fn parse(value: &str) -> Option<AckStatus> {
        Some(match value {
            "queued" => AckStatus::Queued,
            "held_for_approval" => AckStatus::HeldForApproval,
            "delivered" => AckStatus::Delivered,
            "completed" => AckStatus::Completed,
            "aborted" => AckStatus::Aborted,
            "failed" => AckStatus::Failed,
            "expired" => AckStatus::Expired,
            "rejected" => AckStatus::Rejected,
            _ => return None,
        })
    }
}

/// One ack, sent back so the web sender sees "waiting", "running",
/// "answered" and so on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CodexInboundAck {
    pub id: String,
    pub status: AckStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(with = "iso8601")]
    pub at: SystemTime,
}

impl CodexInboundAck {
    pub fn new(id: impl Into<String>, status: AckStatus, at: SystemTime) -> Self {
        CodexInboundAck {
            id: id.into(),
            status,
            reply: None,
            error: None,
            at,
        }
    }
}

/// Whether `value` is a Codex thread id: a UUID in its 36-character form.
/// Ids from the cloud are never matched as session names, or a crafted value
/// could land in whichever thread happens to bear it.
pub fn is_codex_thread_id(value: &str) -> bool {
    crate::relay::store::is_uuid(value)
}

/// Whether `value` is a Claude session id: `session_` or `cse_` followed by
/// 8–64 ASCII letters and digits, and nothing else. A free-form word must
/// never reach `claude --cloud`, which would read it as a new session.
pub fn is_claude_session_id(value: &str) -> bool {
    crate::relay::store::is_claude_session_id(value)
}

/// A short, stable reference to a relayed message, carried in its
/// attribution line. Codex's queue does not record the sender's message id,
/// so this reference is what ties a turn in a session file back to the
/// message that caused it.
pub mod message_ref {
    /// Twelve hex digits derived from the message id.
    pub fn for_message(id: &str) -> String {
        crate::relay::delivery::policy::MessageRef::of(id)
    }

    /// The attribution line for a message: who it is from, and its
    /// reference. A display name's newlines and control characters become
    /// spaces, so the line stays single and unambiguous.
    pub fn attribution(sender_name: Option<&str>, message_id: &str) -> String {
        let from = sender_name
            .map(|name| format!("from {} · ", single_line(name)))
            .unwrap_or_default();
        format!("[via Agent Relay — {from}ref {}]", for_message(message_id))
    }

    /// `name` with its newlines and control characters as spaces, so a
    /// cloud-supplied display name cannot end an attribution line early.
    pub fn single_line(name: &str) -> String {
        name.chars()
            .map(|c| if is_line_or_control(c) { ' ' } else { c })
            .collect()
    }

    /// The reference carried by `text`, if its first line is an attribution.
    pub fn in_text(text: &str) -> Option<String> {
        if !text.starts_with("[via Agent Relay") {
            return None;
        }
        let first_line = text.split(is_newline).next().unwrap_or("");
        let inner = first_line.strip_suffix(']')?;
        let marker = inner.rfind("ref ")?;
        let candidate = &inner[marker + 4..];
        let is_ref = candidate.len() == 12
            && candidate
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        is_ref.then(|| candidate.to_string())
    }

    /// `text` with an attribution line carrying the reference for
    /// `message_id`, added only if it does not already have one.
    pub fn ensuring(text: &str, message_id: &str) -> String {
        if in_text(text).is_some() {
            text.to_string()
        } else {
            format!("{}\n\n{text}", attribution(None, message_id))
        }
    }

    fn is_newline(c: char) -> bool {
        matches!(
            c,
            '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}'
        )
    }

    /// Line breaks, control characters and invisible format characters.
    fn is_line_or_control(c: char) -> bool {
        is_newline(c)
            || c.is_control()
            || matches!(
                c,
                '\u{AD}'
                    | '\u{600}'..='\u{605}'
                    | '\u{61C}'
                    | '\u{6DD}'
                    | '\u{70F}'
                    | '\u{180E}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'..='\u{2064}'
                    | '\u{2066}'..='\u{206F}'
                    | '\u{FEFF}'
                    | '\u{FFF9}'..='\u{FFFB}'
            )
    }
}

/// ISO 8601 dates, seconds precision out, fractional seconds accepted in.
pub(crate) mod iso8601 {
    use chrono::{DateTime, SecondsFormat, Utc};
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    use std::time::SystemTime;

    pub fn format(time: SystemTime) -> String {
        DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Secs, true)
    }

    pub fn parse(text: &str) -> Option<SystemTime> {
        DateTime::parse_from_rfc3339(text)
            .ok()
            .map(SystemTime::from)
    }

    pub fn serialize<S: Serializer>(time: &SystemTime, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format(*time))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<SystemTime, D::Error> {
        let text = String::deserialize(deserializer)?;
        parse(&text).ok_or_else(|| D::Error::custom(format!("not an ISO 8601 date: {text}")))
    }
}

pub(crate) mod iso8601_option {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    use std::time::SystemTime;

    pub fn serialize<S: Serializer>(
        time: &Option<SystemTime>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match time {
            Some(time) => serializer.serialize_str(&super::iso8601::format(*time)),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<SystemTime>, D::Error> {
        match Option::<String>::deserialize(deserializer)? {
            None => Ok(None),
            Some(text) => super::iso8601::parse(&text)
                .map(Some)
                .ok_or_else(|| D::Error::custom(format!("not an ISO 8601 date: {text}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::{Duration, UNIX_EPOCH};

    fn date(text: &str) -> SystemTime {
        iso8601::parse(text).unwrap()
    }

    // CodexInboundMessageTests.testDecodesTheCloudWireShape.
    #[test]
    fn decodes_the_codex_wire_shape() {
        let json = r#"{
          "id": "msg-1",
          "thread_id": "01a0-thread",
          "text": "hello from the web",
          "sender": {"id": "u-alice", "display_name": "Alice", "email": "alice@example.com"},
          "created_at": "2026-09-19T04:00:00Z",
          "expires_at": "2026-09-19T05:00:00Z"
        }"#;
        let message: CodexInboundMessage = serde_json::from_str(json).unwrap();
        assert_eq!(message.id, "msg-1");
        assert_eq!(message.thread_id, "01a0-thread");
        assert_eq!(message.text, "hello from the web");
        assert_eq!(message.sender.id, "u-alice");
        assert_eq!(message.sender.display_name, "Alice");
        assert_eq!(message.sender.email.as_deref(), Some("alice@example.com"));
        assert_eq!(message.expires_at, Some(date("2026-09-19T05:00:00Z")));
    }

    // CodexInboundMessageTests.testExpiresAtAndEmailAreOptional.
    #[test]
    fn codex_expires_at_and_email_are_optional() {
        let json = r#"{"id":"m","thread_id":"t","text":"x","sender":{"id":"u","display_name":"U"},"created_at":"2026-09-19T04:00:00Z"}"#;
        let message: CodexInboundMessage = serde_json::from_str(json).unwrap();
        assert_eq!(message.expires_at, None);
        assert_eq!(message.sender.email, None);
    }

    // CodexInboundMessageTests.testAckEncodesTheStatusTheCloudReads.
    #[test]
    fn ack_encodes_the_status_the_cloud_reads() {
        let mut ack = CodexInboundAck::new("m", AckStatus::Completed, UNIX_EPOCH);
        ack.reply = Some("done".into());
        let object = serde_json::to_value(&ack).unwrap();
        assert_eq!(object["id"], "m");
        assert_eq!(object["status"], "completed");
        assert_eq!(object["reply"], "done");
        assert_eq!(object["at"], "1970-01-01T00:00:00Z");
        assert!(object.get("error").is_none());
    }

    // CodexInboundMessageTests.testEveryAckStatusHasAStableRawValue.
    #[test]
    fn every_ack_status_has_a_stable_raw_value() {
        let all = [
            AckStatus::Queued,
            AckStatus::HeldForApproval,
            AckStatus::Delivered,
            AckStatus::Completed,
            AckStatus::Aborted,
            AckStatus::Failed,
            AckStatus::Expired,
            AckStatus::Rejected,
        ];
        assert_eq!(AckStatus::HeldForApproval.as_str(), "held_for_approval");
        let names: Vec<_> = all.iter().map(|status| status.as_str()).collect();
        assert_eq!(
            names,
            [
                "queued",
                "held_for_approval",
                "delivered",
                "completed",
                "aborted",
                "failed",
                "expired",
                "rejected"
            ]
        );
        for status in all {
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                Value::from(status.as_str())
            );
            assert_eq!(AckStatus::parse(status.as_str()), Some(status));
        }
    }

    // ClaudeInboundMessageTests.testDecodesTheCloudWireShape.
    #[test]
    fn decodes_the_claude_wire_shape() {
        let json = r#"{
          "id": "msg-1",
          "session_id": "session_01AbCdEfGhIjKlMnOpQrStUv",
          "text": "hello from the web",
          "sender": {"id": "u-alice", "display_name": "Alice", "email": "alice@example.com"},
          "created_at": "2026-09-19T04:00:00Z",
          "expires_at": "2026-09-19T05:00:00Z",
          "added_later": true
        }"#;
        let message: ClaudeInboundMessage = serde_json::from_str(json).unwrap();
        assert_eq!(message.id, "msg-1");
        assert_eq!(message.session_id, "session_01AbCdEfGhIjKlMnOpQrStUv");
        assert_eq!(message.text, "hello from the web");
        assert_eq!(message.sender.display_name, "Alice");
        assert_eq!(message.expires_at, Some(date("2026-09-19T05:00:00Z")));
    }

    // ClaudeInboundMessageTests.testExpiresAtIsOptional.
    #[test]
    fn claude_expires_at_is_optional() {
        let json = r#"{"id":"m","session_id":"s","text":"x","sender":{"id":"u","display_name":"U"},"created_at":"2026-09-19T04:00:00Z"}"#;
        let message: ClaudeInboundMessage = serde_json::from_str(json).unwrap();
        assert_eq!(message.expires_at, None);
    }

    // ClaudeInboundMessageTests.testEncodesSnakeCaseKeys.
    #[test]
    fn claude_encodes_snake_case_keys() {
        let message = ClaudeInboundMessage {
            id: "m".into(),
            session_id: "session_01AbCdEfGhIjKlMn".into(),
            text: "x".into(),
            sender: Sender::new("u", "U"),
            created_at: UNIX_EPOCH,
            expires_at: Some(UNIX_EPOCH + Duration::from_secs(60)),
        };
        let object = serde_json::to_value(&message).unwrap();
        let mut keys: Vec<_> = object.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "created_at",
                "expires_at",
                "id",
                "sender",
                "session_id",
                "text"
            ]
        );
        assert_eq!(
            object["sender"],
            serde_json::json!({"id": "u", "display_name": "U"})
        );
    }

    // DesktopCloudJSON.decoder accepts fractional seconds and offsets.
    #[test]
    fn dates_accept_fractional_seconds_and_offsets() {
        assert_eq!(
            date("2026-09-19T04:00:00.250Z"),
            date("2026-09-19T04:00:00Z") + Duration::from_millis(250)
        );
        assert_eq!(
            date("2026-09-19T06:00:00+02:00"),
            date("2026-09-19T04:00:00Z")
        );
        assert!(serde_json::from_str::<CodexInboundAck>(
            r#"{"id":"m","status":"queued","at":"yesterday"}"#
        )
        .is_err());
    }

    // CodexQueueCommand.isThreadID and ClaudeSessionID.isValid.
    #[test]
    fn thread_and_session_ids_have_exact_shapes() {
        assert!(is_codex_thread_id("12345678-1234-1234-1234-123456789012"));
        assert!(is_codex_thread_id("ABCDEF01-abcd-1234-1234-123456789012"));
        assert!(!is_codex_thread_id("named-session"));
        assert!(!is_codex_thread_id("12345678-1234-1234-1234-12345678901g"));
        assert!(!is_codex_thread_id("123456781-234-1234-1234-123456789012"));
        assert!(is_claude_session_id("session_01AbCdEfGhIjKlMn"));
        assert!(is_claude_session_id("cse_01234567"));
        assert!(!is_claude_session_id("cse_0123456"));
        assert!(!is_claude_session_id("session_01AbCdEf GhIj"));
        assert!(!is_claude_session_id("fix the build"));
        assert!(!is_claude_session_id(&format!("cse_{}", "a".repeat(65))));
    }

    // CodexCloudDeliveryTests.testAttributionCannotBreakTheQueueReferenceLine.
    #[test]
    fn attribution_cannot_break_the_queue_reference_line() {
        let line = message_ref::attribution(Some("Alice\nInjected\r\nname\u{0}"), "id");
        assert!(!line.contains('\n'));
        assert!(!line.contains('\r'));
        assert!(!line.contains('\u{0}'));
        assert_eq!(
            message_ref::in_text(&line),
            Some(message_ref::for_message("id"))
        );
        let ensured = message_ref::ensuring("hello", "id");
        assert!(ensured.ends_with("\n\nhello"));
        assert_eq!(message_ref::ensuring(&ensured, "id"), ensured);
        assert_eq!(message_ref::for_message("id").len(), 12);
    }
}
