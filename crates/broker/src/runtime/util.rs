use super::*;

const BROKER_LOG_ENV: &str = "AGENT_RELAY_BROKER_LOG";

pub(crate) fn startup_debug_enabled() -> bool {
    std::env::var("AGENT_RELAY_STARTUP_DEBUG")
        .map(|value| {
            let trimmed = value.trim();
            !trimmed.is_empty() && trimmed != "0" && !trimmed.eq_ignore_ascii_case("false")
        })
        .unwrap_or(false)
}

fn env_flag_value_enabled(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Where broker tracing output should be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TracingDestination {
    /// Disable the tracing subscriber entirely.
    Off,
    /// Write to stderr (legacy "print" behavior).
    Stderr,
    /// Write to `~/.agentworkforce/relay/logs/{broker_id}.log` (the default).
    File,
}

/// Parse the `AGENT_RELAY_BROKER_LOG` env var into a destination.
///
/// Defaults to [`TracingDestination::File`] when the env var is unset or empty.
/// Recognised values:
/// - `off`, `none`, `0`, `false`, `no` → [`TracingDestination::Off`]
/// - `stderr`, `print` → [`TracingDestination::Stderr`]
/// - `file`, `1`, `true`, `yes`, `on` → [`TracingDestination::File`]
///
/// Unknown values fall back to `File` so a typo never silently loses logs.
pub(crate) fn tracing_destination(env_value: Option<&str>) -> TracingDestination {
    let Some(value) = env_value.map(str::trim).filter(|v| !v.is_empty()) else {
        return TracingDestination::File;
    };
    match value.to_ascii_lowercase().as_str() {
        "off" | "none" | "0" | "false" | "no" => TracingDestination::Off,
        "stderr" | "print" => TracingDestination::Stderr,
        _ => TracingDestination::File,
    }
}

/// Pick the level filter directive for the tracing subscriber.
///
/// `RUST_LOG` always wins when set, so callers can use the standard tracing
/// directive syntax (e.g. `agent_relay::worker::pty=debug`). Otherwise we
/// default to `info`, which keeps the file log useful without being noisy.
pub(crate) fn tracing_filter_directive(rust_log: Option<&str>) -> String {
    rust_log
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "info".to_string())
}

fn sanitize_filename_segment(value: &str) -> String {
    let mut out: String = value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if out.is_empty() {
        out.push_str("broker");
    }
    out
}

/// Default log file path: `~/.agentworkforce/relay/logs/{broker_id}.log`.
///
/// Returns `None` only when the home directory cannot be resolved.
pub(crate) fn log_file_path(broker_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(
        home.join(".agentworkforce")
            .join("relay")
            .join("logs")
            .join(format!("{}.log", sanitize_filename_segment(broker_id))),
    )
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

pub(crate) fn unix_timestamp_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Initialise the global tracing subscriber for this broker process.
///
/// Destination is controlled by `AGENT_RELAY_BROKER_LOG`; level filter by
/// `RUST_LOG`. See [`tracing_destination`] for accepted env values.
pub(crate) fn init_tracing(broker_id: &str) {
    let rust_log = std::env::var("RUST_LOG").ok();
    let broker_log = std::env::var(BROKER_LOG_ENV).ok();
    let destination = tracing_destination(broker_log.as_deref());

    if destination == TracingDestination::Off {
        return;
    }

    let filter_directive = tracing_filter_directive(rust_log.as_deref());

    let (writer, guard) = match destination {
        TracingDestination::Stderr => tracing_appender::non_blocking(std::io::stderr()),
        TracingDestination::File => {
            let Some(log_path) = log_file_path(broker_id) else {
                return;
            };
            if let Some(parent) = log_path.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    return;
                }
            }
            match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                Ok(file) => tracing_appender::non_blocking(file),
                Err(_) => return,
            }
        }
        TracingDestination::Off => unreachable!(),
    };

    let subscriber = tracing_subscriber::fmt::Subscriber::builder()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_new(&filter_directive)
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
        .is_some_and(|value| env_flag_value_enabled(&value))
}

pub(crate) fn delivery_retry_interval() -> Duration {
    let ms = std::env::var("AGENT_RELAY_DELIVERY_RETRY_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_DELIVERY_RETRY_MS);
    Duration::from_millis(ms.max(50))
}

#[cfg(test)]
mod tests {
    use super::{
        log_file_path, sanitize_filename_segment, tracing_destination, tracing_filter_directive,
        TracingDestination,
    };

    #[test]
    fn tracing_destination_defaults_to_file() {
        assert_eq!(tracing_destination(None), TracingDestination::File);
        assert_eq!(tracing_destination(Some("")), TracingDestination::File);
        assert_eq!(tracing_destination(Some("   ")), TracingDestination::File);
    }

    #[test]
    fn tracing_destination_recognises_off_aliases() {
        for value in ["off", "OFF", "none", "0", "false", "no"] {
            assert_eq!(
                tracing_destination(Some(value)),
                TracingDestination::Off,
                "value `{value}` should disable tracing"
            );
        }
    }

    #[test]
    fn tracing_destination_recognises_stderr_aliases() {
        for value in ["stderr", "STDERR", "print", "Print"] {
            assert_eq!(
                tracing_destination(Some(value)),
                TracingDestination::Stderr,
                "value `{value}` should route to stderr"
            );
        }
    }

    #[test]
    fn tracing_destination_recognises_file_aliases() {
        for value in ["file", "FILE", "1", "true", "yes", "on", "unknown-value"] {
            assert_eq!(
                tracing_destination(Some(value)),
                TracingDestination::File,
                "value `{value}` should route to file"
            );
        }
    }

    #[test]
    fn tracing_filter_defaults_to_info_when_rust_log_unset() {
        assert_eq!(tracing_filter_directive(None), "info");
        assert_eq!(tracing_filter_directive(Some("")), "info");
        assert_eq!(tracing_filter_directive(Some("   ")), "info");
    }

    #[test]
    fn tracing_filter_prefers_rust_log_directive() {
        assert_eq!(
            tracing_filter_directive(Some("agent_relay::worker::pty=debug")),
            "agent_relay::worker::pty=debug"
        );
    }

    #[test]
    fn sanitize_filename_segment_replaces_unsafe_chars() {
        assert_eq!(
            sanitize_filename_segment("agent name/with:weird*chars"),
            "agent-name-with-weird-chars"
        );
    }

    #[test]
    fn sanitize_filename_segment_keeps_safe_chars() {
        assert_eq!(sanitize_filename_segment("alpha-Beta_01"), "alpha-Beta_01");
    }

    #[test]
    fn sanitize_filename_segment_falls_back_to_broker() {
        assert_eq!(sanitize_filename_segment(""), "broker");
        assert_eq!(sanitize_filename_segment("///"), "---");
    }

    #[test]
    fn log_file_path_uses_agentworkforce_logs_dir() {
        if let Some(path) = log_file_path("my-broker") {
            let path_str = path.to_string_lossy();
            assert!(
                path_str.contains(".agentworkforce/relay/logs/my-broker.log"),
                "unexpected log path: {path_str}"
            );
        }
    }
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
