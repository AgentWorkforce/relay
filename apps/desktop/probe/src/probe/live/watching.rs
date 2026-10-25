//! Coalescing and provider scope for the broad capture watcher.
use super::{collector, inventory, Shared, Trigger};
use ai_hist::Source;
use serde_json::json;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::mpsc,
    time::Instant,
};

/// A coalesced burst retains its provider identity until a sweep reads it.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Owed {
    pub(super) first: Instant,
    pub(super) sources: HashSet<Source>,
    pub(super) full: bool,
}
impl Owed {
    pub(super) fn sources(&self) -> Option<Vec<Source>> {
        (!self.full).then(|| {
            Source::ALL
                .iter()
                .copied()
                .filter(|source| self.sources.contains(source))
                .collect()
        })
    }
}

/// What the broad watcher sends the capture thread: when it noticed it, and
/// the path a write event named, or `None` when the watcher reported an
/// error and a write may have gone unreported.
pub(super) type Noticed = (Instant, Option<PathBuf>);

/// The filesystem watch over every path the store's own watch covers, and
/// what the thread last reported about how it is driven.
pub(super) struct Watching {
    pub(super) watch: Result<inventory::Watch, inventory::Unwatched>,
    events: mpsc::Sender<Noticed>,
    use_fs_events: bool,
    reported: Option<(&'static str, Option<&'static str>)>,
}
impl Watching {
    pub(super) fn start(db: &Path, events: mpsc::Sender<Noticed>, use_fs_events: bool) -> Self {
        let mut watching = Self {
            watch: Err(inventory::Unwatched::NoRoots),
            events,
            use_fs_events,
            reported: None,
        };
        if use_fs_events {
            watching.watch = watching.register(db);
        }
        watching
    }

    fn register(&self, db: &Path) -> Result<inventory::Watch, inventory::Unwatched> {
        let events = self.events.clone();
        inventory::Watch::start(db, move |path| {
            let _ = events.send((Instant::now(), path));
        })
    }

    /// Register afresh when that would watch something more: a provider root
    /// created since, or one whose registration failed. A watcher that
    /// cannot be replaced keeps the one already running.
    fn refresh(&mut self, db: &Path) {
        if !self.use_fs_events {
            return;
        }
        if self.watch.as_ref().is_ok_and(|watch| !watch.outdated(db)) {
            return;
        }
        match self.register(db) {
            Ok(watch) => self.watch = Ok(watch),
            Err(reason) if self.watch.is_err() => self.watch = Err(reason),
            Err(_) => {}
        }
    }

    /// Whether `noticed` owes a forced sweep: a write to a path some source
    /// reads, or a watcher error.
    fn owes(&self, noticed: &Noticed) -> bool {
        match (&self.watch, &noticed.1) {
            (Ok(watch), Some(path)) => watch.covers(path),
            (Ok(_), None) => true,
            (Err(_), _) => false,
        }
    }

    /// Fold one notice into what is owed: a write some source reads owes a
    /// forced sweep from when it was noticed, and a loss also asks for the
    /// watcher to be registered again.
    pub(super) fn fold(&self, noticed: Noticed, owed: &mut Option<Owed>, lost: &mut bool) {
        if self.owes(&noticed) {
            *lost |= noticed.1.is_none();
            let pending = owed.get_or_insert_with(|| Owed {
                first: noticed.0,
                sources: HashSet::new(),
                full: false,
            });
            match (&self.watch, noticed.1.as_deref()) {
                (Ok(watch), Some(path)) => {
                    let sources: Vec<_> = watch.sources(path).collect();
                    let unknown = sources.is_empty();
                    pending.sources.extend(sources);
                    // Directories/deletions may change roots or rename a subtree.
                    pending.full |= !path.is_file() || unknown;
                }
                _ => pending.full = true,
            }
        }
    }

    /// Fold everything queued into what is owed, as a sweep about to run
    /// reads it, and say what the sweep then is: an event's, forced, once
    /// anything is owed, else `trigger`.
    pub(super) fn drain(
        &self,
        received: &mpsc::Receiver<Noticed>,
        owed: &mut Option<Owed>,
        lost: &mut bool,
        trigger: Trigger,
    ) -> Trigger {
        while let Ok(noticed) = received.try_recv() {
            self.fold(noticed, owed, lost);
        }
        if owed.is_some() {
            Trigger::FsEvent
        } else {
            trigger
        }
    }

    /// Every full fallback adopts any provider roots that appeared, including
    /// directory/deletion notices as well as watcher losses and backstops.
    pub(super) fn prepare_sources(
        &mut self,
        db: &Path,
        pending: Option<&Owed>,
        full: bool,
    ) -> Option<Vec<Source>> {
        let sources = if full {
            None
        } else {
            pending.and_then(Owed::sources)
        };
        if sources.is_none() {
            self.refresh(db);
        }
        sources
    }

    /// Report the driver when it is first known or changes: with the time
    /// it started watching, and the reason whenever it polls.
    pub(super) fn observe(&mut self, shared: &Shared) {
        let now = match &self.watch {
            Ok(_) => ("fs-events", None),
            Err(_) if !self.use_fs_events => ("polling", Some("disabled")),
            Err(inventory::Unwatched::NoRoots) => ("polling", Some("no_provider_roots")),
            Err(inventory::Unwatched::Unavailable) => ("polling", Some("fs_events_unavailable")),
        };
        if self.reported == Some(now) {
            return;
        }
        self.reported = Some(now);
        let (name, reason) = now;
        shared.update(|state| {
            state.metrics.driver = Some(name);
            state.metrics.fallback_reason = reason;
            state
                .metrics
                .watching_since_ms
                .get_or_insert_with(collector::now);
        });
        eprintln!(
            "{}",
            json!({"operation":"capture","stage":"live_capture","mode":"watch","driver":name,"fallback_reason":reason})
        );
    }
}
