//! Conversations of the Cursor editor's agent, reached through the same
//! inbox and hooks as Cursor CLI.
//!
//! No process holds an editor conversation's file open: one extension host
//! per window runs every agent conversation of that window, and runs
//! `~/.cursor/hooks.json` hooks as its own children with the conversation
//! in the payload. So the proof is the hook's parent, the kernel's
//! executable for it being Cursor's extension host, and the record
//! Agent Relay's hook leaves of it: which host (pid and start time) last
//! ran a hook for the conversation, and when. The conversation is live
//! while that host runs and has run one of its hooks within `IDLE`.
//!
//! A tool process of the conversation (a shell the agent runs) carries
//! `CURSOR_CONVERSATION_ID`; under a verified extension host it names the
//! caller, the way `CODEX_THREAD_ID` does under a trusted Codex.

use super::{is_session_id, CursorConfig};
use crate::relay::existing_session::platform;
use crate::relay::process::ProcessTable;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// What the editor's agent names its tool processes' conversation by.
pub const CONVERSATION_VAR: &str = "CURSOR_CONVERSATION_ID";

/// How long after its last hook an editor conversation still counts as
/// live in its window: a conversation left open in a window runs no hook
/// until its person starts a turn.
pub(super) const IDLE: Duration = Duration::from_secs(12 * 60 * 60);

/// What the Cursor editor's agent is called where it hosts a session.
pub const HOST: &str = "Cursor";

/// Whether `pid` is a Cursor window's extension host: Cursor's
/// `Cursor Helper (Plugin)` with the `extension-host` title Cursor gives
/// that process on macOS; on Linux, where the title is not set, its
/// `cursor` binary started as the extension host (the crash-reporter type
/// Cursor puts in its environment, or `--type=extensionHost`). Both it and
/// its parent must be Cursor's own binaries
/// (`ProcessTable::is_trusted_cursor`) of one install, and the parent
/// Cursor's main process started as the app (`is_cursor_main`), so a binary
/// merely named after Cursor, Cursor run as a tool (even by the host), or a
/// helper started by Cursor's binary run as plain Node is not. Cursor's
/// other helpers (renderers, its shared process, language servers) are not
/// either.
pub fn is_editor_host(table: &dyn ProcessTable, pid: i32) -> bool {
    let Some(executable) = table.executable(pid) else {
        return false;
    };
    let Some(file) = executable.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if file != "Cursor Helper (Plugin)" && file != "cursor" {
        return false;
    }
    let Some(parent) = table.process(pid).map(|process| process.parent) else {
        return false;
    };
    if !is_cursor_main(table, parent, &executable) || !table.is_trusted_cursor(&executable) {
        return false;
    }
    let arguments = table.arguments(pid);
    let titled = arguments
        .iter()
        .any(|argument| argument.contains("extension-host"));
    let helper = file == "Cursor Helper (Plugin)"
        && executable
            .to_string_lossy()
            .contains("/Contents/Frameworks/Cursor Helper (Plugin).app/");
    let linux = file == "cursor"
        && (titled
            || arguments
                .iter()
                .any(|argument| argument == "--type=extensionHost")
            || table
                .environment_var(pid, "VSCODE_CRASH_REPORTER_PROCESS_TYPE")
                .is_some_and(|kind| kind == "extensionHost"));
    (helper && titled) || linux
}

/// Whether `pid` is the main process of the Cursor install `helper` belongs
/// to, started as the app: its executable is that install's main binary
/// (`Cursor.app/Contents/MacOS/Cursor` around the helper's bundle on macOS,
/// the helper's own `cursor` binary on Linux) and Cursor's own; its
/// environment is readable and does not run it as plain Node
/// (`ELECTRON_RUN_AS_NODE`), where it would run any script and could start
/// a helper titled like a host; and it carries none of the switches a
/// helper (`--type=`) or a debugged main process (`--inspect…`,
/// `--remote-debugging…`) does.
fn is_cursor_main(table: &dyn ProcessTable, pid: i32, helper: &Path) -> bool {
    let Some(main) = table.executable(pid) else {
        return false;
    };
    let same_install = if main.file_name().is_some_and(|name| name == "Cursor") {
        main.parent()
            .filter(|dir| dir.ends_with("Contents/MacOS"))
            .and_then(Path::parent)
            .is_some_and(|contents| {
                helper.starts_with(contents.join("Frameworks/Cursor Helper (Plugin).app"))
            })
    } else {
        main == helper && main.file_name().is_some_and(|name| name == "cursor")
    };
    same_install
        && table.is_trusted_cursor(&main)
        && table.environment_readable(pid)
        && table.environment_var(pid, "ELECTRON_RUN_AS_NODE").is_none()
        && !table.arguments(pid).iter().any(|argument| {
            argument.starts_with("--type=")
                || argument.starts_with("--inspect")
                || argument.starts_with("--remote-debugging")
        })
}

