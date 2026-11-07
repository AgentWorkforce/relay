//! Regression coverage from the restart / startup dogfood failures.
use super::*;

#[tokio::test]
async fn a_saved_spawn_is_in_a_fresh_cores_inventory_without_relaunching() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let first = core(home.path(), spawner.clone());
    spawn(&first, "w1").await;
    let target = named(&first, "w1").target;
    let restarted = core(home.path(), spawner.clone());
    observed(&restarted);
    assert_eq!(restarted.spawned_inventory(&node()).len(), 1);
    restarted.observe_spawned().await;
    assert!(restarted.spawned_live().contains(&target));
    assert_eq!(restarted.spawned_inventory(&node())[0].name, "w1");
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_ended_intent_does_not_reserve_a_slot_or_block_another_invocation() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let mut old = interrupted("old-grok", true, None);
    old.harness = crate::relay::harness::grok::ID;
    old.ended = true;
    intents::put(&core.config.app_data_dir, &old).unwrap();
    assert_eq!(core.spawn_slots().reserved, 0);
    assert_eq!(core.spawn_slots().held, 0);
    let (link, _) = NodeLink::detached(node());
    let mut next = request("next-grok");
    next.harness = old.harness;
    let reservation = core.reserve_place(&link, &next).unwrap();
    assert_eq!(core.spawn_slots().reserved, 1);
    drop(reservation);
    assert_eq!(core.spawn_slots().reserved, 0);
}

#[tokio::test]
async fn a_failed_launch_reports_structured_reason_and_cleans_up_on_ack() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        fails_started: true,
        ..FakeSpawner::default()
    });
    let core = core(home.path(), spawner.clone());
    let (mut link, mut sent) = NodeLink::detached(node());
    link.error_details = true;
    let answer = link.clone();
    let responder = tokio::spawn(async move {
        while let Some(frame) = sent.recv().await {
            let data = match frame["type"].as_str() {
                Some("agent.register") => {
                    json!({"agent_id":"agent_w1", "name":"w1", "token":"at_test"})
                }
                Some("agent.deregister") => json!({"deregistered":true}),
                _ => continue,
            };
            answer.answer(&json!({"v":1,"id":frame["id"],"type":"reply","ok":true,"data":data}));
            if frame["type"] == "agent.deregister" {
                break;
            }
        }
    });
    let result = core.clone().answer_spawn(link.clone(), request("w1")).await;
    assert_eq!(core.clone().answer_spawn(link, request("w1")).await, result);
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
    assert_eq!(core.spawned_inventory(&node()).len(), 1);
    assert!(
        !responder.is_finished(),
        "no deregistration before the result is sent"
    );
    CoreHost(Arc::downgrade(&core)).sent(&result);
    assert!(core.spawned_inventory(&node()).is_empty());
    assert_eq!(result["error"], wire::HARNESS_UNAVAILABLE);
    assert_eq!(
        result["error_details"]["message"],
        "Codex refused the first turn"
    );
    assert_eq!(result["error_details"]["harness"], "codex");
    responder.await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !intents::load(&core.config.app_data_dir).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(core.spawn_slots().held, 0);
    assert_eq!(core.spawn_slots().reserved, 0);
    let restarted = super::core(home.path(), spawner.clone());
    let (mut link, _) = NodeLink::detached(node());
    link.error_details = true;
    assert_eq!(restarted.answer_spawn(link, request("w1")).await, result);
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_legacy_store_write_cannot_erase_a_known_spawn_origin() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    spawn(&core, "w1").await;
    let base = core.store.read(Clone::clone);
    let mut legacy = base.clone();
    legacy.registrations[0].spawn = None;
    legacy.registrations[0].missing_since = Some("2026-10-18T01:03:19Z".into());
    for (ours, theirs) in [(&base, &legacy), (&legacy, &base)] {
        let merged = Store::merged(&base, ours, theirs);
        assert_eq!(merged.registrations[0].spawn, base.registrations[0].spawn);
        assert!(merged.registrations[0].missing_since.is_none());
        core.store.update(|store| *store = merged).unwrap();
        assert_eq!(core.spawned_inventory(&node())[0].name, "w1");
    }
    // Do not revive a spawn that the spawn-aware writer also marked missing.
    let mut missing = base.clone();
    missing.registrations[0].missing_since = legacy.registrations[0].missing_since.clone();
    let merged = Store::merged(&base, &missing, &legacy);
    assert_eq!(
        merged.registrations[0].missing_since,
        missing.registrations[0].missing_since
    );
    core.store.update(|store| *store = merged).unwrap();
    assert!(core.spawned_inventory(&node()).is_empty());
    legacy.registrations[0].agent_id = "replacement".into();
    assert!(Store::merged(&base, &base, &legacy).registrations[0]
        .spawn
        .is_none());
}

