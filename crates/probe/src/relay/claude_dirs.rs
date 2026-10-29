//! Every Claude Code config folder (`CLAUDE_CONFIG_DIR`) this person's
//! sessions use, so a login kept apart from `~/.claude` (a tool or a company
//! setup that runs Claude Code with `CLAUDE_CONFIG_DIR=~/.seclaude`) has its
//! sessions found, its messages delivered and its transcripts uploaded.
//!
//! A folder is watched for one of these reasons (`Origin`):
//! - the desktop's own: its `CLAUDE_CONFIG_DIR`, else `~/.claude`;
//! - a sibling `.claude` or `.claude-<name>` folder beside it, as account
//!   switchers keep;
//! - named in `AGENT_RELAY_CLAUDE_CONFIG_DIRS` (colon-separated);
//! - added in Settings (`claude_config_dirs`);
//! - the `CLAUDE_CONFIG_DIR` of a Claude Code process seen running, kept
//!   after it exits so its transcripts are still uploaded.
//!
//! Each folder is shared unless the person turns it off in Settings
//! (`claude_config_dir`): an unshared folder's sessions are not listed, so
//! they are never put on the relay or messaged, and its transcripts are never
//! uploaded (the upload's consent check refuses a Claude session whose
//! transcript is in one). A team that uploads only `~/.seclaude` turns the
//! others off.
//!
//! Claude Code cloud sessions on claude.ai are listed and uploaded only once
//! the person turns them on (`claude_cloud_sessions`), and only while the
//! `~/.claude` folder is shared: reading them takes Claude Code's own login,
//! which on macOS means a Keychain prompt the setting explains.
//!
//! The added and seen folders, each folder's choice and the cloud-session
//! opt-in are kept in
//! `claude-config-dirs.json` in the relay home, which the core and the probe
//! both read. Each folder is listed once, by its real path.

use crate::relay::process::ProcessTable;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Extra Claude config folders, colon-separated.
pub const DIRS_ENV: &str = "AGENT_RELAY_CLAUDE_CONFIG_DIRS";
/// The `settings.get`/`settings.set` key: the watched folders (get) and the
/// folders added in Settings (set).
pub const SETTING: &str = "claude_config_dirs";
/// The `settings.set` key that changes one folder's choice, such as whether
/// it is shared: `{"path": …, "shared": …}`.
pub const CHOICE_SETTING: &str = "claude_config_dir";
/// The settings that are not true or false: the folder list and one
/// folder's choice. `settings.set` hands them to the extension unchecked.
pub fn is_folder_setting(key: &str) -> bool {
    key == SETTING || key == CHOICE_SETTING
}

/// The `settings.get`/`settings.set` key: whether Claude Code cloud sessions
/// on claude.ai are listed and uploaded. Off until the person turns it on.
pub const CLOUD_SETTING: &str = "claude_cloud_sessions";

/// The file of added and seen folders, in the relay home.
pub const FILE: &str = "claude-config-dirs.json";
/// How often running processes are looked at for a new folder.
const SCAN_INTERVAL: Duration = Duration::from_secs(30);

/// Why a folder is watched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// The desktop's own `CLAUDE_CONFIG_DIR`, else `~/.claude`.
    Default,
    /// A `.claude` or `.claude-<name>` folder beside the default.
    Sibling,
    /// Named in `AGENT_RELAY_CLAUDE_CONFIG_DIRS`.
    Environment,
    /// Added in Settings.
    Added,
    /// A running Claude Code session's `CLAUDE_CONFIG_DIR`.
    Running,
}

/// One watched folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatchedDir {
    pub path: PathBuf,
    pub origin: Origin,
    /// Its sessions may be put on the relay and uploaded.
    pub shared: bool,
}

/// The person's choices for one folder. Missing means the defaults; a later
/// field (the workspace the folder's sessions go to) fits beside `shared`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderChoice {
    #[serde(default = "yes")]
    pub shared: bool,
}

impl Default for FolderChoice {
    fn default() -> FolderChoice {
        FolderChoice { shared: true }
    }
}

