//! Recognizes only Agent Relay hook commands for this build mode.
use super::HOOK_SUBCOMMAND;
use std::path::Path;

pub(super) fn is_ours(command: &str, installed: &str) -> bool {
    let dev = |command: &str| command.trim_end().ends_with(" --dev");
    if dev(command) != dev(installed) {
        return false;
    }
    let body = command.trim();
    let body = body.strip_suffix(" --dev").unwrap_or(body).trim_end();
    let Some(executable) = body.strip_suffix(HOOK_SUBCOMMAND).map(str::trim_end) else {
        return false;
    };
    let executable = executable
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .or_else(|| {
            executable
                .strip_prefix('\'')
                .and_then(|inner| inner.strip_suffix('\''))
        })
        .unwrap_or(executable);
    Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with("agent-relay")
                || matches!(name, "Agent Relay Helper" | "Agent Relay Dev Helper")
        })
}
