use super::*;
use std::net::{IpAddr, SocketAddr};

pub(crate) async fn run_init(cmd: InitCommand, telemetry: TelemetryClient) -> Result<()> {
    let broker_start = Instant::now();
    let startup_debug = startup_debug_enabled();
    let agent_spawn_count: u32 = 0;
    telemetry.track(TelemetryEvent::BrokerStart);

    let runtime_cwd = std::env::current_dir()?;
    let default_instance_name = runtime_cwd
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("project");
    let resolved_name = cmd.resolved_instance_name(Some(default_instance_name));
    if let Some(workspace_key) = cmd.resolved_workspace_key() {
        std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", &workspace_key);
        std::env::set_var("RELAY_WORKSPACE_KEY", &workspace_key);
        std::env::set_var("RELAY_API_KEY", &workspace_key);
    }
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
        // Warn only if there is *actual broker state* in .agentworkforce/relay/ from a
        // prior `--persist` run that could confuse this ephemeral run.
        //
        // The SDK workflow runner ALWAYS writes .agentworkforce/relay/step-outputs/ and
        // .agentworkforce/relay/team/worker-logs/ regardless of broker mode (those are
        // durable artifacts, not broker state), so a bare directory check fires
        // on virtually every workflow run — a noisy false positive.
        //
        // The discriminator is the broker's state file. `ensure_runtime_paths`
        // (the persist-mode helper in runtime/paths.rs) writes it as
        // `state-{safe_name}.json`, where `safe_name` is the sanitized broker
        // name — so the exact filename varies by run. Glob for any
        // `state-*.json` entry in `.agentworkforce/relay/` and surface every match so
        // the user can see exactly what's stale regardless of broker name.
        let stale_dir = runtime_cwd.join(".agentworkforce/relay");
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
        runtime_cwd: &runtime_cwd,
    })
    .await?;
    log_startup_phase(startup_debug, broker_start, "connect_relay completed");

    let RelaySession {
        configured_base,
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
    let (hosted_agent_event_tx, hosted_agent_event_rx) = mpsc::channel::<HostedAgentEvent>(10_000);
    let hosted_event_client = relaycast_http.clone();
    let hosted_event_clients = workspaces
        .iter()
        .map(|workspace| {
            (
                workspace.workspace_id.clone(),
                workspace.http_client.clone(),
            )
        })
        .collect();
    tokio::spawn(run_hosted_agent_event_publisher(
        hosted_event_client,
        hosted_event_clients,
        hosted_agent_event_rx,
    ));
    let node_workspace_id = default_workspace.workspace_id.as_str().to_string();
    let node_id = resolve_broker_node_id(&node_workspace_id);
    // The node registers under its resolved instance name (--instance-name, the
    // legacy --name/--broker-name alias, or AGENT_RELAY_BROKER_NAME), falling back
    // to the machine hostname only when none is set. Deriving this from the raw
    // `cmd.name` (the empty legacy flag) instead would register every node under its
    // hostname, colliding whenever two nodes share a host.
    let resolved_node_name = cmd.resolved_instance_name(None);
    let node_name = crate::node_control::default_node_name(
        (!resolved_node_name.trim().is_empty()).then_some(resolved_node_name.as_str()),
    );
    let fleet_ws_url = relaycast::node_control_ws_url(configured_base.as_deref());
    // Keep terminal traffic on a physically separate websocket. Do not append
    // terminal frames to the heartbeat/action control endpoint.
    let terminal_ws_url = fleet_ws_url
        .strip_suffix("/v1/node/ws")
        .map(|base| format!("{base}/v1/node/terminal/ws"))
        .context("fleet control URL must end with /v1/node/ws to derive the terminal URL")?;
    let broker_version = format!("relay-broker/{}", crate::util::version::broker_version());
    // The broker enrolls as a relaycast node and delivers/injects solely over
    // /v1/node/ws. A node token is required to open that connection: prefer an
    // explicit RELAY_NODE_TOKEN override, then a token previously minted for
    // THIS node id, otherwise mint one now with the workspace key and persist
    // it next to the node id so it rotates with the machine identity.
    // The node token is scoped to the workspace (and engine) it was minted
    // against. Thread the resolved workspace id and base URL through so the
    // cached token is only reused when both match, and so a re-mint after a
    // node-control 401 rewrites the correctly-scoped cache.
    let node_base_url = configured_base.clone();
    // Resolve only the fast, local token sources here (RELAY_NODE_TOKEN override
    // and the on-disk cache). The network mint (create_node) is deliberately NOT
    // done on this path: it would block the broker's API readiness handoff below
    // behind a Relaycast round-trip, delaying `/api/session` (and the CLI's
    // "Broker started.") until the mint completes. When no token is cached, the
    // node-control client mints one in the background (it holds the same minter)
    // and publishes it to `session_node_token`, so realtime delivery still comes
    // online without gating startup on it.
    let node_token =
        resolve_cached_node_token(&node_id, &node_workspace_id, node_base_url.as_deref());
    // A placement only carries a repository key. Checkout paths are local node
    // configuration, so keep them in the broker and resolve the key immediately
    // before every spawn rather than trusting a dispatcher-supplied cwd.
    let node_repo_paths = super::relaycast_events::load_node_repo_paths_from_env()?;
    let node_repo_keys = super::relaycast_events::node_repo_keys(&node_repo_paths);
    let node_manifest =
        bootstrap_node_manifest(&node_name, &node_id, &broker_version, node_repo_keys);
    // Retain the node name for the runtime: the HTTP `bind_agent_to_node`
    // fallback (used when node-control `agent.register` is unavailable) binds
    // spawned agents to this node so they become `via_node` and node delivery
    // reaches them.
    let fleet_node_name = node_name.clone();
    // Capture the resolved node identity for the HTTP session endpoint before it
    // is moved into the control client. Capability providers served by the CLI
    // attach to this same node id.
    let session_node_id = node_id.clone();
    let session_node_name = node_name.clone();
    // The node token is shared by every provider on this node (spec §2). Expose
    // the broker's resolved token on the api-key-gated session so the CLI can
    // serve local config providers without a pre-enrolled RELAY_NODE_TOKEN (the
    // broker mints its own in that case). Alongside the workspace key already
    // returned there, this stays within the local trust boundary. Seeded with the
    // cached token (if any); the node-control client writes through this shared
    // handle when it mints (initially or after a re-mint), keeping it current.
    let session_node_token = std::sync::Arc::new(std::sync::RwLock::new(node_token.clone()));
    // Wire the token minter used by the node-control client both for the initial
    // mint (when no token is cached, off the readiness path) and to recover from
    // a node-control 401 (stale/wrong-scoped token) by discarding the cached
    // token and minting a fresh one instead of looping forever on the rejected
    // token. Absent when no workspace RelayCast client is available (then a 401
    // surfaces a hard error rather than recovering).
    let token_minter = Some(crate::node_control::NodeTokenMinter {
        workspace_key: relay_workspace_key.clone(),
        workspace_id: node_workspace_id.clone(),
        base_url: node_base_url.clone(),
        node_id: node_id.clone(),
        node_name: node_name.clone(),
        broker_version: broker_version.clone(),
        token_path: crate::node_control::default_node_token_path(&node_id),
    });
    let (fleet_control_tx, fleet_control_rx) = mpsc::channel::<FleetControlCommand>(256);
    let (fleet_event_tx, fleet_event_rx) = mpsc::channel::<FleetControlEvent>(256);
    // The terminal queue is deliberately bounded. A wedged remote attach must
    // fail its session rather than accumulating unbounded PTY output in the
    // broker or starving node control.
    // Terminal bytes have a burstier profile than control actions. Keep this
    // lane bounded, but give a short PTY burst room without impacting the
    // independent control queue.
    let (terminal_control_tx, terminal_control_rx) =
        mpsc::channel::<crate::terminal_control::TerminalControlCommand>(1024);
    let (terminal_event_tx, terminal_event_rx) =
        mpsc::channel::<crate::terminal_control::TerminalControlEvent>(1024);
    let node_delivery_token_present = node_token.is_some();
    tokio::spawn(crate::node_control::run_node_control_client(
        crate::node_control::FleetControlConfig {
            ws_url: fleet_ws_url,
            node_token,
            node_id,
            node_name,
            broker_version,
            token_minter,
            session_token: Some(session_node_token.clone()),
            read_idle_timeout: None,
        },
        fleet_control_rx,
        fleet_event_tx,
    ));
    tokio::spawn(crate::terminal_control::run_terminal_control_client(
        crate::terminal_control::TerminalControlConfig {
            ws_url: terminal_ws_url,
            session_token: session_node_token.clone(),
            read_idle_timeout: None,
        },
        terminal_control_rx,
        terminal_event_tx,
    ));
    // Register this node unconditionally on connect (no sidecar required). This
    // is the only command that flips the control client out of its idle state
    // and into the connect loop, so the broker enrolls every startup.
    if let Err(error) = fleet_control_tx
        .send(FleetControlCommand::RegisterNode {
            manifest: node_manifest,
            resume_cursor: None,
        })
        .await
    {
        tracing::warn!(error = %error, "failed to queue node.register at startup");
    }
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
        relay_base_url: configured_base.clone(),
        memberships: workspace_memberships.clone(),
        default_workspace_id: default_workspace_id.clone(),
        node_id: session_node_id,
        node_name: session_node_name,
        node_token: session_node_token,
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
        (
            "AGENT_RELAY_WORKSPACE_KEY".to_string(),
            relay_workspace_key.clone(),
        ),
        (
            "RELAY_WORKSPACE_KEY".to_string(),
            relay_workspace_key.clone(),
        ),
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
    // Pass RELAY_BASE_URL to workers only when an override is configured; when
    // unset, workers inherit the SDK default.
    if let Some(base) = configured_base.as_deref() {
        worker_env.push(("RELAY_BASE_URL".to_string(), base.to_string()));
    }
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
    // Reload the dedup cache persisted by the previous session. It holds
    // relaycast control-event (spawn/release) and delivery read-ack keys, so
    // restoring it stops those control events and read-acks from being
    // re-processed after a crash/restart. It does not gate pending-delivery
    // replay (see the pending/dead-letter reconciliation below). Expired
    // entries drop on load.
    let dedup = crate::dedup::load_dedup_cache(&paths.dedup, Duration::from_secs(300), 8192);
    if !dedup.is_empty() {
        tracing::info!(
            count = dedup.len(),
            "loaded {} dedup entries from previous session",
            dedup.len()
        );
    }
    let delivery_retry_interval = delivery_retry_interval();
    let dead_letters = DeadLetterStore::new(load_dead_letters(&paths.dead_letters));
    if !dead_letters.is_empty() {
        tracing::info!(
            count = dead_letters.len(),
            "loaded {} dead-letter deliveries from previous session",
            dead_letters.len()
        );
    }
    // Reconcile the two persisted stores. `flush_persisted_stores` writes the
    // dead-letter snapshot before pending, so a crash between the two writes
    // can leave a terminally-failed delivery in BOTH files. The dead-letter
    // copy is authoritative for terminal deliveries, so drop any pending
    // duplicate to avoid replaying an already-dead-lettered delivery.
    let mut pending_map = load_pending_deliveries(&paths.pending);
    let mut reconciled = 0usize;
    if !dead_letters.is_empty() && !pending_map.is_empty() {
        let dead_ids: HashSet<DeliveryId> = dead_letters.delivery_ids().into_iter().collect();
        let before = pending_map.len();
        pending_map.retain(|id, _| !dead_ids.contains(id));
        reconciled = before - pending_map.len();
        if reconciled > 0 {
            tracing::warn!(
                reconciled,
                "dropped pending deliveries already present in the dead-letter store"
            );
        }
    }
    let mut pending_deliveries = PendingDeliveryStore::new(pending_map);
    // If reconciliation removed entries, the on-disk pending snapshot is stale;
    // mark dirty so the next flush rewrites it without the duplicates.
    if reconciled > 0 {
        pending_deliveries.mark_dirty();
    }
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
    let pending_verified_spawns = HashMap::new();
    // Per-worker inbound-delivery-mode + pending-relay-message queue. Lives
    // parallel to `workers.workers` so we can swap modes / inspect /
    // drain without touching `WorkerHandle` (which holds OS-level
    // process state). See `relay_broker::types::InboundDeliveryState`. Entries
    // are created lazily on first lookup and removed wherever workers
    // exit (`Release` arm or `reap_exited` sweep).
    let delivery_states: HashMap<WorkerName, InboundDeliveryState> = HashMap::new();
    let agent_result_tokens: HashMap<String, WorkerName> = HashMap::new();
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
        hosted_agent_event_tx,
        pty_observability: HashMap::new(),
        api_rx,
        api_open: true,
        ws_inbound_rx,
        relaycast_open: true,
        fleet_control_tx,
        node_repo_paths,
        fleet_node_name,
        node_delivery_token_present,
        node_delivery_connected: false,
        fleet_event_rx,
        fleet_control_open: true,
        terminal_control_tx,
        terminal_event_rx,
        terminal_control_open: true,
        terminal_sessions: HashMap::new(),
        terminal_snapshot_requests: HashMap::new(),
        terminal_input_requests: HashMap::new(),
        fleet_delivery_book: FleetDeliveryBook::default(),
        // Seed the live capacity with the configured max so heartbeats/load
        // updates keep reporting it (they overwrite load.max_agents from this
        // field); 0 means unlimited, matching the register manifest.
        fleet_max_agents: node_max_agents().unwrap_or(0),
        fleet_inventory: HashMap::new(),
        fleet_inventory_reconcile_retry_after: HashMap::new(),
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
        dead_letters,
        terminal_failed_deliveries,
        pending_requests,
        pending_verified_spawns,
        resize_owners: HashMap::new(),
        delivery_states,
        agent_result_tokens,
        recent_thread_messages,
        shutdown,
        lease_duration,
        last_lease_renewal,
        lease_check,
        sigterm,
        telemetry,
        obligation_store: crate::obligation::ObligationStore::default(),
    };

    runtime.run().await
}

