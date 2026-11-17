//! The organization's workspace policy over this computer's settings: the
//! hook a build's account uses to hand the core the settings an operator
//! locked or defaulted, and the rules the core applies to them.
//!
//! The account (in Agent Relay Desktop, `desktop-core`) reads the policy,
//! caches it and calls [`Core::apply_settings_policy`] whenever it changes.
//! The core then:
//!
//! - writes each **locked** value into the setting once, and refuses every
//!   later change to it, from the apps (`settings.set`) and from agents
//!   (`PATCH /settings`): "This setting is set by your organization.";
//! - writes each **default** once, as a starting value the person may
//!   change. A changed default is written again only while the person still
//!   has the previous one, so a choice the person made is never reversed;
//! - reports which settings are locked, defaulted or mismatched in
//!   `settings.get`'s read-only `organization_policy`.
//!
//! Only the person turns on a person-only setting (`settings_registry`). An
//! operator value that **widens** one (turns it on, or adds entries to its
//! list) applies, locked or default, only on a computer enrolled with the
//! organization's consent (`managed`) **and** when the operator named that
//! setting in `consent`. Otherwise the person's own value stays and the
//! setting is listed as mismatched. A value that **narrows** one (turns it
//! off, or keeps only some of its entries) applies on every computer.
//! `analytics_enabled` follows the same rule without a consent entry: off
//! applies everywhere, on only on a managed computer.
//!
//! A setting this computer does not have (its tool has not run here) is
//! skipped. A key the core does not know is ignored, as the policy says.

use crate::relay::contract::agents::OrganizationPolicyState;
use crate::relay::daemon::Core;
use crate::relay::protocol::RpcError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// The read-only `settings.get` record this module reports.
pub const SETTING: &str = "organization_policy";

/// The refusal of a change to a locked setting, and its label in Settings.
pub const LOCKED: &str = "This setting is set by your organization.";

/// The label in Settings of a setting the organization defaulted.
pub const DEFAULTED: &str = "Managed by your organization.";

/// The person-only settings the workspace policy names (its allowlist's
/// person-only column): an operator value that widens one needs the
/// computer's enrollment consent and a `consent` entry.
pub const PERSON_ONLY: [&str; 7] = [
    "accept_spawns",
    "spawn_allow_teammates",
    "spawn_full_access_claude",
    "spawn_full_access_codex",
    "spawn_native_input",
    "spawn_repositories",
    "spawn_requester_approvals",
];

/// Turned on by an operator only on a managed computer; turned off on any.
const ANALYTICS: &str = "analytics_enabled";

/// The settings part of an organization's workspace policy, as the account
/// hands it over: every section's tiers merged by key.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SettingsPolicy {
    /// Operator values the person cannot change.
    #[serde(default)]
    pub locked: Map<String, Value>,
    /// Operator starting values the person may change.
    #[serde(default)]
    pub defaults: Map<String, Value>,
    /// This computer was enrolled with the organization's consent.
    #[serde(default)]
    pub managed: bool,
    /// The person-only settings the operator consents to widen on managed
    /// computers.
    #[serde(default)]
    pub consent: BTreeSet<String>,
}

/// What the store keeps: the policy and the defaults it already wrote.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stored {
    pub policy: SettingsPolicy,
    /// Each defaulted setting with the default last written into it.
    #[serde(default, rename = "appliedDefaults")]
    pub applied_defaults: Map<String, Value>,
}

/// Whether `value` turns on or adds to `key` beyond `current`.
fn widens(value: &Value, current: Option<&Value>) -> bool {
    match value {
        Value::Bool(on) => *on,
        Value::Array(entries) => {
            let held: Vec<&Value> = match current {
                Some(Value::Array(held)) => held.iter().collect(),
                _ => Vec::new(),
            };
            entries.iter().any(|entry| !held.contains(&entry))
        }
        _ => false,
    }
}

impl SettingsPolicy {
    /// Whether the operator's `value` for `key` may apply on this computer,
    /// given the setting's `current` value.
    pub fn may_apply(&self, key: &str, value: &Value, current: Option<&Value>) -> bool {
        if key == ANALYTICS {
            return value != &Value::Bool(true) || self.managed;
        }
        if PERSON_ONLY.contains(&key) && widens(value, current) {
            return self.managed && self.consent.contains(key);
        }
        true
    }

    /// The locked settings in force, given the current `values`.
    fn locks<'a>(
        &'a self,
        values: &'a Map<String, Value>,
    ) -> impl Iterator<Item = (&'a String, &'a Value)> + 'a {
        self.locked.iter().filter(move |(key, value)| {
            values.contains_key(key.as_str())
                && self.may_apply(key, value, values.get(key.as_str()))
        })
    }

    /// The labels for each setting this computer has, given its `values`.
    pub fn state(&self, values: &Map<String, Value>) -> OrganizationPolicyState {
        let mut state = OrganizationPolicyState {
            managed: self.managed,
            ..OrganizationPolicyState::default()
        };
        for (tier, locked) in [(&self.locked, true), (&self.defaults, false)] {
            for (key, value) in tier {
                if !values.contains_key(key) || (!locked && self.locked.contains_key(key)) {
                    continue;
                }
                let list = if !self.may_apply(key, value, values.get(key)) {
                    &mut state.mismatched
                } else if locked {
                    &mut state.locked
                } else {
                    &mut state.defaults
                };
                list.push(key.clone());
            }
        }
        state
    }

    /// The first change among `changes` that a lock refuses: a locked
    /// setting given any value but its locked one.
    pub fn refusal(
        &self,
        values: &Map<String, Value>,
        changes: &Map<String, Value>,
    ) -> Option<RpcError> {
        self.locks(values)
            .find(|(key, value)| {
                changes
                    .get(key.as_str())
                    .is_some_and(|change| change != *value)
            })
            .map(|_| RpcError::setting_refused(LOCKED.to_string()))
    }
}

