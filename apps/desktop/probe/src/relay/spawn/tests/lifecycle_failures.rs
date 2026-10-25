//! Spawns and releases whose durable records or harness fail part-way.

use super::*;
// The tests that deny writes with mode bits run on Unix only: Windows has
// none, and its access lists are not changed by the core.
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn release_w1() -> ReleaseRequest {
    ReleaseRequest {
        invocation_id: "release_w1".into(),
        name: "w1".into(),
        expected_agent_id: Some("agent_w1".into()),
    }
}

#[tokio::test]
async fn a_spawn_whose_recovery_intent_cannot_be_saved_registers_and_launches_nothing() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core(home.path(), spawner.clone());
    // A non-empty folder where the intents file goes: no write can replace it.
    let blocked = core.config.app_data_dir.join(intents::INTENTS_FILE);
    std::fs::create_dir_all(blocked.join("held")).unwrap();
    let (link, sent) = NodeLink::detached(node());
    let frames = relaycast(link.clone(), sent);
    let result = core.clone().answer_spawn(link, request("w1")).await;
    CoreHost(Arc::downgrade(&core)).sent(&result);
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .starts_with("spawn_failed: could not save the spawn's recovery record"),
        "{result}"
    );
    assert!(spawner.launched.lock().unwrap().is_empty());
    assert!(core.store.read(|store| store.registrations.is_empty()));
    let frames = frames.await.unwrap();
    assert!(frames.iter().all(|f| f["type"] != "agent.register"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_spawn_whose_receipt_cannot_be_saved_still_reports_the_running_agent() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        unconfirmed: true,
        ..FakeSpawner::default()
    });
    let core = core(home.path(), spawner.clone());
    // Receipts can be looked up but not written.
    let receipts = core.config.app_data_dir.join("spawn-completions");
    std::fs::create_dir_all(&receipts).unwrap();
    std::fs::set_permissions(&receipts, std::fs::Permissions::from_mode(0o500)).unwrap();
    let first = spawn(&core, "w1").await;
    assert_eq!(
        first,
        wire::action_output(
            "inv_w1",
            wire::spawned_unconfirmed("w1", "transport_closed")
        )
    );
    assert_eq!(core.store.read(|store| store.registrations.len()), 1);
    // A replay is answered from the saved registration, warning included,
    // and nothing is launched again.
    assert_eq!(spawn(&core, "w1").await, first);
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
    // Restart clears the in-memory answer; changed settings must not turn
    // the saved successful registration into an immutable failed receipt.
    let core = super::core(home.path(), spawner.clone());
    core.store
        .update(|store| store.accept_spawns = Some(false))
        .unwrap();
    assert_eq!(spawn(&core, "w1").await, first);
    // Once receipts can be written, release saves this one before it
    // forgets the agent, so a late replay still answers as the first did.
    std::fs::set_permissions(&receipts, std::fs::Permissions::from_mode(0o700)).unwrap();
    let released = core.clone().answer_release(release_w1()).await;
    assert_eq!(
        released,
        wire::action_output("release_w1", wire::released("w1"))
    );
    assert_eq!(spawn(&core, "w1").await, first);
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_spawn_kept_after_a_restart_is_answered_as_unconfirmed() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core(home.path(), spawner.clone());
    let kept = interrupted("w1", true, Some(Target::new(SessionKind::Codex, THREAD)));
    let registration = kept.registration(
        "agent_w1",
        Target::new(SessionKind::Codex, THREAD),
        None,
        (&node().node_id, &node().node_name),
    );
    let token = crate::relay::workspace::Secret::new("at_live_w1".to_string());
    assert!(core
        .store
        .update(|store| store.add(registration, token))
        .unwrap());
    let expected = wire::action_output(
        "inv_w1",
        wire::spawned_unconfirmed("w1", intents::INTERRUPTED),
    );
    assert_eq!(spawn(&core, "w1").await, expected);
    assert!(spawner.launched.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_release_that_cannot_end_the_agent_keeps_its_registration() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        unreleasable: true,
        ..FakeSpawner::default()
    });
    let core = core(home.path(), spawner.clone());
    spawn(&core, "w1").await;
    let released = core.clone().answer_release(release_w1()).await;
    assert_eq!(
        released["error"],
        "release_failed: could not end @w1: Codex did not archive its thread: timed out"
    );
    assert_eq!(spawner.stopped.lock().unwrap().len(), 1);
    assert_eq!(named(&core, "w1").agent_id, "agent_w1");
    assert_eq!(core.spawn_slots().held, 1);
}

#[tokio::test]
async fn a_panicked_launch_ends_its_intent_and_what_it_started() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        panics: true,
        ..FakeSpawner::default()
    });
    let core = core(home.path(), spawner.clone());
    let (link, sent) = NodeLink::detached(node());
    let frames = relaycast(link.clone(), sent);
    let result = core.clone().answer_spawn(link, request("w1")).await;
    CoreHost(Arc::downgrade(&core)).sent(&result);
    assert_eq!(
        result["error"],
        "spawn_failed: the launch stopped unexpectedly"
    );
    // A restart only finishes taking it off the node; it never keeps it.
    let left = intents::load(&core.config.app_data_dir);
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(left[0].ended);
    assert_eq!(
        left[0].target,
        Some(Target::new(SessionKind::Codex, THREAD))
    );
    assert_eq!(
        *spawner.stopped.lock().unwrap(),
        [Target::new(SessionKind::Codex, THREAD)]
    );
    assert!(core.store.read(|store| store.registrations.is_empty()));
    let frames = frames.await.unwrap();
    assert!(frames.iter().any(|f| f["type"] == "agent.deregister"));
}

