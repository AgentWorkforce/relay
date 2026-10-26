//! The settings routes on the session socket: an agent reads and changes
//! the settings the app's Settings shows, through the same core calls as
//! the app (`settings.get`, `settings.set`) and the registry that describes
//! them (`settings_registry`).
//!
//! ```text
//! GET   /settings                                every setting
//! PATCH /settings {"auto_join_general":true}     change one or more
//! ```
//!
//! Any setting may be changed, with no confirmation, except turning on one
//! that asks the person for something (`PERSON_TURNS_ON`), and each change is
//! recorded: the agent's name, the time, the setting and its value before
//! and after. Settings lists the latest (`agent_changes`), the activity log
//! has a line for each, and the apps re-read their settings at once
//! (`Listing::Settings`).
//!
//! A request is all or nothing: tools' settings are changed first and the
//! store's only once every tool accepted; when a tool refuses, the tools'
//! settings changed first are put back. One that cannot be put back is
//! recorded like any other change, and the refusal names it and why.

use super::{payload, Outbound, OutboundError, Purpose, Request};
use crate::relay::contract::agents::{AgentSettingsChange, SettingsChange};
use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::settings_registry::{describe, writing, RECORDS};
use crate::relay::state::{Level, Listing};
use serde_json::{json, Map, Value};

impl Outbound {
    /// `GET /settings` and `PATCH /settings`, for a live session of this
    /// user's (the same caller check and rate limit as `/send`).
    pub(super) async fn settings_route(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
    ) -> Result<Value, OutboundError> {
        let session = self.identify(pid, uid).await?;
        self.admit(&session.target.key())?;
        if request.method == "GET" {
            return Ok(json!({"settings": describe(&self.core.settings())}));
        }
        let fields = payload(request, Purpose::Json)?;
        let changes = checked(fields)?;
        let by = self.settings_caller(&session);
        let (changed, outcome, unrestored) = apply(&self.core, &changes, &by);
        self.announce_agent_changes(&changed);
        if let Err(error) = outcome {
            return Err(refused(error, &changed, unrestored));
        }
        Ok(json!({
            "changed": changed,
            "settings": describe(&self.core.settings()),
        }))
    }

    /// Logs each change and has the apps read their settings again; `apply`
    /// has recorded them.
    fn announce_agent_changes(&self, changed: &[AgentSettingsChange]) {
        if changed.is_empty() {
            return;
        }
        for change in changed {
            self.core.hub.activity(Level::Info, activity_line(change));
        }
        self.core.hub.invalidated(Listing::Settings);
    }

    /// The caller as Settings names it: its name on the relay, else its
    /// session.
    fn settings_caller(&self, session: &DiscoveredSession) -> String {
        let name = self.core.store.read(|store| {
            store
                .registration_for(&session.target)
                .map(|registration| registration.display_name().to_string())
        });
        name.unwrap_or_else(|| {
            let kind = session.target.kind.as_str();
            format!("an unregistered {kind} session ({})", session.target.id)
        })
    }
}

/// Applies `changes` as one writer (the app's `settings.set` waits), so the
/// values before and after are this change's own. Tools' settings go first
/// and the store's only once every tool accepted: a store write can start
/// side effects (bringing the spawn node in line) that putting a value back
/// would not undo. On a refusal the tools' settings changed first are put
/// back. What is changed now is recorded under the same lock. Returns it,
/// the outcome, and why a put-back failed.
fn apply(
    core: &Core,
    changes: &Map<String, Value>,
    by: &str,
) -> (
    Vec<AgentSettingsChange>,
    Result<(), RpcError>,
    Option<String>,
) {
    let _writing = writing();
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let before = core.settings();
    let chosen = core
        .store
        .read(|store| store.integration_defaults_applied.clone());
    let (store, tools): (Map<String, Value>, Map<String, Value>) = changes
        .clone()
        .into_iter()
        .partition(|(key, _)| store_key(key));
    let mut outcome = Ok(());
    for part in [&tools, &store] {
        if outcome.is_ok() && !part.is_empty() {
            outcome = core.set_settings(part).map(drop);
        }
    }
    let mut unrestored = None;
    if outcome.is_err() {
        let applied = differences(&before, &core.settings(), &tools, by, &at);
        let restore = restoring(&before, &applied);
        if !restore.is_empty() {
            unrestored = core.set_settings(&restore).err().map(|e| e.message);
        }
    }
    let changed = differences(&before, &core.settings(), changes, by, &at);
    if outcome.is_err() {
        keep_choices(core, chosen, &changed);
    }
    // Recorded before the lock is let go, so the record's order is the
    // order the changes were made in.
    let kept = match changed.is_empty() {
        true => Ok(()),
        false => core
            .store
            .update(|store| store.extras.record(changed.clone())),
    };
    if let Err(error) = kept {
        core.hub.activity(
            Level::Warning,
            format!("Could not record {by}'s settings change: {error}"),
        );
    }
    (changed, outcome, unrestored)
}

