//! The per-harness spawn settings: full access and billing, for every
//! harness `relay::harness` knows, as each one's descriptor offers them.
//!
//! `settings.get` lists them as `spawn_harnesses: {<id>: {full_access,
//! billing}}`, and `settings.set` takes the same shape, any subset. Codex
//! and Claude also keep the flat keys they had before the map
//! (`spawn_full_access_codex`, `spawn_billing_claude`, …), read and set as
//! ever; a harness added since is in the map only.

use super::wire::Billing;
use crate::relay::harness::{self, Descriptor, HarnessId};
use crate::relay::store::spawn::HarnessSpawnSettings;
use crate::relay::store::Store;
use serde_json::{json, Map, Value};

/// The key of the per-harness settings.
pub const KEY: &str = "spawn_harnesses";

/// The harnesses with flat keys of their own as well.
pub const FLAT: [&str; 2] = ["codex", "claude"];

/// One harness's spawn settings, as they apply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HarnessSettings {
    pub full_access: bool,
    pub billing: Billing,
}

impl HarnessSettings {
    /// What applies for `descriptor`'s harness: what the person chose,
    /// else its defaults. A harness with no full-access setting runs as it
    /// is set up, never with full access.
    pub fn of(descriptor: &Descriptor, stored: &HarnessSpawnSettings) -> HarnessSettings {
        let full_access = descriptor
            .full_access
            .is_some_and(|full_access| stored.full_access.unwrap_or(full_access.default));
        let billing = match descriptor.billing {
            true => stored.billing.as_deref().and_then(Billing::from_name),
            false => None,
        };
        HarnessSettings {
            full_access,
            billing: billing.unwrap_or_default(),
        }
    }

    /// `settings.get`'s value for it: the settings its descriptor offers.
    fn value(&self, descriptor: &Descriptor) -> Value {
        let mut value = Map::new();
        if descriptor.full_access.is_some() {
            value.insert("full_access".into(), json!(self.full_access));
        }
        if descriptor.billing {
            value.insert("billing".into(), json!(self.billing.name()));
        }
        Value::Object(value)
    }
}

/// Every known harness's settings, in order.
pub fn of(store: &Store) -> Vec<(HarnessId, HarnessSettings)> {
    harness::descriptors()
        .map(|descriptor| {
            let stored = store.spawn_harness(descriptor.id.name());
            (descriptor.id, HarnessSettings::of(descriptor, &stored))
        })
        .collect()
}

/// `settings.get`'s `spawn_harnesses`.
pub fn value(settings: &[(HarnessId, HarnessSettings)]) -> Value {
    Value::Object(
        settings
            .iter()
            .map(|(id, settings)| (id.name().to_string(), settings.value(id.descriptor())))
            .collect(),
    )
}

/// A checked change to one harness's settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HarnessChange {
    pub full_access: Option<bool>,
    pub billing: Option<Billing>,
}

impl HarnessChange {
    /// Writes the change into the store.
    pub fn apply(&self, id: HarnessId, store: &mut Store) {
        let mut kept = store.spawn_harness(id.name());
        if let Some(full_access) = self.full_access {
            kept.full_access = Some(full_access);
        }
        if let Some(billing) = self.billing {
            kept.billing = (billing != Billing::Unspecified).then(|| billing.name().to_string());
        }
        store.set_spawn_harness(id.name(), kept);
    }
}

/// Reads `billing` named `key`.
pub fn billing(key: &str, value: &Value) -> Result<Billing, String> {
    value
        .as_str()
        .and_then(Billing::from_name)
        .ok_or_else(|| format!("{key} must be unspecified, subscription or api."))
}

/// The per-harness changes among `changes`, the flat keys' first; an
/// invalid one is refused with the reason, before anything is changed.
pub fn changes(changes: &Map<String, Value>) -> Result<Vec<(HarnessId, HarnessChange)>, String> {
    let mut read = flat_changes(changes)?;
    if let Some(map) = changes.get(KEY) {
        let map = map
            .as_object()
            .ok_or_else(|| format!("{KEY} must map harness ids to their settings."))?;
        for (id, entry) in map {
            read.push(entry_change(id, entry)?);
        }
    }
    Ok(read)
}

fn flat_changes(changes: &Map<String, Value>) -> Result<Vec<(HarnessId, HarnessChange)>, String> {
    let mut read = Vec::new();
    for id in FLAT.into_iter().filter_map(HarnessId::from_name) {
        let billing_key = format!("spawn_billing_{id}");
        let change = HarnessChange {
            full_access: changes
                .get(&format!("spawn_full_access_{id}"))
                .and_then(Value::as_bool),
            billing: changes
                .get(&billing_key)
                .map(|value| billing(&billing_key, value))
                .transpose()?,
        };
        if change != HarnessChange::default() {
            read.push((id, change));
        }
    }
    Ok(read)
}

