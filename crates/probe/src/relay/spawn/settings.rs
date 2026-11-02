//! What the person configured for spawning: on/off, full access and
//! billing per harness (`harnesses`), whether teammates may spawn here, the
//! most agents at once and repositories. The store keeps them;
//! `settings.get` and `settings.set` read and check them here.

use super::{lifecycle, wire};
use crate::relay::daemon::Core;
use crate::relay::harness::HarnessId;
use crate::relay::protocol::RpcError;
use crate::relay::store::Store;
use serde_json::{json, Map, Value};
use wire::Billing;

/// Puts the store field `$field` back as it was before `$write`, if it still
/// holds what `$write` saved there; a newer value another writer saved is
/// kept. Answers whether it was put back.
macro_rules! put_back {
    ($store:expr, $write:expr, $($field:ident).+) => {{
        let written = &$write.written.$($field).+;
        let previous = &$write.previous.$($field).+;
        if $store.$($field).+ == *written && written != previous {
            $store.$($field).+ = previous.clone();
            true
        } else {
            false
        }
    }};
}

pub mod harnesses;
pub use harnesses::HarnessSettings;

/// The settings that govern spawning.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnSettings {
    pub accept: bool,
    /// Workspace owners and admins may spawn here, not only the node's
    /// owner. Off unless turned on; advertised as `teammates`.
    pub allow_teammates: bool,
    pub max_agents: u32,
    pub repositories: Vec<String>,
    /// Every known harness's, in order.
    pub harnesses: Vec<(HarnessId, HarnessSettings)>,
}

impl SpawnSettings {
    pub fn of(store: &Store) -> SpawnSettings {
        SpawnSettings {
            accept: store.accepts_spawns(),
            allow_teammates: store.spawn_allow_teammates == Some(true),
            max_agents: lifecycle::max_agents(store.spawn_max_agents),
            repositories: store.spawn_repositories.clone().unwrap_or_default(),
            harnesses: harnesses::of(store),
        }
    }

    fn harness(&self, harness: HarnessId) -> Option<&HarnessSettings> {
        self.harnesses
            .iter()
            .find(|(id, _)| *id == harness)
            .map(|(_, settings)| settings)
    }

    pub fn full_access(&self, harness: HarnessId) -> bool {
        self.harness(harness)
            .is_some_and(|settings| settings.full_access)
    }

    pub fn billing(&self, harness: HarnessId) -> Billing {
        self.harness(harness)
            .map(|settings| settings.billing)
            .unwrap_or_default()
    }
}

/// Every spawn setting the store keeps, as `settings.get` and
/// `settings.set` name them.
pub const KEYS: [&str; 11] = [
    "accept_spawns",
    "spawn_full_access_codex",
    "spawn_full_access_claude",
    "spawn_allow_teammates",
    "spawn_native_input",
    "spawn_requester_approvals",
    "spawn_max_agents",
    "spawn_billing_codex",
    "spawn_billing_claude",
    "spawn_repositories",
    harnesses::KEY,
];

/// The configured spawn settings that are not on/off: the store keeps them
/// and `settings.set` checks them here.
pub const CONFIGURED_KEYS: [&str; 5] = [
    "spawn_max_agents",
    "spawn_billing_codex",
    "spawn_billing_claude",
    "spawn_repositories",
    harnesses::KEY,
];

/// The most repositories a node advertises.
const MAX_REPOSITORIES: usize = 64;

/// `settings.get`'s values for the configured settings, apart from
/// `spawn_harnesses`.
pub fn configured_values(store: &Store) -> Map<String, Value> {
    let settings = SpawnSettings::of(store);
    let mut values = Map::new();
    values.insert("spawn_max_agents".into(), json!(settings.max_agents));
    for id in harnesses::FLAT.into_iter().filter_map(HarnessId::from_name) {
        values.insert(
            format!("spawn_billing_{id}"),
            json!(settings.billing(id).name()),
        );
    }
    values.insert("spawn_repositories".into(), json!(settings.repositories));
    values
}

/// A checked change to the configured spawn settings.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfiguredChange {
    max_agents: Option<u32>,
    billing: Vec<(HarnessId, Billing)>,
    repositories: Option<Vec<String>>,
}

fn max_agents(changes: &Map<String, Value>) -> Result<Option<u32>, String> {
    changes
        .get("spawn_max_agents")
        .map(|value| {
            value
                .as_u64()
                .filter(|n| (0..=lifecycle::MAX_AGENTS_LIMIT as u64).contains(n))
                .map(|n| n as u32)
                .ok_or_else(|| {
                    format!(
                        "spawn_max_agents must be 0 (no limit) or a whole number from 1 to {}.",
                        lifecycle::MAX_AGENTS_LIMIT
                    )
                })
        })
        .transpose()
}

