//! What a core holds in memory about its spawned agents: places being
//! reserved or starting, each agent's evidence, the node's last contact and
//! the places reclaimed.

use super::invoke::SpawnError;
use super::lifecycle::{self, AgentRecord, NodeSeen};
use super::node::{NodeInfo, NodeLink};
use super::observe::{Observe, RegistryObserver};
use super::session_ref;
use super::wire::{InventoryAgent, Reclaimed, SpawnFailure, SpawnRequest};
use crate::relay::daemon::Core;
use crate::relay::harness::{HarnessContext, Registry};
use crate::relay::state::{SpawnSlots, SpawnState, SpawnedAgentState};
use crate::relay::store::{Registration, Store};
use chrono::Utc;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Instant;
use tokio::sync::Notify;

/// How long a session socket request with no registration waits while a
/// spawn saves one (`Core::once_spawns_save`).
pub const SPAWN_SAVE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// What this core knows of its spawned agents beyond the store: places
/// being reserved, each agent's evidence, the node's last heartbeat, and
/// places reclaimed. In memory: a restarted core observes everything again
/// before it reclaims anything.
#[derive(Default)]
pub(crate) struct Ledger {
    pub(super) state: Mutex<LedgerState>,
    pub(super) changed: Arc<Notify>,
    observer: Mutex<Option<Arc<dyn Observe>>>,
    pub(super) actions: super::actions::ActionLocks,
    /// Whether the node is claimed for the signed-in person (`claim`).
    claim: Mutex<super::claim::Memory>,
    /// Notified to check the claim at once.
    pub(super) claim_now: Arc<Notify>,
    /// Results the spawn node still owes Relaycast, kept across its
    /// connections and restarts.
    pub(super) results: Arc<Mutex<super::node::Results>>,
}

/// A released agent listed until its release result is sent.
pub(super) struct Releasing {
    pub(super) listed: (String, InventoryAgent),
    pub(super) since: Instant,
}

#[derive(Default)]
pub(super) struct LedgerState {
    /// Invocations holding a place while they start.
    pub(super) reserved: BTreeSet<String>,
    /// Agents Relaycast registered whose launch has not finished, by
    /// invocation, with their node: listed in inventory until saved, so
    /// Relaycast never takes one still starting for missing.
    pub(super) starting: BTreeMap<String, (String, InventoryAgent)>,
    /// Agents released here whose release result has not been sent yet, by
    /// release invocation: listed in inventory until it is, so Relaycast
    /// completes the release rather than first taking the ended agent for
    /// missing, which fails it (`release`). No longer than a result is kept
    /// for sending (`RESULT_KEEP`).
    pub(super) releasing: BTreeMap<String, Releasing>,
    pub(super) failed: BTreeMap<String, super::failed::Cleanup>,
    /// Running agents a restart found whose registration the store could
    /// not take yet, by invocation: listed and holding their place until
    /// saved (`recover`).
    pub(super) unsaved: BTreeMap<String, super::recover::Unsaved>,
    /// Attempts whose unanswered register is being settled, by invocation
    /// and session id: one settler at a time (`unanswered`).
    pub(super) settling: BTreeSet<(String, String)>,
    pub(super) agents: HashMap<String, AgentRecord>,
    pub(super) node: Option<NodeSeen>,
    pub(super) observing: bool,
    pub(super) observed: Option<Instant>,
    /// Free places as last advertised.
    pub(super) advertised_free: Option<u32>,
    pub(super) reclaimed: VecDeque<Reclaimed>,
    /// Agents being taken over (`handover`), each with whether it is to
    /// be stopped at once, in the middle of a turn, and its answer.
    pub(super) taking_over: HashMap<String, super::handover::TakingOver>,
}

impl LedgerState {
    /// Whether the agent holds a place. One never observed does, as any
    /// agent not seen to have ended.
    pub(super) fn holds_slot(&self, name: &str) -> bool {
        self.agents.get(name).is_none_or(AgentRecord::holds_slot)
    }
}

impl Ledger {
    /// The ledger's state; a lock poisoned by a panic elsewhere still
    /// gives it, as every change to it is complete when made.
    pub(super) fn lock(&self) -> MutexGuard<'_, LedgerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The claim, as `lock` gives the state.
    pub(super) fn memory(&self) -> MutexGuard<'_, super::claim::Memory> {
        self.claim.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    pub(crate) fn set_observer(&self, observer: Arc<dyn Observe>) {
        *self.observer.lock().unwrap_or_else(|e| e.into_inner()) = Some(observer);
    }
}

