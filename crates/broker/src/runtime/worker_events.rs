use super::fleet::{
    fail_terminal_session, refresh_fleet_inventory_session_ref, resolve_pending_fleet_ack,
    try_send_terminal, verified_spawn_ready_result,
};
use super::*;
use crate::node_control::delivery_ack;
use crate::terminal_control::{TerminalControlCommand, TerminalToCloud};
use crate::worker::AgentWorkState;

const TERMINAL_PENDING_OUTPUT_MAX_BYTES: usize = 1024 * 1024;

/// Resolve the delivery mode to advertise in a `terminal.ready` frame for
/// `session_id`. A fresh PTY has no prior entry in `delivery_states` — that
/// must not be sent to the client as "no mode" (the attach client would then
/// keep its own inferred default, which can be wrong, e.g. `manual_flush` for
/// `--node drive`). The broker's logical default for a worker with no state
/// entry is [`InboundDeliveryMode::AutoInject`], so fall back to it explicitly.
fn resolve_ready_delivery_state(
    terminal_sessions: &HashMap<String, TerminalSession>,
    delivery_states: &HashMap<WorkerName, InboundDeliveryState>,
    session_id: &str,
) -> (Option<InboundDeliveryMode>, Option<String>) {
    let Some(session) = terminal_sessions.get(session_id) else {
        return (None, None);
    };
    let state = delivery_states.get(&session.agent);
    (
        Some(state.map(|value| value.mode).unwrap_or_default()),
        Some(
            state
                .map(|value| value.revision)
                .unwrap_or_default()
                .to_string(),
        ),
    )
}

fn publish_terminal_output(
    terminal_control_tx: &mpsc::Sender<TerminalControlCommand>,
    terminal_sessions: &mut HashMap<String, TerminalSession>,
    terminal_snapshot_requests: &mut HashMap<String, TerminalSnapshotRequest>,
    terminal_input_requests: &mut HashMap<String, TerminalInputRequest>,
    name: &WorkerName,
    chunk: String,
    offset: Option<u64>,
) {
    if terminal_sessions.is_empty() {
        return;
    }
    let chunk_bytes = chunk.len();
    let mut session_ids = Vec::new();
    let mut saturated_sessions = Vec::new();
    for (session_id, session) in terminal_sessions.iter_mut() {
        if session.agent != *name {
            continue;
        }
        if !session.ready {
            if session.pending_output_bytes + chunk_bytes > TERMINAL_PENDING_OUTPUT_MAX_BYTES {
                saturated_sessions.push(session_id.clone());
            } else {
                session.pending_output.push((chunk.clone(), offset));
                session.pending_output_bytes += chunk_bytes;
            }
            continue;
        }
        session_ids.push(session_id.clone());
    }
    for session_id in saturated_sessions {
        tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal snapshot wait exceeded bounded output buffer; ending session");
        end_terminal_session(
            terminal_control_tx,
            terminal_sessions,
            terminal_snapshot_requests,
            terminal_input_requests,
            &session_id,
            "output_backpressure",
            "terminal snapshot wait exceeded bounded output buffer",
        );
    }
    for session_id in session_ids {
        if !try_send_terminal(
            terminal_control_tx,
            TerminalToCloud::Output {
                session_id: session_id.clone(),
                chunk: chunk.clone(),
                offset,
            },
        ) {
            tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal output queue full or closed; ending session");
            end_terminal_session(
                terminal_control_tx,
                terminal_sessions,
                terminal_snapshot_requests,
                terminal_input_requests,
                &session_id,
                "output_backpressure",
                "terminal output queue is full",
            );
        }
    }
}

fn end_terminal_session(
    terminal_control_tx: &mpsc::Sender<TerminalControlCommand>,
    terminal_sessions: &mut HashMap<String, TerminalSession>,
    terminal_snapshot_requests: &mut HashMap<String, TerminalSnapshotRequest>,
    terminal_input_requests: &mut HashMap<String, TerminalInputRequest>,
    session_id: &str,
    code: &str,
    message: &str,
) {
    terminal_sessions.remove(session_id);
    terminal_snapshot_requests.retain(|_, pending| pending.session_id != session_id);
    terminal_input_requests.retain(|_, pending| pending.session_id != session_id);
    if !try_send_terminal(
        terminal_control_tx,
        TerminalToCloud::Closed {
            session_id: session_id.into(),
            code: Some(code.into()),
            message: Some(message.into()),
        },
    ) {
        tracing::warn!(
            target = "relay_broker::terminal",
            session_id,
            "terminal close could not be queued after session failure"
        );
    }
}

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

