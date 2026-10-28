//! The relay senders the person trusts like themselves.
//!
//! **Settings › Trusted senders** (`trusted_relay_senders`) lists relay
//! names or exact addresses. A message from one of them reaches the person's
//! own agent rather than an answer-only stand-in: OpenClaw's main session,
//! and the person's own Hermes instead of its `relay` profile. Everyone else
//! keeps an answer-only session of their own.
//!
//! The people in the person's workspace are trusted too, unless the person
//! turns that off (`trust_workspace_members`, the desktop's side of Cloud's
//! `trustWorkspaceMembers`). Cloud lists them
//! (`GET /workspaces/<id>/messaging/people`): only active members of the
//! workspace's organization, on its current relay binding. A member is
//! matched by the Relaycast agent id of their person identity, which
//! Relaycast stamps on each message from the sending token, never by name:
//! a name registered again gets a new id. Their agents are not included;
//! those run unattended on inputs the member never saw, and are listed by
//! hand when trusted. The list is read again every minute, so a removed
//! member loses trust within a minute, and a list Cloud has not confirmed
//! for [`MEMBERS_FRESH`] trusts no one.

use crate::relay::cloud_session::{segment, CloudAccess, CloudAccount};
use crate::relay::inject::DeliveryRoute;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// The `settings.set` key.
pub const SETTING: &str = "trusted_relay_senders";

/// Whether the people in the workspace are trusted: on unless turned off.
pub const MEMBERS_SETTING: &str = "trust_workspace_members";

/// The people in the workspace trusted while [`MEMBERS_SETTING`] is on;
/// read-only.
pub const MEMBERS_LIST: &str = "workspace_members";

/// How often the people in the workspace are read from Cloud.
pub const MEMBERS_REFRESH: Duration = Duration::from_secs(60);

/// A member list Cloud has not confirmed for this long trusts no one, so a
/// removed member never stays trusted while Cloud cannot be reached.
pub const MEMBERS_FRESH: Duration = Duration::from_secs(10 * 60);

/// A person in the workspace, by their person identity on the relay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceMember {
    /// The person identity's relay name.
    pub name: String,
    /// The person's name in Agent Relay, when it differs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// The identity's Relaycast agent id, which trust is matched by.
    pub id: String,
}

/// Authorization for one member read. A response from a retired sign-in or
/// an earlier opt-in cannot restore trust.
#[derive(Clone, Debug, PartialEq, Eq)]
struct MemberScope {
    account: CloudAccount,
    generation: u64,
    revision: u64,
}

#[derive(Clone, Debug)]
struct MemberCache {
    scope: MemberScope,
    read_at_ms: i64,
    members: Vec<WorkspaceMember>,
}

#[derive(Default)]
struct MemberState {
    cache: Mutex<Option<MemberCache>>,
    cloud: OnceLock<Arc<dyn CloudAccess>>,
    revision: AtomicU64,
}

/// The trusted-sender keys whose values are not true or false: the list,
/// checked here, and the read-only members.
pub fn is_list_key(key: &str) -> bool {
    key == SETTING || key == MEMBERS_LIST
}

/// Keeps the people in the workspace that OpenClaw and Hermes trust current,
/// until the core stops.
pub async fn keep_members_current(core: std::sync::Arc<crate::relay::daemon::Core>) {
    let Some(trusted) = core.plugins.trusted.clone() else {
        return;
    };
    let mut stopping = core.shutdown_requested();
    let changed = || core.hub.invalidated(crate::relay::state::Listing::Settings);
    tokio::select! {
        _ = trusted.refresh_loop(core.plugins.cloud.as_ref(), changed) => {}
        _ = stopping.wait_for(|stop| *stop) => {}
    }
}

