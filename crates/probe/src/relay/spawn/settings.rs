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
pub const KEYS: [&str; 10] = [
    "accept_spawns",
    "spawn_full_access_codex",
    "spawn_full_access_claude",
    "spawn_allow_teammates",
    "spawn_native_input",
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

    /// Puts back, as `previous` had them, the fields [`Self::apply`] writes.
    fn restore(&self, store: &mut Store, previous: &Store) {
        if self.max_agents.is_some() {
            store.spawn_max_agents = previous.spawn_max_agents;
        }
        for (id, _) in &self.billing {
            store.set_spawn_harness(id.name(), previous.spawn_harness(id.name()));
        }
        if self.repositories.is_some() {
            store.spawn_repositories = previous.spawn_repositories.clone();
        }
    }
}

/// `settings.get`'s spawn values: whether spawns are accepted, each
/// harness's settings, whether teammates may spawn, and the rest of
/// `CONFIGURED_KEYS`.
pub fn values(store: &Store) -> Map<String, Value> {
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
        if self.allow_teammates.is_some() {
            store.spawn_allow_teammates = self.allow_teammates;
        }
        self.configured.apply(store);
    }

    /// Puts back, as `previous` had them, the fields [`Self::apply`] writes.
    fn restore(&self, store: &mut Store, previous: &Store) {
        if self.accept.is_some() {
            store.accept_spawns = previous.accept_spawns;
        }
        for (id, _) in &self.full_access {
            store.set_spawn_harness(id.name(), previous.spawn_harness(id.name()));
        }
        if self.native_input.is_some() {
            store.extras.spawn_native_input = previous.extras.spawn_native_input;
        }
        if self.allow_teammates.is_some() {
            store.spawn_allow_teammates = previous.spawn_allow_teammates;
        }
        self.configured.restore(store, previous);
    }

    /// Whether the spawn node must be brought in line with the change:
    /// teammates go out in a heartbeat at once, as the maximum does.
    fn moves_node(&self) -> bool {
        self.accept.is_some() || self.allow_teammates.is_some() || !self.configured.is_empty()
    }
}

impl Core {
    /// Saves the settings the store keeps among `changes` in one write:
    /// self-registration, auto-activation, relay messages, joining #general
    /// and spawning. The
    /// save refreshes `show_relay_messages` for the next delivery
    /// (`HandleState::saved`); a change to spawning then brings the spawn
    /// node in line.
    pub(crate) fn set_store_settings(&self, changes: &Map<String, Value>) -> Result<(), RpcError> {
        let spawn = Change::read(changes).map_err(RpcError::invalid_params)?;
        let change = |key: &str| changes.get(key).and_then(Value::as_bool);
        let flags = crate::relay::store_settings::STORE_SETTINGS.map(change);
        let [allow, auto, show, general, mobile_handoff, native_continuation, teammate_input] =
            flags;
        if native_continuation == Some(true) {
            self.require_native_continuation_claim().map_err(|message| {
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
        if flags.iter().any(Option::is_some) || !spawn.is_empty() {
            self.store
                .update(|store| {
                    store.allow_self_registration = allow.or(store.allow_self_registration);
                    store.auto_activate = auto.or(store.auto_activate);
                    store.mobile_claude_handoff = mobile_handoff.or(store.mobile_claude_handoff);
                    store.mobile_native_continuation = native_continuation.or(store.mobile_native_continuation);
                    store.show_relay_messages = show.or(store.show_relay_messages);
                    store.extras.auto_join_general = general.or(store.extras.auto_join_general);
                    store.extras.teammate_native_input =
                        teammate_input.or(store.extras.teammate_native_input);
                    spawn.apply(store);
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
        Ok(())
    }

    /// Puts the settings [`Self::set_store_settings`] saved from `changes`
    /// back as `previous` (the store before that save) had them, so a
    /// `settings.set` batch that then fails keeps none of its store changes.
    /// The hooks that follow those settings run again for the values put
    /// back; what a hook already did outside the store (a plugin installed,
    /// queued teammate messages cancelled) is not undone.
    pub(crate) fn restore_store_settings(
        &self,
        changes: &Map<String, Value>,
        previous: &Store,
    ) -> Result<(), RpcError> {
        let Ok(spawn) = Change::read(changes) else {
            return Ok(());
        };
        let changed = |key: &str| changes.get(key).and_then(Value::as_bool).is_some();
        let flags = crate::relay::store_settings::STORE_SETTINGS.map(changed);
        if !flags.contains(&true) && spawn.is_empty() {
            return Ok(());
        }
        let [allow, auto, show, general, mobile_handoff, native_continuation, teammate_input] =
            flags;
        self.store
            .update(|store| {
                if allow {
                    store.allow_self_registration = previous.allow_self_registration;
                }
                if auto {
                    store.auto_activate = previous.auto_activate;
                }
                if show {
                    store.show_relay_messages = previous.show_relay_messages;
                }
                if general {
                    store.extras.auto_join_general = previous.extras.auto_join_general;
                }
                if mobile_handoff {
                    store.mobile_claude_handoff = previous.mobile_claude_handoff;
                }
                if native_continuation {
                    store.mobile_native_continuation = previous.mobile_native_continuation;
                }
                if teammate_input {
                    store.extras.teammate_native_input = previous.extras.teammate_native_input;
                }
                spawn.restore(store, previous);
            })
            .map_err(|e| RpcError::store(&e))?;
        if mobile_handoff {
            let _ = self.mobile_claude_setting_changed(previous.mobile_claude_handoff_on());
        }
        if spawn.moves_node() {
            if let Some(core) = self.arc() {
                tokio::spawn(async move { core.sync_spawn_node().await });
            }
        }
        if native_continuation {
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
        assert_eq!(values(&store)["spawn_native_input"], true);
        for enabled in [false, true] {
            Change::read(json!({"spawn_native_input": enabled}).as_object().unwrap())
                .unwrap()
                .apply(&mut store);
            store = serde_json::from_value(serde_json::to_value(&store).unwrap()).unwrap();
            assert_eq!(values(&store)["spawn_native_input"], enabled);
        }
        for invalid in [json!("true"), json!(null), json!(1)] {
            assert!(
                Change::read(json!({"spawn_native_input": invalid}).as_object().unwrap()).is_err()
            );
        }
    }
}