fn protocol_pid(value: &Value) -> Option<u32> {
    value
        .get("payload")
        .and_then(|payload| payload.get("pid"))
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid != 0)
}

fn record_started_harness_pid(
    runtime: &AgentRuntime,
    harness_pid: &mut Option<u32>,
    value: &Value,
) -> bool {
    if *runtime != AgentRuntime::Pty {
        return false;
    }
    let Some(pid) = protocol_pid(value) else {
        return false;
    };
    *harness_pid = Some(pid);
    true
}

fn worker_event_is_current(current_generation: Option<Uuid>, event_generation: Uuid) -> bool {
    current_generation == Some(event_generation)
}

#[cfg(test)]
mod terminal_ready_delivery_mode_tests {
    use super::*;

    fn terminal_session(agent: &WorkerName) -> TerminalSession {
        TerminalSession {
            agent: agent.clone(),
            mode: TerminalMode::Drive,
            ready: false,
            pending_output: Vec::new(),
            pending_output_bytes: 0,
        }
    }

    #[test]
    fn falls_back_to_auto_inject_when_the_worker_has_no_delivery_state_entry() {
        let agent = WorkerName::new("fresh-worker");
        let mut terminal_sessions = HashMap::new();
        terminal_sessions.insert("session-a".to_string(), terminal_session(&agent));
        let delivery_states: HashMap<WorkerName, InboundDeliveryState> = HashMap::new();

        let resolved =
            resolve_ready_delivery_state(&terminal_sessions, &delivery_states, "session-a");

        assert_eq!(
            resolved,
            (Some(InboundDeliveryMode::AutoInject), Some("0".into())),
            "a fresh PTY with no delivery_states entry must still advertise the broker's \
             logical default instead of omitting the mode"
        );
    }

    #[test]
    fn reports_the_worker_s_actual_mode_when_a_delivery_state_entry_exists() {
        let agent = WorkerName::new("manual-worker");
        let mut terminal_sessions = HashMap::new();
        terminal_sessions.insert("session-b".to_string(), terminal_session(&agent));
        let mut delivery_states: HashMap<WorkerName, InboundDeliveryState> = HashMap::new();
        delivery_states.insert(
            agent,
            InboundDeliveryState {
                mode: InboundDeliveryMode::ManualFlush,
                revision: 3,
                pending: Default::default(),
            },
        );

        let resolved =
            resolve_ready_delivery_state(&terminal_sessions, &delivery_states, "session-b");

        assert_eq!(
            resolved,
            (Some(InboundDeliveryMode::ManualFlush), Some("3".into()))
        );
    }

