//! Local history through `ai-hist`'s public embedder API, `SessionStore`:
//! capture sweeps, live capture, targeted hydration, shallow inventory and
//! catalog reads. The probe's own stop flag drives each call's `StopToken`,
//! and sweep progress reaches the probe's monitor through a
//! `ProgressObserver`.
mod capture;

use agent_relay_probe::delivery::UpgradePending;
use agent_relay_probe::relay::claude_dirs::{self, ClaudeDirs};
use agent_relay_probe::relay::process::SystemProcesses;
use agent_relay_probe::relay::workspace::relay_home;
use ai_hist::{
    CaptureProgress, CatalogQuery, CatalogSession, CompactOptions, CompactReport, DiscoveryOptions,
    DiscoveryState, ForgetOptions, ForgetReport, ForgetScope, HydrateOptions, ProgressObserver,
    ProviderRoots, SessionQuery, SessionRef, SessionScope, SessionStore, Source, StopToken,
    StoreOptions, SyncOptions, SyncReport, WatchedPath,
};
use anyhow::{ensure, Context, Result};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// How often a call's `StopToken` re-reads the probe's stop condition. The
/// store checks the token at provider, file and record boundaries, so this is
/// the added latency of a stop, well under the collector's own 100 ms poll.
const STOP_POLL: Duration = Duration::from_millis(20);

/// Open `db` for writing, migrating it to the shape this `ai-hist` reads.
pub fn open(db: &Path) -> Result<SessionStore> {
    let mut options = StoreOptions::default();
    options.db_path = Some(db.to_path_buf());
    options.roots = base_roots(db);
    Ok(SessionStore::open(options)?)
}

/// The store's own provider roots, as `ai-hist` derives them from the
/// environment, except that a desktop Claude folder the person stopped
/// sharing (`relay::claude_dirs`) is replaced by one that never exists: it is
/// then never swept, discovered, watched or hydrated. `None` keeps the
/// derived roots.
fn base_roots(db: &Path) -> Option<ProviderRoots> {
    let env = |key: &str| std::env::var(key).ok();
    let home = std::env::var_os("HOME");
    // Windows names the home folder USERPROFILE; HOME is usually unset there.
    #[cfg(windows)]
    let home = home.or_else(|| std::env::var_os("USERPROFILE"));
    let home = home.map(PathBuf::from)?;
    let default = claude_dirs::default_home(&env, &home);
    let dirs = ClaudeDirs::from_env(&env, &home, &relay_home(&env, &home));
    if dirs.default_shared(&default) {
        return None;
    }
    let mut roots = ProviderRoots::from_env(home);
    roots.claude = db.with_extension("claude-not-shared");
    Some(roots)
}

/// Open `db` for reading. A database written before the shape this `ai-hist`
/// reads is `UpgradePending`, never migrated here: the commands that read are
/// the ones the desktop runs under a timeout, and a migration it kills rolls
/// back while holding off the collector, which is the one that migrates.
pub fn open_read(db: &Path) -> Result<SessionStore> {
    let mut options = StoreOptions::default();
    options.db_path = Some(db.to_path_buf());
    options.roots = base_roots(db);
    options.read_only = true;
    match SessionStore::open(options) {
        Err(error) if error.is_stale_schema() => Err(UpgradePending.into()),
        opened => Ok(opened?),
    }
}

/// The roots of each Claude Code config folder beyond `roots.claude`: sibling
/// `.claude-<name>` logins, `AGENT_RELAY_CLAUDE_CONFIG_DIRS`, folders added
/// in Settings and running sessions' `CLAUDE_CONFIG_DIR` (see
/// `relay::claude_dirs`). `ai-hist` reads one Claude folder per store, so
/// each other one is swept as Claude alone into the same database: a sweep
/// only adds and updates sessions, never drops one another folder holds.
/// A folder whose `projects/` is one already read (a link) is left out.
pub fn extra_claude_roots(roots: &ProviderRoots) -> Vec<ProviderRoots> {
    let env = |key: &str| std::env::var(key).ok();
    let dirs = ClaudeDirs::from_env(&env, &roots.home, &relay_home(&env, &roots.home));
    dirs.remember_running(&SystemProcesses::default());
    // The desktop's own folder, even when `base_roots` replaced it.
    let default = claude_dirs::default_home(&env, &roots.home);
    let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut seen = std::collections::HashSet::from([real(&default.join("projects"))]);
    dirs.extra_homes(&default)
        .into_iter()
        .filter(|claude| claude.join("projects").is_dir())
        .filter(|claude| seen.insert(real(&claude.join("projects"))))
        .map(|claude| {
            let mut extra = roots.clone();
            extra.claude = claude;
            extra
        })
        .collect()
}

/// The store over `db` reading `roots`.
fn open_with(db: &Path, roots: ProviderRoots) -> Result<SessionStore> {
    Ok(SessionStore::open(
        StoreOptions::default().db_path(db).roots(roots),
    )?)
}

