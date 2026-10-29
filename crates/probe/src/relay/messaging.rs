//! Messaging anyone in the workspace, as you.
//!
//! You message as your one relay identity, which Agent Relay Cloud owns:
//! the same `human` agent the dashboard sends as, so the dashboard, macOS
//! and Linux share one conversation history.
//!
//! ```text
//! POST <site>/cloud/api/v1/workspaces/{id}/messaging/identity/credential ─▶ name, token
//! POST /v1/dm {to|address, text}          (as you) ─▶ conversation_id
//! GET  /v1/dm/conversations               (as you) ─▶ every 1:1 conversation
//! GET  /v1/dm/{id}/messages?limit=50      (as you) ─▶ history, newest first
//! GET  /v1/messages/{id}                  (as you) ─▶ thread_id, which history omits
//! ```
//!
//! Cloud can recover the identity (a fresh token) at any time, which retires
//! the copy held here: a token Relaycast refuses is fetched again, once.
//! Relaycast queues every reply to you as a delivery; they are acknowledged
//! when your conversations are read, and the identity's push socket wakes an
//! open conversation the moment one arrives.
//!
//! An exact `agent@machine` history is shown only with proof from server
//! history: the conversation must list exactly two participants with
//! immutable agent ids, and a message must attribute the exact address to
//! the peer's id. A cached conversation id or a matching name is never
//! enough, so a reused name or machine cannot inherit another identity's
//! history. A conversation without proof is looked for again at most once a
//! minute, sooner when a reply arrives.

use crate::relay::backoff::WorkspaceScope;
use crate::relay::client::{self, Sent};
use crate::relay::cloud_session::{segment, CloudAccount, CloudError};
use crate::relay::contract::directory::Recipient;
use crate::relay::contract::directory::{Conversation, ConversationPeer, Conversations, History};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Attachment;
use crate::relay::links::Endpoint;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::push::PushTarget;
use crate::relay::sdk_gaps;
use crate::relay::state::Listing;
use crate::relay::workspace::{validated_base_url, Secret, Workspace};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// Messages per history page.
pub const HISTORY_LIMIT: u32 = 50;
/// How long an exact-address lookup without proof is not repeated.
pub const EXACT_MISS_TTL: Duration = Duration::from_secs(60);
const DETAILS_KEPT: usize = 2_000;

/// Your relay identity in one Cloud workspace.
#[derive(Clone, Debug)]
pub struct PersonIdentity {
    pub name: String,
    /// Relaycast's immutable agent id for this signed-in person's identity.
    pub agent_id: String,
    pub token: Secret,
    pub base_url: String,
}

/// Whether `workspace` is the Relaycast workspace `identity` sends in. The
/// identity is minted for the signed-in account's Cloud workspace, whose
/// Relaycast key is `account_key`: the daemon's workspace is that one only
/// when it uses the same key on the identity's origin. A CLI workspace on
/// the same origin (two workspaces on `cast.agentrelay.com`) is another
/// workspace, so its roster proves nothing about your sends.
fn is_identity_workspace(
    identity: &PersonIdentity,
    workspace: &Workspace,
    account_key: Option<&Secret>,
) -> bool {
    workspace.base_url == identity.base_url && account_key == Some(&workspace.key)
}

/// The person identity is registered in the team Relaycast workspace, even
/// though it uses its own agent token. Fall back to that token only while no
/// matching team workspace is available (for example during startup, or
/// while the daemon uses a CLI workspace that is not the account's).
fn person_workspace_scope(
    identity: &PersonIdentity,
    workspace: Option<&Workspace>,
    account_key: Option<&Secret>,
) -> WorkspaceScope {
    match workspace.filter(|workspace| is_identity_workspace(identity, workspace, account_key)) {
        Some(workspace) => {
            WorkspaceScope::credential(&workspace.base_url, &workspace.key, "this workspace")
        }
        None => WorkspaceScope::credential(
            &identity.base_url,
            &identity.token,
            "your messaging workspace",
        ),
    }
}

