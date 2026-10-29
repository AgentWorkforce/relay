use agent_relay_probe::delivery::{
    self, worker,
    worker::{LimitsContext, Receiver, ReceiverContext},
    DeliveryFailure, HistoryExportBatch, HistoryExportRecord, IsolationTask, PreparedPayload,
    PublishedLimits, MAX_PUBLISHED_BATCH_RECORDS, THIS_BUILD,
};
use agent_relay_probe::destination::{account_id, prepare, RelayHistoryReceiver, MAPPING_VERSION};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
fn batch() -> HistoryExportBatch {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/delivery-native-v1.json")).unwrap();
    assert_eq!(
        fixture["batch"]["account_id"],
        account_id("org-fixture", Some("workspace-fixture"))
    );
    let mut batch: HistoryExportBatch = serde_json::from_value(fixture["batch"].clone()).unwrap();
    assert_eq!(batch.mapping_version, MAPPING_VERSION);
    batch.account_id = account_id("org-fixture", None);
    batch
}
/// The auth file stem the probe gives a stage: the first 16 hex digits of the
/// SHA-256 of its URL.
fn stage_key(base: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(base.as_bytes()))[..16].to_owned()
}
fn auth(home: &Path, base: &str, org: &str) {
    let stages = home.join("stages");
    std::fs::create_dir_all(&stages).unwrap();
    std::fs::write(
        stages.join(format!("{}.auth.json", stage_key(base))),
        json!({"base_url":base,"access_token":"rth_at_fixture","org_id":org}).to_string(),
    )
    .unwrap();
}
fn server(pages: Vec<(u16, Value)>) -> (String, Fixture) {
    server_with_hook(pages, |_, _| {}, |_| {})
}
/// A loopback receiver serving one page per request. Tests join it only after
/// the client has returned, which is the signal that no further request can
/// arrive: there is no wall-clock wait for a request the client never sends.
struct Fixture {
    client_returned: Arc<AtomicBool>,
    handle: thread::JoinHandle<Vec<(String, String)>>,
}
impl Fixture {
    fn join(self) -> thread::Result<Vec<(String, String)>> {
        self.client_returned.store(true, Ordering::SeqCst);
        self.handle.join()
    }
}
/// Serve `pages` in order. A status of 0 reads the request and closes the
/// connection without a response.
fn server_with_hook(
    pages: Vec<(u16, Value)>,
    hook: impl Fn(usize, &mut TcpStream) + Send + 'static,
    finished: impl FnOnce(&TcpListener) + Send + 'static,
) -> (String, Fixture) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let client_returned = Arc::new(AtomicBool::new(false));
    let returned = client_returned.clone();
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        let total = pages.len();
        for (index, (status, body)) in pages.into_iter().enumerate() {
            let mut stream = loop {
                // Read the flag before accepting: every connection the client
                // made is queued before it returns, so an empty queue after
                // that means it stopped early.
                let stopped = returned.load(Ordering::SeqCst);
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(!stopped, "client sent {index} of {total} requests");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut headers = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                let read = reader.read_line(&mut line).unwrap();
                assert_ne!(
                    read, 0,
                    "client closed request {index} before its headers ended"
                );
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                headers.push_str(&line);
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            requests.push((
                headers.clone(),
                String::from_utf8(decoded(&headers, bytes)).unwrap(),
            ));
            hook(index, &mut stream);
            if status == 0 {
                continue;
            }
            let body = body.to_string();
            if let Err(error) = write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()) {
                assert!(
                    matches!(
                        error.kind(),
                        std::io::ErrorKind::BrokenPipe
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::ConnectionReset
                    ),
                    "{error}"
                );
            }
        }
        finished(&listener);
        requests
    });
    (
        base,
        Fixture {
            client_returned,
            handle,
        },
    )
}

/// A request body as the receiver decodes it, per its `Content-Encoding`.
fn decoded(headers: &str, bytes: Vec<u8>) -> Vec<u8> {
    let headers = headers.to_ascii_lowercase();
    if headers.contains("\r\ncontent-encoding: zstd\r\n") {
        zstd::bulk::decompress(&bytes, 1 << 24).unwrap()
    } else if headers.contains("\r\ncontent-encoding: gzip\r\n") {
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_end(&mut decoded)
            .unwrap();
        decoded
    } else {
        bytes
    }
}
fn content_encoding(headers: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-encoding")
            .then(|| value.trim().to_owned())
    })
}

/// A real HTTP fixture whose response can use the exact request just read.
/// This is needed for a conflict digest over a batch created by the queue.
/// It answers the published-limits request as an older server does (404),
/// outside the `total` batch requests it serves.
fn dynamic_server(
    total: usize,
    mut respond: impl FnMut(usize, &Value) -> (u16, Value) + Send + 'static,
) -> (String, Fixture) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let client_returned = Arc::new(AtomicBool::new(false));
    let returned = client_returned.clone();
    let handle = thread::spawn(move || {
        let mut requests = Vec::new();
        let mut index = 0;
        while index < total {
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            !returned.load(Ordering::SeqCst),
                            "client sent {index} of {total} requests"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            // An accepted socket inherits the listener's nonblocking mode on
            // macOS; reading the request must wait for the client's bytes.
            stream.set_nonblocking(false).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut headers = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
                headers.push_str(&line);
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            if headers.starts_with("GET /v1/delivery/limits ") {
                write!(
                    stream,
                    "HTTP/1.1 404 Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
                continue;
            }
            let body = String::from_utf8(bytes).unwrap();
            let request: Value = serde_json::from_str(&body).unwrap();
            let (status, response) = respond(index, &request);
            index += 1;
            requests.push((headers, body));
            if status == 0 {
                continue; // The receiver accepted the bytes but its response was lost.
            }
            let response = response.to_string();
            write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).unwrap();
        }
        requests
    });
    (
        base,
        Fixture {
            client_returned,
            handle,
        },
    )
}
/// A call budget the fake receiver spends when request `last` arrives. Serve
/// that request with status 0: it never completes and nothing after it is
/// dispatched, exactly as when the deadline lapses while it is in flight, but
/// without depending on how long the earlier requests took.
fn budget_spent_on(
    last: usize,
) -> (
    Arc<AtomicBool>,
    impl Fn(usize, &mut TcpStream) + Send + 'static,
) {
    let spent = Arc::new(AtomicBool::new(false));
    let spend = spent.clone();
    (spent, move |index, _: &mut TcpStream| {
        if index == last {
            spend.store(true, Ordering::SeqCst);
        }
    })
}
fn accepted(batch: &HistoryExportBatch) -> Value {
    json!({"protocolVersion":1,"batchId":batch.batch_id,"acceptedRevisionIds":batch.records.iter().map(|r|&r.revision_id).collect::<Vec<_>>(),"unsupportedRevisionIds":[],"acceptanceLevel":"durable"})
}
fn isolation_child(
    batch: &HistoryExportBatch,
    records: &[agent_relay_probe::delivery::HistoryExportRecord],
) -> HistoryExportBatch {
    use sha2::{Digest, Sha256};
    let mut child = batch.clone();
    child.records = records.to_vec();
    let identity = child
        .records
        .iter()
        .map(|record| record.revision_id.as_str())
        .collect::<Vec<_>>();
    child.batch_id = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(&batch.batch_id, identity)).unwrap())
    );
    child
}
fn isolation_pages(
    batch: &HistoryExportBatch,
    rejected: &std::collections::HashSet<String>,
) -> Vec<(u16, Value)> {
    isolation_pages_from_state(batch, rejected, &[], &[], &[], &[])
}
fn isolation_pages_from_state(
    batch: &HistoryExportBatch,
    rejected: &std::collections::HashSet<String>,
    accepted_ids: &[String],
    suppressed_ids: &[String],
    candidate_ids: &[String],
    frontier: &[IsolationTask],
) -> Vec<(u16, Value)> {
    let mut known = accepted_ids
        .iter()
        .chain(suppressed_ids)
        .chain(candidate_ids)
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    for task in frontier {
        known.extend(task.revision_ids.iter().cloned());
    }
    let unknown = batch
        .records
        .iter()
        .filter(|record| !known.contains(&record.revision_id))
        .cloned()
        .collect::<Vec<_>>();
    let mut tasks = frontier.to_vec();
    let mut pages = Vec::new();
    if tasks.is_empty() {
        let pending = isolation_child(batch, &unknown);
        let failed = pending
            .records
            .iter()
            .any(|record| rejected.contains(&record.revision_id));
        pages.push(if failed {
            (422, json!({"code":"invalid_json"}))
        } else {
            (200, accepted(&pending))
        });
        if failed {
            tasks.push(IsolationTask {
                revision_ids: pending
                    .records
                    .iter()
                    .map(|record| record.revision_id.clone())
                    .collect(),
                rejected: true,
            });
        }
    } else if !unknown.is_empty() {
        tasks.insert(
            0,
            IsolationTask {
                revision_ids: unknown
                    .iter()
                    .map(|record| record.revision_id.clone())
                    .collect(),
                rejected: false,
            },
        );
    }
    while let Some(task) = tasks.pop() {
        let records = task
            .revision_ids
            .iter()
            .map(|revision| {
                batch
                    .records
                    .iter()
                    .find(|record| &record.revision_id == revision)
                    .unwrap()
                    .clone()
            })
            .collect::<Vec<_>>();
        let page = isolation_child(batch, &records);
        if task.rejected {
            if records.len() == 1 {
                continue;
            }
            let middle = records.len() / 2;
            for half in [&records[middle..], &records[..middle]] {
                tasks.push(IsolationTask {
                    revision_ids: half
                        .iter()
                        .map(|record| record.revision_id.clone())
                        .collect(),
                    rejected: false,
                });
            }
            continue;
        }
        let failed = records
            .iter()
            .any(|record| rejected.contains(&record.revision_id));
        pages.push(if failed {
            (422, json!({"code":"invalid_json"}))
        } else {
            (200, accepted(&page))
        });
        if failed {
            tasks.push(IsolationTask {
                revision_ids: task.revision_ids,
                rejected: true,
            });
        }
    }
    pages
}
/// Run `body` in a child test process whose credentials live in a fresh home,
/// so stored auth cannot leak between tests or from the host.
fn isolated(test: &str, body: impl FnOnce(&Path)) {
    const CHILD: &str = "RELAY_TEST_DESTINATION_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env(CHILD, "1")
            .env("HOME", home.path())
            .env("RELAYHISTORY_HOME", home.path())
            .env_remove("RELAYHISTORY_BASE_URL")
            .env_remove("AI_HIST_BASE_URL")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let home = std::env::var_os("RELAYHISTORY_HOME").unwrap();
    body(Path::new(&home));
}
/// The probe's receiver for `base`. A test host cannot inspect legacy
/// schedules, so it acknowledges that explicitly as an interactive user would.
fn receiver(base: &str) -> RelayHistoryReceiver {
    RelayHistoryReceiver {
        base_url: Some(base.to_owned()),
        acknowledge_uninspected_schedules: true,
        ..Default::default()
    }
}
fn never() -> bool {
    false
}
fn limits_context() -> LimitsContext<'static> {
    LimitsContext {
        cancelled: &never,
        timeout_ms: 30_000,
    }
}
fn context(batch: &HistoryExportBatch) -> ReceiverContext<'_> {
    ReceiverContext {
        cancelled: &|| false,
        timeout_ms: 60_000,
        idempotency_key: &batch.batch_id,
        accepted_revision_ids: &[],
        suppressed_revision_ids: &[],
        rejected_revision_ids: &[],
        isolation_frontier: &[],
    }
}

