//! Agent Relay's entries in Cursor CLI's `~/.cursor/hooks.json`.

use super::wait::{WAIT_FLAG, WAIT_TIMEOUT};
use super::{CursorConfig, HOOK_EVENTS, HOOK_SUBCOMMAND, LABEL};
use crate::relay::existing_session::platform;
use serde_json::{json, Map, Value};
use std::path::Path;

/// The store key and `settings.get`/`settings.set` name.
pub const SETTING: &str = "cursor_direct_delivery";

/// Agent Relay's hook timeout, in seconds, in each `hooks.json` entry but
/// the waiting `stop` one (`wait::WAIT_TIMEOUT`).
const HOOK_TIMEOUT: u64 = 10;

/// The `stop` entry's command: the hook with `--wait`, before `--dev`.
fn waiting(command: &str) -> String {
    match command.strip_suffix(" --dev") {
        Some(hook) => format!("{hook} {WAIT_FLAG} --dev"),
        None => format!("{command} {WAIT_FLAG}"),
    }
}

/// `command` without the `stop` entry's `--wait`.
fn without_wait(command: &str) -> (String, bool) {
    let command = command.trim();
    let (hook, dev) = match command.strip_suffix(" --dev") {
        Some(hook) => (hook.trim_end(), " --dev"),
        None => (command, ""),
    };
    match hook.strip_suffix(&format!(" {WAIT_FLAG}")) {
        Some(hook) => (format!("{}{dev}", hook.trim_end()), true),
        None => (command.to_string(), false),
    }
}

/// Installs and removes Agent Relay's hooks in `~/.cursor/hooks.json`. The
/// file is the source of truth: the setting is on exactly when a hook
/// running this build's subcommand is there. Entries for other commands are
/// the person's and are never touched.
pub struct CursorSettings {
    config: CursorConfig,
    command: String,
    lock: std::sync::Mutex<()>,
}

impl CursorSettings {
    pub fn new(config: &CursorConfig, command: String) -> CursorSettings {
        CursorSettings {
            config: config.clone(),
            command,
            lock: std::sync::Mutex::new(()),
        }
    }

    /// The hook command for `executable`, with `--dev` for Agent Relay Dev.
    pub fn command_for(executable: &Path, development: bool) -> String {
        let mut command = format!(
            "{} {HOOK_SUBCOMMAND}",
            crate::relay::outbound::shell_quote(&executable.to_string_lossy())
        );
        if development {
            command.push_str(" --dev");
        }
        command
    }

    fn installed(&self) -> bool {
        platform::SUPPORTED && self.config.installed()
    }

    pub(super) fn is_ours(&self, command: &str) -> bool {
        crate::relay::devin::hook_command::is_ours_running(
            &without_wait(command).0,
            &self.command,
            HOOK_SUBCOMMAND,
        )
    }

