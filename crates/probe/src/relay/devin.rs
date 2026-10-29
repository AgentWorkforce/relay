//! Devin CLI sessions on this computer and the route into them.
//!
//! A Devin session runs its agent in a `devin acp` process (or in the
//! `devin` process itself for harnesses without a child), which holds
//! `<data>/cli/session_locks/<session>.lock` open for as long as the
//! session lives. That open descriptor is the kernel's proof that a
//! process is that session: a pid copied out of a stale lock, or one
//! reused by an unrelated process, holds nothing, and neither does a
//! non-Devin binary.
//!
//! - **Discovery** lists the session each live `devin` process's held
//!   lock names.
//! - **Caller identification** ends at the first `devin` ancestor and
//!   names the session whose lock it holds open, so a Devin subprocess
//!   that is not a session never lends an outer session's identity.
//! - **Delivery** writes the session's inbox file under
//!   `<data>/relay/inbox.d/`, atomically renamed into place. The
//!   session's lifecycle hooks drain files named `<session>.*.msg` into
//!   the conversation at the next hook boundary.

use crate::relay::existing_session::platform;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{SessionKind, Target};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// Where Devin keeps its state: `XDG_DATA_HOME/devin`, else
/// `~/.local/share/devin` — the same path on Linux and macOS. Its
/// configuration, including the lifecycle hooks, lives apart in
/// `XDG_CONFIG_HOME/devin`, else `~/.config/devin`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevinConfig {
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    /// The user's home, kept for the cloud route's credential lookup:
    /// `devin-cloud`'s send resolves `credentials.toml`/`config.json`
    /// from it with the same XDG resolution `data_dir`/`config_dir` used.
    pub home: PathBuf,
    /// Agent Relay Dev stages and drains its own inbox, so a development
    /// build's hook never consumes production's queue and the dev core
    /// never places messages where production's hook reads.
    pub development: bool,
}

impl DevinConfig {
    /// Reads `XDG_DATA_HOME` and `XDG_CONFIG_HOME` from `env`; `home` is
    /// the user's home directory. The production inbox is the default;
    /// `development` selects Agent Relay Dev's.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> DevinConfig {
        let xdg = |key: &str, fallback: &[&str]| {
            env(key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| expand_tilde(&value, home))
                .unwrap_or_else(|| {
                    fallback
                        .iter()
                        .fold(home.to_path_buf(), |p, part| p.join(part))
                })
        };
        DevinConfig {
            data_dir: xdg("XDG_DATA_HOME", &[".local", "share"]).join("devin"),
            config_dir: xdg("XDG_CONFIG_HOME", &[".config"]).join("devin"),
            home: home.to_path_buf(),
            development: false,
        }
    }

    /// This same configuration selecting Agent Relay Dev's inbox.
    pub fn development(mut self, development: bool) -> DevinConfig {
        self.development = development;
        self
    }

    /// The CLI's directory: `session_locks/`, `transcripts/`, `sessions.db`.
    pub fn cli(&self) -> PathBuf {
        self.data_dir.join("cli")
    }

    /// A session's lock file names its holding process while it lives.
    pub fn session_locks(&self) -> PathBuf {
        self.cli().join("session_locks")
    }

    /// The file queue this build's hooks drain into the conversation:
    /// `inbox.d` for Agent Relay, `inbox-dev.d` for Agent Relay Dev.
    pub fn inbox(&self) -> PathBuf {
        let name = if self.development {
            "inbox-dev.d"
        } else {
            "inbox.d"
        };
        self.data_dir.join("relay").join(name)
    }

    /// Devin's own configuration, whose `hooks` object runs a command at
    /// each lifecycle boundary — Agent Relay's route into the conversation.
    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.json")
    }
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(&rest[1..]),
        _ => PathBuf::from(path),
    }
}

/// A lexical absolute spelling, so a missing path cannot bypass a symlinked
/// home merely because `canonicalize` needs it to exist.
fn normalized(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
            Component::RootDir => result.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            Component::Normal(part) => result.push(part),
        }
    }
    result
}

/// One inbox file path spelling: the lock directory's canonical form, so a
/// descriptor read through `/proc` (whose target is fully resolved) still
/// matches a `devin` data directory reached through a symlink.
fn session_lock_variants(config: &DevinConfig) -> Vec<PathBuf> {
    let lexical = normalized(&config.session_locks());
    let mut variants = vec![lexical.clone()];
    if let Ok(resolved) = std::fs::canonicalize(&lexical) {
        let resolved = normalized(&resolved);
        if resolved != lexical {
            variants.push(resolved);
        }
    }
    variants
}

pub(crate) mod hook_command;
/// A Devin session id as a lock file names it: lowercase letters, digits
/// and dashes, starting and ending alphanumeric, at most 128 bytes.
mod session_id;
pub use session_id::is_session_id;

/// Whether the kernel's executable for `pid` is Devin.
pub fn is_devin_process(table: &dyn ProcessTable, pid: i32) -> bool {
    table.executable(pid).is_some_and(|executable| {
        executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "devin" || name == "devin.exe")
    })
}

/// The session a held descriptor names and the held inode's birth, if it is
/// a session lock in `config`'s lock directory whose recorded birth still
/// matches the directory entry's own inode. A lock replaced after it was
/// opened — which a new file's recorded pid could impersonate — never
/// matches, and a filesystem that cannot say the birth names nothing.
fn held_lock(
    locks: &[PathBuf],
    file: &crate::relay::process::OpenedFile,
) -> Option<(String, i128)> {
    let parent = file.path.parent()?;
    if !locks.iter().any(|locks| parent == locks) {
        return None;
    }
    let name = file.path.file_name()?.to_str()?;
    let id = name.strip_suffix(".lock")?;
    if !is_session_id(id) {
        return None;
    }
    let held = file.birth_ns?;
    let named = crate::relay::process::file_birth_ns(&file.path)?;
    (held == named).then(|| (id.to_string(), held))
}

/// Every session lock `pid` provably holds open: each session id with the
/// birth of the inode its descriptor holds. Devin Desktop's one `devin acp`
/// multiplexes every session it runs, holding all their locks at once, so a
/// first-match read would name only one of its sessions.
fn held_locks(
    config: &DevinConfig,
    table: &dyn ProcessTable,
    pid: i32,
) -> std::collections::HashMap<String, i128> {
    let locks = session_lock_variants(config);
    table
        .opened_files(pid)
        .iter()
        .filter_map(|file| held_lock(&locks, file))
        .collect()
}

/// The session `pid` is, from the lock it holds open — never from what the
/// process says about itself. A `devin` process that holds no session lock
/// is a command, not a session, and names nobody. Neither does one holding
/// several: Devin Desktop's shared `acp` holds every session's lock, so
/// naming the first would lend a caller the wrong session's identity.
pub fn held_session(config: &DevinConfig, table: &dyn ProcessTable, pid: i32) -> Option<String> {
    let held = held_locks(config, table, pid);
    (held.len() == 1).then(|| held.into_keys().next()).flatten()
}

/// One live session's holding process, as its lock and the kernel agree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldSession {
    pub session_id: String,
    pub pid: i32,
}