/// Cloud's `{"people": [...]}`: each person with a relay name and the
/// Relaycast agent id of their identity, sorted by name. A person without
/// an id (a Cloud that does not report it yet) is left out, never matched
/// by name.
pub fn decode_people(value: &Value) -> Vec<WorkspaceMember> {
    let text = |person: &Value, key: &str| {
        person[key]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let mut members: Vec<WorkspaceMember> = value["people"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|person| {
            let name = text(person, "handle")?;
            let id = text(person, "agentId")?;
            let display_name = text(person, "displayName").filter(|shown| *shown != name);
            Some(WorkspaceMember {
                name,
                display_name,
                id,
            })
        })
        .collect();
    members.sort_by_key(|member| member.name.to_lowercase());
    members.dedup_by(|a, b| a.id == b.id);
    members
}

/// At most this many trusted senders, each at most 256 characters.
const MAX: usize = 50;

/// The saved list, under the app's data directory.
#[derive(Clone)]
pub struct TrustedSenders {
    path: PathBuf,
    members_on_path: PathBuf,
    members: Arc<MemberState>,
}

impl std::fmt::Debug for TrustedSenders {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustedSenders")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl TrustedSenders {
    pub fn new(app_data_dir: &Path) -> Self {
        TrustedSenders {
            path: app_data_dir.join("trusted-relay-senders.json"),
            members_on_path: app_data_dir.join("trust-workspace-members.json"),
            members: Arc::default(),
        }
    }

    /// Binds the live account before deliveries start. Member lists live only
    /// in this process, and are shared by Settings, OpenClaw and Hermes.
    pub fn bind_cloud(&self, cloud: Arc<dyn CloudAccess>) {
        let _ = self.members.cloud.set(cloud);
    }

    fn scope(&self) -> Option<MemberScope> {
        let cloud = self.members.cloud.get()?;
        Some(MemberScope {
            account: cloud.account()?,
            generation: cloud.identity_sync_generation(),
            revision: self.members.revision.load(Ordering::SeqCst),
        })
    }

    /// Whether the people in the workspace are trusted: on unless turned off.
    pub fn trusts_members(&self) -> bool {
        std::fs::read(&self.members_on_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<bool>(&bytes).ok())
            .unwrap_or(true)
    }

    /// Turns trusting the people in the workspace on or off.
    pub fn set_trusts_members(&self, on: bool) -> Result<(), String> {
        self.clear_members();
        crate::relay::mailbox::write_private(
            &self.members_on_path,
            json!(on).to_string().as_bytes(),
        )
        .map_err(|e| format!("Could not save whether people in your workspace are trusted: {e}"))
    }

    /// Only a fresh list confirmed for the current account grants trust.
    pub fn members_at(&self, now_ms: i64) -> Vec<WorkspaceMember> {
        let cache = self
            .members
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .as_ref()
            .filter(|cache| {
                let age = now_ms.saturating_sub(cache.read_at_ms);
                self.trusts_members()
                    && self.scope().as_ref() == Some(&cache.scope)
                    && (0..=MEMBERS_FRESH.as_millis() as i64).contains(&age)
            })
            .map(|cache| cache.members.clone())
            .unwrap_or_default()
    }

    /// The people in the workspace, while Cloud's list is fresh.
    pub fn members(&self) -> Vec<WorkspaceMember> {
        self.members_at(crate::relay::state::now_ms())
    }

    /// Publishes a response only while its authorization is still current.
    fn store_members(&self, scope: MemberScope, members: Vec<WorkspaceMember>, now_ms: i64) {
        let mut cache = self
            .members
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.trusts_members() && self.scope().as_ref() == Some(&scope) {
            *cache = Some(MemberCache {
                scope,
                read_at_ms: now_ms,
                members,
            });
        }
    }

    /// Forget cached people and reject reads already in flight.
    pub fn clear_members(&self) -> bool {
        let mut cache = self
            .members
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.members.revision.fetch_add(1, Ordering::SeqCst);
        cache.take().is_some_and(|cache| !cache.members.is_empty())
    }

    /// Whether `route`'s sender is a person in the workspace, by the
    /// Relaycast agent id of their person identity, at `now_ms`.
    pub fn trusts_member_at(&self, route: &DeliveryRoute<'_>, now_ms: i64) -> bool {
        let Some(sender_id) = route.sender_id.filter(|id| !id.is_empty()) else {
            return false;
        };
        self.trusts_members()
            && self
                .members_at(now_ms)
                .iter()
                .any(|member| member.id == sender_id)
    }

    /// The names and addresses as Settings saved them.
    pub fn list(&self) -> Vec<String> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .unwrap_or_default()
    }

    /// Whether `route`'s sender is trusted: listed by hand, or a person in
    /// the workspace.
    pub fn trusts(&self, route: &DeliveryRoute<'_>) -> bool {
        matches(&self.list(), route) || self.trusts_member_at(route, crate::relay::state::now_ms())
    }

    /// Saves `value`, a list of names or addresses: trimmed, empty and
    /// repeated entries dropped.
    pub fn set(&self, value: &Value) -> Result<(), String> {
        let invalid =
            || format!("{SETTING} must be a list of at most {MAX} relay names or addresses.");
        let list = value.as_array().ok_or_else(invalid)?;
        let mut senders: Vec<String> = Vec::new();
        for entry in list {
            let entry = entry.as_str().ok_or_else(invalid)?.trim();
            if entry.is_empty() {
                continue;
            }
            if entry.chars().count() > 256 || entry.chars().any(char::is_control) {
                return Err(invalid());
            }
            if !senders
                .iter()
                .any(|known| known.eq_ignore_ascii_case(entry))
            {
                senders.push(entry.to_string());
            }
        }
        if senders.len() > MAX {
            return Err(invalid());
        }
        let bytes = serde_json::to_vec(&senders).map_err(|e| e.to_string())?;
        crate::relay::mailbox::write_private(&self.path, &bytes)
            .map_err(|e| format!("Could not save the trusted senders: {e}"))
    }
}

