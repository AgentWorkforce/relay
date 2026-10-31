use agent_relay_probe::delivery::*;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

/// An install's store in its own directory, opened as its collector.
struct Db {
    conn: Connection,
    _directory: tempfile::TempDir,
}
impl std::ops::Deref for Db {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.conn
    }
}
fn db() -> Db {
    let directory = tempfile::tempdir().unwrap();
    let conn = open_db(&directory.path().join("history.db")).unwrap();
    Db {
        conn,
        _directory: directory,
    }
}
fn config(instance: &str) -> DeliveryJobConfig {
    DeliveryJobConfig {
        destination_id: "fixture".into(),
        instance_id: instance.into(),
        account_id: "account".into(),
        mapping_version: "1".into(),
        selection: ExportSelection {
            all_sources: true,
            kinds: vec!["session_event".into()],
            ..ExportSelection::default()
        },
        limits: DeliveryLimits {
            max_batch_records: 2,
            max_scan_records: 4,
            ..DeliveryLimits::default()
        },
    }
}
fn event(conn: &Connection, id: &str, text: &str) {
    conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?1,42,'user','text',?2)",params![id,text]).unwrap();
}
fn ack(claim: &ClaimedBatch) -> DeliveryAcknowledgment {
    DeliveryAcknowledgment {
        batch_id: claim.batch.batch_id.clone(),
        accepted_revision_ids: claim
            .batch
            .records
            .iter()
            .map(|r| r.revision_id.clone())
            .collect(),
        unsupported_revision_ids: vec![],
        suppressed_revision_ids: vec![],
        rejected_revision_ids: vec![],
        isolation_frontier: vec![],
        acceptance_level: AcceptanceLevel::Durable,
    }
}
fn claim(conn: &Connection, id: &str, now: i64) -> Option<ClaimedBatch> {
    for _ in 0..100 {
        let prep = prepare_batch(conn, id, now).unwrap();
        if prep.batch_id.is_some() {
            return claim_batch(conn, id, "worker", 1000, &|| now).unwrap();
        }
        if prep.bootstrap_complete && prep.scanned_records == 0 {
            return None;
        }
    }
    panic!("bounded fixture failed to progress")
}
fn prepare(conn: &Connection, claim: &ClaimedBatch, now: i64) {
    store_prepared_payload(
        conn,
        &claim.lease,
        &claim.batch.mapping_version,
        "application/json",
        &serde_json::to_string(&claim.batch).unwrap(),
        &|| now,
    )
    .unwrap();
}
fn drain(conn: &Connection, id: &str) -> Vec<HistoryExportRecord> {
    let mut records = vec![];
    for step in 0..100 {
        let now = step * 10;
        let Some(claim) = claim(conn, id, now) else {
            return records;
        };
        prepare(conn, &claim, now);
        acknowledge(conn, &claim.lease, &ack(&claim), &|| now).unwrap();
        records.extend(claim.batch.records);
    }
    panic!("drain did not converge")
}

#[test]
fn delivery_is_inert_until_explicitly_enabled_and_schema_reopen_is_idempotent() {
    let conn = db();
    event(&conn, "one", "local");
    let batches: i64 = conn
        .query_row("SELECT COUNT(*) FROM delivery_batches", [], |r| r.get(0))
        .unwrap();
    assert_eq!(batches, 0);
    let first = create_job(&conn, &config("one"), 0).unwrap();
    assert_eq!(
        create_job(&conn, &config("one"), 1).unwrap().job_id,
        first.job_id
    );
    drop(open_db(std::path::Path::new(conn.path().unwrap())).unwrap());
    assert_eq!(list_jobs(&conn).unwrap().len(), 1);
    let records = drain(&conn, &first.job_id);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].payload["text"], "local");
}

#[test]
fn restart_after_remote_acceptance_preserves_batch_and_prepared_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("history.db");
    let conn = open_db(&path).unwrap();
    event(&conn, "one", "old");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let first = claim(&conn, &job.job_id, 0).unwrap();
    prepare(&conn, &first, 0);
    // A receiver with idempotency persists acceptance, then its response is lost.
    let mut receiver = HashSet::new();
    receiver.insert(first.batch.records[0].revision_id.clone());
    conn.execute(
        "UPDATE session_events SET text='new' WHERE session_id='one'",
        [],
    )
    .unwrap();
    drop(conn);
    let conn = open_db(&path).unwrap();
    assert!(claim_batch(&conn, &job.job_id, "other", 1000, &|| 500)
        .unwrap()
        .is_none());
    let retry = claim_batch(&conn, &job.job_id, "other", 1000, &|| 1001)
        .unwrap()
        .unwrap();
    assert_eq!(retry.batch, first.batch);
    assert!(retry.prepared.is_some());
    assert_eq!(
        retry.prepared.as_ref().unwrap().body,
        serde_json::to_string(&first.batch).unwrap()
    );
    assert!(store_prepared_payload(
        &conn,
        &retry.lease,
        "1",
        "application/json",
        "changed bytes",
        &|| 1002
    )
    .is_err());
    assert!(acknowledge(&conn, &first.lease, &ack(&first), &|| 1002).is_err());
    receiver.insert(retry.batch.records[0].revision_id.clone());
    assert_eq!(receiver.len(), 1);
    acknowledge(&conn, &retry.lease, &ack(&retry), &|| 1002).unwrap();
    let changed = drain(&conn, &job.job_id);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].payload["text"], "new");
    assert_eq!(changed[0].record_id, first.batch.records[0].record_id);
    assert!(changed[0].revision > first.batch.records[0].revision);
}

#[test]
fn partial_and_unsupported_acknowledgments_block_but_isolated_records_are_suppressed() {
    let conn = db();
    event(&conn, "a", "one");
    event(&conn, "b", "two");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let first = claim(&conn, &job.job_id, 0).unwrap();
    prepare(&conn, &first, 0);
    let mut invalid = ack(&first);
    invalid.accepted_revision_ids.push("unknown".into());
    assert!(acknowledge(&conn, &first.lease, &invalid, &|| 1).is_err());
    let mut partial = ack(&first);
    partial.accepted_revision_ids.pop();
    let pending = acknowledge(&conn, &first.lease, &partial, &|| 1).unwrap();
    assert_eq!(pending.acknowledged_records, 0);
    assert_eq!(pending.pending_records, 2);
    assert!(claim_batch(&conn, &job.job_id, "other", 1000, &|| 2)
        .unwrap()
        .is_none());
    retry_job(&conn, &job.job_id).unwrap();
    let retry = claim_batch(&conn, &job.job_id, "other", 1000, &|| 3)
        .unwrap()
        .unwrap();
    assert_eq!(retry.batch, first.batch);
    assert_eq!(retry.accepted_revision_ids, partial.accepted_revision_ids);
    assert!(retry.suppressed_revision_ids.is_empty());
    let mut unsupported = ack(&retry);
    unsupported
        .unsupported_revision_ids
        .push(unsupported.accepted_revision_ids.pop().unwrap());
    let blocked = acknowledge(&conn, &retry.lease, &unsupported, &|| 4).unwrap();
    assert_eq!(blocked.state, "blocked");
    assert_eq!(blocked.failure.as_deref(), Some("unsupported_evidence"));
    assert_eq!(blocked.acknowledged_cursor, 0);
    assert_eq!(blocked.suppressed_records, 0);
    assert_eq!(blocked.skipped_records, 0);
    retry_job(&conn, &job.job_id).unwrap();
    let retry = claim_batch(&conn, &job.job_id, "other", 1000, &|| 5)
        .unwrap()
        .unwrap();
    let mut isolated = ack(&retry);
    isolated
        .suppressed_revision_ids
        .push(isolated.accepted_revision_ids.pop().unwrap());
    let settled = acknowledge(&conn, &retry.lease, &isolated, &|| 6).unwrap();
    assert_eq!(settled.state, "active");
    assert_eq!(settled.failure, None);
    assert!(settled.acknowledged_cursor > 0);
    assert_eq!(settled.acknowledged_records, 1);
    assert_eq!(settled.suppressed_records, 1);
    assert_eq!(settled.skipped_records, 1);
    assert_eq!(settled.pending_records, 0);
}

#[test]
fn receiver_isolation_counts_only_the_records_it_skips() {
    let conn = db();
    event(&conn, "a", "one");
    event(&conn, "b", "two");
    event(&conn, "c", "three");
    let mut three = config("one");
    three.limits.max_batch_records = 3;
    let job = create_job(&conn, &three, 0).unwrap();
    let claimed = claim(&conn, &job.job_id, 0).unwrap();
    prepare(&conn, &claimed, 0);
    let mut isolated = ack(&claimed);
    for _ in 0..2 {
        isolated
            .suppressed_revision_ids
            .push(isolated.accepted_revision_ids.pop().unwrap());
    }

    let settled = acknowledge(&conn, &claimed.lease, &isolated, &|| 1).unwrap();
    assert_eq!(settled.acknowledged_records, 1);
    assert_eq!(settled.suppressed_records, 2);
    assert_eq!(settled.skipped_records, 2);
}

#[test]
fn provisional_rejections_resume_but_are_never_counted_as_suppressed() {
    let conn = db();
    event(&conn, "a", "one");
    event(&conn, "b", "two");
    let job = create_job(&conn, &config("candidates"), 0).unwrap();
    let first = claim(&conn, &job.job_id, 0).unwrap();
    prepare(&conn, &first, 0);
    let mut partial = ack(&first);
    partial.accepted_revision_ids.clear();
    partial
        .rejected_revision_ids
        .push(first.batch.records[0].revision_id.clone());
    partial.isolation_frontier.push(IsolationTask {
        revision_ids: vec![first.batch.records[1].revision_id.clone()],
        rejected: false,
    });
    let waiting = acknowledge(&conn, &first.lease, &partial, &|| 1).unwrap();
    assert_eq!(waiting.acknowledged_records, 0);
    assert_eq!(waiting.suppressed_records, 0);
    assert_eq!(waiting.pending_records, 2);

    let retry = claim_batch(&conn, &job.job_id, "other", 1_000, &|| 1_000_000)
        .unwrap()
        .unwrap();
    assert!(retry.accepted_revision_ids.is_empty());
    assert!(retry.suppressed_revision_ids.is_empty());
    assert_eq!(retry.rejected_revision_ids, partial.rejected_revision_ids);
    assert_eq!(retry.isolation_frontier, partial.isolation_frontier);
    record_failure(
        &conn,
        &retry.lease,
        DeliveryFailure::ReceiverRejected,
        None,
        &|| 1_000_001,
    )
    .unwrap();
    retry_job(&conn, &job.job_id).unwrap();
    let retried = claim_batch(&conn, &job.job_id, "third", 1_000, &|| 1_000_002)
        .unwrap()
        .unwrap();
    assert!(retried.rejected_revision_ids.is_empty());
    assert!(retried.isolation_frontier.is_empty());
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 0);
}