#[tokio::test]
async fn restoring_lost_origin_requires_both_the_local_receipt_and_remote_identity() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    spawn(&core, "w1").await;
    let mut row = named(&core, "w1");
    let expected = row.spawn.take().unwrap();
    let scope = super::completions::Scope::workspace(&core.workspace().unwrap());
    let mut remote = json!({"id":"agent_w1","name":"w1",
        "metadata":{"fleet":{"node_id":node().node_id,"invocation_id":"inv_w1"}}});
    let restored = super::restore_origin::restorable(
        &row,
        &remote,
        &node(),
        &scope,
        &core.config.app_data_dir,
    );
    assert_eq!(restored, Some(expected));
    remote["metadata"]["fleet"]["invocation_id"] = json!("not-receipted");
    assert!(super::restore_origin::restorable(
        &row,
        &remote,
        &node(),
        &scope,
        &core.config.app_data_dir
    )
    .is_none());
}

#[tokio::test]
async fn recovery_retains_and_sends_a_failure_before_forgetting_an_ended_intent() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path(), Arc::new(FakeSpawner::default()));
    let mut intent = interrupted("w1", true, None);
    intent.ended = true;
    intents::put(&core.config.app_data_dir, &intent).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    core.recover_spawns(&link).await;
    let frame = sent.recv().await.unwrap();
    assert_eq!(frame["type"], "action.result");
    assert!(frame["error"]
        .as_str()
        .unwrap()
        .contains("original harness reason is unavailable"));
    let scope = super::completions::Scope::workspace(&core.workspace().unwrap());
    assert!(scope
        .load(&core.config.app_data_dir, &intent.invocation_id)
        .unwrap()
        .unwrap()
        .failed());
    assert!(
        intents::load(&core.config.app_data_dir)
            .iter()
            .any(|kept| kept.invocation_id == intent.invocation_id),
        "the intent remains until deregistration is acknowledged"
    );
}