fn yes() -> bool {
    true
}

/// What `claude-config-dirs.json` keeps.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recorded {
    /// Added in Settings, in the order added.
    #[serde(default)]
    pub added: Vec<PathBuf>,
    /// Seen on a running Claude Code process.
    #[serde(default)]
    pub running: Vec<PathBuf>,
    /// The person's choices, by folder; a folder not here has the defaults.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub folders: BTreeMap<PathBuf, FolderChoice>,
    /// The person turned Claude Code cloud sessions on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cloud_sessions: bool,
}

impl Recorded {
    /// The choices for `path`, matched by its real path too.
    pub fn choice(&self, path: &Path) -> FolderChoice {
        self.folders
            .get(path)
            .or_else(|| {
                let path = real(path);
                self.folders
                    .iter()
                    .find(|(folder, _)| real(folder) == path)
                    .map(|(_, choice)| choice)
            })
            .cloned()
            .unwrap_or_default()
    }
}

/// Where the extra folders come from: the environment's list and the file
/// of added and seen folders. `None` everywhere is no extra folder.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaudeDirs {
    /// `AGENT_RELAY_CLAUDE_CONFIG_DIRS`, resolved.
    pub environment: Vec<PathBuf>,
    /// `claude-config-dirs.json`; `None` keeps nothing (tests).
    pub file: Option<PathBuf>,
}

impl ClaudeDirs {
    /// Reads `AGENT_RELAY_CLAUDE_CONFIG_DIRS`; the file is in `relay_home`.
    pub fn from_env(
        env: &dyn Fn(&str) -> Option<String>,
        home: &Path,
        relay_home: &Path,
    ) -> ClaudeDirs {
        ClaudeDirs {
            environment: env(DIRS_ENV)
                .map(|value| parse_list(&value, home))
                .unwrap_or_default(),
            file: Some(relay_home.join(FILE)),
        }
    }

    /// The added and seen folders; an absent or unreadable file is none.
    pub fn recorded(&self) -> Recorded {
        self.file
            .as_deref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default()
    }

    /// Whether `folder`, as a change to the added folders names it, is
    /// added already: saved in Settings, deleted since or also found
    /// another way included.
    pub fn is_added(&self, folder: &str, home: &Path) -> bool {
        let path = expand_tilde(folder.trim(), home);
        self.recorded().added.contains(&path)
    }

    /// Replaces the folders added in Settings. Each new one must be an
    /// existing folder, given by an absolute or `~` path.
    pub fn set_added(&self, folders: &[String], home: &Path) -> Result<(), String> {
        let known = self.recorded().added;
        let mut added = Vec::new();
        for folder in folders {
            let path = expand_tilde(folder.trim(), home);
            if !path.is_absolute() {
                return Err(format!("{} is not a full path.", folder.trim()));
            }
            // A folder added before and since deleted is kept as it was, so
            // it never blocks removing another.
            if !path.is_dir() && !known.contains(&path) {
                return Err(format!("{} is not a folder.", path.display()));
            }
            if !added.contains(&path) {
                added.push(path);
            }
        }
        self.update(|recorded| {
            recorded.added = added;
            true
        })
    }

    /// Shares a watched folder's sessions, or stops sharing them.
    pub fn set_shared(&self, folder: &str, shared: bool, default: &Path) -> Result<(), String> {
        let path = PathBuf::from(folder.trim());
        let Some(watched) = self
            .watched(default)
            .into_iter()
            .find(|dir| dir.path == path || real(&dir.path) == real(&path))
        else {
            return Err(format!(
                "{} is not a watched Claude Code folder.",
                path.display()
            ));
        };
        self.update(|recorded| {
            let real_path = real(&watched.path);
            recorded
                .folders
                .retain(|known, _| known != &watched.path && real(known) != real_path);
            if !shared {
                recorded
                    .folders
                    .insert(watched.path.clone(), FolderChoice { shared });
            }
            true
        })
    }

    /// Whether the person turned Claude Code cloud sessions on.
    pub fn cloud_sessions(&self) -> bool {
        self.recorded().cloud_sessions
    }

