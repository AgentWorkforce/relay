use super::super::*;
use super::fixture::{self, Fixture};

#[test]
fn policy_persists_across_fresh_processes_for_every_desktop_choice() {
    let f = Fixture::new(3, 0);
    assert_eq!(
        ai_hist::retention::read_retention_policy(&f.db)
            .unwrap()
            .days
            .unwrap()
            .get(),
        30
    );
    for days in [7, 30, 90, 0] {
        f.actor(&format!("save-{days}"));
        f.actor(&format!("check-{days}"));
    }
    f.actor("upload");
    f.actor("prune-once");
    assert_eq!(
        f.events("expired"),
        3,
        "forever policy keeps even uploaded old history"
    );
}

#[test]
fn failed_and_partial_uploads_do_not_authorize_eviction() {
    let f = Fixture::new(8, 0);
    f.actor("save-7");
    f.actor("upload-fail");
    assert_eq!(upload_floor(&f.conn()).unwrap(), Some(0));
    f.actor("prune-once");
    assert_eq!(f.events("expired"), 8);
    delivery::retry_job(&f.conn(), &f.job).unwrap();
    f.actor("upload-partial");
    assert_eq!(f.receiver_count(), 1);
    assert_eq!(upload_floor(&f.conn()).unwrap(), Some(0));
    f.actor("prune-once");
    assert_eq!(
        f.events("expired"),
        8,
        "partial receipts must not raise the durable floor"
    );
    delivery::retry_job(&f.conn(), &f.job).unwrap();
    f.actor("upload");
    assert_eq!(f.receiver_count(), 8);
    f.actor("prune-to-done");
    assert_eq!(f.events("expired"), 0);
    assert_eq!(
        f.receiver_count(),
        8,
        "uploaded copies outlive local eviction"
    );
}

#[test]
fn a_later_unuploaded_prompt_protects_an_already_uploaded_session() {
    let f = Fixture::new(3, 0);
    f.actor("save-7");
    f.actor("upload");
    f.conn().execute("INSERT INTO history(source,session_id,prompt,timestamp_ms) VALUES ('claude','expired','synthetic late prompt',42)",[]).unwrap();
    f.actor("prune-once");
    assert_eq!(
        f.events("expired"),
        3,
        "floor protects every evidence kind, not just events"
    );
    assert_eq!(fixture::scalar(&f.db, "SELECT COUNT(*) FROM history"), 1);
    f.actor("upload");
    assert_eq!(f.receiver_count(), 4);
    f.actor("prune-to-done");
    assert_eq!(f.events("expired"), 0);
    assert_eq!(fixture::scalar(&f.db, "SELECT COUNT(*) FROM history"), 0);
}

#[test]
fn scheduled_maintenance_waits_until_due_and_is_idempotent() {
    let f = Fixture::new(0, 1);
    f.actor("save-7");
    f.actor("upload");
    f.actor("schedule");
    assert_eq!(f.events("recent"), 1);
    assert_eq!(f.events("expired"), 0);
}

#[test]
fn killing_an_upload_after_remote_commit_safely_replays_its_payload() {
    let f = Fixture::new(8, 0);
    f.actor("save-7");
    f.kill_at_checkpoint("upload-pause");
    assert_eq!(f.receiver_count(), 1);
    assert_eq!(upload_floor(&f.conn()).unwrap(), Some(0));
    f.actor("prune-once");
    assert_eq!(f.events("expired"), 8);
    f.actor("upload");
    assert_eq!(f.receiver_count(), 8);
    let remote = f.root.path().join("receiver.db");
    assert_eq!(
        fixture::scalar(&remote, "SELECT SUM(calls) FROM preparations"),
        1,
        "restart must reuse the persisted payload without another prepare call"
    );
    assert_eq!(
        fixture::scalar(&remote, "SELECT COUNT(*) FROM applied"),
        8,
        "no duplicate semantic application"
    );
    assert_eq!(
        fixture::scalar(&remote, "SELECT COUNT(DISTINCT body) FROM attempts"),
        1,
        "interrupted immutable payload is reused"
    );
    assert_eq!(
        fixture::scalar(&remote, "SELECT COUNT(DISTINCT batch_id) FROM attempts"),
        1
    );
    assert_eq!(fixture::scalar(&remote, "SELECT COUNT(*) FROM attempts"), 2);
    f.actor("prune-to-done");
    assert_eq!(f.receiver_count(), 8);
}

#[test]
fn killing_a_partially_completed_prune_resumes_without_losing_retained_history() {
    let f = Fixture::new(900, 2);
    f.actor("save-7");
    f.actor("upload");
    f.kill_at_checkpoint("prune-pause");
    let remaining = f.events("expired");
    assert!(remaining > 0 && remaining < 900);
    assert_eq!(f.events("recent"), 2);
    assert_eq!(f.receiver_count(), 902);
    f.actor("prune-to-done");
    f.actor("prune-once");
    assert_eq!(f.events("expired"), 0);
    assert_eq!(f.events("recent"), 2);
    assert_eq!(f.receiver_count(), 902);
    let integrity: String = f
        .conn()
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}

#[test]
fn local_eviction_sends_no_tombstones_but_ordinary_deletes_still_work() {
    let f = Fixture::new(6, 2);
    f.actor("save-7");
    f.actor("upload");
    fixture::seed(&f.conn(), "unuploaded", 2, Some(42));
    f.actor("prune-to-done");
    assert_eq!(
        f.events("unuploaded"),
        2,
        "new, unuploaded old history stays local"
    );
    assert_eq!(f.events("recent"), 2);
    assert_eq!(f.receiver_count(), 8);
    f.actor("upload");
    let remote = f.root.path().join("receiver.db");
    assert_eq!(f.receiver_count(), 10);
    assert_eq!(
        fixture::scalar(
            &remote,
            "SELECT COUNT(*) FROM applied WHERE operation='delete'"
        ),
        0
    );
    // Positive control: this receiver would really remove an uploaded copy if
    // the feed accidentally exposed local eviction as a cloud tombstone.
    f.conn()
        .execute(
            "DELETE FROM session_events WHERE session_id='recent' AND event_uid='recent-0'",
            [],
        )
        .unwrap();
    f.actor("upload");
    assert_eq!(
        fixture::scalar(
            &remote,
            "SELECT COUNT(*) FROM applied WHERE operation='delete'"
        ),
        1
    );
    assert_eq!(f.receiver_count(), 9);
}

#[test]
fn paused_destination_and_selected_session_backfill_keep_history_protected() {
    let f = Fixture::new(3, 0);
    f.actor("save-7");
    f.actor("upload");
    let conn = f.conn();
    let paused = delivery::create_job(&conn, &fixture::config("paused"), 0).unwrap();
    delivery::pause_job(&conn, &paused.job_id).unwrap();
    f.actor("prune-once");
    assert_eq!(f.events("expired"), 3);
    assert_eq!(upload_floor(&conn).unwrap(), Some(0));
    let selected = delivery::create_session_job(&conn, &fixture::config("selected"), 0).unwrap();
    delivery::include_job_session(
        &conn,
        &selected.job_id,
        &delivery::SessionIdentity {
            source: "claude".into(),
            session_id: "expired".into(),
        },
    )
    .unwrap();
    delivery::cancel_job(&conn, &paused.job_id).unwrap();
    f.actor("prune-once");
    assert_eq!(upload_floor(&conn).unwrap(), Some(0));
    assert_eq!(f.events("expired"), 3);
    f.actor("upload");
    f.actor("prune-to-done");
    assert_eq!(f.events("expired"), 0);
}
