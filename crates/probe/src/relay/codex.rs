//! Codex threads on this computer: discovery, liveness, the routes a
//! message takes into a thread, and the thread's final answers.
//!
//! | Module | Owns |
//! |---|---|
//! | `threads` | Codex's thread records (`state_5.sqlite`) |
//! | `rollout` | A thread's session file: running turns, recorded messages, replies |
//! | `queue` | `codex queue` and Codex's queue (`queue_1.sqlite`) |
//! | `app_server` | The shared app-server over `codex app-server proxy` (WebSocket, JSON-RPC) |
//! | `ipc` | The Codex desktop app's window router socket |
//! | `processes` | Threads backed by live trusted Codex processes |
//! | `router` | `CodexRouter`: which route a message takes, and when it counts as delivered |
//! | `runner` | Running the Codex command line, behind a trait tests fake |
//! | `stop_hook` | Agent Relay's Codex hook: its setting, and Conductor's chats |
//! | `turn_hook` | Messages the hook hands into a running turn, and each one's route claim |
//!
//! Every path comes from a `CodexConfig`, so tests point it at a temporary
//! directory and never reach a real Codex.

pub mod app_server;
pub mod compact;
pub mod hidden_order;
pub mod ipc;
pub mod follower;
pub mod processes;
pub mod queue;
pub mod rollout;
pub mod router;
pub mod runner;
pub mod stall;
pub mod stop_hook;
pub mod threads;
pub mod turn_hook;

pub use processes::CodexProcessSession;
pub use router::{CodexRouter, CodexRoutes, QueueError, SystemCodexRoutes};
pub use threads::CodexThread;

use crate::relay::delivery::final_answer::capped;
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{SessionKind, Target};
use runner::{CodexRunner, SystemRunner};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Where this computer's Codex keeps its state and command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexConfig {
    /// Codex home: `CODEX_HOME`, else `~/.codex`.
    pub home: PathBuf,
    /// Codex's SQLite home: `CODEX_SQLITE_HOME`, else `CODEX_HOME`.
    /// Fleet PTY workers isolate their queue and thread catalog here while
    /// keeping rollouts under the ordinary Codex home.
    pub sqlite_home: PathBuf,
    /// The `codex` command line that runs `codex queue`, when installed.
    pub executable: Option<PathBuf>,
    /// The Codex desktop app's window router socket.
    pub ipc_socket: PathBuf,
}

fn expand(value: &str, home: &Path) -> PathBuf {
    match value.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if value == "~" => home.to_path_buf(),
        None => PathBuf::from(value),
    }
}

/// A file this user can run: an execute bit on Unix, a `PATHEXT`
/// extension (`codex.exe`, npm's `codex.cmd`) on Windows.
fn is_executable_file(path: &Path) -> bool {
    crate::platform::exe::is_executable(path)
}

