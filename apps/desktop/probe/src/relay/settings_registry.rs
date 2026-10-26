//! Every setting the app's Settings shows, described for agents: the one
//! registry behind the session socket's `GET /settings` and
//! `PATCH /settings` (`outbound::settings`).
//!
//! It is derived from the bridge contract the apps already use to read and
//! change settings (`SettingsValues` for `settings.get`, `SettingsChange`
//! for `settings.set`), so a setting added for the apps is an agent's to
//! read and change too, with its doc comment as its description. Nothing
//! here lists settings by hand except the allowed values a type cannot say.

use crate::relay::contract::agents::{SettingsChange, SettingsValues};
use crate::relay::spawn::wire::Billing;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

/// Held while settings change, by the app (`settings.set`) and by agents
/// (`PATCH /settings`), so an agent's change is recorded with the values
/// just before and after it, and no other writer's.
static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Waits for, then holds, the settings write lock.
pub fn writing() -> std::sync::MutexGuard<'static, ()> {
    WRITING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Keys of `settings.get` that are records, not settings.
pub const RECORDS: [&str; 1] = ["agent_changes"];

/// Each setting with its key, type, current value, whether an agent may
/// change it now, what it does, what a change takes (`accepts`, the write
/// schema with its definitions inlined, which can differ from the value's
/// shape) and, where a type cannot say, its allowed values. A setting a tool
/// owns is absent until that tool has run here: it is listed with
/// `available: false` and cannot be changed. Keys in alphabetical order.
pub fn describe(values: &Map<String, Value>) -> Vec<Value> {
    let change = schemars::schema_for!(SettingsChange);
    let definitions = change
        .as_object()
        .and_then(|object| object.get("$defs"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let writable = properties(change);
    let readable = properties(schemars::schema_for!(SettingsValues));
    let keys: BTreeSet<&String> = writable.keys().chain(readable.keys()).collect();
    keys.into_iter()
        .filter(|key| !RECORDS.contains(&key.as_str()))
        .map(|key| {
            let written = writable.get(key);
            let schema = written.or(readable.get(key)).cloned().unwrap_or_default();
            let available = values.contains_key(stands_for(key));
            let mut entry = json!({
                "key": key,
                "type": type_name(&schema),
                "value": values.get(key).cloned().unwrap_or(Value::Null),
                "available": available,
                "writable": written.is_some() && available,
                "description": description(written, readable.get(key)),
            });
            if let Some(written) = written {
                entry["accepts"] = inlined(written.clone(), &definitions);
            }
            if !available {
                entry["unavailable"] = json!(unavailable(key));
            }
            if let Some(allowed) = allowed(key) {
                entry["allowed"] = allowed;
            }
            entry
        })
        .collect()
}

/// Why a setting is absent from `settings.get`: on Windows, a setting of a
/// harness whose local tools are Unix-only says so, as its adapter does
/// (`existing_session::platform::unavailable`), since it never appears there.
fn unavailable(key: &str) -> String {
    let harness = match key {
        "grok_leader" => Some("Grok"),
        "opencode_plugin" => Some("OpenCode"),
        "openclaw_gateway" | "openclaw_unlimited_version" => Some("OpenClaw"),
        "hermes_agent" => Some("Hermes"),
        "devin_direct_delivery" => Some("Devin"),
        "trusted_relay_senders" => Some("OpenClaw and Hermes"),
        _ => None,
    };
    match harness {
        Some("OpenClaw and Hermes") if cfg!(windows) => {
            "OpenClaw and Hermes are not available on Windows.".to_string()
        }
        Some(label) if cfg!(windows) => {
            crate::relay::existing_session::platform::unavailable(label)
        }
        _ => "Not on this computer now: the tool it configures has not run here.".to_string(),
    }
}

/// The `settings.get` key whose presence says a setting can be changed: a
/// command stands for the setting it changes.
fn stands_for(key: &str) -> &str {
    match key {
        "claude_config_dir" => "claude_config_dirs",
        "direct_delivery_default" => "direct_delivery",
        _ => key,
    }
}

/// `schema` with each `$ref` to a definition replaced by the definition.
fn inlined(schema: Value, definitions: &Map<String, Value>) -> Value {
    match schema {
        Value::Object(object) => {
            let target = object
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|reference| reference.strip_prefix("#/$defs/"))
                .and_then(|name| definitions.get(name));
            if let Some(definition) = target {
                return inlined(definition.clone(), definitions);
            }
            Value::Object(
                object
                    .into_iter()
                    .map(|(key, value)| (key, inlined(value, definitions)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| inlined(item, definitions))
                .collect(),
        ),
        other => other,
    }
}

/// A schema's properties, by name.
fn properties(schema: schemars::Schema) -> Map<String, Value> {
    schema
        .as_object()
        .and_then(|object| object.get("properties"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// The JSON type a value takes, without `null` (no setting is set to null).
fn type_name(schema: &Value) -> String {
    match schema.get("type") {
        Some(Value::String(name)) => name.clone(),
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(Value::as_str)
            .find(|name| *name != "null")
            .unwrap_or("object")
            .to_string(),
        _ => "object".to_string(),
    }
}

/// The change's doc comment, else the value's.
fn description(written: Option<&Value>, read: Option<&Value>) -> String {
    [written, read]
        .into_iter()
        .flatten()
        .find_map(|schema| schema.get("description").and_then(Value::as_str))
        .unwrap_or_default()
        .replace('\n', " ")
}

/// The values a setting allows when its type does not say.
fn allowed(key: &str) -> Option<Value> {
    match key {
        "spawn_billing_codex" | "spawn_billing_claude" => Some(json!(Billing::ALL
            .iter()
            .map(|billing| billing.name())
            .collect::<Vec<_>>())),
        "spawn_max_agents" => Some(json!({
            "minimum": 0,
            "maximum": crate::relay::spawn::lifecycle::MAX_AGENTS_LIMIT,
        })),
        "history_retention_days" => Some(json!(crate::relay::history_retention::CHOICES)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn by_key(list: &[Value]) -> Map<String, Value> {
        list.iter()
            .map(|entry| (entry["key"].as_str().unwrap().to_string(), entry.clone()))
            .collect()
    }

    /// Every setting the apps can change or show is in the registry, with
    /// a description: a new setting without a doc comment fails here.
    #[test]
    fn every_app_setting_is_described_for_agents() {
        let readable = properties(schemars::schema_for!(SettingsValues));
        let every: Map<String, Value> = readable.keys().map(|k| (k.clone(), json!(null))).collect();
        let listed = by_key(&describe(&every));
        let change = serde_json::to_value(SettingsChange::default()).unwrap();
        assert!(change.as_object().unwrap().is_empty());
        let mut undescribed = Vec::new();
        for key in properties(schemars::schema_for!(SettingsChange)).keys() {
            let entry = listed.get(key).unwrap_or_else(|| panic!("{key} missing"));
            assert_eq!(entry["writable"], true, "{key}");
            assert!(entry["accepts"].is_object(), "{key}");
            if entry["description"].as_str().unwrap().is_empty() {
                undescribed.push(key.clone());
            }
        }
        assert!(undescribed.is_empty(), "no description: {undescribed:?}");
        for key in properties(schemars::schema_for!(SettingsValues)).keys() {
            assert!(
                listed.contains_key(key) || RECORDS.contains(&key.as_str()),
                "{key} missing"
            );
        }
        assert!(
            !listed.contains_key("agent_changes"),
            "a record, not a setting"
        );
    }

    #[test]
    fn entries_carry_type_value_and_allowed_values() {
        let mut values = Map::new();
        values.insert("auto_join_general".into(), json!(true));
        values.insert("spawn_max_agents".into(), json!(8));
        let listed = by_key(&describe(&values));
        let general = &listed["auto_join_general"];
        assert_eq!(general["type"], "boolean");
        assert_eq!(general["value"], true);
        assert_eq!(listed["spawn_max_agents"]["type"], "integer");
        assert_eq!(listed["spawn_max_agents"]["allowed"]["maximum"], 32);
        assert_eq!(
            listed["history_retention_days"]["allowed"],
            json!([7, 30, 90, 0])
        );
        assert_eq!(
            listed["spawn_billing_codex"]["allowed"],
            json!(["unspecified", "subscription", "api"])
        );
        assert_eq!(listed["direct_delivery_managed"]["writable"], false);
    }

    /// A tool's setting is absent until the tool has run here: listed, but
    /// not offered as changeable, with the reason.
    #[test]
    fn a_setting_whose_tool_has_not_run_is_listed_unavailable() {
        let listed = by_key(&describe(&Map::new()));
        let grok = &listed["grok_leader"];
        assert_eq!(
            (grok["available"].clone(), grok["writable"].clone()),
            (json!(false), json!(false))
        );
        #[cfg(unix)]
        assert!(grok["unavailable"]
            .as_str()
            .unwrap()
            .contains("has not run"));
        // Grok's tools are Unix-only: on Windows its setting says so.
        #[cfg(windows)]
        assert_eq!(grok["unavailable"], "Grok is not available on Windows.");
        let mut values = Map::new();
        values.insert("grok_leader".into(), json!(false));
        values.insert("claude_config_dirs".into(), json!([]));
        let listed = by_key(&describe(&values));
        assert_eq!(listed["grok_leader"]["writable"], true);
        assert!(listed["grok_leader"].get("unavailable").is_none());
        // A command is available with the setting it changes.
        assert_eq!(listed["claude_config_dir"]["writable"], true);
    }

    /// On Windows each Unix-only harness's setting gives that reason, and a
    /// setting of a tool that runs there keeps the usual one.
    #[cfg(windows)]
    #[test]
    fn a_unix_only_harness_setting_says_it_is_not_available_on_windows() {
        let listed = by_key(&describe(&Map::new()));
        for (key, sentence) in [
            ("opencode_plugin", "OpenCode is not available on Windows."),
            ("openclaw_gateway", "OpenClaw is not available on Windows."),
            ("hermes_agent", "Hermes is not available on Windows."),
            (
                "devin_direct_delivery",
                "Devin is not available on Windows.",
            ),
            (
                "trusted_relay_senders",
                "OpenClaw and Hermes are not available on Windows.",
            ),
        ] {
            assert_eq!(listed[key]["unavailable"], sentence, "{key}");
        }
        assert!(listed["codex_stop_hook"]["unavailable"]
            .as_str()
            .unwrap()
            .contains("has not run"));
    }

    /// What a change takes is shown where it differs from the value read:
    /// the folder list reads as folders but is changed with paths, and the
    /// one-folder command names its fields.
    #[test]
    fn the_write_shape_is_shown_with_its_fields() {
        let mut values = Map::new();
        values.insert(
            "claude_config_dirs".into(),
            json!([{"path": "/h/.claude", "origin": "default", "shared": true}]),
        );
        let listed = by_key(&describe(&values));
        let folders = &listed["claude_config_dirs"];
        assert!(folders["value"][0].is_object());
        assert_eq!(folders["accepts"]["items"]["type"], "string");
        let folder = &listed["claude_config_dir"]["accepts"];
        assert!(folder.get("$ref").is_none(), "{folder}");
        assert_eq!(folder["properties"]["path"]["type"], "string");
        assert!(folder["properties"].get("shared").is_some(), "{folder}");
        // A boolean's value round-trips into a change unchanged.
        let general = &listed["auto_join_general"];
        assert_eq!(general["accepts"]["type"], "boolean");
    }
}
