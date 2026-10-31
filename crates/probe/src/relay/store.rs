//! The agent store, `injectable-agents.json` in the app data directory: one
//! format on macOS and Linux.
//!
//! It holds every registration and its agent token, so it is written 0600
//! and only by swapping a fully written temporary file into place. Every
//! writer (this daemon, and until the thin clients land the apps themselves)
//! keeps the whole store in memory and writes it back whole, so a save takes
//! an exclusive `flock` on `injectable-agents.json.lock`, reads the file,
//! folds this process's changes onto whatever another process wrote since
//! (`Store::merged`), and writes the result. A file that exists but does not
//! decode is moved aside as `injectable-agents.json.unreadable-<time>`, never
//! replaced; one that cannot be read at all blocks every save.
//!
//! ```json
//! {
//!   "registrations": [{"name": "codex-api-3f2a", "agentID": "a_1",
//!     "target": {"kind": "codex", "id": "01a0…"}, "title": "Fix tests",
//!     "baseURL": "https://cast.agentrelay.com", "registeredAt": "2026-09-30T10:00:00Z",
//!     "workspaceKey": "rk_live_…", "machinePrefix": "desk", "addedBySession": false,
//!     "webhook": {"id", "url", "token", "channelName", "channelID"},
//!     "replyWithFinalAnswer": true, "integrationChannelID": "…", "integrationChannelName": "…",
//!     "integrations": [{"id", "provider", "resource", "workspaceID", "pathGlob", …}],
//!     "alias": {"name", "agentID", "token", "registeredAt"}}],
//!   "tokens": {"codex-api-3f2a": "at_live_…"},
//!   "cloud": {"key", "baseURL", "workspaceID", "accountWorkspaceID", "name", "relayfileWorkspaceID"},
//!   "cloudSession": {"accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt", "siteURL"},
//!   "allowSelfRegistration": true, "autoActivate": false, "agentLedDefaultsApplied": true,
//!   "pendingCleanups": [{"kind": "agent", "name", "baseURL", "workspaceKey"}],
//!   "testSenders": {"<key ref>": {"name", "token"}},
//!   "replies": [{"agentID", "messageID", "destination": {"thread": {"_0": "m_1"}}, "claimed", …}],
//!   "replyRoutes": [{"agentID", "messageID"}],
//!   "injectedDeliveryIDs": ["del_…"],
//!   "inDoubtDeliveryIDs": ["del_…"]
//! }
//! ```
//!
//! This is the macOS app's format plus `inDoubtDeliveryIDs`; the macOS app
//! still decodes it. Stores written by the Linux app (a top-level
//! `workspaceID`/`workspaceName`/`relayfileWorkspaceID` for the signed-in
//! account, and webhooks, integrations and reply parents keyed by session)
//! and by macOS 2026.09.5 (`workspaceKeySource`) are migrated when read, and
//! written back once in this format.

use crate::relay::delivery::policy::{Delivery, MessageRef};
use crate::relay::links::Endpoint;
use crate::relay::workspace::{Secret, DEFAULT_BASE_URL};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
mod date_fields;
use date_fields::{null_as_default, optional_timestamp, optional_timestamps, timestamp};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::{
    fmt, fs,
    io::{ErrorKind, Write},
};

/// Delivery ids remembered as handled. A redelivered message is already
/// stopped by these; the bound only keeps the file small.
pub const REMEMBERED_DELIVERIES: usize = 1_000;
// Relaycast delivery IDs never use this local, versioned marker namespace.
// Legacy store writers retain the established injectedDeliveryIDs strings.
const REFUSED_DELIVERY_MARKER: &str = "local-refusal:v1:";
const PENDING_REFUSAL_MARKER: &str = "local-pending-refusal:v1:";

/// How many archived agents the store keeps a record of.
pub const ARCHIVED_SESSIONS_KEPT: usize = 50;
/// Sent reply records and reply routes kept per store.
pub const REMEMBERED_REPLIES: usize = 500;

/// Which kind of local session an agent stands for, and so which route a
/// message takes into it.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
pub enum SessionKind {
    /// An existing Pi session connected through the bundled extension.
    #[serde(rename = "pi")]
    Pi,
    /// A Codex thread, in the desktop app or a terminal `codex`.
    #[serde(rename = "codex")]
    Codex,
    /// A Claude Code session in a terminal: its cross-session inbox.
    #[serde(rename = "claude-terminal")]
    ClaudeTerminal,
    /// A Claude desktop app / claude.ai/code session.
    #[serde(rename = "claude-cloud")]
    ClaudeCloud,
    /// A probe-managed Grok ACP session with a verified leader binding.
    #[serde(rename = "grok")]
    Grok,
    /// An already-open Grok ACP session registered with immutable proof of
    /// its leader. A separate kind from `Grok`, so a registration names one
    /// route for good and can never be delivered through the other.
    #[serde(rename = "grok-open")]
    GrokOpen,
    /// A probe-managed authenticated OpenCode server session.
    #[serde(rename = "opencode")]
    OpenCode,
    /// A Muse session a person opened in a terminal, delivered to through a
    /// probe-owned courier Muse session in the same workspace and trust (no
    /// keystrokes into the person's session; Muse's own peer messaging
    /// carries the turn). Discovered from Muse's runtime session registry.
    #[serde(rename = "muse-open")]
    MuseOpen,
    /// An OpenCode session a person opened in a plain `opencode` TUI,
    /// reached through Agent Relay's OpenCode plugin: a per-process Unix
    /// socket that answers only delivery's requests for the sessions that
    /// process holds. Discovered from the plugin's per-pid records.
    #[serde(rename = "opencode-open")]
    OpenCodeOpen,
    /// A Devin CLI session a person runs in a terminal: its `devin acp`
    /// agent process holds `<devin>/cli/session_locks/<session>.lock` open,
    /// which is the kernel proof used for discovery and caller
    /// identification. Delivery writes the session's inbox file, which its
    /// lifecycle hooks drain into the conversation.
    #[serde(rename = "devin")]
    Devin,
    /// A Cursor CLI (`cursor-agent`) session a person runs in a terminal:
    /// the process holds its conversation's `store.db` open, which is the
    /// kernel proof used for discovery and caller identification. Delivery
    /// stages a message in Agent Relay's inbox, which Agent Relay's hooks in
    /// `~/.cursor/hooks.json` hand to the session at its next tool call or
    /// when its turn ends (`relay::cursor_cli`). Not a Cursor Cloud agent.
    #[serde(rename = "cursor-cli")]
    CursorCli,
    /// An OpenClaw agent on the person's local OpenClaw Gateway, reached as
    /// a loopback operator client. Each relay sender gets a session of its
    /// own on that agent, never the person's main chat (`relay::openclaw`).
    #[serde(rename = "openclaw")]
    OpenClaw,
    /// A Hermes Agent home whose gateway serves its API on loopback. Each
    /// relay sender gets a Hermes session of its own (`relay::hermes`).
    #[serde(rename = "hermes")]
    Hermes,
}

/// One local session a message can be injected into. `id` is the session's
/// own id, never a title, so a message cannot land in whichever session
/// happens to share a name.
#[derive(
    Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
pub struct Target {
    pub kind: SessionKind,
    pub id: String,
}

impl Target {
    pub fn new(kind: SessionKind, id: impl Into<String>) -> Target {
        Target {
            kind,
            id: id.into(),
        }
    }

    /// Whether `id` has the exact shape its kind uses: a UUID for Codex and
    /// Claude Code, a tagged `session_…`/`cse_…` id for the Claude app.
    pub fn is_valid(&self) -> bool {
        match self.kind {
            SessionKind::Pi | SessionKind::Codex | SessionKind::ClaudeTerminal => is_uuid(&self.id),
            SessionKind::ClaudeCloud => is_claude_session_id(&self.id),
            SessionKind::Grok | SessionKind::GrokOpen | SessionKind::MuseOpen => is_uuid(&self.id),
            SessionKind::OpenCode | SessionKind::OpenCodeOpen => {
                self.id.strip_prefix("ses_").is_some_and(|body| {
                    (4..=128).contains(&body.len())
                        && body.bytes().all(|byte| byte.is_ascii_alphanumeric())
                })
            }
            SessionKind::Devin => crate::relay::devin::is_session_id(&self.id),
            SessionKind::CursorCli => crate::relay::cursor_cli::is_session_id(&self.id),
            SessionKind::OpenClaw => crate::relay::openclaw::is_agent_id(&self.id),
            SessionKind::Hermes => crate::relay::hermes::is_profile(&self.id),
        }
    }

    /// `kind:id`.
    pub fn key(&self) -> String {
        format!("{}:{}", self.kind.as_str(), self.id)
    }
}

/// A hyphenated UUID, 36 characters, any case.
pub fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

