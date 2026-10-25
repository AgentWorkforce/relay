//! Sessions Conductor (conductor.build) runs. Conductor gives each of its
//! Claude Code and Codex sessions a workspace, a worktree under
//! `~/conductor/workspaces/<repository>/<name>`, and starts their agents
//! from its runtime. The sessions are ordinary Claude Code and Codex
//! sessions otherwise; `host` only says which app a person chats in.

use crate::relay::process::{ProcessTable, MAX_ANCESTRY};
use std::path::Path;

/// The `host` of a session that runs in a Conductor workspace.
pub const HOST: &str = "conductor";

/// The runtime Conductor starts its agents from, in its application data
/// directory.
pub const RUNTIME: &str = "com.conductor.app/bin/.internal/conductor-runtime";

/// The line a Claude Code session in Conductor is given with a relayed
/// message. Conductor shows the session's reply turn but not a message that
/// arrived through Claude Code's peer inbox, so the person would see an
/// answer to nothing.
pub const QUOTE_NOTE: &str = "[conductor: the person cannot see this message in Conductor's chat; start your reply by quoting it in full as a Markdown blockquote, then answer]";

/// Conductor's application data directory, whose presence shows Conductor
/// has run on this computer.
pub fn data_dir(home: &Path) -> std::path::PathBuf {
    home.join("Library/Application Support/com.conductor.app")
}

/// Whether `directory` is in a Conductor workspace.
pub fn is_workspace(directory: &str) -> bool {
    directory.contains("/conductor/workspaces/")
}

/// The app hosting a session in `directory`: `conductor`, or none.
pub fn host(directory: Option<&str>) -> Option<String> {
    directory
        .filter(|directory| is_workspace(directory))
        .map(|_| HOST.to_string())
}

/// The blocks a harness puts before a person's first prompt: Conductor's
/// `<system_instruction>`, Codex's `<recommended_plugins>`,
/// `<environment_context>` and `<user_instructions>`, and Grok's
/// `<user_info>` and `<rules>`. Only these are skipped, so a prompt a person
/// starts with their own tag keeps it.
const PREAMBLE_TAGS: &[&str] = &[
    "system_instruction",
    "recommended_plugins",
    "environment_context",
    "user_instructions",
    "user_info",
    "rules",
];

/// `text` after the closed [`PREAMBLE_TAGS`] blocks that lead it, each
/// through its closing tag, repeated. An unclosed block is left as it is.
pub fn without_preamble(text: &str) -> &str {
    let mut rest = text.trim_start();
    while let Some(tag) = rest
        .strip_prefix('<')
        .and_then(|after| after.split_once('>'))
        .map(|(tag, _)| tag)
        .filter(|tag| PREAMBLE_TAGS.contains(tag))
    {
        let Some((_, after)) = rest.split_once(&format!("</{tag}>")) else {
            break;
        };
        rest = after.trim_start();
    }
    rest
}

/// Whether `executable` is Conductor's runtime.
pub fn is_runtime(executable: &Path) -> bool {
    executable.ends_with(RUNTIME)
}

/// Whether `pid` is this user's Conductor sidecar: Conductor's runtime
/// running `sidecar`, which starts every agent a Conductor chat runs.
pub fn is_sidecar(table: &dyn ProcessTable, uid: u32, pid: i32) -> bool {
    table.process(pid).is_some_and(|p| p.uid == uid)
        && table.executable(pid).is_some_and(|exe| is_runtime(&exe))
        && table.arguments(pid).iter().any(|a| a == "sidecar")
}