#[tokio::test]
async fn recovery_does_not_promote_a_failed_launch_that_cannot_be_stopped() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        fails_started: true,
        unreleasable: true,
        ..FakeSpawner::default()
    });
    let first = core(home.path(), spawner.clone());
    let (link, sent) = NodeLink::detached(node());
    let frames = relaycast(link.clone(), sent);
    let failure = first.answer_spawn(link, request("w1")).await;
    assert!(failure["error"].is_string());
    frames.await.unwrap();
    let restarted = core(home.path(), spawner.clone());
    let (link, mut sent) = NodeLink::detached(node());
    restarted.recover_spawns(&link).await;
    assert!(restarted.store.read(|store| store.registrations.is_empty()));
    assert!(!intents::load(&restarted.config.app_data_dir)[0].ended);
    assert!(sent.try_recv().is_err(), "cleanup was not confirmed");
    assert_eq!(restarted.answer_spawn(link, request("w1")).await, failure);
    assert_eq!(spawner.launched.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn rotated_workspace_receipts_keep_the_original_failure_during_recovery() {
    use crate::relay::workspace::Secret;
    for ended in [true, false] {
        let home = tempfile::tempdir().unwrap();
        let spawner = Arc::new(FakeSpawner {
            unreleasable: true,
            ..FakeSpawner::default()
        });
        let core = core(home.path(), spawner);
        let mut current = core.workspace().unwrap();
        current.workspace_id = Some("rw_1".into());
        let mut original = current.clone();
        original.key = Secret::new("rk_live_previous");
        let mut intent = interrupted("w1", true, Some(Target::new(SessionKind::Codex, THREAD)));
        intent.workspace_id = current.workspace_id.clone();
        intent.workspace_key = original.key.clone();
        intent.ended = ended;
        let error = SpawnError::from("spawn_harness_unavailable: credentials rejected");
        super::completions::Scope::workspace(&original)
            .save_failure(&core.config.app_data_dir, &request("w1"), error)
            .unwrap();
        let mut elsewhere = current.clone();
        elsewhere.workspace_id = Some("rw_2".into());
        assert!(recover::adopt_receipted_intent(
            &core.config.app_data_dir,
            intent.clone(),
            &elsewhere
        )
        .is_none());
        let adopted =
            recover::adopt_receipted_intent(&core.config.app_data_dir, intent, &current).unwrap();
        intents::put(&core.config.app_data_dir, &adopted).unwrap();
        let (link, mut sent) = NodeLink::detached(node());
        core.recover_spawns(&link).await;
        if ended {
            let frame = sent.recv().await.unwrap();
            assert!(frame["error"]
                .as_str()
                .unwrap()
                .contains("credentials rejected"));
        } else {
            assert!(sent.try_recv().is_err());
            assert!(!intents::load(&core.config.app_data_dir)[0].ended);
        }
        assert!(core.store.read(|store| store.registrations.is_empty()));
        let replay = core.answer_spawn(link, request("w1")).await;
        assert!(replay["error"]
            .as_str()
            .unwrap()
            .contains("credentials rejected"));
    }
}

#[tokio::test]
async fn recovery_keeps_a_rotated_intent_when_the_key_carries_no_workspace_id() {
    use crate::relay::state::Verification;
    use crate::relay::workspace::Secret;
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner {
        unreleasable: true,
        ..FakeSpawner::default()
    });
    let core = core(home.path(), spawner);
    // A key from the environment or the app store: no id on the workspace,
    // only on its verified status.
    let current = core.workspace().unwrap();
    assert!(current.workspace_id.is_none());
    core.hub().update(|status| {
        status.workspace.verification = Verification::Verified;
        status.workspace.workspace_id = Some("rw_1".into());
        status.workspace.base_url = Some(current.base_url.clone());
    });
    let mut original = current.clone();
    original.key = Secret::new("rk_live_previous");
    let mut intent = interrupted("w1", true, Some(Target::new(SessionKind::Codex, THREAD)));
    intent.workspace_id = Some("rw_1".into());
    intent.workspace_key = original.key.clone();
    intent.ended = true;
    super::completions::Scope::workspace(&original)
        .save_failure(
            &core.config.app_data_dir,
            &request("w1"),
            SpawnError::from("spawn_harness_unavailable: credentials rejected"),
        )
        .unwrap();
    // Saved under the displaced key, as a real rotation leaves it.
    intents::put(&core.config.app_data_dir, &intent).unwrap();
    let (link, mut sent) = NodeLink::detached(node());
    core.recover_spawns(&link).await;
    let frame = sent.recv().await.unwrap();
    assert!(frame["error"]
        .as_str()
        .unwrap()
        .contains("credentials rejected"));
    let replay = core.answer_spawn(link, request("w1")).await;
    assert!(replay["error"]
        .as_str()
        .unwrap()
        .contains("credentials rejected"));
}

#[tokio::test]
async fn recovery_never_keeps_a_failed_launch_whose_receipt_was_not_saved() {
    let home = tempfile::tempdir().unwrap();
    let spawner = Arc::new(FakeSpawner::default());
    let core = core(home.path(), spawner.clone());
    let target = Target::new(SessionKind::Codex, THREAD);
    // Still running, registered, and no failure receipt: only the intent's
    // own mark says its launch failed.
    let mut intent = interrupted("w1", true, Some(target.clone()));
    intent.launch_failed = true;
    intents::put(&core.config.app_data_dir, &intent).unwrap();
    let (link, _sent) = NodeLink::detached(node());
    core.recover_spawns(&link).await;
    assert!(
        core.store.read(|store| store.registrations.is_empty()),
        "a failed launch is not promoted to a successful agent"
    );
    assert!(spawner.stopped.lock().unwrap().contains(&target));
}
