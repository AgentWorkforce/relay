use super::tests::intent;
use super::*;
use crate::relay::spawn::launch::SpawnedProcess;
use crate::relay::store::SessionKind;

#[test]
fn ending_a_failed_launch_preserves_evidence_from_its_started_callback() {
    let dir = tempfile::tempdir().unwrap();
    let mut in_flight = InFlight {
        app_data_dir: dir.path().into(),
        intent: intent("w1"),
    };
    in_flight.begin().unwrap();
    in_flight
        .update(|intent| intent.agent_id = Some("agent-w1".into()))
        .unwrap();
    let snapshot = in_flight.intent.clone();
    let target = Target::new(SessionKind::ClaudeTerminal, &snapshot.session_id);
    let process = SpawnedProcess {
        pid: 123456,
        start: 76,
    };
    update_attempt(dir.path(), &snapshot, |current| {
        current.target = Some(target.clone());
        current.process = Some(process);
    })
    .unwrap();
    // The async guard still has the older snapshot, like a worker returning
    // an error after it reported a successfully started process.
    assert!(in_flight.intent.target.is_none());
    in_flight.update(|intent| intent.ended = true).unwrap();
    let kept = load(dir.path()).pop().unwrap();
    assert!(kept.ended);
    assert_eq!(kept.target, Some(target));
    assert_eq!(kept.process, Some(process));
    assert_eq!(in_flight.intent, kept);
}

#[test]
fn an_old_cleanup_acknowledgement_cannot_remove_a_new_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let mut old = intent("w1");
    old.ended = true;
    put(dir.path(), &old).unwrap();
    let mut retry = old.clone();
    retry.session_id = "22222222-2222-3333-4444-555555555555".into();
    retry.ended = false;
    put(dir.path(), &retry).unwrap();
    // The old deregistration completes after a retry claimed the invocation.
    remove(dir.path(), &old).unwrap();
    assert_eq!(load(dir.path()), [retry]);
}

#[test]
fn a_retrys_intent_is_never_changed_for_an_earlier_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let earlier = intent("w1");
    let mut retry = intent("w1");
    retry.session_id = "retry-session".into();
    put(dir.path(), &retry).unwrap();
    assert!(!change_attempt(dir.path(), &earlier, |_| true, None));
    assert_eq!(load(dir.path()), [retry.clone()]);
    let mut ended = retry.clone();
    ended.ended = true;
    assert!(!change_attempt(
        dir.path(),
        &retry,
        |kept| kept.ended,
        Some(&ended)
    ));
    assert!(change_attempt(
        dir.path(),
        &retry,
        |kept| !kept.ended,
        Some(&ended)
    ));
    assert_eq!(load(dir.path()), [ended.clone()]);
    assert!(change_attempt(dir.path(), &ended, |_| true, None));
    assert!(load(dir.path()).is_empty());
}

#[test]
fn a_register_sent_is_kept_until_it_is_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let mut in_flight = InFlight {
        app_data_dir: dir.path().into(),
        intent: intent("w1"),
    };
    in_flight.begin().unwrap();
    in_flight
        .update(|intent| intent.register_sent = true)
        .unwrap();
    // A change that does not touch it leaves it.
    in_flight
        .update(|intent| intent.title = "Fix CI again".into())
        .unwrap();
    assert!(load(dir.path())[0].register_sent);
    in_flight
        .update(|intent| intent.register_sent = false)
        .unwrap();
    assert!(!load(dir.path())[0].register_sent);
    // Not registered and nothing started: cancellation leaves nothing.
    drop(in_flight);
    assert!(load(dir.path()).is_empty());
}

#[test]
fn late_worker_and_guard_updates_cannot_replace_a_retry() {
    let dir = tempfile::tempdir().unwrap();
    let mut old = InFlight {
        app_data_dir: dir.path().into(),
        intent: intent("w1"),
    };
    old.begin().unwrap();
    let mut retry = old.intent.clone();
    retry.session_id = "22222222-2222-3333-4444-555555555555".into();
    retry.agent_id = Some("agent-retry".into());
    put(dir.path(), &retry).unwrap();
    assert!(
        update_attempt(dir.path(), &old.intent, |current| current.ended = true)
            .unwrap()
            .is_none()
    );
    assert!(old.update(|current| current.ended = true).is_err());
    old.settled();
    drop(old);
    assert_eq!(load(dir.path()), [retry]);
}

#[test]
fn a_callback_after_settlement_does_not_resurrect_an_intent() {
    let dir = tempfile::tempdir().unwrap();
    let old = intent("w1");
    put(dir.path(), &old).unwrap();
    remove(dir.path(), &old).unwrap();
    assert!(update_attempt(dir.path(), &old, |current| current.target =
        Some(Target::new(SessionKind::ClaudeTerminal, &old.session_id)))
    .unwrap()
    .is_none());
    assert!(load(dir.path()).is_empty());
    assert!(!file(dir.path()).exists());
}

#[test]
fn an_intent_that_cannot_be_saved_is_an_error_not_a_silent_success() {
    let dir = tempfile::tempdir().unwrap();
    // A file where the app data folder should be: nothing can be written.
    let blocked = dir.path().join("not-a-folder");
    std::fs::write(&blocked, b"").unwrap();
    let mut in_flight = InFlight {
        app_data_dir: blocked,
        intent: intent("w1"),
    };
    assert!(in_flight.begin().is_err());
    assert!(in_flight
        .update(|intent| intent.agent_id = Some("agent-w1".into()))
        .is_err());
    // The evidence is still kept in memory, so Drop does not erase it.
    assert_eq!(in_flight.intent.agent_id.as_deref(), Some("agent-w1"));
}