/// Whether `route`'s sender is in `trusted`: its exact address, or, for an
/// entry without `@`, its name; both without case.
pub fn matches(trusted: &[String], route: &DeliveryRoute<'_>) -> bool {
    trusted.iter().any(|entry| {
        let entry = entry.trim();
        !entry.is_empty()
            && (route
                .sender_address
                .is_some_and(|address| address.eq_ignore_ascii_case(entry))
                || (!entry.contains('@')
                    && route
                        .sender
                        .is_some_and(|name| name.eq_ignore_ascii_case(entry))))
    })
}

/// `trusted_relay_senders`, `trust_workspace_members` and
/// `workspace_members`: present while an agent they apply to (OpenClaw,
/// Hermes) is set up on this computer.
pub struct TrustedSettings {
    senders: TrustedSenders,
    applies: Box<dyn Fn() -> bool + Send + Sync>,
    /// Wakes the member refresh early: turned on, or a new sign-in.
    refresh: tokio::sync::Notify,
    published_members: Mutex<Vec<WorkspaceMember>>,
}

impl TrustedSettings {
    pub fn new(
        senders: TrustedSenders,
        applies: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        TrustedSettings {
            senders,
            applies: Box::new(applies),
            refresh: tokio::sync::Notify::new(),
            published_members: Mutex::new(Vec::new()),
        }
    }

    pub fn bind_cloud(&self, cloud: Arc<dyn CloudAccess>) {
        self.senders.bind_cloud(cloud);
    }

    /// Reads the people in the workspace again soon.
    pub fn refresh_soon(&self) {
        self.refresh_soon_if_account_changed();
        self.refresh.notify_one();
    }

    /// Reads the people in the workspace from Cloud while they apply: an
    /// agent is set up, they are trusted and someone is signed in. Signed
    /// out, the list is forgotten; when Cloud cannot be read, the list ages
    /// out after [`MEMBERS_FRESH`]. Whether the people shown changed.
    pub async fn refresh_members(&self, cloud: &dyn CloudAccess) -> bool {
        self.read_members(cloud).await;
        let members = self.senders.members();
        let mut published = self
            .published_members
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let changed = *published != members;
        *published = members;
        changed
    }

    async fn read_members(&self, cloud: &dyn CloudAccess) {
        // Do this before the applicability checks, including while opted out.
        self.refresh_soon_if_account_changed();
        if !(self.applies)() || !self.senders.trusts_members() {
            self.senders.clear_members();
            return;
        }
        let Some(scope) = self.senders.scope() else {
            return;
        };
        let path = format!(
            "/workspaces/{}/messaging/people",
            segment(&scope.account.workspace_id)
        );
        let Ok(value) = cloud.request("GET", path, None).await else {
            return;
        };
        if value["people"].is_array() {
            self.senders
                .store_members(scope, decode_people(&value), crate::relay::state::now_ms());
        }
    }

    fn refresh_soon_if_account_changed(&self) {
        let invalid = self
            .senders
            .members
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .is_some_and(|cache| self.senders.scope().as_ref() != Some(&cache.scope));
        if invalid {
            self.senders.clear_members();
        }
    }

    /// Refreshes the people in the workspace every [`MEMBERS_REFRESH`], or
    /// sooner when asked; `changed` runs when the people shown changed.
    pub async fn refresh_loop(&self, cloud: &dyn CloudAccess, changed: impl Fn()) {
        let mut ticks = tokio::time::interval(MEMBERS_REFRESH);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticks.tick() => {}
                _ = self.refresh.notified() => {}
            }
            if self.refresh_members(cloud).await {
                changed();
            }
        }
    }
}

impl crate::relay::agents::SettingsExtension for TrustedSettings {
    fn get(&self) -> serde_json::Map<String, Value> {
        let mut settings = serde_json::Map::new();
        if (self.applies)() {
            settings.insert(SETTING.into(), json!(self.senders.list()));
            let on = self.senders.trusts_members();
            settings.insert(MEMBERS_SETTING.into(), json!(on));
            // Shown by name; the ids stay in the core.
            let members: Vec<Value> = if on {
                self.senders.members()
            } else {
                Vec::new()
            }
            .into_iter()
            .map(|member| json!({"name": member.name, "display_name": member.display_name}))
            .collect();
            settings.insert(MEMBERS_LIST.into(), Value::Array(members));
        }
        settings
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        match key {
            SETTING => Some(self.senders.set(value)),
            MEMBERS_SETTING => Some(match value.as_bool() {
                Some(on) => self.senders.set_trusts_members(on).inspect(|()| {
                    if on {
                        self.refresh_soon();
                    }
                }),
                None => Err(format!("{MEMBERS_SETTING} must be true or false.")),
            }),
            MEMBERS_LIST => Some(Err(format!(
                "{MEMBERS_LIST} is read from your workspace and cannot be set."
            ))),
            _ => None,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
