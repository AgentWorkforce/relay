//! The workspace directory: its agents and people, the fleet, messaging and
//! deep links.

use crate::relay::messaging::DirectMessage;
use crate::relay::people::{MessageState, RosterAgent, RosterWhere, WorkspacePerson};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, JsonSchema, Serialize)]
pub struct RosterParams {
    #[serde(rename = "where")]
    pub where_runs: Option<RosterWhere>,
    /// Idle agents too: `all` can be thousands of rows.
    #[serde(default)]
    pub include_idle: bool,
    /// Matches name, address or description.
    pub q: Option<String>,
}

/// `roster.list`'s result: active first, then most recently seen.
#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Roster {
    pub agents: Vec<RosterAgent>,
    /// Relaycast statuses that could not be read; their agents are missing
    /// from `agents`.
    pub unread_statuses: Vec<String>,
    pub fetched_at_ms: i64,
}

/// One endpoint to look up on the roster: give exactly one of `to` and
/// `address`, as `messages.send` takes them.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct RecipientParams {
    /// A name (`alice` or `@alice`).
    pub to: Option<String>,
    /// An exact `agent@machine` address.
    pub address: Option<String>,
    /// A message sent to it, whose state is read too.
    pub message_id: Option<String>,
}

/// `roster.get`'s result, also `messages.send`'s `recipient`.
#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Recipient {
    /// Whether the roster was read in the workspace your messages go to.
    /// When not (no workspace key, another workspace, or not signed in),
    /// `agent` and `message` are `null` and say nothing.
    pub known: bool,
    /// The roster's record; `null` when known and no agent has the name or
    /// address.
    pub agent: Option<RosterAgent>,
    /// With a message id: what Relaycast holds for that message; `null`
    /// when Relaycast's record cannot tell.
    pub message: Option<MessageState>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ReleaseParams {
    pub node_id: String,
    pub name: String,
    /// The generation `fleet.list` reported; another is `conflict`.
    pub generation: String,
}

/// `messages.conversations`'s result.
#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Conversations {
    /// Your relay identity's name.
    pub identity: String,
    pub conversations: Vec<Conversation>,
}

/// One of your 1:1 conversations, as Relaycast lists it.
#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub peer: Option<ConversationPeer>,
    /// Relaycast's own summary of the last message.
    pub last_message: serde_json::Value,
    pub unread_count: Option<u64>,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct ConversationPeer {
    pub name: String,
    pub agent_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct HistoryParams {
    /// A name (`alice` or `@alice`) or an `agent@machine` address: the 1:1
    /// conversation with it.
    pub endpoint: String,
    /// Pages back from this message id.
    pub before: Option<String>,
}

/// One uploaded session whose Cloud summary is read or requested.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct SessionOverviewParams {
    pub session_id: String,
}

/// `messages.history`'s result, in reading order (replies beneath their
/// parent).
#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct History {
    pub identity: String,
    pub messages: Vec<DirectMessage>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct SendParams {
    /// A name or address; give exactly one of `to` and `address`.
    pub to: Option<String>,
    /// An exact `agent@machine` address.
    pub address: Option<String>,
    pub text: String,
    /// Answers beneath this message instead.
    pub reply_to: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct SentMessage {
    pub message_id: Option<String>,
    pub conversation_id: Option<String>,
    /// The name the endpoint resolved to.
    pub to: Option<String>,
    /// The recipient and what Relaycast holds for this message, read just
    /// after the send.
    pub recipient: Recipient,
}

/// `people.list`'s result, sorted by name.
#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct People {
    pub people: Vec<WorkspacePerson>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct LinkParams {
    pub url: String,
    /// The site this app is built for; the signed-in site, else
    /// `https://agentrelay.com`, when absent.
    pub site_url: Option<String>,
}
