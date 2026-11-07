//! `agents.take_over`: stopping a spawned agent's headless process so the
//! person can resume its session, without a delivery starting a turn under
//! it and without a mark that outlives a process still running.
//!
//! The take over holds the agent's action lock (as a release does) and its
//! delivery lock (as a delivery does) from the last look at its turn until
//! its headless process is gone, so no message reaches the headless process
//! once the take over decided its turn was over. Observation passes pause
//! meanwhile, so the stop is not taken for the agent ending, and the agent
//! is marked taken over only once its process is gone: a core that stops
//! halfway leaves an agent not taken over, its process running or ended.

use super::{label, Observation, OPENING, POLL, STOP_WAIT, TURN_WAIT};
use crate::relay::contract::spawned::TakenOver;
use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::spawn::ledger::Ledger;
use crate::relay::spawn::lifecycle;
use crate::relay::spawn::observe::Watched;
use crate::relay::state::{Level, Listing, ProcessLiveness};
use crate::relay::store::Registration;
use chrono::Utc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// What a take over answered, once it has.
type Answer = Option<Result<TakenOver, RpcError>>;

/// A take over in progress, as the ledger keeps it.
pub(in crate::relay::spawn) struct TakingOver {
    /// Whether it is to stop the agent at once, in the middle of a turn.
    pub(in crate::relay::spawn) interrupt: bool,
    answer: watch::Receiver<Answer>,
}

impl Core {
    /// Hands `name`'s session to the person: see the module.
    pub(crate) async fn take_over(
        &self,
        name: &str,
        interrupt: bool,
        turn_wait: Duration,
    ) -> Result<TakenOver, RpcError> {
        let registration = self.spawned_named(name)?;
        if !is_taken_over(&registration) && !self.plugins.spawner.hands_over(&registration.target) {
            let label = registration.spawn.as_ref().map_or("agent", label);
            return Err(RpcError::new(
                ErrorKind::Refused,
                format!("A spawned {label} agent cannot be taken over; open its session in {label} instead."),
            ));
        }
        let claim = match self.claim_take_over(name, interrupt) {
            Ok(claim) => claim,
            Err(answer) => return self.joined_take_over(&registration, answer).await,
        };
        let answer = self.take_over_claimed(&registration, turn_wait).await;
        claim.answered(&answer);
        answer
    }

    async fn take_over_claimed(
        &self,
        registration: &Registration,
        turn_wait: Duration,
    ) -> Result<TakenOver, RpcError> {
        if is_taken_over(registration) {
            return Ok(self.taken_over(registration, false).await);
        }
        let name = &registration.name;
        let deadline = Instant::now() + turn_wait;
        let (registration, interrupted, _agent, _delivering) = loop {
            self.wait_for_turn(registration, deadline).await?;
            let agent = self
                .ledger()
                .actions
                .get(format!("agent/{name}"))
                .lock_owned()
                .await;
            let delivering = self.agent_locks.get(name).lock_owned().await;
            // Bind the delayed action to the exact agent selected before
            // waiting, and look again: a delivery may have started a turn.
            let current = self.unchanged_spawn(registration)?;
            if let Some(interrupted) = self.turn_over(&current).await {
                break (current, interrupted, agent, delivering);
            }
        };
        let taken = self.taken_over(&registration, interrupted).await;
        let paused = self.pause_observation().await;
        self.stop_headless(&registration).await?;
        // Gone: only now is it taken over. (Should saving fail, it is seen
        // to have ended.)
        self.change_spawn(name, |spawn| {
            spawn.taken_over_at = Some(lifecycle::iso(Utc::now()));
            spawn.process = None;
        })?;
        drop(paused);
        let label = registration.spawn.as_ref().map_or("agent", label);
        self.hub.activity(
            Level::Info,
            format!(
                "@{name} was taken over: Agent Relay stopped its headless {label}{}. It keeps its name, so messages reach the session you open.",
                if interrupted { " in the middle of a turn" } else { "" }
            ),
        );
        self.hub.invalidated(Listing::Agents);
        self.hub.invalidated(Listing::Sessions);
        Ok(taken)
    }

    /// The answer for a session handed over: where it runs.
    pub(super) async fn taken_over(
        &self,
        registration: &Registration,
        interrupted: bool,
    ) -> TakenOver {
        let spawner = self.plugins.spawner.clone();
        let target = registration.target.clone();
        let found = tokio::task::spawn_blocking(move || spawner.session(&target))
            .await
            .ok()
            .flatten();
        TakenOver {
            name: registration.name.clone(),
            target: registration.target.clone(),
            directory: found
                .and_then(|found| found.directory)
                .map(|directory| directory.display().to_string()),
            interrupted,
        }
    }

    /// Takes over `name` alone; when another take over of it runs, which
    /// an `interrupt` then asks to stop it at once, where it will answer.
    fn claim_take_over(
        &self,
        name: &str,
        interrupt: bool,
    ) -> Result<Claim, watch::Receiver<Answer>> {
        let ledger = self.ledger();
        let mut state = ledger.lock();
        if let Some(running) = state.taking_over.get_mut(name) {
            running.interrupt |= interrupt;
            return Err(running.answer.clone());
        }
        let (answer, receiver) = watch::channel(None);
        let running = TakingOver {
            interrupt,
            answer: receiver,
        };
        state.taking_over.insert(name.to_string(), running);
        drop(state);
        Ok(Claim {
            ledger,
            name: name.to_string(),
            answer,
        })
    }

