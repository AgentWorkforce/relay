//! Skip chat: the saved conversation, the project view and pushes.

use crate::relay::cloud_chat::{SendReceipt, SkipBriefing, SkipWorkState};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The saved conversation for the signed-in account.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ChatConversation {
    pub messages: Vec<ConversationTurn>,
    /// A question is out.
    pub sending: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ConversationTurn {
    pub id: String,
    /// `user` or `assistant`.
    pub role: String,
    pub content: String,
    pub references: Vec<TurnReference>,
    pub actions: Vec<TurnAction>,
}

/// A session Skip cites.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct TurnReference {
    pub session_id: String,
    pub source: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
}

/// Something Skip proposes; `send_message` sends `message` to the session
/// whose target key is `agent_id`.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct TurnAction {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub agent_id: String,
    pub message: String,
    /// What became of the send, once one started.
    pub receipt: Option<SendReceipt>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ChatSendParams {
    /// 1–12,000 characters.
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ChatAnswer {
    /// `false` when the conversation was cleared or the person signed out
    /// meanwhile.
    pub answered: bool,
    pub conversation: ChatConversation,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ActParams {
    pub action_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ActResult {
    pub action_id: String,
    pub receipt: SendReceipt,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ChatHistoryParams {
    pub session_id: String,
    pub source: Option<String>,
    /// The previous page's `next_cursor`.
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct HistoryPage {
    pub events: Vec<SessionEvent>,
    pub next_cursor: Option<String>,
}

/// One event of a session's uploaded history.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct SessionEvent {
    /// Unique across machines and kinds.
    pub id: String,
    pub event_id: String,
    pub source: Option<String>,
    pub session_id: Option<String>,
    pub machine_id: Option<String>,
    /// ISO-8601.
    pub ts: Option<String>,
    pub kind: Option<String>,
    pub actor_name: Option<String>,
    pub actor_role: Option<String>,
    pub content: Option<String>,
    pub content_truncated: Option<bool>,
    pub tool_name: Option<String>,
    pub tool_status: Option<String>,
}

/// `chat.projects`'s result.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ProjectsState {
    /// Cloud owns durable generation; false identifies the legacy refresh-on-view API.
    pub durable: Option<bool>,
    /// Saved content is available, but the latest Cloud read failed.
    pub error: Option<String>,
    /// Null before the first view is built.
    pub report: Option<ProjectsReport>,
    /// Older than 15 minutes.
    pub stale: bool,
    /// A rebuild is running.
    pub refreshing: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ProjectsReport {
    /// ISO-8601.
    pub generated_at: String,
    pub briefing: SkipBriefing,
    pub projects: Vec<Project>,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub state: SkipWorkState,
    pub next: Option<String>,
    pub repositories: Vec<String>,
    pub last_active_at: Option<String>,
    pub sessions: Vec<ProjectSession>,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ProjectSession {
    /// `SOURCE:ID`.
    pub key: String,
    pub session_id: String,
    pub source: String,
    pub title: String,
    pub state: SkipWorkState,
    pub reason: String,
    /// The message Skip sends to move a ready session along.
    pub nudge: Option<String>,
    pub last_active_at: Option<String>,
    /// What `chat.push` takes; null when there is nothing to push.
    pub push_key: Option<String>,
    pub receipt: Option<SendReceipt>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct PushParams {
    pub push_keys: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct PushResult {
    pub results: Vec<PushOutcome>,
    pub projects: ProjectsState,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct PushOutcome {
    pub push_key: String,
    pub outcome: PushOutcomeKind,
    /// Why it did not send, when there is more to say.
    pub detail: Option<String>,
}

/// What one push did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "unconfirmed"))]
pub enum PushOutcomeKind {
    Sent,
    /// The send failed or its outcome is unknown.
    Unconfirmed,
    AlreadyPushed,
    /// The current report has nothing to send for it.
    NotPushable,
    NotOnThisComputer,
    AccountWorkspaceNotConnected,
    /// The session is on another Relaycast workspace than the account's.
    OtherWorkspace,
    RegisterFailed,
}
