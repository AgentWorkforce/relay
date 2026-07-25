//! Anonymous telemetry for the agent-relay broker.
//!
//! Collects lightweight, anonymous usage data and sends it to PostHog.
//! All operations are infallible — telemetry must never crash the broker.
//!
//! Opt-out:
//!   - Set `AGENT_RELAY_TELEMETRY_DISABLED=1` (or `true`)
//!   - Set `DO_NOT_TRACK=1` (cross-tool convention, https://consoledonottrack.com)
//!   - Or write `{"enabled": false}` to `~/.agentworkforce/relay/telemetry.json`
//!     (or `$AGENT_RELAY_DATA_DIR/telemetry.json` when that is set — the same
//!     file `agent-relay telemetry disable` writes)

use std::path::PathBuf;

use relaycast::sanitize_agent_relay_distinct_id;
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
const UNKNOWN_ORCHESTRATOR_HARNESS: &str = "unknown";
const ORCHESTRATOR_HARNESS_ENV: &str = "AGENT_RELAY_ORCHESTRATOR_HARNESS";

/// Returns the configured PostHog key iff it's non-empty. Empty strings are
/// treated the same as "unset" so an accidentally-blank secret doesn't trip
/// us into trying to talk to PostHog with an invalid key.
fn posthog_api_key() -> Option<&'static str> {
    POSTHOG_API_KEY.filter(|k| !k.is_empty())
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
/// `packages/cli/src/cli/telemetry/events.ts` — when you add or change a field here,
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
    /// The broker process itself panicked. Emitted synchronously from the
    /// panic hook (see [`install_panic_hook`]). PII-safe by construction — it
    /// carries only the compile-time source location, never the panic message.
    BrokerPanic {
        /// Source location of the panic as `file:line`.
        location: String,
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
    Agent,
    Protocol,
}

impl ActionSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::HumanCli => "human_cli",
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
            Self::BrokerPanic { .. } => "broker_panic",
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
            Self::BrokerPanic { location } => json!({
                "panic_location": location,
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
// Preferences file (~/.agentworkforce/relay/telemetry.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct TelemetryPrefs {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    notified_at: Option<String>,
}

/// Override for both the preference file and the machine-id file, matching the
/// TypeScript CLI (`telemetry/config.ts`, `telemetry/machine-id.ts`). When set,
/// `agent-relay telemetry disable` writes the opt-out there — so the broker has
/// to read it from the same place or it would ignore an explicit opt-out.
const DATA_DIR_ENV: &str = "AGENT_RELAY_DATA_DIR";

fn data_dir_override() -> Option<PathBuf> {
    env_nonempty(DATA_DIR_ENV).map(PathBuf::from)
}

/// Resolve a telemetry data file: the `AGENT_RELAY_DATA_DIR` override wins,
/// otherwise the platform default. Pure, so the precedence is testable without
/// mutating process-wide env from a parallel test.
fn data_file_path(
    override_dir: Option<PathBuf>,
    default_dir: Option<PathBuf>,
    file_name: &str,
) -> Option<PathBuf> {
    override_dir.or(default_dir).map(|dir| dir.join(file_name))
}

fn prefs_path() -> Option<PathBuf> {
    data_file_path(
        data_dir_override(),
        dirs::home_dir().map(|h| h.join(".agentworkforce/relay")),
        "telemetry.json",
    )
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
    // `AGENT_RELAY_DATA_DIR` wins, then ~/.local/share regardless of platform
    // (matches the spec and the Node.js SDK convention). Both halves mirror the
    // CLI's `getMachineIdPath()`, so the CLI and the broker derive the same id
    // from the same file instead of minting two ids for one machine.
    data_file_path(
        data_dir_override(),
        dirs::home_dir().map(|h| {
            h.join(".local")
                .join("share")
                .join("agentworkforce")
                .join("relay")
        }),
        "machine-id",
    )
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

fn sanitize_orchestrator_harness(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                ' ' | '.' | '_' | '-' | '/' | '(' | ')' | ':' | '=' | ';' | ',' | '+'
            )
    }) {
        return None;
    }
    Some(trimmed.chars().take(120).collect::<String>().to_lowercase())
}

