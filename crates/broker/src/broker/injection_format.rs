fn workspace_context_label(
    workspace_id: Option<&str>,
    workspace_alias: Option<&str>,
) -> Option<String> {
    workspace_alias
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            workspace_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn sender_display_name(from: &str) -> &str {
    let normalized = from
        .strip_prefix("human:")
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(from);

    if is_broker_identity(normalized) {
        "Dashboard"
    } else {
        normalized
    }
}

fn sender_reply_target(from: &str) -> &str {
    from.strip_prefix("human:")
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(from)
}

fn is_broker_identity(name: &str) -> bool {
    let trimmed = name.trim();
    let Some(rest) = trimmed.strip_prefix("broker-") else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn detect_channel_context(message: &str, target: &str) -> Option<String> {
    if target.starts_with('#') {
        return Some(target.trim().to_string());
    }
    if let Some(start) = message.find("[#") {
        let rest = &message[start + 1..];
        if let Some(end) = rest.find(']') {
            let channel = rest[..end].trim();
            if channel.starts_with('#') && channel.len() > 1 {
                return Some(channel.to_string());
            }
        }
    }
    if let Some(start) = message.find(" in #") {
        let rest = &message[start + 4..];
        let end = rest.find([' ', ':', ']', '\n']).unwrap_or(rest.len());
        let candidate = rest[..end].trim();
        if candidate.starts_with('#') && candidate.len() > 1 {
            return Some(candidate.to_string());
        }
    }
    None
}

fn build_mcp_reminder(
    sender: &str,
    target: &str,
    relay_line: &str,
    pre_registered: bool,
    assigned_name: Option<&str>,
) -> String {
    let sender_name = sender_display_name(sender);
    let reply_target = sender_reply_target(sender);
    let channel_context = detect_channel_context(relay_line, target);
    let channel_hint = channel_context
        .as_deref()
        .unwrap_or("#general")
        .trim_start_matches('#');

    // Tool names differ by MCP client: Claude uses mcp__agent-relay__<tool>,
    // Codex/others use agent-relay.<tool>. Include both so any agent can act.
    let dm_hint = if reply_target.eq_ignore_ascii_case(sender_name) {
        format!(
            "- For direct replies to \"{sender_name}\", use mcp__agent-relay__send_dm or agent-relay.send_dm (to: \"{sender_name}\")."
        )
    } else {
        format!(
            "- For direct replies to \"{sender_name}\", use mcp__agent-relay__send_dm or agent-relay.send_dm (to: \"{reply_target}\")."
        )
    };
    let channel_hint_line = format!(
        "- For channel replies, use mcp__agent-relay__post_message or agent-relay.post_message (channel: \"{channel_hint}\")."
    );

    let registration_lines: [String; 2] = if pre_registered {
        [
            "You are pre-registered by the broker under your assigned worker name.".to_string(),
            "Do not call mcp__agent-relay__register_agent unless a send/reply fails with \"Not registered\"."
                .to_string(),
        ]
    } else if let Some(name) = assigned_name {
        [
            "This worker was not pre-registered by the broker.".to_string(),
            format!(
                "Before replying, call mcp__agent-relay__register_agent (name: \"{name}\", type: \"agent\")."
            ),
        ]
    } else {
        [
            "This worker was not pre-registered by the broker.".to_string(),
            "Before replying, call mcp__agent-relay__register_agent (name: \"<worker-name>\", type: \"agent\")."
                .to_string(),
        ]
    };

    [
        "<system-reminder>".to_string(),
        "Agent Relay MCP tools are available for replies.".to_string(),
        registration_lines[0].clone(),
        registration_lines[1].clone(),
        dm_hint,
        channel_hint_line,
        "- For thread replies, use mcp__agent-relay__reply_to_thread or agent-relay.reply_to_thread.".to_string(),
        "- To check unread messages/reactions, use mcp__agent-relay__check_inbox or agent-relay.check_inbox.".to_string(),
        "- Self-termination is not automatic. Only call remove_agent(name: \"<your-agent-name>\") or output /exit on its own line when explicitly instructed to terminate.".to_string(),
        "</system-reminder>".to_string(),
    ]
    .join("\n")
}

fn build_mcp_short_hint(
    sender: &str,
    target: &str,
    relay_line: &str,
    pre_registered: bool,
    assigned_name: Option<&str>,
) -> String {
    let sender_name = sender_display_name(sender);
    let reply_target = sender_reply_target(sender);
    let dm_target = if reply_target.eq_ignore_ascii_case(sender_name) {
        sender_name.to_string()
    } else {
        reply_target.to_string()
    };
    let channel_context = detect_channel_context(relay_line, target);
    let channel_hint = channel_context
        .as_deref()
        .unwrap_or("#general")
        .trim_start_matches('#');

    let register_hint = if pre_registered {
        String::new()
    } else if let Some(name) = assigned_name {
        format!(
            " If unregistered, call mcp__agent-relay__register_agent(name: \"{name}\", type: \"agent\") first."
        )
    } else {
        " If unregistered, call mcp__agent-relay__register_agent(name: \"<worker-name>\", type: \"agent\") first."
            .to_string()
    };

    format!(
        "<system-reminder>Reply via Agent Relay MCP: mcp__agent-relay__send_dm/agent-relay.send_dm (to: \"{dm_target}\") or mcp__agent-relay__post_message/agent-relay.post_message (channel: \"{channel_hint}\").{register_hint}</system-reminder>"
    )
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn format_injection(from: &str, event_id: &str, body: &str, target: &str) -> String {
    format_injection_with_reminder(from, event_id, body, target, true)
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn format_injection_with_reminder(
    from: &str,
    event_id: &str,
    body: &str,
    target: &str,
    include_reminder: bool,
) -> String {
    format_injection_for_worker(from, event_id, body, target, include_reminder, true, None)
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn format_injection_for_worker(
    from: &str,
    event_id: &str,
    body: &str,
    target: &str,
    include_reminder: bool,
    pre_registered: bool,
    assigned_name: Option<&str>,
) -> String {
    format_injection_for_worker_with_workspace(
        from,
        event_id,
        body,
        target,
        include_reminder,
        pre_registered,
        assigned_name,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn format_injection_for_worker_with_workspace(
    from: &str,
    event_id: &str,
    body: &str,
    target: &str,
    include_reminder: bool,
    pre_registered: bool,
    assigned_name: Option<&str>,
    workspace_id: Option<&str>,
    workspace_alias: Option<&str>,
) -> String {
    let sender_name = sender_display_name(from);
    let workspace_label = workspace_context_label(workspace_id, workspace_alias);
    let event_context = workspace_label
        .as_deref()
        .map(|label| format!("{label} / {event_id}"))
        .unwrap_or_else(|| event_id.to_string());
    let relay_line = if body.starts_with("Relay message from ") {
        body.trim().to_string()
    } else if target.starts_with('#') {
        format!(
            "Relay message from {} in {} [{}]: {}",
            sender_name, target, event_context, body
        )
    } else {
        format!(
            "Relay message from {} [{}]: {}",
            sender_name, event_context, body
        )
    };

    if !include_reminder {
        let short_hint =
            build_mcp_short_hint(from, target, &relay_line, pre_registered, assigned_name);
        return format!("{short_hint}\n{relay_line}");
    }

    let mut reminder = build_mcp_reminder(from, target, &relay_line, pre_registered, assigned_name);
    if let Some(label) = workspace_label {
        reminder = reminder.replace(
            "</system-reminder>",
            &format!("- This message belongs to workspace \"{label}\"; keep replies scoped to that workspace.\n</system-reminder>"),
        );
    }
    format!("{reminder}\n{relay_line}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_injection_dm() {
        let result = format_injection("Alice", "evt_1", "hello world", "Bob");
        assert!(result.contains("<system-reminder>"));
        assert!(result.contains("Agent Relay MCP tools"));
        assert!(result.contains("pre-registered by the broker"));
        assert!(result.contains("mcp__agent-relay__send_dm"));
        assert!(result.contains("Self-termination is not automatic"));
        assert!(result.contains("Relay message from Alice [evt_1]: hello world"));
    }

    #[test]
    fn format_injection_channel() {
        let result = format_injection("Alice", "evt_1", "hello world", "#general");
        assert!(result.contains("<system-reminder>"));
        assert!(result.contains("mcp__agent-relay__post_message"));
        assert!(result.contains("channel: \"general\""));
        assert!(result.contains("Relay message from Alice in #general [evt_1]: hello world"));
    }

    #[test]
    fn format_injection_worker_without_preregistration_includes_register_guidance() {
        let result = format_injection_for_worker(
            "Alice",
            "evt_1",
            "hello world",
            "Bob",
            true,
            false,
            Some("Lead"),
        );
        assert!(result.contains("<system-reminder>"));
        assert!(result.contains("not pre-registered by the broker"));
        assert!(result.contains("mcp__agent-relay__register_agent"));
        assert!(result.contains("name: \"Lead\""));
    }

    #[test]
    fn format_injection_pre_formatted() {
        let body = "Relay message from Bob [evt_0]: previous message";
        let result = format_injection("Alice", "evt_1", body, "Charlie");
        assert!(result.contains("<system-reminder>"));
        assert!(result.contains(body));
    }

    #[test]
    fn format_injection_strips_human_prefix_from_sender() {
        let result = format_injection("human:alice", "evt_1", "status?", "Bob");
        assert!(result.contains("Relay message from alice [evt_1]: status?"));
        assert!(result.contains("to \"alice\""));
    }

    #[test]
    fn format_injection_maps_broker_sender_to_dashboard_with_reply_target() {
        let result = format_injection("broker-951762d5", "evt_1", "status?", "Lead");
        assert!(result.contains("Relay message from Dashboard [evt_1]: status?"));
        assert!(result.contains("to: \"broker-951762d5\""));
    }

    #[test]
    fn format_injection_detects_channel_from_preformatted_body() {
        let body = "Relay message from bob [abc123] [#dev-team]: Channel update";
        let result = format_injection("system", "evt_1", body, "Worker");
        assert!(result.contains("mcp__agent-relay__post_message"));
        assert!(result.contains("channel: \"dev-team\""));
        assert!(result.contains(body));
    }

    #[test]
    fn format_injection_without_reminder_includes_short_mcp_hint() {
        let result = format_injection_with_reminder("alice", "evt_9", "retry body", "bob", false);
        assert!(result.contains("<system-reminder>Reply via Agent Relay MCP"));
        assert!(result.contains("mcp__agent-relay__send_dm"));
        assert!(result.contains("mcp__agent-relay__post_message"));
        assert!(result.contains("Relay message from alice [evt_9]: retry body"));
    }
}