#[tokio::test]
async fn a_launch_that_fails_after_starting_ends_its_session_before_its_intent() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        fails_started: true,
        ..FakeSpawner::default()
    });
    let core = core(home.path(), spawner.clone());
    let (link, sent) = NodeLink::detached(node());
    let frames = relaycast(link.clone(), sent);
    let result = core.clone().answer_spawn(link, request("w1")).await;
    CoreHost(Arc::downgrade(&core)).sent(&result);
    assert_eq!(
        result["error"],
        "spawn_harness_unavailable: Codex refused the first turn"
    );
    let thread = Target::new(SessionKind::Codex, THREAD);
    assert_eq!(*spawner.stopped.lock().unwrap(), [thread.clone()]);
    let left = intents::load(&core.config.app_data_dir);
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(left[0].ended, "ended only once its session was");
    assert_eq!(left[0].target, Some(thread));
    let frames = frames.await.unwrap();
    assert!(frames.iter().any(|f| f["type"] == "agent.deregister"));
}

#[tokio::test]
async fn a_failed_launch_whose_session_may_still_run_is_left_for_recovery() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        fails_started: true,
        unreleasable: true,
        ..FakeSpawner::default()
    });
    let core = core(home.path(), spawner.clone());
    let (link, sent) = NodeLink::detached(node());
    let frames = relaycast(link.clone(), sent);
    let result = core.clone().answer_spawn(link, request("w1")).await;
    CoreHost(Arc::downgrade(&core)).sent(&result);
    assert_eq!(
        result["error"],
        "spawn_failed: Codex refused the first turn"
    );
    assert_eq!(spawner.stopped.lock().unwrap().len(), 1, "asked to stop");
    // Not ended, and still registered: recovery finds its session and
    // stops it, or keeps it, rather than only taking the agent off.
    let left = intents::load(&core.config.app_data_dir);
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(!left[0].ended);
    assert_eq!(left[0].agent_id.as_deref(), Some("agent_w1"));
    assert_eq!(
        left[0].target,
        Some(Target::new(SessionKind::Codex, THREAD))
    );
    let frames = frames.await.unwrap();
    assert!(frames.iter().all(|f| f["type"] != "agent.deregister"));
}

/// Answers `agent.register` once the intents can no longer be written, and
/// `agent.deregister` as `deregistered` says, the folder writable again
/// first when it is confirmed.
#[cfg(unix)]
fn unsaved_identity(
    link: NodeLink,
    mut sent: tokio::sync::mpsc::UnboundedReceiver<Value>,
    dir: std::path::PathBuf,
    deregistered: bool,
) -> tokio::task::JoinHandle<Vec<Value>> {
    let mode = move |mode| std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode));
    tokio::spawn(async move {
        let mut frames = Vec::new();
        while let Ok(Some(frame)) =
            tokio::time::timeout(Duration::from_millis(500), sent.recv()).await
        {
            let answer = match frame["type"].as_str() {
                Some("agent.register") => {
                    mode(0o500).unwrap();
                    json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
                    "data": {"agent_id": "agent_w1", "name": "w1", "token": "at_live_w1"}})
                }
                Some("agent.deregister") if deregistered => {
                    mode(0o700).unwrap();
                    json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
                    "data": {"deregistered": true}})
                }
                _ => json!({"v": 1, "id": frame["id"], "type": "error", "ok": false,
                "code": "internal_error", "message": "try again"}),
            };
            link.answer(&answer);
            frames.push(frame);
        }
        frames
    })
}

#[cfg(unix)]
#[tokio::test]
async fn an_unsaved_identity_is_forgotten_only_once_relaycast_confirms_it_off() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core(home.path(), spawner.clone());
    let dir = core.config.app_data_dir.clone();
    let (link, sent) = NodeLink::detached(node());
    let frames = unsaved_identity(link.clone(), sent, dir.clone(), true);
    let result = core.clone().answer_spawn(link, request("w1")).await;
    CoreHost(Arc::downgrade(&core)).sent(&result);
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .starts_with("spawn_failed: could not save the registered agent's recovery record"),
        "{result}"
    );
    assert!(spawner.launched.lock().unwrap().is_empty());
    assert!(intents::load(&dir).is_empty(), "confirmed off the node");
    let frames = frames.await.unwrap();
    assert!(frames.iter().any(|f| f["type"] == "agent.deregister"));
}

#[cfg(unix)]
#[tokio::test]
async fn an_unsaved_identity_whose_deregistration_is_refused_is_kept_for_recovery() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core(home.path(), spawner.clone());
    let dir = core.config.app_data_dir.clone();
    let (link, sent) = NodeLink::detached(node());
    let frames = unsaved_identity(link.clone(), sent, dir.clone(), false);
    let result = core.clone().answer_spawn(link, request("w1")).await;
    CoreHost(Arc::downgrade(&core)).sent(&result);
    assert!(result["error"].is_string(), "{result}");
    assert!(spawner.launched.lock().unwrap().is_empty());
    frames.await.unwrap();
    // Nothing could be written: the record is held in memory, ended, with
    // the identity Relaycast returned.
    let held = intents::load(&dir);
    assert_eq!(held.len(), 1, "{held:?}");
    assert!(held[0].ended);
    assert_eq!(held[0].agent_id.as_deref(), Some("agent_w1"));
    // The next connection takes it off the node.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let host = CoreHost(Arc::downgrade(&core));
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
}
