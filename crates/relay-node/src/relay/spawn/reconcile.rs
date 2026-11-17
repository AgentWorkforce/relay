//! Observing spawned agents: what each one is doing, and reclaiming the
//! place of one seen to have ended, reporting what it left unfinished.

use super::handover;
use super::lifecycle::{self, Transition};
use super::observe::Watched;
use super::wire::Reclaimed;
use crate::relay::daemon::Core;
use crate::relay::state::{Level, Listing, ProcessLiveness, WorkState};
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

    /// The spawned agents this core has seen end (a Codex thread ends when
    /// it is archived), by name.
    pub(crate) fn spawned_seen_ended(&self) -> HashSet<String> {
        let ledger = self.ledger();
        let state = ledger.lock();
        state
            .agents
            .iter()
            .filter(|(_, record)| !record.holds_slot())
            .map(|(name, _)| name.clone())
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
        // Read before the ledger lock: a turn mark is a file, and the lock
        // is only the clock. The stop below reads the file again.
        let idle_samples: Vec<crate::relay::harness::grok::IdleSample> = registrations
            .iter()
            .map(|registration| self.grok_idle_sample(registration))
            .collect();
        let ledger = self.ledger();
        let (mut ended, mut idle_leaders, mut places, mut shown) =
            (Vec::new(), Vec::new(), false, false);
        {
            let mut state = ledger.lock();
            state.observing = false;
            state.observed = Some(Instant::now());
            if observed.len() == registrations.len() {
                for ((registration, observation), sample) in
                    registrations.iter().zip(observed).zip(idle_samples)
                {
                    // The record borrow ends with this block. The match
                    // below borrows `state` again to record a reclaimed place.
                    let (transition, unfinished) = {
                        let record = state.agents.entry(registration.name.clone()).or_default();
                        let before = (
                            record.process.map(|p| p.state),
                            record.work.map(|w| w.state),
                        );
                        let transition = record.apply(observation, now);
                        shown |= before != (Some(observation.process), Some(observation.work));
                        // A spawned Grok leader is its own process and does not
                        // exit when its client does. One quietly idle for
                        // GROK_LEADER_IDLE is ended below. A new turn mark, or
                        // any other state including unknown work, starts the
                        // clock over.
                        let quietly_idle = observation.process == ProcessLiveness::Running
                            && observation.work == WorkState::Idle
                            && !observation.turn_in_progress;
                        if is_grok_leader(registration) && quietly_idle {
                            if sample == crate::relay::harness::grok::IdleSample::Unreadable {
                                // A failed read is not a quiet stretch. Ending
                                // on it could stop a leader whose turn is running.
                                record.idle_since = None;
                                record.idle_mark = None;
                            } else {
                                let seen_mark = match sample {
                                    crate::relay::harness::grok::IdleSample::Seen(turn) => {
                                        turn.mark
                                    }
                                    _ => None,
                                };
                                let (since, mark) = lifecycle::note_grok_idle(
                                    record.idle_since,
                                    record.idle_mark,
                                    seen_mark,
                                    now,
                                );
                                record.idle_since = since;
                                record.idle_mark = mark;
                                if since.is_some_and(|since| {
                                    lifecycle::grok_leader_idle_due(since, now)
                                }) {
                                    idle_leaders.push((registration.clone(), mark));
                                }
                            }
                        } else {
                            record.idle_since = None;
                            record.idle_mark = None;
                        }
                        (transition, record.unfinished.clone())
                    };
                    match transition {
                        Transition::Ended { turn_in_progress } => {
                            state.reclaimed.retain(|r| r.name != registration.name);
                            state.reclaimed.push_front(Reclaimed {
                                name: registration.name.clone(),
                                agent_id: registration.agent_id.clone(),
                                unfinished: unfinished.unwrap_or_default(),
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
            // Its launch is over: so is its relaygate registration, and
            // only that launch's (a new launch may hold the name by now).
            // An answer it still owes goes out with that registration, so
            // it is kept until the agent leaves (`unregister_archived`,
            // after the answer or its wait), which releases it then.
            if let Some(spawn) = &registration.spawn {
                self.release_ended_launch_gate(
                    &registration.name,
                    &spawn.invocation_id,
                    &registration.agent_id,
                )
                .await;
            }
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
        for (registration, mark) in idle_leaders {
            // A message still queued, or a final answer still owed, keeps
            // the leader. A queue that cannot be read keeps it too: ending
            // it then could drop work. The clock stays, so the next pass
            // ends it once the queue is empty.
            let owes = self.store.read(|store| {
                store.replies.iter().flatten().any(|reply| {
                    reply.agent_id == registration.agent_id && reply.claimed != Some(true)
                })
            });
            if owes {
                continue;
            }
            if self
                .waiting_deliveries(&registration)
                .await
                .ok()
                .filter(|pending| *pending == 0)
                .is_none()
            {
                continue;
            }
            let name = registration.name.clone();
            // The queue read can take long enough for a turn to start, or
            // for Relaycast to accept another message. Ending checks the
            // turn and the queue again once it holds the delivery lock.
            if let Err(error) = self
                .end_idle_grok_leader(&name, &registration.agent_id, mark)
                .await
            {
                self.hub.activity(
                    Level::Warning,
                    format!(
                        "Spawned Grok leader @{name} has been idle for 24 hours, but Agent Relay could not end it: {}. It will try again.",
                        error.message
                    ),
                );
            }
        }
    }

    /// The session log of a spawned Grok leader. Other agents are absent:
    /// their idle stretch is not this clock.
    fn grok_idle_sample(
        &self,
        registration: &crate::relay::store::Registration,
    ) -> crate::relay::harness::grok::IdleSample {
        if !is_grok_leader(registration) {
            return crate::relay::harness::grok::IdleSample::Absent;
        }
        crate::relay::harness::grok::idle_sample(
            &self.grok_record_folder(),
            &registration.target.id,
        )
    }

    fn grok_record_folder(&self) -> std::path::PathBuf {
        self.config.app_data_dir.join("spawned-agents/grok")
    }
}

/// A spawned Grok this core still runs. A taken-over leader is the person's.
fn is_grok_leader(registration: &crate::relay::store::Registration) -> bool {
    registration.spawn.as_ref().is_some_and(|spawn| {
        spawn.harness == crate::relay::harness::grok::ID.name()
            && spawn.taken_over_at.is_none()
            && registration.target.kind == crate::relay::store::SessionKind::Grok
    })
}
