//! Who is in the workspace: its people (Agent Relay Cloud's members) and
//! its agents (Relaycast's roster).
//!
//! Members come from `GET <site>/cloud/api/v1/members` with the signed-in
//! person's session. `people.list` keeps only a name, an avatar URL and a
//! one-way identity hash (Cloud's email, role and join date are dropped at
//! once); contractor access also needs the user id, role and join date to
//! address a seat in Cloud's access API (`relay::contractor_access`). An
//! agent registered from a desktop carries its owner in metadata
//! (`cloud_user_id`, `cloud_workspace_id` and `owner_hash`); the roster
//! groups by the hash, so the UI never handles a Cloud user id.
//!
//! The roster is `GET /v1/agents?status=active|all` with the workspace key:
//! `active` is what Relaycast saw within its liveness window and is small;
//! `all` can be thousands of rows and is read only when asked for. Raw
//! agent metadata never leaves the core; each entry is reduced to the
//! public fields below.
//!
//! Each entry carries its `liveness`, what a message sent to it now meets:
//! Relaycast's presence (`status`, `last_seen`, and whether `address` still
//! names a host), and for an agent registered from this computer, whether
//! its session is running, which only this computer knows.

use crate::relay::cloud_session::CloudAccess;
use crate::relay::contract::directory::{Recipient, Roster};
use crate::relay::daemon::Core;
use crate::relay::links::Endpoint;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::state::{now_ms, Level};
use crate::relay::{
    activity::publication::roster_rows, agents::is_listed, sdk_gaps, store::Target,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

mod roster_metadata;
use roster_metadata::{describe, provider_of, REMOTE_SESSION_KINDS};

/// An opaque, stable join key for a person on the roster.
pub fn identity_hash(identifier: &str) -> String {
    Sha256::digest(identifier.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The account's own avatar when it is https, otherwise the standard
/// Gravatar for the email.
pub fn avatar_url(account_avatar: Option<&str>, email: Option<&str>, size: u32) -> Option<String> {
    let direct = account_avatar.map(str::trim).unwrap_or_default();
    if direct.starts_with("https://") {
        return Some(direct.into());
    }
    let email = email
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())?;
    let digest = md5_hex(email.as_bytes());
    Some(format!(
        "https://www.gravatar.com/avatar/{digest}?d=identicon&s={}",
        size.clamp(16, 512)
    ))
}

/// A workspace member, as `people.list` reports them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
pub struct WorkspacePerson {
    pub name: String,
    pub avatar_url: Option<String>,
    pub identity_hash: String,
    /// The signed-in person.
    pub is_self: bool,
}

/// A Cloud member: the person plus what Cloud's access API addresses
/// them by. Never sent over the bridge as is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub user_id: String,
    pub person: WorkspacePerson,
    /// Cloud's role, lowercased (`owner`, `member`, …).
    pub role: String,
    pub joined_at_ms: Option<i64>,
}

/// One entry of Cloud's `members`; `None` without a user id.
pub fn decode_member(member: &Value, self_user_id: Option<&str>) -> Option<Member> {
    let user_id = member["userId"].as_str().filter(|id| !id.is_empty())?;
    let field = |key: &str| {
        member[key]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let name = field("name").or(field("email")).unwrap_or(user_id);
    Some(Member {
        user_id: user_id.into(),
        person: WorkspacePerson {
            name: name.into(),
            avatar_url: avatar_url(field("avatarUrl"), field("email"), 96),
            identity_hash: identity_hash(user_id),
            is_self: self_user_id == Some(user_id),
        },
        role: field("role").unwrap_or_default().to_lowercase(),
        joined_at_ms: field("joinedAt")
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|d| d.timestamp_millis()),
    })
}

/// Cloud's `{"members": [...]}`; a member without a user id is skipped.
pub fn decode_member_list(value: &Value, self_user_id: Option<&str>) -> Vec<Member> {
    value["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|member| decode_member(member, self_user_id))
        .collect()
}

/// Cloud's `{"members": [...]}` as people, sorted by name.
pub fn decode_members(value: &Value, self_user_id: Option<&str>) -> Vec<WorkspacePerson> {
    let mut people: Vec<WorkspacePerson> = decode_member_list(value, self_user_id)
        .into_iter()
        .map(|member| member.person)
        .collect();
    people.sort_by_key(|person| person.name.to_lowercase());
    people
}

/// Where a roster agent runs.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "other_desktop"))]
pub enum RosterWhere {
    /// Registered from this computer.
    ThisComputer,
    Cloud,
    /// Another desktop.
    OtherDesktop,
}

impl RosterWhere {
    pub fn as_str(self) -> &'static str {
        match self {
            RosterWhere::ThisComputer => "this_computer",
            RosterWhere::Cloud => "cloud",
            RosterWhere::OtherDesktop => "other_desktop",
        }
    }
}

/// How long Relaycast counts an agent present after it last saw it (the
/// engine's `AGENT_LIVENESS_TTL_MS`). Relaycast expires `active` itself; an
/// agent that reported `idle`, `waiting` or `blocked` keeps that status, so
/// the same window decides whether it is still there.
pub const LIVENESS_WINDOW_MS: i64 = 5 * 60 * 1000;

/// Whether a roster agent is running, as Relaycast's presence and this
/// computer's sessions say. A hint for whether a reply can come: what
/// happened to a message is its [`MessageState`].
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "offline"))]
pub enum Liveness {
    /// Working: Relaycast saw it within its liveness window; a session on
    /// this computer is running.
    Live,
    /// Running, and reported itself idle, waiting or blocked within the
    /// window.
    Idle,
    /// Not seen within the window, or a session on this computer that is
    /// not running.
    Offline,
}

