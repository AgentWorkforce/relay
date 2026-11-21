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
use std::collections::{BTreeMap, BTreeSet};

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

/// The delivery section's rule for messages from non-admin senders.
const INBOUND: &str = "inbound_default";

/// The organization's admins, by relay name and address, as Control serves
/// them: their messages always deliver.
const ADMIN_SENDERS: &str = "admin_senders";

/// Whether an `inbound_default` value holds (`hold`) or delivers
/// (`deliver`); `None` for any other value.
fn inbound_holds(value: &Value) -> Option<bool> {
    match value.as_str()? {
        "hold" => Some(true),
        "deliver" => Some(false),
        _ => None,
    }
}

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
    /// The policy in force; `None` once it was lifted, while the defaults'
    /// history below is kept.
    #[serde(default)]
    pub policy: Option<SettingsPolicy>,
    /// Each setting a default was written into, kept after the default is
    /// dropped from the policy, so a default added again later still sees a
    /// choice the person made since.
    #[serde(default, rename = "appliedDefaults")]
    pub applied_defaults: BTreeMap<String, AppliedDefault>,
}

/// One default the policy wrote into a setting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedDefault {
    /// The value the policy gave.
    pub given: Value,
    /// The value the setting read just after it was written, which can be
    /// the given one normalized (a list lower-cased) or completed (a part of
    /// a structured setting): the person changed it once it reads otherwise.
    pub applied: Value,
}

/// The settings a change sets under another name: a harness's part of
/// `spawn_harnesses` is also its flat `spawn_full_access_*` and
/// `spawn_billing_*` setting, so a lock on either name holds for both.
fn effective(changes: &Map<String, Value>) -> Map<String, Value> {
    let mut effective = changes.clone();
    if let Some(Value::Object(harnesses)) = changes.get("spawn_harnesses") {
        for (harness, change) in harnesses {
            if !FLAT_HARNESSES.contains(&harness.as_str()) {
                continue;
            }
            for (part, flat) in [
                ("full_access", "spawn_full_access_"),
                ("billing", "spawn_billing_"),
            ] {
                if let Some(value) = change.get(part) {
                    effective.insert(format!("{flat}{harness}"), value.clone());
                }
            }
        }
    }
    effective
}

/// The harnesses whose `spawn_harnesses` part also has a flat setting, the
/// only per-harness spawn settings the workspace policy names.
const FLAT_HARNESSES: [&str; 2] = ["claude", "codex"];

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
    /// The policy with Claude's and Codex's part of a `spawn_harnesses`
    /// value put under its flat name (`spawn_full_access_<harness>`,
    /// `spawn_billing_<harness>`), so the consent rule for person-only
    /// settings sees it. The nested value itself is dropped: the workspace
    /// policy names no other harness's spawn settings, and a key the policy
    /// does not name is ignored, as any unknown key is.
    pub fn flattened(mut self) -> SettingsPolicy {
        for tier in [&mut self.locked, &mut self.defaults] {
            if let Some(nested) = tier.remove("spawn_harnesses") {
                let flat = effective(&Map::from_iter([("spawn_harnesses".to_string(), nested)]));
                for (key, value) in flat {
                    if key != "spawn_harnesses" {
                        tier.entry(key).or_insert(value);
                    }
                }
            }
        }
        self
    }

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
        let changes = effective(changes);
        self.locks(values)
            .find(|(key, value)| {
                changes
                    .get(key.as_str())
                    .is_some_and(|change| change != *value)
            })
            .map(|_| RpcError::setting_refused(LOCKED.to_string()))
    }
}

/// A default to put in a setting: its key, the policy's value, and whether
/// the setting needs a write (it may already hold the value).
type DefaultWrite = (String, Value, bool);

