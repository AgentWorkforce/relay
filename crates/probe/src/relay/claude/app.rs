//! Claude chats an app hosts as a structured run: Paseo's top-level chats
//! and the chats in Claude's desktop app. The app runs each Code chat as a local
//! Claude Code process that publishes the same session record, inbox and
//! socket as a terminal session, so delivery reaches it the same way. The
//! app drives that process as a structured `stream-json` run with no
//! terminal, which [`super::is_interactive_terminal`] rightly takes for
//! automation, but a person is typing in it.

use std::path::Path;

use super::TerminalSession;
use crate::relay::process::{ProcessTable, MAX_ANCESTRY};

/// The `entrypoint` the app records for its chats.
pub const ENTRYPOINT: &str = "claude-desktop";

/// The app's main executable, installed for all users or for this one.
pub fn is_app(executable: &Path) -> bool {
    let path = executable.to_string_lossy();
    (path.starts_with("/Applications/Claude.app/")
        || (path.starts_with("/Users/") && path.contains("/Applications/Claude.app/")))
        && path.ends_with("/Claude.app/Contents/MacOS/Claude")
}

/// Whether `directory` is a folder the app made for a chat with no project
/// (`…/Claude/scratch-workspaces/…`), whose generated name says nothing
/// about the chat.
pub fn is_scratch_workspace(directory: &str) -> bool {
    directory.contains("/Application Support/Claude/scratch-workspaces/")
}

/// Whether a live registry entry is a chat a person runs in Claude's desktop
/// app: recorded as an interactive `claude-desktop` session, and started by
/// this user's Claude app. No other Claude Code session (`sessions`) may sit
/// between them: a `claude -p` or SDK run a chat starts from its tools would
/// reach the app only through that chat, so it stays automation.
pub fn is_app_chat(
    table: &dyn ProcessTable,
    session: &TerminalSession,
    sessions: &[TerminalSession],
) -> bool {
    if session.entrypoint.as_deref() != Some(ENTRYPOINT)
        || session.kind.as_deref() != Some("interactive")
    {
        return false;
    }
    let Some(uid) = table.process(session.pid).map(|process| process.uid) else {
        return false;
    };
    let mut current = session.pid;
    for _ in 0..MAX_ANCESTRY {
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return false;
        };
        if current != session.pid {
            if table.executable(current).is_some_and(|exe| is_app(&exe)) {
                return true;
            }
            if sessions.iter().any(|other| other.pid == current) {
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

/// Whether a live registry entry is the top-level Claude chat Paseo hosts.
/// Paseo drives it as a structured stream-json process, so it is a person's
/// chat even though it correctly fails [`super::is_interactive_terminal`]. A nested
/// Claude session started from that chat is still automation.
pub fn is_paseo_chat(
    table: &dyn ProcessTable,
    session: &TerminalSession,
    sessions: &[TerminalSession],
) -> bool {
    let Some(process) = table.process(session.pid) else {
        return false;
    };
    crate::relay::paseo::under_daemon_excluding(table, process.uid, session.pid, &|pid| {
        sessions.iter().any(|other| other.pid == pid)
    }) && table.process(session.pid) == Some(process)
}

/// Whether a live registry entry is a person's chat that an app hosts as a
/// structured run: a top-level Paseo chat or a Claude desktop app chat.
pub fn is_app_hosted_chat(
    table: &dyn ProcessTable,
    session: &TerminalSession,
    sessions: &[TerminalSession],
) -> bool {
    is_paseo_chat(table, session, sessions) || is_app_chat(table, session, sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_claude_app_bundle_is_the_app() {
        assert!(is_app(Path::new(
            "/Applications/Claude.app/Contents/MacOS/Claude"
        )));
        assert!(is_app(Path::new(
            "/Users/me/Applications/Claude.app/Contents/MacOS/Claude"
        )));
        for other in [
            "/Applications/Claude.app/Contents/Helpers/disclaimer",
            "/tmp/Claude.app/Contents/MacOS/Claude",
            "/Users/me/Library/Application Support/Claude/claude-code/2.1.299/x/claude.app/Contents/MacOS/claude",
        ] {
            assert!(!is_app(Path::new(other)), "{other}");
        }
    }

    #[test]
    fn scratch_workspaces_are_the_apps_own_folders() {
        assert!(is_scratch_workspace(
            "/Users/me/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-10-16-55cdc4"
        ));
        assert!(!is_scratch_workspace("/Users/me/Projects/api"));
    }
}