fn repositories(changes: &Map<String, Value>) -> Result<Option<Vec<String>>, String> {
    changes
        .get("spawn_repositories")
        .map(|value| {
            let invalid = || {
                format!(
                    "spawn_repositories must be a list of at most {MAX_REPOSITORIES} \
                     owner/name repository keys."
                )
            };
            let keys = value.as_array().ok_or_else(invalid)?;
            let mut kept: Vec<String> = Vec::new();
            for key in keys {
                let key = key
                    .as_str()
                    .filter(|key| wire::valid_repo_key(key))
                    .ok_or_else(invalid)?;
                if !kept.iter().any(|k| k == key) {
                    kept.push(key.to_string());
                }
            }
            if kept.len() > MAX_REPOSITORIES {
                return Err(invalid());
            }
            Ok(kept)
        })
        .transpose()
}

impl ConfiguredChange {
    /// Reads the configured spawn settings among `changes`; an invalid one
    /// is refused with the reason, before anything is changed.
    pub fn read(changes: &Map<String, Value>) -> Result<ConfiguredChange, String> {
        let billing = harnesses::changes(changes)?
            .into_iter()
            .filter_map(|(id, change)| Some((id, change.billing?)))
            .collect();
        Ok(ConfiguredChange {
            max_agents: max_agents(changes)?,
            billing,
            repositories: repositories(changes)?,
        })
    }

    pub fn is_empty(&self) -> bool {
        *self == ConfiguredChange::default()
    }

    pub fn apply(&self, store: &mut Store) {
        if let Some(max) = self.max_agents {
            store.spawn_max_agents = Some(max);
        }
        for (id, billing) in &self.billing {
            harnesses::HarnessChange {
                full_access: None,
                billing: Some(*billing),
            }
            .apply(*id, store);
        }
        if let Some(repositories) = &self.repositories {
            store.spawn_repositories = (!repositories.is_empty()).then(|| repositories.clone());
        }
    }

    /// Puts back each field [`Self::apply`] wrote (see `put_back!`).
    fn restore(&self, store: &mut Store, write: &StoreWrite) -> bool {
        let mut restored = false;
        if self.max_agents.is_some() {
            restored |= put_back!(store, write, spawn_max_agents);
        }
        for (id, _) in &self.billing {
            restored |= put_back_harness(store, write, *id);
        }
        if self.repositories.is_some() {
            restored |= put_back!(store, write, spawn_repositories);
        }
        restored
    }
}

/// Whether **Approvals from the spawning agent** is on as set: on in Agent
/// Relay Dev (`development`) and off in the release build, unless the person
/// set it.
pub fn requester_approvals_setting(store: &Store, development: bool) -> bool {
    store
        .extras
        .spawn_requester_approvals
        .unwrap_or(development)
}

/// Whether the agent that spawned a session may answer its permission and
/// approval requests: approvals from the spawning agent on, and native input
/// from it too, which approvals never outlive.
pub fn requester_approvals(store: &Store, development: bool) -> bool {
    store.extras.spawn_native_input != Some(false)
        && requester_approvals_setting(store, development)
}

/// `settings.get`'s spawn values: whether spawns are accepted, each
/// harness's settings, whether teammates may spawn, and the rest of
/// `CONFIGURED_KEYS`. `development` gives approvals from the spawning agent
/// its default.
pub fn values(store: &Store, development: bool) -> Map<String, Value> {
    let settings = SpawnSettings::of(store);
    let mut values = Map::new();
    values.insert("accept_spawns".into(), json!(settings.accept));
    for id in harnesses::FLAT.into_iter().filter_map(HarnessId::from_name) {
        values.insert(
            format!("spawn_full_access_{id}"),
            json!(settings.full_access(id)),
        );
    }
    values.insert(
        "spawn_allow_teammates".into(),
        json!(settings.allow_teammates),
    );
    values.insert(
        "spawn_native_input".into(),
        json!(store.extras.spawn_native_input != Some(false)),
    );
    values.insert(
        "spawn_requester_approvals".into(),
        json!(requester_approvals_setting(store, development)),
    );
    values.extend(configured_values(store));
    values.insert(harnesses::KEY.into(), harnesses::value(&settings.harnesses));
    values
}

/// A checked change to every spawn setting among `settings.set`'s changes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Change {
    accept: Option<bool>,
    full_access: Vec<(HarnessId, bool)>,
    allow_teammates: Option<bool>,
    native_input: Option<bool>,
    requester_approvals: Option<bool>,
    configured: ConfiguredChange,
}

