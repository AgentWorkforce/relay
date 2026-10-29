//! Selected mode's catalog of local sessions: what the session list offers
//! to share.
//!
//! Native events drive exact shallow discovery for known dirty paths, while
//! resumable cold slices cover new sessions and missed events. Cold pacing has
//! its own deadline and excludes measured SQLite lock sleep. Every watch mode
//! keeps bounded recent-file safety polling. Failed initialization and round
//! creation retry with pacing, and folder-consent changes replace retained
//! roots and stale rounds. Discovery never acquires unselected evidence.
use super::{collector, history};
use ai_hist::{Source, WatchScope, WatchedPath};
use notify::{event::ModifyKind, EventKind, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::{Duration, Instant},
};

mod follow;

/// How the inventory runs. [`InventoryOptions::default`] is production;
/// tests shorten the intervals.
#[derive(Clone, Debug)]
pub(super) struct InventoryOptions {
    /// Before the first pass, which the first delivery pass goes ahead of.
    pub startup: Duration,
    /// The next pass waits at least this many times as long as the last one
    /// took: discovery's share of a core stays at or under its reciprocal.
    pub duty_factor: u32,
    /// The least time between two passes, however cheap the last one was.
    pub min_gap: Duration,
    /// How often every source is discovered whatever the watcher reported.
    pub backstop: Duration,
    /// How long a first event waits for the rest of its write before the
    /// pass it asks for runs.
    pub settle: Duration,
    pub use_fs_events: bool,
}
impl Default for InventoryOptions {
    fn default() -> Self {
        Self {
            startup: Duration::from_secs(1),
            duty_factor: 50,
            min_gap: Duration::from_secs(30),
            backstop: Duration::from_secs(30 * 60),
            settle: Duration::from_secs(2),
            use_fs_events: super::live::fs_events_enabled(),
        }
    }
}

enum Signal {
    Changed(PathBuf),
    /// The watcher dropped events (a rescan) or failed: a write to any
    /// source may have gone unreported.
    Lost,
    Stop,
}

/// The running inventory. Dropping it ends the thread at its next wait
/// without joining it: an in-flight provider read never blocks the
/// collector's shutdown, and it stops on the probe's stop request itself.
pub(super) struct Inventory(mpsc::Sender<Signal>);
impl Drop for Inventory {
    fn drop(&mut self) {
        let _ = self.0.send(Signal::Stop);
    }
}

/// Start the inventory; `catalogued` runs after each pass.
pub(super) fn start(
    directory: &Path,
    cancelled: Arc<AtomicBool>,
    options: InventoryOptions,
    catalogued: impl Fn() + Send + 'static,
) -> Inventory {
    let directory = directory.to_path_buf();
    let (signals, received) = mpsc::channel();
    let events = signals.clone();
    std::thread::spawn(move || {
        super::priority::background("inventory");
        if received.recv_timeout(options.startup).is_ok() {
            return;
        }
        follow::run(follow::Context {
            directory: &directory,
            cancelled: &cancelled,
            received: &received,
            events: &events,
            options: &options,
            catalogued: &catalogued,
        });
    });
    Inventory(signals)
}

/// The filesystem watcher over the paths the store's own watch covers, and
/// which source each of them belongs to. Selected mode's inventory and broad
/// mode's live capture both follow provider roots through it.
pub(super) struct Watch {
    _watcher: notify::RecommendedWatcher,
    covered: Vec<(Source, Covered)>,
    /// What was registered, each target with how it was registered.
    registered: BTreeMap<PathBuf, RecursiveMode>,
    complete: bool,
    activity: Arc<std::sync::atomic::AtomicU64>,
}
/// Why no watcher runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Unwatched {
    /// No path the store's watch covers exists yet.
    NoRoots,
    /// Paths exist, but no watcher could be registered on any of them: no
    /// backend, too many watches, `EMFILE`, or the store's paths could not
    /// be read.
    Unavailable,
}
impl Watch {
    /// Watch every existing path the store's own watch covers. `written`
    /// is called with each admitted path a write event names, and with `None`
    /// for an admitted rename, pathless loss, or when the
    /// watcher reports an error, after which a write may have gone
    /// unreported.
    pub(super) fn start(
        db: &Path,
        written: impl Fn(Option<PathBuf>) + Send + 'static,
    ) -> Result<Self, Unwatched> {
        let paths = history::watched_paths(db).map_err(|_| Unwatched::Unavailable)?;
        Self::start_paths(paths, written)
    }