/// The sessions a live `devin` process of `uid`'s provably holds, from each
/// lock file's recorded pid re-proven against the descriptor it keeps. A
/// stale or rewritten lock names no live holder, so it lists nothing. One
/// process may hold several sessions' locks — Devin Desktop's `acp` runs
/// them all — so each lock is checked against the whole set it holds.
pub fn held_sessions(config: &DevinConfig, table: &dyn ProcessTable, uid: u32) -> Vec<HeldSession> {
    let mut sessions = Vec::new();
    // Devin is not available on Windows: no session there is held, listed
    // or delivered to.
    if !platform::SUPPORTED {
        return sessions;
    }
    let mut held_by_pid: std::collections::HashMap<i32, std::collections::HashMap<String, i128>> =
        std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir(config.session_locks()) else {
        return sessions;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".lock"))
            .filter(|id| is_session_id(id))
        else {
            continue;
        };
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(pid) = contents.trim().parse::<i32>() else {
            continue;
        };
        let Some(process) = table.process(pid) else {
            continue;
        };
        let held = held_by_pid
            .entry(pid)
            .or_insert_with(|| held_locks(config, table, pid));
        // The cached proof names the inode the descriptor holds; the entry
        // must still be that inode, re-stated now, or a lock replaced
        // mid-scan would pass on a stale name. A birth the filesystem
        // cannot say proves nothing either.
        if process.uid != uid
            || !is_devin_process(table, pid)
            || crate::relay::process::file_birth_ns(&path)
                .is_none_or(|named| held.get(id) != Some(&named))
        {
            continue;
        }
        sessions.push(HeldSession {
            session_id: id.to_string(),
            pid,
        });
    }
    sessions
}

/// The live Devin session `id` names, if one is held now.
pub fn held(
    config: &DevinConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> Option<HeldSession> {
    held_sessions(config, table, uid)
        .into_iter()
        .find(|session| session.session_id == session_id)
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

/// Devin's session database, opened read-only; a missing or unreadable one
/// degrades a listing to lock-file facts, never to nothing listed.
fn open_database(config: &DevinConfig) -> Option<rusqlite::Connection> {
    let path = config.cli().join("sessions.db");
    if !path.is_file() {
        return None;
    }
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    connection
        .busy_timeout(std::time::Duration::from_millis(200))
        .ok()?;
    Some(connection)
}

/// What Devin's session database says a session is: its title, workspace and
/// last activity (stored as epoch seconds). A missing database, table or
/// row reads as none of it.
struct SessionRecord {
    title: Option<String>,
    working_directory: Option<String>,
    last_activity_ms: Option<i64>,
}

fn session_record(
    database: Option<&rusqlite::Connection>,
    session_id: &str,
) -> Option<SessionRecord> {
    database?
        .query_row(
            "SELECT title, working_directory, last_activity_at FROM sessions WHERE id = ?1",
            [session_id],
            |row| {
                Ok(SessionRecord {
                    title: row.get::<_, Option<String>>(0)?,
                    working_directory: row.get::<_, Option<String>>(1)?,
                    last_activity_ms: row
                        .get::<_, Option<i64>>(2)?
                        .and_then(|seconds| seconds.checked_mul(1000)),
                })
            },
        )
        .ok()
}

/// The live Devin sessions on this computer, for the session list.
pub fn discover(
    config: &DevinConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<DiscoveredSession> {
    let database = open_database(config);
    held_sessions(config, table, uid)
        .into_iter()
        .map(|held| {
            let record = session_record(database.as_ref(), &held.session_id);
            let lock = config
                .session_locks()
                .join(format!("{}.lock", held.session_id));
            DiscoveredSession {
                target: Target::new(SessionKind::Devin, held.session_id.clone()),
                title: record
                    .as_ref()
                    .and_then(|record| record.title.clone())
                    .unwrap_or_else(|| held.session_id.clone()),
                directory: record
                    .as_ref()
                    .and_then(|record| record.working_directory.clone())
                    .or_else(|| {
                        table
                            .cwd(held.pid)
                            .map(|path| path.to_string_lossy().into_owned())
                    }),
                updated_at_ms: record
                    .and_then(|record| record.last_activity_ms)
                    .or_else(|| modified_ms(&lock)),
                host: None,
                live: true,
                holder: None,
            }
        })
        .collect()
}

/// The live Devin session `id` names, as one listing row.
pub fn session(
    config: &DevinConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> Option<DiscoveredSession> {
    discover(config, table, uid)
        .into_iter()
        .find(|session| session.target.id == session_id)
}

/// `pipe:[N]` the child's fd 0 names, so the parent's descriptor for the
/// same pipe is its write end.
fn pipe_inode_of(path: &Path) -> Option<String> {
    let target = std::fs::read_link(path).ok()?;
    let text = target.to_str()?;
    text.strip_prefix("pipe:[")?
        .strip_suffix(']')
        .map(str::to_string)
}

/// A `devin` session's `acp` child speaks ACP over a stdio pipe its REPL
/// parent owns. `/proc` lets a same-uid process open that descriptor: the
/// parent's fd whose pipe inode matches the child's stdin is a write end
/// the relay can put a `session/prompt` on, waking even an idle session —
/// the same request the REPL sends when the person types. `None` when any
/// link of the chain is missing or unreadable, so delivery falls back to
/// the inbox queue.
fn inject_fd(proc_root: &Path, table: &dyn ProcessTable, acp_pid: i32) -> Option<PathBuf> {
    let parent = table.process(acp_pid)?.parent;
    if parent <= 0 {
        return None;
    }
    let stdin = proc_root.join(acp_pid.to_string()).join("fd").join("0");
    let inode = pipe_inode_of(&stdin)?;
    let entries = std::fs::read_dir(proc_root.join(parent.to_string()).join("fd")).ok()?;
    for entry in entries.flatten() {
        if pipe_inode_of(&entry.path()).as_deref() == Some(inode.as_str()) {
            return Some(entry.path());
        }
    }
    None
}

/// `session/prompt` is newline-framed JSON-RPC; a write above `PIPE_BUF`
/// could interleave with the REPL's own writes and corrupt both frames.
const PIPE_PROMPT_MAX: usize = 4096;

/// Writes one `session/prompt` frame on the descriptor `fd` names, one
/// atomic line at most `PIPE_PROMPT_MAX` bytes. Nonblocking: an acp not
/// reading its stdin makes the inbox the route rather than a stalled
/// delivery loop.
fn pipe_prompt(fd: &Path, session_id: &str, message_id: &str, text: &str) -> std::io::Result<()> {
    let id: String = message_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(64)
        .collect();
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": format!("relay-{id}"),
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": text}],
        },
    });
    let mut line = frame.to_string();
    line.push('\n');
    if line.len() > PIPE_PROMPT_MAX {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "prompt frame exceeds PIPE_BUF",
        ));
    }
    use platform::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(platform::O_NONBLOCK)
        .open(fd)
        .and_then(|mut file| file.write_all(line.as_bytes()))
}

