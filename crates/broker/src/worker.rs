use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use crate::{
    ids::{RequestId, WorkerName},
    metrics::MetricsCollector,
    protocol::{
        AgentRuntime, AgentSpec, AppServerAuthType, AppServerHostOwnership, HarnessReleasePolicy,
        HeadlessHarnessConfig, HeadlessHarnessDriver, ProtocolEnvelope, RelayDelivery,
        ResolvedHarnessConfig, PROTOCOL_VERSION,
    },
    relaycast::configure_agent_relay_mcp_with_result,
    supervisor::Supervisor,
    types::AgentResultMcpConfig,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot},
    time::timeout,
};
use uuid::Uuid;

use crate::{
    cli::command_parse::{normalize_cli_name, parse_cli_command},
    runtime::headless_provider_cli_name,
    spawner::terminate_child,
};

const APP_SERVER_AUTH_ENV_KEYS: [&str; 4] = [
    "AGENT_RELAY_APP_SERVER_AUTH_TYPE",
    "AGENT_RELAY_APP_SERVER_AUTH_TOKEN",
    "AGENT_RELAY_APP_SERVER_AUTH_USERNAME",
    "AGENT_RELAY_APP_SERVER_AUTH_PASSWORD",
];
const DEFAULT_RELEASE_GRACE: Duration = Duration::from_secs(2);
const APP_SERVER_RELEASE_GRACE: Duration = Duration::from_secs(35);

/// How long a worker may go without reporting `worker_ready` before the broker
/// treats its harness as failed-to-start.
///
/// The worker process emits `worker_ready` itself, but only after its harness
/// has exposed a proven input prompt. PTY wrappers report the child pid earlier,
/// so this deadline only applies when the broker has neither readiness nor
/// separate proof of harness liveness.
const WORKER_READY_DEADLINE: Duration = Duration::from_secs(90);

/// Briefly hold the spawn acknowledgement so a wrapper that cannot launch its
/// harness has time to exit. `Command::spawn` only proves that the wrapper was
/// created; without this stability window the HTTP API can report success even
/// though the wrapper is already gone by the time the caller lists agents.
const WORKER_SPAWN_STABILITY_WINDOW: Duration = Duration::from_millis(250);

/// How long to wait for a SIGKILLed orphan wrapper to be reaped before giving
/// up. Bounded so a wrapper stuck in uninterruptible sleep cannot stall the
/// maintenance tick, which also drives delivery retries.
const ORPHAN_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const WORKER_WRITE_QUEUE_CAPACITY: usize = 128;
const WORKER_SHUTDOWN_WRITE_TIMEOUT: Duration = Duration::from_millis(250);

/// A complete newline-delimited worker protocol frame. A dedicated task owns
/// each worker's stdin and writes these frames in order, so cancelling a
/// caller can never cancel an in-progress pipe write and leave a partial JSON
/// frame for the next command to corrupt.
pub(crate) struct WorkerWriteCommand {
    frame: Vec<u8>,
    completion: Option<oneshot::Sender<std::result::Result<(), String>>>,
}

/// Why a worker was reaped despite its wrapper process still being alive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OrphanedWorker {
    /// The harness pid the worker reported is gone.
    HarnessExited,
    /// `worker_ready` never arrived within [`WORKER_READY_DEADLINE`].
    NeverReady,
}

impl OrphanedWorker {
    fn reason(self) -> &'static str {
        match self {
            OrphanedWorker::HarnessExited => "harness_exited",
            OrphanedWorker::NeverReady => "harness_never_ready",
        }
    }
}

/// True when `pid` no longer names a live process.
///
/// Safety: `kill(pid, 0)` is a POSIX-safe probe — it performs the permission
/// and existence checks without delivering a signal. `ESRCH` means the process
/// is gone; every other error (notably `EPERM`) means it exists.
#[cfg(unix)]
fn pid_is_gone(pid: u32) -> bool {
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    ret == -1 && std::io::Error::last_os_error().raw_os_error().unwrap_or(0) == libc::ESRCH
}

#[cfg(not(unix))]
fn pid_is_gone(_pid: u32) -> bool {
    false
}

/// Decide whether a worker is dead even though its wrapper process is alive.
///
/// The wrapper (`agent-relay-broker pty …`) can outlive the harness it hosts:
/// its stdin reader blocks on a pipe the broker never closes, so a wrapper whose
/// harness exited at startup can sit in `futex_do_wait` indefinitely. Reaping on
/// the wrapper alone therefore leaves the agent listed as `working` forever, with
/// `last_activity` frozen at the moment it died. Judge liveness by the harness.
pub(crate) fn orphaned_worker(
    harness_pid: Option<u32>,
    ready_at: Option<Instant>,
    spawned_at: Instant,
    now: Instant,
) -> Option<OrphanedWorker> {
    if let Some(pid) = harness_pid {
        if pid_is_gone(pid) {
            return Some(OrphanedWorker::HarnessExited);
        }
        // A live harness pid is proof of life; never apply the readiness
        // deadline to one that is plainly running.
        return None;
    }
    if ready_at.is_none() && now.saturating_duration_since(spawned_at) > WORKER_READY_DEADLINE {
        return Some(OrphanedWorker::NeverReady);
    }
    None
}

/// Confirm that a freshly-created worker process survives its initial handoff.
///
/// This is intentionally narrower than `worker_ready`: PTY readiness may take
/// up to 25 seconds and is processed by the same runtime loop that services the
/// spawn request. The short stability probe catches launch failures without
/// deadlocking that loop or making every successful spawn wait for a TUI.
async fn confirm_worker_process_alive(
    name: &str,
    child: &mut Child,
    log_path: Option<&Path>,
    stability_window: Duration,
) -> Result<()> {
    tokio::time::sleep(stability_window).await;
    let Some(status) = child
        .try_wait()
        .with_context(|| format!("failed to verify agent '{name}' process after spawn"))?
    else {
        return Ok(());
    };

    let log_hint = log_path
        .map(|path| format!("; see worker log {}", path.display()))
        .unwrap_or_default();
    anyhow::bail!("agent '{name}' process exited during startup ({status}){log_hint}")
}

// Working/idle activity inference from PTY output comes from the
// harness-agnostic `relay-pty` crate.
pub(crate) use relay_pty::detection;

#[derive(Debug)]
pub(crate) struct WorkerHandle {
    /// Unique identity for this same-name worker process generation.
    pub(crate) generation: Uuid,
    pub(crate) spec: AgentSpec,
    pub(crate) parent: Option<String>,
    pub(crate) workspace_id: Option<crate::ids::WorkspaceId>,
    pub(crate) child: Child,
    pub(crate) command_tx: mpsc::Sender<WorkerWriteCommand>,
    pub(crate) harness_pid: Option<u32>,
    pub(crate) spawned_at: Instant,
    /// When the worker reported `worker_ready`. `None` means the harness has
    /// never come up — see `WORKER_READY_DEADLINE` in `reap_exited`.
    pub(crate) ready_at: Option<Instant>,
    pub(crate) last_activity_at: Instant,
    pub(crate) context_budget_pct: Option<u8>,
    pub(crate) state: AgentWorkState,
    pub(crate) exit_reason: Option<String>,
}

