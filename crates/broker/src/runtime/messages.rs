use super::*;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadInfo {
    pub(super) thread_id: String,
    pub(super) name: String,
    pub(super) unread_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_message_at: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ThreadAccumulator {
    info: ThreadInfo,
    sort_key: i64,
}

pub(crate) fn normalize_sender(sender: Option<String>) -> String {
    let raw = sender
        .unwrap_or_else(|| "human:orchestrator".to_string())
        .trim()
        .to_string();
    if raw.is_empty() {
        return "human:orchestrator".to_string();
    }
    if let Some(rest) = raw.strip_prefix("human:") {
        let normalized_rest = rest.trim();
        if normalized_rest.is_empty() {
            return "human:orchestrator".to_string();
        }
        return format!("human:{normalized_rest}");
    }
    raw
}

pub(crate) fn sender_is_dashboard_label(sender: &str, self_name: &str) -> bool {
    let trimmed = sender.trim();
    trimmed.eq_ignore_ascii_case("Dashboard")
        || trimmed.eq_ignore_ascii_case("human:Dashboard")
        || trimmed.eq_ignore_ascii_case("human:orchestrator")
        || trimmed.eq_ignore_ascii_case(self_name)
}

pub(crate) fn normalize_identity_for_thread(raw: &str) -> String {
    raw.trim().trim_start_matches('@').to_ascii_lowercase()
}

pub(crate) fn json_scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

pub(crate) fn first_string(value: &Value, pointers: &[&str]) -> Option<String> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(json_scalar_to_string))
}

pub(crate) fn first_bool(value: &Value, pointers: &[&str]) -> Option<bool> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_bool))
}

pub(crate) fn first_u64(value: &Value, pointers: &[&str]) -> Option<u64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_u64))
}

pub(crate) fn first_i64(value: &Value, pointers: &[&str]) -> Option<i64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_i64))
}

pub(crate) fn relaycast_ws_spawn_token(value: &Value) -> Option<String> {
    first_string(
        value,
        &[
            "/agent/token",
            "/agent/relay_key",
            "/agent/api_key",
            "/token",
        ],
    )
}

pub(crate) fn relaycast_spawn_control_dedup_key(workspace_id: &str, identity: &str) -> String {
    format!("control:{workspace_id}:agent.spawn_requested:{identity}")
}

pub(crate) fn relaycast_ws_should_apply_local_spawn_echo_dedup(
    control_dedup_key: Option<&str>,
    local_spawn_echo_key: &str,
) -> bool {
    control_dedup_key != Some(local_spawn_echo_key)
}

pub(crate) fn note_local_spawn_control_dedup(
    dedup: &mut DedupCache,
    workspace_id: Option<&str>,
    agent_name: &str,
    relay_key: Option<&str>,
) {
    let Some(workspace_id) = workspace_id else {
        return;
    };
    let agent_name = agent_name.trim();
    if !agent_name.is_empty() {
        let key = relaycast_spawn_control_dedup_key(workspace_id, agent_name);
        dedup.insert_if_new(&key, Instant::now());
    }
    if let Some(relay_key) = relay_key.map(str::trim).filter(|value| !value.is_empty()) {
        let key = relaycast_spawn_control_dedup_key(workspace_id, relay_key);
        dedup.insert_if_new(&key, Instant::now());
    }
}

pub(crate) fn is_unknown_worker_error_message(message: &str) -> bool {
    message.contains("unknown worker '")
}

pub(crate) fn is_relaycast_self_control_target(
    name: &str,
    workspace_self_name: &str,
    workspace_self_names: &HashSet<String>,
) -> bool {
    let normalized = normalize_identity_for_thread(name);
    normalized == normalize_identity_for_thread(workspace_self_name)
        || workspace_self_names.contains(&normalized)
}

pub(crate) fn message_sender(value: &Value) -> Option<String> {
    first_string(
        value,
        &[
            "/from",
            "/sender",
            "/author",
            "/agent_name",
            "/message/from",
            "/message/sender",
            "/message/author",
            "/payload/from",
            "/payload/sender",
            "/payload/author",
            "/payload/message/from",
            "/payload/message/sender",
            "/payload/message/author",
        ],
    )
}

pub(crate) fn message_target(value: &Value) -> Option<String> {
    first_string(
        value,
        &[
            "/target",
            "/to",
            "/recipient",
            "/channel",
            "/conversation_id",
            "/conversationId",
            "/message/target",
            "/message/to",
            "/message/recipient",
            "/message/channel",
            "/message/conversation_id",
            "/message/conversationId",
            "/payload/target",
            "/payload/to",
            "/payload/recipient",
            "/payload/channel",
            "/payload/conversation_id",
            "/payload/conversationId",
            "/payload/message/target",
            "/payload/message/to",
            "/payload/message/recipient",
            "/payload/message/channel",
            "/payload/message/conversation_id",
            "/payload/message/conversationId",
        ],
    )
}