impl Liveness {
    /// Whether it is running now.
    pub fn is_running(self) -> bool {
        matches!(self, Liveness::Live | Liveness::Idle)
    }
}

/// What Relaycast holds for one message to an agent: its delivery row in
/// the agent's `pending_deliveries`, or that it has none.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "queued"))]
pub enum MessageState {
    /// Relaycast holds it: not yet handed to the agent's host.
    Queued,
    /// Relaycast handed it to the agent's host, which has not acknowledged
    /// it yet.
    Delivered,
    /// Relaycast no longer holds it: the agent acknowledged it (or refused
    /// it).
    PickedUp,
    /// Picked up by an agent on this computer whose Claude Code holds it for
    /// the person's approval before the session sees it.
    HeldForApproval,
    /// No agent has that name or address.
    NoSuchAgent,
}

/// How many rows `GET /v1/agents/{name}` lists in `pending_deliveries`,
/// oldest first: a message missing from a full list may still be pending.
const PENDING_DELIVERIES_LISTED: usize = 50;

/// What Relaycast's agent `record` says about `message_id`; `None` when
/// the record cannot tell (a server without `pending_deliveries`, an
/// unknown row status, or a full list without it).
pub fn message_state(record: &Value, message_id: &str) -> Option<MessageState> {
    let pending = record["pending_deliveries"].as_array()?;
    match pending.iter().find(|row| row["message_id"] == message_id) {
        Some(row) => match row["status"].as_str()? {
            "queued" => Some(MessageState::Queued),
            "delivered" => Some(MessageState::Delivered),
            _ => None,
        },
        None if pending.len() >= PENDING_DELIVERIES_LISTED => None,
        None => Some(MessageState::PickedUp),
    }
}

/// One roster entry, reduced to what the UI and sessions may see.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
pub struct RosterAgent {
    pub name: String,
    pub address: Option<String>,
    /// `agent`, `human` or `service`.
    pub kind: String,
    #[serde(rename = "where")]
    pub where_runs: RosterWhere,
    /// `active` or `idle`: Relaycast's status, any other than `active`
    /// reading `idle`.
    pub status: String,
    /// Whether it is running now: a hint for whether a reply can come.
    pub liveness: Liveness,
    pub last_seen_ms: Option<i64>,
    /// Its objective, else native title, role and project, or persona.
    pub description: String,
    /// The desktop it runs on, as that desktop named itself.
    pub host: Option<String>,
    /// Its owner's identity hash, for grouping under people.
    pub owner_hash: Option<String>,
    /// The uploaded session whose saved Cloud overview describes this agent.
    pub session_id: Option<String>,
    /// Owned by the signed-in person.
    pub is_self: bool,
    /// The harness behind it (`codex`, `claude`, `grok`, `opencode`,
    /// `cursor-cloud`, `capy`), from the registrar's `session_kind`, else the
    /// name's prefix; absent when neither says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// What it is doing, as the desktop it runs on derived it from the
    /// session's own records (`relay::activity`): only while it is live,
    /// and only for a session shared with the workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<crate::relay::activity::AgentActivity>,
}

/// A Relaycast agent record's liveness at `now_ms`. `local_live` is set for
/// an agent registered from this computer: whether its session runs.
pub fn liveness(
    value: &Value,
    last_seen_ms: Option<i64>,
    local_live: Option<bool>,
    now_ms: i64,
) -> Liveness {
    if let Some(running) = local_live {
        return if running {
            Liveness::Live
        } else {
            Liveness::Offline
        };
    }
    // A record without `last_seen` is trusted as Relaycast derived it.
    let seen_recently =
        last_seen_ms.is_none_or(|seen| now_ms - seen.min(now_ms) <= LIVENESS_WINDOW_MS);
    // A desktop marks its registration `idle` when the session ends and
    // `active` when it runs again: there `idle` is an ended session.
    let from_desktop = value["metadata"]["source"] == "relay-desktop";
    match value["status"].as_str().unwrap_or_default() {
        "active" | "online" if seen_recently => Liveness::Live,
        "idle" if from_desktop => Liveness::Offline,
        "idle" | "waiting" | "blocked" if seen_recently => Liveness::Idle,
        _ => Liveness::Offline,
    }
}

