//! Running the spawn node for the core: starting and stopping it with the
//! settings and the workspace, what it advertises, and the core as the node
//! sees it (`CoreHost`).

use super::lifecycle::{self, NodeSeen, WorkCounts};
use super::node::{NodeConfig, NodeHost, NodeInfo, NodeLink, SpawnNode};
use super::node_name;
use super::resources;
use super::wire::{
    self, Advertisement, Configured, HarnessConfigured, HarnessId, InventoryAgent, Invoke, Live,
    LiveAgent, SpawnFailure,
};
use crate::relay::daemon::Core;
use crate::relay::harness;
use crate::relay::push::PushState;
use crate::relay::state::{Level, SpawnSlots, SpawnState, SpawnStatus};
use crate::relay::workspace::Secret;
use chrono::Utc;
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::{Arc, Weak};
use tokio::sync::Notify;

impl Core {
    /// The node this computer should run now, if any: spawns are on, there
    /// is a workspace, and a harness it can spawn is installed.
    fn wanted_spawn_node(&self) -> Result<NodeConfig, Option<String>> {
        let settings = self.spawn_settings();
        if !settings.accept {
            return Err(None);
        }
        let workspace = self
            .workspace()
            .ok_or_else(|| Some("No Agent Relay workspace on this computer.".to_string()))?;
        let harnesses = self.plugins.spawner.available();
        if harnesses.is_empty() {
            return Err(Some(
                "No agent command line Agent Relay can spawn is installed on this computer.".into(),
            ));
        }
        Ok(NodeConfig {
            base_url: workspace.base_url,
            workspace_key: workspace.key,
            node_name: node_name(&self.machine_prefix),
            version: self.config.version.clone(),
            app_data_dir: self.config.app_data_dir.clone(),
            harnesses,
            repositories: settings.repositories,
        })
    }

    /// Starts, replaces or stops the spawn node to match the settings and
    /// the workspace.
    pub async fn sync_spawn_node(&self) {
        let wanted = self.wanted_spawn_node();
        let mut running = self.spawn_node.lock().await;
        if let (Some(node), Ok(config)) = (running.as_ref(), &wanted) {
            if node.config() == config {
                // The maximum or teammates may have changed: a heartbeat
                // carries them at once.
                self.spawn_places_changed();
                return;
            }
        }
        if let Some(node) = running.take() {
            node.stop().await;
        }
        match wanted {
            Ok(config) => {
                let host = Arc::new(CoreHost(self.me.clone()));
                let results = self.ledger().results.clone();
                *running = Some(SpawnNode::start_with(config, host, results));
                // Reconcile with the sessions that really run before the
                // first inventory goes far.
                self.schedule_spawn_observation(true);
            }
            Err(error) => {
                self.hub.update(|status| {
                    status.spawn = Some(SpawnStatus {
                        error,
                        harness_descriptors: Some(harness::published()),
                        ..SpawnStatus::default()
                    })
                });
                self.ledger().lock().node = None;
                self.mirror_spawned_push(SpawnState::Off);
            }
        }
    }

    pub(crate) async fn stop_spawn_node(&self) {
        if let Some(node) = self.spawn_node.lock().await.take() {
            node.stop().await;
        }
    }

