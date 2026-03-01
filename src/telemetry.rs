//! Anonymous telemetry for the agent-relay broker.
//!
//! Collects lightweight, anonymous usage data and sends it to PostHog.
//! All operations are infallible — telemetry must never crash the broker.
//!
//! Opt-out:
//!   - Set `AGENT_RELAY_TELEMETRY_DISABLED=1` (or `true`)
//!   - Or write `{"enabled": false}` to `~/.agent-relay/telemetry.json`

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

const POSTHOG_API_KEY_BUILD: Option<&str> = option_env!("POSTHOG_API_KEY");
const POSTHOG_HOST: &str = "https://us.i.posthog.com";
const FIRST_RUN_NOTICE: &str = "\
Agent Relay collects anonymous usage data to improve the product.
Run `agent-relay telemetry disable` to opt out.";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Telemetry events emitted by the broker at key lifecycle points.
pub enum TelemetryEvent {
    BrokerStart,
    BrokerStop {
        uptime_seconds: u64,
        agent_spawn_count: u32,
    },
    AgentSpawn {
        cli: String,
        runtime: String,
    },
    AgentRelease {
        cli: String,
        release_reason: String,
        lifetime_seconds: u64,
    },
    AgentCrash {
        cli: String,
        exit_code: Option<i32>,
        lifetime_seconds: u64,
    },
    MessageSend {
        is_broadcast: bool,
        has_thread: bool,
    },
    CliCommandRun {
        command_name: String,
    },
}

impl TelemetryEvent {
    /// PostHog event name.
    fn name(&self) -> &'static str {
        match self {
            Self::BrokerStart => "broker_start",
            Self::BrokerStop { .. } => "broker_stop",
            Self::AgentSpawn { .. } => "agent_spawn",
            Self::AgentRelease { .. } => "agent_release",
            Self::AgentCrash { .. } => "agent_crash",
            Self::MessageSend { .. } => "message_send",
            Self::CliCommandRun { .. } => "cli_command_run",
        }
    }

    /// Event-specific properties merged into the PostHog payload.
    fn properties(&self) -> Value {
        match self {
            Self::BrokerStart => json!({}),
            Self::BrokerStop {
                uptime_seconds,
                agent_spawn_count,
            } => json!({
                "uptime_seconds": uptime_seconds,
                "agent_spawn_count": agent_spawn_count,
            }),
            Self::AgentSpawn { cli, runtime } => json!({
                "cli": cli,
                "runtime": runtime,
            }),
            Self::AgentRelease {
                cli,
                release_reason,
                lifetime_seconds,
            } => json!({
                "cli": cli,
                "release_reason": release_reason,
                "lifetime_seconds": lifetime_seconds,
            }),
            Self::AgentCrash {
                cli,
                exit_code,
                lifetime_seconds,
            } => json!({
                "cli": cli,
                "exit_code": exit_code,
                "lifetime_seconds": lifetime_seconds,
            }),
            Self::MessageSend {
                is_broadcast,
                has_thread,
            } => json!({
                "is_broadcast": is_broadcast,
                "has_thread": has_thread,
            }),
            Self::CliCommandRun { command_name } => json!({
                "command_name": command_name,
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Preferences file (~/.agent-relay/telemetry.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct TelemetryPrefs {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    notified_at: Option<String>,
}

fn prefs_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".agent-relay").join("telemetry.json"))
}

fn load_prefs() -> TelemetryPrefs {
    let Some(path) = prefs_path() else {
        return TelemetryPrefs::default();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_prefs(prefs: &TelemetryPrefs) {
    let Some(path) = prefs_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = serde_json::to_string_pretty(prefs)
        .ok()
        .and_then(|json| std::fs::write(&path, json).ok());
}

// ---------------------------------------------------------------------------
// Machine ID & anonymous distinct_id
// ---------------------------------------------------------------------------

fn machine_id_path() -> Option<PathBuf> {
    // Use ~/.local/share regardless of platform (matches the spec and
    // the Node.js SDK convention).
    dirs::home_dir().map(|h| {
        h.join(".local")
            .join("share")
            .join("agent-relay")
            .join("machine-id")
    })
}

fn load_or_create_machine_id() -> Option<String> {
    let path = machine_id_path()?;

    // Try to read existing ID.
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return Some(id);
        }
    }

    // Generate new ID: {hostname}-{random_hex}
    let host = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string());

    let random_hex: String = {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        (0..16)
            .map(|_| format!("{:02x}", rng.gen::<u8>()))
            .collect()
    };

    let id = format!("{}-{}", host, random_hex);

    // Save atomically (write to temp, rename).
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp_path = path.with_extension("tmp");
    if std::fs::write(&tmp_path, &id).is_ok() {
        let _ = std::fs::rename(&tmp_path, &path);
    }

    Some(id)
}

fn anonymous_id(machine_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(machine_id.as_bytes());
    let hash = hasher.finalize();
    hex::encode(&hash[..8]) // first 8 bytes = 16 hex chars
}

/// Tiny hex encoder (avoids adding the `hex` crate).
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}

