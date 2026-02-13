use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
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
    relaycast_ws::{RelaycastWsClient, WsControl},
    snippets::ensure_relaycast_mcp_config,
    spawner::{terminate_child, Spawner},
    telemetry::{TelemetryClient, TelemetryEvent},
    types::{BrokerCommandEvent, BrokerCommandPayload, SenderKind},
};

const DEFAULT_DELIVERY_RETRY_MS: u64 = 1_000;
const MAX_DELIVERY_RETRIES: u32 = 10;
const DEFAULT_RELAYCAST_BASE_URL: &str = "https://api.relaycast.dev";

// PTY auto-response constants (shared by run_wrap and run_pty_worker)
const BYPASS_PERMS_COOLDOWN: Duration = Duration::from_secs(2);
const BYPASS_PERMS_MAX_SENDS: u32 = 5;
const AUTO_ENTER_TIMEOUT: Duration = Duration::from_secs(10);
const AUTO_ENTER_COOLDOWN: Duration = Duration::from_secs(5);
const MAX_AUTO_ENTER_RETRIES: u32 = 5;
const AUTO_SUGGESTION_BLOCK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Parser)]
#[command(name = "agent-relay")]
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
    /// Usage: agent-relay wrap codex -- --full-auto
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
}

#[derive(Debug)]
struct RuntimePaths {
    creds: PathBuf,
    state: PathBuf,
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

/// Shared PTY auto-response state used by run_wrap and run_pty_worker.
struct PtyAutoState {
    // MCP approval
    mcp_approved: bool,
    mcp_detection_buffer: String,
    mcp_partial_match_since: Option<Instant>,
    // Bypass permissions
    bypass_perms_buffer: String,
    last_bypass_perms_send: Option<Instant>,
    bypass_perms_send_count: u32,
    // Codex model upgrade prompt
    codex_model_prompt_handled: bool,
    codex_model_buffer: String,
    // Gemini "Action Required" prompt
    gemini_action_buffer: String,
    last_gemini_action_approval: Option<Instant>,
    // Auto-suggestion / injection state
    auto_suggestion_visible: bool,
    last_injection_time: Option<Instant>,
    last_auto_enter_time: Option<Instant>,
    auto_enter_retry_count: u32,
    editor_mode_buffer: String,
    last_output_time: Instant,
}

const MCP_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5);
const GEMINI_ACTION_COOLDOWN: Duration = Duration::from_secs(2);

impl PtyAutoState {
    fn new() -> Self {
        Self {
            mcp_approved: false,
            mcp_detection_buffer: String::new(),
            mcp_partial_match_since: None,
            bypass_perms_buffer: String::new(),
            last_bypass_perms_send: None,
            bypass_perms_send_count: 0,
            codex_model_prompt_handled: false,
            codex_model_buffer: String::new(),
            gemini_action_buffer: String::new(),
            last_gemini_action_approval: None,
            auto_suggestion_visible: false,
            last_injection_time: None,
            last_auto_enter_time: None,
            auto_enter_retry_count: 0,
            editor_mode_buffer: String::new(),
            last_output_time: Instant::now(),
        }
    }

    /// Append `text` to `buf`, keeping only the last `keep` bytes when `buf` exceeds `max`.
    fn append_buf(buf: &mut String, text: &str, max: usize, keep: usize) {
        buf.push_str(text);
        if buf.len() > max {
            let start = floor_char_boundary(buf, buf.len() - keep);
            *buf = buf[start..].to_string();
        }
    }

    /// Detect and approve MCP server prompts in PTY output.
    /// Supports full match (header + option) and partial-match timeout (5s fallback).
    async fn handle_mcp_approval(&mut self, text: &str, pty: &PtySession) {
        if self.mcp_approved {
            return;
        }
        Self::append_buf(&mut self.mcp_detection_buffer, text, 2500, 2000);
        let clean = strip_ansi(&self.mcp_detection_buffer);
        let has_header =
            clean.contains("MCP Server Approval Required") || clean.contains("MCP server approval");
        let has_approve = clean.contains("[a] Approve all servers")
            || clean.contains("Approve all")
            || clean.contains("[a]");

        let full_match = has_header && has_approve;

        // Timeout-based approval: if we have a partial match for 5+ seconds, approve anyway.
        // Handles edge cases where prompt text fragments across reads.
        let timeout_approval = if has_header || has_approve {
            match self.mcp_partial_match_since {
                None => {
                    self.mcp_partial_match_since = Some(Instant::now());
                    false
                }
                Some(since) => since.elapsed() >= MCP_APPROVAL_TIMEOUT,
            }
        } else {
            self.mcp_partial_match_since = None;
            false
        };

        if full_match || timeout_approval {
            self.mcp_approved = true;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = pty.write_all(b"a");
            self.mcp_detection_buffer.clear();
            self.mcp_partial_match_since = None;
        }
    }

    /// Detect and approve bypass-permissions prompts in PTY output.
    async fn handle_bypass_permissions(&mut self, text: &str, pty: &PtySession) {
        let in_cooldown = self
            .last_bypass_perms_send
            .map(|t| t.elapsed() < BYPASS_PERMS_COOLDOWN)
            .unwrap_or(false);
        if !in_cooldown && self.bypass_perms_send_count < BYPASS_PERMS_MAX_SENDS {
            Self::append_buf(&mut self.bypass_perms_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.bypass_perms_buffer);
            let (has_ref, has_confirm) = detect_bypass_permissions_prompt(&clean);
            if has_ref && has_confirm {
                self.bypass_perms_send_count += 1;
                self.last_bypass_perms_send = Some(Instant::now());
                tokio::time::sleep(Duration::from_millis(500)).await;
                if is_bypass_selection_menu(&clean) {
                    let _ = pty.write_all(b"\x1b[B");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let _ = pty.write_all(b"\r");
                } else {
                    let _ = pty.write_all(b"y\n");
                }
                self.bypass_perms_buffer.clear();
            }
        } else if in_cooldown {
            self.bypass_perms_buffer.clear();
        }
    }