    /// Spawned agents have no push channel of their own: the node's
    /// connection stands in for theirs.
    fn mirror_spawned_push(&self, state: SpawnState) {
        let names: Vec<String> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| r.spawn.is_some())
                .map(|r| r.name.clone())
                .collect()
        });
        self.hub.update(|status| {
            for name in names {
                match state {
                    SpawnState::Live => {
                        status.push.insert(name, PushState::Live);
                    }
                    SpawnState::Connecting => {
                        status.push.insert(name, PushState::Connecting);
                    }
                    SpawnState::Waiting | SpawnState::Off => {
                        status.push.remove(&name);
                    }
                }
            }
        });
    }

    /// Each harness's quota, for `metadata.live.quota`. The hook for
    /// `relay::quota`: it must read only `QuotaCache::snapshot(now)` (an
    /// instant cache read; readings older than 180 s come back unknown),
    /// never `quota::collect`, whose helpers take up to 35 s against a 12 s
    /// heartbeat. The cache refreshes itself (`spawn_refresh`, every 120 s).
    /// No lane is on until each provider is approved, so nothing is
    /// reported and the field is `null`.
    fn harness_quota(&self, _harnesses: &[HarnessId]) -> Vec<(HarnessId, wire::QuotaSignal)> {
        Vec::new()
    }

    /// What the node says about itself now: the configured facts, and the
    /// live ones measured for this frame.
    pub(super) fn spawn_advertisement(
        &self,
        harnesses: &[HarnessId],
        repositories: &[String],
    ) -> Advertisement {
        let settings = self.spawn_settings();
        // Another account owns the node: it offers no spawns until released.
        let harnesses = if self.spawns_blocked() {
            &[]
        } else {
            harnesses
        };
        let registrations = self.spawned_registrations();
        let now = Utc::now();
        let ledger = self.ledger();
        let mut state = ledger.lock();
        let slots = self.slots_in(&state);
        let mut work = WorkCounts::default();
        let mut agents = Vec::new();
        for registration in &registrations {
            let record = state
                .agents
                .get(&registration.name)
                .cloned()
                .unwrap_or_default();
            let (process, evidence) = (record.process_evidence(now), record.work_evidence(now));
            if record.holds_slot() {
                work.add(evidence.state);
            }
            agents.push(LiveAgent {
                name: registration.name.clone(),
                agent_id: registration.agent_id.clone(),
                harness: registration
                    .spawn
                    .as_ref()
                    .map(|s| s.harness.clone())
                    .unwrap_or_default(),
                holds_slot: record.holds_slot(),
                process,
                work: evidence,
            });
        }
        state.advertised_free = slots.free();
        let reclaimed = state.reclaimed.iter().cloned().collect();
        drop(state);
        Advertisement {
            configured: Configured {
                max_agents: settings.max_agents,
                machine: self.host_label(),
                teammates: settings.allow_teammates,
                repositories: repositories.to_vec(),
                harnesses: harnesses
                    .iter()
                    .map(|harness| HarnessConfigured {
                        harness: *harness,
                        billing: settings.billing(*harness),
                        full_access: settings.full_access(*harness),
                    })
                    .collect(),
            },
            live: Live {
                observed_at: lifecycle::iso(now),
                slots,
                work,
                resources: resources::sample(),
                agents,
                reclaimed,
                quota: self.harness_quota(harnesses),
            },
        }
    }
}

/// The core, as the spawn node sees it.
pub(super) struct CoreHost(pub(super) Weak<Core>);

