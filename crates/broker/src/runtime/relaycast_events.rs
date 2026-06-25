use super::*;

impl BrokerRuntime {
    pub(super) async fn handle_relaycast_message(&mut self, ws_msg: WorkspaceInboundMessage) {
        let fleet_mode_active = self.fleet_mode_enabled;
        let workspace_lookup = &self.workspace_lookup;
        let default_workspace = &self.default_workspace;
        let sdk_out_tx = &self.sdk_out_tx;
        let workers = &mut self.workers;
        let telemetry = &self.telemetry;
        let dedup = &mut self.dedup;
        let pending_deliveries = &mut self.pending_deliveries;
        let delivery_states = &mut self.delivery_states;
        let dm_participants_cache = &mut self.dm_participants_cache;
        let recent_thread_messages = &mut self.recent_thread_messages;
        let delivery_retry_interval = self.delivery_retry_interval;

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

        let control_dedup_key =
            if matches!(ws_type, "agent.spawn_requested" | "agent.release_requested") {
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
                return;
            }
        }

        // The v5.0.1 SDK no longer surfaces `agent.spawn_requested` /
        // `agent.release_requested` as typed `WsEvent` variants — in v5 they
        // deserialize to the catch-all `WsEvent::Unknown`, and node control
        // owns spawn and release outright by invoking `spawn_worker_from_request`
        // / `release_worker_locally` from the `action.invoke` node delivery path.
        // The workspace firehose no longer drives these control events, so if one
        // still arrives here we deliberately ignore it (already deduped above)
        // rather than letting it fall through to `map_ws_event`.
        if matches!(ws_type, "agent.spawn_requested" | "agent.release_requested") {
            tracing::debug!(
                target = "agent_relay::broker",
                ws_type = %ws_type,
                workspace_id = %workspace_id,
                "ignoring control event on workspace firehose; node control owns spawn/release"
            );
            return;
        }

        if fleet_mode_active {
            tracing::debug!(
                target = "relay_broker::fleet",
                ws_type = %ws_type,
                workspace_id = %workspace_id,
                "ignoring workspace-stream inbound message in fleet mode; node control owns delivery"
            );
            return;
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
                return;
            }
            let has_local_target = if mapped.target.starts_with('#') {
                !workers
                    .worker_names_for_channel_delivery(
                        &mapped.target,
                        &mapped.from,
                        Some(&workspace_id),
                    )
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
                return;
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
                    delivery_plan.display_target = MessageTarget::new(chan_target);
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
                    dm_participants_cache,
                    &workspace_id,
                    &conversation_id,
                )
                .await;
                tracing::info!(participants = ?participants, "resolved DM participants");

                if let Some(participant) = participants
                    .iter()
                    .find(|participant| !agent_name_eq(participant, &mapped.from))
                {
                    delivery_plan.display_target = MessageTarget::new(participant.clone());
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

            let local_delivery_timeout = http_api_local_delivery_timeout();
            for worker_name in delivery_plan.targets {
                // Inbound-delivery queue: mirrors the /api/send
                // queue above. Auto-inject workers drain the queue
                // immediately; manual-flush workers leave relaycast
                // messages parked until flush. The same full-context
                // capture makes drains reproduce the original
                // delivery (channel/thread/workspace).
                let queue_result = queue_inbound_for_delivery_mode(
                    delivery_states,
                    workers,
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
                );
                if let Some(dropped_from) = &queue_result.evicted_from {
                    let _ = send_broker_event(
                        sdk_out_tx,
                        delivery_dropped_event_for_eviction(&worker_name, dropped_from),
                    )
                    .await;
                }
                match queue_result.outcome {
                    InboundQueueOutcome::Queued => {
                        tracing::info!(
                            target = "agent_relay::broker",
                            event_id = %mapped.event_id,
                            worker = %worker_name,
                            "queued inbound relay message (manual_flush inbound delivery mode)"
                        );
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"delivery_queued",
                                "name":&worker_name,
                                "event_id":&mapped.event_id,
                                "from":&mapped.from,
                                "target":&mapped.target,
                                "reason":"inbound_delivery_manual_flush",
                            }),
                        )
                        .await;
                        continue;
                    }
                    InboundQueueOutcome::DrainNow(to_drain) => {
                        for queued in to_drain {
                            match timeout(
                                local_delivery_timeout,
                                try_inject_pending_relay_message(
                                    workers,
                                    pending_deliveries,
                                    &worker_name,
                                    &queued,
                                    delivery_retry_interval,
                                ),
                            )
                            .await
                            {
                                Ok(Ok(())) => {}
                                Ok(Err(error)) => {
                                    let _ = send_error(
                                        sdk_out_tx,
                                        None,
                                        "delivery_failed",
                                        error.to_string(),
                                        true,
                                        Some(json!({"worker": worker_name})),
                                    )
                                    .await;
                                }
                                Err(_) => {
                                    let _ = send_error(
                                        sdk_out_tx,
                                        None,
                                        "delivery_failed",
                                        format!(
                                            "relaycast delivery timed out after {}ms",
                                            local_delivery_timeout.as_millis()
                                        ),
                                        true,
                                        Some(json!({"worker": worker_name})),
                                    )
                                    .await;
                                }
                            }
                        }
                        continue;
                    }
                    InboundQueueOutcome::WorkerMissing => {}
                }
                match timeout(
                    local_delivery_timeout,
                    queue_and_try_delivery(
                        workers,
                        pending_deliveries,
                        &worker_name,
                        &mapped,
                        delivery_retry_interval,
                    ),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        let _ = send_error(
                            sdk_out_tx,
                            None,
                            "delivery_failed",
                            error.to_string(),
                            true,
                            Some(json!({"worker": worker_name})),
                        )
                        .await;
                    }
                    Err(_) => {
                        let _ = send_error(
                            sdk_out_tx,
                            None,
                            "delivery_failed",
                            format!(
                                "relaycast delivery timed out after {}ms",
                                local_delivery_timeout.as_millis()
                            ),
                            true,
                            Some(json!({"worker": worker_name})),
                        )
                        .await;
                    }
                }
            }

            let display_target = display_target_for_dashboard(
                &delivery_plan.display_target,
                &workspace_self_names,
                &workspace_self_name,
            );
            let display_from = if is_self_name(&workspace_self_names, &mapped.from) {
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
                recent_thread_messages,
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
                sdk_out_tx,
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
            )
            .await;
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