/// `session_` or `cse_` followed by 8–64 ASCII letters and digits.
pub fn is_claude_session_id(value: &str) -> bool {
    let body = value
        .strip_prefix("session_")
        .or_else(|| value.strip_prefix("cse_"));
    body.is_some_and(|body| {
        (8..=64).contains(&body.len()) && body.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

/// An inbound webhook that posts into a channel only this agent listens to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Webhook {
    pub id: String,
    pub url: String,
    /// The `wh_live_…` bearer callers send; shown once, when created.
    pub token: Secret,
    #[serde(rename = "channelName")]
    pub channel_name: String,
    #[serde(rename = "channelID")]
    pub channel_id: String,
}

impl Webhook {
    /// The channel a webhook for `agent` posts into: `hook-<agent>`, with a
    /// nonce so a recreated hook never reuses an archived channel, at most
    /// 64 characters.
    pub fn channel_name(agent: &str, nonce: Option<&str>) -> String {
        let base = format!("hook-{agent}");
        match nonce.filter(|nonce| !nonce.is_empty()) {
            None => base.chars().take(64).collect(),
            Some(nonce) => {
                let suffix: String = format!("-{}", nonce.chars().take(16).collect::<String>());
                let room = 64 - suffix.chars().count();
                format!("{}{suffix}", base.chars().take(room).collect::<String>())
            }
        }
    }
}

/// A relayfile subscription, journaled before anything external is created
/// and kept until setup or cleanup finishes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Integration {
    pub id: String,
    pub provider: String,
    pub resource: String,
    #[serde(rename = "workspaceID")]
    pub workspace_id: String,
    #[serde(rename = "pathGlob", default, skip_serializing_if = "Option::is_none")]
    pub path_glob: Option<String>,
    #[serde(
        rename = "inboundURL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub inbound_url: Option<String>,
    #[serde(
        rename = "writebackURL",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub writeback_url: Option<String>,
    #[serde(rename = "webhookID", default, skip_serializing_if = "Option::is_none")]
    pub webhook_id: Option<String>,
    #[serde(
        rename = "cloudSubscriptionID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cloud_subscription_id: Option<String>,
    #[serde(
        rename = "subscriptionID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub subscription_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready: Option<bool>,
    /// A terminal provider event was delivered; cleanup must converge even
    /// if its first cloud request or the process stops before `ready` flips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<bool>,
}

impl Integration {
    pub fn new(provider: &str, resource: &str, workspace_id: &str) -> Integration {
        Integration {
            id: random_uuid(),
            provider: provider.into(),
            resource: resource.into(),
            workspace_id: workspace_id.into(),
            path_glob: None,
            inbound_url: None,
            writeback_url: None,
            webhook_id: None,
            cloud_subscription_id: None,
            subscription_id: None,
            ready: None,
            terminal: None,
        }
    }

    /// The Relaycast webhook name earlier versions created per subscription.
    pub fn webhook_name(&self) -> String {
        format!("desktop-integration-{}", self.id)
    }
}

/// One session made reachable: the Relaycast agent that stands for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registration {
    pub name: String,
    #[serde(rename = "agentID")]
    pub agent_id: String,
    pub target: Target,
    #[serde(default, deserialize_with = "null_as_default")]
    pub title: String,
    /// The Relaycast origin the agent was registered with.
    #[serde(rename = "baseURL")]
    pub base_url: String,
    /// ISO-8601, seconds precision.
    #[serde(rename = "registeredAt", deserialize_with = "timestamp")]
    pub registered_at: String,
    /// The key the agent was registered with, so it is removed from that
    /// workspace even after this computer switches to another.
    #[serde(
        rename = "workspaceKey",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_key: Option<Secret>,
    /// Captured at registration, so a later computer rename does not make
    /// copied addresses disagree with Relaycast.
    #[serde(
        rename = "machinePrefix",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub machine_prefix: Option<String>,
    /// The session put itself on the relay through the relay-send socket.
    #[serde(
        rename = "addedBySession",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub added_by_session: Option<bool>,
    /// Made by the bounded auto-activation reconciler, and therefore owned
    /// by its ended-session lifecycle rather than by a manual switch.
    #[serde(
        rename = "autoActivated",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_activated: Option<bool>,
    /// First pass on which this automatic registration was no longer an
    /// eligible live session. ISO-8601, after migration from legacy seconds.
    #[serde(
        rename = "missingSince",
        default,
        deserialize_with = "optional_timestamp",
        skip_serializing_if = "Option::is_none"
    )]
    pub missing_since: Option<String>,
    /// When its provider was first seen to record the session as archived.
    /// An archived session leaves the relay whatever added it, and its name
    /// is released; this marks it until Relaycast confirms the removal.
    #[serde(
        rename = "archivedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub archived_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook: Option<Webhook>,
    #[serde(
        rename = "replyWithFinalAnswer",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reply_with_final_answer: Option<bool>,
    #[serde(
        rename = "integrationChannelID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub integration_channel_id: Option<String>,
    #[serde(
        rename = "integrationChannelName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub integration_channel_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrations: Option<Vec<Integration>>,
    /// For a `grok-open` session, the exact already-open binding (its
    /// `existing:grok:` reference) this agent was registered against.
    /// Delivery requires that same binding; after its leader is replaced, the
    /// agent is refused until it is registered again.
    #[serde(
        rename = "routeBinding",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub route_binding: Option<String>,
    /// The hosted MCP the session said it has (`agent-relay-sessions`), or
    /// `none`, in its own `POST /register`; `None` when it did not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp: Option<String>,
    /// For an agent this computer spawned for Agent Relay: the spawn node
    /// it is on and the invocation that made it (`relay::spawn`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn: Option<SpawnOrigin>,
    /// The name it was renamed to: see `aliases`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<AgentAlias>,
    /// Names it was renamed from, forwarding for a day: see `aliases`.
    #[serde(rename = "retiredAliases", default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_aliases: Option<Vec<RetiredAlias>>,
    /// For a Claude Code terminal session: when `/clear` started the
    /// conversation this agent moved to, in milliseconds since the epoch.
    /// A message sent before then was meant for the cleared conversation
    /// and is not delivered into this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleared: Option<i64>,
}

impl Registration {
    /// The machine half of this agent's address: `<prefix>-<agent id>` for
    /// a session on its own direct node (the agent id keeps it unique beside
    /// another session on the same computer), the node name for an agent on
    /// this computer's spawn node.
    pub fn machine_address(&self, current_prefix: &str) -> String {
        if let Some(spawn) = &self.spawn {
            return spawn.node_name.clone();
        }
        format!(
            "{}-{}",
            self.machine_prefix.as_deref().unwrap_or(current_prefix),
            self.agent_id
        )
    }

    /// `name@<prefix>-<agent id>`.
    pub fn direct_address(&self, current_prefix: &str) -> String {
        format!("{}@{}", self.name, self.machine_address(current_prefix))
    }

    /// The same registration under another agent, as after a rename. The
    /// integration channel belongs to the old agent and is left behind.
    pub fn renamed(&self, name: &str, agent_id: &str) -> Registration {
        Registration {
            name: name.into(),
            agent_id: agent_id.into(),
            alias: None,
            retired_aliases: None,
            ..self.clone()
        }
    }

    pub fn has_integrations(&self) -> bool {
        self.integrations
            .as_ref()
            .is_some_and(|list| !list.is_empty())
    }
}

/// The signed-in account's Relaycast workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudWorkspace {
    pub key: Secret,
    #[serde(rename = "baseURL", default, deserialize_with = "null_as_default")]
    pub base_url: String,
    /// The Relaycast workspace id (`rw_…`).
    #[serde(
        rename = "workspaceID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_id: Option<String>,
    /// The Agent Relay (Cloud) workspace chosen at sign-in.
    #[serde(
        rename = "accountWorkspaceID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub account_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        rename = "relayfileWorkspaceID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub relayfile_workspace_id: Option<String>,
}

/// The Agent Relay sign-in session kept for acting later without a browser.
/// Dates stay as the ISO-8601 strings Cloud sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudSession {
    #[serde(rename = "accessToken")]
    pub access_token: Secret,
    #[serde(
        rename = "accessTokenExpiresAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub access_token_expires_at: Option<String>,
    #[serde(
        rename = "refreshToken",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub refresh_token: Option<Secret>,
    #[serde(
        rename = "refreshTokenExpiresAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub refresh_token_expires_at: Option<String>,
    #[serde(rename = "siteURL")]
    pub site_url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CleanupKind {
    Channel,
    Agent,
}

/// An agent whose session was archived, so it left the relay: kept so the
/// person can see where an agent went after its name was released.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchivedSession {
    pub name: String,
    pub address: String,
    pub target: Target,
    #[serde(default)]
    pub title: String,
    /// ISO-8601, seconds precision.
    #[serde(rename = "archivedAt")]
    pub archived_at: String,
}

/// A Relaycast leftover whose removal failed, retried until it is gone.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PendingCleanup {
    pub kind: CleanupKind,
    pub name: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "workspaceKey")]
    pub workspace_key: Secret,
}

/// A Cloud reconciliation that must survive sign-out, a workspace switch,
/// or the daemon stopping. The credential is retained only until Cloud has
/// accepted the empty identity set, then it is revoked when requested and
/// the record is removed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopIdentityClear {
    #[serde(rename = "requestID", default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(rename = "workspaceID")]
    pub workspace_id: String,
    #[serde(rename = "sourceID")]
    pub source_id: String,
    pub session: CloudSession,
    #[serde(rename = "revokeAfter")]
    pub revoke_after: bool,
}

impl DesktopIdentityClear {
    pub fn new(
        workspace_id: String,
        source_id: String,
        session: CloudSession,
        revoke_after: bool,
    ) -> DesktopIdentityClear {
        DesktopIdentityClear {
            request_id: Some(random_uuid()),
            workspace_id,
            source_id,
            session,
            revoke_after,
        }
    }

