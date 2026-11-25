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
pub mod follower;
pub mod hidden_order;
pub mod ipc;
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

/// A file this user can run: an execute bit on Unix, an explicit native exe
/// or a `PATHEXT` extension (npm's `codex.cmd`) on Windows.
fn is_executable_file(path: &Path) -> bool {
    // An explicit native executable does not need extensionless PATH lookup.
    #[cfg(windows)]
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return path.is_file();
    }
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
    versions_with(root, &["bin/codex"])
}

/// Each of `files` in every version directory under `root`: newest version
/// first, and within a version in the order given.
#[cfg(not(windows))]
fn versions_with(root: &Path, files: &[&str]) -> Vec<PathBuf> {
    let found = std::fs::read_dir(root)
        .map(|entries| entries.flatten().map(|e| e.path()).collect::<Vec<_>>())
        .unwrap_or_default();
    newest_first(found, |dir| {
        Some(dir.file_name()?.to_string_lossy().into_owned())
    })
    .into_iter()
    .flat_map(|dir| files.iter().map(move |file| dir.join(file)))
    .collect()
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
/// queue for app threads), version-managed installs (mise's `codex` and
/// npm-backend installs, then npm global installs under nvm's node
/// versions, each newest first), the usual command-line locations, npm
/// global installs under mise's node versions, then `PATH`. A mise shim is
/// never a candidate. An app launched from the desktop has no shell `PATH`,
/// so the fixed locations come first.
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
/// person's `.local\bin`, then `PATH`, then the native executable bundled
/// with the Codex desktop app. Keep an existing CLI ahead of the app fallback:
/// an older app bundle may not support the CLI's terminal-delivery commands.
/// Each command folder is tried with every
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
    let mut candidates: Vec<_> = folders
        .iter()
        .flat_map(|folder| names.iter().map(move |name| folder.join(name)))
        .collect();
    candidates.extend(windows_desktop_executables(env, home));
    candidates.retain(|path| !is_shim(path));
    candidates
}

#[cfg(windows)]
fn windows_desktop_executables(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Vec<PathBuf> {
    let local = env("LOCALAPPDATA")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(r"AppData\Local"));
    let mut found: Vec<_> = windows_desktop_bin_roots(&local)
        .into_iter()
        .flat_map(|root| std::fs::read_dir(root).into_iter().flatten().flatten())
        .map(|entry| entry.path().join("codex.exe"))
        .filter(|path| is_executable_file(path))
        .collect();
    // Build folder names are opaque hashes. Rank complete installations by
    // directory creation time, not a copied binary's preserved last-write time.
    // If the filesystem cannot distinguish install times, order deterministically.
    found.sort_by_cached_key(|path| {
        (
            std::cmp::Reverse(
                path.parent()
                    .and_then(|dir| std::fs::metadata(dir).ok())
                    .and_then(|m| m.created().ok()),
            ),
            std::cmp::Reverse(path.clone()),
        )
    });
    found
}

/// The folders the Codex desktop app unpacks its builds into: the plain
/// `LOCALAPPDATA\OpenAI\Codex\bin`, and the same folder as Windows
/// redirects it for a Microsoft Store (MSIX) install, which writes new
/// AppData files to its package's private
/// `LOCALAPPDATA\Packages\<OpenAI package>\LocalCache\Local`.
#[cfg(windows)]
fn windows_desktop_bin_roots(local: &Path) -> Vec<PathBuf> {
    const BIN: &str = r"OpenAI\Codex\bin";
    let mut roots = vec![local.join(BIN)];
    let mut packaged: Vec<PathBuf> = std::fs::read_dir(local.join("Packages"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.to_ascii_lowercase().starts_with("openai."))
        })
        .map(|entry| entry.path().join(r"LocalCache\Local").join(BIN))
        .collect();
    packaged.sort();
    roots.extend(packaged);
    roots
}

/// The folders mise's npm backend installs `@openai/codex` into, under
/// `<mise data>/installs`.
#[cfg(not(windows))]
const MISE_NPM_CODEX: [&str; 2] = ["npm-openai-codex", "npm-@openai-codex"];