#[test]
fn typed_http_conflict_reaches_the_durable_worker_and_later_records_drain() {
    isolated(
        "typed_http_conflict_reaches_the_durable_worker_and_later_records_drain",
        |home| {
            use sha2::{Digest, Sha256};
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("history.db");
            let conn = delivery::open_db(&path).unwrap();
            for id in ["a", "b", "c"] {
                conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?1,42,'user','text',?1)", params![id]).unwrap();
            }
            let config = delivery::DeliveryJobConfig {
                destination_id: "relayhistory".into(),
                instance_id: "probe".into(),
                account_id: account_id("org-fixture", None),
                mapping_version: MAPPING_VERSION.into(),
                selection: delivery::ExportSelection {
                    sources: vec!["claude".into()],
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
            let mut parent_id = None;
            let mut poison = None;
            let mut remaining: Option<HistoryExportRecord> = None;
            let mut child_batch = None;
            let (base, server) = dynamic_server(5, move |index, request| {
                assert_eq!(request["protocolVersion"], 1);
                let batch: HistoryExportBatch =
                    serde_json::from_value(request["batch"].clone()).unwrap();
                match index {
                    0 => {
                        assert_eq!(batch.records.len(), 2);
                        parent_id = Some(batch.batch_id.clone());
                        let record = batch.records[0].clone();
                        poison = Some(record.revision_id.clone());
                        remaining = Some(batch.records[1].clone());
                        let mut normalized = serde_json::to_value(&record).unwrap();
                        if normalized["session_id"] == "" {
                            normalized["session_id"] = Value::Null;
                        }
                        let digest = format!(
                            "{:x}",
                            Sha256::digest(serde_json::to_string(&normalized).unwrap().as_bytes())
                        );
                        let conflict = json!({"type":"record_revision","originId":record.origin_id,
                            "recordId":record.record_id,"submittedRevisionId":record.revision_id,
                            "submittedRevision":record.revision,"submittedDigest":digest,
                            "currentRevisionId":record.revision_id,"currentRevision":record.revision,
                            "currentDigest":"f".repeat(64)});
                        (
                            409,
                            json!({"error":{"code":"delivery_conflict","message":"revision reused",
                            "conflict":conflict,"conflicts":[conflict],"conflictCount":1}}),
                        )
                    }
                    1 => {
                        assert_ne!(Some(&batch.batch_id), parent_id.as_ref());
                        assert!(batch.batch_id.starts_with("conflict-"));
                        assert_eq!(batch.records, vec![remaining.clone().unwrap()]);
                        child_batch = Some(batch);
                        (0, Value::Null)
                    }
                    // The connection closed before its response is resent
                    // once at once; closed again, the child is left to the
                    // worker's retry.
                    2 => {
                        assert_eq!(Some(&batch), child_batch.as_ref());
                        (0, Value::Null)
                    }
                    3 => {
                        assert_eq!(Some(&batch), child_batch.as_ref());
                        (200, accepted(&batch))
                    }
                    4 => {
                        assert_eq!(batch.records.len(), 1);
                        assert_ne!(Some(&batch.records[0].revision_id), poison.as_ref());
                        assert_ne!(Some(&batch.records[0]), remaining.as_ref());
                        (200, accepted(&batch))
                    }
                    _ => unreachable!(),
                }
            });
            auth(home, &base, "org-fixture");
            let receiver = receiver(&base);
            let receivers = worker::SingleReceiver::new("relayhistory", "probe", &receiver);
            let mut options = worker::DrainOptions::new("http-conflict-test");
            options.max_batches = 1;
            let first = worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
                false
            })
            .unwrap();
            assert!(first.issues.is_empty(), "{:?}", first.issues);
            let after = delivery::status(&conn, &job.job_id).unwrap();
            assert_eq!(after.quarantined_records, 1);
            assert_eq!(after.state, "active");
            assert_eq!(after.pending_records, 1);
            let archived: String = conn
                .query_row(
                    "SELECT prepared FROM delivery_conflict_attempts",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(archived.contains("protocolVersion"));
            drop(conn); // The child and quarantine survive a process restart.
            let conn = delivery::open_db(&path).unwrap();
            let lost = worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
                false
            })
            .unwrap();
            assert!(lost.issues.is_empty(), "{:?}", lost.issues);
            assert_eq!(
                delivery::status(&conn, &job.job_id)
                    .unwrap()
                    .failure
                    .as_deref(),
                Some("transient")
            );
            delivery::retry_job(&conn, &job.job_id).unwrap();
            options.max_batches = 10;
            let replay = worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
                false
            })
            .unwrap();
            assert!(replay.issues.is_empty(), "{:?}", replay.issues);
            let final_status = delivery::status(&conn, &job.job_id).unwrap();
            assert_eq!(final_status.quarantined_records, 1);
            assert_eq!(final_status.acknowledged_records, 2);
            assert_eq!(final_status.pending_records, 0);
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 5);
            assert_eq!(requests[1].1, requests[2].1);
            assert_eq!(requests[1].1, requests[3].1);
        },
    );
}

