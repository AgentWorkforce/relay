//! Fair shallow inventory slices; no evidence acquisition for unselected rows.
use super::*;

#[derive(Clone, Copy)]
pub(super) struct Context<'a> {
    pub directory: &'a Path,
    pub cancelled: &'a Arc<AtomicBool>,
    pub received: &'a mpsc::Receiver<Signal>,
    pub events: &'a mpsc::Sender<Signal>,
    pub options: &'a InventoryOptions,
    pub catalogued: &'a dyn Fn(),
}

struct InventoryLoop<'a> {
    context: Context<'a>,
    store: ai_hist::SessionStore,
    watch: Option<Watch>,
    marked: BTreeSet<Source>,
    paths: BTreeSet<PathBuf>,
    lost: bool,
    settled: Instant,
    spaced: Instant,
    full_at: Instant,
    rounds: history::Reconciliations,
    partial_pass_finished: bool,
    rescan_again: bool,
    hot_at: Instant,
    hot_since_cold: bool,
    recent: history::RecentPaths,
    poll_at: Instant,
    roots: history::RootSettings,
    refresh_after: Instant,
}

pub(super) fn run(context: Context<'_>) {
    while !collector::stopping(context.cancelled) {
        let started = Instant::now();
        match InventoryLoop::new(context) {
            Ok(mut inventory) => {
                inventory.run();
                return;
            }
            Err(error) => {
                let _ = collector::capture_diagnostic(
                    context.directory,
                    "shallow_inventory",
                    started,
                    0,
                    1,
                    Some(&error),
                );
            }
        }
        let due = Instant::now()
            + started
                .elapsed()
                .saturating_mul(context.options.duty_factor)
                .max(context.options.min_gap)
                .max(Duration::from_millis(100));
        while !collector::stopping(context.cancelled) && Instant::now() < due {
            match context.received.recv_timeout(
                due.saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(100)),
            ) {
                Ok(Signal::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                _ => {}
            }
        }
    }
}

impl<'a> InventoryLoop<'a> {
    fn new(context: Context<'a>) -> anyhow::Result<Self> {
        let db = context.directory.join("history.db");
        let store = history::open(&db)?;
        let now = Instant::now();
        Ok(Self {
            context,
            store,
            watch: None,
            marked: Default::default(),
            paths: Default::default(),
            lost: false,
            settled: now,
            spaced: now,
            full_at: now,
            rounds: Default::default(),
            partial_pass_finished: false,
            rescan_again: false,
            hot_at: now,
            hot_since_cold: false,
            recent: Default::default(),
            poll_at: now,
            roots: Default::default(),
            refresh_after: now,
        })
    }