/// mise's data folder: `MISE_DATA_DIR`, else `$XDG_DATA_HOME/mise`, else
/// `~/.local/share/mise`. Only absolute settings count.
#[cfg(not(windows))]
pub(crate) fn mise_data_dir(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    let set = |key: &str| {
        env(key)
            .map(|value| PathBuf::from(value.trim()))
            .filter(|path| path.is_absolute())
    };
    set("MISE_DATA_DIR")
        .or_else(|| set("XDG_DATA_HOME").map(|data| data.join("mise")))
        .unwrap_or_else(|| home.join(".local/share/mise"))
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
    let installs = mise_data_dir(env, home).join("installs");
    let mise = installs.join("codex");
    candidates.push(mise.join("latest/bin/codex"));
    candidates.push(home.join(".local/bin/codex"));
    candidates.extend(versions(&mise));
    // mise's npm backend (`mise use -g npm:@openai/codex`): npm's
    // `--prefix` layout puts the launcher in `bin`, a pnpm-style installer
    // in `node_modules/.bin` (possibly as a wrapper script that needs Node),
    // so the package's own launcher is tried before it and
    // `npm_native_executable` finds the bundled binary from there. Older mise kept the `@` in the folder name.
    for folder in MISE_NPM_CODEX {
        candidates.extend(versions_with(
            &installs.join(folder),
            &[
                "bin/codex",
                "node_modules/@openai/codex/bin/codex.js",
                "node_modules/.bin/codex",
            ],
        ));
    }
    candidates.extend(versions(&home.join(".nvm/versions/node")));
    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
    candidates.push(PathBuf::from("/usr/local/bin/codex"));
    // `npm install -g @openai/codex` under a node mise provides: the global
    // bin of each mise node version, newest first. After the system
    // locations, so a Codex left behind in an old node never displaces a
    // Homebrew install that was reachable before.
    candidates.extend(versions(&installs.join("node")));
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

/// How many threads discovery lists.
pub const DISCOVERY_LIMIT: usize = 40;

/// The writer locks trusted live Codex processes hold on listed threads, as
/// (pid, start, thread).
type ListedLocks = BTreeSet<(i32, u64, String)>;

/// The shared app-server's loaded threads among the listed ones, as
/// discovery last asked, and the listed writer locks it saw then. The
/// app-server holds a thread's writer lock while the thread is loaded, so an
/// answer is complete when it names exactly the listed threads whose locks
/// the app-server the proxy reaches holds. A complete answer is kept until
/// the locks change; one that is not (a thread still loading or unloading,
/// or an ask that failed) is asked again on the next pass.
#[derive(Default)]
pub struct LoadedThreads(std::sync::Mutex<LoadedAnswer>);

#[derive(Default)]
struct LoadedAnswer {
    locks: Option<ListedLocks>,
    loaded: BTreeSet<String>,
    /// Why the kept answer's ask failed, so a pass that reuses it still
    /// says the app-server could not be checked.
    failure: Option<String>,
}

impl LoadedThreads {
    /// The loaded listed threads under `locks`, where the proxied
    /// app-server holds `served`: the kept answer, or `ask`'s (none when it
    /// fails), and how it was had.
    fn under(
        &self,
        locks: ListedLocks,
        served: &BTreeSet<String>,
        ask: impl FnOnce() -> Result<BTreeSet<String>, String>,
    ) -> (BTreeSet<String>, AppServerProbe) {
        {
            let kept = self.answer();
            if kept.locks.as_ref() == Some(&locks) {
                let probe = match &kept.failure {
                    Some(reason) => AppServerProbe::Failed(reason.clone()),
                    None => AppServerProbe::Kept(kept.loaded.len()),
                };
                return (kept.loaded.clone(), probe);
            }
        }
        let (loaded, probe) = match ask() {
            Ok(loaded) => {
                let count = loaded.len();
                (loaded, AppServerProbe::Answered(count))
            }
            Err(reason) => (BTreeSet::new(), AppServerProbe::Failed(reason)),
        };
        let mut kept = self.answer();
        kept.locks = (&loaded == served).then_some(locks);
        kept.loaded = loaded.clone();
        kept.failure = match &probe {
            AppServerProbe::Failed(reason) => Some(reason.clone()),
            _ => None,
        };
        (loaded, probe)
    }

    fn answer(&self) -> std::sync::MutexGuard<'_, LoadedAnswer> {
        self.0.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Whether the Codex app's router was asked, and its answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Probe {
    /// Every listed thread was already known to be running.
    NotAsked,
    /// How many of the asked threads a Codex app window owns, and how many
    /// the router left unanswered by its deadline.
    Answered { owned: usize, unanswered: usize },
    /// Why it could not be asked (`NotRunning`: no app is listening).
    Failed(ipc::IpcError),
}

/// Whether the shared app-server was asked which threads it has loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppServerProbe {
    /// Every listed thread was already known to be running.
    NotAsked,
    /// It answered this pass: how many listed threads it has loaded.
    Answered(usize),
    /// An earlier complete answer still holds (the writer locks are
    /// unchanged): how many listed threads it named.
    Kept(usize),
    /// Why it could not say.
    Failed(String),
}

/// What discovery's three "running" signals said in one pass, as counts
/// (never thread ids or paths), so a chat that is not seen as running can
/// be explained from the core log:
/// 1. a trusted Codex of this user holds the thread's writer lock or
///    resumed it (`process_held`; `process_live` of those run its turns);
/// 2. the shared app-server reports the thread loaded;
/// 3. a Codex app window owns it over the app's router
///    (`<Codex home>/ipc/ipc.sock`, or `\\.\pipe\codex-ipc` on Windows).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunningSignals {
    pub threads: usize,
    pub process_held: usize,
    pub process_live: usize,
    pub app_server: AppServerProbe,
    pub app_router: Probe,
    pub live: usize,
}

/// A router failure as a fixed category: the router's own refusal text and
/// I/O messages can carry paths or thread ids, which the log never holds.
fn router_failure(error: &ipc::IpcError) -> &'static str {
    match error {
        ipc::IpcError::NotRunning => "the Codex app is not running",
        ipc::IpcError::TimedOut => "the Codex app did not answer in time",
        ipc::IpcError::Rejected(_) => "the Codex app refused the connection",
        ipc::IpcError::Io(_) => "the connection failed",
        ipc::IpcError::InvalidFrameLength(_) => "the Codex app sent an invalid message",
    }
}

impl RunningSignals {
    pub fn line(&self) -> String {
        let app_server = match &self.app_server {
            AppServerProbe::NotAsked => "not asked".to_string(),
            AppServerProbe::Answered(count) => format!("{count} loaded"),
            AppServerProbe::Kept(count) => format!("{count} loaded (earlier answer)"),
            AppServerProbe::Failed(reason) => format!("could not check ({reason})"),
        };
        let router = match &self.app_router {
            Probe::NotAsked => "not asked".to_string(),
            Probe::Answered {
                owned,
                unanswered: 0,
            } => format!("{owned} owned by an app window"),
            Probe::Answered { owned, unanswered } => {
                format!("{owned} owned by an app window, {unanswered} unanswered in time")
            }
            Probe::Failed(error) => format!("could not check ({})", router_failure(error)),
        };
        format!(
            "codex discovery: {live} of {threads} recent chats running; \
             (1) trusted Codex process holds the chat: {held} ({drains} running its turns); \
             (2) app-server: {app_server}; (3) Codex app router: {router}",
            live = self.live,
            threads = self.threads,
            held = self.process_held,
            drains = self.process_live,
        )
    }

