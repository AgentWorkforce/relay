use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

use serde_json::{Map, Value};

use crate::types::{
    BrokerCommandEvent, BrokerCommandPayload, InboundKind, InboundRelayEvent, InjectRequest,
    RelayPriority, ReleaseParams, SenderKind, SpawnParams,
};

/// Map a Relaycast ServerEvent (received over WebSocket) to an InboundRelayEvent.
///
/// Supports both current top-level events and older payload-wrapped events.
pub fn map_ws_event(value: &Value) -> Option<InboundRelayEvent> {
    let accessor = EventAccessor::new(value);
    let event_type = accessor.field(EventNesting::Top, "type")?.as_str()?;
    let mut kind = parse_inbound_kind(event_type)?;

    // Relaycast may emit direct messages as `message.created` with a
    // `conversation_id` and no channel. Treat those as DMs so downstream
    // participant resolution and worker routing work correctly.
    if matches!(kind, InboundKind::MessageCreated)
        && extract_channel(accessor).is_none()
        && has_conversation_context(accessor)
    {
        kind = InboundKind::DmReceived;
    }

    // Reject message events that lack both a "message" object and inline
    // text content — these are malformed stubs that cannot be routed.
    // The "message" object can live at top level or inside a "payload" wrapper.
    // DM/thread events may carry text/from directly on the payload without a
    // nested "message" sub-object, so also accept events with extractable text.
    if matches!(
        kind,
        InboundKind::MessageCreated
            | InboundKind::DmReceived
            | InboundKind::ThreadReply
            | InboundKind::GroupDmReceived
    ) {
        let has_message = accessor
            .nested(EventNesting::Message)
            .is_some_and(Value::is_object)
            || accessor
                .nested(EventNesting::PayloadMessage)
                .is_some_and(Value::is_object);
        let has_inline_text = extract_text(accessor).is_some();
        if !has_message && !has_inline_text {
            return None;
        }
    }

    if matches!(kind, InboundKind::Presence) {
        let from = extract_presence_sender(accessor).unwrap_or_else(|| "unknown".to_string());
        let event_id = format!("presence-{event_type}-{from}");
        return Some(InboundRelayEvent {
            event_id,
            kind,
            from,
            sender_agent_id: None,
            sender_kind: SenderKind::Agent,
            target: String::new(),
            text: String::new(),
            thread_id: None,
            priority: RelayPriority::P4,
        });
    }

    let from = extract_sender(accessor).unwrap_or_else(|| "unknown".to_string());
    let sender_agent_id = extract_sender_agent_id(accessor);
    let sender_kind = parse_sender_kind(accessor);
    let target = extract_target(accessor, &kind).unwrap_or_else(|| "unknown".to_string());
    let text = extract_text(accessor).unwrap_or_default();
    let thread_id = extract_thread_id(accessor);
    let event_id = extract_event_id(accessor)
        .unwrap_or_else(|| synth_event_id(event_type, &from, &target, &text, thread_id.as_deref()));

    let priority = match kind {
        InboundKind::DmReceived => RelayPriority::P2,
        InboundKind::MessageCreated | InboundKind::ThreadReply | InboundKind::GroupDmReceived => {
            RelayPriority::P3
        }
        InboundKind::Presence => RelayPriority::P4,
    };

    Some(InboundRelayEvent {
        event_id,
        kind,
        from,
        sender_agent_id,
        sender_kind,
        target,
        text,
        thread_id,
        priority,
    })
}