/// The writes `policy` makes to settings now at `values`, after defaults
/// already written (`applied`), and the defaults record to keep.
fn plan(
    policy: &SettingsPolicy,
    values: &Map<String, Value>,
    applied: &Map<String, Value>,
) -> (Map<String, Value>, Map<String, Value>) {
    let mut writes = Map::new();
    for (key, value) in policy.locks(values) {
        if values.get(key) != Some(value) {
            writes.insert(key.clone(), value.clone());
        }
    }
    let mut record = Map::new();
    for (key, value) in &policy.defaults {
        if policy.locked.contains_key(key) || !values.contains_key(key) {
            continue;
        }
        let current = values.get(key);
        let previous = applied.get(key);
        let untouched = previous.is_none() || current == previous;
        if untouched && policy.may_apply(key, value, current) {
            if current != Some(value) {
                writes.insert(key.clone(), value.clone());
            }
            record.insert(key.clone(), value.clone());
        } else if let Some(previous) = previous {
            // The person changed it, or it waits for consent: the default
            // written before stays the one to compare with.
            record.insert(key.clone(), previous.clone());
        }
    }
    (writes, record)
}

impl Core {
    /// The organization's policy over settings, when one applies.
    pub fn settings_policy(&self) -> Option<SettingsPolicy> {
        self.store
            .read(|store| store.organization_policy.as_ref().map(|s| s.policy.clone()))
    }

    /// Applies the organization's settings policy (`None`: none applies any
    /// more, and the settings keep their values for the person to change).
    /// Locked values and new defaults are written now, each on its own, so
    /// one a tool refuses does not keep the others from applying; the apps
    /// are told to read Settings again.
    pub fn apply_settings_policy(&self, policy: Option<SettingsPolicy>) -> Result<(), RpcError> {
        let _writing = crate::relay::settings_registry::writing();
        let Some(policy) = policy else {
            let cleared = self
                .store
                .update(|store| store.organization_policy.take().is_some());
            if cleared.map_err(|e| RpcError::store(&e))? {
                self.hub()
                    .invalidated(crate::relay::state::Listing::Settings);
            }
            return Ok(());
        };
        let applied = self
            .store
            .read(|store| {
                store
                    .organization_policy
                    .as_ref()
                    .map(|s| s.applied_defaults.clone())
            })
            .unwrap_or_default();
        let values = self.settings();
        let (writes, record) = plan(&policy, &values, &applied);
        for (key, value) in writes {
            let change = Map::from_iter([(key.clone(), value)]);
            if let Err(error) = self.write_settings(&change) {
                crate::relay::diagnostics::write(format_args!(
                    "relay: the organization's value for {key} was not applied: {}",
                    error.message
                ));
            }
        }
        self.store
            .update(|store| {
                store.organization_policy = Some(Stored {
                    policy,
                    applied_defaults: record,
                });
            })
            .map_err(|e| RpcError::store(&e))?;
        self.hub()
            .invalidated(crate::relay::state::Listing::Settings);
        Ok(())
    }

    /// `settings.get`'s `organization_policy`, for `values`.
    pub(crate) fn settings_policy_state(&self, values: &Map<String, Value>) -> Option<Value> {
        let policy = self.settings_policy()?;
        serde_json::to_value(policy.state(values)).ok()
    }

