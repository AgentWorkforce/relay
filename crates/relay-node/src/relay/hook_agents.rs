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

/// Whether `pid` is Copilot CLI (native or npm under Node), or VS Code
/// Copilot's native `copilot-runtime`. Both are caller-attribution boundaries.
pub fn is_copilot_process(table: &dyn ProcessTable, pid: i32) -> bool {
    let named = table.executable(pid).is_some_and(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                [
                    "copilot",
                    "copilot.exe",
                    "copilot-runtime",
                    "copilot-runtime.exe",
                ]
                .iter()
                .any(|expected| name.eq_ignore_ascii_case(expected))
            })
    });
    let node = table.executable(pid).is_some_and(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.eq_ignore_ascii_case("node") || name.eq_ignore_ascii_case("node.exe")
            })
    });
    named
        || (node
            && node_script(&table.arguments(pid)).is_some_and(|argument| {
                let parts: Vec<_> = argument.split(['/', '\\']).collect();
                parts.windows(2).any(|pair| pair == ["@github", "copilot"])
            }))
}

// Only the Node entry point establishes identity. Later user arguments can
// contain package paths too, so skip Node options without scanning script args.
fn node_script(arguments: &[String]) -> Option<&str> {
    let mut args = arguments.iter().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-e" | "--eval" | "-p" | "--print" => return None,
            arg if arg.starts_with("--eval=") || arg.starts_with("--print=") => return None,
            "--" => return args.next().map(String::as_str),
            "-r"
            | "--require"
            | "--import"
            | "--loader"
            | "--experimental-loader"
            | "--conditions"
            | "-C" => {
                args.next()?;
            }
            _ if arg.starts_with('-') => {}
            _ => return Some(arg),
        }
    }
    None
}

/// Whether `pid` is an agent other than Claude Code that runs hooks
/// written for Claude: Cursor CLI and Copilot CLI read Claude's
/// `settings.json` hooks, and Devin and Codex run Claude-format hooks of
/// their own. The Cursor editor's extension host counts too: it runs the
/// hooks of `~/.cursor/hooks.json`, so one under it is never Claude's. A hook
/// found under one of these belongs to it, even when a Claude Code session
/// further up started it.
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

#[cfg(test)]
mod copilot_tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};

    #[test]
    fn attached_eval_and_print_do_not_treat_user_arguments_as_a_script() {
        for flag in ["--eval=console.log('hello')", "--print=process.version"] {
            let arguments = [
                "node",
                flag,
                "--",
                "/opt/node_modules/@github/copilot/index.js",
            ]
            .map(str::to_owned);
            assert!(node_script(&arguments).is_none());
        }
    }
    #[test]
    fn message_arguments_do_not_make_a_relay_client_a_copilot_process() {
        let table = FakeProcesses::default();
        table.insert(
            1,
            FakeProcess {
                executable: Some("/opt/agent-relay-node".into()),
                arguments: vec![
                    "agent-relay-node".into(),
                    "--body".into(),
                    "Please update @github/copilot".into(),
                ],
                ..Default::default()
            },
        );
        assert!(!is_copilot_process(&table, 1));
        table.insert(
            2,
            FakeProcess {
                executable: Some("/opt/node".into()),
                arguments: vec![
                    "node".into(),
                    "/opt/node_modules/@github/copilot/index.js".into(),
                ],
                ..Default::default()
            },
        );
        assert!(is_copilot_process(&table, 2));
        let mut node = table.processes.lock().unwrap().get(&2).unwrap().clone();
        node.executable = Some("/opt/Node.EXE".into());
        node.arguments.insert(1, "--no-warnings".into());
        table.insert(3, node);
        assert!(is_copilot_process(&table, 3));
        table.insert(
            4,
            FakeProcess {
                executable: Some("/opt/node".into()),
                arguments: vec![
                    "node".into(),
                    "other-script.js".into(),
                    "/opt/node_modules/@github/copilot/index.js".into(),
                ],
                ..Default::default()
            },
        );
        assert!(!is_copilot_process(&table, 4));
    }
}