#[test]
fn typed_http_conflict_on_isolation_child_recovers_parent_and_drains_siblings() {
    isolated(
        "typed_http_conflict_on_isolation_child_recovers_parent_and_drains_siblings",
        |home| {
            use sha2::{Digest, Sha256};
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("history.db");
            let conn = delivery::open_db(&path).unwrap();
            for id in ["a", "b", "c"] {
                conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?1,42,'user','text',?1)", params![id]).unwrap();
            }
            let config = delivery::DeliveryJobConfig {
                destination_id: "relayhistory".into(),
                instance_id: "probe".into(),
                account_id: account_id("org-fixture", None),
                mapping_version: MAPPING_VERSION.into(),
                selection: delivery::ExportSelection {
                    sources: vec!["claude".into()],
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
            let mut parent = None;
            let mut poison = None;
            let mut sibling = None;
            let (base, server) = dynamic_server(4, move |index, request| {
                let batch: HistoryExportBatch =
                    serde_json::from_value(request["batch"].clone()).unwrap();
                match index {
                    0 => {
                        assert_eq!(batch.records.len(), 2);
                        poison = Some(batch.records[0].clone());
                        sibling = Some(batch.records[1].clone());
                        parent = Some(batch);
                        (422, json!({"code":"invalid_json"}))
                    }
                    1 => {
                        let record = poison.as_ref().unwrap();
                        assert_eq!(
                            batch,
                            isolation_child(parent.as_ref().unwrap(), &[record.clone()])
                        );
                        let mut normalized = serde_json::to_value(record).unwrap();
                        if normalized["session_id"] == "" {
                            normalized["session_id"] = Value::Null;
                        }
                        let digest = format!(
                            "{:x}",
                            Sha256::digest(serde_json::to_string(&normalized).unwrap().as_bytes())
                        );
                        let conflict = json!({"type":"record_revision","originId":record.origin_id,
                            "recordId":record.record_id,"submittedRevisionId":record.revision_id,
                            "submittedRevision":record.revision,"submittedDigest":digest,
                            "currentRevisionId":record.revision_id,"currentRevision":record.revision,
                            "currentDigest":"f".repeat(64)});
                        (
                            409,
                            json!({"error":{"code":"delivery_conflict","message":"revision reused",
                            "conflict":conflict,"conflicts":[conflict],"conflictCount":1}}),
                        )
                    }
                    2 => {
                        assert!(batch.batch_id.starts_with("conflict-"));
                        assert_eq!(batch.records, vec![sibling.clone().unwrap()]);
                        (200, accepted(&batch))
                    }
                    3 => {
                        assert_eq!(batch.records.len(), 1);
                        assert_ne!(batch.records[0], *poison.as_ref().unwrap());
                        assert_ne!(batch.records[0], *sibling.as_ref().unwrap());
                        (200, accepted(&batch))
                    }
                    _ => unreachable!(),
                }
            });
            auth(home, &base, "org-fixture");
            let receiver = receiver(&base);
            let receivers = worker::SingleReceiver::new("relayhistory", "probe", &receiver);
            let mut options = worker::DrainOptions::new("isolation-conflict-test");
            options.max_batches = 1;
            let first = worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
                false
            })
            .unwrap();
            assert!(first.issues.is_empty(), "{:?}", first.issues);
            let after = delivery::status(&conn, &job.job_id).unwrap();
            assert_eq!(after.state, "active");
            assert_eq!(after.quarantined_records, 1);
            assert_eq!(after.pending_records, 1);
            let attempts: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM delivery_conflict_attempts",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(attempts, 1);

            drop(conn); // The lifted parent recovery is durable across restart.
            let conn = delivery::open_db(&path).unwrap();
            options.max_batches = 10;
            let drained =
                worker::drain(&path, &receivers, &options, &worker::system_clock, &|| {
                    false
                })
                .unwrap();
            assert!(drained.issues.is_empty(), "{:?}", drained.issues);
            let final_status = delivery::status(&conn, &job.job_id).unwrap();
            assert_eq!(final_status.pending_records, 0);
            assert_eq!(final_status.quarantined_records, 1);
            assert_eq!(final_status.acknowledged_records, 2);
            assert_eq!(server.join().unwrap().len(), 4);
        },
    );
}
fn failure(
    result: Result<impl std::fmt::Debug, agent_relay_probe::delivery::worker::ReceiverFailure>,
) -> DeliveryFailure {
    result.unwrap_err().failure
}
#[test]
fn native_fixture_prepares_immutably_and_retry_sends_identical_bytes() {
    isolated(
        "native_fixture_prepares_immutably_and_retry_sends_identical_bytes",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            let saved: PreparedPayload =
                serde_json::from_str(&serde_json::to_string(&prepared).unwrap()).unwrap();
            // A connection closed before its response is resent once at
            // once; closed again, the batch is left to the worker's retry.
            let (base, server) = server(vec![
                (0, json!({"secret":"rth_at_never_echo"})),
                (0, json!({"secret":"rth_at_never_echo"})),
                (200, accepted(&batch)),
            ]);
            auth(home, &base, "org-fixture");
            let receiver = receiver(&base);
            let first = receiver.send(&prepared, &batch, &context(&batch));
            assert!(!format!("{first:?}").contains("rth_at_never_echo"));
            assert_eq!(failure(first), DeliveryFailure::Transient);
            let retry = receiver.send(&saved, &batch, &context(&batch)).unwrap();
            assert_eq!(retry.accepted_revision_ids.len(), batch.records.len());
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 3);
            for request in &requests {
                assert_eq!(request.1, prepared.body);
                assert!(request.0.starts_with("POST /v1/delivery/batches "));
            }
        },
    );
}
/// A kept-alive connection the server closed while the request was written
/// costs one immediate resend of the same bytes, not a failed batch and the
/// worker's backoff. A timeout is never resent.
#[test]
fn a_connection_closed_under_a_send_is_resent_once_on_a_new_connection() {
    isolated(
        "a_connection_closed_under_a_send_is_resent_once_on_a_new_connection",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            let (base, server) = server(vec![(0, json!({})), (200, accepted(&batch))]);
            auth(home, &base, "org-fixture");
            let acknowledged = receiver(&base)
                .send(&prepared, &batch, &context(&batch))
                .unwrap();
            assert_eq!(
                acknowledged.accepted_revision_ids.len(),
                batch.records.len()
            );
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0], requests[1]);

            // A response that does not arrive within the budget is not resent.
            let (base, server) = server_with_hook(
                vec![(0, json!({}))],
                |_, _| thread::sleep(Duration::from_millis(1_500)),
                |_| {},
            );
            auth(home, &base, "org-fixture");
            let short = ReceiverContext {
                timeout_ms: 1_000,
                ..context(&batch)
            };
            let timed_out = receiver(&base).send(&prepared, &batch, &short);
            assert_eq!(failure(timed_out), DeliveryFailure::Transient);
            assert_eq!(server.join().unwrap().len(), 1);
        },
    );
}
#[test]
fn old_server_and_wrong_receipts_never_fall_back_or_acknowledge() {
    isolated(
        "old_server_and_wrong_receipts_never_fall_back_or_acknowledge",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            let mut wrong = accepted(&batch);
            wrong["acceptedRevisionIds"] = json!(["unsubmitted"]);
            for (status, body, expected) in [
                (404, json!({}), DeliveryFailure::UnsupportedEvidence),
                (200, json!({"accepted":99}), DeliveryFailure::InvalidPayload),
                (200, wrong, DeliveryFailure::InvalidPayload),
            ] {
                let (base, server) = server(vec![(status, body)]);
                auth(home, &base, "org-fixture");
                let result = receiver(&base).send(&prepared, &batch, &context(&batch));
                assert_eq!(failure(result), expected);
                assert_eq!(server.join().unwrap().len(), 1);
            }
        },
    );
}

#[test]
fn one_rejected_record_is_isolated_only_after_accepted_siblings() {
    isolated(
        "one_rejected_record_is_isolated_only_after_accepted_siblings",
        |home| {
            let mut batch = batch();
            let template = batch.records[0].clone();
            batch.records = (0..4)
                .map(|index| {
                    let mut record = template.clone();
                    record.record_id = format!("record-{index}");
                    record.revision_id = format!("revision-{index}");
                    record.revision += index as i64;
                    record
                })
                .collect();
            let left = isolation_child(&batch, &batch.records[..2]);
            let right = isolation_child(&batch, &batch.records[2..]);
            // Every resumable child id is derived from the immutable original
            // batch id plus its exact revision ids, not from an ephemeral
            // intermediate split.
            let right_left = isolation_child(&batch, &right.records[..1]);
            let right_right = isolation_child(&batch, &right.records[1..]);
            let (base, server) = server(vec![
                (422, json!({"code":"invalid_json"})),
                (200, accepted(&left)),
                (422, json!({"code":"invalid_json"})),
                (200, accepted(&right_left)),
                (422, json!({"code":"invalid_json"})),
            ]);
            auth(home, &base, "org-fixture");
            let ack = receiver(&base)
                .send(&prepare(batch.clone()).unwrap(), &batch, &context(&batch))
                .unwrap();
            assert_eq!(ack.batch_id, batch.batch_id);
            assert_eq!(ack.accepted_revision_ids.len(), 3);
            assert!(ack.unsupported_revision_ids.is_empty());
            assert_eq!(
                ack.suppressed_revision_ids,
                vec![right_right.records[0].revision_id.clone()]
            );
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 5);
            let sent_ids = requests
                .iter()
                .map(|(_, body)| {
                    serde_json::from_str::<Value>(body).unwrap()["batch"]["batch_id"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                })
                .collect::<Vec<_>>();
            assert_eq!(
                sent_ids,
                vec![
                    batch.batch_id,
                    left.batch_id,
                    right.batch_id,
                    right_left.batch_id,
                    right_right.batch_id
                ]
            );
        },
    );
}

#[test]
fn receiver_wide_rejection_and_singletons_are_never_suppressed() {
    isolated(
        "receiver_wide_rejection_and_singletons_are_never_suppressed",
        |home| {
            let mut batch = batch();
            let template = batch.records[0].clone();
            batch.records = (0..100)
                .map(|index| {
                    let mut record = template.clone();
                    record.record_id = format!("record-{index}");
                    record.revision_id = format!("revision-{index}");
                    record.revision += index as i64;
                    record
                })
                .collect();
            let rejected = batch
                .records
                .iter()
                .map(|record| record.revision_id.clone())
                .collect();
            let prepared = prepare(batch.clone()).unwrap();
            let mut accepted = Vec::new();
            let mut suppressed = Vec::new();
            let mut candidates = Vec::new();
            let mut frontier: Vec<IsolationTask> = Vec::new();
            let mut blocked = false;
            for _ in 0..10 {
                let known = accepted
                    .iter()
                    .chain(&suppressed)
                    .chain(&candidates)
                    .chain(frontier.iter().flat_map(|task| &task.revision_ids))
                    .cloned()
                    .collect::<std::collections::HashSet<_>>();
                let unknown = batch
                    .records
                    .iter()
                    .filter(|record| !known.contains(&record.revision_id))
                    .cloned()
                    .collect::<Vec<_>>();
                if unknown.is_empty() && frontier.is_empty() {
                    let context = ReceiverContext {
                        cancelled: &|| false,
                        timeout_ms: 60_000,
                        idempotency_key: &batch.batch_id,
                        accepted_revision_ids: &accepted,
                        suppressed_revision_ids: &suppressed,
                        rejected_revision_ids: &candidates,
                        isolation_frontier: &frontier,
                    };
                    let result = receiver("http://127.0.0.1:1").send(&prepared, &batch, &context);
                    assert_eq!(failure(result), DeliveryFailure::ReceiverRejected);
                    blocked = true;
                    break;
                }
                let mut pages = isolation_pages_from_state(
                    &batch,
                    &rejected,
                    &accepted,
                    &suppressed,
                    &candidates,
                    &frontier,
                );
                pages.truncate(32);
                let (base, batch_server) = server(pages);
                auth(home, &base, "org-fixture");
                let context = ReceiverContext {
                    cancelled: &|| false,
                    timeout_ms: 60_000,
                    idempotency_key: &batch.batch_id,
                    accepted_revision_ids: &accepted,
                    suppressed_revision_ids: &suppressed,
                    rejected_revision_ids: &candidates,
                    isolation_frontier: &frontier,
                };
                let result = receiver(&base).send(&prepared, &batch, &context);
                let ack = match result {
                    Ok(ack) => ack,
                    Err(error) => {
                        assert_eq!(error.failure, DeliveryFailure::ReceiverRejected);
                        blocked = true;
                        batch_server.join().unwrap();
                        break;
                    }
                };
                assert!(ack.accepted_revision_ids.is_empty());
                assert!(ack.suppressed_revision_ids.is_empty());
                assert!(
                    ack.rejected_revision_ids.len() > candidates.len()
                        || ack.isolation_frontier != frontier
                );
                accepted = ack.accepted_revision_ids;
                suppressed = ack.suppressed_revision_ids;
                candidates = ack.rejected_revision_ids;
                frontier = ack.isolation_frontier;
                assert!(batch_server.join().unwrap().len() <= 32);
            }
            assert!(accepted.is_empty());
            assert!(suppressed.is_empty());
            assert!(blocked);
            assert!(!candidates.is_empty());

            let mut singleton = batch;
            singleton.records.truncate(1);
            let (base, server) = server(vec![
                (422, json!({"code":"invalid_json"})),
                (422, json!({"code":"invalid_json"})),
            ]);
            auth(home, &base, "org-fixture");
            let prepared = prepare(singleton.clone()).unwrap();
            for _ in 0..2 {
                let result = receiver(&base).send(&prepared, &singleton, &context(&singleton));
                assert_eq!(failure(result), DeliveryFailure::ReceiverRejected);
            }
            assert_eq!(server.join().unwrap().len(), 2);
        },
    );
}

