//! Real SDK capture/backfill and real collector in the host's synthetic home.
//! The first HTTP batch is held until the native row has rendered.
use super::Receipts;
use agent_relay_probe::relay::uploader::{InstallRun, ProbeRunner, ProcessRunner, UploaderError};
use agent_relay_probe::relay::workspace::Secret;
use agent_relay_probe::{
    delivery::{self, DeliveryJobConfig, ExportSelection},
    destination,
};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{Notify, Semaphore},
};

/// Use the collector's production discovery function; env_clear alone does
/// not exclude a running Claude process with a custom config root.
pub fn assert_isolated_roots(home: &Path, receipts: &Receipts) {
    let home = home.canonicalize().unwrap();
    let roots = agent_relay_probe::relay::claude_dirs::running_config_dirs(
        &agent_relay_probe::relay::process::SystemProcesses::default(),
    );
    let outside = roots
        .iter()
        .filter(|path| {
            !path
                .canonicalize()
                .unwrap_or_else(|_| (*path).clone())
                .starts_with(&home)
        })
        .count();
    receipts.record(
        "provider_root_guard",
        json!({"outside_custom_claude_roots":outside,"values_redacted":true}),
    );
    assert_eq!(outside,0,"outside custom Claude root detected; refusing isolated collector fixture (values redacted)");
}

pub struct Runner {
    actual: Mutex<Option<Arc<ProcessRunner>>>,
    home: PathBuf,
    pub held: AtomicBool,
    pub release: Notify,
    pub status_started: AtomicBool,
    pub status_success: AtomicBool,
    receipts: Arc<Receipts>,
}
impl Runner {
    pub fn new(home: PathBuf, receipts: Arc<Receipts>) -> Self {
        Self {
            actual: Mutex::default(),
            home,
            held: AtomicBool::new(false),
            release: Notify::new(),
            status_started: AtomicBool::new(false),
            status_success: AtomicBool::new(false),
            receipts,
        }
    }
    pub fn configure(&self, probe: PathBuf) {
        *self.actual.lock().unwrap() = Some(Arc::new(
            ProcessRunner::new(probe)
                .with_env("HOME", &self.home)
                .with_env("CLAUDE_CONFIG_DIR", self.home.join(".claude"))
                .with_env("CODEX_HOME", self.home.join(".codex"))
                .with_env(
                    "OPENCODE_DB",
                    self.home.join(".local/share/opencode/opencode.db"),
                ),
        ));
    }
}
impl ProbeRunner for Runner {
    fn history_access_root(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn run(
        &self,
        args: Vec<String>,
        timeout: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        Box::pin(async move {
            let actual = self.actual.lock().unwrap().clone();
            let Some(actual) = actual else {
                return if args.first().is_some_and(|arg| arg == "installs") {
                    Ok(json!({"installs":[]}))
                } else {
                    Err(UploaderError::new("isolated history fixture not started"))
                };
            };
            let status = args.first().is_some_and(|arg| arg == "status");
            let result = actual.run(args, timeout).await;
            if status && self.held.load(Ordering::SeqCst) {
                self.status_success.store(result.is_ok(), Ordering::SeqCst);
                self.status_started.store(true, Ordering::SeqCst);
                self.receipts.record(
                    "status_enrichment_held",
                    json!({"actual_helper_completed":result.is_ok()}),
                );
                loop {
                    let wake = self.release.notified();
                    if !self.held.load(Ordering::SeqCst) {
                        break;
                    }
                    wake.await;
                }
            }
            result
        })
    }
    fn install(&self, _: Vec<String>, _: Option<Secret>) -> Result<InstallRun, UploaderError> {
        Err(UploaderError::new("no fixture installs through UI"))
    }
    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
        Box::pin(async move {
            self.held.store(false, Ordering::SeqCst);
            self.release.notify_waiters();
            let actual = self.actual.lock().unwrap().clone();
            if let Some(actual) = actual {
                actual.cancel_all().await
            } else {
                Ok(())
            }
        })
    }
}

