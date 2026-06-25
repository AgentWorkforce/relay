use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use uuid::Uuid;

use crate::{
    fleet_wire::{
        ActionInvoke, ActionResult, ActionResultError, ActionResultOutput, ActionResultPayload,
        AgentDeregister, AgentRegister, BrokerToRelaycast, Deliver, DeliveryAck, FleetCapability,
        InventoryAgent, InventorySync, NodeDeregister, NodeHeartbeat, NodeRegister,
        RelaycastToBroker, FLEET_WIRE_VERSION,
    },
    protocol::{HandlerResult, HandlerResultPayload, NodeManifest},
};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(12);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
const REGISTER_AGENT_PENDING_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FleetControlConfig {
    pub(crate) ws_url: String,
    pub(crate) node_token: Option<String>,
    pub(crate) node_id: String,
    pub(crate) node_name: String,
    pub(crate) broker_version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FleetLoadSnapshot {
    pub(crate) active_agents: u32,
    pub(crate) max_agents: u32,
    pub(crate) handlers_live: bool,
}

impl FleetLoadSnapshot {
    /// Build a heartbeat carrying the live load/liveness AND the node roster
    /// snapshot (name/node_id/capabilities/version) so the relaycast engine can
    /// keep this node's descriptor fresh from the steady-state heartbeat without
    /// a fresh `node.register`.
    ///
    /// `max_agents` is sourced from `self` (the FleetLoadSnapshot), which is the
    /// single authoritative live capacity: it is the same denominator used for
    /// the `load` ratio, and it is kept in lockstep with `node.register` because
    /// `RegisterNode`/`UpdateLoad` commands set `load.max_agents` from the same
    /// manifest the register frame is built from (see `run_connected_once`). The
    /// remaining roster fields are immutable identity/descriptor data carried on
    /// the active `NodeRegister`. This guarantees load and max_agents in one
    /// heartbeat never diverge.
    ///
    /// `last_heartbeat_at` is intentionally NOT set — the engine stamps receipt
    /// time server-side as the single source of truth for liveness.
    fn heartbeat(&self, node: &NodeRegister) -> NodeHeartbeat {
        let load = if self.max_agents == 0 {
            0.0
        } else {
            (self.active_agents as f64 / self.max_agents as f64).clamp(0.0, 1.0)
        };
        NodeHeartbeat {
            v: FLEET_WIRE_VERSION,
            id: None,
            name: node.name.clone(),
            node_id: node.node_id.clone(),
            capabilities: node.capabilities.clone(),
            max_agents: self.max_agents,
            version: node.version.clone(),
            load,
            active_agents: self.active_agents,
            handlers_live: self.handlers_live,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentRegistrationToken {
    pub(crate) name: String,
    pub(crate) agent_id: String,
    pub(crate) token: String,
}

#[derive(Debug)]
struct PendingAgentRegistration {
    name: String,
    reply: oneshot::Sender<Result<AgentRegistrationToken, String>>,
    created_at: Instant,
}

#[derive(Debug)]
pub(crate) enum FleetControlCommand {
    RegisterNode {
        manifest: NodeManifest,
        resume_cursor: Option<String>,
    },
    UpdateInventory(Vec<InventoryAgent>),
    UpdateLoad(FleetLoadSnapshot),
    HeartbeatNow,
    DeregisterNode,
    Send(BrokerToRelaycast),
    RegisterAgent {
        request: AgentRegister,
        reply: oneshot::Sender<Result<AgentRegistrationToken, String>>,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum FleetControlEvent {
    Connected,
    Disconnected,
    Message(RelaycastToBroker),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeliveryDecision {
    Deliver { up_to_seq: u64 },
    Duplicate { up_to_seq: u64 },
    Stale { up_to_seq: u64 },
    Gap { up_to_seq: u64 },
}

#[derive(Debug, Default, Clone)]
struct AgentDeliveryCursor {
    up_to_seq: u64,
    seen_msg_ids: HashSet<String>,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct FleetDeliveryBook {
    agents: HashMap<String, AgentDeliveryCursor>,
}

impl FleetDeliveryBook {
    #[cfg(test)]
    pub(crate) fn seed_ack(&mut self, agent: impl Into<String>, up_to_seq: u64) {
        self.agents.entry(agent.into()).or_default().up_to_seq = up_to_seq;
    }

    pub(crate) fn observe(&self, deliver: &Deliver) -> DeliveryDecision {
        let Some(cursor) = self.agents.get(&deliver.agent) else {
            return if deliver.seq == 1 {
                DeliveryDecision::Deliver { up_to_seq: 1 }
            } else {
                DeliveryDecision::Gap { up_to_seq: 0 }
            };
        };
        if cursor.seen_msg_ids.contains(&deliver.msg_id) {
            return DeliveryDecision::Duplicate {
                up_to_seq: cursor.up_to_seq,
            };
        }

        if deliver.seq <= cursor.up_to_seq {
            return DeliveryDecision::Stale {
                up_to_seq: cursor.up_to_seq,
            };
        }

        if deliver.seq != cursor.up_to_seq.saturating_add(1) {
            return DeliveryDecision::Gap {
                up_to_seq: cursor.up_to_seq,
            };
        }

        DeliveryDecision::Deliver {
            up_to_seq: deliver.seq,
        }
    }

    pub(crate) fn commit_delivered(&mut self, deliver: &Deliver) -> u64 {
        let cursor = self.agents.entry(deliver.agent.clone()).or_default();
        if deliver.seq == cursor.up_to_seq.saturating_add(1) {
            cursor.seen_msg_ids.insert(deliver.msg_id.clone());
            cursor.up_to_seq = deliver.seq;
        }
        cursor.up_to_seq
    }

    pub(crate) fn remove_agent(&mut self, agent: &str) {
        self.agents.remove(agent);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HandlerDispatchDecision {
    Dispatch {
        invocation_id: String,
        name: String,
        input: Value,
    },
    AlreadyInFlight,
    Completed(ActionResult),
    Unavailable(ActionResult),
}

#[derive(Debug, Clone, PartialEq)]
struct InFlightHandler {
    name: String,
    input: Value,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct HandlerDispatchState {
    sidecar_connected: bool,
    handlers: HashSet<String>,
    in_flight: HashMap<String, InFlightHandler>,
    completed: HashMap<String, ActionResultPayload>,
}

impl HandlerDispatchState {
    pub(crate) fn connect_sidecar(&mut self) {
        self.sidecar_connected = true;
        self.handlers.clear();
    }

    pub(crate) fn disconnect_sidecar(&mut self) {
        self.sidecar_connected = false;
        self.handlers.clear();
    }

    pub(crate) fn register_handlers(&mut self, names: Vec<String>) {
        self.handlers = names
            .into_iter()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect();
    }

    pub(crate) fn handlers_live(&self) -> bool {
        self.sidecar_connected && !self.handlers.is_empty()
    }

    pub(crate) fn has_in_flight(&self) -> bool {
        !self.in_flight.is_empty()
    }

    pub(crate) fn drain_in_flight_unavailable(&mut self) -> Vec<ActionResult> {
        self.in_flight
            .drain()
            .map(|(invocation_id, _)| handler_unavailable_result(&invocation_id))
            .collect()
    }

    pub(crate) fn fail_unavailable(&mut self, invocation_id: &str) -> ActionResult {
        self.in_flight.remove(invocation_id);
        handler_unavailable_result(invocation_id)
    }

    pub(crate) fn handle_invoke(&mut self, invoke: &ActionInvoke) -> HandlerDispatchDecision {
        if let Some(result) = self.completed.get(&invoke.invocation_id).cloned() {
            return HandlerDispatchDecision::Completed(ActionResult {
                v: FLEET_WIRE_VERSION,
                id: None,
                invocation_id: invoke.invocation_id.clone(),
                result,
            });
        }
        if self.in_flight.contains_key(&invoke.invocation_id) {
            return HandlerDispatchDecision::AlreadyInFlight;
        }
        if !self.sidecar_connected || !self.handlers.contains(&invoke.action) {
            return HandlerDispatchDecision::Unavailable(handler_unavailable_result(
                &invoke.invocation_id,
            ));
        }

        self.in_flight.insert(
            invoke.invocation_id.clone(),
            InFlightHandler {
                name: invoke.action.clone(),
                input: invoke.input.clone(),
            },
        );
        HandlerDispatchDecision::Dispatch {
            invocation_id: invoke.invocation_id.clone(),
            name: invoke.action.clone(),
            input: invoke.input.clone(),
        }
    }

    pub(crate) fn complete(&mut self, result: HandlerResult) -> Option<ActionResult> {
        let invocation_id = result.invocation_id;
        self.in_flight.remove(&invocation_id)?;
        let result = match result.result {
            HandlerResultPayload::Output { output } => {
                ActionResultPayload::Output(ActionResultOutput { output })
            }
            HandlerResultPayload::Error { error } => {
                ActionResultPayload::Error(ActionResultError { error })
            }
        };
        self.completed.insert(invocation_id.clone(), result.clone());
        Some(ActionResult {
            v: FLEET_WIRE_VERSION,
            id: None,
            invocation_id,
            result,
        })
    }
}

pub(crate) fn handler_unavailable_result(invocation_id: &str) -> ActionResult {
    ActionResult {
        v: FLEET_WIRE_VERSION,
        id: None,
        invocation_id: invocation_id.to_string(),
        result: ActionResultPayload::Error(ActionResultError {
            error: "handler_unavailable".to_string(),
        }),
    }
}

pub(crate) fn build_node_register(
    manifest: &NodeManifest,
    default_node_id: &str,
    default_node_name: &str,
    default_version: &str,
    resume_cursor: Option<String>,
) -> NodeRegister {
    NodeRegister {
        v: FLEET_WIRE_VERSION,
        id: None,
        name: non_empty(&manifest.name)
            .unwrap_or(default_node_name)
            .to_string(),
        node_id: manifest
            .node_id
            .as_deref()
            .and_then(non_empty)
            .unwrap_or(default_node_id)
            .to_string(),
        capabilities: manifest
            .capabilities
            .iter()
            .map(|capability| FleetCapability {
                name: capability.name.clone(),
                kind: capability.kind.clone(),
                metadata: capability.metadata.as_ref().map(|metadata| {
                    metadata
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect::<BTreeMap<_, _>>()
                }),
            })
            .collect(),
        max_agents: manifest.max_agents.unwrap_or(0),
        tags: manifest.tags.clone().unwrap_or_default(),
        version: manifest
            .version
            .as_deref()
            .and_then(non_empty)
            .unwrap_or(default_version)
            .to_string(),
        resume_cursor,
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub(crate) fn default_node_name(cli_name: Option<&str>) -> String {
    if let Some(name) = cli_name.and_then(non_empty) {
        return name.to_string();
    }
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .and_then(|name| non_empty(&name).map(ToOwned::to_owned))
        .unwrap_or_else(|| "relay-node".to_string())
}

pub(crate) fn load_or_create_node_id(path: &Path) -> Result<String> {
    if let Ok(existing) = fs::read_to_string(path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return Ok(existing.to_string());
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create node id dir {}", parent.display()))?;
    }
    let id = format!("node_{}", Uuid::new_v4().simple());
    fs::write(path, format!("{id}\n"))
        .with_context(|| format!("failed to write node id file {}", path.display()))?;
    Ok(id)
}

pub(crate) fn default_node_id_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join("agent-relay").join("machine-id"))
}

/// Path to the persisted node token, kept next to the node id file so a node's
/// identity and its minted control token live and rotate together.
pub(crate) fn default_node_token_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join("agent-relay").join("node-token.json"))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedNodeToken {
    node_id: String,
    token: String,
}

/// Load a previously minted node token, but only if it was minted for the same
/// `node_id`. A mismatch means the machine id rotated since the token was
/// written, so the cached token no longer authenticates this node and is
/// ignored (the caller mints a fresh one).
pub(crate) fn load_node_token(path: &Path, node_id: &str) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let persisted: PersistedNodeToken = serde_json::from_str(&raw).ok()?;
    if persisted.node_id != node_id {
        return None;
    }
    let token = persisted.token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

/// Persist a minted node token next to the node id, scoped to `node_id` so a
/// later id rotation invalidates it. Failures are surfaced as `Err` but are
/// non-fatal to startup — the caller logs and continues with the in-memory
/// token.
pub(crate) fn persist_node_token(path: &Path, node_id: &str, token: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create node token dir {}", parent.display()))?;
    }
    let body = serde_json::to_string(&PersistedNodeToken {
        node_id: node_id.to_string(),
        token: token.to_string(),
    })
    .context("failed to serialize node token")?;
    fs::write(path, body)
        .with_context(|| format!("failed to write node token file {}", path.display()))?;
    Ok(())
}

pub(crate) async fn run_node_control_client(
    config: FleetControlConfig,
    mut command_rx: mpsc::Receiver<FleetControlCommand>,
    event_tx: mpsc::Sender<FleetControlEvent>,
) {
    let mut registration: Option<NodeRegister> = None;
    let mut inventory: Vec<InventoryAgent> = Vec::new();
    let mut load = FleetLoadSnapshot::default();
    let mut reconnect_delay = INITIAL_RECONNECT_DELAY;

    loop {
        while registration.is_none() {
            match command_rx.recv().await {
                Some(FleetControlCommand::RegisterNode {
                    manifest,
                    resume_cursor,
                }) => {
                    load.max_agents = manifest.max_agents.unwrap_or(load.max_agents);
                    registration = Some(build_node_register(
                        &manifest,
                        &config.node_id,
                        &config.node_name,
                        &config.broker_version,
                        resume_cursor,
                    ));
                }
                Some(FleetControlCommand::UpdateLoad(next)) => load = next,
                Some(FleetControlCommand::UpdateInventory(next)) => inventory = next,
                Some(FleetControlCommand::Shutdown) | None => return,
                Some(FleetControlCommand::RegisterAgent { reply, .. }) => {
                    let _ = reply.send(Err("node_not_registered".to_string()));
                }
                Some(FleetControlCommand::DeregisterNode) => {
                    inventory.clear();
                    load.handlers_live = false;
                }
                Some(FleetControlCommand::Send(_)) | Some(FleetControlCommand::HeartbeatNow) => {}
            }
        }

        if config
            .node_token
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            match command_rx.recv().await {
                Some(FleetControlCommand::RegisterNode {
                    manifest,
                    resume_cursor,
                }) => {
                    load.max_agents = manifest.max_agents.unwrap_or(load.max_agents);
                    registration = Some(build_node_register(
                        &manifest,
                        &config.node_id,
                        &config.node_name,
                        &config.broker_version,
                        resume_cursor,
                    ));
                }
                Some(FleetControlCommand::UpdateLoad(next)) => load = next,
                Some(FleetControlCommand::UpdateInventory(next)) => inventory = next,
                Some(FleetControlCommand::Shutdown) | None => return,
                Some(FleetControlCommand::RegisterAgent { reply, .. }) => {
                    let _ = reply.send(Err("node_token_missing".to_string()));
                }
                Some(FleetControlCommand::DeregisterNode) => {
                    registration = None;
                    inventory.clear();
                    load.handlers_live = false;
                }
                Some(FleetControlCommand::Send(_)) | Some(FleetControlCommand::HeartbeatNow) => {}
            }
            continue;
        }

        let result = run_connected_once(
            &config,
            &mut command_rx,
            &event_tx,
            &mut registration,
            &mut inventory,
            &mut load,
        )
        .await;
        if matches!(result, ControlRunResult::Shutdown) {
            return;
        }
        if matches!(result, ControlRunResult::Deregistered) {
            reconnect_delay = INITIAL_RECONNECT_DELAY;
            continue;
        }
        let _ = event_tx.send(FleetControlEvent::Disconnected).await;
        tokio::time::sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlRunResult {
    Disconnected,
    Deregistered,
    Shutdown,
}

async fn run_connected_once(
    config: &FleetControlConfig,
    command_rx: &mut mpsc::Receiver<FleetControlCommand>,
    event_tx: &mpsc::Sender<FleetControlEvent>,
    registration: &mut Option<NodeRegister>,
    inventory: &mut Vec<InventoryAgent>,
    load: &mut FleetLoadSnapshot,
) -> ControlRunResult {
    let Some(mut node_register) = registration.clone() else {
        return ControlRunResult::Disconnected;
    };
    let Some(node_token) = config.node_token.as_deref() else {
        return ControlRunResult::Disconnected;
    };

    let mut request = match config.ws_url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(target = "relay_broker::fleet", error = %error, "invalid fleet node ws url");
            return ControlRunResult::Disconnected;
        }
    };
    let header = format!("Bearer {}", node_token.trim());
    match header.parse() {
        Ok(value) => {
            request.headers_mut().insert("authorization", value);
        }
        Err(error) => {
            tracing::warn!(target = "relay_broker::fleet", error = %error, "invalid fleet node token header");
            return ControlRunResult::Disconnected;
        }
    }

    let (ws, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(error) => {
            tracing::warn!(target = "relay_broker::fleet", url = %config.ws_url, error = %error, "fleet node ws connect failed");
            return ControlRunResult::Disconnected;
        }
    };
    let _ = event_tx.send(FleetControlEvent::Connected).await;
    let (mut sink, mut stream) = ws.split();
    let mut pending_agent_registrations: HashMap<String, PendingAgentRegistration> = HashMap::new();

    if send_wire(
        &mut sink,
        &BrokerToRelaycast::NodeRegister(node_register.clone()),
    )
    .await
    .is_err()
    {
        return ControlRunResult::Disconnected;
    }
    if !inventory.is_empty()
        && send_wire(
            &mut sink,
            &BrokerToRelaycast::InventorySync(InventorySync {
                v: FLEET_WIRE_VERSION,
                id: None,
                agents: inventory.clone(),
            }),
        )
        .await
        .is_err()
    {
        return ControlRunResult::Disconnected;
    }
    if send_wire(
        &mut sink,
        &BrokerToRelaycast::NodeHeartbeat(load.heartbeat(&node_register)),
    )
    .await
    .is_err()
    {
        return ControlRunResult::Disconnected;
    }

    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            command = command_rx.recv() => {
                match command {
                    Some(FleetControlCommand::RegisterNode { manifest, resume_cursor }) => {
                        load.max_agents = manifest.max_agents.unwrap_or(load.max_agents);
                        let next = build_node_register(&manifest, &config.node_id, &config.node_name, &config.broker_version, resume_cursor);
                        node_register = next.clone();
                        *registration = Some(next.clone());
                        if send_wire(&mut sink, &BrokerToRelaycast::NodeRegister(next)).await.is_err() {
                            return ControlRunResult::Disconnected;
                        }
                    }
                    Some(FleetControlCommand::UpdateInventory(next)) => {
                        *inventory = next;
                        if send_wire(
                            &mut sink,
                            &BrokerToRelaycast::InventorySync(InventorySync {
                                v: FLEET_WIRE_VERSION,
                                id: None,
                                agents: inventory.clone(),
                            }),
                        )
                        .await
                        .is_err()
                        {
                            drain_agent_registrations(
                                &mut pending_agent_registrations,
                                "node_control_disconnected",
                            );
                            return ControlRunResult::Disconnected;
                        }
                    }
                    Some(FleetControlCommand::UpdateLoad(next)) => {
                        *load = next;
                    }
                    Some(FleetControlCommand::HeartbeatNow) => {
                        if send_wire(&mut sink, &BrokerToRelaycast::NodeHeartbeat(load.heartbeat(&node_register))).await.is_err() {
                            return ControlRunResult::Disconnected;
                        }
                    }
                    Some(FleetControlCommand::DeregisterNode) => {
                        let _ = send_wire(
                            &mut sink,
                            &BrokerToRelaycast::NodeDeregister(NodeDeregister {
                                v: FLEET_WIRE_VERSION,
                                id: None,
                            }),
                        )
                        .await;
                        *registration = None;
                        inventory.clear();
                        load.handlers_live = false;
                        drain_agent_registrations(
                            &mut pending_agent_registrations,
                            "node_deregistered",
                        );
                        return ControlRunResult::Deregistered;
                    }
                    Some(FleetControlCommand::Send(message)) => {
                        if send_wire(&mut sink, &message).await.is_err() {
                            return ControlRunResult::Disconnected;
                        }
                    }
                    Some(FleetControlCommand::RegisterAgent { mut request, reply }) => {
                        let request_id = request.id.clone().unwrap_or_else(|| {
                            format!("agent_register_{}", Uuid::new_v4().simple())
                        });
                        request.id = Some(request_id.clone());
                        pending_agent_registrations.insert(
                            request_id,
                            PendingAgentRegistration {
                                name: request.name.clone(),
                                reply,
                                created_at: Instant::now(),
                            },
                        );
                        if send_wire(&mut sink, &BrokerToRelaycast::AgentRegister(request)).await.is_err() {
                            drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                            return ControlRunResult::Disconnected;
                        }
                    }
                    Some(FleetControlCommand::Shutdown) | None => {
                        drain_agent_registrations(&mut pending_agent_registrations, "node_control_shutdown");
                        return ControlRunResult::Shutdown;
                    }
                }
            }
            _ = heartbeat.tick() => {
                expire_agent_registrations(&mut pending_agent_registrations, Instant::now());
                if send_wire(&mut sink, &BrokerToRelaycast::NodeHeartbeat(load.heartbeat(&node_register))).await.is_err() {
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected;
                }
            }
            message = stream.next() => {
                let Some(message) = message else {
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected;
                };
                let message = match message {
                    Ok(message) => message,
                    Err(error) => {
                        tracing::warn!(target = "relay_broker::fleet", error = %error, "fleet node ws read failed");
                        drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                        return ControlRunResult::Disconnected;
                    }
                };
                if !handle_server_message(message, event_tx, &mut pending_agent_registrations, &mut sink).await {
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected;
                }
            }
        }
    }
}

async fn handle_server_message<S>(
    message: Message,
    event_tx: &mpsc::Sender<FleetControlEvent>,
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    sink: &mut S,
) -> bool
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    match message {
        Message::Text(text) => match serde_json::from_str::<RelaycastToBroker>(&text) {
            Ok(RelaycastToBroker::Reply(reply)) => {
                complete_agent_registration(reply, pending_agent_registrations, sink).await
            }
            Ok(RelaycastToBroker::Error(error)) => {
                fail_agent_registration(
                    &error.id,
                    format!("{}: {}", error.code, error.message),
                    pending_agent_registrations,
                );
                true
            }
            Ok(other) => event_tx
                .send(FleetControlEvent::Message(other))
                .await
                .is_ok(),
            Err(error) => {
                tracing::warn!(target = "relay_broker::fleet", error = %error, "invalid fleet node ws frame");
                true
            }
        },
        Message::Ping(_) => true,
        Message::Close(_) => false,
        _ => true,
    }
}

async fn complete_agent_registration<S>(
    reply: crate::fleet_wire::Reply,
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    sink: &mut S,
) -> bool
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let request_id = reply.id.clone();
    let Some(pending) = pending_agent_registrations.remove(&request_id) else {
        tracing::warn!(
            target = "relay_broker::fleet",
            id = %request_id,
            "agent.register reply did not match a pending registration"
        );
        return true;
    };
    let data = match reply.validate_agent_register_data() {
        Ok(data) => data,
        Err(error) => {
            let _ = pending
                .reply
                .send(Err(format!("invalid_agent_register_reply_data: {error}")));
            return true;
        }
    };
    let token = AgentRegistrationToken {
        name: data.name.unwrap_or_else(|| pending.name.clone()),
        agent_id: data.agent_id,
        token: data.token,
    };
    match pending.reply.send(Ok(token.clone())) {
        Ok(()) => true,
        Err(Ok(token)) => {
            tracing::warn!(
                target = "relay_broker::fleet",
                id = %request_id,
                name = %pending.name,
                agent_id = %token.agent_id,
                "late agent.register success after caller stopped waiting; sending compensating agent.deregister"
            );
            send_wire(
                sink,
                &BrokerToRelaycast::AgentDeregister(AgentDeregister {
                    v: FLEET_WIRE_VERSION,
                    id: Some(request_id),
                    agent_id: token.agent_id,
                    name: Some(pending.name),
                }),
            )
            .await
            .is_ok()
        }
        Err(Err(_)) => true,
    }
}

fn fail_agent_registration(
    id: &str,
    reason: String,
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
) {
    if let Some(pending) = pending_agent_registrations.remove(id) {
        let _ = pending.reply.send(Err(reason));
    }
}

fn expire_agent_registrations(
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    now: Instant,
) {
    let expired: Vec<String> = pending_agent_registrations
        .iter()
        .filter_map(|(id, pending)| {
            (now.saturating_duration_since(pending.created_at) >= REGISTER_AGENT_PENDING_TTL)
                .then_some(id.clone())
        })
        .collect();

    for id in expired {
        if let Some(pending) = pending_agent_registrations.remove(&id) {
            tracing::warn!(
                target = "relay_broker::fleet",
                id = %id,
                name = %pending.name,
                "agent.register pending reply expired without engine response"
            );
            let _ = pending
                .reply
                .send(Err("agent_register_pending_expired".to_string()));
        }
    }
}

fn drain_agent_registrations(
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    reason: &str,
) {
    for (_, pending) in pending_agent_registrations.drain() {
        let _ = pending.reply.send(Err(reason.to_string()));
    }
}

async fn send_wire<S>(sink: &mut S, message: &BrokerToRelaycast) -> Result<()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let text = serde_json::to_string(message)?;
    sink.send(Message::Text(text)).await?;
    Ok(())
}

pub(crate) fn delivery_ack(agent: impl Into<String>, up_to_seq: u64) -> BrokerToRelaycast {
    BrokerToRelaycast::DeliveryAck(DeliveryAck {
        v: FLEET_WIRE_VERSION,
        id: None,
        agent: agent.into(),
        up_to_seq,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    use super::*;
    use crate::fleet_wire::DeliveryMode;

    #[test]
    fn delivery_book_dedups_and_tracks_cumulative_ack() {
        let mut book = FleetDeliveryBook::default();
        let first = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-1".to_string(),
            msg_id: "msg-1".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "one"}),
        };

        assert_eq!(
            book.observe(&first),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
        assert_eq!(book.commit_delivered(&first), 1);
        assert_eq!(
            book.observe(&first),
            DeliveryDecision::Duplicate { up_to_seq: 1 }
        );

        let stale = Deliver {
            msg_id: "msg-stale".to_string(),
            seq: 1,
            ..first.clone()
        };
        assert_eq!(
            book.observe(&stale),
            DeliveryDecision::Stale { up_to_seq: 1 }
        );

        let gap = Deliver {
            msg_id: "msg-gap".to_string(),
            seq: 3,
            ..first
        };
        assert_eq!(book.observe(&gap), DeliveryDecision::Gap { up_to_seq: 1 });
    }

    #[test]
    fn delivery_book_allows_seeded_resume_cursor() {
        let mut book = FleetDeliveryBook::default();
        book.seed_ack("agent-a", 42);
        let deliver = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-43".to_string(),
            msg_id: "msg-43".to_string(),
            seq: 43,
            mode: DeliveryMode::Steer,
            payload: json!({"text": "resume"}),
        };

        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Deliver { up_to_seq: 43 }
        );
        assert_eq!(book.commit_delivered(&deliver), 43);
    }

    #[test]
    fn delivery_book_retries_until_delivery_is_committed() {
        let mut book = FleetDeliveryBook::default();
        let deliver = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-1".to_string(),
            msg_id: "msg-1".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "retry"}),
        };

        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );

        assert_eq!(book.commit_delivered(&deliver), 1);
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Duplicate { up_to_seq: 1 }
        );
    }

    #[test]
    fn delivery_book_remove_agent_prunes_cursor_and_msg_ids() {
        let mut book = FleetDeliveryBook::default();
        let deliver = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-1".to_string(),
            msg_id: "msg-1".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "one"}),
        };
        assert_eq!(book.commit_delivered(&deliver), 1);
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Duplicate { up_to_seq: 1 }
        );

        book.remove_agent("agent-a");
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
    }

    #[test]
    fn expire_agent_registrations_bounds_pending_map() {
        let created_at = Instant::now();
        let (reply_tx, mut reply_rx) = oneshot::channel();
        let mut pending = HashMap::from([(
            "agent_register_1".to_string(),
            PendingAgentRegistration {
                name: "agent-a".to_string(),
                reply: reply_tx,
                created_at,
            },
        )]);

        expire_agent_registrations(
            &mut pending,
            created_at + REGISTER_AGENT_PENDING_TTL - Duration::from_millis(1),
        );
        assert_eq!(pending.len(), 1);

        expire_agent_registrations(&mut pending, created_at + REGISTER_AGENT_PENDING_TTL);
        assert!(pending.is_empty());
        assert!(matches!(
            reply_rx.try_recv(),
            Ok(Err(reason)) if reason == "agent_register_pending_expired"
        ));
    }

    #[test]
    fn handler_dispatch_requires_live_registered_handler() {
        let mut state = HandlerDispatchState::default();
        let invoke = ActionInvoke {
            v: FLEET_WIRE_VERSION,
            invocation_id: "inv-1".to_string(),
            action: "run:test".to_string(),
            input: json!({"suite": "unit"}),
            agent_id: None,
            agent_name: None,
        };

        assert!(matches!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::Unavailable(_)
        ));

        state.connect_sidecar();
        state.register_handlers(vec!["run:test".to_string()]);
        assert_eq!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::Dispatch {
                invocation_id: "inv-1".to_string(),
                name: "run:test".to_string(),
                input: json!({"suite": "unit"}),
            }
        );
        assert_eq!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::AlreadyInFlight
        );
    }

    #[test]
    fn handler_unavailable_failure_clears_inflight_invocation() {
        let mut state = HandlerDispatchState::default();
        state.connect_sidecar();
        state.register_handlers(vec!["run:test".to_string()]);
        let invoke = ActionInvoke {
            v: FLEET_WIRE_VERSION,
            invocation_id: "inv-1".to_string(),
            action: "run:test".to_string(),
            input: json!({"suite": "unit"}),
            agent_id: None,
            agent_name: None,
        };
        assert!(matches!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::Dispatch { .. }
        ));

        assert_eq!(
            state.fail_unavailable("inv-1"),
            handler_unavailable_result("inv-1")
        );
        assert_eq!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::Dispatch {
                invocation_id: "inv-1".to_string(),
                name: "run:test".to_string(),
                input: json!({"suite": "unit"}),
            }
        );
    }

    #[test]
    fn handler_result_completes_once_and_duplicate_invoke_replays_result() {
        let mut state = HandlerDispatchState::default();
        state.connect_sidecar();
        state.register_handlers(vec!["run:test".to_string()]);
        let invoke = ActionInvoke {
            v: FLEET_WIRE_VERSION,
            invocation_id: "inv-1".to_string(),
            action: "run:test".to_string(),
            input: json!({}),
            agent_id: None,
            agent_name: None,
        };
        assert!(matches!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::Dispatch { .. }
        ));

        let completed = state
            .complete(HandlerResult {
                invocation_id: "inv-1".to_string(),
                result: HandlerResultPayload::Output {
                    output: json!({"ok": true}),
                },
            })
            .expect("in-flight result should complete");
        assert_eq!(completed.invocation_id, "inv-1");

        assert_eq!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::Completed(completed)
        );
    }

    #[test]
    fn handler_error_maps_verbatim_to_action_error() {
        let mut state = HandlerDispatchState::default();
        state.connect_sidecar();
        state.register_handlers(vec!["run:test".to_string()]);
        let invoke = ActionInvoke {
            v: FLEET_WIRE_VERSION,
            invocation_id: "inv-err".to_string(),
            action: "run:test".to_string(),
            input: json!({}),
            agent_id: None,
            agent_name: None,
        };
        assert!(matches!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::Dispatch { .. }
        ));

        let completed = state
            .complete(HandlerResult {
                invocation_id: "inv-err".to_string(),
                result: HandlerResultPayload::Error {
                    error: "sidecar_failed".to_string(),
                },
            })
            .expect("in-flight result should complete");
        assert_eq!(
            completed.result,
            ActionResultPayload::Error(ActionResultError {
                error: "sidecar_failed".to_string(),
            })
        );
    }

    #[test]
    fn sidecar_disconnect_drains_inflight_as_unavailable() {
        let mut state = HandlerDispatchState::default();
        state.connect_sidecar();
        state.register_handlers(vec!["run:test".to_string()]);
        let invoke = ActionInvoke {
            v: FLEET_WIRE_VERSION,
            invocation_id: "inv-1".to_string(),
            action: "run:test".to_string(),
            input: json!({}),
            agent_id: None,
            agent_name: None,
        };
        assert!(matches!(
            state.handle_invoke(&invoke),
            HandlerDispatchDecision::Dispatch { .. }
        ));

        state.disconnect_sidecar();
        let drained = state.drain_in_flight_unavailable();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0], handler_unavailable_result("inv-1"));
        assert!(!state.handlers_live());
    }

    #[test]
    fn build_node_register_prefers_manifest_identity() {
        let manifest = NodeManifest {
            name: "builder".to_string(),
            node_id: Some("node-manifest".to_string()),
            capabilities: vec![crate::protocol::NodeCapabilityManifest {
                name: "spawn:codex".to_string(),
                kind: Some("spawn".to_string()),
                metadata: Some(HashMap::from([(
                    "cli".to_string(),
                    Value::String("codex".to_string()),
                )])),
            }],
            max_agents: Some(8),
            tags: Some(vec!["local".to_string()]),
            version: Some("sidecar/1".to_string()),
        };

        let register =
            build_node_register(&manifest, "node-default", "host-default", "broker/1", None);
        assert_eq!(register.name, "builder");
        assert_eq!(register.node_id, "node-manifest");
        assert_eq!(register.max_agents, 8);
        assert_eq!(
            register.capabilities[0].metadata,
            Some(BTreeMap::from([(
                "cli".to_string(),
                Value::String("codex".to_string())
            )]))
        );
    }

    #[tokio::test]
    async fn node_control_client_round_trips_mock_engine_ws() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();

            let register = next_node_to_server(&mut ws).await;
            assert!(matches!(register, BrokerToRelaycast::NodeRegister(_)));
            let heartbeat = next_node_to_server(&mut ws).await;
            assert!(matches!(heartbeat, BrokerToRelaycast::NodeHeartbeat(_)));

            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::Deliver(Deliver {
                    v: FLEET_WIRE_VERSION,
                    agent: "agent-a".to_string(),
                    agent_id: "agent-a-id".to_string(),
                    delivery_id: "delivery-1".to_string(),
                    msg_id: "msg-1".to_string(),
                    seq: 1,
                    mode: DeliveryMode::Wait,
                    payload: json!({"text": "hello"}),
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
            let ack = next_non_heartbeat_node_to_server(&mut ws).await;
            assert_eq!(ack, delivery_ack("agent-a", 1));

            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::ActionInvoke(ActionInvoke {
                    v: FLEET_WIRE_VERSION,
                    invocation_id: "inv-1".to_string(),
                    action: "run:test".to_string(),
                    input: json!({"suite": "unit"}),
                    agent_id: None,
                    agent_name: None,
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
            let result = next_non_heartbeat_node_to_server(&mut ws).await;
            assert!(matches!(result, BrokerToRelaycast::ActionResult(_)));
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        let event = event_rx.recv().await.unwrap();
        assert_eq!(event, FleetControlEvent::Connected);
        let event = event_rx.recv().await.unwrap();
        assert!(matches!(
            event,
            FleetControlEvent::Message(RelaycastToBroker::Deliver(_))
        ));
        command_tx
            .send(FleetControlCommand::Send(delivery_ack("agent-a", 1)))
            .await
            .unwrap();
        let event = event_rx.recv().await.unwrap();
        assert!(matches!(
            event,
            FleetControlEvent::Message(RelaycastToBroker::ActionInvoke(_))
        ));
        command_tx
            .send(FleetControlCommand::Send(BrokerToRelaycast::ActionResult(
                ActionResult {
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    invocation_id: "inv-1".to_string(),
                    result: ActionResultPayload::Output(ActionResultOutput {
                        output: json!({"ok": true}),
                    }),
                },
            )))
            .await
            .unwrap();
        command_tx
            .send(FleetControlCommand::Shutdown)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn node_control_agent_register_round_trips_minted_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();

            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));
            let register_id = match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::AgentRegister(request) => {
                    let register_id = request.id.clone().expect("agent.register id");
                    assert_eq!(request.name, "agent-a");
                    assert_eq!(request.invocation_id.as_deref(), Some("inv-1"));
                    assert_eq!(request.session_ref.as_deref(), Some("session-1"));
                    register_id
                }
                other => panic!("expected agent.register, got {other:?}"),
            };
            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::Reply(crate::fleet_wire::Reply {
                    v: FLEET_WIRE_VERSION,
                    id: register_id,
                    ok: true,
                    data: json!({
                        "name": "agent-a",
                        "agent_id": "agt-1",
                        "token": "at_test"
                    }),
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
            match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => {
                    assert_eq!(sync.agents.len(), 1);
                    assert_eq!(sync.agents[0].name, "agent-a");
                    assert_eq!(
                        sync.agents[0].session_ref.as_deref(),
                        Some("session-discovered")
                    );
                }
                other => panic!("expected inventory.sync, got {other:?}"),
            }
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();
        assert_eq!(event_rx.recv().await.unwrap(), FleetControlEvent::Connected);

        let (reply_tx, reply_rx) = oneshot::channel();
        command_tx
            .send(FleetControlCommand::RegisterAgent {
                request: AgentRegister {
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    name: "agent-a".to_string(),
                    invocation_id: Some("inv-1".to_string()),
                    session_ref: Some("session-1".to_string()),
                    resumable: Some(true),
                },
                reply: reply_tx,
            })
            .await
            .unwrap();
        let token = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            token,
            AgentRegistrationToken {
                name: "agent-a".to_string(),
                agent_id: "agt-1".to_string(),
                token: "at_test".to_string(),
            }
        );
        command_tx
            .send(FleetControlCommand::UpdateInventory(vec![InventoryAgent {
                agent_id: "agt-1".to_string(),
                name: "agent-a".to_string(),
                invocation_id: Some("inv-1".to_string()),
                session_ref: Some("session-discovered".to_string()),
            }]))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    #[tokio::test]
    async fn node_control_agent_register_timeout_late_success_deregisters() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let (register_seen_tx, register_seen_rx) = oneshot::channel();
        let (send_late_reply_tx, send_late_reply_rx) = oneshot::channel();

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();

            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));
            let register_id = match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::AgentRegister(request) => {
                    let register_id = request.id.clone().expect("agent.register id");
                    assert_eq!(request.name, "agent-a");
                    register_seen_tx.send(register_id.clone()).unwrap();
                    register_id
                }
                other => panic!("expected agent.register, got {other:?}"),
            };

            send_late_reply_rx.await.unwrap();
            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::Reply(crate::fleet_wire::Reply {
                    v: FLEET_WIRE_VERSION,
                    id: register_id.clone(),
                    ok: true,
                    data: json!({
                        "name": "agent-a",
                        "agent_id": "agt-late",
                        "token": "at_late"
                    }),
                }))
                .unwrap(),
            ))
            .await
            .unwrap();

            match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::AgentDeregister(deregister) => {
                    assert_eq!(deregister.id.as_deref(), Some(register_id.as_str()));
                    assert_eq!(deregister.agent_id, "agt-late");
                    assert_eq!(deregister.name.as_deref(), Some("agent-a"));
                }
                other => panic!("expected compensating agent.deregister, got {other:?}"),
            }
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();
        assert_eq!(event_rx.recv().await.unwrap(), FleetControlEvent::Connected);

        let (reply_tx, reply_rx) = oneshot::channel();
        command_tx
            .send(FleetControlCommand::RegisterAgent {
                request: AgentRegister {
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    name: "agent-a".to_string(),
                    invocation_id: Some("inv-1".to_string()),
                    session_ref: None,
                    resumable: None,
                },
                reply: reply_tx,
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), register_seen_rx)
            .await
            .unwrap()
            .unwrap();
        drop(reply_rx);
        send_late_reply_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    #[tokio::test]
    async fn node_control_deregister_sends_node_deregister() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));
            assert_eq!(
                next_non_heartbeat_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeDeregister(NodeDeregister {
                    v: FLEET_WIRE_VERSION,
                    id: None
                })
            );
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();
        assert_eq!(event_rx.recv().await.unwrap(), FleetControlEvent::Connected);
        command_tx
            .send(FleetControlCommand::DeregisterNode)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    #[tokio::test]
    async fn node_control_reconnect_sends_inventory_sync() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, _event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));
            ws.close(None).await.unwrap();

            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            match next_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => {
                    assert_eq!(sync.agents.len(), 1);
                    assert_eq!(sync.agents[0].name, "agent-a");
                }
                other => panic!("expected inventory.sync, got {other:?}"),
            }
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();
        command_tx
            .send(FleetControlCommand::UpdateInventory(vec![InventoryAgent {
                agent_id: "agt-1".to_string(),
                name: "agent-a".to_string(),
                invocation_id: Some("inv-1".to_string()),
                session_ref: Some("session-1".to_string()),
            }]))
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(8), server)
            .await
            .unwrap()
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    async fn next_node_to_server<S>(ws: &mut S) -> BrokerToRelaycast
    where
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + Unpin,
    {
        loop {
            if let Message::Text(text) = ws.next().await.unwrap().unwrap() {
                return serde_json::from_str(&text).unwrap();
            }
        }
    }

    async fn next_non_heartbeat_node_to_server<S>(ws: &mut S) -> BrokerToRelaycast
    where
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + Unpin,
    {
        loop {
            let message = next_node_to_server(ws).await;
            if !matches!(message, BrokerToRelaycast::NodeHeartbeat(_)) {
                return message;
            }
        }
    }

    fn test_manifest() -> NodeManifest {
        NodeManifest {
            name: "builder".to_string(),
            node_id: None,
            capabilities: vec![crate::protocol::NodeCapabilityManifest {
                name: "run:test".to_string(),
                kind: Some("action".to_string()),
                metadata: Some(HashMap::from([(
                    "suite".to_string(),
                    Value::String("unit".to_string()),
                )])),
            }],
            max_agents: Some(4),
            tags: Some(vec!["test".to_string()]),
            version: Some("sidecar/test".to_string()),
        }
    }
}
