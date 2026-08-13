use super::fleet::{release_terminal_resize_ownership, try_send_terminal};
use super::*;
use crate::terminal_control::TerminalToCloud;

impl BrokerRuntime {
    pub(super) async fn handle_maintenance_tick(&mut self) {
        let paths = &self.paths;
        let state = &mut self.state;
        let sdk_out_tx = &self.sdk_out_tx;
        let ws_control_tx = &self.ws_control_tx;
        let relaycast_http = &self.relaycast_http;
        let hosted_agent_event_tx = &self.hosted_agent_event_tx;
        let pty_observability = &mut self.pty_observability;
        let workers = &mut self.workers;
        let fleet_control_tx = &self.fleet_control_tx;
        let fleet_inventory = &mut self.fleet_inventory;
        let fleet_delivery_book = &mut self.fleet_delivery_book;
        let fleet_max_agents = self.fleet_max_agents;
        // The broker provider's capacity handlers are live whenever it is
        // connected, so node heartbeats always report handlers_live.
        let fleet_handlers_live = true;
        let telemetry = &self.telemetry;
        let crash_insights = &mut self.crash_insights;
        let pending_deliveries = &mut self.pending_deliveries;
        let dead_letters = &mut self.dead_letters;
        let pending_requests = &mut self.pending_requests;
        let pending_verified_spawns = &mut self.pending_verified_spawns;
        let delivery_states = &mut self.delivery_states;
        let resize_owners = &mut self.resize_owners;
        let agent_result_tokens = &mut self.agent_result_tokens;
        let terminal_control_tx = &self.terminal_control_tx;
        let terminal_sessions = &mut self.terminal_sessions;
        let terminal_snapshot_requests = &mut self.terminal_snapshot_requests;
        let terminal_input_requests = &mut self.terminal_input_requests;
        let delivery_retry_interval = self.delivery_retry_interval;
        let shutdown = &self.shutdown;
        let default_workspace = &self.default_workspace;

        let now = Instant::now();

        // A worker can disappear before answering `snapshot_pty`. Bound these
        // terminal-only RPCs so their sessions cannot remain live forever.
        let expired_terminal_snapshots: Vec<(String, String)> = terminal_snapshot_requests
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(request_id, pending)| (request_id.clone(), pending.session_id.clone()))
            .collect();
        for (request_id, session_id) in expired_terminal_snapshots {
            terminal_snapshot_requests.remove(&request_id);
            if let Some(session) = terminal_sessions.remove(&session_id) {
                release_terminal_resize_ownership(resize_owners, &session.agent, &session_id);
                terminal_input_requests.retain(|_, pending| pending.session_id != session_id);
                if !try_send_terminal(
                    terminal_control_tx,
                    TerminalToCloud::Error {
                        session_id: session_id.clone(),
                        code: "snapshot_timeout".into(),
                        message: "terminal snapshot timed out".into(),
                        request_id: None,
                    },
                ) {
                    tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal queue full or closed while reporting snapshot timeout");
                }
                if !try_send_terminal(
                    terminal_control_tx,
                    TerminalToCloud::Closed {
                        session_id: session_id.clone(),
                        code: Some("snapshot_timeout".into()),
                        message: Some("terminal snapshot timed out".into()),
                    },
                ) {
                    tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal close could not be queued after snapshot timeout");
                }
            }
        }
        let expired_terminal_inputs: Vec<(String, String)> = terminal_input_requests
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(request_id, pending)| (request_id.clone(), pending.session_id.clone()))
            .collect();
        for (request_id, session_id) in expired_terminal_inputs {
            terminal_input_requests.remove(&request_id);
            // A timed-out write may still reach the PTY after cancellation. End
            // the whole session before reporting it so a retry cannot duplicate
            // user keystrokes against that uncertain write.
            if let Some(session) = terminal_sessions.remove(&session_id) {
                release_terminal_resize_ownership(resize_owners, &session.agent, &session_id);
                terminal_snapshot_requests.retain(|_, pending| pending.session_id != session_id);
                terminal_input_requests.retain(|_, pending| pending.session_id != session_id);
                if !try_send_terminal(
                    terminal_control_tx,
                    TerminalToCloud::Error {
                        session_id: session_id.clone(),
                        code: "input_timeout".into(),
                        message: "terminal input acknowledgement timed out".into(),
                        request_id: None,
                    },
                ) {
                    tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal queue full or closed while reporting input timeout");
                }
                if !try_send_terminal(
                    terminal_control_tx,
                    TerminalToCloud::Closed {
                        session_id: session_id.clone(),
                        code: Some("input_timeout".into()),
                        message: Some("terminal input acknowledgement timed out".into()),
                    },
                ) {
                    tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal close could not be queued after input timeout");
                }
            }
        }

        // Time out worker request/response calls whose worker never
        // responded. Common cause: worker crashed between us sending
        // the request frame and it parsing the frame. Without this
        // sweep the HTTP handler would hang forever on its oneshot.
        for (req_id, worker_name, kind) in worker_request::reap_expired(pending_requests, now) {
            tracing::warn!(
                target = "agent_relay::broker",
                request_id = %req_id,
                worker = %worker_name,
                kind = %kind,
                "worker request timed out before worker responded"
            );
        }

        let due_ids: Vec<DeliveryId> = pending_deliveries
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
                workers,
                pending_deliveries,
                delivery_retry_interval,
            )
            .await
            {
                Ok(outcome) => {
                    let _ = emit_delivery_attempt_outcome(
                        sdk_out_tx,
                        dead_letters,
                        &delivery_id,
                        was_retry,
                        outcome,
                    )
                    .await;
                }
                Err(error) => {
                    let _ = send_error(
                        sdk_out_tx,
                        None,
                        "delivery_failed",
                        error.to_string(),
                        true,
                        Some(json!({"delivery_id": delivery_id})),
                    )
                    .await;
                }
            }
        }

        let expired_verified_spawns: Vec<(WorkerName, String)> = pending_verified_spawns
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(name, pending)| (name.clone(), pending.invocation_id.clone()))
            .collect();
        for (name, invocation_id) in &expired_verified_spawns {
            pending_verified_spawns.remove(name);
            let _ = super::relaycast_events::release_worker_locally(
                name.clone(),
                default_workspace,
                workers,
                state,
                paths,
                telemetry,
                sdk_out_tx,
                pending_deliveries,
                dead_letters,
                pending_requests,
                delivery_states,
                agent_result_tokens,
            )
            .await;
            match super::fleet::deregister_fleet_agent(fleet_control_tx, fleet_delivery_book, name)
                .await
            {
                Ok(_) => {
                    super::fleet::prune_fleet_agent_state(
                        fleet_control_tx,
                        fleet_inventory,
                        fleet_delivery_book,
                        name,
                    )
                    .await
                }
                Err(error) => {
                    tracing::warn!(worker = %name, %error, "retaining fleet identity after readiness timeout cleanup");
                    super::fleet::prune_fleet_inventory_entry(
                        fleet_control_tx,
                        fleet_inventory,
                        name,
                    )
                    .await;
                }
            }
            let _ = fleet_control_tx
                .send(FleetControlCommand::Send(
                    crate::fleet_wire::BrokerToRelaycast::ActionResult(
                        super::fleet::verified_spawn_failed_result(
                            invocation_id.clone(),
                            "spawn_readiness_timeout",
                        ),
                    ),
                ))
                .await;
        }

        let exited = match workers.reap_exited().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(err = %e, "reap_exited failed, skipping this cycle");
                vec![]
            }
        };
        let mut fleet_load_changed = !expired_verified_spawns.is_empty() || !exited.is_empty();
        for (name, generation, code, signal, exit_reason) in &exited {
            let mut retain_fleet_identity = false;
            let pending = pending_verified_spawns
                .get(name)
                .is_some_and(|pending| pending.generation == *generation)
                .then(|| pending_verified_spawns.remove(name))
                .flatten();
            if let Some(pending) = pending {
                // A failed verified launch has no owner after its action is
                // failed. Do not let the normal supervisor revive it later.
                workers.supervisor.unregister(name);
                match super::fleet::deregister_fleet_agent(
                    fleet_control_tx,
                    fleet_delivery_book,
                    name,
                )
                .await
                {
                    Ok(_) => {}
                    Err(error) => {
                        tracing::warn!(worker = %name, %error, "retaining fleet identity after early verified-spawn exit");
                        retain_fleet_identity = true;
                    }
                }
                let _ = fleet_control_tx
                    .send(FleetControlCommand::Send(
                        crate::fleet_wire::BrokerToRelaycast::ActionResult(
                            super::fleet::verified_spawn_failed_result(
                                pending.invocation_id,
                                "spawn_harness_not_ready",
                            ),
                        ),
                    ))
                    .await;
            }
            let lifecycle_reason = exit_reason.as_deref().unwrap_or("worker_exited");
            if (code.is_some_and(|code| code != 0) || signal.is_some())
                && state
                    .agents
                    .get(name)
                    .is_some_and(|agent| agent.runtime == AgentRuntime::Pty)
            {
                publish_pty_error(
                    pty_observability,
                    hosted_agent_event_tx,
                    name,
                    lifecycle_reason,
                    code.map(|code| code.to_string()).or_else(|| signal.clone()),
                );
            }
            pty_observability.remove(name);
            let terminal_session_ids: Vec<String> = terminal_sessions
                .iter()
                .filter(|(_, session)| session.agent == *name)
                .map(|(session_id, _)| session_id.clone())
                .collect();
            for session_id in terminal_session_ids {
                terminal_sessions.remove(&session_id);
                terminal_snapshot_requests.retain(|_, pending| pending.session_id != session_id);
                terminal_input_requests.retain(|_, pending| pending.session_id != session_id);
                if !try_send_terminal(
                    terminal_control_tx,
                    TerminalToCloud::Closed {
                        session_id: session_id.clone(),
                        code: Some("agent_exited".into()),
                        message: Some("terminal worker exited".into()),
                    },
                ) {
                    tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal queue full or closed while closing exited worker session");
                }
            }
            // Record crash in insights
            let (category, description) =
                crate::crash_insights::CrashInsights::analyze(*code, signal.as_deref());
            crash_insights.record(crate::crash_insights::CrashRecord {
                agent_name: name.as_str().to_string(),
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
            use crate::supervisor::RestartDecision;
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
                        sdk_out_tx,
                        json!({
                            "kind": "agent_restarting",
                            "name": name,
                            "code": code,
                            "signal": signal,
                            "restart_count": restart_count,
                            "delay_ms": delay.as_millis() as u64,
                        }),
                    )
                    .await;
                    publish_agent_state_transition(
                        ws_control_tx,
                        name,
                        "stuck",
                        Some("restarting"),
                    )
                    .await;
                    // The restart opens a fresh PTY, so any prior resize owner
                    // is stale — clear it so the reattaching client can claim
                    // the new PTY's size instead of being rejected.
                    resize_owners.remove(name);
                }
                Some(RestartDecision::PermanentlyDead { reason }) => {
                    workers.metrics.on_permanent_death(name);
                    let dropped = take_pending_for_worker(pending_deliveries, name);
                    if !dropped.is_empty() {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"delivery_dropped",
                                "name": name,
                                "count": dropped.len(),
                                "reason":"worker_permanently_dead",
                            }),
                        )
                        .await;
                        let _ = emit_dropped_delivery_failures(
                            sdk_out_tx,
                            dead_letters,
                            &dropped,
                            "worker_permanently_dead",
                        )
                        .await;
                    }
                    fail_pending_requests_for_worker(
                        pending_requests,
                        name,
                        "worker_permanently_dead",
                    );
                    delivery_states.remove(name);
                    resize_owners.remove(name);
                    agent_result_tokens.retain(|_, agent| agent != name);
                    let _ = send_event(
                        sdk_out_tx,
                        json!({"kind":"agent_permanently_dead","name":name,"reason":reason}),
                    )
                    .await;
                    publish_agent_state_transition(
                        ws_control_tx,
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
                    if retain_fleet_identity {
                        super::fleet::prune_fleet_inventory_entry(
                            fleet_control_tx,
                            fleet_inventory,
                            name,
                        )
                        .await;
                    } else {
                        super::fleet::prune_fleet_agent_state(
                            fleet_control_tx,
                            fleet_inventory,
                            fleet_delivery_book,
                            name,
                        )
                        .await;
                    }
                }
                None => {
                    // Not supervised — original behavior
                    let dropped = take_pending_for_worker(pending_deliveries, name);
                    if !dropped.is_empty() {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"delivery_dropped",
                                "name": name,
                                "count": dropped.len(),
                                "reason":"worker_exited",
                            }),
                        )
                        .await;
                        let _ = emit_dropped_delivery_failures(
                            sdk_out_tx,
                            dead_letters,
                            &dropped,
                            "worker_exited",
                        )
                        .await;
                    }
                    fail_pending_requests_for_worker(pending_requests, name, "worker_exited");
                    delivery_states.remove(name);
                    resize_owners.remove(name);
                    agent_result_tokens.retain(|_, agent| agent != name);
                    let _ = send_event(
                        sdk_out_tx,
                        json!({
                            "kind":"agent_exited",
                            "name":name,
                            "code":code,
                            "signal":signal,
                            "reason": lifecycle_reason,
                            "generation": generation,
                        }),
                    )
                    .await;
                    publish_agent_state_transition(
                        ws_control_tx,
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
                    if retain_fleet_identity {
                        super::fleet::prune_fleet_inventory_entry(
                            fleet_control_tx,
                            fleet_inventory,
                            name,
                        )
                        .await;
                    } else {
                        super::fleet::prune_fleet_agent_state(
                            fleet_control_tx,
                            fleet_inventory,
                            fleet_delivery_book,
                            name,
                        )
                        .await;
                    }
                }
            }
        }
        // NOTE: the fleet load snapshot is published *after* the restart
        // handling below, not here. Reaping a dead worker and restarting it can
        // both happen within a single maintenance tick; publishing here would
        // broadcast the post-reap / pre-restart count and leave the broker
        // advertising a stale under-count until the next periodic heartbeat.

        // Check for agents ready to restart (past cooldown)
        if !*shutdown {
            let pending_restarts = workers.supervisor.pending_restarts();
            for (name, rst) in pending_restarts {
                let name = WorkerName::from(name);
                if let Some(remaining) = relaycast_http.registration_block_remaining(&name) {
                    tracing::debug!(
                        worker = %name,
                        retry_after_secs = remaining.as_secs().max(1),
                        "skipping restart while relaycast registration is rate-limited"
                    );
                    continue;
                }

                let worker_relay_key = if rst.payload.skip_relay_prompt {
                    None
                } else {
                    match relaycast_http
                        .register_agent_token(&name, rst.payload.spec.cli.as_deref())
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
                if let Some(token) = worker_relay_key.as_deref() {
                    seed_supplied_agent_token(relaycast_http, &name, token);
                    if let Err(error) = relaycast_http
                        .ensure_agent_channels(
                            &name,
                            rst.payload.spec.cli.as_deref(),
                            &rst.payload.spec.channels,
                        )
                        .await
                    {
                        tracing::error!(
                            worker = %name,
                            channels = ?rst.payload.spec.channels,
                            error = %error,
                            "worker channel membership reconciliation failed before restart"
                        );
                    }
                }

                match workers
                    .spawn(
                        rst.payload.spec.clone(),
                        rst.payload.parent.clone(),
                        None,
                        worker_relay_key,
                        rst.payload.skip_relay_prompt,
                        None,
                        rst.payload.agent_result.clone(),
                    )
                    .await
                {
                    Ok(effective_spec) => {
                        fleet_load_changed = true;
                        workers.supervisor.on_restarted(&name);
                        workers.metrics.on_restart(&name);
                        let initial_task = rst.payload.initial_task.clone();
                        if let Some(task) = initial_task.clone() {
                            workers.initial_tasks.insert(name.clone(), task);
                        }
                        let pid = workers.worker_pid(&name);
                        let restart_policy = state
                            .agents
                            .get(&name)
                            .and_then(|agent| agent.restart_policy.clone())
                            .or_else(|| effective_spec.restart_policy.clone());
                        state
                            .agents
                            .entry(name.clone())
                            .and_modify(|agent| {
                                agent.runtime = effective_spec.runtime.clone();
                                agent.parent = rst.payload.parent.clone();
                                agent.channels = effective_spec.channels.clone();
                                agent.pid = pid;
                                agent.started_at = Some(unix_timestamp_secs());
                                agent.spec = Some(effective_spec.clone());
                                agent.restart_policy = restart_policy.clone();
                                agent.initial_task = initial_task.clone();
                            })
                            .or_insert_with(|| broker::PersistedAgent {
                                runtime: effective_spec.runtime.clone(),
                                parent: rst.payload.parent.clone(),
                                channels: effective_spec.channels.clone(),
                                pid,
                                started_at: Some(unix_timestamp_secs()),
                                spec: Some(effective_spec.clone()),
                                restart_policy,
                                initial_task,
                            });
                        if paths.persist {
                            if let Err(error) = state.save(&paths.state) {
                                tracing::warn!(
                                    path = %paths.state.display(),
                                    worker = %name,
                                    error = %error,
                                    "failed to persist restarted worker state"
                                );
                            }
                        }
                        tracing::info!(name = %name, restart_count = rst.restart_count, "agent restarted");
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind": "agent_restarted",
                                "name": name,
                                "restart_count": rst.restart_count,
                            }),
                        )
                        .await;
                        publish_agent_state_transition(
                            ws_control_tx,
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

        // Publish the fleet load snapshot once, after both reaping and restart
        // handling, so the broadcast count reflects the final post-restart live
        // worker set rather than a same-tick post-reap intermediate.
        if fleet_load_changed {
            super::fleet::publish_fleet_load_snapshot(
                fleet_control_tx,
                u32::try_from(workers.workers.len()).unwrap_or(u32::MAX),
                fleet_max_agents,
                fleet_handlers_live,
                true,
            )
            .await;
        }

        // Pending deliveries are persisted by the event loop whenever the
        // map is mutated (see `BrokerRuntime::flush_pending_deliveries`),
        // so no tick-time snapshot is needed here.

        // Obligation boomerang: GC is unconditional; drain only when feature is
        // enabled.  The obligation store lives on BrokerRuntime and must be
        // accessed through `self` here (the local-reference reborrow at the top
        // of this function does not cover it).
        self.obligation_store.gc(now);
        if crate::obligation::boomerang_enabled() {
            let interval = std::time::Duration::from_millis(crate::obligation::interval_ms());
            let due = self.obligation_store.drain_due(now, interval);
            for (msg_id, recipient) in due {
                let boomerang_body = crate::obligation::build_return_body(&msg_id);
                let delivery_id = DeliveryId::new(uuid::Uuid::new_v4().to_string());
                let event_id = EventId::new(uuid::Uuid::new_v4().to_string());
                let relay_delivery = crate::protocol::RelayDelivery {
                    delivery_id,
                    event_id: event_id.clone(),
                    workspace_id: self.default_workspace_id.clone(),
                    workspace_alias: self.default_workspace.workspace_alias.clone(),
                    from: "broker".to_string(),
                    target: crate::ids::MessageTarget::new(recipient.clone()),
                    body: boomerang_body.clone(),
                    thread_id: None,
                    priority: Some(2),
                    injection_mode: crate::protocol::MessageInjectionMode::Wait,
                };
                tracing::info!(
                    target = "relay_broker::obligation",
                    recipient = %recipient,
                    obligation_msg_id = %msg_id,
                    "injecting boomerang return to recipient"
                );
                if let Err(error) = self.workers.deliver(&recipient, relay_delivery).await {
                    tracing::warn!(
                        target = "relay_broker::obligation",
                        recipient = %recipient,
                        obligation_msg_id = %msg_id,
                        error = %error,
                        "failed to inject boomerang return"
                    );
                } else {
                    // Emit a relay_inbound event so waitForReturn in the harness
                    // driver can detect the boomerang injection.
                    let _ = send_event(
                        &self.sdk_out_tx,
                        serde_json::json!({
                            "kind": "relay_inbound",
                            "target": recipient,
                            "obligation_msg_id": msg_id,
                            "event_id": event_id.as_str(),
                            "body": boomerang_body,
                        }),
                    )
                    .await;
                }
            }
        }
    }
}