    /// Records written before request IDs existed get one deterministic
    /// identity, so two app processes cannot fork one cleanup during load.
    fn normalized(&self) -> DesktopIdentityClear {
        if self.request_id.as_deref().is_some_and(is_uuid) {
            return self.clone();
        }
        let fields = [
            "desktop-identity-clear-v1",
            &self.workspace_id,
            &self.source_id,
            if self.revoke_after { "1" } else { "0" },
        ];
        let material = fields
            .iter()
            .map(|field| format!("{}:{field}", field.len()))
            .collect::<String>();
        let mut bytes: [u8; 16] = Sha256::digest(material.as_bytes())[..16]
            .try_into()
            .expect("SHA-256 has sixteen prefix bytes");
        // RFC 9562 version 8: an application-defined UUID with the standard
        // variant, carrying this deterministic SHA-256 prefix.
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let request_id = format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        );
        DesktopIdentityClear {
            request_id: Some(request_id),
            ..self.clone()
        }
    }
}

/// The agent this computer sends test messages as, per workspace key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestSender {
    pub name: String,
    pub token: Secret,
}

/// Where an automatic final answer goes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Destination {
    /// Replies persisted by earlier versions, to a sender's name.
    Dm(Payload),
    /// An exact sender endpoint.
    Address(Payload),
    /// Beneath a message: the answer threads under the question.
    Thread(Payload),
}

/// The single associated value, as Swift's `Codable` encodes enum payloads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payload {
    #[serde(rename = "_0")]
    pub value: String,
}

impl Destination {
    pub fn thread(parent: &str) -> Destination {
        Destination::Thread(Payload {
            value: parent.into(),
        })
    }
}

/// Automatic-answer work, created only for a message that reached (or may
/// have reached) a session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reply {
    #[serde(rename = "agentID")]
    pub agent_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
    pub destination: Destination,
    /// Set before anything is sent, so a concurrent transcript read or an
    /// uncertain network result cannot produce a second answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claimed: Option<bool>,
    #[serde(
        rename = "senderName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sender_name: Option<String>,
    #[serde(
        rename = "senderAddress",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sender_address: Option<String>,
    /// The channel the question arrived in.
    #[serde(rename = "channelID", default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Present on replies whose parent route was validated when they were
    /// created; earlier ones are eligible for the legacy cleanup.
    #[serde(
        rename = "routingVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub routing_version: Option<u32>,
}

impl Reply {
    /// The answer a delivery may get, or `None`: only people and agents get
    /// automatic answers. A provider event in the agent's integration
    /// channel, or anything a webhook posted, is not a question, and an
    /// automatic thread reply there would be written back to the provider.
    pub fn for_delivery(
        delivery: &Delivery,
        registration: &Registration,
        prefix: &str,
    ) -> Option<Reply> {
        if registration.reply_with_final_answer == Some(false)
            || registration.target.kind == SessionKind::ClaudeCloud
        {
            return None;
        }
        let from_self = match delivery.sender_address.as_deref().filter(|a| !a.is_empty()) {
            Some(address) => {
                address == registration.direct_address(prefix)
                    || address == format!("{}@direct", registration.name)
            }
            None => delivery.sender.as_deref() == Some(registration.name.as_str()),
        };
        if from_self {
            return None;
        }
        if registration.integration_channel_id.is_some()
            && delivery.channel_id == registration.integration_channel_id
        {
            return None;
        }
        if delivery.sender.as_deref() == Some("__relay_webhook__") {
            return None;
        }
        let destination = match delivery.thread_id.as_deref().filter(|t| !t.is_empty()) {
            Some(thread) => Destination::thread(thread),
            None => {
                if registration
                    .webhook
                    .as_ref()
                    .is_some_and(|hook| Some(&hook.channel_id) == delivery.channel_id.as_ref())
                {
                    return None;
                }
                if delivery.reason.as_deref() == Some("dm") || delivery.channel_id.is_some() {
                    Destination::thread(&delivery.message_id)
                } else {
                    return None;
                }
            }
        };
        Some(Reply {
            agent_id: registration.agent_id.clone(),
            message_id: delivery.message_id.clone(),
            destination,
            claimed: None,
            sender_name: delivery.sender.clone(),
            sender_address: delivery.sender_address.clone(),
            channel_id: delivery.channel_id.clone(),
            routing_version: Some(1),
        })
    }

    /// The twelve-hex reference the injected text carried.
    pub fn message_ref(&self) -> String {
        MessageRef::of(&self.message_id)
    }

    /// Whether this answer would land in the agent's integration channel,
    /// where a thread reply is written back to the provider.
    pub fn targets_integration(&self, registration: &Registration) -> bool {
        registration
            .integration_channel_id
            .as_ref()
            .is_some_and(|channel| self.channel_id.as_ref() == Some(channel))
    }

    /// A thread reply queued by 2026.09.8 or earlier: its channel is
    /// unknown, so it could be an answer to a provider event.
    pub fn is_unattributed_legacy_thread_reply(&self) -> bool {
        self.routing_version.is_none()
            && self.channel_id.is_none()
            && self.claimed != Some(true)
            && matches!(self.destination, Destination::Thread(_))
    }
}

/// A parent exposed in an injected reply command, which the session may
/// answer through the relay-send socket. Kept apart from automatic-answer
/// work so turning automatic answers on later cannot answer messages that
/// arrived while they were off.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ReplyRoute {
    #[serde(rename = "agentID")]
    pub agent_id: String,
    #[serde(rename = "messageID")]
    pub message_id: String,
}

