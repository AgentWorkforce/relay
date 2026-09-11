use super::*;
use crate::fleet_wire::{
    ActionResult, ActionResultError, ActionResultPayload, AgentDeregister, BrokerToRelaycast,
    FLEET_WIRE_VERSION,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::{sync::oneshot, task::JoinHandle};

const CLEANUP_RETRY_DELAY: Duration = Duration::from_secs(5);
const CLEANUP_ACK_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) enum CleanupCompletion {
    Api(
        oneshot::Sender<Result<Value, String>>,
        Result<Value, String>,
    ),
    Fleet(ActionResult),
}

/// Name custody remains in the runtime until the remote result is reconciled.
/// A failed attempt retains its original generation, client and binding for retry.
pub(crate) struct PendingIdentityCleanup {
    pub(super) generation: Uuid,
    registration: Option<Arc<crate::spawn_registration::SpawnRegistration>>,
    http: RelaycastHttpClient,
    pub(super) delete_identity: bool,
    agent_id: Option<String>,
    expected_token_hash: Result<String, String>,
    deregistered: Arc<AtomicBool>,
    pub(super) attempts: u8,
    task: Option<JoinHandle<Result<(), String>>>,
    pub(super) retry_at: Instant,
    pub(super) completions: Vec<CleanupCompletion>,
}

