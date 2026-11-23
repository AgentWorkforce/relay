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
//! A setting may be changed with no confirmation, except a change that
//! widens who can reach or act as the person, which is the person's to make
//! in Settings (`settings_registry::person_only`): turning on one of
//! `PERSON_TURNS_ON` (or a part of `PERSON_TURNS_ON_PART`), or adding to one
//! of `PERSON_ADDS`, such as the senders trusted like the person, or setting
//! one of `PERSON_SETS`, such as the inbox whose replies answer the person's
//! questions. Narrowing one (turning it off, removing entries, clearing it)
//! is an agent's too. Each change is
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
use crate::relay::settings_registry::{
    describe, person_only, writing, PERSON_ADDS, PERSON_SETS, PERSON_TURNS_ON, PERSON_WIDENS,
    RECORDS,
};
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
        let (changed, outcome, unrestored) = apply(&self.core, &changes, &by)?;
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
/// the outcome, and why a put-back failed; or, changing nothing, the
/// refusal of a change only the person makes, judged against the values
/// under the lock so no other writer's change slips in between.
fn apply(
    core: &Core,
    changes: &Map<String, Value>,
    by: &str,
) -> Result<
    (
        Vec<AgentSettingsChange>,
        Result<(), RpcError>,
        Option<String>,
    ),
    OutboundError,
> {
    let _writing = writing();
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let before = core.settings();
    if let Some(refusal) = widening(&before, &saved_folder(core), changes) {
        return Err(refusal);
    }
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
    Ok((changed, outcome, unrestored))
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

/// Whether the store keeps `key` (spawning's and question escalation's
/// among them); the rest are tools' settings.
fn store_key(key: &str) -> bool {
    crate::relay::store_settings::STORE_SETTINGS.contains(&key)
        || crate::relay::spawn::settings::KEYS.contains(&key)
        || crate::relay::question::settings::KEYS.contains(&key)
}

/// Whether a Claude Code folder is added in Settings already, as saved:
/// `claude_config_dirs` does not show every one (a deleted folder, one also
/// found another way), and `settings.set` keeps those.
fn saved_folder(core: &Core) -> impl Fn(&str) -> bool + '_ {
    let env = |key: &str| core.config.env.get(key).cloned();
    let relay_home = crate::relay::workspace::relay_home(&env, &core.config.home);
    let dirs =
        crate::relay::claude_dirs::ClaudeDirs::from_env(&env, &core.config.home, &relay_home);
    move |folder| dirs.is_added(folder, &core.config.home)
}

/// The refusal of the first change in `changes` only the person makes,
/// given the settings now and the folders saved as added: one that widens
/// who can reach or act as them. A value a setting already has widens
/// nothing.
fn widening(
    values: &Map<String, Value>,
    saved_folder: &dyn Fn(&str) -> bool,
    changes: &Map<String, Value>,
) -> Option<OutboundError> {
    let (key, _) = changes
        .iter()
        .find(|(key, asked)| widens(values, saved_folder, key, asked))?;
    let rule = person_only(key).unwrap_or_default();
    Some(OutboundError::new(403, "person_only_setting", rule))
}

/// Whether changing `key` to `asked` turns on what only the person turns
/// on, or adds an entry only the person adds.
fn widens(
    values: &Map<String, Value>,
    saved_folder: &dyn Fn(&str) -> bool,
    key: &str,
    asked: &Value,
) -> bool {
    // `true`, or `"on"` for a setting read and written as `"on"`/`"off"`.
    let on = |value: Option<&Value>| {
        matches!(value, Some(Value::Bool(true))) || value.and_then(Value::as_str) == Some("on")
    };
    let now = observed(values, key, asked);
    if PERSON_TURNS_ON.contains(&key) {
        return on(Some(asked)) && !on(now.as_ref());
    }
    if PERSON_SETS.contains(&key) {
        // A value other than the one set now; clearing it widens nothing.
        fn text(value: Option<&Value>) -> &str {
            value
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
        }
        let wanted = text(Some(asked));
        return !wanted.is_empty() && !wanted.eq_ignore_ascii_case(text(now.as_ref()));
    }
    if PERSON_ADDS.contains(&key) {
        return added(values, saved_folder, key, asked);
    }
    if PERSON_WIDENS.contains(&key) {
        return asked
            .as_str()
            .is_some_and(|asked| crate::relay::delegation::Accept::widens(asked, now.as_ref()));
    }
    match key {
        // One folder, shared when it was not (or is not watched yet).
        "claude_config_dir" => {
            on(asked.get("shared")) && !on(watched(values, asked).and_then(|f| f.get("shared")))
        }
        // A harness given full access it did not have.
        "spawn_harnesses" => asked
            .as_object()
            .into_iter()
            .flatten()
            .any(|(id, harness)| {
                let had = values
                    .get(key)
                    .and_then(|harnesses| harnesses.get(id))
                    .and_then(|harness| harness.get("full_access"));
                on(harness.get("full_access")) && !on(had)
            }),
        _ => false,
    }
}

