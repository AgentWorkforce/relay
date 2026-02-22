use relaycast::WsEvent;
use serde_json::{Map, Value};

use crate::types::{
    BrokerCommandEvent, BrokerCommandPayload, InboundKind, InboundRelayEvent, InjectRequest,
    RelayPriority, ReleaseParams, SenderKind, SpawnParams,
};

/// Map a Relaycast ServerEvent (received over WebSocket) to an InboundRelayEvent.
///
/// Supports both current top-level events and older payload-wrapped events.
pub fn map_ws_event(value: &Value) -> Option<InboundRelayEvent> {
    if let Some(mapped) = map_ws_event_from_sdk(value) {
        return Some(mapped);
    }

    let event_type = value.get("type")?.as_str()?;
    let kind = parse_inbound_kind(event_type)?;

    if matches!(kind, InboundKind::Presence) {
        let from = extract_presence_sender(value).unwrap_or_else(|| "unknown".to_string());
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

    let event_id = extract_event_id(value)?;
    let from = extract_sender(value).unwrap_or_else(|| "unknown".to_string());
    let sender_agent_id = extract_sender_agent_id(value);
    let sender_kind = parse_sender_kind(value);
    let target = extract_target(value, &kind).unwrap_or_else(|| "unknown".to_string());
    let text = extract_text(value).unwrap_or_default();
    let thread_id = extract_thread_id(value);

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
    if let Some(mapped) = map_ws_broker_command_from_sdk(value) {
        return Some(mapped);
    }

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
        })?;

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

fn map_ws_event_from_sdk(value: &Value) -> Option<InboundRelayEvent> {
    let event: WsEvent = serde_json::from_value(value.clone()).ok()?;

    match event {
        WsEvent::MessageCreated(e) => Some(InboundRelayEvent {
            event_id: e.message.id,
            kind: InboundKind::MessageCreated,
            from: e.message.agent_name,
            sender_agent_id: value
                .pointer("/message/agent_id")
                .and_then(Value::as_str)
                .map(String::from),
            sender_kind: parse_sender_kind(value),
            target: normalize_channel_name(&e.channel),
            text: e.message.text,
            thread_id: None,
            priority: RelayPriority::P3,
        }),
        WsEvent::DmReceived(e) => Some(InboundRelayEvent {
            event_id: e.message.id,
            kind: InboundKind::DmReceived,
            from: e.message.agent_name,
            sender_agent_id: value
                .pointer("/message/agent_id")
                .and_then(Value::as_str)
                .map(String::from),
            sender_kind: parse_sender_kind(value),
            target: e.conversation_id,
            text: e.message.text,
            thread_id: None,
            priority: RelayPriority::P2,
        }),
        WsEvent::GroupDmReceived(e) => Some(InboundRelayEvent {
            event_id: e.message.id,
            kind: InboundKind::GroupDmReceived,
            from: e.message.agent_name,
            sender_agent_id: value
                .pointer("/message/agent_id")
                .and_then(Value::as_str)
                .map(String::from),
            sender_kind: parse_sender_kind(value),
            target: e.conversation_id,
            text: e.message.text,
            thread_id: None,
            priority: RelayPriority::P3,
        }),
        WsEvent::ThreadReply(e) => Some(InboundRelayEvent {
            event_id: e.message.id,
            kind: InboundKind::ThreadReply,
            from: e.message.agent_name,
            sender_agent_id: value
                .pointer("/message/agent_id")
                .and_then(Value::as_str)
                .map(String::from),
            sender_kind: parse_sender_kind(value),
            target: "thread".to_string(),
            text: e.message.text,
            thread_id: Some(e.parent_id),
            priority: RelayPriority::P3,
        }),
        WsEvent::AgentOnline(e) => {
            let from = e.agent.name;
            Some(InboundRelayEvent {
                event_id: format!("presence-agent.online-{from}"),
                kind: InboundKind::Presence,
                from,
                sender_agent_id: None,
                sender_kind: SenderKind::Agent,
                target: String::new(),
                text: String::new(),
                thread_id: None,
                priority: RelayPriority::P4,
            })
        }
        WsEvent::AgentOffline(e) => {
            let from = e.agent.name;
            Some(InboundRelayEvent {
                event_id: format!("presence-agent.offline-{from}"),
                kind: InboundKind::Presence,
                from,
                sender_agent_id: None,
                sender_kind: SenderKind::Agent,
                target: String::new(),
                text: String::new(),
                thread_id: None,
                priority: RelayPriority::P4,
            })
        }
        _ => None,
    }
}

