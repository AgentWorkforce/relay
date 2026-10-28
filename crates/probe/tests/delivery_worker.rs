//! The generic drain loop: one worker, receiver-agnostic, ported from the
//! behaviours the TypeScript host tests already pin down.

use agent_relay_probe::delivery::open_db;
use agent_relay_probe::delivery::worker::*;
use agent_relay_probe::delivery::*;
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Fixture {
    directory: tempfile::TempDir,
    conn: Connection,
}
impl Fixture {
    fn path(&self) -> PathBuf {
        self.directory.path().join("history.db")
    }
}
fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let conn = open_db(&directory.path().join("history.db")).unwrap();
    for session in SESSIONS {
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?1,42,'user','text',?1)",params![session]).unwrap();
    }
    Fixture { directory, conn }
}
const SESSIONS: [&str; 3] = ["local-only", "remote-only", "both"];

fn config(instance: &str) -> DeliveryJobConfig {
    DeliveryJobConfig {
        destination_id: "fixture".into(),
        instance_id: instance.into(),
        account_id: "fixture-account".into(),
        mapping_version: "1".into(),
        selection: ExportSelection {
            all_sources: false,
            sources: vec!["claude".into()],
            kinds: vec!["session_event".into()],
            ..ExportSelection::default()
        },
        limits: DeliveryLimits::default(),
    }
}
fn body(batch: &HistoryExportBatch) -> PreparedBody {
    PreparedBody {
        content_type: "application/json".into(),
        body: serde_json::to_string(&batch.records).unwrap(),
    }
}
fn ack(batch: &HistoryExportBatch) -> DeliveryAcknowledgment {
    DeliveryAcknowledgment {
        batch_id: batch.batch_id.clone(),
        accepted_revision_ids: batch
            .records
            .iter()
            .map(|record| record.revision_id.clone())
            .collect(),
        unsupported_revision_ids: vec![],
        suppressed_revision_ids: vec![],
        rejected_revision_ids: vec![],
        isolation_frontier: vec![],
        acceptance_level: AcceptanceLevel::Durable,
    }
}

type PrepareFn = Box<dyn Fn(&HistoryExportBatch) -> Result<PreparedBody, ReceiverFailure> + Sync>;
type SendFn = Box<
    dyn Fn(&PreparedPayload, &HistoryExportBatch) -> Result<DeliveryAcknowledgment, ReceiverFailure>
        + Sync,
>;
struct Fake {
    mapping: String,
    kinds: Vec<&'static str>,
    tombstones: bool,
    prepare: PrepareFn,
    send: SendFn,
}
impl Default for Fake {
    fn default() -> Self {
        Self {
            mapping: "1".into(),
            kinds: vec!["session_event"],
            tombstones: true,
            prepare: Box::new(|batch| Ok(body(batch))),
            send: Box::new(|_payload, batch| Ok(ack(batch))),
        }
    }
}
impl Receiver for Fake {
    fn mapping_version(&self) -> &str {
        &self.mapping
    }
    fn supported_kinds(&self) -> &[&str] {
        &self.kinds
    }
    fn supports_tombstones(&self) -> bool {
        self.tombstones
    }
    fn prepare(
        &self,
        batch: &HistoryExportBatch,
        _ctx: &ReceiverContext<'_>,
    ) -> Result<PreparedBody, ReceiverFailure> {
        (self.prepare)(batch)
    }
    fn send(
        &self,
        payload: &PreparedPayload,
        batch: &HistoryExportBatch,
        _ctx: &ReceiverContext<'_>,
    ) -> Result<DeliveryAcknowledgment, ReceiverFailure> {
        (self.send)(payload, batch)
    }
}
fn one(receiver: &dyn Receiver) -> SingleReceiver<'_> {
    SingleReceiver::new("fixture", "one", receiver)
}
fn options() -> DrainOptions {
    DrainOptions::new("worker")
}
fn run(path: &Path, receivers: &dyn Receivers, options: &DrainOptions) -> DrainResult {
    drain(path, receivers, options, &system_clock, &|| false).unwrap()
}

#[test]
fn partial_receiver_progress_is_durable_and_reaches_the_next_attempt() {
    struct ResumingReceiver {
        calls: AtomicUsize,
    }
    impl Receiver for ResumingReceiver {
        fn mapping_version(&self) -> &str {
            "1"
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
            _: &ReceiverContext<'_>,
        ) -> Result<PreparedBody, ReceiverFailure> {
            Ok(body(batch))
        }
        fn send(
            &self,
            _: &PreparedPayload,
            batch: &HistoryExportBatch,
            context: &ReceiverContext<'_>,
        ) -> Result<DeliveryAcknowledgment, ReceiverFailure> {
            let call = self.calls.fetch_add(1, SeqCst);
            if call == 0 {
                assert!(context.accepted_revision_ids.is_empty());
                return Ok(DeliveryAcknowledgment {
                    batch_id: batch.batch_id.clone(),
                    accepted_revision_ids: vec![batch.records[0].revision_id.clone()],
                    unsupported_revision_ids: vec![],
                    suppressed_revision_ids: vec![],
                    rejected_revision_ids: vec![],
                    isolation_frontier: vec![],
                    acceptance_level: AcceptanceLevel::Durable,
                });
            }
            assert_eq!(
                context.accepted_revision_ids,
                &[batch.records[0].revision_id.clone()]
            );
            Ok(DeliveryAcknowledgment {
                batch_id: batch.batch_id.clone(),
                accepted_revision_ids: batch.records[1..]
                    .iter()
                    .map(|record| record.revision_id.clone())
                    .collect(),
                unsupported_revision_ids: vec![],
                suppressed_revision_ids: vec![],
                rejected_revision_ids: vec![],
                isolation_frontier: vec![],
                acceptance_level: AcceptanceLevel::Durable,
            })
        }
    }

    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let receiver = ResumingReceiver {
        calls: AtomicUsize::new(0),
    };
    let mut once = options();
    once.max_batches = 1;
    run(&fixture.path(), &one(&receiver), &once);
    let partial = status(&fixture.conn, &job.job_id).unwrap();
    assert_eq!(partial.acknowledged_records, 0);
    retry_job(&fixture.conn, &job.job_id).unwrap();
    run(&fixture.path(), &one(&receiver), &once);
    let complete = status(&fixture.conn, &job.job_id).unwrap();
    assert_eq!(complete.acknowledged_records, 3);
    assert_eq!(receiver.calls.load(SeqCst), 2);
}

#[test]
fn lost_acknowledgment_retries_the_persisted_payload_without_remapping() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let bodies: Arc<Mutex<Vec<String>>> = Arc::default();
    let batches: Arc<Mutex<Vec<String>>> = Arc::default();
    let received: Arc<Mutex<HashSet<String>>> = Arc::default();
    let preparations = Arc::new(AtomicUsize::new(0));
    let observe = |bodies: Arc<Mutex<Vec<String>>>,
                   batches: Arc<Mutex<Vec<String>>>,
                   received: Arc<Mutex<HashSet<String>>>| {
        move |payload: &PreparedPayload, batch: &HistoryExportBatch| {
            bodies.lock().unwrap().push(payload.body.clone());
            batches.lock().unwrap().push(batch.batch_id.clone());
            received.lock().unwrap().extend(
                batch
                    .records
                    .iter()
                    .map(|record| record.revision_id.clone()),
            );
        }
    };
    let first = Fake {
        prepare: {
            let preparations = preparations.clone();
            Box::new(move |batch| {
                preparations.fetch_add(1, SeqCst);
                Ok(body(batch))
            })
        },
        send: {
            let record = observe(bodies.clone(), batches.clone(), received.clone());
            // The receiver durably accepted the batch, then lost its response.
            Box::new(move |payload, batch| {
                record(payload, batch);
                Err(DeliveryFailure::Transient.into())
            })
        },
        ..Fake::default()
    };
    let failed = run(
        &fixture.path(),
        &one(&first),
        &DrainOptions {
            max_batches: 1,
            ..options()
        },
    );
    assert_eq!(failed.attempts, 1);
    assert_eq!(failed.statuses[0].failure.as_deref(), Some("transient"));
    assert_eq!(failed.statuses[0].acknowledged_records, 0);
    assert_eq!(failed.statuses[0].pending_records, 3);
    retry_job(&fixture.conn, &job.job_id).unwrap();

    // Recreate every receiver object, retaining only the database and receiver state.
    let restarted = Fake {
        prepare: Box::new(|_batch| panic!("retry must use the persisted mapping")),
        send: {
            let record = observe(bodies.clone(), batches.clone(), received.clone());
            Box::new(move |payload, batch| {
                record(payload, batch);
                Ok(ack(batch))
            })
        },
        ..Fake::default()
    };
    let delivered = run(&fixture.path(), &one(&restarted), &options());
    assert_eq!(delivered.issues, vec![]);
    assert_eq!(delivered.statuses[0].acknowledged_records, 3);
    assert_eq!(delivered.statuses[0].pending_records, 0);
    assert_eq!(
        delivered.statuses[0].acceptance_level.as_deref(),
        Some("durable")
    );
    assert_eq!(preparations.load(SeqCst), 1);
    assert_eq!(received.lock().unwrap().len(), 3);
    let (bodies, batches) = (bodies.lock().unwrap(), batches.lock().unwrap());
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
    assert_eq!(batches[0], batches[1]);
}

#[test]
fn partial_and_invalid_acknowledgments_cannot_skip_holes() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let subset = Fake {
        send: Box::new(|_payload, batch| {
            Ok(DeliveryAcknowledgment {
                accepted_revision_ids: vec![batch.records[0].revision_id.clone()],
                ..ack(batch)
            })
        }),
        ..Fake::default()
    };
    let partial = run(
        &fixture.path(),
        &one(&subset),
        &DrainOptions {
            max_batches: 1,
            ..options()
        },
    );
    assert_eq!(partial.statuses[0].acknowledged_records, 0);
    assert_eq!(partial.statuses[0].pending_records, 3);
    retry_job(&fixture.conn, &job.job_id).unwrap();

    let wrong = Fake {
        send: Box::new(|_payload, batch| {
            Ok(DeliveryAcknowledgment {
                batch_id: "wrong-batch".into(),
                ..ack(batch)
            })
        }),
        ..Fake::default()
    };
    let invalid = run(&fixture.path(), &one(&wrong), &options());
    assert_eq!(invalid.statuses[0].state, "blocked");
    assert_eq!(
        invalid.statuses[0].failure.as_deref(),
        Some("invalid_payload")
    );
    assert_eq!(invalid.statuses[0].acknowledged_records, 0);
    retry_job(&fixture.conn, &job.job_id).unwrap();

    let accepted = run(&fixture.path(), &one(&Fake::default()), &options());
    assert_eq!(accepted.statuses[0].acknowledged_records, 3);
}