    /// Whether this build's waiting `stop` entry is in `hooks.json`. A hook
    /// waiting for a message ends once it is not, so turning the setting
    /// off stops waiting hooks too.
    pub fn waits(&self) -> bool {
        self.read_object().is_ok_and(|object| {
            object
                .get("hooks")
                .and_then(|hooks| hooks.get("stop"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| entry["command"].as_str())
                .any(|command| without_wait(command).1 && self.is_ours(command))
        })
    }

    /// Runs `claim` while this build's waiting `stop` entry is in
    /// `hooks.json`, holding the lock turning the setting on or off takes,
    /// so once that returns no waiting hook hands anything more over.
    /// `None` when the entry is not there or the lock cannot be taken.
    pub fn while_waiting<T>(&self, claim: impl FnOnce() -> T) -> Option<T> {
        let _held = self.file_lock(false)?;
        self.waits().then(claim)
    }

    /// The lock over this build's entries across processes: shared while a
    /// waiting hook claims, exclusive while the file is edited.
    fn file_lock(&self, exclusive: bool) -> Option<std::fs::File> {
        let inbox = self.config.inbox();
        std::fs::create_dir_all(&inbox).ok()?;
        let _ = platform::set_mode(&inbox, 0o700);
        use platform::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(inbox.join(".hooks.lock"))
            .ok()?;
        let taken = if exclusive {
            fs2::FileExt::lock_exclusive(&file)
        } else {
            fs2::FileExt::lock_shared(&file)
        };
        taken.ok().map(|()| file)
    }

    /// Brings this build's entries, where they are in `hooks.json`, up to
    /// the ones it installs now, so an install made before the waiting
    /// `stop` entry and `beforeSubmitPrompt` gets them. Everything else
    /// stays, and a file already up to date is not written. Whether they
    /// are there is read under the same lock as turning the setting off
    /// takes, so a refresh never puts back entries just taken out.
    pub fn refresh(&self) -> Result<(), String> {
        if !self.installed() {
            return Ok(());
        }
        self.edit_when(true, |object| self.owns(object))
    }

    pub(super) fn read_object(&self) -> Result<Map<String, Value>, String> {
        let path = crate::relay::claude_settings::resolve_symlinks(&self.config.hooks_file());
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
            Err(_) => return Err("~/.cursor/hooks.json cannot be read".into()),
        };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Map::new());
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(object)) => Ok(object),
            _ => Err("~/.cursor/hooks.json is not a JSON object, so it was left unchanged".into()),
        }
    }

    fn hook_enabled(&self) -> bool {
        self.read_object().is_ok_and(|object| self.owns(&object))
    }

    /// Whether any of `object`'s hooks is this build's.
    fn owns(&self, object: &Map<String, Value>) -> bool {
        object
            .get("hooks")
            .and_then(Value::as_object)
            .is_some_and(|hooks| {
                hooks
                    .values()
                    .flat_map(|entries| entries.as_array().into_iter().flatten())
                    .filter_map(|entry| entry["command"].as_str())
                    .any(|command| self.is_ours(command))
            })
    }

    /// Removes this build's entries from every event, and any event left
    /// empty.
    fn take_out(&self, object: &mut Map<String, Value>) {
        let Some(hooks) = object.get_mut("hooks").and_then(Value::as_object_mut) else {
            return;
        };
        let events: Vec<String> = hooks.keys().cloned().collect();
        for event in events {
            let Some(entries) = hooks.get_mut(&event).and_then(Value::as_array_mut) else {
                continue;
            };
            entries.retain(|entry| !entry["command"].as_str().is_some_and(|c| self.is_ours(c)));
            if entries.is_empty() {
                hooks.remove(&event);
            }
        }
        if hooks.is_empty() {
            object.remove("hooks");
        }
    }

    /// Adds this build's entry to each of `HOOK_EVENTS`, after `take_out`,
    /// so exactly one runs per event. The `stop` entry waits
    /// (`super::wait`): it runs with `--wait`, an hour's timeout and no
    /// `loop_limit`, so Cursor neither ends it early nor skips it after
    /// five follow-ups in a row.
    pub(super) fn install_into(&self, object: &mut Map<String, Value>) -> Result<(), String> {
        object.entry("version").or_insert(json!(1));
        let hooks = object.entry("hooks").or_insert_with(|| json!({}));
        let Some(hooks) = hooks.as_object_mut() else {
            return Err(
                "~/.cursor/hooks.json has a hooks value that is not an object, so it was left unchanged"
                    .into(),
            );
        };
        for event in HOOK_EVENTS {
            let entries = hooks.entry(event).or_insert_with(|| json!([]));
            let Some(entries) = entries.as_array_mut() else {
                return Err(format!(
                    "~/.cursor/hooks.json has a {event} value that is not a list, so it was left unchanged"
                ));
            };
            entries.push(if event == "stop" {
                json!({
                    "command": waiting(&self.command),
                    "timeout": WAIT_TIMEOUT,
                    "loop_limit": null,
                })
            } else {
                json!({"command": self.command, "timeout": HOOK_TIMEOUT})
            });
        }
        Ok(())
    }

    /// Applies `enable` to `hooks.json` through the symlink, keeping the
    /// file's mode and a one-time backup, atomically.
    fn edit(&self, enable: bool) -> Result<(), String> {
        self.edit_when(enable, |_| true)
    }

    /// `edit`, when the file it read under the lock passes `applies`. It
    /// waits for any claim a waiting hook has under way (`while_waiting`),
    /// and leaves the file as it is when that lock cannot be taken.
    fn edit_when(
        &self,
        enable: bool,
        applies: impl FnOnce(&Map<String, Value>) -> bool,
    ) -> Result<(), String> {
        let _held = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let _claims = self.file_lock(true).ok_or(
            "Agent Relay could not lock its Cursor hooks, so ~/.cursor/hooks.json was left unchanged",
        )?;
        let mut object = self.read_object()?;
        if !applies(&object) || (!enable && object.get("hooks").is_none()) {
            return Ok(());
        }
        self.take_out(&mut object);
        if enable {
            self.install_into(&mut object)?;
        }
        let path = crate::relay::claude_settings::resolve_symlinks(&self.config.hooks_file());
        let existing = std::fs::read(&path).ok();
        let mut bytes =
            serde_json::to_vec_pretty(&Value::Object(object)).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        if existing.as_deref() == Some(bytes.as_slice()) {
            return Ok(());
        }
        crate::relay::claude_settings::write_keeping_file(
            &path,
            existing.as_deref(),
            &bytes,
            ".relay-desktop-backup",
            0o600,
        )
        .map_err(|_| "~/.cursor/hooks.json cannot be written".to_string())
    }
}

/// Never turned on by default: where Cursor CLI has run, Settings offers
/// the hooks (`cursor_direct_delivery` false), and hooks already in place
/// stay as they are.
impl crate::relay::agents::SettingsExtension for CursorSettings {
    /// On only while this build's waiting `stop` entry is in place, as the
    /// setting's wording promises: an earlier install that `refresh` could
    /// not bring up to date reads as off, and turning it on tries again and
    /// says why it cannot.
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        if self.installed() {
            settings.insert(
                SETTING.into(),
                Value::Bool(self.hook_enabled() && self.waits()),
            );
        }
        settings
    }

    fn refuse(&self, key: &str, value: &Value) -> Option<String> {
        if key != SETTING {
            return None;
        }
        if let Some(reason) = platform::unsupported(LABEL) {
            return Some(reason);
        }
        (value.as_bool() == Some(true) && !self.installed())
            .then(|| "Cursor CLI has never run on this computer.".into())
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        if let Some(reason) = self.refuse(key, value) {
            return Some(Err(reason));
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        Some(self.edit(enabled))
    }
}
