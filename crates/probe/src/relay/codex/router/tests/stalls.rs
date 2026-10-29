use super::*;
use crate::relay::codex::stall::{Progress, Timing};
use app_server::recovery::Recovery;

fn stalled() -> (Arc<Fake>, CodexRouter, Arc<Mutex<Duration>>) {
    let fake = Fake::new();
    fake.busy.store(true, Ordering::SeqCst);
    *fake.progress.lock().unwrap() = Some(Progress {
        turn: "stuck".into(),
        at_ms: 1,
    });
    let (mut router, clock) = clocked(&fake);
    router.stall_timing = Timing {
        stall: Duration::from_secs(10),
        interrupt: Duration::from_secs(30),
    };
    (fake, router, clock)
}

#[test]
fn waiting_messages_mark_stalled_and_new_events_clear_the_mark() {
    let (fake, router, clock) = stalled();
    router.inject_spawned(THREAD, "a", "first");
    router.inject_spawned(THREAD, "b", "second");
    *clock.lock().unwrap() = Duration::from_secs(9);
    assert!(router.inbox_stall(THREAD).is_none());
    *clock.lock().unwrap() = Duration::from_secs(10);
    let report = router.inbox_stall(THREAD).expect("stalled");
    assert_eq!(report.undrained_count, 2);
    assert_eq!(report.oldest_undrained_age_ms, 10_000);
    fake.progress.lock().unwrap().as_mut().unwrap().at_ms += 1;
    assert!(router.inbox_stall(THREAD).is_none());
    *clock.lock().unwrap() = Duration::from_secs(20);
    assert!(router.inbox_stall(THREAD).is_some());
    router.cancel(THREAD, "a");
    assert_eq!(router.inbox_stall(THREAD).unwrap().undrained_count, 1);
    router.cancel(THREAD, "b");
    assert!(router.inbox_stall(THREAD).is_none());
}

#[test]
fn only_spawned_agents_can_interrupt_after_the_longer_threshold() {
    for spawned in [false, true] {
        let (fake, router, clock) = stalled();
        let deliver = || {
            if spawned {
                router.inject_spawned(THREAD, "a", "first")
            } else {
                router.inject(THREAD, "a", "first")
            }
        };
        deliver();
        *clock.lock().unwrap() = Duration::from_secs(9);
        deliver();
        assert!(fake.recoveries.lock().unwrap().is_empty());
        *clock.lock().unwrap() = Duration::from_secs(10);
        deliver();
        assert_eq!(*fake.recoveries.lock().unwrap(), [false]);
        *clock.lock().unwrap() = Duration::from_secs(29);
        deliver();
        assert_eq!(fake.recoveries.lock().unwrap().last(), Some(&false));
        *clock.lock().unwrap() = Duration::from_secs(30);
        deliver();
        assert_eq!(fake.recoveries.lock().unwrap().last(), Some(&spawned));
    }
}

#[test]
fn native_driver_recovery_never_overtakes_a_terminal_queue_or_unknown_progress() {
    for guard in ["terminal", "queued", "unreadable"] {
        let (fake, router, clock) = stalled();
        if guard == "terminal" {
            fake.terminal_live.store(true, Ordering::SeqCst);
        } else if guard == "queued" {
            *fake.queued.lock().unwrap() = Some(true);
        } else {
            *fake.progress.lock().unwrap() = None;
        }
        router.wait_for_turn(THREAD, "a", "first", true);
        *clock.lock().unwrap() = Duration::from_secs(30);
        assert_eq!(router.wait_for_turn(THREAD, "a", "first", true), InjectOutcome::Waiting(BUSY.into()));
        assert!(fake.recoveries.lock().unwrap().is_empty(), "{guard}");
    }
}

#[test]
fn interruption_waits_for_idle_then_delivers_each_message_once() {
    let (fake, router, clock) = stalled();
    router.inject_spawned(THREAD, "a", "first");
    router.inject_spawned(THREAD, "b", "second");
    *clock.lock().unwrap() = Duration::from_secs(30);
    *fake.recovery.lock().unwrap() = Some(Ok(Recovery::Interrupted));
    assert_eq!(
        router.inject_spawned(THREAD, "a", "first"),
        InjectOutcome::Waiting(BUSY.into())
    );
    router.inject_spawned(THREAD, "b", "second");
    assert_eq!(fake.recoveries.lock().unwrap().len(), 1);
    assert_eq!(count(&fake.spawn_sends), 0);
    fake.busy.store(false, Ordering::SeqCst);
    *fake.progress.lock().unwrap() = None;
    assert!(router.inbox_stall(THREAD).is_none());
    for (id, text) in [("a", "first"), ("b", "second")] {
        assert_eq!(
            router.inject_spawned(THREAD, id, text),
            InjectOutcome::Delivered
        );
        fake.recorded.store(true, Ordering::SeqCst);
        assert_eq!(
            router.inject_spawned(THREAD, id, text),
            InjectOutcome::Delivered
        );
        fake.recorded.store(false, Ordering::SeqCst);
    }
    assert_eq!(count(&fake.spawn_sends), 2);
}