/// Keeps the first row of each name. The per-status reads run together, so
/// an agent whose status changes meanwhile can be in two answers; the
/// earlier status read wins.
fn one_row_per_name(items: &mut Vec<Value>) {
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(item["name"].as_str().unwrap_or_default().to_string()));
}

/// Decodes `GET /v1/agents` entries: active first, then most recently seen.
/// `local` maps the names registered from this computer to whether their
/// session runs.
pub fn decode_roster(
    items: &[Value],
    local: &HashMap<String, bool>,
    own_hash: Option<&str>,
    now_ms: i64,
) -> Vec<RosterAgent> {
    let mut agents: Vec<RosterAgent> = items
        .iter()
        .filter_map(|value| {
            let name = value["name"].as_str().filter(|n| !n.is_empty())?;
            let metadata = Some(&value["metadata"]).filter(|m| is_listed(m))?;
            let source = metadata["source"].as_str().unwrap_or_default();
            // Hosted provider agents run in their provider's cloud, never a desktop.
            let remote_kind = metadata["session_kind"]
                .as_str()
                .is_some_and(|kind| REMOTE_SESSION_KINDS.contains(&kind));
            let cloud = metadata["cloud_agent_id"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
                || source.starts_with("cloud")
                || remote_kind;
            let raw_kind = value["type"].as_str().unwrap_or("agent");
            let kind = if ["agent", "human", "service"].contains(&raw_kind) {
                raw_kind
            } else {
                "service"
            };
            let where_runs = if local.contains_key(name) {
                RosterWhere::ThisComputer
            } else if cloud {
                RosterWhere::Cloud
            } else {
                RosterWhere::OtherDesktop
            };
            let owner_hash = metadata["owner_hash"]
                .as_str()
                .filter(|h| !h.is_empty())
                .map(str::to_string);
            let last_seen_ms = value["last_seen"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|d| d.timestamp_millis());
            Some(RosterAgent {
                provider: provider_of(name, metadata),
                activity: None,
                liveness: liveness(value, last_seen_ms, local.get(name).copied(), now_ms),
                name: name.into(),
                address: value["address"]
                    .as_str()
                    .filter(|a| !a.is_empty())
                    .map(str::to_string),
                kind: kind.into(),
                where_runs,
                status: if value["status"] == "active" {
                    "active"
                } else {
                    "idle"
                }
                .into(),
                last_seen_ms,
                description: describe(metadata, &value["persona"]),
                // A hosted agent may publish no machine; name its provider.
                host: metadata["host"]
                    .as_str()
                    .map(str::trim)
                    .filter(|h| !h.is_empty())
                    .map(str::to_string)
                    .or_else(|| match metadata["session_kind"].as_str() {
                        Some("capy") => Some("Capy".to_string()),
                        Some("cursor-cloud") => Some("Cursor Cloud".to_string()),
                        Some("replicas") => Some("Replicas".to_string()),
                        _ => None,
                    }),
                session_id: roster_metadata::history_session_id(metadata),
                is_self: own_hash.is_some() && owner_hash.as_deref() == own_hash,
                owner_hash,
            })
        })
        .collect();
    agents.sort_by_key(|a| {
        (
            a.status != "active",
            std::cmp::Reverse(a.last_seen_ms.unwrap_or(i64::MIN)),
        )
    });
    agents
}

/// The Relaycast statuses of a running agent, read for the default roster:
/// `status=all` can be thousands of rows.
const RUNNING_STATUSES: [&str; 5] = ["active", "online", "idle", "waiting", "blocked"];

/// What `roster.list` narrows to.
#[derive(Clone, Debug, Default)]
pub struct RosterQuery {
    pub where_runs: Option<RosterWhere>,
    pub include_idle: bool,
    pub q: Option<String>,
}

impl RosterQuery {
    pub fn matches(&self, agent: &RosterAgent) -> bool {
        if self.where_runs.is_some_and(|w| w != agent.where_runs) {
            return false;
        }
        match self.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
            None => true,
            Some(q) => {
                let q = q.to_lowercase();
                [
                    Some(&agent.name),
                    agent.address.as_ref(),
                    Some(&agent.description),
                ]
                .into_iter()
                .flatten()
                .any(|field| field.to_lowercase().contains(&q))
            }
        }
    }
}

impl Core {
    /// The workspace's people, from Agent Relay Cloud.
    pub async fn people(&self) -> Result<Vec<WorkspacePerson>, RpcError> {
        let account = self.plugins.cloud.account();
        let value = members_response(self.plugins.cloud.as_ref()).await?;
        Ok(decode_members(
            &value,
            account.and_then(|a| a.user_id).as_deref(),
        ))
    }

