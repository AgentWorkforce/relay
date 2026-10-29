//! Spawning: Agent Relay starting agents on this computer, headless, through
//! each vendor's own interface instead of the `agent-relay` broker's PTY.
//! Each harness is one adapter in `relay::harness`, known by its id
//! (`spawn:<id>`), with its own launch, observation and settings.
//!
//! ```text
//! Cloud spawn_relay_agent ─▶ Relaycast action.invoke spawn:<harness> ─▶ spawn node (node)
//!     ─▶ reserve a place (lifecycle::admit) or refuse: spawn_capacity_exceeded | capacity_changed
//!     ─▶ agent.register on the node (Relaycast stamps metadata.fleet)
//!     ─▶ launch headless (launch): Codex app-server thread │ claude -p stream-json
//!     ─▶ store the agent like any other registration ─▶ action.result {spawned, ready, name}
//! later: Relaycast deliver ─▶ wake ─▶ the usual delivery: HTTP read, inject, HTTP ack
//! every 15 s: observe each spawned agent (observe) ─▶ lifecycle evidence; an end seen
//!     reclaims its place and reports what it left unfinished
//! ```
//!
//! Off until the person turns on "Accept spawns" in Settings. A spawned agent
//! is an ordinary registration with a `spawn` origin: it is listed, delivered
//! to and removed like any other, but it is hosted on the spawn node rather
//! than its own direct node, so it opens no push channel of its own and is
//! never auto-activated a second time.
//!
//! The node advertises what the person configured apart from what it
//! measures (`wire::Advertisement`), and never chooses for a requester: a
//! spawn it cannot place is refused with an explicit outcome, never queued
//! or sent elsewhere. See `docs/node-lifecycle.md`.
//!
//! The core's side is split by concern: `settings` (what the person
//! configured), `ledger` (places and evidence held in memory), `reconcile`
//! (observing spawned agents and reclaiming places), `invoke` (answering
//! spawn and release invocations), `host` (running the node and what it
//! advertises), `intents` with `recover` (spawns in flight kept on disk
//! and settled after a restart; agents carried over to a new node id),
//! `unanswered` (registering a spawn's agent, and settling one whose
//! `agent.register` went unanswered), `handover` (the apps joining a
//! spawned agent and taking it over) and `claim` (recording the node as the
//! signed-in person's in Agent Relay).

mod actions;
mod claim;
mod completions;
pub(crate) mod control;
pub(crate) mod drive;
mod failed;
pub mod handover;
mod host;
pub mod intents;
mod invoke;
pub mod launch;
mod ledger;
pub mod lifecycle;
pub mod node;
pub mod observe;
mod reconcile;
mod recover;
mod release;
pub mod report_back;
pub mod resources;
mod restore_origin;
pub mod settings;
mod unanswered;
pub mod wire;

pub use claim::OWNED_BY_OTHER;
pub use reconcile::ended_line;
pub use report_back::ReportBack;
pub use settings::{configured_values, ConfiguredChange, SpawnSettings, CONFIGURED_KEYS};

use crate::relay::daemon::Core;
use crate::relay::store::{Registration, Target};
use std::collections::HashSet;

/// The spawn node's name, distinct from a broker node this computer may
/// also run: `<machine prefix>-desktop`.
pub fn node_name(machine_prefix: &str) -> String {
    format!("{machine_prefix}-desktop")
}

/// The first message a spawned agent reads: who it is and who asked for it,
/// how to report back over the session socket, then its task.
pub fn first_text(name: &str, address: &str, task: &str, report: &ReportBack) -> String {
    let header = report.header(name, address);
    let header = match report.lines() {
        Some(lines) => format!("{header}\n{lines}"),
        None => header,
    };
    if task.is_empty() {
        format!("{header}\n\nYou were started by Agent Relay with no task yet. Wait for a message.")
    } else {
        format!("{header}\n\n{task}")
    }
}

/// `session_ref` for a spawned agent: the invocation that made it.
fn session_ref(invocation_id: &str) -> String {
    format!("spawn:{invocation_id}")
}

impl Core {
    pub(crate) fn spawn_settings(&self) -> SpawnSettings {
        self.store.read(SpawnSettings::of)
    }

    /// The spawned registrations still on the relay here.
    fn spawned_registrations(&self) -> Vec<Registration> {
        self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| r.spawn.is_some() && r.archived_at.is_none())
                .cloned()
                .collect()
        })
    }

    /// The sessions this computer spawned, so discovery never registers
    /// them a second time.
    pub(crate) fn spawned_targets(&self) -> HashSet<Target> {
        self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| r.spawn.is_some())
                .map(|r| r.target.clone())
                .collect()
        })
    }

    /// Saves a spawned agent's receipt before it is taken off the relay
    /// here: its registration may be its invocation's only record (one kept
    /// after a restart), and a late replay must be answered, not relaunched.
    pub(crate) fn keep_spawn_receipt(
        &self,
        registration: &Registration,
    ) -> Result<(), crate::relay::protocol::RpcError> {
        self.preserve_spawn_completion(registration)
            .map_err(|error| {
                crate::relay::protocol::RpcError::new(
                    crate::relay::protocol::ErrorKind::StoreFailed,
                    format!(
                        "@{} was kept: its spawn receipt could not be saved. {error}",
                        registration.name
                    ),
                )
            })
    }

    /// Ends a spawned agent's process when it is taken off the relay here.
    /// One taken over runs in the person's own client, which is left alone.
    pub(crate) fn stop_spawned(&self, registration: &Registration) {
        if let Some(spawn) = &registration.spawn {
            if spawn.taken_over_at.is_none() {
                self.plugins
                    .spawner
                    .stop(&registration.target, spawn.process.as_ref());
            }
            self.forget_spawned(&registration.name);
        }
    }
}

/// Who a registration's agent works for, as delivery may act on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ownership {
    /// Bound at the spawn from evidence Agent Relay vouches for.
    Known(crate::relay::store::SpawnOwner),
    /// Not known: the agent is a peer to everyone, with no owner input.
    Unknown,
}

/// The owner bound to a spawned agent; `Unknown` for any agent without a
/// verified binding, including every agent not spawned here.
pub fn owner_of(registration: &Registration) -> Ownership {
    match registration
        .spawn
        .as_ref()
        .and_then(|spawn| spawn.owner.clone())
    {
        Some(owner) => Ownership::Known(owner),
        None => Ownership::Unknown,
    }
}

/// Whether `delivery` is a direct message from the agent that asked for
/// `registration`'s spawn, matched by the immutable Relaycast sender id the
/// spawn recorded (`spawn.requester`), never by name: a name can be taken
/// again, and a body can claim anything. Such a message is framed as the
/// owner's (`policy::OWNER_LINE`). An agent not spawned here, or one the
/// person took over, has no requester.
pub fn from_requester(
    registration: &Registration,
    delivery: &crate::relay::delivery::policy::Delivery,
) -> bool {
    registration
        .spawn
        .as_ref()
        .filter(|spawn| spawn.taken_over_at.is_none())
        .and_then(|spawn| spawn.requester.as_ref())
        .map(|requester| requester.agent_id.as_str())
        .is_some_and(|id| !id.is_empty() && drive::direct_from(delivery, Some(id)))
}

#[cfg(test)]
mod tests {
    use super::host::CoreHost;
    use super::invoke::{register_error, SpawnError};
    use super::launch::{Launch, LaunchError, TaskHandoff};
    use super::ledger::LEDGERS;
    use super::node::{NodeHost, NodeInfo, NodeLink};
    use super::observe::{Observe, Watched};
    use super::wire::{Billing, InventoryAgent, Invoke, ReleaseRequest, SpawnRequest};
    use super::*;
    use crate::relay::harness::{claude, codex, HarnessId};
    use crate::relay::spawn::launch::{Launched, SpawnedProcess, Spawner};
    use crate::relay::spawn::lifecycle::Observation;
    use crate::relay::state::{NodeReach, WorkState};
    use crate::relay::state::{ProcessLiveness, SpawnSlots, SpawnState, SpawnStatus};
    use crate::relay::store::SessionKind;
    use crate::relay::store::Store;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bdb7b";

    #[derive(Default)]
    struct FakeSpawner {
        launched: Mutex<Vec<Launch>>,
        stopped: Mutex<Vec<Target>>,
        refuse: bool,
        unconfirmed: bool,
        /// Every session it is asked about has ended.
        dead: bool,
        /// A release whose end the harness cannot confirm.
        unreleasable: bool,
        /// A launch that starts its session, then panics.
        panics: bool,
        /// A launch that starts its session, then fails.
        fails_started: bool,
        /// When set, a launch says it started and waits to be let go.
        pause: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
        /// Its agents take native user turns.
        native: bool,
    }

    /// Answers each agent by name; `Running`/`Idle` for one not set.
    #[derive(Default)]
    struct FakeObserver(Mutex<HashMap<String, Observation>>);

    impl FakeObserver {
        fn set(&self, name: &str, process: ProcessLiveness, work: WorkState, turn: bool) {
            self.0.lock().unwrap().insert(
                name.into(),
                Observation {
                    process,
                    work,
                    turn_in_progress: turn,
                },
            );
        }
    }

