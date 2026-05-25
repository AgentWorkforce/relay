#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use crate::{
    metrics::MetricsCollector,
    protocol::{
        AgentRuntime, AgentSpec, HarnessDefinition, ProtocolEnvelope, RelayDelivery,
        PROTOCOL_VERSION,
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

pub(crate) mod detection;

#[derive(Debug)]
pub(crate) struct WorkerHandle {
    pub(crate) spec: AgentSpec,
    pub(crate) parent: Option<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) child: Child,
    pub(crate) stdin: ChildStdin,
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
    Message { name: String, value: Value },
}

pub(crate) struct WorkerRegistry {
    pub(crate) workers: HashMap<String, WorkerHandle>,
    event_tx: mpsc::Sender<WorkerEvent>,
    worker_env: Vec<(String, String)>,
    worker_logs_dir: PathBuf,
    pub(crate) initial_tasks: HashMap<String, String>,
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
                    "pid": handle.child.id(),
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

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn spawn(
        &mut self,
        spec: AgentSpec,
        parent: Option<String>,
        idle_threshold_secs: Option<u64>,
        worker_relay_api_key: Option<String>,
        skip_relay_prompt: bool,
        workspace_id: Option<String>,
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

        match spec.runtime {
            AgentRuntime::Pty => {
                let cli = spec.cli.as_deref().context("pty runtime requires `cli`")?;
                let (parsed_cli, inline_cli_args) = parse_cli_command(cli)
                    .with_context(|| format!("invalid CLI command '{cli}'"))?;
                let harness = resolve_harness_definition(&parsed_cli, spec.harness.clone());
                spec.harness = harness.clone();
                let resolved_cli = resolve_harness_command(&parsed_cli, harness.as_ref());
                let adapter_cli = harness_adapter_key(&resolved_cli, harness.as_ref());
                let mut effective_args = inline_cli_args;
                effective_args.extend(spec.args.clone());

                command.arg("pty");
                command.arg("--agent-name").arg(&spec.name);
                if let Some(secs) = idle_threshold_secs {
                    command.arg("--idle-threshold-secs").arg(secs.to_string());
                }
                command.arg(&resolved_cli);

                let cli_lower = adapter_cli.to_lowercase();
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
                                let thread_id =
                                    crate::codex_session::create_resumable_codex_thread(
                                        &resolved_cli,
                                        cwd,
                                        &self.worker_env,
                                    )
                                    .await
                                    .with_context(|| {
                                        format!(
                                            "failed to create resumable Codex session for '{}'",
                                            spec.name
                                        )
                                    })?;
                                tracing::info!(
                                    worker = %spec.name,
                                    session_id = %thread_id,
                                    "created resumable Codex session for spawned PTY"
                                );
                                spec.session_id = Some(thread_id.clone());
                                harness_session_args.push("resume".to_string());
                                harness_session_args.push(thread_id);
                            }
                        }
                    }
                }
                // NOTE: Permission-bypass flags are auto-injected for all spawned agents.
                // This means any actor who can trigger agent.add gets agents with no permission
                // guardrails. Future work should make this an explicit opt-in per step/agent.
                let bypass_flag: Option<String> = harness
                    .as_ref()
                    .and_then(|definition| harness_bypass_flag(definition, &effective_args))
                    .or_else(|| {
                        if is_claude
                            && !effective_args
                                .iter()
                                .any(|a| a.contains("dangerously-skip-permissions"))
                        {
                            Some("--dangerously-skip-permissions".to_string())
                        } else if is_codex
                            && !effective_args.iter().any(|a| {
                                a.contains("dangerously-bypass") || a.contains("full-auto")
                            })
                        {
                            Some("--dangerously-bypass-approvals-and-sandbox".to_string())
                        } else if is_gemini
                            && !effective_args.iter().any(|a| a == "--yolo" || a == "-y")
                        {
                            Some("--yolo".to_string())
                        } else {
                            None
                        }
                    });

                if let Some(flag) = bypass_flag.as_deref() {
                    tracing::warn!(
                        worker = %spec.name,
                        flag = %flag,
                        "auto-injecting permission-bypass flag for spawned agent"
                    );
                }

                let mcp_args = self
                    .build_mcp_args(
                        &adapter_cli,
                        &spec.name,
                        &effective_args,
                        Path::new(spec.cwd.as_deref().unwrap_or(".")),
                        worker_relay_api_key.as_deref(),
                        skip_relay_prompt,
                        agent_result.as_ref(),
                    )
                    .await?;

                let model_args = if let Some(definition) = harness.as_ref() {
                    match resolve_harness_model_args(
                        definition,
                        &resolved_cli,
                        &cli_lower,
                        &spec.name,
                        spec.model.as_deref(),
                        &effective_args,
                    )
                    .await
                    {
                        Some((model, args)) => {
                            spec.model = Some(model);
                            args
                        }
                        None => Vec::new(),
                    }
                } else {
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
                    model_flag
                        .map(|model| vec!["--model".to_string(), model])
                        .unwrap_or_default()
                };

                let extra_args = if let Some(definition) = harness.as_ref() {
                    render_harness_interactive_args(
                        definition,
                        bypass_flag.as_deref(),
                        spec.model.as_deref(),
                        &model_args,
                        &mcp_args,
                        &effective_args,
                        &harness_session_args,
                    )
                } else {
                    let mut args = Vec::new();
                    if let Some(flag) = bypass_flag {
                        args.push(flag);
                    }
                    args.extend(model_args);
                    args.extend(mcp_args);
                    args.extend(effective_args);
                    args.extend(harness_session_args);
                    args
                };

                let has_extra = !extra_args.is_empty();
                if has_extra {
                    command.arg("--");
                    for arg in &extra_args {
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
        }

        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &self.worker_env {
            command.env(key, value);
        }
        if let Some(config) = &agent_result {
            for (key, value) in config.env_pairs() {
                command.env(key, value);
            }
        }
        if !skip_relay_prompt && !matches!(spec.runtime, AgentRuntime::Headless) {
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

    pub(crate) async fn shutdown_all(&mut self) -> Result<()> {
        let names: Vec<String> = self.workers.keys().cloned().collect();
        for name in names {
            if let Err(error) = self.release(&name).await {
                tracing::warn!(target = "agent_relay::broker", name = %name, error = %error, "worker shutdown failed");
            }
        }
        Ok(())
    }

    pub(crate) async fn reap_exited(
        &mut self,
    ) -> Result<Vec<(String, Option<i32>, Option<String>, Option<String>)>> {
        let names: Vec<String> = self.workers.keys().cloned().collect();
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

fn canonicalize_display(path: &Path) -> String {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|resolved| resolved.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn expand_home_path(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn fallback_path_env() -> OsString {
    #[cfg(unix)]
    {
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/root"));
        OsString::from(format!(
            "{home}/.local/bin:{home}/.opencode/bin:{home}/.claude/local:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
        ))
    }
    #[cfg(windows)]
    {
        OsString::from(r"C:\Windows\System32;C:\Windows")
    }
}

fn harness_name_key(cli: &str) -> String {
    normalize_cli_name(cli)
        .split(':')
        .next()
        .unwrap_or(cli)
        .to_lowercase()
}

fn builtin_harness_definition(adapter: &str) -> Option<HarnessDefinition> {
    let key = harness_name_key(adapter);
    let mut definition = HarnessDefinition {
        adapter: Some(key.clone()),
        ..Default::default()
    };

    match key.as_str() {
        "claude" => {
            definition.binary = Some("claude".to_string());
            definition.non_interactive_args = vec![
                "-p".to_string(),
                "{bypass}".to_string(),
                "{task}".to_string(),
                "{args}".to_string(),
            ];
            definition.bypass_flag = Some("--dangerously-skip-permissions".to_string());
            definition.search_paths = vec!["~/.claude/local".to_string()];
            Some(definition)
        }
        "codex" => {
            definition.binary = Some("codex".to_string());
            definition.non_interactive_args = vec![
                "exec".to_string(),
                "{bypass}".to_string(),
                "{task}".to_string(),
                "{args}".to_string(),
            ];
            definition.bypass_flag = Some("--dangerously-bypass-approvals-and-sandbox".to_string());
            definition.bypass_aliases = vec!["--full-auto".to_string()];
            definition.search_paths = vec!["~/.local/bin".to_string()];
            Some(definition)
        }
        "gemini" => {
            definition.binary = Some("gemini".to_string());
            definition.non_interactive_args =
                vec!["-p".to_string(), "{task}".to_string(), "{args}".to_string()];
            definition.bypass_flag = Some("--yolo".to_string());
            definition.bypass_aliases = vec!["-y".to_string()];
            Some(definition)
        }
        "opencode" => {
            definition.binary = Some("opencode".to_string());
            definition.non_interactive_args = vec![
                "run".to_string(),
                "{task}".to_string(),
                "{args}".to_string(),
            ];
            definition.search_paths = vec!["~/.opencode/bin".to_string()];
            definition.ignore_exit_code = true;
            Some(definition)
        }
        "droid" => {
            definition.binary = Some("droid".to_string());
            definition.non_interactive_args = vec![
                "exec".to_string(),
                "{task}".to_string(),
                "{args}".to_string(),
            ];
            Some(definition)
        }
        "aider" => {
            definition.binary = Some("aider".to_string());
            definition.non_interactive_args = vec![
                "--message".to_string(),
                "{task}".to_string(),
                "--yes-always".to_string(),
                "--no-git".to_string(),
                "{args}".to_string(),
            ];
            Some(definition)
        }
        "goose" => {
            definition.binary = Some("goose".to_string());
            definition.non_interactive_args = vec![
                "run".to_string(),
                "--text".to_string(),
                "{task}".to_string(),
                "--no-session".to_string(),
                "{args}".to_string(),
            ];
            Some(definition)
        }
        "cursor" => {
            definition.adapter = Some("cursor".to_string());
            definition.binaries = vec!["cursor-agent".to_string(), "agent".to_string()];
            definition.non_interactive_args = vec![
                "--force".to_string(),
                "-p".to_string(),
                "{task}".to_string(),
                "{args}".to_string(),
            ];
            Some(definition)
        }
        "cursor-agent" | "agent" => {
            definition.adapter = Some("cursor".to_string());
            definition.binary = Some(key.clone());
            definition.non_interactive_args = vec![
                "--force".to_string(),
                "-p".to_string(),
                "{task}".to_string(),
                "{args}".to_string(),
            ];
            Some(definition)
        }
        _ => None,
    }
}

fn merge_harness_definitions(
    base: HarnessDefinition,
    override_definition: HarnessDefinition,
) -> HarnessDefinition {
    let override_binary = override_definition.binary.and_then(|binary| {
        if binary.trim().is_empty() {
            None
        } else {
            Some(binary)
        }
    });
    let overrides_binary = override_binary.is_some();
    HarnessDefinition {
        adapter: override_definition.adapter.or(base.adapter),
        binary: override_binary.or(base.binary),
        binaries: if override_definition.binaries.is_empty() {
            if overrides_binary {
                Vec::new()
            } else {
                base.binaries
            }
        } else {
            override_definition.binaries
        },
        interactive_args: if override_definition.interactive_args.is_empty() {
            base.interactive_args
        } else {
            override_definition.interactive_args
        },
        non_interactive_args: if override_definition.non_interactive_args.is_empty() {
            base.non_interactive_args
        } else {
            override_definition.non_interactive_args
        },
        model_args: if override_definition.model_args.is_empty() {
            base.model_args
        } else {
            override_definition.model_args
        },
        bypass_flag: override_definition.bypass_flag.or(base.bypass_flag),
        bypass_aliases: if override_definition.bypass_aliases.is_empty() {
            base.bypass_aliases
        } else {
            override_definition.bypass_aliases
        },
        search_paths: if override_definition.search_paths.is_empty() {
            base.search_paths
        } else {
            override_definition.search_paths
        },
        ignore_exit_code: override_definition.ignore_exit_code || base.ignore_exit_code,
        proxy_provider: override_definition.proxy_provider.or(base.proxy_provider),
        aliases: if override_definition.aliases.is_empty() {
            base.aliases
        } else {
            override_definition.aliases
        },
    }
}

fn resolve_harness_definition(
    cli_name: &str,
    provided: Option<HarnessDefinition>,
) -> Option<HarnessDefinition> {
    let default_adapter = harness_name_key(cli_name);
    let mut definition = if let Some(provided) = provided {
        let adapter_key = provided
            .adapter
            .as_deref()
            .map(str::trim)
            .filter(|adapter| !adapter.is_empty())
            .map(harness_name_key)
            .unwrap_or_else(|| default_adapter.clone());
        if let Some(base) = builtin_harness_definition(&adapter_key) {
            merge_harness_definitions(base, provided)
        } else {
            provided
        }
    } else {
        builtin_harness_definition(&default_adapter)?
    };
    if definition
        .adapter
        .as_deref()
        .map(str::trim)
        .filter(|adapter| !adapter.is_empty())
        .is_none()
    {
        definition.adapter = Some(default_adapter);
    }
    Some(definition)
}

fn harness_adapter_key(resolved_cli: &str, harness: Option<&HarnessDefinition>) -> String {
    harness
        .and_then(|definition| definition.adapter.as_deref())
        .map(str::trim)
        .filter(|adapter| !adapter.is_empty())
        .map(harness_name_key)
        .unwrap_or_else(|| harness_name_key(resolved_cli))
}

fn resolve_command_with_paths(command: &str, search_paths: &[String]) -> String {
    if command.contains('/') || command.contains('\\') || command.starts_with('.') {
        let candidate = expand_home_path(command);
        if is_executable_file(&candidate) {
            return canonicalize_display(&candidate);
        }
        return command.to_string();
    }

    for dir in search_paths {
        let candidate = expand_home_path(dir).join(command);
        if is_executable_file(&candidate) {
            return canonicalize_display(&candidate);
        }
    }

    let path_env = env::var_os("PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(fallback_path_env);
    for dir in env::split_paths(&path_env) {
        let candidate = dir.join(command);
        if is_executable_file(&candidate) {
            return canonicalize_display(&candidate);
        }
    }

    command.to_string()
}

fn resolve_harness_command(default_command: &str, harness: Option<&HarnessDefinition>) -> String {
    let Some(harness) = harness else {
        return default_command.to_string();
    };

    let candidates: Vec<&str> = if harness.binaries.is_empty() {
        harness
            .binary
            .as_deref()
            .map(|binary| vec![binary])
            .unwrap_or_else(|| vec![default_command])
    } else {
        harness.binaries.iter().map(String::as_str).collect()
    };

    for candidate in candidates.iter().copied() {
        let resolved = resolve_command_with_paths(candidate, &harness.search_paths);
        if resolved != candidate || is_executable_file(Path::new(&resolved)) {
            return resolved;
        }
    }

    candidates
        .first()
        .copied()
        .unwrap_or(default_command)
        .to_string()
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn arg_matches_flag(arg: &str, flag: &str) -> bool {
    arg == flag
        || arg
            .strip_prefix(flag)
            .is_some_and(|rest| rest.starts_with('='))
}

fn harness_bypass_flag(harness: &HarnessDefinition, existing_args: &[String]) -> Option<String> {
    let flag = harness.bypass_flag.as_deref()?.trim();
    if flag.is_empty() {
        return None;
    }

    let mut flags = vec![flag];
    flags.extend(
        harness
            .bypass_aliases
            .iter()
            .map(String::as_str)
            .map(str::trim)
            .filter(|alias| !alias.is_empty()),
    );
    if existing_args.iter().any(|arg| {
        flags
            .iter()
            .any(|candidate| arg_matches_flag(arg, candidate))
    }) {
        return None;
    }

    Some(flag.to_string())
}

fn is_exact_placeholder(value: &str, name: &str) -> bool {
    value == format!("{{{name}}}") || value == format!("{{{{{name}}}}}")
}

fn replace_scalar_placeholders(
    template: &str,
    bypass: Option<&str>,
    model: Option<&str>,
) -> String {
    template
        .replace("{{bypass}}", bypass.unwrap_or(""))
        .replace("{bypass}", bypass.unwrap_or(""))
        .replace("{{model}}", model.unwrap_or(""))
        .replace("{model}", model.unwrap_or(""))
}

fn render_harness_arg_template(
    template: &[String],
    bypass: Option<&str>,
    model: Option<&str>,
    model_args: &[String],
    mcp_args: &[String],
    args: &[String],
    session_args: &[String],
) -> Vec<String> {
    let mut rendered = Vec::new();
    for entry in template {
        if is_exact_placeholder(entry, "args") {
            rendered.extend(args.iter().cloned());
            continue;
        }
        if is_exact_placeholder(entry, "modelArgs") {
            rendered.extend(model_args.iter().cloned());
            continue;
        }
        if is_exact_placeholder(entry, "mcpArgs") {
            rendered.extend(mcp_args.iter().cloned());
            continue;
        }
        if is_exact_placeholder(entry, "sessionArgs") {
            rendered.extend(session_args.iter().cloned());
            continue;
        }
        if is_exact_placeholder(entry, "bypass") {
            if let Some(flag) = bypass {
                rendered.push(flag.to_string());
            }
            continue;
        }
        if is_exact_placeholder(entry, "model") {
            if let Some(model) = model {
                rendered.push(model.to_string());
            }
            continue;
        }

        rendered.push(replace_scalar_placeholders(entry, bypass, model));
    }
    rendered
}

fn render_harness_interactive_args(
    harness: &HarnessDefinition,
    bypass: Option<&str>,
    model: Option<&str>,
    model_args: &[String],
    mcp_args: &[String],
    args: &[String],
    session_args: &[String],
) -> Vec<String> {
    let default_template;
    let template = if harness.interactive_args.is_empty() {
        default_template = vec![
            "{bypass}".to_string(),
            "{modelArgs}".to_string(),
            "{mcpArgs}".to_string(),
            "{args}".to_string(),
            "{sessionArgs}".to_string(),
        ];
        &default_template
    } else {
        &harness.interactive_args
    };

    render_harness_arg_template(
        template,
        bypass,
        model,
        model_args,
        mcp_args,
        args,
        session_args,
    )
}

fn render_harness_model_args(harness: &HarnessDefinition, model: &str) -> Vec<String> {
    let default_template;
    let template = if harness.model_args.is_empty() {
        default_template = vec!["--model".to_string(), "{model}".to_string()];
        &default_template
    } else {
        &harness.model_args
    };

    render_harness_arg_template(template, None, Some(model), &[], &[], &[], &[])
}

fn model_arg_markers(harness: &HarnessDefinition) -> Vec<String> {
    let default_template;
    let template = if harness.model_args.is_empty() {
        default_template = vec!["--model".to_string(), "{model}".to_string()];
        &default_template
    } else {
        &harness.model_args
    };

    let mut markers = Vec::new();
    for (index, entry) in template.iter().enumerate() {
        if is_exact_placeholder(entry, "model") {
            if let Some(previous) = index.checked_sub(1).and_then(|i| template.get(i)) {
                if previous.starts_with('-') {
                    markers.push(previous.clone());
                }
            }
            continue;
        }

        let model_token = entry.find("{model}").or_else(|| entry.find("{{model}}"));
        if let Some(pos) = model_token {
            let marker = entry[..pos].trim_end_matches('=');
            if marker.starts_with('-') && !marker.is_empty() {
                markers.push(marker.to_string());
            }
        }
    }
    markers.sort();
    markers.dedup();
    markers
}

fn harness_model_override_present(harness: &HarnessDefinition, existing_args: &[String]) -> bool {
    let markers = model_arg_markers(harness);
    if markers.is_empty() {
        return args_include_model_override(existing_args);
    }
    existing_args.iter().any(|arg| {
        markers
            .iter()
            .any(|marker| arg_matches_flag(arg.as_str(), marker.as_str()))
    })
}

async fn resolve_harness_model_args(
    harness: &HarnessDefinition,
    resolved_cli: &str,
    normalized_cli: &str,
    worker_name: &str,
    requested_model: Option<&str>,
    existing_args: &[String],
) -> Option<(String, Vec<String>)> {
    let requested = requested_model?.trim();
    if requested.is_empty() || harness_model_override_present(harness, existing_args) {
        return None;
    }

    let model = if normalized_cli.eq_ignore_ascii_case("codex") {
        codex_local_fallback_model(resolved_cli, requested)
            .await
            .inspect(|&fallback| {
                tracing::warn!(
                    worker = %worker_name,
                    requested_model = %requested,
                    fallback_model = %fallback,
                    "local Codex CLI model catalog does not confirm requested model; using fallback"
                );
            })
            .unwrap_or(requested)
    } else {
        requested
    };

    Some((model.to_string(), render_harness_model_args(harness, model)))
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
mod harness_adapter_tests {
    use super::*;

    #[test]
    fn built_in_harnesses_resolve_as_adapter_config() {
        let harness = resolve_harness_definition("codex", None).expect("codex harness");

        assert_eq!(harness.adapter.as_deref(), Some("codex"));
        assert_eq!(harness.binary.as_deref(), Some("codex"));
        assert_eq!(
            harness.bypass_flag.as_deref(),
            Some("--dangerously-bypass-approvals-and-sandbox")
        );
        assert_eq!(harness.bypass_aliases, vec!["--full-auto".to_string()]);
    }

    #[test]
    fn custom_harness_can_select_builtin_lifecycle_adapter() {
        let harness = resolve_harness_definition(
            "company-codex",
            Some(HarnessDefinition {
                adapter: Some("codex".to_string()),
                binary: Some("company-codex".to_string()),
                ..Default::default()
            }),
        )
        .expect("custom harness");

        assert_eq!(
            harness_adapter_key("company-codex", Some(&harness)),
            "codex"
        );
        assert_eq!(
            harness.bypass_flag.as_deref(),
            Some("--dangerously-bypass-approvals-and-sandbox")
        );
    }

    #[test]
    fn binary_override_replaces_inherited_adapter_binaries() {
        let harness = resolve_harness_definition(
            "company-cursor",
            Some(HarnessDefinition {
                adapter: Some("cursor".to_string()),
                binary: Some("company-cursor".to_string()),
                ..Default::default()
            }),
        )
        .expect("custom cursor harness");

        assert_eq!(harness.binary.as_deref(), Some("company-cursor"));
        assert!(harness.binaries.is_empty());
    }

    #[test]
    fn blank_binary_override_does_not_clear_inherited_adapter_binaries() {
        let harness = resolve_harness_definition(
            "company-cursor",
            Some(HarnessDefinition {
                adapter: Some("cursor".to_string()),
                binary: Some("   ".to_string()),
                ..Default::default()
            }),
        )
        .expect("custom cursor harness");

        assert_eq!(harness.binary, None);
        assert_eq!(
            harness.binaries,
            vec!["cursor-agent".to_string(), "agent".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_harness_command_skips_non_executable_search_path_candidates() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp dir");
        let non_executable = temp.path().join("relay-non-executable");
        let executable = temp.path().join("relay-executable");
        fs::write(&non_executable, "#!/bin/sh\n").expect("write non-executable");
        fs::write(&executable, "#!/bin/sh\n").expect("write executable");
        fs::set_permissions(&non_executable, fs::Permissions::from_mode(0o644))
            .expect("chmod non-executable");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("chmod executable");

        let harness = HarnessDefinition {
            binaries: vec![
                "relay-non-executable".to_string(),
                "relay-executable".to_string(),
            ],
            search_paths: vec![temp.path().to_string_lossy().to_string()],
            ..Default::default()
        };

        assert_eq!(
            resolve_harness_command("fallback", Some(&harness)),
            canonicalize_display(&executable)
        );
    }

    #[test]
    fn harness_interactive_args_expand_vector_placeholders() {
        let harness = HarnessDefinition {
            interactive_args: vec![
                "run".to_string(),
                "{bypass}".to_string(),
                "{modelArgs}".to_string(),
                "{args}".to_string(),
                "{sessionArgs}".to_string(),
            ],
            ..Default::default()
        };

        let args = render_harness_interactive_args(
            &harness,
            Some("--yes"),
            Some("qwen3-coder"),
            &["-m".to_string(), "qwen3-coder".to_string()],
            &[],
            &["--verbose".to_string()],
            &["resume".to_string(), "session-1".to_string()],
        );

        assert_eq!(
            args,
            vec![
                "run",
                "--yes",
                "-m",
                "qwen3-coder",
                "--verbose",
                "resume",
                "session-1"
            ]
        );
    }

    #[test]
    fn harness_model_args_dedup_custom_model_flag() {
        let harness = HarnessDefinition {
            model_args: vec!["--model-id".to_string(), "{model}".to_string()],
            ..Default::default()
        };

        assert!(harness_model_override_present(
            &harness,
            &["--model-id".to_string(), "existing".to_string()]
        ));
        assert!(harness_model_override_present(
            &harness,
            &["--model-id=existing".to_string()]
        ));
        assert!(!harness_model_override_present(
            &harness,
            &["--other".to_string()]
        ));
    }

    #[test]
    fn harness_bypass_uses_aliases_for_dedup() {
        let harness = HarnessDefinition {
            bypass_flag: Some("--yes".to_string()),
            bypass_aliases: vec!["-y".to_string()],
            ..Default::default()
        };

        assert_eq!(
            harness_bypass_flag(&harness, &["--verbose".to_string()]),
            Some("--yes".to_string())
        );
        assert_eq!(harness_bypass_flag(&harness, &["-y".to_string()]), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