/// Everything the core remembers about this computer's agents.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Store {
    #[serde(default)]
    pub registrations: Vec<Registration>,
    /// Forward-only, local binding of an immutable Relaycast agent id to the
    /// signed-in person present when this desktop registered it. Older agents
    /// have no entry and remain unknown.
    #[serde(
        rename = "agentOwners",
        default,
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub agent_owners: BTreeMap<String, crate::relay::cloud_session::AgentOwner>,
    /// Agent tokens by agent name.
    #[serde(default)]
    pub tokens: BTreeMap<String, Secret>,
    /// Missing means true: self-registration is opt-out.
    #[serde(
        rename = "allowSelfRegistration",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub allow_self_registration: Option<bool>,
    /// Missing means false.
    #[serde(
        rename = "autoActivate",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_activate: Option<bool>,
    /// Experimental owner-initiated Claude continuation from mobile. Off by default.
    #[serde(
        rename = "mobileClaudeHandoff",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub mobile_claude_handoff: Option<bool>,
    /// Separate opt-in: Claude-only consent never enables another provider.
    #[serde(rename = "mobileNativeContinuation", default, skip_serializing_if = "Option::is_none")]
    pub mobile_native_continuation: Option<bool>,
    /// Missing means false: relay messages are hidden from agent chats, the
    /// agent reading each one from its hidden history.
    #[serde(
        rename = "showRelayMessages",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub show_relay_messages: Option<bool>,
    /// Missing means true: Agent Relay may start agents here unless the
    /// person turned it off.
    #[serde(rename = "acceptSpawns")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_spawns: Option<bool>,
    /// Missing means true: spawned Codex runs without its sandbox.
    #[serde(rename = "spawnFullAccessCodex")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_full_access_codex: Option<bool>,
    /// Missing means true: spawned Claude skips permission prompts.
    #[serde(rename = "spawnFullAccessClaude")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_full_access_claude: Option<bool>,
    /// Missing means false: only the node's owner may spawn here, not
    /// workspace owners and admins too.
    #[serde(rename = "spawnAllowTeammates")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_allow_teammates: Option<bool>,
    /// The most spawned agents this computer runs at once; missing means
    /// no limit, as does 0. Older untouched settings were absent (default 12);
    /// explicit values, including 12, remain the person's chosen cap.
    #[serde(
        rename = "spawnMaxAgents",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub spawn_max_agents: Option<u32>,
    /// How spawned Codex is paid for (`subscription`, `api`); missing means
    /// not stated. Advertised, never checked.
    #[serde(
        rename = "spawnBillingCodex",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub spawn_billing_codex: Option<String>,
    /// How spawned Claude is paid for, as `spawn_billing_codex`.
    #[serde(
        rename = "spawnBillingClaude",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub spawn_billing_claude: Option<String>,
    /// Owner/name keys of the repositories spawned agents may be asked to
    /// work in, advertised as the node's `repo_keys`; missing means none.
    #[serde(
        rename = "spawnRepositories",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub spawn_repositories: Option<Vec<String>>,
    /// The spawn settings of harnesses other than Codex and Claude, by id
    /// (`spawn`).
    #[serde(rename = "spawnHarnesses")]
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub spawn_harnesses: BTreeMap<String, spawn::HarnessSpawnSettings>,
    /// Durable admission attempts inside the rate-limit window. Attempts,
    /// not just successes, are recorded so Relaycast failures cannot create
    /// a retry storm.
    #[serde(
        rename = "autoActivationEvents",
        default,
        deserialize_with = "optional_timestamps",
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_activation_events: Option<Vec<String>>,
    /// The last thing keeping each session off the relay, by `target.key()`:
    /// a failed registration attempt, or the write pause or rate window that
    /// kept the pass from attempting it at all. Diagnostics only — cleared
    /// when the session registers, kept for sessions that left while
    /// blocked, and bounded at [`AUTO_ACTIVATION_FAILURES_KEPT`]. `None` is
    /// a writer that never journaled; `Some(empty)` is a real clear a
    /// merge must propagate, like `pendingRefusalSettlements`.
    #[serde(
        rename = "autoActivationFailures",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_activation_failures: Option<BTreeMap<String, ActivationFailure>>,
    #[serde(
        rename = "agentLedDefaultsApplied",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub agent_led_defaults_applied: Option<bool>,
    /// The integration settings (`direct_delivery`, `grok_leader`, ...) this
    /// computer has already turned on by default, or the person has set: each
    /// is turned on at most once, so turning one off stays off.
    #[serde(
        rename = "integrationDefaultsApplied",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub integration_defaults_applied: Option<Vec<String>>,
    #[serde(flatten)]
    pub extras: SettingsExtras,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud: Option<CloudWorkspace>,
    #[serde(
        rename = "cloudSession",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cloud_session: Option<CloudSession>,
    /// Stable, non-secret installation id. Cloud reconciles only identity
    /// rows from this desktop, never another computer owned by the person.
    #[serde(
        rename = "desktopSyncSourceID",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub desktop_sync_source_id: Option<String>,
    #[serde(
        rename = "desktopIdentityClearsPending",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub desktop_identity_clears_pending: Option<Vec<DesktopIdentityClear>>,
    #[serde(
        rename = "pendingCleanups",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub pending_cleanups: Option<Vec<PendingCleanup>>,
    /// Rotations whose saved-copy rewrite is still owed, each recorded
    /// before the replacement key's verification so a failed check does not
    /// drop it. A list, not a slot: A→B followed by B→C owes A's copies the
    /// rewrite just as much as B's, so a newer record must never overwrite
    /// an unfinished one.
    #[serde(
        rename = "pendingKeyMigrations",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub pending_key_migrations: Option<Vec<PendingKeyMigration>>,
    /// The single-slot encoding builds before this list wrote; folded into
    /// `pending_key_migrations` on decode and never serialized.
    #[serde(rename = "pendingKeyMigration", default, skip_serializing)]
    pub(crate) pending_key_migration_legacy: Option<PendingKeyMigration>,
    /// Registrations whose `renamed_to` marker Relaycast has not confirmed.
    #[serde(rename = "pendingNameMarkers", default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_name_markers: Option<Vec<String>>,
    /// Agents that left because their session was archived, newest first,
    /// at most [`ARCHIVED_SESSIONS_KEPT`].
    #[serde(
        rename = "archivedSessions",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub archived_sessions: Option<Vec<ArchivedSession>>,
    /// Complete classification identities; the rich recent-agent list stays bounded.
    #[serde(rename = "archivedSessionKeys", default, skip_serializing_if = "BTreeSet::is_empty")]
    pub archived_session_keys: std::sync::Arc<BTreeSet<String>>,
    #[serde(
        rename = "testSenders",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub test_senders: Option<BTreeMap<String, TestSender>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replies: Option<Vec<Reply>>,
    #[serde(
        rename = "replyRoutes",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub reply_routes: Option<Vec<ReplyRoute>>,
    /// Put into a session: never injected again; a redelivery is acked.
    #[serde(rename = "injectedDeliveryIDs", default)]
    pub injected_delivery_ids: Vec<String>,
    /// Possibly put into a session: never injected again, and reported
    /// failed (never acked) on redelivery, since an ack records arrival.
    /// Bounded apart from `injectedDeliveryIDs`, so later traffic cannot
    /// evict one into a resend. Each is in `injectedDeliveryIDs` too: the
    /// macOS app does not keep this list and drops it when it saves.
    #[serde(rename = "inDoubtDeliveryIDs", default)]
    pub in_doubt_delivery_ids: Vec<String>,
    /// Explicitly refused: never offer the delivery to the session again;
    /// redelivery retries only its non-retryable failure settlement.
    #[serde(
        rename = "refusedDeliveryIDs",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub refused_delivery_ids: Vec<String>,
    /// None is a legacy writer omitting the field; Some(empty) confirms
    /// that all pending refusals settled. Keep credentials until settlement.
    #[serde(
        rename = "pendingRefusalSettlements",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub pending_refusal_settlements: Option<Vec<PendingRefusal>>,
}

pub use activation_failures::{ActivationFailure, PublishedJournal, AUTO_ACTIVATION_FAILURES_KEPT};
mod activation_failures;
mod archives;
mod merge_helpers;

/// A workspace-key rotation whose saved-copy rewrite has not landed: the
/// superseded key, the origin it was found at, and the workspace id the
/// replacement must verify to again. Recorded before verification so a
/// failed check or a daemon stop cannot strand the saved copies — a later
/// refresh resolves it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingKeyMigration {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "oldKey")]
    pub old_key: Secret,
    #[serde(rename = "workspaceID")]
    pub workspace_id: String,
}

