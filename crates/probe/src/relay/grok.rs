//! Grok on this computer: where it keeps its state, the live sessions its
//! TUI records, and its leader-mode setting.
//!
//! - **Discovery.** A running `grok` TUI records itself in
//!   `<grok home>/active_sessions.json` (`session_id`, `pid`, `cwd`,
//!   `opened_at`) and removes the record when it exits. That is the Grok
//!   counterpart of Claude Code's `sessions/<pid>.json`, except that a plain
//!   TUI opens no socket: the record is discovery, not a route. Paseo does
//!   not write that file: it starts `grok agent stdio` under its daemon, and
//!   those sessions are listed from that process plus the session id Paseo
//!   recorded for it, once that process's own Grok session directory exists.
//!   A client started with `--no-leader`, or whose leader is not the one
//!   running, is listed and is not deliverable.
//! - **The route.** With leader mode on (`[cli] use_leader = true` in
//!   `<grok home>/config.toml`, or `grok --leader`), the TUI spawns a shared
//!   `grok agent leader` on `<grok home>/leader.sock`, and that leader loads
//!   and prompts the TUI's own session for a second ACP client. The
//!   already-open route in `existing_session` binds and proves it.
//! - **The setting.** `GrokSettings` serves `use_leader` as the `grok_leader`
//!   setting. It rewrites only that one line of `config.toml`, keeping every
//!   other byte, with the same symlink, mode and backup rules as the Claude
//!   settings editor.
//!
//! Processes are read through a `ProcessTable`, so tests never start Grok.

mod titles;
use titles::title;
pub(crate) use titles::{binding_title, native_title};

use crate::relay::agents::SettingsExtension;
use crate::relay::claude_settings::{resolve_symlinks, write_keeping_file};
use crate::relay::existing_session::platform;
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, SessionKind, Target};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The `settings.get` key for `[cli] use_leader`.
pub const SETTING: &str = "grok_leader";

/// Kept beside `config.toml` the first time it is rewritten.
const BACKUP_SUFFIX: &str = ".relay-desktop-backup";

/// Where Grok keeps its state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrokConfig {
    /// `GROK_HOME`, else `~/.grok`: the live-session registry, `config.toml`,
    /// the session store and the default `leader.sock`.
    pub home: PathBuf,
}

impl GrokConfig {
    /// Reads `GROK_HOME` from `env`; `home` is the user's home directory.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> GrokConfig {
        let grok_home = env("GROK_HOME")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(|value| expand_tilde(&value, home))
            .unwrap_or_else(|| home.join(".grok"));
        GrokConfig { home: grok_home }
    }

    /// Whether Grok has run for this user: its home exists. Never on
    /// Windows, where its leader's Unix socket, the only route into a
    /// session, does not exist, so its setting is not offered there.
    pub fn installed(&self) -> bool {
        platform::SUPPORTED && self.home.is_dir()
    }

    /// The live-session registry the TUI keeps.
    pub fn active_sessions(&self) -> PathBuf {
        self.home.join("active_sessions.json")
    }

    /// The user's own `config.toml`.
    pub fn config_file(&self) -> PathBuf {
        self.home.join("config.toml")
    }

    /// The socket a leader with no `--leader-socket` listens on.
    pub fn default_leader_socket(&self) -> PathBuf {
        self.home.join("leader.sock")
    }

    /// One session's directory in Grok's store: the working directory,
    /// percent-encoded as one path component, then the session id.
    pub fn session_dir(&self, cwd: &str, session_id: &str) -> PathBuf {
        self.home
            .join("sessions")
            .join(encode_component(cwd))
            .join(session_id)
    }
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if path == "~" => home.to_path_buf(),
        None => PathBuf::from(path),
    }
}

/// Grok's encoding of a working directory as one path component: every byte
/// outside `A-Za-z0-9-_.!~*'()` becomes `%XX`.
fn encode_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// One record of `active_sessions.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveSession {
    pub session_id: String,
    pub pid: i32,
    pub cwd: Option<String>,
    pub opened_at_ms: Option<i64>,
}

/// Decodes `active_sessions.json`. Lenient, since the file is Grok's: a
/// record without a UUID session id or a positive pid is skipped, and a
/// file that is not a list is empty.
pub fn decode_active_sessions(data: &[u8]) -> Vec<ActiveSession> {
    let Ok(Value::Array(records)) = serde_json::from_slice::<Value>(data) else {
        return Vec::new();
    };
    records
        .iter()
        .filter_map(|record| {
            let session_id = record["session_id"].as_str().filter(|id| is_uuid(id))?;
            let pid = record["pid"]
                .as_i64()
                .filter(|pid| *pid > 0)
                .and_then(|pid| i32::try_from(pid).ok())?;
            Some(ActiveSession {
                session_id: session_id.to_string(),
                pid,
                cwd: record["cwd"]
                    .as_str()
                    .filter(|cwd| !cwd.is_empty())
                    .map(str::to_string),
                opened_at_ms: record["opened_at"]
                    .as_str()
                    .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                    .map(|time| time.timestamp_millis()),
            })
        })
        .collect()
}

/// Whether `pid` is a Grok process: the kernel's executable for it is named
/// `grok` or `grok-<version>`, as Grok installs itself. A record whose pid
/// another program now has is a stale record, not a session.
fn is_grok_process(table: &dyn ProcessTable, pid: i32) -> bool {
    table.executable(pid).is_some_and(|executable| {
        executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "grok" || name.starts_with("grok-"))
    })
}