fn db_identity(path: &Path) -> Value {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(metadata) => {
            json!({"inode":metadata.ino(),"device":metadata.dev(),"bytes":metadata.len()})
        }
        Err(error) => json!({"missing_or_error":error.to_string()}),
    }
}

fn install_directory(home: &Path) -> PathBuf {
    let site = "http://127.0.0.1:3100";
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(site, "account", "workspace")).unwrap())
    );
    home.join(".agentworkforce/probe").join(key)
}

fn initialize_install(home: &Path, base: &str) -> (PathBuf, String) {
    let site = "http://127.0.0.1:3100";
    let directory = install_directory(home);
    std::fs::create_dir_all(directory.join("stages")).unwrap();
    let stage = format!("{:x}", Sha256::digest(base.as_bytes()))[..16].to_owned();
    std::fs::write(directory.join(format!("stages/{stage}.auth.json")),json!({"base_url":base,"access_token":"rth_at_fixture","access_token_expires_at":"2099-01-01T00:00:00Z","org_id":"org","workspace_id":"workspace"}).to_string()).unwrap();
    let conn = delivery::open_db(&directory.join("history.db")).unwrap();
    let job = delivery::create_job(
        &conn,
        &DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "teams-probe".into(),
            account_id: destination::account_id("org", Some("workspace")),
            mapping_version: destination::MAPPING_VERSION.into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: delivery::SUPPORTED_KINDS
                    .iter()
                    .map(|kind| (*kind).into())
                    .collect(),
                sessionless: true,
                ..Default::default()
            },
            limits: Default::default(),
        },
        0,
    )
    .unwrap();
    drop(conn);
    std::fs::write(directory.join("config.json"),json!({"version":1,"site_url":site,"account_id":"account","org_id":"org","workspace_id":"workspace","history_url":base,"delivery_account":job.config.account_id,"job_id":job.job_id,"include_existing":true,"sharing_mode":null,"acknowledge_uninspected_schedules":true}).to_string()).unwrap();
    (directory, job.job_id)
}
pub fn prepare_empty(home: &Path) -> PathBuf {
    let (directory, _) = initialize_install(home, "http://127.0.0.1:1");
    let roots = ai_hist::ProviderRoots::from_home(
        home.to_path_buf(),
        home.join(".local/share/opencode/opencode.db"),
    );
    let store = ai_hist::SessionStore::open(
        ai_hist::StoreOptions::default()
            .db_path(directory.join("history.db"))
            .roots(roots),
    )
    .unwrap();
    drop(store); // Initialize schema only: no sync, helper, or collector.

    directory
}

#[derive(Clone)]
struct MarkerStamp {
    generation: i64,
    origin: String,
    base: i64,
    epoch: i64,
    config: String,
}
impl MarkerStamp {
    fn read(conn: &rusqlite::Connection, job: &str) -> rusqlite::Result<Self> {
        conn.query_row("SELECT j.generation,o.origin_id,o.revision_base,o.feed_epoch,j.config_json FROM delivery_jobs j CROSS JOIN delivery_origin o WHERE j.id=?1 AND o.singleton=1", [job], |row| Ok(Self { generation:row.get(0)?,origin:row.get(1)?,base:row.get(2)?,epoch:row.get(3)?,config:row.get(4)? }))
    }
}
struct MarkerProof {
    stamp: MarkerStamp,
    batch: String,
    origin: String,
    revision: i64,
}

fn marker_record<'a>(
    batch: &'a Value,
    marker: &str,
    job: &str,
    stamp: &MarkerStamp,
) -> Option<&'a Value> {
    if batch["job_id"].as_str() != Some(job)
        || batch["generation"].as_i64() != Some(stamp.generation)
        || batch["origin_id"].as_str() != Some(stamp.origin.as_str())
    {
        return None;
    }
    let session = marker.strip_prefix("native-new-")?;
    batch["records"].as_array()?.iter().find(|record| {
        record["session_id"].as_str() == Some(session)
            && record["origin_id"].as_str() == Some(stamp.origin.as_str())
            && record.to_string().contains(marker)
    })
}
impl MarkerProof {
    fn feed_position(&self) -> Option<i64> {
        self.revision
            .checked_sub(self.stamp.base)
            .filter(|position| *position > 0)
    }
}

