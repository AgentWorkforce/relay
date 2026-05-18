//! Anonymous telemetry for the agent-relay broker.
//!
//! Collects lightweight, anonymous usage data and sends it to PostHog.
//! All operations are infallible — telemetry must never crash the broker.
//!
//! Opt-out:
//!   - Set `AGENT_RELAY_TELEMETRY_DISABLED=1` (or `true`)
//!   - Set `DO_NOT_TRACK=1` (cross-tool convention, https://consoledonottrack.com)
//!   - Or write `{"enabled": false}` to `~/.agent-relay/telemetry.json`

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

/// PostHog write key, baked in at compile time from the
/// `AGENT_RELAY_POSTHOG_KEY` env var. When unset (forks, local dev, CI tests),
/// this is `None` and telemetry is a no-op — no events queued, no HTTP calls.
/// Real releases inject the key from a GitHub Actions secret so shipped
/// binaries report to the production PostHog project.
const POSTHOG_API_KEY: Option<&str> = option_env!("AGENT_RELAY_POSTHOG_KEY");
const POSTHOG_HOST: &str = "https://us.i.posthog.com";

/// Returns the configured PostHog key iff it's non-empty. Empty strings are
/// treated the same as "unset" so an accidentally-blank secret doesn't trip
/// us into trying to talk to PostHog with an invalid key.
fn posthog_api_key() -> Option<&'static str> {
    POSTHOG_API_KEY.and_then(|k| if k.is_empty() { None } else { Some(k) })
}

