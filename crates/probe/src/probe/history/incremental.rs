//! Bounded capture and shallow inventory through the SDK.
use super::*;

/// One sweep of an open store for live capture: the same locked sweep as
/// [`sync`], trying the store's sync lock once. `Ok(None)` when another sweep
/// holds it, so nothing was read. `force` bypasses the stat-only source
/// fingerprint, as a filesystem event asks: the event can arrive before the
/// write is flushed, so each session's own stamp decides what is read. A stop
/// ends the sweep at its next provider, file or record boundary.
#[cfg(test)]
pub fn sweep_once(
    store: &SessionStore,
    force: bool,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<Option<SyncReport>> {
    sweep_sources_once(store, force, None, stopped)
}

/// A source-scoped event pass never stamps the full-source fingerprint. Full
/// reconciliation uses `None`, including startup, watcher loss and backstops.
#[cfg(test)]
pub fn sweep_sources_once(
    store: &SessionStore,
    force: bool,
    sources: Option<Vec<Source>>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<Option<SyncReport>> {
    sweep_paths_once(store, force, sources, None, stopped)
}

/// Keep exact watcher paths through the provider-owned incremental acquisition.
#[cfg(test)]
pub fn sweep_paths_once(
    store: &SessionStore,
    force: bool,
    sources: Option<Vec<Source>>,
    paths: Option<Vec<PathBuf>>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<Option<SyncReport>> {
    sweep_paths_with_roots(
        store,
        force,
        sources,
        paths,
        extra_claude_roots(store.roots()),
        stopped,
    )
}

/// Retained collectors use only roots authorized by their validated settings.
pub fn sweep_paths_with_roots(
    store: &SessionStore,
    force: bool,
    sources: Option<Vec<Source>>,
    paths: Option<Vec<PathBuf>>,
    extra: Vec<ProviderRoots>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<Option<SyncReport>> {
    let stop = Stop::follow(stopped);
    if stop.stopped() {
        return Err(cancelled());
    }
    let mut options = SyncOptions::default();
    options.force = force;
    options.sources = sources;
    options.paths = paths;
    options.stop = Some(stop.token());
    let mut report = match store.sync(options.clone()) {
        Ok(report) => report,
        Err(ai_hist::Error::SyncLocked { .. }) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if stop.stopped() {
        return Err(cancelled());
    }
    for session in sweep_extra_claude_roots(store.db_path(), extra, &options)? {
        if !report.changed.contains(&session) {
            report.changed.push(session);
        }
    }
    if stop.stopped() {
        return Err(cancelled());
    }
    Ok(Some(report))
}

/// Retain completed siblings alongside failed rounds, so refreshing healthy
/// coverage never starts a second scanner for an unresolved root.
#[derive(Default)]
pub struct Reconciliations {
    active: std::collections::VecDeque<Reconciliation>,
    completed: Vec<Reconciliation>,
}

pub struct Reconciliation {
    db: PathBuf,
    extra_claude: Option<PathBuf>,
    inner: ai_hist::Reconciliation,
}

impl Reconciliation {
    fn key(&self) -> Option<PathBuf> {
        self.extra_claude.as_ref().map(|root| {
            let projects = root.join("projects");
            projects.canonicalize().unwrap_or(projects)
        })
    }
}

impl Reconciliations {
    pub fn is_empty(&self) -> bool {
        self.active.is_empty()
    }
    pub fn clear(&mut self) {
        self.active.clear();
        self.completed.clear();
    }
    pub fn pop_front(&mut self) -> Option<Reconciliation> {
        self.active.pop_front()
    }
    pub fn push_back(&mut self, round: Reconciliation) {
        self.active.push_back(round);
    }
    pub fn completed(&mut self, round: Reconciliation) {
        self.completed.push(round);
    }
    /// Deferred errors are retained work, but do not block a fresh healthy pass.
    /// The SDK's level query is valid even when the last step returned Err.
    pub fn healthy_pass_exhausted(&self) -> bool {
        self.active
            .iter()
            .all(|round| round.inner.healthy_pass_exhausted())
    }
    /// Refresh only after every healthy iterator and acquisition queue drained.
    /// Build newly authorized contexts before mutating retained ones, so a
    /// failed open preserves both the current obligation and the retry request.
    pub fn refresh(&mut self, store: &SessionStore, settings: &RootSettings) -> Result<bool> {
        if !self.healthy_pass_exhausted() {
            return Ok(false);
        }
        let extra = settings.extra_claude_roots(store)?;
        let mut keys: std::collections::HashSet<_> = self
            .active
            .iter()
            .chain(self.completed.iter())
            .map(Reconciliation::key)
            .collect();
        let mut added = Vec::new();
        if keys.insert(None) {
            added.push(Reconciliation {
                db: store.db_path().to_owned(),
                extra_claude: None,
                inner: store.reconcile()?,
            });
        }
        for roots in extra {
            let projects = roots.claude.join("projects");
            let key = Some(projects.canonicalize().unwrap_or(projects));
            if keys.insert(key) {
                added.push(Reconciliation {
                    db: store.db_path().to_owned(),
                    extra_claude: Some(roots.claude.clone()),
                    inner: open_with(store.db_path(), roots)?
                        .reconcile()?
                        .sources([Source::Claude]),
                });
            }
        }
        let retained = self.active.len() + self.completed.len();
        self.active.extend(self.completed.drain(..));
        // Keep every prepared context owned even if the SDK unexpectedly
        // refuses a retained round. Newly added rounds already have work and
        // must not be refreshed before their first pass drains.
        self.active.extend(added);
        for round in self.active.iter_mut().take(retained) {
            if !round.inner.refresh_healthy_pass() {
                anyhow::bail!("drained SDK round refused refresh; reconciliation remains owed");
            }
        }
        Ok(true)
    }
}

/// One fair round for the base roots and every explicitly shared Claude login.
/// Callers refresh retained stores when folder settings change; each new pass
/// also discovers newly added extra roots from the validated sharing snapshot.
pub fn reconciliation(store: &SessionStore, settings: &RootSettings) -> Result<Reconciliations> {
    let mut rounds = Reconciliations::default();
    rounds.refresh(store, settings)?;
    Ok(rounds)
}

/// Bound metadata to 64 entries and acquisition to eight paths. A single
/// transcript/database keeps the SDK's existing atomic acquisition boundary.
pub fn reconcile_step(
    round: &mut Reconciliation,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<ai_hist::ReconciliationStep> {
    let stop = Stop::follow(stopped);
    let mut options = SyncOptions::default();
    options.stop = Some(stop.token());
    Ok(round.inner.step(64, 8, options)?)
}

/// The same metadata budget for selected-only inventory; never hydrate an
/// unselected transcript while discovering its catalog row.
pub fn inventory_step(
    round: &mut Reconciliation,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<ai_hist::ReconciliationStep> {
    let stop = Stop::follow(stopped);
    let mut options = DiscoveryOptions::default();
    options.stop = Some(stop.token());
    let result = round
        .inner
        .discover_step(64, 8, options)
        .map_err(Into::into);
    prune_inventory_result(&round.db, result)
}

/// Enumeration-only slices cannot have restored catalog rows. Errors may
/// follow partial commits, so they are always cleaned before propagation.
fn prune_inventory_result(
    db: &Path,
    result: Result<ai_hist::ReconciliationStep>,
) -> Result<ai_hist::ReconciliationStep> {
    if result.as_ref().is_ok_and(|step| step.discovery.is_none()) {
        return result;
    }
    super::super::session_reset::prune_catalog(db)?;
    result
}

/// Discover an exact, bounded watcher batch without evidence acquisition.
#[cfg(test)]
pub fn discover_paths(
    store: &SessionStore,
    sources: Vec<Source>,
    paths: Vec<PathBuf>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<()> {
    discover_paths_with_roots(
        store,
        sources,
        paths,
        extra_claude_roots(store.roots()),
        stopped,
    )
}

pub fn discover_paths_with_roots(
    store: &SessionStore,
    sources: Vec<Source>,
    paths: Vec<PathBuf>,
    extra: Vec<ProviderRoots>,
    stopped: impl Fn() -> bool + Send + 'static,
) -> Result<()> {
    let stop = Stop::follow(stopped);
    let claude = sources.contains(&Source::Claude);
    let mut options = DiscoveryOptions::default()
        .sources(sources)
        .stop(stop.token());
    options.paths = Some(paths);
    discover_and_prune(store.db_path(), || {
        store.discover(options.clone())?;
        if claude {
            for roots in extra {
                open_with(store.db_path(), roots)?
                    .discover(options.clone().sources([Source::Claude]))?;
            }
        }
        Ok(())
    })
}

/// Occupancy pacing excludes the SDK's measured SQLite busy-handler sleeps.
/// This is elapsed work minus a known blocking wait, not a CPU-time estimate.
pub fn cold_gap(elapsed: Duration, sqlite_busy_wait: Duration, factor: u32) -> Duration {
    elapsed
        .saturating_sub(sqlite_busy_wait)
        .saturating_mul(factor)
}

#[cfg(test)]
mod pacing_tests {
    use super::*;
    #[test]
    fn lock_wait_is_not_multiplied_into_the_next_cold_deadline() {
        assert_eq!(
            cold_gap(Duration::from_millis(5100), Duration::from_secs(5), 50),
            Duration::from_secs(5)
        );
        assert_eq!(
            cold_gap(Duration::from_millis(100), Duration::ZERO, 50),
            Duration::from_secs(5)
        );
        assert_eq!(
            cold_gap(Duration::ZERO, Duration::from_secs(1), 50),
            Duration::ZERO
        );
    }
}

#[cfg(test)]
mod retained_round_tests {
    use super::*;

    #[test]
    fn partial_refresh_keeps_completed_siblings_and_deduplicates_extra_roots() {
        let Some(home) = crate::live::tests::isolated_home(
            "history::incremental::retained_round_tests::partial_refresh_keeps_completed_siblings_and_deduplicates_extra_roots",
        ) else { return; };
        use agent_relay_probe::relay::process::FakeProcesses;
        let env = |key: &str| std::env::var(key).ok();
        ClaudeDirs::from_env(&env, &home, &relay_home(&env, &home))
            .remember_running(&FakeProcesses::default());
        let bad = home.join(".codex/archived_sessions");
        std::fs::create_dir_all(bad.parent().unwrap()).unwrap();
        std::fs::write(&bad, b"not a directory").unwrap();
        let extra = home.join(".claude-work/projects/p");
        std::fs::create_dir_all(&extra).unwrap();
        crate::live::tests::append(
            &extra.join("old.jsonl"),
            &crate::live::tests::transcript_line("extra-old", "one"),
        );
        let mut store = open(&home.join("probe/history.db")).unwrap();
        let mut settings = RootSettings::default();
        settings.refresh(&mut store).unwrap();
        let mut rounds = reconciliation(&store, &settings).unwrap();
        assert!(
            !rounds.refresh(&store, &settings).unwrap(),
            "a refresh must not discard any active iterator or queued acquisition"
        );
        let drain = |rounds: &mut Reconciliations| {
            for _ in 0..120 {
                let Some(mut round) = rounds.pop_front() else {
                    break;
                };
                if reconcile_step(&mut round, || false).is_ok_and(|step| step.complete) {
                    rounds.completed(round);
                } else {
                    rounds.push_back(round);
                }
            }
        };
        drain(&mut rounds);
        assert_eq!((rounds.active.len(), rounds.completed.len()), (1, 1));
        assert!(rounds.healthy_pass_exhausted());
        crate::live::tests::append(
            &extra.join("new.jsonl"),
            &crate::live::tests::transcript_line("extra-new", "one"),
        );
        let newly_added = home.join(".claude-personal/projects/p");
        std::fs::create_dir_all(&newly_added).unwrap();
        crate::live::tests::append(
            &newly_added.join("new.jsonl"),
            &crate::live::tests::transcript_line("extra-added", "one"),
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(home.join(".claude-work"), home.join(".claude-alias")).unwrap();
        assert!(rounds.refresh(&store, &settings).unwrap());
        assert_eq!(
            rounds.active.len(),
            3,
            "one base plus two distinct extra roots, without duplicate failed scanners"
        );
        drain(&mut rounds);
        let event_count = |id: &str| {
            rusqlite::Connection::open(store.db_path())
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM session_events WHERE session_id=?",
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        };
        assert_eq!(
            event_count("extra-new"),
            1,
            "completed sibling must participate in fresh coverage"
        );
        assert_eq!(
            event_count("extra-added"),
            1,
            "new authorized extra roots must join the retained set"
        );
        assert_eq!((rounds.active.len(), rounds.completed.len()), (1, 2));
        assert!(rounds.refresh(&store, &settings).unwrap());
        assert_eq!(
            rounds.active.len(),
            3,
            "repeated refresh must not accumulate same-root obligations"
        );

        // Reverse the roles: a failing extra root must retain a completed base
        // context too, even when the extra directory disappears from discovery.
        std::fs::remove_file(&bad).unwrap();
        std::fs::create_dir_all(&bad).unwrap();
        drain(&mut rounds);
        assert!(rounds.is_empty());
        rounds = reconciliation(&store, &settings).unwrap();
        let projects = home.join(".claude-work/projects");
        std::fs::rename(&projects, home.join(".claude-work/projects-saved")).unwrap();
        std::fs::write(&projects, b"not a directory").unwrap();
        drain(&mut rounds);
        assert_eq!((rounds.active.len(), rounds.completed.len()), (1, 2));
        let primary = home.join(".claude/projects/base/base-new.jsonl");
        std::fs::create_dir_all(primary.parent().unwrap()).unwrap();
        crate::live::tests::append(
            &primary,
            &crate::live::tests::transcript_line("base-new", "one"),
        );
        assert!(rounds.refresh(&store, &settings).unwrap());
        assert_eq!(
            rounds.active.len(),
            3,
            "a temporarily unreadable extra root remains owed once"
        );
        drain(&mut rounds);
        assert_eq!(
            event_count("base-new"),
            1,
            "completed base context must rejoin healthy coverage"
        );
    }

    #[test]
    fn refresh_refusal_keeps_retained_and_new_roots_owed() {
        let Some(home) = crate::live::tests::isolated_home(
            "history::incremental::retained_round_tests::refresh_refusal_keeps_retained_and_new_roots_owed",
        ) else { return; };
        use agent_relay_probe::relay::process::FakeProcesses;
        let env = |key: &str| std::env::var(key).ok();
        ClaudeDirs::from_env(&env, &home, &relay_home(&env, &home))
            .remember_running(&FakeProcesses::default());
        let bad = home.join(".codex/archived_sessions");
        std::fs::create_dir_all(bad.parent().unwrap()).unwrap();
        std::fs::write(&bad, b"not a directory").unwrap();
        let extra = home.join(".claude-work/projects/p");
        std::fs::create_dir_all(&extra).unwrap();
        crate::live::tests::append(
            &extra.join("existing.jsonl"),
            &crate::live::tests::transcript_line("refusal-existing", "one"),
        );
        let mut store = open(&home.join("probe/history.db")).unwrap();
        let mut settings = RootSettings::default();
        settings.refresh(&mut store).unwrap();
        let drain = |rounds: &mut Reconciliations| {
            for _ in 0..120 {
                let Some(mut round) = rounds.pop_front() else {
                    break;
                };
                if reconcile_step(&mut round, || false).is_ok_and(|step| step.complete) {
                    rounds.completed(round);
                } else {
                    rounds.push_back(round);
                }
            }
        };
        let mut rounds = reconciliation(&store, &settings).unwrap();
        drain(&mut rounds);
        assert_eq!((rounds.active.len(), rounds.completed.len()), (1, 1));
        assert!(rounds.healthy_pass_exhausted());
        crate::live::tests::append(
            &extra.join("refused.jsonl"),
            &crate::live::tests::transcript_line("refusal-retained", "one"),
        );
        // A fresh SDK round in the completed slot deterministically violates
        // the drained-round invariant without a production hook or SDK edit.
        let mut fresh = reconciliation(&store, &settings).unwrap();
        let index = fresh
            .active
            .iter()
            .position(|round| round.key().is_some())
            .unwrap();
        rounds.completed[0] = fresh.active.remove(index).unwrap();
        let added = home.join(".claude-personal/projects/p");
        std::fs::create_dir_all(&added).unwrap();
        crate::live::tests::append(
            &added.join("added.jsonl"),
            &crate::live::tests::transcript_line("refusal-added", "one"),
        );
        let error = rounds.refresh(&store, &settings).unwrap_err();
        assert!(error.to_string().contains("SDK round refused refresh"));
        assert_eq!((rounds.active.len(), rounds.completed.len()), (3, 0));
        assert_eq!(
            rounds
                .active
                .iter()
                .map(Reconciliation::key)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        assert!(
            !rounds.healthy_pass_exhausted(),
            "refused and newly prepared work remains runnable"
        );
        drain(&mut rounds);
        let count = |id: &str| {
            rusqlite::Connection::open(store.db_path())
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM session_events WHERE session_id=?",
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        };
        assert_eq!(count("refusal-retained"), 1);
        assert_eq!(count("refusal-added"), 1);
        assert_eq!(
            (rounds.active.len(), rounds.completed.len()),
            (1, 2),
            "deferred base failure remains owed"
        );
        std::fs::remove_file(&bad).unwrap();
        std::fs::create_dir_all(&bad).unwrap();
        drain(&mut rounds);
        assert!(
            rounds.active.is_empty(),
            "the retained failed round can complete after repair"
        );
        assert_eq!(rounds.completed.len(), 3);
    }
}

#[cfg(test)]
mod reset_tests;
