use serde::{
    de::{self, Deserializer},
    ser, Deserialize, Serialize, Serializer,
};
use serde_json::Value;

pub const FLEET_WIRE_VERSION: FleetWireVersion = FleetWireVersion;

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
pub struct NodeRegister {
    pub v: FleetWireVersion,
    pub name: String,
    pub node_id: String,
    pub capabilities: Vec<String>,
    pub max_agents: u32,
    pub tags: Vec<String>,
    pub version: String,
    pub resume_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeHeartbeat {
    pub v: FleetWireVersion,
    #[serde(
        deserialize_with = "deserialize_finite_nonnegative_f64",
        serialize_with = "serialize_finite_nonnegative_f64"
    )]
    pub load: f64,
    pub active_agents: u32,
    pub handlers_live: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeDeregister {
    pub v: FleetWireVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentRegister {
    pub v: FleetWireVersion,
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
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryAck {
    pub v: FleetWireVersion,
    pub agent: String,
    pub up_to_seq: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActionResult {
    pub v: FleetWireVersion,
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

fn deserialize_finite_nonnegative_f64<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    validate_finite_nonnegative_f64(value).map_err(de::Error::custom)
}

fn serialize_finite_nonnegative_f64<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    validate_finite_nonnegative_f64(*value).map_err(ser::Error::custom)?;
    serializer.serialize_f64(*value)
}

fn validate_finite_nonnegative_f64(value: f64) -> Result<f64, &'static str> {
    if !value.is_finite() {
        return Err("load must be finite");
    }
    if value < 0.0 {
        return Err("load must be nonnegative");
    }
    Ok(value)
}

impl From<&ActionResult> for ActionResultWire {
    fn from(value: &ActionResult) -> Self {
        match &value.result {
            ActionResultPayload::Output(output) => Self {
                v: value.v,
                invocation_id: value.invocation_id.clone(),
                output: Some(output.output.clone()),
                error: None,
            },
            ActionResultPayload::Error(error) => Self {
                v: value.v,
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
    pub agents: Vec<InventoryAgent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Deliver {
    pub v: FleetWireVersion,
    pub agent: String,
    pub msg_id: String,
    pub seq: u64,
    pub mode: DeliveryMode,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionInvoke {
    pub v: FleetWireVersion,
    pub invocation_id: String,
    pub action: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ping {
    pub v: FleetWireVersion,
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
}

pub type BrokerToRelaycast = NodeToServer;
pub type RelaycastToBroker = ServerToNode;

#[cfg(test)]
mod tests {
    use serde::de::{value::Error as DeError, IntoDeserializer};
    use serde_json::{json, Value};

    use super::{
        deserialize_finite_nonnegative_f64, ActionResult, ActionResultError, ActionResultPayload,
        AgentRegister, BrokerToRelaycast, Deliver, DeliveryMode, NodeHeartbeat, RelaycastToBroker,
        FLEET_WIRE_VERSION,
    };

    #[test]
    fn skips_absent_optional_fields() {
        let msg = BrokerToRelaycast::AgentRegister(AgentRegister {
            v: FLEET_WIRE_VERSION,
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
            "load": -0.1,
            "active_agents": 0,
            "handlers_live": true
        });
        assert!(serde_json::from_value::<BrokerToRelaycast>(negative).is_err());

        for load in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let result: Result<f64, DeError> =
                deserialize_finite_nonnegative_f64(load.into_deserializer());
            assert!(result.is_err(), "expected load {load:?} to be rejected");
        }

        let invalid = BrokerToRelaycast::NodeHeartbeat(NodeHeartbeat {
            v: FLEET_WIRE_VERSION,
            load: f64::INFINITY,
            active_agents: 0,
            handlers_live: true,
        });
        assert!(serde_json::to_value(invalid).is_err());
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
