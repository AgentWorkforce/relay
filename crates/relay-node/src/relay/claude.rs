//! Claude sessions on this computer and the routes into them.
//!
//! - **Terminal sessions** (`claude-terminal`): Claude Code registers every
//!   session in `<claude home>/sessions/<pid>.json` and opens an inbox
//!   socket for cross-session messaging, authenticated by the token in the
//!   matching `<pid>.<hash>.key` (readable only by this user). A message is
//!   two JSON lines on that socket (see `peer_frames`). Claude Code labels
//!   it as coming from another session, keeps its own guardrail text around
//!   it, and may hold it for approval as `crossSessionInbound` says (see
//!   `claude_settings`).
//! - **Claude app sessions** (`claude-cloud`): the desktop app's folder
//!   sessions and claude.ai/code run on Anthropic's side; the documented way
//!   in is `claude --print --cloud <id>` under the user's own Claude sign-in.
//!   Nothing here reads Claude credentials.
//!
//! Processes are read through a `ProcessTable` and commands run through a
//! `CommandRunner`, so tests use fakes and never start a session or a CLI.

use crate::relay::claude_dirs::ClaudeDirs;
use crate::relay::contract::agents::SessionHolder;
use crate::relay::delivery::final_answer;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::{claude_start_matches, ProcessTable};
use crate::relay::sessions::{DiscoveredSession, UnreadableSessionFile};
use crate::relay::store::{is_claude_session_id, is_uuid, random_uuid, SessionKind, Target};
use crate::relay::workspace::relay_home;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The inbox wire version this core speaks. A session advertising anything
/// else is left alone rather than guessed at.
pub const KNOWN_PEER_PROTOCOL: i64 = 1;

/// Claude Code refuses an inbox line past about a million characters; this
/// is kept a little under and applies to the whole serialized line.
pub const MAX_LINE_BYTES: usize = 1_000_000;

/// How long one `claude --print --cloud` send may take before it is stopped.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(60);

/// How long `claude --help` may take when probing for the JSON result.
const HELP_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a write to an inbox socket may block.
const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the session gets to read both lines before the socket closes.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(1);

/// Where `claude` installs itself, beyond the user's home. An app launched
/// from Finder does not inherit the shell's `PATH`, so these are checked
/// directly.
const SYSTEM_CLAUDE: [&str; 2] = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];

/// Where Claude keeps its state on this computer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeConfig {
    /// `CLAUDE_CONFIG_DIR`, else `~/.claude`: the session registry, the
    /// transcripts under `projects/`, and the user's `settings.json`.
    pub home: PathBuf,
    /// The `claude` command line that sends into Claude app sessions.
    pub executable: Option<PathBuf>,
    /// The Claude desktop app's per-account session state
    /// (`~/Library/Application Support/Claude/local-agent-mode-sessions`);
    /// `None` where the desktop app does not run.
    pub app_sessions: Option<PathBuf>,
    /// The person's other Claude config folders (`claude_dirs`).
    pub dirs: ClaudeDirs,
}

impl ClaudeConfig {
    /// Reads `CLAUDE_CONFIG_DIR` and `RELAY_DESKTOP_CLAUDE` from `env`;
    /// `home` is the user's home directory.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> ClaudeConfig {
        let system: Vec<PathBuf> = SYSTEM_CLAUDE.iter().map(PathBuf::from).collect();
        ClaudeConfig::resolve(env, home, &system)
    }

    /// `from_env` with the system install locations given, so a test never
    /// finds a real `claude`.
    pub fn resolve(
        env: &dyn Fn(&str) -> Option<String>,
        home: &Path,
        system_claude: &[PathBuf],
    ) -> ClaudeConfig {
        let set = |key: &str| {
            env(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let claude_home = set("CLAUDE_CONFIG_DIR")
            .map(|dir| expand_tilde(&dir, home))
            .unwrap_or_else(|| home.join(".claude"));
        let executable = match set("RELAY_DESKTOP_CLAUDE") {
            // An explicit choice that is not executable finds nothing, rather
            // than quietly running some other `claude`.
            Some(path) => runnable(&expand_tilde(&path, home)),
            None => [
                home.join(".local/bin/claude"),
                home.join(".claude/local/claude"),
            ]
            .into_iter()
            .chain(system_claude.iter().cloned())
            .chain(windows_claude_locations(env))
            .find_map(|p| runnable(&p)),
        };
        let app_sessions = cfg!(target_os = "macos")
            .then(|| home.join("Library/Application Support/Claude/local-agent-mode-sessions"));
        let dirs = ClaudeDirs::from_env(env, home, &relay_home(env, home));
        ClaudeConfig {
            home: claude_home,
            executable,
            app_sessions,
            dirs,
        }
    }

    /// Claude Code's session registry.
    pub fn registry(&self) -> PathBuf {
        self.home.join("sessions")
    }

    /// Every session registry of this person's Claude logins: the configured
    /// one, then the `sessions/` of every other watched config folder
    /// (`ClaudeDirs::watched`): sibling `.claude-<name>` logins, folders
    /// named in `AGENT_RELAY_CLAUDE_CONFIG_DIRS` or added in Settings, and
    /// the `CLAUDE_CONFIG_DIR` of running sessions. Each folder once, by its
    /// real path: a login whose `sessions/` links to the default's is read
    /// once.
    /// A folder the person stopped sharing (`ClaudeDirs::set_shared`),
    /// the configured one included, is not read: its sessions stay off the
    /// relay.
    pub fn registries(&self) -> Vec<PathBuf> {
        let mut found = Vec::new();
        if self.dirs.default_shared(&self.home) {
            found.push(self.registry());
        }
        found.extend(
            self.dirs
                .extra_homes(&self.home)
                .into_iter()
                .map(|home| home.join("sessions"))
                .filter(|registry| registry.is_dir()),
        );
        let mut seen = std::collections::HashSet::new();
        found.retain(|registry| {
            seen.insert(std::fs::canonicalize(registry).unwrap_or_else(|_| registry.clone()))
        });
        found
    }

    /// Claude Code's transcripts, one folder per working directory.
    pub fn projects(&self) -> PathBuf {
        self.home.join("projects")
    }
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(&rest[1..]),
        _ => PathBuf::from(path),
    }
}

