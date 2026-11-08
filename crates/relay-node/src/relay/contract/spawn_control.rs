//! Narrow native spawn controls; credentials and arbitrary HTTP are never part of this contract.
use std::fmt;

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

/// Starts a one-use proof for a service caller on this exact bridge
/// connection. The server binds the returned challenge to the connection,
/// active workspace and caller; the connection id never enters this wire.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnCallerChallengeParams {
    pub caller_name: String,
}

/// An opaque, fresh, domain-separated message to authenticate. The client
/// computes HMAC-SHA256 with its service-caller secret over the UTF-8 bytes of
/// `challenge` and sends the lowercase hexadecimal result once.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct SpawnCallerChallenge {
    pub challenge: String,
    /// Unix time in milliseconds. The server still owns expiry and consumes
    /// a challenge atomically, so this is informational for the client.
    pub expires_at_ms: u64,
}

/// Completes a one-use service-caller proof on the same connection that
/// requested it. `authenticator` is never a reusable credential.
#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnCallerAuthenticateParams {
    pub caller_name: String,
    pub challenge: String,
    pub authenticator: String,
}

impl fmt::Debug for SpawnCallerAuthenticateParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SpawnCallerAuthenticateParams")
            .field("caller_name", &self.caller_name)
            .field("challenge", &"<redacted>")
            .field("authenticator", &"<redacted>")
            .finish()
    }
}

/// Confirms only which caller is now bound. It exposes no connection id,
/// authority generation, secret, token or reusable capability.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct SpawnCallerAuthenticated {
    pub caller_name: String,
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
    /// True only when the provider reported the agent released: its output's
    /// `released` is exactly the JSON boolean `true`; it is never inferred
    /// from `status`. Added within bridge version 2, so older cores did not
    /// send it: a missing, `null` or non-boolean value reads as false. It is
    /// always written.
    #[serde(default, deserialize_with = "only_true")]
    #[schemars(extend("x-fallback" = false))]
    pub released: bool,
    pub task_unconfirmed: bool,
    /// A bounded machine code, never provider error text or arbitrary output.
    pub error_code: Option<String>,
}

/// Reads a proof flag: only a literal `true` is `true`; anything else,
/// `null` or a value of another type included, is `false`.
fn only_true<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(serde_json::Value::deserialize(deserializer)? == serde_json::Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_a_challenge_or_authenticator() {
        let params = SpawnCallerAuthenticateParams {
            caller_name: "flows".into(),
            challenge: "agent-relay/spawn-caller/v1:challenge-value".into(),
            authenticator: "authenticator-value".into(),
        };
        let debug = format!("{params:?}");
        assert!(!debug.contains("challenge-value"), "{debug}");
        assert!(!debug.contains("authenticator-value"), "{debug}");
        assert!(debug.contains("flows"), "{debug}");
        assert!(debug.contains("redacted"), "{debug}");
    }

    fn invocation(released: Option<serde_json::Value>) -> SpawnControlInvocation {
        let mut value = serde_json::json!({
            "id": "inv_1", "agent_id": null, "status": "completed", "node_id": "n",
            "name": "worker_1", "spawned": false, "ready": false,
            "task_unconfirmed": false, "error_code": null
        });
        if let Some(released) = released {
            value["released"] = released;
        }
        serde_json::from_value(value).unwrap()
    }

    /// `released` is additive within bridge version 2: a reply from an older
    /// core omits it, and only a literal `true` is proof of a release.
    #[test]
    fn released_reads_as_false_unless_it_is_literally_true() {
        use serde_json::json;
        for (released, expected) in [
            (None, false),
            (Some(json!(null)), false),
            (Some(json!(false)), false),
            (Some(json!(true)), true),
            (Some(json!("true")), false),
            (Some(json!(1)), false),
            (Some(json!({"ok": true})), false),
        ] {
            let read = invocation(released.clone());
            assert_eq!(read.released, expected, "{released:?}");
            let written = serde_json::to_value(&read).unwrap();
            assert_eq!(written["released"], json!(expected), "{released:?}");
            let text = serde_json::to_string(&read).unwrap();
            assert!(text.contains(&format!("\"released\":{expected}")), "{text}");
        }
    }

    /// A client reads each spawn method's reply the same way: an older
    /// core's reply without `released` still reads.
    #[test]
    fn every_spawn_reply_reads_released_from_an_older_or_newer_core() {
        use crate::relay::contract::{method, reader};
        use serde_json::json;
        let replies = [
            // spawn.invoke: dispatched, not yet ready.
            json!({"id": "inv_1", "status": "dispatched", "node_id": "n", "name": "worker_1",
                   "spawned": true, "ready": false, "task_unconfirmed": false}),
            // spawn.status: the spawned agent is ready.
            json!({"id": "inv_1", "agent_id": "a_1", "status": "completed", "node_id": "n",
                   "name": "worker_1", "spawned": true, "ready": true,
                   "task_unconfirmed": false, "error_code": null}),
            // spawn.release: completed.
            json!({"id": "inv_2", "status": "completed", "node_id": "n", "name": "worker_1",
                   "spawned": false, "ready": false, "task_unconfirmed": false}),
        ];
        for reply in replies {
            for (released, expected) in [
                (None, false),
                (Some(json!(null)), false),
                (Some(json!(false)), false),
                (Some(json!(true)), true),
                (Some(json!("true")), false),
                (Some(json!(1)), false),
            ] {
                let mut reply = reply.clone();
                if let Some(released) = released.clone() {
                    reply["released"] = released;
                }
                let invoke = reader::result::<method::SpawnInvoke>(reply.clone()).unwrap();
                let status = reader::result::<method::SpawnInvocation>(reply.clone()).unwrap();
                let release = reader::result::<method::SpawnRelease>(reply.clone()).unwrap();
                for read in [invoke, status, release] {
                    assert_eq!(read.released, expected, "{reply}");
                    assert_eq!(
                        serde_json::to_value(&read).unwrap()["released"],
                        json!(expected)
                    );
                }
            }
        }
    }
}