    pub(super) fn start_paths(
        paths: Vec<history::Watched>,
        written: impl Fn(Option<PathBuf>) + Send + 'static,
    ) -> Result<Self, Unwatched> {
        let registrations = registrations(&paths);
        if registrations.is_empty() {
            return Err(Unwatched::NoRoots);
        }
        let covered: Vec<_> = paths
            .into_iter()
            .map(|watched| (watched.source, Covered::new(watched.path)))
            .collect();
        let admitted = covered.clone();
        let activity = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let observed = activity.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                for path in admitted_notices(event, |path| {
                    admitted.iter().any(|(_, root)| root.covers(path))
                }) {
                    observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    written(path);
                }
            })
            .map_err(|_| Unwatched::Unavailable)?;
        let expected = registrations.len();
        let registered: BTreeMap<PathBuf, RecursiveMode> = registrations
            .into_iter()
            .filter(|(target, mode)| watcher.watch(target, *mode).is_ok())
            .collect();
        if registered.is_empty() {
            return Err(Unwatched::Unavailable);
        }
        Ok(Self {
            _watcher: watcher,
            complete: registered.len() == expected,
            covered,
            activity,
            registered,
        })
    }

    /// Every existing requested root was registered. Partial coverage still
    /// receives useful events, but must keep the bounded polling fallback.
    pub(super) fn complete(&self) -> bool {
        self.complete
    }

    pub(super) fn activity(&self) -> Arc<std::sync::atomic::AtomicU64> {
        self.activity.clone()
    }

    /// The sources a write at `path` belongs to.
    pub(super) fn sources<'a>(&'a self, path: &'a Path) -> impl Iterator<Item = Source> + 'a {
        self.covered
            .iter()
            .filter(move |(_, covered)| covered.covers(path))
            .map(|(source, _)| *source)
    }

    /// Whether a write at `path` is evidence for any source.
    pub(super) fn covers(&self, path: &Path) -> bool {
        self.sources(path).next().is_some()
    }

    /// Whether registering afresh would watch something this watcher does
    /// not: a provider root created since, or one whose registration failed.
    pub(super) fn outdated_paths(&self, paths: &[history::Watched]) -> bool {
        registrations(paths) != self.registered
    }

    #[cfg(test)]
    pub(super) fn outdated(&self, db: &Path) -> bool {
        history::watched_paths(db)
            .map(|paths| registrations(&paths) != self.registered)
            .unwrap_or(false)
    }
}

/// Named renames must be admitted while their paths still exist in the event.
/// Promoting an unrelated atomic diagnostic rename to a pathless loss would
/// otherwise feed the collector's own writes back into reconciliation.
fn admitted_notices(
    event: notify::Result<notify::Event>,
    admits: impl Fn(&Path) -> bool,
) -> Vec<Option<PathBuf>> {
    let unrelated_rename = event.as_ref().is_ok_and(|event| {
        matches!(event.kind, EventKind::Modify(ModifyKind::Name(_)))
            && !event.need_rescan()
            && !event.paths.is_empty()
            && !event
                .paths
                .iter()
                .any(|path| !sqlite_index(path) && admits(path))
    });
    if unrelated_rename {
        return Vec::new();
    }
    noticed(event)
        .into_iter()
        .filter(|path| path.as_ref().is_none_or(|path| admits(path)))
        .collect()
}

/// What one watcher callback reports: each path a write event names, or a
/// single `None` when events may have gone unreported. A rescan (an inotify
/// queue overflow, FSEvents' `MustScanSubDirs` after the kernel or the
/// stream dropped events) arrives with no path at all, or naming only a
/// directory the store's filter does not admit, so it is a loss, never a
/// path; so is a write event naming no path, and a watcher error.
pub(super) fn noticed(event: notify::Result<notify::Event>) -> Vec<Option<PathBuf>> {
    let event = match event {
        Ok(event) => event,
        Err(_) => return vec![None],
    };
    if event.need_rescan() || matches!(event.kind, EventKind::Modify(ModifyKind::Name(_))) {
        return vec![None];
    }
    if !writes(&event.kind) {
        return Vec::new();
    }
    if event.paths.is_empty() {
        return vec![None];
    }
    event
        .paths
        .into_iter()
        .filter(|path| !sqlite_index(path))
        .map(Some)
        .collect()
}