/// Whether `pid` is the `cursor-agent … worker start` a Cursor window's
/// agent extension runs, directly under that window's extension host: it
/// holds no conversation of its own, so a walk goes on past it to the host.
pub fn is_editor_worker(table: &dyn ProcessTable, pid: i32) -> bool {
    table
        .arguments(pid)
        .windows(2)
        .any(|pair| pair[0] == "worker" && pair[1] == "start")
        && table
            .process(pid)
            .is_some_and(|process| is_editor_host(table, process.parent))
}

/// Whether a process `pid` under the extension host `host` may speak for
/// `session_id`: no `cursor-agent` of `uid`'s holds the conversation,
/// wherever its data folder is (`super::held_anywhere`, so the caller's
/// `CURSOR_DATA_DIR` cannot hide one), no record gives it to another
/// window's host that still runs (however long it has been idle), and the processes between `pid` and `host` vouch for it
/// (`path_vouches`). The first hook of a conversation's window establishes
/// its record.
pub(super) fn may_claim(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
    pid: i32,
    host: i32,
    session_id: &str,
) -> bool {
    if super::held_anywhere(table, uid, session_id) {
        return false;
    }
    let owner = owner(config, table, uid, session_id);
    if owner.is_some_and(|owner| owner != host) {
        return false;
    }
    match path_vouches(table, pid, host, session_id) {
        Some(Vouch::Named) => true,
        Some(Vouch::Launched) => {
            owner == Some(host) || recently_active(config, table, host, session_id)
        }
        None => false,
    }
}

/// How the processes between a caller and its host vouch for a conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Vouch {
    /// One of them names it in `CURSOR_CONVERSATION_ID`.
    Named,
    /// None names any, and the caller is what Cursor starts for a hook.
    Launched,
}

/// How long after Cursor last wrote a conversation's transcript a hook
/// that names no conversation may still take it up for its window.
const ACTIVE: Duration = Duration::from_secs(60 * 60);

/// Whether Cursor wrote `session_id`'s transcript (its own, or a subagent's)
/// within `ACTIVE`, in the data folder of `host`'s window
/// (`window_data_dir`): the conversation is running now.
///
/// Out of scope, as for every route here: code running as this user.
/// Cursor extensions run as the user inside the trusted extension host,
/// which starts the hooks, so an extension can start what looks like
/// Cursor's hook launch and name any conversation in the payload; Cursor
/// gives a hook nothing that proves which conversation started it. This
/// gate only keeps such a claim to a conversation running now that no
/// running window holds, rather than any a closed or reloaded window left.
fn recently_active(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    host: i32,
    session_id: &str,
) -> bool {
    let mut editor = CursorConfig::from_env(&|_| None, &config.home);
    editor.data_dir = window_data_dir(table, host).unwrap_or(editor.data_dir);
    super::inbox::transcripts(&editor, session_id)
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok()?.modified().ok())
        .any(|written| written.elapsed().map_or(true, |age| age < ACTIVE))
}

/// The `CURSOR_DATA_DIR` the Cursor of `host`'s window runs with: from the
/// host's own environment or, where the kernel shows none (macOS hides a
/// titled helper's), its main process's. Never the caller's own, which a
/// hook's starter chooses; `None` means Cursor's default, `~/.cursor`.
fn window_data_dir(table: &dyn ProcessTable, host: i32) -> Option<PathBuf> {
    let set = |pid: i32| {
        table
            .environment_var(pid, "CURSOR_DATA_DIR")
            .filter(|dir| !dir.trim().is_empty())
            .map(PathBuf::from)
    };
    set(host).or_else(|| set(table.process(host)?.parent))
}