// ---------------------------------------------------------------------------
// TelemetryClient
// ---------------------------------------------------------------------------

/// Fire-and-forget telemetry client.
///
/// Spawns a background task that batches and sends events to PostHog.
/// All public methods are synchronous and never block or fail.
pub struct TelemetryClient {
    enabled: bool,
    api_key: String,
    distinct_id: String,
    tx: Option<mpsc::UnboundedSender<PostHogCapture>>,
}

#[derive(Debug, Serialize)]
struct PostHogCapture {
    api_key: String,
    event: String,
    distinct_id: String,
    properties: Value,
}

impl Default for TelemetryClient {
    fn default() -> Self {
        Self::new()
    }
}

impl TelemetryClient {
    /// Create a new telemetry client.
    ///
    /// Checks opt-out preferences, loads/generates an anonymous machine ID,
    /// and prints a first-run notice if this is the first invocation.
    pub fn new() -> Self {
        let enabled = Self::check_enabled();
        if !enabled {
            return Self {
                enabled: false,
                api_key: String::new(),
                distinct_id: String::new(),
                tx: None,
            };
        }

        let Some(api_key) = Self::resolve_api_key() else {
            return Self {
                enabled: false,
                api_key: String::new(),
                distinct_id: String::new(),
                tx: None,
            };
        };

        let distinct_id = load_or_create_machine_id()
            .map(|id| anonymous_id(&id))
            .unwrap_or_else(|| "unknown".to_string());

        // First-run notice.
        let mut prefs = load_prefs();
        if prefs.notified_at.is_none() {
            eprintln!("{}", FIRST_RUN_NOTICE);
            prefs.notified_at = Some(chrono::Utc::now().to_rfc3339());
            save_prefs(&prefs);
        }

        // Background sender task.
        let (tx, rx) = mpsc::unbounded_channel::<PostHogCapture>();
        tokio::spawn(sender_loop(rx));

        Self {
            enabled: true,
            api_key,
            distinct_id,
            tx: Some(tx),
        }
    }

    /// Whether telemetry is enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Track an event. Fire-and-forget; never errors.
    pub fn track(&self, event: TelemetryEvent) {
        if !self.enabled {
            return;
        }
        let Some(tx) = &self.tx else {
            return;
        };

        let mut props = event.properties();
        // Merge common properties.
        if let Some(obj) = props.as_object_mut() {
            obj.insert(
                "agent_relay_version".to_string(),
                json!(env!("CARGO_PKG_VERSION")),
            );
            obj.insert("os".to_string(), json!(std::env::consts::OS));
            obj.insert("arch".to_string(), json!(std::env::consts::ARCH));
        }

        let capture = PostHogCapture {
            api_key: self.api_key.clone(),
            event: event.name().to_string(),
            distinct_id: self.distinct_id.clone(),
            properties: props,
        };

        // Send is non-blocking; ignore errors (channel closed = shutting down).
        let _ = tx.send(capture);
    }

