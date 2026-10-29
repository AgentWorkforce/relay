//! Live capture: the collector's capture thread, apart from delivery.
//!
//! In `all` and `new` sharing modes the thread attaches the filesystem watcher
//! before beginning resumable historical reconciliation. Admitted writes keep
//! exact provider paths in a bounded pending set; hot passes acquire up to eight
//! paths after debounce and cost pacing, waking delivery when content changes.
//! Cold slices have a separate deadline and retain directory positions. A due
//! cold slice gets a turn after at most one hot pass. Watcher loss, overflow and
//! backstops schedule fresh coverage without abandoning unfinished work.
//! Every watch mode retains an independent five-second poll of up to 32
//! recent catalogued/admitted paths; other paths rely on cold coverage. Folder consent
//! changes refresh retained roots and discard stale iterator/pending state.
//! Full maintenance uses the SDK's cooperative provider/file/record boundaries
//! and yields when admitted writes or fallback changes need hot capture. These
//! are input-count and cooperative boundaries, not hard elapsed-time limits.
//!
//! In `selected` mode a companion only enumerates remote catalog metadata;
//! the member thread enumerates no provider: a filesystem watch over
//! the directories of the members' transcripts names the member a write
//! landed on, and after a short debounce the thread compares that member's
//! transcript with what it last hydrated and hydrates it if it moved. A
//! member in a shared database moves with its own catalog row, compared
//! after each inventory pass. Every member is hydrated each
//! [`MEMBER_BACKSTOP_INTERVAL`], and a transcript no watch covers is
//! compared every [`MEMBER_POLL_INTERVAL`].
//!
//! The thread reports a capture verdict and content-free counts and
//! durations through [`Shared`], which the delivery loop folds into each pass
//! report; it never writes the pass report itself.
mod broad;
mod maintenance;
mod member_safety;
#[cfg(test)]
use broad::gap;
use member_safety::stamps;
mod metrics;
mod selected_remote;
use metrics::Metrics;
mod not_ready;
mod watching;

use watching::{Noticed, Owed, Watching};

use super::collector::stopping;
use super::{collector, history, inventory};
use agent_relay_probe::delivery;
use ai_hist::{SessionRef, Source};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime},
};

/// How long a burst of filesystem events is coalesced before the sweep it
/// asks for runs, or in selected mode the member round: long enough to fold
/// the several writes of one transcript update into one sweep, short enough
/// that an interactive turn is captured well within a second once the pace
/// allows. The window always ends rather than waiting for quiet.
pub(super) const WATCH_DEBOUNCE: Duration = Duration::from_millis(200);
/// Broad mode's pace: the next sweep starts no sooner than this many times
/// the last one's duration after it ended, so sweeps hold at most about
/// `1 / (1 + factor)` of a core however busy the providers are. A sweep that
/// reads a moved transcript of a typical history takes tens of
/// milliseconds, so the least gap, not this, paces it.
pub(super) const SWEEP_DUTY_FACTOR: u32 = 10;
/// Cold maintenance has its own conservative occupancy budget. Success slices
/// have no fixed minimum sleep; one atomic input may still be expensive.
const COLD_DUTY_FACTOR: u32 = 50;
/// The least time from the end of one broad-mode sweep to the start of the
/// next, however cheap it was: sustained writes are swept about this often,
/// and a line an agent writes is captured within about this long plus the
/// debounce.
pub(super) const SWEEP_MIN_GAP: Duration = Duration::from_secs(1);
/// Full reconciliation is due this long after the previous full pass, even
/// while scoped events run. Cold work keeps its independent cost pacing and
/// captures writes the platform never reports; this does not cap a costly gap.
pub(super) const CAPTURE_BACKSTOP_INTERVAL: Duration = Duration::from_secs(60);
/// How often selected mode reads its job's state and membership, so a
/// member added or a job resumed is hydrated within about this long, and
/// stats at most 32 rotating file locators, including native-watched files.
/// Native callbacks still compare their named members immediately.
pub(super) const MEMBER_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// How often selected mode hydrates every member whatever its file shows:
/// a member with no local file to stat, or a change a stat cannot see.
pub(super) const MEMBER_BACKSTOP_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// Set to `0` to keep broad capture from attaching a filesystem watcher, so
/// capture uses recent-file polling plus fair cold reconciliation,
/// selected mode's inventory discovers every source at its spaced cadence,
/// and selected mode stats every member's transcript each
/// [`MEMBER_POLL_INTERVAL`].
pub(super) const FS_EVENTS_ENV: &str = "AGENT_RELAY_PROBE_FS_EVENTS";
/// Whether [`FS_EVENTS_ENV`] leaves filesystem events on.
pub(super) fn fs_events_enabled() -> bool {
    std::env::var(FS_EVENTS_ENV).map_or(true, |value| value != "0")
}
/// How often the capture thread rechecks the probe's stop request while it
/// waits for a tick.
const STOP_POLL: Duration = Duration::from_millis(100);
/// Most changed sessions of one tick whose files are stat'ed to measure
/// capture lag: a sweep after a long gap can change thousands.
const LAG_SAMPLE: usize = 64;

/// How the capture thread runs. [`LiveOptions::default`] is production; tests
/// shorten the intervals.
#[derive(Clone, Debug)]
pub(super) struct LiveOptions {
    pub debounce: Duration,
    pub duty_factor: u32,
    pub cold_duty_factor: u32,
    pub fallback_poll: Duration,
    pub min_gap: Duration,
    pub backstop: Duration,
    pub use_fs_events: bool,
    pub member_poll: Duration,
    pub member_backstop: Duration,
}
impl Default for LiveOptions {
    fn default() -> Self {
        Self {
            debounce: WATCH_DEBOUNCE,
            duty_factor: SWEEP_DUTY_FACTOR,
            cold_duty_factor: COLD_DUTY_FACTOR,
            fallback_poll: Duration::from_secs(5),
            min_gap: SWEEP_MIN_GAP,
            backstop: CAPTURE_BACKSTOP_INTERVAL,
            use_fs_events: fs_events_enabled(),
            member_poll: MEMBER_POLL_INTERVAL,
            member_backstop: MEMBER_BACKSTOP_INTERVAL,
        }
    }
}
/// What the capture thread and the delivery loop share: a wake for the
/// delivery loop, and the capture side of the pass report.
#[derive(Default)]
pub(super) struct Shared {
    wake: Mutex<bool>,
    woken: Condvar,
    state: Mutex<State>,
    /// Set by each inventory pass, taken by selected mode's next round.
    catalogued: AtomicBool,
    remote_catalogued: AtomicBool,
    /// Set by a pruning that freed enough to rewrite the store, taken by the
    /// delivery loop, which runs the rewrite between its passes.
    compact_due: AtomicBool,
}
#[derive(Default)]
struct State {
    /// The last capture verdict: `None` before the first capture finished,
    /// `Some(None)` when it succeeded, else the class of its failure.
    verdict: Option<Option<String>>,
    metrics: Metrics,
}
impl Shared {
    /// Wake the delivery loop: local history gained something to deliver,
    /// or the capture verdict changed.
    pub(super) fn signal(&self) {
        *self.wake.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.woken.notify_all();
    }
    /// Forget a wake that predates the pass about to run, which reads
    /// everything it was for. One that arrives during the pass is kept.
    pub(super) fn clear(&self) {
        *self.wake.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
    /// Wait until woken, `deadline` passes or `stopped` holds. Returns
    /// whether it was woken.
    pub(super) fn wait(&self, deadline: Instant, stopped: impl Fn() -> bool) -> bool {
        let mut woken = self.wake.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if std::mem::take(&mut *woken) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline || stopped() {
                return false;
            }
            woken = self
                .woken
                .wait_timeout(woken, (deadline - now).min(STOP_POLL))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
    /// The inventory finished a pass: the next round in selected mode
    /// compares each member in a shared database with its catalog row.
    pub(super) fn catalogued(&self) {
        self.catalogued.store(true, Ordering::Relaxed);
    }
    fn take_catalogued(&self) -> bool {
        self.catalogued.swap(false, Ordering::Relaxed)
    }
    /// Whether a pruning asked for the store to be rewritten since the last
    /// time this was asked.
    pub(super) fn take_compact_due(&self) -> bool {
        self.compact_due.swap(false, Ordering::Relaxed)
    }
    /// The capture verdict, once a capture has finished.
    pub(super) fn verdict(&self) -> Option<Option<String>> {
        self.state().verdict.clone()
    }
    /// The capture side of the pass report, once the thread has started.
    pub(super) fn report(&self) -> Option<serde_json::Value> {
        let state = self.state();
        state.metrics.mode.map(|_| state.metrics.report())
    }
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn update(&self, change: impl FnOnce(&mut State)) {
        change(&mut self.state());
    }
    /// Record a verdict; wake the delivery loop when it changed, so the
    /// report shows it without waiting for an idle pass.
    fn judge(&self, verdict: Option<String>) {
        let changed = {
            let mut state = self.state();
            let changed = state.verdict.as_ref() != Some(&verdict);
            state.verdict = Some(verdict);
            changed
        };
        if changed {
            self.signal();
        }
    }
}

pub(super) use selected_remote::Capture;

/// Start the capture thread for `config`'s sharing mode.
pub(super) fn start(
    directory: &Path,
    config: &super::Config,
    cancelled: Arc<AtomicBool>,
    shared: Arc<Shared>,
    options: LiveOptions,
) -> Capture {
    let directory = directory.to_path_buf();
    let selected = super::bridge::mode(config) == super::bridge::SharingMode::Selected;
    let history_url = config.history_url.clone();
    let job_id = config.job_id.clone();
    let stop = cancelled.clone();
    let thread = std::thread::Builder::new()
        .name("probe-capture".into())
        .spawn(move || {
            super::priority::capture();
            if selected {
                let _remote = selected_remote::start(&directory, &cancelled, &shared, &options);
                follow_members(&directory, &job_id, &cancelled, &shared, &options)
            } else {
                broad::capture(&directory, &history_url, &cancelled, &shared, &options)
            }
        })
        .expect("spawning the capture thread");
    Capture {
        thread: Some(thread),
        stop,
    }
}

/// All and new modes: one cancellable sweep, then the paced watch, or the
/// timer when the store cannot be followed.
/// When the last sweep ended and how long it took: what the next one is
/// paced by.
#[derive(Clone, Copy)]
struct Swept {
    ended: Instant,
    took: Duration,
}

/// Scoped events cannot postpone full reconciliation forever.
#[cfg(test)]
fn next_sweep(
    owed: Option<&Owed>,
    paced: Instant,
    backstop: Instant,
    debounce: Duration,
) -> (Instant, Trigger) {
    let full_due = backstop.max(paced);
    match owed {
        Some(pending) if (pending.first + debounce).max(paced) < full_due => {
            ((pending.first + debounce).max(paced), Trigger::FsEvent)
        }
        _ => (full_due, Trigger::Poll),
    }
}

/// What woke a sweep of the paced watch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trigger {
    /// A filesystem event, after the debounce and the pace.
    FsEvent,
    /// The backstop, or the independent recent-file safety polling cadence.
    Poll,
}
impl Trigger {
    fn as_str(self) -> &'static str {
        match self {
            Trigger::FsEvent => "fs-event",
            Trigger::Poll => "poll",
        }
    }
}

/// One sweep of the paced watch.
struct Tick {
    trigger: Trigger,
    /// A full walk ran.
    swept: bool,
    /// Another sweep held the store's sync lock; nothing was read.
    contended: bool,
    /// Sessions whose catalog row the sweep created or changed.
    changed: Vec<SessionRef>,
    took: Duration,
    /// For an event's sweep, how long past its debounce (or the sweep it
    /// retries) it waited for the pace.
    waited: Option<Duration>,
}

/// Fold one sweep's outcome, or its failure, into the report.
fn fold(
    directory: &Path,
    report: anyhow::Result<Tick>,
    store: &ai_hist::SessionStore,
    shared: &Shared,
) {
    match report {
        Ok(report) => tick(&report, store, shared),
        Err(error) => {
            let class = collector::capture_error_class(&error);
            shared.update(|state| {
                state.metrics.ticks += 1;
                state.metrics.ticks_failed += 1;
            });
            let _ = super::save_json(
                &directory.join("capture-diagnostic.json"),
                &json!({"operation":"capture","stage":"live_capture","error_class":class}),
            );
            shared.judge(Some(class.to_owned()));
        }
    }
}