#[test]
fn malformed_receiver_isolation_progress_is_invalid_payload() {
    fn assert_invalid(mutate: fn(&mut DeliveryAcknowledgment, &HistoryExportBatch)) {
        let fixture = fixture();
        create_job(&fixture.conn, &config("one"), 0).unwrap();
        let receiver = Fake {
            send: Box::new(move |_payload, batch| {
                let mut response = ack(batch);
                mutate(&mut response, batch);
                Ok(response)
            }),
            ..Fake::default()
        };
        let invalid = run(&fixture.path(), &one(&receiver), &options());
        assert_eq!(invalid.statuses[0].state, "blocked");
        assert_eq!(
            invalid.statuses[0].failure.as_deref(),
            Some("invalid_payload")
        );
        assert_eq!(invalid.statuses[0].acknowledged_records, 0);
    }

    fn unknown_frontier(ack: &mut DeliveryAcknowledgment, _batch: &HistoryExportBatch) {
        ack.isolation_frontier.push(IsolationTask {
            revision_ids: vec!["unknown".into()],
            rejected: true,
        });
    }
    fn duplicate_frontier(ack: &mut DeliveryAcknowledgment, batch: &HistoryExportBatch) {
        ack.accepted_revision_ids.clear();
        let revision = batch.records[0].revision_id.clone();
        ack.isolation_frontier.push(IsolationTask {
            revision_ids: vec![revision.clone(), revision],
            rejected: true,
        });
    }
    fn overlapping_frontier(ack: &mut DeliveryAcknowledgment, batch: &HistoryExportBatch) {
        ack.isolation_frontier.push(IsolationTask {
            revision_ids: vec![batch.records[0].revision_id.clone()],
            rejected: true,
        });
    }
    fn empty_frontier(ack: &mut DeliveryAcknowledgment, _batch: &HistoryExportBatch) {
        ack.isolation_frontier.push(IsolationTask {
            revision_ids: vec![],
            rejected: false,
        });
    }
    fn unknown_rejection(ack: &mut DeliveryAcknowledgment, _batch: &HistoryExportBatch) {
        ack.rejected_revision_ids.push("unknown".into());
    }
    fn overlapping_rejection(ack: &mut DeliveryAcknowledgment, batch: &HistoryExportBatch) {
        ack.rejected_revision_ids
            .push(batch.records[0].revision_id.clone());
    }

    for mutation in [
        unknown_frontier as fn(&mut DeliveryAcknowledgment, &HistoryExportBatch),
        duplicate_frontier,
        overlapping_frontier,
        empty_frontier,
        unknown_rejection,
        overlapping_rejection,
    ] {
        assert_invalid(mutation);
    }
}

#[test]
fn one_blocked_receiver_cannot_stop_another_and_mapping_upgrades_keep_pending_work() {
    let fixture = fixture();
    let first = create_job(&fixture.conn, &config("one"), 0).unwrap();
    create_job(&fixture.conn, &config("two"), 0).unwrap();
    let mut registry: HashMap<(String, String), Box<dyn Receiver>> = HashMap::new();
    registry.insert(
        ("fixture".into(), "one".into()),
        Box::new(Fake {
            send: Box::new(|_payload, _batch| Err(DeliveryFailure::AuthenticationRequired.into())),
            ..Fake::default()
        }),
    );
    registry.insert(("fixture".into(), "two".into()), Box::new(Fake::default()));
    let result = run(&fixture.path(), &registry, &options());
    let job = |result: &DrainResult, instance: &str| {
        result
            .statuses
            .iter()
            .find(|job| job.config.instance_id == instance)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        job(&result, "one").failure.as_deref(),
        Some("authentication_required")
    );
    assert_eq!(job(&result, "two").acknowledged_records, 3);
    retry_job(&fixture.conn, &first.job_id).unwrap();

    let upgraded = Fake {
        mapping: "2".into(),
        ..Fake::default()
    };
    let result = run(
        &fixture.path(),
        &one(&upgraded),
        &DrainOptions {
            job_ids: Some(vec![first.job_id.clone()]),
            ..options()
        },
    );
    assert_eq!(result.statuses.len(), 1);
    assert_eq!(
        result.statuses[0].failure.as_deref(),
        Some("mapping_version_mismatch")
    );
    assert_eq!(result.statuses[0].pending_records, 3);
}

#[test]
fn an_unregistered_destination_is_reported_once_in_the_host_json_shape() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let empty: HashMap<(String, String), Box<dyn Receiver>> = HashMap::new();
    let result = run(&fixture.path(), &empty, &options());
    assert_eq!(result.attempts, 0);
    assert_eq!(
        result.issues,
        vec![DrainIssue {
            job_id: job.job_id.clone(),
            code: DrainIssueCode::DestinationNotRegistered,
            detail: None,
        }]
    );
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["issues"][0]["jobId"], serde_json::json!(job.job_id));
    assert_eq!(value["issues"][0]["code"], "DESTINATION_NOT_REGISTERED");
    assert!(value["issues"][0].get("detail").is_none());
    assert!(value.get("retention").is_none());
    assert_eq!(
        value["statuses"][0]["job_id"],
        serde_json::json!(job.job_id)
    );
    assert_eq!(value["attempts"], serde_json::json!(0));
}

/// The lease this test claims under.
///
/// The keepalive renews with two thirds of the lease left, so the whole margin
/// for a scheduler stall plus a contended write is one lease. At 100 ms that
/// margin was shorter than a single step of the database's busy backoff, which
/// reaches 500 ms, and a 4-way-loaded machine lost it routinely — in both
/// directions: the claim lapsing and letting this test's "must not be
/// dispatched twice" receiver fire, or the renewal failing and turning a good
/// acknowledgment into a transient failure. Neither is the property under
/// test. A lease that can absorb one full backoff keeps the property intact —
/// the send below still outlives several lease lifetimes, so nothing but
/// renewal can hold the claim — without betting on thread wake-up latency.
const RENEWAL_LEASE_MS: i64 = 600;

/// The lease column for one job, read through the test's own connection.
fn lease_until_ms(conn: &Connection, job_id: &str) -> Option<i64> {
    conn.query_row(
        "SELECT lease_until_ms FROM delivery_jobs WHERE id = ?",
        params![job_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .unwrap()
}

#[test]
fn lease_renewal_prevents_a_concurrent_worker_from_dispatching_the_same_batch() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let sending = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let sends = Arc::new(AtomicUsize::new(0));
    let leased = DrainOptions {
        lease_ms: RENEWAL_LEASE_MS,
        request_timeout_ms: 15_000,
        ..options()
    };
    let worker = {
        let (path, sending, sends) = (fixture.path(), sending.clone(), sends.clone());
        let (leased, release) = (leased.clone(), release.clone());
        std::thread::spawn(move || {
            let slow = Fake {
                send: Box::new(move |_payload, batch| {
                    sends.fetch_add(1, SeqCst);
                    sending.store(true, SeqCst);
                    // Held until the concurrent claim has been observed rather
                    // than for a fixed span. The window is then exactly as long
                    // as the property needs: every extra millisecond is one
                    // more renewal that has to land, and buys nothing.
                    while !release.load(SeqCst) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Ok(ack(batch))
                }),
                ..Fake::default()
            };
            run(&path, &one(&slow), &leased)
        })
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while !sending.load(SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(sending.load(SeqCst), "the receiver never started sending");

    // Wait for a renewal that has actually been written and that carries the
    // claim a full lease past the one taken at dispatch. Every renewal stores
    // `now + lease_ms`, so `renewed >= claimed_until + lease_ms` is precisely
    // "the worker's own clock is past the original expiry" — the condition the
    // concurrent claim below has to race — established from the database
    // rather than from how promptly this thread happens to wake up.
    let claimed_until = lease_until_ms(&fixture.conn, &job.job_id)
        .expect("the dispatching worker holds a lease while sending");
    let expired = claimed_until + RENEWAL_LEASE_MS;
    while lease_until_ms(&fixture.conn, &job.job_id).is_some_and(|until| until < expired)
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(5));
    }
    let renewed = lease_until_ms(&fixture.conn, &job.job_id).expect("the lease is still held");
    assert!(
        renewed >= expired,
        "the keepalive never renewed past the original lease ({renewed} < {expired})"
    );
    assert!(
        !worker.is_finished(),
        "the first drain finished before the concurrent claim"
    );

    let blocked = Fake {
        send: Box::new(|_payload, _batch| panic!("a leased batch must not be dispatched twice")),
        ..Fake::default()
    };
    let second = run(&fixture.path(), &one(&blocked), &leased);
    assert_eq!(second.attempts, 0);
    release.store(true, SeqCst);
    let first = worker.join().unwrap();
    assert_eq!(first.attempts, 1);
    assert_eq!(first.statuses[0].acknowledged_records, 3);
    assert_eq!(sends.load(SeqCst), 1);
}

#[test]
fn eligibility_changed_while_mapping_is_rechecked_before_transport() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let sent = Arc::new(AtomicUsize::new(0));
    let excluding = Fake {
        prepare: {
            let path = fixture.path();
            Box::new(move |batch| {
                let conn = open_db(&path).unwrap();
                for session in SESSIONS {
                    set_session_excluded(
                        &conn,
                        &SessionIdentity {
                            source: "claude".into(),
                            session_id: session.into(),
                        },
                        true,
                    )
                    .unwrap();
                }
                Ok(body(batch))
            })
        },
        send: {
            let sent = sent.clone();
            Box::new(move |_payload, batch| {
                sent.fetch_add(1, SeqCst);
                Ok(ack(batch))
            })
        },
        ..Fake::default()
    };
    let result = run(&fixture.path(), &one(&excluding), &options());
    assert_eq!(sent.load(SeqCst), 0);
    assert_eq!(result.attempts, 1);
    assert_eq!(result.issues[0].code, DrainIssueCode::DeliveryStateFailed);
    retry_job(&fixture.conn, &job.job_id).unwrap();

    let suppressed = run(&fixture.path(), &one(&excluding), &options());
    assert_eq!(sent.load(SeqCst), 0);
    assert_eq!(suppressed.statuses[0].suppressed_records, 3);
    assert_eq!(suppressed.statuses[0].skipped_records, 0);
    assert_eq!(suppressed.statuses[0].acknowledged_records, 0);
}

#[test]
fn host_cancellation_returns_before_any_attempt() {
    let fixture = fixture();
    create_job(&fixture.conn, &config("one"), 0).unwrap();
    let untouched = Fake {
        prepare: Box::new(|_batch| panic!("a cancelled drain must not map a payload")),
        send: Box::new(|_payload, _batch| panic!("a cancelled drain must not send")),
        ..Fake::default()
    };
    let result = drain(
        &fixture.path(),
        &one(&untouched),
        &options(),
        &system_clock,
        &|| true,
    )
    .unwrap();
    assert_eq!(result.attempts, 0);
    assert_eq!(result.issues, vec![]);
    assert_eq!(result.statuses[0].pending_records, 0);
}

#[test]
fn invalid_selections_and_bounds_are_invalid_arguments() {
    let fixture = fixture();
    create_job(&fixture.conn, &config("one"), 0).unwrap();
    let receiver = Fake::default();
    let failure = |options: DrainOptions| {
        drain(
            &fixture.path(),
            &one(&receiver),
            &options,
            &system_clock,
            &|| false,
        )
        .unwrap_err()
        .to_string()
    };
    assert!(failure(DrainOptions {
        job_ids: Some(vec!["missing".into()]),
        ..options()
    })
    .starts_with("INVALID_ARGUMENT: unknown delivery job selection"));
    for invalid in [
        DrainOptions {
            max_batches: 0,
            ..options()
        },
        DrainOptions {
            max_prepare_steps: 10_001,
            ..options()
        },
        DrainOptions {
            lease_ms: 29,
            ..options()
        },
        DrainOptions {
            request_timeout_ms: 0,
            ..options()
        },
        DrainOptions {
            max_elapsed: Some(Duration::ZERO),
            ..options()
        },
        DrainOptions {
            max_elapsed: Some(Duration::from_millis(86_400_001)),
            ..options()
        },
    ] {
        assert!(failure(invalid).starts_with("INVALID_ARGUMENT:"));
    }
}

