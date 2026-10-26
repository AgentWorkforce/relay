use super::*;

fn binding() -> Binding {
    Binding {
        scope: "account/workspace/agent/session".into(),
        owner: "human-id".into(),
    }
}
fn runtime(alternate: bool) -> Runtime {
    Runtime {
        pid: if alternate { 20 } else { 10 },
        start: 100,
        idle: true,
    }
}
fn lease(action: &Action) -> &str {
    let Action::Submit { lease_id, .. } = action;
    lease_id
}

#[test]
fn native_input_uses_current_process_once_without_handoff_or_permission_changes() {
    let mut queue = Journal::default();
    assert_eq!(
        queue.enqueue(binding(), "delivery", "hello", 0).unwrap(),
        Outcome::Waiting
    );
    let desktop = runtime(false);
    let submit = queue.poll(&binding(), &desktop, 1).unwrap();
    assert!(matches!(&submit, Action::Submit { text, .. } if text == "hello"));
    assert_eq!(queue.status(&binding().scope), Some("connecting"));
    assert!(queue.active_runtime(&binding(), &desktop));
    assert!(!queue.active_runtime(&binding(), &runtime(true)));
    let mut changed_owner = binding();
    changed_owner.owner = "new-owner".into();
    assert!(!queue.active_runtime(&changed_owner, &desktop));
    assert!(queue.poll(&binding(), &desktop, 2).is_none());
    assert!(queue.ack(&binding(), &desktop, lease(&submit), true, 3));
    assert_eq!(queue.status(&binding().scope), Some("ready"));
    assert_eq!(
        queue.enqueue(binding(), "delivery", "hello", 4).unwrap(),
        Outcome::Started
    );
}

#[test]
fn busy_session_and_unknown_runtime_never_receive_control() {
    let mut queue = Journal::default();
    queue.enqueue(binding(), "delivery", "hello", 0).unwrap();
    let mut busy = runtime(false);
    busy.idle = false;
    assert!(queue.poll(&binding(), &busy, 1).is_none());
    assert!(matches!(
        queue.poll(&binding(), &runtime(false), 2),
        Some(Action::Submit { .. })
    ));
}

#[test]
fn sender_workspace_registration_and_session_cannot_claim_someone_elses_text() {
    let mut queue = Journal::default();
    queue.enqueue(binding(), "delivery", "hello", 0).unwrap();
    let mut peer = binding();
    peer.owner = "peer-claims-human".into();
    assert!(queue.poll(&peer, &runtime(true), 1).is_none());
    let mut other = binding();
    other.scope = "other-workspace/session".into();
    assert!(queue.poll(&other, &runtime(true), 1).is_none());
    assert!(queue.enqueue(peer, "delivery", "hello", 2).is_err());
    assert!(queue
        .enqueue(binding(), "delivery", "replacement", 2)
        .is_err());
}

#[test]
fn process_replacement_cannot_ack_old_submission_and_timeout_never_replays() {
    let mut queue = Journal::default();
    queue.enqueue(binding(), "delivery", "hello", 0).unwrap();
    let submit = queue.poll(&binding(), &runtime(true), 1).unwrap();
    let mut recycled = runtime(true);
    recycled.start += 1;
    assert!(!queue.ack(&binding(), &recycled, lease(&submit), true, 2));
    assert!(queue.poll(&binding(), &recycled, LEASE_MS + 2).is_none());
    assert_eq!(
        queue
            .enqueue(binding(), "delivery", "hello", LEASE_MS + 3)
            .unwrap(),
        Outcome::InDoubt
    );
    assert!(!queue.ack(
        &binding(),
        &runtime(true),
        lease(&submit),
        true,
        LEASE_MS + 4
    ));
}

#[test]
fn rejected_native_input_is_not_reissued() {
    let mut queue = Journal::default();
    queue.enqueue(binding(), "delivery", "hello", 0).unwrap();
    let submit = queue.poll(&binding(), &runtime(false), 1).unwrap();
    assert!(queue.ack(&binding(), &runtime(false), lease(&submit), false, 2));
    assert!(queue.poll(&binding(), &runtime(false), 3).is_none());
    assert_eq!(
        queue.enqueue(binding(), "delivery", "hello", 4).unwrap(),
        Outcome::Failed
    );
}