    /// Writes `line` to the core log when it differs from the last pass's,
    /// so a steady state is logged once, not every refresh.
    fn log_if_changed(&self) {
        static LAST: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
        let line = self.line();
        let mut last = LAST.lock().unwrap_or_else(|error| error.into_inner());
        if last.as_deref() != Some(line.as_str()) {
            crate::relay::diagnostics::write(format_args!("{line}"));
            *last = Some(line);
        }
    }
}

/// Codex threads on this computer as sessions (title, directory,
/// updated_at_ms, live): the 40 most recently updated, newest first. `None`
/// when Codex's database cannot be read this pass, so the caller can keep
/// the last list rather than empty it while Codex holds a lock.
pub fn try_discover(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
    loaded: &LoadedThreads,
) -> Option<Vec<DiscoveredSession>> {
    try_discover_with(config, table, uid, loaded, &SystemRunner)
}

fn try_discover_with(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
    loaded: &LoadedThreads,
    runner: &dyn CodexRunner,
) -> Option<Vec<DiscoveredSession>> {
    let (found, signals) = discover_with_signals(config, table, uid, loaded, runner)?;
    signals.log_if_changed();
    Some(found)
}

/// `try_discover_with`, and what each running signal said.
fn discover_with_signals(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
    loaded: &LoadedThreads,
    runner: &dyn CodexRunner,
) -> Option<(Vec<DiscoveredSession>, RunningSignals)> {
    let threads = threads::read_recent(config, DISCOVERY_LIMIT)?;
    let ids: BTreeSet<String> = threads.iter().map(|t| t.id.to_lowercase()).collect();
    let process_sessions = processes::process_sessions(table, uid, &ids);
    let paseo_threads = processes::paseo_threads(table, uid, &process_sessions);
    let mut live: BTreeSet<String> = process_sessions
        .iter()
        .filter(|session| processes::drains_queue(table, uid, session.pid))
        .map(|session| session.thread.clone())
        .collect();
    let mut signals = RunningSignals {
        threads: ids.len(),
        process_held: process_sessions
            .iter()
            .map(|session| &session.thread)
            .collect::<BTreeSet<_>>()
            .len(),
        process_live: live.len(),
        app_server: AppServerProbe::NotAsked,
        app_router: Probe::NotAsked,
        live: 0,
    };
    if live.len() < ids.len() {
        let held: Vec<_> = process_sessions
            .iter()
            .filter(|session| !session.authorizes_callers)
            .collect();
        let locks = held
            .iter()
            .map(|session| (session.pid, session.start, session.thread.clone()))
            .collect();
        let proxied: Vec<_> = held
            .iter()
            .filter(|session| processes::is_proxied_app_server(table, session.pid))
            .collect();
        let served: BTreeSet<String> = proxied
            .iter()
            .map(|session| session.thread.clone())
            .collect();
        // Chats sharing the app-server can be told apart on the relay-send
        // socket only by the commands the app-server reports them running:
        // watch them before their commands start, through that app-server's
        // own executable (never another Codex's, which may not reach it).
        if served.len() > 1 {
            if let Some(executable) = proxied
                .first()
                .and_then(|session| table.executable(session.pid))
            {
                app_server::watch::ensure(&executable, &config.home, &config.sqlite_home);
            }
        }
        let (from_app_server, probe) = loaded.under(locks, &served, || {
            try_loaded_threads(config, table, uid, runner)
                .map(|loaded| loaded.intersection(&ids).cloned().collect())
        });
        signals.app_server = probe;
        live.extend(from_app_server);
    }
    let unknown: Vec<String> = threads
        .iter()
        .filter(|t| !live.contains(&t.id.to_lowercase()))
        .map(|t| t.id.clone())
        .collect();
    if !unknown.is_empty() {
        match ipc::try_open_threads(&config.ipc_socket, &unknown) {
            Ok((owned, unanswered)) => {
                signals.app_router = Probe::Answered {
                    owned: owned.len(),
                    unanswered,
                };
                live.extend(owned.into_keys().map(|id| id.to_lowercase()));
            }
            Err(error) => signals.app_router = Probe::Failed(error),
        }
    }
    signals.live = live.len();
    let found = threads
        .into_iter()
        .map(|thread| {
            let is_live = live.contains(&thread.id.to_lowercase());
            let host = paseo_threads
                .contains(&thread.id.to_lowercase())
                .then(|| crate::relay::paseo::HOST.to_string());
            session(thread, is_live, host)
        })
        .collect();
    Some((found, signals))
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
    try_loaded_threads(config, table, uid, runner).unwrap_or_default()
}