    /// Detect and dismiss Codex model upgrade prompts by selecting "Use existing model".
    async fn handle_codex_model_prompt(&mut self, text: &str, pty: &PtySession) {
        if self.codex_model_prompt_handled {
            return;
        }
        Self::append_buf(&mut self.codex_model_buffer, text, 2500, 2000);
        let clean = strip_ansi(&self.codex_model_buffer);
        let (has_upgrade_ref, has_model_options) = detect_codex_model_prompt(&clean);
        if has_upgrade_ref && has_model_options {
            tracing::info!("Detected Codex model upgrade prompt, selecting 'Use existing model'");
            self.codex_model_prompt_handled = true;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = pty.write_all(b"\x1b[B"); // Down arrow → option 2
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = pty.write_all(b"\r"); // Enter to confirm
            self.codex_model_buffer.clear();
        }
    }

    /// Detect and auto-approve Gemini "Action Required" permission prompts.
    async fn handle_gemini_action(&mut self, text: &str, pty: &PtySession) {
        let in_cooldown = self
            .last_gemini_action_approval
            .map(|t| t.elapsed() < GEMINI_ACTION_COOLDOWN)
            .unwrap_or(false);
        if !in_cooldown {
            Self::append_buf(&mut self.gemini_action_buffer, text, 2500, 2000);
            let clean = strip_ansi(&self.gemini_action_buffer);
            let (has_header, has_allow_option) = detect_gemini_action_required(&clean);
            if has_header && has_allow_option {
                tracing::info!("Detected Gemini 'Action Required' prompt, auto-approving with '2'");
                tokio::time::sleep(Duration::from_millis(100)).await;
                let _ = pty.write_all(b"2\n");
                self.gemini_action_buffer.clear();
                self.last_gemini_action_approval = Some(Instant::now());
            }
        } else {
            self.gemini_action_buffer.clear();
        }
    }

    /// Send an enter keystroke if the agent appears stuck after injection.
    /// Uses exponential backoff: 10s → 15s → 25s → 40s → 60s.
    fn try_auto_enter(&mut self, pty: &PtySession) {
        if let Some(injection_time) = self.last_injection_time {
            let backoff_multiplier = match self.auto_enter_retry_count {
                0 => 1.0,
                1 => 1.5,
                2 => 2.5,
                3 => 4.0,
                _ => 6.0,
            };
            let required_silence =
                Duration::from_secs_f64(AUTO_ENTER_TIMEOUT.as_secs_f64() * backoff_multiplier);
            let since_injection = injection_time.elapsed();
            let since_output = self.last_output_time.elapsed();
            let cooldown_ok = self
                .last_auto_enter_time
                .map(|t| t.elapsed() >= AUTO_ENTER_COOLDOWN)
                .unwrap_or(true);
            let in_editor = is_in_editor_mode(&self.editor_mode_buffer);
            if since_injection > required_silence
                && since_output > required_silence
                && cooldown_ok
                && !in_editor
                && !self.auto_suggestion_visible
                && self.auto_enter_retry_count < MAX_AUTO_ENTER_RETRIES
            {
                let _ = pty.write_all(b"\r");
                self.last_auto_enter_time = Some(Instant::now());
                self.auto_enter_retry_count += 1;
            }
        }
    }

    fn update_auto_suggestion(&mut self, text: &str) {
        if is_auto_suggestion(text) {
            self.auto_suggestion_visible = true;
        } else if !strip_ansi(text).trim().is_empty() {
            self.auto_suggestion_visible = false;
        }
    }

    fn update_editor_buffer(&mut self, text: &str) {
        Self::append_buf(&mut self.editor_mode_buffer, text, 2000, 1500);
    }

    fn reset_auto_enter_on_output(&mut self, text: &str) {
        let clean_text = strip_ansi(text);
        let is_echo = clean_text.lines().all(|line| {
            let trimmed = line.trim();
            trimmed.is_empty() || trimmed.starts_with("Relay message from ")
        });
        if !is_echo && clean_text.len() > 10 && self.auto_enter_retry_count > 0 {
            self.auto_enter_retry_count = 0;
        }
    }
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
            Some(agent_name.as_str()),
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
}

