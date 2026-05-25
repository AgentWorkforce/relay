use super::*;
use std::net::{IpAddr, SocketAddr};

pub(crate) async fn run_init(cmd: InitCommand, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let startup_debug = startup_debug_enabled();
    let agent_spawn_count: u32 = 0;
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
        // Warn only if there is *actual broker state* in .agent-relay/ from a
        // prior `--persist` run that could confuse this ephemeral run.
        //
        // The SDK workflow runner ALWAYS writes .agent-relay/step-outputs/ and
        // .agent-relay/team/worker-logs/ regardless of broker mode (those are
        // durable artifacts, not broker state), so a bare directory check fires
        // on virtually every workflow run — a noisy false positive.
        //
        // The discriminator is the broker's state file. `ensure_runtime_paths`
        // (the persist-mode helper in runtime/paths.rs) writes it as
        // `state-{safe_name}.json`, where `safe_name` is the sanitized broker
        // name — so the exact filename varies by run. Glob for any
        // `state-*.json` entry in `.agent-relay/` and surface every match so
        // the user can see exactly what's stale regardless of broker name.
        let stale_dir = runtime_cwd.join(".agent-relay");
        let stale_state_files: Vec<PathBuf> = std::fs::read_dir(&stale_dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                name_str.starts_with("state-") && name_str.ends_with(".json")
            })
            .map(|entry| entry.path())
            .collect();
        if !stale_state_files.is_empty() {
            eprintln!(
                "[agent-relay] WARNING: this run is ephemeral but {} prior --persist state file(s) remain in {}:",
                stale_state_files.len(),
                stale_dir.display()
            );
            for state_file in &stale_state_files {
                eprintln!("[agent-relay] WARNING:   {}", state_file.display());
            }
            eprintln!("[agent-relay] WARNING: remove them to avoid confusing spawned agents.");
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
    let (api_tx, api_rx) = mpsc::channel::<ListenApiRequest>(32);
    let bind_addr = format!("{}:{}", cmd.api_bind, cmd.api_port);
    log_startup_phase(
        startup_debug,
        broker_start,
        format!("binding API listener on {}", bind_addr),
    );
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("failed to bind API on {}", bind_addr))?;
    let local_addr = listener.local_addr()?;
    let actual_port = local_addr.port();
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
        ws_inbound_rx,
    } = relay;
    let workspace_lookup: HashMap<WorkspaceId, RelayWorkspace> = workspaces
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

    let extra_channels: Vec<ChannelName> = channels_from_csv(&cmd.channels)
        .into_iter()
        .map(ChannelName::from)
        .collect();
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

    let callback_host = callback_host_for_url(&cmd.api_bind, local_addr);
    let mut worker_env = vec![
        ("RELAY_BASE_URL".to_string(), http_base.clone()),
        ("RELAY_API_KEY".to_string(), relay_workspace_key.clone()),
        (
            "AGENT_RELAY_RESULT_URL".to_string(),
            format!("http://{}:{}/api/agent-result", callback_host, actual_port),
        ),
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
            default_workspace_id.as_str().to_string(),
        ));
        worker_env.push((
            "RELAY_WORKSPACE_ID".to_string(),
            default_workspace_id.into_string(),
        ));
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

    let (worker_event_tx, worker_event_rx) = mpsc::channel::<WorkerEvent>(1024);
    let worker_logs_dir = paths
        .state
        .parent()
        .expect("state path should always have a parent")
        .join("team")
        .join("worker-logs");
    let workers = WorkerRegistry::new(worker_event_tx, worker_env, worker_logs_dir, broker_start);

    // Load crash insights from previous session
    let crash_insights_path = paths.state.parent().unwrap().join("crash-insights.json");
    let crash_insights = crate::crash_insights::CrashInsights::load(&crash_insights_path);

    let sdk_lines = BufReader::new(tokio::io::stdin()).lines();
    let stdin_open = true;
    let mut reap_tick = tokio::time::interval(Duration::from_millis(500));
    reap_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let dedup = DedupCache::new(Duration::from_secs(300), 8192);
    let delivery_retry_interval = delivery_retry_interval();
    let pending_deliveries = load_pending_deliveries(&paths.pending);
    let terminal_failed_deliveries: HashSet<DeliveryId> = HashSet::new();
    // Outstanding worker-bound RPC requests waiting on a `*_response`
    // frame from the wrapped worker. Keyed by the `request_id` we put on
    // the outbound request frame; the reply `oneshot` is consumed when
    // the worker echoes the same `request_id` back, or the entry expires
    // via the deadline sweep in the `reap_tick` arm below.
    //
    // The generic correlation infrastructure lives in `crate::worker_request`
    // so each new request/response route (`snapshot_pty`, `delivery-mode`,
    // `pending`, `flush`, ...) costs about five lines of broker plumbing.
    let pending_requests: HashMap<String, worker_request::PendingRequest> = HashMap::new();
    // Per-worker inbound-delivery-mode + pending-relay-message queue. Lives
    // parallel to `workers.workers` so we can swap modes / inspect /
    // drain without touching `WorkerHandle` (which holds OS-level
    // process state). See `relay_broker::types::InboundDeliveryState`. Entries
    // are created lazily on first lookup and removed wherever workers
    // exit (`Release` arm or `reap_exited` sweep).
    let delivery_states: HashMap<WorkerName, InboundDeliveryState> = HashMap::new();
    let agent_result_tokens: HashMap<String, WorkerName> = HashMap::new();
    let dm_participants_cache = DmParticipantsCache::new();
    let recent_thread_messages: VecDeque<Value> = VecDeque::new();
    if !pending_deliveries.is_empty() {
        tracing::info!(
            count = pending_deliveries.len(),
            "loaded {} pending deliveries from previous session",
            pending_deliveries.len()
        );
    }

    let shutdown = false;

    // Owner lease: in ephemeral mode, the broker shuts down if the SDK
    // doesn't renew the lease within this duration. Replaces stdin EOF
    // detection. Disabled in persist mode.
    let lease_duration = if cmd.persist {
        None
    } else {
        Some(Duration::from_secs(120))
    };
    let last_lease_renewal = Instant::now();
    let mut lease_check = tokio::time::interval(Duration::from_secs(10));
    lease_check.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Graceful-shutdown signal: SIGTERM on unix, Ctrl+Break/Close on Windows.
    // `tokio::signal::ctrl_c()` is handled in its own select! arm below and
    // works on both platforms.
    #[cfg(unix)]
    let sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(windows)]
    let mut sigterm = tokio::signal::windows::ctrl_shutdown()?;

    let runtime = BrokerRuntime {
        persist: cmd.persist,
        broker_start,
        agent_spawn_count,
        paths,
        state,
        workspaces,
        workspace_lookup,
        default_workspace,
        default_workspace_id,
        self_names,
        ws_control_tx,
        relaycast_http,
        api_rx,
        api_open: true,
        ws_inbound_rx,
        relaycast_open: true,
        sdk_out_tx,
        worker_event_rx,
        worker_events_open: true,
        workers,
        crash_insights,
        crash_insights_path,
        sdk_lines,
        stdin_open,
        reap_tick,
        dedup,
        delivery_retry_interval,
        pending_deliveries,
        terminal_failed_deliveries,
        pending_requests,
        delivery_states,
        agent_result_tokens,
        dm_participants_cache,
        recent_thread_messages,
        shutdown,
        lease_duration,
        last_lease_renewal,
        lease_check,
        sigterm,
        telemetry,
    };

    runtime.run().await
}