#[test]
fn a_legacy_writer_overlap_rebuilds_only_the_unresolved_frontier() {
    let conn = db();
    event(&conn, "a", "one");
    event(&conn, "b", "two");
    let job = create_job(&conn, &config("rollback"), 0).unwrap();
    let first = claim(&conn, &job.job_id, 0).unwrap();
    prepare(&conn, &first, 0);
    let mut partial = ack(&first);
    partial.accepted_revision_ids.clear();
    partial.isolation_frontier.push(IsolationTask {
        revision_ids: first
            .batch
            .records
            .iter()
            .map(|record| record.revision_id.clone())
            .collect(),
        rejected: true,
    });
    acknowledge(&conn, &first.lease, &partial, &|| 1).unwrap();

    // Simulate a rollback to a build that knows accepted progress but does not
    // know the frontier column: it accepts one revision and leaves the newer
    // column untouched.
    let legacy_accepted = vec![first.batch.records[0].revision_id.clone()];
    conn.execute(
        "UPDATE delivery_batches SET accepted_revision_ids=? WHERE id=?",
        params![
            serde_json::to_string(&legacy_accepted).unwrap(),
            first.batch.batch_id
        ],
    )
    .unwrap();

    let retry = claim_batch(&conn, &job.job_id, "new-build", 1_000, &|| 1_000_000)
        .unwrap()
        .unwrap();
    assert_eq!(retry.accepted_revision_ids, legacy_accepted);
    assert_eq!(retry.isolation_frontier.len(), 1);
    assert_eq!(
        retry.isolation_frontier[0].revision_ids,
        vec![first.batch.records[1].revision_id.clone()]
    );
    assert!(!retry.isolation_frontier[0].rejected);
    let stored: String = conn
        .query_row(
            "SELECT isolation_frontier FROM delivery_batches WHERE id=?",
            [&first.batch.batch_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Vec<IsolationTask>>(&stored).unwrap(),
        retry.isolation_frontier
    );
}

#[test]
fn two_destinations_bootstrap_independently_while_one_is_offline() {
    let conn = db();
    event(&conn, "a", "initial");
    let left = create_job(&conn, &config("left"), 0).unwrap();
    let right = create_job(&conn, &config("right"), 1).unwrap();
    let failed = claim(&conn, &left.job_id, 2).unwrap();
    prepare(&conn, &failed, 2);
    record_failure(
        &conn,
        &failed.lease,
        DeliveryFailure::RateLimited,
        Some(50_000),
        &|| 3,
    )
    .unwrap();
    assert_eq!(drain(&conn, &right.job_id).len(), 1);
    let left_status = status(&conn, &left.job_id).unwrap();
    assert_eq!(left_status.acknowledged_records, 0);
    assert_eq!(left_status.next_attempt_ms, 50_000);
    event(&conn, "b", "later");
    assert_eq!(drain(&conn, &right.job_id).len(), 1);
    assert_eq!(status(&conn, &left.job_id).unwrap().pending_records, 1);
    assert_eq!(
        status(&conn, &right.job_id).unwrap().acknowledged_records,
        2
    );
}

#[test]
fn changing_logical_identity_emits_old_tombstone_then_new_revision() {
    let conn = db();
    event(&conn, "a", "content");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let before = drain(&conn, &job.job_id);
    conn.execute(
        "UPDATE session_events SET event_uid='other' WHERE session_id='a'",
        [],
    )
    .unwrap();
    let after = drain(&conn, &job.job_id);
    assert_eq!(after.len(), 2);
    assert_eq!(after[0].operation, "delete");
    assert_eq!(after[0].record_id, before[0].record_id);
    assert_ne!(after[1].record_id, before[0].record_id);
    assert!(after[1].revision > after[0].revision);
}

#[test]
fn queued_exclusion_fences_workers_and_remaps_only_with_a_new_batch_id() {
    let conn = db();
    event(&conn, "a", "keep");
    event(&conn, "b", "private");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let old = claim(&conn, &job.job_id, 0).unwrap();
    prepare(&conn, &old, 0);
    set_session_excluded(
        &conn,
        &SessionIdentity {
            source: "claude".into(),
            session_id: "b".into(),
        },
        true,
    )
    .unwrap();
    assert!(acknowledge(&conn, &old.lease, &ack(&old), &|| 1).is_err());
    let next = claim_batch(&conn, &job.job_id, "new", 1000, &|| 2)
        .unwrap()
        .unwrap();
    assert_ne!(next.batch.batch_id, old.batch.batch_id);
    assert!(next.prepared.is_none());
    assert_eq!(next.batch.records.len(), 1);
    assert_eq!(next.batch.records[0].session_id.as_deref(), Some("a"));
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 1);
    assert_eq!(status(&conn, &job.job_id).unwrap().skipped_records, 0);
    prepare(&conn, &next, 2);
    acknowledge(&conn, &next.lease, &ack(&next), &|| 3).unwrap();
    assert_eq!(status(&conn, &job.job_id).unwrap().acknowledged_records, 1);
}

#[test]
fn pause_retains_capture_and_selection_changes_require_explicit_new_generation() {
    let conn = db();
    event(&conn, "a", "first");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    pause_job(&conn, &job.job_id).unwrap();
    event(&conn, "b", "while paused");
    assert!(claim_batch(&conn, &job.job_id, "worker", 1000, &|| 0)
        .unwrap()
        .is_none());
    let mut changed = config("one");
    changed.mapping_version = "2".into();
    assert!(create_job(&conn, &changed, 1).is_err());
    resume_job(&conn, &job.job_id).unwrap();
    assert_eq!(drain(&conn, &job.job_id).len(), 2);
    cancel_job(&conn, &job.job_id).unwrap();
    let next = create_job(&conn, &changed, 2).unwrap();
    assert_eq!(next.generation, 2);
    assert_ne!(next.job_id, job.job_id);
    assert_eq!(drain(&conn, &next.job_id).len(), 2);
}

#[test]
fn lease_renewal_prevents_overlap_and_stale_failure_cannot_change_progress() {
    let conn = db();
    event(&conn, "a", "first");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let claim = claim(&conn, &job.job_id, 0).unwrap();
    let renewed = renew_lease(&conn, &claim.lease, 5000, &|| 500).unwrap();
    assert_eq!(renewed.expires_at_ms, 5500);
    assert!(claim_batch(&conn, &job.job_id, "other", 1000, &|| 1001)
        .unwrap()
        .is_none());
    let next = claim_batch(&conn, &job.job_id, "other", 1000, &|| 5501)
        .unwrap()
        .unwrap();
    assert_eq!(next.batch, claim.batch);
    assert!(record_failure(
        &conn,
        &renewed,
        DeliveryFailure::PermissionDenied,
        None,
        &|| 5502
    )
    .is_err());
    assert_eq!(status(&conn, &job.job_id).unwrap().state, "active");
}

fn tool_result(conn: &Connection, id: &str, text: &str) {
    conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text,payload_bytes) VALUES ('claude',?1,?1||'-tool',42,'user','tool_result',?2,?3)",params![id,text,text.len() as i64]).unwrap();
}
const MARKER: &str = " [truncated by Agent Relay to fit the upload limit]";
fn small(instance: &str) -> DeliveryJobConfig {
    let mut small = config(instance);
    small.limits.max_batch_bytes = 4096;
    small
}

#[test]
fn a_record_over_the_byte_limit_is_truncated_to_fit_and_keeps_its_identity() {
    let conn = db();
    tool_result(&conn, "a", &"x".repeat(10_000));
    let whole = drain(
        &conn,
        &create_job(&conn, &config("roomy"), 0).unwrap().job_id,
    );
    let job = create_job(&conn, &small("small"), 1).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    let (record, original) = (&records[0], &whole[0]);
    assert_eq!(record.record_id, original.record_id);
    assert_eq!(record.kind, original.kind);
    let text = record.payload["text"].as_str().unwrap();
    assert!(text.ends_with(MARKER), "{text}");
    assert!(text.len() < 4096);
    assert!(text.trim_end_matches(MARKER).chars().all(|c| c == 'x'));
    assert_eq!(record.payload["payload_truncated"], 1);
    assert_eq!(record.payload["payload_bytes"], 10_000);
    assert_ne!(original.payload["payload_truncated"], 1);
    let state = status(&conn, &job.job_id).unwrap();
    assert!(state.bootstrap_complete);
    assert_eq!(state.suppressed_records, 0);
}

#[test]
fn a_json_document_over_the_limit_is_cut_inside_and_stays_valid() {
    let conn = db();
    let blocks = serde_json::json!([
        {"type": "text", "text": "PDF pages extracted"},
        {"type": "image", "source": {"data": "A".repeat(20_000)}},
    ]);
    tool_result(&conn, "a", &blocks.to_string());
    let job = create_job(&conn, &small("small"), 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    let text = records[0].payload["text"].as_str().unwrap();
    let cut: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(cut[0]["text"], "PDF pages extracted");
    assert!(cut[1]["source"]["data"].as_str().unwrap().ends_with(MARKER));
    assert_eq!(records[0].payload["payload_truncated"], 1);
}

#[test]
fn an_oversized_identity_column_is_never_cut() {
    let conn = db();
    let uid = "u".repeat(10_000);
    conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','a',?1,42,'user','text','short')",[&uid]).unwrap();
    let job = create_job(&conn, &small("small"), 0).unwrap();
    assert!(drain(&conn, &job.job_id).is_empty());
    let state = status(&conn, &job.job_id).unwrap();
    assert!(state.bootstrap_complete);
    assert_eq!(state.suppressed_records, 1);
}

#[test]
fn escaped_text_is_cut_alone_and_other_columns_keep_their_values() {
    let conn = db();
    let cwd = "/".to_owned() + &"d".repeat(1500);
    conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text,cwd,payload_hash) VALUES ('claude','a','e',42,'user','tool_result',?1,?2,'hash')",params!["\"\\".repeat(4000), cwd]).unwrap();
    let job = create_job(&conn, &small("small"), 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    let payload = &records[0].payload;
    assert!(payload["text"].as_str().unwrap().ends_with(MARKER));
    assert_eq!(payload["cwd"], cwd.as_str());
    assert_eq!(payload["payload_hash"], "hash");
    assert_eq!(payload["event_uid"], "e");
}