/// A version manager's shim re-resolves `codex` per directory and can run
/// another build; only a real install is used.
fn is_shim(path: &Path) -> bool {
    let shim = |p: &Path| {
        let text = p.to_string_lossy();
        text.contains("/mise/shims/") || (cfg!(windows) && text.contains(r"\mise\shims\"))
    };
    shim(path) || std::fs::canonicalize(path).is_ok_and(|real| shim(&real))
}

/// Version directories newest first: `0.154.0` before `0.99.0`, and a
/// release before its prereleases.
#[cfg_attr(windows, allow(dead_code))]
fn newest_first(
    mut paths: Vec<PathBuf>,
    version_of: impl Fn(&Path) -> Option<String>,
) -> Vec<PathBuf> {
    // The release numbers, then a release above its prereleases
    // (`0.154.1` above `0.154.1-alpha`), then the prerelease label.
    let key = |path: &PathBuf| -> (Vec<u64>, bool, String) {
        let version = version_of(path).unwrap_or_default();
        let version = version.trim_start_matches('v');
        let (release, prerelease) = version.split_once('-').unwrap_or((version, ""));
        let numbers = release
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect();
        (numbers, prerelease.is_empty(), prerelease.to_string())
    };
    paths.sort_by_key(|path| std::cmp::Reverse(key(path)));
    paths
}

/// `<root>/<version>/bin/codex` for every version directory under `root`.
#[cfg(not(windows))]
fn versions(root: &Path) -> Vec<PathBuf> {
    let found = std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path().join("bin/codex"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    newest_first(found, |path| {
        let version = path.parent()?.parent()?.file_name()?;
        Some(version.to_string_lossy().into_owned())
    })
}

/// Resolve npm's launcher to its bundled native executable so desktop apps
/// and systemd services do not need Node on their PATH. Follow symlinks first
/// (Homebrew, npm and pnpm expose the launcher through them).
#[cfg(unix)]
fn npm_native_executable(launcher: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(launcher).ok()?;
    if real.file_name()? != "codex.js" || real.parent()?.file_name()? != "bin" {
        return None;
    }
    let root = real.parent()?.parent()?;
    let (triple, package) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("aarch64-apple-darwin", "codex-darwin-arm64"),
        ("macos", "x86_64") => ("x86_64-apple-darwin", "codex-darwin-x64"),
        ("linux", "aarch64") => ("aarch64-unknown-linux-musl", "codex-linux-arm64"),
        ("linux", "x86_64") => ("x86_64-unknown-linux-musl", "codex-linux-x64"),
        _ => return None,
    };
    // Node resolves optional dependencies from the package's node_modules,
    // then ancestor node_modules directories (including hoisted installs).
    root.ancestors()
        .map(|dir| {
            dir.join("node_modules/@openai")
                .join(package)
                .join("vendor")
        })
        .chain(std::iter::once(root.join("vendor")))
        .map(|vendor| vendor.join(triple).join("bin/codex"))
        .find(|path| is_executable_file(path))
}

/// Where a `codex` command line may be installed, in order of preference:
/// the binary inside the Codex desktop app (the very build that reads the
/// queue for app threads), version-managed installs, the usual command-line
/// locations, then `PATH`. An app launched from the desktop has no shell
/// `PATH`, so the fixed locations come first.
pub fn executable_candidates(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        windows_executable_candidates(env, home)
    }
    #[cfg(not(windows))]
    {
        unix_executable_candidates(env, home)
    }
}

/// `executable_candidates` on Windows: npm's global folder (where
/// `npm install -g @openai/codex` puts `codex.cmd`; an app started from the
/// Start menu still has it on `PATH`, but a logon task may not), the
/// person's `.local\bin`, then `PATH`. Each folder is tried with every
/// `PATHEXT` name (`codex.exe` before `codex.cmd`), never the bare `codex`,
/// which is npm's POSIX-shell script.
#[cfg(windows)]
fn windows_executable_candidates(
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
) -> Vec<PathBuf> {
    let names = crate::platform::exe::command_names("codex");
    let set = |key: &str| env(key).filter(|value| !value.trim().is_empty());
    let mut folders = Vec::new();
    folders.push(
        set("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(r"AppData\Roaming"))
            .join("npm"),
    );
    folders.push(home.join(r".local\bin"));
    if let Some(path) = set("PATH") {
        folders.extend(std::env::split_paths(&path).filter(|dir| dir.is_absolute()));
    }
    let mut candidates: Vec<PathBuf> = folders
        .iter()
        .flat_map(|folder| names.iter().map(move |name| folder.join(name)))
        .collect();
    candidates.retain(|path| !is_shim(path));
    candidates
}

#[cfg(not(windows))]
fn unix_executable_candidates(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from(
            "/Applications/ChatGPT.app/Contents/Resources/codex",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Codex.app/Contents/Resources/codex",
        ));
    }
    if cfg!(target_os = "macos") {
        for app in ["ChatGPT", "Codex"] {
            candidates.push(PathBuf::from(format!(
                "/Applications/{app}.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
            )));
        }
    }
    let mise = home.join(".local/share/mise/installs/codex");
    candidates.push(mise.join("latest/bin/codex"));
    candidates.push(home.join(".local/bin/codex"));
    candidates.extend(versions(&mise));
    candidates.extend(versions(&home.join(".nvm/versions/node")));
    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
    candidates.push(PathBuf::from("/usr/local/bin/codex"));
    if let Some(path) = env("PATH") {
        candidates.extend(
            path.split(':')
                .filter(|dir| dir.starts_with('/'))
                .map(|dir| Path::new(dir).join("codex")),
        );
    }
    candidates.retain(|path| !is_shim(path));
    candidates
        .into_iter()
        .flat_map(|path| {
            npm_native_executable(&path)
                .into_iter()
                .chain(std::iter::once(path))
        })
        .collect()
}

