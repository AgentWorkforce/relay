//! This computer's agents on the relay: putting a session on the relay
//! under a name, renaming it, taking it off, its inbound webhook, test
//! messages, the store-backed settings, and retrying removals that failed.
//!
//! Registering a session creates a Relaycast agent addressed
//! `name@<machine prefix>-<agent id>`; from then on anyone in the workspace
//! can DM or @mention it and `relay::delivery` puts each message into the
//! session. Removing it deletes the agent (freeing the name) with the
//! workspace key it was registered with, never whichever key is current.

use crate::relay::cloud_session::AgentOwner;
use crate::relay::contract::agents::{
    AgentIntegration, AgentWebhook, Agents, ArchivedAgent, LocalAgent,
};
use crate::relay::daemon::Core;
use crate::relay::links::Endpoint;
use crate::relay::managed_sessions::ManagedAuthority;
use crate::relay::people::identity_hash;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::push::{PushState, PushTarget};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::state::{Level, Listing};
use crate::relay::store::{
    iso8601_now, random_hex, AgentAlias, CleanupKind, PendingCleanup, Registration, SessionKind,
    Store, Target, TestSender, Webhook,
};
use crate::relay::workspace::{self, Secret};
use crate::relay::{claude_dirs, client, history_retention as retention, trusted};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

mod activation_journal;
mod naming;
mod registration_routes;
mod roster_publication;
use activation_journal::auto_activation_allowance;
pub use naming::suggested_name;
use naming::suggested_name_numbered;
pub(crate) use roster_publication::present_registration_names;

/// The longest agent name.
pub const NAME_MAX: usize = 48;
const AUTO_ACTIVATE_GRACE_SECONDS: i64 = 5 * 60;
const AUTO_ACTIVATE_WINDOW_SECONDS: i64 = 60;
const AUTO_ACTIVATE_MAX_PER_WINDOW: usize = 5;
/// Bound automatic name allocation even when many matching names are taken.
const NAME_ATTEMPTS: usize = 100;
/// Whether the store keeps the setting `key` (spawning's among them); the
/// rest belong to settings extensions.
fn store_setting(key: &str) -> bool {
    crate::relay::store_settings::STORE_SETTINGS.contains(&key)
        || crate::relay::spawn::settings::KEYS.contains(&key)
}

/// The settings that are lists or values, not true or false: their owners
/// check them.
fn checked_by_owner(key: &str) -> bool {
    is_list_setting(key) || crate::relay::spawn::CONFIGURED_KEYS.contains(&key)
}

/// Settings whose value is a list (or, for session history, a number of
/// days) its owner checks and saves as given, never an on/off choice a
/// default pass could reverse.
fn is_list_setting(key: &str) -> bool {
    claude_dirs::is_folder_setting(key) || trusted::is_list_key(key) || key == retention::SETTING
}

fn parse_time(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&chrono::Utc))
}