fn is_executable(path: &Path) -> bool {
    crate::platform::exe::is_executable(path)
}

/// `path` as a runnable `claude`: itself on Unix; on Windows also the
/// `claude.exe` or npm's `claude.cmd` beside the bare name.
fn runnable(path: &Path) -> Option<PathBuf> {
    if cfg!(windows) {
        crate::platform::exe::runnable(path)
    } else {
        is_executable(path).then(|| path.to_path_buf())
    }
}

/// Where `claude` installs itself on Windows beyond the user's home: npm's
/// global folder (`%APPDATA%\npm`), which an app started from the Start
/// menu may not have on its `PATH`.
fn windows_claude_locations(env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    env("APPDATA")
        .filter(|value| !value.is_empty())
        .map(|appdata| vec![Path::new(&appdata).join("npm").join("claude")])
        .unwrap_or_default()
}

/// The command name an agent environment is chosen by: the file name, and
/// on Windows without its `.exe`/`.cmd` extension.
fn cli_name(program: &Path) -> String {
    let name = if cfg!(windows) {
        program.file_stem()
    } else {
        program.file_name()
    };
    name.map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// MARK: Terminal sessions

/// A Claude Code session running in a terminal, as its registry entry
/// records it. The session id outlives the process; the pid and socket are
/// looked up again at delivery time, so a resumed session still receives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalSession {
    pub session_id: String,
    pub pid: i32,
    pub socket_path: PathBuf,
    /// The inbox wire version; only `KNOWN_PEER_PROTOCOL` is spoken.
    pub peer_protocol: i64,
    /// When the process started, as Claude Code recorded it: clock ticks
    /// since boot on Linux, a UTC `ctime` string on macOS.
    pub proc_start: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    /// `idle`, `shell` or `busy`, when the session records it (`status`).
    pub status: Option<String>,
    /// Who started the session, such as `claude-desktop` for a Claude app chat.
    pub entrypoint: Option<String>,
    /// `interactive` for a chat a person types in.
    pub kind: Option<String>,
    /// When the registry entry was last written.
    pub updated_at_ms: Option<i64>,
    /// The registry the entry is in, where its `<pid>.<hash>.key` is too:
    /// `None` for the configured one (`ClaudeConfig::registry`).
    pub registry: Option<PathBuf>,
}

impl TerminalSession {
    /// Decodes one `<pid>.json` registry record. Lenient, since the file is
    /// Claude Code's: bytes after the record are ignored (see
    /// `first_value`), unknown fields are ignored, and a record without
    /// what a delivery needs (a UUID session id, a pid, a socket) is `None`.
    pub fn decode(data: &[u8]) -> Option<TerminalSession> {
        TerminalSession::decode_value(&first_value(data).ok()?)
    }

    fn decode_value(record: &Value) -> Option<TerminalSession> {
        let session_id = record["sessionId"].as_str().filter(|id| is_uuid(id))?;
        let pid = record["pid"]
            .as_i64()
            .filter(|pid| *pid > 0)
            .and_then(|pid| i32::try_from(pid).ok())?;
        let socket_path = record["messagingSocketPath"]
            .as_str()
            .filter(|p| !p.is_empty())?;
        let text = |key: &str| record[key].as_str().map(str::to_string);
        Some(TerminalSession {
            session_id: session_id.to_string(),
            pid,
            socket_path: PathBuf::from(socket_path),
            peer_protocol: record["peerProtocol"].as_i64().unwrap_or(0),
            proc_start: recorded_start(&record["procStart"]),
            cwd: text("cwd"),
            name: text("name"),
            status: text("status"),
            entrypoint: text("entrypoint"),
            kind: text("kind"),
            updated_at_ms: None,
            registry: None,
        })
    }

