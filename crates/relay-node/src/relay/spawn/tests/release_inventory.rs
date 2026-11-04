//! A released agent stays in the node's inventory until its release result
//! is sent: an inventory without it first makes Relaycast take the ended
//! agent for missing and fail the release (`agent_identity_mismatch`).

use super::*;
use std::time::{Duration, Instant};
use tokio::sync::Notify;

fn release_w1() -> ReleaseRequest {
    ReleaseRequest {
        invocation_id: "release_w1".into(),
        name: "w1".into(),
        expected_agent_id: Some("agent_w1".into()),
    }
}

fn lists_w1(core: &Core) -> bool {
    core.spawned_inventory(&node())
        .iter()
        .any(|a| a.name == "w1")
}

/// Whether the node was told its places changed, within a short wait.
async fn told(changed: &Notify) -> bool {
    tokio::time::timeout(Duration::from_millis(50), changed.notified())
        .await
        .is_ok()
}

#[tokio::test]
async fn a_released_agent_is_listed_until_its_result_is_sent() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    spawn(&core, "w1").await;
    assert!(lists_w1(&core));
    let changed = core.ledger().changed.clone();
    while told(&changed).await {}

    let released = core.clone().answer_release(release_w1()).await;
    assert_eq!(
        released,
        wire::action_output("release_w1", wire::released("w1"))
    );
    assert!(core.store.read(|store| store.registrations.is_empty()));
    assert_eq!(core.spawn_slots().held, 0);
    // Still listed, and the node not told yet: the result goes first.
    assert!(lists_w1(&core));
    assert!(!told(&changed).await);

    core.release_result_sent("release_w1");
    assert!(!lists_w1(&core));
    assert!(told(&changed).await);
    // Any other result leaves nothing to tell.
    core.release_result_sent("release_w1");
    assert!(!told(&changed).await);
}

#[tokio::test]
async fn a_release_that_fails_lists_nothing_extra() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        unreleasable: true,
        ..FakeSpawner::default()
    });
    let core = core(home.path(), spawner);
    spawn(&core, "w1").await;
    let released = core.clone().answer_release(release_w1()).await;
    assert!(released["error"]
        .as_str()
        .unwrap()
        .starts_with("release_failed"));
    assert!(core.ledger().lock().releasing.is_empty());
    // Listed as before, from its kept registration.
    assert!(lists_w1(&core));
}

#[tokio::test]
async fn a_released_agent_whose_result_is_never_sent_is_listed_no_longer_than_it_is_kept() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    spawn(&core, "w1").await;
    core.clone().answer_release(release_w1()).await;
    assert!(lists_w1(&core));
    // The socket closed before the result was written, and the next
    // connection came after the result was given up.
    let given_up = Instant::now()
        .checked_sub(super::node::RESULT_KEEP + Duration::from_secs(1))
        .unwrap();
    for releasing in core.ledger().lock().releasing.values_mut() {
        releasing.since = given_up;
    }
    assert!(!lists_w1(&core));
    assert!(core.ledger().lock().releasing.is_empty());
}