/// Fold one sweep into the report and wake delivery when it wrote.
fn tick(report: &Tick, store: &ai_hist::SessionStore, shared: &Shared) {
    let wrote = report.swept || !report.changed.is_empty();
    let lag = (!report.changed.is_empty())
        .then(|| capture_lag(store, &report.changed))
        .flatten();
    let took = millis(report.took);
    shared.update(|state| {
        let metrics = &mut state.metrics;
        metrics.ticks += 1;
        *metrics
            .ticks_by_trigger
            .entry(report.trigger.as_str())
            .or_default() += 1;
        metrics.ticks_swept += u64::from(report.swept);
        metrics.ticks_unchanged += u64::from(!report.swept && !report.contended);
        metrics.ticks_contended += u64::from(report.contended);
        metrics.sessions_changed += report.changed.len() as u64;
        metrics.tick_ms_last = Some(took);
        metrics.tick_ms_max = metrics.tick_ms_max.max(took);
        if let Some(waited) = report.waited.filter(|waited| !waited.is_zero()) {
            metrics.ticks_paced += 1;
            metrics.duty_wait_ms_total = metrics.duty_wait_ms_total.saturating_add(millis(waited));
        }
        if wrote {
            metrics.ticks_waking_delivery += 1;
        }
        if !report.contended {
            metrics.last_capture_ms = Some(collector::now());
        }
        if let Some(lag) = lag {
            metrics.lag(lag);
        }
    });
    // A sweep that could not take the lock read nothing; an owed one is
    // retried, and its verdict is the one that retry reaches.
    if !report.contended {
        shared.judge(None);
    }
    if wrote {
        shared.signal();
    }
}

/// From the newest modification among `changed` sessions' files to now.
fn capture_lag(store: &ai_hist::SessionStore, changed: &[SessionRef]) -> Option<u64> {
    let sample = &changed[..changed.len().min(LAG_SAMPLE)];
    let newest = history::raw_paths(store, sample)
        .ok()?
        .into_iter()
        .flatten()
        .filter_map(|path| std::fs::metadata(path).and_then(|m| m.modified()).ok())
        .max()?;
    Some(millis(
        SystemTime::now()
            .duration_since(newest)
            .unwrap_or(Duration::ZERO),
    ))
}

/// Where selected mode looks for a member's change.
#[derive(Clone, Debug)]
enum Locator {
    /// The member's own transcript, whose modification time and length move
    /// only when this session is written. `None` when the catalog names no
    /// local file: such a member waits for the backstop.
    File(Option<PathBuf>),
    /// A source whose file holds many sessions (OpenCode's database): the
    /// file moves whenever any of them is written, so the member's own
    /// catalog row, which the inventory's pass after a write to that file
    /// refreshes and a hydration refreshes too, says when this one moved.
    Catalog(SessionRef),
}

/// A member as last seen.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Stamp {
    /// Its transcript's modification time and length.
    File(SystemTime, u64),
    /// Its catalog row's source stamp and last activity.
    Catalog(Option<String>, Option<i64>),
    /// Nothing to compare: no file, or no catalog row yet.
    Unknown,
}

/// What selected mode remembers between rounds.
#[derive(Default)]
struct Members {
    /// Each member as of its last hydration.
    seen: HashMap<delivery::SessionIdentity, Stamp>,
    /// Where each member's change shows, read from its catalog row once and
    /// again after every backstop.
    locators: HashMap<delivery::SessionIdentity, Locator>,
    /// When every member is next hydrated whatever its stamp shows.
    backstop: Option<Instant>,
    /// The class of the last hydration round's failure, until a round
    /// succeeds. A round that could not even read the members is reported on
    /// its own and forgotten by the next round that could.
    failure: Option<String>,
    /// The selection the delegated members were last brought in line with,
    /// and whether a hydration since may have found new delegated work.
    delegated_for: Option<HashSet<delivery::SessionIdentity>>,
    delegation_due: bool,
    /// When a delegation sync that failed may be tried again.
    delegation_retry: Option<Instant>,
    /// The member set whose evidence alone the store last kept, and when a
    /// pruning that failed may be tried again.
    pruned: Option<HashSet<delivery::SessionIdentity>>,
    prune_retry: Option<Instant>,
    /// The connections every round reads through, kept from one round to the
    /// next. A fresh connection parses the store's whole schema before its
    /// first statement, which once a second was most of what an idle round
    /// cost. A failed round drops them, so the next one opens its own.
    readers: Option<Readers>,
    /// Where the watch sends what it observes; `None` when filesystem
    /// events are off; rotating safety stats still check transcripts.
    events: Option<mpsc::Sender<Observed>>,
    /// The watch over the members' transcripts, registered afresh each
    /// backstop. `None` while no watcher can run.
    watch: Option<MemberWatch>,
    /// The members an event named since the last round.
    written: HashSet<delivery::SessionIdentity>,
    /// Whether the next round compares every member: the round before it
    /// failed after taking the events and the inventory pass it was owed, or
    /// the watcher lost events.
    recheck: bool,
    /// Members whose provider was not ready, to be tried again shortly.
    not_ready: not_ready::NotReady,
    safety: member_safety::Poll,
    roots: history::RootSettings,
    denied: HashSet<delivery::SessionIdentity>,
}
impl Members {
    /// Take in what the watch observed. Returns whether it asks for a round.
    fn observe(&mut self, observed: Observed) -> bool {
        match observed {
            Observed::Written(path) => {
                let Some(member) = self.watch.as_ref().and_then(|watch| watch.member(&path)) else {
                    return false;
                };
                self.written.insert(member.clone());
            }
            Observed::Lost => self.recheck = true,
        }
        true
    }
}

/// What a watcher callback reports: each written path of a write event,
/// and a loss for a rescan or a failure.
fn observed(event: notify::Result<notify::Event>) -> Vec<Observed> {
    match event {
        Ok(event) if !event.need_rescan() => {
            if !inventory::writes(&event.kind) {
                return Vec::new();
            }
            event.paths.into_iter().map(Observed::Written).collect()
        }
        _ => vec![Observed::Lost],
    }
}

/// What the member watch reports.
#[derive(Debug)]
enum Observed {
    /// A write at this path.
    Written(PathBuf),
    /// Events were dropped (a queue overflow, or a kernel-coalesced rescan
    /// naming only the watched directory), or the watcher failed: a write to
    /// any member's transcript may have gone unreported.
    Lost,
}

/// The filesystem watch over selected members' transcripts. Each
/// transcript's directory is registered without recursing: a watch on the
/// file itself ends with the next atomic rewrite, and a provider's whole
/// tree would report every other session's writes.
struct MemberWatch {
    watcher: notify::RecommendedWatcher,
    /// The directories registered.
    directories: HashSet<PathBuf>,
    /// Directories whose registration failed, retried each round: one that
    /// does not exist yet, or a watcher out of watches.
    unregistered: HashSet<PathBuf>,
    /// The transcripts followed, by member, as last asked.
    following: HashMap<delivery::SessionIdentity, PathBuf>,
    /// The members whose transcript's directory is registered.
    covered: HashSet<delivery::SessionIdentity>,
    /// Each covered transcript, in every spelling an event can name it by.
    files: HashMap<PathBuf, delivery::SessionIdentity>,
}
impl MemberWatch {
    fn start(events: mpsc::Sender<Observed>) -> notify::Result<Self> {
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            for observed in observed(event) {
                let _ = events.send(observed);
            }
        })?;
        Ok(Self {
            watcher,
            directories: HashSet::new(),
            unregistered: HashSet::new(),
            following: HashMap::new(),
            covered: HashSet::new(),
            files: HashMap::new(),
        })
    }

    /// Follow `files`, each member's transcript: register the directories
    /// not registered yet and give up those no member's transcript is in.
    /// Returns the members to compare now because the registrations moved:
    /// every covered member, since a registration made now reports no write
    /// from before it held, and some backends restart their stream for every
    /// path they add or remove.
    fn follow(
        &mut self,
        files: HashMap<delivery::SessionIdentity, PathBuf>,
    ) -> HashSet<delivery::SessionIdentity> {
        use notify::Watcher;
        if files == self.following && self.unregistered.is_empty() {
            return HashSet::new();
        }
        let mut by_directory: HashMap<PathBuf, Vec<delivery::SessionIdentity>> = HashMap::new();
        for (member, file) in &files {
            if let Some(directory) = file.parent() {
                by_directory
                    .entry(directory.to_path_buf())
                    .or_default()
                    .push(member.clone());
            }
        }
        let mut moved = false;
        let unused: Vec<PathBuf> = self
            .directories
            .iter()
            .filter(|directory| !by_directory.contains_key(*directory))
            .cloned()
            .collect();
        for directory in unused {
            let _ = self.watcher.unwatch(&directory);
            self.directories.remove(&directory);
            moved = true;
        }
        self.unregistered.clear();
        self.covered.clear();
        self.files.clear();
        for (directory, members) in by_directory {
            if !self.directories.contains(&directory) {
                if self
                    .watcher
                    .watch(&directory, notify::RecursiveMode::NonRecursive)
                    .is_err()
                {
                    self.unregistered.insert(directory);
                    continue;
                }
                self.directories.insert(directory);
                moved = true;
            }
            for member in members {
                for spelling in spellings(&files[&member]) {
                    self.files.insert(spelling, member.clone());
                }
                self.covered.insert(member);
            }
        }
        self.following = files;
        if moved {
            self.covered.clone()
        } else {
            HashSet::new()
        }
    }

    /// Whether an event will name a write to `member`'s transcript.
    #[cfg(test)]
    fn covers(&self, member: &delivery::SessionIdentity) -> bool {
        self.covered.contains(member)
    }

    /// The member whose transcript `path` is.
    fn member(&self, path: &Path) -> Option<&delivery::SessionIdentity> {
        self.files.get(path)
    }
}

/// A file's path as given and with its directory's symlinks resolved, which
/// is how some backends report it (FSEvents names `/var` as `/private/var`).
fn spellings(file: &Path) -> Vec<PathBuf> {
    let resolved = file
        .parent()
        .and_then(|parent| Some(parent.canonicalize().ok()?.join(file.file_name()?)));
    let mut spellings = vec![file.to_path_buf()];
    spellings.extend(resolved.filter(|resolved| resolved != file));
    spellings
}

/// The store as selected mode reads it: the delivery tables, and the
/// catalog through `ai-hist`, whose handle keeps its own read connections.
struct Readers {
    control: rusqlite::Connection,
    store: ai_hist::SessionStore,
    /// The database file the control connection opened. A store replaced
    /// under it (a reset, a restored backup) is a different file, which a
    /// kept connection would go on reading.
    file: Option<FileIdentity>,
    snapshot: bool,
}
impl Readers {
    fn open(db: &Path) -> anyhow::Result<Self> {
        let file = FileIdentity::of(db);
        Ok(Self {
            control: delivery::open_db_readonly(db)?,
            store: history::open_read(db)?,
            file,
            snapshot: false,
        })
    }
    /// Whether `db` is still the file these readers opened.
    fn current(&self, db: &Path) -> bool {
        self.file.is_some() && self.file == FileIdentity::of(db)
    }
}

/// A file's device and inode: what a path names, independent of its contents.
/// `None` where the platform gives no stable identity, so such readers are
/// never kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}
impl FileIdentity {
    #[cfg(unix)]
    fn of(path: &Path) -> Option<Self> {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(path).ok()?;
        Some(Self {
            device: meta.dev(),
            inode: meta.ino(),
        })
    }
    #[cfg(not(unix))]
    fn of(_path: &Path) -> Option<Self> {
        None
    }
}

/// Selected mode: hydrate a member when an event names its transcript and
/// the transcript moved, every member each backstop, and moved files through
/// bounded rotating safety stats regardless of watch coverage. A paused job
/// hydrates nothing.
fn follow_members(
    directory: &Path,
    job_id: &str,
    cancelled: &Arc<AtomicBool>,
    shared: &Shared,
    options: &LiveOptions,
) {
    shared.update(|state| {
        state.metrics.mode = Some("members");
        if !options.use_fs_events {
            state.metrics.driver = Some("member-poll");
            state.metrics.fallback_reason = Some("disabled");
        }
    });
    let db = directory.join("history.db");
    // The sender stays held here, so the receiver never reports the channel
    // closed while no watch is running.
    let (events, written) = mpsc::channel();
    let mut members = Members {
        events: options.use_fs_events.then(|| events.clone()),
        ..Members::default()
    };
    while !stopping(cancelled) {
        poll_and_judge(
            directory,
            &db,
            job_id,
            cancelled,
            shared,
            &mut members,
            options,
        );
        // Wait for the next membership read, or for the debounce an event
        // opens: a burst of writes to members' transcripts is one round,
        // and the window ends whether or not the writes do.
        let next = Instant::now() + options.member_poll;
        let mut settle: Option<Instant> = None;
        loop {
            let now = Instant::now();
            let until = settle.map_or(next, |settle| settle.min(next));
            if stopping(cancelled) || now >= until {
                break;
            }
            let Ok(observed) = written.recv_timeout((until - now).min(STOP_POLL)) else {
                continue;
            };
            if members.observe(observed) {
                settle.get_or_insert_with(|| Instant::now() + options.debounce);
            }
        }
    }
    drop(events);
}