/// What to register for every existing watched path, a target registered
/// recursively when any path under it asks for that.
pub(super) fn registrations(paths: &[history::Watched]) -> BTreeMap<PathBuf, RecursiveMode> {
    let mut registrations: BTreeMap<PathBuf, RecursiveMode> = BTreeMap::new();
    for watched in paths {
        let (target, mode) = registration(&watched.path);
        let Some(target) = target else { continue };
        let held = registrations.entry(target).or_insert(mode);
        if mode == RecursiveMode::Recursive {
            *held = mode;
        }
    }
    registrations
}

/// Whether an event reports a write: a file's contents or its directory's
/// entries moved. Opening and closing a file is not, even one opened for
/// writing (SQLite opens a read-only connection's `-wal` that way), and
/// neither is a change to a file's metadata alone (opening a provider's
/// database updates its sidecars' extended attributes). Discovery's own
/// reads raise both, and would otherwise mark that provider again, forever.
pub(super) fn writes(kind: &EventKind) -> bool {
    !matches!(
        kind,
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))
    )
}

/// Whether `path` is an SQLite database's shared-memory index. Reading a
/// database in WAL mode updates it, so discovery's own read of a provider's
/// store would mark that provider again, forever; a write always moves the
/// database itself or its `-wal` or `-journal`.
fn sqlite_index(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with("-shm"))
}

/// What to register for a watched path: a single file through its parent,
/// because a watch on the file itself ends with the next atomic rewrite;
/// a directory's own entries without recursing; a tree whole. `None` for a
/// path that does not exist yet, which the next backstop registers.
fn registration(path: &WatchedPath) -> (Option<PathBuf>, RecursiveMode) {
    let (target, mode) = match path.scope {
        WatchScope::File => (path.path.parent(), RecursiveMode::NonRecursive),
        WatchScope::Directory => (Some(path.path.as_path()), RecursiveMode::NonRecursive),
        _ => (Some(path.path.as_path()), RecursiveMode::Recursive),
    };
    (
        target
            .filter(|target| target.exists())
            .map(Path::to_path_buf),
        mode,
    )
}

/// A watched path in each spelling an event can arrive in: as configured,
/// and with its symlinks resolved, which is how some backends report it.
#[derive(Clone)]
struct Covered {
    watched: WatchedPath,
    spellings: Vec<PathBuf>,
}
impl Covered {
    fn new(watched: WatchedPath) -> Self {
        let path = watched.path.clone();
        let resolved = match watched.scope {
            WatchScope::File => path
                .parent()
                .and_then(|parent| Some(parent.canonicalize().ok()?.join(path.file_name()?))),
            _ => path.canonicalize().ok(),
        };
        let mut spellings = vec![path];
        spellings.extend(resolved.filter(|resolved| *resolved != spellings[0]));
        Self { watched, spellings }
    }

    /// The store's own rule: an entry of a directory counts when the store's
    /// filter admits it, and the directory itself always does.
    fn covers(&self, path: &Path) -> bool {
        self.spellings.iter().any(|root| match self.watched.scope {
            WatchScope::File => path == root,
            WatchScope::Directory => match (path.parent(), path.file_name()) {
                (Some(parent), Some(name)) if parent == root => self.watched.admits(name),
                _ => path == root,
            },
            _ => path.starts_with(root),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live::tests::{append, eventually, isolated_home, transcript_line};
    use std::fs;

    #[test]
    fn unrelated_named_renames_do_not_become_pathless_losses() {
        use notify::event::{Flag, RenameMode};
        let renamed = |path: &str| {
            notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(PathBuf::from(path))
        };
        let admits = |path: &Path| path == Path::new("/home/opencode.db");
        assert!(admitted_notices(Ok(renamed("/home/probe/cycle.json")), admits).is_empty());
        assert!(matches!(
            admitted_notices(Ok(renamed("/home/opencode.db")), admits).as_slice(),
            [None]
        ));
        assert!(matches!(
            admitted_notices(
                Ok(renamed("/home/probe/cycle.json").set_flag(Flag::Rescan)),
                admits
            )
            .as_slice(),
            [None]
        ));
        assert!(matches!(
            admitted_notices(
                Ok(notify::Event::new(EventKind::Modify(ModifyKind::Name(
                    RenameMode::Any
                )))),
                admits
            )
            .as_slice(),
            [None]
        ));
    }

    fn options(use_fs_events: bool) -> InventoryOptions {
        // Spaced by the least gap alone, so a test's quiet window is not
        // outlasted by a pass the duty factor is still holding back.
        InventoryOptions {
            startup: Duration::ZERO,
            duty_factor: 0,
            min_gap: Duration::from_millis(100),
            backstop: Duration::from_secs(60 * 60),
            settle: Duration::from_millis(50),
            use_fs_events,
        }
    }

    fn catalogued(db: &Path, session: &str) -> bool {
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .and_then(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=?)",
                    [session],
                    |row| row.get(0),
                )
            })
            .unwrap_or(false)
    }

