//! An install whose uploads ran on the export journal rebuilds onto the change
//! feed the first time its collector opens it.

use agent_relay_probe::delivery::*;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

const ORIGIN: &str = "0123456789abcdef0123456789abcdef";
/// The journal's AUTOINCREMENT high-water mark: above every row it still
/// holds, because compaction removed the rest.
const ISSUED: i64 = 5_000;

/// A job configuration as the export-journal probe stored it: that build's
/// kind list for the sharing mode, and no `sessionless` field.
fn stored_config(instance: &str, kinds: &[&str]) -> String {
    serde_json::json!({
        "destination_id": "relayhistory",
        "instance_id": instance,
        "account_id": "account",
        "mapping_version": "1",
        "selection": {
            "all_sources": true, "sources": [], "sessions": [],
            "kinds": kinds, "excluded_sessions": [],
        },
        "limits": DeliveryLimits::default(),
    })
    .to_string()
}
/// The configuration the probe creates for a sharing mode now: every kind,
/// and prompts with no session only when everything is shared.
fn current_config(instance: &str, share_all: bool) -> DeliveryJobConfig {
    DeliveryJobConfig {
        destination_id: "relayhistory".into(),
        instance_id: instance.into(),
        account_id: "account".into(),
        mapping_version: "1".into(),
        selection: ExportSelection {
            all_sources: true,
            kinds: SUPPORTED_KINDS.iter().map(|kind| (*kind).into()).collect(),
            sessionless: share_all,
            ..ExportSelection::default()
        },
        limits: DeliveryLimits::default(),
    }
}
fn event(conn: &Connection, session: &str, uid: &str) {
    conn.execute(
        "INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?2,1,'user','text','synthetic')",
        params![session, uid],
    )
    .unwrap();
}
fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// A store in the journal's schema: a blocked all-sources job with a
/// pending batch and an acknowledged receipt, a paused selected-sessions job
/// with two members and a pending batch, one excluded session, and evidence
/// the journal captured and then compacted away.
fn legacy_store() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let mut options = ai_hist::StoreOptions::default();
    options.db_path = Some(path.clone());
    ai_hist::SessionStore::open(options).unwrap();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(include_str!("fixtures/export-journal-schema.sql"))
        .unwrap();
    conn.execute(
        "INSERT INTO delivery_state(singleton,origin_id,retained_bytes,max_retained_bytes) VALUES (1,?,0,268435456)",
        [ORIGIN],
    )
    .unwrap();
    conn.execute_batch(&format!(
        "INSERT INTO history_compaction VALUES (1,0);
         INSERT INTO delivery_jobs(id,destination_id,instance_id,account_id,generation,config_json,state,created_ms,cutoff,journal_cursor,bootstrap_kind,bootstrap_rowid,bootstrap_done,acknowledged_cursor,failure)
           VALUES ('all','relayhistory','all','account',1,'{all}','blocked',1,10,4900,12,0,1,4800,'invalid_payload'),
                  ('selected','relayhistory','selected','account',1,'{selected}','paused',1,20,4950,0,0,1,4900,NULL);
         INSERT INTO delivery_session_jobs(job_id,last_member) VALUES ('selected','m1');
         INSERT INTO delivery_session_members(id,job_id,source,session_id,cutoff,cursor,bootstrap_kind,bootstrap_rowid,bootstrap_done,ready)
           VALUES ('m1','selected','claude','member-one',20,4950,12,0,1,1),
                  ('m2','selected','claude','member-two',30,4950,3,7,0,0);
         INSERT INTO history_subscriptions(id,source,session_id,journal_cursor,bootstrap_kind,bootstrap_rowid,bootstrap_done)
           VALUES ('all',NULL,NULL,4900,12,0,1),('m1','claude','member-one',4950,12,0,1),('m2','claude','member-two',4950,3,7,0);
         INSERT INTO delivery_exclusions(source,session_id) VALUES ('claude','private');
         INSERT INTO delivery_batches(id,job_id,state,payload,records,bytes,journal_end,created_ms,accepted_records)
           VALUES ('sent','all','acknowledged',NULL,3,0,4800,1,3),
                  ('stuck','all','blocked','{{}}',1,2,4900,2,0),
                  ('waiting','selected','pending','{{}}',1,2,4950,3,0);",
        all = stored_config("all", &["history", "session_event", "session"]),
        selected = stored_config("selected", &["session_event", "session"]),
    ))
    .unwrap();
    // Evidence captured by the journal before the upgrade.
    for (session, uid) in [
        ("member-one", "a"),
        ("member-two", "b"),
        ("outsider", "c"),
        ("private", "d"),
    ] {
        event(&conn, session, uid);
    }
    // The journal withheld the excluded session.
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM delivery_journal WHERE kind='session_event'"
        ),
        3
    );
    conn.execute_batch("DELETE FROM delivery_journal;").unwrap();
    conn.execute(
        "UPDATE sqlite_sequence SET seq=? WHERE name='delivery_journal'",
        [ISSUED],
    )
    .unwrap();
    (directory, path)
}