fn map_ws_broker_command_from_sdk(value: &Value) -> Option<BrokerCommandEvent> {
    let event: WsEvent = serde_json::from_value(value.clone()).ok()?;
    let invoked = match event {
        WsEvent::CommandInvoked(invoked) => invoked,
        _ => return None,
    };

    let command_name = invoked.command.trim_start_matches('/');
    let params = Value::Object(invoked.parameters?);
    let payload = if command_name == "spawn" || command_name.starts_with("spawn-") {
        let spawn: SpawnParams = serde_json::from_value(params).ok()?;
        BrokerCommandPayload::Spawn(spawn)
    } else if command_name == "release" || command_name.starts_with("release-") {
        let release: ReleaseParams = serde_json::from_value(params).ok()?;
        BrokerCommandPayload::Release(release)
    } else {
        return None;
    };

    Some(BrokerCommandEvent {
        command: invoked.command,
        channel: invoked.channel,
        invoked_by: invoked.invoked_by,
        handler_agent_id: invoked.handler_agent_id,
        payload,
    })
}

fn parse_inbound_kind(event_type: &str) -> Option<InboundKind> {
    match event_type {
        "message.created" | "message.received" | "message.new" => Some(InboundKind::MessageCreated),
        "dm.received" | "dm.created" | "direct_message.received" => Some(InboundKind::DmReceived),
        "thread.reply" | "thread.message.created" => Some(InboundKind::ThreadReply),
        "group_dm.received" | "group_dm.created" => Some(InboundKind::GroupDmReceived),
        "agent.online" | "agent.offline" | "user.online" | "user.offline" => {
            Some(InboundKind::Presence)
        }
        _ => None,
    }
}

fn normalize_channel_name(raw: &str) -> String {
    if raw.starts_with('#') {
        raw.to_string()
    } else {
        format!("#{raw}")
    }
}