/// Marks each registration whose session is gone with when it went, and
/// names the automatically activated ones gone for the grace period, which
/// leave the relay. An automatic agent is present while its session is
/// still eligible for activation; a manually or self-added one while its
/// session is `live`. A marked registration is kept, with its name and its
/// queued messages, but is not heartbeated as present and is not listed:
/// a reopened Codex thread is back on the relay the moment it runs again.
/// An archived one is not coming back: it is named due at once.
fn reconcile_lifecycle(
    store: &mut Store,
    eligible: &HashSet<Target>,
    live: &HashSet<Target>,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<String> {
    let now_text = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut due = Vec::new();
    for registration in store.registrations.iter_mut() {
        // An archived session leaves at once, however it was added.
        if registration.archived_at.is_some() {
            due.push(registration.name.clone());
            continue;
        }
        let automatic = registration.auto_activated == Some(true);
        let present = if automatic {
            eligible.contains(&registration.target)
        } else {
            live.contains(&registration.target)
        };
        if present {
            registration.missing_since = None;
        } else if automatic
            && registration
                .missing_since
                .as_deref()
                .and_then(parse_time)
                .is_some_and(|missing| {
                    now.signed_duration_since(missing).num_seconds() >= AUTO_ACTIVATE_GRACE_SECONDS
                })
        {
            due.push(registration.name.clone());
        } else if registration
            .missing_since
            .as_deref()
            .and_then(parse_time)
            .is_none()
        {
            registration.missing_since = Some(now_text.clone());
        }
    }
    due
}

/// `raw` as a valid agent name, or `None`: 2–48 lowercase letters, digits
/// and single dashes, starting and ending with a letter or digit, so it
/// survives being typed after an `@` and placed in a URL path. Surrounding
/// whitespace and a leading `@` are forgiven.
pub fn normalize_name(raw: &str) -> Option<String> {
    let lowered = raw.trim().to_lowercase();
    let name = lowered.strip_prefix('@').unwrap_or(&lowered);
    let name_byte = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let bytes = name.as_bytes();
    let valid = (2..=NAME_MAX).contains(&bytes.len())
        && bytes.iter().all(|b| name_byte(*b) || *b == b'-')
        && name_byte(bytes[0])
        && name_byte(bytes[bytes.len() - 1])
        && !name.contains("--");
    valid.then(|| name.to_string())
}

/// Async locks by key, created on first use.
#[derive(Default)]
pub struct KeyedLocks(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

impl KeyedLocks {
    pub fn get(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.0
            .lock()
            .unwrap()
            .entry(key.into())
            .or_default()
            .clone()
    }
}

/// Serializes removal with both other target mutations and delivery. The
/// owned guards make it possible to acquire in the global target-then-agent
/// order before any remote identity or channel is deleted.
async fn removal_guards(
    target_locks: &KeyedLocks,
    agent_locks: &KeyedLocks,
    target_key: &str,
    name: &str,
) -> (
    tokio::sync::OwnedMutexGuard<()>,
    tokio::sync::OwnedMutexGuard<()>,
) {
    let changing = target_locks.get(target_key).lock_owned().await;
    let delivering = agent_locks.get(name).lock_owned().await;
    (changing, delivering)
}

pub use crate::relay::settings_watch::SettingsExtension;

/// An agent on the relay, as `agents.register` reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
pub struct Registered {
    pub name: String,
    pub address: String,
    /// The session was registered already; nothing changed.
    pub already_registered: bool,
}

/// A webhook as `agents.webhook.create` reports it. The secret is present
/// only to the call that created it.
#[derive(Clone, Debug)]
pub struct WebhookResult {
    pub id: String,
    pub url: String,
    pub secret: Option<Secret>,
    pub created: bool,
}

/// Sessions reached only through a probe-verified provider binding.
fn is_managed(kind: SessionKind) -> bool {
    matches!(
        kind,
        SessionKind::Grok | SessionKind::GrokOpen | SessionKind::OpenCode
    )
}

fn not_registered(name: &str) -> RpcError {
    RpcError::new(
        ErrorKind::NotFound,
        format!("No agent named @{name} is on the relay from this computer."),
    )
}

fn name_rules() -> RpcError {
    RpcError::invalid_params("Use 2–48 lowercase letters, digits and single dashes.")
}

fn key_gone(name: &str) -> RpcError {
    RpcError::new(
        ErrorKind::Refused,
        format!("The workspace key @{name} was registered with is gone. Restore that key first."),
    )
}

fn busy() -> RpcError {
    RpcError::new(
        ErrorKind::Busy,
        "Another change to this session is still running.",
    )
}

/// Add operation context without hiding the safe, actionable failure reason.
fn relaycast_error(error: &relaycast::RelayError, message: String) -> RpcError {
    let mut mapped = RpcError::from_relaycast(error);
    mapped.message = format!("{message} {}", mapped.message);
    mapped
}

fn is_name_taken(error: &relaycast::RelayError) -> bool {
    matches!(error, relaycast::RelayError::Api { code, status, .. }
        if code == "agent_already_exists" || *status == 409)
}

impl Core {
    /// This computer's name as agent metadata shows it.
    pub(crate) fn host_label(&self) -> String {
        let host = self.config.host_name.trim_end_matches('.');
        let host = if host.to_lowercase().ends_with(".local") {
            &host[..host.len() - ".local".len()]
        } else {
            host
        };
        if host.is_empty() {
            "computer".into()
        } else {
            host.into()
        }
    }

    /// The signed-in person's roster join key: which people and agents are
    /// their own.
    pub(crate) fn owner_hash(&self) -> Option<String> {
        self.plugins
            .cloud
            .account()
            .and_then(|account| account.user_id)
            .map(|id| identity_hash(&id))
    }

    /// The key a registration acts with in its own workspace: the one it
    /// was registered with, or (for stores from the first build) the
    /// current key when the origin matches.
    pub(crate) fn key_for(&self, registration: &Registration) -> Option<Secret> {
        registration.workspace_key.clone().or_else(|| {
            self.workspace()
                .filter(|w| w.base_url == registration.base_url)
                .map(|w| w.key)
        })
    }

    fn registration_named(&self, name: &str) -> Result<Registration, RpcError> {
        self.store
            .read(|store| store.registration_named(name).cloned())
            .ok_or_else(|| not_registered(name))
    }

    /// Whom new registrations name as their owner.
    pub(crate) fn agent_owner(&self) -> Option<AgentOwner> {
        self.plugins.cloud.agent_owner()
    }

    /// Account changes never transfer ownership of an existing agent. Older
    /// registrations with no binding remain unknown until re-registered.
    pub async fn credit_agents(&self) {
        self.request_desktop_identity_sync();
    }

    fn metadata(
        &self,
        target: &Target,
        title: &str,
        description: Option<&str>,
        owner: Option<&AgentOwner>,
    ) -> Map<String, Value> {
        let mut metadata = Map::new();
        metadata.insert("source".into(), json!("relay-desktop"));
        metadata.insert("injectable".into(), json!("true"));
        metadata.insert("session_kind".into(), json!(target.kind.as_str()));
        metadata.insert("session_id".into(), json!(target.id));
        metadata.insert("session_title".into(), json!(aliases::published_title(title)));
        if matches!(target.kind, SessionKind::OpenClaw | SessionKind::Hermes) {
            metadata.insert("session_scope".into(), json!("agent"));
        }
        metadata.insert("host".into(), json!(self.host_label()));
        if let Some(description) = description.map(str::trim).filter(|d| !d.is_empty()) {
            let one_line = description.split_whitespace().collect::<Vec<_>>().join(" ");
            metadata.insert("objective".into(), json!(one_line));
        }
        if let Some(owner) = owner {
            metadata.extend(owner.metadata());
        }
        metadata
    }

    pub(crate) fn claim_name(&self, name: &str) -> Result<(), RpcError> {
        if self.claiming.lock().unwrap().insert(name.into()) {
            Ok(())
        } else {
            Err(RpcError::new(
                ErrorKind::Conflict,
                format!("@{name} is already being registered for another session here. Choose another name."),
            ))
        }
    }

    pub(crate) fn release_name(&self, name: &str) {
        self.claiming.lock().unwrap().remove(name);
    }

    /// Puts the session `target` names on the relay, if discovery finds it.
    pub async fn register_target(
        &self,
        target: &Target,
        name: Option<&str>,
        description: Option<&str>,
    ) -> Result<Registered, RpcError> {
        if is_managed(target.kind) {
            // A managed registration is answered only after the same live
            // authority check a new one gets, under the target lock.
            let lock = self.target_locks.get(&target.key());
            let _changing = lock.lock().await;
            if self.store.read(|s| s.registration_for(target).is_some()) {
                self.verify_managed_registration_authority(target).await?;
            }
            if let Some(registration) = self.store.read(|s| s.registration_for(target).cloned()) {
                return Ok(already_registered(&registration, &self.machine_prefix));
            }
        } else if let Some(registration) = self.store.read(|s| s.registration_for(target).cloned())
        {
            return Ok(already_registered(&registration, &self.machine_prefix));
        }
        let sessions = self.plugins.sessions.clone();
        let wanted = target.clone();
        let session = tokio::task::spawn_blocking(move || {
            sessions.find_session(&wanted)
        })
        .await
        .ok()
        .flatten();
        let session = match session {
            Some(session) => session,
            None if is_managed(target.kind) => {
                return Err(RpcError::new(
                    ErrorKind::Refused,
                    "This managed session has no live probe-owned binding.",
                ))
            }
            None => {
                return Err(RpcError::new(
                    ErrorKind::Refused,
                    "This session is not running.",
                ))
            }
        };
        self.register_session(&session, name, description, false)
            .await
    }

    /// Registers `session` under `raw_name` (or its suggested name) and
    /// starts delivering to it. A session already on the relay is reported
    /// as it is.
    pub async fn register_session(
        &self,
        session: &DiscoveredSession,
        raw_name: Option<&str>,
        description: Option<&str>,
        added_by_session: bool,
    ) -> Result<Registered, RpcError> {
        self.register_session_with_origin(session, raw_name, description, added_by_session, false)
            .await
    }

    async fn register_session_with_origin(
        &self,
        session: &DiscoveredSession,
        raw_name: Option<&str>,
        description: Option<&str>,
        added_by_session: bool,
        auto_activated: bool,
    ) -> Result<Registered, RpcError> {
        let target = &session.target;
        let lock = self.target_locks.get(&target.key());
        let _changing = lock.lock().await;
        // An existing managed registration is answered only after the live
        // authority check; a new one is checked once its binding exists.
        if let Some(existing) = self.store.read(|s| s.registration_for(target).cloned()) {
            if is_managed(target.kind) {
                self.verify_managed_registration_authority(target).await?;
            }
            return self.answer_registered(existing, raw_name, _changing).await;
        }
        // An already-open Grok agent is pinned to the exact binding it is
        // registered against; delivery refuses any other. A Grok TUI session
        // listed from Grok's own registry has no binding yet: adding it binds
        // its leader first, so a Grok row is added like a Claude one. A row
        // that is not live has no leader to bind, so nothing is bound.
        if target.kind == SessionKind::GrokOpen && !session.live {
            return Err(RpcError::new(
                ErrorKind::Refused,
                "No Grok leader is running for this session. Turn on Grok leader mode in Settings, then restart Grok.",
            ));
        }
        if target.kind == SessionKind::OpenCodeOpen && !session.live {
            return Err(RpcError::new(
                ErrorKind::Refused,
                "This OpenCode window started before Agent Relay's OpenCode plugin was on. Restart OpenCode, then add the session.",
            ));
        }
        let route_binding = self.registration_route_binding(session).await?;
        if is_managed(target.kind) {
            self.verify_managed_registration_authority(target).await?;
        }
        if !session.live {
            return Err(RpcError::new(
                ErrorKind::Refused,
                "This session is not running.",
            ));
        }
        // A fleet worker answers to its fleet name; ownership is read fresh,
        // and unknown ownership gives no second identity.
        let directory = self.plugins.sessions.clone();
        let wanted = target.clone();
        match tokio::task::spawn_blocking(move || directory.fleet_owned(&wanted)).await {
            Ok(Ok(false)) => {}
            Ok(Ok(true)) => {
                return Err(RpcError::new(
                    ErrorKind::Refused,
                    "This session is already managed by this computer's relay.",
                ))
            }
            Ok(Err(message)) => return Err(RpcError::new(ErrorKind::FleetUnavailable, message)),
            Err(_) => {
                return Err(RpcError::new(
                    ErrorKind::FleetUnavailable,
                    "Could not verify whether this session is already managed by this computer's relay.",
                ))
            }
        }
        let name = match raw_name {
            Some(raw) => normalize_name(raw).ok_or_else(name_rules)?,
            None => suggested_name(session),
        };
        if !target.is_valid() {
            return Err(RpcError::invalid_params(
                "This session's id is not one Agent Relay can deliver to.",
            ));
        }
        self.refresh_workspace().await;
        let workspace = self.workspace().ok_or_else(|| {
            RpcError::new(
                ErrorKind::NotSignedIn,
                "No Agent Relay workspace key on this computer.",
            )
        })?;
        let mut candidate = name;
        let mut attempt = 1;
        let registration = loop {
            let result = if let Some(holder) = self
                .store
                .read(|s| s.name_holder(&candidate, target).cloned())
            {
                let location = if holder.base_url == workspace.base_url {
                    String::new()
                } else {
                    format!(" in {}", holder.base_url)
                };
                Err(RpcError::new(
                    ErrorKind::Conflict,
                    format!("@{candidate} is already used by another session here{location}. Turn that one off first, or choose another name."),
                ))
            } else if let Err(error) = self.claim_name(&candidate) {
                Err(error)
            } else {
                let result = self
                    .create_registration(
                        session,
                        &candidate,
                        description,
                        added_by_session,
                        auto_activated,
                        &workspace,
                        route_binding.clone(),
                    )
                    .await;
                self.release_name(&candidate);
                result
            };
            match result {
                Ok(registration) => break registration,
                Err(error)
                    if raw_name.is_none()
                        && error.data.kind == ErrorKind::Conflict
                        && attempt < NAME_ATTEMPTS =>
                {
                    attempt += 1;
                    candidate = suggested_name_numbered(session, attempt);
                }
                Err(error) => return Err(error),
            }
        };
        self.sync_agents().await;
        self.hub.invalidated(Listing::Agents);
        self.hub.activity(
            Level::Info,
            format!("@{} is on the relay.", registration.name),
        );
        Ok(Registered {
            address: registration.direct_address(&self.machine_prefix),
            name: registration.name,
            already_registered: false,
        })
    }

    /// The live immutable route reference of an existing provider session.
    async fn live_route_binding(&self, target: &Target) -> Option<String> {
        let directory = self.plugins.sessions.clone();
        let wanted = target.clone();
        tokio::task::spawn_blocking(move || directory.route_binding(&wanted))
            .await
            .ok()
            .flatten()
    }

    /// Binds an already-open Grok session to its leader for the signed-in
    /// workspace and owner, as `sessions.existing.register` does. The probe
    /// finds and proves the leader itself; the row supplies only the session
    /// id and the working directory Grok recorded for it.
    async fn bind_open_grok(&self, session: &DiscoveredSession) -> Result<(), RpcError> {
        let directory = session.directory.clone().ok_or_else(|| {
            RpcError::new(
                ErrorKind::Refused,
                "This Grok session's working directory is unknown, so it cannot be bound.",
            )
        })?;
        let authority = self.registration_authority().await?;
        let request = crate::relay::existing_session::enablement::OpenLeaderRequest {
            session_id: session.target.id.clone(),
            directory: std::path::PathBuf::from(directory),
            workspace_id: authority.workspace_id,
            owner_id: authority.owner_id,
            owner_uid: authority.owner_uid,
        };
        let sessions = self.plugins.sessions.clone();
        tokio::task::spawn_blocking(move || sessions.register_existing(request))
            .await
            .map_err(|_| {
                RpcError::new(
                    ErrorKind::Internal,
                    "Binding this Grok session did not complete.",
                )
            })?
            .map_err(|message| RpcError::new(ErrorKind::Refused, message))?;
        self.hub.invalidated(Listing::Sessions);
        Ok(())
    }

    /// The signed-in workspace and owner a probe-owned binding is minted for
    /// and checked against.
    async fn registration_authority(&self) -> Result<ManagedAuthority, RpcError> {
        self.refresh_workspace().await;
        let workspace_id = self.verified_workspace_id().ok_or_else(|| {
            RpcError::new(
                ErrorKind::NotSignedIn,
                "A verified Agent Relay workspace is required for managed sessions.",
            )
        })?;
        let owner_id = self
            .agent_owner()
            .map(|owner| owner.user_id)
            .ok_or_else(|| {
                RpcError::new(
                    ErrorKind::NotSignedIn,
                    "A signed-in owner is required for managed sessions.",
                )
            })?;
        Ok(ManagedAuthority {
            workspace_id,
            owner_id,
            owner_uid: crate::relay::peer::current_uid(),
        })
    }

    /// Managed providers can be registered only while the same live record
    /// proves the current Relaycast workspace, signed-in owner and OS uid.
    /// This is deliberately independent of a caller-provided session row.
    async fn verify_managed_registration_authority(&self, target: &Target) -> Result<(), RpcError> {
        let expected = self.registration_authority().await?;
        let directory = self.plugins.sessions.clone();
        let wanted = target.clone();
        let actual = tokio::task::spawn_blocking(move || directory.managed_authority(&wanted))
            .await
            .ok()
            .flatten();
        if actual.as_ref() != Some(&expected) {
            return Err(RpcError::new(
                ErrorKind::Refused,
                "This managed session is not bound to the current workspace and owner.",
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_registration(
        &self,
        session: &DiscoveredSession,
        name: &str,
        description: Option<&str>,
        added_by_session: bool,
        auto_activated: bool,
        workspace: &workspace::Workspace,
        route_binding: Option<String>,
    ) -> Result<Registration, RpcError> {
        let owner = self.agent_owner();
        let workspace_scope = self.relaycast_scope(&workspace.base_url, &workspace.key);
        let result = client::register_agent(
            &workspace.base_url,
            &workspace.key,
            name,
            self.joining(),
            self.metadata(&session.target, &session.title, description, owner.as_ref()),
        )
        .await;
        self.observe_relaycast_write_result(&workspace_scope, &result);
        let agent = result.map_err(|error| {
            if is_name_taken(&error) {
                RpcError::new(
                    ErrorKind::Conflict,
                    format!("@{name} is already taken in this workspace. Choose another name."),
                )
            } else {
                relaycast_error(
                    &error,
                    format!("Could not register @{name} on Agent Relay."),
                )
            }
        })?;
        let registration = Registration {
            name: agent.name.clone(),
            agent_id: agent.id.clone(),
            target: session.target.clone(),
            title: session.title.clone(),
            base_url: workspace.base_url.clone(),
            registered_at: iso8601_now(),
            workspace_key: Some(workspace.key.clone()),
            machine_prefix: Some(self.machine_prefix.clone()),
            added_by_session: Some(added_by_session),
            auto_activated: auto_activated.then_some(true),
            missing_since: None,
            archived_at: None,
            webhook: None,
            reply_with_final_answer: None,
            integration_channel_id: None,
            integration_channel_name: None,
            integrations: None,
            route_binding,
            spawn: None,
            mcp: None,
            alias: None,
            retired_aliases: None,
            cleared: None,
        };
        let saved = self.store.update(|store| {
            let added = store.add(registration.clone(), agent.token.clone());
            if added {
                if let Some(owner) = owner.as_ref().filter(|owner| owner.workspace_id.is_some()) {
                    store
                        .agent_owners
                        .insert(registration.agent_id.clone(), owner.clone());
                }
            }
            added
        });
        match saved {
            Ok(true) => Ok(registration),
            Ok(false) => {
                self.delete_or_retry(&workspace.base_url, &workspace.key, &agent.name)
                    .await;
                Err(RpcError::new(
                    ErrorKind::Conflict,
                    format!("@{} is already used by another session here. Turn that one off first, or choose another name.", agent.name),
                ))
            }
            Err(error) => {
                // Without its token on disk the agent would outlive this
                // computer unreachable: take it back down, or keep retrying.
                self.delete_or_retry(&workspace.base_url, &workspace.key, &agent.name)
                    .await;
                Err(RpcError::new(
                    ErrorKind::StoreFailed,
                    format!(
                        "Could not save the registration, so @{} was removed again. {error}",
                        agent.name
                    ),
                ))
            }
        }
    }

    /// Deletes an agent this computer no longer holds the token of; when
    /// Relaycast cannot be reached, records the deletion to retry (in memory
    /// at least, when the store cannot be saved either).
    async fn delete_or_retry(&self, base_url: &str, key: &Secret, name: &str) {
        let workspace = self.relaycast_scope(base_url, key);
        let result = client::delete_agent(base_url, key, name).await;
        self.observe_relaycast_write_result(&workspace, &result);
        if result.is_err() {
            let _ = self.store.remember(|store| {
                store.add_pending_cleanup(PendingCleanup {
                    kind: CleanupKind::Agent,
                    name: name.into(),
                    base_url: base_url.into(),
                    workspace_key: key.clone(),
                })
            });
        }
    }

    /// Deletes a channel this computer created but recorded nowhere, or
    /// records it to retry.
    async fn delete_channel_or_retry(&self, base_url: &str, key: &Secret, name: &str) {
        let workspace = self.relaycast_scope(base_url, key);
        let result = client::delete_channel(base_url, key, name).await;
        self.observe_relaycast_write_result(&workspace, &result);
        if result.is_err() {
            let _ = self.store.remember(|store| {
                store.add_pending_cleanup(PendingCleanup {
                    kind: CleanupKind::Channel,
                    name: name.into(),
                    base_url: base_url.into(),
                    workspace_key: key.clone(),
                })
            });
        }
    }

    /// Takes the agent off the relay: its webhook, its integration channel
    /// and the agent itself are removed from Relaycast first, then from the
    /// store, once any delivery in flight for it has finished.
    pub async fn unregister(&self, name: &str) -> Result<(), RpcError> {
        self.unregister_with_integrations(name, false).await
    }

    async fn unregister_with_integrations(
        &self,
        name: &str,
        allow_integrations: bool,
    ) -> Result<(), RpcError> {
        let registration = self.registration_named(name)?;
        let (_changing, _delivering) = removal_guards(
            &self.target_locks,
            &self.agent_locks,
            &registration.target.key(),
            name,
        )
        .await;
        let registration = self.registration_named(name)?;
        // A delivery in flight through any alias finishes first, too.
        let mut _delivering_aliases = Vec::new();
        for alias in registration.names().into_iter().skip(1) {
            _delivering_aliases.push(self.agent_locks.get(&alias).lock_owned().await);
        }
        // Recheck under the same delivery lock as injection. Discovery can
        // mark an archive while an in-flight refusal has not journaled yet.
        if allow_integrations
            && self
                .store
                .read(|s| s.has_pending_refusal_for(&registration))
        {
            return Ok(());
        }
        if registration.has_integrations() && !allow_integrations {
            return Err(RpcError::new(
                ErrorKind::Refused,
                "Unsubscribe or clean up integrations before removing this agent.",
            ));
        }
        self.keep_spawn_receipt(&registration)?;
        let key = self.key_for(&registration).ok_or_else(|| key_gone(name))?;
        let base = &registration.base_url;
        let workspace = self.relaycast_scope(base, &key);
        let removed = async {
            if let Some(webhook) = &registration.webhook {
                client::delete_webhook(base, &key, &webhook.id).await?;
                client::delete_channel(base, &key, &webhook.channel_name).await?;
            }
            if let Some(channel) = &registration.integration_channel_name {
                client::delete_channel(base, &key, channel).await?;
            }
            // Every name is released together. Aliases go first, each
            // forgotten as soon as it is gone, so a failure removing the
            // registered name never leaves a stale alias.
            for alias in registration.names().into_iter().skip(1) {
                client::delete_agent(base, &key, &alias).await?;
                self.forget_removed_alias(name, &alias);
            }
            client::delete_agent(base, &key, name).await
        }
        .await;
        self.observe_relaycast_write_result(&workspace, &removed);
        removed.map_err(|error| {
            let mut mapped = RpcError::from_relaycast(&error);
            let status = match &error {
                relaycast::RelayError::Api { status, .. } => format!(" (HTTP {status})"),
                _ => String::new(),
            };
            mapped.message = format!(
                "Could not remove @{name} from Agent Relay{status}. {} The registration was kept; retry when the connection is working.",
                mapped.message,
            );
            mapped
        })?;
        self.store
            .update(|store| store.remove(name))
            .map_err(|error| {
                RpcError::new(
                    ErrorKind::StoreFailed,
                    format!("@{name} was removed from Agent Relay, but this computer could not save that. {error}"),
                )
            })?;
        self.stop_spawned(&registration);
        self.forget_agent_and_alias(&registration);
        self.sync_agents().await;
        self.hub.invalidated(Listing::Agents);
        let left = match registration.alias_name() {
            Some(alias) => format!("@{alias} (@{name}) left the relay."),
            None => format!("@{name} left the relay."),
        };
        self.hub.activity(Level::Info, left);
        Ok(())
    }

    /// Retries Relaycast removals that failed earlier. Only what finished is
    /// dropped: a rename may record new ones meanwhile.
    pub(crate) async fn retry_pending_cleanups(&self) {
        self.retry_name_markers().await;
        let pending = self
            .store
            .read(|s| s.pending_cleanups.clone().unwrap_or_default());
        let mut done = Vec::new();
        for cleanup in pending {
            let workspace = self.relaycast_scope(&cleanup.base_url, &cleanup.workspace_key);
            if !self.relaycast_write_allowed(&workspace) {
                continue;
            }
            let result = match cleanup.kind {
                CleanupKind::Channel => {
                    client::delete_channel(&cleanup.base_url, &cleanup.workspace_key, &cleanup.name)
                        .await
                }
                CleanupKind::Agent => {
                    // The name is held for the removal, as a registration
                    // holds it until saved: one in flight is waited out (and
                    // tried next pass), and none starts meanwhile.
                    if !self.claim_cleanup_name(&cleanup.name) {
                        continue;
                    }
                    // Re-read before the removal: the name may have been
                    // taken again here (a rename back, a new registration)
                    // since the cleanup was recorded, and that agent is kept.
                    let kept = self.store.read(|s| {
                        s.registrations
                            .iter()
                            .any(|r| r.answers_to(&cleanup.name) && r.base_url == cleanup.base_url)
                    });
                    let result = if kept {
                        Ok(())
                    } else {
                        client::delete_agent(
                            &cleanup.base_url,
                            &cleanup.workspace_key,
                            &cleanup.name,
                        )
                        .await
                    };
                    self.release_name(&cleanup.name);
                    result
                }
            };
            self.observe_relaycast_write_result(&workspace, &result);
            if result.is_ok() {
                done.push(cleanup);
            }
        }
        if !done.is_empty() {
            let _ = self.store.update(|store| {
                if let Some(list) = store.pending_cleanups.as_mut() {
                    list.retain(|c| !done.contains(c));
                    if list.is_empty() {
                        store.pending_cleanups = None;
                    }
                }
            });
        }
    }

    /// Gives the agent an inbound webhook: a channel only it listens to and
    /// a webhook bound to that channel. Whatever is POSTed to the URL with
    /// the bearer becomes a message in the session. An agent that already
    /// has one gets it back without its secret.
    pub async fn create_webhook(&self, name: &str) -> Result<WebhookResult, RpcError> {
        let registration = self.registration_named(name)?;
        let lock = self.target_locks.get(&registration.target.key());
        let _changing = lock.lock().await;
        let registration = self.registration_named(name)?;
        if let Some(hook) = &registration.webhook {
            return Ok(WebhookResult {
                id: hook.id.clone(),
                url: hook.url.clone(),
                secret: None,
                created: false,
            });
        }
        let key = self.key_for(&registration).ok_or_else(|| key_gone(name))?;
        let token = self
            .store
            .read(|s| s.tokens.get(name).cloned())
            .ok_or_else(|| not_registered(name))?;
        let base = &registration.base_url;
        let channel = Webhook::channel_name(name, Some(&random_hex(16)));
        let failed = |error: &relaycast::RelayError| {
            relaycast_error(error, format!("Could not create a webhook for @{name}."))
        };
        let channel_id = match client::ensure_channel(
            base,
            &token,
            &channel,
            &format!("Inbound webhook for @{name}"),
        )
        .await
        {
            Ok(channel_id) => channel_id,
            // The channel may exist even though reading it back failed.
            Err(error) => {
                self.delete_channel_or_retry(base, &key, &channel).await;
                return Err(failed(&error));
            }
        };
        let hook =
            match client::create_webhook(base, &key, &format!("@{name} webhook"), &channel).await {
                Ok(hook) => hook,
                Err(error) => {
                    self.delete_channel_or_retry(base, &key, &channel).await;
                    return Err(failed(&error));
                }
            };
        let mut updated = registration.clone();
        updated.webhook = Some(Webhook {
            id: hook.id.clone(),
            url: hook.url.clone(),
            token: hook.token.clone(),
            channel_name: channel.clone(),
            channel_id,
        });
        // Saved means the merged store still holds it: another process may
        // have removed the agent meanwhile, and its removal wins.
        let saved = self
            .store
            .update(|store| store.update(updated))
            .map_err(|error| {
                RpcError::new(
                    ErrorKind::StoreFailed,
                    format!("Could not save the webhook, so it was removed again. {error}"),
                )
            })
            .and_then(|_| {
                let kept = self.store.read(|s| {
                    s.registration_named(name)
                        .and_then(|r| r.webhook.as_ref())
                        .is_some_and(|w| w.id == hook.id)
                });
                kept.then_some(()).ok_or_else(|| {
                    RpcError::new(
                        ErrorKind::NotFound,
                        format!("@{name} was removed meanwhile, so its webhook was removed too."),
                    )
                })
            });
        if let Err(error) = saved {
            let _ = client::delete_webhook(base, &key, &hook.id).await;
            self.delete_channel_or_retry(base, &key, &channel).await;
            return Err(error);
        }
        self.hub.invalidated(Listing::Agents);
        Ok(WebhookResult {
            id: hook.id,
            url: hook.url,
            secret: Some(hook.token),
            created: true,
        })
    }

    /// Stops the agent's webhook: its URL and bearer no longer work. True
    /// when there was none.
    pub async fn revoke_webhook(&self, name: &str) -> Result<bool, RpcError> {
        let registration = self.registration_named(name)?;
        let lock = self.target_locks.get(&registration.target.key());
        let Ok(_changing) = lock.try_lock() else {
            return Err(busy());
        };
        let registration = self.registration_named(name)?;
        let Some(webhook) = registration.webhook.clone() else {
            return Ok(true);
        };
        let key = self.key_for(&registration).ok_or_else(|| key_gone(name))?;
        let base = &registration.base_url;
        let removed = async {
            client::delete_webhook(base, &key, &webhook.id).await?;
            client::delete_channel(base, &key, &webhook.channel_name).await
        }
        .await;
        removed.map_err(|e| relaycast_error(&e, format!("Could not remove @{name}'s webhook.")))?;
        let mut updated = registration;
        updated.webhook = None;
        self.store
            .update(|store| store.update(updated))
            .map_err(|e| RpcError::store(&e))?;
        self.hub.invalidated(Listing::Agents);
        Ok(false)
    }

    /// Whether the agent answers automatically with the session's final
    /// answer: `Some(true)` always, `Some(false)` never, `None` only when
    /// the session cannot reply itself. Turning it off drops pending work.
    pub async fn set_reply_setting(
        &self,
        name: &str,
        enabled: Option<bool>,
    ) -> Result<(), RpcError> {
        let target = self.registration_named(name)?.target;
        let lock = self.target_locks.get(&target.key());
        let _changing = lock.lock().await;
        let mut registration = self.registration_named(name)?;
        registration.reply_with_final_answer = enabled;
        let agent_id = registration.agent_id.clone();
        self.store
            .update(|store| {
                if enabled == Some(false) {
                    for reply in store.replies.iter_mut().flatten() {
                        if reply.agent_id == agent_id {
                            reply.claimed = Some(true);
                        }
                    }
                }
                store.update(registration);
            })
            .map_err(|e| RpcError::store(&e))?;
        self.hub.invalidated(Listing::Agents);
        Ok(())
    }

    /// Sends `text` to the agent through Relaycast, so it takes exactly the
    /// path a teammate's message does: as you when signed in to Agent Relay
    /// (it lands in your one conversation history), otherwise as this
    /// computer's test sender. Returns the message id.
    pub async fn test_message(
        &self,
        name: &str,
        text: Option<&str>,
    ) -> Result<Option<String>, RpcError> {
        let registration = self.registration_named(name)?;
        let body = text
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or(
                "This is a test message from the Agent Relay desktop app. No reply is needed.",
            )
            .to_string();
        let endpoint = Endpoint::Address(registration.current_address(&self.machine_prefix));
        if self.plugins.cloud.account().is_some() {
            let sent = self.send_as_person(&endpoint, &body, None).await?;
            return Ok(sent.message_id);
        }
        let key = self.key_for(&registration).ok_or_else(|| key_gone(name))?;
        let base = &registration.base_url;
        let sender = self.test_sender(base, &key).await?;
        let sent = match client::send_dm(base, &sender.token, &endpoint, &body, None).await {
            Err(error) if error.is_auth_rejection() => {
                // The sender was removed elsewhere: make a new one, once.
                let id = crate::relay::delivery::policy::MessageRef::of(key.expose());
                let _ = self.store.update(|store| {
                    if let Some(senders) = store.test_senders.as_mut() {
                        senders.remove(&id);
                    }
                });
                let fresh = self.test_sender(base, &key).await?;
                client::send_dm(base, &fresh.token, &endpoint, &body, None).await
            }
            other => other,
        };
        let sent =
            sent.map_err(|e| relaycast_error(&e, "Could not send the test message.".into()))?;
        Ok(sent.message_id)
    }

    async fn test_sender(&self, base: &str, key: &Secret) -> Result<TestSender, RpcError> {
        let workspace = self.relaycast_scope(base, key);
        let id = crate::relay::delivery::policy::MessageRef::of(key.expose());
        if let Some(existing) = self
            .store
            .read(|s| s.test_senders.as_ref().and_then(|t| t.get(&id)).cloned())
        {
            return Ok(existing);
        }
        let mut metadata = Map::new();
        metadata.insert("source".into(), json!("relay-desktop"));
        metadata.insert("role".into(), json!("test-sender"));
        let mut last = None;
        for _ in 0..3 {
            let name = format!("desktop-tester-{}", random_hex(4));
            let result =
                client::register_agent(base, key, &name, &self.machine_prefix, metadata.clone())
                    .await;
            self.observe_relaycast_write_result(&workspace, &result);
            match result {
                Ok(agent) => {
                    let sender = TestSender {
                        name: agent.name,
                        token: agent.token,
                    };
                    let saved = self.store.update(|store| {
                        store
                            .test_senders
                            .get_or_insert_with(Default::default)
                            .insert(id.clone(), sender.clone());
                    });
                    if let Err(error) = saved {
                        self.delete_or_retry(base, key, &sender.name).await;
                        return Err(RpcError::store(&error));
                    }
                    return Ok(sender);
                }
                Err(error) if is_name_taken(&error) => last = Some(error),
                Err(error) => {
                    return Err(relaycast_error(
                        &error,
                        "Could not create a test sender.".into(),
                    ))
                }
            }
        }
        Err(last
            .map(|e| relaycast_error(&e, "Could not create a test sender.".into()))
            .unwrap_or_else(|| {
                RpcError::new(ErrorKind::Internal, "Could not create a test sender.")
            }))
    }

    /// Whether sessions may put themselves on the relay through the
    /// relay-send socket.
    pub fn allows_self_registration(&self) -> bool {
        self.store.read(Store::allows_self_registration)
    }

    /// Every setting: the store's and the extensions'.
    pub fn settings(&self) -> Map<String, Value> {
        let mut settings = self.store_settings();
        settings.extend(self.store.read(crate::relay::spawn::settings::values));
        for extension in &self.plugins.settings {
            settings.extend(extension.get());
        }
        settings
    }

    /// Turns on, once each, the integration settings whose tools are
    /// installed and that this computer has not turned on before or the
    /// person has not set: Claude Code direct delivery, Grok leader mode and
    /// the like. A key is remembered once it is on or set, so one the person
    /// turned off stays off, while a tool installed later gets its default
    /// on the next pass. One that cannot be changed now is tried again later.
    pub fn apply_integration_defaults(&self) {
        let _changing = self.integration_settings.lock().unwrap();
        let applied = self
            .store
            .read(|s| s.integration_defaults_applied.clone().unwrap_or_default());
        let mut newly = Vec::new();
        for extension in &self.plugins.settings {
            for key in extension.default_on() {
                if applied.iter().any(|done| done == key) || newly.contains(&key) {
                    continue;
                }
                if extension.get().get(key) == Some(&Value::Bool(true)) {
                    newly.push(key);
                    continue;
                }
                match extension.set(key, &Value::Bool(true)) {
                    Some(Ok(())) => {
                        self.hub.activity(
                            Level::Info,
                            format!("Turned on {key} by default; turn it off in Settings."),
                        );
                        newly.push(key);
                    }
                    Some(Err(message)) => self.hub.activity(
                        Level::Warning,
                        format!("Could not turn on {key} by default: {message}"),
                    ),
                    None => {}
                }
            }
        }
        if !newly.is_empty() {
            // A default left unrecorded is already on, so a later pass only
            // records it.
            let _ = self.remember_integration_choices(&newly);
        }
    }

    /// Runs `change` to the tool behind `key` and, once it succeeds, records
    /// `key` as the person's choice, so no default reverses it. Callers hold
    /// `integration_settings`, which also serializes the default pass, so
    /// recording after the change leaves no window for a default; nothing is
    /// recorded for a change that fails, so a later default still applies.
    /// A choice that cannot be recorded is reported as a failure.
    pub(crate) fn with_integration_choice<T, E>(
        &self,
        key: &str,
        change: impl FnOnce() -> Result<T, E>,
        stored: impl FnOnce(crate::relay::store::StoreError) -> E,
    ) -> Result<T, E> {
        let value = change()?;
        self.remember_integration_choices(&[key]).map_err(stored)?;
        Ok(value)
    }

    /// Records integration keys as applied or chosen, so no default changes
    /// them again.
    pub(crate) fn remember_integration_choices(
        &self,
        keys: &[&str],
    ) -> Result<(), crate::relay::store::StoreError> {
        self.store
            .update(|store| {
                let list = store
                    .integration_defaults_applied
                    .get_or_insert_with(Vec::new);
                for key in keys {
                    if !list.iter().any(|done| done == key) {
                        list.push((*key).to_string());
                    }
                }
            })
            .map(|_| ())
    }

    /// Applies each given setting; an unknown key or a wrong type changes
    /// nothing.
    pub fn set_settings(
        &self,
        changes: &Map<String, Value>,
    ) -> Result<Map<String, Value>, RpcError> {
        let known = self.settings();
        let write_only = |key: &str| {
            self.plugins
                .settings
                .iter()
                .any(|extension| extension.write_only().contains(&key))
        };
        for (key, value) in changes {
            if !known.contains_key(key) && !write_only(key) {
                return Err(RpcError::invalid_params(format!(
                    "There is no setting named {key}."
                )));
            }
            // The lists and values among the settings are checked by
            // their owners.
            if !value.is_boolean() && !checked_by_owner(key) {
                return Err(RpcError::invalid_params(format!(
                    "{key} must be true or false."
                )));
            }
        }
        self.set_store_settings(changes)?;
        let _changing = self.integration_settings.lock().unwrap();
        for (key, value) in changes {
            if store_setting(key) {
                continue;
            }
            if write_only(key) || is_list_setting(key) {
                // A one-time default, not a choice to record: once it has
                // written, the tool's own settings name the value, which the
                // default pass already leaves alone. The Claude folders are
                // a list no default pass touches.
                for extension in &self.plugins.settings {
                    if let Some(result) = extension.set(key, value) {
                        result.map_err(|message| RpcError::new(ErrorKind::Refused, message))?;
                    }
                }
                continue;
            }
            // The person's own choice, recorded once the tool has changed, so
            // no default reverses it and a failed change is never kept.
            self.with_integration_choice(
                key,
                || {
                    for extension in &self.plugins.settings {
                        if let Some(result) = extension.set(key, value) {
                            result.map_err(|message| RpcError::new(ErrorKind::Refused, message))?;
                        }
                    }
                    Ok(())
                },
                |e| RpcError::store(&e),
            )?;
        }
        Ok(self.settings())
    }

    /// This computer's agents on the relay.
    pub fn agents_list(&self) -> Agents {
        let store = self.store.snapshot();
        let status = self.status();
        let errors = self.delivery.lock().unwrap().queue_errors.clone();
        let stalls = self.inbox_stalls();
        // An archived agent is listed as archived while its removal is
        // pending, never as still on the relay.
        let agents = store
            .registrations
            .iter()
            .filter(|r| r.archived_at.is_none())
            .map(|r| LocalAgent {
                name: r.name.clone(),
                alias: r.alias_name().map(str::to_owned),
                address: r.current_address(&self.machine_prefix),
                target: r.target.clone(),
                title: r.title.clone(),
                registered_at: r.registered_at.clone(),
                added_by_session: r.added_by_session == Some(true),
                reply_with_final_answer: r.reply_with_final_answer,
                webhook: r.webhook.as_ref().map(AgentWebhook::from),
                integrations: r
                    .integrations
                    .iter()
                    .flatten()
                    .map(|i| AgentIntegration {
                        provider: i.provider.clone(),
                        resource: i.resource.clone(),
                        ready: i.ready == Some(true),
                    })
                    .collect(),
                push: agent_push(&status.push, r),
                // Under any name still delivering, retired ones included.
                delivery_error: r.names().iter().find_map(|n| errors.get(n)).cloned(),
                spawn: self.spawned_agent_state(r),
                inbox_stall: stalls.get(&r.name).cloned(),
            })
            .collect();
        let archived = store
            .archived_sessions
            .iter()
            .flatten()
            .map(|a| ArchivedAgent {
                name: a.name.clone(),
                address: a.address.clone(),
                target: a.target.clone(),
                title: a.title.clone(),
                archived_at: a.archived_at.clone(),
            })
            .collect();
        Agents { agents, archived }
    }

    /// Exactly one push channel per agent this computer delivers to (and
    /// one for the signed-in person while messaging is open).
    pub async fn sync_agents(&self) {
        let store = self.store.snapshot();
        // Only a registration whose session runs is present on the relay;
        // an ended session's keeps its name and queue but no channel.
        // An alias has a channel of its own into the same session.
        let mut targets: Vec<PushTarget> = store
            .credentials()
            .into_iter()
            .filter(|(r, _)| r.missing_since.is_none() && r.spawn.is_none())
            .map(|(r, token)| PushTarget {
                agent: r.name.clone(),
                base_url: r.base_url.clone(),
                workspace: self.relaycast_registration_scope(&r, &token),
                token,
                machine_address: Some(r.machine_address(&self.machine_prefix)),
            })
            .collect();
        for (name, (registration, token)) in self.retiring.lock().unwrap().iter() {
            if !targets.iter().any(|t| &t.agent == name) {
                targets.push(PushTarget {
                    agent: name.clone(),
                    base_url: registration.base_url.clone(),
                    token: token.clone(),
                    workspace: self.relaycast_registration_scope(registration, token),
                    machine_address: Some(registration.machine_address(&self.machine_prefix)),
                });
            }
        }
        targets.extend(self.person_push_target());
        self.sync_push(targets).await;
        let error = self.store.error();
        self.hub.update(|status| status.agents.store_error = error);
        self.request_desktop_identity_sync();
        self.sync_spawn_node().await;
    }

    /// Records that the sessions of the agents `names` were archived: each
    /// is listed in the store's archived sessions and leaves the relay on
    /// the next pass, releasing its name, however it was added.
    pub(crate) fn mark_sessions_archived(&self, names: &[String]) {
        if names.is_empty() {
            return;
        }
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let prefix = self.machine_prefix.clone();
        let marked = self.store.update(|store| {
            names
                .iter()
                .filter(|name| store.mark_archived(name, &prefix, &now))
                .cloned()
                .collect::<Vec<_>>()
        });
        match marked {
            Ok(marked) if !marked.is_empty() => {
                self.hub.activity(
                    Level::Info,
                    format!(
                        "Session archived: @{} is leaving the relay and its name is released.",
                        marked.join(", @")
                    ),
                );
                self.hub.invalidated(Listing::Agents);
            }
            Ok(_) => {}
            Err(error) => self.hub.activity(
                Level::Warning,
                format!("Could not record that a session was archived: {error}"),
            ),
        }
    }

    /// Reconciles registrations with the sessions on this computer. Ended
    /// or no longer eligible automatic identities leave after a grace period
    /// even when admission has since been turned off; a manual or self-added
    /// registration whose session ended is kept but marked, so it stops
    /// heartbeating as present until its session runs again. New admissions
    /// are capped and their attempts durably rate-limited.
    pub(crate) async fn activate_new_sessions(&self) -> Vec<String> {
        let mut reconciling = self.auto_activation.lock().await;
        let sessions = self.plugins.sessions.clone();
        let registered: Vec<(String, Target)> = self.store.read(|s| {
            s.registrations
                .iter()
                .filter(|r| r.archived_at.is_none())
                .map(|r| (r.name.clone(), r.target.clone()))
                .collect()
        });
        let title_revision = self.roster_revision.load(std::sync::atomic::Ordering::SeqCst);
        let discovered = tokio::task::spawn_blocking(move || {
            let all = sessions.sessions();
            let live: HashSet<Target> = all
                .iter()
                .filter(|session| session.live)
                .map(|session| session.target.clone())
                .collect();
            let targets: Vec<Target> = registered.iter().map(|(_, t)| t.clone()).collect();
            let archived = sessions.archived(&targets);
            let archived: Vec<String> = registered
                .into_iter()
                .filter(|(_, target)| archived.contains(target))
                .map(|(name, _)| name)
                .collect();
            let found = sessions.auto_activation_sessions();
            (found, all, live, archived, sessions.cleared(&targets))
        })
        .await;
        if let Ok((_, _, live, _, _)) = &discovered {
            // Relay Connect credentials follow the same running sessions.
            self.connect.lock().unwrap().observe_live_targets(live);
        }
        let (found, all, mut live, archived, cleared) = discovered.unwrap_or_default();
        self.mark_sessions_archived(&archived);
        // A spawned agent is present while its spawner says it runs, and
        // its session is never activated a second time.
        let spawned = self.spawned_targets();
        let spawned_live = self.spawned_live();
        live.retain(|target| !spawned.contains(target));
        live.extend(spawned_live);
        let mut found: HashMap<Target, DiscoveredSession> = found
            .into_iter()
            .filter(|session| !spawned.contains(&session.target))
            .map(|session| (session.target.clone(), session))
            .collect();
        let moved = self.follow_cleared(&cleared);
        let now = chrono::Utc::now();
        let now_text = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let mut failures = Vec::new();

        let eligible: HashSet<Target> = found.keys().cloned().collect();
        found.retain(|target, _| !moved.contains(target));
        let marked_before = self.store.read(present_registration_names);
        let due = match self.reconcile_discovered_registrations(
            &all, title_revision, &eligible, &live, now,
        ) {
            Ok(due) => due,
            Err(error) => {
                return vec![format!(
                    "Could not save auto-activation lifecycle state: {error}"
                )]
            }
        };
        let marked_after = self.store.read(present_registration_names);
        // On the first pass after start, agents marked absent by an earlier
        // run are announced too, so a restart never leaves one shown active.
        let first_pass = !self
            .presence_announced
            .swap(true, std::sync::atomic::Ordering::SeqCst);
        let marked_before = if first_pass {
            self.backfill_name_markers();
            // An archived one is announced as archived, not as ended.
            self.store.read(|s| {
                s.registrations
                    .iter()
                    .filter(|r| r.archived_at.is_none())
                    .map(|r| r.display_name().to_owned())
                    .collect()
            })
        } else {
            marked_before
        };
        if marked_after != marked_before {
            // Presence changed: the push channels follow the live sessions.
            let gone: Vec<&str> = marked_before
                .iter()
                .filter(|name| !marked_after.contains(name))
                .map(String::as_str)
                .collect();
            let back: Vec<&str> = marked_after
                .iter()
                .filter(|name| !marked_before.contains(name))
                .map(String::as_str)
                .collect();
            if !gone.is_empty() {
                self.hub.activity(
                    Level::Info,
                    format!(
                        "Session ended: @{} left the active relay; its name and queue are kept.",
                        gone.join(", @")
                    ),
                );
            }
            if !back.is_empty() {
                self.hub.activity(
                    Level::Info,
                    format!(
                        "Session running again: @{} is back on the relay.",
                        back.join(", @")
                    ),
                );
            }
            // Relaycast lists an agent as active until it is told otherwise,
            // so every device sees the change at once. Each change stays
            // pending until Relaycast confirms it, retried every pass.
            {
                let mut pending = self.presence_pending.lock().unwrap();
                for name in &gone {
                    pending.insert(name.to_string(), "idle");
                }
                for name in &back {
                    pending.insert(name.to_string(), "active");
                }
            }
            self.sync_agents().await;
        }
        self.refresh_activity(&all).await;
        self.announce_pending_presence().await;
        for name in due {
            // An archived refusal must reach its sender before removing the
            // registration/token that can settle it. No queue read or injection.
            if self.store.read(|s| {
                s.registration_named(&name)
                    .is_some_and(|r| s.has_pending_refusal_for(r))
            }) {
                continue;
            }
            if let Err(error) = self.unregister_with_integrations(&name, true).await {
                failures.push(format!("{name}: {}", error.message));
            }
        }

        if self.workspace().is_none() {
            return failures;
        }
        // Devin, open Muse, OpenClaw and Hermes sessions join by default:
        // a live lock-holding `devin` process (or this machine's sign-in,
        // for Devin Cloud), a live message-capable Muse registry record, an
        // OpenClaw Gateway that answers this user's loopback handshake, and
        // a Hermes API that answers its own key are already caller proof,
        // re-proved on every send — though an explicit Auto-activate off is
        // still honored. Every other provider needs the setting on.
        match self.store.read(|s| s.auto_activate) {
            Some(false) => return failures,
            Some(true) => {}
            None => {
                found.retain(|target, _| auto_activation::auto_activates_by_default(target.kind));
                if found.is_empty() {
                    return failures;
                }
            }
        }

        let (allowance, wait_reason) = match self
            .store
            .update(|store| auto_activation_allowance(store, now))
        {
            Ok(allowance) => allowance,
            Err(error) => {
                failures.push(format!(
                    "Could not save auto-activation rate state: {error}"
                ));
                return failures;
            }
        };

        let (cleared, blocked) = self
            .activate_sessions(
                found.into_values(),
                allowance,
                &wait_reason,
                &now_text,
                &mut failures,
            )
            .await;
        self.record_activation_outcomes(
            &cleared,
            &blocked,
            &now_text,
            &mut failures,
            &mut *reconciling,
        )
        .await;
        // `found` iterates a HashMap, so the caller's change detection sees
        // the same outcome set in the same order every pass.
        failures.sort_unstable();
        failures
    }

    /// Deliveries in an agent's queue not yet put into its session.
    pub(crate) async fn waiting_deliveries(
        &self,
        registration: &Registration,
    ) -> Result<usize, RpcError> {
        let Some((registration, token)) = self.agent_credential(&registration.name) else {
            return Ok(0);
        };
        let queue = client::deliveries(&registration.base_url, &token)
            .await
            .map_err(|e| {
                relaycast_error(
                    &e,
                    format!("Could not read @{}'s messages.", registration.name),
                )
            })?;
        Ok(self.store.read(|store| {
            queue
                .iter()
                .filter(|d| d.is_pending() && !store.was_handled(&d.id))
                .count()
        }))
    }
}

// `auto_activation` shares its line with `aliases` so this file stays under its line ratchet.
mod aliases;
mod auto_activation;
use aliases::already_registered;
pub(crate) use aliases::{agent_push, is_listed, update_registered_title};

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::Ordering;
    use std::sync::Mutex as StdMutex;
    use std::thread;
    use std::time::Duration;

    /// A `Core` in a tempdir, with the config every agent test repeats.
    fn test_core() -> (Arc<Core>, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                .unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let (core, _signals) = Core::new(config);
        (core, temp)
    }

    /// The smallest Relaycast that answers `serve` PATCHes: the first
    /// request is a 400 (an immediate, non-retryable failure), the rest
    /// are 200s, and every request body is recorded in `hits`.
    fn patch_stub(
        listener: TcpListener,
        serve: usize,
        hits: Arc<StdMutex<Vec<String>>>,
    ) -> thread::JoinHandle<()> {
        listener.set_nonblocking(true).unwrap();
        thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while hits.lock().unwrap().len() < serve && std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // macOS inherits the listener's nonblocking flag on accept.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut buffer = [0u8; 8192];
                        loop {
                            let Ok(count) = stream.read(&mut buffer) else {
                                break;
                            };
                            if count == 0 {
                                break;
                            }
                            request.extend_from_slice(&buffer[..count]);
                            let Some(headers_end) =
                                request.windows(4).position(|window| window == b"\r\n\r\n")
                            else {
                                continue;
                            };
                            let body = request.len() - headers_end - 4;
                            let wanted = String::from_utf8_lossy(&request[..headers_end])
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|value| value.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if body >= wanted {
                                break;
                            }
                        }
                        hits.lock()
                            .unwrap()
                            .push(String::from_utf8_lossy(&request).into_owned());
                        let (status, body) = if hits.lock().unwrap().len() == 1 {
                            (
                                "400 Bad Request",
                                r#"{"ok":false,"error":{"code":"boom","message":"rejected"}}"#,
                            )
                        } else {
                            (
                                "200 OK",
                                r#"{"ok":true,"data":{"id":"a1","name":"mirror","type":"agent","status":"active","persona":null}}"#,
                            )
                        };
                        write!(
                            stream,
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        })
    }

    #[tokio::test]
    async fn removal_waits_for_an_in_flight_delivery_before_cleanup_starts() {
        let target_locks = Arc::new(KeyedLocks::default());
        let agent_locks = Arc::new(KeyedLocks::default());
        let in_flight = agent_locks.get("open-code").lock_owned().await;
        let waiting_targets = target_locks.clone();
        let waiting_agents = agent_locks.clone();
        let removal = tokio::spawn(async move {
            removal_guards(
                &waiting_targets,
                &waiting_agents,
                "opencode:ses_exact",
                "open-code",
            )
            .await
        });

        tokio::task::yield_now().await;
        assert!(
            !removal.is_finished(),
            "cleanup must not delete the remote identity during delivery"
        );
        drop(in_flight);
        let guards = tokio::time::timeout(Duration::from_secs(1), removal)
            .await
            .expect("cleanup should continue after delivery")
            .unwrap();
        drop(guards);
    }

    fn session(id: &str, directory: &str, kind: SessionKind) -> DiscoveredSession {
        DiscoveredSession {
            target: Target::new(kind, id),
            title: "Fix tests".into(),
            directory: Some(directory.into()),
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        }
    }

    const THREAD: &str = "01a0c221-6806-7210-af25-97e104b15049";

    // InjectableAgentsTests.testNormalize… and test_normalizes_and_rejects.
    #[test]
    fn names_are_normalized_and_bad_ones_rejected() {
        assert_eq!(
            normalize_name("  @Codex-API-3f2a ").as_deref(),
            Some("codex-api-3f2a")
        );
        assert_eq!(normalize_name("ab").as_deref(), Some("ab"));
        for bad in [
            "",
            "a",
            "Bad Name!",
            "-lead",
            "trail-",
            "two--dashes",
            "under_score",
            "émile",
            "sp ace",
            &"a".repeat(49),
        ] {
            assert_eq!(normalize_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn suggested_names_use_at_most_two_task_words() {
        for (title, expected) in [
            ("Plan support", "claude-cloud-plan-support"),
            (
                "Can you please plan support for teams?",
                "claude-cloud-plan-support",
            ),
            ("Fix the login bug", "claude-cloud-fix-login"),
            ("Review", "claude-cloud-review"),
            ("Hermes", "claude-cloud-hermes"),
            ("Pi session", "claude-cloud-pi-session"),
            ("Claude Code session diagnostics", "claude-cloud-claude-code"),
            ("Plan plan support", "claude-cloud-plan-support"),
        ] {
            let mut task = session(THREAD, "/projects/cloud", SessionKind::ClaudeTerminal);
            task.title = title.into();
            assert_eq!(suggested_name(&task), expected);
            assert_eq!(normalize_name(expected).as_deref(), Some(expected));
        }
    }

    #[test]
    fn suggested_names_do_not_treat_placeholder_titles_as_tasks() {
        for title in ["cloud", THREAD, "Untitled thread", "New session", "!!!", ""] {
            let mut task = session(THREAD, "/projects/cloud", SessionKind::Codex);
            task.title = title.into();
            assert_eq!(suggested_name(&task), "codex-cloud-session");
        }
    }

    #[test]
    fn suggested_names_treat_discovery_fallback_titles_as_placeholders() {
        // LocalSessions::caller supplies these when the caller is known but
        // its provider has no discoverable session metadata yet.
        for (kind, title) in [
            (SessionKind::Codex, "Codex session"),
            (SessionKind::ClaudeTerminal, "Claude Code session"),
            (SessionKind::ClaudeCloud, "Claude Code session"),
            (SessionKind::Grok, "Grok session"),
            (SessionKind::GrokOpen, "Grok session"),
            (SessionKind::OpenCode, "OpenCode session"),
            (SessionKind::OpenCodeOpen, "OpenCode session"),
            (SessionKind::MuseOpen, "Muse session"),
            (SessionKind::Devin, "Devin session"),
            (SessionKind::CursorCli, "Cursor CLI session"),
            (SessionKind::OpenClaw, "OpenClaw agent"),
            (SessionKind::Hermes, "Hermes"),
            (SessionKind::Pi, "Pi session"),
        ] {
            for directory in [None, Some("/projects/cloud".to_string())] {
                let project = if directory.is_some() {
                    "cloud"
                } else {
                    "session"
                };
                let mut task = session(THREAD, "/projects/cloud", kind);
                task.directory = directory;
                // Exercise the same case/spacing normalization as task titles.
                task.title = format!("  {}  ", title.to_uppercase());
                let expected = format!("{}-{project}-session", kind.source());
                assert_eq!(suggested_name(&task), expected, "{title}");
                assert_eq!(
                    suggested_name_numbered(&task, 2),
                    format!("{expected}-2"),
                    "{title}"
                );
            }
        }
    }

    #[test]
    fn suggested_names_fit_the_length_limit() {
        let long = session(
            THREAD,
            &format!("/x/{}", "very-long-project-name-".repeat(6)),
            SessionKind::Codex,
        );
        let suggested = suggested_name(&long);
        assert!(suggested.len() <= NAME_MAX);
        assert_eq!(normalize_name(&suggested), Some(suggested));
        let mut long_task = long.clone();
        long_task.target.kind = SessionKind::OpenCode;
        long_task.title = "extraordinarilylong enormouslylongword".into();
        for number in [1, 2, 10, 100] {
            let name = suggested_name_numbered(&long_task, number);
            assert!(name.len() <= NAME_MAX, "{name}");
            assert_eq!(normalize_name(&name), Some(name.clone()));
            assert!(name.contains("extraordinar-enormouslylo"), "{name}");
        }
        let untitled = DiscoveredSession {
            directory: None,
            title: "!!!".into(),
            ..session(THREAD, "/", SessionKind::Codex)
        };
        assert!(suggested_name(&untitled).starts_with("codex-session-"));
    }

    #[test]
    fn suggested_names_cover_new_harnesses_and_ignore_scratch_directories() {
        for (kind, prefix) in [
            (SessionKind::OpenClaw, "openclaw"),
            (SessionKind::Hermes, "hermes"),
            (SessionKind::Pi, "pi"),
        ] {
            let task = session(THREAD, "/projects/cloud", kind);
            assert_eq!(suggested_name(&task), format!("{prefix}-cloud-fix-tests"));
        }
        let mut scratch = session(THREAD,
            "/Users/me/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-10-16-55cdc4",
            SessionKind::ClaudeTerminal);
        scratch.title = "Ping".into();
        assert_eq!(suggested_name(&scratch), "claude-session-ping");
    }

    fn automatic_registration(name: &str, id: &str, registered_at: &str) -> Registration {
        Registration {
            name: name.into(),
            agent_id: format!("agent-{name}"),
            target: Target::new(SessionKind::Codex, id),
            title: name.into(),
            base_url: "https://cast.agentrelay.com".into(),
            registered_at: registered_at.into(),
            workspace_key: None,
            machine_prefix: None,
            added_by_session: Some(false),
            auto_activated: Some(true),
            missing_since: None,
            archived_at: None,
            webhook: None,
            reply_with_final_answer: None,
            integration_channel_id: None,
            integration_channel_name: None,
            integrations: None,
            route_binding: None,
            spawn: None,
            mcp: None,
            alias: None,
            retired_aliases: None,
            cleared: None,
        }
    }

    #[tokio::test]
    async fn registered_managed_target_is_not_answered_without_a_verified_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                .unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let (core, _signals) = Core::new(config);
        let target = Target::new(SessionKind::OpenCode, "ses_exact");
        let mut registration =
            automatic_registration("managed-existing", "ses_exact", "2026-10-01T12:00:00Z");
        registration.target = target.clone();
        core.store
            .update(|store| store.registrations.push(registration))
            .unwrap();

        let error = core.register_target(&target, None, None).await.unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::NotSignedIn);
    }

    /// An integration setting kept in memory: `installed` decides whether it
    /// defaults on, `refuse` makes every change fail.
    struct FakeIntegration {
        key: &'static str,
        installed: std::sync::atomic::AtomicBool,
        on: std::sync::atomic::AtomicBool,
        refuse: std::sync::atomic::AtomicBool,
        sets: std::sync::atomic::AtomicUsize,
    }

    impl FakeIntegration {
        fn new(key: &'static str, installed: bool) -> Arc<FakeIntegration> {
            Arc::new(FakeIntegration {
                key,
                installed: installed.into(),
                on: false.into(),
                refuse: false.into(),
                sets: 0.into(),
            })
        }
    }

    impl SettingsExtension for FakeIntegration {
        fn get(&self) -> Map<String, Value> {
            let mut settings = Map::new();
            settings.insert(self.key.into(), json!(self.on.load(Ordering::SeqCst)));
            settings
        }
        fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
            if key != self.key {
                return None;
            }
            if self.refuse.load(Ordering::SeqCst) {
                return Some(Err("not now".into()));
            }
            self.sets.fetch_add(1, Ordering::SeqCst);
            self.on.store(value.as_bool().unwrap(), Ordering::SeqCst);
            Some(Ok(()))
        }
        fn default_on(&self) -> Vec<&'static str> {
            if self.installed.load(Ordering::SeqCst) {
                vec![self.key]
            } else {
                Vec::new()
            }
        }
    }

    #[tokio::test]
    async fn trusted_relay_senders_are_set_as_a_list() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join(".openclaw");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("openclaw.json"), "{}").unwrap();
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                .unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let openclaw = crate::relay::openclaw::OpenClawConfig::new(
            &std::collections::BTreeMap::new(),
            temp.path(),
            &temp.path().join("app-data"),
        );
        let plugins = crate::relay::daemon::Plugins {
            settings: vec![Arc::new(crate::relay::trusted::TrustedSettings::new(
                openclaw.trusted.clone(),
                || true,
            ))],
            ..crate::relay::daemon::Plugins::default()
        };
        let (core, _signals) = Core::with_plugins(config, plugins);
        let mut change = Map::new();
        change.insert("trusted_relay_senders".into(), json!(["ada-lovelace"]));
        let settings = core.set_settings(&change).unwrap();
        assert_eq!(settings["trusted_relay_senders"], json!(["ada-lovelace"]));
        assert_eq!(openclaw.trusted.list(), ["ada-lovelace"]);
        // A boolean is not a list.
        change.insert("trusted_relay_senders".into(), json!(true));
        assert!(core.set_settings(&change).is_err());
    }

    #[tokio::test]
    async fn integrations_default_on_once_and_an_opt_out_stays_off() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                .unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let grok = FakeIntegration::new("grok_leader", true);
        let later = FakeIntegration::new("opencode_plugin", false);
        let plugins = crate::relay::daemon::Plugins {
            settings: vec![grok.clone(), later.clone()],
            ..crate::relay::daemon::Plugins::default()
        };
        let (core, _signals) = Core::with_plugins(config, plugins);

        // An installed tool is turned on; one not installed is left alone.
        core.apply_integration_defaults();
        assert!(grok.on.load(Ordering::SeqCst));
        assert!(!later.on.load(Ordering::SeqCst));
        assert_eq!(
            core.store.read(|s| s.integration_defaults_applied.clone()),
            Some(vec!["grok_leader".to_string()])
        );

        // The person turns it off: no later pass turns it back on.
        let mut off = Map::new();
        off.insert("grok_leader".into(), json!(false));
        core.set_settings(&off).unwrap();
        core.apply_integration_defaults();
        assert!(!grok.on.load(Ordering::SeqCst));

        // A tool installed later gets its default on the next pass, but a
        // change that fails now is retried, not recorded as done.
        later.installed.store(true, Ordering::SeqCst);
        later.refuse.store(true, Ordering::SeqCst);
        core.apply_integration_defaults();
        assert!(!later.on.load(Ordering::SeqCst));
        later.refuse.store(false, Ordering::SeqCst);
        core.apply_integration_defaults();
        assert!(later.on.load(Ordering::SeqCst));
        assert_eq!(later.sets.load(Ordering::SeqCst), 1);

        // A change the person makes that fails is not kept as their choice,
        // so the default still applies once the tool can be written.
        let blocked = FakeIntegration::new("blocked_tool", true);
        let core_with_blocked = {
            let config = crate::relay::daemon::Config {
                paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core2.sock"))
                    .unwrap(),
                home: temp.path().into(),
                app_data_dir: temp.path().join("app-data-2"),
                env: std::collections::BTreeMap::new(),
                version: "0.0.0-test".into(),
                host_name: "Test Desk.local".into(),
                rediscover_every: Duration::from_secs(3600),
                push_timing: crate::relay::push::PushTiming::default(),
                delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
            };
            let plugins = crate::relay::daemon::Plugins {
                settings: vec![blocked.clone()],
                ..crate::relay::daemon::Plugins::default()
            };
            Core::with_plugins(config, plugins).0
        };
        blocked.refuse.store(true, Ordering::SeqCst);
        let mut off = Map::new();
        off.insert("blocked_tool".into(), json!(false));
        assert!(core_with_blocked.set_settings(&off).is_err());
        assert_eq!(
            core_with_blocked
                .store
                .read(|s| s.integration_defaults_applied.clone()),
            None
        );
        blocked.refuse.store(false, Ordering::SeqCst);
        core_with_blocked.apply_integration_defaults();
        assert!(blocked.on.load(Ordering::SeqCst));

        // A setting already on is recorded without being rewritten.
        let already = FakeIntegration::new("direct_delivery", true);
        already.on.store(true, Ordering::SeqCst);
        assert!(already.default_on().contains(&"direct_delivery"));
    }

    #[tokio::test]
    async fn title_refresh_fences_a_discovery_snapshot_before_native_publication() {
        use crate::relay::contract::agents::SessionTitleSetParams;
        use crate::relay::sessions::SessionDirectory;
        use std::sync::{mpsc, Mutex};

        struct PausedDirectory {
            title: Mutex<String>,
            ready: mpsc::SyncSender<()>,
            release: Mutex<mpsc::Receiver<()>>,
        }
        impl SessionDirectory for PausedDirectory {
            fn sessions(&self) -> Vec<DiscoveredSession> {
                vec![DiscoveredSession {
                    target: Target::new(SessionKind::Codex, THREAD),
                    title: self.title.lock().unwrap().clone(),
                    directory: None,
                    updated_at_ms: None,
                    live: true,
                    host: None,
                    holder: None,
                }]
            }
            fn auto_activation_sessions(&self) -> Vec<DiscoveredSession> {
                self.ready.send(()).unwrap();
                self.release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap();
                Vec::new()
            }
            fn set_title(&self, _: &str, _: &str, title: &str) -> Result<String, String> {
                *self.title.lock().unwrap() = title.to_owned();
                Ok(title.to_owned())
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        let directory = Arc::new(PausedDirectory {
            title: Mutex::new("Old title".into()),
            ready: ready_tx,
            release: Mutex::new(release_rx),
        });
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                .unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let plugins = crate::relay::daemon::Plugins {
            sessions: directory,
            ..Default::default()
        };
        let (core, _signals) = Core::with_plugins(config, plugins);
        let mut registration = automatic_registration("manual", THREAD, "2026-10-01T12:00:00Z");
        registration.auto_activated = None;
        registration.title = "Old title".into();
        core.store
            .update(|store| store.registrations.push(registration))
            .unwrap();
        let polling = core.clone();
        let poll = tokio::spawn(async move { polling.activate_new_sessions().await });
        tokio::task::spawn_blocking(move || {
            ready_rx.recv_timeout(Duration::from_secs(10)).unwrap()
        })
        .await
        .unwrap();
        crate::relay::session_titles::set_native_title(
            &core,
            SessionTitleSetParams {
                source: "codex".into(),
                session_id: THREAD.into(),
                title: "New title".into(),
            },
        )
        .await
        .unwrap();
        release_tx.send(()).unwrap();
        assert!(poll.await.unwrap().is_empty());
        // No second discovery or daemon loop can repair an incorrect overwrite.
        assert_eq!(
            core.store.read(|s| s.registrations[0].title.clone()),
            "New title"
        );
    }

    #[tokio::test]
    async fn the_poll_marks_a_manual_registration_whose_session_is_not_live() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                .unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let (core, _signals) = Core::new(config);
        let mut manual = automatic_registration("manual", THREAD, "2026-10-01T12:00:00Z");
        manual.auto_activated = None;
        core.store
            .update(|store| store.registrations.push(manual))
            .unwrap();
        // No session directory lists the thread: the registration is marked
        // absent, kept, and its mark is on disk.
        let failures = core.activate_new_sessions().await;
        assert!(failures.is_empty(), "{failures:?}");
        let marked = core
            .store
            .read(|s| s.registrations[0].missing_since.clone());
        assert!(marked.is_some());
        let on_disk =
            std::fs::read_to_string(temp.path().join("app-data/injectable-agents.json")).unwrap();
        assert!(on_disk.contains("missingSince"), "{on_disk}");
        assert_eq!(core.store.read(|s| s.registrations.len()), 1);
    }

    #[test]
    fn an_ended_session_is_marked_absent_and_only_an_automatic_one_leaves() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-01T12:10:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let mut automatic = automatic_registration("automatic", THREAD, "2026-10-01T12:00:00Z");
        let mut manual = automatic_registration(
            "manual",
            "01a0c221-6806-7210-af25-97e104b15050",
            "2026-10-01T12:00:00Z",
        );
        manual.auto_activated = None;
        let mut store = Store {
            registrations: vec![automatic.clone(), manual.clone()],
            ..Store::default()
        };
        let none = HashSet::new();
        // Both sessions are gone: both are marked, so neither is present;
        // neither leaves yet.
        assert!(reconcile_lifecycle(&mut store, &none, &none, now).is_empty());
        assert_eq!(
            store.registrations[0].missing_since.as_deref(),
            Some("2026-10-01T12:10:00Z")
        );
        assert_eq!(
            store.registrations[1].missing_since.as_deref(),
            Some("2026-10-01T12:10:00Z")
        );
        assert!(present_registration_names(&store).is_empty());

        // Gone for the grace period: the automatic one leaves; the manual
        // one keeps its name and queue, absent until its session runs.
        automatic.missing_since = Some("2026-10-01T12:04:59Z".into());
        manual.missing_since = Some("2026-10-01T12:04:59Z".into());
        store.registrations = vec![automatic.clone(), manual.clone()];
        assert_eq!(
            reconcile_lifecycle(&mut store, &none, &none, now),
            ["automatic"]
        );
        assert!(present_registration_names(&store).is_empty());

        // The manual session runs again: present at once. The automatic one
        // needs eligibility, not just liveness.
        let live = HashSet::from([automatic.target.clone(), manual.target.clone()]);
        assert_eq!(
            reconcile_lifecycle(&mut store, &none, &live, now),
            ["automatic"]
        );
        assert_eq!(present_registration_names(&store), ["manual"]);
        let eligible = HashSet::from([automatic.target.clone()]);
        store.registrations = vec![automatic.clone(), manual.clone()];
        assert!(reconcile_lifecycle(&mut store, &eligible, &live, now).is_empty());
        assert_eq!(present_registration_names(&store), ["automatic", "manual"]);
    }

    #[test]
    fn automatic_admission_is_paced_never_capped() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-01T12:10:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let mut store = Store {
            auto_activation_events: Some(vec![
                "2026-10-01T12:09:59Z".into(),
                "2026-10-01T12:09:58Z".into(),
                "2026-10-01T12:09:57Z".into(),
            ]),
            ..Store::default()
        };
        let (allowance, _) = auto_activation_allowance(&mut store, now);
        assert_eq!(allowance, 2);
        store.auto_activation_events = Some(vec!["2026-10-01T12:09:59Z".into(); 5]);
        let (allowance, wait) = auto_activation_allowance(&mut store, now);
        assert_eq!(allowance, 0);
        assert!(wait.contains("rate limit"));

        store.auto_activation_events = None;
        store.registrations = (0..40)
            .map(|i| automatic_registration(&format!("a-{i}"), &format!("s-{i}"), "2026-09-30T12:00:00Z"))
            .collect();
        let (allowance, _) = auto_activation_allowance(&mut store, now);
        assert_eq!(allowance, AUTO_ACTIVATE_MAX_PER_WINDOW, "never capped");
    }

    // A write pause must hold every blocker mirror: no PATCH leaves, and
    // the journal stays dirty so the next pass republishes it.
    #[tokio::test]
    async fn a_write_pause_publishes_nothing_and_keeps_the_mirror_dirty() {
        let (core, _temp) = test_core();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let mut registration = automatic_registration("mirror", THREAD, "2026-10-01T12:00:00Z");
        registration.base_url = base;
        registration.workspace_key = Some(Secret::new("workspace-key"));
        let scope = core.relaycast_scope(&registration.base_url, &Secret::new("workspace-key"));
        core.store
            .update(|store| store.registrations.push(registration))
            .unwrap();
        let denied: relaycast::Result<()> = Err(relaycast::RelayError::Api {
            code: "workspace_busy".into(),
            message: "busy".into(),
            status: 503,
            request_id: None,
            attempts: 1,
            retry_after_ms: Some(30_000),
            details: None,
        });
        core.observe_relaycast_write_result(&scope, &denied);
        assert!(!core.relaycast_write_allowed(&scope));

        let mut published = None;
        let mut failures = Vec::new();
        let blocked = BTreeMap::from([("codex:thread".to_string(), "limited".to_string())]);
        core.record_activation_outcomes(
            &[],
            &blocked,
            "2026-10-01T12:00:00Z",
            &mut failures,
            &mut published,
        )
        .await;

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(listener.accept().is_err(), "a paused write still went out");
        assert!(published.is_none(), "a paused publish must stay dirty");
        let journal = core.store.read(|s| s.auto_activation_failures.clone());
        assert_eq!(
            journal.unwrap()["codex:thread"].message,
            "limited",
            "the local journal still records the blocker"
        );
    }

    // A failed publish is retried on the next pass even when the journal
    // did not change, and a journal cleared by registration is mirrored
    // as an empty `blocked_sessions` rather than left stale remotely.
    #[tokio::test]
    async fn a_failed_mirror_retries_and_a_cleared_journal_reaches_the_roster() {
        let (core, _temp) = test_core();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(StdMutex::new(Vec::new()));
        let server = patch_stub(listener, 3, hits.clone());
        let mut registration = automatic_registration("mirror", THREAD, "2026-10-01T12:00:00Z");
        registration.base_url = base;
        registration.workspace_key = Some(Secret::new("workspace-key"));
        core.store
            .update(|store| store.registrations.push(registration))
            .unwrap();

        let mut published = None;
        let now = "2026-10-01T12:00:00Z";
        let blocked = BTreeMap::from([("codex:thread".to_string(), "limited".to_string())]);
        let mut failures = Vec::new();

        // First PATCH is rejected: the mirror stays dirty even though the
        // local journal recorded the blocker.
        core.record_activation_outcomes(&[], &blocked, now, &mut failures, &mut published)
            .await;
        assert!(published.is_none(), "a failed publish must stay dirty");
        assert_eq!(hits.lock().unwrap().len(), 1);

        // Same journal, next pass: the dirty mirror republishes anyway and
        // this time Relaycast takes it.
        core.record_activation_outcomes(&[], &blocked, now, &mut failures, &mut published)
            .await;
        assert_eq!(hits.lock().unwrap().len(), 2);
        assert!(published.is_some(), "a clean publish is remembered");

        // Nothing changed: no third PATCH.
        core.record_activation_outcomes(&[], &blocked, now, &mut failures, &mut published)
            .await;
        assert_eq!(hits.lock().unwrap().len(), 2, "a clean mirror stays quiet");

        // The session registered between passes: the local journal is
        // cleared and the roster hears `blocked_sessions: []`, not nothing.
        core.record_activation_outcomes(
            &["codex:thread".to_string()],
            &BTreeMap::new(),
            now,
            &mut failures,
            &mut published,
        )
        .await;
        let hits = hits.lock().unwrap();
        assert_eq!(
            hits.len(),
            3,
            "the cleared journal must be published: {failures:?}"
        );
        assert!(hits[0].contains("codex:thread"), "{}", hits[0]);
        assert!(hits[2].contains("\"blocked_sessions\":[]"), "{}", hits[2]);
        drop(hits);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn show_relay_messages_is_off_until_turned_on_and_is_kept() {
        use crate::relay::store_settings::SHOW_RELAY_MESSAGES;
        let temp = tempfile::tempdir().unwrap();
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                .unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let (core, _signals) = Core::with_plugins(config, crate::relay::daemon::Plugins::default());
        // Delivery's flag is process-wide and every core sets it, so this
        // reads the store; `store_settings` tests the flag under its lock.
        use crate::relay::store::Store;
        assert_eq!(core.settings()[SHOW_RELAY_MESSAGES], json!(false));
        assert!(core.store.read(Store::hides_relay_messages));
        let mut on = Map::new();
        on.insert(SHOW_RELAY_MESSAGES.into(), json!(true));
        let settings = core.set_settings(&on).unwrap();
        assert_eq!(settings[SHOW_RELAY_MESSAGES], json!(true));
        assert_eq!(core.store.read(|s| s.show_relay_messages), Some(true));
        assert!(!core.store.read(Store::hides_relay_messages));
        // Other store settings are untouched by it.
        assert_eq!(settings["allow_self_registration"], json!(true));
        let mut off = Map::new();
        off.insert(SHOW_RELAY_MESSAGES.into(), json!(false));
        core.set_settings(&off).unwrap();
        assert!(core.store.read(Store::hides_relay_messages), "hidden again");
    }
}
