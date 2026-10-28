use super::*;

#[test]
fn native_spawn_resume_keeps_busy_queue_and_duplicate_guards() {
    let fake = Fake::new();
    let router = router(&fake);
    fake.busy.store(true, Ordering::SeqCst);
    assert_eq!(
        router.inject_spawned(THREAD, "spawn-guard", "followup"),
        InjectOutcome::Waiting(BUSY.into())
    );
    assert_eq!(count(&fake.spawn_sends), 0);
    fake.busy.store(false, Ordering::SeqCst);
    *fake.queued.lock().unwrap() = None;
    assert_eq!(
        router.inject_spawned(THREAD, "spawn-guard", "followup"),
        InjectOutcome::Waiting(QUEUE_UNREADABLE.into())
    );
    assert_eq!(count(&fake.spawn_sends), 0);
    *fake.queued.lock().unwrap() = Some(true);
    assert!(matches!(
        router.inject_spawned(THREAD, "spawn-guard", "followup"),
        InjectOutcome::Accepted(_)
    ));
    assert_eq!(count(&fake.spawn_sends), 0);
    fake.recorded.store(true, Ordering::SeqCst);
    assert_eq!(
        router.inject_spawned(THREAD, "spawn-guard", "followup"),
        InjectOutcome::Delivered
    );
    assert_eq!(count(&fake.spawn_sends), 0);
    fake.recorded.store(false, Ordering::SeqCst);
    *fake.queued.lock().unwrap() = Some(false);
    assert_eq!(
        router.inject_spawned(THREAD, "spawn-new", "followup"),
        InjectOutcome::Delivered
    );
    assert_eq!(count(&fake.spawn_sends), 1);
}