    /// Flush pending events and shut down the background sender.
    ///
    /// Drops the channel so the sender loop finishes draining. This is
    /// best-effort; if the process exits before the HTTP calls complete
    /// the events are lost (acceptable for telemetry).
    pub fn shutdown(self) {
        // Dropping `tx` causes the sender loop to drain and exit.
        drop(self.tx);
    }

    // -- internal --

    fn check_enabled() -> bool {
        // Environment variable opt-out.
        if let Ok(val) = std::env::var("AGENT_RELAY_TELEMETRY_DISABLED") {
            if val == "1" || val.eq_ignore_ascii_case("true") {
                return false;
            }
        }
        // Prefs file opt-out.
        let prefs = load_prefs();
        if prefs.enabled == Some(false) {
            return false;
        }
        true
    }

    fn resolve_api_key() -> Option<String> {
        std::env::var("POSTHOG_API_KEY")
            .ok()
            .or_else(|| POSTHOG_API_KEY_BUILD.map(ToOwned::to_owned))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }
}

// ---------------------------------------------------------------------------
// Background sender
// ---------------------------------------------------------------------------

async fn sender_loop(mut rx: mpsc::UnboundedReceiver<PostHogCapture>) {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return, // cannot build HTTP client; silently give up
    };

    let url = format!("{}/capture/", POSTHOG_HOST);

    while let Some(capture) = rx.recv().await {
        // Fire-and-forget: send POST, ignore result.
        let _ = client.post(&url).json(&capture).send().await;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_id_is_deterministic_and_16_chars() {
        let id = anonymous_id("test-machine-abc123");
        assert_eq!(id.len(), 16);
        assert_eq!(id, anonymous_id("test-machine-abc123"));
    }

    #[test]
    fn anonymous_id_differs_for_different_input() {
        assert_ne!(anonymous_id("machine-a"), anonymous_id("machine-b"));
    }

    #[test]
    fn event_names_are_snake_case() {
        let events = vec![
            TelemetryEvent::BrokerStart,
            TelemetryEvent::BrokerStop {
                uptime_seconds: 60,
                agent_spawn_count: 2,
            },
            TelemetryEvent::AgentSpawn {
                cli: "claude".into(),
                runtime: "pty".into(),
            },
            TelemetryEvent::AgentRelease {
                cli: "claude".into(),
                release_reason: "user".into(),
                lifetime_seconds: 30,
            },
            TelemetryEvent::AgentCrash {
                cli: "claude".into(),
                exit_code: Some(1),
                lifetime_seconds: 10,
            },
            TelemetryEvent::MessageSend {
                is_broadcast: true,
                has_thread: false,
            },
            TelemetryEvent::CliCommandRun {
                command_name: "init".into(),
            },
        ];

        for event in events {
            let name = event.name();
            assert!(
                name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "event name '{}' is not snake_case",
                name
            );
        }
    }

    #[test]
    fn disabled_client_does_not_panic() {
        // Set env var to disable, then construct.
        std::env::set_var("AGENT_RELAY_TELEMETRY_DISABLED", "1");
        let client = TelemetryClient {
            enabled: false,
            api_key: String::new(),
            distinct_id: String::new(),
            tx: None,
        };
        assert!(!client.is_enabled());
        client.track(TelemetryEvent::BrokerStart);
        client.shutdown();
        std::env::remove_var("AGENT_RELAY_TELEMETRY_DISABLED");
    }

    #[test]
    fn prefs_default_is_enabled() {
        let prefs = TelemetryPrefs::default();
        // None means not explicitly disabled.
        assert_ne!(prefs.enabled, Some(false));
    }

    #[test]
    fn hex_encode_works() {
        assert_eq!(hex::encode(&[0xab, 0xcd, 0x01, 0xff]), "abcd01ff");
    }
}
