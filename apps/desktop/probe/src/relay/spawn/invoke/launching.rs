//! Launching a registered agent, and ending what a failed launch started
//! before its intent is marked ended.

use super::super::intents::{self, InFlight};
use super::super::launch::{Launch, LaunchError, Launched, SpawnedProcess};
use super::unsaved_intent;
use crate::relay::daemon::Core;
use crate::relay::state::Level;
use crate::relay::store::Target;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

impl Core {
    /// Launches a registered agent, its session recorded on disk as soon as
    /// it starts. A launch that failed, panicked or started a session the
    /// intent could not record is ended here, and only once its end is
    /// confirmed is its intent marked ended, so a restart never keeps it;
    /// one that may still run is `Running`, its evidence left for recovery.
    pub(super) async fn launch_registered(
        &self,
        launch: Launch,
        in_flight: &mut InFlight,
    ) -> Result<Launched, LaunchFailure> {
        let spawner = self.plugins.spawner.clone();
        let (app_data_dir, intent) = (in_flight.app_data_dir.clone(), in_flight.intent.clone());
        let seen: Arc<Mutex<Option<Seen>>> = Arc::default();
        let unrecorded = Arc::new(AtomicBool::new(false));
        let launching = {
            let (seen, unrecorded) = (seen.clone(), unrecorded.clone());
            move || {
                // Known as soon as the session starts, before the launch ends.
                let started = |target: &Target, process: Option<SpawnedProcess>| {
                    *seen.lock().unwrap_or_else(|e| e.into_inner()) =
                        Some((target.clone(), process));
                    let recorded = intents::update_attempt(&app_data_dir, &intent, |current| {
                        (current.target, current.process) = (Some(target.clone()), process);
                    });
                    if !matches!(recorded, Ok(Some(_))) {
                        unrecorded.store(true, Ordering::SeqCst);
                    }
                };
                spawner.launch(&launch, &started)
            }
        };
        let failure = match tokio::task::spawn_blocking(launching).await {
            Ok(Ok(launched)) => return self.recorded(launched, in_flight, &unrecorded).await,
            Ok(Err(error)) => LaunchFailure::Launch(error),
            // A panicked worker may already have started the harness.
            Err(_) => LaunchFailure::Panicked,
        };
        let seen = seen.lock().unwrap_or_else(|e| e.into_inner()).take();
        Err(self.end_failed(in_flight, seen, failure).await)
    }

    /// A launched agent, once its intent records its session.
    async fn recorded(
        &self,
        launched: Launched,
        in_flight: &mut InFlight,
        unrecorded: &AtomicBool,
    ) -> Result<Launched, LaunchFailure> {
        if !unrecorded.load(Ordering::SeqCst) {
            return Ok(launched);
        }
        let recorded = in_flight.update(|intent| {
            (intent.target, intent.process) = (Some(launched.target.clone()), launched.process);
        });
        match recorded {
            Ok(()) => Ok(launched),
            Err(error) => {
                let failure = LaunchFailure::Unrecorded(error);
                match self.abandon(&launched, in_flight).await {
                    true => Err(failure),
                    false => Err(LaunchFailure::Running(failure.code())),
                }
            }
        }
    }

    /// Ends what a failed launch started (OpenCode's server, say, recorded
    /// before its first message was refused), found by its intent or what
    /// its started callback saw, and confirms it ended.
    async fn end_failed(
        &self,
        in_flight: &mut InFlight,
        seen: Option<Seen>,
        failure: LaunchFailure,
    ) -> LaunchFailure {
        // Read back what the callback recorded, adding what it saw.
        let _ = in_flight.update(|intent| {
            if let (None, Some((target, process))) = (&intent.target, seen) {
                (intent.target, intent.process) = (Some(target), process);
            }
        });
        let spawner = self.plugins.spawner.clone();
        let intent = in_flight.intent.clone();
        let ended = tokio::task::spawn_blocking(move || match spawner.find(&intent) {
            Some((target, process)) => spawner.release(&target, process.as_ref()).is_ok(),
            None => true,
        })
        .await
        .unwrap_or(false);
        self.settle_failed(in_flight, ended, failure)
    }

