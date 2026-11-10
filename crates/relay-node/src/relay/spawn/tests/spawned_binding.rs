//! A spawned session's own connection (its SessionStart hook, an activation
//! pass, its own registration request) binds to the registration its spawn
//! saves: one registration, one roster identity, its requester kept. Any
//! other session still gets a registration of its own.

use super::report_back::relaycast_routes;
use super::*;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::SpawnRequester;

fn session(thread: &str) -> DiscoveredSession {
    DiscoveredSession {
        target: Target::new(SessionKind::Codex, thread),
        // The spawn header is the thread's title, as Codex names it.
        title: "[via Agent Relay — spawned as @w1 (w1@test-desk-desktop)] Fix CI".into(),
        directory: None,
        updated_at_ms: None,
        live: true,
        host: None,
        holder: None,
    }
}

fn with_account(home: &std::path::Path, spawner: Arc<FakeSpawner>, rest: &str) -> Arc<Core> {
    core_built(
        home,
        spawner,
        Arc::new(crate::relay::cloud_session::SignedOut),
        rest,
        Some(crate::relay::test_account::TestAccount::new().into_plugin()),
    )
}

/// The worker's own registration request, started now.
fn worker_registers(
    core: &Arc<Core>,
    thread: &'static str,
) -> tokio::task::JoinHandle<
    Result<crate::relay::agents::Registered, crate::relay::protocol::RpcError>,
> {
    let core = core.clone();
    tokio::spawn(async move {
        core.register_session(&session(thread), None, None, true)
            .await
    })
}

#[tokio::test]
async fn a_spawned_workers_own_connection_binds_to_its_spawn_registration() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        starts_before_pause: true,
        ..FakeSpawner::default()
    });
    let (started_tx, started) = std::sync::mpsc::channel();
    let (proceed, proceed_rx) = std::sync::mpsc::channel();
    *spawner.pause.lock().unwrap() = Some((started_tx, proceed_rx));
    let core = core(home.path(), spawner.clone());
    let (link, sent) = NodeLink::detached(node());
    let frames = relaycast(link.clone(), sent);
    let spawning = tokio::spawn(core.clone().answer_spawn(link, request("w1")));
    tokio::task::spawn_blocking(move || started.recv().unwrap())
        .await
        .unwrap();

    // Started, not yet saved: discovery already counts it as spawned.
    let target = Target::new(SessionKind::Codex, THREAD);
    assert!(core.store.read(|store| store.registrations.is_empty()));
    assert!(core.spawned_targets().contains(&target));

    // The worker's own connection asks to be registered in that window,
    // and waits for the spawn instead of registering an agent of its own.
    let worker = worker_registers(&core, THREAD);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !worker.is_finished(),
        "it waits for the spawn's registration"
    );
    proceed.send(()).unwrap();
    spawning.await.unwrap();
    let registered = worker.await.unwrap().unwrap();
    assert_eq!(registered.name, "w1");
    assert!(registered.already_registered);
    assert_eq!(registered.address, "w1@test-desk-desktop");

    // One registration, the spawn's, with its record intact.
    let registrations = core.store.read(|store| store.registrations.clone());
    assert_eq!(registrations.len(), 1, "{registrations:?}");
    let registration = &registrations[0];
    assert_eq!(registration.target, target);
    assert_eq!(registration.agent_id, "agent_w1");
    let spawn = registration.spawn.as_ref().unwrap();
    assert_eq!(spawn.invocation_id, "inv_w1");
    assert_eq!(spawn.node_name, "test-desk-desktop");
    assert!(spawn.taken_over_at.is_none());

    // One roster identity: the node's agent.register, and no other.
    let frames = frames.await.unwrap();
    assert_eq!(
        frames
            .iter()
            .filter(|frame| frame["type"] == "agent.register")
            .count(),
        1,
        "{frames:?}"
    );

    // Asked again once saved, the answer is the same identity.
    let again = worker_registers(&core, THREAD).await.unwrap().unwrap();
    assert_eq!(
        (again.name.as_str(), again.already_registered),
        ("w1", true)
    );
    assert_eq!(core.store.read(|store| store.registrations.len()), 1);
    assert!(core.spawned_targets().contains(&target));
}

