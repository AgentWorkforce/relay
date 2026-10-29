//! Bounded independent presentation discovery. Reads request work; they never
//! wait for a provider, and a held provider owns only its own single task.
use super::*;
use crate::relay::sessions::SessionPartition;
use std::sync::{LockResult, Mutex, MutexGuard};
use std::time::Duration;
use tokio::task::JoinSet;
use tokio::time::Instant as Deadline;

/// Cached rows and coalesced presentation demand share the core's lifetime.
#[derive(Default)]
pub(crate) struct PresentationSnapshot {
    rows: Mutex<(u64, Vec<DiscoveredSession>)>,
    demand: PresentationDemand,
}
impl PresentationSnapshot {
    pub(crate) fn lock(&self) -> LockResult<MutexGuard<'_, (u64, Vec<DiscoveredSession>)>> {
        self.rows.lock()
    }
    pub(super) fn request(&self) {
        self.demand.request();
    }
}

#[derive(Default)]
struct PresentationDemand {
    last: Mutex<Option<Deadline>>,
    notify: tokio::sync::Notify,
}
impl PresentationDemand {
    pub(super) fn request(&self) {
        let mut last = self.last.lock().unwrap_or_else(|error| error.into_inner());
        if last.is_none_or(|last| last.elapsed() >= WATCH_EVERY) {
            *last = Some(Deadline::now());
            self.notify.notify_one();
        }
    }
}

struct Slot {
    partition: Option<SessionPartition>,
    due: Deadline,
    busy: bool,
    started: Deadline,
    requested: bool,
}
struct Completed {
    slot: usize,
    generation: u64,
    found: Option<Vec<DiscoveredSession>>,
}

pub(super) async fn watch(core: Arc<Core>) {
    let mut stopping = core.shutdown_requested();
    let mut slots: Vec<_> = core
        .plugins
        .sessions
        .presentation_partitions()
        .into_iter()
        .map(|partition| Slot {
            partition: Some(partition),
            due: Deadline::now(),
            busy: false,
            started: Deadline::now() - WATCH_EVERY,
            requested: false,
        })
        .collect();
    // Shared fleet authority is refreshed once per cadence, independently of
    // provider work. Registration still reads every broker fresh/fail closed.
    slots.push(Slot {
        partition: None,
        due: Deadline::now(),
        busy: false,
        started: Deadline::now() - WATCH_EVERY,
        requested: false,
    });
    let mut jobs = JoinSet::new();
    let mut authority_ready = false;
    let mut housekeeping = JoinSet::new();
    housekeeping.spawn(maintain(core.clone()));
    loop {
        if core.stopping() {
            break;
        }
        start_due(&core, &mut slots, &mut jobs, authority_ready);
        let next = slots
            .iter()
            .filter(|slot| !slot.busy && (authority_ready || slot.partition.is_none()))
            .map(|slot| slot.due)
            .min()
            .unwrap_or_else(|| Deadline::now() + Duration::from_secs(3600));
        tokio::select! {
            _ = stopping.wait_for(|stop| *stop) => break,
            _ = tokio::time::sleep_until(next) => {},
            _ = core.session_snapshot.demand.notify.notified() => {
                // Demand can shorten the post-completion sleep after a slow
                // read, but never start a domain more often than the idle rate.
                wake_stale(&mut slots);
            },
            Some(result) = jobs.join_next(), if !jobs.is_empty() => {
                if let Ok(done) = result {
                    let slot = &mut slots[done.slot];
                    slot.busy = false;
                    slot.due = if slot.requested { Deadline::now() } else { Deadline::now() + WATCH_EVERY };
                    slot.requested = false;
                    if slot.partition.is_none() { authority_ready = true; }
                    publish(&core, slot.partition, done);
                }
            },
        }
    }
    // Dropping JoinSets cancels async supervisors. A running blocking call
    // cannot be forcibly stopped; at most one per fixed domain remains, and
    // no replacement is started after shutdown.
}

fn wake_stale(slots: &mut [Slot]) {
    for slot in slots {
        if slot.started.elapsed() >= WATCH_EVERY {
            if slot.busy {
                slot.requested = true;
            } else {
                slot.due = Deadline::now();
            }
        }
    }
}

