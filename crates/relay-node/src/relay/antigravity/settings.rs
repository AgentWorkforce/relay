//! Managed `"agent-relay"` / `"agent-relay-dev"` entries in Antigravity's
//! global `~/.gemini/config/hooks.json`, preserving every user-configured hook.
use super::{proof, AntigravityConfig};
use serde_json::{json, Map, Value};
use std::io;
use std::path::{Path, PathBuf};

/// The store key and `settings.get`/`settings.set` name.
pub const SETTING: &str = "antigravity_direct_delivery";

const HOOK_KEY: &str = "agent-relay";
const DEV_HOOK_KEY: &str = "agent-relay-dev";
const EVENTS: &[(&str, &str, u64)] = &[
    ("SessionStart", "start", 20),
    ("PreInvocation", "pre", 10),
    ("PostInvocation", "post", 10),
    ("Stop", "stop", 3600),
];

fn hook_key(config: &AntigravityConfig) -> &'static str {
    if config.development {
        DEV_HOOK_KEY
    } else {
        HOOK_KEY
    }
}

pub struct AntigravitySettings {
    config: AntigravityConfig,
    lock: std::sync::Mutex<()>,
}

impl AntigravitySettings {
    pub fn new(config: &AntigravityConfig, executable: PathBuf) -> Self {
        config.set_helper(executable);
        Self {
            config: config.clone(),
            lock: std::sync::Mutex::new(()),
        }
    }

    pub fn installed(&self) -> bool {
        proof::SUPPORTED && (self.config.data_dir.is_dir() || self.enabled())
    }

    pub fn enabled(&self) -> bool {
        self.config.enabled()
    }

    fn hooks_lock(&self) -> Result<std::fs::File, String> {
        let dir = self.config.home.join(".agentworkforce/desktop");
        crate::platform::fs::create_private_dir_all(&dir)
            .map_err(|_| "Could not open Antigravity hooks lock directory.")?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(false);
        let lock = crate::platform::fs::no_follow(crate::platform::fs::private(&mut options))
            .open(dir.join(".antigravity-hooks.lock"))
            .map_err(|_| "Could not open Antigravity hooks lock.")?;
        let metadata = lock
            .metadata()
            .map_err(|_| "Could not inspect Antigravity hooks lock.")?;
        if !metadata.is_file()
            || !crate::platform::fs::owned_by_current_user(&metadata)
            || !crate::platform::fs::private_to_owner(&metadata, 0o077)
        {
            return Err("Antigravity hooks lock is not private.".into());
        }
        super::lock_exclusive_bounded(&lock, super::LOCK_TIMEOUT)
            .map_err(|_| "Could not lock Antigravity hooks.".to_string())?;
        Ok(lock)
    }

    /// Bring an already-installed managed entry up to date with the current
    /// helper path and event timeouts without re-enabling after an explicit Off.
    pub fn refresh(&self) -> Result<(), String> {
        if !proof::SUPPORTED || !self.config.helper().is_absolute() {
            return Ok(());
        }
        let _held = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let _file_lock = self.hooks_lock()?;
        let key = hook_key(&self.config);
        let Some(Value::Object(mut root)) =
            document(&self.config).map_err(|_| "Could not read Antigravity hooks.")?
        else {
            return Ok(());
        };
        if !root.contains_key(key) {
            return Ok(());
        }
        let expected = managed_entry(&self.config, &self.config.helper());
        if root.get(key) == Some(&expected) {
            return Ok(());
        }
        root.insert(key.into(), expected);
        let bytes = serde_json::to_vec_pretty(&Value::Object(root))
            .map_err(|_| "Could not encode Antigravity hooks.")?;
        crate::platform::fs::write_atomic(&self.config.hooks_file(), &bytes)
            .map_err(|_| "Could not save Antigravity hooks.".into())
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled && !proof::SUPPORTED {
            return Err("Antigravity hook delivery is currently available only on macOS.".into());
        }
        if enabled && !self.config.helper().is_absolute() {
            return Err("Antigravity requires an absolute managed helper path.".into());
        }
        let _held = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let _file_lock = self.hooks_lock()?;
        let path = self.config.hooks_file();
        let mut root = match document(&self.config)
            .map_err(|_| "Could not read Antigravity hooks.")?
        {
            Some(Value::Object(map)) => map,
            Some(_) => {
                return Err(
                    "Antigravity's hooks.json is not a JSON object and was left unchanged.".into(),
                );
            }
            None => Map::new(),
        };
        let key = hook_key(&self.config);
        if !enabled {
            if root.remove(key).is_none() {
                return Ok(());
            }
            let bytes = serde_json::to_vec_pretty(&Value::Object(root))
                .map_err(|_| "Could not encode Antigravity hooks.")?;
            return crate::platform::fs::write_atomic(&path, &bytes)
                .map_err(|_| "Could not save Antigravity hooks.".into());
        }
        let expected = managed_entry(&self.config, &self.config.helper());
        if root.get(key) == Some(&expected) {
            return Ok(());
        }
        root.insert(key.into(), expected);
        let bytes = serde_json::to_vec_pretty(&Value::Object(root))
            .map_err(|_| "Could not encode Antigravity hooks.")?;
        crate::platform::fs::create_private_dir_all(
            path.parent()
                .ok_or("Missing Antigravity config directory.")?,
        )
        .map_err(|_| "Could not open Antigravity config directory.")?;
        crate::platform::fs::write_atomic(&path, &bytes)
            .map_err(|_| "Could not save Antigravity hooks.".into())
    }
}