/// A time-bounded drain against a large backlog keeps attempting batches for
/// as long as its wall-clock budget lasts, so throughput follows the backlog
/// instead of a fixed batch count; the count bounds stay as ceilings. The
/// budget here is the longest a drain accepts, so it never expires on any
/// host and the backlog alone decides when the drain ends; stopping once a
/// budget passes is proven by the test below.
#[test]
fn a_time_bounded_drain_delivers_a_backlog_beyond_a_fixed_batch_count() {
    let fixture = fixture();
    for n in 0..3_000 {
        fixture.conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','both',?1,43,'user','text','backlog')",params![format!("backlog-{n}")]).unwrap();
    }
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let receiver = Fake::default();
    let result = run(
        &fixture.path(),
        &one(&receiver),
        &DrainOptions {
            max_elapsed: Some(Duration::from_millis(86_400_000)),
            max_batches: 1_000,
            max_prepare_steps: 1_000,
            ..options()
        },
    );
    assert!(result.attempts > 8, "attempts: {}", result.attempts);
    assert_eq!(result.issues, vec![]);
    assert_eq!(result.statuses[0].job_id, job.job_id);
    assert_eq!(result.statuses[0].pending_records, 0);
    assert_eq!(result.statuses[0].unqueued_changes, 0);
    assert_eq!(result.statuses[0].acknowledged_records, 3_003);
}

/// The budget bounds how long a drain keeps going, not whether it goes at all.
/// Whatever the host and the clock are doing, a drain with deliverable work
/// makes at least one attempt and records it normally, and a budget already
/// spent stops the next one: nothing acknowledged is lost either way.
#[test]
fn a_drain_stops_starting_attempts_once_its_time_budget_has_passed() {
    // A budget the first attempt alone outlasts, and one that admits a few.
    for budget in [Duration::from_millis(1), Duration::from_millis(100)] {
        let fixture = fixture();
        for n in 0..500 {
            fixture.conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','both',?1,43,'user','text','backlog')",params![format!("backlog-{n}")]).unwrap();
        }
        create_job(&fixture.conn, &config("one"), 0).unwrap();
        let receiver = Fake {
            send: Box::new(|_payload, batch| {
                std::thread::sleep(Duration::from_millis(40));
                Ok(ack(batch))
            }),
            ..Fake::default()
        };
        let result = run(
            &fixture.path(),
            &one(&receiver),
            &DrainOptions {
                max_elapsed: Some(budget),
                max_batches: 1_000,
                max_prepare_steps: 1_000,
                ..options()
            },
        );
        assert!(
            result.attempts >= 1 && result.attempts < 6,
            "attempts: {} on a {budget:?} budget",
            result.attempts
        );
        assert_eq!(result.issues, vec![]);
        assert_eq!(
            result.statuses[0].acknowledged_records,
            result.attempts as i64 * 100
        );
        // Unscanned bootstrap rows remain: the budget, not the backlog, ended it.
        assert!(!result.statuses[0].bootstrap_complete);
        assert!(result.statuses[0].failure.is_none());
    }
}

/// Scanning is bounded by the same budget as delivery. A job whose rows are
/// all withheld produces no batch and no attempt, so nothing but the clock
/// stops it walking the whole feed a prepare step at a time.
#[test]
fn a_drain_stops_scanning_once_its_time_budget_has_passed() {
    let fixture = fixture();
    let mut job_config = config("one");
    job_config.limits.max_scan_records = 5;
    let job = create_job(&fixture.conn, &job_config, 0).unwrap();
    for n in 0..2_000 {
        fixture.conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','both',?1,43,'user','text','withheld')",params![format!("withheld-{n}")]).unwrap();
    }
    for session in SESSIONS {
        set_session_excluded(
            &fixture.conn,
            &SessionIdentity {
                source: "claude".into(),
                session_id: (*session).into(),
            },
            true,
        )
        .unwrap();
    }
    let receiver = Fake::default();
    let result = run(
        &fixture.path(),
        &one(&receiver),
        &DrainOptions {
            max_elapsed: Some(Duration::from_millis(1)),
            max_batches: 1_000,
            max_prepare_steps: 1_000,
            ..options()
        },
    );
    assert_eq!(result.attempts, 0);
    assert_eq!(result.issues, vec![]);
    assert_eq!(result.statuses[0].job_id, job.job_id);
    assert_eq!(result.statuses[0].acknowledged_records, 0);
    // Five rows a step: the deadline stopped the scan long before the steps
    // that would walk the feed, and after at least one of them.
    let scanned: i64 = fixture
        .conn
        .query_row(
            "SELECT COUNT(*) FROM session_events WHERE event_uid LIKE 'withheld-%' AND revision<=?",
            [result.statuses[0].journal_cursor],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        (1..=1_000).contains(&scanned),
        "scanned: {scanned} of 2 000 withheld rows"
    );
}

/// Prepare and claim one batch, the way the drain loop does. `create_job`
/// alone leaves nothing to claim: a batch has to be materialized first.
fn prepare_and_claim(conn: &Connection, job_id: &str, lease_ms: i64) -> ClaimedBatch {
    for _ in 0..100 {
        let now = system_clock();
        if prepare_batch(conn, job_id, now).unwrap().batch_id.is_some() {
            return claim_batch(conn, job_id, "worker", lease_ms, &|| now)
                .unwrap()
                .expect("a prepared batch is claimable");
        }
    }
    panic!("bounded fixture failed to produce a batch")
}

/// A renewal blocked past the deadline must not report a lease it does not
/// hold.
///
/// `renew_lease` used to take its timestamp before asking for the write lock.
/// Acquiring that lock can block for as long as the connection's busy policy
/// allows, so the value it then committed was `stale_now + lease_ms` - for any
/// wait longer than the lease, a deadline already in the past - and it
/// returned `Ok`. The keepalive recorded a renewed lease it did not have while
/// another worker was free to reclaim the batch mid-send: a well-formed answer
/// computed over nothing.
#[test]
fn a_renewal_blocked_past_the_deadline_never_reports_a_lease_in_the_past() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let lease_ms = 100;
    let hold = Duration::from_millis(lease_ms as u64 * 6);
    let claim = prepare_and_claim(&fixture.conn, &job.job_id, lease_ms);

    // Hold the write lock for several lease lengths, then release it on a
    // timer. The renewal below therefore blocks, and by the time it commits, a
    // timestamp taken before the block is long stale.
    let path = fixture.path();
    let (locked, lock_taken) = std::sync::mpsc::channel();
    let holding = std::thread::spawn(move || {
        let blocker = open_db(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        locked.send(system_clock()).unwrap();
        std::thread::sleep(hold);
        blocker.execute_batch("ROLLBACK").unwrap();
    });
    // The renewal asks for the lock only once the blocker holds it; a sleep
    // here is a race on a loaded box, and losing it makes the renewal return
    // at once with an honest deadline the assertion below would misread.
    let taken_at = lock_taken.recv().unwrap();

    let renewer = open_db(&fixture.path()).unwrap();
    let renewed = renew_lease(&renewer, &claim.lease, lease_ms, &system_clock)
        .expect("the lock is released well inside the busy policy");
    holding.join().unwrap();

    // The lock was released no earlier than `hold` after the blocker took
    // it. A clock read after the block therefore dates the deadline at or
    // beyond `taken_at + hold + lease_ms`; a clock read before it dates it
    // at most `taken_at + lease_ms` plus the few ms between the lock and the
    // ask, five lease lengths short. Asserting against the release time
    // rather than "still unexpired now" keeps the test honest on a loaded
    // box, where the return itself can be delayed past a 100 ms lease.
    let released_no_earlier_than = taken_at + hold.as_millis() as i64;
    assert!(
        renewed.expires_at_ms >= released_no_earlier_than + lease_ms,
        "renewal dated its deadline from before the block: {} < {} + {lease_ms}; \
         the clock was read before a {}ms wait for the lock",
        renewed.expires_at_ms,
        released_no_earlier_than,
        hold.as_millis(),
    );
    assert_eq!(
        lease_until_ms(&fixture.conn, &job.job_id),
        Some(renewed.expires_at_ms),
        "the stored deadline must be the one the caller was told about"
    );
}

/// A lapsed lease that nobody took is still this worker's claim.
///
/// `check_lease` used to require `lease_until_ms > now`, which reads an expiry
/// nobody acted on as "the claim is gone". Expiry is a signal to *other*
/// workers that an abandoned batch may be stolen, and `claim_batch` enforces
/// it; every takeover bumps the fence, so the fence alone proves ownership.
/// Conflating the two meant a worker could not record its own outcome after
/// its lease lapsed — which is how a panicking receiver stopped producing a
/// `transient` failure under load.
#[test]
fn an_expired_but_unclaimed_lease_can_still_record_its_own_outcome() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let claim = prepare_and_claim(&fixture.conn, &job.job_id, 30);
    // Past the deadline, with no second worker anywhere near it.
    std::thread::sleep(Duration::from_millis(60));

    let status = record_failure(
        &fixture.conn,
        &claim.lease,
        DeliveryFailure::Transient,
        None,
        &system_clock,
    )
    .expect("an unclaimed batch is still ours to fail");
    assert_eq!(status.failure.as_deref(), Some("transient"));

    // A batch that really was taken is still refused. `claim_batch` bumps the
    // fence, which is what the check now rests on.
    //
    // The takeover is a precondition, not something to check for and step
    // around: guarding the assertion on `stolen.is_some()` would let a
    // regression that stops the second worker claiming anything at all make
    // this test pass without testing its subject. It is deterministic here --
    // the failure above took `attempts` to 1, so the backoff is 2000 ms plus
    // at most 400 ms of jitter, well inside the 10 s horizon below, and the
    // batch is `retry_wait` under an `active` job, which is what `claim_batch`
    // requires.
    let stolen = claim_batch(&fixture.conn, &job.job_id, "other", 30, &|| {
        system_clock() + 10_000
    })
    .unwrap()
    .expect("a retry_wait batch is claimable once its backoff has passed");
    assert_ne!(
        stolen.lease.fence, claim.lease.fence,
        "a takeover bumps the fence; that is the whole ownership proof"
    );
    assert!(
        record_failure(
            &fixture.conn,
            &claim.lease,
            DeliveryFailure::Transient,
            None,
            &system_clock,
        )
        .is_err(),
        "a fenced lease must not be able to move another worker's state"
    );
}

/// The fence proves ownership only for as long as the transaction that read
/// it. `validate_dispatch` commits before the receiver sends, so an expired
/// lease that passed it could be claimed by another worker in the gap and the
/// batch sent twice. Before transport the lease must therefore still be live;
/// after transport (the test above) ownership alone is enough.
#[test]
fn an_expired_lease_cannot_gate_a_dispatch_it_may_no_longer_own() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    // A long lease, and the clock is driven explicitly rather than slept
    // past: every gate takes `now_ms`, so expiry is a value, not a race.
    let claim = prepare_and_claim(&fixture.conn, &job.job_id, 60_000);
    let live = claim.lease.expires_at_ms - 1;
    let expired = claim.lease.expires_at_ms;
    let body = serde_json::to_string(&claim.batch).unwrap();
    store_prepared_payload(
        &fixture.conn,
        &claim.lease,
        &claim.batch.mapping_version,
        "application/json",
        &body,
        &|| live,
    )
    .expect("a live lease persists its payload");
    validate_dispatch(&fixture.conn, &claim.lease, &|| live).expect("a live lease validates");

    // At the deadline, still unclaimed. Ownership holds; liveness does not.
    let refused = validate_dispatch(&fixture.conn, &claim.lease, &|| expired)
        .expect_err("an expired lease must not be handed to transport");
    assert!(
        refused.to_string().contains("expired before dispatch"),
        "unexpected refusal: {refused}"
    );
    assert!(
        store_prepared_payload(
            &fixture.conn,
            &claim.lease,
            &claim.batch.mapping_version,
            "application/json",
            &body,
            &|| expired,
        )
        .is_err(),
        "an expired lease must not persist a payload it may not get to send"
    );

    // The very gap the gate exists for: another worker can take it now …
    let stolen = claim_batch(&fixture.conn, &job.job_id, "other", 30_000, &|| expired)
        .unwrap()
        .expect("an expired batch is claimable by another worker");
    assert_ne!(stolen.lease.fence, claim.lease.fence);
    // … and a renewal by the first worker is then a fence mismatch, not a
    // resurrection: renewal only revives a lease nobody has claimed.
    assert!(renew_lease(&fixture.conn, &claim.lease, 30, &|| expired).is_err());
}