    /// The refusal of `changes` a lock makes, for settings now at `values`.
    pub(crate) fn settings_policy_refusal(
        &self,
        values: &Map<String, Value>,
        changes: &Map<String, Value>,
    ) -> Option<RpcError> {
        self.settings_policy()?.refusal(values, changes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn policy(value: Value) -> SettingsPolicy {
        serde_json::from_value(value).unwrap()
    }

    /// Every person-only setting the policy names is one the core keeps
    /// for the person to turn on or add to.
    #[test]
    fn the_policy_person_only_settings_are_the_cores() {
        use crate::relay::settings_registry::{PERSON_ADDS, PERSON_TURNS_ON};
        for key in PERSON_ONLY {
            assert!(
                PERSON_TURNS_ON.contains(&key) || PERSON_ADDS.contains(&key),
                "{key}"
            );
        }
    }

    #[test]
    fn a_widening_lock_needs_managed_and_consent() {
        let values = map(json!({"accept_spawns": false}));
        let locked = json!({"locked": {"accept_spawns": true}});
        let unmanaged = policy(locked.clone());
        assert!(!unmanaged.may_apply("accept_spawns", &json!(true), values.get("accept_spawns")));
        let mut managed = policy(locked);
        managed.managed = true;
        assert!(!managed.may_apply("accept_spawns", &json!(true), None));
        managed.consent.insert("accept_spawns".into());
        assert!(managed.may_apply("accept_spawns", &json!(true), None));
        let state = unmanaged.state(&values);
        assert_eq!(state.mismatched, vec!["accept_spawns"]);
        assert!(state.locked.is_empty());
        assert_eq!(managed.state(&values).locked, vec!["accept_spawns"]);
    }

    #[test]
    fn a_narrowing_lock_applies_on_every_computer() {
        let values = map(json!({"accept_spawns": true, "spawn_repositories": ["a/b", "c/d"]}));
        let p = policy(json!({"locked": {"accept_spawns": false, "spawn_repositories": ["a/b"]}}));
        let state = p.state(&values);
        assert_eq!(state.locked, vec!["accept_spawns", "spawn_repositories"]);
        let (writes, _) = plan(&p, &values, &Map::new());
        assert_eq!(
            writes,
            map(json!({"accept_spawns": false, "spawn_repositories": ["a/b"]}))
        );
        // A list adding an entry widens it.
        let wider = policy(json!({"locked": {"spawn_repositories": ["a/b", "e/f"]}}));
        assert_eq!(wider.state(&values).mismatched, vec!["spawn_repositories"]);
        assert!(plan(&wider, &values, &Map::new()).0.is_empty());
    }

    #[test]
    fn analytics_off_applies_everywhere_and_on_only_when_managed() {
        let values = map(json!({"analytics_enabled": false}));
        let on = policy(json!({"locked": {"analytics_enabled": true}}));
        assert_eq!(on.state(&values).mismatched, vec!["analytics_enabled"]);
        let mut managed = on.clone();
        managed.managed = true;
        assert_eq!(managed.state(&values).locked, vec!["analytics_enabled"]);
        let off = policy(json!({"locked": {"analytics_enabled": false}}));
        assert_eq!(off.state(&values).locked, vec!["analytics_enabled"]);
    }

    #[test]
    fn a_setting_that_is_not_settings_is_ignored() {
        let values = map(json!({"spawn_max_agents": 8}));
        let p =
            policy(json!({"locked": {"auto_join_repositories": ["a/*"], "spawn_max_agents": 4}}));
        assert_eq!(p.state(&values).locked, vec!["spawn_max_agents"]);
        assert_eq!(
            plan(&p, &values, &Map::new()).0,
            map(json!({"spawn_max_agents": 4}))
        );
    }

    #[test]
    fn a_lock_refuses_any_other_value() {
        let values = map(json!({"spawn_max_agents": 4, "auto_join_general": true}));
        let p = policy(json!({"locked": {"spawn_max_agents": 4}}));
        let refused = p
            .refusal(&values, &map(json!({"spawn_max_agents": 6})))
            .unwrap();
        assert_eq!(refused.message, LOCKED);
        assert!(p
            .refusal(&values, &map(json!({"spawn_max_agents": 4})))
            .is_none());
        assert!(p
            .refusal(&values, &map(json!({"auto_join_general": false})))
            .is_none());
    }

    #[test]
    fn a_default_is_written_once_and_never_over_the_persons_choice() {
        let p = policy(json!({"defaults": {"auto_join_general": true}}));
        let values = map(json!({"auto_join_general": false}));
        let (writes, record) = plan(&p, &values, &Map::new());
        assert_eq!(writes, map(json!({"auto_join_general": true})));
        assert_eq!(record, map(json!({"auto_join_general": true})));
        // The person turned it off again: the default stays written once.
        let (writes, record) = plan(&p, &values, &record);
        assert!(writes.is_empty());
        assert_eq!(record, map(json!({"auto_join_general": true})));
        // A changed default follows only while the person has the old one.
        let changed = policy(json!({"defaults": {"spawn_max_agents": 2}}));
        let values = map(json!({"spawn_max_agents": 4}));
        let applied = map(json!({"spawn_max_agents": 4}));
        assert_eq!(
            plan(&changed, &values, &applied).0,
            map(json!({"spawn_max_agents": 2}))
        );
        let chosen = map(json!({"spawn_max_agents": 6}));
        assert!(plan(&changed, &chosen, &applied).0.is_empty());
        assert_eq!(changed.state(&values).defaults, vec!["spawn_max_agents"]);
    }

    #[test]
    fn a_widening_default_waits_for_consent() {
        let values = map(json!({"spawn_allow_teammates": false}));
        let p = policy(json!({"defaults": {"spawn_allow_teammates": true}}));
        assert!(plan(&p, &values, &Map::new()).0.is_empty());
        assert_eq!(p.state(&values).mismatched, vec!["spawn_allow_teammates"]);
        let mut consented = p;
        consented.managed = true;
        consented.consent.insert("spawn_allow_teammates".into());
        assert_eq!(
            plan(&consented, &values, &Map::new()).0,
            map(json!({"spawn_allow_teammates": true}))
        );
    }
}
