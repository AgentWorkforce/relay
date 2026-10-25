//! Selected mode's catalog of local sessions: what the session list offers
//! to share.
//!
//! Shallow discovery reads every provider's metadata, and on a large history
//! a pass that finds nothing new still costs seconds of CPU, so the catalog
//! follows the providers instead of a timer. A filesystem watcher over the
//! paths the store's own watch covers marks the source a write landed under,
//! and the next pass discovers only the marked sources. Passes are spaced by
//! what they cost: the next starts no sooner than 50 times the last one's
//! duration after it ended, and never sooner than the minimum gap,
//! so discovery holds at most about a fiftieth of a core however busy the
//! providers are. Every backstop a pass discovers every source, for writes
//! no event reported, and registers the watcher afresh, for provider roots
//! created since. Without a watcher every pass discovers every source, at
//! the spaced cadence. Each finished pass is reported to the caller, whose
//! selected members in a shared database move with the rows a pass refreshes.
use super::{collector, history};
use ai_hist::{Source, WatchScope, WatchedPath};
use notify::{event::ModifyKind, EventKind, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::{Duration, Instant},
};

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
        follow(
            &directory,
            &cancelled,
            &received,
            &events,
            &options,
            &catalogued,
        );
    });
    Inventory(signals)
}

fn follow(
    directory: &Path,
    cancelled: &Arc<AtomicBool>,
    received: &mpsc::Receiver<Signal>,
    events: &mpsc::Sender<Signal>,
    options: &InventoryOptions,
    catalogued: &dyn Fn(),
) {
    let db = directory.join("history.db");
    let mut watch: Option<Watch> = None;
    let mut marked = BTreeSet::new();
    // Events were lost since the last pass: the next one discovers every
    // source, at the spaced cadence.
    let mut lost = false;
    let mut settled = Instant::now();
    let mut spaced = Instant::now();
    let mut full_at = Instant::now();
    while !collector::stopping(cancelled) {
        let now = Instant::now();
        let full = now >= full_at;
        let owed = !marked.is_empty() || lost;
        if full || (owed && now >= spaced.max(settled)) {
            let rescan = std::mem::take(&mut lost);
            let sources = if full || rescan {
                // A fresh registration picks up roots created since the last
                // one, and replaces a watcher that dropped events or failed;
                // events from here on are the next pass's.
                if full || rescan {
                    watch = options
                        .use_fs_events
                        .then(|| {
                            let events = events.clone();
                            Watch::start(&db, move |path| {
                                let _ = events.send(match path {
                                    Some(path) => Signal::Changed(path),
                                    None => Signal::Lost,
                                });
                            })
                            .ok()
                        })
                        .flatten();
                }
                marked.clear();
                None
            } else {
                Some(std::mem::take(&mut marked).into_iter().collect())
            };
            let took = pass(directory, &db, sources, cancelled);
            catalogued();
            let gap = (took * options.duty_factor).clamp(options.min_gap, options.backstop);
            spaced = Instant::now() + gap;
            if full {
                full_at = if watch.is_some() {
                    Instant::now() + options.backstop
                } else {
                    spaced
                };
            }
            continue;
        }
        let wake = if !owed {
            full_at
        } else {
            full_at.min(spaced.max(settled))
        };
        match received.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(Signal::Changed(path)) => {
                let Some(watch) = &watch else { continue };
                marked.extend(watch.sources(&path));
                if !owed && !marked.is_empty() {
                    settled = Instant::now() + options.settle;
                }
            }
            Ok(Signal::Lost) => {
                if watch.is_none() {
                    continue;
                }
                lost = true;
                if !owed {
                    settled = Instant::now() + options.settle;
                }
            }
            Ok(Signal::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

/// One discovery pass of `sources`, every source when `None`, with the
/// diagnostic every pass writes. Returns how long it took.
fn pass(
    directory: &Path,
    db: &Path,
    sources: Option<Vec<Source>>,
    cancelled: &Arc<AtomicBool>,
) -> Duration {
    let started = Instant::now();
    let stop = cancelled.clone();
    let result = history::discover_sources(db, None, sources, move || collector::stopping(&stop));
    let _ = collector::capture_diagnostic(
        directory,
        "shallow_inventory",
        started,
        result.as_ref().copied().unwrap_or(0),
        usize::from(result.is_err()),
        result.as_ref().err(),
    );
    started.elapsed()
}

/// The filesystem watcher over the paths the store's own watch covers, and
/// which source each of them belongs to. Selected mode's inventory and broad
/// mode's live capture both follow provider roots through it.
pub(super) struct Watch {
    _watcher: notify::RecommendedWatcher,
    covered: Vec<(Source, Covered)>,
    /// What was registered, each target with how it was registered.
    registered: BTreeMap<PathBuf, RecursiveMode>,
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
    /// is called with each path a write event names (the store's filter is
    /// the caller's, through [`Watch::sources`]), and with `None` when the
    /// watcher reports an error, after which a write may have gone
    /// unreported.
    pub(super) fn start(
        db: &Path,
        written: impl Fn(Option<PathBuf>) + Send + 'static,
    ) -> Result<Self, Unwatched> {
        let paths = history::watched_paths(db).map_err(|_| Unwatched::Unavailable)?;
        let registrations = registrations(&paths);
        if registrations.is_empty() {
            return Err(Unwatched::NoRoots);
        }
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                for path in noticed(event) {
                    written(path);
                }
            })
            .map_err(|_| Unwatched::Unavailable)?;
        let registered: BTreeMap<PathBuf, RecursiveMode> = registrations
            .into_iter()
            .filter(|(target, mode)| watcher.watch(target, *mode).is_ok())
            .collect();
        if registered.is_empty() {
            return Err(Unwatched::Unavailable);
        }
        Ok(Self {
            _watcher: watcher,
            covered: paths
                .into_iter()
                .map(|watched| (watched.source, Covered::new(watched.path)))
                .collect(),
            registered,
        })
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
    pub(super) fn outdated(&self, db: &Path) -> bool {
        history::watched_paths(db)
            .map(|paths| registrations(&paths) != self.registered)
            .unwrap_or(false)
    }
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
        loop {
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