/// What `policy` writes into settings now at `values`: the locked values
/// that differ, and the defaults to write (with whether a write is needed),
/// given the defaults already written (`applied`). A default is written once
/// while the setting still reads as the policy last left it, so the person's
/// own choice is never reversed; the same default is never written twice.
fn plan(
    policy: &SettingsPolicy,
    values: &Map<String, Value>,
    applied: &BTreeMap<String, AppliedDefault>,
) -> (Map<String, Value>, Vec<DefaultWrite>) {
    let mut locks = Map::new();
    for (key, value) in policy.locks(values) {
        if values.get(key) != Some(value) {
            locks.insert(key.clone(), value.clone());
        }
    }
    let mut defaults = Vec::new();
    for (key, value) in &policy.defaults {
        if policy.locked.contains_key(key) || !values.contains_key(key) {
            continue;
        }
        let current = values.get(key);
        let previous = applied.get(key);
        let untouched = previous.is_none_or(|previous| current == Some(&previous.applied));
        let already = previous.is_some_and(|previous| &previous.given == value);
        if untouched && !already && policy.may_apply(key, value, current) {
            defaults.push((key.clone(), value.clone(), current != Some(value)));
        }
    }
    (locks, defaults)
}

/// The organization's locked values put back into the store fields that
/// hold them, after a merge of two processes' saves: a save made before
/// the lock arrived must not leave a locked setting at another value next to
/// the lock. Only the store-held settings the workspace policy names are
/// rewritten (spawning, joining #general), under the same consent rule as
/// any apply; the next apply corrects the rest.
pub(crate) fn relock(store: &mut crate::relay::store::Store) {
    let Some(policy) = store
        .organization_policy
        .as_ref()
        .and_then(|stored| stored.policy.clone())
    else {
        return;
    };
    let mut current = crate::relay::spawn::settings::values(store, false);
    current.insert(GENERAL.into(), Value::Bool(store.auto_joins_general()));
    current.insert(
        ESCALATION.into(),
        Value::from(if crate::relay::question::settings::on(store) {
            "on"
        } else {
            "off"
        }),
    );
    let mut changes = Map::new();
    for (key, value) in &policy.locked {
        // Question escalation is store-held too, and read by the spawn
        // settings' `Change` (`question::settings::Change`).
        let held = crate::relay::spawn::settings::KEYS.contains(&key.as_str())
            || key == GENERAL
            || key == ESCALATION;
        if held && current.get(key) != Some(value) && policy.may_apply(key, value, current.get(key))
        {
            changes.insert(key.clone(), value.clone());
        }
    }
    // The repositories list is held as its saved (normalized) form.
    if let Some(list) = crate::relay::repositories::locked_list(&policy) {
        let list = (!list.is_empty()).then_some(list);
        if store.auto_join_repositories != list {
            store.auto_join_repositories = list;
        }
    }
    // Each lock on its own, as an apply writes them: one value the store
    // cannot take does not keep the others from holding.
    for (key, value) in changes {
        if key == GENERAL {
            if let Value::Bool(general) = value {
                store.extras.auto_join_general = Some(general);
            }
            continue;
        }
        let change = Map::from_iter([(key, value)]);
        if let Ok(change) = crate::relay::spawn::settings::Change::read(&change) {
            change.apply(store);
        }
    }
}

/// The store-held `auto_join_general` setting.
const GENERAL: &str = "auto_join_general";

/// The store-held `question_escalation` setting.
const ESCALATION: &str = crate::relay::question::settings::ESCALATION;

/// Question escalation reads on unless turned off, where an unset flag once
/// read off. A store from before that keeps what its organization decided:
/// an unset flag under a stored lock of off, or under a stored default of
/// off the person still has (`appliedDefaults` records off as applied), is
/// written off as it is read. Whether the change is written back is the
/// decoder's (`Store::decode`). Nothing else changes: the person's own
/// choice, no policy or a lifted one, and a default of on.
pub(crate) fn keep_question_escalation_off(store: &mut crate::relay::store::Store) {
    if store.extras.question_escalation.is_some() {
        return;
    }
    let Some(stored) = store.organization_policy.as_ref() else {
        return;
    };
    let Some(policy) = stored.policy.as_ref() else {
        return;
    };
    let off = Value::from("off");
    let locked = policy.locked.get(ESCALATION) == Some(&off);
    let defaulted = !policy.locked.contains_key(ESCALATION)
        && policy.defaults.get(ESCALATION) == Some(&off)
        && stored
            .applied_defaults
            .get(ESCALATION)
            .is_some_and(|applied| applied.applied == off);
    if locked || defaulted {
        store.extras.question_escalation = Some(false);
    }
}

impl Core {
    /// The organization's policy over settings, when one applies.
    pub fn settings_policy(&self) -> Option<SettingsPolicy> {
        self.store.read(|store| {
            store
                .organization_policy
                .as_ref()
                .and_then(|s| s.policy.clone())
        })
    }

