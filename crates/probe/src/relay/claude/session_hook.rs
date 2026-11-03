//! Agent Relay's optional Claude Code SessionStart hook.
//!
//! Michael's sessions stay off the relay until someone puts them on.
//! When the setting is on, each Claude login the desktop knows about
//! (`ClaudeSettings::login_settings`) gets one command hook. At session
//! start that command asks `GET /setup/status` with
//! `X-Agent-Relay-Observe: 1`, which reads status and does not apply the
//! agent-led defaults. When `session.registered` is false and sessions may
//! register themselves, it tells Claude to ask the person whether to put
//! the session on the relay, and under what name, and to `POST /register`
//! only if they say yes. The person sees a shorter notice. A session
//! already on the relay is reminded who it is there, how to reach peers
//! and the working norm ([`hosted_mcp::preamble`]); that says nothing to
//! the person, so it is given to automated runs too.
//! Only a session a person is typing in is told anything: a `claude -p`,
//! Agent SDK or structured pipe run (a flows step, cron, CI) has nobody to
//! answer, so the hook stays quiet there ([`has_person`]). When that setting is off, the nudge says so and does
//! not offer a command that would be refused. It never registers the
//! session, and it prints nothing when the status cannot be read.
//!
//! The hook is on by default after sign-in, preserving a saved Off choice.
//! Its join prompt is active only with selected-session sharing. It is installed only into shared
//! logins (`login_settings`). Turning it off, and a refresh while it is on,
//! also clear it from a watched login that has since been unshared
//! (`watched_logins`). A directory the desktop does not watch is left alone.
//!
//! With the hook come Claude Code permission rules ([`PermissionRules`],
//! in `permissions`) that let the session run this probe's self-limiting
//! session commands (`relay read`, `send`, `agents`, `whoami`,
//! `fetch-attachment`, `connect-send`) on this core's session socket without an approval
//! prompt, so it can read and answer a relayed message in Claude's default
//! permission mode. They go into and out of the same `settings.json` with
//! the hook. Taking the hook out leaves the file as the person had it: their
//! own copy (`.relay-desktop-backup`) goes back byte for byte when nothing
//! else changed, and a file Agent Relay created goes once it is empty.

use crate::relay::agents::SettingsExtension;
use crate::relay::claude::ClaudeConfig;
use crate::relay::claude_settings::{
    claude_settings_edit_lock, resolve_symlinks, write_keeping_file, ClaudeSettings,
};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod output;
#[cfg(test)]
mod permission_tests;
mod permissions;
mod rollback;
pub use output::{
    claude_ancestor, has_person, hook_output, joining, nudge, read_probe, read_status,
    registration_off, StatusRead, JOINING_FOR_PERSON, NUDGE_FOR_PERSON, OBSERVE_HEADER,
    OBSERVE_VALUE,
};
#[cfg(test)]
pub use permissions::covers;
pub use permissions::PermissionRules;
use rollback::store_planned;

/// Appended to a settings file's name for the one-time copy of the person's
/// own file.
const BACKUP_SUFFIX: &str = ".relay-desktop-backup";

/// The `settings.set` key this extension owns.
pub const SETTING: &str = "claude_session_hook";

/// The subcommand the hook runs; also how the hook is recognized as ours.
pub const SUBCOMMAND: &str = "relay claude-session-hook";

/// Installs and removes the hook. The files are the source of truth, so the
/// setting is on when any known login has this build's hook.
pub struct ClaudeSessionHookSettings {
    claude: ClaudeSettings,
    command: String,
    /// The permission rules that come with the hook, and the core's data
    /// folder, which records the rules Agent Relay added.
    permissions: Option<(PermissionRules, PathBuf)>,
    /// The space-free link the rules name when the probe's path needs
    /// quoting (`probe_alias`), as the reply hints do.
    alias: Option<std::sync::Arc<crate::relay::probe_alias::ProbeAlias>>,
    lock: Mutex<()>,
}

impl ClaudeSessionHookSettings {
    pub fn new(claude: &ClaudeConfig, command: String) -> ClaudeSessionHookSettings {
        ClaudeSessionHookSettings {
            claude: ClaudeSettings::new(claude),
            command,
            permissions: None,
            alias: None,
            lock: Mutex::new(()),
        }
    }

    /// Also writes [`PermissionRules`] while the hook is on, recording the
    /// ones it adds in `state_dir` (the core's data folder).
    pub fn with_permission_rules(mut self, rules: PermissionRules, state_dir: PathBuf) -> Self {
        self.permissions = Some((rules, state_dir));
        self
    }

    /// Names the probe in the rules by `alias` when its path needs quoting.
    pub fn with_probe_alias(
        mut self,
        alias: std::sync::Arc<crate::relay::probe_alias::ProbeAlias>,
    ) -> Self {
        self.alias = Some(alias);
        self
    }

    /// The permission rules wanted with the hook; none without them. They
    /// name the probe as the hints do now: its link while that is kept.
    fn rules(&self) -> Vec<String> {
        self.permissions
            .as_ref()
            .map(|(rules, _)| match &self.alias {
                Some(alias) => PermissionRules {
                    probe: alias.probe(),
                    socket: rules.socket.clone(),
                }
                .rules(),
                None => rules.rules(),
            })
            .unwrap_or_default()
    }

    /// Turns the hook on or off, keeping the probe's link while its rules
    /// are in a file and letting it go once they are not.
    fn edit_with_alias(&self, enable: bool) -> Result<(), String> {
        use crate::relay::probe_alias::User;
        let Some(alias) = self.alias.as_ref().filter(|_| self.permissions.is_some()) else {
            return self.edit(enable);
        };
        if enable {
            alias.acquire(User::Claude);
        }
        let outcome = self.edit(enable);
        if !self.hook_enabled() {
            alias.release(User::Claude);
        }
        outcome
    }

    /// At an Agent Relay Dev start, which skips [`Self::refresh`]: keeps the
    /// probe's link while a hook's rules are on disk, so the hints name the
    /// same program the rules allow, and lets it go when the hook is off.
    pub fn reconcile_probe_alias(&self) {
        use crate::relay::probe_alias::User;
        let Some(alias) = self.alias.as_ref().filter(|_| self.permissions.is_some()) else {
            return;
        };
        let _guard = self.lock();
        if self.applies() && self.hook_enabled() {
            alias.acquire(User::Claude);
        } else {
            alias.release(User::Claude);
        }
    }

    /// The rules Agent Relay added, by file.
    fn added(&self) -> permissions::Added {
        self.permissions
            .as_ref()
            .map(|(_, dir)| permissions::Added::load(dir))
            .unwrap_or_default()
    }

