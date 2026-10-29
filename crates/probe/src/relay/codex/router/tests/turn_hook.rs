use super::*;
use crate::relay::codex::turn_hook::{self, Claimed, HookEvent, TurnInbox};
use std::sync::atomic::AtomicI64;

const TEXT: &str = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nCan you check CI?";

/// A terminal Codex running a turn, Agent Relay's hook ready, and the
/// record's clock.
fn working(dir: &Path) -> (Arc<Fake>, CodexRouter, Arc<StopHookInbox>, Arc<AtomicI64>) {
    let fake = Fake::new();
    fake.terminal_live.store(true, Ordering::SeqCst);
    fake.live.store(true, Ordering::SeqCst);
    fake.busy.store(true, Ordering::SeqCst);
    let (router, inbox, clock) = restarted(&fake, dir);
    (fake, router, inbox, clock)
}

/// A router and inbox over the record in `dir`, as after a restart.
fn restarted(fake: &Arc<Fake>, dir: &Path) -> (CodexRouter, Arc<StopHookInbox>, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let now = clock.clone();
    let turns =
        TurnInbox::open(dir.join(turn_hook::RECORD)).with_clock(move || now.load(Ordering::SeqCst));
    let inbox = Arc::new(StopHookInbox::with_turns(turns));
    inbox.set_ready(true);
    let router = CodexRouter::new(fake.clone()).with_stop_hook(inbox.clone());
    (router, inbox, clock)
}

fn context(answer: &serde_json::Value) -> &str {
    answer["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap_or_default()
}

// A message for a terminal Codex in a long turn reaches it at the turn's
// next tool call, not after the turn, and only the rollout settles it.
#[test]
fn a_working_session_gets_the_message_at_its_next_tool_call() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, router, inbox, _) = working(dir.path());
    assert_eq!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::WaitingForTurn(turn_hook::WAITING.into())
    );
    assert_eq!(count(&fake.queue_sends), 0, "not behind the turn");
    assert_eq!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::WaitingForTurn(turn_hook::WAITING.into()),
        "still offered while the turn runs"
    );
    let answer = inbox.turns().answer(THREAD, HookEvent::PostToolUse);
    assert!(context(&answer).ends_with("Can you check CI?"));
    assert!(context(&answer).starts_with("[via Agent Relay — from @alice · ref 0123456789ab]"));
    assert_eq!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::Accepted(RECORDING.into())
    );
    fake.recorded.store(true, Ordering::SeqCst);
    assert_eq!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::Delivered
    );
    assert_eq!(inbox.turns().claimed("m1"), Claimed::Free);
    assert_eq!(count(&fake.queue_sends), 0);
}

// Codex runs no Stop hook for an interrupted or failed turn: a message no
// hook took goes to the queue on the next pass, and the hook never gets it.
#[test]
fn a_turn_that_ends_without_a_hook_sends_the_message_by_the_queue() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, router, inbox, _) = working(dir.path());
    router.inject_with(THREAD, "m1", TEXT, &|| None);
    fake.busy.store(false, Ordering::SeqCst);
    assert!(matches!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::Accepted(_)
    ));
    assert_eq!(count(&fake.queue_sends), 1);
    assert_eq!(inbox.turns().claimed("m1"), Claimed::Elsewhere);
    fake.busy.store(true, Ordering::SeqCst);
    assert_eq!(
        inbox.turns().answer(THREAD, HookEvent::Stop),
        serde_json::json!({})
    );
}

// Never resend what may have arrived: a message the hook handed over that
// Codex did not record is in doubt, across a restart too.
#[test]
fn a_message_the_hook_took_is_never_sent_again() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, router, inbox, clock) = working(dir.path());
    router.inject_with(THREAD, "m1", TEXT, &|| None);
    let stop = inbox.turns().answer(THREAD, HookEvent::Stop);
    assert_eq!(stop["decision"], "block");
    drop(router);
    // Restarted, with the turn over and nothing recorded yet.
    fake.busy.store(false, Ordering::SeqCst);
    let (router, _, restarted_clock) = restarted(&fake, dir.path());
    restarted_clock.store(clock.load(Ordering::SeqCst) + 10_000, Ordering::SeqCst);
    assert_eq!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::Accepted(RECORDING.into())
    );
    restarted_clock.store(clock.load(Ordering::SeqCst) + 46_000, Ordering::SeqCst);
    assert!(matches!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::InDoubt(_)
    ));
    // Restarted again before the doubt was recorded: still in doubt.
    let (router, _, again) = restarted(&fake, dir.path());
    again.store(clock.load(Ordering::SeqCst) + 50_000, Ordering::SeqCst);
    assert!(matches!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::InDoubt(_)
    ));
    assert_eq!(count(&fake.queue_sends), 0);
    assert_eq!(count(&fake.app_sends), 0);
    assert_eq!(count(&fake.window_sends), 0);
}