const FIRST_RUN_NOTICE: &str = "\
Agent Relay collects anonymous usage data to improve the product.
Run `agent-relay telemetry disable` to opt out.";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Telemetry events emitted by the broker at key lifecycle points.
///
/// Schema aligns with the TypeScript definitions in
/// `packages/telemetry/src/events.ts` — when you add or change a field here,
/// update that file too so dashboards stay coherent across the CLI/broker
/// boundary.
pub enum TelemetryEvent {
    BrokerStart,
    BrokerStop {
        uptime_seconds: u64,
        agent_spawn_count: u32,
    },
    AgentSpawn {
        /// Which agent CLI was spawned (claude, codex, gemini, ...).
        cli: String,
        /// Internal runtime label (e.g. `"pty"`). Not in the TS schema but
        /// still useful for operational debugging.
        runtime: String,
        /// Where the spawn originated — matches TS `ActionSource`.
        spawn_source: ActionSource,
        /// Whether the spawner supplied an initial task string.
        has_task: bool,
        /// Whether this is a shadow agent (spawned with `shadow_of`/`shadow_mode`).
        is_shadow: bool,
    },
    AgentRelease {
        /// Which agent CLI was released (may be empty when unknown at the
        /// release site — relaycast-driven releases don't resolve the CLI
        /// from the worker name alone).
        cli: String,
        /// Broker-local category of the release reason (e.g. `"ws_command"`,
        /// `"relaycast_release"`). Retained for continuity with historical
        /// events; the product-level reason lives in `release_source`.
        release_reason: String,
        /// Wall-clock lifetime of the agent in seconds.
        lifetime_seconds: u64,
        /// Who initiated the release — matches TS `ActionSource`.
        release_source: ActionSource,
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

/// Mirror of the TypeScript `ActionSource` union. Serialized as snake_case
/// strings so PostHog dashboards can filter on string literals cleanly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionSource {
    HumanCli,
    HumanDashboard,
    Agent,
    Protocol,
}

impl ActionSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::HumanCli => "human_cli",
            Self::HumanDashboard => "human_dashboard",
            Self::Agent => "agent",
            Self::Protocol => "protocol",
        }
    }
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
            Self::AgentSpawn {
                cli,
                runtime,
                spawn_source,
                has_task,
                is_shadow,
            } => json!({
                "cli": cli,
                "runtime": runtime,
                "spawn_source": spawn_source.as_str(),
                "has_task": has_task,
                "is_shadow": is_shadow,
            }),
            Self::AgentRelease {
                cli,
                release_reason,
                lifetime_seconds,
                release_source,
            } => json!({
                "cli": cli,
                "release_reason": release_reason,
                "lifetime_seconds": lifetime_seconds,
                "release_source": release_source.as_str(),
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

/// Read an env var and return `Some(trimmed)` iff it's set and non-empty.
/// Never throws; caller uses the result to tag events, not to gate logic.
fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

/// Best-effort OS release string for telemetry tagging. Shells out to
/// `uname -r` on unix (broker is unix-only anyway); returns `None` on
/// failure so we just omit the property rather than risking a crash.
fn detect_os_version() -> Option<String> {
    let output = std::process::Command::new("uname")
        .arg("-r")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Canonical harness slug set — must stay aligned with the TS
/// `Harness` union in `packages/telemetry/src/harness.ts`
/// and the relaycast server-side enum (#132).
const KNOWN_HARNESSES: &[&str] = &[
    "claude-code",
    "cursor",
    "codex",
    "gemini",
    "aider",
    "cline",
    "continue",
    "windsurf",
    "zed",
    "unknown",
];

/// Map a process basename to a harness slug, or `None` for unrecognized.
/// Match is case-insensitive against the executable basename.
fn classify_harness_basename(basename: &str) -> Option<&'static str> {
    let lower = basename.trim().to_lowercase();
    // Strip Windows .exe suffix for portability with the TS classifier.
    let stripped = lower.strip_suffix(".exe").unwrap_or(&lower);
    match stripped {
        "claude" | "claude-code" => Some("claude-code"),
        "cursor" => Some("cursor"),
        "codex" => Some("codex"),
        "gemini" => Some("gemini"),
        "aider" => Some("aider"),
        "cline" => Some("cline"),
        "continue" => Some("continue"),
        "windsurf" => Some("windsurf"),
        "zed" => Some("zed"),
        _ => {
            // Catch helper-style names like "Cursor Helper", "Claude Helper".
            if stripped.starts_with("cursor ") {
                Some("cursor")
            } else if stripped.starts_with("claude ") {
                Some("claude-code")
            } else if stripped.starts_with("windsurf ") {
                Some("windsurf")
            } else {
                None
            }
        }
    }
}

/// Read the basename portion of a process command string.
fn command_basename(command: &str) -> String {
    let first = command.split_whitespace().next().unwrap_or("");
    let stripped = first.trim_matches(['"', '\''].as_ref());
    let last_sep = stripped.rfind(['/', '\\'].as_ref());
    match last_sep {
        Some(idx) => stripped[idx + 1..].to_string(),
        None => stripped.to_string(),
    }
}

/// Linux-only: read `/proc/<pid>/comm` and `/proc/<pid>/status`.
#[cfg(target_os = "linux")]
fn read_proc_info(pid: u32) -> Option<(String, u32)> {
    let comm = std::fs::read_to_string(format!("/proc/{}/comm", pid))
        .ok()?
        .trim()
        .to_string();
    let status = std::fs::read_to_string(format!("/proc/{}/status", pid)).ok()?;
    let ppid = status
        .lines()
        .find(|line| line.starts_with("PPid:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    Some((comm, ppid))
}

/// macOS: shell out to `ps -o ppid=,command= -p <pid>`. Cheap enough for
/// the small number of ancestor walks we do at startup.
#[cfg(target_os = "macos")]
fn read_proc_info(pid: u32) -> Option<(String, u32)> {
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=,command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8(output.stdout).ok()?.trim().to_string();
    let mut parts = line.splitn(2, char::is_whitespace);
    let ppid_str = parts.next()?.trim();
    let command = parts.next()?.trim().to_string();
    let ppid = ppid_str.parse::<u32>().ok()?;
    Some((command, ppid))
}

/// Fallback for platforms we don't implement (Windows, BSDs, etc.).
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_proc_info(_pid: u32) -> Option<(String, u32)> {
    None
}

/// Walk the parent process chain looking for a known harness basename.
/// Returns `"unknown"` on any failure or after exhausting the depth limit.
///
/// Resolution order:
///   1. `AGENT_RELAY_HARNESS` env var (set by the TS CLI before
///      spawning the broker — Option A in the issue).
///   2. Process-tree walk via platform-specific APIs (fallback for the SDK
///      case where user code spawns the broker directly).
///   3. `"unknown"` as the long-tail baseline.
fn detect_harness() -> String {
    // 1. Env-var hint set by a parent CLI — saves the broker from re-walking.
    if let Some(value) = env_nonempty("AGENT_RELAY_HARNESS") {
        let lower = value.to_lowercase();
        if KNOWN_HARNESSES.iter().any(|&h| h == lower) {
            return lower;
        }
        return "unknown".to_string();
    }

    // 2. Walk the parent chain — up to 10 hops.
    #[cfg(unix)]
    {
        let mut pid: u32 = unsafe { libc::getppid() } as u32;
        for _ in 0..10 {
            if pid <= 1 {
                break;
            }
            let Some((command, ppid)) = read_proc_info(pid) else {
                break;
            };
            let basename = command_basename(&command);
            if let Some(harness) = classify_harness_basename(&basename) {
                return harness.to_string();
            }
            if ppid == pid || ppid <= 1 {
                break;
            }
            pid = ppid;
        }
    }

    // 3. Fallback.
    "unknown".to_string()
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
    distinct_id: String,
    tx: Option<mpsc::UnboundedSender<PostHogCapture>>,
    /// CLI version read from `AGENT_RELAY_CLI_VERSION` when the broker is
    /// spawned by the CLI. Absent for standalone broker invocations.
    cli_version: Option<String>,
    /// SDK version read from `AGENT_RELAY_SDK_VERSION` when the broker is
    /// spawned by the CLI.
    sdk_version: Option<String>,
    /// OS release string (best-effort via `uname -r`, empty on failure /
    /// platforms where that isn't meaningful).
    os_version: Option<String>,
    /// Parent harness driving the broker (Claude Code, Cursor,
    /// Codex, etc.). Read from `AGENT_RELAY_HARNESS` if the
    /// CLI set it before spawning; otherwise detected via a parent-process
    /// walk. Always falls back to `"unknown"` so dashboards can size the
    /// long tail.
    harness: String,
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
    /// Build a fully-disabled client. Used for every no-op path (env opt-out,
    /// prefs-file opt-out, missing build-time PostHog key) so they all behave
    /// identically.
    fn disabled() -> Self {
        Self {
            enabled: false,
            distinct_id: String::new(),
            tx: None,
            cli_version: None,
            sdk_version: None,
            os_version: None,
            harness: "unknown".to_string(),
        }
    }

    /// Create a new telemetry client.
    ///
    /// Checks opt-out preferences, loads/generates an anonymous machine ID,
    /// and prints a first-run notice if this is the first invocation.
    pub fn new() -> Self {
        let enabled = Self::check_enabled();
        if !enabled {
            return Self::disabled();
        }

        // No build-time PostHog key (forks, local dev, CI). Behave exactly
        // like the user-opted-out path: no queue, no HTTP, no first-run
        // notice. A debug log is left as a breadcrumb for operators trying
        // to figure out why telemetry isn't reaching the dashboard.
        if posthog_api_key().is_none() {
            tracing::debug!(
                "telemetry: AGENT_RELAY_POSTHOG_KEY not set at build time; running as no-op"
            );
            return Self::disabled();
        }

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
            distinct_id,
            tx: Some(tx),
            cli_version: env_nonempty("AGENT_RELAY_CLI_VERSION"),
            sdk_version: env_nonempty("AGENT_RELAY_SDK_VERSION"),
            os_version: detect_os_version(),
            harness: detect_harness(),
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
        // Merge common properties. Version identification mirrors the
        // TypeScript `CommonProperties` shape so dashboards can filter on
        // `cli_version` / `sdk_version` / `broker_version` independent of
        // which component emitted the event. `agent_relay_version` is kept
        // as a back-compat alias that mirrors `broker_version` here.
        if let Some(obj) = props.as_object_mut() {
            let broker_version = env!("CARGO_PKG_VERSION");
            obj.insert("agent_relay_version".to_string(), json!(broker_version));
            obj.insert("broker_version".to_string(), json!(broker_version));
            if let Some(ref v) = self.cli_version {
                obj.insert("cli_version".to_string(), json!(v));
            }
            if let Some(ref v) = self.sdk_version {
                obj.insert("sdk_version".to_string(), json!(v));
            }
            obj.insert("os".to_string(), json!(std::env::consts::OS));
            if let Some(ref v) = self.os_version {
                obj.insert("os_version".to_string(), json!(v));
            }
            obj.insert("arch".to_string(), json!(std::env::consts::ARCH));
            obj.insert("harness".to_string(), json!(self.harness));
            obj.insert("surface".to_string(), json!("broker"));
        }

        // `posthog_api_key()` is guaranteed `Some` here — `TelemetryClient::new`
        // returns the disabled variant (which short-circuits above via the
        // `enabled` check) when the build-time key is absent. Fall back to an
        // empty string defensively rather than panicking if that invariant
        // ever changes.
        let api_key = posthog_api_key().unwrap_or("").to_string();
        let capture = PostHogCapture {
            api_key,
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
        // AGENT_RELAY_TELEMETRY_DISABLED is the product-specific switch;
        // DO_NOT_TRACK (https://consoledonottrack.com) is the cross-tool convention.
        for key in ["AGENT_RELAY_TELEMETRY_DISABLED", "DO_NOT_TRACK"] {
            if let Ok(val) = std::env::var(key) {
                if val == "1" || val.eq_ignore_ascii_case("true") {
                    return false;
                }
            }
        }
        // Prefs file opt-out.
        let prefs = load_prefs();
        if prefs.enabled == Some(false) {
            return false;
        }
        true
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
                spawn_source: ActionSource::HumanCli,
                has_task: true,
                is_shadow: false,
            },
            TelemetryEvent::AgentRelease {
                cli: "claude".into(),
                release_reason: "user".into(),
                lifetime_seconds: 30,
                release_source: ActionSource::HumanCli,
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
            distinct_id: String::new(),
            tx: None,
            cli_version: None,
            sdk_version: None,
            os_version: None,
            harness: "unknown".to_string(),
        };
        assert!(!client.is_enabled());
        client.track(TelemetryEvent::BrokerStart);
        client.shutdown();
        std::env::remove_var("AGENT_RELAY_TELEMETRY_DISABLED");
    }

    #[test]
    fn classify_harness_basename_recognizes_known_harnesses() {
        assert_eq!(classify_harness_basename("claude"), Some("claude-code"));
        assert_eq!(
            classify_harness_basename("claude-code"),
            Some("claude-code")
        );
        assert_eq!(classify_harness_basename("Claude"), Some("claude-code"));
        assert_eq!(classify_harness_basename("Cursor"), Some("cursor"));
        assert_eq!(classify_harness_basename("cursor.exe"), Some("cursor"));
        assert_eq!(classify_harness_basename("Cursor Helper"), Some("cursor"));
        assert_eq!(classify_harness_basename("codex"), Some("codex"));
        assert_eq!(classify_harness_basename("gemini"), Some("gemini"));
        assert_eq!(classify_harness_basename("zed"), Some("zed"));
        assert_eq!(classify_harness_basename("bash"), None);
        assert_eq!(classify_harness_basename("node"), None);
    }

    #[test]
    fn command_basename_strips_path_and_quotes() {
        assert_eq!(command_basename("/usr/bin/claude --foo"), "claude");
        assert_eq!(
            command_basename("\"/Applications/Claude.app/Claude\""),
            "Claude"
        );
        assert_eq!(command_basename("zed"), "zed");
        assert_eq!(command_basename(""), "");
    }

    #[test]
    fn detect_harness_respects_env_hint() {
        std::env::set_var("AGENT_RELAY_HARNESS", "claude-code");
        assert_eq!(detect_harness(), "claude-code");
        std::env::set_var("AGENT_RELAY_HARNESS", "garbage-value");
        assert_eq!(detect_harness(), "unknown");
        std::env::set_var("AGENT_RELAY_HARNESS", "CURSOR");
        // Case-insensitive normalization.
        assert_eq!(detect_harness(), "cursor");
        std::env::remove_var("AGENT_RELAY_HARNESS");
    }

    #[test]
    fn do_not_track_disables_telemetry() {
        // Clear both vars, set DO_NOT_TRACK, and verify check_enabled is false.
        std::env::remove_var("AGENT_RELAY_TELEMETRY_DISABLED");
        std::env::set_var("DO_NOT_TRACK", "1");
        assert!(!TelemetryClient::check_enabled());
        std::env::set_var("DO_NOT_TRACK", "true");
        assert!(!TelemetryClient::check_enabled());
        std::env::set_var("DO_NOT_TRACK", "0");
        // Value "0" is not truthy — prefs file / default wins. We only assert
        // that "0" does not itself force-disable; actual enabled state depends
        // on prefs, so just re-enable cleanup.
        std::env::remove_var("DO_NOT_TRACK");
    }

    #[test]
    fn action_source_serializes_to_snake_case_strings() {
        assert_eq!(ActionSource::HumanCli.as_str(), "human_cli");
        assert_eq!(ActionSource::HumanDashboard.as_str(), "human_dashboard");
        assert_eq!(ActionSource::Agent.as_str(), "agent");
        assert_eq!(ActionSource::Protocol.as_str(), "protocol");
    }

    #[test]
    fn agent_spawn_properties_include_new_fields() {
        let event = TelemetryEvent::AgentSpawn {
            cli: "claude".into(),
            runtime: "pty".into(),
            spawn_source: ActionSource::HumanDashboard,
            has_task: true,
            is_shadow: false,
        };
        let props = event.properties();
        assert_eq!(props["cli"], "claude");
        assert_eq!(props["runtime"], "pty");
        assert_eq!(props["spawn_source"], "human_dashboard");
        assert_eq!(props["has_task"], true);
        assert_eq!(props["is_shadow"], false);
    }

    #[test]
    fn agent_release_properties_include_release_source() {
        let event = TelemetryEvent::AgentRelease {
            cli: String::new(),
            release_reason: "relaycast_release".into(),
            lifetime_seconds: 42,
            release_source: ActionSource::Protocol,
        };
        let props = event.properties();
        assert_eq!(props["release_reason"], "relaycast_release");
        assert_eq!(props["release_source"], "protocol");
        assert_eq!(props["lifetime_seconds"], 42);
    }

    #[test]
    fn env_nonempty_handles_missing_empty_and_whitespace() {
        std::env::remove_var("AGENT_RELAY_TEST_TELEMETRY_MISSING");
        assert_eq!(env_nonempty("AGENT_RELAY_TEST_TELEMETRY_MISSING"), None);

        std::env::set_var("AGENT_RELAY_TEST_TELEMETRY_EMPTY", "");
        assert_eq!(env_nonempty("AGENT_RELAY_TEST_TELEMETRY_EMPTY"), None);

        std::env::set_var("AGENT_RELAY_TEST_TELEMETRY_WS", "   ");
        assert_eq!(env_nonempty("AGENT_RELAY_TEST_TELEMETRY_WS"), None);

        std::env::set_var("AGENT_RELAY_TEST_TELEMETRY_SET", "4.0.30");
        assert_eq!(
            env_nonempty("AGENT_RELAY_TEST_TELEMETRY_SET"),
            Some("4.0.30".to_string())
        );

        std::env::remove_var("AGENT_RELAY_TEST_TELEMETRY_EMPTY");
        std::env::remove_var("AGENT_RELAY_TEST_TELEMETRY_WS");
        std::env::remove_var("AGENT_RELAY_TEST_TELEMETRY_SET");
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

    #[test]
    fn posthog_api_key_treats_empty_as_unset() {
        // `posthog_api_key()` reads the build-time const, so we can't mutate
        // it from a test. What we can guarantee is the wrapper's contract:
        // a `Some("")` from `option_env!` must round-trip to `None` so the
        // disabled path takes over. Verify that contract on a synthetic
        // `Option<&str>` matching the same `and_then` shape.
        let synthetic: Option<&str> = Some("");
        let normalized = synthetic.and_then(|k| if k.is_empty() { None } else { Some(k) });
        assert!(normalized.is_none());

        let synthetic: Option<&str> = Some("phc_abc");
        let normalized = synthetic.and_then(|k| if k.is_empty() { None } else { Some(k) });
        assert_eq!(normalized, Some("phc_abc"));
    }
}