#[test]
fn durable_lease_survives_restart_and_corrupt_file_is_preserved() {
    let dir = tempfile::tempdir().unwrap();
    edit(dir.path(), |queue| {
        queue.enqueue(binding(), "delivery", "hello", 0)
    })
    .unwrap();
    let action = edit(dir.path(), |queue| {
        Ok(queue.poll(&binding(), &runtime(true), 1))
    })
    .unwrap()
    .unwrap();
    assert!(edit(dir.path(), |queue| Ok(queue.poll(
        &binding(),
        &runtime(true),
        2
    )))
    .unwrap()
    .is_none());
    assert!(edit(dir.path(), |queue| Ok(queue.ack(
        &binding(),
        &runtime(true),
        lease(&action),
        true,
        3
    )))
    .unwrap());
    let path = dir.path().join("mobile-claude-handoff/queue.json");
    std::fs::write(&path, "corrupt").unwrap();
    assert!(edit(dir.path(), |_| Ok(())).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "corrupt");
}

#[test]
fn queue_bounds_and_handled_only_pruning() {
    let mut queue = Journal::default();
    assert!(queue
        .enqueue(binding(), "large", &"x".repeat(MAX_TEXT + 1), 0)
        .is_err());
    for index in 0..MAX_ENTRIES {
        queue
            .enqueue(binding(), &index.to_string(), "hello", 0)
            .unwrap();
    }
    assert!(queue.enqueue(binding(), "extra", "hello", 0).is_err());
    queue.prune(|id| id == "0");
    assert!(queue.enqueue(binding(), "extra", "hello", 0).is_ok());
    assert_eq!(queue.entries.len(), MAX_ENTRIES);
}

#[test]
fn absent_mod_expires_but_a_live_busy_mod_keeps_waiting_for_idle() {
    let mut absent = Journal::default();
    absent.enqueue(binding(), "delivery", "hello", 0).unwrap();
    assert_eq!(
        absent
            .enqueue(binding(), "delivery", "hello", LEASE_MS)
            .unwrap(),
        Outcome::Unavailable
    );
    assert!(absent
        .notice(&binding().scope)
        .contains("Restart or reload Claude"));
    assert!(absent
        .poll(&binding(), &runtime(true), LEASE_MS + 1)
        .is_none());

    let mut live = Journal::default();
    live.enqueue(binding(), "delivery", "hello", 0).unwrap();
    let mut busy = runtime(false);
    busy.idle = false;
    assert!(live.poll(&binding(), &busy, LEASE_MS - 1).is_none());
    assert_eq!(
        live.enqueue(binding(), "delivery", "hello", LEASE_MS)
            .unwrap(),
        Outcome::Waiting
    );
    assert!(matches!(
        live.poll(&binding(), &runtime(false), LEASE_MS + 1),
        Some(Action::Submit { .. })
    ));
}

#[test]
fn opt_out_cancels_unsent_and_never_replays_a_leased_native_message_as_peer() {
    let mut queue = Journal::default();
    queue.enqueue(binding(), "first", "one", 0).unwrap();
    let submit = queue.poll(&binding(), &runtime(false), 1).unwrap();
    queue.enqueue(binding(), "second", "two", 2).unwrap();
    queue.cancel();
    assert!(!queue.active_runtime(&binding(), &runtime(false)));
    assert_eq!(
        queue.previous(&binding().scope, "first", false, 3),
        Some(Outcome::InDoubt)
    );
    assert_eq!(
        queue.previous(&binding().scope, "second", false, 3),
        Some(Outcome::Failed)
    );
    assert!(!queue.ack(&binding(), &runtime(false), lease(&submit), true, 4));
    assert!(
        queue.poll(&binding(), &runtime(false), 5).is_none(),
        "re-enabling cannot resurrect either message"
    );
}

#[test]
fn changed_authority_retains_completed_receipt_and_cancels_pending_input() {
    let mut queue = Journal::default();
    queue.enqueue(binding(), "done", "one", 0).unwrap();
    let submit = queue.poll(&binding(), &runtime(false), 1).unwrap();
    assert!(queue.ack(&binding(), &runtime(false), lease(&submit), true, 2));
    assert_eq!(
        queue.previous(&binding().scope, "done", false, 3),
        Some(Outcome::Started)
    );
    queue.enqueue(binding(), "pending", "two", 4).unwrap();
    assert_eq!(
        queue.previous(&binding().scope, "pending", false, 5),
        Some(Outcome::Failed)
    );
    assert!(queue.poll(&binding(), &runtime(false), 6).is_none());
}

