//! Validated startup handoff before live event capture and historical work.
use super::*;

/// The handoff from validated startup roots to the event scheduler.
pub(in crate::live) struct Started {
    pub(in crate::live) store: ai_hist::SessionStore,
    pub(in crate::live) roots: history::RootSettings,
    pub(in crate::live) watch: Watching,
}

pub(in crate::live) fn start(
    mut store: ai_hist::SessionStore,
    events: mpsc::Sender<Noticed>,
    cancelled: &Arc<AtomicBool>,
    shared: &Shared,
    options: &LiveOptions,
) -> Option<Started> {
    let mut roots = history::RootSettings::default();
    while !stopping(cancelled) {
        let checked = roots.last_checked();
        match roots.refresh(&mut store) {
            Ok(_) => {
                // Arm only the validated snapshot, then retain it in the
                // scheduler. Its first refresh is no longer a policy reset
                // that could discard a notice admitted after readiness.
                let mut watch =
                    Watching::start_roots(&store, &roots, events, options.use_fs_events);
                watch.observe(shared);
                return Some(Started {
                    store,
                    roots,
                    watch,
                });
            }
            Err(error) => {
                if roots.last_checked() != checked {
                    shared.judge(Some(collector::capture_error_class(&error).into()));
                }
                // A malformed/unreadable sharing snapshot must not publish a
                // watcher or acquire anything through the unvalidated store.
                std::thread::sleep(STOP_POLL);
            }
        }
    }
    None
}

/// Retry opening the store with pacing; a transient failure must not leave
/// this run permanently doing uncapped whole-source timer sweeps.
fn open(
    db: &Path,
    cancelled: &Arc<AtomicBool>,
    shared: &Shared,
    options: &LiveOptions,
) -> Option<ai_hist::SessionStore> {
    while !stopping(cancelled) {
        let started = Instant::now();
        match history::open(db) {
            Ok(store) => return Some(store),
            Err(error) => shared.judge(Some(collector::capture_error_class(&error).into())),
        }
        let due = Instant::now() + gap(started.elapsed(), options).max(options.backstop);
        while !stopping(cancelled) && Instant::now() < due {
            std::thread::sleep(STOP_POLL);
        }
    }
    None
}

pub(in crate::live) fn capture(
    directory: &Path,
    history_url: &str,
    cancelled: &Arc<AtomicBool>,
    shared: &Arc<Shared>,
    options: &LiveOptions,
) {
    shared.update(|state| state.metrics.mode = Some("watch"));
    let db = directory.join("history.db");
    let Some(store) = open(&db, cancelled, shared, options) else {
        return;
    };
    let progress = Some(crate::progress::Monitor::start(
        directory,
        history_url,
        None,
        false,
    ));
    let (events, received) = mpsc::channel();
    let Some(Started {
        store,
        roots,
        watch,
    }) = start(store, events, cancelled, shared, options)
    else {
        return;
    };
    let _remote = super::remote(
        store.clone(),
        cancelled.clone(),
        shared.clone(),
        options.backstop,
    );
    let last = Swept {
        ended: Instant::now(),
        took: Duration::ZERO,
    };
    super::follow(
        super::Context {
            directory,
            store,
            watch,
            received: &received,
            last,
            cancelled,
            shared,
            options,
            progress,
        },
        roots,
    );
}
