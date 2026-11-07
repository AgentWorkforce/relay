//! Joining and taking over an agent Agent Relay spawned here, for the apps:
//! `agents.transcript` follows what it says from its own output, and
//! `agents.take_over` hands its session to the person.
//!
//! Exactly one process runs a session at any time. A take over waits for
//! the agent's turn to end (or interrupts it when asked), stops its
//! headless process, waits for it to be gone and only then marks the agent
//! taken over (`take_over`); only then do the apps resume the session in
//! Terminal or Claude Desktop. The
//! agent keeps its name, address and place on the spawn node. From then on
//! its process is whichever one its harness finds running the session
//! (`follow_sessions`), so delivery reaches the session the person opened,
//! and releasing the agent leaves that process running.

use super::lifecycle::Observation;
use super::observe::{Observe, Watched};
use crate::relay::contract::spawned::SessionSpawn;
use crate::relay::contract::transcript::{LocalTranscriptCursor, LocalTranscriptPage};
use crate::relay::contract::{answer, method};
use crate::relay::daemon::Core;
use crate::relay::harness::HarnessId;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::spawn::launch::{SpawnedProcess, Spawner};
use crate::relay::state::{ProcessLiveness, WorkState};
use crate::relay::store::{Registration, SpawnOrigin};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// How long a take over waits for a running turn to end.
pub const TURN_WAIT: Duration = Duration::from_secs(10 * 60);
/// How long a stopped agent gets to exit.
const STOP_WAIT: Duration = Duration::from_secs(if cfg!(test) { 1 } else { 15 });
const POLL: Duration = Duration::from_millis(500);
/// After a take over, how long the session may run nowhere (the person's
/// client still opening) before the agent counts as ended.
pub const OPENING_GRACE: chrono::Duration = chrono::Duration::minutes(2);

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    match method {
        method::AgentsTranscript::NAME => Some(
            answer::<method::AgentsTranscript, _>(raw, |request| async move {
                core.spawned_transcript(&request.name, request.cursor).await
            })
            .await,
        ),
        method::AgentsTakeOver::NAME => Some(
            answer::<method::AgentsTakeOver, _>(raw, |request| async move {
                core.take_over(&request.name, request.interrupt, TURN_WAIT)
                    .await
            })
            .await,
        ),
        _ => None,
    }
}

/// The product name of a spawned agent's harness.
fn label(spawn: &SpawnOrigin) -> &'static str {
    HarnessId::from_name(&spawn.harness).map_or("agent", HarnessId::label)
}

/// The agents taken over whose recorded process no longer runs, looked for
/// by their session: one found running is followed to that process (and
/// returned, to be saved); one not found within `OPENING_GRACE` of its take
/// over is returned in `opening`, its observation to be set aside, as the
/// person's client may still be opening it. `taken_over[i]` is when
/// `watched[i]` was taken over.
pub fn follow_sessions(
    spawner: &dyn Spawner,
    watched: &mut [Watched],
    taken_over: &[Option<DateTime<Utc>>],
    now: DateTime<Utc>,
) -> (Vec<(String, SpawnedProcess)>, Vec<usize>) {
    let (mut adopted, mut opening) = (Vec::new(), Vec::new());
    for (index, (agent, at)) in watched.iter_mut().zip(taken_over).enumerate() {
        let Some(at) = at.filter(|_| !agent.alive) else {
            continue;
        };
        match spawner.session(&agent.target) {
            Some(found) => {
                agent.process = Some(found.process);
                agent.alive = spawner.alive(&agent.target, agent.process.as_ref());
                adopted.push((agent.name.clone(), found.process));
            }
            None if now - at < OPENING_GRACE => opening.push(index),
            None => {}
        }
    }
    (adopted, opening)
}

/// When each registration was taken over, if it was.
pub fn taken_over_times(registrations: &[Registration]) -> Vec<Option<DateTime<Utc>>> {
    registrations
        .iter()
        .map(|r| r.spawn.as_ref()?.taken_over_at.as_deref()?.parse().ok())
        .collect()
}