/// One round and the verdict it reaches. A round that read the members
/// reports the standing verdict of the last hydration, so a transient
/// failure to read them is withdrawn by the next round that could, even when
/// nothing moved; a paused job observes nothing and leaves the verdict
/// standing.
fn poll_and_judge(
    directory: &Path,
    db: &Path,
    job_id: &str,
    cancelled: &Arc<AtomicBool>,
    shared: &Shared,
    members: &mut Members,
    options: &LiveOptions,
) {
    let readers = match members.readers.take() {
        Some(readers) if readers.current(db) => Ok(readers),
        _ => Readers::open(db),
    };
    let polled = readers.and_then(|mut readers| {
        member_safety::refresh(&mut readers, members)?;
        let polled = poll_members(
            directory, &readers, job_id, cancelled, shared, members, options,
        );
        if polled.is_ok() {
            members.readers = Some(readers);
        }
        polled
    });
    match polled {
        Ok(true) => {
            shared.judge(members.failure.clone());
            follow_delegation(
                directory,
                db,
                job_id,
                shared,
                members,
                options.member_backstop,
            );
            prune_unselected(directory, db, job_id, cancelled, shared, members, options);
        }
        Ok(false) => {}
        Err(error) => {
            members.recheck = true;
            shared.judge(Some(collector::capture_error_class(&error).to_owned()))
        }
    }
}

/// Bring the job's delegated members in line with the selection: each
/// selected session's subagents and child threads are members as part of it,
/// uploaded with it and dropped with it. Runs when the selection changed or a
/// hydration may have recorded new delegations.
fn follow_delegation(
    directory: &Path,
    db: &Path,
    job_id: &str,
    shared: &Shared,
    state: &mut Members,
    backstop: Duration,
) {
    let Some(readers) = state.readers.as_ref() else {
        return;
    };
    let Ok(selected) = delivery::job_selected_sessions(&readers.control, job_id) else {
        return;
    };
    let current: HashSet<_> = selected.into_iter().collect();
    if !state.delegation_due && state.delegated_for.as_ref() == Some(&current) {
        return;
    }
    if state.delegation_retry.is_some_and(|at| Instant::now() < at) {
        return;
    }
    let started = Instant::now();
    match delivery::open_db(db).and_then(|conn| delivery::sync_delegated_members(&conn, job_id)) {
        Ok(changed) => {
            state.delegated_for = Some(current);
            state.delegation_due = false;
            state.delegation_retry = None;
            if changed {
                shared.signal();
            }
        }
        // Still due: retried at the next backstop rather than every round.
        Err(error) => {
            state.delegation_retry = Some(Instant::now() + backstop);
            let _ = collector::capture_diagnostic(
                directory,
                "delegated_members",
                started,
                0,
                1,
                Some(&error),
            );
        }
    }
}

/// Keep only the members' evidence: on the first poll of a run, and whenever
/// the members change, every other session's evidence is dropped (see
/// [`prune_to_members`]). A failure is retried at the next backstop rather
/// than every poll.
fn prune_unselected(
    directory: &Path,
    db: &Path,
    job_id: &str,
    cancelled: &Arc<AtomicBool>,
    shared: &Shared,
    state: &mut Members,
    options: &LiveOptions,
) {
    if state.prune_retry.is_some_and(|at| Instant::now() < at) {
        return;
    }
    let Some(readers) = state.readers.as_ref() else {
        return;
    };
    let Ok(members) = delivery::job_selected_sessions(&readers.control, job_id) else {
        return;
    };
    let current: HashSet<_> = members.iter().cloned().collect();
    if state.pruned.as_ref() == Some(&current) {
        return;
    }
    let result = prune_to_members(directory, db, &members, cancelled);
    if stopping(cancelled) {
        return;
    }
    match result {
        Ok(compact) => {
            state.pruned = Some(current);
            state.prune_retry = None;
            if compact {
                shared.compact_due.store(true, Ordering::Relaxed);
                shared.signal();
            }
        }
        Err(_) => state.prune_retry = Some(Instant::now() + options.member_backstop),
    }
}

/// Sources a selection stored by an older build may name that the store has
/// since retired: trajectories, and Relaycast's message history.
const RETIRED_SOURCES: &[&str] = &["trajectory", "relay"];

/// Drop the evidence of every session but `members` and their delegated
/// children, and say whether the space that freed is worth a rewrite of the
/// store (see [`compact_store`], which the caller runs while nothing of its
/// own writes). Reports the pass in `pruning-diagnostic.json`, or its failure
/// in `capture-diagnostic.json` as stage `evidence_pruning`.
///
/// Nothing is dropped for an empty member list, or one naming a source this
/// build cannot name: an empty or unreadable selection must never read as
/// "keep nothing". A member of a [`RETIRED_SOURCES`] source this build's store
/// no longer names is passed over instead, as the store holds nothing of it to
/// keep, so long as another member remains.
pub(super) fn prune_to_members(
    directory: &Path,
    db: &Path,
    members: &[delivery::SessionIdentity],
    cancelled: &Arc<AtomicBool>,
) -> anyhow::Result<bool> {
    let Some(keep) = members
        .iter()
        .filter_map(|member| match Source::parse(&member.source) {
            Some(source) => Some(Some(SessionRef::id(source, member.session_id.clone()))),
            None if RETIRED_SOURCES.contains(&member.source.as_str()) => None,
            None => Some(None),
        })
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(false);
    };
    if keep.is_empty() {
        return Ok(false);
    }
    let started = Instant::now();
    let stop = cancelled.clone();
    match history::forget_unselected(db, &keep, move || stopping(&stop)) {
        Ok(forgotten) => {
            let _ = super::save_status_json(
                &directory.join("pruning-diagnostic.json"),
                &json!({
                    "operation": "evidence_pruning",
                    "elapsed_ms": millis(started.elapsed()),
                    "kept_sessions": keep.len(),
                    "forgotten_sessions": forgotten.sessions,
                    "skipped_unrecoverable": forgotten.skipped_unrecoverable,
                    "events_removed": forgotten.events,
                    "reclaimable_bytes": forgotten.reclaimable_bytes,
                    "db_bytes": forgotten.db_bytes,
                }),
            );
            Ok(history::worth_compacting(&forgotten))
        }
        Err(error) => {
            if !stopping(cancelled) {
                let _ = collector::capture_diagnostic(
                    directory,
                    "evidence_pruning",
                    started,
                    0,
                    1,
                    Some(&error),
                );
            }
            Err(error)
        }
    }
}

/// Rewrite the store in place to give back the space a pruning freed, and
/// report it in `compaction-diagnostic.json`, or its failure in
/// `capture-diagnostic.json` as stage `compaction`. The rewrite holds the
/// store's write lock for its whole length (tens of seconds on a large
/// store), so it runs between delivery passes, never beside one. A volume too
/// full for the rewrite is left for the next run's pruning to ask again.
pub(super) fn compact_store(directory: &Path, db: &Path) {
    let started = Instant::now();
    match history::compact(db) {
        Ok(compacted) => {
            let _ = super::save_status_json(
                &directory.join("compaction-diagnostic.json"),
                &json!({
                    "operation": "compaction",
                    "elapsed_ms": millis(started.elapsed()),
                    "compacted": compacted.is_some(),
                    "db_bytes_before": compacted.as_ref().map(|report| report.db_bytes_before),
                    "db_bytes_after": compacted.as_ref().map(|report| report.db_bytes_after),
                }),
            );
        }
        Err(error) => {
            let _ =
                collector::capture_diagnostic(directory, "compaction", started, 0, 1, Some(&error));
        }
    }
}