    /// When the inventory last finished a pass, by its diagnostic.
    fn last_pass(directory: &Path) -> Option<std::time::SystemTime> {
        fs::metadata(directory.join("inventory-diagnostic.json"))
            .and_then(|meta| meta.modified())
            .ok()
    }

    /// A store and one catalogued session, with the inventory running.
    fn running(home: &Path, use_fs_events: bool) -> (PathBuf, PathBuf, Inventory) {
        let directory = home.join("probe");
        fs::create_dir_all(&directory).unwrap();
        let db = directory.join("history.db");
        history::open(&db).unwrap();
        let project = home.join(".claude/projects/inventory");
        fs::create_dir_all(&project).unwrap();
        append(
            &project.join("first.jsonl"),
            &transcript_line("first", "one"),
        );
        let inventory = start(
            &directory,
            Arc::new(AtomicBool::new(false)),
            options(use_fs_events),
            || {},
        );
        eventually("the first pass", Duration::from_secs(30), || {
            catalogued(&db, "first")
        });
        (directory, project, inventory)
    }

    /// A session written after the first pass is catalogued by the event it
    /// raises, long before the backstop comes round.
    #[test]
    fn a_new_session_is_catalogued_by_its_event() {
        let Some(home) =
            isolated_home("inventory::tests::a_new_session_is_catalogued_by_its_event")
        else {
            return;
        };
        let (directory, project, _inventory) = running(&home, true);
        append(
            &project.join("later.jsonl"),
            &transcript_line("later", "one"),
        );
        eventually("the event's pass", Duration::from_secs(15), || {
            catalogued(&directory.join("history.db"), "later")
        });
    }

    /// With nothing written under a provider root, no pass runs between
    /// backstops.
    #[test]
    fn an_idle_history_is_not_rediscovered() {
        let Some(home) = isolated_home("inventory::tests::an_idle_history_is_not_rediscovered")
        else {
            return;
        };
        let (directory, _project, _inventory) = running(&home, true);
        // A backend may still report the writes made before it attached.
        let mut seen = last_pass(&directory);
        let quiescing = std::time::Instant::now();
        loop {
            assert!(
                quiescing.elapsed() < Duration::from_secs(20),
                "inventory never becomes idle; last diagnostic: {:?}",
                fs::read_to_string(directory.join("inventory-diagnostic.json"))
            );
            std::thread::sleep(Duration::from_millis(1_000));
            let now = last_pass(&directory);
            if now == seen {
                break;
            }
            seen = now;
        }
        std::thread::sleep(Duration::from_millis(1_500));
        assert_eq!(
            last_pass(&directory),
            seen,
            "a pass ran with nothing written"
        );
    }

    /// Without a filesystem watcher every pass discovers every source, at the
    /// spaced cadence rather than the backstop's.
    #[test]
    fn without_filesystem_events_the_inventory_polls() {
        let Some(home) =
            isolated_home("inventory::tests::without_filesystem_events_the_inventory_polls")
        else {
            return;
        };
        let (directory, project, _inventory) = running(&home, false);
        append(
            &project.join("later.jsonl"),
            &transcript_line("later", "one"),
        );
        eventually("a polled pass", Duration::from_secs(15), || {
            catalogued(&directory.join("history.db"), "later")
        });
    }