#[test]
fn isolation_persists_candidates_until_an_accepted_sibling_is_found() {
    isolated(
        "isolation_persists_candidates_until_an_accepted_sibling_is_found",
        |home| {
            let mut batch = batch();
            let template = batch.records[0].clone();
            batch.records = (0..100)
                .map(|index| {
                    let mut record = template.clone();
                    record.record_id = format!("record-{index}");
                    record.revision_id = format!("revision-{index}");
                    record.revision += index as i64;
                    record
                })
                .collect();
            let accepted_id = batch.records[99].revision_id.clone();
            let rejected = batch
                .records
                .iter()
                .filter(|record| record.revision_id != accepted_id)
                .map(|record| record.revision_id.clone())
                .collect::<std::collections::HashSet<_>>();
            let prepared = prepare(batch.clone()).unwrap();
            let mut accepted = Vec::new();
            let mut suppressed = Vec::new();
            let mut candidates = Vec::new();
            let mut frontier: Vec<IsolationTask> = Vec::new();
            for _ in 0..10 {
                let mut pages = isolation_pages_from_state(
                    &batch,
                    &rejected,
                    &accepted,
                    &suppressed,
                    &candidates,
                    &frontier,
                );
                pages.truncate(32);
                let (base, batch_server) = server(pages);
                auth(home, &base, "org-fixture");
                let context = ReceiverContext {
                    cancelled: &|| false,
                    timeout_ms: 60_000,
                    idempotency_key: &batch.batch_id,
                    accepted_revision_ids: &accepted,
                    suppressed_revision_ids: &suppressed,
                    rejected_revision_ids: &candidates,
                    isolation_frontier: &frontier,
                };
                let ack = receiver(&base).send(&prepared, &batch, &context).unwrap();
                accepted = ack.accepted_revision_ids;
                suppressed = ack.suppressed_revision_ids;
                candidates = ack.rejected_revision_ids;
                frontier = ack.isolation_frontier;
                assert!(batch_server.join().unwrap().len() <= 32);
                if accepted.len() + suppressed.len() == batch.records.len() {
                    break;
                }
            }
            assert_eq!(accepted, vec![accepted_id]);
            assert_eq!(suppressed.len(), 99);
            assert!(candidates.is_empty());
            assert!(frontier.is_empty());
        },
    );
}

#[test]
fn bad_records_in_both_halves_are_individually_suppressed() {
    isolated(
        "bad_records_in_both_halves_are_individually_suppressed",
        |home| {
            let mut batch = batch();
            let template = batch.records[0].clone();
            batch.records = (0..100)
                .map(|index| {
                    let mut record = template.clone();
                    record.record_id = format!("record-{index}");
                    record.revision_id = format!("revision-{index}");
                    record.revision += index as i64;
                    record
                })
                .collect();
            let rejected = [
                batch.records[10].revision_id.clone(),
                batch.records[90].revision_id.clone(),
            ]
            .into_iter()
            .collect();
            let pages = isolation_pages(&batch, &rejected);
            assert!(pages.len() <= 32);
            let (base, server) = server(pages);
            auth(home, &base, "org-fixture");
            let ack = receiver(&base)
                .send(&prepare(batch.clone()).unwrap(), &batch, &context(&batch))
                .unwrap();
            assert_eq!(ack.accepted_revision_ids.len(), 98);
            assert_eq!(ack.suppressed_revision_ids.len(), 2);
            assert!(ack
                .suppressed_revision_ids
                .contains(&batch.records[10].revision_id));
            assert!(ack
                .suppressed_revision_ids
                .contains(&batch.records[90].revision_id));
            assert!(server.join().unwrap().len() <= 32);
        },
    );
}

#[test]
fn isolation_resumes_after_the_request_cap() {
    isolated("isolation_resumes_after_the_request_cap", |home| {
        let mut batch = batch();
        let template = batch.records[0].clone();
        batch.records = (0..100)
            .map(|index| {
                let mut record = template.clone();
                record.record_id = format!("record-{index}");
                record.revision_id = format!("revision-{index}");
                record.revision += index as i64;
                record
            })
            .collect();
        let rejected: std::collections::HashSet<_> = [0usize, 50, 99]
            .into_iter()
            .map(|index| batch.records[index].revision_id.clone())
            .collect();
        let mut first_pages = isolation_pages(&batch, &rejected);
        assert!(first_pages.len() > 32);
        first_pages.truncate(32);
        let (base, first_server) = server(first_pages);
        auth(home, &base, "org-fixture");
        let prepared = prepare(batch.clone()).unwrap();
        let first = receiver(&base)
            .send(&prepared, &batch, &context(&batch))
            .unwrap();
        assert_eq!(first_server.join().unwrap().len(), 32);
        let first_accounted =
            first.accepted_revision_ids.len() + first.suppressed_revision_ids.len();
        assert!((1..100).contains(&first_accounted));

        let second_pages = isolation_pages_from_state(
            &batch,
            &rejected,
            &first.accepted_revision_ids,
            &first.suppressed_revision_ids,
            &first.rejected_revision_ids,
            &first.isolation_frontier,
        );
        assert!(second_pages.len() <= 32);
        let (base, second_server) = server(second_pages);
        auth(home, &base, "org-fixture");
        let resumed = ReceiverContext {
            cancelled: &|| false,
            timeout_ms: 60_000,
            idempotency_key: &batch.batch_id,
            accepted_revision_ids: &first.accepted_revision_ids,
            suppressed_revision_ids: &first.suppressed_revision_ids,
            rejected_revision_ids: &first.rejected_revision_ids,
            isolation_frontier: &first.isolation_frontier,
        };
        let final_ack = receiver(&base).send(&prepared, &batch, &resumed).unwrap();
        assert_eq!(final_ack.accepted_revision_ids.len(), 97);
        assert_eq!(final_ack.suppressed_revision_ids.len(), 3);
        assert_eq!(
            final_ack.accepted_revision_ids.len() + final_ack.suppressed_revision_ids.len(),
            100
        );
        assert!(second_server.join().unwrap().len() <= 32);
    });
}

#[test]
fn isolation_resumes_when_deadline_expires_before_any_leaf_or_acceptance() {
    isolated(
        "isolation_resumes_when_deadline_expires_before_any_leaf_or_acceptance",
        |home| {
            let mut batch = batch();
            let template = batch.records[0].clone();
            batch.records = (0..8)
                .map(|index| {
                    let mut record = template.clone();
                    record.record_id = format!("record-{index}");
                    record.revision_id = format!("revision-{index}");
                    record.revision += index as i64;
                    record
                })
                .collect();
            let rejected = batch.records[..7]
                .iter()
                .map(|record| record.revision_id.clone())
                .collect::<std::collections::HashSet<_>>();
            let (spent, spend) = budget_spent_on(1);
            let (base, first_server) = server_with_hook(
                vec![(422, json!({"code":"invalid_json"})), (0, json!({}))],
                spend,
                |_| {},
            );
            auth(home, &base, "org-fixture");
            let prepared = prepare(batch.clone()).unwrap();
            let expiring = ReceiverContext {
                cancelled: &|| spent.load(Ordering::SeqCst),
                timeout_ms: 60_000,
                idempotency_key: &batch.batch_id,
                accepted_revision_ids: &[],
                suppressed_revision_ids: &[],
                rejected_revision_ids: &[],
                isolation_frontier: &[],
            };
            let first = receiver(&base).send(&prepared, &batch, &expiring).unwrap();
            assert!(first.accepted_revision_ids.is_empty());
            assert!(first.suppressed_revision_ids.is_empty());
            assert!(first.rejected_revision_ids.is_empty());
            assert!(!first.isolation_frontier.is_empty());
            assert_eq!(first_server.join().unwrap().len(), 2);

            let pages = isolation_pages_from_state(
                &batch,
                &rejected,
                &first.accepted_revision_ids,
                &first.suppressed_revision_ids,
                &first.rejected_revision_ids,
                &first.isolation_frontier,
            );
            let (base, second_server) = server(pages);
            auth(home, &base, "org-fixture");
            let resumed = ReceiverContext {
                cancelled: &|| false,
                timeout_ms: 60_000,
                idempotency_key: &batch.batch_id,
                accepted_revision_ids: &first.accepted_revision_ids,
                suppressed_revision_ids: &first.suppressed_revision_ids,
                rejected_revision_ids: &first.rejected_revision_ids,
                isolation_frontier: &first.isolation_frontier,
            };
            let final_ack = receiver(&base).send(&prepared, &batch, &resumed).unwrap();
            assert_eq!(final_ack.accepted_revision_ids.len(), 1);
            assert_eq!(final_ack.suppressed_revision_ids.len(), 7);
            assert!(final_ack.isolation_frontier.is_empty());
            assert!(second_server.join().unwrap().len() <= 32);
        },
    );
}

