//! Typed deserialization of the Relaycast v3 WebSocket wire contract.
//!
//! The hosted engine (v3.1.x) emits the event shapes published as zod
//! schemas in `@relaycast/types` (`events.ts`, `message.ts`). This module
//! mirrors the subset of that contract the broker routes: channel
//! messages, DMs, group DMs, thread replies, reactions, and agent
//! presence.
//!
//! Parsing is strict about schema-required fields and tolerant of unknown
//! fields (`deny_unknown_fields` is intentionally off for forward
//! compatibility). [`parse_typed_inbound`] returns `None` for any event
//! that does not match the contract; [`super::bridge::map_ws_event`] then
//! falls back to the tolerant `relaycast::normalize_inbound_event`
//! field-probing path and logs a structured warning, so contract drift is
//! observable in logs without dropping traffic.
//!
//! For contract-conformant events the typed path produces exactly the
//! same [`NormalizedInboundEvent`] the tolerant path would; the
//! equivalence is pinned by the fixture tests in `bridge.rs` and the unit
//! tests below.

use serde::Deserialize;
use serde_json::Value;

use relaycast::{
    normalize_sender_identity, NormalizedEventKind, NormalizedInboundEvent, RelayPriority,
    SenderKind,
};

/// Outcome of a successful typed parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TypedInbound {
    /// The event matched the typed contract and routes as an inbound event.
    Event(NormalizedInboundEvent),
    /// The event matched the typed contract but is intentionally not
    /// routed (currently: reactions without channel context, which are
    /// surfaced via the inbox API instead of PTY injection).
    Ignored,
}

/// Parse a raw WS event against the typed v3 wire contract.
///
/// Returns `None` when the event type is outside the contract subset or
/// the body is missing schema-required fields; callers fall back to the
/// tolerant parser in that case.
pub(crate) fn parse_typed_inbound(value: &Value) -> Option<TypedInbound> {
    let event_type = value.get("type")?.as_str()?;
    match event_type {
        "message.created" => WireMessageCreated::deserialize(value)
            .ok()
            .and_then(WireMessageCreated::into_inbound),
        "dm.received" => WireDirectMessage::deserialize(value)
            .ok()
            .and_then(|event| event.into_inbound(NormalizedEventKind::DmReceived)),
        "group_dm.received" => WireDirectMessage::deserialize(value)
            .ok()
            .and_then(|event| event.into_inbound(NormalizedEventKind::GroupDmReceived)),
        "thread.reply" => WireThreadReply::deserialize(value)
            .ok()
            .and_then(WireThreadReply::into_inbound),
        "message.reacted" => WireMessageReacted::deserialize(value)
            .ok()
            .map(WireMessageReacted::into_inbound),
        "agent.status.active"
        | "agent.status.idle"
        | "agent.status.blocked"
        | "agent.status.waiting"
        | "agent.status.offline"
        | "agent.status.changed" => WireAgentStatus::deserialize(value)
            .ok()
            .and_then(|event| event.into_inbound(event_type)),
        _ => None,
    }
}

/// `message.created` (zod `MessageCreatedEventSchema`): channel message
/// with the stable top-level event id the engine assigns for dedup.
#[derive(Debug, Deserialize)]
struct WireMessageCreated {
    /// Stable event id (uuid) — distinct from the message id.
    id: String,
    channel: String,
    message: WireChannelMessage,
}

/// `ChannelMessagePayloadSchema`: core message payload plus a required
/// `attachments` array.
#[derive(Debug, Deserialize)]
struct WireChannelMessage {
    /// Message record id; the top-level event id is used for routing.
    #[allow(dead_code)]
    id: String,
    agent_id: String,
    agent_name: String,
    text: String,
    /// Required by the schema; contents are not consumed by the broker.
    #[allow(dead_code)]
    attachments: Vec<Value>,
}

impl WireMessageCreated {
    fn into_inbound(self) -> Option<TypedInbound> {
        let target = channel_target(&self.channel)?;
        if self.id.is_empty() || self.message.agent_name.is_empty() {
            return None;
        }
        Some(TypedInbound::Event(NormalizedInboundEvent {
            event_id: self.id,
            kind: NormalizedEventKind::MessageCreated,
            from: normalize_sender_identity(&self.message.agent_name),
            sender_agent_id: non_empty(self.message.agent_id),
            sender_kind: SenderKind::Unknown,
            target,
            text: self.message.text,
            thread_id: None,
            priority: RelayPriority::P3,
        }))
    }
}

