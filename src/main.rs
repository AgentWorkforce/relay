use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

mod helpers;
mod pty_worker;
mod spawner;
mod wrap;

use helpers::{
    detect_bypass_permissions_prompt, detect_codex_model_prompt, detect_gemini_action_required,
    floor_char_boundary, format_injection, is_auto_suggestion, is_bypass_selection_menu,
    is_in_editor_mode, strip_ansi, TerminalQueryParser,
};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::mpsc,
    time::MissedTickBehavior,
};
use uuid::Uuid;

use relay_broker::{
    auth::{AuthClient, CredentialStore},
    control::{can_release_child, is_human_sender},
    dedup::DedupCache,
    message_bridge::{map_ws_broker_command, map_ws_event},
    protocol::{AgentRuntime, AgentSpec, ProtocolEnvelope, RelayDelivery, PROTOCOL_VERSION},
    pty::PtySession,
    relaycast_ws::{RelaycastHttpClient, RelaycastWsClient, WsControl},
    snippets::{configure_relaycast_mcp, ensure_relaycast_mcp_config},
    telemetry::{TelemetryClient, TelemetryEvent},
    types::{BrokerCommandEvent, BrokerCommandPayload, SenderKind},
};

use spawner::{terminate_child, Spawner};

const DEFAULT_DELIVERY_RETRY_MS: u64 = 1_000;
const MAX_DELIVERY_RETRIES: u32 = 10;
const DEFAULT_RELAYCAST_BASE_URL: &str = "https://api.relaycast.dev";

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
    /// Listen mode: connect to Relaycast WS and log events without wrapping a CLI.
    /// Useful for monitoring or running as a spawn-only hub.
    Listen(ListenCommand),
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
    #[arg(long, default_value = "broker")]
    name: String,

    #[arg(long, default_value = "general")]
    channels: String,
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
    provider: HeadlessProvider,

    #[arg(last = true)]
    args: Vec<String>,

    #[arg(long)]
    agent_name: Option<String>,
}

#[derive(Debug, clap::Args, Clone)]
struct ListenCommand {
    /// Agent name for this listener (default: from RELAY_AGENT_NAME or "listener")
    #[arg(long)]
    agent_name: Option<String>,

    /// Comma-separated channels to subscribe to (default: from RELAY_CHANNELS or "general")
    #[arg(long)]
    channels: Option<String>,

    /// Subscribe to all channels in the workspace (fetches from Relaycast API at startup)
    #[arg(long, default_value = "false")]
    all: bool,

    /// Port for the HTTP API (default: 3889)
    #[arg(long, default_value = "3889")]
    port: u16,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum HeadlessProvider {
    Claude,
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
    creds: PathBuf,
    state: PathBuf,
    pending: PathBuf,
    pid: PathBuf,
    /// Held for process lifetime to prevent concurrent broker instances.
    #[allow(dead_code)]
    _lock: std::fs::File,
}

/// Shared Relaycast connection state used by run_init, run_listen, and run_wrap.
struct RelaySession {
    http_base: String,
    relay_workspace_key: String,
    self_agent_id: String,
    self_names: HashSet<String>,
    self_agent_ids: HashSet<String>,
    ws_inbound_rx: mpsc::Receiver<Value>,
    ws_control_tx: mpsc::Sender<WsControl>,
}

/// Build the standard env-var array passed to every spawned child agent.
fn spawn_env_vars<'a>(
    name: &'a str,
    api_key: &'a str,
    base_url: &'a str,
    channels: &'a str,
) -> [(&'a str, &'a str); 5] {
    [
        ("RELAY_AGENT_NAME", name),
        ("RELAY_API_KEY", api_key),
        ("RELAY_BASE_URL", base_url),
        ("RELAY_CHANNELS", channels),
        ("RELAY_STRICT_AGENT_NAME", "1"),
    ]
}

struct RelaySessionOptions<'a> {
    paths: &'a RuntimePaths,
    requested_name: &'a str,
    channels: Vec<String>,
    strict_name: bool,
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

    let auth = AuthClient::new(
        http_base.clone(),
        CredentialStore::new(opts.paths.creds.clone()),
    );
    let session = auth
        .startup_session_with_options(Some(opts.requested_name), opts.strict_name)
        .await
        .context("failed to initialize relaycast session")?;
    let relay_workspace_key = session.credentials.api_key.clone();
    let self_agent_id = session.credentials.agent_id.clone();

    let agent_name = session
        .credentials
        .agent_name
        .clone()
        .unwrap_or_else(|| opts.requested_name.to_string());
    if agent_name != opts.requested_name {
        eprintln!(
            "[agent-relay] registered as '{}' (requested '{}')",
            agent_name, opts.requested_name
        );
    }

    if opts.ensure_mcp_config {
        if let Err(error) = ensure_relaycast_mcp_config(
            opts.runtime_cwd,
            Some(relay_workspace_key.as_str()),
            Some(http_base.as_str()),
            None, // Don't hardcode agent name — each child inherits RELAY_AGENT_NAME via env
        ) {
            tracing::warn!("failed to ensure .mcp.json: {error}");
        }
    }

    let mut self_names = HashSet::new();
    self_names.insert(agent_name.clone());
    self_names.insert(opts.requested_name.to_string());
    if opts.read_mcp_identity {
        if let Ok(mcp_json) = std::fs::read_to_string(opts.runtime_cwd.join(".mcp.json")) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&mcp_json) {
                if let Some(mcp_name) = parsed
                    .pointer("/mcpServers/relaycast/env/RELAY_AGENT_NAME")
                    .and_then(Value::as_str)
                {
                    if !mcp_name.is_empty() {
                        self_names.insert(mcp_name.to_string());
                    }
                }
            }
        }
    }
    tracing::debug!(self_names = ?self_names, "echo filter identities");

    let mut self_agent_ids = HashSet::new();
    self_agent_ids.insert(self_agent_id.clone());

    let (ws_inbound_tx, ws_inbound_rx) = mpsc::channel(512);
    let (ws_control_tx, ws_control_rx) = mpsc::channel(8);
    let ws = RelaycastWsClient::new(
        ws_base,
        auth,
        session.token,
        session.credentials,
        opts.channels,
    );
    tokio::spawn(async move {
        ws.run(
            ws_inbound_tx,
            ws_control_rx,
            relay_broker::events::EventEmitter::new(false),
        )
        .await;
    });

    Ok(RelaySession {
        http_base,
        relay_workspace_key,
        self_agent_id,
        self_names,
        self_agent_ids,
        ws_inbound_rx,
        ws_control_tx,
    })
}