/// A refused delivery whose non-retryable settlement has not been confirmed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRefusal {
    #[serde(rename = "deliveryID")]
    pub delivery_id: String,
    #[serde(rename = "agentID")]
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl fmt::Debug for Store {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Store")
            .field(
                "registrations",
                &self
                    .registrations
                    .iter()
                    .map(|r| &r.name)
                    .collect::<Vec<_>>(),
            )
            .field("tokens", &self.tokens.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl Store {
    /// Creates and persists this installation's reconciliation id once.
    pub fn ensure_desktop_sync_source_id(&mut self) {
        if !self.desktop_sync_source_id.as_deref().is_some_and(is_uuid) {
            self.desktop_sync_source_id = Some(random_uuid());
        }
    }

    /// Queues an empty reconciliation for the currently stored account.
    /// Each account transition gets its own generation so a later sign-in
    /// cannot replace the credential that must clear (and perhaps revoke)
    /// an earlier session.
    pub fn queue_desktop_identity_clear(&mut self, revoke_after: bool) -> bool {
        let (Some(workspace_id), Some(source_id), Some(session)) = (
            self.cloud
                .as_ref()
                .and_then(|cloud| cloud.account_workspace_id.clone()),
            self.desktop_sync_source_id.clone(),
            self.cloud_session.clone(),
        ) else {
            return false;
        };
        let list = self
            .desktop_identity_clears_pending
            .get_or_insert_with(Vec::new);
        list.push(DesktopIdentityClear::new(
            workspace_id,
            source_id,
            session,
            revoke_after,
        ));
        true
    }

    /// Adds `registration`, replacing only the same session's earlier one.
    /// Refused (false) when another session holds the name.
    pub fn add(&mut self, registration: Registration, token: Secret) -> bool {
        if self
            .name_holder(&registration.name, &registration.target)
            .is_some()
        {
            return false;
        }
        let replaced: Vec<String> = self
            .registrations
            .iter()
            .filter(|r| r.target == registration.target)
            .map(|r| r.name.clone())
            .collect();
        let retired: Vec<String> = self
            .registrations
            .iter()
            .filter(|r| r.target == registration.target && r.agent_id != registration.agent_id)
            .map(|r| r.agent_id.clone())
            .collect();
        for id in retired {
            self.agent_owners.remove(&id);
            self.retire_refusals(&id);
        }
        for name in &replaced {
            self.tokens.remove(name);
        }
        self.queue_replaced_aliases(&registration);
        self.registrations
            .retain(|r| r.target != registration.target);
        self.forget_activation_blocker(&registration.target.key());
        self.tokens.insert(registration.name.clone(), token);
        self.registrations.push(registration);
        true
    }

    /// Replaces a registration in place, by name.
    pub fn update(&mut self, registration: Registration) {
        if let Some(existing) = self
            .registrations
            .iter_mut()
            .find(|r| r.name == registration.name)
        {
            *existing = registration;
        }
    }

    pub fn remove(&mut self, name: &str) {
        let retired: Vec<String> = self
            .registrations
            .iter()
            .filter(|r| r.name == name)
            .flat_map(Registration::agent_ids)
            .collect();
        for id in retired {
            self.agent_owners.remove(&id);
            self.retire_refusals(&id);
        }
        self.registrations.retain(|r| r.name != name);
        self.tokens.remove(name);
    }

    pub(crate) fn retire_refusals(&mut self, agent_id: &str) {
        if let Some(pending) = &mut self.pending_refusal_settlements {
            pending.retain(|p| p.agent_id != agent_id);
        }
        self.trim_injected_history();
    }

    /// A concurrent save cannot recreate settlements for a removed agent.
    /// Keep handled history, but retire work whose credentials were removed.
    fn retire_unregistered_refusals(&mut self, sources: &[&Store]) {
        let known: HashSet<String> = sources.iter().flat_map(|s| s.agent_ids()).collect();
        let kept: HashSet<String> = self.agent_ids().collect();
        if let Some(pending) = &mut self.pending_refusal_settlements {
            pending.retain(|p| !known.contains(&p.agent_id) || kept.contains(&p.agent_id));
        }
        // Every merge branch, including clone shortcuts, must remove
        // compatibility metadata for work whose credential was retired.
        self.trim_injected_history();
    }

    pub fn was_injected(&self, delivery_id: &str) -> bool {
        self.injected_delivery_ids
            .iter()
            .any(|id| id == delivery_id)
    }

    pub fn was_in_doubt(&self, delivery_id: &str) -> bool {
        self.in_doubt_delivery_ids
            .iter()
            .any(|id| id == delivery_id)
    }

    pub fn was_refused(&self, delivery_id: &str) -> bool {
        self.refused_delivery_ids.iter().any(|id| id == delivery_id)
            || self
                .injected_delivery_ids
                .iter()
                .any(|id| id.strip_prefix(REFUSED_DELIVERY_MARKER) == Some(delivery_id))
            || self
                .pending_refusal_settlements
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|pending| pending.delivery_id == delivery_id)
    }

    /// A terminal local outcome: never offer it to the session again.
    pub fn was_handled(&self, delivery_id: &str) -> bool {
        self.was_injected(delivery_id)
            || self.was_in_doubt(delivery_id)
            || self.was_refused(delivery_id)
    }

    pub fn record_injected(&mut self, delivery_id: &str) {
        if !self
            .injected_delivery_ids
            .iter()
            .any(|id| id == delivery_id)
        {
            self.injected_delivery_ids.push(delivery_id.into());
        }
        self.trim_injected_history();
    }

    pub fn record_in_doubt(&mut self, delivery_id: &str) {
        self.record_injected(delivery_id);
        remember(&mut self.in_doubt_delivery_ids, delivery_id);
    }

    pub fn record_refused(&mut self, delivery_id: &str) {
        remember(&mut self.refused_delivery_ids, delivery_id);
        // A plain ID protects older injectors; a versioned local marker in
        // the same established field keeps restart settlement fail-only.
        self.record_in_doubt(delivery_id);
    }

    /// Independent windows: 1,000 ordinary injections and 1,000 refusals
    /// (two compatibility entries each), plus every unsettled refusal.
    fn trim_injected_history(&mut self) {
        if self.refused_delivery_ids.is_empty()
            && self
                .pending_refusal_settlements
                .as_deref()
                .unwrap_or_default()
                .is_empty()
            && !self.injected_delivery_ids.iter().any(|id| {
                id.starts_with(REFUSED_DELIVERY_MARKER) || id.starts_with(PENDING_REFUSAL_MARKER)
            })
        {
            if self.injected_delivery_ids.len() > REMEMBERED_DELIVERIES {
                self.injected_delivery_ids
                    .drain(..self.injected_delivery_ids.len() - REMEMBERED_DELIVERIES);
            }
            return;
        }
        let own: HashSet<&str> = self
            .refused_delivery_ids
            .iter()
            .map(String::as_str)
            .collect();
        let pending: HashSet<&str> = self
            .pending_refusal_settlements
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|p| p.delivery_id.as_str())
            .collect();
        let mut seen = HashSet::new();
        let mut legacy: Vec<String> = self
            .injected_delivery_ids
            .iter()
            .filter_map(|id| id.strip_prefix(REFUSED_DELIVERY_MARKER))
            .filter(|id| {
                !own.contains(id) && !pending.contains(id) && seen.insert((*id).to_owned())
            })
            .map(str::to_owned)
            .collect();
        let legacy_capacity = REMEMBERED_DELIVERIES.saturating_sub(self.refused_delivery_ids.len());
        if legacy.len() > legacy_capacity {
            legacy.drain(..legacy.len() - legacy_capacity);
        }
        let mut refusals = legacy;
        refusals.extend(self.refused_delivery_ids.iter().cloned());
        let mut seen: HashSet<String> = refusals.iter().cloned().collect();
        for pending in self
            .pending_refusal_settlements
            .as_deref()
            .unwrap_or_default()
        {
            if seen.insert(pending.delivery_id.clone()) {
                refusals.push(pending.delivery_id.clone());
            }
        }
        let mut ordinary: Vec<String> = self
            .injected_delivery_ids
            .iter()
            .filter(|id| {
                !id.starts_with(REFUSED_DELIVERY_MARKER)
                    && !id.starts_with(PENDING_REFUSAL_MARKER)
                    && !seen.contains(*id)
            })
            .cloned()
            .collect();
        if ordinary.len() > REMEMBERED_DELIVERIES {
            ordinary.drain(..ordinary.len() - REMEMBERED_DELIVERIES);
        }
        for id in refusals {
            ordinary.push(id.clone());
            ordinary.push(format!("{REFUSED_DELIVERY_MARKER}{id}"));
        }
        for pending in self
            .pending_refusal_settlements
            .as_deref()
            .unwrap_or_default()
        {
            ordinary.push(format!(
                "{PENDING_REFUSAL_MARKER}{}",
                serde_json::to_string(pending).expect("refusal IDs serialize")
            ));
        }
        self.injected_delivery_ids = ordinary;
    }

    /// Rehydrate only when an older writer omitted the new journal.
    /// Explicit Some(empty) remains authoritative after confirmed settlement.
    fn restore_pending_refusals(&mut self) {
        if self.pending_refusal_settlements.is_some() {
            return;
        }
        let mut seen = HashSet::new();
        let pending: Vec<PendingRefusal> = self
            .injected_delivery_ids
            .iter()
            .filter_map(|id| id.strip_prefix(PENDING_REFUSAL_MARKER))
            .filter_map(|id| serde_json::from_str::<PendingRefusal>(id).ok())
            .filter(|p| seen.insert(p.delivery_id.clone()))
            .collect();
        if !pending.is_empty() {
            self.pending_refusal_settlements = Some(pending);
        }
    }

    pub fn has_pending_refusal(&self, agent_id: &str) -> bool {
        self.pending_refusal_settlements
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|pending| pending.agent_id == agent_id)
    }

    pub fn queue_refusal(&mut self, delivery_id: &str, agent_id: &str) {
        self.queue_refusal_with_reason(delivery_id, agent_id, None);
    }

    pub fn queue_refusal_with_reason(
        &mut self,
        delivery_id: &str,
        agent_id: &str,
        reason: Option<&str>,
    ) {
        self.record_refused(delivery_id);
        let list = self
            .pending_refusal_settlements
            .get_or_insert_with(Vec::new);
        if !list
            .iter()
            .any(|pending| pending.delivery_id == delivery_id)
        {
            list.push(PendingRefusal {
                delivery_id: delivery_id.into(),
                agent_id: agent_id.into(),
                reason: reason.map(str::to_owned),
            });
        }
        self.trim_injected_history();
    }

    pub fn settle_refusal(&mut self, delivery_id: &str) {
        self.pending_refusal_settlements
            .get_or_insert_with(Vec::new)
            .retain(|pending| pending.delivery_id != delivery_id);
        self.trim_injected_history();
    }

    /// Records a cleanup to retry, once.
    pub fn add_pending_cleanup(&mut self, cleanup: PendingCleanup) {
        let list = self.pending_cleanups.get_or_insert_with(Vec::new);
        if !list.contains(&cleanup) {
            list.push(cleanup);
        }
    }

    /// Remembers a displaced workspace key until a verified replacement's
    /// saved copies are rewritten. Records accumulate: A→B followed by B→C
    /// owes A's saved copies the rewrite as well as B's, so a record upserts
    /// into the list by its (origin, displaced key) identity rather than
    /// replacing it.
    pub fn record_pending_key_migration(&mut self, migration: PendingKeyMigration) {
        let list = self.pending_key_migrations.get_or_insert_with(Vec::new);
        if !list
            .iter()
            .any(|owed| owed.base_url == migration.base_url && owed.old_key == migration.old_key)
        {
            list.push(migration);
        }
    }

    /// The recorded rotations in `settled` are done — applied, or no longer
    /// owed — so their records drop. Anything not listed stays owed.
    pub fn clear_pending_key_migrations(&mut self, settled: &[PendingKeyMigration]) {
        let Some(list) = self.pending_key_migrations.as_mut() else {
            return;
        };
        list.retain(|owed| {
            !settled
                .iter()
                .any(|done| done.base_url == owed.base_url && done.old_key == owed.old_key)
        });
        if list.is_empty() {
            self.pending_key_migrations = None;
        }
    }

    /// Rewrites every saved copy of `old` at `base_url` to `new`: the keys
    /// registrations registered with, and the keys pending cleanups still
    /// owe Relaycast. Run when discovery produced a replacement key that
    /// verified to the SAME workspace — a rotation. The superseded key stops
    /// authenticating once its grace lapses, so copies left behind would
    /// strand the agents and the pending removals. Keys that differ from
    /// `old` belong to another workspace sharing the origin and are left
    /// alone.
    pub fn rotate_workspace_key(&mut self, base_url: &str, old: &Secret, new: &Secret) -> usize {
        let mut migrated = 0;
        for registration in self.registrations.iter_mut() {
            if registration.base_url == base_url && registration.workspace_key.as_ref() == Some(old)
            {
                registration.workspace_key = Some(new.clone());
                migrated += 1;
            }
        }
        if let Some(cleanups) = self.pending_cleanups.as_mut() {
            for cleanup in cleanups.iter_mut() {
                if cleanup.base_url == base_url && &cleanup.workspace_key == old {
                    cleanup.workspace_key = new.clone();
                    migrated += 1;
                }
            }
        }
        migrated
    }

    pub fn reply_routes_for(&self, agent_id: &str) -> HashSet<String> {
        self.reply_routes
            .iter()
            .flatten()
            .filter(|route| route.agent_id == agent_id)
            .map(|route| route.message_id.clone())
            .collect()
    }

    pub fn record_reply_route(&mut self, agent_id: &str, message_id: &str) {
        let routes = self.reply_routes.get_or_insert_with(Vec::new);
        if !routes
            .iter()
            .any(|route| route.agent_id == agent_id && route.message_id == message_id)
        {
            routes.push(ReplyRoute {
                agent_id: agent_id.into(),
                message_id: message_id.into(),
            });
        }
        self.prune_reply_routes();
    }

    /// Drops one parent authorized before a prompt that never arrived.
    pub fn forget_reply_route(&mut self, agent_id: &str, message_id: &str) {
        let Some(mut routes) = self.reply_routes.take() else {
            return;
        };
        routes.retain(|route| !(route.agent_id == agent_id && route.message_id == message_id));
        if !routes.is_empty() {
            self.reply_routes = Some(routes);
        }
    }

    /// Keeps every reply path that may have been shown to a session. An
    /// injection can become uncertain after the prompt was written, so this
    /// runs for confirmed and in-doubt outcomes alike.
    pub fn record_reply_opportunity(
        &mut self,
        delivery: &Delivery,
        registration: &Registration,
        manual_reply_allowed: bool,
        prefix: &str,
    ) {
        if manual_reply_allowed {
            self.record_reply_route(&registration.agent_id, &delivery.message_id);
        }
        // A session that can reply through the socket chooses its own
        // answer; the automatic one is a fallback unless explicitly enabled.
        if !manual_reply_allowed || registration.answers_finally_to(delivery) {
            if let Some(reply) = Reply::for_delivery(delivery, registration, prefix) {
                let replies = self.replies.get_or_insert_with(Vec::new);
                if !replies
                    .iter()
                    .any(|r| r.agent_id == reply.agent_id && r.message_id == reply.message_id)
                {
                    replies.push(reply);
                }
            }
        }
    }

    /// Claims the automatic answer a socket send replaces, before the send.
    /// `reply_to` names the exact turn; a plain DM answers the latest
    /// injection from that endpoint, so repeated sends never consume an
    /// older opportunity. True when something was claimed.
    ///
    /// A session can answer while injection is still running, before the
    /// automatic answer is written. When that answer will be written, the
    /// claim records it now, already claimed, so the later write does not
    /// queue a second one.
    pub fn claim_socket_reply(
        &mut self,
        agent_id: &str,
        endpoint: &Endpoint,
        reply_to: Option<&str>,
    ) -> bool {
        if self.claim_queued_socket_reply(agent_id, endpoint, reply_to) {
            return true;
        }
        let Some(parent) = reply_to else {
            return false;
        };
        if self
            .replies
            .iter()
            .flatten()
            .any(|reply| reply.agent_id == agent_id && reply.message_id == parent)
        {
            return false;
        }
        let automatic = self.registrations.iter().any(|registration| {
            registration.agent_id == agent_id && registration.answers_requester_finally()
        });
        if !automatic {
            return false;
        }
        let (sender_name, sender_address) = match endpoint {
            Endpoint::Name(name) => (Some(name.clone()), None),
            Endpoint::Address(address) => (None, Some(address.clone())),
        };
        self.replies.get_or_insert_with(Vec::new).push(Reply {
            agent_id: agent_id.into(),
            message_id: parent.into(),
            destination: Destination::thread(parent),
            claimed: Some(true),
            sender_name,
            sender_address,
            channel_id: None,
            routing_version: Some(1),
        });
        true
    }

    /// Marks an automatic answer that is already queued. False when there
    /// is nothing queued for this send.
    fn claim_queued_socket_reply(
        &mut self,
        agent_id: &str,
        endpoint: &Endpoint,
        reply_to: Option<&str>,
    ) -> bool {
        let Some(replies) = self.replies.as_mut() else {
            return false;
        };
        let index = match reply_to {
            Some(parent) => replies
                .iter()
                .rposition(|r| r.agent_id == agent_id && r.message_id == parent),
            None => replies.iter().rposition(|r| {
                r.agent_id == agent_id
                    && match endpoint {
                        Endpoint::Name(name) => r.sender_name.as_deref() == Some(name.as_str()),
                        Endpoint::Address(address) => {
                            r.sender_address.as_deref() == Some(address.as_str())
                        }
                    }
            }),
        };
        match index {
            Some(index) if replies[index].claimed != Some(true) => {
                replies[index].claimed = Some(true);
                true
            }
            _ => false,
        }
    }

    /// Moves answers owed and reply routes from one agent to another, as
    /// after a rename.
    pub fn rekey_replies(&mut self, from: &str, to: &str) {
        for reply in self.replies.iter_mut().flatten() {
            if reply.agent_id == from {
                reply.agent_id = to.into();
            }
        }
        for route in self.reply_routes.iter_mut().flatten() {
            if route.agent_id == from {
                route.agent_id = to.into();
            }
        }
    }

    /// Drops work that can no longer be sent (its agent is gone or has
    /// answers off) and all but the most recent sent records.
    pub fn prune_replies(&mut self) {
        if let Some(mut list) = self.replies.take() {
            let replying: HashSet<&str> = self
                .registrations
                .iter()
                .filter(|r| r.reply_with_final_answer != Some(false))
                .map(|r| r.agent_id.as_str())
                .collect();
            list.retain(|r| r.claimed == Some(true) || replying.contains(r.agent_id.as_str()));
            let sent: Vec<usize> = list
                .iter()
                .enumerate()
                .filter(|(_, r)| r.claimed == Some(true))
                .map(|(index, _)| index)
                .collect();
            if sent.len() > REMEMBERED_REPLIES {
                let drop: HashSet<usize> = sent[..sent.len() - REMEMBERED_REPLIES]
                    .iter()
                    .copied()
                    .collect();
                list = list
                    .into_iter()
                    .enumerate()
                    .filter(|(index, _)| !drop.contains(index))
                    .map(|(_, r)| r)
                    .collect();
            }
            self.replies = (!list.is_empty()).then_some(list);
        }
        self.prune_reply_routes();
    }

    fn prune_reply_routes(&mut self) {
        if let Some(mut routes) = self.reply_routes.take() {
            let current: HashSet<&str> = self
                .registrations
                .iter()
                .map(|r| r.agent_id.as_str())
                .collect();
            routes.retain(|route| current.contains(route.agent_id.as_str()));
            if routes.len() > REMEMBERED_REPLIES {
                routes.drain(..routes.len() - REMEMBERED_REPLIES);
            }
            self.reply_routes = (!routes.is_empty()).then_some(routes);
        }
    }

    /// Drops unsent thread replies queued by 2026.09.8 and earlier: they do
    /// not record their channel, so any could be an automatic answer to a
    /// provider event. Skipping a pending answer is the safe side.
    pub fn drop_legacy_thread_replies(&mut self) {
        if let Some(mut list) = self.replies.take() {
            list.retain(|r| !r.is_unattributed_legacy_thread_reply());
            self.replies = (!list.is_empty()).then_some(list);
        }
    }
}