/// The person's recorded choices (`integration_defaults_applied`) after a
/// refused batch: as they were before it, the put-back's own writes
/// included, since a change that did not stand is no choice and the default
/// pass may still turn the tool on; plus each tool setting that stays
/// changed because it could not be put back, so the default pass never
/// undoes it. A command stands for the setting it changes.
fn keep_choices(core: &Core, chosen: Option<Vec<String>>, changed: &[AgentSettingsChange]) {
    let mut kept = chosen;
    for change in changed.iter().filter(|change| !store_key(&change.key)) {
        let key = match change.key.as_str() {
            "direct_delivery_default" => "direct_delivery",
            key => key,
        };
        let list = kept.get_or_insert_with(Vec::new);
        if !list.iter().any(|known| known == key) {
            list.push(key.to_string());
        }
    }
    let saved = core
        .store
        .update(|store| store.integration_defaults_applied = kept);
    if let Err(error) = saved {
        core.hub.activity(
            Level::Warning,
            format!("Could not put back a refused settings change's choices: {error}"),
        );
    }
}

/// Whether the store keeps `key` (spawning's among them); the rest are
/// tools' settings.
fn store_key(key: &str) -> bool {
    crate::relay::store_settings::STORE_SETTINGS.contains(&key)
        || crate::relay::spawn::settings::KEYS.contains(&key)
}

/// Settings only the person turns on, in Settings: turning one on asks them
/// for something. Claude Code cloud sessions raise macOS's prompt to read
/// Claude Code's Keychain login; mobile handoff changes where sessions run.
/// An agent may still turn them off.
const PERSON_TURNS_ON: [&str; 2] = [
    crate::relay::claude_dirs::CLOUD_SETTING,
    "mobile_claude_handoff",
];

/// The change as `settings.set` takes it: known settings only, at least one.
fn checked(fields: Map<String, Value>) -> Result<Map<String, Value>, OutboundError> {
    if fields.is_empty() {
        return Err(OutboundError::new(
            400,
            "invalid_settings",
            "Name at least one setting to change; GET /settings lists them.",
        ));
    }
    if let Some(record) = fields.keys().find(|key| RECORDS.contains(&key.as_str())) {
        return Err(OutboundError::new(
            400,
            "invalid_settings",
            format!("{record} is a record, not a setting; it cannot be changed."),
        ));
    }
    if let Some(key) = PERSON_TURNS_ON
        .iter()
        .find(|key| fields.get(**key) == Some(&Value::Bool(true)))
    {
        return Err(OutboundError::new(
            403,
            "person_only_setting",
            format!("Only the person can turn {key} on, in Agent Relay's Settings."),
        ));
    }
    let change: SettingsChange = serde_json::from_value(Value::Object(fields)).map_err(|e| {
        OutboundError::new(
            400,
            "invalid_settings",
            format!("{e}. GET /settings lists each setting and its type."),
        )
    })?;
    match serde_json::to_value(change) {
        Ok(Value::Object(changes)) => Ok(changes),
        _ => Ok(Map::new()),
    }
}

