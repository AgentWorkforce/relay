//! Skip chat: Agent Relay Cloud's assistant over the workspace's sessions.
//!
//! Every request is the signed-in person's own, through `CloudAccess`, to
//! `/workspaces/{id}/skip/{chat,projects,history}`; Cloud answers each in
//! one JSON body (Skip does not stream). The conversation and the project
//! view are saved per account under `<app data>/Conversations/`, named and
//! shaped as the macOS app saved them (`<sha256(site/workspace)>.json` and
//! `.projects.json`), so a moved directory reads as is.
//!
//! The core builds what Skip is told about this computer itself: the
//! sessions discovery finds, which of them are on the account's Relaycast
//! workspace, and the saved project view linked to them. Acting on Skip's
//! proposals (`chat.act`, `chat.push`) goes through the agent runtime like
//! any test message, and records a receipt before dispatch so an uncertain
//! send is never repeated.

use crate::relay::cloud_session::{segment, CloudAccount, CloudError};
use crate::relay::contract::chat::{
    ActResult, ChatAnswer, ChatConversation, ConversationTurn, HistoryPage, Project,
    ProjectSession, ProjectsReport, ProjectsState, PushOutcome, PushOutcomeKind, PushResult,
    SessionEvent, TurnAction, TurnReference,
};
use crate::relay::contract::{answer, method};
use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::state::{now_ms, Listing};
use crate::relay::store::{random_uuid, CloudWorkspace, Registration, SessionKind};
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

/// The directory under the app data directory that holds saved chats.
pub const CONVERSATIONS_DIR: &str = "Conversations";
/// Turns of history sent with each question.
const SENT_TURNS: usize = 40;
/// Turns kept on disk.
const SAVED_TURNS: usize = 100;
/// Characters in one question, and per turn sent.
const TURN_CHARS: usize = 12_000;
const SENT_AGENTS: usize = 100;
const SENT_PROJECTS: usize = 40;
const SENT_PROJECT_SESSIONS: usize = 30;
/// A project view older than this is rebuilt when shown.
const STALE_AFTER_MS: i64 = 15 * 60 * 1000;
/// A push receipt outlives its session's absence from one report until the
/// session is past the view's two-week window.
const RECEIPT_HORIZON_MS: i64 = 15 * 86_400 * 1000;
/// Swift's `Date` reference: 2001-01-01T00:00:00Z, in Unix seconds.
const APPLE_EPOCH_S: f64 = 978_307_200.0;

// ---------------------------------------------------------------------------
// Cloud's contract and the saved files.

/// A session Skip cites.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReference {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Something Skip proposes; `send_message` sends `message` to the session
/// whose target key is `agent_id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAction {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub agent_id: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatTurn {
    pub id: String,
    /// `user` or `assistant`.
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub references: Vec<ChatReference>,
    #[serde(default)]
    pub actions: Vec<ChatAction>,
}

impl ChatTurn {
    fn new(role: &str, content: String) -> ChatTurn {
        ChatTurn {
            id: random_uuid().to_uppercase(),
            role: role.into(),
            content,
            references: Vec::new(),
            actions: Vec::new(),
        }
    }
}

/// `POST skip/chat`'s answer; anything else in it (`toolCalls`) is ignored.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ChatReply {
    pub message: String,
    /// Absent when Skip proposes nothing.
    #[serde(default)]
    pub actions: Vec<ChatAction>,
    #[serde(default)]
    pub references: Vec<ChatReference>,
}

/// What happened to one send Skip proposed or pushed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "unconfirmed"))]
pub enum ReceiptState {
    /// Recorded before dispatch; still so after a restart means in doubt.
    Sending,
    /// Relaycast accepted the message.
    Sent,
    /// The send failed or its outcome is unknown; `detail` says why.
    Unconfirmed,
}

/// A send's receipt, as saved and as the bridge reports it. A receipt
/// exists for every send ever started, so none is sent twice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(from = "StoredReceipt")]
pub struct SendReceipt {
    pub state: ReceiptState,
    /// The agent it went to.
    pub agent: Option<String>,
    pub detail: Option<String>,
    pub at_ms: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
struct TypedReceipt {
    state: ReceiptState,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    at_ms: Option<i64>,
}

/// The macOS app saved receipts as sentences (actions) or as
/// `{message, date, sent}` (pushes); both still read.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
enum StoredReceipt {
    Typed(TypedReceipt),
    MacPush {
        message: String,
        date: f64,
        sent: bool,
    },
    MacAction(String),
}

const UNCONFIRMED_PREFIX: &str = "Send could not be confirmed: ";

impl From<StoredReceipt> for SendReceipt {
    fn from(stored: StoredReceipt) -> SendReceipt {
        let from_sentence = |message: &str, sent: bool, at_ms: Option<i64>| {
            let agent = message
                .split_once('@')
                .map(|(_, rest)| rest.split(['.', ' ']).next().unwrap_or_default())
                .filter(|name| !name.is_empty())
                .map(String::from);
            if sent || message.starts_with("Sent to Relaycast") {
                SendReceipt {
                    state: ReceiptState::Sent,
                    agent,
                    detail: None,
                    at_ms,
                }
            } else if let Some(detail) = message.strip_prefix(UNCONFIRMED_PREFIX) {
                SendReceipt {
                    state: ReceiptState::Unconfirmed,
                    agent: None,
                    detail: Some(detail.into()),
                    at_ms,
                }
            } else {
                SendReceipt {
                    state: ReceiptState::Sending,
                    agent: None,
                    detail: None,
                    at_ms,
                }
            }
        };
        match stored {
            StoredReceipt::Typed(t) => SendReceipt {
                state: t.state,
                agent: t.agent,
                detail: t.detail,
                at_ms: t.at_ms,
            },
            StoredReceipt::MacPush {
                message,
                date,
                sent,
            } => from_sentence(
                &message,
                sent,
                Some(((date + APPLE_EPOCH_S) * 1000.0) as i64),
            ),
            StoredReceipt::MacAction(message) => from_sentence(&message, false, None),
        }
    }
}

impl SendReceipt {
    fn sending() -> SendReceipt {
        SendReceipt {
            state: ReceiptState::Sending,
            agent: None,
            detail: None,
            at_ms: Some(now_ms()),
        }
    }

