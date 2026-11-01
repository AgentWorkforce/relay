//! Cursor CLI (`cursor-agent`) sessions on this computer and the route into
//! them, which the Cursor editor's agent conversations share (`editor`).
//! Not Cursor Cloud agents, which Agent Relay Cloud reaches through Cursor's
//! API.
//!
//! A `cursor-agent` process holds its conversation's
//! `<cursor data>/chats/<workspace hash>/<conversation id>/store.db` open
//! for as long as that conversation is the one it runs, idle or working.
//! That open descriptor is the kernel's proof of which session a process
//! is, the way a Devin session's held lock is: a reused pid, a copied path
//! or a non-Cursor binary holds nothing.
//!
//! - **Discovery** lists the conversation each live `cursor-agent` holds.
//! - **Caller identification** ends at the first `cursor-agent` ancestor
//!   and names the conversation it holds, or nobody.
//! - **Delivery** stages a file in Agent Relay's own inbox for the session.
//!   Agent Relay's hooks in `~/.cursor/hooks.json` hand it to the session
//!   at its next tool call (`postToolUse` → `additional_context`) or when
//!   its turn ends (`stop` → `followup_message`, a new user turn). A CLI
//!   session idle at its prompt runs no hook, so its messages wait for its
//!   person. An editor conversation's `stop` hook waits after a completed
//!   turn instead, and answers the next message staged for it (`wait`).
//! - **Settlement** claims a message before the hook prints it and
//!   tombstones it once the answer is written. A claim the hook never
//!   finished is settled by Cursor's transcript, which records a `stop`
//!   follow-up as a user turn; one it cannot find there is in doubt and is
//!   never sent again.

use crate::relay::existing_session::platform;
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, SessionKind, Target};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// What the apps and adapters call this harness.
pub const LABEL: &str = "Cursor CLI";

/// Where Cursor CLI keeps its state, and where Agent Relay keeps the inbox
/// its hooks drain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorConfig {
    /// `CURSOR_DATA_DIR`, else `~/.cursor`: `chats/` and `projects/`.
    pub data_dir: PathBuf,
    /// `CURSOR_CONFIG_DIR`, else `XDG_CONFIG_HOME/cursor`, else `~/.cursor`:
    /// `cli-config.json`, which only the CLI writes.
    pub config_dir: PathBuf,
    /// The user's home. Cursor reads user hooks from `~/.cursor/hooks.json`
    /// whatever the data and config directories are.
    pub home: PathBuf,
    /// Agent Relay Dev stages and drains its own inbox, so neither build's
    /// hook consumes the other's messages.
    pub development: bool,
}

impl CursorConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> CursorConfig {
        let set = |key: &str| {
            env(key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        CursorConfig {
            data_dir: set("CURSOR_DATA_DIR").unwrap_or_else(|| home.join(".cursor")),
            config_dir: set("CURSOR_CONFIG_DIR")
                .or_else(|| set("XDG_CONFIG_HOME").map(|dir| dir.join("cursor")))
                .unwrap_or_else(|| home.join(".cursor")),
            home: home.to_path_buf(),
            development: false,
        }
    }

    /// This configuration selecting Agent Relay Dev's inbox.
    pub fn development(mut self, development: bool) -> CursorConfig {
        self.development = development;
        self
    }

    /// One directory per workspace, one per conversation inside it.
    pub fn chats(&self) -> PathBuf {
        self.data_dir.join("chats")
    }

    /// The user hooks file Cursor CLI reads at every session start.
    pub fn hooks_file(&self) -> PathBuf {
        self.home.join(".cursor").join("hooks.json")
    }

    /// The queue this build's hook drains: `inbox.d` for Agent Relay,
    /// `inbox-dev.d` for Agent Relay Dev.
    pub fn inbox(&self) -> PathBuf {
        let name = if self.development {
            "inbox-dev.d"
        } else {
            "inbox.d"
        };
        self.home
            .join(".agentworkforce")
            .join("desktop")
            .join("cursor")
            .join(name)
    }

    /// Cursor CLI has run on this computer (it writes `cli-config.json`),
    /// or the Cursor editor's agent has (it keeps transcripts in
    /// `projects/`).
    pub fn installed(&self) -> bool {
        self.config_dir.join("cli-config.json").is_file() || self.data_dir.join("projects").is_dir()
    }
}

/// Whether the kernel's executable for `pid` is a Cursor CLI agent: the
/// `node` Cursor ships in `cursor-agent/versions/<version>/`, or a binary
/// named `cursor-agent`. Its `worker-server` child holds no conversation and
/// is not a session.
pub fn is_cursor_process(table: &dyn ProcessTable, pid: i32) -> bool {
    let Some(executable) = table.executable(pid) else {
        return false;
    };
    let name = |path: Option<&Path>| {
        path.and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .map(str::to_string)
    };
    let file = name(Some(executable.as_path())).unwrap_or_default();
    let shipped = matches!(file.as_str(), "node" | "node.exe")
        && name(executable.parent().and_then(Path::parent)).as_deref() == Some("versions")
        && name(
            executable
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent),
        )
        .as_deref()
            == Some("cursor-agent");
    let named = matches!(file.as_str(), "cursor-agent" | "cursor-agent.exe");
    (shipped || named)
        && !table
            .arguments(pid)
            .iter()
            .any(|argument| argument == "worker-server")
}

