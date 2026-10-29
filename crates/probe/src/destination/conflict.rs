//! Strict interpretation of the receiver's typed 409. The error body never
//! enters durable state; only validated identities and digests do.
use super::*;
use crate::delivery::{ConflictRecord, ConflictRecovery, HistoryExportRecord};
use serde_json::{json, Value};

fn label(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= 512)
}
fn digest(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    })
}
fn canonical_hash(value: &Value) -> String {
    fn append(value: &Value, rendered: &mut String) {
        match value {
            Value::Null => rendered.push_str("null"),
            Value::Bool(boolean) => rendered.push_str(if *boolean { "true" } else { "false" }),
            Value::Number(number) => {
                let numeric = number.as_f64().expect("JSON number fits in f64");
                if numeric == 0.0 {
                    rendered.push('0'); // JSON.stringify(-0) is 0.
                } else {
                    rendered.push_str(ryu_js::Buffer::new().format(numeric));
                }
            }
            Value::String(string) => {
                rendered.push_str(&serde_json::to_string(string).expect("string serializes"));
            }
            Value::Array(items) => {
                rendered.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        rendered.push(',');
                    }
                    append(item, rendered);
                }
                rendered.push(']');
            }
            Value::Object(items) => {
                // JavaScript's Array.sort compares UTF-16 code units. Rust's
                // scalar-value order differs for supplementary-plane keys.
                let mut keys = items.keys().collect::<Vec<_>>();
                keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
                rendered.push('{');
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        rendered.push(',');
                    }
                    rendered.push_str(&serde_json::to_string(key).expect("key serializes"));
                    rendered.push(':');
                    append(items.get(key).expect("sorted key exists"), rendered);
                }
                rendered.push('}');
            }
        }
    }
    let mut rendered = String::new();
    append(value, &mut rendered);
    hash(rendered.as_bytes())
}
fn normalized_record(record: &HistoryExportRecord) -> Value {
    let mut value = serde_json::to_value(record).expect("record serializes");
    if value["session_id"] == "" {
        value["session_id"] = Value::Null;
    }
    value
}
pub(crate) fn batch_digest(batch: &HistoryExportBatch) -> String {
    let mut value = serde_json::to_value(batch).expect("batch serializes");
    value["records"] = Value::Array(batch.records.iter().map(normalized_record).collect());
    canonical_hash(&json!({"protocolVersion":1,"batch":value}))
}
pub(crate) fn child_id(parent: &HistoryExportBatch, records: &[HistoryExportRecord]) -> String {
    format!(
        "conflict-{}",
        canonical_hash(&json!([
            "relayhistory-delivery-conflict-recovery-v1",
            parent.origin_id,
            parent.batch_id,
            batch_digest(parent),
            records
                .iter()
                .map(|record| &record.revision_id)
                .collect::<Vec<_>>()
        ]))
    )
}

