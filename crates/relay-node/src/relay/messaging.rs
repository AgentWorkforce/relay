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
//! GET  /v1/inbox                          (as you) ─▶ what is unread for you
//! POST /v1/messages/{id}/read             (as you) ─▶ read on every device
//! ```
//!
//! Cloud can recover the identity (a fresh token) at any time, which retires
//! the copy held here: a token Relaycast refuses is fetched again, once.
//!
//! On a gate-only install (the workspace names a relaygate, or the identity
//! route answers 403 `gate_only` with the gate's address, which is then
//! kept like the one a gate-only resolve names) there is no Cloud identity:
//! you enrol at the gate as one more agent, under a name derived from your
//! user id ([`gate_person_name`]), with the device token. Everything you
//! send and read then goes through the gate with the `rg_` token it issued,
//! which is renewed like an agent's (same name and recovery proof, so the
//! same agent id): at 80% of its lifetime, and once when the gate refuses it.
//!
//! ```text
//! POST <gate>/v1/register {name, recovery}  (device token) ─▶ agent_id, rg_ token
//! ```
//! Relaycast queues every reply to you as a delivery. On Relaycast an ack is
//! also a read (it moves your read position), so reading a conversation
//! acknowledges that conversation's deliveries only, after its page is
//! returned ([`acks`]); the others stay queued, and unread, until their
//! conversation is read or they expire. The identity's push socket wakes an
//! open conversation the moment one arrives.
//!
//! An exact `agent@machine` history is shown only with proof from server
//! history: the conversation must list exactly two participants with
//! immutable agent ids, and a message must attribute the exact address to
//! the peer's id. A cached conversation id or a matching name is never
//! enough, so a reused name or machine cannot inherit another identity's
//! history. A conversation without proof is looked for again at most once a
//! minute, sooner when a reply arrives, and then only in the conversations
//! that changed since they were read.
//!
//! The conversation listing is kept for [`LISTING_TTL`] for the account,
//! identity and token that read it, without its last messages, so following
//! an open conversation reads only its newest page. It is read again sooner
//! when a history read sees a new delivery, a push wake arrives, you send,
//! the token is refused, or you sign out or change account. A conversation
//! removed, re-bound or given other participants meanwhile (by another of
//! your machines, say, whose deliveries are not seen here) is noticed
//! within [`LISTING_TTL`]. A listing read while one of those drops it is
//! not kept. A history read whose delivery poll fails reads the listing,
//! so a pause or a refused token reaches the caller as before. A lookup
//! over the kept listing that finds no conversation runs again on a
//! listing read now: an empty answer, and an exact-address miss, rest only
//! on a listing read by that call.
//!
//! Every read as you is paced by the workspace's Relaycast pause
//! ([`crate::relay::backoff`]): while it lasts, a read is refused with the
//! time left instead of reaching Relaycast.

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
use crate::relay::store::GateEnrolment;
use crate::relay::workspace::{validated_base_url, Secret, Workspace};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Messages per history page.
pub const HISTORY_LIMIT: u32 = 50;
/// How long an exact-address lookup without proof is not repeated.
pub const EXACT_MISS_TTL: Duration = Duration::from_secs(60);
/// How long a conversation that proved an exact address is trusted for it
/// without its proof being read again. An address re-registered by another
/// agent is seen at most this late, and at once when the conversation's
/// peer is no longer the agent proved.
pub const PROOF_TTL: Duration = Duration::from_secs(600);

/// A conversation that proved an exact address: the agent it proved and
/// when.
#[derive(Clone, Debug)]
struct Proven {
    conversation: String,
    agent_id: String,
    at: Instant,
}
const DETAILS_KEPT: usize = 2_000;
/// How long a conversation listing is used again without reading it:
/// longer than the apps' follow interval (9 s), so following reads only
/// the conversation's page, and half the [`EXACT_MISS_TTL`].
pub const LISTING_TTL: Duration = Duration::from_secs(30);
/// A listing longer than this is not kept.
const LISTING_KEPT: usize = 1_000;

/// Your relay identity in one Cloud workspace.
#[derive(Clone, Debug)]
pub struct PersonIdentity {
    pub name: String,
    /// Relaycast's immutable agent id for this signed-in person's identity.
    pub agent_id: String,
    pub token: Secret,
    pub base_url: String,
}

/// The name your own messaging identity enrols under at relaygate on a
/// gate-only install: `person-` and the first 16 hex digits of the sha256
/// of your Cloud user id (the owner hash agents already publish,
/// [`crate::relay::people::identity_hash`]), e.g. `person-c6c289e49e9c05b2`
/// for `user-1`. It is the same on every enrolment, so registering again
/// (same name, same recovery proof) keeps the same agent, and it names no
/// account detail. It never starts with relaygate's reserved `ctl:`.
pub fn gate_person_name(user_id: &str) -> String {
    let hash = crate::relay::people::identity_hash(user_id);
    format!("person-{}", &hash[..16])
}