#[test]
fn a_document_of_many_short_strings_is_cut_in_one_pass() {
    let conn = db();
    // Long enough that cutting each to the marker fits the batch, many
    // enough that the cut touches thousands of them.
    let leaves: Vec<String> = (0..12_000)
        .map(|i| format!("{i:08}{}", "s".repeat(200)))
        .collect();
    tool_result(&conn, "a", &serde_json::to_string(&leaves).unwrap());
    let job = create_job(&conn, &config("roomy"), 0).unwrap();
    let started = std::time::Instant::now();
    let records = drain(&conn, &job.job_id);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(records.len(), 1);
    let cut: Vec<String> =
        serde_json::from_str(records[0].payload["text"].as_str().unwrap()).unwrap();
    assert_eq!(cut.len(), leaves.len());
    assert!(cut.iter().any(|leaf| leaf.ends_with(MARKER)));
}

#[test]
fn a_top_level_json_string_stays_valid_json_when_cut() {
    let conn = db();
    let quoted = serde_json::to_string(&"q".repeat(10_000)).unwrap();
    conn.execute("INSERT INTO tool_calls(source,session_id,tool_use_id,name,args_json) VALUES('claude','a','tool','Edit',?1)", params![quoted]).unwrap();
    let mut calls = small("string");
    calls.selection.kinds = vec!["tool_call".into()];
    let job = create_job(&conn, &calls, 0).unwrap();
    let records = drain(&conn, &job.job_id);
    let call = records.iter().find(|r| r.kind == "tool_call").unwrap();
    let args = call.payload["args_json"].as_str().unwrap();
    assert!(args.len() < quoted.len());
    let cut: String = serde_json::from_str(args).unwrap();
    assert!(cut.ends_with(MARKER));
}

#[test]
fn a_record_just_over_the_limit_is_truncated_not_suppressed() {
    let drained = |len: usize| {
        let conn = db();
        tool_result(&conn, "a", &"x".repeat(len));
        let job = create_job(&conn, &small("edge"), 0).unwrap();
        let records = drain(&conn, &job.job_id);
        (
            records,
            status(&conn, &job.job_id).unwrap().suppressed_records,
        )
    };
    // The longest text that fits untouched, found by bisection.
    let (mut fits, mut over) = (1, 4096);
    while over - fits > 1 {
        let mid = (fits + over) / 2;
        let (records, _) = drained(mid);
        let whole = records.len() == 1
            && !records[0].payload["text"]
                .as_str()
                .unwrap()
                .ends_with(MARKER);
        if whole {
            fits = mid
        } else {
            over = mid
        }
    }
    for extra in [1, 10, MARKER.len() - 1, MARKER.len()] {
        let (records, suppressed) = drained(fits + extra);
        assert_eq!(suppressed, 0, "{extra} bytes over");
        assert_eq!(records.len(), 1, "{extra} bytes over");
        assert!(records[0].payload["text"]
            .as_str()
            .unwrap()
            .ends_with(MARKER));
    }
}

#[test]
fn an_oversized_payload_json_is_cut_and_its_description_kept() {
    let conn = db();
    let document = serde_json::json!({"summary": "s".repeat(10_000)}).to_string();
    conn.execute("INSERT INTO session_markers(source,session_id,marker_uid,kind,subkind,ts_ms,text,payload_json) VALUES('claude','a','m0','compaction_boundary','compacted',1,'compacted',?1)", params![document]).unwrap();
    let mut markers = small("markers");
    markers.selection.kinds = vec!["session_marker".into()];
    let job = create_job(&conn, &markers, 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 0);
    let marker = records.iter().find(|r| r.kind == "session_marker").unwrap();
    let cut: serde_json::Value =
        serde_json::from_str(marker.payload["payload_json"].as_str().unwrap()).unwrap();
    assert!(cut["summary"].as_str().unwrap().ends_with(MARKER));
    assert_eq!(marker.payload["text"], "compacted");
}