/// What messaging remembers in memory.
#[derive(Default)]
pub struct MessagingState {
    /// `(account key, identity)`: the identity belongs to one signed-in
    /// person in one Cloud workspace on one site.
    identity: Option<(String, PersonIdentity)>,
    /// Conversation ids by `(identity name, endpoint key)`: search hints only.
    conversations: HashMap<(String, String), String>,
    /// Exact-address lookups that found no proof, by `(workspace, identity, endpoint key)`.
    misses: HashMap<(String, String, String), Instant>,
    /// `GET /v1/messages/{id}` answers, scoped to the credential that read them.
    details: HashMap<(String, Secret, String), Value>,
}

/// One message as a conversation shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
pub struct DirectMessage {
    pub id: String,
    pub sender: String,
    pub sender_id: Option<String>,
    pub sender_address: Option<String>,
    pub text: String,
    pub created_at: Option<String>,
    pub thread_id: Option<String>,
    pub mine: bool,
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

mod conversations;
pub use conversations::{direct_conversations, find_conversation};

/// The agent id a desktop address carries: `name@<machine prefix>-<id>`,
/// as `Registration::direct_address` mints it. The id is the immutable
/// part; the machine prefix is only a label.
fn address_agent_id(address: &str) -> Option<(&str, &str)> {
    let (name, machine) = address.split_once('@')?;
    let (_, id) = machine.rsplit_once('-')?;
    (!name.is_empty() && !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .then_some((name, id))
}

/// The immutable `(agent id, address)` this history proves for `address`
/// in `conversation`, or `None`: Relaycast must list exactly two
/// participants with distinct ids, and either the address itself names the
/// peer's immutable agent id and name, or a message attributes `address`
/// to the peer's id and name. A reply an agent sends through the desktop
/// socket carries no address, so the id the address embeds is what proves
/// a desktop agent's conversation.
pub fn endpoint_binding(
    conversation: &Value,
    messages: &[Value],
    address: &str,
    me: &str,
) -> Option<(String, String)> {
    let participants: HashSet<(String, String)> = conversation["participants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((text(&p["agent_id"])?, text(&p["agent_name"])?)))
        .collect();
    let ids: HashSet<&String> = participants.iter().map(|(id, _)| id).collect();
    if participants.len() != 2 || ids.len() != 2 {
        return None;
    }
    if let Some((name, id)) = address_agent_id(address) {
        if name != me && participants.contains(&(id.to_string(), name.to_string())) {
            return Some((id.to_string(), address.to_string()));
        }
    }
    messages.iter().find_map(|item| {
        if item["agent_address"] != address {
            return None;
        }
        let id = text(&item["agent_id"])?;
        let name = text(&item["agent_name"])?;
        (name != me && participants.contains(&(id.clone(), name)))
            .then(|| (id, address.to_string()))
    })
}

fn created_at_ms(value: &Option<String>) -> Option<i64> {
    value
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|d| d.timestamp_millis())
}

/// A message's text, then a `📎 name` line for each file it carries, so
/// the macOS and Linux conversations both show that a file came with it.
fn with_attachment_names(item: &Value) -> String {
    let mut text = item["text"].as_str().unwrap_or_default().to_string();
    for attachment in Attachment::list(&[item]) {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("📎 ");
        text.push_str(&attachment.display_name());
    }
    text
}

/// Messages in reading order: roots oldest first, each followed by its
/// replies, without duplicates. Malformed cycles are harmless.
pub fn threaded(items: &[Value], me: &str) -> Vec<DirectMessage> {
    let mut by_id: Vec<DirectMessage> = Vec::new();
    let mut seen_ids = HashSet::new();
    for item in items {
        let Some(id) = text(&item["id"]) else {
            continue;
        };
        if !seen_ids.insert(id.clone()) {
            continue;
        }
        let sender = item["agent_name"].as_str().unwrap_or_default().to_string();
        by_id.push(DirectMessage {
            mine: sender == me,
            id,
            sender,
            sender_id: text(&item["agent_id"]),
            sender_address: text(&item["agent_address"]),
            text: with_attachment_names(item),
            created_at: text(&item["created_at"]),
            thread_id: text(&item["thread_id"]),
        });
    }
    by_id.sort_by(|a, b| {
        let (at, bt) = (created_at_ms(&a.created_at), created_at_ms(&b.created_at));
        (at.is_none(), at, &a.id).cmp(&(bt.is_none(), bt, &b.id))
    });
    let ids: HashSet<&str> = by_id.iter().map(|m| m.id.as_str()).collect();
    let mut children: HashMap<&str, Vec<&DirectMessage>> = HashMap::new();
    for message in &by_id {
        if let Some(parent) = message.thread_id.as_deref() {
            children.entry(parent).or_default().push(message);
        }
    }
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    fn append<'a>(
        message: &'a DirectMessage,
        children: &HashMap<&str, Vec<&'a DirectMessage>>,
        seen: &mut HashSet<&'a str>,
        result: &mut Vec<DirectMessage>,
    ) {
        if !seen.insert(message.id.as_str()) {
            return;
        }
        result.push(message.clone());
        for child in children.get(message.id.as_str()).into_iter().flatten() {
            append(child, children, seen, result);
        }
    }
    for message in &by_id {
        let root = message
            .thread_id
            .as_deref()
            .is_none_or(|parent| !ids.contains(parent));
        if root {
            append(message, &children, &mut seen, &mut result);
        }
    }
    for message in &by_id {
        append(message, &children, &mut seen, &mut result);
    }
    result
}

fn sign_in_required() -> RpcError {
    RpcError::new(
        ErrorKind::NotSignedIn,
        "Sign in to Agent Relay to message as yourself.",
    )
}

/// Who an identity and everything read with it belong to.
fn account_key(account: &CloudAccount) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        account.site_url,
        account.workspace_id,
        account.user_id.as_deref().unwrap_or_default()
    )
}

