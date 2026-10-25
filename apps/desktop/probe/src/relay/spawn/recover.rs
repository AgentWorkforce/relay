//! Keeping spawned agents bound to the node this computer runs now, and
//! settling the spawns a restart interrupted.
//!
//! The node keeps its id across restarts and token rotations (`node`), but
//! one enrolled afresh (its enrollment lost, or the machine prefix changed)
//! has a new id. Relaycast lets a node claim, through its inventory, an
//! agent of the same workspace whose old node is no longer live, so the
//! agents spawned on the old node are carried over rather than left out of
//! the inventory, where Relaycast would mark them missing while they run.
//!
//! A spawn the core stopped in the middle of left its intent on disk
//! (`intents`). Once the node connects, each of the node's workspace is
//! settled before the first inventory: an agent found still running is
//! kept, saved as the spawn would have saved it (or, when the store cannot
//! take it yet, listed and holding its place while the save is tried again
//! before each inventory), and anything else is ended,
//! its session stopped and the agent taken off the node, so nothing runs
//! that Agent Relay does not list. One of another workspace waits for a
//! node of that workspace; the workspace is told by its Relaycast id when
//! both sides know it, as a Cloud key recovery may rotate the key.
//! The intent of an ended agent stays until Relaycast confirms the
//! deregistration, so one lost with the connection is sent again.

use super::intents::{self, Intent};
use super::launch::SpawnedProcess;
use super::node::{NodeInfo, NodeLink};
use super::session_ref;
use super::unanswered::Unanswered;
use super::wire::{self, InventoryAgent};
use crate::relay::daemon::Core;
use crate::relay::push::PushState;
use crate::relay::state::{Level, Listing, SpawnState};
use crate::relay::store::{random_uuid, Registration, Target};
use crate::relay::workspace::{Secret, Workspace};
use std::path::PathBuf;
use std::time::Duration;

/// How long Relaycast gets to answer a deregistration.
const DEREGISTER_TIMEOUT: Duration = Duration::from_secs(10);

/// How one interrupted spawn was settled.
enum Settled {
    /// Still running, and saved as the spawn would have saved it.
    Kept,
    /// Not kept: whatever of it ran was stopped; it is taken off the node.
    Ended,
    /// Still running but not saved (the store could not be written): its
    /// intent stays as it is, and it is `Unsaved` until a save succeeds.
    Retry,
}

/// A running agent recovery kept whose registration the store could not
/// take: listed in inventory and holding its place while the save is tried
/// again before each inventory (`save_unsaved`), so Relaycast never marks
/// it missing nor is its place advertised as free.
#[derive(Clone)]
pub(super) struct Unsaved {
    intent: Intent,
    registration: Registration,
    token: Secret,
    /// Its node, and the agent as inventory lists it.
    pub(super) listed: (String, InventoryAgent),
}

/// The intent, when it is of `workspace`, pinned to the workspace's key.
/// Relaycast ids name one workspace whatever its key, so they decide when
/// both are known; an intent or a source without one (older intents, keys
/// from the environment) must hold the same key. Never one of another
/// origin.
pub(super) fn of_workspace(mut intent: Intent, workspace: &Workspace) -> Option<Intent> {
    let same = match (&intent.workspace_id, &workspace.workspace_id) {
        (Some(intended), Some(current)) => intended == current,
        _ => intent.workspace_key == workspace.key,
    };
    if !same || intent.base_url != workspace.base_url {
        return None;
    }
    // A kept agent's registration pins the key in use now.
    intent.workspace_key = workspace.key.clone();
    Some(intent)
}

/// Preserve the original receipt before adopting a rotated credential. If the
/// copy fails, leave the original intent untouched so recovery can retry safely.
pub(super) fn adopt_receipted_intent(
    app_data: &std::path::Path,
    intent: Intent,
    workspace: &Workspace,
) -> Option<Intent> {
    let adopted = of_workspace(intent.clone(), workspace)?;
    if super::completions::Scope::workspace(workspace).adopt(app_data, &intent).is_err() {
        crate::relay::diagnostics::write(format_args!("Agent Relay could not adopt spawn receipt {}; retaining its intent", intent.invocation_id));
        return None;
    }
    Some(adopted)
}

