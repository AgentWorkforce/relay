use serde_json::Value;

use crate::ids::{AgentId, EventId, MessageTarget, ThreadId, WorkspaceAlias, WorkspaceId};
use crate::types::{
    BrokerCommandPayload, InboundKind, InboundRelayEvent, InjectRequest, RelayPriority,
    ReleaseParams, SenderKind, SpawnParams,
};

/// Map a Relaycast ServerEvent (received over WebSocket) to an InboundRelayEvent.
pub fn map_ws_event(
    value: &Value,
    workspace_id: &str,
    workspace_alias: Option<&str>,
) -> Option<InboundRelayEvent> {
    let event = relaycast::normalize_inbound_event(value)?;
    let kind = map_sdk_event_kind(event.kind);
    tracing::debug!(
        target = "broker::bridge",
        event_id = %event.event_id,
        kind = ?kind,
        from = %event.from,
        to = %event.target,
        "mapped WS event"
    );

    Some(InboundRelayEvent {
        event_id: EventId::new(event.event_id),
        workspace_id: WorkspaceId::new(workspace_id),
        workspace_alias: workspace_alias.map(WorkspaceAlias::from),
        kind,
        from: event.from,
        sender_agent_id: event.sender_agent_id.map(AgentId::from),
        sender_kind: map_sdk_sender_kind(event.sender_kind),
        target: MessageTarget::new(event.target),
        text: event.text,
        thread_id: event.thread_id.map(ThreadId::from),
        priority: map_sdk_priority(event.priority),
    })
}

/// A parsed `action.invoked` WebSocket event.
///
/// Relaycast 2.x routes spawn/release through the actions API. The
/// `action.invoked` event identifies the invocation but omits its input, so the
/// handler reads the input back with `get_action_invocation` before executing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInvokedRef {
    /// Action name (e.g. "spawn", "release").
    pub action: String,
    /// Invocation id, used to fetch the input and report completion.
    pub invocation_id: String,
    /// Agent name of the caller.
    pub invoked_by: String,
    /// Handler agent id assigned by Relaycast, when present.
    pub handler_agent_id: Option<String>,
}