impl Change {
    /// Reads the spawn settings among `changes`; an invalid one is refused
    /// with the reason, before anything is changed.
    pub fn read(changes: &Map<String, Value>) -> Result<Change, String> {
        let configured = ConfiguredChange::read(changes)?;
        let full_access = harnesses::changes(changes)?
            .into_iter()
            .filter_map(|(id, change)| Some((id, change.full_access?)))
            .collect();
        Ok(Change {
            accept: changes.get("accept_spawns").and_then(Value::as_bool),
            full_access,
            allow_teammates: changes
                .get("spawn_allow_teammates")
                .and_then(Value::as_bool),
            native_input: changes
                .get("spawn_native_input")
                .map(|v| v.as_bool().ok_or("spawn_native_input must be a boolean."))
                .transpose()?,
            requester_approvals: changes
                .get("spawn_requester_approvals")
                .map(|v| {
                    v.as_bool()
                        .ok_or("spawn_requester_approvals must be a boolean.")
                })
                .transpose()?,
            configured,
        })
    }

    pub fn is_empty(&self) -> bool {
        *self == Change::default()
    }

    pub fn apply(&self, store: &mut Store) {
        if self.accept.is_some() {
            store.accept_spawns = self.accept;
        }
        for (id, full_access) in &self.full_access {
            harnesses::HarnessChange {
                full_access: Some(*full_access),
                billing: None,
            }
            .apply(*id, store);
        }
        if self.native_input.is_some() {
            store.extras.spawn_native_input = self.native_input;
        }
        if self.requester_approvals.is_some() {
            store.extras.spawn_requester_approvals = self.requester_approvals;
        }
        if self.allow_teammates.is_some() {
            store.spawn_allow_teammates = self.allow_teammates;
        }
        self.configured.apply(store);
    }

    /// Puts back each field [`Self::apply`] wrote (see `put_back!`).
    fn restore(&self, store: &mut Store, write: &StoreWrite) -> bool {
        let mut restored = false;
        if self.accept.is_some() {
            restored |= put_back!(store, write, accept_spawns);
        }
        for (id, _) in &self.full_access {
            restored |= put_back_harness(store, write, *id);
        }
        if self.native_input.is_some() {
            restored |= put_back!(store, write, extras.spawn_native_input);
        }
        if self.requester_approvals.is_some() {
            restored |= put_back!(store, write, extras.spawn_requester_approvals);
        }
        if self.allow_teammates.is_some() {
            restored |= put_back!(store, write, spawn_allow_teammates);
        }
        self.configured.restore(store, write) | restored
    }

    /// Whether the spawn node must be brought in line with the change:
    /// teammates go out in a heartbeat at once, as the maximum does.
    fn moves_node(&self) -> bool {
        self.accept.is_some() || self.allow_teammates.is_some() || !self.configured.is_empty()
    }
}

/// What a store-settings save changed: the store just before the write and
/// just after it.
pub(crate) struct StoreWrite {
    previous: Store,
    written: Store,
}

/// `put_back!` for one harness's spawn settings.
fn put_back_harness(store: &mut Store, write: &StoreWrite, id: HarnessId) -> bool {
    let written = write.written.spawn_harness(id.name());
    let previous = write.previous.spawn_harness(id.name());
    if store.spawn_harness(id.name()) == written && written != previous {
        store.set_spawn_harness(id.name(), previous);
        return true;
    }
    false
}

impl Core {
    /// Whether this is Agent Relay Dev, which turns approvals from the
    /// spawning agent on by default.
    pub(crate) fn development(&self) -> bool {
        crate::relay::outbound::is_development(&self.config.app_data_dir)
    }

    /// `settings.get`'s spawn values (`values`) for this build.
    pub(crate) fn spawn_setting_values(&self) -> Map<String, Value> {
        let development = self.development();
        self.store.read(|store| values(store, development))
    }