pub(crate) fn message_preview(value: &Value) -> Option<String> {
    let text = first_string(
        value,
        &[
            "/text",
            "/body",
            "/content",
            "/message/text",
            "/message/body",
            "/message/content",
            "/payload/text",
            "/payload/body",
            "/payload/content",
            "/payload/message/text",
            "/payload/message/body",
            "/payload/message/content",
            "/message",
            "/payload/message",
        ],
    )?;
    Some(truncate_thread_preview(&text, 200))
}

pub(crate) fn truncate_thread_preview(input: &str, max_len: usize) -> String {
    let trimmed = input.trim();
    if trimmed.len() <= max_len {
        return trimmed.to_string();
    }
    let boundary = floor_char_boundary(trimmed, max_len);
    let mut out = trimmed[..boundary].to_string();
    out.push_str("...");
    out
}

/// Parse a message timestamp into a millisecond sort key.
///
/// Numeric values below `4_102_444_800` are treated as Unix seconds so mixed
/// second, millisecond, and RFC3339 inputs sort in the same unit.
pub(crate) fn parse_sort_key_from_raw_timestamp(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(epoch) = trimmed.parse::<i64>() {
        return Some(if epoch < 4_102_444_800 {
            epoch.saturating_mul(1_000)
        } else {
            epoch
        });
    }
    chrono::DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

pub(crate) fn message_timestamp_string(value: &Value) -> Option<String> {
    first_string(
        value,
        &[
            "/created_at",
            "/createdAt",
            "/timestamp",
            "/ts",
            "/message/created_at",
            "/message/createdAt",
            "/message/timestamp",
            "/message/ts",
            "/payload/created_at",
            "/payload/createdAt",
            "/payload/timestamp",
            "/payload/ts",
            "/payload/message/created_at",
            "/payload/message/createdAt",
            "/payload/message/timestamp",
            "/payload/message/ts",
        ],
    )
}

pub(crate) fn message_sort_key(value: &Value, index: usize) -> i64 {
    if let Some(raw) = message_timestamp_string(value) {
        if let Some(parsed) = parse_sort_key_from_raw_timestamp(&raw) {
            return parsed;
        }
    }

    first_i64(
        value,
        &[
            "/created_at",
            "/createdAt",
            "/timestamp",
            "/ts",
            "/message/created_at",
            "/message/createdAt",
            "/message/timestamp",
            "/message/ts",
            "/payload/created_at",
            "/payload/createdAt",
            "/payload/timestamp",
            "/payload/ts",
        ],
    )
    .unwrap_or(index as i64)
}

pub(crate) fn message_thread_id(value: &Value) -> Option<String> {
    if let Some(explicit) = first_string(
        value,
        &[
            "/thread_id",
            "/threadId",
            "/parent_id",
            "/conversation_id",
            "/conversationId",
            "/message/thread_id",
            "/message/threadId",
            "/message/parent_id",
            "/message/conversation_id",
            "/message/conversationId",
            "/payload/thread_id",
            "/payload/threadId",
            "/payload/parent_id",
            "/payload/conversation_id",
            "/payload/conversationId",
            "/payload/message/thread_id",
            "/payload/message/threadId",
            "/payload/message/parent_id",
            "/payload/message/conversation_id",
            "/payload/message/conversationId",
        ],
    ) {
        return Some(explicit);
    }

    let target = message_target(value)?;
    if target.starts_with('#') {
        return Some(normalize_channel(&target));
    }
    if target.starts_with("conv_")
        || target.starts_with("dm_")
        || target.chars().all(|ch| ch.is_ascii_digit())
    {
        return Some(target);
    }

    let sender = message_sender(value)?;
    let sender = normalize_identity_for_thread(&sender);
    let target = normalize_identity_for_thread(&target);
    if sender.is_empty() || target.is_empty() {
        return None;
    }
    let (first, second) = if sender <= target {
        (sender, target)
    } else {
        (target, sender)
    };
    Some(format!("direct:{first}:{second}"))
}

pub(crate) fn is_self_identity(value: &str, self_names: &HashSet<String>) -> bool {
    let normalized = normalize_identity_for_thread(value);
    !normalized.is_empty()
        && self_names
            .iter()
            .any(|self_name| normalize_identity_for_thread(self_name) == normalized)
}

pub(crate) fn derive_thread_name(
    message: &Value,
    thread_id: &str,
    self_names: &HashSet<String>,
) -> String {
    if let Some(explicit) = first_string(
        message,
        &[
            "/thread_name",
            "/threadName",
            "/title",
            "/subject",
            "/conversation_name",
            "/conversationName",
        ],
    ) {
        return explicit;
    }

    if thread_id.starts_with('#') {
        return thread_id.to_string();
    }

    // Use participants array (from workspace-level DM data) to build a combined name
    // like "WorkerA ↔ WorkerB" for DMs between non-broker agents.
    if let Some(participants) = message.get("participants").and_then(|v| v.as_array()) {
        let names: Vec<&str> = participants
            .iter()
            .filter_map(|p| p.as_str())
            .filter(|name| !is_self_identity(name, self_names))
            .collect();
        if names.len() >= 2 {
            return format!("{} ↔ {}", names[0], names[1]);
        } else if names.len() == 1 {
            return names[0].to_string();
        }
    }

    if let Some(sender) = message_sender(message) {
        if !is_self_identity(&sender, self_names) {
            return sender.trim().trim_start_matches('@').to_string();
        }
    }

    if let Some(target) = message_target(message) {
        let trimmed = target.trim().trim_start_matches('@');
        if trimmed.starts_with('#') {
            return normalize_channel(trimmed);
        }
        if !trimmed.is_empty()
            && !trimmed.eq_ignore_ascii_case(thread_id)
            && !is_self_identity(trimmed, self_names)
            && !trimmed.starts_with("conv_")
            && !trimmed.starts_with("dm_")
            && !trimmed.chars().all(|ch| ch.is_ascii_digit())
        {
            return trimmed.to_string();
        }
    }

    thread_id.to_string()
}

pub(crate) fn thread_unread_increment(message: &Value, self_names: &HashSet<String>) -> usize {
    if let Some(read) = first_bool(
        message,
        &[
            "/read",
            "/is_read",
            "/isRead",
            "/message/read",
            "/message/is_read",
            "/message/isRead",
            "/payload/read",
            "/payload/is_read",
            "/payload/isRead",
            "/payload/message/read",
            "/payload/message/is_read",
            "/payload/message/isRead",
        ],
    ) {
        return usize::from(!read);
    }

    if let Some(sender) = message_sender(message) {
        return usize::from(!is_self_identity(&sender, self_names));
    }
    0
}

pub(crate) fn build_thread_infos(
    messages: &[Value],
    self_names: &HashSet<String>,
) -> Vec<ThreadInfo> {
    let mut by_thread: HashMap<String, ThreadAccumulator> = HashMap::new();

    for (index, message) in messages.iter().enumerate() {
        let Some(thread_id) = message_thread_id(message) else {
            continue;
        };

        let name = derive_thread_name(message, &thread_id, self_names);
        let sort_key = message_sort_key(message, index);
        let preview = message_preview(message);
        let timestamp = message_timestamp_string(message);
        let explicit_unread = first_u64(
            message,
            &[
                "/unread_count",
                "/unreadCount",
                "/message/unread_count",
                "/message/unreadCount",
                "/payload/unread_count",
                "/payload/unreadCount",
                "/payload/message/unread_count",
                "/payload/message/unreadCount",
            ],
        )
        .map(|value| value as usize);
        let unread_delta = thread_unread_increment(message, self_names);

        let entry = by_thread
            .entry(thread_id.clone())
            .or_insert_with(|| ThreadAccumulator {
                info: ThreadInfo {
                    thread_id: thread_id.clone(),
                    name: name.clone(),
                    unread_count: 0,
                    last_message: None,
                    last_message_at: None,
                },
                sort_key,
            });

        if entry.info.name == entry.info.thread_id && name != entry.info.thread_id {
            entry.info.name = name.clone();
        }

        if let Some(explicit_unread) = explicit_unread {
            entry.info.unread_count = entry.info.unread_count.max(explicit_unread);
        } else {
            entry.info.unread_count = entry.info.unread_count.saturating_add(unread_delta);
        }

        if sort_key >= entry.sort_key {
            entry.sort_key = sort_key;
            entry.info.name = name;
            entry.info.last_message = preview;
            entry.info.last_message_at = timestamp;
        }
    }

    let mut threads: Vec<ThreadAccumulator> = by_thread.into_values().collect();
    threads.sort_by(|left, right| {
        right
            .sort_key
            .cmp(&left.sort_key)
            .then_with(|| left.info.thread_id.cmp(&right.info.thread_id))
    });

    threads.into_iter().map(|entry| entry.info).collect()
}

pub(crate) fn record_thread_history_event(history: &mut VecDeque<Value>, event: Value) {
    if history.len() >= THREAD_HISTORY_LIMIT {
        let _ = history.pop_front();
    }
    history.push_back(event);
}
