//! Answering the node's invocations: spawning an agent here, or releasing
//! one, with the result Relaycast passes back to Cloud.

use super::actions::CompletedSpawn;
use super::completions::{self, Scope};
use super::intents::{self, InFlight, Intent};
use super::launch::{Launch, LaunchError};
use super::ledger::Starting;
use super::node::NodeLink;
use super::report_back::{self, ReportBack};
use super::unanswered::Unanswered;
use super::wire::{self, HarnessId, InventoryAgent, SpawnFailure, SpawnRequest};
use super::{first_text, lifecycle, session_ref, SpawnSettings};
use crate::relay::daemon::Core;
use crate::relay::push::PushState;
use crate::relay::state::{Level, Listing, SpawnState};
use crate::relay::workspace::Secret;
use chrono::Utc;
use launching::LaunchFailure;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

mod error;
mod launching;
use error::refusal;
pub(super) use error::SpawnError;

pub(super) const REGISTER_TIMEOUT: Duration = Duration::from_secs(10);

// A timed-out filesystem call cannot be cancelled. Its permit stays with the
// worker until it finishes, so retries cannot fill Tokio's blocking pool.
static DIRECTORY_CHECKS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

/// Relaycast's refusal of `agent.register`, as Cloud reads it.
pub(super) fn register_error(code: &str, message: &str) -> String {
    match code {
        "agent_already_exists" | "agent_name_in_use" => {
            format!("spawn_agent_name_in_use: {message}")
        }
        "node_capacity_exceeded" => format!("spawn_capacity_exceeded: {message}"),
        _ => format!("spawn_failed: {message}"),
    }
}

impl Core {
    pub(super) async fn answer_spawn(
        self: Arc<Core>,
        link: NodeLink,
        request: SpawnRequest,
    ) -> Value {
        self.hub.activity(
            Level::Info,
            format!(
                "Agent Relay received spawn {} for @{} ({}) on {}.",
                request.invocation_id, request.name, request.harness, link.node.node_name
            ),
        );
        match self.spawn_agent(&link, &request).await {
            Ok(output) => wire::action_output(&request.invocation_id, output),
            Err(error) => {
                if let Some(cleanup) = self.ledger().lock().failed.get_mut(&request.invocation_id) {
                    if cleanup.error.is_none()
                        && cleanup.intent.name == request.name
                        && cleanup.intent.harness == request.harness
                    {
                        cleanup.error = Some(error.clone());
                    }
                }
                let message = format!(
                    "Agent Relay could not spawn @{} here (invocation {}): {}",
                    request.name,
                    request.invocation_id,
                    error.text()
                );
                crate::relay::diagnostics::write(format_args!("{message}"));
                self.hub.activity(Level::Warning, message);
                error.result(&request.invocation_id, &link)
            }
        }
    }

    fn harness_unavailable(
        &self,
        link: &NodeLink,
        harness: HarnessId,
        message: String,
    ) -> SpawnError {
        refusal(
            link,
            harness,
            wire::HARNESS_UNAVAILABLE,
            crate::relay::harness::diagnostics::redact(&message),
        )
    }