    /// A start time is recorded, so a caller can be matched to it. Without
    /// one, the relay-send socket can never tell this session from a
    /// recycled pid, so the session is not told how to reply.
    pub fn can_reply(&self) -> bool {
        self.proc_start.is_some()
    }

    pub fn speaks_known_protocol(&self) -> bool {
        self.peer_protocol == KNOWN_PEER_PROTOCOL
    }

    /// A short name for lists: the session's own name, else its directory's
    /// last component, else its id.
    pub fn display_name(&self) -> String {
        if let Some(name) = self.name.as_deref().filter(|n| !n.is_empty()) {
            return name.to_string();
        }
        self.cwd
            .as_deref()
            .and_then(|cwd| Path::new(cwd).file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.session_id.clone())
    }
}

/// `procStart` as text: a string on macOS, and a string or a number of
/// clock ticks on Linux.
fn recorded_start(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Whether the registry entry belongs to a process running now. The pid
/// alone is not enough: pids are reused, and a recycled one would take a
/// teammate's message into an unrelated process. An entry with no recorded
/// start is taken on its pid (and can never be replied from; see
/// `TerminalSession::can_reply`).
pub fn is_alive(table: &dyn ProcessTable, session: &TerminalSession) -> bool {
    let Some(process) = table.process(session.pid) else {
        return false;
    };
    match &session.proc_start {
        None => true,
        Some(recorded) => claude_start_matches(table.start_clock(), recorded, &process),
    }
}

/// The first JSON value in a file of Claude Code's, ignoring whatever
/// follows it. Claude Code rewrites its registry files in place, so an
/// interrupted write (a full disk, say) can leave stray bytes after a
/// complete record; the record still names its session.
fn first_value(data: &[u8]) -> Result<Value, serde_json::Error> {
    serde_json::Deserializer::from_slice(data)
        .into_iter::<Value>()
        .next()
        .unwrap_or_else(|| serde_json::from_slice(data))
}

/// Claude Code's session registry as read now.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Registry {
    /// Live sessions (pid alive and start time matching), newest first.
    pub sessions: Vec<TerminalSession>,
    /// `<pid>.json` files that do not parse although the process they name
    /// is the running session: a `<pid>.<hash>.key` of the same pid records
    /// that process's start time. Such a session is not in `sessions`.
    pub unreadable: Vec<UnreadableSessionFile>,
}

/// Brings a Claude login that joined the watched folders since the last
/// look (a running session's `CLAUDE_CONFIG_DIR`, a folder added or shared
/// again) in line with direct delivery, as the core does at start: without
/// it such a login would hold relayed messages until the next restart.
fn follow_new_logins(config: &ClaudeConfig) {
    static KNOWN: Mutex<Option<HashMap<PathBuf, Vec<PathBuf>>>> = Mutex::new(None);
    let homes = config.dirs.extra_homes(&config.home);
    {
        let mut known = KNOWN.lock().unwrap_or_else(|e| e.into_inner());
        let known = known.get_or_insert_with(HashMap::new);
        let before = known.insert(config.home.clone(), homes.clone());
        // The first look follows too: the scan just before it may have
        // recorded a folder the core's start did not know.
        if before.is_some_and(|before| homes.iter().all(|home| before.contains(home))) {
            return;
        }
    }
    let _ = crate::relay::claude_settings::ClaudeSettings::new(config).follow_default();
}

/// Reads Claude Code's session registry.
pub fn registry(config: &ClaudeConfig, table: &dyn ProcessTable) -> Registry {
    config.dirs.remember_running(table);
    follow_new_logins(config);
    let mut registry = Registry::default();
    let configured = config.registry();
    for (directory, path) in config
        .registries()
        .into_iter()
        .flat_map(|directory| {
            sorted_entries(&directory)
                .into_iter()
                .map(move |path| (directory.clone(), path))
        })
        .filter(|(_, path)| path.extension().is_some_and(|e| e == "json"))
    {
        let record = std::fs::read(&path)
            .map_err(|error| error.to_string())
            .and_then(|data| first_value(&data).map_err(|error| error.to_string()));
        match record {
            Ok(record) => {
                let Some(mut session) = TerminalSession::decode_value(&record) else {
                    continue;
                };
                session.updated_at_ms = modified_ms(&path);
                session.registry = (directory != configured).then(|| directory.clone());
                if is_alive(table, &session) {
                    // One entry per process. A stale entry without a start
                    // time passes `is_alive` by pid alone, so one whose start
                    // time matches wins over it, in whichever login it is.
                    match registry
                        .sessions
                        .iter()
                        .position(|other| other.pid == session.pid)
                    {
                        None => registry.sessions.push(session),
                        Some(index)
                            if registry.sessions[index].proc_start.is_none()
                                && session.proc_start.is_some() =>
                        {
                            registry.sessions[index] = session;
                        }
                        Some(_) => {}
                    }
                }
            }
            Err(error) => {
                let Some(pid) = registry_pid(&path) else {
                    continue;
                };
                if key_names_running_process(&directory, table, pid) {
                    registry
                        .unreadable
                        .push(UnreadableSessionFile { path, pid, error });
                }
            }
        }
    }
    registry.sessions.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then(a.pid.cmp(&b.pid))
    });
    clear::remember_processes(&registry.sessions);
    registry
}

