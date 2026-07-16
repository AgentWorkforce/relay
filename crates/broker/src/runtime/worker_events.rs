use super::fleet::refresh_fleet_inventory_session_ref;
use super::*;
use crate::worker::AgentWorkState;

fn enqueue_pty_event(
    states: &mut HashMap<WorkerName, PtyObservabilityState>,
    tx: &mpsc::Sender<HostedAgentEvent>,
    name: &WorkerName,
    event_type: &str,
    fidelity: &str,
    turn_id: Option<&str>,
    fields: Value,
) {
    let state = states.entry(name.clone()).or_default();
    state.sequence += 1;
    let timestamp = chrono::Utc::now().to_rfc3339();
    let mut payload = fields.as_object().cloned().unwrap_or_default();
    payload.insert("at".to_string(), Value::String(timestamp.clone()));
    let mut observability = json!({
        "source":"broker", "fidelity":fidelity, "sequence":state.sequence,
        "timestamp":timestamp,
    });
    if let (Some(turn_id), Some(object)) = (turn_id, observability.as_object_mut()) {
        object.insert("turnId".to_string(), Value::String(turn_id.to_string()));
    }
    payload.insert("observability".to_string(), observability);
    if let Err(error) = tx.try_send(HostedAgentEvent {
        name: name.to_string(),
        event_type: event_type.to_string(),
        payload,
        workspace_id: state.workspace_id.clone(),
    }) {
        tracing::warn!(worker = %name, error = %error, "Relaycast PTY observability queue is full or closed");
    }
}

#[cfg(test)]
mod pty_observability_tests {
    use super::*;

    #[tokio::test]
    async fn broker_owned_pty_profile_is_ordered_and_deduplicates_busy_output() {
        let (tx, mut rx) = mpsc::channel(32);
        let mut states = HashMap::new();
        let name = WorkerName::new("Worker");

        publish_pty_starting(&mut states, &tx, &name, None);
        publish_pty_busy(&mut states, &tx, &name);
        publish_pty_busy(&mut states, &tx, &name);
        publish_pty_idle(&mut states, &tx, &name);

        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        let event_types: Vec<_> = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect();
        assert_eq!(
            event_types,
            [
                "session.starting",
                "observability.capabilities",
                "activity.changed",
                "turn.started",
                "activity.changed",
                "turn.settled",
                "activity.changed",
            ]
        );
        let sequences: Vec<_> = events
            .iter()
            .map(|event| event.payload["observability"]["sequence"].as_u64().unwrap())
            .collect();
        assert_eq!(sequences, (1..=7).collect::<Vec<_>>());
        assert_eq!(events[2].payload["activity"], "starting");
        assert_eq!(events[4].payload["activity"], "thinking");
        assert_eq!(events[6].payload["activity"], "idle");
        assert_eq!(
            events[1].payload["capabilities"]["activities"]["typing"]["available"],
            false
        );
    }

    #[tokio::test]
    async fn transport_diagnostics_are_not_hosted_as_a_second_canonical_stream() {
        let name = WorkerName::new("Worker");
        let diagnostic = json!({
            "protocol_version": 1,
            "sequence": 1,
            "diagnostic": { "kind": "diagnostic", "message": "debug" }
        });
        assert!(
            hosted_agent_event(&name, "native_harness_diagnostic", &diagnostic, None).is_none()
        );

        let canonical = json!({
            "protocol_version":1, "sequence":9, "timestamp":"2026-07-16T00:00:00Z",
            "event":{"kind":"diagnostic","message":"debug","observability":{"source":"ai-sdk","fidelity":"exact","sequence":9,"timestamp":"2026-07-16T00:00:00Z"}}
        });
        let workspace_id = WorkspaceId::new("ws_secondary");
        let hosted =
            hosted_agent_event(&name, "agent_event", &canonical, Some(workspace_id.clone()))
                .expect("canonical event should be hosted");
        assert_eq!(hosted.event_type, "diagnostic");
        assert!(hosted.payload.get("kind").is_none());
        assert_eq!(hosted.payload["protocol_version"], 1);
        assert_eq!(hosted.payload["sequence"], 9);
        assert_eq!(hosted.workspace_id, Some(workspace_id));
    }
}

