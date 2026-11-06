//! One provider-owned hook file, preserving every hook the person installed.
use super::{proof, CopilotConfig};
use serde_json::{json, Value};
use std::io;
use std::path::{Path, PathBuf};
const OWNER: &str = "agent-relay-desktop";
const EVENTS: &[(&str, &str)] = &[
    ("sessionStart", "start"),
    ("preToolUse", "before"),
    ("postToolUse", "tool"),
    ("agentStop", "stop"),
];

pub struct CopilotSettings {
    config: CopilotConfig,
}
impl CopilotSettings {
    pub fn new(config: &CopilotConfig, executable: PathBuf) -> Self {
        config.set_helper(executable);
        Self {
            config: config.clone(),
        }
    }
    pub fn enabled(&self) -> bool {
        self.config.enabled()
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled && !proof::SUPPORTED {
            return Err("Copilot chat delivery is currently available only in VS Code on macOS. Hosted MCP setup is available on this platform.".into());
        }
        if enabled && !self.config.helper().is_absolute() {
            return Err("Copilot requires an absolute managed helper path.".into());
        }
        let path = self.config.hooks_file();
        let exists = match std::fs::symlink_metadata(&path) {
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(_) => return Err("Could not inspect Copilot hooks.".into()),
        };
        if exists && !owned_state(&self.config).map_err(|_| "Could not read Copilot hooks.")? {
            return Err("Copilot's Agent Relay hooks file contains unrecognized settings and was left unchanged.".into());
        }
        if !enabled {
            if exists {
                std::fs::remove_file(&path).map_err(|_| "Could not remove Copilot hooks.")?;
            }
            return Ok(());
        }
        let bytes = serde_json::to_vec_pretty(&managed_value(&self.config, &self.config.helper()))
            .map_err(|_| "Could not encode Copilot hooks.")?;
        if exists && std::fs::read(&path).map_err(|_| "Could not read Copilot hooks.")? == bytes {
            return Ok(());
        }
        crate::platform::fs::create_private_dir_all(
            path.parent().ok_or("Missing Copilot hooks directory.")?,
        )
        .map_err(|_| "Could not open Copilot hooks directory.")?;
        crate::platform::fs::write_atomic(&path, &bytes)
            .map_err(|_| "Could not save Copilot hooks.".into())
    }
}
fn managed_value(config: &CopilotConfig, executable: &Path) -> Value {
    let mut hooks = serde_json::Map::new();
    for (event, flag) in EVENTS {
        let command = format!(
            "exec {} copilot-hook --event {}{}",
            crate::relay::outbound::shell_quote(&executable.to_string_lossy()),
            flag,
            if config.development { " --dev" } else { "" }
        );
        hooks.insert((*event).into(), json!([{"type":"command","command":command,
            "timeoutSec":if *flag == "stop" { 3600 } else if matches!(*flag, "before" | "start") { 20 } else { 10 }}]));
    }
    json!({"version":1,"agentRelayManagedBy":OWNER,"hooks":hooks})
}
/// Only a missing file is absent. Other errors must keep discovery unavailable
/// and must never authorize replacing an existing file.
pub(super) fn installed_state(config: &CopilotConfig) -> io::Result<bool> {
    if !config.helper().is_absolute() {
        return Ok(false);
    }
    Ok(document(config)?.is_some_and(|value| value == managed_value(config, &config.helper())))
}
// Setup can repair or remove an old managed helper (including a legacy
// relative path that is never accepted for discovery), but discovery and calls
// still require the exact helper the host currently selected.
fn owned_state(config: &CopilotConfig) -> io::Result<bool> {
    let Some(value) = document(config)? else {
        return Ok(false);
    };
    let Some(command) = value["hooks"]["sessionStart"][0]["command"].as_str() else {
        return Ok(false);
    };
    let Ok(args) = shell_words::split(command) else {
        return Ok(false);
    };
    let Some(helper) = args.get(1).filter(|p| !p.is_empty()).map(Path::new) else {
        return Ok(false);
    };
    let mut expected = managed_value(config, helper);
    if value == expected {
        return Ok(true);
    }
    // The initial adapter used a 10-second start timeout.
    expected["hooks"]["sessionStart"][0]["timeoutSec"] = json!(10);
    Ok(value == expected)
}
fn document(config: &CopilotConfig) -> io::Result<Option<Value>> {
    let path = config.hooks_file();
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file()
        || !crate::platform::fs::owned_by_current_user(&metadata)
        || !crate::platform::fs::private_to_owner(&metadata, 0o022)
    {
        return Ok(None);
    }
    serde_json::from_slice(&std::fs::read(path)?)
        .map(Some)
        .map_err(io::Error::other)
}

/// The socket peer must be the configured hook executable, running its exact
/// event command; a runtime's MCP or tool child is not a hook merely by ancestry.
pub(super) fn caller_is_hook(
    config: &CopilotConfig,
    table: &dyn crate::relay::process::ProcessTable,
    pid: i32,
    event: &str,
) -> bool {
    let Ok(bytes) = std::fs::read(config.hooks_file()) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    let Some((native, _)) = EVENTS.iter().find(|(_, flag)| *flag == event) else {
        return false;
    };
    let Some(command) = value["hooks"][native][0]["command"].as_str() else {
        return false;
    };
    let Ok(expected) = shell_words::split(command) else {
        return false;
    };
    if expected.len() < 5 {
        return false;
    }
    let Some(actual) = table.executable(pid) else {
        return false;
    };
    let program = std::path::Path::new(&expected[1]);
    let resolved = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
    actual == resolved
        && resolved == std::fs::canonicalize(config.helper()).unwrap_or_else(|_| config.helper())
        && table.is_trusted_relay_helper(pid, &actual)
        && table.arguments(pid).get(1..) == Some(&expected[2..])
}