fn callback_host_for_url(api_bind: &str, local_addr: SocketAddr) -> String {
    let host = match unbracket_ipv6(api_bind.trim()) {
        "" => {
            if local_addr.is_ipv6() {
                "::1"
            } else {
                "127.0.0.1"
            }
        }
        "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        other => other,
    };
    bracket_ipv6_host(host)
}

fn unbracket_ipv6(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
}

fn bracket_ipv6_host(host: &str) -> String {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => format!("[{}]", host),
        _ => host.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn callback_host_uses_family_specific_loopback_for_wildcards() {
        assert_eq!(
            callback_host_for_url("0.0.0.0", SocketAddr::from((Ipv4Addr::UNSPECIFIED, 3889))),
            "127.0.0.1"
        );
        assert_eq!(
            callback_host_for_url("[::]", SocketAddr::from((Ipv6Addr::UNSPECIFIED, 3889))),
            "[::1]"
        );
        assert_eq!(
            callback_host_for_url("::", SocketAddr::from((Ipv6Addr::UNSPECIFIED, 3889))),
            "[::1]"
        );
    }

    #[test]
    fn callback_host_brackets_ipv6_literals() {
        assert_eq!(
            callback_host_for_url("::1", SocketAddr::from((Ipv6Addr::LOCALHOST, 3889))),
            "[::1]"
        );
        assert_eq!(
            callback_host_for_url("[::1]", SocketAddr::from((Ipv6Addr::LOCALHOST, 3889))),
            "[::1]"
        );
        assert_eq!(
            callback_host_for_url("127.0.0.1", SocketAddr::from((Ipv4Addr::LOCALHOST, 3889))),
            "127.0.0.1"
        );
    }
}