#[test]
fn incomplete_receipt_keeps_the_interrupted_frontier_task() {
    isolated(
        "incomplete_receipt_keeps_the_interrupted_frontier_task",
        |home| {
            let mut batch = batch();
            let template = batch.records[0].clone();
            batch.records = (0..4)
                .map(|index| {
                    let mut record = template.clone();
                    record.record_id = format!("record-{index}");
                    record.revision_id = format!("revision-{index}");
                    record.revision += index as i64;
                    record
                })
                .collect();
            let left = isolation_child(&batch, &batch.records[..2]);
            let right = isolation_child(&batch, &batch.records[2..]);
            let mut incomplete = accepted(&right);
            incomplete["acceptedRevisionIds"] = json!([right.records[0].revision_id.clone()]);
            let (base, server) = server(vec![(200, accepted(&left)), (200, incomplete)]);
            auth(home, &base, "org-fixture");
            let root = IsolationTask {
                revision_ids: batch
                    .records
                    .iter()
                    .map(|record| record.revision_id.clone())
                    .collect(),
                rejected: true,
            };
            let resumed = ReceiverContext {
                cancelled: &|| false,
                timeout_ms: 60_000,
                idempotency_key: &batch.batch_id,
                accepted_revision_ids: &[],
                suppressed_revision_ids: &[],
                rejected_revision_ids: &[],
                isolation_frontier: &[root],
            };
            let ack = receiver(&base)
                .send(&prepare(batch.clone()).unwrap(), &batch, &resumed)
                .unwrap();
            assert_eq!(ack.accepted_revision_ids.len(), 2);
            assert_eq!(ack.isolation_frontier.len(), 1);
            assert_eq!(
                ack.isolation_frontier[0].revision_ids,
                right
                    .records
                    .iter()
                    .map(|record| record.revision_id.clone())
                    .collect::<Vec<_>>()
            );
            assert!(!ack.isolation_frontier[0].rejected);
            assert_eq!(server.join().unwrap().len(), 2);
        },
    );
}

#[test]
fn isolation_resumes_after_the_call_budget_expires() {
    isolated("isolation_resumes_after_the_call_budget_expires", |home| {
        let mut batch = batch();
        let template = batch.records[0].clone();
        batch.records = (0..4)
            .map(|index| {
                let mut record = template.clone();
                record.record_id = format!("record-{index}");
                record.revision_id = format!("revision-{index}");
                record.revision += index as i64;
                record
            })
            .collect();
        let rejected = [batch.records[3].revision_id.clone()]
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let left = isolation_child(&batch, &batch.records[..2]);
        let (spent, spend) = budget_spent_on(2);
        let (base, first_server) = server_with_hook(
            vec![
                (422, json!({"code":"invalid_json"})),
                (200, accepted(&left)),
                (0, json!({})),
            ],
            spend,
            |_| {},
        );
        auth(home, &base, "org-fixture");
        let prepared = prepare(batch.clone()).unwrap();
        let expiring = ReceiverContext {
            cancelled: &|| spent.load(Ordering::SeqCst),
            timeout_ms: 60_000,
            idempotency_key: &batch.batch_id,
            accepted_revision_ids: &[],
            suppressed_revision_ids: &[],
            rejected_revision_ids: &[],
            isolation_frontier: &[],
        };
        let first = receiver(&base).send(&prepared, &batch, &expiring).unwrap();
        assert_eq!(first.accepted_revision_ids.len(), 2);
        assert!(first.suppressed_revision_ids.is_empty());
        assert_eq!(first_server.join().unwrap().len(), 3);

        let second_pages = isolation_pages_from_state(
            &batch,
            &rejected,
            &first.accepted_revision_ids,
            &first.suppressed_revision_ids,
            &first.rejected_revision_ids,
            &first.isolation_frontier,
        );
        let (base, second_server) = server(second_pages);
        auth(home, &base, "org-fixture");
        let resumed = ReceiverContext {
            cancelled: &|| false,
            timeout_ms: 60_000,
            idempotency_key: &batch.batch_id,
            accepted_revision_ids: &first.accepted_revision_ids,
            suppressed_revision_ids: &first.suppressed_revision_ids,
            rejected_revision_ids: &first.rejected_revision_ids,
            isolation_frontier: &first.isolation_frontier,
        };
        let final_ack = receiver(&base).send(&prepared, &batch, &resumed).unwrap();
        assert_eq!(final_ack.accepted_revision_ids.len(), 3);
        assert_eq!(final_ack.suppressed_revision_ids.len(), 1);
        assert_eq!(second_server.join().unwrap().len(), 3);
    });
}

#[test]
fn isolation_persists_rejected_candidates_when_the_budget_expires_before_acceptance() {
    isolated(
        "isolation_persists_rejected_candidates_when_the_budget_expires_before_acceptance",
        |home| {
            let mut batch = batch();
            let template = batch.records[0].clone();
            batch.records = (0..4)
                .map(|index| {
                    let mut record = template.clone();
                    record.record_id = format!("record-{index}");
                    record.revision_id = format!("revision-{index}");
                    record.revision += index as i64;
                    record
                })
                .collect();
            let rejected = batch.records[..3]
                .iter()
                .map(|record| record.revision_id.clone())
                .collect::<std::collections::HashSet<_>>();
            let (spent, spend) = budget_spent_on(5);
            let (base, first_server) = server_with_hook(
                vec![
                    (422, json!({"code":"invalid_json"})),
                    (422, json!({"code":"invalid_json"})),
                    (422, json!({"code":"invalid_json"})),
                    (422, json!({"code":"invalid_json"})),
                    (422, json!({"code":"invalid_json"})),
                    (0, json!({})),
                ],
                spend,
                |_| {},
            );
            auth(home, &base, "org-fixture");
            let prepared = prepare(batch.clone()).unwrap();
            let expiring = ReceiverContext {
                cancelled: &|| spent.load(Ordering::SeqCst),
                timeout_ms: 60_000,
                idempotency_key: &batch.batch_id,
                accepted_revision_ids: &[],
                suppressed_revision_ids: &[],
                rejected_revision_ids: &[],
                isolation_frontier: &[],
            };
            let first = receiver(&base).send(&prepared, &batch, &expiring).unwrap();
            assert!(first.accepted_revision_ids.is_empty());
            assert!(first.suppressed_revision_ids.is_empty());
            assert_eq!(first.rejected_revision_ids.len(), 2);
            assert_eq!(first_server.join().unwrap().len(), 6);

            let (base, second_server) = server(isolation_pages_from_state(
                &batch,
                &rejected,
                &first.accepted_revision_ids,
                &first.suppressed_revision_ids,
                &first.rejected_revision_ids,
                &first.isolation_frontier,
            ));
            auth(home, &base, "org-fixture");
            let resumed = ReceiverContext {
                cancelled: &|| false,
                timeout_ms: 60_000,
                idempotency_key: &batch.batch_id,
                accepted_revision_ids: &first.accepted_revision_ids,
                suppressed_revision_ids: &first.suppressed_revision_ids,
                rejected_revision_ids: &first.rejected_revision_ids,
                isolation_frontier: &first.isolation_frontier,
            };
            let final_ack = receiver(&base).send(&prepared, &batch, &resumed).unwrap();
            assert_eq!(final_ack.accepted_revision_ids.len(), 1);
            assert_eq!(final_ack.suppressed_revision_ids.len(), 3);
            assert!(final_ack.rejected_revision_ids.is_empty());
            assert_eq!(second_server.join().unwrap().len(), 2);
        },
    );
}

#[test]
fn non_content_4xx_responses_are_not_isolated() {
    isolated("non_content_4xx_responses_are_not_isolated", |home| {
        let batch = batch();
        let prepared = prepare(batch.clone()).unwrap();
        for (status, expected) in [
            (403, DeliveryFailure::PermissionDenied),
            (404, DeliveryFailure::UnsupportedEvidence),
            (413, DeliveryFailure::InvalidPayload),
            (429, DeliveryFailure::RateLimited),
        ] {
            let (base, server) = server(vec![(status, json!({"code":"classified"}))]);
            auth(home, &base, "org-fixture");
            let result = receiver(&base).send(&prepared, &batch, &context(&batch));
            assert_eq!(failure(result), expected);
            assert_eq!(server.join().unwrap().len(), 1);
        }
    });
}
#[test]
fn account_mismatch_and_prepared_mutation_fail_before_transport() {
    isolated(
        "account_mismatch_and_prepared_mutation_fail_before_transport",
        |home| {
            let batch = batch();
            let mut prepared = prepare(batch.clone()).unwrap();
            let base = "http://127.0.0.1:1";
            auth(home, base, "other-org");
            let receiver = receiver(base);
            assert_eq!(
                failure(receiver.send(&prepared, &batch, &context(&batch))),
                DeliveryFailure::PermissionDenied
            );
            prepared.body.push(' ');
            assert_eq!(
                failure(receiver.send(&prepared, &batch, &context(&batch))),
                DeliveryFailure::InvalidPayload
            );
        },
    );
}