/// Map a CLI command (e.g. `claude`, `codex`, `gemini`) to its canonical
/// harness id. Used for orchestrator detection and for per-worker origin_actor
/// attribution (the broker knows the CLI it spawns).
pub(crate) fn infer_harness_from_command(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    let normalized = lower.replace('\\', "/");
    let base = normalized
        .rsplit('/')
        .next()
        .unwrap_or(normalized.as_str())
        .trim_end_matches(".exe");
    let base = base
        .strip_suffix(".cmd")
        .or_else(|| base.strip_suffix(".bat"))
        .unwrap_or(base);

    if base == "claude" || lower.contains("claude-code") {
        return Some("claude-code");
    }
    if base == "codex" || normalized.contains("/codex") {
        return Some("codex");
    }
    if base == "cursor" || base == "cursor-agent" || lower.contains("cursor") {
        return Some("cursor");
    }
    if base == "gemini" || base == "gemini-cli" || lower.contains("gemini-cli") {
        return Some("gemini-cli");
    }
    if base == "aider" || lower.contains("aider") {
        return Some("aider");
    }
    if base == "opencode" || lower.contains("opencode") {
        return Some("opencode");
    }
    if base == "goose" || lower.contains("goose") {
        return Some("goose");
    }
    if base == "droid" || lower.contains("droid") {
        return Some("droid");
    }
    if base == "amp" || normalized.contains("/amp") {
        return Some("amp");
    }
    if lower.contains("copilot") {
        return Some("github-copilot");
    }
    if base == "zed" || lower.contains("zed") {
        return Some("zed");
    }

    None
}

#[cfg(unix)]
fn lookup_process_info(pid: i32) -> Option<(i32, String)> {
    if pid <= 0 {
        return None;
    }
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-o", "comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let mut parts = stdout.split_whitespace();
    let ppid = parts.next()?.parse::<i32>().ok()?;
    let command = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        None
    } else {
        Some((ppid, command))
    }
}

#[cfg(unix)]
fn detect_process_orchestrator_harness() -> Option<String> {
    use std::collections::HashSet;

    let mut pid = nix::unistd::getppid().as_raw();
    let mut seen = HashSet::new();

    for _ in 0..8 {
        if pid <= 0 || !seen.insert(pid) {
            break;
        }
        let Some((ppid, command)) = lookup_process_info(pid) else {
            break;
        };
        if let Some(harness) = infer_harness_from_command(&command) {
            return Some(harness.to_string());
        }
        if ppid == pid {
            break;
        }
        pid = ppid;
    }

    None
}

#[cfg(not(unix))]
fn detect_process_orchestrator_harness() -> Option<String> {
    None
}

fn detect_orchestrator_harness() -> String {
    for key in [
        ORCHESTRATOR_HARNESS_ENV,
        "RELAYCAST_HARNESS",
        "X_RELAYCAST_HARNESS",
    ] {
        if let Ok(value) = std::env::var(key) {
            if let Some(harness) = sanitize_orchestrator_harness(&value) {
                return harness;
            }
        }
    }

    detect_process_orchestrator_harness()
        .unwrap_or_else(|| UNKNOWN_ORCHESTRATOR_HARNESS.to_string())
}

/// Process-wide cached orchestrator harness: explicit env override, else
/// process-tree detection (claude-code / codex / cursor / …). Detection walks
/// the parent-process chain, so we resolve it once and reuse the result for
/// both our own PostHog events and the harness we forward to the relaycast
/// backend. Returns the [`UNKNOWN_ORCHESTRATOR_HARNESS`] sentinel when
/// undetectable.
pub(crate) fn orchestrator_harness() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(detect_orchestrator_harness)
}

/// Like [`orchestrator_harness`] but `None` instead of the `"unknown"`
/// sentinel, so callers can skip forwarding a non-informative value (the
/// relaycast backend already defaults a missing harness to `"unknown"`).
pub(crate) fn orchestrator_harness_opt() -> Option<&'static str> {
    let harness = orchestrator_harness();
    (harness != UNKNOWN_ORCHESTRATOR_HARNESS).then_some(harness)
}

/// `origin_actor` path for the broker's own relaycast traffic (the workspace
/// stream + agent registration the broker performs on behalf of the CLI). The
/// agent-relay CLI is the actor; spawned agents are attributed separately as
/// `agent-relay-cli/agent/<harness>`. See cloud/plans/origin-actor.md.
pub(crate) const BROKER_ORIGIN_ACTOR: &str = "agent-relay-cli/cli";