pub(super) fn publish_pty_starting(
    states: &mut HashMap<WorkerName, PtyObservabilityState>,
    tx: &mpsc::Sender<HostedAgentEvent>,
    name: &WorkerName,
    workspace_id: Option<WorkspaceId>,
) {
    states.insert(
        name.clone(),
        PtyObservabilityState {
            workspace_id,
            ..PtyObservabilityState::default()
        },
    );
    enqueue_pty_event(
        states,
        tx,
        name,
        "session.starting",
        "exact",
        None,
        json!({"reason":"broker_spawn"}),
    );
    enqueue_pty_event(
        states,
        tx,
        name,
        "observability.capabilities",
        "exact",
        None,
        json!({"capabilities":pty_capabilities()}),
    );
    let state = states
        .get_mut(name)
        .expect("PTY observability state exists");
    let previous = state.activity;
    state.activity = "starting";
    enqueue_pty_event(
        states,
        tx,
        name,
        "activity.changed",
        "exact",
        None,
        json!({
            "activity":"starting", "previousActivity":previous, "reason":"broker_spawn"
        }),
    );
}

pub(super) fn publish_pty_busy(
    states: &mut HashMap<WorkerName, PtyObservabilityState>,
    tx: &mpsc::Sender<HostedAgentEvent>,
    name: &WorkerName,
) {
    let state = states.entry(name.clone()).or_default();
    if state.activity == "thinking" {
        return;
    }
    let turn_id = format!("pty-{}-{}", name, state.sequence + 1);
    let previous = state.activity;
    state.activity = "thinking";
    state.turn_id = Some(turn_id.clone());
    enqueue_pty_event(
        states,
        tx,
        name,
        "turn.started",
        "inferred",
        Some(&turn_id),
        json!({"turnId":turn_id}),
    );
    enqueue_pty_event(
        states,
        tx,
        name,
        "activity.changed",
        "inferred",
        Some(&turn_id),
        json!({
            "activity":"thinking", "previousActivity":previous, "reason":"broker_busy_boundary"
        }),
    );
}

pub(super) fn publish_pty_idle(
    states: &mut HashMap<WorkerName, PtyObservabilityState>,
    tx: &mpsc::Sender<HostedAgentEvent>,
    name: &WorkerName,
) {
    let Some(state) = states.get_mut(name) else {
        return;
    };
    let Some(turn_id) = state.turn_id.take() else {
        return;
    };
    let previous = state.activity;
    state.activity = "idle";
    enqueue_pty_event(
        states,
        tx,
        name,
        "turn.settled",
        "inferred",
        Some(&turn_id),
        json!({"turnId":turn_id}),
    );
    enqueue_pty_event(
        states,
        tx,
        name,
        "activity.changed",
        "inferred",
        Some(&turn_id),
        json!({
            "activity":"idle", "previousActivity":previous, "reason":"broker_idle_boundary"
        }),
    );
}

pub(super) fn publish_pty_error(
    states: &mut HashMap<WorkerName, PtyObservabilityState>,
    tx: &mpsc::Sender<HostedAgentEvent>,
    name: &WorkerName,
    error: &str,
    code: Option<String>,
) {
    let state = states.entry(name.clone()).or_default();
    if state.activity == "error" {
        return;
    }
    let previous = state.activity;
    state.activity = "error";
    let turn_id = state.turn_id.clone();
    let mut failure = json!({"error":error});
    if let (Some(code), Some(object)) = (code, failure.as_object_mut()) {
        object.insert("code".to_string(), Value::String(code));
    }
    enqueue_pty_event(
        states,
        tx,
        name,
        "session.failed",
        "exact",
        turn_id.as_deref(),
        failure,
    );
    enqueue_pty_event(
        states,
        tx,
        name,
        "activity.changed",
        "exact",
        turn_id.as_deref(),
        json!({
            "activity":"error", "previousActivity":previous, "reason":"broker_runtime_failure"
        }),
    );
}