    fn outcome(agent: &str, result: &Result<Option<String>, RpcError>) -> SendReceipt {
        let (state, detail) = match result {
            Ok(_) => (ReceiptState::Sent, None),
            Err(error) => (ReceiptState::Unconfirmed, Some(error.message.clone())),
        };
        SendReceipt {
            state,
            agent: Some(agent.into()),
            detail,
            at_ms: Some(now_ms()),
        }
    }
}

/// `<sha256(site/workspace)>.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedConversation {
    pub messages: Vec<ChatTurn>,
    /// By action id.
    #[serde(default)]
    pub receipts: BTreeMap<String, SendReceipt>,
}

/// What a session or project needs next, as Skip classified it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "idle"))]
pub enum SkipWorkState {
    NeedsYou,
    Ready,
    Working,
    Idle,
    Done,
}

/// A state this build does not know reads as idle rather than failing.
impl<'de> Deserialize<'de> for SkipWorkState {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match String::deserialize(deserializer)?.as_str() {
            "needs_you" => SkipWorkState::NeedsYou,
            "ready" => SkipWorkState::Ready,
            "working" => SkipWorkState::Working,
            "done" => SkipWorkState::Done,
            _ => SkipWorkState::Idle,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipProjectSession {
    pub session_id: String,
    pub source: String,
    pub title: String,
    pub state: SkipWorkState,
    pub reason: String,
    /// The message Skip sends to move a ready session along.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nudge: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<String>,
}

impl SkipProjectSession {
    /// The `SOURCE:ID` key the uploader and discovery share.
    pub fn key(&self) -> String {
        format!("{}:{}", self.source, self.session_id)
    }

    pub fn can_push(&self) -> bool {
        self.state == SkipWorkState::Ready && self.nudge.as_deref().is_some_and(|n| !n.is_empty())
    }

    /// One push: the session at its last recorded activity. The nudge is
    /// reworded on every refresh, so it is not the identity; a session is
    /// pushable again only once history records new activity.
    pub fn push_key(&self) -> Option<String> {
        self.can_push().then(|| {
            format!(
                "{}@{}",
                self.key(),
                self.last_active_at.as_deref().unwrap_or_default()
            )
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipProject {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub state: SkipWorkState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub repositories: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<String>,
    pub sessions: Vec<SkipProjectSession>,
}

/// Skip's one-paragraph view across projects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SkipBriefing {
    pub headline: String,
    pub stuck: Vec<String>,
    pub moving: Vec<String>,
    pub ready: Vec<String>,
}

/// Skip's persisted project report (also the legacy synchronous POST response).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipProjectsReport {
    pub generated_at: String,
    pub briefing: SkipBriefing,
    pub projects: Vec<SkipProject>,
}

/// The map sent back on refresh so project ids and names stay stable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreviousProject {
    pub id: String,
    pub name: String,
    pub sessions: Vec<String>,
}

impl SkipProjectsReport {
    pub fn pushable(&self) -> impl Iterator<Item = &SkipProjectSession> {
        self.projects
            .iter()
            .flat_map(|p| &p.sessions)
            .filter(|s| s.can_push())
    }

    pub fn previous(&self) -> Vec<PreviousProject> {
        self.projects
            .iter()
            .filter(|p| !p.id.trim().is_empty() && !p.name.trim().is_empty())
            .take(40)
            .map(|p| PreviousProject {
                id: p.id.clone(),
                name: prefix(&p.name, 200),
                sessions: p.sessions.iter().take(200).map(|s| s.key()).collect(),
            })
            .collect()
    }

    fn generated_ms(&self) -> Option<i64> {
        chrono::DateTime::parse_from_rfc3339(&self.generated_at)
            .ok()
            .map(|d| d.timestamp_millis())
    }

    /// Whether the view is old enough to rebuild when shown.
    pub fn is_stale(&self, now_ms: i64) -> bool {
        self.generated_ms()
            .is_none_or(|generated| now_ms - generated > STALE_AFTER_MS)
    }
}

/// `<sha256(site/workspace)>.projects.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedProjects {
    pub report: SkipProjectsReport,
    /// By push key.
    #[serde(default)]
    pub receipts: BTreeMap<String, SendReceipt>,
}

/// One entry of `GET skip/history?kind=events`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub event_id: String,
    pub source: Option<String>,
    pub session_id: Option<String>,
    pub machine_id: Option<String>,
    pub ts: Option<String>,
    pub kind: Option<String>,
    pub actor_name: Option<String>,
    pub actor_role: Option<String>,
    pub content: Option<String>,
    pub content_truncated: Option<bool>,
    pub tool_name: Option<String>,
    pub tool_status: Option<String>,
}

impl HistoryEvent {
    /// Unique across machines and kinds: the same event id replayed from
    /// two machines, or as a message and a tool call, is two events.
    pub fn id(&self) -> String {
        [
            self.source.as_deref(),
            self.session_id.as_deref(),
            self.machine_id.as_deref(),
            self.kind.as_deref(),
            Some(self.event_id.as_str()),
        ]
        .iter()
        .map(|part| {
            let part = part.unwrap_or_default();
            format!("{}:{part}", part.len())
        })
        .collect()
    }