    fn save_added(&self, added: &permissions::Added) -> Result<(), String> {
        match &self.permissions {
            Some((_, dir)) => added.save(dir),
            None => Ok(()),
        }
    }

    /// The shell command for `executable`, with `--dev` for Agent Relay Dev.
    pub fn command_for(executable: &Path, development: bool) -> String {
        let mut command = format!(
            "{} {SUBCOMMAND}",
            crate::relay::outbound::shell_quote(&executable.to_string_lossy())
        );
        if development {
            command.push_str(" --dev");
        }
        command
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// `settings.json` paths from `logins`, one per real file, skipping a
    /// login whose directory does not exist.
    fn paths_of(&self, logins: impl IntoIterator<Item = ClaudeSettings>) -> Vec<PathBuf> {
        let mut seen = std::collections::HashSet::new();
        logins
            .into_iter()
            .map(|login| login.user_settings)
            .filter(|path| {
                self.claude.dirs.settings_writable(path) && path.parent().is_some_and(Path::is_dir)
            })
            .filter(|path| {
                seen.insert(std::fs::canonicalize(path).unwrap_or_else(|_| path.clone()))
            })
            .collect()
    }

    /// Shared logins the hook is installed into. An unshared default is
    /// left out, so turning a folder off stops new nudges there.
    fn install_targets(&self) -> Vec<PathBuf> {
        let Some(home) = self.claude.user_settings.parent() else {
            return Vec::new();
        };
        let include_default = self.claude.dirs.default_shared(home);
        self.paths_of(
            self.claude
                .login_settings()
                .into_iter()
                .filter(|login| include_default || login.user_settings.parent() != Some(home)),
        )
    }

    /// Every watched login, shared or not. Turning the hook off and
    /// reporting whether it is on use this, so a hook installed before a
    /// folder was unshared is not forgotten.
    fn removal_targets(&self) -> Vec<PathBuf> {
        self.paths_of(self.claude.watched_logins())
    }

    fn applies(&self) -> bool {
        !self.removal_targets().is_empty()
    }

    fn login_name(path: &Path) -> String {
        path.parent()
            .and_then(|dir| dir.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Claude".into())
    }

    fn fail(path: &Path, why: &str) -> String {
        format!("{}/settings.json {why}.", Self::login_name(path))
    }

    fn read_object(&self, path: &Path) -> Result<Map<String, Value>, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
            Err(_) => return Err(Self::fail(path, "cannot be read")),
        };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Map::new());
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(object)) => Ok(object),
            Ok(_) => Err(Self::fail(
                path,
                "is not a JSON object, so it was left unchanged",
            )),
            Err(_) => Err(Self::fail(
                path,
                "is not valid JSON, so it was left unchanged",
            )),
        }
    }

    /// Writes `value`, the first time copying the file as it was beside it
    /// (`.relay-desktop-backup`). A file that already holds the hook is
    /// never the person's own copy.
    fn write(&self, path: &Path, value: &Value) -> Result<(), String> {
        self.claude.check_write_target(path)?;
        let path = resolve_symlinks(path);
        let existing = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(Self::fail(&path, "cannot be read")),
        };
        let existing = existing.filter(|bytes| {
            !serde_json::from_slice::<Value>(bytes).is_ok_and(|value| self.holds_ours(&value))
        });
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        write_keeping_file(&path, existing.as_deref(), &bytes, BACKUP_SUFFIX, 0o600)
            .map_err(|_| Self::fail(&path, "cannot be written"))
    }

    /// Whether `value` holds this build's hook. Its permission rules come
    /// and go with it; a rule alone may be the person's own.
    fn holds_ours(&self, value: &Value) -> bool {
        value["hooks"]["SessionStart"]
            .as_array()
            .is_some_and(|groups| !self.our_commands(groups).is_empty())
    }

    /// `value` with this build's hook and its permission rules (the current
    /// ones and `added`) taken out.
    fn without_ours(&self, value: &Value, added: &[String]) -> Value {
        let Some(mut object) = value.as_object().cloned() else {
            return value.clone();
        };
        self.remove_from(&mut object);
        let mut rules = self.rules();
        rules.extend(added.iter().cloned());
        permissions::take_out(&mut object, &rules);
        Value::Object(object)
    }

    /// This build's hook, in any version of the executable. Agent Relay and
    /// Agent Relay Dev (`--dev`) each keep their own.
    fn is_ours(&self, command: &str) -> bool {
        let dev = |command: &str| command.trim_end().ends_with(" --dev");
        let body = command.trim();
        let body = body.strip_suffix(" --dev").unwrap_or(body).trim_end();
        body.ends_with(SUBCOMMAND) && dev(command) == dev(&self.command)
    }

    fn our_commands<'a>(&self, groups: &'a [Value]) -> Vec<&'a str> {
        groups
            .iter()
            .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str())
            .filter(|command| self.is_ours(command))
            .collect()
    }

    /// Removes this build's hooks from `groups`, and any group that held
    /// only them. Whether anything changed.
    fn take_out(&self, groups: &mut Vec<Value>) -> bool {
        let before = groups.clone();
        for group in groups.iter_mut() {
            if let Some(hooks) = group["hooks"].as_array_mut() {
                hooks.retain(|hook| !hook["command"].as_str().is_some_and(|c| self.is_ours(c)));
            }
        }
        groups.retain(|group| {
            group["hooks"]
                .as_array()
                .is_none_or(|hooks| !hooks.is_empty())
        });
        *groups != before
    }

    fn entry(&self) -> Value {
        json!({"hooks": [{"type": "command", "command": self.command, "timeout": 10}]})
    }

    fn file_has_hook(&self, path: &Path) -> bool {
        self.read_object(path).is_ok_and(|object| {
            object
                .get("hooks")
                .and_then(|hooks| hooks.get("SessionStart"))
                .and_then(Value::as_array)
                .is_some_and(|groups| !self.our_commands(groups).is_empty())
        })
    }

    fn hook_enabled(&self) -> bool {
        self.removal_targets()
            .iter()
            .any(|path| self.file_has_hook(path))
    }

    fn shared_has_hook(&self) -> bool {
        self.install_targets()
            .iter()
            .any(|path| self.file_has_hook(path))
    }

    fn install_into(&self, path: &Path, object: &mut Map<String, Value>) -> Result<(), String> {
        let hooks = object.entry("hooks").or_insert_with(|| json!({}));
        let Some(hooks) = hooks.as_object_mut() else {
            return Err(Self::fail(
                path,
                "has a hooks value that is not an object, so it was left unchanged",
            ));
        };
        let start = hooks.entry("SessionStart").or_insert_with(|| json!([]));
        let Some(groups) = start.as_array_mut() else {
            return Err(Self::fail(
                path,
                "has a SessionStart value that is not a list, so it was left unchanged",
            ));
        };
        let entry = self.entry();
        let current = groups.contains(&entry) && self.our_commands(groups).len() == 1;
        if !current {
            self.take_out(groups);
            groups.push(entry);
        }
        Ok(())
    }

    fn remove_from(&self, object: &mut Map<String, Value>) {
        let Some(hooks) = object.get_mut("hooks").and_then(Value::as_object_mut) else {
            return;
        };
        let Some(groups) = hooks.get_mut("SessionStart").and_then(Value::as_array_mut) else {
            return;
        };
        if !self.take_out(groups) {
            return;
        }
        if groups.is_empty() {
            hooks.remove("SessionStart");
        }
        if hooks.is_empty() {
            object.remove("hooks");
        }
    }

    /// Validates the shared logins before writing any. The settings lock is
    /// held for the whole edit, so a direct-delivery write cannot land
    /// between the read and the write. If a later login cannot be
    /// snapshotted or stored, the logins already written are restored.
    /// Turning the hook on with nowhere shared to put it does not remove
    /// leftovers. An unshared file that cannot be read is skipped, so it
    /// cannot block the shared logins.
    /// The logins an edit touches: every login holding the hook, plus, when
    /// turning it on, every shared login (`install`).
    fn edit_targets(
        &self,
        enable: bool,
        install: &std::collections::HashSet<PathBuf>,
    ) -> Result<Vec<PathBuf>, String> {
        if enable && install.is_empty() {
            return Err(if self.removal_targets().is_empty() {
                "No Claude Code login was found, so the hook was not changed.".into()
            } else {
                "No shared Claude Code login was found, so the hook was not turned on.".into()
            });
        }
        let mut targets = self.removal_targets();
        if enable {
            for path in install {
                if !targets.contains(path) {
                    targets.push(path.clone());
                }
            }
        }
        if targets.is_empty() {
            return Err("No Claude Code login was found, so the hook was not changed.".into());
        }
        Ok(targets)
    }

    /// Each target's settings after the edit, for the files it changes, and
    /// the rules Agent Relay will then have added to each.
    fn plan_edit(
        &self,
        enable: bool,
        install: &std::collections::HashSet<PathBuf>,
        targets: Vec<PathBuf>,
        added_before: &permissions::Added,
    ) -> Result<(Vec<(PathBuf, Value)>, permissions::Added), String> {
        let rules = self.rules();
        let mut added = added_before.clone();
        let mut planned = Vec::new();
        for path in targets {
            let shared = install.contains(&path);
            let mut object = match self.read_object(&path) {
                Ok(object) => object,
                Err(_) if !shared => continue,
                Err(error) => return Err(error),
            };
            let before = Value::Object(object.clone());
            if enable && shared {
                self.install_into(&path, &mut object)?;
                if self.permissions.is_some() {
                    let owned = permissions::add(&mut object, &rules, added_before.of(&path))
                        .map_err(|why| Self::fail(&path, why))?;
                    added.set(&path, owned);
                }
            } else {
                self.remove_from(&mut object);
                permissions::take_out(&mut object, added_before.of(&path));
                added.set(&path, Vec::new());
            }
            let after = Value::Object(object);
            if after != before {
                planned.push((path, after));
            }
        }
        Ok((planned, added))
    }

    fn edit(&self, enable: bool) -> Result<(), String> {
        let _edit = claude_settings_edit_lock();
        let install: std::collections::HashSet<PathBuf> =
            self.install_targets().into_iter().collect();
        let targets = self.edit_targets(enable, &install)?;
        let added_before = self.added();
        let (planned, added) = self.plan_edit(enable, &install, targets, &added_before)?;
        // While the files are written, the record names every rule that may
        // be in them, so none Agent Relay added is ever left unrecorded.
        if added != added_before {
            self.save_added(&added_before.union(&added))?;
        }
        // Copies of the person's files go only once every login is written:
        // a later login that fails rolls the earlier ones back, and they
        // still need their copy.
        let mut spent = Vec::new();
        let stored = store_planned(
            &planned,
            |path| self.snapshot(path),
            |path, value| self.store(path, value, added_before.of(path), &mut spent),
            |path, previous| self.restore(path, previous),
        );
        if stored.is_ok() {
            for backup in spent {
                let _ = std::fs::remove_file(backup);
            }
        }
        if added != added_before {
            let _ = self.save_added(if stored.is_ok() {
                &added
            } else {
                &added_before
            });
        }
        stored
    }

    /// Bytes of the resolved file before this edit changes it. `None` when
    /// there was no file, which a failed edit then removes again.
    fn snapshot(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        let path = resolve_symlinks(path);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(Self::fail(&path, "cannot be read")),
        }
    }

    fn restore(&self, path: &Path, previous: &Option<Vec<u8>>) -> Result<(), String> {
        self.claude.check_write_target(path)?;
        let path = resolve_symlinks(path);
        match previous {
            Some(bytes) => {
                let existing = std::fs::read(&path).ok();
                write_keeping_file(&path, existing.as_deref(), bytes, BACKUP_SUFFIX, 0o600)
                    .map_err(|_| Self::fail(&path, "cannot be restored"))
            }
            None => match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(Self::fail(&path, "cannot be restored")),
            },
        }
    }

    /// Writes `value`. Once the hook and its rules are out, the file goes
    /// back to how the person had it: their own copy (`.relay-desktop-backup`) is put back byte for byte when the
    /// file differs from it in nothing they set, and a file Agent Relay
    /// created (no copy) is removed once it is an empty object. A file the
    /// person changed since keeps their change, and the copy is kept. A
    /// file reached through a link is never removed: that would leave the
    /// link dangling. A copy no longer needed is added to `spent`, for the
    /// edit to remove once every login is written.
    fn store(
        &self,
        path: &Path,
        value: &Value,
        added: &[String],
        spent: &mut Vec<PathBuf>,
    ) -> Result<(), String> {
        if self.holds_ours(value) {
            return self.write(path, value);
        }
        let resolved = resolve_symlinks(path);
        let mut backup = resolved.clone().into_os_string();
        backup.push(BACKUP_SUFFIX);
        let backup = PathBuf::from(backup);
        let mut keep_file = false;
        if let Ok(original) = std::fs::read(&backup) {
            let normal = permissions::without_empty(value);
            match serde_json::from_slice::<Value>(&original) {
                Ok(saved)
                    if !self.holds_ours(&saved) && permissions::without_empty(&saved) == normal =>
                {
                    write_keeping_file(&resolved, None, &original, BACKUP_SUFFIX, 0o600)
                        .map_err(|_| Self::fail(&resolved, "cannot be restored"))?;
                    spent.push(backup);
                    return Ok(());
                }
                // An earlier build copied a file that already held the hook:
                // the copy has nothing the file does not.
                Ok(saved)
                    if self.holds_ours(&saved)
                        && permissions::without_empty(&self.without_ours(&saved, added))
                            == normal =>
                {
                    spent.push(backup.clone());
                }
                _ => keep_file = true,
            }
        }
        let linked = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
        if !keep_file && !linked && value.as_object().is_some_and(Map::is_empty) {
            return match std::fs::remove_file(&resolved) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(Self::fail(&resolved, "cannot be removed")),
            };
        }
        self.write(path, value)
    }

    /// At core start: a hook the person turned on is brought up to date (a
    /// moved app runs a different executable) and copied to a shared login
    /// added since. A copy left on a login that is no longer shared is
    /// removed. When no shared login has it, off stays off, including a
    /// leftover on an unshared login.
    pub fn refresh(&self) {
        let _guard = self.lock();
        if self.shared_has_hook() {
            let _ = self.edit_with_alias(true);
        } else if self.hook_enabled() {
            let _ = self.edit_with_alias(false);
        } else if let Some(alias) = &self.alias {
            // Off: a link left for its rules goes.
            alias.release(crate::relay::probe_alias::User::Claude);
        }
    }
}