    /// Stops a launched agent that will not be kept. True once its end is
    /// confirmed and its intent marked ended; false leaves the intent as it
    /// is, for recovery to stop what may still run.
    pub(super) async fn abandon(&self, launched: &Launched, in_flight: &mut InFlight) -> bool {
        let spawner = self.plugins.spawner.clone();
        let (target, process) = (launched.target.clone(), launched.process);
        let ended = tokio::task::spawn_blocking(move || spawner.release(&target, process.as_ref()))
            .await
            .is_ok_and(|released| released.is_ok());
        if ended {
            let _ = in_flight.update(|intent| intent.ended = true);
        }
        ended
    }

    /// Marks a failed launch's intent ended once what it started is
    /// confirmed ended; otherwise it is `Running`, left as it is.
    fn settle_failed(
        &self,
        in_flight: &mut InFlight,
        ended: bool,
        failure: LaunchFailure,
    ) -> LaunchFailure {
        // Record the terminal reason before marking its only recovery intent ended.
        // Recovery may remove that intent as soon as deregistration is confirmed.
        let error = if !ended {
            super::SpawnError::from(failure.code()).redacted()
        } else {
            match &failure {
                LaunchFailure::Launch(
                    LaunchError::Unavailable(reason) | LaunchError::Failed(reason),
                ) => super::SpawnError::Failure(Box::new(super::SpawnFailure {
                    code: super::wire::HARNESS_UNAVAILABLE,
                    message: crate::relay::harness::diagnostics::redact(reason),
                    node: in_flight.intent.node_name.clone(),
                    harness: Some(in_flight.intent.harness),
                    active: None,
                    reserved: None,
                    max: None,
                    observed_at: super::lifecycle::iso(chrono::Utc::now()),
                    retryable: false,
                })),
                _ => super::SpawnError::from(failure.code()).redacted(),
            }
        };
        crate::relay::diagnostics::write(format_args!(
            "Agent Relay launch {} for @{} failed before cleanup: {}",
            in_flight.intent.invocation_id,
            in_flight.intent.name,
            error.text()
        ));
        let request = super::SpawnRequest {
            invocation_id: in_flight.intent.invocation_id.clone(),
            name: in_flight.intent.name.clone(),
            harness: in_flight.intent.harness,
            task: String::new(),
            directory: None,
        };
        let saved = self.workspace().is_some_and(|workspace| {
            super::Scope::workspace(&workspace)
                .save_failure(&self.config.app_data_dir, &request, error)
                .is_ok()
        });
        if !saved {
            crate::relay::diagnostics::write(format_args!(
                "Agent Relay could not persist failed launch {} before cleanup",
                request.invocation_id
            ));
        }
        let _ = in_flight.update(|intent| intent.launch_failed = true);
        if !ended {
            self.hub.activity(
                Level::Warning,
                format!(
                    "Agent Relay could not confirm that @{}'s failed launch ended; it tries again when it reconnects.",
                    in_flight.intent.name
                ),
            );
            return LaunchFailure::Running(failure.code());
        }
        // Its intent is the only durable trace until the receipt is saved:
        // keep it, so recovery retries instead of forgetting the failure.
        if saved {
            let _ = in_flight.update(|intent| intent.ended = true);
        }
        failure
    }
}

/// What a launch's started callback reported.
type Seen = (Target, Option<SpawnedProcess>);

/// Why a registered agent was not launched.
pub(super) enum LaunchFailure {
    Launch(LaunchError),
    Panicked,
    /// It started, but the intent could not record its session.
    Unrecorded(std::io::Error),
    /// It failed (the code says how), but what it started could not be
    /// confirmed ended: still registered, its intent left for recovery.
    Running(String),
}

impl LaunchFailure {
    pub(super) fn code(&self) -> String {
        match self {
            LaunchFailure::Launch(error) => error.code(),
            LaunchFailure::Panicked => "spawn_failed: the launch stopped unexpectedly".into(),
            LaunchFailure::Unrecorded(error) => unsaved_intent("launched agent", error),
            LaunchFailure::Running(code) => code.clone(),
        }
    }
}