#[derive(Debug)]
struct WorkerHandle {
    spec: AgentSpec,
    parent: Option<String>,
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
    priority: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct SendInputPayload {
    name: String,
    data: String,
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

fn is_system_sender(sender: &str) -> bool {
    sender == "system" || sender == "human:orchestrator" || sender.starts_with("human:")
}

struct WorkerRegistry {
    workers: HashMap<String, WorkerHandle>,
    event_tx: mpsc::Sender<WorkerEvent>,
    worker_env: Vec<(String, String)>,
    initial_tasks: HashMap<String, String>,
    supervisor: relay_broker::supervisor::Supervisor,
    metrics: relay_broker::metrics::MetricsCollector,
}

impl WorkerRegistry {
    fn new(
        event_tx: mpsc::Sender<WorkerEvent>,
        worker_env: Vec<(String, String)>,
        broker_start: Instant,
    ) -> Self {
        Self {
            workers: HashMap::new(),
            event_tx,
            worker_env,
            initial_tasks: HashMap::new(),
            supervisor: relay_broker::supervisor::Supervisor::new(),
            metrics: relay_broker::metrics::MetricsCollector::new(broker_start),
        }
    }

    fn list(&self) -> Vec<Value> {
        self.workers
            .iter()
            .map(|(name, handle)| {
                json!({
                    "name": name,
                    "runtime": handle.spec.runtime,
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
    ) -> Result<()> {
        if self.workers.contains_key(&spec.name) {
            anyhow::bail!("agent '{}' already exists", spec.name);
        }

        let mut command =
            Command::new(std::env::current_exe().context("failed to locate current executable")?);

        match spec.runtime {
            AgentRuntime::Pty => {
                let cli = spec.cli.as_deref().context("pty runtime requires `cli`")?;
                command.arg("pty");
                command.arg("--agent-name").arg(&spec.name);
                if let Some(secs) = idle_threshold_secs {
                    command.arg("--idle-threshold-secs").arg(secs.to_string());
                }
                command.arg(cli);

                // Auto-add bypass flags for CLIs that need them to run non-interactively.
                // Each CLI has its own flag; we only add it if the user didn't already.
                let cli_lower = cli.to_lowercase();
                let is_claude = cli_lower == "claude" || cli_lower.starts_with("claude:");
                let is_codex = cli_lower == "codex";

                let bypass_flag: Option<&str> = if is_claude
                    && !spec
                        .args
                        .iter()
                        .any(|a| a.contains("dangerously-skip-permissions"))
                {
                    Some("--dangerously-skip-permissions")
                } else if is_codex && !spec.args.iter().any(|a| a.contains("full-auto")) {
                    Some("--full-auto")
                } else {
                    None
                };

                // Build MCP config args for CLIs that support dynamic MCP configuration.
                let cwd = spec.cwd.as_deref().unwrap_or(".");
                let mcp_args = configure_relaycast_mcp(
                    cli,
                    &spec.name,
                    self.env_value("RELAY_API_KEY"),
                    self.env_value("RELAY_BASE_URL"),
                    &spec.args,
                    Path::new(cwd),
                )
                .await?;

                let has_extra =
                    bypass_flag.is_some() || !spec.args.is_empty() || !mcp_args.is_empty();
                if has_extra {
                    command.arg("--");
                    if let Some(flag) = bypass_flag {
                        command.arg(flag);
                    }
                    for arg in &mcp_args {
                        command.arg(arg);
                    }
                    for arg in &spec.args {
                        command.arg(arg);
                    }
                }
            }
            AgentRuntime::HeadlessClaude => {
                command.arg("headless");
                command.arg("--agent-name").arg(&spec.name);
                command.arg("claude");

                // Build MCP config for headless Claude agents.
                let mcp_args = configure_relaycast_mcp(
                    "claude",
                    &spec.name,
                    self.env_value("RELAY_API_KEY"),
                    self.env_value("RELAY_BASE_URL"),
                    &spec.args,
                    Path::new(spec.cwd.as_deref().unwrap_or(".")),
                )
                .await?;

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

        spawn_worker_reader(
            self.event_tx.clone(),
            spec.name.clone(),
            "stdout",
            stdout,
            true,
        );
        spawn_worker_reader(
            self.event_tx.clone(),
            spec.name.clone(),
            "stderr",
            stderr,
            false,
        );

        let handle = WorkerHandle {
            spec: spec.clone(),
            parent,
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
        self.send_to_worker(name, "deliver_relay", None, serde_json::to_value(delivery)?)
            .await
    }

    async fn release(&mut self, name: &str) -> Result<()> {
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

        terminate_child(&mut handle.child, Duration::from_secs(2)).await
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
            let status = if let Some(handle) = self.workers.get_mut(&name) {
                handle.child.try_wait()?
            } else {
                None
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
            }
        }
        Ok(exited)
    }

    fn worker_names_for_channel_delivery(&self, channel: &str, from: &str) -> Vec<String> {
        let normalized = normalize_channel(channel);
        self.workers
            .iter()
            .filter_map(|(name, handle)| {
                if name.eq_ignore_ascii_case(from) {
                    return None;
                }
                let joined: HashSet<String> = handle
                    .spec
                    .channels
                    .iter()
                    .map(|c| normalize_channel(c))
                    .collect();
                if joined.contains(&normalized) {
                    Some(name.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    fn worker_names_for_direct_target(&self, target: &str, from: &str) -> Vec<String> {
        let trimmed = target.trim();
        self.workers
            .keys()
            .filter(|name| {
                if name.eq_ignore_ascii_case(from) {
                    return false;
                }
                trimmed.eq_ignore_ascii_case(name)
                    || trimmed.eq_ignore_ascii_case(&format!("@{name}"))
            })
            .cloned()
            .collect()
    }
}

fn spawn_worker_reader<R>(
    tx: mpsc::Sender<WorkerEvent>,
    name: String,
    stream_name: &'static str,
    reader: R,
    parse_json: bool,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if parse_json {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
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
        Commands::Listen(_) => "listen",
        Commands::Wrap { .. } => "wrap",
    };
    telemetry.track(TelemetryEvent::CliCommandRun {
        command_name: command_name.to_string(),
    });

    match cli.command {
        Commands::Init(cmd) => run_init(cmd, telemetry).await,
        Commands::Pty(cmd) => pty_worker::run_pty_worker(cmd).await,
        Commands::Headless(cmd) => run_headless_worker(cmd).await,
        Commands::Listen(cmd) => run_listen(cmd, telemetry).await,
        Commands::Wrap { cli, args } => wrap::run_wrap(cli, args, false, telemetry).await,
    }
}

async fn run_init(cmd: InitCommand, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let mut agent_spawn_count: u32 = 0;
    telemetry.track(TelemetryEvent::BrokerStart);

    let runtime_cwd = std::env::current_dir()?;
    let paths = ensure_runtime_paths(&runtime_cwd)?;
    let mut state = BrokerState::load(&paths.state).unwrap_or_default();

    // Clean up agents from previous sessions whose processes have died
    let reaped = state.reap_dead_agents();
    if !reaped.is_empty() {
        tracing::info!(
            agents = ?reaped,
            "reaped {} dead agent(s) from previous session",
            reaped.len()
        );
        state.save(&paths.state)?;
    }

    if std::env::var("AGENT_RELAY_DISABLE_RELAYCAST").is_ok() {
        anyhow::bail!(
            "AGENT_RELAY_DISABLE_RELAYCAST is no longer supported; broker requires Relaycast"
        );
    }

    let relay = connect_relay(RelaySessionOptions {
        paths: &paths,
        requested_name: &cmd.name,
        channels: channels_from_csv(&cmd.channels),
        strict_name: false,
        read_mcp_identity: true,
        ensure_mcp_config: true,
        runtime_cwd: &runtime_cwd,
    })
    .await?;

    let RelaySession {
        http_base,
        relay_workspace_key,
        self_agent_id: _,
        self_names,
        self_agent_ids,
        mut ws_inbound_rx,
        ws_control_tx,
    } = relay;

    // Build HTTP client for forwarding messages to Relaycast REST API
    let relaycast_http = {
        let agent_name = self_names
            .iter()
            .next()
            .cloned()
            .unwrap_or_else(|| "broker".to_string());
        RelaycastHttpClient::new(&http_base, &relay_workspace_key, agent_name)
    };

    let worker_env = vec![
        ("RELAY_BASE_URL".to_string(), http_base.clone()),
        ("RELAY_API_KEY".to_string(), relay_workspace_key),
    ];

    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(1024);
    tokio::spawn(async move {
        while let Some(frame) = sdk_out_rx.recv().await {
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
    let mut workers = WorkerRegistry::new(worker_event_tx, worker_env, broker_start);

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
    if !pending_deliveries.is_empty() {
        tracing::info!(
            count = pending_deliveries.len(),
            "loaded {} pending deliveries from previous session",
            pending_deliveries.len()
        );
    }

    let mut shutdown = false;

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
                                &telemetry,
                                &mut agent_spawn_count,
                                Some(&relaycast_http),
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
                    // Handle agent.release_requested from Relaycast (e.g. agent self-termination via remove_agent MCP)
                    if let Some(rc_event) = parse_relaycast_agent_event(&ws_msg) {
                        match rc_event {
                            RelaycastAgentEvent::Release { ref name } => {
                                workers.supervisor.unregister(name);
                                workers.metrics.on_release(name);
                                match workers.release(name).await {
                                    Ok(()) => {
                                        let dropped = drop_pending_for_worker(&mut pending_deliveries, name);
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
                                        state.agents.remove(name);
                                        if let Err(error) = state.save(&paths.state) {
                                            tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state");
                                        }
                                        let _ = send_event(
                                            &sdk_out_tx,
                                            json!({"kind":"agent_exited","name":name,"code":0,"signal":null}),
                                        ).await;
                                        tracing::info!(child = %name, "released worker via relaycast in broker mode");
                                        eprintln!("[agent-relay] released worker '{}' via relaycast", name);
                                    }
                                    Err(error) => {
                                        tracing::error!(child = %name, error = %error, "failed to release worker via relaycast");
                                        eprintln!("[agent-relay] failed to release '{}': {}", name, error);
                                    }
                                }
                                continue;
                            }
                            RelaycastAgentEvent::Spawn { ref name, ref cli } => {
                                // Spawn is not supported in broker init mode — agents are managed by the SDK
                                tracing::warn!(name = %name, cli = %cli, "ignoring spawn request in broker init mode");
                                continue;
                            }
                        }
                    }

                    if let Some(mapped) = map_ws_event(&ws_msg) {
                        if !dedup.insert_if_new(&mapped.event_id, Instant::now()) {
                            continue;
                        }
                        if self_names.contains(&mapped.from)
                            || mapped.sender_agent_id.as_ref().is_some_and(|id| self_agent_ids.contains(id))
                        {
                            tracing::debug!(from = %mapped.from, sender_agent_id = ?mapped.sender_agent_id, "skipping self-echo in broker loop");
                            continue;
                        }

                        let _ = send_event(
                            &sdk_out_tx,
                            json!({
                                "kind": "relay_inbound",
                                "event_id": mapped.event_id,
                                "from": mapped.from,
                                "target": mapped.target,
                                "body": mapped.text,
                                "thread_id": mapped.thread_id,
                            }),
                        ).await;

                        telemetry.track(TelemetryEvent::MessageSend {
                            is_broadcast: mapped.target.starts_with('#'),
                            has_thread: mapped.thread_id.is_some(),
                        });

                        if mapped.target.starts_with('#') {
                            let targets = workers.worker_names_for_channel_delivery(&mapped.target, &mapped.from);
                            for worker_name in targets {
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
                        } else {
                            let targets = workers.worker_names_for_direct_target(&mapped.target, &mapped.from);
                            for worker_name in targets {
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
                        }
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
                                        if let Ok(ack) = serde_json::from_value::<DeliveryAckPayload>(payload.clone()) {
                                            let should_remove = match pending_deliveries.get(&ack.delivery_id) {
                                                Some(pending) if pending.delivery.event_id != ack.event_id => {
                                                    tracing::warn!(
                                                        target = "agent_relay::broker",
                                                        delivery_id = %ack.delivery_id,
                                                        expected_event_id = %pending.delivery.event_id,
                                                        received_event_id = %ack.event_id,
                                                        "delivery ack event_id mismatch — ignoring stale ack"
                                                    );
                                                    false
                                                }
                                                _ => true,
                                            };
                                            if should_remove {
                                                pending_deliveries.remove(&ack.delivery_id);
                                            }
                                        }
                                        let _ = send_event(&sdk_out_tx, json!({
                                            "kind": "delivery_ack",
                                            "name": name,
                                            "delivery_id": payload.get("delivery_id"),
                                            "event_id": payload.get("event_id"),
                                            "timestamp": payload.get("timestamp"),
                                        })).await;
                                    }
                                } else if msg_type == "delivery_queued" || msg_type == "delivery_injected" {
                                    if let Some(payload) = value.get("payload") {
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
                                        pending_deliveries.remove(delivery_id);
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
                                        pending_deliveries.remove(delivery_id);
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
                                            2,
                                            delivery_retry_interval,
                                        ).await {
                                            tracing::warn!(worker = %name, error = %e, "failed to deliver initial_task");
                                        }
                                    }
                                    let runtime = value.get("payload")
                                        .and_then(|p| p.get("runtime"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("pty");
                                    let _ = send_event(&sdk_out_tx, json!({
                                        "kind": "worker_ready",
                                        "name": name,
                                        "runtime": runtime,
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
                            state.agents.remove(name);
                            if let Err(error) = state.save(&paths.state) {
                                tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state");
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
                            state.agents.remove(name);
                            if let Err(error) = state.save(&paths.state) {
                                tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state");
                            }
                        }
                    }
                }

                // Check for agents ready to restart (past cooldown)
                if !shutdown {
                    let pending_restarts = workers.supervisor.pending_restarts();
                    for (name, rst) in pending_restarts {
                        match workers.spawn(rst.spec.clone(), rst.parent.clone(), None).await {
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
                            }
                            Err(e) => {
                                tracing::error!(name = %name, error = %e, "restart failed");
                            }
                        }
                    }
                }

                // Persist pending deliveries for crash recovery
                if let Err(error) = save_pending_deliveries(&paths.pending, &pending_deliveries) {
                    tracing::warn!(path = %paths.pending.display(), error = %error, "failed to persist pending deliveries");
                }
            }
        }
    }

    // Save crash insights before shutdown
    if let Err(error) = crash_insights.save(&crash_insights_path) {
        tracing::warn!(error = %error, "failed to save crash insights");
    }

    telemetry.track(TelemetryEvent::BrokerStop {
        uptime_seconds: broker_start.elapsed().as_secs(),
        agent_spawn_count,
    });
    telemetry.shutdown();

    if let Err(error) = ws_control_tx.send(WsControl::Shutdown).await {
        tracing::warn!(error = %error, "failed to send ws shutdown signal");
    }
    pending_deliveries.clear();
    // Clean shutdown — remove pending file since nothing is pending
    let _ = std::fs::remove_file(&paths.pending);
    workers.shutdown_all().await?;

    // Clean up PID file on graceful shutdown
    let _ = std::fs::remove_file(&paths.pid);

    Ok(())
}

/// Listen mode: connect to Relaycast WS and log events without wrapping a CLI.
/// Handles spawn/release commands from both WS events and an HTTP API.
/// The HTTP API (default port 3889) accepts spawn/release/list requests.
/// Usage: `agent-relay-broker listen --agent-name hub --channels general,ops --port 3889`
async fn run_listen(cmd: ListenCommand, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let mut agent_spawn_count: u32 = 0;
    telemetry.track(TelemetryEvent::BrokerStart);
    let requested_name = cmd
        .agent_name
        .or_else(|| std::env::var("RELAY_AGENT_NAME").ok())
        .unwrap_or_else(|| "listener".to_string());
    let api_port = cmd.port;

    // --- Auth & Relaycast connection ---
    let runtime_cwd = std::env::current_dir()?;
    let paths = ensure_runtime_paths(&runtime_cwd)?;

    // Resolve channel list: --all fetches from Relaycast API, otherwise use --channels or default
    let channel_list = if cmd.all {
        let fetched = fetch_all_channels(&paths).await.unwrap_or_default();
        if fetched.is_empty() {
            eprintln!("[agent-relay] --all: no channels found, falling back to 'general'");
            vec!["general".to_string()]
        } else {
            eprintln!(
                "[agent-relay] --all: subscribing to {} channels",
                fetched.len()
            );
            fetched
        }
    } else {
        let channels = cmd
            .channels
            .or_else(|| std::env::var("RELAY_CHANNELS").ok())
            .unwrap_or_else(|| "general".to_string());
        channels_from_csv(&channels)
    };

    // Build CSV string for child agent env vars
    let channels = channel_list.join(",");

    eprintln!(
        "[agent-relay] listen mode (agent: {}, channels: {:?}, api port: {})",
        requested_name, channel_list, api_port
    );

    let relay = connect_relay(RelaySessionOptions {
        paths: &paths,
        requested_name: &requested_name,
        channels: channel_list,
        strict_name: false,
        read_mcp_identity: false,
        ensure_mcp_config: false,
        runtime_cwd: &runtime_cwd,
    })
    .await?;

    let RelaySession {
        http_base,
        relay_workspace_key,
        self_agent_id,
        self_names,
        self_agent_ids,
        mut ws_inbound_rx,
        ws_control_tx,
    } = relay;

    // Values for child agent env vars
    let child_api_key = relay_workspace_key;
    let child_base_url = http_base;

    // Spawner for child agents
    let mut spawner = Spawner::new();

    // --- HTTP API ---
    // Handlers send requests through a channel; the main loop processes them
    // since Spawner isn't Send/Sync (owns Child processes).
    let (api_tx, mut api_rx) = mpsc::channel::<ListenApiRequest>(32);

    let api_router = listen_api_router(api_tx);
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{api_port}"))
        .await
        .with_context(|| format!("failed to bind API on port {api_port}"))?;
    eprintln!("[agent-relay] API listening on http://127.0.0.1:{api_port}");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, api_router).await {
            tracing::error!(error = %e, "HTTP API server error");
        }
    });

    eprintln!("[agent-relay] listening — press Ctrl-C to stop");

    let mut dedup = DedupCache::new(Duration::from_secs(300), 8192);

    let mut reap_tick = tokio::time::interval(Duration::from_secs(5));
    reap_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut running = true;
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;

    while running {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                running = false;
            }

            _ = sigterm.recv() => {
                tracing::info!("received SIGTERM, shutting down");
                running = false;
            }

            // HTTP API requests
            Some(req) = api_rx.recv() => {
                match req {
                    ListenApiRequest::Spawn { name, cli, args, reply } => {
                        let env_vars = spawn_env_vars(&name, &child_api_key, &child_base_url, &channels);
                        match spawner.spawn_wrap(&name, &cli, &args, &env_vars, Some("Dashboard")).await {
                            Ok(pid) => {
                                agent_spawn_count += 1;
                                telemetry.track(TelemetryEvent::AgentSpawn {
                                    cli: cli.clone(),
                                    runtime: "pty".to_string(),
                                });
                                eprintln!("[agent-relay] spawned child '{}' (pid {})", name, pid);
                                let _ = reply.send(Ok(json!({ "success": true, "name": name, "pid": pid })));
                            }
                            Err(error) => {
                                eprintln!("[agent-relay] failed to spawn '{}': {}", name, error);
                                let _ = reply.send(Err(error.to_string()));
                            }
                        }
                    }
                    ListenApiRequest::Release { name, reply } => {
                        match spawner.release(&name, Duration::from_secs(2)).await {
                            Ok(()) => {
                                telemetry.track(TelemetryEvent::AgentRelease {
                                    cli: String::new(),
                                    release_reason: "api_request".to_string(),
                                    lifetime_seconds: 0,
                                });
                                eprintln!("[agent-relay] released child '{}'", name);
                                let _ = reply.send(Ok(json!({ "success": true, "name": name })));
                            }
                            Err(error) => {
                                eprintln!("[agent-relay] failed to release '{}': {}", name, error);
                                let _ = reply.send(Err(error.to_string()));
                            }
                        }
                    }
                    ListenApiRequest::List { reply } => {
                        let agents = spawner.list_children();
                        let _ = reply.send(Ok(json!({ "success": true, "agents": agents })));
                    }
                }
            }

            ws_msg = ws_inbound_rx.recv() => {
                match ws_msg {
                    Some(ws_msg) => {
                        // Handle spawn/release broker commands from WS
                        if let Some(cmd_event) = map_ws_broker_command(&ws_msg) {
                            if !command_targets_self(&cmd_event, &self_agent_id) {
                                tracing::debug!(
                                    command = %cmd_event.command,
                                    handler_agent_id = ?cmd_event.handler_agent_id,
                                    self_agent_id = %self_agent_id,
                                    "ignoring command event for a different handler"
                                );
                                continue;
                            }
                            match cmd_event.payload {
                                BrokerCommandPayload::Spawn(ref params) => {
                                    if params.name.is_empty() || params.cli.is_empty() {
                                        tracing::error!("spawn command missing name or cli");
                                        continue;
                                    }
                                    let env_vars = spawn_env_vars(&params.name, &child_api_key, &child_base_url, &channels);
                                    match spawner.spawn_wrap(
                                        &params.name, &params.cli, &params.args, &env_vars, Some(&cmd_event.invoked_by),
                                    ).await {
                                        Ok(pid) => {
                                            agent_spawn_count += 1;
                                            telemetry.track(TelemetryEvent::AgentSpawn {
                                                cli: params.cli.clone(),
                                                runtime: "pty".to_string(),
                                            });
                                            tracing::info!(child = %params.name, cli = %params.cli, pid = pid, invoked_by = %cmd_event.invoked_by, "spawned child agent");
                                            eprintln!("[agent-relay] spawned child '{}' (pid {})", params.name, pid);
                                        }
                                        Err(error) => {
                                            tracing::error!(child = %params.name, error = %error, "failed to spawn child agent");
                                            eprintln!("[agent-relay] failed to spawn '{}': {}", params.name, error);
                                        }
                                    }
                                }
                                BrokerCommandPayload::Release(ref params) => {
                                    let sender_is_human = is_human_sender(&cmd_event.invoked_by, SenderKind::Unknown);
                                    let owner = spawner.owner_of(&params.name);
                                    if can_release_child(owner, &cmd_event.invoked_by, sender_is_human) {
                                        match spawner.release(&params.name, Duration::from_secs(2)).await {
                                            Ok(()) => {
                                                telemetry.track(TelemetryEvent::AgentRelease {
                                                    cli: String::new(),
                                                    release_reason: "ws_command".to_string(),
                                                    lifetime_seconds: 0,
                                                });
                                                tracing::info!(child = %params.name, released_by = %cmd_event.invoked_by, "released child agent");
                                                eprintln!("[agent-relay] released child '{}'", params.name);
                                            }
                                            Err(error) => {
                                                tracing::error!(child = %params.name, error = %error, "failed to release child agent");
                                                eprintln!("[agent-relay] failed to release '{}': {}", params.name, error);
                                            }
                                        }
                                    } else {
                                        tracing::warn!(child = %params.name, sender = %cmd_event.invoked_by, "release denied: sender is not owner or human");
                                    }
                                }
                            }
                            continue;
                        }

                        // Handle agent.spawn_requested / agent.release_requested from relaycast REST API
                        if let Some(rc_event) = parse_relaycast_agent_event(&ws_msg) {
                            match rc_event {
                                RelaycastAgentEvent::Spawn { ref name, ref cli } => {
                                    let env_vars = spawn_env_vars(name, &child_api_key, &child_base_url, &channels);
                                    match spawner.spawn_wrap(
                                        name, cli, &[], &env_vars, Some("relaycast"),
                                    ).await {
                                        Ok(pid) => {
                                            agent_spawn_count += 1;
                                            telemetry.track(TelemetryEvent::AgentSpawn {
                                                cli: cli.clone(),
                                                runtime: "pty".to_string(),
                                            });
                                            tracing::info!(child = %name, cli = %cli, pid = pid, "spawned child agent via relaycast");
                                            eprintln!("[agent-relay] spawned child '{}' (pid {}) via relaycast", name, pid);
                                        }
                                        Err(error) => {
                                            tracing::error!(child = %name, error = %error, "failed to spawn child agent via relaycast");
                                            eprintln!("[agent-relay] failed to spawn '{}': {}", name, error);
                                        }
                                    }
                                }
                                RelaycastAgentEvent::Release { ref name } => {
                                    match spawner.release(name, Duration::from_secs(2)).await {
                                        Ok(()) => {
                                            telemetry.track(TelemetryEvent::AgentRelease {
                                                cli: String::new(),
                                                release_reason: "relaycast_release".to_string(),
                                                lifetime_seconds: 0,
                                            });
                                            tracing::info!(child = %name, "released child agent via relaycast");
                                            eprintln!("[agent-relay] released child '{}' via relaycast", name);
                                        }
                                        Err(error) => {
                                            tracing::error!(child = %name, error = %error, "failed to release child agent via relaycast");
                                            eprintln!("[agent-relay] failed to release '{}': {}", name, error);
                                        }
                                    }
                                }
                            }
                            continue;
                        }

                        // Log regular relay events
                        if let Some(mapped) = map_ws_event(&ws_msg) {
                            if !dedup.insert_if_new(&mapped.event_id, Instant::now()) {
                                continue;
                            }
                            if self_names.contains(&mapped.from)
                                || mapped.sender_agent_id.as_ref().is_some_and(|id| self_agent_ids.contains(id))
                            {
                                tracing::debug!(from = %mapped.from, sender_agent_id = ?mapped.sender_agent_id, "skipping self-echo in listen mode");
                                continue;
                            }
                            eprintln!(
                                "[relay] {} → {}: {}",
                                mapped.from,
                                mapped.target,
                                if mapped.text.len() > 120 {
                                    let boundary = floor_char_boundary(&mapped.text, 120);
                                    format!("{}…", &mapped.text[..boundary])
                                } else {
                                    mapped.text.clone()
                                }
                            );
                        }
                    }
                    None => {
                        running = false;
                    }
                }
            }

            _ = reap_tick.tick() => {
                if let Ok(exited) = spawner.reap_exited().await {
                    for name in exited {
                        telemetry.track(TelemetryEvent::AgentCrash {
                            cli: String::new(),
                            exit_code: None,
                            lifetime_seconds: 0,
                        });
                        tracing::info!(child = %name, "child agent exited");
                        eprintln!("[agent-relay] child '{}' exited", name);
                    }
                }
            }
        }
    }

    telemetry.track(TelemetryEvent::BrokerStop {
        uptime_seconds: broker_start.elapsed().as_secs(),
        agent_spawn_count,
    });
    telemetry.shutdown();

    // Cleanup
    spawner.shutdown_all(Duration::from_secs(2)).await;
    if let Err(e) = ws_control_tx.send(WsControl::Shutdown).await {
        tracing::warn!(error = %e, "failed to send WS shutdown in listen cleanup");
    }

    // Clean up PID file on graceful shutdown
    let _ = std::fs::remove_file(&paths.pid);

    // Ensure lock is held until after all cleanup is complete
    drop(paths);

    eprintln!("[agent-relay] listen session ended");
    Ok(())
}

// --- Listen-mode HTTP API types and handlers ---

enum ListenApiRequest {
    Spawn {
        name: String,
        cli: String,
        args: Vec<String>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Release {
        name: String,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    List {
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
}

#[derive(Clone)]
struct ListenApiState {
    tx: mpsc::Sender<ListenApiRequest>,
}

fn listen_api_router(tx: mpsc::Sender<ListenApiRequest>) -> axum::Router {
    use axum::{routing, Router};

    let state = ListenApiState { tx };

    Router::new()
        .route("/api/spawn", routing::post(listen_api_spawn))
        .route("/api/spawned", routing::get(listen_api_list))
        .route("/api/spawned/{name}", routing::delete(listen_api_release))
        .route("/health", routing::get(listen_api_health))
        .with_state(state)
}

async fn listen_api_health() -> axum::Json<Value> {
    axum::Json(json!({
        "status": "ok",
        "service": "agent-relay-listen",
    }))
}

async fn listen_api_spawn(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::Json(body): axum::Json<Value>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let cli = body
        .get("cli")
        .and_then(Value::as_str)
        .unwrap_or("claude")
        .to_string();
    let args: Vec<String> = body
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    if name.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(json!({ "success": false, "error": "Missing required field: name" })),
        );
    }

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Spawn {
            name: name.clone(),
            cli,
            args,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal channel closed" })),
        );
    }

    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "name": name, "error": err })),
        ),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal reply dropped" })),
        ),
    }
}

async fn listen_api_list(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> axum::Json<Value> {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::List { reply: reply_tx })
        .await
        .is_err()
    {
        return axum::Json(json!({ "success": false, "agents": [] }));
    }
    match reply_rx.await {
        Ok(Ok(val)) => axum::Json(val),
        _ => axum::Json(json!({ "success": false, "agents": [] })),
    }
}

async fn listen_api_release(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Release {
            name: name.clone(),
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal channel closed" })),
        );
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "name": name, "error": err })),
        ),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal reply dropped" })),
        ),
    }
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
    telemetry: &TelemetryClient,
    agent_spawn_count: &mut u32,
    relaycast_http: Option<&RelaycastHttpClient>,
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
            let mut effective_task = payload.initial_task.clone();
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
                                                let from =
                                                    m.get("from").and_then(Value::as_str).unwrap_or("?");
                                                let text =
                                                    m.get("text").and_then(Value::as_str).unwrap_or("");
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
                                        format!("{}\n\n## Current Task\n{}", continuity_block, new_task)
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

            workers
                .spawn(payload.agent.clone(), None, payload.idle_threshold_secs)
                .await?;
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
                    initial_task: payload.initial_task.clone(),
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
                restart_policy,
            );
            workers.metrics.on_spawn(&name);

            *agent_spawn_count += 1;
            telemetry.track(TelemetryEvent::AgentSpawn {
                cli: payload.agent.cli.clone().unwrap_or_default(),
                runtime: format!("{:?}", runtime),
            });

            send_ok(
                out_tx,
                frame.request_id,
                json!({
                    "name": name,
                    "runtime": runtime,
                }),
            )
            .await?;
            send_event(
                out_tx,
                json!({
                    "kind": "agent_spawned",
                    "name": name,
                    "runtime": runtime,
                    "parent": Value::Null,
                }),
            )
            .await?;
            Ok(false)
        }
        "send_message" => {
            let payload: SendMessagePayload = serde_json::from_value(frame.payload)
                .context("send_message payload must contain `to` and `text`")?;
            let from = payload
                .from
                .unwrap_or_else(|| "human:orchestrator".to_string());
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
                    priority,
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
                    }),
                )
                .await?;
            } else if let Some(http) = relaycast_http {
                // Target is not a local worker — forward via Relaycast REST API
                let to = payload.to.clone();
                let eid = event_id.clone();
                match http.send(&to, &payload.text).await {
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

            // Check agent exists before attempting release
            if !workers.workers.contains_key(&payload.name) {
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

                    let continuity_file =
                        continuity_dir.join(format!("{}.json", payload.name));
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
        mapped.priority.as_u8(),
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
    priority: u8,
    retry_interval: Duration,
) -> Result<()> {
    let delivery = RelayDelivery {
        delivery_id: format!("del_{}", Uuid::new_v4().simple()),
        event_id: event_id.to_string(),
        from: from.to_string(),
        target: target.to_string(),
        body: body.to_string(),
        thread_id,
        priority: Some(priority),
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

fn drop_pending_for_worker(
    pending_deliveries: &mut HashMap<String, PendingDelivery>,
    worker_name: &str,
) -> usize {
    let before = pending_deliveries.len();
    pending_deliveries.retain(|_, pending| pending.worker_name != worker_name);
    before.saturating_sub(pending_deliveries.len())
}

async fn run_headless_worker(cmd: HeadlessCommand) -> Result<()> {
    if !matches!(cmd.provider, HeadlessProvider::Claude) {
        anyhow::bail!("unsupported headless provider");
    }

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
                let inferred_name = cmd
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
                    .unwrap_or_else(|| "headless-claude".to_string());

                let _ = send_frame(
                    &out_tx,
                    "worker_ready",
                    frame.request_id,
                    json!({
                        "name": inferred_name,
                        "runtime": "headless_claude",
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

                // TODO(cloud/headless): integrate Claude headless SDK runtime.
                let _ = send_frame(
                    &out_tx,
                    "delivery_ack",
                    frame.request_id,
                    json!({
                        "delivery_id": delivery.delivery_id,
                        "event_id": delivery.event_id,
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

/// Fetch all channel names from the Relaycast workspace API.
async fn fetch_all_channels(paths: &RuntimePaths) -> Result<Vec<String>> {
    let http_base = std::env::var("RELAYCAST_BASE_URL")
        .ok()
        .or_else(|| std::env::var("RELAY_BASE_URL").ok())
        .unwrap_or_else(|| DEFAULT_RELAYCAST_BASE_URL.to_string());
    let store = CredentialStore::new(paths.creds.clone());
    let cached = store
        .load()
        .map_err(|_| anyhow::anyhow!("no cached credentials"))?;
    let api_key = &cached.api_key;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{http_base}/v1/channels"))
        .bearer_auth(api_key)
        .send()
        .await
        .context("failed to fetch channels")?;

    if !resp.status().is_success() {
        anyhow::bail!("channels API returned {}", resp.status());
    }
    let body: Value = resp.json().await?;
    let channels = body
        .as_array()
        .or_else(|| body.get("channels").and_then(Value::as_array))
        .map(|arr| {
            arr.iter()
                .filter_map(|ch| ch.get("name").and_then(Value::as_str).map(String::from))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(channels)
}

fn channels_from_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// Parsed result from a relaycast `agent.spawn_requested` or `agent.release_requested` WS event.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RelaycastAgentEvent {
    Spawn { name: String, cli: String },
    Release { name: String },
}

/// Parse a raw WS JSON value into a `RelaycastAgentEvent` if it matches
/// `agent.spawn_requested` or `agent.release_requested`.
fn parse_relaycast_agent_event(value: &serde_json::Value) -> Option<RelaycastAgentEvent> {
    let event_type = value.get("type")?.as_str()?;
    let agent = value.get("agent")?;

    match event_type {
        "agent.spawn_requested" => {
            let name = agent.get("name")?.as_str().filter(|s| !s.is_empty())?;
            let cli = agent.get("cli")?.as_str().filter(|s| !s.is_empty())?;
            Some(RelaycastAgentEvent::Spawn {
                name: name.to_string(),
                cli: cli.to_string(),
            })
        }
        "agent.release_requested" => {
            let name = agent.get("name")?.as_str().filter(|s| !s.is_empty())?;
            Some(RelaycastAgentEvent::Release {
                name: name.to_string(),
            })
        }
        _ => None,
    }
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

fn normalize_channel(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with('#') {
        trimmed.to_string()
    } else {
        format!("#{trimmed}")
    }
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

fn ensure_runtime_paths(cwd: &Path) -> Result<RuntimePaths> {
    let root = cwd.join(".agent-relay");
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create runtime dir {}", root.display()))?;

    let lock_path = root.join("broker.lock");
    let pid_path = root.join("broker.pid");
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
                            creds: root.join("relaycast.json"),
                            state: root.join("state.json"),
                            pending: root.join("pending.json"),
                            pid: pid_path,
                            _lock: lock_file,
                        });
                    }
                }
            }
            anyhow::bail!(
                "another broker instance is already running in this directory ({})",
                root.display()
            );
        }
    }

    // Write our PID for crash recovery
    write_pid_file(&pid_path)?;

    Ok(RuntimePaths {
        creds: root.join("relaycast.json"),
        state: root.join("state.json"),
        pending: root.join("pending.json"),
        pid: pid_path,
        _lock: lock_file,
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
    use std::{collections::HashMap, time::Instant};

    use crate::helpers::terminal_query_responses;
    use relay_broker::protocol::RelayDelivery;

    use super::{
        channels_from_csv, continuity_dir, delivery_retry_interval, derive_ws_base_url_from_http,
        detect_bypass_permissions_prompt, drop_pending_for_worker, extract_mcp_message_ids,
        floor_char_boundary, format_injection, is_auto_suggestion, is_bypass_selection_menu,
        is_in_editor_mode, normalize_channel, parse_relaycast_agent_event, strip_ansi,
        PendingDelivery, RelaycastAgentEvent, TerminalQueryParser,
    };

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
    fn injection_format_preserved() {
        let rendered = format_injection("alice", "evt_1", "hello", "bob");
        assert_eq!(rendered, "Relay message from alice [evt_1]: hello");
    }

    #[test]
    fn injection_format_includes_channel() {
        let rendered = format_injection("alice", "evt_1", "hello", "#general");
        assert_eq!(
            rendered,
            "Relay message from alice in #general [evt_1]: hello"
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
    fn drop_pending_for_worker_removes_only_matching_entries() {
        let mut pending = HashMap::new();
        pending.insert(
            "del_1".to_string(),
            PendingDelivery {
                worker_name: "A".to_string(),
                delivery: RelayDelivery {
                    delivery_id: "del_1".to_string(),
                    event_id: "evt_1".to_string(),
                    from: "x".to_string(),
                    target: "#general".to_string(),
                    body: "hello".to_string(),
                    thread_id: None,
                    priority: None,
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
                    from: "y".to_string(),
                    target: "#general".to_string(),
                    body: "world".to_string(),
                    thread_id: None,
                    priority: None,
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
    // The logic is: claude/claude:* → --dangerously-skip-permissions, codex → --full-auto

    fn compute_bypass_flag(cli: &str, existing_args: &[String]) -> Option<&'static str> {
        let cli_lower = cli.to_lowercase();
        if (cli_lower == "claude" || cli_lower.starts_with("claude:"))
            && !existing_args
                .iter()
                .any(|a| a.contains("dangerously-skip-permissions"))
        {
            Some("--dangerously-skip-permissions")
        } else if cli_lower == "codex" && !existing_args.iter().any(|a| a.contains("full-auto")) {
            Some("--full-auto")
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
    fn bypass_flag_codex_gets_full_auto() {
        assert_eq!(compute_bypass_flag("codex", &[]), Some("--full-auto"));
    }

    #[test]
    fn bypass_flag_gemini_gets_none() {
        assert_eq!(compute_bypass_flag("gemini", &[]), None);
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
        let args = vec!["--full-auto".to_string()];
        assert_eq!(
            compute_bypass_flag("codex", &args),
            None,
            "should not duplicate flag"
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
            Some("--full-auto"),
            "unrelated args should not prevent bypass flag"
        );
    }

    // --- parse_relaycast_agent_event tests ---

    #[test]
    fn parses_agent_spawn_requested() {
        let event = parse_relaycast_agent_event(&serde_json::json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "Worker1",
                "cli": "claude",
                "task": "Do some work",
                "channel": "general",
                "already_existed": false
            }
        }));
        assert_eq!(
            event,
            Some(RelaycastAgentEvent::Spawn {
                name: "Worker1".into(),
                cli: "claude".into(),
            })
        );
    }

    #[test]
    fn parses_agent_spawn_requested_null_channel() {
        let event = parse_relaycast_agent_event(&serde_json::json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "Worker2",
                "cli": "codex",
                "task": "Task text",
                "channel": null,
                "already_existed": true
            }
        }));
        assert_eq!(
            event,
            Some(RelaycastAgentEvent::Spawn {
                name: "Worker2".into(),
                cli: "codex".into(),
            })
        );
    }

    #[test]
    fn parses_agent_release_requested() {
        let event = parse_relaycast_agent_event(&serde_json::json!({
            "type": "agent.release_requested",
            "agent": { "name": "Worker1" },
            "reason": "task complete",
            "deleted": false
        }));
        assert_eq!(
            event,
            Some(RelaycastAgentEvent::Release {
                name: "Worker1".into(),
            })
        );
    }

    #[test]
    fn spawn_requested_missing_name_returns_none() {
        assert!(parse_relaycast_agent_event(&serde_json::json!({
            "type": "agent.spawn_requested",
            "agent": { "cli": "claude", "task": "work" }
        }))
        .is_none());
    }

    #[test]
    fn spawn_requested_missing_cli_returns_none() {
        assert!(parse_relaycast_agent_event(&serde_json::json!({
            "type": "agent.spawn_requested",
            "agent": { "name": "Worker1", "task": "work" }
        }))
        .is_none());
    }

    #[test]
    fn spawn_requested_empty_name_returns_none() {
        assert!(parse_relaycast_agent_event(&serde_json::json!({
            "type": "agent.spawn_requested",
            "agent": { "name": "", "cli": "claude", "task": "work" }
        }))
        .is_none());
    }

    #[test]
    fn release_requested_empty_name_returns_none() {
        assert!(parse_relaycast_agent_event(&serde_json::json!({
            "type": "agent.release_requested",
            "agent": { "name": "" },
            "reason": null,
            "deleted": false
        }))
        .is_none());
    }

    #[test]
    fn release_requested_missing_agent_returns_none() {
        assert!(parse_relaycast_agent_event(&serde_json::json!({
            "type": "agent.release_requested",
            "reason": "done",
            "deleted": true
        }))
        .is_none());
    }

    #[test]
    fn unrelated_event_type_returns_none() {
        assert!(parse_relaycast_agent_event(&serde_json::json!({
            "type": "message.created",
            "agent": { "name": "Worker1", "cli": "claude" }
        }))
        .is_none());
    }

    #[test]
    fn command_invoked_not_matched_by_relaycast_parser() {
        assert!(parse_relaycast_agent_event(&serde_json::json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "123",
            "parameters": { "name": "x", "cli": "y" }
        }))
        .is_none());
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
        assert!(
            !super::is_pid_alive(pid),
            "exited child PID should be dead"
        );
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
        let pid: u32 = contents.trim().parse().expect("pid file should contain a number");
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
        assert_eq!(
            result,
            std::path::PathBuf::from(".agent-relay/continuity")
        );
    }
}