impl SettingsExtension for ClaudeSessionHookSettings {
    fn default_on(&self) -> Vec<&'static str> {
        // Only shared logins count: with none there is nowhere to install
        // (the edit would fail every pass), and a stale copy on a login no
        // longer shared must not keep the hook off the shared ones, since
        // `refresh` removes that copy and would leave none.
        if !self.install_targets().is_empty() && !self.shared_has_hook() {
            vec![SETTING]
        } else {
            Vec::new()
        }
    }

    fn get(&self) -> Map<String, Value> {
        let _guard = self.lock();
        let mut values = Map::new();
        if self.applies() {
            values.insert(SETTING.into(), Value::Bool(self.hook_enabled()));
        }
        values
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        let _guard = self.lock();
        Some(self.edit_with_alias(enabled))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::claude_dirs::ClaudeDirs;
    use crate::relay::hosted_mcp::{self, McpAccess};
    use serde_json::json;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn settings(root: &Path) -> ClaudeSessionHookSettings {
        let config = ClaudeConfig {
            home: root.join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs::default(),
        };
        ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
        )
    }

    #[test]
    fn development_hooks_leave_added_normal_login_settings_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let temp_path = std::fs::canonicalize(temp.path()).unwrap();
        let root = temp_path.join("Agent Relay.dev");
        let home = root.join("mcp/clients/.claude");
        let normal = temp_path.join("normal-claude");
        for dir in [&home, &normal] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(".claude.json"), "{}").unwrap();
            std::fs::write(dir.join("settings.json"), "{\"sentinel\":true}\n").unwrap();
        }
        let dirs = ClaudeDirs::development(&root);
        dirs.set_added(&[normal.to_string_lossy().into_owned()], &temp_path)
            .unwrap();
        let config = ClaudeConfig {
            home: home.clone(),
            executable: None,
            app_sessions: None,
            dirs,
        };
        let hooks = ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/private/dev/probe"), true),
        );
        assert_eq!(hooks.install_targets(), vec![home.join("settings.json")]);
        assert_eq!(hooks.removal_targets(), vec![home.join("settings.json")]);
        hooks.edit(true).unwrap();
        assert!(hooks.hook_enabled());
        hooks.refresh();
        hooks.edit(false).unwrap();
        assert!(!hooks.hook_enabled());
        assert!(hooks
            .write(&normal.join("settings.json"), &json!({}))
            .is_err());
        assert!(hooks.restore(&normal.join("settings.json"), &None).is_err());
        assert_eq!(
            std::fs::read(normal.join("settings.json")).unwrap(),
            b"{\"sentinel\":true}\n"
        );
        assert!(!normal.join("settings.json.relay-desktop-backup").exists());
    }

    fn open(on_relay: bool) -> StatusRead {
        StatusRead::Registered {
            on_relay,
            self_registration: true,
        }
    }

    fn login(root: &Path, name: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".claude.json"), "{}\n").unwrap();
    }

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn command(value: &Value) -> Vec<&str> {
        value["hooks"]["SessionStart"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str())
            .collect()
    }

    fn processes(claude: &[&str], terminal: bool) -> crate::relay::process::FakeProcesses {
        use crate::relay::process::{FakeProcess, FakeProcesses};
        let table = FakeProcesses::default();
        table.insert(
            100,
            FakeProcess {
                parent: 1,
                arguments: claude.iter().map(|arg| arg.to_string()).collect(),
                has_terminal: terminal,
                ..FakeProcess::default()
            },
        );
        // Claude runs the hook command through a shell.
        table.insert(
            200,
            FakeProcess {
                parent: 100,
                arguments: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "agent-relay relay claude-session-hook".into(),
                ],
                ..FakeProcess::default()
            },
        );
        table
    }

    #[test]
    fn only_a_session_with_a_person_is_asked() {
        assert!(has_person(&processes(&["claude"], true), 200));
        assert!(has_person(
            &processes(&["node", "/usr/local/bin/claude", "--resume", "abc"], true),
            200
        ));
        // npm installs run Anthropic's package under Node.
        assert!(has_person(
            &processes(
                &[
                    "node",
                    "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"
                ],
                true
            ),
            200
        ));
        // A flows step, cron or CI run has nobody to answer.
        assert!(!has_person(
            &processes(&["claude", "-p", "do the task"], true),
            200
        ));
        assert!(!has_person(
            &processes(&["claude", "--print", "x"], true),
            200
        ));
        assert!(!has_person(
            &processes(&["claude", "--output-format", "stream-json"], true),
            200
        ));
        // Not attached to a terminal: piped, so no person is typing.
        assert!(!has_person(&processes(&["claude"], false), 200));
        // No Claude Code process above the hook: stay quiet.
        assert!(!has_person(&processes(&["bash"], true), 200));
        assert_eq!(
            claude_ancestor(&processes(&["claude"], true), 200),
            Some(100)
        );
    }

    #[test]
    fn automatic_activation_tells_claude_it_joins_without_asking() {
        let body = br#"{"ok":true,"data":{"auto_activate":true,"allow_self_registration":true,"session":{"registered":false,"auto_activates":true}}}"#;
        assert_eq!(read_status(200, body), StatusRead::Joining);
        // Activation on, but this session will not join (no workspace, or an
        // excluded folder): the usual guidance, not a promise to join.
        let skipped = br#"{"ok":true,"data":{"auto_activate":true,"allow_self_registration":true,"session":{"registered":false,"auto_activates":false}}}"#;
        assert!(matches!(
            read_status(200, skipped),
            StatusRead::Registered { .. }
        ));
        // Already on the relay: the identity reminder, whatever the setting.
        let on = br#"{"ok":true,"data":{"auto_activate":true,"session":{"registered":true,"name":"n","address":"n@m"}}}"#;
        assert!(matches!(read_status(200, on), StatusRead::OnRelay { .. }));
        let off = br#"{"ok":true,"data":{"auto_activate":false,"session":{"registered":false}}}"#;
        assert!(matches!(
            read_status(200, off),
            StatusRead::Registered { .. }
        ));

        let socket = Path::new("/run/user/1000/agent-relay/relay.sock");
        let out = hook_output(Some(StatusRead::Joining), socket, true, None);
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert_eq!(out["systemMessage"], JOINING_FOR_PERSON);
        assert!(text.contains("Do not register it"), "{text}");
        assert!(!text.contains("ask the person whether"), "{text}");
        assert!(!text.contains("POST /register"), "{text}");
        assert!(text.contains(socket.to_str().unwrap()), "{text}");
        assert!(text.contains("/agents"), "{text}");
        assert!(text.contains("/send"), "{text}");
        assert_eq!(
            hook_output(Some(StatusRead::Joining), socket, false, None),
            json!({})
        );
    }

    #[test]
    fn join_prompt_respects_sharing_policy_but_registered_preamble_remains() {
        let socket = Path::new("/tmp/relay.sock");
        for mode in ["selected", "all", "new"] {
            let body = json!({"data": {"sharing_mode": mode,
                "allow_self_registration": true, "session": {"registered": false}}});
            let status = read_status(200, &serde_json::to_vec(&body).unwrap());
            let output = hook_output(Some(status), socket, true, None);
            assert_eq!(output != json!({}), mode == "selected", "{mode}");
            let registered = json!({"data": {"sharing_mode": mode,
                "claude_prompt_to_join_allowed": false,
                "session": {"registered": true, "name":"api", "address":"api@desk"}}});
            let status = read_status(200, &serde_json::to_vec(&registered).unwrap());
            assert!(
                hook_output(Some(status), socket, true, None)["hookSpecificOutput"].is_object()
            );
        }
        let pending = json!({"data": {"sharing_mode":"selected",
            "claude_prompt_to_join_allowed":false, "session":{"registered":false}}});
        assert_eq!(
            hook_output(
                Some(read_status(200, &serde_json::to_vec(&pending).unwrap())),
                socket,
                true,
                None
            ),
            json!({})
        );
    }

    #[test]
    fn nudge_has_claude_ask_the_person_before_registering() {
        let socket = Path::new("/run/user/1000/agent-relay/relay.sock");
        let out = hook_output(Some(open(false)), socket, true, None);
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert_eq!(out["systemMessage"], NUDGE_FOR_PERSON);
        assert!(
            text.contains("Do not put it on the relay on your own"),
            "{text}"
        );
        assert!(text.contains("ask the person whether"), "{text}");
        assert!(text.contains("Only if they say yes"), "{text}");
        let asked = text.find("ask the person").unwrap();
        let command = text.find("POST /register").unwrap();
        assert!(
            asked < command,
            "the question comes before the command: {text}"
        );
        assert!(!NUDGE_FOR_PERSON.contains("curl"), "{NUDGE_FOR_PERSON}");
        assert!(
            NUDGE_FOR_PERSON.contains("unless you say yes"),
            "{NUDGE_FOR_PERSON}"
        );
        assert!(text.contains("POST /register"), "{text}");
        assert!(text.contains(socket.to_str().unwrap()), "{text}");
        assert!(text.contains("does not register this session"), "{text}");
        assert!(!text.contains("auto_activate"), "{text}");
        assert!(out.get("decision").is_none());
        assert_eq!(hook_output(Some(open(true)), socket, true, None), json!({}));
        assert_eq!(hook_output(None, socket, true, None), json!({}));
        assert_eq!(
            hook_output(Some(open(false)), socket, false, None),
            json!({})
        );
        assert!(text.contains("\"mcp\":\"agent-relay-sessions\""), "{text}");
        let blocked = hook_output(
            Some(StatusRead::Registered {
                on_relay: false,
                self_registration: false,
            }),
            socket,
            true,
            None,
        );
        let blocked_agent = blocked["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(
            blocked_agent.contains("unless the person asks you to"),
            "{blocked_agent}"
        );
        assert!(!blocked_agent.contains("curl"), "{blocked_agent}");
        let blocked = blocked["systemMessage"].as_str().unwrap();
        assert!(
            blocked.contains("Let sessions put themselves on the relay"),
            "{blocked}"
        );
        assert!(!blocked.contains("curl"), "{blocked}");
        assert!(
            blocked.contains("does not register this session"),
            "{blocked}"
        );
    }

    #[test]
    fn a_session_on_the_relay_gets_the_preamble_for_its_access() {
        let socket = Path::new("/run/user/1000/agent-relay/relay.sock");
        let body = |mcp: &str| {
            format!(
                r#"{{"ok":true,"data":{{"session":{{"registered":true,"name":"api","address":"api@mac-1","mcp":"{mcp}"}}}}}}"#
            )
        };
        for (wire, access) in [
            ("declared", McpAccess::Declared),
            ("unknown", McpAccess::Unknown),
            ("socket_only", McpAccess::SocketOnly),
        ] {
            let status = read_status(200, body(wire).as_bytes());
            assert_eq!(
                status,
                StatusRead::OnRelay {
                    name: "api".into(),
                    address: "api@mac-1".into(),
                    link_address: "api@mac-1".into(),
                    mcp: access
                }
            );
            // Nothing for the person to answer, so automated runs get it too.
            for interactive in [true, false] {
                let out = hook_output(Some(status.clone()), socket, interactive, None);
                assert!(out.get("systemMessage").is_none());
                assert_eq!(
                    out["hookSpecificOutput"]["additionalContext"],
                    hosted_mcp::preamble("api", "api@mac-1", "api@mac-1", access, socket, None)
                );
            }
        }
    }

    #[test]
    fn status_reader_never_treats_a_failure_as_registered() {
        let ok = br#"{"ok":true,"data":{"session":{"registered":false}}}
"#;
        assert_eq!(read_status(200, ok), open(false));
        assert_eq!(
            read_status(
                200,
                br#"{"ok":true,"data":{"session":{"registered":true}}}"#
            ),
            open(true)
        );
        assert_eq!(
            read_status(
                200,
                br#"{"ok":true,"data":{"allow_self_registration":false,"session":{"registered":false}}}"#
            ),
            StatusRead::Registered {
                on_relay: false,
                self_registration: false
            }
        );
        assert_eq!(
            read_status(
                403,
                br#"{"ok":false,"error":{"code":"not_a_relay_session","message":"no"}}"#
            ),
            StatusRead::Again
        );
        assert_eq!(
            read_status(
                409,
                br#"{"ok":false,"error":{"code":"session_file_unreadable","message":"no"}}"#
            ),
            StatusRead::Again
        );
        assert_eq!(
            read_status(500, br#"{"ok":false,"error":{"code":"save_failed"}}"#),
            StatusRead::Unknown
        );
        assert_eq!(read_status(200, b"not-json"), StatusRead::Unknown);
    }

    #[test]
    fn offered_by_default_then_idempotent_and_removed_cleanly() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        login(root.path(), ".seclaude");
        let primary = root.path().join(".claude/settings.json");
        std::fs::write(
            &primary,
            r#"{"crossSessionInbound":"hold","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}
"#,
        )
        .unwrap();
        std::fs::write(
            root.path().join(".seclaude/settings.json"),
            "{\"untouched\":true}\n",
        )
        .unwrap();
        let settings = settings(root.path());
        assert_eq!(settings.get()[SETTING], false);
        assert_eq!(SettingsExtension::default_on(&settings), [SETTING]);
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));

        let installed = read(&primary);
        assert_eq!(installed["crossSessionInbound"], "hold");
        assert_eq!(
            installed["hooks"]["Stop"][0]["hooks"][0]["command"],
            "echo hi"
        );
        let ours = command(&installed);
        assert_eq!(
            ours,
            vec!["'/Apps/Agent Relay.app/probe' relay claude-session-hook"],
            "{installed}"
        );
        let work = read(&root.path().join(".claude-work/settings.json"));
        assert_eq!(command(&work), ours);
        assert_eq!(
            read(&root.path().join(".seclaude/settings.json")),
            json!({"untouched": true}),
            "a login outside .claude / .claude-* stays untouched until other_logins lists it"
        );
        let backup =
            std::fs::read(primary.with_file_name("settings.json.relay-desktop-backup")).unwrap();
        assert!(std::str::from_utf8(&backup)
            .unwrap()
            .contains("crossSessionInbound"));

        let bytes = std::fs::read(&primary).unwrap();
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert_eq!(
            std::fs::read(&primary).unwrap(),
            bytes,
            "a second install does not rewrite"
        );

        assert_eq!(settings.get()[SETTING], true);
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        let removed = read(&primary);
        assert_eq!(removed["crossSessionInbound"], "hold");
        assert!(removed["hooks"].get("SessionStart").is_none(), "{removed}");
        assert_eq!(
            removed["hooks"]["Stop"][0]["hooks"][0]["command"],
            "echo hi"
        );
        assert!(
            !root.path().join(".claude-work/settings.json").exists(),
            "a settings.json the hook created goes once it is empty"
        );
        // The person's own file came back byte for byte, and its copy went.
        assert_eq!(
            std::fs::read(&primary).unwrap(),
            b"{\"crossSessionInbound\":\"hold\",\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"echo hi\"}]}]}}\n"
        );
        assert!(!primary
            .with_file_name("settings.json.relay-desktop-backup")
            .exists());
        assert_eq!(settings.get()[SETTING], false);
        let kept = std::fs::read(&primary).unwrap();
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(std::fs::read(&primary).unwrap(), kept);
    }

    #[test]
    fn an_older_copy_is_replaced_and_the_other_build_is_left() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        let dev = format!("/old/probe {SUBCOMMAND} --dev");
        let old = format!("/old/probe {SUBCOMMAND}");
        std::fs::write(
            root.path().join(".claude/settings.json"),
            serde_json::to_vec_pretty(&json!({
                "hooks": {"SessionStart": [
                    {"hooks": [
                        {"type": "command", "command": "echo theirs"},
                        {"type": "command", "command": old},
                        {"type": "command", "command": dev}
                    ]}
                ]}
            }))
            .unwrap(),
        )
        .unwrap();
        let settings = settings(root.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let installed = read(&root.path().join(".claude/settings.json"));
        let commands = command(&installed);
        assert!(commands.contains(&"echo theirs"), "{commands:?}");
        assert!(commands.contains(&dev.as_str()), "{commands:?}");
        assert_eq!(
            commands
                .iter()
                .filter(|c| c.contains(SUBCOMMAND) && !c.ends_with(" --dev"))
                .count(),
            1,
            "{commands:?}"
        );
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        let removed = read(&root.path().join(".claude/settings.json"));
        let left = command(&removed);
        assert_eq!(left, vec!["echo theirs", dev.as_str()]);
    }

    #[test]
    fn a_bad_file_is_left_unchanged_and_blocks_the_other_login() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        std::fs::write(root.path().join(".claude/settings.json"), "{}\n").unwrap();
        std::fs::write(root.path().join(".claude-work/settings.json"), "[1]\n").unwrap();
        let settings = settings(root.path());
        let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
        assert!(error.contains("not a JSON object"), "{error}");
        assert_eq!(read(&root.path().join(".claude/settings.json")), json!({}));
        assert_eq!(
            std::fs::read(root.path().join(".claude-work/settings.json")).unwrap(),
            b"[1]\n"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_is_rewritten_at_its_target() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        let real = root.path().join("real.json");
        std::fs::write(&real, "{\"keep\":1}\n").unwrap();
        std::fs::remove_file(root.path().join(".claude/settings.json")).ok();
        symlink(&real, root.path().join(".claude/settings.json")).unwrap();
        let settings = settings(root.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert!(
            std::fs::symlink_metadata(root.path().join(".claude/settings.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(read(&real)["keep"], 1);
        assert_eq!(command(&read(&real)).len(), 1);
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(
            std::fs::symlink_metadata(root.path().join(".claude/settings.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let kept = read(&real);
        assert_eq!(kept["keep"], 1);
        assert!(kept.get("hooks").is_none(), "{kept}");
        assert!(real.exists());
    }

    #[test]
    fn turning_off_keeps_a_preexisting_empty_file() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        let path = root.path().join(".claude/settings.json");
        std::fs::write(&path, "{}\n").unwrap();
        let settings = settings(root.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(read(&path), json!({}));
        assert!(path.is_file());
    }

    #[test]
    #[cfg(unix)]
    fn a_later_login_that_cannot_be_written_rolls_the_earlier_one_back() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let work = root.path().join(".claude-work");
        let mut blocked = std::fs::metadata(&work).unwrap().permissions();
        blocked.set_mode(0o555);
        std::fs::set_permissions(&work, blocked).unwrap();
        struct ModeRestore<'a> {
            dir: &'a Path,
        }
        impl Drop for ModeRestore<'_> {
            fn drop(&mut self) {
                if let Ok(meta) = std::fs::metadata(self.dir) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(self.dir, perms);
                }
            }
        }
        let _restore = ModeRestore { dir: &work };
        let probe = work.join(".probe-write");
        if std::fs::File::create(&probe).is_ok() {
            return;
        }
        let settings = settings(root.path());
        let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
        assert!(error.contains("cannot be written"), "{error}");
        assert!(
            !root.path().join(".claude/settings.json").exists(),
            "the login written first is removed again"
        );
        assert!(!work.join("settings.json").exists());
    }

    #[test]
    #[cfg(unix)]
    fn a_snapshot_failure_after_a_write_rolls_that_write_back() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let first = root.path().join(".claude/settings.json");
        let second = root.path().join(".claude-work/settings.json");
        std::fs::write(&first, "{\"keep\":1}\n").unwrap();
        std::fs::write(&second, "{\"keep\":2}\n").unwrap();
        let mut blocked = std::fs::metadata(&second).unwrap().permissions();
        blocked.set_mode(0o000);
        std::fs::set_permissions(&second, blocked).unwrap();
        struct ModeRestore<'a> {
            file: &'a Path,
        }
        impl Drop for ModeRestore<'_> {
            fn drop(&mut self) {
                if let Ok(meta) = std::fs::metadata(self.file) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o644);
                    let _ = std::fs::set_permissions(self.file, perms);
                }
            }
        }
        let _restore = ModeRestore { file: &second };
        if std::fs::read(&second).is_ok() {
            return;
        }
        let mut open = std::fs::metadata(&second).unwrap().permissions();
        open.set_mode(0o644);
        std::fs::set_permissions(&second, open).unwrap();

        let settings = settings(root.path());
        let planned = vec![
            (first.clone(), json!({"keep": 1, "changed": true})),
            (second.clone(), json!({"keep": 2, "changed": true})),
        ];
        let error = store_planned(
            &planned,
            |path| settings.snapshot(path),
            |path, value| {
                let stored = settings.store(path, value, &[], &mut Vec::new());
                if stored.is_ok() && path == first {
                    let mut perms = std::fs::metadata(&second).unwrap().permissions();
                    perms.set_mode(0o000);
                    std::fs::set_permissions(&second, perms).unwrap();
                }
                stored
            },
            |path, previous| settings.restore(path, previous),
        )
        .unwrap_err();
        assert!(error.contains("cannot be read"), "{error}");
        assert_eq!(read(&first), json!({"keep": 1}));
        let mut open = std::fs::metadata(&second).unwrap().permissions();
        open.set_mode(0o644);
        std::fs::set_permissions(&second, open).unwrap();
        assert_eq!(read(&second), json!({"keep": 2}));
    }

    #[test]
    fn refresh_copies_an_enabled_hook_to_a_new_login_and_leaves_off_alone() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        let settings = settings(root.path());
        settings.refresh();
        assert!(!root.path().join(".claude/settings.json").exists());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        login(root.path(), ".claude-work");
        settings.refresh();
        assert_eq!(
            command(&read(&root.path().join(".claude-work/settings.json"))).len(),
            1
        );
    }

    #[test]
    fn absent_without_a_login_directory() {
        let root = tempfile::tempdir().unwrap();
        let settings = settings(root.path());
        assert!(settings.get().is_empty());
        let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
        assert!(error.contains("No Claude Code login"), "{error}");
        assert!(!root.path().join(".claude").exists());
        assert_eq!(
            settings.set(SETTING, &json!("yes")),
            Some(Err(format!("{SETTING} must be true or false.")))
        );
        assert_eq!(settings.set("direct_delivery", &json!(true)), None);
    }

    #[test]
    fn login_settings_is_the_only_list_the_hook_uses() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        login(root.path(), ".seclaude");
        let config = ClaudeConfig {
            home: root.path().join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs::default(),
        };
        let names: Vec<String> = ClaudeSettings::new(&config)
            .login_settings()
            .into_iter()
            .filter_map(|login| {
                login
                    .user_settings
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .collect();
        assert_eq!(
            names,
            vec![".claude".to_string(), ".claude-work".to_string()]
        );
    }

    #[test]
    fn an_unshared_login_loses_a_hook_installed_while_it_was_shared() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let relay = root.path().join("relay");
        std::fs::create_dir_all(&relay).unwrap();
        let record = relay.join(crate::relay::claude_dirs::FILE);
        let config = ClaudeConfig {
            home: root.path().join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs {
                private_root: None,
                environment: Vec::new(),
                file: Some(record.clone()),
            },
        };
        let settings = ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
        );
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let primary = root.path().join(".claude/settings.json");
        let work = root.path().join(".claude-work/settings.json");
        assert_eq!(command(&read(&work)).len(), 1);
        let work_dir = root.path().join(".claude-work");
        std::fs::write(
            &record,
            serde_json::to_vec(&json!({
                "folders": { work_dir.to_str().unwrap(): { "shared": false } }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            settings.get()[SETTING],
            true,
            "a leftover hook on an unshared login still counts as on"
        );
        settings.refresh();
        assert!(
            !work.exists(),
            "refresh takes the hook out of a folder that is no longer shared"
        );
        assert_eq!(command(&read(&primary)).len(), 1);
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        // Both files were the hook's own: gone once it is out.
        assert!(!primary.exists());
        assert!(!work.exists());
        assert_eq!(settings.get()[SETTING], false);
    }

    #[test]
    fn turning_on_does_nothing_when_every_login_is_unshared() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let relay = root.path().join("relay");
        std::fs::create_dir_all(&relay).unwrap();
        let record = relay.join(crate::relay::claude_dirs::FILE);
        let config = ClaudeConfig {
            home: root.path().join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs {
                private_root: None,
                environment: Vec::new(),
                file: Some(record.clone()),
            },
        };
        let settings = ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
        );
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let primary = root.path().join(".claude/settings.json");
        let work = root.path().join(".claude-work/settings.json");
        let primary_bytes = std::fs::read(&primary).unwrap();
        let work_bytes = std::fs::read(&work).unwrap();
        std::fs::write(
            &record,
            serde_json::to_vec(&json!({
                "folders": {
                    root.path().join(".claude").to_str().unwrap(): { "shared": false },
                    root.path().join(".claude-work").to_str().unwrap(): { "shared": false }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
        assert!(error.contains("No shared Claude Code login"), "{error}");
        assert_eq!(std::fs::read(&primary).unwrap(), primary_bytes);
        assert_eq!(std::fs::read(&work).unwrap(), work_bytes);
        assert_eq!(settings.get()[SETTING], true);
    }

    #[test]
    fn an_unreadable_unshared_file_does_not_block_shared_logins() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let relay = root.path().join("relay");
        std::fs::create_dir_all(&relay).unwrap();
        let record = relay.join(crate::relay::claude_dirs::FILE);
        let config = ClaudeConfig {
            home: root.path().join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs {
                private_root: None,
                environment: Vec::new(),
                file: Some(record.clone()),
            },
        };
        let settings = ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
        );
        let primary = root.path().join(".claude/settings.json");
        let work = root.path().join(".claude-work/settings.json");
        std::fs::write(&work, "not json").unwrap();
        std::fs::write(
            &record,
            serde_json::to_vec(&json!({
                "folders": {
                    root.path().join(".claude-work").to_str().unwrap(): { "shared": false }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert_eq!(command(&read(&primary)).len(), 1);
        assert_eq!(std::fs::read(&work).unwrap(), b"not json");
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(
            !primary.exists(),
            "the hook's own file goes once it is empty"
        );
        assert_eq!(std::fs::read(&work).unwrap(), b"not json");
        assert_eq!(settings.get()[SETTING], false);
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;

    #[test]
    fn a_renamed_session_is_named_as_it_is_now_but_links_its_registered_address() {
        let body = br#"{"ok":true,"data":{"session":{"registered":true,"name":"tan-man","address":"tan-man@mac-2","link_address":"claude-first@mac-1","mcp":"unknown"}}}"#;
        let socket = Path::new("/run/user/1000/agent-relay/relay.sock");
        let out = hook_output(Some(read_status(200, body)), socket, true, None);
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(text.contains("@tan-man (tan-man@mac-2)"), "{text}");
        assert!(
            text.contains("join_relay desktop_address=\"claude-first@mac-1\""),
            "{text}"
        );
        // An older core sends no link_address: its address is the registered one.
        let old = br#"{"ok":true,"data":{"session":{"registered":true,"name":"api","address":"api@mac-1"}}}"#;
        let out = hook_output(Some(read_status(200, old)), socket, true, None);
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(
            text.contains("join_relay desktop_address=\"api@mac-1\""),
            "{text}"
        );
    }

    #[test]
    fn registration_off_also_rechecks_whoami_but_the_person_does_not_read_it() {
        let probe = Path::new("/Users/me/.agentworkforce/desktop/bin/agent-relay-probe");
        let socket = Path::new("/Users/me/Library/Application Support/x/run/relay.sock");
        let off = StatusRead::Registered {
            on_relay: false,
            self_registration: false,
        };
        let out = hook_output(Some(off), socket, true, Some(probe));
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        let whoami = format!(
            "{} relay whoami --socket '{}'",
            probe.display(),
            socket.display()
        );
        assert!(text.contains(&whoami), "{text}");
        assert!(
            text.contains("Do not try to put this session on the relay"),
            "{text}"
        );
        assert!(
            !out["systemMessage"].as_str().unwrap().contains("whoami"),
            "{out}"
        );
    }

    #[test]
    fn nudge_checks_whoami_with_the_allowed_command_before_asking_again() {
        // The nudge is read once at SessionStart; another agent or Agent
        // Relay can register the session afterwards (2026-11-02).
        let probe = Path::new("/Users/me/.agentworkforce/desktop/bin/agent-relay-probe");
        let socket = Path::new("/Users/me/Library/Application Support/x/run/relay.sock");
        let rules = PermissionRules {
            probe: probe.into(),
            socket: socket.into(),
        }
        .rules();
        let unregistered = StatusRead::Registered {
            on_relay: false,
            self_registration: true,
        };
        let out = hook_output(Some(unregistered), socket, true, Some(probe));
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        let whoami = format!(
            "{} relay whoami --socket '{}'",
            probe.display(),
            socket.display()
        );
        assert!(text.contains(&whoami), "{text}");
        assert!(rules.iter().any(|rule| covers(rule, &whoami)));
        assert!(
            text.contains("do not ask and do not register it again"),
            "{text}"
        );
        let asked = text.find("ask the person").unwrap();
        let later = text.find(&whoami).unwrap();
        assert!(asked < later, "{text}");
    }

    // The coordinator's skill e2e: the SessionStart text named curl, which
    // Claude's rules do not allow. The core reports the probe its rules
    // name, and the text's commands use it.
    #[test]
    fn the_start_text_names_the_probe_the_core_reports() {
        let body = br#"{"ok":true,"data":{"probe":"/Users/me/.agentworkforce/desktop/bin/agent-relay-probe","session":{"registered":true,"name":"api","address":"api@mac-1","mcp":"socket_only"}}}"#;
        let probe = read_probe(body).unwrap();
        assert_eq!(
            probe,
            Path::new("/Users/me/.agentworkforce/desktop/bin/agent-relay-probe")
        );
        assert_eq!(read_probe(br#"{"data":{"probe":"relative/probe"}}"#), None);
        assert_eq!(read_probe(br#"{"data":{}}"#), None);
        let socket = Path::new("/Users/me/Library/Application Support/x/run/relay.sock");
        let rules = PermissionRules {
            probe: probe.clone(),
            socket: socket.into(),
        }
        .rules();
        for status in [read_status(200, body), StatusRead::Joining] {
            let out = hook_output(Some(status), socket, true, Some(&probe));
            let text = out["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap();
            assert!(!text.contains("curl"), "{text}");
            let agents = format!(
                "{} relay agents --socket '{}'",
                probe.display(),
                socket.display()
            );
            assert!(text.contains(&agents), "{text}");
            assert!(rules.iter().any(|rule| covers(rule, &agents)));
        }
    }
}