fn pty_capabilities() -> Value {
    let unavailable = json!({"available":false});
    let exact = json!({"available":true,"fidelities":["exact"]});
    let inferred = json!({"available":true,"fidelities":["inferred"]});
    json!({
        "activities":{"starting":exact,"thinking":inferred,"typing":unavailable,"using_tool":unavailable,"waiting":unavailable,"idle":inferred,"error":exact},
        "events":{"lifecycle":exact,"turns":inferred,"text":unavailable,"reasoning":unavailable,"tools":unavailable,"tool_approvals":unavailable,"files":unavailable,"compaction":unavailable,"model":unavailable,"warnings":unavailable,"usage":unavailable,"diagnostics":unavailable,"errors":exact}
    })
}

fn hosted_agent_event(
    name: &WorkerName,
    msg_type: &str,
    payload: &Value,
    workspace_id: Option<WorkspaceId>,
) -> Option<HostedAgentEvent> {
    if msg_type != "agent_event" {
        return None;
    }
    let mut event_payload = payload.get("event")?.as_object()?.clone();
    let event_type = event_payload.remove("kind")?.as_str()?.to_string();
    event_payload.insert(
        "protocol_version".to_string(),
        payload.get("protocol_version").cloned()?,
    );
    event_payload.insert("sequence".to_string(), payload.get("sequence").cloned()?);
    if let Some(timestamp) = payload.get("timestamp") {
        event_payload.insert("timestamp".to_string(), timestamp.clone());
    }
    Some(HostedAgentEvent {
        name: name.to_string(),
        event_type,
        payload: event_payload,
        workspace_id,
    })
}

