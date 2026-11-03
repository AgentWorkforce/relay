//! `action.result` frames: what the node answers an invocation with, an
//! output or an error, with `error_details` where Relaycast agreed to them.

use super::{HarnessId, WIRE_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub fn action_output(invocation_id: &str, output: Value) -> Value {
    json!({
        "v": WIRE_VERSION,
        "type": "action.result",
        "invocation_id": invocation_id,
        "output": output,
    })
}

pub fn action_error(invocation_id: &str, error: &str) -> Value {
    json!({
        "v": WIRE_VERSION,
        "type": "action.result",
        "invocation_id": invocation_id,
        "error": error,
    })
}

/// The agreed failure codes that carry `error_details`. Every failure ends
/// that attempt: the node never queues, retries or sends a spawn elsewhere,
/// and the caller keeps the task.
pub const CAPACITY_EXCEEDED: &str = "spawn_capacity_exceeded";
pub const CAPACITY_CHANGED: &str = "capacity_changed";
pub const TARGET_UNAVAILABLE: &str = "spawn_target_unavailable";
pub const TARGET_OFFLINE: &str = "spawn_target_offline";
pub const HARNESS_UNAVAILABLE: &str = "spawn_harness_unavailable";

type FailureCode = &'static str;

/// A spawn refused with details a requester can act on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnFailure {
    /// One of the codes above.
    #[serde(deserialize_with = "failure_code")]
    pub code: FailureCode,
    pub message: String,
    /// This node's name.
    pub node: String,
    pub harness: Option<HarnessId>,
    /// Held places, spawns starting and the maximum, when known.
    pub active: Option<u32>,
    pub reserved: Option<u32>,
    pub max: Option<u32>,
    /// ISO-8601, when the refusal was decided.
    pub observed_at: String,
    /// Whether the same spawn may succeed later here (a place may free up).
    pub retryable: bool,
}

fn failure_code<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<&'static str, D::Error> {
    let code = String::deserialize(deserializer)?;
    [
        CAPACITY_EXCEEDED,
        CAPACITY_CHANGED,
        TARGET_UNAVAILABLE,
        TARGET_OFFLINE,
        HARNESS_UNAVAILABLE,
    ]
    .into_iter()
    .find(|known| *known == code)
    .ok_or_else(|| serde::de::Error::custom("unknown spawn failure code"))
}

/// `{"error": "<code>", "error_details": {…}}` on a connection that accepted
/// `ERROR_DETAILS_CAPABILITY`; a code-prefixed redacted reason otherwise. Legacy brokers reject unknown
/// fields, but preserve the error string verbatim.
pub fn action_failure(invocation_id: &str, failure: &SpawnFailure, details: bool) -> Value {
    if !details {
        return action_error(
            invocation_id,
            &format!(
                "{}: {}",
                failure.code,
                crate::relay::harness::diagnostics::redact(&failure.message)
            ),
        );
    }
    let mut details = json!({
        "code": failure.code,
        "message": crate::relay::harness::diagnostics::redact(&failure.message),
        "node": failure.node,
        "harness": failure.harness.map(HarnessId::name),
        "active": failure.active,
        "reserved": failure.reserved,
        "max": failure.max,
        "observed_at": failure.observed_at,
        "retryable": failure.retryable,
    });
    if let Value::Object(fields) = &mut details {
        fields.retain(|_, value| !value.is_null());
    }
    json!({
        "v": WIRE_VERSION,
        "type": "action.result",
        "invocation_id": invocation_id,
        "error": failure.code,
        "error_details": details,
    })
}

/// A spawn the harness was seen to take its task in.
pub fn spawned(name: &str) -> Value {
    json!({"spawned": true, "ready": true, "name": name})
}

/// A live agent whose task was handed over without the harness confirming
/// it. A retry would start a second agent, so it is still a success.
pub fn spawned_unconfirmed(name: &str, verification: &str) -> Value {
    json!({
        "spawned": true,
        "ready": true,
        "name": name,
        "warning": {
            "code": "spawn_task_unconfirmed",
            "verification": verification,
            "message": if verification == "model_start_unconfirmed" {
                format!("agent '{name}' is live and its initial task was queued, but model startup has not been verified. Do not retry this spawn; message the agent to check.")
            } else {
                format!("agent '{name}' is live and ready and its initial task was handed over, but the harness did not confirm taking it. Do not retry this spawn; message the agent to check.")
            },
        },
    })
}

pub fn released(name: &str) -> Value {
    json!({"released": true, "name": name})
}