    pub(super) async fn spawn_agent(
        &self,
        link: &NodeLink,
        request: &SpawnRequest,
    ) -> Result<Value, SpawnError> {
        let workspace = self
            .workspace()
            .ok_or("spawn_failed: no Agent Relay workspace")?;
        let scope = Scope::workspace(&workspace);
        let ledger = self.ledger();
        // Always invocation before name: a replay observes the first launch's
        // result, and a release cannot acknowledge it before it is saved.
        let mut invocation = ledger
            .actions
            .get(scope.lock_key(&request.invocation_id))
            .lock_owned()
            .await;
        if let Some(completed) = invocation.as_ref() {
            return completed.replay(request);
        }
        if let Some(cleanup) = ledger
            .lock()
            .failed
            .get(&request.invocation_id)
            .filter(|cleanup| {
                super::recover::of_workspace(cleanup.intent.clone(), &workspace).is_some()
            })
        {
            if cleanup.intent.name != request.name || cleanup.intent.harness != request.harness {
                return Err(
                    "spawn_invalid_input: invocation belongs to another failed launch".into(),
                );
            }
            if let Some(error) = &cleanup.error {
                return Err(error.clone());
            }
        }
        if let Some(completed) = scope
            .load(&self.config.app_data_dir, &request.invocation_id)
            .map_err(|_| SpawnError::from("spawn_failed: could not read the saved spawn receipt"))?
        {
            return completed.replay(request);
        }
        let _agent = ledger
            .actions
            .get(format!("agent/{}", request.name))
            .lock_owned()
            .await;
        // A spawn Relaycast sends again answers as it did the first time,
        // over any connection and after a restart; the same invocation
        // asking for another agent is refused, never rebound.
        if let Some(saved) = self.store.read(|store| {
            store
                .registrations
                .iter()
                .find(|r| {
                    r.spawn.as_ref().is_some_and(|spawn| {
                        spawn.invocation_id == request.invocation_id
                            && scope.matches_registration(r)
                    })
                })
                .cloned()
        }) {
            let harness = saved
                .spawn
                .as_ref()
                .map_or("", |spawn| spawn.harness.as_str());
            if saved.name != request.name || harness != request.harness.name() {
                return Err(format!(
                    "spawn_invalid_input: invocation {} already spawned @{} ({harness})",
                    request.invocation_id, saved.name
                )
                .into());
            }
            let _ = self.preserve_spawn_completion(&saved);
            return Ok(completions::spawned_output(&saved));
        }
        let result = match self.spawn_agent_once(link, request).await {
            Ok(output) => match scope.save(&self.config.app_data_dir, request, output.clone()) {
                Ok(completion) => completion.replay(request),
                // The agent runs and its registration is saved, carrying the
                // invocation and its answer: a replay is answered from it, and
                // a release or removal saves the receipt before forgetting it.
                // Reporting a failure here would leave Cloud a worker it
                // believes never started.
                Err(error) => {
                    self.hub.activity(
                        Level::Warning,
                        format!(
                            "Agent Relay spawned @{} but could not save its spawn receipt yet: {error}",
                            request.name
                        ),
                    );
                    Ok(output)
                }
            },
            Err(error) => {
                let error = error.redacted();
                match scope.save_failure(&self.config.app_data_dir, request, error.clone()) {
                    Ok(completion) => completion.replay(request),
                    Err(_) => {
                        let message = format!(
                            "Agent Relay could not save the failed spawn receipt for {}: {}",
                            request.invocation_id,
                            error.text()
                        );
                        crate::relay::diagnostics::write(format_args!("{message}"));
                        self.hub.activity(Level::Warning, message);
                        Err(error)
                    }
                }
            }
        };
        *invocation = Some(CompletedSpawn {
            name: request.name.clone(),
            harness: request.harness,
            result: result.clone(),
        });
        result
    }

    async fn spawn_agent_once(
        &self,
        link: &NodeLink,
        request: &SpawnRequest,
    ) -> Result<Value, SpawnError> {
        let settings = self.spawn_settings();
        if !settings.accept {
            return Err("spawn_disabled: spawning is turned off on this computer".into());
        }
        if self.spawns_blocked() {
            let message = super::claim::OWNED_BY_OTHER.to_string();
            return Err(refusal(
                link,
                request.harness,
                wire::TARGET_UNAVAILABLE,
                message,
            ));
        }
        if !self.plugins.spawner.available().contains(&request.harness) {
            let reason = self
                .plugins
                .spawner
                .unavailable_reason(request.harness)
                .unwrap_or_else(|| {
                    format!(
                        "{} is not installed on this computer",
                        request.harness.label()
                    )
                });
            return Err(self.harness_unavailable(link, request.harness, reason));
        }
        if self
            .store
            .read(|store| store.registrations.iter().any(|r| r.name == request.name))
        {
            return Err(format!(
                "spawn_agent_name_in_use: @{} is already an agent on this computer",
                request.name
            )
            .into());
        }
        let reservation = self.reserve_place(link, request)?;
        self.spawn_places_changed();
        let mut left = None;
        let result = match self.claim_name(&request.name) {
            Ok(()) => {
                let result = self
                    .spawn_claimed(link, request, &settings, &mut left)
                    .await;
                self.release_name(&request.name);
                result
            }
            Err(_) => Err(format!(
                "spawn_agent_name_in_use: @{} is being registered here",
                request.name
            )
            .into()),
        };
        drop(reservation);
        self.spawn_places_changed();
        // Once its place is given back, so a retry of the invocation is
        // told apart from it.
        if let Some((intent, how)) = left {
            self.settle_unanswered(link.clone(), intent, how);
        }
        result
    }

