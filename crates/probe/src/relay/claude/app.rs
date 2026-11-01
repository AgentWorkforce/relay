//! Claude chats an app hosts as a structured run: Paseo's top-level chats,
//! T3 Code's chats on macOS and Linux and the chats in Claude's desktop app.
//! The app runs each Code chat as a local Claude Code process that publishes
//! the same session record, inbox and socket as a terminal session, so
//! delivery reaches it the same way. The app drives that process as a
//! structured `stream-json` run with no terminal, which
//! [`super::is_interactive_terminal`] rightly takes for automation, but a
//! person is typing in it.

use std::path::Path;

use super::{Registry, TerminalSession};
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

/// T3 Code's main executable on any release channel, installed for all
/// users or for this one: the macOS bundle (`T3 Code.app` or
/// `T3 Code (<Channel>).app`), the Linux package in
/// `/opt/T3 Code (<Channel>)/t3code`, or a running Linux AppImage, which
/// mounts itself at `$TMPDIR/.mount_<random>/t3code`. Its backend server is
/// the same executable, so a chat's parent matches too.
pub fn is_t3_app(executable: &Path) -> bool {
    let Some(name) = executable.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let path = executable.to_string_lossy();
    if name == "t3code" {
        let Some(folder) = executable
            .parent()
            .and_then(Path::file_name)
            .and_then(|folder| folder.to_str())
        else {
            return false;
        };
        return path.starts_with('/')
            && ((is_t3_product(folder) && path == format!("/opt/{folder}/t3code"))
                || folder
                    .strip_prefix(".mount_")
                    .is_some_and(|id| !id.is_empty()));
    }
    is_t3_product(name)
        && (path.starts_with("/Applications/")
            || (path.starts_with("/Users/") && path.contains("/Applications/")))
        && path.ends_with(&format!("/{name}.app/Contents/MacOS/{name}"))
}

/// T3 Code's product name on any release channel: `T3 Code` or
/// `T3 Code (<Channel>)`.
fn is_t3_product(name: &str) -> bool {
    name == "T3 Code"
        || name
            .strip_prefix("T3 Code (")
            .and_then(|rest| rest.strip_suffix(')'))
            .is_some_and(|channel| {
                !channel.is_empty() && channel.chars().all(char::is_alphanumeric)
            })
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
    registry: &Registry,
) -> bool {
    session.entrypoint.as_deref() == Some(ENTRYPOINT) && hosted_by(table, session, registry, is_app)
}

/// Whether a live registry entry is a chat a person runs in T3 Code, which
/// records its chats as `sdk-ts` like any SDK run, so only the process tree
/// tells them apart. A Claude session a chat starts stays automation, and so
/// does `claude -p` in T3 Code's terminal, which can also record `interactive`.
pub fn is_t3_chat(
    table: &dyn ProcessTable,
    session: &TerminalSession,
    registry: &Registry,
) -> bool {
    is_structured_chat_process(table, session.pid) && hosted_by(table, session, registry, is_t3_app)
}

/// Whether `pid` runs the way an app drives a chat: a `stream-json` pipe with
/// no terminal and no `-p`/`--print`.
fn is_structured_chat_process(table: &dyn ProcessTable, pid: i32) -> bool {
    let arguments = table.arguments(pid);
    let printing = arguments
        .iter()
        .any(|arg| arg == "-p" || arg == "--print" || arg.starts_with("--print="));
    let structured = arguments.iter().enumerate().any(|(index, argument)| {
        argument == "--input-format=stream-json"
            || (argument == "--input-format"
                && arguments.get(index + 1).map(String::as_str) == Some("stream-json"))
    });
    structured && !printing && !table.has_terminal(pid)
}