#[test]
fn an_escaped_leaf_that_saves_enough_leaves_the_others_whole() {
    let conn = db();
    // One leaf of quotes costs four batch bytes per character once escaped
    // twice; cutting it alone frees far more than a plain leaf of equal length.
    let document = serde_json::json!({
        "escaped": "\"".repeat(1_500),
        "plain": "p".repeat(1_400),
    })
    .to_string();
    tool_result(&conn, "a", &document);
    let job = create_job(&conn, &small("escaped"), 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    let cut: serde_json::Value =
        serde_json::from_str(records[0].payload["text"].as_str().unwrap()).unwrap();
    assert!(cut["escaped"].as_str().unwrap().ends_with(MARKER));
    assert_eq!(cut["plain"], "p".repeat(1_400));
}

#[test]
fn escaped_text_is_cut_by_what_it_costs_in_the_batch() {
    let conn = db();
    // A quote costs two batch bytes; cutting by decoded bytes would drop
    // about twice as many as the batch needs.
    tool_result(&conn, "a", &"\"".repeat(3_000));
    let job = create_job(&conn, &small("quotes"), 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    let text = records[0].payload["text"].as_str().unwrap();
    let kept = text.strip_suffix(MARKER).unwrap().len();
    // About 1,350 fit beside the batch's other bytes; decoded-byte cutting
    // kept none.
    assert!(kept > 1_000, "kept {kept} of 3000");
}

#[test]
fn a_pretty_printed_document_is_compacted_before_anything_is_cut() {
    let conn = db();
    let value = serde_json::json!(vec!["ab"; 400]);
    let pretty = serde_json::to_string_pretty(&serde_json::json!({ "items": value })).unwrap();
    let pretty = pretty.replace("\n", &format!("\n{}", " ".repeat(20)));
    conn.execute("INSERT INTO session_markers(source,session_id,marker_uid,kind,subkind,ts_ms,text,payload_json) VALUES('claude','a','m0','compaction_boundary','compacted',1,'compacted',?1)", params![pretty]).unwrap();
    let mut markers = small("pretty");
    markers.selection.kinds = vec!["session_marker".into()];
    let job = create_job(&conn, &markers, 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 0);
    let marker = records.iter().find(|r| r.kind == "session_marker").unwrap();
    let kept = marker.payload["payload_json"].as_str().unwrap();
    assert!(!kept.ends_with(MARKER));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(kept).unwrap(),
        serde_json::json!({ "items": value })
    );
}

#[test]
fn an_oversized_out_of_range_json_number_is_shortened_as_valid_json_text() {
    let conn = db();
    conn.execute("INSERT INTO tool_calls(source,session_id,tool_use_id,name,args_json) VALUES('claude','a','tool','Edit',?1)", params!["1".repeat(10_000)]).unwrap();
    let mut calls = small("number");
    calls.selection.kinds = vec!["tool_call".into()];
    let job = create_job(&conn, &calls, 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    let args = records[0].payload["args_json"].as_str().unwrap();
    let retained: String = serde_json::from_str(args).unwrap();
    assert!(retained.ends_with(MARKER));
    assert!(retained.len() < 10_000);
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 0);
}

#[test]
fn malformed_json_expansion_is_sized_then_shortened_before_batching() {
    let conn = db();
    let malformed = "\\".repeat(600 * 1024);
    conn.execute(
        "INSERT INTO tool_calls(source,session_id,tool_use_id,name,args_json) VALUES('claude','a','tool','Edit',?1)",
        [&malformed],
    )
    .unwrap();
    let mut calls = config("malformed-expansion");
    calls.selection.kinds = vec!["tool_call".into()];
    let job = create_job(&conn, &calls, 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    let args = records[0].payload["args_json"].as_str().unwrap();
    let retained: String = serde_json::from_str(args).unwrap();
    assert!(retained.ends_with(MARKER));
    assert!(retained.len() < malformed.len());
    assert!(serde_json::to_vec(&records[0]).unwrap().len() < calls.limits.max_batch_bytes);
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 0);
}

#[test]
fn a_compacted_payload_is_marked_truncated() {
    let conn = db();
    let pretty = serde_json::to_string_pretty(&serde_json::json!({ "items": vec!["ab"; 250] }))
        .unwrap()
        .replace('\n', &format!("\n{}", " ".repeat(20)));
    tool_result(&conn, "a", &pretty);
    let job = create_job(&conn, &small("compacted"), 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    let text = records[0].payload["text"].as_str().unwrap();
    assert!(text.len() < pretty.len() && !text.ends_with(MARKER));
    assert_eq!(records[0].payload["payload_truncated"], 1);
}

#[test]
fn short_leaves_of_quotes_are_cut_by_what_they_cost() {
    let conn = db();
    // Each leaf is shorter than the marker decoded, but its quotes cost about
    // four batch bytes each, so replacing it with the marker saves room.
    let leaves = vec!["\"".repeat(45); 30];
    tool_result(&conn, "a", &serde_json::to_string(&leaves).unwrap());
    let job = create_job(&conn, &small("quote-leaves"), 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 0);
    assert_eq!(records.len(), 1);
    let cut: Vec<String> =
        serde_json::from_str(records[0].payload["text"].as_str().unwrap()).unwrap();
    assert_eq!(cut.len(), leaves.len());
    assert!(cut.iter().any(|leaf| leaf.ends_with(MARKER)));
}

#[test]
fn the_column_that_costs_most_in_the_batch_is_cut_first() {
    let conn = db();
    // The quotes are shorter decoded but cost twice as much in the batch;
    // cutting them alone fits, so the longer plain cwd stays whole.
    let quotes = "\"".repeat(1_500);
    let cwd = "c".repeat(1_600);
    conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text,cwd,payload_bytes) VALUES ('claude','a','a-tool',42,'user','tool_result',?1,?2,?3)", params![quotes, cwd, quotes.len() as i64]).unwrap();
    let job = create_job(&conn, &small("costly"), 0).unwrap();
    let records = drain(&conn, &job.job_id);
    assert_eq!(records.len(), 1);
    assert!(records[0].payload["text"]
        .as_str()
        .unwrap()
        .ends_with(MARKER));
    assert_eq!(records[0].payload["cwd"], cwd);
}

#[test]
fn a_document_of_quotes_just_over_the_limit_is_cut_not_suppressed() {
    let drained = |len: usize| {
        let conn = db();
        tool_result(
            &conn,
            "a",
            &serde_json::to_string(&["\"".repeat(len)]).unwrap(),
        );
        let job = create_job(&conn, &small("quote-edge"), 0).unwrap();
        let records = drain(&conn, &job.job_id);
        (
            records,
            status(&conn, &job.job_id).unwrap().suppressed_records,
        )
    };
    // The longest leaf of quotes that fits whole, found by bisection.
    let (mut fits, mut over) = (1, 2048);
    while over - fits > 1 {
        let mid = (fits + over) / 2;
        let (records, _) = drained(mid);
        let whole = records.len() == 1
            && !records[0].payload["text"]
                .as_str()
                .unwrap()
                .contains(MARKER.trim());
        if whole {
            fits = mid
        } else {
            over = mid
        }
    }
    for extra in 1..=3 {
        let (records, suppressed) = drained(fits + extra);
        assert_eq!(suppressed, 0, "{extra} quotes over");
        assert_eq!(records.len(), 1, "{extra} quotes over");
    }
}

#[test]
fn a_record_that_cannot_fit_is_suppressed_and_the_job_moves_on() {
    let conn = db();
    event(&conn, "a", &"x".repeat(2000));
    let mut tiny = config("tiny");
    tiny.limits.max_batch_bytes = 512;
    let job = create_job(&conn, &tiny, 0).unwrap();
    assert!(drain(&conn, &job.job_id).is_empty());
    let state = status(&conn, &job.job_id).unwrap();
    assert!(state.bootstrap_complete);
    assert_eq!(state.suppressed_records, 1);
    assert!(state.journal_cursor > 0);
}

#[test]
fn a_selected_session_backfill_truncates_an_oversized_record() {
    let conn = db();
    tool_result(&conn, "a", &"x".repeat(10_000));
    event(&conn, "a", "after");
    let root = create_session_job(&conn, &small("scoped"), 0).unwrap();
    let a = SessionIdentity {
        source: "claude".into(),
        session_id: "a".into(),
    };
    assert!(set_job_session(&conn, &root.job_id, &a, true).unwrap());
    let records = drain(&conn, &root.job_id);
    assert_eq!(records.len(), 2);
    assert!(records
        .iter()
        .any(|record| record.payload["payload_truncated"] == 1
            && record.payload["text"].as_str().unwrap().ends_with(MARKER)));
    assert!(records
        .iter()
        .any(|record| record.payload["text"] == "after"));
}

#[test]
fn a_job_stored_or_sent_with_a_retired_kind_still_drains() {
    let conn = db();
    event(&conn, "a", "before");
    let mut cfg = config("retired");
    cfg.selection.kinds = SUPPORTED_KINDS.iter().map(|s| (*s).into()).collect();
    let job = create_job(&conn, &cfg, 0).unwrap();
    // A job an older build stored still lists the kind it no longer drains.
    conn.execute(
        "UPDATE delivery_jobs SET config_json=json_insert(config_json,'$.selection.kinds[#]','trajectory') WHERE id=?",
        [&job.job_id],
    )
    .unwrap();
    let stored: String = conn
        .query_row(
            "SELECT config_json FROM delivery_jobs WHERE id=?",
            [&job.job_id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(stored.contains("\"trajectory\""));
    assert!(status(&conn, &job.job_id)
        .unwrap()
        .config
        .selection
        .kinds
        .iter()
        .all(|kind| kind != "trajectory"));
    // The probe's own setup, without the kind, is the same generation.
    assert_eq!(create_job(&conn, &cfg, 1).unwrap().job_id, job.job_id);
    // So is a configuration that still sends it.
    let mut sent = cfg.clone();
    sent.selection.kinds.push("trajectory".into());
    assert_eq!(create_job(&conn, &sent, 1).unwrap().job_id, job.job_id);
    let records = drain(&conn, &job.job_id);
    assert!(records
        .iter()
        .any(|record| record.kind == "session_event" && record.payload["text"] == "before"));
    // A configuration sending only retired kinds selects nothing.
    let mut only = config("only-retired");
    only.selection.kinds = RETIRED_KINDS.iter().map(|s| (*s).into()).collect();
    assert!(create_job(&conn, &only, 2).is_err());
    // Any other unknown kind is still refused.
    let mut unknown = config("unknown");
    unknown.selection.kinds = vec!["session_event".into(), "not_a_kind".into()];
    assert!(create_job(&conn, &unknown, 2).is_err());
}

#[test]
fn all_supported_evidence_kinds_preserve_raw_fields_and_canonical_keys() {
    let conn = db();
    conn.execute_batch(r#"
INSERT INTO history(source,session_id,timestamp_ms,prompt,git_branch) VALUES('codex','s',1,'prompt','main');
INSERT INTO sessions(source,session_id,first_prompt) VALUES('codex','s','prompt');
INSERT INTO session_presences(source,session_id,location,raw_locator) VALUES('codex','s','remote','fixture://s');
INSERT INTO tool_calls(source,session_id,tool_use_id,name,args_json) VALUES('codex','s','tool','Edit','{ "raw": 1 }');
INSERT INTO file_edits(source,session_id,tool_use_id,file_path,tool_name,structured_patch_json) VALUES('codex','s','tool','src/lib.rs','Edit','[ 1 ]');
INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('codex','s','rel','child','delegation','observed','fixture',1,1);
INSERT INTO session_commit_links(source,session_id,repo,commit_sha,match_method,confidence,created_at_ms) VALUES('codex','s','repo','sha','cwd',1,1);
INSERT INTO session_observations(source,session_id,location,connector_id,connector_instance,raw_locator,source_stamp,updated_ms) VALUES('codex','s','remote','fixture','account','fixture://s','v1',1);
INSERT INTO observation_evidence(source,session_id,location,connector_id,connector_instance,evidence_uid,payload_json) VALUES('codex','s','remote','fixture','account','record','{ "events": [] }');
INSERT INTO session_markers(source,session_id,marker_uid,kind,subkind,ts_ms,text,payload_json) VALUES('codex','s','c0','compaction_boundary','compacted',1,'compacted','{ "checkpoint": 1 }');
"#).unwrap();
    event(&conn, "a", "event");
    let mut cfg = config("all");
    cfg.selection.kinds = SUPPORTED_KINDS.iter().map(|s| (*s).into()).collect();
    let job = create_job(&conn, &cfg, 0).unwrap();
    let records = drain(&conn, &job.job_id);
    let by_kind: HashMap<_, _> = records.iter().map(|r| (r.kind.as_str(), r)).collect();
    assert_eq!(by_kind.len(), SUPPORTED_KINDS.len());
    assert_eq!(by_kind["tool_call"].payload["args_json"], "{ \"raw\": 1 }");
    assert_eq!(
        by_kind["file_edit"].payload["structured_patch_json"],
        "[ 1 ]"
    );
    assert_eq!(by_kind["presence"].payload["location"], "remote");
    assert_eq!(
        by_kind["source_observation"].payload["connector_instance"],
        "account"
    );
    assert_eq!(
        by_kind["observation_evidence"].payload["payload_json"],
        r#"{ "events": [] }"#
    );
    assert_eq!(by_kind["history"].payload["git_branch"], "main");
    assert_eq!(
        by_kind["session_marker"].payload["kind"],
        "compaction_boundary"
    );
    assert_eq!(
        by_kind["session_marker"].payload["payload_json"],
        r#"{ "checkpoint": 1 }"#
    );
    assert!(records
        .iter()
        .all(|r| r.schema_version == 1 && !r.origin_id.is_empty()));
}

#[test]
fn dispatch_requires_immutable_payload_and_rechecks_privacy_after_mapping() {
    let conn = db();
    event(&conn, "a", "private");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let claim = claim(&conn, &job.job_id, 0).unwrap();
    assert!(validate_dispatch(&conn, &claim.lease, &|| 1).is_err());
    prepare(&conn, &claim, 1);
    assert!(validate_dispatch(&conn, &claim.lease, &|| 2).is_ok());
    set_session_excluded(
        &conn,
        &SessionIdentity {
            source: "claude".into(),
            session_id: "a".into(),
        },
        true,
    )
    .unwrap();
    assert!(validate_dispatch(&conn, &claim.lease, &|| 3).is_err());
    assert!(claim_batch(&conn, &job.job_id, "other", 1000, &|| 3)
        .unwrap()
        .is_none());
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 1);
    assert_eq!(status(&conn, &job.job_id).unwrap().acknowledged_records, 0);
}

#[test]
fn excluded_child_relationship_metadata_is_not_exported_through_its_parent() {
    let conn = db();
    conn.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('codex','parent','edge','secret','delegation','observed','fixture',1,1)",[]).unwrap();
    let mut cfg = config("one");
    cfg.selection.kinds = vec!["relationship".into()];
    let job = create_job(&conn, &cfg, 0).unwrap();
    let old = claim(&conn, &job.job_id, 0).unwrap();
    prepare(&conn, &old, 0);
    set_session_excluded(
        &conn,
        &SessionIdentity {
            source: "codex".into(),
            session_id: "secret".into(),
        },
        true,
    )
    .unwrap();
    assert!(claim_batch(&conn, &job.job_id, "next", 1000, &|| 1)
        .unwrap()
        .is_none());
    assert_eq!(status(&conn, &job.job_id).unwrap().suppressed_records, 1);
}

/// A destination body is retained as a JSON envelope, where escaping can
/// double it. The configured prepared limit bounds those stored bytes, so a
/// body that fills it exactly is stored, and one that would overflow it is
/// refused with the row untouched.
#[test]
fn the_prepared_limit_bounds_the_stored_envelope_not_the_body() {
    let conn = db();
    let mut cfg = config("one");
    cfg.limits.max_prepared_bytes = 4_096;
    let job = create_job(&conn, &cfg, 0).unwrap();
    event(&conn, "a", "retained revision");
    let claim = claim(&conn, &job.job_id, 1).unwrap();

    // A body of quote characters: each is two bytes once escaped.
    let stored_len = |body: &str| {
        serde_json::to_string(&PreparedPayload {
            mapping_version: "1".into(),
            content_type: "application/json".into(),
            body: body.into(),
            sha256: "0".repeat(64),
            prepared_by: None,
        })
        .unwrap()
        .len()
    };
    let envelope = stored_len("");
    let room = 4_096 - envelope;
    let exact = "\"".repeat(room / 2) + &"a".repeat(room % 2);
    assert_eq!(stored_len(&exact), 4_096);
    assert!(
        exact.len() < 4_096,
        "the body itself is well under the limit"
    );

    let oversized = "\"".repeat(4_096);
    let refused = store_prepared_payload(
        &conn,
        &claim.lease,
        "1",
        "application/json",
        &oversized,
        &|| 1,
    )
    .unwrap_err();
    assert!(refused
        .to_string()
        .contains("prepared delivery payload too large"));
    assert!(conn
        .query_row("SELECT prepared IS NULL FROM delivery_batches", [], |r| {
            r.get::<_, bool>(0)
        })
        .unwrap());

    store_prepared_payload(&conn, &claim.lease, "1", "application/json", &exact, &|| 1).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT length(CAST(prepared AS BLOB)) FROM delivery_batches",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        4_096
    );
    acknowledge(&conn, &claim.lease, &ack(&claim), &|| 2).unwrap();
}

#[test]
fn terminal_receipts_can_be_compacted_without_accepting_a_stale_ack() {
    let conn = db();
    event(&conn, "a", "first");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let claim = claim(&conn, &job.job_id, 0).unwrap();
    prepare(&conn, &claim, 0);
    acknowledge(&conn, &claim.lease, &ack(&claim), &|| 1).unwrap();
    assert_eq!(compact_receipts(&conn, 1).unwrap(), 1);
    assert!(acknowledge(&conn, &claim.lease, &ack(&claim), &|| 2).is_err());
    assert_eq!(status(&conn, &job.job_id).unwrap().acknowledged_records, 1);
}

#[test]
fn cancelling_the_last_job_releases_all_upload_state() {
    let conn = db();
    for id in ["a", "b", "c", "d"] {
        event(&conn, id, "evidence");
    }
    let whole = create_job(&conn, &config("whole"), 0).unwrap();
    let sent = claim(&conn, &whole.job_id, 0).unwrap();
    prepare(&conn, &sent, 0);
    acknowledge(&conn, &sent.lease, &ack(&sent), &|| 1).unwrap();
    // A second batch is left queued, and a scoped job holds members.
    let queued = claim(&conn, &whole.job_id, 2).unwrap();
    prepare(&conn, &queued, 2);
    let scoped = create_session_job(&conn, &config("scoped"), 0).unwrap();
    let member = SessionIdentity {
        source: "claude".into(),
        session_id: "a".into(),
    };
    set_job_session(&conn, &scoped.job_id, &member, true).unwrap();
    let withheld = SessionIdentity {
        source: "claude".into(),
        session_id: "b".into(),
    };
    set_session_excluded(&conn, &withheld, true).unwrap();
    let origin = |conn: &Connection| -> (String, i64) {
        conn.query_row(
            "SELECT origin_id,max_revision FROM delivery_origin",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    };
    let before = origin(&conn);
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    };

    // Any live job keeps everything.
    cancel_job(&conn, &whole.job_id).unwrap();
    assert!(!release_decommissioned(&conn).unwrap());
    assert!(count("delivery_batches") > 0);
    assert_eq!(count("delivery_session_members"), 1);

    cancel_job(&conn, &scoped.job_id).unwrap();
    assert!(release_decommissioned(&conn).unwrap());
    for table in [
        "delivery_batches",
        "delivery_session_members",
        "delivery_session_jobs",
    ] {
        assert_eq!(count(table), 0, "{table}");
    }
    assert_eq!(status(&conn, &whole.job_id).unwrap().pending_records, 0);
    // A reconnect still numbers above everything this origin sent, and the
    // person's exclusions stand.
    assert_eq!(origin(&conn), before);
    assert!(!is_shareable(&conn, &withheld).unwrap());
    assert_eq!(status(&conn, &whole.job_id).unwrap().state, "cancelled");
}

#[test]
fn permanent_failure_cannot_resume_through_pause_without_explicit_retry() {
    for failure in [
        DeliveryFailure::AuthenticationRequired,
        DeliveryFailure::PermissionDenied,
        DeliveryFailure::InvalidPayload,
        DeliveryFailure::UnsupportedEvidence,
        DeliveryFailure::MappingVersionMismatch,
    ] {
        let conn = db();
        event(&conn, "one", "pending");
        let job = create_job(&conn, &config("blocked"), 0).unwrap();
        let first = claim(&conn, &job.job_id, 0).unwrap();
        prepare(&conn, &first, 0);
        let expected_prepared = validate_dispatch(&conn, &first.lease, &|| 0).unwrap();
        let blocked = record_failure(&conn, &first.lease, failure, None, &|| 1).unwrap();
        assert_eq!(blocked.state, "blocked");
        assert!(pause_job(&conn, &job.job_id).is_err());
        assert!(resume_job(&conn, &job.job_id).is_err());
        assert_eq!(status(&conn, &job.job_id).unwrap(), blocked);
        assert!(claim_batch(&conn, &job.job_id, "other", 1000, &|| 100_000)
            .unwrap()
            .is_none());
        // A paused row written by the previous buggy version also remains blocked.
        conn.execute(
            "UPDATE delivery_jobs SET state='paused' WHERE id=?",
            [&job.job_id],
        )
        .unwrap();
        assert!(resume_job(&conn, &job.job_id).is_err());
        assert!(pause_job(&conn, &job.job_id).is_err());
        assert_eq!(status(&conn, &job.job_id).unwrap().failure, blocked.failure);
        retry_job(&conn, &job.job_id).unwrap();
        let next = claim_batch(&conn, &job.job_id, "other", 1000, &|| 2)
            .unwrap()
            .unwrap();
        assert_eq!(next.batch, first.batch);
        assert_eq!(next.prepared, Some(expected_prepared));
        acknowledge(&conn, &next.lease, &ack(&next), &|| 3).unwrap();
    }
}

#[test]
fn resume_checks_state_after_acquiring_the_write_transaction() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static WAITING_FOR_WRITE: AtomicBool = AtomicBool::new(false);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("resume.db");
    let writer = open_db(&path).unwrap();
    let reader = open_db(&path).unwrap();
    let job = create_job(&writer, &config("race"), 0).unwrap();
    pause_job(&writer, &job.job_id).unwrap();
    reader
        .busy_handler(Some(|_| {
            WAITING_FOR_WRITE.store(true, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(1));
            true
        }))
        .unwrap();
    let tx = writer.unchecked_transaction().unwrap();
    tx.execute(
        "UPDATE delivery_jobs SET state='blocked',failure='permission_denied' WHERE id=?",
        [&job.job_id],
    )
    .unwrap();
    let id = job.job_id.clone();
    let resumer = std::thread::spawn(move || resume_job(&reader, &id));
    let started = std::time::Instant::now();
    while !WAITING_FOR_WRITE.load(Ordering::SeqCst) {
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        std::thread::yield_now();
    }
    tx.commit().unwrap();
    assert!(resumer.join().unwrap().is_err());
    assert_eq!(status(&writer, &job.job_id).unwrap().state, "blocked");
}

#[test]
fn observation_revisions_keep_instance_identity_and_deletions() {
    let conn = db();
    let mut cfg = config("observations");
    cfg.selection.kinds = vec!["source_observation".into(), "observation_evidence".into()];
    let job = create_job(&conn, &cfg, 0).unwrap();
    drain(&conn, &job.job_id);
    for account in ["first", "second"] {
        conn.execute("INSERT INTO session_observations(source,session_id,location,connector_id,connector_instance,raw_locator,updated_ms) VALUES('claude','session','remote','fixture',?,'fixture://session',1)",[account]).unwrap();
        conn.execute("INSERT INTO observation_evidence(source,session_id,location,connector_id,connector_instance,evidence_uid,payload_json) VALUES('claude','session','remote','fixture',?,'record','{\"v\":1}')",[account]).unwrap();
    }
    conn.execute(
        "UPDATE session_observations SET source_stamp='v2' WHERE connector_instance='first'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE observation_evidence SET payload_json='{\"v\":2}' WHERE connector_instance='first'",
        [],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM observation_evidence WHERE connector_instance='second'",
        [],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM session_observations WHERE connector_instance='second'",
        [],
    )
    .unwrap();
    // The feed carries each record's current state: the first instance's
    // latest revision, and the second's deletion.
    let rows = drain(&conn, &job.job_id);
    assert_eq!(rows.len(), 4);
    for kind in ["source_observation", "observation_evidence"] {
        let rows = rows
            .iter()
            .filter(|row| row.kind == kind)
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 2, "{kind}");
        assert_ne!(rows[0].record_id, rows[1].record_id);
        let live = rows.iter().find(|row| row.operation == "upsert").unwrap();
        assert_eq!(live.payload["connector_instance"], "first");
        let gone = rows.iter().find(|row| row.operation == "delete").unwrap();
        assert!(gone.payload.is_null());
    }
    let observation = rows
        .iter()
        .find(|row| row.kind == "source_observation" && row.operation == "upsert")
        .unwrap();
    assert_eq!(observation.payload["source_stamp"], "v2");
}