/// The live check is only as good as the clock it reads. `validate_dispatch`
/// used to take `now_ms` as a value the worker sampled before calling it, so
/// a wait for the write lock longer than the lease validated against a
/// timestamp from before the wait, and an expired lease was handed to
/// transport. The clock is read inside the transaction now, as renewal's is.
#[test]
fn a_validation_blocked_past_the_deadline_is_refused_not_dated_from_before_it() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let lease_ms = 100;
    let hold = Duration::from_millis(lease_ms as u64 * 6);
    let claim = prepare_and_claim(&fixture.conn, &job.job_id, lease_ms);
    // The setup is dated from the claim itself, not from the wall clock: on a
    // loaded runner the few statements between claiming and persisting can
    // outlast a 100 ms lease, and the store would then be refused for a
    // reason this test is not about. The liveness under test is the one the
    // validator reads inside the lock below, and that one stays on the wall
    // clock.
    let claimed_at = claim.lease.expires_at_ms - lease_ms;
    store_prepared_payload(
        &fixture.conn,
        &claim.lease,
        &claim.batch.mapping_version,
        "application/json",
        &serde_json::to_string(&claim.batch).unwrap(),
        &|| claimed_at,
    )
    .expect("a live lease persists its payload");

    let path = fixture.path();
    let (locked, lock_taken) = std::sync::mpsc::channel();
    let holding = std::thread::spawn(move || {
        let blocker = open_db(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        locked.send(()).unwrap();
        std::thread::sleep(hold);
        blocker.execute_batch("ROLLBACK").unwrap();
    });
    lock_taken.recv().unwrap();

    // Asked while the lease is live, answered after it has lapsed. A clock
    // sampled before the wait would say "live"; the one read inside the
    // lock says the truth.
    let validator = open_db(&fixture.path()).unwrap();
    let refused = validate_dispatch(&validator, &claim.lease, &system_clock)
        .expect_err("a lease that lapsed during the wait must not be handed to transport");
    holding.join().unwrap();
    assert!(
        refused.to_string().contains("expired before dispatch"),
        "unexpected refusal: {refused}"
    );
    // Positive control: nothing but the clock reading refused it. Dated from
    // the claim, the same lease still validates, so the refusal above came
    // from reading the clock inside the lock and not from any other change
    // to the lease.
    validate_dispatch(&validator, &claim.lease, &|| claimed_at)
        .expect("the lease is refused only by a clock read after the wait");
}