/// Queues `text` for the session: a `session/prompt` straight into the
/// live session's `acp` stdin when its pipe is reachable — an immediate
/// user turn that wakes even an idle session — else its inbox file,
/// renamed into place once written and synced, so a hook boundary never
/// reads a partial message. The pipe's `Delivered` is the session's turn;
/// the inbox's `Accepted` hands the message to the session's own queue,
/// which a lifecycle hook drains when it next fires.
pub fn send(
    config: &DevinConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    // Devin's host, pipes and hooks are Unix tools: refused on Windows.
    if let Some(reason) = platform::unsupported(DEVIN) {
        return InjectOutcome::Refused(reason);
    }
    if !is_session_id(session_id) {
        return InjectOutcome::Refused("invalid Devin session id".into());
    }
    if let Some(outcome) =
        crate::relay::harness::devin::deliver(config, table, session_id, message_id, text)
    {
        return outcome;
    }
    let nonce: String = message_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .take(120)
        .collect();
    let nonce = if nonce.is_empty() {
        format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_nanos())
                .unwrap_or(0)
        )
    // Sanitizing can make distinct ids share a name (`a/b`, `a:c` → `a-c`):
    // a hash of the raw id keeps the file one-per-message.
    } else if nonce != message_id {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        message_id.hash(&mut hasher);
        format!("{nonce}-{:x}", hasher.finish())
    } else {
        nonce
    };
    let name = format!("{session_id}.{nonce}.msg");
    let inbox = config.inbox();
    let target = inbox.join(&name);
    // A delivery id hands off exactly once. `Accepted` is retried by the
    // delivery runtime until the delivery leaves its queue, so a repeat
    // `send` for the same id must converge rather than stage again: a
    // tombstone proves the hook already consumed it (the message did reach
    // the session — `Delivered`), a still-staged file is the same handoff
    // waiting for a boundary. Without this the same DM can land repeatedly.
    if inbox.join(DRAINED_DIR).join(&name).exists() {
        return InjectOutcome::Delivered;
    }
    if target.exists() {
        return InjectOutcome::Accepted(
            "in the session's inbox; its next lifecycle hook boundary drains it".into(),
        );
    }
    let Some(held) = held(config, table, uid, session_id) else {
        return InjectOutcome::Waiting("that Devin session is not running".into());
    };
    if let Some(fd) = inject_fd(Path::new("/proc"), table, held.pid) {
        match pipe_prompt(&fd, session_id, message_id, text) {
            Ok(()) => return InjectOutcome::Delivered,
            // An unreachable, over-long or refused frame falls back to the
            // session's durable queue, which loses nothing the pipe would.
            Err(_) => {}
        }
    }
    let staging = inbox.join(format!(".{name}.tmp"));
    if let Err(error) = std::fs::create_dir_all(&inbox) {
        return InjectOutcome::Retry(format!("could not open the session's inbox: {error}"));
    }
    // One message id stages the same bytes, so a leftover `.tmp` from an
    // interrupted attempt is simply rewritten. The file is private either
    // way: the permissions are set on the inode, not only at creation, so a
    // permissive umask or a reused `.tmp` cannot leave relayed mail
    // world-readable.
    use platform::OpenOptionsExt;
    let write = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staging)
        .and_then(|mut file| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
            file.write_all(text.as_bytes())?;
            file.sync_all()
        });
    if let Err(error) = write {
        return InjectOutcome::Retry(format!("could not write the session's inbox: {error}"));
    }
    // A staged file is `Accepted`, not `Delivered`: the session's own queue
    // holds it durably, but no hook boundary has shown it to the session.
    let handed_off = || {
        InjectOutcome::Accepted(
            "in the session's inbox; its next lifecycle hook boundary drains it".into(),
        )
    };
    match std::fs::rename(&staging, &target) {
        Ok(()) => {
            // The rename's directory entry must reach disk as well: without
            // the directory's sync a crash can lose a delivery the relay
            // already settled.
            match std::fs::File::open(&inbox).and_then(|dir| dir.sync_all()) {
                Ok(()) => handed_off(),
                Err(error) => InjectOutcome::Retry(format!(
                    "could not sync the session's inbox directory: {error}"
                )),
            }
        }
        // The delivery was already placed: this duplicate settles too.
        Err(_) if target.exists() => handed_off(),
        Err(error) => {
            InjectOutcome::Retry(format!("could not place the session's inbox file: {error}"))
        }
    }
}

/// The probe subcommand Devin's lifecycle hooks call.
pub const HOOK_SUBCOMMAND: &str = "relay devin-hook";

/// Lifecycle events the managed hook drains the inbox at. `PostToolUse`
/// delivers mid-turn, `Stop` at the turn's end, `UserPromptSubmit` with
/// the next prompt and `SessionStart` at launch.
pub const HOOK_EVENTS: [&str; 4] = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];

/// One queued message: its inbox file and its text, read but still in
/// place until the hook's answer is written.
struct Pending {
    path: PathBuf,
    text: String,
}

/// Each `<session>.<msg>.msg` the inbox holds, oldest staged first — the
/// file's own mtime, since the message id in its name carries no order.
/// Nothing is removed here: `settle` tombstones the files once the answer
/// they fed is written, so a failed or partial write loses nothing. A
/// `no-session` or malformed id drains nothing: only a real session's
/// files are touched.
fn pending(config: &DevinConfig, session_id: &str) -> Vec<Pending> {
    if !is_session_id(session_id) {
        return Vec::new();
    }
    let inbox = config.inbox();
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&inbox)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.starts_with(&format!("{session_id}.")) && name.ends_with(".msg")
                        })
                })
                .collect()
        })
        .unwrap_or_default();
    paths.sort_by(|a, b| {
        let stamped = |path: &PathBuf| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
        };
        stamped(a).cmp(&stamped(b)).then_with(|| a.cmp(b))
    });
    paths
        .into_iter()
        .filter_map(|path| {
            let text = std::fs::read_to_string(&path).ok()?.trim().to_string();
            (!text.is_empty()).then_some(Pending { path, text })
        })
        .collect()
}

/// The hook's answer to one lifecycle `payload` (what Devin writes on the
/// hook's stdin): pending inbox texts folded into one injection, shaped
/// per event — `additionalContext` while the session keeps working,
/// a `block` decision when it stops. With it come the inbox files the
/// texts were read from, to `settle` only after the answer is written.
/// `None` means say nothing and consume nothing: no pending message, an
/// event that does not inject, or `stop_hook_active` (the message then
/// waits for the next boundary rather than looping).
pub fn hook_answer(
    config: &DevinConfig,
    payload: &serde_json::Value,
) -> Option<(serde_json::Value, Vec<PathBuf>)> {
    let event = payload["hook_event_name"].as_str()?;
    if !HOOK_EVENTS.contains(&event) {
        return None;
    }
    // A stop hook already answering a block must not block again — and the
    // message stays queued for the next boundary, never drained-and-lost.
    if event == "Stop" && payload["stop_hook_active"].as_bool().unwrap_or(false) {
        return None;
    }
    let session_id = payload["session_id"].as_str().unwrap_or("");
    let drained = pending(config, session_id);
    if drained.is_empty() {
        return None;
    }
    let injected = format!(
        "[via Agent Relay — injected message]\n{}",
        drained
            .iter()
            .map(|pending| pending.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    );
    let output = match event {
        "Stop" => serde_json::json!({"decision": "block", "reason": injected}),
        _ => serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": event,
                "additionalContext": injected,
            }
        }),
    };
    Some((
        output,
        drained.into_iter().map(|pending| pending.path).collect(),
    ))
}