    /// Saves the settings the store keeps among `changes` in one write:
    /// self-registration, auto-activation, relay messages, joining #general,
    /// connecting the tools found here, and spawning. The
    /// save refreshes `show_relay_messages` for the next delivery
    /// (`HandleState::saved`); a change to spawning then brings the spawn
    /// node in line.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn set_store_settings(&self, changes: &Map<String, Value>) -> Result<(), RpcError> {
        self.save_store_settings(changes).map(|_| ())
    }

    /// [`Self::set_store_settings`], answering what the store held just
    /// before its write and just after it, when it wrote.
    pub(crate) fn save_store_settings(
        &self,
        changes: &Map<String, Value>,
    ) -> Result<Option<StoreWrite>, RpcError> {
        let spawn = Change::read(changes).map_err(RpcError::invalid_params)?;
        let change = |key: &str| changes.get(key).and_then(Value::as_bool);
        let flags = crate::relay::store_settings::STORE_SETTINGS.map(change);
        let [allow, auto, show, general, mobile_handoff, native_continuation, teammate_input, connect, pi_auto, opencode_auto] =
            flags;
        if native_continuation == Some(true) {
            self.require_native_continuation_claim()
                .map_err(|message| {
                    RpcError::new(crate::relay::protocol::ErrorKind::Refused, message)
                })?;
        }
        // Turning Claude's route on installs its plugin first. A failed
        // install stores no choice for Claude, but the rest of the change
        // (the other adapters' route among it, which the one Settings row
        // sets together with Claude's) is still saved; the error is then
        // reported.
        let mut install_error = None;
        let mut mobile_handoff = mobile_handoff;
        if mobile_handoff == Some(true) {
            self.require_mobile_claude_owner_claim()
                .map_err(|message| {
                    RpcError::new(crate::relay::protocol::ErrorKind::Refused, message)
                })?;
            if let Err(message) = self.install_mobile_claude_plugin() {
                install_error = Some(message);
                mobile_handoff = None;
            }
        }
        let mut write = None;
        if flags.iter().any(Option::is_some) || !spawn.is_empty() {
            write = self
                .store
                .update(|store| {
                    let previous = store.clone();
                    store.allow_self_registration = allow.or(store.allow_self_registration);
                    store.auto_activate = auto.or(store.auto_activate);
                    store.mobile_claude_handoff = mobile_handoff.or(store.mobile_claude_handoff);
                    store.mobile_native_continuation =
                        native_continuation.or(store.mobile_native_continuation);
                    store.show_relay_messages = show.or(store.show_relay_messages);
                    store.extras.auto_join_general = general.or(store.extras.auto_join_general);
                    store.extras.teammate_native_input =
                        teammate_input.or(store.extras.teammate_native_input);
                    store.extras.connect_detected_tools =
                        connect.or(store.extras.connect_detected_tools);
                    store.extras.pi_auto_activate = pi_auto.or(store.extras.pi_auto_activate);
                    store.extras.opencode_auto_activate =
                        opencode_auto.or(store.extras.opencode_auto_activate);
                    spawn.apply(store);
                    Some(StoreWrite {
                        previous,
                        written: store.clone(),
                    })
                })
                .map_err(|e| RpcError::store(&e))?;
        }
        if let Some(enabled) = mobile_handoff {
            self.mobile_claude_setting_changed(enabled)
                .map_err(|message| {
                    RpcError::new(crate::relay::protocol::ErrorKind::Refused, message)
                })?;
        }
        if teammate_input == Some(false) {
            self.teammate_native_input_disabled().map_err(|message| {
                RpcError::new(crate::relay::protocol::ErrorKind::Refused, message)
            })?;
        }
        if let Some(message) = install_error {
            return Err(RpcError::new(
                crate::relay::protocol::ErrorKind::Refused,
                message,
            ));
        }
        if spawn.moves_node() {
            if let Some(core) = self.arc() {
                tokio::spawn(async move { core.sync_spawn_node().await });
            }
        }
        if native_continuation.is_some() {
            self.native_continuation_setting_changed();
        }
        Ok(write)
    }

    /// Puts the settings [`Self::save_store_settings`] saved from `changes`
    /// back as the store had them before `write`, so a `settings.set` batch
    /// that then fails keeps none of its store changes. Each key is compared
    /// and put back under the store's lock: one another writer changed since
    /// is left as that writer saved it. The hooks that follow those settings
    /// run again for the keys put back; what a hook already did outside the
    /// store (a plugin installed, queued teammate messages cancelled) is not
    /// undone.
    pub(crate) fn restore_store_settings(
        &self,
        changes: &Map<String, Value>,
        write: &StoreWrite,
    ) -> Result<(), RpcError> {
        let Ok(spawn) = Change::read(changes) else {
            return Ok(());
        };
        let changed = |key: &str| changes.get(key).and_then(Value::as_bool).is_some();
        let [allow, auto, show, general, mobile_handoff, native_continuation, teammate_input, connect, pi_auto, opencode_auto] =
            crate::relay::store_settings::STORE_SETTINGS.map(changed);
        let (handoff, continuation, spawning) = self
            .store
            .update(|store| {
                if allow {
                    put_back!(store, write, allow_self_registration);
                }
                if auto {
                    put_back!(store, write, auto_activate);
                }
                if show {
                    put_back!(store, write, show_relay_messages);
                }
                if general {
                    put_back!(store, write, extras.auto_join_general);
                }
                if teammate_input {
                    put_back!(store, write, extras.teammate_native_input);
                }
                if connect {
                    put_back!(store, write, extras.connect_detected_tools);
                }
                if pi_auto {
                    put_back!(store, write, extras.pi_auto_activate);
                }
                if opencode_auto {
                    put_back!(store, write, extras.opencode_auto_activate);
                }
                (
                    mobile_handoff && put_back!(store, write, mobile_claude_handoff),
                    native_continuation && put_back!(store, write, mobile_native_continuation),
                    spawn.restore(store, write),
                )
            })
            .map_err(|e| RpcError::store(&e))?;
        if handoff {
            let _ = self.mobile_claude_setting_changed(write.previous.mobile_claude_handoff_on());
        }
        if spawning && spawn.moves_node() {
            if let Some(core) = self.arc() {
                tokio::spawn(async move { core.sync_spawn_node().await });
            }
        }
        if continuation {
            self.native_continuation_setting_changed();
        }
        Ok(())
    }
}