/// Map a Relaycast `command.invoked` event to a BrokerCommandEvent.
///
/// Relaycast emits these when an agent invokes a registered slash command
/// (e.g. `/spawn`, `/release`). The `parameters` field carries structured data.
pub fn map_ws_broker_command(value: &Value) -> Option<BrokerCommandEvent> {
    let event_type = value.get("type")?.as_str()?;
    if event_type != "command.invoked" {
        return None;
    }

    let command = value.get("command")?.as_str()?;
    let channel = value
        .get("channel")
        .and_then(scalar_to_string)
        .unwrap_or_default();
    let invoked_by = value
        .get("invoked_by")
        .and_then(scalar_to_string)
        .unwrap_or_else(|| "unknown".to_string());
    let handler_agent_id = value
        .get("handler_agent_id")
        .and_then(scalar_to_string)
        .or_else(|| {
            value
                .get("handler")
                .and_then(|handler| handler.get("id"))
                .and_then(scalar_to_string)
        });

    let params = value.get("parameters")?;

    let command_name = command.trim_start_matches('/');
    let payload = if command_name == "spawn" || command_name.starts_with("spawn-") {
        let spawn: SpawnParams = serde_json::from_value(params.clone()).ok()?;
        BrokerCommandPayload::Spawn(spawn)
    } else if command_name == "release" || command_name.starts_with("release-") {
        let release: ReleaseParams = serde_json::from_value(params.clone()).ok()?;
        BrokerCommandPayload::Release(release)
    } else {
        return None;
    };

    Some(BrokerCommandEvent {
        command: command.to_string(),
        channel,
        invoked_by,
        handler_agent_id,
        payload,
    })
}

#[derive(Clone, Copy)]
enum EventNesting {
    Top,
    Message,
    Payload,
    PayloadMessage,
}

#[derive(Clone, Copy)]
struct EventAccessor<'a> {
    top: &'a Value,
    message: Option<&'a Value>,
    payload: Option<&'a Value>,
    payload_message: Option<&'a Value>,
}

impl<'a> EventAccessor<'a> {
    fn new(top: &'a Value) -> Self {
        let payload = top.get("payload");
        let message = top.get("message");
        let payload_message = payload.and_then(|nested| nested.get("message"));

        Self {
            top,
            message,
            payload,
            payload_message,
        }
    }