/// `CoreMessagePayloadSchema`: shared message payload for DMs, group DMs,
/// and thread replies (`attachments` is optional here).
#[derive(Debug, Deserialize)]
struct WireCoreMessage {
    /// Message record id; the top-level event id is used for routing.
    #[allow(dead_code)]
    id: String,
    agent_id: String,
    agent_name: String,
    text: String,
}

/// `dm.received` / `group_dm.received` (zod `DmReceivedEventSchema` /
/// `GroupDmReceivedEventSchema`).
///
/// Canonical events carry no explicit recipient, but the tolerant path
/// prefers one over `conversation_id` when present; the optional fields
/// below preserve that precedence so hybrid events that otherwise satisfy
/// the contract route identically on both paths.
#[derive(Debug, Deserialize)]
struct WireDirectMessage {
    /// Stable event id (uuid).
    id: String,
    conversation_id: String,
    message: WireCoreMessage,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    recipient: Option<String>,
    #[serde(default)]
    to_agent: Option<String>,
    #[serde(default)]
    recipient_agent: Option<String>,
}

impl WireDirectMessage {
    fn into_inbound(self, kind: NormalizedEventKind) -> Option<TypedInbound> {
        let target = [
            self.target,
            self.to,
            self.recipient,
            self.to_agent,
            self.recipient_agent,
        ]
        .into_iter()
        .find_map(|candidate| candidate.and_then(non_empty))
        .or_else(|| non_empty(self.conversation_id))?;
        if self.id.is_empty() || self.message.agent_name.is_empty() {
            return None;
        }
        let priority = if matches!(kind, NormalizedEventKind::DmReceived) {
            RelayPriority::P2
        } else {
            RelayPriority::P3
        };
        Some(TypedInbound::Event(NormalizedInboundEvent {
            event_id: self.id,
            kind,
            from: normalize_sender_identity(&self.message.agent_name),
            sender_agent_id: non_empty(self.message.agent_id),
            sender_kind: SenderKind::Unknown,
            target,
            text: self.message.text,
            thread_id: None,
            priority,
        }))
    }
}

/// `thread.reply` (zod `ThreadReplyEventSchema`): the v3 engine always
/// includes the channel; channel-less replies are pre-v3 shapes handled by
/// the tolerant fallback (`"thread"` sentinel target).
#[derive(Debug, Deserialize)]
struct WireThreadReply {
    /// Stable event id (uuid).
    id: String,
    channel: String,
    parent_id: String,
    message: WireCoreMessage,
}

impl WireThreadReply {
    fn into_inbound(self) -> Option<TypedInbound> {
        let target = channel_target(&self.channel)?;
        if self.id.is_empty() || self.message.agent_name.is_empty() {
            return None;
        }
        Some(TypedInbound::Event(NormalizedInboundEvent {
            event_id: self.id,
            kind: NormalizedEventKind::ThreadReply,
            from: normalize_sender_identity(&self.message.agent_name),
            sender_agent_id: non_empty(self.message.agent_id),
            sender_kind: SenderKind::Unknown,
            target,
            text: self.message.text,
            thread_id: non_empty(self.parent_id),
            priority: RelayPriority::P3,
        }))
    }
}

/// `message.reacted` (zod `MessageReactedEventSchema`).
///
/// The schema carries no channel context and no event id; the engine's
/// reaction fanout enriches channel reactions with `channel_name`.
/// Reactions without channel context (DM reactions) are not injected —
/// they surface via the inbox API instead.
#[derive(Debug, Deserialize)]
struct WireMessageReacted {
    message_id: String,
    emoji: String,
    agent_name: String,
    #[serde(default)]
    #[allow(dead_code)]
    action: Option<String>,
    #[serde(default)]
    channel_name: Option<String>,
}

impl WireMessageReacted {
    fn into_inbound(self) -> TypedInbound {
        let target = match self.channel_name {
            Some(channel) if channel.starts_with('#') => channel,
            Some(channel) if !channel.is_empty() => format!("#{channel}"),
            _ => return TypedInbound::Ignored,
        };
        let from = self.agent_name;
        let emoji = self.emoji;
        let message_id = self.message_id;
        TypedInbound::Event(NormalizedInboundEvent {
            event_id: format!("reaction-{message_id}-{from}-{emoji}"),
            kind: NormalizedEventKind::ReactionReceived,
            from: from.clone(),
            sender_agent_id: None,
            sender_kind: SenderKind::Agent,
            target,
            text: format!(
                ":{emoji}: reaction from {from} on message {message_id} (informational; no response required)"
            ),
            thread_id: None,
            priority: RelayPriority::P4,
        })
    }
}