/// `loaded_threads`, or why the app-server could not be asked.
fn try_loaded_threads(
    config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
    runner: &dyn CodexRunner,
) -> Result<BTreeSet<String>, String> {
    let executable = processes::running_executable(table, uid)
        .ok_or_else(|| "no trusted Codex is running".to_string())?;
    let mut stream = runner
        .proxy_in_home(&executable, &config.home, &config.sqlite_home)
        .map_err(|error| format!("its proxy did not start: {:?}", error.kind()))?;
    app_server::try_loaded_threads(stream.as_mut(), app_server::LOADED_TIMEOUT)
        .map(|loaded| loaded.into_iter().map(|id| id.to_lowercase()).collect())
        .map_err(|error| format!("it did not answer: {:?}", error.kind()))
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

/// The `threads` (lowercased) for which `thread_is_live` holds, from one
/// pass over the process table.
pub fn live_threads<'a>(
    _config: &CodexConfig,
    table: &dyn ProcessTable,
    uid: u32,
    threads: impl IntoIterator<Item = &'a str>,
) -> BTreeSet<String> {
    processes::reply_capable_threads(table, uid, threads)
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
    // Windows has no socket file: its router is a named pipe, always asked.
    if ipc::router_may_listen(&config.ipc_socket) {
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
            pinned(&[("CODEX_SQLITE_HOME", "~/codex-db")]).sqlite_home,
            home.path().join("codex-db")
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

    #[cfg(windows)]
    #[test]
    fn windows_desktop_codex_is_found_without_path_or_npm() {
        let home = tempfile::tempdir().unwrap();
        for local in [
            home.path().join("custom-local"),
            home.path().join(r"AppData\Local"),
        ] {
            let root = local.join(r"OpenAI\Codex\bin");
            let binary = root.join("complete-build/codex.exe");
            executable(&binary);
            std::fs::create_dir_all(root.join("incomplete-build")).unwrap();
            std::fs::write(root.join("incomplete-build/codex"), b"shell script").unwrap();
            std::fs::create_dir_all(root.join("not-a-file/codex.exe")).unwrap();
            let value = local.to_str().unwrap();
            let values = if local.ends_with("custom-local") {
                vec![("LOCALAPPDATA", value)]
            } else {
                vec![]
            };
            assert_eq!(
                CodexConfig::from_env(&env(&values), home.path()).executable,
                Some(binary)
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_desktop_codex_uses_install_time_and_preserves_existing_cli() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(r"AppData\Local\OpenAI\Codex\bin");
        let older = root.join("older/codex.exe");
        let newer = root.join("newer/codex.exe");
        let npm = home.path().join(r"AppData\Roaming\npm\codex.cmd");
        for (path, seconds) in [(&older, 3), (&newer, 1)] {
            executable(path);
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new().set_modified(
                        std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds),
                    ),
                )
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(
            CodexConfig::from_env(&env(&[]), home.path()).executable,
            Some(newer.clone())
        );
        // Equal copied executable timestamps must not change install ordering.
        for path in [&older, &newer] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(10)),
                )
                .unwrap();
        }
        assert_eq!(
            CodexConfig::from_env(&env(&[]), home.path()).executable,
            Some(newer)
        );
        executable(&npm);
        assert_eq!(
            CodexConfig::from_env(&env(&[]), home.path()).executable,
            Some(npm.clone())
        );
        assert_eq!(
            CodexConfig::from_env(
                &env(&[("RELAY_DESKTOP_CODEX", older.to_str().unwrap())]),
                home.path()
            )
            .executable,
            Some(older)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_desktop_codex_does_not_require_exe_in_pathext() {
        const CHILD: &str = "RELAY_TEST_CODEX_RESTRICTED_PATHEXT";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "relay::codex::tests::windows_desktop_codex_does_not_require_exe_in_pathext",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .env("PATHEXT", ".COM;.CMD")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let binary = home
            .path()
            .join(r"AppData\Local\OpenAI\Codex\bin\build\codex.exe");
        executable(&binary);
        assert_eq!(
            CodexConfig::from_env(&env(&[]), home.path()).executable,
            Some(binary)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_desktop_codex_ignores_relative_local_app_data() {
        let home = tempfile::tempdir().unwrap();
        let binary = home
            .path()
            .join(r"AppData\Local\OpenAI\Codex\bin\build\codex.exe");
        executable(&binary);
        assert_eq!(
            CodexConfig::from_env(&env(&[("LOCALAPPDATA", "relative")]), home.path()).executable,
            Some(binary)
        );
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
        let found =
            try_discover_with(&config, &table, UID, &LoadedThreads::default(), &runner).unwrap();
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
            let found = try_discover_with(
                &config,
                &table,
                UID,
                &LoadedThreads::default(),
                &runner_hosting(&[THIRD]),
            )
            .unwrap();
            assert!(found.iter().all(|s| s.live));
            server.join().unwrap();
        }
        #[cfg(windows)]
        let _ = &mut config;
    }

    /// A runner whose proxies answer `loaded` in turn.
    fn runner_answering(loaded: &[&[&str]]) -> FakeRunner {
        let runner = FakeRunner::default();
        for threads in loaded {
            runner
                .streams
                .lock()
                .unwrap()
                .push_back(Box::new(FakeAppServer::hosting(threads, None)));
        }
        runner
    }

    /// The app-server daemon `codex app-server proxy` reaches, holding the
    /// writer locks of `threads`.
    fn app_server_holding(threads: &[&str]) -> FakeProcess {
        FakeProcess {
            open_files: threads.iter().map(|thread| lock(thread)).collect(),
            ..codex_process(12, &["codex", "app-server", "--listen", "unix://"])
        }
    }

    fn live_ids(found: &[DiscoveredSession]) -> Vec<&str> {
        found
            .iter()
            .filter(|s| s.live)
            .map(|s| s.target.id.as_str())
            .collect()
    }

    // An answer naming exactly the daemon's listed locks is kept until those
    // locks change: an unchanged pass runs no proxy.
    #[test]
    fn unchanged_locks_run_no_proxy() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let db = seed(home.path(), "wal");
        add_thread(&db, SECOND, 1_790_659_487);
        add_thread(&db, THIRD, 1_790_659_488);
        let table = trusted_table();
        table.insert(602, app_server_holding(&[THIRD]));
        let runner = runner_answering(&[&[THIRD], &[THIRD, SECOND]]);
        let loaded = LoadedThreads::default();
        let pass = || try_discover_with(&config, &table, UID, &loaded, &runner).unwrap();
        let proxies = || runner.proxies.lock().unwrap().len();

        for _ in 0..4 {
            assert_eq!(live_ids(&pass()), [THIRD]);
        }
        assert_eq!(proxies(), 1, "an unchanged pass runs no proxy");

        // The daemon loads SECOND: it takes SECOND's lock.
        table.insert(602, app_server_holding(&[THIRD, SECOND]));
        for _ in 0..3 {
            assert_eq!(live_ids(&pass()), [THIRD, SECOND]);
        }
        assert_eq!(proxies(), 2, "a changed lock asks once");
    }

    // Codex takes a thread's lock before the thread is loaded: answers that
    // miss a thread whose lock the daemon holds are asked again, however
    // many agree, until one names it.
    #[test]
    fn a_thread_still_loading_is_asked_about_again() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let db = seed(home.path(), "wal");
        add_thread(&db, THIRD, 1_790_659_488);
        let table = trusted_table();
        table.insert(602, app_server_holding(&[THIRD]));
        let runner = runner_answering(&[&[], &[], &[THIRD]]);
        let loaded = LoadedThreads::default();
        let pass = || try_discover_with(&config, &table, UID, &loaded, &runner).unwrap();
        let third_live =
            |found: Vec<DiscoveredSession>| found.iter().any(|s| s.target.id == THIRD && s.live);

        assert!(!third_live(pass()));
        assert!(!third_live(pass()));
        assert!(third_live(pass()));
        assert!(third_live(pass()));
        assert_eq!(runner.proxies.lock().unwrap().len(), 3);
    }

    // A failed ask is not an answer that the daemon's threads are unloaded.
    #[test]
    fn a_failed_ask_is_retried() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let db = seed(home.path(), "wal");
        add_thread(&db, THIRD, 1_790_659_488);
        let table = trusted_table();
        table.insert(602, app_server_holding(&[THIRD]));
        let runner = FakeRunner::default();
        let loaded = LoadedThreads::default();
        let pass = || try_discover_with(&config, &table, UID, &loaded, &runner).unwrap();
        let third_live =
            |found: Vec<DiscoveredSession>| found.iter().any(|s| s.target.id == THIRD && s.live);

        // The first two asks fail: no proxy answers.
        assert!(!third_live(pass()));
        assert!(!third_live(pass()));
        runner
            .streams
            .lock()
            .unwrap()
            .push_back(Box::new(FakeAppServer::hosting(&[THIRD], None)));
        assert!(third_live(pass()));
        assert!(third_live(pass()));
        assert_eq!(runner.proxies.lock().unwrap().len(), 3);
    }

    // With no daemon holding a listed lock, an empty answer is complete:
    // a terminal Codex or a stdio app-server runs one proxy, then none.
    #[test]
    fn no_daemon_lock_asks_once() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let db = seed(home.path(), "wal");
        add_thread(&db, SECOND, 1_790_659_487);
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(THREAD)],
                ..codex_process(10, &["codex"])
            },
        );
        table.insert(
            601,
            FakeProcess {
                open_files: vec![lock(SECOND)],
                ..codex_process(11, &["codex", "app-server", "--analytics-default-enabled"])
            },
        );
        let runner = FakeRunner::default();
        let loaded = LoadedThreads::default();
        for _ in 0..5 {
            try_discover_with(&config, &table, UID, &loaded, &runner).unwrap();
        }
        assert_eq!(runner.proxies.lock().unwrap().len(), 1);
    }

    // Only the app-server on the default control socket (`unix://`) is the
    // proxied daemon; one on its own socket path, over stdio or with no
    // `--listen` is not.
    #[test]
    fn the_proxied_app_server_listens_on_the_default_socket() {
        let table = trusted_table();
        let cases: [(&[&str], bool); 6] = [
            (
                &["codex", "app-server", "--listen", "unix://", "--managed"],
                true,
            ),
            (&["codex", "app-server", "--listen=unix://"], true),
            (
                &["codex", "app-server", "--listen=unix:///tmp/codex.sock"],
                false,
            ),
            (&["codex", "app-server", "--listen", "stdio://"], false),
            (
                &[
                    "codex",
                    "-c",
                    "x=1",
                    "app-server",
                    "--analytics-default-enabled",
                ],
                false,
            ),
            (&["codex", "--listen", "unix://"], false),
        ];
        for (pid, (arguments, proxied)) in (700..).zip(cases) {
            table.insert(pid, codex_process(20, arguments));
            assert_eq!(
                processes::is_proxied_app_server(&table, pid),
                proxied,
                "{arguments:?}"
            );
        }
    }

    // CodexDiscoveryTests.testUnreadableCodexKeepsTheLastThreads (the
    // unreadable half: the caller keeps its last list).
    #[test]
    fn unreadable_codex_is_not_an_empty_list() {
        let home = tempfile::tempdir().unwrap();
        let runner = FakeRunner::default();
        assert_eq!(
            try_discover_with(
                &config(home.path()),
                &trusted_table(),
                UID,
                &LoadedThreads::default(),
                &runner,
            ),
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
        let listed = try_discover_with(
            &config,
            &trusted_table(),
            UID,
            &LoadedThreads::default(),
            &FakeRunner::default(),
        )
        .unwrap();
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
        // It holds two chats, so the relay-send socket names neither.
        assert!(crate::relay::process::codex_selection_is_ambiguous(
            &table, 601, UID
        ));
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
        // One pass answers the same for several threads.
        let upper = THREAD.to_uppercase();
        assert_eq!(
            live_threads(
                &config,
                &table,
                UID,
                [upper.as_str(), SECOND, "not-a-thread"]
            ),
            BTreeSet::from([THREAD.to_string()])
        );
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

    // relay#2239: each running signal is reported, as counts only.
    #[test]
    fn discovery_reports_each_running_signal() {
        let home = tempfile::tempdir().unwrap();
        let mut config = config(home.path());
        config.ipc_socket = home.path().join("no-router.sock");
        let db = seed(home.path(), "wal");
        add_thread(&db, SECOND, 1_790_659_487);
        let table = trusted_table();
        // A terminal Codex holds THREAD: signal 1 alone answers it.
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(THREAD)],
                ..codex_process(10, &["codex"])
            },
        );
        #[cfg(windows)]
        ipc::TEST_ROUTER_PIPE.with(|name| {
            *name.borrow_mut() = Some(crate::relay::transport::pipe_name(
                &home.path().join("no-router"),
            ))
        });
        let (found, signals) = discover_with_signals(
            &config,
            &table,
            UID,
            &LoadedThreads::default(),
            &runner_hosting(&[]),
        )
        .unwrap();
        assert_eq!(live_ids(&found), [THREAD]);
        assert_eq!(
            signals,
            RunningSignals {
                threads: 2,
                process_held: 1,
                process_live: 1,
                app_server: AppServerProbe::Answered(0),
                app_router: Probe::Failed(ipc::IpcError::NotRunning),
                live: 1,
            }
        );
        let line = signals.line();
        assert!(line.contains("1 of 2 recent chats running"), "{line}");
        assert!(line.contains("(1) trusted Codex process holds the chat: 1 (1 running its turns)"));
        assert!(line.contains("(2) app-server: 0 loaded"));
        assert!(
            line.contains("(3) Codex app router: could not check (the Codex app is not running)")
        );
        let refused = RunningSignals {
            app_router: Probe::Failed(ipc::IpcError::Rejected(format!("no {THREAD} at C:\\x"))),
            ..signals.clone()
        };
        let line = refused.line();
        assert!(line.contains("could not check (the Codex app refused the connection)"));
        assert!(!line.contains(THREAD) && !line.contains("C:"), "{line}");
        assert!(!line.contains(THREAD) && !line.contains(SECOND));
        // Every chat answered by a process: the others are not asked.
        let all = RunningSignals {
            app_server: AppServerProbe::NotAsked,
            app_router: Probe::NotAsked,
            ..signals.clone()
        };
        assert!(all
            .line()
            .contains("(2) app-server: not asked; (3) Codex app router: not asked"));
        // A check that could not be made is never reported as an empty answer.
        let failed = RunningSignals {
            app_server: AppServerProbe::Failed("no trusted Codex is running".into()),
            app_router: Probe::Answered {
                owned: 1,
                unanswered: 2,
            },
            ..signals.clone()
        };
        let line = failed.line();
        assert!(line.contains("(2) app-server: could not check (no trusted Codex is running)"));
        assert!(
            line.contains("(3) Codex app router: 1 owned by an app window, 2 unanswered in time")
        );
        // Nothing runs: the app-server is not reachable, which is said so.
        let (_, idle) = discover_with_signals(
            &config,
            &trusted_table(),
            UID,
            &LoadedThreads::default(),
            &runner_hosting(&[]),
        )
        .unwrap();
        assert_eq!(
            idle.app_server,
            AppServerProbe::Failed("no trusted Codex is running".into())
        );
        // A later pass that reuses that answer still says it failed.
        let cache = LoadedThreads::default();
        for _ in 0..2 {
            let (_, again) =
                discover_with_signals(&config, &trusted_table(), UID, &cache, &runner_hosting(&[]))
                    .unwrap();
            assert_eq!(
                again.app_server,
                AppServerProbe::Failed("no trusted Codex is running".into())
            );
        }
    }

    /// A Codex app router on a Windows named pipe of the test's own, owning
    /// `owned`; serves one connection. Returns the pipe's name.
    #[cfg(windows)]
    async fn serve_windows_router(
        dir: &Path,
        owned: &'static [&'static str],
    ) -> (String, tokio::task::JoinHandle<()>) {
        use crate::relay::transport::{pipe_name, CoreListener};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let path = dir.join("codex-router");
        let mut listener = CoreListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let mut stream = listener.accept().await.unwrap();
            loop {
                let Ok(size) = stream.read_u32_le().await else {
                    return;
                };
                let mut payload = vec![0; size as usize];
                if stream.read_exact(&mut payload).await.is_err() {
                    return;
                }
                let request: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                let id = request["requestId"].clone();
                let response = match request["method"].as_str() {
                    Some("initialize") => serde_json::json!({
                        "type": "response", "requestId": id, "resultType": "success",
                        "result": {"clientId": "relay-1"}
                    }),
                    Some("thread-owner-discovery") => {
                        let thread = request["params"]["conversationId"].as_str().unwrap();
                        if owned.iter().any(|known| *known == thread) {
                            serde_json::json!({
                                "type": "response", "requestId": id, "resultType": "success",
                                "handledByClientId": "window-1", "result": {}
                            })
                        } else {
                            serde_json::json!({
                                "type": "response", "requestId": id, "resultType": "error",
                                "error": "no-client-found"
                            })
                        }
                    }
                    _ => continue,
                };
                let frame = ipc::encode_frame(&serde_json::to_vec(&response).unwrap()).unwrap();
                if stream.write_all(&frame).await.is_err() {
                    return;
                }
            }
        });
        (pipe_name(&path), server)
    }

    // relay#2239: Windows has no `ipc.sock`; the app's named pipe is asked
    // anyway, and a chat an app window owns is open.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn windows_open_thread_ids_asks_the_named_pipe_without_a_socket_file() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        assert!(!config.ipc_socket.exists());
        let db = seed(home.path(), "wal");
        add_thread(&db, SECOND, 1_790_659_487);
        drop(db);
        let (pipe, server) = serve_windows_router(home.path(), &[SECOND]).await;
        let open = tokio::task::spawn_blocking(move || {
            ipc::TEST_ROUTER_PIPE.with(|name| *name.borrow_mut() = Some(pipe));
            open_thread_ids(&config, &trusted_table(), UID)
        })
        .await
        .unwrap();
        assert_eq!(open, BTreeSet::from([SECOND.to_string()]));
        server.await.unwrap();
    }

    // relay#2239: discovery marks a chat the app's window owns as running
    // over the named pipe, and says so.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn windows_discovery_reads_app_windows_over_the_named_pipe() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let db = seed(home.path(), "wal");
        add_thread(&db, SECOND, 1_790_659_487);
        drop(db);
        let (pipe, server) = serve_windows_router(home.path(), &[THREAD]).await;
        let (found, signals) = tokio::task::spawn_blocking(move || {
            ipc::TEST_ROUTER_PIPE.with(|name| *name.borrow_mut() = Some(pipe));
            discover_with_signals(
                &config,
                &trusted_table(),
                UID,
                &LoadedThreads::default(),
                &runner_hosting(&[]),
            )
            .unwrap()
        })
        .await
        .unwrap();
        assert_eq!(live_ids(&found), [THREAD]);
        assert_eq!(
            signals.app_router,
            Probe::Answered {
                owned: 1,
                unanswered: 0
            }
        );
        assert_eq!(signals.process_held, 0);
        server.await.unwrap();
    }

    // relay#2239: with no app running, the pipe's absence is reported at
    // once, not waited for.
    #[cfg(windows)]
    #[test]
    fn windows_an_absent_app_router_is_not_running_quickly() {
        let home = tempfile::tempdir().unwrap();
        ipc::TEST_ROUTER_PIPE.with(|name| {
            *name.borrow_mut() = Some(crate::relay::transport::pipe_name(
                &home.path().join("absent"),
            ))
        });
        assert!(ipc::router_may_listen(&home.path().join("ipc/ipc.sock")));
        let started = std::time::Instant::now();
        assert_eq!(
            ipc::try_open_threads(&home.path().join("ipc/ipc.sock"), &[THREAD.into()])
                .map(|(owned, _)| owned),
            Err(ipc::IpcError::NotRunning)
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[cfg(windows)]
    #[test]
    fn windows_store_installs_of_the_codex_app_are_found() {
        let home = tempfile::tempdir().unwrap();
        let local = home.path().join(r"AppData\Local");
        let binary = local
            .join(r"Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\OpenAI\Codex\bin\b1")
            .join("codex.exe");
        executable(&binary);
        // Another publisher's package is not looked into.
        executable(
            &local
                .join(r"Packages\Other.App_1\LocalCache\Local\OpenAI\Codex\bin\b2")
                .join("codex.exe"),
        );
        assert_eq!(
            windows_desktop_executables(&env(&[]), home.path()),
            vec![binary.clone()]
        );
        assert_eq!(
            CodexConfig::from_env(&env(&[]), home.path()).executable,
            Some(binary)
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

    /// The installed candidates under `home`, in order: what `from_env`
    /// would pick from there, ignoring installs on the machine running the
    /// test.
    #[cfg(unix)]
    fn installed_under(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Vec<PathBuf> {
        executable_candidates(env, home)
            .into_iter()
            .filter(|path| path.starts_with(home) && is_executable_file(path))
            .collect()
    }

    /// npm's global layout under `prefix`: the launcher in
    /// `lib/node_modules/@openai/codex/bin/codex.js`, linked from `bin/codex`.
    #[cfg(unix)]
    fn npm_global_codex(prefix: &Path) -> PathBuf {
        let launcher = prefix.join("lib/node_modules/@openai/codex/bin/codex.js");
        executable(&launcher);
        let link = prefix.join("bin/codex");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink("../lib/node_modules/@openai/codex/bin/codex.js", &link)
            .unwrap();
        link
    }

    // #2247: `npm install -g @openai/codex` under a node mise provides is
    // found without the shell's PATH (the core started by the desktop app
    // has only /usr/bin:/bin), newest node first.
    #[cfg(unix)]
    #[test]
    fn a_codex_in_a_mise_node_global_bin_is_found_without_path() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let node = home.join(".local/share/mise/installs/node");
        let older = npm_global_codex(&node.join("20.20.0"));
        let newer = npm_global_codex(&node.join("22.23.2"));
        // A newer node without Codex is skipped.
        std::fs::create_dir_all(node.join("24.20.0/bin")).unwrap();
        let env = env(&[("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")]);
        assert_eq!(installed_under(&env, home), vec![newer.clone(), older]);
        assert!(!is_shim(&newer));
    }

    // #2247: mise's npm backend (`mise use -g npm:@openai/codex`) puts each
    // version under `installs/npm-openai-codex/<version>`, newest first, and
    // ahead of npm installs under a node version.
    #[cfg(unix)]
    #[test]
    fn a_codex_from_mises_npm_backend_is_found_newest_first() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let installs = home.join(".local/share/mise/installs");
        let backend = installs.join("npm-openai-codex");
        let old = npm_global_codex(&backend.join("0.99.0"));
        let new = npm_global_codex(&backend.join("0.154.0"));
        let legacy = npm_global_codex(&installs.join("npm-@openai-codex/0.98.0"));
        let node = npm_global_codex(&installs.join("node/22.23.2"));
        assert_eq!(
            installed_under(&env(&[]), home),
            vec![new, old, legacy, node]
        );
    }

    // Review on #2258: a pnpm-style installer puts mise's npm-backend
    // launcher in `node_modules/.bin`, possibly as a wrapper script rather
    // than a link; the package's own launcher still resolves to the bundled
    // native binary, so Node is not needed on PATH.
    #[cfg(unix)]
    #[test]
    fn a_codex_from_mises_npm_backend_in_node_modules_bin_is_found() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().canonicalize().unwrap();
        let home = home.as_path();
        let version = home.join(".local/share/mise/installs/npm-openai-codex/0.154.0");
        let wrapper = version.join("node_modules/.bin/codex");
        executable(&wrapper);
        std::fs::write(
            &wrapper,
            "#!/bin/sh\nexec node \"$0/../../@openai/codex/bin/codex.js\" \"$@\"\n",
        )
        .unwrap();
        let launcher = version.join("node_modules/@openai/codex/bin/codex.js");
        executable(&launcher);
        let env = env(&[("PATH", "/usr/bin:/bin")]);
        assert_eq!(
            installed_under(&env, home),
            vec![launcher.clone(), wrapper.clone()]
        );
        let (triple, package) = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => ("aarch64-apple-darwin", "codex-darwin-arm64"),
            ("macos", "x86_64") => ("x86_64-apple-darwin", "codex-darwin-x64"),
            ("linux", "aarch64") => ("aarch64-unknown-linux-musl", "codex-linux-arm64"),
            ("linux", "x86_64") => ("x86_64-unknown-linux-musl", "codex-linux-x64"),
            _ => return,
        };
        let native = version
            .join("node_modules/@openai")
            .join(package)
            .join("vendor")
            .join(triple)
            .join("bin/codex");
        executable(&native);
        assert_eq!(installed_under(&env, home), vec![native, launcher, wrapper]);
    }

    // Review on #2258: a Codex left in a mise node version never displaces
    // a system install that was found before; it still beats PATH.
    #[cfg(unix)]
    #[test]
    fn mise_node_installs_come_after_the_system_locations() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let in_node = npm_global_codex(&home.join(".local/share/mise/installs/node/22.23.2"));
        let candidates = executable_candidates(&env(&[("PATH", "/usr/bin")]), home);
        let position = |p: &Path| candidates.iter().position(|c| c == p).unwrap();
        assert!(position(Path::new("/usr/local/bin/codex")) < position(&in_node));
        assert!(position(&in_node) < position(Path::new("/usr/bin/codex")));
    }

    // mise's data folder follows MISE_DATA_DIR, then XDG_DATA_HOME.
    #[cfg(unix)]
    #[test]
    fn mise_installs_follow_mises_data_folder() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let data = home.join("data");
        let xdg = npm_global_codex(&data.join("mise/installs/npm-openai-codex/0.154.0"));
        let custom = npm_global_codex(&home.join("custom/installs/node/22.23.2"));
        let custom_dir = home.join("custom");
        assert_eq!(
            installed_under(&env(&[("XDG_DATA_HOME", data.to_str().unwrap())]), home),
            vec![xdg.clone()]
        );
        assert_eq!(
            installed_under(
                &env(&[
                    ("XDG_DATA_HOME", data.to_str().unwrap()),
                    ("MISE_DATA_DIR", custom_dir.to_str().unwrap()),
                ]),
                home
            ),
            vec![custom]
        );
        assert_eq!(
            installed_under(&env(&[("MISE_DATA_DIR", "relative/mise")]), home),
            Vec::<PathBuf>::new(),
            "a relative MISE_DATA_DIR falls back to ~/.local/share/mise"
        );
    }

    // #2247: the shim stays skipped even when it is the only `codex` on
    // PATH; the real mise install behind it is used instead.
    #[cfg(unix)]
    #[test]
    fn the_mise_shim_stays_skipped_beside_mise_installs() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let mise = home.join(".local/share/mise");
        let shim = mise.join("shims/codex");
        executable(&shim);
        let real = npm_global_codex(&mise.join("installs/npm-openai-codex/0.154.0"));
        let path = mise.join("shims");
        let env = env(&[("PATH", path.to_str().unwrap())]);
        let found = installed_under(&env, home);
        assert_eq!(found, vec![real]);
        assert!(!executable_candidates(&env, home).contains(&shim));
    }

    // #2247: RELAY_DESKTOP_CODEX still wins over every mise install.
    #[cfg(unix)]
    #[test]
    fn the_override_wins_over_mise_installs() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let installs = home.join(".local/share/mise/installs");
        npm_global_codex(&installs.join("npm-openai-codex/0.154.0"));
        npm_global_codex(&installs.join("node/22.23.2"));
        let pinned = home.join("pinned/codex");
        executable(&pinned);
        let config = CodexConfig::from_env(
            &env(&[("RELAY_DESKTOP_CODEX", pinned.to_str().unwrap())]),
            home,
        );
        assert_eq!(config.executable, Some(pinned));
    }
}