pub(crate) type ExitedWorker = (
    WorkerName,
    Uuid,
    Option<i32>,
    Option<String>,
    Option<String>,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentWorkState {
    Working,
    Idle,
    BlockedOnSend,
}

impl AgentWorkState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AgentWorkState::Working => "working",
            AgentWorkState::Idle => "idle",
            AgentWorkState::BlockedOnSend => "blocked_on_send",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum WorkerEvent {
    Message {
        name: WorkerName,
        generation: Uuid,
        value: Value,
    },
    /// The worker-owned stdin writer failed after a command was accepted.
    /// The runtime must close dependent terminal sessions and terminate this
    /// generation; accepting any more frames would only hide the broken pipe.
    WriterFailed {
        name: WorkerName,
        generation: Uuid,
        error: String,
    },
}

pub(crate) struct WorkerRegistry {
    pub(crate) workers: HashMap<WorkerName, WorkerHandle>,
    event_tx: mpsc::Sender<WorkerEvent>,
    worker_env: Vec<(String, String)>,
    worker_logs_dir: PathBuf,
    pub(crate) initial_tasks: HashMap<WorkerName, String>,
    pub(crate) supervisor: Supervisor,
    pub(crate) metrics: MetricsCollector,
}

fn encode_worker_frame(
    msg_type: &str,
    request_id: Option<RequestId>,
    payload: Value,
) -> Result<Vec<u8>> {
    let frame = ProtocolEnvelope {
        v: PROTOCOL_VERSION,
        msg_type: msg_type.to_string(),
        request_id,
        payload,
    };
    let mut encoded = serde_json::to_vec(&frame)?;
    encoded.push(b'\n');
    Ok(encoded)
}

pub(crate) fn spawn_worker_writer(
    event_tx: mpsc::Sender<WorkerEvent>,
    name: WorkerName,
    generation: Uuid,
    mut stdin: ChildStdin,
    mut command_rx: mpsc::Receiver<WorkerWriteCommand>,
) {
    tokio::spawn(async move {
        while let Some(mut command) = command_rx.recv().await {
            let write_result = async {
                stdin
                    .write_all(&command.frame)
                    .await
                    .context("failed writing frame to worker stdin")?;
                stdin
                    .flush()
                    .await
                    .context("failed flushing worker stdin")?;
                Ok::<(), anyhow::Error>(())
            }
            .await
            .map_err(|error| error.to_string());

            if let Some(completion) = command.completion.take() {
                let _ = completion.send(write_result.clone());
            }

            let Err(error) = write_result else {
                continue;
            };

            // A failed write may have consumed part of the frame. Do not let
            // another command reuse this stream: notify the runtime so it can
            // close the dependent terminal sessions and terminate the worker.
            let _ = event_tx
                .send(WorkerEvent::WriterFailed {
                    name: name.clone(),
                    generation,
                    error: error.clone(),
                })
                .await;

            while let Ok(mut queued) = command_rx.try_recv() {
                if let Some(completion) = queued.completion.take() {
                    let _ = completion.send(Err(format!(
                        "worker command writer stopped after write failure: {error}"
                    )));
                }
            }
            break;
        }
    });
}

impl WorkerRegistry {
    pub(crate) fn new(
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
            supervisor: Supervisor::new(),
            metrics: MetricsCollector::new(broker_start),
        }
    }

    pub(crate) fn worker_log_path(&self, worker_name: &str) -> Option<PathBuf> {
        // Reject path traversal: slashes, backslashes, null bytes, and ".." components
        if worker_name.contains('/')
            || worker_name.contains('\\')
            || worker_name.contains('\0')
            || worker_name == ".."
            || worker_name.starts_with("../")
            || worker_name.ends_with("/..")
            || worker_name.contains("/../")
        {
            tracing::warn!(
                worker = %worker_name,
                "skipping worker log file creation due to invalid worker name"
            );
            return None;
        }
        Some(self.worker_logs_dir.join(format!("{worker_name}.log")))
    }

    /// Snapshot every spawned worker for `GET /api/spawned` and `GET /api/status`.
    ///
    /// `pending_messages` comes from [`crate::runtime::pending_message_counts`];
    /// a worker missing from the map has nothing waiting.
    pub(crate) fn list(&self, pending_messages: &HashMap<WorkerName, usize>) -> Vec<Value> {
        self.workers
            .iter()
            .map(|(name, handle)| {
                let native_harness = native_harness_metadata(&handle.spec);
                json!({
                    "name": name,
                    "runtime": handle.spec.runtime,
                    "provider": handle.spec.provider.clone(),
                    "cli": handle.spec.cli,
                    "model": handle.spec.model,
                    "sessionId": handle.spec.session_id,
                    "team": handle.spec.team,
                    "channels": handle.spec.channels,
                    "parent": handle.parent,
                    "sessionId": handle.spec.session_id,
                    "pid": handle.harness_pid,
                    "workerPid": handle.child.id(),
                    "last_activity_ms": handle.last_activity_at.elapsed().as_millis() as u64,
                    "last_activity_at": chrono::Utc::now()
                        - chrono::Duration::from_std(handle.last_activity_at.elapsed()).unwrap_or_default(),
                    "context_budget_pct": handle.context_budget_pct,
                    "current_state": handle.state.as_str(),
                    "pending_messages": pending_messages.get(name).copied().unwrap_or(0),
                    "runtime_kind": if native_harness.is_some() { "native" } else if handle.spec.runtime == AgentRuntime::Pty { "pty" } else { "headless" },
                    "native_harness_protocol_version": native_harness.as_ref().map(|(version, _)| *version),
                    "native_harness_capabilities": native_harness.and_then(|(_, capabilities)| capabilities),
                })
            })
            .collect()
    }

    pub(crate) fn env_value(&self, key: &str) -> Option<&str> {
        self.worker_env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    #[allow(clippy::too_many_arguments)]
    async fn build_mcp_args(
        &self,
        cli_name: &str,
        agent_name: &str,
        existing_args: &[String],
        cwd: &Path,
        worker_relay_api_key: Option<&str>,
        skip_relay_prompt: bool,
        agent_result: Option<&AgentResultMcpConfig>,
    ) -> Result<Vec<String>> {
        // `skip_relay_prompt` is an explicit opt-out: the caller does not want the
        // Agent Relay MCP server (messaging/channel/etc. tools) injected, e.g. to
        // save tokens. We honor that even when `agent_result` is configured —
        // `AGENT_RELAY_RESULT_*` env vars are still set on the worker process
        // below, so a separately-configured Agent Relay MCP can pick them up.
        if skip_relay_prompt {
            return Ok(Vec::new());
        }
        configure_agent_relay_mcp_with_result(
            cli_name,
            agent_name,
            self.env_value("RELAY_API_KEY"),
            self.env_value("RELAY_BASE_URL"),
            existing_args,
            cwd,
            worker_relay_api_key,
            self.env_value("RELAY_WORKSPACES_JSON"),
            self.env_value("RELAY_DEFAULT_WORKSPACE"),
            agent_result,
        )
        .await
    }

    pub(crate) fn has_worker(&self, name: &str) -> bool {
        self.workers.contains_key(name)
    }

    /// True when a worker is registered AND its child process is still alive.
    /// Registration alone (`has_worker`) can lag a dead child until the periodic
    /// `reap_exited` sweep removes it, so callers that must not act on a
    /// dead-but-present worker (e.g. dead-letter redelivery) probe liveness with
    /// a non-blocking `kill(pid, 0)`, mirroring the reap sweep.
    pub(crate) fn is_worker_live(&self, name: &str) -> bool {
        let Some(handle) = self.workers.get(name) else {
            return false;
        };
        #[cfg(unix)]
        {
            match handle.child.id() {
                Some(pid) => !pid_is_gone(pid),
                // `id()` returns None once the child has been waited/reaped.
                None => false,
            }
        }
        #[cfg(not(unix))]
        {
            let _ = handle;
            true
        }
    }

    /// True when a worker named `name` exists and either has no recorded
    /// workspace or belongs to `workspace_id`. Gates sender impersonation on
    /// Relaycast publish: a worker attached to workspace A must not be
    /// impersonated when publishing into workspace B, which would register or
    /// rotate that name's token in the wrong workspace.
    pub(crate) fn has_worker_in_workspace(
        &self,
        name: &str,
        workspace_id: &crate::ids::WorkspaceId,
    ) -> bool {
        match self.workers.get(name) {
            Some(handle) => match &handle.workspace_id {
                Some(worker_ws) => worker_ws == workspace_id,
                None => true,
            },
            None => false,
        }
    }

    pub(crate) fn worker_pid(&self, name: &str) -> Option<u32> {
        self.workers.get(name).and_then(|h| h.child.id())
    }

    pub(crate) fn harness_pid(&self, name: &str) -> Option<u32> {
        self.workers.get(name).and_then(|h| h.harness_pid)
    }

    /// Clean up a worker whose spawn was rejected after the handle was
    /// already inserted into `self.workers` — whether `init_worker` failed to
    /// send (e.g. the wrapper's stdin closed before the broker could write to
    /// it, EPIPE) or the post-spawn stability check rejected it. Shared so
    /// every rejection path leaves the registry, restart supervisor, and
    /// child process in the same clean state.
    async fn cleanup_rejected_spawn(&mut self, name: &WorkerName) {
        if let Some(handle) = self.workers.get_mut(name) {
            let _ = terminate_child(&mut handle.child, ORPHAN_REAP_TIMEOUT).await;
        }
        self.workers.remove(name);
        self.initial_tasks.remove(name);
        self.supervisor.unregister(name);
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn spawn(
        &mut self,
        spec: AgentSpec,
        parent: Option<String>,
        idle_threshold_secs: Option<u64>,
        worker_relay_api_key: Option<String>,
        skip_relay_prompt: bool,
        workspace_id: Option<crate::ids::WorkspaceId>,
        agent_result: Option<AgentResultMcpConfig>,
    ) -> Result<AgentSpec> {
        let mut spec = spec;
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
        let mut harness_env: Vec<(String, String)> = Vec::new();
        let mut suppress_worker_env: Vec<&'static str> = Vec::new();
        let mut initial_harness_pid: Option<u32> = None;
        let mut direct_native_harness_sidecar = false;

        match spec.harness_config.clone() {
            Some(ResolvedHarnessConfig::Pty(config)) => {
                spec.runtime = AgentRuntime::Pty;
                if spec.session_id.is_none() {
                    spec.session_id = config.session_id.clone();
                }
                if spec.cwd.is_none() {
                    spec.cwd = config.cwd.clone();
                }
                if let Some(env) = config.env {
                    harness_env.extend(env);
                }

                let (resolved_cli, inline_cli_args) = parse_cli_command(&config.command)
                    .with_context(|| format!("invalid harness command '{}'", config.command))?;
                let normalized_cli = normalize_cli_name(&resolved_cli);
                let mut effective_args = inline_cli_args;
                effective_args.extend(config.args.clone());

                command.arg("pty");
                command.arg("--agent-name").arg(&spec.name);
                if let Some(secs) = idle_threshold_secs {
                    command.arg("--idle-threshold-secs").arg(secs.to_string());
                }
                command.arg(&resolved_cli);

                let cli_lower = normalized_cli.to_lowercase();
                let is_claude = cli_lower == "claude" || cli_lower.starts_with("claude:");
                let is_codex = cli_lower == "codex";
                let is_gemini = cli_lower == "gemini";
                let is_grok = cli_lower == "grok";
                if let Some(model) = apply_codex_model_arg_fallback(
                    &resolved_cli,
                    &cli_lower,
                    &spec.name,
                    &mut effective_args,
                )
                .await
                {
                    spec.model = Some(model);
                }
                let mut harness_session_args = Vec::new();
                if let Some(session_id) = spec.session_id.as_deref() {
                    apply_requested_session_reference(
                        &cli_lower,
                        session_id,
                        &mut effective_args,
                        &mut harness_session_args,
                    )?;
                } else {
                    if is_claude {
                        spec.session_id = prepare_claude_session_args(&mut effective_args);
                    } else if is_codex {
                        match codex_session_reference(&effective_args) {
                            CodexSessionReference::Resume(thread_id) => {
                                spec.session_id = Some(thread_id);
                            }
                            CodexSessionReference::Fork(_)
                            | CodexSessionReference::AmbiguousVariadicImage
                            | CodexSessionReference::Unknown => {}
                            CodexSessionReference::None | CodexSessionReference::VariadicImage => {
                                if codex_has_positional_arg(&effective_args) {
                                    tracing::debug!(
                                        worker = %spec.name,
                                        "not pre-creating Codex session because args contain a positional prompt or subcommand"
                                    );
                                } else {
                                    let cwd = Path::new(spec.cwd.as_deref().unwrap_or("."));
                                    match crate::codex_session::create_resumable_codex_thread(
                                        &resolved_cli,
                                        cwd,
                                        &self.worker_env,
                                        &effective_args,
                                        crate::util::version::broker_version(),
                                    )
                                    .await
                                    {
                                        Ok(thread_id) => {
                                            tracing::info!(
                                                worker = %spec.name,
                                                session_id = %thread_id,
                                                "created resumable Codex session for spawned PTY"
                                            );
                                            spec.session_id = Some(thread_id.clone());
                                            harness_session_args.push("resume".to_string());
                                            harness_session_args.push(thread_id);
                                        }
                                        Err(err) => {
                                            tracing::warn!(
                                                worker = %spec.name,
                                                error = %err,
                                                "failed to pre-create resumable Codex session; spawning without sessionId"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // NOTE: Permission-bypass flags are auto-injected for all spawned agents.
                // This means any actor who can trigger agent.add gets agents with no permission
                // guardrails. Future work should make this an explicit opt-in per step/agent.
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
                } else if is_grok && !effective_args.iter().any(|a| a == "--always-approve") {
                    Some("--always-approve")
                } else {
                    None
                };

                if let Some(flag) = bypass_flag {
                    tracing::warn!(
                        worker = %spec.name,
                        flag = %flag,
                        "auto-injecting permission-bypass flag for spawned agent"
                    );
                }

                let mcp_args = self
                    .build_mcp_args(
                        &resolved_cli,
                        &spec.name,
                        &effective_args,
                        Path::new(spec.cwd.as_deref().unwrap_or(".")),
                        worker_relay_api_key.as_deref(),
                        skip_relay_prompt,
                        agent_result.as_ref(),
                    )
                    .await?;

                let model_flag = resolve_model_flag_for_cli(
                    &resolved_cli,
                    &cli_lower,
                    &spec.name,
                    spec.model.as_deref(),
                    &effective_args,
                )
                .await;
                if let Some(ref model) = model_flag {
                    spec.model = Some(model.clone());
                }

                let pty_cli_args = ordered_pty_cli_args(
                    bypass_flag,
                    model_flag.as_deref(),
                    &mcp_args,
                    &effective_args,
                    &harness_session_args,
                );
                if !pty_cli_args.is_empty() {
                    command.arg("--");
                    for arg in &pty_cli_args {
                        command.arg(arg);
                    }
                }
            }
            Some(ResolvedHarnessConfig::Headless(config)) => {
                validate_app_server_config(&config)?;
                spec.runtime = AgentRuntime::Headless;
                spec.session_id = Some(config.session_id.clone());
                initial_harness_pid = config.host.as_ref().and_then(|host| host.pid);
                match &config.driver {
                    HeadlessHarnessDriver::AppServer => {}
                }

                command.arg("app-server");
                command.arg("--agent-name").arg(&spec.name);
                command.arg("--protocol").arg(&config.protocol);
                command.arg("--endpoint").arg(&config.endpoint);
                command.arg("--session-id").arg(&config.session_id);
                if let Some(pid) = initial_harness_pid {
                    command.arg("--host-pid").arg(pid.to_string());
                }
                command
                    .arg("--release")
                    .arg(release_policy_arg(config.release.as_ref()));

                suppress_worker_env.extend(APP_SERVER_AUTH_ENV_KEYS);
                for key in APP_SERVER_AUTH_ENV_KEYS {
                    command.env_remove(key);
                }

                if let Some(auth) = config.auth {
                    harness_env.push((
                        "AGENT_RELAY_APP_SERVER_AUTH_TYPE".to_string(),
                        app_server_auth_type_arg(&auth.auth_type).to_string(),
                    ));
                    if let Some(token) = auth.token {
                        harness_env.push(("AGENT_RELAY_APP_SERVER_AUTH_TOKEN".to_string(), token));
                    }
                    if let Some(username) = auth.username {
                        harness_env
                            .push(("AGENT_RELAY_APP_SERVER_AUTH_USERNAME".to_string(), username));
                    }
                    if let Some(password) = auth.password {
                        harness_env
                            .push(("AGENT_RELAY_APP_SERVER_AUTH_PASSWORD".to_string(), password));
                    }
                }
            }
            Some(ResolvedHarnessConfig::Native(config)) => {
                if config.command.trim().is_empty() {
                    anyhow::bail!("native harness sidecar command is required");
                }
                if config.session_id.trim().is_empty() {
                    anyhow::bail!("native harness sidecar sessionId is required");
                }
                spec.runtime = AgentRuntime::Headless;
                spec.session_id = Some(config.session_id);
                if spec.cwd.is_none() {
                    spec.cwd = config.cwd;
                }
                if let Some(env) = config.env {
                    harness_env.extend(env);
                }
                let (program, inline_args) =
                    parse_cli_command(&config.command).with_context(|| {
                        format!(
                            "invalid native harness sidecar command '{}'",
                            config.command
                        )
                    })?;
                command = Command::new(program);
                command.args(inline_args);
                command.args(config.args);
                direct_native_harness_sidecar = true;
            }
            None => match spec.runtime {
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

                    let cli_lower = normalized_cli.to_lowercase();
                    let is_claude = cli_lower == "claude" || cli_lower.starts_with("claude:");
                    let is_codex = cli_lower == "codex";
                    let is_gemini = cli_lower == "gemini";
                    let is_grok = cli_lower == "grok";
                    if let Some(model) = apply_codex_model_arg_fallback(
                        &resolved_cli,
                        &cli_lower,
                        &spec.name,
                        &mut effective_args,
                    )
                    .await
                    {
                        spec.model = Some(model);
                    }
                    let mut harness_session_args = Vec::new();
                    if let Some(session_id) = spec.session_id.as_deref() {
                        apply_requested_session_reference(
                            &cli_lower,
                            session_id,
                            &mut effective_args,
                            &mut harness_session_args,
                        )?;
                    } else {
                        if is_claude {
                            spec.session_id = prepare_claude_session_args(&mut effective_args);
                        } else if is_codex {
                            match codex_session_reference(&effective_args) {
                                CodexSessionReference::Resume(thread_id) => {
                                    spec.session_id = Some(thread_id);
                                }
                                CodexSessionReference::Fork(_)
                                | CodexSessionReference::AmbiguousVariadicImage
                                | CodexSessionReference::Unknown => {}
                                CodexSessionReference::None
                                | CodexSessionReference::VariadicImage => {
                                    if codex_has_positional_arg(&effective_args) {
                                        tracing::debug!(
                                            worker = %spec.name,
                                            "not pre-creating Codex session because args contain a positional prompt or subcommand"
                                        );
                                    } else {
                                        let cwd = Path::new(spec.cwd.as_deref().unwrap_or("."));
                                        match crate::codex_session::create_resumable_codex_thread(
                                            &resolved_cli,
                                            cwd,
                                            &self.worker_env,
                                            &effective_args,
                                            crate::util::version::broker_version(),
                                        )
                                        .await
                                        {
                                            Ok(thread_id) => {
                                                tracing::info!(
                                                    worker = %spec.name,
                                                    session_id = %thread_id,
                                                    "created resumable Codex session for spawned PTY"
                                                );
                                                spec.session_id = Some(thread_id.clone());
                                                harness_session_args.push("resume".to_string());
                                                harness_session_args.push(thread_id);
                                            }
                                            Err(err) => {
                                                tracing::warn!(
                                                    worker = %spec.name,
                                                    error = %err,
                                                    "failed to pre-create resumable Codex session; spawning without sessionId"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // NOTE: Permission-bypass flags are auto-injected for all spawned agents.
                    // This means any actor who can trigger agent.add gets agents with no permission
                    // guardrails. Future work should make this an explicit opt-in per step/agent.
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
                    } else if is_gemini
                        && !effective_args.iter().any(|a| a == "--yolo" || a == "-y")
                    {
                        Some("--yolo")
                    } else if is_grok && !effective_args.iter().any(|a| a == "--always-approve") {
                        Some("--always-approve")
                    } else {
                        None
                    };

                    if let Some(flag) = bypass_flag {
                        tracing::warn!(
                            worker = %spec.name,
                            flag = %flag,
                            "auto-injecting permission-bypass flag for spawned agent"
                        );
                    }

                    let mcp_args = self
                        .build_mcp_args(
                            cli,
                            &spec.name,
                            &effective_args,
                            Path::new(spec.cwd.as_deref().unwrap_or(".")),
                            worker_relay_api_key.as_deref(),
                            skip_relay_prompt,
                            agent_result.as_ref(),
                        )
                        .await?;

                    let model_flag = resolve_model_flag_for_cli(
                        &resolved_cli,
                        &cli_lower,
                        &spec.name,
                        spec.model.as_deref(),
                        &effective_args,
                    )
                    .await;
                    if let Some(ref model) = model_flag {
                        spec.model = Some(model.clone());
                    }

                    let pty_cli_args = ordered_pty_cli_args(
                        bypass_flag,
                        model_flag.as_deref(),
                        &mcp_args,
                        &effective_args,
                        &harness_session_args,
                    );
                    if !pty_cli_args.is_empty() {
                        command.arg("--");
                        for arg in &pty_cli_args {
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
                    let provider_cli = headless_provider_cli_name(provider);
                    command.arg(provider_cli);
                    if let Some(model) = apply_codex_model_arg_fallback(
                        provider_cli,
                        provider_cli,
                        &spec.name,
                        &mut spec.args,
                    )
                    .await
                    {
                        spec.model = Some(model);
                    }

                    let mcp_args = self
                        .build_mcp_args(
                            provider_cli,
                            &spec.name,
                            &spec.args,
                            Path::new(spec.cwd.as_deref().unwrap_or(".")),
                            worker_relay_api_key.as_deref(),
                            skip_relay_prompt,
                            agent_result.as_ref(),
                        )
                        .await?;

                    let model_arg = resolve_model_flag_for_cli(
                        provider_cli,
                        provider_cli,
                        &spec.name,
                        spec.model.as_deref(),
                        &spec.args,
                    )
                    .await;
                    if let Some(ref model) = model_arg {
                        spec.model = Some(model.clone());
                    }

                    if model_arg.is_some() || !spec.args.is_empty() || !mcp_args.is_empty() {
                        command.arg("--");
                        if let Some(model) = model_arg {
                            command.arg("--model");
                            command.arg(model);
                        }
                        for arg in &mcp_args {
                            command.arg(arg);
                        }
                        for arg in &spec.args {
                            command.arg(arg);
                        }
                    }
                }
            },
        }

        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.worker_env {
            if suppress_worker_env.contains(&key.as_str()) {
                continue;
            }
            command.env(key, value);
        }
        // Per-worker origin_actor: tag this agent's relaycast telemetry with the
        // CLI it runs and the model it was spawned with
        // (`agent-relay-cli/agent/<harness>[@<model>]`). The agent's JS SDK reads
        // AGENT_RELAY_ORIGIN_ACTOR. Don't override an explicit value set via
        // harness_config env.
        if !harness_env
            .iter()
            .any(|(k, _)| k == "AGENT_RELAY_ORIGIN_ACTOR")
        {
            if let Some(harness) = spec
                .cli
                .as_deref()
                .and_then(crate::telemetry::infer_harness_from_command)
            {
                command.env(
                    "AGENT_RELAY_ORIGIN_ACTOR",
                    crate::telemetry::agent_origin_actor(harness, spec.model.as_deref()),
                );
            }
        }
        for (key, value) in &harness_env {
            command.env(key, value);
        }
        if let Some(config) = &agent_result {
            for (key, value) in config.env_pairs() {
                command.env(key, value);
            }
        }
        if should_inject_relay_participant_env(
            &spec.runtime,
            direct_native_harness_sidecar,
            skip_relay_prompt,
        ) {
            if let Some(relay_key) = worker_relay_api_key {
                command.env("RELAY_AGENT_TOKEN", relay_key);
            }
            command.env("RELAY_AGENT_NAME", &spec.name);
            command.env("RELAY_AGENT_TYPE", "agent");
            command.env("RELAY_STRICT_AGENT_NAME", "1");
        }
        // Remove CLAUDECODE from child env to prevent nested Claude Code instances
        // from interfering with the parent's session management
        command.env_remove("CLAUDECODE");
        if let Some(cwd) = spec.cwd.as_ref() {
            command.current_dir(cwd);
        }

        let mut child = command.spawn().context("failed to spawn worker")?;
        if direct_native_harness_sidecar {
            initial_harness_pid = child.id();
        }
        let stdin = child.stdin.take().context("worker missing stdin pipe")?;
        let stdout = child.stdout.take().context("worker missing stdout pipe")?;
        let stderr = child.stderr.take().context("worker missing stderr pipe")?;
        let log_file = self.worker_log_path(&spec.name);
        let startup_log_file = log_file.clone();

        let generation = Uuid::new_v4();
        spawn_worker_reader(
            self.event_tx.clone(),
            spec.name.clone(),
            generation,
            "stdout",
            stdout,
            true,
            log_file.clone(),
        );
        spawn_worker_reader(
            self.event_tx.clone(),
            spec.name.clone(),
            generation,
            "stderr",
            stderr,
            false,
            log_file,
        );
        let (command_tx, command_rx) = mpsc::channel(WORKER_WRITE_QUEUE_CAPACITY);
        spawn_worker_writer(
            self.event_tx.clone(),
            spec.name.clone(),
            generation,
            stdin,
            command_rx,
        );

        let handle = WorkerHandle {
            generation,
            spec: spec.clone(),
            parent,
            workspace_id,
            child,
            command_tx,
            harness_pid: initial_harness_pid,
            spawned_at: Instant::now(),
            ready_at: None,
            last_activity_at: Instant::now(),
            context_budget_pct: None,
            state: AgentWorkState::Working,
            exit_reason: None,
        };
        self.workers.insert(spec.name.clone(), handle);

        if let Err(error) = self
            .send_to_worker(
                &spec.name,
                "init_worker",
                None,
                json!({
                    "agent": spec,
                }),
            )
            .await
        {
            // The wrapper can exit before the broker's first write reaches it
            // (its stdin closes, and `send_to_worker` fails with EPIPE before
            // the stability-window check below ever runs). Without this, that
            // race left a stale entry in `self.workers` that `node agent
            // list` could briefly advertise, exactly like a startup-check
            // rejection — so it gets the identical cleanup.
            self.cleanup_rejected_spawn(&spec.name).await;
            return Err(error);
        }

        let startup_confirmation = {
            let handle = self
                .workers
                .get_mut(&spec.name)
                .with_context(|| format!("unknown worker '{}' after spawn", spec.name))?;
            confirm_worker_process_alive(
                &spec.name,
                &mut handle.child,
                startup_log_file.as_deref(),
                WORKER_SPAWN_STABILITY_WINDOW,
            )
            .await
        };
        if let Err(error) = startup_confirmation {
            // `confirm_worker_process_alive` rejects here for two different
            // reasons: `try_wait` confirmed the wrapper exited, or `try_wait`
            // itself returned an I/O error and we don't actually know the
            // process is dead. Either way, terminate and reap it before
            // dropping the handle — the confirmed-exit case is a no-op kill,
            // but the I/O-error case would otherwise silently orphan a still
            // -live, unsupervised process. The original verification error is
            // preserved and returned either way.
            self.cleanup_rejected_spawn(&spec.name).await;
            return Err(error);
        }

        tracing::info!(
            target = "broker::spawn",
            name = %spec.name,
            "worker spawned and initialised"
        );

        Ok(spec)
    }

    pub(crate) async fn send_to_worker(
        &mut self,
        name: &str,
        msg_type: &str,
        request_id: Option<RequestId>,
        payload: Value,
    ) -> Result<()> {
        let command_tx = self
            .workers
            .get(name)
            .with_context(|| format!("unknown worker '{name}'"))?
            .command_tx
            .clone();
        let frame = encode_worker_frame(msg_type, request_id, payload)?;
        let (completion_tx, completion_rx) = oneshot::channel();
        command_tx
            .send(WorkerWriteCommand {
                frame,
                completion: Some(completion_tx),
            })
            .await
            .map_err(|_| anyhow::anyhow!("worker command writer is unavailable for '{name}'"))
            .with_context(|| format!("failed writing frame to worker '{name}'"))?;
        completion_rx
            .await
            .map_err(|_| {
                anyhow::anyhow!("worker command writer stopped before completing '{name}'")
            })
            .with_context(|| format!("failed writing frame to worker '{name}'"))?
            .map_err(anyhow::Error::msg)
            .with_context(|| format!("failed writing frame to worker '{name}'"))?;

        Ok(())
    }

    /// Queue an already-framed raw PTY command through the same sole stdin
    /// writer used for protocol frames. This keeps administrative PTY actions
    /// such as `/model` from interleaving with JSON protocol traffic.
    pub(crate) async fn send_raw_to_worker(&self, name: &str, frame: Vec<u8>) -> Result<()> {
        let command_tx = self
            .workers
            .get(name)
            .with_context(|| format!("unknown worker '{name}'"))?
            .command_tx
            .clone();
        let (completion_tx, completion_rx) = oneshot::channel();
        command_tx
            .send(WorkerWriteCommand {
                frame,
                completion: Some(completion_tx),
            })
            .await
            .map_err(|_| anyhow::anyhow!("worker command writer is unavailable for '{name}'"))?;
        completion_rx
            .await
            .map_err(|_| {
                anyhow::anyhow!("worker command writer stopped before completing '{name}'")
            })?
            .map_err(anyhow::Error::msg)
            .with_context(|| format!("failed writing raw command to worker '{name}'"))?;
        Ok(())
    }

    /// Enqueue a complete worker frame without awaiting its pipe write. This
    /// is used by terminal attach traffic, which must remain responsive when a
    /// PTY stops draining stdin. The dedicated writer owns the actual write;
    /// a later write failure is reported as [`WorkerEvent::WriterFailed`].
    pub(crate) fn try_send_to_worker(
        &self,
        name: &str,
        msg_type: &str,
        request_id: Option<RequestId>,
        payload: Value,
    ) -> Result<()> {
        let command_tx = self
            .workers
            .get(name)
            .with_context(|| format!("unknown worker '{name}'"))?
            .command_tx
            .clone();
        let frame = encode_worker_frame(msg_type, request_id, payload)?;
        command_tx
            .try_send(WorkerWriteCommand {
                frame,
                completion: None,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    anyhow::anyhow!("worker command queue is full for '{name}'")
                }
                mpsc::error::TrySendError::Closed(_) => {
                    anyhow::anyhow!("worker command writer is unavailable for '{name}'")
                }
            })
    }

    pub(crate) async fn deliver(&mut self, name: &str, delivery: RelayDelivery) -> Result<()> {
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

    pub(crate) async fn release(&mut self, name: &str) -> Result<()> {
        tracing::info!(target = "broker::release", name = %name, "releasing worker");
        self.initial_tasks.remove(name);
        // An explicit release is terminal even when the process already exited
        // and disappeared from `workers`. Cancel any pending restart before
        // looking up the handle so maintenance cannot resurrect the released
        // name after the API has acknowledged teardown.
        self.supervisor.unregister(name);
        let mut handle = self
            .workers
            .remove(name)
            .with_context(|| format!("unknown worker '{name}'"))?;
        let release_grace = release_grace_for_spec(&handle.spec);

        let shutdown_frame = ProtocolEnvelope {
            v: PROTOCOL_VERSION,
            msg_type: "shutdown_worker".to_string(),
            request_id: None,
            payload: json!({"reason":"release","grace_ms": release_grace.as_millis() as u64}),
        };
        let encoded = serde_json::to_vec(&shutdown_frame)?;
        let mut frame = encoded;
        frame.push(b'\n');
        let (completion_tx, completion_rx) = oneshot::channel();
        if handle
            .command_tx
            .try_send(WorkerWriteCommand {
                frame,
                completion: Some(completion_tx),
            })
            .is_ok()
        {
            // Cancelling this wait cannot cancel the worker-owned write; it
            // only bounds release before the normal process termination path.
            let _ = timeout(WORKER_SHUTDOWN_WRITE_TIMEOUT, completion_rx).await;
        }

        let result = terminate_child(&mut handle.child, release_grace).await;
        match &result {
            Ok(()) => tracing::info!(target = "broker::release", name = %name, "worker released"),
            Err(error) => {
                tracing::warn!(target = "broker::release", name = %name, error = %error, "worker release failed")
            }
        }
        result
    }

    pub(crate) async fn shutdown_all(&mut self) -> Result<()> {
        let names: Vec<WorkerName> = self.workers.keys().cloned().collect();
        for name in names {
            if let Err(error) = self.release(&name).await {
                tracing::warn!(target = "agent_relay::broker", name = %name, error = %error, "worker shutdown failed");
            }
        }
        Ok(())
    }

    pub(crate) async fn reap_exited(&mut self) -> Result<Vec<ExitedWorker>> {
        let names: Vec<WorkerName> = self.workers.keys().cloned().collect();
        let mut exited = Vec::new();
        for name in names {
            let (status, gone_via_kill0) = if let Some(handle) = self.workers.get_mut(&name) {
                match handle.child.try_wait() {
                    Ok(status) => {
                        if status.is_none() {
                            #[cfg(unix)]
                            {
                                if let Some(pid) = handle.child.id() {
                                    if pid_is_gone(pid) {
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
            // The wrapper can outlive its harness. When it does, judge the agent
            // by the harness and tear the orphaned wrapper down — otherwise the
            // agent is listed as `working` forever.
            let orphaned = if status.is_none() && !gone_via_kill0 {
                self.workers.get(&name).and_then(|handle| {
                    orphaned_worker(
                        handle.harness_pid,
                        handle.ready_at,
                        handle.spawned_at,
                        Instant::now(),
                    )
                })
            } else {
                None
            };
            if let Some(orphan) = orphaned {
                let generation = self
                    .workers
                    .get(&name)
                    .expect("orphaned worker must still be registered")
                    .generation;
                let reason = self
                    .workers
                    .get(&name)
                    .and_then(|handle| handle.exit_reason.clone())
                    .or_else(|| Some(orphan.reason().to_string()));
                if let Some(handle) = self.workers.get_mut(&name) {
                    tracing::warn!(
                        worker = %name,
                        wrapper_pid = ?handle.child.id(),
                        harness_pid = ?handle.harness_pid,
                        reason = orphan.reason(),
                        "reap_exited: harness gone but wrapper alive — killing orphaned wrapper"
                    );
                    // SIGKILL *and* reap. Dropping the `Child` without waiting
                    // leaves the wrapper to tokio's best-effort background
                    // reaper, so a run of failed agent starts accumulates
                    // zombies. SIGKILL cannot be caught, so this returns
                    // promptly — but the deadline keeps a wrapper wedged in
                    // uninterruptible sleep from stalling the maintenance tick,
                    // which also drives delivery retries.
                    if let Err(error) = handle.child.start_kill() {
                        tracing::warn!(worker = %name, %error, "failed to signal orphaned wrapper");
                    }
                    match timeout(ORPHAN_REAP_TIMEOUT, handle.child.wait()).await {
                        Ok(Ok(_)) => {}
                        Ok(Err(error)) => {
                            tracing::warn!(worker = %name, %error, "orphaned wrapper wait failed")
                        }
                        Err(_) => tracing::warn!(
                            worker = %name,
                            timeout_ms = ORPHAN_REAP_TIMEOUT.as_millis(),
                            "orphaned wrapper did not exit before the reap deadline"
                        ),
                    }
                }
                self.workers.remove(&name);
                self.initial_tasks.remove(&name);
                exited.push((name, generation, None, None, reason));
                continue;
            }
            if let Some(status) = status {
                let generation = self
                    .workers
                    .get(&name)
                    .expect("exited worker must still be registered")
                    .generation;
                let code = status.code();
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal().map(|s| s.to_string())
                };
                #[cfg(not(unix))]
                let signal: Option<String> = None;
                let reason = self
                    .workers
                    .get(&name)
                    .and_then(|handle| handle.exit_reason.clone());
                self.workers.remove(&name);
                self.initial_tasks.remove(&name);
                exited.push((name, generation, code, signal, reason));
            } else if gone_via_kill0 {
                let generation = self
                    .workers
                    .get(&name)
                    .expect("gone worker must still be registered")
                    .generation;
                let reason = self
                    .workers
                    .get(&name)
                    .and_then(|handle| handle.exit_reason.clone());
                self.workers.remove(&name);
                self.initial_tasks.remove(&name);
                exited.push((name, generation, None, None, reason));
            }
        }
        Ok(exited)
    }
}

fn should_inject_relay_participant_env(
    runtime: &AgentRuntime,
    direct_native_harness_sidecar: bool,
    skip_relay_prompt: bool,
) -> bool {
    !skip_relay_prompt && (matches!(runtime, AgentRuntime::Pty) || direct_native_harness_sidecar)
}

/// Runtime metadata is deliberately carried in the harness config so the
/// process wrapper can remain `headless` while attach clients select the
/// native harness transport. Accept both the explicit marker and protocol field to
/// keep the broker compatible with sidecars produced by adjacent releases.
pub(crate) fn native_harness_metadata(spec: &AgentSpec) -> Option<(u64, Option<Value>)> {
    let (metadata, explicit_protocol) = match spec.harness_config.as_ref()? {
        ResolvedHarnessConfig::Native(config) => (config.metadata.as_ref(), true),
        ResolvedHarnessConfig::Headless(config) => {
            let protocol = config.protocol.trim().to_ascii_lowercase();
            (
                config.metadata.as_ref(),
                protocol == "relay-native-harness" || protocol == "relay-native-harness-v1",
            )
        }
        ResolvedHarnessConfig::Pty(_) => return None,
    };
    let explicit = metadata
        .and_then(|m| m.get("runtimeKind").or_else(|| m.get("runtime_kind")))
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "native");
    if !explicit && !explicit_protocol {
        return None;
    }
    let version = metadata
        .and_then(|m| {
            m.get("nativeHarnessProtocolVersion")
                .or_else(|| m.get("native_harness_protocol_version"))
        })
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let capabilities = metadata
        .and_then(|m| {
            m.get("nativeHarnessCapabilities")
                .or_else(|| m.get("native_harness_capabilities"))
        })
        .cloned();
    Some((version, capabilities))
}

fn release_policy_arg(policy: Option<&HarnessReleasePolicy>) -> &'static str {
    match policy {
        Some(HarnessReleasePolicy::Abort) => "abort",
        Some(HarnessReleasePolicy::Delete) => "delete",
        Some(HarnessReleasePolicy::Detach) | None => "detach",
    }
}

fn app_server_auth_type_arg(auth_type: &AppServerAuthType) -> &'static str {
    match auth_type {
        AppServerAuthType::Bearer => "bearer",
        AppServerAuthType::Basic => "basic",
        AppServerAuthType::None => "none",
    }
}

fn release_grace_for_spec(spec: &AgentSpec) -> Duration {
    match spec.harness_config.as_ref() {
        Some(ResolvedHarnessConfig::Headless(config))
            if matches!(&config.driver, HeadlessHarnessDriver::AppServer) =>
        {
            APP_SERVER_RELEASE_GRACE
        }
        Some(ResolvedHarnessConfig::Native(_)) => APP_SERVER_RELEASE_GRACE,
        _ => DEFAULT_RELEASE_GRACE,
    }
}

fn validate_app_server_config(config: &HeadlessHarnessConfig) -> Result<()> {
    if !matches!(&config.driver, HeadlessHarnessDriver::AppServer) {
        anyhow::bail!("unsupported headless harness driver");
    }

    let protocol = config.protocol.trim().to_ascii_lowercase();
    if protocol != "opencode" {
        anyhow::bail!(
            "unsupported app_server protocol '{}' (supported: opencode)",
            config.protocol
        );
    }

    let endpoint = config.endpoint.trim();
    if endpoint.is_empty() {
        anyhow::bail!("app_server endpoint is required");
    }
    let parsed_endpoint = reqwest::Url::parse(endpoint)
        .with_context(|| format!("invalid app_server endpoint '{}'", config.endpoint))?;
    match parsed_endpoint.scheme() {
        "http" | "https" => {}
        scheme => anyhow::bail!(
            "invalid app_server endpoint scheme '{}' (expected http or https)",
            scheme
        ),
    }
    if config.auth.is_some()
        && parsed_endpoint.scheme() == "http"
        && !is_loopback_endpoint_host(&parsed_endpoint)
    {
        anyhow::bail!(
            "app_server auth requires https unless the endpoint is loopback: {}",
            config.endpoint
        );
    }

    if config.session_id.trim().is_empty() {
        anyhow::bail!("app_server sessionId is required");
    }

    if config
        .host
        .as_ref()
        .and_then(|host| host.ownership.as_ref())
        .is_some_and(|ownership| matches!(ownership, AppServerHostOwnership::BrokerOwned))
    {
        anyhow::bail!("broker-owned app_server hosts are not supported yet");
    }

    if let Some(auth) = config.auth.as_ref() {
        match auth.auth_type {
            AppServerAuthType::Bearer => {
                if auth
                    .token
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    anyhow::bail!("app_server bearer auth requires token");
                }
            }
            AppServerAuthType::Basic => {
                if auth
                    .username
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    anyhow::bail!("app_server basic auth requires username");
                }
                if auth
                    .password
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                {
                    anyhow::bail!("app_server basic auth requires password");
                }
            }
            AppServerAuthType::None => {}
        }
    }

    Ok(())
}

fn is_loopback_endpoint_host(endpoint: &reqwest::Url) -> bool {
    endpoint.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CodexSessionReference {
    Resume(String),
    Fork(String),
    VariadicImage,
    AmbiguousVariadicImage,
    Unknown,
    None,
}

fn prepare_claude_session_args(args: &mut Vec<String>) -> Option<String> {
    if let Some(session_id) = cli_flag_value(args, "--session-id") {
        return Some(session_id);
    }
    if cli_flag_present(args, &["--session-id"]) {
        return None;
    }
    if let Some(session_id) =
        cli_flag_value(args, "--resume").or_else(|| cli_flag_value(args, "-r"))
    {
        return Some(session_id);
    }
    if cli_flag_present(args, &["--resume", "-r", "--continue", "-c"]) {
        return None;
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    args.push("--session-id".to_string());
    args.push(session_id.clone());
    Some(session_id)
}

fn ordered_pty_cli_args(
    bypass_flag: Option<&str>,
    model: Option<&str>,
    mcp_args: &[String],
    effective_args: &[String],
    harness_session_args: &[String],
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(flag) = bypass_flag {
        args.push(flag.to_string());
    }
    if let Some(model) = model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    args.extend_from_slice(mcp_args);
    // Codex options such as --image are variadic and can consume an appended
    // `resume <thread>`. Put the broker-owned subcommand before user options;
    // Codex accepts its resume options after the session positional.
    args.extend_from_slice(harness_session_args);
    args.extend_from_slice(effective_args);
    args
}

fn apply_requested_session_reference(
    cli_lower: &str,
    session_id: &str,
    args: &mut Vec<String>,
    harness_session_args: &mut Vec<String>,
) -> Result<()> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        anyhow::bail!("session_ref must not be empty");
    }

    if cli_lower == "claude" || cli_lower.starts_with("claude:") {
        if let Some(existing) =
            cli_flag_value(args, "--resume").or_else(|| cli_flag_value(args, "-r"))
        {
            if existing != session_id {
                anyhow::bail!(
                    "session_ref conflicts with the Claude session argument already configured"
                );
            }
            return Ok(());
        }
        if cli_flag_present(
            args,
            &["--session-id", "--resume", "-r", "--continue", "-c"],
        ) {
            anyhow::bail!("session_ref requires an explicit Claude session id");
        }
        args.push("--resume".to_string());
        args.push(session_id.to_string());
        return Ok(());
    }

    if cli_lower == "codex" {
        match codex_session_reference(args) {
            CodexSessionReference::Resume(existing) if existing == session_id => return Ok(()),
            CodexSessionReference::Resume(_) => {
                anyhow::bail!(
                    "session_ref conflicts with the Codex session argument already configured"
                );
            }
            CodexSessionReference::Fork(_) => {
                anyhow::bail!("session_ref cannot be combined with a Codex fork");
            }
            CodexSessionReference::AmbiguousVariadicImage => {
                anyhow::bail!(
                    "session_ref cannot safely disambiguate Codex resume/fork values after --image"
                );
            }
            CodexSessionReference::Unknown => {
                anyhow::bail!("session_ref requires an explicit Codex session id");
            }
            CodexSessionReference::None | CodexSessionReference::VariadicImage => {
                harness_session_args.push("resume".to_string());
                harness_session_args.push(session_id.to_string());
                return Ok(());
            }
        }
    }

    anyhow::bail!("session_ref resume is supported only for Claude and Codex PTY harnesses");
}

fn codex_session_reference(args: &[String]) -> CodexSessionReference {
    let mut index = 0;
    let mut skip_next = false;
    while index < args.len() {
        let arg = args[index].as_str();
        if skip_next {
            skip_next = false;
            index += 1;
            continue;
        }
        if arg == "--" {
            return CodexSessionReference::None;
        }
        if codex_is_variadic_image_arg(arg) {
            return if args[index + 1..]
                .iter()
                .any(|value| value == "resume" || value == "fork")
            {
                CodexSessionReference::AmbiguousVariadicImage
            } else {
                CodexSessionReference::VariadicImage
            };
        }
        if codex_flag_consumes_next_arg(arg) {
            if args.get(index + 1).is_none() {
                return CodexSessionReference::Unknown;
            }
            skip_next = true;
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            if arg.contains('=') || codex_flag_without_value(arg) {
                index += 1;
                continue;
            }
            // An unknown option may consume the following token. Fail closed
            // instead of mistaking that value for a resume/fork subcommand.
            return CodexSessionReference::Unknown;
        }
        if arg == "resume" || arg == "fork" {
            let Some(next) = args.get(index + 1).map(String::as_str) else {
                return CodexSessionReference::Unknown;
            };
            if next == "--last" || next.starts_with('-') {
                return CodexSessionReference::Unknown;
            }
            return if arg == "resume" {
                CodexSessionReference::Resume(next.to_string())
            } else {
                CodexSessionReference::Fork(next.to_string())
            };
        }
        index += 1;
    }
    CodexSessionReference::None
}

fn codex_has_positional_arg(args: &[String]) -> bool {
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            return true;
        }
        if codex_is_variadic_image_arg(arg) {
            // At the root command, --image consumes subsequent positional
            // values. With a broker-owned resume prefix those same options are
            // safely interpreted by the resume subcommand.
            return false;
        }
        if codex_flag_consumes_next_arg(arg) {
            skip_next = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        return true;
    }
    false
}

fn codex_flag_consumes_next_arg(arg: &str) -> bool {
    if arg.contains('=') {
        return false;
    }
    matches!(
        arg,
        "--model"
            | "-m"
            | "--profile"
            | "-p"
            | "--config"
            | "-c"
            | "--enable"
            | "--disable"
            | "--remote"
            | "--remote-auth-token-env"
            | "--sandbox"
            | "-s"
            | "--local-provider"
            | "--ask-for-approval"
            | "-a"
            | "--approval-policy"
            | "--cd"
            | "-C"
            | "--cwd"
            | "--add-dir"
    )
}

fn codex_is_variadic_image_arg(arg: &str) -> bool {
    arg == "--image" || arg == "-i" || arg.starts_with("--image=") || arg.starts_with("-i=")
}

fn codex_flag_without_value(arg: &str) -> bool {
    matches!(
        arg,
        "--strict-config"
            | "--oss"
            | "--dangerously-bypass-approvals-and-sandbox"
            | "--dangerously-bypass-hook-trust"
            | "--full-auto"
            | "--search"
            | "--no-alt-screen"
            | "--help"
            | "-h"
            | "--version"
            | "-V"
    )
}

fn cli_flag_value(args: &[String], flag: &str) -> Option<String> {
    let equals_prefix = format!("{flag}=");
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if arg == flag {
            return args
                .get(index + 1)
                .filter(|value| !value.starts_with('-'))
                .cloned();
        }
        if let Some(value) = arg.strip_prefix(&equals_prefix) {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        index += 1;
    }
    None
}

fn cli_flag_present(args: &[String], flags: &[&str]) -> bool {
    args.iter().any(|arg| {
        let arg = arg.as_str();
        flags.iter().any(|flag| {
            arg == *flag
                || arg
                    .strip_prefix(*flag)
                    .is_some_and(|rest| rest.starts_with('='))
        })
    })
}

fn args_include_model_override(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "--model" || arg.starts_with("--model=") || arg == "-m" || arg.starts_with("-m=")
    })
}

async fn apply_codex_model_arg_fallback(
    resolved_cli: &str,
    normalized_cli: &str,
    worker_name: &str,
    args: &mut [String],
) -> Option<String> {
    const GPT_5_5: &str = "gpt-5.5";

    if !normalized_cli.eq_ignore_ascii_case("codex") || !args_reference_model(args, GPT_5_5) {
        return None;
    }

    let fallback = codex_local_fallback_model(resolved_cli, GPT_5_5).await?;

    if replace_model_arg(args, GPT_5_5, fallback) {
        tracing::warn!(
            worker = %worker_name,
            requested_model = %GPT_5_5,
            fallback_model = %fallback,
            "local Codex CLI model catalog does not confirm explicit model arg; rewriting to fallback"
        );
        Some(fallback.to_string())
    } else {
        None
    }
}

fn args_reference_model(args: &[String], model: &str) -> bool {
    args.iter().enumerate().any(|(index, arg)| {
        if arg == "--model" || arg == "-m" {
            return args.get(index + 1).is_some_and(|value| value == model);
        }
        arg.strip_prefix("--model=")
            .or_else(|| arg.strip_prefix("-m="))
            .is_some_and(|value| value == model)
    })
}

fn replace_model_arg(args: &mut [String], requested: &str, replacement: &str) -> bool {
    let mut changed = false;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--model" || args[index] == "-m" {
            if let Some(value) = args.get_mut(index + 1) {
                if value == requested {
                    *value = replacement.to_string();
                    changed = true;
                }
            }
            index += 2;
            continue;
        }

        if let Some(value) = args[index].strip_prefix("--model=") {
            if value == requested {
                args[index] = format!("--model={replacement}");
                changed = true;
            }
        } else if let Some(value) = args[index].strip_prefix("-m=") {
            if value == requested {
                args[index] = format!("-m={replacement}");
                changed = true;
            }
        }
        index += 1;
    }
    changed
}

async fn resolve_model_flag_for_cli(
    resolved_cli: &str,
    normalized_cli: &str,
    worker_name: &str,
    requested_model: Option<&str>,
    existing_args: &[String],
) -> Option<String> {
    let requested = requested_model?.trim();
    if requested.is_empty() || args_include_model_override(existing_args) {
        return None;
    }

    if normalized_cli.eq_ignore_ascii_case("codex") {
        if let Some(fallback) = codex_local_fallback_model(resolved_cli, requested).await {
            tracing::warn!(
                worker = %worker_name,
                requested_model = %requested,
                fallback_model = %fallback,
                "local Codex CLI model catalog does not confirm requested model; using fallback"
            );
            return Some(fallback.to_string());
        }
    }

    Some(requested.to_string())
}

async fn codex_local_fallback_model(
    resolved_cli: &str,
    requested_model: &str,
) -> Option<&'static str> {
    const GPT_5_5: &str = "gpt-5.5";
    const GPT_5_5_FALLBACK: &str = "gpt-5.4";

    if requested_model != GPT_5_5 {
        return None;
    }

    match codex_debug_models_contains_model(resolved_cli, requested_model).await {
        Some(true) | None => None,
        Some(false) => Some(GPT_5_5_FALLBACK),
    }
}

async fn codex_debug_models_contains_model(resolved_cli: &str, model: &str) -> Option<bool> {
    // Matches the spawn+output timeout used in snippets.rs: under CI load, spawning
    // the Codex CLI can take longer than 5s, which was previously causing a spurious
    // fallback away from the requested model instead of a genuine "unsupported" result.
    let output = timeout(
        Duration::from_secs(15),
        codex_debug_models_output(resolved_cli),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    codex_models_json_contains_model(&output.stdout, model)
}

/// Spawn `codex debug models`, retrying briefly on `ExecutableFileBusy`
/// (`ETXTBSY`, "Text file busy").
///
/// On Linux a concurrent `fork`/`exec` in another thread can transiently hold a
/// writable file descriptor to an executable that was just written, so `execve`
/// of a freshly written binary can spuriously fail with `ETXTBSY`. This is a
/// well-known race in multithreaded programs that spawn subprocesses (and shows
/// up in this crate's parallel test suite, where each test writes and immediately
/// execs a fake `codex` script). Retry a few times with a short backoff before
/// giving up; all attempts stay within the caller's spawn timeout budget.
///
/// Matched via the portable `std::io::ErrorKind::ExecutableFileBusy` rather than
/// a raw `libc::ETXTBSY` so the code stays correct on non-Unix targets (the
/// broker also builds for Windows), where the errno is absent and this condition
/// simply never fires.
async fn codex_debug_models_output(resolved_cli: &str) -> std::io::Result<std::process::Output> {
    const MAX_ATTEMPTS: u32 = 5;
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        match Command::new(resolved_cli)
            .arg("debug")
            .arg("models")
            .output()
            .await
        {
            Err(err)
                if err.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && attempt < MAX_ATTEMPTS =>
            {
                tokio::time::sleep(Duration::from_millis(20 * u64::from(attempt))).await;
            }
            other => return other,
        }
    }
}

fn codex_models_json_contains_model(bytes: &[u8], model: &str) -> Option<bool> {
    let value = serde_json::from_slice::<Value>(bytes).ok()?;
    let models = value.get("models")?.as_array()?;
    Some(models.iter().any(|entry| {
        let matches_model = entry
            .get("slug")
            .or_else(|| entry.get("id"))
            .or_else(|| entry.get("model"))
            .and_then(Value::as_str)
            .is_some_and(|slug| slug == model);
        let requires_upgrade = entry
            .get("upgrade")
            .is_some_and(|upgrade| !upgrade.is_null());
        matches_model && !requires_upgrade
    }))
}

fn spawn_worker_reader<R>(
    tx: mpsc::Sender<WorkerEvent>,
    name: WorkerName,
    generation: Uuid,
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
                            generation,
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

            // Only stdout carries the PTY-output protocol. Stderr is captured
            // in the worker log file for diagnostics; forwarding it as a
            // worker_stream event causes tracing logs (e.g. the idle
            // watchdog) to render inside the agent's xterm buffer, on top of
            // the CLI's input prompt.
            if !parse_json {
                continue;
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
                    generation,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AppServerHarnessAuth, AppServerHarnessHost};

    fn make_registry(env: Vec<(String, String)>) -> WorkerRegistry {
        let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
        WorkerRegistry::new(tx, env, PathBuf::from("/tmp/worker-tests"), Instant::now())
    }

    #[test]
    fn worker_registry_starts_empty() {
        let reg = make_registry(vec![]);
        assert!(reg.list(&HashMap::new()).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_confirmation_rejects_a_process_that_exits_immediately() {
        let mut child = Command::new("sleep").arg("0").spawn().unwrap();

        let error = confirm_worker_process_alive(
            "failed-worker",
            &mut child,
            Some(Path::new("/tmp/failed-worker.log")),
            Duration::from_millis(500),
        )
        .await
        .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("process exited during startup"));
        assert!(message.contains("/tmp/failed-worker.log"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_confirmation_accepts_a_process_that_stays_alive() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();

        confirm_worker_process_alive("live-worker", &mut child, None, Duration::from_millis(100))
            .await
            .unwrap();

        terminate_child(&mut child, Duration::from_millis(200))
            .await
            .unwrap();
    }

    #[cfg(unix)]
    fn spec_for_test(name: &str) -> AgentSpec {
        AgentSpec {
            name: WorkerName::from(name),
            runtime: AgentRuntime::Headless,
            provider: None,
            cli: None,
            session_id: None,
            harness_config: None,
            model: None,
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            args: Vec::new(),
            channels: Vec::new(),
            restart_policy: None,
        }
    }

    #[cfg(unix)]
    fn is_process_alive(pid: u32) -> bool {
        use nix::{sys::signal::kill, unistd::Pid};
        // `kill(pid, None)` is the POSIX liveness probe: it signals nothing,
        // it only reports whether the pid still exists and is ours to signal.
        kill(Pid::from_raw(pid as i32), None).is_ok()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_rejected_spawn_terminates_a_still_alive_child_and_removes_it() {
        // Regression test: a rejected spawn used to remove the registry entry
        // (and, before that fix, sometimes not even run cleanup — see the
        // EPIPE-race test below) without ever touching the child process
        // itself. Dropping a `tokio::process::Child` does not kill the OS
        // process, so a spawn rejected while the wrapper was still alive
        // orphaned it. `cleanup_rejected_spawn` must kill and reap it.
        let mut reg = make_registry(vec![]);
        let name = "cleanup-orphan-candidate";
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id().expect("child has a pid");
        let stdin = child.stdin.take().expect("piped stdin");
        let generation = Uuid::new_v4();
        let (command_tx, command_rx) = mpsc::channel(WORKER_WRITE_QUEUE_CAPACITY);
        spawn_worker_writer(
            reg.event_tx.clone(),
            WorkerName::from(name),
            generation,
            stdin,
            command_rx,
        );
        assert!(
            is_process_alive(pid),
            "precondition: child must start alive"
        );

        reg.workers.insert(
            WorkerName::from(name),
            WorkerHandle {
                generation,
                spec: spec_for_test(name),
                parent: None,
                workspace_id: None,
                child,
                command_tx,
                harness_pid: None,
                spawned_at: Instant::now(),
                ready_at: None,
                last_activity_at: Instant::now(),
                context_budget_pct: None,
                state: AgentWorkState::Working,
                exit_reason: None,
            },
        );

        reg.cleanup_rejected_spawn(&WorkerName::from(name)).await;

        assert!(!reg.workers.contains_key(&WorkerName::from(name)));
        assert!(
            !is_process_alive(pid),
            "cleanup_rejected_spawn must terminate the child, not just drop the handle"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn init_worker_send_failure_cleans_up_like_a_startup_rejection() {
        // Regression test for the EPIPE race: if the wrapper exits before the
        // broker's first write reaches it, `send_to_worker("init_worker")`
        // fails before the stability-window check ever runs. Before this fix
        // that early `?` skipped cleanup entirely, leaving a stale entry
        // `node agent list` could advertise. Trigger a real write failure —
        // once a child exits, its stdin's read end closes, so writing to our
        // held `ChildStdin` fails — rather than asserting on message text.
        let mut reg = make_registry(vec![]);
        let name = "epipe-candidate";
        let mut child = Command::new("true").stdin(Stdio::piped()).spawn().unwrap();
        let stdin = child.stdin.take().expect("piped stdin");
        child.wait().await.expect("child exits immediately");
        let generation = Uuid::new_v4();
        let (command_tx, command_rx) = mpsc::channel(WORKER_WRITE_QUEUE_CAPACITY);
        spawn_worker_writer(
            reg.event_tx.clone(),
            WorkerName::from(name),
            generation,
            stdin,
            command_rx,
        );

        reg.workers.insert(
            WorkerName::from(name),
            WorkerHandle {
                generation,
                spec: spec_for_test(name),
                parent: None,
                workspace_id: None,
                child,
                command_tx,
                harness_pid: None,
                spawned_at: Instant::now(),
                ready_at: None,
                last_activity_at: Instant::now(),
                context_budget_pct: None,
                state: AgentWorkState::Working,
                exit_reason: None,
            },
        );

        let send_result = reg
            .send_to_worker(name, "init_worker", None, json!({}))
            .await;
        assert!(
            send_result.is_err(),
            "writing to a worker whose process already exited must fail, proving the race is real"
        );

        // This mirrors exactly what `spawn()` now does on this error path.
        reg.cleanup_rejected_spawn(&WorkerName::from(name)).await;

        assert!(!reg.workers.contains_key(&WorkerName::from(name)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_enqueue_serializes_complete_frames_through_one_writer() {
        let (event_tx, _event_rx) = mpsc::channel::<WorkerEvent>(16);
        let mut reg = WorkerRegistry::new(
            event_tx.clone(),
            Vec::new(),
            PathBuf::from("/tmp/worker-tests"),
            Instant::now(),
        );
        let name = "writer-serialization";
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let generation = Uuid::new_v4();
        let (command_tx, command_rx) = mpsc::channel(WORKER_WRITE_QUEUE_CAPACITY);
        spawn_worker_writer(
            event_tx,
            WorkerName::from(name),
            generation,
            stdin,
            command_rx,
        );
        reg.workers.insert(
            WorkerName::from(name),
            WorkerHandle {
                generation,
                spec: spec_for_test(name),
                parent: None,
                workspace_id: None,
                child,
                command_tx,
                harness_pid: None,
                spawned_at: Instant::now(),
                ready_at: None,
                last_activity_at: Instant::now(),
                context_budget_pct: None,
                state: AgentWorkState::Working,
                exit_reason: None,
            },
        );

        reg.try_send_to_worker(name, "snapshot_pty", None, json!({ "format": "ansi" }))
            .unwrap();
        reg.try_send_to_worker(name, "resize_pty", None, json!({ "rows": 24, "cols": 80 }))
            .unwrap();

        let mut lines = BufReader::new(stdout).lines();
        for expected_type in ["snapshot_pty", "resize_pty"] {
            let line = timeout(Duration::from_secs(1), lines.next_line())
                .await
                .expect("writer should not block")
                .expect("cat stdout should remain open")
                .expect("writer should emit a complete newline-delimited frame");
            let frame: Value = serde_json::from_str(&line)
                .expect("each serialized worker command must remain valid JSON");
            assert_eq!(
                frame.get("type").and_then(Value::as_str),
                Some(expected_type)
            );
        }

        let handle = reg
            .workers
            .get_mut(name)
            .expect("test worker remains registered");
        terminate_child(&mut handle.child, Duration::from_millis(200))
            .await
            .unwrap();
    }

    // The wrapper process can outlive the harness it hosts, so reaping on the
    // wrapper alone leaves a dead agent listed as `working` forever.
    mod orphaned_worker {
        use super::*;

        /// A pid that cannot be live. `kill(0)` on pid 0 addresses the caller's
        /// own process group, so use an unassigned high pid instead.
        fn dead_pid() -> u32 {
            // Above the default pid_max; never allocated.
            0x7FFF_FFFF
        }

        fn live_pid() -> u32 {
            std::process::id()
        }

        #[test]
        fn reports_harness_exited_when_the_reported_pid_is_gone() {
            let now = Instant::now();
            assert_eq!(
                orphaned_worker(Some(dead_pid()), Some(now), now, now),
                Some(OrphanedWorker::HarnessExited)
            );
        }

        #[test]
        fn leaves_a_worker_with_a_live_harness_alone() {
            let now = Instant::now();
            assert_eq!(orphaned_worker(Some(live_pid()), Some(now), now, now), None);
        }

        // A live harness pid is proof of life even if `worker_ready` was missed,
        // so the readiness deadline must not apply to it.
        #[test]
        fn a_live_harness_is_never_reaped_for_missing_readiness() {
            let spawned = Instant::now();
            let now = spawned + WORKER_READY_DEADLINE + Duration::from_secs(60);
            assert_eq!(orphaned_worker(Some(live_pid()), None, spawned, now), None);
        }

        #[test]
        fn reports_never_ready_only_after_the_deadline() {
            let spawned = Instant::now();
            // Still inside the window — a slow harness must be left to boot.
            assert_eq!(
                orphaned_worker(None, None, spawned, spawned + Duration::from_secs(30)),
                None
            );
            assert_eq!(
                orphaned_worker(None, None, spawned, spawned + WORKER_READY_DEADLINE),
                None
            );
            assert_eq!(
                orphaned_worker(
                    None,
                    None,
                    spawned,
                    spawned + WORKER_READY_DEADLINE + Duration::from_secs(1)
                ),
                Some(OrphanedWorker::NeverReady)
            );
        }

        // A worker that reported ready and has no pid to probe (non-PTY
        // runtimes) must never be reaped by the deadline.
        #[test]
        fn a_ready_worker_without_a_pid_is_never_reaped() {
            let spawned = Instant::now();
            let now = spawned + WORKER_READY_DEADLINE * 10;
            assert_eq!(orphaned_worker(None, Some(spawned), spawned, now), None);
        }

        #[test]
        fn the_deadline_allows_slow_pty_startup_before_reaping() {
            // The PTY emits a one-shot warning at 25s but keeps waiting for a
            // proven prompt. A reported live child pid bypasses this deadline;
            // without either signal, the broker still leaves a generous margin
            // before classifying the wrapper as orphaned.
            assert!(WORKER_READY_DEADLINE > Duration::from_secs(25) * 3);
        }
    }

    #[test]
    fn has_worker_returns_false_for_unknown() {
        let reg = make_registry(vec![]);
        assert!(!reg.has_worker("nonexistent"));
    }

    #[test]
    fn has_worker_in_workspace_returns_false_for_unknown() {
        let reg = make_registry(vec![]);
        let workspace = crate::ids::WorkspaceId::new("ws_1".to_string());
        assert!(!reg.has_worker_in_workspace("nonexistent", &workspace));
    }

    #[tokio::test]
    async fn release_cancels_pending_restart_for_an_already_exited_worker() {
        let mut reg = make_registry(vec![]);
        let name = "released-stale-worker";
        let restart_policy = crate::supervisor::RestartPolicy {
            cooldown_ms: 0,
            ..crate::supervisor::RestartPolicy::default()
        };
        let spec = AgentSpec {
            name: WorkerName::from(name),
            runtime: AgentRuntime::Headless,
            provider: None,
            cli: None,
            session_id: None,
            harness_config: None,
            model: None,
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            args: Vec::new(),
            channels: Vec::new(),
            restart_policy: Some(restart_policy.clone()),
        };
        reg.supervisor.register(
            name,
            crate::supervisor::SupervisedAgent {
                spec,
                parent: None,
                initial_task: None,
                skip_relay_prompt: false,
                agent_result: None,
            },
            restart_policy,
        );
        assert!(reg.supervisor.is_supervised(name));
        assert!(matches!(
            reg.supervisor.on_exit(name, Some(1), None),
            Some(crate::supervisor::RestartDecision::Restart { .. })
        ));
        assert!(!reg.supervisor.pending_restarts().is_empty());

        let error = reg
            .release(name)
            .await
            .expect_err("missing process is still reported");
        assert!(error.to_string().contains("unknown worker"));
        assert!(!reg.supervisor.is_supervised(name));
        assert!(reg.supervisor.pending_restarts().is_empty());
    }

    #[test]
    fn worker_log_path_rejects_path_traversal() {
        let reg = make_registry(vec![]);
        assert!(reg.worker_log_path("..").is_none());
        assert!(reg.worker_log_path("../etc/passwd").is_none());
        assert!(reg.worker_log_path("foo/../bar").is_none());
        assert!(reg.worker_log_path("foo/bar").is_none());
        assert!(reg.worker_log_path("foo\\bar").is_none());
        assert!(reg.worker_log_path("valid-name").is_some());
        assert!(reg.worker_log_path("worker.1").is_some());
    }

    #[test]
    fn env_value_lookup() {
        let env = vec![("KEY".into(), "val".into())];
        let reg = make_registry(env);
        assert_eq!(reg.env_value("KEY"), Some("val"));
        assert_eq!(reg.env_value("MISSING"), None);
    }

    #[test]
    fn relay_participant_credentials_cover_pty_and_direct_native_sidecars() {
        assert!(should_inject_relay_participant_env(
            &AgentRuntime::Pty,
            false,
            false
        ));
        assert!(should_inject_relay_participant_env(
            &AgentRuntime::Headless,
            true,
            false
        ));
        assert!(!should_inject_relay_participant_env(
            &AgentRuntime::Headless,
            false,
            false
        ));
        assert!(!should_inject_relay_participant_env(
            &AgentRuntime::Headless,
            true,
            true
        ));
    }

    fn make_app_server_config() -> HeadlessHarnessConfig {
        HeadlessHarnessConfig {
            driver: HeadlessHarnessDriver::AppServer,
            protocol: "opencode".to_string(),
            endpoint: "http://127.0.0.1:4096".to_string(),
            session_id: "ses_123".to_string(),
            auth: None,
            host: Some(AppServerHarnessHost {
                ownership: Some(AppServerHostOwnership::Attached),
                pid: Some(12345),
            }),
            release: Some(HarnessReleasePolicy::Detach),
            metadata: None,
        }
    }

    #[test]
    fn app_server_config_validation_accepts_attached_opencode_config() {
        let config = make_app_server_config();
        validate_app_server_config(&config).expect("valid app-server config");
    }

    #[test]
    fn native_harness_metadata_is_explicit_and_capability_accurate() {
        let spec: AgentSpec = serde_json::from_value(json!({
            "name": "native-worker",
            "runtime": "headless",
            "args": [],
            "channels": [],
            "harnessConfig": {
                "runtime": "native",
                "command": "node",
                "args": ["/tmp/sidecar.js"],
                "sessionId": "native-1",
                "metadata": {
                    "runtimeKind": "native",
                    "nativeHarnessProtocolVersion": 1,
                    "nativeHarnessCapabilities": {"activeInput": true, "interrupt": true}
                }
            }
        }))
        .expect("native harness agent spec");

        let (version, capabilities) =
            native_harness_metadata(&spec).expect("native harness metadata");
        assert_eq!(version, 1);
        assert_eq!(
            capabilities.unwrap(),
            json!({"activeInput": true, "interrupt": true})
        );
    }

    #[test]
    fn app_server_config_validation_rejects_missing_bearer_token() {
        let mut config = make_app_server_config();
        config.auth = Some(AppServerHarnessAuth {
            auth_type: AppServerAuthType::Bearer,
            token: None,
            username: None,
            password: None,
        });

        let error = validate_app_server_config(&config).expect_err("missing token rejected");
        assert!(error.to_string().contains("bearer auth requires token"));
    }

    #[test]
    fn app_server_config_validation_rejects_authenticated_non_loopback_http() {
        let mut config = make_app_server_config();
        config.endpoint = "http://example.com:4096".to_string();
        config.auth = Some(AppServerHarnessAuth {
            auth_type: AppServerAuthType::Bearer,
            token: Some("token".to_string()),
            username: None,
            password: None,
        });

        let error = validate_app_server_config(&config).expect_err("non-loopback http rejected");
        assert!(error
            .to_string()
            .contains("auth requires https unless the endpoint is loopback"));
    }

    #[test]
    fn app_server_config_validation_rejects_broker_owned_host() {
        let mut config = make_app_server_config();
        config.host = Some(AppServerHarnessHost {
            ownership: Some(AppServerHostOwnership::BrokerOwned),
            pid: None,
        });

        let error = validate_app_server_config(&config).expect_err("broker-owned host rejected");
        assert!(error
            .to_string()
            .contains("broker-owned app_server hosts are not supported yet"));
    }

    #[test]
    fn app_server_config_validation_rejects_unsupported_protocol() {
        let mut config = make_app_server_config();
        config.protocol = "custom".to_string();

        let error = validate_app_server_config(&config).expect_err("unsupported protocol rejected");
        assert!(error
            .to_string()
            .contains("unsupported app_server protocol"));
    }

    #[test]
    fn app_server_release_uses_extended_grace() {
        let spec = AgentSpec {
            name: WorkerName::from("opencode-app"),
            runtime: AgentRuntime::Headless,
            provider: None,
            cli: None,
            session_id: Some("ses_123".to_string()),
            harness_config: Some(ResolvedHarnessConfig::Headless(make_app_server_config())),
            model: None,
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            args: Vec::new(),
            channels: Vec::new(),
            restart_policy: None,
        };

        assert_eq!(release_grace_for_spec(&spec), APP_SERVER_RELEASE_GRACE);
    }

    #[test]
    fn prepare_claude_session_args_generates_uuid_session_id() {
        let mut args = Vec::new();
        let session_id = prepare_claude_session_args(&mut args).expect("session id");

        assert!(uuid::Uuid::parse_str(&session_id).is_ok());
        assert_eq!(args, vec!["--session-id".to_string(), session_id]);
    }

    #[test]
    fn prepare_claude_session_args_preserves_explicit_session_id() {
        let mut args = vec![
            "--session-id".to_string(),
            "session-1".to_string(),
            "--print".to_string(),
        ];
        let session_id = prepare_claude_session_args(&mut args);

        assert_eq!(session_id.as_deref(), Some("session-1"));
        assert_eq!(
            args,
            vec![
                "--session-id".to_string(),
                "session-1".to_string(),
                "--print".to_string(),
            ]
        );
    }

    #[test]
    fn prepare_claude_session_args_uses_resume_id_without_injecting() {
        let mut args = vec!["--resume=session-2".to_string()];
        let session_id = prepare_claude_session_args(&mut args);

        assert_eq!(session_id.as_deref(), Some("session-2"));
        assert_eq!(args, vec!["--resume=session-2".to_string()]);
    }

    #[test]
    fn requested_session_reference_adds_claude_resume_args() {
        let mut args = vec!["--model".to_string(), "claude-opus-4-1".to_string()];
        let mut harness_session_args = Vec::new();

        apply_requested_session_reference(
            "claude",
            "session-claude-1",
            &mut args,
            &mut harness_session_args,
        )
        .expect("Claude session resume");

        assert_eq!(
            args,
            vec![
                "--model".to_string(),
                "claude-opus-4-1".to_string(),
                "--resume".to_string(),
                "session-claude-1".to_string(),
            ]
        );
        assert!(harness_session_args.is_empty());
    }

    #[test]
    fn requested_session_reference_adds_codex_resume_args() {
        let mut args = vec!["--profile".to_string(), "work".to_string()];
        let mut harness_session_args = Vec::new();

        apply_requested_session_reference(
            "codex",
            "thread-codex-1",
            &mut args,
            &mut harness_session_args,
        )
        .expect("Codex session resume");

        assert_eq!(args, vec!["--profile".to_string(), "work".to_string()]);
        assert_eq!(
            harness_session_args,
            vec!["resume".to_string(), "thread-codex-1".to_string()]
        );
    }

    #[test]
    fn requested_session_reference_does_not_treat_flag_value_as_codex_resume() {
        let mut args = vec!["--enable".to_string(), "resume".to_string()];
        let mut harness_session_args = Vec::new();

        apply_requested_session_reference(
            "codex",
            "thread-codex-1",
            &mut args,
            &mut harness_session_args,
        )
        .expect("Codex session resume");

        assert_eq!(args, vec!["--enable".to_string(), "resume".to_string()]);
        assert_eq!(
            harness_session_args,
            vec!["resume".to_string(), "thread-codex-1".to_string()]
        );
    }

    #[test]
    fn requested_session_reference_precedes_variadic_codex_image_args() {
        let mut args = vec!["--image".to_string(), "/tmp/review.png".to_string()];
        let mut harness_session_args = Vec::new();

        apply_requested_session_reference(
            "codex",
            "thread-codex-1",
            &mut args,
            &mut harness_session_args,
        )
        .expect("Codex session resume");

        let ordered = ordered_pty_cli_args(
            Some("--dangerously-bypass-approvals-and-sandbox"),
            Some("gpt-5.4"),
            &[
                "-c".to_string(),
                "mcp_servers.agent-relay.enabled=true".to_string(),
            ],
            &args,
            &harness_session_args,
        );
        assert_eq!(
            ordered,
            vec![
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5.4",
                "-c",
                "mcp_servers.agent-relay.enabled=true",
                "resume",
                "thread-codex-1",
                "--image",
                "/tmp/review.png",
            ]
        );
    }

    #[test]
    fn requested_session_reference_accepts_matching_resume_before_codex_images() {
        let mut args = vec![
            "resume".to_string(),
            "thread-codex-1".to_string(),
            "--image".to_string(),
            "/tmp/review.png".to_string(),
        ];
        let mut harness_session_args = Vec::new();

        apply_requested_session_reference(
            "codex",
            "thread-codex-1",
            &mut args,
            &mut harness_session_args,
        )
        .expect("matching explicit Codex resume");

        assert!(harness_session_args.is_empty());
    }

    #[test]
    fn requested_session_reference_rejects_ambiguous_variadic_codex_image_values() {
        let mut args = vec![
            "--image".to_string(),
            "/tmp/review.png".to_string(),
            "resume".to_string(),
        ];
        let mut harness_session_args = Vec::new();

        let error = apply_requested_session_reference(
            "codex",
            "thread-codex-1",
            &mut args,
            &mut harness_session_args,
        )
        .expect_err("ambiguous variadic values must fail closed");

        assert!(error.to_string().contains("after --image"));
        assert!(harness_session_args.is_empty());
    }

    #[test]
    fn requested_session_reference_rejects_ambiguous_codex_option() {
        let mut args = vec!["--future-option".to_string(), "resume".to_string()];
        let mut harness_session_args = Vec::new();

        let error = apply_requested_session_reference(
            "codex",
            "thread-codex-1",
            &mut args,
            &mut harness_session_args,
        )
        .expect_err("unknown Codex option arity must fail closed");

        assert!(error
            .to_string()
            .contains("requires an explicit Codex session id"));
        assert!(harness_session_args.is_empty());
    }

    #[test]
    fn requested_session_reference_rejects_conflicting_cli_session() {
        let mut args = vec!["resume".to_string(), "thread-other".to_string()];
        let mut harness_session_args = Vec::new();

        let error = apply_requested_session_reference(
            "codex",
            "thread-requested",
            &mut args,
            &mut harness_session_args,
        )
        .expect_err("conflicting resume must fail closed");

        assert!(error.to_string().contains("conflicts"));
        assert!(harness_session_args.is_empty());
    }

    #[test]
    fn requested_session_reference_rejects_new_or_forked_sessions() {
        let mut claude_args = vec!["--session-id".to_string(), "session-requested".to_string()];
        let mut claude_harness_args = Vec::new();
        let claude_error = apply_requested_session_reference(
            "claude",
            "session-requested",
            &mut claude_args,
            &mut claude_harness_args,
        )
        .expect_err("a requested session must resume instead of starting");
        assert!(claude_error
            .to_string()
            .contains("explicit Claude session id"));

        let mut codex_args = vec!["fork".to_string(), "thread-requested".to_string()];
        let mut codex_harness_args = Vec::new();
        let codex_error = apply_requested_session_reference(
            "codex",
            "thread-requested",
            &mut codex_args,
            &mut codex_harness_args,
        )
        .expect_err("a requested session must resume instead of forking");
        assert!(codex_error.to_string().contains("Codex fork"));
    }

    #[test]
    fn codex_session_reference_detects_resume_and_fork_ids() {
        assert_eq!(
            codex_session_reference(&[
                "--model".into(),
                "gpt-5.4".into(),
                "resume".into(),
                "thread-1".into()
            ]),
            CodexSessionReference::Resume("thread-1".to_string())
        );
        assert_eq!(
            codex_session_reference(&["fork".into(), "thread-2".into()]),
            CodexSessionReference::Fork("thread-2".to_string())
        );
        assert_eq!(
            codex_session_reference(&["resume".into(), "--last".into()]),
            CodexSessionReference::Unknown
        );
        // Trailing value-taking flag without a value -> Unknown (don't blindly
        // pre-create a Codex session for malformed CLI input).
        assert_eq!(
            codex_session_reference(&["--profile".into()]),
            CodexSessionReference::Unknown
        );
        assert_eq!(
            codex_session_reference(&[
                "--image".into(),
                "/tmp/review.png".into(),
                "resume".into(),
                "thread-3".into(),
            ]),
            CodexSessionReference::AmbiguousVariadicImage
        );
        assert_eq!(
            codex_session_reference(&["--image".into(), "/tmp/review.png".into()]),
            CodexSessionReference::VariadicImage
        );
        assert_eq!(
            codex_session_reference(&[
                "resume".into(),
                "thread-4".into(),
                "--image".into(),
                "/tmp/review.png".into(),
            ]),
            CodexSessionReference::Resume("thread-4".to_string())
        );
    }

    #[test]
    fn codex_has_positional_arg_ignores_known_global_flag_values() {
        assert!(!codex_has_positional_arg(&[
            "--model".into(),
            "gpt-5.4".into(),
            "--config".into(),
            "model_provider=default".into(),
        ]));
        assert!(codex_has_positional_arg(&[
            "--model".into(),
            "gpt-5.4".into(),
            "Fix the bug".into(),
        ]));
        assert!(codex_has_positional_arg(&["exec".into()]));
        assert!(!codex_has_positional_arg(&[
            "--image".into(),
            "/tmp/review.png".into(),
        ]));
    }

    #[test]
    fn args_include_model_override_detects_supported_forms() {
        assert!(args_include_model_override(&[
            "--model".to_string(),
            "gpt-5.4".to_string()
        ]));
        assert!(args_include_model_override(
            &["--model=gpt-5.4".to_string()]
        ));
        assert!(args_include_model_override(&[
            "-m".to_string(),
            "gpt-5.4".to_string()
        ]));
        assert!(args_include_model_override(&["-m=gpt-5.4".to_string()]));
        assert!(!args_include_model_override(&["--search".to_string()]));
    }

    #[test]
    fn model_arg_helpers_detect_and_replace_supported_forms() {
        let mut args = vec![
            "--model".to_string(),
            "gpt-5.5".to_string(),
            "--foo".to_string(),
            "--model=gpt-5.5".to_string(),
            "-m=gpt-5.5".to_string(),
        ];

        assert!(args_reference_model(&args, "gpt-5.5"));
        assert!(replace_model_arg(&mut args, "gpt-5.5", "gpt-5.4"));
        assert_eq!(
            args,
            vec![
                "--model".to_string(),
                "gpt-5.4".to_string(),
                "--foo".to_string(),
                "--model=gpt-5.4".to_string(),
                "-m=gpt-5.4".to_string(),
            ]
        );
        assert!(!args_reference_model(&args, "gpt-5.5"));
    }

    #[test]
    fn codex_models_json_contains_slug_model() {
        let catalog = br#"{
          "models": [
            { "slug": "gpt-5.4", "upgrade": null },
            { "slug": "gpt-5.5", "upgrade": null }
          ]
        }"#;

        assert_eq!(
            codex_models_json_contains_model(catalog, "gpt-5.5"),
            Some(true)
        );
        assert_eq!(
            codex_models_json_contains_model(catalog, "gpt-5.3-codex"),
            Some(false)
        );
    }

    #[test]
    fn codex_models_json_treats_upgrade_requirement_as_unsupported() {
        let catalog = br#"{
          "models": [
            { "slug": "gpt-5.5", "upgrade": { "message": "requires a newer version" } }
          ]
        }"#;

        assert_eq!(
            codex_models_json_contains_model(catalog, "gpt-5.5"),
            Some(false)
        );
    }

    #[test]
    fn codex_models_json_requires_models_array() {
        assert_eq!(
            codex_models_json_contains_model(br#"{"models":{}}"#, "gpt-5.5"),
            None
        );
        assert_eq!(
            codex_models_json_contains_model(b"not json", "gpt-5.5"),
            None
        );
    }

    #[cfg(unix)]
    fn write_fake_codex(catalog_json: &str) -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let script = dir.path().join("codex");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"debug\" ] && [ \"$2\" = \"models\" ]; then\n  printf '%s\\n' '{}'\n  exit 0\nfi\nexit 1\n",
                catalog_json
            ),
        )
        .expect("write fake codex");
        let mut permissions = std::fs::metadata(&script)
            .expect("fake codex metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).expect("chmod fake codex");
        dir
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_arg_fallback_rewrites_explicit_model_and_reports_effective_model() {
        let dir = write_fake_codex(
            r#"{"models":[{"slug":"gpt-5.5","upgrade":{"message":"requires a newer version"}},{"slug":"gpt-5.4","upgrade":null}]}"#,
        );
        let fake_codex = dir.path().join("codex");
        let mut args = vec![
            "--model".to_string(),
            "gpt-5.5".to_string(),
            "--foo".to_string(),
        ];

        let fallback = apply_codex_model_arg_fallback(
            fake_codex.to_str().expect("utf-8 fake codex path"),
            "codex",
            "worker-a",
            &mut args,
        )
        .await;

        assert_eq!(fallback.as_deref(), Some("gpt-5.4"));
        assert_eq!(
            args,
            vec![
                "--model".to_string(),
                "gpt-5.4".to_string(),
                "--foo".to_string(),
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_arg_fallback_keeps_supported_explicit_model() {
        let dir = write_fake_codex(r#"{"models":[{"slug":"gpt-5.5","upgrade":null}]}"#);
        let fake_codex = dir.path().join("codex");
        let mut args = vec!["--model=gpt-5.5".to_string()];

        let fallback = apply_codex_model_arg_fallback(
            fake_codex.to_str().expect("utf-8 fake codex path"),
            "codex",
            "worker-a",
            &mut args,
        )
        .await;

        assert_eq!(fallback, None);
        assert_eq!(args, vec!["--model=gpt-5.5".to_string()]);
    }
}