/// An interrupted spawn's session and process, as its harness found them.
struct Found {
    target: Target,
    process: Option<SpawnedProcess>,
    alive: bool,
}

/// Takes an ended agent off the node, in the background; its intent goes
/// once Relaycast confirms. Relaycast answers ok even for an agent no longer
/// on the node; a refusal is tried again on the next connection.
pub(super) fn deregister(link: NodeLink, app_data_dir: PathBuf, agent_id: String, intent: Intent) {
    tokio::spawn(async move {
        let id = format!("agent_deregister_{}", random_uuid());
        let frame = wire::agent_deregister(&id, &agent_id, &intent.name);
        let reply = link.request(&id, frame, DEREGISTER_TIMEOUT).await;
        if reply.is_some_and(|reply| matches!(wire::reply_to(&reply, &id), Some(Ok(_)))) {
            let _ = intents::remove(&app_data_dir, &intent);
        }
    });
}

impl Core {
    /// Binds the spawned agents of this workspace that are on another node
    /// of this computer to `node`.
    pub(super) fn carry_over_spawned(&self, node: &NodeInfo) {
        let Some(workspace) = self.workspace() else {
            return;
        };
        let elsewhere = |r: &crate::relay::store::Registration| {
            r.base_url == workspace.base_url
                && r.workspace_key.as_ref() == Some(&workspace.key)
                && r.spawn.as_ref().is_some_and(|s| s.node_id != node.node_id)
        };
        if !self
            .store
            .read(|store| store.registrations.iter().any(elsewhere))
        {
            return;
        }
        let _ = self.store.update(|store| {
            for registration in store.registrations.iter_mut().filter(|r| elsewhere(r)) {
                if let Some(spawn) = registration.spawn.as_mut() {
                    spawn.node_id = node.node_id.clone();
                    spawn.node_name = node.node_name.clone();
                }
            }
        });
        self.hub.invalidated(Listing::Agents);
    }

    /// Settles every spawn of this connection's workspace a restart
    /// interrupted, leaving those still starting in this core alone. An
    /// agent that is not kept is taken off the node once the connection
    /// runs; its intent stays, marked ended, until Relaycast confirms, so a
    /// deregistration lost with the socket or refused is sent again on the
    /// next connection. A spawn of another workspace (the account switched
    /// while it started) is left on disk untouched, for a node of its own
    /// workspace: its agent is never restored, stopped or taken off over
    /// this one.
    pub(super) async fn recover_spawns(&self, link: &NodeLink) {
        let Some(mut workspace) = self.workspace() else {
            return;
        };
        // A key from the environment or the app store carries no id; the
        // verified one lets intents saved under a rotated key still match.
        workspace.workspace_id = self.verified_workspace_id();
        let app_data_dir = self.config.app_data_dir.clone();
        let ours = intents::load(&app_data_dir)
            .into_iter()
            .filter_map(|intent| adopt_receipted_intent(&app_data_dir, intent, &workspace));
        for mut intent in ours {
            {
                let ledger = self.ledger();
                let mut state = ledger.lock();
                if state.reserved.contains(&intent.invocation_id) {
                    continue;
                }
                if let Some(cleanup) = state.failed.get_mut(&intent.invocation_id) {
                    if cleanup.since.elapsed() < super::node::RESULT_KEEP {
                        cleanup.link = link.clone();
                        continue;
                    }
                }
                state.failed.remove(&intent.invocation_id);
                // Settled afresh: listed again only if still unsaved.
                state.unsaved.remove(&intent.invocation_id);
            }
            if self.saved(&intent) {
                // Saved just before the core stopped.
                let _ = intents::remove(&app_data_dir, &intent);
                continue;
            }
            let Some(agent_id) = intent.agent_id.clone() else {
                if intent.register_sent {
                    // Registered, perhaps, with the id never received.
                    self.settle_unanswered(link.clone(), intent, Unanswered::Lost);
                } else {
                    // Never registered on Relaycast, so never launched.
                    let _ = intents::remove(&app_data_dir, &intent);
                }
                continue;
            };
            if !intent.ended {
                match self.keep_interrupted(link, &intent, &agent_id).await {
                    Settled::Kept => {
                        let _ = intents::remove(&app_data_dir, &intent);
                        continue;
                    }
                    // Still running and unsaved: listed and tried again
                    // rather than ended.
                    Settled::Retry => continue,
                    Settled::Ended => {}
                }
            }
            if !self.record_recovered_failure(link, &intent, &workspace) {
                continue;
            }
            if !intent.ended {
                let Ok(Some(updated)) =
                    intents::update_attempt(&app_data_dir, &intent, |current| current.ended = true)
                else {
                    continue;
                };
                intent = updated;
            }
            deregister(link.clone(), app_data_dir.clone(), agent_id, intent);
        }
    }

