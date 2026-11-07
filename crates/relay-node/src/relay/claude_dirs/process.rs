//! Discover the configuration folders of native Claude Code processes.

use super::*;

/// `CLAUDE_CONFIG_DIR` of each running Claude Code process of this user.
pub fn running_config_dirs(table: &dyn ProcessTable) -> Vec<PathBuf> {
    let uid = crate::relay::peer::current_uid();
    let mut found = Vec::new();
    for pid in table.all_pids() {
        if table.process(pid).is_none_or(|p| p.uid != uid) {
            continue;
        }
        if !is_claude_code(table, pid) {
            continue;
        }
        let Some(dir) = table
            .environment_var(pid, "CLAUDE_CONFIG_DIR")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let path = PathBuf::from(dir);
        if path.is_absolute() && !found.contains(&path) {
            found.push(path);
        }
    }
    found
}

/// Whether a file name is Claude Code's program: `claude`, and on Windows
/// the native `claude.exe` or npm's `claude.cmd` shim, in any letter case.
pub(crate) fn is_claude_name(name: &str) -> bool {
    if cfg!(windows) {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "claude" | "claude.exe" | "claude.cmd"
        )
    } else {
        name == "claude"
    }
}

/// A Claude Code process: `claude` by its first or second argument (the
/// native binary, or `node …/claude`), or Anthropic's Node package.
/// Whether `pid` runs Claude Code: its first or second argument is named
/// `claude`, or is Anthropic's npm package path (`node .../claude-code/cli.js`,
/// with either separator on Windows).
pub(crate) fn is_claude_code(table: &dyn ProcessTable, pid: i32) -> bool {
    let arguments = table.arguments(pid);
    arguments.iter().take(2).any(|argument| {
        let name = Path::new(argument)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        is_claude_name(&name)
            || argument.contains("@anthropic-ai/claude-code/")
            || (cfg!(windows) && argument.contains("@anthropic-ai\\claude-code\\"))
    })
}