/// Claims `session_id` for the extension host `host` on behalf of the hook
/// process `pid`, and records it (`record`): under a lock per conversation,
/// so two windows' first hooks cannot both pass `may_claim` and both record
/// themselves. Whoever records second finds the first one's record and is
/// refused. `false` when the claim or the record failed.
pub(super) fn claim(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    pid: i32,
    host: i32,
    session_id: &str,
    workspace: Workspace<'_>,
) -> bool {
    if !is_session_id(session_id) {
        return false;
    }
    locked(config, session_id, || {
        let uid = crate::relay::peer::current_uid();
        may_claim(config, table, uid, pid, host, session_id)
            && record(config, table, host, session_id, workspace)
    })
    .unwrap_or(false)
}

/// `session_id`'s record lock file, not yet locked.
pub(super) fn lock_file(config: &CursorConfig, session_id: &str) -> Option<std::fs::File> {
    let dir = records(config);
    std::fs::create_dir_all(&dir).ok()?;
    let _ = platform::set_mode(&dir, 0o700);
    use platform::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join(format!(".{session_id}.lock")))
        .ok()
}

/// Runs `run` under `session_id`'s record lock. `None` when it cannot be
/// taken.
fn locked<T>(config: &CursorConfig, session_id: &str, run: impl FnOnce() -> T) -> Option<T> {
    let lock = lock_file(config, session_id)?;
    fs2::FileExt::lock_exclusive(&lock).ok()?;
    let result = run();
    let _ = fs2::FileExt::unlock(&lock);
    Some(result)
}

/// Removes `session_id`'s record if it is still `stale`: under the record
/// lock, so a window that claimed the conversation since `stale` was read
/// keeps its own. Discovery calls this and a claim can hold the lock through
/// a signature check, so it never waits: when the lock is held the record
/// stays for the next discovery.
pub(super) fn remove_stale(config: &CursorConfig, session_id: &str, stale: &Record) {
    let path = records(config).join(format!("{session_id}.json"));
    let Some(lock) = lock_file(config, session_id) else {
        return;
    };
    if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
        return;
    }
    if read(&path).as_ref() == Some(stale) {
        let _ = std::fs::remove_file(&path);
    }
    let _ = fs2::FileExt::unlock(&lock);
}

/// How the processes from `pid` up to (not including) `host` vouch for
/// `session_id`, if they do: every one's environment is readable, none names another
/// conversation in `CURSOR_CONVERSATION_ID`, and either one names this one
/// (a tool of it) or none does and `pid` is what Cursor starts for a hook:
/// the host's own child, or the child of the host's `sh -c` or of the
/// window's `cursor-agent … worker start`. Cursor gives its hooks no
/// `CURSOR_CONVERSATION_ID`, only the payload; any deeper process naming
/// none descends from a tool or an extension that dropped it.
fn path_vouches(table: &dyn ProcessTable, pid: i32, host: i32, session_id: &str) -> Option<Vouch> {
    let mut named = false;
    let mut chain = Vec::new();
    let mut current = pid;
    for _ in 0..crate::relay::process::MAX_ANCESTRY {
        if current == host {
            let launched = match chain.as_slice() {
                [] | [_] => true,
                [_, launcher] => {
                    is_editor_worker(table, *launcher) || is_hook_shell(table, *launcher)
                }
                _ => false,
            };
            return if named {
                Some(Vouch::Named)
            } else {
                launched.then_some(Vouch::Launched)
            };
        }
        if current <= 1 || !table.environment_readable(current) {
            return None;
        }
        if let Some(id) = table.environment_var(current, CONVERSATION_VAR) {
            if id.trim().to_lowercase() != session_id {
                return None;
            }
            named = true;
        }
        let process = table.process(current)?;
        chain.push(current);
        current = process.parent;
    }
    None
}