impl CodexConfig {
    /// `CODEX_HOME` else `~/.codex`; `RELAY_DESKTOP_CODEX` (exactly that
    /// file, or none) else the first installed candidate of
    /// `executable_candidates`; never a version-manager shim.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> CodexConfig {
        let set = |key: &str| {
            env(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let codex_home = set("CODEX_HOME")
            .map(|value| expand(&value, home))
            .unwrap_or_else(|| home.join(".codex"));
        let sqlite_home = set("CODEX_SQLITE_HOME")
            .map(|value| expand(&value, home))
            .unwrap_or_else(|| codex_home.clone());
        let executable = match set("RELAY_DESKTOP_CODEX") {
            Some(value) => {
                Some(expand(&value, home)).filter(|path| is_executable_file(path) && !is_shim(path))
            }
            None => executable_candidates(env, home)
                .into_iter()
                .find(|path| is_executable_file(path)),
        };
        CodexConfig {
            ipc_socket: codex_home.join("ipc/ipc.sock"),
            home: codex_home,
            sqlite_home,
            executable,
        }
    }
}

/// Codex threads on this computer as sessions (title, directory,
/// updated_at_ms, live): the 40 most recently updated, newest first. Empty
/// when Codex's database cannot be read; `try_discover` tells the two apart.
pub fn discover(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<DiscoveredSession> {
    try_discover(config, table, uid).unwrap_or_default()
}

/// How many threads discovery lists.
pub const DISCOVERY_LIMIT: usize = 40;

/// `discover`, or `None` when Codex's database cannot be read this pass, so
/// the caller can keep the last list rather than empty it while Codex holds
/// a lock.
pub fn try_discover(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Option<Vec<DiscoveredSession>> {
    try_discover_with(config, table, uid, &SystemRunner)
}

fn try_discover_with(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
    runner: &dyn CodexRunner,
) -> Option<Vec<DiscoveredSession>> {
    let threads = threads::read_recent(config, DISCOVERY_LIMIT)?;
    let ids: BTreeSet<String> = threads.iter().map(|t| t.id.to_lowercase()).collect();
    let process_sessions = processes::process_sessions(table, uid, &ids);
    let paseo_threads = processes::paseo_threads(table, uid, &process_sessions);
    let mut live: BTreeSet<String> = process_sessions
        .iter()
        .filter(|session| processes::drains_queue(table, uid, session.pid))
        .map(|session| session.thread.clone())
        .collect();
    if live.len() < ids.len() {
        live.extend(loaded_threads(config, table, uid, runner));
    }
    let unknown: Vec<String> = threads
        .iter()
        .filter(|t| !live.contains(&t.id.to_lowercase()))
        .map(|t| t.id.clone())
        .collect();
    live.extend(
        ipc::open_threads(&config.ipc_socket, &unknown)
            .into_keys()
            .map(|id| id.to_lowercase()),
    );
    Some(
        threads
            .into_iter()
            .map(|thread| {
                let is_live = live.contains(&thread.id.to_lowercase());
                let host = paseo_threads
                    .contains(&thread.id.to_lowercase())
                    .then(|| crate::relay::paseo::HOST.to_string());
                session(thread, is_live, host)
            })
            .collect(),
    )
}

fn session(thread: CodexThread, live: bool, host: Option<String>) -> DiscoveredSession {
    DiscoveredSession {
        // One spelling everywhere: caller identification lowercases the
        // thread ids it reads from the kernel, and `Target` compares exactly.
        target: Target::new(SessionKind::Codex, thread.id.to_lowercase()),
        title: thread.title,
        directory: thread.directory,
        updated_at_ms: thread.updated_at_ms,
        host,
        live,
        holder: None,
    }
}

/// One thread by id, outside the bounded discovery list, for a session
/// that identified itself on the relay-send socket: archived, sub-agent and
/// unknown threads are not found. `live` is true: the caller is running in
/// it.
pub fn thread(config: &CodexConfig, id: &str) -> Option<DiscoveredSession> {
    threads::read_one(config, id).map(|thread| session(thread, true, None))
}

/// The threads the shared app-server has loaded now; none when no trusted
/// Codex runs.
pub fn app_server_loaded(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> BTreeSet<String> {
    loaded_threads(config, table, uid, &SystemRunner)
}

/// The threads the shared app-server has loaded, through a live Codex's
/// proxy; none when no Codex runs.
fn loaded_threads(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
    runner: &dyn CodexRunner,
) -> BTreeSet<String> {
    let Some(executable) = processes::running_executable(table, uid) else {
        return BTreeSet::new();
    };
    let Ok(mut stream) = runner.proxy_in_home(&executable, &config.home, &config.sqlite_home)
    else {
        return BTreeSet::new();
    };
    app_server::loaded_threads(stream.as_mut(), app_server::LOADED_TIMEOUT)
        .into_iter()
        .map(|id| id.to_lowercase())
        .collect()
}

/// Whether a reply command could work for this thread now: a command it
/// runs could be identified on the relay-send socket, because a trusted
/// live Codex holds this thread's writer lock (alone, or in a signed shared
/// app-server), or an older Codex runs `resume <thread>`
/// (`processes::reply_capable`).
pub fn thread_is_live(
    _config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
    thread: &str,
) -> bool {
    processes::reply_capable(table, uid, thread)
}

/// The person's most recently updated Codex threads, newest first (see
/// `threads::read_recent`); empty when the database cannot be read.
pub fn recent_threads(config: &CodexConfig, limit: usize) -> Vec<CodexThread> {
    threads::read_recent(config, limit).unwrap_or_default()
}

/// How many recent threads the Codex app is asked about.
const WINDOW_CATALOG: usize = 500;

/// The threads open now: those a trusted live Codex of this user holds the
/// writer lock for or resumed, and those a Codex app window owns.
pub fn open_thread_ids(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> BTreeSet<String> {
    let mut open = processes::open_threads(table, uid);
    if config.ipc_socket.exists() {
        let recent: Vec<String> = recent_threads(config, WINDOW_CATALOG)
            .into_iter()
            .map(|t| t.id)
            .filter(|id| !open.contains(&id.to_lowercase()))
            .collect();
        open.extend(
            ipc::open_threads(&config.ipc_socket, &recent)
                .into_keys()
                .map(|id| id.to_lowercase()),
        );
    }
    open
}

/// The thread's final answer to the turn whose prompt carried
/// `message_ref`, once that turn completed (from its rollout); `None` while
/// it runs, when it was aborted, or when the rollout cannot say.
pub fn final_answer(config: &CodexConfig, thread: &str, message_ref: &str) -> Option<String> {
    let path = rollout::rollout_path(config, thread)?;
    rollout::RolloutSummary::read(&path)?
        .reply_to(message_ref)
        .and_then(capped)
}

/// Removes the relay's own expired items from Codex's queue (see
/// `queue::cleanup_expired_owned`).
pub fn cleanup_expired_queue(config: &CodexConfig, now_ms: i64) {
    queue::cleanup_expired_owned(config, now_ms);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::codex::app_server::tests::FakeAppServer;
    #[cfg(unix)]
    use crate::relay::codex::ipc::tests::FakeRouter;
    use crate::relay::codex::processes::tests::{
        codex, codex_process, lock, process, trusted_table, UID,
    };
    use crate::relay::codex::runner::tests::FakeRunner;
    use crate::relay::codex::threads::tests::{config, seed, THREAD};
    use crate::relay::process::FakeProcess;
    use std::collections::HashMap;
    #[cfg(unix)]
    use std::sync::{Arc, Mutex};

    const SECOND: &str = "01a0c221-6806-7210-af25-97e104b15050";
    const THIRD: &str = "01a0c221-6806-7210-af25-97e104b15051";

    fn env(values: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let values: HashMap<String, String> = values
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| values.get(key).cloned()
    }

    fn executable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"not a real codex").unwrap();
        crate::platform::fs::set_mode(path, 0o700).unwrap();
    }

    /// An installed Codex's file name relative to a folder: Windows runs
    /// only a `PATHEXT` name.
    const BIN_CODEX: &str = if cfg!(windows) {
        "bin/codex.exe"
    } else {
        "bin/codex"
    };

    // codex_home and CodexBridge.codexHome.
    #[test]
    fn codex_home_is_codex_home_else_dot_codex() {
        let home = tempfile::tempdir().unwrap();
        let override_path = home.path().join(BIN_CODEX);
        executable(&override_path);
        let pinned = |values: &[(&str, &str)]| {
            let mut values = values.to_vec();
            values.push(("RELAY_DESKTOP_CODEX", override_path.to_str().unwrap()));
            CodexConfig::from_env(&env(&values), home.path())
        };
        let config = pinned(&[]);
        assert_eq!(config.home, home.path().join(".codex"));
        assert_eq!(config.sqlite_home, home.path().join(".codex"));
        assert_eq!(config.ipc_socket, home.path().join(".codex/ipc/ipc.sock"));
        assert_eq!(
            pinned(&[("CODEX_HOME", "/srv/codex")]).home,
            PathBuf::from("/srv/codex")
        );
        assert_eq!(
            pinned(&[("CODEX_HOME", "~/alt")]).home,
            home.path().join("alt")
        );
        assert_eq!(
            pinned(&[("CODEX_HOME", "  ")]).home,
            home.path().join(".codex")
        );
        assert_eq!(
            pinned(&[("CODEX_HOME", "/srv/codex")]).sqlite_home,
            PathBuf::from("/srv/codex")
        );
        assert_eq!(
            pinned(&[("CODEX_SQLITE_HOME", "~/fleet-db")]).sqlite_home,
            home.path().join("fleet-db")
        );
    }

    // CodexQueueBridge.candidates (RELAY_DESKTOP_CODEX) and _codex_binary.
    #[test]
    fn the_override_is_that_file_or_none() {
        let home = tempfile::tempdir().unwrap();
        let installed = home.path().join(BIN_CODEX);
        executable(&installed);
        let config = CodexConfig::from_env(
            &env(&[("RELAY_DESKTOP_CODEX", installed.to_str().unwrap())]),
            home.path(),
        );
        assert_eq!(config.executable, Some(installed.clone()));
        let pinned_tilde = format!("~/{BIN_CODEX}");
        let tilde = CodexConfig::from_env(
            &env(&[("RELAY_DESKTOP_CODEX", pinned_tilde.as_str())]),
            home.path(),
        );
        assert_eq!(tilde.executable, Some(installed));
        let missing = home.path().join("nothing/codex");
        let config = CodexConfig::from_env(
            &env(&[("RELAY_DESKTOP_CODEX", missing.to_str().unwrap())]),
            home.path(),
        );
        assert_eq!(
            config.executable, None,
            "no fallback past a broken override"
        );
        let plain = home.path().join("plain");
        std::fs::write(&plain, b"x").unwrap();
        let config = CodexConfig::from_env(
            &env(&[("RELAY_DESKTOP_CODEX", plain.to_str().unwrap())]),
            home.path(),
        );
        assert_eq!(config.executable, None, "not executable");
    }

    // test_codex_delivery_uses_real_mise_install_instead_of_manager_shim and
    // test_codex_delivery_finds_a_version_pinned_mise_install.
    #[cfg(unix)]
    #[test]
    fn candidates_prefer_real_installs_and_never_a_shim() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let shims = home.join(".local/share/mise/shims");
        let path = format!("{}:relative:/usr/bin", shims.display());
        let candidates = executable_candidates(&env(&[("PATH", &path)]), home);
        let mise = home.join(".local/share/mise/installs/codex");
        assert!(!candidates.iter().any(|c| c.starts_with(&shims)));
        assert!(!candidates.iter().any(|c| c.starts_with("relative")));
        let position = |p: &Path| candidates.iter().position(|c| c == p).unwrap();
        assert!(
            position(&mise.join("latest/bin/codex")) < position(&home.join(".local/bin/codex"))
        );
        assert!(
            position(&home.join(".local/bin/codex")) < position(Path::new("/usr/local/bin/codex"))
        );
        assert_eq!(candidates.last(), Some(&PathBuf::from("/usr/bin/codex")));
        if cfg!(target_os = "macos") {
            assert_eq!(
                candidates[0],
                PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex")
            );
        }
        // Version-pinned installs, newest first.
        for version in ["0.99.0", "0.154.0", "0.154.1-alpha"] {
            std::fs::create_dir_all(mise.join(version).join("bin")).unwrap();
        }
        std::fs::create_dir_all(home.join(".nvm/versions/node/v22.1.0/bin")).unwrap();
        let candidates = executable_candidates(&env(&[]), home);
        let pinned: Vec<&PathBuf> = candidates
            .iter()
            .filter(|c| c.starts_with(&mise) && !c.starts_with(mise.join("latest")))
            .collect();
        assert_eq!(
            pinned,
            [
                &mise.join("0.154.1-alpha/bin/codex"),
                &mise.join("0.154.0/bin/codex"),
                &mise.join("0.99.0/bin/codex")
            ]
        );
        assert!(candidates.contains(&home.join(".nvm/versions/node/v22.1.0/bin/codex")));
        // A symlink into the shims is a shim too.
        executable(&shims.join("codex"));
        std::fs::create_dir_all(home.join("links")).unwrap();
        std::os::unix::fs::symlink(shims.join("codex"), home.join("links/codex")).unwrap();
        assert!(is_shim(&home.join("links/codex")));
        assert!(!is_shim(&mise.join("0.99.0/bin/codex")));
    }

    #[cfg(unix)]
    #[test]
    fn npm_launchers_resolve_native_binaries_without_node() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().canonicalize().unwrap();
        let root = home.as_path().join("lib/node_modules/@openai/codex");
        let launcher = root.join("bin/codex.js");
        executable(&launcher);
        std::fs::write(&launcher, "#!/usr/bin/env node\nprocess.exit(1)\n").unwrap();
        let link = home.as_path().join("bin/codex");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&launcher, &link).unwrap();
        assert_eq!(npm_native_executable(&link), None);
        let triple = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "aarch64-apple-darwin",
            ("macos", "x86_64") => "x86_64-apple-darwin",
            ("linux", "aarch64") => "aarch64-unknown-linux-musl",
            ("linux", "x86_64") => "x86_64-unknown-linux-musl",
            _ => return,
        };
        let package = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => "codex-darwin-arm64",
            ("macos", _) => "codex-darwin-x64",
            ("linux", "aarch64") => "codex-linux-arm64",
            _ => "codex-linux-x64",
        };
        // Legacy vendor, nested optional dependency, and hoisted dependency.
        for vendor in [
            root.join("vendor"),
            root.join("node_modules/@openai")
                .join(package)
                .join("vendor"),
            home.as_path()
                .join("lib/node_modules/@openai")
                .join(package)
                .join("vendor"),
        ] {
            let native = vendor.join(triple).join("bin/codex");
            executable(&native);
            std::fs::write(&native, "#!/bin/sh\nprintf 'Queued message fixture\\n'\n").unwrap();
            assert_eq!(npm_native_executable(&link), Some(native.clone()));
            let candidates = executable_candidates(
                &env(&[("PATH", link.parent().unwrap().to_str().unwrap())]),
                home.as_path(),
            );
            let at = candidates.iter().position(|p| p == &link).unwrap();
            assert_eq!(candidates[at - 1], native);
            let output = std::process::Command::new(&candidates[at - 1])
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .args(["queue", "--help"])
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(String::from_utf8_lossy(&output.stdout).contains("Queued message fixture"));
            std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(
                npm_native_executable(&link),
                None,
                "reject non-executable payloads"
            );
            std::fs::remove_file(native).unwrap();
        }
        let plain = home.as_path().join("plain/codex");
        executable(&plain);
        assert_eq!(npm_native_executable(&plain), None);
    }

    // Windows: npm's global folder first, then PATH, each with its PATHEXT
    // names, never a mise shim and never npm's bare POSIX-shell `codex`.
    #[cfg(windows)]
    #[test]
    fn windows_candidates_take_npm_and_path_with_their_extensions() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let npm = home.join("roaming").join("npm");
        let tools = home.join("tools");
        let shims = home.join(r"AppData\Local\mise\shims");
        let path = std::env::join_paths([&shims, &tools, Path::new("relative")]).unwrap();
        let values = [
            (
                "APPDATA",
                home.join("roaming").to_string_lossy().into_owned(),
            ),
            ("PATH", path.to_string_lossy().into_owned()),
        ];
        let values: Vec<(&str, &str)> = values.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let candidates = executable_candidates(&env(&values), home);
        let position = |p: &Path| candidates.iter().position(|c| c == p).unwrap();
        assert!(position(&npm.join("codex.cmd")) < position(&tools.join("codex.exe")));
        assert!(position(&tools.join("codex.exe")) < position(&tools.join("codex.cmd")));
        assert!(!candidates.iter().any(|c| c.starts_with(&shims)));
        assert!(!candidates.iter().any(|c| c.starts_with("relative")));
        assert!(!candidates.contains(&npm.join("codex")));
        // npm's shim is what an installed Codex resolves to.
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::write(npm.join("codex"), "#!/bin/sh\n").unwrap();
        std::fs::write(npm.join("codex.cmd"), "@echo off\r\n").unwrap();
        let config = CodexConfig::from_env(&env(&values), home);
        assert_eq!(config.executable, Some(npm.join("codex.cmd")));
    }

    fn runner_hosting(loaded: &[&str]) -> FakeRunner {
        let runner = FakeRunner::default();
        runner
            .streams
            .lock()
            .unwrap()
            .push_back(Box::new(FakeAppServer::hosting(loaded, None)));
        runner
    }

    fn add_thread(db: &rusqlite::Connection, id: &str, updated: i64) {
        db.execute(
            "insert into threads values (?1, '', 'Fix tests', '/code/relay', ?2, 0, 'cli', null)",
            (id, updated),
        )
        .unwrap();
    }

    // InjectableAgents.discover (Codex): a running TUI, the app-server's
    // loaded threads and an owning window each make a thread live.
    #[test]
    fn discovery_marks_live_threads() {
        let home = tempfile::tempdir().unwrap();
        let mut config = config(home.path());
        let db = seed(home.path(), "wal");
        add_thread(&db, SECOND, 1_790_659_487);
        add_thread(&db, THIRD, 1_790_659_488);
        let table = trusted_table();
        table.insert(600, codex_process(10, &["codex", "resume", THREAD]));
        // An exec run is not a session that takes messages.
        table.insert(601, codex_process(11, &["codex", "exec", "resume", SECOND]));
        table.insert(
            602,
            FakeProcess {
                open_files: vec![lock(THIRD)],
                ..codex_process(12, &["codex", "app-server"])
            },
        );
        let runner = runner_hosting(&[THIRD]);
        let found = try_discover_with(&config, &table, UID, &runner).unwrap();
        let live: Vec<(&str, bool)> = found
            .iter()
            .map(|s| (s.target.id.as_str(), s.live))
            .collect();
        assert_eq!(live, [(THIRD, true), (SECOND, false), (THREAD, true)]);
        assert_eq!(found[2].title, "Pull main");
        assert_eq!(found[2].directory.as_deref(), Some("/code/cloud"));
        assert_eq!(found[2].updated_at_ms, Some(1_790_659_486_000));
        assert_eq!(found[2].target.kind, SessionKind::Codex);
        assert_eq!(*runner.proxies.lock().unwrap(), [codex()]);

        // A window of the Codex app owns SECOND (no app router on Windows).
        #[cfg(unix)]
        {
            let socket = home.path().join("ipc.sock");
            config.ipc_socket = socket.clone();
            let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
            let router = FakeRouter {
                owned: vec![SECOND.into()],
                refuse: None,
                started: Arc::new(Mutex::new(Vec::new())),
            };
            let server = std::thread::spawn(move || router.serve(listener.accept().unwrap().0));
            let found = try_discover_with(&config, &table, UID, &runner_hosting(&[THIRD])).unwrap();
            assert!(found.iter().all(|s| s.live));
            server.join().unwrap();
        }
        #[cfg(windows)]
        let _ = &mut config;
    }

    // CodexDiscoveryTests.testUnreadableCodexKeepsTheLastThreads (the
    // unreadable half: the caller keeps its last list).
    #[test]
    fn unreadable_codex_is_not_an_empty_list() {
        let home = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        assert_eq!(
            try_discover_with(&config(home.path()), &trusted_table(), UID, &runner),
            None
        );
        assert!(runner.proxies.lock().unwrap().is_empty());
    }

    // CodexDiscoveryTests.testSocketLooksUpOnlyThePeerThreadOutsideTheAgentsListWindow.
    #[test]
    fn a_peer_thread_is_found_outside_the_list() {
        let home = tempfile::tempdir().unwrap();
        let db = seed(home.path(), "wal");
        for index in 1..=45 {
            add_thread(
                &db,
                &format!("00000000-0000-0000-0000-{index:012}"),
                1_790_659_486 + index,
            );
        }
        let config = config(home.path());
        let listed =
            try_discover_with(&config, &trusted_table(), UID, &FakeRunner::default()).unwrap();
        assert_eq!(listed.len(), 40);
        assert!(!listed.iter().any(|s| s.target.id == THREAD));
        let peer = thread(&config, THREAD).unwrap();
        assert_eq!(peer.target, Target::new(SessionKind::Codex, THREAD));
        assert!(peer.live);
        assert_eq!(
            thread(&config, "00000000-0000-0000-0000-999999999999"),
            None
        );
    }

    // OutboundReplyHint.make, codex_thread_is_live and
    // test_plain_codex_session_is_eligible_for_reply_hint. A signed shared
    // app-server with the claimed lock can now identify its command.
    #[test]
    fn a_reply_command_needs_a_codex_that_vouches_for_it() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let table = trusted_table();
        assert!(!thread_is_live(&config, &table, UID, THREAD));
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(THREAD), lock(SECOND)],
                ..codex_process(10, &["codex", "app-server"])
            },
        );
        assert!(thread_is_live(&config, &table, UID, THREAD));
        // The command relay-send sees the matching thread environment.
        table.insert(
            601,
            FakeProcess {
                environment: [("CODEX_THREAD_ID".to_string(), THREAD.to_string())].into(),
                ..process(600, 11)
            },
        );
        assert_eq!(
            crate::relay::process::codex_caller_thread(&table, 601, UID),
            Some(THREAD.to_string())
        );
        assert!(thread_is_live(&config, &table, UID, SECOND));
        table.remove(600);
        // A plain Codex holding the thread's writer lock alone.
        table.insert(
            602,
            FakeProcess {
                open_files: vec![lock(THREAD)],
                ..codex_process(12, &["codex"])
            },
        );
        assert!(thread_is_live(&config, &table, UID, &THREAD.to_uppercase()));
        assert!(!thread_is_live(&config, &table, UID, SECOND));
        assert!(!thread_is_live(&config, &table, UID, "not-a-thread"));
    }

    // CodexBridge.recentThreads / openThreadIDs (DesktopCloudSession.catalog).
    #[test]
    fn recent_and_open_threads() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        assert!(recent_threads(&config, 10).is_empty());
        let db = seed(home.path(), "wal");
        add_thread(&db, SECOND, 1_790_659_487);
        let recent = recent_threads(&config, 10);
        assert_eq!(
            recent.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            [SECOND, THREAD]
        );
        assert_eq!(recent[0].project().as_deref(), Some("relay"));
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SECOND)],
                ..codex_process(10, &["codex"])
            },
        );
        // No app socket: the processes alone.
        assert_eq!(
            open_thread_ids(&config, &table, UID),
            BTreeSet::from([SECOND.to_string()])
        );
    }

    // InjectableAgents.finalAnswer (Codex) over the thread's rollout.
    #[test]
    fn the_final_answer_comes_from_the_rollout() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let reference = "123456abcdef";
        assert_eq!(final_answer(&config, THREAD, reference), None);
        let db = seed(home.path(), "wal");
        let rollout = home.path().join("rollout.jsonl");
        db.execute(
            "update threads set rollout_path = ?1",
            [rollout.to_str().unwrap()],
        )
        .unwrap();
        let fixture = include_str!("../../tests/fixtures/codex/rollout.jsonl");
        let lines: Vec<&str> = fixture.lines().collect();
        std::fs::write(&rollout, lines[..2].join("\n")).unwrap();
        assert_eq!(
            final_answer(&config, THREAD, reference),
            None,
            "still running"
        );
        std::fs::write(&rollout, fixture).unwrap();
        assert_eq!(
            final_answer(&config, THREAD, reference).as_deref(),
            Some("Codex answer")
        );
        assert_eq!(final_answer(&config, THREAD, "000000000000"), None);
    }

    // Review: a release ranks above its own prereleases.
    #[test]
    fn a_release_ranks_above_its_prereleases() {
        let paths: Vec<PathBuf> = [
            "0.154.1-alpha",
            "0.99.0",
            "0.154.1",
            "0.154.0",
            "0.154.1-beta",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        let sorted = newest_first(paths, |p| Some(p.to_string_lossy().into_owned()));
        let sorted: Vec<String> = sorted.iter().map(|p| p.display().to_string()).collect();
        assert_eq!(
            sorted,
            [
                "0.154.1",
                "0.154.1-beta",
                "0.154.1-alpha",
                "0.154.0",
                "0.99.0"
            ]
        );
    }

    // Review: the override is never a shim either.
    #[test]
    fn the_override_is_never_a_shim() {
        let home = tempfile::tempdir().unwrap();
        let shim = home.path().join(".local/share/mise/shims/codex");
        executable(&shim);
        let config = CodexConfig::from_env(
            &env(&[("RELAY_DESKTOP_CODEX", shim.to_str().unwrap())]),
            home.path(),
        );
        assert_eq!(config.executable, None);
    }
}
