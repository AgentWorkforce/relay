//! Transient systemd scopes for what the core starts on Linux, so a spawned
//! agent, or a Codex daemon the core had to start, is outside the core's own
//! cgroup and outlives `systemctl --user restart agent-relay.service`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// `systemd-run` when this user's systemd manager is running (its private
/// socket is under `$XDG_RUNTIME_DIR/systemd`): Linux only.
pub fn systemd_run(
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let runtime = env("XDG_RUNTIME_DIR").filter(|dir| dir.starts_with('/'))?;
    if !exists(&Path::new(&runtime).join("systemd/private")) {
        return None;
    }
    ["/usr/bin/systemd-run", "/bin/systemd-run"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| exists(path))
}

/// Starts in the scope `unit`, else without one. A scoped start that fails
/// may already have started the agent inside the scope, so the scope is
/// stopped first (ending anything in it; nothing when it never existed):
/// the retry must not leave a second agent running beside the first.
pub(crate) fn start_scoped_or_plain(
    systemd_run: &Path,
    unit: &str,
    start: impl Fn(Option<(&Path, &str)>) -> Result<i32, String>,
) -> Result<i32, String> {
    start(Some((systemd_run, unit))).or_else(|_| {
        let _ = Command::new(systemd_run.with_file_name("systemctl"))
            .args(["--user", "stop", &format!("{unit}.scope")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        start(None)
    })
}

/// The arguments that run a command in the transient scope `unit` of the
/// user's manager; the command follows. `systemd-run --scope` runs the
/// command itself, in place, once the scope exists, so its output and exit
/// are the command's, and the scope ends when the last process in it does.
pub fn scope_arguments(unit: &str) -> Vec<String> {
    [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        &format!("--unit={unit}"),
        "--description=Agent Relay spawned agent",
        "--",
    ]
    .map(String::from)
    .to_vec()
}

/// A scope name systemd accepts: `agent-relay-spawn-<id>`, from letters,
/// digits and dashes only.
pub fn scope_unit(id: &str) -> String {
    let id: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    format!("agent-relay-spawn-{id}")
}