/// The key of the person's push channel: `@name`. Agent names never hold
/// `@`, so a local agent with the same name (in another workspace) keeps a
/// channel of its own.
fn person_channel(name: &str) -> String {
    format!("@{name}")
}

impl Core {
    /// The identity in memory, when it belongs to the account signed in
    /// now. Anything read for another account is forgotten.
    fn current_identity(&self) -> Option<PersonIdentity> {
        let key = self.plugins.cloud.account().map(|a| account_key(&a));
        let mut state = self.messaging.lock().unwrap();
        match (&state.identity, key) {
            (Some((owner, identity)), Some(key)) if *owner == key => Some(identity.clone()),
            (None, _) => None,
            _ => {
                *state = MessagingState::default();
                None
            }
        }
    }

    /// Your relay identity for the signed-in account, from memory or Cloud.
    /// `refresh` asks Cloud again, for a token Relaycast refused.
    pub(crate) async fn person_identity(&self, refresh: bool) -> Result<PersonIdentity, RpcError> {
        let account = self.plugins.cloud.account().ok_or_else(sign_in_required)?;
        if let Some(identity) = self.current_identity().filter(|_| !refresh) {
            return Ok(identity);
        }
        let path = format!(
            "/workspaces/{}/messaging/identity/credential",
            segment(&account.workspace_id)
        );
        let body = self
            .plugins
            .cloud
            .request("POST", path, Some(json!({})))
            .await
            .map_err(|error| match error {
                CloudError::SignedOut | CloudError::Rejected => sign_in_required(),
                error => RpcError::cloud(&error),
            })?;
        let identity = &body["identity"];
        let (Some(name), Some(agent_id), Some(token), Some(base_url)) = (
            text(&identity["name"]),
            text(&identity["agentId"]),
            text(&identity["token"]),
            identity["relaycastUrl"]
                .as_str()
                .and_then(validated_base_url),
        ) else {
            return Err(RpcError::new(
                ErrorKind::CloudFailed,
                "Agent Relay did not return your relay identity.",
            ));
        };
        let identity = PersonIdentity {
            name,
            agent_id,
            token: Secret::new(token),
            base_url,
        };
        {
            let mut state = self.messaging.lock().unwrap();
            if state
                .identity
                .as_ref()
                .is_some_and(|(owner, _)| *owner != account_key(&account))
            {
                *state = MessagingState::default();
            }
            state.identity = Some((account_key(&account), identity.clone()));
        }
        if let Some(core) = self.arc() {
            tokio::spawn(async move { core.sync_agents().await });
        }
        Ok(identity)
    }

    /// The push channel for your identity, once it is known.
    pub(crate) fn person_push_target(&self) -> Option<PushTarget> {
        let identity = self.current_identity()?;
        let team = self.workspace();
        let account_key = self.account_workspace_key();
        let workspace = person_workspace_scope(&identity, team.as_ref(), account_key.as_ref());
        Some(PushTarget {
            agent: person_channel(&identity.name),
            base_url: identity.base_url,
            token: identity.token,
            workspace,
            machine_address: None,
        })
    }