#[test]
fn clearing_consumed_exclusions_requires_a_new_baseline_generation() {
    for queued in [false, true] {
        let conn = db();
        let session = SessionIdentity {
            source: "claude".into(),
            session_id: "private".into(),
        };
        event(&conn, "private", "historical baseline");
        let cfg = config("one");
        let job = create_job(&conn, &cfg, 0).unwrap();
        if queued {
            assert!(claim(&conn, &job.job_id, 0).is_some());
        }
        set_session_excluded(&conn, &session, true).unwrap();
        assert!(drain(&conn, &job.job_id).is_empty());
        let error = set_session_excluded(&conn, &session, false).unwrap_err();
        assert!(error.to_string().contains("DELIVERY_GENERATION_REQUIRED"));
        assert!(drain(&conn, &job.job_id).is_empty());
        cancel_job(&conn, &job.job_id).unwrap();
        set_session_excluded(&conn, &session, false).unwrap();
        let next = create_job(&conn, &cfg, 1).unwrap();
        let records = drain(&conn, &next.job_id);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].payload["text"], "historical baseline");
        assert!(next.generation > job.generation);
    }
}

#[test]
fn clearing_exclusions_does_not_require_cancelling_unaffected_jobs() {
    let conn = db();
    let session = SessionIdentity {
        source: "claude".into(),
        session_id: "private".into(),
    };
    set_session_excluded(&conn, &session, true).unwrap();
    let mut cfg = config("other");
    cfg.selection.all_sources = false;
    cfg.selection.sessions = vec![SessionIdentity {
        source: "claude".into(),
        session_id: "other".into(),
    }];
    create_job(&conn, &cfg, 0).unwrap();
    let mut explicit = config("permanent");
    explicit.selection.excluded_sessions.push(session.clone());
    create_job(&conn, &explicit, 0).unwrap();
    set_session_excluded(&conn, &session, false).unwrap();
    set_session_excluded(&conn, &session, false).unwrap();
}

#[test]
fn scoped_membership_backfills_only_changes_and_preserves_pending_batches() {
    let conn = db();
    event(&conn, "a", "before");
    event(&conn, "b", "second");
    let root = create_session_job(&conn, &config("scoped"), 0).unwrap();
    let a = SessionIdentity {
        source: "claude".into(),
        session_id: "a".into(),
    };
    let b = SessionIdentity {
        source: "claude".into(),
        session_id: "b".into(),
    };
    assert!(claim(&conn, &root.job_id, 1).is_none());
    assert!(set_job_session(&conn, &root.job_id, &a, true).unwrap());
    assert!(!set_job_session(&conn, &root.job_id, &a, true).unwrap());
    let first = claim(&conn, &root.job_id, 2).unwrap();
    prepare(&conn, &first, 2);
    assert!(set_job_session(&conn, &root.job_id, &b, true).unwrap());
    assert!(validate_dispatch(&conn, &first.lease, &|| 3).is_err());
    let reclaimed = claim_batch(&conn, &root.job_id, "worker", 1000, &|| 3)
        .unwrap()
        .unwrap();
    assert_eq!(first.batch.batch_id, reclaimed.batch.batch_id);
    acknowledge(&conn, &reclaimed.lease, &ack(&reclaimed), &|| 4).unwrap();
    let records = drain(&conn, &root.job_id);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].session_id.as_deref(), Some("b"));
    assert!(set_job_session(&conn, &root.job_id, &a, false).unwrap());
    event(&conn, "private", "must not upload");
    assert!(set_job_session(&conn, &root.job_id, &a, true).unwrap());
    let records = drain(&conn, &root.job_id);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].session_id.as_deref(), Some("a"));
}