/// The sessions the registry names whose process is alive, this user's and
/// a Grok executable. A dead or recycled pid is not a session; a record of
/// another user is not this user's.
pub fn active_sessions(
    config: &GrokConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<ActiveSession> {
    // No Grok session is reachable on Windows (`GrokConfig::installed`).
    if !platform::SUPPORTED {
        return Vec::new();
    }
    let Ok(data) = std::fs::read(config.active_sessions()) else {
        return Vec::new();
    };
    decode_active_sessions(&data)
        .into_iter()
        .filter(|session| {
            table
                .process(session.pid)
                .is_some_and(|process| process.uid == uid)
                && is_grok_process(table, session.pid)
        })
        .collect()
}

/// Whether `arguments` are a `grok agent stdio` client, including
/// `grok agent --no-leader stdio`. A leader is not one: it serves clients
/// and does not itself name a session. `--no-leader` still matches here;
/// that client is listed and is not deliverable.
fn is_stdio_agent(arguments: &[String]) -> bool {
    let Some(agent) = arguments.iter().position(|argument| argument == "agent") else {
        return false;
    };
    let rest = &arguments[agent + 1..];
    rest.iter().any(|argument| argument == "stdio")
        && !rest.iter().any(|argument| argument == "leader")
}

/// The leader socket `pid` is attached to. `--no-leader` is attached to
/// none. One `--leader-socket` names that socket; two name none, the same
/// rule as a leader's own argv. Otherwise the socket is `leader.sock` in
/// this process's Grok home. This is the Paseo deliverability check. A TUI
/// keeps [`preferred_leader_socket`], which does not treat `--no-leader` as
/// detachment.
pub(crate) fn attached_leader_socket(table: &dyn ProcessTable, pid: i32) -> Option<PathBuf> {
    let arguments = table.arguments(pid);
    if arguments.iter().any(|argument| argument == "--no-leader") {
        return None;
    }
    let mut named = arguments
        .windows(2)
        .filter(|pair| pair[0] == "--leader-socket")
        .map(|pair| PathBuf::from(&pair[1]));
    match named.next() {
        Some(socket) => named.next().is_none().then_some(socket),
        None => crate::relay::existing_session::grok::default_leader_socket(table, pid),
    }
}

/// The socket registration prefers for a Grok client already listed as
/// deliverable: the first `--leader-socket` in its argv, else `leader.sock`
/// in its own Grok home. `--no-leader` does not change this. A Paseo client
/// started that way is left out of `open_sessions` before this is asked, so
/// a TUI that passes the flag still prefers its own home.
pub(crate) fn preferred_leader_socket(table: &dyn ProcessTable, pid: i32) -> Option<PathBuf> {
    let arguments = table.arguments(pid);
    let named = arguments
        .windows(2)
        .find(|pair| pair[0] == "--leader-socket")
        .map(|pair| PathBuf::from(&pair[1]));
    named.or_else(|| crate::relay::existing_session::grok::default_leader_socket(table, pid))
}

/// Whether a leader of `uid` is serving the socket `pid` is attached to.
/// A `--no-leader` client, or a client whose socket no leader has, is not.
fn client_reaches_leader(table: &dyn ProcessTable, uid: u32, pid: i32) -> bool {
    let Some(socket) = attached_leader_socket(table, pid) else {
        return false;
    };
    use crate::relay::existing_session::grok::{
        default_leader_socket, leader_socket, open_leader_pids,
    };
    open_leader_pids(table, uid).into_iter().any(|leader| {
        let default = default_leader_socket(table, leader);
        leader_socket(&table.arguments(leader), default.as_deref())
            .is_some_and(|served| served == socket)
    })
}

/// Grok sessions Paseo is driving. Each is a `grok agent stdio` of this user
/// under the packaged Paseo helper, with no other Grok process between it
/// and that helper, and the session id is the one that helper's agent record
/// names for `PASEO_AGENT_ID`, accepted only when
/// that process's own Grok session directory for `PASEO_AGENT_CWD` exists.
/// The home is the process's `GROK_HOME` or `~/.grok`, never the probe's.
/// The pid is the stdio client. A client that shares no running leader is
/// still returned: listing it is separate from delivering to it.
pub fn paseo_sessions(table: &dyn ProcessTable, uid: u32) -> Vec<ActiveSession> {
    // Paseo and Grok's leader are not available on Windows.
    if !platform::SUPPORTED {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for pid in table.all_pids() {
        let Some(process) = table.process(pid).filter(|process| process.uid == uid) else {
            continue;
        };
        if !is_grok_process(table, pid)
            || !is_stdio_agent(&table.arguments(pid))
            || !crate::relay::paseo::under_daemon_excluding(table, uid, pid, &|ancestor| {
                is_grok_process(table, ancestor)
            })
            || !table.environment_readable(pid)
        {
            continue;
        }
        let Some(agent_id) = table.environment_var(pid, "PASEO_AGENT_ID") else {
            continue;
        };
        let Some(cwd) = table.environment_var(pid, "PASEO_AGENT_CWD") else {
            continue;
        };
        let cwd = crate::relay::paseo::normalize_directory(&cwd);
        if !Path::new(&cwd).is_absolute() {
            continue;
        }
        let Some(paseo_home) = crate::relay::paseo::home_of(table, pid) else {
            continue;
        };
        let Some(session_id) = crate::relay::paseo::grok_session_id(&paseo_home, &agent_id, &cwd)
        else {
            continue;
        };
        let Some(grok_home) = crate::relay::existing_session::grok::grok_home(table, pid) else {
            continue;
        };
        let store = GrokConfig { home: grok_home };
        if !store.session_dir(&cwd, &session_id).is_dir() || !seen.insert(session_id.clone()) {
            continue;
        }
        // A pid recycled while this was read is not the session.
        if table.process(pid) != Some(process) {
            continue;
        }
        found.push(ActiveSession {
            session_id,
            pid,
            cwd: Some(cwd),
            opened_at_ms: None,
        });
    }
    found
}

/// Why `session_id` must not be bound to a leader. `None` when it is not a
/// Paseo-only session, or when its stdio client is attached to a leader that
/// is running. Binding anything else would prompt a different Grok process
/// than the chat Paseo is showing.
pub fn paseo_unbindable(
    config: &GrokConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> Option<String> {
    let client = paseo_sessions(table, uid)
        .into_iter()
        .find(|session| session.session_id == session_id)?;
    if active_sessions(config, table, uid)
        .iter()
        .any(|session| session.session_id == session_id)
    {
        return None;
    }
    if attached_leader_socket(table, client.pid).is_none() {
        return Some(
            "This Grok session is running without a shared leader, so a message would not reach the chat in Paseo."
                .into(),
        );
    }
    if !client_reaches_leader(table, uid, client.pid) {
        return Some(
            "No Grok leader is running for this session. Turn on Grok leader mode in Settings, then restart Grok."
                .into(),
        );
    }
    None
}

/// Why a message must not be sent through an already-bound leader on
/// `socket`. `None` when no Paseo-only client is driving the session, or
/// when that client is attached to `socket`. A client that has since started
/// with `--no-leader`, or attached to another socket, would not show the
/// message in Paseo's chat. A client that has exited leaves the leader, as a
/// closed TUI does.
pub fn paseo_delivery_block(
    config: &GrokConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
    socket: &Path,
) -> Option<String> {
    let client = paseo_sessions(table, uid)
        .into_iter()
        .find(|session| session.session_id == session_id)?;
    if active_sessions(config, table, uid)
        .iter()
        .any(|session| session.session_id == session_id)
    {
        return None;
    }
    match attached_leader_socket(table, client.pid) {
        None => Some(
            "This Grok session is running without a shared leader, so a message would not reach the chat in Paseo."
                .into(),
        ),
        Some(attached) if attached == socket => None,
        Some(_) => Some(
            "This Grok session is attached to a different leader, so a message would not reach the chat in Paseo."
                .into(),
        ),
    }
}

/// TUI sessions from `active_sessions.json`, plus Paseo-hosted stdio sessions
/// the registry does not name and whose client is attached to a leader that
/// is running. A session both name keeps the registry's pid: that process is
/// the one whose argv names `--leader-socket`. A `--no-leader` client is
/// absent here, so nothing binds or replies through a different leader.
pub fn open_sessions(
    config: &GrokConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<ActiveSession> {
    let mut sessions = active_sessions(config, table, uid);
    let seen: HashSet<String> = sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    sessions.extend(paseo_sessions(table, uid).into_iter().filter(|session| {
        !seen.contains(&session.session_id) && client_reaches_leader(table, uid, session.pid)
    }));
    sessions
}

/// The Grok sessions, as `sessions.list` rows of kind `grok-open`: the TUI's
/// registry, and Grok sessions Paseo is driving. `live` says whether a leader
/// of this user is running, which is how a TUI row becomes deliverable. A
/// Paseo-only row is live only when that stdio client is attached to a leader
/// that is running, so a `--no-leader` client stays visible and is not
/// offered. Rows whose session is in `skip` (already bound and listed from
/// the binding) are left out. A Paseo-hosted session carries `host` `paseo`.
pub fn discover(
    config: &GrokConfig,
    table: &dyn ProcessTable,
    uid: u32,
    live: bool,
    skip: &dyn Fn(&str) -> bool,
) -> Vec<DiscoveredSession> {
    let registry = active_sessions(config, table, uid);
    let hosted_rows = paseo_sessions(table, uid);
    let registry_ids: HashSet<String> = registry
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    let hosted: HashSet<String> = hosted_rows
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    let mut sessions = registry;
    sessions.extend(
        hosted_rows
            .into_iter()
            .filter(|session| !registry_ids.contains(&session.session_id)),
    );
    sessions
        .into_iter()
        .filter(|session| !skip(&session.session_id))
        .map(|session| {
            let from_paseo_only =
                hosted.contains(&session.session_id) && !registry_ids.contains(&session.session_id);
            let store = if from_paseo_only {
                crate::relay::existing_session::grok::grok_home(table, session.pid)
                    .map(|home| GrokConfig { home })
                    .unwrap_or_else(|| config.clone())
            } else {
                config.clone()
            };
            DiscoveredSession {
                target: Target::new(SessionKind::GrokOpen, session.session_id.clone()),
                title: title(&store, &session),
                directory: session.cwd.clone(),
                updated_at_ms: session.opened_at_ms,
                host: hosted
                    .contains(&session.session_id)
                    .then(|| crate::relay::paseo::HOST.to_string()),
                live: if from_paseo_only {
                    client_reaches_leader(table, uid, session.pid)
                } else {
                    live
                },
                holder: None,
            }
        })
        .collect()
}

/// `config.toml` could not be read as text, or names `use_leader` in more
/// than one place, so one line cannot be rewritten with confidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ambiguous;

impl std::fmt::Display for Ambiguous {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Your Grok config.toml could not be updated safely; set `use_leader` under `[cli]` yourself.")
    }
}

/// Where `use_leader` is set in a `config.toml`: the line index and the
/// spelling (`use_leader` under `[cli]`, or a top-level `cli.use_leader`).
#[derive(Clone, Debug, PartialEq, Eq)]
enum UseLeaderLine {
    InTable(usize),
    Dotted(usize),
    /// A top-level inline table, `cli = { ... }`, on one line.
    Inline(usize),
}

/// Reads `use_leader` from `config.toml`'s text: `Some(true)` or
/// `Some(false)` when set, `None` when absent. `Err` when it is set more than
/// once or the `[cli]` table appears twice.
pub fn use_leader(text: &str) -> Result<Option<bool>, Ambiguous> {
    let lines: Vec<&str> = text.lines().collect();
    Ok(find_use_leader(&lines)?.and_then(|found| match found {
        UseLeaderLine::InTable(index) | UseLeaderLine::Dotted(index) => {
            Some(value_is_true(lines[index]))
        }
        UseLeaderLine::Inline(index) => inline_use_leader(lines[index]),
    }))
}

fn find_use_leader(lines: &[&str]) -> Result<Option<UseLeaderLine>, Ambiguous> {
    let mut found = Vec::new();
    let mut cli_headers = 0;
    let mut table: Option<String> = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if let Some(header) = table_header(trimmed) {
            if header == "cli" {
                cli_headers += 1;
            }
            table = Some(header);
            continue;
        }
        match table.as_deref() {
            None if key_of(trimmed) == Some("cli.use_leader") => {
                found.push(UseLeaderLine::Dotted(index))
            }
            // `cli = { ... }`: an inline table cannot be extended later by a
            // `[cli]` table, so it is edited in place, or refused when it
            // spans lines.
            None if key_of(trimmed) == Some("cli") => {
                if !inline_table_braces(trimmed) {
                    return Err(Ambiguous);
                }
                found.push(UseLeaderLine::Inline(index))
            }
            Some("cli") if key_of(trimmed) == Some("use_leader") => {
                found.push(UseLeaderLine::InTable(index))
            }
            _ => {}
        }
    }
    // An inline `cli` table beside a `[cli]` table defines `cli` twice.
    let inline = found
        .iter()
        .any(|line| matches!(line, UseLeaderLine::Inline(_)));
    if cli_headers > 1 || found.len() > 1 || (inline && cli_headers > 0) {
        return Err(Ambiguous);
    }
    Ok(found.pop())
}

/// `[name]` or `[[name]]` as `name`, for a line that opens a table.
fn table_header(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix('[')?;
    let (array, rest) = match rest.strip_prefix('[') {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let end = rest.find(']')?;
    let name = rest[..end].trim();
    let after = &rest[end + 1..];
    let after = if array {
        after.strip_prefix(']')?
    } else {
        after
    };
    let after = after.trim_start();
    (after.is_empty() || after.starts_with('#')).then(|| name.to_string())
}

/// The bare key of a `key = value` line; `None` for anything else.
fn key_of(trimmed: &str) -> Option<&str> {
    let (key, _) = trimmed.split_once('=')?;
    let key = key.trim();
    // A quoted key names the same setting: `"use_leader" = true`.
    let key = key
        .strip_prefix('"')
        .and_then(|k| k.strip_suffix('"'))
        .or_else(|| key.strip_prefix('\'').and_then(|k| k.strip_suffix('\'')))
        .unwrap_or(key);
    (!key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'))
    .then_some(key)
}

/// Whether a `cli = {...}` line holds its whole inline table: one `{` and
/// one `}` after the `=`, with nothing but whitespace or a comment after.
fn inline_table_braces(trimmed: &str) -> bool {
    let Some((_, value)) = trimmed.split_once('=') else {
        return false;
    };
    let value = value.trim_start();
    let Some(inner) = value.strip_prefix('{') else {
        return false;
    };
    let Some(end) = inner.find('}') else {
        return false;
    };
    let after = inner[end + 1..].trim_start();
    !inner[..end].contains(['{', '}']) && (after.is_empty() || after.starts_with('#'))
}

/// `use_leader` inside a one-line `cli = { ... }`: `Some(true|false)` when
/// set, `None` when absent.
fn inline_use_leader(line: &str) -> Option<bool> {
    let (_, value) = line.split_once('=')?;
    let inner = value.trim_start().strip_prefix('{')?;
    let inner = &inner[..inner.find('}')?];
    split_inline_entries(inner).into_iter().find_map(|entry| {
        let (key, value) = entry.split_once('=')?;
        (key_of(entry).is_some() && key_of(entry) == Some("use_leader") && !key.trim().is_empty())
            .then(|| value.trim() == "true")
    })
}

/// The entries of a one-line inline table body, split at the commas
/// outside quoted strings, each kept verbatim apart from surrounding
/// whitespace.
fn split_inline_entries(body: &str) -> Vec<&str> {
    let mut entries = Vec::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (index, c) in body.char_indices() {
        match quote {
            Some(q) => {
                if escaped {
                    escaped = false;
                } else if c == '\\' && q == '"' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' => quote = Some(c),
                ',' => {
                    entries.push(body[start..index].trim());
                    start = index + 1;
                }
                _ => {}
            },
        }
    }
    entries.push(body[start..].trim());
    entries
        .into_iter()
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// `line`, a one-line `cli = { ... }`, with `use_leader` set to `flag`:
/// replaced where present, else added first.
fn with_inline_use_leader(line: &str, flag: &str) -> String {
    let (head, value) = line.split_once('=').expect("an inline table line");
    let value = value.trim_start();
    let inner = &value[1..];
    let end = inner.find('}').expect("a closed inline table");
    let (body, tail) = (&inner[..end], &inner[end + 1..]);
    let entries: Vec<String> = split_inline_entries(body)
        .into_iter()
        .map(|entry| match entry.split_once('=') {
            Some((key, _)) if key_of(entry) == Some("use_leader") => {
                format!("{} = {flag}", key.trim())
            }
            _ => entry.to_string(),
        })
        .collect();
    let mut entries = entries;
    if !entries
        .iter()
        .any(|entry| key_of(entry) == Some("use_leader"))
    {
        entries.insert(0, format!("use_leader = {flag}"));
    }
    format!(
        "{} = {{ {} }}{}",
        head.trim_end(),
        entries.join(", "),
        tail.trim_end()
    )
}

/// The comment a `key = value` line ends with, including its `#`, when the
/// value is a bare word (as a boolean is); empty otherwise.
fn trailing_comment(line: &str) -> &str {
    let Some((_, value)) = line.split_once('=') else {
        return "";
    };
    match value.find('#') {
        Some(at) => value[at..].trim_end(),
        None => "",
    }
}

/// The line ending `text` uses, from its first line; `\n` when it has none.
fn line_ending(text: &str) -> &'static str {
    match text.find('\n') {
        Some(at) if at > 0 && text.as_bytes()[at - 1] == b'\r' => "\r\n",
        _ => "\n",
    }
}

/// Whether a `key = value` line's value is the TOML boolean `true`.
fn value_is_true(line: &str) -> bool {
    let Some((_, value)) = line.split_once('=') else {
        return false;
    };
    let value = value.split('#').next().unwrap_or("").trim();
    value == "true"
}

/// `text` with `use_leader` set to `enabled` under `[cli]`, changing only the
/// line that sets it (or adding one), so comments, order and every other
/// setting stay as they are. An absent key is only ever added when enabling;
/// Grok's default is off.
pub fn with_use_leader(text: &str, enabled: bool) -> Result<String, Ambiguous> {
    let ending = line_ending(text);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let found = find_use_leader(&lines.iter().map(String::as_str).collect::<Vec<_>>())?;
    let flag = if enabled { "true" } else { "false" };
    // The replaced line keeps its indentation, its key as spelled, and its
    // trailing comment; every other line keeps its bytes.
    let rewritten = |line: &str| {
        let key = line
            .split_once('=')
            .map(|(key, _)| key.trim())
            .unwrap_or("use_leader");
        let comment = trailing_comment(line);
        let comment = if comment.is_empty() {
            String::new()
        } else {
            format!(" {comment}")
        };
        format!("{}{key} = {flag}{comment}", indent_of(line))
    };
    match found {
        Some(UseLeaderLine::InTable(index)) | Some(UseLeaderLine::Dotted(index)) => {
            lines[index] = rewritten(&lines[index]);
        }
        Some(UseLeaderLine::Inline(index)) => {
            if !enabled && inline_use_leader(&lines[index]).is_none() {
                return Ok(text.to_string());
            }
            lines[index] = format!(
                "{}{}",
                indent_of(&lines[index]),
                with_inline_use_leader(lines[index].trim_start(), flag)
            );
        }
        None if !enabled => return Ok(text.to_string()),
        None => {
            let header = lines
                .iter()
                .position(|line| table_header(line.trim_start()).as_deref() == Some("cli"));
            match header {
                Some(index) => lines.insert(index + 1, "use_leader = true".to_string()),
                None => {
                    if lines.last().is_some_and(|line| !line.trim().is_empty()) {
                        lines.push(String::new());
                    }
                    lines.push("[cli]".to_string());
                    lines.push("use_leader = true".to_string());
                }
            }
        }
    }
    let mut updated = lines.join(ending);
    updated.push_str(ending);
    Ok(updated)
}

fn indent_of(line: &str) -> &str {
    &line[..line.len() - line.trim_start().len()]
}

/// The user's Grok `config.toml`, served as the `grok_leader` setting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrokSettings {
    pub config: GrokConfig,
}

impl GrokSettings {
    pub fn new(config: &GrokConfig) -> GrokSettings {
        GrokSettings {
            config: config.clone(),
        }
    }

    /// Whether the user's config turns leader mode on. Unreadable or
    /// ambiguous files read as off.
    pub fn leader_enabled(&self) -> bool {
        std::fs::read_to_string(self.config.config_file())
            .ok()
            .and_then(|text| use_leader(&text).ok().flatten())
            .unwrap_or(false)
    }

    /// Sets `[cli] use_leader` in the user's config. A file already as asked
    /// is not rewritten. Sessions Grok opens afterwards run on the shared
    /// leader; ones already open keep running as they are.
    pub fn set_leader(&self, enabled: bool) -> Result<(), String> {
        let path = resolve_symlinks(&self.config.config_file());
        let existing = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("Could not read your Grok config: {e}")),
        };
        let text = match &existing {
            Some(bytes) => String::from_utf8(bytes.clone()).map_err(|_| Ambiguous.to_string())?,
            None => String::new(),
        };
        let current = use_leader(&text).map_err(|e| e.to_string())?;
        if current.unwrap_or(false) == enabled {
            return Ok(());
        }
        let updated = with_use_leader(&text, enabled).map_err(|e| e.to_string())?;
        write_keeping_file(
            &path,
            existing.as_deref(),
            updated.as_bytes(),
            // A new config is private: Grok's can come to hold MCP
            // credentials in `[mcp_servers.*.env]`.
            BACKUP_SUFFIX,
            0o600,
        )
        .map_err(|e| format!("Could not save your Grok config: {e}"))
    }
}

impl SettingsExtension for GrokSettings {
    /// Leader mode is on by default wherever Grok is installed: only a Grok
    /// session on its shared leader can be listed and messaged. A config that
    /// already sets `use_leader` either way, or cannot be read safely, is the
    /// person's choice and is left alone.
    fn default_on(&self) -> Vec<&'static str> {
        let unset = match std::fs::read_to_string(self.config.config_file()) {
            Ok(text) => matches!(use_leader(&text), Ok(None)),
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        };
        if self.config.installed() && unset {
            vec![SETTING]
        } else {
            Vec::new()
        }
    }

    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        if self.config.installed() {
            settings.insert(SETTING.into(), Value::Bool(self.leader_enabled()));
        }
        settings
    }

    fn refuse(&self, key: &str, _value: &Value) -> Option<String> {
        (key == SETTING)
            .then(|| platform::unsupported("Grok"))
            .flatten()
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        if let Some(reason) = self.refuse(key, value) {
            return Some(Err(reason));
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        Some(self.set_leader(enabled))
    }
}

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;
    use crate::relay::process::FakeProcesses;

    #[test]
    fn grok_is_not_offered_or_listed_on_windows() {
        let root = tempfile::tempdir().unwrap();
        let config = GrokConfig {
            home: root.path().to_path_buf(),
        };
        let settings = GrokSettings::new(&config);
        assert!(settings.get().is_empty());
        assert!(settings.default_on().is_empty());
        assert_eq!(
            settings.set(SETTING, &Value::Bool(true)),
            Some(Err("Grok is not available on Windows.".into()))
        );
        let table = FakeProcesses::default();
        assert!(discover(&config, &table, 0, true, &|_| false).is_empty());
        assert!(open_sessions(&config, &table, 0).is_empty());
    }
}