    #[test]
    fn returns_no_delivery_state_for_an_unknown_session_id() {
        let terminal_sessions: HashMap<String, TerminalSession> = HashMap::new();
        let delivery_states: HashMap<WorkerName, InboundDeliveryState> = HashMap::new();

        let resolved =
            resolve_ready_delivery_state(&terminal_sessions, &delivery_states, "no-such-session");

        assert_eq!(resolved, (None, None));
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

    #[test]
    fn protocol_pid_accepts_only_u32_payload_values() {
        assert_eq!(protocol_pid(&json!({"payload": {"pid": 42}})), Some(42));
        assert_eq!(protocol_pid(&json!({"payload": {"pid": 0}})), None);
        assert_eq!(
            protocol_pid(&json!({"payload": {"pid": u64::from(u32::MAX) + 1}})),
            None
        );
        assert_eq!(protocol_pid(&json!({"payload": {"pid": "42"}})), None);
    }

    #[test]
    fn worker_generation_gate_rejects_stale_same_name_events() {
        let current = Uuid::new_v4();
        assert!(worker_event_is_current(Some(current), current));
        assert!(!worker_event_is_current(Some(current), Uuid::new_v4()));
        assert!(!worker_event_is_current(None, current));
    }

    #[test]
    fn harness_started_records_liveness_without_readiness() {
        let mut harness_pid = None;
        assert!(record_started_harness_pid(
            &AgentRuntime::Pty,
            &mut harness_pid,
            &json!({"payload": {"pid": 42}})
        ));
        assert_eq!(harness_pid, Some(42));

        let now = Instant::now();
        let live_pid = std::process::id();
        assert!(record_started_harness_pid(
            &AgentRuntime::Pty,
            &mut harness_pid,
            &json!({"payload": {"pid": live_pid}})
        ));
        assert_eq!(
            crate::worker::orphaned_worker(
                harness_pid,
                None,
                now - std::time::Duration::from_secs(120),
                now,
            ),
            None,
            "reported harness liveness must bypass the never-ready deadline"
        );

        let mut zero_pid = None;
        assert!(!record_started_harness_pid(
            &AgentRuntime::Pty,
            &mut zero_pid,
            &json!({"payload": {"pid": 0}})
        ));
        assert_eq!(
            crate::worker::orphaned_worker(
                zero_pid,
                None,
                now - std::time::Duration::from_secs(120),
                now,
            ),
            Some(crate::worker::OrphanedWorker::NeverReady),
            "a zero pid must not suppress the never-ready deadline"
        );

        let mut headless_pid = None;
        assert!(!record_started_harness_pid(
            &AgentRuntime::Headless,
            &mut headless_pid,
            &json!({"payload": {"pid": 42}})
        ));
        assert_eq!(headless_pid, None);
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
        let dead_letters = &mut self.dead_letters;
        let terminal_failed_deliveries = &mut self.terminal_failed_deliveries;
        let pending_requests = &mut self.pending_requests;
        let pending_verified_spawns = &mut self.pending_verified_spawns;
        let delivery_retry_interval = self.delivery_retry_interval;
        let fleet_control_tx = &self.fleet_control_tx;
        let fleet_delivery_book = &mut self.fleet_delivery_book;
        let fleet_inventory = &mut self.fleet_inventory;
        let delivery_states = &self.delivery_states;
        let terminal_control_tx = &self.terminal_control_tx;
        let terminal_sessions = &mut self.terminal_sessions;
        let terminal_snapshot_requests = &mut self.terminal_snapshot_requests;
        let terminal_input_requests = &mut self.terminal_input_requests;

        match worker_event {
            WorkerEvent::WriterFailed {
                name,
                generation,
                error,
            } => {
                let current_generation = workers.workers.get(&name).map(|handle| handle.generation);
                if !worker_event_is_current(current_generation, generation) {
                    tracing::debug!(
                        target = "agent_relay::broker",
                        worker = %name,
                        event_generation = %generation,
                        current_generation = ?current_generation,
                        "ignoring writer failure from stale worker generation"
                    );
                    return;
                }

                tracing::warn!(
                    target = "relay_broker::terminal",
                    worker = %name,
                    error = %error,
                    "worker command writer failed; closing attached terminals and resetting worker"
                );
                let session_ids: Vec<String> = terminal_sessions
                    .iter()
                    .filter(|(_, session)| session.agent == name)
                    .map(|(session_id, _)| session_id.clone())
                    .collect();
                for session_id in session_ids {
                    fail_terminal_session(
                        terminal_control_tx,
                        terminal_sessions,
                        terminal_snapshot_requests,
                        terminal_input_requests,
                        session_id,
                        "worker_write_failed",
                        format!("worker command writer failed: {error}"),
                    );
                }
                if let Err(release_error) = workers.terminate_after_writer_failure(name.as_str()) {
                    tracing::warn!(
                        target = "relay_broker::terminal",
                        worker = %name,
                        error = %release_error,
                        "failed to signal worker after command writer failure"
                    );
                }
            }
            WorkerEvent::Message {
                name,
                generation,
                value,
            } => {
                let current_generation = workers.workers.get(&name).map(|handle| handle.generation);
                if !worker_event_is_current(current_generation, generation) {
                    tracing::debug!(
                        target = "agent_relay::broker",
                        worker = %name,
                        event_generation = %generation,
                        current_generation = ?current_generation,
                        "ignoring event from stale worker generation"
                    );
                    return;
                }
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

                                // Resolve a fleet (engine-facing) ack withheld
                                // pending confirmation of this exact PTY
                                // injection (relay#1310). No-op when nothing
                                // is withheld for this delivery — the
                                // delivery_id/event_id match already happened
                                // above via `clear_pending_delivery_if_event_matches`,
                                // so a stale/reused id naturally yields `pending
                                // = None` here too (relay#1543).
                                if let Some((agent, up_to_seq)) =
                                    resolve_pending_fleet_ack(pending.as_ref(), fleet_delivery_book)
                                {
                                    let _ = fleet_control_tx
                                        .send(FleetControlCommand::Send(delivery_ack(
                                            agent, up_to_seq,
                                        )))
                                        .await;
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
                                    + delivery_ack_timeout(
                                        &pending.delivery.injection_mode,
                                        delivery_retry_interval,
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
                                let _ = emit_dropped_delivery_failures(
                                    sdk_out_tx,
                                    dead_letters,
                                    std::slice::from_ref(&pending),
                                    reason,
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
                        let terminal_input_session_id = value
                            .get("request_id")
                            .and_then(Value::as_str)
                            .and_then(|request_id| terminal_input_requests.remove(request_id))
                            .map(|request| request.session_id);
                        let terminal_snapshot_request = value
                            .get("request_id")
                            .and_then(Value::as_str)
                            .and_then(|request_id| terminal_snapshot_requests.remove(request_id))
                            .map(|request| (request.session_id, request.client_request_id));
                        if let Some(session_id) = terminal_input_session_id {
                            if !terminal_sessions.contains_key(&session_id) {
                                return;
                            }
                            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                            let message = if msg_type != "write_pty_response" {
                                TerminalToCloud::Error {
                                    session_id: session_id.clone(),
                                    code: "input_failed".into(),
                                    message:
                                        "terminal input returned an unexpected worker response"
                                            .into(),
                                    request_id: None,
                                }
                            } else if let Some(error) = payload.get("error") {
                                TerminalToCloud::Error {
                                    session_id: session_id.clone(),
                                    code: error
                                        .get("code")
                                        .and_then(Value::as_str)
                                        .unwrap_or("input_failed")
                                        .to_string(),
                                    message: error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("terminal input failed")
                                        .to_string(),
                                    request_id: None,
                                }
                            } else if let Some(bytes_written) =
                                payload.get("bytes_written").and_then(Value::as_u64)
                            {
                                TerminalToCloud::InputAck {
                                    session_id: session_id.clone(),
                                    bytes_written: usize::try_from(bytes_written)
                                        .unwrap_or(usize::MAX),
                                }
                            } else {
                                TerminalToCloud::Error {
                                    session_id: session_id.clone(),
                                    code: "input_failed".into(),
                                    message: "terminal input response was malformed".into(),
                                    request_id: None,
                                }
                            };
                            if !try_send_terminal(terminal_control_tx, message) {
                                tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal queue full or closed while reporting PTY input result; ending session");
                                end_terminal_session(
                                    terminal_control_tx,
                                    terminal_sessions,
                                    terminal_snapshot_requests,
                                    terminal_input_requests,
                                    &session_id,
                                    "output_backpressure",
                                    "terminal output queue is full",
                                );
                            }
                        } else if let Some((session_id, client_request_id)) =
                            terminal_snapshot_request
                        {
                            if !terminal_sessions.contains_key(&session_id) {
                                return;
                            }
                            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                            // Look up the session's agent so we can include its
                            // current delivery mode in the Ready frame, giving
                            // the client an authoritative initial mode rather
                            // than an inferred guess.
                            let (session_delivery_mode, session_delivery_revision) =
                                resolve_ready_delivery_state(
                                    terminal_sessions,
                                    delivery_states,
                                    &session_id,
                                );
                            let message = if msg_type != "snapshot_response" {
                                TerminalToCloud::Error {
                                    session_id: session_id.clone(),
                                    code: "snapshot_failed".into(),
                                    message:
                                        "terminal snapshot returned an unexpected worker response"
                                            .into(),
                                    request_id: client_request_id.clone(),
                                }
                            } else if let Some(error) = payload.get("error") {
                                TerminalToCloud::Error {
                                    session_id: session_id.clone(),
                                    code: error
                                        .get("code")
                                        .and_then(Value::as_str)
                                        .unwrap_or("snapshot_failed")
                                        .to_string(),
                                    message: error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("terminal snapshot failed")
                                        .to_string(),
                                    request_id: client_request_id.clone(),
                                }
                            } else if let (Some(screen), Some(rows), Some(cols)) = (
                                payload.get("screen").and_then(Value::as_str),
                                payload
                                    .get("rows")
                                    .and_then(Value::as_u64)
                                    .and_then(|value| u16::try_from(value).ok()),
                                payload
                                    .get("cols")
                                    .and_then(Value::as_u64)
                                    .and_then(|value| u16::try_from(value).ok()),
                            ) {
                                if let Some(request_id) = client_request_id.clone() {
                                    TerminalToCloud::Snapshot {
                                        session_id: session_id.clone(),
                                        request_id,
                                        screen: screen.to_string(),
                                        rows,
                                        cols,
                                        offset: payload
                                            .get("offset")
                                            .and_then(Value::as_u64)
                                            .unwrap_or(0),
                                    }
                                } else {
                                    TerminalToCloud::Ready {
                                        session_id: session_id.clone(),
                                        screen: screen.to_string(),
                                        rows,
                                        cols,
                                        offset: payload
                                            .get("offset")
                                            .and_then(Value::as_u64)
                                            .unwrap_or(0),
                                        delivery_mode: session_delivery_mode,
                                        delivery_revision: session_delivery_revision,
                                    }
                                }
                            } else {
                                TerminalToCloud::Error {
                                    session_id: session_id.clone(),
                                    code: "snapshot_failed".into(),
                                    message: "terminal snapshot response was malformed".into(),
                                    request_id: client_request_id.clone(),
                                }
                            };
                            let snapshot_ready = matches!(&message, TerminalToCloud::Ready { .. });
                            let snapshot_failure = match &message {
                                TerminalToCloud::Error { code, message, .. } => {
                                    Some((code.clone(), message.clone()))
                                }
                                _ => None,
                            };
                            if !try_send_terminal(terminal_control_tx, message) {
                                tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal queue full or closed while sending snapshot; ending session");
                                end_terminal_session(
                                    terminal_control_tx,
                                    terminal_sessions,
                                    terminal_snapshot_requests,
                                    terminal_input_requests,
                                    &session_id,
                                    "output_backpressure",
                                    "terminal output queue is full",
                                );
                            } else if snapshot_ready {
                                let pending_output =
                                    if let Some(session) = terminal_sessions.get_mut(&session_id) {
                                        session.ready = true;
                                        session.pending_output_bytes = 0;
                                        std::mem::take(&mut session.pending_output)
                                    } else {
                                        Vec::new()
                                    };
                                for (chunk, offset) in pending_output {
                                    if !try_send_terminal(
                                        terminal_control_tx,
                                        TerminalToCloud::Output {
                                            session_id: session_id.clone(),
                                            chunk,
                                            offset,
                                        },
                                    ) {
                                        tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal queue full or closed while flushing buffered output; ending session");
                                        end_terminal_session(
                                            terminal_control_tx,
                                            terminal_sessions,
                                            terminal_snapshot_requests,
                                            terminal_input_requests,
                                            &session_id,
                                            "output_backpressure",
                                            "terminal output queue is full",
                                        );
                                        break;
                                    }
                                }
                            } else if client_request_id.is_none() {
                                if let Some((code, message)) = snapshot_failure {
                                    end_terminal_session(
                                        terminal_control_tx,
                                        terminal_sessions,
                                        terminal_snapshot_requests,
                                        terminal_input_requests,
                                        &session_id,
                                        &code,
                                        &message,
                                    );
                                }
                            }
                        } else {
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
                        let payload = value.get("payload");
                        let chunk = payload
                            .and_then(|payload| payload.get("chunk"))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let offset = payload
                            .and_then(|payload| payload.get("offset"))
                            .and_then(Value::as_u64);
                        let mut stream_event = json!({
                            "kind": "worker_stream",
                            "name": name,
                            "stream": payload.and_then(|p| p.get("stream")).cloned().unwrap_or(Value::String("stdout".to_string())),
                            "chunk": chunk.clone(),
                        });
                        // Forward the per-worker stream offset when present so
                        // attaching clients can correlate the live stream with
                        // a snapshot. Absent for headless workers (no grid).
                        if let Some(offset) = offset {
                            if let Some(obj) = stream_event.as_object_mut() {
                                obj.insert("offset".to_string(), Value::from(offset));
                            }
                        }
                        if !chunk.is_empty() {
                            publish_terminal_output(
                                terminal_control_tx,
                                terminal_sessions,
                                terminal_snapshot_requests,
                                terminal_input_requests,
                                &name,
                                chunk,
                                offset,
                            );
                        }
                        let _ = send_event(sdk_out_tx, stream_event).await;
                    } else if msg_type == "harness_started" {
                        // A running child process proves liveness but not that
                        // its TUI is ready for injected input. Record the pid so
                        // startup maintenance can distinguish a live, slow (or
                        // unrecognized) prompt from a dead harness. Do not set
                        // ready_at or release initial_tasks here.
                        if let Some(handle) = workers.workers.get_mut(&name) {
                            record_started_harness_pid(
                                &handle.spec.runtime,
                                &mut handle.harness_pid,
                                &value,
                            );
                        }
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
                        // Resolve the verified Fleet action before optional SDK
                        // notifications and initial-task work. A congested SDK
                        // output queue must not turn a ready worker into an
                        // action timeout.
                        let pending = pending_verified_spawns
                            .get(&name)
                            .is_some_and(|pending| pending.generation == generation)
                            .then(|| pending_verified_spawns.remove(&name))
                            .flatten();
                        if let Some(pending) = pending {
                            let _ = fleet_control_tx
                                .send(FleetControlCommand::Send(
                                    crate::fleet_wire::BrokerToRelaycast::ActionResult(
                                        verified_spawn_ready_result(pending.invocation_id, &name),
                                    ),
                                ))
                                .await;
                        }
                        let interactive_hold_replayed = is_pty_worker
                            && delivery_states
                                .get(&name)
                                .map(|s| s.mode == InboundDeliveryMode::ManualFlush)
                                .unwrap_or(false);
                        if interactive_hold_replayed {
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
                                None,
                            )
                            .await
                            {
                                tracing::warn!(worker = %name, error = %e, "failed to deliver initial_task");
                            }
                            // The initial task bypasses the delivery-mode queue, but the
                            // hold replayed above freezes injection pops inside the PTY
                            // worker — so without this frame the task the spawn was asked
                            // to run sits invisibly in the worker's queue until the hold
                            // lifts. A worker that restarts while explicitly held reaches
                            // `worker_ready` in exactly that state. The spawn asked for
                            // this task, so a one-shot exemption releases it; later relay
                            // messages keep parking under the hold as usual.
                            //
                            // The flush is scoped to this task's own `event_id`. A blanket
                            // flush would exempt the worker's whole queue, and a restart
                            // keeps unacknowledged deliveries (see `maintenance.rs`), so a
                            // relay message retried into the new worker before
                            // `worker_ready` would splice into the human's session too.
                            if interactive_hold_replayed {
                                if let Err(err) = workers
                                    .send_to_worker(
                                        &name,
                                        "flush_injections",
                                        None,
                                        json!({ "event_id": event_id }),
                                    )
                                    .await
                                {
                                    tracing::warn!(
                                        worker = %name,
                                        error = %err,
                                        "failed to release initial task through interactive hold"
                                    );
                                }
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
                        let payload_pid = protocol_pid(&value);
                        let (provider_val, cli_val, model_val, session_id_val, pid_val) = workers
                            .workers
                            .get_mut(&name)
                            .map(|h| {
                                if let Some(pid) = payload_pid {
                                    h.harness_pid = Some(pid);
                                }
                                // Records that the harness actually came up, so
                                // `reap_exited` can tell a slow start from one that
                                // never happened.
                                h.ready_at.get_or_insert_with(Instant::now);
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
                                "generation": generation,
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
                                "generation": generation,
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
                                "generation": generation,
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
                                                    None,
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