/// One round. `Ok(false)` when the job is paused, so nothing was observed.
fn poll_members(
    directory: &Path,
    readers: &Readers,
    job_id: &str,
    cancelled: &Arc<AtomicBool>,
    shared: &Shared,
    state: &mut Members,
    options: &LiveOptions,
) -> anyhow::Result<bool> {
    if delivery::job_state(&readers.control, job_id)? == "paused" {
        return Ok(false);
    }
    let members = delivery::job_selected_sessions(&readers.control, job_id)?;
    // A member removed is forgotten, so one included again is hydrated at
    // once like any new member: no event named its transcript while it was
    // out.
    let current: HashSet<&delivery::SessionIdentity> = members.iter().collect();
    not_ready::release(state, &current, Instant::now());
    state.locators.retain(|member, _| current.contains(member));
    state.denied.retain(|member| current.contains(member));
    let everyone = state.backstop.is_none_or(|at| Instant::now() >= at);
    if everyone {
        state.locators.clear();
        state.backstop = Some(Instant::now() + options.member_backstop);
        if let Some(events) = &state.events {
            // A fresh registration picks up directories created since the
            // last one, and replaces a watch the platform dropped.
            state.watch = None;
            state.watch = MemberWatch::start(events.clone()).ok();
        }
    }
    let mut remote = selected_remote::prepare(&readers.store, state, &members, shared)?;
    let registered = match &mut state.watch {
        Some(watch) => watch.follow(
            members
                .iter()
                .filter_map(|member| match state.locators.get(member) {
                    Some(Locator::File(Some(path))) => Some((member.clone(), path.clone())),
                    _ => None,
                })
                .collect(),
        ),
        None => HashSet::new(),
    };
    if state.events.is_some() {
        // Events drive the round only while a registration covers a
        // transcript: a watcher whose every registration failed (out of
        // watches, too many open files) leaves each transcript to the stat.
        let files = members
            .iter()
            .filter(|member| matches!(state.locators.get(*member), Some(Locator::File(Some(_)))))
            .count();
        let covered = state.watch.as_ref().map_or(0, |watch| watch.covered.len());
        let watching = state.watch.is_some() && (files == 0 || covered > 0);
        shared.update(|shared| {
            shared.metrics.driver = Some(if watching {
                "member-events"
            } else {
                "member-poll"
            });
            shared.metrics.fallback_reason = (!watching).then_some("fs_events_unavailable");
        });
    }
    let safety = state.safety.pick(
        &members,
        &state.locators,
        options.member_poll,
        Instant::now(),
    );
    let catalogued = shared.take_catalogued();
    let recheck = std::mem::take(&mut state.recheck);
    let written = std::mem::take(&mut state.written);
    // The members whose stamp this round reads: a member never seen, every
    // member at the backstop or after a failed round, a transcript an event
    // named or a registration just started covering, a shared database's
    // member after an inventory pass, and at most 32 rotating file locators.
    let members: Vec<_> = members
        .into_iter()
        .filter(|member| {
            !state.denied.contains(member)
                && remote.eligible(
                    member,
                    everyone
                        || recheck
                        || !state.seen.contains_key(member)
                        || written.contains(member)
                        || registered.contains(member)
                        || match state.locators.get(member) {
                            Some(Locator::Catalog(_)) => catalogued,
                            Some(Locator::File(Some(_))) => safety.contains(member),
                            // Nothing to compare: the backstop hydrates it.
                            _ => false,
                        },
                )
        })
        .collect();
    if members.is_empty() {
        remote.prepared();
        return Ok(true);
    }
    let now = stamps(&readers.store, &members, &state.locators)?;
    remote.prepared();
    let mut changed = Vec::new();
    let mut before = Vec::new();
    for (member, stamp) in members.into_iter().zip(now) {
        // A member never seen is hydrated at once; one with nothing to
        // compare waits for the backstop.
        let moved = match state.seen.get(&member) {
            None => true,
            Some(last) => stamp != Stamp::Unknown && *last != stamp,
        };
        if remote.eligible(&member, everyone || moved) {
            changed.push(member);
            before.push(stamp);
        }
    }
    if changed.is_empty() {
        return Ok(true);
    }
    let tally = not_ready::Tally::default();
    let extra = state.roots.extra_claude_roots(&readers.store)?;
    let result = collector::capture_members(
        directory,
        changed.clone(),
        || stopping(cancelled),
        |member| {
            let stop = cancelled.clone();
            let result = history::hydrate_snapshot(
                &readers.store,
                extra.clone(),
                &member.source,
                &member.session_id,
                move || stopping(&stop),
            );
            tally.note(&member, &result);
            result
        },
    );
    if stopping(cancelled) {
        return Ok(true);
    }
    // A file is stamped as it was before the hydration read it, so a write
    // during the hydration, whose event the next round takes, is seen as a
    // move. A catalog row is stamped after, because the hydration refreshes
    // the row itself and that is not a change. A member that failed is not
    // retried each round either: the next change, or the backstop, tries it
    // again.
    let after = stamps(&readers.store, &changed, &state.locators)?;
    for ((member, before), after) in changed.iter().zip(before).zip(after) {
        let stamp = match after {
            Stamp::Catalog(..) => after,
            _ => before,
        };
        state.seen.insert(member.clone(), stamp);
    }
    state.not_ready.settle(&changed, &tally, Instant::now());
    let (done, not_ready) = tally.counts();
    shared.update(|shared| {
        let metrics = &mut shared.metrics;
        metrics.hydrations += done;
        metrics.member_polls_changed += 1;
        metrics.ticks += 1;
        if done > 0 {
            metrics.last_capture_ms = Some(collector::now());
        }
        if done + not_ready < changed.len() as u64 {
            metrics.ticks_failed += 1;
        }
    });
    state.failure = result
        .as_ref()
        .err()
        .map(|error| collector::capture_error_class(error).to_owned());
    if done > 0 {
        state.delegation_due = true;
        shared.signal();
    }
    Ok(true)
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::{fs, sync::atomic::Ordering};

    /// Provider roots come from the environment, so a test that watches or
    /// hydrates runs alone in a child process whose home is a fresh
    /// directory. Returns that home in the child; in the parent, `None` once
    /// the child passed. The child inherits no `RELAYHISTORY_*` setting:
    /// another test may hold a remote connector sign-in in the environment
    /// (pointed at its stub server) while this child spawns, and the child's
    /// capture would otherwise list that stub's sessions. The connector keys
    /// are removed by name too, since such a test may set them after the
    /// environment snapshot below and before the spawn.
    pub(crate) fn isolated_home(name: &str) -> Option<PathBuf> {
        const CHILD: &str = "AGENT_RELAY_PROBE_TEST_HOME";
        if let Some(home) = std::env::var_os(CHILD) {
            return Some(home.into());
        }
        let home = tempfile::tempdir().unwrap();
        let path = home.path();
        const CONNECTOR_KEYS: [&str; 8] = [
            "RELAYHISTORY_DEVIN_API_KEY",
            "RELAYHISTORY_DEVIN_ORG_ID",
            "RELAYHISTORY_DEVIN_CREDENTIALS",
            "RELAYHISTORY_DEVIN_CONFIG",
            "RELAYHISTORY_DEVIN_API_BASE_URL",
            "RELAYHISTORY_CLAUDE_CREDENTIALS",
            "RELAYHISTORY_CLAUDE_API_BASE_URL",
            "RELAYHISTORY_HOME",
        ];
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        for key in CONNECTOR_KEYS {
            command.env_remove(key);
        }
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("RELAYHISTORY_") {
                command.env_remove(key);
            }
        }
        let output = command
            .args(["--exact", name, "--nocapture"])
            .env(CHILD, path)
            .env("HOME", path)
            .env("USERPROFILE", path)
            .env("CLAUDE_CONFIG_DIR", path.join(".claude"))
            .env("CODEX_HOME", path.join(".codex"))
            .env("GROK_HOME", path.join(".grok"))
            .env("OPENCODE_DB", path.join("opencode.db"))
            .env("XDG_CONFIG_HOME", path.join(".config"))
            .env("APPDATA", path.join("AppData/Roaming"))
            .env_remove("GROK_BOT_USER_DATA")
            .env_remove("XDG_DATA_HOME")
            .env_remove("AGENT_RELAY_HOME")
            .env_remove(agent_relay_probe::relay::claude_dirs::DIRS_ENV)
            .env_remove(FS_EVENTS_ENV)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        None
    }

    pub(crate) fn transcript_line(session: &str, marker: &str) -> String {
        format!(
            "{}\n",
            json!({"sessionId":session,"uuid":marker,"type":"user","cwd":"/tmp/project",
                "message":{"role":"user","content":format!("synthetic {marker}")},
                "timestamp":"2026-09-01T01:00:00Z"})
        )
    }

    pub(crate) fn append(path: &Path, line: &str) {
        use std::io::Write;
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap()
            .write_all(line.as_bytes())
            .unwrap();
    }

    pub(crate) fn config(job: &delivery::DeliveryStatus, selected: bool) -> super::super::Config {
        super::super::Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: job.config.account_id.clone(),
            job_id: job.job_id.clone(),
            include_existing: true,
            sharing_mode: Some(if selected {
                super::super::bridge::SharingMode::Selected
            } else {
                super::super::bridge::SharingMode::All
            }),
            acknowledge_uninspected_schedules: false,
        }
    }

    pub(crate) fn job_config() -> delivery::DeliveryJobConfig {
        delivery::DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "teams-probe".into(),
            account_id: agent_relay_probe::destination::account_id("org", Some("workspace")),
            mapping_version: agent_relay_probe::destination::MAPPING_VERSION.into(),
            selection: collector::selection(true),
            limits: Default::default(),
        }
    }

    pub(crate) fn options() -> LiveOptions {
        LiveOptions {
            debounce: Duration::from_millis(50),
            duty_factor: SWEEP_DUTY_FACTOR,
            cold_duty_factor: SWEEP_DUTY_FACTOR,
            fallback_poll: Duration::from_millis(100),
            min_gap: Duration::from_millis(200),
            backstop: Duration::from_secs(60),
            use_fs_events: true,
            member_poll: Duration::from_millis(100),
            member_backstop: Duration::from_secs(60 * 60),
        }
    }

    pub(crate) fn eventually(what: &str, timeout: Duration, condition: impl Fn() -> bool) {
        let start = Instant::now();
        while !condition() {
            assert!(start.elapsed() < timeout, "{what} within {timeout:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn metric(shared: &Shared, name: &str) -> serde_json::Value {
        shared.report().unwrap_or_default()[name].clone()
    }

    pub(super) fn events(db: &Path, session: &str) -> usize {
        delivery::open_db_readonly(db)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id=?",
                [session],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// Drain wakes until none arrives for `quiet`: a watcher started just
    /// after a write may still report it.
    fn settle(shared: &Shared, quiet: Duration) {
        loop {
            shared.clear();
            if !shared.wait(Instant::now() + quiet, || false) {
                return;
            }
        }
    }

    #[test]
    fn a_wake_during_a_pass_is_kept_and_one_before_it_is_not() {
        let shared = Shared::default();
        shared.signal();
        // The pass about to run reads what the earlier wake was for.
        shared.clear();
        let start = Instant::now();
        assert!(!shared.wait(start + Duration::from_millis(150), || false));
        assert!(start.elapsed() >= Duration::from_millis(150));
        // A wake that lands during the pass ends the wait after it at once.
        shared.signal();
        let start = Instant::now();
        assert!(shared.wait(start + Duration::from_secs(10), || false));
        assert!(start.elapsed() < Duration::from_secs(1));
        // A stop ends the wait too.
        let start = Instant::now();
        assert!(!shared.wait(start + Duration::from_secs(10), || true));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    /// A write to a transcript is captured by a filesystem-event tick that
    /// wakes delivery well within a second, and the probe's stop request
    /// ends the watch thread promptly.
    #[test]
    fn a_tick_that_writes_wakes_delivery_and_a_stop_ends_the_watch() {
        let Some(home) = isolated_home(
            "live::tests::a_tick_that_writes_wakes_delivery_and_a_stop_ends_the_watch",
        ) else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let project = home.join(".claude/projects/live");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join("watched.jsonl");
        append(&transcript, &transcript_line("watched", "first"));

        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, false),
            cancelled.clone(),
            shared.clone(),
            LiveOptions {
                duty_factor: 0,
                cold_duty_factor: 0,
                ..options()
            },
        );
        eventually("the first sweep", Duration::from_secs(30), || {
            shared.verdict() == Some(None) && metric(&shared, "sweeps").as_u64() >= Some(1)
        });
        assert_eq!(events(&db, "watched"), 1);
        eventually("the watcher", Duration::from_secs(10), || {
            metric(&shared, "driver") == "fs-events"
                && metric(&shared, "sweeps").as_u64().unwrap_or(0) >= 1
        });
        assert!(metric(&shared, "fallback_reason").is_null());
        settle(&shared, Duration::from_millis(500));

        let written = Instant::now();
        append(&transcript, &transcript_line("watched", "second"));
        assert!(
            shared.wait(written + Duration::from_secs(10), || false),
            "no tick woke delivery: {:?}",
            shared.report()
        );
        let woke = written.elapsed();
        assert!(
            woke < Duration::from_secs(3),
            "woke after {woke:?}; capture metrics={:?}",
            shared.report()
        );
        assert_eq!(
            events(&db, "watched"),
            2,
            "the tick that woke delivery wrote"
        );
        let reported = Instant::now();
        loop {
            let report = shared.report().unwrap_or_default();
            if report["sessions_changed"].as_u64() >= Some(1) && report["capture_lag_ms"].is_u64() {
                break;
            }
            assert!(
                reported.elapsed() < Duration::from_secs(5),
                "the tick's report: {report}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(metric(&shared, "ticks_by_trigger")["fs-event"].as_u64() >= Some(1));
        assert_eq!(metric(&shared, "ticks_failed"), 0);

        let stopping = Instant::now();
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
        assert!(
            stopping.elapsed() < Duration::from_secs(3),
            "the watch took {:?} to stop",
            stopping.elapsed()
        );
    }

    /// The store's sync lock, as a sweep holds it.
    fn sync_lock(db: &Path) -> fs::File {
        let canonical = fs::canonicalize(db).unwrap();
        let mut name = canonical.file_name().unwrap().to_os_string();
        name.push(".sync.lock");
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(canonical.with_file_name(name))
            .unwrap()
    }

    /// Another sweep holds the store's sync lock as capture starts. The
    /// startup sweep waits for it rather than failing the first capture, and
    /// walks local history once the lock is free.
    #[test]
    fn the_startup_sweep_waits_for_a_sweep_that_holds_the_lock() {
        let Some(home) =
            isolated_home("live::tests::the_startup_sweep_waits_for_a_sweep_that_holds_the_lock")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let project = home.join(".claude/projects/locked");
        fs::create_dir_all(&project).unwrap();
        append(
            &project.join("locked.jsonl"),
            &transcript_line("locked", "first"),
        );
        // A sweep that holds the lock, as far as the startup sweep can tell.
        let lock = sync_lock(&db);
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let _capture = start(
            &directory,
            &config(&job, false),
            cancelled,
            shared.clone(),
            options(),
        );
        std::thread::sleep(Duration::from_millis(700));
        // Another provider can finish an empty slice while Claude waits for
        // the sync lock. Its successful verdict proves no protected work;
        // check the locked transcript and completed round directly.
        assert!(
            !matches!(shared.verdict(), Some(Some(_))),
            "waiting for the sync lock must not report a capture failure"
        );
        assert_eq!(metric(&shared, "sweeps"), 0);
        assert_eq!(events(&db, "locked"), 0, "capture must wait for the lock");
        fs2::FileExt::unlock(&lock).unwrap();
        eventually("the first capture", Duration::from_secs(30), || {
            shared.verdict() == Some(None) && metric(&shared, "sweeps").as_u64() >= Some(1)
        });
        assert_eq!(metric(&shared, "sweeps"), 1);
        assert_eq!(events(&db, "locked"), 1);
    }

    /// Writes that land while another sweep holds the store's sync lock are
    /// still events the watch owes a tick. A tick that finds the lock held
    /// reads nothing and the watch retries the owed sweep, at most a second
    /// apart however many events found the lock held, so the writes are read
    /// as soon as the lock is free rather than at the backstop.
    #[test]
    fn writes_while_the_lock_is_held_are_read_once_it_is_released() {
        let Some(home) = isolated_home(
            "live::tests::writes_while_the_lock_is_held_are_read_once_it_is_released",
        ) else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let project = home.join(".claude/projects/held");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join("held.jsonl");
        append(&transcript, &transcript_line("held", "line-0"));
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let _capture = start(
            &directory,
            &config(&job, false),
            cancelled,
            shared.clone(),
            options(),
        );
        eventually("the catch-up sweep", Duration::from_secs(30), || {
            metric(&shared, "driver") == "fs-events" && metric(&shared, "sweeps") == 1
        });
        assert_eq!(events(&db, "held"), 1);

        // A sweep that holds the lock, as far as the watch can tell, through
        // a burst of separate writes: each is its own event and its own tick.
        const LINES: usize = 10;
        let lock = sync_lock(&db);
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        for line in 1..=LINES {
            append(
                &transcript,
                &transcript_line("held", &format!("line-{line}")),
            );
            std::thread::sleep(Duration::from_millis(150));
        }
        eventually(
            "ticks that found the lock held",
            Duration::from_secs(10),
            || metric(&shared, "ticks_contended").as_u64() >= Some(1),
        );
        assert_eq!(events(&db, "held"), 1, "nothing is read under the lock");

        let released = Instant::now();
        fs2::FileExt::unlock(&lock).unwrap();
        eventually(
            "the writes made under the lock",
            Duration::from_secs(10),
            || events(&db, "held") == LINES + 1,
        );
        eprintln!(
            "read {:?} after the lock was released: {:?}",
            released.elapsed(),
            shared.report()
        );
    }

    /// A local history large enough that the startup sweep takes seconds.
    fn large_history(home: &Path) {
        use std::io::Write;
        fs::create_dir_all(home.join(".claude/projects")).unwrap();
        let mut prompts =
            std::io::BufWriter::new(fs::File::create(home.join(".claude/history.jsonl")).unwrap());
        for n in 0..200_000 {
            writeln!(prompts, "{}", json!({"display":format!("prompt {n}"),"timestamp":1_700_000_000_000_i64 + n,"project":"/tmp/project","sessionId":"long"})).unwrap();
        }
    }

    /// A stop during the startup sweep ends the capture thread at once: the
    /// sweep stops at its next boundary, and no uncancellable watch tick has
    /// been started to walk the rest of the history.
    #[test]
    fn a_stop_during_the_startup_sweep_ends_capture_promptly() {
        let Some(home) =
            isolated_home("live::tests::a_stop_during_the_startup_sweep_ends_capture_promptly")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        large_history(&home);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, false),
            cancelled.clone(),
            shared.clone(),
            options(),
        );
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            metric(&shared, "sweeps"),
            0,
            "the startup sweep is still running"
        );
        let stopping = Instant::now();
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
        assert!(
            stopping.elapsed() < Duration::from_secs(3),
            "stopped after {:?}",
            stopping.elapsed()
        );
        assert!(
            metric(&shared, "watching_since_ms").is_i64(),
            "watching begins before backfill"
        );
        // Nothing holds the store's sync lock afterwards.
        fs2::FileExt::try_lock_exclusive(&sync_lock(&db)).unwrap();
    }

    /// The watcher attaches before cold backlog enumeration. Exact active
    /// writes are captured while hundreds of unrelated archived files remain.
    ///
    /// The archive's startup round needs at least 125 cold slices (eight
    /// paths each), and this test paces cold work so that after its first
    /// slice the next is not due for seconds: the round cannot finish within
    /// the test however fast or loaded the machine is, so the active writes
    /// can only be captured if capture does not wait for it. (Hot work
    /// interleaving with cold slices that keep coming due is covered step by
    /// step by the scheduler tests in `live::broad`.)
    #[test]
    fn a_write_during_the_startup_sweep_is_caught_up_at_once() {
        let Some(home) =
            isolated_home("live::tests::a_write_during_the_startup_sweep_is_caught_up_at_once")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let archive = home.join(".claude/projects/archive");
        fs::create_dir_all(&archive).unwrap();
        for n in 0..1000 {
            append(
                &archive.join(format!("old-{n}.jsonl")),
                &transcript_line(&format!("old-{n}"), "old"),
            );
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, false),
            cancelled.clone(),
            shared.clone(),
            LiveOptions {
                // Every microsecond a cold slice works buys a second before
                // the next; a slice that acquires eight files takes far more.
                cold_duty_factor: 1_000_000,
                ..options()
            },
        );
        eventually("watch before backfill", Duration::from_secs(5), || {
            metric(&shared, "driver") == "fs-events"
        });
        // The write lands during the startup round: it has begun, not ended.
        eventually("the backfill begins", Duration::from_secs(10), || {
            metric(&shared, "cold_slices").as_u64() >= Some(1)
        });
        assert_eq!(metric(&shared, "sweeps"), 0, "the backfill is unfinished");
        let transcript = archive.join("active.jsonl");
        let started = Instant::now();
        append(&transcript, &transcript_line("active", "first"));
        // The backfill cannot finish meanwhile, so these waits only bound a
        // hang: a capture that waited for the backfill would never get here.
        // They are generous because a starved capture thread keeps its pace,
        // ten times as long as its last sweep took.
        eventually(
            "active creation during backfill",
            Duration::from_secs(60),
            || events(&db, "active") == 1,
        );
        append(&transcript, &transcript_line("active", "second"));
        eventually(
            "active append during backfill",
            Duration::from_secs(60),
            || events(&db, "active") == 2,
        );
        assert!(metric(&shared, "ticks_by_trigger")["fs-event"].as_u64() >= Some(1));
        assert_eq!(
            metric(&shared, "sweeps"),
            0,
            "active capture did not wait for archive completion"
        );
        eprintln!(
            "active updates during 1000-file backfill: {:?}",
            started.elapsed()
        );
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
    }

    /// Without filesystem events the watch polls at the backstop cadence, as
    /// the capture timer did, and the report says why.
    #[test]
    fn without_filesystem_events_capture_polls_and_says_why() {
        let Some(home) =
            isolated_home("live::tests::without_filesystem_events_capture_polls_and_says_why")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let project = home.join(".claude/projects/live");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join("polled.jsonl");
        append(&transcript, &transcript_line("polled", "first"));
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let options = LiveOptions {
            use_fs_events: false,
            cold_duty_factor: 0,
            backstop: Duration::from_millis(300),
            ..options()
        };
        let capture = start(
            &directory,
            &config(&job, false),
            cancelled.clone(),
            shared.clone(),
            options,
        );
        eventually("the polling driver", Duration::from_secs(30), || {
            metric(&shared, "driver") == "polling"
                && metric(&shared, "sweeps").as_u64().unwrap_or(0) >= 1
        });
        assert_eq!(metric(&shared, "fallback_reason"), "disabled");
        eventually("the initial polling round", Duration::from_secs(30), || {
            events(&db, "polled") == 1 && metric(&shared, "sweeps").as_u64() >= Some(1)
        });
        settle(&shared, Duration::from_millis(800));
        append(&transcript, &transcript_line("polled", "second"));
        assert!(shared.wait(Instant::now() + Duration::from_secs(10), || false));
        eventually("the polled write", Duration::from_secs(10), || {
            events(&db, "polled") == 2
                && metric(&shared, "ticks_by_trigger")["poll"]
                    .as_u64()
                    .is_some_and(|n| n >= 1)
        });
        assert!(metric(&shared, "ticks_by_trigger")["poll"].as_u64() >= Some(1));
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
    }

    #[test]
    fn fallback_recent_append_does_not_wait_for_an_unfinished_archive_round() {
        let Some(home) = isolated_home(
            "live::tests::fallback_recent_append_does_not_wait_for_an_unfinished_archive_round",
        ) else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let project = home.join(".claude/projects/fallback");
        fs::create_dir_all(&project).unwrap();
        let active = project.join("active.jsonl");
        append(&active, &transcript_line("active", "first"));
        let store = history::open(&db).unwrap();
        history::sweep_paths_once(
            &store,
            false,
            Some(vec![Source::Claude]),
            Some(vec![active.clone()]),
            || false,
        )
        .unwrap();
        for n in 0..1000 {
            append(
                &project.join(format!("archive-{n}.jsonl")),
                &transcript_line(&format!("archive-{n}"), "old"),
            );
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, false),
            cancelled.clone(),
            shared.clone(),
            LiveOptions {
                use_fs_events: false,
                cold_duty_factor: 1000,
                min_gap: Duration::from_millis(10),
                duty_factor: 0,
                fallback_poll: Duration::from_millis(100),
                ..options()
            },
        );
        eventually("polling driver", Duration::from_secs(5), || {
            metric(&shared, "driver") == "polling"
        });
        append(&active, &transcript_line("active", "second"));
        eventually(
            "known active append during cold fallback",
            Duration::from_secs(15),
            || events(&db, "active") == 2,
        );
        assert_eq!(
            metric(&shared, "sweeps"),
            0,
            "the unfinished archive must not be the capture mechanism"
        );
        assert!(metric(&shared, "cold_paths").as_u64().unwrap_or(0) < 1000);
        let stopping = Instant::now();
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
        assert!(stopping.elapsed() < Duration::from_secs(3));
    }

    /// The pace: ten times the last sweep, at least the least gap, at most
    /// the backstop.
    #[test]
    fn a_sweep_is_followed_by_a_gap_ten_times_as_long() {
        let options = LiveOptions::default();
        assert_eq!(gap(Duration::ZERO, &options), SWEEP_MIN_GAP);
        assert_eq!(gap(Duration::from_millis(30), &options), SWEEP_MIN_GAP);
        assert_eq!(
            gap(Duration::from_millis(2_400), &options),
            Duration::from_secs(24)
        );
        assert_eq!(
            gap(Duration::from_secs(30), &options),
            Duration::from_secs(300)
        );
        assert_eq!(
            gap(Duration::MAX, &options),
            Duration::MAX,
            "never overflows"
        );
    }

    /// A transcript written several times a second, as a live session's is,
    /// is swept about once per least gap rather than once per write, and its
    /// last line is still captured within about that gap.
    #[test]
    fn sustained_writes_are_swept_at_the_pace() {
        let Some(home) = isolated_home("live::tests::sustained_writes_are_swept_at_the_pace")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let project = home.join(".claude/projects/busy");
        fs::create_dir_all(&project).unwrap();
        let transcript = project.join("busy.jsonl");
        append(&transcript, &transcript_line("busy", "line-0"));
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let options = LiveOptions {
            // This fixture measures the fixed minimum gap. Adaptive duty cost
            // is separately asserted by a_sweep_is_followed_by_a_gap_ten_times_as_long.
            duty_factor: 0,
            min_gap: Duration::from_secs(1),
            ..options()
        };
        let _capture = start(
            &directory,
            &config(&job, false),
            cancelled,
            shared.clone(),
            options,
        );
        eventually("the catch-up sweep", Duration::from_secs(30), || {
            metric(&shared, "driver") == "fs-events" && metric(&shared, "sweeps") == 1
        });
        settle(&shared, Duration::from_millis(1_500));
        let before = metric(&shared, "ticks_by_trigger")["fs-event"]
            .as_u64()
            .unwrap_or(0);

        const LINES: usize = 30;
        let writing = Instant::now();
        let mut last_write_ms = 0;
        for line in 1..=LINES {
            if line == LINES {
                last_write_ms = collector::now();
            }
            append(
                &transcript,
                &transcript_line("busy", &format!("line-{line}")),
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        let wrote = writing.elapsed();
        let last = Instant::now();
        eventually("the last line", Duration::from_secs(10), || {
            // Catalog commit precedes publication of tick metrics. Wait for
            // the same completed capture before asserting its pacing report.
            events(&db, "busy") == LINES + 1
                && metric(&shared, "last_capture_ms")
                    .as_i64()
                    .is_some_and(|ms| ms >= last_write_ms)
                && metric(&shared, "ticks_by_trigger")["fs-event"]
                    .as_u64()
                    .unwrap_or(0)
                    > before
        });
        let caught = last.elapsed();
        let ticks = metric(&shared, "ticks_by_trigger")["fs-event"]
            .as_u64()
            .unwrap_or(0)
            - before;
        eprintln!(
            "{LINES} writes over {wrote:?}: {ticks} sweeps, last line after {caught:?}: {:?}",
            shared.report()
        );
        // One sweep per second of writing, give or take the ones at either
        // end, rather than one per write.
        assert!(
            ticks <= wrote.as_secs() + 3,
            "{ticks} sweeps for {LINES} writes over {wrote:?}"
        );
        assert!(caught < Duration::from_secs(3), "caught after {caught:?}");
        assert!(metric(&shared, "ticks_paced").as_u64() >= Some(1));
        assert!(metric(&shared, "duty_wait_ms_total").as_u64() >= Some(1));
        assert!(metric(&shared, "tick_ms_last").is_u64());
    }

    /// What is queued when a sweep becomes due is not dropped: a write some
    /// source reads makes that sweep an event's, forced, and a loss also has
    /// the watcher registered again. Writes no source reads, and a watcher
    /// that is not running, owe nothing.
    #[test]
    fn a_sweep_reads_what_was_queued_as_an_event() {
        let Some(home) = isolated_home("live::tests::a_sweep_reads_what_was_queued_as_an_event")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        history::open(&db).unwrap();
        let project = home.join(".claude/projects/queued");
        fs::create_dir_all(&project).unwrap();
        let (events, received) = mpsc::channel();
        let watch = Watching::start(&db, events.clone(), true);
        assert!(watch.watch.is_ok(), "the watcher runs");
        let queued = |noticed: Option<PathBuf>| {
            events.send((Instant::now(), noticed)).unwrap();
        };

        let (mut owed, mut lost) = (None, false);
        queued(Some(home.join("notes.txt")));
        assert_eq!(
            watch.drain(&received, &mut owed, &mut lost, Trigger::Poll),
            Trigger::Poll,
            "a write no source reads"
        );
        assert_eq!((&owed, lost), (&None, false));

        queued(Some(project.join("s.jsonl")));
        assert_eq!(
            watch.drain(&received, &mut owed, &mut lost, Trigger::Poll),
            Trigger::FsEvent
        );
        assert!(owed.is_some() && !lost);

        let (mut owed, mut lost) = (None, false);
        queued(None);
        assert_eq!(
            watch.drain(&received, &mut owed, &mut lost, Trigger::Poll),
            Trigger::FsEvent
        );
        assert!(owed.is_some() && lost);

        let polling = Watching::start(&db, events.clone(), false);
        let (mut owed, mut lost) = (None, false);
        queued(None);
        assert_eq!(
            polling.drain(&received, &mut owed, &mut lost, Trigger::Poll),
            Trigger::Poll
        );
        assert_eq!((&owed, lost), (&None, false));
    }

    #[test]
    fn fallback_full_pass_refreshes_provider_roots() {
        let Some(home) = isolated_home("live::tests::fallback_full_pass_refreshes_provider_roots")
        else {
            return;
        };
        let db = home.join("probe/history.db");
        history::open(&db).unwrap();
        fs::create_dir_all(home.join(".claude/projects/existing")).unwrap();
        let (sent, _) = mpsc::channel();
        let mut watch = Watching::start(&db, sent, true);
        assert!(watch.watch.is_ok());
        fs::create_dir_all(home.join(".codex/sessions/new")).unwrap();
        assert!(watch.watch.as_ref().unwrap().outdated(&db));
        let pending = Owed {
            paths: HashSet::new(),
            first: Instant::now(),
            sources: HashSet::from([Source::Claude]),
            full: true,
            fs_event: true,
        };
        assert_eq!(watch.prepare_sources(&db, Some(&pending), false), None);
        assert!(
            !watch.watch.as_ref().unwrap().outdated(&db),
            "directory/deletion fallback must refresh roots before sweeping"
        );
    }

    #[test]
    fn full_reconciliation_deadline_wins_during_a_sustained_event_burst() {
        let now = Instant::now();
        let pending = Owed {
            paths: HashSet::new(),
            first: now,
            sources: HashSet::from([Source::Claude]),
            full: false,
            fs_event: true,
        };
        let deadline = now + Duration::from_secs(1);
        assert_eq!(
            next_sweep(Some(&pending), now, deadline, Duration::from_millis(50)),
            (now + Duration::from_millis(50), Trigger::FsEvent)
        );
        let late = Owed {
            paths: HashSet::new(),
            first: deadline,
            ..pending
        };
        assert_eq!(
            next_sweep(Some(&late), now, deadline, Duration::from_millis(50)),
            (deadline, Trigger::Poll)
        );
    }

    #[test]
    fn a_burst_retains_provider_scope_and_loss_requests_full_reconciliation() {
        let Some(home) = isolated_home(
            "live::tests::a_burst_retains_provider_scope_and_loss_requests_full_reconciliation",
        ) else {
            return;
        };
        let db = home.join("probe/history.db");
        history::open(&db).unwrap();
        let claude = home.join(".claude/projects/scoped/c.jsonl");
        let codex = home.join(".codex/sessions/scoped/d.jsonl");
        for path in [&claude, &codex] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "").unwrap();
        }
        let (sent, received) = mpsc::channel();
        let watch = Watching::start(&db, sent.clone(), true);
        assert!(watch.watch.is_ok());
        let (mut owed, mut lost) = (None, false);
        watch.fold((Instant::now(), Some(claude)), &mut owed, &mut lost);
        assert_eq!(owed.as_ref().unwrap().sources(), Some(vec![Source::Claude]));
        sent.send((Instant::now(), Some(codex))).unwrap();
        assert_eq!(
            watch.drain(&received, &mut owed, &mut lost, Trigger::Poll),
            Trigger::FsEvent
        );
        let sources = owed.as_ref().unwrap().sources().unwrap();
        assert!(sources.contains(&Source::Claude) && sources.contains(&Source::Codex));
        assert_eq!(sources.len(), 2);
        watch.fold(
            (
                Instant::now(),
                Some(home.join(".codex/sessions/scoped/missing.jsonl")),
            ),
            &mut owed,
            &mut lost,
        );
        assert_eq!(owed.as_ref().unwrap().sources(), None);
        assert!(!lost);
        watch.fold((Instant::now(), None), &mut owed, &mut lost);
        assert!(lost);
        assert_eq!(owed.as_ref().unwrap().sources(), None);
    }

    #[test]
    fn sustained_scoped_events_do_not_starve_the_full_backstop() {
        let Some(home) =
            isolated_home("live::tests::sustained_scoped_events_do_not_starve_the_full_backstop")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let claude = home.join(".claude/projects/busy/busy.jsonl");
        fs::create_dir_all(claude.parent().unwrap()).unwrap();
        append(&claude, &transcript_line("busy", "first"));
        let store = history::open(&db).unwrap();
        history::sweep_once(&store, true, || false).unwrap();
        let (sent, received) = mpsc::channel();
        let watch = Watching::start(&db, sent.clone(), true);
        assert!(watch.watch.is_ok());
        let codex = home.join(".codex/sessions/2026/10/15/rollout-late.jsonl");
        fs::create_dir_all(codex.parent().unwrap()).unwrap();
        assert!(
            watch.watch.as_ref().unwrap().outdated(&db),
            "new provider needs registration"
        );
        let timestamp = "2026-10-15T01:00:00Z";
        append(
            &codex,
            &format!(
                "{}\n{}\n",
                json!({"timestamp":timestamp,"type":"session_meta","payload":{"id":"late-codex","cwd":"/tmp/project"}}),
                json!({"timestamp":timestamp,"type":"event_msg","payload":{"type":"user_message","message":"synthetic"}})
            ),
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let shared = Arc::new(Shared::default());
        let options = LiveOptions {
            debounce: Duration::from_millis(5),
            duty_factor: 0,
            min_gap: Duration::from_millis(10),
            backstop: Duration::from_millis(300),
            ..options()
        };
        let thread = std::thread::spawn(move || {
            broad::follow(
                broad::Context {
                    directory: &directory,
                    store,
                    watch,
                    received: &received,
                    last: Swept {
                        ended: Instant::now(),
                        took: Duration::ZERO,
                    },
                    cancelled: &stop,
                    shared: &shared,
                    options: &options,
                    progress: None,
                },
                Default::default(),
            )
        });
        let started = Instant::now();
        let mut found = false;
        while started.elapsed() < Duration::from_secs(5) {
            sent.send((Instant::now(), Some(claude.clone()))).unwrap();
            if events(&db, "late-codex") > 0 {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        cancelled.store(true, Ordering::Relaxed);
        thread.join().unwrap();
        assert!(found, "full backstop starved by scoped event passes");
    }

    /// With nothing written, the watch runs no sweep between backstops.
    #[test]
    fn an_idle_history_is_not_swept() {
        let Some(home) = isolated_home("live::tests::an_idle_history_is_not_swept") else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let project = home.join(".claude/projects/idle");
        fs::create_dir_all(&project).unwrap();
        append(
            &project.join("idle.jsonl"),
            &transcript_line("idle", "first"),
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let _capture = start(
            &directory,
            &config(&job, false),
            cancelled,
            shared.clone(),
            options(),
        );
        eventually("the catch-up sweep", Duration::from_secs(30), || {
            metric(&shared, "driver") == "fs-events" && metric(&shared, "sweeps") == 1
        });
        // A backend may still report the writes made before it attached.
        let mut seen = metric(&shared, "ticks");
        loop {
            std::thread::sleep(Duration::from_millis(1_000));
            let now = metric(&shared, "ticks");
            if now == seen {
                break;
            }
            seen = now;
        }
        std::thread::sleep(Duration::from_millis(2_000));
        assert_eq!(metric(&shared, "ticks"), seen, "{:?}", shared.report());
    }

    /// Readers kept from one member poll to the next are given up once the
    /// store is replaced under them, so a poll never reads a removed file.
    #[cfg(unix)]
    #[test]
    fn kept_readers_follow_a_replaced_store() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        history::open(&db).unwrap();
        let readers = Readers::open(&db).unwrap();
        assert!(readers.current(&db));
        let replacement = dir.path().join("replacement.db");
        history::open(&replacement).unwrap();
        fs::rename(&replacement, &db).unwrap();
        assert!(!readers.current(&db));
    }

    /// A provider that appears after the probe started is watched once the
    /// backstop finds it, and its sessions are captured: the loop is never
    /// left without coverage until a restart.
    #[test]
    fn a_provider_that_appears_after_start_is_captured() {
        let Some(home) =
            isolated_home("live::tests::a_provider_that_appears_after_start_is_captured")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let job = delivery::create_job(&delivery::open_db(&db).unwrap(), &job_config(), 0).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let options = LiveOptions {
            backstop: Duration::from_millis(300),
            ..options()
        };
        let _capture = start(
            &directory,
            &config(&job, false),
            cancelled,
            shared.clone(),
            options,
        );
        eventually("the first sweep", Duration::from_secs(30), || {
            shared.verdict() == Some(None)
        });
        let project = home.join(".claude/projects/late");
        fs::create_dir_all(&project).unwrap();
        append(
            &project.join("late.jsonl"),
            &transcript_line("late", "first"),
        );
        eventually(
            "the late provider's session",
            Duration::from_secs(15),
            || events(&db, "late") == 1,
        );
        append(
            &project.join("late.jsonl"),
            &transcript_line("late", "second"),
        );
        eventually("its next write", Duration::from_secs(15), || {
            events(&db, "late") == 2
        });
    }

    /// A poll that could not read the members reports a failure, and the
    /// next poll that could withdraws it, even when no member moved.
    #[test]
    fn a_failed_member_poll_is_withdrawn_by_the_next_idle_poll() {
        let directory = tempfile::tempdir().unwrap();
        let db = directory.path().join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        let job = delivery::create_session_job(&conn, &job_config(), 0).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Shared::default();
        let mut members = Members::default();
        let poll = |job: &str, members: &mut Members| {
            poll_and_judge(
                directory.path(),
                &db,
                job,
                &cancelled,
                &shared,
                members,
                &options(),
            )
        };
        // The job cannot be read: a transient failure of the poll itself.
        poll("missing-job", &mut members);
        assert!(matches!(shared.verdict(), Some(Some(_))));
        // The next poll reads it, nothing moved, and the failure is withdrawn.
        poll(&job.job_id, &mut members);
        assert_eq!(shared.verdict(), Some(None));
        // A paused job observes nothing and leaves the verdict where it was.
        poll("missing-job", &mut members);
        delivery::pause_job(&conn, &job.job_id).unwrap();
        poll(&job.job_id, &mut members);
        assert!(matches!(shared.verdict(), Some(Some(_))));
    }

    /// A member of a source whose file holds many sessions (OpenCode's
    /// database) moves with its own catalog row, not with the shared file,
    /// which another session's write touches.
    #[test]
    fn a_member_in_a_shared_database_moves_with_its_catalog_row() {
        assert!(!Source::OpenCode.capabilities().hydrates_by_path);
        assert!(Source::Claude.capabilities().hydrates_by_path);
        let directory = tempfile::tempdir().unwrap();
        let db = directory.path().join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        let shared_file = directory.path().join("opencode.db");
        fs::write(&shared_file, "one").unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,raw_path,source_stamp,last_activity_ms,discovery_state) VALUES ('opencode','member',?1,'v1',1,'shallow')",
            [shared_file.to_string_lossy()],
        )
        .unwrap();
        let member = delivery::SessionIdentity {
            source: "opencode".into(),
            session_id: "member".into(),
        };
        let locators = HashMap::from([(
            member.clone(),
            Locator::Catalog(SessionRef::id(Source::OpenCode, "member")),
        )]);
        let store = history::open_read(&db).unwrap();
        let stamp = || stamps(&store, std::slice::from_ref(&member), &locators).unwrap()[0].clone();
        let first = stamp();
        assert_eq!(first, Stamp::Catalog(Some("v1".into()), Some(1)));
        // Another session writes the shared database: this member did not move.
        fs::write(&shared_file, "one and another session").unwrap();
        assert_eq!(stamp(), first);
        // Its own row moved.
        conn.execute(
            "UPDATE sessions SET source_stamp='v2', last_activity_ms=2 WHERE session_id='member'",
            [],
        )
        .unwrap();
        assert_ne!(stamp(), first);
    }

    /// Selected mode reads no provider: it hydrates every member once, then
    /// only the member whose transcript moved, never a session it does not
    /// share, and nothing while the job is paused.
    #[test]
    fn selected_mode_hydrates_only_the_members_whose_transcript_moved() {
        let Some(home) = isolated_home(
            "live::tests::selected_mode_hydrates_only_the_members_whose_transcript_moved",
        ) else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        let project = home.join(".claude/projects/selected");
        fs::create_dir_all(&project).unwrap();
        for session in ["moving", "still", "private"] {
            append(
                &project.join(format!("{session}.jsonl")),
                &transcript_line(session, &format!("{session}-1")),
            );
        }
        history::discover(&db, None, || false).unwrap();
        let job = delivery::create_session_job(&conn, &job_config(), 0).unwrap();
        for session in ["moving", "still"] {
            delivery::set_job_session(
                &conn,
                &job.job_id,
                &delivery::SessionIdentity {
                    source: "claude".into(),
                    session_id: session.into(),
                },
                true,
            )
            .unwrap();
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, true),
            cancelled.clone(),
            shared.clone(),
            options(),
        );
        let hydrations = || metric(&shared, "hydrations").as_u64().unwrap_or(0);
        eventually(
            "every member hydrated once",
            Duration::from_secs(30),
            || hydrations() == 2,
        );
        assert_eq!(metric(&shared, "mode"), "members");
        assert_eq!(events(&db, "moving"), 1);
        assert_eq!(events(&db, "still"), 1);
        assert_eq!(events(&db, "private"), 0);
        shared.clear();

        append(
            &project.join("moving.jsonl"),
            &transcript_line("moving", "moving-2"),
        );
        assert!(shared.wait(Instant::now() + Duration::from_secs(10), || false));
        eventually("the moved member hydrated", Duration::from_secs(10), || {
            events(&db, "moving") == 2
        });
        // Several polls later, still only the one member was hydrated again.
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(hydrations(), 3);
        assert_eq!(events(&db, "private"), 0);

        delivery::pause_job(&conn, &job.job_id).unwrap();
        append(
            &project.join("still.jsonl"),
            &transcript_line("still", "still-2"),
        );
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(hydrations(), 3, "a paused job hydrates nothing");
        delivery::resume_job(&conn, &job.job_id).unwrap();
        eventually(
            "the member written while paused",
            Duration::from_secs(10),
            || events(&db, "still") == 2,
        );
        eventually("its hydration counted", Duration::from_secs(5), || {
            hydrations() == 4
        });
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
    }

    /// A selected job over Claude transcripts under `home`: `members` are
    /// its members, `others` are only catalogued. Returns the probe
    /// directory, its store, the transcripts' directory and the job.
    fn selected_job(
        home: &Path,
        members: &[&str],
        others: &[&str],
    ) -> (PathBuf, PathBuf, PathBuf, delivery::DeliveryStatus) {
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        let project = home.join(".claude/projects/selected");
        fs::create_dir_all(&project).unwrap();
        for session in members.iter().chain(others) {
            append(
                &project.join(format!("{session}.jsonl")),
                &transcript_line(session, &format!("{session}-1")),
            );
        }
        history::discover(&db, None, || false).unwrap();
        let job = delivery::create_session_job(&conn, &job_config(), 0).unwrap();
        for session in members {
            delivery::set_job_session(
                &conn,
                &job.job_id,
                &delivery::SessionIdentity {
                    source: "claude".into(),
                    session_id: (*session).into(),
                },
                true,
            )
            .unwrap();
        }
        (directory, db, project, job)
    }

    /// Options whose membership read never comes round during a test, so
    /// only an event or the backstop can start a round after the first.
    fn event_options() -> LiveOptions {
        LiveOptions {
            member_poll: Duration::from_secs(10 * 60),
            ..options()
        }
    }

    /// A write to a member's transcript is hydrated through its event, long
    /// before the next membership read would have stat'ed it.
    #[test]
    fn an_event_hydrates_a_member_without_waiting_for_a_poll() {
        let Some(home) =
            isolated_home("live::tests::an_event_hydrates_a_member_without_waiting_for_a_poll")
        else {
            return;
        };
        let (directory, db, project, job) = selected_job(&home, &["moving"], &["private"]);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, true),
            cancelled.clone(),
            shared.clone(),
            event_options(),
        );
        let hydrations = || metric(&shared, "hydrations").as_u64().unwrap_or(0);
        eventually("the member hydrated once", Duration::from_secs(30), || {
            hydrations() == 1
        });
        assert_eq!(metric(&shared, "driver"), "member-events");
        assert_eq!(metric(&shared, "fallback_reason"), serde_json::Value::Null);

        let written = Instant::now();
        append(
            &project.join("moving.jsonl"),
            &transcript_line("moving", "moving-2"),
        );
        // The hydration's records land before the round reports it.
        eventually(
            "the written member hydrated",
            Duration::from_secs(15),
            || events(&db, "moving") == 2 && hydrations() == 2,
        );
        assert!(written.elapsed() < Duration::from_secs(15));
        // A write to a transcript in the same directory that is not a
        // member's is never hydrated.
        append(
            &project.join("private.jsonl"),
            &transcript_line("private", "private-2"),
        );
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(events(&db, "private"), 0);
        assert_eq!(hydrations(), 2);
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
    }

    /// A burst of appends to one transcript inside the debounce window is
    /// one round and one hydration.
    #[test]
    fn a_burst_of_writes_is_one_hydration() {
        let Some(home) = isolated_home("live::tests::a_burst_of_writes_is_one_hydration") else {
            return;
        };
        let (directory, db, project, job) = selected_job(&home, &["busy"], &[]);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, true),
            cancelled.clone(),
            shared.clone(),
            LiveOptions {
                debounce: Duration::from_secs(2),
                ..event_options()
            },
        );
        let hydrations = || metric(&shared, "hydrations").as_u64().unwrap_or(0);
        let rounds = || {
            metric(&shared, "member_polls_changed")
                .as_u64()
                .unwrap_or(0)
        };
        eventually("the member hydrated once", Duration::from_secs(30), || {
            hydrations() == 1
        });
        // A backend may still report the writes made before it attached;
        // their round finds the transcript unchanged.
        std::thread::sleep(Duration::from_millis(1_500));
        assert_eq!((hydrations(), rounds()), (1, 1));

        // One write per line through one handle, as an agent appends: each
        // is its own event, all well inside the window.
        const LINES: usize = 100;
        let burst = Instant::now();
        {
            use std::io::Write;
            let mut transcript = fs::OpenOptions::new()
                .append(true)
                .open(project.join("busy.jsonl"))
                .unwrap();
            for line in 0..LINES {
                transcript
                    .write_all(transcript_line("busy", &format!("busy-burst-{line}")).as_bytes())
                    .unwrap();
            }
        }
        let burst = burst.elapsed();
        // The hydration's records land before the round reports it.
        eventually("the burst hydrated", Duration::from_secs(15), || {
            events(&db, "busy") == LINES + 1 && hydrations() == 2
        });
        // Past another debounce window: events that straggled in after the
        // round find the transcript unchanged.
        std::thread::sleep(Duration::from_millis(3_000));
        assert_eq!(
            (hydrations(), rounds()),
            (2, 2),
            "a burst of {LINES} writes over {burst:?}"
        );
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
    }

    /// With no write at all, the backstop still hydrates every member.
    #[test]
    fn the_backstop_hydrates_every_member_without_events() {
        let Some(home) =
            isolated_home("live::tests::the_backstop_hydrates_every_member_without_events")
        else {
            return;
        };
        let (directory, _db, _project, job) = selected_job(&home, &["one", "two"], &[]);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, true),
            cancelled.clone(),
            shared.clone(),
            LiveOptions {
                member_poll: Duration::from_millis(100),
                member_backstop: Duration::from_secs(1),
                ..options()
            },
        );
        eventually("two backstops", Duration::from_secs(30), || {
            metric(&shared, "hydrations").as_u64().unwrap_or(0) >= 4
        });
        assert_eq!(metric(&shared, "driver"), "member-events");
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
    }

    /// Without filesystem events every member's transcript is stat'ed each
    /// round, and the report says why.
    #[test]
    fn without_filesystem_events_members_are_polled_and_say_why() {
        let Some(home) =
            isolated_home("live::tests::without_filesystem_events_members_are_polled_and_say_why")
        else {
            return;
        };
        let (directory, db, project, job) = selected_job(&home, &["polled"], &[]);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, true),
            cancelled.clone(),
            shared.clone(),
            LiveOptions {
                use_fs_events: false,
                ..options()
            },
        );
        eventually("the member hydrated once", Duration::from_secs(30), || {
            events(&db, "polled") == 1
        });
        assert_eq!(metric(&shared, "driver"), "member-poll");
        assert_eq!(metric(&shared, "fallback_reason"), "disabled");
        append(
            &project.join("polled.jsonl"),
            &transcript_line("polled", "polled-2"),
        );
        eventually("the polled write hydrated", Duration::from_secs(15), || {
            events(&db, "polled") == 2
        });
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
    }

    /// Named events remain immediate before the safety deadline; a due
    /// bounded safety poll also captures a held-open write without an event.
    #[test]
    fn native_events_work_before_due_safety_poll_and_due_poll_needs_no_event() {
        let Some(home) = isolated_home(
            "live::tests::native_events_work_before_due_safety_poll_and_due_poll_needs_no_event",
        ) else {
            return;
        };
        let (directory, db, project, job) = selected_job(&home, &["watched"], &[]);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Shared::default();
        let (sender, written) = mpsc::channel();
        let mut members = Members {
            events: Some(sender),
            ..Members::default()
        };
        let round = |members: &mut Members| {
            poll_and_judge(
                &directory,
                &db,
                &job.job_id,
                &cancelled,
                &shared,
                members,
                &event_options(),
            )
        };
        let member = delivery::SessionIdentity {
            source: "claude".into(),
            session_id: "watched".into(),
        };
        round(&mut members);
        assert_eq!(events(&db, "watched"), 1);
        assert!(members.watch.as_ref().unwrap().covers(&member));
        // Whatever the attach reported is behind us.
        while written.recv_timeout(Duration::from_millis(500)).is_ok() {}

        append(
            &project.join("watched.jsonl"),
            &transcript_line("watched", "watched-2"),
        );
        round(&mut members);
        assert_eq!(events(&db, "watched"), 1, "a round without an event");

        let deadline = Instant::now() + Duration::from_secs(15);
        let named = loop {
            let observed = written
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("an event for the write");
            let Observed::Written(path) = observed else {
                continue;
            };
            if let Some(named) = members.watch.as_ref().unwrap().member(&path) {
                break named.clone();
            }
        };
        assert_eq!(named, member);
        assert!(members.observe(Observed::Written(project.join("watched.jsonl"))));
        round(&mut members);
        assert_eq!(events(&db, "watched"), 2);
        let mut writer = fs::OpenOptions::new()
            .append(true)
            .open(project.join("watched.jsonl"))
            .unwrap();
        use std::io::Write;
        writer
            .write_all(transcript_line("watched", "watched-3").as_bytes())
            .unwrap();
        writer.flush().unwrap();
        // Inject a due safety turn, deliberately consuming no native notice.
        members.safety = member_safety::Poll::default();
        round(&mut members);
        assert_eq!(
            events(&db, "watched"),
            3,
            "a watched file does not depend on its close event"
        );
        drop(writer);
    }

    /// A member in a shared database is compared with its catalog row after
    /// an inventory pass, and not before.
    #[test]
    fn an_inventory_pass_compares_members_in_a_shared_database() {
        let Some(home) =
            isolated_home("live::tests::an_inventory_pass_compares_members_in_a_shared_database")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        let job = delivery::create_session_job(&conn, &job_config(), 0).unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,raw_path,source_stamp,last_activity_ms,discovery_state) VALUES ('opencode','member',?1,'v1',1,'shallow')",
            [home.join("opencode.db").to_string_lossy()],
        )
        .unwrap();
        let member = delivery::SessionIdentity {
            source: "opencode".into(),
            session_id: "member".into(),
        };
        delivery::set_job_session(&conn, &job.job_id, &member, true).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Shared::default();
        let mut members = Members::default();
        let round = |members: &mut Members| {
            poll_and_judge(
                &directory,
                &db,
                &job.job_id,
                &cancelled,
                &shared,
                members,
                &options(),
            )
        };
        let rounds = || shared.state().metrics.member_polls_changed;
        round(&mut members);
        assert_eq!(rounds(), 1, "a member never seen is hydrated at once");
        let moved = conn
            .execute(
                "UPDATE sessions SET source_stamp='v2', last_activity_ms=2 WHERE session_id='member'",
                [],
            )
            .unwrap();
        assert_eq!(moved, 1);
        round(&mut members);
        assert_eq!(rounds(), 1, "no pass, no comparison");
        shared.catalogued();
        round(&mut members);
        assert_eq!(rounds(), 2, "the pass's row moved");
    }

    /// A member removed and included again is hydrated at once: no event
    /// named its transcript while it was out of the job.
    #[test]
    fn a_member_included_again_is_hydrated_at_once() {
        let Some(home) = isolated_home("live::tests::a_member_included_again_is_hydrated_at_once")
        else {
            return;
        };
        let (directory, db, project, job) = selected_job(&home, &["returning", "staying"], &[]);
        let conn = delivery::open_db(&db).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Shared::default();
        let (sender, _written) = mpsc::channel();
        let mut members = Members {
            events: Some(sender),
            ..Members::default()
        };
        let round = |members: &mut Members| {
            poll_and_judge(
                &directory,
                &db,
                &job.job_id,
                &cancelled,
                &shared,
                members,
                &options(),
            )
        };
        let returning = delivery::SessionIdentity {
            source: "claude".into(),
            session_id: "returning".into(),
        };
        round(&mut members);
        assert_eq!(events(&db, "returning"), 1);

        delivery::set_job_session(&conn, &job.job_id, &returning, false).unwrap();
        round(&mut members);
        append(
            &project.join("returning.jsonl"),
            &transcript_line("returning", "returning-2"),
        );
        round(&mut members);
        // Out of the job, its evidence is dropped and its writes are not read.
        assert_eq!(events(&db, "returning"), 0, "not a member");

        delivery::set_job_session(&conn, &job.job_id, &returning, true).unwrap();
        round(&mut members);
        assert_eq!(events(&db, "returning"), 2);
    }

    /// A rescan (events the kernel or the backend dropped) and a watcher
    /// failure are losses; a write is its paths; a read is nothing.
    #[test]
    fn a_rescan_or_a_watcher_failure_is_a_loss() {
        use notify::event::{AccessKind, DataChange, Flag, ModifyKind};
        use notify::EventKind;
        let rescan = notify::Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert!(matches!(observed(Ok(rescan))[..], [Observed::Lost]));
        let failed = Err(notify::Error::generic("queue overflow"));
        assert!(matches!(observed(failed)[..], [Observed::Lost]));
        let write = notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
            .add_path(PathBuf::from("/p/a.jsonl"));
        assert!(
            matches!(&observed(Ok(write))[..], [Observed::Written(path)] if path == Path::new("/p/a.jsonl"))
        );
        let read = notify::Event::new(EventKind::Access(AccessKind::Any))
            .add_path(PathBuf::from("/p/a.jsonl"));
        assert!(observed(Ok(read)).is_empty());
    }

    /// After a loss the next round compares every member, so a write whose
    /// event was dropped is hydrated then rather than at the backstop.
    #[test]
    fn a_lost_event_has_the_next_round_compare_every_member() {
        let Some(home) =
            isolated_home("live::tests::a_lost_event_has_the_next_round_compare_every_member")
        else {
            return;
        };
        let (directory, db, project, job) = selected_job(&home, &["one", "two"], &[]);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Shared::default();
        let (sender, written) = mpsc::channel();
        let mut members = Members {
            events: Some(sender),
            ..Members::default()
        };
        let round = |members: &mut Members| {
            poll_and_judge(
                &directory,
                &db,
                &job.job_id,
                &cancelled,
                &shared,
                members,
                &event_options(),
            )
        };
        round(&mut members);
        assert_eq!((events(&db, "one"), events(&db, "two")), (1, 1));
        for session in ["one", "two"] {
            append(
                &project.join(format!("{session}.jsonl")),
                &transcript_line(session, &format!("{session}-2")),
            );
        }
        // The writes' events are dropped, as a queue overflow drops them.
        while written.recv_timeout(Duration::from_millis(500)).is_ok() {}
        round(&mut members);
        assert_eq!(
            (events(&db, "one"), events(&db, "two")),
            (1, 1),
            "before the safety deadline, a loss notification still bypasses the wait"
        );
        assert!(members.observe(Observed::Lost));
        round(&mut members);
        assert_eq!((events(&db, "one"), events(&db, "two")), (2, 2));
    }

    /// A watcher with no registration covering a transcript is not driving
    /// anything: the report says the members are polled, and why, until a
    /// registration holds.
    #[test]
    fn a_watch_that_covers_no_transcript_reports_polling() {
        let Some(home) =
            isolated_home("live::tests::a_watch_that_covers_no_transcript_reports_polling")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        let job = delivery::create_session_job(&conn, &job_config(), 0).unwrap();
        let folder = home.join(".claude/projects/later");
        conn.execute(
            "INSERT INTO sessions(source,session_id,raw_path,source_stamp,last_activity_ms,discovery_state) VALUES ('claude','later',?1,'v1',1,'shallow')",
            [folder.join("later.jsonl").to_string_lossy()],
        )
        .unwrap();
        let member = delivery::SessionIdentity {
            source: "claude".into(),
            session_id: "later".into(),
        };
        delivery::set_job_session(&conn, &job.job_id, &member, true).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Shared::default();
        let (sender, _written) = mpsc::channel();
        let mut members = Members {
            events: Some(sender),
            ..Members::default()
        };
        let round = |members: &mut Members| {
            poll_and_judge(
                &directory,
                &db,
                &job.job_id,
                &cancelled,
                &shared,
                members,
                &options(),
            )
        };
        let driver = || {
            let state = shared.state();
            (state.metrics.driver, state.metrics.fallback_reason)
        };
        round(&mut members);
        assert!(members.watch.is_some(), "the watcher itself started");
        assert_eq!(
            driver(),
            (Some("member-poll"), Some("fs_events_unavailable"))
        );
        fs::create_dir_all(&folder).unwrap();
        round(&mut members);
        assert!(members.watch.as_ref().unwrap().covers(&member));
        assert_eq!(driver(), (Some("member-events"), None));
    }

    /// A member of a retired source does not hold back the pruning of the
    /// rest, whether or not this build's store still names that source; one
    /// naming a source no build knows still leaves everything in place.
    #[test]
    fn pruning_passes_over_members_of_retired_sources() {
        let Some(home) =
            isolated_home("live::tests::pruning_passes_over_members_of_retired_sources")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        delivery::open_db(&db).unwrap();
        let project = home.join(".claude/projects/retired");
        fs::create_dir_all(&project).unwrap();
        for session in ["kept", "dropped"] {
            append(
                &project.join(format!("{session}.jsonl")),
                &transcript_line(session, &format!("{session}-1")),
            );
        }
        history::discover(&db, None, || false).unwrap();
        for session in ["kept", "dropped"] {
            history::hydrate(&db, "claude", session, || false).unwrap();
            assert_eq!(events(&db, session), 1);
        }
        let member = |source: &str, session: &str| delivery::SessionIdentity {
            source: source.into(),
            session_id: session.into(),
        };
        let cancelled = Arc::new(AtomicBool::new(false));

        let unknown = [member("claude", "kept"), member("not-a-source", "x")];
        assert!(!prune_to_members(&directory, &db, &unknown, &cancelled).unwrap());
        assert_eq!(
            events(&db, "dropped"),
            1,
            "an unknown source dropped evidence"
        );

        let members = [
            member("claude", "kept"),
            member("trajectory", "t"),
            member("relay", "r"),
        ];
        prune_to_members(&directory, &db, &members, &cancelled).unwrap();
        assert_eq!(events(&db, "kept"), 1);
        assert_eq!(events(&db, "dropped"), 0);
    }

    /// Selected mode keeps only its members' evidence: everything else
    /// captured before the selection is dropped on the first round and stays
    /// catalogued, a member deselected later loses its evidence too, a job
    /// with no members drops nothing, and a member selected again is captured
    /// in full again at once.
    #[test]
    fn selected_mode_keeps_only_its_members_evidence() {
        let Some(home) =
            isolated_home("live::tests::selected_mode_keeps_only_its_members_evidence")
        else {
            return;
        };
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        let project = home.join(".claude/projects/selected");
        fs::create_dir_all(&project).unwrap();
        for session in ["kept", "dropped", "earlier"] {
            append(
                &project.join(format!("{session}.jsonl")),
                &transcript_line(session, &format!("{session}-1")),
            );
        }
        history::discover(&db, None, || false).unwrap();
        for session in ["kept", "dropped", "earlier"] {
            history::hydrate(&db, "claude", session, || false).unwrap();
            assert_eq!(events(&db, session), 1);
        }
        let member = |session: &str| delivery::SessionIdentity {
            source: "claude".into(),
            session_id: session.into(),
        };

        // No members yet: nothing is dropped.
        let job = delivery::create_session_job(&conn, &job_config(), 0).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared::default());
        let capture = start(
            &directory,
            &config(&job, true),
            cancelled.clone(),
            shared.clone(),
            options(),
        );
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(
            events(&db, "earlier"),
            1,
            "an empty selection dropped evidence"
        );

        for session in ["kept", "dropped"] {
            delivery::set_job_session(&conn, &job.job_id, &member(session), true).unwrap();
        }
        eventually(
            "evidence outside the selection dropped",
            Duration::from_secs(30),
            || events(&db, "earlier") == 0,
        );
        assert_eq!(events(&db, "kept"), 1);
        assert_eq!(events(&db, "dropped"), 1);
        let store = history::open_read(&db).unwrap();
        let rows = history::catalog_rows(
            &store,
            &[SessionRef::id(Source::Claude, "earlier".to_string())],
        )
        .unwrap();
        assert_eq!(
            rows[0].as_ref().map(|row| row.discovery_state),
            Some(ai_hist::DiscoveryState::Shallow),
            "a dropped session stays listed"
        );

        delivery::set_job_session(&conn, &job.job_id, &member("dropped"), false).unwrap();
        eventually(
            "a deselected member's evidence dropped",
            Duration::from_secs(30),
            || events(&db, "dropped") == 0,
        );
        assert_eq!(events(&db, "kept"), 1);
        // The diagnostic is written once the pass that dropped it finishes.
        let pruning = || -> serde_json::Value {
            fs::read(directory.join("pruning-diagnostic.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default()
        };
        eventually(
            "the pruning for the narrowed selection reported",
            Duration::from_secs(10),
            || pruning()["kept_sessions"] == 1,
        );
        assert!(pruning()["forgotten_sessions"].as_u64() >= Some(1));
        assert_eq!(pruning()["skipped_unrecoverable"], 0);

        // Selected again, it is captured in full again at once, not at the
        // backstop: its evidence was dropped while it was out.
        delivery::set_job_session(&conn, &job.job_id, &member("dropped"), true).unwrap();
        eventually(
            "a re-selected member captured again",
            Duration::from_secs(10),
            || events(&db, "dropped") == 1,
        );
        cancelled.store(true, Ordering::Relaxed);
        drop(capture);
    }
}