    pub(crate) fn is_person(&self, agent: &str) -> bool {
        self.current_identity()
            .is_some_and(|identity| person_channel(&identity.name) == agent)
    }

    /// A reply arrived for you, or your socket came up: any open
    /// conversation re-reads, and exact-address lookups may now find proof.
    pub(crate) fn person_woke(&self) {
        self.messaging.lock().unwrap().misses.clear();
        self.hub.invalidated(Listing::Messages);
    }

    /// Sends as you; `reply_to` answers beneath that message instead.
    pub async fn send_as_person(
        &self,
        endpoint: &Endpoint,
        text_: &str,
        reply_to: Option<&str>,
    ) -> Result<Sent, RpcError> {
        let body = text_.trim();
        if body.is_empty() {
            return Err(RpcError::invalid_params("Type a message first."));
        }
        let send = |identity: PersonIdentity| async move {
            match reply_to {
                Some(parent) => {
                    client::reply(&identity.base_url, &identity.token, parent, body, None).await
                }
                None => {
                    client::send_dm(&identity.base_url, &identity.token, endpoint, body, None).await
                }
            }
        };
        let identity = self.person_identity(false).await?;
        let (identity, sent) = match send(identity.clone()).await {
            Err(error) if error.is_auth_rejection() => {
                let fresh = self.person_identity(true).await?;
                (fresh.clone(), send(fresh).await)
            }
            other => (identity, other),
        };
        let sent = match sent {
            Ok(sent) => sent,
            Err(error) => return Err(self.person_send_error(endpoint, &error).await),
        };
        let workspace = self
            .plugins
            .cloud
            .account()
            .map(|a| a.workspace_id)
            .unwrap_or_default();
        let mut state = self.messaging.lock().unwrap();
        if let Some(conversation) = &sent.conversation_id {
            state.conversations.insert(
                (identity.name.clone(), endpoint.key()),
                conversation.clone(),
            );
        }
        state
            .misses
            .remove(&(workspace, identity.name.clone(), endpoint.key()));
        Ok(sent)
    }

    /// The signed-in account's Relaycast workspace key: the workspace your
    /// relay identity sends in.
    fn account_workspace_key(&self) -> Option<Secret> {
        self.store
            .read(|store| store.cloud.as_ref().map(|cloud| cloud.key.clone()))
    }

    /// Whether the daemon workspace's roster is the workspace your messages
    /// go to: the same workspace (by key, not only by origin) as the
    /// signed-in account your identity sends in. A CLI workspace that is
    /// not the account's is never taken as proof about your sends.
    pub(crate) async fn roster_is_messaging_workspace(&self) -> bool {
        let Some(workspace) = self.workspace() else {
            return false;
        };
        let account_key = self.account_workspace_key();
        self.person_identity(false).await.is_ok_and(|identity| {
            is_identity_workspace(&identity, &workspace, account_key.as_ref())
        })
    }

    /// The recipient of a send to `endpoint` and what Relaycast holds for
    /// it, read just after the send; unknown when the roster cannot be read.
    pub async fn recipient_after_send(&self, endpoint: &Endpoint, sent: &Sent) -> Recipient {
        let lookup = match (endpoint, sent.to.as_deref()) {
            (Endpoint::Name(_), Some(name)) => Endpoint::Name(name.into()),
            _ => endpoint.clone(),
        };
        self.recipient(&lookup, sent.message_id.as_deref())
            .await
            .unwrap_or(Recipient {
                known: false,
                agent: None,
                message: None,
            })
    }

    /// Acknowledges the replies Relaycast queued for you. History is
    /// durable; this only stops redrive. Returns how many.
    async fn acknowledge_person_deliveries(&self, identity: &PersonIdentity) -> usize {
        let Ok(pending) = client::deliveries(&identity.base_url, &identity.token).await else {
            return 0;
        };
        let mut acknowledged = 0;
        for delivery in pending {
            if client::ack(&identity.base_url, &identity.token, &delivery.id)
                .await
                .is_ok()
            {
                acknowledged += 1;
            }
        }
        acknowledged
    }

