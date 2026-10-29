//! Observing spawned agents: what each one is doing, and reclaiming the
//! place of one seen to have ended, reporting what it left unfinished.

use super::handover;
use super::lifecycle::{self, Transition};
use super::observe::Watched;
use super::wire::Reclaimed;
use crate::relay::daemon::Core;
use crate::relay::state::{Level, Listing, ProcessLiveness};
use crate::relay::store::Target;
use chrono::Utc;
use std::collections::HashSet;
use std::time::Instant;

/// How many reclaimed places the live advertisement lists.
pub(super) const RECLAIMED_KEPT: usize = 8;

/// The activity line for an agent seen to have ended unreleased.
pub fn ended_line(name: &str, turn_in_progress: bool, pending: Option<u32>) -> String {
    let mut line =
        format!("Spawned agent @{name} is no longer running; its place here is free again.");
    match (turn_in_progress, pending.unwrap_or(0)) {
        (false, 0) => {}
        (true, 0) => line.push_str(" It ended in the middle of a turn."),
        (false, 1) => line.push_str(" 1 message to it was not taken."),
        (false, n) => line.push_str(&format!(" {n} messages to it were not taken.")),
        (true, 1) => line.push_str(" It ended in the middle of a turn, with 1 message not taken."),
        (true, n) => line.push_str(&format!(
            " It ended in the middle of a turn, with {n} messages not taken."
        )),
    }
    line
}

impl Core {
    /// What each spawned agent's harness last said of its turn, by name.
    pub(crate) fn spawned_work(
        &self,
    ) -> std::collections::HashMap<String, crate::relay::state::WorkState> {
        let ledger = self.ledger();
        let state = ledger.lock();
        state
            .agents
            .iter()
            .filter_map(|(name, record)| Some((name.clone(), record.work?.state)))
            .collect()
    }

    /// The spawned agents present on the relay: every one not seen to have
    /// ended. One not yet observed keeps what it had, so a restart does
    /// not bring back an agent already gone. Asks for a fresh look when
    /// one is due.
    pub(crate) fn spawned_live(&self) -> HashSet<Target> {
        self.schedule_spawn_observation(false);
        let ledger = self.ledger();
        let state = ledger.lock();
        self.spawned_registrations()
            .into_iter()
            .filter(
                |r| match state.agents.get(&r.name).and_then(|a| a.process) {
                    Some(seen) => seen.state != ProcessLiveness::Exited,
                    None => r.missing_since.is_none(),
                },
            )
            .map(|r| r.target)
            .collect()
    }

    /// Starts an observation pass in the background when one is due (or
    /// `now`) and none runs.
    pub(super) fn schedule_spawn_observation(&self, now: bool) {
        let Some(core) = self.arc() else {
            return;
        };
        if tokio::runtime::Handle::try_current().is_err() || self.spawned_registrations().is_empty()
        {
            return;
        }
        {
            let ledger = self.ledger();
            let mut state = ledger.lock();
            let due = now
                || state
                    .observed
                    .is_none_or(|at| at.elapsed() >= lifecycle::OBSERVE_EVERY);
            if state.observing || !due {
                return;
            }
            state.observing = true;
        }
        tokio::spawn(async move { core.observe_spawned().await });
    }

    /// Looks at every spawned agent, records what was seen, and reclaims
    /// the place of each one seen to have ended, reporting what it left
    /// unfinished. After a restart this is the reconciliation: nothing is
    /// reclaimed before it.
    pub(crate) async fn observe_spawned(&self) {
        let registrations = self.spawned_registrations();
        // A core that started again takes up a spawned Claude's pending
        // requests, which its own output still holds.
        for registration in &registrations {
            self.watch_spawned_claude(registration);
        }
        let spawner = self.plugins.spawner.clone();
        let observer = self.observer();
        let watched: Vec<Watched> = registrations
            .iter()
            .map(|r| Watched {
                name: r.name.clone(),
                target: r.target.clone(),
                process: r.spawn.as_ref().and_then(|spawn| spawn.process),
                alive: false,
            })
            .collect();
        let taken_over = handover::taken_over_times(&registrations);
        let (observed, adopted) = tokio::task::spawn_blocking(move || {
            handover::observe(spawner.as_ref(), observer.as_ref(), watched, &taken_over)
        })
        .await
        .unwrap_or_default();
        self.adopt(&adopted);
        let now = Utc::now();
        let ledger = self.ledger();
        let (mut ended, mut places, mut shown) = (Vec::new(), false, false);
        {
            let mut state = ledger.lock();
            state.observing = false;
            state.observed = Some(Instant::now());
            if observed.len() == registrations.len() {
                for (registration, observation) in registrations.iter().zip(observed) {
                    let record = state.agents.entry(registration.name.clone()).or_default();
                    let before = (
                        record.process.map(|p| p.state),
                        record.work.map(|w| w.state),
                    );
                    let transition = record.apply(observation, now);
                    shown |= before != (Some(observation.process), Some(observation.work));
                    match transition {
                        Transition::Ended { turn_in_progress } => {
                            let unfinished = record.unfinished.clone().unwrap_or_default();
                            state.reclaimed.retain(|r| r.name != registration.name);
                            state.reclaimed.push_front(Reclaimed {
                                name: registration.name.clone(),
                                agent_id: registration.agent_id.clone(),
                                unfinished,
                            });
                            state.reclaimed.truncate(RECLAIMED_KEPT);
                            ended.push((registration.clone(), turn_in_progress));
                            places = true;
                        }
                        Transition::Revived => {
                            state.reclaimed.retain(|r| r.name != registration.name);
                            places = true;
                        }
                        Transition::Unchanged => {}
                    }
                }
            }
            let names: HashSet<&str> = registrations.iter().map(|r| r.name.as_str()).collect();
            state.agents.retain(|name, _| names.contains(name.as_str()));
        }
        if places {
            self.spawn_places_changed();
        }
        if shown || places {
            self.hub.invalidated(Listing::Agents);
        }
        for (registration, turn_in_progress) in ended {
            // What it was sent and never took stays in its Relaycast queue.
            let pending = self
                .waiting_deliveries(&registration)
                .await
                .ok()
                .map(|n| n as u32);
            {
                let mut state = ledger.lock();
                if let Some(unfinished) = state
                    .agents
                    .get_mut(&registration.name)
                    .and_then(|record| record.unfinished.as_mut())
                {
                    unfinished.pending_deliveries = pending;
                }
                for reclaimed in state
                    .reclaimed
                    .iter_mut()
                    .filter(|r| r.name == registration.name)
                {
                    reclaimed.unfinished.pending_deliveries = pending;
                }
            }
            self.hub.activity(
                if turn_in_progress || pending.unwrap_or(0) > 0 {
                    Level::Warning
                } else {
                    Level::Info
                },
                ended_line(&registration.name, turn_in_progress, pending),
            );
            self.hub.invalidated(Listing::Agents);
            ledger.changed.notify_one();
        }
    }
}