/// This all-source fixture has no suppressed/excluded records. Its durable
/// acknowledged frontier therefore covers the exact received marker revision,
/// even after the transient batch receipt has been compacted away.
fn exact_marker_acknowledged(
    conn: &rusqlite::Connection,
    job: &str,
    proof: &MarkerProof,
) -> rusqlite::Result<bool> {
    let Some(position) = proof.feed_position() else {
        return Ok(false);
    };
    if proof.origin != proof.stamp.origin {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_jobs j CROSS JOIN delivery_origin o WHERE j.id=?1 AND j.generation=?2 AND j.config_json=?3 AND j.state='active' AND j.bootstrap_done=1 AND j.acceptance_level='durable' AND j.acknowledged_cursor>=?4 AND j.acknowledged_records>0 AND j.suppressed_records=0 AND j.skipped_records=0 AND o.singleton=1 AND o.origin_id=?5 AND o.revision_base=?6 AND o.feed_epoch=?7 AND NOT EXISTS(SELECT 1 FROM delivery_quarantine WHERE job_id=j.id) AND NOT EXISTS(SELECT 1 FROM delivery_exclusions))",
        rusqlite::params![job,proof.stamp.generation,proof.stamp.config,position,proof.stamp.origin,proof.stamp.base,proof.stamp.epoch],
        |row|row.get(0),
    )
}

