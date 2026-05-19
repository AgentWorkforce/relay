use super::*;

pub(crate) async fn run_init(cmd: InitCommand, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let startup_debug = startup_debug_enabled();
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
    let custom_state_dir = cmd.state_dir.as_ref().map(PathBuf::from);
    log_startup_phase(
        startup_debug,
        broker_start,
        format!(
            "run_init begin name='{}' cwd='{}' persist={} channels='{}'",
            resolved_name,
            runtime_cwd.display(),
            cmd.persist,
            cmd.channels
        ),
    );
    let paths = if cmd.persist || custom_state_dir.is_some() {
        ensure_runtime_paths(&runtime_cwd, &resolved_name, custom_state_dir.as_deref())?
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
    log_startup_phase(
        startup_debug,
        broker_start,
        format!("runtime paths ready state='{}'", paths.state.display()),
    );
    let mut state = if cmd.persist || custom_state_dir.is_some() {
        broker::BrokerState::load(&paths.state).unwrap_or_default()
    } else {
        broker::BrokerState::default()
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

    // HTTP/WS API — always started. This is the primary transport for SDK
    // consumers, dashboards, and remote clients. When no explicit API key
    // is configured, generate a random one so control endpoints are always
    // authenticated (the key is written to the runtime metadata file for
    // SDK discovery).
    let api_key = std::env::var("RELAY_BROKER_API_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("br_{}", Uuid::new_v4().simple()));

    // Set the env var so listen_api's configured_broker_api_key() picks it up.
    std::env::set_var("RELAY_BROKER_API_KEY", &api_key);

    let relay_ready = Arc::new(Notify::new());
    let relay_ready_state: Arc<RwLock<Option<RelayReadyState>>> = Arc::new(RwLock::new(None));
    let (api_tx, mut api_rx) = mpsc::channel::<ListenApiRequest>(32);
    let bind_addr = format!("{}:{}", cmd.api_bind, cmd.api_port);
    log_startup_phase(
        startup_debug,
        broker_start,
        format!("binding API listener on {}", bind_addr),
    );
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("failed to bind API on {}", bind_addr))?;
    let actual_port = listener.local_addr()?.port();
    log_startup_phase(
        startup_debug,
        broker_start,
        format!("API listener bound on {}:{}", cmd.api_bind, actual_port),
    );
    // Machine-readable on stdout (SDK parses this to discover the port).
    // Diagnostic logs stay on stderr via tracing/eprintln.
    println!(
        "[agent-relay] API listening on http://{}:{}",
        cmd.api_bind, actual_port
    );

    // Write connection file so CLI commands can find this broker.
    let connection_dir = paths.state.parent().unwrap();
    let connection_path = connection_dir.join("connection.json");
    let connection = json!({
        "url": format!("http://{}:{}", cmd.api_bind, actual_port),
        "port": actual_port,
        "api_key": &api_key,
        "pid": std::process::id(),
    });
    if let Ok(json_str) = serde_json::to_string_pretty(&connection) {
        if let Ok(mut tmp) = tempfile::NamedTempFile::new_in(connection_dir) {
            use std::io::Write;
            if tmp.write_all(json_str.as_bytes()).is_ok() {
                let _ = tmp.persist(&connection_path);
                tracing::info!(path = %connection_path.display(), "wrote connection file");
            }
        }
    }

    let (startup_listener_tx, startup_listener_rx) =
        tokio::sync::oneshot::channel::<tokio::net::TcpListener>();
    let relay_ready_for_startup = relay_ready.clone();
    tokio::spawn(async move {
        let listener = serve_startup_api_until_ready(listener, relay_ready_for_startup).await;
        let _ = startup_listener_tx.send(listener);
    });

    log_startup_phase(startup_debug, broker_start, "calling connect_relay");
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
    log_startup_phase(startup_debug, broker_start, "connect_relay completed");

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

    // Broadcast channel for streaming dashboard-relevant events to WS clients.
    // Created before publishing the ready router so replay and WS endpoints are
    // available as soon as Relaycast workspace data is known.
    let (events_tx, _events_rx) = broadcast::channel::<String>(512);
    let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);

    let ready_router = listen_api_router(ListenApiConfig {
        tx: api_tx.clone(),
        events_tx: events_tx.clone(),
        replay_buffer: replay_buffer.clone(),
        workspace_key: Some(relay_workspace_key.clone()),
        memberships: workspace_memberships.clone(),
        default_workspace_id: default_workspace_id.clone(),
        persist: cmd.persist,
    });
    {
        let mut ready = relay_ready_state.write().await;
        *ready = Some(RelayReadyState {
            workspace_key: relay_workspace_key.clone(),
            memberships: workspace_memberships.clone(),
            default_workspace_id: default_workspace_id.clone(),
        });
    }
    if let Some(ready) = relay_ready_state.read().await.as_ref() {
        log_startup_phase(
            startup_debug,
            broker_start,
            format!(
                "relay ready workspace_key_set={} memberships={} default_workspace={:?}",
                !ready.workspace_key.is_empty(),
                ready.memberships.len(),
                ready.default_workspace_id
            ),
        );
    }
    relay_ready.notify_one();
    let listener = startup_listener_rx
        .await
        .context("startup API listener task stopped before Relaycast readiness handoff")?;
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, ready_router).await {
            tracing::error!(error = %e, "HTTP API server error");
        }
    });

    log_startup_phase(
        startup_debug,
        broker_start,
        format!(
            "ensuring default channels for {} workspaces",
            workspaces.len()
        ),
    );
    for workspace in &workspaces {
        if let Err(error) = workspace.http_client.ensure_default_channels().await {
            tracing::warn!(workspace_id = %workspace.workspace_id, error = %error, "failed to ensure default channels");
        }
    }
    log_startup_phase(startup_debug, broker_start, "default channels ensured");

    let extra_channels = channels_from_csv(&cmd.channels);
    log_startup_phase(
        startup_debug,
        broker_start,
        format!("ensuring extra channels count={}", extra_channels.len()),
    );
    for workspace in &workspaces {
        if let Err(error) = workspace
            .http_client
            .ensure_extra_channels(&extra_channels)
            .await
        {
            tracing::warn!(workspace_id = %workspace.workspace_id, error = %error, "failed to ensure extra channels");
        }
    }
    log_startup_phase(startup_debug, broker_start, "extra channels ensured");

    if !extra_channels.is_empty() {
        log_startup_phase(
            startup_debug,
            broker_start,
            "subscribing websocket control channels",
        );
        for workspace in &workspaces {
            let _ = workspace
                .ws_control_tx
                .send(WsControl::Subscribe(extra_channels.clone()))
                .await;
        }
        log_startup_phase(
            startup_debug,
            broker_start,
            "websocket subscriptions updated",
        );
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
        // Do NOT stamp RELAYFILE_WORKSPACE from default_workspace_id. The
        // relaycast workspace id and the relayfile workspace id are
        // independent — a relayfile JWT scoped to a different workspace will
        // 403 with "workspace mismatch" when the relayfile MCP sends the
        // wrong id. Callers that share an id across both services (e.g. the
        // canonical `relay on start` flow) set RELAYFILE_WORKSPACE
        // themselves through per-spawn env_vars.
        worker_env.push((
            "RELAY_DEFAULT_WORKSPACE".to_string(),
            default_workspace_id.clone(),
        ));
        worker_env.push(("RELAY_WORKSPACE_ID".to_string(), default_workspace_id));
    }

    let (sdk_out_tx, mut sdk_out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(1024);
    let events_tx_for_stdout = events_tx.clone();
    let replay_buffer_for_stdout = replay_buffer.clone();
    tokio::spawn(async move {
        while let Some(frame) = sdk_out_rx.recv().await {
            // Broadcast events to WS clients (the primary SDK transport)
            if frame.msg_type == "event" {
                broadcast_if_relevant(
                    &events_tx_for_stdout,
                    &replay_buffer_for_stdout,
                    &frame.payload,
                )
                .await;
            }
            // Note: stdout writing is removed. The HTTP/WS API is the
            // only SDK transport. Events flow through broadcast_if_relevant
            // → events_tx → WS clients.
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
    let mut stdin_open = true;
    let mut reap_tick = tokio::time::interval(Duration::from_millis(500));
    reap_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut dedup = DedupCache::new(Duration::from_secs(300), 8192);
    let delivery_retry_interval = delivery_retry_interval();
    let mut pending_deliveries = load_pending_deliveries(&paths.pending);
    let mut terminal_failed_deliveries: HashSet<String> = HashSet::new();
    // Outstanding worker-bound RPC requests waiting on a `*_response`
    // frame from the wrapped worker. Keyed by the `request_id` we put on
    // the outbound request frame; the reply `oneshot` is consumed when
    // the worker echoes the same `request_id` back, or the entry expires
    // via the deadline sweep in the `reap_tick` arm below.
    //
    // The generic correlation infrastructure lives in `crate::worker_request`
    // so each new request/response route (`snapshot_pty`, `delivery-mode`,
    // `pending`, `flush`, ...) costs about five lines of broker plumbing.
    let mut pending_requests: HashMap<String, worker_request::PendingRequest> = HashMap::new();
    // Per-worker inbound-delivery-mode + pending-relay-message queue. Lives
    // parallel to `workers.workers` so we can swap modes / inspect /
    // drain without touching `WorkerHandle` (which holds OS-level
    // process state). See `relay_broker::types::InboundDeliveryState`. Entries
    // are created lazily on first lookup and removed wherever workers
    // exit (`Release` arm, `worker_exited` frame, `reap_exited` sweep).
    let mut delivery_states: HashMap<String, InboundDeliveryState> = HashMap::new();
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

    // Owner lease: in ephemeral mode, the broker shuts down if the SDK
    // doesn't renew the lease within this duration. Replaces stdin EOF
    // detection. Disabled in persist mode.
    let lease_duration = if cmd.persist {
        None
    } else {
        Some(Duration::from_secs(120))
    };
    let mut last_lease_renewal = Instant::now();
    let mut lease_check = tokio::time::interval(Duration::from_secs(10));
    lease_check.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Graceful-shutdown signal: SIGTERM on unix, Ctrl+Break/Close on Windows.
    // `tokio::signal::ctrl_c()` is handled in its own select! arm below and
    // works on both platforms.
    #[cfg(unix)]
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(windows)]
    let mut sigterm = tokio::signal::windows::ctrl_shutdown()?;

    while !shutdown {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                shutdown = true;
            }

            _ = lease_check.tick() => {
                if let Some(duration) = lease_duration {
                    if last_lease_renewal.elapsed() > duration {
                        tracing::info!(
                            elapsed_secs = last_lease_renewal.elapsed().as_secs(),
                            lease_secs = duration.as_secs(),
                            "owner lease expired — shutting down"
                        );
                        shutdown = true;
                    }
                }
            }

            _ = sigterm.recv() => {
                tracing::info!("received SIGTERM, shutting down");
                shutdown = true;
            }

            // HTTP API requests (when --api-port is active)
            result = api_rx.recv() => {
                if let Some(req) = result {
                    match req {
                        ListenApiRequest::Spawn {
                            name,
                            cli,
                            transport,
                            model,
                            args,
                            task,
                            channels,
                            cwd,
                            team,
                            shadow_of,
                            shadow_mode,
                            continue_from,
                            idle_threshold_secs,
                            skip_relay_prompt,
                            restart_policy,
                            agent_token,
                            reply,
                        } => {
                            let effective_channels = if channels.is_empty() {
                                default_spawn_channels()
                            } else {
                                channels.clone()
                            };
                            let spec = match build_http_api_spawn_spec(
                                name.clone(),
                                cli.clone(),
                                transport,
                                model.clone(),
                                args,
                                effective_channels.clone(),
                                cwd,
                                team,
                                shadow_of,
                                shadow_mode,
                                *restart_policy,
                            ) {
                                Ok(spec) => spec,
                                Err(error) => {
                                    let _ = reply.send(Err(error.to_string()));
                                    continue;
                                }
                            };
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

                            // Caller-supplied agent_token overrides auto-registration
                            let worker_relay_key = agent_token.or(worker_relay_key);

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
                                skip_relay_prompt,
                                idle_threshold_secs.map(|s| s.to_string()),
                            ).await {
                                Ok(effective_spec) => {
                                    if let Some(ref task_text) = effective_task {
                                        workers.initial_tasks.insert(name.clone(), task_text.clone());
                                    }
                                    agent_spawn_count += 1;
                                    telemetry.track(TelemetryEvent::AgentSpawn {
                                        cli: cli.clone(),
                                        runtime: runtime_label(&effective_spec.runtime).to_string(),
                                        spawn_source: ActionSource::HumanDashboard,
                                        has_task: effective_task.is_some(),
                                        is_shadow: effective_spec.shadow_of.is_some()
                                            || effective_spec.shadow_mode.is_some(),
                                    });
                                    let pid = workers.worker_pid(&name).unwrap_or(0);
                                    state.agents.insert(
                                        name.clone(),
                                        broker::PersistedAgent {
                                            runtime: effective_spec.runtime.clone(),
                                            parent: Some("Dashboard".to_string()),
                                            channels: effective_spec.channels.clone(),
                                            pid: workers.worker_pid(&name),
                                            started_at: Some(
                                                std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .unwrap_or_default()
                                                    .as_secs(),
                                            ),
                                            spec: Some(effective_spec.clone()),
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
                                            "runtime":runtime_label(&effective_spec.runtime),
                                            "provider": effective_spec.provider.clone(),
                                            "cli": effective_spec.cli.clone(),
                                            "model": effective_spec.model.clone(),
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
                                        "runtime": runtime_label(&effective_spec.runtime),
                                        "model": effective_spec.model.clone(),
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
                                    fail_pending_requests_for_worker(&mut pending_requests, &name, "agent_released");
                                    delivery_states.remove(&name);
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
                                // Inbound-delivery queue: every inbound message
                                // enters the per-worker FIFO first. `auto_inject`
                                // drains immediately; `manual_flush` holds and
                                // counts as delivered so the HTTP caller's ack
                                // semantics are unchanged. We pass the FULL
                                // routing context so any drain reproduces the
                                // original delivery (channel/thread/workspace
                                // /priority/mode), not a stripped-down DM.
                                match queue_inbound_for_delivery_mode(
                                    &mut delivery_states,
                                    &workers,
                                    &worker_name,
                                    InboundContext {
                                        from: &delivery_from,
                                        body: &text,
                                        target: &normalized_to,
                                        thread_id: thread_id.as_deref(),
                                        workspace_id: Some(selected_workspace_id.as_str()),
                                        workspace_alias: selected_workspace_alias.as_deref(),
                                        priority,
                                        mode: mode.clone(),
                                        event_id: Some(&event_id),
                                    },
                                ) {
                                    InboundQueueOutcome::Queued => {
                                        delivered = delivered.saturating_add(1);
                                        tracing::info!(
                                            target = "relay_broker::http_api",
                                            event_id = %event_id,
                                            to = %normalized_to,
                                            worker = %worker_name,
                                            "queued local delivery (manual_flush inbound delivery mode)"
                                        );
                                        let _ = send_event(
                                            &sdk_out_tx,
                                            json!({
                                                "kind":"delivery_queued",
                                                "name":&worker_name,
                                                "event_id":&event_id,
                                                "from":&delivery_from,
                                                "target":&normalized_to,
                                                "reason":"inbound_delivery_manual_flush",
                                            }),
                                        ).await;
                                        continue;
                                    }
                                    InboundQueueOutcome::DrainNow(to_drain) => {
                                        for queued in to_drain {
                                            let queued_event_id =
                                                queued.event_id.as_deref().unwrap_or("");
                                            let is_current =
                                                queued.event_id.as_deref() == Some(event_id.as_str());
                                            match timeout(
                                                local_delivery_timeout,
                                                try_inject_pending_relay_message(
                                                    &mut workers,
                                                    &mut pending_deliveries,
                                                    &worker_name,
                                                    &queued,
                                                    delivery_retry_interval,
                                                ),
                                            )
                                            .await
                                            {
                                                Ok(Ok(_)) => {
                                                    if is_current {
                                                        delivered = delivered.saturating_add(1);
                                                    }
                                                }
                                                Ok(Err(error)) => {
                                                    if is_current {
                                                        delivery_errors =
                                                            delivery_errors.saturating_add(1);
                                                    }
                                                    tracing::warn!(
                                                        target = "relay_broker::http_api",

                                                        event_id = %queued_event_id,
                                                        to = %queued.target,
                                                        worker = %worker_name,
                                                        error = %error,
                                                        "local delivery attempt failed"
                                                    );
                                                }
                                                Err(_) => {
                                                    if is_current {
                                                        delivery_errors =
                                                            delivery_errors.saturating_add(1);
                                                    }
                                                    tracing::warn!(
                                                        target = "relay_broker::http_api",

                                                        event_id = %queued_event_id,
                                                        to = %queued.target,
                                                        worker = %worker_name,
                                                        timeout_ms = %local_delivery_timeout.as_millis(),
                                                        "local delivery attempt timed out"
                                                    );
                                                }
                                            }
                                        }
                                        continue;
                                    }
                                    InboundQueueOutcome::WorkerMissing => {
                                        // Fall through so the standard
                                        // not-found accounting path runs.
                                    }
                                }
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
                                    mode = ?mode,
                                    delivery_errors = %delivery_errors,
                                    delivery_from = %delivery_from,
                                    ui_from = %ui_from,
                                    relaycast_timeout_ms = %relaycast_timeout.as_millis(),
                                    "no local deliveries succeeded; forwarding to relaycast"
                                );
                                let relaycast_start = Instant::now();
                                match timeout(
                                    relaycast_timeout,
                                    selected_workspace
                                        .http_client
                                        .send_with_mode(&normalized_to, &text, mode.clone()),
                                )
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
                        ListenApiRequest::SendInput { name, data, reply } => {
                            if let Err(err) = workers.send_to_worker(
                                &name, "write_pty", Some(format!("api_{}", Uuid::new_v4().simple())),
                                json!({ "data": data }),
                            ).await {
                                let _ = reply.send(Err(format!("agent_not_found: {}", err)));
                            } else {
                                let _ = reply.send(Ok(json!({
                                    "name": name,
                                    "bytes_written": data.len(),
                                })));
                            }
                        }
                        ListenApiRequest::ResizePty { name, rows, cols, reply } => {
                            if rows == 0 || cols == 0 {
                                let _ = reply.send(Err("invalid_dimensions: rows and cols must be >= 1".into()));
                            } else if let Err(err) = workers.send_to_worker(
                                &name, "resize_pty", Some(format!("api_{}", Uuid::new_v4().simple())),
                                json!({ "rows": rows, "cols": cols }),
                            ).await {
                                let _ = reply.send(Err(format!("agent_not_found: {}", err)));
                            } else {
                                let _ = reply.send(Ok(json!({
                                    "name": name,
                                    "rows": rows,
                                    "cols": cols,
                                })));
                            }
                        }
                        ListenApiRequest::WorkerRequest { name, kind, payload, timeout, reply } => {
                            // Generic worker request/response: validate the
                            // worker exists and supports a PTY (all current
                            // request/response routes target the PTY side),
                            // then ship the frame and park the `reply`
                            // oneshot in `pending_requests`. The response is
                            // fulfilled either by the `*_response` arm below
                            // or by the deadline sweep in `reap_tick`.
                            //
                            // Headless workers don't run a VT and don't handle
                            // PTY-oriented RPCs — short-circuit with a typed
                            // error rather than letting the request sit until
                            // the timeout sweep returns a misleading
                            // `worker_timeout`.
                            let runtime = workers
                                .workers
                                .get(&name)
                                .map(|handle| handle.spec.runtime.clone());
                            match runtime {
                                None => {
                                    let _ = reply.send(Err(
                                        worker_request::RequestWorkerError::WorkerNotFound(
                                            format!("no worker named '{name}'"),
                                        ),
                                    ));
                                }
                                Some(AgentRuntime::Headless) => {
                                    let _ = reply.send(Err(
                                        worker_request::RequestWorkerError::UnsupportedRuntime(
                                            format!("worker '{name}' is headless; {kind} is only supported on PTY workers"),
                                        ),
                                    ));
                                }
                                Some(AgentRuntime::Pty) => {
                                    let request_id = format!("req_{}", Uuid::new_v4().simple());
                                    if let Err(err) = workers.send_to_worker(
                                        &name,
                                        &kind,
                                        Some(request_id.clone()),
                                        payload,
                                    ).await {
                                        let _ = reply.send(Err(
                                            worker_request::RequestWorkerError::SendFailed(
                                                err.to_string(),
                                            ),
                                        ));
                                    } else {
                                        pending_requests.insert(
                                            request_id,
                                            worker_request::PendingRequest {
                                                kind,
                                                worker_name: name,
                                                reply,
                                                deadline: Instant::now() + timeout,
                                            },
                                        );
                                    }
                                }
                            }
                        }
                        ListenApiRequest::GetMetrics { agent, reply } => {
                            if let Some(ref agent_name) = agent {
                                if let Some(handle) = workers.workers.get(agent_name) {
                                    let m = build_agent_metrics(handle);
                                    let _ = reply.send(Ok(json!({ "agents": [m], "broker": workers.metrics.snapshot(workers.workers.len()) })));
                                } else {
                                    let _ = reply.send(Err(format!("unknown worker '{}'", agent_name)));
                                }
                            } else {
                                let mut agent_metrics: Vec<AgentMetrics> = workers.workers.values()
                                    .map(build_agent_metrics)
                                    .collect();
                                agent_metrics.sort_by(|a, b| a.name.cmp(&b.name));
                                let _ = reply.send(Ok(json!({
                                    "agents": agent_metrics,
                                    "broker": workers.metrics.snapshot(workers.workers.len()),
                                })));
                            }
                        }
                        ListenApiRequest::GetStatus { reply } => {
                            let pending: Vec<Value> = pending_deliveries.values().map(|pd| {
                                json!({
                                    "delivery_id": pd.delivery.delivery_id,
                                    "worker_name": pd.worker_name,
                                    "event_id": pd.delivery.event_id,
                                    "attempts": pd.attempts,
                                })
                            }).collect();
                            let _ = reply.send(Ok(json!({
                                "agent_count": workers.workers.len(),
                                "agents": workers.list(),
                                "pending_delivery_count": pending.len(),
                                "pending_deliveries": pending,
                            })));
                        }
                        ListenApiRequest::GetCrashInsights { reply } => {
                            let _ = reply.send(Ok(crash_insights.to_json()));
                        }
                        ListenApiRequest::Preflight { agents, reply } => {
                            let count = agents.len();
                            let _ = reply.send(Ok(json!({ "queued": count })));
                            // Background preflight — same as stdio handler
                            for entry in agents {
                                let http = relaycast_http.clone();
                                tokio::spawn(async move {
                                    let _ = tokio::time::timeout(
                                        Duration::from_secs(30),
                                        http.register_agent_token(&entry.name, Some(&entry.cli)),
                                    ).await;
                                });
                            }
                        }
                        ListenApiRequest::SubscribeChannels { name, channels, reply } => {
                            let Some(handle) = workers.workers.get_mut(&name) else {
                                let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                                continue;
                            };
                            let mut added = Vec::new();
                            for ch in &channels {
                                let exists = handle.spec.channels.iter()
                                    .any(|c| c.eq_ignore_ascii_case(ch));
                                if !exists {
                                    handle.spec.channels.push(ch.clone());
                                    added.push(ch.clone());
                                }
                            }
                            let all_channels = handle.spec.channels.clone();
                            let _ = reply.send(Ok(json!({
                                "name": name,
                                "channels": all_channels,
                            })));
                        }
                        ListenApiRequest::UnsubscribeChannels { name, channels, reply } => {
                            let Some(handle) = workers.workers.get_mut(&name) else {
                                let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                                continue;
                            };
                            handle.spec.channels.retain(|c| {
                                !channels.iter().any(|rem| rem.eq_ignore_ascii_case(c))
                            });
                            let remaining = handle.spec.channels.clone();
                            let _ = reply.send(Ok(json!({
                                "name": name,
                                "channels": remaining,
                            })));
                        }
                        ListenApiRequest::GetInboundDeliveryMode { name, reply } => {
                            if !workers.has_worker(&name) {
                                let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound(name)));
                            } else {
                                let mode = delivery_states
                                    .get(&name)
                                    .map(|s| s.mode)
                                    .unwrap_or_default();
                                let _ = reply.send(Ok(mode));
                            }
                        }
                        ListenApiRequest::SetInboundDeliveryMode { name, mode, reply } => {
                            if !workers.has_worker(&name) {
                                let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound(name)));
                            } else {
                                let entry = delivery_states.entry(name.clone()).or_default();
                                let previous = entry.mode;
                                entry.mode = mode;
                                let to_flush: Vec<PendingRelayMessage> = if previous
                                    == InboundDeliveryMode::ManualFlush
                                    && mode == InboundDeliveryMode::AutoInject
                                {
                                    entry.drain_pending()
                                } else {
                                    Vec::new()
                                };
                                let flushed = to_flush.len();
                                if !to_flush.is_empty() {
                                    tracing::info!(
                                        target = "agent_relay::broker",
                                        worker = %name,
                                        drained = flushed,
                                        "draining pending queue on manual_flush → auto_inject transition"
                                    );
                                }
                                for queued in to_flush {
                                    inject_pending_relay_message(
                                        &mut workers,
                                        &mut pending_deliveries,
                                        &name,
                                        &queued,
                                        delivery_retry_interval,
                                    )
                                    .await;
                                }
                                tracing::info!(
                                    target = "agent_relay::broker",
                                    worker = %name,
                                    previous_mode = previous.as_wire_str(),
                                    mode = mode.as_wire_str(),
                                    flushed,
                                    "inbound delivery mode updated"
                                );
                                if previous != mode {
                                    let _ = send_event(
                                        &sdk_out_tx,
                                        json!({
                                            "kind":"agent_inbound_delivery_mode_changed",
                                            "name":&name,
                                            "previous_mode":previous.as_wire_str(),
                                            "mode":mode.as_wire_str(),
                                        }),
                                    ).await;
                                }
                                if flushed > 0 {
                                    let _ = send_event(
                                        &sdk_out_tx,
                                        json!({
                                            "kind":"agent_pending_drained",
                                            "name":&name,
                                            "count":flushed,
                                            "reason":"delivery_mode_transition",
                                        }),
                                    ).await;
                                }
                                let _ = reply.send(Ok(SetInboundDeliveryModeOk { mode, flushed }));
                            }
                        }
                        ListenApiRequest::GetPending { name, reply } => {
                            if !workers.has_worker(&name) {
                                let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound(name)));
                            } else {
                                let snapshot = delivery_states
                                    .get(&name)
                                    .map(|s| s.pending_snapshot())
                                    .unwrap_or_default();
                                let _ = reply.send(Ok(snapshot));
                            }
                        }
                        ListenApiRequest::FlushPending { name, reply } => {
                            if !workers.has_worker(&name) {
                                let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound(name)));
                            } else {
                                let to_flush: Vec<PendingRelayMessage> = delivery_states
                                    .get_mut(&name)
                                    .map(|state| state.drain_pending())
                                    .unwrap_or_default();
                                let flushed = to_flush.len();
                                if flushed > 0 {
                                    tracing::info!(
                                        target = "agent_relay::broker",
                                        worker = %name,
                                        drained = flushed,
                                        "flushing pending queue on explicit /flush"
                                    );
                                }
                                for queued in to_flush {
                                    inject_pending_relay_message(
                                        &mut workers,
                                        &mut pending_deliveries,
                                        &name,
                                        &queued,
                                        delivery_retry_interval,
                                    )
                                    .await;
                                }
                                if flushed > 0 {
                                    let _ = send_event(
                                        &sdk_out_tx,
                                        json!({
                                            "kind":"agent_pending_drained",
                                            "name":&name,
                                            "count":flushed,
                                            "reason":"explicit_flush",
                                        }),
                                    ).await;
                                }
                                let _ = reply.send(Ok(flushed));
                            }
                        }
                        ListenApiRequest::Shutdown { reply } => {
                            let _ = reply.send(Ok(json!({ "status": "shutting_down" })));
                            shutdown = true;
                        }
                        ListenApiRequest::RenewLease { reply } => {
                            last_lease_renewal = Instant::now();
                            let expires_in = lease_duration.map(|d| d.as_secs()).unwrap_or(0);
                            let _ = reply.send(Ok(json!({
                                "renewed": true,
                                "expires_in_secs": expires_in,
                                "persist": cmd.persist,
                            })));
                        }
                    }
                }
            }

            // Stdin is no longer used for SDK communication — all control
            // goes through the HTTP/WS API. We drain stdin to avoid
            // blocking if anything writes to it, and stop polling after EOF.
            result = sdk_lines.next_line(), if stdin_open => {
                if matches!(result, Ok(None) | Err(_)) {
                    stdin_open = false;
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
                                        fail_pending_requests_for_worker(&mut pending_requests, &name, "relaycast_release");
                                        delivery_states.remove(&name);
                                        telemetry.track(TelemetryEvent::AgentRelease {
                                            cli: String::new(),
                                            release_reason: "relaycast_release".to_string(),
                                            lifetime_seconds: 0,
                                            release_source: ActionSource::Protocol,
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
                                    Ok(effective_spec) => {
                                        if let Some(ref task_text) = effective_task {
                                            workers.initial_tasks.insert(name.clone(), task_text.clone());
                                        }
                                        agent_spawn_count += 1;
                                        telemetry.track(TelemetryEvent::AgentSpawn {
                                            cli: cli.clone(),
                                            runtime: runtime_label(&effective_spec.runtime).to_string(),
                                            spawn_source: ActionSource::Protocol,
                                            has_task: effective_task.is_some(),
                                            is_shadow: false,
                                        });
                                        let pid = workers.worker_pid(&name).unwrap_or(0);
                                        state.agents.insert(
                                            name.clone(),
                                            broker::PersistedAgent {
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
                                                spec: Some(effective_spec.clone()),
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
                                                "model": effective_spec.model.clone(),
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
                                        Ok(effective_spec) => {
                                            if let Some(ref task_text) = effective_task {
                                                workers.initial_tasks.insert(name.clone(), task_text.clone());
                                            }
                                            agent_spawn_count += 1;
                                            telemetry.track(TelemetryEvent::AgentSpawn {
                                                cli: cli.clone(),
                                                runtime: runtime_label(&effective_spec.runtime).to_string(),
                                                spawn_source: ActionSource::Protocol,
                                                has_task: effective_task.is_some(),
                                                is_shadow: false,
                                            });
                                            let pid = workers.worker_pid(&name).unwrap_or(0);
                                            state.agents.insert(
                                                name.clone(),
                                                broker::PersistedAgent {
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
                                                    spec: Some(effective_spec.clone()),
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
                                                    "model": effective_spec.model.clone(),
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
                            let participants = resolve_dm_participants_cached(
                                &workspace_http,
                                &mut dm_participants_cache,
                                &workspace_id,
                                &conversation_id,
                            )
                            .await;
                            tracing::info!(participants = ?participants, "resolved DM participants");

                            if let Some(participant) = participants
                                .iter()
                                .find(|participant| !agent_name_eq(participant, &mapped.from))
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
                            // Inbound-delivery queue: mirrors the /api/send
                            // queue above. Auto-inject workers drain the queue
                            // immediately; manual-flush workers leave relaycast
                            // messages parked until flush. The same full-context
                            // capture makes drains reproduce the original
                            // delivery (channel/thread/workspace).
                            match queue_inbound_for_delivery_mode(
                                &mut delivery_states,
                                &workers,
                                &worker_name,
                                InboundContext {
                                    from: &mapped.from,
                                    body: &mapped.text,
                                    target: &mapped.target,
                                    thread_id: mapped.thread_id.as_deref(),
                                    workspace_id: Some(mapped.workspace_id.as_str()),
                                    workspace_alias: mapped.workspace_alias.as_deref(),
                                    priority: mapped.priority.as_u8(),
                                    mode: MessageInjectionMode::Wait,
                                    event_id: Some(&mapped.event_id),
                                },
                            ) {
                                InboundQueueOutcome::Queued => {
                                    tracing::info!(
                                        target = "agent_relay::broker",
                                        event_id = %mapped.event_id,
                                        worker = %worker_name,
                                        "queued inbound relay message (manual_flush inbound delivery mode)"
                                    );
                                    let _ = send_event(
                                        &sdk_out_tx,
                                        json!({
                                            "kind":"delivery_queued",
                                            "name":&worker_name,
                                            "event_id":&mapped.event_id,
                                            "from":&mapped.from,
                                            "target":&mapped.target,
                                            "reason":"inbound_delivery_manual_flush",
                                        }),
                                    ).await;
                                    continue;
                                }
                                InboundQueueOutcome::DrainNow(to_drain) => {
                                    for queued in to_drain {
                                        if let Err(error) = try_inject_pending_relay_message(
                                            &mut workers,
                                            &mut pending_deliveries,
                                            &worker_name,
                                            &queued,
                                            delivery_retry_interval,
                                        )
                                        .await
                                        {
                                            let _ = send_error(
                                                &sdk_out_tx,
                                                None,
                                                "delivery_failed",
                                                error.to_string(),
                                                true,
                                                Some(json!({"worker": worker_name})),
                                            )
                                            .await;
                                        }
                                    }
                                    continue;
                                }
                                InboundQueueOutcome::WorkerMissing => {}
                            }
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
                        let display_from = if is_self_name(&workspace_self_names, &mapped.from)
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
                                } else if msg_type.ends_with("_response") {
                                    // Generic worker request/response dispatch.
                                    // Any frame whose `type` ends in
                                    // `_response` is routed by `request_id`
                                    // into the matching parked `oneshot` in
                                    // `pending_requests`. The pending entry
                                    // owns the format/error decoding logic
                                    // via `worker_request::fulfil_response_frame`.
                                    let routed = worker_request::fulfil_response_frame(
                                        &mut pending_requests,
                                        &value,
                                    );
                                    if !routed {
                                        let req_id = value
                                            .get("request_id")
                                            .and_then(Value::as_str)
                                            .unwrap_or("<missing>");
                                        tracing::debug!(
                                            target = "agent_relay::broker",
                                            worker = %name,
                                            msg_type = %msg_type,
                                            request_id = %req_id,
                                            "worker response with no pending caller — dropping"
                                        );
                                    }
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
                                    fail_pending_requests_for_worker(&mut pending_requests, &name, "worker_exited");
                                    delivery_states.remove(&name);
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

                // Time out worker request/response calls whose worker never
                // responded. Common cause: worker crashed between us sending
                // the request frame and it parsing the frame. Without this
                // sweep the HTTP handler would hang forever on its oneshot.
                for (req_id, worker_name, kind) in
                    worker_request::reap_expired(&mut pending_requests, now)
                {
                    tracing::warn!(
                        target = "agent_relay::broker",
                        request_id = %req_id,
                        worker = %worker_name,
                        kind = %kind,
                        "worker request timed out before worker responded"
                    );
                }

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
                            fail_pending_requests_for_worker(&mut pending_requests, name, "worker_permanently_dead");
                            delivery_states.remove(name);
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
                            fail_pending_requests_for_worker(&mut pending_requests, name, "worker_exited");
                            delivery_states.remove(name);
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
                            Ok(_) => {
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

    // Clean up state and connection files on graceful shutdown
    if paths.persist {
        let _ = std::fs::remove_file(&paths.state);
    }
    let connection_path = paths.state.parent().unwrap().join("connection.json");
    let _ = std::fs::remove_file(&connection_path);

    Ok(())
}