    /// Applies the organization's settings policy (`None`: none applies any
    /// more, and the settings keep their values for the person to change).
    /// Locked values and new defaults are written now, each on its own, so
    /// one a tool refuses does not keep the others from applying; the apps
    /// are told to read Settings again.
    pub fn apply_settings_policy(&self, policy: Option<SettingsPolicy>) -> Result<(), RpcError> {
        let _writing = crate::relay::settings_registry::writing();
        let policy = policy.map(SettingsPolicy::flattened);
        let Some(policy) = policy else {
            // The defaults' history stays, so a policy given later still
            // sees the choices the person made under this one.
            let cleared = self.store.update(|store| {
                store
                    .organization_policy
                    .as_mut()
                    .and_then(|stored| stored.policy.take())
                    .is_some()
            });
            // The hold is lifted only once the policy's removal is saved: a
            // failed save keeps both, as the caller is told.
            let cleared = cleared.map_err(|e| RpcError::store(&e))?;
            self.sync_organization_hold_with(None);
            if cleared {
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
        // The incoming policy is stored before anything is written: every
        // save merges with the file and re-applies the stored locks
        // (`relock`), which must be this policy's, not the one it replaces.
        self.store
            .update(|store| {
                store.organization_policy = Some(Stored {
                    policy: Some(policy.clone()),
                    applied_defaults: applied.clone(),
                });
            })
            .map_err(|e| RpcError::store(&e))?;
        let values = self.settings();
        let (locks, defaults) = plan(&policy, &values, &applied);
        for (key, value) in locks {
            self.write_policy_value(&key, value);
        }
        // A default is recorded only once it is in the setting, as the
        // setting then reads, so a failed write is tried again next time.
        let mut record = applied;
        self.apply_inbound_policy(&policy, &mut record);
        for (key, value, write) in defaults {
            if write && !self.write_policy_value(&key, value.clone()) {
                continue;
            }
            if let Some(now) = self.settings().get(&key).cloned() {
                record.insert(
                    key,
                    AppliedDefault {
                        given: value,
                        applied: now,
                    },
                );
            }
        }
        self.store
            .update(|store| {
                store.organization_policy = Some(Stored {
                    policy: Some(policy),
                    applied_defaults: record,
                });
            })
            .map_err(|e| RpcError::store(&e))?;
        self.hub()
            .invalidated(crate::relay::state::Listing::Settings);
        Ok(())
    }

    /// Writes the organization's `value` into `key`, past its locks;
    /// answers whether it was written. A failure is logged and tried again
    /// on the next apply.
    fn write_policy_value(&self, key: &str, value: Value) -> bool {
        let change = Map::from_iter([(key.to_string(), value)]);
        match self.write_settings(&change) {
            Ok(_) => true,
            Err(error) => {
                crate::relay::diagnostics::write(format_args!(
                    "relay: the organization's value for {key} was not applied: {}",
                    error.message
                ));
                false
            }
        }
    }

    /// Whether the organization's policy locks `key`, which a default pass
    /// of its own (`apply_integration_defaults`) then leaves alone.
    pub(crate) fn locked_by_organization(&self, key: &str) -> bool {
        self.settings_policy()
            .is_some_and(|policy| policy.locked.contains_key(key))
    }

    /// The delivery section: a locked `inbound_default: "hold"` holds every
    /// message from a sender not in `admin_senders`, in every harness
    /// (`claude_delivery_policy`); defaulted, it seeds the person's own
    /// known-senders-only restriction once, as any default is written.
    fn apply_inbound_policy(
        &self,
        policy: &SettingsPolicy,
        record: &mut BTreeMap<String, AppliedDefault>,
    ) {
        // The person's restriction is put in place before the organization's
        // hold changes, so a delivery decided in between is held by one or
        // the other, never by neither.
        if !policy.locked.contains_key(INBOUND) {
            self.seed_inbound_default(policy, record);
        }
        self.sync_organization_hold_with(Some(policy));
    }

    /// A defaulted `inbound_default`, written once into the person's own
    /// restriction like any default.
    fn seed_inbound_default(
        &self,
        policy: &SettingsPolicy,
        record: &mut BTreeMap<String, AppliedDefault>,
    ) {
        let Some(hold) = policy.defaults.get(INBOUND).and_then(inbound_holds) else {
            return;
        };
        let given = policy.defaults[INBOUND].clone();
        let current = Value::Bool(self.claude_delivery.restricted());
        let previous = record.get(INBOUND);
        let untouched = previous.is_none_or(|previous| previous.applied == current);
        let already = previous.is_some_and(|previous| previous.given == given);
        if !untouched || already {
            return;
        }
        if current != Value::Bool(hold) {
            if let Err(error) = self.set_claude_delivery_restricted(hold) {
                crate::relay::diagnostics::write(format_args!(
                    "relay: the organization's value for {INBOUND} was not applied: {}",
                    error.message
                ));
                return;
            }
        }
        record.insert(
            INBOUND.into(),
            AppliedDefault {
                given,
                applied: Value::Bool(self.claude_delivery.restricted()),
            },
        );
    }

    /// Gives the delivery policy the organization's hold from the stored
    /// policy: at startup, before the account reads the policy again.
    pub(crate) fn sync_organization_hold(&self) {
        let policy = self.settings_policy();
        self.sync_organization_hold_with(policy.as_ref());
    }

    fn sync_organization_hold_with(&self, policy: Option<&SettingsPolicy>) {
        let admins = policy.and_then(|policy| {
            let holds = policy.locked.get(INBOUND).and_then(inbound_holds) == Some(true);
            holds.then(|| {
                policy
                    .locked
                    .get(ADMIN_SENDERS)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<BTreeSet<String>>()
            })
        });
        if self.set_organization_hold(admins) {
            // Held or released messages are read again under the new rule.
            let names = self.store.read(|store| {
                store
                    .registrations
                    .iter()
                    .map(|registration| registration.name.clone())
                    .collect::<Vec<_>>()
            });
            for name in names {
                self.request_drain(&name);
            }
        }
    }

    /// Sets the organization's hold under the delivery lock, which a channel
    /// batch's final hold check and pin save also hold: a hold either
    /// arrives before that check, which sees it, or after the pin is saved,
    /// when the batch is already handed over. Lock order: delivery, then the
    /// hold. Answers whether the hold changed.
    pub(crate) fn set_organization_hold(&self, admins: Option<BTreeSet<String>>) -> bool {
        let _pins = self.delivery_state();
        self.claude_delivery.set_organization_hold(admins)
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
        let (writes, _) = plan(&p, &values, &BTreeMap::new());
        assert_eq!(
            writes,
            map(json!({"accept_spawns": false, "spawn_repositories": ["a/b"]}))
        );
        // A list adding an entry widens it.
        let wider = policy(json!({"locked": {"spawn_repositories": ["a/b", "e/f"]}}));
        assert_eq!(wider.state(&values).mismatched, vec!["spawn_repositories"]);
        assert!(plan(&wider, &values, &BTreeMap::new()).0.is_empty());
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
            plan(&p, &values, &BTreeMap::new()).0,
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

    fn applied(key: &str, given: Value, now: Value) -> BTreeMap<String, AppliedDefault> {
        BTreeMap::from([(
            key.to_string(),
            AppliedDefault {
                given,
                applied: now,
            },
        )])
    }

    #[test]
    fn a_default_is_written_once_and_never_over_the_persons_choice() {
        let p = policy(json!({"defaults": {"auto_join_general": true}}));
        let values = map(json!({"auto_join_general": false}));
        let (_, defaults) = plan(&p, &values, &BTreeMap::new());
        assert_eq!(
            defaults,
            vec![("auto_join_general".into(), json!(true), true)]
        );
        // Written once: the person turned it off again, and it stays off.
        let record = applied("auto_join_general", json!(true), json!(true));
        assert!(plan(&p, &values, &record).1.is_empty());
        // A changed default follows only while the person has the old one.
        let changed = policy(json!({"defaults": {"spawn_max_agents": 2}}));
        let values = map(json!({"spawn_max_agents": 4}));
        let record = applied("spawn_max_agents", json!(4), json!(4));
        assert_eq!(
            plan(&changed, &values, &record).1,
            vec![("spawn_max_agents".into(), json!(2), true)]
        );
        let chosen = map(json!({"spawn_max_agents": 6}));
        assert!(plan(&changed, &chosen, &record).1.is_empty());
        assert_eq!(changed.state(&values).defaults, vec!["spawn_max_agents"]);
    }

    /// The setting's own reading of a default (normalized, or completed) is
    /// what the person is compared with, so an untouched setting keeps
    /// following the policy.
    #[test]
    fn a_normalized_default_still_follows_the_policy() {
        let first = policy(json!({"defaults": {"auto_join_repositories": ["Acme/Web"]}}));
        let values = map(json!({"auto_join_repositories": ["acme/web"]}));
        let record = applied(
            "auto_join_repositories",
            json!(["Acme/Web"]),
            json!(["acme/web"]),
        );
        assert!(plan(&first, &values, &record).1.is_empty());
        let next = policy(json!({"defaults": {"auto_join_repositories": ["acme/api"]}}));
        assert_eq!(
            plan(&next, &values, &record).1,
            vec![("auto_join_repositories".into(), json!(["acme/api"]), true)]
        );
    }

    #[test]
    fn a_widening_default_waits_for_consent() {
        let values = map(json!({"spawn_allow_teammates": false}));
        let p = policy(json!({"defaults": {"spawn_allow_teammates": true}}));
        assert!(plan(&p, &values, &BTreeMap::new()).1.is_empty());
        assert_eq!(p.state(&values).mismatched, vec!["spawn_allow_teammates"]);
        let mut consented = p;
        consented.managed = true;
        consented.consent.insert("spawn_allow_teammates".into());
        assert_eq!(
            plan(&consented, &values, &BTreeMap::new()).1,
            vec![("spawn_allow_teammates".into(), json!(true), true)]
        );
    }

    /// A policy's nested `spawn_harnesses` part is judged under its flat
    /// name, so the consent rule for full access holds.
    #[test]
    fn a_nested_policy_value_is_judged_under_its_flat_name() {
        let p = policy(json!({
            "locked": {"spawn_harnesses": {"codex": {"full_access": true, "billing": "api"}}},
        }))
        .flattened();
        assert!(p.locked.get("spawn_harnesses").is_none());
        assert_eq!(p.locked["spawn_full_access_codex"], json!(true));
        assert_eq!(p.locked["spawn_billing_codex"], json!("api"));
        // Other harnesses have no policy setting: their part is not one.
        let other = policy(json!({
            "locked": {"spawn_harnesses": {"opencode": {"full_access": false}}},
        }))
        .flattened();
        assert!(other.locked.is_empty());
        let values =
            map(json!({"spawn_full_access_codex": false, "spawn_billing_codex": "subscription"}));
        let state = p.state(&values);
        assert_eq!(state.mismatched, vec!["spawn_full_access_codex"]);
        assert_eq!(state.locked, vec!["spawn_billing_codex"]);
    }

    /// Two processes save at once, one before a lock arrived: the merged
    /// store keeps the lock and the locked value together.
    #[test]
    fn a_merge_keeps_a_locked_value_with_its_lock() {
        use crate::relay::store::Store;
        let base = Store {
            spawn_max_agents: Some(8),
            ..Store::default()
        };
        // A process that has not seen the lock changes the cap.
        let mut ours = base.clone();
        ours.spawn_max_agents = Some(6);
        ours.extras.auto_join_general = Some(true);
        // Another installs a lock of 4 and saves it.
        let mut theirs = base.clone();
        theirs.organization_policy = Some(Stored {
            policy: Some(policy(json!({
                "locked": {"spawn_max_agents": 4, "auto_join_general": false, "accept_spawns": true},
            }))),
            applied_defaults: BTreeMap::new(),
        });
        theirs.spawn_max_agents = Some(4);
        let merged = Store::merged(&base, &ours, &theirs);
        assert!(merged.organization_policy.is_some());
        assert_eq!(merged.spawn_max_agents, Some(4));
        assert_eq!(merged.extras.auto_join_general, Some(false));
        // A widening person-only lock is not forced on an unmanaged computer.
        assert_ne!(merged.accept_spawns, Some(true));
        // The other writer order keeps them together too.
        // A stale save of the repositories list gives way to the lock.
        let mut stale = base.clone();
        stale.auto_join_repositories = Some(vec!["me/fork".into()]);
        let mut repos = base.clone();
        repos.organization_policy = Some(Stored {
            policy: Some(policy(
                json!({"locked": {"auto_join_repositories": ["Acme/*"]}}),
            )),
            applied_defaults: BTreeMap::new(),
        });
        let merged = Store::merged(&base, &stale, &repos);
        assert_eq!(
            merged.auto_join_repositories,
            Some(vec!["acme/*".to_string()])
        );
        let reversed = Store::merged(&base, &theirs, &ours);
        assert_eq!(reversed.spawn_max_agents, Some(4));
        assert_eq!(reversed.extras.auto_join_general, Some(false));
        // Once the lock is lifted, the merge keeps each side's own value.
        let mut lifted = theirs.clone();
        if let Some(stored) = lifted.organization_policy.as_mut() {
            stored.policy = None;
        }
        let merged = Store::merged(&base, &ours, &lifted);
        assert_eq!(merged.spawn_max_agents, Some(6));
    }

    /// A save made under a newer policy keeps its values when it merges
    /// with a store still holding the older lock.
    #[test]
    fn a_merge_follows_the_newer_policy() {
        use crate::relay::store::Store;
        let mut base = Store::default();
        base.organization_policy = Some(Stored {
            policy: Some(policy(json!({"locked": {"spawn_max_agents": 4}}))),
            applied_defaults: BTreeMap::new(),
        });
        base.spawn_max_agents = Some(4);
        let mut newer = base.clone();
        newer.organization_policy = Some(Stored {
            policy: Some(policy(json!({"defaults": {"spawn_max_agents": 2}}))),
            applied_defaults: BTreeMap::new(),
        });
        newer.spawn_max_agents = Some(2);
        assert_eq!(
            Store::merged(&base, &newer, &base).spawn_max_agents,
            Some(2)
        );
        assert_eq!(
            Store::merged(&base, &base, &newer).spawn_max_agents,
            Some(2)
        );
    }

    /// A lock on question escalation holds through a merge with a save
    /// made before the lock arrived, as the store-held spawn settings do.
    #[test]
    fn a_question_escalation_lock_holds_through_a_merge() {
        use crate::relay::store::Store;
        let mut base = Store {
            organization_policy: Some(Stored {
                policy: Some(policy(json!({"locked": {"question_escalation": "off"}}))),
                applied_defaults: BTreeMap::new(),
            }),
            ..Store::default()
        };
        base.extras.question_escalation = Some(false);
        let mut stale = Store::default();
        stale.extras.question_escalation = Some(true);
        assert_eq!(
            Store::merged(&Store::default(), &stale, &base)
                .extras
                .question_escalation,
            Some(false)
        );
    }

    /// One locked value the store cannot take does not keep the other locks
    /// from holding after a merge.
    #[test]
    fn a_malformed_lock_does_not_undo_the_others() {
        use crate::relay::store::Store;
        let base = Store::default();
        let mut stale = base.clone();
        stale.accept_spawns = Some(true);
        let mut locking = base.clone();
        locking.organization_policy = Some(Stored {
            policy: Some(policy(json!({
                "locked": {"accept_spawns": false, "spawn_max_agents": "invalid"},
            }))),
            applied_defaults: BTreeMap::new(),
        });
        locking.accept_spawns = Some(false);
        let merged = Store::merged(&base, &stale, &locking);
        assert_eq!(merged.accept_spawns, Some(false));
    }

    /// A harness's part of `spawn_harnesses` is the same setting as its flat
    /// name, so a lock on one refuses the other.
    #[test]
    fn a_lock_holds_under_the_settings_other_name() {
        let values = map(json!({"spawn_full_access_codex": false, "spawn_billing_claude": "api"}));
        let p = policy(
            json!({"locked": {"spawn_full_access_codex": false, "spawn_billing_claude": "api"}}),
        );
        let nested = map(json!({"spawn_harnesses": {"codex": {"full_access": true}}}));
        assert_eq!(p.refusal(&values, &nested).unwrap().message, LOCKED);
        let billing = map(json!({"spawn_harnesses": {"claude": {"billing": "subscription"}}}));
        assert!(p.refusal(&values, &billing).is_some());
        let same = map(json!({"spawn_harnesses": {"codex": {"full_access": false}}}));
        assert!(p.refusal(&values, &same).is_none());
    }
}
