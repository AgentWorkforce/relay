//! OpenCode on this computer: the plugin that makes a plain `opencode` TUI
//! reachable, the per-process registry it keeps, and its setting.
//!
//! - **Why a plugin.** A plain OpenCode TUI runs its server in a worker over
//!   an in-process fetch and opens no port; it listens only when started
//!   with explicit server flags. OpenCode loads every `*.js` file in
//!   `<config>/plugins/` into every process it starts, TUI included. The
//!   bundled module supports the V1 hook API and the V2 plugin API.
//! - **The plugin.** `agent-relay.js` listens on `<runtime>/<pid>.sock`, a
//!   Unix socket in a directory only this user can enter, and records the
//!   top-level sessions its process holds in `<runtime>/<pid>.json`. The
//!   socket answers only what delivery needs, for those sessions only: the
//!   status, one session, its messages, one message, and `prompt_async` with
//!   a `msg_relay_` id and one text part. See `opencode/agent-relay.js`.
//! - **The route.** `opencode_existing` delivers over that socket with the
//!   same deterministic message id, durable journal and correlated-assistant
//!   receipt as the managed route. Before every request it proves the pid,
//!   its start time, uid and executable, the socket's directory, owner and
//!   inode, and, on the connected socket, that the kernel's peer is that
//!   pid and this user.
//! - **The setting.** `OpenCodeSettings` serves `opencode_plugin`: on writes
//!   the plugin file, off removes it. Only a file carrying the plugin's
//!   marker is ever rewritten or removed; any other file at that name is kept
//!   as a backup first and put back when the setting goes off.
//!
//! Processes are read through a `ProcessTable`, so tests never start
//! OpenCode.

pub mod managed;

use crate::relay::agents::SettingsExtension;
use crate::relay::claude_settings::write_keeping_file;
use crate::relay::existing_session::platform::{self, FileTypeExt, MetadataExt};
use crate::relay::opencode_existing::{self, Binding};
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{SessionKind, Target};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The `settings.get` key for the plugin.
pub const SETTING: &str = "opencode_plugin";

/// Bumped whenever the plugin's behavior changes; turning the setting on
/// again rewrites an older copy.
pub const PLUGIN_VERSION: u32 = 7;

/// The line every copy of the plugin carries, so only our file is replaced
/// or removed.
const PLUGIN_MARKER: &str = "AGENT_RELAY_OPENCODE_PLUGIN=";

const PLUGIN_FILE: &str = "agent-relay.js";

/// Kept beside a file of someone else's that had the plugin's name.
const BACKUP_SUFFIX: &str = ".relay-desktop-backup";

/// Left beside the plugin when the person turns it off, so the choice is
/// recorded in OpenCode's own directory and the plugin is not turned on by
/// default again. OpenCode loads only `*.js` and `*.ts`, so it ignores it.
const OFF_SUFFIX: &str = ".off";

const PLUGIN_SOURCE: &str = include_str!("opencode/agent-relay.js");

/// The prefix of the reference an open OpenCode agent is pinned to.
const ROUTE_PREFIX: &str = "opencode-plugin:";

/// Where OpenCode keeps its configuration and data, and where its plugin
/// listens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenCodeConfig {
    /// `<XDG_CONFIG_HOME, else ~/.config>/opencode`: OpenCode's global
    /// config directory, whose `plugins/` it loads into every process.
    pub config_dir: PathBuf,
    /// `<XDG_DATA_HOME, else ~/.local/share>/opencode`.
    pub data_dir: PathBuf,
    /// `~/.agentworkforce/desktop/opencode`: the plugin's sockets and
    /// records. Short on purpose, as a Unix socket path is limited to 104
    /// bytes on macOS.
    pub runtime: PathBuf,
}

impl OpenCodeConfig {
    /// Reads `XDG_CONFIG_HOME` and `XDG_DATA_HOME` from `env`; `home` is the
    /// user's home directory. OpenCode uses the XDG layout on macOS too.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> OpenCodeConfig {
        let base = |key: &str, default: &[&str]| {
            env(key)
                .map(|value| value.trim().to_string())
                .filter(|value| value.starts_with('/'))
                .map(PathBuf::from)
                .unwrap_or_else(|| default.iter().fold(home.to_path_buf(), |p, c| p.join(c)))
        };
        OpenCodeConfig {
            config_dir: base("XDG_CONFIG_HOME", &[".config"]).join("opencode"),
            data_dir: base("XDG_DATA_HOME", &[".local", "share"]).join("opencode"),
            runtime: home
                .join(".agentworkforce")
                .join("desktop")
                .join("opencode"),
        }
    }

    /// Whether OpenCode has run for this user. Never on Windows: the plugin
    /// listens on a Unix socket, so neither its setting nor its sessions
    /// exist there.
    pub fn installed(&self) -> bool {
        platform::SUPPORTED && (self.config_dir.is_dir() || self.data_dir.is_dir())
    }

    /// The plugin file in OpenCode's global plugin directory.
    pub fn plugin_file(&self) -> PathBuf {
        self.config_dir.join("plugins").join(PLUGIN_FILE)
    }

    /// The opt-out marker turning the plugin off leaves.
    pub fn off_marker(&self) -> PathBuf {
        let mut path = self.plugin_file().into_os_string();
        path.push(OFF_SUFFIX);
        PathBuf::from(path)
    }

    /// The plugin as written to disk, with this computer's runtime directory.
    pub fn plugin_source(&self) -> String {
        let runtime = serde_json::to_string(&self.runtime.to_string_lossy()).unwrap();
        PLUGIN_SOURCE
            .replace("__RUNTIME__", &runtime)
            .replace("__VERSION__", &PLUGIN_VERSION.to_string())
    }
}

