use super::*;
use crate::worker::AgentWorkState;

impl BrokerRuntime {
    pub(super) async fn handle_worker_event(&mut self, worker_event: WorkerEvent) {
        let paths = &self.paths;
        let state = &mut self.state;
        let sdk_out_tx = &self.sdk_out_tx;
        let ws_control_tx = &self.ws_control_tx;
        let workers = &mut self.workers;
        let pending_deliveries = &mut self.pending_deliveries;
        let terminal_failed_deliveries = &mut self.terminal_failed_deliveries;
        let pending_requests = &mut self.pending_requests;
        let delivery_retry_interval = self.delivery_retry_interval;

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
                                return;
                            }

                            let pending_for_confirmation = if let Ok(ack) =
                                serde_json::from_value::<DeliveryAckPayload>(payload.clone())
                            {
                                let pending = clear_pending_delivery_if_event_matches(
                                    pending_deliveries,
                                    &ack.delivery_id,
                                    Some(&ack.event_id),
                                    &name,
                                    "delivery_ack",
                                );
                                if pending.is_some() {
                                    terminal_failed_deliveries.remove(&ack.delivery_id);
                                }
                                pending
                            } else {
                                None
                            };
                            let _ = send_event(
                                sdk_out_tx,
                                json!({
                                    "kind": "delivery_ack",
                                    "name": name,
                                    "delivery_id": payload.get("delivery_id"),
                                    "event_id": payload.get("event_id"),
                                    "timestamp": payload.get("timestamp"),
                                }),
                            )
                            .await;
                            if let Some(pending) = pending_for_confirmation {
                                if let Some(handle) = workers.workers.get_mut(&name) {
                                    handle.last_activity_at = Instant::now();
                                    handle.state = AgentWorkState::Working;
                                }
                                let _ = send_broker_event(
                                    sdk_out_tx,
                                    BrokerEvent::MessageDeliveryConfirmed {
                                        name: name.clone(),
                                        delivery_id: pending.delivery.delivery_id,
                                        event_id: pending.delivery.event_id,
                                        from: pending.delivery.from,
                                        to: pending.delivery.target,
                                    },
                                )
                                .await;
                            }
                        }
                    } else if msg_type == "delivery_queued" || msg_type == "delivery_injected" {
                        if let Some(payload) = value.get("payload") {
                            let delivery_id = payload
                                .get("delivery_id")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if let Some(pending) = pending_deliveries.get_mut(delivery_id) {
                                pending.next_retry_at = Instant::now()
                                    + std::cmp::max(
                                        delivery_retry_interval,
                                        crate::broker::delivery_verification::VERIFICATION_WINDOW,
                                    );
                            }
                            if let Some(handle) = workers.workers.get_mut(&name) {
                                handle.last_activity_at = Instant::now();
                                handle.state = AgentWorkState::Working;
                            }
                            let _ = send_event(
                                sdk_out_tx,
                                json!({
                                    "kind": msg_type,
                                    "name": name,
                                    "delivery_id": payload.get("delivery_id"),
                                    "event_id": payload.get("event_id"),
                                    "timestamp": payload.get("timestamp"),
                                }),
                            )
                            .await;
                        }
                    } else if msg_type == "delivery_verified" {
                        if let Some(payload) = value.get("payload") {
                            let delivery_id = payload
                                .get("delivery_id")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let event_id = payload
                                .get("event_id")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            tracing::debug!(
                                target = "agent_relay::broker",
                                worker = %name,
                                delivery_id = %delivery_id,
                                event_id = %event_id,
                                "delivery verified by echo detection"
                            );
                            let pending_for_confirmation = clear_pending_delivery_if_event_matches(
                                pending_deliveries,
                                delivery_id,
                                Some(event_id),
                                &name,
                                "delivery_verified",
                            );
                            let _ = send_event(
                                sdk_out_tx,
                                json!({
                                    "kind": "delivery_verified",
                                    "name": name,
                                    "delivery_id": delivery_id,
                                    "event_id": event_id,
                                }),
                            )
                            .await;
                            if let Some(pending) = pending_for_confirmation {
                                if let Some(handle) = workers.workers.get_mut(&name) {
                                    handle.last_activity_at = Instant::now();
                                    handle.state = AgentWorkState::Working;
                                }
                                let _ = send_broker_event(
                                    sdk_out_tx,
                                    BrokerEvent::MessageDeliveryConfirmed {
                                        name: name.clone(),
                                        delivery_id: pending.delivery.delivery_id,
                                        event_id: pending.delivery.event_id,
                                        from: pending.delivery.from,
                                        to: pending.delivery.target,
                                    },
                                )
                                .await;
                            }
                        }
                    } else if msg_type == "delivery_active" {
                        if let Some(payload) = value.get("payload") {
                            if let Some(handle) = workers.workers.get_mut(&name) {
                                handle.last_activity_at = Instant::now();
                                handle.state = AgentWorkState::Working;
                            }
                            let _ = send_event(
                                sdk_out_tx,
                                json!({
                                    "kind": "delivery_active",
                                    "name": name,
                                    "delivery_id": payload.get("delivery_id"),
                                    "event_id": payload.get("event_id"),
                                    "pattern": payload.get("pattern"),
                                }),
                            )
                            .await;
                        }
                    } else if msg_type == "delivery_failed" {
                        if let Some(payload) = value.get("payload") {
                            let delivery_id = payload
                                .get("delivery_id")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let event_id = payload
                                .get("event_id")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let reason = payload
                                .get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            tracing::warn!(
                                target = "agent_relay::broker",
                                worker = %name,
                                delivery_id = %delivery_id,
                                event_id = %event_id,
                                reason = %reason,
                                "delivery failed — echo not detected"
                            );
                            let pending_for_failure = clear_pending_delivery_if_event_matches(
                                pending_deliveries,
                                delivery_id,
                                Some(event_id),
                                &name,
                                "delivery_failed",
                            );
                            if pending_for_failure.is_some() && !delivery_id.is_empty() {
                                terminal_failed_deliveries.insert(delivery_id.to_string());
                            }
                            let _ = send_event(
                                sdk_out_tx,
                                json!({
                                    "kind": "delivery_failed",
                                    "name": name,
                                    "delivery_id": delivery_id,
                                    "event_id": event_id,
                                    "reason": reason,
                                }),
                            )
                            .await;
                            if let Some(pending) = pending_for_failure {
                                if let Some(handle) = workers.workers.get_mut(&name) {
                                    handle.last_activity_at = Instant::now();
                                    handle.state = AgentWorkState::Working;
                                }
                                let _ = send_broker_event(
                                    sdk_out_tx,
                                    BrokerEvent::MessageDeliveryFailed {
                                        name: name.clone(),
                                        delivery_id: Some(pending.delivery.delivery_id),
                                        event_id: Some(pending.delivery.event_id),
                                        from: pending.delivery.from,
                                        to: pending.delivery.target,
                                        attempts: pending.attempts,
                                        last_error: reason.to_string(),
                                    },
                                )
                                .await;
                            }
                        }
                    } else if msg_type == "worker_error" {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind": "worker_error",
                                "name": name,
                                "error": value.get("payload").cloned().unwrap_or(Value::Null)
                            }),
                        )
                        .await;
                    } else if msg_type.ends_with("_response") {
                        // Generic worker request/response dispatch.
                        // Any frame whose `type` ends in
                        // `_response` is routed by `request_id`
                        // into the matching parked `oneshot` in
                        // `pending_requests`. The pending entry
                        // owns the format/error decoding logic
                        // via `worker_request::fulfil_response_frame`.
                        let routed =
                            worker_request::fulfil_response_frame(pending_requests, &value);
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
                        if let Some(handle) = workers.workers.get_mut(&name) {
                            handle.last_activity_at = Instant::now();
                            handle.state = AgentWorkState::Working;
                        }
                        let _ = send_event(sdk_out_tx, json!({
                                        "kind": "worker_stream",
                                        "name": name,
                                        "stream": value.get("payload").and_then(|p| p.get("stream")).cloned().unwrap_or(Value::String("stdout".to_string())),
                                        "chunk": value.get("payload").and_then(|p| p.get("chunk")).cloned().unwrap_or(Value::String(String::new())),
                                    })).await;
                    } else if msg_type == "worker_ready" {
                        if let Some(task_text) = workers.initial_tasks.remove(&name) {
                            let event_id = format!("init_{}", Uuid::new_v4().simple());
                            if let Err(e) = queue_and_try_delivery_raw(
                                workers,
                                pending_deliveries,
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
                            )
                            .await
                            {
                                tracing::warn!(worker = %name, error = %e, "failed to deliver initial_task");
                            }
                        }
                        let runtime = value
                            .get("payload")
                            .and_then(|p| p.get("runtime"))
                            .and_then(Value::as_str)
                            .unwrap_or("pty");
                        let (provider_val, cli_val, model_val, session_id_val, pid_val) = workers
                            .workers
                            .get(&name)
                            .map(|h| {
                                (
                                    h.spec.provider.clone(),
                                    h.spec.cli.clone(),
                                    h.spec.model.clone(),
                                    h.spec.session_id.clone(),
                                    h.child.id(),
                                )
                            })
                            .unwrap_or((None, None, None, None, None));
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind": "worker_ready",
                                "name": name,
                                "runtime": runtime,
                                "provider": provider_val,
                                "cli": cli_val,
                                "model": model_val,
                                "sessionId": session_id_val,
                                "pid": pid_val,
                            }),
                        )
                        .await;
                    } else if msg_type == "agent_idle" {
                        let idle_secs = value
                            .get("payload")
                            .and_then(|p| p.get("idle_secs"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let since =
                            chrono::Utc::now() - chrono::Duration::seconds(idle_secs as i64);
                        if let Some(handle) = workers.workers.get_mut(&name) {
                            handle.state = AgentWorkState::Idle;
                        }
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind": "agent_idle",
                                "name": name,
                                "idle_secs": idle_secs,
                                "since": since,
                            }),
                        )
                        .await;
                        publish_agent_state_transition(
                            ws_control_tx,
                            &name,
                            "idle",
                            Some("idle_threshold"),
                        )
                        .await;
                    } else if msg_type == "agent_blocked_on_send" {
                        let blocked_secs = value
                            .get("payload")
                            .and_then(|p| p.get("blocked_secs"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let pending_delivery_count = value
                            .get("payload")
                            .and_then(|p| p.get("pending_delivery_count"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            as usize;
                        if let Some(handle) = workers.workers.get_mut(&name) {
                            handle.last_activity_at = Instant::now();
                            handle.state = AgentWorkState::BlockedOnSend;
                        }
                        let _ = send_broker_event(
                            sdk_out_tx,
                            BrokerEvent::AgentBlockedOnSend {
                                name: name.clone(),
                                blocked_secs,
                                pending_delivery_count,
                            },
                        )
                        .await;
                        publish_agent_state_transition(
                            ws_control_tx,
                            &name,
                            "stuck",
                            Some("blocked_on_send"),
                        )
                        .await;
                    } else if msg_type == "agent_context_low" {
                        let pct = value
                            .get("payload")
                            .and_then(|p| p.get("pct"))
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            .min(100) as u8;
                        if let Some(handle) = workers.workers.get_mut(&name) {
                            handle.context_budget_pct = Some(pct);
                            handle.last_activity_at = Instant::now();
                        }
                        let _ = send_broker_event(
                            sdk_out_tx,
                            BrokerEvent::AgentContextLow {
                                name: name.clone(),
                                pct,
                            },
                        )
                        .await;
                    } else if msg_type == "agent_exit" {
                        let reason = value
                            .get("payload")
                            .and_then(|p| p.get("reason"))
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        if let Some(handle) = workers.workers.get_mut(&name) {
                            handle.exit_reason = Some(reason.to_string());
                            handle.last_activity_at = Instant::now();
                        }
                        tracing::info!(agent = %name, reason = %reason, "agent requested exit");
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind": "agent_exit",
                                "name": name,
                                "reason": reason,
                            }),
                        )
                        .await;
                    } else if msg_type == "continuity_command" {
                        // Agent-initiated continuity: the pty_worker detected a
                        // KIND: continuity block in PTY output and emitted this event.
                        let action = value
                            .get("payload")
                            .and_then(|p| p.get("action"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let content = value
                            .get("payload")
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
                                    let initial_task =
                                        agent_data.and_then(|d| d.initial_task.clone());
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
                                                let prev_task = ctx
                                                    .get("initial_task")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("unknown");
                                                let summary = ctx
                                                    .get("summary")
                                                    .and_then(Value::as_str)
                                                    .unwrap_or("no summary");
                                                let history_str = ctx
                                                    .get("message_history")
                                                    .and_then(Value::as_array)
                                                    .map(|msgs| {
                                                        msgs.iter()
                                                            .filter_map(|m| {
                                                                let from =
                                                                    m.get("from")?.as_str()?;
                                                                let text = m
                                                                    .get("text")
                                                                    .or_else(|| m.get("body"))?
                                                                    .as_str()?;
                                                                Some(format!(
                                                                    "  - {}: {}",
                                                                    from, text
                                                                ))
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
                                                let event_id = format!(
                                                    "cont_load_{}",
                                                    Uuid::new_v4().simple()
                                                );
                                                if let Err(e) = queue_and_try_delivery_raw(
                                                    workers,
                                                    pending_deliveries,
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
                                                )
                                                .await
                                                {
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
                        let code = value
                            .get("payload")
                            .and_then(|p| p.get("code"))
                            .and_then(Value::as_i64)
                            .map(|c| c as i32);
                        let signal = value
                            .get("payload")
                            .and_then(|p| p.get("signal"))
                            .and_then(Value::as_str)
                            .map(String::from);
                        tracing::info!(
                            agent = %name,
                            code = ?code,
                            signal = ?signal,
                            "worker_exited received; deferring cleanup to reap_exited"
                        );
                    }
                }
            }
        }
    }
}