/// Env var carrying the anonymous distinct id, exported by the agent-relay CLI
/// so the broker and every spawned agent report as the same machine.
const AGENT_RELAY_DISTINCT_ID_ENV: &str = "AGENT_RELAY_DISTINCT_ID";

/// Anonymous machine id forwarded to relaycast as `X-Agent-Relay-Distinct-Id`,
/// or `None` when the user has opted out of telemetry.
///
/// Relaycast's server-side product events key on this when present (see the
/// engine's `emitServerEvent`), which is what lets a workspace-create or an
/// agent-registration be attributed back to an install. Without it every
/// broker-driven server event is keyed by workspace id alone, so "how many
/// distinct installs are using this" is unanswerable.
///
/// Prefer the CLI-exported env var so the CLI, the broker, and the agents it
/// spawns all report one id; fall back to the same hashed machine id the
/// telemetry client uses, for a broker started outside the CLI. This is the
/// same anonymous value already sent with the broker's own PostHog events —
/// never a hostname, account, or path. Resolved once per process.
pub(crate) fn agent_relay_distinct_id() -> Option<&'static str> {
    static CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            resolve_distinct_id(
                TelemetryClient::check_enabled(),
                env_nonempty(AGENT_RELAY_DISTINCT_ID_ENV),
                || load_or_create_machine_id().map(|id| anonymous_id(&id)),
            )
        })
        .as_deref()
}

/// Policy half of [`agent_relay_distinct_id`], split out so the opt-out
/// behaviour is testable without touching process-wide env or the cache.
/// `machine_id` is lazy: an opted-out broker must not even derive one.
///
/// The resolved value is sanitized against the SDK's wire contract before any
/// caller builds a header from it. The env var is caller-supplied, and an
/// invalid one (a newline, a non-ASCII character) would otherwise be handed to
/// `RequestBuilder::header`, which stores the conversion error and fails the
/// request on every retry — optional telemetry must never break connectivity.
fn resolve_distinct_id(
    enabled: bool,
    env_value: Option<String>,
    machine_id: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if !enabled {
        return None;
    }
    sanitize_agent_relay_distinct_id(env_value.or_else(machine_id))
}

