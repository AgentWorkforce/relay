use std::collections::BTreeMap;

use serde::{
    de::{self, Deserializer},
    ser, Deserialize, Serialize, Serializer,
};
use serde_json::Value;

pub const FLEET_WIRE_VERSION: FleetWireVersion = FleetWireVersion;
/// Node capability that negotiates `delivery_ack_seq` in `agent.register`
/// replies. It is declared as capacity so older engines never materialize it
/// as an invokable action.
pub const DELIVERY_CURSOR_CAPABILITY: &str = "relay:delivery-cursor-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FleetWireVersion;

impl FleetWireVersion {
    pub const VALUE: u32 = 1;

    pub fn as_u32(self) -> u32 {
        Self::VALUE
    }
}

impl Serialize for FleetWireVersion {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u32(Self::VALUE)
    }
}

impl<'de> Deserialize<'de> for FleetWireVersion {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = u32::deserialize(deserializer)?;
        if value == Self::VALUE {
            Ok(Self)
        } else {
            Err(de::Error::custom(format!(
                "expected fleet wire version {}",
                Self::VALUE
            )))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMode {
    Wait,
    Steer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FleetCapability {
    pub name: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind: Option<String>,
    /// `action` capability opting into a workspace-global alias claiming this name.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub global: Option<bool>,
    /// `action` capability opting into the offline queue when its provider is down.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub queue: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// Provider identity carried on connection-scoped node frames. `name` is the
/// provider's stable identity — persistence, capability-conflict checks, and the
/// engine's routing key. `instance_id` is the connection epoch: re-registering
/// the same name with a fresh instance replaces the previous attachment
/// (reconnect), while a name whose current instance is still connected is
/// rejected as a duplicate process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FleetProviderIdentity {
    pub name: String,
    pub instance_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeRegister {
    pub v: FleetWireVersion,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    pub name: String,
    pub node_id: String,
    // Absent means the synthetic `default` provider; the broker always sends its
    // own `{ name: "broker", instance_id }` identity.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub provider: Option<FleetProviderIdentity>,
    pub capabilities: Vec<FleetCapability>,
    pub max_agents: u32,
    pub tags: Vec<String>,
    pub version: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub machine_id: Option<String>,
    pub resume_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeHeartbeat {
    pub v: FleetWireVersion,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    // Heartbeats are provider-scoped by connection; absent means the synthetic
    // `default` provider. The broker always sends its `{ name: "broker",
    // instance_id }` identity, and load/active_agents/handlers_live describe it.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub provider: Option<FleetProviderIdentity>,
    // Roster snapshot carried for liveness: lets the relaycast engine refresh
    // this node's descriptor (name/capabilities/max_agents/version) from the
    // steady-state heartbeat without waiting for a fresh node.register — e.g.
    // after an engine restart where the broker keeps heartbeating an
    // already-registered node. `max_agents` here is the SAME authoritative value
    // the broker reports via node.register (sourced from the active
    // FleetLoadSnapshot), so the engine never sees a divergent capacity.
    //
    // NOTE: `last_heartbeat_at` is intentionally NOT a field — receipt time is
    // the engine's server-stamped single source of truth for liveness.
    pub name: String,
    pub node_id: String,
    pub capabilities: Vec<FleetCapability>,
    pub max_agents: u32,
    pub version: String,
    // Capacity utilization is undefined for an unbounded provider
    // (`max_agents == 0`). The wire type accepts an omitted/null value for the
    // coordinated relaycast#307 rollout, but producers must keep sending the
    // legacy numeric value until compatible engines are deployed; older engines
    // reject the entire heartbeat when `load` is absent.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_finite_nonnegative_f64",
        serialize_with = "serialize_optional_finite_nonnegative_f64",
        skip_serializing_if = "Option::is_none"
    )]
    pub load: Option<f64>,
    pub active_agents: u32,
    pub handlers_live: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeDeregister {
    pub v: FleetWireVersion,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    // Removes this provider's attachment and persisted capability set; absent
    // means the synthetic `default` provider.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub provider: Option<FleetProviderIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentRegister {
    pub v: FleetWireVersion,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    pub name: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub invocation_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_ref: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub resumable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentDeregister {
    pub v: FleetWireVersion,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    pub agent_id: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryAck {
    pub v: FleetWireVersion,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    pub agent: String,
    pub up_to_seq: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActionResult {
    pub v: FleetWireVersion,
    pub id: Option<String>,
    pub invocation_id: String,
    pub result: ActionResultPayload,
}

impl Serialize for ActionResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        ActionResultWire::from(self).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ActionResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        ActionResultWire::deserialize(deserializer)?
            .try_into()
            .map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionResultWire {
    pub v: FleetWireVersion,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    pub invocation_id: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub output: Option<Value>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub error: Option<String>,
}

fn deserialize_optional_presence<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn deserialize_optional_finite_nonnegative_f64<'de, D>(
    deserializer: D,
) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer)?
        .map(validate_finite_nonnegative_f64)
        .transpose()
        .map_err(de::Error::custom)
}

fn serialize_finite_nonnegative_f64<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    validate_finite_nonnegative_f64(*value).map_err(ser::Error::custom)?;
    serializer.serialize_f64(*value)
}

fn serialize_optional_finite_nonnegative_f64<S>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(value) => serialize_finite_nonnegative_f64(value, serializer),
        None => serializer.serialize_none(),
    }
}

fn validate_finite_nonnegative_f64(value: f64) -> Result<f64, &'static str> {
    if !value.is_finite() {
        return Err("load must be finite");
    }
    if value < 0.0 {
        return Err("load must be nonnegative");
    }
    if value > 1.0 {
        return Err("load must be at most 1");
    }
    Ok(value)
}