impl NodeHost for CoreHost {
    fn invoke(&self, link: NodeLink, invoke: Invoke) -> BoxFuture<'static, Value> {
        let core = self.0.upgrade();
        Box::pin(async move {
            let Some(core) = core else {
                return match invoke {
                    Invoke::Spawn(r) => wire::action_failure(
                        &r.invocation_id,
                        &SpawnFailure {
                            code: wire::TARGET_UNAVAILABLE,
                            message: "Agent Relay on this computer is stopping".into(),
                            node: link.node.node_name.clone(),
                            harness: Some(r.harness),
                            active: None,
                            reserved: None,
                            max: None,
                            observed_at: lifecycle::iso(Utc::now()),
                            retryable: true,
                        },
                        link.error_details,
                    ),
                    Invoke::Release(r) => {
                        wire::action_error(&r.invocation_id, "release_failed: stopping")
                    }
                    Invoke::Other { invocation_id } => {
                        wire::action_error(&invocation_id, "handler_unavailable")
                    }
                };
            };
            match invoke {
                Invoke::Spawn(request) => core.answer_spawn(link, request).await,
                Invoke::Release(request) => core.answer_release(request).await,
                Invoke::Other { invocation_id } => {
                    wire::action_error(&invocation_id, "handler_unavailable")
                }
            }
        })
    }

    fn inventory(&self, node: &NodeInfo) -> Vec<InventoryAgent> {
        self.0
            .upgrade()
            .map(|core| {
                core.save_unsaved();
                core.carry_over_spawned(node);
                core.spawned_inventory(node)
            })
            .unwrap_or_default()
    }

    fn deliver(&self, agent: &str, frame: Value) {
        let Some(core) = self.0.upgrade() else {
            return;
        };
        let ours = core.store.read(|store| {
            store
                .registrations
                .iter()
                .any(|r| r.name == agent && r.spawn.is_some())
        });
        if ours {
            core.wake(agent.to_string(), Some(frame));
        }
    }

    fn state(&self, mut status: SpawnStatus) {
        let Some(core) = self.0.upgrade() else {
            return;
        };
        let state = status.state;
        {
            let ledger = core.ledger();
            let mut ledger = ledger.lock();
            let now = Utc::now();
            ledger.node = match (state, ledger.node) {
                (SpawnState::Live, _) => Some(NodeSeen::Reached(now)),
                (SpawnState::Waiting, Some(NodeSeen::Down(since))) => Some(NodeSeen::Down(since)),
                (SpawnState::Waiting, _) => Some(NodeSeen::Down(now)),
                (SpawnState::Connecting, seen) => seen,
                (SpawnState::Off, _) => None,
            };
        }
        if state != SpawnState::Off {
            status.slots = Some(core.spawn_slots());
        }
        status.harness_descriptors = Some(harness::published());
        core.dress_spawn_status(&mut status);
        core.hub.update(|snapshot| snapshot.spawn = Some(status));
        core.mirror_spawned_push(state);
        if state == SpawnState::Live {
            // Anything sent while the node was down.
            let names: Vec<String> = core.store.read(|store| {
                store
                    .registrations
                    .iter()
                    .filter(|r| r.spawn.is_some())
                    .map(|r| r.name.clone())
                    .collect()
            });
            for name in names {
                core.request_drain(&name);
            }
        }
    }

    fn advertisement(&self, harnesses: &[HarnessId], repositories: &[String]) -> Advertisement {
        match self.0.upgrade() {
            Some(core) => core.spawn_advertisement(harnesses, repositories),
            None => Advertisement {
                configured: Configured {
                    max_agents: lifecycle::DEFAULT_MAX_AGENTS,
                    machine: String::new(),
                    teammates: false,
                    repositories: repositories.to_vec(),
                    harnesses: Vec::new(),
                },
                live: Live {
                    observed_at: lifecycle::iso(Utc::now()),
                    slots: SpawnSlots::default(),
                    work: WorkCounts::default(),
                    resources: resources::Resources::default(),
                    agents: Vec::new(),
                    reclaimed: Vec::new(),
                    quota: Vec::new(),
                },
            },
        }
    }

    fn heartbeat_sent(&self) {
        if let Some(core) = self.0.upgrade() {
            core.ledger().lock().node = Some(NodeSeen::Reached(Utc::now()));
        }
    }

    fn changed(&self) -> Arc<Notify> {
        self.0
            .upgrade()
            .map(|core| core.ledger().changed.clone())
            .unwrap_or_default()
    }

    fn claim_now(&self) -> Arc<Notify> {
        self.0
            .upgrade()
            .map(|core| core.ledger().claim_now.clone())
            .unwrap_or_default()
    }

    fn claim(&self, node: &NodeInfo, token: &Secret) {
        if let Some(core) = self.0.upgrade() {
            core.check_spawn_claim(node, token);
        }
    }

    fn refused(&self, message: String) {
        if let Some(core) = self.0.upgrade() {
            core.hub.activity(Level::Warning, message);
        }
    }

    fn sent(&self, frame: &Value) {
        let invocation = frame["invocation_id"].as_str();
        if let (Some(core), Some(invocation)) = (self.0.upgrade(), invocation) {
            core.release_result_sent(invocation);
            core.failed_spawn_result_sent(invocation);
        }
    }

    fn connected(&self, link: NodeLink) -> BoxFuture<'static, ()> {
        let core = self.0.upgrade();
        Box::pin(async move {
            if let Some(core) = core {
                core.restore_spawn_origins(&link.node).await;
                core.recover_spawns(&link).await;
            }
        })
    }
}
