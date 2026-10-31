//! Full maintenance yields its existing atomic work when new capture is due.
use super::*;
use std::sync::atomic::AtomicU64;

pub(super) struct Audit {
    pub result: anyhow::Result<Option<ai_hist::SyncReport>>,
    pub interrupted: bool,
}

pub(super) fn run(
    store: &ai_hist::SessionStore,
    cancelled: &Arc<AtomicBool>,
    watch: &Watching,
    activity_before_drain: Option<u64>,
    recent: &history::RecentPaths,
    roots: &history::RootSettings,
) -> Audit {
    let mut guard = Interrupt::watching(store, cancelled, watch, recent, activity_before_drain);
    guard.consent = Some((
        roots.clone(),
        Mutex::new(Instant::now() - Duration::from_secs(1)),
    ));
    execute(store, guard)
}

fn execute(store: &ai_hist::SessionStore, guard: Interrupt) -> Audit {
    let interrupted = guard.interrupted.clone();
    let extra = match &guard.consent {
        Some((roots, _)) => roots.extra_claude_roots(store),
        None => Ok(history::extra_claude_roots(store.roots())),
    };
    let result = extra.and_then(|extra| {
        history::sweep_paths_with_roots(store, false, None, None, extra, move || guard.stopped())
    });
    Audit {
        result,
        interrupted: interrupted.load(Ordering::Relaxed),
    }
}

struct Interrupt {
    store: ai_hist::SessionStore,
    cancelled: Arc<AtomicBool>,
    activity: Option<Arc<AtomicU64>>,
    initial: u64,
    recent: Option<Mutex<(Instant, history::RecentPaths)>>,
    interrupted: Arc<AtomicBool>,
    consent: Option<(history::RootSettings, Mutex<Instant>)>,
}
impl Interrupt {
    fn watching(
        store: &ai_hist::SessionStore,
        cancelled: &Arc<AtomicBool>,
        watch: &Watching,
        recent: &history::RecentPaths,
        initial: Option<u64>,
    ) -> Self {
        Self::new(
            store.clone(),
            cancelled.clone(),
            watch.watch.as_ref().ok().map(inventory::Watch::activity),
            Some(recent.clone()),
            initial,
        )
    }