#[test]
fn scoped_backfill_has_constant_unrelated_record_visits() {
    for count in [100, 10_000, 50_000] {
        for early in [true, false] {
            let conn = db();
            if early {
                event(&conn, "selected", "fixed");
            }
            conn.execute_batch("BEGIN").unwrap();
            for n in 0..count {
                event(&conn, &format!("unrelated-{n}"), "unrelated");
            }
            if !early {
                event(&conn, "selected", "fixed");
            }
            conn.execute_batch("COMMIT").unwrap();
            let root = create_session_job(&conn, &config("scale"), 0).unwrap();
            let steps = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counter = steps.clone();
            conn.progress_handler(
                1,
                Some(move || {
                    counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    false
                }),
            );
            let started = std::time::Instant::now();
            let before = conn.total_changes();
            include_job_session(
                &conn,
                &root.job_id,
                &SessionIdentity {
                    source: "claude".into(),
                    session_id: "selected".into(),
                },
            )
            .unwrap();
            let select_ms = started.elapsed().as_secs_f64() * 1000.;
            let writes = conn.total_changes() - before;
            let selected_steps = steps.swap(0, std::sync::atomic::Ordering::Relaxed);
            let started = std::time::Instant::now();
            let prep = prepare_batch(&conn, &root.job_id, 1).unwrap();
            let prepare_ms = started.elapsed().as_secs_f64() * 1000.;
            let prepare_steps = steps.load(std::sync::atomic::Ordering::Relaxed);
            conn.progress_handler(0, None::<fn() -> bool>);
            eprintln!("scoped count={count} early={early} select_ms={select_ms:.3} prepare_ms={prepare_ms:.3} writes={writes} select_vm={selected_steps} prepare_vm={prepare_steps} visits={}",prep.scanned_records);
            assert_eq!(prep.scanned_records, 1);
            assert!(prep.batch_id.is_some());
            assert!(selected_steps < 10_000);
            assert!(prepare_steps < 15_000);
            assert!(writes < 30);
            let claimed = claim_batch(&conn, &root.job_id, "fake", 1000, &|| 2)
                .unwrap()
                .unwrap();
            prepare(&conn, &claimed, 2);
            validate_dispatch(&conn, &claimed.lease, &|| 2).unwrap();
            acknowledge(&conn, &claimed.lease, &ack(&claimed), &|| 3).unwrap();
            assert_eq!(status(&conn, &root.job_id).unwrap().acknowledged_records, 1);
        }
    }
}

#[test]
fn scoped_adoption_preserves_ownership_preimage_and_global_exclusion_guard() {
    let conn = db();
    event(&conn, "outside", "private");
    let old = create_job(&conn, &config("adopt-owner"), 0).unwrap();
    conn.execute(
        "UPDATE session_events SET session_id='a' WHERE session_id='outside'",
        [],
    )
    .unwrap();
    let a = SessionIdentity {
        source: "claude".into(),
        session_id: "a".into(),
    };
    adopt_session_job(&conn, &old.job_id, std::slice::from_ref(&a)).unwrap();
    let records = drain(&conn, &old.job_id);
    assert_eq!(records.len(), 1);
    assert!(records[0].revision > old.journal_cursor);
    set_session_excluded(&conn, &a, true).unwrap();
    assert!(set_session_excluded(&conn, &a, false).is_err());
    set_job_session(&conn, &old.job_id, &a, false).unwrap();
    let other = create_job(&conn, &config("other-account"), 2).unwrap();
    assert!(set_session_excluded(&conn, &a, false).is_err());
    cancel_job(&conn, &other.job_id).unwrap();
    set_session_excluded(&conn, &a, false).unwrap();
    set_job_session(&conn, &old.job_id, &a, true).unwrap();
    assert_eq!(drain(&conn, &old.job_id).len(), 1);
}

#[test]
fn scoped_members_are_not_config_json_or_active_job_count_and_unrelated_sessions_stay_private() {
    let conn = db();
    event(&conn, "outside", "before");
    let root = create_session_job(&conn, &config("many"), 0).unwrap();
    for n in 0..400 {
        set_job_session(
            &conn,
            &root.job_id,
            &SessionIdentity {
                source: "claude".into(),
                session_id: format!("{n}-{}", "x".repeat(180)),
            },
            true,
        )
        .unwrap();
    }
    assert_eq!(job_sessions(&conn, &root.job_id).unwrap().len(), 400);
    assert!(
        serde_json::to_vec(&status(&conn, &root.job_id).unwrap().config)
            .unwrap()
            .len()
            < 1000
    );
    conn.execute(
        "UPDATE session_events SET text='after' WHERE session_id='outside'",
        [],
    )
    .unwrap();
    assert!(drain(&conn, &root.job_id).is_empty());
    assert_eq!(list_jobs(&conn).unwrap().len(), 1);
}

#[test]
fn ready_members_make_round_robin_progress_across_single_record_batches() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let conn = open_db(&path).unwrap();
    let mut cfg = config("fair");
    cfg.limits.max_batch_records = 1;
    let job = create_session_job(&conn, &cfg, 0).unwrap();
    for id in ["a", "b"] {
        for n in 0..5 {
            conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?,?,1,'user','text','synthetic')", params![id,n.to_string()]).unwrap();
        }
        set_job_session(
            &conn,
            &job.job_id,
            &SessionIdentity {
                source: "claude".into(),
                session_id: id.into(),
            },
            true,
        )
        .unwrap();
    }
    let first = claim(&conn, &job.job_id, 1).unwrap();
    let first_session = first.batch.records[0].session_id.clone();
    prepare(&conn, &first, 1);
    acknowledge(&conn, &first.lease, &ack(&first), &|| 2).unwrap();
    drop(conn);
    // Progress persists across worker restarts while the first member is backlogged.
    let conn = open_db(&path).unwrap();
    let second = claim(&conn, &job.job_id, 3).unwrap();
    assert_ne!(second.batch.records[0].session_id, first_session);
    prepare(&conn, &second, 3);
    acknowledge(&conn, &second.lease, &ack(&second), &|| 4).unwrap();
    let third = claim(&conn, &job.job_id, 5).unwrap();
    assert_eq!(third.batch.records[0].session_id, first_session);
}

#[test]
fn scoped_include_preserves_other_jobs_and_rolls_back_a_failed_guard() {
    for existing in [false, true] {
        for scoped_other in [false, true] {
            let conn = db();
            let parent = SessionIdentity {
                source: "claude".into(),
                session_id: "parent".into(),
            };
            let child = SessionIdentity {
                source: "claude".into(),
                session_id: "child".into(),
            };
            let mut cfg = config("target");
            let root = create_session_job(&conn, &cfg, 0).unwrap();
            set_job_session(&conn, &root.job_id, &parent, true).unwrap();
            if existing {
                set_job_session(&conn, &root.job_id, &child, true).unwrap();
            }
            set_session_excluded(&conn, &child, true).unwrap();
            cfg.instance_id = "other".into();
            let other = if scoped_other {
                // Another session job that already selects the child is
                // affected by lifting its exclusion.
                let other = create_session_job(&conn, &cfg, 0).unwrap();
                set_job_session(&conn, &other.job_id, &child, true).unwrap();
                other
            } else {
                create_job(&conn, &cfg, 0).unwrap()
            };
            let before = serde_json::to_value(status(&conn, &root.job_id).unwrap()).unwrap();
            let members = job_sessions(&conn, &root.job_id).unwrap();
            let error = include_job_session(&conn, &root.job_id, &child).unwrap_err();
            assert!(error.to_string().contains("DELIVERY_GENERATION_REQUIRED"));
            assert_eq!(
                serde_json::to_value(status(&conn, &root.job_id).unwrap()).unwrap(),
                before
            );
            assert_eq!(job_sessions(&conn, &root.job_id).unwrap(), members);
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM delivery_exclusions WHERE session_id='child'",
                    [],
                    |r| r.get::<_, usize>(0)
                )
                .unwrap(),
                1
            );
            cancel_job(&conn, &other.job_id).unwrap();
            assert!(include_job_session(&conn, &root.job_id, &child).unwrap());
        }
    }
}

/// An update is a new revision of the same record, and a delete is its
/// tombstone: one record identity, rising revisions.
#[test]
fn updates_and_deletes_are_new_revisions_of_one_record() {
    let conn = db();
    event(&conn, "a", "first");
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let first = drain(&conn, &job.job_id);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].operation, "upsert");
    assert_eq!(first[0].payload["text"], "first");
    assert!(drain(&conn, &job.job_id).is_empty());

    conn.execute(
        "UPDATE session_events SET text='second' WHERE session_id='a'",
        [],
    )
    .unwrap();
    let second = drain(&conn, &job.job_id);
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].record_id, first[0].record_id);
    assert!(second[0].revision > first[0].revision);
    assert_eq!(second[0].payload["text"], "second");

    conn.execute("DELETE FROM session_events WHERE session_id='a'", [])
        .unwrap();
    let deleted = drain(&conn, &job.job_id);
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].operation, "delete");
    assert_eq!(deleted[0].record_id, first[0].record_id);
    assert!(deleted[0].revision > second[0].revision);
    assert!(deleted[0].payload.is_null());
    let status = status(&conn, &job.job_id).unwrap();
    assert!(status.bootstrap_complete);
    assert_eq!(status.unqueued_changes, 0);
}

/// An additive store migration changes the canonical payload of every
/// existing row without writing that row. A fresh delivery generation must
/// not replay the changed payload at the revision the receiver already holds.
#[test]
fn an_exported_column_change_replays_rows_above_every_delivered_revision() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let conn = open_db(&path).unwrap();
    event(&conn, "a", "before migration");
    let config = config("schema-change");
    let first_job = create_job(&conn, &config, 0).unwrap();
    let delivered = drain(&conn, &first_job.job_id);
    assert_eq!(delivered.len(), 1);
    let highest_delivered = delivered[0].revision;
    let delivered_id = delivered[0].record_id.clone();

    let stored_revision: i64 = conn
        .query_row(
            "SELECT revision FROM session_events WHERE event_uid='a'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // Stands in for an additive ai-hist migration such as `location`: the
    // stored row now exports different JSON, but ALTER TABLE does not advance
    // the row's feed revision.
    conn.execute_batch(
        "ALTER TABLE session_events ADD COLUMN export_shape_probe TEXT NOT NULL DEFAULT 'local';",
    )
    .unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT revision FROM session_events WHERE event_uid='a'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap(),
        stored_revision
    );
    drop(conn);

    // A collector reopen runs ai-hist's schema reconciliation. Recreating the
    // job forces the same history through a fresh bootstrap, as an install
    // rebuild or a new delivery generation would.
    let conn = open_db(&path).unwrap();
    cancel_job(&conn, &first_job.job_id).unwrap();
    let replacement = create_job(&conn, &config, 1).unwrap();
    let replayed = drain(&conn, &replacement.job_id);
    assert_eq!(replayed.len(), 1);
    assert_eq!(replayed[0].record_id, delivered_id);
    assert_eq!(replayed[0].payload["export_shape_probe"], "local");
    assert!(
        replayed
            .iter()
            .all(|record| record.revision > highest_delivered),
        "a changed payload must never reuse a delivered revision: delivered={delivered:?}, replayed={replayed:?}"
    );
}