    /// `expected` as it is now, unless it was replaced meanwhile.
    fn unchanged_spawn(&self, expected: &Registration) -> Result<Registration, RpcError> {
        let current = self.spawned_named(&expected.name)?;
        if current.agent_id != expected.agent_id || current.target != expected.target {
            return Err(RpcError::new(
                ErrorKind::Refused,
                format!(
                    "@{} changed while the take over was waiting. Select the agent again.",
                    expected.name
                ),
            ));
        }
        Ok(current)
    }

    /// Waits for the take over already running to finish, and answers as
    /// it did.
    async fn joined_take_over(
        &self,
        expected: &Registration,
        answer: watch::Receiver<Answer>,
    ) -> Result<TakenOver, RpcError> {
        let shared = tokio::time::timeout(TURN_WAIT + STOP_WAIT, answer_of(answer))
            .await
            .ok()
            .flatten();
        match shared {
            Some(Ok(taken)) => self.unchanged_spawn(expected).map(|_| taken),
            Some(Err(error)) => Err(error),
            // It ended without answering (or is still waiting).
            None => self.taken_over_or_busy(expected).await,
        }
    }

    async fn taken_over_or_busy(&self, expected: &Registration) -> Result<TakenOver, RpcError> {
        let registration = self.unchanged_spawn(expected)?;
        if is_taken_over(&registration) {
            return Ok(self.taken_over(&registration, false).await);
        }
        Err(still_busy(&registration.name))
    }

    /// Waits while a turn runs, until `deadline` passes or an interrupt is
    /// asked for.
    async fn wait_for_turn(
        &self,
        registration: &Registration,
        deadline: Instant,
    ) -> Result<(), RpcError> {
        while self.turn_over(registration).await.is_none() {
            if Instant::now() >= deadline {
                return Err(still_busy(&registration.name));
            }
            tokio::time::sleep(POLL).await;
        }
        Ok(())
    }

    /// Whether the agent may be stopped now: `Some(false)` with no turn
    /// running, `Some(true)` with one running that an interrupt was asked
    /// for, `None` while one runs otherwise.
    async fn turn_over(&self, registration: &Registration) -> Option<bool> {
        let seen = self.observe_now(registration).await;
        if seen.process == ProcessLiveness::Exited || !seen.turn_in_progress {
            return Some(false);
        }
        let ledger = self.ledger();
        let state = ledger.lock();
        let running = state.taking_over.get(&registration.name);
        running
            .is_some_and(|running| running.interrupt)
            .then_some(true)
    }

    /// One look at a spawned agent now.
    async fn observe_now(&self, registration: &Registration) -> Observation {
        let spawner = self.plugins.spawner.clone();
        let observer = self.observer();
        let target = registration.target.clone();
        let process = registration.spawn.as_ref().and_then(|spawn| spawn.process);
        let name = registration.name.clone();
        tokio::task::spawn_blocking(move || {
            let alive = spawner.alive(&target, process.as_ref());
            let agents = [Watched {
                name,
                target,
                process,
                alive,
            }];
            spawner
                .observe(&agents)
                .unwrap_or_else(|| observer.observe(&agents))
                .pop()
        })
        .await
        .ok()
        .flatten()
        .unwrap_or(OPENING)
    }

    /// Waits for an observation pass running to finish, and starts none
    /// until the pause is dropped.
    async fn pause_observation(&self) -> ObservationPaused {
        let ledger = self.ledger();
        loop {
            {
                let mut state = ledger.lock();
                if !state.observing {
                    state.observing = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        ObservationPaused(ledger)
    }

    /// Stops the headless process and waits for it to be gone.
    async fn stop_headless(&self, registration: &Registration) -> Result<(), RpcError> {
        let spawner = self.plugins.spawner.clone();
        let target = registration.target.clone();
        let process = registration.spawn.as_ref().and_then(|spawn| spawn.process);
        let stopped = tokio::task::spawn_blocking(move || {
            spawner.stop(&target, process.as_ref());
            let deadline = Instant::now() + STOP_WAIT;
            while spawner.alive(&target, process.as_ref()) {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(POLL);
            }
            true
        })
        .await
        .unwrap_or(false);
        if stopped {
            return Ok(());
        }
        let name = &registration.name;
        Err(RpcError::new(
            ErrorKind::Internal,
            format!("@{name} did not stop, so its session was not handed over. Try again."),
        ))
    }
}

/// What the take over `answer` is for answered; `None` when it ended
/// without answering.
async fn answer_of(mut answer: watch::Receiver<Answer>) -> Answer {
    let answered = answer.wait_for(Option::is_some).await.ok()?;
    answered.clone()
}

fn still_busy(name: &str) -> RpcError {
    RpcError::new(
        ErrorKind::Busy,
        format!("@{name} is still in the middle of a turn. Interrupt it to take it over now."),
    )
}

pub(super) fn is_taken_over(registration: &Registration) -> bool {
    registration
        .spawn
        .as_ref()
        .is_some_and(|spawn| spawn.taken_over_at.is_some())
}

/// A take over in progress; it ends when dropped.
struct Claim {
    ledger: Arc<Ledger>,
    name: String,
    answer: watch::Sender<Answer>,
}

impl Claim {
    /// Gives every take over that joined this one its answer.
    fn answered(&self, answer: &Result<TakenOver, RpcError>) {
        self.answer.send_replace(Some(answer.clone()));
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.ledger.lock().taking_over.remove(&self.name);
    }
}

/// Observation passes paused while held.
struct ObservationPaused(Arc<Ledger>);

impl Drop for ObservationPaused {
    fn drop(&mut self) {
        self.0.lock().observing = false;
    }
}