/// A stored body is repaired into wire form before it is sent unless this
/// build's own `prepare` produced it. A body recorded as another build's goes
/// through the repair; one recorded as this build's is sent as stored. A body
/// whose bytes no longer match the digest stored with them is refused before
/// transport, whichever build it is recorded as.
#[test]
fn only_a_body_this_build_prepared_is_sent_without_the_wire_repair() {
    isolated(
        "only_a_body_this_build_prepared_is_sent_without_the_wire_repair",
        |home| {
            let mut batch = batch();
            batch.records[0].payload["prompt"] = json!("before\0after");
            // A body as an older build persisted it, NUL and all.
            let legacy =
                serde_json::to_string(&json!({"protocolVersion": 1, "batch": batch})).unwrap();
            assert!(legacy.contains("\\u0000"));
            let stored = |prepared_by| {
                PreparedPayload::stored(MAPPING_VERSION, "application/json", &legacy, prepared_by)
            };
            let (base, server) = server(vec![(200, accepted(&batch)), (200, accepted(&batch))]);
            auth(home, &base, "org-fixture");
            let receiver = receiver(&base);

            for prepared_by in [Some("0.0.0-dev+foreign@foreign"), Some(THIS_BUILD), None] {
                let mut tampered = stored(prepared_by);
                tampered.body.push(' ');
                assert_eq!(
                    failure(receiver.send(&tampered, &batch, &context(&batch))),
                    DeliveryFailure::InvalidPayload
                );
            }
            let foreign = stored(Some("0.0.0-dev+foreign@foreign"));
            receiver.send(&foreign, &batch, &context(&batch)).unwrap();
            let here = stored(Some(THIS_BUILD));
            receiver.send(&here, &batch, &context(&batch)).unwrap();

            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 2);
            let repaired = &requests[0].1;
            assert!(!repaired.contains("\\u0000") && repaired.contains("before\u{FFFD}after"));
            assert_eq!(requests[1].1, legacy);
        },
    );
}

/// The receiver's own assertions about the generation a host configured are
/// rechecked on every prepare and send, not only when a job is created.
#[test]
fn asserted_account_and_instance_are_rechecked_before_every_dispatch() {
    isolated(
        "asserted_account_and_instance_are_rechecked_before_every_dispatch",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            let base = "http://127.0.0.1:1";
            auth(home, base, "org-fixture");
            let other_account = RelayHistoryReceiver {
                expected_account: Some(account_id("other-org", None)),
                ..receiver(base)
            };
            let other_instance = RelayHistoryReceiver {
                instance_id: Some("another-generation".into()),
                ..receiver(base)
            };
            for (receiver, expected) in [
                (other_account, DeliveryFailure::PermissionDenied),
                (other_instance, DeliveryFailure::MappingVersionMismatch),
            ] {
                assert_eq!(
                    failure(receiver.prepare(&batch, &context(&batch))),
                    expected
                );
                assert_eq!(
                    failure(receiver.send(&prepared, &batch, &context(&batch))),
                    expected
                );
            }
            // The same assertions matching the batch reach the transport instead.
            let matching = RelayHistoryReceiver {
                expected_account: Some(batch.account_id.clone()),
                instance_id: Some(batch.instance_id.clone()),
                ..receiver(base)
            };
            assert_eq!(
                matching.prepare(&batch, &context(&batch)).unwrap().body,
                prepared.body
            );
            assert_eq!(
                failure(matching.send(&prepared, &batch, &context(&batch))),
                DeliveryFailure::Transient
            );
        },
    );
}

#[test]
fn a_rate_limit_during_isolation_keeps_its_failure_class() {
    isolated(
        "a_rate_limit_during_isolation_keeps_its_failure_class",
        |home| {
            let mut batch = batch();
            let template = batch.records[0].clone();
            batch.records = (0..4)
                .map(|index| {
                    let mut record = template.clone();
                    record.record_id = format!("record-{index}");
                    record.revision_id = format!("revision-{index}");
                    record.revision += index as i64;
                    record
                })
                .collect();
            let (base, server) = server(vec![
                (422, json!({"code":"invalid_json"})),
                (429, json!({"code":"rate_limited"})),
            ]);
            auth(home, &base, "org-fixture");
            let result =
                receiver(&base).send(&prepare(batch.clone()).unwrap(), &batch, &context(&batch));
            assert_eq!(failure(result), DeliveryFailure::RateLimited);
            assert_eq!(server.join().unwrap().len(), 2);
        },
    );
}

#[test]
fn receipt_overlap_and_duplicate_revisions_are_rejected() {
    isolated(
        "receipt_overlap_and_duplicate_revisions_are_rejected",
        |home| {
            let batch = batch();
            let mut duplicate = batch.clone();
            duplicate.records.push(duplicate.records[0].clone());
            assert!(prepare(duplicate).is_err());
            let mut response = accepted(&batch);
            response["unsupportedRevisionIds"] = json!([batch.records[0].revision_id]);
            let (base, server) = server(vec![(200, response)]);
            auth(home, &base, "org-fixture");
            let result =
                receiver(&base).send(&prepare(batch.clone()).unwrap(), &batch, &context(&batch));
            assert_eq!(failure(result), DeliveryFailure::InvalidPayload);
            server.join().unwrap();
        },
    );
}
#[test]
fn default_size_payload_prepares_under_the_body_cap() {
    let mut batch = batch();
    batch.records.truncate(1);
    batch.records[0].payload = json!({"prompt":"\u{1}".repeat(150_000)});
    let prepared = prepare(batch).unwrap();
    assert!(prepared.body.len() > 900_000);
    assert!(prepared.body.len() < 1_048_576);
}

#[test]
fn preparation_matches_server_record_limit_before_persisting_invalid_payload() {
    let mut batch = batch();
    let template = batch.records[0].clone();
    batch.records = (0..100)
        .map(|index| {
            let mut record = template.clone();
            record.record_id = format!("record-{index}");
            record.revision_id = format!("revision-{index}");
            record
        })
        .collect();
    assert!(prepare(batch.clone()).is_ok());
    let mut extra = template;
    extra.record_id = "record-100".into();
    extra.revision_id = "revision-100".into();
    batch.records.push(extra);
    assert!(prepare(batch).is_err());
}

#[test]
fn receiver_deadlines_and_cancellation_cover_transport_refresh_and_lock_waits() {
    // Isolate stored credentials and schedule discovery from other tests and
    // from the host. All HTTP traffic goes to synthetic loopback receivers.
    const CHILD: &str = "RELAY_TEST_RECEIVER_DEADLINE";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "receiver_deadlines_and_cancellation_cover_transport_refresh_and_lock_waits",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("HOME", home.path())
            .env("RELAYHISTORY_HOME", home.path())
            .env_remove("RELAYHISTORY_BASE_URL")
            .env_remove("AI_HIST_BASE_URL")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    use std::sync::mpsc;
    let home = std::env::var_os("RELAYHISTORY_HOME").unwrap();
    let home = Path::new(&home);
    let batch = batch();
    let prepared = prepare(batch.clone()).unwrap();
    let cancelled = ReceiverContext {
        cancelled: &|| true,
        timeout_ms: 60_000,
        idempotency_key: &batch.batch_id,
        accepted_revision_ids: &[],
        suppressed_revision_ids: &[],
        rejected_revision_ids: &[],
        isolation_frontier: &[],
    };
    let receiver = RelayHistoryReceiver::default();
    assert_eq!(
        receiver.prepare(&batch, &cancelled).unwrap_err().failure,
        DeliveryFailure::Transient
    );
    assert_eq!(
        receiver
            .send(&prepared, &batch, &cancelled)
            .unwrap_err()
            .failure,
        DeliveryFailure::Transient
    );

    for phase in [
        "headers",
        "body",
        "refresh",
        "lock",
        "cancel-refresh",
        "cancel-retry",
        "success",
    ] {
        let cancelled = Arc::new(AtomicBool::new(false));
        let server_cancelled = cancelled.clone();
        let (entered, ready) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let pages = match phase {
            "refresh" | "cancel-retry" => vec![
                (401, json!({})),
                (
                    if phase == "refresh" { 0 } else { 200 },
                    json!({"accessToken":"rth_at_rotated", "refreshToken":"rth_rt_rotated"}),
                ),
            ],
            "lock" | "cancel-refresh" => vec![(401, json!({}))],
            "success" => vec![(200, accepted(&batch))],
            _ => vec![(0, json!({}))],
        };
        let (completed, completion) = mpsc::channel();
        let (base, server) = server_with_hook(
            pages,
            move |index, stream| {
                if phase == "cancel-refresh" || (phase == "cancel-retry" && index == 1) {
                    server_cancelled.store(true, Ordering::SeqCst);
                }
                if phase == "body" {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n").unwrap();
                }
                if matches!(phase, "headers" | "body") || (phase == "refresh" && index == 1) {
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(10)).unwrap();
                }
                if phase == "success" {
                    thread::sleep(Duration::from_millis(150));
                }
            },
            move |listener| {
                completion.recv_timeout(Duration::from_secs(10)).unwrap();
                // Keep listening until the caller has returned: a forbidden refresh
                // or retry would otherwise just get connection-refused and look transient.
                assert!(
                    matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
                    "{phase}: unexpected additional request"
                );
            },
        );
        auth(home, &base, "org-fixture");
        let auth_path = home
            .join("stages")
            .join(format!("{}.auth.json", stage_key(&base)));
        let mut stored: Value =
            serde_json::from_slice(&std::fs::read(&auth_path).unwrap()).unwrap();
        stored["refresh_token"] = json!("rth_rt_fixture");
        std::fs::write(&auth_path, stored.to_string()).unwrap();
        let lock = if phase == "lock" {
            let path = auth_path.with_file_name(format!(
                "{}.refresh.lock",
                auth_path.file_name().unwrap().to_str().unwrap()
            ));
            let file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(path)
                .unwrap();
            fs2::FileExt::lock_exclusive(&file).unwrap();
            Some(file)
        } else {
            None
        };
        let receiver = RelayHistoryReceiver {
            base_url: Some(base),
            acknowledge_uninspected_schedules: true,
            ..Default::default()
        };
        let payload = prepared.clone();
        let batch = batch.clone();
        let (done, result) = mpsc::channel();
        let worker = thread::spawn(move || {
            let context = ReceiverContext {
                cancelled: &|| cancelled.load(Ordering::SeqCst),
                timeout_ms: if phase == "success" { 60_000 } else { 500 },
                idempotency_key: &batch.batch_id,
                accepted_revision_ids: &[],
                suppressed_revision_ids: &[],
                rejected_revision_ids: &[],
                isolation_frontier: &[],
            };
            done.send(receiver.send(&payload, &batch, &context))
                .unwrap();
        });
        if matches!(phase, "headers" | "body" | "refresh") {
            ready.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        let outcome = result.recv_timeout(Duration::from_secs(2));
        // Always unblock fixtures before asserting so a regression cannot hang.
        let _ = release.send(());
        drop(lock);
        worker.join().unwrap();
        completed.send(()).unwrap();
        let requests = server.join().unwrap();
        let outcome =
            outcome.unwrap_or_else(|_| panic!("{phase}: receiver exceeded the supplied budget"));
        if phase == "success" {
            assert!(outcome.is_ok());
        } else {
            assert_eq!(
                outcome.unwrap_err().failure,
                DeliveryFailure::Transient,
                "{phase}"
            );
        }
        assert_eq!(
            requests.len(),
            if matches!(phase, "refresh" | "cancel-retry") {
                2
            } else {
                1
            }
        );
        if phase == "cancel-retry" {
            let rotated: Value =
                serde_json::from_slice(&std::fs::read(&auth_path).unwrap()).unwrap();
            assert_eq!(rotated["refresh_token"], "rth_rt_rotated");
        }
    }
}