    async fn spawn_claimed(
        &self,
        link: &NodeLink,
        request: &SpawnRequest,
        settings: &SpawnSettings,
        left: &mut Option<(Intent, Unanswered)>,
    ) -> Result<Value, SpawnError> {
        let workspace = self
            .workspace()
            .ok_or("spawn_failed: this computer has no Agent Relay workspace")?;
        let directory = request
            .directory
            .clone()
            .unwrap_or_else(|| self.config.home.clone());
        // TCC approval and unavailable volumes can stall filesystem calls.
        // Check before registering an agent, without blocking node heartbeats
        // or the desktop socket. A timed-out check has no launch side effects.
        let checked_directory = directory.clone();
        tokio::time::timeout(
            Duration::from_secs(10),
            async move {
                let permit = DIRECTORY_CHECKS.acquire().await
                    .map_err(|_| "spawn_failed: could not check access to the working folder".to_string())?;
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    super::launch::check_directory(&checked_directory)
                })
                .await
                .map_err(|_| "spawn_failed: could not check access to the working folder".to_string())?
                .map_err(|reason| format!("spawn_invalid_input: {reason}"))
            },
        )
        .await
        .map_err(|_| "spawn_failed: checking access to the working folder timed out. Check that the drive is available and Agent Relay can access it, then retry.")??;
        // Who asked, as Relaycast recorded it, read while the agent registers.
        let requester = tokio::spawn({
            let workspace = workspace.clone();
            let invocation_id = request.invocation_id.clone();
            async move { report_back::requester(&workspace, &invocation_id).await }
        });
        // On disk before anything starts, so a restart finds what it left.
        let mut in_flight = InFlight {
            app_data_dir: self.config.app_data_dir.clone(),
            intent: Intent {
                invocation_id: request.invocation_id.clone(),
                name: request.name.clone(),
                harness: request.harness,
                node_id: link.node.node_id.clone(),
                node_name: link.node.node_name.clone(),
                title: intents::title(&request.task, &request.name),
                base_url: workspace.base_url.clone(),
                workspace_key: workspace.key.clone(),
                // The verified id, also for keys from the environment or the
                // app store: recovery matches by it after a key rotation.
                workspace_id: self.verified_workspace_id(),
                machine_prefix: self.machine_prefix.clone(),
                message_id: report_back::first_message_id(&request.invocation_id),
                session_id: crate::relay::store::random_uuid(),
                created_ms: Utc::now().timestamp_millis(),
                ended: false,
                launch_failed: false,
                register_sent: false,
                agent_id: None,
                token: None,
                requester: None,
                target: None,
                process: None,
            },
        };
        in_flight
            .begin()
            .map_err(|error| unsaved_intent("spawn", &error))?;
        let agent = self
            .register(
                link,
                &mut in_flight,
                left,
                self.store
                    .read(crate::relay::store::Store::auto_joins_general),
            )
            .await?;
        let deregister = |intent: &Intent| {
            self.defer_failed_cleanup(link, intent);
        };
        // Nothing starts on an identity a restart could not find again. The
        // identity stays in memory either way, so its record outlives an
        // unanswered deregistration.
        if let Err(error) = in_flight.update(|intent| {
            intent.agent_id = Some(agent.agent_id.clone());
            intent.token = Some(Secret::new(agent.token.clone()));
        }) {
            // Taken off in the background like every deregistration (never
            // taken over while it may still land); the record, ended, goes
            // once Relaycast confirms, and recovery finds it otherwise.
            in_flight.leave_for_recovery();
            super::recover::deregister(
                link.clone(),
                self.ledger(),
                self.config.app_data_dir.clone(),
                agent.agent_id.clone(),
                in_flight.intent.clone(),
            );
            return Err(unsaved_intent("registered agent", &error).into());
        }
        let ledger = self.ledger();
        ledger.lock().starting.insert(
            request.invocation_id.clone(),
            (
                link.node.node_id.clone(),
                InventoryAgent {
                    agent_id: agent.agent_id.clone(),
                    name: request.name.clone(),
                    invocation_id: request.invocation_id.clone(),
                    session_ref: session_ref(&request.invocation_id),
                },
            ),
        );
        let _starting = Starting {
            ledger,
            invocation_id: request.invocation_id.clone(),
        };
        let address = format!("{}@{}", request.name, link.node.node_name);
        let requester = requester
            .await
            .ok()
            .flatten()
            .filter(|requester| requester.name != request.name);
        // Kept with the intent, so an agent saved after a restart is still
        // owed its final answer. Without it only that answer is lost.
        if requester.is_some() {
            let _ = in_flight.update(|intent| intent.requester = requester.clone());
        }
        let report = ReportBack::new(
            request.harness,
            &in_flight.intent.message_id,
            requester.as_ref().map(|requester| requester.name.clone()),
            self.plugins
                .relay_send
                .as_ref()
                .and_then(|relay_send| relay_send.serving.get()),
            settings.full_access(request.harness),
        );
        let launch = Launch {
            harness: request.harness,
            name: request.name.clone(),
            text: first_text(&request.name, &address, &request.task, &report),
            directory: directory.clone(),
            full_access: settings.full_access(request.harness),
            message_id: in_flight.intent.message_id.clone(),
            session_id: in_flight.intent.session_id.clone(),
        };
        let launched = match self.launch_registered(launch, &mut in_flight).await {
            Ok(launched) => launched,
            Err(LaunchFailure::Launch(
                LaunchError::Unavailable(reason) | LaunchError::Failed(reason),
            )) => {
                deregister(&in_flight.intent);
                return Err(self.harness_unavailable(
                    link,
                    request.harness,
                    crate::relay::harness::diagnostics::redact(&reason),
                ));
            }
            // What it started may still run: it stays registered, its intent
            // left for recovery to stop it and take it off the node.
            Err(LaunchFailure::Running(code)) => return Err(code.into()),
            Err(failure) => {
                deregister(&in_flight.intent);
                return Err(failure.code().into());
            }
        };
        let registration = intents::with_task(
            in_flight.intent.registration(
                &agent.agent_id,
                launched.target.clone(),
                launched.process,
                (&link.node.node_id, &link.node.node_name),
            ),
            launched.task,
        );
        // The requester gets the first turn's final answer unless the agent
        // sends them something itself (`report_back::owed`).
        let saved = self.store.update(|store| {
            report_back::add_spawned(
                store,
                registration.clone(),
                Secret::new(agent.token.clone()),
            )
        });
        if saved != Ok(true) {
            if self.abandon(&launched, &mut in_flight).await {
                deregister(&in_flight.intent);
            }
            return Err(match saved {
                Ok(_) => format!(
                    "spawn_agent_name_in_use: @{} is already an agent on this computer",
                    request.name
                ),
                Err(error) => format!("spawn_failed: could not save the agent: {error}"),
            }
            .into());
        }
        self.watch_spawned(&registration);
        in_flight.settled();
        self.hub.update(|status| {
            if status.spawn.as_ref().map(|spawn| spawn.state) == Some(SpawnState::Live) {
                status.push.insert(request.name.clone(), PushState::Live);
            }
        });
        self.hub.invalidated(Listing::Agents);
        self.hub.activity(
            Level::Info,
            format!(
                "Agent Relay spawned @{} ({}) in {}.",
                request.name,
                request.harness.label(),
                directory.display()
            ),
        );
        self.request_drain(&request.name);
        Ok(completions::spawned_output(&registration))
    }
}

pub(super) fn unsaved_intent(what: &str, error: &std::io::Error) -> String {
    format!("spawn_failed: could not save the {what}'s recovery record: {error}")
}