/// The change that puts back each applied setting, in the shape a change
/// takes: the folder list as the added folders' paths, one folder by its
/// path and sharing, the first-run default as direct delivery itself.
fn restoring(before: &Map<String, Value>, applied: &[AgentSettingsChange]) -> Map<String, Value> {
    let mut restore = Map::new();
    for change in applied {
        let key = change.key.as_str();
        let entry = match key {
            "claude_config_dirs" => before.get(key).map(|folders| {
                let added: Vec<Value> = folders
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|folder| folder["origin"] == "added")
                    .filter_map(|folder| folder.get("path").cloned())
                    .collect();
                (key, Value::Array(added))
            }),
            "claude_config_dir" => change
                .from
                .as_deref()
                .and_then(|from| serde_json::from_str::<Value>(from).ok())
                .map(|folder| {
                    let back = json!({"path": folder["path"], "shared": folder["shared"]});
                    (key, back)
                }),
            "direct_delivery_default" => before
                .get("direct_delivery")
                .map(|value| ("direct_delivery", value.clone())),
            _ => before.get(key).map(|value| (key, value.clone())),
        };
        if let Some((key, value)) = entry {
            restore.insert(key.to_string(), value);
        }
    }
    restore
}

/// A refusal from `settings.set` as the socket reports it: a value or a
/// change a setting refuses is the caller's to fix (400), anything else the
/// core's (500). Settings still changed by the request are named, with why
/// they could not be put back.
fn refused(
    error: RpcError,
    changed: &[AgentSettingsChange],
    unrestored: Option<String>,
) -> OutboundError {
    let (status, code) = match error.data.kind {
        ErrorKind::InvalidParams | ErrorKind::Refused => (400, "invalid_settings"),
        _ => (500, "settings_failed"),
    };
    let mut message = error.message;
    if !changed.is_empty() {
        let keys: Vec<&str> = changed.iter().map(|change| change.key.as_str()).collect();
        message = format!(
            "{message} These could not be put back and stay changed: {}.",
            keys.join(", ")
        );
        if let Some(why) = unrestored {
            message = format!("{message} Putting them back failed: {why}");
        }
    }
    OutboundError::new(status, code, message)
}

/// What a requested key changes, as `settings.get` shows it: a command that
/// changes part of another setting reads that part. `None` when nothing
/// observable stands for it.
fn observed(values: &Map<String, Value>, key: &str, asked: &Value) -> Option<Value> {
    match key {
        // One folder of `claude_config_dirs`, by path.
        "claude_config_dir" => values
            .get("claude_config_dirs")?
            .as_array()?
            .iter()
            .find(|folder| folder.get("path") == asked.get("path"))
            .cloned(),
        // The first-run default changes direct delivery itself.
        "direct_delivery_default" => values.get("direct_delivery").cloned(),
        _ => values.get(key).cloned(),
    }
}

/// What changed among the settings named in `changes`, as `settings.get`
/// read it before and after: the value before and after, as JSON text. A
/// setting left as it was, or with nothing observable, is no change.
fn differences(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    changes: &Map<String, Value>,
    by: &str,
    at: &str,
) -> Vec<AgentSettingsChange> {
    changes
        .iter()
        .filter_map(|(key, asked)| {
            let old = observed(before, key, asked);
            let new = observed(after, key, asked)?;
            (old.as_ref() != Some(&new)).then(|| AgentSettingsChange {
                at: at.to_string(),
                by: by.to_string(),
                key: key.clone(),
                from: old.as_ref().map(Value::to_string),
                to: new.to_string(),
            })
        })
        .collect()
}

