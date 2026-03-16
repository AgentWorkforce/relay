use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

mod helpers;
mod listen_api;
mod pty_worker;
mod routing;
mod spawner;
mod swarm;
mod swarm_tui;
mod wrap;

use helpers::{
    detect_bypass_permissions_prompt, detect_claude_trust_prompt, detect_codex_model_prompt,
    detect_gemini_action_required, detect_gemini_trust_prompt, detect_gemini_untrusted_banner,
    detect_opencode_permission_prompt, floor_char_boundary, is_auto_suggestion,
    is_bypass_selection_menu, is_in_editor_mode, normalize_cli_name, parse_cli_command, strip_ansi,
    TerminalQueryParser,
};
use listen_api::{broadcast_if_relevant, listen_api_router, ListenApiRequest};
use routing::display_target_for_dashboard;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use relaycast::WsEvent;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{broadcast, mpsc},
    time::{timeout, MissedTickBehavior},
};
use uuid::Uuid;

use relay_broker::{
    auth::AuthClient,
    control::{can_release_child, is_human_sender},
    dedup::DedupCache,
    message_bridge::{map_ws_broker_command, map_ws_event},
    multi_workspace::{MultiWorkspaceSession, WorkspaceInboundMessage, WorkspaceMembershipSummary},
    protocol::{
        AgentRuntime, AgentSpec, HeadlessProvider as ProtocolHeadlessProvider,
        MessageInjectionMode, ProtocolEnvelope, RelayDelivery, PROTOCOL_VERSION,
    },
    pty::PtySession,
    relaycast_ws::{
        format_worker_preregistration_error, registration_is_retryable,
        registration_retry_after_secs, retry_agent_registration, RegRetryOutcome,
        RelaycastHttpClient, WsControl,
    },
    replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY},
    snippets::{configure_relaycast_mcp_with_token, ensure_relaycast_mcp_config},
    telemetry::{TelemetryClient, TelemetryEvent},
    types::{BrokerCommandEvent, BrokerCommandPayload, InboundKind, SenderKind},
};

use spawner::{spawn_env_vars, terminate_child, Spawner};

const DEFAULT_DELIVERY_RETRY_MS: u64 = 1_000;
const MAX_DELIVERY_RETRIES: u32 = 10;
const DEFAULT_RELAYCAST_BASE_URL: &str = "https://api.relaycast.dev";
const DM_PARTICIPANT_CACHE_TTL: Duration = Duration::from_secs(30);
const THREAD_HISTORY_LIMIT: usize = 1_000;
const DEFAULT_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_HTTP_API_EVENT_EMIT_TIMEOUT_MS: u64 = 200;

