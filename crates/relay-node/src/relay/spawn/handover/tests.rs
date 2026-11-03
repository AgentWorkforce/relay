use super::*;
use crate::relay::contract::spawned::TakenOver;
use crate::relay::contract::transcript::LocalTranscriptEntry;
use crate::relay::harness::{claude, codex, RunningSession};
use crate::relay::spawn::intents::Intent;
use crate::relay::spawn::launch::{Launch, LaunchError, Launched, Started};
use crate::relay::spawn::ledger::LEDGERS;
use crate::relay::spawn::observe::Observe;
use crate::relay::store::{SessionKind, Target};
use crate::relay::workspace::Secret;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

const SESSION: &str = "0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d";
const HEADLESS: SpawnedProcess = SpawnedProcess { pid: 700, start: 7 };
const RESUMED: SpawnedProcess = SpawnedProcess { pid: 800, start: 8 };

/// A spawned Claude: its headless process runs until stopped (unless
/// `stubborn`), and `resumed` is the session the person opened.
struct FakeClaude {
    headless: AtomicBool,
    stubborn: bool,
    stops: AtomicU32,
    resumed: Mutex<Option<RunningSession>>,
}

impl FakeClaude {
    fn new(stubborn: bool) -> Arc<FakeClaude> {
        Arc::new(FakeClaude {
            headless: AtomicBool::new(true),
            stubborn,
            stops: AtomicU32::new(0),
            resumed: Mutex::new(None),
        })
    }

    fn resume(&self) {
        *self.resumed.lock().unwrap() = Some(RunningSession {
            process: RESUMED,
            directory: Some(PathBuf::from("/work/api")),
        });
    }
}

impl Spawner for FakeClaude {
    fn available(&self) -> Vec<HarnessId> {
        vec![claude::ID]
    }

    fn launch(&self, _: &Launch, _: Started) -> Result<Launched, LaunchError> {
        Err(LaunchError::Failed("not here".into()))
    }

    fn alive(&self, _: &Target, process: Option<&SpawnedProcess>) -> bool {
        match process {
            Some(&HEADLESS) => self.headless.load(Ordering::SeqCst),
            Some(&RESUMED) => self.resumed.lock().unwrap().is_some(),
            _ => false,
        }
    }

    fn stop(&self, _: &Target, process: Option<&SpawnedProcess>) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        if process == Some(&HEADLESS) && !self.stubborn {
            self.headless.store(false, Ordering::SeqCst);
        }
    }

    fn hands_over(&self, target: &Target) -> bool {
        target.kind == SessionKind::ClaudeTerminal
    }

    fn transcript(
        &self,
        target: &Target,
        cursor: Option<&LocalTranscriptCursor>,
    ) -> Option<Result<LocalTranscriptPage, String>> {
        self.hands_over(target).then(|| {
            Ok(LocalTranscriptPage {
                entries: vec![LocalTranscriptEntry {
                    id: "0.0".into(),
                    role: "user".into(),
                    kind: "text".into(),
                    text: format!("from {:?}", cursor.map(|c| c.id)),
                    image_path: None,
                    timestamp_ms: 1,
                    truncated: false,
                }],
                next_cursor: None,
                follow_cursor: None,
            })
        })
    }

    fn session(&self, _: &Target) -> Option<RunningSession> {
        if self.headless.load(Ordering::SeqCst) {
            return Some(RunningSession {
                process: HEADLESS,
                directory: Some(PathBuf::from("/work/api")),
            });
        }
        self.resumed.lock().unwrap().clone()
    }
}

/// Says each agent works while `working` is set.
#[derive(Default)]
struct Turns {
    working: AtomicBool,
}

impl Observe for Turns {
    fn observe(&self, agents: &[Watched]) -> Vec<Observation> {
        let working = self.working.load(Ordering::SeqCst);
        agents
            .iter()
            .map(|agent| Observation {
                process: if agent.alive {
                    ProcessLiveness::Running
                } else {
                    ProcessLiveness::Exited
                },
                work: if working {
                    WorkState::Working
                } else {
                    WorkState::Idle
                },
                turn_in_progress: agent.alive && working,
            })
            .collect()
    }
}

fn core(home: &std::path::Path, spawner: Arc<FakeClaude>) -> (Arc<Core>, Arc<Turns>) {
    let config = crate::relay::daemon::Config {
        paths: crate::relay::paths::CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app-data"),
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
        spawner,
        ..crate::relay::daemon::Plugins::default()
    };
    let (core, _signals) = Core::with_plugins(config, plugins);
    LEDGERS.lock().unwrap().remove(&core.config.app_data_dir);
    let turns = Arc::new(Turns::default());
    core.ledger().set_observer(turns.clone());
    (core, turns)
}

