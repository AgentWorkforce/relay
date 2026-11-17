//! Consent controls for messages delivered into Claude Code sessions.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeDeliveryStatus {
    pub restricted: bool,
    pub sessions: Vec<ClaudeDeliverySession>,
    pub allowed_senders: Vec<ClaudeSender>,
    pub held: Vec<ClaudeHeldDelivery>,
    /// The organization holds every message from a sender who is not one of
    /// its admins, in every harness (`claude_delivery_policy`): while true,
    /// held messages may be approved one by one, but no sender can be
    /// allowed for good. Absent when no such rule applies.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub organization_hold: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeDeliverySession {
    pub id: String,
    pub agent: String,
    pub title: String,
    /// `false` means Ask first for every message to this session.
    pub direct: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeSender {
    pub address: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeHeldDelivery {
    pub id: String,
    pub agent: String,
    pub session_id: String,
    pub sender: String,
    pub sender_name: String,
    pub text: String,
    pub held_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeRestrictionParams {
    pub restricted: bool,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeSessionDeliveryParams {
    pub session_id: String,
    pub direct: bool,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeSenderDeliveryParams {
    pub sender: String,
    pub name: String,
    pub allowed: bool,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeHeldParams {
    pub id: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct ClaudeDeliveryChanged {
    pub changed: bool,
}
