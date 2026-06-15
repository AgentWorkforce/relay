use super::*;

impl BrokerRuntime {
    pub(super) async fn handle_api_request(&mut self, req: ListenApiRequest) {
        let paths = &self.paths;
        let state = &mut self.state;
        let workspaces = &self.workspaces;
        let workspace_lookup = &self.workspace_lookup;
        let default_workspace = &self.default_workspace;
        let default_workspace_id = &self.default_workspace_id;
        let self_names = &self.self_names;
        let relaycast_http = &self.relaycast_http;
        let ws_control_tx = &self.ws_control_tx;
        let sdk_out_tx = &self.sdk_out_tx;
        let workers = &mut self.workers;
        let telemetry = &self.telemetry;
        let agent_spawn_count = &mut self.agent_spawn_count;
        let pending_deliveries = &mut self.pending_deliveries;
        let pending_requests = &mut self.pending_requests;
        let delivery_states = &mut self.delivery_states;
        let agent_result_tokens = &mut self.agent_result_tokens;
        let dedup = &mut self.dedup;
        let recent_thread_messages = &mut self.recent_thread_messages;
        let delivery_retry_interval = self.delivery_retry_interval;
        let last_lease_renewal = &mut self.last_lease_renewal;
        let lease_duration = self.lease_duration;
        let persist = self.persist;
        let shutdown = &mut self.shutdown;
        let crash_insights = &self.crash_insights;

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
                harness_config,
                agent_token,
                agent_result_schema,
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
                    harness_config,
                ) {
                    Ok(spec) => spec,
                    Err(error) => {
                        let _ = reply.send(Err(error.to_string()));
                        return;
                    }
                };
                let mut preregistration_warning: Option<String> = None;
                let registration_result =
                    retry_agent_registration(relaycast_http, &name, Some(&cli)).await;
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
                        return;
                    }
                };

                // Caller-supplied agent_token overrides auto-registration.
                // Seed it so broker-side read-acks later act as this exact
                // recipient identity instead of minting a replacement token.
                let worker_relay_key = if let Some(token) = agent_token {
                    seed_supplied_agent_token(relaycast_http, &name, &token);
                    Some(token)
                } else {
                    worker_relay_key
                };

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

                let spawn_workspace_id = default_workspace_id.clone().or_else(|| {
                    workspaces
                        .first()
                        .map(|workspace| workspace.workspace_id.clone())
                });
                let agent_result = agent_result_schema.map(|schema| AgentResultMcpConfig {
                    callback_url: workers
                        .env_value("AGENT_RELAY_RESULT_URL")
                        .unwrap_or("http://127.0.0.1:3889/api/agent-result")
                        .to_string(),
                    token: format!("arr_{}", Uuid::new_v4().simple()),
                    schema: Some(schema),
                });
                if let Some(config) = &agent_result {
                    agent_result_tokens.insert(config.token.clone(), name.clone());
                }
                match workers
                    .spawn(
                        spec,
                        Some("Dashboard".to_string()),
                        idle_threshold_secs,
                        worker_relay_key.clone(),
                        skip_relay_prompt,
                        spawn_workspace_id.clone(),
                        agent_result.clone(),
                    )
                    .await
                {
                    Ok(effective_spec) => {
                        // Prepend relay skill text for small-tier models and CLI harnesses that
                        // need explicit tool guidance to reliably call add_agent / remove_agent.
                        if let Some(prefix) = relay_skill_prefix(
                            effective_spec.cli.as_deref().unwrap_or(&cli),
                            effective_spec.model.as_deref(),
                        ) {
                            effective_task = Some(match effective_task {
                                Some(task) => format!("{prefix}\n\n{task}"),
                                None => prefix.to_string(),
                            });
                            tracing::debug!(
                                agent = %name,
                                cli = %effective_spec.cli.as_deref().unwrap_or(&cli),
                                model = ?effective_spec.model,
                                "injected relay skill prefix for model or CLI harness"
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
                            spawn_source: ActionSource::HumanDashboard,
                            has_task: effective_task.is_some(),
                            is_shadow: effective_spec.shadow_of.is_some()
                                || effective_spec.shadow_mode.is_some(),
                        });
                        let pid = workers.harness_pid(&name);
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
                        if paths.persist {
                            let _ = state.save(&paths.state);
                        }
                        note_local_spawn_control_dedup(
                            dedup,
                            spawn_workspace_id.as_deref(),
                            &name,
                            worker_relay_key.as_deref(),
                        );
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"agent_spawned",
                                "name":&name,
                                "runtime":runtime_label(&effective_spec.runtime),
                                "provider": effective_spec.provider.clone(),
                                "cli": effective_spec.cli.clone(),
                                "model": effective_spec.model.clone(),
                                "sessionId": effective_spec.session_id.clone(),
                                "pid":pid,
                                "source":"http_api",
                                "pre_registered": worker_relay_key.is_some(),
                                "registration_warning": preregistration_warning.clone(),
                            }),
                        )
                        .await;
                        publish_agent_state_transition(
                            ws_control_tx,
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
                            "sessionId": effective_spec.session_id.clone(),
                            "pid": pid,
                            "sessionId": effective_spec.session_id.clone(),
                            "pre_registered": worker_relay_key.is_some(),
                            "warning": preregistration_warning,
                        })));
                    }
                    Err(e) => {
                        if let Some(config) = &agent_result {
                            agent_result_tokens.remove(&config.token);
                        }
                        eprintln!("[agent-relay] HTTP API: failed to spawn '{}': {}", name, e);
                        let _ = reply.send(Err(e.to_string()));
                    }
                }
            }
            ListenApiRequest::SubmitAgentResult {
                token,
                name,
                data,
                final_result,
                metadata,
                reply,
            } => {
                let Some(agent_name) = agent_result_tokens.get(&token).cloned() else {
                    let _ = reply.send(Err(listen_api::AgentResultRouteError::InvalidToken));
                    return;
                };
                if let Some(requested_name) = name.as_deref() {
                    if requested_name != agent_name {
                        let _ = reply.send(Err(listen_api::AgentResultRouteError::InvalidToken));
                        return;
                    }
                }

                let result_id = format!("ar_{}", Uuid::new_v4().simple());
                let payload = json!({
                    "kind": "agent_result",
                    "name": agent_name,
                    "result_id": result_id,
                    "data": data,
                    "final": final_result,
                    "metadata": metadata,
                });
                let _ = send_event(sdk_out_tx, payload).await;
                let _ = reply.send(Ok(json!({
                    "success": true,
                    "name": agent_name,
                    "result_id": result_id,
                })));
            }
            ListenApiRequest::SetModel {
                name,
                model,
                timeout_ms,
                reply,
            } => {
                let Some(handle) = workers.workers.get_mut(&name) else {
                    let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                    return;
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
                        .with_context(|| format!("failed flushing worker '{}' stdin", name))?;
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
            ListenApiRequest::Release {
                name,
                reason,
                reply,
            } => {
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
                        let dropped = take_pending_for_worker(pending_deliveries, &name);
                        if !dropped.is_empty() {
                            let _ = send_event(
                                            sdk_out_tx,
                                            json!({"kind":"delivery_dropped","name":&name,"count":dropped.len(),"reason":"agent_released"}),
                                        ).await;
                            let _ = emit_dropped_delivery_failures(
                                sdk_out_tx,
                                &dropped,
                                "agent_released",
                            )
                            .await;
                        }
                        fail_pending_requests_for_worker(pending_requests, &name, "agent_released");
                        delivery_states.remove(&name);
                        agent_result_tokens.retain(|_, agent| agent != &name);
                        state.agents.remove(&name);
                        if paths.persist {
                            let _ = state.save(&paths.state);
                        }
                        let _ =
                            send_event(sdk_out_tx, json!({"kind":"agent_released","name":&name}))
                                .await;
                        publish_agent_state_transition(
                            ws_control_tx,
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
                            eprintln!(
                                "[agent-relay] HTTP API: failed to release '{}': {}",
                                name, e
                            );
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
                    workspace_lookup.get(workspace_id).cloned().ok_or_else(|| {
                        format!(
                            "workspace_not_found:workspace '{}' is not attached",
                            workspace_id
                        )
                    })
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
                        .ok_or_else(|| {
                            format!(
                                "workspace_not_found:workspace alias '{}' is not attached",
                                workspace_alias
                            )
                        })
                } else if workspaces.len() == 1 {
                    Ok(workspaces[0].clone())
                } else if let Some(default_workspace_id) = default_workspace_id.as_deref() {
                    workspace_lookup
                        .get(default_workspace_id)
                        .cloned()
                        .ok_or_else(|| {
                            format!(
                                "workspace_not_found: default workspace '{}' not found",
                                default_workspace_id
                            )
                        })
                } else {
                    Err("ambiguous_workspace:workspaceId or workspaceAlias is required when multiple workspaces are attached".to_string())
                };
                let selected_workspace = match selected_workspace {
                    Ok(workspace) => workspace,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
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
                    recent_thread_messages,
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
                    workers.worker_names_for_channel_delivery(
                        &normalized_to,
                        &delivery_from,
                        Some(&selected_workspace_id),
                    )
                } else {
                    workers.worker_names_for_direct_target(
                        &normalized_to,
                        &delivery_from,
                        Some(&selected_workspace_id),
                    )
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
                    let queue_result = queue_inbound_for_delivery_mode(
                        delivery_states,
                        workers,
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
                            delivered = delivered.saturating_add(1);
                            tracing::info!(
                                target = "relay_broker::http_api",
                                event_id = %event_id,
                                to = %normalized_to,
                                worker = %worker_name,
                                "queued local delivery (manual_flush inbound delivery mode)"
                            );
                            let _ = send_event(
                                sdk_out_tx,
                                json!({
                                    "kind":"delivery_queued",
                                    "name":&worker_name,
                                    "event_id":&event_id,
                                    "from":&delivery_from,
                                    "target":&normalized_to,
                                    "reason":"inbound_delivery_manual_flush",
                                }),
                            )
                            .await;
                            continue;
                        }
                        InboundQueueOutcome::DrainNow(to_drain) => {
                            for queued in to_drain {
                                let queued_event_id = queued.event_id.as_deref().unwrap_or("");
                                let is_current =
                                    queued.event_id.as_deref() == Some(event_id.as_str());
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
                                    Ok(Ok(_)) => {
                                        if is_current {
                                            delivered = delivered.saturating_add(1);
                                        }
                                    }
                                    Ok(Err(error)) => {
                                        if is_current {
                                            delivery_errors = delivery_errors.saturating_add(1);
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
                                            delivery_errors = delivery_errors.saturating_add(1);
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
                            workers,
                            pending_deliveries,
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
                        sdk_out_tx,
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
                        selected_workspace.http_client.send_with_mode(
                            &normalized_to,
                            &text,
                            mode.clone(),
                        ),
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
                                sdk_out_tx,
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
                let mut messages: Vec<Value> = recent_thread_messages.iter().cloned().collect();
                match relaycast_http.get_all_dms(200).await {
                    Ok(dm_messages) => messages.extend(dm_messages),
                    Err(error) => {
                        tracing::debug!(
                            error = %error,
                            "failed to fetch relaycast dm history for /api/threads"
                        );
                    }
                }
                let threads = build_thread_infos(&messages, self_names);
                let _ = reply.send(Ok(json!({ "threads": threads })));
            }
            ListenApiRequest::SendInput { name, data, reply } => {
                match workers
                    .workers
                    .get(&name)
                    .map(|handle| handle.spec.runtime.clone())
                {
                    None => {
                        let _ =
                            reply.send(Err(format!("agent_not_found: no worker named '{name}'")));
                    }
                    Some(AgentRuntime::Headless) => {
                        let _ = reply.send(Err(format!(
                            "unsupported_runtime: worker '{name}' is headless; pty input is only supported on PTY workers"
                        )));
                    }
                    Some(AgentRuntime::Pty) => {
                        if let Err(err) = workers
                            .send_to_worker(
                                &name,
                                "write_pty",
                                Some(RequestId::new(format!("api_{}", Uuid::new_v4().simple()))),
                                json!({ "data": data }),
                            )
                            .await
                        {
                            let _ = reply.send(Err(format!("agent_not_found: {}", err)));
                        } else {
                            let _ = reply.send(Ok(json!({
                                "name": name,
                                "bytes_written": data.len(),
                            })));
                        }
                    }
                }
            }
            ListenApiRequest::CheckPtyInputTarget { name, reply } => {
                match workers
                    .workers
                    .get(&name)
                    .map(|handle| handle.spec.runtime.clone())
                {
                    None => {
                        let _ =
                            reply.send(Err(format!("agent_not_found: no worker named '{name}'")));
                    }
                    Some(AgentRuntime::Headless) => {
                        let _ = reply.send(Err(format!(
                            "unsupported_runtime: worker '{name}' is headless; pty input streams are only supported on PTY workers"
                        )));
                    }
                    Some(AgentRuntime::Pty) => {
                        let _ = reply.send(Ok(json!({
                            "name": name,
                            "runtime": "pty",
                        })));
                    }
                }
            }
            ListenApiRequest::ResizePty {
                name,
                rows,
                cols,
                reply,
            } => {
                if rows == 0 || cols == 0 {
                    let _ =
                        reply.send(Err("invalid_dimensions: rows and cols must be >= 1".into()));
                } else {
                    match workers
                        .workers
                        .get(&name)
                        .map(|handle| handle.spec.runtime.clone())
                    {
                        None => {
                            let _ = reply
                                .send(Err(format!("agent_not_found: no worker named '{name}'")));
                        }
                        Some(AgentRuntime::Headless) => {
                            let _ = reply.send(Err(format!(
                                "unsupported_runtime: worker '{name}' is headless; resize_pty is only supported on PTY workers"
                            )));
                        }
                        Some(AgentRuntime::Pty) => {
                            if let Err(err) = workers
                                .send_to_worker(
                                    &name,
                                    "resize_pty",
                                    Some(RequestId::new(format!(
                                        "api_{}",
                                        Uuid::new_v4().simple()
                                    ))),
                                    json!({ "rows": rows, "cols": cols }),
                                )
                                .await
                            {
                                let _ = reply.send(Err(format!("agent_not_found: {}", err)));
                            } else {
                                let _ = reply.send(Ok(json!({
                                    "name": name,
                                    "rows": rows,
                                    "cols": cols,
                                })));
                            }
                        }
                    }
                }
            }
            ListenApiRequest::WorkerRequest {
                name,
                kind,
                payload,
                timeout,
                reply,
            } => {
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
                        let _ =
                            reply.send(Err(worker_request::RequestWorkerError::WorkerNotFound(
                                format!("no worker named '{name}'"),
                            )));
                    }
                    Some(AgentRuntime::Headless) => {
                        let _ = reply.send(Err(
                                        worker_request::RequestWorkerError::UnsupportedRuntime(
                                            format!("worker '{name}' is headless; {kind} is only supported on PTY workers"),
                                        ),
                                    ));
                    }
                    Some(AgentRuntime::Pty) => {
                        let request_id = RequestId::new(format!("req_{}", Uuid::new_v4().simple()));
                        if let Err(err) = workers
                            .send_to_worker(&name, &kind, Some(request_id.clone()), payload)
                            .await
                        {
                            let _ = reply.send(Err(
                                worker_request::RequestWorkerError::SendFailed(err.to_string()),
                            ));
                        } else {
                            pending_requests.insert(
                                request_id.into_string(),
                                worker_request::PendingRequest {
                                    kind,
                                    worker_name: name.into_string(),
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
                    let mut agent_metrics: Vec<AgentMetrics> =
                        workers.workers.values().map(build_agent_metrics).collect();
                    agent_metrics.sort_by(|a, b| a.name.cmp(&b.name));
                    let _ = reply.send(Ok(json!({
                        "agents": agent_metrics,
                        "broker": workers.metrics.snapshot(workers.workers.len()),
                    })));
                }
            }
            ListenApiRequest::GetStatus { reply } => {
                let pending: Vec<Value> = pending_deliveries
                    .values()
                    .map(|pd| {
                        json!({
                            "delivery_id": pd.delivery.delivery_id,
                            "worker_name": pd.worker_name,
                            "event_id": pd.delivery.event_id,
                            "from": pd.delivery.from,
                            "to": pd.delivery.target,
                            "attempts": pd.attempts,
                            "queued_at_ms": pd.queued_at_ms,
                            "age_ms": unix_timestamp_millis().saturating_sub(pd.queued_at_ms),
                            "last_error": pd.last_error,
                        })
                    })
                    .collect();
                let auth_workspaces: Vec<Value> = workspaces
                    .iter()
                    .map(|workspace| {
                        json!({
                            "workspace_id": workspace.workspace_id,
                            "workspace_alias": workspace.workspace_alias,
                            "self_name": workspace.self_name,
                            "self_agent_id": workspace.self_agent_id,
                            "authenticated": true,
                            "default": default_workspace_id
                                .as_deref()
                                .is_some_and(|id| id == workspace.workspace_id),
                        })
                    })
                    .collect();
                let _ = reply.send(Ok(json!({
                    "agent_count": workers.workers.len(),
                    "agents": workers.list(),
                    "pending_delivery_count": pending.len(),
                    "pending_deliveries": pending,
                    "auth": {
                        "authenticated": !auth_workspaces.is_empty(),
                        "workspace_count": auth_workspaces.len(),
                        "default_workspace_id": default_workspace_id,
                        "workspaces": auth_workspaces,
                    },
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
                        )
                        .await;
                    });
                }
            }
            ListenApiRequest::SubscribeChannels {
                name,
                channels,
                reply,
            } => {
                let (workspace_id, parent, spec, pid, added, all_channels) = {
                    let Some(handle) = workers.workers.get_mut(&name) else {
                        let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                        return;
                    };
                    let mut added = Vec::new();
                    for ch in &channels {
                        let exists = handle
                            .spec
                            .channels
                            .iter()
                            .any(|c| c.eq_ignore_ascii_case(ch));
                        if !exists {
                            handle.spec.channels.push(ch.clone());
                            added.push(ch.clone());
                        }
                    }
                    (
                        handle.workspace_id.clone(),
                        handle.parent.clone(),
                        handle.spec.clone(),
                        handle.child.id(),
                        added,
                        handle.spec.channels.clone(),
                    )
                };

                if !added.is_empty() {
                    let workspace = workspace_for_channel_update(
                        workspace_id.as_deref(),
                        workspace_lookup,
                        default_workspace_id.as_deref(),
                        default_workspace,
                    );
                    if let Err(error) = workspace.http_client.ensure_extra_channels(&added).await {
                        tracing::warn!(
                            worker = %name,
                            workspace_id = %workspace.workspace_id,
                            channels = ?added,
                            error = %error,
                            "failed to ensure subscribed channels"
                        );
                    }
                    if let Err(error) = workspace
                        .ws_control_tx
                        .send(WsControl::Subscribe(added.clone()))
                        .await
                    {
                        tracing::warn!(
                            worker = %name,
                            workspace_id = %workspace.workspace_id,
                            channels = ?added,
                            error = %error,
                            "failed to send ws channel subscribe control"
                        );
                    }
                }

                persist_agent_channels(state, &name, parent, spec, pid, all_channels.clone());
                if paths.persist {
                    if let Err(error) = state.save(&paths.state) {
                        tracing::warn!(
                            path = %paths.state.display(),
                            worker = %name,
                            error = %error,
                            "failed to persist channel subscriptions"
                        );
                    }
                }
                let _ = reply.send(Ok(json!({
                    "name": name,
                    "channels": all_channels,
                })));
            }
            ListenApiRequest::UnsubscribeChannels {
                name,
                channels,
                reply,
            } => {
                let (workspace_id, parent, spec, pid, removed, remaining) = {
                    let Some(handle) = workers.workers.get_mut(&name) else {
                        let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                        return;
                    };
                    let before = handle.spec.channels.clone();
                    handle
                        .spec
                        .channels
                        .retain(|c| !channels.iter().any(|rem| rem.eq_ignore_ascii_case(c)));
                    let remaining = handle.spec.channels.clone();
                    let removed = before
                        .into_iter()
                        .filter(|channel| {
                            !remaining
                                .iter()
                                .any(|kept| kept.eq_ignore_ascii_case(channel))
                        })
                        .collect::<Vec<_>>();
                    (
                        handle.workspace_id.clone(),
                        handle.parent.clone(),
                        handle.spec.clone(),
                        handle.child.id(),
                        removed,
                        remaining,
                    )
                };

                if !removed.is_empty() {
                    let workspace = workspace_for_channel_update(
                        workspace_id.as_deref(),
                        workspace_lookup,
                        default_workspace_id.as_deref(),
                        default_workspace,
                    );
                    let target_workspace_id = effective_channel_workspace_id(
                        workspace_id.as_deref(),
                        default_workspace_id.as_deref(),
                    );
                    let unsubscribe = removed
                        .iter()
                        .filter(|channel| {
                            !workers.workers.values().any(|handle| {
                                effective_channel_workspace_id(
                                    handle.workspace_id.as_deref(),
                                    default_workspace_id.as_deref(),
                                ) == target_workspace_id
                                    && channel_in_list(&handle.spec.channels, channel)
                            })
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if !unsubscribe.is_empty() {
                        if let Err(error) = workspace
                            .ws_control_tx
                            .send(WsControl::Unsubscribe(unsubscribe.clone()))
                            .await
                        {
                            tracing::warn!(
                                worker = %name,
                                workspace_id = %workspace.workspace_id,
                                channels = ?unsubscribe,
                                error = %error,
                                "failed to send ws channel unsubscribe control"
                            );
                        }
                    }
                }

                persist_agent_channels(state, &name, parent, spec, pid, remaining.clone());
                if paths.persist {
                    if let Err(error) = state.save(&paths.state) {
                        tracing::warn!(
                            path = %paths.state.display(),
                            worker = %name,
                            error = %error,
                            "failed to persist channel subscriptions"
                        );
                    }
                }
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
                            workers,
                            pending_deliveries,
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
                            sdk_out_tx,
                            json!({
                                "kind":"agent_inbound_delivery_mode_changed",
                                "name":&name,
                                "previous_mode":previous.as_wire_str(),
                                "mode":mode.as_wire_str(),
                            }),
                        )
                        .await;
                    }
                    if flushed > 0 {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"agent_pending_drained",
                                "name":&name,
                                "count":flushed,
                                "reason":"delivery_mode_transition",
                            }),
                        )
                        .await;
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
                            workers,
                            pending_deliveries,
                            &name,
                            &queued,
                            delivery_retry_interval,
                        )
                        .await;
                    }
                    if flushed > 0 {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"agent_pending_drained",
                                "name":&name,
                                "count":flushed,
                                "reason":"explicit_flush",
                            }),
                        )
                        .await;
                    }
                    let _ = reply.send(Ok(flushed));
                }
            }
            ListenApiRequest::Shutdown { reply } => {
                let _ = reply.send(Ok(json!({ "status": "shutting_down" })));
                *shutdown = true;
            }
            ListenApiRequest::RenewLease { reply } => {
                *last_lease_renewal = Instant::now();
                let expires_in = lease_duration.map(|d| d.as_secs()).unwrap_or(0);
                let _ = reply.send(Ok(json!({
                    "renewed": true,
                    "expires_in_secs": expires_in,
                    "persist": persist,
                })));
            }
        }
    }
}