#[cfg(test)]
mod native_input_tests {
    use super::*;
    #[test]
    fn native_input_is_on_by_default_persisted_and_rejects_non_booleans() {
        let mut store = Store::default();
        assert_eq!(values(&store, false)["spawn_native_input"], true);
        for enabled in [false, true] {
            Change::read(json!({"spawn_native_input": enabled}).as_object().unwrap())
                .unwrap()
                .apply(&mut store);
            store = serde_json::from_value(serde_json::to_value(&store).unwrap()).unwrap();
            assert_eq!(values(&store, false)["spawn_native_input"], enabled);
        }
        for invalid in [json!("true"), json!(null), json!(1)] {
            assert!(
                Change::read(json!({"spawn_native_input": invalid}).as_object().unwrap()).is_err()
            );
        }
    }
}

#[cfg(test)]
mod requester_approvals_tests {
    use super::*;

    fn set(store: &mut Store, change: Value) {
        Change::read(change.as_object().unwrap())
            .unwrap()
            .apply(store);
        *store = serde_json::from_value(serde_json::to_value(&*store).unwrap()).unwrap();
    }

    #[test]
    fn approvals_from_the_spawning_agent_are_on_in_dev_and_off_in_release_until_set() {
        let mut store = Store::default();
        assert_eq!(values(&store, true)["spawn_requester_approvals"], true);
        assert_eq!(values(&store, false)["spawn_requester_approvals"], false);
        assert!(requester_approvals(&store, true));
        assert!(!requester_approvals(&store, false));

        set(&mut store, json!({"spawn_requester_approvals": true}));
        assert!(
            requester_approvals(&store, false),
            "the person turned it on"
        );
        set(&mut store, json!({"spawn_requester_approvals": false}));
        assert!(
            !requester_approvals(&store, true),
            "the person turned it off"
        );
        assert_eq!(values(&store, true)["spawn_requester_approvals"], false);

        for invalid in [json!("true"), json!(null), json!(1)] {
            assert!(Change::read(
                json!({"spawn_requester_approvals": invalid})
                    .as_object()
                    .unwrap()
            )
            .is_err());
        }
    }

    #[test]
    fn approvals_never_outlive_native_input_from_the_spawning_agent() {
        let mut store = Store::default();
        set(
            &mut store,
            json!({"spawn_requester_approvals": true, "spawn_native_input": false}),
        );
        assert!(!requester_approvals(&store, true));
        assert!(!requester_approvals(&store, false));
        // The setting itself is kept, and counts again with native input.
        assert_eq!(values(&store, false)["spawn_requester_approvals"], true);
        set(&mut store, json!({"spawn_native_input": true}));
        assert!(requester_approvals(&store, false));
    }

    // A `settings.set` batch whose other write fails is put back: approvals
    // from the spawning agent must not stay on after the failed change.
    #[test]
    fn a_failed_change_puts_approvals_from_the_spawning_agent_back() {
        let previous = Store::default();
        let change = Change::read(
            json!({"spawn_requester_approvals": true})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        let mut written = previous.clone();
        change.apply(&mut written);
        let write = StoreWrite {
            previous: previous.clone(),
            written: written.clone(),
        };
        let mut store = written;
        assert!(change.restore(&mut store, &write));
        assert!(!requester_approvals(&store, false));
        assert_eq!(store.extras.spawn_requester_approvals, None);
    }
}