/// The inbox subdirectory `settle` moves consumed files into. A tombstone
/// is the only durable proof a delivery id was consumed — `send` reads it
/// to converge a retried handoff instead of staging a duplicate.
const DRAINED_DIR: &str = "drained";

/// Tombstones past this count are pruned oldest-first, well beyond the
/// lifetime of any delivery still retrying.
const DRAINED_KEPT: usize = 1024;

/// Moves the inbox files a written hook answer consumed into `drained/` —
/// the tombstone `send` dedupes retries against. A file that resists the
/// move is removed outright; a resisted removal delivers again at a later
/// boundary — a possible repeat, never a loss.
pub fn settle(paths: &[PathBuf]) {
    for path in paths {
        let moved = path
            .parent()
            .zip(path.file_name())
            .and_then(|(inbox, name)| {
                let drained = inbox.join(DRAINED_DIR);
                std::fs::create_dir_all(&drained).ok()?;
                let _ = platform::set_mode(&drained, 0o700);
                std::fs::rename(path, drained.join(name)).ok()
            })
            .is_some();
        if !moved {
            let _ = std::fs::remove_file(path);
        }
        if let Some(inbox) = path.parent() {
            prune_drained(&inbox.join(DRAINED_DIR));
        }
    }
}

/// Keeps `drained/` bounded: tombstones only need to outlive a delivery's
/// retries, so beyond `DRAINED_KEPT` the oldest go first.
fn prune_drained(drained: &Path) {
    let mut tombstones: Vec<PathBuf> = std::fs::read_dir(drained)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default();
    if tombstones.len() <= DRAINED_KEPT {
        return;
    }
    let stamped = |path: &PathBuf| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
    };
    tombstones.sort_by(|a, b| stamped(a).cmp(&stamped(b)).then_with(|| a.cmp(b)));
    for path in tombstones.into_iter().take(DRAINED_KEPT / 2) {
        let _ = std::fs::remove_file(path);
    }
}

/// The store key and `settings.get`/`settings.set` name.
pub const SETTING: &str = "devin_direct_delivery";

/// Devin's product name, as its harness descriptor gives it.
const DEVIN: &str = crate::relay::harness::devin::DESCRIPTOR.label;

/// Installs and removes the lifecycle hooks in Devin's `config.json`. The
/// file is the source of truth, so the setting reads on exactly when a
/// hook running this build's subcommand is there; entries for other
/// commands are the user's and are never touched.
pub struct DevinSettings {
    config: DevinConfig,
    command: String,
    lock: std::sync::Mutex<()>,
}

impl DevinSettings {
    pub fn new(config: &DevinConfig, command: String) -> DevinSettings {
        DevinSettings {
            config: config.clone(),
            command,
            lock: std::sync::Mutex::new(()),
        }
    }

    /// The hook command for `executable`, with `--dev` for Agent Relay Dev.
    pub fn command_for(executable: &Path, development: bool) -> String {
        let mut command = format!(
            "{} {HOOK_SUBCOMMAND}",
            crate::relay::outbound::shell_quote(&executable.to_string_lossy())
        );
        if development {
            command.push_str(" --dev");
        }
        command
    }

    /// Devin has run on this computer — its data directory exists, where
    /// sessions and the inbox live. The setting is offered only then, like
    /// the OpenCode plugin's; the configuration directory itself may not
    /// exist yet on an otherwise working install.
    /// Never on Windows, where Devin is not available, so the setting is
    /// not offered there.
    fn installed(&self) -> bool {
        platform::SUPPORTED && self.config.data_dir.is_dir()
    }

    /// This build's hook: `<relay binary> relay devin-hook [--dev]`, where
    /// the executable is one of ours by name and Agent Relay and Agent
    /// Relay Dev each keep their own. A command that merely ends with the
    /// subcommand's spelling — `echo relay devin-hook`, a shell wrapper —
    /// is the user's own hook and is never removed.
    fn is_ours(&self, command: &str) -> bool {
        hook_command::is_ours(command, &self.command)
    }

    fn read_object(&self) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let path = self.config.config_file();
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(serde_json::Map::new())
            }
            Err(_) => return Err("~/.config/devin/config.json cannot be read".into()),
        };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(serde_json::Map::new());
        }
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(serde_json::Value::Object(object)) => Ok(object),
            _ => Err(
                "~/.config/devin/config.json is not a JSON object, so it was left unchanged".into(),
            ),
        }
    }

    /// Every command Devin runs at a hook boundary that is this build's,
    /// across all events.
    fn our_commands<'a>(
        &self,
        hooks: &'a serde_json::Map<String, serde_json::Value>,
    ) -> Vec<&'a str> {
        hooks
            .values()
            .flat_map(|groups| groups.as_array().into_iter().flatten())
            .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str())
            .filter(|command| self.is_ours(command))
            .collect()
    }

    fn hook_enabled(&self) -> bool {
        self.read_object()
            .ok()
            .and_then(|object| {
                object
                    .get("hooks")
                    .and_then(serde_json::Value::as_object)
                    .map(|hooks| !self.our_commands(hooks).is_empty())
            })
            .unwrap_or(false)
    }

    /// Removes this build's hooks from every event's groups, and any group
    /// or event left empty. Whether anything changed.
    fn take_out(&self, object: &mut serde_json::Map<String, serde_json::Value>) -> bool {
        let Some(hooks) = object
            .get_mut("hooks")
            .and_then(serde_json::Value::as_object_mut)
        else {
            return false;
        };
        let mut changed = false;
        let events: Vec<String> = hooks.keys().cloned().collect();
        for event in events {
            let Some(groups) = hooks
                .get_mut(&event)
                .and_then(serde_json::Value::as_array_mut)
            else {
                continue;
            };
            for group in groups.iter_mut() {
                if let Some(entries) = group["hooks"].as_array_mut() {
                    let before = entries.len();
                    entries
                        .retain(|hook| !hook["command"].as_str().is_some_and(|c| self.is_ours(c)));
                    changed |= entries.len() != before;
                }
            }
            groups.retain(|group| {
                group["hooks"]
                    .as_array()
                    .is_none_or(|entries| !entries.is_empty())
            });
            if groups.is_empty() {
                hooks.remove(&event);
            }
        }
        if hooks.is_empty() {
            object.remove("hooks");
        }
        changed
    }

    /// Installs this build's hook on each of `HOOK_EVENTS`, after removing
    /// any stale copies, so exactly one runs per boundary.
    fn install_into(
        &self,
        object: &mut serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        let hooks = object
            .entry("hooks")
            .or_insert_with(|| serde_json::json!({}));
        let Some(hooks) = hooks.as_object_mut() else {
            return Err(
                "~/.config/devin/config.json has a hooks value that is not an object, so it was left unchanged"
                    .into(),
            );
        };
        for event in HOOK_EVENTS {
            let groups = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
            let Some(groups) = groups.as_array_mut() else {
                return Err(format!(
                    "~/.config/devin/config.json has a {event} value that is not a list, so it was left unchanged"
                ));
            };
            groups.push(serde_json::json!({
                "matcher": "",
                "hooks": [{"type": "command", "command": self.command, "timeout": 10}],
            }));
        }
        Ok(())
    }

    /// Applies `enable` to `config.json`, atomically through a backup so an
    /// interrupted write never leaves the file torn.
    fn edit(&self, enable: bool) -> Result<(), String> {
        let _held = self
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let mut object = self.read_object()?;
        self.take_out(&mut object);
        if enable {
            self.install_into(&mut object)?;
        }
        let path = self.config.config_file();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| "~/.config/devin cannot be created".to_string())?;
        }
        let existing = std::fs::read(&path).ok();
        let mut bytes = serde_json::to_vec_pretty(&serde_json::Value::Object(object))
            .map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        crate::relay::claude_settings::write_keeping_file(
            &crate::relay::claude_settings::resolve_symlinks(&path),
            existing.as_deref(),
            &bytes,
            ".relay-desktop-backup",
            0o600,
        )
        .map_err(|_| "~/.config/devin/config.json cannot be written".to_string())
    }
}