fn drain(conn: &Connection, job_id: &str) -> Vec<HistoryExportRecord> {
    let mut records = Vec::new();
    for step in 0..1000 {
        let prepared = prepare_batch(conn, job_id, step).unwrap();
        if prepared.batch_id.is_none() {
            if prepared.bootstrap_complete && prepared.scanned_records == 0 {
                return records;
            }
            continue;
        }
        let claim = claim_batch(conn, job_id, "rebuild", 60_000, &|| step)
            .unwrap()
            .unwrap();
        store_prepared_payload(conn, &claim.lease, "1", "application/json", "{}", &|| step)
            .unwrap();
        acknowledge(
            conn,
            &claim.lease,
            &DeliveryAcknowledgment {
                batch_id: claim.batch.batch_id.clone(),
                accepted_revision_ids: claim
                    .batch
                    .records
                    .iter()
                    .map(|record| record.revision_id.clone())
                    .collect(),
                unsupported_revision_ids: vec![],
                suppressed_revision_ids: vec![],
                rejected_revision_ids: vec![],
                isolation_frontier: vec![],
                acceptance_level: AcceptanceLevel::Durable,
            },
            &|| step,
        )
        .unwrap();
        records.extend(claim.batch.records);
    }
    panic!("drain did not converge")
}

fn schema(path: &Path) -> Vec<String> {
    Connection::open(path)
        .unwrap()
        .prepare("SELECT type||':'||name FROM sqlite_master ORDER BY type,name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn a_journal_install_rebuilds_onto_the_feed_keeping_its_origin_jobs_and_consent() {
    let (_directory, path) = legacy_store();
    let conn = open_db(&path).unwrap();

    // The journal and everything that fed it are gone.
    let triggers: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'delivery%' OR tbl_name IN ('delivery_batches','delivery_journal','delivery_shadow','history_export_pages'))")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(triggers.is_empty(), "{triggers:?}");
    for table in [
        "delivery_journal",
        "delivery_shadow",
        "delivery_bootstrap_bounds",
        "history_subscriptions",
        "history_exports",
        "history_export_pages",
        "history_compaction",
    ] {
        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM sqlite_master WHERE name='{table}'")
            ),
            0,
            "{table}"
        );
    }
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name LIKE 'delivery_identity_%'"),
        0
    );

    // The origin keeps its identity and numbers above everything it issued.
    let (origin, base): (String, i64) = conn
        .query_row(
            "SELECT origin_id,revision_base FROM delivery_origin",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(origin, ORIGIN);
    assert_eq!(base, ISSUED);

    // Each job's stored selection moves to every kind, so the probe's current
    // configuration for its sharing mode is the same generation, not a
    // changed one.
    assert_eq!(
        status(&conn, "all").unwrap().config,
        current_config("all", true)
    );
    assert_eq!(
        status(&conn, "selected").unwrap().config,
        current_config("selected", false)
    );
    assert_eq!(
        create_job(&conn, &current_config("all", true), 1)
            .unwrap()
            .job_id,
        "all"
    );
    assert_eq!(
        create_session_job(&conn, &current_config("selected", false), 1)
            .unwrap()
            .job_id,
        "selected"
    );

    // Jobs keep their state, members and exclusions; unsent batches are
    // dropped and receipts kept.
    let all = status(&conn, "all").unwrap();
    assert_eq!(all.state, "blocked");
    assert_eq!(all.failure.as_deref(), Some("invalid_payload"));
    assert_eq!(all.skipped_records, 0);
    assert_eq!(all.journal_cursor, 0);
    assert!(!all.bootstrap_complete);
    let selected = status(&conn, "selected").unwrap();
    assert_eq!(selected.state, "paused");
    assert!(!selected.bootstrap_complete);
    let members = job_sessions(&conn, "selected").unwrap();
    assert_eq!(
        members
            .iter()
            .map(|m| m.session_id.as_str())
            .collect::<Vec<_>>(),
        ["member-one", "member-two"]
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM delivery_session_members WHERE cursor<>0 OR bootstrap_done<>0"
        ),
        0
    );
    assert!(!is_shareable(
        &conn,
        &SessionIdentity {
            source: "claude".into(),
            session_id: "private".into()
        }
    )
    .unwrap());
    let batches: Vec<String> = conn
        .prepare("SELECT id FROM delivery_batches ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(batches, ["sent"]);

    // New evidence is ingested with no journal to write.
    event(&conn, "outsider", "after-upgrade");

    // The first records are numbered above every revision the journal issued,
    // for the job's whole history, withholding the excluded session.
    retry_job(&conn, "all").unwrap();
    let records = drain(&conn, "all");
    assert!(records.iter().all(|record| record.revision > ISSUED));
    assert!(records.iter().all(|record| record.origin_id == ORIGIN));
    let sessions: std::collections::BTreeSet<_> = records
        .iter()
        .filter(|record| record.kind == "session_event")
        .filter_map(|record| record.session_id.as_deref())
        .collect();
    assert_eq!(
        sessions.into_iter().collect::<Vec<_>>(),
        ["member-one", "member-two", "outsider"]
    );
    assert!(records
        .iter()
        .any(|record| record.payload["event_uid"] == "after-upgrade"));

    // The selected job backfills exactly its members once resumed.
    resume_job(&conn, "selected").unwrap();
    let records = drain(&conn, "selected");
    assert!(records.iter().all(|record| record.revision > ISSUED));
    let mut uids: Vec<_> = records
        .iter()
        .filter(|record| record.kind == "session_event")
        .map(|record| record.payload["event_uid"].as_str().unwrap().to_owned())
        .collect();
    uids.sort();
    assert_eq!(uids, ["a", "b"]);
}