fn workspace_for_channel_update<'a>(
    workspace_id: Option<&str>,
    workspace_lookup: &'a HashMap<WorkspaceId, RelayWorkspace>,
    default_workspace_id: Option<&str>,
    default_workspace: &'a RelayWorkspace,
) -> &'a RelayWorkspace {
    workspace_id
        .and_then(|id| workspace_lookup.get(id))
        .or_else(|| default_workspace_id.and_then(|id| workspace_lookup.get(id)))
        .unwrap_or(default_workspace)
}

fn effective_channel_workspace_id<'a>(
    workspace_id: Option<&'a str>,
    default_workspace_id: Option<&'a str>,
) -> Option<&'a str> {
    workspace_id.or(default_workspace_id)
}

fn channel_in_list(channels: &[ChannelName], channel: &str) -> bool {
    channels
        .iter()
        .any(|existing| existing.as_str().eq_ignore_ascii_case(channel))
}

/// One-line skill text prepended for CLI harnesses that need a minimal relay lifecycle hint.
const RELAY_WORKER_ONE_LINER: &str = "\
Call mcp__agent-relay__add_agent to spawn a relay worker for a task, and \
mcp__agent-relay__remove_agent to release relay workers when they are done.";

/// Skill text prepended to the task for small/fast models (haiku, mini, flash) that need
/// explicit tool guidance to reliably call mcp__agent-relay__add_agent.
/// Eval data: haiku achieves 0/5 spawn reliability without guidance, 5/5 with this text.
/// Sonnet/Opus pass bare (0-shot), so they receive no prefix.
const SMALL_MODEL_RELAY_SKILL: &str = "\
## Agent Relay — Worker Management