/// The spellings of the chats directory a held descriptor may name: as
/// configured, and fully resolved, since the kernel reports resolved paths.
fn chat_roots(config: &CursorConfig) -> Vec<PathBuf> {
    let lexical = config.chats();
    let mut roots = vec![lexical.clone()];
    if let Ok(resolved) = std::fs::canonicalize(&lexical) {
        if resolved != lexical {
            roots.push(resolved);
        }
    }
    roots
}

/// The conversation a held descriptor names, if it is a `store.db` exactly
/// two levels under the chats directory, in a directory named by a
/// conversation id, and the directory entry is still the inode the
/// descriptor holds. A store replaced after it was opened names nothing.
fn held_store(roots: &[PathBuf], file: &crate::relay::process::OpenedFile) -> Option<String> {
    if file.path.file_name()? != "store.db" {
        return None;
    }
    let conversation = file.path.parent()?;
    let workspace = conversation.parent()?;
    if !roots
        .iter()
        .any(|root| workspace.parent() == Some(root.as_path()))
    {
        return None;
    }
    let id = conversation.file_name()?.to_str()?;
    if !is_session_id(id) {
        return None;
    }
    let held = file.birth_ns?;
    let named = crate::relay::process::file_birth_ns(&file.path)?;
    (held == named).then(|| id.to_string())
}

/// Every conversation `pid` holds open.
fn held_stores(config: &CursorConfig, table: &dyn ProcessTable, pid: i32) -> Vec<String> {
    let roots = chat_roots(config);
    let mut ids: Vec<String> = table
        .opened_files(pid)
        .iter()
        .filter_map(|file| held_store(&roots, file))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// A Cursor conversation id: a lowercase hyphenated UUID.
pub fn is_session_id(id: &str) -> bool {
    is_uuid(id) && !id.bytes().any(|byte| byte.is_ascii_uppercase())
}

/// The session `pid` is, from the store it holds open, never from what the
/// process says. A `cursor-agent` holding none (a fresh TUI before its first
/// prompt, `cursor-agent status`) or several names nobody.
pub fn held_session(config: &CursorConfig, table: &dyn ProcessTable, pid: i32) -> Option<String> {
    let mut held = held_stores(config, table, pid);
    (held.len() == 1).then(|| held.remove(0))
}

/// One live session's holding process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldSession {
    pub session_id: String,
    pub pid: i32,
}

