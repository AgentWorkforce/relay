//! Narrow native spawn controls; credentials and arbitrary HTTP are never part of this contract.
use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// `Debug` is written by hand (below) so `caller_secret` never prints.
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnInvokeParams {
    pub caller_name: String,
    /// A secret that names a caller the core's spawn caller plugin
    /// vouches for instead of a session registration; absent for a session
    /// caller. A core without the plugin refuses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller_secret: Option<String>,
    pub node_id: String,
    pub node_name: String,
    pub name: String,
    pub harness: String,
    pub task: String,
    pub directory: String,
    pub idempotency_key: String,
}

// `Debug` is written by hand (below) so `caller_secret` never prints.
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnInvocationParams {
    pub caller_name: String,
    /// A secret that names a caller the core's spawn caller plugin
    /// vouches for instead of a session registration; absent for a session
    /// caller. A core without the plugin refuses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller_secret: Option<String>,
    pub action: SpawnControlAction,
    pub invocation_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpawnControlAction {
    Spawn,
    Release,
}

// `Debug` is written by hand (below) so `caller_secret` never prints.
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnReleaseParams {
    pub caller_name: String,
    /// A secret that names a caller the core's spawn caller plugin
    /// vouches for instead of a session registration; absent for a session
    /// caller. A core without the plugin refuses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller_secret: Option<String>,
    pub node_id: String,
    pub node_name: String,
    pub name: String,
    pub expected_agent_id: String,
    pub idempotency_key: String,
}

/// Shows whether a `caller_secret` was given, never its value.
struct RedactedSecret<'a>(&'a Option<String>);

impl fmt::Debug for RedactedSecret<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Some(_) => f.write_str("\"<redacted>\""),
            None => f.write_str("None"),
        }
    }
}

impl fmt::Debug for SpawnInvokeParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SpawnInvokeParams")
            .field("caller_name", &self.caller_name)
            .field("caller_secret", &RedactedSecret(&self.caller_secret))
            .field("node_id", &self.node_id)
            .field("node_name", &self.node_name)
            .field("name", &self.name)
            .field("harness", &self.harness)
            .field("task", &self.task)
            .field("directory", &self.directory)
            .field("idempotency_key", &self.idempotency_key)
            .finish()
    }
}

impl fmt::Debug for SpawnInvocationParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SpawnInvocationParams")
            .field("caller_name", &self.caller_name)
            .field("caller_secret", &RedactedSecret(&self.caller_secret))
            .field("action", &self.action)
            .field("invocation_id", &self.invocation_id)
            .finish()
    }
}

impl fmt::Debug for SpawnReleaseParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SpawnReleaseParams")
            .field("caller_name", &self.caller_name)
            .field("caller_secret", &RedactedSecret(&self.caller_secret))
            .field("node_id", &self.node_id)
            .field("node_name", &self.node_name)
            .field("name", &self.name)
            .field("expected_agent_id", &self.expected_agent_id)
            .field("idempotency_key", &self.idempotency_key)
            .finish()
    }
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
    /// Explicit proof that a completed release removed the exact agent.
    pub released: bool,
    pub task_unconfirmed: bool,
    /// A bounded machine code, never provider error text or arbitrary output.
    pub error_code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "svc-secret-value-7f3a9c";

    #[test]
    fn debug_never_prints_the_caller_secret() {
        let invoke: SpawnInvokeParams = serde_json::from_value(serde_json::json!({
            "caller_name": "flows", "caller_secret": SECRET, "node_id": "n", "node_name": "d",
            "name": "w", "harness": "claude", "task": "t", "directory": "/tmp",
            "idempotency_key": "spawn-test-20261107-0001"
        }))
        .unwrap();
        let status: SpawnInvocationParams = serde_json::from_value(serde_json::json!({
            "caller_name": "flows", "caller_secret": SECRET, "action": "spawn", "invocation_id": "i"
        }))
        .unwrap();
        let release: SpawnReleaseParams = serde_json::from_value(serde_json::json!({
            "caller_name": "flows", "caller_secret": SECRET, "node_id": "n", "node_name": "d",
            "name": "w", "expected_agent_id": "a", "idempotency_key": "spawn-test-20261107-0001"
        }))
        .unwrap();
        for debug in [
            format!("{invoke:?}"),
            format!("{status:?}"),
            format!("{release:?}"),
            format!("{invoke:#?}"),
            format!("{status:#?}"),
            format!("{release:#?}"),
        ] {
            assert!(!debug.contains(SECRET), "{debug}");
            assert!(debug.contains("redacted"), "{debug}");
        }
        assert!(format!("{invoke:?}").contains(r#"caller_secret: "<redacted>""#));
        // The other fields still print, and the wire value is untouched.
        assert!(format!("{release:?}").contains(r#"expected_agent_id: "a""#));
        assert_eq!(
            serde_json::to_value(&status).unwrap()["caller_secret"],
            serde_json::json!(SECRET)
        );
    }

    #[test]
    fn debug_shows_an_absent_caller_secret_as_none() {
        let status: SpawnInvocationParams = serde_json::from_value(serde_json::json!({
            "caller_name": "lead", "action": "release", "invocation_id": "i"
        }))
        .unwrap();
        let debug = format!("{status:?}");
        assert!(debug.contains("caller_secret: None"), "{debug}");
        assert!(!debug.contains("redacted"), "{debug}");
    }
}