/// Whether `pid` is a shell running one command string (`sh -c …`), the
/// way Cursor may start a hook command.
fn is_hook_shell(table: &dyn ProcessTable, pid: i32) -> bool {
    let arguments = table.arguments(pid);
    let shell = table
        .executable(pid)
        .and_then(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .is_some_and(|name| matches!(name.as_str(), "sh" | "bash" | "dash" | "zsh"));
    shell && arguments.get(1).is_some_and(|flag| flag == "-c")
}

/// Which extension host last ran a hook of a conversation, and when.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Record {
    pub host_pid: i32,
    pub host_start: u64,
    /// The window's first workspace folder.
    pub workspace: Option<String>,
    pub seen_ms: i64,
}

/// One live editor conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorSession {
    pub session_id: String,
    pub host_pid: i32,
    pub workspace: Option<String>,
    pub seen_ms: i64,
}

fn records(config: &CursorConfig) -> PathBuf {
    config
        .home
        .join(".agentworkforce")
        .join("desktop")
        .join("cursor")
        .join("editor")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|now| i64::try_from(now.as_millis()).ok())
        .unwrap_or(0)
}

/// Where `workspace` in a `record` call comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Workspace<'a> {
    /// The window's own folders, from a hook payload: it replaces any; a
    /// payload with none keeps what the same host recorded.
    Window(Option<&'a str>),
    /// A tool's working directory: used only when the same host recorded
    /// none for the conversation.
    Fallback(Option<&'a str>),
}

/// Records that `host`, a verified extension host of this user's, runs
/// `session_id`. The record is written beside and renamed into place, so a
/// reader never sees half of one. Failure only leaves the old record, and
/// answers `false`.
fn record(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    host: i32,
    session_id: &str,
    workspace: Workspace<'_>,
) -> bool {
    if !is_session_id(session_id) {
        return false;
    }
    let Some(process) = table.process(host) else {
        return false;
    };
    let dir = records(config);
    let path = dir.join(format!("{session_id}.json"));
    let previous = || {
        read(&path)
            .filter(|previous| previous.host_pid == host && previous.host_start == process.start)
            .and_then(|previous| previous.workspace)
    };
    let workspace = match workspace {
        Workspace::Window(Some(workspace)) => Some(workspace.to_string()),
        Workspace::Window(None) => previous(),
        Workspace::Fallback(workspace) => previous().or_else(|| workspace.map(str::to_string)),
    };
    let record = Record {
        host_pid: host,
        host_start: process.start,
        workspace,
        seen_ms: now_ms(),
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let _ = platform::set_mode(&dir, 0o700);
    static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let write = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let staging = dir.join(format!(
        ".{session_id}.json.{}.{write}.tmp",
        std::process::id()
    ));
    let Ok(bytes) = serde_json::to_vec(&record) else {
        return false;
    };
    use platform::OpenOptionsExt;
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staging)
        .and_then(|mut file| {
            file.write_all(&bytes)?;
            file.sync_all()
        });
    if written.is_err() || std::fs::rename(&staging, &path).is_err() {
        let _ = std::fs::remove_file(&staging);
        return false;
    }
    true
}

pub(super) fn read(path: &Path) -> Option<Record> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The extension host a record gives `session_id` to, while that same host
/// still runs, however long since its last hook.
fn owner(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> Option<i32> {
    let record = read(&records(config).join(format!("{session_id}.json")))?;
    hosts(table, uid, &record).then_some(record.host_pid)
}

/// Whether `record`'s host is still the same extension host of `uid`'s.
fn hosts(table: &dyn ProcessTable, uid: u32, record: &Record) -> bool {
    table
        .process(record.host_pid)
        .is_some_and(|process| process.uid == uid && process.start == record.host_start)
        && !table.zombie(record.host_pid)
        && is_editor_host(table, record.host_pid)
}

/// Whether `record`'s host is still the same extension host of `uid`'s and
/// ran a hook of the conversation within `IDLE`.
fn alive(table: &dyn ProcessTable, uid: u32, record: &Record) -> bool {
    now_ms().saturating_sub(record.seen_ms) < IDLE.as_millis() as i64 && hosts(table, uid, record)
}

/// Whether `session_id`'s record still gives it to the extension host
/// `host` started at `host_start`, and a hook of it ran within `IDLE`.
pub(super) fn holds(config: &CursorConfig, session_id: &str, host: i32, host_start: u64) -> bool {
    read(&records(config).join(format!("{session_id}.json"))).is_some_and(|record| {
        record.host_pid == host
            && record.host_start == host_start
            && now_ms().saturating_sub(record.seen_ms) < IDLE.as_millis() as i64
    })
}

/// The live editor conversation `session_id` names, if its host still runs.
pub fn live(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> Option<EditorSession> {
    if !platform::SUPPORTED || !is_session_id(session_id) {
        return None;
    }
    let record = read(&records(config).join(format!("{session_id}.json")))?;
    alive(table, uid, &record).then(|| EditorSession {
        session_id: session_id.to_string(),
        host_pid: record.host_pid,
        workspace: record.workspace,
        seen_ms: record.seen_ms,
    })
}

/// Every live editor conversation, by id. A record whose host is gone, or
/// whose pid another process now has, is removed.
pub fn sessions(config: &CursorConfig, table: &dyn ProcessTable, uid: u32) -> Vec<EditorSession> {
    if !platform::SUPPORTED {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(records(config)) else {
        return Vec::new();
    };
    let mut found: Vec<EditorSession> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let id = path
                .file_name()?
                .to_str()?
                .strip_suffix(".json")?
                .to_string();
            if !is_session_id(&id) {
                return None;
            }
            let record = read(&path)?;
            if !alive(table, uid, &record) {
                let replaced = table
                    .process(record.host_pid)
                    .is_some_and(|process| process.start != record.host_start);
                if replaced || table.process_gone(record.host_pid) {
                    remove_stale(config, &id, &record);
                }
                return None;
            }
            Some(EditorSession {
                session_id: id,
                host_pid: record.host_pid,
                workspace: record.workspace,
                seen_ms: record.seen_ms,
            })
        })
        .collect();
    found.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    found
}

/// The window's first workspace folder, from a hook payload.
pub(super) fn payload_workspace(payload: &Value) -> Option<&str> {
    payload["workspace_roots"]
        .as_array()?
        .iter()
        .find_map(|root| root.as_str().filter(|root| !root.trim().is_empty()))
}

/// The conversation a tool process of the editor's agent names, from its
/// own environment: `CURSOR_CONVERSATION_ID` on `pid` or, where macOS
/// hides an Apple binary's environment, the processes below `host` on its
/// walk up that show one. Processes that name different conversations, or
/// one that is no conversation id, name none.
pub fn tool_conversation(table: &dyn ProcessTable, pid: i32, host: i32) -> Option<String> {
    path_conversation(table, pid, host).filter(|id| is_session_id(id))
}

/// Every `CURSOR_CONVERSATION_ID` the processes from `pid` up to (not
/// including) `host` show, as one value; any disagreement, or a walk that
/// never reaches `host`, reads as an empty one.
fn path_conversation(table: &dyn ProcessTable, pid: i32, host: i32) -> Option<String> {
    let mut found: Option<String> = None;
    let mut current = pid;
    for _ in 0..crate::relay::process::MAX_ANCESTRY {
        if current == host {
            return found;
        }
        if current <= 1 {
            return Some(String::new());
        }
        if let Some(id) = table.environment_var(current, CONVERSATION_VAR) {
            let id = id.trim().to_lowercase();
            if found.as_ref().is_some_and(|seen| *seen != id) {
                return Some(String::new());
            }
            found = Some(id);
        }
        let Some(process) = table.process(current) else {
            return Some(String::new());
        };
        current = process.parent;
    }
    Some(String::new())
}

/// The first line of the conversation's first prompt, from Cursor's
/// transcript, for its title; `None` when there is no transcript.
pub(super) fn title(config: &CursorConfig, session_id: &str) -> Option<String> {
    use std::io::Read;
    let path = super::inbox::transcripts(config, session_id)
        .into_iter()
        .next()?;
    let mut head = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(256 << 10)
        .read_to_end(&mut head)
        .ok()?;
    let text = String::from_utf8_lossy(&head);
    let entry = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|entry| entry["role"] == "user")?;
    let prompt = entry["message"]["content"]
        .as_array()?
        .iter()
        .find_map(|part| part["text"].as_str())?;
    let prompt = match prompt.split_once("<user_query>") {
        Some((_, rest)) => rest.split("</user_query>").next().unwrap_or(rest),
        None => prompt,
    };
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let mut title: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        title.push('…');
    }
    Some(title)
}