    /// The workspace's agents, with this computer's own marked, and the
    /// Relaycast statuses that could not be read. Relaycast filters by one
    /// status per request, so the default roster is one read per running
    /// status; a failed read leaves out only its agents, and the list fails
    /// only when every read does.
    pub async fn roster(
        &self,
        query: &RosterQuery,
    ) -> Result<(Vec<RosterAgent>, Vec<String>), RpcError> {
        let (workspace, http) = self.roster_client()?;
        let statuses: &[&str] = if query.include_idle {
            &["all"]
        } else {
            &RUNNING_STATUSES
        };
        let mut items = Vec::new();
        let mut unread = Vec::new();
        let mut failure = None;
        let workspace_scope = self.relaycast_scope(&workspace.base_url, &workspace.key);
        for status in statuses {
            if !self.relaycast_poll_allowed(&workspace_scope) {
                unread.push(status.to_string());
                continue;
            }
            let read = sdk_gaps::list_agents(&http, status).await;
            self.observe_relaycast_result(&workspace_scope, &read);
            match read {
                Ok(listed) => items.extend(listed),
                Err(error) => {
                    unread.push(status.to_string());
                    failure.get_or_insert(error);
                }
            }
        }
        if let Some(error) = failure {
            if unread.len() == statuses.len() {
                return Err(RpcError::from_relaycast(&error));
            }
            self.hub.activity(
                Level::Warning,
                format!(
                    "The roster is missing {} agents: {}",
                    unread.join(", "),
                    RpcError::from_relaycast(&error).message
                ),
            );
        } else if unread.len() == statuses.len() {
            return Err(RpcError::new(
                ErrorKind::RateLimited,
                "The Agent Relay roster is paused while its request limit recovers.",
            ));
        }
        one_row_per_name(&mut items);
        let local = self.local_liveness(&workspace).await;
        let own = self.owner_hash();
        let agents = roster_rows(self, &items, &local, own.as_deref())
            .into_iter()
            .filter(|agent| query.include_idle || agent.liveness.is_running())
            .filter(|agent| query.matches(agent))
            .collect();
        Ok((agents, unread))
    }

    /// The roster's record of one endpoint (a name, or an exact address
    /// whose name part is every reading before an `@`, as Relaycast reads
    /// it), and with `message_id`, what Relaycast holds for that message.
    /// Read only in the workspace your messages go to; elsewhere nothing is
    /// known.
    pub async fn recipient(
        &self,
        endpoint: &Endpoint,
        message_id: Option<&str>,
    ) -> Result<Recipient, RpcError> {
        if !self.roster_is_messaging_workspace().await {
            return Ok(Recipient {
                known: false,
                agent: None,
                message: None,
            });
        }
        let (workspace, http) = self.roster_client()?;
        let value = endpoint.value();
        let names: Vec<&str> = match endpoint {
            Endpoint::Name(name) => vec![name.as_str()],
            Endpoint::Address(address) => address
                .char_indices()
                .filter(|(index, c)| *c == '@' && *index > 0)
                .map(|(index, _)| &address[..index])
                .collect(),
        };
        let mut found = Vec::new();
        for name in names {
            match sdk_gaps::get_agent(&http, name).await {
                Ok(Some(item)) => found.push(item),
                Ok(None) => {}
                Err(error) => return Err(RpcError::from_relaycast(&error)),
            }
        }
        let local = self.local_liveness(&workspace).await;
        let own = self.owner_hash();
        let matches = |name: &str, address: Option<&str>| match endpoint {
            Endpoint::Name(wanted) => name == wanted,
            Endpoint::Address(_) => address == Some(value),
        };
        let agent = roster_rows(self, &found, &local, own.as_deref())
            .into_iter()
            .find(|agent| matches(&agent.name, agent.address.as_deref()));
        let message = message_id.and_then(|id| match &agent {
            None => Some(MessageState::NoSuchAgent),
            Some(agent) => found
                .iter()
                .find(|record| record["name"] == agent.name.as_str())
                .and_then(|record| self.held_state(id, message_state(record, id))),
        });
        Ok(Recipient {
            known: true,
            agent,
            message,
        })
    }

    /// The workspace and a client for its roster, with the workspace key.
    fn roster_client(
        &self,
    ) -> Result<
        (
            crate::relay::workspace::Workspace,
            crate::relay::diagnostic_http::HttpClient,
        ),
        RpcError,
    > {
        let workspace = self.workspace().ok_or_else(|| {
            RpcError::new(
                ErrorKind::NotSignedIn,
                "No Agent Relay workspace key was found.",
            )
        })?;
        let http = sdk_gaps::http(&workspace.base_url, &workspace.key)
            .map_err(|e| RpcError::from_relaycast(&e))?;
        Ok((workspace, http))
    }

