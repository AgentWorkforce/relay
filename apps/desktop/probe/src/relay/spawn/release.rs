//! Answering the node's release invocations: ending a spawned agent here,
//! with the result Relaycast passes back to Cloud.
//!
//! A release forgets the agent only once its end is confirmed: its process
//! gone, or its Codex thread archived. One that could not be ended keeps its
//! registration, name and place, and the release fails so it can be asked
//! again, rather than leave an agent working that nothing here lists.

use super::wire::{self, ReleaseRequest};
use crate::relay::daemon::Core;
use crate::relay::state::{Level, Listing};
use crate::relay::store::Registration;
use serde_json::Value;
use std::sync::Arc;

impl Core {
    /// Ends a spawned agent Cloud released. Relaycast completes the release
    /// itself from the result, so nothing is deregistered here.
    pub(super) async fn answer_release(self: Arc<Core>, request: ReleaseRequest) -> Value {
        let _agent = self
            .ledger()
            .actions
            .get(format!("agent/{}", request.name))
            .lock_owned()
            .await;
        let found = self.store.read(|store| {
            store
                .registrations
                .iter()
                .find(|r| r.name == request.name && r.spawn.is_some())
                .cloned()
        });
        let Some(registration) = found else {
            // Nothing of it is left here: released already.
            return wire::action_output(&request.invocation_id, wire::released(&request.name));
        };
        if request
            .expected_agent_id
            .as_ref()
            .is_some_and(|expected| *expected != registration.agent_id)
        {
            return wire::action_error(
                &request.invocation_id,
                "release_failed: that agent is not the one on this computer",
            );
        }
        if self.preserve_spawn_completion(&registration).is_err() {
            return wire::action_error(
                &request.invocation_id,
                "release_failed: could not preserve the spawn receipt",
            );
        }
        let lock = self.agent_locks.get(&registration.name);
        let _delivering = lock.lock().await;
        // Listed until the result is sent: an inventory without it first
        // would make Relaycast take it for missing and fail the release.
        self.mark_releasing(&request.invocation_id, &registration);
        if let Err(reason) = self.end_spawned(&registration).await {
            self.unmark_releasing(&request.invocation_id);
            return wire::action_error(
                &request.invocation_id,
                &format!(
                    "release_failed: could not end @{}: {reason}",
                    registration.name
                ),
            );
        }
        if let Err(error) = self.store.update(|store| store.remove(&registration.name)) {
            self.unmark_releasing(&request.invocation_id);
            return wire::action_error(
                &request.invocation_id,
                &format!("release_failed: could not save the release: {error}"),
            );
        }
        self.forget_agent(&registration.name);
        self.forget_releasing(&registration.name);
        self.hub.update(|status| {
            status.push.remove(&registration.name);
        });
        self.hub.invalidated(Listing::Agents);
        self.hub.activity(
            Level::Info,
            format!("Agent Relay released @{}.", registration.name),
        );
        wire::action_output(&request.invocation_id, wire::released(&request.name))
    }

    /// Ends the agent and waits for its harness to confirm it. A session
    /// taken over runs in the person's own client: left alone.
    async fn end_spawned(&self, registration: &Registration) -> Result<(), String> {
        let Some(spawn) = registration.spawn.as_ref() else {
            return Ok(());
        };
        if spawn.taken_over_at.is_some() {
            return Ok(());
        }
        let spawner = self.plugins.spawner.clone();
        let (target, process) = (registration.target.clone(), spawn.process);
        tokio::task::spawn_blocking(move || spawner.release(&target, process.as_ref()))
            .await
            .unwrap_or_else(|_| Err("ending it stopped unexpectedly".into()))
    }
}