/// Never turned on by default: where Devin has run and the hooks are off,
/// the apps offer them in Sessions (`devin_direct_delivery` false), and
/// hooks already in place stay as they are.
impl crate::relay::agents::SettingsExtension for DevinSettings {
    fn get(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut settings = serde_json::Map::new();
        if self.installed() {
            settings.insert(SETTING.into(), serde_json::Value::Bool(self.hook_enabled()));
        }
        settings
    }

    fn set(&self, key: &str, value: &serde_json::Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        if let Some(reason) = platform::unsupported(DEVIN) {
            return Some(Err(reason));
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        if enabled && !self.installed() {
            return Some(Err("Devin has never run on this computer.".into()));
        }
        Some(self.edit(enabled))
    }
}

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;
    use crate::relay::agents::SettingsExtension;

    #[test]
    fn devin_is_not_available_on_windows() {
        let home = tempfile::tempdir().unwrap();
        let config = DevinConfig::from_env(&|_| None, home.path());
        std::fs::create_dir_all(&config.data_dir).unwrap();
        let table = crate::relay::process::FakeProcesses::default();
        assert!(discover(&config, &table, 0).is_empty());
        assert_eq!(
            send(&config, &table, 0, "session", "message", "hi"),
            InjectOutcome::Refused("Devin is not available on Windows.".into())
        );
        let settings = DevinSettings::new(&config, "agent-relay-probe relay devin-hook".into());
        assert!(settings.get().is_empty());
        assert_eq!(
            settings.set(SETTING, &serde_json::Value::Bool(true)),
            Some(Err("Devin is not available on Windows.".into()))
        );
    }
}

