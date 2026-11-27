//! Recognizes Agent Relay hook commands for managed provider hook files.
use super::HOOK_SUBCOMMAND;
use std::path::Path;

pub(super) fn is_ours(command: &str) -> bool {
    is_ours_running(command, HOOK_SUBCOMMAND)
}

/// Whether `command` runs `subcommand` of one of our executables. Shared by
/// managed hook files (Devin's `config.json`, Cursor's `hooks.json`).
pub(crate) fn is_ours_running(command: &str, subcommand: &str) -> bool {
    let body = command.trim();
    let Some(executable) = body.strip_suffix(subcommand).map(str::trim_end) else {
        return false;
    };
    // The earlier `<executable> relay <subcommand>` form is ours too, so
    // setup replaces it with the current one.
    let executable = executable
        .strip_suffix(" relay")
        .map(str::trim_end)
        .unwrap_or(executable);
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
        .is_some_and(|name| name.starts_with("agent-relay") || name == "Agent Relay Helper")
}