    /// Never discard an ended recovery intent without a durable terminal answer.
    /// Older cores may have saved no reason; report that gap instead of inventing one.
    fn record_recovered_failure(
        &self,
        link: &NodeLink,
        intent: &Intent,
        workspace: &Workspace,
    ) -> bool {
        let request = wire::SpawnRequest {
            invocation_id: intent.invocation_id.clone(),
            name: intent.name.clone(),
            harness: intent.harness,
            task: String::new(),
            directory: None,
        };
        let error = super::invoke::SpawnError::from(
            "spawn_failed: Agent Relay recovered an ended launch without a recorded result; the original harness reason is unavailable.");
        match super::completions::Scope::workspace(workspace).save_failure(
            &self.config.app_data_dir,
            &request,
            error,
        ) {
            Ok(completion) => {
                if let Err(error) = completion.replay(&request) {
                    let frame = error.result(&request.invocation_id, link);
                    crate::relay::diagnostics::write(format_args!(
                        "Agent Relay recovered failed spawn {}: {}",
                        request.invocation_id,
                        crate::relay::harness::diagnostics::redact(&frame.to_string())
                    ));
                    link.send(frame);
                }
                true
            }
            Err(_) => {
                crate::relay::diagnostics::write(format_args!(
                    "Agent Relay could not save recovered failure {}; retaining its intent",
                    request.invocation_id
                ));
                false
            }
        }
    }

    /// Tries again to save the running agents recovery could not, before
    /// each inventory, so one is kept on the live connection rather than
    /// the next. One whose name another agent took meanwhile is no longer
    /// listed: its intent stays for the next connection to end it.
    pub(super) fn save_unsaved(&self) {
        let ledger = self.ledger();
        let unsaved: Vec<Unsaved> = ledger.lock().unsaved.values().cloned().collect();
        for unsaved in unsaved {
            let (registration, token) = (unsaved.registration, unsaved.token);
            let Ok(saved) = self
                .store
                .update(|store| super::report_back::add_spawned(store, registration, token))
            else {
                continue;
            };
            ledger.lock().unsaved.remove(&unsaved.intent.invocation_id);
            if saved {
                let _ = intents::remove(&self.config.app_data_dir, &unsaved.intent);
                self.kept(&unsaved.intent.name);
            } else {
                self.spawn_places_changed();
            }
        }
    }

    /// Whether the intent's invocation already has its registration.
    pub(super) fn saved(&self, intent: &Intent) -> bool {
        self.store.read(|store| {
            store.registrations.iter().any(|r| {
                r.spawn
                    .as_ref()
                    .is_some_and(|spawn| spawn.invocation_id == intent.invocation_id)
            })
        })
    }