/// One Claude-only sweep of each extra Claude folder into `db`, as
/// [`SessionStore::sync`] with `options` otherwise. A folder whose sweep
/// found the lock held is left to the next one. Returns the sessions the
/// sweeps changed.
fn sweep_extra_claude(
    db: &Path,
    roots: &ProviderRoots,
    options: &SyncOptions,
) -> Result<Vec<SessionRef>> {
    let mut changed = Vec::new();
    if options
        .sources
        .as_ref()
        .is_some_and(|sources| !sources.contains(&Source::Claude))
    {
        return Ok(changed);
    }
    for extra in extra_claude_roots(roots) {
        let mut options = options.clone().sources([Source::Claude]);
        options.progress = None;
        match open_with(db, extra)?.sync(options) {
            Ok(report) => changed.extend(report.changed),
            Err(ai_hist::Error::SyncLocked { .. }) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(changed)
}

/// A `StopToken` that follows the probe's stop condition for the life of one
/// store call.
struct Stop {
    token: StopToken,
    finished: Arc<AtomicBool>,
    watcher: Option<JoinHandle<()>>,
}
impl Stop {
    fn follow(stopped: impl Fn() -> bool + Send + 'static) -> Self {
        let token = StopToken::new();
        let finished = Arc::new(AtomicBool::new(false));
        if stopped() {
            token.stop();
        }
        let watcher = {
            let token = token.clone();
            let finished = finished.clone();
            std::thread::spawn(move || {
                while !finished.load(Ordering::Relaxed) && !token.is_stopped() {
                    if stopped() {
                        token.stop();
                        break;
                    }
                    std::thread::sleep(STOP_POLL);
                }
            })
        };
        Self {
            token,
            finished,
            watcher: Some(watcher),
        }
    }
    fn token(&self) -> StopToken {
        self.token.clone()
    }
    fn stopped(&self) -> bool {
        self.token.is_stopped()
    }
}
impl Drop for Stop {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Relaxed);
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
    }
}

fn cancelled() -> anyhow::Error {
    ai_hist::Error::Cancelled("local capture cancelled".into()).into()
}

/// One full local sweep into `db`. `Ok(false)` when another sweep (another
/// process's, or this process's watch tick) held the store's sync lock for
/// all of `lock_wait`, so the broad sweep did not run. Recent catalog rows may
/// already have been hydrated independently. A stop ends the wait. `force`
/// bypasses the stat-only source fingerprint, so every source is walked and
/// each session's own stamp decides what is read.
/// `observer` sees `initializing` before the sweep, each provider's file
/// counts during it, and `complete` after it.
pub fn sync(
    db: &Path,
    lock_wait: Duration,
    force: bool,
    observer: impl Fn(CaptureProgress) + Send + Sync + 'static,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<bool> {
    let stop = Stop::follow(stopped);
    let observer = Arc::new(observer);
    let phase = |source: &str| {
        observer(CaptureProgress {
            source: source.into(),
            ..Default::default()
        })
    };
    phase("initializing");
    if stop.stopped() {
        return Err(cancelled());
    }
    let store = open(db)?;
    capture::prioritize(db, &store, &stop, observer.as_ref())?;
    let mut options = SyncOptions::default();
    options.lock_timeout_ms = u64::try_from(lock_wait.as_millis()).unwrap_or(u64::MAX);
    options.force = force;
    options.stop = Some(stop.token());
    options.progress = Some(ProgressObserver::new({
        let observer = observer.clone();
        move |progress| observer(progress)
    }));
    let swept = match store.sync(options.clone()) {
        Ok(_) => true,
        Err(ai_hist::Error::SyncLocked { .. }) => false,
        Err(error) => return Err(error.into()),
    };
    if stop.stopped() {
        return Err(cancelled());
    }
    if swept {
        sweep_extra_claude(db, store.roots(), &options)?;
        if stop.stopped() {
            return Err(cancelled());
        }
        // Broad capture's remote leg: enumerate (cadence-gated) then hydrate
        // the remote-only rows `store.sync` cannot reach. Like the local
        // sweep it is reported beside the pass, not through it — a connector
        // outage lands in `remote-diagnostic.json`, never a failed sync.
        let remote_started = Instant::now();
        let remote = super::remote_sources::sweep(db, &store, || stop.stopped());
        super::remote_sources::report_sweep(db, remote_started, &remote);
    }
    phase("complete");
    Ok(swept)
}