fn extract_presence_sender(value: &Value) -> Option<String> {
    let payload = value.get("payload");
    for candidate in [
        value.get("agent").and_then(|a| a.get("name")),
        payload
            .and_then(|p| p.get("agent"))
            .and_then(|a| a.get("name")),
        value.get("agent_name"),
        payload.and_then(|p| p.get("agent_name")),
        value.get("from"),
        payload.and_then(|p| p.get("from")),
    ] {
        if let Some(name) = candidate.and_then(scalar_to_string) {
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn extract_event_id(value: &Value) -> Option<String> {
    let payload = value.get("payload");
    for candidate in [
        value.get("event_id"),
        value.get("id"),
        value.get("message").and_then(|m| m.get("event_id")),
        value.get("message").and_then(|m| m.get("id")),
        payload.and_then(|p| p.get("event_id")),
        payload.and_then(|p| p.get("id")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("event_id")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("id")),
    ] {
        if let Some(id) = candidate.and_then(scalar_to_string) {
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

/// Extract the agent_id from the message object in a WS event.
/// Relaycast includes `agent_id` inside the `message` sub-object.
fn extract_sender_agent_id(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(|m| m.get("agent_id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn extract_sender(value: &Value) -> Option<String> {
    let payload = value.get("payload");
    for candidate in [
        value.get("from"),
        value.get("sender"),
        value.get("author"),
        value.get("from_agent"),
        value.get("agent_name"),
        value.get("message").and_then(|m| m.get("from")),
        value.get("message").and_then(|m| m.get("sender")),
        value.get("message").and_then(|m| m.get("author")),
        value.get("message").and_then(|m| m.get("agent_name")),
        payload.and_then(|p| p.get("from")),
        payload.and_then(|p| p.get("sender")),
        payload.and_then(|p| p.get("author")),
        payload.and_then(|p| p.get("from_agent")),
        payload.and_then(|p| p.get("agent_name")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("from")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("sender")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("author")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("agent_name")),
    ] {
        if let Some(name) = candidate.and_then(sender_value_to_string) {
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn extract_target(value: &Value, kind: &InboundKind) -> Option<String> {
    let payload = value.get("payload");

    if matches!(kind, InboundKind::DmReceived | InboundKind::GroupDmReceived) {
        for candidate in [
            value.get("conversation_id"),
            value.get("target"),
            payload.and_then(|p| p.get("conversation_id")),
            payload.and_then(|p| p.get("target")),
            payload
                .and_then(|p| p.get("message"))
                .and_then(|m| m.get("target")),
        ] {
            if let Some(target) = candidate.and_then(scalar_to_string) {
                if !target.is_empty() {
                    return Some(target);
                }
            }
        }
    }

    if let Some(channel) = extract_channel(value) {
        return Some(channel);
    }

    for candidate in [
        value.get("target"),
        value.get("to"),
        value.get("recipient"),
        value.get("message").and_then(|m| m.get("target")),
        value.get("message").and_then(|m| m.get("to")),
        value.get("message").and_then(|m| m.get("recipient")),
        payload.and_then(|p| p.get("target")),
        payload.and_then(|p| p.get("to")),
        payload.and_then(|p| p.get("recipient")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("target")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("to")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("recipient")),
    ] {
        if let Some(target) = candidate.and_then(scalar_to_string) {
            if !target.is_empty() {
                return Some(target);
            }
        }
    }

    if matches!(kind, InboundKind::ThreadReply) {
        return Some("thread".to_string());
    }

    None
}

fn extract_channel(value: &Value) -> Option<String> {
    let payload = value.get("payload");
    for candidate in [
        value.get("channel"),
        value.get("message").and_then(|m| m.get("channel")),
        payload.and_then(|p| p.get("channel")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("channel")),
    ] {
        if let Some(raw) = candidate.and_then(scalar_to_string) {
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

fn extract_text(value: &Value) -> Option<String> {
    let payload = value.get("payload");
    for candidate in [
        value.get("text"),
        value.get("body"),
        value.get("content"),
        value.get("message").and_then(|m| m.get("text")),
        value.get("message").and_then(|m| m.get("body")),
        value.get("message").and_then(|m| m.get("content")),
        payload.and_then(|p| p.get("text")),
        payload.and_then(|p| p.get("body")),
        payload.and_then(|p| p.get("content")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("text")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("body")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("content")),
    ] {
        if let Some(text) = candidate.and_then(scalar_to_string) {
            return Some(text);
        }
    }

    if let Some(raw_message) = value.get("message").and_then(Value::as_str) {
        return Some(raw_message.to_string());
    }
    if let Some(raw_message) = payload
        .and_then(|p| p.get("message"))
        .and_then(Value::as_str)
    {
        return Some(raw_message.to_string());
    }

    None
}

fn extract_thread_id(value: &Value) -> Option<String> {
    let payload = value.get("payload");
    for candidate in [
        value.get("parent_id"),
        value.get("thread_id"),
        value.get("threadId"),
        value.get("message").and_then(|m| m.get("thread_id")),
        value.get("message").and_then(|m| m.get("threadId")),
        payload.and_then(|p| p.get("parent_id")),
        payload.and_then(|p| p.get("thread_id")),
        payload.and_then(|p| p.get("threadId")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("thread_id")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("threadId")),
    ] {
        if let Some(id) = candidate.and_then(scalar_to_string) {
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
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

fn parse_sender_kind(value: &Value) -> SenderKind {
    let payload = value.get("payload");

    for candidate in [
        value.get("from_type"),
        value.get("sender_type"),
        value.get("actor_type"),
        value.get("source_type"),
        value.get("origin_type"),
        value.get("sender_kind"),
        value.get("message").and_then(|m| m.get("from_type")),
        value.get("message").and_then(|m| m.get("sender_type")),
        value.get("message").and_then(|m| m.get("actor_type")),
        value.get("message").and_then(|m| m.get("source_type")),
        value.get("message").and_then(|m| m.get("origin_type")),
        value.get("message").and_then(|m| m.get("sender_kind")),
        payload.and_then(|p| p.get("from_type")),
        payload.and_then(|p| p.get("sender_type")),
        payload.and_then(|p| p.get("actor_type")),
        payload.and_then(|p| p.get("source_type")),
        payload.and_then(|p| p.get("origin_type")),
        payload.and_then(|p| p.get("sender_kind")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("from_type")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("sender_type")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("actor_type")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("source_type")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("origin_type")),
        payload
            .and_then(|p| p.get("message"))
            .and_then(|m| m.get("sender_kind")),
    ] {
        if let Some(kind) = candidate
            .and_then(Value::as_str)
            .and_then(parse_sender_kind_label)
        {
            return kind;
        }
    }

    for obj in [
        value.as_object(),
        value.get("message").and_then(Value::as_object),
        payload.and_then(Value::as_object),
        payload
            .and_then(|p| p.get("message"))
            .and_then(Value::as_object),
    ] {
        if let Some(kind) = obj.and_then(parse_sender_kind_from_containers) {
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
    use serde_json::json;

    use crate::types::InboundKind;

    use super::{map_ws_broker_command, map_ws_event, to_inject_request};

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
        assert!(map_ws_event(&json!({
            "type":"message.created",
            "channel":"general",
            "message": {"agent_name":"alice","text":"hello"}
        }))
        .is_none());
    }

    #[test]
    fn maps_command_invoked_spawn() {
        let cmd = map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "147298826957365248",
            "handler_agent_id": "147305428879515648",
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
        assert_eq!(cmd.handler_agent_id, "147305428879515648");
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
            "handler_agent_id": "147305428879515648",
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
            "handler_agent_id": "147305428879515648",
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
            "handler_agent_id": "147305428879515648",
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

        assert_eq!(cmd.handler_agent_id, "147305428879515648");
    }

    #[test]
    fn command_invoked_ignores_missing_handler_agent_id() {
        assert!(map_ws_broker_command(&json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "123",
            "parameters": { "name": "x", "cli": "y" }
        }))
        .is_none());
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