/// A loopback receiver that keeps connections alive and answers each request
/// with the next status in `statuses`, a receipt for `batch` on 200. Returns
/// the base URL, a count of accepted connections, and each request's bearer.
fn keep_alive_server(
    statuses: Vec<u16>,
    batch: &HistoryExportBatch,
) -> (
    String,
    Arc<std::sync::atomic::AtomicUsize>,
    Arc<std::sync::Mutex<Vec<String>>>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let connections = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let bearers = Arc::new(std::sync::Mutex::new(Vec::new()));
    let receipt = accepted(batch).to_string();
    let statuses = Arc::new(std::sync::Mutex::new(statuses.into_iter()));
    let (counted, seen) = (connections.clone(), bearers.clone());
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            counted.fetch_add(1, Ordering::SeqCst);
            let (statuses, seen, receipt) = (statuses.clone(), seen.clone(), receipt.clone());
            thread::spawn(move || {
                let mut writer = stream.try_clone().unwrap();
                let mut reader = BufReader::new(stream);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let mut length = 0;
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        if header == "\r\n" {
                            break;
                        }
                        let lower = header.to_ascii_lowercase();
                        if let Some(value) = lower.strip_prefix("content-length:") {
                            length = value.trim().parse().unwrap();
                        }
                        if lower.starts_with("authorization:") {
                            seen.lock()
                                .unwrap()
                                .push(header["authorization:".len()..].trim().to_owned());
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let status = statuses
                        .lock()
                        .unwrap()
                        .next()
                        .expect("an expected request");
                    let answer = if status == 200 {
                        receipt.clone()
                    } else {
                        "{}".into()
                    };
                    write!(
                        writer,
                        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{answer}",
                        answer.len()
                    )
                    .unwrap();
                }
            });
        }
    });
    (base, connections, bearers)
}

/// Consecutive batches share one kept-alive connection, and a receiver keeps
/// the session it last used: a token another process rotated meanwhile is
/// read again only once the receiver's copy is refused, without a refresh.
#[test]
fn consecutive_sends_share_a_connection_and_reread_a_rotated_session_on_401() {
    isolated(
        "consecutive_sends_share_a_connection_and_reread_a_rotated_session_on_401",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            let (base, connections, bearers) = keep_alive_server(vec![200, 401, 200, 200], &batch);
            let stored = |token: &str| {
                let stages = home.join("stages");
                std::fs::create_dir_all(&stages).unwrap();
                let expires = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
                std::fs::write(
                    stages.join(format!("{}.auth.json", stage_key(&base))),
                    json!({"base_url":base,"access_token":token,"access_token_expires_at":expires,
                           "refresh_token":"rth_rt_fixture","org_id":"org-fixture"})
                    .to_string(),
                )
                .unwrap();
            };
            stored("rth_at_first");
            let receiver = receiver(&base);
            receiver.send(&prepared, &batch, &context(&batch)).unwrap();
            // Another process rotates the stored pair.
            stored("rth_at_second");
            receiver.send(&prepared, &batch, &context(&batch)).unwrap();
            receiver.send(&prepared, &batch, &context(&batch)).unwrap();
            assert_eq!(
                *bearers.lock().unwrap(),
                [
                    "Bearer rth_at_first",
                    "Bearer rth_at_first",
                    "Bearer rth_at_second",
                    "Bearer rth_at_second"
                ]
            );
            assert_eq!(connections.load(Ordering::SeqCst), 1);
        },
    );
}

/// A receipt's published limits size the receiver's next batches; a receipt
/// without them, from an older server, returns it to the protocol default,
/// and malformed ones are ignored rather than refusing the receipt.
#[test]
fn receipts_publish_the_limits_the_next_batches_are_sized_by() {
    isolated(
        "receipts_publish_the_limits_the_next_batches_are_sized_by",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            let mut published = accepted(&batch);
            published["limits"] = json!({"maxRecords": 500, "maxRequestBytes": 2_097_152});
            let mut malformed = accepted(&batch);
            malformed["limits"] = json!({"maxRecords": -1, "maxRequestBytes": "big"});
            let (base, server) = server(vec![
                // An older server, without the limits endpoint.
                (404, json!({})),
                (200, published),
                (200, accepted(&batch)),
                (200, malformed),
            ]);
            auth(home, &base, "org-fixture");
            let receiver = receiver(&base);
            assert_eq!(
                receiver.published_limits(&limits_context()),
                PublishedLimits::default()
            );
            receiver.send(&prepared, &batch, &context(&batch)).unwrap();
            assert_eq!(
                receiver.published_limits(&limits_context()),
                PublishedLimits {
                    max_records: Some(500),
                    max_request_bytes: Some(2_097_152),
                }
            );
            // Clones share what the receiver learned.
            assert_eq!(
                receiver.clone().published_limits(&limits_context()),
                receiver.published_limits(&limits_context())
            );
            receiver.send(&prepared, &batch, &context(&batch)).unwrap();
            assert_eq!(
                receiver.published_limits(&limits_context()),
                PublishedLimits::default()
            );
            receiver.send(&prepared, &batch, &context(&batch)).unwrap();
            assert_eq!(
                receiver.published_limits(&limits_context()),
                PublishedLimits::default()
            );
            // The limits are asked for once, never again after a receipt.
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 4);
            assert!(requests[0].0.starts_with("GET /v1/delivery/limits "));
        },
    );
}

/// A server that publishes request-body codings receives each batch in the
/// first one it prefers, decoding to exactly the stored bytes; a receipt that
/// names another coding, or none (an older server), changes what the next
/// batch is sent with.
#[test]
fn batches_are_compressed_with_the_coding_the_server_publishes() {
    isolated(
        "batches_are_compressed_with_the_coding_the_server_publishes",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            let mut gzip_only = accepted(&batch);
            gzip_only["limits"] = json!({"maxRecords": 500, "contentEncodings": ["br", "gzip"]});
            let (base, server) = server(vec![
                (
                    200,
                    json!({"maxRecords": 500, "maxRequestBytes": 2_097_152,
                           "contentEncodings": ["zstd", "gzip"]}),
                ),
                (200, gzip_only),
                (200, accepted(&batch)),
                (200, accepted(&batch)),
            ]);
            auth(home, &base, "org-fixture");
            let receiver = receiver(&base);
            receiver.published_limits(&limits_context());
            for _ in 0..3 {
                receiver.send(&prepared, &batch, &context(&batch)).unwrap();
            }
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 4);
            let sent: Vec<_> = requests[1..]
                .iter()
                .map(|(headers, body)| {
                    assert_eq!(body, &prepared.body);
                    content_encoding(headers)
                })
                .collect();
            assert_eq!(
                sent,
                [Some("zstd".to_owned()), Some("gzip".to_owned()), None]
            );
        },
    );
}

/// A server that refuses a compressed body (one rolled back to before it
/// decoded the coding it published) gets the same batch once more as stored,
/// in the same send, and uncompressed batches until a receipt publishes a
/// coding again.
#[test]
fn a_refused_coding_resends_the_stored_bytes_and_stops_compressing() {
    isolated(
        "a_refused_coding_resends_the_stored_bytes_and_stops_compressing",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            for status in [400, 415] {
                let (base, server) = server(vec![
                    (
                        200,
                        json!({"maxRecords": 500, "contentEncodings": ["zstd"]}),
                    ),
                    (
                        status,
                        json!({"error": {"code": "invalid_delivery", "message": "not JSON"}}),
                    ),
                    (200, accepted(&batch)),
                    (200, accepted(&batch)),
                ]);
                auth(home, &base, "org-fixture");
                let receiver = receiver(&base);
                receiver.published_limits(&limits_context());
                let acknowledged = receiver.send(&prepared, &batch, &context(&batch)).unwrap();
                assert_eq!(
                    acknowledged.accepted_revision_ids.len(),
                    batch.records.len()
                );
                receiver.send(&prepared, &batch, &context(&batch)).unwrap();
                let requests = server.join().unwrap();
                assert_eq!(requests.len(), 4, "{status}");
                let sent: Vec<_> = requests[1..]
                    .iter()
                    .map(|(headers, body)| {
                        assert_eq!(body, &prepared.body);
                        content_encoding(headers)
                    })
                    .collect();
                assert_eq!(sent, [Some("zstd".to_owned()), None, None], "{status}");
            }
        },
    );
}