/// Live Claude Code terminal sessions (pid alive and start time matching),
/// newest first.
pub fn terminal_sessions(config: &ClaudeConfig, table: &dyn ProcessTable) -> Vec<TerminalSession> {
    registry(config, table).sessions
}

/// The pid a `<pid>.json` registry file is named after.
fn registry_pid(path: &Path) -> Option<i32> {
    path.file_stem()?
        .to_str()?
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 0)
}

/// The `<pid>.<hash>.key` records of `pid`, each as its JSON value.
fn key_records(registry: &Path, pid: i32) -> Vec<Value> {
    let prefix = format!("{pid}.");
    sorted_entries(registry)
        .into_iter()
        .filter(|path| {
            path.extension().is_some_and(|e| e == "key")
                && path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(&prefix))
        })
        .filter_map(|path| first_value(&std::fs::read(path).ok()?).ok())
        .collect()
}

/// Whether a key of `pid` records the start time of the process running
/// as `pid` now, so a file named after that pid is the running session's
/// and not one left by an earlier process the pid was recycled from.
fn key_names_running_process(registry: &Path, table: &dyn ProcessTable, pid: i32) -> bool {
    let Some(process) = table.process(pid) else {
        return false;
    };
    key_records(registry, pid).iter().any(|record| {
        recorded_start(&record["procStart"])
            .is_some_and(|start| claude_start_matches(table.start_clock(), &start, &process))
    })
}

/// The live session with this id, looked up afresh: its pid and socket
/// change when it is resumed in a new process.
pub fn terminal_session(
    config: &ClaudeConfig,
    table: &dyn ProcessTable,
    session_id: &str,
) -> Option<TerminalSession> {
    terminal_sessions(config, table)
        .into_iter()
        .find(|s| s.session_id == session_id)
}

/// What holds a terminal session's transcript. A registry entry is read
/// only once `is_alive` has proved its process (pid and recorded start),
/// so the entry is the holder; which kind of holder it is, the entry
/// itself records, in the field Claude Code's own handoff reads to decide
/// whether a session is already taken. The process's command cannot
/// answer this: a chat hosted in another app (Conductor, Paseo, Claude
/// Desktop) runs a structured pipe and is still a session a person types
/// in, and records itself `interactive`. An entry too old to record a
/// kind is taken as interactive, so no action that works is hidden on a
/// guess. [`is_interactive_terminal`] answers a different question — may
/// this session be put on the relay without being asked — and keeps its
/// own evidence.
pub fn holder(session: &TerminalSession) -> SessionHolder {
    match session.kind.as_deref().filter(|kind| !kind.is_empty()) {
        Some("interactive") | None => SessionHolder::Interactive,
        Some(_) => SessionHolder::Background,
    }
}

/// Whether a live registry entry is a conversational Claude Code terminal,
/// rather than an Agent SDK, `claude -p`, or structured pipe run. Those
/// automation modes publish the same session records as the interactive UI,
/// so the process command and terminal attachment are the deciding evidence.
pub fn is_interactive_terminal(table: &dyn ProcessTable, session: &TerminalSession) -> bool {
    if session
        .name
        .as_deref()
        .is_some_and(|name| name.to_lowercase().starts_with("sdk-"))
    {
        return false;
    }
    is_interactive_process(table, session.pid)
}

/// Whether the Claude Code process `pid` is one a person is typing in: its
/// command is not `-p`/`--print` or a structured JSON pipe, and it is
/// attached to a terminal. [`is_interactive_terminal`] adds the session-name
/// check for registry entries.
pub fn is_interactive_process(table: &dyn ProcessTable, pid: i32) -> bool {
    let arguments = table.arguments(pid);
    if arguments.is_empty() {
        return false;
    }
    let lowered: Vec<String> = arguments.iter().map(|arg| arg.to_lowercase()).collect();
    if lowered
        .iter()
        .any(|arg| arg == "-p" || arg == "--print" || arg.starts_with("--print="))
    {
        return false;
    }
    for option in ["--input-format", "--output-format"] {
        let structured = lowered.iter().enumerate().any(|(index, argument)| {
            let value = argument.strip_prefix(&format!("{option}=")).or_else(|| {
                (argument == option)
                    .then(|| lowered.get(index + 1))
                    .flatten()
                    .map(String::as_str)
            });
            matches!(value, Some("json" | "stream-json"))
        });
        if structured {
            return false;
        }
    }
    table.has_terminal(pid)
}

