//! Narrow native spawn controls; credentials and arbitrary HTTP are never part of this contract.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnInvokeParams {
    pub caller_name: String,
    pub node_id: String,
    pub node_name: String,
    pub name: String,
    pub harness: String,
    pub task: String,
    pub directory: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnInvocationParams {
    pub caller_name: String,
    pub action: SpawnControlAction,
    pub invocation_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpawnControlAction {
    Spawn,
    Release,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnReleaseParams {
    pub caller_name: String,
    pub node_id: String,
    pub node_name: String,
    pub name: String,
    pub expected_agent_id: String,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct SpawnTargets {
    pub targets: Vec<SpawnControlTarget>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct SpawnControlTarget {
    pub id: String,
    pub name: String,
    pub live: bool,
    pub handlers_live: bool,
    pub stale: bool,
    pub capabilities: Vec<String>,
    pub active_agents: u64,
    pub reserved_agents: u64,
    pub max_agents: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct SpawnControlInvocation {
    pub id: String,
    /// Set only from this core's same-workspace registration for this exact spawn invocation.
    pub agent_id: Option<String>,
    pub status: String,
    pub node_id: Option<String>,
    pub name: Option<String>,
    pub spawned: bool,
    pub ready: bool,
    pub task_unconfirmed: bool,
    /// A bounded machine code, never provider error text or arbitrary output.
    pub error_code: Option<String>,
}