fn is_ours(contents: &[u8]) -> bool {
    String::from_utf8_lossy(contents)
        .lines()
        .take(5)
        .any(|line| line.contains(PLUGIN_MARKER))
}

/// The plugin file, served as the `opencode_plugin` setting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenCodeSettings {
    pub config: OpenCodeConfig,
}

impl OpenCodeSettings {
    pub fn new(config: &OpenCodeConfig) -> OpenCodeSettings {
        OpenCodeSettings {
            config: config.clone(),
        }
    }

    /// Whether our plugin is installed, whatever its version.
    pub fn plugin_enabled(&self) -> bool {
        std::fs::read(self.config.plugin_file()).is_ok_and(|contents| is_ours(&contents))
    }

    /// Rewrites an installed copy of our plugin that differs from this
    /// build's, so a newer version reaches computers that turned it on
    /// before. Anything else in its place, or no plugin, is left alone.
    /// Returns whether the file was rewritten.
    pub fn refresh_plugin(&self) -> Result<bool, String> {
        if !platform::SUPPORTED {
            return Ok(false);
        }
        let path = self.config.plugin_file();
        if !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
            return Ok(false);
        }
        let existing = std::fs::read(&path)
            .map_err(|e| format!("Could not read the OpenCode plugin file: {e}"))?;
        let source = self.config.plugin_source();
        if !is_ours(&existing) || existing == source.as_bytes() {
            return Ok(false);
        }
        write_keeping_file(&path, None, source.as_bytes(), BACKUP_SUFFIX, 0o644)
            .map_err(|e| format!("Could not update the OpenCode plugin: {e}"))?;
        Ok(true)
    }

    /// Installs or removes the plugin. OpenCode processes started afterwards
    /// load it; ones already open keep running as they are.
    pub fn set_plugin(&self, enabled: bool) -> Result<(), String> {
        if let Some(reason) = platform::unsupported("OpenCode") {
            return Err(reason);
        }
        let path = self.config.plugin_file();
        let mut backup = path.clone().into_os_string();
        backup.push(BACKUP_SUFFIX);
        let backup = PathBuf::from(backup);
        let existing = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => Some(
                std::fs::read(&path)
                    .map_err(|e| format!("Could not read the OpenCode plugin file: {e}"))?,
            ),
            Ok(_) => {
                return Err(format!(
                    "{} is not a regular file; Agent Relay leaves it alone.",
                    path.display()
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(format!("Could not read the OpenCode plugin file: {e}")),
        };
        if enabled {
            let source = self.config.plugin_source();
            if existing.as_deref() == Some(source.as_bytes()) {
                return Ok(());
            }
            // Someone else's file with our name is kept as the backup.
            let keep = existing.as_deref().filter(|contents| !is_ours(contents));
            write_keeping_file(&path, keep, source.as_bytes(), BACKUP_SUFFIX, 0o644)
                .map_err(|e| format!("Could not save the OpenCode plugin: {e}"))?;
            return match std::fs::remove_file(self.config.off_marker()) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    Err(format!("Could not clear the OpenCode opt-out marker: {e}"))
                }
                _ => Ok(()),
            };
        }
        // Off is recorded in OpenCode's directory whatever was there, so the
        // plugin is not turned on by default again.
        std::fs::write(
            self.config.off_marker(),
            "Agent Relay's OpenCode plugin was turned off in Agent Relay's settings.\n\
             Delete this file, or turn OpenCode sessions on there, to allow it again.\n",
        )
        .map_err(|e| format!("Could not record that the OpenCode plugin is off: {e}"))?;
        if !existing.as_deref().is_some_and(is_ours) {
            return Ok(());
        }
        std::fs::remove_file(&path)
            .map_err(|e| format!("Could not remove the OpenCode plugin: {e}"))?;
        if std::fs::symlink_metadata(&backup).is_ok_and(|metadata| metadata.is_file()) {
            std::fs::rename(&backup, &path)
                .map_err(|e| format!("Could not restore {}: {e}", path.display()))?;
        }
        Ok(())
    }
}

impl SettingsExtension for OpenCodeSettings {
    /// The plugin is on by default wherever OpenCode has run, since a plain
    /// OpenCode session has no other way in. A plugins directory that
    /// already holds a file of that name, or the marker turning it off
    /// leaves, is the person's choice and is left alone.
    fn default_on(&self) -> Vec<&'static str> {
        let free = |path: PathBuf| matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
        if self.config.installed()
            && free(self.config.plugin_file())
            && free(self.config.off_marker())
        {
            vec![SETTING]
        } else {
            Vec::new()
        }
    }

    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        if self.config.installed() {
            settings.insert(SETTING.into(), Value::Bool(self.plugin_enabled()));
        }
        settings
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        if let Some(reason) = platform::unsupported("OpenCode") {
            return Some(Err(reason));
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        Some(self.set_plugin(enabled))
    }
}