/// Build the `origin_actor` path for a spawned agent:
/// `agent-relay-cli/agent/<harness>[@<model>]`. The model (when the broker knows
/// it from the spawn request) is appended so server telemetry can segment by
/// model; cloud parses a digit-less `@`-suffix as a model. See
/// cloud/plans/origin-actor.md.
pub(crate) fn agent_origin_actor(harness: &str, model: Option<&str>) -> String {
    match model.map(str::trim).filter(|m| !m.is_empty()) {
        Some(model) => format!("agent-relay-cli/agent/{harness}@{model}"),
        None => format!("agent-relay-cli/agent/{harness}"),
    }
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
    /// Harness or agent CLI that appears to be driving Agent Relay.
    orchestrator_harness: String,
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
            orchestrator_harness: UNKNOWN_ORCHESTRATOR_HARNESS.to_string(),
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
            orchestrator_harness: orchestrator_harness().to_string(),
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
        if let Some(obj) = props.as_object_mut() {
            obj.append(&mut self.common_properties());
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

    /// Common properties merged onto every event. Version identification
    /// mirrors the TypeScript `CommonProperties` shape so dashboards can filter
    /// on `cli_version` / `sdk_version` / `broker_version` independent of which
    /// component emitted the event. `agent_relay_version` is kept as a
    /// back-compat alias that mirrors `broker_version` here.
    fn common_properties(&self) -> serde_json::Map<String, Value> {
        let mut obj = serde_json::Map::new();
        let broker_version = crate::util::version::broker_version();
        obj.insert("app".to_string(), json!("broker"));
        obj.insert("surface".to_string(), json!("broker"));
        obj.insert(
            "orchestrator_harness".to_string(),
            json!(self.orchestrator_harness.as_str()),
        );
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
        obj
    }

    /// Build a [`PanicReporter`] snapshot for use in a `std::panic` hook, or
    /// `None` when telemetry is disabled (so callers install nothing). The
    /// snapshot owns everything needed to emit `broker_panic` synchronously,
    /// since the async sender loop and tokio runtime may already be gone by the
    /// time the process panics.
    pub fn panic_reporter(&self) -> Option<PanicReporter> {
        if !self.enabled {
            return None;
        }
        let api_key = posthog_api_key()?.to_string();
        Some(PanicReporter {
            api_key,
            distinct_id: self.distinct_id.clone(),
            common: self.common_properties(),
        })
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
// Panic reporting
// ---------------------------------------------------------------------------

/// Owned snapshot of everything needed to synchronously emit a `broker_panic`
/// event from a `std::panic` hook. Built via [`TelemetryClient::panic_reporter`]
/// while the client is alive, then captured by the panic hook closure so the
/// event can be sent even after the async sender loop has stopped.
pub struct PanicReporter {
    api_key: String,
    distinct_id: String,
    common: serde_json::Map<String, Value>,
}

impl PanicReporter {
    /// Synchronously emit a `broker_panic` event for the given source location.
    /// `location` is a sanitized compile-time `file:line` — never the panic
    /// message, which can contain user data.
    fn report(&self, location: &str) {
        // Serialize through the shared event contract so the event name and
        // payload can't drift from `TelemetryEvent`/the TypeScript schema.
        let event = TelemetryEvent::BrokerPanic {
            location: location.to_string(),
        };
        let mut props = event.properties();
        if let Some(obj) = props.as_object_mut() {
            for (key, value) in &self.common {
                obj.insert(key.clone(), value.clone());
            }
        }
        let capture = PostHogCapture {
            api_key: self.api_key.clone(),
            event: event.name().to_string(),
            distinct_id: self.distinct_id.clone(),
            properties: props,
        };
        send_capture_blocking(capture);
    }
}

/// Reduce a panic source path to a PII-safe form before it leaves the process.
///
/// `PanicHookInfo::location().file()` is the path as passed to rustc. First-party
/// workspace code compiles with repo-relative paths (`crates/broker/src/...`),
/// which are safe. A panic inside a dependency can instead carry an absolute
/// path such as `/home/<user>/.cargo/registry/.../src/lib.rs`, which embeds the
/// OS username. Strip a leading home-directory prefix (replacing it with `~`) so
/// no username leaks; if an absolute path remains outside the home dir, keep only
/// the file name so no machine-specific directory structure is reported.
fn sanitize_panic_file(file: &str, home: Option<&str>) -> String {
    if let Some(rest) = home
        .map(|h| h.trim_end_matches(['/', '\\']))
        .filter(|h| !h.is_empty())
        .and_then(|h| file.strip_prefix(h))
        // Require a path-component boundary after the home prefix so a sibling
        // dir like `/home/alice2` isn't mistaken for `/home/alice` (which would
        // leak the `2` — i.e. a different username).
        .filter(|rest| rest.is_empty() || rest.starts_with(['/', '\\']))
    {
        return format!("~{rest}");
    }
    if std::path::Path::new(file).is_absolute() {
        return std::path::Path::new(file)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
    }
    file.to_string()
}

/// Best-effort synchronous POST used only from the panic hook, where the shared
/// async sender loop can't be relied on. Runs on a freshly-spawned OS thread
/// with its own current-thread runtime so it's safe even when the panic
/// originated on a tokio worker thread (creating a runtime inside a runtime
/// thread would itself panic). The reqwest client timeout bounds how long the
/// thread — and therefore process teardown — can wait on the network.
fn send_capture_blocking(capture: PostHogCapture) {
    let handle = std::thread::Builder::new()
        .name("broker-panic-telemetry".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(_) => return,
            };
            runtime.block_on(async {
                let client = match reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(3))
                    .build()
                {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let url = format!("{}/capture/", POSTHOG_HOST);
                let _ = client.post(&url).json(&capture).send().await;
            });
        });
    // Wait for the send to finish (bounded by the reqwest timeout above) so the
    // event has a chance to leave the process before it unwinds or aborts.
    if let Ok(handle) = handle {
        let _ = handle.join();
    }
}

/// Install a process-global panic hook that emits a PII-safe `broker_panic`
/// telemetry event before delegating to the previously-installed hook (so the
/// default message/backtrace still prints). Call once during startup with the
/// reporter from [`TelemetryClient::panic_reporter`]; a no-op reporter isn't
/// built when telemetry is disabled, so callers simply skip installation then.
pub fn install_panic_hook(reporter: PanicReporter) {
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned());
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| {
                format!(
                    "{}:{}",
                    sanitize_panic_file(l.file(), home.as_deref()),
                    l.line()
                )
            })
            .unwrap_or_else(|| "unknown".to_string());
        // A panic inside the panic hook aborts the process, so guard the
        // telemetry send — a failed report must never mask the real panic.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reporter.report(&location);
        }));
        previous(info);
    }));
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
            TelemetryEvent::BrokerPanic {
                location: "crates/broker/src/wrap.rs:1862".into(),
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
    fn broker_panic_event_is_pii_safe() {
        let event = TelemetryEvent::BrokerPanic {
            location: "crates/broker/src/wrap.rs:42".into(),
        };
        assert_eq!(event.name(), "broker_panic");
        let props = event.properties();
        assert_eq!(
            props["panic_location"],
            json!("crates/broker/src/wrap.rs:42")
        );
        // Only the source location is carried — no message/payload key that
        // could leak user data.
        let obj = props.as_object().expect("object props");
        assert_eq!(obj.len(), 1, "unexpected extra props: {obj:?}");
    }

    #[test]
    fn sanitize_panic_file_keeps_relative_paths() {
        // First-party workspace code is already repo-relative — leave it intact.
        assert_eq!(
            sanitize_panic_file("crates/broker/src/telemetry.rs", Some("/home/alice")),
            "crates/broker/src/telemetry.rs"
        );
    }

    #[test]
    fn sanitize_panic_file_strips_home_prefix() {
        // A dependency panic under the home dir must not leak the username.
        assert_eq!(
            sanitize_panic_file(
                "/home/alice/.cargo/registry/src/index/tokio-1.0/src/lib.rs",
                Some("/home/alice")
            ),
            "~/.cargo/registry/src/index/tokio-1.0/src/lib.rs"
        );
    }

    #[test]
    fn sanitize_panic_file_requires_home_path_boundary() {
        // A sibling dir sharing the home string prefix must NOT be treated as
        // home (`/home/alice2` != `/home/alice`) — it would leak `alice2`.
        assert_eq!(
            sanitize_panic_file("/home/alice2/secret/lib.rs", Some("/home/alice")),
            "lib.rs"
        );
        // Exact home dir maps to `~`, trailing separators on home are ignored.
        assert_eq!(
            sanitize_panic_file("/home/alice/x/lib.rs", Some("/home/alice/")),
            "~/x/lib.rs"
        );
    }

    #[test]
    fn sanitize_panic_file_reduces_other_absolute_paths_to_basename() {
        // Absolute path outside the home dir (and no home known) → file name only.
        assert_eq!(
            sanitize_panic_file("/opt/build/secret-dir/src/lib.rs", None),
            "lib.rs"
        );
        assert_eq!(
            sanitize_panic_file("/opt/build/secret-dir/src/lib.rs", Some("/home/alice")),
            "lib.rs"
        );
    }

    #[test]
    fn disabled_client_reports_no_panic_reporter() {
        let client = TelemetryClient {
            enabled: false,
            distinct_id: String::new(),
            tx: None,
            cli_version: None,
            sdk_version: None,
            os_version: None,
            orchestrator_harness: UNKNOWN_ORCHESTRATOR_HARNESS.to_string(),
        };
        assert!(client.panic_reporter().is_none());
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
            orchestrator_harness: UNKNOWN_ORCHESTRATOR_HARNESS.to_string(),
        };
        assert!(!client.is_enabled());
        client.track(TelemetryEvent::BrokerStart);
        client.shutdown();
        std::env::remove_var("AGENT_RELAY_TELEMETRY_DISABLED");
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
        assert_eq!(ActionSource::Agent.as_str(), "agent");
        assert_eq!(ActionSource::Protocol.as_str(), "protocol");
    }

    #[test]
    fn agent_spawn_properties_include_new_fields() {
        let event = TelemetryEvent::AgentSpawn {
            cli: "claude".into(),
            runtime: "pty".into(),
            spawn_source: ActionSource::HumanCli,
            has_task: true,
            is_shadow: false,
        };
        let props = event.properties();
        assert_eq!(props["cli"], "claude");
        assert_eq!(props["runtime"], "pty");
        assert_eq!(props["spawn_source"], "human_cli");
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
    fn sanitize_orchestrator_harness_normalizes_safe_values() {
        assert_eq!(
            sanitize_orchestrator_harness("  Codex CLI  "),
            Some("codex cli".to_string())
        );
        assert_eq!(sanitize_orchestrator_harness("bad\nvalue"), None);
        assert_eq!(sanitize_orchestrator_harness(""), None);
    }

    #[test]
    fn resolve_distinct_id_is_none_when_telemetry_is_disabled() {
        // Opted out: neither the exported id nor a derived machine id may leak.
        let mut derived = false;
        let resolved = resolve_distinct_id(false, Some("abc123".to_string()), || {
            derived = true;
            Some("machine".to_string())
        });
        assert_eq!(resolved, None);
        assert!(!derived, "machine id must not be derived when opted out");
    }

    #[test]
    fn resolve_distinct_id_prefers_the_exported_env_value() {
        let resolved = resolve_distinct_id(true, Some("abc123".to_string()), || {
            Some("machine".to_string())
        });
        assert_eq!(resolved, Some("abc123".to_string()));
    }

    #[test]
    fn resolve_distinct_id_falls_back_to_the_machine_id() {
        let resolved = resolve_distinct_id(true, None, || Some("machine".to_string()));
        assert_eq!(resolved, Some("machine".to_string()));
        assert_eq!(resolve_distinct_id(true, None, || None), None);
    }

    #[test]
    fn resolve_distinct_id_drops_a_header_invalid_env_value() {
        // A caller-supplied value that can't be a header value must be dropped,
        // not forwarded — reqwest would store the conversion error and fail the
        // request on every retry. Matches the TS contract, which sends no header
        // at all rather than falling back when the env value is malformed.
        for bad in ["abc\ndef", "naïve", "has space"] {
            assert_eq!(
                resolve_distinct_id(true, Some(bad.to_string()), || Some("machine".to_string())),
                None,
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn data_file_path_prefers_the_configured_data_dir() {
        // `agent-relay telemetry disable` writes the opt-out to
        // AGENT_RELAY_DATA_DIR when set, so the broker must read it from there.
        assert_eq!(
            data_file_path(
                Some(PathBuf::from("/custom/dir")),
                Some(PathBuf::from("/home/u/.agentworkforce/relay")),
                "telemetry.json",
            ),
            Some(PathBuf::from("/custom/dir/telemetry.json"))
        );
    }

    #[test]
    fn data_file_path_falls_back_to_the_platform_default() {
        assert_eq!(
            data_file_path(
                None,
                Some(PathBuf::from("/home/u/.agentworkforce/relay")),
                "telemetry.json"
            ),
            Some(PathBuf::from(
                "/home/u/.agentworkforce/relay/telemetry.json"
            ))
        );
        assert_eq!(data_file_path(None, None, "telemetry.json"), None);
    }

    #[test]
    fn agent_origin_actor_appends_model_when_present() {
        assert_eq!(
            agent_origin_actor("codex", Some("gpt-5")),
            "agent-relay-cli/agent/codex@gpt-5"
        );
        assert_eq!(
            agent_origin_actor("claude-code", None),
            "agent-relay-cli/agent/claude-code"
        );
        // blank/whitespace model is treated as absent
        assert_eq!(
            agent_origin_actor("claude-code", Some("  ")),
            "agent-relay-cli/agent/claude-code"
        );
    }

    #[test]
    fn infer_harness_from_command_recognizes_known_parents() {
        assert_eq!(
            infer_harness_from_command("/usr/local/bin/codex"),
            Some("codex")
        );
        assert_eq!(
            infer_harness_from_command("/Applications/Cursor.app/Contents/MacOS/Cursor"),
            Some("cursor")
        );
        assert_eq!(
            infer_harness_from_command(r"C:\Users\will\AppData\Roaming\npm\gemini.cmd"),
            Some("gemini-cli")
        );
        assert_eq!(infer_harness_from_command("/usr/bin/zsh"), None);
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
        // `Option<&str>` matching the same `filter` shape.
        let synthetic: Option<&str> = Some("");
        let normalized = synthetic.filter(|k| !k.is_empty());
        assert!(normalized.is_none());

        let synthetic: Option<&str> = Some("phc_abc");
        let normalized = synthetic.filter(|k| !k.is_empty());
        assert_eq!(normalized, Some("phc_abc"));
    }
}
