//! Which agent a hook command runs under. Cursor CLI and Copilot CLI read
//! the hooks in Claude Code's `settings.json`, and Devin and Codex run
//! Claude-format hooks of their own, so a hook cannot tell from its
//! environment or its file which agent started it: the nearest agent
//! process above it does.

use crate::relay::process::ProcessTable;

/// Whether `pid` is a Claude Code process: its executable is named
/// `claude`, or [`is_claude_code`] matches its arguments (`claude`, or
/// Anthropic's npm package under Node).
///
/// [`is_claude_code`]: crate::relay::claude_dirs::is_claude_code
pub fn is_claude_process(table: &dyn ProcessTable, pid: i32) -> bool {
    let executable = table.executable(pid).is_some_and(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(crate::relay::claude_dirs::is_claude_name)
    });
    executable || crate::relay::claude_dirs::is_claude_code(table, pid)
}

/// Whether `pid` is GitHub Copilot CLI: the `copilot` binary, or its npm
/// package under Node.
pub fn is_copilot_process(table: &dyn ProcessTable, pid: i32) -> bool {
    let named = table.executable(pid).is_some_and(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, "copilot" | "copilot.exe"))
    });
    named
        || table
            .arguments(pid)
            .iter()
            .any(|argument| argument.contains("@github/copilot"))
}

/// Whether `pid` is an agent other than Claude Code that runs hooks
/// written for Claude: Cursor CLI and Copilot CLI read Claude's
/// `settings.json` hooks, and Devin and Codex run Claude-format hooks of
/// their own. A hook found under one of these belongs to it, even when a
/// Claude Code session further up started it.
pub fn is_other_agent(table: &dyn ProcessTable, pid: i32) -> bool {
    crate::relay::cursor_cli::is_cursor_process(table, pid)
        || crate::relay::cursor_cli::editor::is_editor_host(table, pid)
        || is_copilot_process(table, pid)
        || crate::relay::devin::is_devin_process(table, pid)
        || crate::relay::opencode::is_opencode_process(table, pid)
        || table
            .executable(pid)
            .is_some_and(|exe| table.is_trusted_codex(&exe))
}