    /// Your conversation with `endpoint`, in reading order; empty before the
    /// first message, and for an exact address without proof. `before`
    /// pages back from a message id.
    pub async fn history(
        &self,
        endpoint: &Endpoint,
        before: Option<&str>,
    ) -> Result<History, RpcError> {
        let identity = self.person_identity(false).await?;
        let result = match self.history_as(&identity, endpoint, before).await {
            Err(error) if error.is_auth_rejection() => {
                let fresh = self.person_identity(true).await?;
                self.history_as(&fresh, endpoint, before)
                    .await
                    .map(|m| (fresh, m))
            }
            other => other.map(|m| (identity, m)),
        };
        let (identity, messages) = result.map_err(|e| RpcError::from_relaycast(&e))?;
        Ok(History {
            identity: identity.name,
            messages,
        })
    }

    async fn history_as(
        &self,
        identity: &PersonIdentity,
        peer: &Endpoint,
        before: Option<&str>,
    ) -> relaycast::Result<Vec<DirectMessage>> {
        let http = sdk_gaps::http(&identity.base_url, &identity.token)?;
        if self.acknowledge_person_deliveries(identity).await > 0 {
            // Any incoming DM can be the proof an earlier lookup lacked.
            self.messaging.lock().unwrap().misses.clear();
        }
        let workspace = self
            .plugins
            .cloud
            .account()
            .map(|a| a.workspace_id)
            .unwrap_or_default();
        let miss_key = (workspace, identity.name.clone(), peer.key());
        let preferred = {
            let mut state = self.messaging.lock().unwrap();
            if peer.is_address() {
                if let Some(missed) = state.misses.get(&miss_key) {
                    if missed.elapsed() < EXACT_MISS_TTL {
                        return Ok(Vec::new());
                    }
                    state.misses.remove(&miss_key);
                }
            }
            state
                .conversations
                .get(&(identity.name.clone(), peer.key()))
                .cloned()
        };
        let listing = sdk_gaps::dm_conversations(&http).await?;
        let mut conversations = direct_conversations(&listing, &identity.name);
        if let Some(preferred) = &preferred {
            conversations.sort_by_key(|c| c["id"].as_str() != Some(preferred.as_str()));
        }
        let mut selected: Option<String> = None;
        match peer {
            Endpoint::Address(address) => {
                for candidate in &conversations {
                    let Some(id) = text(&candidate["id"]) else {
                        continue;
                    };
                    let mut page = sdk_gaps::dm_messages(&http, &id, HISTORY_LIMIT, None).await?;
                    let mut proof = endpoint_binding(candidate, &page, address, &identity.name);
                    let mut seen = HashSet::new();
                    // The address-bearing message may be older than the
                    // latest page: walk back until it is found or the
                    // conversation ends.
                    while proof.is_none() && page.len() as u32 >= HISTORY_LIMIT {
                        let Some(cursor) = page.last().and_then(|m| text(&m["id"])) else {
                            break;
                        };
                        if !seen.insert(cursor.clone()) {
                            break;
                        }
                        page =
                            sdk_gaps::dm_messages(&http, &id, HISTORY_LIMIT, Some(&cursor)).await?;
                        proof = endpoint_binding(candidate, &page, address, &identity.name);
                    }
                    if proof.is_some() {
                        selected = Some(id);
                        break;
                    }
                }
            }
            Endpoint::Name(name) => {
                selected = find_conversation(&conversations, &identity.name, name);
            }
        }
        let Some(selected) = selected else {
            if peer.is_address() {
                self.messaging
                    .lock()
                    .unwrap()
                    .misses
                    .insert(miss_key, Instant::now());
            }
            return Ok(Vec::new());
        };
        {
            let mut state = self.messaging.lock().unwrap();
            state.misses.remove(&miss_key);
            state
                .conversations
                .insert((identity.name.clone(), peer.key()), selected.clone());
        }
        let page = sdk_gaps::dm_messages(&http, &selected, HISTORY_LIMIT, before).await?;
        let hydrated = self.hydrate(&http, identity, page).await?;
        Ok(threaded(&hydrated, &identity.name))
    }

