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
    relaycast::configure_relaycast_mcp_with_result,
    supervisor::Supervisor,
    types::AgentResultMcpConfig,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::mpsc,
    time::timeout,
};

use crate::{
    cli::command_parse::{normalize_cli_name, parse_cli_command},
    routing,
    runtime::headless_provider_cli_name,
    spawner::terminate_child,
};

const APP_SERVER_AUTH_ENV_KEYS: [&str; 4] = [
    "AGENT_RELAY_APP_SERVER_AUTH_TYPE",
    "AGENT_RELAY_APP_SERVER_AUTH_TOKEN",
    "AGENT_RELAY_APP_SERVER_AUTH_USERNAME",
    "AGENT_RELAY_APP_SERVER_AUTH_PASSWORD",
];
const RELAY_AGENT_CHILD_ENV_KEYS: [&str; 4] = [
    "RELAY_AGENT_NAME",
    "RELAY_AGENT_TOKEN",
    "RELAY_AGENT_TYPE",
    "RELAY_STRICT_AGENT_NAME",
];
const DEFAULT_RELEASE_GRACE: Duration = Duration::from_secs(2);
const APP_SERVER_RELEASE_GRACE: Duration = Duration::from_secs(35);

pub(crate) mod detection;

#[derive(Debug)]
pub(crate) struct WorkerHandle {
    pub(crate) spec: AgentSpec,
    pub(crate) parent: Option<String>,
    pub(crate) workspace_id: Option<crate::ids::WorkspaceId>,
    pub(crate) child: Child,
    pub(crate) stdin: ChildStdin,
    pub(crate) harness_pid: Option<u32>,
    pub(crate) spawned_at: Instant,
    pub(crate) last_activity_at: Instant,
    pub(crate) context_budget_pct: Option<u8>,
    pub(crate) state: AgentWorkState,
    pub(crate) exit_reason: Option<String>,
}

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
    Message { name: WorkerName, value: Value },
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

    pub(crate) fn list(&self) -> Vec<Value> {
        self.workers
            .iter()
            .map(|(name, handle)| {
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
        // relaycast MCP server (messaging/channel/etc. tools) injected, e.g. to
        // save tokens. We honor that even when `agent_result` is configured —
        // `AGENT_RELAY_RESULT_*` env vars are still set on the worker process
        // below, so a separately-configured relaycast MCP can pick them up.
        if skip_relay_prompt {
            return Ok(Vec::new());
        }
        configure_relaycast_mcp_with_result(
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

    pub(crate) fn worker_pid(&self, name: &str) -> Option<u32> {
        self.workers.get(name).and_then(|h| h.child.id())
    }

    pub(crate) fn harness_pid(&self, name: &str) -> Option<u32> {
        self.workers.get(name).and_then(|h| h.harness_pid)
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
                if spec.session_id.is_none() {
                    if is_claude {
                        spec.session_id = prepare_claude_session_args(&mut effective_args);
                    } else if is_codex {
                        match codex_session_reference(&effective_args) {
                            CodexSessionReference::Known(thread_id) => {
                                spec.session_id = Some(thread_id);
                            }
                            CodexSessionReference::Unknown => {}
                            CodexSessionReference::None => {
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

                let has_extra = bypass_flag.is_some()
                    || model_flag.is_some()
                    || !effective_args.is_empty()
                    || !mcp_args.is_empty()
                    || !harness_session_args.is_empty();
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
                    for arg in &harness_session_args {
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
                    if spec.session_id.is_none() {
                        if is_claude {
                            spec.session_id = prepare_claude_session_args(&mut effective_args);
                        } else if is_codex {
                            match codex_session_reference(&effective_args) {
                                CodexSessionReference::Known(thread_id) => {
                                    spec.session_id = Some(thread_id);
                                }
                                CodexSessionReference::Unknown => {}
                                CodexSessionReference::None => {
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

                    let has_extra = bypass_flag.is_some()
                        || model_flag.is_some()
                        || !effective_args.is_empty()
                        || !mcp_args.is_empty()
                        || !harness_session_args.is_empty();
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
                        for arg in &harness_session_args {
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
        for (key, value) in &harness_env {
            command.env(key, value);
        }
        if let Some(config) = &agent_result {
            for (key, value) in config.env_pairs() {
                command.env(key, value);
            }
        }
        if matches!(spec.runtime, AgentRuntime::Pty) {
            apply_pty_relay_agent_env(
                &mut command,
                &spec.name,
                worker_relay_api_key.as_deref(),
                skip_relay_prompt,
            );
        }
        // Remove CLAUDECODE from child env to prevent nested Claude Code instances
        // from interfering with the parent's session management
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
            harness_pid: initial_harness_pid,
            spawned_at: Instant::now(),
            last_activity_at: Instant::now(),
            context_budget_pct: None,
            state: AgentWorkState::Working,
            exit_reason: None,
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

        Ok(spec)
    }

    pub(crate) async fn send_to_worker(
        &mut self,
        name: &str,
        msg_type: &str,
        request_id: Option<RequestId>,
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
        let encoded = serde_json::to_string(&shutdown_frame)?;
        let _ = handle.stdin.write_all(encoded.as_bytes()).await;
        let _ = handle.stdin.write_all(b"\n").await;
        let _ = handle.stdin.flush().await;

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

    pub(crate) async fn reap_exited(
        &mut self,
    ) -> Result<Vec<(WorkerName, Option<i32>, Option<String>, Option<String>)>> {
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
                                    // Safety: kill(pid, 0) is a POSIX-safe probe that checks
                                    // process existence without sending a signal. ESRCH means
                                    // the process no longer exists.
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
            if let Some(status) = status {
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
                exited.push((name, code, signal, reason));
            } else if gone_via_kill0 {
                let reason = self
                    .workers
                    .get(&name)
                    .and_then(|handle| handle.exit_reason.clone());
                self.workers.remove(&name);
                self.initial_tasks.remove(&name);
                exited.push((name, None, None, reason));
            }
        }
        Ok(exited)
    }

    pub(crate) fn routing_workers(&self) -> Vec<routing::RoutingWorker<'_>> {
        self.workers
            .iter()
            .map(|(name, handle)| routing::RoutingWorker {
                name,
                channels: &handle.spec.channels,
                workspace_id: handle.workspace_id.as_deref(),
            })
            .collect()
    }

    pub(crate) fn worker_names_for_channel_delivery(
        &self,
        channel: &str,
        from: &str,
        workspace_id: Option<&str>,
    ) -> Vec<String> {
        let workers = self.routing_workers();
        routing::worker_names_for_channel_delivery(&workers, channel, from, workspace_id)
    }

    pub(crate) fn worker_names_for_direct_target(
        &self,
        target: &str,
        from: &str,
        workspace_id: Option<&str>,
    ) -> Vec<String> {
        let workers = self.routing_workers();
        routing::worker_names_for_direct_target(&workers, target, from, workspace_id)
    }

    pub(crate) fn has_any_worker(&self) -> bool {
        !self.workers.is_empty()
    }

    pub(crate) fn has_worker_by_name_ignoring_case(&self, target: &str) -> bool {
        let trimmed = target.trim();
        self.workers.iter().any(|(worker_name, _)| {
            trimmed.eq_ignore_ascii_case(worker_name)
                || trimmed.eq_ignore_ascii_case(&format!("@{}", worker_name))
        })
    }
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
        _ => DEFAULT_RELEASE_GRACE,
    }
}

fn pty_relay_agent_env_overrides(
    agent_name: &str,
    worker_relay_api_key: Option<&str>,
    skip_relay_prompt: bool,
) -> Vec<(&'static str, Option<String>)> {
    let token = if skip_relay_prompt {
        None
    } else {
        worker_relay_api_key.map(str::to_string)
    };
    let agent_type = (!skip_relay_prompt).then(|| "agent".to_string());
    let strict_name = (!skip_relay_prompt).then(|| "1".to_string());

    vec![
        ("RELAY_AGENT_NAME", Some(agent_name.to_string())),
        ("RELAY_AGENT_TOKEN", token),
        ("RELAY_AGENT_TYPE", agent_type),
        ("RELAY_STRICT_AGENT_NAME", strict_name),
    ]
}

fn apply_pty_relay_agent_env(
    command: &mut Command,
    agent_name: &str,
    worker_relay_api_key: Option<&str>,
    skip_relay_prompt: bool,
) {
    // Command inherits the broker process env by default, so unset every
    // relay-agent key before applying the PTY child contract. Skipped prompt
    // injection still exposes the assigned name for wrapper launchers, but not
    // the broker-injected MCP registration env.
    for key in RELAY_AGENT_CHILD_ENV_KEYS {
        command.env_remove(key);
    }
    let overrides =
        pty_relay_agent_env_overrides(agent_name, worker_relay_api_key, skip_relay_prompt);
    for (key, value) in overrides {
        if let Some(value) = value {
            command.env(key, value);
        }
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
    Known(String),
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
        if codex_flag_consumes_next_arg(arg) {
            if args.get(index + 1).is_none() {
                return CodexSessionReference::Unknown;
            }
            skip_next = true;
            index += 1;
            continue;
        }
        if arg == "resume" || arg == "fork" {
            let Some(next) = args.get(index + 1).map(String::as_str) else {
                return CodexSessionReference::Unknown;
            };
            if next == "--last" || next.starts_with('-') {
                return CodexSessionReference::Unknown;
            }
            return CodexSessionReference::Known(next.to_string());
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
            | "--config"
            | "-c"
            | "--sandbox"
            | "-s"
            | "--ask-for-approval"
            | "--approval-policy"
            | "--cd"
            | "--cwd"
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
        Some(true) => None,
        Some(false) | None => Some(GPT_5_5_FALLBACK),
    }
}

async fn codex_debug_models_contains_model(resolved_cli: &str, model: &str) -> Option<bool> {
    let output = timeout(
        Duration::from_millis(1_500),
        Command::new(resolved_cli)
            .arg("debug")
            .arg("models")
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    codex_models_json_contains_model(&output.stdout, model)
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
        assert!(!reg.has_any_worker());
        assert!(reg.list().is_empty());
    }

    #[test]
    fn has_worker_returns_false_for_unknown() {
        let reg = make_registry(vec![]);
        assert!(!reg.has_worker("nonexistent"));
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
    fn pty_relay_env_exposes_name_when_prompt_injection_is_skipped() {
        let overrides: HashMap<_, _> =
            pty_relay_agent_env_overrides("LauncherWorker", Some("tok_worker"), true)
                .into_iter()
                .collect();

        assert_eq!(
            overrides.get("RELAY_AGENT_NAME").and_then(|v| v.as_deref()),
            Some("LauncherWorker")
        );
        assert_eq!(overrides.get("RELAY_AGENT_TOKEN"), Some(&None));
        assert_eq!(overrides.get("RELAY_AGENT_TYPE"), Some(&None));
        assert_eq!(overrides.get("RELAY_STRICT_AGENT_NAME"), Some(&None));
    }

    #[test]
    fn pty_relay_env_includes_registration_vars_when_injecting_prompt() {
        let overrides: HashMap<_, _> =
            pty_relay_agent_env_overrides("RelayWorker", Some("tok_worker"), false)
                .into_iter()
                .collect();

        assert_eq!(
            overrides.get("RELAY_AGENT_NAME").and_then(|v| v.as_deref()),
            Some("RelayWorker")
        );
        assert_eq!(
            overrides
                .get("RELAY_AGENT_TOKEN")
                .and_then(|v| v.as_deref()),
            Some("tok_worker")
        );
        assert_eq!(
            overrides.get("RELAY_AGENT_TYPE").and_then(|v| v.as_deref()),
            Some("agent")
        );
        assert_eq!(
            overrides
                .get("RELAY_STRICT_AGENT_NAME")
                .and_then(|v| v.as_deref()),
            Some("1")
        );
    }

    #[tokio::test]
    async fn pty_relay_env_removes_existing_registration_vars_when_prompt_injection_is_skipped() {
        let mut command = Command::new("env");
        command.env("RELAY_AGENT_NAME", "InheritedName");
        command.env("RELAY_AGENT_TOKEN", "inherited-token");
        command.env("RELAY_AGENT_TYPE", "human");
        command.env("RELAY_STRICT_AGENT_NAME", "1");

        apply_pty_relay_agent_env(&mut command, "LauncherWorker", Some("tok_worker"), true);

        let output = command.output().await.expect("env command should run");
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).expect("env output should be utf-8");
        let env: HashMap<_, _> = stdout
            .lines()
            .filter_map(|line| line.split_once('='))
            .collect();

        assert_eq!(env.get("RELAY_AGENT_NAME"), Some(&"LauncherWorker"));
        assert!(!env.contains_key("RELAY_AGENT_TOKEN"));
        assert!(!env.contains_key("RELAY_AGENT_TYPE"));
        assert!(!env.contains_key("RELAY_STRICT_AGENT_NAME"));
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
    fn routing_workers_empty_when_no_workers() {
        let reg = make_registry(vec![]);
        assert!(reg.routing_workers().is_empty());
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
    fn codex_session_reference_detects_resume_and_fork_ids() {
        assert_eq!(
            codex_session_reference(&[
                "--model".into(),
                "gpt-5.4".into(),
                "resume".into(),
                "thread-1".into()
            ]),
            CodexSessionReference::Known("thread-1".to_string())
        );
        assert_eq!(
            codex_session_reference(&["fork".into(), "thread-2".into()]),
            CodexSessionReference::Known("thread-2".to_string())
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