    fn run(&mut self) {
        while !collector::stopping(self.context.cancelled) {
            for _ in 0..128 {
                let Ok(signal) = self.context.received.try_recv() else {
                    break;
                };
                if !self.signal(signal) {
                    return;
                }
            }
            let now = Instant::now();
            if !self.refresh_roots(now) {
                // Past capture deadlines must not turn a settings failure into
                // a 100Hz retry/diagnostic loop. Stop is checked next turn.
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            if !self.advance(now) {
                return;
            }
        }
    }

    fn advance(&mut self, now: Instant) -> bool {
        self.refresh(now);
        self.poll_recent(now);
        let hot_ready = !self.paths.is_empty() && now >= self.settled && now >= self.hot_at;
        let cold_ready = !self.rounds.is_empty() && now >= self.spaced;
        let started = Instant::now();
        if cold_ready && (self.hot_since_cold || !hot_ready) {
            let (failed, busy_wait) = self.cold(started);
            self.spaced = Instant::now()
                + history::cold_gap(
                    started.elapsed(),
                    busy_wait,
                    self.context.options.duty_factor,
                )
                .max(if failed {
                    self.context.options.min_gap
                } else {
                    Duration::ZERO
                });
            self.hot_since_cold = false;
            (self.context.catalogued)();
        } else if hot_ready {
            self.hot(started);
            self.hot_at = Instant::now()
                + started
                    .elapsed()
                    .saturating_mul(self.context.options.duty_factor)
                    .max(self.context.options.min_gap);
            self.hot_since_cold = true;
            (self.context.catalogued)();
        } else if !self.wait(now) {
            return false;
        }
        true
    }

    fn refresh_roots(&mut self, now: Instant) -> bool {
        let checked = self.roots.last_checked();
        match self.roots.refresh(&mut self.store) {
            Ok(true) => {
                self.rounds.clear();
                self.partial_pass_finished = false;
                self.paths.clear();
                self.marked.clear();
                self.recent = Default::default();
                self.full_at = now;
                self.spaced = now;
                self.poll_at = now;
                self.refresh_after = now;
                self.rescan_again = false;
            }
            Ok(false) => {}
            Err(_) if self.roots.last_checked() == checked => return false,
            Err(error) => {
                let _ = collector::capture_diagnostic(
                    self.context.directory,
                    "shallow_inventory",
                    now,
                    0,
                    1,
                    Some(&error),
                );
                return false;
            }
        }
        true
    }

    fn poll_recent(&mut self, now: Instant) {
        if now < self.poll_at {
            return;
        }
        self.poll_at = now
            + self
                .context
                .options
                .min_gap
                .min(Duration::from_secs(5))
                .max(Duration::from_millis(100));
        if let Ok(paths) = self
            .roots
            .extra_claude_roots(&self.store)
            .and_then(|extra| self.recent.poll_with_roots(&self.store, extra))
        {
            for (source, path) in paths {
                self.marked.insert(source);
                if self.paths.contains(&path) || self.paths.len() < 4096 {
                    self.paths.insert(path);
                } else {
                    self.lost = true;
                }
            }
        }
    }

    fn signal(&mut self, signal: Signal) -> bool {
        match signal {
            Signal::Changed(path) => self.notice(path),
            Signal::Lost => self.lost = true,
            Signal::Stop => return false,
        }
        true
    }

    fn refresh(&mut self, now: Instant) {
        if now < self.refresh_after || (now < self.full_at && !self.lost) {
            return;
        }
        self.watch = self
            .context
            .options
            .use_fs_events
            .then(|| {
                let events = self.context.events.clone();
                let extra = self.roots.extra_claude_roots(&self.store).ok()?;
                Watch::start_paths(
                    history::watched_paths_for(&self.store, extra),
                    move |path| {
                        let _ = events.send(match path {
                            Some(path) => Signal::Changed(path),
                            None => Signal::Lost,
                        });
                    },
                )
                .ok()
            })
            .flatten();
        if self.rounds.is_empty() {
            match history::reconciliation(&self.store, &self.roots) {
                Ok(next) => self.rounds = next,
                Err(error) => {
                    self.lost = true;
                    self.refresh_after =
                        now + self.context.options.min_gap.max(Duration::from_millis(100));
                    let _ = collector::capture_diagnostic(
                        self.context.directory,
                        "shallow_inventory",
                        now,
                        0,
                        1,
                        Some(&error),
                    );
                    return;
                }
            }
        } else if self.rounds.healthy_pass_exhausted() {
            if let Err(error) = self.rounds.refresh(&self.store, &self.roots) {
                self.lost = true;
                self.refresh_after =
                    now + self.context.options.min_gap.max(Duration::from_millis(100));
                let _ = collector::capture_diagnostic(
                    self.context.directory,
                    "shallow_inventory",
                    now,
                    0,
                    1,
                    Some(&error),
                );
                return;
            }
            self.partial_pass_finished = false;
            self.rescan_again = false;
        } else if self.lost {
            self.rescan_again = true;
        }
        self.full_at = now + self.context.options.backstop;
        self.lost = false;
    }

    fn hot(&mut self, started: Instant) {
        let batch: Vec<_> = self.paths.iter().take(8).cloned().collect();
        if let Some(watch) = &self.watch {
            self.recent.remember(
                batch
                    .iter()
                    .flat_map(|path| watch.sources(path).map(|source| (source, path.clone()))),
            );
        }
        let stop = self.context.cancelled.clone();
        let result = self
            .roots
            .extra_claude_roots(&self.store)
            .and_then(|extra| {
                history::discover_paths_with_roots(
                    &self.store,
                    self.marked.iter().copied().collect(),
                    batch.clone(),
                    extra,
                    move || collector::stopping(&stop),
                )
            });
        if result.is_ok() {
            for path in &batch {
                self.paths.remove(path);
            }
            if self.paths.is_empty() {
                self.marked.clear();
            }
        }
        let _ = collector::capture_diagnostic(
            self.context.directory,
            "shallow_inventory",
            started,
            batch.len(),
            usize::from(result.is_err()),
            result.as_ref().err(),
        );
    }

    fn cold(&mut self, started: Instant) -> (bool, Duration) {
        let Some(mut round) = self.rounds.pop_front() else {
            return (false, Duration::ZERO);
        };
        let stop = self.context.cancelled.clone();
        let result = history::inventory_step(&mut round, move || collector::stopping(&stop));
        if result.as_ref().is_ok_and(|step| step.complete) {
            self.rounds.completed(round);
        } else {
            self.rounds.push_back(round);
        }
        let busy_wait = result
            .as_ref()
            .map_or(Duration::ZERO, |step| step.sqlite_busy_wait);
        let diagnostic = serde_json::json!({
            "operation": "capture", "stage": "shallow_inventory", "elapsed_ms": started.elapsed().as_millis(),
            "sqlite_busy_wait_ms": busy_wait.as_millis(),
            "sessions_captured": result.as_ref().map_or(0, |step| step.paths),
            "failures": usize::from(result.is_err()),
            "error_class": result.as_ref().err().map(collector::capture_error_class),
        });
        let _ = crate::save_status_json(
            &self.context.directory.join("inventory-diagnostic.json"),
            &diagnostic,
        );
        if result.is_err() {
            eprintln!("{diagnostic}");
        }
        let clean = self.rounds.is_empty();
        let boundary =
            clean || (!self.partial_pass_finished && self.rounds.healthy_pass_exhausted());
        if boundary {
            self.partial_pass_finished = !clean;
            let interval = if self.watch.as_ref().is_some_and(Watch::complete) {
                self.context.options.backstop
            } else {
                // Without native events, completed rounds are the polling
                // driver. The long watcher backstop would leave new files
                // unseen between rounds. Per-slice cost pacing still applies.
                self.context.options.min_gap
            };
            self.full_at = Instant::now() + interval;
        }
        if clean {
            self.rounds.clear();
        }
        if self.rounds.healthy_pass_exhausted() && std::mem::take(&mut self.rescan_again) {
            self.lost = true;
            self.full_at = Instant::now();
        }
        (result.is_err(), busy_wait)
    }

    fn wait(&mut self, now: Instant) -> bool {
        let mut wake = self.full_at.max(self.refresh_after);
        if !self.rounds.is_empty() {
            wake = wake.min(self.spaced);
        }
        if !self.paths.is_empty() {
            wake = wake.min(self.hot_at.max(self.settled));
        }
        wake = wake.min(self.poll_at);
        match self.context.received.recv_timeout(
            wake.saturating_duration_since(now)
                .max(Duration::from_millis(10))
                .min(Duration::from_millis(100)),
        ) {
            Ok(signal) => return self.signal(signal),
            Err(mpsc::RecvTimeoutError::Disconnected) => return false,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        true
    }

    fn notice(&mut self, path: PathBuf) {
        let Some(watch) = &self.watch else {
            return;
        };
        let sources: Vec<_> = watch.sources(&path).collect();
        if sources.is_empty() {
            return;
        }
        // Parent-directory watches also report unrelated folders, including
        // this worker's own diagnostic writes. Only an admitted directory
        // can request reconciliation; otherwise those writes feed back.
        if !path.is_file() {
            self.lost = true;
            return;
        }
        self.marked.extend(sources);
        if self.paths.is_empty() {
            self.settled = Instant::now() + self.context.options.settle;
        }
        if self.paths.contains(&path) || self.paths.len() < 4096 {
            self.paths.insert(path);
        } else {
            self.lost = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_settings_failure_does_not_rewrite_diagnostics_between_retries() {
        let Some(home) = crate::live::tests::isolated_home("inventory::follow::tests::cached_settings_failure_does_not_rewrite_diagnostics_between_retries") else { return; };
        let directory = home.join("probe");
        let (events, received) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = InventoryOptions::default();
        let mut inventory = InventoryLoop::new(Context {
            directory: &directory,
            cancelled: &cancelled,
            received: &received,
            events: &events,
            options: &options,
            catalogued: &|| {},
        })
        .unwrap();
        let env = |key: &str| std::env::var(key).ok();
        let file = agent_relay_probe::relay::workspace::relay_home(&env, &home)
            .join(agent_relay_probe::relay::claude_dirs::FILE);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, b"{").unwrap();
        assert!(!inventory.refresh_roots(Instant::now()));
        let diagnostic = directory.join("inventory-diagnostic.json");
        assert!(diagnostic.is_file());
        std::fs::remove_file(&diagnostic).unwrap();
        for _ in 0..100 {
            assert!(!inventory.refresh_roots(Instant::now()));
        }
        assert!(
            !diagnostic.exists(),
            "cached failure must neither write a diagnostic nor resume capture"
        );
    }

    #[test]
    fn failed_round_creation_retains_loss_and_retries_after_pacing() {
        let Some(home) = crate::live::tests::isolated_home(
            "inventory::follow::tests::failed_round_creation_retains_loss_and_retries_after_pacing",
        ) else {
            return;
        };
        let directory = home.join("probe");
        let (events, received) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = InventoryOptions {
            use_fs_events: false,
            ..InventoryOptions::default()
        };
        let mut inventory = InventoryLoop::new(Context {
            directory: &directory,
            cancelled: &cancelled,
            received: &received,
            events: &events,
            options: &options,
            catalogued: &|| {},
        })
        .unwrap();
        assert!(inventory.refresh_roots(Instant::now()));
        inventory.store = history::open_read(inventory.store.db_path()).unwrap();
        inventory.lost = true;
        let now = Instant::now();
        inventory.refresh(now);
        assert!(inventory.lost && inventory.rounds.is_empty());
        assert!(inventory.refresh_after > now);
        inventory.store = history::open(inventory.store.db_path()).unwrap();
        inventory.refresh(now); // not yet due
        assert!(inventory.rounds.is_empty());
        inventory.refresh(inventory.refresh_after);
        assert!(!inventory.lost && !inventory.rounds.is_empty());
    }

    #[test]
    fn complete_watch_keeps_recent_polling_and_duplicate_paths_do_not_overflow() {
        let Some(home) = crate::live::tests::isolated_home("inventory::follow::tests::complete_watch_keeps_recent_polling_and_duplicate_paths_do_not_overflow") else { return; };
        let directory = home.join("probe");
        let project = home.join(".claude/projects/partial");
        std::fs::create_dir_all(&project).unwrap();
        let transcript = project.join("partial.jsonl");
        crate::live::tests::append(
            &transcript,
            &crate::live::tests::transcript_line("partial", "one"),
        );
        let (events, received) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = InventoryOptions::default();
        let mut inventory = InventoryLoop::new(Context {
            directory: &directory,
            cancelled: &cancelled,
            received: &received,
            events: &events,
            options: &options,
            catalogued: &|| {},
        })
        .unwrap();
        assert!(inventory.refresh_roots(Instant::now()));
        history::discover_paths(
            &inventory.store,
            vec![Source::Claude],
            vec![transcript.clone()],
            || false,
        )
        .unwrap();
        let watch = Watch::start(inventory.store.db_path(), |_| {}).unwrap();
        assert!(watch.complete());
        inventory.watch = Some(watch);
        inventory.poll_recent(Instant::now());
        assert!(
            inventory.paths.contains(&transcript),
            "complete registration must still poll known files"
        );
        for n in 0..4095 {
            inventory
                .paths
                .insert(project.join(format!("other-{n}.jsonl")));
        }
        inventory.notice(transcript);
        assert!(!inventory.lost, "a duplicate at capacity is not lost work");
    }

    #[test]
    fn directory_notices_require_provider_admission_before_requesting_a_round() {
        let Some(home)=crate::live::tests::isolated_home("inventory::follow::tests::directory_notices_require_provider_admission_before_requesting_a_round") else {return};
        let directory = home.join("probe");
        std::fs::create_dir_all(&directory).unwrap();
        let project = home.join(".claude/projects/p");
        std::fs::create_dir_all(&project).unwrap();
        let (events, received) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = InventoryOptions::default();
        let mut inventory = InventoryLoop::new(Context {
            directory: &directory,
            cancelled: &cancelled,
            received: &received,
            events: &events,
            options: &options,
            catalogued: &|| {},
        })
        .unwrap();
        inventory.watch = Some(Watch::start(inventory.store.db_path(), |_| {}).unwrap());
        inventory.notice(directory.clone());
        assert!(
            !inventory.lost,
            "an unrelated diagnostic folder must not request a round"
        );
        assert!(inventory.paths.is_empty());
        inventory.notice(project);
        assert!(
            inventory.lost,
            "an admitted provider directory must still request reconciliation"
        );
    }
    #[test]
    fn periodic_round_rests_after_completion_but_actual_loss_keeps_followup() {
        let Some(home) = crate::live::tests::isolated_home("inventory::follow::tests::periodic_round_rests_after_completion_but_actual_loss_keeps_followup") else {return};
        let directory = home.join("probe");
        let (events, received) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = InventoryOptions::default();
        let mut inventory = InventoryLoop::new(Context {
            directory: &directory,
            cancelled: &cancelled,
            received: &received,
            events: &events,
            options: &options,
            catalogued: &|| {},
        })
        .unwrap();
        assert!(inventory.refresh_roots(Instant::now()));
        inventory.refresh(Instant::now());
        assert!(!inventory.rounds.is_empty());
        assert!(inventory.watch.as_ref().is_some_and(Watch::complete));
        let head = inventory.store.head_revision().unwrap();
        inventory.refresh(inventory.full_at + options.backstop * 3);
        assert!(
            !inventory.rescan_again,
            "an elapsed timer is not actual loss"
        );
        let finishing = Instant::now();
        while !inventory.rounds.is_empty() {
            inventory.cold(Instant::now());
        }
        assert_eq!(inventory.store.head_revision().unwrap(), head);
        assert!(!inventory.lost);
        let next = inventory.full_at;
        assert!(next >= finishing + options.backstop);
        inventory.refresh(next - Duration::from_nanos(1));
        assert!(inventory.rounds.is_empty());
        inventory.refresh(next);
        assert!(
            !inventory.rounds.is_empty(),
            "the retained periodic deadline must run"
        );
        inventory.signal(Signal::Lost);
        inventory.refresh(next);
        assert!(inventory.rescan_again);
        while !inventory.rounds.is_empty() {
            inventory.cold(Instant::now());
        }
        assert!(inventory.lost);
        assert!(inventory.full_at <= Instant::now());
        inventory.refresh(Instant::now());
        assert!(
            !inventory.rounds.is_empty(),
            "actual loss must not wait for the periodic interval"
        );
        inventory.watch = None;
        let finishing = Instant::now();
        while !inventory.rounds.is_empty() {
            inventory.cold(Instant::now());
        }
        assert!(inventory.full_at >= finishing + options.min_gap);
        assert!(
            inventory.full_at < finishing + options.backstop,
            "without a watcher completed rounds retain polling cadence"
        );
    }

    #[test]
    fn partial_inventory_revisits_healthy_roots_at_poll_and_loss_deadlines() {
        let Some(home) = crate::live::tests::isolated_home(
            "inventory::follow::tests::partial_inventory_revisits_healthy_roots_at_poll_and_loss_deadlines",
        ) else { return; };
        use agent_relay_probe::relay::{
            claude_dirs::ClaudeDirs, process::FakeProcesses, workspace::relay_home,
        };
        let env = |key: &str| std::env::var(key).ok();
        ClaudeDirs::from_env(&env, &home, &relay_home(&env, &home))
            .remember_running(&FakeProcesses::default());
        let bad = home.join(".codex/archived_sessions");
        std::fs::create_dir_all(&bad.parent().unwrap()).unwrap();
        std::fs::write(&bad, b"not a directory").unwrap();
        let project = home.join(".claude/projects/healthy");
        std::fs::create_dir_all(&project).unwrap();
        let directory = home.join("probe");
        let (events, received) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let options = InventoryOptions {
            use_fs_events: false,
            ..InventoryOptions::default()
        };
        let mut inventory = InventoryLoop::new(Context {
            directory: &directory,
            cancelled: &cancelled,
            received: &received,
            events: &events,
            options: &options,
            catalogued: &|| {},
        })
        .unwrap();
        assert!(inventory.refresh_roots(Instant::now()));
        inventory.refresh(Instant::now());
        for _ in 0..120 {
            inventory.cold(Instant::now());
        }
        assert!(!inventory.rounds.is_empty());
        let next = inventory.full_at;
        inventory.cold(Instant::now());
        assert_eq!(
            inventory.full_at, next,
            "retry-only turns must retain the fresh coverage deadline"
        );
        assert!(
            next < Instant::now() + options.backstop,
            "partial polling coverage retains the short polling interval"
        );
        let catalogued = |inventory: &InventoryLoop<'_>, id: &str| {
            inventory
                .store
                .sessions(ai_hist::CatalogQuery::default())
                .any(|row| row.unwrap().session_id == id)
        };
        let new = project.join("periodic-inventory.jsonl");
        crate::live::tests::append(
            &new,
            &crate::live::tests::transcript_line("periodic-inventory", "one"),
        );
        inventory.refresh(next);
        for _ in 0..120 {
            inventory.cold(Instant::now());
        }
        assert!(
            catalogued(&inventory, "periodic-inventory"),
            "periodic healthy inventory must not wait for error repair"
        );
        assert_eq!(
            rusqlite::Connection::open(inventory.store.db_path())
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM session_events WHERE session_id='periodic-inventory'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "partial inventory must remain shallow"
        );
        let new = project.join("lost-inventory.jsonl");
        crate::live::tests::append(
            &new,
            &crate::live::tests::transcript_line("lost-inventory", "one"),
        );
        inventory.signal(Signal::Lost);
        inventory.refresh(Instant::now());
        for _ in 0..120 {
            inventory.cold(Instant::now());
        }
        assert!(
            catalogued(&inventory, "lost-inventory"),
            "real loss retains prompt healthy successor coverage"
        );
        assert!(
            !inventory.rounds.is_empty(),
            "failed enumeration is still owed"
        );
    }
}