#[test]
fn scoped_revocation_keeps_receipts_and_never_revives_an_old_generation() {
    let mut queue = Journal::default();
    let revoked = binding();
    let other = Binding {
        scope: "other-login".into(),
        ..binding()
    };
    queue.enqueue(revoked.clone(), "done", "one", 0).unwrap();
    let done = queue.poll(&revoked, &runtime(false), 1).unwrap();
    assert!(queue.ack(&revoked, &runtime(false), lease(&done), true, 2));
    let Action::Submit {
        control_token: old, ..
    } = done;
    queue.enqueue(revoked.clone(), "leased", "two", 3).unwrap();
    let leased = queue.poll(&revoked, &runtime(false), 4).unwrap();
    queue
        .enqueue(revoked.clone(), "queued", "three", 5)
        .unwrap();
    queue
        .enqueue(other.clone(), "other", "unaffected", 5)
        .unwrap();
    let other_action = queue.poll(&other, &runtime(true), 6).unwrap();
    let Action::Submit {
        control_token: other_token,
        ..
    } = other_action;

    queue.cancel_scopes(&[revoked.scope.clone()].into());
    assert!(!queue.control_valid(&revoked, &runtime(false), &old, false));
    assert!(queue.control_valid(&other, &runtime(true), &other_token, false));
    for (id, outcome) in [
        ("done", Outcome::Started),
        ("leased", Outcome::InDoubt),
        ("queued", Outcome::Failed),
    ] {
        assert!(queue.contains_delivery(id));
        assert_eq!(queue.previous(&revoked.scope, id, true, 7), Some(outcome));
    }
    assert!(!queue.ack(&revoked, &runtime(false), lease(&leased), true, 8));
    assert!(queue.poll(&revoked, &runtime(false), 9).is_none());
    queue
        .enqueue(revoked.clone(), "fresh", "new explicit turn", 10)
        .unwrap();
    let Action::Submit {
        control_token: fresh,
        ..
    } = queue.poll(&revoked, &runtime(false), 11).unwrap();
    assert_ne!(fresh, old);
    assert!(!queue.control_valid(&revoked, &runtime(false), &old, false));
    assert!(queue.control_valid(&revoked, &runtime(false), &fresh, false));
}

#[test]
fn dead_runtime_pruning_allows_more_than_lifetime_capacity_without_replaying_leases() {
    let mut queue = Journal::default();
    for index in 0..MAX_ENTRIES + 10 {
        let mut owner = binding();
        owner.scope = format!("session-{index}");
        let id = format!("delivery-{index}");
        queue.prune_active(|_, _| false);
        queue.prune(|previous| previous != &id);
        queue.enqueue(owner.clone(), &id, "hello", 0).unwrap();
        let submit = queue.poll(&owner, &runtime(false), 1).unwrap();
        assert!(!queue.confirmed_active_runtime(&owner, &runtime(false)));
        queue.prune_active(|_, _| false);
        assert!(queue.poll(&owner, &runtime(false), 2).is_none());
        assert!(queue.ack(&owner, &runtime(false), lease(&submit), true, 3));
        assert_eq!(
            queue.enqueue(owner, &id, "hello", 4).unwrap(),
            Outcome::Started
        );
    }
}

#[test]
fn results_require_confirmed_submission_but_permissions_can_arrive_before_ack() {
    let mut queue = Journal::default();
    queue.enqueue(binding(), "delivery", "hello", 0).unwrap();
    let action = queue.poll(&binding(), &runtime(false), 1).unwrap();
    assert!(queue.active_runtime(&binding(), &runtime(false)));
    assert!(!queue.confirmed_active_runtime(&binding(), &runtime(false)));
    assert!(queue.ack(&binding(), &runtime(false), lease(&action), false, 2));
    assert!(!queue.confirmed_active_runtime(&binding(), &runtime(false)));
}

#[test]
fn control_generation_rejects_old_owner_and_recycled_runtime_results() {
    let mut queue = Journal::default();
    queue.enqueue(binding(), "old", "hello", 0).unwrap();
    let first = queue.poll(&binding(), &runtime(false), 1).unwrap();
    let Action::Submit {
        control_token: old, ..
    } = &first;
    assert!(queue.control_valid(&binding(), &runtime(false), old, false));
    assert!(!queue.control_valid(&binding(), &runtime(false), old, true));
    queue.ack(&binding(), &runtime(false), lease(&first), true, 2);
    assert!(queue.control_valid(&binding(), &runtime(false), old, true));
    let mut next = binding();
    next.owner = "different-person".into();
    queue.enqueue(next.clone(), "new", "hello", 3).unwrap();
    let second = queue.poll(&next, &runtime(false), 4).unwrap();
    let Action::Submit {
        control_token: new, ..
    } = &second;
    assert_ne!(old, new);
    assert!(!queue.control_valid(&next, &runtime(false), old, false));
    assert!(!queue.control_valid(&binding(), &runtime(false), old, false));
    assert!(queue.control_valid(&next, &runtime(false), new, false));
    queue.ack(&next, &runtime(false), lease(&second), true, 5);
    queue
        .enqueue(next.clone(), "replacement", "hello", 6)
        .unwrap();
    queue.poll(&next, &runtime(true), 7).unwrap();
    assert!(!queue.control_valid(&next, &runtime(true), new, false));
}
