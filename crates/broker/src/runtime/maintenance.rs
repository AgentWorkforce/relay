use super::*;

impl BrokerRuntime {
    pub(super) async fn handle_maintenance_tick(&mut self) {
        let paths = &self.paths;
        let state = &mut self.state;
        let sdk_out_tx = &self.sdk_out_tx;
        let ws_control_tx = &self.ws_control_tx;
        let relaycast_http = &self.relaycast_http;
        let workers = &mut self.workers;
        let telemetry = &self.telemetry;
        let crash_insights = &mut self.crash_insights;
        let pending_deliveries = &mut self.pending_deliveries;
        let pending_requests = &mut self.pending_requests;
        let delivery_states = &mut self.delivery_states;
        let delivery_retry_interval = self.delivery_retry_interval;
        let shutdown = &self.shutdown;

        let now = Instant::now();

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
                workers,
                pending_deliveries,
                delivery_retry_interval,
            )
            .await
            {
                Ok(Some((worker_name, attempts, event_id))) => {
                    if was_retry {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"delivery_retry",
                                "name": worker_name,
                                "delivery_id": delivery_id,
                                "event_id": event_id,
                                "attempts": attempts,
                            }),
                        )
                        .await;
                    }
                }
                Ok(None) => {
                    if was_retry {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind": "delivery_dropped",
                                "delivery_id": delivery_id,
                                "reason": "max_retries_exceeded",
                            }),
                        )
                        .await;
                    }
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

        let exited = match workers.reap_exited().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(err = %e, "reap_exited failed, skipping this cycle");
                vec![]
            }
        };
        for (name, code, signal) in &exited {
            // Record crash in insights
            let (category, description) =
                relay_broker::crash_insights::CrashInsights::analyze(*code, signal.as_deref());
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
                }
                Some(RestartDecision::PermanentlyDead { reason }) => {
                    workers.metrics.on_permanent_death(name);
                    let dropped = drop_pending_for_worker(pending_deliveries, name);
                    if dropped > 0 {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"delivery_dropped",
                                "name": name,
                                "count": dropped,
                                "reason":"worker_permanently_dead",
                            }),
                        )
                        .await;
                    }
                    fail_pending_requests_for_worker(
                        pending_requests,
                        name,
                        "worker_permanently_dead",
                    );
                    delivery_states.remove(name);
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
                }
                None => {
                    // Not supervised — original behavior
                    let dropped = drop_pending_for_worker(pending_deliveries, name);
                    if dropped > 0 {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"delivery_dropped",
                                "name": name,
                                "count": dropped,
                                "reason":"worker_exited",
                            }),
                        )
                        .await;
                    }
                    fail_pending_requests_for_worker(pending_requests, name, "worker_exited");
                    delivery_states.remove(name);
                    let _ = send_event(
                        sdk_out_tx,
                        json!({"kind":"agent_exited","name":name,"code":code,"signal":signal}),
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
                }
            }
        }

        // Check for agents ready to restart (past cooldown)
        if !*shutdown {
            let pending_restarts = workers.supervisor.pending_restarts();
            for (name, rst) in pending_restarts {
                if let Some(remaining) = relaycast_http.registration_block_remaining(&name) {
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

        // Persist pending deliveries for crash recovery
        if paths.persist {
            if let Err(error) = save_pending_deliveries(&paths.pending, pending_deliveries) {
                tracing::warn!(path = %paths.pending.display(), error = %error, "failed to persist pending deliveries");
            }
        }
    }
}
