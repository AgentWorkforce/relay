//! Replicas launches through Cloud; provider credentials never enter the desktop.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReplicasEnvironment {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReplicasEnvironments {
    pub environments: Vec<ReplicasEnvironment>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReplicasSpawnParams {
    pub client_request_id: String,
    pub environment_id: String,
    pub name: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coding_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_to: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReplicasSpawnGetParams {
    pub spawn_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReplicasBinding {
    pub state: String,
    pub agent: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReplicasSpawn {
    pub spawn_id: String,
    pub replica_id: Option<String>,
    pub chat_id: Option<String>,
    pub status: String,
    pub binding: ReplicasBinding,
    pub error: Option<String>,
    pub outcome_unknown: Option<bool>,
    pub recovery: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReplicasReleased {
    pub spawn_id: String,
    pub replica_id: Option<String>,
    pub released: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spawn_omits_unspecified_provider_options() {
        let request: ReplicasSpawnParams = serde_json::from_value(serde_json::json!({
            "client_request_id":"op-1", "environment_id":"env", "name":"review", "task":"review"
        }))
        .unwrap();
        let value = serde_json::to_value(request).unwrap();
        assert!(value.get("coding_agent").is_none());
        assert!(value.get("model").is_none());
    }
    #[test]
    fn uncertain_launch_does_not_read_as_bound() {
        let value = serde_json::json!({"spawn_id":"op", "replica_id":null,"chat_id":null,
            "status":"creating","binding":{"state":"pending"},"outcome_unknown":true,
            "recovery":"Inspect the replica before retrying."});
        let result: ReplicasSpawn = serde_json::from_value(value).unwrap();
        assert_eq!(result.outcome_unknown, Some(true));
        assert_eq!(result.binding.state, "pending");
        assert!(result.binding.agent.is_none());
    }
}
