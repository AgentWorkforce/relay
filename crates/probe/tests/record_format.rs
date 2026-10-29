//! A record built from the change feed names and carries a row exactly as the
//! export journal did, so the receiver replaces what it already holds rather
//! than keeping a second copy: `record_id` is the SHA-256 of SQLite's
//! `json_array(kind, key columns...)` text, and `payload` is SQLite's
//! `json_object` of every stored column but `revision`.

use agent_relay_probe::delivery::*;
use rusqlite::{params, types::Value as Sql, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};

const TEXTS: &[&str] = &[
    "plain",
    "quote \" backslash \\ slash / tab\t newline\n cr\r",
    "control \u{1} \u{8} \u{c} \u{1f} del \u{7f}",
    "unicode é 漢字 😀 \u{2028} \u{2029} \u{feff}",
    "{\"json\": [1, 2.5, null, true]}",
    "",
];

fn sql(value: &Value) -> Sql {
    match value {
        Value::Null => Sql::Null,
        Value::String(text) => Sql::Text(text.clone()),
        Value::Number(number) => number
            .as_i64()
            .map(Sql::Integer)
            .unwrap_or_else(|| Sql::Real(number.as_f64().unwrap())),
        other => panic!("unexpected key value {other}"),
    }
}

/// The table, and its key columns, the journal keyed a kind by.
fn table(kind: &str) -> (&'static str, &'static [&'static str]) {
    match kind {
        "history" => ("history", &["source", "timestamp_ms", "prompt"]),
        "session_event" => ("session_events", &["source", "session_id", "event_uid"]),
        "session" => ("sessions", &["source", "session_id"]),
        other => panic!("unexpected kind {other}"),
    }
}

#[test]
fn feed_records_keep_the_journal_record_id_and_payload() {
    let directory = tempfile::tempdir().unwrap();
    let conn = open_db(&directory.path().join("history.db")).unwrap();
    for (n, text) in TEXTS.iter().enumerate() {
        let session = format!("session-{n}");
        conn.execute(
            "INSERT INTO sessions(source,session_id,cwd,first_prompt,last_activity_ms,models_json) VALUES('claude',?1,'/tmp/x',?2,?3,'[\"m\"]')",
            params![session, text, 1_700_000_000_000i64 + n as i64],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text,token_json,payload_bytes) VALUES('claude',?1,?2,?3,'user','text',?4,'{\"in\":1}',?5)",
            params![session, format!("uid-{n}-{text}"), 42 + n as i64, text, n as i64],
        )
        .unwrap();
        // Every other prompt names no session.
        conn.execute(
            "INSERT INTO history(source,session_id,project,prompt,prompt_hash,timestamp_ms) VALUES('claude',?1,'/p',?2,?3,?4)",
            params![(n % 2 == 0).then(|| session.clone()), format!("prompt {text}"), format!("h{n}"), 1_000 + n as i64],
        )
        .unwrap();
    }
    let job = create_job(
        &conn,
        &DeliveryJobConfig {
            destination_id: "fixture".into(),
            instance_id: "format".into(),
            account_id: "account".into(),
            mapping_version: "1".into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["history".into(), "session_event".into(), "session".into()],
                sessionless: true,
                ..ExportSelection::default()
            },
            limits: DeliveryLimits::default(),
        },
        0,
    )
    .unwrap();
    let mut records = Vec::new();
    for step in 0..100 {
        let prepared = prepare_batch(&conn, &job.job_id, step).unwrap();
        if prepared.batch_id.is_none() {
            if prepared.bootstrap_complete && prepared.scanned_records == 0 {
                break;
            }
            continue;
        }
        let claim = claim_batch(&conn, &job.job_id, "format", 60_000, &|| step)
            .unwrap()
            .unwrap();
        settle(&conn, &claim, step);
        records.extend(claim.batch.records);
    }
    assert_eq!(records.len(), TEXTS.len() * 3);

    for record in &records {
        let (table, key) = table(&record.kind);
        let values: Vec<Sql> = key
            .iter()
            .map(|column| sql(&record.payload[*column]))
            .collect();
        let placeholders = vec!["?"; values.len()].join(",");
        let mut arguments = vec![Sql::Text(record.kind.clone())];
        arguments.extend(values.iter().cloned());
        let journal_key: String = conn
            .query_row(
                &format!("SELECT json_array(?,{placeholders})"),
                rusqlite::params_from_iter(arguments),
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            record.record_id,
            format!("{:x}", Sha256::digest(journal_key.as_bytes())),
            "{} record_id",
            record.kind
        );

        // `raw_facts_version` is the store's parser bookkeeping, which the
        // feed leaves out of every record (ai-hist 0.38).
        let columns: Vec<String> = conn
            .prepare(
                "SELECT name FROM pragma_table_info(?)
                 WHERE name NOT IN ('revision','raw_facts_version') ORDER BY cid",
            )
            .unwrap()
            .query_map([table], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let object = columns
            .iter()
            .map(|column| format!("'{column}',\"{column}\""))
            .collect::<Vec<_>>()
            .join(",");
        let condition = key
            .iter()
            .map(|column| format!("{column} IS ?"))
            .collect::<Vec<_>>()
            .join(" AND ");
        let journal_payload: String = conn
            .query_row(
                &format!("SELECT json_object({object}) FROM {table} WHERE {condition}"),
                rusqlite::params_from_iter(values),
                |r| r.get(0),
            )
            .unwrap();
        let journal_payload: Value = serde_json::from_str(&journal_payload).unwrap();
        assert_eq!(record.payload, journal_payload, "{} payload", record.kind);
        assert_eq!(
            record.revision_id,
            format!(
                "{:x}",
                Sha256::digest(
                    format!(
                        "{}:{}:{}",
                        record.origin_id, record.record_id, record.revision
                    )
                    .as_bytes()
                )
            )
        );
    }
}

/// Settle a claimed batch without a receiver, so the drain moves on.
fn settle(conn: &Connection, claim: &ClaimedBatch, now: i64) {
    store_prepared_payload(conn, &claim.lease, "1", "application/json", "{}", &|| now).unwrap();
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
        &|| now,
    )
    .unwrap();
}