    fn to_bridge(&self) -> SessionEvent {
        SessionEvent {
            id: self.id(),
            event_id: self.event_id.clone(),
            source: self.source.clone(),
            session_id: self.session_id.clone(),
            machine_id: self.machine_id.clone(),
            ts: self.ts.clone(),
            kind: self.kind.clone(),
            actor_name: self.actor_name.clone(),
            actor_role: self.actor_role.clone(),
            content: self.content.clone(),
            content_truncated: self.content_truncated,
            tool_name: self.tool_name.clone(),
            tool_status: self.tool_status.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEventsPage {
    pub events: Vec<HistoryEvent>,
    pub next_cursor: Option<String>,
}

// ---------------------------------------------------------------------------
// What Skip is told about this computer.

/// One session on this computer, as Skip sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    /// The session's target key, which `send_message` names as `agentId`.
    pub id: String,
    pub name: String,
    /// `available`, `not running` or `not addressable`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// The project view as Skip chat sees it; `agent_id` links a session to
/// the roster.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectContext {
    pub name: String,
    pub state: SkipWorkState,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub sessions: Vec<ProjectSessionContext>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionContext {
    pub session_id: String,
    pub source: String,
    pub title: String,
    pub state: SkipWorkState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

fn prefix(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

/// The history source a session's transcript is uploaded under.
pub fn history_source(kind: SessionKind) -> &'static str {
    kind.source()
}

/// Whether `registration` is on the account's Relaycast workspace.
pub fn belongs_to_cloud(registration: &Registration, cloud: Option<&CloudWorkspace>) -> bool {
    cloud.is_some_and(|cloud| {
        registration.workspace_key.as_ref() == Some(&cloud.key)
            && registration.base_url == cloud.base_url
    })
}

/// Each session, named as its registration when that is on the account's
/// workspace (only those are addressable from Skip).
pub fn agent_context(
    sessions: &[DiscoveredSession],
    registrations: &[Registration],
    cloud: Option<&CloudWorkspace>,
) -> Vec<AgentContext> {
    sessions
        .iter()
        .map(|session| {
            let registration = registrations
                .iter()
                .find(|r| r.target == session.target)
                .filter(|r| belongs_to_cloud(r, cloud));
            let status = match registration {
                None => "not addressable",
                Some(_) if session.live => "available",
                Some(_) => "not running",
            };
            AgentContext {
                id: session.target.key(),
                name: prefix(registration.map_or(&session.title, |r| &r.name), 512),
                status: status.into(),
                project: session.project().map(|p| prefix(&p, 2048)),
                session_id: Some(session.target.id.clone()),
                source: Some(history_source(session.target.kind).into()),
            }
        })
        .collect()
}

/// The saved project view, each session linked to its roster entry.
pub fn project_context(
    report: &SkipProjectsReport,
    agents: &[AgentContext],
) -> Vec<ProjectContext> {
    let mut roster: HashMap<String, &str> = HashMap::new();
    for agent in agents {
        if let (Some(id), Some(source)) = (&agent.session_id, &agent.source) {
            roster
                .entry(format!("{source}:{id}"))
                .or_insert(agent.id.as_str());
        }
    }
    report
        .projects
        .iter()
        .take(SENT_PROJECTS)
        .map(|project| ProjectContext {
            name: prefix(&project.name, 200),
            state: project.state,
            summary: prefix(&project.summary, 1_000),
            next: project.next.as_deref().map(|n| prefix(n, 400)),
            sessions: project
                .sessions
                .iter()
                .take(SENT_PROJECT_SESSIONS)
                .map(|s| ProjectSessionContext {
                    session_id: s.session_id.clone(),
                    source: s.source.clone(),
                    title: prefix(&s.title, 512),
                    state: s.state,
                    agent_id: roster.get(&s.key()).map(|id| id.to_string()),
                })
                .collect(),
        })
        .collect()
}

/// `POST skip/chat`'s body: the latest turns, each bounded, and what Skip
/// is told about this computer.
pub fn chat_body(
    timezone: &str,
    messages: &[ChatTurn],
    agents: &[AgentContext],
    projects: &[ProjectContext],
) -> Value {
    let recent = &messages[messages.len().saturating_sub(SENT_TURNS)..];
    let mut body = json!({
        "timezone": timezone,
        "messages": recent
            .iter()
            .map(|t| json!({"role": t.role, "content": prefix(&t.content, TURN_CHARS)}))
            .collect::<Vec<_>>(),
        "agents": &agents[..agents.len().min(SENT_AGENTS)],
    });
    if !projects.is_empty() {
        body["projects"] = json!(&projects[..projects.len().min(SENT_PROJECTS)]);
    }
    body
}

/// `skip/history`'s query for one session's events.
pub fn history_query(session_id: &str, source: Option<&str>, cursor: Option<&str>) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("kind", "events");
    query.append_pair("sessionId", session_id);
    if let Some(source) = source {
        query.append_pair("source", source);
    }
    if let Some(cursor) = cursor {
        query.append_pair("cursor", cursor);
    }
    query.finish()
}

/// This computer's IANA time zone: `TZ`, else the zone `/etc/localtime`
/// links to, else `/etc/timezone`, else UTC.
pub fn local_timezone(env: &BTreeMap<String, String>) -> String {
    let zone_of = |path: &str| -> Option<String> {
        let path = path.trim().trim_start_matches(':');
        let zone = match path.rsplit_once("zoneinfo/") {
            Some((_, zone)) => zone,
            None if !path.starts_with('/') => path,
            None => return None,
        };
        (!zone.is_empty()).then(|| zone.to_string())
    };
    env.get("TZ")
        .and_then(|tz| zone_of(tz))
        .or_else(|| {
            fs::read_link("/etc/localtime")
                .ok()
                .and_then(|link| zone_of(&link.to_string_lossy()))
        })
        .or_else(|| {
            fs::read_to_string("/etc/timezone")
                .ok()
                .and_then(|tz| zone_of(&tz))
        })
        .unwrap_or_else(|| "UTC".into())
}

// ---------------------------------------------------------------------------
// Files.

/// `<app data>/Conversations/<sha256(site/workspace)>.json`, derived from
/// the account alone so sign-out can delete it.
pub fn conversation_path(app_data_dir: &Path, site_url: &str, workspace_id: &str) -> PathBuf {
    let key: String = Sha256::digest(format!("{site_url}/{workspace_id}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    app_data_dir
        .join(CONVERSATIONS_DIR)
        .join(format!("{key}.json"))
}

pub fn projects_path(app_data_dir: &Path, site_url: &str, workspace_id: &str) -> PathBuf {
    conversation_path(app_data_dir, site_url, workspace_id).with_extension("projects.json")
}

/// A missing or unreadable file reads as nothing saved.
fn load<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Written readable by this user only, then swapped into place.
fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), RpcError> {
    let failed = |_| {
        RpcError::new(
            ErrorKind::StoreFailed,
            "Skip's chat could not be saved on this computer.",
        )
    };
    let directory = path.parent().unwrap_or(Path::new("."));
    if !directory.exists() {
        fs::create_dir_all(directory).map_err(failed)?;
        let _ = crate::platform::fs::set_mode(directory, 0o700);
    }
    let temporary = directory.join(format!(".chat-{}.json", random_uuid()));
    let result = (|| {
        let mut file =
            crate::platform::fs::private(fs::OpenOptions::new().write(true).create_new(true))
                .open(&temporary)?;
        file.write_all(&serde_json::to_vec(value).expect("chat state encodes"))?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(failed)
}

/// Deletes the account's saved conversation and project view (sign-out),
/// and drops any answer still in flight for it.
pub fn forget(app_data_dir: &Path, account: &CloudAccount) {
    let conversation = conversation_path(app_data_dir, &account.site_url, &account.workspace_id);
    let projects = projects_path(app_data_dir, &account.site_url, &account.workspace_id);
    with_state(&conversation, |state| {
        state.epoch += 1;
        state.conversation += 1;
        state.sending = false;
        state.refreshing = false;
        state.pending_actions.clear();
        state.pending_pushes.clear();
        let _ = fs::remove_file(&conversation);
        let _ = fs::remove_file(&projects);
    });
}

fn signed_out() -> RpcError {
    RpcError::new(
        ErrorKind::NotSignedIn,
        "Sign in to Agent Relay to use Skip.",
    )
}

// ---------------------------------------------------------------------------
// In-flight state, per account file.

#[derive(Default)]
struct AccountState {
    /// Bumped by `forget`: nothing started before it is written after.
    epoch: u64,
    /// Bumped by `chat.clear` and `forget`: a reply or receipt for an
    /// earlier conversation never lands in this one.
    conversation: u64,
    sending: bool,
    refreshing: bool,
    pending_actions: HashSet<String>,
    pending_pushes: HashSet<String>,
}

/// Every read-change-write of a chat file runs under this lock.
static STATE: LazyLock<Mutex<HashMap<PathBuf, AccountState>>> = LazyLock::new(Default::default);

fn with_state<T>(conversation: &Path, body: impl FnOnce(&mut AccountState) -> T) -> T {
    let mut states = STATE.lock().unwrap();
    body(states.entry(conversation.to_path_buf()).or_default())
}

// ---------------------------------------------------------------------------
// The bridge.

struct Chat {
    core: Arc<Core>,
    account: CloudAccount,
    conversation: PathBuf,
    projects: PathBuf,
}

fn chat(core: &Arc<Core>) -> Result<Chat, RpcError> {
    let account = core.plugins.cloud.account().ok_or_else(|| {
        RpcError::new(
            ErrorKind::NotSignedIn,
            "Sign in to Agent Relay to use Skip.",
        )
    })?;
    if account.workspace_id.is_empty() {
        return Err(RpcError::new(
            ErrorKind::NotSignedIn,
            "Connect to an Agent Relay workspace to continue.",
        ));
    }
    let data = &core.config().app_data_dir;
    Ok(Chat {
        conversation: conversation_path(data, &account.site_url, &account.workspace_id),
        projects: projects_path(data, &account.site_url, &account.workspace_id),
        core: core.clone(),
        account,
    })
}

fn cloud_error(error: CloudError) -> RpcError {
    match error {
        CloudError::SignedOut | CloudError::Rejected => {
            RpcError::new(ErrorKind::NotSignedIn, error.to_string())
        }
        other => RpcError::cloud(&other),
    }
}

fn unreadable() -> RpcError {
    RpcError::new(
        ErrorKind::CloudFailed,
        "Agent Relay Cloud returned an unreadable response. Try again.",
    )
}

fn busy(what: &str) -> RpcError {
    RpcError::new(ErrorKind::Busy, format!("Skip is still {what}."))
}

/// Runs `work` to completion even if the caller goes away: Skip's answers
/// take up to a minute and are wanted wherever the person goes next.
async fn detached<T, F>(work: F) -> Result<T, RpcError>
where
    T: Send + 'static,
    F: Future<Output = Result<T, RpcError>> + Send + 'static,
{
    tokio::spawn(work).await.unwrap_or_else(|_| {
        Err(RpcError::new(
            ErrorKind::Internal,
            "Skip's request stopped unexpectedly.",
        ))
    })
}

impl Chat {
    fn path(&self, route: &str) -> String {
        format!(
            "/workspaces/{}/skip/{route}",
            segment(&self.account.workspace_id)
        )
    }

    fn timezone(&self) -> String {
        local_timezone(&self.core.config().env)
    }

    async fn sessions(&self) -> Vec<DiscoveredSession> {
        let directory = self.core.plugins.sessions.clone();
        tokio::task::spawn_blocking(move || directory.sessions())
            .await
            .unwrap_or_default()
    }

    fn cloud_workspace(&self) -> Option<CloudWorkspace> {
        self.core.store.read(|s| s.cloud.clone())
    }

    /// Sends `text` to the agent named `name` as the signed-in person, and
    /// only as them: after a sign-out this fails rather than falling back
    /// to this computer's test sender.
    async fn send_as_person(&self, name: &str, text: &str) -> Result<Option<String>, RpcError> {
        let address = self
            .core
            .store
            .read(|store| {
                store
                    .registrations
                    .iter()
                    .find(|r| r.name == name)
                    .map(|r| r.direct_address(&self.core.machine_prefix))
            })
            .ok_or_else(|| {
                RpcError::new(
                    ErrorKind::NotFound,
                    format!("No agent named @{name} is on the relay from this computer."),
                )
            })?;
        if self.core.plugins.cloud.account().is_none() {
            return Err(signed_out());
        }
        let sent = self
            .core
            .send_as_person(&crate::relay::links::Endpoint::Address(address), text, None)
            .await?;
        Ok(sent.message_id)
    }

    fn saved_conversation(&self) -> ChatConversation {
        let saved: SavedConversation = load(&self.conversation).unwrap_or_default();
        let sending = with_state(&self.conversation, |s| s.sending);
        conversation_of(&saved, sending)
    }

    fn project_view(&self) -> ProjectsState {
        let saved: Option<SavedProjects> = load(&self.projects);
        let refreshing = with_state(&self.conversation, |s| s.refreshing);
        projects_of(saved.as_ref(), refreshing, now_ms())
    }

    async fn send(self, text: String) -> Result<ChatAnswer, RpcError> {
        let (conversation, mut messages) = with_state(&self.conversation, |state| {
            if state.sending {
                return Err(busy("answering"));
            }
            state.sending = true;
            let saved: SavedConversation = load(&self.conversation).unwrap_or_default();
            Ok((state.conversation, saved.messages))
        })?;
        let user = ChatTurn::new("user", text);
        messages.push(user.clone());
        let sessions = self.sessions().await;
        let agents = self
            .core
            .store
            .read(|store| agent_context(&sessions, &store.registrations, store.cloud.as_ref()));
        let projects = load::<SavedProjects>(&self.projects)
            .map(|saved| project_context(&saved.report, &agents))
            .unwrap_or_default();
        let body = chat_body(&self.timezone(), &messages, &agents, &projects);
        let answer = self
            .core
            .plugins
            .cloud
            .request("POST", self.path("chat"), Some(body))
            .await;
        let answered = with_state(&self.conversation, |state| -> Result<bool, RpcError> {
            // A sign-out since started this conversation over; its own
            // question, if any, is still out.
            if state.conversation == conversation {
                state.sending = false;
            }
            let reply: ChatReply =
                serde_json::from_value(answer.map_err(cloud_error)?).map_err(|_| unreadable())?;
            if state.conversation != conversation {
                return Ok(false);
            }
            let mut saved: SavedConversation = load(&self.conversation).unwrap_or_default();
            saved.messages.push(user);
            saved.messages.push(ChatTurn {
                references: reply.references,
                actions: reply.actions,
                ..ChatTurn::new("assistant", reply.message)
            });
            let keep = saved.messages.len().saturating_sub(SAVED_TURNS);
            saved.messages.drain(..keep);
            save(&self.conversation, &saved)?;
            Ok(true)
        })?;
        if answered {
            self.core.hub.invalidated(Listing::Chat);
        }
        Ok(ChatAnswer {
            answered,
            conversation: self.saved_conversation(),
        })
    }

    fn clear(&self) -> Result<ChatConversation, RpcError> {
        with_state(&self.conversation, |state| {
            if state.sending {
                return Err(busy("answering"));
            }
            // An action still in flight reports into the conversation it
            // was proposed in, never into this one.
            state.conversation += 1;
            state.pending_actions.clear();
            save(&self.conversation, &SavedConversation::default())
        })?;
        self.core.hub.invalidated(Listing::Chat);
        Ok(self.saved_conversation())
    }

    async fn act(self, action_id: String) -> Result<ActResult, RpcError> {
        let started = with_state(&self.conversation, |state| {
            let mut saved: SavedConversation = load(&self.conversation).unwrap_or_default();
            let action = saved
                .messages
                .iter()
                .flat_map(|t| &t.actions)
                .find(|a| a.id == action_id)
                .cloned()
                .ok_or_else(|| {
                    RpcError::new(
                        ErrorKind::NotFound,
                        "Skip did not propose this action in the current conversation.",
                    )
                })?;
            if action.kind != "send_message" {
                return Err(RpcError::invalid_params(
                    "This build can only send messages Skip proposes.",
                ));
            }
            if let Some(receipt) = saved.receipts.get(&action_id) {
                return Ok(Err(receipt.clone()));
            }
            if state.pending_actions.contains(&action_id) {
                return Ok(Err(SendReceipt::sending()));
            }
            let (registration, cloud) = self.core.store.read(|store| {
                (
                    store
                        .registrations
                        .iter()
                        .find(|r| r.target.key() == action.agent_id)
                        .cloned(),
                    store.cloud.clone(),
                )
            });
            let registration = registration.ok_or_else(|| {
                RpcError::new(
                    ErrorKind::NotFound,
                    "This agent is no longer addressable. Enable the session in Agents before sending.",
                )
            })?;
            if !belongs_to_cloud(&registration, cloud.as_ref()) {
                return Err(RpcError::new(
                    ErrorKind::Refused,
                    "This session belongs to a different Agent Relay workspace. Connect the account workspace in Agents before sending.",
                ));
            }
            // Saved before dispatch: an uncertain result is never retried.
            state.pending_actions.insert(action_id.clone());
            saved
                .receipts
                .insert(action_id.clone(), SendReceipt::sending());
            if let Err(error) = save(&self.conversation, &saved) {
                state.pending_actions.remove(&action_id);
                return Err(error);
            }
            Ok(Ok((
                state.conversation,
                state.epoch,
                registration.name,
                action.message,
            )))
        })?;
        let (conversation, epoch, name, message) = match started {
            Ok(started) => started,
            Err(receipt) => return Ok(ActResult { action_id, receipt }),
        };
        self.core.hub.invalidated(Listing::Chat);
        // Nothing is sent as the person after they signed out.
        if with_state(&self.conversation, |state| state.epoch) != epoch {
            return Err(signed_out());
        }
        let result = self.send_as_person(&name, &message).await;
        let receipt = SendReceipt::outcome(&name, &result);
        with_state(&self.conversation, |state| {
            state.pending_actions.remove(&action_id);
            if state.conversation != conversation {
                return Ok(());
            }
            let mut saved: SavedConversation = load(&self.conversation).unwrap_or_default();
            saved.receipts.insert(action_id.clone(), receipt.clone());
            save(&self.conversation, &saved)
        })?;
        self.core.hub.invalidated(Listing::Chat);
        Ok(ActResult { action_id, receipt })
    }

    async fn history(
        &self,
        session_id: &str,
        source: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<HistoryPage, RpcError> {
        let path = format!(
            "{}?{}",
            self.path("history"),
            history_query(session_id, source, cursor)
        );
        let epoch = with_state(&self.conversation, |state| state.epoch);
        let page: HistoryEventsPage = serde_json::from_value(
            self.core
                .plugins
                .cloud
                .request("GET", path, None)
                .await
                .map_err(cloud_error)?,
        )
        .map_err(|_| unreadable())?;
        // A page fetched for an account signed out meanwhile is not shown.
        if with_state(&self.conversation, |state| state.epoch) != epoch {
            return Err(signed_out());
        }
        let mut seen = HashSet::new();
        let events = page
            .events
            .iter()
            .filter(|e| seen.insert(e.id()))
            .map(HistoryEvent::to_bridge)
            .collect();
        Ok(HistoryPage {
            events,
            next_cursor: page.next_cursor,
        })
    }

    /// Ordinary reads fetch Cloud's persisted report; they never admit inference.
    async fn read_projects(&self) -> Result<ProjectsState, RpcError> {
        let epoch = with_state(&self.conversation, |state| state.epoch);
        match self
            .core
            .plugins
            .cloud
            .request("GET", self.path("projects"), None)
            .await
        {
            Ok(value) => self.accept_project_reply(epoch, value),
            Err(error) => with_state(&self.conversation, |state| {
                if state.epoch != epoch {
                    return Err(signed_out());
                }
                let saved = load::<SavedProjects>(&self.projects);
                let mut view = projects_of(saved.as_ref(), state.refreshing, now_ms());
                match error {
                    // Older Cloud deployments have only POST.
                    CloudError::Status {
                        status: 404 | 405, ..
                    } => {
                        view.durable = Some(false);
                        Ok(view)
                    }
                    CloudError::Unreachable
                    | CloudError::Status {
                        status: 500..=599, ..
                    } if saved.is_some() => {
                        // An outage cannot identify the server's generation mode.
                        // Keep it unknown so clients never auto-admit model work.
                        view.stale = true;
                        view.error =
                            Some("Cloud is unavailable. Showing the saved project report.".into());
                        Ok(view)
                    }
                    other => Err(cloud_error(other)),
                }
            }),
        }
    }

    fn accept_project_reply(&self, epoch: u64, value: Value) -> Result<ProjectsState, RpcError> {
        let durable = value.get("enabled") == Some(&Value::Bool(true));
        let (report, remote) = if value.get("enabled") == Some(&Value::Bool(false)) {
            (None, None)
        } else if value.get("enabled") == Some(&Value::Bool(true)) {
            #[derive(Deserialize)]
            struct Cached {
                result: Option<SkipProjectsReport>,
                status: String,
                stale: bool,
            }
            let cached: Cached = serde_json::from_value(value).map_err(|_| unreadable())?;
            let message = match cached.status.as_str() {
                "blocked_configuration" => Some("Project summaries need service configuration. Ask an administrator to check the model and History connections."),
                "blocked_identity" => Some("Project summaries need an authorized workspace member. Refresh after restoring workspace access."),
                "failed" => Some("Project summary generation failed. Refresh to retry."),
                "queued" | "running" | "complete" | "missing" => None,
                _ => return Err(unreadable()),
            };
            if let Some(message) = message {
                return Err(RpcError::new(ErrorKind::CloudFailed, message));
            }
            let refreshing = matches!(cached.status.as_str(), "queued" | "running");
            (cached.result, Some((cached.stale, refreshing)))
        } else {
            (
                Some(
                    serde_json::from_value::<SkipProjectsReport>(value)
                        .map_err(|_| unreadable())?,
                ),
                None,
            )
        };
        let accepted = with_state(&self.conversation, |state| -> Result<bool, RpcError> {
            if state.epoch != epoch {
                return Ok(false);
            }
            if let Some(report) = report {
                let saved = load::<SavedProjects>(&self.projects);
                // A slower read must not replace a newer completed report.
                if saved
                    .as_ref()
                    .is_none_or(|old| old.report.generated_ms() <= report.generated_ms())
                {
                    let horizon = now_ms() - RECEIPT_HORIZON_MS;
                    let mut receipts = saved.map(|s| s.receipts).unwrap_or_default();
                    receipts.retain(|_, r| r.at_ms.is_some_and(|at| at > horizon));
                    save(&self.projects, &SavedProjects { report, receipts })?;
                }
            }
            Ok(true)
        })?;
        let mut view = self.project_view();
        if accepted {
            view.durable = Some(durable);
            if let Some((stale, refreshing)) = remote {
                view.stale = stale;
                view.refreshing |= refreshing;
            }
        }
        Ok(view)
    }

    async fn refresh_projects(self) -> Result<ProjectsState, RpcError> {
        let (epoch, previous) = with_state(&self.conversation, |state| {
            if state.refreshing {
                return Err(busy("building the project view"));
            }
            state.refreshing = true;
            let saved: Option<SavedProjects> = load(&self.projects);
            Ok((
                state.epoch,
                saved.map(|s| s.report.previous()).unwrap_or_default(),
            ))
        })?;
        let body = json!({"timezone": self.timezone(), "previous": previous});
        let answer = self
            .core
            .plugins
            .cloud
            .request("POST", self.path("projects"), Some(body))
            .await;
        with_state(&self.conversation, |state| {
            if state.epoch == epoch {
                state.refreshing = false;
            }
        });
        let view = self.accept_project_reply(epoch, answer.map_err(cloud_error)?)?;
        self.core.hub.invalidated(Listing::Projects);
        Ok(view)
    }

    async fn push(self, keys: Vec<String>) -> Result<PushResult, RpcError> {
        let mut results = Vec::new();
        for key in keys {
            let (outcome, detail) = self.push_one(&key).await?;
            results.push(PushOutcome {
                push_key: key,
                outcome,
                detail,
            });
        }
        Ok(PushResult {
            results,
            projects: self.project_view(),
        })
    }

    /// Sends Skip's nudge to the session `key` names, as the person, putting
    /// the session on the relay first when it is not yet. Answers the
    /// outcome and, when it did not send, why.
    async fn push_one(&self, key: &str) -> Result<(PushOutcomeKind, Option<String>), RpcError> {
        // What the current report says now: a refresh may have reworded the
        // nudge since the UI drew it.
        let started = with_state(&self.conversation, |state| {
            let saved: Option<SavedProjects> = load(&self.projects);
            let Some(saved) = saved else {
                return Err(PushOutcomeKind::NotPushable);
            };
            let Some(session) = saved
                .report
                .pushable()
                .find(|s| s.push_key().as_deref() == Some(key))
                .cloned()
            else {
                return Err(PushOutcomeKind::NotPushable);
            };
            if saved.receipts.contains_key(key) || !state.pending_pushes.insert(key.into()) {
                return Err(PushOutcomeKind::AlreadyPushed);
            }
            Ok((state.epoch, session))
        });
        let (epoch, pushed) = match started {
            Ok(started) => started,
            Err(outcome) => return Ok((outcome, None)),
        };
        let result = self.deliver_push(key, epoch, &pushed).await;
        with_state(&self.conversation, |state| {
            state.pending_pushes.remove(key);
        });
        if result.is_ok() {
            self.core.hub.invalidated(Listing::Projects);
        }
        result
    }

    async fn deliver_push(
        &self,
        key: &str,
        epoch: u64,
        pushed: &SkipProjectSession,
    ) -> Result<(PushOutcomeKind, Option<String>), RpcError> {
        let sessions = self.sessions().await;
        let Some(session) = sessions
            .iter()
            .find(|s| s.target.upload_key().as_deref() == Some(pushed.key().as_str()))
        else {
            return Ok((PushOutcomeKind::NotOnThisComputer, None));
        };
        let Some(cloud) = self.cloud_workspace() else {
            return Ok((PushOutcomeKind::AccountWorkspaceNotConnected, None));
        };
        let mut registration = self
            .core
            .store
            .read(|s| s.registration_for(&session.target).cloned());
        if registration.is_none() {
            // Registering on any other workspace would leave the session
            // there and still not reach it from this account.
            let here = self.core.workspace();
            if !here.is_some_and(|w| w.key == cloud.key && w.base_url == cloud.base_url) {
                return Ok((PushOutcomeKind::OtherWorkspace, None));
            }
            if let Err(error) = self.core.register_session(session, None, None, false).await {
                return Ok((PushOutcomeKind::RegisterFailed, Some(error.message)));
            }
            registration = self
                .core
                .store
                .read(|s| s.registration_for(&session.target).cloned());
        }
        let Some(registration) = registration else {
            return Ok((PushOutcomeKind::RegisterFailed, None));
        };
        if !belongs_to_cloud(&registration, Some(&cloud)) {
            return Ok((PushOutcomeKind::OtherWorkspace, Some(registration.name)));
        }
        let record = |receipt: SendReceipt| {
            with_state(&self.conversation, |state| {
                if state.epoch != epoch {
                    return Ok(false);
                }
                let Some(mut saved) = load::<SavedProjects>(&self.projects) else {
                    return Ok(false);
                };
                saved.receipts.insert(key.into(), receipt);
                save(&self.projects, &saved).map(|_| true)
            })
        };
        // Saved before dispatch: an uncertain result is never retried.
        if !record(SendReceipt::sending())? {
            return Ok((PushOutcomeKind::NotPushable, None));
        }
        let nudge = pushed.nudge.clone().unwrap_or_default();
        let result = self.send_as_person(&registration.name, &nudge).await;
        let receipt = SendReceipt::outcome(&registration.name, &result);
        record(receipt.clone())?;
        Ok(match receipt.state {
            ReceiptState::Sent => (PushOutcomeKind::Sent, None),
            _ => (PushOutcomeKind::Unconfirmed, receipt.detail),
        })
    }
}

fn turn_of(turn: &ChatTurn, receipts: &BTreeMap<String, SendReceipt>) -> ConversationTurn {
    ConversationTurn {
        id: turn.id.clone(),
        role: turn.role.clone(),
        content: turn.content.clone(),
        references: turn
            .references
            .iter()
            .map(|r| TurnReference {
                session_id: r.session_id.clone(),
                source: r.source.clone(),
                title: r.title.clone(),
                url: r.url.clone(),
            })
            .collect(),
        actions: turn
            .actions
            .iter()
            .map(|a| TurnAction {
                id: a.id.clone(),
                kind: a.kind.clone(),
                agent_id: a.agent_id.clone(),
                message: a.message.clone(),
                receipt: receipts.get(&a.id).cloned(),
            })
            .collect(),
    }
}

/// `chat.conversation`'s result.
pub fn conversation_of(saved: &SavedConversation, sending: bool) -> ChatConversation {
    ChatConversation {
        messages: saved
            .messages
            .iter()
            .map(|t| turn_of(t, &saved.receipts))
            .collect(),
        sending,
    }
}

/// `chat.projects`'s result.
pub fn projects_of(saved: Option<&SavedProjects>, refreshing: bool, now_ms: i64) -> ProjectsState {
    let report = saved.map(|saved| {
        let r = &saved.report;
        ProjectsReport {
            generated_at: r.generated_at.clone(),
            briefing: r.briefing.clone(),
            projects: r
                .projects
                .iter()
                .map(|p| Project {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    summary: p.summary.clone(),
                    state: p.state,
                    next: p.next.clone(),
                    repositories: p.repositories.clone(),
                    last_active_at: p.last_active_at.clone(),
                    sessions: p
                        .sessions
                        .iter()
                        .map(|s| {
                            let push_key = s.push_key();
                            ProjectSession {
                                key: s.key(),
                                session_id: s.session_id.clone(),
                                source: s.source.clone(),
                                title: s.title.clone(),
                                state: s.state,
                                reason: s.reason.clone(),
                                nudge: s.nudge.clone(),
                                last_active_at: s.last_active_at.clone(),
                                receipt: push_key
                                    .as_ref()
                                    .and_then(|k| saved.receipts.get(k))
                                    .cloned(),
                                push_key,
                            }
                        })
                        .collect(),
                })
                .collect(),
        }
    });
    ProjectsState {
        durable: None,
        error: None,
        report,
        stale: saved.is_none_or(|s| s.report.is_stale(now_ms)),
        refreshing,
    }
}

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    Some(match method {
        method::ChatConversation::NAME => {
            answer::<method::ChatConversation, _>(raw, |_| async {
                Ok(chat(core)?.saved_conversation())
            })
            .await
        }
        method::ChatSend::NAME => {
            answer::<method::ChatSend, _>(raw, |request| async move {
                let text = request.text.trim().to_string();
                if text.is_empty() {
                    return Err(RpcError::invalid_params("Ask Skip something first."));
                }
                if text.chars().count() > TURN_CHARS {
                    return Err(RpcError::invalid_params(
                        "Keep your message under 12,000 characters.",
                    ));
                }
                detached(chat(core)?.send(text)).await
            })
            .await
        }
        method::ChatClear::NAME => {
            answer::<method::ChatClear, _>(raw, |_| async { chat(core)?.clear() }).await
        }
        method::ChatAct::NAME => {
            answer::<method::ChatAct, _>(raw, |request| async move {
                detached(chat(core)?.act(request.action_id)).await
            })
            .await
        }
        method::ChatHistory::NAME => {
            answer::<method::ChatHistory, _>(raw, |request| async move {
                if request.session_id.is_empty() {
                    return Err(RpcError::invalid_params("Name the session to read."));
                }
                chat(core)?
                    .history(
                        &request.session_id,
                        request.source.as_deref(),
                        request.cursor.as_deref(),
                    )
                    .await
            })
            .await
        }
        method::ChatProjects::NAME => {
            answer::<method::ChatProjects, _>(raw, |_| async { chat(core)?.read_projects().await })
                .await
        }
        method::ChatProjectsRefresh::NAME => {
            answer::<method::ChatProjectsRefresh, _>(raw, |_| async {
                detached(chat(core)?.refresh_projects()).await
            })
            .await
        }
        method::ChatPush::NAME => {
            answer::<method::ChatPush, _>(raw, |request| async move {
                detached(chat(core)?.push(request.push_keys)).await
            })
            .await
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests;