fn start_due(
    core: &Arc<Core>,
    slots: &mut [Slot],
    jobs: &mut JoinSet<Completed>,
    authority_ready: bool,
) {
    for (index, slot) in slots.iter_mut().enumerate() {
        if slot.busy || slot.due > Deadline::now() || (!authority_ready && slot.partition.is_some())
        {
            continue;
        }
        slot.busy = true;
        slot.started = Deadline::now();
        let directory = core.plugins.sessions.clone();
        let partition = slot.partition;
        let generation = core
            .session_snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .0;
        jobs.spawn(async move {
            let found = tokio::task::spawn_blocking(move || match partition {
                Some(partition) => directory.discover_partition(partition),
                None => {
                    directory.refresh_presentation_authority();
                    None
                }
            })
            .await
            .unwrap_or(None);
            Completed {
                slot: index,
                generation,
                found,
            }
        });
    }
}

fn publish(core: &Arc<Core>, partition: Option<SessionPartition>, done: Completed) {
    let mut snapshot = core
        .session_snapshot
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut changed = false;
    if snapshot.0 == done.generation {
        if let (Some(partition), Some(mut found)) = (partition, done.found) {
            // A partition cannot erase or manufacture another provider's rows.
            found.retain(|row| partition.contains(&row.target));
            let previous = || {
                snapshot
                    .1
                    .iter()
                    .filter(|row| partition.contains(&row.target))
            };
            changed = previous().count() != found.len()
                || !previous()
                    .zip(&found)
                    .all(|(left, right)| same_presentation(left, right));
            if changed {
                snapshot.1.retain(|row| !partition.contains(&row.target));
                snapshot.1.extend(found);
            } else {
                // Timestamp-only progress remains readable without cloning or
                // sorting the whole listing or waking native clients.
                for (row, fresh) in snapshot
                    .1
                    .iter_mut()
                    .filter(|row| partition.contains(&row.target))
                    .zip(found)
                {
                    row.updated_at_ms = fresh.updated_at_ms;
                }
            }
        }
    }
    let before = snapshot.1.len();
    snapshot.1 = core
        .plugins
        .sessions
        .filter_presentation(std::mem::take(&mut snapshot.1));
    changed |= before != snapshot.1.len();
    if changed {
        snapshot
            .1
            .sort_by_key(|row| partition_order(SessionPartition::for_target(&row.target)));
        core.hub.invalidated(Listing::Sessions);
    }
}

fn same_presentation(left: &DiscoveredSession, right: &DiscoveredSession) -> bool {
    left.target == right.target
        && left.title == right.title
        && left.directory == right.directory
        && left.host == right.host
        && left.live == right.live
        && left.holder == right.holder
}

fn partition_order(partition: SessionPartition) -> u8 {
    match partition {
        SessionPartition::All => 0,
        SessionPartition::Codex => 1,
        SessionPartition::Claude => 2,
        SessionPartition::Grok => 3,
        SessionPartition::Muse => 4,
        SessionPartition::Pi => 5,
        SessionPartition::OpenCode => 6,
        SessionPartition::Devin => 7,
        SessionPartition::CursorCli => 8,
        SessionPartition::OpenClaw => 9,
        SessionPartition::Hermes => 10,
    }
}

async fn maintain(core: Arc<Core>) {
    let mut sessions = None;
    let mut fleet = None;
    loop {
        // Keep the old registration/project/fleet shape comparison cadence;
        // internal reads never request another provider pass.
        compare(&core, &mut sessions, &mut fleet).await;
        let config = core.config();
        let env = |key: &str| config.env.get(key).cloned();
        let codex = crate::relay::codex::CodexConfig::from_env(&env, &config.home);
        let _ = tokio::task::spawn_blocking(move || {
            crate::relay::codex::cleanup_expired_queue(&codex, crate::relay::state::now_ms())
        })
        .await;
        tokio::time::sleep(WATCH_EVERY).await;
    }
}
async fn compare(core: &Arc<Core>, sessions: &mut Option<Value>, fleet: &mut Option<Value>) {
    let listed =
        sessions_shape(&serde_json::to_value(cached_sessions_list(core).await).unwrap_or_default());
    if sessions.as_ref().is_none_or(|previous| *previous != listed) {
        core.hub.invalidated(Listing::Sessions);
    }
    *sessions = Some(listed);
    let listed =
        fleet_shape(&serde_json::to_value(this_fleet(core).list().await).unwrap_or_default());
    if fleet.as_ref().is_some_and(|previous| *previous != listed) {
        core.hub.invalidated(Listing::Fleet);
    }
    *fleet = Some(listed);
}

#[cfg(test)]
mod tests;