// Its fixtures assume Grok runs here, as it does only on Unix.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};

    const SESSION: &str = "01a1136e-00f9-7d10-ba21-5579ce7a4d08";
    const OTHER: &str = "01a1136e-3958-7fe2-ab01-1db35ad55f8f";

    fn config(root: &Path) -> GrokConfig {
        GrokConfig {
            home: root.join(".grok"),
        }
    }

    #[test]
    fn leader_mode_defaults_on_only_where_grok_has_no_choice_recorded() {
        let temp = tempfile::tempdir().unwrap();
        let settings = GrokSettings::new(&config(temp.path()));
        // Grok not installed: nothing to turn on.
        assert!(settings.default_on().is_empty());
        std::fs::create_dir_all(temp.path().join(".grok")).unwrap();
        assert_eq!(settings.default_on(), vec![SETTING]);
        let file = temp.path().join(".grok/config.toml");
        std::fs::write(&file, "[ui]\ntheme = \"dark\"\n").unwrap();
        assert_eq!(settings.default_on(), vec![SETTING]);
        // An explicit choice either way is the person's, as is a file that
        // cannot be read safely.
        for text in [
            "[cli]\nuse_leader = false\n",
            "[cli]\nuse_leader = true\n",
            "[cli]\nuse_leader = true\n[cli]\nuse_leader = false\n",
        ] {
            std::fs::write(&file, text).unwrap();
            assert!(settings.default_on().is_empty(), "{text}");
        }
    }

    fn registry(root: &Path, records: Value) {
        let config = config(root);
        std::fs::create_dir_all(&config.home).unwrap();
        std::fs::write(config.active_sessions(), records.to_string()).unwrap();
    }

    #[test]
    fn grok_home_follows_the_environment() {
        let home = Path::new("/home/me");
        assert_eq!(
            GrokConfig::from_env(&|_| None, home).home,
            PathBuf::from("/home/me/.grok")
        );
        let custom = |key: &str| (key == "GROK_HOME").then(|| " ~/grok-alt ".to_string());
        assert_eq!(
            GrokConfig::from_env(&custom, home).home,
            PathBuf::from("/home/me/grok-alt")
        );
        let blank = |key: &str| (key == "GROK_HOME").then(|| "  ".to_string());
        assert_eq!(
            GrokConfig::from_env(&blank, home).home,
            PathBuf::from("/home/me/.grok")
        );
        assert_eq!(
            config(home).default_leader_socket(),
            PathBuf::from("/home/me/.grok/leader.sock")
        );
    }

    #[test]
    fn session_directories_are_percent_encoded_like_groks() {
        assert_eq!(
            config(Path::new("/home/me")).session_dir("/home/me/Projects/x y", SESSION),
            PathBuf::from(format!(
                "/home/me/.grok/sessions/%2Fhome%2Fme%2FProjects%2Fx%20y/{SESSION}"
            ))
        );
    }

    #[test]
    fn the_registry_is_read_leniently() {
        let records = serde_json::json!([
            {"session_id": SESSION, "pid": 4242, "cwd": "/w/api", "opened_at": "2026-10-06T22:55:38.848904269Z"},
            {"session_id": "not-a-uuid", "pid": 1},
            {"session_id": OTHER, "pid": 0},
            {"session_id": OTHER, "pid": 7, "extra": true},
            "junk"
        ]);
        let decoded = decode_active_sessions(records.to_string().as_bytes());
        assert_eq!(
            decoded,
            vec![
                ActiveSession {
                    session_id: SESSION.into(),
                    pid: 4242,
                    cwd: Some("/w/api".into()),
                    opened_at_ms: Some(1_791_327_338_848),
                },
                ActiveSession {
                    session_id: OTHER.into(),
                    pid: 7,
                    cwd: None,
                    opened_at_ms: None,
                },
            ]
        );
        assert!(decode_active_sessions(b"{}").is_empty());
        assert!(decode_active_sessions(b"garbage").is_empty());
    }

    #[test]
    fn only_this_users_live_processes_are_sessions() {
        let temp = tempfile::tempdir().unwrap();
        registry(
            temp.path(),
            serde_json::json!([
                {"session_id": SESSION, "pid": 100, "cwd": "/w/api"},
                {"session_id": OTHER, "pid": 200, "cwd": "/w/other"},
                {"session_id": "01a1136e-aaaa-7fe2-ab01-1db35ad55f8f", "pid": 300, "cwd": "/w/gone"},
            ]),
        );
        let table = FakeProcesses::default();
        table.insert(
            100,
            FakeProcess {
                uid: 501,
                executable: Some("/home/me/.grok/bin/grok-1.0.46".into()),
                ..FakeProcess::default()
            },
        );
        table.insert(
            200,
            FakeProcess {
                uid: 502,
                executable: Some("/home/me/.grok/bin/grok".into()),
                ..FakeProcess::default()
            },
        );
        // A recycled pid now running something else is a stale record.
        table.insert(
            300,
            FakeProcess {
                uid: 501,
                executable: Some("/usr/bin/sleep".into()),
                ..FakeProcess::default()
            },
        );
        let found = discover(&config(temp.path()), &table, 501, true, &|_| false);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].target, Target::new(SessionKind::GrokOpen, SESSION));
        assert_eq!(found[0].title, "api");
        assert_eq!(found[0].directory.as_deref(), Some("/w/api"));
        assert!(found[0].live);
        // Without a leader the row is shown but not deliverable.
        let found = discover(&config(temp.path()), &table, 501, false, &|_| false);
        assert!(!found[0].live);
        // A session already listed from its binding is not listed twice.
        assert!(discover(&config(temp.path()), &table, 501, true, &|id| id == SESSION).is_empty());
    }

    #[test]
    fn a_paseo_stdio_grok_is_listed_and_a_grok_outside_paseo_is_not() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let cwd = temp.path().join("cloud");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.to_string_lossy().to_string();
        let agent = "b90723ba-d4a3-4a9e-986d-a08ee7400fc4";
        std::fs::create_dir_all(config.session_dir(&cwd, SESSION)).unwrap();
        let record = temp
            .path()
            .join("paseo/agents/cloud")
            .join(format!("{agent}.json"));
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(
            &record,
            serde_json::json!({
                "provider": "grok",
                "cwd": cwd,
                "title": "ping",
                "runtimeInfo": {"provider": "grok", "sessionId": SESSION},
                "persistence": {"provider": "grok", "sessionId": SESSION},
            })
            .to_string(),
        )
        .unwrap();
        let helper = "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
        let table = FakeProcesses::default();
        table.insert(
            10,
            FakeProcess {
                parent: 1,
                uid: 501,
                executable: Some(helper.into()),
                ..FakeProcess::default()
            },
        );
        table.insert(
            30,
            FakeProcess {
                parent: 10,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec![
                    "grok".into(),
                    "agent".into(),
                    "--no-leader".into(),
                    "stdio".into(),
                ],
                environment: std::collections::HashMap::from([
                    (
                        "PASEO_HOME".into(),
                        temp.path().join("paseo").display().to_string(),
                    ),
                    ("PASEO_AGENT_ID".into(), agent.into()),
                    ("PASEO_AGENT_CWD".into(), cwd.clone()),
                    ("HOME".into(), temp.path().display().to_string()),
                ]),
                ..FakeProcess::default()
            },
        );
        // The same command outside Paseo is not a hosted session.
        table.insert(
            40,
            FakeProcess {
                parent: 1,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec!["grok".into(), "agent".into(), "stdio".into()],
                environment: std::collections::HashMap::from([
                    (
                        "PASEO_HOME".into(),
                        temp.path().join("paseo").display().to_string(),
                    ),
                    ("PASEO_AGENT_ID".into(), agent.into()),
                    ("PASEO_AGENT_CWD".into(), cwd.clone()),
                ]),
                ..FakeProcess::default()
            },
        );
        let found = discover(&config, &table, 501, true, &|_| false);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].target, Target::new(SessionKind::GrokOpen, SESSION));
        assert_eq!(found[0].host.as_deref(), Some("paseo"));
        assert_eq!(found[0].directory.as_deref(), Some(cwd.as_str()));
        // `--no-leader` is listed and is not deliverable, even while the
        // caller says a leader of this user is running.
        assert!(!found[0].live);
        assert!(open_sessions(&config, &table, 501).is_empty());
        assert!(paseo_unbindable(&config, &table, 501, SESSION)
            .unwrap()
            .contains("without a shared leader"));
        // A tool that is itself `grok agent stdio` inherits the agent's
        // environment. It must not keep the session after the client exits.
        table.insert(
            32,
            FakeProcess {
                parent: 30,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec!["grok".into(), "agent".into(), "stdio".into()],
                environment: std::collections::HashMap::from([
                    (
                        "PASEO_HOME".into(),
                        temp.path().join("paseo").display().to_string(),
                    ),
                    ("PASEO_AGENT_ID".into(), agent.into()),
                    ("PASEO_AGENT_CWD".into(), cwd.clone()),
                    ("HOME".into(), temp.path().display().to_string()),
                ]),
                ..FakeProcess::default()
            },
        );
        table.remove(30);
        assert!(discover(&config, &table, 501, true, &|_| false).is_empty());
        table.insert(
            30,
            FakeProcess {
                parent: 10,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec![
                    "grok".into(),
                    "agent".into(),
                    "--no-leader".into(),
                    "stdio".into(),
                ],
                environment: std::collections::HashMap::from([
                    (
                        "PASEO_HOME".into(),
                        temp.path().join("paseo").display().to_string(),
                    ),
                    ("PASEO_AGENT_ID".into(), agent.into()),
                    ("PASEO_AGENT_CWD".into(), cwd.clone()),
                    ("HOME".into(), temp.path().display().to_string()),
                ]),
                ..FakeProcess::default()
            },
        );
        // No session directory means Paseo's record is not a Grok session.
        std::fs::remove_dir_all(config.session_dir(&cwd, SESSION)).unwrap();
        assert!(discover(&config, &table, 501, true, &|_| false).is_empty());
    }

    #[test]
    fn a_paseo_stdio_client_is_deliverable_only_on_the_leader_it_uses() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let cwd = temp.path().join("cloud");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.to_string_lossy().to_string();
        let agent = "b90723ba-d4a3-4a9e-986d-a08ee7400fc4";
        let other_agent = "0de8f33e-9eb1-482e-843f-99c13d367757";
        std::fs::create_dir_all(config.session_dir(&cwd, SESSION)).unwrap();
        std::fs::create_dir_all(config.session_dir(&cwd, OTHER)).unwrap();
        for (id, session) in [(agent, SESSION), (other_agent, OTHER)] {
            let record = temp
                .path()
                .join("paseo/agents/cloud")
                .join(format!("{id}.json"));
            std::fs::create_dir_all(record.parent().unwrap()).unwrap();
            std::fs::write(
                &record,
                serde_json::json!({
                    "provider": "grok",
                    "cwd": cwd,
                    "runtimeInfo": {"sessionId": session},
                    "persistence": {"sessionId": session},
                })
                .to_string(),
            )
            .unwrap();
        }
        let helper = "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
        let table = FakeProcesses::default();
        table.insert(
            10,
            FakeProcess {
                parent: 1,
                uid: 501,
                executable: Some(helper.into()),
                ..FakeProcess::default()
            },
        );
        let home = temp.path().display().to_string();
        table.insert(
            20,
            FakeProcess {
                parent: 1,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec!["grok".into(), "agent".into(), "leader".into()],
                environment: std::collections::HashMap::from([("HOME".into(), home.clone())]),
                ..FakeProcess::default()
            },
        );
        // A different home's leader must not make this client deliverable.
        table.insert(
            21,
            FakeProcess {
                parent: 1,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec!["grok".into(), "agent".into(), "leader".into()],
                environment: std::collections::HashMap::from([(
                    "HOME".into(),
                    "/Users/someone-else".into(),
                )]),
                ..FakeProcess::default()
            },
        );
        table.insert(
            30,
            FakeProcess {
                parent: 10,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec!["grok".into(), "agent".into(), "stdio".into()],
                environment: std::collections::HashMap::from([
                    (
                        "PASEO_HOME".into(),
                        temp.path().join("paseo").display().to_string(),
                    ),
                    ("PASEO_AGENT_ID".into(), agent.into()),
                    ("PASEO_AGENT_CWD".into(), cwd.clone()),
                    ("HOME".into(), home.clone()),
                ]),
                ..FakeProcess::default()
            },
        );
        table.insert(
            31,
            FakeProcess {
                parent: 10,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec![
                    "grok".into(),
                    "agent".into(),
                    "--no-leader".into(),
                    "stdio".into(),
                ],
                environment: std::collections::HashMap::from([
                    (
                        "PASEO_HOME".into(),
                        temp.path().join("paseo").display().to_string(),
                    ),
                    ("PASEO_AGENT_ID".into(), other_agent.into()),
                    ("PASEO_AGENT_CWD".into(), cwd.clone()),
                    ("HOME".into(), home),
                ]),
                ..FakeProcess::default()
            },
        );
        let found = discover(&config, &table, 501, false, &|_| false);
        let attached = found
            .iter()
            .find(|row| row.target.id == SESSION)
            .expect("attached client");
        assert!(attached.live);
        assert_eq!(attached.host.as_deref(), Some("paseo"));
        let detached = found
            .iter()
            .find(|row| row.target.id == OTHER)
            .expect("detached client");
        assert!(!detached.live);
        let open = open_sessions(&config, &table, 501);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].session_id, SESSION);
        assert_eq!(paseo_unbindable(&config, &table, 501, SESSION), None);
        assert!(paseo_unbindable(&config, &table, 501, OTHER)
            .unwrap()
            .contains("without a shared leader"));
        // The attached client's socket is its own leader.sock, not the
        // other home's.
        let socket = temp.path().join(".grok/leader.sock");
        assert_eq!(attached_leader_socket(&table, 30), Some(socket.clone()));
        assert_eq!(attached_leader_socket(&table, 31), None);
        // A TUI that passes `--no-leader` still prefers its own home. Paseo
        // clients with that flag never reach this preference.
        assert_eq!(preferred_leader_socket(&table, 31), Some(socket.clone()));
        assert_eq!(
            paseo_delivery_block(&config, &table, 501, SESSION, &socket),
            None
        );
        assert!(paseo_delivery_block(&config, &table, 501, OTHER, &socket)
            .unwrap()
            .contains("without a shared leader"));
        assert!(
            paseo_delivery_block(&config, &table, 501, SESSION, Path::new("/other.sock"))
                .unwrap()
                .contains("different leader")
        );
        assert_eq!(
            paseo_delivery_block(
                &config,
                &table,
                501,
                "01a1136e-aaaa-7fe2-ab01-1db35ad55f8f",
                &socket
            ),
            None
        );
    }

    #[test]
    fn a_paseo_session_is_read_from_the_clients_grok_home() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let cwd = "/work/cloud";
        let agent = "b90723ba-d4a3-4a9e-986d-a08ee7400fc4";
        let alt = temp.path().join("work-grok");
        let store = GrokConfig { home: alt.clone() };
        std::fs::create_dir_all(store.session_dir(cwd, SESSION)).unwrap();
        std::fs::write(
            store.session_dir(cwd, SESSION).join("summary.json"),
            serde_json::json!({"generated_title": "From the client home"}).to_string(),
        )
        .unwrap();
        // The probe's own home has no copy of this session.
        let record = temp
            .path()
            .join("paseo/agents/cloud")
            .join(format!("{agent}.json"));
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(
            &record,
            serde_json::json!({
                "provider": "grok",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": SESSION},
            })
            .to_string(),
        )
        .unwrap();
        let helper = "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
        let table = FakeProcesses::default();
        table.insert(
            10,
            FakeProcess {
                parent: 1,
                uid: 501,
                executable: Some(helper.into()),
                ..FakeProcess::default()
            },
        );
        table.insert(
            30,
            FakeProcess {
                parent: 10,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec!["grok".into(), "agent".into(), "stdio".into()],
                environment: std::collections::HashMap::from([
                    (
                        "PASEO_HOME".into(),
                        temp.path().join("paseo").display().to_string(),
                    ),
                    ("PASEO_AGENT_ID".into(), agent.into()),
                    ("PASEO_AGENT_CWD".into(), cwd.into()),
                    ("GROK_HOME".into(), alt.display().to_string()),
                    ("HOME".into(), temp.path().display().to_string()),
                ]),
                ..FakeProcess::default()
            },
        );
        let found = discover(&config, &table, 501, false, &|_| false);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "From the client home");
        // A session that exists only in the probe's home is not this client's.
        std::fs::remove_dir_all(&alt).unwrap();
        std::fs::create_dir_all(config.session_dir(cwd, SESSION)).unwrap();
        assert!(discover(&config, &table, 501, false, &|_| false).is_empty());
    }

    #[test]
    fn a_root_directory_paseo_session_is_listed() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let agent = "b90723ba-d4a3-4a9e-986d-a08ee7400fc4";
        std::fs::create_dir_all(config.session_dir("/", SESSION)).unwrap();
        let record = temp
            .path()
            .join("paseo/agents/root")
            .join(format!("{agent}.json"));
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(
            &record,
            serde_json::json!({
                "provider": "grok",
                "cwd": "/",
                "runtimeInfo": {"sessionId": SESSION},
            })
            .to_string(),
        )
        .unwrap();
        let helper = "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
        let table = FakeProcesses::default();
        table.insert(
            10,
            FakeProcess {
                parent: 1,
                uid: 501,
                executable: Some(helper.into()),
                ..FakeProcess::default()
            },
        );
        table.insert(
            30,
            FakeProcess {
                parent: 10,
                uid: 501,
                executable: Some("/Users/me/.local/bin/grok".into()),
                arguments: vec!["grok".into(), "agent".into(), "stdio".into()],
                environment: std::collections::HashMap::from([
                    (
                        "PASEO_HOME".into(),
                        temp.path().join("paseo").display().to_string(),
                    ),
                    ("PASEO_AGENT_ID".into(), agent.into()),
                    ("PASEO_AGENT_CWD".into(), "/".into()),
                    ("HOME".into(), temp.path().display().to_string()),
                ]),
                ..FakeProcess::default()
            },
        );
        let found = discover(&config, &table, 501, false, &|_| false);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].directory.as_deref(), Some("/"));
        assert_eq!(found[0].target.id, SESSION);
    }

    #[test]
    fn native_titles_reject_wrong_identity_and_invalid_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let cwd = "/work/project";
        let dir = config.session_dir(cwd, SESSION);
        std::fs::create_dir_all(&dir).unwrap();
        let summary = dir.join("summary.json");
        for value in [
            serde_json::json!({"info":{"id":OTHER,"cwd":cwd},"generated_title":"Wrong session"}),
            serde_json::json!({"info":{"id":SESSION,"cwd":"/elsewhere"},"generated_title":"Wrong folder"}),
            serde_json::json!({"generated_title":"Bad\nline"}),
            serde_json::json!({"generated_title":"x".repeat(201)}),
        ] {
            std::fs::write(&summary, value.to_string()).unwrap();
            assert_eq!(native_title(&config, cwd, SESSION), None);
        }
        std::fs::write(&summary, "{".repeat(1024 * 1024 + 1)).unwrap();
        assert_eq!(native_title(&config, cwd, SESSION), None);
        std::fs::write(&summary, "invalid json").unwrap();
        assert_eq!(native_title(&config, cwd, SESSION), None);
        assert_eq!(native_title(&config, cwd, "../other"), None);
    }

    #[test]
    fn the_title_prefers_groks_generated_one() {
        let temp = tempfile::tempdir().unwrap();
        registry(
            temp.path(),
            serde_json::json!([{"session_id": SESSION, "pid": 100, "cwd": "/w/api"}]),
        );
        let config = config(temp.path());
        let dir = config.session_dir("/w/api", SESSION);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("summary.json"),
            serde_json::json!({"generated_title": " Fix the login bug "}).to_string(),
        )
        .unwrap();
        let table = FakeProcesses::default();
        table.insert(
            100,
            FakeProcess {
                uid: 501,
                executable: Some("/home/me/.grok/bin/grok".into()),
                ..FakeProcess::default()
            },
        );
        let found = discover(&config, &table, 501, true, &|_| false);
        assert_eq!(found[0].title, "Fix the login bug");
    }

    #[test]
    fn use_leader_is_read_from_the_cli_table_or_a_dotted_key() {
        assert_eq!(use_leader(""), Ok(None));
        assert_eq!(use_leader("[cli]\nuse_leader = true\n"), Ok(Some(true)));
        assert_eq!(
            use_leader("[cli]\n  use_leader = false # off\n"),
            Ok(Some(false))
        );
        assert_eq!(use_leader("cli.use_leader = true\n[ui]\n"), Ok(Some(true)));
        // The same key in another table, or a dotted key after a header,
        // is not this setting.
        assert_eq!(use_leader("[ui]\nuse_leader = true\n"), Ok(None));
        assert_eq!(use_leader("[cli.other]\nuse_leader = true\n"), Ok(None));
        assert_eq!(use_leader("[ui]\ncli.use_leader = true\n"), Ok(None));
        assert_eq!(
            use_leader("[cli]\nuse_leader = true\n[ui]\n[cli]\n"),
            Err(Ambiguous)
        );
        assert_eq!(
            use_leader("cli.use_leader = true\n[cli]\nuse_leader = false\n"),
            Err(Ambiguous)
        );
    }

    #[test]
    fn enabling_changes_one_line_and_keeps_the_rest() {
        let text = "[marketplace]\nname = \"x\"\n\n[[marketplace.sources]]\nname = \"xAI\"\n\n[cli]\ninstaller = \"npm\"\nauto_update = true\n\n[ui]\nyolo = false\n\n[mcp_servers.agent-relay.env]\nRELAY_API_KEY = \"secret\"\n";
        let updated = with_use_leader(text, true).unwrap();
        assert_eq!(
            updated,
            "[marketplace]\nname = \"x\"\n\n[[marketplace.sources]]\nname = \"xAI\"\n\n[cli]\nuse_leader = true\ninstaller = \"npm\"\nauto_update = true\n\n[ui]\nyolo = false\n\n[mcp_servers.agent-relay.env]\nRELAY_API_KEY = \"secret\"\n"
        );
        assert_eq!(use_leader(&updated), Ok(Some(true)));
        let disabled = with_use_leader(&updated, false).unwrap();
        assert_eq!(
            disabled,
            updated.replace("use_leader = true", "use_leader = false")
        );
        // An existing line keeps its indentation, its comment and its key
        // as spelled; a CRLF file stays CRLF.
        assert_eq!(
            with_use_leader("[cli]\n  use_leader = false # was off\n", true).unwrap(),
            "[cli]\n  use_leader = true # was off\n"
        );
        assert_eq!(
            with_use_leader("[cli]\r\nuse_leader = false # keep\r\n[ui]\r\n", true).unwrap(),
            "[cli]\r\nuse_leader = true # keep\r\n[ui]\r\n"
        );
        assert_eq!(use_leader("[cli]\n\"use_leader\" = true\n"), Ok(Some(true)));
        assert_eq!(
            with_use_leader("[cli]\n\"use_leader\" = false\n", true).unwrap(),
            "[cli]\n\"use_leader\" = true\n"
        );
        assert_eq!(
            with_use_leader("cli.use_leader = false\n", true).unwrap(),
            "cli.use_leader = true\n"
        );
    }

    #[test]
    fn an_inline_cli_table_is_edited_in_place_never_shadowed() {
        // A later `[cli]` table would make the file invalid TOML.
        assert_eq!(use_leader("cli = { use_leader = true }\n"), Ok(Some(true)));
        assert_eq!(use_leader("cli = { installer = \"npm\" }\n"), Ok(None));
        assert_eq!(
            with_use_leader(
                "cli = { installer = \"npm\", use_leader = false } # x\n[ui]\n",
                true
            )
            .unwrap(),
            "cli = { installer = \"npm\", use_leader = true } # x\n[ui]\n"
        );
        assert_eq!(
            with_use_leader("  cli = { installer = \"npm\" }\n", true).unwrap(),
            "  cli = { use_leader = true, installer = \"npm\" }\n"
        );
        assert_eq!(
            with_use_leader("cli = {}\n", true).unwrap(),
            "cli = { use_leader = true }\n"
        );
        // Quoted values keep their commas; nothing else is touched.
        assert_eq!(
            with_use_leader("cli = { label = \"a,b\", other = 'x, y' }\n", true).unwrap(),
            "cli = { use_leader = true, label = \"a,b\", other = 'x, y' }\n"
        );
        assert_eq!(
            with_use_leader("cli = { label = \"a,b\", use_leader = false }\n", true).unwrap(),
            "cli = { label = \"a,b\", use_leader = true }\n"
        );
        assert_eq!(
            use_leader("cli = { label = \"x,use_leader = true\" }\n"),
            Ok(None)
        );
        assert_eq!(
            with_use_leader("cli = { installer = \"npm\" }\n", false).unwrap(),
            "cli = { installer = \"npm\" }\n"
        );
        // An inline table spanning lines, or one beside a `[cli]` table, is
        // left alone.
        assert_eq!(
            use_leader("cli = {\n  use_leader = true\n}\n"),
            Err(Ambiguous)
        );
        assert_eq!(
            use_leader("cli = { use_leader = true }\n[cli]\n"),
            Err(Ambiguous)
        );
    }

    #[test]
    fn a_missing_table_is_appended_and_disabling_an_absent_key_writes_nothing() {
        assert_eq!(
            with_use_leader("[ui]\nyolo = false\n", true).unwrap(),
            "[ui]\nyolo = false\n\n[cli]\nuse_leader = true\n"
        );
        assert_eq!(
            with_use_leader("", true).unwrap(),
            "[cli]\nuse_leader = true\n"
        );
        assert_eq!(
            with_use_leader("[ui]\nyolo = false\n", false).unwrap(),
            "[ui]\nyolo = false\n"
        );
        assert_eq!(
            with_use_leader("[cli]\n[ui]\n[cli]\n", true),
            Err(Ambiguous)
        );
    }

    #[test]
    fn the_setting_is_served_only_where_grok_has_run() {
        let temp = tempfile::tempdir().unwrap();
        let settings = GrokSettings::new(&config(temp.path()));
        assert!(settings.get().is_empty());
        assert_eq!(settings.set("direct_delivery", &Value::Bool(true)), None);
        std::fs::create_dir_all(&settings.config.home).unwrap();
        assert_eq!(settings.get()[SETTING], Value::Bool(false));
        assert_eq!(
            settings.set(SETTING, &Value::String("yes".into())),
            Some(Err("grok_leader must be true or false.".into()))
        );
        assert_eq!(settings.set(SETTING, &Value::Bool(true)), Some(Ok(())));
        assert_eq!(
            std::fs::read_to_string(settings.config.config_file()).unwrap(),
            "[cli]\nuse_leader = true\n"
        );
        assert_eq!(settings.get()[SETTING], Value::Bool(true));
        // Already as asked: not rewritten, so no backup appears.
        assert_eq!(settings.set(SETTING, &Value::Bool(true)), Some(Ok(())));
        assert!(!settings
            .config
            .home
            .join("config.toml.relay-desktop-backup")
            .exists());
        assert_eq!(settings.set(SETTING, &Value::Bool(false)), Some(Ok(())));
        assert_eq!(settings.get()[SETTING], Value::Bool(false));
        assert_eq!(
            std::fs::read_to_string(settings.config.config_file()).unwrap(),
            "[cli]\nuse_leader = false\n"
        );
        assert_eq!(
            std::fs::read_to_string(
                settings
                    .config
                    .home
                    .join("config.toml.relay-desktop-backup")
            )
            .unwrap(),
            "[cli]\nuse_leader = true\n"
        );
    }

    #[test]
    fn an_ambiguous_config_is_left_alone() {
        let temp = tempfile::tempdir().unwrap();
        let settings = GrokSettings::new(&config(temp.path()));
        std::fs::create_dir_all(&settings.config.home).unwrap();
        let text = "[cli]\nuse_leader = true\n[ui]\n[cli]\n";
        std::fs::write(settings.config.config_file(), text).unwrap();
        assert!(!settings.leader_enabled());
        let outcome = settings.set(SETTING, &Value::Bool(true)).unwrap();
        assert!(outcome.unwrap_err().contains("could not be updated safely"));
        assert_eq!(
            std::fs::read_to_string(settings.config.config_file()).unwrap(),
            text
        );
    }
}