/// One session a plugin process holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldSession {
    pub session_id: String,
    pub title: Option<String>,
    pub directory: PathBuf,
    pub updated_at_ms: Option<i64>,
}

/// One live OpenCode process running the plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenProcess {
    pub pid: i32,
    pub start: u64,
    pub uid: u32,
    pub executable: PathBuf,
    pub socket: PathBuf,
    pub sessions: Vec<HeldSession>,
}

/// Whether `id` has the shape of an OpenCode session id the registry
/// accepts, `ses_` and 4 to 128 letters or digits, as the plugin's
/// V1 and V2 shell hooks check too.
pub use managed::is_session_id;

/// Whether the kernel's executable for `pid` is OpenCode: `opencode`, or
/// the `opencode.exe` the npm package installs and execs.
pub(crate) fn is_opencode_process(table: &dyn ProcessTable, pid: i32) -> bool {
    table.executable(pid).is_some_and(|executable| {
        executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "opencode" || name == "opencode.exe")
    })
}

fn private_dir(path: &Path, uid: u32) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0
    })
}

/// The socket's device and inode, as the binding pins it.
pub(crate) fn socket_identity(path: &Path, uid: u32) -> Option<(u64, u64)> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    (metadata.file_type().is_socket() && metadata.uid() == uid)
        .then(|| (metadata.dev(), metadata.ino()))
}

/// Decodes one `<pid>.json` record. Lenient, since a dying process can
/// leave anything: a record that does not name its own pid and socket, or
/// a session without a valid id or an absolute directory, is skipped.
fn decode_record(data: &[u8], pid: i32, socket: &Path) -> Option<Vec<HeldSession>> {
    let record: Value = serde_json::from_slice(data).ok()?;
    if record["pid"].as_i64() != Some(i64::from(pid))
        || record["socket"].as_str() != socket.to_str()
    {
        return None;
    }
    let sessions = record["sessions"].as_array()?;
    Some(
        sessions
            .iter()
            .filter_map(|session| {
                let session_id = session["id"].as_str()?;
                if !Target::new(SessionKind::OpenCodeOpen, session_id).is_valid() {
                    return None;
                }
                let directory = session["directory"]
                    .as_str()
                    .filter(|path| path.starts_with('/'))?;
                Some(HeldSession {
                    session_id: session_id.to_string(),
                    title: session["title"]
                        .as_str()
                        .map(str::trim)
                        .filter(|title| !title.is_empty())
                        .map(str::to_string),
                    directory: PathBuf::from(directory),
                    updated_at_ms: session["updated"].as_i64(),
                })
            })
            .collect(),
    )
}

/// The live plugin processes of this user. A record is believed only while
/// its pid is alive, this user's and an OpenCode executable, and its socket
/// is a socket of this user's in the private runtime directory.
pub fn open_processes(
    config: &OpenCodeConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<OpenProcess> {
    // No plugin listens on Windows, where it would need a Unix socket.
    if !platform::SUPPORTED || !private_dir(&config.runtime, uid) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&config.runtime) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(pid) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".json"))
            .and_then(|stem| stem.parse::<i32>().ok())
            .filter(|pid| *pid > 1)
        else {
            continue;
        };
        let record_private = std::fs::symlink_metadata(&path).is_ok_and(|metadata| {
            metadata.is_file() && metadata.uid() == uid && metadata.mode() & 0o022 == 0
        });
        let socket = config.runtime.join(format!("{pid}.sock"));
        let Some(process) = table.process(pid).filter(|process| process.uid == uid) else {
            continue;
        };
        if !record_private
            || !is_opencode_process(table, pid)
            || socket_identity(&socket, uid).is_none()
        {
            continue;
        }
        let Some(executable) = table.executable(pid) else {
            continue;
        };
        let Some(sessions) = std::fs::read(&path)
            .ok()
            .and_then(|data| decode_record(&data, pid, &socket))
        else {
            continue;
        };
        found.push(OpenProcess {
            pid,
            start: process.start,
            uid,
            executable,
            socket,
            sessions,
        });
    }
    found.sort_by_key(|process| process.pid);
    found
}

/// Why a session has no single live route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Miss {
    /// No live OpenCode process with the plugin holds it.
    NotOpen,
    /// More than one does, so which one would run the turn is a guess.
    Ambiguous,
}

/// The one live process holding `session_id`, and its record of it.
pub fn holder(
    config: &OpenCodeConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
) -> Result<(OpenProcess, HeldSession), Miss> {
    let mut holders = open_processes(config, table, uid)
        .into_iter()
        .filter_map(|process| {
            let session = process
                .sessions
                .iter()
                .find(|session| session.session_id == session_id)
                .cloned()?;
            Some((process, session))
        });
    let first = holders.next().ok_or(Miss::NotOpen)?;
    if holders.next().is_some() {
        return Err(Miss::Ambiguous);
    }
    Ok(first)
}