    fn nested(self, nesting: EventNesting) -> Option<&'a Value> {
        match nesting {
            EventNesting::Top => Some(self.top),
            EventNesting::Message => self.message,
            EventNesting::Payload => self.payload,
            EventNesting::PayloadMessage => self.payload_message,
        }
    }

    fn field(self, nesting: EventNesting, key: &str) -> Option<&'a Value> {
        self.nested(nesting)?.get(key)
    }

    fn agent_name(self, nesting: EventNesting) -> Option<&'a Value> {
        self.field(nesting, "agent")
            .and_then(|agent| agent.get("name"))
    }

    fn first_string<F>(
        self,
        candidates: &[(EventNesting, &str)],
        mut convert: F,
        require_non_empty: bool,
    ) -> Option<String>
    where
        F: FnMut(&Value) -> Option<String>,
    {
        for (nesting, key) in candidates {
            if let Some(value) = self.field(*nesting, key).and_then(&mut convert) {
                if !require_non_empty || !value.is_empty() {
                    return Some(value);
                }
            }
        }
        None
    }

    fn first_agent_name(self, nestings: &[EventNesting]) -> Option<String> {
        for nesting in nestings {
            if let Some(name) = self.agent_name(*nesting).and_then(scalar_to_string) {
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
        None
    }

    fn has_trimmed_non_empty_scalar(self, candidates: &[(EventNesting, &str)]) -> bool {
        candidates.iter().any(|(nesting, key)| {
            self.field(*nesting, key)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
        })
    }
}

fn parse_inbound_kind(event_type: &str) -> Option<InboundKind> {
    match event_type {
        "message.created" | "message.received" | "message.new" | "message.sent"
        | "message.delivered" => Some(InboundKind::MessageCreated),
        "dm.received"
        | "dm.created"
        | "dm.new"
        | "dm.sent"
        | "dm.message.created"
        | "direct_message.received"
        | "direct_message.created"
        | "direct_message.new"
        | "direct_message.sent" => Some(InboundKind::DmReceived),
        "thread.reply" | "thread.message.created" | "thread.message.sent" => {
            Some(InboundKind::ThreadReply)
        }
        "group_dm.received"
        | "group_dm.created"
        | "group_dm.new"
        | "group_dm.sent"
        | "group_dm.message.created" => Some(InboundKind::GroupDmReceived),
        "agent.online" | "agent.offline" | "user.online" | "user.offline" => {
            Some(InboundKind::Presence)
        }
        _ => None,
    }
}

fn extract_presence_sender(accessor: EventAccessor<'_>) -> Option<String> {
    const AGENT_NAME_NESTINGS: [EventNesting; 2] = [EventNesting::Top, EventNesting::Payload];
    const AGENT_NAME_FIELDS: [(EventNesting, &str); 2] = [
        (EventNesting::Top, "agent_name"),
        (EventNesting::Payload, "agent_name"),
    ];
    const FROM_FIELDS: [(EventNesting, &str); 2] =
        [(EventNesting::Top, "from"), (EventNesting::Payload, "from")];

    accessor
        .first_agent_name(&AGENT_NAME_NESTINGS)
        .or_else(|| accessor.first_string(&AGENT_NAME_FIELDS, scalar_to_string, true))
        .or_else(|| accessor.first_string(&FROM_FIELDS, scalar_to_string, true))
}

fn extract_event_id(accessor: EventAccessor<'_>) -> Option<String> {
    const EVENT_ID_FIELDS: [(EventNesting, &str); 12] = [
        (EventNesting::Top, "event_id"),
        (EventNesting::Top, "message_id"),
        (EventNesting::Top, "id"),
        (EventNesting::Message, "event_id"),
        (EventNesting::Message, "message_id"),
        (EventNesting::Message, "id"),
        (EventNesting::Payload, "event_id"),
        (EventNesting::Payload, "message_id"),
        (EventNesting::Payload, "id"),
        (EventNesting::PayloadMessage, "event_id"),
        (EventNesting::PayloadMessage, "message_id"),
        (EventNesting::PayloadMessage, "id"),
    ];

    accessor.first_string(&EVENT_ID_FIELDS, scalar_to_string, true)
}

/// Extract the agent_id from the message object in a WS event.
/// Relaycast includes `agent_id` inside the `message` sub-object.
fn extract_sender_agent_id(accessor: EventAccessor<'_>) -> Option<String> {
    accessor
        .field(EventNesting::Message, "agent_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn extract_sender(accessor: EventAccessor<'_>) -> Option<String> {
    const TOP_AGENT_NESTINGS: [EventNesting; 1] = [EventNesting::Top];
    const TOP_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::Top, "from"),
        (EventNesting::Top, "sender"),
        (EventNesting::Top, "author"),
        (EventNesting::Top, "from_agent"),
        (EventNesting::Top, "agent"),
        (EventNesting::Top, "agent_name"),
    ];
    const MESSAGE_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::Message, "from"),
        (EventNesting::Message, "sender"),
        (EventNesting::Message, "author"),
        (EventNesting::Message, "from_agent"),
        (EventNesting::Message, "agent"),
        (EventNesting::Message, "agent_name"),
    ];
    const PAYLOAD_AGENT_NESTINGS: [EventNesting; 1] = [EventNesting::Payload];
    const PAYLOAD_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::Payload, "from"),
        (EventNesting::Payload, "sender"),
        (EventNesting::Payload, "author"),
        (EventNesting::Payload, "from_agent"),
        (EventNesting::Payload, "agent"),
        (EventNesting::Payload, "agent_name"),
    ];
    const PAYLOAD_MESSAGE_FIELDS: [(EventNesting, &str); 6] = [
        (EventNesting::PayloadMessage, "from"),
        (EventNesting::PayloadMessage, "sender"),
        (EventNesting::PayloadMessage, "author"),
        (EventNesting::PayloadMessage, "from_agent"),
        (EventNesting::PayloadMessage, "agent"),
        (EventNesting::PayloadMessage, "agent_name"),
    ];

    let raw = accessor
        .first_agent_name(&TOP_AGENT_NESTINGS)
        .or_else(|| accessor.first_string(&TOP_FIELDS, sender_value_to_string, true))
        .or_else(|| accessor.first_string(&MESSAGE_FIELDS, sender_value_to_string, true))
        .or_else(|| accessor.first_agent_name(&PAYLOAD_AGENT_NESTINGS))
        .or_else(|| accessor.first_string(&PAYLOAD_FIELDS, sender_value_to_string, true))
        .or_else(|| accessor.first_string(&PAYLOAD_MESSAGE_FIELDS, sender_value_to_string, true))?;

    Some(normalize_sender_identity(&raw))
}