    #[test]
    fn stopping_inventory_during_bounded_cold_work_ends_the_worker() {
        let Some(home) = isolated_home(
            "inventory::tests::stopping_inventory_during_bounded_cold_work_ends_the_worker",
        ) else {
            return;
        };
        let directory = home.join("probe");
        fs::create_dir_all(&directory).unwrap();
        let db = directory.join("history.db");
        history::open(&db).unwrap();
        let project = home.join(".claude/projects/stopping");
        fs::create_dir_all(&project).unwrap();
        for n in 0..1000 {
            append(
                &project.join(format!("archive-{n}.jsonl")),
                &transcript_line(&format!("archive-{n}"), "one"),
            );
        }
        let (worker_lifetime, done) = std::sync::mpsc::channel::<()>();
        let (at_slice, reached) = std::sync::mpsc::sync_channel(0);
        let (resume, released) = std::sync::mpsc::sync_channel(0);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        let inventory = start(
            &directory,
            Arc::new(AtomicBool::new(false)),
            options(false),
            move || {
                let _ = &worker_lifetime;
                if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    at_slice.send(()).unwrap();
                    released.recv().unwrap();
                }
            },
        );
        reached.recv_timeout(Duration::from_secs(30)).unwrap();
        let count: i64 = rusqlite::Connection::open(&db)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert!(
            count < 1000,
            "the barrier must interrupt an unfinished round: {count}"
        );
        drop(inventory);
        resume.send(()).unwrap();
        assert!(
            matches!(
                done.recv_timeout(Duration::from_secs(3)),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
            ),
            "stop must be handled between bounded slices"
        );
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "no further slice after stop"
        );
    }

    #[test]
    fn initialization_retries_after_a_real_store_open_failure() {
        let Some(home) = isolated_home(
            "inventory::tests::initialization_retries_after_a_real_store_open_failure",
        ) else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        fs::create_dir_all(&db).unwrap(); // a directory cannot be opened as SQLite
        let project = home.join(".claude/projects/recovered");
        fs::create_dir_all(&project).unwrap();
        append(
            &project.join("recovered.jsonl"),
            &transcript_line("recovered", "one"),
        );
        let _inventory = start(
            &directory,
            Arc::new(AtomicBool::new(false)),
            options(false),
            || {},
        );
        eventually(
            "initial open failure is reported",
            Duration::from_secs(10),
            || {
                fs::read(directory.join("inventory-diagnostic.json"))
                    .ok()
                    .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
                    .is_some_and(|value| value["failures"] == 1)
            },
        );
        fs::remove_dir(&db).unwrap();
        eventually(
            "inventory recovers without restarting",
            Duration::from_secs(15),
            || catalogued(&db, "recovered"),
        );
    }

    #[test]
    fn enabling_default_folder_refreshes_an_already_running_inventory() {
        let Some(home) = isolated_home(
            "inventory::tests::enabling_default_folder_refreshes_an_already_running_inventory",
        ) else {
            return;
        };
        let env = |key: &str| std::env::var(key).ok();
        let dirs = agent_relay_probe::relay::claude_dirs::ClaudeDirs::from_env(
            &env,
            &home,
            &agent_relay_probe::relay::workspace::relay_home(&env, &home),
        );
        let default = home.join(".claude");
        let project = default.join("projects/consent");
        fs::create_dir_all(&project).unwrap();
        append(
            &project.join("newly-shared.jsonl"),
            &transcript_line("newly-shared", "one"),
        );
        dirs.set_shared(default.to_str().unwrap(), false, &default)
            .unwrap();
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let (passed, first) = mpsc::channel();
        let _inventory = start(
            &directory,
            Arc::new(AtomicBool::new(false)),
            options(false),
            move || {
                let _ = passed.send(());
            },
        );
        first.recv_timeout(Duration::from_secs(15)).unwrap();
        assert!(!catalogued(&db, "newly-shared"));
        dirs.set_shared(default.to_str().unwrap(), true, &default)
            .unwrap();
        eventually(
            "changed consent refreshes retained roots",
            Duration::from_secs(15),
            || catalogued(&db, "newly-shared"),
        );
    }

    /// Discovery's own read of a provider's SQLite store rewrites the
    /// store's `-shm` index when no other connection holds it; that is not a
    /// write, so it asks for no pass.
    #[test]
    fn reading_a_provider_database_asks_for_no_pass() {
        let Some(home) =
            isolated_home("inventory::tests::reading_a_provider_database_asks_for_no_pass")
        else {
            return;
        };
        // A WAL store whose `-wal` and `-shm` outlived the process that wrote
        // it, as OpenCode's do: copied while its writer still holds them.
        let written = home.join("written");
        fs::create_dir_all(&written).unwrap();
        let writer = rusqlite::Connection::open(written.join("opencode.db")).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1);")
            .unwrap();
        for suffix in ["", "-wal", "-shm"] {
            fs::copy(
                written.join(format!("opencode.db{suffix}")),
                home.join(format!("opencode.db{suffix}")),
            )
            .unwrap();
        }
        drop(writer);
        let (directory, _project, _inventory) = running(&home, true);
        let mut seen = last_pass(&directory);
        loop {
            std::thread::sleep(Duration::from_millis(1_000));
            let now = last_pass(&directory);
            if now == seen {
                break;
            }
            seen = now;
        }
        std::thread::sleep(Duration::from_millis(1_500));
        assert_eq!(last_pass(&directory), seen, "a read asked for a pass");
    }

    /// Events the watcher dropped ask for a pass over every source, though
    /// nothing named a path some source reads.
    #[test]
    fn a_lost_event_asks_for_a_full_pass() {
        let Some(home) = isolated_home("inventory::tests::a_lost_event_asks_for_a_full_pass")
        else {
            return;
        };
        let (directory, project, inventory) = running(&home, true);
        let mut seen = last_pass(&directory);
        loop {
            std::thread::sleep(Duration::from_millis(1_000));
            let now = last_pass(&directory);
            if now == seen {
                break;
            }
            seen = now;
        }
        // A session no event reported, as after a queue overflow.
        append(
            &project.join("dropped.jsonl"),
            &transcript_line("dropped", "one"),
        );
        let mut held = last_pass(&directory);
        loop {
            std::thread::sleep(Duration::from_millis(1_000));
            let now = last_pass(&directory);
            if now == held {
                break;
            }
            held = now;
        }
        // The write's own event may already have catalogued it; forget it so
        // only the loss can bring it back.
        rusqlite::Connection::open(directory.join("history.db"))
            .unwrap()
            .execute("DELETE FROM sessions WHERE session_id='dropped'", [])
            .unwrap();
        inventory.0.send(Signal::Lost).unwrap();
        eventually("the loss's pass", Duration::from_secs(15), || {
            catalogued(&directory.join("history.db"), "dropped")
        });
    }

    /// After a loss the watcher is registered again, so a provider root
    /// created since it last registered is followed from then on rather than
    /// from the next backstop.
    #[test]
    fn a_lost_event_registers_the_watcher_again() {
        let Some(home) =
            isolated_home("inventory::tests::a_lost_event_registers_the_watcher_again")
        else {
            return;
        };
        let directory = home.join("probe");
        fs::create_dir_all(&directory).unwrap();
        let db = directory.join("history.db");
        history::open(&db).unwrap();
        // Something to watch at start, so a watcher runs, but no Claude root.
        fs::create_dir_all(home.join(".codex")).unwrap();
        append(
            &home.join(".codex/history.jsonl"),
            &format!(
                "{}\n",
                serde_json::json!({"session_id":"codex","ts":1_700_000_000,"text":"synthetic"})
            ),
        );
        let inventory = start(
            &directory,
            Arc::new(AtomicBool::new(false)),
            options(true),
            || {},
        );
        eventually("the first pass", Duration::from_secs(30), || {
            last_pass(&directory).is_some()
        });
        let mut seen = last_pass(&directory);
        loop {
            std::thread::sleep(Duration::from_millis(1_000));
            let now = last_pass(&directory);
            if now == seen {
                break;
            }
            seen = now;
        }
        // A provider root the watcher was not registered on.
        let project = home.join(".claude/projects/late");
        fs::create_dir_all(&project).unwrap();
        inventory.0.send(Signal::Lost).unwrap();
        eventually("the loss's pass", Duration::from_secs(15), || {
            last_pass(&directory) != seen
        });
        std::thread::sleep(Duration::from_millis(500));
        append(
            &project.join("after.jsonl"),
            &transcript_line("after", "one"),
        );
        eventually("the new root's event", Duration::from_secs(15), || {
            catalogued(&db, "after")
        });
    }

    /// A rescan arrives with no path (an inotify queue overflow, FSEvents
    /// after dropped events), or naming only a directory; either way it is
    /// a loss, as is a watcher error and a write naming no path.
    #[test]
    fn a_rescan_or_a_pathless_write_is_a_loss() {
        use notify::event::{AccessKind, DataChange, Flag};
        let rescan = notify::Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(noticed(Ok(rescan)), vec![None]);
        let rescan = notify::Event::new(EventKind::Other)
            .set_flag(Flag::Rescan)
            .add_path(PathBuf::from("/home/a/.claude"));
        assert_eq!(noticed(Ok(rescan)), vec![None]);
        assert_eq!(
            noticed(Err(notify::Error::generic("watcher failed"))),
            vec![None]
        );
        let renamed = notify::Event::new(EventKind::Modify(ModifyKind::Name(
            notify::event::RenameMode::Both,
        )))
        .add_path(PathBuf::from("/home/a/.claude/projects/old"))
        .add_path(PathBuf::from("/home/a/.claude/projects/new"));
        assert_eq!(noticed(Ok(renamed)), vec![None]);
        let pathless = notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)));
        assert_eq!(noticed(Ok(pathless)), vec![None]);

        let written = PathBuf::from("/home/a/.claude/projects/p/s.jsonl");
        let write = notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
            .add_path(written.clone())
            .add_path(PathBuf::from("/home/a/opencode.db-shm"));
        assert_eq!(noticed(Ok(write)), vec![Some(written.clone())]);
        let read = notify::Event::new(EventKind::Access(AccessKind::Any)).add_path(written);
        assert!(noticed(Ok(read)).is_empty());
    }

    #[test]
    fn a_shared_memory_index_is_not_a_write() {
        assert!(sqlite_index(Path::new("/x/opencode.db-shm")));
        assert!(!sqlite_index(Path::new("/x/opencode.db-wal")));
        assert!(!sqlite_index(Path::new("/x/opencode.db")));
    }

    /// A watched path whose directory entries are all evidence, as the store
    /// serializes one.
    fn unfiltered(scope: WatchScope, path: &Path) -> WatchedPath {
        serde_json::from_value(serde_json::json!({
            "path": path,
            "scope": scope,
            "entries": "all",
        }))
        .unwrap()
    }

    #[test]
    fn a_watched_path_covers_what_its_scope_says() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let covered = |scope, path: &Path| Covered::new(unfiltered(scope, path));
        let file = covered(WatchScope::File, &base.join("history.jsonl"));
        assert!(file.covers(&base.join("history.jsonl")));
        assert!(!file.covers(&base.join("todos.json")));

        let directory = covered(WatchScope::Directory, &base.join("opencode"));
        assert!(directory.covers(&base.join("opencode/opencode.db-wal")));
        assert!(!directory.covers(&base.join("opencode/storage/part.json")));

        let mut roots = ai_hist::ProviderRoots::from_home(base.clone(), base.join("opencode.db"));
        roots.opencode_db_pinned = false;
        let stores = Covered::new(
            Source::OpenCode
                .capabilities()
                .watch_roots(&roots)
                .into_iter()
                .find(|watched| watched.scope == WatchScope::Directory && watched.path == base)
                .expect("OpenCode's database directory is watched"),
        );
        for store in ["opencode.db", "opencode.db-wal", "opencode-beta.db-shm"] {
            assert!(stores.covers(&base.join(store)), "{store}");
        }
        for other in ["probe", "notes.txt", "opencode-.db", "opencode.db.bak"] {
            assert!(!stores.covers(&base.join(other)), "{other}");
        }
        // The directory itself changing is evidence, as it is to the store.
        assert!(stores.covers(&base));

        let tree = covered(WatchScope::Tree, &base.join("projects"));
        assert!(tree.covers(&base.join("projects/a/b/session.jsonl")));
        assert!(!tree.covers(&base.join("elsewhere/session.jsonl")));
    }

    /// Some backends report a path with its symlinks resolved.
    #[cfg(unix)]
    #[test]
    fn a_watched_path_covers_its_resolved_spelling() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        fs::create_dir_all(&real).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let tree = Covered::new(unfiltered(WatchScope::Tree, &link));
        assert!(tree.covers(&real.canonicalize().unwrap().join("session.jsonl")));
    }

    #[test]
    fn reads_and_metadata_are_not_writes() {
        use notify::event::{
            AccessKind, AccessMode, CreateKind, DataChange, MetadataKind, RemoveKind,
        };
        for read in [
            EventKind::Access(AccessKind::Read),
            EventKind::Access(AccessKind::Close(AccessMode::Read)),
            EventKind::Access(AccessKind::Close(AccessMode::Write)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Extended)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Ownership)),
        ] {
            assert!(!writes(&read), "{read:?}");
        }
        for write in [
            EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            EventKind::Modify(ModifyKind::Any),
            EventKind::Create(CreateKind::File),
            EventKind::Remove(RemoveKind::File),
        ] {
            assert!(writes(&write), "{write:?}");
        }
    }
}