/// Whether `workspace` is the Relaycast workspace `identity` sends in. The
/// identity is minted for the signed-in account's Cloud workspace, whose
/// Relaycast key is `account_key`: the daemon's workspace is that one only
/// when it uses the same key on the identity's origin. A CLI workspace on
/// the same origin (two workspaces on `cast.agentrelay.com`) is another
/// workspace, so its roster proves nothing about your sends. A gate-only
/// workspace has no key: it is yours when your identity enrolled at its
/// gate.
fn is_identity_workspace(
    identity: &PersonIdentity,
    workspace: &Workspace,
    account_key: Option<&Secret>,
) -> bool {
    if workspace.is_gate_only() {
        return workspace.base_url == identity.base_url;
    }
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
    /// When the identity enrolled at relaygate (gate-only), its recovery
    /// proof and when its `rg_` token is due for renewal.
    gate: Option<GateEnrolment>,
    /// The identity's `rg_` token relaygate rejected (401): never handed
    /// out again, while the identity and its renewal timing are kept,
    /// until an enrolment issues another.
    refused: Option<Secret>,
    /// Conversation ids by `(identity name, endpoint key)`: search hints only.
    conversations: HashMap<(String, String), String>,
    /// The last conversation listing, for [`LISTING_TTL`].
    listing: Option<KeptListing>,
    /// How many times the kept listing was dropped on purpose (not by
    /// expiry): a listing read while it changed is not kept.
    listing_drops: u64,
    /// The conversation that last proved each exact address, by the same
    /// key as `misses`: trusted for [`PROOF_TTL`] while its peer is the
    /// agent proved.
    proven: HashMap<(String, String, String), Proven>,
    /// Exact-address lookups that found no proof, by `(workspace, identity, endpoint key)`.
    misses: HashMap<(String, String, String), Instant>,
    /// The conversations an exact-address lookup read without finding
    /// proof, by the same key as `misses` and then conversation id.
    checked: HashMap<(String, String, String), HashMap<String, Checked>>,
    /// `GET /v1/messages/{id}` answers, scoped to the credential that read them.
    details: HashMap<(String, Secret, String), Value>,
    /// Ids of your queued deliveries already seen by a history read: a new
    /// one is a reply that may be the proof a lookup lacked.
    seen_deliveries: HashSet<String>,
    /// Conversation reads waiting their turn, by `(base url, identity
    /// name)`: an entry is there while that identity's reads are settled.
    /// The task settling them is marked by the number beside its queue.
    settling: HashMap<(String, String), (u64, Vec<acks::ConversationRead>)>,
    /// The newest message marked read in each conversation, by
    /// `(base url, identity name, conversation id)`.
    marked: HashMap<(String, String, String), String>,
}

impl MessagingState {
    /// A reply or a send may be the proof a lookup lacked: lookups run
    /// again, and a conversation whose listing cannot show that it changed
    /// is read again. `key` limits this to one lookup. Either may also
    /// start a conversation: the kept listing is dropped.
    fn forget_misses(&mut self, key: Option<&(String, String, String)>) {
        self.drop_listing();
        match key {
            Some(key) => {
                self.misses.remove(key);
                if let Some(checked) = self.checked.get_mut(key) {
                    checked.retain(|_, c| c.marked);
                }
            }
            None => {
                self.misses.clear();
                for checked in self.checked.values_mut() {
                    checked.retain(|_, c| c.marked);
                }
            }
        }
    }

    /// Forgets everything, as on sign-out or another account. A listing
    /// still being read is not kept afterwards.
    fn reset(&mut self) {
        let drops = self.listing_drops;
        *self = MessagingState::default();
        self.listing_drops = drops + 1;
    }

    /// Drops the kept listing on purpose: a listing whose read started
    /// before this is not kept when it arrives.
    fn drop_listing(&mut self) {
        self.listing = None;
        self.listing_drops += 1;
    }

    /// The listing `key` read less than [`LISTING_TTL`] ago.
    fn kept_listing(&mut self, key: &ListingKey) -> Option<Vec<Listed>> {
        let kept = self.listing.as_ref()?;
        if kept.key == *key && kept.at.elapsed() < LISTING_TTL {
            return Some(kept.conversations.clone());
        }
        self.listing = None;
        None
    }

    /// Keeps a listing whose read started when [`Self::listing_drops`] was
    /// `drops`; if the listing was dropped since, the answer is older than
    /// the drop and is not kept.
    fn keep_listing(&mut self, key: ListingKey, conversations: &[Listed], drops: u64) {
        if drops != self.listing_drops {
            return;
        }
        self.listing = (conversations.len() <= LISTING_KEPT).then(|| KeptListing {
            key,
            at: Instant::now(),
            conversations: conversations.to_vec(),
        });
    }
}

/// What `/v1/dm/conversations` said of a conversation that was read without
/// finding proof. Relaycast lists each conversation with its last message
/// (`last_message`: id, text, sender, time), so while the listing says the
/// same nothing new can be in it. A server that lists no last message
/// cannot show a change: such a conversation is read again after
/// [`EXACT_MISS_TTL`], or when a reply arrives.
struct Checked {
    listing: String,
    marked: bool,
    at: Instant,
}

impl Checked {
    fn of(listed: &Listed) -> Checked {
        Checked {
            listing: listed.listing.clone(),
            marked: listed.marked,
            at: Instant::now(),
        }
    }

    /// Whether reading the conversation listed as `now` again would only
    /// read what this check already read.
    fn covers(&self, now: &Checked) -> bool {
        self.listing == now.listing && (self.marked || self.at.elapsed() < EXACT_MISS_TTL)
    }
}

/// Whose conversation listing it is: the account (site, Cloud workspace,
/// user), the identity name, and the Relaycast origin and token it was read
/// with. A refused and replaced token reads its own.
type ListingKey = (String, String, String, Secret);

/// A conversation listing as read, for [`LISTING_TTL`].
struct KeptListing {
    key: ListingKey,
    at: Instant,
    conversations: Vec<Listed>,
}

/// One 1:1 conversation of the listing, without its last message: its id,
/// type and participants, and a digest of how it was listed ([`Checked`]).
#[derive(Clone)]
struct Listed {
    conversation: Value,
    listing: String,
    marked: bool,
}