/// The sessions open OpenCode processes hold, as `opencode-open` rows. A
/// session two processes hold is listed once; delivery refuses it until
/// only one does.
pub fn discover(
    config: &OpenCodeConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<DiscoveredSession> {
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for process in open_processes(config, table, uid) {
        for session in process.sessions {
            if !seen.insert(session.session_id.clone()) {
                continue;
            }
            let directory = session.directory.to_str().map(str::to_string);
            rows.push(DiscoveredSession {
                title: session.title.clone().unwrap_or_else(|| {
                    directory
                        .as_deref()
                        .map(|cwd| cwd.trim_end_matches('/'))
                        .and_then(|cwd| cwd.rsplit('/').next())
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| session.session_id.clone())
                }),
                target: Target::new(SessionKind::OpenCodeOpen, session.session_id),
                directory,
                updated_at_ms: session.updated_at_ms,
                host: None,
                live: true,
                holder: None,
            });
        }
    }
    rows
}

/// `opencode` subcommands that are not an interactive session.
const NOT_A_SESSION: &[&str] = &[
    "acp",
    "agent",
    "attach",
    "auth",
    "completion",
    "db",
    "debug",
    "export",
    "github",
    "import",
    "mcp",
    "models",
    "plugin",
    "plug",
    "pr",
    "providers",
    "run",
    "serve",
    "session",
    "stats",
    "uninstall",
    "upgrade",
    "web",
];

/// Whether `pid` is an interactive OpenCode TUI: OpenCode on a terminal
/// whose arguments name no other subcommand. Flags can take values, so any
/// argument that is a subcommand word counts, not only the first; a TUI
/// opened on a project directory named like one is missed, never a server
/// listed.
fn is_tui(table: &dyn ProcessTable, pid: i32) -> bool {
    is_opencode_process(table, pid)
        && table.has_terminal(pid)
        && !table
            .arguments(pid)
            .iter()
            .skip(1)
            .any(|argument| NOT_A_SESSION.contains(&argument.as_str()))
}

/// OpenCode TUIs of this user's that run without the plugin, because they
/// started before it was installed: the session each most recently worked
/// on in its directory, from OpenCode's own database, as rows that are not
/// live. They cannot be reached until OpenCode restarts, and are listed so
/// the app can say so. Sessions a plugin process already holds are skipped.
/// With the plugin off, a restart would not connect them, so none is listed.
pub fn needing_restart(
    config: &OpenCodeConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<DiscoveredSession> {
    if !platform::SUPPORTED || !OpenCodeSettings::new(config).plugin_enabled() {
        return Vec::new();
    }
    let reachable: std::collections::HashSet<i32> = open_processes(config, table, uid)
        .iter()
        .map(|process| process.pid)
        .collect();
    let held: std::collections::HashSet<String> = discover(config, table, uid)
        .into_iter()
        .map(|row| row.target.id)
        .collect();
    let directories: Vec<PathBuf> = table
        .all_pids()
        .into_iter()
        .filter(|pid| !reachable.contains(pid))
        .filter(|pid| {
            table
                .process(*pid)
                .is_some_and(|process| process.uid == uid)
        })
        .filter(|pid| is_tui(table, *pid))
        .filter_map(|pid| table.cwd(pid))
        .collect();
    if directories.is_empty() {
        return Vec::new();
    }
    let Some(database) = open_database(config) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for directory in directories {
        let Some(directory_text) = directory.to_str() else {
            continue;
        };
        let Some((id, title, updated)) = latest_session(&database, directory_text) else {
            continue;
        };
        if held.contains(&id) || !seen.insert(id.clone()) {
            continue;
        }
        let target = Target::new(SessionKind::OpenCodeOpen, id);
        if !target.is_valid() {
            continue;
        }
        rows.push(DiscoveredSession {
            title: Some(title.trim().to_string())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| target.id.clone()),
            target,
            directory: Some(directory_text.to_string()),
            updated_at_ms: Some(updated),
            host: None,
            live: false,
            holder: None,
        });
    }
    rows
}

