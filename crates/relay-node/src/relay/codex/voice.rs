//! Validate an authenticated Cloud voice lookup against one relay delivery.
//! This does not turn sender-supplied metadata into authority. The caller
//! must obtain the response through the authorized Cloud route and derive the
//! expected fields from the delivered message and current registration.

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;

/// All identifiers that one Fast turn must match. In particular, the Relay
/// message ID exists only after Relaycast stores the DM.
pub(crate) struct Binding<'a> {
    pub workspace_id: &'a str,
    /// Relaycast's immutable `message.agent_id`, as delivered to this node.
    pub sender_agent_id: &'a str,
    pub recipient_agent_id: &'a str,
    pub recipient_session_id: &'a str,
    pub message_id: &'a str,
    pub request_id: &'a str,
}

/// Accept only a fresh, exact match from Cloud. Error responses, absent
/// fields, and sender-asserted hints all fail closed to ordinary service.
pub(crate) fn authorized(response: &Value, binding: &Binding<'_>, now: DateTime<Utc>) -> bool {
    if response["authorized"].as_bool() != Some(true) {
        return false;
    }
    for (field, expected) in [
        ("workspaceId", binding.workspace_id),
        ("senderAgentId", binding.sender_agent_id),
        ("recipientAgentId", binding.recipient_agent_id),
        ("recipientSessionId", binding.recipient_session_id),
        ("messageId", binding.message_id),
        ("requestId", binding.request_id),
    ] {
        if expected.is_empty() || response[field].as_str() != Some(expected) {
            return false;
        }
    }
    // Cloud alone resolves this Relaycast identity to a current person.
    // The node cannot assert or compare the person's internal user ID.
    if response["senderUserId"].as_str().is_none_or(str::is_empty) {
        return false;
    }
    let Some(expires) = response["expiresAt"]
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
    else {
        return false;
    };
    expires > now && expires <= now + Duration::seconds(60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BINDING: Binding<'static> = Binding {
        workspace_id: "w1",
        sender_agent_id: "person-relay-id",
        recipient_agent_id: "skip-agent",
        recipient_session_id: "skip-session",
        message_id: "m1",
        request_id: "r1",
    };

    fn response() -> Value {
        json!({
            "authorized": true,
            "workspaceId": "w1",
            "senderAgentId": "person-relay-id",
            "senderUserId": "u1",
            "recipientAgentId": "skip-agent",
            "recipientSessionId": "skip-session",
            "messageId": "m1",
            "requestId": "r1",
            "expiresAt": "2026-11-28T00:00:30Z"
        })
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-28T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn exact_fresh_cloud_result_is_accepted() {
        assert!(authorized(&response(), &BINDING, now()));
    }

    #[test]
    fn every_binding_field_is_required_and_exact() {
        for field in [
            "workspaceId",
            "senderAgentId",
            "recipientAgentId",
            "recipientSessionId",
            "messageId",
            "requestId",
        ] {
            let mut wrong = response();
            wrong[field] = json!("other");
            assert!(!authorized(&wrong, &BINDING, now()), "{field}");
            wrong.as_object_mut().unwrap().remove(field);
            assert!(!authorized(&wrong, &BINDING, now()), "missing {field}");
        }
        let mut missing_person = response();
        missing_person
            .as_object_mut()
            .unwrap()
            .remove("senderUserId");
        assert!(!authorized(&missing_person, &BINDING, now()));
    }

    #[test]
    fn denial_expiration_and_overlong_lifetime_fail_closed() {
        let mut wrong = response();
        wrong["authorized"] = json!(false);
        assert!(!authorized(&wrong, &BINDING, now()));
        wrong = response();
        wrong["expiresAt"] = json!("2026-11-28T00:00:00Z");
        assert!(!authorized(&wrong, &BINDING, now()));
        wrong["expiresAt"] = json!("2026-11-28T00:02:00Z");
        assert!(!authorized(&wrong, &BINDING, now()));
        wrong["expiresAt"] = json!("invalid");
        assert!(!authorized(&wrong, &BINDING, now()));
    }
}