#[derive(Debug, Clone)]
struct PendingDelivery {
    worker_name: String,
    delivery: RelayDelivery,
    attempts: u32,
    next_retry_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingWrapInjection {
    from: String,
    event_id: String,
    body: String,
    target: String,
    queued_at: Instant,
}

#[derive(Debug, Clone)]
struct PendingWorkerInjection {
    delivery: RelayDelivery,
    request_id: Option<String>,
    queued_at: Instant,
}

#[derive(Debug, Clone, Copy, Default)]
enum TerminalQueryState {
    #[default]
    Idle,
    Esc,
    Csi,
    CsiQmark,
    Csi6,
    CsiQmark6,
}

#[derive(Debug, Default)]
struct TerminalQueryParser {
    state: TerminalQueryState,
}

#[derive(Debug, Clone)]
enum WorkerEvent {
    Message { name: String, value: Value },
}

#[derive(Debug, Deserialize)]
struct SpawnPayload {
    agent: AgentSpec,
}

#[derive(Debug, Deserialize)]
struct ReleasePayload {
    name: String,
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
struct DeliveryAckPayload {
    delivery_id: String,
    event_id: String,
}

struct WorkerRegistry {
    workers: HashMap<String, WorkerHandle>,
    event_tx: mpsc::Sender<WorkerEvent>,
    worker_env: Vec<(String, String)>,
}

impl WorkerRegistry {
    fn new(event_tx: mpsc::Sender<WorkerEvent>, worker_env: Vec<(String, String)>) -> Self {
        Self {
            workers: HashMap::new(),
            event_tx,
            worker_env,
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

    fn has_worker(&self, name: &str) -> bool {
        self.workers.contains_key(name)
    }

    async fn spawn(&mut self, spec: AgentSpec, parent: Option<String>) -> Result<()> {
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
                command.arg(cli);
                if !spec.args.is_empty() {
                    command.arg("--");
                    for arg in &spec.args {
                        command.arg(arg);
                    }
                }
            }
            AgentRuntime::HeadlessClaude => {
                command.arg("headless");
                command.arg("--agent-name").arg(&spec.name);
                command.arg("claude");
                if !spec.args.is_empty() {
                    command.arg("--");
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
        Commands::Pty(cmd) => run_pty_worker(cmd).await,
        Commands::Headless(cmd) => run_headless_worker(cmd).await,
        Commands::Listen(cmd) => run_listen(cmd, telemetry).await,
        Commands::Wrap { cli, args } => run_wrap(cli, args, telemetry).await,
    }
}

async fn run_init(cmd: InitCommand, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let mut agent_spawn_count: u32 = 0;
    telemetry.track(TelemetryEvent::BrokerStart);

    let runtime_cwd = std::env::current_dir()?;
    let paths = ensure_runtime_paths(&runtime_cwd)?;
    let mut state = BrokerState::load(&paths.state).unwrap_or_default();
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
    let mut workers = WorkerRegistry::new(worker_event_tx, worker_env);

    let mut sdk_lines = BufReader::new(tokio::io::stdin()).lines();
    let mut reap_tick = tokio::time::interval(Duration::from_millis(500));
    reap_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut dedup = DedupCache::new(Duration::from_secs(300), 8192);
    let delivery_retry_interval = delivery_retry_interval();
    let mut pending_deliveries: HashMap<String, PendingDelivery> = HashMap::new();

    let mut shutdown = false;

    while !shutdown {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
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
                                            "delivery": payload,
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
                                    let _ = send_event(&sdk_out_tx, json!({
                                        "kind": "worker_ready",
                                        "name": name,
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

                let exited = workers.reap_exited().await?;
                for (name, code, signal) in exited {
                    let dropped = drop_pending_for_worker(&mut pending_deliveries, &name);
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
                    telemetry.track(TelemetryEvent::AgentCrash {
                        cli: String::new(),
                        exit_code: code,
                        lifetime_seconds: 0,
                    });
                    let _ = send_event(
                        &sdk_out_tx,
                        json!({"kind":"agent_exited","name":name,"code":code,"signal":signal}),
                    ).await;
                    state.agents.remove(&name);
                    if let Err(error) = state.save(&paths.state) {
                        tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state");
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

    if let Err(error) = ws_control_tx.send(WsControl::Shutdown).await {
        tracing::warn!(error = %error, "failed to send ws shutdown signal");
    }
    pending_deliveries.clear();
    workers.shutdown_all().await?;

    Ok(())
}

/// Listen mode: connect to Relaycast WS and log events without wrapping a CLI.
/// Handles spawn/release commands from both WS events and an HTTP API.
/// The HTTP API (default port 3889) accepts spawn/release/list requests.
/// Usage: `agent-relay listen --agent-name hub --channels general,ops --port 3889`
async fn run_listen(cmd: ListenCommand, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let mut agent_spawn_count: u32 = 0;
    telemetry.track(TelemetryEvent::BrokerStart);
    let requested_name = cmd
        .agent_name
        .or_else(|| std::env::var("RELAY_AGENT_NAME").ok())
        .unwrap_or_else(|| "listener".to_string());
    let channels = cmd
        .channels
        .or_else(|| std::env::var("RELAY_CHANNELS").ok())
        .unwrap_or_else(|| "general".to_string());
    let channel_list = channels_from_csv(&channels);
    let api_port = cmd.port;

    eprintln!(
        "[agent-relay] listen mode (agent: {}, channels: {:?}, api port: {})",
        requested_name, channel_list, api_port
    );

    // --- Auth & Relaycast connection ---
    let runtime_cwd = std::env::current_dir()?;
    let paths = ensure_runtime_paths(&runtime_cwd)?;

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
    while running {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
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
                                    format!("{}…", &mapped.text[..120])
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
        "uptime": 0,
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

/// Interactive wrap mode: wraps a CLI in a PTY with terminal passthrough
/// while connecting to Relaycast for relay message injection.
/// Usage: `agent-relay codex --full-auto`
async fn run_wrap(cli_name: String, cli_args: Vec<String>, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let mut agent_spawn_count: u32 = 0;
    telemetry.track(TelemetryEvent::BrokerStart);
    // Disable Claude Code auto-suggestions so relay message injection into the PTY
    // cannot accidentally accept a ghost suggestion via the Enter keystroke.
    #[allow(deprecated)]
    std::env::set_var("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false");

    let requested_name = std::env::var("RELAY_AGENT_NAME").unwrap_or_else(|_| cli_name.clone());
    let channels = std::env::var("RELAY_CHANNELS").unwrap_or_else(|_| "general".to_string());
    let channel_list = channels_from_csv(&channels);

    eprintln!(
        "[agent-relay] wrapping {} (agent: {}, channels: {:?})",
        cli_name, requested_name, channel_list
    );
    eprintln!("[agent-relay] use RUST_LOG=debug for verbose logging");

    // --- Auth & Relaycast connection ---
    let runtime_cwd = std::env::current_dir()?;
    let paths = ensure_runtime_paths(&runtime_cwd)?;

    let strict_name = env_flag_enabled("RELAY_STRICT_AGENT_NAME");
    let relay = connect_relay(RelaySessionOptions {
        paths: &paths,
        requested_name: &requested_name,
        channels: channel_list,
        strict_name,
        read_mcp_identity: true,
        ensure_mcp_config: true,
        runtime_cwd: &runtime_cwd,
    })
    .await?;

    tracing::debug!("connected to relaycast");

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
    let child_api_key = relay_workspace_key.clone();
    let child_base_url = http_base.clone();

    // Spawner for child agents
    let mut spawner = Spawner::new();

    // --- Spawn CLI in PTY ---
    let (pty, mut pty_rx) = PtySession::spawn(
        &cli_name,
        &cli_args,
        terminal_rows().unwrap_or(24),
        terminal_cols().unwrap_or(80),
    )?;
    let mut terminal_query_parser = TerminalQueryParser::default();

    eprintln!("[agent-relay] ready");

    // Set terminal to raw mode for passthrough
    #[cfg(unix)]
    let saved_termios = {
        use nix::sys::termios;
        match termios::tcgetattr(std::io::stdin()) {
            Ok(orig) => {
                let mut raw = orig.clone();
                termios::cfmakeraw(&mut raw);
                let _ = termios::tcsetattr(std::io::stdin(), termios::SetArg::TCSANOW, &raw);
                Some(orig)
            }
            Err(_) => None,
        }
    };

    // Stdin reader thread
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if stdin_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Dedup for WS events
    let mut dedup = DedupCache::new(Duration::from_secs(300), 8192);

    // Buffer for extracting message IDs from MCP tool responses in PTY output.
    // When the agent sends messages via MCP, the response contains the message ID.
    // Pre-seeding dedup with these IDs prevents self-echo when the same message
    // arrives via WS — regardless of what identity the MCP server uses.
    let mut mcp_response_buffer = String::new();

    let mut pty_auto = PtyAutoState::new();
    let mut auto_enter_interval = tokio::time::interval(Duration::from_secs(2));
    auto_enter_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_injection_interval = tokio::time::interval(Duration::from_millis(50));
    pending_injection_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_wrap_injections: VecDeque<PendingWrapInjection> = VecDeque::new();

    let mut reap_tick = tokio::time::interval(Duration::from_secs(5));
    reap_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // SIGWINCH (terminal resize)
    let mut sigwinch =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
            .expect("failed to register SIGWINCH handler");

    let mut running = true;
    let mut stdout = tokio::io::stdout();

    while running {
        tokio::select! {
            // Ctrl-C
            _ = tokio::signal::ctrl_c() => {
                running = false;
            }

            // Stdin → PTY (passthrough)
            Some(data) = stdin_rx.recv() => {
                let _ = pty.write_all(&data);
            }

            // PTY output → stdout (passthrough) + auto-responses
            chunk = pty_rx.recv() => {
                match chunk {
                    Some(chunk) => {
                        // Terminal query responses (CSI 6n)
                        for response in terminal_query_parser.feed(&chunk) {
                            let _ = pty.write_all(response);
                        }

                        // Passthrough to user's terminal
                        use tokio::io::AsyncWriteExt;
                        let _ = stdout.write_all(&chunk).await;
                        let _ = stdout.flush().await;

                        let text = String::from_utf8_lossy(&chunk).to_string();
                        pty_auto.last_output_time = Instant::now();

                        pty_auto.update_auto_suggestion(&text);
                        pty_auto.update_editor_buffer(&text);
                        pty_auto.reset_auto_enter_on_output(&text);

                        // Extract message IDs from MCP tool responses to prevent self-echo.
                        {
                            let clean_text = strip_ansi(&text);
                            mcp_response_buffer.push_str(&clean_text);
                            if mcp_response_buffer.len() > 4000 {
                                let start = floor_char_boundary(&mcp_response_buffer, mcp_response_buffer.len() - 3000);
                                mcp_response_buffer = mcp_response_buffer[start..].to_string();
                            }
                            for msg_id in extract_mcp_message_ids(&mcp_response_buffer) {
                                if dedup.insert_if_new(&msg_id, Instant::now()) {
                                    tracing::debug!("pre-seeded dedup with outbound message id: {}", msg_id);
                                }
                            }
                        }

                        pty_auto.handle_mcp_approval(&text, &pty).await;
                        pty_auto.handle_bypass_permissions(&text, &pty).await;
                        pty_auto.handle_codex_model_prompt(&text, &pty).await;
                        pty_auto.handle_gemini_action(&text, &pty).await;
                    }
                    None => {
                        running = false;
                    }
                }
            }

            // Relay messages from WS → intercept broker commands or queue for PTY injection
            ws_msg = ws_inbound_rx.recv() => {
                if let Some(ws_msg) = ws_msg {
                    // Check for command.invoked event first (spawn/release)
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
                                        eprintln!("\r\n[agent-relay] spawned child '{}' (pid {})\r", params.name, pid);
                                    }
                                    Err(error) => {
                                        tracing::error!(child = %params.name, error = %error, "failed to spawn child agent");
                                        eprintln!("\r\n[agent-relay] failed to spawn '{}': {}\r", params.name, error);
                                    }
                                }
                            }
                            BrokerCommandPayload::Release(ref params) => {
                                // command.invoked doesn't carry sender_kind, so use Unknown
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
                                            eprintln!("\r\n[agent-relay] released child '{}'\r", params.name);
                                        }
                                        Err(error) => {
                                            tracing::error!(child = %params.name, error = %error, "failed to release child agent");
                                            eprintln!("\r\n[agent-relay] failed to release '{}': {}\r", params.name, error);
                                        }
                                    }
                                } else {
                                    tracing::warn!(child = %params.name, sender = %cmd_event.invoked_by, "release denied: sender is not owner or human");
                                }
                            }
                        }
                        continue;
                    }

                    // Regular relay message: map and queue for PTY injection
                    if let Some(mapped) = map_ws_event(&ws_msg) {
                        if !dedup.insert_if_new(&mapped.event_id, Instant::now()) {
                            tracing::debug!("dedup: skipping {}", mapped.event_id);
                            continue;
                        }
                        if self_names.contains(&mapped.from)
                            || mapped.sender_agent_id.as_ref().is_some_and(|id| self_agent_ids.contains(id))
                        {
                            tracing::debug!(from = %mapped.from, sender_agent_id = ?mapped.sender_agent_id, "skipping self-echo in wrap mode");
                            continue;
                        }

                        pending_wrap_injections.push_back(PendingWrapInjection {
                            from: mapped.from,
                            event_id: mapped.event_id,
                            body: mapped.text,
                            target: mapped.target,
                            queued_at: Instant::now(),
                        });
                    } else {
                        tracing::debug!("ws event not mapped: {}", serde_json::to_string(&ws_msg).unwrap_or_default());
                    }
                }
            }

            _ = pending_injection_interval.tick() => {
                let should_block = pending_wrap_injections
                    .front()
                    .map(|pending| {
                        pty_auto.auto_suggestion_visible && pending.queued_at.elapsed() < AUTO_SUGGESTION_BLOCK_TIMEOUT
                    })
                    .unwrap_or(false);
                if should_block {
                    continue;
                }
                if let Some(pending) = pending_wrap_injections.pop_front() {
                    if pty_auto.auto_suggestion_visible {
                        tracing::warn!(
                            event_id = %pending.event_id,
                            "auto-suggestion visible; sending Escape to dismiss before injection"
                        );
                        let _ = pty.write_all(b"\x1b");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        pty_auto.auto_suggestion_visible = false;
                    }
                    tracing::debug!("relay from {} → {}", pending.from, pending.target);
                    let injection = format_injection(
                        &pending.from,
                        &pending.event_id,
                        &pending.body,
                        &pending.target,
                    );
                    if let Err(e) = pty.write_all(injection.as_bytes()) {
                        tracing::warn!(event_id = %pending.event_id, error = %e, "PTY injection write failed, re-queuing");
                        pending_wrap_injections.push_front(PendingWrapInjection {
                            from: pending.from,
                            event_id: pending.event_id,
                            body: pending.body,
                            target: pending.target,
                            queued_at: pending.queued_at,
                        });
                        continue;
                    }
                    telemetry.track(TelemetryEvent::MessageSend {
                        is_broadcast: pending.target.starts_with('#'),
                        has_thread: false,
                    });
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let _ = pty.write_all(b"\r");
                    pty_auto.last_injection_time = Some(Instant::now());
                    pty_auto.auto_enter_retry_count = 0;
                }
            }

            // Auto-enter for stuck agents
            _ = auto_enter_interval.tick() => {
                pty_auto.try_auto_enter(&pty);
            }

            // Reap child agents that have exited on their own
            _ = reap_tick.tick() => {
                if let Ok(exited) = spawner.reap_exited().await {
                    for name in exited {
                        telemetry.track(TelemetryEvent::AgentCrash {
                            cli: String::new(),
                            exit_code: None,
                            lifetime_seconds: 0,
                        });
                        tracing::info!(child = %name, "child agent exited");
                        eprintln!("\r\n[agent-relay] child '{}' exited\r", name);
                    }
                }
            }

            // SIGWINCH: forward terminal resize to PTY
            _ = sigwinch.recv() => {
                if let Some((rows, cols)) = get_terminal_size() {
                    let _ = pty.resize(rows, cols);
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
    let _ = pty.shutdown();

    // Terminate all child agents
    spawner.shutdown_all(Duration::from_secs(2)).await;

    if let Err(e) = ws_control_tx.send(WsControl::Shutdown).await {
        tracing::warn!(error = %e, "failed to send WS shutdown in wrap cleanup");
    }

    // Restore terminal
    #[cfg(unix)]
    if let Some(orig) = saved_termios {
        use nix::sys::termios;
        let _ = termios::tcsetattr(std::io::stdin(), termios::SetArg::TCSANOW, &orig);
    }

    eprintln!("\r\n[agent-relay] session ended");
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

            workers.spawn(payload.agent.clone(), None).await?;
            state.agents.insert(
                name.clone(),
                PersistedAgent {
                    runtime: runtime.clone(),
                    parent: None,
                    channels: payload.agent.channels.clone(),
                },
            );
            state.save(state_path)?;

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
            let text_len = payload.text.len();
            let has_thread_id = payload.thread_id.is_some();
            let priority = payload.priority;
            send_error(
                out_tx,
                frame.request_id,
                "unsupported_operation",
                format!(
                    "send_message is not supported for broker-local injection (to='{}', from='{}', text_len={}, thread_id={}, priority={:?}); use Relaycast MCP/SDK to publish messages",
                    payload.to,
                    payload
                        .from
                        .unwrap_or_else(|| "human:orchestrator".to_string()),
                    text_len,
                    has_thread_id,
                    priority,
                ),
                false,
                None,
            )
            .await?;
            Ok(false)
        }
        "release_agent" => {
            let payload: ReleasePayload = serde_json::from_value(frame.payload)
                .context("release_agent payload must contain `name`")?;

            workers.release(&payload.name).await?;
            let dropped = drop_pending_for_worker(pending_deliveries, &payload.name);
            state.agents.remove(&payload.name);
            state.save(state_path)?;

            telemetry.track(TelemetryEvent::AgentRelease {
                cli: String::new(),
                release_reason: "sdk_request".to_string(),
                lifetime_seconds: 0,
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

async fn run_pty_worker(cmd: PtyCommand) -> Result<()> {
    // Disable Claude Code auto-suggestions to prevent accidental acceptance during injection.
    #[allow(deprecated)]
    std::env::set_var("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "false");

    #[cfg(unix)]
    let (init_rows, init_cols) = get_terminal_size().unwrap_or((24, 80));
    #[cfg(not(unix))]
    let (init_rows, init_cols) = (24u16, 80u16);
    let (pty, mut pty_rx) = PtySession::spawn(&cmd.cli, &cmd.args, init_rows, init_cols)?;
    let mut terminal_query_parser = TerminalQueryParser::default();

    let (out_tx, mut out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(1024);
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
    let mut running = true;

    let mut pty_auto = PtyAutoState::new();

    // --- SIGWINCH (terminal resize) ---
    let mut sigwinch =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())
            .expect("failed to register SIGWINCH handler");

    let mut auto_enter_interval = tokio::time::interval(Duration::from_secs(2));
    auto_enter_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_injection_interval = tokio::time::interval(Duration::from_millis(50));
    pending_injection_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut pending_worker_injections: VecDeque<PendingWorkerInjection> = VecDeque::new();
    let mut pending_worker_delivery_ids: HashSet<String> = HashSet::new();

    while running {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let frame: ProtocolEnvelope<Value> = match serde_json::from_str(&line) {
                            Ok(frame) => frame,
                            Err(error) => {
                                let _ = send_frame(&out_tx, "worker_error", None, json!({
                                    "code":"invalid_frame",
                                    "message": error.to_string(),
                                    "retryable": false
                                })).await;
                                continue;
                            }
                        };

                        match frame.msg_type.as_str() {
                            "init_worker" => {
                                let inferred_name = cmd
                                    .agent_name
                                    .clone()
                                    .or_else(|| {
                                        frame.payload
                                            .get("agent")
                                            .and_then(|a| a.get("name"))
                                            .and_then(Value::as_str)
                                            .map(ToOwned::to_owned)
                                    })
                                    .unwrap_or_else(|| "pty-worker".to_string());

                                let _ = send_frame(
                                    &out_tx,
                                    "worker_ready",
                                    frame.request_id,
                                    json!({"name": inferred_name, "runtime": "pty"}),
                                )
                                .await;
                            }
                            "deliver_relay" => {
                                let delivery: RelayDelivery = match serde_json::from_value(frame.payload) {
                                    Ok(d) => d,
                                    Err(error) => {
                                        let _ = send_frame(&out_tx, "worker_error", frame.request_id, json!({
                                            "code":"invalid_delivery",
                                            "message": error.to_string(),
                                            "retryable": false
                                        })).await;
                                        continue;
                                    }
                                };
                                if pending_worker_delivery_ids.insert(delivery.delivery_id.clone()) {
                                    pending_worker_injections.push_back(PendingWorkerInjection {
                                        delivery,
                                        request_id: frame.request_id,
                                        queued_at: Instant::now(),
                                    });
                                } else {
                                    tracing::debug!(
                                        delivery_id = %delivery.delivery_id,
                                        "skipping duplicate pending delivery"
                                    );
                                }
                            }
                            "shutdown_worker" => {
                                running = false;
                            }
                            "ping" => {
                                let ts = frame.payload.get("ts_ms").and_then(Value::as_u64).unwrap_or_default();
                                let _ = send_frame(&out_tx, "pong", frame.request_id, json!({"ts_ms": ts})).await;
                            }
                            other => {
                                let _ = send_frame(&out_tx, "worker_error", frame.request_id, json!({
                                    "code":"unknown_type",
                                    "message": format!("unsupported message type '{}'", other),
                                    "retryable": false
                                })).await;
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }

            pty_output = pty_rx.recv() => {
                match pty_output {
                    Some(chunk) => {
                        for response in terminal_query_parser.feed(&chunk) {
                            let _ = pty.write_all(response);
                        }
                        let text = String::from_utf8_lossy(&chunk).to_string();
                        let _ = send_frame(&out_tx, "worker_stream", None, json!({
                            "stream": "stdout",
                            "chunk": text,
                        })).await;

                        pty_auto.update_auto_suggestion(&text);
                        pty_auto.last_output_time = Instant::now();
                        pty_auto.update_editor_buffer(&text);
                        pty_auto.reset_auto_enter_on_output(&text);
                        pty_auto.handle_mcp_approval(&text, &pty).await;
                        pty_auto.handle_bypass_permissions(&text, &pty).await;
                        pty_auto.handle_codex_model_prompt(&text, &pty).await;
                        pty_auto.handle_gemini_action(&text, &pty).await;
                    }
                    None => {
                        running = false;
                    }
                }
            }

            _ = pending_injection_interval.tick() => {
                let should_block = pending_worker_injections
                    .front()
                    .map(|pending| {
                        pty_auto.auto_suggestion_visible && pending.queued_at.elapsed() < AUTO_SUGGESTION_BLOCK_TIMEOUT
                    })
                    .unwrap_or(false);
                if should_block {
                    continue;
                }
                if let Some(pending) = pending_worker_injections.pop_front() {
                    if pty_auto.auto_suggestion_visible {
                        tracing::warn!(
                            delivery_id = %pending.delivery.delivery_id,
                            "auto-suggestion visible; sending Escape to dismiss before injection"
                        );
                        let _ = pty.write_all(b"\x1b");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        pty_auto.auto_suggestion_visible = false;
                    }

                    let injection = format_injection(
                        &pending.delivery.from,
                        &pending.delivery.event_id,
                        &pending.delivery.body,
                        &pending.delivery.target,
                    );
                    if let Err(e) = pty.write_all(injection.as_bytes()) {
                        tracing::warn!(
                            delivery_id = %pending.delivery.delivery_id,
                            error = %e,
                            "PTY injection write failed, re-queuing delivery"
                        );
                        pending_worker_injections.push_front(pending);
                        continue;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let _ = pty.write_all(b"\r");
                    pty_auto.last_injection_time = Some(Instant::now());
                    pty_auto.auto_enter_retry_count = 0;

                    let _ = send_frame(
                        &out_tx,
                        "delivery_ack",
                        pending.request_id,
                        json!({
                            "delivery_id": pending.delivery.delivery_id,
                            "event_id": pending.delivery.event_id
                        }),
                    )
                    .await;
                    pending_worker_delivery_ids.remove(&pending.delivery.delivery_id);
                }
            }

            // --- Auto-enter for stuck agents ---
            _ = auto_enter_interval.tick() => {
                pty_auto.try_auto_enter(&pty);
            }

            // --- SIGWINCH: forward terminal resize to PTY ---
            _ = sigwinch.recv() => {
                if let Some((rows, cols)) = get_terminal_size() {
                    let _ = pty.resize(rows, cols);
                }
            }
        }
    }

    let _ = pty.shutdown();
    let _ = send_frame(
        &out_tx,
        "worker_exited",
        None,
        json!({"code": Value::Null, "signal": Value::Null}),
    )
    .await;

    Ok(())
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

fn channels_from_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect()
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

impl TerminalQueryParser {
    fn feed(&mut self, chunk: &[u8]) -> Vec<&'static [u8]> {
        const ESC: u8 = 0x1b;
        const CSI: u8 = b'[';
        const QMARK: u8 = b'?';
        const SIX: u8 = b'6';
        const N: u8 = b'n';

        let mut out = Vec::new();
        for byte in chunk {
            self.state = match (self.state, *byte) {
                (_, ESC) => TerminalQueryState::Esc,
                (TerminalQueryState::Esc, CSI) => TerminalQueryState::Csi,
                (TerminalQueryState::Csi, QMARK) => TerminalQueryState::CsiQmark,
                (TerminalQueryState::Csi, SIX) => TerminalQueryState::Csi6,
                (TerminalQueryState::CsiQmark, SIX) => TerminalQueryState::CsiQmark6,
                (TerminalQueryState::Csi6, N) => {
                    out.push(b"\x1b[1;1R".as_slice());
                    TerminalQueryState::Idle
                }
                (TerminalQueryState::CsiQmark6, N) => {
                    out.push(b"\x1b[?1;1R".as_slice());
                    TerminalQueryState::Idle
                }
                _ => TerminalQueryState::Idle,
            };
        }
        out
    }
}

#[cfg(test)]
fn terminal_query_responses(chunk: &[u8]) -> Vec<&'static [u8]> {
    let mut parser = TerminalQueryParser::default();
    parser.feed(chunk)
}

fn format_injection(from: &str, event_id: &str, body: &str, target: &str) -> String {
    // If body is already formatted (from orchestrator), don't double-wrap
    if body.starts_with("Relay message from ") {
        return body.to_string();
    }
    if target.starts_with('#') {
        format!(
            "Relay message from {} in {} [{}]: {}",
            from, target, event_id, body
        )
    } else {
        format!("Relay message from {} [{}]: {}", from, event_id, body)
    }
}

/// Find the nearest character boundary at or before the given byte index.
fn floor_char_boundary(s: &str, index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Strip ANSI escape sequences from text for robust pattern matching.
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(&nc) = chars.peek() {
                        chars.next();
                        if nc.is_ascii_alphabetic() || nc == '@' || nc == '`' {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(nc) = chars.next() {
                        if nc == '\x07' {
                            break;
                        }
                        if nc == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(' | ')' | '*' | '+') => {
                    chars.next();
                    chars.next();
                }
                Some(c) if *c >= '0' && *c <= '~' => {
                    chars.next();
                }
                _ => {}
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Detect Claude Code --dangerously-skip-permissions confirmation prompt.
/// Returns (has_bypass_ref, has_confirmation).
fn detect_bypass_permissions_prompt(clean_output: &str) -> (bool, bool) {
    let lower = clean_output.to_lowercase();
    let has_bypass_ref =
        (lower.contains("bypass") && lower.contains("permission")) || lower.contains("dangerously");
    let has_confirmation = lower.contains("(yes/no)")
        || lower.contains("(y/n)")
        || (lower.contains("proceed") && lower.contains("yes"))
        || (lower.contains("accept") && lower.contains("risk"))
        || (lower.contains("accept") && lower.contains("no,") && lower.contains("exit"));
    (has_bypass_ref, has_confirmation)
}

/// Check if the bypass permissions prompt is in selection menu format.
fn is_bypass_selection_menu(clean_output: &str) -> bool {
    let lower = clean_output.to_lowercase();
    let has_accept = lower.contains("accept");
    let has_exit_option = lower.contains("exit");
    let has_enter_confirm = lower.contains("enter") && lower.contains("confirm");
    has_accept && has_exit_option && has_enter_confirm
}

/// Detect if the agent is in an editor mode (vim INSERT, nano, etc.).
/// When in editor mode, auto-Enter should be suppressed.
fn is_in_editor_mode(recent_output: &str) -> bool {
    let clean = strip_ansi(recent_output);
    let last_output = if clean.len() > 500 {
        let start = floor_char_boundary(&clean, clean.len() - 500);
        &clean[start..]
    } else {
        &clean
    };

    // Claude CLI status bar with mode indicator - NOT vim
    let claude_ui_chars = ['⏵', '⏴', '►', '▶'];
    let has_claude_ui = last_output.chars().any(|c| claude_ui_chars.contains(&c));
    if has_claude_ui
        && (last_output.contains("-- INSERT --")
            || last_output.contains("-- NORMAL --")
            || last_output.contains("-- VISUAL --"))
    {
        return false;
    }

    // Vim/Neovim mode indicators
    let vim_patterns = [
        "-- INSERT --",
        "-- REPLACE --",
        "-- VISUAL --",
        "-- VISUAL LINE --",
        "-- VISUAL BLOCK --",
        "-- SELECT --",
        "-- TERMINAL --",
    ];
    for pattern in vim_patterns {
        if let Some(pos) = last_output.rfind(pattern) {
            let after_pattern = &last_output[pos + pattern.len()..];
            let trimmed = after_pattern.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('\n') {
                return true;
            }
        }
    }

    // Nano / Emacs / pager indicators
    if last_output.contains("GNU nano") || last_output.contains("^G Get Help") {
        return true;
    }
    if last_output.contains("(END)") || last_output.contains("--More--") {
        return true;
    }

    false
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

/// Detect Codex model upgrade/selection prompt in output.
/// Returns (has_upgrade_ref, has_model_options) where:
/// - has_upgrade_ref: output references a new model or upgrade
/// - has_model_options: output contains "Try new model" and "Use existing model"
///
/// Note: Codex uses cursor-forward sequences instead of spaces in TUI output.
/// After ANSI stripping, words may be concatenated without spaces.
/// Detection uses individual keyword checks rather than exact phrase matching.
fn detect_codex_model_prompt(clean_output: &str) -> (bool, bool) {
    let lower = clean_output.to_lowercase();
    let has_upgrade_ref = (lower.contains("codex") && lower.contains("upgrade"))
        || (lower.contains("codex") && lower.contains("new") && lower.contains("model"))
        || (lower.contains("just") && lower.contains("got") && lower.contains("upgrade"));
    let has_model_options = lower.contains("try") && lower.contains("existing");
    (has_upgrade_ref, has_model_options)
}

/// Detect Gemini "Action Required" permission prompt in output.
/// Returns (has_header, has_allow_option).
/// Gemini shows these even with --yolo for shell redirects, heredocs, etc.
fn detect_gemini_action_required(clean_output: &str) -> (bool, bool) {
    let has_header = clean_output.contains("Action Required");
    let has_allow_option =
        clean_output.contains("Allow once") || clean_output.contains("Allow for this session");
    (has_header, has_allow_option)
}

/// Detect Claude Code auto-suggestion ghost text.
///
/// Auto-suggestions are rendered with reverse-video cursor + dim ghost text,
/// and often include the "↵ send" hint.
fn is_auto_suggestion(output: &str) -> bool {
    let has_cursor_ghost = output.contains("\x1b[7m") && output.contains("\x1b[27m\x1b[2m");
    let has_send_hint = output.contains("↵ send");
    has_cursor_ghost || has_send_hint
}

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

fn ensure_runtime_paths(cwd: &Path) -> Result<RuntimePaths> {
    let root = cwd.join(".agent-relay");
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create runtime dir {}", root.display()))?;

    Ok(RuntimePaths {
        creds: root.join("relaycast.json"),
        state: root.join("state.json"),
    })
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
        std::fs::write(path, body)
            .with_context(|| format!("failed writing state file {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, time::Instant};

    use relay_broker::protocol::RelayDelivery;

    use super::{
        channels_from_csv, delivery_retry_interval, derive_ws_base_url_from_http,
        detect_bypass_permissions_prompt, drop_pending_for_worker, extract_mcp_message_ids,
        floor_char_boundary, format_injection, is_auto_suggestion, is_bypass_selection_menu,
        is_in_editor_mode, normalize_channel, strip_ansi, terminal_query_responses,
        PendingDelivery, TerminalQueryParser,
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
        let input = "\x1b[1CYes,\x1b[1CI\x1b[1Caccept";
        let clean = strip_ansi(input);
        assert_eq!(clean, "Yes,Iaccept");
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
}