/// Resolve the node token used to authenticate the `/v1/node/ws` connection
/// from the fast, local sources only, in precedence order:
///
/// 1. `RELAY_NODE_TOKEN` env override (operator-supplied; never persisted).
/// 2. A token previously minted for this exact `node_id` and cached on disk.
///
/// Returns `None` when neither exists. This never performs a network mint — that
/// stays off the broker's API-readiness path (see the call site) and is handled
/// in the background by the node-control client, which holds the same
/// [`crate::node_control::NodeTokenMinter`].
fn resolve_cached_node_token(
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
) -> Option<String> {
    if let Some(token) = std::env::var("RELAY_NODE_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Some(token);
    }

    let token_path = crate::node_control::default_node_token_path(node_id);
    if let Some(token) = token_path.as_deref().and_then(|path| {
        crate::node_control::load_node_token(path, node_id, workspace_id, base_url)
    }) {
        tracing::info!(node_id = %node_id, workspace_id = %workspace_id, "reusing cached node token");
        return Some(token);
    }

    None
}

fn explicit_env_node_id() -> Option<String> {
    std::env::var("RELAY_NODE_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn explicit_env_node_token_present() -> bool {
    std::env::var("RELAY_NODE_TOKEN")
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

fn resolve_broker_node_id(workspace_id: &str) -> String {
    resolve_broker_node_id_from_path(
        crate::node_control::default_node_id_path().as_deref(),
        workspace_id,
    )
}

fn resolve_broker_node_id_from_path(seed_path: Option<&Path>, workspace_id: &str) -> String {
    if let Some(node_id) = explicit_env_node_id() {
        return node_id;
    }

    match seed_path {
        Some(path) => {
            // Node-id mode — explicit vs auto:
            //   * Cloud enrollment: `relay node up` supplies RELAY_NODE_ID and
            //     RELAY_NODE_TOKEN from the enrollment store. The env node id
            //     must be sent verbatim in `node.register`, or the engine rejects
            //     the token-bound handshake with `node_id_mismatch`.
            //   * Legacy explicit / fleet: before RELAY_NODE_ID existed,
            //     operators pre-seeded the machine-id file and supplied
            //     RELAY_NODE_TOKEN. Keep honoring that file as the pinned id.
            //   * Auto / direct: with no supplied token the broker mints its own
            //     node via `create_node`; derive the id from the machine seed +
            //     cwd so one host serving multiple workspaces/dirs doesn't collide.
            let loaded = if explicit_env_node_token_present() {
                crate::node_control::load_or_create_machine_seed(path)
            } else {
                crate::node_control::load_or_create_node_id(path, workspace_id)
            };
            loaded.unwrap_or_else(|error| {
                tracing::warn!(error = %error, "failed to load fleet node machine id; using ephemeral id");
                format!("node_{}", Uuid::new_v4().simple())
            })
        }
        None => format!("node_{}", Uuid::new_v4().simple()),
    }
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

/// The harnesses the broker advertises `spawn:<harness>` capacity for when
/// `AGENT_RELAY_NODE_HARNESSES` is unset.
const DEFAULT_NODE_HARNESSES: &[&str] = &["claude", "codex", "gemini", "opencode"];

/// Build the node descriptor the broker registers as the `broker` provider.
///
/// The broker is the node's capacity executor, so this advertises what the node
/// can *run*: `spawn:<harness>` for each harness the broker can launch, plus
/// `release`, all `kind: "capacity"`. Capacity capabilities feed placement and
/// `ctx.spawnAgent` delegation and are never materialized as actions. The
/// manifest must never advertise a bare `"spawn"`: the engine treats that as a
/// generic action pinned to this node, hijacking capability-based spawn
/// placement for the whole workspace. The harness set comes from the
/// `AGENT_RELAY_NODE_HARNESSES` CSV (the CLI sets it from the project's
/// teams.json / node definition), falling back to a built-in default.
fn bootstrap_node_manifest(
    node_name: &str,
    node_id: &str,
    broker_version: &str,
    repo_keys: Vec<String>,
) -> NodeManifest {
    let mut capabilities: Vec<crate::protocol::NodeCapabilityManifest> = node_capacity_harnesses()
        .into_iter()
        .map(|harness| crate::protocol::NodeCapabilityManifest {
            name: format!("spawn:{harness}"),
            kind: Some("capacity".to_string()),
            metadata: None,
        })
        .collect();
    capabilities.push(crate::protocol::NodeCapabilityManifest {
        name: "release".to_string(),
        kind: Some("capacity".to_string()),
        metadata: None,
    });
    NodeManifest {
        name: node_name.to_string(),
        node_id: Some(node_id.to_string()),
        capabilities,
        max_agents: node_max_agents(),
        tags: None,
        // The same locally parsed map drives this keys-only registration and
        // spawn-time checkout resolution. Keep Some([]) authoritative so a
        // removed mapping clears stale control-plane advertisements.
        repo_keys: Some(repo_keys),
        version: Some(broker_version.to_string()),
    }
}

/// The harness names this broker can spawn, from `AGENT_RELAY_NODE_HARNESSES`
/// (comma-separated, order-preserving, de-duplicated) or the built-in default.
fn node_capacity_harnesses() -> Vec<String> {
    let configured: Vec<String> = std::env::var("AGENT_RELAY_NODE_HARNESSES")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let source: Vec<String> = if configured.is_empty() {
        DEFAULT_NODE_HARNESSES
            .iter()
            .map(|h| (*h).to_string())
            .collect()
    } else {
        configured
    };
    let mut seen = std::collections::HashSet::new();
    source
        .into_iter()
        .filter(|h| seen.insert(h.clone()))
        .collect()
}

/// Provider-level agent capacity, from `AGENT_RELAY_NODE_MAX_AGENTS`. Absent
/// (0/unlimited) preserves the broker's historically unbounded capacity.
fn node_max_agents() -> Option<u32> {
    std::env::var("AGENT_RELAY_NODE_MAX_AGENTS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        // 0 means unlimited, same as absent; normalize it away so the doc
        // comment holds and `Some(0)` never reads as an explicit zero-capacity.
        .filter(|&max| max > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::sync::{Mutex, MutexGuard};

    static NODE_ID_ENV_MUTEX: Mutex<()> = Mutex::new(());

    struct NodeIdEnvGuard {
        _guard: MutexGuard<'static, ()>,
        original_node_id: Option<OsString>,
        original_node_token: Option<OsString>,
    }

    impl Drop for NodeIdEnvGuard {
        fn drop(&mut self) {
            // SAFETY: These tests hold NODE_ID_ENV_MUTEX while mutating the
            // process environment, serializing access within this test module
            // until the inherited RELAY_NODE_* values have been restored.
            unsafe {
                match &self.original_node_id {
                    Some(value) => std::env::set_var("RELAY_NODE_ID", value),
                    None => std::env::remove_var("RELAY_NODE_ID"),
                }
                match &self.original_node_token {
                    Some(value) => std::env::set_var("RELAY_NODE_TOKEN", value),
                    None => std::env::remove_var("RELAY_NODE_TOKEN"),
                }
            }
        }
    }

    fn clear_node_id_env() -> NodeIdEnvGuard {
        clear_node_id_env_with_originals().0
    }

    fn clear_node_id_env_with_originals() -> (NodeIdEnvGuard, Option<OsString>, Option<OsString>) {
        let guard = NODE_ID_ENV_MUTEX.lock().unwrap();
        let original_node_id = std::env::var_os("RELAY_NODE_ID");
        let original_node_token = std::env::var_os("RELAY_NODE_TOKEN");
        // SAFETY: NODE_ID_ENV_MUTEX serializes environment mutations for these
        // tests before any code under test observes RELAY_NODE_* values.
        unsafe {
            std::env::remove_var("RELAY_NODE_ID");
            std::env::remove_var("RELAY_NODE_TOKEN");
        }
        (
            NodeIdEnvGuard {
                _guard: guard,
                original_node_id: original_node_id.clone(),
                original_node_token: original_node_token.clone(),
            },
            original_node_id,
            original_node_token,
        )
    }

    #[test]
    fn node_id_env_guard_restores_original_node_env() {
        let (env_guard, original_node_id, original_node_token) = clear_node_id_env_with_originals();
        assert!(std::env::var_os("RELAY_NODE_ID").is_none());
        assert!(std::env::var_os("RELAY_NODE_TOKEN").is_none());

        // SAFETY: env_guard holds NODE_ID_ENV_MUTEX for the duration of this
        // test, so RELAY_NODE_* mutations are serialized.
        unsafe {
            std::env::set_var("RELAY_NODE_ID", "node_test_mutation");
            std::env::set_var("RELAY_NODE_TOKEN", "nt_live_test_mutation");
        }

        drop(env_guard);

        assert_eq!(std::env::var_os("RELAY_NODE_ID"), original_node_id);
        assert_eq!(std::env::var_os("RELAY_NODE_TOKEN"), original_node_token);
    }

    #[test]
    fn bootstrap_node_manifest_advertises_capacity_not_bare_spawn() {
        // The broker registers its run capacity: `spawn:<harness>` + `release`,
        // all `kind: "capacity"`. It must never advertise a bare `"spawn"`, which
        // the engine would materialize as a generic action pinned to this node,
        // hijacking capability-based spawn placement for the whole workspace.
        let manifest =
            bootstrap_node_manifest("node-a", "node_a", "relay-broker/9.1.1", Vec::new());
        assert!(
            !manifest.capabilities.is_empty(),
            "broker manifest must advertise its capacity"
        );
        assert!(
            manifest
                .capabilities
                .iter()
                .all(|cap| cap.kind.as_deref() == Some("capacity")),
            "every advertised capability must be kind capacity, got {:?}",
            manifest.capabilities
        );
        assert!(
            manifest.capabilities.iter().all(|cap| cap.name != "spawn"),
            "manifest must not advertise a bare spawn capability"
        );
        assert!(
            manifest
                .capabilities
                .iter()
                .any(|cap| cap.name == "release"),
            "manifest must advertise release capacity"
        );
        assert!(
            manifest
                .capabilities
                .iter()
                .any(|cap| cap.name.starts_with("spawn:")),
            "manifest must advertise at least one spawn:<harness> capacity"
        );
        assert_eq!(manifest.name, "node-a");
        assert_eq!(manifest.node_id.as_deref(), Some("node_a"));
        assert_eq!(manifest.version.as_deref(), Some("relay-broker/9.1.1"));
        assert_eq!(manifest.tags, None);
        assert_eq!(manifest.repo_keys, Some(Vec::new()));
    }

    #[test]
    fn broker_node_id_prefers_explicit_relay_node_id_env() {
        let _env_guard = clear_node_id_env();
        let dir = tempfile::tempdir().unwrap();
        let seed_path = dir.path().join("machine-id");
        std::fs::write(&seed_path, "node_legacy_file\n").unwrap();
        // SAFETY: clear_node_id_env holds NODE_ID_ENV_MUTEX for the duration
        // of this test, so RELAY_NODE_* mutations are serialized.
        unsafe {
            std::env::set_var("RELAY_NODE_TOKEN", "nt_live_enrolled");
            std::env::set_var("RELAY_NODE_ID", "node_enrolled");
        }

        let node_id = resolve_broker_node_id_from_path(Some(&seed_path), "rw_test");

        assert_eq!(node_id, "node_enrolled");
    }

    #[test]
    fn broker_node_id_keeps_legacy_token_pinned_machine_file_without_env_id() {
        let _env_guard = clear_node_id_env();
        let dir = tempfile::tempdir().unwrap();
        let seed_path = dir.path().join("machine-id");
        std::fs::write(&seed_path, "node_legacy_file\n").unwrap();
        // SAFETY: clear_node_id_env holds NODE_ID_ENV_MUTEX for the duration
        // of this test, so RELAY_NODE_* mutations are serialized.
        unsafe {
            std::env::set_var("RELAY_NODE_TOKEN", "nt_live_enrolled");
        }

        let node_id = resolve_broker_node_id_from_path(Some(&seed_path), "rw_test");

        assert_eq!(node_id, "node_legacy_file");
    }

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
    fn bootstrap_node_manifest_advertises_only_keys_from_the_runtime_map() {
        let private_path = "/node-private/checkouts/factory";
        let repo_paths = BTreeMap::from([(
            "AgentWorkforce/factory".to_string(),
            PathBuf::from(private_path),
        )]);
        let manifest = bootstrap_node_manifest(
            "node-a",
            "node_a",
            "relay-broker/9.1.1",
            super::relaycast_events::node_repo_keys(&repo_paths),
        );
        let register = crate::node_control::build_node_register(
            &manifest,
            "node-default",
            "host-default",
            "relay-broker/default",
            None,
        );
        let wire = serde_json::to_string(&crate::fleet_wire::BrokerToRelaycast::NodeRegister(
            register,
        ))
        .expect("serialize node.register");

        assert!(wire.contains("AgentWorkforce/factory"), "{wire}");
        assert!(!wire.contains(private_path), "{wire}");
        assert!(!wire.contains("repo_paths"), "{wire}");
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