#[test]
fn steering_uses_the_active_turn_and_ambiguous_sends_have_no_fallback() {
    for result in [
        Ok(Recovery::Steered),
        Err(TurnError::InDoubt("lost reply".into())),
    ] {
        let (fake, router, clock) = stalled();
        router.inject_spawned(THREAD, "a", "first");
        *clock.lock().unwrap() = Duration::from_secs(10);
        *fake.recovery.lock().unwrap() = Some(result.clone());
        let outcome = router.inject_spawned(THREAD, "a", "first");
        match result {
            Ok(_) => assert_eq!(outcome, InjectOutcome::Delivered),
            Err(_) => assert!(matches!(outcome, InjectOutcome::InDoubt(_))),
        }
        assert_eq!(count(&fake.spawn_sends), 0);
        assert_eq!(count(&fake.window_sends), 0);
        assert_eq!(fake.recoveries.lock().unwrap().len(), 1);
    }
}

#[test]
fn hidden_relay_messages_are_never_steered_into_the_chat() {
    let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    for hidden in [true, false] {
        compact::set_enabled(hidden);
        let (fake, router, clock) = stalled();
        router.inject_spawned(THREAD, "a", "first");
        *clock.lock().unwrap() = Duration::from_secs(10);
        assert_eq!(
            router.inject_spawned(THREAD, "a", "first"),
            InjectOutcome::Waiting(BUSY.into())
        );
        *clock.lock().unwrap() = Duration::from_secs(30);
        router.inject_spawned(THREAD, "a", "first");
        let steer = (!hidden).then(|| "first".to_string());
        assert_eq!(*fake.steers.lock().unwrap(), [steer.clone(), steer]);
        assert_eq!(*fake.recoveries.lock().unwrap(), [false, true]);
    }
    compact::set_enabled(true);
}

#[test]
fn an_ambiguous_steer_blocks_recovery_of_its_turn_until_progress() {
    let (fake, router, clock) = stalled();
    router.inject_spawned(THREAD, "a", "first");
    *clock.lock().unwrap() = Duration::from_secs(10);
    *fake.recovery.lock().unwrap() = Some(Err(TurnError::InDoubt("lost reply".into())));
    assert!(matches!(
        router.inject_spawned(THREAD, "a", "first"),
        InjectOutcome::InDoubt(_)
    ));
    // Another message past the interrupt threshold must not abort a turn
    // that may already hold the first one.
    *fake.recovery.lock().unwrap() = Some(Ok(Recovery::Interrupted));
    router.inject_spawned(THREAD, "b", "second");
    *clock.lock().unwrap() = Duration::from_secs(40);
    assert_eq!(
        router.inject_spawned(THREAD, "b", "second"),
        InjectOutcome::Waiting(BUSY.into())
    );
    assert_eq!(fake.recoveries.lock().unwrap().len(), 1);
    fake.progress.lock().unwrap().as_mut().unwrap().at_ms += 1;
    router.inject_spawned(THREAD, "b", "second");
    *clock.lock().unwrap() = Duration::from_secs(80);
    router.inject_spawned(THREAD, "b", "second");
    assert_eq!(*fake.recoveries.lock().unwrap(), [false, true]);
}

// A steer hands the message to the turn, so like every other route it is
// claimed from Agent Relay's turn hook first, and never steered once the
// hook has handed it over.
#[test]
fn a_steer_claims_the_message_from_the_turn_hook_first() {
    use crate::relay::codex::turn_hook::{self, HookEvent, TurnInbox};
    let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    compact::set_enabled(false);
    for taken in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (fake, router, clock) = stalled();
        let turns = TurnInbox::open(dir.path().join(turn_hook::RECORD));
        let inbox = Arc::new(StopHookInbox::with_turns(turns));
        inbox.set_ready(true);
        let mut router = router.with_stop_hook(inbox.clone());
        router.stall_timing = Timing {
            stall: Duration::from_secs(10),
            interrupt: Duration::from_secs(30),
        };
        router.inject_spawned(THREAD, "a", "first");
        if taken {
            inbox.turns().offer(THREAD, "a", "first").unwrap();
            inbox.turns().answer(THREAD, HookEvent::PostToolUse);
        }
        *clock.lock().unwrap() = Duration::from_secs(10);
        *fake.recovery.lock().unwrap() = Some(Ok(Recovery::Steered));
        let outcome = router.wait_for_turn(THREAD, "a", "first", true);
        if taken {
            assert!(fake.steers.lock().unwrap().is_empty());
            assert_eq!(outcome, InjectOutcome::Accepted(RECORDING.into()));
        } else {
            assert_eq!(*fake.steers.lock().unwrap(), [Some("first".to_string())]);
            assert_eq!(outcome, InjectOutcome::Delivered);
        }
    }
    compact::set_enabled(true);
}