/// Normalize well-known sender identities to canonical display names.
///
/// Broker identities (`broker`, `broker-XXXXXXXX`) and human relay identities
/// (`human:orchestrator`) are normalized to `"Dashboard"` so downstream
/// consumers see a stable, human-friendly name regardless of the underlying
/// relay infrastructure identity.
fn normalize_sender_identity(raw: &str) -> String {
    // broker identities: exact "broker" or "broker-" followed by hex/alphanumeric suffix
    if raw == "broker" || raw.starts_with("broker-") {
        return "Dashboard".to_string();
    }
    // human relay identities: "human:orchestrator" and similar human:* patterns
    if raw.starts_with("human:") {
        return "Dashboard".to_string();
    }
    raw.to_string()
}

fn extract_target(accessor: EventAccessor<'_>, kind: &InboundKind) -> Option<String> {
    const EXPLICIT_TARGET_FIELDS: [(EventNesting, &str); 20] = [
        (EventNesting::Top, "target"),
        (EventNesting::Top, "to"),
        (EventNesting::Top, "recipient"),
        (EventNesting::Top, "to_agent"),
        (EventNesting::Top, "recipient_agent"),
        (EventNesting::Message, "target"),
        (EventNesting::Message, "to"),
        (EventNesting::Message, "recipient"),
        (EventNesting::Message, "to_agent"),
        (EventNesting::Message, "recipient_agent"),
        (EventNesting::Payload, "target"),
        (EventNesting::Payload, "to"),
        (EventNesting::Payload, "recipient"),
        (EventNesting::Payload, "to_agent"),
        (EventNesting::Payload, "recipient_agent"),
        (EventNesting::PayloadMessage, "target"),
        (EventNesting::PayloadMessage, "to"),
        (EventNesting::PayloadMessage, "recipient"),
        (EventNesting::PayloadMessage, "to_agent"),
        (EventNesting::PayloadMessage, "recipient_agent"),
    ];
    const CONVERSATION_DM_FIELDS: [(EventNesting, &str); 2] = [
        (EventNesting::Top, "conversation_id"),
        (EventNesting::Payload, "conversation_id"),
    ];
    const CONVERSATION_FIELDS: [(EventNesting, &str); 4] = [
        (EventNesting::Top, "conversation_id"),
        (EventNesting::Message, "conversation_id"),
        (EventNesting::Payload, "conversation_id"),
        (EventNesting::PayloadMessage, "conversation_id"),
    ];

    if matches!(kind, InboundKind::DmReceived | InboundKind::GroupDmReceived) {
        // Prefer explicit recipient-like fields when available so init-mode
        // worker routing can match the local worker name for direct delivery.
        if let Some(target) =
            accessor.first_string(&EXPLICIT_TARGET_FIELDS, sender_value_to_string, true)
        {
            return Some(target);
        }

        // Fall back to conversation identifiers for legacy/event-shape coverage.
        if let Some(target) = accessor.first_string(&CONVERSATION_DM_FIELDS, scalar_to_string, true)
        {
            return Some(target);
        }
    }

    if let Some(channel) = extract_channel(accessor) {
        return Some(channel);
    }

    if let Some(target) =
        accessor.first_string(&EXPLICIT_TARGET_FIELDS, sender_value_to_string, true)
    {
        return Some(target);
    }

    if let Some(target) = accessor.first_string(&CONVERSATION_FIELDS, scalar_to_string, true) {
        return Some(target);
    }

    if matches!(kind, InboundKind::ThreadReply) {
        return Some("thread".to_string());
    }

    None
}

fn has_conversation_context(accessor: EventAccessor<'_>) -> bool {
    const CONVERSATION_FIELDS: [(EventNesting, &str); 4] = [
        (EventNesting::Top, "conversation_id"),
        (EventNesting::Message, "conversation_id"),
        (EventNesting::Payload, "conversation_id"),
        (EventNesting::PayloadMessage, "conversation_id"),
    ];

    accessor.has_trimmed_non_empty_scalar(&CONVERSATION_FIELDS)
}

fn synth_event_id(
    event_type: &str,
    from: &str,
    target: &str,
    text: &str,
    thread_id: Option<&str>,
) -> String {
    let mut hasher = DefaultHasher::new();
    event_type.hash(&mut hasher);
    from.hash(&mut hasher);
    target.hash(&mut hasher);
    text.hash(&mut hasher);
    thread_id.unwrap_or_default().hash(&mut hasher);
    let digest = hasher.finish();
    format!("synthetic-{event_type}-{digest:016x}")
}