/// A member's history before it was added arrives through its backfill, and
/// what it writes afterwards through the feed: every record exactly once, and
/// nothing of a session that is not a member.
#[test]
fn a_member_is_backfilled_once_and_then_followed() {
    let conn = db();
    event(&conn, "member", "before");
    event(&conn, "outsider", "before");
    let root = create_session_job(&conn, &config("scoped"), 0).unwrap();
    let member = SessionIdentity {
        source: "claude".into(),
        session_id: "member".into(),
    };
    set_job_session(&conn, &root.job_id, &member, true).unwrap();
    assert!(!status(&conn, &root.job_id).unwrap().bootstrap_complete);
    conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','member','later',43,'user','text','after')",[]).unwrap();
    event(&conn, "outsider-later", "after");
    let records = drain(&conn, &root.job_id);
    let mut texts: Vec<_> = records
        .iter()
        .map(|record| {
            assert_eq!(record.session_id.as_deref(), Some("member"));
            record.payload["text"].as_str().unwrap().to_owned()
        })
        .collect();
    texts.sort();
    assert_eq!(texts, ["after", "before"]);
    let ids: HashSet<_> = records.iter().map(|record| &record.record_id).collect();
    assert_eq!(ids.len(), 2);
    assert!(status(&conn, &root.job_id).unwrap().bootstrap_complete);
    assert!(drain(&conn, &root.job_id).is_empty());

    // Removing the member fences a pending batch; including it again
    // backfills it from the start.
    conn.execute(
        "UPDATE session_events SET text='edited' WHERE event_uid='later'",
        [],
    )
    .unwrap();
    let pending = claim(&conn, &root.job_id, 1_000).unwrap();
    set_job_session(&conn, &root.job_id, &member, false).unwrap();
    assert!(validate_dispatch(&conn, &pending.lease, &|| 1_000).is_err());
    assert!(
        claim_batch(&conn, &root.job_id, "after-removal", 1000, &|| 3_000)
            .unwrap()
            .is_none()
    );
    set_job_session(&conn, &root.job_id, &member, true).unwrap();
    let again = drain(&conn, &root.job_id);
    let mut texts: Vec<_> = again
        .iter()
        .map(|record| record.payload["text"].as_str().unwrap().to_owned())
        .collect();
    texts.sort();
    assert_eq!(texts, ["before", "edited"]);
}

/// A store as a release that still fed trajectories left it -- the table, and
/// the kind in the stored export fingerprints -- opened writable by this one,
/// which retires the kind under a new epoch.
fn retire_trajectories(path: &std::path::Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE trajectories (id TEXT PRIMARY KEY, decisions_json TEXT NOT NULL DEFAULT '[]')",
    )
    .unwrap();
    let stored: String = conn
        .query_row(
            "SELECT export_schema_digest FROM change_feed_store",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut digests: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&stored).unwrap();
    digests.insert("trajectory".into(), "trajectory-schema".into());
    conn.execute(
        "UPDATE change_feed_store SET export_schema_digest=?",
        [serde_json::to_string(&digests).unwrap()],
    )
    .unwrap();
    drop(conn);
    ai_hist::SessionStore::open(ai_hist::StoreOptions::default().db_path(path.to_path_buf()))
        .unwrap();
}

