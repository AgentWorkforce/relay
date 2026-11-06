//! One provider-owned hook file, preserving every hook the person installed.
use super::{proof, CopilotConfig};
use serde_json::{json, Value};
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
    executable: PathBuf,
}
impl CopilotSettings {
    pub fn new(config: &CopilotConfig, executable: PathBuf) -> Self {
        Self {
            config: config.clone(),
            executable,
        }
    }
    pub fn enabled(&self) -> bool {
        self.config.enabled()
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        if enabled && !proof::SUPPORTED {
            return Err("Copilot chat delivery is currently available only in VS Code on macOS. Hosted MCP setup is available on this platform.".into());
        }
        let path = self.config.hooks_file();
        if std::fs::symlink_metadata(&path).is_ok() && !installed(&path) {
            return Err("Copilot's Agent Relay hooks file contains unrecognized settings and was left unchanged.".into());
        }
        if !enabled {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|_| "Could not remove Copilot hooks.")?;
            }
            return Ok(());
        }
        let mut hooks = serde_json::Map::new();
        for (event, flag) in EVENTS {
            let command = format!(
                "exec {} copilot-hook --event {}{}",
                crate::relay::outbound::shell_quote(&self.executable.to_string_lossy()),
                flag,
                if self.config.development {
                    " --dev"
                } else {
                    ""
                }
            );
            hooks.insert((*event).into(), json!([{"type":"command","command":command,"timeoutSec":if *flag == "stop" { 3600 } else if *flag == "before" { 20 } else { 10 }}]));
        }
        let value = json!({"version":1,"agentRelayManagedBy":OWNER,"hooks":hooks});
        let bytes =
            serde_json::to_vec_pretty(&value).map_err(|_| "Could not encode Copilot hooks.")?;
        if std::fs::read(&path).ok().as_deref() == Some(&bytes) {
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
pub(super) fn installed(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file()
        || !crate::platform::fs::owned_by_current_user(&metadata)
        || !crate::platform::fs::private_to_owner(&metadata, 0o022)
    {
        return false;
    }
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|v| {
            v["agentRelayManagedBy"] == OWNER
                && v["version"] == 1
                && EVENTS.iter().all(|(event, flag)| {
                    v["hooks"][event].as_array().is_some_and(|a| {
                        a.len() == 1
                            && a[0]["type"] == "command"
                            && a[0]["command"]
                                .as_str()
                                .is_some_and(|command| command_matches(command, flag))
                    })
                })
        })
}
fn command_matches(command: &str, event: &str) -> bool {
    let Ok(args) = shell_words::split(command) else {
        return false;
    };
    (args.len() == 5 || (args.len() == 6 && args[5] == "--dev"))
        && args[0] == "exec"
        && args[2] == "copilot-hook"
        && args[3] == "--event"
        && args[4] == event
        && Path::new(&args[1]).is_absolute()
        && Path::new(&args[1])
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| {
                s.starts_with("agent-relay")
                    || matches!(s, "Agent Relay Helper" | "Agent Relay Dev Helper")
            })
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
    let program = Path::new(&expected[1]);
    let resolved = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
    actual == resolved && table.arguments(pid).get(1..) == Some(&expected[2..])
}