fn extract_channel(accessor: EventAccessor<'_>) -> Option<String> {
    const CHANNEL_FIELDS: [(EventNesting, &str); 4] = [
        (EventNesting::Top, "channel"),
        (EventNesting::Message, "channel"),
        (EventNesting::Payload, "channel"),
        (EventNesting::PayloadMessage, "channel"),
    ];

    for (nesting, key) in CHANNEL_FIELDS {
        if let Some(raw) = accessor.field(nesting, key).and_then(scalar_to_string) {
            if raw.is_empty() {
                continue;
            }
            if raw.starts_with('#') {
                return Some(raw);
            }
            return Some(format!("#{raw}"));
        }
    }
    None
}

fn extract_text(accessor: EventAccessor<'_>) -> Option<String> {
    const TEXT_FIELDS: [(EventNesting, &str); 12] = [
        (EventNesting::Top, "text"),
        (EventNesting::Top, "body"),
        (EventNesting::Top, "content"),
        (EventNesting::Message, "text"),
        (EventNesting::Message, "body"),
        (EventNesting::Message, "content"),
        (EventNesting::Payload, "text"),
        (EventNesting::Payload, "body"),
        (EventNesting::Payload, "content"),
        (EventNesting::PayloadMessage, "text"),
        (EventNesting::PayloadMessage, "body"),
        (EventNesting::PayloadMessage, "content"),
    ];

    if let Some(text) = accessor.first_string(&TEXT_FIELDS, scalar_to_string, false) {
        return Some(text);
    }

    if let Some(raw_message) = accessor
        .field(EventNesting::Top, "message")
        .and_then(Value::as_str)
    {
        return Some(raw_message.to_string());
    }
    if let Some(raw_message) = accessor
        .field(EventNesting::Payload, "message")
        .and_then(Value::as_str)
    {
        return Some(raw_message.to_string());
    }

    None
}

fn extract_thread_id(accessor: EventAccessor<'_>) -> Option<String> {
    const THREAD_FIELDS: [(EventNesting, &str); 10] = [
        (EventNesting::Top, "parent_id"),
        (EventNesting::Top, "thread_id"),
        (EventNesting::Top, "threadId"),
        (EventNesting::Message, "thread_id"),
        (EventNesting::Message, "threadId"),
        (EventNesting::Payload, "parent_id"),
        (EventNesting::Payload, "thread_id"),
        (EventNesting::Payload, "threadId"),
        (EventNesting::PayloadMessage, "thread_id"),
        (EventNesting::PayloadMessage, "threadId"),
    ];

    accessor.first_string(&THREAD_FIELDS, scalar_to_string, true)
}

