use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayPriority {
    P0,
    P1,
    P2,
    P3,
    P4,
}

impl RelayPriority {
    pub fn as_u8(self) -> u8 {
        match self {
            RelayPriority::P0 => 0,
            RelayPriority::P1 => 1,
            RelayPriority::P2 => 2,
            RelayPriority::P3 => 3,
            RelayPriority::P4 => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboundKind {
    MessageCreated,
    DmReceived,
    ThreadReply,
    GroupDmReceived,
    Presence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SenderKind {
    Agent,
    Human,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundRelayEvent {
    pub event_id: String,
    pub kind: InboundKind,
    pub from: String,
    pub sender_agent_id: Option<String>,
    pub sender_kind: SenderKind,
    pub target: String,
    pub text: String,
    pub thread_id: Option<String>,
    pub priority: RelayPriority,
}

/// A command invocation event received over WebSocket.
/// Relaycast emits these as `type: "command.invoked"` when an agent invokes
/// a registered command (e.g. `/spawn`, `/release`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerCommandEvent {
    /// The slash command name (e.g. "/spawn", "/release").
    pub command: String,
    /// Channel the command was invoked in.
    pub channel: String,
    /// Agent ID or name of the invoker.
    pub invoked_by: String,
    /// Target command handler agent ID, when provided by Relaycast.
    pub handler_agent_id: Option<String>,
    /// Structured parameters for the command.
    pub payload: BrokerCommandPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnParams {
    pub name: String,
    pub cli: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseParams {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerCommandPayload {
    Spawn(SpawnParams),
    Release(ReleaseParams),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InjectRequest {
    pub id: String,
    pub from: String,
    pub target: String,
    pub body: String,
    pub priority: RelayPriority,
    pub attempts: u32,
}
