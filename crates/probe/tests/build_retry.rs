use agent_relay_probe::delivery::{self, DeliveryJobConfig, ExportSelection};
use rusqlite::Connection;

/// A blocked job in an install's store of its own. The directory lives as
/// long as the store.
fn blocked_job() -> (tempfile::TempDir, Connection, String) {
    let directory = tempfile::tempdir().unwrap();
    let conn = delivery::open_db(&directory.path().join("history.db")).unwrap();
    let job = delivery::create_job(
        &conn,
        &DeliveryJobConfig {
            destination_id: "fixture".into(),
            instance_id: "probe".into(),
            account_id: "account".into(),
            mapping_version: "1".into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["session_event".into()],
                ..Default::default()
            },
            limits: Default::default(),
        },
        0,
    )
    .unwrap();
    conn.execute(
        "UPDATE delivery_jobs SET state='blocked',failure='invalid_payload' WHERE id=?",
        [&job.job_id],
    )
    .unwrap();
    (directory, conn, job.job_id)
}

#[test]
fn legacy_marker_is_imported_during_schema_upgrade_without_repeating_retry() {
    let (directory, conn, id) = blocked_job();
    conn.execute_batch("ALTER TABLE delivery_jobs DROP COLUMN retry_build")
        .unwrap();
    drop(delivery::open_db(&directory.path().join("history.db")).unwrap());
    delivery::retry_job_for_build(&conn, &id, "0.26.1", Some("0.26.1")).unwrap();
    assert_eq!(delivery::status(&conn, &id).unwrap().state, "blocked");
    // Losing the file later cannot forget the imported verdict.
    delivery::retry_job_for_build(&conn, &id, "0.26.1", None).unwrap();
    assert_eq!(delivery::status(&conn, &id).unwrap().state, "blocked");
    delivery::retry_job_for_build(&conn, &id, "0.26.2", None).unwrap();
    assert_eq!(delivery::status(&conn, &id).unwrap().state, "active");
}

#[test]
fn schema_upgrade_marks_an_existing_retry_deadline_as_client_generated() {
    let (directory, conn, id) = blocked_job();
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE delivery_jobs SET state='active',failure='rate_limited',next_attempt_ms=? WHERE id=?",
        rusqlite::params![now + 3_600_000, &id],
    )
    .unwrap();
    conn.execute_batch("ALTER TABLE delivery_jobs DROP COLUMN receiver_retry_after_ms")
        .unwrap();
    drop(delivery::open_db(&directory.path().join("history.db")).unwrap());

    let receiver_deadline: i64 = conn
        .query_row(
            "SELECT receiver_retry_after_ms FROM delivery_jobs WHERE id=?",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receiver_deadline, 0);
    delivery::retry_job_for_build(&conn, &id, "0.26.1", None).unwrap();
    let next = delivery::status(&conn, &id).unwrap().next_attempt_ms;
    assert!((now + 299_000..=now + 301_000).contains(&next), "{next}");
}

#[test]
fn retry_history_survives_version_rollbacks() {
    let (_directory, conn, id) = blocked_job();
    for (build, expected) in [
        ("0.26.1", "active"),
        ("0.26.2", "active"),
        ("0.26.1", "blocked"),
        ("0.26.2", "blocked"),
        ("0.26.3", "active"),
    ] {
        conn.execute(
            "UPDATE delivery_jobs SET state='blocked',failure='invalid_payload' WHERE id=?",
            [&id],
        )
        .unwrap();
        delivery::retry_job_for_build(&conn, &id, build, None).unwrap();
        assert_eq!(
            delivery::status(&conn, &id).unwrap().state,
            expected,
            "build {build}"
        );
    }
    let builds: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM delivery_job_builds WHERE job_id=?",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(builds, 3);
}

#[test]
fn migration_preserves_the_previous_single_build_record() {
    let (directory, conn, id) = blocked_job();
    conn.execute_batch("DROP TABLE delivery_job_builds")
        .unwrap();
    conn.execute(
        "UPDATE delivery_jobs SET retry_build='0.26.1' WHERE id=?",
        [&id],
    )
    .unwrap();
    drop(delivery::open_db(&directory.path().join("history.db")).unwrap());
    delivery::retry_job_for_build(&conn, &id, "0.26.2", None).unwrap();
    assert_eq!(delivery::status(&conn, &id).unwrap().state, "active");
    conn.execute("UPDATE delivery_jobs SET state='blocked' WHERE id=?", [&id])
        .unwrap();
    delivery::retry_job_for_build(&conn, &id, "0.26.1", None).unwrap();
    assert_eq!(delivery::status(&conn, &id).unwrap().state, "blocked");
}

#[test]
fn build_record_failure_rolls_back_job_and_batch_retry() {
    let (_directory, conn, id) = blocked_job();
    conn.execute("INSERT INTO delivery_batches(id,job_id,state,records,bytes,journal_end,created_ms) VALUES('batch',?,'blocked',1,0,0,0)", [&id]).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_retry_build BEFORE UPDATE OF retry_build ON delivery_jobs BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;").unwrap();
    assert!(delivery::retry_job_for_build(&conn, &id, "0.26.1", None).is_err());
    let status = delivery::status(&conn, &id).unwrap();
    assert_eq!(status.state, "blocked");
    assert_eq!(status.failure.as_deref(), Some("invalid_payload"));
    let recorded: Option<String> = conn
        .query_row(
            "SELECT retry_build FROM delivery_jobs WHERE id=?",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recorded, None);
    let builds: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM delivery_job_builds WHERE job_id=?",
            [&id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        builds, 0,
        "a failed transaction must not consume the build's retry"
    );
    let batch_state: String = conn
        .query_row(
            "SELECT state FROM delivery_batches WHERE id='batch'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(batch_state, "blocked");

    conn.execute_batch("DROP TRIGGER reject_retry_build")
        .unwrap();
    delivery::retry_job_for_build(&conn, &id, "0.26.1", None).unwrap();
    assert_eq!(delivery::status(&conn, &id).unwrap().state, "active");
    let batch_state: String = conn
        .query_row(
            "SELECT state FROM delivery_batches WHERE id='batch'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(batch_state, "pending");
}