/// Recording an outcome needs only ownership, so an expired but unclaimed
/// worker may still record its own failure — which is exactly why the clock
/// has to be read inside the lock. `apply_failure` schedules the next attempt
/// from `now_ms`, and a value sampled before a wait longer than the backoff
/// commits a retry that is already overdue: the batch is claimable the moment
/// the transaction commits, and backoff is defeated by the one condition it
/// exists for.
#[test]
fn a_failure_recorded_after_a_lock_wait_is_scheduled_from_after_it() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let lease_ms = 100;
    let hold = Duration::from_millis(lease_ms as u64 * 10);
    let claim = prepare_and_claim(&fixture.conn, &job.job_id, lease_ms);

    // Sampled before the lock is even taken, so the hold is entirely after it.
    let before = system_clock();
    let path = fixture.path();
    let (locked, lock_taken) = std::sync::mpsc::channel();
    let holding = std::thread::spawn(move || {
        let blocker = open_db(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        locked.send(()).unwrap();
        std::thread::sleep(hold);
        blocker.execute_batch("ROLLBACK").unwrap();
    });
    lock_taken.recv().unwrap();

    // Asked before the wait, committed after it. A clock read inside the
    // lock dates the retry from after the hold.
    let recorder = open_db(&fixture.path()).unwrap();
    let status = record_failure(
        &recorder,
        &claim.lease,
        DeliveryFailure::Transient,
        None,
        &system_clock,
    )
    .expect("an unclaimed batch is still ours to fail");
    holding.join().unwrap();
    assert_eq!(status.failure.as_deref(), Some("transient"));
    let (next_attempt_ms, attempts): (i64, i64) = recorder
        .query_row(
            "SELECT next_attempt_ms, attempts FROM delivery_jobs WHERE id=?",
            [&job.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    // Backoff doubles per attempt (the claim counts as one) and jitter is at
    // most a fifth of it. A clock sampled before the wait can schedule no
    // later than `before + backoff * 6 / 5`; one read inside the lock
    // schedules no earlier than `before + hold + backoff`, and the hold is
    // longer than the jitter can be.
    let backoff = 1_000 << attempts;
    let earliest = before + hold.as_millis() as i64 + backoff;
    assert!(
        next_attempt_ms >= earliest,
        "retry scheduled from before the lock wait: next {next_attempt_ms} < {earliest}"
    );

    // Positive control: the retry is dated from the clock the call was given
    // and nothing else. With a deterministic clock and no wait, the same
    // path schedules exactly one backoff (plus bounded jitter) after it.
    let other = create_job(&fixture.conn, &config("two"), 0).unwrap();
    let claim = prepare_and_claim(&fixture.conn, &other.job_id, lease_ms);
    record_failure(
        &fixture.conn,
        &claim.lease,
        DeliveryFailure::Transient,
        None,
        &|| 5_000,
    )
    .unwrap();
    let (scheduled, attempts): (i64, i64) = fixture
        .conn
        .query_row(
            "SELECT next_attempt_ms, attempts FROM delivery_jobs WHERE id=?",
            [&other.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    // Backoff doubles per attempt (the claim counts as one) and jitter is at
    // most a fifth of it, so the window below is dated from the given clock
    // and nothing else.
    let backoff = 1_000 << attempts;
    assert!(
        (5_000 + backoff..=5_000 + backoff + backoff / 5).contains(&scheduled),
        "retry not dated from the given clock: {scheduled} (attempts {attempts})"
    );
}

/// Partial acceptance schedules a retry, so an acknowledgment reads its clock
/// inside the lock for the same reason a failure does.
#[test]
fn a_partial_acknowledgment_after_a_lock_wait_is_scheduled_from_after_it() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let lease_ms = 100;
    let hold = Duration::from_millis(lease_ms as u64 * 10);
    let claim = prepare_and_claim(&fixture.conn, &job.job_id, lease_ms);
    let claimed_at = claim.lease.expires_at_ms - lease_ms;
    store_prepared_payload(
        &fixture.conn,
        &claim.lease,
        &claim.batch.mapping_version,
        "application/json",
        &serde_json::to_string(&claim.batch).unwrap(),
        &|| claimed_at,
    )
    .expect("a live lease persists its payload");
    let mut partial = ack(&claim.batch);
    partial.accepted_revision_ids.pop();

    // Sampled before the lock is even taken, so the hold is entirely after it.
    let before = system_clock();
    let path = fixture.path();
    let (locked, lock_taken) = std::sync::mpsc::channel();
    let holding = std::thread::spawn(move || {
        let blocker = open_db(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        locked.send(()).unwrap();
        std::thread::sleep(hold);
        blocker.execute_batch("ROLLBACK").unwrap();
    });
    lock_taken.recv().unwrap();

    let acker = open_db(&fixture.path()).unwrap();
    let status = acknowledge(&acker, &claim.lease, &partial, &system_clock)
        .expect("a partial acknowledgment is recorded as a transient failure");
    holding.join().unwrap();
    assert_eq!(status.failure.as_deref(), Some("transient"));
    let (next_attempt_ms, attempts): (i64, i64) = acker
        .query_row(
            "SELECT next_attempt_ms, attempts FROM delivery_jobs WHERE id=?",
            [&job.job_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    // Backoff doubles per attempt (the claim counts as one) and jitter is at
    // most a fifth of it. A clock sampled before the wait can schedule no
    // later than `before + backoff * 6 / 5`; one read inside the lock
    // schedules no earlier than `before + hold + backoff`, and the hold is
    // longer than the jitter can be.
    let backoff = 1_000 << attempts;
    let earliest = before + hold.as_millis() as i64 + backoff;
    assert!(
        next_attempt_ms >= earliest,
        "retry scheduled from before the lock wait: next {next_attempt_ms} < {earliest}"
    );
}

/// A claim's deadline is computed from the clock, and the clock used to be
/// read before the write lock was asked for. A claim that waited longer than
/// its lease then committed a deadline already in the past and reported
/// success: the pre-transport checks refused the lease and another worker
/// reclaimed the batch at once. The deadline is now dated from inside the
/// lock, so a lease means what it says whatever the claim waited.
#[test]
fn a_claim_blocked_past_its_lease_is_dated_from_after_the_wait() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    // The lease is long and the hold short, on purpose: the deadline must be
    // dated after the hold whatever the lease length, and a long lease keeps
    // the liveness check below from expiring under scheduling delay.
    let lease_ms = 5_000;
    let hold = Duration::from_millis(1_000);
    for _ in 0..100 {
        if prepare_batch(&fixture.conn, &job.job_id, system_clock())
            .unwrap()
            .batch_id
            .is_some()
        {
            break;
        }
    }

    // Sampled before the lock is even taken, so the hold is entirely after it.
    let before = system_clock();
    let path = fixture.path();
    let (locked, lock_taken) = std::sync::mpsc::channel();
    let holding = std::thread::spawn(move || {
        let blocker = open_db(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        locked.send(()).unwrap();
        std::thread::sleep(hold);
        blocker.execute_batch("ROLLBACK").unwrap();
    });
    lock_taken.recv().unwrap();

    let claimer = open_db(&fixture.path()).unwrap();
    let claim = claim_batch(&claimer, &job.job_id, "worker", lease_ms, &system_clock)
        .unwrap()
        .expect("a prepared batch is claimable");
    holding.join().unwrap();
    let earliest = before + hold.as_millis() as i64 + lease_ms;
    assert!(
        claim.lease.expires_at_ms >= earliest,
        "lease dated from before the lock wait: expires {} < {earliest}",
        claim.lease.expires_at_ms
    );
    // And it is a lease the worker can actually use: live, not already lapsed.
    validate_dispatch(&claimer, &claim.lease, &system_clock)
        .map(|_| ())
        .or_else(|error| {
            // A payload has not been persisted yet; only an expiry refusal is
            // a failure of this test.
            if error.to_string().contains("expired") {
                Err(error)
            } else {
                Ok(())
            }
        })
        .expect("a lease dated inside the lock is live when it is handed back");

    // Positive control: the deadline is the given clock plus the lease and
    // nothing else, so the assertion above cannot be met by padding.
    let other = create_job(&fixture.conn, &config("two"), 0).unwrap();
    for _ in 0..100 {
        if prepare_batch(&fixture.conn, &other.job_id, 5_000)
            .unwrap()
            .batch_id
            .is_some()
        {
            break;
        }
    }
    let claim = claim_batch(&fixture.conn, &other.job_id, "worker", lease_ms, &|| 5_000)
        .unwrap()
        .expect("a prepared batch is claimable");
    assert_eq!(claim.lease.expires_at_ms, 5_000 + lease_ms);
}

#[test]
fn a_panicking_receiver_is_a_transient_failure_and_releases_the_keepalive() {
    let fixture = fixture();
    create_job(&fixture.conn, &config("one"), 0).unwrap();
    let receiver = Fake {
        send: Box::new(|_payload, _batch| panic!("receiver bug")),
        ..Fake::default()
    };
    // A short lease so a keepalive thread that never saw `stop` would be
    // caught renewing rather than merely idle when the deadline below fires.
    let options = DrainOptions {
        lease_ms: 100,
        ..options()
    };
    let started = Instant::now();
    let result = run(&fixture.path(), &one(&receiver), &options);
    assert!(started.elapsed() < Duration::from_secs(10), "drain hung");
    assert_eq!(result.attempts, 1);
    assert_eq!(result.issues, vec![]);
    assert_eq!(result.statuses[0].failure.as_deref(), Some("transient"));
    assert_eq!(result.statuses[0].acknowledged_records, 0);
    assert_eq!(result.statuses[0].pending_records, 3);
}

#[test]
fn orderly_stops_release_claims_without_failure_or_backoff_and_resume_immediately() {
    for (during_send, completed_send) in [(false, false), (true, false), (true, true)] {
        let fixture = fixture();
        let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let receiver = Fake {
            prepare: {
                let stopped = stopped.clone();
                Box::new(move |batch| {
                    if !during_send {
                        stopped.store(true, SeqCst);
                    }
                    Ok(body(batch))
                })
            },
            send: {
                let stopped = stopped.clone();
                Box::new(move |_, batch| {
                    assert!(during_send, "stop before send must prevent transport");
                    stopped.store(true, SeqCst);
                    if completed_send {
                        Ok(ack(batch))
                    } else {
                        Err(DeliveryFailure::Transient.into())
                    }
                })
            },
            ..Fake::default()
        };
        for _ in 0..3 {
            stopped.store(false, SeqCst);
            let result = drain(
                &fixture.path(),
                &one(&receiver),
                &options(),
                &system_clock,
                &|| stopped.load(SeqCst),
            )
            .unwrap();
            assert!(stopped.load(SeqCst));
            assert!(result.issues.is_empty());
            let status = &result.statuses[0];
            assert_eq!(status.failure, None);
            assert_eq!(status.next_attempt_ms, 0);
            assert_eq!(status.acknowledged_records, 0);
            assert_eq!(status.pending_records, 3);
            let attempts: i64 = fixture
                .conn
                .query_row(
                    "SELECT attempts FROM delivery_jobs WHERE id=?",
                    [&job.job_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(attempts, 0, "stops must not accumulate exponential retries");
        }
        let receiver = Fake {
            prepare: Box::new(move |batch| {
                assert!(
                    !during_send,
                    "reuse the already persisted body after interrupted transport"
                );
                Ok(body(batch))
            }),
            ..Fake::default()
        };
        let resumed = run(&fixture.path(), &one(&receiver), &options());
        assert!(resumed.issues.is_empty());
        assert_eq!(resumed.statuses[0].acknowledged_records, 3);
    }
}

#[test]
fn host_stop_does_not_overwrite_a_new_workers_claim() {
    let fixture = fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let replacement = Arc::new(Mutex::new(None));
    let receiver = Fake {
        prepare: {
            let (path, job_id) = (fixture.path(), job.job_id.clone());
            let (stopped, replacement) = (stopped.clone(), replacement.clone());
            Box::new(move |batch| {
                let conn = open_db(&path).unwrap();
                conn.execute(
                    "UPDATE delivery_jobs SET lease_until_ms=0 WHERE id=?",
                    [&job_id],
                )
                .unwrap();
                *replacement.lock().unwrap() = Some(
                    claim_batch(&conn, &job_id, "replacement", 60_000, &system_clock)
                        .unwrap()
                        .unwrap(),
                );
                stopped.store(true, SeqCst);
                Ok(body(batch))
            })
        },
        send: Box::new(|_, _| panic!("fenced worker must not send")),
        ..Fake::default()
    };
    let result = drain(
        &fixture.path(),
        &one(&receiver),
        &options(),
        &system_clock,
        &|| stopped.load(SeqCst),
    )
    .unwrap();
    assert_eq!(result.issues[0].code, DrainIssueCode::DeliveryStateFailed);
    let replacement = replacement.lock().unwrap();
    let claim = replacement.as_ref().unwrap();
    // Still owns the live lease: stale cancellation must not change its fence,
    // state, retry count or prepared body.
    renew_lease(&fixture.conn, &claim.lease, 60_000, &system_clock).unwrap();
    let attempts: i64 = fixture
        .conn
        .query_row(
            "SELECT attempts FROM delivery_jobs WHERE id=?",
            [&job.job_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(attempts, 2);
    assert_eq!(result.statuses[0].failure, None);
}

#[test]
fn host_stop_preserves_explicit_receiver_retry_after() {
    let fixture = fixture();
    create_job(&fixture.conn, &config("one"), 0).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let retry_at = system_clock() + 60_000;
    let receiver = Fake {
        send: {
            let stopped = stopped.clone();
            Box::new(move |_, _| {
                stopped.store(true, SeqCst);
                Err(ReceiverFailure {
                    failure: DeliveryFailure::RateLimited,
                    retry_after_ms: Some(retry_at),
                    recovery: None,
                })
            })
        },
        ..Fake::default()
    };
    let result = drain(
        &fixture.path(),
        &one(&receiver),
        &options(),
        &system_clock,
        &|| stopped.load(SeqCst),
    )
    .unwrap();
    assert_eq!(result.statuses[0].failure.as_deref(), Some("rate_limited"));
    assert!(result.statuses[0].next_attempt_ms >= retry_at);
}

#[test]
fn a_stop_after_the_outcome_decision_does_not_turn_success_into_failure() {
    let fixture = fixture();
    create_job(&fixture.conn, &config("one"), 0).unwrap();
    let sent = Arc::new(AtomicBool::new(false));
    let polls_after_send = AtomicUsize::new(0);
    let receiver = Fake {
        send: {
            let sent = sent.clone();
            Box::new(move |_, batch| {
                sent.store(true, SeqCst);
                Ok(ack(batch))
            })
        },
        ..Fake::default()
    };
    let result = drain(
        &fixture.path(),
        &one(&receiver),
        &options(),
        &system_clock,
        &|| sent.load(SeqCst) && polls_after_send.fetch_add(1, SeqCst) > 0,
    )
    .unwrap();
    assert!(result.issues.is_empty());
    assert_eq!(result.statuses[0].acknowledged_records, 3);
    assert_eq!(result.statuses[0].failure, None);
    assert_eq!(result.statuses[0].next_attempt_ms, 0);
}

#[test]
fn reinclusion_backfills_again_and_keeps_the_consented_pending_batch() {
    let fixture = fixture();
    let mut cfg = config("one");
    cfg.selection.all_sources = true;
    cfg.selection.sources.clear();
    let job = create_session_job(&fixture.conn, &cfg, 0).unwrap();
    let session = SessionIdentity {
        source: "claude".into(),
        session_id: SESSIONS[0].into(),
    };
    set_job_session(&fixture.conn, &job.job_id, &session, true).unwrap();
    prepare_batch(&fixture.conn, &job.job_id, system_clock()).unwrap();
    let old = claim_batch(
        &fixture.conn,
        &job.job_id,
        "original",
        60_000,
        &system_clock,
    )
    .unwrap()
    .unwrap();
    store_prepared_payload(
        &fixture.conn,
        &old.lease,
        "1",
        "application/json",
        "{}",
        &system_clock,
    )
    .unwrap();
    let leased = run(&fixture.path(), &one(&Fake::default()), &options());
    assert_eq!(leased.attempts, 0);
    assert!(leased.issues.is_empty());
    set_job_session(&fixture.conn, &job.job_id, &session, false).unwrap();
    set_job_session(&fixture.conn, &job.job_id, &session, true).unwrap();
    // The pending batch is still consented, so it goes as it was prepared;
    // the new membership then backfills the session again at the same,
    // unchanged revision, which the receiver accepts idempotently.
    let old_revision = old.batch.records[0].revision_id.clone();
    let fake = Fake {
        send: Box::new(move |_, batch| {
            assert_eq!(batch.records.len(), 1);
            assert_eq!(batch.records[0].revision_id, old_revision);
            Ok(ack(batch))
        }),
        ..Fake::default()
    };
    let delivered = run(&fixture.path(), &one(&fake), &options());
    assert_eq!(delivered.attempts, 2);
    assert!(delivered.issues.is_empty());
    assert_eq!(delivered.statuses[0].acknowledged_records, 2);
}

/// The prepared limit bounds the destination body as retained, so a body that
/// serializes past it is the receiver's invalid payload rather than a capacity
/// failure: nothing is stored and the job blocks. A body whose retained size
/// is exactly the limit is delivered, and every stored row stays inside the
/// share the reserve gives it.
#[test]
fn a_body_that_exceeds_the_stored_prepared_limit_is_the_receivers_invalid_payload() {
    let fixture = fixture();
    let limits = DeliveryLimits {
        max_prepared_bytes: 4_096,
        ..DeliveryLimits::default()
    };
    let job = create_job(
        &fixture.conn,
        &DeliveryJobConfig {
            limits: limits.clone(),
            ..config("one")
        },
        0,
    )
    .unwrap();
    let escaped = |len: usize| {
        Box::new(move |_: &HistoryExportBatch| {
            Ok(PreparedBody {
                content_type: "application/json".into(),
                body: "\"".repeat(len),
            })
        })
    };

    // Under the limit as a body, over it once escaped and enveloped.
    let oversized = Fake {
        prepare: escaped(4_096),
        send: Box::new(|_, _| panic!("a payload the limit refused is never sent")),
        ..Fake::default()
    };
    let refused = run(&fixture.path(), &one(&oversized), &options());
    assert!(refused.issues.is_empty(), "not a capacity failure");
    assert_eq!(refused.statuses[0].state, "blocked");
    assert_eq!(
        refused.statuses[0].failure.as_deref(),
        Some("invalid_payload")
    );
    assert_eq!(refused.statuses[0].acknowledged_records, 0);
    assert!(fixture
        .conn
        .query_row("SELECT prepared IS NULL FROM delivery_batches", [], |r| {
            r.get::<_, bool>(0)
        })
        .unwrap());

    // The same body one escaped character shorter fits exactly.
    retry_job(&fixture.conn, &job.job_id).unwrap();
    let envelope = PreparedPayload::stored("1", "application/json", "", Some(THIS_BUILD))
        .retained_bytes()
        .unwrap();
    let fitting = Fake {
        prepare: escaped((4_096 - envelope) / 2),
        ..Fake::default()
    };
    let delivered = run(&fixture.path(), &one(&fitting), &options());
    assert!(delivered.issues.is_empty());
    assert_eq!(delivered.statuses[0].acknowledged_records, 3);
    // Both stored columns stay within the per-row share the reserve assumes.
    let (payload, prepared): (i64, i64) = fixture.conn.query_row(
        "SELECT COALESCE(MAX(length(CAST(payload AS BLOB))),0),COALESCE(MAX(length(CAST(prepared AS BLOB))),0) FROM delivery_batches",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert!(payload <= limits.max_batch_bytes as i64);
    assert!(prepared <= limits.max_prepared_bytes as i64);
}

/// A body the worker stores from the receiver's own `prepare` reaches `send`
/// marked as prepared by this build, under the digest of exactly those
/// bytes; a body stored any other way reaches it unmarked.
#[test]
fn a_body_the_worker_prepared_reaches_send_marked_with_this_build() {
    use sha2::{Digest, Sha256};
    type Seen = Mutex<Vec<(Option<String>, bool)>>;
    fn recording(seen: &Arc<Seen>) -> SendFn {
        let seen = seen.clone();
        Box::new(move |payload, batch| {
            let digest = format!("{:x}", Sha256::digest(payload.body.as_bytes()));
            seen.lock()
                .unwrap()
                .push((payload.prepared_by.clone(), digest == payload.sha256));
            Ok(ack(batch))
        })
    }

    let fixture = fixture();
    create_job(&fixture.conn, &config("one"), 0).unwrap();
    let seen = Arc::new(Seen::default());
    let receiver = Fake {
        send: recording(&seen),
        ..Fake::default()
    };
    let delivered = run(&fixture.path(), &one(&receiver), &options());
    assert_eq!(delivered.issues, vec![]);
    assert_eq!(delivered.statuses[0].acknowledged_records, 3);
    assert_eq!(*seen.lock().unwrap(), [(Some(THIS_BUILD.to_owned()), true)]);

    let fixture = self::fixture();
    let job = create_job(&fixture.conn, &config("one"), 0).unwrap();
    let claim = prepare_and_claim(&fixture.conn, &job.job_id, 1);
    let claimed_at = claim.lease.expires_at_ms - 1;
    store_prepared_payload(
        &fixture.conn,
        &claim.lease,
        &claim.batch.mapping_version,
        "application/json",
        &body(&claim.batch).body,
        &|| claimed_at,
    )
    .unwrap();
    // The lease has lapsed, so the drain claims the stored batch again and
    // sends the body as it was stored.
    while system_clock() <= claim.lease.expires_at_ms {
        std::thread::sleep(Duration::from_millis(1));
    }
    let seen = Arc::new(Seen::default());
    let receiver = Fake {
        prepare: Box::new(|_| panic!("a stored body is never prepared again")),
        send: recording(&seen),
        ..Fake::default()
    };
    let delivered = run(&fixture.path(), &one(&receiver), &options());
    assert_eq!(delivered.issues, vec![]);
    assert_eq!(delivered.statuses[0].acknowledged_records, 3);
    assert_eq!(*seen.lock().unwrap(), [(None, true)]);
}

/// A drain reports what it moved and how long it took: counts, bytes and
/// durations only.
#[test]
fn a_drain_measures_its_batches_bytes_and_lag() {
    let fixture = fixture();
    for n in 0..250 {
        fixture.conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','both',?1,?2,'user','text','backlog')",params![format!("measured-{n}"), system_clock() - 60_000]).unwrap();
    }
    create_job(&fixture.conn, &config("one"), 0).unwrap();
    let receiver = Fake::default();
    let result = run(&fixture.path(), &one(&receiver), &options());
    let metrics = &result.metrics;
    assert_eq!(result.issues, vec![]);
    assert_eq!(metrics.batches_sent, result.attempts as u64);
    assert_eq!(metrics.batches_acknowledged, result.attempts as u64);
    assert_eq!(metrics.records_acknowledged, 253);
    assert!(metrics.bytes_sent > 0);
    assert!(metrics.send_ms_max <= metrics.send_ms_total);
    assert!(metrics.elapsed_ms >= metrics.send_ms_total);
    // The newest delivered record was written a minute before the drain.
    let lag = metrics.event_lag_ms.unwrap();
    assert!((60_000..600_000).contains(&lag), "{lag}");

    // A drain with nothing to send measures nothing but its own time.
    let idle = run(&fixture.path(), &one(&receiver), &options());
    assert_eq!(
        idle.metrics,
        DrainMetrics {
            elapsed_ms: idle.metrics.elapsed_ms,
            ..DrainMetrics::default()
        }
    );
}

type VerdictFn = Box<dyn Fn(&HistoryExportBatch, usize) -> Option<ReceiverFailure> + Sync>;
type MappingFn = Box<dyn Fn(&HistoryExportBatch) -> Result<PreparedBody, ReceiverFailure> + Sync>;
/// A receiver that may map and send from several threads at once, recording
/// how many mappings and sends overlapped, which batches it mapped, and how
/// often each batch was sent.
struct Concurrent {
    delay: Duration,
    in_flight: AtomicUsize,
    most: AtomicUsize,
    sends: Mutex<HashMap<String, usize>>,
    /// Decides a send's outcome from the batch and its send count so far.
    verdict: VerdictFn,
    /// Maps a batch.
    mapping: MappingFn,
    published: PublishedLimits,
    /// Sends wait, up to a second, until this many have overlapped once, so
    /// a loaded host cannot hide whether sends overlap at all.
    rendezvous: usize,
    /// The job's first batch finishes mapping only after another batch's
    /// mapping has returned, and then gives a send that does not wait for
    /// it [`SEND_GRACE`] to begin.
    first_maps_last: bool,
    mapping_now: AtomicUsize,
    most_mapping: AtomicUsize,
    /// Batch ids in the order their mappings returned.
    mapped: Mutex<Vec<String>>,
    /// Each mapped batch by id.
    batches: Mutex<HashMap<String, HistoryExportBatch>>,
    /// Each send's batch id, the digest of the body it was handed, and the
    /// batches mapped before it began.
    sent: Mutex<Vec<(String, String, HashSet<String>)>>,
}
impl Concurrent {
    fn new(delay: Duration) -> Self {
        Self {
            delay,
            in_flight: AtomicUsize::new(0),
            most: AtomicUsize::new(0),
            sends: Mutex::new(HashMap::new()),
            verdict: Box::new(|_, _| None),
            mapping: Box::new(|batch| Ok(body(batch))),
            published: PublishedLimits::default(),
            rendezvous: 0,
            first_maps_last: false,
            mapping_now: AtomicUsize::new(0),
            most_mapping: AtomicUsize::new(0),
            mapped: Mutex::new(Vec::new()),
            batches: Mutex::new(HashMap::new()),
            sent: Mutex::new(Vec::new()),
        }
    }
    fn sends(&self, batch_id: &str) -> usize {
        self.sends
            .lock()
            .unwrap()
            .get(batch_id)
            .copied()
            .unwrap_or(0)
    }
}
impl Receiver for Concurrent {
    fn mapping_version(&self) -> &str {
        "1"
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
        _: &ReceiverContext<'_>,
    ) -> Result<PreparedBody, ReceiverFailure> {
        let now = self.mapping_now.fetch_add(1, SeqCst) + 1;
        self.most_mapping.fetch_max(now, SeqCst);
        if self.first_maps_last && first_batch(batch) {
            let waiting = Instant::now();
            while self.mapped.lock().unwrap().is_empty() {
                assert!(
                    waiting.elapsed() < Duration::from_secs(30),
                    "no other batch was mapped"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
            // While sends keep claim order none begins here, and the grace
            // runs out; one that does not is seen by the test's order check.
            let grace = Instant::now();
            while self.sent.lock().unwrap().is_empty() && grace.elapsed() < SEND_GRACE {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        let mapped = (self.mapping)(batch);
        self.batches
            .lock()
            .unwrap()
            .insert(batch.batch_id.clone(), batch.clone());
        self.mapped.lock().unwrap().push(batch.batch_id.clone());
        self.mapping_now.fetch_sub(1, SeqCst);
        mapped
    }
    fn send(
        &self,
        payload: &PreparedPayload,
        batch: &HistoryExportBatch,
        _: &ReceiverContext<'_>,
    ) -> Result<DeliveryAcknowledgment, ReceiverFailure> {
        let mapped = self.mapped.lock().unwrap().iter().cloned().collect();
        self.sent
            .lock()
            .unwrap()
            .push((batch.batch_id.clone(), payload.sha256.clone(), mapped));
        let now = self.in_flight.fetch_add(1, SeqCst) + 1;
        self.most.fetch_max(now, SeqCst);
        let previous = {
            let mut sends = self.sends.lock().unwrap();
            let count = sends.entry(batch.batch_id.clone()).or_default();
            *count += 1;
            *count - 1
        };
        let waiting = Instant::now();
        while self.most.load(SeqCst) < self.rendezvous && waiting.elapsed() < Duration::from_secs(1)
        {
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(self.delay);
        self.in_flight.fetch_sub(1, SeqCst);
        match (self.verdict)(batch, previous) {
            Some(failure) => Err(failure),
            None => Ok(ack(batch)),
        }
    }
    fn concurrent(&self) -> Option<&(dyn Receiver + Sync)> {
        Some(self)
    }
    fn published_limits(&self, _: &LimitsContext<'_>) -> PublishedLimits {
        self.published
    }
}
/// How long the job's first batch, with [`Concurrent::first_maps_last`],
/// leaves a later batch's send to begin before its own mapping returns.
const SEND_GRACE: Duration = Duration::from_millis(200);
/// Whether `batch` is the job's first: it holds the fixture's first event.
fn first_batch(batch: &HistoryExportBatch) -> bool {
    batch
        .records
        .iter()
        .any(|record| record.payload["event_uid"] == "local-only")
}
/// Where a batch's first event sits in the fixture's feed: the fixture's own
/// events, then the backlog in order.
fn feed_position(batch: &HistoryExportBatch) -> usize {
    batch
        .records
        .iter()
        .map(|record| {
            let event = record.payload["event_uid"].as_str().unwrap();
            match event.strip_prefix("backlog-") {
                Some(n) => SESSIONS.len() + n.parse::<usize>().unwrap(),
                None => SESSIONS.iter().position(|s| *s == event).unwrap(),
            }
        })
        .min()
        .unwrap()
}
/// A fixture with `events` more session events, and a job over it whose
/// batches hold `per_batch` records.
fn backlog(events: usize, per_batch: usize) -> (Fixture, String) {
    let fixture = fixture();
    for n in 0..events {
        fixture.conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','both',?1,42,'user','text','backlog')",params![format!("backlog-{n}")]).unwrap();
    }
    let mut config = config("one");
    config.limits.max_batch_records = per_batch;
    let job = create_job(&fixture.conn, &config, 0).unwrap().job_id;
    (fixture, job)
}
fn pipelined(window: usize) -> DrainOptions {
    DrainOptions {
        max_in_flight: window,
        ..options()
    }
}

#[test]
fn each_send_recomputes_its_timeout_from_the_absolute_deadline() {
    struct DeadlineReceiver {
        timeouts: Mutex<Vec<i64>>,
    }
    impl Receiver for DeadlineReceiver {
        fn mapping_version(&self) -> &str {
            "1"
        }
        fn supported_kinds(&self) -> &[&str] {
            &["session_event"]
        }
        fn supports_tombstones(&self) -> bool {
            true
        }
        fn concurrent(&self) -> Option<&(dyn Receiver + Sync)> {
            Some(self)
        }
        fn prepare(
            &self,
            batch: &HistoryExportBatch,
            _context: &ReceiverContext<'_>,
        ) -> Result<PreparedBody, ReceiverFailure> {
            Ok(body(batch))
        }
        fn send(
            &self,
            _payload: &PreparedPayload,
            batch: &HistoryExportBatch,
            context: &ReceiverContext<'_>,
        ) -> Result<DeliveryAcknowledgment, ReceiverFailure> {
            self.timeouts.lock().unwrap().push(context.timeout_ms);
            std::thread::sleep(Duration::from_millis(200));
            Ok(ack(batch))
        }
    }

    let (fixture, _) = backlog(2, 1);
    let receiver = DeadlineReceiver {
        timeouts: Mutex::new(Vec::new()),
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    let options = DrainOptions {
        max_batches: 4,
        max_prepare_steps: 4,
        max_in_flight: 2,
        request_timeout_ms: 120_000,
        request_deadline: Some(deadline),
        ..options()
    };
    run(&fixture.path(), &one(&receiver), &options);
    let timeouts = receiver.timeouts.lock().unwrap();
    assert!(timeouts.len() >= 3, "{timeouts:?}");
    let newest = *timeouts.iter().max().unwrap();
    let latest = *timeouts.iter().min().unwrap();
    assert!(newest <= 60_000, "{timeouts:?}");
    assert!(latest + 100 < newest, "{timeouts:?}");
}

/// With a window, sends overlap up to its size, every record is
/// acknowledged once, and the acknowledged position reaches the job's.
#[test]
fn a_pipelined_drain_overlaps_sends_up_to_its_window() {
    let (fixture, _) = backlog(37, 2);
    let mut receiver = Concurrent::new(Duration::from_millis(5));
    receiver.rendezvous = 2;
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let status = &result.statuses[0];
    assert_eq!(status.acknowledged_records, 40);
    assert_eq!(status.pending_records, 0);
    assert_eq!(status.acknowledged_cursor, status.journal_cursor);
    let most = receiver.most.load(SeqCst);
    assert!((2..=4).contains(&most), "{most}");
    assert_eq!(result.metrics.batches_acknowledged, 20);
    assert_eq!(result.metrics.batches_sent, 20);
    assert!((2..=4).contains(&result.metrics.max_in_flight));
    assert_eq!(result.metrics.batches_retried, 0);
    assert!(receiver
        .sends
        .lock()
        .unwrap()
        .values()
        .all(|sends| *sends == 1));
    // Every receipt was released: no batch is waiting on another.
    let left: i64 = fixture
        .conn
        .query_row("SELECT COUNT(*) FROM delivery_batches", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

/// A receiver that is not concurrent, or a window of one, sends one batch
/// at a time.
#[test]
fn without_a_concurrent_receiver_one_batch_is_in_flight() {
    let (fixture, _) = backlog(9, 2);
    let receiver = Concurrent::new(Duration::from_millis(5));
    let result = run(&fixture.path(), &one(&receiver), &pipelined(1));
    assert_eq!(receiver.most.load(SeqCst), 1);
    assert_eq!(result.metrics.max_in_flight, 1);
    assert_eq!(result.statuses[0].acknowledged_records, 12);
}

/// The oldest batch of a window fails while later ones are acknowledged:
/// they stay delivered and are never sent again, the job's acknowledged
/// position stays before the failed batch, and once its deadline passes the
/// failed batch alone is retried, after which the position catches up.
#[test]
fn a_failed_batch_holds_the_position_while_later_ones_stay_delivered() {
    let (fixture, job_id) = backlog(17, 2);
    let mut receiver = Concurrent::new(Duration::from_millis(10));
    // The batch holding the first record fails once, slowly enough that
    // its siblings are acknowledged first.
    receiver.verdict = Box::new(|batch, previous| {
        let first = batch
            .records
            .iter()
            .any(|record| record.payload["event_uid"] == "local-only");
        if first && previous == 0 {
            std::thread::sleep(Duration::from_millis(80));
            Some(DeliveryFailure::Transient.into())
        } else {
            None
        }
    });
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let failed = &result.statuses[0];
    assert_eq!(failed.failure.as_deref(), Some("transient"));
    assert_eq!(failed.acknowledged_cursor, 0);
    assert!(failed.acknowledged_records > 0);
    assert_eq!(failed.pending_records, 2);
    let delivered: Vec<String> = fixture
        .conn
        .prepare("SELECT id FROM delivery_batches WHERE job_id=? AND state='acknowledged'")
        .unwrap()
        .query_map([&job_id], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(!delivered.is_empty());

    retry_job(&fixture.conn, &job_id).unwrap();
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let caught_up = &result.statuses[0];
    assert_eq!(caught_up.acknowledged_records, 20);
    assert_eq!(caught_up.failure, None);
    assert_eq!(caught_up.acknowledged_cursor, caught_up.journal_cursor);
    assert_eq!(result.metrics.batches_retried, 1);
    for batch_id in &delivered {
        assert_eq!(receiver.sends(batch_id), 1, "{batch_id} was sent again");
    }
    // Every batch was mapped once, across both drains: the retry resends
    // the body persisted for its first attempt.
    let mapped = receiver.mapped.lock().unwrap().clone();
    assert_eq!(mapped.len(), 10);
    assert_eq!(mapped.iter().collect::<HashSet<_>>().len(), 10);
    let sent = receiver.sent.lock().unwrap();
    let retried: Vec<&String> = sent
        .iter()
        .filter(|(batch_id, _, _)| receiver.sends(batch_id) == 2)
        .map(|(_, digest, _)| digest)
        .collect();
    assert_eq!(retried.len(), 2);
    assert_eq!(retried[0], retried[1]);
}

/// In a window, receivers map batches on the sender threads, several at
/// once, while each batch is still persisted, validated and sent only after
/// every batch claimed before it was mapped: a later batch mapped first
/// waits for the earlier one.
#[test]
fn a_window_maps_batches_at_once_and_sends_them_in_claim_order() {
    let (fixture, _) = backlog(17, 2);
    let mut receiver = Concurrent::new(Duration::from_millis(2));
    receiver.first_maps_last = true;
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    assert_eq!(result.statuses[0].acknowledged_records, 20);
    assert_eq!(result.metrics.batches_sent, 10);
    assert!(receiver.most_mapping.load(SeqCst) >= 2);
    let mapped = receiver.mapped.lock().unwrap();
    assert_eq!(mapped.len(), 10);
    let positions: HashMap<String, usize> = receiver
        .batches
        .lock()
        .unwrap()
        .iter()
        .map(|(batch_id, batch)| (batch_id.clone(), feed_position(batch)))
        .collect();
    // The job's first batch finished mapping after another batch did.
    assert_ne!(positions[&mapped[0]], 0);
    let sent = receiver.sent.lock().unwrap();
    assert_eq!(sent.len(), 10);
    for (batch_id, _, mapped_before) in sent.iter() {
        for (earlier, position) in positions.iter() {
            if *position < positions[batch_id] {
                assert!(
                    mapped_before.contains(earlier),
                    "{batch_id} was sent before {earlier}, claimed before it, was mapped"
                );
            }
        }
    }
}

/// A mapping that fails on a sender thread settles its batch exactly as the
/// same failure does when the draining thread maps one batch at a time:
/// whether the receiver classified it, returned an invalid body or panicked.
#[test]
fn a_failed_mapping_settles_alike_on_a_sender_thread() {
    let cases: [fn() -> MappingFn; 4] = [
        || Box::new(|_| Err(DeliveryFailure::Transient.into())),
        || Box::new(|_| Err(DeliveryFailure::PermissionDenied.into())),
        || {
            Box::new(|batch| {
                Ok(PreparedBody {
                    content_type: String::new(),
                    ..body(batch)
                })
            })
        },
        || Box::new(|_| panic!("receiver bug")),
    ];
    for case in cases {
        let settled = |window: usize| {
            // The fixture's own events alone, in one batch.
            let (fixture, job_id) = backlog(0, 100);
            let mut receiver = Concurrent::new(Duration::ZERO);
            receiver.mapping = case();
            let result = drain(
                &fixture.path(),
                &one(&receiver),
                &pipelined(window),
                &|| 1_000_000,
                &|| false,
            )
            .unwrap();
            assert_eq!(result.issues, vec![]);
            assert_eq!(result.metrics.batches_sent, 0);
            assert_eq!(receiver.most_mapping.load(SeqCst), 1);
            let mut status = result.statuses[0].clone();
            assert_eq!(status.job_id, job_id);
            status.job_id.clear();
            // A retry deadline is jittered.
            assert!(status.next_attempt_ms >= 1_000_000);
            status.next_attempt_ms = 0;
            let batch: (String, bool, i64) = fixture
                .conn
                .query_row(
                    "SELECT state, prepared IS NULL, records FROM delivery_batches WHERE job_id=?",
                    [&job_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            (status, batch)
        };
        let (on_sender, batch) = settled(4);
        assert!(on_sender.failure.is_some());
        assert!(batch.1, "a failed mapping persisted a body");
        assert_eq!((on_sender, batch), settled(1));
    }
}

/// A mapping that blocks the job stops the window: the batches claimed and
/// mapped after it fail their eligibility recheck and are never sent to a
/// blocked job, the job keeps the verdict that blocked it, and once retried
/// every batch is delivered and sent once.
#[test]
fn a_blocking_mapping_keeps_later_batches_of_its_window_unsent() {
    let (fixture, job_id) = backlog(17, 2);
    let mut receiver = Concurrent::new(Duration::ZERO);
    receiver.first_maps_last = true;
    let blocking = Arc::new(AtomicBool::new(true));
    let blocks = blocking.clone();
    receiver.mapping = Box::new(move |batch| {
        if first_batch(batch) && blocks.load(SeqCst) {
            Err(DeliveryFailure::PermissionDenied.into())
        } else {
            Ok(body(batch))
        }
    });
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let blocked = &result.statuses[0];
    assert_eq!(blocked.state, "blocked");
    assert_eq!(blocked.failure.as_deref(), Some("permission_denied"));
    assert!(receiver.mapped.lock().unwrap().len() >= 2);
    assert_eq!(result.metrics.batches_sent, 0);

    blocking.store(false, SeqCst);
    retry_job(&fixture.conn, &job_id).unwrap();
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let delivered = &result.statuses[0];
    assert_eq!(delivered.failure, None);
    assert_eq!(delivered.acknowledged_records, 20);
    assert_eq!(delivered.acknowledged_cursor, delivered.journal_cursor);
    assert_eq!(receiver.sends.lock().unwrap().len(), 10);
    assert!(receiver
        .sends
        .lock()
        .unwrap()
        .values()
        .all(|sends| *sends == 1));
}

/// A blocking verdict inside a window blocks the job, and the batches sent
/// beside it are still recorded as delivered rather than reported as a
/// local state failure.
#[test]
fn a_blocking_verdict_in_a_window_keeps_its_siblings_outcomes() {
    let (fixture, _) = backlog(17, 2);
    let mut receiver = Concurrent::new(Duration::from_millis(20));
    receiver.verdict = Box::new(|batch, _| {
        batch
            .records
            .iter()
            .any(|record| record.payload["event_uid"] == "local-only")
            .then(|| DeliveryFailure::PermissionDenied.into())
    });
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let blocked = &result.statuses[0];
    assert_eq!(blocked.state, "blocked");
    assert_eq!(blocked.failure.as_deref(), Some("permission_denied"));
    let sent = result.metrics.batches_sent;
    assert!(sent >= 2, "{sent}");
    assert_eq!(result.metrics.batches_acknowledged, sent - 1);
    assert_eq!(blocked.acknowledged_records as u64, 2 * (sent - 1));
}

/// A host stop during a window releases every claim without a failure, so
/// the next drain resumes at once and sends nothing twice it acknowledged.
#[test]
fn a_host_stop_releases_every_claim_of_a_window() {
    let (fixture, job_id) = backlog(17, 2);
    let mut receiver = Concurrent::new(Duration::from_millis(30));
    receiver.rendezvous = 2;
    // The host asks to stop once three batches were handed to the receiver.
    let cancelled = || receiver.sends.lock().unwrap().len() >= 3;
    let result = drain(
        &fixture.path(),
        &one(&receiver),
        &pipelined(4),
        &system_clock,
        &cancelled,
    )
    .unwrap();
    assert_eq!(result.issues, vec![]);
    let stopped = &result.statuses[0];
    assert_eq!(stopped.failure, None);
    assert_eq!(stopped.next_attempt_ms, 0);
    assert!(stopped.pending_records > 0);
    let leased: i64 = fixture
        .conn
        .query_row(
            "SELECT COUNT(*) FROM delivery_batches WHERE job_id=? AND state='leased'",
            [&job_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leased, 0);
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.statuses[0].acknowledged_records, 20);
    assert_eq!(
        result.statuses[0].acknowledged_cursor,
        result.statuses[0].journal_cursor
    );
}

/// A selected-sessions job with `events` more events of its one member,
/// `both`, and batches of two records.
fn session_backlog(events: usize) -> (Fixture, String) {
    let fixture = fixture();
    for n in 0..events {
        fixture.conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','both',?1,42,'user','text','member')",params![format!("member-{n}")]).unwrap();
    }
    let mut config = config("one");
    config.limits.max_batch_records = 2;
    config.selection.all_sources = true;
    config.selection.sources.clear();
    let job = create_session_job(&fixture.conn, &config, 0).unwrap();
    include_job_session(&fixture.conn, &job.job_id, &both()).unwrap();
    (fixture, job.job_id)
}
fn both() -> SessionIdentity {
    SessionIdentity {
        source: "claude".into(),
        session_id: "both".into(),
    }
}
/// What a session listing proves about the member `both`: whether the job
/// may still send something for it, among the sessions no unresolved batch
/// holds.
fn member_waiting(conn: &Connection, job_id: &str) -> bool {
    let positions = upload_positions(conn, job_id).unwrap();
    let states = session_states(conn, &positions, &[both()], StatusCache::default()).unwrap();
    assert!(states.unknown.is_empty());
    states.waiting.contains(&both())
}
/// Whether an unresolved batch holds a record of `both`: a listing shows
/// such a session as queued or uploading, never uploaded.
fn member_queued(conn: &Connection, job_id: &str) -> bool {
    conn.prepare("SELECT payload FROM delivery_batches WHERE job_id=? AND state IN ('pending','leased','retry_wait','blocked')")
        .unwrap()
        .query_map([job_id], |r| r.get::<_, String>(0))
        .unwrap()
        .any(|payload| {
            serde_json::from_str::<HistoryExportBatch>(&payload.unwrap())
                .unwrap()
                .records
                .iter()
                .any(|record| record.session_id.as_deref() == Some("both"))
        })
}

/// A selected-sessions job's backfill goes out in a window like any other
/// job's: sends overlap up to its size, every record is acknowledged once,
/// the acknowledged position reaches the job's, and every receipt is
/// released.
#[test]
fn a_session_job_pipelines_its_backfill_up_to_its_window() {
    let (fixture, _) = session_backlog(19);
    let mut receiver = Concurrent::new(Duration::from_millis(5));
    receiver.rendezvous = 2;
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let most = receiver.most.load(SeqCst);
    assert!((2..=4).contains(&most), "{most}");
    let status = &result.statuses[0];
    assert_eq!(status.acknowledged_records, 20);
    assert_eq!(status.pending_records, 0);
    assert_eq!(status.acknowledged_cursor, status.journal_cursor);
    assert_eq!(result.metrics.batches_sent, 10);
    assert!(receiver
        .sends
        .lock()
        .unwrap()
        .values()
        .all(|sends| *sends == 1));
    let left: i64 = fixture
        .conn
        .query_row("SELECT COUNT(*) FROM delivery_batches", [], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0);
    assert!(!member_waiting(&fixture.conn, &status.job_id));
}

/// A session job's oldest backfill batch fails while the rest of its window
/// is acknowledged. The member's backfill has passed every record, which its
/// batches hold: the failed one still holds its records, so the member is not
/// uploaded, and the position stays before the end the batches share. The
/// retry sends the failed batch alone, with the body stored for its first
/// attempt, and the member is uploaded.
#[test]
fn a_failed_session_batch_is_retried_alone_and_completes_the_backfill() {
    let (fixture, job_id) = session_backlog(17);
    let mut receiver = Concurrent::new(Duration::from_millis(10));
    receiver.verdict = Box::new(|batch, previous| {
        let first = batch
            .records
            .iter()
            .any(|record| record.payload["event_uid"] == "both");
        if first && previous == 0 {
            std::thread::sleep(Duration::from_millis(80));
            Some(DeliveryFailure::Transient.into())
        } else {
            None
        }
    });
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let failed = &result.statuses[0];
    assert_eq!(failed.failure.as_deref(), Some("transient"));
    assert!(failed.acknowledged_records > 0);
    assert_eq!(failed.pending_records, 2);
    assert!(failed.acknowledged_cursor < failed.journal_cursor);
    assert!(member_queued(&fixture.conn, &job_id));
    let delivered: Vec<String> = fixture
        .conn
        .prepare("SELECT id FROM delivery_batches WHERE job_id=? AND state='acknowledged'")
        .unwrap()
        .query_map([&job_id], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();

    retry_job(&fixture.conn, &job_id).unwrap();
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let caught_up = &result.statuses[0];
    assert_eq!(caught_up.acknowledged_records, 18);
    assert_eq!(caught_up.failure, None);
    assert_eq!(caught_up.acknowledged_cursor, caught_up.journal_cursor);
    assert_eq!(result.metrics.batches_retried, 1);
    for batch_id in &delivered {
        assert_eq!(receiver.sends(batch_id), 1, "{batch_id} was sent again");
    }
    let sent = receiver.sent.lock().unwrap();
    assert_eq!(sent.len(), 10);
    let retried: Vec<&String> = sent
        .iter()
        .filter(|(batch_id, _, _)| receiver.sends(batch_id) == 2)
        .map(|(_, digest, _)| digest)
        .collect();
    assert_eq!(retried.len(), 2);
    assert_eq!(retried[0], retried[1]);
    // Every record was sent, once, across both drains.
    let batches = receiver.batches.lock().unwrap();
    let events: Vec<&str> = batches
        .values()
        .flat_map(|batch| &batch.records)
        .map(|record| record.payload["event_uid"].as_str().unwrap())
        .collect();
    assert_eq!(events.len(), 18);
    assert_eq!(events.iter().collect::<HashSet<_>>().len(), 18);
    assert!(!member_queued(&fixture.conn, &job_id));
    assert!(!member_waiting(&fixture.conn, &job_id));
}

/// A drain that stops partway through a session job's backfill leaves the
/// member waiting: its backfill has not reached its cutoff, whatever the
/// window acknowledged. The next drain resumes from the member's cursor.
#[test]
fn a_session_backfill_cut_short_resumes_from_its_cursor() {
    let (fixture, job_id) = session_backlog(17);
    let receiver = Concurrent::new(Duration::ZERO);
    let bounded = DrainOptions {
        max_batches: 2,
        ..pipelined(4)
    };
    let result = run(&fixture.path(), &one(&receiver), &bounded);
    assert_eq!(result.issues, vec![]);
    assert!(!result.statuses[0].bootstrap_complete);
    assert!(member_waiting(&fixture.conn, &job_id));
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    assert_eq!(result.statuses[0].acknowledged_records, 18);
    assert!(receiver
        .sends
        .lock()
        .unwrap()
        .values()
        .all(|sends| *sends == 1));
    assert!(!member_waiting(&fixture.conn, &job_id));
}

/// Batches follow the record limit the receiver last published: the
/// protocol's 100 while it publishes none, its own up to 500, never more.
#[test]
fn batches_follow_the_receivers_published_record_limit() {
    let batches = |published: PublishedLimits| {
        let (fixture, _) = backlog(597, 100);
        let mut receiver = Concurrent::new(Duration::ZERO);
        receiver.published = published;
        let result = run(&fixture.path(), &one(&receiver), &pipelined(1));
        assert_eq!(result.statuses[0].acknowledged_records, 600);
        result.metrics.batches_acknowledged
    };
    let records = |max_records| PublishedLimits {
        max_records: Some(max_records),
        max_request_bytes: None,
    };
    assert_eq!(batches(PublishedLimits::default()), 6);
    assert_eq!(batches(records(250)), 3);
    assert_eq!(batches(records(10_000)), 2);
    assert_eq!(batches(records(60)), 10);
}

/// A send that panics on a sender thread is that batch's transient failure;
/// the window still finishes and records its siblings.
#[test]
fn a_panicking_concurrent_send_is_a_transient_failure() {
    let (fixture, _) = backlog(17, 2);
    let mut receiver = Concurrent::new(Duration::from_millis(5));
    receiver.verdict = Box::new(|batch, _| {
        if batch
            .records
            .iter()
            .any(|record| record.payload["event_uid"] == "local-only")
        {
            panic!("receiver bug");
        }
        None
    });
    let result = run(&fixture.path(), &one(&receiver), &pipelined(4));
    assert_eq!(result.issues, vec![]);
    let failed = &result.statuses[0];
    assert_eq!(failed.state, "active");
    assert_eq!(failed.failure.as_deref(), Some("transient"));
    assert_eq!(failed.acknowledged_cursor, 0);
}

/// The cost of a selected-sessions job following a feed that is mostly other
/// sessions' changes: what each preparation spends per change it examines.
/// Run with `--ignored --nocapture`; `SESSION_FOLLOW_EVENTS` sets how many
/// changes of other sessions the feed holds (default 20,000).
#[test]
#[ignore]
fn session_job_follow_cost() {
    let events: usize = std::env::var("SESSION_FOLLOW_EVENTS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(20_000);
    let fixture = fixture();
    let mut config = config("one");
    config.selection.all_sources = true;
    config.selection.sources.clear();
    let job = create_session_job(&fixture.conn, &config, 0).unwrap();
    include_job_session(
        &fixture.conn,
        &job.job_id,
        &SessionIdentity {
            source: "claude".into(),
            session_id: "both".into(),
        },
    )
    .unwrap();
    let receiver = Concurrent::new(Duration::ZERO);
    let result = run(&fixture.path(), &one(&receiver), &pipelined(1));
    assert_eq!(result.statuses[0].acknowledged_records, 1);
    let tx = fixture.conn.unchecked_transaction().unwrap();
    for n in 0..events {
        tx.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','other',?1,42,'user','text','other')",params![format!("other-{n}")]).unwrap();
    }
    tx.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','both','member-late',42,'user','text','member')",[]).unwrap();
    tx.commit().unwrap();
    let started = Instant::now();
    let mut drains = 0;
    loop {
        let result = run(&fixture.path(), &one(&receiver), &pipelined(1));
        drains += 1;
        let status = &result.statuses[0];
        if status.acknowledged_records == 2 && status.unqueued_changes == 0 {
            break;
        }
        assert!(drains < 10_000);
    }
    eprintln!(
        "events={events} drains={drains} elapsed_ms={} us_per_change={:.1}",
        started.elapsed().as_millis(),
        started.elapsed().as_secs_f64() * 1e6 / events as f64
    );
}