    /// Turns Claude Code cloud sessions on or off.
    pub fn set_cloud_sessions(&self, on: bool) -> Result<(), String> {
        self.update(|recorded| {
            let changed = recorded.cloud_sessions != on;
            recorded.cloud_sessions = on;
            changed
        })
    }

    /// Records the `CLAUDE_CONFIG_DIR` of each running Claude Code process
    /// of this user, at most once every `SCAN_INTERVAL` in this process.
    pub fn remember_running(&self, table: &dyn ProcessTable) -> bool {
        static LAST: Mutex<Option<Instant>> = Mutex::new(None);
        {
            let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
            if last.is_some_and(|at| at.elapsed() < SCAN_INTERVAL) {
                return false;
            }
            *last = Some(Instant::now());
        }
        self.record_running(&running_config_dirs(table))
    }

    /// Adds `seen` to the running folders, dropping those gone from disk.
    /// The file is rewritten only when that changes it; true when it was.
    pub fn record_running(&self, seen: &[PathBuf]) -> bool {
        let mut wrote = false;
        let _ = self.update(|recorded| {
            let mut running: Vec<PathBuf> = recorded
                .running
                .iter()
                .filter(|path| path.is_dir())
                .cloned()
                .collect();
            for path in seen {
                if path.is_dir() && !running.contains(path) {
                    running.push(path.clone());
                }
            }
            wrote = running != recorded.running;
            recorded.running = running;
            wrote
        });
        wrote
    }