/// Enqueue the inventory removal and deregistration together, before yielding
/// the runtime. A stale snapshot must never be enqueued later by a background
/// task, after another worker has joined. Backpressure retains custody for retry.
#[allow(clippy::too_many_arguments)]
fn start_attempt(
    tx: &mpsc::Sender<FleetControlCommand>,
    agent_id: Option<String>,
    inventory: &mut HashMap<WorkerName, InventoryAgent>,
    http: RelaycastHttpClient,
    name: WorkerName,
    delete_identity: bool,
    expected_token_hash: Result<String, String>,
    deregistered: Arc<AtomicBool>,
    registration: Option<Arc<crate::spawn_registration::SpawnRegistration>>,
    generation: Uuid,
) -> JoinHandle<Result<(), String>> {
    let authorized = || {
        registration.as_ref().is_none_or(|custody| {
            custody.authorizes_cleanup(
                generation,
                agent_id.as_deref(),
                expected_token_hash.as_ref().ok().map(String::as_str),
            )
        })
    };
    if !authorized() {
        return tokio::spawn(async {
            Err("registration cleanup authority revoked; name quarantined".into())
        });
    }
    if inventory
        .get(&name)
        .is_some_and(|entry| Some(entry.agent_id.as_str()) == agent_id.as_deref())
    {
        inventory.remove(&name);
    }
    let acknowledgement = (|| {
        if deregistered.load(Ordering::Acquire) {
            return Ok(None);
        }
        tx.try_send(FleetControlCommand::UpdateInventory(
            inventory.values().cloned().collect(),
        ))
        .map_err(|error| format!("cleanup inventory unavailable: {error}"))?;
        let Some(agent_id) = &agent_id else {
            return Ok(None);
        };
        let (reply, received) = oneshot::channel();
        tx.try_send(FleetControlCommand::DeregisterAgent {
            request: AgentDeregister {
                v: FLEET_WIRE_VERSION,
                id: None,
                agent_id: agent_id.to_string(),
                name: Some(name.to_string()),
            },
            reply,
        })
        .map_err(|error| format!("cleanup deregistration unavailable: {error}"))?;
        Ok::<_, String>(Some(received))
    })();
    tokio::spawn(async move {
        if let Some(received) = acknowledgement? {
            timeout(CLEANUP_ACK_TIMEOUT, received)
                .await
                .map_err(|_| "fleet deregistration acknowledgement timed out".to_string())?
                .map_err(|_| {
                    "fleet deregistration connection closed before acknowledgement".to_string()
                })??;
        }
        // Preserve confirmed progress across a failed identity-delete retry.
        deregistered.store(true, Ordering::Release);
        // Only delete an identity created by this generation. A supplied token
        // can request binding teardown, but never grants deletion ownership.
        if delete_identity {
            if registration.as_ref().is_some_and(|custody| {
                !custody.authorizes_cleanup(
                    generation,
                    agent_id.as_deref(),
                    expected_token_hash.as_ref().ok().map(String::as_str),
                )
            }) {
                return Err("registration cleanup authority revoked; name quarantined".into());
            }
            http.release_agent_identity_guarded(
                &name,
                Some("owned worker cleanup"),
                true,
                Some(&expected_token_hash?),
            )
            .await
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn schedule_identity_cleanup(
    workers: &mut WorkerRegistry,
    tx: &mpsc::Sender<FleetControlCommand>,
    book: &FleetDeliveryBook,
    inventory: &mut HashMap<WorkerName, InventoryAgent>,
    http: &RelaycastHttpClient,
    name: &WorkerName,
    delete_identity: bool,
    completion: Option<CleanupCompletion>,
) {
    let registration = workers
        .spawn_registrations
        .entries
        .get(name)
        .cloned()
        .filter(|entry| !entry.retired());
    let generation = registration
        .as_ref()
        .map(|entry| entry.generation())
        .unwrap_or_else(|| {
            workers
                .owned_spawn_generations
                .get(name)
                .map(|(generation, _)| *generation)
                .or_else(|| workers.workers.get(name).map(|worker| worker.generation))
                .or_else(|| {
                    workers
                        .identity_cleanups
                        .get(name)
                        .map(|pending| pending.generation)
                })
                .unwrap_or_else(Uuid::new_v4)
        });
    // Never coalesce another generation or touch its supervisor/inventory.
    if workers
        .workers
        .get(name)
        .is_some_and(|worker| worker.generation != generation)
        || workers
            .owned_spawn_generations
            .get(name)
            .is_some_and(|(owned, _)| *owned != generation)
    {
        tracing::error!(worker = %name, %generation, "refusing stale identity cleanup");
        return;
    }
    if let Some(pending) = workers.identity_cleanups.get_mut(name) {
        if pending.generation == generation {
            if let Some(completion) = completion {
                pending.completions.push(completion);
            }
        } else {
            tracing::error!(worker = %name, %generation, "refusing cleanup completion for another generation");
        }
        return;
    }
    if delete_identity {
        workers
            .owned_spawn_generations
            .entry(name.clone())
            .or_insert((generation, http.clone()));
    }
    let (agent_id, expected_token_hash) = if let Some(registration) = &registration {
        match registration.cleanup_identity() {
            Some((id, hash)) => (Some(id), Ok(hash)),
            None => (
                None,
                Err("registration has no proven identity custody".into()),
            ),
        }
    } else {
        (
            book.active_agent_id(name.as_str()).map(ToString::to_string),
            http.owned_identity_token_hash(name)
                .map_err(|error| error.to_string()),
        )
    };
    if registration.as_ref().is_none_or(|custody| {
        custody.authorizes_cleanup(
            generation,
            agent_id.as_deref(),
            expected_token_hash.as_ref().ok().map(String::as_str),
        )
    }) {
        workers.supervisor.unregister(name);
    }
    let deregistered = Arc::new(AtomicBool::new(false));
    let task = start_attempt(
        tx,
        agent_id.clone(),
        inventory,
        http.clone(),
        name.clone(),
        delete_identity,
        expected_token_hash.clone(),
        deregistered.clone(),
        registration.clone(),
        generation,
    );
    workers.identity_cleanups.insert(
        name.clone(),
        PendingIdentityCleanup {
            generation,
            registration,
            http: http.clone(),
            delete_identity,
            agent_id,
            expected_token_hash,
            deregistered,
            attempts: 1,
            task: Some(task),
            retry_at: Instant::now(),
            completions: completion.into_iter().collect(),
        },
    );
}

impl BrokerRuntime {
    pub(super) async fn drain_identity_cleanups_on_shutdown(&mut self) {
        // Leave room for the existing 2.5s presence phase inside the CLI stop
        // deadline. Never detach a mutating task beyond broker shutdown.
        let _ = timeout(Duration::from_secs(1), async {
            while !self.workers.identity_cleanups.is_empty() {
                self.reconcile_identity_cleanups().await;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        for (name, pending) in &mut self.workers.identity_cleanups {
            if let Some(task) = pending.task.take() {
                task.abort();
            }
            tracing::warn!(worker = %name, generation = %pending.generation,
                "broker shutting down with unconfirmed owned cleanup; reconcile the recorded generation before name reuse");
        }
    }

    /// Poll only completed tasks. Network waits never occupy the runtime actor.
    pub(super) async fn reconcile_identity_cleanups(&mut self) {
        let names: Vec<_> = self.workers.identity_cleanups.keys().cloned().collect();
        for name in names {
            let pending = self.workers.identity_cleanups.get_mut(&name).unwrap();
            if pending
                .task
                .as_ref()
                .is_some_and(|task| !task.is_finished())
            {
                continue;
            }
            if pending.task.is_none() {
                if pending.attempts < 5 && Instant::now() >= pending.retry_at {
                    pending.attempts += 1;
                    pending.task = Some(start_attempt(
                        &self.fleet_control_tx,
                        pending.agent_id.clone(),
                        &mut self.fleet_inventory,
                        pending.http.clone(),
                        name.clone(),
                        pending.delete_identity,
                        pending.expected_token_hash.clone(),
                        pending.deregistered.clone(),
                        pending.registration.clone(),
                        pending.generation,
                    ));
                }
                continue;
            }
            let mut result = pending
                .task
                .take()
                .unwrap()
                .await
                .unwrap_or_else(|error| Err(format!("cleanup task failed: {error}")));
            if result.is_ok() && pending.delete_identity {
                if let Some(registration) = &pending.registration {
                    if let Err(error) = registration.retire_after_cleanup(pending.generation) {
                        tracing::warn!(worker = %name, %error, "remote cleanup complete but durable reservation retirement failed");
                        if registration.authorizes_cleanup(
                            pending.generation,
                            pending.agent_id.as_deref(),
                            pending
                                .expected_token_hash
                                .as_ref()
                                .ok()
                                .map(String::as_str),
                        ) {
                            pending.task = Some(tokio::spawn(async { Ok(()) }));
                            continue;
                        }
                        result = Err(error);
                    }
                }
            }
            let completions = std::mem::take(&mut pending.completions);
            let generation = pending.generation;
            if let Err(error) = &result {
                pending.retry_at = Instant::now() + CLEANUP_RETRY_DELAY;
                if pending.attempts >= 5 {
                    tracing::error!(worker = %name, %generation, agent_id = ?pending.agent_id, %error,
                        "owned identity cleanup retries exhausted; name stays reserved until an explicit generation-matched release retry");
                } else {
                    tracing::warn!(worker = %name, %generation, %error, "owned identity cleanup unconfirmed; name reserved for retry");
                }
            } else {
                let delete_identity = pending.delete_identity;
                let agent_id = pending.agent_id.clone();
                self.workers.identity_cleanups.remove(&name);
                // Spawn entry points reject reserved names; still guard against
                // removing custody if a future internal path changes generation.
                if self
                    .workers
                    .owned_spawn_generations
                    .get(&name)
                    .is_some_and(|(owned, _)| *owned == generation)
                {
                    self.workers.owned_spawn_generations.remove(&name);
                    if delete_identity {
                        self.workers
                            .completed_owned_releases
                            .push_back((name.clone(), generation));
                        if self.workers.completed_owned_releases.len() > 1024 {
                            self.workers.completed_owned_releases.pop_front();
                        }
                    }
                }
                if self.fleet_delivery_book.active_agent_id(name.as_str()) == agent_id.as_deref() {
                    self.fleet_delivery_book.remove_agent(name.as_str());
                }
            }
            for completion in completions {
                let cleanup_error = result.as_ref().err().map(|error| format!("owned identity cleanup unconfirmed for {name} generation {generation}; retry retained: {error}"));
                match completion {
                    CleanupCompletion::Api(reply, response) => {
                        let response = match cleanup_error {
                            Some(error) => Err(match response {
                                Err(original) => format!("{original}; {error}"),
                                Ok(_) => error,
                            }),
                            None => response,
                        };
                        let _ = reply.send(response);
                    }
                    CleanupCompletion::Fleet(mut response) => {
                        if let Some(error) = cleanup_error {
                            let original = match response.result {
                                ActionResultPayload::Error(error) => error.error,
                                _ => String::new(),
                            };
                            response.result = ActionResultPayload::Error(ActionResultError {
                                error: format!("{original}; {error}"),
                            });
                        }
                        let _ = self
                            .fleet_control_tx
                            .send(FleetControlCommand::Send(BrokerToRelaycast::ActionResult(
                                response,
                            )))
                            .await;
                    }
                }
            }
        }
    }
}