fn remember(list: &mut Vec<String>, id: &str) {
    if !list.iter().any(|existing| existing == id) {
        list.push(id.into());
    }
    if list.len() > REMEMBERED_DELIVERIES {
        list.drain(..list.len() - REMEMBERED_DELIVERIES);
    }
}

// MARK: Decoding and migration

/// A decoded store, and whether migration changed it (so it is written back).
#[derive(Debug)]
pub struct Decoded {
    pub store: Store,
    pub migrated: bool,
}

/// The `workspaceKeySource` 2026.09.5 wrote for a key fetched with the
/// sign-in: the account's key, not one pasted into the app.
const SIGN_IN_SOURCE: &str = "your Agent Relay sign-in";

impl Store {
    /// Decodes either platform's store and migrates it to this format.
    /// `machine_prefix` is given to registrations saved before prefixes were
    /// recorded: the address they were reachable at until now.
    pub fn decode(bytes: &[u8], machine_prefix: &str) -> Result<Decoded, serde_json::Error> {
        let value: Value = serde_json::from_slice(bytes)?;
        let Value::Object(mut object) = value else {
            return Err(serde::de::Error::custom("the store is not a JSON object"));
        };
        let legacy = Legacy::take(&mut object);
        let numeric_dates = object
            .get("registrations")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|r| r["registeredAt"].is_number()));
        let mut store: Store = serde_json::from_value(Value::Object(object))?;
        let before = store.clone();
        store.restore_pending_refusals();
        // The single-slot encoding predates the list: fold it in so an
        // unfinished migration written by an older build still resolves.
        if let Some(legacy) = store.pending_key_migration_legacy.take() {
            store.record_pending_key_migration(legacy);
        }
        let mut migrated = legacy.apply(&mut store) || numeric_dates;
        for registration in &mut store.registrations {
            if registration.machine_prefix.is_none() {
                registration.machine_prefix = Some(machine_prefix.into());
            }
        }
        store.drop_legacy_thread_replies();
        store.ensure_desktop_sync_source_id();
        if let Some(clears) = store.desktop_identity_clears_pending.as_mut() {
            *clears = clears
                .iter()
                .map(DesktopIdentityClear::normalized)
                .collect();
        }
        migrated |= store != before;
        Ok(Decoded { store, migrated })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = serde_json::to_vec_pretty(self).expect("the store serializes");
        bytes.push(b'\n');
        bytes
    }
}