// Devin finds no session on Windows (`held_sessions`), and these tests use
// pipes, `/proc` symlinks and file modes.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};

    const UID: u32 = 501;

    fn config(home: &Path) -> DevinConfig {
        DevinConfig {
            data_dir: home.join("devin"),
            config_dir: home.join("config").join("devin"),
            home: home.to_path_buf(),
            development: false,
        }
    }

    /// A lock file `<id>.lock` containing `pid`, in the config's lock
    /// directory, returned with its path so a fake process can hold it.
    fn lock(config: &DevinConfig, id: &str, pid: i32) -> PathBuf {
        let dir = config.session_locks();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.lock"));
        std::fs::write(&path, pid.to_string()).unwrap();
        path
    }

    fn devin_process(parent: i32, open_files: Vec<PathBuf>) -> FakeProcess {
        FakeProcess {
            parent,
            uid: UID,
            start: 100,
            executable: Some(PathBuf::from("/opt/devin/bin/devin")),
            open_files,
            ..FakeProcess::default()
        }
    }

    #[test]
    fn session_ids_accept_only_devins_spelling() {
        assert!(is_session_id("real-gallium"));
        assert!(is_session_id("ab"));
        assert!(!is_session_id("a"));
        assert!(!is_session_id("Real-Gallium"));
        assert!(!is_session_id("-real-gallium"));
        assert!(!is_session_id("real-gallium-"));
        assert!(!is_session_id("real_gallium"));
        assert!(!is_session_id("real/gallium"));
        assert!(!is_session_id("a".repeat(129).as_str()));
    }

    #[test]
    fn the_session_is_the_lock_the_process_holds_open() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let lock = lock(&config, "real-gallium", 400);
        let table = FakeProcesses::default();
        table.insert(
            400,
            devin_process(1, vec![lock, PathBuf::from("/tmp/other.log")]),
        );
        assert_eq!(
            held_session(&config, &table, 400).as_deref(),
            Some("real-gallium")
        );
        // A process holding no lock names no session, and a file merely
        // living in the directory does not count either.
        table.insert(401, devin_process(1, Vec::new()));
        assert_eq!(held_session(&config, &table, 401), None);
        table.insert(
            402,
            devin_process(1, vec![config.session_locks().join("not-a-lock")]),
        );
        assert_eq!(held_session(&config, &table, 402), None);
    }

    #[test]
    fn a_replaced_lock_names_no_session() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        // A process opened `real-gallium.lock`, then the file was replaced
        // (new inode, new contents naming the pid). The descriptor still
        // lists the old inode's birth; the directory entry's differs, so
        // the hold proves nothing and no session is named.
        let path = lock(&config, "real-gallium", 400);
        let stale = crate::relay::process::OpenedFile {
            birth_ns: crate::relay::process::file_birth_ns(&path).map(|born| born + 1),
            path: path.clone(),
        };
        table.insert(
            400,
            FakeProcess {
                opened_files: Some(vec![stale]),
                ..devin_process(1, vec![path])
            },
        );
        assert_eq!(held_session(&config, &table, 400), None);
        assert!(held_sessions(&config, &table, UID).is_empty());
    }

    #[test]
    fn discovery_lists_only_locks_a_live_devin_process_proves() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        let live = lock(&config, "real-gallium", 400);
        table.insert(400, devin_process(1, vec![live]));
        // A stale lock's recorded pid is dead: nothing.
        lock(&config, "stale-session", 499);
        // A lock whose recorded pid belongs to another user: nothing.
        let foreign = lock(&config, "foreign-session", 410);
        table.insert(
            410,
            FakeProcess {
                uid: 502,
                ..devin_process(1, vec![foreign])
            },
        );
        // A lock whose recorded pid is not a Devin binary at all: nothing.
        let hijacked = lock(&config, "hijacked-session", 420);
        table.insert(
            420,
            FakeProcess {
                uid: UID,
                start: 100,
                executable: Some(PathBuf::from("/usr/bin/python3")),
                open_files: vec![hijacked],
                ..FakeProcess::default()
            },
        );
        // A lock whose recorded pid is Devin but holds nothing open —
        // the file's claim alone never lists a session.
        lock(&config, "unheld-session", 430);
        table.insert(430, devin_process(1, Vec::new()));
        // Malformed contents and an invalid id in the name: skipped.
        let dir = config.session_locks();
        std::fs::write(dir.join("broken-session.lock"), "not-a-pid").unwrap();
        std::fs::write(dir.join("bad_id.lock"), "400").unwrap();
        let listed = held_sessions(&config, &table, UID);
        assert_eq!(
            listed,
            vec![HeldSession {
                session_id: "real-gallium".into(),
                pid: 400
            }]
        );
    }

    #[test]
    fn one_process_holding_many_locks_lists_every_session() {
        // Devin Desktop's one `devin acp` multiplexes every session it
        // runs and holds all their locks; discovery must list each one,
        // not only the first descriptor it happens to enumerate.
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let first = lock(&config, "real-gallium", 400);
        let second = lock(&config, "well-apple", 400);
        let table = FakeProcesses::default();
        table.insert(400, devin_process(1, vec![first, second]));
        let listed = held_sessions(&config, &table, UID);
        assert_eq!(listed.len(), 2);
        assert!(listed
            .iter()
            .any(|held| held.session_id == "real-gallium" && held.pid == 400));
        assert!(listed
            .iter()
            .any(|held| held.session_id == "well-apple" && held.pid == 400));
        // A caller under a multiplexed holder cannot be one session, so
        // it is nobody — never the first lock's wearer.
        assert_eq!(held_session(&config, &table, 400), None);
        // Each named session still proves held for sends.
        for id in ["real-gallium", "well-apple"] {
            assert_eq!(
                self::held(&config, &table, UID, id),
                Some(HeldSession {
                    session_id: id.into(),
                    pid: 400
                })
            );
        }
    }

    #[test]
    fn a_reused_pid_without_the_lock_lists_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        // The lock names a pid a different `devin` process now owns, one
        // holding no file: pid reuse cannot resurrect the ended session.
        lock(&config, "real-gallium", 400);
        let table = FakeProcesses::default();
        table.insert(400, devin_process(1, vec![PathBuf::from("/tmp/unrelated")]));
        assert!(held_sessions(&config, &table, UID).is_empty());
    }

    #[test]
    fn the_database_names_and_places_a_live_session() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        let held = lock(&config, "real-gallium", 400);
        table.insert(400, devin_process(1, vec![held]));
        std::fs::create_dir_all(config.cli()).unwrap();
        let database = rusqlite::Connection::open(config.cli().join("sessions.db")).unwrap();
        database
            .execute_batch(
                "create table sessions (id text primary key, working_directory text, \
                 last_activity_at integer, title text)",
            )
            .unwrap();
        database
            .execute(
                "insert into sessions values ('real-gallium', '/work/api', 1700000000, 'Fix it')",
                [],
            )
            .unwrap();
        drop(database);
        let listed = discover(&config, &table, UID);
        assert_eq!(listed.len(), 1);
        let row = &listed[0];
        assert_eq!(row.target, Target::new(SessionKind::Devin, "real-gallium"));
        assert_eq!(row.title, "Fix it");
        assert_eq!(row.directory.as_deref(), Some("/work/api"));
        assert_eq!(row.updated_at_ms, Some(1_700_000_000_000));
        assert!(row.live);
    }

    #[test]
    fn a_missing_database_degrades_to_lock_facts() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        let held = lock(&config, "real-gallium", 400);
        table.insert(400, devin_process(1, vec![held]));
        let listed = discover(&config, &table, UID);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "real-gallium");
    }

    #[test]
    fn a_send_places_the_inbox_file_once() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        let held = lock(&config, "real-gallium", 400);
        table.insert(400, devin_process(1, vec![held]));
        let outcome = send(&config, &table, UID, "real-gallium", "m-1", "hello");
        assert!(matches!(outcome, InjectOutcome::Accepted(_)));
        let placed = config.inbox().join("real-gallium.m-1.msg");
        assert_eq!(std::fs::read_to_string(&placed).unwrap(), "hello");
        // The staged file is private regardless of the process umask.
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&placed).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // The staging file never lingers, and the same message settles a
        // second time without a rewrite.
        assert!(!config.inbox().join(".real-gallium.m-1.msg.tmp").exists());
        let outcome = send(&config, &table, UID, "real-gallium", "m-1", "hello");
        assert!(matches!(outcome, InjectOutcome::Accepted(_)));
        assert_eq!(
            std::fs::read_dir(config.inbox()).unwrap().flatten().count(),
            1
        );
    }

    #[test]
    fn a_send_to_nobody_waits_and_a_bad_id_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        assert!(matches!(
            send(&config, &table, UID, "real-gallium", "m-1", "hello"),
            InjectOutcome::Waiting(_)
        ));
        assert!(matches!(
            send(&config, &table, UID, "not/an-id", "m-1", "hello"),
            InjectOutcome::Refused(_)
        ));
        // Nothing was queued for either.
        assert!(!config.inbox().exists());
    }

    fn place(config: &DevinConfig, name: &str, text: &str) {
        std::fs::create_dir_all(config.inbox()).unwrap();
        std::fs::write(config.inbox().join(name), text).unwrap();
    }

    fn settings(config: &DevinConfig) -> DevinSettings {
        DevinSettings::new(
            config,
            "/opt/relay/agent-relay-probe relay devin-hook".into(),
        )
    }

    /// Stamps `name`'s mtime at `seconds` past the epoch, so arrival order
    /// — not the message id in the name — is what a drain sorts on.
    fn place_at(config: &DevinConfig, name: &str, text: &str, seconds: u64) {
        place(config, name, text);
        let path = config.inbox().join(name);
        let times = std::fs::FileTimes::new()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds));
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(times)
            .unwrap();
    }

    #[test]
    fn the_hook_drains_the_session_inbox_as_context() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        // Later names arrive earlier: ordering is arrival, not message id.
        place_at(&config, "real-gallium.9.msg", "first", 10);
        place_at(&config, "real-gallium.1.msg", "second", 20);
        // Other sessions' files and staging files are never drained.
        place(&config, "other-session.9.msg", "not yours");
        place(&config, ".real-gallium.3.msg.tmp", "partial");
        let (output, consumed) = hook_answer(
            &config,
            &serde_json::json!({"hook_event_name": "PostToolUse", "session_id": "real-gallium"}),
        )
        .unwrap();
        let context = output["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(context.contains("first"));
        assert!(context.find("first").unwrap() < context.find("second").unwrap());
        // Reading alone removes nothing: the files stay until the answer
        // is written and `settle` runs.
        assert!(config.inbox().join("real-gallium.9.msg").exists());
        settle(&consumed);
        // Consumed files are tombstoned, not deleted: `drained/` proves to
        // a retried `send` that this message id already reached the session.
        let drained = config.inbox().join("drained");
        assert!(drained.join("real-gallium.9.msg").exists());
        assert!(drained.join("real-gallium.1.msg").exists());
        assert!(!config.inbox().join("real-gallium.9.msg").exists());
        assert!(!config.inbox().join("real-gallium.1.msg").exists());
        assert!(config.inbox().join("other-session.9.msg").exists());
        assert!(config.inbox().join(".real-gallium.3.msg.tmp").exists());
        // The next boundary has nothing to say.
        assert!(hook_answer(
            &config,
            &serde_json::json!({"hook_event_name": "PostToolUse", "session_id": "real-gallium"}),
        )
        .is_none());
    }

    #[test]
    fn the_hook_blocks_a_stop_but_never_loops() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        place(&config, "real-gallium.1.msg", "ping");
        let (output, _) = hook_answer(
            &config,
            &serde_json::json!({"hook_event_name": "Stop", "session_id": "real-gallium"}),
        )
        .unwrap();
        assert_eq!(output["decision"], "block");
        assert!(output["reason"].as_str().unwrap().contains("ping"));
        // stop_hook_active: nothing is said and the file stays queued, so
        // a stop hook cannot call itself and nothing is drained-and-lost.
        place(&config, "real-gallium.2.msg", "again");
        assert!(hook_answer(
            &config,
            &serde_json::json!({"hook_event_name": "Stop", "session_id": "real-gallium", "stop_hook_active": true}),
        )
        .is_none());
        assert!(config.inbox().join("real-gallium.2.msg").exists());
        // A non-inject event, a missing payload and a malformed id: quiet.
        for payload in [
            serde_json::json!({"hook_event_name": "SessionEnd", "session_id": "real-gallium"}),
            serde_json::json!({}),
            serde_json::json!({"hook_event_name": "UserPromptSubmit", "session_id": "../etc"}),
        ] {
            assert!(hook_answer(&config, &payload).is_none());
        }
    }

    #[test]
    fn a_retried_handoff_converges_instead_of_staging_twice() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        // The delivery runtime retries an `Accepted` send until the
        // delivery leaves its queue. Between staging and the retry a hook
        // boundary may consume the file — the repeat must prove that, not
        // stage the same DM again.
        place(&config, "real-gallium.m-1.msg", "hello");
        let (_, consumed) = hook_answer(
            &config,
            &serde_json::json!({"hook_event_name": "PostToolUse", "session_id": "real-gallium"}),
        )
        .unwrap();
        settle(&consumed);
        // Drained once: a resend reports `Delivered` — the session did see
        // it — and the inbox gains nothing.
        assert!(matches!(
            send(
                &config,
                &FakeProcesses::default(),
                UID,
                "real-gallium",
                "m-1",
                "hello"
            ),
            InjectOutcome::Delivered
        ));
        assert!(!config.inbox().join("real-gallium.m-1.msg").exists());
        // Still staged but not yet drained: the same handoff, no rewrite.
        place(&config, "real-gallium.m-2.msg", "again");
        assert!(matches!(
            send(
                &config,
                &FakeProcesses::default(),
                UID,
                "real-gallium",
                "m-2",
                "again"
            ),
            InjectOutcome::Accepted(_)
        ));
        assert_eq!(
            std::fs::read_to_string(config.inbox().join("real-gallium.m-2.msg")).unwrap(),
            "again"
        );
    }

    #[test]
    fn sanitised_ids_cannot_share_a_staged_name() {
        // Distinct message ids that sanitise alike must not dedupe
        // together — each stages under its own name.
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        let held = lock(&config, "real-gallium", 400);
        table.insert(400, devin_process(1, vec![held]));
        send(&config, &table, UID, "real-gallium", "a/b", "one");
        send(&config, &table, UID, "real-gallium", "a:b", "two");
        let staged: Vec<_> = std::fs::read_dir(config.inbox())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().into_string().unwrap())
            .filter(|name| name.ends_with(".msg"))
            .collect();
        assert_eq!(staged.len(), 2, "{staged:?}");
    }

    #[test]
    fn agent_relay_dev_drains_its_own_inbox_only() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        // A production message stays put while Agent Relay Dev drains, and
        // Dev's own queue is the one it empties.
        place(&config, "real-gallium.1.msg", "production");
        let dev = config.clone().development(true);
        place(&dev, "real-gallium.2.msg", "development");
        let (output, consumed) = hook_answer(
            &dev,
            &serde_json::json!({"hook_event_name": "PostToolUse", "session_id": "real-gallium"}),
        )
        .unwrap();
        settle(&consumed);
        assert!(output.to_string().contains("development"));
        assert!(!output.to_string().contains("production"));
        assert!(config.inbox().join("real-gallium.1.msg").exists());
        assert!(!dev.inbox().join("real-gallium.2.msg").exists());
    }

    #[test]
    fn the_setting_installs_only_its_own_hooks() {
        use crate::relay::agents::SettingsExtension;
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        std::fs::create_dir_all(&config.data_dir).unwrap();
        std::fs::create_dir_all(&config.config_dir).unwrap();
        std::fs::write(
            config.config_file(),
            r#"{"theme_mode":"dark","hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"/usr/bin/echo hi"},{"type":"command","command":"/usr/bin/echo relay devin-hook"}]}]}}"#,
        )
        .unwrap();
        let settings = settings(&config);
        // get() reads the file: off before install.
        assert_eq!(settings.get()[SETTING], serde_json::Value::Bool(false));
        // Offered in Sessions, never turned on silently.
        assert!(settings.default_on().is_empty());
        settings
            .set(SETTING, &serde_json::json!(true))
            .unwrap()
            .unwrap();
        assert_eq!(settings.get()[SETTING], serde_json::Value::Bool(true));
        assert!(settings.default_on().is_empty());
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(config.config_file()).unwrap()).unwrap();
        // Each inject event carries exactly one of our commands, and the
        // user's echo hooks survived on UserPromptSubmit — including the
        // one whose arguments merely spell our subcommand.
        for event in HOOK_EVENTS {
            let commands: Vec<&str> = written["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|group| group["hooks"].as_array().unwrap().iter())
                .filter_map(|hook| hook["command"].as_str())
                .collect();
            assert_eq!(
                commands
                    .iter()
                    .filter(|command| command.contains("agent-relay-probe"))
                    .count(),
                1,
                "{event}"
            );
        }
        assert!(written["hooks"]["UserPromptSubmit"]
            .to_string()
            .contains("echo relay devin-hook"));
        assert!(written["hooks"]["UserPromptSubmit"]
            .to_string()
            .contains("echo hi"));
        assert_eq!(written["theme_mode"], "dark");
        // Off removes ours everywhere, keeps the user's, and a second off
        // is a no-op.
        settings
            .set(SETTING, &serde_json::json!(false))
            .unwrap()
            .unwrap();
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(config.config_file()).unwrap()).unwrap();
        let ours = written["hooks"].to_string();
        assert!(!ours.contains("agent-relay-probe"));
        assert!(written["hooks"]["UserPromptSubmit"]
            .to_string()
            .contains("echo hi"));
        // The user's own `echo relay devin-hook` is foreign, so it stays.
        assert!(written["hooks"]["UserPromptSubmit"]
            .to_string()
            .contains("echo relay devin-hook"));
        assert_eq!(settings.get()[SETTING], serde_json::Value::Bool(false));
        settings
            .set(SETTING, &serde_json::json!(false))
            .unwrap()
            .unwrap();
    }

    #[test]
    fn bundled_mac_helpers_enable_idempotently_and_can_be_turned_off() {
        use crate::relay::agents::SettingsExtension;
        for (name, development) in [
            ("Agent Relay Helper", false),
            ("Agent Relay Dev Helper", true),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let config = config(temp.path());
            std::fs::create_dir_all(&config.data_dir).unwrap();
            let executable = temp.path().join("App.app/Contents/Helpers").join(name);
            let settings = DevinSettings::new(
                &config,
                DevinSettings::command_for(&executable, development),
            );
            // Existing installs can already contain duplicate hooks from repeated clicks.
            let mut object = serde_json::Map::new();
            settings.install_into(&mut object).unwrap();
            settings.install_into(&mut object).unwrap();
            object.insert("theme_mode".into(), serde_json::json!("dark"));
            std::fs::create_dir_all(&config.config_dir).unwrap();
            std::fs::write(config.config_file(), serde_json::to_vec(&object).unwrap()).unwrap();
            for _ in 0..2 {
                settings
                    .set(SETTING, &serde_json::json!(true))
                    .unwrap()
                    .unwrap();
                assert_eq!(settings.get()[SETTING], true, "{name}");
                let object = settings.read_object().unwrap();
                for event in HOOK_EVENTS {
                    assert_eq!(
                        object["hooks"][event].as_array().unwrap().len(),
                        1,
                        "{name}: {event}"
                    );
                }
                assert_eq!(object["theme_mode"], "dark");
            }
            settings
                .set(SETTING, &serde_json::json!(false))
                .unwrap()
                .unwrap();
            assert_eq!(settings.get()[SETTING], false, "{name}");
            assert!(!settings.read_object().unwrap().contains_key("hooks"));
        }
    }

    #[test]
    fn the_setting_fails_closed_on_an_unreadable_config() {
        use crate::relay::agents::SettingsExtension;
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        std::fs::create_dir_all(&config.data_dir).unwrap();
        std::fs::create_dir_all(&config.config_dir).unwrap();
        std::fs::write(config.config_file(), "{ not json").unwrap();
        let settings = settings(&config);
        let error = settings
            .set(SETTING, &serde_json::json!(true))
            .unwrap()
            .unwrap_err();
        assert!(error.contains("left unchanged"));
        // The file is untouched, and the read reports the hook as off
        // rather than pretending it was installed.
        assert_eq!(
            std::fs::read_to_string(config.config_file()).unwrap(),
            "{ not json"
        );
        assert_eq!(settings.get()[SETTING], serde_json::Value::Bool(false));
    }

    #[test]
    fn the_setting_ignores_foreign_commands_and_dev_variants() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let settings = settings(&config);
        assert!(settings.is_ours("/opt/relay/agent-relay-probe relay devin-hook"));
        assert!(settings.is_ours("'/opt/relay dir/agent-relay-probe' relay devin-hook"));
        assert!(!settings.is_ours("/opt/relay/agent-relay-probe relay devin-hook --dev"));
        assert!(!settings.is_ours("/home/user/.config/devin/relay-hook.py"));
        // A command whose arguments merely spell the subcommand — an echo,
        // a wrapper script, some other binary — is the user's, never ours.
        assert!(!settings.is_ours("echo relay devin-hook"));
        assert!(!settings.is_ours("/opt/relay/probe relay devin-hook"));
        assert!(!settings.is_ours("sh -c 'agent-relay-probe relay devin-hook'"));
        let dev = DevinSettings::new(
            &config,
            "/opt/agent-relay-probe relay devin-hook --dev".into(),
        );
        assert!(dev.is_ours("/opt/agent-relay-probe relay devin-hook --dev"));
        assert!(!dev.is_ours("/opt/agent-relay-probe relay devin-hook"));
        assert!(!dev.is_ours("/opt/probe relay devin-hook --dev"));
    }

    /// A symlink whose target is a `pipe:[N]` name, like `/proc/pid/fd`
    /// entries give `readlink` on Linux.
    fn pipe_link(dir: &Path, name: &str, inode: u64) {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(format!("pipe:[{inode}]"), &path).unwrap();
    }

    #[test]
    fn inject_fd_finds_the_parents_write_end_by_pipe_inode() {
        let temp = tempfile::tempdir().unwrap();
        let proc = temp.path().join("proc");
        pipe_link(&proc, "50/fd/0", 1234);
        pipe_link(&proc, "40/fd/7", 1234);
        pipe_link(&proc, "40/fd/9", 9999);
        let table = FakeProcesses::default();
        table.insert(50, devin_process(40, Vec::new()));
        assert_eq!(inject_fd(&proc, &table, 50), Some(proc.join("40/fd/7")));
    }

    #[test]
    fn inject_fd_yields_nothing_without_a_matching_parent_fd() {
        let temp = tempfile::tempdir().unwrap();
        let proc = temp.path().join("proc");
        pipe_link(&proc, "50/fd/0", 1234);
        pipe_link(&proc, "40/fd/7", 9999);
        let table = FakeProcesses::default();
        table.insert(50, devin_process(40, Vec::new()));
        assert_eq!(inject_fd(&proc, &table, 50), None);
        // stdin that is not a pipe, a vanished parent and a parentless acp
        // all take the inbox route.
        std::fs::remove_file(proc.join("50/fd/0")).unwrap();
        std::fs::write(proc.join("50/fd/0"), "x").unwrap();
        assert_eq!(inject_fd(&proc, &table, 50), None);
        table.insert(51, devin_process(0, Vec::new()));
        assert_eq!(inject_fd(&proc, &table, 51), None);
    }

    #[test]
    fn pipe_prompt_writes_one_framed_prompt_under_pipe_buf() {
        let mut fds = [0 as libc::c_int; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let (read_fd, write_fd) = (fds[0], fds[1]);
        let path = PathBuf::from(format!("/dev/fd/{write_fd}"));
        pipe_prompt(&path, "tested-cardboard", "msg-1", "wake up").unwrap();
        unsafe { libc::close(write_fd) };
        let mut frame = String::new();
        use std::io::Read;
        use std::os::unix::io::FromRawFd;
        unsafe { std::fs::File::from_raw_fd(read_fd) }
            .read_to_string(&mut frame)
            .unwrap();
        assert!(frame.len() <= PIPE_PROMPT_MAX);
        let value: serde_json::Value = serde_json::from_str(frame.trim_end()).unwrap();
        assert_eq!(value["method"], "session/prompt");
        assert_eq!(value["id"], "relay-msg-1");
        assert_eq!(value["params"]["sessionId"], "tested-cardboard");
        assert_eq!(value["params"]["prompt"][0]["text"], "wake up");

        let mut fds = [0 as libc::c_int; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let path = PathBuf::from(format!("/dev/fd/{}", fds[1]));
        let long = "x".repeat(PIPE_PROMPT_MAX);
        assert!(pipe_prompt(&path, "s", "m", &long).is_err());
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }
}