/// Retiring a kind gives the feed a new epoch without renumbering it, so the
/// origin adopts the epoch and a job over every kind resumes where it was:
/// nothing it sent is sent again, and its records keep their numbering.
#[test]
fn a_retired_kind_keeps_every_job_where_it_was() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let conn = open_db(&path).unwrap();
    for n in 0..5 {
        event(&conn, &format!("s{n}"), "before");
    }
    let mut every = config("every");
    every.selection.kinds = SUPPORTED_KINDS.iter().map(|kind| (*kind).into()).collect();
    let job = create_job(&conn, &every, 0).unwrap();
    let before = drain(&conn, &job.job_id);
    assert_eq!(
        before
            .iter()
            .filter(|record| record.kind == "session_event")
            .count(),
        5
    );
    let origin = || {
        conn.query_row(
            "SELECT feed_epoch,revision_base FROM delivery_origin",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .unwrap()
    };
    let (epoch, base) = origin();

    retire_trajectories(&path);
    event(&conn, "after", "after");
    let after = drain(&conn, &job.job_id);

    let texts: Vec<_> = after
        .iter()
        .filter(|record| record.kind == "session_event")
        .map(|record| record.payload["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["after"], "only what changed since: {after:?}");
    let (adopted, kept) = origin();
    assert_ne!(adopted, epoch, "the origin adopted the new epoch");
    assert_eq!(kept, base, "nothing was renumbered");
}

/// A replaced database counts its feed from zero again. Its records must
/// still supersede what the receiver holds, so the base moves above every
/// revision this origin has issued and the job starts over.
#[test]
fn a_replaced_database_numbers_its_records_above_everything_issued() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let conn = open_db(&path).unwrap();
    for n in 0..5 {
        event(&conn, &format!("s{n}"), "original");
    }
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let before = drain(&conn, &job.job_id);
    let highest = before.iter().map(|record| record.revision).max().unwrap();
    let origin = conn
        .query_row("SELECT origin_id FROM delivery_origin", [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
    // A batch prepared from the old database and never sent.
    event(&conn, "unsent", "original");
    let stale = prepare_batch(&conn, &job.job_id, 1)
        .unwrap()
        .batch_id
        .unwrap();
    // Replace the evidence and its feed, keeping the upload tables.
    conn.execute_batch(
        "DELETE FROM session_events; DELETE FROM evidence_tombstones;
         UPDATE observation_clock SET version=0;
         UPDATE change_feed_store SET epoch=epoch+2;",
    )
    .unwrap();
    event(&conn, "s0", "replacement");
    let after = drain(&conn, &job.job_id);
    // The old database's unsent batch went with its positions.
    assert!(after
        .iter()
        .all(|record| record.payload["text"] != "original"));
    let settled: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM delivery_batches WHERE id=?",
            [&stale],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(settled, 0);
    assert_eq!(after.len(), 1);
    let replacement = &after[0];
    assert_eq!(replacement.payload["text"], "replacement");
    assert!(replacement.revision > highest);
    assert_eq!(replacement.origin_id, origin);
}

/// A session job's positions belong to the epoch they were read in. A
/// database replaced before the job's first preparation restarts it, so the
/// replacement's history still arrives.
#[test]
fn a_database_replaced_before_the_first_preparation_restarts_session_jobs() {
    let conn = db();
    for n in 0..20 {
        event(&conn, &format!("filler-{n}"), "original");
    }
    let root = create_session_job(&conn, &config("scoped"), 0).unwrap();
    set_job_session(
        &conn,
        &root.job_id,
        &SessionIdentity {
            source: "claude".into(),
            session_id: "member".into(),
        },
        true,
    )
    .unwrap();
    conn.execute_batch(
        "DELETE FROM session_events; DELETE FROM evidence_tombstones;
         UPDATE observation_clock SET version=0;
         UPDATE change_feed_store SET epoch=epoch+2;",
    )
    .unwrap();
    event(&conn, "member", "replacement");
    let records = drain(&conn, &root.job_id);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].payload["text"], "replacement");
}

fn relationship(conn: &Connection, parent: &str, uid: &str, child: Option<&str>) {
    conn.execute(
        "INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('claude',?1,?2,?3,'delegation','observed','fixture',1,1)",
        params![parent, uid, child],
    )
    .unwrap();
}
fn uids(records: &[HistoryExportRecord]) -> Vec<String> {
    let mut uids: Vec<_> = records
        .iter()
        .filter(|record| record.kind == "relationship")
        .map(|record| {
            record.payload["relationship_uid"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    uids.sort();
    uids
}

/// A relationship discloses both its sessions, so it leaves only when its
/// parent is shared and its child is shared too or unlinked.
#[test]
fn an_edge_to_an_unshared_child_is_withheld() {
    let conn = db();
    relationship(&conn, "parent", "to-private", Some("private"));
    relationship(&conn, "parent", "to-shared", Some("shared"));
    relationship(&conn, "parent", "unlinked", None);
    set_session_excluded(
        &conn,
        &SessionIdentity {
            source: "claude".into(),
            session_id: "private".into(),
        },
        true,
    )
    .unwrap();
    let mut cfg = config("all");
    cfg.selection.kinds = vec!["relationship".into()];
    let job = create_job(&conn, &cfg, 0).unwrap();
    assert_eq!(uids(&drain(&conn, &job.job_id)), ["to-shared", "unlinked"]);

    // Under a session job, the child must be a member too.
    let mut cfg = config("scoped");
    cfg.selection.kinds = vec!["relationship".into()];
    let root = create_session_job(&conn, &cfg, 0).unwrap();
    let member = |session: &str| SessionIdentity {
        source: "claude".into(),
        session_id: session.into(),
    };
    set_job_session(&conn, &root.job_id, &member("parent"), true).unwrap();
    assert_eq!(uids(&drain(&conn, &root.job_id)), ["unlinked"]);

    // A dispatch recheck withholds an edge whose child stopped being shared
    // after it was prepared.
    relationship(&conn, "parent", "later", Some("shared"));
    set_job_session(&conn, &root.job_id, &member("shared"), true).unwrap();
    let claim = claim(&conn, &root.job_id, 1).unwrap();
    assert!(uids(&claim.batch.records).contains(&"later".to_owned()));
    prepare(&conn, &claim, 1);
    set_session_excluded(&conn, &member("shared"), true).unwrap();
    assert!(validate_dispatch(&conn, &claim.lease, &|| 1).is_err());
}

/// An edge whose two sessions are shared by two different session jobs leaves
/// through neither: each job holds one endpoint, and a relationship needs both
/// in the same job. Nothing is retained for it, since the feed is read in place.
#[test]
fn an_edge_whose_endpoints_belong_to_different_jobs_is_sent_by_neither() {
    let conn = db();
    relationship(&conn, "parent", "split", Some("child"));
    let member = |session: &str| SessionIdentity {
        source: "claude".into(),
        session_id: session.into(),
    };
    let scoped = |instance: &str| {
        let mut cfg = config(instance);
        cfg.selection.kinds = vec!["relationship".into()];
        create_session_job(&conn, &cfg, 0).unwrap().job_id
    };
    let parent_job = scoped("parent-job");
    let child_job = scoped("child-job");
    set_job_session(&conn, &parent_job, &member("parent"), true).unwrap();
    set_job_session(&conn, &child_job, &member("child"), true).unwrap();
    assert!(uids(&drain(&conn, &parent_job)).is_empty());
    assert!(uids(&drain(&conn, &child_job)).is_empty());
    assert!(status(&conn, &parent_job).unwrap().bootstrap_complete);
    assert!(status(&conn, &child_job).unwrap().bootstrap_complete);

    // A later revision of the split edge still leaves through neither.
    conn.execute(
        "UPDATE session_relationships SET updated_ms=2 WHERE relationship_uid='split'",
        [],
    )
    .unwrap();
    assert!(uids(&drain(&conn, &parent_job)).is_empty());
    assert!(uids(&drain(&conn, &child_job)).is_empty());

    // Once one job holds both endpoints, it sends the edge.
    set_job_session(&conn, &parent_job, &member("child"), true).unwrap();
    assert_eq!(uids(&drain(&conn, &parent_job)), ["split"]);
    assert!(uids(&drain(&conn, &child_job)).is_empty());
}

/// A legacy job whose selection names sources or sessions, rather than every
/// source, sends only the identities that selection names.
#[test]
fn an_explicit_selection_sends_only_what_it_names() {
    let conn = db();
    event(&conn, "chosen", "chosen event");
    event(&conn, "other", "other event");
    conn.execute(
        "INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('codex','elsewhere','elsewhere',42,'user','text','codex event')",
        [],
    )
    .unwrap();
    let sessions_of = |records: &[HistoryExportRecord]| {
        let mut sessions: Vec<_> = records
            .iter()
            .map(|record| {
                format!(
                    "{}:{}",
                    record.source,
                    record.session_id.as_deref().unwrap_or_default()
                )
            })
            .collect();
        sessions.sort();
        sessions
    };

    let mut cfg = config("by-session");
    cfg.selection.all_sources = false;
    cfg.selection.sessions = vec![SessionIdentity {
        source: "claude".into(),
        session_id: "chosen".into(),
    }];
    let job = create_job(&conn, &cfg, 0).unwrap();
    assert_eq!(sessions_of(&drain(&conn, &job.job_id)), ["claude:chosen"]);

    let mut cfg = config("by-source");
    cfg.selection.all_sources = false;
    cfg.selection.sources = vec!["codex".into()];
    let job = create_job(&conn, &cfg, 0).unwrap();
    assert_eq!(sessions_of(&drain(&conn, &job.job_id)), ["codex:elsewhere"]);
}

/// An edge is stored under its parent, so a child included after its parent
/// was backfilled receives the edges naming it through its own backfill.
#[test]
fn a_child_included_later_receives_its_incoming_edges_once() {
    let conn = db();
    relationship(&conn, "parent", "edge", Some("child"));
    event(&conn, "child", "child event");
    let mut cfg = config("scoped");
    cfg.selection.kinds = vec!["relationship".into(), "session_event".into()];
    let root = create_session_job(&conn, &cfg, 0).unwrap();
    let member = |session: &str| SessionIdentity {
        source: "claude".into(),
        session_id: session.into(),
    };
    set_job_session(&conn, &root.job_id, &member("parent"), true).unwrap();
    assert!(uids(&drain(&conn, &root.job_id)).is_empty());
    set_job_session(&conn, &root.job_id, &member("child"), true).unwrap();
    let records = drain(&conn, &root.job_id);
    assert_eq!(uids(&records), ["edge"]);
    assert!(records.iter().any(|record| record.kind == "session_event"));
    assert!(drain(&conn, &root.job_id).is_empty());
    assert!(status(&conn, &root.job_id).unwrap().bootstrap_complete);

    // Both sessions included together: the edge is reached by both
    // backfills and sent once.
    let root = create_session_job(
        &conn,
        &{
            let mut cfg = cfg.clone();
            cfg.instance_id = "together".into();
            cfg
        },
        0,
    )
    .unwrap();
    set_job_session(&conn, &root.job_id, &member("parent"), true).unwrap();
    set_job_session(&conn, &root.job_id, &member("child"), true).unwrap();
    assert_eq!(uids(&drain(&conn, &root.job_id)), ["edge"]);
}

/// A prompt logged with no session cannot be excluded, so only a job that
/// shares everything sends it.
#[test]
fn prompts_with_no_session_leave_only_when_everything_is_shared() {
    let conn = db();
    conn.execute(
        "INSERT INTO history(source,session_id,prompt,prompt_hash,timestamp_ms) VALUES ('claude',NULL,'no session','h1',1),('claude','named','in a session','h2',2)",
        [],
    )
    .unwrap();
    let mut cfg = config("new");
    cfg.selection.kinds = vec!["history".into()];
    let new = create_job(&conn, &cfg, 0).unwrap();
    let records = drain(&conn, &new.job_id);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].session_id.as_deref(), Some("named"));
    cfg.instance_id = "all".into();
    cfg.selection.sessionless = true;
    let all = create_job(&conn, &cfg, 0).unwrap();
    assert_eq!(drain(&conn, &all.job_id).len(), 2);
}

/// A job's unqueued changes are the ones it will send: writes of kinds it
/// does not select, and of sessions that are not its members, leave it
/// caught up.
#[test]
fn unqueued_changes_count_only_what_the_job_will_send() {
    let conn = db();
    event(&conn, "member", "before");
    let all = create_job(&conn, &config("all"), 0).unwrap();
    let root = create_session_job(&conn, &config("scoped"), 0).unwrap();
    set_job_session(
        &conn,
        &root.job_id,
        &SessionIdentity {
            source: "claude".into(),
            session_id: "member".into(),
        },
        true,
    )
    .unwrap();
    drain(&conn, &all.job_id);
    drain(&conn, &root.job_id);
    for job in [&all.job_id, &root.job_id] {
        assert_eq!(status(&conn, job).unwrap().unqueued_changes, 0);
    }

    conn.execute("INSERT INTO tool_calls(source,session_id,tool_use_id,name,args_json) VALUES ('claude','member','tool','Edit','{}')", []).unwrap();
    event(&conn, "outsider", "unrelated");
    assert_eq!(status(&conn, &all.job_id).unwrap().unqueued_changes, 1);
    assert_eq!(status(&conn, &root.job_id).unwrap().unqueued_changes, 0);

    conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','member','later',43,'user','text','after')", []).unwrap();
    assert_eq!(status(&conn, &all.job_id).unwrap().unqueued_changes, 2);
    assert_eq!(status(&conn, &root.job_id).unwrap().unqueued_changes, 1);
}

/// Changes beyond what status examines are still work the job has to do: a
/// member's change behind a long run of other sessions' changes keeps the
/// job from reading as caught up.
#[test]
fn member_work_behind_many_unrelated_changes_is_still_unqueued() {
    let conn = db();
    let root = create_session_job(&conn, &config("scoped"), 0).unwrap();
    set_job_session(
        &conn,
        &root.job_id,
        &SessionIdentity {
            source: "claude".into(),
            session_id: "member".into(),
        },
        true,
    )
    .unwrap();
    drain(&conn, &root.job_id);
    for n in 0..300 {
        event(&conn, &format!("outsider-{n}"), "unrelated");
    }
    event(&conn, "member", "later");
    assert!(status(&conn, &root.job_id).unwrap().unqueued_changes > 0);
    let records = drain(&conn, &root.job_id);
    assert_eq!(records.len(), 1);
    assert_eq!(status(&conn, &root.job_id).unwrap().unqueued_changes, 0);
}

/// A generation an older build created with its default limits (1 MiB
/// batches, 2 MiB retained) runs with the current defaults, and setup's
/// identical-configuration check still adopts it; its stored row is left as
/// written for that older build.
#[test]
fn a_generation_with_the_former_default_limits_runs_with_the_current_ones() {
    let conn = db();
    let current = DeliveryJobConfig {
        limits: DeliveryLimits::default(),
        ..config("one")
    };
    let job = create_job(&conn, &current, 0).unwrap();
    conn.execute(
        "UPDATE delivery_jobs SET config_json=json_set(config_json,'$.limits.max_batch_bytes',1048576,'$.limits.max_prepared_bytes',2097152) WHERE id=?",
        [&job.job_id],
    )
    .unwrap();
    assert_eq!(status(&conn, &job.job_id).unwrap().config, current);
    assert_eq!(create_job(&conn, &current, 1).unwrap().job_id, job.job_id);
    let stored: String = conn
        .query_row(
            "SELECT json_extract(config_json,'$.limits.max_batch_bytes') FROM delivery_jobs WHERE id=?",
            [&job.job_id],
            |row| row.get::<_, i64>(0).map(|n| n.to_string()),
        )
        .unwrap();
    assert_eq!(stored, "1048576");
}

/// A progress read skips the feed scan only while the bootstrap is still
/// running, when the count cannot change what a report shows; afterwards it
/// counts unqueued changes exactly as `status` does.
#[test]
fn progress_status_scans_the_feed_only_once_the_bootstrap_is_done() {
    let conn = db();
    for n in 0..6 {
        event(&conn, &format!("session-{n}"), "text");
    }
    let job = create_job(&conn, &config("one"), 0).unwrap();
    let full = status(&conn, &job.job_id).unwrap();
    let progress = progress_status(&conn, &job.job_id).unwrap();
    assert!(!full.bootstrap_complete && full.unqueued_changes > 0);
    assert_eq!(progress.unqueued_changes, 0);
    assert_eq!(
        DeliveryStatus {
            unqueued_changes: full.unqueued_changes,
            ..progress
        },
        full
    );
    while !prepare_batch(&conn, &job.job_id, 0)
        .unwrap()
        .bootstrap_complete
    {
        let claim = claim_batch(&conn, &job.job_id, "worker", 1_000, &|| 0)
            .unwrap()
            .unwrap();
        store_prepared_payload(&conn, &claim.lease, "1", "application/json", "{}", &|| 0).unwrap();
        acknowledge(&conn, &claim.lease, &ack(&claim), &|| 0).unwrap();
    }
    event(&conn, "after", "text");
    let full = status(&conn, &job.job_id).unwrap();
    assert!(full.bootstrap_complete && full.unqueued_changes > 0);
    assert_eq!(progress_status(&conn, &job.job_id).unwrap(), full);
}