/// OpenCode's session database, opened read-only.
pub(crate) fn open_database(config: &OpenCodeConfig) -> Option<rusqlite::Connection> {
    let path = config.data_dir.join("opencode.db");
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

/// The top-level, unarchived session most recently updated in `directory`.
fn latest_session(
    database: &rusqlite::Connection,
    directory: &str,
) -> Option<(String, String, i64)> {
    database
        .query_row(
            "SELECT id, title, time_updated FROM session \
             WHERE directory = ?1 AND parent_id IS NULL AND time_archived IS NULL \
             ORDER BY time_updated DESC LIMIT 1",
            [directory],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok()
}

/// Those of `session_ids` OpenCode's own database records as archived,
/// read over one connection. A missing database, table or row archives
/// nothing.
pub fn archived_ids<'a>(
    config: &OpenCodeConfig,
    session_ids: impl IntoIterator<Item = &'a str>,
) -> HashSet<String> {
    let ids: Vec<&str> = session_ids
        .into_iter()
        .filter(|id| is_session_id(id))
        .collect();
    if ids.is_empty() {
        return HashSet::new();
    }
    let Some(database) = open_database(config) else {
        return HashSet::new();
    };
    let Ok(mut statement) = database.prepare(
        "SELECT EXISTS(SELECT 1 FROM session WHERE id = ?1 AND time_archived IS NOT NULL)",
    ) else {
        return HashSet::new();
    };
    ids.into_iter()
        .filter(|id| statement.query_row([id], |row| row.get(0)).unwrap_or(false))
        .map(str::to_string)
        .collect()
}

/// The reference an open OpenCode agent's registration is pinned to.
pub fn route_reference(session_id: &str) -> String {
    format!("{ROUTE_PREFIX}{session_id}")
}

/// Whether `reference` pins exactly `session_id`.
pub fn is_route_reference(reference: &str, session_id: &str) -> bool {
    reference.strip_prefix(ROUTE_PREFIX) == Some(session_id)
}

/// The delivery binding for one held session: the exact process and socket,
/// with OpenCode's own project and workspace ids read back over that socket.
/// The credential reference pins the socket's inode, so a plugin that
/// restarted, even under the same pid, is a different route.
pub fn binding(
    table: &dyn ProcessTable,
    http: &dyn opencode_existing::HttpTransport,
    process: &OpenProcess,
    session: &HeldSession,
    relay_workspace_id: &str,
    owner_id: &str,
) -> Result<Binding, opencode_existing::Failure> {
    let (dev, ino) = socket_identity(&process.socket, process.uid)
        .ok_or(opencode_existing::Failure::StaleServer)?;
    let mut candidate = Binding {
        relay_workspace_id: relay_workspace_id.to_string(),
        owner_id: owner_id.to_string(),
        session_id: session.session_id.clone(),
        endpoint: format!("unix:{}", process.socket.display()),
        server_pid: process.pid,
        server_start: process.start,
        server_uid: process.uid,
        executable: process.executable.clone(),
        directory: session.directory.clone(),
        project_id: String::new(),
        opencode_workspace_id: None,
        credential_reference: String::new(),
    };
    candidate.credential_reference =
        opencode_existing::credential_reference(&candidate, &plugin_marker(dev, ino));
    let (project_id, workspace_id) = opencode_existing::inspect_session(
        table,
        http,
        &candidate,
        std::time::Duration::from_secs(10),
    )?;
    candidate.project_id = project_id;
    candidate.opencode_workspace_id = workspace_id;
    Ok(candidate)
}

/// The marker a plugin route's credential reference is made from.
pub(crate) fn plugin_marker(dev: u64, ino: u64) -> String {
    format!("plugin:{dev}:{ino}")
}

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;

    #[test]
    fn the_plugin_setting_is_absent_and_refused_on_windows() {
        let root = tempfile::tempdir().unwrap();
        let config = OpenCodeConfig {
            config_dir: root.path().join("config").join("opencode"),
            data_dir: root.path().join("data").join("opencode"),
            runtime: root.path().join("rt"),
        };
        std::fs::create_dir_all(&config.config_dir).unwrap();
        let settings = OpenCodeSettings::new(&config);
        assert!(!config.installed());
        assert!(settings.get().is_empty());
        assert!(settings.default_on().is_empty());
        assert_eq!(
            settings.set(SETTING, &Value::Bool(true)),
            Some(Err("OpenCode is not available on Windows.".to_string()))
        );
        assert_eq!(settings.refresh_plugin(), Ok(false));
        assert!(!config.plugin_file().exists());
    }
}

