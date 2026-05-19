use super::*;

pub(crate) fn startup_debug_enabled() -> bool {
    std::env::var("AGENT_RELAY_STARTUP_DEBUG")
        .map(|value| {
            let trimmed = value.trim();
            !trimmed.is_empty() && trimmed != "0" && !trimmed.eq_ignore_ascii_case("false")
        })
        .unwrap_or(false)
}

pub(crate) fn log_startup_phase(enabled: bool, started_at: Instant, message: impl AsRef<str>) {
    if enabled {
        eprintln!(
            "[agent-relay][startup +{}ms] {}",
            started_at.elapsed().as_millis(),
            message.as_ref()
        );
    }
}

pub(crate) fn init_tracing() {
    let (writer, guard) = tracing_appender::non_blocking(std::io::stderr());
    let subscriber = tracing_subscriber::fmt::Subscriber::builder()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(true)
        .with_writer(writer)
        .finish();
    if tracing::subscriber::set_global_default(subscriber).is_ok() {
        let _ = TRACING_GUARD.set(guard);
    }
}

pub(crate) fn channels_from_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// Default channels for freshly spawned agents.
/// Reads RELAY_DEFAULT_CHANNELS (comma-separated) or falls back to the
/// broker's default channels: vec!["general", "engineering"] — both created
/// at startup by ensure_default_channels().
pub(crate) fn default_spawn_channels() -> Vec<String> {
    if let Ok(raw) = std::env::var("RELAY_DEFAULT_CHANNELS") {
        let parsed = channels_from_csv(&raw);
        if !parsed.is_empty() {
            return parsed;
        }
    }
    // channels: ["general", "engineering"] (must match ensure_default_channels)
    vec!["general".to_string(), "engineering".to_string()]
}

pub(crate) fn command_targets_self(cmd_event: &BrokerCommandEvent, self_agent_id: &str) -> bool {
    match cmd_event.handler_agent_id.as_deref() {
        Some(handler_id) => handler_id == self_agent_id,
        None => {
            tracing::warn!(
                command = %cmd_event.command,
                invoked_by = %cmd_event.invoked_by,
                "command has no handler_agent_id; accepting by default (multi-broker setups should scope commands)"
            );
            true
        }
    }
}

pub(crate) fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

pub(crate) fn delivery_retry_interval() -> Duration {
    let ms = std::env::var("AGENT_RELAY_DELIVERY_RETRY_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_DELIVERY_RETRY_MS);
    Duration::from_millis(ms.max(50))
}

pub(crate) fn http_api_local_delivery_timeout() -> Duration {
    let ms = std::env::var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS);
    Duration::from_millis(ms.max(100))
}

pub(crate) fn http_api_relaycast_send_timeout() -> Duration {
    let ms = std::env::var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS);
    Duration::from_millis(ms.max(500))
}

pub(crate) fn http_api_event_emit_timeout() -> Duration {
    let ms = std::env::var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_HTTP_API_EVENT_EMIT_TIMEOUT_MS);
    Duration::from_millis(ms.max(25))
}

pub(crate) fn normalize_channel(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('#') {
        trimmed.to_string()
    } else {
        format!("#{trimmed}")
    }
}

pub(crate) fn build_agent_state_transition_event(
    name: &str,
    state: &str,
    reason: Option<&str>,
) -> Value {
    let mut payload = json!({
        "type": "agent.state",
        "state": state,
        "agent": { "name": name },
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });
    if let Some(reason) = reason.map(str::trim).filter(|value| !value.is_empty()) {
        payload["reason"] = json!(reason);
    }
    payload
}

pub(crate) async fn publish_agent_state_transition(
    ws_control_tx: &mpsc::Sender<WsControl>,
    name: &str,
    state: &str,
    reason: Option<&str>,
) {
    let event = build_agent_state_transition_event(name, state, reason);
    if let Err(error) = ws_control_tx.send(WsControl::Publish(event)).await {
        tracing::debug!(
            agent = %name,
            state = %state,
            error = %error,
            "failed to publish agent state transition"
        );
    }
}

/// Get current terminal size. Returns (rows, cols).
///
/// Uses `crossterm::terminal::size()`, which is cross-platform:
/// TIOCGWINSZ on unix, GetConsoleScreenBufferInfo on Windows.
pub(crate) fn get_terminal_size() -> Option<(u16, u16)> {
    crossterm::terminal::size()
        .ok()
        .map(|(cols, rows)| (rows, cols))
}

/// Detect Claude Code auto-suggestion ghost text.
///
/// Auto-suggestions are rendered with reverse-video cursor + dim ghost text,
/// and often include the "↵ send" hint.
/// Extract Relaycast message IDs from MCP tool response output.
///
/// When the agent sends a message via MCP (send_dm, send_message, etc.),
/// the response JSON contains `"id": "<snowflake>"`. We extract these IDs
/// and pre-seed the dedup cache so the WS echo of the same message is dropped.
/// This is more robust than name-based filtering since it works regardless
/// of what identity the MCP server registers with.
pub(crate) fn extract_mcp_message_ids(buffer: &str) -> Vec<String> {
    let mut ids = Vec::new();
    // Match patterns like "id": "147310274064424960" (Relaycast snowflake IDs are 18-digit numbers)
    let mut search_start = 0;
    while let Some(key_pos) = buffer[search_start..].find("\"id\"") {
        let abs_pos = search_start + key_pos + 4; // skip past "id"
        if abs_pos >= buffer.len() {
            break;
        }
        let rest = &buffer[abs_pos..];
        // Skip whitespace and colon
        let rest = rest.trim_start();
        let rest = if let Some(r) = rest.strip_prefix(':') {
            r.trim_start()
        } else {
            search_start = abs_pos;
            continue;
        };
        // Extract quoted value
        if let Some(r) = rest.strip_prefix('"') {
            if let Some(end) = r.find('"') {
                let value = &r[..end];
                // Only match numeric snowflake IDs (15-20 digits)
                if value.len() >= 15
                    && value.len() <= 20
                    && value.chars().all(|c| c.is_ascii_digit())
                {
                    ids.push(value.to_string());
                }
            }
        }
        search_start = abs_pos;
    }
    ids
}