#[tokio::test]
async fn the_requester_still_approves_after_the_worker_connected() {
    let home = tempfile::tempdir().unwrap();
    let core = with_account(
        home.path(),
        Arc::new(FakeSpawner::default()),
        "http://localhost:9",
    );
    core.store
        .update(|store| store.extras.spawn_requester_approvals = Some(true))
        .unwrap();
    let target = Target::new(SessionKind::Codex, THREAD);
    let requester = SpawnRequester {
        name: "grokbot".into(),
        agent_id: "agent_grokbot".into(),
    };
    // A spawn whose launch started the thread and has not saved it yet.
    let mut intent = interrupted("w1", true, Some(target.clone()));
    intent.requester = Some(requester.clone());
    intents::put(&core.config.app_data_dir, &intent).unwrap();
    assert!(core.spawned_targets().contains(&target));

    let worker = worker_registers(&core, THREAD);
    tokio::time::sleep(Duration::from_millis(200)).await;
    // The spawn saves its registration, as `answer_spawn` does.
    let saved = intent.registration(
        "agent_w1",
        target.clone(),
        None,
        (&node().node_id, &node().node_name),
    );
    assert!(core
        .store
        .update(|store| {
            crate::relay::spawn::report_back::add_spawned(
                store,
                saved,
                crate::relay::workspace::Secret::new("at_live_w1"),
            )
        })
        .unwrap());
    let registered = worker.await.unwrap().unwrap();
    assert_eq!(
        (registered.name.as_str(), registered.already_registered),
        ("w1", true)
    );

    let registration = core
        .store
        .read(|store| store.registration_for(&target).cloned())
        .unwrap();
    assert_eq!(core.store.read(|store| store.registrations.len()), 1);
    let spawn = registration.spawn.as_ref().unwrap();
    assert_eq!(spawn.requester.as_ref(), Some(&requester));
    assert!(spawn.taken_over_at.is_none());
    assert_eq!(
        core.approving_requester(&registration),
        Some(requester),
        "the requester is still found after the worker connected"
    );
}

#[tokio::test]
async fn a_spawned_session_is_refused_an_identity_of_its_own_while_its_spawn_saves() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let target = Target::new(SessionKind::Codex, THREAD);
    // The launch started it; the spawn never saved (it is being abandoned).
    let intent = interrupted("w1", true, Some(target.clone()));
    intents::put(&core.config.app_data_dir, &intent).unwrap();
    let refused = worker_registers(&core, THREAD).await.unwrap().unwrap_err();
    assert_eq!(
        refused.data.kind,
        crate::relay::protocol::ErrorKind::Refused,
        "{refused:?}"
    );
    assert!(core.store.read(|store| store.registrations.is_empty()));
    // Once the spawn has ended, the session is no longer held for it.
    intents::put(
        &core.config.app_data_dir,
        &intents::Intent {
            ended: true,
            ..intent
        },
    )
    .unwrap();
    assert!(!core.spawned_targets().contains(&target));
}

#[tokio::test]
async fn a_session_no_spawn_started_is_not_held_for_one() {
    const OTHER: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    // Another thread is being spawned meanwhile.
    let spawned = Target::new(SessionKind::Codex, THREAD);
    intents::put(
        &core.config.app_data_dir,
        &interrupted("w1", true, Some(spawned.clone())),
    )
    .unwrap();
    let other = Target::new(SessionKind::Codex, OTHER);
    assert!(core.spawned_targets().contains(&spawned));
    assert!(!core.spawned_targets().contains(&other));
    // It goes straight to Relaycast for an agent of its own: nothing
    // listens here, so the registration fails there, not as a spawn's.
    let started = std::time::Instant::now();
    let error = worker_registers(&core, OTHER).await.unwrap().unwrap_err();
    assert_ne!(
        error.data.kind,
        crate::relay::protocol::ErrorKind::Refused,
        "{error:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "never waits on a spawn"
    );
}

/// The positive half, against Relaycast's REST API: a session no spawn
/// started is registered as an agent of its own, with no spawn record.
#[tokio::test]
async fn a_session_no_spawn_started_gets_a_registration_of_its_own() {
    const OTHER: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    let home = tempfile::tempdir().unwrap();
    let (rest, seen) = relaycast_routes(vec![(
        "POST /v1/agents ",
        "200 OK",
        json!({"ok": true, "data": {
            "id": "agent_solo", "name": "solo", "token": "at_live_solo"
        }}),
    )]);
    let core = core_at(home.path(), Arc::new(FakeSpawner::default()), &rest);
    let registered = core
        .register_session(&session(OTHER), Some("solo"), None, true)
        .await
        .unwrap();
    assert_eq!(registered.name, "solo");
    assert!(!registered.already_registered);
    assert_ne!(registered.address, "solo@test-desk-desktop");
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .any(|line| line.starts_with("POST /v1/agents ")),
        "{seen:?}"
    );
    let other = Target::new(SessionKind::Codex, OTHER);
    let registration = core
        .store
        .read(|store| store.registration_for(&other).cloned())
        .unwrap();
    assert_eq!(registration.agent_id, "agent_solo");
    assert!(registration.spawn.is_none());
}