// The hook never gets a message another route may have: a queued handoff,
// one behind the relay's queue items, or one for Relay Connect.
#[test]
fn only_a_message_no_other_route_has_is_offered() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, router, inbox, _) = working(dir.path());
    // Queued while idle; after a restart Codex has taken the row and the
    // rollout shows its turn running, but not the message yet.
    fake.busy.store(false, Ordering::SeqCst);
    router.inject_with(THREAD, "queued", TEXT, &|| None);
    assert_eq!(count(&fake.queue_sends), 1);
    fake.busy.store(true, Ordering::SeqCst);
    let (router, inbox_after, _) = restarted(&fake, dir.path());
    router.inject_with(THREAD, "queued", TEXT, &|| None);
    assert_eq!(inbox_after.turns().claimed("queued"), Claimed::Elsewhere);
    assert!(!inbox_after.turns().has_offered(THREAD));
    // Behind a relay message waiting in Codex's queue.
    *fake.queued.lock().unwrap() = Some(true);
    router.inject_with(THREAD, "behind", TEXT, &|| None);
    assert_eq!(inbox_after.turns().claimed("behind"), Claimed::Free);
    *fake.queued.lock().unwrap() = Some(false);
    // Relay Connect keeps the queue.
    router.inject(THREAD, "connect", TEXT);
    assert_ne!(inbox_after.turns().claimed("connect"), Claimed::Offered);
    assert!(!inbox.turns().has_offered(THREAD));
}

// A turn a killed Codex left open, a Conductor chat (its own Stop-hook
// route), or a hook that is not installed and trusted: no offer.
#[test]
fn no_offer_without_a_live_turn_whose_hook_runs() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, router, inbox, _) = working(dir.path());
    fake.live.store(false, Ordering::SeqCst);
    fake.terminal_live.store(false, Ordering::SeqCst);
    assert_eq!(
        router.inject_with(THREAD, "stale", TEXT, &|| None),
        InjectOutcome::Waiting(BUSY.into())
    );
    assert_ne!(inbox.turns().claimed("stale"), Claimed::Offered);
    fake.live.store(true, Ordering::SeqCst);
    fake.terminal_live.store(true, Ordering::SeqCst);
    inbox.set_ready(false);
    router.inject_with(THREAD, "untrusted", TEXT, &|| None);
    assert_eq!(count(&fake.queue_sends), 1, "behind the turn, as before");
    assert_eq!(inbox.turns().claimed("untrusted"), Claimed::Elsewhere);
    inbox.set_ready(true);
    fake.conductor.store(true, Ordering::SeqCst);
    assert_eq!(
        router.inject_with(THREAD, "conductor", TEXT, &|| None),
        InjectOutcome::Accepted(stop_hook::HELD.into())
    );
    assert_eq!(inbox.turns().claimed("conductor"), Claimed::Free);
}

// A route that cannot be recorded is not taken: nothing is handed over.
#[test]
fn an_unreadable_record_hands_nothing_over() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(turn_hook::RECORD), b"{not json").unwrap();
    let (fake, router, _, _) = working(dir.path());
    assert_eq!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::Waiting(super::super::turn_hook::CLAIM_UNRECORDED.into())
    );
    assert_eq!(count(&fake.queue_sends), 0);
}

// Review on #663: a busy app session whose hook is not ready yet waits
// unclaimed, so the hook can still take the message once it is.
#[test]
fn a_busy_session_waits_unclaimed_for_its_hook() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, router, inbox, _) = working(dir.path());
    fake.terminal_live.store(false, Ordering::SeqCst);
    inbox.set_ready(false);
    assert_eq!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::Waiting(BUSY.into())
    );
    assert_eq!(inbox.turns().claimed("m1"), Claimed::Free);
    inbox.set_ready(true);
    assert_eq!(
        router.inject_with(THREAD, "m1", TEXT, &|| None),
        InjectOutcome::WaitingForTurn(turn_hook::WAITING.into())
    );
}

// Review on #663: an offer that must now wait behind a relay message in
// Codex's queue is withdrawn and joins the queue behind it.
#[test]
fn an_offer_behind_a_queued_relay_message_is_withdrawn() {
    let dir = tempfile::tempdir().unwrap();
    let (fake, router, inbox, _) = working(dir.path());
    router.inject_with(THREAD, "m2", TEXT, &|| None);
    assert_eq!(inbox.turns().claimed("m2"), Claimed::Offered);
    // An earlier message went to the queue as the last turn ended.
    *fake.relay_ahead.lock().unwrap() = Some(Some(true));
    assert!(matches!(
        router.inject_with(THREAD, "m2", TEXT, &|| None),
        InjectOutcome::WaitingForTurn(_) | InjectOutcome::Accepted(_)
    ));
    assert_eq!(count(&fake.queue_sends), 1, "behind it in the queue");
    assert_eq!(inbox.turns().claimed("m2"), Claimed::Elsewhere);
    assert_eq!(
        inbox.turns().answer(THREAD, HookEvent::PostToolUse),
        serde_json::json!({})
    );
}

// Review on #663: while the record cannot be read, a native turn waits
// without touching its receipt.
#[test]
fn a_native_turn_waits_while_the_record_cannot_be_read() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(turn_hook::RECORD), b"{not json").unwrap();
    let (fake, router, _, _) = working(dir.path());
    assert_eq!(
        router.inject_native_existing(THREAD, "m1", TEXT),
        InjectOutcome::Waiting(super::super::turn_hook::CLAIM_UNRECORDED.into())
    );
    assert_eq!(count(&fake.window_sends), 0);
}

// A cancelled message is offered no more.
#[test]
fn a_cancelled_offer_is_withdrawn() {
    let dir = tempfile::tempdir().unwrap();
    let (_, router, inbox, _) = working(dir.path());
    router.inject_with(THREAD, "m1", TEXT, &|| None);
    router.cancel(THREAD, "m1");
    assert_eq!(inbox.turns().claimed("m1"), Claimed::Free);
    assert_eq!(
        inbox.turns().answer(THREAD, HookEvent::PostToolUse),
        serde_json::json!({})
    );
}