/// One look at each spawned agent, as `observe_spawned` takes it: whether it
/// runs, a session taken over followed to the client running it, and what
/// it is doing. Returns the observations, in order, and the processes
/// `follow_sessions` adopted.
pub fn observe(
    spawner: &dyn Spawner,
    observer: &dyn Observe,
    watched: Vec<Watched>,
    taken_over: &[Option<DateTime<Utc>>],
) -> (Vec<Observation>, Vec<(String, SpawnedProcess)>) {
    let mut watched: Vec<Watched> = watched
        .into_iter()
        .map(|w| Watched {
            alive: spawner.alive(&w.target, w.process.as_ref()),
            ..w
        })
        .collect();
    let (adopted, opening) = follow_sessions(spawner, &mut watched, taken_over, Utc::now());
    let mut observed = spawner
        .observe(&watched)
        .unwrap_or_else(|| observer.observe(&watched));
    for index in opening {
        if let Some(observation) = observed.get_mut(index) {
            *observation = OPENING;
        }
    }
    (observed, adopted)
}

/// Nothing known: what an agent whose client is still opening shows.
pub const OPENING: Observation = Observation {
    process: ProcessLiveness::Unknown,
    work: WorkState::Unknown,
    turn_in_progress: false,
};

impl Core {
    /// What `sessions.list` says may be done with a spawned registration.
    pub(crate) fn session_spawn(&self, registration: &Registration) -> Option<SessionSpawn> {
        let spawn = registration.spawn.as_ref()?;
        let taken_over = take_over::is_taken_over(registration);
        Some(SessionSpawn {
            harness: spawn.harness.clone(),
            can_take_over: !taken_over && self.plugins.spawner.hands_over(&registration.target),
            taken_over,
        })
    }

    /// Saves the processes `follow_sessions` found running taken-over
    /// sessions.
    pub(super) fn adopt(&self, adopted: &[(String, SpawnedProcess)]) {
        for (name, process) in adopted {
            let _ = self.change_spawn(name, |spawn| spawn.process = Some(*process));
        }
    }

    /// The spawned agent named `name`.
    fn spawned_named(&self, name: &str) -> Result<Registration, RpcError> {
        let registration = self.store.read(|store| {
            store
                .registrations
                .iter()
                .find(|r| r.name == name && r.archived_at.is_none())
                .cloned()
        });
        let registration = registration.ok_or_else(|| {
            RpcError::new(
                ErrorKind::NotFound,
                format!("@{name} is not an agent on this computer."),
            )
        })?;
        if registration.spawn.is_none() {
            return Err(RpcError::new(
                ErrorKind::Refused,
                format!("Agent Relay did not spawn @{name}; open its session instead."),
            ));
        }
        Ok(registration)
    }

    fn change_spawn(
        &self,
        name: &str,
        change: impl FnOnce(&mut SpawnOrigin),
    ) -> Result<(), RpcError> {
        self.store
            .update(|store| {
                let spawn = store
                    .registrations
                    .iter_mut()
                    .find(|r| r.name == name)
                    .and_then(|r| r.spawn.as_mut());
                if let Some(spawn) = spawn {
                    change(spawn);
                }
            })
            .map_err(|error| {
                RpcError::new(
                    ErrorKind::StoreFailed,
                    format!("Could not save @{name}: {error}"),
                )
            })
    }

    pub(crate) async fn spawned_transcript(
        &self,
        name: &str,
        cursor: Option<LocalTranscriptCursor>,
    ) -> Result<LocalTranscriptPage, RpcError> {
        let registration = self.spawned_named(name)?;
        let spawner = self.plugins.spawner.clone();
        let page = tokio::task::spawn_blocking(move || {
            spawner.transcript(&registration.target, cursor.as_ref())
        })
        .await
        .ok()
        .flatten();
        match page {
            Some(Ok(page)) => Ok(page),
            Some(Err(error)) => Err(RpcError::new(
                ErrorKind::Internal,
                format!("Could not read the transcript of @{name}: {error}"),
            )),
            None => Err(RpcError::new(
                ErrorKind::Refused,
                format!("@{name} keeps no transcript of its own; read its session's."),
            )),
        }
    }
}

mod take_over;
#[cfg(test)]
mod tests;

pub(super) use take_over::TakingOver;