    /// Fills in what DM history omits (`thread_id`, and on older servers the
    /// sender id and address) from the single-message endpoint, and adds a
    /// recent reply's parent from outside the page.
    async fn hydrate(
        &self,
        http: &crate::relay::diagnostic_http::HttpClient,
        identity: &PersonIdentity,
        items: Vec<Value>,
    ) -> relaycast::Result<Vec<Value>> {
        let complete = |item: &Value| {
            ["thread_id", "agent_id", "agent_address"]
                .iter()
                .all(|key| item.get(*key).is_some_and(|value| !value.is_null()))
        };
        let valid: Vec<Value> = items
            .into_iter()
            .filter(|i| text(&i["id"]).is_some())
            .collect();
        let mut hydrated: Vec<Value> =
            futures_util::stream::iter(valid.into_iter().map(|item| async move {
                if complete(&item) {
                    return Ok(item);
                }
                let id = text(&item["id"]).unwrap_or_default();
                let metadata = self.message_detail(http, identity, &id).await?;
                let mut merged = metadata.clone();
                if let (Some(merged), Some(item)) = (merged.as_object_mut(), item.as_object()) {
                    for (key, value) in item {
                        merged.insert(key.clone(), value.clone());
                    }
                    merged.insert("thread_id".into(), metadata["thread_id"].clone());
                }
                Ok::<Value, relaycast::RelayError>(merged)
            }))
            .buffered(4)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<Result<_, _>>()?;
        let mut ids: HashSet<String> = hydrated.iter().filter_map(|m| text(&m["id"])).collect();
        let parents: Vec<String> = hydrated
            .iter()
            .filter_map(|m| text(&m["thread_id"]))
            .collect();
        for parent in parents {
            if ids.insert(parent.clone()) {
                hydrated.push(self.message_detail(http, identity, &parent).await?);
            }
        }
        Ok(hydrated)
    }

    async fn message_detail(
        &self,
        http: &crate::relay::diagnostic_http::HttpClient,
        identity: &PersonIdentity,
        id: &str,
    ) -> relaycast::Result<Value> {
        let key = (
            identity.base_url.clone(),
            identity.token.clone(),
            id.to_string(),
        );
        if let Some(cached) = self.messaging.lock().unwrap().details.get(&key) {
            return Ok(cached.clone());
        }
        let value = sdk_gaps::message(http, id).await?;
        if value["id"] != id {
            return Err(relaycast::RelayError::InvalidResponse(
                "incorrect message thread metadata".into(),
            ));
        }
        let mut state = self.messaging.lock().unwrap();
        if state.details.len() >= DETAILS_KEPT {
            state.details.clear();
        }
        state.details.insert(key, value.clone());
        Ok(value)
    }