/// Whether a live registry entry is a chat a person runs in Conductor: in a
/// Conductor workspace and started by this user's Conductor sidecar.
/// Conductor drives every chat as a structured `stream-json` Agent SDK run,
/// which [`is_interactive_terminal`] rightly takes for automation, but a
/// person is typing in it, as in a terminal.
///
/// No other Claude Code session (`sessions`) may sit between the chat and
/// the sidecar: a `claude -p` or SDK run a chat starts from its tools shares
/// the workspace and reaches the sidecar only through that chat, so it stays
/// automation.
pub fn is_conductor_chat(
    table: &dyn ProcessTable,
    uid: u32,
    session: &TerminalSession,
    sessions: &[TerminalSession],
) -> bool {
    crate::relay::conductor::host(session.cwd.as_deref()).is_some()
        && crate::relay::conductor::under_sidecar(table, uid, session.pid, &|pid| {
            sessions.iter().any(|other| other.pid == pid)
        })
}

fn terminal_host(
    table: &dyn ProcessTable,
    session: &TerminalSession,
    sessions: &[TerminalSession],
) -> Option<String> {
    if is_paseo_chat(table, session, sessions) {
        Some(crate::relay::paseo::HOST.to_string())
    } else {
        crate::relay::conductor::host(session.cwd.as_deref())
    }
}

fn sorted_entries(directory: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(directory)
        .map(|read| read.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    entries.sort();
    entries
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    i64::try_from(modified.duration_since(UNIX_EPOCH).ok()?.as_millis()).ok()
}

/// The inbox token from the session's `<pid>.<hash>.key` whose recorded
/// start matches the session's. A key that records no start is used only
/// when it is the pid's one key, so a leftover key from an earlier process
/// with this pid never wins. Never logged or put in an error.
pub fn peer_token(config: &ClaudeConfig, session: &TerminalSession) -> Option<String> {
    let registry = session
        .registry
        .clone()
        .unwrap_or_else(|| config.registry());
    let keys: Vec<(String, Option<String>)> = key_records(&registry, session.pid)
        .into_iter()
        .filter_map(|record| {
            let token = record["peerToken"].as_str().filter(|t| !t.is_empty())?;
            Some((token.to_string(), recorded_start(&record["procStart"])))
        })
        .collect();
    if let Some(start) = &session.proc_start {
        if let Some((token, _)) = keys.iter().find(|(_, key)| key.as_ref() == Some(start)) {
            return Some(token.clone());
        }
    }
    match keys.as_slice() {
        [(token, None)] => Some(token.clone()),
        [(token, Some(_))] if session.proc_start.is_none() => Some(token.clone()),
        _ => None,
    }
}

/// One delivery to an inbox: the auth line, then the user message, as
/// Claude Code's own sessions address each other (peer protocol 1).
/// `message_id` lets a session that sees the same delivery twice recognise
/// it. Nothing comes back on the connection.
#[derive(Debug)]
pub struct PeerFrames {
    pub bytes: Vec<u8>,
    /// The length of the auth line, newline included.
    pub auth_len: usize,
}

/// ```text
/// {"token":"<peerToken>","type":"auth"}
/// {"message":{"content":"…","role":"user"},"msg_id":…,"priority":"next","type":"user","uuid":…}
/// ```
pub fn peer_frames(token: &str, message_id: &str, text: &str) -> Result<PeerFrames, String> {
    let line = |value: Value| {
        let mut bytes = serde_json::to_vec(&value).expect("JSON values serialize");
        bytes.push(b'\n');
        bytes
    };
    let auth = line(json!({"type": "auth", "token": token}));
    let message = line(json!({
        "type": "user",
        "msg_id": message_id,
        "uuid": random_uuid().to_uppercase(),
        "priority": "next",
        "message": {"role": "user", "content": text},
    }));
    if auth.len() > MAX_LINE_BYTES {
        return Err("the session's inbox key is too long to send".into());
    }
    if message.len() > MAX_LINE_BYTES {
        return Err(format!(
            "the message is {} bytes, past the {MAX_LINE_BYTES} a session accepts",
            message.len()
        ));
    }
    let auth_len = auth.len();
    Ok(PeerFrames {
        bytes: [auth, message].concat(),
        auth_len,
    })
}

/// Writes `text` into the session's inbox. Blocking. `Delivered` means the
/// bytes were handed over, not that Claude read or ran them.
pub fn send_to_terminal(
    config: &ClaudeConfig,
    table: &dyn ProcessTable,
    session_id: &str,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    if !is_uuid(session_id) {
        return InjectOutcome::Refused("invalid session id".into());
    }
    let Some(session) = terminal_session(config, table, session_id) else {
        return InjectOutcome::Waiting("that Claude Code session is not running".into());
    };
    if !session.speaks_known_protocol() {
        return InjectOutcome::Retry(format!(
            "that Claude Code session speaks peer protocol {}, which this app does not know",
            session.peer_protocol
        ));
    }
    let Some(token) = peer_token(config, &session) else {
        return InjectOutcome::Retry("could not read that Claude Code session's inbox key".into());
    };
    let frames = match peer_frames(&token, message_id, text) {
        Ok(frames) => frames,
        Err(reason) => return InjectOutcome::Retry(reason),
    };
    inbox_socket::write(&session.socket_path, &frames, session.pid)
}

// MARK: Claude app (cloud) sessions

/// A cloud session the Claude desktop app has open against local folders,
/// as its `remote-session-spaces.json` records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudSession {
    /// A tagged `session_…` / `cse_…` id.
    pub session_id: String,
    pub folders: Vec<String>,
}