    impl Observe for FakeObserver {
        fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
            let set = self.0.lock().unwrap();
            agents
                .iter()
                .map(|agent| {
                    set.get(&agent.name).copied().unwrap_or(Observation {
                        process: ProcessLiveness::Running,
                        work: WorkState::Idle,
                        turn_in_progress: false,
                    })
                })
                .collect()
        }
    }

    impl Spawner for FakeSpawner {
        fn available(&self) -> Vec<HarnessId> {
            vec![codex::ID]
        }

        fn launch(
            &self,
            launch: &Launch,
            started_session: super::launch::Started,
        ) -> Result<Launched, LaunchError> {
            let mut launched = self.launched.lock().unwrap();
            launched.push(launch.clone());
            drop(launched);
            if self.panics {
                started_session(&Target::new(SessionKind::Codex, THREAD), None);
                panic!("the launch worker panicked");
            }
            if self.fails_started {
                started_session(&Target::new(SessionKind::Codex, THREAD), None);
                return Err(LaunchError::Failed("Codex refused the first turn".into()));
            }
            if let Some((started, proceed)) = self.pause.lock().unwrap().take() {
                started.send(()).unwrap();
                proceed.recv().unwrap();
            }
            let launched = self.launched.lock().unwrap();
            if self.refuse {
                return Err(LaunchError::Failed("Codex refused the first turn".into()));
            }
            // A thread of its own for each launch.
            let thread = format!("{}{:012x}", &THREAD[..24], launched.len());
            Ok(Launched {
                target: Target::new(SessionKind::Codex, thread),
                process: None,
                task: if self.unconfirmed {
                    TaskHandoff::Unconfirmed("transport_closed")
                } else {
                    TaskHandoff::Confirmed
                },
            })
        }

        fn alive(&self, _: &Target, _: Option<&SpawnedProcess>) -> bool {
            !self.dead
        }

        fn native_input(&self, _: &Target) -> bool {
            self.native
        }

        fn stop(&self, target: &Target, _: Option<&SpawnedProcess>) {
            self.stopped.lock().unwrap().push(target.clone());
        }

        fn release(&self, target: &Target, process: Option<&SpawnedProcess>) -> Result<(), String> {
            self.stop(target, process);
            match self.unreleasable {
                true => Err("Codex did not archive its thread: timed out".into()),
                false => Ok(()),
            }
        }
    }

    mod lifecycle_failures;
    mod native_sender;
    mod owner_framing;
    mod owner_turns;
    mod release_inventory;
    mod report_back;
    mod restart_reasons;
    mod unanswered_register;

    #[tokio::test]
    async fn the_node_starts_when_the_workspace_is_found_after_the_first_sync() {
        let home = tempfile::tempdir().unwrap();
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(home.path().join("core.sock"))
                .unwrap(),
            home: home.path().into(),
            app_data_dir: home.path().join("app-data"),
            // No key yet; nothing listens at the origin, so nothing leaves.
            env: [(
                "RELAYCAST_URL".to_string(),
                "http://localhost:9".to_string(),
            )]
            .into(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let plugins = crate::relay::daemon::Plugins {
            spawner: Arc::new(FakeSpawner::default()),
            ..crate::relay::daemon::Plugins::default()
        };
        let (core, _signals) = Core::with_plugins(config, plugins);
        core.store
            .update(|store| store.accept_spawns = Some(true))
            .unwrap();
        // The first sync at start, before discovery: no node.
        core.sync_spawn_node().await;
        assert!(core.spawn_node.lock().await.is_none());
        core.store
            .update(|store| {
                store.cloud = Some(crate::relay::store::CloudWorkspace {
                    key: crate::relay::workspace::Secret::new("rk_live_test0000"),
                    ..Default::default()
                })
            })
            .unwrap();
        core.rediscover_workspace();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while core.spawn_node.lock().await.is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the node never started"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        core.stop_spawn_node().await;
    }

    fn core(home: &std::path::Path, spawner: Arc<FakeSpawner>) -> Arc<Core> {
        // Nothing listens: counting a queue fails at once, offline.
        core_at(home, spawner, "http://localhost:9")
    }

    /// A core whose Relaycast REST API is at `relaycast`.
    fn core_at(home: &std::path::Path, spawner: Arc<FakeSpawner>, relaycast: &str) -> Arc<Core> {
        core_signed_in(
            home,
            spawner,
            Arc::new(crate::relay::cloud_session::SignedOut),
            relaycast,
        )
    }

    /// A core signed in to `cloud`.
    fn core_with(
        home: &std::path::Path,
        spawner: Arc<FakeSpawner>,
        cloud: Arc<dyn crate::relay::cloud_session::CloudAccess>,
    ) -> Arc<Core> {
        core_signed_in(home, spawner, cloud, "http://localhost:9")
    }

    /// A core signed in to `cloud` whose Relaycast REST API is at `relaycast`.
    fn core_signed_in(
        home: &std::path::Path,
        spawner: Arc<FakeSpawner>,
        cloud: Arc<dyn crate::relay::cloud_session::CloudAccess>,
        relaycast: &str,
    ) -> Arc<Core> {
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: home.join("app-data"),
            env: Default::default(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let plugins = crate::relay::daemon::Plugins {
            spawner,
            cloud,
            ..crate::relay::daemon::Plugins::default()
        };
        let (core, _signals) = Core::with_plugins(config, plugins);
        core.store
            .update(|store| {
                store.cloud = Some(crate::relay::store::CloudWorkspace {
                    key: crate::relay::workspace::Secret::new("rk_live_test0000"),
                    base_url: relaycast.into(),
                    ..Default::default()
                });
                store.accept_spawns = Some(true)
            })
            .unwrap();
        core.rediscover_workspace();
        // A fresh ledger, as a newly started core has.
        LEDGERS.lock().unwrap().remove(&core.config.app_data_dir);
        core
    }

    fn observed(core: &Core) -> Arc<FakeObserver> {
        let observer = Arc::new(FakeObserver::default());
        core.ledger().set_observer(observer.clone());
        observer
    }

    /// Spawns over a connection whose Relaycast accepted `error_details`.
    async fn spawn(core: &Arc<Core>, name: &str) -> Value {
        spawn_over(core, name, true).await
    }

    /// Spawns over a connection that did (`details`) or did not accept
    /// `error_details` at its `node.register`.
    async fn spawn_over(core: &Arc<Core>, name: &str, details: bool) -> Value {
        let (mut link, sent) = NodeLink::detached(node());
        link.error_details = details;
        let _frames = relaycast(link.clone(), sent);
        let result = core.clone().answer_spawn(link, request(name)).await;
        CoreHost(Arc::downgrade(core)).sent(&result);
        result
    }

    fn node() -> NodeInfo {
        NodeInfo {
            node_id: "node_desktop_1".into(),
            node_name: "test-desk-desktop".into(),
        }
    }

    fn request(name: &str) -> SpawnRequest {
        SpawnRequest {
            invocation_id: format!("inv_{name}"),
            harness: codex::ID,
            name: name.into(),
            task: "Fix CI".into(),
            directory: None,
        }
    }

    /// Answers every `agent.register` on the link as Relaycast does.
    fn relaycast(
        link: NodeLink,
        mut sent: tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) -> impl std::future::Future<Output = Result<Vec<Value>, tokio::task::JoinError>> {
        let (finish, mut finished) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut frames = Vec::new();
            loop {
                // Collect until the caller finishes the operation and awaits
                // the frames, draining already queued frames first. Slow disk
                // writes must not make the fake disconnect after 500 ms.
                let frame = tokio::select! {
                    biased;
                    frame = sent.recv() => match frame {
                        Some(frame) => frame,
                        None => break,
                    },
                    _ = &mut finished => break,
                };
                if frame["type"] == "agent.register" {
                    let name = frame["name"].as_str().unwrap_or_default();
                    link.answer(
                        &serde_json::json!({"v": 1, "id": frame["id"], "type": "reply",
                        "ok": true, "data": {"agent_id": format!("agent_{name}"),
                        "name": name, "token": format!("at_live_{name}")}}),
                    );
                }
                frames.push(frame);
            }
            frames
        });
        async move {
            let _ = finish.send(());
            task.await
        }
    }

    #[tokio::test]
    async fn the_fake_relay_keeps_collecting_until_the_operation_finishes() {
        let (link, sent) = NodeLink::detached(node());
        let frames = relaycast(link.clone(), sent);
        tokio::time::sleep(Duration::from_millis(600)).await;
        link.send(serde_json::json!({"type": "agent.deregister"}));
        assert_eq!(frames.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_agent_still_launching_is_in_the_inventory() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let (started_tx, started) = std::sync::mpsc::channel();
        let (proceed, proceed_rx) = std::sync::mpsc::channel();
        *spawner.pause.lock().unwrap() = Some((started_tx, proceed_rx));
        let core = core(home.path(), spawner.clone());
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let spawning = tokio::spawn(core.clone().answer_spawn(link, request("w1")));
        tokio::task::spawn_blocking(move || started.recv().unwrap())
            .await
            .unwrap();
        // Registered on the node, not yet saved: an inventory now must still
        // name it, or Relaycast marks it missing mid-launch.
        assert!(core.store.read(|store| store.registrations.is_empty()));
        let expected = vec![InventoryAgent {
            agent_id: "agent_w1".into(),
            name: "w1".into(),
            invocation_id: "inv_w1".into(),
            session_ref: "spawn:inv_w1".into(),
        }];
        assert_eq!(core.spawned_inventory(&node()), expected);
        proceed.send(()).unwrap();
        spawning.await.unwrap();
        // Saved now: listed once, from the store.
        assert_eq!(core.spawned_inventory(&node()), expected);
        assert!(core.ledger().state.lock().unwrap().starting.is_empty());
    }

    #[tokio::test]
    async fn an_in_flight_spawn_replay_waits_for_the_original_result() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let (started_tx, started) = std::sync::mpsc::channel();
        let (proceed, proceed_rx) = std::sync::mpsc::channel();
        *spawner.pause.lock().unwrap() = Some((started_tx, proceed_rx));
        let core = core(home.path(), spawner.clone());
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
        tokio::task::spawn_blocking(move || started.recv().unwrap())
            .await
            .unwrap();
        let duplicate = core.clone().answer_spawn(link, request("w1"));
        tokio::pin!(duplicate);
        let early = match futures_util::poll!(&mut duplicate) {
            std::task::Poll::Ready(value) => Some(value),
            std::task::Poll::Pending => None,
        };
        let waited = early.is_none();
        proceed.send(()).unwrap();
        let first = spawning.await.unwrap();
        let again = match early {
            Some(value) => value,
            None => duplicate.await,
        };
        assert!(
            waited,
            "a duplicate invocation must wait for its existing launch"
        );
        assert_eq!(again, first);
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);
        assert_eq!(core.spawn_slots().reserved, 0);
    }

    #[tokio::test]
    async fn an_in_flight_spawn_is_released_after_launch_finishes() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let (started_tx, started) = std::sync::mpsc::channel();
        let (proceed, proceed_rx) = std::sync::mpsc::channel();
        *spawner.pause.lock().unwrap() = Some((started_tx, proceed_rx));
        let core = core(home.path(), spawner.clone());
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let spawning = tokio::spawn(core.clone().answer_spawn(link, request("w1")));
        tokio::task::spawn_blocking(move || started.recv().unwrap())
            .await
            .unwrap();
        let releasing = core.clone().answer_release(ReleaseRequest {
            invocation_id: "inv_release".into(),
            name: "w1".into(),
            expected_agent_id: Some("agent_w1".into()),
        });
        tokio::pin!(releasing);
        let early = match futures_util::poll!(&mut releasing) {
            std::task::Poll::Ready(value) => Some(value),
            std::task::Poll::Pending => None,
        };
        let waited = early.is_none();
        proceed.send(()).unwrap();
        spawning.await.unwrap();
        let released = match early {
            Some(value) => value,
            None => releasing.await,
        };
        assert!(
            waited,
            "release must not acknowledge an agent still launching"
        );
        assert_eq!(
            released,
            wire::action_output("inv_release", wire::released("w1"))
        );
        assert_eq!(spawner.stopped.lock().unwrap().len(), 1);
        assert!(core.store.read(|store| store.registrations.is_empty()));
        assert_eq!(core.spawn_slots().reserved, 0);
    }

    #[tokio::test]
    async fn a_waiting_spawn_replay_does_not_respawn_after_release() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let (started_tx, started) = std::sync::mpsc::channel();
        let (proceed, proceed_rx) = std::sync::mpsc::channel();
        *spawner.pause.lock().unwrap() = Some((started_tx, proceed_rx));
        let core = core(home.path(), spawner.clone());
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let spawning = tokio::spawn(core.clone().answer_spawn(link.clone(), request("w1")));
        tokio::task::spawn_blocking(move || started.recv().unwrap())
            .await
            .unwrap();
        let releasing = core.clone().answer_release(ReleaseRequest {
            invocation_id: "inv_release".into(),
            name: "w1".into(),
            expected_agent_id: Some("agent_w1".into()),
        });
        tokio::pin!(releasing);
        assert!(futures_util::poll!(&mut releasing).is_pending());
        let duplicate = core.clone().answer_spawn(link, request("w1"));
        tokio::pin!(duplicate);
        assert!(futures_util::poll!(&mut duplicate).is_pending());
        proceed.send(()).unwrap();
        let first = spawning.await.unwrap();
        // Finish release before polling the waiting replay again.
        let released = releasing.await;
        assert_eq!(
            released,
            wire::action_output("inv_release", wire::released("w1"))
        );
        let again = duplicate.await;
        assert_eq!(again, first);
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);
        assert_eq!(spawner.stopped.lock().unwrap().len(), 1);
        assert!(core.store.read(|store| store.registrations.is_empty()));
    }

    #[tokio::test]
    async fn a_late_spawn_replay_after_release_uses_the_durable_receipt() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        let first = spawn(&core, "w1").await;
        let released = core
            .clone()
            .answer_release(ReleaseRequest {
                invocation_id: "release_w1".into(),
                name: "w1".into(),
                expected_agent_id: Some("agent_w1".into()),
            })
            .await;
        assert_eq!(
            released,
            wire::action_output("release_w1", wire::released("w1"))
        );
        // No future/guard from the original spawn remains. A newly acquired
        // weak lock has no cached result; only the disk receipt can prevent this.
        let scope = completions::Scope::workspace(&core.workspace().unwrap());
        assert!(core
            .ledger()
            .actions
            .get(scope.lock_key("inv_w1"))
            .lock()
            .await
            .is_none());
        core.store
            .update(|store| store.accept_spawns = Some(false))
            .unwrap();
        assert_eq!(spawn(&core, "w1").await, first);
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);
        assert!(core.store.read(|store| store.registrations.is_empty()));
    }

    #[tokio::test]
    async fn saved_spawn_registrations_do_not_cross_workspace_scopes() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner);
        spawn(&core, "w1").await;
        let registration = core.store.read(|store| store.registrations[0].clone());
        let workspace = core.workspace().unwrap();
        assert!(completions::Scope::workspace(&workspace).matches_registration(&registration));
        let mut another = workspace.clone();
        another.key = crate::relay::workspace::Secret::new("rk_live_another_workspace");
        assert!(!completions::Scope::workspace(&another).matches_registration(&registration));
        another = workspace;
        another.base_url = "https://another.example".into();
        assert!(!completions::Scope::workspace(&another).matches_registration(&registration));
    }

    #[tokio::test]
    async fn a_fresh_core_cannot_respawn_a_released_invocation() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner {
            unconfirmed: true,
            ..FakeSpawner::default()
        });
        let original = core(home.path(), spawner.clone());
        let first = spawn(&original, "w1").await;
        assert_eq!(
            first["output"]["warning"]["verification"],
            "transport_closed"
        );
        assert!(spawner.launched.lock().unwrap()[0].full_access);
        original
            .clone()
            .answer_release(ReleaseRequest {
                invocation_id: "release_w1".into(),
                name: "w1".into(),
                expected_agent_id: Some("agent_w1".into()),
            })
            .await;
        drop(original);
        let restarted = core(home.path(), spawner.clone());
        assert_eq!(spawn(&restarted, "w1").await, first);
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);
        assert_eq!(spawner.stopped.lock().unwrap().len(), 1);
        assert!(restarted.store.read(|store| store.registrations.is_empty()));
        // A new invocation with the same name still starts a new worker.
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let mut another = request("w1");
        another.invocation_id = "inv_w1_new".into();
        let result = restarted.clone().answer_spawn(link, another).await;
        assert_eq!(
            result,
            wire::action_output(
                "inv_w1_new",
                wire::spawned_unconfirmed("w1", "transport_closed")
            )
        );
        assert_eq!(spawner.launched.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn release_preserves_a_legacy_registration_before_removing_it() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let original = core(home.path(), spawner.clone());
        let first = spawn(&original, "w1").await;
        std::fs::remove_dir_all(original.config.app_data_dir.join("spawn-completions")).unwrap();
        original
            .clone()
            .answer_release(ReleaseRequest {
                invocation_id: "release_w1".into(),
                name: "w1".into(),
                expected_agent_id: Some("agent_w1".into()),
            })
            .await;
        drop(original);
        let restarted = core(home.path(), spawner.clone());
        assert_eq!(spawn(&restarted, "w1").await, first);
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_unreadable_receipt_prevents_spawn_and_release_from_forgetting_identity() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        spawn(&core, "w1").await;
        let directory = core.config.app_data_dir.join("spawn-completions");
        std::fs::remove_dir_all(&directory).unwrap();
        std::fs::write(&directory, "blocked").unwrap();
        let result = spawn(&core, "w1").await;
        let error = result["error"]
            .as_str()
            .unwrap_or_else(|| panic!("the spawn was not refused: {result}"));
        assert!(error.contains("saved spawn receipt"), "{error}");
        let released = core
            .clone()
            .answer_release(ReleaseRequest {
                invocation_id: "release_w1".into(),
                name: "w1".into(),
                expected_agent_id: Some("agent_w1".into()),
            })
            .await;
        assert_eq!(
            released["error"],
            "release_failed: could not preserve the spawn receipt"
        );
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);
        assert!(spawner.stopped.lock().unwrap().is_empty());
        assert_eq!(core.store.read(|store| store.registrations.len()), 1);
    }

    #[tokio::test]
    async fn cancelling_a_registered_spawn_keeps_its_recovery_intent() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let (started_tx, started) = std::sync::mpsc::channel();
        let (proceed, proceed_rx) = std::sync::mpsc::channel();
        *spawner.pause.lock().unwrap() = Some((started_tx, proceed_rx));
        let core = core(home.path(), spawner.clone());
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let spawning = tokio::spawn(core.clone().answer_spawn(link, request("w1")));
        tokio::task::spawn_blocking(move || started.recv().unwrap())
            .await
            .unwrap();
        spawning.abort();
        let cancelled = spawning.await.unwrap_err().is_cancelled();
        proceed.send(()).unwrap();
        assert!(cancelled);
        let kept = intents::load(&core.config.app_data_dir);
        assert_eq!(kept.len(), 1, "cancellation must retain recovery evidence");
        assert_eq!(kept[0].agent_id.as_deref(), Some("agent_w1"));
        assert_eq!(kept[0].invocation_id, "inv_w1");
        assert!(
            !kept[0].ended,
            "recovery must inspect the interrupted launch"
        );
        assert!(core.store.read(|store| store.registrations.is_empty()));
    }

    #[tokio::test]
    async fn a_failed_launch_leaves_nothing_in_the_inventory() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner {
            refuse: true,
            ..FakeSpawner::default()
        });
        let core = core(home.path(), spawner);
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let result = core.clone().answer_spawn(link, request("w1")).await;
        assert_eq!(
            core.spawned_inventory(&node()).len(),
            1,
            "failure must be sent first"
        );
        CoreHost(Arc::downgrade(&core)).sent(&result);
        assert!(core.spawned_inventory(&node()).is_empty());
        assert!(core.ledger().state.lock().unwrap().starting.is_empty());
    }

    #[tokio::test]
    async fn a_saved_spawn_still_reserved_holds_one_place() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        spawn(&core, "w1").await;
        // Saved, with its reservation not yet given back.
        core.ledger()
            .state
            .lock()
            .unwrap()
            .reserved
            .insert("inv_w1".into());
        let slots = core.spawn_slots();
        assert_eq!((slots.held, slots.reserved), (1, 0));
    }

    #[tokio::test]
    async fn an_invocation_still_starting_is_not_reserved_twice() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        let (link, _sent) = NodeLink::detached(node());
        let reserved = |core: &Core| core.ledger().state.lock().unwrap().reserved.len();
        let first = core.reserve_place(&link, &request("w1")).ok().unwrap();
        let again = core.reserve_place(&link, &request("w1"));
        assert!(
            matches!(&again, Err(SpawnError::Plain(error)) if error.starts_with("spawn_in_progress")),
            "{:?}",
            again.err().map(|_| ())
        );
        // The refused duplicate left the first attempt's place reserved.
        assert_eq!(reserved(&core), 1);
        let other = core.reserve_place(&link, &request("w2")).ok().unwrap();
        assert_eq!(reserved(&core), 2);
        drop(first);
        drop(other);
        assert_eq!(reserved(&core), 0);
    }

    #[tokio::test]
    async fn a_spawn_registers_on_the_node_launches_and_keeps_the_agent() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        let (link, sent) = NodeLink::detached(node());
        let frames = relaycast(link.clone(), sent);
        let answer = core.clone().answer_spawn(link, request("w1")).await;
        assert_eq!(answer, wire::action_output("inv_w1", wire::spawned("w1")));
        let frames = frames.await.unwrap();
        assert_eq!(frames[0]["type"], "agent.register");
        assert_eq!(frames[0]["invocation_id"], "inv_w1");

        let launched = spawner.launched.lock().unwrap().clone();
        assert_eq!(launched.len(), 1);
        assert_eq!(launched[0].directory, PathBuf::from(home.path()));
        assert!(launched[0].full_access);
        assert_eq!(
            launched[0].text,
            format!(
                "[via Agent Relay — spawned as @w1 (w1@test-desk-desktop) · ref {}]\n\nFix CI",
                crate::relay::delivery::policy::MessageRef::of("spawn-inv_w1")
            ),
            "no requester when Relaycast cannot be read; no socket when it does not serve"
        );

        let (registration, token) = core.store.read(|store| {
            (
                store.registrations[0].clone(),
                store.tokens.get("w1").map(|t| t.expose().to_string()),
            )
        });
        assert_eq!(registration.agent_id, "agent_w1");
        assert_eq!(registration.target.kind, SessionKind::Codex);
        assert_eq!(
            registration.direct_address("test-desk"),
            "w1@test-desk-desktop"
        );
        assert_eq!(registration.spawn.as_ref().unwrap().invocation_id, "inv_w1");
        assert_eq!(token.as_deref(), Some("at_live_w1"));
        assert_eq!(
            core.spawned_inventory(&node()),
            vec![InventoryAgent {
                agent_id: "agent_w1".into(),
                name: "w1".into(),
                invocation_id: "inv_w1".into(),
                session_ref: "spawn:inv_w1".into(),
            }]
        );
        assert!(core.spawned_targets().contains(&registration.target));

        // Relaycast sending the same invocation again starts nothing new.
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let again = core.clone().answer_spawn(link, request("w1")).await;
        assert_eq!(again, wire::action_output("inv_w1", wire::spawned("w1")));
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);

        // A release for another agent of that name is refused; the right
        // one ends the agent and forgets it.
        let wrong = core
            .clone()
            .answer_release(ReleaseRequest {
                invocation_id: "inv_r0".into(),
                name: "w1".into(),
                expected_agent_id: Some("agent_other".into()),
            })
            .await;
        assert!(wrong["error"]
            .as_str()
            .unwrap()
            .starts_with("release_failed"));
        let released = core
            .clone()
            .answer_release(ReleaseRequest {
                invocation_id: "inv_r1".into(),
                name: "w1".into(),
                expected_agent_id: Some("agent_w1".into()),
            })
            .await;
        assert_eq!(
            released,
            wire::action_output("inv_r1", wire::released("w1"))
        );
        assert!(core.store.read(|store| store.registrations.is_empty()));
        assert_eq!(spawner.stopped.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_spawn_is_refused_when_turned_off_taken_or_failed_to_launch() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner {
            refuse: true,
            ..FakeSpawner::default()
        });
        let core = core(home.path(), spawner.clone());

        // A failed launch takes the agent back off the node.
        let (link, sent) = NodeLink::detached(node());
        let frames = relaycast(link.clone(), sent);
        let failed = core.clone().answer_spawn(link, request("w2")).await;
        CoreHost(Arc::downgrade(&core)).sent(&failed);
        assert_eq!(
            failed["error"],
            "spawn_harness_unavailable: Codex refused the first turn"
        );
        let frames = frames.await.unwrap();
        assert_eq!(frames[1]["type"], "agent.deregister");
        assert_eq!(frames[1]["agent_id"], "agent_w2");
        assert!(core.store.read(|store| store.registrations.is_empty()));

        let (link, _sent) = NodeLink::detached(node());
        let missing = SpawnRequest {
            directory: Some(home.path().join("missing")),
            ..request("w3")
        };
        let answer = core.clone().answer_spawn(link, missing).await;
        assert!(answer["error"]
            .as_str()
            .unwrap()
            .starts_with("spawn_invalid_input"));

        core.store
            .update(|store| store.accept_spawns = Some(false))
            .unwrap();
        let (link, _sent) = NodeLink::detached(node());
        let off = core.clone().answer_spawn(link, request("w4")).await;
        assert!(off["error"].as_str().unwrap().starts_with("spawn_disabled"));
    }

    // Windows has no mode bits to make a folder unreadable with.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unreadable_working_folder_is_refused_before_agent_registration() {
        use std::os::unix::fs::PermissionsExt;

        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join("unreadable");
        std::fs::create_dir(&directory).unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o111)).unwrap();
        let (link, mut sent) = NodeLink::detached(node());
        let answer = core
            .clone()
            .answer_spawn(
                link,
                SpawnRequest {
                    directory: Some(directory.clone()),
                    ..request("unreadable")
                },
            )
            .await;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let error = answer["error"].as_str().unwrap();
        assert!(
            error.starts_with("spawn_invalid_input: Agent Relay could not read the working folder"),
            "{error}"
        );
        assert!(
            sent.try_recv().is_err(),
            "no agent.register should have been sent"
        );
        assert!(core.store.read(|store| store.registrations.is_empty()));
    }

    #[tokio::test]
    async fn a_node_another_account_owns_offers_and_takes_no_spawns() {
        use crate::relay::spawn::claim::tests::{owned_elsewhere, FakeCloud};
        use crate::relay::state::SpawnClaimState;
        let home = tempfile::tempdir().unwrap();
        let cloud = Arc::new(FakeCloud::answering(Err(owned_elsewhere())));
        let core = core_with(home.path(), Arc::new(FakeSpawner::default()), cloud.clone());
        // This node stands in for the one the core starts in the
        // background, which would report its own connection state.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while core.spawn_node.lock().await.is_none() {
            assert!(std::time::Instant::now() < deadline, "no node started");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        core.stop_spawn_node().await;
        let host = CoreHost(Arc::downgrade(&core));
        host.state(SpawnStatus {
            state: SpawnState::Live,
            node_name: Some(node().node_name),
            ..SpawnStatus::default()
        });
        let offered = |core: &Core| {
            wire::NodeIdentity {
                node_id: node().node_id,
                name: node().node_name,
                instance_id: "broker_1".into(),
                version: "1".into(),
            }
            .heartbeat(&core.spawn_advertisement(&[codex::ID], &[]))["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["name"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert!(offered(&core).contains(&"spawn:codex".to_string()));
        let configured = &core.spawn_advertisement(&[codex::ID], &[]).configured;
        assert_eq!(configured.machine, "Test Desk");
        assert!(!configured.teammates);

        let token = crate::relay::workspace::Secret::new("nt_live_one1one1".to_string());
        host.claim(&node(), &token);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !core.spawns_blocked() {
            assert!(std::time::Instant::now() < deadline, "never answered");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let spawn = core.status().spawn.unwrap();
        assert_eq!(spawn.state, SpawnState::Live);
        assert_eq!(spawn.claim.unwrap().state, SpawnClaimState::OwnedByOther);
        assert_eq!(spawn.error.as_deref(), Some(claim::OWNED_BY_OTHER));
        assert!(!offered(&core).iter().any(|name| name.starts_with("spawn:")));
        let (link, _sent) = NodeLink::detached(node());
        let refused = core.clone().answer_spawn(link, request("w1")).await;
        assert_eq!(
            refused["error"],
            format!("{}: {}", wire::TARGET_UNAVAILABLE, claim::OWNED_BY_OTHER)
        );
        assert!(core.store.read(|store| store.registrations.is_empty()));
        // Checked every minute, but not asked again so soon.
        host.claim(&node(), &token);
        assert_eq!(cloud.asked(), 1);

        // Released and claimed with a new token: spawns again.
        *cloud.answer.lock().unwrap() = Ok(json!({"claimed": true, "owner": "you"}));
        let token = crate::relay::workspace::Secret::new("nt_live_two2two2".to_string());
        host.claim(&node(), &token);
        while core.spawns_blocked() {
            assert!(std::time::Instant::now() < deadline, "never claimed");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let spawn = core.status().spawn.unwrap();
        assert_eq!(spawn.claim.unwrap().state, SpawnClaimState::Claimed);
        assert_eq!(spawn.error, None);
        assert!(offered(&core).contains(&"spawn:codex".to_string()));
    }

    #[test]
    fn the_node_is_named_apart_from_a_broker_on_the_same_computer() {
        assert_eq!(node_name("test-mac-mini"), "test-mac-mini-desktop");
    }

    #[test]
    fn spawning_and_full_access_are_on_until_the_person_turns_them_off() {
        let store = Store::default();
        let settings = SpawnSettings::of(&store);
        assert!(settings.accept);
        assert_eq!(settings.max_agents, 0);
        assert!(settings.full_access(codex::ID));
        assert!(settings.full_access(claude::ID));
        let store = Store {
            accept_spawns: Some(false),
            spawn_max_agents: Some(8),
            spawn_full_access_claude: Some(false),
            ..Store::default()
        };
        let settings = SpawnSettings::of(&store);
        assert!(!settings.accept);
        assert_eq!(settings.max_agents, 8);
        assert!(settings.full_access(codex::ID));
        assert!(!settings.full_access(claude::ID));
    }

    #[test]
    fn old_untouched_default_becomes_unlimited_but_explicit_values_survive() {
        let mut saved = serde_json::to_value(Store::default()).unwrap();
        assert!(saved.get("spawnMaxAgents").is_none());
        let old: Store = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(SpawnSettings::of(&old).max_agents, 0);
        for cap in [0, 1, 12, 32] {
            saved["spawnMaxAgents"] = json!(cap);
            let old: Store = serde_json::from_value(saved.clone()).unwrap();
            assert_eq!(SpawnSettings::of(&old).max_agents, cap);
        }
    }

    #[test]
    fn the_first_message_names_the_agent_and_carries_the_task() {
        let quiet = ReportBack {
            message_ref: "0123456789ab".into(),
            ..ReportBack::default()
        };
        assert_eq!(
            first_text("w1", "w1@mac-desktop", "Fix CI", &quiet),
            "[via Agent Relay — spawned as @w1 (w1@mac-desktop) · ref 0123456789ab]\n\nFix CI"
        );
        assert!(first_text("w1", "w1@mac-desktop", "", &quiet).contains("Wait for a message."));
        // With a requester and the socket serving, how to reach them comes
        // between the header and the task.
        let report = ReportBack {
            requester: Some("grokbot".into()),
            socket: Some("/run/user/1000/agent-relay/relay.sock".into()),
            ..quiet
        };
        let text = first_text("w1", "w1@mac-desktop", "Fix CI", &report);
        let (head, task) = text.split_once("\n\n").unwrap();
        assert_eq!(task, "Fix CI");
        assert!(head.starts_with(
            "[via Agent Relay — spawned as @w1 (w1@mac-desktop) · from @grokbot · ref 0123456789ab]\n[report: "
        ), "{head}");
        assert!(head.contains("'http://relay/send?to=grokbot'"), "{head}");
        assert!(head.contains("[agents: "), "{head}");
    }

    #[test]
    fn a_taken_name_is_reported_as_cloud_expects() {
        assert!(
            register_error("agent_already_exists", "taken").starts_with("spawn_agent_name_in_use")
        );
        assert!(
            register_error("node_capacity_exceeded", "full").starts_with("spawn_capacity_exceeded")
        );
        assert!(register_error("other", "x").starts_with("spawn_failed"));
    }

    fn named(core: &Core, name: &str) -> Registration {
        core.store
            .read(|store| store.registrations.iter().find(|r| r.name == name).cloned())
            .unwrap()
    }

    fn set_max(core: &Core, max: u32) {
        core.store
            .update(|store| store.spawn_max_agents = Some(max))
            .unwrap();
    }

    #[tokio::test]
    async fn a_full_node_refuses_with_details_and_never_queues() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        observed(&core);
        set_max(&core, 1);
        assert_eq!(
            spawn(&core, "w1").await,
            wire::action_output("inv_w1", wire::spawned("w1"))
        );
        let refused = spawn(&core, "w2").await;
        assert_eq!(refused["error"], "spawn_capacity_exceeded");
        let details = &refused["error_details"];
        assert_eq!(details["code"], "spawn_capacity_exceeded");
        assert_eq!(details["node"], "test-desk-desktop");
        assert_eq!(details["harness"], "codex");
        assert_eq!(
            (&details["active"], &details["reserved"], &details["max"]),
            (&json!(1), &json!(0), &json!(1))
        );
        assert_eq!(details["retryable"], true);
        assert!(details["observed_at"].as_str().unwrap().ends_with('Z'));
        // Nothing was started, registered or kept for later.
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);
        assert_eq!(core.store.read(|store| store.registrations.len()), 1);
        assert!(core.ledger().state.lock().unwrap().reserved.is_empty());
    }

    #[tokio::test]
    async fn details_follow_each_connection_and_an_older_relaycast_keeps_the_reason() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        observed(&core);
        set_max(&core, 1);
        spawn(&core, "w1").await;
        // A connection that accepted the capability: details.
        let accepted = spawn_over(&core, "w2", true).await;
        assert_eq!(accepted["error"], "spawn_capacity_exceeded");
        assert_eq!(accepted["error_details"]["max"], 1);
        // Reconnected to an older Relaycast (no acceptance, or refused):
        // the code and reason in the string its strict schema accepts.
        let older = spawn_over(&core, "w3", false).await;
        assert_eq!(
            older,
            json!({"v": 1, "type": "action.result", "invocation_id": "inv_w3",
                "error": "spawn_capacity_exceeded: this computer runs 1 of at most 1 spawned agents; release one or choose another node"})
        );
        assert!(older.get("error_details").is_none());
        // The flag is learned from each connection's register reply: only
        // the contract field turns it on; "accepted" capabilities, a
        // missing field or another contract do not.
        for (reply, name) in [
            (
                json!({"accepted_capabilities": [{"name": wire::ERROR_DETAILS_CAPABILITY,
                    "kind": "capacity", "accepted": true}]}),
                "w4",
            ),
            (
                json!({"spawn_error_details_contract": "relay:spawn-error-details-v2"}),
                "w5",
            ),
        ] {
            let (mut link, _sent) = NodeLink::detached(node());
            link.error_details = wire::error_details_agreed(&reply);
            let answer = core.clone().answer_spawn(link, request(name)).await;
            assert!(answer["error"]
                .as_str()
                .unwrap()
                .starts_with("spawn_capacity_exceeded: "));
            assert!(answer.get("error_details").is_none(), "{reply}");
        }
        let (mut link, _sent) = NodeLink::detached(node());
        link.error_details = wire::error_details_agreed(
            &json!({"spawn_error_details_contract": wire::ERROR_DETAILS_CAPABILITY}),
        );
        let agreed = core.clone().answer_spawn(link, request("w6")).await;
        assert_eq!(agreed["error_details"]["code"], "spawn_capacity_exceeded");
        // Plain errors are plain either way.
        core.store
            .update(|store| store.accept_spawns = Some(false))
            .unwrap();
        let off = spawn_over(&core, "w7", true).await;
        assert!(off.get("error_details").is_none());
        assert!(off["error"].as_str().unwrap().starts_with("spawn_disabled"));
    }

    #[tokio::test]
    async fn a_place_advertised_then_taken_is_refused_as_capacity_changed() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        observed(&core);
        set_max(&core, 1);
        // The last heartbeat said one place was free…
        let advertised = core.spawn_advertisement(&[codex::ID], &[]);
        assert_eq!(advertised.live.slots.free(), Some(1));
        // …and a spawn took it before the next one.
        spawn(&core, "w1").await;
        let refused = spawn(&core, "w2").await;
        assert_eq!(refused["error"], "capacity_changed");
        assert_eq!(refused["error_details"]["retryable"], true);
        // Once advertised full, a refusal is plain exceeded.
        core.spawn_advertisement(&[codex::ID], &[]);
        assert_eq!(spawn(&core, "w3").await["error"], "spawn_capacity_exceeded");
    }

    #[tokio::test]
    async fn idle_and_unknown_agents_keep_their_place() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        let observer = observed(&core);
        set_max(&core, 2);
        spawn(&core, "w1").await;
        spawn(&core, "w2").await;
        observer.set("w1", ProcessLiveness::Running, WorkState::Idle, false);
        observer.set("w2", ProcessLiveness::Unknown, WorkState::Unknown, false);
        core.observe_spawned().await;
        assert_eq!(
            core.spawn_slots(),
            SpawnSlots {
                max: 2,
                held: 2,
                reserved: 0
            }
        );
        assert_eq!(core.spawned_live().len(), 2);
        assert_eq!(spawn(&core, "w3").await["error"], "spawn_capacity_exceeded");
        let row = core.spawned_agent_state(&named(&core, "w1")).unwrap();
        assert_eq!(row.harness, "codex");
        assert!(row.holds_slot);
        assert_eq!(row.process.state, ProcessLiveness::Running);
        assert_eq!(row.work.state, WorkState::Idle);
        assert!(row.work.at.is_some());
        assert_eq!(row.unfinished, None);
        let advertisement = core.spawn_advertisement(&[codex::ID], &[]);
        assert_eq!(
            (
                advertisement.live.work.idle,
                advertisement.live.work.unknown
            ),
            (1, 1)
        );
    }

    #[tokio::test]
    async fn a_crashed_agent_gives_back_its_place_and_reports_unfinished_work() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        let observer = observed(&core);
        set_max(&core, 1);
        spawn(&core, "w1").await;
        observer.set("w1", ProcessLiveness::Running, WorkState::Working, true);
        core.observe_spawned().await;
        assert_eq!(core.spawn_slots().held, 1);
        observer.set("w1", ProcessLiveness::Exited, WorkState::Unknown, true);
        core.observe_spawned().await;
        assert_eq!(core.spawn_slots().held, 0);
        assert!(core.spawned_live().is_empty());
        assert!(core.spawned_inventory(&node()).is_empty());
        let registration = named(&core, "w1");
        let row = core.spawned_agent_state(&registration).unwrap();
        assert!(!row.holds_slot);
        let unfinished = row.unfinished.unwrap();
        assert!(unfinished.turn_in_progress);
        // Its queue could not be read here (nothing listens): not counted.
        assert_eq!(unfinished.pending_deliveries, None);
        let advertisement = core.spawn_advertisement(&[codex::ID], &[]);
        assert_eq!(advertisement.live.reclaimed.len(), 1);
        assert_eq!(advertisement.live.reclaimed[0].agent_id, "agent_w1");
        // Its registration (name and queue) stays until it is released, and
        // its place takes a new spawn.
        assert_eq!(
            spawn(&core, "w2").await,
            wire::action_output("inv_w2", wire::spawned("w2"))
        );
        // Seen running again, it holds a place again: over the maximum, so
        // new spawns are refused until one is released.
        observer.set("w1", ProcessLiveness::Running, WorkState::Idle, false);
        core.observe_spawned().await;
        assert_eq!(core.spawn_slots().held, 2);
        assert!(core
            .spawn_advertisement(&[codex::ID], &[])
            .live
            .reclaimed
            .is_empty());
    }

    #[tokio::test]
    async fn after_a_restart_only_genuinely_dead_agents_are_reclaimed() {
        let home = tempfile::tempdir().unwrap();
        let first = core(home.path(), Arc::new(FakeSpawner::default()));
        observed(&first);
        spawn(&first, "alive").await;
        spawn(&first, "dead").await;
        // The test's cores share one in-memory ledger by folder; a new
        // process would start with no node evidence at all.
        first.stop_spawn_node().await;
        CoreHost(Arc::downgrade(&first)).state(SpawnStatus::default());
        drop(first);

        // A new core over the same store, with nothing in memory.
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        let observer = observed(&core);
        observer.set("alive", ProcessLiveness::Running, WorkState::Working, true);
        observer.set("dead", ProcessLiveness::Exited, WorkState::Unknown, true);
        // Before it has looked, nothing is reclaimed and nothing reads as
        // running: unknown keeps the place.
        assert_eq!(core.spawn_slots().held, 2);
        assert_eq!(core.spawned_live().len(), 2);
        let row = core.spawned_agent_state(&named(&core, "dead")).unwrap();
        assert_eq!(row.process.state, ProcessLiveness::Unknown);
        assert_eq!(row.node.state, NodeReach::Unknown);

        core.observe_spawned().await;
        assert_eq!(core.spawn_slots().held, 1);
        let inventory: Vec<String> = core
            .spawned_inventory(&node())
            .into_iter()
            .map(|agent| agent.name)
            .collect();
        assert_eq!(inventory, ["alive"]);
        let dead = core.spawned_agent_state(&named(&core, "dead")).unwrap();
        assert!(dead.unfinished.unwrap().turn_in_progress);
        let alive = core.spawned_agent_state(&named(&core, "alive")).unwrap();
        assert_eq!(alive.work.state, WorkState::Working);
    }

    #[tokio::test]
    async fn a_new_node_carries_over_the_agents_spawned_on_the_old_one() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        spawn(&core, "w1").await;
        let host = CoreHost(Arc::downgrade(&core));
        let renamed = NodeInfo {
            node_id: "node_desktop_2".into(),
            node_name: "test-desk-desktop".into(),
        };
        // Listed by the node it now runs on, which Relaycast lets claim an
        // agent whose old node is gone; never left out to be marked missing.
        let listed = host.inventory(&renamed);
        assert_eq!(
            listed.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["w1"]
        );
        let spawn = named(&core, "w1").spawn.unwrap();
        assert_eq!(spawn.node_id, "node_desktop_2");
        assert_eq!(spawn.invocation_id, "inv_w1");
        assert_eq!(core.spawn_slots().held, 1);
    }

    #[tokio::test]
    async fn a_node_renamed_under_its_own_id_readdresses_its_agents() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        spawn(&core, "w1").await;
        let host = CoreHost(Arc::downgrade(&core));
        // Another node took the name while Relaycast had lost this one.
        let renamed = NodeInfo {
            node_name: "test-desk-desktop-3f9a".into(),
            ..node()
        };
        let listed = host.inventory(&renamed);
        assert_eq!(
            listed.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["w1"]
        );
        let registration = named(&core, "w1");
        let spawn = registration.spawn.as_ref().unwrap();
        assert_eq!(spawn.node_id, node().node_id);
        assert_eq!(spawn.node_name, "test-desk-desktop-3f9a");
        assert_eq!(
            registration.direct_address("test-desk"),
            "w1@test-desk-desktop-3f9a"
        );
    }

    #[tokio::test]
    async fn a_spawn_in_flight_is_kept_on_disk_until_its_agent_is_saved() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let (started_tx, started) = std::sync::mpsc::channel();
        let (proceed, proceed_rx) = std::sync::mpsc::channel();
        *spawner.pause.lock().unwrap() = Some((started_tx, proceed_rx));
        let core = core(home.path(), spawner.clone());
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        let spawning = tokio::spawn(core.clone().answer_spawn(link, request("w1")));
        tokio::task::spawn_blocking(move || started.recv().unwrap())
            .await
            .unwrap();
        let kept = intents::load(&core.config.app_data_dir);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(kept[0].invocation_id, "inv_w1");
        assert_eq!(kept[0].agent_id.as_deref(), Some("agent_w1"));
        assert_eq!(
            kept[0].token.as_ref().map(|t| t.expose()),
            Some("at_live_w1")
        );
        assert_eq!(kept[0].message_id, "spawn-inv_w1");
        // The session the launch is started with is the one on disk.
        let launched = spawner.launched.lock().unwrap()[0].clone();
        assert_eq!(launched.session_id, kept[0].session_id);
        proceed.send(()).unwrap();
        spawning.await.unwrap();
        assert!(intents::load(&core.config.app_data_dir).is_empty());
        assert!(named(&core, "w1").spawn.is_some());
    }

    fn interrupted(name: &str, registered: bool, target: Option<Target>) -> intents::Intent {
        intents::Intent {
            invocation_id: format!("inv_{name}"),
            name: name.into(),
            harness: codex::ID,
            node_id: node().node_id,
            node_name: node().node_name,
            title: "Fix CI".into(),
            base_url: "http://localhost:9".into(),
            workspace_key: crate::relay::workspace::Secret::new("rk_live_test0000".to_string()),
            workspace_id: None,
            machine_prefix: "test-desk".into(),
            message_id: format!("spawn-inv_{name}"),
            session_id: "0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d".into(),
            created_ms: 0,
            ended: false,
            launch_failed: false,
            register_sent: registered,
            agent_id: registered.then(|| format!("agent_{name}")),
            token: registered
                .then(|| crate::relay::workspace::Secret::new(format!("at_live_{name}"))),
            requester: None,
            target,
            process: None,
        }
    }

    #[tokio::test]
    async fn a_restart_keeps_a_spawn_whose_agent_still_runs() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        let thread = Target::new(SessionKind::Codex, THREAD);
        let requester = crate::relay::store::SpawnRequester {
            name: "grokbot".into(),
            agent_id: "agent_grokbot".into(),
        };
        intents::put(
            &core.config.app_data_dir,
            &intents::Intent {
                requester: Some(requester.clone()),
                ..interrupted("w1", true, Some(thread.clone()))
            },
        )
        .unwrap();
        // This node stands in for the one the core starts in the
        // background, which would report its own connection state.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while core.spawn_node.lock().await.is_none() {
            assert!(std::time::Instant::now() < deadline, "no node started");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        core.stop_spawn_node().await;
        let host = CoreHost(Arc::downgrade(&core));
        host.state(SpawnStatus {
            state: SpawnState::Live,
            ..SpawnStatus::default()
        });
        let (link, mut sent) = NodeLink::detached(node());
        host.connected(link).await;
        // On the node's connection, as a spawn just saved is.
        assert_eq!(
            core.status().push.get("w1"),
            Some(&crate::relay::push::PushState::Live)
        );
        let kept = named(&core, "w1");
        assert_eq!(kept.target, thread);
        assert_eq!(kept.agent_id, "agent_w1");
        let origin = kept.spawn.unwrap();
        assert_eq!(origin.invocation_id, "inv_w1");
        assert_eq!(origin.requester, Some(requester));
        // Still owed to its requester, as the spawn would have saved it.
        let owed = core.store.read(|s| s.replies.clone()).unwrap();
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0].agent_id, "agent_w1");
        assert_eq!(owed[0].message_id, "spawn-inv_w1");
        assert_eq!(
            core.store
                .read(|s| s.tokens.get("w1").map(|t| t.expose().to_string())),
            Some("at_live_w1".to_string())
        );
        assert!(intents::load(&core.config.app_data_dir).is_empty());
        assert!(sent.try_recv().is_err(), "nothing is deregistered");
        assert_eq!(
            core.spawned_inventory(&node())
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            ["w1"]
        );
    }

    /// The next frame sent on a detached link.
    async fn next_frame(sent: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), sent.recv())
            .await
            .expect("a frame in time")
            .expect("the link is open")
    }

    async fn recovered_deregister(sent: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
        let failure = next_frame(sent).await;
        assert_eq!(
            failure["type"], "action.result",
            "the terminal reason precedes cleanup"
        );
        assert!(failure["error"].is_string());
        next_frame(sent).await
    }

    async fn settled(dir: &std::path::Path) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !intents::load(dir).is_empty() {
            assert!(std::time::Instant::now() < deadline, "the intent stayed");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn a_restart_ends_a_spawn_whose_agent_cannot_be_found() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        let dir = core.config.app_data_dir.clone();
        // Registered, then the core stopped before it learned the thread.
        intents::put(&dir, &interrupted("w1", true, None)).unwrap();
        // Stopped before Relaycast registered anything.
        intents::put(&dir, &interrupted("w2", false, None)).unwrap();
        let (link, mut sent) = NodeLink::detached(node());
        CoreHost(Arc::downgrade(&core))
            .connected(link.clone())
            .await;
        let frame = recovered_deregister(&mut sent).await;
        assert_eq!(frame["type"], "agent.deregister");
        assert_eq!(frame["agent_id"], "agent_w1");
        assert_eq!(frame["name"], "w1");
        // Kept until Relaycast answers.
        let left = intents::load(&dir);
        assert_eq!(left.len(), 1);
        assert!(left[0].ended);
        link.answer(
            &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
            "data": {"deregistered": true}}),
        );
        settled(&dir).await;
        assert!(sent.try_recv().is_err());
        assert!(core.store.read(|s| s.registrations.is_empty()));
        assert!(spawner.stopped.lock().unwrap().is_empty());
        assert_eq!(core.spawn_slots().held, 0);
    }

    #[tokio::test]
    async fn a_deregistration_lost_with_the_connection_is_sent_again() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        // Spawns turned off while it was down: the running agent is ended.
        core.store
            .update(|store| store.accept_spawns = Some(false))
            .unwrap();
        let dir = core.config.app_data_dir.clone();
        let thread = Target::new(SessionKind::Codex, THREAD);
        intents::put(&dir, &interrupted("w1", true, Some(thread.clone()))).unwrap();
        let host = CoreHost(Arc::downgrade(&core));
        let (link, sent) = NodeLink::detached(node());
        // The connection closes before the frame is written.
        drop(sent);
        host.connected(link).await;
        assert_eq!(*spawner.stopped.lock().unwrap(), [thread]);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(intents::load(&dir).len(), 1, "kept for the next connection");
        let (link, mut sent) = NodeLink::detached(node());
        host.connected(link.clone()).await;
        let frame = recovered_deregister(&mut sent).await;
        assert_eq!(frame["type"], "agent.deregister");
        assert_eq!(frame["agent_id"], "agent_w1");
        link.answer(
            &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
            "data": {"deregistered": true}}),
        );
        settled(&dir).await;
        // Stopped once, not again on the retry.
        assert_eq!(spawner.stopped.lock().unwrap().len(), 1);
        assert!(core.store.read(|s| s.registrations.is_empty()));
    }

    #[tokio::test]
    async fn a_refused_deregistration_is_sent_again() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        let dir = core.config.app_data_dir.clone();
        intents::put(&dir, &interrupted("w1", true, None)).unwrap();
        let host = CoreHost(Arc::downgrade(&core));
        let (link, mut sent) = NodeLink::detached(node());
        host.connected(link.clone()).await;
        let frame = recovered_deregister(&mut sent).await;
        link.answer(
            &json!({"v": 1, "id": frame["id"], "type": "error", "ok": false,
            "code": "internal_error", "message": "try again"}),
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(intents::load(&dir).len(), 1, "kept after a refusal");
        let (link, mut sent) = NodeLink::detached(node());
        host.connected(link.clone()).await;
        let frame = recovered_deregister(&mut sent).await;
        assert_eq!(frame["type"], "agent.deregister");
        link.answer(
            &json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
            "data": {"deregistered": true}}),
        );
        settled(&dir).await;
    }

    #[tokio::test]
    async fn a_restart_leaves_another_workspaces_spawn_for_its_own_node() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        let dir = core.config.app_data_dir.clone();
        let thread = Target::new(SessionKind::Codex, THREAD);
        // Started in another workspace before the account switched.
        let mut foreign = interrupted("w1", true, Some(thread));
        foreign.workspace_key =
            crate::relay::workspace::Secret::new("rk_live_other000".to_string());
        intents::put(&dir, &foreign).unwrap();
        let mut elsewhere = interrupted("w2", true, None);
        elsewhere.base_url = "https://another.example".into();
        intents::put(&dir, &elsewhere).unwrap();
        let (link, mut sent) = NodeLink::detached(node());
        CoreHost(Arc::downgrade(&core)).connected(link).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        // Neither kept on this node, stopped nor taken off over it.
        assert!(core.store.read(|s| s.registrations.is_empty()));
        assert!(spawner.stopped.lock().unwrap().is_empty());
        assert!(sent.try_recv().is_err());
        assert!(core.spawned_inventory(&node()).is_empty());
        assert_eq!(intents::load(&dir), [foreign, elsewhere]);
    }

    #[tokio::test]
    async fn a_store_that_cannot_be_written_keeps_the_running_agent_for_later() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        let dir = core.config.app_data_dir.clone();
        let thread = Target::new(SessionKind::Codex, THREAD);
        let intent = interrupted("w1", true, Some(thread.clone()));
        intents::put(&dir, &intent).unwrap();
        // Another writer left a store this core cannot read: nothing saves.
        let store_file = dir.join(crate::relay::app_store::STORE_FILE);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&store_file, b"{not json").unwrap();
        let host = CoreHost(Arc::downgrade(&core));
        let listed = |host: &CoreHost| {
            host.inventory(&node())
                .into_iter()
                .map(|a| (a.name, a.agent_id, a.invocation_id))
                .collect::<Vec<_>>()
        };
        let w1 = || {
            vec![(
                "w1".to_string(),
                "agent_w1".to_string(),
                "inv_w1".to_string(),
            )]
        };
        let (link, mut sent) = NodeLink::detached(node());
        host.connected(link).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(spawner.stopped.lock().unwrap().is_empty(), "never stopped");
        assert!(sent.try_recv().is_err(), "never taken off the node");
        assert_eq!(intents::load(&dir), [intent]);
        // Still listed, holding its place, while the save waits: never
        // marked missing nor its place advertised as free.
        assert_eq!(listed(&host), w1());
        assert_eq!(core.spawn_slots().held, 1);
        // A reconnection meanwhile lists it once.
        let (link, _sent) = NodeLink::detached(node());
        host.connected(link).await;
        assert_eq!(listed(&host), w1());
        assert_eq!(core.spawn_slots().held, 1);
        // Saved on the live connection's next inventory once the store can
        // be written, with no reconnection.
        std::fs::remove_file(&store_file).unwrap();
        assert_eq!(listed(&host), w1());
        assert_eq!(named(&core, "w1").target, thread);
        assert!(intents::load(&dir).is_empty());
        assert!(core.ledger().lock().unsaved.is_empty());
        assert_eq!(core.spawn_slots().held, 1);
        assert!(sent.try_recv().is_err());
        assert!(spawner.stopped.lock().unwrap().is_empty());
    }

    #[test]
    fn an_intent_is_of_its_workspace_by_id_across_a_rotated_key() {
        use crate::relay::workspace::{Secret, Workspace};
        let workspace = |key: &str, id: Option<&str>| Workspace {
            key: Secret::new(key.to_string()),
            base_url: "http://localhost:9".into(),
            workspace_id: id.map(str::to_string),
            source: Default::default(),
        };
        let mut intent = interrupted("w1", true, None);
        intent.workspace_id = Some("rw_1".into());
        // The key rotated (Cloud key recovery): the same workspace by id,
        // and a kept agent pins the key in use now.
        let rotated = workspace("rk_live_rotated0", Some("rw_1"));
        let adopted = recover::of_workspace(intent.clone(), &rotated).unwrap();
        assert_eq!(adopted.workspace_key, rotated.key);
        assert_eq!(adopted.invocation_id, intent.invocation_id);
        // Another workspace by id, whatever its key; or another origin.
        assert!(recover::of_workspace(
            intent.clone(),
            &workspace("rk_live_test0000", Some("rw_2"))
        )
        .is_none());
        let mut elsewhere = intent.clone();
        elsewhere.base_url = "https://another.example".into();
        assert!(recover::of_workspace(elsewhere, &rotated).is_none());
        // Without an id on either side, only the same key.
        let older = interrupted("w2", true, None);
        assert!(
            recover::of_workspace(older.clone(), &workspace("rk_live_test0000", Some("rw_1")))
                .is_some()
        );
        assert!(
            recover::of_workspace(older, &workspace("rk_live_rotated0", Some("rw_1"))).is_none()
        );
        assert!(
            recover::of_workspace(intent.clone(), &workspace("rk_live_test0000", None)).is_some()
        );
        assert!(recover::of_workspace(intent, &workspace("rk_live_rotated0", None)).is_none());
    }

    #[tokio::test]
    async fn a_restart_stops_what_is_left_of_a_found_agent_that_no_longer_runs() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner {
            dead: true,
            ..FakeSpawner::default()
        });
        let core = core(home.path(), spawner.clone());
        let dir = core.config.app_data_dir.clone();
        let thread = Target::new(SessionKind::Codex, THREAD);
        intents::put(&dir, &interrupted("w1", true, Some(thread.clone()))).unwrap();
        let (link, mut sent) = NodeLink::detached(node());
        CoreHost(Arc::downgrade(&core)).connected(link).await;
        // Its harness ends what it proves it owns (Muse's detached host).
        assert_eq!(*spawner.stopped.lock().unwrap(), [thread]);
        assert_eq!(
            recovered_deregister(&mut sent).await["type"],
            "agent.deregister"
        );
        assert!(core.store.read(|s| s.registrations.is_empty()));
    }

    #[tokio::test]
    async fn a_release_frees_the_place_and_forgets_the_agent() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        let observer = observed(&core);
        set_max(&core, 1);
        spawn(&core, "w1").await;
        observer.set("w1", ProcessLiveness::Exited, WorkState::Completed, false);
        core.observe_spawned().await;
        let released = core
            .clone()
            .answer_release(ReleaseRequest {
                invocation_id: "inv_r".into(),
                name: "w1".into(),
                expected_agent_id: Some("agent_w1".into()),
            })
            .await;
        assert_eq!(released, wire::action_output("inv_r", wire::released("w1")));
        assert!(core.ledger().state.lock().unwrap().agents.is_empty());
        assert!(core
            .spawn_advertisement(&[codex::ID], &[])
            .live
            .reclaimed
            .is_empty());
        assert_eq!(core.spawn_slots().held, 0);
        assert_eq!(spawner.stopped.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_node_connection_is_the_reachability_evidence() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        observed(&core);
        spawn(&core, "w1").await;
        let host = CoreHost(Arc::downgrade(&core));
        // Workspace discovery starts the real node in the background; it can
        // reach nothing here and would report itself waiting at any moment.
        // This test drives the node's states itself.
        core.stop_spawn_node().await;
        host.state(SpawnStatus::default());
        let reach = || core.spawned_agent_state(&named(&core, "w1")).unwrap().node;
        let status = |state| SpawnStatus {
            state,
            ..SpawnStatus::default()
        };
        assert_eq!(reach().state, NodeReach::Unknown);
        host.state(status(SpawnState::Live));
        assert_eq!(reach().state, NodeReach::Reachable);
        assert_eq!(
            core.hub.snapshot().spawn.unwrap().slots,
            Some(SpawnSlots {
                max: 0,
                held: 1,
                reserved: 0
            })
        );
        host.state(status(SpawnState::Waiting));
        let down = reach();
        assert_eq!(down.state, NodeReach::Unreachable);
        host.state(status(SpawnState::Connecting));
        host.state(status(SpawnState::Waiting));
        assert_eq!(reach().at, down.at, "down since the first drop");
        host.heartbeat_sent();
        assert_eq!(reach().state, NodeReach::Reachable);
        host.state(SpawnStatus::default());
        assert_eq!(reach().state, NodeReach::Unknown);
        assert_eq!(core.hub.snapshot().spawn.unwrap().slots, None);
        // Whatever the node's state, the apps get every harness's
        // description for its settings.
        assert_eq!(
            core.hub.snapshot().spawn.unwrap().harness_descriptors,
            Some(crate::relay::harness::published())
        );
    }

    #[tokio::test]
    async fn configured_settings_are_checked_stored_and_advertised() {
        let home = tempfile::tempdir().unwrap();
        let core = core(home.path(), Arc::new(FakeSpawner::default()));
        let change = |value: Value| ConfiguredChange::read(value.as_object().unwrap());
        for bad in [
            json!({"spawn_max_agents": -1}),
            json!({"spawn_max_agents": 33}),
            json!({"spawn_max_agents": "4"}),
            json!({"spawn_billing_codex": "free"}),
            json!({"spawn_repositories": ["/Users/me/repo"]}),
            json!({"spawn_repositories": "AgentWorkforce/relay"}),
        ] {
            assert!(change(bad.clone()).is_err(), "{bad}");
        }
        assert_eq!(core.settings()["spawn_allow_teammates"], false);
        let settings = core
            .set_settings(
                json!({"spawn_max_agents": 3, "spawn_billing_codex": "subscription",
                    "spawn_allow_teammates": true,
                    "spawn_repositories": ["AgentWorkforce/relay", "AgentWorkforce/relay"]})
                .as_object()
                .unwrap(),
            )
            .unwrap();
        assert_eq!(settings["spawn_max_agents"], 3);
        assert_eq!(settings["spawn_allow_teammates"], true);
        assert_eq!(settings["spawn_billing_codex"], "subscription");
        assert_eq!(settings["spawn_billing_claude"], "unspecified");
        assert_eq!(
            settings["spawn_repositories"],
            json!(["AgentWorkforce/relay"])
        );
        assert!(core
            .set_settings(json!({"spawn_max_agents": 99}).as_object().unwrap())
            .is_err());
        let advertised = core.spawn_advertisement(
            &[codex::ID, claude::ID],
            &core.spawn_settings().repositories,
        );
        assert_eq!(advertised.configured.max_agents, 3);
        assert!(advertised.configured.teammates);
        assert_eq!(advertised.configured.repositories, ["AgentWorkforce/relay"]);
        assert_eq!(
            advertised.configured.harnesses[0].billing,
            Billing::Subscription
        );
        assert_eq!(
            advertised.configured.harnesses[1].billing,
            Billing::Unspecified
        );
        assert_eq!(advertised.live.slots.max, 3);
        // Clearing the optional cap survives persistence and reaches the wire.
        let settings = core
            .set_settings(json!({"spawn_max_agents": 0}).as_object().unwrap())
            .unwrap();
        assert_eq!(settings["spawn_max_agents"], 0);
        assert_eq!(core.spawn_settings().max_agents, 0);
        assert_eq!(core.spawn_slots().free(), None);

        assert!(advertised.live.quota.is_empty(), "no quota lane is on");
        // Back to unspecified and no repositories: nothing stored.
        core.set_settings(
            json!({"spawn_billing_codex": "unspecified", "spawn_repositories": []})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert!(core
            .set_settings(json!({"spawn_allow_teammates": "yes"}).as_object().unwrap())
            .is_err());
        core.store.read(|store| {
            assert_eq!(store.spawn_allow_teammates, Some(true));
            assert_eq!(store.spawn_billing_codex, None);
            assert_eq!(store.spawn_repositories, None);
        });
    }

    #[tokio::test]
    async fn an_owner_is_never_taken_from_the_spawn_and_a_binding_never_changes() {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner::default());
        let core = core(home.path(), spawner.clone());
        observed(&core);
        // An owner claimed in the input, the task and Relaycast metadata.
        let frame = json!({"v": 1, "type": "action.invoke", "invocation_id": "inv_w1",
            "action": "spawn:codex", "caller_id": "agent_mallory",
            "metadata": {"fleet": {"owner": "user_mallory"}},
            "input": {"name": "w1", "task": "owner: user_mallory",
                "owner": {"userID": "user_mallory", "workspaceID": "ws_1"},
                "cloud_user_id": "user_mallory"}});
        let Some(Ok(Invoke::Spawn(request))) = wire::invoke(&frame) else {
            panic!("not a spawn")
        };
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        core.clone().answer_spawn(link, request.clone()).await;
        let registration = named(&core, "w1");
        assert_eq!(registration.spawn.as_ref().unwrap().owner, None);
        assert_eq!(owner_of(&registration), Ownership::Unknown);

        // A reconnect (a new link, a new instance) re-sending the spawn
        // answers as before and binds nothing new.
        let (link, sent) = NodeLink::detached(node());
        let _frames = relaycast(link.clone(), sent);
        assert_eq!(
            core.clone().answer_spawn(link, request.clone()).await,
            wire::action_output("inv_w1", wire::spawned("w1"))
        );
        assert_eq!(spawner.launched.lock().unwrap().len(), 1);
        assert_eq!(named(&core, "w1"), registration);
        // The same invocation asking for another agent is refused…
        let (link, _sent) = NodeLink::detached(node());
        let changed = core
            .clone()
            .answer_spawn(
                link,
                SpawnRequest {
                    name: "w9".into(),
                    ..request.clone()
                },
            )
            .await;
        assert!(changed["error"]
            .as_str()
            .unwrap()
            .starts_with("spawn_invalid_input: invocation inv_w1 already spawned @w1"));
        // …and so is the name under another invocation.
        let (link, _sent) = NodeLink::detached(node());
        let reused = core
            .clone()
            .answer_spawn(
                link,
                SpawnRequest {
                    invocation_id: "inv_other".into(),
                    ..request
                },
            )
            .await;
        assert!(reused["error"]
            .as_str()
            .unwrap()
            .starts_with("spawn_agent_name_in_use"));
        assert_eq!(named(&core, "w1"), registration);

        // A binding Agent Relay vouched for is what delivery reads; it
        // survives a restart in the store.
        let owner = crate::relay::store::SpawnOwner {
            workspace_id: "ws_1".into(),
            user_id: "user_1".into(),
            relay_workspace_id: "rw_1".into(),
            actor_id: "actor_1".into(),
            authority_hash: "h".into(),
        };
        core.store
            .update(|store| {
                store.registrations[0].spawn.as_mut().unwrap().owner = Some(owner.clone())
            })
            .unwrap();
        drop(core);
        let restarted = super::tests::core(home.path(), Arc::new(FakeSpawner::default()));
        assert_eq!(owner_of(&named(&restarted, "w1")), Ownership::Known(owner));
    }

    #[test]
    fn an_ended_agent_is_reported_with_what_it_left() {
        assert_eq!(
            ended_line("w1", false, Some(0)),
            "Spawned agent @w1 is no longer running; its place here is free again."
        );
        assert!(ended_line("w1", true, None).ends_with(" It ended in the middle of a turn."));
        assert!(ended_line("w1", false, Some(1)).ends_with(" 1 message to it was not taken."));
        assert!(ended_line("w1", true, Some(3))
            .ends_with(" It ended in the middle of a turn, with 3 messages not taken."));
    }
}