impl BrokerRuntime {
    pub(super) async fn handle_worker_event(&mut self, worker_event: WorkerEvent) {
        let paths = &self.paths;
        let state = &mut self.state;
        let sdk_out_tx = &self.sdk_out_tx;
        let relaycast_http = self.relaycast_http.clone();
        let hosted_agent_event_tx = &self.hosted_agent_event_tx;
        let pty_observability = &mut self.pty_observability;
        let ws_control_tx = &self.ws_control_tx;
        let workers = &mut self.workers;
        let dedup = &mut self.dedup;
        let pending_deliveries = &mut self.pending_deliveries;
        let terminal_failed_deliveries = &mut self.terminal_failed_deliveries;
        let pending_requests = &mut self.pending_requests;
        let delivery_retry_interval = self.delivery_retry_interval;
        let fleet_control_tx = &self.fleet_control_tx;
        let fleet_inventory = &mut self.fleet_inventory;
        let delivery_states = &self.delivery_states;

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
                                let read_ack_delivery_id = pending.delivery.delivery_id.clone();
                                let read_ack_event_id = pending.delivery.event_id.clone();
                                let cli_hint = workers
                                    .workers
                                    .get(&name)
                                    .and_then(|handle| handle.spec.cli.as_deref())
                                    .map(str::to_string);
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
                                mark_delivery_read_ack(
                                    &relaycast_http,
                                    sdk_out_tx,
                                    dedup,
                                    &name,
                                    cli_hint.as_deref(),
                                    &read_ack_delivery_id,
                                    &read_ack_event_id,
                                );
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
                            // "echo" when the injection was confirmed in PTY
                            // output; "timeout_fallback" when the worker acked
                            // without ever seeing the echo.
                            let verification = payload
                                .get("verification")
                                .and_then(Value::as_str)
                                .unwrap_or("echo");
                            let reason = payload.get("reason").and_then(Value::as_str);
                            if verification == "timeout_fallback" {
                                tracing::info!(
                                    target = "agent_relay::broker",
                                    worker = %name,
                                    delivery_id = %delivery_id,
                                    event_id = %event_id,
                                    reason = reason.unwrap_or(""),
                                    "delivery acked via timeout fallback — echo never verified"
                                );
                            } else {
                                tracing::debug!(
                                    target = "agent_relay::broker",
                                    worker = %name,
                                    delivery_id = %delivery_id,
                                    event_id = %event_id,
                                    "delivery verified by echo detection"
                                );
                            }
                            let pending_for_confirmation = clear_pending_delivery_if_event_matches(
                                pending_deliveries,
                                delivery_id,
                                Some(event_id),
                                &name,
                                "delivery_verified",
                            );
                            let mut verified_event = json!({
                                "kind": "delivery_verified",
                                "name": name,
                                "delivery_id": delivery_id,
                                "event_id": event_id,
                                "verification": verification,
                            });
                            if let (Some(reason), Some(map)) =
                                (reason, verified_event.as_object_mut())
                            {
                                map.insert("reason".to_string(), Value::String(reason.to_string()));
                            }
                            let _ = send_event(sdk_out_tx, verified_event).await;
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
                                terminal_failed_deliveries.insert(DeliveryId::from(delivery_id));
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
                        let is_pty = workers
                            .workers
                            .get(&name)
                            .is_some_and(|handle| handle.spec.runtime == AgentRuntime::Pty);
                        if is_pty {
                            let message = value
                                .get("payload")
                                .and_then(|payload| payload.get("message"))
                                .and_then(Value::as_str)
                                .unwrap_or("PTY worker error");
                            publish_pty_error(
                                pty_observability,
                                hosted_agent_event_tx,
                                &name,
                                message,
                                value
                                    .get("payload")
                                    .and_then(|payload| payload.get("code"))
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                            );
                        }
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind": "worker_error",
                                "name": name,
                                "code": value.get("payload").and_then(|payload| payload.get("code")).and_then(Value::as_str).unwrap_or("worker_error"),
                                "message": value.get("payload").and_then(|payload| payload.get("message")).and_then(Value::as_str).unwrap_or("worker reported an error"),
                                "error": value.get("payload").cloned().unwrap_or(Value::Null)
                            }),
                        )
                        .await;
                    } else if msg_type == "agent_event" || msg_type == "native_harness_diagnostic" {
                        let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                        let protocol_version =
                            payload.get("protocol_version").and_then(Value::as_u64);
                        let sequence = payload.get("sequence").and_then(Value::as_u64);
                        let body_key = if msg_type == "agent_event" {
                            "event"
                        } else {
                            "diagnostic"
                        };
                        if protocol_version != Some(1)
                            || sequence.is_none_or(|sequence| sequence == 0)
                            || !payload.get(body_key).is_some_and(Value::is_object)
                        {
                            let _ = send_event(
                                sdk_out_tx,
                                json!({
                                    "kind": "worker_error",
                                    "name": name,
                                    "code": "invalid_native_harness_frame",
                                    "message": "native harness frame requires protocol_version=1, a positive sequence, and an object payload",
                                    "error": {
                                        "code": "invalid_native_harness_frame",
                                        "message": "native harness frame requires protocol_version=1, a positive sequence, and an object payload",
                                        "retryable": false,
                                    }
                                }),
                            )
                            .await;
                            return;
                        }
                        if let Some(handle) = workers.workers.get_mut(&name) {
                            handle.last_activity_at = Instant::now();
                        }
                        // Transport diagnostics have their own sequence domain and are
                        // also represented by the canonical `diagnostic` agent event.
                        // Keep them on the local attach stream, but publish only the
                        // canonical agent-event stream to Relaycast to avoid duplicates.
                        let workspace_id = workers
                            .workers
                            .get(&name)
                            .and_then(|handle| handle.workspace_id.clone());
                        if let Some(hosted_event) =
                            hosted_agent_event(&name, msg_type, &payload, workspace_id)
                        {
                            if let Err(error) = hosted_agent_event_tx.try_send(hosted_event) {
                                tracing::warn!(worker = %name, error = %error, "Relaycast agent-event queue is full or closed");
                            }
                        }
                        let mut agent_event = payload;
                        if let Some(object) = agent_event.as_object_mut() {
                            object.insert("kind".to_string(), Value::String(msg_type.to_string()));
                            object.insert("name".to_string(), Value::String(name.to_string()));
                        }
                        let _ = send_event(sdk_out_tx, agent_event).await;
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
                        let is_pty = workers
                            .workers
                            .get(&name)
                            .is_some_and(|handle| handle.spec.runtime == AgentRuntime::Pty);
                        if let Some(handle) = workers.workers.get_mut(&name) {
                            handle.last_activity_at = Instant::now();
                            handle.state = AgentWorkState::Working;
                        }
                        if is_pty {
                            publish_pty_busy(pty_observability, hosted_agent_event_tx, &name);
                        }
                        let mut stream_event = json!({
                            "kind": "worker_stream",
                            "name": name,
                            "stream": value.get("payload").and_then(|p| p.get("stream")).cloned().unwrap_or(Value::String("stdout".to_string())),
                            "chunk": value.get("payload").and_then(|p| p.get("chunk")).cloned().unwrap_or(Value::String(String::new())),
                        });
                        // Forward the per-worker stream offset when present so
                        // attaching clients can correlate the live stream with
                        // a snapshot. Absent for headless workers (no grid).
                        if let Some(offset) =
                            value.get("payload").and_then(|p| p.get("offset")).cloned()
                        {
                            if let Some(obj) = stream_event.as_object_mut() {
                                obj.insert("offset".to_string(), offset);
                            }
                        }
                        let _ = send_event(sdk_out_tx, stream_event).await;
                    } else if msg_type == "worker_ready" {
                        // If this (re)spawned worker's inbound delivery mode is
                        // already manual_flush — e.g. it crashed and restarted
                        // while a human was driving — replay the interactive hold
                        // so its automation stays paused until the drive is
                        // released. Fresh workers default to auto_inject, so this
                        // is a no-op in the common case.
                        let is_pty_worker = workers
                            .workers
                            .get(&name)
                            .map(|handle| handle.spec.runtime == AgentRuntime::Pty)
                            .unwrap_or(false);
                        if is_pty_worker
                            && delivery_states
                                .get(&name)
                                .map(|s| s.mode == InboundDeliveryMode::ManualFlush)
                                .unwrap_or(false)
                        {
                            if let Err(err) = workers
                                .send_to_worker(
                                    &name,
                                    "set_interactive_hold",
                                    None,
                                    json!({ "hold": true }),
                                )
                                .await
                            {
                                tracing::warn!(
                                    worker = %name,
                                    error = %err,
                                    "failed to replay interactive hold to ready worker"
                                );
                            }
                        }
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
                        if runtime == "pty" && !pty_observability.contains_key(&name) {
                            let workspace_id = workers
                                .workers
                                .get(&name)
                                .and_then(|handle| handle.workspace_id.clone());
                            publish_pty_starting(
                                pty_observability,
                                hosted_agent_event_tx,
                                &name,
                                workspace_id,
                            );
                        }
                        let payload_pid = value
                            .get("payload")
                            .and_then(|p| p.get("pid"))
                            .and_then(Value::as_u64)
                            .filter(|pid| *pid <= u32::MAX as u64)
                            .map(|pid| pid as u32);
                        let (provider_val, cli_val, model_val, session_id_val, pid_val) = workers
                            .workers
                            .get_mut(&name)
                            .map(|h| {
                                if let Some(pid) = payload_pid {
                                    h.harness_pid = Some(pid);
                                }
                                (
                                    h.spec.provider.clone(),
                                    h.spec.cli.clone(),
                                    h.spec.model.clone(),
                                    h.spec.session_id.clone(),
                                    h.harness_pid,
                                )
                            })
                            .unwrap_or((None, None, None, None, None));
                        if let Some(session_ref) = session_id_val.as_deref() {
                            refresh_fleet_inventory_session_ref(
                                fleet_control_tx,
                                fleet_inventory,
                                &name,
                                session_ref,
                            )
                            .await;
                        }
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
                        if workers
                            .workers
                            .get(&name)
                            .is_some_and(|handle| handle.spec.runtime == AgentRuntime::Pty)
                        {
                            publish_pty_idle(pty_observability, hosted_agent_event_tx, &name);
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
