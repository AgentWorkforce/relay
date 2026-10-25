//! Incoming messages: the desktop mailbox people send to Codex threads
//! shared from this computer.

use crate::relay::incoming::IncomingState;
use crate::relay::outbox::Mode;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// `incoming.status`'s result.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct IncomingStatus {
    pub state: IncomingState,
    /// A sharing change that was recovered or could not be saved.
    pub error: Option<String>,
    pub threads: Vec<IncomingThread>,
    /// Messages waiting for approval.
    pub held: Vec<HeldMessage>,
    /// Whether a held message can be approved now.
    pub can_approve: bool,
}

/// A Codex thread on this computer and how it is shared.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct IncomingThread {
    pub id: String,
    pub project: String,
    pub title: String,
    /// Open in Codex now.
    pub open: bool,
    pub shared: bool,
    /// `null` when not shared.
    pub mode: Option<Mode>,
    pub allows_unrestricted: bool,
}

/// A message held for the person to approve.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct HeldMessage {
    pub id: String,
    pub thread_id: String,
    pub text: String,
    pub sender_name: Option<String>,
    pub enqueued_at_ms: i64,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ShareParams {
    pub thread_id: String,
    /// `null` stops sharing.
    pub mode: Option<Mode>,
    #[serde(default)]
    pub allows_unrestricted: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct HeldMessageParams {
    pub id: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Approved {
    /// `false` when the message cannot be approved now (expired, gone, or
    /// incoming paused).
    pub approved: bool,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Rejected {
    pub rejected: bool,
}