impl crate::relay::agents::SettingsExtension for AntigravitySettings {
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        if self.installed() {
            settings.insert(SETTING.into(), Value::Bool(self.enabled()));
        }
        settings
    }

    fn refuse(&self, key: &str, value: &Value) -> Option<String> {
        if key != SETTING {
            return None;
        }
        if !proof::SUPPORTED {
            return Some("Antigravity hook delivery is currently available only on macOS.".into());
        }
        (value.as_bool() == Some(true) && !self.installed())
            .then(|| "Antigravity has never run on this computer.".into())
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
        Some(self.set_enabled(enabled))
    }
}

fn managed_entry(config: &AntigravityConfig, executable: &Path) -> Value {
    let mut entry = Map::new();
    for (event, flag, timeout) in EVENTS {
        let command = format!(
            "exec {} antigravity-hook --event {}{}",
            crate::relay::outbound::shell_quote(&executable.to_string_lossy()),
            flag,
            if config.development { " --dev" } else { "" }
        );
        entry.insert(
            (*event).into(),
            json!([{"type": "command", "command": command, "timeout": timeout}]),
        );
    }
    Value::Object(entry)
}

pub(super) fn installed_state(config: &AntigravityConfig) -> io::Result<bool> {
    if !config.helper().is_absolute() {
        return Ok(false);
    }
    let Some(Value::Object(root)) = document(config)? else {
        return Ok(false);
    };
    let Some(entry) = root.get(hook_key(config)) else {
        return Ok(false);
    };
    if entry == &managed_entry(config, &config.helper()) {
        return Ok(true);
    }
    let Some(helper) = managed_helper(entry).filter(|p| p.is_absolute()) else {
        return Ok(false);
    };
    Ok(same_helper_file(&helper, &config.helper()) && entry == &managed_entry(config, &helper))
}

fn managed_helper(entry: &Value) -> Option<PathBuf> {
    let command = entry["SessionStart"][0]["command"].as_str()?;
    let args = shell_words::split(command).ok()?;
    args.get(1).filter(|p| !p.is_empty()).map(PathBuf::from)
}

fn same_helper_file(left: &Path, right: &Path) -> bool {
    left == right || same_file::is_same_file(left, right).unwrap_or(false)
}

fn document(config: &AntigravityConfig) -> io::Result<Option<Value>> {
    let path = config.hooks_file();
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !meta.file_type().is_file() {
        return Err(io::Error::other("Antigravity hooks path is not a file"));
    }
    let bytes = std::fs::read(&path)?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(io::Error::other)
}

/// Confirm the peer calling `/antigravity/hook` is the managed helper running
/// `antigravity-hook --event <event>`.
pub(super) fn caller_is_hook(
    config: &AntigravityConfig,
    table: &dyn crate::relay::process::ProcessTable,
    pid: i32,
    event: &str,
) -> bool {
    let helper = config.helper();
    if !helper.is_absolute() {
        return false;
    }
    let Some(exe) = table.executable(pid) else {
        return false;
    };
    if !same_helper_file(&exe, &helper) || !table.is_trusted_relay_helper(pid, &exe) {
        return false;
    }
    let args = table.arguments(pid);
    let mut expected = vec![
        "antigravity-hook".to_owned(),
        "--event".to_owned(),
        event.to_owned(),
    ];
    if config.development {
        expected.push("--dev".to_owned());
    }
    args.len() == expected.len() + 1 && args[1..] == expected[..]
}