/// Fields only earlier stores have, removed from the object before decoding.
#[derive(Default)]
struct Legacy {
    // A top-level key: the sign-in's moves into `cloud`; a pasted one is dropped.
    workspace_key: Option<String>,
    workspace_key_source: Option<String>,
    workspace_base_url: Option<String>,
    // Linux: the signed-in account's Cloud workspace.
    account_workspace_id: Option<String>,
    account_workspace_name: Option<String>,
    relayfile_workspace_id: Option<String>,
    // Linux: per-session records.
    webhooks: Option<Map<String, Value>>,
    integrations: Option<Map<String, Value>>,
    reply_parents: Option<Map<String, Value>>,
    // Linux: the person identity and conversation hints, re-fetched on use.
    dropped_caches: bool,
}

impl Legacy {
    fn take(object: &mut Map<String, Value>) -> Legacy {
        let string = |object: &mut Map<String, Value>, key: &str| {
            object
                .remove(key)
                .and_then(|value| value.as_str().map(str::to_string))
        };
        let map = |object: &mut Map<String, Value>, key: &str| match object.remove(key) {
            Some(Value::Object(map)) => Some(map),
            _ => None,
        };
        let mut legacy = Legacy {
            workspace_key: string(object, "workspaceKey"),
            workspace_key_source: string(object, "workspaceKeySource"),
            workspace_base_url: string(object, "workspaceBaseURL"),
            account_workspace_id: string(object, "workspaceID"),
            account_workspace_name: string(object, "workspaceName"),
            relayfile_workspace_id: string(object, "relayfileWorkspaceID"),
            webhooks: None,
            integrations: None,
            reply_parents: None,
            dropped_caches: false,
        };
        // The Linux store keeps integrations by session at the top level;
        // this format keeps them on each registration.
        if object.get("integrations").is_some_and(Value::is_object) {
            legacy.integrations = map(object, "integrations");
        }
        legacy.webhooks = map(object, "webhooks");
        legacy.reply_parents = map(object, "replyParents");
        legacy.dropped_caches =
            object.remove("senders").is_some() | object.remove("conversations").is_some();
        legacy
    }

    /// Folds the legacy fields into `store`. True when anything was there.
    /// Moves a top-level key the sign-in fetched into `cloud`; a pasted one
    /// is dropped. True when a top-level key field was there. macOS
    /// 2026.09.5 marked a sign-in key with `workspaceKeySource`; the Linux
    /// app wrote it beside the account's workspace id.
    fn move_sign_in_key(&self, store: &mut Store) -> bool {
        let sign_in = self.workspace_key_source.as_deref() == Some(SIGN_IN_SOURCE)
            || self.account_workspace_id.is_some();
        if let (true, Some(key), None) = (sign_in, &self.workspace_key, &store.cloud) {
            store.cloud = Some(CloudWorkspace {
                key: Secret::new(key.clone()),
                base_url: self
                    .workspace_base_url
                    .clone()
                    .unwrap_or_else(|| DEFAULT_BASE_URL.into()),
                ..CloudWorkspace::default()
            });
        }
        self.workspace_key.is_some()
            || self.workspace_key_source.is_some()
            || self.workspace_base_url.is_some()
    }

    fn apply(self, store: &mut Store) -> bool {
        let mut changed = self.dropped_caches;
        changed |= self.move_sign_in_key(store);
        if self.account_workspace_id.is_some()
            || self.account_workspace_name.is_some()
            || self.relayfile_workspace_id.is_some()
        {
            changed = true;
            if let Some(cloud) = store.cloud.as_mut() {
                cloud.account_workspace_id = cloud
                    .account_workspace_id
                    .take()
                    .or(self.account_workspace_id.clone());
                cloud.name = cloud.name.take().or(self.account_workspace_name.clone());
                cloud.relayfile_workspace_id = cloud
                    .relayfile_workspace_id
                    .take()
                    .or(self.relayfile_workspace_id.clone());
            }
        }

        let registration_index = |store: &Store, session: &str| {
            store
                .registrations
                .iter()
                .position(|r| r.target.id == session)
        };
        if let Some(webhooks) = self.webhooks {
            changed = true;
            for (session, record) in webhooks {
                let Some(index) = registration_index(store, &session) else {
                    continue;
                };
                let field = |key: &str| record[key].as_str().map(str::to_string);
                // Kept from an agent this session had before: not this one's.
                if field("agent_id").is_some_and(|id| id != store.registrations[index].agent_id) {
                    continue;
                }
                let (Some(id), Some(url), Some(token), Some(channel), Some(channel_id)) = (
                    field("id"),
                    field("url"),
                    field("secret"),
                    field("channel"),
                    field("channel_id"),
                ) else {
                    continue;
                };
                let registration = &mut store.registrations[index];
                if registration.webhook.is_none() {
                    registration.webhook = Some(Webhook {
                        id,
                        url,
                        token: Secret::new(token),
                        channel_name: channel,
                        channel_id,
                    });
                }
            }
        }
        if let Some(integrations) = self.integrations {
            changed = true;
            for (session, records) in integrations {
                let Some(index) = registration_index(store, &session) else {
                    continue;
                };
                let workspace = self.relayfile_workspace_id.clone().unwrap_or_default();
                let registration = &mut store.registrations[index];
                let own_channel = format!("agent-events-{}", registration.agent_id);
                for record in records.as_array().into_iter().flatten() {
                    let (Some(provider), Some(resource)) =
                        (record["provider"].as_str(), record["resource"].as_str())
                    else {
                        continue;
                    };
                    if let (Some(id), Some(name)) = (
                        record["channel_id"].as_str(),
                        record["channel"]
                            .as_str()
                            .filter(|name| *name == own_channel),
                    ) {
                        registration.integration_channel_id = Some(id.into());
                        registration.integration_channel_name = Some(name.into());
                    }
                    let mut entry = Integration::new(provider, resource, &workspace);
                    entry.path_glob = Some(resource.into());
                    entry.ready = Some(true);
                    registration
                        .integrations
                        .get_or_insert_with(Vec::new)
                        .push(entry);
                }
            }
        }
        if let Some(parents) = self.reply_parents {
            changed = true;
            for (session, messages) in parents {
                let Some(index) = registration_index(store, &session) else {
                    continue;
                };
                let agent_id = store.registrations[index].agent_id.clone();
                for message in messages.as_array().into_iter().flatten() {
                    if let Some(message) = message.as_str() {
                        store.record_reply_route(&agent_id, message);
                    }
                }
            }
        }
        changed
    }
}

/// Seconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ`, the form Foundation's
/// default ISO-8601 decoder reads.
pub fn iso8601_from_seconds(seconds: f64) -> String {
    chrono::DateTime::from_timestamp(seconds.trunc() as i64, 0)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

pub fn iso8601_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// A random lowercase UUID (v4 layout).
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the OS random source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `count` random lowercase hex digits.
pub fn random_hex(count: usize) -> String {
    random_uuid()
        .replace('-', "")
        .chars()
        .chain(random_uuid().replace('-', "").chars())
        .take(count)
        .collect()
}

// MARK: Merge (`merge`)

mod merge;
mod session_kind;
mod settings_extras;
pub use settings_extras::SettingsExtras;
pub mod spawn;
pub use spawn::{SpawnOrigin, SpawnOwner, SpawnRequester};

// MARK: The file

/// Why the store could not be read or saved. Messages are safe to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The file did not decode; it was kept at `aside` and the core started
    /// without it.
    SetAside { aside: PathBuf },
    /// The file exists but cannot be read; nothing is saved until it can.
    Unreadable { path: PathBuf, reason: String },
    /// Another process wrote a form this version cannot read; this change
    /// was not saved.
    ChangedUnreadable { path: PathBuf },
    /// Writing failed.
    Write { path: PathBuf, reason: String },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::SetAside { aside } => write!(
                f,
                "Your saved agents could not be read. They were kept in {} and Agent Relay started without them.",
                aside.display()
            ),
            StoreError::Unreadable { path, reason } => write!(
                f,
                "Your saved agents at {} could not be read ({reason}), so changes are not being saved.",
                path.display()
            ),
            StoreError::ChangedUnreadable { path } => write!(
                f,
                "Another copy of Agent Relay wrote {} in a form this version cannot read, so this change was not saved.",
                path.display()
            ),
            StoreError::Write { path, reason } => {
                write!(f, "Could not save {} ({reason}).", path.display())
            }
        }
    }
}

impl std::error::Error for StoreError {}

enum Contents {
    Missing,
    Store(Box<Decoded>),
    Undecodable,
    Unreadable(String),
}

/// The store on disk, with this process's last view of it.
pub struct StoreFile {
    path: PathBuf,
    machine_prefix: String,
    /// The file as this process last read or wrote it: the common ancestor
    /// of this process's changes and anyone else's.
    baseline: Store,
    blocked: Option<StoreError>,
}