impl From<&ActionResult> for ActionResultWire {
    fn from(value: &ActionResult) -> Self {
        match &value.result {
            ActionResultPayload::Output(output) => Self {
                v: value.v,
                id: value.id.clone(),
                invocation_id: value.invocation_id.clone(),
                output: Some(output.output.clone()),
                error: None,
            },
            ActionResultPayload::Error(error) => Self {
                v: value.v,
                id: value.id.clone(),
                invocation_id: value.invocation_id.clone(),
                output: None,
                error: Some(error.error.clone()),
            },
        }
    }
}

impl TryFrom<ActionResultWire> for ActionResult {
    type Error = String;

    fn try_from(value: ActionResultWire) -> Result<Self, Self::Error> {
        let result = match (value.output, value.error) {
            (Some(output), None) => ActionResultPayload::Output(ActionResultOutput { output }),
            (None, Some(error)) => ActionResultPayload::Error(ActionResultError { error }),
            _ => {
                return Err("action.result must include exactly one of output or error".to_string())
            }
        };

        Ok(Self {
            v: value.v,
            id: value.id,
            invocation_id: value.invocation_id,
            result,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ActionResultPayload {
    Output(ActionResultOutput),
    Error(ActionResultError),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionResultOutput {
    pub output: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionResultError {
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InventoryAgent {
    pub agent_id: String,
    pub name: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub invocation_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub session_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InventorySync {
    pub v: FleetWireVersion,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    pub agents: Vec<InventoryAgent>,
}

// Inbound (server -> broker): intentionally NOT `deny_unknown_fields`. A future
// top-level field added by the engine must not make `from_str` fail, or the
// frame is dropped before a `delivery.ack` is sent and the engine redelivers it
// forever. Forward compatibility wins over strictness on inbound frames.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Deliver {
    pub v: FleetWireVersion,
    pub agent: String,
    pub agent_id: String,
    pub delivery_id: String,
    pub msg_id: String,
    pub seq: u64,
    pub mode: DeliveryMode,
    pub payload: Value,
}

// Inbound (server -> broker): intentionally NOT `deny_unknown_fields` for the
// same forward-compatibility reason as `Deliver` above.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionInvoke {
    pub v: FleetWireVersion,
    pub invocation_id: String,
    pub action: String,
    pub input: Value,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ping {
    pub v: FleetWireVersion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub v: FleetWireVersion,
    pub id: String,
    #[serde(
        deserialize_with = "deserialize_true_bool",
        serialize_with = "serialize_true_bool"
    )]
    pub ok: bool,
    pub data: Value,
}

impl Reply {
    pub fn validate_agent_register_data(&self) -> serde_json::Result<AgentRegisterReplyData> {
        validate_agent_register_reply_data(&self.data)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentRegisterReplyData {
    pub agent_id: String,
    pub token: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    /// Relaycast's authoritative cumulative delivery cursor for this agent.
    /// Present only when the node advertised the cursor-handshake capability;
    /// absent keeps replies compatible with older engines.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_presence",
        skip_serializing_if = "Option::is_none"
    )]
    pub delivery_ack_seq: Option<u64>,
}

pub fn validate_agent_register_reply_data(
    data: &Value,
) -> serde_json::Result<AgentRegisterReplyData> {
    serde_json::from_value(data.clone())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Error {
    pub v: FleetWireVersion,
    pub id: String,
    #[serde(
        deserialize_with = "deserialize_false_bool",
        serialize_with = "serialize_false_bool"
    )]
    pub ok: bool,
    pub code: String,
    pub message: String,
}

fn deserialize_true_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = bool::deserialize(deserializer)?;
    if value {
        Ok(value)
    } else {
        Err(de::Error::custom("expected ok to be true"))
    }
}

fn serialize_true_bool<S>(value: &bool, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if *value {
        serializer.serialize_bool(*value)
    } else {
        Err(ser::Error::custom("expected ok to be true"))
    }
}

fn deserialize_false_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = bool::deserialize(deserializer)?;
    if value {
        Err(de::Error::custom("expected ok to be false"))
    } else {
        Ok(value)
    }
}

fn serialize_false_bool<S>(value: &bool, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if *value {
        Err(ser::Error::custom("expected ok to be false"))
    } else {
        serializer.serialize_bool(*value)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum NodeToServer {
    #[serde(rename = "node.register")]
    NodeRegister(NodeRegister),
    #[serde(rename = "node.heartbeat")]
    NodeHeartbeat(NodeHeartbeat),
    #[serde(rename = "node.deregister")]
    NodeDeregister(NodeDeregister),
    #[serde(rename = "agent.register")]
    AgentRegister(AgentRegister),
    #[serde(rename = "agent.deregister")]
    AgentDeregister(AgentDeregister),
    #[serde(rename = "delivery.ack")]
    DeliveryAck(DeliveryAck),
    #[serde(rename = "action.result")]
    ActionResult(ActionResult),
    #[serde(rename = "inventory.sync")]
    InventorySync(InventorySync),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerToNode {
    #[serde(rename = "deliver")]
    Deliver(Deliver),
    #[serde(rename = "action.invoke")]
    ActionInvoke(ActionInvoke),
    #[serde(rename = "ping")]
    Ping(Ping),
    #[serde(rename = "reply")]
    Reply(Reply),
    #[serde(rename = "error")]
    Error(Error),
}

pub type BrokerToRelaycast = NodeToServer;
pub type RelaycastToBroker = ServerToNode;

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{
        validate_agent_register_reply_data, validate_finite_nonnegative_f64, ActionResult,
        ActionResultError, ActionResultPayload, AgentRegister, BrokerToRelaycast, Deliver,
        DeliveryMode, Error, FleetCapability, NodeHeartbeat, RelaycastToBroker, Reply,
        FLEET_WIRE_VERSION,
    };

    #[test]
    fn skips_absent_optional_fields() {
        let msg = BrokerToRelaycast::AgentRegister(AgentRegister {
            v: FLEET_WIRE_VERSION,
            id: None,
            name: "codex-1".to_string(),
            invocation_id: None,
            session_ref: None,
            resumable: None,
        });

        let value = serde_json::to_value(msg).unwrap();
        assert_eq!(
            value,
            json!({
                "type": "agent.register",
                "v": 1,
                "name": "codex-1"
            })
        );
    }

    #[test]
    fn action_result_allows_error_payloads() {
        let msg = BrokerToRelaycast::ActionResult(ActionResult {
            v: FLEET_WIRE_VERSION,
            id: None,
            invocation_id: "inv_2".to_string(),
            result: ActionResultPayload::Error(ActionResultError {
                error: "handler_unavailable".to_string(),
            }),
        });

        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: BrokerToRelaycast = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn action_result_requires_exactly_one_result_field() {
        let missing = json!({
            "type": "action.result",
            "v": 1,
            "invocation_id": "inv_2"
        });
        assert!(serde_json::from_value::<BrokerToRelaycast>(missing).is_err());

        let ambiguous = json!({
            "type": "action.result",
            "v": 1,
            "invocation_id": "inv_2",
            "output": null,
            "error": "handler_unavailable"
        });
        assert!(serde_json::from_value::<BrokerToRelaycast>(ambiguous).is_err());
    }

    #[test]
    fn node_heartbeat_rejects_invalid_loads() {
        let negative = json!({
            "type": "node.heartbeat",
            "v": 1,
            "name": "builder-1",
            "node_id": "node_1",
            "capabilities": [],
            "max_agents": 1,
            "version": "relay-broker/test",
            "load": -0.1,
            "active_agents": 0,
            "handlers_live": true
        });
        assert!(serde_json::from_value::<BrokerToRelaycast>(negative).is_err());

        let over_capacity = json!({
            "type": "node.heartbeat",
            "v": 1,
            "name": "builder-1",
            "node_id": "node_1",
            "capabilities": [],
            "max_agents": 1,
            "version": "relay-broker/test",
            "load": 1.1,
            "active_agents": 2,
            "handlers_live": true
        });
        assert!(serde_json::from_value::<BrokerToRelaycast>(over_capacity).is_err());

        for load in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(
                validate_finite_nonnegative_f64(load).is_err(),
                "expected load {load:?} to be rejected"
            );
        }

        for load in [0.0, 1.0] {
            assert_eq!(
                validate_finite_nonnegative_f64(load),
                Ok(load),
                "expected load {load:?} to be accepted"
            );
            let boundary = json!({
                "type": "node.heartbeat",
                "v": 1,
                "name": "builder-1",
                "node_id": "node_1",
                "capabilities": [],
                "max_agents": 1,
                "version": "relay-broker/test",
                "load": load,
                "active_agents": 1,
                "handlers_live": true
            });
            let decoded: BrokerToRelaycast = serde_json::from_value(boundary)
                .unwrap_or_else(|err| panic!("expected load {load:?} to decode: {err}"));
            match decoded {
                BrokerToRelaycast::NodeHeartbeat(hb) => assert_eq!(hb.load, Some(load)),
                other => panic!("expected NodeHeartbeat, got {other:?}"),
            }
        }

        let invalid = BrokerToRelaycast::NodeHeartbeat(NodeHeartbeat {
            v: FLEET_WIRE_VERSION,
            id: None,
            provider: None,
            name: "builder-1".to_string(),
            node_id: "node_1".to_string(),
            capabilities: vec![],
            max_agents: 1,
            version: "relay-broker/test".to_string(),
            load: Some(f64::INFINITY),
            active_agents: 0,
            handlers_live: true,
        });
        assert!(serde_json::to_value(invalid).is_err());
    }

    #[test]
    fn node_heartbeat_carries_roster_snapshot() {
        // The heartbeat carries the node roster snapshot (name, node_id,
        // capabilities, max_agents, version) ALONGSIDE live load/liveness, so
        // the relaycast engine can refresh this node's descriptor from the
        // steady-state heartbeat without a fresh `node.register` (e.g. after an
        // engine restart). `last_heartbeat_at` is intentionally ABSENT — the
        // engine stamps receipt time server-side as the single source of truth
        // for liveness. This guards the exact wire contract the engine accepts.
        let msg = BrokerToRelaycast::NodeHeartbeat(NodeHeartbeat {
            v: FLEET_WIRE_VERSION,
            id: None,
            provider: Some(super::FleetProviderIdentity {
                name: "broker".to_string(),
                instance_id: "inst_1".to_string(),
            }),
            name: "builder-1".to_string(),
            node_id: "node_1".to_string(),
            capabilities: vec![FleetCapability {
                name: "spawn:codex".to_string(),
                kind: Some("capacity".to_string()),
                global: None,
                queue: None,
                metadata: None,
            }],
            max_agents: 4,
            version: "relay-broker/test".to_string(),
            load: Some(0.25),
            active_agents: 1,
            handlers_live: true,
        });

        let value = serde_json::to_value(msg).unwrap();
        assert_eq!(
            value,
            json!({
                "type": "node.heartbeat",
                "v": 1,
                "provider": { "name": "broker", "instance_id": "inst_1" },
                "name": "builder-1",
                "node_id": "node_1",
                "capabilities": [
                    {
                        "name": "spawn:codex",
                        "kind": "capacity"
                    }
                ],
                "max_agents": 4,
                "version": "relay-broker/test",
                "load": 0.25,
                "active_agents": 1,
                "handlers_live": true
            })
        );
        // last_heartbeat_at must NOT appear on the wire.
        assert!(
            value.get("last_heartbeat_at").is_none(),
            "broker must not send last_heartbeat_at; the engine stamps it server-side"
        );
    }

    #[test]
    fn node_heartbeat_omits_unreported_load() {
        let msg = BrokerToRelaycast::NodeHeartbeat(NodeHeartbeat {
            v: FLEET_WIRE_VERSION,
            id: None,
            provider: None,
            name: "unbounded-builder".to_string(),
            node_id: "node_unbounded".to_string(),
            capabilities: vec![],
            max_agents: 0,
            version: "relay-broker/test".to_string(),
            load: None,
            active_agents: 25,
            handlers_live: true,
        });

        let value = serde_json::to_value(msg).unwrap();
        assert_eq!(value.get("load"), None);
        assert_eq!(value["active_agents"], 25);
        assert_eq!(value["max_agents"], 0);

        // Decode side: a heartbeat with the `load` field absent entirely, and
        // one with an explicit `"load": null` (e.g. from a relay that
        // round-trips the omitted value), must both decode to `load: None`.
        let missing_field = json!({
            "type": "node.heartbeat",
            "v": 1,
            "name": "unbounded-builder",
            "node_id": "node_unbounded",
            "capabilities": [],
            "max_agents": 0,
            "version": "relay-broker/test",
            "active_agents": 25,
            "handlers_live": true
        });
        let decoded: BrokerToRelaycast = serde_json::from_value(missing_field).unwrap();
        match decoded {
            BrokerToRelaycast::NodeHeartbeat(hb) => {
                assert_eq!(hb.load, None);
                assert_eq!(hb.active_agents, 25);
                assert_eq!(hb.max_agents, 0);
            }
            other => panic!("expected NodeHeartbeat, got {other:?}"),
        }

        let explicit_null = json!({
            "type": "node.heartbeat",
            "v": 1,
            "name": "unbounded-builder",
            "node_id": "node_unbounded",
            "capabilities": [],
            "max_agents": 0,
            "version": "relay-broker/test",
            "load": null,
            "active_agents": 25,
            "handlers_live": true
        });
        let decoded: BrokerToRelaycast = serde_json::from_value(explicit_null).unwrap();
        match decoded {
            BrokerToRelaycast::NodeHeartbeat(hb) => assert_eq!(hb.load, None),
            other => panic!("expected NodeHeartbeat, got {other:?}"),
        }
    }

    #[test]
    fn node_register_absent_resume_cursor_serializes_as_null() {
        let decoded: BrokerToRelaycast = serde_json::from_value(json!({
            "type": "node.register",
            "v": 1,
            "name": "builder-1",
            "node_id": "node_1",
            "capabilities": [],
            "max_agents": 1,
            "tags": [],
            "version": "relay-broker/test"
        }))
        .unwrap();

        let encoded = serde_json::to_value(decoded).unwrap();
        assert_eq!(
            encoded,
            json!({
                "type": "node.register",
                "v": 1,
                "name": "builder-1",
                "node_id": "node_1",
                "capabilities": [],
                "max_agents": 1,
                "tags": [],
                "version": "relay-broker/test",
                "resume_cursor": null
            })
        );
    }

    #[test]
    fn optional_fields_reject_explicit_nulls() {
        let null_request_id = json!({
            "type": "agent.register",
            "v": 1,
            "id": null,
            "name": "codex-1"
        });
        assert!(serde_json::from_value::<BrokerToRelaycast>(null_request_id).is_err());

        let null_invocation = json!({
            "type": "agent.register",
            "v": 1,
            "name": "codex-1",
            "invocation_id": null
        });
        assert!(serde_json::from_value::<BrokerToRelaycast>(null_invocation).is_err());

        let null_error = json!({
            "type": "action.result",
            "v": 1,
            "invocation_id": "inv_2",
            "output": null,
            "error": null
        });
        assert!(serde_json::from_value::<BrokerToRelaycast>(null_error).is_err());
    }

    #[test]
    fn response_frames_enforce_ok_literal() {
        let reply: RelaycastToBroker = serde_json::from_value(json!({
            "type": "reply",
            "v": 1,
            "id": "req_1",
            "ok": true,
            "data": {
                "agent_id": "agt_1"
            }
        }))
        .unwrap();
        assert_eq!(serde_json::to_value(&reply).unwrap()["ok"], true);

        let error: RelaycastToBroker = serde_json::from_value(json!({
            "type": "error",
            "v": 1,
            "id": "req_2",
            "ok": false,
            "code": "node_name_conflict",
            "message": "duplicate"
        }))
        .unwrap();
        assert_eq!(serde_json::to_value(&error).unwrap()["ok"], false);

        let wrong_reply_ok = json!({
            "type": "reply",
            "v": 1,
            "id": "req_1",
            "ok": false,
            "data": null
        });
        assert!(serde_json::from_value::<RelaycastToBroker>(wrong_reply_ok).is_err());

        let wrong_error_ok = json!({
            "type": "error",
            "v": 1,
            "id": "req_2",
            "ok": true,
            "code": "node_name_conflict",
            "message": "duplicate"
        });
        assert!(serde_json::from_value::<RelaycastToBroker>(wrong_error_ok).is_err());

        let invalid_reply = RelaycastToBroker::Reply(Reply {
            v: FLEET_WIRE_VERSION,
            id: "req_1".to_string(),
            ok: false,
            data: Value::Null,
        });
        assert!(serde_json::to_value(invalid_reply).is_err());

        let invalid_error = RelaycastToBroker::Error(Error {
            v: FLEET_WIRE_VERSION,
            id: "req_2".to_string(),
            ok: true,
            code: "node_name_conflict".to_string(),
            message: "duplicate".to_string(),
        });
        assert!(serde_json::to_value(invalid_error).is_err());
    }

    #[test]
    fn validates_agent_register_reply_data_at_use() {
        let reply: Reply = serde_json::from_value(json!({
            "v": 1,
            "id": "req_agent_register_001",
            "ok": true,
            "data": {
                "agent_id": "agt_1",
                "token": "at_live_1",
                "name": "codex-builder-1",
                "delivery_ack_seq": 42
            }
        }))
        .unwrap();

        let data = reply.validate_agent_register_data().unwrap();
        assert_eq!(data.agent_id, "agt_1");
        assert_eq!(data.token, "at_live_1");
        assert_eq!(data.name.as_deref(), Some("codex-builder-1"));
        assert_eq!(data.delivery_ack_seq, Some(42));

        let without_name = validate_agent_register_reply_data(&json!({
            "agent_id": "agt_1",
            "token": "at_live_1"
        }))
        .unwrap();
        assert_eq!(without_name.name, None);
        assert_eq!(without_name.delivery_ack_seq, None);

        let missing_token = json!({
            "agent_id": "agt_1",
            "name": "codex-builder-1"
        });
        assert!(validate_agent_register_reply_data(&missing_token).is_err());

        let extra_field = json!({
            "agent_id": "agt_1",
            "token": "at_live_1",
            "session_ref": "pty://builder-1/sessions/codex-builder-1"
        });
        assert!(validate_agent_register_reply_data(&extra_field).is_err());
    }

    #[test]
    fn rejects_unsupported_wire_versions() {
        let unsupported = json!({
            "type": "ping",
            "v": 2
        });

        assert!(serde_json::from_value::<RelaycastToBroker>(unsupported).is_err());
    }

    #[test]
    fn deliver_accepts_open_payloads() {
        let msg = RelaycastToBroker::Deliver(Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "codex-1".to_string(),
            agent_id: "codex-1-id".to_string(),
            delivery_id: "delivery_1".to_string(),
            msg_id: "msg_1".to_string(),
            seq: 42,
            mode: DeliveryMode::Wait,
            payload: json!({
                "text": "ship it",
                "metadata": {
                    "channel": "general"
                }
            }),
        });

        let value: Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(value["payload"]["metadata"]["channel"], "general");
        let decoded: RelaycastToBroker = serde_json::from_value(value).unwrap();
        assert_eq!(decoded, msg);
    }
}