/// A spawned agent named `name` on `kind`, as a spawn saves it.
fn spawned(core: &Core, name: &str, kind: SessionKind, harness: HarnessId) {
    let intent = Intent {
        invocation_id: format!("inv_{name}"),
        name: name.into(),
        harness,
        node_id: "node_desktop_1".into(),
        node_name: "test-desk-desktop".into(),
        title: "Fix CI".into(),
        base_url: "https://cast.example".into(),
        workspace_key: Secret::new("rk_live_test0000".to_string()),
        workspace_id: None,
        machine_prefix: "test-desk".into(),
        message_id: format!("spawn-inv_{name}"),
        session_id: SESSION.into(),
        created_ms: 0,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: None,
        token: None,
        requester: None,
        target: None,
        process: None,
    };
    let process = (kind == SessionKind::ClaudeTerminal).then_some(HEADLESS);
    let registration = intent.registration(
        &format!("agent_{name}"),
        Target::new(kind, SESSION),
        process,
        ("node_desktop_1", "test-desk-desktop"),
    );
    let token = Secret::new(format!("at_live_{name}"));
    assert!(core
        .store
        .update(|store| store.add(registration, token))
        .unwrap());
}

fn named(core: &Core, name: &str) -> Registration {
    core.store.read(|store| {
        store
            .registrations
            .iter()
            .find(|r| r.name == name)
            .cloned()
            .unwrap()
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_claude_is_stopped_and_handed_over_under_its_name() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(false);
    let (core, _) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    let before = core.session_spawn(&named(&core, "c1")).unwrap();
    assert!(before.can_take_over && !before.taken_over);
    assert_eq!(before.harness, "claude");

    let taken = core.take_over("c1", false, TURN_WAIT).await.unwrap();
    assert_eq!(
        taken,
        TakenOver {
            name: "c1".into(),
            target: Target::new(SessionKind::ClaudeTerminal, SESSION),
            directory: Some("/work/api".into()),
            interrupted: false,
        }
    );
    assert!(!claude.headless.load(Ordering::SeqCst));
    let registration = named(&core, "c1");
    let spawn = registration.spawn.clone().unwrap();
    assert!(spawn.taken_over_at.is_some());
    assert_eq!(spawn.process, None, "the headless process is gone");
    assert_eq!(
        registration.direct_address("test-desk"),
        "c1@test-desk-desktop"
    );
    let after = core.session_spawn(&registration).unwrap();
    assert!(!after.can_take_over && after.taken_over);

    // Asked again, it answers the same without stopping anything more.
    let again = core.take_over("c1", false, TURN_WAIT).await.unwrap();
    assert_eq!(again.target, taken.target);
    assert_eq!(claude.stops.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_agent_follows_the_session_the_person_opened() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(false);
    let (core, _) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    core.take_over("c1", false, TURN_WAIT).await.unwrap();

    // Opening: nothing runs the session yet, and the agent keeps its place.
    core.observe_spawned().await;
    let state = core.spawned_agent_state(&named(&core, "c1")).unwrap();
    assert!(state.holds_slot);
    assert_eq!(state.process.state, ProcessLiveness::Unknown);
    assert_eq!(state.unfinished, None);

    // Resumed: the agent's process is the person's client.
    claude.resume();
    core.observe_spawned().await;
    assert_eq!(named(&core, "c1").spawn.unwrap().process, Some(RESUMED));
    let state = core.spawned_agent_state(&named(&core, "c1")).unwrap();
    assert_eq!(state.process.state, ProcessLiveness::Running);
    assert!(core.spawned_live().contains(&named(&core, "c1").target));

    // Taking it off here, or Cloud releasing it, leaves the person's
    // client running.
    core.stop_spawned(&named(&core, "c1"));
    let released = core
        .clone()
        .answer_release(crate::relay::spawn::wire::ReleaseRequest {
            invocation_id: "inv_r1".into(),
            name: "c1".into(),
            expected_agent_id: Some("agent_c1".into()),
        })
        .await;
    assert_eq!(released["error"], Value::Null, "{released}");
    assert!(core.store.read(|store| store.registrations.is_empty()));
    assert_eq!(claude.stops.load(Ordering::SeqCst), 1);
}

#[test]
fn a_session_not_reopened_in_time_counts_as_ended() {
    let claude = FakeClaude::new(false);
    claude.headless.store(false, Ordering::SeqCst);
    let now = Utc::now();
    let agent = |name: &str| Watched {
        name: name.into(),
        target: Target::new(SessionKind::ClaudeTerminal, SESSION),
        process: None,
        alive: false,
    };
    let mut watched = [agent("recent"), agent("long ago"), agent("spawned")];
    let taken = [
        Some(now - chrono::Duration::seconds(10)),
        Some(now - OPENING_GRACE - chrono::Duration::seconds(1)),
        None,
    ];
    let (adopted, opening) = follow_sessions(claude.as_ref(), &mut watched, &taken, now);
    assert!(adopted.is_empty());
    assert_eq!(opening, [0]);
    claude.resume();
    let (adopted, opening) = follow_sessions(claude.as_ref(), &mut watched, &taken, now);
    assert_eq!(
        adopted,
        [
            ("recent".to_string(), RESUMED),
            ("long ago".to_string(), RESUMED)
        ]
    );
    assert!(opening.is_empty());
    assert!(watched[0].alive && watched[1].alive);
    assert!(!watched[2].alive, "only a session taken over is followed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_turn_running_is_waited_for_or_interrupted_when_asked() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(false);
    let (core, turns) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    turns.working.store(true, Ordering::SeqCst);

    // Still working when the wait runs out: nothing is stopped.
    let error = core
        .take_over("c1", false, Duration::from_millis(50))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Busy);
    assert!(
        error.message.contains("middle of a turn"),
        "{}",
        error.message
    );
    assert_eq!(claude.stops.load(Ordering::SeqCst), 0);
    assert!(named(&core, "c1").spawn.unwrap().taken_over_at.is_none());

    // The turn ends while it waits: taken over cleanly.
    let waiting = {
        let core = core.clone();
        tokio::spawn(async move { core.take_over("c1", false, TURN_WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(claude.stops.load(Ordering::SeqCst), 0, "waits for the turn");
    turns.working.store(false, Ordering::SeqCst);
    let taken = waiting.await.unwrap().unwrap();
    assert!(!taken.interrupted);
    assert_eq!(claude.stops.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_interrupt_asked_while_one_waits_stops_it_at_once() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(false);
    let (core, turns) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    turns.working.store(true, Ordering::SeqCst);
    let waiting = {
        let core = core.clone();
        tokio::spawn(async move { core.take_over("c1", false, TURN_WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    let interrupted = core.take_over("c1", true, TURN_WAIT).await.unwrap();
    let taken = waiting.await.unwrap().unwrap();
    assert!(taken.interrupted);
    assert_eq!(interrupted, taken, "both calls answer alike");
    assert_eq!(claude.stops.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claude_that_does_not_stop_is_not_handed_over() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(true);
    let (core, _) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    let error = core.take_over("c1", false, TURN_WAIT).await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Internal);
    assert!(error.message.contains("did not stop"), "{}", error.message);
    let spawn = named(&core, "c1").spawn.unwrap();
    assert_eq!(spawn.taken_over_at, None);
    assert_eq!(spawn.process, Some(HEADLESS));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_spawned_agent_that_hands_over_is_taken_over_or_read() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(false);
    let (core, _) = core(home.path(), claude.clone());
    spawned(&core, "x1", SessionKind::Codex, codex::ID);
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    let codex = core.take_over("x1", false, TURN_WAIT).await.unwrap_err();
    assert_eq!(codex.data.kind, ErrorKind::Refused);
    assert_eq!(
        codex.message,
        "A spawned Codex agent cannot be taken over; open its session in Codex instead."
    );
    let spawn = core.session_spawn(&named(&core, "x1")).unwrap();
    assert!(!spawn.can_take_over && !spawn.taken_over);
    let missing = core
        .take_over("nobody", false, TURN_WAIT)
        .await
        .unwrap_err();
    assert_eq!(missing.data.kind, ErrorKind::NotFound);
    assert_eq!(
        core.spawned_transcript("x1", None)
            .await
            .unwrap_err()
            .data
            .kind,
        ErrorKind::Refused
    );
    let page = core
        .spawned_transcript("c1", Some(LocalTranscriptCursor { ts_ms: 0, id: 42 }))
        .await
        .unwrap();
    assert_eq!(page.entries[0].text, "from Some(42)");
    assert_eq!(claude.stops.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_waiting_takeover_refuses_a_replacement_agent() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(false);
    let (core, turns) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    turns.working.store(true, Ordering::SeqCst);
    let waiting = {
        let core = core.clone();
        tokio::spawn(async move { core.take_over("c1", false, TURN_WAIT).await })
    };
    for _ in 0..100 {
        if core.ledger().lock().taking_over.contains_key("c1") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(core.ledger().lock().taking_over.contains_key("c1"));
    core.store
        .update(|store| {
            let replacement = store
                .registrations
                .iter_mut()
                .find(|r| r.name == "c1")
                .unwrap();
            replacement.agent_id = "agent_replacement".into();
            replacement.target.id = "replacement-session".into();
        })
        .unwrap();
    turns.working.store(false, Ordering::SeqCst);
    let error = waiting.await.unwrap().unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Refused);
    assert_eq!(claude.stops.load(Ordering::SeqCst), 0);
    assert!(named(&core, "c1").spawn.unwrap().taken_over_at.is_none());
}

/// Waits until `done` holds, for at most about a second.
async fn until(done: impl Fn() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never happened");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_under_way_is_waited_for_and_so_is_the_turn_it_starts() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(false);
    let (core, turns) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    let delivering = core.agent_locks.get("c1").lock_owned().await;
    let waiting = {
        let core = core.clone();
        tokio::spawn(async move { core.take_over("c1", false, TURN_WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        claude.stops.load(Ordering::SeqCst),
        0,
        "waits for the delivery"
    );

    // The message it delivered started a turn: that turn is waited for too.
    turns.working.store(true, Ordering::SeqCst);
    drop(delivering);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(claude.stops.load(Ordering::SeqCst), 0, "waits for the turn");
    turns.working.store(false, Ordering::SeqCst);
    let taken = waiting.await.unwrap().unwrap();
    assert!(!taken.interrupted);
    assert_eq!(claude.stops.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_is_marked_taken_over_only_once_its_process_is_gone() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(true);
    let (core, _) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    let waiting = {
        let core = core.clone();
        tokio::spawn(async move { core.take_over("c1", false, TURN_WAIT).await })
    };
    until(|| claude.stops.load(Ordering::SeqCst) == 1).await;

    // Still stopping: not taken over, and no observation pass takes the
    // stop for the agent ending.
    let spawn = named(&core, "c1").spawn.unwrap();
    assert_eq!(spawn.taken_over_at, None);
    assert_eq!(spawn.process, Some(HEADLESS));
    assert!(core.ledger().lock().observing);

    claude.headless.store(false, Ordering::SeqCst);
    waiting.await.unwrap().unwrap();
    let spawn = named(&core, "c1").spawn.unwrap();
    assert!(spawn.taken_over_at.is_some());
    assert_eq!(spawn.process, None);
    assert!(!core.ledger().lock().observing);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_take_over_that_joins_one_gives_its_answer_even_a_refusal() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(false);
    let (core, turns) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    turns.working.store(true, Ordering::SeqCst);
    let waiting = {
        let core = core.clone();
        tokio::spawn(async move {
            core.take_over("c1", false, Duration::from_millis(600))
                .await
        })
    };
    until(|| core.ledger().lock().taking_over.contains_key("c1")).await;
    let joined = core.take_over("c1", false, TURN_WAIT).await.unwrap_err();
    let first = waiting.await.unwrap().unwrap_err();
    assert_eq!(first.data.kind, ErrorKind::Busy);
    assert_eq!(joined, first);
    assert_eq!(claude.stops.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_take_over_still_stopping_its_agent_offers_no_resume_yet() {
    let home = tempfile::tempdir().unwrap();
    let claude = FakeClaude::new(true);
    let (core, _) = core(home.path(), claude.clone());
    spawned(&core, "c1", SessionKind::ClaudeTerminal, claude::ID);
    let taking = {
        let core = core.clone();
        tokio::spawn(async move { core.take_over("c1", false, TURN_WAIT).await })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while claude.stops.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    // Nothing durable claims completion while the headless process still runs.
    assert!(named(&core, "c1").spawn.unwrap().taken_over_at.is_none());
    let pending = core.session_spawn(&named(&core, "c1")).unwrap();
    assert!(!pending.taken_over, "not resumable while it still runs");
    // A restarted core has no in-memory claim and must still refuse resume
    // and clean up the original headless process on release.
    let (restarted, _) = self::core(home.path(), claude.clone());
    let saved = named(&restarted, "c1");
    assert!(!restarted.session_spawn(&saved).unwrap().taken_over);
    let stops = claude.stops.load(Ordering::SeqCst);
    restarted.stop_spawned(&saved);
    assert_eq!(claude.stops.load(Ordering::SeqCst), stops + 1);
    // It never stops: the take over fails and nothing was handed over.
    assert!(taking.await.unwrap().is_err());
    let after = core.session_spawn(&named(&core, "c1")).unwrap();
    assert!(!after.taken_over && after.can_take_over);
}