/// The activity log's line for one change.
fn activity_line(change: &AgentSettingsChange) -> String {
    let from = change.from.as_deref().unwrap_or("unset");
    format!(
        "{} changed {} from {from} to {} on the session socket.",
        change.by, change.key, change.to
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn only_known_settings_and_at_least_one_are_accepted() {
        let unknown = checked(map(json!({"no_such_setting": true}))).unwrap_err();
        assert_eq!(unknown.status, 400);
        assert!(
            unknown.message.contains("no_such_setting"),
            "{}",
            unknown.message
        );
        let wrong = checked(map(json!({"auto_join_general": "yes"}))).unwrap_err();
        assert_eq!(wrong.code, "invalid_settings");
        assert_eq!(checked(Map::new()).unwrap_err().code, "invalid_settings");
        let record = checked(map(json!({"agent_changes": []}))).unwrap_err();
        assert!(record.message.contains("record"), "{}", record.message);
        let ok = checked(map(
            json!({"auto_join_general": true, "spawn_max_agents": 4}),
        ))
        .unwrap();
        assert_eq!(
            Value::Object(ok),
            json!({"auto_join_general": true, "spawn_max_agents": 4})
        );
    }

    #[test]
    fn mobile_handoff_opt_in_requires_the_person_not_a_session_message() {
        let on = checked(map(json!({"mobile_claude_handoff": true}))).unwrap_err();
        assert_eq!((on.status, on.code.as_str()), (403, "person_only_setting"));
        let off = checked(map(json!({"mobile_claude_handoff": false}))).unwrap();
        assert_eq!(Value::Object(off), json!({"mobile_claude_handoff": false}));
    }

    #[test]
    fn an_agent_may_turn_claude_cloud_sessions_off_but_not_on() {
        let on = checked(map(json!({"claude_cloud_sessions": true}))).unwrap_err();
        assert_eq!((on.status, on.code.as_str()), (403, "person_only_setting"));
        let off = checked(map(json!({"claude_cloud_sessions": false}))).unwrap();
        assert_eq!(Value::Object(off), json!({"claude_cloud_sessions": false}));
    }

    #[test]
    fn a_change_records_the_value_before_and_after() {
        let before = map(json!({"auto_join_general": false, "auto_activate": true}));
        let after = map(json!({"auto_join_general": true, "auto_activate": true}));
        let changes = map(json!({"auto_join_general": true, "auto_activate": true}));
        let changed = differences(&before, &after, &changes, "api", "2026-10-16T00:00:00Z");
        assert_eq!(
            changed,
            vec![AgentSettingsChange {
                at: "2026-10-16T00:00:00Z".into(),
                by: "api".into(),
                key: "auto_join_general".into(),
                from: Some("false".into()),
                to: "true".into(),
            }],
            "auto_activate kept its value"
        );
        assert_eq!(
            activity_line(&changed[0]),
            "api changed auto_join_general from false to true on the session socket."
        );
    }

    #[test]
    fn a_folder_change_records_that_folders_values() {
        let folder =
            |shared: bool| json!({"path": "/h/.claude", "origin": "default", "shared": shared});
        let other = json!({"path": "/opt/claude", "origin": "added", "shared": true});
        let before = map(json!({"claude_config_dirs": [folder(true), other.clone()]}));
        let after = map(json!({"claude_config_dirs": [folder(false), other]}));
        let changes = map(json!({"claude_config_dir": {"path": "/h/.claude", "shared": false}}));
        let changed = differences(&before, &after, &changes, "api", "t");
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].key, "claude_config_dir");
        assert_eq!(changed[0].from, Some(folder(true).to_string()));
        assert_eq!(changed[0].to, folder(false).to_string());
    }

    #[test]
    fn a_write_only_command_records_only_what_it_changed() {
        let off = map(json!({"direct_delivery": false}));
        let on = map(json!({"direct_delivery": true}));
        let turn_on = map(json!({"direct_delivery_default": true}));
        let changed = differences(&off, &on, &turn_on, "api", "t");
        assert_eq!(
            (changed[0].from.as_deref(), changed[0].to.as_str()),
            (Some("false"), "true")
        );
        // `false` changes nothing, and nothing is recorded.
        let no_op = map(json!({"direct_delivery_default": false}));
        assert!(differences(&off, &off, &no_op, "api", "t").is_empty());
        // A key with nothing observable is not invented as `unset` → value.
        let unseen = map(json!({"claude_config_dir": {"path": "/gone", "shared": false}}));
        assert!(differences(&off, &off, &unseen, "api", "t").is_empty());
    }

    /// The put-back is a change `settings.set` takes, in each setting's
    /// write shape.
    #[test]
    fn a_put_back_takes_each_settings_write_shape() {
        let folder = |path: &str, origin: &str, shared: bool| json!({"path": path, "origin": origin, "shared": shared});
        let before = map(json!({
            "auto_join_general": false,
            "direct_delivery": false,
            "claude_config_dirs": [folder("/h/.claude", "default", true), folder("/opt/claude", "added", true)],
        }));
        let applied = |key: &str, from: Option<Value>| AgentSettingsChange {
            at: "t".into(),
            by: "api".into(),
            key: key.into(),
            from: from.map(|value| value.to_string()),
            to: "x".into(),
        };
        let restore = restoring(
            &before,
            &[
                applied("auto_join_general", Some(json!(false))),
                applied("claude_config_dirs", None),
                applied(
                    "claude_config_dir",
                    Some(folder("/h/.claude", "default", true)),
                ),
                applied("direct_delivery_default", Some(json!(false))),
            ],
        );
        assert_eq!(
            Value::Object(restore.clone()),
            json!({
                "auto_join_general": false,
                "claude_config_dirs": ["/opt/claude"],
                "claude_config_dir": {"path": "/h/.claude", "shared": true},
                "direct_delivery": false,
            })
        );
        serde_json::from_value::<SettingsChange>(Value::Object(restore)).unwrap();
    }

    /// Two tools' settings: `codex_stop_hook` takes a change, `grok_leader`
    /// refuses every one.
    #[derive(Default)]
    struct Tools {
        hook: std::sync::atomic::AtomicBool,
        direct: std::sync::atomic::AtomicBool,
        sticky: std::sync::atomic::AtomicBool,
    }

    impl crate::relay::agents::SettingsExtension for Tools {
        fn get(&self) -> Map<String, Value> {
            let load = |flag: &std::sync::atomic::AtomicBool| {
                flag.load(std::sync::atomic::Ordering::SeqCst)
            };
            map(json!({
                "codex_stop_hook": load(&self.hook),
                "contractor_access": load(&self.sticky),
                "direct_delivery": load(&self.direct),
                "grok_leader": false,
            }))
        }
        fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
            let on = value.as_bool().unwrap_or_default();
            let store = |flag: &std::sync::atomic::AtomicBool| {
                flag.store(on, std::sync::atomic::Ordering::SeqCst);
                Some(Ok(()))
            };
            match key {
                "codex_stop_hook" => store(&self.hook),
                "direct_delivery" | "direct_delivery_default" => store(&self.direct),
                // Turns on, but refuses to turn off again.
                "contractor_access" if on => store(&self.sticky),
                "contractor_access" => Some(Err("It cannot be turned off now.".into())),
                "grok_leader" => Some(Err("Grok is not installed.".into())),
                _ => None,
            }
        }
        fn write_only(&self) -> &'static [&'static str] {
            &["direct_delivery_default"]
        }
    }

    fn core(temp: &std::path::Path) -> std::sync::Arc<Core> {
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.join("core.sock")).unwrap(),
            home: temp.into(),
            app_data_dir: temp.join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: std::time::Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let plugins = crate::relay::daemon::Plugins {
            settings: vec![std::sync::Arc::new(Tools::default())],
            ..crate::relay::daemon::Plugins::default()
        };
        Core::with_plugins(config, plugins).0
    }

    // A tool refuses part way: the tool setting changed before it is put
    // back, and the store's settings (spawning among them, whose write
    // brings the spawn node in line) are never written at all.
    #[tokio::test]
    async fn a_batch_a_tool_refuses_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let changes = map(json!({
            "auto_join_general": true,
            "accept_spawns": false,
            "codex_stop_hook": true,
            "grok_leader": true,
        }));
        let (changed, outcome, unrestored) = apply(&core, &changes, "api");
        assert_eq!(outcome.unwrap_err().message, "Grok is not installed.");
        assert!(changed.is_empty(), "{changed:?}");
        assert_eq!(unrestored, None);
        assert_eq!(core.settings()["codex_stop_hook"], false, "put back");
        let store = core.store.snapshot();
        assert_eq!(
            store.integration_defaults_applied.unwrap_or_default(),
            Vec::<String>::new(),
            "a change that did not stand is no choice the default pass must keep"
        );
        assert_eq!(store.accept_spawns, None, "never written");
        assert_eq!(store.extras.auto_join_general, None, "never written");
        // The first-run default is put back as direct delivery itself; that
        // write is no choice either.
        let default = map(json!({"direct_delivery_default": true, "grok_leader": true}));
        let (changed, outcome, unrestored) = apply(&core, &default, "api");
        assert!(outcome.is_err());
        assert!(changed.is_empty(), "{changed:?}");
        assert_eq!(unrestored, None);
        assert_eq!(core.settings()["direct_delivery"], false, "put back");
        let choices = || core.store.read(|s| s.integration_defaults_applied.clone());
        assert_eq!(choices().unwrap_or_default(), Vec::<String>::new());
        // A setting that cannot be put back stays changed and stays the
        // person's choice, so no default pass undoes it.
        let sticky = map(json!({"contractor_access": true, "grok_leader": true}));
        let (changed, outcome, unrestored) = apply(&core, &sticky, "api");
        assert!(outcome.is_err());
        assert_eq!(unrestored.as_deref(), Some("It cannot be turned off now."));
        let keys: Vec<&str> = changed.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["contractor_access"]);
        assert_eq!(choices(), Some(vec!["contractor_access".to_string()]));
        // Without the refusing setting, every one changes and is reported.
        let changes = map(json!({"auto_join_general": true, "codex_stop_hook": true}));
        let (changed, outcome, _) = apply(&core, &changes, "api");
        assert!(outcome.is_ok());
        assert_eq!(changed.len(), 2, "{changed:?}");
        assert_eq!(core.settings()["auto_join_general"], true);
        // Recorded in the order made, newest first, also within one second.
        let later = map(json!({"codex_stop_hook": false}));
        apply(&core, &later, "reviewer");
        let record = core.store.read(|store| store.extras.agent_changes.clone());
        let keys: Vec<(&str, &str)> = record
            .iter()
            .map(|change| (change.by.as_str(), change.key.as_str()))
            .collect();
        assert_eq!(
            keys,
            [
                ("reviewer", "codex_stop_hook"),
                ("api", "codex_stop_hook"),
                ("api", "auto_join_general"),
                ("api", "contractor_access"),
            ]
        );
    }

    /// The history is saved while the write lock is held: a writer that
    /// takes the lock next never sees a change without its record.
    #[tokio::test]
    async fn no_writer_sees_a_change_before_its_record() {
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let toggles = 19;
        let changing = core.clone();
        let writer = std::thread::spawn(move || {
            for i in 0..toggles {
                let on = map(json!({"codex_stop_hook": i % 2 == 0}));
                apply(&changing, &on, "api");
            }
        });
        let mut samples = 0;
        while !writer.is_finished() || samples == 0 {
            let _writing = writing();
            let hook = core.settings()["codex_stop_hook"] == true;
            let recorded = core.store.read(|store| store.extras.agent_changes.len());
            assert_eq!(
                hook,
                recorded % 2 == 1,
                "hook {hook} with {recorded} recorded"
            );
            samples += 1;
        }
        writer.join().unwrap();
        let recorded = core.store.read(|store| store.extras.agent_changes.len());
        assert_eq!(recorded, toggles);
    }

    #[test]
    fn a_refusal_is_the_callers_and_names_what_stayed_changed() {
        let invalid = refused(
            RpcError::invalid_params("spawn_max_agents must be a whole number."),
            &[],
            None,
        );
        assert_eq!(
            (invalid.status, invalid.code.as_str()),
            (400, "invalid_settings")
        );
        assert_eq!(invalid.message, "spawn_max_agents must be a whole number.");
        let stuck = differences(
            &map(json!({"auto_join_general": false})),
            &map(json!({"auto_join_general": true})),
            &map(json!({"auto_join_general": true})),
            "api",
            "t",
        );
        let managed = refused(
            RpcError::new(
                ErrorKind::Refused,
                "Your organization manages direct delivery.",
            ),
            &stuck,
            Some("the folder is gone.".into()),
        );
        assert_eq!(
            (managed.status, managed.code.as_str()),
            (400, "invalid_settings")
        );
        assert_eq!(
            managed.message,
            "Your organization manages direct delivery. These could not be put back and stay changed: auto_join_general. Putting them back failed: the folder is gone."
        );
        let internal = refused(RpcError::new(ErrorKind::Internal, "disk full"), &[], None);
        assert_eq!(internal.status, 500);
    }
}