    /// Keeps the agent of one interrupted spawn if it still runs and spawns
    /// are on, stored as the spawn would have stored it; otherwise stops
    /// whatever of it was found and reports it ended. One found that no
    /// longer runs is still handed to its harness to stop: what it left
    /// (Muse's detached host, say) is ended there, after the harness proves
    /// it owns it. A store that could not be written keeps a running agent
    /// as it is, `Unsaved`, for a later inventory to save.
    async fn keep_interrupted(&self, link: &NodeLink, intent: &Intent, agent_id: &str) -> Settled {
        let found = self.found(intent).await;
        if let Some(workspace) = self.workspace() {
            let failed = match super::completions::Scope::workspace(&workspace)
                .load(&self.config.app_data_dir, &intent.invocation_id)
            {
                Ok(completion) => {
                    intent.launch_failed
                        || completion.is_some_and(|completion| completion.failed())
                }
                Err(_) => return Settled::Retry,
            };
            if failed {
                // A failed launch may have left an unkillable process. Never
                // promote it to a successful agent after restarting.
                if let Some(found) = found {
                    let spawner = self.plugins.spawner.clone();
                    let stopped = tokio::task::spawn_blocking(move || {
                        spawner.release(&found.target, found.process.as_ref())
                    })
                    .await
                    .is_ok_and(|result| result.is_ok());
                    if !stopped {
                        return Settled::Retry;
                    }
                }
                return Settled::Ended;
            }
        }
        if let (Some(found), Some(token)) = (found.as_ref(), intent.token.clone()) {
            if found.alive && self.spawn_settings().accept {
                let node = (link.node.node_id.as_str(), link.node.node_name.as_str());
                let registration =
                    intent.registration(agent_id, found.target.clone(), found.process, node);
                let saving = (registration.clone(), token.clone());
                match self
                    .store
                    .update(|store| super::report_back::add_spawned(store, saving.0, saving.1))
                {
                    Ok(true) => {
                        self.kept(&intent.name);
                        return Settled::Kept;
                    }
                    Err(error) => {
                        self.unsaved(intent, registration, token, &link.node.node_id);
                        self.hub.activity(
                            Level::Warning,
                            format!(
                                "Agent Relay could not save @{}, which it spawned before it restarted; it keeps it listed and tries again: {error}",
                                intent.name
                            ),
                        );
                        return Settled::Retry;
                    }
                    // Its name is held by another agent: it cannot be kept.
                    Ok(false) => {}
                }
            }
        }
        if let Some(Found {
            target, process, ..
        }) = found
        {
            let spawner = self.plugins.spawner.clone();
            let _ =
                tokio::task::spawn_blocking(move || spawner.stop(&target, process.as_ref())).await;
        }
        self.hub.activity(
            Level::Warning,
            format!(
                "Agent Relay ended @{}: it restarted while spawning it.",
                intent.name
            ),
        );
        Settled::Ended
    }

    /// Lists a running agent the store could not take yet, holding its
    /// place, until `save_unsaved` saves it.
    fn unsaved(&self, intent: &Intent, registration: Registration, token: Secret, node_id: &str) {
        let agent = InventoryAgent {
            agent_id: registration.agent_id.clone(),
            name: registration.name.clone(),
            invocation_id: intent.invocation_id.clone(),
            session_ref: session_ref(&intent.invocation_id),
        };
        let unsaved = Unsaved {
            intent: intent.clone(),
            registration,
            token,
            listed: (node_id.to_string(), agent),
        };
        self.ledger()
            .lock()
            .unsaved
            .insert(intent.invocation_id.clone(), unsaved);
        self.spawn_places_changed();
    }

    /// The interrupted spawn's session and process, when found, and whether
    /// they still run.
    async fn found(&self, intent: &Intent) -> Option<Found> {
        let spawner = self.plugins.spawner.clone();
        let intent = intent.clone();
        tokio::task::spawn_blocking(move || {
            spawner.find(&intent).map(|(target, process)| Found {
                alive: spawner.alive(&target, process.as_ref()),
                target,
                process,
            })
        })
        .await
        .ok()
        .flatten()
    }

    /// A kept agent is present as a spawn's is: on the node's connection,
    /// listed, delivered to, and holding its place.
    pub(super) fn kept(&self, name: &str) {
        self.hub.update(|status| {
            if status.spawn.as_ref().map(|spawn| spawn.state) == Some(SpawnState::Live) {
                status.push.insert(name.to_string(), PushState::Live);
            }
        });
        self.hub.invalidated(Listing::Agents);
        self.hub.activity(
            Level::Info,
            format!("Agent Relay kept @{name}, which it spawned before it restarted."),
        );
        self.request_drain(name);
        self.spawn_places_changed();
    }
}