impl CloudSession {
    /// The last component of the first folder, or the id.
    pub fn display_name(&self) -> String {
        self.folders
            .first()
            .and_then(|folder| Path::new(folder).file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.session_id.clone())
    }
}

/// Decodes one `remote-session-spaces.json`. Lenient, since the file is
/// the desktop app's: unknown fields are ignored and entries without a
/// valid tagged id are skipped; a file of another shape is an error.
pub fn decode_spaces(data: &[u8]) -> Result<Vec<CloudSession>, String> {
    let file: Value = serde_json::from_slice(data).map_err(|e| e.to_string())?;
    let entries = file["entries"]
        .as_array()
        .ok_or("the file has no entries list")?;
    Ok(entries
        .iter()
        .filter_map(|entry| {
            let session_id = entry["sessionId"]
                .as_str()
                .filter(|id| is_claude_session_id(id))?;
            let folders = entry["folders"]
                .as_array()
                .map(|folders| {
                    folders
                        .iter()
                        .filter_map(|f| f.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            Some(CloudSession {
                session_id: session_id.to_string(),
                folders,
            })
        })
        .collect())
}

/// The cloud sessions the Claude desktop app has against local folders,
/// across every signed-in account
/// (`<app sessions>/<account>/<organization>/remote-session-spaces.json`).
/// Empty when the desktop app is absent.
pub fn cloud_sessions(config: &ClaudeConfig) -> Vec<CloudSession> {
    let Some(root) = &config.app_sessions else {
        return Vec::new();
    };
    let visible = |path: &PathBuf| {
        path.file_name()
            .is_some_and(|n| !n.to_string_lossy().starts_with('.'))
    };
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for account in sorted_entries(root).into_iter().filter(visible) {
        for organization in sorted_entries(&account).into_iter().filter(visible) {
            let Ok(data) = std::fs::read(organization.join("remote-session-spaces.json")) else {
                continue;
            };
            let Ok(sessions) = decode_spaces(&data) else {
                continue;
            };
            for session in sessions {
                if seen.insert(session.session_id.clone()) {
                    found.push(session);
                }
            }
        }
    }
    found
}

/// Arguments for sending into `session_id`; the text goes on standard
/// input, never in the arguments, so it can neither be parsed as a flag nor
/// show in `ps`. `--output-format json` only when the CLI advertises it: a
/// CLI that cannot parse the option exits before sending anything.
pub fn cloud_arguments(session_id: &str, json_result: bool) -> Vec<String> {
    let mut arguments: Vec<String> = vec!["--print".into(), "--cloud".into(), session_id.into()];
    if json_result {
        arguments.extend(["--output-format".into(), "json".into()]);
    }
    arguments
}

/// Whether a CLI whose `--help` reads like this can be asked for the JSON
/// result: it has to know both the flag and the `--cloud` send itself.
pub fn advertises_json_result(help: &str) -> bool {
    help.contains("--output-format") && help.contains("--cloud")
}

/// What one `claude --print --cloud` run amounted to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendOutcome {
    /// Claude accepted the message; `url` links the session when reported.
    Sent { url: Option<String> },
    /// Refused in a way trying again cannot fix: archived or unknown
    /// session, or an account that cannot send to cloud sessions.
    Refused(String),
    /// Failed in a way that may pass: network, sign-in, a busy service.
    Failed(String),
}

const SENT_MARKER: &str = "Sent to cloud session.";
const PERMANENT_MARKERS: [&str; 4] = [
    "is archived",
    "invalid session id",
    "is not a cloud session id",
    "not enabled for your account",
];

/// Whether a refusal `reason` is a Claude app session saying it is archived.
pub fn is_archived_refusal(reason: &str) -> bool {
    reason.to_lowercase().contains(PERMANENT_MARKERS[0])
}

/// Reads the outcome from the exit code and output. The documented JSON
/// result (`{ok, session_id, url}` or `{ok: false, error}`) decides when
/// present; configuration errors print plain text, and an older CLI prints
/// only its confirmation line, which is accepted on exit 0. Anything unclear
/// is a failure, never a success.
pub fn send_outcome(exit_code: i32, stdout: &str, stderr: &str) -> SendOutcome {
    if let Some(result) = json_result(stdout) {
        if result["ok"] == true {
            return SendOutcome::Sent {
                url: result["url"].as_str().map(str::to_string),
            };
        }
        return classify(
            result["error"]
                .as_str()
                .unwrap_or("claude reported a failed send"),
        );
    }
    if exit_code == 0 && stdout.contains(SENT_MARKER) {
        return SendOutcome::Sent { url: None };
    }
    let detail = first_line(if stderr.is_empty() { stdout } else { stderr });
    if detail.is_empty() {
        classify(&format!("claude exited with code {exit_code}"))
    } else {
        classify(detail)
    }
}

/// The one JSON object in the output, ignoring anything printed around it.
/// Only `ok` is required, so an added field cannot spoil a send.
fn json_result(output: &str) -> Option<Value> {
    let start = output.find('{')?;
    let end = output.rfind('}')?;
    if start >= end {
        return None;
    }
    let value: Value = serde_json::from_str(&output[start..=end]).ok()?;
    value["ok"].is_boolean().then_some(value)
}

fn first_line(output: &str) -> &str {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// Held to 300 characters, so a runaway message cannot bloat an ack.
fn classify(detail: &str) -> SendOutcome {
    let trimmed = detail.trim();
    let cleaned = trimmed.strip_prefix("Error: ").unwrap_or(trimmed);
    let capped: String = cleaned.chars().take(300).collect();
    let lowered = capped.to_lowercase();
    if PERMANENT_MARKERS.iter().any(|m| lowered.contains(m)) {
        SendOutcome::Refused(capped)
    } else {
        SendOutcome::Failed(capped)
    }
}

/// How one command run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunOutcome {
    Exited {
        code: i32,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    /// The program could not be started.
    NotStarted(String),
    /// It did not finish in time and was stopped.
    TimedOut,
}

/// Runs a command line; the seam that keeps tests from executing `claude`.
pub trait CommandRunner: Send + Sync {
    /// Runs `program` in a neutral directory with `input` on standard input,
    /// stopping it after `timeout`.
    fn run(
        &self,
        program: &Path,
        arguments: &[String],
        input: &[u8],
        timeout: Duration,
    ) -> RunOutcome;
}

/// The environment a launched agent CLI runs with, given its name and this
/// process's environment through an optional caller-supplied hook.
pub type AgentEnvironment = std::sync::Arc<
    dyn Fn(
            &str,
            std::collections::BTreeMap<String, String>,
        ) -> std::collections::BTreeMap<String, String>
        + Send
        + Sync,
>;

/// Runs commands on this computer.
#[derive(Clone, Default)]
pub struct SystemRunner {
    /// Replaces the inherited environment when set.
    pub environment: Option<AgentEnvironment>,
}

impl CommandRunner for SystemRunner {
    fn run(
        &self,
        program: &Path,
        arguments: &[String],
        input: &[u8],
        timeout: Duration,
    ) -> RunOutcome {
        use std::process::{Command, Stdio};
        use std::sync::mpsc;
        // A neutral directory: the send must not pick up a project's
        // settings, hooks or MCP servers from wherever the core started.
        let mut command = Command::new(program);
        crate::platform::process::hide_window(&mut command);
        if let Some(environment) = &self.environment {
            let cli = cli_name(program);
            command
                .env_clear()
                .envs(environment(&cli, std::env::vars().collect()));
        }
        let spawned = command
            .args(arguments)
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => return RunOutcome::NotStarted(error.to_string()),
        };
        // Written and read off-thread, so a child that never reads, or
        // fills a pipe, cannot wedge the timeout below.
        if let Some(mut stdin) = child.stdin.take() {
            let input = input.to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&input);
            });
        }
        let reader = |pipe: Option<Box<dyn Read + Send>>| {
            let (sender, receiver) = mpsc::channel();
            if let Some(mut pipe) = pipe {
                std::thread::spawn(move || {
                    let mut bytes = Vec::new();
                    let _ = pipe.read_to_end(&mut bytes);
                    let _ = sender.send(bytes);
                });
            }
            receiver
        };
        let stdout = reader(
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        );
        let stderr = reader(
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        );
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                _ => {
                    stop(&mut child);
                    return RunOutcome::TimedOut;
                }
            }
        };
        let collect = |receiver: mpsc::Receiver<Vec<u8>>| {
            receiver
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or_default()
        };
        RunOutcome::Exited {
            code: status.code().unwrap_or(-1),
            stdout: collect(stdout),
            stderr: collect(stderr),
        }
    }
}

