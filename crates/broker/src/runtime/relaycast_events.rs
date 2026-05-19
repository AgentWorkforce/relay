use super::*;

impl BrokerRuntime {
    pub(super) async fn handle_relaycast_message(&mut self, ws_msg: WorkspaceInboundMessage) {
        let paths = &self.paths;
        let state = &mut self.state;
        let workspace_lookup = &self.workspace_lookup;
        let default_workspace = &self.default_workspace;
        let sdk_out_tx = &self.sdk_out_tx;
        let workers = &mut self.workers;
        let telemetry = &self.telemetry;
        let agent_spawn_count = &mut self.agent_spawn_count;
        let dedup = &mut self.dedup;
        let pending_deliveries = &mut self.pending_deliveries;
        let pending_requests = &mut self.pending_requests;
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
                                let _ = emit_dropped_delivery_failures(
                                    sdk_out_tx,
                                    &dropped,
                                    "agent_released",
                                )
                                .await;
                            }
                            fail_pending_requests_for_worker(
                                pending_requests,
                                &name,
                                "relaycast_release",
                            );
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
                                sdk_out_tx,
                                json!({"kind":"agent_released","name":name}),
                            )
                            .await;
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
                    return;
                }
                WsEvent::AgentSpawnRequested(event) => {
                    let name = event.agent.name;
                    eprintln!(
                        "[agent-relay] received spawn request for '{}' (cli: {})",
                        name, event.agent.cli
                    );
                    if is_relaycast_self_control_target(
                        &name,
                        &workspace_self_name,
                        &workspace_self_names,
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
                        eprintln!(
                            "[agent-relay] dropping duplicate spawn request for '{}'",
                            name
                        );
                        return;
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
                    let cli_command = parse_cli_command(&cli)
                        .map(|(cmd, _)| cmd)
                        .unwrap_or_else(|_| cli.clone());
                    let cli_name_lower = normalize_cli_name(&cli_command).to_lowercase();
                    let is_claude =
                        cli_name_lower == "claude" || cli_name_lower.starts_with("claude:");
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
                        )
                        .await
                    {
                        Ok(effective_spec) => {
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
                            if paths.persist {
                                let _ = state.save(&paths.state);
                            }
                            let _ = send_event(
                                sdk_out_tx,
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
                            )
                            .await;
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
                    return;
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
                eprintln!(
                    "[agent-relay] handling spawn request for '{}' via JSON fallback (cli: {})",
                    name, cli
                );

                if is_relaycast_self_control_target(
                    &name,
                    &workspace_self_name,
                    &workspace_self_names,
                ) {
                    eprintln!(
                        "[agent-relay] ignoring spawn request for '{}' (broker self)",
                        name
                    );
                } else {
                    let local_spawn_echo_key =
                        relaycast_spawn_control_dedup_key(&workspace_id, &name);
                    let should_dedup = relaycast_ws_should_apply_local_spawn_echo_dedup(
                        control_dedup_key.as_deref(),
                        &local_spawn_echo_key,
                    );
                    // Always insert the local echo key for consistency with the primary path
                    let is_new = dedup.insert_if_new(&local_spawn_echo_key, Instant::now());
                    if !should_dedup || is_new {
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
                        let cli_command = parse_cli_command(&cli)
                            .map(|(cmd, _)| cmd)
                            .unwrap_or_else(|_| cli.clone());
                        let cli_name_lower = normalize_cli_name(&cli_command).to_lowercase();
                        let is_claude =
                            cli_name_lower == "claude" || cli_name_lower.starts_with("claude:");
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
                                )
                                .await
                                {
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

                        match workers
                            .spawn(
                                spec,
                                Some("Relaycast".to_string()),
                                None,
                                worker_relay_key.clone(),
                                false,
                                Some(workspace_id.clone()),
                            )
                            .await
                        {
                            Ok(effective_spec) => {
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
                                if paths.persist {
                                    let _ = state.save(&paths.state);
                                }
                                let _ = send_event(
                                    sdk_out_tx,
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
                                )
                                .await;
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
                        eprintln!(
                            "[agent-relay] dropping duplicate spawn request for '{}' (fallback)",
                            name
                        );
                    }
                }
            }
            // Don't fall through to map_ws_event for control events
            // handled by the JSON fallback path.
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

            let local_delivery_timeout = http_api_local_delivery_timeout();
            for worker_name in delivery_plan.targets {
                // Inbound-delivery queue: mirrors the /api/send
                // queue above. Auto-inject workers drain the queue
                // immediately; manual-flush workers leave relaycast
                // messages parked until flush. The same full-context
                // capture makes drains reproduce the original
                // delivery (channel/thread/workspace).
                match queue_inbound_for_delivery_mode(
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
                ) {
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