/// The sessions live `cursor-agent` processes of `uid`'s hold. Never on
/// Windows, where the route is not available.
pub fn held_sessions(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<HeldSession> {
    if !platform::SUPPORTED || !config.chats().is_dir() {
        return Vec::new();
    }
    let mut sessions: Vec<HeldSession> = table
        .all_pids()
        .into_iter()
        .filter(|pid| {
            table
                .process(*pid)
                .is_some_and(|process| process.uid == uid)
                && !table.zombie(*pid)
                && is_cursor_process(table, *pid)
        })
        .filter_map(|pid| {
            held_session(config, table, pid).map(|session_id| HeldSession { session_id, pid })
        })
        .collect();
    // Two processes holding one conversation (a resumed chat beside the
    // original) leave which one a hook runs in unknowable: neither is
    // listed or delivered to.
    let mut counts = std::collections::HashMap::new();
    for session in &sessions {
        *counts.entry(session.session_id.clone()).or_insert(0) += 1;
    }
    sessions.retain(|session| counts[&session.session_id] == 1);
    sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    sessions
}

/// The live Cursor CLI session `session_id` names, if one is held now.
pub fn held(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> Option<HeldSession> {
    held_sessions(config, table, uid)
        .into_iter()
        .find(|session| session.session_id == session_id)
}

/// Whether any live `cursor-agent` of `uid`'s holds a `<session_id>/store.db`
/// open, under whichever data folder: what a hook's or tool's own
/// `CURSOR_DATA_DIR` names cannot hide a CLI session from the editor route.
pub(crate) fn held_anywhere(table: &dyn ProcessTable, uid: u32, session_id: &str) -> bool {
    table.all_pids().into_iter().any(|pid| {
        table.process(pid).is_some_and(|process| process.uid == uid)
            && !table.zombie(pid)
            && is_cursor_process(table, pid)
            && table.open_files(pid).iter().any(|path| {
                path.file_name().is_some_and(|name| name == "store.db")
                    && path
                        .parent()
                        .and_then(Path::file_name)
                        .is_some_and(|name| name == session_id)
            })
    })
}

/// The store `session_id`'s holder has open, under whichever workspace.
fn store_path(config: &CursorConfig, session_id: &str) -> Option<PathBuf> {
    std::fs::read_dir(config.chats())
        .ok()?
        .flatten()
        .map(|workspace| workspace.path().join(session_id).join("store.db"))
        .find(|path| path.is_file())
}

/// The conversation's name, which Cursor keeps in the store's `meta` row as
/// hex-encoded JSON. Read-only; any failure reads as no name.
fn store_name(store: &Path) -> Option<String> {
    let connection = rusqlite::Connection::open_with_flags(
        store,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    connection.busy_timeout(Duration::from_millis(200)).ok()?;
    let hex: String = connection
        .query_row("SELECT value FROM meta WHERE key = '0'", [], |row| {
            row.get(0)
        })
        .ok()?;
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|at| {
            hex.get(at..at + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        })
        .collect::<Option<_>>()?;
    let meta: Value = serde_json::from_slice(&bytes).ok()?;
    meta["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    i64::try_from(
        modified
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis(),
    )
    .ok()
}

/// The live Cursor CLI sessions and Cursor editor conversations on this
/// computer, for the session list. A conversation a `cursor-agent` holds
/// is listed as that CLI session.
pub fn discover(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<DiscoveredSession> {
    let mut found = discover_cli(config, table, uid);
    let held: std::collections::HashSet<String> = found
        .iter()
        .map(|session| session.target.id.clone())
        .collect();
    found.extend(
        editor::sessions(config, table, uid)
            .into_iter()
            .filter(|session| !held.contains(&session.session_id))
            .map(|session| DiscoveredSession {
                target: Target::new(SessionKind::CursorCli, session.session_id.clone()),
                title: editor::title(config, &session.session_id)
                    .unwrap_or_else(|| session.session_id.clone()),
                directory: session.workspace,
                updated_at_ms: Some(session.seen_ms),
                host: Some(editor::HOST.to_string()),
                live: true,
                holder: None,
            }),
    );
    found
}

fn discover_cli(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<DiscoveredSession> {
    held_sessions(config, table, uid)
        .into_iter()
        .map(|held| {
            let store = store_path(config, &held.session_id);
            let updated_at_ms = store.as_ref().and_then(|store| {
                // The write-ahead log changes with every turn; the store
                // itself only at checkpoints.
                let mut wal = store.clone().into_os_string();
                wal.push("-wal");
                modified_ms(Path::new(&wal)).or_else(|| modified_ms(store))
            });
            DiscoveredSession {
                target: Target::new(SessionKind::CursorCli, held.session_id.clone()),
                title: store
                    .as_deref()
                    .and_then(store_name)
                    .unwrap_or_else(|| held.session_id.clone()),
                directory: table
                    .cwd(held.pid)
                    .map(|path| path.to_string_lossy().into_owned()),
                updated_at_ms,
                host: None,
                live: true,
                holder: None,
            }
        })
        .collect()
}

/// The live Cursor session `session_id` names, as one listing row.
pub fn session(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> Option<DiscoveredSession> {
    discover(config, table, uid)
        .into_iter()
        .find(|session| session.target.id == session_id)
}

/// Whether `session_id` runs now, in a `cursor-agent` that alone holds it
/// or in a Cursor editor window, so a reply command its tools run can
/// reach the core.
pub fn running(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> bool {
    held(config, table, uid, session_id).is_some()
        || editor::live(config, table, uid, session_id).is_some()
}

/// How many ancestors a hook climbs to its `cursor-agent`: Cursor runs a
/// hook through a shell, so it is normally the grandparent.
const HOOK_ANCESTRY: usize = 8;

/// What a hook runs under, when it may hand over a session's messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookCaller {
    /// The one `cursor-agent` holding the session's store.
    Cli,
    /// A Cursor window's extension host (`editor`), which runs the
    /// conversation the payload names.
    Editor { host: i32 },
}

/// What the hook process `start` runs under, for `session_id`: the first
/// agent above the hook, of this user's. Either the `cursor-agent` holding
/// the session, when it is the one process holding that conversation's
/// store open, as discovery requires; or a Cursor editor window's extension
/// host, which runs every conversation of its window and runs their hooks
/// as its children, when the conversation is not another window's or a
/// CLI's (`editor::may_claim`). The editor's own `cursor-agent` worker is
/// walked past. The payload's id alone never drains a session's inbox,
/// and neither does a second Cursor that resumed the same conversation or a
/// hook any other agent runs.
pub fn hook_caller(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    start: i32,
    session_id: &str,
) -> Option<HookCaller> {
    let uid = crate::relay::peer::current_uid();
    let mut pid = start;
    for _ in 0..HOOK_ANCESTRY {
        if pid <= 1 {
            return None;
        }
        let process = table.process(pid)?;
        if process.uid == uid && is_cursor_process(table, pid) {
            let holder = held(config, table, uid, session_id).is_some_and(|held| held.pid == pid);
            if holder {
                return Some(HookCaller::Cli);
            }
            if !editor::is_editor_worker(table, pid) {
                return None;
            }
            pid = process.parent;
            continue;
        }
        if process.uid == uid && editor::is_editor_host(table, pid) {
            return (platform::SUPPORTED
                && editor::may_claim(config, table, uid, start, pid, session_id))
            .then_some(HookCaller::Editor { host: pid });
        }
        if crate::relay::hook_agents::is_claude_process(table, pid)
            || crate::relay::hook_agents::is_other_agent(table, pid)
        {
            return None;
        }
        pid = process.parent;
    }
    None
}

/// Whether the hook process `start` may hand over `session_id`'s messages
/// (`hook_caller`).
pub fn hook_caller_holds(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    start: i32,
    session_id: &str,
) -> bool {
    hook_caller(config, table, start, session_id).is_some()
}

/// Claims and records the editor conversation the hook process `start`
/// under `host` runs (`editor::claim`), so delivery and the session list see
/// it live. `false` when it may not, or the record failed: the hook then
/// hands nothing over.
pub fn record_editor_hook(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    start: i32,
    host: i32,
    payload: &Value,
) -> bool {
    payload_session(payload).is_some_and(|session_id| {
        editor::claim(
            config,
            table,
            start,
            host,
            session_id,
            editor::Workspace::Window(editor::payload_workspace(payload)),
        )
    })
}

/// One run of Agent Relay's hook for `payload` in the process `pid`. It
/// first notes a turn starting and retires a hook still waiting after
/// another turn of the conversation (`wait::turn_seen`); a
/// `beforeSubmitPrompt` does only that.
/// Then, only under the caller `hook_caller` proves, it hands the
/// conversation's staged messages over through `write`, which says whether
/// the answer was written in full: claims are tombstoned once it was and
/// put back if not. With `watch` (the `stop` entry's `--wait`) an editor
/// conversation's completed turn waits for its next message (`wait::wait`).
/// A Cursor CLI session answers at once, and keeps Cursor's own limit of
/// follow-ups in a row (`wait::CURSOR_LOOP_LIMIT`), which that entry lifts.
/// `true` once it answered.
pub fn run_hook(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    pid: i32,
    payload: &Value,
    watch: Option<&wait::Watch<'_>>,
    write: &mut dyn FnMut(&Value) -> bool,
) -> bool {
    wait::turn_seen(config, payload);
    let Some(session) = payload_session(payload) else {
        return false;
    };
    if payload["hook_event_name"] == "beforeSubmitPrompt" {
        return false;
    }
    match hook_caller(config, table, pid, session) {
        None => false,
        Some(HookCaller::Cli) => {
            let looped = payload["hook_event_name"] == "stop"
                && payload["loop_count"]
                    .as_u64()
                    .is_some_and(|count| count >= wait::CURSOR_LOOP_LIMIT);
            !(watch.is_some() && looped) && answer_now(config, payload, write)
        }
        Some(HookCaller::Editor { host }) => {
            if !record_editor_hook(config, table, pid, host, payload) {
                return false;
            }
            match watch {
                Some(watch) if wait::waits_after(payload) => {
                    wait::wait(config, table, host, payload, watch, write) == wait::Ended::Answered
                }
                _ => answer_now(config, payload, write),
            }
        }
    }
}

fn answer_now(
    config: &CursorConfig,
    payload: &Value,
    write: &mut dyn FnMut(&Value) -> bool,
) -> bool {
    let Some(answer) = hook_answer(config, payload) else {
        return false;
    };
    let written = write(&answer.output);
    if written {
        drain(&answer.claimed);
    } else {
        unclaim(config, &answer.claimed);
    }
    written
}

/// The caller a tool process `pid` of the editor's agent is, once the walk
/// up from it reaches the extension host `host` of this user's: the
/// conversation its `CURSOR_CONVERSATION_ID` names, when a hook of that
/// conversation already recorded it live under this host, or nobody. A
/// tool's environment alone never puts a conversation on a host.
pub fn editor_caller(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    pid: i32,
    host: i32,
) -> Option<String> {
    if !platform::SUPPORTED || !editor::is_editor_host(table, host) {
        return None;
    }
    let uid = crate::relay::peer::current_uid();
    let session_id = editor::tool_conversation(table, pid, host)?;
    let owned = editor::live(config, table, uid, &session_id)
        .is_some_and(|session| session.host_pid == host);
    if !owned {
        return None;
    }
    let workspace = table
        .cwd(pid)
        .map(|path| path.to_string_lossy().into_owned());
    editor::claim(
        config,
        table,
        pid,
        host,
        &session_id,
        editor::Workspace::Fallback(workspace.as_deref()),
    )
    .then_some(session_id)
}

pub mod editor;
mod inbox;
mod settings;
pub mod wait;
pub use inbox::{
    drain, hook_answer, payload_session, send, unclaim, HookAnswer, HOOK_EVENTS, HOOK_SUBCOMMAND,
};
pub use settings::{CursorSettings, SETTING};

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;
    use crate::relay::agents::SettingsExtension;
    use crate::relay::inject::InjectOutcome;

    #[test]
    fn cursor_cli_is_not_available_on_windows() {
        let home = tempfile::tempdir().unwrap();
        let config = CursorConfig::from_env(&|_| None, home.path());
        std::fs::create_dir_all(config.chats()).unwrap();
        std::fs::write(config.config_dir.join("cli-config.json"), "{}").unwrap();
        let table = crate::relay::process::FakeProcesses::default();
        assert!(discover(&config, &table, 0).is_empty());
        let session = "6e0af963-e21c-4fb8-a8e8-7f34765b6d64";
        assert_eq!(
            send(&config, &table, 0, session, "message", "hi"),
            InjectOutcome::Refused("Cursor CLI is not available on Windows.".into())
        );
        let settings = CursorSettings::new(&config, "agent-relay-probe relay cursor-hook".into());
        assert!(settings.get().is_empty());
        assert_eq!(
            settings.set(SETTING, &Value::Bool(true)),
            Some(Err("Cursor CLI is not available on Windows.".into()))
        );
    }
}

#[cfg(test)]
mod editor_tests;
#[cfg(test)]
mod tests;