// Unix sockets and file modes throughout; the plugin route is not available
// on Windows.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use std::os::unix::fs::PermissionsExt;

    const SESSION: &str = "ses_ee6c05d84ffeEbQeSyDo7qvc2p";

    fn config(root: &Path) -> OpenCodeConfig {
        OpenCodeConfig {
            config_dir: root.join("config").join("opencode"),
            data_dir: root.join("data").join("opencode"),
            runtime: root.join("rt"),
        }
    }

    /// A socket path must fit in 104 bytes on macOS, which a long `TMPDIR`
    /// can exceed.
    fn short_tempdir() -> tempfile::TempDir {
        tempfile::tempdir_in("/tmp").unwrap()
    }

    fn uid() -> u32 {
        unsafe { libc::getuid() }
    }

    /// A runtime directory with one live record and its listening socket.
    fn live_record(
        config: &OpenCodeConfig,
        pid: i32,
        sessions: Value,
    ) -> std::os::unix::net::UnixListener {
        std::fs::create_dir_all(&config.runtime).unwrap();
        std::fs::set_permissions(&config.runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
        let socket = config.runtime.join(format!("{pid}.sock"));
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let record = serde_json::json!({
            "version": 1, "pid": pid, "socket": socket, "directory": "/w", "sessions": sessions,
        });
        let path = config.runtime.join(format!("{pid}.json"));
        std::fs::write(&path, record.to_string()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        listener
    }

    fn opencode(table: &FakeProcesses, pid: i32, name: &str) {
        table.insert(
            pid,
            FakeProcess {
                uid: uid(),
                start: 77,
                executable: Some(PathBuf::from("/opt/opencode/bin").join(name)),
                ..FakeProcess::default()
            },
        );
    }

    #[test]
    fn config_follows_xdg_and_keeps_the_socket_path_short() {
        let home = Path::new("/home/me");
        let plain = OpenCodeConfig::from_env(&|_| None, home);
        assert_eq!(plain.config_dir, PathBuf::from("/home/me/.config/opencode"));
        assert_eq!(
            plain.data_dir,
            PathBuf::from("/home/me/.local/share/opencode")
        );
        assert_eq!(
            plain.plugin_file(),
            PathBuf::from("/home/me/.config/opencode/plugins/agent-relay.js")
        );
        assert_eq!(
            plain.runtime,
            PathBuf::from("/home/me/.agentworkforce/desktop/opencode")
        );
        let xdg = |key: &str| match key {
            "XDG_CONFIG_HOME" => Some(" /x/cfg ".to_string()),
            "XDG_DATA_HOME" => Some("relative".to_string()),
            _ => None,
        };
        let custom = OpenCodeConfig::from_env(&xdg, home);
        assert_eq!(custom.config_dir, PathBuf::from("/x/cfg/opencode"));
        assert_eq!(
            custom.data_dir,
            PathBuf::from("/home/me/.local/share/opencode")
        );
    }

    #[test]
    fn the_plugin_names_its_runtime_and_version() {
        let config = config(Path::new("/r \"q\""));
        let source = config.plugin_source();
        assert!(source.contains(r#"const RUNTIME = "/r \"q\"/rt";"#));
        assert!(source.contains(&format!("const VERSION = {PLUGIN_VERSION};")));
        assert!(!source.contains("__RUNTIME__") && !source.contains("__VERSION__"));
        assert!(is_ours(source.as_bytes()));
        // Only what delivery needs is answered.
        assert!(source.contains("prompt_async") && source.contains("msg_relay_"));
        assert!(!source.contains("/session/${id}/abort"));
        // A fork never holds its source session, and a non-object prompt
        // body is the caller's error.
        assert!(source.contains(r#"word === "--fork" || (word.startsWith("--fork=")"#));
        assert!(
            source.contains(r#"body === null || typeof body !== "object" || Array.isArray(body)"#)
        );
        // Disposing the instance closes its listener and files.
        assert!(source.contains(r#"process.removeListener("exit", close);"#));
        assert!(source.contains("clearTimeout(startup);"));
        assert!(source.contains("setup: setupV2, server: AgentRelay"));
        assert!(source.contains("await runtime.dispose();"));
    }

    #[test]
    fn session_ids_take_the_registry_range() {
        assert!(is_session_id("ses_abcd"));
        assert!(is_session_id(&format!("ses_{}", "a".repeat(65))));
        assert!(is_session_id(&format!("ses_{}", "a".repeat(128))));
        assert!(!is_session_id("ses_abc"));
        assert!(!is_session_id(&format!("ses_{}", "a".repeat(129))));
        assert!(!is_session_id("ses_ab-cd"));
        // The plugin's hook tags with the same rule.
        assert!(PLUGIN_SOURCE.contains("!SESSION.test(id)"));
    }

    #[test]
    fn an_older_copy_of_the_plugin_is_refreshed_and_nothing_else_is() {
        let temp = tempfile::TempDir::new().unwrap();
        let config = config(temp.path());
        let settings = OpenCodeSettings::new(&config);
        assert_eq!(
            settings.refresh_plugin(),
            Ok(false),
            "no plugin, nothing to do"
        );
        std::fs::create_dir_all(config.config_dir.join("plugins")).unwrap();
        std::fs::write(config.plugin_file(), "// AGENT_RELAY_OPENCODE_PLUGIN=1\n").unwrap();
        assert_eq!(settings.refresh_plugin(), Ok(true));
        assert_eq!(
            std::fs::read_to_string(config.plugin_file()).unwrap(),
            config.plugin_source()
        );
        assert_eq!(settings.refresh_plugin(), Ok(false), "already current");
        std::fs::write(config.plugin_file(), "// someone else's plugin\n").unwrap();
        assert_eq!(settings.refresh_plugin(), Ok(false));
        assert_eq!(
            std::fs::read_to_string(config.plugin_file()).unwrap(),
            "// someone else's plugin\n"
        );
    }

    #[test]
    fn the_setting_installs_and_removes_only_its_own_file() {
        let temp = tempfile::TempDir::new().unwrap();
        let config = config(temp.path());
        let settings = OpenCodeSettings::new(&config);
        assert!(settings.get().is_empty(), "no OpenCode, no setting");
        std::fs::create_dir_all(config.config_dir.join("plugins")).unwrap();
        assert_eq!(settings.get()[SETTING], Value::Bool(false));

        assert_eq!(settings.set(SETTING, &Value::Bool(true)), Some(Ok(())));
        assert_eq!(settings.get()[SETTING], Value::Bool(true));
        assert_eq!(
            std::fs::read_to_string(config.plugin_file()).unwrap(),
            config.plugin_source()
        );
        // Our own file is replaced without a backup, and removed.
        std::fs::write(config.plugin_file(), "// AGENT_RELAY_OPENCODE_PLUGIN=0\n").unwrap();
        settings.set_plugin(true).unwrap();
        assert_eq!(
            std::fs::read_to_string(config.plugin_file()).unwrap(),
            config.plugin_source()
        );
        settings.set_plugin(false).unwrap();
        assert!(!config.plugin_file().exists());
        assert!(config.off_marker().is_file(), "off leaves its trace");
        settings.set_plugin(true).unwrap();
        assert!(!config.off_marker().exists(), "on clears it");
        settings.set_plugin(false).unwrap();
        std::fs::remove_file(config.off_marker()).unwrap();
        assert!(std::fs::read_dir(config.config_dir.join("plugins"))
            .unwrap()
            .next()
            .is_none());

        // Someone else's file is backed up, then put back.
        std::fs::write(
            config.plugin_file(),
            "export const Mine = async () => ({})\n",
        )
        .unwrap();
        assert!(!settings.plugin_enabled());
        settings.set_plugin(false).unwrap();
        assert!(
            config.plugin_file().exists(),
            "off never removes a file not ours"
        );
        settings.set_plugin(true).unwrap();
        assert!(settings.plugin_enabled());
        let backup = config
            .config_dir
            .join("plugins/agent-relay.js.relay-desktop-backup");
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "export const Mine = async () => ({})\n"
        );
        settings.set_plugin(false).unwrap();
        assert_eq!(
            std::fs::read_to_string(config.plugin_file()).unwrap(),
            "export const Mine = async () => ({})\n"
        );
        assert!(!backup.exists());

        assert_eq!(
            settings.set(SETTING, &Value::from("yes")),
            Some(Err("opencode_plugin must be true or false.".into()))
        );
        assert_eq!(settings.set("grok_leader", &Value::Bool(true)), None);
    }

    #[test]
    fn the_plugin_is_on_by_default_only_where_nobody_chose() {
        let temp = tempfile::TempDir::new().unwrap();
        let config = config(temp.path());
        let settings = OpenCodeSettings::new(&config);
        assert!(settings.default_on().is_empty(), "not installed");
        std::fs::create_dir_all(&config.data_dir).unwrap();
        assert_eq!(settings.default_on(), vec![SETTING]);
        settings.set_plugin(true).unwrap();
        assert!(settings.default_on().is_empty(), "already on");
        settings.set_plugin(false).unwrap();
        assert!(settings.default_on().is_empty(), "turned off");
        std::fs::remove_file(config.off_marker()).unwrap();
        assert_eq!(settings.default_on(), vec![SETTING]);
        std::fs::write(
            config.plugin_file(),
            "export const Mine = async () => ({})\n",
        )
        .unwrap();
        assert!(settings.default_on().is_empty(), "someone else's file");
    }

    #[test]
    fn only_live_opencode_processes_of_this_user_are_listed() {
        let temp = short_tempdir();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        let sessions = serde_json::json!([
            {"id": SESSION, "title": " Fix the build ", "directory": "/w/api", "updated": 5},
            {"id": "not-a-session", "directory": "/w"},
            {"id": "ses_relative0dir", "directory": "w"},
        ]);
        let _live = live_record(&config, 4242, sessions.clone());
        opencode(&table, 4242, "opencode.exe");
        // A recycled pid that is not OpenCode, and a dead one.
        let _other = live_record(&config, 4343, sessions.clone());
        opencode(&table, 4343, "node");
        let _dead = live_record(&config, 4444, sessions);

        let found = open_processes(&config, &table, uid());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, 4242);
        assert_eq!(found[0].start, 77);
        assert_eq!(
            found[0].sessions,
            vec![HeldSession {
                session_id: SESSION.into(),
                title: Some("Fix the build".into()),
                directory: PathBuf::from("/w/api"),
                updated_at_ms: Some(5),
            }]
        );
        let rows = discover(&config, &table, uid());
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].target,
            Target::new(SessionKind::OpenCodeOpen, SESSION)
        );
        assert_eq!(rows[0].title, "Fix the build");
        assert_eq!(rows[0].directory.as_deref(), Some("/w/api"));

        // Another user's process is never this user's session.
        assert!(open_processes(&config, &table, uid() + 1).is_empty());
    }

    #[test]
    fn a_shared_runtime_directory_lists_nothing() {
        let temp = short_tempdir();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        let _live = live_record(
            &config,
            4242,
            serde_json::json!([{"id": SESSION, "directory": "/w"}]),
        );
        opencode(&table, 4242, "opencode");
        std::fs::set_permissions(&config.runtime, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(open_processes(&config, &table, uid()).is_empty());
    }

    #[test]
    fn a_record_must_name_its_own_pid_and_socket() {
        let socket = Path::new("/rt/5.sock");
        let good = serde_json::json!({"pid": 5, "socket": "/rt/5.sock", "sessions": []});
        assert_eq!(
            decode_record(good.to_string().as_bytes(), 5, socket),
            Some(vec![])
        );
        let wrong_pid = serde_json::json!({"pid": 6, "socket": "/rt/5.sock", "sessions": []});
        assert_eq!(
            decode_record(wrong_pid.to_string().as_bytes(), 5, socket),
            None
        );
        let wrong_socket =
            serde_json::json!({"pid": 5, "socket": "/elsewhere.sock", "sessions": []});
        assert_eq!(
            decode_record(wrong_socket.to_string().as_bytes(), 5, socket),
            None
        );
        assert_eq!(decode_record(b"garbage", 5, socket), None);
    }

    #[test]
    fn a_session_two_processes_hold_has_no_route() {
        let temp = short_tempdir();
        let config = config(temp.path());
        let table = FakeProcesses::default();
        let held = serde_json::json!([{"id": SESSION, "directory": "/w"}]);
        let _first = live_record(&config, 4242, held.clone());
        opencode(&table, 4242, "opencode");
        assert_eq!(
            holder(&config, &table, uid(), SESSION).map(|(process, _)| process.pid),
            Ok(4242)
        );
        assert_eq!(
            holder(&config, &table, uid(), "ses_missing00").map(|_| ()),
            Err(Miss::NotOpen)
        );
        let _second = live_record(&config, 4343, held);
        opencode(&table, 4343, "opencode");
        assert_eq!(
            holder(&config, &table, uid(), SESSION).map(|_| ()),
            Err(Miss::Ambiguous)
        );
        assert_eq!(discover(&config, &table, uid()).len(), 1);
    }

    #[test]
    fn open_tuis_without_the_plugin_need_a_restart() {
        let temp = short_tempdir();
        let config = config(temp.path());
        std::fs::create_dir_all(&config.data_dir).unwrap();
        let database = rusqlite::Connection::open(config.data_dir.join("opencode.db")).unwrap();
        database
            .execute_batch(
                "CREATE TABLE session (id text, title text, directory text, parent_id text, \
                 time_archived integer, time_updated integer);
                 INSERT INTO session VALUES ('ses_old000000', 'Old', '/w/api', NULL, NULL, 1);
                 INSERT INTO session VALUES ('ses_new000000', 'New work', '/w/api', NULL, NULL, 9);
                 INSERT INTO session VALUES ('ses_child00000', 'Child', '/w/api', 'ses_new000000', NULL, 20);
                 INSERT INTO session VALUES ('ses_gone000000', 'Gone', '/w/api', NULL, 5, 30);
                 INSERT INTO session VALUES ('ses_web0000000', 'Web', '/w/web', NULL, NULL, 3);",
            )
            .unwrap();
        drop(database);
        assert_eq!(
            archived_ids(
                &config,
                ["ses_gone000000", "ses_new000000", "ses_missing0000"]
            ),
            HashSet::from(["ses_gone000000".to_string()])
        );
        let table = FakeProcesses::default();
        let tui = |arguments: &[&str], cwd: &str, terminal: bool| FakeProcess {
            uid: uid(),
            start: 1,
            executable: Some(PathBuf::from("/opt/opencode/bin/opencode.exe")),
            arguments: arguments.iter().map(|a| a.to_string()).collect(),
            cwd: Some(PathBuf::from(cwd)),
            has_terminal: terminal,
            ..FakeProcess::default()
        };
        table.insert(10, tui(&["opencode"], "/w/api", true));
        // A server, a one-shot run and a process off any terminal are not TUIs.
        table.insert(
            11,
            tui(&["opencode", "serve", "--port", "4096"], "/w/web", true),
        );
        table.insert(
            12,
            tui(&["opencode", "--model", "x/y", "run", "hi"], "/w/web", true),
        );
        table.insert(13, tui(&["opencode"], "/w/web", false));
        // With the plugin off, a restart would not connect them: none listed.
        assert!(needing_restart(&config, &table, uid()).is_empty());
        OpenCodeSettings::new(&config).set_plugin(true).unwrap();
        let rows = needing_restart(&config, &table, uid());
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].target,
            Target::new(SessionKind::OpenCodeOpen, "ses_new000000")
        );
        assert_eq!(rows[0].title, "New work");
        assert!(!rows[0].live);
        // A TUI given a project path is a TUI.
        table.insert(14, tui(&["opencode", "/w/web"], "/w/web", true));
        assert_eq!(needing_restart(&config, &table, uid()).len(), 2);
        // Once the plugin runs in that TUI, it is listed live instead.
        let _live = live_record(
            &config,
            10,
            serde_json::json!([{"id": "ses_new000000", "directory": "/w/api"}]),
        );
        table.insert(
            10,
            FakeProcess {
                start: 77,
                ..tui(&["opencode"], "/w/api", true)
            },
        );
        let rows = needing_restart(&config, &table, uid());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target.id, "ses_web0000000");
    }

    #[test]
    fn route_references_pin_one_session() {
        let reference = route_reference(SESSION);
        assert!(is_route_reference(&reference, SESSION));
        assert!(!is_route_reference(&reference, "ses_other0000"));
        assert!(!is_route_reference(SESSION, SESSION));
    }
}