/// Whether an interactive registry entry was started by this user's `host`
/// executable, with no other Claude Code session between them, not even one
/// whose registry file cannot be read.
fn hosted_by(
    table: &dyn ProcessTable,
    session: &TerminalSession,
    registry: &Registry,
    host: fn(&Path) -> bool,
) -> bool {
    if session.kind.as_deref() != Some("interactive") {
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
            if table.executable(current).is_some_and(|exe| host(&exe)) {
                return true;
            }
            if registry.sessions.iter().any(|other| other.pid == current)
                || registry.unreadable.iter().any(|file| file.pid == current)
            {
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
/// structured run: a top-level Paseo chat, a T3 Code chat or a Claude desktop
/// app chat.
pub fn is_app_hosted_chat(
    table: &dyn ProcessTable,
    session: &TerminalSession,
    registry: &Registry,
) -> bool {
    is_paseo_chat(table, session, &registry.sessions)
        || is_t3_chat(table, session, registry)
        || is_app_chat(table, session, registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use crate::relay::sessions::UnreadableSessionFile;

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
    fn only_the_t3_code_bundles_are_t3_code() {
        for app in [
            "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)",
            "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
            "/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)",
            "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)",
            "/Users/me/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)",
            // The Linux packages: the stable and preview builds install as Beta.
            "/opt/T3 Code (Beta)/t3code",
            "/opt/T3 Code (Nightly)/t3code",
            "/opt/T3 Code/t3code",
            // A running AppImage, mounted under /tmp or $TMPDIR.
            "/tmp/.mount_T3-CodmajGcH/t3code",
            "/home/me/.cache/tmp/.mount_T3-Codx1Y2z3/t3code",
        ] {
            assert!(is_t3_app(Path::new(app)), "{app}");
        }
        for other in [
            "/Applications/T3 Code (Alpha).app/Contents/Resources/resource-monitor/t3-resource-monitor",
            "/Applications/T3 Code (Alpha).app/Contents/Frameworks/T3 Code (Alpha) Helper (Renderer).app/Contents/MacOS/T3 Code (Alpha) Helper (Renderer)",
            "/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code",
            "/Applications/T3 Code ().app/Contents/MacOS/T3 Code ()",
            "/tmp/T3 Code.app/Contents/MacOS/T3 Code",
            "/Applications/Claude.app/Contents/MacOS/Claude",
            "/opt/T3 Code (Beta)/chrome_crashpad_handler",
            "/opt/T3 Code (Beta)/resources/resource-monitor/t3-resource-monitor",
            "/tmp/.mount_T3-CodmajGcH/resources/resource-monitor/t3-resource-monitor",
            "/opt/T3 Code ()/t3code",
            "/opt/Other/t3code",
            "/home/me/opt/T3 Code (Beta)/t3code",
            "/tmp/.mount_/t3code",
            "/tmp/squashfs-root/t3code",
            "/usr/bin/t3code",
            "/home/me/.local/bin/t3code",
            "t3code",
            ".mount_T3-CodmajGcH/t3code",
        ] {
            assert!(!is_t3_app(Path::new(other)), "{other}");
        }
    }

    const T3: &str = "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)";
    /// Every T3 Code main executable a chat's process tree reaches: the macOS
    /// bundle, the Linux package and a running Linux AppImage.
    const T3_BUILDS: [&str; 3] = [
        T3,
        "/opt/T3 Code (Beta)/t3code",
        "/tmp/.mount_T3-CodmajGcH/t3code",
    ];

    fn process(parent: i32, executable: Option<&str>) -> FakeProcess {
        FakeProcess {
            parent,
            uid: 501,
            executable: executable.map(Into::into),
            ..FakeProcess::default()
        }
    }

    fn chat_process(parent: i32) -> FakeProcess {
        FakeProcess {
            arguments: vec![
                "claude".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--input-format".into(),
                "stream-json".into(),
            ],
            ..process(parent, Some("/usr/local/bin/claude"))
        }
    }

    fn session(pid: i32, kind: Option<&str>) -> TerminalSession {
        TerminalSession {
            session_id: "7f2a4cab-5d9e-4e3a-9b8c-3c4d5e6f7a01".into(),
            pid,
            socket_path: "/s".into(),
            peer_protocol: 1,
            proc_start: None,
            cwd: None,
            name: None,
            status: None,
            entrypoint: Some("sdk-ts".into()),
            kind: kind.map(Into::into),
            updated_at_ms: None,
            registry: None,
        }
    }

    fn registry(sessions: &[&TerminalSession]) -> Registry {
        Registry {
            sessions: sessions.iter().map(|&session| session.clone()).collect(),
            unreadable: Vec::new(),
        }
    }

    #[test]
    fn a_t3_code_chat_is_a_persons_chat_but_what_it_starts_is_not() {
        for t3 in T3_BUILDS {
            // T3 Code's main process starts its backend server from the same
            // executable, and the server starts each chat.
            let table = FakeProcesses::default();
            table.insert(10, process(1, Some(t3)));
            table.insert(11, process(10, Some(t3)));
            table.insert(12, chat_process(11));
            table.insert(13, process(12, Some("/bin/zsh")));
            table.insert(14, chat_process(13));

            let chat = session(12, Some("interactive"));
            assert!(is_t3_chat(&table, &chat, &registry(&[&chat])), "{t3}");
            assert!(
                is_app_hosted_chat(&table, &chat, &registry(&[&chat])),
                "{t3}"
            );

            let nested = session(14, Some("interactive"));
            assert!(
                !is_t3_chat(&table, &nested, &registry(&[&chat, &nested])),
                "{t3}"
            );

            // The parent chat's record cannot be read: its pid still stops the walk.
            let unreadable = Registry {
                sessions: vec![nested.clone()],
                unreadable: vec![UnreadableSessionFile {
                    path: "/sessions/12.json".into(),
                    pid: 12,
                    error: "expected value".into(),
                }],
            };
            assert!(!is_t3_chat(&table, &nested, &unreadable), "{t3}");

            let run = session(12, Some("sdk"));
            assert!(!is_t3_chat(&table, &run, &registry(&[&run])), "{t3}");
            let unknown = session(12, None);
            assert!(
                !is_t3_chat(&table, &unknown, &registry(&[&unknown])),
                "{t3}"
            );
        }
    }

    #[test]
    fn a_t3_code_chat_run_by_another_user_is_not_this_users_chat() {
        for t3 in T3_BUILDS {
            let table = FakeProcesses::default();
            table.insert(
                40,
                FakeProcess {
                    uid: 0,
                    ..process(1, Some(t3))
                },
            );
            table.insert(41, chat_process(40));
            let chat = session(41, Some("interactive"));
            assert!(!is_t3_chat(&table, &chat, &registry(&[&chat])), "{t3}");
        }
    }

    #[test]
    fn claude_print_in_t3_codes_terminal_stays_automation() {
        for t3 in T3_BUILDS {
            let table = FakeProcesses::default();
            table.insert(30, process(1, Some(t3)));
            table.insert(31, process(30, Some("/bin/zsh")));
            table.insert(
                32,
                FakeProcess {
                    arguments: vec!["claude".into(), "-p".into(), "hello".into()],
                    has_terminal: true,
                    ..process(31, Some("/usr/local/bin/claude"))
                },
            );
            let run = session(32, Some("interactive"));
            assert!(!is_t3_chat(&table, &run, &registry(&[&run])), "{t3}");

            // A structured pipe in that terminal is a script, not the app's chat.
            table.insert(
                33,
                FakeProcess {
                    has_terminal: true,
                    ..chat_process(31)
                },
            );
            let piped = session(33, Some("interactive"));
            assert!(!is_t3_chat(&table, &piped, &registry(&[&piped])), "{t3}");

            table.insert(
                34,
                FakeProcess {
                    arguments: vec![
                        "claude".into(),
                        "-p".into(),
                        "--input-format=stream-json".into(),
                    ],
                    ..process(30, Some("/usr/local/bin/claude"))
                },
            );
            let printing = session(34, Some("interactive"));
            assert!(
                !is_t3_chat(&table, &printing, &registry(&[&printing])),
                "{t3}"
            );
        }
    }

    #[test]
    fn a_sdk_run_outside_t3_code_stays_automation() {
        let table = FakeProcesses::default();
        table.insert(20, process(1, Some("/usr/local/bin/node")));
        table.insert(21, chat_process(20));
        let run = session(21, Some("interactive"));
        assert!(!is_t3_chat(&table, &run, &registry(&[&run])));
    }

    #[test]
    fn scratch_workspaces_are_the_apps_own_folders() {
        assert!(is_scratch_workspace(
            "/Users/me/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-10-16-55cdc4"
        ));
        assert!(!is_scratch_workspace("/Users/me/Projects/api"));
    }
}