    /// Your 1:1 conversations, as Relaycast lists them.
    pub async fn conversations(&self) -> Result<Conversations, RpcError> {
        let identity = self.person_identity(false).await?;
        let list = |identity: PersonIdentity| async move {
            let http = sdk_gaps::http(&identity.base_url, &identity.token)?;
            sdk_gaps::dm_conversations(&http).await
        };
        let (identity, listing) = match list(identity.clone()).await {
            Err(error) if error.is_auth_rejection() => {
                let fresh = self.person_identity(true).await?;
                (fresh.clone(), list(fresh).await)
            }
            other => (identity, other),
        };
        let listing = listing.map_err(|e| RpcError::from_relaycast(&e))?;
        let conversations = direct_conversations(&listing, &identity.name)
            .iter()
            .map(|c| {
                let participant = c["participants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|p| p["agent_name"] != identity.name.as_str())
                    .and_then(|p| {
                        Some(ConversationPeer {
                            name: text(&p["agent_name"])?,
                            agent_id: text(&p["agent_id"]),
                        })
                    });
                let named = c["participant_names"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(text)
                    .find(|name| *name != identity.name)
                    .map(|name| ConversationPeer {
                        name,
                        agent_id: None,
                    });
                Conversation {
                    id: c["id"].as_str().unwrap_or_default().to_string(),
                    peer: participant.or(named),
                    last_message: c["last_message"].clone(),
                    unread_count: c["unread_count"].as_u64(),
                }
            })
            .collect();
        Ok(Conversations {
            identity: identity.name,
            conversations,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::backoff::RelaycastBackoff;

    const ME: &str = "ada-lovelace";

    fn conversation(id: &str, peer_id: &str) -> Value {
        json!({"id": id, "type": "1:1", "participants": [
            {"agent_id": "agent_person", "agent_name": ME},
            {"agent_id": peer_id, "agent_name": "reviewer"},
        ]})
    }

    #[test]
    fn team_plan_pause_also_gates_person_background_calls() {
        let team = Workspace {
            key: Secret::new("rk_team_workspace"),
            base_url: "https://relay.example".into(),
            workspace_id: Some("rw_team".into()),
            source: Default::default(),
        };
        let person = PersonIdentity {
            name: "person".into(),
            agent_id: "agent_person".into(),
            token: Secret::new("at_person"),
            base_url: team.base_url.clone(),
        };
        let team_scope = WorkspaceScope::credential(&team.base_url, &team.key, "team");
        let person_scope = person_workspace_scope(&person, Some(&team), Some(&team.key));
        let gate = RelaycastBackoff::default();
        gate.record_error(
            &team_scope,
            &relaycast::RelayError::Api {
                code: "plan_limit_exceeded".into(),
                message: "limited".into(),
                status: 429,
                request_id: None,
                attempts: 1,
                retry_after_ms: Some(3_600_000),
                details: None,
            },
        );

        assert!(!gate.allowed(&person_scope));
    }

    #[test]
    fn only_the_account_workspace_proves_anything_about_person_sends() {
        let account = Workspace {
            key: Secret::new("rk_live_account00"),
            base_url: "https://cast.agentrelay.com".into(),
            workspace_id: Some("rw_account".into()),
            source: Default::default(),
        };
        let person = PersonIdentity {
            name: "person".into(),
            agent_id: "agent_person".into(),
            token: Secret::new("at_person"),
            base_url: account.base_url.clone(),
        };
        let account_key = Some(&account.key);
        assert!(is_identity_workspace(&person, &account, account_key));
        // The CLI's workspace B on the same origin as account A is another
        // workspace: its roster says nothing about sends in A.
        let cli = Workspace {
            key: Secret::new("rk_live_cli_other"),
            workspace_id: None,
            source: crate::relay::workspace::WorkspaceSource::CliEnv("RELAY_WORKSPACE_KEY".into()),
            ..account.clone()
        };
        assert!(!is_identity_workspace(&person, &cli, account_key));
        // The CLI naming the account's own key is the account's workspace.
        let same = Workspace {
            key: account.key.clone(),
            ..cli.clone()
        };
        assert!(is_identity_workspace(&person, &same, account_key));
        // No account key, or another origin, proves nothing.
        assert!(!is_identity_workspace(&person, &account, None));
        let elsewhere = Workspace {
            base_url: "http://127.0.0.1:8787".into(),
            ..account.clone()
        };
        assert!(!is_identity_workspace(&person, &elsewhere, account_key));
        // Background calls as you are gated by your own token, not B's.
        assert_eq!(
            person_workspace_scope(&person, Some(&cli), account_key),
            WorkspaceScope::credential(&person.base_url, &person.token, "your messaging workspace"),
        );
    }

    #[test]
    fn a_desktop_address_proves_its_conversation_by_the_agent_id_it_embeds() {
        let address = "grok-relay-1d77b6@linux-host-233378063229464576";
        let mut conversation = conversation("dm_grok", "233378063229464576");
        conversation["participants"][1]["agent_name"] = json!("grok-relay-1d77b6");
        // No message carries the address: a socket reply never does.
        let reply = json!({"agent_id": "233378063229464576", "agent_name": "grok-relay-1d77b6", "text": "PONG"});
        assert_eq!(
            endpoint_binding(&conversation, std::slice::from_ref(&reply), address, ME),
            Some(("233378063229464576".into(), address.into()))
        );
        // Another agent's id, another name, or your own name proves nothing.
        assert_eq!(
            endpoint_binding(&conversation, &[], "grok-relay-1d77b6@linux-host-1", ME),
            None
        );
        assert_eq!(
            endpoint_binding(
                &conversation,
                &[],
                "other@linux-host-233378063229464576",
                ME
            ),
            None
        );
        let own = format!("{ME}@linux-host-agent_person");
        assert_eq!(endpoint_binding(&conversation, &[], &own, ME), None);
        // A machine label without a numeric id is no proof either.
        assert_eq!(
            endpoint_binding(&conversation, &[], "grok-relay-1d77b6@direct", ME),
            None
        );
    }

    // test_exact_history_fails_closed_without_matching_immutable_evidence.
    #[test]
    fn exact_history_fails_closed_without_matching_immutable_evidence() {
        let address = "reviewer@sf-frame-generation-2";
        let conversation = conversation("dm_old", "agent_reviewer_generation_2");
        for item in [
            json!({"agent_id": "agent_reviewer_generation_2", "agent_name": "reviewer", "agent_address": "reviewer@wrong-machine"}),
            json!({"agent_id": "agent_reviewer_generation_1", "agent_name": "reviewer", "agent_address": address}),
            json!({"agent_name": "reviewer", "agent_address": address}),
        ] {
            assert_eq!(
                endpoint_binding(&conversation, std::slice::from_ref(&item), address, ME),
                None,
                "{item}"
            );
        }
        let mut group = conversation.clone();
        group["participants"]
            .as_array_mut()
            .unwrap()
            .push(json!({"agent_id": "agent_other", "agent_name": "other"}));
        let proof = json!({"agent_id": "agent_reviewer_generation_2", "agent_name": "reviewer", "agent_address": address});
        assert_eq!(
            endpoint_binding(&group, std::slice::from_ref(&proof), address, ME),
            None
        );
        assert_eq!(
            endpoint_binding(&conversation, &[proof], address, ME),
            Some(("agent_reviewer_generation_2".into(), address.into()))
        );
        // Your own address never proves a peer conversation.
        let own = format!("{ME}@direct-person");
        assert_eq!(
            endpoint_binding(
                &conversation,
                &[json!({"agent_id": "agent_person", "agent_name": ME, "agent_address": own})],
                &own,
                ME
            ),
            None
        );
    }

    // test_finds_only_the_one_to_one_conversation.
    #[test]
    fn finds_only_the_one_to_one_conversation() {
        let listing = vec![
            json!({"id": "g", "type": "group", "participants": [{"agent_name": "me"}, {"agent_name": "peer"}]}),
            json!({"id": "d", "type": "1:1", "participants": [{"agent_name": "me"}, {"agent_name": "peer"}]}),
        ];
        assert_eq!(
            find_conversation(&listing, "me", "peer").as_deref(),
            Some("d")
        );
        assert_eq!(find_conversation(&listing, "me", "other"), None);
        assert_eq!(direct_conversations(&listing, "me").len(), 1);
    }

    // RelaycastClient.threaded and test_real_dm_shape_recovers_thread….
    #[test]
    fn replies_read_beneath_their_parent() {
        let items = vec![
            json!({"id": "4", "agent_name": "reviewer", "text": "plain DM", "created_at": "2026-09-25T05:00:03Z"}),
            json!({"id": "3", "agent_name": "reviewer", "text": "answer to first", "created_at": "2026-09-25T05:00:02Z", "thread_id": "1"}),
            json!({"id": "2", "agent_name": ME, "text": "second question", "created_at": "2026-09-25T05:00:01Z"}),
            json!({"id": "1", "agent_name": ME, "text": "first question", "created_at": "2026-09-25T05:00:00Z"}),
            json!({"id": "1", "agent_name": ME, "text": "duplicate row", "created_at": "2026-09-25T05:00:00Z"}),
        ];
        let messages = threaded(&items, ME);
        let ids: Vec<&str> = messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["1", "3", "2", "4"]);
        assert!(messages[0].mine);
        assert!(!messages[1].mine);
        assert_eq!(messages[1].thread_id.as_deref(), Some("1"));
        // A cycle is harmless.
        let cycle = vec![
            json!({"id": "a", "agent_name": "x", "thread_id": "b"}),
            json!({"id": "b", "agent_name": "x", "thread_id": "a"}),
        ];
        assert_eq!(threaded(&cycle, ME).len(), 2);
    }

    #[test]
    fn attached_files_are_named_in_the_conversation() {
        let items = vec![
            json!({"id": "1", "agent_name": "peer", "text": "see", "created_at": "2026-09-25T05:00:00Z",
                "attachments": [{"file_id": "file_1", "filename": "shot.png", "content_type": "image/png", "size_bytes": 3}]}),
            json!({"id": "2", "agent_name": "peer", "text": "", "created_at": "2026-09-25T05:00:01Z",
                "attachments": [{"file_id": "file_2", "filename": "a\nb.pdf"}]}),
        ];
        let messages = threaded(&items, ME);
        assert_eq!(messages[0].text, "see\n📎 shot.png");
        assert_eq!(messages[1].text, "📎 a b.pdf");
    }
}