### Spawn a relay worker
To delegate a task to a dedicated relay worker agent, call:
  mcp__agent-relay__add_agent(name: \"WorkerName\", cli: \"claude\", task: \"full task instructions\")
Required: name (unique string), cli (\"claude\" or other CLI), task (complete instructions for the relay worker).
The relay worker will DM you \"ACK: <understanding>\" when it starts and \"DONE: <result>\" when complete.

### Release a relay worker
When a relay worker reports DONE, immediately release them:
  mcp__agent-relay__remove_agent(name: \"WorkerName\")
Always release relay workers — unreleased agents waste resources.

### When to spawn
Spawn when: the task asks you to delegate or assign work, is large, needs specialised focus, or would block your own progress.";

/// Returns true for small/fast model tiers that need explicit relay skill injection.
/// Matches haiku (Claude), mini (GPT), flash (Gemini), and generic small-tier names.
fn is_small_model_tier(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("haiku") || m.contains("-mini") || m.contains("-flash") || m.contains("small")
}

/// Returns the skill prefix to prepend to the initial task, if any.
/// Only small-tier models receive the prefix; larger models are self-sufficient.
fn model_skill_prefix(model: Option<&str>) -> Option<&'static str> {
    model
        .filter(|m| is_small_model_tier(m))
        .map(|_| SMALL_MODEL_RELAY_SKILL)
}

/// Returns the CLI-specific relay skill prefix, if that harness needs one.
fn cli_skill_prefix(cli: &str) -> Option<&'static str> {
    let command = shlex::split(cli)
        .and_then(|parts| parts.into_iter().next())
        .or_else(|| cli.split_whitespace().next().map(ToOwned::to_owned))
        .unwrap_or_else(|| cli.to_string());
    let cli = Path::new(&command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command.as_str())
        .to_lowercase();
    if cli == "gemini" {
        Some(RELAY_WORKER_ONE_LINER)
    } else {
        None
    }
}

/// Returns the combined relay skill prefix for a spawned agent.
pub(super) fn relay_skill_prefix(cli: &str, model: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(prefix) = model_skill_prefix(model) {
        parts.push(prefix);
    }
    if let Some(prefix) = cli_skill_prefix(cli) {
        parts.push(prefix);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

#[cfg(test)]
mod skill_injection_tests {
    use super::{
        cli_skill_prefix, is_small_model_tier, model_skill_prefix, relay_skill_prefix,
        RELAY_WORKER_ONE_LINER, SMALL_MODEL_RELAY_SKILL,
    };

    #[test]
    fn small_tier_models_receive_prefix() {
        assert!(is_small_model_tier("claude-haiku-4-5-20251001"));
        assert!(is_small_model_tier("claude-haiku-4-5"));
        assert!(is_small_model_tier("gpt-4o-mini"));
        assert!(is_small_model_tier("gemini-2.0-flash"));
        assert!(is_small_model_tier("gemini-1.5-flash-latest"));
    }

    #[test]
    fn large_tier_models_receive_no_prefix() {
        assert!(!is_small_model_tier("claude-sonnet-4-6"));
        assert!(!is_small_model_tier("claude-opus-4-8"));
        assert!(!is_small_model_tier("gpt-4o"));
        assert!(!is_small_model_tier("gemini-1.5-pro"));
    }

    #[test]
    fn none_model_receives_no_prefix() {
        assert!(model_skill_prefix(None).is_none());
    }

    #[test]
    fn haiku_model_receives_skill_prefix() {
        let prefix = model_skill_prefix(Some("claude-haiku-4-5-20251001"));
        assert_eq!(prefix, Some(SMALL_MODEL_RELAY_SKILL));
        let text = prefix.unwrap();
        assert!(text.contains("mcp__agent-relay__add_agent"));
        assert!(text.contains("mcp__agent-relay__remove_agent"));
        assert!(text.contains("relay worker"));
        assert!(!text.contains("Do it yourself"));
    }

    #[test]
    fn cli_specific_harnesses_receive_prefixes() {
        assert_eq!(cli_skill_prefix("gemini"), Some(RELAY_WORKER_ONE_LINER));
        assert_eq!(
            cli_skill_prefix("gemini --model pro"),
            Some(RELAY_WORKER_ONE_LINER)
        );
        assert_eq!(
            cli_skill_prefix("/usr/local/bin/gemini --model pro"),
            Some(RELAY_WORKER_ONE_LINER)
        );
        // droid: no injection — broker injection kills s03 bare (0/5 vs 5/5 baseline without it)
        assert_eq!(cli_skill_prefix("droid"), None);
        assert_eq!(cli_skill_prefix("/opt/homebrew/bin/droid --foo"), None);
        assert_eq!(cli_skill_prefix("codex"), None);
        assert_eq!(cli_skill_prefix("claude"), None);
    }

    #[test]
    fn relay_skill_prefix_combines_model_and_cli_guidance() {
        let prefix = relay_skill_prefix("gemini", Some("gemini-2.0-flash")).unwrap();
        assert!(prefix.contains("## Agent Relay"));
        assert!(prefix.contains(RELAY_WORKER_ONE_LINER));

        // droid gets no injection — broker-injected skill text suppresses relay tool use entirely
        assert!(relay_skill_prefix("droid", None).is_none());

        assert!(relay_skill_prefix("codex", Some("gpt-5.5")).is_none());
    }
}

fn persist_agent_channels(
    state: &mut broker::BrokerState,
    name: &str,
    parent: Option<String>,
    mut spec: AgentSpec,
    pid: Option<u32>,
    channels: Vec<ChannelName>,
) {
    spec.channels = channels.clone();
    let runtime = spec.runtime.clone();
    let agent = state
        .agents
        .entry(WorkerName::from(name))
        .or_insert_with(|| broker::PersistedAgent {
            runtime: runtime.clone(),
            parent: parent.clone(),
            channels: channels.clone(),
            pid,
            started_at: Some(unix_timestamp_secs()),
            spec: Some(spec.clone()),
            restart_policy: None,
            initial_task: None,
        });
    agent.runtime = runtime;
    agent.parent = parent;
    agent.channels = channels;
    agent.pid = pid;
    agent.spec = Some(spec);
}