/// Whether this user's Conductor sidecar started `pid`: the nearest
/// ancestor that is Conductor's runtime is the sidecar. Between them may be
/// a launcher such as a `claude_code_executable_path` script, which `exec`s
/// into the agent, or Conductor's own executable proxy, but no process
/// `agent` names: a run an agent starts from its own tools reaches the
/// sidecar through that agent, and is the agent's, not Conductor's. The walk
/// ends at the first process of another user.
pub fn under_sidecar(
    table: &dyn ProcessTable,
    uid: u32,
    pid: i32,
    agent: &dyn Fn(i32) -> bool,
) -> bool {
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return false;
        };
        if current != pid {
            if table
                .executable(current)
                .is_some_and(|exe| is_runtime(&exe))
            {
                return is_sidecar(table, uid, current);
            }
            if agent(current) {
                return false;
            }
        }
        if process.parent <= 1 {
            return false;
        }
        current = process.parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_conductor_workspace_names_its_host() {
        let workspace = "/Users/me/conductor/workspaces/app/caracas";
        assert_eq!(host(Some(workspace)).as_deref(), Some("conductor"));
        assert_eq!(host(Some("/Users/me/src/app")), None);
        assert_eq!(host(None), None);
        assert!(is_runtime(Path::new(
            "/Users/me/Library/Application Support/com.conductor.app/bin/.internal/conductor-runtime"
        )));
        assert!(!is_runtime(Path::new("/usr/local/bin/conductor-runtime")));
    }

    #[test]
    fn only_this_users_sidecar_counts() {
        use crate::relay::process::{FakeProcess, FakeProcesses};
        let runtime = std::path::PathBuf::from(
            "/Users/me/Library/Application Support/com.conductor.app/bin/.internal/conductor-runtime",
        );
        let table = FakeProcesses::default();
        let node = |parent, uid, exe: Option<std::path::PathBuf>, args: &[&str]| FakeProcess {
            parent,
            uid,
            start: 1,
            executable: exe,
            arguments: args.iter().map(|a| a.to_string()).collect(),
            ..FakeProcess::default()
        };
        table.insert(
            10,
            node(
                1,
                501,
                Some(runtime.clone()),
                &["conductor-runtime", "sidecar"],
            ),
        );
        table.insert(20, node(10, 501, None, &["sh", "claude-conductor"]));
        table.insert(30, node(20, 501, None, &["claude"]));
        let none = |_: i32| false;
        assert!(is_sidecar(&table, 501, 10));
        assert!(under_sidecar(&table, 501, 30, &none));
        assert!(
            !under_sidecar(&table, 501, 10, &none),
            "the sidecar is not under itself"
        );
        assert!(!under_sidecar(&table, 502, 30, &none), "another user's");
        // A run the chat (30) starts from one of its tools goes through it.
        table.insert(40, node(30, 501, None, &["zsh"]));
        table.insert(50, node(40, 501, None, &["claude", "-p", "x"]));
        let chat = |pid: i32| pid == 30;
        assert!(!under_sidecar(&table, 501, 50, &chat));
        assert!(under_sidecar(&table, 501, 30, &chat), "the chat itself");
        table.insert(
            10,
            node(
                1,
                501,
                Some(runtime.clone()),
                &["conductor-runtime", "logger"],
            ),
        );
        assert!(!under_sidecar(&table, 501, 30, &none));
        table.insert(
            10,
            node(
                1,
                501,
                Some("/usr/bin/conductor-runtime".into()),
                &["x", "sidecar"],
            ),
        );
        assert!(!under_sidecar(&table, 501, 30, &none));
    }

    #[test]
    fn a_harness_preamble_is_skipped() {
        let prompt = "<system_instruction>\nYou are working inside Conductor.\n</system_instruction>\n\n<recommended_plugins>\nx\n</recommended_plugins>\nCheck in";
        assert_eq!(without_preamble(prompt), "Check in");
        assert_eq!(without_preamble("  Fix <b>this</b>"), "Fix <b>this</b>");
        let unclosed = "<system_instruction>\nYou are working inside";
        assert_eq!(without_preamble(unclosed), unclosed);
        assert_eq!(without_preamble("<Div>x</Div> y"), "<Div>x</Div> y");
        assert_eq!(without_preamble("<b>Bold</b> please"), "<b>Bold</b> please");
        let codex = "<environment_context>\n<cwd>/x</cwd>\n</environment_context>\n<user_instructions>y</user_instructions>\nCheck in";
        assert_eq!(without_preamble(codex), "Check in");
        let grok = "<user_info>\nOS Version: macos\n</user_info>\n\n<rules>\n<user_rules>\n<user_rule>x</user_rule>\n</user_rules>\n</rules>";
        assert_eq!(without_preamble(grok), "");
        // A person's own snake_case tag is their prompt, not a preamble.
        let tagged = "<task_details>Fix the upload test and retain its logs.</task_details>";
        assert_eq!(without_preamble(tagged), tagged);
        assert_eq!(
            without_preamble(
                "<system_instruction>x</system_instruction>\n<task_details>Fix it</task_details>"
            ),
            "<task_details>Fix it</task_details>"
        );
    }
}
