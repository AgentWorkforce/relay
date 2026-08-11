use super::*;
use crate::{
    fleet_wire::{
        ActionInvoke, ActionResult, ActionResultError, ActionResultOutput, ActionResultPayload,
        AgentDeregister, AgentRegister, BrokerToRelaycast, Deliver, DeliveryMode,
        RelaycastToBroker, FLEET_WIRE_VERSION,
    },
    node_control::{delivery_ack, handler_unavailable_result, DeliveryDecision},
    terminal_control::{
        TerminalControlCommand, TerminalControlEvent, TerminalFromCloud, TerminalMode,
        TerminalToCloud,
    },
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

const FLEET_AGENT_REGISTER_TIMEOUT: Duration = Duration::from_secs(30);
const VERIFIED_SPAWN_READY_TIMEOUT: Duration = Duration::from_secs(90);
const TERMINAL_INPUT_MAX_BYTES: usize = 64 * 1024;
const TERMINAL_INPUT_MAX_BASE64_BYTES: usize = TERMINAL_INPUT_MAX_BYTES * 4 / 3 + 4;
const TERMINAL_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_INPUT_ACK_TIMEOUT: Duration = Duration::from_secs(5);
// Terminal worker writes share the broker event loop with fleet control and
// worker lifecycle events. A wedged PTY must fail only its own attach instead
// of awaiting an unbounded pipe write in that loop.
const TERMINAL_WORKER_WRITE_TIMEOUT: Duration = Duration::from_millis(250);
const TERMINAL_INPUT_MAX_IN_FLIGHT_PER_SESSION: usize = 16;
// Relaycast currently limits a node to 32 terminal sessions. Keep that many
// slots free from high-volume frames so every affected session can still get a
// terminal.closed notification when the output lane applies backpressure.
const TERMINAL_CLOSE_RESERVE: usize = 32;

pub(super) fn try_send_terminal(
    terminal_control_tx: &mpsc::Sender<TerminalControlCommand>,
    message: TerminalToCloud,
) -> bool {
    let is_close = matches!(&message, TerminalToCloud::Closed { .. });
    if !is_close && terminal_control_tx.capacity() <= TERMINAL_CLOSE_RESERVE {
        return false;
    }
    terminal_control_tx
        .try_send(TerminalControlCommand::Send(message))
        .is_ok()
}

#[derive(Debug, Clone)]
pub(super) struct PendingVerifiedSpawn {
    pub(super) invocation_id: String,
    pub(super) deadline: Instant,
    pub(super) generation: Uuid,
}

pub(super) fn verified_spawn_ready_result(
    invocation_id: String,
    name: &WorkerName,
) -> ActionResult {
    ActionResult {
        v: FLEET_WIRE_VERSION,
        id: None,
        invocation_id,
        result: ActionResultPayload::Output(ActionResultOutput {
            output: json!({ "spawned": true, "ready": true, "name": name.as_str() }),
        }),
    }
}

pub(super) fn verified_spawn_failed_result(invocation_id: String, error: &str) -> ActionResult {
    ActionResult {
        v: FLEET_WIRE_VERSION,
        id: None,
        invocation_id,
        result: ActionResultPayload::Error(ActionResultError {
            error: error.to_string(),
        }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FleetDeliverySurfaceOutcome {
    Acknowledge,
    HoldForManualFlush,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FleetDeliveryPlan {
    Surface,
    Acknowledge(u64),
    RejectWithoutAck,
}

fn plan_fleet_delivery(decision: DeliveryDecision) -> FleetDeliveryPlan {
    match decision {
        DeliveryDecision::Deliver { .. } => FleetDeliveryPlan::Surface,
        DeliveryDecision::Duplicate { up_to_seq }
        | DeliveryDecision::Stale { up_to_seq }
        | DeliveryDecision::Gap { up_to_seq } => FleetDeliveryPlan::Acknowledge(up_to_seq),
        DeliveryDecision::IdentityReject => FleetDeliveryPlan::RejectWithoutAck,
    }
}

impl BrokerRuntime {
    pub(super) async fn handle_terminal_control_event(&mut self, event: TerminalControlEvent) {
        match event {
            TerminalControlEvent::Connected => {
                tracing::info!(
                    target = "relay_broker::terminal",
                    "fleet terminal transport connected"
                );
            }
            TerminalControlEvent::Disconnected => {
                tracing::warn!(
                    target = "relay_broker::terminal",
                    sessions = self.terminal_sessions.len(),
                    "fleet terminal transport disconnected; clearing sessions for cloud resync"
                );
                // Relaycast re-opens live terminal sessions when this dedicated
                // lane reconnects. Drop the old connection's state now so input
                // and snapshot replies cannot be routed into a server-side
                // session that was invalidated with the old websocket.
                self.terminal_sessions.clear();
                self.terminal_snapshot_requests.clear();
                self.terminal_input_requests.clear();
            }
            TerminalControlEvent::Message(TerminalFromCloud::Open {
                session_id,
                agent,
                mode,
            }) => {
                let agent_name = WorkerName::new(agent.clone());
                let runtime = self
                    .workers
                    .workers
                    .get(&agent_name)
                    .map(|handle| handle.spec.runtime.clone());
                match runtime {
                    None => self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "agent_not_found".to_string(),
                        message: format!("no worker named '{agent}'"),
                    }),
                    Some(AgentRuntime::Headless) => self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "unsupported_runtime".to_string(),
                        message: format!("worker '{agent}' is headless and has no PTY"),
                    }),
                    Some(AgentRuntime::Pty) => {
                        self.terminal_sessions.insert(
                            session_id.clone(),
                            TerminalSession {
                                agent: agent_name.clone(),
                                mode,
                                ready: false,
                                pending_output: Vec::new(),
                                pending_output_bytes: 0,
                            },
                        );
                        // Request the grid asynchronously. The response is routed
                        // from worker_events to the terminal lane, so this never
                        // stalls heartbeat/action processing behind a PTY snapshot.
                        let request_id = format!("terminal_snapshot_{}", Uuid::new_v4().simple());
                        match tokio::time::timeout(
                            TERMINAL_WORKER_WRITE_TIMEOUT,
                            self.workers.send_to_worker(
                                agent_name.as_str(),
                                "snapshot_pty",
                                Some(RequestId::new(request_id.clone())),
                                json!({ "format": "ansi" }),
                            ),
                        )
                        .await
                        {
                            Ok(Ok(())) => {
                                self.terminal_snapshot_requests.insert(
                                    request_id,
                                    TerminalSnapshotRequest {
                                        session_id,
                                        deadline: Instant::now() + TERMINAL_SNAPSHOT_TIMEOUT,
                                    },
                                );
                            }
                            Ok(Err(error)) => {
                                self.fail_terminal_session(
                                    session_id,
                                    "snapshot_failed",
                                    error.to_string(),
                                );
                            }
                            Err(_) => {
                                self.fail_terminal_session(
                                    session_id,
                                    "snapshot_timeout",
                                    "terminal snapshot write timed out".into(),
                                );
                            }
                        }
                    }
                }
            }
            TerminalControlEvent::Message(TerminalFromCloud::Input {
                session_id,
                data_base64,
            }) => {
                let Some(session) = self.terminal_sessions.get(&session_id).cloned() else {
                    self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "session_not_found".into(),
                        message: "terminal session is not active".into(),
                    });
                    return;
                };
                if session.mode == TerminalMode::View {
                    self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "read_only".into(),
                        message: "view sessions do not accept input".into(),
                    });
                    return;
                }
                if !session.ready {
                    self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "session_not_ready".into(),
                        message: "terminal snapshot is not ready".into(),
                    });
                    return;
                }
                if data_base64.len() > TERMINAL_INPUT_MAX_BASE64_BYTES {
                    self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "invalid_input".into(),
                        message: "terminal input must be bounded base64 UTF-8".into(),
                    });
                    return;
                }
                let bytes = match BASE64.decode(data_base64.as_bytes()) {
                    Ok(bytes) if bytes.len() <= TERMINAL_INPUT_MAX_BYTES => bytes,
                    _ => {
                        self.send_terminal(TerminalToCloud::Error {
                            session_id,
                            code: "invalid_input".into(),
                            message: "terminal input must be bounded base64 UTF-8".into(),
                        });
                        return;
                    }
                };
                let data = match String::from_utf8(bytes) {
                    Ok(data) => data,
                    Err(_) => {
                        self.send_terminal(TerminalToCloud::Error {
                            session_id,
                            code: "invalid_input".into(),
                            message: "terminal input must be UTF-8".into(),
                        });
                        return;
                    }
                };
                if self
                    .terminal_input_requests
                    .values()
                    .filter(|pending| pending.session_id == session_id)
                    .count()
                    >= TERMINAL_INPUT_MAX_IN_FLIGHT_PER_SESSION
                {
                    self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "input_backpressure".into(),
                        message: "terminal input acknowledgement backlog is full".into(),
                    });
                    return;
                }
                let request_id = format!("terminal_input_{}", Uuid::new_v4().simple());
                match tokio::time::timeout(
                    TERMINAL_WORKER_WRITE_TIMEOUT,
                    self.workers.send_to_worker(
                        session.agent.as_str(),
                        "write_pty",
                        Some(RequestId::new(request_id.clone())),
                        json!({ "data": data }),
                    ),
                )
                .await
                {
                    Ok(Ok(())) => {
                        self.terminal_input_requests.insert(
                            request_id,
                            TerminalInputRequest {
                                session_id,
                                deadline: Instant::now() + TERMINAL_INPUT_ACK_TIMEOUT,
                            },
                        );
                    }
                    Ok(Err(error)) => {
                        self.fail_terminal_session(session_id, "input_failed", error.to_string())
                    }
                    Err(_) => self.fail_terminal_session(
                        session_id,
                        "input_timeout",
                        "terminal input write timed out".into(),
                    ),
                }
            }
            TerminalControlEvent::Message(TerminalFromCloud::Resize {
                session_id,
                rows,
                cols,
            }) => {
                let Some(session) = self.terminal_sessions.get(&session_id).cloned() else {
                    self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "session_not_found".into(),
                        message: "terminal session is not active".into(),
                    });
                    return;
                };
                if session.mode == TerminalMode::View {
                    self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "read_only".into(),
                        message: "view sessions do not resize the PTY".into(),
                    });
                    return;
                }
                if !session.ready {
                    self.send_terminal(TerminalToCloud::Error {
                        session_id,
                        code: "session_not_ready".into(),
                        message: "terminal snapshot is not ready".into(),
                    });
                    return;
                }
                match tokio::time::timeout(
                    TERMINAL_WORKER_WRITE_TIMEOUT,
                    self.workers.send_to_worker(
                        session.agent.as_str(),
                        "resize_pty",
                        None,
                        json!({ "rows": rows, "cols": cols }),
                    ),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        self.fail_terminal_session(session_id, "resize_failed", error.to_string())
                    }
                    Err(_) => self.fail_terminal_session(
                        session_id,
                        "resize_timeout",
                        "terminal resize write timed out".into(),
                    ),
                }
            }
            TerminalControlEvent::Message(TerminalFromCloud::Close { session_id }) => {
                self.terminal_sessions.remove(&session_id);
                self.terminal_snapshot_requests
                    .retain(|_, pending| pending.session_id != session_id);
                self.terminal_input_requests
                    .retain(|_, pending| pending.session_id != session_id);
                self.send_terminal(TerminalToCloud::Closed {
                    session_id,
                    code: None,
                    message: None,
                });
            }
        }
    }

    /// Attempts a bounded enqueue onto the dedicated terminal lane. On
    /// saturation we tear down the affected session instead of accumulating
    /// unbounded PTY output or delaying control traffic.
    pub(super) fn send_terminal(&mut self, message: TerminalToCloud) {
        let session_id = match &message {
            TerminalToCloud::Ready { session_id, .. }
            | TerminalToCloud::Output { session_id, .. }
            | TerminalToCloud::InputAck { session_id, .. }
            | TerminalToCloud::Error { session_id, .. }
            | TerminalToCloud::Closed { session_id, .. } => session_id.clone(),
        };
        let is_close = matches!(&message, TerminalToCloud::Closed { .. });
        if !try_send_terminal(&self.terminal_control_tx, message) {
            tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal queue full or closed; ending session");
            self.terminal_sessions.remove(&session_id);
            self.terminal_snapshot_requests
                .retain(|_, pending| pending.session_id != session_id);
            self.terminal_input_requests
                .retain(|_, pending| pending.session_id != session_id);
            if !is_close
                && !try_send_terminal(
                    &self.terminal_control_tx,
                    TerminalToCloud::Closed {
                        session_id: session_id.clone(),
                        code: Some("output_backpressure".into()),
                        message: Some("terminal output queue is full".into()),
                    },
                )
            {
                tracing::warn!(target = "relay_broker::terminal", session_id = %session_id, "terminal close could not be queued after backpressure");
            }
        }
    }

    fn fail_terminal_session(&mut self, session_id: String, code: &str, message: String) {
        self.terminal_sessions.remove(&session_id);
        self.terminal_snapshot_requests
            .retain(|_, pending| pending.session_id != session_id);
        self.terminal_input_requests
            .retain(|_, pending| pending.session_id != session_id);
        self.send_terminal(TerminalToCloud::Error {
            session_id: session_id.clone(),
            code: code.into(),
            message: message.clone(),
        });
        self.send_terminal(TerminalToCloud::Closed {
            session_id,
            code: Some(code.into()),
            message: Some(message),
        });
    }

    pub(super) async fn handle_fleet_control_event(&mut self, event: FleetControlEvent) {
        match event {
            FleetControlEvent::Connected => {
                self.node_delivery_token_present = true;
                self.node_delivery_connected = true;
                // Node delivery is live: message delivery flows solely over
                // /v1/node/ws. The workspace firehose delivery path was removed,
                // so there is no firehose injection to suppress here.
                tracing::info!(
                    target = "relay_broker::fleet",
                    "fleet node control connected; node delivery active"
                );
            }
            FleetControlEvent::Disconnected => {
                self.node_delivery_connected = false;
                tracing::warn!(
                    target = "relay_broker::fleet",
                    "fleet node control disconnected"
                );
            }
            FleetControlEvent::Message(RelaycastToBroker::Deliver(deliver)) => {
                self.handle_fleet_deliver(deliver).await;
            }
            FleetControlEvent::Message(RelaycastToBroker::ActionInvoke(invoke)) => {
                self.handle_fleet_action_invoke(invoke).await;
            }
            FleetControlEvent::Message(RelaycastToBroker::Ping(_))
            | FleetControlEvent::Message(RelaycastToBroker::Reply(_))
            | FleetControlEvent::Message(RelaycastToBroker::Error(_)) => {}
        }
    }

    async fn handle_fleet_deliver(&mut self, deliver: Deliver) {
        // Obligation discharge: before surfacing, check if this is an author
        // done-reaction that should clear an outstanding obligation (#1474).
        // Done here (not in surface_fleet_deliver) to avoid borrow conflicts
        // between &self and &mut self.obligation_store.
        if crate::obligation::boomerang_enabled() {
            if deliver
                .payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("")
                == "message.reacted"
            {
                let emoji = deliver
                    .payload
                    .get("emoji")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let msg_id = deliver
                    .payload
                    .get("message_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let reactor = deliver
                    .payload
                    .get("agent_name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if emoji == crate::obligation::DONE_EMOJI
                    && !msg_id.is_empty()
                    && !reactor.is_empty()
                {
                    if self.obligation_store.try_discharge(msg_id, reactor) {
                        tracing::info!(
                            target = "relay_broker::obligation",
                            msg_id = %msg_id,
                            reactor = %reactor,
                            "obligation discharged by author done-reaction"
                        );
                    }
                }
            }
        }

        let decision = self.fleet_delivery_book.observe(&deliver);
        let up_to_seq = match plan_fleet_delivery(decision) {
            FleetDeliveryPlan::Surface => match self.surface_fleet_deliver(&deliver).await {
                Ok(FleetDeliverySurfaceOutcome::Acknowledge) => {
                    self.fleet_delivery_book.commit_delivered(&deliver)
                }
                Ok(FleetDeliverySurfaceOutcome::HoldForManualFlush) => {
                    self.fleet_delivery_book.commit_received(&deliver);
                    return;
                }
                Err(error) => {
                    tracing::warn!(
                        target = "relay_broker::fleet",
                        agent = %deliver.agent,
                        delivery_id = %deliver.delivery_id,
                        msg_id = %deliver.msg_id,
                        error = %error,
                        "fleet delivery injection failed; withholding ack"
                    );
                    return;
                }
            },
            FleetDeliveryPlan::Acknowledge(up_to_seq) => up_to_seq,
            FleetDeliveryPlan::RejectWithoutAck => {
                tracing::warn!(
                    target = "relay_broker::fleet",
                    agent = %deliver.agent,
                    agent_id = %deliver.agent_id,
                    delivery_id = %deliver.delivery_id,
                    msg_id = %deliver.msg_id,
                    "rejecting fleet delivery with conflicting agent identity; withholding ack"
                );
                return;
            }
        };
        let _ = self
            .fleet_control_tx
            .send(FleetControlCommand::Send(delivery_ack(
                deliver.agent,
                up_to_seq,
            )))
            .await;
    }

    /// Surface a node `deliver` frame by branching on its payload `type`:
    /// message-class events inject into the recipient worker's PTY; reaction /
    /// read receipts are acked with a tracing log only (PTY surfacing deferred).
    /// `Acknowledge` means the delivery crossed the PTY injection boundary;
    /// `HoldForManualFlush` means it was received into the volatile FIFO but
    /// remains owned by Relaycast until a later successful flush.
    async fn surface_fleet_deliver(
        &mut self,
        deliver: &Deliver,
    ) -> Result<FleetDeliverySurfaceOutcome, anyhow::Error> {
        let payload_type = deliver
            .payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("");
        match classify_fleet_delivery(payload_type) {
            // Route through the same per-worker InboundDeliveryMode choke
            // point as the HTTP/sidecar send path (`queue_inbound_for_delivery_mode`
            // in runtime/delivery.rs). Node delivery is the ONLY delivery
            // path now that direct local injection has been removed from
            // `ListenApiRequest::Send`, so if manual_flush isn't honored
            // here, it's never honored anywhere.
            FleetDeliverySurfacing::Inject => {
                let fields = fleet_delivery_fields(&deliver.payload, &deliver.agent);

                // Mirror the `relay_inbound` dashboard event that the HTTP
                // `Send` handler (`ListenApiRequest::Send` in runtime/api.rs)
                // emits at send time, so Pear's dashboard learns about
                // agent-originated / remote channel & DM traffic live, the
                // same way it already does for messages a human sends from
                // Pear's own UI. Without this, a human's own message shows
                // up instantly but an agent's reply to the same channel
                // never appears live (it's only injected into other agents'
                // PTYs here, and eventually reconciled via polling). See
                // `fleet_dashboard_relay_inbound_event`'s doc comment for how
                // it avoids both the per-recipient-fanout duplicate and the
                // dashboard-echoing-its-own-message duplicate.
                if let Some(dashboard_event) = fleet_dashboard_relay_inbound_event(
                    payload_type,
                    deliver,
                    &fields,
                    &self.default_workspace.self_name,
                    self.default_workspace_id.as_deref(),
                    self.default_workspace.workspace_alias.as_deref(),
                ) {
                    emit_http_api_event_with_timeout(
                        &self.sdk_out_tx,
                        dashboard_event,
                        http_api_event_emit_timeout(),
                    )
                    .await;
                }

                let injection_mode = match deliver.mode {
                    DeliveryMode::Wait => MessageInjectionMode::Wait,
                    DeliveryMode::Steer => MessageInjectionMode::Steer,
                };
                let priority = fields
                    .priority
                    .unwrap_or(if fields.target.starts_with('#') { 3 } else { 2 });
                let queue_result = queue_inbound_for_delivery_mode(
                    &mut self.delivery_states,
                    &self.workers,
                    &deliver.agent,
                    InboundContext {
                        from: &fields.from,
                        body: &fields.body,
                        target: &fields.target,
                        thread_id: fields.thread_id.as_deref(),
                        workspace_id: self.default_workspace_id.as_deref(),
                        workspace_alias: self.default_workspace.workspace_alias.as_deref(),
                        priority,
                        mode: injection_mode,
                        event_id: Some(&deliver.msg_id),
                        relaycast_receipt: Some(RelaycastDeliveryReceipt {
                            agent: WorkerName::from(&deliver.agent),
                            agent_id: AgentId::from(&deliver.agent_id),
                            delivery_id: DeliveryId::from(&deliver.delivery_id),
                            msg_id: EventId::from(&deliver.msg_id),
                            seq: deliver.seq,
                        }),
                    },
                );
                if let Some(dropped_from) = &queue_result.evicted_from {
                    let _ = send_broker_event(
                        &self.sdk_out_tx,
                        delivery_dropped_event_for_eviction(&deliver.agent, dropped_from),
                    )
                    .await;
                }

                // Obligation registration (#1474): if this is an obligating
                // message (body contains the marker) register it so the
                // maintenance boomerang sweep can re-surface it.
                if crate::obligation::boomerang_enabled()
                    && crate::obligation::is_obligating(&fields.body)
                {
                    let interval = Duration::from_millis(crate::obligation::interval_ms());
                    self.obligation_store.register(
                        deliver.msg_id.to_string(),
                        fields.from.clone(),
                        deliver.agent.to_string(),
                        interval,
                    );
                    tracing::info!(
                        target = "relay_broker::obligation",
                        msg_id = %deliver.msg_id,
                        author = %fields.from,
                        recipient = %deliver.agent,
                        "obligation registered for boomerang"
                    );
                }

                match queue_result.outcome {
                    InboundQueueOutcome::Queued => {
                        tracing::info!(
                            target = "relay_broker::fleet",
                            agent = %deliver.agent,
                            delivery_id = %deliver.delivery_id,
                            msg_id = %deliver.msg_id,
                            "queued node delivery (manual_flush inbound delivery mode)"
                        );
                        // Surface the hold as a `delivery_queued` event, as the
                        // now-removed local send path did. `attach --drive`
                        // counts these to show pending messages; node delivery
                        // is the only delivery path now, so this is the only
                        // place the event can originate. The `name` field is
                        // what scopes it to the worker on the consumer side.
                        let _ = send_event(
                            &self.sdk_out_tx,
                            json!({
                                "kind": "delivery_queued",
                                "name": deliver.agent.as_str(),
                                "event_id": deliver.msg_id.as_str(),
                                "delivery_id": deliver.delivery_id.as_str(),
                                "from": fields.from.as_str(),
                                "target": fields.target.as_str(),
                                "reason": "inbound_delivery_manual_flush",
                            }),
                        )
                        .await;
                        Ok(FleetDeliverySurfaceOutcome::HoldForManualFlush)
                    }
                    InboundQueueOutcome::DrainNow(to_drain) => {
                        // Mirrors the HTTP send path: drain may surface older
                        // backlog alongside the message this specific `deliver`
                        // frame is for. Only a failure injecting THIS delivery's
                        // own message should withhold the ack (causing the
                        // engine to redeliver it); backlog injection failures
                        // are logged and otherwise don't block the ack, since
                        // their own delivery frames already governed their acks.
                        let mut current_result = Ok(());
                        for queued in to_drain {
                            let is_current =
                                queued.event_id.as_deref() == Some(deliver.msg_id.as_str());
                            if let Err(error) = try_inject_pending_relay_message(
                                &mut self.workers,
                                &mut self.pending_deliveries,
                                &deliver.agent,
                                &queued,
                                self.delivery_retry_interval,
                            )
                            .await
                            {
                                if is_current {
                                    current_result = Err(error);
                                } else {
                                    tracing::warn!(
                                        target = "relay_broker::fleet",
                                        agent = %deliver.agent,
                                        from = %queued.from,
                                        error = %error,
                                        "failed to inject drained backlog message"
                                    );
                                }
                            }
                        }
                        current_result.map(|()| FleetDeliverySurfaceOutcome::Acknowledge)
                    }
                    InboundQueueOutcome::RejectedFull => anyhow::bail!(
                        "manual delivery queue is full for '{}'; retaining Relaycast ownership",
                        deliver.agent
                    ),
                    InboundQueueOutcome::WorkerMissing => {
                        let relay_delivery = self.fleet_relay_delivery(deliver);
                        self.workers
                            .deliver(&deliver.agent, relay_delivery)
                            .await
                            .map(|()| FleetDeliverySurfaceOutcome::Acknowledge)
                    }
                }
            }
            FleetDeliverySurfacing::AckOnly => {
                tracing::info!(
                    target = "relay_broker::fleet",
                    agent = %deliver.agent,
                    delivery_id = %deliver.delivery_id,
                    msg_id = %deliver.msg_id,
                    payload_type = %payload_type,
                    "acking node receipt/reaction delivery without PTY surfacing (deferred)"
                );
                Ok(FleetDeliverySurfaceOutcome::Acknowledge)
            }
            FleetDeliverySurfacing::AckUnknown => {
                tracing::warn!(
                    target = "relay_broker::fleet",
                    agent = %deliver.agent,
                    delivery_id = %deliver.delivery_id,
                    payload_type = %payload_type,
                    "acking unrecognized node delivery payload type without surfacing"
                );
                Ok(FleetDeliverySurfaceOutcome::Acknowledge)
            }
        }
    }

    fn fleet_relay_delivery(&self, deliver: &Deliver) -> RelayDelivery {
        let fields = fleet_delivery_fields(&deliver.payload, &deliver.agent);
        RelayDelivery {
            delivery_id: DeliveryId::new(deliver.delivery_id.clone()),
            event_id: EventId::new(deliver.msg_id.clone()),
            workspace_id: self.default_workspace_id.clone(),
            workspace_alias: self.default_workspace.workspace_alias.clone(),
            from: fields.from,
            target: MessageTarget::new(fields.target),
            body: fields.body,
            thread_id: fields.thread_id,
            priority: fields.priority,
            injection_mode: match deliver.mode {
                DeliveryMode::Wait => MessageInjectionMode::Wait,
                DeliveryMode::Steer => MessageInjectionMode::Steer,
            },
        }
    }

    async fn handle_fleet_action_invoke(&mut self, invoke: ActionInvoke) {
        // The broker is the node's capacity executor. The engine only dispatches
        // the capacity it owns — `spawn:<harness>` and `release` — to this
        // connection; the broker runs them directly against its PTY runtime.
        // Capability action handlers live in their own providers and are
        // dispatched to those sockets by the engine, never here.
        let action = invoke.action.as_str();
        if action == "spawn" || action.starts_with("spawn:") {
            self.handle_fleet_action_spawn(invoke).await;
            return;
        }
        if action == "release" {
            self.handle_fleet_action_release(invoke).await;
            return;
        }

        // An invoke for a capability the broker does not own should never reach
        // it (the engine routes actions to their registering provider). Reply
        // loudly rather than silently dropping the invocation.
        tracing::warn!(
            target = "relay_broker::fleet",
            action = %action,
            invocation_id = %invoke.invocation_id,
            "broker received action.invoke for a non-capacity action; replying handler_unavailable"
        );
        self.send_fleet_action_result(handler_unavailable_result(&invoke.invocation_id))
            .await;
    }

    /// Run a `spawn` / `spawn:<harness>` node action by parsing the invoke input
    /// into spawn fields and calling the local spawn fn (which binds the agent
    /// to this node). Replies with `action.result { output }` on success or
    /// `{ error }` on failure.
    async fn handle_fleet_action_spawn(&mut self, invoke: ActionInvoke) {
        let Some(name) = action_invoke_agent_name(&invoke) else {
            self.reply_action_error(&invoke.invocation_id, "spawn_missing_agent_name")
                .await;
            return;
        };
        if self.workers.workers.contains_key(&name)
            || self.pending_verified_spawns.contains_key(&name)
        {
            self.reply_action_error(&invoke.invocation_id, "spawn_agent_name_in_use")
                .await;
            return;
        }
        let cli = match action_invoke_string(&invoke.input, &["cli", "command", "provider"]) {
            Some(cli) => cli,
            None => {
                self.reply_action_error(&invoke.invocation_id, "spawn_missing_cli")
                    .await;
                return;
            }
        };
        let task = action_invoke_string(&invoke.input, &["task", "initial_task", "prompt"]);
        let channel = action_invoke_string(&invoke.input, &["channel"]);
        let model = action_invoke_string(&invoke.input, &["model"]);

        // Honor the task-exit lifecycle exactly like the local HTTP spawn API:
        // `spawn_mode: task_exit` / `exit_after_task: true` make the agent exit
        // once its task is done instead of idling. Reject an unknown spawn_mode
        // loudly rather than silently defaulting to interactive.
        let spawn_mode = action_invoke_string(&invoke.input, &["spawn_mode", "spawnMode"]);
        let explicit_exit_after_task =
            action_invoke_bool(&invoke.input, &["exit_after_task", "exitAfterTask"]);
        let exit_after_task =
            match resolve_exit_after_task(spawn_mode.as_deref(), explicit_exit_after_task) {
                Ok(value) => value,
                Err(error) => {
                    self.reply_action_error(&invoke.invocation_id, &error).await;
                    return;
                }
            };

        // Reuse the action input as the `ws_value` the spawn fn reads
        // harnessConfig / supplied tokens from, mirroring the firehose payload
        // shape (top-level and nested-`agent` lookups both work).
        let ws_value = invoke.input.clone();
        let workspace_id = self
            .default_workspace_id
            .clone()
            .or_else(|| self.workspaces.first().map(|w| w.workspace_id.clone()));
        let Some(workspace_id) = workspace_id else {
            self.reply_action_error(&invoke.invocation_id, "no_workspace_available")
                .await;
            return;
        };
        let workspace_state = self
            .workspace_lookup
            .get(&workspace_id)
            .cloned()
            .unwrap_or_else(|| self.default_workspace.clone());

        // Forward the invocation id and the harness session ref into the node
        // `agent.register` the spawn emits, mirroring the sidecar path
        // (`fleet_initial_session_ref(&spec)`). Without these, the invocation is
        // not correlated to the agent and a resumable `spawn:<harness>` (when
        // `harnessConfig.session_id` is set) silently becomes a fresh spawn.
        let session_ref = super::relaycast_events::relaycast_spawn_session_ref(&ws_value);
        // `action.invoke` is the authoritative control request, not a
        // workspace-firehose echo of a local spawn. Mark it with the same
        // control key the echo guard derives so a later release + respawn of
        // the same agent name is not suppressed by the five-minute
        // name-scoped echo cache.
        let action_control_dedup_key =
            relaycast_spawn_control_dedup_key(workspace_id.as_str(), name.as_str());

        super::relaycast_events::spawn_worker_from_request(
            name.clone(),
            cli,
            task,
            channel,
            model,
            exit_after_task,
            &ws_value,
            &workspace_id,
            Some(&action_control_dedup_key),
            &workspace_state,
            &mut self.workers,
            &mut self.state,
            &self.paths,
            &self.telemetry,
            &self.sdk_out_tx,
            &mut self.dedup,
            &mut self.agent_spawn_count,
            &self.fleet_control_tx,
            &mut self.fleet_delivery_book,
            &self.fleet_node_name,
            Some(invoke.invocation_id.clone()),
            session_ref,
            &self.hosted_agent_event_tx,
            &mut self.pty_observability,
        )
        .await;

        self.publish_fleet_load(true).await;

        let verify_ready = super::relaycast_events::relaycast_spawn_verifies_ready(&ws_value);

        // A verified spawn keeps the action open until the harness itself emits
        // worker_ready. Process creation alone is not proof that the persona is
        // usable; worker_events resolves this pending entry, while maintenance
        // fails it after an early exit/readiness timeout and performs cleanup.
        if self.workers.workers.contains_key(&name) {
            if verify_ready {
                if self
                    .workers
                    .workers
                    .get(&name)
                    .is_some_and(|worker| worker.ready_at.is_some())
                {
                    self.send_fleet_action_result(verified_spawn_ready_result(
                        invoke.invocation_id,
                        &name,
                    ))
                    .await;
                } else {
                    let generation = self
                        .workers
                        .workers
                        .get(&name)
                        .expect("verified spawn worker must still exist")
                        .generation;
                    self.pending_verified_spawns.insert(
                        name,
                        PendingVerifiedSpawn {
                            invocation_id: invoke.invocation_id,
                            deadline: Instant::now() + VERIFIED_SPAWN_READY_TIMEOUT,
                            generation,
                        },
                    );
                }
                return;
            }
            self.reply_action_output(
                &invoke.invocation_id,
                json!({ "spawned": true, "name": name.as_str() }),
            )
            .await;
        } else {
            // A registration can succeed before process creation fails. Undo
            // that authoritative identity before reporting the failed launch.
            match deregister_fleet_agent(&self.fleet_control_tx, &self.fleet_delivery_book, &name)
                .await
            {
                Ok(_) => {
                    prune_fleet_agent_state(
                        &self.fleet_control_tx,
                        &mut self.fleet_inventory,
                        &mut self.fleet_delivery_book,
                        &name,
                    )
                    .await
                }
                Err(error) => {
                    tracing::warn!(worker = %name, %error, "retaining fleet identity after failed spawn cleanup");
                    prune_fleet_inventory_entry(
                        &self.fleet_control_tx,
                        &mut self.fleet_inventory,
                        &name,
                    )
                    .await;
                }
            }
            self.reply_action_error(&invoke.invocation_id, "spawn_failed")
                .await;
        }
    }

    /// Run a `release` node action, routing by the invoke's agent_name (then
    /// agent_id) to the local release fn. Replies with `action.result`.
    async fn handle_fleet_action_release(&mut self, invoke: ActionInvoke) {
        let Some(name) = action_invoke_agent_name(&invoke) else {
            self.reply_action_error(&invoke.invocation_id, "release_missing_agent_name")
                .await;
            return;
        };
        let workspace_id = self
            .default_workspace_id
            .clone()
            .or_else(|| self.workspaces.first().map(|w| w.workspace_id.clone()));
        let workspace_state = workspace_id
            .as_ref()
            .and_then(|id| self.workspace_lookup.get(id).cloned())
            .unwrap_or_else(|| self.default_workspace.clone());

        let outcome = super::relaycast_events::release_worker_locally(
            name.clone(),
            &workspace_state,
            &mut self.workers,
            &mut self.state,
            &self.paths,
            &self.telemetry,
            &self.sdk_out_tx,
            &mut self.pending_deliveries,
            &mut self.dead_letters,
            &mut self.pending_requests,
            &mut self.delivery_states,
            &mut self.agent_result_tokens,
        )
        .await;

        // Drop any resize ownership for the released worker so a later worker
        // reusing the name isn't rejected by a stale single-resizer entry.
        self.resize_owners.remove(&name);
        self.pty_observability.remove(&name);

        let mut deregistration_failed = false;
        if outcome == super::relaycast_events::ReleaseOutcome::Released {
            match deregister_fleet_agent(&self.fleet_control_tx, &self.fleet_delivery_book, &name)
                .await
            {
                Ok(_) => {
                    prune_fleet_agent_state(
                        &self.fleet_control_tx,
                        &mut self.fleet_inventory,
                        &mut self.fleet_delivery_book,
                        &name,
                    )
                    .await;
                }
                Err(error) => {
                    tracing::warn!(worker = %name, %error, "retaining fleet identity after release cleanup");
                    deregistration_failed = true;
                    prune_fleet_inventory_entry(
                        &self.fleet_control_tx,
                        &mut self.fleet_inventory,
                        &name,
                    )
                    .await;
                }
            }
        }
        if let Some(pending) = self.pending_verified_spawns.remove(&name) {
            self.send_fleet_action_result(verified_spawn_failed_result(
                pending.invocation_id,
                "spawn_released_before_ready",
            ))
            .await;
        }
        self.publish_fleet_load(true).await;
        match outcome {
            super::relaycast_events::ReleaseOutcome::Released if deregistration_failed => {
                self.reply_action_error(&invoke.invocation_id, "release_deregistration_failed")
                    .await;
            }
            super::relaycast_events::ReleaseOutcome::Released => {
                self.reply_action_output(
                    &invoke.invocation_id,
                    json!({ "released": true, "name": name.as_str() }),
                )
                .await;
            }
            super::relaycast_events::ReleaseOutcome::Failed => {
                self.reply_action_error(&invoke.invocation_id, "release_failed")
                    .await;
            }
        }
    }

    async fn reply_action_output(&self, invocation_id: &str, output: Value) {
        self.send_fleet_action_result(ActionResult {
            v: FLEET_WIRE_VERSION,
            id: None,
            invocation_id: invocation_id.to_string(),
            result: ActionResultPayload::Output(ActionResultOutput { output }),
        })
        .await;
    }

    async fn reply_action_error(&self, invocation_id: &str, error: &str) {
        self.send_fleet_action_result(ActionResult {
            v: FLEET_WIRE_VERSION,
            id: None,
            invocation_id: invocation_id.to_string(),
            result: ActionResultPayload::Error(ActionResultError {
                error: error.to_string(),
            }),
        })
        .await;
    }

    async fn send_fleet_action_result(&self, result: ActionResult) {
        let _ = self
            .fleet_control_tx
            .send(FleetControlCommand::Send(BrokerToRelaycast::ActionResult(
                result,
            )))
            .await;
    }

    async fn publish_fleet_load(&self, heartbeat_now: bool) {
        let active_agents = u32::try_from(self.workers.workers.len()).unwrap_or(u32::MAX);
        // The broker provider's capacity handlers (spawn/release) are live for as
        // long as its connection is up, so `handlers_live` is unconditionally true
        // here — a connected broker can always place work.
        publish_fleet_load_snapshot(
            &self.fleet_control_tx,
            active_agents,
            self.fleet_max_agents,
            true,
            heartbeat_now,
        )
        .await;
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct FlushPendingRelayResult {
    pub(super) flushed: usize,
    pub(super) failure: Option<String>,
}

/// Inject a worker's held queue in FIFO order. A failed item and every item
/// behind it remain queued. Relaycast ACKs advance only after the corresponding
/// PTY write succeeds, so the emitted cursor is always an injected prefix.
pub(super) async fn flush_pending_relay_messages(
    delivery_states: &mut HashMap<WorkerName, InboundDeliveryState>,
    workers: &mut WorkerRegistry,
    fleet_delivery_book: &mut FleetDeliveryBook,
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    worker_name: &WorkerName,
    retry_interval: Duration,
) -> FlushPendingRelayResult {
    let mut result = FlushPendingRelayResult::default();

    loop {
        let next = delivery_states
            .get(worker_name)
            .and_then(|state| state.pending.front())
            .cloned();
        let Some(queued) = next else {
            break;
        };

        if let Some(receipt) = queued.relaycast_receipt.as_ref() {
            if !fleet_delivery_book.can_ack_receipt(receipt) {
                result.failure = Some(format!(
                    "delivery sequence {} for '{}' is not the next ACKable receipt",
                    receipt.seq, receipt.agent
                ));
                break;
            }
        }

        if let Err(error) =
            try_inject_pending_relay_message_once(workers, worker_name, &queued, retry_interval)
                .await
        {
            result.failure = Some(error.to_string());
            break;
        }

        if let Some(receipt) = queued.relaycast_receipt.as_ref() {
            let Some(up_to_seq) = fleet_delivery_book.commit_acked_receipt(receipt) else {
                result.failure = Some(format!(
                    "delivery sequence {} for '{}' could not advance the ACK cursor",
                    receipt.seq, receipt.agent
                ));
                break;
            };
            if let Err(error) = fleet_control_tx
                .send(FleetControlCommand::Send(delivery_ack(
                    receipt.agent.to_string(),
                    up_to_seq,
                )))
                .await
            {
                tracing::warn!(
                    target = "relay_broker::fleet",
                    agent = %receipt.agent,
                    up_to_seq,
                    error = %error,
                    "failed to enqueue delivery ACK after manual flush"
                );
            }
        }

        let removed = delivery_states
            .get_mut(worker_name)
            .and_then(|state| state.pending.pop_front());
        debug_assert_eq!(removed.as_ref(), Some(&queued));
        result.flushed += 1;
    }

    result
}

/// Bind an agent to this node by sending node-control `agent.register` and
/// awaiting the engine reply with the minted agent token. This is the single
/// "register agent via node" step both the `/api/spawn` path and the node
/// `action.invoke` spawn converge on, so every spawned agent is born
/// `via_node`-bound to the broker. The returned token is injected into the
/// worker as `RELAY_AGENT_TOKEN` (which also sets `RELAY_SKIP_BOOTSTRAP`), so
/// the worker MCP never re-registers over HTTP.
pub(super) async fn register_node_agent_token(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_delivery_book: &mut FleetDeliveryBook,
    name: &str,
    invocation_id: Option<String>,
    session_ref: Option<String>,
) -> Result<crate::node_control::AgentRegistrationToken, String> {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    fleet_control_tx
        .send(FleetControlCommand::RegisterAgent {
            request: AgentRegister {
                v: FLEET_WIRE_VERSION,
                id: None,
                name: name.to_string(),
                invocation_id,
                session_ref: session_ref.clone(),
                resumable: session_ref.as_ref().map(|_| true),
            },
            reply: reply_tx,
        })
        .await
        .map_err(|_| "fleet_control_unavailable".to_string())?;
    let token = tokio::time::timeout(FLEET_AGENT_REGISTER_TIMEOUT, reply_rx)
        .await
        .map_err(|_| "agent_register_timeout".to_string())?
        .map_err(|_| "agent_register_reply_dropped".to_string())??;
    fleet_delivery_book.bind_authoritative_identity(token.name.clone(), token.agent_id.clone());
    if let Some(up_to_seq) = token.delivery_ack_seq {
        fleet_delivery_book.seed_cursor(token.name.clone(), token.agent_id.clone(), up_to_seq);
    }
    Ok(token)
}

pub(super) async fn publish_fleet_load_snapshot(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    active_agents: u32,
    max_agents: u32,
    handlers_live: bool,
    heartbeat_now: bool,
) {
    if let Err(error) =
        fleet_control_tx.try_send(FleetControlCommand::UpdateLoad(FleetLoadSnapshot {
            active_agents,
            max_agents,
            handlers_live,
        }))
    {
        tracing::warn!(error = %error, "fleet load update queue is unavailable; periodic heartbeat will retry");
    }
    if heartbeat_now {
        if let Err(error) = fleet_control_tx.try_send(FleetControlCommand::HeartbeatNow) {
            tracing::warn!(error = %error, "fleet heartbeat queue is unavailable; periodic heartbeat will retry");
        }
    }
}

/// Queue an `agent.deregister` frame before a released name can be reused.
///
/// HTTP release and a subsequent same-name spawn are separate broker API
/// requests, but both converge on this single FIFO fleet-control channel. A
/// successful synchronous enqueue here precedes the release reply, so the
/// control plane observes deregistration before any later `agent.register`,
/// including when a restarted broker has a new node id. Backpressure fails the
/// release promptly and retains the authoritative identity for retry instead
/// of blocking the broker's single runtime API actor. Agents registered only
/// through the legacy HTTP fallback have no authoritative fleet identity and
/// remain covered by the REST offline call.
pub(super) async fn deregister_fleet_agent(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_delivery_book: &FleetDeliveryBook,
    name: &WorkerName,
) -> Result<bool, String> {
    let Some(agent_id) = fleet_delivery_book.active_agent_id(name.as_str()) else {
        return Ok(false);
    };
    fleet_control_tx
        .try_send(FleetControlCommand::Send(
            BrokerToRelaycast::AgentDeregister(AgentDeregister {
                v: FLEET_WIRE_VERSION,
                id: None,
                agent_id: agent_id.to_string(),
                name: Some(name.as_str().to_string()),
            }),
        ))
        .map_err(|error| match error {
            tokio::sync::mpsc::error::TrySendError::Full(_) => {
                "fleet_control_backpressure".to_string()
            }
            tokio::sync::mpsc::error::TrySendError::Closed(_) => {
                "fleet_control_unavailable".to_string()
            }
        })?;
    Ok(true)
}

pub(super) async fn publish_fleet_inventory_snapshot(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &HashMap<WorkerName, InventoryAgent>,
) {
    if let Err(error) = fleet_control_tx.try_send(FleetControlCommand::UpdateInventory(
        fleet_inventory.values().cloned().collect(),
    )) {
        tracing::warn!(error = %error, "fleet inventory queue is unavailable; periodic heartbeat will retry");
    }
}

pub(super) async fn refresh_fleet_inventory_session_ref(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &mut HashMap<WorkerName, InventoryAgent>,
    name: &WorkerName,
    session_ref: &str,
) -> bool {
    let session_ref = session_ref.trim();
    if session_ref.is_empty() {
        return false;
    }
    let Some(agent) = fleet_inventory.get_mut(name) else {
        return false;
    };
    if agent.session_ref.as_deref() == Some(session_ref) {
        return false;
    }

    agent.session_ref = Some(session_ref.to_string());
    publish_fleet_inventory_snapshot(fleet_control_tx, fleet_inventory).await;
    true
}

pub(super) async fn prune_fleet_inventory_entry(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &mut HashMap<WorkerName, InventoryAgent>,
    name: &WorkerName,
) {
    if fleet_inventory.remove(name).is_some() {
        publish_fleet_inventory_snapshot(fleet_control_tx, fleet_inventory).await;
    }
}

pub(super) async fn prune_fleet_agent_state(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &mut HashMap<WorkerName, InventoryAgent>,
    fleet_delivery_book: &mut FleetDeliveryBook,
    name: &WorkerName,
) {
    fleet_delivery_book.remove_agent(name.as_str());
    prune_fleet_inventory_entry(fleet_control_tx, fleet_inventory, name).await;
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// How a node `deliver` frame should be surfaced, decided by its payload `type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FleetDeliverySurfacing {
    /// Directive message class — inject into the recipient worker's PTY.
    Inject,
    /// Ambient receipt/reaction — ack + log only (PTY surfacing deferred).
    AckOnly,
    /// Unrecognized class — ack (so it is not redelivered forever) without
    /// injecting, and warn so new event types are visible.
    AckUnknown,
}

/// Classify a node `deliver` payload `type` into a surfacing decision. The empty
/// type covers legacy/plain payloads that carry the message body directly
/// (text/body/content), preserving pre-node delivery behavior.
///
/// The message-class arm mirrors relaycast's `parse_inbound_kind` alias set
/// (events.rs): the engine may emit any of these alias `type` values for a
/// message-class event, and acking-without-injecting any of them would
/// permanently drop the message (at-least-once never redelivers an acked
/// delivery). `AckUnknown` is reserved for genuinely non-message control types.
///
/// Action-result types are part of the engine's `seq:0` fan-out family
/// (`relaycast` engine `invocationCompletion.ts` emits `action.completed` /
/// `action.failed` to the caller; `routes/action.ts` emits `action.denied`).
/// They are injected so the agent that invoked the action receives the result.
///
/// PTY surfacing of `message.reacted` / `message.read` (and presence) is
/// intentionally deferred in this node-only-delivery migration: those frames are
/// acked (so the engine does not redeliver) but not injected. They remain
/// `AckOnly` until a dedicated reaction/receipt surfacing path is built.
fn classify_fleet_delivery(payload_type: &str) -> FleetDeliverySurfacing {
    match payload_type {
        // seq:0 fan-out action results delivered to the caller agent — inject.
        "action.completed" | "action.failed" | "action.denied" => FleetDeliverySurfacing::Inject,
        // seq:0 fan-out reactions/read receipts — ack-only (PTY surfacing deferred).
        "message.reacted" | "message.read" => FleetDeliverySurfacing::AckOnly,
        // message-class aliases — mirror relaycast parse_inbound_kind.
        "message.created"
        | "message.received"
        | "message.new"
        | "message.sent"
        | "message.delivered"
        | "thread.reply"
        | "thread.message.created"
        | "thread.message.sent"
        | "dm.received"
        | "dm.created"
        | "dm.new"
        | "dm.sent"
        | "dm.message.created"
        | "direct_message.received"
        | "direct_message.created"
        | "direct_message.new"
        | "direct_message.sent"
        | "group_dm.received"
        | "group_dm.created"
        | "group_dm.new"
        | "group_dm.sent"
        | "group_dm.message.created"
        | "" => FleetDeliverySurfacing::Inject,
        _ => FleetDeliverySurfacing::AckUnknown,
    }
}

/// Whether a node `deliver` payload `type` represents an actual chat message
/// arriving (channel post, DM, thread reply) as opposed to an action-result
/// fan-out (`action.completed` / `action.failed` / `action.denied`) or an
/// ambient reaction/receipt. Both message-class and action-result types are
/// `FleetDeliverySurfacing::Inject` (both get PTY'd to a worker), but only
/// message-class types are "someone sent a message" for dashboard purposes —
/// mirrors the message-class alias arm of `classify_fleet_delivery` exactly
/// (kept as a separate list rather than folding into that function's return
/// type, since callers of `classify_fleet_delivery` outside the dashboard
/// concern don't need this distinction).
fn is_chat_message_delivery(payload_type: &str) -> bool {
    matches!(
        payload_type,
        "message.created"
            | "message.received"
            | "message.new"
            | "message.sent"
            | "message.delivered"
            | "thread.reply"
            | "thread.message.created"
            | "thread.message.sent"
            | "dm.received"
            | "dm.created"
            | "dm.new"
            | "dm.sent"
            | "dm.message.created"
            | "direct_message.received"
            | "direct_message.created"
            | "direct_message.new"
            | "direct_message.sent"
            | "group_dm.received"
            | "group_dm.created"
            | "group_dm.new"
            | "group_dm.sent"
            | "group_dm.message.created"
            | ""
    )
}

/// Build the `relay_inbound` dashboard event for a node `deliver` frame that
/// is about to be `Inject`-surfaced, or `None` when it shouldn't be surfaced
/// to the dashboard at all.
///
/// Returns `None` when either:
/// - `payload_type` isn't a genuine chat-message class (e.g. it's an
///   `action.completed`/`action.failed`/`action.denied` result, which is
///   `Inject`-classified for PTY purposes but isn't "someone sent a
///   message"), or
/// - the delivered message's sender is this broker's own dashboard/self
///   identity (`sender_is_dashboard_label`) — that message was already
///   surfaced to the dashboard synchronously at HTTP send time
///   (`ListenApiRequest::Send` in runtime/api.rs) under a different
///   (`http_*`) event id, so re-emitting it here under `deliver.msg_id`
///   would show up as a second, undeduped bubble.
///
/// When `Some`, the event's `event_id` is always `deliver.msg_id` — the
/// same value the node control plane fans out across every local
/// recipient's own `Deliver` frame for one underlying message (mirrors
/// `fleet_relay_delivery`'s PTY-path `EventId`), so the renderer's
/// exact-id dedup collapses the multiple dashboard events this function
/// will produce (one per local recipient) down to one visible message.
fn fleet_dashboard_relay_inbound_event(
    payload_type: &str,
    deliver: &Deliver,
    fields: &FleetDeliveryFields,
    self_name: &str,
    workspace_id: Option<&str>,
    workspace_alias: Option<&str>,
) -> Option<Value> {
    if !is_chat_message_delivery(payload_type) {
        return None;
    }
    if sender_is_dashboard_label(&fields.from, self_name) {
        return None;
    }
    Some(json!({
        "kind": "relay_inbound",
        "event_id": deliver.msg_id.as_str(),
        "from": fields.from.as_str(),
        "target": fields.target.as_str(),
        "body": fields.body.as_str(),
        "thread_id": fields.thread_id.as_ref().map(ThreadId::as_str),
        "workspace_id": workspace_id,
        "workspace_alias": workspace_alias,
    }))
}

/// Resolve the worker name a node `action.invoke` targets: prefer the frame's
/// `agent_name`, then the input's `name`/`agent`/`agent_name`/`agent_id`
/// fields. Returns `None` when no non-empty identity is present.
fn action_invoke_agent_name(invoke: &ActionInvoke) -> Option<WorkerName> {
    invoke
        .agent_name
        .as_deref()
        .and_then(non_empty)
        .map(WorkerName::from)
        .or_else(|| {
            action_invoke_string(&invoke.input, &["name", "agent_name", "agent"])
                .map(WorkerName::from)
        })
        .or_else(|| {
            invoke
                .agent_id
                .as_deref()
                .and_then(non_empty)
                .map(WorkerName::from)
        })
}

/// Read the first non-empty string at any of the given top-level keys of an
/// `action.invoke` input object (also checks under a nested `agent` object,
/// mirroring the firehose payload shape).
fn action_invoke_string(input: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = input.get(key).and_then(Value::as_str).and_then(non_empty) {
            return Some(value.to_string());
        }
    }
    let agent = input.get("agent")?;
    for key in keys {
        if let Some(value) = agent.get(key).and_then(Value::as_str).and_then(non_empty) {
            return Some(value.to_string());
        }
    }
    None
}

/// Read the first boolean at any of the given top-level keys of an
/// `action.invoke` input object (also checks under a nested `agent` object),
/// mirroring [`action_invoke_string`]'s lookup order for the flattened-vs-nested
/// spawn payload shape.
fn action_invoke_bool(input: &Value, keys: &[&str]) -> Option<bool> {
    for key in keys {
        if let Some(value) = input.get(key).and_then(Value::as_bool) {
            return Some(value);
        }
    }
    let agent = input.get("agent")?;
    for key in keys {
        if let Some(value) = agent.get(key).and_then(Value::as_bool) {
            return Some(value);
        }
    }
    None
}

/// Message fields extracted from a node `deliver` payload, ready to build a
/// [`RelayDelivery`].
struct FleetDeliveryFields {
    body: String,
    from: String,
    target: String,
    thread_id: Option<ThreadId>,
    priority: Option<u8>,
}

/// Extract message body/sender/target/thread/priority from a node `deliver`
/// payload.
///
/// The relaycast v5 node `deliver` frame nests the message under
/// `payload.data` with `type` at `payload.type` (see relaycast
/// `normalize_node_deliver`): the text lives at `data.text`, the sender at
/// `data.agent_name` (falling back to `data.from_name`), the channel at
/// `data.channel_name`, and the thread at `data.thread_id`. We read those
/// `data.*` paths first, then fall back to the legacy flat/`message.*` paths so
/// older or test payloads still map. `fallback_target` (the recipient agent
/// name) is used only when no channel/target is present, i.e. for direct
/// messages.
fn fleet_delivery_fields(payload: &Value, fallback_target: &str) -> FleetDeliveryFields {
    let body = first_string(
        payload,
        &[
            "/data/text",
            "/text",
            "/body",
            "/content",
            "/message/text",
            "/payload/text",
            // Action-result fan-out (action.completed/failed/denied) carries the
            // result under data.output / data.error rather than a text field.
            "/data/output",
            "/data/error",
        ],
    )
    .unwrap_or_else(|| payload.to_string());
    let from = first_string(
        payload,
        &[
            "/data/agent_name",
            "/data/from_name",
            "/from",
            "/sender",
            "/author",
            "/message/agent_name",
            "/message/from",
            "/payload/from",
        ],
    )
    .unwrap_or_else(|| "relaycast".to_string());
    let target = first_string(
        payload,
        &["/target", "/to", "/recipient", "/message/target"],
    )
    .or_else(|| {
        first_string(
            payload,
            &["/data/channel_name", "/channel", "/message/channel"],
        )
        .map(|channel| {
            if channel.starts_with('#') {
                channel
            } else {
                format!("#{channel}")
            }
        })
    })
    .unwrap_or_else(|| fallback_target.to_string());
    let thread_id = first_string(
        payload,
        &[
            "/data/thread_id",
            "/thread_id",
            "/threadId",
            "/data/parent_id",
        ],
    )
    .map(ThreadId::new);
    let priority = first_u64(payload, &["/data/priority", "/priority"])
        .and_then(|value| u8::try_from(value).ok())
        .or_else(|| {
            first_string(payload, &["/data/metadata/priority", "/metadata/priority"])
                .and_then(|label| priority_from_label(&label))
        });
    FleetDeliveryFields {
        body,
        from,
        target,
        thread_id,
        priority,
    }
}

fn priority_from_label(label: &str) -> Option<u8> {
    match label.trim().to_ascii_lowercase().as_str() {
        "low" => Some(1),
        "normal" => Some(2),
        "high" => Some(3),
        "urgent" => Some(4),
        _ => None,
    }
}

pub(super) fn fleet_initial_session_ref(spec: &AgentSpec) -> Option<String> {
    spec.session_id.clone().or_else(|| {
        spec.harness_config
            .as_ref()
            .and_then(ResolvedHarnessConfig::session_id)
            .map(ToOwned::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::PtyHarnessConfig;

    fn test_agent_spec(session_id: Option<&str>, harness_session_id: Option<&str>) -> AgentSpec {
        AgentSpec {
            name: WorkerName::from("agent-a"),
            runtime: AgentRuntime::Pty,
            provider: None,
            cli: Some("codex".to_string()),
            session_id: session_id.map(ToOwned::to_owned),
            harness_config: harness_session_id.map(|session_id| {
                ResolvedHarnessConfig::Pty(PtyHarnessConfig {
                    command: "codex".to_string(),
                    args: Vec::new(),
                    cwd: None,
                    env: None,
                    session_id: Some(session_id.to_string()),
                    delivery: None,
                    metadata: None,
                })
            }),
            model: None,
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            args: Vec::new(),
            channels: Vec::new(),
            restart_policy: None,
        }
    }

    #[test]
    fn identity_reject_plan_neither_surfaces_nor_acks() {
        assert_eq!(
            plan_fleet_delivery(DeliveryDecision::IdentityReject),
            FleetDeliveryPlan::RejectWithoutAck
        );
    }

    #[test]
    fn terminal_close_reserve_survives_output_backpressure() {
        let (tx, mut rx) = mpsc::channel(TERMINAL_CLOSE_RESERVE + 1);
        assert!(try_send_terminal(
            &tx,
            TerminalToCloud::Output {
                session_id: "session-a".into(),
                chunk: "x".into(),
                offset: None,
            },
        ));
        assert!(
            !try_send_terminal(
                &tx,
                TerminalToCloud::Output {
                    session_id: "session-a".into(),
                    chunk: "y".into(),
                    offset: None,
                },
            ),
            "non-final terminal traffic must preserve close capacity"
        );
        assert!(try_send_terminal(
            &tx,
            TerminalToCloud::Closed {
                session_id: "session-a".into(),
                code: Some("output_backpressure".into()),
                message: Some("queue full".into()),
            },
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(TerminalControlCommand::Send(TerminalToCloud::Output { .. }))
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(TerminalControlCommand::Send(TerminalToCloud::Closed { .. }))
        ));
    }

    #[test]
    fn classify_fleet_delivery_injects_message_classes_and_acks_receipts() {
        // Mirrors relaycast parse_inbound_kind message-class alias set: any of
        // these must inject, not ack-and-drop.
        for inject in [
            "message.created",
            "message.received",
            "message.new",
            "message.sent",
            "message.delivered",
            "thread.reply",
            "thread.message.created",
            "thread.message.sent",
            "dm.received",
            "dm.created",
            "dm.new",
            "dm.sent",
            "dm.message.created",
            "direct_message.received",
            "direct_message.created",
            "direct_message.new",
            "direct_message.sent",
            "group_dm.received",
            "group_dm.created",
            "group_dm.new",
            "group_dm.sent",
            "group_dm.message.created",
            // seq:0 action-result fan-out delivered to the caller agent.
            "action.completed",
            "action.failed",
            "action.denied",
            "",
        ] {
            assert_eq!(
                classify_fleet_delivery(inject),
                FleetDeliverySurfacing::Inject,
                "{inject} should inject"
            );
        }
        for ack_only in ["message.reacted", "message.read"] {
            assert_eq!(
                classify_fleet_delivery(ack_only),
                FleetDeliverySurfacing::AckOnly,
                "{ack_only} should ack-only"
            );
        }
        assert_eq!(
            classify_fleet_delivery("something.new"),
            FleetDeliverySurfacing::AckUnknown
        );
    }

    #[test]
    fn fleet_delivery_fields_reads_node_data_envelope() {
        // The real relaycast v5 node `deliver` payload: { type, data: { ... } }.
        let payload = json!({
            "type": "message.created",
            "data": {
                "id": "msg-1",
                "agent_name": "alice",
                "from_name": "ignored-when-agent-name-present",
                "channel_name": "general",
                "text": "hello world",
                "thread_id": "thr-9",
            }
        });
        let fields = fleet_delivery_fields(&payload, "recipient-agent");
        assert_eq!(fields.body, "hello world");
        assert_eq!(fields.from, "alice");
        assert_eq!(fields.target, "#general");
        assert_eq!(
            fields.thread_id.as_ref().map(ThreadId::as_str),
            Some("thr-9")
        );
    }

    #[test]
    fn fleet_delivery_fields_falls_back_to_from_name_and_dm_target() {
        // DM-shaped data: no channel_name, sender carried as from_name only.
        let payload = json!({
            "type": "dm.received",
            "data": {
                "from_name": "bob",
                "text": "ping",
            }
        });
        let fields = fleet_delivery_fields(&payload, "recipient-agent");
        assert_eq!(fields.body, "ping");
        assert_eq!(fields.from, "bob");
        // No channel -> direct message addressed to the recipient agent.
        assert_eq!(fields.target, "recipient-agent");
        assert!(fields.thread_id.is_none());
    }

    #[test]
    fn fleet_delivery_fields_supports_legacy_flat_payload() {
        // Legacy/plain payload that carries the body directly.
        let payload = json!({
            "text": "flat body",
            "from": "carol",
            "channel": "#ops",
        });
        let fields = fleet_delivery_fields(&payload, "recipient-agent");
        assert_eq!(fields.body, "flat body");
        assert_eq!(fields.from, "carol");
        assert_eq!(fields.target, "#ops");
    }

    fn action_invoke(
        input: Value,
        agent_name: Option<&str>,
        agent_id: Option<&str>,
    ) -> ActionInvoke {
        ActionInvoke {
            v: FLEET_WIRE_VERSION,
            invocation_id: "inv-1".to_string(),
            action: "spawn".to_string(),
            input,
            agent_id: agent_id.map(ToOwned::to_owned),
            agent_name: agent_name.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn action_invoke_agent_name_prefers_frame_then_input_then_agent_id() {
        assert_eq!(
            action_invoke_agent_name(&action_invoke(
                json!({"name": "from-input"}),
                Some("from-frame"),
                None
            )),
            Some(WorkerName::from("from-frame"))
        );
        assert_eq!(
            action_invoke_agent_name(&action_invoke(
                json!({"name": "from-input"}),
                None,
                Some("agt-1")
            )),
            Some(WorkerName::from("from-input"))
        );
        assert_eq!(
            action_invoke_agent_name(&action_invoke(json!({}), None, Some("agt-1"))),
            Some(WorkerName::from("agt-1"))
        );
        assert_eq!(
            action_invoke_agent_name(&action_invoke(
                json!({"agent": {"name": "nested"}}),
                None,
                None
            )),
            Some(WorkerName::from("nested"))
        );
        assert_eq!(
            action_invoke_agent_name(&action_invoke(json!({}), Some("  "), None)),
            None
        );
    }

    #[test]
    fn action_invoke_string_reads_top_level_and_nested_agent() {
        let input = json!({"cli": "codex", "agent": {"model": "gpt-5"}});
        assert_eq!(
            action_invoke_string(&input, &["cli"]).as_deref(),
            Some("codex")
        );
        assert_eq!(
            action_invoke_string(&input, &["model"]).as_deref(),
            Some("gpt-5")
        );
        assert_eq!(action_invoke_string(&input, &["missing"]), None);
        // blank values are skipped
        assert_eq!(
            action_invoke_string(
                &json!({"cli": "  ", "command": "claude"}),
                &["cli", "command"]
            )
            .as_deref(),
            Some("claude")
        );
    }

    #[test]
    fn action_invoke_bool_reads_top_level_and_nested_agent() {
        // Top-level (flattened) and nested-`agent` shapes both resolve, matching
        // the fleet TS layer that flattens `{...spawn.agent, task, ...}`.
        assert_eq!(
            action_invoke_bool(&json!({"exit_after_task": true}), &["exit_after_task"]),
            Some(true)
        );
        assert_eq!(
            action_invoke_bool(
                &json!({"agent": {"exitAfterTask": false}}),
                &["exit_after_task", "exitAfterTask"]
            ),
            Some(false)
        );
        // Absent on both levels yields None so the caller can default.
        assert_eq!(
            action_invoke_bool(&json!({"cli": "codex"}), &["exit_after_task"]),
            None
        );
    }

    #[test]
    fn action_invoke_spawn_input_resolves_task_exit_lifecycle() {
        // The engine-dispatched spawn reads spawn_mode/exit_after_task from the
        // invoke input exactly like the local HTTP spawn, from either the
        // flattened top level or the nested `agent` object.
        let top_level = json!({"cli": "codex", "spawn_mode": "task_exit"});
        assert!(resolve_exit_after_task(
            action_invoke_string(&top_level, &["spawn_mode", "spawnMode"]).as_deref(),
            action_invoke_bool(&top_level, &["exit_after_task", "exitAfterTask"]),
        )
        .expect("valid spawn_mode"));

        let nested = json!({"agent": {"cli": "codex", "spawnMode": "interactive"}});
        assert!(!resolve_exit_after_task(
            action_invoke_string(&nested, &["spawn_mode", "spawnMode"]).as_deref(),
            action_invoke_bool(&nested, &["exit_after_task", "exitAfterTask"]),
        )
        .expect("valid spawn_mode"));

        let explicit = json!({"cli": "codex", "exit_after_task": true});
        assert!(resolve_exit_after_task(
            action_invoke_string(&explicit, &["spawn_mode", "spawnMode"]).as_deref(),
            action_invoke_bool(&explicit, &["exit_after_task", "exitAfterTask"]),
        )
        .expect("valid explicit flag"));
    }

    #[test]
    fn action_invoke_spawn_control_key_allows_immediate_name_reuse() {
        let local_key = relaycast_spawn_control_dedup_key("ws_1", "worker-a");

        // Each node action is already correlated by its invocation id. Passing
        // the matching control key tells the legacy firehose echo guard not to
        // consume or reject the reusable worker name.
        for _ in 0..2 {
            assert!(!relaycast_ws_should_apply_local_spawn_echo_dedup(
                Some(local_key.as_str()),
                &local_key,
            ));
        }
    }

    #[test]
    fn fleet_initial_session_ref_prefers_explicit_spec_session() {
        let spec = test_agent_spec(Some("session-spec"), Some("session-harness"));
        assert_eq!(
            fleet_initial_session_ref(&spec).as_deref(),
            Some("session-spec")
        );

        let spec = test_agent_spec(None, Some("session-harness"));
        assert_eq!(
            fleet_initial_session_ref(&spec).as_deref(),
            Some("session-harness")
        );
    }

    #[tokio::test]
    async fn action_invoke_spawn_seeds_authoritative_cursor_before_resumed_delivery() {
        // The Fleet CLI sends `session_ref` at the top level. It must be
        // forwarded with the invocation id into the node `agent.register`, so
        // the spawn resumes the session and the invocation is correlated to
        // the agent.
        let ws_value = json!({
            "session_ref": "sess-resume-7",
            "agent": {
                "harnessConfig": {
                    "runtime": "pty",
                    "command": "codex",
                }
            }
        });
        let session_ref = super::super::relaycast_events::relaycast_spawn_session_ref(&ws_value);
        assert_eq!(
            session_ref.as_deref(),
            Some("sess-resume-7"),
            "session ref must be derived from the action input"
        );

        // Drive the exact registration step the spawn path uses and capture the
        // emitted AgentRegister to confirm both fields are threaded through.
        let (tx, mut rx) = mpsc::channel::<FleetControlCommand>(4);
        let register_handle = tokio::spawn(async move {
            let mut delivery_book = FleetDeliveryBook::default();
            let token = register_node_agent_token(
                &tx,
                &mut delivery_book,
                "agent-a",
                Some("inv-42".to_string()),
                session_ref,
            )
            .await?;
            Ok::<_, String>((token, delivery_book))
        });

        let command = rx.recv().await.expect("register command emitted");
        let FleetControlCommand::RegisterAgent { request, reply } = command else {
            panic!("expected RegisterAgent command");
        };
        assert_eq!(request.invocation_id.as_deref(), Some("inv-42"));
        assert_eq!(request.session_ref.as_deref(), Some("sess-resume-7"));
        // A session ref implies the spawn is resumable.
        assert_eq!(request.resumable, Some(true));

        // Satisfy the awaiting caller so the task completes cleanly.
        reply
            .send(Ok(crate::node_control::AgentRegistrationToken {
                name: "agent-a".to_string(),
                agent_id: "agent-a-id".to_string(),
                token: "at_test".to_string(),
                delivery_ack_seq: Some(42),
            }))
            .unwrap();
        let (token, delivery_book) = register_handle.await.unwrap().unwrap();
        assert_eq!(token.token, "at_test");

        let resumed = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-43".to_string(),
            msg_id: "msg-43".to_string(),
            seq: 43,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "after restart"}),
        };
        assert_eq!(
            delivery_book.observe(&resumed),
            crate::node_control::DeliveryDecision::Deliver { up_to_seq: 43 }
        );
    }

    #[tokio::test]
    async fn agent_register_without_cursor_still_binds_authoritative_identity() {
        let (tx, mut rx) = mpsc::channel::<FleetControlCommand>(4);
        let register_handle = tokio::spawn(async move {
            let mut delivery_book = FleetDeliveryBook::default();
            register_node_agent_token(&tx, &mut delivery_book, "agent-a", None, None).await?;
            Ok::<_, String>(delivery_book)
        });

        let FleetControlCommand::RegisterAgent { reply, .. } =
            rx.recv().await.expect("register command emitted")
        else {
            panic!("expected RegisterAgent command");
        };
        reply
            .send(Ok(crate::node_control::AgentRegistrationToken {
                name: "agent-a".to_string(),
                agent_id: "agent-a-id".to_string(),
                token: "at_test".to_string(),
                delivery_ack_seq: None,
            }))
            .unwrap();
        let delivery_book = register_handle.await.unwrap().unwrap();

        let current = test_deliver(
            "agent-a",
            "delivery-current",
            "message-current",
            json!({"type": "message.created"}),
        );
        assert_eq!(
            delivery_book.observe(&current),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
        let mismatch = Deliver {
            agent_id: "impostor-id".to_string(),
            ..current
        };
        assert_eq!(
            delivery_book.observe(&mismatch),
            DeliveryDecision::IdentityReject
        );
    }

    #[tokio::test]
    async fn release_queues_fleet_deregister_with_authoritative_identity() {
        let (tx, mut rx) = mpsc::channel::<FleetControlCommand>(1);
        let mut delivery_book = FleetDeliveryBook::default();
        delivery_book.bind_authoritative_identity("agent-a", "agent-a-id");

        assert!(
            deregister_fleet_agent(&tx, &delivery_book, &WorkerName::from("agent-a"))
                .await
                .expect("deregister should enqueue")
        );

        let command = rx.recv().await.expect("deregister command emitted");
        let FleetControlCommand::Send(BrokerToRelaycast::AgentDeregister(request)) = command else {
            panic!("expected AgentDeregister command");
        };
        assert_eq!(request.agent_id, "agent-a-id");
        assert_eq!(request.name.as_deref(), Some("agent-a"));
    }

    #[tokio::test]
    async fn release_without_fleet_identity_does_not_emit_deregister() {
        let (tx, mut rx) = mpsc::channel::<FleetControlCommand>(1);
        let delivery_book = FleetDeliveryBook::default();

        assert!(
            !deregister_fleet_agent(&tx, &delivery_book, &WorkerName::from("http-only"))
                .await
                .expect("missing identity should be a no-op")
        );
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn release_does_not_deregister_nonauthoritative_http_identity() {
        let (tx, mut rx) = mpsc::channel::<FleetControlCommand>(1);
        let mut delivery_book = FleetDeliveryBook::default();
        let delivery = test_deliver(
            "http-only",
            "delivery-http-only",
            "message-http-only",
            json!({"text": "legacy delivery"}),
        );
        delivery_book.commit_received(&delivery);

        assert!(
            !deregister_fleet_agent(&tx, &delivery_book, &WorkerName::from("http-only"))
                .await
                .expect("non-authoritative identity should be a no-op")
        );
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn failed_release_deregister_retains_identity_for_retry() {
        let (tx, rx) = mpsc::channel::<FleetControlCommand>(1);
        drop(rx);
        let mut delivery_book = FleetDeliveryBook::default();
        delivery_book.bind_authoritative_identity("agent-a", "agent-a-id");

        assert_eq!(
            deregister_fleet_agent(&tx, &delivery_book, &WorkerName::from("agent-a")).await,
            Err("fleet_control_unavailable".to_string())
        );
        assert_eq!(delivery_book.active_agent_id("agent-a"), Some("agent-a-id"));
    }

    #[tokio::test]
    async fn release_deregister_fails_fast_when_fleet_control_is_backpressured() {
        let (tx, _rx) = mpsc::channel::<FleetControlCommand>(1);
        tx.try_send(FleetControlCommand::HeartbeatNow)
            .expect("fill fleet control queue");
        let mut delivery_book = FleetDeliveryBook::default();
        delivery_book.bind_authoritative_identity("agent-a", "agent-a-id");

        let result = tokio::time::timeout(
            Duration::from_millis(50),
            deregister_fleet_agent(&tx, &delivery_book, &WorkerName::from("agent-a")),
        )
        .await
        .expect("backpressured deregister must not stall the runtime API actor");

        assert_eq!(result, Err("fleet_control_backpressure".to_string()));
        assert_eq!(delivery_book.active_agent_id("agent-a"), Some("agent-a-id"));
    }

    #[tokio::test]
    async fn load_publication_does_not_wait_for_fleet_control_capacity() {
        let (tx, _rx) = mpsc::channel::<FleetControlCommand>(1);
        tx.try_send(FleetControlCommand::HeartbeatNow)
            .expect("fill fleet control queue");

        tokio::time::timeout(
            Duration::from_millis(50),
            publish_fleet_load_snapshot(&tx, 1, 4, true, true),
        )
        .await
        .expect("load publication must not stall the runtime API actor");
    }

    #[test]
    fn relaycast_spawn_session_ref_is_none_without_harness_session() {
        // A spawn with no harnessConfig session id yields None — the spawn is a
        // fresh (non-resume) spawn, matching the pre-fix behavior for that case.
        let ws_value = json!({
            "agent": { "harnessConfig": { "runtime": "pty", "command": "codex" } }
        });
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_session_ref(&ws_value),
            None
        );
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_session_ref(&json!({})),
            None
        );
    }

    #[test]
    fn relaycast_spawn_session_ref_supports_action_and_harness_shapes() {
        let explicit = json!({
            "session_ref": " session-explicit ",
            "agent": {
                "harnessConfig": {
                    "runtime": "pty",
                    "command": "codex",
                    "sessionId": "session-harness",
                }
            }
        });
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_session_ref(&explicit).as_deref(),
            Some("session-explicit"),
            "the Fleet action field must take precedence over its compatibility fallback"
        );

        let nested_camel = json!({"agent": {"sessionRef": "session-nested"}});
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_session_ref(&nested_camel).as_deref(),
            Some("session-nested")
        );

        let harness_only = json!({
            "agent": {
                "harnessConfig": {
                    "runtime": "pty",
                    "command": "codex",
                    "sessionId": "session-harness",
                }
            }
        });
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_session_ref(&harness_only).as_deref(),
            Some("session-harness")
        );
    }

    #[test]
    fn relaycast_spawn_spec_session_id_prefers_requested_resume() {
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_spec_session_id(
                "codex",
                Some(" requested-session "),
                Some("harness-session"),
            )
            .as_deref(),
            Some("requested-session")
        );
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_spec_session_id(
                "claude",
                None,
                Some(" harness-session "),
            )
            .as_deref(),
            Some("harness-session")
        );
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_spec_session_id(
                "codex",
                Some("  "),
                None,
            ),
            None
        );
        assert_eq!(
            super::super::relaycast_events::relaycast_spawn_spec_session_id(
                "pool",
                Some("metadata-only-session"),
                None,
            ),
            None,
            "custom capacity harnesses retain session_ref metadata without receiving Codex/Claude argv"
        );
    }
    #[tokio::test]
    async fn prune_fleet_inventory_entry_publishes_without_removed_agent() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut inventory = HashMap::from([
            (
                WorkerName::from("agent-a"),
                InventoryAgent {
                    agent_id: "agt-a".to_string(),
                    name: "agent-a".to_string(),
                    invocation_id: Some("inv-a".to_string()),
                    session_ref: Some("session-a".to_string()),
                },
            ),
            (
                WorkerName::from("agent-b"),
                InventoryAgent {
                    agent_id: "agt-b".to_string(),
                    name: "agent-b".to_string(),
                    invocation_id: Some("inv-b".to_string()),
                    session_ref: Some("session-b".to_string()),
                },
            ),
        ]);

        prune_fleet_inventory_entry(&tx, &mut inventory, &WorkerName::from("agent-a")).await;

        match rx.recv().await {
            Some(FleetControlCommand::UpdateInventory(agents)) => {
                assert_eq!(agents.len(), 1);
                assert_eq!(agents[0].name, "agent-b");
            }
            other => panic!("expected inventory update, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refresh_fleet_inventory_session_ref_publishes_immediate_sync() {
        let (tx, mut rx) = mpsc::channel(4);
        let name = WorkerName::from("agent-a");
        let mut inventory = HashMap::from([(
            name.clone(),
            InventoryAgent {
                agent_id: "agt-a".to_string(),
                name: "agent-a".to_string(),
                invocation_id: Some("inv-a".to_string()),
                session_ref: None,
            },
        )]);

        assert!(
            refresh_fleet_inventory_session_ref(&tx, &mut inventory, &name, " session-discovered ")
                .await
        );

        match rx.recv().await {
            Some(FleetControlCommand::UpdateInventory(agents)) => {
                assert_eq!(agents.len(), 1);
                assert_eq!(agents[0].name, "agent-a");
                assert_eq!(agents[0].session_ref.as_deref(), Some("session-discovered"));
            }
            other => panic!("expected inventory update, got {other:?}"),
        }
        assert_eq!(
            inventory
                .get(&name)
                .and_then(|agent| agent.session_ref.as_deref()),
            Some("session-discovered")
        );
        assert!(
            !refresh_fleet_inventory_session_ref(&tx, &mut inventory, &name, "session-discovered")
                .await
        );
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn publish_fleet_load_snapshot_emits_immediate_heartbeat_after_release() {
        let (tx, mut rx) = mpsc::channel(4);

        publish_fleet_load_snapshot(&tx, 1, 4, true, true).await;

        match rx.recv().await {
            Some(FleetControlCommand::UpdateLoad(load)) => {
                assert_eq!(load.active_agents, 1);
                assert_eq!(load.max_agents, 4);
                assert!(load.handlers_live);
            }
            other => panic!("expected load update, got {other:?}"),
        }
        assert!(matches!(
            rx.recv().await,
            Some(FleetControlCommand::HeartbeatNow)
        ));
        assert!(rx.try_recv().is_err());
    }
    fn test_deliver(agent: &str, delivery_id: &str, msg_id: &str, payload: Value) -> Deliver {
        Deliver {
            v: FLEET_WIRE_VERSION,
            agent: agent.to_string(),
            agent_id: format!("{agent}-id"),
            delivery_id: delivery_id.to_string(),
            msg_id: msg_id.to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload,
        }
    }

    #[test]
    fn is_chat_message_delivery_covers_message_classes_but_not_action_results() {
        for message_class in [
            "message.created",
            "message.received",
            "message.new",
            "message.sent",
            "message.delivered",
            "thread.reply",
            "thread.message.created",
            "thread.message.sent",
            "dm.received",
            "dm.created",
            "dm.new",
            "dm.sent",
            "dm.message.created",
            "direct_message.received",
            "direct_message.created",
            "direct_message.new",
            "direct_message.sent",
            "group_dm.received",
            "group_dm.created",
            "group_dm.new",
            "group_dm.sent",
            "group_dm.message.created",
            "",
        ] {
            assert!(
                is_chat_message_delivery(message_class),
                "{message_class} should be a chat-message class"
            );
        }
        // action-result fan-out is Inject-classified (PTY'd back to the
        // caller) but is NOT a chat message and must not be treated as one.
        for action_result in ["action.completed", "action.failed", "action.denied"] {
            assert!(
                !is_chat_message_delivery(action_result),
                "{action_result} must not be treated as a chat message"
            );
        }
        // ack-only / unknown classes are also not chat messages.
        for other in ["message.reacted", "message.read", "something.new"] {
            assert!(!is_chat_message_delivery(other));
        }
    }

    #[test]
    fn fleet_dashboard_relay_inbound_event_has_expected_shape_for_message_class_delivery() {
        // (a) A message-class delivery to one recipient produces exactly one
        // dashboard event, shaped like the HTTP Send handler's `relay_inbound`
        // event, with `event_id` stably set to `deliver.msg_id`.
        let deliver = test_deliver("claude-1", "delivery-1", "msg-123", json!({}));
        let fields = FleetDeliveryFields {
            body: "hello #general".to_string(),
            from: "codex-1".to_string(),
            target: "#general".to_string(),
            thread_id: Some(ThreadId::new("thr-1")),
            priority: None,
        };
        let event = fleet_dashboard_relay_inbound_event(
            "message.created",
            &deliver,
            &fields,
            "broker-self",
            Some("ws-1"),
            Some("alias-1"),
        )
        .expect("message-class delivery from a non-dashboard sender should emit");

        assert_eq!(event["kind"], "relay_inbound");
        assert_eq!(event["event_id"], "msg-123");
        assert_eq!(event["from"], "codex-1");
        assert_eq!(event["target"], "#general");
        assert_eq!(event["body"], "hello #general");
        assert_eq!(event["thread_id"], "thr-1");
        assert_eq!(event["workspace_id"], "ws-1");
        assert_eq!(event["workspace_alias"], "alias-1");
    }

    #[test]
    fn fleet_dashboard_relay_inbound_event_id_is_stable_across_fanned_out_recipients() {
        // (b) The node control plane fans a single channel message out to one
        // `Deliver` frame PER local recipient, each with a distinct
        // `delivery_id`/`agent` but the SAME `msg_id`. The dashboard event's
        // `event_id` must be that shared `msg_id` in every case, so the
        // renderer's exact-id dedup collapses the duplicates instead of
        // showing the same message once per recipient.
        let fields = FleetDeliveryFields {
            body: "hello #general".to_string(),
            from: "codex-1".to_string(),
            target: "#general".to_string(),
            thread_id: None,
            priority: None,
        };
        let deliver_to_claude = test_deliver("claude-1", "delivery-1", "msg-shared", json!({}));
        let deliver_to_gpt = test_deliver("gpt-1", "delivery-2", "msg-shared", json!({}));

        let event_a = fleet_dashboard_relay_inbound_event(
            "message.created",
            &deliver_to_claude,
            &fields,
            "broker-self",
            None,
            None,
        )
        .expect("first recipient's delivery should emit");
        let event_b = fleet_dashboard_relay_inbound_event(
            "message.created",
            &deliver_to_gpt,
            &fields,
            "broker-self",
            None,
            None,
        )
        .expect("second recipient's delivery should emit");

        assert_eq!(event_a["event_id"], "msg-shared");
        assert_eq!(event_b["event_id"], "msg-shared");
        assert_eq!(
            event_a["event_id"], event_b["event_id"],
            "event_id must be identical across every local recipient's Deliver frame for the same underlying message"
        );
    }

    #[test]
    fn fleet_dashboard_relay_inbound_event_skips_dashboard_originated_messages() {
        // (c) A human's own message sent from Pear's dashboard already gets an
        // immediate `relay_inbound` emission (under a different, `http_*`,
        // event id) at HTTP send time, and then round-trips back through node
        // delivery to any local worker subscribed to the channel. Re-emitting
        // it here — under `deliver.msg_id` instead of the original `http_*`
        // id — would duplicate it under a second id that exact-id dedup can't
        // catch, so it must be skipped broker-side using the same
        // `sender_is_dashboard_label` check the Send handler uses.
        let deliver = test_deliver("claude-1", "delivery-1", "msg-456", json!({}));
        for dashboard_label in [
            "Dashboard",
            "human:Dashboard",
            "human:orchestrator",
            "broker-self",
        ] {
            let fields = FleetDeliveryFields {
                body: "hi from dashboard".to_string(),
                from: dashboard_label.to_string(),
                target: "#general".to_string(),
                thread_id: None,
                priority: None,
            };
            assert!(
                fleet_dashboard_relay_inbound_event(
                    "message.created",
                    &deliver,
                    &fields,
                    "broker-self",
                    None,
                    None,
                )
                .is_none(),
                "sender {dashboard_label} should be recognized as the dashboard/self identity and skipped"
            );
        }
        // A non-dashboard sender (another agent, a remote human) still emits.
        let fields = FleetDeliveryFields {
            body: "hi".to_string(),
            from: "codex-1".to_string(),
            target: "#general".to_string(),
            thread_id: None,
            priority: None,
        };
        assert!(fleet_dashboard_relay_inbound_event(
            "message.created",
            &deliver,
            &fields,
            "broker-self",
            None,
            None,
        )
        .is_some());
    }

    #[test]
    fn fleet_dashboard_relay_inbound_event_skips_action_result_deliveries() {
        // (d) action.completed/action.failed/action.denied are Inject-classified
        // (PTY'd back to the invoking agent as an action result) but are not
        // chat messages and must not surface as a dashboard `relay_inbound`
        // chat bubble.
        let deliver = test_deliver("claude-1", "delivery-1", "msg-789", json!({}));
        let fields = FleetDeliveryFields {
            body: "{\"ok\":true}".to_string(),
            from: "codex-1".to_string(),
            target: "claude-1".to_string(),
            thread_id: None,
            priority: None,
        };
        for action_result_type in ["action.completed", "action.failed", "action.denied"] {
            assert!(
                fleet_dashboard_relay_inbound_event(
                    action_result_type,
                    &deliver,
                    &fields,
                    "broker-self",
                    None,
                    None,
                )
                .is_none(),
                "{action_result_type} must not emit a dashboard relay_inbound event"
            );
        }
    }
}