/// A refused coding that leaves no budget to resend the stored bytes ends the
/// send as a stopped drain does, so the worker retries the batch, and the
/// retry posts the stored bytes rather than failing it for the coding.
#[test]
fn a_refused_coding_without_budget_left_is_retried_uncompressed() {
    isolated(
        "a_refused_coding_without_budget_left_is_retried_uncompressed",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            for status in [400, 415] {
                let stop = Arc::new(AtomicBool::new(false));
                let stopping = stop.clone();
                let (base, server) = server_with_hook(
                    vec![
                        (
                            200,
                            json!({"maxRecords": 500, "contentEncodings": ["zstd"]}),
                        ),
                        (status, json!({"error": {"code": "unsupported_encoding"}})),
                        (200, accepted(&batch)),
                    ],
                    move |index, _| {
                        if index == 1 {
                            stopping.store(true, Ordering::SeqCst);
                        }
                    },
                    |_| {},
                );
                auth(home, &base, "org-fixture");
                let receiver = receiver(&base);
                receiver.published_limits(&limits_context());
                let cancelled = || stop.load(Ordering::SeqCst);
                let stopped = ReceiverContext {
                    cancelled: &cancelled,
                    ..context(&batch)
                };
                let first = receiver.send(&prepared, &batch, &stopped);
                assert_eq!(failure(first), DeliveryFailure::Transient, "{status}");
                stop.store(false, Ordering::SeqCst);
                receiver.send(&prepared, &batch, &context(&batch)).unwrap();
                let requests = server.join().unwrap();
                assert_eq!(requests.len(), 3, "{status}");
                let sent: Vec<_> = requests[1..]
                    .iter()
                    .map(|(headers, body)| {
                        assert_eq!(body, &prepared.body);
                        content_encoding(headers)
                    })
                    .collect();
                assert_eq!(sent, [Some("zstd".to_owned()), None], "{status}");
            }
        },
    );
}

/// A refused coding stays refused for the rest of the send: when the
/// uncompressed resend meets an expired session, the request repeated after
/// the token refresh carries the stored bytes, not the refused compressed ones.
#[test]
fn a_refresh_after_a_refused_coding_reposts_the_stored_bytes() {
    isolated(
        "a_refresh_after_a_refused_coding_reposts_the_stored_bytes",
        |home| {
            let batch = batch();
            let prepared = prepare(batch.clone()).unwrap();
            let (base, server) = server(vec![
                (
                    200,
                    json!({"maxRecords": 500, "contentEncodings": ["zstd"]}),
                ),
                (415, json!({"error": {"code": "unsupported_encoding"}})),
                (401, json!({})),
                (
                    200,
                    json!({"accessToken":"rth_at_rotated", "refreshToken":"rth_rt_rotated"}),
                ),
                (200, accepted(&batch)),
            ]);
            auth(home, &base, "org-fixture");
            let auth_path = home
                .join("stages")
                .join(format!("{}.auth.json", stage_key(&base)));
            let mut stored: Value =
                serde_json::from_slice(&std::fs::read(&auth_path).unwrap()).unwrap();
            stored["refresh_token"] = json!("rth_rt_fixture");
            std::fs::write(&auth_path, stored.to_string()).unwrap();
            let receiver = receiver(&base);
            receiver.published_limits(&limits_context());
            receiver.send(&prepared, &batch, &context(&batch)).unwrap();
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 5);
            assert!(requests[3].0.starts_with("POST /v1/auth/token/refresh "));
            let batches: Vec<_> = [1, 2, 4]
                .iter()
                .map(|&index| {
                    let (headers, body) = &requests[index];
                    assert!(headers.starts_with("POST /v1/delivery/batches "));
                    assert_eq!(body, &prepared.body);
                    content_encoding(headers)
                })
                .collect();
            assert_eq!(batches, [Some("zstd".to_owned()), None, None]);
        },
    );
}

/// Before any receipt, the receiver asks the server for its limits once, so
/// the first batches of a run are sized by them rather than the protocol's
/// default; a failure to ask reads as no limits and is not repeated.
#[test]
fn the_first_batches_are_sized_by_the_limits_the_server_publishes() {
    isolated(
        "the_first_batches_are_sized_by_the_limits_the_server_publishes",
        |home| {
            let (base, server) = server(vec![(
                200,
                json!({"maxRecords": 250, "maxRequestBytes": 1_000_000}),
            )]);
            auth(home, &base, "org-fixture");
            let receiver = receiver(&base);
            let limits = PublishedLimits {
                max_records: Some(250),
                max_request_bytes: Some(1_000_000),
            };
            assert_eq!(receiver.published_limits(&limits_context()), limits);
            assert_eq!(receiver.clone().published_limits(&limits_context()), limits);
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].0.starts_with("GET /v1/delivery/limits "));
            assert!(requests[0]
                .0
                .to_ascii_lowercase()
                .contains("authorization: bearer rth_at_fixture"));

            let (base, closing) = self::server(vec![(0, json!({}))]);
            auth(home, &base, "org-fixture");
            let failed = self::receiver(&base);
            assert_eq!(
                failed.published_limits(&limits_context()),
                PublishedLimits::default()
            );
            assert_eq!(
                failed.published_limits(&limits_context()),
                PublishedLimits::default()
            );
            assert_eq!(closing.join().unwrap().len(), 1);
        },
    );
}

/// The limits request stays within the drain's request deadline and stops
/// with it: a stalled server costs the remaining budget, not the full limits
/// timeout, and a stopped drain does not ask at all.
#[test]
fn the_limits_request_honors_the_drain_deadline_and_stop() {
    isolated(
        "the_limits_request_honors_the_drain_deadline_and_stop",
        |home| {
            let (base, stalled) = server_with_hook(
                vec![(0, json!({}))],
                |_, _| thread::sleep(Duration::from_millis(3_000)),
                |_| {},
            );
            auth(home, &base, "org-fixture");
            let started = std::time::Instant::now();
            let short = LimitsContext {
                cancelled: &never,
                timeout_ms: 300,
            };
            assert_eq!(
                receiver(&base).published_limits(&short),
                PublishedLimits::default()
            );
            assert!(started.elapsed() < Duration::from_millis(2_500));
            assert_eq!(stalled.join().unwrap().len(), 1);

            let (base, idle) = server(vec![]);
            auth(home, &base, "org-fixture");
            let stopped = LimitsContext {
                cancelled: &|| true,
                timeout_ms: 30_000,
            };
            assert_eq!(
                receiver(&base).published_limits(&stopped),
                PublishedLimits::default()
            );
            assert!(idle.join().unwrap().is_empty());
        },
    );
}

/// The limits request authenticates like a batch: a 401 for an expired
/// session goes through the shared refresh, and the refreshed bearer asks
/// again within the same one-time probe.
#[test]
fn the_limits_request_refreshes_an_expired_session() {
    isolated("the_limits_request_refreshes_an_expired_session", |home| {
        let (base, server) = server(vec![
            (401, json!({})),
            (
                200,
                json!({"accessToken":"rth_at_rotated", "refreshToken":"rth_rt_rotated"}),
            ),
            (
                200,
                json!({"maxRecords": 250, "maxRequestBytes": 1_000_000}),
            ),
        ]);
        auth(home, &base, "org-fixture");
        let auth_path = home
            .join("stages")
            .join(format!("{}.auth.json", stage_key(&base)));
        let mut stored: Value =
            serde_json::from_slice(&std::fs::read(&auth_path).unwrap()).unwrap();
        stored["refresh_token"] = json!("rth_rt_fixture");
        std::fs::write(&auth_path, stored.to_string()).unwrap();
        let receiver = receiver(&base);
        let limits = PublishedLimits {
            max_records: Some(250),
            max_request_bytes: Some(1_000_000),
        };
        assert_eq!(receiver.published_limits(&limits_context()), limits);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        let bearer = |index: usize| {
            requests[index]
                .0
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("authorization: bearer ")
                        .map(str::to_owned)
                })
                .unwrap()
        };
        assert!(requests[0].0.starts_with("GET /v1/delivery/limits "));
        assert_eq!(bearer(0), "rth_at_fixture");
        assert!(requests[1].0.starts_with("POST /v1/auth/token/refresh "));
        assert!(requests[2].0.starts_with("GET /v1/delivery/limits "));
        assert_eq!(bearer(2), "rth_at_rotated");
        let rotated: Value = serde_json::from_slice(&std::fs::read(&auth_path).unwrap()).unwrap();
        assert_eq!(rotated["refresh_token"], "rth_rt_rotated");
    });
}

/// The receiver maps any batch up to the most records a server may publish,
/// so a batch prepared under a raised limit is still mapped after a restart
/// forgot that limit; more than that is refused before it is persisted.
#[test]
fn the_receiver_maps_batches_up_to_the_published_ceiling() {
    let mut batch = batch();
    let template = batch.records[0].clone();
    let records = |count: usize| {
        (0..count)
            .map(|index| {
                let mut record = template.clone();
                record.record_id = format!("record-{index}");
                record.revision_id = format!("revision-{index}");
                record
            })
            .collect::<Vec<_>>()
    };
    let receiver = receiver("http://127.0.0.1:9");
    batch.records = records(MAX_PUBLISHED_BATCH_RECORDS);
    assert!(receiver.prepare(&batch, &context(&batch)).is_ok());
    assert!(prepare(batch.clone()).is_err());
    batch.records = records(MAX_PUBLISHED_BATCH_RECORDS + 1);
    assert_eq!(
        failure(receiver.prepare(&batch, &context(&batch))),
        DeliveryFailure::InvalidPayload
    );
}