impl Listed {
    fn of(conversation: &Value) -> Listed {
        let participants = match conversation["participants"].as_array() {
            Some(list) => list
                .iter()
                .map(|p| json!({"agent_id": p["agent_id"], "agent_name": p["agent_name"]}))
                .collect(),
            None => Value::Null,
        };
        Listed {
            conversation: json!({
                "id": conversation["id"],
                "type": conversation["type"],
                "participants": participants,
                "participant_names": conversation["participant_names"],
            }),
            listing: format!("{:x}", Sha256::digest(conversation.to_string())),
            marked: conversation
                .get("last_message")
                .is_some_and(|last| !last.is_null()),
        }
    }
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

/// The code of a read refused here, without reaching Relaycast, because
/// the workspace's pause started during the pass.
const PAUSED: &str = "relaycast_paused";

/// A read as you refused while the workspace's Relaycast pause lasts, with
/// the time left as the error's `Retry-After`.
fn paused(wait: Duration) -> RpcError {
    let mut error = RpcError::new(
        ErrorKind::RateLimited,
        "Your messages are paused while Agent Relay recovers.",
    );
    error.retry_after_secs = Some(wait.as_secs() + u64::from(wait.subsec_nanos() > 0));
    error
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

mod acks;
mod conversations;
#[cfg(test)]
mod history_tests;
mod inbox;
#[cfg(test)]
mod inbox_tests;
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

/// Whether `conversation` lists an agent with the name `address` goes by
/// or the agent id it carries: only such a conversation can prove it
/// ([`endpoint_binding`] needs a message from a listed agent, which sends
/// under its own name, or the id in the address).
fn may_prove(conversation: &Value, address: &str) -> bool {
    let name = address.split('@').next().unwrap_or_default();
    let id = address_agent_id(address).map(|(_, id)| id);
    conversation["participants"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|p| {
            p["agent_name"].as_str() == Some(name)
                || id.is_some_and(|id| text(&p["agent_id"]).as_deref() == Some(id))
        })
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

/// Another workspace was saved while a request for the one before was out.
fn workspace_changed() -> RpcError {
    RpcError::new(
        ErrorKind::CloudFailed,
        "Your Agent Relay workspace changed while you were being enrolled. Try again.",
    )
}

/// An enrolment at the gate that failed, as messaging reports it: signed
/// out says what to do about it for your own messages.
fn gate_identity_error(error: RpcError) -> RpcError {
    match error.data.kind {
        ErrorKind::NotSignedIn => RpcError::new(
            ErrorKind::NotSignedIn,
            "Messaging as yourself is unavailable: this computer is signed out of Agent Relay, so it cannot enrol you through relaygate. Sign in again.",
        ),
        _ => error,
    }
}

/// Your gate identity cannot be enrolled before `wait` is over (the gate's
/// `Retry-After` after a failure, `why`), and no unexpired token is held.
fn person_gate_waiting(wait: std::time::Duration, why: Option<String>) -> RpcError {
    let secs = wait.as_secs().max(1);
    let why = why.map(|why| format!(" {why}")).unwrap_or_default();
    let mut error = RpcError::new(
        ErrorKind::RelaycastUnreachable,
        format!("Messaging as yourself is waiting for relaygate.{why} Try again in {secs}s."),
    );
    error.retry_after_secs = Some(secs);
    error
}

/// The stored workspace's key, address and Agent Relay workspace: what
/// tells one saved workspace from another.
fn stored_workspace_of(
    store: &crate::relay::store::Store,
) -> Option<(Secret, String, Option<String>)> {
    store.cloud.as_ref().map(|cloud| {
        (
            cloud.key.clone(),
            cloud.base_url.clone(),
            cloud.account_workspace_id.clone(),
        )
    })
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
    pub(crate) fn current_identity(&self) -> Option<PersonIdentity> {
        let key = self.plugins.cloud.account().map(|a| account_key(&a));
        let mut state = self.messaging.lock().unwrap();
        match (&state.identity, key) {
            (Some((owner, identity)), Some(key)) if *owner == key => Some(identity.clone()),
            (None, _) => None,
            _ => {
                state.reset();
                None
            }
        }
    }

    /// Your relay identity for the signed-in account, from memory or Cloud
    /// (or relaygate, on a gate-only install). `refresh` asks again, for a
    /// token Relaycast refused.
    pub(crate) async fn person_identity(&self, refresh: bool) -> Result<PersonIdentity, RpcError> {
        let refused = refresh
            .then(|| self.current_identity().map(|identity| identity.token))
            .flatten();
        self.person_identity_unless(refresh, refused).await
    }

    /// Your relay identity again after `refused` (the token a call used)
    /// was rejected. With a key this asks Cloud again, as
    /// `person_identity(true)` does. Through a gate, a token renewed
    /// meanwhile is kept: only `refused` is never handed out again.
    pub(crate) async fn person_identity_refused(
        &self,
        refused: &Secret,
    ) -> Result<PersonIdentity, RpcError> {
        self.person_identity_unless(true, Some(refused.clone()))
            .await
    }

    async fn person_identity_unless(
        &self,
        refresh: bool,
        refused: Option<Secret>,
    ) -> Result<PersonIdentity, RpcError> {
        let Some(account) = self.plugins.cloud.account() else {
            // Signed out: forget what was read for the last account.
            self.current_identity();
            return Err(sign_in_required());
        };
        let gate_url = self.person_gate_url();
        if let Some(identity) = self.current_identity().filter(|identity| {
            !refresh
                && !self.person_gate_due()
                && !self.person_token_refused(&identity.token)
                && gate_url
                    .as_ref()
                    .is_none_or(|gate| *gate == identity.base_url)
        }) {
            return Ok(identity);
        }
        if let Some(gate_url) = gate_url {
            return self
                .person_identity_at_gate(&account, &gate_url, refused.as_ref())
                .await;
        }
        let path = format!(
            "/workspaces/{}/messaging/identity/credential",
            segment(&account.workspace_id)
        );
        let asked_in = self.stored_workspace();
        let body = match self
            .plugins
            .cloud
            .request("POST", path, Some(json!({})))
            .await
        {
            Ok(body) => body,
            Err(CloudError::GateOnly { relaygate_url }) => {
                let gate_url = self.adopt_gate_url(&account, asked_in, relaygate_url)?;
                return self
                    .person_identity_at_gate(&account, &gate_url, refused.as_ref())
                    .await;
            }
            Err(CloudError::SignedOut | CloudError::Rejected) => return Err(sign_in_required()),
            Err(error) => return Err(RpcError::cloud(&error)),
        };
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
                state.reset();
            }
            state.identity = Some((account_key(&account), identity.clone()));
            state.gate = None;
            state.refused = None;
        }
        if let Some(core) = self.arc() {
            tokio::spawn(async move { core.sync_agents().await });
        }
        Ok(identity)
    }

    /// The relaygate your identity enrols at: the gate-only workspace's, or
    /// one kept in the store (adopted from a `gate_only` refusal) before
    /// the workspace was resolved again. None with a workspace key.
    fn person_gate_url(&self) -> Option<String> {
        self.workspace()
            .filter(Workspace::is_gate_only)
            .and_then(|workspace| workspace.gate_url)
            .or_else(|| {
                self.store.read(|store| {
                    store
                        .cloud
                        .as_ref()
                        .and_then(|cloud| cloud.gate_url.as_deref())
                        .and_then(validated_base_url)
                })
            })
    }

    /// Which stored workspace a request was made in: its key, address and
    /// Agent Relay workspace. Another workspace saved meanwhile differs.
    fn stored_workspace(&self) -> Option<(Secret, String, Option<String>)> {
        self.store.read(stored_workspace_of)
    }

    /// The gate a `gate_only` refusal of the identity route named, kept in
    /// the store as a gate-only resolve keeps it, unless a gate is known
    /// already (then that one is used). A refusal that names no valid gate
    /// leaves nothing to message through. `account` asked while `asked_in`
    /// was stored: a refusal that arrives after a sign-out, another account
    /// or another workspace belongs to none of them and is neither kept nor
    /// used.
    fn adopt_gate_url(
        &self,
        account: &CloudAccount,
        asked_in: Option<(Secret, String, Option<String>)>,
        offered: Option<String>,
    ) -> Result<String, RpcError> {
        if self.plugins.cloud.account().map(|a| account_key(&a)) != Some(account_key(account)) {
            return Err(sign_in_required());
        }
        // As the file holds it now: another process may have saved the
        // workspace you switched to.
        let unchanged = self
            .store
            .update_latest(|store| stored_workspace_of(store) == asked_in)
            .unwrap_or_else(|_| self.stored_workspace() == asked_in);
        if !unchanged {
            return Err(workspace_changed());
        }
        if let Some(known) = self.person_gate_url() {
            return Ok(known);
        }
        let gate = offered.ok_or_else(|| {
            RpcError::new(
                ErrorKind::CloudRefused,
                "Messaging as yourself is unavailable: this workspace is gate-only, and Agent Relay named no relaygate to message through.",
            )
        })?;
        // A failed save is not fatal here: you still message through the
        // gate now, and the next refusal adopts it again.
        // Checked again as it saves, so a workspace saved in between keeps
        // its own credentials and the gate is not used either.
        let saved = self.store.update_latest(|store| {
            if stored_workspace_of(store) != asked_in {
                return false;
            }
            if let Some(cloud) = store.cloud.as_mut().filter(|c| c.gate_url.is_none()) {
                cloud.gate_url = Some(gate.clone());
            }
            true
        });
        if let Ok(false) = saved {
            return Err(workspace_changed());
        }
        Ok(gate)
    }

    /// Whether relaygate rejected `token`, your identity's `rg_` token.
    fn person_token_refused(&self, token: &Secret) -> bool {
        self.messaging.lock().unwrap().refused.as_ref() == Some(token)
    }

    /// Whether your identity's `rg_` token (gate-only) is due for renewal.
    pub(crate) fn person_gate_due(&self) -> bool {
        let state = self.messaging.lock().unwrap();
        state
            .gate
            .as_ref()
            .is_some_and(|gate| gate.due(chrono::Utc::now()))
    }

    /// Whether your identity's `rg_` token (gate-only) has expired.
    fn person_gate_expired(&self) -> bool {
        let state = self.messaging.lock().unwrap();
        state
            .gate
            .as_ref()
            .is_some_and(|gate| gate.expired(chrono::Utc::now()))
    }

    /// The renewal key of your gate identity, `@name`, when it is held.
    pub(crate) fn person_gate_channel(&self) -> Option<String> {
        let state = self.messaging.lock().unwrap();
        state.gate.as_ref()?;
        state
            .identity
            .as_ref()
            .map(|(_, identity)| person_channel(&identity.name))
    }

    /// Enrols (or enrols again, for a new token) your identity at
    /// `gate_url` as one more agent: [`gate_person_name`], the device token,
    /// and the recovery proof kept for that name. One enrolment runs at a
    /// time; a caller that waited for another's uses the token it got.
    /// `refused`: a token the gate rejected, never handed out again.
    ///
    /// A token that is due but has not expired keeps working: when
    /// enrolling again fails, or the gate's wait after a failure is not
    /// over, it is returned instead of the error. Without one, the wait is
    /// an error that says when to try again; no request is sent before it.
    async fn person_identity_at_gate(
        &self,
        account: &CloudAccount,
        gate_url: &str,
        refused: Option<&Secret>,
    ) -> Result<PersonIdentity, RpcError> {
        let user_id = account
            .user_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(sign_in_required)?;
        let name = gate_person_name(user_id);
        let channel = person_channel(&name);
        let lock = self.gate_locks.get(&channel);
        let _enrolling = lock.lock().await;
        if let Some(refused) = refused {
            let mut state = self.messaging.lock().unwrap();
            if state
                .identity
                .as_ref()
                .is_some_and(|(_, identity)| identity.token == *refused)
            {
                state.refused = Some(refused.clone());
            }
        }
        let held = self.current_identity().filter(|identity| {
            identity.base_url == gate_url
                && identity.name == name
                && !self.person_token_refused(&identity.token)
        });
        if let Some(identity) = held.clone().filter(|_| !self.person_gate_due()) {
            return Ok(identity);
        }
        let usable = held.filter(|_| !self.person_gate_expired());
        if let Some((wait, why)) = self.person_renewal_wait(&channel) {
            return usable.ok_or_else(|| person_gate_waiting(wait, why));
        }
        let enrolled = self.enrol_at_gate(gate_url, &name).await;
        // Signed out, or another account signed in, while it enrolled:
        // neither the new token nor the one held before is this person's
        // to keep or hand out.
        if self.plugins.cloud.account().map(|a| account_key(&a)) != Some(account_key(account)) {
            return Err(sign_in_required());
        }
        let (issued, enrolment) = match enrolled {
            Ok(enrolled) => enrolled,
            Err(error) => {
                // Signed out, nothing was sent: nothing to wait for.
                if error.data.kind != ErrorKind::NotSignedIn || self.device_token().await.is_ok() {
                    self.person_renewal_failed(&channel, &error);
                }
                return usable.ok_or_else(|| gate_identity_error(error));
            }
        };
        let identity = PersonIdentity {
            name,
            agent_id: issued.agent_id,
            token: issued.token,
            base_url: gate_url.to_owned(),
        };
        {
            let mut state = self.messaging.lock().unwrap();
            if state
                .identity
                .as_ref()
                .is_some_and(|(owner, _)| *owner != account_key(account))
            {
                state.reset();
            }
            state.identity = Some((account_key(account), identity.clone()));
            state.gate = Some(enrolment);
            state.refused = None;
        }
        self.forget_gate_renewal(&channel);
        if let Some(core) = self.arc() {
            tokio::spawn(async move { core.sync_agents().await });
        }
        Ok(identity)
    }

    /// The push channel for your identity, once it is known.
    pub(crate) fn person_push_target(&self) -> Option<PushTarget> {
        let identity = self
            .current_identity()
            .filter(|identity| !self.person_token_refused(&identity.token))?;
        let workspace = self.person_scope(&identity);
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
        self.messaging.lock().unwrap().forget_misses(None);
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
                let fresh = self.person_identity_refused(&identity.token).await?;
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
        state.forget_misses(Some(&(workspace, identity.name.clone(), endpoint.key())));
        Ok(sent)
    }

    /// The Relaycast workspace that paces calls as you.
    fn person_scope(&self, identity: &PersonIdentity) -> WorkspaceScope {
        let team = self.workspace();
        let account_key = self.account_workspace_key();
        person_workspace_scope(identity, team.as_ref(), account_key.as_ref())
    }

    /// Refuses a read as you while the workspace's Relaycast pause lasts,
    /// with the time left as the error's `Retry-After`. A read it admits
    /// after a pause is the workspace's one recheck.
    fn person_read_allowed(&self, scope: &WorkspaceScope) -> Result<(), RpcError> {
        match self.relaycast_backoff.remaining(scope) {
            Some(wait) => Err(paused(wait)),
            None => Ok(()),
        }
    }

    /// `error`, a read as you that failed, as the caller sees it: while the
    /// workspace's pause lasts (this read or another started it), refused
    /// with the time left.
    fn person_error(&self, scope: &WorkspaceScope, error: &relaycast::RelayError) -> RpcError {
        match self.relaycast_backoff.pause_left(scope) {
            Some(wait) => paused(wait),
            None => RpcError::from_relaycast(error),
        }
    }

    /// Runs one Relaycast read as you and tells the workspace pause how it
    /// went. A refused token is your own, renewed by the caller: it says
    /// nothing about the workspace key, so the workspace is not checked again.
    /// Once a pause starts, by an earlier read of the same pass or anyone
    /// else's, the read is refused without reaching Relaycast: the recheck
    /// a pass was admitted with ends with the first pacing answer.
    #[allow(clippy::result_large_err)] // the SDK's own error type
    async fn person_read<T>(
        &self,
        scope: &WorkspaceScope,
        read: impl Future<Output = relaycast::Result<T>>,
    ) -> relaycast::Result<T> {
        if let Some(wait) = self.relaycast_backoff.pause_left(scope) {
            return Err(relaycast::RelayError::Api {
                code: PAUSED.into(),
                message: "the workspace's Relaycast pause has not ended".into(),
                status: 429,
                request_id: None,
                attempts: 0,
                retry_after_ms: Some(u64::try_from(wait.as_millis()).unwrap_or(u64::MAX)),
                details: None,
            });
        }
        let result = read.await;
        match &result {
            Err(error) if crate::relay::node_credential::rejects_credential(error) => {
                self.relaycast_backoff.record_error(scope, error);
            }
            result => self.observe_relaycast_result(scope, result),
        }
        result
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

    /// Your conversation with `endpoint`, in reading order; empty before the
    /// first message, and for an exact address without proof. `before`
    /// pages back from a message id.
    pub async fn history(
        self: &Arc<Self>,
        endpoint: &Endpoint,
        before: Option<&str>,
    ) -> Result<History, RpcError> {
        let identity = self.person_identity(false).await?;
        let scope = self.person_scope(&identity);
        self.person_read_allowed(&scope)?;
        let result = match self.history_as(&identity, endpoint, before).await {
            Err(error) if error.is_auth_rejection() => {
                // Nothing read with the refused token is used again.
                self.messaging.lock().unwrap().drop_listing();
                let fresh = self.person_identity_refused(&identity.token).await?;
                self.history_as(&fresh, endpoint, before)
                    .await
                    .map(|m| (fresh, m))
            }
            other => other.map(|m| (identity, m)),
        };
        let (identity, messages) = result.map_err(|e| self.person_error(&scope, &e))?;
        Ok(History {
            identity: identity.name,
            messages,
        })
    }

    async fn history_as(
        self: &Arc<Self>,
        identity: &PersonIdentity,
        peer: &Endpoint,
        before: Option<&str>,
    ) -> relaycast::Result<Vec<DirectMessage>> {
        let http = sdk_gaps::http(&identity.base_url, &identity.token)?;
        let scope = self.person_scope(identity);
        let pending = self.person_deliveries(identity, &scope).await;
        if pending.is_none() {
            // The poll failed (a workspace pause, a refused token): the
            // listing is read, not taken from the kept copy, so its request
            // meets the same refusal and the caller gets it, not a lookup
            // over an older listing.
            self.messaging.lock().unwrap().drop_listing();
        }
        if self.new_person_deliveries(pending.as_deref().unwrap_or_default()) {
            // Any incoming DM can be the proof an earlier lookup lacked.
            self.messaging.lock().unwrap().forget_misses(None);
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
        let (mut conversations, mut kept) = self
            .listed_conversations(&http, identity, &scope, false)
            .await?;
        let (selected, newest) = loop {
            let found = self
                .select_conversation(
                    &http,
                    identity,
                    &scope,
                    peer,
                    &miss_key,
                    preferred.as_deref(),
                    conversations,
                )
                .await?;
            if found.0.is_some() || !kept {
                break found;
            }
            // A kept listing can be up to LISTING_TTL old and miss a
            // conversation started since: an empty answer, and a miss, rest
            // only on a listing this call read.
            self.messaging.lock().unwrap().drop_listing();
            (conversations, kept) = self
                .listed_conversations(&http, identity, &scope, true)
                .await?;
        };
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
        // The lookup's read of the newest page is the page asked for.
        let page = match newest.filter(|_| before.is_none()) {
            Some(page) => page,
            None => {
                self.person_read(
                    &scope,
                    sdk_gaps::dm_messages(&http, &selected, HISTORY_LIMIT, before),
                )
                .await?
            }
        };
        let read = acks::ConversationRead {
            identity: identity.clone(),
            scope: scope.clone(),
            conversation: selected,
            on_page: page.iter().filter_map(|m| text(&m["id"])).collect(),
            latest: before.is_none(),
        };
        let hydrated = self.hydrate(&http, identity, &scope, page).await?;
        // Read on Relaycast after the page is returned, and only this
        // conversation: there an ack is also a read.
        self.settle_read(read);
        Ok(threaded(&hydrated, &identity.name))
    }

    /// Whether conversation `id` (listed as `candidate`) proved the address
    /// `key` names within [`PROOF_TTL`] and still has the agent it proved
    /// as a participant.
    fn proven(&self, key: &(String, String, String), id: &str, candidate: &Value) -> bool {
        let state = self.messaging.lock().unwrap();
        let Some(proven) = state.proven.get(key) else {
            return false;
        };
        proven.conversation == id
            && proven.at.elapsed() < PROOF_TTL
            && candidate["participants"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| p["agent_id"].as_str() == Some(proven.agent_id.as_str()))
    }

    /// The conversation `peer` names among `conversations` (the one
    /// `preferred` first), and its newest page when the lookup read it.
    #[allow(clippy::too_many_arguments, clippy::result_large_err)]
    async fn select_conversation(
        &self,
        http: &crate::relay::diagnostic_http::HttpClient,
        identity: &PersonIdentity,
        scope: &WorkspaceScope,
        peer: &Endpoint,
        miss_key: &(String, String, String),
        preferred: Option<&str>,
        mut conversations: Vec<Listed>,
    ) -> relaycast::Result<(Option<String>, Option<Vec<Value>>)> {
        // The conversation proved before first, then those whose other side
        // goes by the address's name: an address is `<name>@<machine>`, so
        // the conversation it names is almost always one of them, and the
        // walk back for proof through other agents' long conversations is
        // left for when none of them proves it.
        let named = match peer {
            Endpoint::Address(address) => address.split('@').next(),
            _ => None,
        };
        conversations.sort_by_key(|c| {
            let id = c.conversation["id"].as_str();
            let names_it = named.is_some_and(|name| {
                c.conversation["participants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|p| p["agent_name"].as_str() == Some(name))
            });
            let proven = self
                .messaging
                .lock()
                .unwrap()
                .proven
                .get(miss_key)
                .map(|p| p.conversation.clone());
            (
                proven.as_deref() != id,
                preferred.is_none() || id != preferred,
                !names_it,
            )
        });
        let mut selected: Option<String> = None;
        // The selected conversation's newest page, when the lookup read it.
        let mut newest: Option<Vec<Value>> = None;
        match peer {
            Endpoint::Address(address) => {
                {
                    // Conversations no longer listed are not remembered.
                    let listed: HashSet<String> = conversations
                        .iter()
                        .filter_map(|c| text(&c.conversation["id"]))
                        .collect();
                    let mut state = self.messaging.lock().unwrap();
                    if state.checked.len() >= DETAILS_KEPT {
                        state.checked.clear();
                    }
                    if let Some(checked) = state.checked.get_mut(miss_key) {
                        checked.retain(|id, _| listed.contains(id));
                    }
                }
                for listed in &conversations {
                    let candidate = &listed.conversation;
                    let Some(id) = text(&candidate["id"]) else {
                        continue;
                    };
                    // A conversation whose other side has neither the
                    // address's name nor the agent id it carries cannot
                    // hold its proof: it is not read. An agent you never
                    // wrote to is then answered without reading any.
                    if !may_prove(candidate, address) {
                        continue;
                    }
                    // A conversation read without proof is read again only
                    // once the listing shows it changed. What was read before
                    // an error stays read, so a retry goes on from there.
                    // A kept listing can be up to LISTING_TTL old, so a
                    // change it does not show yet is read once it is
                    // listed again. A miss is cached only off a listing
                    // the call read from Relaycast (`history_as`), so a
                    // conversation started elsewhere is found at most
                    // EXACT_MISS_TTL after it started, and sooner on
                    // anything that forgets misses.
                    let listed = Checked::of(listed);
                    let unchanged = self
                        .messaging
                        .lock()
                        .unwrap()
                        .checked
                        .get(miss_key)
                        .and_then(|checked| checked.get(&id))
                        .is_some_and(|checked| checked.covers(&listed));
                    if unchanged {
                        continue;
                    }
                    // Proved for this address within PROOF_TTL, by this
                    // identity in this workspace, and its peer still the
                    // agent proved: the proof is not walked for again on
                    // every read (a long conversation's proof can be many
                    // pages back). Sign-out or another account forgets it.
                    if self.proven(miss_key, &id, candidate) {
                        selected = Some(id);
                        break;
                    }
                    // An address that embeds the peer's agent id is proved by
                    // the participants alone: no message has to be read.
                    if endpoint_binding(candidate, &[], address, &identity.name).is_some() {
                        selected = Some(id);
                        break;
                    }
                    let first = self
                        .person_read(scope, sdk_gaps::dm_messages(http, &id, HISTORY_LIMIT, None))
                        .await?;
                    let mut proof = endpoint_binding(candidate, &first, address, &identity.name);
                    let mut older: Option<Vec<Value>> = None;
                    let mut seen = HashSet::new();
                    // The address-bearing message may be older than the
                    // latest page: walk back until it is found or the
                    // conversation ends.
                    while proof.is_none() {
                        let page = older.as_ref().unwrap_or(&first);
                        if (page.len() as u32) < HISTORY_LIMIT {
                            break;
                        }
                        let Some(cursor) = page.last().and_then(|m| text(&m["id"])) else {
                            break;
                        };
                        if !seen.insert(cursor.clone()) {
                            break;
                        }
                        let page = self
                            .person_read(
                                scope,
                                sdk_gaps::dm_messages(http, &id, HISTORY_LIMIT, Some(&cursor)),
                            )
                            .await?;
                        proof = endpoint_binding(candidate, &page, address, &identity.name);
                        older = Some(page);
                    }
                    if let Some((agent_id, _)) = proof {
                        self.messaging.lock().unwrap().proven.insert(
                            miss_key.clone(),
                            Proven {
                                conversation: id.clone(),
                                agent_id,
                                at: Instant::now(),
                            },
                        );
                        selected = Some(id);
                        newest = Some(first);
                        break;
                    }
                    self.messaging
                        .lock()
                        .unwrap()
                        .checked
                        .entry(miss_key.clone())
                        .or_default()
                        .insert(id, listed);
                }
            }
            Endpoint::Name(name) => {
                let conversations: Vec<Value> =
                    conversations.into_iter().map(|c| c.conversation).collect();
                selected = find_conversation(&conversations, &identity.name, name);
            }
        }
        Ok((selected, newest))
    }

    /// Fills in what DM history omits (`thread_id`, and on older servers the
    /// sender id and address) from the single-message endpoint, and adds a
    /// recent reply's parent from outside the page.
    async fn hydrate(
        &self,
        http: &crate::relay::diagnostic_http::HttpClient,
        identity: &PersonIdentity,
        scope: &WorkspaceScope,
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
                let metadata = self.message_detail(http, identity, scope, &id).await?;
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
                hydrated.push(self.message_detail(http, identity, scope, &parent).await?);
            }
        }
        Ok(hydrated)
    }

    async fn message_detail(
        &self,
        http: &crate::relay::diagnostic_http::HttpClient,
        identity: &PersonIdentity,
        scope: &WorkspaceScope,
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
        // Each detail read is observed on its own: an overload answer
        // pauses the workspace, and the reads not yet sent are refused.
        let value = self.person_read(scope, sdk_gaps::message(http, id)).await?;
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

    /// Your 1:1 conversations as listed, from the listing kept for this
    /// identity and token unless `fresh`, or from Relaycast; and whether
    /// they came from the kept listing.
    #[allow(clippy::result_large_err)] // the SDK's own error type
    async fn listed_conversations(
        &self,
        http: &crate::relay::diagnostic_http::HttpClient,
        identity: &PersonIdentity,
        scope: &WorkspaceScope,
        fresh: bool,
    ) -> relaycast::Result<(Vec<Listed>, bool)> {
        let key: ListingKey = (
            self.plugins
                .cloud
                .account()
                .map(|a| account_key(&a))
                .unwrap_or_default(),
            identity.name.clone(),
            identity.base_url.clone(),
            identity.token.clone(),
        );
        let drops = {
            let mut state = self.messaging.lock().unwrap();
            if !fresh {
                if let Some(kept) = state.kept_listing(&key) {
                    return Ok((kept, true));
                }
            }
            state.listing_drops
        };
        let listing = self
            .person_read(scope, sdk_gaps::dm_conversations(http))
            .await?;
        let listed: Vec<Listed> = direct_conversations(&listing, &identity.name)
            .iter()
            .map(Listed::of)
            .collect();
        // A send or a reply that dropped the listing while it was read
        // may have changed it: this answer is returned, not kept.
        self.messaging
            .lock()
            .unwrap()
            .keep_listing(key, &listed, drops);
        Ok((listed, false))
    }

    /// Your 1:1 conversations, as Relaycast lists them.
    pub async fn conversations(&self) -> Result<Conversations, RpcError> {
        let identity = self.person_identity(false).await?;
        let scope = self.person_scope(&identity);
        self.person_read_allowed(&scope)?;
        let list = |identity: PersonIdentity| async move {
            let http = sdk_gaps::http(&identity.base_url, &identity.token)?;
            let scope = self.person_scope(&identity);
            self.person_read(&scope, sdk_gaps::dm_conversations(&http))
                .await
        };
        let (identity, listing) = match list(identity.clone()).await {
            Err(error) if error.is_auth_rejection() => {
                let fresh = self.person_identity_refused(&identity.token).await?;
                (fresh.clone(), list(fresh).await)
            }
            other => (identity, other),
        };
        let listing = listing.map_err(|e| self.person_error(&scope, &e))?;
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
            control_url: None,
            gate_url: None,
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
            control_url: None,
            gate_url: None,
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
    fn a_gate_only_workspace_is_yours_when_you_enrolled_at_its_gate() {
        let gate = Workspace {
            key: Secret::default(),
            base_url: "https://gate.example".into(),
            workspace_id: Some("rw_account".into()),
            source: Default::default(),
            control_url: None,
            gate_url: Some("https://gate.example".into()),
        };
        let person = PersonIdentity {
            name: gate_person_name("user-1"),
            agent_id: "agent_person".into(),
            token: Secret::new("rg_person"),
            base_url: gate.base_url.clone(),
        };
        // The store's key is empty beside a gate, and never what decides.
        for account_key in [
            None,
            Some(&Secret::default()),
            Some(&Secret::new("rk_live_x")),
        ] {
            assert!(is_identity_workspace(&person, &gate, account_key));
        }
        let elsewhere = Workspace {
            base_url: "https://other-gate.example".into(),
            gate_url: Some("https://other-gate.example".into()),
            ..gate.clone()
        };
        assert!(!is_identity_workspace(&person, &elsewhere, None));
    }

    #[test]
    fn the_gate_name_of_a_person_is_stable_and_derived_from_the_user_id() {
        assert_eq!(gate_person_name("user-1"), "person-c6c289e49e9c05b2");
        assert_eq!(gate_person_name("user-1"), gate_person_name("user-1"));
        assert_ne!(gate_person_name("user-1"), gate_person_name("user-2"));
        assert!(!gate_person_name("ctl:x").starts_with("ctl:"));
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
    fn key(token: &str) -> ListingKey {
        (
            "account".into(),
            ME.into(),
            "https://cast.example".into(),
            Secret::new(token),
        )
    }

    #[test]
    fn a_kept_listing_holds_no_message_and_serves_only_its_own_key() {
        let mut listed = conversation("conv_1", "agent_peer");
        listed["last_message"] = json!({"id": "m1", "text": "a private body"});
        listed["participants"][0]["agent_bio"] = json!("a private bio");
        let kept = Listed::of(&listed);
        let held = kept.conversation.to_string();
        assert!(!held.contains("private"), "{held}");
        assert_eq!(kept.conversation["id"], "conv_1");
        assert!(kept.marked);

        let mut state = MessagingState::default();
        state.keep_listing(
            key("at_one"),
            std::slice::from_ref(&kept),
            state.listing_drops,
        );
        assert!(state.kept_listing(&key("at_one")).is_some());
        // Another token (a refused one replaced) or identity reads its own,
        // and the kept one is dropped.
        assert!(state.kept_listing(&key("at_two")).is_none());
        assert!(state.kept_listing(&key("at_one")).is_none());

        state.keep_listing(
            key("at_one"),
            std::slice::from_ref(&kept),
            state.listing_drops,
        );
        state.listing.as_mut().unwrap().at = Instant::now() - LISTING_TTL;
        assert!(state.kept_listing(&key("at_one")).is_none());

        state.keep_listing(
            key("at_one"),
            std::slice::from_ref(&kept),
            state.listing_drops,
        );
        state.forget_misses(None);
        assert!(state.listing.is_none());

        state.keep_listing(
            key("at_one"),
            &vec![kept.clone(); LISTING_KEPT + 1],
            state.listing_drops,
        );
        assert!(state.listing.is_none());
    }

    #[test]
    fn a_listing_read_before_a_drop_is_not_kept() {
        let kept = Listed::of(&conversation("conv_1", "agent_peer"));
        let mut state = MessagingState::default();
        // Expiry is not a drop: a read started before it is kept.
        let drops = state.listing_drops;
        state.keep_listing(key("at_one"), std::slice::from_ref(&kept), drops);
        state.listing.as_mut().unwrap().at = Instant::now() - LISTING_TTL;
        assert!(state.kept_listing(&key("at_one")).is_none());
        state.keep_listing(key("at_one"), std::slice::from_ref(&kept), drops);
        assert!(state.listing.is_some());

        for drop in [
            MessagingState::drop_listing as fn(&mut MessagingState),
            |state| state.forget_misses(None),
            |state| state.forget_misses(Some(&("w".into(), ME.into(), "peer".into()))),
            MessagingState::reset,
        ] {
            let drops = state.listing_drops;
            drop(&mut state);
            state.keep_listing(key("at_one"), std::slice::from_ref(&kept), drops);
            assert!(state.listing.is_none());
        }
    }

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