/// The watched folder a one-folder change names, as `set_shared` finds it:
/// by its path trimmed, or the folder that path really is.
fn watched<'a>(values: &'a Map<String, Value>, asked: &Value) -> Option<&'a Value> {
    let path = std::path::Path::new(asked.get("path")?.as_str()?.trim());
    let real = |path: &std::path::Path| std::fs::canonicalize(path).ok();
    values
        .get("claude_config_dirs")?
        .as_array()?
        .iter()
        .find(|folder| {
            let Some(known) = folder.get("path").and_then(Value::as_str) else {
                return false;
            };
            let known = std::path::Path::new(known);
            known == path || real(known).is_some_and(|known| Some(known) == real(path))
        })
}

/// Whether the list `asked` names an entry `key` does not have now: the
/// folder list by the folders saved as added; a list of names or
/// repositories trimmed and without case, as the trusted senders are saved.
fn added(
    values: &Map<String, Value>,
    saved_folder: &dyn Fn(&str) -> bool,
    key: &str,
    asked: &Value,
) -> bool {
    let now: Vec<&Value> = values
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let has = |entry: &str| match key {
        "claude_config_dirs" => saved_folder(entry),
        _ => now
            .iter()
            .filter_map(|known| known.as_str())
            .any(|known| known.trim().eq_ignore_ascii_case(entry)),
    };
    asked
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .any(|entry| !entry.is_empty() && !has(entry))
}

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

    fn refusal(values: Value, changes: Value) -> Option<(u16, String, String)> {
        folders_refusal(values, &[], changes)
    }

    fn folders_refusal(
        values: Value,
        saved: &[&str],
        changes: Value,
    ) -> Option<(u16, String, String)> {
        let saved_folder = |folder: &str| saved.contains(&folder);
        widening(&map(values), &saved_folder, &checked(map(changes)).unwrap())
            .map(|error| (error.status, error.code, error.message))
    }

    /// Each setting that widens who can reach or act as the person is the
    /// person's to turn on; an agent may turn it off, and one already on
    /// widens nothing.
    #[test]
    fn an_agent_may_turn_off_but_not_on_what_widens_trust() {
        for key in PERSON_TURNS_ON {
            let (yes, no) = (json!(true), json!(false));
            let (status, code, message) =
                refusal(json!({key: no.clone()}), json!({key: yes.clone()})).expect(key);
            assert_eq!((status, code.as_str()), (403, "person_only_setting"));
            assert_eq!(
                message,
                format!("Only the person can turn {key} on, in Agent Relay's Settings. An agent may turn it off.")
            );
            assert_eq!(refusal(json!({key: yes}), json!({key: no})), None, "{key}");
        }
        // Already on: nothing widens. The first-run default reads as direct
        // delivery itself.
        assert_eq!(
            refusal(
                json!({"auto_activate": true}),
                json!({"auto_activate": true})
            ),
            None
        );
        assert_eq!(
            refusal(
                json!({"direct_delivery": true}),
                json!({"direct_delivery_default": true})
            ),
            None
        );
        assert!(refusal(json!({}), json!({"direct_delivery_default": true})).is_some());
        // `false` turns nothing on.
        assert_eq!(
            refusal(json!({}), json!({"direct_delivery_default": false})),
            None
        );
        // One refused setting refuses the whole request.
        let (_, _, message) = refusal(
            json!({"auto_join_general": false, "spawn_allow_teammates": false}),
            json!({"auto_join_general": true, "spawn_allow_teammates": true}),
        )
        .unwrap();
        assert!(message.contains("spawn_allow_teammates"), "{message}");
        // What widens no one's reach stays an agent's to turn on.
        assert_eq!(
            refusal(
                json!({}),
                json!({"auto_join_general": true, "show_relay_messages": true})
            ),
            None
        );
    }

    /// Whose delegates' approvals count is the person's to widen; an agent
    /// may narrow it.
    #[test]
    fn an_agent_may_narrow_but_not_widen_whose_delegates_count() {
        let key = crate::relay::delegation::SETTING;
        for (now, asked) in [
            ("off", "own_owner"),
            ("own_owner", "code_owners"),
            ("off", "code_owners"),
        ] {
            let (status, code, message) =
                refusal(json!({key: now}), json!({key: asked})).expect(asked);
            assert_eq!((status, code.as_str()), (403, "person_only_setting"));
            assert_eq!(
                message,
                format!("Only the person can widen {key}, in Agent Relay's Settings. An agent may narrow it.")
            );
        }
        for (now, asked) in [
            ("code_owners", "own_owner"),
            ("own_owner", "off"),
            ("code_owners", "code_owners"),
        ] {
            assert_eq!(
                refusal(json!({key: now}), json!({key: asked})),
                None,
                "{asked}"
            );
        }
    }

    /// An agent may remove a trusted sender, but adding one, by a new name
    /// or among the old ones, is the person's.
    #[test]
    fn an_agent_may_remove_but_not_add_a_trusted_sender() {
        let now = json!({"trusted_relay_senders": ["ada-lovelace", "grace@relay.example"]});
        let (status, code, message) = refusal(
            now.clone(),
            json!({"trusted_relay_senders": ["ada-lovelace", "attacker"]}),
        )
        .unwrap();
        assert_eq!((status, code.as_str()), (403, "person_only_setting"));
        assert_eq!(
            message,
            "Only the person can add to trusted_relay_senders, in Agent Relay's Settings. An agent may remove entries."
        );
        for narrower in [
            json!(["ada-lovelace"]),
            json!([]),
            // Saved trimmed and without case: the same senders.
            json!([" Ada-Lovelace ", "GRACE@relay.example", ""]),
        ] {
            let change = json!({"trusted_relay_senders": narrower});
            assert_eq!(refusal(now.clone(), change.clone()), None, "{change}");
        }
        // Nothing listed yet: any entry is an addition.
        assert!(refusal(json!({}), json!({"trusted_relay_senders": ["a"]})).is_some());
        // Repositories spawned agents work in, likewise.
        let repos = json!({"spawn_repositories": ["acme/web"]});
        assert!(refusal(
            repos.clone(),
            json!({"spawn_repositories": ["acme/web", "acme/api"]})
        )
        .is_some());
        assert_eq!(refusal(repos, json!({"spawn_repositories": []})), None);
    }

    /// A Claude Code folder's sessions are put on the relay once it is
    /// added and shared: both are the person's; removing and unsharing are
    /// an agent's too.
    #[test]
    fn an_agent_may_unshare_but_not_add_or_share_a_claude_folder() {
        let folder = |path: &str, origin: &str, shared: bool| json!({"path": path, "origin": origin, "shared": shared});
        let now = json!({"claude_config_dirs": [
            folder("/h/.claude", "default", false),
            folder("/opt/claude", "added", true),
        ]});
        // Judged against the folders saved as added, which the list read
        // does not show whole: `/gone/claude` was deleted since.
        let saved = ["/opt/claude", "/gone/claude"];
        let folders =
            |list: Value| folders_refusal(now.clone(), &saved, json!({"claude_config_dirs": list}));
        assert!(folders(json!(["/opt/claude", "/srv/claude"])).is_some());
        // The default folder is watched already, but adding it is not the
        // person's choice.
        assert!(folders(json!(["/h/.claude"])).is_some());
        assert_eq!(folders(json!([])), None);
        // Removing one while keeping a deleted one adds nothing.
        assert_eq!(folders(json!(["/gone/claude"])), None);
        let share = |path: &str, shared: bool| json!({"claude_config_dir": {"path": path, "shared": shared}});
        let (_, _, message) = refusal(now.clone(), share("/h/.claude", true)).unwrap();
        assert_eq!(
            message,
            "Only the person can turn shared on in claude_config_dir, in Agent Relay's Settings. An agent may turn it off."
        );
        assert!(refusal(now.clone(), share("/not/watched", true)).is_some());
        assert_eq!(
            refusal(now.clone(), share("/opt/claude", true)),
            None,
            "shared already"
        );
        assert_eq!(
            refusal(now.clone(), share(" /opt/claude ", true)),
            None,
            "trimmed"
        );
        assert_eq!(refusal(now, share("/opt/claude", false)), None);
        // A folder named through a link to it is that folder. (Windows
        // needs a privilege to make a link.)
        #[cfg(unix)]
        {
            let temp = tempfile::tempdir().unwrap();
            let shared = temp.path().join("claude");
            std::fs::create_dir(&shared).unwrap();
            let link = temp.path().join("link");
            std::os::unix::fs::symlink(&shared, &link).unwrap();
            let now =
                json!({"claude_config_dirs": [folder(shared.to_str().unwrap(), "added", true)]});
            assert_eq!(
                refusal(now, share(link.to_str().unwrap(), true)),
                None,
                "through a link"
            );
        }
    }

    #[test]
    fn an_agent_may_confine_but_not_free_a_spawned_harness() {
        let now = json!({"spawn_harnesses": {"codex": {"full_access": true}, "pi": {"full_access": false}}});
        let free = |id: &str, on: bool| json!({"spawn_harnesses": {id: {"full_access": on}}});
        assert!(refusal(now.clone(), free("pi", true)).is_some());
        assert!(refusal(now.clone(), free("gemini", true)).is_some());
        assert_eq!(refusal(now.clone(), free("codex", true)), None);
        assert_eq!(refusal(now.clone(), free("codex", false)), None);
        let billing = json!({"spawn_harnesses": {"pi": {"billing": "api"}}});
        assert_eq!(refusal(now, billing), None);
    }

    /// The refusal is judged under the write lock and changes nothing.
    #[tokio::test]
    async fn a_batch_with_a_person_only_change_changes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let changes = map(json!({"auto_join_general": true, "direct_delivery": true}));
        let error = apply(&core, &changes, "api").unwrap_err();
        assert_eq!(
            (error.status, error.code.as_str()),
            (403, "person_only_setting")
        );
        let values = core.settings();
        assert_eq!(values["direct_delivery"], false);
        assert_eq!(values["auto_join_general"], false);
        assert_eq!(values["agent_changes"], json!([]));
        // Once the person turned it on, an agent may turn it off.
        core.set_settings(&map(json!({"direct_delivery": true})))
            .unwrap();
        let off = map(json!({"direct_delivery": false}));
        let (changed, outcome, _) = apply(&core, &off, "api").unwrap();
        assert!(outcome.is_ok());
        assert_eq!(changed[0].key, "direct_delivery");
        assert_eq!(core.settings()["direct_delivery"], false);
    }

    /// Question escalation's inbox answers as the person: an agent may turn
    /// escalation on and off, but only the person sets the inbox; an agent
    /// may clear it.
    #[tokio::test]
    async fn an_agent_turns_question_escalation_on_but_only_the_person_sets_its_inbox() {
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let error = apply(
            &core,
            &map(json!({"question_escalation_inbox": "mallory"})),
            "api",
        )
        .unwrap_err();
        assert_eq!(
            (error.status, error.code.as_str(), error.message.as_str()),
            (
                403,
                "person_only_setting",
                "Only the person can set question_escalation_inbox, in Agent Relay's Settings. An agent may clear it."
            )
        );
        let values = core.settings();
        // On unless turned off.
        assert_eq!(values["question_escalation"], "on");
        assert_eq!(values["question_escalation_inbox"], "");
        assert_eq!(values["agent_changes"], json!([]));
        // An agent may turn escalation off (and on again).
        let off = map(json!({"question_escalation": "off"}));
        assert!(apply(&core, &off, "api").unwrap().1.is_ok());
        assert_eq!(core.settings()["question_escalation"], "off");
        let on = map(json!({"question_escalation": "on"}));
        assert!(apply(&core, &on, "api").unwrap().1.is_ok());
        assert_eq!(core.settings()["question_escalation"], "on");
        assert!(apply(&core, &off, "api").unwrap().1.is_ok());
        assert_eq!(core.settings()["question_escalation"], "off");
        // The person may.
        core.set_settings(&map(json!({
            "question_escalation": "on",
            "question_escalation_inbox": "triage",
        })))
        .unwrap();
        let values = core.settings();
        assert_eq!(values["question_escalation"], "on");
        assert_eq!(values["question_escalation_inbox"], "triage");
        // The same inbox again widens nothing; another one does.
        let same = map(json!({"question_escalation_inbox": " Triage "}));
        assert!(apply(&core, &same, "api").unwrap().1.is_ok());
        let other = map(json!({"question_escalation_inbox": "mallory"}));
        assert_eq!(apply(&core, &other, "api").unwrap_err().status, 403);
        // An agent may clear the inbox and turn escalation off.
        let narrower = map(json!({
            "question_escalation": "off",
            "question_escalation_inbox": "",
        }));
        assert!(apply(&core, &narrower, "api").unwrap().1.is_ok());
        let values = core.settings();
        assert_eq!(values["question_escalation"], "off");
        assert_eq!(values["question_escalation_inbox"], "");
    }

    /// Question escalation is on unless turned off: an explicit off, from
    /// the person or an agent, stays off through writes of other settings
    /// and a restart (the store read again from its file); an explicit on
    /// stays on.
    #[tokio::test]
    async fn an_explicit_question_escalation_off_survives_a_restart() {
        let temp = tempfile::tempdir().unwrap();
        {
            let first = core(temp.path());
            assert_eq!(first.settings()["question_escalation"], "on");
            first
                .set_settings(&map(json!({"question_escalation": "off"})))
                .unwrap();
            first
                .set_settings(&map(json!({"auto_join_general": true})))
                .unwrap();
            first
                .set_settings(&map(json!({"question_escalation_inbox": "triage"})))
                .unwrap();
            let other = map(json!({"show_relay_messages": true}));
            assert!(apply(&first, &other, "api").unwrap().1.is_ok());
            assert_eq!(first.settings()["question_escalation"], "off");
        }
        let second = core(temp.path());
        let values = second.settings();
        assert_eq!(values["question_escalation"], "off");
        assert_eq!(values["auto_join_general"], true);
        assert_eq!(values["question_escalation_inbox"], "triage");
        // Turned on by an agent, it stays on across a restart too.
        let on = map(json!({"question_escalation": "on"}));
        assert!(apply(&second, &on, "api").unwrap().1.is_ok());
        drop(second);
        assert_eq!(core(temp.path()).settings()["question_escalation"], "on");
    }

    /// The organization's policy decides question escalation both ways: a
    /// lock holds `off` against the default, and `on` against the person's
    /// own off, and either is refused to the app and to agents; a default
    /// `off` is written once over the unset default and stays the person's
    /// to change.
    #[tokio::test]
    async fn the_organization_policy_decides_question_escalation_both_ways() {
        use crate::relay::settings_policy::{SettingsPolicy, LOCKED};
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let given =
            |value: serde_json::Value| -> SettingsPolicy { serde_json::from_value(value).unwrap() };
        let (on, off) = (
            map(json!({"question_escalation": "on"})),
            map(json!({"question_escalation": "off"})),
        );
        // Locked off, over the unset (on) default.
        core.apply_settings_policy(Some(given(
            json!({"locked": {"question_escalation": "off"}}),
        )))
        .unwrap();
        assert_eq!(core.settings()["question_escalation"], "off");
        assert_eq!(
            core.store.read(|store| store.extras.question_escalation),
            Some(false)
        );
        assert_eq!(core.set_settings(&on).unwrap_err().message, LOCKED);
        let (_, outcome, _) = apply(&core, &on, "api").unwrap();
        assert_eq!(outcome.unwrap_err().message, LOCKED);
        assert_eq!(core.settings()["question_escalation"], "off");
        assert!(core
            .store
            .read(|store| !crate::relay::question::settings::on(store)));
        // Locked on, over an explicit off.
        core.apply_settings_policy(Some(given(
            json!({"locked": {"question_escalation": "on"}}),
        )))
        .unwrap();
        assert_eq!(core.settings()["question_escalation"], "on");
        assert_eq!(core.set_settings(&off).unwrap_err().message, LOCKED);
        let (_, outcome, _) = apply(&core, &off, "api").unwrap();
        assert_eq!(outcome.unwrap_err().message, LOCKED);
        assert_eq!(core.settings()["question_escalation"], "on");
        assert_eq!(
            core.settings()["organization_policy"]["locked"],
            json!(["question_escalation"])
        );
        // Lifted: the value stays, and is the person's again.
        core.apply_settings_policy(None).unwrap();
        core.set_settings(&off).unwrap();
        assert_eq!(core.settings()["question_escalation"], "off");

        // Defaulted off on a computer that never set it.
        let fresh = tempfile::tempdir().unwrap();
        let fresh = self::core(fresh.path());
        fresh
            .apply_settings_policy(Some(given(
                json!({"defaults": {"question_escalation": "off"}}),
            )))
            .unwrap();
        assert_eq!(fresh.settings()["question_escalation"], "off");
        fresh.set_settings(&on).unwrap();
        fresh
            .apply_settings_policy(fresh.settings_policy())
            .unwrap();
        assert_eq!(
            fresh.settings()["question_escalation"],
            "on",
            "the person's choice is not reversed"
        );
    }

    /// A core whose store file, before it starts, is `store` as an older
    /// build saved it.
    fn core_from_old_store(temp: &std::path::Path, store: Value) -> std::sync::Arc<Core> {
        let data = temp.join("app-data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            data.join(crate::relay::app_store::STORE_FILE),
            serde_json::to_vec(&store).unwrap(),
        )
        .unwrap();
        core(temp)
    }

    /// Before question escalation was on by default, an unset flag read off,
    /// so an organization's default of off was recorded as already in place
    /// and never written. Such a store keeps reading off after the upgrade,
    /// and applying the same policy again keeps it off.
    #[tokio::test]
    async fn an_organization_default_of_off_survives_the_upgrade() {
        let temp = tempfile::tempdir().unwrap();
        let core = core_from_old_store(
            temp.path(),
            json!({"organizationPolicy": {
                "policy": {"defaults": {"question_escalation": "off"}},
                "appliedDefaults": {"question_escalation": {"given": "off", "applied": "off"}},
            }}),
        );
        assert_eq!(core.settings()["question_escalation"], "off");
        core.apply_settings_policy(core.settings_policy()).unwrap();
        assert_eq!(core.settings()["question_escalation"], "off");
        drop(core);
        assert_eq!(
            self::core(temp.path()).settings()["question_escalation"],
            "off"
        );
    }

    /// A stored lock of off holds from the start, before the policy is
    /// applied again.
    #[tokio::test]
    async fn a_stored_lock_of_off_holds_from_the_start() {
        let temp = tempfile::tempdir().unwrap();
        let core = core_from_old_store(
            temp.path(),
            json!({"organizationPolicy": {"policy": {"locked": {"question_escalation": "off"}}}}),
        );
        assert_eq!(core.settings()["question_escalation"], "off");
    }

    /// Only those two stores change: the person's own on stays on under a
    /// default of off; with no policy, a removed one, or a default of on,
    /// an unset flag reads on and stays unset.
    #[tokio::test]
    async fn the_upgrade_keeps_every_other_question_escalation_as_it_reads() {
        let default_off = json!({
            "policy": {"defaults": {"question_escalation": "off"}},
            "appliedDefaults": {"question_escalation": {"given": "off", "applied": "off"}},
        });
        for (store, reads, stored) in [
            (
                json!({"questionEscalation": true, "organizationPolicy": default_off}),
                "on",
                Some(true),
            ),
            (json!({}), "on", None),
            (
                json!({"organizationPolicy": {"policy": null, "appliedDefaults":
                    {"question_escalation": {"given": "off", "applied": "off"}}}}),
                "on",
                None,
            ),
            (
                json!({"organizationPolicy": {
                    "policy": {"defaults": {"question_escalation": "on"}},
                    "appliedDefaults": {"question_escalation": {"given": "on", "applied": "on"}},
                }}),
                "on",
                None,
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let core = core_from_old_store(temp.path(), store.clone());
            assert_eq!(core.settings()["question_escalation"], reads, "{store}");
            assert_eq!(
                core.store.read(|store| store.extras.question_escalation),
                stored,
                "{store}"
            );
        }
    }

    /// The organization's locks are written once and refused to the app
    /// and to agents alike; its defaults stay the person's to change.
    #[tokio::test]
    async fn an_organization_lock_is_applied_and_refused_to_everyone() {
        use crate::relay::settings_policy::{SettingsPolicy, LOCKED};
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let policy: SettingsPolicy = serde_json::from_value(json!({
            "locked": {"spawn_max_agents": 2, "accept_spawns": true},
            "defaults": {"auto_join_general": true},
        }))
        .unwrap();
        core.apply_settings_policy(Some(policy)).unwrap();
        let values = core.settings();
        assert_eq!(values["spawn_max_agents"], 2);
        assert_eq!(values["auto_join_general"], true);
        assert_eq!(
            values["organization_policy"],
            json!({
                "locked": ["spawn_max_agents"],
                "defaults": ["auto_join_general"],
                "mismatched": ["accept_spawns"],
                "managed": false,
            })
        );
        let refused = core
            .set_settings(&map(json!({"spawn_max_agents": 6})))
            .unwrap_err();
        assert_eq!(refused.message, LOCKED);
        let (_, outcome, _) = apply(&core, &map(json!({"spawn_max_agents": 6})), "api").unwrap();
        assert_eq!(outcome.unwrap_err().message, LOCKED);
        assert_eq!(core.settings()["spawn_max_agents"], 2);
        // A default is the person's to change, and stays changed.
        core.set_settings(&map(json!({"auto_join_general": false})))
            .unwrap();
        core.apply_settings_policy(core.settings_policy()).unwrap();
        assert_eq!(core.settings()["auto_join_general"], false);
        // Agents see the lock in GET /settings.
        let listed = crate::relay::settings_registry::describe(&core.settings());
        let max = listed
            .iter()
            .find(|entry| entry["key"] == "spawn_max_agents")
            .unwrap();
        assert_eq!(
            (max["writable"].clone(), max["organization"].clone()),
            (json!(false), json!(LOCKED))
        );
        // No policy any more: the values stay, and are the person's again.
        core.apply_settings_policy(None).unwrap();
        assert!(core.settings().get("organization_policy").is_none());
        core.set_settings(&map(json!({"spawn_max_agents": 6})))
            .unwrap();
    }

    /// A lock that becomes a default, or another lock, takes its new value:
    /// the saves made while applying re-apply the new policy's locks, not
    /// the old one's, and the new default is recorded as written.
    #[tokio::test]
    async fn a_policy_change_writes_its_own_values() {
        use crate::relay::settings_policy::SettingsPolicy;
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let given =
            |value: serde_json::Value| -> SettingsPolicy { serde_json::from_value(value).unwrap() };
        core.apply_settings_policy(Some(given(json!({"locked": {"spawn_max_agents": 4}}))))
            .unwrap();
        assert_eq!(core.settings()["spawn_max_agents"], 4);
        core.apply_settings_policy(Some(given(json!({"locked": {"spawn_max_agents": 2}}))))
            .unwrap();
        assert_eq!(core.settings()["spawn_max_agents"], 2);
        core.apply_settings_policy(Some(given(json!({"defaults": {"spawn_max_agents": 3}}))))
            .unwrap();
        assert_eq!(core.settings()["spawn_max_agents"], 3);
        let recorded = core.store.read(|store| {
            store.organization_policy.as_ref().unwrap().applied_defaults["spawn_max_agents"].clone()
        });
        assert_eq!((recorded.given, recorded.applied), (json!(3), json!(3)));
        // The repositories list follows a lock that becomes a default too.
        core.apply_settings_policy(Some(given(
            json!({"locked": {"auto_join_repositories": ["acme/*"]}}),
        )))
        .unwrap();
        assert_eq!(core.settings()["auto_join_repositories"], json!(["acme/*"]));
        core.apply_settings_policy(Some(given(
            json!({"defaults": {"auto_join_repositories": ["Tools/Web"]}}),
        )))
        .unwrap();
        assert_eq!(
            core.settings()["auto_join_repositories"],
            json!(["tools/web"])
        );
        assert!(core.forced_repositories().is_empty());
    }

    /// The repositories list is saved normalized; only the organization's
    /// lock makes its sessions join whatever automatic activation says, and
    /// a matching directory is labelled with its owner/name.
    #[tokio::test]
    async fn auto_join_repositories_is_saved_and_forced_only_when_locked() {
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        assert_eq!(core.settings()["auto_join_repositories"], json!([]));
        core.set_settings(&map(
            json!({"auto_join_repositories": ["Acme/Web", "acme/web", "tools/*"]}),
        ))
        .unwrap();
        assert_eq!(
            core.settings()["auto_join_repositories"],
            json!(["acme/web", "tools/*"])
        );
        let bad = core
            .set_settings(&map(json!({"auto_join_repositories": ["/home/me/web"]})))
            .unwrap_err();
        assert!(bad.message.contains("owner/name"), "{}", bad.message);
        assert_eq!(core.auto_join_repositories(), vec!["acme/web", "tools/*"]);
        // The person's own list forces nothing.
        assert!(core.forced_repositories().is_empty());

        let repo = temp.path().join("web");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(
            repo.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://github.com/acme/web.git\n",
        )
        .unwrap();
        assert_eq!(
            core.repository_label(repo.to_str()).as_deref(),
            Some("acme/web")
        );

        let policy: crate::relay::settings_policy::SettingsPolicy =
            serde_json::from_value(json!({"locked": {"auto_join_repositories": ["acme/*"]}}))
                .unwrap();
        core.apply_settings_policy(Some(policy)).unwrap();
        assert_eq!(core.forced_repositories(), vec!["acme/*"]);
        assert_eq!(
            core.settings()["organization_policy"]["locked"],
            json!(["auto_join_repositories"])
        );
        assert!(core
            .set_settings(&map(json!({"auto_join_repositories": []})))
            .is_err());
        // The lock forces its own list, whatever the saved one says.
        core.write_settings(&map(json!({"auto_join_repositories": ["me/fork"]})))
            .unwrap();
        assert_eq!(core.forced_repositories(), vec!["acme/*"]);
        // A lock that is not a valid list forces nothing.
        let malformed: crate::relay::settings_policy::SettingsPolicy =
            serde_json::from_value(json!({"locked": {"auto_join_repositories": ["/home/me/web"]}}))
                .unwrap();
        core.apply_settings_policy(Some(malformed)).unwrap();
        assert!(core.forced_repositories().is_empty());
        core.apply_settings_policy(None).unwrap();
        assert!(core.forced_repositories().is_empty());
    }

    /// A locked hold reaches the delivery policy and is lifted with the
    /// policy; a defaulted one seeds the person's restriction once.
    #[tokio::test]
    async fn the_delivery_section_holds_or_seeds_the_restriction() {
        use crate::relay::settings_policy::SettingsPolicy;
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let locked: SettingsPolicy = serde_json::from_value(json!({
            "locked": {"inbound_default": "hold", "admin_senders": ["lead"]},
        }))
        .unwrap();
        core.apply_settings_policy(Some(locked)).unwrap();
        assert!(core.claude_delivery_status().organization_hold);
        assert!(core
            .set_claude_sender_delivery("sam@desk", "Sam", true)
            .is_err());
        core.apply_settings_policy(None).unwrap();
        assert!(!core.claude_delivery_status().organization_hold);

        let defaulted: SettingsPolicy =
            serde_json::from_value(json!({"defaults": {"inbound_default": "hold"}})).unwrap();
        core.apply_settings_policy(Some(defaulted.clone())).unwrap();
        assert!(!core.claude_delivery_status().organization_hold);
        assert!(core.claude_delivery_status().restricted);
        // The person turns it off: the default is not written again.
        core.set_claude_delivery_restricted(false).unwrap();
        core.apply_settings_policy(Some(defaulted)).unwrap();
        assert!(!core.claude_delivery_status().restricted);
    }

    /// Moving between a locked hold and a defaulted one never leaves a
    /// moment when neither the organization nor the person holds unknown
    /// senders.
    #[tokio::test]
    async fn a_hold_handed_between_organization_and_person_never_opens() {
        use crate::relay::settings_policy::SettingsPolicy;
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let locked: SettingsPolicy = serde_json::from_value(json!({
            "locked": {"inbound_default": "hold", "admin_senders": ["lead"]},
        }))
        .unwrap();
        let defaulted: SettingsPolicy =
            serde_json::from_value(json!({"defaults": {"inbound_default": "hold"}})).unwrap();
        core.apply_settings_policy(Some(locked.clone())).unwrap();
        core.claude_delivery.states.lock().unwrap().clear();
        core.apply_settings_policy(Some(defaulted)).unwrap();
        let states = core.claude_delivery.states.lock().unwrap().clone();
        assert!(!states.contains(&(false, false)), "{states:?}");
        assert_eq!(states.last(), Some(&(false, true)));
        // And back: the organization's hold is in place before anything else.
        core.claude_delivery.states.lock().unwrap().clear();
        core.apply_settings_policy(Some(locked)).unwrap();
        let states = core.claude_delivery.states.lock().unwrap().clone();
        assert!(!states.contains(&(false, false)), "{states:?}");
        assert_eq!(states.last(), Some(&(true, true)));
    }

    /// Lifting the policy keeps the organization's hold when the removal
    /// cannot be saved: the stored policy and the hold never disagree.
    #[tokio::test]
    async fn a_failed_lift_keeps_the_hold() {
        use crate::relay::settings_policy::SettingsPolicy;
        let temp = tempfile::tempdir().unwrap();
        let core = core(temp.path());
        let locked: SettingsPolicy = serde_json::from_value(json!({
            "locked": {"inbound_default": "hold", "admin_senders": ["lead"]},
        }))
        .unwrap();
        core.apply_settings_policy(Some(locked)).unwrap();
        assert!(core.claude_delivery.organization_holds());
        // The store file changed into something this core cannot read, so
        // the next save fails.
        std::fs::write(
            temp.path().join("app-data/injectable-agents.json"),
            "not json",
        )
        .unwrap();
        assert!(core.apply_settings_policy(None).is_err());
        assert!(core.claude_delivery.organization_holds());
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

    /// Tools' settings: `claude_session_hook` takes a change, `grok_leader`
    /// refuses every one, `analytics_enabled` turns on but not off.
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
                "claude_session_hook": load(&self.hook),
                "analytics_enabled": load(&self.sticky),
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
                "claude_session_hook" => store(&self.hook),
                "direct_delivery" | "direct_delivery_default" => store(&self.direct),
                // Turns on, but refuses to turn off again.
                "analytics_enabled" if on => store(&self.sticky),
                "analytics_enabled" => Some(Err("It cannot be turned off now.".into())),
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
            "claude_session_hook": true,
            "grok_leader": false,
        }));
        let (changed, outcome, unrestored) = apply(&core, &changes, "api").unwrap();
        assert_eq!(outcome.unwrap_err().message, "Grok is not installed.");
        assert!(changed.is_empty(), "{changed:?}");
        assert_eq!(unrestored, None);
        assert_eq!(core.settings()["claude_session_hook"], false, "put back");
        let store = core.store.snapshot();
        assert_eq!(
            store.integration_defaults_applied.unwrap_or_default(),
            Vec::<String>::new(),
            "a change that did not stand is no choice the default pass must keep"
        );
        assert_eq!(store.accept_spawns, None, "never written");
        assert_eq!(store.extras.auto_join_general, None, "never written");
        let choices = || core.store.read(|s| s.integration_defaults_applied.clone());
        // A setting that cannot be put back stays changed and stays the
        // person's choice, so no default pass undoes it.
        let sticky = map(json!({"analytics_enabled": true, "grok_leader": false}));
        let (changed, outcome, unrestored) = apply(&core, &sticky, "api").unwrap();
        assert!(outcome.is_err());
        assert_eq!(unrestored.as_deref(), Some("It cannot be turned off now."));
        let keys: Vec<&str> = changed.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["analytics_enabled"]);
        assert_eq!(choices(), Some(vec!["analytics_enabled".to_string()]));
        // Without the refusing setting, every one changes and is reported.
        let changes = map(json!({"auto_join_general": true, "claude_session_hook": true}));
        let (changed, outcome, _) = apply(&core, &changes, "api").unwrap();
        assert!(outcome.is_ok());
        assert_eq!(changed.len(), 2, "{changed:?}");
        assert_eq!(core.settings()["auto_join_general"], true);
        // Recorded in the order made, newest first, also within one second.
        let later = map(json!({"claude_session_hook": false}));
        let _ = apply(&core, &later, "reviewer").unwrap();
        let record = core.store.read(|store| store.extras.agent_changes.clone());
        let keys: Vec<(&str, &str)> = record
            .iter()
            .map(|change| (change.by.as_str(), change.key.as_str()))
            .collect();
        assert_eq!(
            keys,
            [
                ("reviewer", "claude_session_hook"),
                ("api", "claude_session_hook"),
                ("api", "auto_join_general"),
                ("api", "analytics_enabled"),
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
                let on = map(json!({"claude_session_hook": i % 2 == 0}));
                let _ = apply(&changing, &on, "api").unwrap();
            }
        });
        let mut samples = 0;
        while !writer.is_finished() || samples == 0 {
            let _writing = writing();
            let hook = core.settings()["claude_session_hook"] == true;
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