#[derive(Debug, Parser)]
#[command(name = "agent-relay-broker")]
#[command(about = "Agent relay broker and worker runtime")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Init(InitCommand),
    Pty(PtyCommand),
    Headless(HeadlessCommand),
    /// Run ad-hoc swarm execution via the relay broker
    Swarm(swarm::SwarmArgs),
    /// Internal: wraps a CLI in a PTY with interactive passthrough.
    /// Used by the SDK — not for direct user invocation.
    /// Usage: agent-relay-broker wrap codex -- --full-auto
    #[command(hide = true)]
    Wrap {
        /// The CLI to wrap (e.g. "codex", "claude")
        cli: String,
        /// Additional arguments passed to the wrapped CLI
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

#[derive(Debug, clap::Args)]
struct InitCommand {
    #[arg(long, default_value = "")]
    name: String,

    #[arg(long, default_value = "general")]
    channels: String,

    /// Optional HTTP API port for dashboard proxy (0 = disabled)
    #[arg(long, default_value = "0")]
    api_port: u16,

    /// Enable persistence: write state, pending-deliveries, lock, PID, and MCP
    /// config to `.agent-relay/` in the working directory. When omitted (the
    /// default), runtime files are written to a deterministic temp directory and
    /// cleaned up opportunistically; identity registration is non-strict to avoid
    /// stale-name collisions across short-lived sessions.
    #[arg(long, default_value_t = false)]
    persist: bool,
}

#[derive(Debug, clap::Args, Clone)]
struct PtyCommand {
    cli: String,

    #[arg(last = true)]
    args: Vec<String>,

    #[arg(long)]
    agent_name: Option<String>,

    /// Emit delivery_active events when output matches progress patterns.
    #[arg(long)]
    progress: bool,

    /// Silence duration in seconds before emitting agent_idle (0 = disabled).
    #[arg(long, default_value = "30")]
    idle_threshold_secs: u64,
}

#[derive(Debug, clap::Args, Clone)]
struct HeadlessCommand {
    provider: HeadlessCliProvider,

    #[arg(last = true)]
    args: Vec<String>,

    #[arg(long)]
    agent_name: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum HeadlessCliProvider {
    Claude,
    Opencode,
}

impl From<HeadlessCliProvider> for ProtocolHeadlessProvider {
    fn from(value: HeadlessCliProvider) -> Self {
        match value {
            HeadlessCliProvider::Claude => Self::Claude,
            HeadlessCliProvider::Opencode => Self::Opencode,
        }
    }
}

fn headless_provider_cli_name(provider: &ProtocolHeadlessProvider) -> &'static str {
    match provider {
        ProtocolHeadlessProvider::Claude => "claude",
        ProtocolHeadlessProvider::Opencode => "opencode",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct BrokerState {
    agents: HashMap<String, PersistedAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedAgent {
    runtime: AgentRuntime,
    parent: Option<String>,
    channels: Vec<String>,
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    spec: Option<AgentSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restart_policy: Option<relay_broker::supervisor::RestartPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    initial_task: Option<String>,
}

#[derive(Debug)]
struct RuntimePaths {
    persist: bool,
    state: PathBuf,
    pending: PathBuf,
    pid: PathBuf,
    /// Held for process lifetime to prevent concurrent broker instances (persist mode only).
    #[allow(dead_code)]
    _lock: Option<std::fs::File>,
}

/// Shared Relaycast connection state used by run_init and run_wrap.
#[derive(Clone)]
struct RelayWorkspace {
    workspace_id: String,
    workspace_alias: Option<String>,
    relay_workspace_key: String,
    self_name: String,
    self_agent_id: String,
    self_names: HashSet<String>,
    self_agent_ids: HashSet<String>,
    http_client: RelaycastHttpClient,
    ws_control_tx: mpsc::Sender<WsControl>,
}

struct RelaySession {
    http_base: String,
    default_workspace_id: Option<String>,
    workspaces: Vec<RelayWorkspace>,
    ws_inbound_rx: mpsc::Receiver<WorkspaceInboundMessage>,
}

#[allow(dead_code)]
impl RelaySession {
    fn is_multi_workspace(&self) -> bool {
        self.workspaces.len() > 1
    }

    fn membership_summaries(&self) -> Vec<WorkspaceMembershipSummary> {
        self.workspaces
            .iter()
            .map(|workspace| WorkspaceMembershipSummary {
                workspace_id: workspace.workspace_id.clone(),
                workspace_alias: workspace.workspace_alias.clone(),
                is_default: self
                    .default_workspace_id
                    .as_deref()
                    .is_some_and(|workspace_id| workspace_id == workspace.workspace_id),
            })
            .collect()
    }

    fn default_workspace(&self) -> Option<&RelayWorkspace> {
        if let Some(default_workspace_id) = self.default_workspace_id.as_deref() {
            self.workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == default_workspace_id)
        } else if self.workspaces.len() == 1 {
            self.workspaces.first()
        } else {
            None
        }
    }

    fn workspace_by_selector(
        &self,
        workspace_id: Option<&str>,
        workspace_alias: Option<&str>,
    ) -> Result<&RelayWorkspace> {
        if let Some(workspace_id) = workspace_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return self
                .workspaces
                .iter()
                .find(|workspace| workspace.workspace_id == workspace_id)
                .with_context(|| format!("workspace '{}' is not attached", workspace_id));
        }

        if let Some(workspace_alias) = workspace_alias
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return self
                .workspaces
                .iter()
                .find(|workspace| {
                    workspace
                        .workspace_alias
                        .as_deref()
                        .is_some_and(|alias| alias.eq_ignore_ascii_case(workspace_alias))
                })
                .with_context(|| format!("workspace alias '{}' is not attached", workspace_alias));
        }

        self.default_workspace()
            .context("workspace selection is ambiguous; provide workspaceId or workspaceAlias")
    }
}

/// Build the standard env-var array passed to every spawned child agent.
fn normalize_initial_task(task: Option<String>) -> Option<String> {
    task.and_then(|value| {
        if value.trim().is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

struct RelaySessionOptions<'a> {
    paths: &'a RuntimePaths,
    requested_name: &'a str,
    channels: Vec<String>,
    strict_name: bool,
    agent_type: Option<&'a str>,
    /// Read .mcp.json for additional self-name identities
    read_mcp_identity: bool,
    /// Write relaycast server entry to .mcp.json
    ensure_mcp_config: bool,
    runtime_cwd: &'a Path,
}

async fn connect_relay(opts: RelaySessionOptions<'_>) -> Result<RelaySession> {
    let http_base = std::env::var("RELAYCAST_BASE_URL")
        .ok()
        .or_else(|| std::env::var("RELAY_BASE_URL").ok())
        .unwrap_or_else(|| DEFAULT_RELAYCAST_BASE_URL.to_string());
    let ws_base = std::env::var("RELAYCAST_WS_URL")
        .unwrap_or_else(|_| derive_ws_base_url_from_http(&http_base));

    let auth = AuthClient::new(http_base.clone());
    let sessions = auth
        .startup_session_set_with_options(
            Some(opts.requested_name),
            opts.strict_name,
            opts.agent_type,
        )
        .await
        .context("failed to initialize relaycast session")?;

    let default_session = sessions
        .default_session()
        .or_else(|| sessions.memberships.first())
        .context("no relaycast memberships were initialized")?;
    let relay_workspace_key = default_session.credentials.api_key.clone();
    let self_agent_id = default_session.credentials.agent_id.clone();
    let self_token = default_session.token.clone();
    let agent_name = default_session
        .credentials
        .agent_name
        .clone()
        .unwrap_or_else(|| opts.requested_name.to_string());

    let identity_debug = format!(
        "agent_name='{}'
requested='{}'
agent_id='{}'
token_prefix='{}'
default_workspace='{}'
workspace_count='{}'
timestamp='{}'
",
        agent_name,
        opts.requested_name,
        self_agent_id,
        &self_token[..self_token.len().min(16)],
        default_session.credentials.workspace_id,
        sessions.memberships.len(),
        chrono::Utc::now().to_rfc3339()
    );
    let debug_path = opts
        .paths
        .state
        .parent()
        .unwrap()
        .join("identity-debug.txt");
    if std::env::var("AGENT_RELAY_NO_DEBUG_FILES").is_err() {
        let _ = std::fs::write(&debug_path, &identity_debug);
        eprintln!(
            "[agent-relay] identity debug written to {}",
            debug_path.display()
        );
    }
    if agent_name != opts.requested_name {
        eprintln!(
            "[agent-relay] WARNING: registered as '{}' (requested '{}')",
            agent_name, opts.requested_name
        );
    }

    if opts.ensure_mcp_config {
        if let Err(error) = ensure_relaycast_mcp_config(
            opts.runtime_cwd,
            Some(relay_workspace_key.as_str()),
            Some(http_base.as_str()),
            None,
        ) {
            tracing::warn!("failed to ensure .mcp.json: {error}");
        }
    }

    let mut multi = MultiWorkspaceSession::new(
        http_base.clone(),
        ws_base,
        auth,
        sessions,
        opts.channels,
        opts.read_mcp_identity,
        opts.runtime_cwd,
        relay_broker::events::EventEmitter::new(false),
    );

    let default_workspace_id = multi.default_workspace_id.clone();
    let workspaces = multi
        .handles
        .drain(..)
        .map(|handle| RelayWorkspace {
            workspace_id: handle.workspace_id,
            workspace_alias: handle.workspace_alias,
            relay_workspace_key: handle.relay_workspace_key,
            self_name: handle.self_name,
            self_agent_id: handle.self_agent_id,
            self_names: handle.self_names,
            self_agent_ids: handle.self_agent_ids,
            http_client: handle.http_client,
            ws_control_tx: handle.ws_control_tx,
        })
        .collect();

    Ok(RelaySession {
        http_base,
        default_workspace_id,
        workspaces,
        ws_inbound_rx: multi.inbound_rx,
    })
}

#[derive(Debug)]
struct WorkerHandle {
    spec: AgentSpec,
    parent: Option<String>,
    workspace_id: Option<String>,
    child: Child,
    stdin: ChildStdin,
    spawned_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingDelivery {
    worker_name: String,
    delivery: RelayDelivery,
    attempts: u32,
    next_retry_at: Instant,
}

/// Serializable snapshot of pending deliveries for crash recovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedPendingDelivery {
    worker_name: String,
    delivery: RelayDelivery,
    attempts: u32,
}

fn save_pending_deliveries(
    path: &Path,
    deliveries: &HashMap<String, PendingDelivery>,
) -> Result<()> {
    let persisted: Vec<PersistedPendingDelivery> = deliveries
        .values()
        .map(|pd| PersistedPendingDelivery {
            worker_name: pd.worker_name.clone(),
            delivery: pd.delivery.clone(),
            attempts: pd.attempts,
        })
        .collect();
    let json = serde_json::to_string_pretty(&persisted)?;
    let dir = path.parent().unwrap_or(path);
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("failed creating temp file in {}", dir.display()))?;
    std::io::Write::write_all(&mut tmp, json.as_bytes())?;
    tmp.persist(path)
        .with_context(|| format!("failed persisting pending deliveries to {}", path.display()))?;
    Ok(())
}

fn load_pending_deliveries(path: &Path) -> HashMap<String, PendingDelivery> {
    let data = match std::fs::read_to_string(path) {
        Ok(d) => d,
        Err(_) => return HashMap::new(),
    };
    let persisted: Vec<PersistedPendingDelivery> = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    persisted
        .into_iter()
        .map(|p| {
            let id = p.delivery.delivery_id.clone();
            (
                id,
                PendingDelivery {
                    worker_name: p.worker_name,
                    delivery: p.delivery,
                    attempts: p.attempts,
                    next_retry_at: Instant::now(), // retry immediately on restart
                },
            )
        })
        .collect()
}

#[derive(Debug, Clone)]
enum WorkerEvent {
    Message { name: String, value: Value },
}

#[derive(Debug, Deserialize)]
struct SpawnPayload {
    agent: AgentSpec,
    #[serde(default)]
    initial_task: Option<String>,
    /// Silence duration in seconds before emitting agent_idle (0 = disabled).
    #[serde(default)]
    idle_threshold_secs: Option<u64>,
    /// Name of a previously released agent whose continuity context should be injected.
    #[serde(default)]
    continue_from: Option<String>,
    /// When true, skip injecting the relay MCP configuration into the spawned agent.
    /// Useful for minor tasks where relay messaging is not needed, saving tokens.
    #[serde(default)]
    skip_relay_prompt: bool,
}

#[derive(Debug, Deserialize)]
struct ReleasePayload {
    name: String,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SendMessagePayload {
    to: String,
    text: String,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    workspace_alias: Option<String>,
    #[serde(default)]
    priority: Option<u8>,
    #[serde(default)]
    mode: MessageInjectionMode,
}

#[derive(Debug, Deserialize)]
struct SendInputPayload {
    name: String,
    data: String,
}

#[derive(Debug, Deserialize)]
struct ResizePtyPayload {
    name: String,
    rows: u16,
    cols: u16,
}

#[derive(Debug, Deserialize)]
struct SetModelPayload {
    name: String,
    model: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GetMetricsPayload {
    #[serde(default)]
    agent: Option<String>,
}

#[derive(Debug, Serialize)]
struct AgentMetrics {
    name: String,
    pid: u32,
    memory_bytes: u64,
    uptime_secs: u64,
}

#[derive(Debug, Deserialize)]
struct DeliveryAckPayload {
    delivery_id: String,
    event_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ThreadInfo {
    thread_id: String,
    name: String,
    unread_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_message_at: Option<String>,
}

#[derive(Debug, Clone)]
struct ThreadAccumulator {
    info: ThreadInfo,
    sort_key: i64,
}

fn is_system_sender(sender: &str) -> bool {
    sender == "system" || sender == "human:orchestrator" || sender.starts_with("human:")
}

fn normalize_sender(sender: Option<String>) -> String {
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

fn sender_is_dashboard_label(sender: &str, self_name: &str) -> bool {
    let trimmed = sender.trim();
    trimmed.eq_ignore_ascii_case("Dashboard")
        || trimmed.eq_ignore_ascii_case("human:Dashboard")
        || trimmed.eq_ignore_ascii_case("human:orchestrator")
        || trimmed.eq_ignore_ascii_case(self_name)
}

struct WorkerRegistry {
    workers: HashMap<String, WorkerHandle>,
    event_tx: mpsc::Sender<WorkerEvent>,
    worker_env: Vec<(String, String)>,
    worker_logs_dir: PathBuf,
    initial_tasks: HashMap<String, String>,
    supervisor: relay_broker::supervisor::Supervisor,
    metrics: relay_broker::metrics::MetricsCollector,
}

impl WorkerRegistry {
    fn new(
        event_tx: mpsc::Sender<WorkerEvent>,
        worker_env: Vec<(String, String)>,
        worker_logs_dir: PathBuf,
        broker_start: Instant,
    ) -> Self {
        if let Err(error) = std::fs::create_dir_all(&worker_logs_dir) {
            tracing::warn!(
                path = %worker_logs_dir.display(),
                error = %error,
                "failed to create worker log directory"
            );
        }

        Self {
            workers: HashMap::new(),
            event_tx,
            worker_env,
            worker_logs_dir,
            initial_tasks: HashMap::new(),
            supervisor: relay_broker::supervisor::Supervisor::new(),
            metrics: relay_broker::metrics::MetricsCollector::new(broker_start),
        }
    }

    fn worker_log_path(&self, worker_name: &str) -> Option<PathBuf> {
        if worker_name.contains('/') || worker_name.contains('\\') || worker_name.contains('\0') {
            tracing::warn!(
                worker = %worker_name,
                "skipping worker log file creation due to invalid worker name"
            );
            return None;
        }
        Some(self.worker_logs_dir.join(format!("{worker_name}.log")))
    }

    fn list(&self) -> Vec<Value> {
        self.workers
            .iter()
            .map(|(name, handle)| {
                json!({
                    "name": name,
                    "runtime": handle.spec.runtime,
                    "provider": handle.spec.provider.clone(),
                    "cli": handle.spec.cli,
                    "model": handle.spec.model,
                    "team": handle.spec.team,
                    "channels": handle.spec.channels,
                    "parent": handle.parent,
                    "pid": handle.child.id(),
                })
            })
            .collect()
    }

    /// Look up an env-var value from the worker env list.
    fn env_value(&self, key: &str) -> Option<&str> {
        self.worker_env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn has_worker(&self, name: &str) -> bool {
        self.workers.contains_key(name)
    }

    fn worker_pid(&self, name: &str) -> Option<u32> {
        self.workers.get(name).and_then(|h| h.child.id())
    }

    async fn spawn(
        &mut self,
        spec: AgentSpec,
        parent: Option<String>,
        idle_threshold_secs: Option<u64>,
        worker_relay_api_key: Option<String>,
        skip_relay_prompt: bool,
        workspace_id: Option<String>,
    ) -> Result<()> {
        if self.workers.contains_key(&spec.name) {
            anyhow::bail!("agent '{}' already exists", spec.name);
        }

        tracing::info!(
            target = "broker::spawn",
            name = %spec.name,
            cli = ?spec.cli,
            runtime = ?spec.runtime,
            parent = ?parent,
            cwd = ?spec.cwd,
            "spawning worker"
        );

        let mut command =
            Command::new(std::env::current_exe().context("failed to locate current executable")?);

        match spec.runtime {
            AgentRuntime::Pty => {
                let cli = spec.cli.as_deref().context("pty runtime requires `cli`")?;
                let (resolved_cli, inline_cli_args) = parse_cli_command(cli)
                    .with_context(|| format!("invalid CLI command '{cli}'"))?;
                let normalized_cli = normalize_cli_name(&resolved_cli);
                let mut effective_args = inline_cli_args;
                effective_args.extend(spec.args.clone());

                command.arg("pty");
                command.arg("--agent-name").arg(&spec.name);
                if let Some(secs) = idle_threshold_secs {
                    command.arg("--idle-threshold-secs").arg(secs.to_string());
                }
                command.arg(&resolved_cli);

                // Auto-add bypass flags for CLIs that need them to run non-interactively.
                // Each CLI has its own flag; we only add it if the user didn't already.
                let cli_lower = normalized_cli.to_lowercase();
                let is_claude = cli_lower == "claude" || cli_lower.starts_with("claude:");
                let is_codex = cli_lower == "codex";

                let is_gemini = cli_lower == "gemini";
                let bypass_flag: Option<&str> = if is_claude
                    && !effective_args
                        .iter()
                        .any(|a| a.contains("dangerously-skip-permissions"))
                {
                    Some("--dangerously-skip-permissions")
                } else if is_codex
                    && !effective_args
                        .iter()
                        .any(|a| a.contains("dangerously-bypass") || a.contains("full-auto"))
                {
                    Some("--dangerously-bypass-approvals-and-sandbox")
                } else if is_gemini && !effective_args.iter().any(|a| a == "--yolo" || a == "-y") {
                    Some("--yolo")
                } else {
                    None
                };

                // Build MCP config args for CLIs that support dynamic MCP configuration.
                // When skip_relay_prompt is true, skip MCP config injection so the
                // spawned agent does not receive relay protocol context (saves tokens
                // for minor tasks where messaging is not needed).
                let mcp_args = if skip_relay_prompt {
                    vec![]
                } else {
                    let cwd = spec.cwd.as_deref().unwrap_or(".");
                    // Pass the original CLI name (e.g. "cursor") so cursor-specific
                    // MCP config logic is triggered. `resolved_cli` may differ
                    // (parse_cli_command maps "cursor" → "agent").
                    configure_relaycast_mcp_with_token(
                        cli,
                        &spec.name,
                        self.env_value("RELAY_API_KEY"),
                        self.env_value("RELAY_BASE_URL"),
                        &effective_args,
                        Path::new(cwd),
                        worker_relay_api_key.as_deref(),
                        self.env_value("RELAY_WORKSPACES_JSON"),
                        self.env_value("RELAY_DEFAULT_WORKSPACE"),
                    )
                    .await?
                };

                // Inject --model flag when spec.model is set and not already in args.
                let model_flag = spec.model.as_deref().and_then(|m| {
                    if m.is_empty()
                        || effective_args
                            .iter()
                            .any(|a| a == "--model" || a.starts_with("--model=") || a == "-m")
                    {
                        None
                    } else {
                        Some(m.to_string())
                    }
                });

                let has_extra = bypass_flag.is_some()
                    || model_flag.is_some()
                    || !effective_args.is_empty()
                    || !mcp_args.is_empty();
                if has_extra {
                    command.arg("--");
                    if let Some(flag) = bypass_flag {
                        command.arg(flag);
                    }
                    if let Some(ref model) = model_flag {
                        command.arg("--model");
                        command.arg(model);
                    }
                    for arg in &mcp_args {
                        command.arg(arg);
                    }
                    for arg in &effective_args {
                        command.arg(arg);
                    }
                }
            }
            AgentRuntime::Headless => {
                let provider = spec
                    .provider
                    .as_ref()
                    .context("headless runtime requires `provider`")?;
                command.arg("headless");
                command.arg("--agent-name").arg(&spec.name);
                command.arg(headless_provider_cli_name(provider));

                // Build MCP config for headless provider agents.
                let mcp_args = if skip_relay_prompt {
                    vec![]
                } else {
                    configure_relaycast_mcp_with_token(
                        headless_provider_cli_name(provider),
                        &spec.name,
                        self.env_value("RELAY_API_KEY"),
                        self.env_value("RELAY_BASE_URL"),
                        &spec.args,
                        Path::new(spec.cwd.as_deref().unwrap_or(".")),
                        worker_relay_api_key.as_deref(),
                        self.env_value("RELAY_WORKSPACES_JSON"),
                        self.env_value("RELAY_DEFAULT_WORKSPACE"),
                    )
                    .await?
                };

                if !spec.args.is_empty() || !mcp_args.is_empty() {
                    command.arg("--");
                    for arg in &mcp_args {
                        command.arg(arg);
                    }
                    for arg in &spec.args {
                        command.arg(arg);
                    }
                }
            }
        }

        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.worker_env {
            command.env(key, value);
        }
        if !skip_relay_prompt {
            if let Some(relay_key) = worker_relay_api_key {
                // Keep RELAY_API_KEY as the workspace key and pass the
                // pre-registered agent token separately for MCP servers that
                // support session bootstrap.
                command.env("RELAY_AGENT_TOKEN", relay_key);
            }
            command.env("RELAY_AGENT_NAME", &spec.name);
            command.env("RELAY_AGENT_TYPE", "agent");
            command.env("RELAY_STRICT_AGENT_NAME", "1");
        }
        // Remove CLAUDECODE env var to prevent "nested session" detection
        // when spawning Claude Code agents from within a Claude Code session.
        command.env_remove("CLAUDECODE");
        if let Some(cwd) = spec.cwd.as_ref() {
            command.current_dir(cwd);
        }

        let mut child = command.spawn().context("failed to spawn worker")?;
        let stdin = child.stdin.take().context("worker missing stdin pipe")?;
        let stdout = child.stdout.take().context("worker missing stdout pipe")?;
        let stderr = child.stderr.take().context("worker missing stderr pipe")?;
        let log_file = self.worker_log_path(&spec.name);

        spawn_worker_reader(
            self.event_tx.clone(),
            spec.name.clone(),
            "stdout",
            stdout,
            true,
            log_file.clone(),
        );
        spawn_worker_reader(
            self.event_tx.clone(),
            spec.name.clone(),
            "stderr",
            stderr,
            false,
            log_file,
        );

        let handle = WorkerHandle {
            spec: spec.clone(),
            parent,
            workspace_id,
            child,
            stdin,
            spawned_at: Instant::now(),
        };
        self.workers.insert(spec.name.clone(), handle);

        self.send_to_worker(
            &spec.name,
            "init_worker",
            None,
            json!({
                "agent": spec,
            }),
        )
        .await?;

        tracing::info!(
            target = "broker::spawn",
            name = %spec.name,
            "worker spawned and initialised"
        );

        Ok(())
    }

    async fn send_to_worker(
        &mut self,
        name: &str,
        msg_type: &str,
        request_id: Option<String>,
        payload: Value,
    ) -> Result<()> {
        let handle = self
            .workers
            .get_mut(name)
            .with_context(|| format!("unknown worker '{name}'"))?;

        let frame = ProtocolEnvelope {
            v: PROTOCOL_VERSION,
            msg_type: msg_type.to_string(),
            request_id,
            payload,
        };

        let encoded = serde_json::to_string(&frame)?;
        handle
            .stdin
            .write_all(encoded.as_bytes())
            .await
            .with_context(|| format!("failed writing frame to worker '{name}'"))?;
        handle
            .stdin
            .write_all(b"\n")
            .await
            .with_context(|| format!("failed writing newline to worker '{name}'"))?;
        handle
            .stdin
            .flush()
            .await
            .with_context(|| format!("failed flushing worker '{name}' stdin"))?;

        Ok(())
    }

    async fn deliver(&mut self, name: &str, delivery: RelayDelivery) -> Result<()> {
        tracing::debug!(
            target = "broker::deliver",
            worker = %name,
            from = %delivery.from,
            target = %delivery.target,
            event_id = %delivery.event_id,
            "delivering event to worker"
        );
        self.send_to_worker(name, "deliver_relay", None, serde_json::to_value(delivery)?)
            .await
    }

    async fn release(&mut self, name: &str) -> Result<()> {
        tracing::info!(target = "broker::release", name = %name, "releasing worker");
        self.initial_tasks.remove(name);
        let mut handle = self
            .workers
            .remove(name)
            .with_context(|| format!("unknown worker '{name}'"))?;

        let shutdown_frame = ProtocolEnvelope {
            v: PROTOCOL_VERSION,
            msg_type: "shutdown_worker".to_string(),
            request_id: None,
            payload: json!({"reason":"release","grace_ms":2000}),
        };
        let encoded = serde_json::to_string(&shutdown_frame)?;
        let _ = handle.stdin.write_all(encoded.as_bytes()).await;
        let _ = handle.stdin.write_all(b"\n").await;
        let _ = handle.stdin.flush().await;

        let result = terminate_child(&mut handle.child, Duration::from_secs(2)).await;
        match &result {
            Ok(()) => tracing::info!(target = "broker::release", name = %name, "worker released"),
            Err(error) => {
                tracing::warn!(target = "broker::release", name = %name, error = %error, "worker release failed")
            }
        }
        result
    }

    async fn shutdown_all(&mut self) -> Result<()> {
        let names: Vec<String> = self.workers.keys().cloned().collect();
        for name in names {
            if let Err(error) = self.release(&name).await {
                tracing::warn!(target = "agent_relay::broker", name = %name, error = %error, "worker shutdown failed");
            }
        }
        Ok(())
    }

    async fn reap_exited(&mut self) -> Result<Vec<(String, Option<i32>, Option<String>)>> {
        let names: Vec<String> = self.workers.keys().cloned().collect();
        let mut exited = Vec::new();
        for name in names {
            let (status, gone_via_kill0) = if let Some(handle) = self.workers.get_mut(&name) {
                match handle.child.try_wait() {
                    Ok(status) => {
                        // try_wait returned Ok — check if process is gone via kill(0)
                        // even when try_wait says None (still running).
                        if status.is_none() {
                            #[cfg(unix)]
                            {
                                if let Some(pid) = handle.child.id() {
                                    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
                                    if ret == -1 {
                                        let errno = std::io::Error::last_os_error()
                                            .raw_os_error()
                                            .unwrap_or(0);
                                        if errno == libc::ESRCH {
                                            tracing::info!(
                                                worker = %name,
                                                pid = pid,
                                                "reap_exited: kill(0) says ESRCH — process gone"
                                            );
                                            (None, true)
                                        } else {
                                            (None, false)
                                        }
                                    } else {
                                        (None, false)
                                    }
                                } else {
                                    // No PID available — process was already reaped
                                    (None, true)
                                }
                            }
                            #[cfg(not(unix))]
                            {
                                (status, false)
                            }
                        } else {
                            (status, false)
                        }
                    }
                    Err(e) => {
                        // ECHILD or similar — child already reaped elsewhere
                        tracing::info!(
                            worker = %name,
                            error = %e,
                            "reap_exited: try_wait error — treating as exited"
                        );
                        (None, true)
                    }
                }
            } else {
                (None, false)
            };
            if let Some(status) = status {
                let code = status.code();
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal().map(|s| s.to_string())
                };
                #[cfg(not(unix))]
                let signal: Option<String> = None;
                self.workers.remove(&name);
                self.initial_tasks.remove(&name);
                exited.push((name, code, signal));
            } else if gone_via_kill0 {
                // Process is gone but try_wait didn't report it.
                // Treat as exited with unknown exit code.
                self.workers.remove(&name);
                self.initial_tasks.remove(&name);
                exited.push((name, None, None));
            }
        }
        Ok(exited)
    }

    fn routing_workers(&self) -> Vec<routing::RoutingWorker<'_>> {
        self.workers
            .iter()
            .map(|(name, handle)| routing::RoutingWorker {
                name,
                channels: &handle.spec.channels,
                workspace_id: handle.workspace_id.as_deref(),
            })
            .collect()
    }

    fn worker_names_for_channel_delivery(
        &self,
        channel: &str,
        from: &str,
        workspace_id: Option<&str>,
    ) -> Vec<String> {
        let workers = self.routing_workers();
        routing::worker_names_for_channel_delivery(&workers, channel, from, workspace_id)
    }

    fn worker_names_for_direct_target(
        &self,
        target: &str,
        from: &str,
        workspace_id: Option<&str>,
    ) -> Vec<String> {
        let workers = self.routing_workers();
        routing::worker_names_for_direct_target(&workers, target, from, workspace_id)
    }

    fn has_any_worker(&self) -> bool {
        !self.workers.is_empty()
    }

    fn has_worker_by_name_ignoring_case(&self, target: &str) -> bool {
        let trimmed = target.trim();
        self.workers.iter().any(|(worker_name, _)| {
            trimmed.eq_ignore_ascii_case(worker_name)
                || trimmed.eq_ignore_ascii_case(&format!("@{}", worker_name))
        })
    }
}

fn spawn_worker_reader<R>(
    tx: mpsc::Sender<WorkerEvent>,
    name: String,
    stream_name: &'static str,
    reader: R,
    parse_json: bool,
    log_file_path: Option<PathBuf>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    async fn append_log_chunk(
        log_file: &mut Option<tokio::fs::File>,
        log_file_path: &Option<PathBuf>,
        disable_log_file: &mut bool,
        worker_name: &str,
        chunk: &str,
        append_newline_if_missing: bool,
    ) {
        if *disable_log_file {
            return;
        }
        let Some(file) = log_file.as_mut() else {
            return;
        };

        if let Err(error) = file.write_all(chunk.as_bytes()).await {
            if let Some(path) = log_file_path.as_ref() {
                tracing::warn!(
                    worker = %worker_name,
                    path = %path.display(),
                    error = %error,
                    "failed writing worker log chunk"
                );
            }
            *disable_log_file = true;
            *log_file = None;
            return;
        }

        if append_newline_if_missing && !chunk.ends_with('\n') {
            if let Err(error) = file.write_all(b"\n").await {
                if let Some(path) = log_file_path.as_ref() {
                    tracing::warn!(
                        worker = %worker_name,
                        path = %path.display(),
                        error = %error,
                        "failed writing newline to worker log"
                    );
                }
                *disable_log_file = true;
                *log_file = None;
            }
        }
    }

    tokio::spawn(async move {
        let mut log_file = match log_file_path.as_ref() {
            Some(path) => match tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .await
            {
                Ok(file) => Some(file),
                Err(error) => {
                    tracing::warn!(
                        worker = %name,
                        path = %path.display(),
                        error = %error,
                        "failed to open worker log file"
                    );
                    None
                }
            },
            None => None,
        };

        let mut disable_log_file = false;

        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if parse_json {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if value
                        .get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|msg_type| msg_type == "worker_stream")
                    {
                        if let Some(chunk) = value
                            .get("payload")
                            .and_then(|payload| payload.get("chunk"))
                            .and_then(Value::as_str)
                        {
                            append_log_chunk(
                                &mut log_file,
                                &log_file_path,
                                &mut disable_log_file,
                                &name,
                                chunk,
                                false,
                            )
                            .await;
                        }
                    }
                    if tx
                        .send(WorkerEvent::Message {
                            name: name.clone(),
                            value,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }
            }

            append_log_chunk(
                &mut log_file,
                &log_file_path,
                &mut disable_log_file,
                &name,
                &line,
                true,
            )
            .await;

            let fallback = json!({
                "v": PROTOCOL_VERSION,
                "type": "worker_stream",
                "payload": {
                    "stream": stream_name,
                    "chunk": line,
                }
            });

            if tx
                .send(WorkerEvent::Message {
                    name: name.clone(),
                    value: fallback,
                })
                .await
                .is_err()
            {
                break;
            }
        }
    });
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cli = Cli::parse();
    let telemetry = TelemetryClient::new();

    let command_name = match &cli.command {
        Commands::Init(_) => "init",
        Commands::Pty(_) => "pty",
        Commands::Headless(_) => "headless",
        Commands::Swarm(_) => "swarm",
        Commands::Wrap { .. } => "wrap",
    };
    telemetry.track(TelemetryEvent::CliCommandRun {
        command_name: command_name.to_string(),
    });

    match cli.command {
        Commands::Init(cmd) => run_init(cmd, telemetry).await,
        Commands::Pty(cmd) => pty_worker::run_pty_worker(cmd).await,
        Commands::Headless(cmd) => run_headless_worker(cmd).await,
        Commands::Swarm(args) => swarm::run_swarm(args).await,
        Commands::Wrap { cli, args } => wrap::run_wrap(cli, args, false, telemetry).await,
    }
}

async fn run_init(cmd: InitCommand, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let mut agent_spawn_count: u32 = 0;
    telemetry.track(TelemetryEvent::BrokerStart);

    let runtime_cwd = std::env::current_dir()?;
    let resolved_name = if cmd.name.trim().is_empty() {
        runtime_cwd
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("project")
            .to_string()
    } else {
        cmd.name.trim().to_string()
    };
    let paths = if cmd.persist {
        ensure_runtime_paths(&runtime_cwd, &resolved_name)?
    } else {
        // Warn if a stale .agent-relay/ dir exists from a previous persist run.
        // Agents can read files from it directly (logs, state) and get confused.
        let stale_dir = runtime_cwd.join(".agent-relay");
        if stale_dir.exists() {
            eprintln!(
                "[agent-relay] WARNING: stale .agent-relay/ directory found in {}",
                runtime_cwd.display()
            );
            eprintln!(
                "[agent-relay] WARNING: remove it to avoid confusing spawned agents: rm -rf {}",
                stale_dir.display()
            );
        }
        ensure_ephemeral_paths(&runtime_cwd, &resolved_name)?
    };
    let mut state = if cmd.persist {
        BrokerState::load(&paths.state).unwrap_or_default()
    } else {
        BrokerState::default()
    };

    // Clean up agents from previous sessions whose processes have died
    let reaped = state.reap_dead_agents();
    if !reaped.is_empty() {
        tracing::info!(
            agents = ?reaped,
            "reaped {} dead agent(s) from previous session",
            reaped.len()
        );
        if paths.persist {
            if let Err(error) = state.save(&paths.state) {
                tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state after reaping dead agents");
            }
        }
    }

    if std::env::var("AGENT_RELAY_DISABLE_RELAYCAST").is_ok() {
        anyhow::bail!(
            "AGENT_RELAY_DISABLE_RELAYCAST is no longer supported; broker requires Relaycast"
        );
    }

    // Use RELAY_AGENT_TYPE env var if set (e.g. "agent" for SDK-spawned brokers),
    // otherwise default to "human" for interactive CLI usage.
    let agent_type_env = std::env::var("RELAY_AGENT_TYPE").ok();
    let agent_type_ref = agent_type_env.as_deref().unwrap_or("human");

    let relay = connect_relay(RelaySessionOptions {
        paths: &paths,
        requested_name: &resolved_name,
        channels: channels_from_csv(&cmd.channels),
        // Ephemeral brokers are short-lived and frequently restarted by tests/SDK
        // callers. Use non-strict registration so stale Relaycast identities from
        // prior runs don't hard-fail startup.
        strict_name: cmd.persist,
        agent_type: Some(agent_type_ref),
        read_mcp_identity: true,
        ensure_mcp_config: cmd.persist,
        runtime_cwd: &runtime_cwd,
    })
    .await?;

    let RelaySession {
        http_base,
        default_workspace_id,
        workspaces,
        mut ws_inbound_rx,
    } = relay;
    let workspace_lookup: HashMap<String, RelayWorkspace> = workspaces
        .iter()
        .cloned()
        .map(|workspace| (workspace.workspace_id.clone(), workspace))
        .collect();
    let default_workspace = if let Some(default_workspace_id) = default_workspace_id.as_deref() {
        workspaces
            .iter()
            .find(|workspace| workspace.workspace_id == default_workspace_id)
            .or_else(|| workspaces.first())
    } else {
        workspaces.first()
    }
    .cloned()
    .context("no relay workspace was available after initialization")?;
    let relay_workspace_key = default_workspace.relay_workspace_key.clone();
    let self_names = default_workspace.self_names.clone();
    let ws_control_tx = default_workspace.ws_control_tx.clone();
    let relaycast_http = default_workspace.http_client.clone();
    let workspace_memberships: Vec<WorkspaceMembershipSummary> = workspaces
        .iter()
        .map(|workspace| WorkspaceMembershipSummary {
            workspace_id: workspace.workspace_id.clone(),
            workspace_alias: workspace.workspace_alias.clone(),
            is_default: default_workspace_id
                .as_deref()
                .is_some_and(|workspace_id| workspace_id == workspace.workspace_id),
        })
        .collect();
    let relay_workspaces_json = serde_json::to_string(
        &workspaces
            .iter()
            .map(|workspace| {
                serde_json::json!({
                    "workspace_id": workspace.workspace_id,
                    "workspace_alias": workspace.workspace_alias,
                    "api_key": workspace.relay_workspace_key,
                })
            })
            .collect::<Vec<_>>(),
    )?;

    for workspace in &workspaces {
        if let Err(error) = workspace.http_client.ensure_default_channels().await {
            tracing::warn!(workspace_id = %workspace.workspace_id, error = %error, "failed to ensure default channels");
        }
    }

    let extra_channels = channels_from_csv(&cmd.channels);
    for workspace in &workspaces {
        if let Err(error) = workspace
            .http_client
            .ensure_extra_channels(&extra_channels)
            .await
        {
            tracing::warn!(workspace_id = %workspace.workspace_id, error = %error, "failed to ensure extra channels");
        }
    }

    if !extra_channels.is_empty() {
        for workspace in &workspaces {
            let _ = workspace
                .ws_control_tx
                .send(WsControl::Subscribe(extra_channels.clone()))
                .await;
        }
    }

    let mut worker_env = vec![
        ("RELAY_BASE_URL".to_string(), http_base.clone()),
        ("RELAY_API_KEY".to_string(), relay_workspace_key.clone()),
        (
            "RELAY_WORKSPACES_JSON".to_string(),
            relay_workspaces_json.clone(),
        ),
    ];
    if let Some(default_workspace_id) = default_workspace_id.clone() {
        worker_env.push((
            "RELAY_DEFAULT_WORKSPACE".to_string(),
            default_workspace_id.clone(),
        ));
        worker_env.push(("RELAY_WORKSPACE_ID".to_string(), default_workspace_id));
    }

    // Broadcast channel for streaming dashboard-relevant events to WS clients.
    // Created early so the stdout writer task can also broadcast events.
    let (events_tx, _events_rx) = broadcast::channel::<String>(512);
    let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);

    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(1024);
    let events_tx_for_stdout = events_tx.clone();
    let replay_buffer_for_stdout = replay_buffer.clone();
    tokio::spawn(async move {
        while let Some(frame) = sdk_out_rx.recv().await {
            // Broadcast dashboard-relevant events to WS clients
            if frame.msg_type == "event" {
                broadcast_if_relevant(
                    &events_tx_for_stdout,
                    &replay_buffer_for_stdout,
                    &frame.payload,
                )
                .await;
            }
            if let Ok(line) = serde_json::to_string(&frame) {
                use std::io::Write;
                let mut stdout = std::io::stdout().lock();
                let _ = stdout.write_all(line.as_bytes());
                let _ = stdout.write_all(b"\n");
                let _ = stdout.flush();
            }
        }
    });

    let (worker_event_tx, mut worker_event_rx) = mpsc::channel::<WorkerEvent>(1024);
    let worker_logs_dir = paths
        .state
        .parent()
        .expect("state path should always have a parent")
        .join("team")
        .join("worker-logs");
    let mut workers =
        WorkerRegistry::new(worker_event_tx, worker_env, worker_logs_dir, broker_start);

    // Load crash insights from previous session
    let crash_insights_path = paths.state.parent().unwrap().join("crash-insights.json");
    let mut crash_insights =
        relay_broker::crash_insights::CrashInsights::load(&crash_insights_path);

    let mut sdk_lines = BufReader::new(tokio::io::stdin()).lines();
    let mut reap_tick = tokio::time::interval(Duration::from_millis(500));
    reap_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut dedup = DedupCache::new(Duration::from_secs(300), 8192);
    let delivery_retry_interval = delivery_retry_interval();
    let mut pending_deliveries = load_pending_deliveries(&paths.pending);
    let mut terminal_failed_deliveries: HashSet<String> = HashSet::new();
    let mut dm_participants_cache: HashMap<String, (Instant, Vec<String>)> = HashMap::new();
    let mut recent_thread_messages: VecDeque<Value> = VecDeque::new();
    if !pending_deliveries.is_empty() {
        tracing::info!(
            count = pending_deliveries.len(),
            "loaded {} pending deliveries from previous session",
            pending_deliveries.len()
        );
    }

    let mut shutdown = false;

    // Optional HTTP API (for dashboard proxy)
    let (api_tx, mut api_rx) = if cmd.api_port > 0 {
        let (tx, rx) = mpsc::channel::<ListenApiRequest>(32);
        let router = listen_api_router(
            tx.clone(),
            events_tx.clone(),
            replay_buffer.clone(),
            Some(relay_workspace_key.clone()),
            workspace_memberships.clone(),
            default_workspace_id.clone(),
        );
        let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", cmd.api_port))
            .await
            .with_context(|| format!("failed to bind API on port {}", cmd.api_port))?;
        eprintln!(
            "[agent-relay] API listening on http://127.0.0.1:{}",
            cmd.api_port
        );
        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router).await {
                tracing::error!(error = %e, "HTTP API server error");
            }
        });
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    // Suppress unused-variable warning when api_tx is created but only used for its lifetime
    let _ = &api_tx;

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;

    while !shutdown {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                shutdown = true;
            }

            _ = sigterm.recv() => {
                tracing::info!("received SIGTERM, shutting down");
                shutdown = true;
            }

            // HTTP API requests (when --api-port is active)
            result = async { api_rx.as_mut().unwrap().recv().await }, if api_rx.is_some() => {
                if let Some(req) = result {
                    match req {
                        ListenApiRequest::Spawn {
                            name,
                            cli,
                            model,
                            args,
                            task,
                            channels,
                            cwd,
                            team,
                            shadow_of,
                            shadow_mode,
                            continue_from,
                            reply,
                        } => {
                            let effective_channels = if channels.is_empty() {
                                default_spawn_channels()
                            } else {
                                channels.clone()
                            };
                            let spec = AgentSpec {
                                name: name.clone(),
                                runtime: AgentRuntime::Pty,
                                provider: None,
                                cli: Some(cli.clone()),
                                model: model.clone(),
                                cwd,
                                team,
                                shadow_of,
                                shadow_mode,
                                args,
                                channels: effective_channels.clone(),
                                restart_policy: None,
                            };
                            let spec_for_state = spec.clone();
                            let mut preregistration_warning: Option<String> = None;
                            let registration_result = retry_agent_registration(
                                &relaycast_http, &name, Some(&cli),
                            ).await;
                            let worker_relay_key = match registration_result {
                                Ok(token) => Some(token),
                                Err(RegRetryOutcome::RetryableExhausted(error)) => {
                                    let message = format_worker_preregistration_error(&name, &error);
                                    tracing::warn!(
                                        worker = %name,
                                        error = %error,
                                        "continuing spawn without pre-registration after retries exhausted"
                                    );
                                    preregistration_warning = Some(message);
                                    None
                                }
                                Err(RegRetryOutcome::Fatal(error)) => {
                                    let _ = reply.send(Err(format_worker_preregistration_error(&name, &error)));
                                    continue;
                                }
                            };

                            let mut effective_task = normalize_initial_task(task);
                            if let Some(ref continue_from) = continue_from {
                                let continuity_dir = continuity_dir(&paths.state);
                                let continuity_file = continuity_dir.join(format!("{}.json", continue_from));
                                if continuity_file.exists() {
                                    match std::fs::read_to_string(&continuity_file) {
                                        Ok(contents) => {
                                            if let Ok(ctx) = serde_json::from_str::<Value>(&contents) {
                                                let prev_task = ctx
                                                    .get("initial_task")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("unknown");
                                                let summary = ctx
                                                    .get("summary")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("no summary available");
                                                let messages = ctx
                                                    .get("message_history")
                                                    .and_then(Value::as_array)
                                                    .map(|msgs| {
                                                        msgs.iter()
                                                            .filter_map(|m| {
                                                                let from = m
                                                                    .get("from")
                                                                    .and_then(Value::as_str)
                                                                    .unwrap_or("?");
                                                                let text = m
                                                                    .get("text")
                                                                    .and_then(Value::as_str)
                                                                    .unwrap_or("");
                                                                if text.is_empty() {
                                                                    None
                                                                } else {
                                                                    Some(format!("  {}: {}", from, text))
                                                                }
                                                            })
                                                            .collect::<Vec<_>>()
                                                            .join("\n")
                                                    })
                                                    .unwrap_or_default();

                                                let continuity_block = format!(
                                                    "## Continuity Context (from previous session as '{}')\n\
                                                     Previous task: {}\n\
                                                     Session summary: {}\n{}",
                                                    continue_from,
                                                    prev_task,
                                                    summary,
                                                    if messages.is_empty() {
                                                        String::new()
                                                    } else {
                                                        format!("Recent messages:\n{}\n", messages)
                                                    }
                                                );

                                                effective_task = Some(match effective_task {
                                                    Some(new_task) => {
                                                        format!(
                                                            "{}\n\n## Current Task\n{}",
                                                            continuity_block, new_task
                                                        )
                                                    }
                                                    None => continuity_block,
                                                });
                                                tracing::info!(
                                                    agent = %name,
                                                    continue_from = %continue_from,
                                                    "injected continuity context from previous session for HTTP API spawn"
                                                );
                                            }
                                        }
                                        Err(e) => {
                                            tracing::warn!(
                                                agent = %name,
                                                continue_from = %continue_from,
                                                error = %e,
                                                "failed to read continuity file for HTTP API spawn"
                                            );
                                        }
                                    }
                                } else {
                                    tracing::warn!(
                                        agent = %name,
                                        continue_from = %continue_from,
                                        "no continuity file found at {}",
                                        continuity_file.display()
                                    );
                                }
                            }

                            match workers.spawn(
                                spec,
                                Some("Dashboard".to_string()),
                                None,
                                worker_relay_key.clone(),
                                false,
                                None,
                            ).await {
                                Ok(()) => {
                                    if let Some(ref task_text) = effective_task {
                                        workers.initial_tasks.insert(name.clone(), task_text.clone());
                                    }
                                    agent_spawn_count += 1;
                                    telemetry.track(TelemetryEvent::AgentSpawn {
                                        cli: cli.clone(),
                                        runtime: "pty".to_string(),
                                    });
                                    let pid = workers.worker_pid(&name).unwrap_or(0);
                                    state.agents.insert(
                                        name.clone(),
                                        PersistedAgent {
                                            runtime: AgentRuntime::Pty,
                                            parent: Some("Dashboard".to_string()),
                                            channels: spec_for_state.channels.clone(),
                                            pid: workers.worker_pid(&name),
                                            started_at: Some(
                                                std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .unwrap_or_default()
                                                    .as_secs(),
                                            ),
                                            spec: Some(spec_for_state),
                                            restart_policy: None,
                                            initial_task: effective_task,
                                        },
                                    );
                                    if paths.persist { let _ = state.save(&paths.state); }
                                    note_local_spawn_control_dedup(
                                        &mut dedup,
                                        default_workspace_id
                                            .as_deref()
                                            .or_else(|| workspaces.first().map(|workspace| workspace.workspace_id.as_str())),
                                        &name,
                                        worker_relay_key.as_deref(),
                                    );
                                    let _ = send_event(
                                        &sdk_out_tx,
                                        json!({
                                            "kind":"agent_spawned",
                                            "name":&name,
                                            "runtime":"pty",
                                            "cli":&cli,
                                            "model":&model,
                                            "pid":pid,
                                            "source":"http_api",
                                            "pre_registered": worker_relay_key.is_some(),
                                            "registration_warning": preregistration_warning.clone(),
                                        }),
                                    ).await;
                                    publish_agent_state_transition(
                                        &ws_control_tx,
                                        &name,
                                        "spawned",
                                        Some("http_api_spawn"),
                                    )
                                    .await;
                                    let _ = reply.send(Ok(json!({
                                        "success": true,
                                        "name": name,
                                        "pid": pid,
                                        "pre_registered": worker_relay_key.is_some(),
                                        "warning": preregistration_warning,
                                    })));
                                }
                                Err(e) => {
                                    eprintln!("[agent-relay] HTTP API: failed to spawn '{}': {}", name, e);
                                    let _ = reply.send(Err(e.to_string()));
                                }
                            }
                        }
                        ListenApiRequest::SetModel { name, model, timeout_ms, reply } => {
                            let Some(handle) = workers.workers.get_mut(&name) else {
                                let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                                continue;
                            };

                            let model_command = format!("/model {}\n", model);
                            let result = async {
                                handle
                                    .stdin
                                    .write_all(model_command.as_bytes())
                                    .await
                                    .with_context(|| {
                                        format!("failed writing model command to worker '{}'", name)
                                    })?;
                                handle
                                    .stdin
                                    .flush()
                                    .await
                                    .with_context(|| {
                                        format!("failed flushing worker '{}' stdin", name)
                                    })?;
                                if let Some(timeout_ms) = timeout_ms {
                                    tracing::info!(
                                        name = %name,
                                        timeout_ms,
                                        "HTTP API set_model timeout_ms is currently advisory only"
                                    );
                                }
                                Ok::<(), anyhow::Error>(())
                            }
                            .await;

                            match result {
                                Ok(()) => {
                                    let _ = reply.send(Ok(json!({
                                        "name": name,
                                        "model": model,
                                        "success": true,
                                    })));
                                }
                                Err(error) => {
                                    let _ = reply.send(Err(error.to_string()));
                                }
                            }
                        }
                        ListenApiRequest::Release { name, reason, reply } => {
                            if let Some(ref r) = reason {
                                tracing::info!(worker = %name, reason = %r, "releasing agent via HTTP API");
                            }
                            // Unregister from supervisor before release to prevent
                            // auto-restart of intentionally released agents.
                            workers.supervisor.unregister(&name);
                            workers.metrics.on_release(&name);
                            match workers.release(&name).await {
                                Ok(()) => {
                                    if let Err(error) = relaycast_http.mark_agent_offline(&name).await {
                                        tracing::warn!(
                                            worker = %name,
                                            error = %error,
                                            "failed to mark released worker offline in relaycast"
                                        );
                                    }
                                    let dropped = drop_pending_for_worker(&mut pending_deliveries, &name);
                                    if dropped > 0 {
                                        let _ = send_event(
                                            &sdk_out_tx,
                                            json!({"kind":"delivery_dropped","name":&name,"count":dropped,"reason":"agent_released"}),
                                        ).await;
                                    }
                                    state.agents.remove(&name);
                                    if paths.persist { let _ = state.save(&paths.state); }
                                    let _ = send_event(
                                        &sdk_out_tx,
                                        json!({"kind":"agent_released","name":&name}),
                                    ).await;
                                    publish_agent_state_transition(
                                        &ws_control_tx,
                                        &name,
                                        "exited",
                                        Some("http_api_release"),
                                    )
                                    .await;
                                    let _ = reply.send(Ok(json!({ "success": true, "name": name })));
                                }
                                Err(e) => {
                                    let message = e.to_string();
                                    if is_unknown_worker_error_message(&message) {
                                        relaycast_http.forget_agent_registration(&name);
                                        state.agents.remove(&name);
                                        if paths.persist {
                                            let _ = state.save(&paths.state);
                                        }
                                        tracing::debug!(
                                            worker = %name,
                                            "ignoring duplicate HTTP API release for already exited worker"
                                        );
                                        let _ = reply.send(Ok(json!({ "success": true, "name": name })));
                                    } else {
                                        eprintln!("[agent-relay] HTTP API: failed to release '{}': {}", name, e);
                                        let _ = reply.send(Err(message));
                                    }
                                }
                            }
                        }
                        ListenApiRequest::Send {
                            to,
                            text,
                            from,
                            thread_id,
                            workspace_id,
                            workspace_alias,
                            mode,
                            reply,
                        } => {
                            let normalized_to = to.trim().to_string();
                            let selected_workspace = if let Some(workspace_id) = workspace_id.as_deref() {
                                workspace_lookup
                                    .get(workspace_id)
                                    .cloned()
                                    .ok_or_else(|| format!("workspace_not_found:workspace '{}' is not attached", workspace_id))
                            } else if let Some(workspace_alias) = workspace_alias.as_deref() {
                                workspaces
                                    .iter()
                                    .find(|workspace| {
                                        workspace
                                            .workspace_alias
                                            .as_deref()
                                            .is_some_and(|alias| alias.eq_ignore_ascii_case(workspace_alias))
                                    })
                                    .cloned()
                                    .ok_or_else(|| format!("workspace_not_found:workspace alias '{}' is not attached", workspace_alias))
                            } else if workspaces.len() == 1 {
                                Ok(workspaces[0].clone())
                            } else if let Some(default_workspace_id) = default_workspace_id.as_deref() {
                                workspace_lookup
                                    .get(default_workspace_id)
                                    .cloned()
                                    .ok_or_else(|| format!("workspace_not_found: default workspace '{}' not found", default_workspace_id))
                            } else {
                                Err("ambiguous_workspace:workspaceId or workspaceAlias is required when multiple workspaces are attached".to_string())
                            };
                            let selected_workspace = match selected_workspace {
                                Ok(workspace) => workspace,
                                Err(error) => {
                                    let _ = reply.send(Err(error));
                                    continue;
                                }
                            };
                            let selected_workspace_id = selected_workspace.workspace_id.clone();
                            let selected_workspace_alias = selected_workspace.workspace_alias.clone();
                            let workspace_self_name = selected_workspace.self_name.clone();
                            let normalized_sender = normalize_sender(from.clone());
                            let from_dashboard =
                                sender_is_dashboard_label(&normalized_sender, &workspace_self_name);
                            let delivery_from = if from_dashboard {
                                workspace_self_name.clone()
                            } else {
                                normalized_sender.clone()
                            };
                            tracing::info!(
                                target = "relay_broker::http_api",

                                raw_from = ?from,
                                normalized_sender = %normalized_sender,
                                from_dashboard = %from_dashboard,
                                delivery_from = %delivery_from,
                                to = %normalized_to,
                                thread_id = ?thread_id,
                                self_name = %workspace_self_name,
                                "HTTP API send request"
                            );
                            let ui_from = if from_dashboard {
                                workspace_self_name.clone()
                            } else {
                                normalized_sender
                            };
                            let event_id = format!("http_{}", Uuid::new_v4().simple());
                            let priority = if normalized_to.starts_with('#') { 3 } else { 2 };
                            let mut delivered = 0usize;
                            let mut delivery_errors = 0usize;
                            let request_start = Instant::now();
                            let local_delivery_timeout = http_api_local_delivery_timeout();
                            let relaycast_timeout = http_api_relaycast_send_timeout();
                            let event_emit_timeout = http_api_event_emit_timeout();

                            record_thread_history_event(
                                &mut recent_thread_messages,
                                json!({
                                    "event_id": event_id.clone(),
                                    "from": ui_from.clone(),
                                    "target": normalized_to.clone(),
                                    "to": normalized_to.clone(),
                                    "text": text.clone(),
                                    "thread_id": thread_id.clone(),
                                    "workspace_id": selected_workspace_id.clone(),
                                    "workspace_alias": selected_workspace_alias.clone(),
                                    "timestamp": chrono::Utc::now().to_rfc3339(),
                                }),
                            );

                            let targets = if normalized_to.starts_with('#') {
                                workers.worker_names_for_channel_delivery(&normalized_to, &delivery_from, Some(&selected_workspace_id))
                            } else {
                                workers.worker_names_for_direct_target(&normalized_to, &delivery_from, Some(&selected_workspace_id))
                            };

                            tracing::info!(
                                target = "relay_broker::http_api",

                                event_id = %event_id,
                                to = %normalized_to,
                                delivery_from = %delivery_from,
                                target_count = %targets.len(),
                                "resolved HTTP API send targets"
                            );

                            for worker_name in targets {
                                match timeout(
                                    local_delivery_timeout,
                                    queue_and_try_delivery_raw(
                                        &mut workers,
                                        &mut pending_deliveries,
                                        &worker_name,
                                        &event_id,
                                        &delivery_from,
                                        &normalized_to,
                                        &text,
                                        thread_id.clone(),
                                        Some(selected_workspace_id.clone()),
                                        selected_workspace_alias.clone(),
                                        priority,
                                        mode.clone(),
                                        delivery_retry_interval,
                                    ),
                                )
                                .await
                                {
                                    Ok(Ok(_)) => {
                                        delivered = delivered.saturating_add(1);
                                    }
                                    Ok(Err(error)) => {
                                        delivery_errors = delivery_errors.saturating_add(1);
                                        tracing::warn!(
                                            target = "relay_broker::http_api",

                                            event_id = %event_id,
                                            to = %normalized_to,
                                            worker = %worker_name,
                                            error = %error,
                                            "local delivery attempt failed"
                                        );
                                    }
                                    Err(_) => {
                                        delivery_errors = delivery_errors.saturating_add(1);
                                        tracing::warn!(
                                            target = "relay_broker::http_api",

                                            event_id = %event_id,
                                            to = %normalized_to,
                                            worker = %worker_name,
                                            timeout_ms = %local_delivery_timeout.as_millis(),
                                            "local delivery attempt timed out"
                                        );
                                    }
                                }
                            }

                            if delivered > 0 {
                                tracing::info!(
                                    target = "relay_broker::http_api",

                                    event_id = %event_id,
                                    to = %normalized_to,
                                    delivery_from = %delivery_from,
                                    ui_from = %ui_from,
                                    delivered = %delivered,
                                    "local delivery succeeded"
                                );
                                emit_http_api_event_with_timeout(
                                    &sdk_out_tx,
                                    json!({
                                        "kind": "relay_inbound",
                                        "event_id": event_id,
                                        "from": ui_from,
                                        "target": normalized_to,
                                        "body": text,
                                        "thread_id": thread_id.clone(),
                                        "workspace_id": selected_workspace_id.clone(),
                                        "workspace_alias": selected_workspace_alias.clone(),
                                    }),
                                    event_emit_timeout,
                                )
                                .await;
                                if reply
                                    .send(Ok(json!({
                                    "success": true,
                                    "event_id": event_id,
                                    "delivered": delivered,
                                    "local": true,
                                    "workspace_id": selected_workspace_id,
                                    "workspace_alias": selected_workspace_alias,
                                })))
                                    .is_err()
                                {
                                    tracing::warn!(
                                        target = "relay_broker::http_api",

                                        event_id = %event_id,
                                        "broker HTTP API reply channel closed before local delivery response"
                                    );
                                }
                            } else {
                                tracing::info!(
                                    target = "relay_broker::http_api",

                                    event_id = %event_id,
                                    to = %normalized_to,
                                    delivery_errors = %delivery_errors,
                                    delivery_from = %delivery_from,
                                    ui_from = %ui_from,
                                    relaycast_timeout_ms = %relaycast_timeout.as_millis(),
                                    "no local deliveries succeeded; forwarding to relaycast"
                                );
                                let relaycast_start = Instant::now();
                                match timeout(relaycast_timeout, selected_workspace.http_client.send(&normalized_to, &text))
                                    .await
                                {
                                    Ok(Ok(())) => {
                                        tracing::info!(
                                            target = "relay_broker::http_api",

                                            event_id = %event_id,
                                            to = %normalized_to,
                                            relaycast_ms = %relaycast_start.elapsed().as_millis(),
                                            "relaycast publish succeeded"
                                        );
                                        emit_http_api_event_with_timeout(
                                            &sdk_out_tx,
                                            json!({
                                                "kind": "relay_inbound",
                                                "event_id": event_id,
                                                "from": ui_from,
                                                "target": normalized_to,
                                                "body": text,
                                                "thread_id": thread_id.clone(),
                                                "workspace_id": selected_workspace_id.clone(),
                                                "workspace_alias": selected_workspace_alias.clone(),
                                            }),
                                            event_emit_timeout,
                                        )
                                        .await;
                                        if reply
                                            .send(Ok(json!({
                                            "success": true,
                                            "event_id": event_id,
                                            "relaycast_published": true,
                                            "local": false,
                                            "workspace_id": selected_workspace_id,
                                            "workspace_alias": selected_workspace_alias,
                                        })))
                                            .is_err()
                                        {
                                            tracing::warn!(
                                                target = "relay_broker::http_api",

                                                event_id = %event_id,
                                                "broker HTTP API reply channel closed before relaycast response"
                                            );
                                        }
                                    }
                                    Ok(Err(error)) => {
                                        tracing::warn!(
                                            target = "relay_broker::http_api",

                                            event_id = %event_id,
                                            to = %normalized_to,
                                            relaycast_ms = %relaycast_start.elapsed().as_millis(),
                                            error = %error,
                                            "relaycast publish failed"
                                        );
                                        let not_found = format!("Agent \"{}\" not found", normalized_to);
                                        if reply
                                            .send(Err(format!(
                                            "{not_found} and Relaycast publish failed: {error}"
                                        )))
                                            .is_err()
                                        {
                                            tracing::warn!(
                                                target = "relay_broker::http_api",

                                                event_id = %event_id,
                                                "broker HTTP API reply channel closed before relaycast failure response"
                                            );
                                        }
                                    }
                                    Err(_) => {
                                        tracing::warn!(
                                            target = "relay_broker::http_api",

                                            event_id = %event_id,
                                            to = %normalized_to,
                                            relaycast_timeout_ms = %relaycast_timeout.as_millis(),
                                            relaycast_ms = %relaycast_start.elapsed().as_millis(),
                                            "relaycast publish timed out"
                                        );
                                        let not_found = format!("Agent \"{}\" not found", normalized_to);
                                        if reply
                                            .send(Err(format!(
                                            "{not_found} and Relaycast publish timed out after {}ms",
                                            relaycast_timeout.as_millis()
                                        )))
                                            .is_err()
                                        {
                                            tracing::warn!(
                                                target = "relay_broker::http_api",

                                                event_id = %event_id,
                                                "broker HTTP API reply channel closed before relaycast timeout response"
                                            );
                                        }
                                    }
                                }
                            }
                            tracing::info!(
                                target = "relay_broker::http_api",

                                event_id = %event_id,
                                to = %normalized_to,
                                total_ms = %request_start.elapsed().as_millis(),
                                "HTTP API send request handling complete"
                            );
                        }
                        ListenApiRequest::List { reply } => {
                            let _ = reply.send(Ok(json!({ "agents": workers.list() })));
                        }
                        ListenApiRequest::Threads { reply } => {
                            let mut messages: Vec<Value> =
                                recent_thread_messages.iter().cloned().collect();
                            match relaycast_http.get_all_dms(200).await {
                                Ok(dm_messages) => messages.extend(dm_messages),
                                Err(error) => {
                                    tracing::debug!(
                                        error = %error,
                                        "failed to fetch relaycast dm history for /api/threads"
                                    );
                                }
                            }
                            let threads = build_thread_infos(&messages, &self_names);
                            let _ = reply.send(Ok(json!({ "threads": threads })));
                        }
                    }
                }
            }

            line = sdk_lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        match handle_sdk_frame(
                            &line,
                            &sdk_out_tx,
                                &mut workers,
                                &mut state,
                                &paths.state,
                                &mut pending_deliveries,
                                &mut dedup,
                                &telemetry,
                                &mut agent_spawn_count,
                                Some(&relaycast_http),
                                Some(&ws_control_tx),
                                &relay_workspace_key,
                                &workspaces,
                                default_workspace_id.as_deref(),
                                &crash_insights,
                            ).await {
                            Ok(should_shutdown) => {
                                if should_shutdown {
                                    shutdown = true;
                                }
                            }
                            Err(error) => {
                                let _ = send_error(&sdk_out_tx, None, "invalid_request", error.to_string(), false, None).await;
                            }
                        }
                    }
                    Ok(None) => {
                        shutdown = true;
                    }
                    Err(error) => {
                        let _ = send_error(&sdk_out_tx, None, "io_error", error.to_string(), true, None).await;
                        shutdown = true;
                    }
                }
            }

            ws_msg = ws_inbound_rx.recv() => {
                if let Some(ws_msg) = ws_msg {
                    let workspace_id = ws_msg.workspace_id.clone();
                    let workspace_alias = ws_msg.workspace_alias.clone();
                    let ws_value = ws_msg.value;
                    let workspace_state = workspace_lookup
                        .get(&workspace_id)
                        .cloned()
                        .unwrap_or_else(|| default_workspace.clone());
                    let workspace_self_name = workspace_state.self_name.clone();
                    let workspace_self_names = workspace_state.self_names.clone();
                    let workspace_self_agent_ids = workspace_state.self_agent_ids.clone();
                    let workspace_http = workspace_state.http_client.clone();
                    let ws_type = ws_value
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("<unknown>");
                    tracing::info!(
                        target = "agent_relay::broker",
                        ws_type = %ws_type,
                        workspace_id = %workspace_id,
                        event = %ws_value,
                        "received relaycast ws event"
                    );

                    let control_dedup_key = if matches!(
                        ws_type,
                        "agent.spawn_requested" | "agent.release_requested"
                    ) {
                        relaycast_ws_control_dedup_key(&workspace_id, ws_type, &ws_value)
                    } else {
                        None
                    };

                    if let Some(ref control_dedup_key) = control_dedup_key {
                        if !dedup.insert_if_new(control_dedup_key, Instant::now()) {
                            tracing::info!(
                                ws_type = %ws_type,
                                workspace_id = %workspace_id,
                                "dropping duplicate relaycast control event"
                            );
                            continue;
                        }
                    }

                    if matches!(ws_type, "agent.spawn_requested" | "agent.release_requested") {
                        if let Err(ref deser_err) = serde_json::from_value::<WsEvent>(ws_value.clone()) {
                            eprintln!(
                                "[agent-relay] WARNING: failed to deserialize {} event: {}",
                                ws_type, deser_err
                            );
                        }
                    }
                    if let Ok(ws_event) = serde_json::from_value::<WsEvent>(ws_value.clone()) {
                        match ws_event {
                            WsEvent::AgentReleaseRequested(event) => {
                                let name = event.agent.name;
                                if is_relaycast_self_control_target(
                                    &name,
                                    &workspace_self_name,
                                    &workspace_self_names,
                                ) {
                                    workspace_http.forget_agent_registration(&name);
                                    tracing::debug!(
                                        worker = %name,
                                        "ignoring relaycast release request for broker self"
                                    );
                                    continue;
                                }
                                workers.supervisor.unregister(&name);
                                workers.metrics.on_release(&name);
                                match workers.release(&name).await {
                                    Ok(()) => {
                                        workspace_http.forget_agent_registration(&name);
                                        let dropped = drop_pending_for_worker(&mut pending_deliveries, &name);
                                        if dropped > 0 {
                                            let _ = send_event(
                                                &sdk_out_tx,
                                                json!({"kind":"delivery_dropped","name":name,"count":dropped,"reason":"agent_released"}),
                                            ).await;
                                        }
                                        telemetry.track(TelemetryEvent::AgentRelease {
                                            cli: String::new(),
                                            release_reason: "relaycast_release".to_string(),
                                            lifetime_seconds: 0,
                                        });
                                        state.agents.remove(&name);
                                        if paths.persist {
                                            if let Err(error) = state.save(&paths.state) {
                                                tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state");
                                            }
                                        }
                                        let _ = send_event(
                                            &sdk_out_tx,
                                            json!({"kind":"agent_released","name":name}),
                                        ).await;
                                        publish_agent_state_transition(
                                            &workspace_state.ws_control_tx,
                                            &name,
                                            "exited",
                                            Some("relaycast_release"),
                                        )
                                        .await;
                                        tracing::info!(child = %name, "released worker via relaycast in broker mode");
                                        eprintln!("[agent-relay] released worker '{}' via relaycast", name);
                                    }
                                    Err(error) => {
                                        let message = error.to_string();
                                        if is_unknown_worker_error_message(&message) {
                                            workspace_http.forget_agent_registration(&name);
                                            state.agents.remove(&name);
                                            if paths.persist {
                                                if let Err(save_error) = state.save(&paths.state) {
                                                    tracing::warn!(
                                                        path = %paths.state.display(),
                                                        error = %save_error,
                                                        "failed to persist broker state"
                                                    );
                                                }
                                            }
                                            tracing::debug!(
                                                child = %name,
                                                "ignoring duplicate relaycast release for already exited worker"
                                            );
                                        } else {
                                            tracing::error!(child = %name, error = %error, "failed to release worker via relaycast");
                                            eprintln!("[agent-relay] failed to release '{}': {}", name, error);
                                        }
                                    }
                                }
                                continue;
                            }
                            WsEvent::AgentSpawnRequested(event) => {
                                let name = event.agent.name;
                                eprintln!("[agent-relay] received spawn request for '{}' (cli: {})", name, event.agent.cli);
                                if is_relaycast_self_control_target(
                                    &name,
                                    &workspace_self_name,
                                    &workspace_self_names,
                                ) {
                                    tracing::debug!(
                                        worker = %name,
                                        "ignoring relaycast spawn request for broker self"
                                    );
                                    eprintln!("[agent-relay] ignoring spawn request for '{}' (broker self)", name);
                                    continue;
                                }
                                let local_spawn_echo_key =
                                    relaycast_spawn_control_dedup_key(&workspace_id, &name);
                                if relaycast_ws_should_apply_local_spawn_echo_dedup(
                                    control_dedup_key.as_deref(),
                                    &local_spawn_echo_key,
                                ) && !dedup.insert_if_new(&local_spawn_echo_key, Instant::now())
                                {
                                    tracing::info!(
                                        worker = %name,
                                        workspace_id = %workspace_id,
                                        "dropping duplicate/local relaycast spawn request"
                                    );
                                    eprintln!("[agent-relay] dropping duplicate spawn request for '{}'", name);
                                    continue;
                                }
                                let cli = event.agent.cli;
                                let task = Some(event.agent.task).filter(|value| !value.trim().is_empty());
                                let channel = event.agent.channel;

                                tracing::info!(name = %name, cli = %cli, task = ?task, channel = ?channel, "handling spawn request from relaycast WS");
                                let channels = channel
                                    .as_deref()
                                    .map(|ch| {
                                        let mut chs = default_spawn_channels();
                                        if !chs.contains(&ch.to_string()) {
                                            chs.push(ch.to_string());
                                        }
                                        chs
                                    })
                                    .unwrap_or_else(default_spawn_channels);
                                let spec = AgentSpec {
                                    name: name.clone(),
                                    runtime: AgentRuntime::Pty,
                                    provider: None,
                                    cli: Some(cli.clone()),
                                    model: None,
                                    cwd: None,
                                    team: None,
                                    shadow_of: None,
                                    shadow_mode: None,
                                    args: vec![],
                                    channels: channels.clone(),
                                    restart_policy: None,
                                };
                                let spec_for_state = spec.clone();
                                let effective_task = normalize_initial_task(task.clone());

                                // Pre-register agent token. Claude doesn't need this — it
                                // bakes the API key into --mcp-config JSON and self-registers.
                                // Non-Claude CLIs need the token injected into their CLI args
                                // at spawn time, so we do a quick (3s) registration attempt.
                                let cli_command = parse_cli_command(&cli).map(|(cmd, _)| cmd).unwrap_or_else(|_| cli.clone());
                                let cli_name_lower = normalize_cli_name(&cli_command).to_lowercase();
                                let is_claude = cli_name_lower == "claude" || cli_name_lower.starts_with("claude:");
                                let worker_relay_key = {
                                    let ws_token = relaycast_ws_spawn_token(&ws_value);
                                    if ws_token.is_some() {
                                        ws_token
                                    } else if is_claude {
                                        // Claude self-registers via its MCP server — skip blocking call
                                        None
                                    } else {
                                        const REG_TIMEOUT: Duration = Duration::from_secs(3);
                                        match tokio::time::timeout(
                                            REG_TIMEOUT,
                                            workspace_http.register_agent_token(&name, Some(cli.as_str())),
                                        ).await {
                                            Ok(Ok(token)) => {
                                                tracing::info!(
                                                    worker = %name,
                                                    "pre-registered agent via broker for WS spawn"
                                                );
                                                Some(token)
                                            }
                                            Ok(Err(error)) => {
                                                tracing::warn!(
                                                    worker = %name,
                                                    error = %error,
                                                    "WS spawn pre-registration failed; agent will self-register"
                                                );
                                                None
                                            }
                                            Err(_) => {
                                                tracing::warn!(
                                                    worker = %name,
                                                    "WS spawn pre-registration timed out (3s); agent will self-register"
                                                );
                                                None
                                            }
                                        }
                                    }
                                };

                                match workers.spawn(
                                    spec,
                                    Some("Relaycast".to_string()),
                                    None,
                                    worker_relay_key.clone(),
                                    false,
                                    Some(workspace_id.clone()),
                                ).await {
                                    Ok(()) => {
                                        if let Some(ref task_text) = effective_task {
                                            workers.initial_tasks.insert(name.clone(), task_text.clone());
                                        }
                                        agent_spawn_count += 1;
                                        telemetry.track(TelemetryEvent::AgentSpawn {
                                            cli: cli.clone(),
                                            runtime: "pty".to_string(),
                                        });
                                        let pid = workers.worker_pid(&name).unwrap_or(0);
                                        state.agents.insert(
                                            name.clone(),
                                            PersistedAgent {
                                                runtime: AgentRuntime::Pty,
                                                parent: Some("Relaycast".to_string()),
                                                channels,
                                                pid: workers.worker_pid(&name),
                                                started_at: Some(
                                                    std::time::SystemTime::now()
                                                        .duration_since(std::time::UNIX_EPOCH)
                                                        .unwrap_or_default()
                                                        .as_secs(),
                                                ),
                                                spec: Some(spec_for_state),
                                                restart_policy: None,
                                                initial_task: effective_task,
                                            },
                                        );
                                        if paths.persist { let _ = state.save(&paths.state); }
                                        let _ = send_event(
                                            &sdk_out_tx,
                                            json!({
                                                "kind": "agent_spawned",
                                                "name": name,
                                                "runtime": "pty",
                                                "cli": cli,
                                                "pid": pid,
                                                "source": "relaycast_ws",
                                                "pre_registered": worker_relay_key.is_some(),
                                            }),
                                        ).await;
                                        publish_agent_state_transition(
                                            &workspace_state.ws_control_tx,
                                            &name,
                                            "spawned",
                                            Some("relaycast_spawn"),
                                        )
                                        .await;
                                        tracing::info!(child = %name, pid, "spawned worker via relaycast WS");
                                        eprintln!("[agent-relay] spawned worker '{}' via relaycast", name);
                                    }
                                    Err(e) => {
                                        let msg = e.to_string();
                                        if msg.contains("already exists") {
                                            tracing::debug!(child = %name, "agent already spawned via SDK, skipping duplicate relaycast WS spawn");
                                        } else {
                                            tracing::error!(child = %name, error = %e, "failed to spawn worker via relaycast WS");
                                            eprintln!("[agent-relay] failed to spawn '{}': {}", name, e);
                                        }
                                    }
                                }
                                continue;
                            }
                            _ => {}
                        }
                    } else if ws_type == "agent.spawn_requested" {
                        // Fallback: the SDK failed to deserialize the event (e.g. missing
                        // fields like `already_existed` or `task: null`).  Extract the
                        // spawn info directly from the raw JSON so we don't silently
                        // drop the request.
                        let agent_obj = ws_value.get("agent");
                        let name = agent_obj
                            .and_then(|a| a.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let cli = agent_obj
                            .and_then(|a| a.get("cli"))
                            .and_then(Value::as_str)
                            .unwrap_or("claude")
                            .to_string();
                        let task = agent_obj
                            .and_then(|a| a.get("task"))
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let channel = agent_obj
                            .and_then(|a| a.get("channel"))
                            .and_then(Value::as_str)
                            .map(String::from);

                        if !name.is_empty() {
                            eprintln!("[agent-relay] handling spawn request for '{}' via JSON fallback (cli: {})", name, cli);

                            if is_relaycast_self_control_target(
                                &name,
                                &workspace_self_name,
                                &workspace_self_names,
                            ) {
                                eprintln!("[agent-relay] ignoring spawn request for '{}' (broker self)", name);
                            } else {
                                let local_spawn_echo_key =
                                    relaycast_spawn_control_dedup_key(&workspace_id, &name);
                                let should_dedup = relaycast_ws_should_apply_local_spawn_echo_dedup(
                                    control_dedup_key.as_deref(),
                                    &local_spawn_echo_key,
                                );
                                // Always insert the local echo key for consistency with the primary path
                                let is_new = dedup.insert_if_new(&local_spawn_echo_key, Instant::now());
                                if !should_dedup || is_new
                                {
                                    let channels = channel
                                        .as_deref()
                                        .map(|ch| {
                                            let mut chs = default_spawn_channels();
                                            if !chs.contains(&ch.to_string()) {
                                                chs.push(ch.to_string());
                                            }
                                            chs
                                        })
                                        .unwrap_or_else(default_spawn_channels);
                                    let spec = AgentSpec {
                                        name: name.clone(),
                                        runtime: AgentRuntime::Pty,
                                        provider: None,
                                        cli: Some(cli.clone()),
                                        model: None,
                                        cwd: None,
                                        team: None,
                                        shadow_of: None,
                                        shadow_mode: None,
                                        args: vec![],
                                        channels: channels.clone(),
                                        restart_policy: None,
                                    };
                                    let spec_for_state = spec.clone();
                                    let task_opt = Some(task).filter(|v| !v.trim().is_empty());
                                    let effective_task = normalize_initial_task(task_opt.clone());

                                    // Pre-register (same logic as primary WS spawn path).
                                    let cli_command = parse_cli_command(&cli).map(|(cmd, _)| cmd).unwrap_or_else(|_| cli.clone());
                                    let cli_name_lower = normalize_cli_name(&cli_command).to_lowercase();
                                    let is_claude = cli_name_lower == "claude" || cli_name_lower.starts_with("claude:");
                                    let worker_relay_key = {
                                        let ws_token = relaycast_ws_spawn_token(&ws_value);
                                        if ws_token.is_some() {
                                            ws_token
                                        } else if is_claude {
                                            None
                                        } else {
                                            const REG_TIMEOUT: Duration = Duration::from_secs(3);
                                            match tokio::time::timeout(
                                                REG_TIMEOUT,
                                                workspace_http.register_agent_token(&name, Some(cli.as_str())),
                                            ).await {
                                                Ok(Ok(token)) => Some(token),
                                                Ok(Err(error)) => {
                                                    tracing::warn!(
                                                        worker = %name,
                                                        error = %error,
                                                        "WS spawn fallback pre-registration failed"
                                                    );
                                                    None
                                                }
                                                Err(_) => {
                                                    tracing::warn!(worker = %name, "WS spawn fallback pre-registration timed out (3s)");
                                                    None
                                                }
                                            }
                                        }
                                    };

                                    match workers.spawn(
                                        spec,
                                        Some("Relaycast".to_string()),
                                        None,
                                        worker_relay_key.clone(),
                                        false,
                                        Some(workspace_id.clone()),
                                    ).await {
                                        Ok(()) => {
                                            if let Some(ref task_text) = effective_task {
                                                workers.initial_tasks.insert(name.clone(), task_text.clone());
                                            }
                                            agent_spawn_count += 1;
                                            telemetry.track(TelemetryEvent::AgentSpawn {
                                                cli: cli.clone(),
                                                runtime: "pty".to_string(),
                                            });
                                            let pid = workers.worker_pid(&name).unwrap_or(0);
                                            state.agents.insert(
                                                name.clone(),
                                                PersistedAgent {
                                                    runtime: AgentRuntime::Pty,
                                                    parent: Some("Relaycast".to_string()),
                                                    channels,
                                                    pid: workers.worker_pid(&name),
                                                    started_at: Some(
                                                        std::time::SystemTime::now()
                                                            .duration_since(std::time::UNIX_EPOCH)
                                                            .unwrap_or_default()
                                                            .as_secs(),
                                                    ),
                                                    spec: Some(spec_for_state),
                                                    restart_policy: None,
                                                    initial_task: effective_task,
                                                },
                                            );
                                            if paths.persist { let _ = state.save(&paths.state); }
                                            let _ = send_event(
                                                &sdk_out_tx,
                                                json!({
                                                    "kind": "agent_spawned",
                                                    "name": name,
                                                    "runtime": "pty",
                                                    "cli": cli,
                                                    "pid": pid,
                                                    "source": "relaycast_ws_fallback",
                                                    "pre_registered": worker_relay_key.is_some(),
                                                }),
                                            ).await;
                                            publish_agent_state_transition(
                                                &workspace_state.ws_control_tx,
                                                &name,
                                                "spawned",
                                                Some("relaycast_spawn"),
                                            )
                                            .await;
                                            eprintln!("[agent-relay] spawned worker '{}' via relaycast (JSON fallback)", name);
                                        }
                                        Err(e) => {
                                            let msg = e.to_string();
                                            if !msg.contains("already exists") {
                                                eprintln!("[agent-relay] failed to spawn '{}': {}", name, e);
                                            }
                                        }
                                    }
                                } else {
                                    eprintln!("[agent-relay] dropping duplicate spawn request for '{}' (fallback)", name);
                                }
                            }
                        }
                        // Don't fall through to map_ws_event for control events
                        // handled by the JSON fallback path.
                        continue;
                    }

                    // Preserve the raw channel from the WS event for thread replies.
                    // The mapper may set target = "thread" (synthetic) when the SDK
                    // struct lacks a channel field; we use the raw value to fix
                    // display_target so the dashboard can route the message correctly.
                    let raw_ws_channel = ws_value
                        .get("channel")
                        .and_then(Value::as_str)
                        .map(String::from);

                    if let Some(mapped) = map_ws_event(&ws_value, &workspace_id, workspace_alias.as_deref()) {
                        tracing::info!(
                            from = %mapped.from,
                            target = %mapped.target,
                            kind = ?mapped.kind,
                            event_id = %mapped.event_id,
                            text_len = mapped.text.len(),
                            "mapped inbound WS event"
                        );
                        let dedup_key = format!("{}:{}", mapped.workspace_id, mapped.event_id);
                        if !dedup.insert_if_new(&dedup_key, Instant::now()) {
                            tracing::info!(event_id = %mapped.event_id, workspace_id = %mapped.workspace_id, "dropping duplicate event");
                            continue;
                        }
                        let has_local_target = if mapped.target.starts_with('#') {
                            !workers
                                .worker_names_for_channel_delivery(&mapped.target, &mapped.from, Some(&workspace_id))
                                .is_empty()
                        } else if matches!(mapped.kind, InboundKind::ThreadReply) && mapped.target == "thread" {
                            // Thread replies target "thread" (synthetic), not a specific worker.
                            // Treat as having a local target when any worker exists so the
                            // self-echo filter doesn't drop dashboard-originated thread replies.
                            workers.has_any_worker()
                        } else {
                            workers.has_worker_by_name_ignoring_case(&mapped.target)
                        };
                        if routing::is_self_echo(
                            &mapped,
                            &workspace_self_names,
                            &workspace_self_agent_ids,
                            has_local_target,
                        ) {
                            tracing::info!(from = %mapped.from, sender_agent_id = ?mapped.sender_agent_id, self_names = ?workspace_self_names, "skipping self-echo in broker loop");
                            continue;
                        }

                        telemetry.track(TelemetryEvent::MessageSend {
                            is_broadcast: mapped.target.starts_with('#'),
                            has_thread: mapped.thread_id.is_some(),
                        });

                        let mut delivery_plan = {
                            let worker_view = workers.routing_workers();
                            routing::resolve_delivery_targets(&mapped, &worker_view)
                        };

                        // For thread replies with synthetic target "thread", override
                        // display_target with the actual channel so the dashboard can
                        // route the message to the correct channel/DM view.
                        if matches!(mapped.kind, InboundKind::ThreadReply)
                            && delivery_plan.display_target == "thread"
                        {
                            if let Some(ref ch) = raw_ws_channel {
                                let chan_target = if ch.starts_with('#') {
                                    ch.clone()
                                } else {
                                    format!("#{ch}")
                                };
                                tracing::info!(
                                    original_target = "thread",
                                    resolved_target = %chan_target,
                                    "overriding thread reply display_target with raw WS channel"
                                );
                                delivery_plan.display_target = chan_target;
                            }
                        }

                        if mapped.target.starts_with('#') {
                            tracing::info!(
                                channel = %mapped.target,
                                from = %mapped.from,
                                target_count = delivery_plan.targets.len(),
                                targets = ?delivery_plan.targets,
                                "channel delivery targets"
                            );
                        } else {
                            tracing::info!(
                                target = %mapped.target,
                                from = %mapped.from,
                                kind = ?mapped.kind,
                                direct_targets = ?delivery_plan.targets,
                                "direct message routing"
                            );
                        }

                        if delivery_plan.needs_dm_resolution {
                            let conversation_id = mapped.target.clone();
                            tracing::info!(conversation_id = %conversation_id, "resolving DM participants");
                            let participants = resolve_dm_participants(
                                &workspace_http,
                                &mut dm_participants_cache,
                                &workspace_id,
                                &conversation_id,
                            )
                            .await;
                            tracing::info!(participants = ?participants, "resolved DM participants");

                            if let Some(participant) = participants
                                .iter()
                                .find(|participant| !participant.eq_ignore_ascii_case(&mapped.from))
                            {
                                delivery_plan.display_target = participant.clone();
                            }

                            let worker_view = workers.routing_workers();
                            delivery_plan.targets = routing::worker_names_for_dm_participants(
                                &worker_view,
                                &participants,
                                &mapped.from,
                                Some(&workspace_id),
                            );
                            tracing::info!(dm_targets = ?delivery_plan.targets, "DM participant-based routing targets");
                        }

                        for worker_name in delivery_plan.targets {
                            if let Err(error) = queue_and_try_delivery(
                                &mut workers,
                                &mut pending_deliveries,
                                &worker_name,
                                &mapped,
                                delivery_retry_interval,
                            ).await {
                                let _ = send_error(&sdk_out_tx, None, "delivery_failed", error.to_string(), true, Some(json!({"worker": worker_name}))).await;
                            }
                        }

                        let display_target =
                            display_target_for_dashboard(&delivery_plan.display_target, &workspace_self_names, &workspace_self_name);
                        let display_from = if workspace_self_names
                            .iter()
                            .any(|name| mapped.from.eq_ignore_ascii_case(name))
                        {
                            workspace_self_name.clone()
                        } else {
                            mapped.from.clone()
                        };
                        tracing::info!(
                            from = %display_from,
                            display_target = %display_target,
                            event_id = %mapped.event_id,
                            body_len = mapped.text.len(),
                            "broadcasting relay_inbound to dashboard"
                        );
                        record_thread_history_event(
                            &mut recent_thread_messages,
                            json!({
                                "event_id": mapped.event_id.clone(),
                                "from": display_from.clone(),
                                "target": display_target.clone(),
                                "text": mapped.text.clone(),
                                "thread_id": mapped.thread_id.clone(),
                                "workspace_id": mapped.workspace_id.clone(),
                                "workspace_alias": mapped.workspace_alias.clone(),
                                "timestamp": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                        let _ = send_event(
                            &sdk_out_tx,
                            json!({
                                "kind": "relay_inbound",
                                "event_id": mapped.event_id,
                                "from": display_from,
                                "target": display_target,
                                "body": mapped.text,
                                "thread_id": mapped.thread_id,
                                "workspace_id": mapped.workspace_id,
                                "workspace_alias": mapped.workspace_alias,
                            }),
                        ).await;
                    } else if ws_type != "broker.connection" && ws_type != "broker.channel_join" {
                        tracing::info!(
                            target = "agent_relay::broker",
                            ws_type = %ws_type,
                            event = %ws_value,
                            "relaycast ws event ignored by inbound mapper"
                        );
                    }
                }
            }

            worker_event = worker_event_rx.recv() => {
                if let Some(worker_event) = worker_event {
                    match worker_event {
                        WorkerEvent::Message { name, value } => {
                            if let Some(msg_type) = value.get("type").and_then(Value::as_str) {
                                if msg_type == "delivery_ack" {
                                    if let Some(payload) = value.get("payload") {
                                        let delivery_id = payload
                                            .get("delivery_id")
                                            .and_then(Value::as_str)
                                            .unwrap_or("");

                                        // Terminal guard: ignore late delivery_ack events once a
                                        // delivery has reached terminal failed status.
                                        if !delivery_id.is_empty()
                                            && terminal_failed_deliveries.contains(delivery_id)
                                        {
                                            tracing::info!(
                                                worker = %name,
                                                delivery_id = %delivery_id,
                                                "ignoring late delivery_ack after terminal failed status"
                                            );
                                            continue;
                                        }

                                        if let Ok(ack) = serde_json::from_value::<DeliveryAckPayload>(payload.clone()) {
                                            clear_pending_delivery_if_event_matches(
                                                &mut pending_deliveries,
                                                &ack.delivery_id,
                                                Some(&ack.event_id),
                                                &name,
                                                "delivery_ack",
                                            );
                                            terminal_failed_deliveries.remove(&ack.delivery_id);
                                        }
                                        let _ = send_event(&sdk_out_tx, json!({
                                            "kind": "delivery_ack",
                                            "name": name,
                                            "delivery_id": payload.get("delivery_id"),
                                            "event_id": payload.get("event_id"),
                                            "timestamp": payload.get("timestamp"),
                                        })).await;
                                    }
                                } else if msg_type == "delivery_queued" {
                                    if let Some(payload) = value.get("payload") {
                                        let _ = send_event(&sdk_out_tx, json!({
                                            "kind": msg_type,
                                            "name": name,
                                            "delivery_id": payload.get("delivery_id"),
                                            "event_id": payload.get("event_id"),
                                            "timestamp": payload.get("timestamp"),
                                        })).await;
                                    }
                                } else if msg_type == "delivery_injected" {
                                    if let Some(payload) = value.get("payload") {
                                        let delivery_id = payload
                                            .get("delivery_id")
                                            .and_then(Value::as_str)
                                            .unwrap_or("");
                                        let event_id =
                                            payload.get("event_id").and_then(Value::as_str);
                                        clear_pending_delivery_if_event_matches(
                                            &mut pending_deliveries,
                                            delivery_id,
                                            event_id,
                                            &name,
                                            "delivery_injected",
                                        );
                                        let _ = send_event(&sdk_out_tx, json!({
                                            "kind": msg_type,
                                            "name": name,
                                            "delivery_id": payload.get("delivery_id"),
                                            "event_id": payload.get("event_id"),
                                            "timestamp": payload.get("timestamp"),
                                        })).await;
                                    }
                                } else if msg_type == "delivery_verified" {
                                    if let Some(payload) = value.get("payload") {
                                        let delivery_id = payload.get("delivery_id").and_then(Value::as_str).unwrap_or("");
                                        let event_id = payload.get("event_id").and_then(Value::as_str).unwrap_or("");
                                        tracing::debug!(
                                            target = "agent_relay::broker",
                                            worker = %name,
                                            delivery_id = %delivery_id,
                                            event_id = %event_id,
                                            "delivery verified by echo detection"
                                        );
                                        clear_pending_delivery_if_event_matches(
                                            &mut pending_deliveries,
                                            delivery_id,
                                            Some(event_id),
                                            &name,
                                            "delivery_verified",
                                        );
                                        let _ = send_event(&sdk_out_tx, json!({
                                            "kind": "delivery_verified",
                                            "name": name,
                                            "delivery_id": delivery_id,
                                            "event_id": event_id,
                                        })).await;
                                    }
                                } else if msg_type == "delivery_active" {
                                    if let Some(payload) = value.get("payload") {
                                        let _ = send_event(&sdk_out_tx, json!({
                                            "kind": "delivery_active",
                                            "name": name,
                                            "delivery_id": payload.get("delivery_id"),
                                            "event_id": payload.get("event_id"),
                                            "pattern": payload.get("pattern"),
                                        })).await;
                                    }
                                } else if msg_type == "delivery_failed" {
                                    if let Some(payload) = value.get("payload") {
                                        let delivery_id = payload.get("delivery_id").and_then(Value::as_str).unwrap_or("");
                                        let event_id = payload.get("event_id").and_then(Value::as_str).unwrap_or("");
                                        let reason = payload.get("reason").and_then(Value::as_str).unwrap_or("unknown");
                                        tracing::warn!(
                                            target = "agent_relay::broker",
                                            worker = %name,
                                            delivery_id = %delivery_id,
                                            event_id = %event_id,
                                            reason = %reason,
                                            "delivery failed — echo not detected"
                                        );
                                        clear_pending_delivery_if_event_matches(
                                            &mut pending_deliveries,
                                            delivery_id,
                                            Some(event_id),
                                            &name,
                                            "delivery_failed",
                                        );
                                        if !delivery_id.is_empty() {
                                            terminal_failed_deliveries
                                                .insert(delivery_id.to_string());
                                        }
                                        let _ = send_event(&sdk_out_tx, json!({
                                            "kind": "delivery_failed",
                                            "name": name,
                                            "delivery_id": delivery_id,
                                            "event_id": event_id,
                                            "reason": reason,
                                        })).await;
                                    }
                                } else if msg_type == "worker_error" {
                                    let _ = send_event(&sdk_out_tx, json!({
                                        "kind": "worker_error",
                                        "name": name,
                                        "error": value.get("payload").cloned().unwrap_or(Value::Null)
                                    })).await;
                                } else if msg_type == "worker_stream" {
                                    let _ = send_event(&sdk_out_tx, json!({
                                        "kind": "worker_stream",
                                        "name": name,
                                        "stream": value.get("payload").and_then(|p| p.get("stream")).cloned().unwrap_or(Value::String("stdout".to_string())),
                                        "chunk": value.get("payload").and_then(|p| p.get("chunk")).cloned().unwrap_or(Value::String(String::new())),
                                    })).await;
                                } else if msg_type == "worker_ready" {
                                    if let Some(task_text) = workers.initial_tasks.remove(&name) {
                                        let event_id = format!("init_{}", Uuid::new_v4().simple());
                                        if let Err(e) = queue_and_try_delivery_raw(
                                            &mut workers,
                                            &mut pending_deliveries,
                                            &name,
                                            &event_id,
                                            "broker",
                                            &name,
                                            &task_text,
                                            None,
                                            None,
                                            None,
                                            2,
                                            MessageInjectionMode::Wait,
                                            delivery_retry_interval,
                                        ).await {
                                            tracing::warn!(worker = %name, error = %e, "failed to deliver initial_task");
                                        }
                                    }
                                    let runtime = value.get("payload")
                                        .and_then(|p| p.get("runtime"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("pty");
                                    let (provider_val, cli_val, model_val) = workers.workers.get(&name)
                                        .map(|h| (h.spec.provider.clone(), h.spec.cli.clone(), h.spec.model.clone()))
                                        .unwrap_or((None, None, None));
                                    let _ = send_event(&sdk_out_tx, json!({
                                        "kind": "worker_ready",
                                        "name": name,
                                        "runtime": runtime,
                                        "provider": provider_val,
                                        "cli": cli_val,
                                        "model": model_val,
                                    })).await;
                                } else if msg_type == "agent_idle" {
                                    let idle_secs = value.get("payload")
                                        .and_then(|p| p.get("idle_secs"))
                                        .and_then(Value::as_u64)
                                        .unwrap_or(0);
                                    let _ = send_event(&sdk_out_tx, json!({
                                        "kind": "agent_idle",
                                        "name": name,
                                        "idle_secs": idle_secs,
                                    })).await;
                                    publish_agent_state_transition(
                                        &ws_control_tx,
                                        &name,
                                        "idle",
                                        Some("idle_threshold"),
                                    )
                                    .await;
                                } else if msg_type == "agent_exit" {
                                    let reason = value.get("payload")
                                        .and_then(|p| p.get("reason"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown");
                                    tracing::info!(agent = %name, reason = %reason, "agent requested exit");
                                    let _ = send_event(&sdk_out_tx, json!({
                                        "kind": "agent_exit",
                                        "name": name,
                                        "reason": reason,
                                    })).await;
                                } else if msg_type == "continuity_command" {
                                    // Agent-initiated continuity: the pty_worker detected a
                                    // KIND: continuity block in PTY output and emitted this event.
                                    let action = value.get("payload")
                                        .and_then(|p| p.get("action"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    let content = value.get("payload")
                                        .and_then(|p| p.get("content"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    match action {
                                        "save" => {
                                            let cont_dir = continuity_dir(&paths.state);
                                            if let Err(e) = std::fs::create_dir_all(&cont_dir) {
                                                tracing::warn!(
                                                    agent = %name,
                                                    error = %e,
                                                    "continuity_command save: failed to create dir"
                                                );
                                            } else {
                                                // Build a minimal continuity record with the provided summary.
                                                let agent_data = state.agents.get(&name);
                                                let cli = agent_data
                                                    .and_then(|d| d.spec.as_ref())
                                                    .and_then(|s| s.cli.clone());
                                                let initial_task = agent_data
                                                    .and_then(|d| d.initial_task.clone());
                                                let continuity = json!({
                                                    "agent_name": name,
                                                    "cli": cli,
                                                    "initial_task": initial_task,
                                                    "released_at": null,
                                                    "lifetime_seconds": null,
                                                    "message_history": [],
                                                    "summary": content,
                                                });
                                                let cont_file = cont_dir.join(format!("{}.json", name));
                                                match std::fs::write(
                                                    &cont_file,
                                                    serde_json::to_string_pretty(&continuity)
                                                        .unwrap_or_default(),
                                                ) {
                                                    Ok(()) => tracing::info!(
                                                        agent = %name,
                                                        path = %cont_file.display(),
                                                        "continuity_command: saved agent-initiated continuity"
                                                    ),
                                                    Err(e) => tracing::warn!(
                                                        agent = %name,
                                                        error = %e,
                                                        "continuity_command save: failed to write file"
                                                    ),
                                                }
                                            }
                                        }
                                        "load" => {
                                            let cont_dir = continuity_dir(&paths.state);
                                            let cont_file = cont_dir.join(format!("{}.json", name));
                                            if cont_file.exists() {
                                                match std::fs::read_to_string(&cont_file) {
                                                    Ok(raw) => {
                                                        if let Ok(ctx) = serde_json::from_str::<Value>(&raw) {
                                                            // Build a context summary and inject it
                                                            let prev_task = ctx.get("initial_task")
                                                                .and_then(Value::as_str)
                                                                .unwrap_or("unknown");
                                                            let summary = ctx.get("summary")
                                                                .and_then(Value::as_str)
                                                                .unwrap_or("no summary");
                                                            let history_str = ctx.get("message_history")
                                                                .and_then(Value::as_array)
                                                                .map(|msgs| {
                                                                    msgs.iter()
                                                                        .filter_map(|m| {
                                                                            let from = m.get("from")?.as_str()?;
                                                                            let text = m.get("text")
                                                                                .or_else(|| m.get("body"))?
                                                                                .as_str()?;
                                                                            Some(format!("  - {}: {}", from, text))
                                                                        })
                                                                        .collect::<Vec<_>>()
                                                                        .join("\n")
                                                                })
                                                                .unwrap_or_default();
                                                            let history_section = if history_str.is_empty() {
                                                                String::new()
                                                            } else {
                                                                format!("\nRecent messages:\n{}", history_str)
                                                            };
                                                            let inject_body = format!(
                                                                "## Continuity Context (from previous session as '{}')\n\
                                                                 Previous task: {}\n\
                                                                 Session summary: {}{}",
                                                                name, prev_task, summary, history_section
                                                            );
                                                            let event_id = format!("cont_load_{}", Uuid::new_v4().simple());
                                                            if let Err(e) = queue_and_try_delivery_raw(
                                                                &mut workers,
                                                                &mut pending_deliveries,
                                                                &name,
                                                                &event_id,
                                                                "broker",
                                                                &name,
                                                                &inject_body,
                                                                None,
                                                                None,
                                                                None,
                                                                2,
                                                                MessageInjectionMode::Wait,
                                                                delivery_retry_interval,
                                                            ).await {
                                                                tracing::warn!(
                                                                    agent = %name,
                                                                    error = %e,
                                                                    "continuity_command load: failed to inject context"
                                                                );
                                                            } else {
                                                                tracing::info!(
                                                                    agent = %name,
                                                                    "continuity_command: injected loaded context"
                                                                );
                                                            }
                                                        }
                                                    }
                                                    Err(e) => tracing::warn!(
                                                        agent = %name,
                                                        error = %e,
                                                        "continuity_command load: failed to read file"
                                                    ),
                                                }
                                            } else {
                                                tracing::debug!(
                                                    agent = %name,
                                                    "continuity_command load: no continuity file found"
                                                );
                                            }
                                        }
                                        "uncertain" => {
                                            tracing::info!(
                                                agent = %name,
                                                content = %content,
                                                "continuity_command: agent reported uncertainty"
                                            );
                                        }
                                        other => {
                                            tracing::warn!(
                                                agent = %name,
                                                action = %other,
                                                "continuity_command: unknown action ignored"
                                            );
                                        }
                                    }
                                } else if msg_type == "worker_exited" {
                                    // PTY worker process is exiting — clean up and
                                    // emit agent_exited so the SDK doesn't have to
                                    // wait for the reap_exited polling cycle.
                                    let code = value.get("payload")
                                        .and_then(|p| p.get("code"))
                                        .and_then(Value::as_i64)
                                        .map(|c| c as i32);
                                    let signal = value.get("payload")
                                        .and_then(|p| p.get("signal"))
                                        .and_then(Value::as_str)
                                        .map(String::from);
                                    tracing::info!(
                                        agent = %name,
                                        code = ?code,
                                        signal = ?signal,
                                        "worker_exited received — cleaning up"
                                    );
                                    // Remove from registry so reap_exited won't
                                    // double-process this worker.
                                    workers.workers.remove(&name);
                                    workers.initial_tasks.remove(&name);
                                    // Drop pending deliveries for this worker
                                    let dropped = drop_pending_for_worker(&mut pending_deliveries, &name);
                                    if dropped > 0 {
                                        let _ = send_event(
                                            &sdk_out_tx,
                                            json!({
                                                "kind": "delivery_dropped",
                                                "name": name,
                                                "count": dropped,
                                                "reason": "worker_exited",
                                            }),
                                        ).await;
                                    }
                                    let _ = send_event(
                                        &sdk_out_tx,
                                        json!({
                                            "kind": "agent_exited",
                                            "name": name,
                                            "code": code,
                                            "signal": signal,
                                        }),
                                    ).await;
                                    publish_agent_state_transition(
                                        &ws_control_tx,
                                        &name,
                                        "exited",
                                        Some("worker_exited"),
                                    )
                                    .await;
                                    if let Err(error) = relaycast_http.mark_agent_offline(&name).await {
                                        tracing::warn!(
                                            worker = %name,
                                            error = %error,
                                            "failed to mark exited worker offline in relaycast"
                                        );
                                    }
                                    state.agents.remove(&name);
                                    if paths.persist {
                                        if let Err(error) = state.save(&paths.state) {
                                            tracing::warn!(
                                                path = %paths.state.display(),
                                                error = %error,
                                                "failed to persist broker state"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            _ = reap_tick.tick() => {
                let now = Instant::now();
                let due_ids: Vec<String> = pending_deliveries
                    .iter()
                    .filter_map(|(delivery_id, pending)| {
                        if pending.next_retry_at <= now {
                            Some(delivery_id.clone())
                        } else {
                            None
                        }
                    })
                    .collect();

                for delivery_id in due_ids {
                    let was_retry = pending_deliveries
                        .get(&delivery_id)
                        .map(|pending| pending.attempts > 0)
                        .unwrap_or(false);

                    match retry_pending_delivery(
                        &delivery_id,
                        &mut workers,
                        &mut pending_deliveries,
                        delivery_retry_interval,
                    )
                    .await {
                        Ok(Some((worker_name, attempts, event_id))) => {
                            if was_retry {
                                let _ = send_event(
                                    &sdk_out_tx,
                                    json!({
                                        "kind":"delivery_retry",
                                        "name": worker_name,
                                        "delivery_id": delivery_id,
                                        "event_id": event_id,
                                        "attempts": attempts,
                                    }),
                                ).await;
                            }
                        }
                        Ok(None) => {
                            if was_retry {
                                let _ = send_event(
                                    &sdk_out_tx,
                                    json!({
                                        "kind": "delivery_dropped",
                                        "delivery_id": delivery_id,
                                        "reason": "max_retries_exceeded",
                                    }),
                                ).await;
                            }
                        }
                        Err(error) => {
                            let _ = send_error(
                                &sdk_out_tx,
                                None,
                                "delivery_failed",
                                error.to_string(),
                                true,
                                Some(json!({"delivery_id": delivery_id})),
                            ).await;
                        }
                    }
                }

                let exited = match workers.reap_exited().await {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(err = %e, "reap_exited failed, skipping this cycle");
                        vec![]
                    }
                };
                for (name, code, signal) in &exited {
                    // Record crash in insights
                    let (category, description) = relay_broker::crash_insights::CrashInsights::analyze(*code, signal.as_deref());
                    crash_insights.record(relay_broker::crash_insights::CrashRecord {
                        agent_name: name.clone(),
                        exit_code: *code,
                        signal: signal.clone(),
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                        uptime_secs: 0,
                        category,
                        description,
                    });

                    telemetry.track(TelemetryEvent::AgentCrash {
                        cli: String::new(),
                        exit_code: *code,
                        lifetime_seconds: 0,
                    });

                    // Check supervisor for restart decision
                    use relay_broker::supervisor::RestartDecision;
                    match workers.supervisor.on_exit(name, *code, signal.as_deref()) {
                        Some(RestartDecision::Restart { delay }) => {
                            // Keep pending deliveries — we'll redeliver after restart
                            workers.metrics.on_crash(name);
                            let restart_count = workers.supervisor.restart_count(name) + 1;
                            tracing::info!(
                                name = %name,
                                exit_code = ?code,
                                signal = ?signal,
                                restart_count,
                                delay_ms = delay.as_millis() as u64,
                                "agent will be restarted"
                            );
                            let _ = send_event(
                                &sdk_out_tx,
                                json!({
                                    "kind": "agent_restarting",
                                    "name": name,
                                    "code": code,
                                    "signal": signal,
                                    "restart_count": restart_count,
                                    "delay_ms": delay.as_millis() as u64,
                                }),
                            ).await;
                            publish_agent_state_transition(
                                &ws_control_tx,
                                name,
                                "stuck",
                                Some("restarting"),
                            )
                            .await;
                        }
                        Some(RestartDecision::PermanentlyDead { reason }) => {
                            workers.metrics.on_permanent_death(name);
                            let dropped = drop_pending_for_worker(&mut pending_deliveries, name);
                            if dropped > 0 {
                                let _ = send_event(
                                    &sdk_out_tx,
                                    json!({
                                        "kind":"delivery_dropped",
                                        "name": name,
                                        "count": dropped,
                                        "reason":"worker_permanently_dead",
                                    }),
                                ).await;
                            }
                            let _ = send_event(
                                &sdk_out_tx,
                                json!({"kind":"agent_permanently_dead","name":name,"reason":reason}),
                            ).await;
                            publish_agent_state_transition(
                                &ws_control_tx,
                                name,
                                "stuck",
                                Some("permanently_dead"),
                            )
                            .await;
                            if let Err(error) = relaycast_http.mark_agent_offline(name).await {
                                tracing::warn!(
                                    worker = %name,
                                    error = %error,
                                    "failed to mark permanently dead worker offline in relaycast"
                                );
                            }
                            state.agents.remove(name);
                            if paths.persist {
                                if let Err(error) = state.save(&paths.state) {
                                    tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state");
                                }
                            }
                        }
                        None => {
                            // Not supervised — original behavior
                            let dropped = drop_pending_for_worker(&mut pending_deliveries, name);
                            if dropped > 0 {
                                let _ = send_event(
                                    &sdk_out_tx,
                                    json!({
                                        "kind":"delivery_dropped",
                                        "name": name,
                                        "count": dropped,
                                        "reason":"worker_exited",
                                    }),
                                ).await;
                            }
                            let _ = send_event(
                                &sdk_out_tx,
                                json!({"kind":"agent_exited","name":name,"code":code,"signal":signal}),
                            ).await;
                            publish_agent_state_transition(
                                &ws_control_tx,
                                name,
                                "exited",
                                Some("worker_exited"),
                            )
                            .await;
                            if let Err(error) = relaycast_http.mark_agent_offline(name).await {
                                tracing::warn!(
                                    worker = %name,
                                    error = %error,
                                    "failed to mark exited worker offline in relaycast"
                                );
                            }
                            state.agents.remove(name);
                            if paths.persist {
                                if let Err(error) = state.save(&paths.state) {
                                    tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state");
                                }
                            }
                        }
                    }
                }

                // Check for agents ready to restart (past cooldown)
                if !shutdown {
                    let pending_restarts = workers.supervisor.pending_restarts();
                    for (name, rst) in pending_restarts {
                        if let Some(remaining) = relaycast_http.registration_block_remaining(&name)
                        {
                            tracing::debug!(
                                worker = %name,
                                retry_after_secs = remaining.as_secs().max(1),
                                "skipping restart while relaycast registration is rate-limited"
                            );
                            continue;
                        }

                        let worker_relay_key = if rst.skip_relay_prompt {
                            None
                        } else {
                            match relaycast_http
                                .register_agent_token(&name, rst.spec.cli.as_deref())
                                .await
                            {
                                Ok(token) => Some(token),
                                Err(error) => {
                                    match registration_retry_after_secs(&error) {
                                        Some(retry_after_secs) => {
                                            tracing::warn!(
                                                worker = %name,
                                                retry_after_secs,
                                                error = %error,
                                                "restart blocked by relaycast registration rate limit"
                                            );
                                        }
                                        None => {
                                            tracing::error!(
                                                worker = %name,
                                                error = %error,
                                                "failed to pre-register worker before restart"
                                            );
                                        }
                                    }
                                    continue;
                                }
                            }
                        };

                        match workers
                            .spawn(
                                rst.spec.clone(),
                                rst.parent.clone(),
                                None,
                                worker_relay_key,
                                rst.skip_relay_prompt,
                                None,
                            )
                            .await
                        {
                            Ok(()) => {
                                workers.supervisor.on_restarted(&name);
                                workers.metrics.on_restart(&name);
                                if let Some(task) = rst.initial_task {
                                    workers.initial_tasks.insert(name.clone(), task);
                                }
                                tracing::info!(name = %name, restart_count = rst.restart_count, "agent restarted");
                                let _ = send_event(
                                    &sdk_out_tx,
                                    json!({
                                        "kind": "agent_restarted",
                                        "name": name,
                                        "restart_count": rst.restart_count,
                                    }),
                                ).await;
                                publish_agent_state_transition(
                                    &ws_control_tx,
                                    &name,
                                    "spawned",
                                    Some("restarted"),
                                )
                                .await;
                            }
                            Err(e) => {
                                tracing::error!(name = %name, error = %e, "restart failed");
                            }
                        }
                    }
                }

                // Persist pending deliveries for crash recovery
                if paths.persist {
                    if let Err(error) = save_pending_deliveries(&paths.pending, &pending_deliveries) {
                        tracing::warn!(path = %paths.pending.display(), error = %error, "failed to persist pending deliveries");
                    }
                }
            }
        }
    }

    // Save crash insights before shutdown (only in persist mode)
    if paths.persist {
        if let Err(error) = crash_insights.save(&crash_insights_path) {
            tracing::warn!(error = %error, "failed to save crash insights");
        }
    }

    telemetry.track(TelemetryEvent::BrokerStop {
        uptime_seconds: broker_start.elapsed().as_secs(),
        agent_spawn_count,
    });
    telemetry.shutdown();

    let active_workers: Vec<String> = workers.workers.keys().cloned().collect();
    for worker_name in active_workers {
        if let Err(error) = relaycast_http.mark_agent_offline(&worker_name).await {
            tracing::warn!(
                worker = %worker_name,
                error = %error,
                "failed to mark worker offline during shutdown"
            );
        }
    }

    // Mark broker agent offline in Relaycast before shutting down WS
    if let Err(error) = relaycast_http.mark_offline().await {
        tracing::warn!(error = %error, "failed to mark broker offline during shutdown");
    }

    if let Err(error) = ws_control_tx.send(WsControl::Shutdown).await {
        tracing::warn!(error = %error, "failed to send ws shutdown signal");
    }
    pending_deliveries.clear();
    // Clean shutdown — remove pending file since nothing is pending
    if paths.persist {
        let _ = std::fs::remove_file(&paths.pending);
    }
    workers.shutdown_all().await?;

    // Clean up PID file and state file on graceful shutdown
    if paths.persist {
        let _ = std::fs::remove_file(&paths.pid);
        let _ = std::fs::remove_file(&paths.state);
    }

    Ok(())
}

/// Get terminal rows from TIOCGWINSZ.
#[cfg(unix)]
fn terminal_rows() -> Option<u16> {
    use nix::libc;
    use nix::pty::Winsize;
    let mut ws = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_row > 0 {
            Some(ws.ws_row)
        } else {
            None
        }
    }
}

/// Get terminal cols from TIOCGWINSZ.
#[cfg(unix)]
fn terminal_cols() -> Option<u16> {
    use nix::libc;
    use nix::pty::Winsize;
    let mut ws = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
            Some(ws.ws_col)
        } else {
            None
        }
    }
}

#[cfg(not(unix))]
fn terminal_rows() -> Option<u16> {
    None
}
#[cfg(not(unix))]
fn terminal_cols() -> Option<u16> {
    None
}

#[cfg(target_os = "linux")]
fn memory_bytes_for_pid(pid: u32) -> u64 {
    let statm_path = format!("/proc/{pid}/statm");
    let statm = match std::fs::read_to_string(statm_path) {
        Ok(contents) => contents,
        Err(_) => return 0,
    };

    let rss_pages = match statm
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(value) => value,
        None => return 0,
    };

    let page_size = unsafe { nix::libc::sysconf(nix::libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return 0;
    }

    rss_pages.saturating_mul(page_size as u64)
}

#[cfg(not(target_os = "linux"))]
fn memory_bytes_for_pid(_pid: u32) -> u64 {
    0
}

fn build_agent_metrics(handle: &WorkerHandle) -> AgentMetrics {
    let pid = handle.child.id().unwrap_or_default();
    AgentMetrics {
        name: handle.spec.name.clone(),
        pid,
        memory_bytes: if pid == 0 {
            0
        } else {
            memory_bytes_for_pid(pid)
        },
        uptime_secs: handle.spawned_at.elapsed().as_secs(),
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_sdk_frame(
    line: &str,
    out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    workers: &mut WorkerRegistry,
    state: &mut BrokerState,
    state_path: &Path,
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    dedup: &mut DedupCache,
    telemetry: &TelemetryClient,
    agent_spawn_count: &mut u32,
    relaycast_http: Option<&RelaycastHttpClient>,
    ws_control_tx: Option<&mpsc::Sender<WsControl>>,
    workspace_key: &str,
    workspaces: &[RelayWorkspace],
    default_workspace_id: Option<&str>,
    crash_insights: &relay_broker::crash_insights::CrashInsights,
) -> Result<bool> {
    let frame: ProtocolEnvelope<Value> =
        serde_json::from_str(line).context("request is not a valid protocol envelope")?;

    if frame.v != PROTOCOL_VERSION {
        send_error(
            out_tx,
            frame.request_id,
            "unsupported_version",
            format!(
                "expected protocol version {}, got {}",
                PROTOCOL_VERSION, frame.v
            ),
            false,
            None,
        )
        .await?;
        return Ok(false);
    }

    match frame.msg_type.as_str() {
        "hello" => {
            send_frame(
                out_tx,
                "hello_ack",
                frame.request_id,
                json!({
                    "broker_version": env!("CARGO_PKG_VERSION"),
                    "protocol_version": PROTOCOL_VERSION,
                    "workspace_key": workspace_key,
                }),
            )
            .await?;
            Ok(false)
        }
        "spawn_agent" => {
            let payload: SpawnPayload = serde_json::from_value(frame.payload)
                .context("spawn_agent payload must contain `agent`")?;
            let runtime = payload.agent.runtime.clone();
            let name = payload.agent.name.clone();

            // Build the effective initial_task, injecting continuity context if continue_from is set.
            let mut effective_task = normalize_initial_task(payload.initial_task.clone());
            if let Some(ref continue_from) = payload.continue_from {
                let continuity_dir = continuity_dir(state_path);
                let continuity_file = continuity_dir.join(format!("{}.json", continue_from));
                if continuity_file.exists() {
                    match std::fs::read_to_string(&continuity_file) {
                        Ok(contents) => {
                            if let Ok(ctx) = serde_json::from_str::<Value>(&contents) {
                                let prev_task = ctx
                                    .get("initial_task")
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown");
                                let summary = ctx
                                    .get("summary")
                                    .and_then(Value::as_str)
                                    .unwrap_or("no summary available");
                                let messages = ctx
                                    .get("message_history")
                                    .and_then(Value::as_array)
                                    .map(|msgs| {
                                        msgs.iter()
                                            .filter_map(|m| {
                                                let from = m
                                                    .get("from")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("?");
                                                let text = m
                                                    .get("text")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("");
                                                if text.is_empty() {
                                                    None
                                                } else {
                                                    Some(format!("  {}: {}", from, text))
                                                }
                                            })
                                            .collect::<Vec<_>>()
                                            .join("\n")
                                    })
                                    .unwrap_or_default();

                                let continuity_block = format!(
                                    "## Continuity Context (from previous session as '{}')\n\
                                     Previous task: {}\n\
                                     Session summary: {}\n{}",
                                    continue_from,
                                    prev_task,
                                    summary,
                                    if messages.is_empty() {
                                        String::new()
                                    } else {
                                        format!("Recent messages:\n{}\n", messages)
                                    }
                                );

                                effective_task = Some(match effective_task {
                                    Some(new_task) => {
                                        format!(
                                            "{}\n\n## Current Task\n{}",
                                            continuity_block, new_task
                                        )
                                    }
                                    None => continuity_block,
                                });
                                tracing::info!(
                                    agent = %name,
                                    continue_from = %continue_from,
                                    "injected continuity context from previous session"
                                );
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                agent = %name,
                                continue_from = %continue_from,
                                error = %e,
                                "failed to read continuity file"
                            );
                        }
                    }
                } else {
                    tracing::warn!(
                        agent = %name,
                        continue_from = %continue_from,
                        "no continuity file found at {}",
                        continuity_file.display()
                    );
                }
            }

            // Pre-registration with a 15s timeout so a slow Relaycast API never
            // blocks the SDK's spawn_agent call (SDK timeout = 60s). If the cache
            // was warmed by preflight_agents, this is an instant cache hit (<1ms).
            // If registration times out or fails retryably, we proceed without a
            // token — the agent self-registers via MCP on first connect.
            // Skip pre-registration when skip_relay_prompt is true — the agent
            // won't use relay messaging so there is no need to register it, and
            // a registration failure should not abort the spawn.
            let mut preregistration_warning: Option<String> = None;
            let worker_relay_key = if payload.skip_relay_prompt {
                None
            } else if let Some(http) = relaycast_http {
                const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(15);
                match tokio::time::timeout(
                    REGISTRATION_TIMEOUT,
                    http.register_agent_token(&name, payload.agent.cli.as_deref()),
                )
                .await
                {
                    Ok(Ok(token)) => Some(token),
                    Ok(Err(error)) => {
                        if registration_is_retryable(&error) {
                            preregistration_warning =
                                Some(format_worker_preregistration_error(&name, &error));
                            tracing::warn!(
                                worker = %name,
                                error = %error,
                                "continuing spawn without pre-registration due to retryable relaycast error"
                            );
                            None
                        } else {
                            let retry_after_secs = registration_retry_after_secs(&error);
                            let mut details = json!({
                                "agent": name,
                                "registration_error": error.to_string(),
                            });
                            if let Some(retry_after) = retry_after_secs {
                                details["retry_after_secs"] = json!(retry_after);
                            }
                            send_error(
                                out_tx,
                                frame.request_id,
                                "worker_registration_failed",
                                format_worker_preregistration_error(&name, &error),
                                registration_is_retryable(&error),
                                Some(details),
                            )
                            .await?;
                            return Ok(false);
                        }
                    }
                    Err(_timeout) => {
                        // Registration timed out — spawn without token.
                        // Agent will self-register with Relaycast on MCP connect.
                        tracing::warn!(
                            worker = %name,
                            timeout_secs = REGISTRATION_TIMEOUT.as_secs(),
                            "Relaycast pre-registration timed out; spawning without token"
                        );
                        preregistration_warning = Some(format!(
                            "pre-registration for '{name}' timed out after {}s; agent will self-register",
                            REGISTRATION_TIMEOUT.as_secs()
                        ));
                        None
                    }
                }
            } else {
                None
            };

            // Seed the dedup cache BEFORE spawning so that a Relaycast WS echo
            // arriving while the spawn is in progress is correctly deduplicated.
            // If spawn fails we remove the entry so retries are not blocked.
            note_local_spawn_control_dedup(
                dedup,
                default_workspace_id.or_else(|| {
                    workspaces
                        .first()
                        .map(|workspace| workspace.workspace_id.as_str())
                }),
                &name,
                worker_relay_key.as_deref(),
            );

            if let Err(err) = workers
                .spawn(
                    payload.agent.clone(),
                    None,
                    payload.idle_threshold_secs,
                    worker_relay_key.clone(),
                    payload.skip_relay_prompt,
                    None,
                )
                .await
            {
                let err_msg = format!("{err:#}");
                // Only clean up dedup if this was a genuinely new spawn attempt
                // that failed, not a duplicate request for an already-running
                // agent.  When the error is "already exists" the dedup entry
                // belongs to the prior successful spawn and must be preserved.
                if !err_msg.contains("already exists") {
                    remove_local_spawn_control_dedup(
                        dedup,
                        default_workspace_id.or_else(|| {
                            workspaces
                                .first()
                                .map(|workspace| workspace.workspace_id.as_str())
                        }),
                        &name,
                        worker_relay_key.as_deref(),
                    );
                }
                return Err(err);
            }

            // Subscribe the broker's WebSocket to any custom channels the
            // spawned agent needs so cloud-routed messages reach the broker.
            if !payload.agent.channels.is_empty() {
                let spawn_channels = payload.agent.channels.clone();
                for workspace in workspaces {
                    if let Err(error) = workspace
                        .http_client
                        .ensure_extra_channels(&spawn_channels)
                        .await
                    {
                        tracing::warn!(
                            workspace_id = %workspace.workspace_id,
                            error = %error,
                            "failed to ensure extra channels for spawned agent"
                        );
                    }
                    let _ = workspace
                        .ws_control_tx
                        .send(WsControl::Subscribe(spawn_channels.clone()))
                        .await;
                }
            }
            if let Some(task) = effective_task.clone() {
                workers.initial_tasks.insert(name.clone(), task);
            }
            let worker_pid = workers.worker_pid(&name);
            state.agents.insert(
                name.clone(),
                PersistedAgent {
                    runtime: runtime.clone(),
                    parent: None,
                    channels: payload.agent.channels.clone(),
                    pid: worker_pid,
                    started_at: Some(
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    ),
                    spec: Some(payload.agent.clone()),
                    restart_policy: payload.agent.restart_policy.clone(),
                    initial_task: effective_task.clone(),
                },
            );
            state.save(state_path)?;

            // Register with supervisor for auto-restart
            let restart_policy = payload.agent.restart_policy.clone().unwrap_or_default();
            let initial_task_for_supervisor = workers.initial_tasks.get(&name).cloned();
            workers.supervisor.register(
                &name,
                payload.agent.clone(),
                None,
                initial_task_for_supervisor,
                payload.skip_relay_prompt,
                restart_policy,
            );
            workers.metrics.on_spawn(&name);

            *agent_spawn_count += 1;
            telemetry.track(TelemetryEvent::AgentSpawn {
                cli: payload.agent.cli.clone().unwrap_or_default(),
                runtime: format!("{:?}", runtime),
            });

            let spawned_provider = payload.agent.provider.clone();
            let spawned_cli = payload.agent.cli.clone();
            let spawned_model = payload.agent.model.clone();

            send_ok(
                out_tx,
                frame.request_id,
                json!({
                    "name": name,
                    "runtime": runtime,
                    "provider": spawned_provider.clone(),
                    "pre_registered": worker_relay_key.is_some(),
                    "warning": preregistration_warning.clone(),
                }),
            )
            .await?;
            send_event(
                out_tx,
                json!({
                    "kind": "agent_spawned",
                    "name": name,
                    "runtime": runtime,
                    "provider": spawned_provider,
                    "cli": spawned_cli,
                    "model": spawned_model,
                    "parent": Value::Null,
                    "pre_registered": worker_relay_key.is_some(),
                    "registration_warning": preregistration_warning,
                }),
            )
            .await?;
            if let Some(ws_control_tx) = ws_control_tx {
                publish_agent_state_transition(ws_control_tx, &name, "spawned", Some("sdk_spawn"))
                    .await;
            }
            Ok(false)
        }
        "send_message" => {
            let payload: SendMessagePayload = serde_json::from_value(frame.payload)
                .context("send_message payload must contain `to` and `text`")?;
            let mut from = normalize_sender(payload.from);
            if !is_system_sender(&from) && !workers.has_worker(&from) && !from.contains(':') {
                from = format!("human:{from}");
            }

            if !is_system_sender(&from) && !workers.has_worker(&from) {
                send_error(
                    out_tx,
                    frame.request_id,
                    "sender_not_found",
                    format!("Sender '{}' is not a registered agent", from),
                    false,
                    None,
                )
                .await?;
                return Ok(false);
            }
            let priority = payload.priority.unwrap_or(2);
            let event_id = format!("sdk_{}", Uuid::new_v4().simple());
            let selected_workspace = if let Some(workspace_id) = payload.workspace_id.as_deref() {
                let Some(workspace) = workspaces
                    .iter()
                    .find(|workspace| workspace.workspace_id == workspace_id)
                    .cloned()
                else {
                    send_error(
                        out_tx,
                        frame.request_id,
                        "workspace_not_found",
                        format!("workspace '{}' is not attached", workspace_id),
                        false,
                        None,
                    )
                    .await?;
                    return Ok(false);
                };
                workspace
            } else if let Some(workspace_alias) = payload.workspace_alias.as_deref() {
                let Some(workspace) = workspaces
                    .iter()
                    .find(|workspace| {
                        workspace
                            .workspace_alias
                            .as_deref()
                            .is_some_and(|alias| alias.eq_ignore_ascii_case(workspace_alias))
                    })
                    .cloned()
                else {
                    send_error(
                        out_tx,
                        frame.request_id,
                        "workspace_not_found",
                        format!("workspace alias '{}' is not attached", workspace_alias),
                        false,
                        None,
                    )
                    .await?;
                    return Ok(false);
                };
                workspace
            } else if workspaces.len() == 1 {
                workspaces[0].clone()
            } else if let Some(default_workspace_id) = default_workspace_id {
                let Some(workspace) = workspaces
                    .iter()
                    .find(|workspace| workspace.workspace_id == default_workspace_id)
                    .cloned()
                else {
                    send_error(
                        out_tx,
                        frame.request_id,
                        "workspace_not_found",
                        format!("default workspace '{}' not found", default_workspace_id),
                        false,
                        None,
                    )
                    .await?;
                    return Ok(false);
                };
                workspace
            } else {
                send_error(
                    out_tx,
                    frame.request_id,
                    "ambiguous_workspace",
                    "workspaceId or workspaceAlias is required when multiple workspaces are attached".to_string(),
                    false,
                    None,
                )
                .await?;
                return Ok(false);
            };

            if workers.has_worker(&payload.to) {
                queue_and_try_delivery_raw(
                    workers,
                    pending_deliveries,
                    &payload.to,
                    &event_id,
                    &from,
                    &payload.to,
                    &payload.text,
                    payload.thread_id,
                    Some(selected_workspace.workspace_id.clone()),
                    selected_workspace.workspace_alias.clone(),
                    priority,
                    payload.mode,
                    delivery_retry_interval(),
                )
                .await?;

                send_ok(
                    out_tx,
                    frame.request_id,
                    json!({
                        "delivered": true,
                        "to": payload.to,
                        "event_id": event_id,
                        "targets": [payload.to],
                        "workspace_id": selected_workspace.workspace_id,
                        "workspace_alias": selected_workspace.workspace_alias,
                    }),
                )
                .await?;
            } else if let Some(_http) = relaycast_http {
                let to = payload.to.clone();
                let eid = event_id.clone();
                match selected_workspace
                    .http_client
                    .send(&to, &payload.text)
                    .await
                {
                    Ok(()) => {
                        tracing::info!(to = %to, event_id = %eid, "relaycast publish succeeded");
                        send_ok(
                            out_tx,
                            frame.request_id,
                            json!({
                                "delivered": false,
                                "relaycast_published": true,
                                "to": to,
                                "event_id": eid,
                                "targets": [to],
                                "workspace_id": selected_workspace.workspace_id,
                                "workspace_alias": selected_workspace.workspace_alias,
                            }),
                        )
                        .await?;
                        send_event(
                            out_tx,
                            json!({
                                "kind": "relaycast_published",
                                "event_id": eid,
                                "to": to,
                                "target_type": if to.starts_with('#') { "channel" } else { "dm" },
                            }),
                        )
                        .await?;
                    }
                    Err(e) => {
                        tracing::warn!(to = %to, event_id = %eid, err = %e, "relaycast publish failed");
                        send_error(
                            out_tx,
                            frame.request_id,
                            "relaycast_publish_failed",
                            format!("failed to publish to Relaycast: {e}"),
                            true,
                            None,
                        )
                        .await?;
                        send_event(
                            out_tx,
                            json!({
                                "kind": "relaycast_publish_failed",
                                "event_id": eid,
                                "to": to,
                                "reason": e.to_string(),
                            }),
                        )
                        .await?;
                    }
                }
            } else {
                send_error(
                    out_tx,
                    frame.request_id,
                    "agent_not_found",
                    format!(
                        "no local worker named '{}' and no Relaycast connection",
                        payload.to
                    ),
                    false,
                    None,
                )
                .await?;
            }
            Ok(false)
        }
        "send_input" => {
            let payload: SendInputPayload = serde_json::from_value(frame.payload)
                .context("send_input payload must contain `name` and `data`")?;

            let Some(handle) = workers.workers.get_mut(&payload.name) else {
                send_error(
                    out_tx,
                    frame.request_id,
                    "agent_not_found",
                    format!("unknown worker '{}'", payload.name),
                    false,
                    None,
                )
                .await?;
                return Ok(false);
            };

            let bytes = payload.data.as_bytes();
            handle
                .stdin
                .write_all(bytes)
                .await
                .with_context(|| format!("failed writing input to worker '{}'", payload.name))?;
            handle
                .stdin
                .flush()
                .await
                .with_context(|| format!("failed flushing worker '{}' stdin", payload.name))?;

            send_ok(
                out_tx,
                frame.request_id,
                json!({
                    "name": payload.name,
                    "bytes_written": bytes.len(),
                }),
            )
            .await?;
            Ok(false)
        }
        "resize_pty" => {
            let payload: ResizePtyPayload = serde_json::from_value(frame.payload)
                .context("resize_pty payload must contain `name`, `rows`, and `cols`")?;

            if payload.rows == 0 || payload.cols == 0 {
                send_error(
                    out_tx,
                    frame.request_id,
                    "invalid_dimensions",
                    "rows and cols must be >= 1".to_string(),
                    false,
                    None,
                )
                .await?;
                return Ok(false);
            }

            let Some(handle) = workers.workers.get(&payload.name) else {
                send_error(
                    out_tx,
                    frame.request_id,
                    "agent_not_found",
                    format!("unknown worker '{}'", payload.name),
                    false,
                    None,
                )
                .await?;
                return Ok(false);
            };

            if handle.spec.runtime != AgentRuntime::Pty {
                send_error(
                    out_tx,
                    frame.request_id,
                    "unsupported_operation",
                    format!(
                        "resize_pty is only supported for PTY agents, '{}' is {:?}",
                        payload.name, handle.spec.runtime
                    ),
                    false,
                    None,
                )
                .await?;
                return Ok(false);
            }

            workers
                .send_to_worker(
                    &payload.name,
                    "resize_pty",
                    None,
                    json!({
                        "rows": payload.rows,
                        "cols": payload.cols,
                    }),
                )
                .await?;

            send_ok(
                out_tx,
                frame.request_id,
                json!({
                    "name": payload.name,
                    "rows": payload.rows,
                    "cols": payload.cols,
                }),
            )
            .await?;
            Ok(false)
        }
        "set_model" => {
            let payload: SetModelPayload = serde_json::from_value(frame.payload)
                .context("set_model payload must contain `name` and `model`")?;
            let timeout_ms = payload.timeout_ms;

            let Some(handle) = workers.workers.get_mut(&payload.name) else {
                send_error(
                    out_tx,
                    frame.request_id,
                    "agent_not_found",
                    format!("unknown worker '{}'", payload.name),
                    false,
                    None,
                )
                .await?;
                return Ok(false);
            };

            let model_command = format!("/model {}\n", payload.model);
            handle
                .stdin
                .write_all(model_command.as_bytes())
                .await
                .with_context(|| {
                    format!("failed writing model command to worker '{}'", payload.name)
                })?;
            handle
                .stdin
                .flush()
                .await
                .with_context(|| format!("failed flushing worker '{}' stdin", payload.name))?;
            if let Some(timeout_ms) = timeout_ms {
                tracing::info!(
                    name = %payload.name,
                    timeout_ms,
                    "set_model timeout_ms is currently advisory only"
                );
            }

            send_ok(
                out_tx,
                frame.request_id,
                json!({
                    "name": payload.name,
                    "model": payload.model,
                    "success": true,
                }),
            )
            .await?;
            Ok(false)
        }
        "get_metrics" => {
            let payload: GetMetricsPayload = serde_json::from_value(frame.payload)
                .context("get_metrics payload must be an object")?;

            let mut agents: Vec<AgentMetrics> = if let Some(agent_name) = payload.agent {
                let Some(handle) = workers.workers.get(&agent_name) else {
                    send_error(
                        out_tx,
                        frame.request_id,
                        "agent_not_found",
                        format!("unknown worker '{}'", agent_name),
                        false,
                        None,
                    )
                    .await?;
                    return Ok(false);
                };
                vec![build_agent_metrics(handle)]
            } else {
                workers
                    .workers
                    .values()
                    .map(build_agent_metrics)
                    .collect::<Vec<_>>()
            };
            agents.sort_by(|a, b| a.name.cmp(&b.name));

            let broker_stats = workers.metrics.snapshot(workers.workers.len());
            send_ok(
                out_tx,
                frame.request_id,
                json!({
                    "agents": agents,
                    "broker": broker_stats,
                }),
            )
            .await?;
            Ok(false)
        }
        "get_crash_insights" => {
            send_ok(out_tx, frame.request_id, crash_insights.to_json()).await?;
            Ok(false)
        }
        "release_agent" => {
            let payload: ReleasePayload = serde_json::from_value(frame.payload)
                .context("release_agent payload must contain `name`")?;

            // Check agent exists before attempting release.
            // If the agent recently crashed and was reaped from workers but is
            // still in the supervisor's pending-restart state, unregister it so
            // it doesn't get re-spawned, then return success.
            if !workers.workers.contains_key(&payload.name) {
                if workers.supervisor.is_supervised(&payload.name) {
                    workers.supervisor.unregister(&payload.name);
                    tracing::info!(
                        name = %payload.name,
                        "released agent from supervisor pending-restart state"
                    );
                    state.agents.remove(&payload.name);
                    state.save(state_path)?;
                    send_ok(out_tx, frame.request_id, json!({"name": payload.name})).await?;
                    send_event(out_tx, json!({"kind":"agent_released","name":payload.name}))
                        .await?;
                    return Ok(false);
                }
                if let Some(http) = relaycast_http {
                    http.forget_agent_registration(&payload.name);
                }
                state.agents.remove(&payload.name);
                state.save(state_path)?;
                send_error(
                    out_tx,
                    frame.request_id,
                    "agent_not_found",
                    format!("unknown worker '{}'", payload.name),
                    false,
                    None,
                )
                .await?;
                return Ok(false);
            }

            tracing::info!(
                name = %payload.name,
                reason = ?payload.reason,
                "releasing worker from sdk request"
            );

            let lifetime_seconds = workers
                .workers
                .get(&payload.name)
                .map(|h| h.spawned_at.elapsed().as_secs())
                .unwrap_or(0);

            // Capture continuity data before releasing the agent.
            let persisted = state.agents.get(&payload.name).cloned();
            if let Some(ref agent_data) = persisted {
                let continuity_dir = continuity_dir(state_path);
                if let Err(e) = std::fs::create_dir_all(&continuity_dir) {
                    tracing::warn!(error = %e, "failed to create continuity dir");
                } else {
                    // Fetch recent DMs from relaycast if available.
                    let message_history = if let Some(http) = relaycast_http {
                        match http.get_dms(&payload.name, 50).await {
                            Ok(msgs) => msgs,
                            Err(e) => {
                                tracing::warn!(
                                    error = %e,
                                    "failed to fetch DMs for continuity"
                                );
                                vec![]
                            }
                        }
                    } else {
                        vec![]
                    };

                    let released_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();

                    let reason_str = payload
                        .reason
                        .as_deref()
                        .unwrap_or("released via SDK request");

                    let cli = agent_data.spec.as_ref().and_then(|s| s.cli.clone());
                    let cwd = agent_data.spec.as_ref().and_then(|s| s.cwd.clone());

                    let continuity = json!({
                        "agent_name": payload.name,
                        "cli": cli,
                        "initial_task": agent_data.initial_task,
                        "cwd": cwd,
                        "released_at": released_at,
                        "lifetime_seconds": lifetime_seconds,
                        "message_history": message_history,
                        "summary": reason_str,
                    });

                    let continuity_file = continuity_dir.join(format!("{}.json", payload.name));
                    match std::fs::write(
                        &continuity_file,
                        serde_json::to_string_pretty(&continuity).unwrap_or_default(),
                    ) {
                        Ok(()) => {
                            tracing::info!(
                                agent = %payload.name,
                                path = %continuity_file.display(),
                                "saved continuity data"
                            );
                        }
                        Err(e) => {
                            tracing::warn!(
                                error = %e,
                                "failed to write continuity file"
                            );
                        }
                    }
                }
            }

            // Unregister from supervisor (intentional release — no restart)
            workers.supervisor.unregister(&payload.name);
            workers.metrics.on_release(&payload.name);

            workers.release(&payload.name).await?;
            if let Some(http) = relaycast_http {
                if let Err(error) = http.mark_agent_offline(&payload.name).await {
                    tracing::warn!(
                        worker = %payload.name,
                        error = %error,
                        "failed to mark released worker offline in relaycast"
                    );
                }
            }
            let dropped = drop_pending_for_worker(pending_deliveries, &payload.name);
            state.agents.remove(&payload.name);
            state.save(state_path)?;

            telemetry.track(TelemetryEvent::AgentRelease {
                cli: String::new(),
                release_reason: payload.reason.unwrap_or_else(|| "sdk_request".to_string()),
                lifetime_seconds,
            });

            send_ok(out_tx, frame.request_id, json!({"name": payload.name})).await?;
            send_event(out_tx, json!({"kind":"agent_released","name":payload.name})).await?;
            if let Some(ws_control_tx) = ws_control_tx {
                publish_agent_state_transition(
                    ws_control_tx,
                    &payload.name,
                    "exited",
                    Some("sdk_release"),
                )
                .await;
            }
            if dropped > 0 {
                send_event(
                    out_tx,
                    json!({
                        "kind":"delivery_dropped",
                        "name": payload.name,
                        "count": dropped,
                        "reason":"released",
                    }),
                )
                .await?;
            }
            Ok(false)
        }
        "list_agents" => {
            send_ok(out_tx, frame.request_id, json!({"agents": workers.list()})).await?;
            Ok(false)
        }
        "get_status" => {
            let agents: Vec<Value> = workers.list();
            let pending: Vec<Value> = pending_deliveries
                .values()
                .map(|pd| {
                    json!({
                        "delivery_id": pd.delivery.delivery_id,
                        "worker_name": pd.worker_name,
                        "event_id": pd.delivery.event_id,
                        "attempts": pd.attempts,
                    })
                })
                .collect();
            send_ok(
                out_tx,
                frame.request_id,
                json!({
                    "agent_count": agents.len(),
                    "agents": agents,
                    "pending_delivery_count": pending.len(),
                    "pending_deliveries": pending,
                }),
            )
            .await?;
            Ok(false)
        }
        "preflight_agents" => {
            // Pre-register a batch of agents with Relaycast in parallel background tasks.
            // Warms the token cache so subsequent spawn_agent calls are instant cache hits.
            // Responds immediately — registration happens concurrently in the background.
            #[derive(serde::Deserialize)]
            struct PreflightAgentsPayload {
                agents: Vec<PreflightAgentEntry>,
            }
            #[derive(serde::Deserialize)]
            struct PreflightAgentEntry {
                name: String,
                cli: String,
            }

            let payload: PreflightAgentsPayload = serde_json::from_value(frame.payload)
                .context("preflight_agents payload must contain `agents` array")?;

            let count = payload.agents.len();
            send_ok(out_tx, frame.request_id, json!({ "queued": count })).await?;

            if let Some(http) = relaycast_http {
                for entry in payload.agents {
                    let http_clone = http.clone();
                    tokio::spawn(async move {
                        match tokio::time::timeout(
                            Duration::from_secs(30),
                            http_clone.register_agent_token(&entry.name, Some(entry.cli.as_str())),
                        )
                        .await
                        {
                            Ok(Ok(_)) => tracing::debug!(
                                name = %entry.name,
                                "preflight: agent pre-registered"
                            ),
                            Ok(Err(e)) => tracing::warn!(
                                name = %entry.name,
                                error = %e,
                                "preflight: agent pre-registration failed"
                            ),
                            Err(_) => tracing::warn!(
                                name = %entry.name,
                                "preflight: agent pre-registration timed out (30s)"
                            ),
                        }
                    });
                }
            }

            Ok(false)
        }
        "shutdown" => {
            send_ok(out_tx, frame.request_id, json!({"status":"shutting_down"})).await?;
            Ok(true)
        }
        other => {
            send_error(
                out_tx,
                frame.request_id,
                "unknown_type",
                format!("unsupported message type '{other}'"),
                false,
                None,
            )
            .await?;
            Ok(false)
        }
    }
}

async fn queue_and_try_delivery(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    worker_name: &str,
    mapped: &relay_broker::types::InboundRelayEvent,
    retry_interval: Duration,
) -> Result<()> {
    queue_and_try_delivery_raw(
        workers,
        pending_deliveries,
        worker_name,
        &mapped.event_id,
        &mapped.from,
        &mapped.target,
        &mapped.text,
        mapped.thread_id.clone(),
        Some(mapped.workspace_id.clone()),
        mapped.workspace_alias.clone(),
        mapped.priority.as_u8(),
        MessageInjectionMode::Wait,
        retry_interval,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn queue_and_try_delivery_raw(
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    worker_name: &str,
    event_id: &str,
    from: &str,
    target: &str,
    body: &str,
    thread_id: Option<String>,
    workspace_id: Option<String>,
    workspace_alias: Option<String>,
    priority: u8,
    injection_mode: MessageInjectionMode,
    retry_interval: Duration,
) -> Result<()> {
    let delivery = RelayDelivery {
        delivery_id: format!("del_{}", Uuid::new_v4().simple()),
        event_id: event_id.to_string(),
        workspace_id,
        workspace_alias,
        from: from.to_string(),
        target: target.to_string(),
        body: body.to_string(),
        thread_id,
        priority: Some(priority),
        injection_mode,
    };
    let delivery_id = delivery.delivery_id.clone();
    pending_deliveries.insert(
        delivery_id.clone(),
        PendingDelivery {
            worker_name: worker_name.to_string(),
            delivery,
            attempts: 0,
            next_retry_at: Instant::now(),
        },
    );

    let _ =
        retry_pending_delivery(&delivery_id, workers, pending_deliveries, retry_interval).await?;
    Ok(())
}

async fn retry_pending_delivery(
    delivery_id: &str,
    workers: &mut WorkerRegistry,
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    retry_interval: Duration,
) -> Result<Option<(String, u32, String)>> {
    let pending = match pending_deliveries.get(delivery_id) {
        Some(pending) => pending.clone(),
        None => return Ok(None),
    };

    if pending.attempts >= MAX_DELIVERY_RETRIES {
        pending_deliveries.remove(delivery_id);
        return Ok(None);
    }

    if !workers.has_worker(&pending.worker_name) {
        pending_deliveries.remove(delivery_id);
        return Ok(None);
    }

    match workers
        .deliver(&pending.worker_name, pending.delivery.clone())
        .await
    {
        Ok(()) => {
            if let Some(current) = pending_deliveries.get_mut(delivery_id) {
                current.attempts = current.attempts.saturating_add(1);
                current.next_retry_at = Instant::now() + retry_interval;
                return Ok(Some((
                    current.worker_name.clone(),
                    current.attempts,
                    current.delivery.event_id.clone(),
                )));
            }
            Ok(None)
        }
        Err(error) => {
            if let Some(current) = pending_deliveries.get_mut(delivery_id) {
                current.next_retry_at = Instant::now() + retry_interval;
            }
            Err(error)
        }
    }
}

async fn resolve_dm_participants(
    relaycast_http: &RelaycastHttpClient,
    dm_participants_cache: &mut HashMap<String, (Instant, Vec<String>)>,
    workspace_id: &str,
    conversation_id: &str,
) -> Vec<String> {
    let workspace_id = workspace_id.trim();
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return vec![];
    }
    let cache_key = format!("{workspace_id}:{conversation_id}");

    if let Some((fetched_at, participants)) = dm_participants_cache.get(&cache_key) {
        if fetched_at.elapsed() < DM_PARTICIPANT_CACHE_TTL {
            return participants.clone();
        }
    }

    let fetched = relaycast_http
        .get_dm_participants(conversation_id)
        .await
        .unwrap_or_else(|error| {
            tracing::debug!(
                workspace_id = %workspace_id,
                conversation_id = %conversation_id,
                error = %error,
                "failed resolving DM participants"
            );
            vec![]
        });

    dm_participants_cache.insert(cache_key, (Instant::now(), fetched.clone()));
    fetched
}

fn drop_pending_for_worker(
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    worker_name: &str,
) -> usize {
    let before = pending_deliveries.len();
    pending_deliveries.retain(|_, pending| pending.worker_name != worker_name);
    before.saturating_sub(pending_deliveries.len())
}

fn should_clear_pending_delivery_for_event(
    pending: Option<&PendingDelivery>,
    event_id: Option<&str>,
) -> bool {
    let Some(pending) = pending else {
        return true;
    };

    let Some(event_id) = event_id
        .map(str::trim)
        .filter(|event_id| !event_id.is_empty())
    else {
        return true;
    };

    pending.delivery.event_id == event_id
}

fn clear_pending_delivery_if_event_matches(
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    delivery_id: &str,
    event_id: Option<&str>,
    worker_name: &str,
    worker_signal: &str,
) {
    let pending = pending_deliveries.get(delivery_id);
    if should_clear_pending_delivery_for_event(pending, event_id) {
        pending_deliveries.remove(delivery_id);
        return;
    }

    if let Some(pending) = pending {
        tracing::warn!(
            target = "agent_relay::broker",
            worker = %worker_name,
            signal = %worker_signal,
            delivery_id = %delivery_id,
            expected_event_id = %pending.delivery.event_id,
            received_event_id = %event_id.unwrap_or(""),
            "ignoring stale delivery lifecycle event due to event_id mismatch"
        );
    }
}

async fn run_headless_worker(cmd: HeadlessCommand) -> Result<()> {
    let provider: ProtocolHeadlessProvider = cmd.provider.into();
    let provider_name = headless_provider_cli_name(&provider);

    let (out_tx, mut out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(512);
    tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if let Ok(line) = serde_json::to_string(&frame) {
                use std::io::Write;
                let mut stdout = std::io::stdout().lock();
                let _ = stdout.write_all(line.as_bytes());
                let _ = stdout.write_all(b"\n");
                let _ = stdout.flush();
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut worker_name = cmd
        .agent_name
        .clone()
        .unwrap_or_else(|| format!("headless-{provider_name}"));
    while let Ok(Some(line)) = lines.next_line().await {
        let frame: ProtocolEnvelope<Value> = match serde_json::from_str(&line) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = send_frame(
                    &out_tx,
                    "worker_error",
                    None,
                    json!({
                        "code":"invalid_frame",
                        "message": error.to_string(),
                        "retryable": false,
                    }),
                )
                .await;
                continue;
            }
        };

        match frame.msg_type.as_str() {
            "init_worker" => {
                worker_name = cmd
                    .agent_name
                    .clone()
                    .or_else(|| {
                        frame
                            .payload
                            .get("agent")
                            .and_then(|a| a.get("name"))
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    })
                    .unwrap_or_else(|| format!("headless-{provider_name}"));

                let _ = send_frame(
                    &out_tx,
                    "worker_ready",
                    frame.request_id,
                    json!({
                        "name": &worker_name,
                        "runtime": "headless",
                    }),
                )
                .await;
            }
            "deliver_relay" => {
                let delivery: RelayDelivery = match serde_json::from_value(frame.payload) {
                    Ok(d) => d,
                    Err(error) => {
                        let _ = send_frame(
                            &out_tx,
                            "worker_error",
                            frame.request_id,
                            json!({
                                "code":"invalid_delivery",
                                "message": error.to_string(),
                                "retryable": false,
                            }),
                        )
                        .await;
                        continue;
                    }
                };

                let timestamp = chrono::Utc::now().timestamp_millis();
                let delivery_id = delivery.delivery_id;
                let event_id = delivery.event_id;

                let _ = send_frame(
                    &out_tx,
                    "delivery_queued",
                    None,
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                        "agent": &worker_name,
                        "timestamp": timestamp,
                    }),
                )
                .await;

                let _ = send_frame(
                    &out_tx,
                    "delivery_injected",
                    None,
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                        "agent": &worker_name,
                        "timestamp": timestamp,
                    }),
                )
                .await;

                let _ = send_frame(
                    &out_tx,
                    "delivery_active",
                    None,
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                        "pattern": format!("headless:{}", provider_name),
                    }),
                )
                .await;

                let _ = send_frame(
                    &out_tx,
                    "delivery_verified",
                    None,
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                    }),
                )
                .await;

                let _ = send_frame(
                    &out_tx,
                    "delivery_ack",
                    frame.request_id,
                    json!({
                        "delivery_id": delivery_id,
                        "event_id": event_id,
                    }),
                )
                .await;
            }
            "ping" => {
                let ts = frame
                    .payload
                    .get("ts_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let _ = send_frame(&out_tx, "pong", frame.request_id, json!({"ts_ms": ts})).await;
            }
            "shutdown_worker" => {
                break;
            }
            other => {
                let _ = send_frame(
                    &out_tx,
                    "worker_error",
                    frame.request_id,
                    json!({
                        "code":"unknown_type",
                        "message": format!("unsupported message type '{}'", other),
                        "retryable": false,
                    }),
                )
                .await;
            }
        }
    }

    let _ = send_frame(
        &out_tx,
        "worker_exited",
        None,
        json!({"code": Value::Null, "signal": Value::Null}),
    )
    .await;

    Ok(())
}

async fn send_ok(
    tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    request_id: Option<String>,
    result: Value,
) -> Result<()> {
    send_frame(tx, "ok", request_id, json!({"result": result})).await
}

async fn send_error(
    tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    request_id: Option<String>,
    code: &str,
    message: String,
    retryable: bool,
    data: Option<Value>,
) -> Result<()> {
    send_frame(
        tx,
        "error",
        request_id,
        json!({
            "code": code,
            "message": message,
            "retryable": retryable,
            "data": data,
        }),
    )
    .await
}

async fn send_event(tx: &mpsc::Sender<ProtocolEnvelope<Value>>, payload: Value) -> Result<()> {
    send_frame(tx, "event", None, payload).await
}

async fn emit_http_api_event_with_timeout(
    tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    payload: Value,
    timeout_window: Duration,
) {
    match timeout(timeout_window, send_event(tx, payload)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!(
                target = "relay_broker::http_api",
                error = %error,
                "failed to enqueue HTTP API event"
            );
        }
        Err(_) => {
            tracing::warn!(
                target = "relay_broker::http_api",
                timeout_ms = %timeout_window.as_millis(),
                "timed out enqueuing HTTP API event"
            );
        }
    }
}

async fn send_frame(
    tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    msg_type: &str,
    request_id: Option<String>,
    payload: Value,
) -> Result<()> {
    tx.send(ProtocolEnvelope {
        v: PROTOCOL_VERSION,
        msg_type: msg_type.to_string(),
        request_id,
        payload,
    })
    .await
    .context("failed to enqueue outbound frame")
}

fn init_tracing() {
    let subscriber = tracing_subscriber::fmt::Subscriber::builder()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(true)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}

fn channels_from_csv(raw: &str) -> Vec<String> {
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
fn default_spawn_channels() -> Vec<String> {
    if let Ok(raw) = std::env::var("RELAY_DEFAULT_CHANNELS") {
        let parsed = channels_from_csv(&raw);
        if !parsed.is_empty() {
            return parsed;
        }
    }
    // channels: ["general", "engineering"] (must match ensure_default_channels)
    vec!["general".to_string(), "engineering".to_string()]
}

fn command_targets_self(cmd_event: &BrokerCommandEvent, self_agent_id: &str) -> bool {
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

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn delivery_retry_interval() -> Duration {
    let ms = std::env::var("AGENT_RELAY_DELIVERY_RETRY_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_DELIVERY_RETRY_MS);
    Duration::from_millis(ms.max(50))
}

fn http_api_local_delivery_timeout() -> Duration {
    let ms = std::env::var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS);
    Duration::from_millis(ms.max(100))
}

fn http_api_relaycast_send_timeout() -> Duration {
    let ms = std::env::var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS);
    Duration::from_millis(ms.max(500))
}

fn http_api_event_emit_timeout() -> Duration {
    let ms = std::env::var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_HTTP_API_EVENT_EMIT_TIMEOUT_MS);
    Duration::from_millis(ms.max(25))
}

fn normalize_channel(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('#') {
        trimmed.to_string()
    } else {
        format!("#{trimmed}")
    }
}

fn build_agent_state_transition_event(name: &str, state: &str, reason: Option<&str>) -> Value {
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

async fn publish_agent_state_transition(
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

fn normalize_identity_for_thread(raw: &str) -> String {
    raw.trim().trim_start_matches('@').to_ascii_lowercase()
}

fn json_scalar_to_string(value: &Value) -> Option<String> {
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

fn first_string(value: &Value, pointers: &[&str]) -> Option<String> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(json_scalar_to_string))
}

fn first_bool(value: &Value, pointers: &[&str]) -> Option<bool> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_bool))
}

fn first_u64(value: &Value, pointers: &[&str]) -> Option<u64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_u64))
}

fn first_i64(value: &Value, pointers: &[&str]) -> Option<i64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_i64))
}

fn relaycast_ws_control_dedup_key(
    workspace_id: &str,
    ws_type: &str,
    value: &Value,
) -> Option<String> {
    let identity = if ws_type == "agent.spawn_requested" {
        relaycast_ws_spawn_token(value)
            .or_else(|| {
                first_string(
                    value,
                    &[
                        "/event_id",
                        "/id",
                        "/payload/id",
                        "/payload/event_id",
                        "/agent/id",
                        "/agent/event_id",
                        "/message/id",
                        "/message/event_id",
                        "/message_id",
                    ],
                )
            })
            .or_else(|| first_string(value, &["/agent/name", "/payload/agent/name", "/name"]))
    } else {
        first_string(
            value,
            &[
                "/event_id",
                "/id",
                "/payload/id",
                "/payload/event_id",
                "/agent/id",
                "/agent/event_id",
                "/message/id",
                "/message/event_id",
                "/message_id",
            ],
        )
    }
    .or_else(|| serde_json::to_string(value).ok())?;
    Some(format!("control:{workspace_id}:{ws_type}:{identity}"))
}

fn relaycast_ws_spawn_token(value: &Value) -> Option<String> {
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

fn relaycast_spawn_control_dedup_key(workspace_id: &str, identity: &str) -> String {
    format!("control:{workspace_id}:agent.spawn_requested:{identity}")
}

fn relaycast_ws_should_apply_local_spawn_echo_dedup(
    control_dedup_key: Option<&str>,
    local_spawn_echo_key: &str,
) -> bool {
    control_dedup_key != Some(local_spawn_echo_key)
}

fn note_local_spawn_control_dedup(
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

fn remove_local_spawn_control_dedup(
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
        dedup.remove(&key);
    }
    if let Some(relay_key) = relay_key.map(str::trim).filter(|value| !value.is_empty()) {
        let key = relaycast_spawn_control_dedup_key(workspace_id, relay_key);
        dedup.remove(&key);
    }
}

fn is_unknown_worker_error_message(message: &str) -> bool {
    message.contains("unknown worker '")
}

fn is_relaycast_self_control_target(
    name: &str,
    workspace_self_name: &str,
    workspace_self_names: &HashSet<String>,
) -> bool {
    let normalized = normalize_identity_for_thread(name);
    normalized == normalize_identity_for_thread(workspace_self_name)
        || workspace_self_names.contains(&normalized)
}

fn message_sender(value: &Value) -> Option<String> {
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

fn message_target(value: &Value) -> Option<String> {
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

fn message_preview(value: &Value) -> Option<String> {
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

fn truncate_thread_preview(input: &str, max_len: usize) -> String {
    let trimmed = input.trim();
    if trimmed.len() <= max_len {
        return trimmed.to_string();
    }
    let boundary = floor_char_boundary(trimmed, max_len);
    let mut out = trimmed[..boundary].to_string();
    out.push_str("...");
    out
}

fn parse_sort_key_from_raw_timestamp(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(epoch) = trimmed.parse::<i64>() {
        return Some(epoch);
    }
    chrono::DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn message_timestamp_string(value: &Value) -> Option<String> {
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

fn message_sort_key(value: &Value, index: usize) -> i64 {
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

fn message_thread_id(value: &Value) -> Option<String> {
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

fn is_self_identity(value: &str, self_names: &HashSet<String>) -> bool {
    let normalized = normalize_identity_for_thread(value);
    !normalized.is_empty()
        && self_names
            .iter()
            .any(|self_name| normalize_identity_for_thread(self_name) == normalized)
}

fn derive_thread_name(message: &Value, thread_id: &str, self_names: &HashSet<String>) -> String {
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

fn thread_unread_increment(message: &Value, self_names: &HashSet<String>) -> usize {
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

fn build_thread_infos(messages: &[Value], self_names: &HashSet<String>) -> Vec<ThreadInfo> {
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

fn record_thread_history_event(history: &mut VecDeque<Value>, event: Value) {
    if history.len() >= THREAD_HISTORY_LIMIT {
        let _ = history.pop_front();
    }
    history.push_back(event);
}

/// Get current terminal size via ioctl.
#[cfg(unix)]
fn get_terminal_size() -> Option<(u16, u16)> {
    use nix::libc;
    use nix::pty::Winsize;

    let mut winsize = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    unsafe {
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut winsize) == 0 {
            Some((winsize.ws_row, winsize.ws_col))
        } else {
            None
        }
    }
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
fn extract_mcp_message_ids(buffer: &str) -> Vec<String> {
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

/// Check if a process with the given PID is alive.
#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    // kill(pid, 0) checks existence without sending a signal
    let rc = unsafe { nix::libc::kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    // EPERM means the process exists but we can't signal it (different user)
    let err = std::io::Error::last_os_error();
    err.raw_os_error() == Some(nix::libc::EPERM)
}

/// Returns the continuity directory path derived from the state file path.
/// State path is always `{cwd}/.agent-relay/state.json`, so parent is `{cwd}/.agent-relay/`.
fn continuity_dir(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .expect("state_path always has a parent (.agent-relay/)")
        .join("continuity")
}

/// Create ephemeral runtime paths in the system temp directory.
///
/// Unlike `ensure_runtime_paths`, this function:
/// - Writes nothing to the project directory
/// - Uses a deterministic temp directory derived from cwd+broker name so
///   duplicate brokers still collide on the same lock/PID files
///
/// The temp directory is NOT removed on exit — the OS cleans it up on reboot.
/// State and pending-delivery files are still written there so they don't
/// interfere with the project tree; they're just ephemeral.
/// Ephemeral mode: no lock file, no PID file, no temp directory.
/// The broker lifecycle is tied to the parent process via stdin — when the
/// parent (SDK client) exits, stdin gets EOF and the broker shuts down.
/// Single-instance enforcement is unnecessary here because each SDK client
/// manages its own child process.
fn ensure_ephemeral_paths(_cwd: &Path, _broker_name: &str) -> Result<RuntimePaths> {
    // Use a random temp subdir so concurrent ephemeral brokers don't collide
    // on state files.
    let root = std::env::temp_dir().join(format!("agent-relay-ephemeral-{}", std::process::id()));
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create ephemeral temp dir {}", root.display()))?;

    Ok(RuntimePaths {
        persist: false,
        state: root.join("state.json"),
        pending: root.join("pending.json"),
        pid: PathBuf::new(),
        _lock: None,
    })
}

fn ensure_runtime_paths(cwd: &Path, broker_name: &str) -> Result<RuntimePaths> {
    let root = cwd.join(".agent-relay");
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create runtime dir {}", root.display()))?;

    // Sanitise name for use in filenames — keep only alphanumeric and hyphens
    let safe_name: String = broker_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Lock and PID files are per-broker-name so concurrent workflows can coexist.
    let lock_path = root.join(format!("broker-{safe_name}.lock"));
    let pid_path = root.join(format!("broker-{safe_name}.pid"));
    let lock_file = std::fs::File::create(&lock_path)
        .with_context(|| format!("failed to create lock file {}", lock_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = lock_file.as_raw_fd();
        let rc = unsafe { nix::libc::flock(fd, nix::libc::LOCK_EX | nix::libc::LOCK_NB) };
        if rc != 0 {
            // Lock acquisition failed — check if the holder is still alive
            if let Ok(contents) = std::fs::read_to_string(&pid_path) {
                if let Ok(old_pid) = contents.trim().parse::<u32>() {
                    if !is_pid_alive(old_pid) {
                        tracing::warn!(
                            old_pid = old_pid,
                            "stale broker lock detected (PID {} is dead), recovering",
                            old_pid
                        );
                        // The old process is dead — remove stale PID file and retry lock.
                        // We drop and re-create the lock file to clear the stale flock.
                        drop(lock_file);
                        let lock_file = std::fs::File::create(&lock_path).with_context(|| {
                            format!(
                                "failed to re-create lock file after stale recovery {}",
                                lock_path.display()
                            )
                        })?;
                        let fd = lock_file.as_raw_fd();
                        let rc = unsafe {
                            nix::libc::flock(fd, nix::libc::LOCK_EX | nix::libc::LOCK_NB)
                        };
                        if rc != 0 {
                            anyhow::bail!(
                                "another broker instance is already running in this directory ({})",
                                root.display()
                            );
                        }
                        // Successfully recovered — write our PID and return
                        write_pid_file(&pid_path)?;
                        return Ok(RuntimePaths {
                            persist: true,
                            state: root.join(format!("state-{safe_name}.json")),
                            pending: root.join(format!("pending-{safe_name}.json")),
                            pid: pid_path,
                            _lock: Some(lock_file),
                        });
                    } else {
                        anyhow::bail!(
                            "another broker instance is already running in this directory (pid: {}, {})",
                            old_pid,
                            root.display()
                        );
                    }
                }
            }
            // PID file missing or unreadable while lock is held — treat as stale.
            // This happens when the user deletes .agent-relay/ while an old broker
            // is still alive, or during the shutdown race (PID deleted before flock
            // released).
            tracing::warn!(
                "broker lock held but no valid PID file found, treating as stale and recovering"
            );
            drop(lock_file);
            let lock_file = std::fs::File::create(&lock_path).with_context(|| {
                format!(
                    "failed to re-create lock file after stale recovery {}",
                    lock_path.display()
                )
            })?;
            let fd = lock_file.as_raw_fd();
            let rc = unsafe { nix::libc::flock(fd, nix::libc::LOCK_EX | nix::libc::LOCK_NB) };
            if rc != 0 {
                anyhow::bail!(
                    "another broker instance is already running in this directory ({})",
                    root.display()
                );
            }
            write_pid_file(&pid_path)?;
            return Ok(RuntimePaths {
                persist: true,
                state: root.join(format!("state-{safe_name}.json")),
                pending: root.join(format!("pending-{safe_name}.json")),
                pid: pid_path,
                _lock: Some(lock_file),
            });
        }
    }

    // Write our PID for crash recovery
    write_pid_file(&pid_path)?;

    Ok(RuntimePaths {
        persist: true,
        state: root.join(format!("state-{safe_name}.json")),
        pending: root.join(format!("pending-{safe_name}.json")),
        pid: pid_path,
        _lock: Some(lock_file),
    })
}

/// Write the current process PID to the given path atomically.
fn write_pid_file(path: &Path) -> Result<()> {
    let pid = std::process::id();
    let dir = path
        .parent()
        .with_context(|| format!("pid path has no parent: {}", path.display()))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)
        .with_context(|| format!("failed creating temp pid file in {}", dir.display()))?;
    use std::io::Write;
    write!(tmp, "{}", pid)?;
    tmp.persist(path)
        .with_context(|| format!("failed persisting pid file to {}", path.display()))?;
    tracing::info!(pid = pid, path = %path.display(), "wrote broker PID file");
    Ok(())
}

fn derive_ws_base_url_from_http(http_base: &str) -> String {
    let trimmed = http_base.trim();
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_string()
    }
}

impl BrokerState {
    fn load(path: &Path) -> Result<Self> {
        let body = std::fs::read_to_string(path)
            .with_context(|| format!("failed reading state file {}", path.display()))?;
        let state = serde_json::from_str::<Self>(&body)
            .with_context(|| format!("failed parsing state file {}", path.display()))?;
        Ok(state)
    }

    fn save(&self, path: &Path) -> Result<()> {
        let body = serde_json::to_vec_pretty(self)?;
        let dir = path
            .parent()
            .with_context(|| format!("state path has no parent: {}", path.display()))?;
        let mut tmp = tempfile::NamedTempFile::new_in(dir)
            .with_context(|| format!("failed creating temp file in {}", dir.display()))?;
        std::io::Write::write_all(&mut tmp, &body)
            .with_context(|| "failed writing to temp state file")?;
        tmp.persist(path)
            .with_context(|| format!("failed persisting state file to {}", path.display()))?;
        Ok(())
    }

    /// Remove persisted agents whose PIDs are no longer alive.
    /// Returns the names of agents that were cleaned up.
    #[cfg(unix)]
    fn reap_dead_agents(&mut self) -> Vec<String> {
        let dead: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, agent)| {
                if let Some(pid) = agent.pid {
                    !is_pid_alive(pid)
                } else {
                    // No PID recorded — stale entry from before PID tracking, remove it
                    true
                }
            })
            .map(|(name, _)| name.clone())
            .collect();

        for name in &dead {
            self.agents.remove(name);
        }
        dead
    }

    #[cfg(not(unix))]
    fn reap_dead_agents(&mut self) -> Vec<String> {
        // On non-Unix platforms, clear all agents without PID info
        let dead: Vec<String> = self
            .agents
            .iter()
            .filter(|(_, agent)| agent.pid.is_none())
            .map(|(name, _)| name.clone())
            .collect();
        for name in &dead {
            self.agents.remove(name);
        }
        dead
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeSet, HashMap, HashSet},
        time::{Duration, Instant},
    };

    use crate::helpers::{format_injection, terminal_query_responses};
    use relay_broker::protocol::{MessageInjectionMode, RelayDelivery};
    use serde_json::{json, Value};

    use super::{
        build_agent_state_transition_event, build_thread_infos, channels_from_csv, continuity_dir,
        delivery_retry_interval, derive_ws_base_url_from_http, detect_bypass_permissions_prompt,
        detect_claude_trust_prompt, display_target_for_dashboard, drop_pending_for_worker,
        extract_mcp_message_ids, http_api_event_emit_timeout, http_api_local_delivery_timeout,
        http_api_relaycast_send_timeout, is_auto_suggestion, is_bypass_selection_menu,
        is_in_editor_mode, is_relaycast_self_control_target, is_unknown_worker_error_message,
        normalize_channel, normalize_initial_task, normalize_sender,
        relaycast_spawn_control_dedup_key, relaycast_ws_control_dedup_key,
        relaycast_ws_should_apply_local_spawn_echo_dedup, relaycast_ws_spawn_token,
        sender_is_dashboard_label, should_clear_pending_delivery_for_event, strip_ansi,
        PendingDelivery, TerminalQueryParser,
    };
    use crate::helpers::floor_char_boundary;
    use relay_broker::dedup::DedupCache;
    use relay_broker::relaycast_ws::{
        format_worker_preregistration_error, RelaycastRegistrationError,
    };

    fn extract_kind_literals(source: &str) -> BTreeSet<String> {
        let marker = "\"kind\"";
        let mut kinds = BTreeSet::new();
        let mut cursor = 0;
        while let Some(offset) = source[cursor..].find(marker) {
            let mut start = cursor + offset + marker.len();
            if start >= source.len() {
                break;
            }
            if !source[start..].starts_with(':') {
                cursor = start;
                continue;
            }
            start += 1;
            while start < source.len() && source.as_bytes()[start].is_ascii_whitespace() {
                start += 1;
            }
            if start >= source.len() || source.as_bytes()[start] != b'"' {
                cursor = start;
                continue;
            }
            start += 1;
            if let Some(end) = source[start..].find('"') {
                let candidate = &source[start..start + end];
                if !candidate.is_empty()
                    && candidate
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
                {
                    kinds.insert(candidate.to_string());
                }
            }
            cursor = start;
            if cursor >= source.len() {
                break;
            }
        }
        kinds
    }

    #[test]
    fn parses_channels() {
        assert_eq!(channels_from_csv("general,ops"), vec!["general", "ops"]);
    }

    #[test]
    fn channel_normalization() {
        assert_eq!(normalize_channel("general"), "#general");
        assert_eq!(normalize_channel("#ops"), "#ops");
    }

    #[test]
    fn normalize_initial_task_drops_empty_values() {
        assert_eq!(normalize_initial_task(None), None);
        assert_eq!(normalize_initial_task(Some(String::new())), None);
        assert_eq!(normalize_initial_task(Some("   ".to_string())), None);
    }

    #[test]
    fn normalize_initial_task_keeps_non_empty_values() {
        assert_eq!(
            normalize_initial_task(Some("Ship the patch".to_string())),
            Some("Ship the patch".to_string())
        );
    }

    #[test]
    fn ws_base_derivation() {
        assert_eq!(
            derive_ws_base_url_from_http("https://api.relaycast.dev"),
            "wss://api.relaycast.dev"
        );
        assert_eq!(
            derive_ws_base_url_from_http("http://localhost:8787"),
            "ws://localhost:8787"
        );
    }

    #[test]
    fn relaycast_control_dedup_key_prefers_event_id() {
        let value = json!({
            "type": "agent.spawn_requested",
            "event_id": "evt_123",
            "agent": { "name": "worker-a", "cli": "claude", "task": "Ship it" }
        });

        assert_eq!(
            relaycast_ws_control_dedup_key("ws_1", "agent.spawn_requested", &value),
            Some("control:ws_1:agent.spawn_requested:evt_123".to_string())
        );
    }

    #[test]
    fn relaycast_control_dedup_key_prefers_spawn_token_for_spawn_requests() {
        let value = json!({
            "type": "agent.spawn_requested",
            "event_id": "evt_123",
            "agent": {
                "name": "worker-a",
                "cli": "claude",
                "task": "Ship it",
                "token": "at_live_worker"
            }
        });

        assert_eq!(
            relaycast_ws_control_dedup_key("ws_1", "agent.spawn_requested", &value),
            Some("control:ws_1:agent.spawn_requested:at_live_worker".to_string())
        );
    }

    #[test]
    fn relaycast_control_dedup_key_falls_back_to_agent_name_for_spawn_requests() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "worker-a",
                "cli": "claude",
                "task": "Ship it"
            }
        });

        assert_eq!(
            relaycast_ws_control_dedup_key("ws_1", "agent.spawn_requested", &value),
            Some("control:ws_1:agent.spawn_requested:worker-a".to_string())
        );
    }

    #[test]
    fn relaycast_control_dedup_key_falls_back_to_serialized_payload() {
        let value = json!({
            "type": "agent.release_requested",
            "agent": { "name": "worker-a" }
        });

        let key = relaycast_ws_control_dedup_key("ws_1", "agent.release_requested", &value)
            .expect("fallback dedup key");
        assert!(key.starts_with("control:ws_1:agent.release_requested:{"));
        assert!(key.contains("\"worker-a\""));
    }

    #[test]
    fn relaycast_ws_spawn_token_extracts_agent_token() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "worker-a",
                "token": "at_live_worker"
            }
        });

        assert_eq!(
            relaycast_ws_spawn_token(&value),
            Some("at_live_worker".to_string())
        );
    }

    #[test]
    fn relaycast_ws_spawn_name_only_control_key_skips_second_name_dedup() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "worker-a",
                "cli": "claude",
                "task": "Ship it"
            }
        });

        let control_key = relaycast_ws_control_dedup_key("ws_1", "agent.spawn_requested", &value)
            .expect("control dedup key");
        let local_key = relaycast_spawn_control_dedup_key("ws_1", "worker-a");

        assert_eq!(control_key, local_key);
        assert!(!relaycast_ws_should_apply_local_spawn_echo_dedup(
            Some(control_key.as_str()),
            &local_key
        ));
    }

    #[test]
    fn relaycast_ws_spawn_event_id_echo_still_uses_local_name_dedup() {
        let value = json!({
            "type": "agent.spawn_requested",
            "event_id": "evt_123",
            "agent": {
                "name": "worker-a",
                "cli": "claude",
                "task": "Ship it"
            }
        });

        let control_key = relaycast_ws_control_dedup_key("ws_1", "agent.spawn_requested", &value)
            .expect("control dedup key");
        let local_key = relaycast_spawn_control_dedup_key("ws_1", "worker-a");

        assert_ne!(control_key, local_key);
        assert!(relaycast_ws_should_apply_local_spawn_echo_dedup(
            Some(control_key.as_str()),
            &local_key
        ));

        let now = Instant::now();
        let mut dedup = DedupCache::new(Duration::from_secs(60), 16);
        assert!(dedup.insert_if_new(&local_key, now));
        assert!(dedup.insert_if_new(&control_key, now + Duration::from_secs(1)));
        assert!(!dedup.insert_if_new(&local_key, now + Duration::from_secs(2)));
    }

    #[test]
    fn unknown_worker_error_message_matches_release_failures() {
        assert!(is_unknown_worker_error_message("unknown worker 'worker-a'"));
        assert!(is_unknown_worker_error_message(
            "failed to release 'worker-a': unknown worker 'worker-a'"
        ));
        assert!(!is_unknown_worker_error_message("failed to bind api port"));
    }

    #[test]
    fn relaycast_self_control_target_matches_aliases_case_insensitively() {
        let self_names = HashSet::from([
            "relay-broker".to_string(),
            "relay-broker@workspace".to_string(),
        ]);

        assert!(is_relaycast_self_control_target(
            "Relay-Broker",
            "relay-broker",
            &self_names
        ));
        assert!(is_relaycast_self_control_target(
            "@relay-broker@workspace",
            "relay-broker",
            &self_names
        ));
        assert!(!is_relaycast_self_control_target(
            "worker-a",
            "relay-broker",
            &self_names
        ));
    }

    #[tokio::test]
    async fn contract_health_fixture_requires_rich_listen_health_shape() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../packages/contracts/fixtures/health-fixtures.json"
        ))
        .expect("health fixture should be valid JSON");
        let expected_shape = fixture
            .get("health_response")
            .and_then(Value::as_object)
            .expect("health fixture must include health_response object");

        let actual = crate::listen_api::listen_api_health_payload(None, vec![]);

        for required_key in expected_shape.keys() {
            // TODO(contract-wave1-health-shape): listen-mode /health should
            // implement the shared BrokerHealthResponse contract fields.
            assert!(
                actual.get(required_key).is_some(),
                "listen /health response is missing required contract field: {}",
                required_key
            );
        }
    }

    #[tokio::test]
    async fn contract_startup_429_fixture_requires_degraded_health_status() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../packages/contracts/fixtures/health-fixtures.json"
        ))
        .expect("health fixture should be valid JSON");
        let expected = fixture
            .get("wave0_startup_429_degraded")
            .and_then(|v| v.get("expected_health_status"))
            .and_then(Value::as_str)
            .expect("health fixture must include expected degraded health status");
        let startup_error_code = fixture
            .get("wave0_startup_429_degraded")
            .and_then(|v| v.get("error"))
            .and_then(|v| v.get("code"))
            .and_then(Value::as_str)
            .expect("health fixture must include startup error code");
        std::env::set_var("AGENT_RELAY_STARTUP_ERROR_CODE", startup_error_code);
        let actual = crate::listen_api::listen_api_health_payload(None, vec![])
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        std::env::remove_var("AGENT_RELAY_STARTUP_ERROR_CODE");

        assert_eq!(
            actual, expected,
            "listen /health status \"{}\" does not match startup 429 degraded contract \"{}\"",
            actual, expected
        );
    }

    #[test]
    fn contract_replay_fixture_requires_replay_route_exposure() {
        let replay_fixture: Value = serde_json::from_str(include_str!(
            "../packages/contracts/fixtures/replay-fixtures.json"
        ))
        .expect("replay fixture should be valid JSON");
        assert!(
            replay_fixture.get("replay_cursor_request").is_some(),
            "replay fixture must include replay_cursor_request"
        );
        assert!(
            replay_fixture.get("replay_response").is_some(),
            "replay fixture must include replay_response"
        );

        let source = include_str!("listen_api.rs");
        assert!(
            source.contains(".route(\"/api/events/replay\""),
            "listen API router does not expose /api/events/replay"
        );
    }

    #[test]
    fn contract_timeout_fixture_requires_terminal_failed_guard_before_late_ack() {
        let replay_fixture: Value = serde_json::from_str(include_str!(
            "../packages/contracts/fixtures/replay-fixtures.json"
        ))
        .expect("replay fixture should be valid JSON");
        let timeout_fixture = replay_fixture
            .get("wave0_timeout_terminal_semantics")
            .and_then(Value::as_object)
            .expect("replay fixture must include wave0_timeout_terminal_semantics object");

        let expected_terminal_status = timeout_fixture
            .get("expected_terminal_status")
            .and_then(Value::as_str)
            .expect("timeout fixture requires expected_terminal_status");
        let late_event_kind = timeout_fixture
            .get("late_event_kind")
            .and_then(Value::as_str)
            .expect("timeout fixture requires late_event_kind");

        let source = include_str!("main.rs");
        let ack_branch = source
            .find("msg_type == \"delivery_ack\"")
            .map(|idx| {
                let end = (idx + 1200).min(source.len());
                &source[idx..end]
            })
            .expect("main.rs must include delivery_ack handling");

        assert!(
            ack_branch.contains(expected_terminal_status) || ack_branch.contains("terminal"),
            "delivery_ack branch lacks terminal guard for timeout status \"{}\" and late event \"{}\"",
            expected_terminal_status,
            late_event_kind
        );
    }

    #[test]
    fn contract_broadcast_whitelist_fixture_requires_filtering_to_required_kinds() {
        let event_fixture: Value = serde_json::from_str(include_str!(
            "../packages/contracts/fixtures/event-fixtures.json"
        ))
        .expect("event fixture should be valid JSON");
        let required = event_fixture
            .get("wave0_broadcast_whitelist")
            .and_then(|v| v.get("required_kinds"))
            .and_then(Value::as_array)
            .expect("event fixture must include wave0_broadcast_whitelist.required_kinds")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<BTreeSet<String>>();

        let emitted = extract_kind_literals(include_str!("main.rs"));

        assert!(
            required.is_subset(&emitted),
            "broker source is missing required broadcast kinds; expected {:?}, got {:?}",
            required,
            emitted
        );
    }

    #[test]
    fn build_thread_infos_groups_channel_messages() {
        let messages = vec![
            json!({
                "from": "broker",
                "target": "#general",
                "text": "outbound",
                "timestamp": "2026-02-23T10:00:00Z",
            }),
            json!({
                "from": "Lead",
                "target": "#general",
                "text": "inbound",
                "timestamp": "2026-02-23T10:01:00Z",
            }),
        ];
        let self_names = HashSet::from(["broker".to_string()]);
        let threads = build_thread_infos(&messages, &self_names);

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].thread_id, "#general");
        assert_eq!(threads[0].name, "#general");
        assert_eq!(threads[0].unread_count, 1);
        assert_eq!(threads[0].last_message.as_deref(), Some("inbound"));
    }

    #[test]
    fn build_thread_infos_groups_direct_messages_case_insensitively() {
        let messages = vec![
            json!({
                "from": "BROKER",
                "to": "WorkerA",
                "text": "ping",
                "timestamp": "2026-02-23T10:00:00Z",
            }),
            json!({
                "from": "workera",
                "to": "broker",
                "text": "pong",
                "timestamp": "2026-02-23T10:01:00Z",
            }),
        ];
        let self_names = HashSet::from(["broker".to_string()]);
        let threads = build_thread_infos(&messages, &self_names);

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].thread_id, "direct:broker:workera");
        assert_eq!(threads[0].name, "workera");
        assert_eq!(threads[0].unread_count, 1);
        assert_eq!(threads[0].last_message.as_deref(), Some("pong"));
    }

    #[test]
    fn build_thread_infos_uses_dm_conversation_id_and_sender_name() {
        let messages = vec![json!({
            "from": "Planner",
            "conversation_id": "conv_123",
            "text": "dm payload",
            "timestamp": "2026-02-23T10:01:00Z",
        })];
        let self_names = HashSet::from(["broker".to_string()]);
        let threads = build_thread_infos(&messages, &self_names);

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].thread_id, "conv_123");
        assert_eq!(threads[0].name, "Planner");
        assert_eq!(threads[0].unread_count, 1);
    }

    #[test]
    fn build_thread_infos_shows_dms_between_non_broker_agents() {
        let messages = vec![
            json!({
                "from": "WorkerA",
                "conversation_id": "dm_456",
                "participants": ["WorkerA", "WorkerB"],
                "text": "hello WorkerB",
                "timestamp": "2026-02-23T10:00:00Z",
            }),
            json!({
                "from": "WorkerB",
                "conversation_id": "dm_456",
                "participants": ["WorkerA", "WorkerB"],
                "text": "hi WorkerA",
                "timestamp": "2026-02-23T10:01:00Z",
            }),
        ];
        let self_names = HashSet::from(["broker".to_string()]);
        let threads = build_thread_infos(&messages, &self_names);

        assert_eq!(threads.len(), 1, "should group into one conversation");
        assert_eq!(threads[0].thread_id, "dm_456");
        assert_eq!(threads[0].name, "WorkerA ↔ WorkerB");
        assert_eq!(
            threads[0].unread_count, 2,
            "both messages unread (neither from broker)"
        );
        assert_eq!(threads[0].last_message.as_deref(), Some("hi WorkerA"));
    }

    #[test]
    fn build_thread_infos_dm_with_participants_filters_broker() {
        let messages = vec![json!({
            "from": "WorkerA",
            "conversation_id": "dm_789",
            "participants": ["broker", "WorkerA"],
            "text": "hello broker",
            "timestamp": "2026-02-23T10:00:00Z",
        })];
        let self_names = HashSet::from(["broker".to_string()]);
        let threads = build_thread_infos(&messages, &self_names);

        assert_eq!(threads.len(), 1);
        assert_eq!(
            threads[0].name, "WorkerA",
            "should filter out broker from participants"
        );
    }

    #[test]
    fn build_thread_infos_multiple_independent_dm_conversations() {
        let messages = vec![
            json!({
                "from": "Alice",
                "conversation_id": "dm_aaa",
                "participants": ["Alice", "Bob"],
                "text": "hi Bob",
                "timestamp": "2026-02-23T10:00:00Z",
            }),
            json!({
                "from": "Charlie",
                "conversation_id": "dm_bbb",
                "participants": ["Charlie", "Diana"],
                "text": "hi Diana",
                "timestamp": "2026-02-23T10:01:00Z",
            }),
            json!({
                "from": "broker",
                "conversation_id": "dm_ccc",
                "participants": ["broker", "Eve"],
                "text": "hi Eve",
                "timestamp": "2026-02-23T10:02:00Z",
            }),
        ];
        let self_names = HashSet::from(["broker".to_string()]);
        let threads = build_thread_infos(&messages, &self_names);

        assert_eq!(
            threads.len(),
            3,
            "should have three separate DM conversations"
        );

        let thread_aaa = threads.iter().find(|t| t.thread_id == "dm_aaa").unwrap();
        assert_eq!(thread_aaa.name, "Alice ↔ Bob");

        let thread_bbb = threads.iter().find(|t| t.thread_id == "dm_bbb").unwrap();
        assert_eq!(thread_bbb.name, "Charlie ↔ Diana");

        let thread_ccc = threads.iter().find(|t| t.thread_id == "dm_ccc").unwrap();
        assert_eq!(thread_ccc.name, "Eve", "broker filtered from participants");
    }

    #[test]
    fn build_thread_infos_respects_explicit_unread_count() {
        let messages = vec![json!({
            "from": "Planner",
            "target": "broker",
            "text": "status",
            "unread_count": 7,
            "timestamp": "2026-02-23T10:01:00Z",
        })];
        let self_names = HashSet::from(["broker".to_string()]);
        let threads = build_thread_infos(&messages, &self_names);

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].unread_count, 7);
    }

    #[test]
    fn build_agent_state_transition_event_has_expected_shape() {
        let payload = build_agent_state_transition_event("worker-a", "spawned", Some("sdk_spawn"));
        assert_eq!(payload["type"], "agent.state");
        assert_eq!(payload["state"], "spawned");
        assert_eq!(payload["agent"]["name"], "worker-a");
        assert_eq!(payload["reason"], "sdk_spawn");
        assert!(payload["timestamp"].as_str().is_some());

        let no_reason = build_agent_state_transition_event("worker-a", "idle", None);
        assert!(no_reason.get("reason").is_none());
    }

    #[test]
    fn preregistration_error_message_dedupes_retry_after_for_rate_limit() {
        let error = RelaycastRegistrationError::RateLimited {
            agent_name: "Foobar".to_string(),
            retry_after_secs: 60,
            detail: "{\"ok\":false}".to_string(),
        };
        let message = format_worker_preregistration_error("Foobar", &error);
        assert_eq!(message.matches("retry after").count(), 1);
    }

    #[test]
    fn preregistration_error_message_does_not_invent_retry_after_for_transport_errors() {
        let error = RelaycastRegistrationError::Transport {
            agent_name: "Foobar".to_string(),
            detail: "timeout".to_string(),
        };
        let message = format_worker_preregistration_error("Foobar", &error);
        assert!(!message.contains("retry after"));
    }

    #[test]
    fn injection_format_preserved() {
        let rendered = format_injection("alice", "evt_1", "hello", "bob");
        assert!(rendered.contains("<system-reminder>"));
        assert!(rendered.contains("mcp__relaycast__message_dm_send"));
        assert!(rendered.contains("Relay message from alice [evt_1]: hello"));
    }

    #[test]
    fn injection_format_includes_channel() {
        let rendered = format_injection("alice", "evt_1", "hello", "#general");
        assert!(rendered.contains("mcp__relaycast__message_post"));
        assert!(rendered.contains("channel: \"general\""));
        assert!(rendered.contains("Relay message from alice in #general [evt_1]: hello"));
    }

    #[test]
    fn normalize_sender_defaults_to_human_orchestrator() {
        assert_eq!(normalize_sender(None), "human:orchestrator");
        assert_eq!(normalize_sender(Some(String::new())), "human:orchestrator");
        assert_eq!(
            normalize_sender(Some("   ".to_string())),
            "human:orchestrator"
        );
    }

    #[test]
    fn normalize_sender_normalizes_human_prefix() {
        assert_eq!(
            normalize_sender(Some("human:  Dashboard  ".to_string())),
            "human:Dashboard"
        );
    }

    #[test]
    fn normalize_sender_preserves_worker_names() {
        assert_eq!(
            normalize_sender(Some("WorkerOne".to_string())),
            "WorkerOne".to_string()
        );
    }

    #[test]
    fn sender_is_dashboard_label_accepts_legacy_dashboard_senders() {
        assert!(sender_is_dashboard_label("Dashboard", "my-project"));
        assert!(sender_is_dashboard_label("human:Dashboard", "my-project"));
        assert!(sender_is_dashboard_label(
            "human:orchestrator",
            "my-project"
        ));
        assert!(sender_is_dashboard_label("my-project", "my-project"));
        assert!(!sender_is_dashboard_label("Lead", "my-project"));
    }

    #[test]
    fn display_target_for_dashboard_maps_self_identity() {
        let mut self_names = HashSet::new();
        self_names.insert("broker-951762d5".to_string());
        self_names.insert("DashProbe".to_string());
        let primary = "my-project";

        assert_eq!(
            display_target_for_dashboard("broker-951762d5", &self_names, primary),
            "my-project"
        );
        assert_eq!(
            display_target_for_dashboard("dashprobe", &self_names, primary),
            "my-project"
        );
        assert_eq!(
            display_target_for_dashboard("Lead", &self_names, primary),
            "Lead".to_string()
        );
    }

    #[test]
    fn delivery_retry_interval_uses_default_and_env_override() {
        std::env::remove_var("AGENT_RELAY_DELIVERY_RETRY_MS");
        assert_eq!(delivery_retry_interval().as_millis(), 1_000);

        std::env::set_var("AGENT_RELAY_DELIVERY_RETRY_MS", "250");
        assert_eq!(delivery_retry_interval().as_millis(), 250);

        std::env::set_var("AGENT_RELAY_DELIVERY_RETRY_MS", "1");
        assert_eq!(delivery_retry_interval().as_millis(), 50);

        std::env::remove_var("AGENT_RELAY_DELIVERY_RETRY_MS");
    }

    #[test]
    fn http_api_timeout_windows_use_default_and_env_override() {
        std::env::remove_var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS");
        std::env::remove_var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS");
        std::env::remove_var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS");

        assert_eq!(http_api_local_delivery_timeout().as_millis(), 3_000);
        assert_eq!(http_api_relaycast_send_timeout().as_millis(), 20_000);
        assert_eq!(http_api_event_emit_timeout().as_millis(), 200);

        std::env::set_var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS", "10");
        std::env::set_var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS", "100");
        std::env::set_var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS", "1");

        assert_eq!(http_api_local_delivery_timeout().as_millis(), 100);
        assert_eq!(http_api_relaycast_send_timeout().as_millis(), 500);
        assert_eq!(http_api_event_emit_timeout().as_millis(), 25);

        std::env::set_var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS", "1500");
        std::env::set_var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS", "12000");
        std::env::set_var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS", "150");

        assert_eq!(http_api_local_delivery_timeout().as_millis(), 1_500);
        assert_eq!(http_api_relaycast_send_timeout().as_millis(), 12_000);
        assert_eq!(http_api_event_emit_timeout().as_millis(), 150);

        std::env::remove_var("AGENT_RELAY_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS");
        std::env::remove_var("AGENT_RELAY_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS");
        std::env::remove_var("AGENT_RELAY_HTTP_API_EVENT_EMIT_TIMEOUT_MS");
    }

    #[test]
    fn drop_pending_for_worker_removes_only_matching_entries() {
        let mut pending = HashMap::new();
        pending.insert(
            "del_1".to_string(),
            PendingDelivery {
                worker_name: "A".to_string(),
                delivery: RelayDelivery {
                    delivery_id: "del_1".to_string(),
                    event_id: "evt_1".to_string(),
                    workspace_id: Some("ws_test".to_string()),
                    workspace_alias: Some("test".to_string()),
                    from: "x".to_string(),
                    target: "#general".to_string(),
                    body: "hello".to_string(),
                    thread_id: None,
                    priority: None,
                    injection_mode: MessageInjectionMode::Wait,
                },
                attempts: 1,
                next_retry_at: Instant::now(),
            },
        );
        pending.insert(
            "del_2".to_string(),
            PendingDelivery {
                worker_name: "B".to_string(),
                delivery: RelayDelivery {
                    delivery_id: "del_2".to_string(),
                    event_id: "evt_2".to_string(),
                    workspace_id: Some("ws_test".to_string()),
                    workspace_alias: Some("test".to_string()),
                    from: "y".to_string(),
                    target: "#general".to_string(),
                    body: "world".to_string(),
                    thread_id: None,
                    priority: None,
                    injection_mode: MessageInjectionMode::Wait,
                },
                attempts: 1,
                next_retry_at: Instant::now(),
            },
        );

        let dropped = drop_pending_for_worker(&mut pending, "A");
        assert_eq!(dropped, 1);
        assert!(pending.contains_key("del_2"));
        assert!(!pending.contains_key("del_1"));
    }

    #[test]
    fn should_clear_pending_delivery_when_event_id_matches() {
        let pending = PendingDelivery {
            worker_name: "A".to_string(),
            delivery: RelayDelivery {
                delivery_id: "del_1".to_string(),
                event_id: "evt_1".to_string(),
                workspace_id: Some("ws_test".to_string()),
                workspace_alias: Some("test".to_string()),
                from: "x".to_string(),
                target: "#general".to_string(),
                body: "hello".to_string(),
                thread_id: None,
                priority: None,
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 1,
            next_retry_at: Instant::now(),
        };

        assert!(should_clear_pending_delivery_for_event(
            Some(&pending),
            Some("evt_1")
        ));
        assert!(!should_clear_pending_delivery_for_event(
            Some(&pending),
            Some("evt_2")
        ));
    }

    #[test]
    fn should_clear_pending_delivery_without_event_id_for_compatibility() {
        let pending = PendingDelivery {
            worker_name: "A".to_string(),
            delivery: RelayDelivery {
                delivery_id: "del_1".to_string(),
                event_id: "evt_1".to_string(),
                workspace_id: Some("ws_test".to_string()),
                workspace_alias: Some("test".to_string()),
                from: "x".to_string(),
                target: "#general".to_string(),
                body: "hello".to_string(),
                thread_id: None,
                priority: None,
                injection_mode: MessageInjectionMode::Wait,
            },
            attempts: 1,
            next_retry_at: Instant::now(),
        };

        assert!(should_clear_pending_delivery_for_event(
            Some(&pending),
            None
        ));
        assert!(should_clear_pending_delivery_for_event(
            Some(&pending),
            Some("")
        ));
        assert!(should_clear_pending_delivery_for_event(None, Some("evt_1")));
    }

    #[test]
    fn terminal_query_responses_standard_cpr() {
        let responses = terminal_query_responses(b"\x1b[6n");
        assert_eq!(responses, vec![b"\x1b[1;1R".as_slice()]);
    }

    #[test]
    fn terminal_query_parser_handles_split_sequences() {
        let mut parser = TerminalQueryParser::default();
        assert!(parser.feed(b"\x1b[").is_empty());
        assert!(parser.feed(b"6").is_empty());
        let responses = parser.feed(b"n");
        assert_eq!(responses, vec![b"\x1b[1;1R".as_slice()]);
    }

    #[test]
    fn terminal_query_parser_handles_private_cpr() {
        let mut parser = TerminalQueryParser::default();
        assert!(parser.feed(b"\x1b[?6").is_empty());
        let responses = parser.feed(b"n");
        assert_eq!(responses, vec![b"\x1b[?1;1R".as_slice()]);
    }

    // ==================== strip_ansi tests ====================

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\x1b[32mHello\x1b[0m"), "Hello");
        assert_eq!(strip_ansi("\x1b[1;31mred bold\x1b[0m"), "red bold");
    }

    #[test]
    fn strip_ansi_removes_osc_sequences() {
        assert_eq!(strip_ansi("\x1b]0;title\x07rest"), "rest");
        assert_eq!(strip_ansi("\x1b]0;title\x1b\\rest"), "rest");
    }

    #[test]
    fn strip_ansi_preserves_plain_text() {
        assert_eq!(strip_ansi("Hello world"), "Hello world");
        assert_eq!(strip_ansi(""), "");
    }

    #[test]
    fn strip_ansi_handles_mixed_content() {
        let input = "\x1b[33m⚠️  bypass\x1b[0m permissions mode\n\x1b[1m(yes/no)\x1b[0m";
        let clean = strip_ansi(input);
        assert!(clean.contains("bypass"));
        assert!(clean.contains("(yes/no)"));
        assert!(!clean.contains("\x1b"));
    }

    #[test]
    fn strip_ansi_handles_cursor_forward_sequences() {
        // Claude Code uses \x1b[1C (cursor forward) instead of spaces
        // These should be replaced with spaces so echo detection works
        let input = "\x1b[1CYes,\x1b[1CI\x1b[1Caccept";
        let clean = strip_ansi(input);
        assert_eq!(clean, " Yes, I accept");
    }

    // ==================== floor_char_boundary tests ====================

    #[test]
    fn floor_char_boundary_at_valid_positions() {
        let s = "Hello 世界";
        assert_eq!(floor_char_boundary(s, 0), 0);
        assert_eq!(floor_char_boundary(s, 6), 6);
        assert_eq!(floor_char_boundary(s, 9), 9);
    }

    #[test]
    fn floor_char_boundary_mid_multibyte() {
        let s = "Hello 世界";
        assert_eq!(floor_char_boundary(s, 7), 6);
        assert_eq!(floor_char_boundary(s, 8), 6);
    }

    #[test]
    fn floor_char_boundary_past_end() {
        let s = "Hello 世界";
        assert_eq!(floor_char_boundary(s, 100), s.len());
    }

    // ==================== detect_bypass_permissions_prompt tests ====================

    #[test]
    fn bypass_perms_yes_no_prompt() {
        let output = "⚠️  Bypassing all permission checks.\nDo you want to proceed? (yes/no)";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(has_ref);
        assert!(has_confirm);
    }

    #[test]
    fn bypass_perms_dangerously_with_yn() {
        let output = "Running with --dangerously-skip-permissions\nAccept the risks? (y/n)";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(has_ref);
        assert!(has_confirm);
    }

    #[test]
    fn bypass_perms_accept_risk_variant() {
        let output =
            "bypass permissions mode enabled\nDo you accept the risk of running in this mode?";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(has_ref);
        assert!(has_confirm);
    }

    #[test]
    fn bypass_perms_no_match_normal_output() {
        let output = "I'll help you fix that bug. Let me read the file first.";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(!has_ref);
        assert!(!has_confirm);
    }

    #[test]
    fn bypass_perms_no_false_positive_permission_without_bypass() {
        let output = "File permission denied. (yes/no)";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(!has_ref, "permission without bypass should not match");
        assert!(has_confirm, "yes/no detected but insufficient alone");
    }

    #[test]
    fn bypass_perms_no_false_positive_status_bar() {
        let output = "-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(has_ref, "status bar has bypass+permissions");
        assert!(!has_confirm, "but no confirmation prompt");
    }

    #[test]
    fn bypass_perms_selection_menu_format() {
        let output = "WARNING: ClaudeCoderunninginBypassPermissionsmode\n\
                       Byproceeding,youacceptallresponsibility\n\
                       No,exit\nYes,Iaccept\nEntertoconfirm";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(has_ref);
        assert!(has_confirm);
        assert!(is_bypass_selection_menu(output));
    }

    #[test]
    fn bypass_perms_selection_menu_with_spaces() {
        let output = "WARNING: Claude Code running in Bypass Permissions mode\n\
                       1. No, exit\n2. Yes, I accept\nEnter to confirm";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(has_ref && has_confirm);
        assert!(is_bypass_selection_menu(output));
    }

    #[test]
    fn bypass_perms_legacy_not_selection_menu() {
        let output = "bypass permissions mode\nProceed? (yes/no)";
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(output);
        assert!(has_ref && has_confirm, "legacy should still detect");
        assert!(
            !is_bypass_selection_menu(output),
            "legacy should NOT be selection menu"
        );
    }

    #[test]
    fn bypass_perms_with_raw_ansi() {
        let raw = "\x1b[33m⚠️  bypass permissions\x1b[0m mode\nProceed? \x1b[1m(yes/no)\x1b[0m";
        let clean = strip_ansi(raw);
        let (has_ref, has_confirm) = detect_bypass_permissions_prompt(&clean);
        assert!(has_ref && has_confirm);
    }

    // ==================== detect_claude_trust_prompt tests ====================

    #[test]
    fn claude_trust_prompt_full_match() {
        let output = "take a moment to review what's in this folder first.\n\
                       Claude Code'll be able to read, edit, and execute files here.\n\
                       Security guide\n\
                       ❯ 1. Yes, I trust this folder\n\
                         2. No, exit\n\
                       Enter to confirm · Esc to cancel";
        let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
        assert!(has_trust_ref);
        assert!(has_confirmation);
    }

    #[test]
    fn claude_trust_prompt_stripped_spaces() {
        let output = "Yes,Itrustthisfolder\nNo,exit";
        let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
        assert!(has_trust_ref);
        assert!(has_confirmation);
    }

    #[test]
    fn claude_trust_prompt_no_match_normal_output() {
        let output = "I'll help you fix that bug. Let me read the file first.";
        let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
        assert!(!has_trust_ref);
        assert!(!has_confirmation);
    }

    #[test]
    fn claude_trust_prompt_partial_no_exit() {
        let output = "Yes, I trust this folder";
        let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(output);
        assert!(has_trust_ref);
        assert!(!has_confirmation, "should not match without exit option");
    }

    #[test]
    fn claude_trust_prompt_with_ansi() {
        let raw = "\x1b[1m❯ 1. Yes, I trust this folder\x1b[0m\n  2. No, exit";
        let clean = strip_ansi(raw);
        let (has_trust_ref, has_confirmation) = detect_claude_trust_prompt(&clean);
        assert!(has_trust_ref && has_confirmation);
    }

    // ==================== is_in_editor_mode tests ====================

    #[test]
    fn editor_mode_vim_insert() {
        assert!(is_in_editor_mode("Some text\n-- INSERT --\n"));
        assert!(is_in_editor_mode("Some text\n-- INSERT --"));
    }

    #[test]
    fn editor_mode_claude_cli_not_vim() {
        let output = "-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)";
        assert!(!is_in_editor_mode(output));
    }

    #[test]
    fn editor_mode_nano() {
        let output = "  GNU nano 5.8\nFile: test.txt\n^G Get Help  ^O Write Out";
        assert!(is_in_editor_mode(output));
    }

    #[test]
    fn editor_mode_less_pager() {
        assert!(is_in_editor_mode("some content\n(END)"));
        assert!(is_in_editor_mode("some content\n--More--"));
    }

    #[test]
    fn editor_mode_normal_output() {
        assert!(!is_in_editor_mode(
            "I'll help you with that task. Let me search."
        ));
        assert!(!is_in_editor_mode("$ ls -la\ntotal 0\n$ "));
    }

    #[test]
    fn editor_mode_with_ansi() {
        let output = "\x1b[32mSome text\x1b[0m\n-- INSERT --\n";
        assert!(is_in_editor_mode(output));
    }

    #[test]
    fn editor_mode_vim_visual_modes() {
        assert!(is_in_editor_mode("text\n-- VISUAL --\n"));
        assert!(is_in_editor_mode("text\n-- VISUAL LINE --\n"));
        assert!(is_in_editor_mode("text\n-- VISUAL BLOCK --\n"));
        assert!(is_in_editor_mode("text\n-- REPLACE --\n"));
    }

    #[test]
    fn editor_mode_claude_normal_not_vim() {
        assert!(!is_in_editor_mode("-- NORMAL -- ► some Claude UI text"));
        assert!(!is_in_editor_mode("-- VISUAL -- ▶ Claude UI"));
    }

    #[test]
    fn auto_suggestion_detects_cursor_plus_dim_pattern() {
        assert!(is_auto_suggestion(
            "\x1b[7mW\x1b[27m\x1b[2mhat's the task?\x1b[22m"
        ));
    }

    #[test]
    fn auto_suggestion_detects_send_hint() {
        assert!(is_auto_suggestion("                     ↵ send"));
    }

    #[test]
    fn auto_suggestion_ignores_normal_output() {
        assert!(!is_auto_suggestion("Relay message from Alice [abc]: hello"));
        assert!(!is_auto_suggestion("Running tests..."));
        assert!(!is_auto_suggestion("> \x1b[7m \x1b[27m"));
    }

    #[test]
    fn extract_mcp_ids_from_tool_response() {
        let output = r#"  ⎿  {
       "id": "147310274064424960",
       "conversation_id": "147310245874507776",
       "from": "agent-a",
       "text": "hello"
     }"#;
        let ids = extract_mcp_message_ids(output);
        // Only extracts "id" keys, not "conversation_id"
        assert_eq!(ids, vec!["147310274064424960"]);
    }

    #[test]
    fn extract_mcp_ids_ignores_short_ids() {
        let output = r#""id": "123""#;
        assert!(extract_mcp_message_ids(output).is_empty());
    }

    #[test]
    fn extract_mcp_ids_ignores_non_numeric() {
        let output = r#""id": "msg_abc123def456ghi""#;
        assert!(extract_mcp_message_ids(output).is_empty());
    }

    #[test]
    fn extract_mcp_ids_handles_no_ids() {
        assert!(extract_mcp_message_ids("normal output with no JSON").is_empty());
        assert!(extract_mcp_message_ids("").is_empty());
    }

    // ==================== bypass flag selection logic tests ====================
    // Tests for the bypass flag logic used in WorkerRegistry::spawn().
    // The logic is: claude/claude:* → --dangerously-skip-permissions, codex → --dangerously-bypass-approvals-and-sandbox

    fn compute_bypass_flag(cli: &str, existing_args: &[String]) -> Option<&'static str> {
        let cli_lower = cli.to_lowercase();
        if (cli_lower == "claude" || cli_lower.starts_with("claude:"))
            && !existing_args
                .iter()
                .any(|a| a.contains("dangerously-skip-permissions"))
        {
            Some("--dangerously-skip-permissions")
        } else if cli_lower == "codex"
            && !existing_args
                .iter()
                .any(|a| a.contains("dangerously-bypass") || a.contains("full-auto"))
        {
            Some("--dangerously-bypass-approvals-and-sandbox")
        } else if cli_lower == "gemini" && !existing_args.iter().any(|a| a == "--yolo" || a == "-y")
        {
            Some("--yolo")
        } else {
            None
        }
    }

    #[test]
    fn bypass_flag_claude_gets_skip_permissions() {
        assert_eq!(
            compute_bypass_flag("claude", &[]),
            Some("--dangerously-skip-permissions")
        );
    }

    #[test]
    fn bypass_flag_claude_variant_gets_skip_permissions() {
        assert_eq!(
            compute_bypass_flag("claude:latest", &[]),
            Some("--dangerously-skip-permissions")
        );
        assert_eq!(
            compute_bypass_flag("Claude", &[]),
            Some("--dangerously-skip-permissions")
        );
        assert_eq!(
            compute_bypass_flag("CLAUDE:v2", &[]),
            Some("--dangerously-skip-permissions")
        );
    }

    #[test]
    fn bypass_flag_codex_gets_dangerously_bypass() {
        assert_eq!(
            compute_bypass_flag("codex", &[]),
            Some("--dangerously-bypass-approvals-and-sandbox")
        );
    }

    #[test]
    fn bypass_flag_gemini_gets_yolo() {
        assert_eq!(compute_bypass_flag("gemini", &[]), Some("--yolo"));
    }

    #[test]
    fn bypass_flag_gemini_dedup_when_yolo_present() {
        let args = vec!["--yolo".to_string()];
        assert_eq!(
            compute_bypass_flag("gemini", &args),
            None,
            "should not duplicate --yolo flag"
        );
    }

    #[test]
    fn bypass_flag_gemini_dedup_when_y_present() {
        let args = vec!["-y".to_string()];
        assert_eq!(
            compute_bypass_flag("gemini", &args),
            None,
            "should not duplicate when -y shorthand present"
        );
    }

    #[test]
    fn bypass_flag_aider_gets_none() {
        assert_eq!(compute_bypass_flag("aider", &[]), None);
    }

    #[test]
    fn bypass_flag_goose_gets_none() {
        assert_eq!(compute_bypass_flag("goose", &[]), None);
    }

    #[test]
    fn bypass_flag_unknown_cli_gets_none() {
        assert_eq!(compute_bypass_flag("mystery-cli", &[]), None);
    }

    #[test]
    fn bypass_flag_claude_dedup_when_already_present() {
        let args = vec!["--dangerously-skip-permissions".to_string()];
        assert_eq!(
            compute_bypass_flag("claude", &args),
            None,
            "should not duplicate flag"
        );
    }

    #[test]
    fn bypass_flag_codex_dedup_when_already_present() {
        let args = vec!["--dangerously-bypass-approvals-and-sandbox".to_string()];
        assert_eq!(
            compute_bypass_flag("codex", &args),
            None,
            "should not duplicate flag"
        );
    }

    #[test]
    fn bypass_flag_codex_dedup_when_full_auto_present() {
        let args = vec!["--full-auto".to_string()];
        assert_eq!(
            compute_bypass_flag("codex", &args),
            None,
            "should not add bypass when --full-auto already present"
        );
    }

    #[test]
    fn bypass_flag_claude_dedup_partial_match() {
        // If someone passes a different arg containing the substring, still dedup
        let args = vec!["--my-dangerously-skip-permissions-flag".to_string()];
        assert_eq!(
            compute_bypass_flag("claude", &args),
            None,
            "substring match should prevent duplication"
        );
    }

    #[test]
    fn bypass_flag_codex_with_other_args() {
        let args = vec!["--model".to_string(), "gpt-4".to_string()];
        assert_eq!(
            compute_bypass_flag("codex", &args),
            Some("--dangerously-bypass-approvals-and-sandbox"),
            "unrelated args should not prevent bypass flag"
        );
    }

    // ==================== is_pid_alive ====================

    #[test]
    fn is_pid_alive_returns_true_for_self() {
        let pid = std::process::id();
        assert!(
            super::is_pid_alive(pid),
            "current process PID should be alive"
        );
    }

    #[test]
    fn is_pid_alive_returns_false_for_dead_pid() {
        // Spawn a short-lived child, wait for it to exit, then verify it's dead
        let child = std::process::Command::new("true")
            .spawn()
            .expect("failed to spawn 'true'");
        let pid = child.id();
        let mut child = child;
        child.wait().expect("failed to wait on child");
        // After the child exits, its PID should not be alive
        // (the PID may be recycled, but on macOS/Linux it won't be immediately)
        assert!(!super::is_pid_alive(pid), "exited child PID should be dead");
    }

    #[test]
    fn is_pid_alive_returns_false_for_bogus_pid() {
        // PID 0 is the kernel scheduler — kill(0, 0) signals the entire process group,
        // not a real target. Use a very high PID that almost certainly doesn't exist.
        // On macOS pid_max is ~99999; on Linux it's typically 32768 or 4194304.
        // 4_000_000 is unlikely to be in use.
        assert!(
            !super::is_pid_alive(4_000_000),
            "bogus PID 4_000_000 should not be alive (ESRCH)"
        );
    }

    #[test]
    fn is_pid_alive_eperm_means_alive() {
        // PID 1 (launchd/init) is owned by root. When run as a normal user,
        // kill(1, 0) returns EPERM — the process exists but we can't signal it.
        // This is exactly the EPERM case our fix handles.
        // Skip if running as root (e.g., in some CI containers) since root can
        // signal any process and would get rc=0 instead of EPERM.
        if unsafe { nix::libc::getuid() } == 0 {
            eprintln!("skipping EPERM test: running as root");
            return;
        }
        assert!(
            super::is_pid_alive(1),
            "PID 1 (init/launchd) should report alive via EPERM"
        );
    }

    // ==================== write_pid_file ====================

    #[test]
    fn write_pid_file_is_atomic() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        let pid_path = dir.path().join("broker.pid");
        super::write_pid_file(&pid_path).expect("write_pid_file failed");
        let contents = std::fs::read_to_string(&pid_path).expect("failed to read pid file");
        let pid: u32 = contents
            .trim()
            .parse()
            .expect("pid file should contain a number");
        assert_eq!(pid, std::process::id());
    }

    // ==================== continuity_dir ====================

    #[test]
    fn continuity_dir_derives_correct_path_from_state_json() {
        let state_path = std::path::Path::new("/project/.agent-relay/state.json");
        let result = continuity_dir(state_path);
        assert_eq!(
            result,
            std::path::PathBuf::from("/project/.agent-relay/continuity")
        );
    }

    #[test]
    fn continuity_dir_works_with_nested_project_path() {
        let state_path = std::path::Path::new("/home/user/projects/my-app/.agent-relay/state.json");
        let result = continuity_dir(state_path);
        assert_eq!(
            result,
            std::path::PathBuf::from("/home/user/projects/my-app/.agent-relay/continuity")
        );
    }

    #[test]
    fn continuity_dir_preserves_relative_paths() {
        let state_path = std::path::Path::new(".agent-relay/state.json");
        let result = continuity_dir(state_path);
        assert_eq!(result, std::path::PathBuf::from(".agent-relay/continuity"));
    }

    // ==================== model flag injection tests ====================
    // Tests for the --model flag injection logic used in WorkerRegistry::spawn().
    // When spec.model is set and non-empty, the broker should inject --model <value>
    // into the spawned CLI's argv, unless the user already specified --model.

    /// Mirror of the model flag logic in WorkerRegistry::spawn().
    fn compute_model_flag(model: Option<&str>, existing_args: &[String]) -> Option<String> {
        model.and_then(|m| {
            if m.is_empty()
                || existing_args
                    .iter()
                    .any(|a| a == "--model" || a.starts_with("--model=") || a == "-m")
            {
                None
            } else {
                Some(m.to_string())
            }
        })
    }

    #[test]
    fn model_flag_injected_when_present() {
        assert_eq!(
            compute_model_flag(Some("haiku"), &[]),
            Some("haiku".to_string()),
            "model should be injected when set and args are empty"
        );
    }

    #[test]
    fn model_flag_not_injected_when_none() {
        assert_eq!(
            compute_model_flag(None, &[]),
            None,
            "model should not be injected when not set"
        );
    }

    #[test]
    fn model_flag_not_injected_when_empty() {
        assert_eq!(
            compute_model_flag(Some(""), &[]),
            None,
            "model should not be injected when empty string"
        );
    }

    #[test]
    fn model_flag_not_injected_when_already_in_args() {
        let args = vec!["--model".to_string(), "opus".to_string()];
        assert_eq!(
            compute_model_flag(Some("haiku"), &args),
            None,
            "model should not be injected when --model already in args"
        );
    }

    #[test]
    fn model_flag_not_injected_when_short_flag_in_args() {
        let args = vec!["-m".to_string(), "opus".to_string()];
        assert_eq!(
            compute_model_flag(Some("haiku"), &args),
            None,
            "model should not be injected when -m already in args"
        );
    }

    #[test]
    fn model_flag_not_injected_when_equals_format_in_args() {
        let args = vec!["--model=opus".to_string()];
        assert_eq!(
            compute_model_flag(Some("haiku"), &args),
            None,
            "model should not be injected when --model=value already in args"
        );
    }

    #[test]
    fn model_flag_injected_with_other_args() {
        let args = vec!["--verbose".to_string()];
        assert_eq!(
            compute_model_flag(Some("gpt-4o"), &args),
            Some("gpt-4o".to_string()),
            "model should be injected when other unrelated args exist"
        );
    }
}