    /// Reads, changes and writes the file under an exclusive lock, so the
    /// core and the probe never overwrite each other's change (an unshared
    /// folder must never come back shared). `change` says whether it
    /// changed anything; nothing is written when it did not.
    fn update(&self, change: impl FnOnce(&mut Recorded) -> bool) -> Result<(), String> {
        let Some(file) = self.file.as_deref() else {
            return Ok(());
        };
        let failed = |error: std::io::Error| {
            format!(
                "Could not save the Claude folders to {}: {error}",
                file.display()
            )
        };
        let _lock = FileLock::exclusive(&lock_path(file)).map_err(failed)?;
        // Discovery must not overwrite unreadable consent choices with the
        // permissive read-only fallback while recording a newly seen login.
        let mut recorded = match std::fs::read(file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                format!(
                    "Could not decode Claude folder choices at {}: {error}",
                    file.display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Recorded::default(),
            Err(error) => return Err(failed(error)),
        };
        if !change(&mut recorded) {
            return Ok(());
        }
        write_private(file, &recorded).map_err(failed)
    }

    /// Every watched folder, the default first, each once by real path.
    /// Only folders that exist are listed, except the default.
    pub fn watched(&self, default: &Path) -> Vec<WatchedDir> {
        self.watched_recorded(default, &self.recorded())
    }

    /// Uses a caller-validated consent snapshot for mutation-sensitive work.
    pub fn watched_recorded(&self, default: &Path, recorded: &Recorded) -> Vec<WatchedDir> {
        let dir = |path: PathBuf, origin| WatchedDir {
            shared: recorded.choice(&path).shared,
            path,
            origin,
        };
        let mut found = vec![dir(default.to_path_buf(), Origin::Default)];
        found.extend(
            siblings(default)
                .into_iter()
                .map(|path| dir(path, Origin::Sibling)),
        );
        for (paths, origin) in [
            (&self.environment, Origin::Environment),
            (&recorded.added, Origin::Added),
            (&recorded.running, Origin::Running),
        ] {
            found.extend(
                paths
                    .iter()
                    .filter(|path| path.is_dir())
                    .map(|path| dir(path.clone(), origin)),
            );
        }
        let mut seen = HashSet::new();
        found.retain(|dir| seen.insert(real(&dir.path)));
        found
    }

    /// Every shared watched folder but the default.
    pub fn extra_homes(&self, default: &Path) -> Vec<PathBuf> {
        self.watched(default)
            .into_iter()
            .skip(1)
            .filter(|dir| dir.shared)
            .map(|dir| dir.path)
            .collect()
    }

    /// Whether the default folder is shared.
    pub fn default_shared(&self, default: &Path) -> bool {
        self.recorded().choice(default).shared
    }

    /// Every watched folder that is not shared.
    pub fn unshared(&self, default: &Path) -> Vec<PathBuf> {
        self.watched(default)
            .into_iter()
            .filter(|dir| !dir.shared)
            .map(|dir| dir.path)
            .collect()
    }
}

/// The folders this process's environment watches that are not shared:
/// the default is `CLAUDE_CONFIG_DIR`, else `~/.claude`. Kept while the file
/// is unchanged (its size, modification time and inode), so a folder turned
/// off is refused by the next consent check.
pub fn unshared_folders() -> Vec<PathBuf> {
    type Stamp = Option<(u64, i64, i64, u64)>;
    static CACHE: Mutex<Option<(Stamp, Vec<PathBuf>)>> = Mutex::new(None);
    let env = |key: &str| std::env::var(key).ok();
    let Ok(home) = crate::relay::paths::home() else {
        return Vec::new();
    };
    let relay_home = crate::relay::workspace::relay_home(&env, &home);
    let dirs = ClaudeDirs::from_env(&env, &home, &relay_home);
    let stamp: Stamp = dirs.file.as_deref().and_then(file_stamp);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((known, folders)) = cache.as_ref() {
        if *known == stamp {
            return folders.clone();
        }
    }
    let folders = dirs.unshared(&default_home(&env, &home));
    *cache = Some((stamp, folders.clone()));
    folders
}

/// The desktop's own Claude Code folder: `CLAUDE_CONFIG_DIR`, else
/// `~/.claude`.
pub fn default_home(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    env("CLAUDE_CONFIG_DIR")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(|dir| expand_tilde(&dir, home))
        .unwrap_or_else(|| home.join(".claude"))
}

/// Whether `session_id` names a Claude Code cloud session on claude.ai
/// (`cse_…`, `session_…`); a local session's id is a UUID.
pub fn is_cloud_session(session_id: &str) -> bool {
    session_id.starts_with("cse_") || session_id.starts_with("session_")
}

/// Whether claude.ai cloud sessions may be listed and uploaded: the person
/// turned them on, and `~/.claude` is shared. They are read with Claude
/// Code's login in `~/.claude`, so they follow that folder's Shared switch,
/// and only while `~/.claude` is a watched folder whose switch Settings
/// shows: otherwise nobody could turn them off.
pub fn cloud_sessions_shared(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> bool {
    let login = real(&home.join(".claude"));
    let dirs = ClaudeDirs::from_env(env, home, &crate::relay::workspace::relay_home(env, home));
    dirs.cloud_sessions()
        && dirs
            .watched(&default_home(env, home))
            .into_iter()
            .any(|dir| dir.shared && real(&dir.path) == login)
}

/// Whether the person turned Claude Code cloud sessions on, in this
/// process's environment, whatever the `~/.claude` folder's Shared switch.
pub fn cloud_sessions_on_here() -> bool {
    let env = |key: &str| std::env::var(key).ok();
    crate::relay::paths::home().is_ok_and(|home| {
        ClaudeDirs::from_env(
            &env,
            &home,
            &crate::relay::workspace::relay_home(&env, &home),
        )
        .cloud_sessions()
    })
}

/// [`cloud_sessions_shared`] for this process's environment.
pub fn cloud_sessions_shared_here() -> bool {
    let env = |key: &str| std::env::var(key).ok();
    crate::relay::paths::home().is_ok_and(|home| cloud_sessions_shared(&env, &home))
}

/// Whether `transcript` is in one of `folders`, by path as written or real.
pub fn in_folders(transcript: &Path, folders: &[PathBuf]) -> bool {
    let real_transcript = real(transcript);
    folders.iter().any(|folder| {
        transcript.starts_with(folder)
            || real_transcript.starts_with(folder)
            || real_transcript.starts_with(real(folder))
    })
}

/// The `.claude` and `.claude-<name>` folders beside `default`, sorted.
pub fn siblings(default: &Path) -> Vec<PathBuf> {
    let Some(parent) = default.parent() else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name == ".claude" || name.starts_with(".claude-")
        })
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    found.sort();
    found
}