    fn new(
        store: ai_hist::SessionStore,
        cancelled: Arc<AtomicBool>,
        activity: Option<Arc<AtomicU64>>,
        recent: Option<history::RecentPaths>,
        initial: Option<u64>,
    ) -> Self {
        let initial = initial.unwrap_or_else(|| {
            activity
                .as_ref()
                .map_or(0, |epoch| epoch.load(Ordering::Relaxed))
        });
        let recent =
            recent.map(|recent| Mutex::new((Instant::now() - Duration::from_secs(1), recent)));
        Self {
            store,
            cancelled,
            activity,
            initial,
            recent,
            interrupted: Arc::new(AtomicBool::new(false)),
            consent: None,
        }
    }
    fn stopped(&self) -> bool {
        if stopping(&self.cancelled) || self.interrupted.load(Ordering::Relaxed) {
            return true;
        }
        let changed = self
            .activity
            .as_ref()
            .is_some_and(|epoch| epoch.load(Ordering::Relaxed) != self.initial);
        let polled = self.recent.as_ref().is_some_and(|recent| {
            let Ok(mut held) = recent.lock() else {
                return false;
            };
            if held.0.elapsed() < Duration::from_secs(1) {
                return false;
            }
            held.0 = Instant::now();
            let extra = match &self.consent {
                Some((roots, _)) => roots.extra_claude_roots(&self.store),
                None => Ok(history::extra_claude_roots(self.store.roots())),
            };
            extra
                .and_then(|extra| held.1.poll_with_roots(&self.store, extra))
                .is_ok_and(|paths| !paths.is_empty())
        });
        let consent_changed = self.consent.as_ref().is_some_and(|(roots, checked)| {
            let Ok(mut checked) = checked.lock() else {
                return true;
            };
            if checked.elapsed() < Duration::from_secs(1) {
                return false;
            }
            *checked = Instant::now();
            roots.changed(&self.store)
        });
        if changed || polled || consent_changed {
            self.interrupted.store(true, Ordering::Relaxed);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_audit_observes_hot_preemption_while_waiting_for_its_write() {
        let Some(home) = crate::live::tests::isolated_home("live::maintenance::tests::native_audit_observes_hot_preemption_while_waiting_for_its_write") else {return};
        let db = home.join("probe/history.db");
        let store = history::open(&db).unwrap();
        let path = home.join(".claude/projects/native/native.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::live::tests::append(&path, &crate::live::tests::transcript_line("native", "one"));
        let writer = rusqlite::Connection::open(&db).unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        let activity = Arc::new(AtomicU64::new(0));
        let guard = Interrupt::new(
            store.clone(),
            Arc::new(AtomicBool::new(false)),
            Some(activity.clone()),
            None,
            None,
        );
        let interrupted = guard.interrupted.clone();
        let (completed, finished) = mpsc::channel();
        let task = std::thread::spawn(move || {
            let _ = completed.send(execute(&store, guard));
        });
        let mut name = db.as_os_str().to_owned();
        name.push(".sync.lock");
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(PathBuf::from(name))
            .unwrap();
        let started = Instant::now();
        let entered = loop {
            if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
                break true;
            }
            fs2::FileExt::unlock(&lock).unwrap();
            if started.elapsed() > Duration::from_secs(5) {
                break false;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        activity.fetch_add(1, Ordering::Relaxed);
        let notified = Instant::now();
        while !interrupted.load(Ordering::Relaxed) && notified.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let observed = interrupted.load(Ordering::Relaxed);
        let before_release = finished.recv_timeout(Duration::from_secs(5)).ok();
        let lease_released =
            before_release.is_some() && fs2::FileExt::try_lock_exclusive(&lock).is_ok();
        writer.execute_batch("ROLLBACK").unwrap();
        task.join().unwrap();
        assert!(entered, "audit must first hold the real SDK sync lease");
        assert!(
            observed,
            "the actual audit must forward its hot preemption guard to the SDK stop monitor"
        );
        assert!(lease_released, "preempted audit must release its sync lease while the competing writer still holds SQLite");
        let audit =
            before_release.expect("audit must finish before the competing writer is released");
        assert!(audit.interrupted && audit.result.is_err());
    }

    #[test]
    fn a_write_between_queue_drain_and_guard_creation_is_still_new_work() {
        let Some(home) = crate::live::tests::isolated_home("live::maintenance::tests::a_write_between_queue_drain_and_guard_creation_is_still_new_work") else {return};
        let store = history::open(&home.join("probe/history.db")).unwrap();
        let activity = Arc::new(AtomicU64::new(8));
        let guard = Interrupt::new(
            store,
            Arc::new(AtomicBool::new(false)),
            Some(activity),
            None,
            Some(7),
        );
        assert!(
            guard.stopped(),
            "the saved pre-drain cutoff must survive guard construction"
        );
    }

    #[test]
    fn maintenance_stops_when_retained_folder_consent_is_revoked() {
        let Some(home) = crate::live::tests::isolated_home(
            "live::maintenance::tests::maintenance_stops_when_retained_folder_consent_is_revoked",
        ) else {
            return;
        };
        let mut store = history::open(&home.join("probe/history.db")).unwrap();
        let mut roots = history::RootSettings::default();
        roots.refresh(&mut store).unwrap();
        let env = |key: &str| std::env::var(key).ok();
        let dirs = agent_relay_probe::relay::claude_dirs::ClaudeDirs::from_env(
            &env,
            &home,
            &agent_relay_probe::relay::workspace::relay_home(&env, &home),
        );
        let default = home.join(".claude");
        dirs.set_shared(default.to_str().unwrap(), false, &default)
            .unwrap();
        // The guard is constructed after revocation but must compare against
        // the consent that opened the old store, not silently adopt the change.
        let mut guard = Interrupt::new(store, Arc::new(AtomicBool::new(false)), None, None, None);
        guard.consent = Some((roots, Mutex::new(Instant::now() - Duration::from_secs(1))));
        assert!(guard.stopped());
        assert!(guard.interrupted.load(Ordering::Relaxed));
    }

    #[test]
    fn admitted_writes_interrupt_maintenance_without_becoming_user_stop() {
        let Some(home) = crate::live::tests::isolated_home("live::maintenance::tests::admitted_writes_interrupt_maintenance_without_becoming_user_stop") else {return};
        let store = history::open(&home.join("probe/history.db")).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let activity = Arc::new(AtomicU64::new(7));
        let guard = Interrupt::new(store, cancelled.clone(), Some(activity.clone()), None, None);
        assert!(!guard.stopped(), "old notifications are not new work");
        activity.fetch_add(1, Ordering::Relaxed);
        assert!(guard.stopped());
        assert!(guard.interrupted.load(Ordering::Relaxed));
        assert!(!cancelled.load(Ordering::Relaxed));
    }
    #[test]
    fn missing_watch_uses_bounded_recent_file_changes_to_interrupt_audit() {
        let Some(home) = crate::live::tests::isolated_home("live::maintenance::tests::missing_watch_uses_bounded_recent_file_changes_to_interrupt_audit") else {return};
        let store = history::open(&home.join("probe/history.db")).unwrap();
        let path = home.join(".claude/projects/a/a.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::live::tests::append(&path, &crate::live::tests::transcript_line("a", "one"));
        history::sweep_once(&store, true, || false).unwrap();
        let mut recent = history::RecentPaths::default();
        recent.poll(&store).unwrap();
        let guard = Interrupt::new(
            store,
            Arc::new(AtomicBool::new(false)),
            None,
            Some(recent),
            None,
        );
        assert!(!guard.stopped());
        crate::live::tests::append(&path, &crate::live::tests::transcript_line("a", "two"));
        guard.recent.as_ref().unwrap().lock().unwrap().0 = Instant::now() - Duration::from_secs(2);
        assert!(guard.stopped());
    }
    #[test]
    fn a_complete_watcher_still_interrupts_audit_for_held_open_writes() {
        let Some(home)=crate::live::tests::isolated_home("live::maintenance::tests::a_complete_watcher_still_interrupts_audit_for_held_open_writes") else {return};
        let db = home.join("probe/history.db");
        let store = history::open(&db).unwrap();
        let path = home.join(".claude/projects/a/a.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        crate::live::tests::append(&path, &crate::live::tests::transcript_line("a", "one"));
        history::sweep_once(&store, true, || false).unwrap();
        let mut recent = history::RecentPaths::default();
        recent.poll(&store).unwrap();
        let (events, _received) = mpsc::channel();
        let watch = Watching::start(&db, events, true);
        assert!(watch.complete());
        let mut guard = Interrupt::watching(
            &store,
            &Arc::new(AtomicBool::new(false)),
            &watch,
            &recent,
            None,
        );
        // Deterministically withhold all callback activity: native registration
        // success is deliberately insufficient for this held-open writer.
        guard.activity = None;
        assert!(!guard.stopped());
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        use std::io::Write;
        writer
            .write_all(crate::live::tests::transcript_line("a", "two").as_bytes())
            .unwrap();
        writer.flush().unwrap();
        guard.recent.as_ref().unwrap().lock().unwrap().0 = Instant::now() - Duration::from_secs(2);
        assert!(guard.stopped());
        drop(writer);
    }
}