/// Convert a conflict proven for an exact deterministic isolation child into
/// a recovery plan for the durable parent lease. Nothing from the receiver is
/// widened here: the child identity/digest and all conflicting records must
/// already match the exact child request, and that child must be reproducible
/// from the parent. `verify` will independently bind the lifted plan to the
/// persisted parent bytes inside the recovery transaction.
pub(crate) fn lift(
    parent: &HistoryExportBatch,
    submitted: &HistoryExportBatch,
    recovery: &ConflictRecovery,
) -> Option<ConflictRecovery> {
    if recovery.parent_batch_id != submitted.batch_id
        || recovery.submitted_digest != batch_digest(submitted)
    {
        return None;
    }
    let records = submitted
        .records
        .iter()
        .map(|submitted_record| {
            parent
                .records
                .iter()
                .find(|record| record.revision_id == submitted_record.revision_id)
                .filter(|record| *record == submitted_record)
                .cloned()
        })
        .collect::<Option<Vec<_>>>()?;
    if super::child_batch(parent, &records) != *submitted
        || recovery.quarantined.iter().any(|conflict| {
            !submitted.records.iter().any(|record| {
                record.record_id == conflict.record_id
                    && record.revision_id == conflict.revision_id
                    && record.revision == conflict.revision
            })
        })
    {
        return None;
    }
    let removed = recovery
        .quarantined
        .iter()
        .map(|record| record.revision_id.as_str())
        .collect::<HashSet<_>>();
    let remaining = parent
        .records
        .iter()
        .filter(|record| !removed.contains(record.revision_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    Some(ConflictRecovery {
        parent_batch_id: parent.batch_id.clone(),
        submitted_digest: batch_digest(parent),
        quarantined: recovery.quarantined.clone(),
        child_batch_id: child_id(parent, &remaining),
    })
}

/// Returns a plan only for an exact status/code and complete, bounded detail.
/// `submitted` is parsed from the exact bytes sent to the receiver.
pub(crate) fn parse(
    status: u16,
    body: &Value,
    submitted: &HistoryExportBatch,
) -> Option<ConflictRecovery> {
    if status != 409
        || body.pointer("/error/code")?.as_str()? != "delivery_conflict"
        || !body.pointer("/error/message")?.is_string()
    {
        return None;
    }
    let error = body.get("error")?;
    let first = error.get("conflict")?;
    let (submitted_digest, _) = conflict_digests(first, &submitted.origin_id)?;
    let quarantined = match first.get("type")?.as_str()? {
        "batch_id" => batch_conflict(error, first, submitted)?,
        "record_revision" => record_conflicts(error, first, submitted)?,
        _ => return None,
    };
    let removed: HashSet<_> = quarantined
        .iter()
        .map(|record| record.revision_id.as_str())
        .collect();
    let remaining = submitted
        .records
        .iter()
        .filter(|record| !removed.contains(record.revision_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    Some(ConflictRecovery {
        parent_batch_id: submitted.batch_id.clone(),
        submitted_digest: if quarantined.is_empty() {
            submitted_digest.into()
        } else {
            batch_digest(submitted)
        },
        quarantined,
        child_batch_id: child_id(submitted, &remaining),
    })
}

/// Every conflict must name this origin and two distinct, canonical digests.
fn conflict_digests<'a>(item: &'a Value, origin_id: &str) -> Option<(&'a str, &'a str)> {
    let submitted = digest(item.get("submittedDigest")?)?;
    let current = digest(item.get("currentDigest")?)?;
    if label(item.get("originId")?)? != origin_id || submitted == current {
        return None;
    }
    Some((submitted, current))
}

fn batch_conflict(
    error: &Value,
    first: &Value,
    submitted: &HistoryExportBatch,
) -> Option<Vec<ConflictRecord>> {
    if error.get("conflicts").is_some()
        || error.get("conflictCount").is_some()
        || label(first.get("batchId")?)? != submitted.batch_id
        || digest(first.get("submittedDigest")?)? != batch_digest(submitted)
    {
        return None;
    }
    Some(Vec::new())
}

fn record_conflicts(
    error: &Value,
    first: &Value,
    submitted: &HistoryExportBatch,
) -> Option<Vec<ConflictRecord>> {
    let list = error.get("conflicts")?.as_array()?;
    let count = error.get("conflictCount")?.as_u64()? as usize;
    if list.is_empty()
        || list.len() > 100
        || count < list.len()
        || count > submitted.records.len()
        || list[0] != *first
    {
        return None;
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in list {
        let conflict = record_conflict(item, submitted)?;
        if !seen.insert(conflict.revision_id.clone()) {
            return None;
        }
        result.push(conflict);
    }
    // The first entry is the exact discriminator, including its comparison identity.
    Some(result)
}

fn conflict_revision(item: &Value) -> Option<i64> {
    let revision = item.get("submittedRevision")?.as_i64()?;
    if revision <= 0
        || revision > 9_007_199_254_740_991
        || item.get("currentRevision")?.as_i64()? != revision
        || label(item.get("currentRevisionId")?).is_none()
    {
        return None;
    }
    Some(revision)
}

fn record_conflict(item: &Value, submitted: &HistoryExportBatch) -> Option<ConflictRecord> {
    if item.get("type")?.as_str()? != "record_revision" {
        return None;
    }
    let (submitted_digest, current_digest) = conflict_digests(item, &submitted.origin_id)?;
    let record_id = label(item.get("recordId")?)?;
    let revision_id = label(item.get("submittedRevisionId")?)?;
    let revision = conflict_revision(item)?;
    let record = submitted.records.iter().find(|record| {
        record.record_id == record_id
            && record.revision_id == revision_id
            && record.revision == revision
    })?;
    if submitted_digest != canonical_hash(&normalized_record(record)) {
        return None;
    }
    Some(ConflictRecord {
        record_id: record_id.into(),
        revision_id: revision_id.into(),
        revision,
        submitted_digest: submitted_digest.into(),
        current_digest: current_digest.into(),
    })
}

/// Recheck an in-memory plan against the persisted, exact wire body under the
/// queue write transaction. This also supplies the immutable child wire body.
pub(crate) fn verify(
    prepared: &PreparedPayload,
    parent: &HistoryExportBatch,
    recovery: &ConflictRecovery,
) -> Result<(
    HistoryExportBatch,
    PreparedPayload,
    Vec<HistoryExportRecord>,
)> {
    let body = storable_body(prepared.body.clone())?;
    let request: Request = serde_json::from_str(&body)?;
    require(
        request.protocol_version == 1
            && request.batch.batch_id == parent.batch_id
            && recovery.parent_batch_id == parent.batch_id
            && recovery.submitted_digest == batch_digest(&request.batch),
        DeliveryFailure::InvalidPayload,
    )?;
    let submitted = request.batch;
    let mut removed = HashSet::new();
    for item in &recovery.quarantined {
        let record = submitted
            .records
            .iter()
            .find(|record| {
                record.record_id == item.record_id
                    && record.revision_id == item.revision_id
                    && record.revision == item.revision
            })
            .ok_or_else(|| fail(DeliveryFailure::InvalidPayload))?;
        require(
            removed.insert(item.revision_id.as_str())
                && item.submitted_digest == canonical_hash(&normalized_record(record))
                && item.current_digest != item.submitted_digest,
            DeliveryFailure::InvalidPayload,
        )?;
    }
    let remaining = submitted
        .records
        .iter()
        .filter(|record| !removed.contains(record.revision_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    require(
        recovery.child_batch_id == child_id(&submitted, &remaining),
        DeliveryFailure::InvalidPayload,
    )?;
    let mut child = parent.clone();
    child.batch_id = recovery.child_batch_id.clone();
    child
        .records
        .retain(|record| !removed.contains(record.revision_id.as_str()));
    let submitted_records = submitted.records.clone();
    let mut wire_child = submitted;
    wire_child.batch_id = recovery.child_batch_id.clone();
    wire_child.records = remaining;
    let child_body = serde_json::to_string(&Request {
        protocol_version: 1,
        batch: wire_child,
    })?;
    let child_prepared = PreparedPayload {
        mapping_version: prepared.mapping_version.clone(),
        content_type: prepared.content_type.clone(),
        sha256: hash(child_body.as_bytes()),
        body: child_body,
        prepared_by: None,
    };
    Ok((child, child_prepared, submitted_records))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delivery::{self, worker};
    use rusqlite::params;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn record(id: &str, revision_id: &str, text: &str) -> HistoryExportRecord {
        HistoryExportRecord {
            schema_version: 1,
            origin_id: "origin".into(),
            record_id: id.into(),
            revision_id: revision_id.into(),
            revision: 1,
            kind: "session_event".into(),
            source: "claude".into(),
            session_id: Some(id.into()),
            operation: "upsert".into(),
            payload: json!({"text":text,"nested":{"z":1,"a":2}}),
        }
    }
    fn batch(records: Vec<HistoryExportRecord>) -> HistoryExportBatch {
        HistoryExportBatch {
            schema_version: 1,
            origin_id: "origin".into(),
            batch_id: "parent".into(),
            job_id: "job".into(),
            generation: 1,
            destination_id: "relayhistory".into(),
            instance_id: "probe".into(),
            account_id: "relayhistory:account".into(),
            mapping_version: MAPPING_VERSION.into(),
            records,
        }
    }
    fn record_error(record: &HistoryExportRecord) -> Value {
        json!({"type":"record_revision","originId":record.origin_id,"recordId":record.record_id,
            "submittedRevisionId":record.revision_id,"submittedRevision":record.revision,
            "submittedDigest":canonical_hash(&normalized_record(record)),
            "currentRevisionId":record.revision_id,"currentRevision":record.revision,
            "currentDigest":"f".repeat(64)})
    }
    fn response(records: &[HistoryExportRecord]) -> Value {
        let conflicts: Vec<_> = records.iter().map(record_error).collect();
        json!({"error":{"code":"delivery_conflict","message":"different content",
            "conflict":conflicts[0],"conflicts":conflicts,"conflictCount":records.len()}})
    }

    #[test]
    fn canonical_digest_matches_the_javascript_receiver_for_numbers_and_utf16_keys() {
        let value = json!({"integer_like":1.0,"scaled":1e30,"\u{e000}":0,"😀":1,
            "small":0.000001,"tiny":1e-7});
        assert_eq!(
            canonical_hash(&value),
            "fa17e64c32d204c972b66c4bcbfefc1fabaf26c99aaf4d789c4201c4d7221e87"
        );
    }

    #[test]
    fn exact_status_identity_digest_and_bounded_multi_conflict_are_required() {
        let one = record("a", "r1", "one");
        let two = record("b", "r2", "two");
        let submitted = batch(vec![one.clone(), two.clone()]);
        let good = response(&[one, two]);
        let plan = parse(409, &good, &submitted).unwrap();
        assert_eq!(plan.quarantined.len(), 2);
        assert!(parse(400, &good, &submitted).is_none());
        let mut bad = good.clone();
        bad["error"]["code"] = json!("other");
        assert!(parse(409, &bad, &submitted).is_none());
        let mut bad = good.clone();
        bad["error"]["conflicts"][1]["submittedDigest"] = json!("0".repeat(64));
        assert!(parse(409, &bad, &submitted).is_none());
        let mut bad = good.clone();
        bad["error"]["conflicts"][1]["submittedRevisionId"] = json!("r1");
        assert!(parse(409, &bad, &submitted).is_none());
        let mut bad = good.clone();
        bad["error"]["conflictCount"] = json!(101);
        assert!(parse(409, &bad, &submitted).is_none());
    }

    #[test]
    fn incomplete_or_mismatched_record_conflicts_are_rejected() {
        let one = record("a", "r1", "one");
        let submitted = batch(vec![one.clone()]);
        let good = response(&[one]);
        for field in [
            "type",
            "originId",
            "recordId",
            "submittedRevisionId",
            "submittedRevision",
            "submittedDigest",
            "currentRevisionId",
            "currentRevision",
            "currentDigest",
        ] {
            let mut bad = good.clone();
            bad["error"]["conflict"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            bad["error"]["conflicts"][0] = bad["error"]["conflict"].clone();
            assert!(parse(409, &bad, &submitted).is_none(), "missing {field}");
        }
        for (field, value) in [
            ("type", json!("unknown")),
            ("originId", json!("another-origin")),
            ("recordId", json!("another-record")),
            ("submittedRevisionId", json!("another-revision")),
            ("submittedRevision", json!(0)),
            ("submittedRevision", json!(9_007_199_254_740_992i64)),
            ("currentRevision", json!(2)),
            ("currentRevisionId", json!("")),
            ("currentDigest", json!("F".repeat(64))),
            (
                "currentDigest",
                good["error"]["conflict"]["submittedDigest"].clone(),
            ),
        ] {
            let mut bad = good.clone();
            bad["error"]["conflict"][field] = value;
            bad["error"]["conflicts"][0] = bad["error"]["conflict"].clone();
            assert!(parse(409, &bad, &submitted).is_none(), "invalid {field}");
        }
    }

    #[test]
    fn conflict_list_must_be_bounded_unique_and_match_its_discriminator() {
        let one = record("a", "r1", "one");
        let two = record("b", "r2", "two");
        let submitted = batch(vec![one.clone(), two.clone()]);
        let good = response(&[one, two]);
        for count in [json!(0), json!(1), json!(3), json!("2")] {
            let mut bad = good.clone();
            bad["error"]["conflictCount"] = count;
            assert!(parse(409, &bad, &submitted).is_none());
        }
        let first = good["error"]["conflict"].clone();
        for list in [
            json!([]),
            json!([first, first]),
            json!([good["error"]["conflicts"][1], first]),
            json!(vec![first; 101]),
        ] {
            let mut bad = good.clone();
            bad["error"]["conflicts"] = list;
            assert!(parse(409, &bad, &submitted).is_none());
        }
        let mut partial = good;
        partial["error"]["conflicts"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        // The receiver may return a bounded subset of the total conflicts.
        assert_eq!(
            parse(409, &partial, &submitted).unwrap().quarantined.len(),
            1
        );
    }

    #[test]
    fn same_batch_revision_reuse_remains_quarantined() {
        let a = record("same", "first", "one");
        let b = record("same", "second", "different");
        let submitted = batch(vec![a, b.clone()]);
        let mut conflict = record_error(&b);
        conflict["currentRevisionId"] = json!("first");
        let body = json!({"error":{"code":"delivery_conflict","message":"in batch",
            "conflict":conflict,"conflicts":[conflict],"conflictCount":1}});
        let plan = parse(409, &body, &submitted).unwrap();
        assert_eq!(plan.quarantined[0].revision_id, "second");
        assert_eq!(submitted.records[1].revision, 1);
    }

    #[test]
    fn isolation_child_proof_lifts_only_for_its_exact_parent_subset() {
        let first = record("a", "r1", "one");
        let second = record("b", "r2", "two");
        let parent = batch(vec![first.clone(), second.clone()]);
        let submitted = super::super::child_batch(&parent, std::slice::from_ref(&first));
        let recovery = parse(409, &response(std::slice::from_ref(&first)), &submitted).unwrap();
        let lifted = lift(&parent, &submitted, &recovery).unwrap();
        assert_eq!(lifted.parent_batch_id, parent.batch_id);
        assert_eq!(lifted.submitted_digest, batch_digest(&parent));
        assert_eq!(lifted.quarantined[0].revision_id, first.revision_id);
        let prepared = super::prepare(parent.clone()).unwrap();
        let (child, _, _) = verify(&prepared, &parent, &lifted).unwrap();
        assert_eq!(child.records, vec![second]);

        let mut forged = submitted.clone();
        forged.batch_id = "not-the-deterministic-child".into();
        assert!(lift(&parent, &forged, &recovery).is_none());
        let unrelated = batch(vec![record("x", "rx", "elsewhere")]);
        assert!(lift(&unrelated, &submitted, &recovery).is_none());
    }

    #[test]
    fn batch_id_conflict_rekeys_all_records_without_quarantine_or_revision_change() {
        let submitted = batch(vec![record("a", "r1", "one"), record("b", "r2", "two")]);
        let body = json!({"error":{"code":"delivery_conflict","message":"batch reused",
            "conflict":{"type":"batch_id","originId":submitted.origin_id,
                "batchId":submitted.batch_id,"submittedDigest":batch_digest(&submitted),
                "currentDigest":"f".repeat(64)}}});
        let plan = parse(409, &body, &submitted).unwrap();
        assert!(plan.quarantined.is_empty());
        let prepared = super::prepare(submitted.clone()).unwrap();
        let (child, child_prepared, _) = verify(&prepared, &submitted, &plan).unwrap();
        assert_eq!(child.records, submitted.records);
        assert_eq!(child.batch_id, plan.child_batch_id);
        assert_eq!(child.records[0].revision, submitted.records[0].revision);
        assert_eq!(child_prepared.sha256, hash(child_prepared.body.as_bytes()));
        assert_eq!(plan, parse(409, &body, &submitted).unwrap());
        let mut invalid = body;
        invalid["error"]["conflict"]["submittedDigest"] = json!("0".repeat(64));
        assert!(parse(409, &invalid, &submitted).is_none());
    }

    struct ReceiverFixture {
        calls: AtomicUsize,
        accepted_without_response: Mutex<Option<(String, String)>>,
    }
    impl worker::Receiver for ReceiverFixture {
        fn mapping_version(&self) -> &str {
            MAPPING_VERSION
        }
        fn supported_kinds(&self) -> &[&str] {
            &["session_event"]
        }
        fn supports_tombstones(&self) -> bool {
            true
        }
        fn prepare(
            &self,
            batch: &HistoryExportBatch,
            _: &worker::ReceiverContext<'_>,
        ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
            let prepared = super::prepare_within(batch.clone(), 100).unwrap();
            Ok(worker::PreparedBody {
                content_type: prepared.content_type,
                body: prepared.body,
            })
        }
        fn send(
            &self,
            payload: &PreparedPayload,
            batch: &HistoryExportBatch,
            _: &worker::ReceiverContext<'_>,
        ) -> std::result::Result<DeliveryAcknowledgment, worker::ReceiverFailure> {
            let sent: Request = serde_json::from_str(&payload.body).unwrap();
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                let conflict = sent.batch.records[0].clone();
                return Err(worker::ReceiverFailure {
                    failure: DeliveryFailure::DeliveryConflict,
                    retry_after_ms: None,
                    recovery: parse(409, &response(&[conflict]), &sent.batch),
                });
            }
            if call == 1 {
                *self.accepted_without_response.lock().unwrap() =
                    Some((batch.batch_id.clone(), payload.body.clone()));
                return Err(DeliveryFailure::Transient.into());
            }
            if call == 2 {
                let (id, body) = self
                    .accepted_without_response
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap();
                assert_eq!(batch.batch_id, id);
                assert_eq!(payload.body, body);
            }
            assert_eq!(sent.batch.batch_id, batch.batch_id);
            Ok(DeliveryAcknowledgment {
                batch_id: batch.batch_id.clone(),
                accepted_revision_ids: batch
                    .records
                    .iter()
                    .map(|r| r.revision_id.clone())
                    .collect(),
                unsupported_revision_ids: vec![],
                suppressed_revision_ids: vec![],
                rejected_revision_ids: vec![],
                isolation_frontier: vec![],
                acceptance_level: AcceptanceLevel::Durable,
            })
        }
    }

    #[test]
    fn worker_quarantines_atomically_then_restart_drains_child_and_later_batch() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let conn = delivery::open_db(&path).unwrap();
        for id in ["a", "b", "c"] {
            conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?1,42,'user','text',?1)", params![id]).unwrap();
        }
        let config = delivery::DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "probe".into(),
            account_id: "relayhistory:account".into(),
            mapping_version: MAPPING_VERSION.into(),
            selection: delivery::ExportSelection {
                all_sources: true,
                kinds: vec!["session_event".into()],
                ..Default::default()
            },
            limits: delivery::DeliveryLimits {
                max_batch_records: 2,
                max_scan_records: 4,
                ..Default::default()
            },
        };
        let job = delivery::create_job(&conn, &config, 0).unwrap();
        let receiver = ReceiverFixture {
            calls: AtomicUsize::new(0),
            accepted_without_response: Mutex::new(None),
        };
        let receivers = worker::SingleReceiver::new("relayhistory", "probe", &receiver);
        let mut options = worker::DrainOptions::new("worker");
        options.max_batches = 1;
        worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
            false
        })
        .unwrap();
        let after = delivery::status(&conn, &job.job_id).unwrap();
        assert_eq!(after.quarantined_records, 1);
        assert_eq!(after.skipped_records, 0);
        assert_eq!(after.state, "active");
        let (child_id, archived): (String, String) = conn
            .query_row(
                "SELECT child_batch_id,prepared FROM delivery_conflict_attempts",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(child_id.starts_with("conflict-"));
        assert!(archived.contains("protocolVersion"));
        drop(conn); // Simulate process restart before the child is sent.
        let conn = delivery::open_db(&path).unwrap();
        options.max_batches = 10;
        worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
            false
        })
        .unwrap();
        assert_eq!(
            delivery::status(&conn, &job.job_id)
                .unwrap()
                .failure
                .as_deref(),
            Some("transient")
        );
        delivery::retry_job(&conn, &job.job_id).unwrap();
        worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
            false
        })
        .unwrap();
        let final_status = delivery::status(&conn, &job.job_id).unwrap();
        assert_eq!(final_status.pending_records, 0);
        assert_eq!(final_status.quarantined_records, 1);
        assert_eq!(final_status.skipped_records, 0);
        assert_eq!(final_status.acknowledged_records, 2);
        assert!(receiver.calls.load(Ordering::SeqCst) >= 3);
        let evidence: String = conn
            .query_row("SELECT record_json FROM delivery_quarantine", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(evidence.contains("session_event"));
        delivery::cancel_job(&conn, &job.job_id).unwrap();
        let retained: i64 = conn
            .query_row("SELECT COUNT(*) FROM delivery_quarantine", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(retained, 0);
    }

    struct RecoveryReceiver {
        calls: AtomicUsize,
        invalid: bool,
    }
    impl worker::Receiver for RecoveryReceiver {
        fn mapping_version(&self) -> &str {
            MAPPING_VERSION
        }
        fn supported_kinds(&self) -> &[&str] {
            &["session_event"]
        }
        fn supports_tombstones(&self) -> bool {
            true
        }
        fn prepare(
            &self,
            batch: &HistoryExportBatch,
            _: &worker::ReceiverContext<'_>,
        ) -> std::result::Result<worker::PreparedBody, worker::ReceiverFailure> {
            let prepared = super::prepare(batch.clone()).unwrap();
            Ok(worker::PreparedBody {
                content_type: prepared.content_type,
                body: prepared.body,
            })
        }
        fn send(
            &self,
            payload: &PreparedPayload,
            _: &HistoryExportBatch,
            _: &worker::ReceiverContext<'_>,
        ) -> std::result::Result<DeliveryAcknowledgment, worker::ReceiverFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let sent: Request = serde_json::from_str(&payload.body).unwrap();
            let mut recovery = parse(
                409,
                &response(std::slice::from_ref(&sent.batch.records[0])),
                &sent.batch,
            )
            .unwrap();
            // Model a recovery plan that passed the transport boundary but
            // fails the core's fenced recheck against persisted bytes.
            if self.invalid {
                recovery.submitted_digest = "0".repeat(64);
            }
            Err(worker::ReceiverFailure {
                failure: DeliveryFailure::DeliveryConflict,
                retry_after_ms: None,
                recovery: Some(recovery),
            })
        }
    }

    #[test]
    fn invalid_recovery_is_recorded_as_a_conflict_instead_of_leaving_a_lease() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let conn = delivery::open_db(&path).unwrap();
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','a','a',42,'user','text','a')", []).unwrap();
        let config = delivery::DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "probe".into(),
            account_id: "relayhistory:account".into(),
            mapping_version: MAPPING_VERSION.into(),
            selection: delivery::ExportSelection {
                all_sources: true,
                kinds: vec!["session_event".into()],
                ..Default::default()
            },
            limits: delivery::DeliveryLimits::default(),
        };
        let job = delivery::create_job(&conn, &config, 0).unwrap();
        let receiver = RecoveryReceiver {
            calls: AtomicUsize::new(0),
            invalid: true,
        };
        let receivers = worker::SingleReceiver::new("relayhistory", "probe", &receiver);
        let options = worker::DrainOptions::new("worker");

        let result = worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
            false
        })
        .unwrap();
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        let status = delivery::status(&conn, &job.job_id).unwrap();
        assert_eq!(status.state, "blocked");
        assert_eq!(status.failure.as_deref(), Some("delivery_conflict"));
        let leased: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delivery_batches WHERE job_id=? AND state='leased'",
                [&job.job_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leased, 0);
        assert_eq!(receiver.calls.load(Ordering::SeqCst), 1);

        worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
            false
        })
        .unwrap();
        assert_eq!(receiver.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn storage_failure_during_valid_recovery_retries_instead_of_blocking() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let conn = delivery::open_db(&path).unwrap();
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','a','a',42,'user','text','a')", []).unwrap();
        let config = delivery::DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "probe".into(),
            account_id: "relayhistory:account".into(),
            mapping_version: MAPPING_VERSION.into(),
            selection: delivery::ExportSelection {
                all_sources: true,
                kinds: vec!["session_event".into()],
                ..Default::default()
            },
            limits: delivery::DeliveryLimits::default(),
        };
        let job = delivery::create_job(&conn, &config, 0).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_conflict_recovery
             BEFORE INSERT ON delivery_conflict_attempts
             BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;",
        )
        .unwrap();
        let receiver = RecoveryReceiver {
            calls: AtomicUsize::new(0),
            invalid: false,
        };
        let receivers = worker::SingleReceiver::new("relayhistory", "probe", &receiver);
        let options = worker::DrainOptions::new("worker");

        worker::drain(&path, &receivers, &options, &|| 1_000, &|| false).unwrap();
        let deferred = delivery::status(&conn, &job.job_id).unwrap();
        assert_eq!(deferred.state, "active");
        assert_eq!(deferred.failure.as_deref(), Some("transient"));
        assert!(deferred.next_attempt_ms > 1_000);
        assert_eq!(receiver.calls.load(Ordering::SeqCst), 1);
        let leased: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM delivery_batches WHERE job_id=? AND state='leased'",
                [&job.job_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leased, 0);

        conn.execute_batch("DROP TRIGGER fail_conflict_recovery;")
            .unwrap();
        delivery::retry_job(&conn, &job.job_id).unwrap();
        worker::drain(&path, &receivers, &options, &|| 10_000, &|| false).unwrap();
        let recovered = delivery::status(&conn, &job.job_id).unwrap();
        assert_eq!(recovered.state, "active");
        assert_eq!(recovered.failure, None);
        assert_eq!(recovered.pending_records, 0);
        assert_eq!(recovered.quarantined_records, 1);
        assert_eq!(receiver.calls.load(Ordering::SeqCst), 2);
    }
}