/// `CLAUDE_CONFIG_DIR` of each running Claude Code process of this user.
pub fn running_config_dirs(table: &dyn ProcessTable) -> Vec<PathBuf> {
    let uid = crate::relay::peer::current_uid();
    let mut found = Vec::new();
    for pid in table.all_pids() {
        if table.process(pid).is_none_or(|p| p.uid != uid) {
            continue;
        }
        if !is_claude_code(table, pid) {
            continue;
        }
        let Some(dir) = table
            .environment_var(pid, "CLAUDE_CONFIG_DIR")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let path = PathBuf::from(dir);
        if path.is_absolute() && !found.contains(&path) {
            found.push(path);
        }
    }
    found
}

/// Whether a file name is Claude Code's program: `claude`, and on Windows
/// the native `claude.exe` or npm's `claude.cmd` shim, in any letter case.
pub(crate) fn is_claude_name(name: &str) -> bool {
    if cfg!(windows) {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "claude" | "claude.exe" | "claude.cmd"
        )
    } else {
        name == "claude"
    }
}

/// A Claude Code process: `claude` by its first or second argument (the
/// native binary, or `node …/claude`), or Anthropic's Node package.
/// Whether `pid` runs Claude Code: its first or second argument is named
/// `claude`, or is Anthropic's npm package path (`node .../claude-code/cli.js`,
/// with either separator on Windows).
pub(crate) fn is_claude_code(table: &dyn ProcessTable, pid: i32) -> bool {
    let arguments = table.arguments(pid);
    arguments.iter().take(2).any(|argument| {
        let name = Path::new(argument)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        is_claude_name(&name)
            || argument.contains("@anthropic-ai/claude-code/")
            || (cfg!(windows) && argument.contains("@anthropic-ai\\claude-code\\"))
    })
}

/// A colon-separated list of folders (semicolons on Windows, where a drive
/// letter takes the colon); `~` is the home folder.
pub fn parse_list(value: &str, home: &Path) -> Vec<PathBuf> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut found = Vec::new();
    for part in value
        .split(separator)
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let path = expand_tilde(part, home);
        if path.is_absolute() && !found.contains(&path) {
            found.push(path);
        }
    }
    found
}

fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(&rest[1..]),
        _ => PathBuf::from(path),
    }
}

fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `claude-config-dirs.json.lock`, beside the file.
fn lock_path(file: &Path) -> PathBuf {
    let mut path = file.as_os_str().to_owned();
    path.push(".lock");
    PathBuf::from(path)
}

/// Length, modification time (seconds, nanoseconds) and inode of `file`,
/// which change whenever it is rewritten.
#[cfg(unix)]
fn file_stamp(file: &Path) -> Option<(u64, i64, i64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(file).ok()?;
    Some((m.len(), m.mtime(), m.mtime_nsec(), m.ino()))
}

/// Windows has no inode in std; the length and the modification time,
/// which `write_private`'s rename carries over from the new file, tell a
/// rewrite apart.
#[cfg(windows)]
fn file_stamp(file: &Path) -> Option<(u64, i64, i64, u64)> {
    let m = std::fs::metadata(file).ok()?;
    let modified = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some((
        m.len(),
        i64::try_from(modified.as_secs()).ok()?,
        i64::from(modified.subsec_nanos()),
        0,
    ))
}

/// An exclusive `flock` held until dropped (closing the file releases it).
struct FileLock(std::fs::File);

