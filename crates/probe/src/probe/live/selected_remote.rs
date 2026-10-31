//! Selected capture enumerates remote metadata independently; only its
//! existing selected-member loop acquires evidence.
use super::*;

/// The running capture thread. Dropping it ends the thread, as the probe's
/// stop request does, and waits for it: after its in-flight sweep.
pub(crate) struct Capture {
    pub(super) thread: Option<JoinHandle<()>>,
    pub(super) stop: Arc<AtomicBool>,
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Clock {
    #[cfg(test)]
    source: Option<Arc<super::super::remote_sources::test_host::VirtualClock>>,
}
impl Clock {
    fn new(db: &Path) -> Self {
        let _ = db;
        Self {
            #[cfg(test)]
            source: super::super::remote_sources::test_host::clock_for_current_home(db),
        }
    }
    fn now(&self) -> Instant {
        #[cfg(test)]
        if let Some(clock) = &self.source {
            return clock.now();
        }
        Instant::now()
    }
    fn arm(&self, due: Instant) {
        let _ = due;
        #[cfg(test)]
        if let Some(clock) = &self.source {
            clock.arm(due);
        }
    }
    fn disarm(&self) {
        #[cfg(test)]
        if let Some(clock) = &self.source {
            clock.disarm();
        }
    }
}

pub(super) struct Worker {
    thread: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(super) fn start(
    directory: &Path,
    cancelled: &Arc<AtomicBool>,
    shared: &Arc<Shared>,
    options: &LiveOptions,
) -> Worker {
    let directory = directory.to_path_buf();
    let cancelled = cancelled.clone();
    let shared = shared.clone();
    let interval = options.backstop;
    let stop = Arc::new(AtomicBool::new(false));
    let halted = stop.clone();
    let thread = std::thread::spawn(move || {
        let is_stopped = || stopping(&cancelled) || halted.load(Ordering::Relaxed);
        super::super::priority::background("remote-inventory");
        let db = directory.join("history.db");
        let mut home = None;
        let clock = Clock::new(&db);
        while !is_stopped() {
            let started = clock.now();
            let result = (|| {
                if home.is_none() {
                    home = Some(history::open(&db)?.roots().home.clone());
                }
                enumerate(
                    &db,
                    home.as_deref()
                        .ok_or_else(|| anyhow::anyhow!("remote roots unavailable"))?,
                    || is_stopped(),
                )
            })();
            super::super::remote_sources::report_enumeration(&db, started, &result);
            if result.as_ref().is_ok_and(|report| report.is_some()) {
                shared.remote_catalogued.store(true, Ordering::Relaxed);
                shared.catalogued();
            }
            let due = deadline(started, clock.now(), interval);
            clock.arm(due);
            while !is_stopped() && clock.now() < due {
                std::thread::sleep(STOP_POLL);
            }
            clock.disarm();
        }
    });
    Worker {
        thread: Some(thread),
        stop,
    }
}

fn deadline(started: Instant, finished: Instant, interval: Duration) -> Instant {
    finished
        + interval.max(
            finished
                .saturating_duration_since(started)
                .saturating_mul(SWEEP_DUTY_FACTOR),
        )
}

fn enumerate(
    db: &Path,
    home: &Path,
    stopped: impl Fn() -> bool,
) -> anyhow::Result<Option<super::super::remote_sources::Enumeration>> {
    let result = super::super::remote_sources::enumerate(db, home, stopped);
    if !matches!(&result, Ok(None)) {
        super::super::session_reset::prune_catalog(db)?;
    }
    result
}

/// Restore an unprepared notification on every error path. A new publication
/// can arrive meanwhile; no successful preparation ever stores false again.
pub(super) struct Notice<'a> {
    changed: HashSet<delivery::SessionIdentity>,
    shared: &'a Shared,
    restore: bool,
}
impl Notice<'_> {
    pub(super) fn contains(&self, member: &delivery::SessionIdentity) -> bool {
        self.changed.contains(member)
    }
    pub(super) fn eligible(&self, member: &delivery::SessionIdentity, ordinary: bool) -> bool {
        ordinary || self.contains(member)
    }
    pub(super) fn prepared(&mut self) {
        self.restore = false;
    }
}
impl Drop for Notice<'_> {
    fn drop(&mut self) {
        if self.restore {
            self.shared.remote_catalogued.store(true, Ordering::Relaxed);
        }
    }
}

pub(super) fn prepare<'a>(
    store: &ai_hist::SessionStore,
    state: &mut Members,
    members: &[delivery::SessionIdentity],
    shared: &'a Shared,
) -> anyhow::Result<Notice<'a>> {
    member_safety::locate(store, state, members)?;
    self::members(store, members, &state.locators, shared)
}

/// A completed listing needs to invalidate remote File(None) members too:
/// their Unknown stamp cannot move. No local file gains another polling path.
pub(super) fn members<'a>(
    store: &ai_hist::SessionStore,
    members: &[delivery::SessionIdentity],
    locators: &HashMap<delivery::SessionIdentity, Locator>,
    shared: &'a Shared,
) -> anyhow::Result<Notice<'a>> {
    let pending = shared.remote_catalogued.swap(false, Ordering::Relaxed);
    let mut notice = Notice {
        changed: HashSet::new(),
        shared,
        restore: pending,
    };
    if pending {
        for member in members
            .iter()
            .filter(|member| !matches!(locators.get(*member), Some(Locator::File(Some(_)))))
        {
            if super::super::remote_sources::observed(store, &member.source, &member.session_id)? {
                notice.changed.insert(member.clone());
            }
        }
    }
    Ok(notice)
}

#[cfg(test)]
mod tests;