/// Parse a raw `action.invoked` WebSocket event (top-level or payload-wrapped).
pub fn parse_ws_action_invoked(value: &Value) -> Option<ActionInvokedRef> {
    let event = action_invoked_object(value)?;
    Some(ActionInvokedRef {
        action: event.get("action_name")?.as_str()?.to_string(),
        invocation_id: event.get("invocation_id")?.as_str()?.to_string(),
        invoked_by: event
            .get("caller_name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        handler_agent_id: event
            .get("handler_agent_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Locate the object carrying the `action.invoked` fields, accepting both
/// top-level and `payload`-wrapped event shapes.
fn action_invoked_object(value: &Value) -> Option<&Value> {
    let is_action = |v: &Value| v.get("type").and_then(|t| t.as_str()) == Some("action.invoked");
    if is_action(value) && value.get("action_name").is_some() {
        return Some(value);
    }
    let payload = value.get("payload")?;
    if (is_action(value) || is_action(payload)) && payload.get("action_name").is_some() {
        return Some(payload);
    }
    None
}

/// Build the broker execution payload from a fetched action invocation input.
///
/// Returns `None` for actions the broker does not own or whose input does not
/// match the expected spawn/release shape.
pub fn broker_payload_from_action(
    action: &str,
    input: Option<serde_json::Map<String, Value>>,
) -> Option<BrokerCommandPayload> {
    let params = Value::Object(input?);
    if action == "spawn" || action.starts_with("spawn-") {
        let spawn: SpawnParams = serde_json::from_value(params).ok()?;
        Some(BrokerCommandPayload::Spawn(spawn))
    } else if action == "release" || action.starts_with("release-") {
        let release: ReleaseParams = serde_json::from_value(params).ok()?;
        Some(BrokerCommandPayload::Release(release))
    } else {
        None
    }
}

fn map_sdk_event_kind(kind: relaycast::NormalizedEventKind) -> InboundKind {
    match kind {
        relaycast::NormalizedEventKind::MessageCreated => InboundKind::MessageCreated,
        relaycast::NormalizedEventKind::DmReceived => InboundKind::DmReceived,
        relaycast::NormalizedEventKind::ThreadReply => InboundKind::ThreadReply,
        relaycast::NormalizedEventKind::GroupDmReceived => InboundKind::GroupDmReceived,
        relaycast::NormalizedEventKind::Presence => InboundKind::Presence,
        relaycast::NormalizedEventKind::ReactionReceived => InboundKind::ReactionReceived,
    }
}

fn map_sdk_sender_kind(kind: relaycast::SenderKind) -> SenderKind {
    match kind {
        relaycast::SenderKind::Human => SenderKind::Human,
        relaycast::SenderKind::Agent => SenderKind::Agent,
        relaycast::SenderKind::Unknown => SenderKind::Unknown,
    }
}

fn map_sdk_priority(priority: relaycast::RelayPriority) -> RelayPriority {
    match priority {
        relaycast::RelayPriority::P2 => RelayPriority::P2,
        relaycast::RelayPriority::P3 => RelayPriority::P3,
        relaycast::RelayPriority::P4 => RelayPriority::P4,
    }
}

pub fn to_inject_request(event: InboundRelayEvent) -> Option<InjectRequest> {
    if matches!(event.kind, InboundKind::Presence) {
        return None;
    }

    Some(InjectRequest {
        id: event.event_id.into_string(),
        workspace_id: event.workspace_id,
        workspace_alias: event.workspace_alias,
        from: event.from,
        target: event.target,
        body: event.text,
        priority: event.priority,
        attempts: 0,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use crate::types::InboundKind;

    use super::to_inject_request;

    fn map_event(value: &Value) -> Option<crate::types::InboundRelayEvent> {
        super::map_ws_event(value, "ws_test", Some("test"))
    }

    use super::{broker_payload_from_action, parse_ws_action_invoked, ActionInvokedRef};

    /// Parse an `action.invoked` event and resolve the spawn/release payload
    /// from a separately-supplied input map, mirroring the runtime flow where
    /// the input is fetched via `get_action_invocation`.
    fn map_action(
        event: &Value,
        input: Value,
    ) -> Option<(ActionInvokedRef, crate::types::BrokerCommandPayload)> {
        let action_ref = parse_ws_action_invoked(event)?;
        let input_map = input.as_object().cloned();
        let payload = broker_payload_from_action(&action_ref.action, input_map)?;
        Some((action_ref, payload))
    }
    #[test]
    fn maps_message_created_top_level() {
        let event = map_event(&json!({
            "type": "message.created",
            "channel": "general",
            "message": {
                "id": "msg_1",
                "agent_name": "alice",
                "text": "hello",
                "attachments": []
            }
        }))
        .expect("should map message.created");

        assert_eq!(event.kind, InboundKind::MessageCreated);
        assert_eq!(event.event_id, "msg_1");
        assert_eq!(event.from, "alice");
        assert_eq!(event.target, "#general");
        assert_eq!(event.text, "hello");
        assert!(to_inject_request(event).is_some());
    }

    #[test]
    fn contract_identity_fixture_requires_broker_identity_normalization() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/fixtures/identity-fixtures.json"
        ))
        .expect("identity fixture should be valid JSON");
        let cases = fixture
            .get("wave0_identity_normalization")
            .and_then(|v| v.get("cases"))
            .and_then(Value::as_array)
            .expect("identity fixture must include wave0_identity_normalization.cases");

        for case in cases {
            let input = case
                .get("input")
                .and_then(Value::as_str)
                .expect("identity normalization case must include input");
            let expected = case
                .get("normalized")
                .and_then(Value::as_str)
                .expect("identity normalization case must include normalized");

            let event = map_event(&json!({
                "type": "message.created",
                "channel": "general",
                "message": {
                    "id": format!("evt_contract_identity_{input}"),
                    "agent_name": input,
                    "text": "identity contract probe"
                }
            }))
            .expect("message.created should map for identity contract fixture");

            // TODO(contract-wave1-identity-normalization): normalize broker
            // and human relay identities to canonical cross-repo display names.
            assert_eq!(
                event.from, expected,
                "sender identity \"{}\" did not normalize to expected \"{}\"",
                input, expected
            );
        }
    }

    #[test]
    fn maps_dm_received_top_level() {
        let event = map_event(&json!({
            "type": "dm.received",
            "conversation_id": "conv_1",
            "message": {
                "id": "dm_1",
                "agent_name": "bob",
                "text": "hi there"
            }
        }))
        .unwrap();

        assert_eq!(event.kind, InboundKind::DmReceived);
        assert_eq!(event.event_id, "dm_1");
        assert_eq!(event.from, "bob");
        assert_eq!(event.target, "conv_1");
        assert_eq!(event.text, "hi there");
    }

    #[test]
    fn maps_message_created_conversation_shape_as_dm_received() {
        let event = map_event(&json!({
            "type": "message.created",
            "conversation_id": "conv_9",
            "message": {
                "id": "dm_9",
                "agent_name": "Lead",
                "text": "reply from relaycast",
                "to": {
                    "name": "Dashboard"
                }
            }
        }))
        .expect("conversation message should map as dm");

        assert_eq!(event.kind, InboundKind::DmReceived);
        assert_eq!(event.event_id, "dm_9");
        assert_eq!(event.from, "Lead");
        assert_eq!(event.target, "Dashboard");
        assert_eq!(event.text, "reply from relaycast");
    }

    #[test]
    fn dm_target_prefers_explicit_recipient_over_conversation_id() {
        let event = map_event(&json!({
            "type": "dm.received",
            "conversation_id": "conv_1",
            "target": "Lead",
            "message": {
                "id": "dm_2",
                "agent_name": "Dashboard",
                "text": "hello lead"
            }
        }))
        .expect("should map dm.received");

        assert_eq!(event.kind, InboundKind::DmReceived);
        assert_eq!(event.target, "Lead");
    }

    #[test]
    fn maps_thread_reply_top_level() {
        let event = map_event(&json!({
            "type": "thread.reply",
            "parent_id": "msg_parent",
            "message": {
                "id": "msg_reply",
                "agent_name": "alice",
                "text": "a reply"
            }
        }))
        .unwrap();

        assert_eq!(event.kind, InboundKind::ThreadReply);
        assert_eq!(event.event_id, "msg_reply");
        assert_eq!(event.thread_id.as_deref(), Some("msg_parent"));
        assert_eq!(event.target, "thread");
    }

    #[test]
    fn maps_thread_reply_with_channel() {
        let event = map_event(&json!({
            "type": "thread.reply",
            "channel": "general",
            "parent_id": "msg_parent",
            "message": {
                "id": "msg_reply2",
                "agent_name": "bob",
                "text": "a channel reply"
            }
        }))
        .unwrap();

        assert_eq!(event.kind, InboundKind::ThreadReply);
        assert_eq!(event.event_id, "msg_reply2");
        assert_eq!(event.thread_id.as_deref(), Some("msg_parent"));
        assert_eq!(event.target, "#general");
    }

    #[test]
    fn maps_group_dm_top_level() {
        let event = map_event(&json!({
            "type": "group_dm.received",
            "conversation_id": "conv_group",
            "message": {
                "id": "gdm_1",
                "agent_name": "carol",
                "text": "group msg"
            }
        }))
        .unwrap();

        assert_eq!(event.kind, InboundKind::GroupDmReceived);
        assert_eq!(event.target, "conv_group");
    }

    #[test]
    fn maps_presence_top_level() {
        let event = map_event(&json!({
            "type": "agent.online",
            "agent": { "name": "alice" }
        }))
        .unwrap();

        assert_eq!(event.kind, InboundKind::Presence);
        assert_eq!(event.from, "alice");
        assert_eq!(event.priority, crate::types::RelayPriority::P4);
        assert!(to_inject_request(event).is_none());
    }

    #[test]
    fn maps_payload_wrapped_shape() {
        let event = map_event(&json!({
            "type": "message.received",
            "payload": {
                "id": "evt-7",
                "channel": "#ops",
                "message": {
                    "id": "msg-7",
                    "from": {"name":"alice"},
                    "body": "hello from nested payload"
                }
            }
        }))
        .expect("nested payload should map");

        assert_eq!(event.kind, InboundKind::MessageCreated);
        assert_eq!(event.event_id, "evt-7");
        assert_eq!(event.from, "alice");
        assert_eq!(event.target, "#ops");
        assert_eq!(event.text, "hello from nested payload");
    }

    #[test]
    fn sender_kind_from_nested_sender_object_payload() {
        let event = map_event(&json!({
            "type": "dm.received",
            "payload": {
                "event_id": "d3",
                "target": "Lead",
                "text": "hello",
                "from": {
                    "name": "bob",
                    "type": "agent"
                }
            }
        }))
        .expect("payload should map");

        assert_eq!(event.from, "bob");
        assert_eq!(event.sender_kind, crate::types::SenderKind::Agent);
    }

    #[test]
    fn maps_reaction_added() {
        let event = map_event(&json!({
            "type": "reaction.added",
            "message_id": "msg_42",
            "emoji": "thumbsup",
            "agent_name": "alice",
            "channel_name": "general"
        }))
        .expect("should map reaction.added");

        assert_eq!(event.kind, InboundKind::ReactionReceived);
        assert_eq!(event.from, "alice");
        assert_eq!(event.target, "#general");
        assert!(event.text.contains(":thumbsup:"));
        assert!(event.text.contains("no response required"));
        assert_eq!(event.event_id, "reaction-msg_42-alice-thumbsup");
        assert_eq!(event.priority, crate::types::RelayPriority::P4);
        assert!(to_inject_request(event).is_some());
    }

    #[test]
    fn maps_reaction_removed() {
        let event = map_event(&json!({
            "type": "reaction.removed",
            "message_id": "msg_42",
            "emoji": "thumbsup",
            "agent_name": "bob",
            "channel_name": "dev"
        }))
        .expect("should map reaction.removed");

        assert_eq!(event.kind, InboundKind::ReactionReceived);
        assert_eq!(event.from, "bob");
        assert_eq!(event.target, "#dev");
    }

    #[test]
    fn drops_reaction_without_channel() {
        // Reactions without a channel (e.g. DM reactions) are dropped from PTY
        // injection — they're surfaced via the inbox API / piggyback instead.
        assert!(map_event(&json!({
            "type": "reaction.added",
            "message_id": "msg_99",
            "emoji": "rocket",
            "agent_name": "carol"
        }))
        .is_none());
    }

    #[test]
    fn ignores_unsupported_events_safely() {
        assert!(map_event(&json!({"type":"unknown"})).is_none());
        assert!(map_event(&json!({"type":"channel.created","channel":{"name":"x"}})).is_none());
        assert!(map_event(&json!({"type":"connected","client_id":"abc"})).is_none());
    }

    #[test]
    fn ignores_malformed_events() {
        assert!(map_event(&json!({"type":"message.created","channel":"general"})).is_none());

        let mapped = map_event(&json!({
            "type":"message.created",
            "channel":"general",
            "message": {"agent_name":"alice","text":"hello"}
        }))
        .expect("message without explicit id should synthesize an event id");
        assert_eq!(mapped.kind, InboundKind::MessageCreated);
        assert_eq!(mapped.from, "alice");
        assert_eq!(mapped.target, "#general");
        assert!(mapped.event_id.starts_with("synthetic-message.created-"));
    }

    #[test]
    fn maps_action_invoked_spawn() {
        let (action_ref, payload) = map_action(
            &json!({
                "type": "action.invoked",
                "action_name": "spawn",
                "invocation_id": "inv_1",
                "caller_name": "147298826957365248",
            }),
            json!({
                "name": "Worker1",
                "cli": "codex",
                "args": ["--full-auto"]
            }),
        )
        .expect("should map action.invoked spawn");

        assert_eq!(action_ref.action, "spawn");
        assert_eq!(action_ref.invocation_id, "inv_1");
        assert_eq!(action_ref.invoked_by, "147298826957365248");
        assert_eq!(action_ref.handler_agent_id, None);
        assert_eq!(
            payload,
            crate::types::BrokerCommandPayload::Spawn(crate::types::SpawnParams {
                name: "Worker1".into(),
                cli: "codex".into(),
                args: vec!["--full-auto".into()],
            })
        );
    }

    #[test]
    fn maps_action_invoked_release() {
        let (_, payload) = map_action(
            &json!({
                "type": "action.invoked",
                "action_name": "release",
                "invocation_id": "inv_2",
                "caller_name": "147298826957365248",
            }),
            json!({ "name": "Worker1" }),
        )
        .expect("should map action.invoked release");

        assert_eq!(
            payload,
            crate::types::BrokerCommandPayload::Release(crate::types::ReleaseParams {
                name: "Worker1".into(),
            })
        );
    }

    #[test]
    fn maps_action_invoked_spawn_with_suffix() {
        let (_, payload) = map_action(
            &json!({
                "type": "action.invoked",
                "action_name": "spawn-19c4c7f8150",
                "invocation_id": "inv_3",
                "caller_name": "147298826957365248",
            }),
            json!({
                "name": "Worker2",
                "cli": "codex",
                "args": ["--full-auto"]
            }),
        )
        .expect("should map action.invoked spawn with suffix");

        assert_eq!(
            payload,
            crate::types::BrokerCommandPayload::Spawn(crate::types::SpawnParams {
                name: "Worker2".into(),
                cli: "codex".into(),
                args: vec!["--full-auto".into()],
            })
        );
    }

    #[test]
    fn parses_action_invoked_handler_agent_id() {
        let action_ref = parse_ws_action_invoked(&json!({
            "type": "action.invoked",
            "action_name": "spawn",
            "invocation_id": "inv_4",
            "caller_name": "147298826957365248",
            "handler_agent_id": "147305428879515648",
        }))
        .expect("should parse action.invoked handler agent id");

        assert_eq!(
            action_ref.handler_agent_id.as_deref(),
            Some("147305428879515648")
        );
    }

    #[test]
    fn parses_action_invoked_payload_wrapped() {
        let action_ref = parse_ws_action_invoked(&json!({
            "type": "action.invoked",
            "payload": {
                "type": "action.invoked",
                "action_name": "spawn",
                "invocation_id": "inv_5",
                "caller_name": "abc",
            }
        }))
        .expect("should parse payload-wrapped action.invoked");

        assert_eq!(action_ref.action, "spawn");
        assert_eq!(action_ref.invocation_id, "inv_5");
    }

    #[test]
    fn action_invoked_ignores_non_action_types() {
        assert!(parse_ws_action_invoked(&json!({
            "type": "dm.received",
            "action_name": "spawn",
            "invocation_id": "inv_6",
            "caller_name": "123",
        }))
        .is_none());
    }

    #[test]
    fn action_payload_ignores_unknown_actions() {
        assert!(broker_payload_from_action(
            "unknown",
            Some(json!({ "name": "x" }).as_object().cloned().unwrap())
        )
        .is_none());
    }

    #[test]
    fn action_payload_ignores_missing_input() {
        assert!(broker_payload_from_action("spawn", None).is_none());
    }

    #[test]
    fn action_invoked_not_picked_up_by_map_event() {
        assert!(map_event(&json!({
            "type": "action.invoked",
            "action_name": "spawn",
            "invocation_id": "inv_7",
            "caller_name": "123",
        }))
        .is_none());
    }
}