impl StoreFile {
    pub fn new(path: PathBuf, machine_prefix: &str) -> StoreFile {
        StoreFile {
            path,
            machine_prefix: machine_prefix.into(),
            baseline: Store::default(),
            blocked: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The stored agents, or an empty store and the reason there is none.
    /// A store in an earlier format is migrated and written back.
    pub fn load(&mut self) -> (Store, Option<StoreError>) {
        let result = self.with_lock(|file| match file.read() {
            Contents::Missing => {
                file.baseline = Store::default();
                Ok((Store::default(), None))
            }
            Contents::Store(decoded) => {
                // A migration that cannot be written back yet still loads:
                // the next save writes the migrated store.
                let error = match decoded.migrated {
                    true => file.write(&decoded.store).err(),
                    false => None,
                };
                file.baseline = decoded.store.clone();
                Ok((decoded.store, error))
            }
            Contents::Undecodable => {
                let aside = file.set_aside()?;
                file.baseline = Store::default();
                Ok((Store::default(), Some(StoreError::SetAside { aside })))
            }
            Contents::Unreadable(reason) => {
                let error = StoreError::Unreadable {
                    path: file.path.clone(),
                    reason,
                };
                file.blocked = Some(error.clone());
                Ok((Store::default(), Some(error)))
            }
        });
        match result {
            Ok(loaded) => loaded,
            Err(error) => {
                self.blocked = Some(error.clone());
                (Store::default(), Some(error))
            }
        }
    }

    /// Writes `store` merged with the file's current contents and returns
    /// what was written.
    pub fn save(&mut self, store: &Store) -> Result<Store, StoreError> {
        if let Some(blocked) = &self.blocked {
            return Err(blocked.clone());
        }
        self.with_lock(|file| {
            let merged = match file.read() {
                Contents::Missing => store.clone(),
                Contents::Store(theirs) => Store::merged(&file.baseline, store, &theirs.store),
                Contents::Undecodable => {
                    return Err(StoreError::ChangedUnreadable {
                        path: file.path.clone(),
                    })
                }
                Contents::Unreadable(reason) => {
                    return Err(StoreError::Unreadable {
                        path: file.path.clone(),
                        reason,
                    })
                }
            };
            file.write(&merged)?;
            file.baseline = merged.clone();
            Ok(merged)
        })
    }

    fn read(&self) -> Contents {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Contents::Missing,
            Err(error) => return Contents::Unreadable(error.kind().to_string()),
        };
        match Store::decode(&bytes, &self.machine_prefix) {
            Ok(decoded) => Contents::Store(Box::new(decoded)),
            Err(_) => Contents::Undecodable,
        }
    }

    fn set_aside(&self) -> Result<PathBuf, StoreError> {
        let stamp = chrono::Utc::now().format("%Y-%m-%dT%H%M%SZ");
        let name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut aside = self
            .path
            .with_file_name(format!("{name}.unreadable-{stamp}"));
        if aside.exists() {
            aside = self
                .path
                .with_file_name(format!("{name}.unreadable-{stamp}-{}", random_hex(8)));
        }
        fs::rename(&self.path, &aside).map_err(|error| StoreError::Unreadable {
            path: self.path.clone(),
            reason: error.kind().to_string(),
        })?;
        Ok(aside)
    }

    /// Agent tokens are in here: the file is created readable by this user
    /// only, then swapped into place.
    fn write(&self, store: &Store) -> Result<(), StoreError> {
        let failed = |error: std::io::Error| StoreError::Write {
            path: self.path.clone(),
            reason: error.kind().to_string(),
        };
        let directory = self.path.parent().unwrap_or(Path::new("."));
        let temporary = directory.join(format!(".injectable-agents-{}.json", random_uuid()));
        let result = (|| {
            let mut file =
                crate::platform::fs::private(fs::OpenOptions::new().write(true).create_new(true))
                    .open(&temporary)?;
            file.write_all(&store.encode())?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)?;
            // The rename is durable once the directory is. The new file is
            // already in place, so a failure here does not undo the save.
            let _ = crate::platform::fs::sync_dir(directory);
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(failed)
    }

    /// Runs `body` holding an exclusive `flock` on the sibling lock file, so
    /// another process's read-merge-write never interleaves with this one's.
    fn with_lock<T>(
        &mut self,
        body: impl FnOnce(&mut StoreFile) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let unreadable = |path: &Path, error: std::io::Error| StoreError::Unreadable {
            path: path.to_path_buf(),
            reason: error.kind().to_string(),
        };
        let directory = self.path.parent().unwrap_or(Path::new(".")).to_path_buf();
        if !directory.exists() {
            fs::create_dir_all(&directory).map_err(|e| unreadable(&directory, e))?;
            let _ = crate::platform::fs::set_mode(&directory, 0o700);
        }
        let mut lock_path = self.path.clone().into_os_string();
        lock_path.push(".lock");
        let lock_path = PathBuf::from(lock_path);
        let lock = crate::platform::fs::private(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false),
        )
        .open(&lock_path)
        .map_err(|e| unreadable(&lock_path, e))?;
        loop {
            match lock.lock_exclusive() {
                Ok(()) => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(unreadable(&lock_path, error)),
            }
        }
        let result = body(self);
        let _ = FileExt::unlock(&lock);
        result
    }
}

/// The store as the daemon holds it: the in-memory copy every change goes
/// through, and the file it is saved to.
pub struct StoreHandle {
    inner: std::sync::Mutex<HandleState>,
    /// Told whenever the store's error changes, for the status snapshot.
    on_error: std::sync::OnceLock<Box<dyn Fn(Option<String>) + Send + Sync>>,
}

struct HandleState {
    store: Store,
    file: StoreFile,
    load_error: Option<StoreError>,
    save_error: Option<StoreError>,
}

impl HandleState {
    fn error(&self) -> Option<String> {
        self.save_error
            .as_ref()
            .or(self.load_error.as_ref())
            .map(ToString::to_string)
    }

    fn saved(&mut self, saved: Store) {
        // A save adopts what other processes wrote, this setting included.
        crate::relay::codex::compact::set_enabled(saved.hides_relay_messages());
        self.store = saved;
        self.save_error = None;
        // A migration that could not be written back is written now.
        if matches!(self.load_error, Some(StoreError::Write { .. })) {
            self.load_error = None;
        }
    }
}

impl StoreHandle {
    /// Loads (and if need be migrates) the store at `path`.
    pub fn open(path: PathBuf, machine_prefix: &str) -> StoreHandle {
        let mut file = StoreFile::new(path, machine_prefix);
        let (store, load_error) = file.load();
        StoreHandle {
            inner: std::sync::Mutex::new(HandleState {
                store,
                file,
                load_error,
                save_error: None,
            }),
            on_error: std::sync::OnceLock::new(),
        }
    }

    /// Calls `report` with the store's error each time it changes.
    pub fn watch_errors(&self, report: impl Fn(Option<String>) + Send + Sync + 'static) {
        let _ = self.on_error.set(Box::new(report));
    }

    fn report(&self, before: Option<String>, after: Option<String>) {
        if before != after {
            if let Some(report) = self.on_error.get() {
                report(after);
            }
        }
    }

    pub fn read<T>(&self, read: impl FnOnce(&Store) -> T) -> T {
        read(&self.inner.lock().unwrap().store)
    }

    pub fn snapshot(&self) -> Store {
        self.read(Store::clone)
    }

    /// Applies `change` and saves, adopting what another process wrote
    /// since. When the save fails the change is undone, so memory never
    /// claims what disk does not hold.
    pub fn update<T>(&self, change: impl FnOnce(&mut Store) -> T) -> Result<T, StoreError> {
        blocking(|| self.update_now(change))
    }

    fn update_now<T>(&self, change: impl FnOnce(&mut Store) -> T) -> Result<T, StoreError> {
        let mut state = self.inner.lock().unwrap();
        let before = state.store.clone();
        let result = change(&mut state.store);
        if state.store == before {
            return Ok(result);
        }
        let error_before = state.error();
        let changed = state.store.clone();
        let outcome = match state.file.save(&changed) {
            Ok(saved) => {
                state.saved(saved);
                Ok(result)
            }
            Err(error) => {
                state.store = before;
                state.save_error = Some(error.clone());
                Err(error)
            }
        };
        let error_after = state.error();
        drop(state);
        self.report(error_before, error_after);
        outcome
    }

    /// Applies `change` and saves, keeping the change in memory even when
    /// the save fails: for delivery records, where forgetting that a message
    /// was injected would inject it again. A later `flush` makes it durable.
    pub fn remember<T>(&self, change: impl FnOnce(&mut Store) -> T) -> Result<T, StoreError> {
        let mut state = self.inner.lock().unwrap();
        let result = change(&mut state.store);
        drop(state);
        self.flush().map(|_| result)
    }

    /// Saves the current store again, to make in-memory records durable.
    pub fn flush(&self) -> Result<(), StoreError> {
        blocking(|| self.flush_now())
    }

    fn flush_now(&self) -> Result<(), StoreError> {
        let mut state = self.inner.lock().unwrap();
        let error_before = state.error();
        let store = state.store.clone();
        let outcome = match state.file.save(&store) {
            Ok(saved) => {
                state.saved(saved);
                Ok(())
            }
            Err(error) => {
                state.save_error = Some(error.clone());
                Err(error)
            }
        };
        let error_after = state.error();
        drop(state);
        self.report(error_before, error_after);
        outcome
    }

    /// Why the store could not be saved last time, or could not be read.
    pub fn error(&self) -> Option<String> {
        self.inner.lock().unwrap().error()
    }
}

/// Runs a save, which waits for the file lock and syncs to disk, telling a
/// multi-threaded runtime to move its other tasks off this worker first.
fn blocking<T>(save: impl FnOnce() -> T) -> T {
    use tokio::runtime::{Handle, RuntimeFlavor};
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(save)
        }
        _ => save(),
    }
}

mod aliases;
pub use aliases::{AgentAlias, RetiredAlias};

#[cfg(test)]
mod tests;