#[test]
fn rebuilding_twice_changes_nothing() {
    let (_directory, path) = legacy_store();
    drop(open_db(&path).unwrap());
    let rebuilt = schema(&path);
    let origin: (String, i64, i64) = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT origin_id,revision_base,max_revision FROM delivery_origin",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    drop(open_db(&path).unwrap());
    assert_eq!(schema(&path), rebuilt);
    let again: (String, i64, i64) = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT origin_id,revision_base,max_revision FROM delivery_origin",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(again, origin);
}

/// `path` as ai-hist leaves it once its own upgrade has run: without the
/// `trajectories` table (and, with it, the journal's triggers and index on
/// it). Until then a read-only or control open finds the store stale and
/// waits for the collector, as [`a_store_ai_hist_has_not_upgraded_waits_for_the_collector`]
/// shows.
fn retire_trajectories(path: &Path) {
    Connection::open(path)
        .unwrap()
        .execute_batch("DROP TABLE trajectories")
        .unwrap();
}

/// A store ai-hist has not upgraded yet answers a control open, and a read
/// of its sessions, with the upgrade pending: only the collector's writable
/// open migrates it. Upload status still answers from the probe's own tables.
#[test]
fn a_store_ai_hist_has_not_upgraded_waits_for_the_collector() {
    let (_directory, path) = legacy_store();
    let error = open_control_db(&path).expect_err("the control open waits");
    assert!(is_upgrade_pending(&error), "{error:#}");
    let conn = open_db_readonly(&path).unwrap();
    assert_eq!(status(&conn, "all").unwrap().state, "blocked");
    let error = session_identities(&conn).expect_err("the session read waits");
    assert!(is_upgrade_pending(&error), "{error:#}");
}

/// Only the collector lock's holder rebuilds: a control action beside an
/// older collector leaves the journal it is still writing in place.
#[test]
fn a_control_open_never_rebuilds() {
    let (_directory, path) = legacy_store();
    retire_trajectories(&path);
    let conn = open_control_db(&path).unwrap();
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM sqlite_master WHERE name='delivery_journal'"
        ),
        1
    );
    pause_job(&conn, "selected").unwrap();
    event(&conn, "outsider", "beside-an-older-collector");
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM delivery_journal WHERE kind='session_event'"
        ),
        1
    );
}

/// Status and the identity read answer from a journal install before its
/// collector has rebuilt it, as the desktop's first status call after an
/// upgrade does.
#[test]
fn status_reads_a_journal_install_before_its_rebuild() {
    let (_directory, path) = legacy_store();
    retire_trajectories(&path);
    let conn = open_db_readonly(&path).unwrap();
    let all = status(&conn, "all").unwrap();
    assert_eq!(all.state, "blocked");
    assert_eq!(all.journal_cursor, 4_900);
    assert!(!status(&conn, "selected").unwrap().bootstrap_complete);
    let identities = session_identities(&conn).unwrap();
    assert_eq!(identities.len(), 4);
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM sqlite_master WHERE name='delivery_journal'"
        ),
        1
    );
}