/// SIGTERM, then SIGKILL after five seconds (Windows terminates at once;
/// see `platform::process`).
fn stop(child: &mut std::process::Child) {
    // A child this process spawned and has not reaped, so its pid is its own.
    crate::platform::process::terminate(child.id());
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
}

type CapabilityKey = (PathBuf, Option<SystemTime>);

/// Whether each CLI advertises the JSON result, keyed by path and
/// modification time so an updated CLI is asked again.
fn json_support() -> &'static Mutex<HashMap<CapabilityKey, bool>> {
    static SUPPORT: OnceLock<Mutex<HashMap<CapabilityKey, bool>>> = OnceLock::new();
    SUPPORT.get_or_init(Default::default)
}

/// Read from the CLI's own `--help`, once per build. A probe that does not
/// run or answer in time is not remembered; the send uses the confirmation
/// line for now.
pub fn supports_json_result(runner: &dyn CommandRunner, claude: &Path) -> bool {
    let modified = std::fs::metadata(claude).and_then(|m| m.modified()).ok();
    let key = (claude.to_path_buf(), modified);
    if let Some(known) = json_support().lock().unwrap().get(&key) {
        return *known;
    }
    let RunOutcome::Exited {
        code: 0, stdout, ..
    } = runner.run(claude, &["--help".to_string()], b"", HELP_TIMEOUT)
    else {
        return false;
    };
    let supported = advertises_json_result(&String::from_utf8_lossy(&stdout));
    json_support().lock().unwrap().insert(key, supported);
    supported
}

