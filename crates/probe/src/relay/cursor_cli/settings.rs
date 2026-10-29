//! Agent Relay's entries in Cursor CLI's `~/.cursor/hooks.json`.

use super::{CursorConfig, HOOK_EVENTS, HOOK_SUBCOMMAND, LABEL};
use crate::relay::existing_session::platform;
use serde_json::{json, Map, Value};
use std::path::Path;

/// The store key and `settings.get`/`settings.set` name.
pub const SETTING: &str = "cursor_direct_delivery";

/// Agent Relay's hook timeout, in seconds, in each `hooks.json` entry.
const HOOK_TIMEOUT: u64 = 10;

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
        crate::relay::devin::hook_command::is_ours_running(command, &self.command, HOOK_SUBCOMMAND)
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
        self.read_object().is_ok_and(|object| {
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
    /// so exactly one runs per event.
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
            entries.push(json!({"command": self.command, "timeout": HOOK_TIMEOUT}));
        }
        Ok(())
    }

    /// Applies `enable` to `hooks.json` through the symlink, keeping the
    /// file's mode and a one-time backup, atomically.
    fn edit(&self, enable: bool) -> Result<(), String> {
        let _held = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut object = self.read_object()?;
        if !enable && object.get("hooks").is_none() {
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
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        if self.installed() {
            settings.insert(SETTING.into(), Value::Bool(self.hook_enabled()));
        }
        settings
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        if let Some(reason) = platform::unsupported(LABEL) {
            return Some(Err(reason));
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        if enabled && !self.installed() {
            return Some(Err("Cursor CLI has never run on this computer.".into()));
        }
        Some(self.edit(enabled))
    }
}