/// One ledger per core, by its app data folder. (Kept here rather than as a
/// `Core` field so `relay::spawn` stays self-contained.)
pub(super) static LEDGERS: LazyLock<Mutex<HashMap<PathBuf, Arc<Ledger>>>> =
    LazyLock::new(Default::default);

/// A place held while a spawn starts; given back when dropped.
pub(super) struct Reservation {
    ledger: Arc<Ledger>,
    invocation_id: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.ledger.lock().reserved.remove(&self.invocation_id);
    }
}

/// An agent registered on the node while it launches; forgotten when
/// dropped, by which time it is saved or has failed.
pub(super) struct Starting {
    pub(super) ledger: Arc<Ledger>,
    pub(super) invocation_id: String,
}

impl Drop for Starting {
    fn drop(&mut self) {
        self.ledger.lock().starting.remove(&self.invocation_id);
    }
}

impl Core {
    /// `read` from the store, waiting up to [`SPAWN_SAVE_WAIT`] while it
    /// finds nothing and a spawn is between registering its agent and
    /// saving it: a spawned agent can run its first message's report
    /// command before its launch is confirmed and saved.
    pub(crate) async fn once_spawns_save<T>(
        &self,
        read: impl Fn(&Store) -> Option<T>,
    ) -> Option<T> {
        let deadline = Instant::now() + SPAWN_SAVE_WAIT;
        loop {
            let found = self.store.read(&read);
            let starting = !self.ledger().lock().starting.is_empty();
            if found.is_some() || !starting || Instant::now() >= deadline {
                return found;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }

    pub(crate) fn ledger(&self) -> Arc<Ledger> {
        LEDGERS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(self.config.app_data_dir.clone())
            .or_default()
            .clone()
    }

    pub(super) fn observer(&self) -> Arc<dyn Observe> {
        let ledger = self.ledger();
        let mut observer = ledger.observer.lock().unwrap_or_else(|e| e.into_inner());
        observer
            .get_or_insert_with(|| {
                Arc::new(RegistryObserver(Registry::builtin(&HarnessContext::local(
                    &self.config.env,
                    &self.config.home,
                    &self.config.app_data_dir,
                ))))
            })
            .clone()
    }

    pub(super) fn slots_in(&self, state: &LedgerState) -> SpawnSlots {
        let spawned = self.spawned_registrations();
        let held =
            spawned.iter().filter(|r| state.holds_slot(&r.name)).count() + state.unsaved.len();
        let held = held as u32;
        // A spawn already saved holds its place as a registration until its
        // reservation is dropped: counted once.
        let saved: BTreeSet<&str> = spawned
            .iter()
            .filter_map(|r| r.spawn.as_ref().map(|s| s.invocation_id.as_str()))
            .collect();
        let reserved = state
            .reserved
            .iter()
            .filter(|id| !saved.contains(id.as_str()))
            .count() as u32;
        SpawnSlots {
            max: self.spawn_settings().max_agents,
            held,
            reserved,
        }
    }

    pub(crate) fn spawn_slots(&self) -> SpawnSlots {
        let ledger = self.ledger();
        let state = ledger.lock();
        self.slots_in(&state)
    }

    /// Shows the places in the status.
    pub(super) fn show_spawn_places(&self) {
        let slots = self.spawn_slots();
        self.hub.update(|status| {
            if let Some(spawn) = status.spawn.as_mut().filter(|s| s.state != SpawnState::Off) {
                spawn.slots = Some(slots);
            }
        });
    }

    /// Shows the places in the status and tells the node at once.
    pub(super) fn spawn_places_changed(&self) {
        self.show_spawn_places();
        self.ledger().changed.notify_one();
    }

    /// Takes a place for `request`, or refuses: never waits for one.
    pub(super) fn reserve_place(
        &self,
        link: &NodeLink,
        request: &SpawnRequest,
    ) -> Result<Reservation, SpawnError> {
        let ledger = self.ledger();
        let mut state = ledger.lock();
        // Relaycast sending an invocation again while it is still starting
        // must not reserve twice: the second would free the first's place
        // when it ends.
        if state.reserved.contains(&request.invocation_id) {
            return Err(format!(
                "spawn_in_progress: invocation {} is already starting here",
                request.invocation_id
            )
            .into());
        }
        let slots = self.slots_in(&state);
        if let Err(refusal) = lifecycle::admit(slots, state.advertised_free) {
            return Err(SpawnError::Failure(Box::new(SpawnFailure {
                code: refusal.code(),
                message: refusal.message(),
                node: link.node.node_name.clone(),
                harness: Some(request.harness),
                active: Some(slots.held),
                reserved: Some(slots.reserved),
                max: Some(slots.max),
                observed_at: lifecycle::iso(Utc::now()),
                retryable: true,
            })));
        }
        state.reserved.insert(request.invocation_id.clone());
        drop(state);
        Ok(Reservation {
            ledger,
            invocation_id: request.invocation_id.clone(),
        })
    }

    /// A spawned agent's place and lifecycle, as its row shows it.
    pub(crate) fn spawned_agent_state(
        &self,
        registration: &Registration,
    ) -> Option<SpawnedAgentState> {
        let spawn = registration.spawn.as_ref()?;
        let ledger = self.ledger();
        let state = ledger.lock();
        let record = state
            .agents
            .get(&registration.name)
            .cloned()
            .unwrap_or_default();
        let now = Utc::now();
        Some(SpawnedAgentState {
            harness: spawn.harness.clone(),
            holds_slot: record.holds_slot(),
            node: lifecycle::node_evidence(state.node, now),
            process: record.process_evidence(now),
            work: record.work_evidence(now),
            unfinished: record.unfinished,
        })
    }

    /// The agents this node hosts: those holding a place. One left out is
    /// marked offline by Relaycast (`agent.exited missing_from_inventory`).
    pub(super) fn spawned_inventory(&self, node: &NodeInfo) -> Vec<InventoryAgent> {
        let ledger = self.ledger();
        let mut state = ledger.lock();
        // A result never sent within this is given up, and so is its agent.
        state
            .releasing
            .retain(|_, r| r.since.elapsed() < super::node::RESULT_KEEP);
        let mut agents: Vec<InventoryAgent> = self
            .spawned_registrations()
            .into_iter()
            .filter(|r| r.missing_since.is_none() && state.holds_slot(&r.name))
            .filter_map(|r| inventory_entry(&r).filter(|(id, _)| *id == node.node_id))
            .map(|(_, agent)| agent)
            .collect();
        let unsaved = state.unsaved.values().map(|u| &u.listed);
        let releasing = state.releasing.values().map(|r| &r.listed);
        let listed = state.starting.values().chain(releasing);
        for (node_id, agent) in listed.chain(unsaved) {
            if *node_id == node.node_id
                && !agents
                    .iter()
                    .any(|a| a.invocation_id == agent.invocation_id)
            {
                agents.push(agent.clone());
            }
        }
        agents
    }

    /// Gives back a released agent's place: nothing of it is kept.
    pub(super) fn forget_spawned(&self, name: &str) {
        self.forget_record(name);
        self.spawn_places_changed();
    }

    fn forget_record(&self, name: &str) {
        let ledger = self.ledger();
        let mut state = ledger.lock();
        state.agents.remove(name);
        state.reclaimed.retain(|r| r.name != name);
    }

    /// Gives back the place of an agent being released. The node is not
    /// told yet: the agent stays listed until its release result is sent
    /// (`release_result_sent`).
    pub(super) fn forget_releasing(&self, name: &str) {
        self.forget_record(name);
        self.show_spawn_places();
    }

    /// Keeps `registration` listed while the release `invocation_id` is
    /// answered, however its process is observed meanwhile.
    pub(super) fn mark_releasing(&self, invocation_id: &str, registration: &Registration) {
        if let Some(listed) = inventory_entry(registration) {
            let since = Instant::now();
            let releasing = Releasing { listed, since };
            let ledger = self.ledger();
            ledger
                .lock()
                .releasing
                .insert(invocation_id.to_string(), releasing);
        }
    }

    /// The release `invocation_id` failed: its agent is not released.
    pub(super) fn unmark_releasing(&self, invocation_id: &str) {
        self.ledger().lock().releasing.remove(invocation_id);
    }

    /// The result of the action `invocation_id` was written to Relaycast:
    /// an agent it released stops being listed, and Relaycast learns at
    /// once, after the result.
    pub(crate) fn release_result_sent(&self, invocation_id: &str) {
        let removed = self.ledger().lock().releasing.remove(invocation_id);
        if removed.is_some() {
            self.spawn_places_changed();
        }
    }
}

/// How a spawned registration is listed in inventory, with its node.
fn inventory_entry(registration: &Registration) -> Option<(String, InventoryAgent)> {
    let spawn = registration.spawn.as_ref()?;
    let agent = InventoryAgent {
        agent_id: registration.agent_id.clone(),
        name: registration.name.clone(),
        invocation_id: spawn.invocation_id.clone(),
        session_ref: session_ref(&spawn.invocation_id),
    };
    Some((spawn.node_id.clone(), agent))
}