struct Collector(Child);
impl std::ops::Deref for Collector {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.0
    }
}
impl std::ops::DerefMut for Collector {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.0
    }
}
impl Drop for Collector {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

pub struct Backfill {
    pub directory: PathBuf,
    job: String,
    collector: Collector,
    barrier: Arc<Semaphore>,
    accepted: Arc<std::sync::atomic::AtomicUsize>,
    batches: Arc<std::sync::atomic::AtomicUsize>,
    receiver: tokio::task::JoinHandle<()>,
    bodies: Arc<Mutex<Vec<(Instant, String)>>>,
    receipts: Arc<Receipts>,
    new_paths: Mutex<std::collections::HashMap<String, (Instant, MarkerStamp)>>,
}
impl Backfill {
    pub async fn start(home: &Path, probe: &Path, receipts: Arc<Receipts>) -> Self {
        assert_isolated_roots(home, &receipts);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let barrier = Arc::new(Semaphore::new(0));
        let first = Arc::new(Notify::new());
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let batches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count_batches = batches.clone();
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let captured = bodies.clone();
        let gate = barrier.clone();
        let seen = accepted.clone();
        let started = first.clone();
        let receiver_receipts = receipts.clone();
        let receiver = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let gate = gate.clone();
                let seen = seen.clone();
                let started = started.clone();
                let receipts = receiver_receipts.clone();
                let captured = captured.clone();
                let count_batches = count_batches.clone();
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut reader = BufReader::new(read);
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                            break;
                        }
                        let mut length = 0;
                        loop {
                            let mut header = String::new();
                            if reader.read_line(&mut header).await.unwrap_or(0) == 0 {
                                return;
                            }
                            if header == "\r\n" {
                                break;
                            }
                            if let Some(value) =
                                header.to_ascii_lowercase().strip_prefix("content-length:")
                            {
                                length = value.trim().parse().unwrap();
                            }
                        }
                        let mut bytes = vec![0; length];
                        if reader.read_exact(&mut bytes).await.is_err() {
                            return;
                        }
                        let result = if line.starts_with("GET /v1/delivery/limits ") { json!({"maxRecords":500,"maxRequestBytes":2097152}) }
                        else {
                            let request: Value = serde_json::from_slice(&bytes).unwrap();
                            if let Some(records) = request["batch"]["records"].as_array() {
                                receipts.record("backfill_batch_held", json!({"record_count":records.len(),"accepted_records":seen.load(Ordering::SeqCst)}));
                                started.notify_one();
                                let permit = gate.acquire().await.unwrap(); permit.forget(); gate.add_permits(1);
                                seen.fetch_add(records.len(), Ordering::SeqCst);
                                count_batches.fetch_add(1, Ordering::SeqCst);
                                json!({"protocolVersion":1,"batchId":request["batch"]["batch_id"],"acceptedRevisionIds":records.iter().map(|row|row["revision_id"].clone()).collect::<Vec<_>>(),"unsupportedRevisionIds":[],"acceptanceLevel":"durable"})
                            } else { json!({}) }
                        }.to_string();
                        if write.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{result}",result.len()).as_bytes()).await.is_err() { return; }
                        captured
                            .lock()
                            .unwrap()
                            .push((Instant::now(), String::from_utf8(bytes).unwrap()));
                    }
                });
            }
        });
        let (directory, job) = initialize_install(home, &base);
        for n in 0..64 {
            let project = home.join(format!(".claude/projects/project-{}", n % 10));
            std::fs::create_dir_all(&project).unwrap();
            let id = format!("native-backfill-{n}");
            let text: String = (0..20).map(|i| format!("{}\n",json!({"sessionId":id,"uuid":format!("{id}-{i}"),"type":"user","cwd":"/tmp/project","message":{"role":"user","content":format!("synthetic {id}-{i}")},"timestamp":"2026-10-20T12:00:00.000Z"}))).collect();
            std::fs::write(project.join(format!("{id}.jsonl")), text).unwrap();
        }
        let roots = ai_hist::ProviderRoots::from_home(
            home.to_path_buf(),
            home.join(".local/share/opencode/opencode.db"),
        );
        let store = ai_hist::SessionStore::open(
            ai_hist::StoreOptions::default()
                .db_path(directory.join("history.db"))
                .roots(roots),
        )
        .unwrap();
        store
            .sync(ai_hist::SyncOptions::default().sources([ai_hist::Source::Claude]))
            .unwrap();
        drop(store);

        assert_isolated_roots(home, &receipts);
        let collector = Collector(
            Command::new(probe)
                .env_clear()
                .env("HOME", home)
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .env("CLAUDE_CONFIG_DIR", home.join(".claude"))
                .env("CODEX_HOME", home.join(".codex"))
                .env(
                    "OPENCODE_DB",
                    home.join(".local/share/opencode/opencode.db"),
                )
                .args(["run", "--directory"])
                .arg(&directory)
                .args(["--startup-id", "native-visibility"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(std::fs::File::create(directory.join("collector-fixture.log")).unwrap())
                .spawn()
                .unwrap(),
        );
        tokio::time::timeout(Duration::from_secs(90), first.notified())
            .await
            .expect("real collector must reach held HTTP batch");

        Self {
            directory,
            job,
            collector,
            barrier,
            accepted,
            batches,
            receiver,
            bodies,
            receipts,
            new_paths: Mutex::default(),
        }
    }
    pub fn note_new_path(&self, marker: &str) {
        let conn = self.reader();
        let stamp = MarkerStamp::read(&conn, &self.job)
            .unwrap_or_else(|error| self.database_failure(&conn, &error.to_string()));
        self.new_paths
            .lock()
            .unwrap()
            .insert(marker.into(), (Instant::now(), stamp));
    }
    fn reader(&self) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_with_flags(
            self.directory.join("history.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn
    }
    fn database_failure(&self, conn: &rusqlite::Connection, error: &str) -> ! {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.preserve_database_diagnostic(conn, error)
        }));
        panic!("isolated history database operation failed; diagnostic attempted: {error}")
    }
    pub async fn captured(&self, marker: &str) -> Value {
        let (start, stamp) = self
            .new_paths
            .lock()
            .unwrap()
            .get(marker)
            .expect("new history path was written")
            .clone();
        let observed = loop {
            let received = self.bodies.lock().unwrap().iter().find_map(|(at, body)| {
                let request: Value = serde_json::from_str(body).ok()?;
                let batch = &request["batch"];
                let record = marker_record(batch, marker, &self.job, &stamp)?;
                Some((*at, batch["batch_id"].as_str()?.to_string(), record.clone()))
            });
            if let Some(received) = received {
                break received;
            }
            assert!(
                start.elapsed() < Duration::from_secs(150),
                "receiver ACK exceeded unchanged150s bound"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        let (received_at, batch, record) = observed;
        assert_eq!(
            record["session_id"].as_str(),
            marker.strip_prefix("native-new-"),
            "Receiver marker must belong to this exact new thread"
        );
        let revision_id = record["revision_id"].as_str().unwrap();
        let proof = MarkerProof {
            stamp,
            batch,
            origin: record["origin_id"].as_str().unwrap().into(),
            revision: record["revision"].as_i64().unwrap(),
        };
        let receiver_ms = received_at.duration_since(start).as_millis();
        assert!(receiver_ms <= 150_000);
        self.receipts.record("history_receiver_acknowledged",json!({"marker":marker,"job_id":self.job,"batch_id":proof.batch,"revision_id":revision_id,"export_revision":proof.revision,"feed_position":proof.feed_position(),"origin_id":proof.origin,"generation":proof.stamp.generation,"marker_to_receiver_ms":receiver_ms}));
        loop {
            let conn = self.reader();
            if exact_marker_acknowledged(&conn, &self.job, &proof)
                .unwrap_or_else(|error| self.database_failure(&conn, &error.to_string()))
            {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(150),
                "collector did not persist exact marker frontier ACK within150s"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let result = json!({"marker":marker,"job_id":self.job,"batch_id":proof.batch,"revision_id":revision_id,"feed_position":proof.feed_position(),"marker_to_receiver_ms":receiver_ms,"marker_to_persisted_ms":start.elapsed().as_millis()});
        self.receipts
            .record("history_collector_ack_persisted", result.clone());
        result
    }
    pub fn busy(&self) -> Value {
        let conn = rusqlite::Connection::open_with_flags(
            self.directory.join("history.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let status = delivery::status(&conn, &self.job)
            .unwrap_or_else(|error| self.database_failure(&conn, &format!("{error:#}")));
        assert!(status.pending_records > 0 || status.unqueued_changes > 0);
        json!({"pending_records":status.pending_records,"unqueued_changes":status.unqueued_changes,"acknowledged_records":status.acknowledged_records,"receiver_accepted_records":self.accepted.load(Ordering::SeqCst)})
    }
    fn preserve_database_diagnostic(&self, conn: &rusqlite::Connection, error: &str) {
        let output = self.directory.join("native-db-diagnostic");
        std::fs::create_dir_all(&output).unwrap();
        // Failure artifacts contain only this known synthetic install. Copies
        // are raw live files, not a claimed consistent SQLite snapshot.
        let files: Vec<Value> = ["history.db", "history.db-wal", "history.db-shm"]
            .into_iter()
            .map(|name| {
                let source = self.directory.join(name);
                let copied = std::fs::metadata(&source)
                    .map_err(|e| e.to_string())
                    .and_then(|metadata| {
                        if metadata.len() > 64 * 1024 * 1024 {
                            return Err("diagnostic size bound exceeded".into());
                        }
                        std::fs::copy(&source, output.join(name)).map_err(|e| e.to_string())
                    });
                json!({"file":name,"identity":db_identity(&source),"raw_live_copy":copied})
            })
            .collect();
        let _ = conn.busy_timeout(Duration::from_millis(100));
        let queries: Vec<Value> = [
            "PRAGMA quick_check",
            "SELECT count(*) FROM sqlite_master",
            "SELECT count(*) FROM delivery_batches",
        ]
        .into_iter()
        .map(|sql| {
            let rows = conn
                .prepare(sql)
                .and_then(|mut statement| {
                    let rows =
                        statement.query_map([], |row| Ok(format!("{:?}", row.get_ref(0))))?;
                    rows.take(8).collect::<rusqlite::Result<Vec<_>>>()
                })
                .map_err(|e| e.to_string());
            json!({"sql":sql,"rows":rows})
        })
        .collect();
        let diagnostic = json!({"error":error,"database":db_identity(&self.directory.join("history.db")),"files":files,"queries":queries,"sqlite_version":rusqlite::version(),"synthetic_only":true});
        std::fs::write(
            output.join("database-diagnostic.log"),
            serde_json::to_vec_pretty(&diagnostic).unwrap(),
        )
        .unwrap();
        self.receipts
            .record("fixture_database_diagnostic", diagnostic);
    }
    pub fn release(&self) {
        self.barrier.add_permits(1);
    }
    pub async fn quiet(&mut self) -> Value {
        self.release();
        let started = Instant::now();
        loop {
            let conn = rusqlite::Connection::open_with_flags(
                self.directory.join("history.db"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            conn.busy_timeout(Duration::from_secs(5)).unwrap();
            let status = delivery::status(&conn, &self.job)
                .unwrap_or_else(|error| self.database_failure(&conn, &format!("{error:#}")));
            let cycle: Value = std::fs::read(self.directory.join("cycle.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .unwrap_or_default();
            if status.bootstrap_complete
                && status.pending_records == 0
                && status.unqueued_changes == 0
                && cycle["capture_metrics"]["sweeps"].as_u64().unwrap_or(0) >= 1
            {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(150));
            assert!(self.collector.try_wait().unwrap().is_none());
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let before = self.accepted.load(Ordering::SeqCst);
        let batches_before = self.batches.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(65)).await;
        assert_eq!(
            before,
            self.accepted.load(Ordering::SeqCst),
            "quiet collector must not send new history"
        );
        assert_eq!(
            batches_before,
            self.batches.load(Ordering::SeqCst),
            "quiet collector must send no batches, including empty batches"
        );
        json!({"quiet_seconds":65,"accepted_records":before,"batch_count":batches_before,"batches_during_quiet":0})
    }
}

#[cfg(test)]
mod marker_ack_tests {
    use super::*;

    fn database() -> (tempfile::TempDir, rusqlite::Connection, String, MarkerProof) {
        let directory = tempfile::tempdir().unwrap();
        let (install, job) = initialize_install(directory.path(), "http://127.0.0.1:1");
        let conn = delivery::open_db(&install.join("history.db")).unwrap();
        conn.execute("INSERT OR REPLACE INTO delivery_origin(singleton,origin_id,revision_base,feed_epoch,max_revision) VALUES (1,'fixture-origin',100,7,150)", []).unwrap();
        conn.execute("UPDATE delivery_jobs SET bootstrap_done=1,acknowledged_cursor=49,acknowledged_records=2,acceptance_level='durable'", []).unwrap();
        let proof = MarkerProof {
            stamp: MarkerStamp::read(&conn, &job).unwrap(),
            batch: "marker-batch".into(),
            origin: "fixture-origin".into(),
            revision: 150,
        };
        (directory, conn, job, proof)
    }

    #[test]
    fn receiver_marker_requires_matching_batch_and_record_identity() {
        let (_directory, _conn, job, proof) = database();
        let marker = "native-new-fresh-thread";
        let body = json!({"job_id":job,"generation":proof.stamp.generation,"origin_id":proof.stamp.origin,"records":[{"session_id":"fresh-thread","origin_id":proof.stamp.origin,"payload":marker}]});
        assert!(marker_record(&body, marker, &job, &proof.stamp).is_some());
        for (field, wrong) in [
            ("job_id", json!("wrong-job")),
            ("generation", json!(proof.stamp.generation + 1)),
            ("origin_id", json!("wrong-origin")),
        ] {
            let mut wrong_body = body.clone();
            wrong_body[field] = wrong;
            assert!(
                marker_record(&wrong_body, marker, &job, &proof.stamp).is_none(),
                "Reject mismatched batch {field}"
            );
        }
        for (field, wrong) in [
            ("session_id", "wrong-thread"),
            ("origin_id", "wrong-origin"),
        ] {
            let mut wrong_body = body.clone();
            wrong_body["records"][0][field] = json!(wrong);
            assert!(
                marker_record(&wrong_body, marker, &job, &proof.stamp).is_none(),
                "Reject mismatched record {field}"
            );
        }
    }

    #[test]
    fn receiver_observation_without_durable_frontier_is_not_settlement() {
        let (_directory, conn, job, proof) = database();
        assert!(!exact_marker_acknowledged(&conn, &job, &proof).unwrap());
        conn.execute(
            "UPDATE delivery_jobs SET acknowledged_cursor=50,acceptance_level=NULL",
            [],
        )
        .unwrap();
        assert!(!exact_marker_acknowledged(&conn, &job, &proof).unwrap());
        conn.execute("UPDATE delivery_jobs SET acceptance_level='durable'", [])
            .unwrap();
        assert!(exact_marker_acknowledged(&conn, &job, &proof).unwrap());
    }

    #[test]
    fn wrong_identity_generation_epoch_or_suppression_cannot_settle_marker() {
        let (_directory, conn, job, mut proof) = database();
        conn.execute("UPDATE delivery_jobs SET acknowledged_cursor=50", [])
            .unwrap();
        assert!(!exact_marker_acknowledged(&conn, "wrong-job", &proof).unwrap());
        proof.origin = "wrong-origin".into();
        assert!(!exact_marker_acknowledged(&conn, &job, &proof).unwrap());
        proof.origin = "fixture-origin".into();
        proof.stamp.generation += 1;
        assert!(!exact_marker_acknowledged(&conn, &job, &proof).unwrap());
        proof.stamp.generation -= 1;
        proof.stamp.epoch += 1;
        assert!(!exact_marker_acknowledged(&conn, &job, &proof).unwrap());
        proof.stamp.epoch -= 1;
        for column in ["suppressed_records", "skipped_records"] {
            conn.execute(&format!("UPDATE delivery_jobs SET {column}=1"), [])
                .unwrap();
            assert!(!exact_marker_acknowledged(&conn, &job, &proof).unwrap());
            conn.execute(&format!("UPDATE delivery_jobs SET {column}=0"), [])
                .unwrap();
        }
        assert!(exact_marker_acknowledged(&conn, &job, &proof).unwrap());
    }

    #[test]
    fn exact_marker_frontier_survives_real_receipt_compaction() {
        let (_directory, conn, job, proof) = database();
        conn.execute("UPDATE delivery_jobs SET acknowledged_cursor=50", [])
            .unwrap();
        conn.execute("INSERT INTO delivery_batches(id,job_id,state,records,accepted_records,bytes,journal_end,created_ms) VALUES ('marker-batch',?1,'acknowledged',2,2,1,50,0)", [&job]).unwrap();
        assert!(exact_marker_acknowledged(&conn, &job, &proof).unwrap());
        assert_eq!(delivery::compact_receipts(&conn, 100).unwrap(), 1);
        let remaining: i64 = conn
            .query_row(
                "SELECT count(*) FROM delivery_batches WHERE id='marker-batch'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            remaining, 0,
            "The production compactor removed the transient receipt"
        );
        assert!(
            exact_marker_acknowledged(&conn, &job, &proof).unwrap(),
            "Durable exact-marker acceptance must survive removal"
        );
    }
}

impl Drop for Backfill {
    fn drop(&mut self) {
        self.release();
        let _ = std::fs::write(
            self.directory.join("stop.json"),
            json!({"startup_id":"native-visibility"}).to_string(),
        );
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            if self.collector.try_wait().unwrap().is_some() {
                self.receiver.abort();
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.collector.kill();
        let _ = self.collector.wait();
        self.receiver.abort();
    }
}