/// Fully index one session and the subagents and child threads it delegated
/// work to, which are part of it: no provider enumeration.
pub fn hydrate(
    db: &Path,
    source: &str,
    session_id: &str,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<()> {
    let source = Source::parse(source).with_context(|| format!("unknown source {source}"))?;
    let stop = Stop::follow(stopped);
    capture::hydrate_with_stop(db, source, session_id, &stop)
}

/// How long pruning and compaction wait for the store's sync lock before
/// leaving the work to a later poll.
const PRUNE_LOCK_WAIT: Duration = Duration::from_secs(30);
/// The least a rewrite of the store has to give back to be worth its
/// exclusive minutes: 64 MiB, and a quarter of the file.
const COMPACT_MIN_RECLAIM: u64 = 64 << 20;

/// Drop the evidence of every session but `keep` and their delegated
/// children, which stay catalogued as `Shallow` and are hydrated again if
/// they are selected again. A session whose evidence no local hydration
/// could read back (its transcript deleted, or its evidence from a remote
/// or plugin source) is left as it is and counted in the report.
pub fn forget_unselected(
    db: &Path,
    keep: &[SessionRef],
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<ForgetReport> {
    let stop = Stop::follow(stopped);
    let mut options = ForgetOptions::default();
    options.lock_timeout_ms = u64::try_from(PRUNE_LOCK_WAIT.as_millis()).unwrap_or(u64::MAX);
    options.stop = Some(stop.token());
    let report = open(db)?.forget_evidence(ForgetScope::AllExcept(keep.to_vec()), options)?;
    Ok(report)
}

/// Whether the space a forget left free is worth a rewrite of the store.
pub fn worth_compacting(forgotten: &ForgetReport) -> bool {
    forgotten.reclaimable_bytes >= COMPACT_MIN_RECLAIM
        && forgotten.reclaimable_bytes.saturating_mul(4) >= forgotten.db_bytes
}

/// Rewrite the store in place to give its free space back. The rewrite holds
/// the store's write lock for its whole length, so a caller runs it while
/// nothing of its own needs to write. `None` when the volume cannot hold the
/// rewrite yet, which a later pass retries.
pub fn compact(db: &Path) -> Result<Option<CompactReport>> {
    let mut options = CompactOptions::default();
    options.lock_timeout_ms = u64::try_from(PRUNE_LOCK_WAIT.as_millis()).unwrap_or(u64::MAX);
    match open(db)?.compact(options) {
        Ok(report) => Ok(Some(report)),
        Err(ai_hist::Error::InsufficientSpace(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// One sweep of an open store for live capture: the same locked sweep as
/// [`sync`], trying the store's sync lock once. `Ok(None)` when another sweep
/// holds it, so nothing was read. `force` bypasses the stat-only source
/// fingerprint, as a filesystem event asks: the event can arrive before the
/// write is flushed, so each session's own stamp decides what is read. A stop
/// ends the sweep at its next provider, file or record boundary.
pub fn sweep_once(
    store: &SessionStore,
    force: bool,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<Option<SyncReport>> {
    sweep_sources_once(store, force, None, stopped)
}

/// A source-scoped event pass never stamps the full-source fingerprint. Full
/// reconciliation uses `None`, including startup, watcher loss and backstops.
pub fn sweep_sources_once(
    store: &SessionStore,
    force: bool,
    sources: Option<Vec<Source>>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<Option<SyncReport>> {
    let stop = Stop::follow(stopped);
    if stop.stopped() {
        return Err(cancelled());
    }
    let mut options = SyncOptions::default();
    options.force = force;
    options.sources = sources;
    options.stop = Some(stop.token());
    let mut report = match store.sync(options.clone()) {
        Ok(report) => report,
        Err(ai_hist::Error::SyncLocked { .. }) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if stop.stopped() {
        return Err(cancelled());
    }
    for session in sweep_extra_claude(store.db_path(), store.roots(), &options)? {
        if !report.changed.contains(&session) {
            report.changed.push(session);
        }
    }
    if stop.stopped() {
        return Err(cancelled());
    }
    Ok(Some(report))
}

/// One path the store's own watch covers: what a consumer watching provider
/// roots itself registers. [`WatchedPath::admits`] is the store's own filter
/// for which of its entries are evidence.
pub struct Watched {
    pub source: Source,
    pub path: WatchedPath,
}

/// Every path the store's own watch covers. A path two sources share is
/// listed for each.
pub fn watched_paths(db: &Path) -> Result<Vec<Watched>> {
    let store = open_read(db)?;
    let roots = store.roots();
    let extra = extra_claude_roots(roots);
    Ok(Source::ALL
        .iter()
        .flat_map(|source| {
            source
                .capabilities()
                .watch_roots(roots)
                .into_iter()
                .map(|path| Watched {
                    source: *source,
                    path,
                })
        })
        .chain(extra.iter().flat_map(|roots| {
            Source::Claude
                .capabilities()
                .watch_roots(roots)
                .into_iter()
                .map(|path| Watched {
                    source: Source::Claude,
                    path,
                })
        }))
        .collect())
}

/// Each session's catalog row, `None` for one the catalog does not hold.
/// Reads only the row, never the session's evidence.
pub fn catalog_rows(
    store: &SessionStore,
    sessions: &[SessionRef],
) -> Result<Vec<Option<CatalogSession>>> {
    let mut query = SessionQuery::default();
    query.include_text = false;
    query.kinds = Some(Vec::new());
    sessions
        .iter()
        .map(|session| {
            Ok(store
                .session(session, query.clone())?
                .map(|evidence| evidence.session))
        })
        .collect()
}

/// The provider file or database each session was read from, by catalog
/// row: `None` for a session the catalog does not hold or that has no local
/// file.
pub fn raw_paths(store: &SessionStore, sessions: &[SessionRef]) -> Result<Vec<Option<PathBuf>>> {
    Ok(catalog_rows(store, sessions)?
        .into_iter()
        .map(|row| row.and_then(|row| row.raw_path))
        .collect())
}

/// One shallow catalog sweep of every local provider, at most `limit` rows.
/// Returns how many sessions it read or found unchanged.
pub fn discover(
    db: &Path,
    limit: Option<usize>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<usize> {
    discover_sources(db, limit, None, stopped)
}

/// [`discover`] restricted to `sources`; `None` reads every local provider.
pub fn discover_sources(
    db: &Path,
    limit: Option<usize>,
    sources: Option<Vec<Source>>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<usize> {
    let report = discover_report(db, limit, sources, stopped)?;
    Ok(report.discovered + report.skipped_unchanged)
}

/// Refresh Grok before selected-mode delivery. A diagnostic for a selected
/// session (or one whose locator is unknown) must stop delivery, since an old
/// child might still be classified as a root. Unrelated broken histories do
/// not prevent a known selected root from uploading.
pub fn discover_grok_selection_checked(
    db: &Path,
    selected_ids: &[String],
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<usize> {
    let report = discover_report(db, None, Some(vec![Source::Grok]), stopped)?;
    if report.diagnostics.is_empty() {
        return Ok(report.discovered + report.skipped_unchanged);
    }
    let selected_refs: Vec<_> = selected_ids
        .iter()
        .map(|id| SessionRef::id(Source::Grok, id))
        .collect();
    let paths = raw_paths(&open_read(db)?, &selected_refs)?;
    let unknown_locator = paths.iter().any(Option::is_none);
    let relevant = report
        .diagnostics
        .iter()
        .filter(|diagnostic| {
            diagnostic.subject.as_ref().is_none_or(|subject| {
                unknown_locator
                    || paths
                        .iter()
                        .flatten()
                        .any(|path| path == Path::new(subject))
            })
        })
        .count();
    ensure!(
        relevant == 0,
        "local catalog refresh left {} unreadable provider or session entries",
        relevant
    );
    Ok(report.discovered + report.skipped_unchanged)
}

fn discover_report(
    db: &Path,
    limit: Option<usize>,
    sources: Option<Vec<Source>>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<ai_hist::DiscoveryReport> {
    let stop = Stop::follow(stopped);
    let claude = sources
        .as_ref()
        .is_none_or(|sources| sources.contains(&Source::Claude));
    let mut options = DiscoveryOptions::default();
    options.limit = limit;
    options.sources = sources;
    options.stop = Some(stop.token());
    let store = open(db)?;
    let report = discover_and_prune(db, || {
        let mut report = store.discover(options.clone())?;
        if claude {
            for extra in extra_claude_roots(store.roots()) {
                let extra_report =
                    open_with(db, extra)?.discover(options.clone().sources([Source::Claude]))?;
                report.discovered += extra_report.discovered;
                report.skipped_unchanged += extra_report.skipped_unchanged;
                report.diagnostics.extend(extra_report.diagnostics);
            }
        }
        Ok(report)
    })?;
    // Remote connectors (devin-cloud, claude-web) land their catalog rows on the same
    // pass — but only when this discovery's scope can name their source:
    // a provider-scoped pass (Grok-only delivery, for one) must not pay a
    // remote API round trip it cannot use. Enumeration is cadence-gated
    // inside; only a run or a failure is recorded, a skipped pass leaves
    // the previous diagnostic untouched.
    if super::remote_sources::scoped(options.sources.as_deref()) {
        let remote_started = Instant::now();
        let remote =
            super::remote_sources::enumerate(db, store.roots().home.as_path(), || stop.stopped());
        super::remote_sources::report_enumeration(db, remote_started, &remote);
    }
    Ok(report)
}

fn discover_and_prune<T>(db: &Path, discover: impl FnOnce() -> Result<T>) -> Result<T> {
    let discovered = discover();
    // Reset exclusions remain pruned even if a watched folder fails.
    super::session_reset::prune_catalog(db)?;
    discovered
}

/// Catalog rows newest first, one per session a person can select: a
/// subagent or child thread is part of the session that delegated to it and
/// is not listed apart from it. `scope` is `All` for an install's own store,
/// where every catalogued session is listed, and `Local` for the preview
/// cache.
pub fn catalog(
    store: &SessionStore,
    scope: SessionScope,
    limit: usize,
) -> Result<Vec<CatalogSession>> {
    let mut query = CatalogQuery::default();
    query.scope = scope;
    query.exclude_delegated = true;
    query.page_size = i64::try_from(limit.clamp(1, 1_000)).unwrap_or(1_000);
    let forgotten = super::session_reset::baseline()?;
    Ok(store
        .sessions(query)
        .filter(|row| match row {
            Ok(row) => !forgotten.contains(&agent_relay_probe::delivery::SessionIdentity {
                source: row.source.as_str().into(),
                session_id: row.session_id.clone(),
            }),
            Err(_) => true,
        })
        .take(limit)
        .collect::<Result<Vec<_>, _>>()?)
}

/// Catalogued sessions whose full evidence has been indexed.
pub fn captured_sessions(db: &Path) -> Result<i64> {
    let store = open_read(db)?;
    let mut query = CatalogQuery::default();
    query.scope = SessionScope::All;
    query.page_size = 1_000;
    let mut captured = 0;
    for session in store.sessions(query) {
        if session?.discovery_state == DiscoveryState::Full {
            captured += 1;
        }
    }
    Ok(captured)
}

#[cfg(test)]
mod tests {
    use super::super::live::tests::{append, isolated_home, transcript_line};
    use super::*;
    use std::fs;

    #[test]
    fn grok_subagent_summary_stays_in_history_but_leaves_the_desktop_catalog() {
        let Some(home) = crate::live::tests::isolated_home(
            "history::tests::grok_subagent_summary_stays_in_history_but_leaves_the_desktop_catalog",
        ) else {
            return;
        };
        let sessions = home.join(".grok/sessions/%2Fwork%2Fapp");
        let write_session = |id: &str, summary: serde_json::Value| {
            let directory = sessions.join(id);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("summary.json"), summary.to_string()).unwrap();
            fs::write(directory.join("chat_history.jsonl"), "").unwrap();
        };
        write_session(
            "grok-root",
            serde_json::json!({
                "info": {"id": "grok-root", "cwd": "/work/app"},
                "created_at": "2026-10-11T09:00:00.000Z",
                "updated_at": "2026-10-11T09:05:00.000Z"
            }),
        );
        write_session(
            "grok-child",
            serde_json::json!({
                "info": {"id": "grok-child", "cwd": "/work/app"},
                "created_at": "2026-10-11T09:01:00.000Z",
                "updated_at": "2026-10-11T09:02:00.000Z"
            }),
        );

        let db = home.join("catalog.db");
        assert_eq!(
            discover_sources(&db, None, Some(vec![Source::Grok]), || false).unwrap(),
            2
        );
        let store = open_read(&db).unwrap();
        let initial: Vec<_> = catalog(&store, SessionScope::Local, 10)
            .unwrap()
            .into_iter()
            .map(|row| row.session_id)
            .collect();
        assert_eq!(
            initial.len(),
            2,
            "both ordinary sessions start in the picker"
        );
        assert!(initial.contains(&"grok-root".to_owned()));
        assert!(initial.contains(&"grok-child".to_owned()));
        drop(store);

        // Grok can update a summary after discovery. The next preview refresh
        // must replace the cached classification even with an empty transcript.
        write_session(
            "grok-child",
            serde_json::json!({
                "info": {"id": "grok-child", "cwd": "/work/app"},
                "session_kind": "subagent",
                "created_at": "2026-10-11T09:01:00.000Z",
                "updated_at": "2026-10-11T09:08:00.000Z"
            }),
        );
        assert_eq!(
            discover_sources(&db, None, Some(vec![Source::Grok]), || false).unwrap(),
            2
        );
        let store = open_read(&db).unwrap();
        let visible = catalog(&store, SessionScope::Local, 10).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].session_id, "grok-root");
        // The newer child must be excluded before the picker applies its limit.
        let first_page = catalog(&store, SessionScope::Local, 1).unwrap();
        assert_eq!(first_page.len(), 1);
        assert_eq!(first_page[0].session_id, "grok-root");

        let child = catalog_rows(&store, &[SessionRef::id(Source::Grok, "grok-child")]).unwrap();
        assert_eq!(child[0].as_ref().unwrap().session_id, "grok-child");

        let mut all = CatalogQuery::default();
        all.scope = SessionScope::Local;
        let retained: Vec<_> = store
            .sessions(all)
            .map(|row| row.unwrap().session_id)
            .collect();
        assert_eq!(retained.len(), 2, "the child remains in local history");
        assert!(retained.contains(&"grok-child".to_owned()));
    }

    #[test]
    fn failed_extra_discovery_still_prunes_reset_catalog_rows() {
        let Some(home) =
            isolated_home("history::tests::failed_extra_discovery_still_prunes_reset_catalog_rows")
        else {
            return;
        };
        let folder = home.join(".claude/projects/one");
        std::fs::create_dir_all(&folder).unwrap();
        append(
            &folder.join("old.jsonl"),
            &transcript_line("old", "old-message"),
        );
        append(
            &folder.join("fresh.jsonl"),
            &transcript_line("fresh", "fresh-message"),
        );
        super::super::save_json(
            &home.join(".agentworkforce/session-reset-baseline.json"),
            &vec![agent_relay_probe::delivery::SessionIdentity {
                source: "claude".into(),
                session_id: "old".into(),
            }],
        )
        .unwrap();
        let db = home.join("history.db");
        let store = open(&db).unwrap();
        let result = discover_and_prune::<usize>(&db, || {
            store.discover(DiscoveryOptions::default().sources([Source::Claude]))?;
            let conn = rusqlite::Connection::open(&db)?;
            let old: i64 = conn.query_row(
                "SELECT count(*) FROM sessions WHERE source='claude' AND session_id='old'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(
                old, 1,
                "Partial discovery really restored the excluded shallow row"
            );
            anyhow::bail!("extra folder unavailable")
        });
        assert_eq!(result.unwrap_err().to_string(), "extra folder unavailable");
        let conn = rusqlite::Connection::open(&db).unwrap();
        let old: i64 = conn
            .query_row(
                "SELECT count(*) FROM sessions WHERE source='claude' AND session_id='old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            old, 0,
            "A failed later folder must not resurrect reset sessions"
        );
        let fresh: i64 = conn
            .query_row(
                "SELECT count(*) FROM sessions WHERE source='claude' AND session_id='fresh'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            fresh, 1,
            "Unrelated newly discovered sessions survive pruning"
        );
    }

    #[test]
    fn first_capture_indexes_recent_sessions_before_older_history_and_resumes() {
        let Some(home) = isolated_home(
            "history::tests::first_capture_indexes_recent_sessions_before_older_history_and_resumes",
        ) else { return; };
        let default = home.join(".claude/projects/one");
        let other = home.join(".seclaude/projects/two");
        fs::create_dir_all(&default).unwrap();
        fs::create_dir_all(&other).unwrap();
        std::env::set_var(
            agent_relay_probe::relay::claude_dirs::DIRS_ENV,
            "~/.seclaude",
        );
        // Deliberately reverse filename/creation order and span config roots.
        let now = chrono::Utc::now();
        for (directory, id, hours) in [
            (&default, "a-oldest", 24 * 60),
            (&default, "b-older", 24 * 14),
            (&default, "c-week", 24 * 3),
            (&other, "z-today", 2),
        ] {
            let mut line: serde_json::Value =
                serde_json::from_str(&transcript_line(id, id)).unwrap();
            line["timestamp"] =
                serde_json::json!((now - chrono::Duration::hours(hours)).to_rfc3339());
            append(&directory.join(format!("{id}.jsonl")), &format!("{line}\n"));
        }
        let codex = home.join(".codex/sessions/2026/10/15");
        fs::create_dir_all(&codex).unwrap();
        let timestamp = (now - chrono::Duration::hours(4)).to_rfc3339();
        append(
            &codex.join("rollout-codex-today.jsonl"),
            &format!(
                "{}\n{}\n",
                serde_json::json!({"timestamp": timestamp, "type": "session_meta",
                "payload": {"id": "codex-today", "cwd": "/tmp/project"}}),
                serde_json::json!({"timestamp": timestamp, "type": "event_msg",
                "payload": {"type": "user_message", "message": "synthetic codex"}}),
            ),
        );
        let db = home.join("probe/history.db");
        fs::create_dir_all(db.parent().unwrap()).unwrap();
        // This is also the default selected-mode path: metadata is visible in
        // recency order, but none of these sessions has full evidence yet.
        discover(&db, None, || false).unwrap();
        let rows = catalog(&open_read(&db).unwrap(), SessionScope::All, 100).unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>(),
            ["z-today", "codex-today", "c-week", "b-older", "a-oldest"]
        );
        assert!(rows
            .iter()
            .all(|row| row.discovery_state == DiscoveryState::Shallow));
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let snapshots = observed.clone();
        let observed_db = db.clone();
        let result = sync(
            &db,
            Duration::ZERO,
            false,
            move |progress| {
                if progress.source != "history" {
                    return;
                }
                let rows =
                    catalog(&open_read(&observed_db).unwrap(), SessionScope::All, 100).unwrap();
                let full: Vec<_> = rows
                    .into_iter()
                    .filter(|row| row.discovery_state == DiscoveryState::Full)
                    .map(|row| row.session_id)
                    .collect();
                snapshots.lock().unwrap().push(full);
                if progress.processed_files == 3 {
                    stop.store(true, Ordering::Relaxed);
                    // Cancellation follows the caller through the bounded poll.
                    std::thread::sleep(STOP_POLL * 2);
                }
            },
            move || cancelled.load(Ordering::Relaxed),
        );
        assert!(
            result.is_err(),
            "Stop after the recent sessions must interrupt backfill"
        );
        assert_eq!(
            *observed.lock().unwrap(),
            vec![
                vec!["z-today"],
                vec!["z-today", "codex-today"],
                vec!["z-today", "codex-today", "c-week"]
            ]
        );
        let resumed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let snapshots = resumed.clone();
        let observed_db = db.clone();
        assert!(sync(
            &db,
            Duration::ZERO,
            false,
            move |progress| {
                if progress.source != "history" {
                    return;
                }
                let rows =
                    catalog(&open_read(&observed_db).unwrap(), SessionScope::All, 100).unwrap();
                snapshots.lock().unwrap().push(
                    rows.into_iter()
                        .filter(|row| row.discovery_state == DiscoveryState::Full)
                        .map(|row| row.session_id)
                        .collect::<Vec<_>>(),
                );
            },
            || false
        )
        .unwrap());
        assert_eq!(
            *resumed.lock().unwrap(),
            vec![
                vec!["z-today", "codex-today", "c-week", "b-older"],
                vec!["z-today", "codex-today", "c-week", "b-older", "a-oldest"],
            ]
        );
    }

    /// Opt-in discovery reads local roots and writes only fresh temporary
    /// catalogs. No sync, hydration, delivery or remote connector is invoked.
    #[test]
    #[ignore = "opt-in read-only discovery over explicit real provider roots"]
    fn real_roots_discovery_benchmark() {
        let Some(home) = std::env::var_os("AGENT_RELAY_DISCOVERY_BENCH_HOME") else {
            return;
        };
        let source =
            std::env::var("AGENT_RELAY_DISCOVERY_BENCH_SOURCE").unwrap_or_else(|_| "claude".into());
        let source = Source::parse(&source).expect("known benchmark provider");
        let home = PathBuf::from(home).canonicalize().unwrap();
        assert!(home.is_dir());
        let root = tempfile::tempdir().unwrap();
        assert!(
            !root.path().starts_with(&home),
            "output must be outside provider home"
        );
        #[cfg(unix)]
        fn cpu_ms() -> u128 {
            let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
            assert_eq!(
                unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
                0
            );
            let usage = unsafe { usage.assume_init() };
            ((usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as u128) * 1000
                + ((usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as u128) / 1000
        }
        #[cfg(not(unix))]
        fn cpu_ms() -> u128 {
            0
        }
        for scoped in [false, true] {
            let db = root
                .path()
                .join(if scoped { "scoped.db" } else { "broad.db" });
            assert!(!db.exists());
            let mut options = StoreOptions::default();
            options.db_path = Some(db);
            options.roots = Some(ProviderRoots::from_home(
                home.clone(),
                home.join(".local/share/opencode/opencode.db"),
            ));
            let store = SessionStore::open(options).unwrap();
            let stop = StopToken::new();
            let timeout = stop.clone();
            let (done, received) = std::sync::mpsc::channel();
            let watchdog = std::thread::spawn(move || {
                if received
                    .recv_timeout(std::time::Duration::from_secs(120))
                    .is_err()
                {
                    timeout.stop();
                }
            });
            let mut discovery = DiscoveryOptions::default();
            discovery.stop = Some(stop);
            discovery.skip_protected_folder_identity = true;
            if scoped {
                discovery.sources = Some(vec![source]);
            }
            let started = std::time::Instant::now();
            let cpu_started = cpu_ms();
            let result = store.discover(discovery);
            let cpu_ms = cpu_ms().saturating_sub(cpu_started);
            let elapsed_ms = started.elapsed().as_millis();
            let _ = done.send(());
            watchdog.join().unwrap();
            match result {
                Ok(report) => {
                    let mut counts = std::collections::BTreeMap::new();
                    let mut query = CatalogQuery::default();
                    query.scope = SessionScope::All;
                    for row in store.sessions(query) {
                        *counts
                            .entry(row.unwrap().source.as_str().to_owned())
                            .or_insert(0usize) += 1;
                    }
                    eprintln!(
                        "discovery_benchmark {}",
                        serde_json::json!({"scoped":scoped,"elapsed_ms":elapsed_ms,"cpu_ms":cpu_ms,"discovered":report.discovered,"skipped_unchanged":report.skipped_unchanged,"diagnostics":report.diagnostics.len(),"provider_counts":counts})
                    );
                }
                Err(_) => eprintln!(
                    "discovery_benchmark {}",
                    serde_json::json!({"scoped":scoped,"elapsed_ms":elapsed_ms,"cpu_ms":cpu_ms,"failed":true})
                ),
            }
        }
    }

    /// The catalog-change report drives capture lag/UI diagnostics; evidence
    /// counts alone cannot prove that a scoped append reports its session.
    #[test]
    fn a_scoped_append_reports_the_changed_session() {
        let Some(home) =
            isolated_home("history::tests::a_scoped_append_reports_the_changed_session")
        else {
            return;
        };
        let transcript = home.join(".claude/projects/scoped-report/report.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        append(&transcript, &transcript_line("report", "first"));
        let db = home.join("probe/history.db");
        let store = open(&db).unwrap();
        sweep_once(&store, true, || false).unwrap();
        let mut outcomes = Vec::new();
        for (sources, marker) in [(Some(vec![Source::Claude]), "second"), (None, "third")] {
            let conn = rusqlite::Connection::open_with_flags(
                &db,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let before: Option<String> = conn.query_row("SELECT source_stamp FROM sessions WHERE source='claude' AND session_id='report'", [], |r| r.get(0)).unwrap();
            append(&transcript, &transcript_line("report", marker));
            let report = sweep_sources_once(&store, true, sources.clone(), || false)
                .unwrap()
                .unwrap();
            let after: Option<String> = conn.query_row("SELECT source_stamp FROM sessions WHERE source='claude' AND session_id='report'", [], |r| r.get(0)).unwrap();
            let events: i64 = conn.query_row("SELECT COUNT(*) FROM session_events WHERE source='claude' AND session_id='report'", [], |r| r.get(0)).unwrap();
            outcomes.push((
                sources.is_some(),
                before != after,
                events,
                report
                    .changed
                    .contains(&SessionRef::id(Source::Claude, "report")),
            ));
        }
        assert!(
            outcomes.iter().all(|(_, _, _, changed)| *changed),
            "(scoped, stamp_moved, evidence_rows, session_reported)={outcomes:?}"
        );
    }

    /// Run with AGENT_RELAY_SCOPE_WORKLOAD_FILES=1000 and --nocapture for a
    /// bounded, synthetic before/after capture workload. Never reads live roots.
    #[test]
    fn scoped_capture_workload_skips_unrelated_provider_files() {
        let Some(home) =
            isolated_home("history::tests::scoped_capture_workload_skips_unrelated_provider_files")
        else {
            return;
        };
        let files = std::env::var("AGENT_RELAY_SCOPE_WORKLOAD_FILES")
            .ok()
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(4)
            .clamp(1, 2000);
        let project = home.join(".claude/projects/scoped-workload");
        fs::create_dir_all(&project).unwrap();
        for index in 0..files {
            let id = format!("scoped-{index}");
            append(
                &project.join(format!("{id}.jsonl")),
                &transcript_line(&id, "seed"),
            );
        }
        let db = home.join("probe/history.db");
        let store = open(&db).unwrap();
        sweep_once(&store, true, || false).unwrap().unwrap();
        // The exact same fixture is measured first with baseline broad dispatch,
        // then scoped dispatch. Warm-cache order favors the second, so timings
        // are diagnostic; omitted-provider visibility is the deterministic proof.
        let started = std::time::Instant::now();
        sweep_once(&store, true, || false).unwrap().unwrap();
        let broad_ms = started.elapsed().as_millis();
        append(
            &project.join("late.jsonl"),
            &transcript_line("late", "later"),
        );
        let started = std::time::Instant::now();
        let report = sweep_sources_once(&store, true, Some(vec![Source::Codex]), || false)
            .unwrap()
            .unwrap();
        let scoped_ms = started.elapsed().as_millis();
        assert!(report
            .changed
            .iter()
            .all(|session| session.source() != Source::Claude));
        assert!(!catalog(&store, SessionScope::All, files + 2)
            .unwrap()
            .iter()
            .any(|s| s.session_id == "late"));
        // Full reconciliation still discovers the omitted source's write.
        sweep_once(&store, true, || false).unwrap().unwrap();
        assert!(catalog(&store, SessionScope::All, files + 2)
            .unwrap()
            .iter()
            .any(|s| s.session_id == "late"));
        eprintln!("scope workload: unrelated_files={files}, broad_ms={broad_ms}, scoped_ms={scoped_ms}, unrelated_new_sessions_captured_by_scoped=0, full_reconciliation_found_new_session=1");
    }

    /// A Claude login kept apart from `~/.claude` (`CLAUDE_CONFIG_DIR=~/.seclaude`)
    /// is swept, watched and hydrated into the same store as the default.
    #[test]
    fn every_claude_config_folder_is_swept_and_hydrated() {
        let Some(home) =
            isolated_home("history::tests::every_claude_config_folder_is_swept_and_hydrated")
        else {
            return;
        };
        let default = home.join(".claude/projects/one");
        let other = home.join(".seclaude/projects/two");
        std::fs::create_dir_all(&default).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        append(&default.join("mine.jsonl"), &transcript_line("mine", "a"));
        append(&other.join("theirs.jsonl"), &transcript_line("theirs", "b"));
        let db = home.join("probe/history.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let listed = |db: &Path| {
            let store = open_read(db).unwrap();
            let mut ids: Vec<String> = catalog(&store, SessionScope::All, 100)
                .unwrap()
                .into_iter()
                .map(|s| s.session_id)
                .collect();
            ids.sort();
            ids
        };

        // Not watched yet: only the default folder is read.
        assert!(sync(&db, Duration::ZERO, true, |_| {}, || false).unwrap());
        assert_eq!(listed(&db), ["mine"]);

        std::env::set_var(
            agent_relay_probe::relay::claude_dirs::DIRS_ENV,
            "~/.seclaude",
        );
        let store = open(&db).unwrap();
        assert_eq!(
            extra_claude_roots(store.roots())
                .into_iter()
                .map(|roots| roots.claude)
                .collect::<Vec<_>>(),
            [home.join(".seclaude")]
        );
        assert!(
            watched_paths(&db)
                .unwrap()
                .iter()
                .any(|w| w.source == Source::Claude
                    && w.path.path.starts_with(home.join(".seclaude")))
        );
        // A Codex event must not read either Claude login. This also guards
        // the extra-root wrapper, which used to sweep Claude unconditionally.
        sweep_sources_once(&store, true, Some(vec![Source::Codex]), || false).unwrap();
        assert_eq!(listed(&db), ["mine"]);
        let report = sweep_sources_once(&store, true, Some(vec![Source::Claude]), || false)
            .unwrap()
            .unwrap();
        assert!(report
            .changed
            .contains(&SessionRef::id(Source::Claude, "theirs")));
        assert_eq!(listed(&db), ["mine", "theirs"]);
        hydrate(&db, "claude", "theirs", || false).unwrap();
        hydrate(&db, "claude", "mine", || false).unwrap();
        assert_eq!(captured_sessions(&db).unwrap(), 2);

        // Only ~/.seclaude is shared: a session in ~/.claude is never
        // uploaded, whatever the upload policy says.
        let dirs = ClaudeDirs::from_env(
            &|key: &str| std::env::var(key).ok(),
            &home,
            &home.join(".agentworkforce/relay"),
        );
        dirs.set_shared(
            &home.join(".claude").display().to_string(),
            false,
            &home.join(".claude"),
        )
        .unwrap();
        let conn = agent_relay_probe::delivery::open_db(&db).unwrap();
        let shareable = |session: &str| {
            agent_relay_probe::delivery::is_shareable(
                &conn,
                &agent_relay_probe::delivery::SessionIdentity {
                    source: "claude".into(),
                    session_id: session.into(),
                },
            )
            .unwrap()
        };
        assert!(!shareable("mine"));
        assert!(shareable("theirs"));
        // One the catalog cannot place is withheld while a folder is off.
        assert!(!shareable("uncatalogued"));
    }

    /// An unshared default folder is not swept, and its sessions are not
    /// hydrated, while a shared extra folder still is.
    #[test]
    fn an_unshared_default_folder_is_not_read() {
        let Some(home) = isolated_home("history::tests::an_unshared_default_folder_is_not_read")
        else {
            return;
        };
        let default = home.join(".claude/projects/one");
        let other = home.join(".seclaude/projects/two");
        std::fs::create_dir_all(&default).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        append(&default.join("mine.jsonl"), &transcript_line("mine", "a"));
        append(&other.join("theirs.jsonl"), &transcript_line("theirs", "b"));
        std::env::set_var(
            agent_relay_probe::relay::claude_dirs::DIRS_ENV,
            "~/.seclaude",
        );
        let dirs = ClaudeDirs::from_env(
            &|key: &str| std::env::var(key).ok(),
            &home,
            &home.join(".agentworkforce/relay"),
        );
        dirs.set_shared(
            &home.join(".claude").display().to_string(),
            false,
            &home.join(".claude"),
        )
        .unwrap();
        let db = home.join("probe/history.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        assert!(sync(&db, Duration::ZERO, true, |_| {}, || false).unwrap());
        discover(&db, None, || false).unwrap();
        let store = open_read(&db).unwrap();
        let ids: Vec<String> = catalog(&store, SessionScope::All, 100)
            .unwrap()
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        assert_eq!(ids, ["theirs"]);
        assert!(!watched_paths(&db)
            .unwrap()
            .iter()
            .any(|w| w.path.path.starts_with(home.join(".claude"))));
        assert!(hydrate(&db, "claude", "mine", || false).is_err());
    }

    /// An unshared extra folder is not swept.
    #[test]
    fn an_unshared_claude_folder_is_not_swept() {
        let Some(home) = isolated_home("history::tests::an_unshared_claude_folder_is_not_swept")
        else {
            return;
        };
        let other = home.join(".claude-work/projects/two");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        append(&other.join("theirs.jsonl"), &transcript_line("theirs", "b"));
        let dirs = ClaudeDirs::from_env(&|_| None, &home, &home.join(".agentworkforce/relay"));
        dirs.set_shared(
            &home.join(".claude-work").display().to_string(),
            false,
            &home.join(".claude"),
        )
        .unwrap();
        let db = home.join("probe/history.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        assert!(sync(&db, Duration::ZERO, true, |_| {}, || false).unwrap());
        let store = open_read(&db).unwrap();
        assert!(catalog(&store, SessionScope::All, 100).unwrap().is_empty());
    }
}