fn entry_change(id: &str, entry: &Value) -> Result<(HarnessId, HarnessChange), String> {
    let harness = HarnessId::from_name(id)
        .ok_or_else(|| format!("{KEY} names {id}, a harness this computer does not know."))?;
    let entry = entry
        .as_object()
        .ok_or_else(|| format!("{KEY}.{id} must be an object."))?;
    let descriptor = harness.descriptor();
    let mut change = HarnessChange::default();
    for (key, value) in entry {
        let name = format!("{KEY}.{id}.{key}");
        match key.as_str() {
            "full_access" if descriptor.full_access.is_some() => {
                let on = value
                    .as_bool()
                    .ok_or_else(|| format!("{name} must be true or false."))?;
                change.full_access = Some(on);
            }
            "billing" if descriptor.billing => change.billing = Some(billing(&name, value)?),
            _ => return Err(format!("{} has no spawn setting {key}.", descriptor.label)),
        }
    }
    Ok((harness, change))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::harness::{claude, codex};

    fn read(value: Value) -> Result<Vec<(HarnessId, HarnessChange)>, String> {
        changes(value.as_object().unwrap())
    }

    #[test]
    fn every_known_harness_is_listed_with_what_its_descriptor_offers() {
        let store = Store {
            spawn_full_access_claude: Some(false),
            spawn_billing_codex: Some("api".into()),
            ..Store::default()
        };
        assert_eq!(
            value(&of(&store)),
            json!({
                "codex": {"full_access": true, "billing": "api"},
                "claude": {"full_access": false, "billing": "unspecified"},
                "opencode": {"full_access": true, "billing": "unspecified"},
                "grok": {"full_access": true, "billing": "unspecified"},
                "muse": {"full_access": false, "billing": "unspecified"},
                "devin": {"full_access": false, "billing": "unspecified"},
            })
        );
    }

    #[test]
    fn a_harness_with_no_full_access_setting_never_runs_with_full_access() {
        let descriptor = Descriptor {
            full_access: None,
            billing: false,
            ..codex::DESCRIPTOR
        };
        let stored = HarnessSpawnSettings {
            full_access: Some(true),
            billing: Some("api".into()),
        };
        let settings = HarnessSettings::of(&descriptor, &stored);
        assert!(!settings.full_access);
        assert_eq!(settings.billing, Billing::Unspecified);
        assert_eq!(settings.value(&descriptor), json!({}));
    }

    #[test]
    fn changes_are_read_from_the_flat_keys_and_the_map() {
        assert_eq!(read(json!({})), Ok(vec![]));
        assert_eq!(
            read(
                json!({"spawn_full_access_codex": false, "spawn_billing_claude": "api",
                "spawn_harnesses": {"claude": {"full_access": true}}})
            ),
            Ok(vec![
                (
                    codex::ID,
                    HarnessChange {
                        full_access: Some(false),
                        billing: None
                    }
                ),
                (
                    claude::ID,
                    HarnessChange {
                        full_access: None,
                        billing: Some(Billing::Api)
                    }
                ),
                (
                    claude::ID,
                    HarnessChange {
                        full_access: Some(true),
                        billing: None
                    }
                ),
            ])
        );
        for (bad, reason) in [
            (
                json!({"spawn_billing_codex": "free"}),
                "spawn_billing_codex must be unspecified, subscription or api.",
            ),
            (
                json!({"spawn_harnesses": []}),
                "spawn_harnesses must map harness ids to their settings.",
            ),
            (
                json!({"spawn_harnesses": {"aider": {}}}),
                "spawn_harnesses names aider, a harness this computer does not know.",
            ),
            (
                json!({"spawn_harnesses": {"codex": true}}),
                "spawn_harnesses.codex must be an object.",
            ),
            (
                json!({"spawn_harnesses": {"codex": {"full_access": "yes"}}}),
                "spawn_harnesses.codex.full_access must be true or false.",
            ),
            (
                json!({"spawn_harnesses": {"codex": {"billing": "free"}}}),
                "spawn_harnesses.codex.billing must be unspecified, subscription or api.",
            ),
            (
                json!({"spawn_harnesses": {"claude": {"model": "opus"}}}),
                "Claude has no spawn setting model.",
            ),
        ] {
            assert_eq!(read(bad.clone()), Err(reason.to_string()), "{bad}");
        }
    }

    #[test]
    fn a_change_keeps_what_it_does_not_name_and_unspecified_billing_is_not_kept() {
        let mut store = Store {
            spawn_full_access_codex: Some(false),
            ..Store::default()
        };
        let change = HarnessChange {
            full_access: None,
            billing: Some(Billing::Subscription),
        };
        change.apply(codex::ID, &mut store);
        assert_eq!(store.spawn_full_access_codex, Some(false));
        assert_eq!(store.spawn_billing_codex.as_deref(), Some("subscription"));
        HarnessChange {
            full_access: Some(true),
            billing: Some(Billing::Unspecified),
        }
        .apply(codex::ID, &mut store);
        assert_eq!(store.spawn_full_access_codex, Some(true));
        assert_eq!(store.spawn_billing_codex, None);
    }
}