/// `agent.status.*` (zod `AgentStatus*EventSchema`): presence transitions.
#[derive(Debug, Deserialize)]
struct WireAgentStatus {
    agent: WireAgentRef,
    /// Required by the schema; the value is not consumed (the event type
    /// already carries the transition).
    #[allow(dead_code)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct WireAgentRef {
    name: String,
}

impl WireAgentStatus {
    fn into_inbound(self, event_type: &str) -> Option<TypedInbound> {
        let from = non_empty(self.agent.name)?;
        Some(TypedInbound::Event(NormalizedInboundEvent {
            event_id: format!("presence-{event_type}-{from}"),
            kind: NormalizedEventKind::Presence,
            from,
            sender_agent_id: None,
            sender_kind: SenderKind::Agent,
            target: String::new(),
            text: String::new(),
            thread_id: None,
            priority: RelayPriority::P4,
        }))
    }
}

/// Normalize a wire channel name to the `#channel` routing convention.
fn channel_target(channel: &str) -> Option<String> {
    if channel.is_empty() {
        return None;
    }
    if channel.starts_with('#') {
        Some(channel.to_string())
    } else {
        Some(format!("#{channel}"))
    }
}

fn non_empty(raw: String) -> Option<String> {
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_typed_inbound, TypedInbound};

    /// For contract-conformant events the typed path must produce exactly
    /// the event the tolerant path produces — the tolerant parser is the
    /// behavior oracle for this refactor.
    fn assert_typed_matches_tolerant(event: &serde_json::Value) {
        let typed = match parse_typed_inbound(event) {
            Some(TypedInbound::Event(typed)) => typed,
            other => panic!("expected typed parse for {event}, got {other:?}"),
        };
        let tolerant = relaycast::normalize_inbound_event(event)
            .expect("tolerant parser should also map contract-conformant events");
        assert_eq!(typed, tolerant, "typed and tolerant parse diverged");
    }

    #[test]
    fn canonical_message_created_parses_typed_and_matches_tolerant() {
        assert_typed_matches_tolerant(&json!({
            "id": "8f5a3c0e-9d6b-5a4f-8c2d-1e7b9a0f4c63",
            "type": "message.created",
            "channel": "general",
            "message": {
                "id": "184467440737095516",
                "agent_id": "147298826957365248",
                "agent_name": "alice",
                "text": "hello team",
                "attachments": []
            }
        }));
    }

    #[test]
    fn canonical_dm_received_parses_typed_and_matches_tolerant() {
        assert_typed_matches_tolerant(&json!({
            "id": "0c1d2e3f-4a5b-5c6d-8e7f-9a0b1c2d3e4f",
            "type": "dm.received",
            "conversation_id": "dm_184467440737095517",
            "message": {
                "id": "184467440737095518",
                "agent_id": "147298826957365248",
                "agent_name": "bob",
                "text": "direct ping"
            }
        }));
    }

    #[test]
    fn canonical_group_dm_parses_typed_and_matches_tolerant() {
        assert_typed_matches_tolerant(&json!({
            "id": "1a2b3c4d-5e6f-5a7b-8c8d-9e0f1a2b3c4d",
            "type": "group_dm.received",
            "conversation_id": "conv_184467440737095519",
            "message": {
                "id": "184467440737095520",
                "agent_id": "147298826957365249",
                "agent_name": "carol",
                "text": "group update"
            }
        }));
    }

    #[test]
    fn canonical_thread_reply_parses_typed_and_matches_tolerant() {
        assert_typed_matches_tolerant(&json!({
            "id": "2b3c4d5e-6f7a-5b8c-8d9e-0f1a2b3c4d5e",
            "type": "thread.reply",
            "channel": "general",
            "parent_id": "184467440737095521",
            "message": {
                "id": "184467440737095522",
                "agent_id": "147298826957365250",
                "agent_name": "dave",
                "text": "threaded answer"
            }
        }));
    }

    #[test]
    fn canonical_reaction_with_channel_parses_typed_and_matches_tolerant() {
        assert_typed_matches_tolerant(&json!({
            "type": "message.reacted",
            "message_id": "184467440737095523",
            "emoji": "thumbsup",
            "agent_name": "alice",
            "action": "added",
            "channel_name": "general"
        }));
    }

    #[test]
    fn canonical_presence_parses_typed_and_matches_tolerant() {
        for event_type in [
            "agent.status.active",
            "agent.status.offline",
            "agent.status.changed",
        ] {
            assert_typed_matches_tolerant(&json!({
                "type": event_type,
                "agent": { "name": "alice" },
                "status": "active"
            }));
        }
    }

    #[test]
    fn typed_path_normalizes_infrastructure_senders() {
        let event = json!({
            "id": "3c4d5e6f-7a8b-5c9d-8e0f-1a2b3c4d5e6f",
            "type": "dm.received",
            "conversation_id": "dm_1",
            "message": {
                "id": "184467440737095524",
                "agent_id": "147298826957365251",
                "agent_name": "broker-abc123",
                "text": "infra ping"
            }
        });
        match parse_typed_inbound(&event) {
            Some(TypedInbound::Event(typed)) => assert_eq!(typed.from, "Dashboard"),
            other => panic!("expected typed parse, got {other:?}"),
        }
    }

    #[test]
    fn reaction_without_channel_is_ignored_by_typed_path() {
        let event = json!({
            "type": "message.reacted",
            "message_id": "184467440737095525",
            "emoji": "rocket",
            "agent_name": "carol",
            "action": "added"
        });
        assert_eq!(parse_typed_inbound(&event), Some(TypedInbound::Ignored));
        assert!(relaycast::normalize_inbound_event(&event).is_none());
    }

    #[test]
    fn schema_violations_do_not_parse_typed() {
        // Missing top-level event id.
        assert!(parse_typed_inbound(&json!({
            "type": "message.created",
            "channel": "general",
            "message": {
                "id": "m1",
                "agent_id": "a1",
                "agent_name": "alice",
                "text": "hi",
                "attachments": []
            }
        }))
        .is_none());
        // Missing required agent_id in the message payload.
        assert!(parse_typed_inbound(&json!({
            "id": "4d5e6f7a-8b9c-5d0e-8f1a-2b3c4d5e6f7a",
            "type": "dm.received",
            "conversation_id": "dm_2",
            "message": { "id": "m2", "agent_name": "bob", "text": "hi" }
        }))
        .is_none());
        // Missing required attachments array on a channel message.
        assert!(parse_typed_inbound(&json!({
            "id": "5e6f7a8b-9c0d-5e1f-8a2b-3c4d5e6f7a8b",
            "type": "message.created",
            "channel": "general",
            "message": { "id": "m3", "agent_id": "a3", "agent_name": "carol", "text": "hi" }
        }))
        .is_none());
        // Payload-wrapped legacy shape.
        assert!(parse_typed_inbound(&json!({
            "type": "message.created",
            "payload": {
                "id": "evt-1",
                "channel": "#ops",
                "message": { "id": "m4", "from": {"name": "alice"}, "body": "hello" }
            }
        }))
        .is_none());
        // Legacy alias event types are not part of the v3 contract.
        assert!(parse_typed_inbound(&json!({
            "id": "6f7a8b9c-0d1e-5f2a-8b3c-4d5e6f7a8b9c",
            "type": "message.received",
            "channel": "general",
            "message": {
                "id": "m5",
                "agent_id": "a5",
                "agent_name": "alice",
                "text": "hi",
                "attachments": []
            }
        }))
        .is_none());
        // Empty channel cannot be routed.
        assert!(parse_typed_inbound(&json!({
            "id": "7a8b9c0d-1e2f-5a3b-8c4d-5e6f7a8b9c0d",
            "type": "message.created",
            "channel": "",
            "message": {
                "id": "m6",
                "agent_id": "a6",
                "agent_name": "alice",
                "text": "hi",
                "attachments": []
            }
        }))
        .is_none());
    }

    #[test]
    fn hybrid_dm_with_explicit_recipient_keeps_tolerant_precedence() {
        // Off-contract but fully-typed events must still route the way the
        // tolerant path would: explicit recipient wins over conversation_id.
        let event = json!({
            "id": "8b9c0d1e-2f3a-5b4c-8d5e-6f7a8b9c0d1e",
            "type": "dm.received",
            "conversation_id": "dm_3",
            "target": "Lead",
            "message": {
                "id": "184467440737095526",
                "agent_id": "147298826957365252",
                "agent_name": "bob",
                "text": "hello lead"
            }
        });
        match parse_typed_inbound(&event) {
            Some(TypedInbound::Event(typed)) => assert_eq!(typed.target, "Lead"),
            other => panic!("expected typed parse, got {other:?}"),
        }
    }
}