    /// The names registered from this computer in `workspace`, each with
    /// whether its session runs now.
    async fn local_liveness(
        &self,
        workspace: &crate::relay::workspace::Workspace,
    ) -> HashMap<String, bool> {
        let registrations: Vec<(String, Target)> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| {
                    r.base_url == workspace.base_url
                        && self.key_for(r).as_ref() == Some(&workspace.key)
                })
                .flat_map(|r| r.names().into_iter().map(|name| (name, r.target.clone())))
                .collect()
        });
        if registrations.is_empty() {
            return HashMap::new();
        }
        let live: HashSet<Target> = self
            .session_snapshot
            .lock()
            .unwrap()
            .1
            .iter()
            .filter(|session| session.live)
            .map(|session| session.target.clone())
            .collect();
        registrations
            .into_iter()
            .map(|(name, target)| (name, live.contains(&target)))
            .collect()
    }

    /// `roster.list`'s result.
    pub async fn roster_list(&self, query: &RosterQuery) -> Result<Roster, RpcError> {
        let (agents, unread_statuses) = self.roster(query).await?;
        Ok(Roster {
            agents,
            unread_statuses,
            fetched_at_ms: now_ms(),
        })
    }

    /// The Relaycast id of a workspace key's workspace.
    pub(crate) async fn relaycast_workspace_id(
        &self,
        base_url: &str,
        key: &crate::relay::workspace::Secret,
    ) -> relaycast::Result<String> {
        // Through `sdk_gaps`: the SDK's `Workspace` requires `api_key_hash`,
        // which the server no longer sends.
        let http = crate::relay::sdk_gaps::http(base_url, key)?;
        crate::relay::sdk_gaps::workspace_identity(&http)
            .await
            .map(|info| info.id)
    }
}

/// Cloud's `GET /members` body, checked to hold a member list.
pub async fn members_response(cloud: &dyn CloudAccess) -> Result<Value, RpcError> {
    let value = cloud
        .request("GET", "/members".into(), None)
        .await
        .map_err(|e| RpcError::cloud(&e))?;
    if !value["members"].is_array() {
        return Err(RpcError::new(
            ErrorKind::CloudFailed,
            "Agent Relay did not return the workspace's people.",
        ));
    }
    Ok(value)
}