fn sender_value_to_string(value: &Value) -> Option<String> {
    if let Some(s) = scalar_to_string(value) {
        return Some(s);
    }

    let obj = value.as_object()?;
    for key in ["name", "display_name", "username", "handle", "id"] {
        if let Some(v) = obj.get(key) {
            if let Some(s) = scalar_to_string(v) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn parse_sender_kind(accessor: EventAccessor<'_>) -> SenderKind {
    const KIND_FIELDS: [(EventNesting, &str); 24] = [
        (EventNesting::Top, "from_type"),
        (EventNesting::Top, "sender_type"),
        (EventNesting::Top, "actor_type"),
        (EventNesting::Top, "source_type"),
        (EventNesting::Top, "origin_type"),
        (EventNesting::Top, "sender_kind"),
        (EventNesting::Message, "from_type"),
        (EventNesting::Message, "sender_type"),
        (EventNesting::Message, "actor_type"),
        (EventNesting::Message, "source_type"),
        (EventNesting::Message, "origin_type"),
        (EventNesting::Message, "sender_kind"),
        (EventNesting::Payload, "from_type"),
        (EventNesting::Payload, "sender_type"),
        (EventNesting::Payload, "actor_type"),
        (EventNesting::Payload, "source_type"),
        (EventNesting::Payload, "origin_type"),
        (EventNesting::Payload, "sender_kind"),
        (EventNesting::PayloadMessage, "from_type"),
        (EventNesting::PayloadMessage, "sender_type"),
        (EventNesting::PayloadMessage, "actor_type"),
        (EventNesting::PayloadMessage, "source_type"),
        (EventNesting::PayloadMessage, "origin_type"),
        (EventNesting::PayloadMessage, "sender_kind"),
    ];
    const CONTAINER_NESTINGS: [EventNesting; 4] = [
        EventNesting::Top,
        EventNesting::Message,
        EventNesting::Payload,
        EventNesting::PayloadMessage,
    ];

    for (nesting, key) in KIND_FIELDS {
        if let Some(kind) = accessor
            .field(nesting, key)
            .and_then(Value::as_str)
            .and_then(parse_sender_kind_label)
        {
            return kind;
        }
    }

    for nesting in CONTAINER_NESTINGS {
        if let Some(kind) = accessor
            .nested(nesting)
            .and_then(Value::as_object)
            .and_then(parse_sender_kind_from_containers)
        {
            return kind;
        }
    }

    SenderKind::Unknown
}

fn parse_sender_kind_label(raw: &str) -> Option<SenderKind> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "human" | "user" => Some(SenderKind::Human),
        "agent" | "bot" | "assistant" => Some(SenderKind::Agent),
        _ => None,
    }
}

fn parse_sender_kind_from_containers(payload: &Map<String, Value>) -> Option<SenderKind> {
    for container in ["from", "sender", "author"] {
        if let Some(kind) = payload
            .get(container)
            .and_then(Value::as_object)
            .and_then(|obj| {
                obj.get("type")
                    .or_else(|| obj.get("kind"))
                    .or_else(|| obj.get("role"))
            })
            .and_then(Value::as_str)
            .and_then(parse_sender_kind_label)
        {
            return Some(kind);
        }
    }
    None
}

pub fn to_inject_request(event: InboundRelayEvent) -> Option<InjectRequest> {
    if matches!(event.kind, InboundKind::Presence) {
        return None;
    }

    Some(InjectRequest {
        id: event.event_id,
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

    use super::{
        map_ws_broker_command, map_ws_event, to_inject_request, EventAccessor, EventNesting,
    };

    fn accessor_fixture() -> Value {
        json!({
            "event_id": "evt_top",
            "type": "message.created",
            "message": {
                "event_id": "evt_message",
                "text": "message-level text"
            },
            "payload": {
                "event_id": "evt_payload",
                "text": "payload-level text",
                "message": {
                    "event_id": "evt_payload_message",
                    "text": "payload-message text"
                }
            }
        })
    }

    #[test]
    fn event_accessor_reads_top_level_nesting() {
        let event = accessor_fixture();
        let accessor = EventAccessor::new(&event);

        assert_eq!(
            accessor
                .field(EventNesting::Top, "event_id")
                .and_then(Value::as_str),
            Some("evt_top")
        );
    }

    #[test]
    fn event_accessor_reads_message_nesting() {
        let event = accessor_fixture();
        let accessor = EventAccessor::new(&event);

        assert_eq!(
            accessor
                .field(EventNesting::Message, "event_id")
                .and_then(Value::as_str),
            Some("evt_message")
        );
    }

    #[test]
    fn event_accessor_reads_payload_nesting() {
        let event = accessor_fixture();
        let accessor = EventAccessor::new(&event);

        assert_eq!(
            accessor
                .field(EventNesting::Payload, "event_id")
                .and_then(Value::as_str),
            Some("evt_payload")
        );
    }

    #[test]
    fn event_accessor_reads_payload_message_nesting() {
        let event = accessor_fixture();
        let accessor = EventAccessor::new(&event);

        assert_eq!(
            accessor
                .field(EventNesting::PayloadMessage, "event_id")
                .and_then(Value::as_str),
            Some("evt_payload_message")
        );
    }

    #[test]
    fn maps_message_created_top_level() {
        let event = map_ws_event(&json!({
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
            "../packages/contracts/fixtures/identity-fixtures.json"
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

            let event = map_ws_event(&json!({
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
        let event = map_ws_event(&json!({
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
        let event = map_ws_event(&json!({
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
        let event = map_ws_event(&json!({
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
        let event = map_ws_event(&json!({
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
    fn maps_group_dm_top_level() {
        let event = map_ws_event(&json!({
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
        let event = map_ws_event(&json!({
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
        let event = map_ws_event(&json!({
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
        let event = map_ws_event(&json!({
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
    fn ignores_unsupported_events_safely() {
        assert!(map_ws_event(&json!({"type":"unknown"})).is_none());
        assert!(map_ws_event(&json!({"type":"channel.created","channel":{"name":"x"}})).is_none());
        assert!(map_ws_event(&json!({"type":"connected","client_id":"abc"})).is_none());
    }

    #[test]
    fn ignores_malformed_events() {
        assert!(map_ws_event(&json!({"type":"message.created","channel":"general"})).is_none());

        let mapped = map_ws_event(&json!({
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
    fn maps_command_invoked_spawn() {
        let cmd = map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "147298826957365248",
            "args": null,
            "parameters": {
                "name": "Worker1",
                "cli": "codex",
                "args": ["--full-auto"]
            }
        }))
        .expect("should map command.invoked spawn");

        assert_eq!(cmd.command, "/spawn");
        assert_eq!(cmd.channel, "general");
        assert_eq!(cmd.invoked_by, "147298826957365248");
        assert_eq!(cmd.handler_agent_id, None);
        assert_eq!(
            cmd.payload,
            crate::types::BrokerCommandPayload::Spawn(crate::types::SpawnParams {
                name: "Worker1".into(),
                cli: "codex".into(),
                args: vec!["--full-auto".into()],
            })
        );
    }

    #[test]
    fn maps_command_invoked_release() {
        let cmd = map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/release",
            "channel": "general",
            "invoked_by": "147298826957365248",
            "args": null,
            "parameters": {
                "name": "Worker1"
            }
        }))
        .expect("should map command.invoked release");

        assert_eq!(
            cmd.payload,
            crate::types::BrokerCommandPayload::Release(crate::types::ReleaseParams {
                name: "Worker1".into(),
            })
        );
    }

    #[test]
    fn maps_command_invoked_spawn_with_suffix() {
        let cmd = map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/spawn-19c4c7f8150",
            "channel": "general",
            "invoked_by": "147298826957365248",
            "parameters": {
                "name": "Worker2",
                "cli": "codex",
                "args": ["--full-auto"]
            }
        }))
        .expect("should map command.invoked spawn with suffix");

        assert_eq!(
            cmd.payload,
            crate::types::BrokerCommandPayload::Spawn(crate::types::SpawnParams {
                name: "Worker2".into(),
                cli: "codex".into(),
                args: vec!["--full-auto".into()],
            })
        );
    }

    #[test]
    fn maps_command_invoked_release_with_suffix() {
        let cmd = map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/release-19c4c7f8150",
            "channel": "general",
            "invoked_by": "147298826957365248",
            "parameters": {
                "name": "Worker2"
            }
        }))
        .expect("should map command.invoked release with suffix");

        assert_eq!(
            cmd.payload,
            crate::types::BrokerCommandPayload::Release(crate::types::ReleaseParams {
                name: "Worker2".into(),
            })
        );
    }

    #[test]
    fn maps_command_invoked_handler_agent_id() {
        let cmd = map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "147298826957365248",
            "handler_agent_id": "147305428879515648",
            "parameters": {
                "name": "Worker3",
                "cli": "codex"
            }
        }))
        .expect("should map command.invoked handler agent id");

        assert_eq!(cmd.handler_agent_id.as_deref(), Some("147305428879515648"));
    }

    #[test]
    fn command_invoked_ignores_non_command_types() {
        assert!(map_ws_broker_command(&json!({
            "type": "dm.received",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "123",
            "parameters": { "name": "x", "cli": "y" }
        }))
        .is_none());
    }

    #[test]
    fn command_invoked_ignores_similar_command_without_delimiter() {
        assert!(map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/spawnx",
            "channel": "general",
            "invoked_by": "123",
            "parameters": { "name": "x", "cli": "y" }
        }))
        .is_none());
    }

    #[test]
    fn command_invoked_ignores_unknown_commands() {
        assert!(map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/unknown",
            "channel": "general",
            "invoked_by": "123",
            "parameters": { "name": "x" }
        }))
        .is_none());
    }

    #[test]
    fn command_invoked_ignores_missing_parameters() {
        assert!(map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "123"
        }))
        .is_none());
    }

    #[test]
    fn command_invoked_not_picked_up_by_map_ws_event() {
        assert!(map_ws_event(&json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "123",
            "parameters": { "name": "Worker1", "cli": "codex" }
        }))
        .is_none());
    }
}
