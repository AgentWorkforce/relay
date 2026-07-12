use super::*;
use crate::{
    fleet_wire::{
        ActionInvoke, ActionResult, ActionResultError, ActionResultOutput, ActionResultPayload,
        AgentRegister, BrokerToRelaycast, Deliver, DeliveryMode, RelaycastToBroker,
        FLEET_WIRE_VERSION,
    },
    node_control::{delivery_ack, handler_unavailable_result},
};

const FLEET_AGENT_REGISTER_TIMEOUT: Duration = Duration::from_secs(30);

impl BrokerRuntime {
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
        let decision = self.fleet_delivery_book.observe(&deliver);
        let up_to_seq = match decision {
            crate::node_control::DeliveryDecision::Deliver { up_to_seq: _ } => {
                match self.surface_fleet_deliver(&deliver).await {
                    Ok(()) => self.fleet_delivery_book.commit_delivered(&deliver),
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
                }
            }
            crate::node_control::DeliveryDecision::Duplicate { up_to_seq }
            | crate::node_control::DeliveryDecision::Stale { up_to_seq }
            | crate::node_control::DeliveryDecision::Gap { up_to_seq } => up_to_seq,
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
    /// An `Ok` return means the delivery may be committed and acked; an `Err`
    /// means injection failed and the ack must be withheld so the engine
    /// redelivers.
    async fn surface_fleet_deliver(&mut self, deliver: &Deliver) -> Result<(), anyhow::Error> {
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
                    },
                );
                if let Some(dropped_from) = &queue_result.evicted_from {
                    let _ = send_broker_event(
                        &self.sdk_out_tx,
                        delivery_dropped_event_for_eviction(&deliver.agent, dropped_from),
                    )
                    .await;
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
                        Ok(())
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
                        current_result
                    }
                    InboundQueueOutcome::WorkerMissing => {
                        let relay_delivery = self.fleet_relay_delivery(deliver);
                        self.workers.deliver(&deliver.agent, relay_delivery).await
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
                Ok(())
            }
            FleetDeliverySurfacing::AckUnknown => {
                tracing::warn!(
                    target = "relay_broker::fleet",
                    agent = %deliver.agent,
                    delivery_id = %deliver.delivery_id,
                    payload_type = %payload_type,
                    "acking unrecognized node delivery payload type without surfacing"
                );
                Ok(())
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

        super::relaycast_events::spawn_worker_from_request(
            name.clone(),
            cli,
            task,
            channel,
            model,
            &ws_value,
            &workspace_id,
            None,
            &workspace_state,
            &mut self.workers,
            &mut self.state,
            &self.paths,
            &self.telemetry,
            &self.sdk_out_tx,
            &mut self.dedup,
            &mut self.agent_spawn_count,
            &self.fleet_control_tx,
            &self.fleet_node_name,
            Some(invoke.invocation_id.clone()),
            session_ref,
        )
        .await;

        self.publish_fleet_load(true).await;

        // `spawn_worker_from_request` does not return a result; treat presence of
        // the worker as success so the engine's invocation resolves.
        if self.workers.workers.contains_key(&name) {
            self.reply_action_output(
                &invoke.invocation_id,
                json!({ "spawned": true, "name": name.as_str() }),
            )
            .await;
        } else {
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
            &mut self.pending_requests,
            &mut self.delivery_states,
            &mut self.agent_result_tokens,
        )
        .await;

        prune_fleet_agent_state(
            &self.fleet_control_tx,
            &mut self.fleet_inventory,
            &mut self.fleet_delivery_book,
            &name,
        )
        .await;
        self.publish_fleet_load(true).await;
        match outcome {
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

/// Bind an agent to this node by sending node-control `agent.register` and
/// awaiting the engine reply with the minted agent token. This is the single
/// "register agent via node" step both the `/api/spawn` path and the node
/// `action.invoke` spawn converge on, so every spawned agent is born
/// `via_node`-bound to the broker. The returned token is injected into the
/// worker as `RELAY_AGENT_TOKEN` (which also sets `RELAY_SKIP_BOOTSTRAP`), so
/// the worker MCP never re-registers over HTTP.
pub(super) async fn register_node_agent_token(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
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
    tokio::time::timeout(FLEET_AGENT_REGISTER_TIMEOUT, reply_rx)
        .await
        .map_err(|_| "agent_register_timeout".to_string())?
        .map_err(|_| "agent_register_reply_dropped".to_string())?
}

pub(super) async fn publish_fleet_load_snapshot(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    active_agents: u32,
    max_agents: u32,
    handlers_live: bool,
    heartbeat_now: bool,
) {
    let _ = fleet_control_tx
        .send(FleetControlCommand::UpdateLoad(FleetLoadSnapshot {
            active_agents,
            max_agents,
            handlers_live,
        }))
        .await;
    if heartbeat_now {
        let _ = fleet_control_tx
            .send(FleetControlCommand::HeartbeatNow)
            .await;
    }
}

pub(super) async fn publish_fleet_inventory_snapshot(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &HashMap<WorkerName, InventoryAgent>,
) {
    let _ = fleet_control_tx
        .send(FleetControlCommand::UpdateInventory(
            fleet_inventory.values().cloned().collect(),
        ))
        .await;
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
    async fn action_invoke_spawn_forwards_session_ref_and_invocation_into_agent_register() {
        // An `action.invoke` spawn carrying `harnessConfig.session_id` must
        // forward a non-None session_ref (and the invocation id) into the node
        // `agent.register` it emits, so the spawn resumes the session and the
        // invocation is correlated to the agent (Bug 2). Previously both were
        // hardcoded to None on this path.
        let ws_value = json!({
            "agent": {
                "harnessConfig": {
                    "runtime": "pty",
                    "command": "codex",
                    "sessionId": "sess-resume-7",
                }
            }
        });
        let session_ref = super::super::relaycast_events::relaycast_spawn_session_ref(&ws_value);
        assert_eq!(
            session_ref.as_deref(),
            Some("sess-resume-7"),
            "session ref must be derived from harnessConfig.session_id"
        );

        // Drive the exact registration step the spawn path uses and capture the
        // emitted AgentRegister to confirm both fields are threaded through.
        let (tx, mut rx) = mpsc::channel::<FleetControlCommand>(4);
        let register_handle = tokio::spawn(async move {
            register_node_agent_token(&tx, "agent-a", Some("inv-42".to_string()), session_ref).await
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
            }))
            .unwrap();
        let token = register_handle.await.unwrap().unwrap();
        assert_eq!(token.token, "at_test");
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