impl FileLock {
    fn exclusive(path: &Path) -> std::io::Result<FileLock> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = crate::platform::fs::private(
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false),
        )
        .open(path)?;
        FileLock::lock(file)
    }

    /// Windows: `LockFileEx` through fs2, held by the open handle as
    /// `flock` is by the descriptor.
    #[cfg(windows)]
    fn lock(file: std::fs::File) -> std::io::Result<FileLock> {
        fs2::FileExt::lock_exclusive(&file)?;
        Ok(FileLock(file))
    }

    #[cfg(unix)]
    fn lock(file: std::fs::File) -> std::io::Result<FileLock> {
        use std::os::unix::io::AsRawFd;
        loop {
            // SAFETY: `flock` takes the descriptor of a file this owns.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                return Ok(FileLock(file));
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

fn write_private(file: &Path, recorded: &Recorded) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut bytes = serde_json::to_vec_pretty(recorded)?;
    bytes.push(b'\n');
    let mut temporary = file.as_os_str().to_owned();
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    temporary.push(format!(".{}.{next}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    let mut out = crate::platform::fs::private(
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true),
    )
    .open(&temporary)?;
    out.write_all(&bytes)?;
    out.sync_all()?;
    // Closed before the rename, so no handle of this core outlives it.
    drop(out);
    std::fs::rename(&temporary, file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};

    fn dirs(root: &Path) -> ClaudeDirs {
        ClaudeDirs {
            environment: Vec::new(),
            file: Some(root.join("relay").join(FILE)),
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_environment_list_is_semicolon_separated_on_windows() {
        let home = Path::new(r"C:\Users\m");
        assert_eq!(
            parse_list(r" ~/.seclaude;;D:\claude;relative;~/.seclaude", home),
            vec![
                PathBuf::from(r"C:\Users\m").join(".seclaude"),
                PathBuf::from(r"D:\claude")
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_environment_list_is_colon_separated_with_tilde() {
        let home = Path::new("/Users/m");
        assert_eq!(
            parse_list(" ~/.seclaude::/opt/claude:relative:~/.seclaude", home),
            vec![
                PathBuf::from("/Users/m/.seclaude"),
                PathBuf::from("/opt/claude")
            ]
        );
        let env = |key: &str| (key == DIRS_ENV).then(|| "~/.seclaude".to_string());
        let dirs = ClaudeDirs::from_env(&env, home, Path::new("/Users/m/.agentworkforce/relay"));
        assert_eq!(dirs.environment, vec![PathBuf::from("/Users/m/.seclaude")]);
        assert_eq!(
            dirs.file,
            Some(PathBuf::from("/Users/m/.agentworkforce/relay").join(FILE))
        );
    }

    #[test]
    fn cloud_sessions_follow_the_watched_home_claude_folder() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let relay = home.join("relay");
        std::fs::create_dir_all(&relay).unwrap();
        let env_with = |config_dir: Option<PathBuf>| {
            let relay = relay.clone();
            move |key: &str| match key {
                "AGENT_RELAY_HOME" => Some(relay.display().to_string()),
                "CLAUDE_CONFIG_DIR" => config_dir.as_ref().map(|d| d.display().to_string()),
                _ => None,
            }
        };
        assert!(is_cloud_session("cse_01A") && is_cloud_session("session_01A"));
        assert!(!is_cloud_session("0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d"));
        // Off until the person turns them on.
        assert!(!cloud_sessions_shared(&env_with(None), home));
        let dirs = ClaudeDirs::from_env(&env_with(None), home, &relay);
        dirs.set_cloud_sessions(true).unwrap();
        // `~/.claude` is the watched default and shared.
        assert!(cloud_sessions_shared(&env_with(None), home));
        // Claude Code runs from another folder: `~/.claude` has no switch.
        let elsewhere = home.join("work").join(".seclaude");
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert!(!cloud_sessions_shared(&env_with(Some(elsewhere)), home));
        // Turned off in Settings.
        let mut recorded = Recorded {
            cloud_sessions: true,
            ..Recorded::default()
        };
        recorded
            .folders
            .insert(home.join(".claude"), FolderChoice { shared: false });
        std::fs::write(relay.join(FILE), serde_json::to_vec(&recorded).unwrap()).unwrap();
        assert!(!cloud_sessions_shared(&env_with(None), home));
        // Turned back off.
        recorded.folders.clear();
        std::fs::write(relay.join(FILE), serde_json::to_vec(&recorded).unwrap()).unwrap();
        assert!(cloud_sessions_shared(&env_with(None), home));
        dirs.set_cloud_sessions(false).unwrap();
        assert!(!cloud_sessions_shared(&env_with(None), home));
    }

    #[test]
    #[cfg(unix)]
    fn watched_lists_each_folder_once_with_why() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let default = root.join(".claude");
        let sibling = root.join(".claude-work");
        let seclaude = root.join(".seclaude");
        let added = root.join("added-claude");
        let running = root.join("running-claude");
        for dir in [&default, &sibling, &seclaude, &added, &running] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::os::unix::fs::symlink(&seclaude, root.join("link-to-seclaude")).unwrap();
        let mut dirs = dirs(root);
        dirs.environment = vec![seclaude.clone(), root.join("missing")];
        dirs.set_added(
            &[
                added.display().to_string(),
                root.join("link-to-seclaude").display().to_string(),
            ],
            root,
        )
        .unwrap();
        dirs.record_running(&[running.clone(), default.clone()]);
        let watched = dirs.watched(&default);
        let dir = |path: &PathBuf, origin| WatchedDir {
            path: path.clone(),
            origin,
            shared: true,
        };
        assert_eq!(
            watched,
            vec![
                dir(&default, Origin::Default),
                dir(&sibling, Origin::Sibling),
                dir(&seclaude, Origin::Environment),
                dir(&added, Origin::Added),
                dir(&running, Origin::Running),
            ]
        );
        assert_eq!(
            dirs.extra_homes(&default),
            vec![
                sibling.clone(),
                seclaude.clone(),
                added.clone(),
                running.clone()
            ]
        );

        // Only ~/.seclaude is shared: every other folder stays out.
        for folder in [&default, &sibling, &added, &running] {
            dirs.set_shared(&folder.display().to_string(), false, &default)
                .unwrap();
        }
        assert!(!dirs.default_shared(&default));
        assert_eq!(dirs.extra_homes(&default), vec![seclaude.clone()]);
        let unshared = dirs.unshared(&default);
        assert_eq!(
            unshared,
            vec![
                default.clone(),
                sibling.clone(),
                added.clone(),
                running.clone()
            ]
        );
        assert!(in_folders(&default.join("projects/p/s.jsonl"), &unshared));
        assert!(!in_folders(&seclaude.join("projects/p/s.jsonl"), &unshared));
        // A link names the folder it links to.
        let link = root.join("link-to-seclaude").display().to_string();
        dirs.set_shared(&link, false, &default).unwrap();
        assert!(dirs.extra_homes(&default).is_empty());
        dirs.set_shared(&seclaude.display().to_string(), true, &default)
            .unwrap();
        assert_eq!(dirs.extra_homes(&default), vec![seclaude.clone()]);
        dirs.set_shared(&default.display().to_string(), true, &default)
            .unwrap();
        assert!(dirs.default_shared(&default));
        assert!(dirs
            .set_shared(&root.join("missing").display().to_string(), false, &default)
            .is_err());
        // Shared is the default and is not written down.
        assert!(!dirs.recorded().folders.contains_key(&default));
    }

    // Review on #426: the core and the probe both write the file; neither
    // may lose the other's change.
    #[test]
    fn concurrent_changes_are_all_kept() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let default = root.join(".claude");
        std::fs::create_dir(&default).unwrap();
        let folders: Vec<PathBuf> = (0..16).map(|i| root.join(format!("seen-{i}"))).collect();
        for folder in &folders {
            std::fs::create_dir(folder).unwrap();
        }
        let threads: Vec<_> = folders
            .iter()
            .cloned()
            .map(|folder| {
                let dirs = dirs(&root);
                std::thread::spawn(move || {
                    dirs.record_running(&[folder]);
                })
            })
            .chain(std::iter::once({
                let dirs = dirs(&root);
                let default = default.clone();
                std::thread::spawn(move || {
                    dirs.set_shared(&default.display().to_string(), false, &default)
                        .unwrap()
                })
            }))
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let recorded = dirs(&root).recorded();
        assert_eq!(recorded.running.len(), folders.len());
        assert!(!recorded.choice(&default).shared);
    }

    #[test]
    fn added_folders_must_exist_and_replace_the_last_list() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let one = root.join("one");
        std::fs::create_dir(&one).unwrap();
        let dirs = dirs(root);
        assert!(dirs.set_added(&["relative".into()], root).is_err());
        assert!(dirs
            .set_added(&[root.join("nope").display().to_string()], root)
            .is_err());
        dirs.set_added(&[one.display().to_string()], root).unwrap();
        assert_eq!(dirs.recorded().added, vec![one]);
        dirs.set_added(&[], root).unwrap();
        assert!(dirs.recorded().added.is_empty());
    }

    /// A folder saved as added stays added once deleted, by its `~` path
    /// too; one never added is not.
    #[test]
    fn an_added_folder_is_known_by_its_saved_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let one = root.join("one");
        std::fs::create_dir(&one).unwrap();
        let dirs = dirs(root);
        dirs.set_added(&[one.display().to_string()], root).unwrap();
        std::fs::remove_dir(&one).unwrap();
        assert!(dirs.is_added(&format!(" {} ", one.display()), root));
        assert!(dirs.is_added("~/one", root));
        assert!(!dirs.is_added(&root.join("two").display().to_string(), root));
    }

    #[test]
    fn remembering_running_folders_never_overwrites_malformed_choices() {
        let temp = tempfile::tempdir().unwrap();
        let dirs = dirs(temp.path());
        let seen = temp.path().join(".claude-work");
        std::fs::create_dir(&seen).unwrap();
        let file = dirs.file.as_ref().unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, b"{").unwrap();
        assert!(!dirs.record_running(&[seen]));
        assert_eq!(std::fs::read(file).unwrap(), b"{");
    }

    #[test]
    fn running_folders_are_kept_until_they_are_gone() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let seen = root.join(".seclaude");
        std::fs::create_dir(&seen).unwrap();
        let dirs = dirs(root);
        dirs.record_running(std::slice::from_ref(&seen));
        dirs.record_running(&[]);
        assert_eq!(dirs.recorded().running, vec![seen.clone()]);
        std::fs::remove_dir(&seen).unwrap();
        dirs.record_running(&[]);
        assert!(dirs.recorded().running.is_empty());
    }

    // Unix process fixtures: `/Users/…` folders are not absolute on Windows.
    #[cfg(unix)]
    #[test]
    fn running_claude_processes_name_their_config_folder() {
        let table = FakeProcesses::default();
        let uid = crate::relay::peer::current_uid();
        let process = |uid: u32| FakeProcess {
            parent: 1,
            uid,
            ..FakeProcess::default()
        };
        let mut claude = process(uid);
        claude.arguments = vec!["claude".into(), "--resume".into()];
        claude
            .environment
            .insert("CLAUDE_CONFIG_DIR".into(), "/Users/m/.seclaude".into());
        table.insert(10, claude);
        let mut node = process(uid);
        node.arguments = vec![
            "node".into(),
            "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js".into(),
        ];
        node.environment
            .insert("CLAUDE_CONFIG_DIR".into(), "/Users/m/.other".into());
        table.insert(11, node);
        let mut shell = process(uid);
        shell.arguments = vec!["zsh".into()];
        shell
            .environment
            .insert("CLAUDE_CONFIG_DIR".into(), "/Users/m/.shell".into());
        table.insert(12, shell);
        let mut plain = process(uid);
        plain.arguments = vec!["/home/m/.local/bin/claude".into()];
        table.insert(13, plain);
        let mut theirs = process(uid + 1);
        theirs.arguments = vec!["claude".into()];
        theirs
            .environment
            .insert("CLAUDE_CONFIG_DIR".into(), "/Users/x/.claude".into());
        table.insert(14, theirs);
        let mut found = running_config_dirs(&table);
        found.sort();
        assert_eq!(
            found,
            vec![
                PathBuf::from("/Users/m/.other"),
                PathBuf::from("/Users/m/.seclaude")
            ]
        );
    }
}