/// MD5 is Gravatar's URL scheme, nothing more.
fn md5_hex(input: &[u8]) -> String {
    use md5::{Digest as _, Md5};
    Md5::digest(input)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {

    #[test]
    fn muse_agents_carry_their_harness() {
        let registered = serde_json::json!({"session_kind": "muse-open"});
        assert_eq!(
            provider_of("anything", &registered).as_deref(),
            Some("muse")
        );
        let named = serde_json::json!({});
        assert_eq!(
            provider_of("muse-agentrelay-com-518ae4", &named).as_deref(),
            Some("muse")
        );
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn capy_threads_carry_their_harness_and_run_in_the_cloud() {
        let items = vec![json!({
            "name": "capy-reviewer",
            "type": "agent",
            "status": "active",
            "last_seen": "2026-09-29T12:00:00Z",
            "metadata": {"session_kind": "capy", "capy_thread_id": "jam_01ABC"}
        })];
        let agents = decode_roster(&items, &HashMap::new(), None, NOW);
        assert_eq!(agents[0].provider.as_deref(), Some("capy"));
        assert_eq!(agents[0].where_runs, RosterWhere::Cloud);
        assert_eq!(agents[0].host.as_deref(), Some("Capy"));
        assert_eq!(
            provider_of("reviewer", &json!({"session_kind": "capy"})).as_deref(),
            Some("capy")
        );
        assert_eq!(
            provider_of("unrelated", &json!({"session_kind": "nope"})),
            None
        );
    }

    #[test]
    fn cursor_cloud_and_replicas_agents_keep_distinct_remote_provider_ids() {
        let items = vec![
            json!({
                "name": "cursor-review",
                "type": "agent",
                "status": "active",
                "last_seen": "2026-09-29T12:00:00Z",
                "metadata": {"session_kind": "cursor-cloud", "cursor_agent_id": "bc-1"}
            }),
            json!({
                "name": "replicas-review",
                "type": "agent",
                "status": "active",
                "last_seen": "2026-09-29T12:00:00Z",
                "metadata": {"session_kind": "replicas", "replica_id": "replica-1"}
            }),
        ];
        let agents = decode_roster(&items, &HashMap::new(), None, NOW);
        let cursor = agents
            .iter()
            .find(|agent| agent.name == "cursor-review")
            .unwrap();
        assert_eq!(cursor.provider.as_deref(), Some("cursor-cloud"));
        assert_eq!(cursor.where_runs, RosterWhere::Cloud);
        assert_eq!(cursor.host.as_deref(), Some("Cursor Cloud"));
        let replicas = agents
            .iter()
            .find(|agent| agent.name == "replicas-review")
            .unwrap();
        assert_eq!(replicas.provider.as_deref(), Some("replicas"));
        assert_eq!(replicas.where_runs, RosterWhere::Cloud);
        assert_eq!(replicas.host.as_deref(), Some("Replicas"));
    }

    /// One minute after the fixtures' `2026-09-29T12:00:00Z`.
    const NOW: i64 = 1_790_683_260_000;

    // AgentPeopleTests.testAccountAvatarWinsAndEmailFallsBackToGravatar and
    // test_avatar_prefers_account_then_gravatar.
    #[test]
    fn the_account_avatar_wins_and_email_falls_back_to_gravatar() {
        assert_eq!(
            avatar_url(
                Some("https://example.com/a.png"),
                Some("person@example.com"),
                96
            )
            .as_deref(),
            Some("https://example.com/a.png")
        );
        assert_eq!(
            avatar_url(None, Some(" Person@Example.com "), 96).as_deref(),
            Some(
                "https://www.gravatar.com/avatar/7de8517bce4457e8390aa4006a1880fb?d=identicon&s=96"
            )
        );
        assert_eq!(
            avatar_url(Some("http://insecure.example/a"), None, 96),
            None
        );
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
    }

    // test_members_decode_avatar_and_sort.
    #[test]
    fn members_decode_with_avatars_sorted_by_name() {
        let people = decode_members(
            &json!({"members": [
                {"userId": "z", "name": "Zed", "email": "z@example.com", "avatarUrl": "https://example.com/z.png", "role": "member"},
                {"userId": "a", "name": "Alice", "email": "a@example.com"},
                {"name": "No id"},
            ]}),
            Some("a"),
        );
        assert_eq!(
            people.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["Alice", "Zed"]
        );
        assert_eq!(
            people[1].avatar_url.as_deref(),
            Some("https://example.com/z.png")
        );
        assert_eq!(people[1].identity_hash, identity_hash("z"));
        assert!(people[0].is_self);
        let text = serde_json::to_string(&people).unwrap();
        assert!(!text.contains("example.com\""), "no email is kept: {text}");
        assert!(!text.contains("\"z\""), "no user id is kept: {text}");
    }

    // test_enable_marks_the_cloud_person_for_teammate_grouping.
    #[test]
    fn identity_hashes_are_sha256() {
        assert_eq!(
            identity_hash("user-1"),
            "c6c289e49e9c05b2145860387b73bcb18df43fb09a1e4a4a9713c76c88bb541b"
        );
    }

    #[test]
    fn native_title_is_a_description_fallback_without_overriding_the_objective() {
        let items = vec![json!({"name": "builder", "status": "active", "metadata": {
            "session_title": "Fix login", "objective": "Review only"
        }})];
        let agents = decode_roster(&items, &HashMap::new(), None, NOW);
        assert_eq!(agents[0].description, "Review only");
        let items = vec![json!({"name": "builder", "status": "active", "metadata": {
            "session_title": "Fix login"
        }})];
        let agents = decode_roster(&items, &HashMap::new(), None, NOW);
        assert_eq!(agents[0].description, "Fix login");
    }

    #[test]
    fn activity_is_shown_only_while_an_agent_is_live() {
        use crate::relay::activity::{AgentActivity, AgentTurn};
        let activity = json!({"turn": "working", "repo": "relay-desktop", "branch": "main", "doing": "Fix login"});
        let items = vec![
            json!({"name": "remote", "status": "active", "metadata": {"activity": activity}}),
            json!({"name": "gone", "status": "active", "last_seen": "2020-01-01T00:00:00Z",
                "metadata": {"activity": activity}}),
            json!({"name": "mine", "status": "active", "metadata": {"activity": activity}}),
            json!({"name": "ended", "status": "active", "metadata": {"activity": activity}}),
        ];
        let local: HashMap<String, bool> =
            [("mine".to_string(), true), ("ended".to_string(), false)].into();
        let mut agents = decode_roster(&items, &local, None, NOW);
        crate::relay::activity::fill_roster(&mut agents, &items, &HashMap::new());
        let find = |agents: &[RosterAgent], name: &str| {
            agents
                .iter()
                .find(|a| a.name == name)
                .unwrap()
                .activity
                .clone()
        };
        let remote = find(&agents, "remote").unwrap();
        assert_eq!(remote.turn, Some(AgentTurn::Working));
        assert_eq!(remote.doing.as_deref(), Some("Fix login"));
        assert_eq!(find(&agents, "gone"), None);
        // This computer's agents say what they do now, from this core.
        let now = AgentActivity {
            turn: Some(AgentTurn::Idle),
            ..Default::default()
        };
        let local = [
            ("mine".to_string(), now.clone()),
            ("ended".to_string(), now.clone()),
        ]
        .into();
        crate::relay::activity::fill_roster(&mut agents, &items, &local);
        assert_eq!(find(&agents, "mine"), Some(now));
        assert_eq!(find(&agents, "ended"), None);
        assert!(find(&agents, "remote").is_some());
    }

    #[test]
    fn gateway_agent_identifiers_are_not_linked_to_history() {
        let items = vec![
            json!({"name": "openclaw", "metadata": {"source": "relay-desktop", "session_kind": "openclaw", "session_id": "main"}}),
            json!({"name": "hermes", "metadata": {"source": "relay-desktop", "session_kind": "hermes", "session_id": "default"}}),
            json!({"name": "explicit-agent", "metadata": {"session_scope": "agent", "session_id": "main"}}),
            json!({"name": "transcript", "metadata": {"session_kind": "openclaw", "session_id": "real-history-id"}}),
        ];
        let agents = decode_roster(&items, &HashMap::new(), None, NOW);
        for agent in agents {
            assert_eq!(
                agent.session_id.as_deref(),
                (agent.name == "transcript").then_some("real-history-id")
            );
        }
    }

    // RelaycastReplyClientTests.testActiveRosterUsesWorkspaceKeyAndRedactsMetadata.
    #[test]
    fn the_roster_is_reduced_to_public_fields() {
        let items = vec![
            json!({"name": "bob", "address": "bob@laptop", "type": "agent", "status": "active",
                "last_seen": "2026-09-29T12:00:00Z",
                "metadata": {"objective": "Fix   the roster", "host": "laptop", "owner_hash": "abc123", "session_id": "session-bob", "secret": "never"}}),
            json!({"name": "alice", "type": "human", "status": "idle", "metadata": {"source": "cloud-worker", "role": "reviewer"}}),
            json!({"name": "mine", "type": "robot", "status": "active", "metadata": {"role": "ci-watcher", "project": "cloud"}}),
            json!({"name": ""}),
            json!("junk"),
        ];
        let local: HashMap<String, bool> = [("mine".to_string(), true)].into();
        let agents = decode_roster(&items, &local, Some("abc123"), NOW);
        assert_eq!(agents.len(), 3);
        let bob = agents.iter().find(|a| a.name == "bob").unwrap();
        assert_eq!(
            bob,
            &RosterAgent {
                name: "bob".into(),
                address: Some("bob@laptop".into()),
                kind: "agent".into(),
                where_runs: RosterWhere::OtherDesktop,
                status: "active".into(),
                liveness: Liveness::Live,
                last_seen_ms: Some(1_790_683_200_000),
                description: "Fix the roster".into(),
                host: Some("laptop".into()),
                owner_hash: Some("abc123".into()),
                session_id: Some("session-bob".into()),
                is_self: true,
                provider: None,
                activity: None,
            }
        );
        let alice = agents.iter().find(|a| a.name == "alice").unwrap();
        assert_eq!(alice.where_runs, RosterWhere::Cloud);
        assert_eq!(alice.status, "idle");
        let mine = agents.iter().find(|a| a.name == "mine").unwrap();
        assert_eq!(mine.where_runs, RosterWhere::ThisComputer);
        assert_eq!(mine.kind, "service");
        assert_eq!(mine.description, "ci-watcher · cloud");
        assert_eq!(agents.last().unwrap().name, "alice", "idle sorts last");
        assert!(!serde_json::to_string(&agents).unwrap().contains("never"));
    }

    #[test]
    fn an_agent_in_two_status_reads_is_listed_once() {
        let mut items = vec![
            json!({"name": "mover", "status": "active"}),
            json!({"name": "other", "status": "active"}),
            json!({"name": "mover", "status": "idle"}),
        ];
        one_row_per_name(&mut items);
        assert_eq!(
            items,
            vec![
                json!({"name": "mover", "status": "active"}),
                json!({"name": "other", "status": "active"}),
            ]
        );
    }

    #[test]
    fn the_harness_comes_from_the_session_kind_the_cli_else_the_name_prefix() {
        let items = vec![
            json!({"name": "api-work", "status": "active", "metadata": {"session_kind": "claude-terminal"}}),
            json!({"name": "builder", "status": "active", "metadata": {"session_kind": "codex"}}),
            json!({"name": "grok-relay-1d77b6", "status": "active", "metadata": {"session_kind": "grok-open"}}),
            json!({"name": "codex-test-node-848f43", "status": "active", "metadata": {}}),
            json!({"name": "Claude-review", "status": "active"}),
            json!({"name": "cursor-pair", "status": "active", "metadata": {"session_kind": "unknown"}}),
            json!({"name": "reviewer", "status": "active", "metadata": {"session_kind": "weird"}}),
            // Fleet workers: the broker records the CLI it spawned.
            json!({"name": "code-desktop-cool", "status": "active", "metadata": {"cli": "claude"}}),
            json!({"name": "ios-check", "status": "active", "metadata": {"cli": "/usr/local/bin/Codex --yolo"}}),
            json!({"name": "pair", "status": "active", "metadata": {"cli": "cursor-agent"}}),
            json!({"name": "codex-gemini", "status": "active", "metadata": {"cli": "gemini"}}),
            json!({"name": "reviewer-two", "status": "active", "metadata": {"cli": "claude-code"}}),
        ];
        let agents = decode_roster(&items, &HashMap::new(), None, NOW);
        let provider = |name: &str| {
            agents
                .iter()
                .find(|a| a.name == name)
                .unwrap()
                .provider
                .clone()
        };
        assert_eq!(provider("api-work").as_deref(), Some("claude"));
        assert_eq!(provider("builder").as_deref(), Some("codex"));
        assert_eq!(provider("grok-relay-1d77b6").as_deref(), Some("grok"));
        assert_eq!(provider("codex-test-node-848f43").as_deref(), Some("codex"));
        assert_eq!(provider("Claude-review").as_deref(), Some("claude"));
        assert_eq!(provider("cursor-pair").as_deref(), Some("cursor"));
        assert_eq!(provider("reviewer"), None);
        assert_eq!(provider("code-desktop-cool").as_deref(), Some("claude"));
        assert_eq!(provider("ios-check").as_deref(), Some("codex"));
        assert_eq!(provider("pair").as_deref(), Some("cursor"));
        assert_eq!(provider("reviewer-two").as_deref(), Some("claude"));
        // A CLI with no icon falls back to the name prefix.
        assert_eq!(provider("codex-gemini").as_deref(), Some("codex"));
        let text = serde_json::to_string(&agents).unwrap();
        assert!(text.contains("\"provider\":\"grok\""));
    }

    #[test]
    fn liveness_reads_presence_and_this_computers_sessions() {
        let fresh = "2026-09-29T12:00:00Z";
        let stale = "2026-09-29T11:00:00Z";
        let items = vec![
            json!({"name": "working", "address": "working@m", "status": "active", "last_seen": fresh}),
            json!({"name": "connected", "address": "connected@m", "status": "online", "last_seen": fresh}),
            json!({"name": "resting", "address": "resting@m", "status": "idle", "last_seen": fresh}),
            json!({"name": "ended", "address": "ended@m", "status": "idle", "last_seen": fresh, "metadata": {"source": "relay-desktop", "session_kind": "codex"}}),
            json!({"name": "stuck", "address": "stuck@m", "status": "blocked", "last_seen": fresh}),
            json!({"name": "silent", "address": "silent@m", "status": "idle", "last_seen": stale}),
            json!({"name": "gone", "address": "gone@m", "status": "offline", "last_seen": fresh}),
            json!({"name": "sdk-agent", "address": null, "status": "active", "last_seen": fresh}),
            json!({"name": "sdk-asleep", "address": null, "status": "offline", "last_seen": stale}),
            json!({"name": "stopped", "address": "stopped@m", "status": "active", "last_seen": fresh}),
            json!({"name": "running", "address": "running@m", "status": "offline", "last_seen": stale}),
        ];
        let local: HashMap<String, bool> = [
            ("stopped".to_string(), false),
            ("running".to_string(), true),
        ]
        .into();
        let agents = decode_roster(&items, &local, None, NOW);
        let of = |name: &str| agents.iter().find(|a| a.name == name).unwrap().liveness;
        assert_eq!(of("working"), Liveness::Live);
        assert_eq!(of("connected"), Liveness::Live);
        assert_eq!(of("resting"), Liveness::Idle);
        assert_eq!(
            of("ended"),
            Liveness::Offline,
            "a desktop marks an ended session idle"
        );
        assert_eq!(of("stuck"), Liveness::Idle);
        assert_eq!(of("silent"), Liveness::Offline);
        assert_eq!(of("gone"), Liveness::Offline);
        assert_eq!(
            of("sdk-agent"),
            Liveness::Live,
            "no address is no node, not an exit"
        );
        assert_eq!(of("sdk-asleep"), Liveness::Offline);
        assert_eq!(
            of("stopped"),
            Liveness::Offline,
            "its session is not running"
        );
        assert_eq!(of("running"), Liveness::Live, "its session runs here");
    }

    #[test]
    fn a_messages_state_is_its_row_in_pending_deliveries() {
        let record = json!({"pending_deliveries": [
            {"message_id": "m1", "status": "queued"},
            {"message_id": "m2", "status": "delivered"},
            {"message_id": "m3", "status": "mystery"},
        ]});
        assert_eq!(message_state(&record, "m1"), Some(MessageState::Queued));
        assert_eq!(message_state(&record, "m2"), Some(MessageState::Delivered));
        assert_eq!(message_state(&record, "m3"), None);
        assert_eq!(message_state(&record, "m4"), Some(MessageState::PickedUp));
        assert_eq!(
            message_state(&json!({}), "m1"),
            None,
            "an older server cannot tell"
        );
        let full: Vec<Value> = (0..PENDING_DELIVERIES_LISTED)
            .map(|i| json!({"message_id": format!("x{i}"), "status": "queued"}))
            .collect();
        assert_eq!(
            message_state(&json!({"pending_deliveries": full}), "m4"),
            None,
            "a full list may have left it out"
        );
    }

    #[test]
    fn roster_queries_filter_by_place_and_text() {
        let agents = decode_roster(
            &[
                json!({"name": "reviewer", "status": "active", "metadata": {"objective": "Reviews pull requests"}}),
                json!({"name": "cloud-bot", "status": "active", "metadata": {"source": "cloud"}}),
            ],
            &HashMap::new(),
            None,
            NOW,
        );
        let query = RosterQuery {
            q: Some("PULL".into()),
            ..RosterQuery::default()
        };
        assert_eq!(agents.iter().filter(|a| query.matches(a)).count(), 1);
        let query = RosterQuery {
            where_runs: Some(RosterWhere::Cloud),
            ..RosterQuery::default()
        };
        assert_eq!(
            agents
                .iter()
                .filter(|a| query.matches(a))
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            ["cloud-bot"]
        );
    }
}