/// Sends `text` into the Claude app session `session_id` as a user message.
/// Blocking, for up to `SEND_TIMEOUT`.
pub fn send_to_cloud(
    config: &ClaudeConfig,
    runner: &SystemRunner,
    session_id: &str,
    text: &str,
) -> InjectOutcome {
    send_to_cloud_with(config, runner, session_id, text)
}

/// `send_to_cloud` through `runner`. The id is checked against Claude's
/// exact tagged shape first: a free-form word given to `--cloud` would
/// start a new session described by it.
pub fn send_to_cloud_with(
    config: &ClaudeConfig,
    runner: &dyn CommandRunner,
    session_id: &str,
    text: &str,
) -> InjectOutcome {
    if !is_claude_session_id(session_id) {
        return InjectOutcome::Refused("invalid session id".into());
    }
    let Some(claude) = &config.executable else {
        return InjectOutcome::Retry("the claude command line is not installed".into());
    };
    let arguments = cloud_arguments(session_id, supports_json_result(runner, claude));
    match runner.run(claude, &arguments, text.as_bytes(), SEND_TIMEOUT) {
        RunOutcome::NotStarted(_) => {
            InjectOutcome::Retry("the claude command line is not installed".into())
        }
        RunOutcome::TimedOut => InjectOutcome::InDoubt("claude did not answer in time".into()),
        RunOutcome::Exited {
            code,
            stdout,
            stderr,
        } => match send_outcome(
            code,
            &String::from_utf8_lossy(&stdout),
            &String::from_utf8_lossy(&stderr),
        ) {
            SendOutcome::Sent { .. } => InjectOutcome::Delivered,
            SendOutcome::Refused(reason) => InjectOutcome::Refused(reason),
            SendOutcome::Failed(reason) => InjectOutcome::Retry(reason),
        },
    }
}

// MARK: Discovery and final answers

/// Claude terminal and Claude app (cloud) sessions. A terminal session is
/// as recent as Claude Code's last write to its registry entry.
pub fn discover(config: &ClaudeConfig, table: &dyn ProcessTable) -> Vec<DiscoveredSession> {
    let sessions = terminal_sessions(config, table);
    let terminal = sessions.iter().map(|session| DiscoveredSession {
        target: Target::new(SessionKind::ClaudeTerminal, session.session_id.clone()),
        title: crate::relay::session_titles::claude::display_title(config, session),
        directory: session.cwd.clone(),
        updated_at_ms: session.updated_at_ms,
        host: terminal_host(table, session, &sessions),
        live: true,
        holder: Some(holder(session)),
    });
    let cloud = cloud_sessions(config)
        .into_iter()
        .map(|session| DiscoveredSession {
            target: Target::new(SessionKind::ClaudeCloud, session.session_id.clone()),
            title: session.display_name(),
            directory: session.folders.first().cloned(),
            updated_at_ms: None,
            host: None,
            live: true,
            // A Claude app chat is not a transcript one process holds.
            holder: None,
        });
    terminal
        .chain(cloud)
        .filter(|session| session.target.is_valid())
        .collect()
}

/// Claude Code's folder name for a working directory under `projects/`:
/// every character but an ASCII letter or digit becomes `-`.
pub fn project_folder(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The terminal session's final answer to the turn whose prompt carried
/// `message_ref`, from its transcript `projects/<folder>/<id>.jsonl`. A
/// session that has exited is out of the registry but its transcript is
/// still on disk, and its turn is over one way or another.
pub fn final_answer(
    config: &ClaudeConfig,
    table: &dyn ProcessTable,
    session_id: &str,
    message_ref: &str,
) -> Option<String> {
    let (path, live) = transcript::path(config, table, session_id)?;
    let transcript = std::fs::read(path).ok()?;
    final_answer::claude(&transcript, message_ref, live.is_none_or(|s| s.is_idle()))
}

pub mod app;
pub mod clear;
pub mod hold;
pub mod inbox;
mod inbox_socket;
pub mod status;
pub mod transcript;
pub use app::{is_app_hosted_chat, is_paseo_chat};
pub use clear::{cleared, started_before_clear, Cleared};
pub use hold::{predicted_hold, Hold};
pub mod session_hook;

#[cfg(test)]
mod tests;
