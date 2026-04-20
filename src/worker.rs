use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use relay_broker::{
    metrics::MetricsCollector,
    protocol::{AgentRuntime, AgentSpec, ProtocolEnvelope, RelayDelivery, PROTOCOL_VERSION},
    snippets::configure_relaycast_mcp_with_token,
    supervisor::Supervisor,
};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::mpsc,
};

use crate::{
    headless_provider_cli_name,
    helpers::{cli_supports_flag, normalize_cli_name, parse_cli_command},
    routing,
    spawner::terminate_child,
};

#[derive(Debug)]
pub(crate) struct WorkerHandle {
    pub(crate) spec: AgentSpec,
    pub(crate) parent: Option<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) child: Child,
    pub(crate) stdin: ChildStdin,
    pub(crate) spawned_at: Instant,
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
                    "team": handle.spec.team,
                    "channels": handle.spec.channels,
                    "parent": handle.parent,
                    "pid": handle.child.id(),
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

    async fn build_mcp_args(
        &self,
        cli_name: &str,
        agent_name: &str,
        existing_args: &[String],
        cwd: &Path,
        worker_relay_api_key: Option<&str>,
        skip_relay_prompt: bool,
    ) -> Result<Vec<String>> {
        if skip_relay_prompt {
            return Ok(Vec::new());
        }
        configure_relaycast_mcp_with_token(
            cli_name,
            agent_name,
            self.env_value("RELAY_API_KEY"),
            self.env_value("RELAY_BASE_URL"),
            existing_args,
            cwd,
            worker_relay_api_key,
            self.env_value("RELAY_WORKSPACES_JSON"),
            self.env_value("RELAY_DEFAULT_WORKSPACE"),
        )
        .await
    }

    pub(crate) fn has_worker(&self, name: &str) -> bool {
        self.workers.contains_key(name)
    }

    pub(crate) fn worker_pid(&self, name: &str) -> Option<u32> {
        self.workers.get(name).and_then(|h| h.child.id())
    }

    pub(crate) async fn spawn(
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

                let cli_lower = normalized_cli.to_lowercase();
                let is_claude = cli_lower == "claude" || cli_lower.starts_with("claude:");
                let is_codex = cli_lower == "codex";
                let is_gemini = cli_lower == "gemini";
                // NOTE: Permission-bypass flags are auto-injected for all spawned agents.
                // This means any actor who can trigger agent.add gets agents with no permission
                // guardrails. Future work should make this an explicit opt-in per step/agent.
                //
                // For claude we also inject `--permission-mode bypassPermissions` on top of
                // `--dangerously-skip-permissions`. In Claude Code 2.1.x the former has proven
                // more effective at suppressing the "Do you trust the files in this folder?"
                // dialog, which otherwise renders mid-session on first filesystem tool use
                // and blocks a broker-wrapped PTY silently.
                //
                // `--permission-mode` was added to claude-code ~2.0; older installs reject
                // unknown flags and the spawn would fail. `cli_supports_flag` probes
                // `<cli> --help` once per (cli, flag) pair and caches the result, so older
                // claude installs silently skip the extra flag and keep the original
                // `--dangerously-skip-permissions`-only behavior.
                let mut extra_bypass_flags: Vec<&str> = Vec::new();
                let bypass_flag: Option<&str> = if is_claude
                    && !effective_args
                        .iter()
                        .any(|a| a.contains("dangerously-skip-permissions"))
                {
                    let user_set_permission_mode = effective_args
                        .iter()
                        .any(|a| a == "--permission-mode" || a.starts_with("--permission-mode="));
                    if !user_set_permission_mode
                        && cli_supports_flag(&resolved_cli, "--permission-mode")
                    {
                        extra_bypass_flags.extend(["--permission-mode", "bypassPermissions"]);
                    }
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
                        extra = ?extra_bypass_flags,
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
                    )
                    .await?;

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
                    for extra in &extra_bypass_flags {
                        command.arg(extra);
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
                let provider_cli = headless_provider_cli_name(provider);
                command.arg(provider_cli);

                let mcp_args = self
                    .build_mcp_args(
                        provider_cli,
                        &spec.name,
                        &spec.args,
                        Path::new(spec.cwd.as_deref().unwrap_or(".")),
                        worker_relay_api_key.as_deref(),
                        skip_relay_prompt,
                    )
                    .await?;

                let model_arg =
                    spec.model.as_deref().and_then(|model| {
                        if spec.args.iter().any(|arg| {
                            arg == "--model" || arg.starts_with("--model=") || arg == "-m"
                        }) {
                            None
                        } else {
                            Some(model.to_string())
                        }
                    });

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
    ) -> Result<Vec<(String, Option<i32>, Option<String>)>> {
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
                self.workers.remove(&name);
                self.initial_tasks.remove(&name);
                exited.push((name, code, signal));
            } else if gone_via_kill0 {
                self.workers.remove(&name);
                self.initial_tasks.remove(&name);
                exited.push((name, None, None));
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