fn relaycast_harness_config(value: &Value) -> Result<Option<ResolvedHarnessConfig>, String> {
    let agent = value.get("agent");
    let harness_id = agent
        .and_then(|agent| {
            agent
                .get("harnessId")
                .or_else(|| agent.get("harness_id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("harnessId")
                .or_else(|| value.get("harness_id"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if harness_id.is_some() {
        return Err(
            "harnessId is not supported by Relaycast spawns; send harnessConfig".to_string(),
        );
    }

    let raw = agent
        .and_then(|agent| {
            agent
                .get("harnessConfig")
                .or_else(|| agent.get("harness_config"))
        })
        .or_else(|| {
            value
                .get("harnessConfig")
                .or_else(|| value.get("harness_config"))
        });

    match raw {
        Some(config) => serde_json::from_value::<ResolvedHarnessConfig>(config.clone())
            .map(Some)
            .map_err(|error| format!("Invalid harnessConfig: {error}")),
        None => Ok(None),
    }
}

/// Release a worker that the fleet/node control plane asked the broker to drop.
///
/// Extracted verbatim from the former `WsEvent::AgentReleaseRequested` firehose
/// arm. The v5.0.1 SDK removed that event variant; node control invokes this
/// directly via `action.invoke`. `workspace_state` supplies the per-workspace
/// HTTP client, self-name set, and WS control channel the original arm captured.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub(super) async fn release_worker_locally(
    name: WorkerName,
    workspace_state: &RelayWorkspace,
    workers: &mut WorkerRegistry,
    state: &mut broker::BrokerState,
    paths: &RuntimePaths,
    telemetry: &TelemetryClient,
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    pending_requests: &mut HashMap<String, worker_request::PendingRequest>,
    delivery_states: &mut HashMap<WorkerName, InboundDeliveryState>,
    agent_result_tokens: &mut HashMap<String, WorkerName>,
) {
    let workspace_http = &workspace_state.http_client;
    if is_relaycast_self_control_target(
        &name,
        &workspace_state.self_name,
        &workspace_state.self_names,
    ) {
        workspace_http.forget_agent_registration(&name);
        tracing::debug!(
            worker = %name,
            "ignoring relaycast release request for broker self"
        );
        return;
    }
    workers.supervisor.unregister(&name);
    workers.metrics.on_release(&name);
    match workers.release(&name).await {
        Ok(()) => {
            workspace_http.forget_agent_registration(&name);
            let dropped = take_pending_for_worker(pending_deliveries, &name);
            if !dropped.is_empty() {
                let _ = send_event(
                                sdk_out_tx,
                                json!({"kind":"delivery_dropped","name":name,"count":dropped.len(),"reason":"agent_released"}),
                            ).await;
                let _ = emit_dropped_delivery_failures(sdk_out_tx, &dropped, "agent_released").await;
            }
            fail_pending_requests_for_worker(pending_requests, &name, "relaycast_release");
            delivery_states.remove(&name);
            agent_result_tokens.retain(|_, agent| agent != &name);
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
            let _ = send_event(sdk_out_tx, json!({"kind":"agent_released","name":name})).await;
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
}

/// Spawn a worker the fleet/node control plane requested.
///
/// Extracted verbatim from the former `WsEvent::AgentSpawnRequested` firehose
/// arm. The v5.0.1 SDK removed that event variant; node control invokes this
/// directly via `action.invoke`. The spawn fields (`cli`, `task`, `channel`,
/// `model`) previously came off the typed event payload and are now passed in;
/// `ws_value` is retained for `harnessConfig`/token extraction exactly as
/// before. `control_dedup_key` carries the firehose control dedup key so the
/// local spawn-echo dedup behaves identically.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub(super) async fn spawn_worker_from_request(
    name: WorkerName,
    cli: String,
    task: Option<String>,
    channel: Option<String>,
    model: Option<String>,
    ws_value: &Value,
    workspace_id: &WorkspaceId,
    control_dedup_key: Option<&str>,
    workspace_state: &RelayWorkspace,
    workers: &mut WorkerRegistry,
    state: &mut broker::BrokerState,
    paths: &RuntimePaths,
    telemetry: &TelemetryClient,
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    dedup: &mut DedupCache,
    agent_spawn_count: &mut u32,
) {
    let workspace_http = &workspace_state.http_client;
    eprintln!(
        "[agent-relay] received spawn request for '{}' (cli: {})",
        name, cli
    );
    if is_relaycast_self_control_target(
        &name,
        &workspace_state.self_name,
        &workspace_state.self_names,
    ) {
        tracing::debug!(
            worker = %name,
            "ignoring relaycast spawn request for broker self"
        );
        eprintln!(
            "[agent-relay] ignoring spawn request for '{}' (broker self)",
            name
        );
        return;
    }
    let local_spawn_echo_key = relaycast_spawn_control_dedup_key(workspace_id, &name);
    if relaycast_ws_should_apply_local_spawn_echo_dedup(control_dedup_key, &local_spawn_echo_key)
        && !dedup.insert_if_new(&local_spawn_echo_key, Instant::now())
    {
        tracing::info!(
            worker = %name,
            workspace_id = %workspace_id,
            "dropping duplicate/local relaycast spawn request"
        );
        eprintln!(
            "[agent-relay] dropping duplicate spawn request for '{}'",
            name
        );
        return;
    }
    let task = task.filter(|value| !value.trim().is_empty());
    // Carry the requested model through so the launched CLI is
    // started with `--model` (see worker.rs). An empty/blank
    // model is treated as unset.
    let model = model.filter(|value| !value.trim().is_empty());
    let harness_config = match relaycast_harness_config(ws_value) {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(
                worker = %name,
                error = %error,
                "rejecting relaycast spawn with invalid harness config"
            );
            eprintln!(
                "[agent-relay] rejecting spawn request for '{}': {}",
                name, error
            );
            return;
        }
    };
    let runtime = harness_config
        .as_ref()
        .map(ResolvedHarnessConfig::runtime)
        .unwrap_or(AgentRuntime::Pty);
    let session_id = harness_config
        .as_ref()
        .and_then(ResolvedHarnessConfig::session_id)
        .map(ToOwned::to_owned);

    tracing::info!(name = %name, cli = %cli, task = ?task, channel = ?channel, "handling spawn request from relaycast WS");
    let channels = channel
        .as_deref()
        .map(|ch| {
            let mut chs = default_spawn_channels();
            let candidate = ChannelName::from(ch);
            if !chs.contains(&candidate) {
                chs.push(candidate);
            }
            chs
        })
        .unwrap_or_else(default_spawn_channels);
    let spec = AgentSpec {
        name: name.clone(),
        runtime: runtime.clone(),
        provider: None,
        cli: Some(cli.clone()),
        session_id,
        harness_config,
        model,
        cwd: None,
        team: None,
        shadow_of: None,
        shadow_mode: None,
        args: vec![],
        channels: channels.clone(),
        restart_policy: None,
    };
    let mut effective_task = normalize_initial_task(task.clone());

    // Pre-register an agent token for every spawned worker.
    // The Agent Relay MCP server needs RELAY_AGENT_TOKEN +
    // RELAY_SKIP_BOOTSTRAP=1 in its environment to expose
    // tools immediately; otherwise it runs network
    // registration before responding to the MCP initialize
    // handshake, the client drops the pending server, and
    // no relaycast tool names land in deferred_tools. The
    // short timeout keeps spawn latency bounded while still
    // giving the registration call a real chance.
    let worker_relay_key = {
        if let Some(token) = relaycast_ws_spawn_token(ws_value) {
            seed_supplied_agent_token(workspace_http, &name, &token);
            Some(token)
        } else {
            const REG_TIMEOUT: Duration = Duration::from_secs(3);
            match tokio::time::timeout(
                REG_TIMEOUT,
                workspace_http.register_agent_token(&name, Some(cli.as_str())),
            )
            .await
            {
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

    match workers
        .spawn(
            spec,
            Some("Relaycast".to_string()),
            None,
            worker_relay_key.clone(),
            false,
            Some(workspace_id.clone()),
            None,
        )
        .await
    {
        Ok(effective_spec) => {
            if let Some(prefix) = super::api::relay_skill_prefix(
                effective_spec.cli.as_deref().unwrap_or(&cli),
                effective_spec.model.as_deref(),
            ) {
                effective_task = Some(match effective_task {
                    Some(task) => format!("{prefix}\n\n{task}"),
                    None => prefix,
                });
                tracing::debug!(
                    agent = %name,
                    cli = %effective_spec.cli.as_deref().unwrap_or(&cli),
                    model = ?effective_spec.model,
                    "injected relay skill prefix for Relaycast spawn"
                );
            }
            if let Some(ref task_text) = effective_task {
                workers
                    .initial_tasks
                    .insert(name.clone(), task_text.clone());
            }
            *agent_spawn_count += 1;
            telemetry.track(TelemetryEvent::AgentSpawn {
                cli: cli.clone(),
                runtime: runtime_label(&effective_spec.runtime).to_string(),
                spawn_source: ActionSource::Protocol,
                has_task: effective_task.is_some(),
                is_shadow: false,
            });
            let pid = workers.harness_pid(&name);
            state.agents.insert(
                name.clone(),
                broker::PersistedAgent {
                    runtime: effective_spec.runtime.clone(),
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
            if paths.persist {
                let _ = state.save(&paths.state);
            }
            let _ = send_event(
                sdk_out_tx,
                json!({
                    "kind": "agent_spawned",
                    "name": name,
                    "runtime": runtime_label(&effective_spec.runtime),
                    "cli": cli,
                    "model": effective_spec.model.clone(),
                    "sessionId": effective_spec.session_id.clone(),
                    "pid": pid,
                    "source": "relaycast_ws",
                    "pre_registered": worker_relay_key.is_some(),
                }),
            )
            .await;
            publish_agent_state_transition(
                &workspace_state.ws_control_tx,
                &name,
                "spawned",
                Some("relaycast_spawn"),
            )
            .await;
            tracing::info!(child = %name, pid = ?pid, "spawned worker via relaycast WS");
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::relaycast::WsEvent;

    #[test]
    fn relaycast_harness_config_accepts_inline_config() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "ClaudeReviewer",
                "cli": "company-claude",
                "harnessConfig": {
                    "runtime": "pty",
                    "command": "claude",
                    "args": []
                }
            }
        });

        let config = relaycast_harness_config(&value)
            .expect("inline config should parse")
            .expect("inline config should return config");

        assert_eq!(config.runtime(), AgentRuntime::Pty);
    }

    #[test]
    fn relaycast_harness_config_rejects_harness_id() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "ClaudeReviewer",
                "cli": "company-claude",
                "harnessId": "company-claude"
            }
        });

        let error = relaycast_harness_config(&value).expect_err("harnessId should fail");

        assert!(error.contains("harnessId is not supported"));
    }

    /// Regression guard for the v5.0.1 firehose control path.
    ///
    /// In relaycast v5 `WsEvent` ends in `#[serde(other)] Unknown`, so an
    /// `agent.spawn_requested` frame deserializes to `Ok(WsEvent::Unknown)`
    /// rather than `Err`. The former firehose handler gated its raw-JSON spawn
    /// fallback on `from_value::<WsEvent>(..).is_ok()`, which is now always true
    /// — making that fallback dead code. This test pins the deserialization
    /// behavior so the dispatch in `handle_relaycast_message` must classify
    /// these control events by `ws_type`, not by `WsEvent` decode success.
    #[test]
    fn spawn_requested_frame_deserializes_to_unknown_not_err() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": { "name": "ClaudeReviewer", "cli": "claude" }
        });

        let decoded: Result<WsEvent, _> = serde_json::from_value(value);
        assert!(
            matches!(decoded, Ok(WsEvent::Unknown)),
            "v5 must decode agent.spawn_requested as Unknown; got {decoded:?}"
        );
    }

    /// The release control event likewise falls into the catch-all variant in
    /// v5, confirming both control types are owned by node control (via
    /// `action.invoke`) and intentionally ignored on the workspace firehose.
    #[test]
    fn release_requested_frame_deserializes_to_unknown_not_err() {
        let value = json!({
            "type": "agent.release_requested",
            "agent": { "name": "ClaudeReviewer" }
        });

        let decoded: Result<WsEvent, _> = serde_json::from_value(value);
        assert!(
            matches!(decoded, Ok(WsEvent::Unknown)),
            "v5 must decode agent.release_requested as Unknown; got {decoded:?}"
        );
    }
}
