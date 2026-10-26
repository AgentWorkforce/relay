//! A line written to a local transcript reaches the receiver within seconds:
//! the real collector, a synthetic home and a loopback receiver.
//!
//! `LIVE_CAPTURE_APPENDS=10 cargo test --test live_capture -- --nocapture`
//! appends that many lines one after another and prints the latency of each
//! from the write to the receiver's acknowledgment, with p50 and p95;
//! `LIVE_CAPTURE_BINARY` measures another build of the probe instead.
use agent_relay_probe::delivery::{self, DeliveryJobConfig, ExportSelection};
use agent_relay_probe::destination;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Every request body the receiver acknowledged, with when it answered.
type Received = Arc<Mutex<Vec<(Instant, String)>>>;

/// A loopback RelayHistory receiver that keeps connections alive and accepts
/// every record of every batch.
fn receiver() -> (String, Received) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let received: Received = Arc::default();
    let seen = received.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let seen = seen.clone();
            std::thread::spawn(move || {
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
                        if reader.read_line(&mut header).unwrap_or(0) == 0 {
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
                    let mut body = vec![0; length];
                    if reader.read_exact(&mut body).is_err() {
                        return;
                    }
                    let body = String::from_utf8(body).unwrap();
                    if line.starts_with("GET /v1/delivery/limits ") {
                        let limits = r#"{"maxRecords":500,"maxRequestBytes":2097152}"#;
                        if write!(
                            writer,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{limits}",
                            limits.len()
                        )
                        .is_err()
                        {
                            return;
                        }
                        continue;
                    }
                    let request: Value = serde_json::from_str(&body).unwrap();
                    let batch = &request["batch"];
                    let Some(records) = batch["records"].as_array() else {
                        // A progress heartbeat, not a batch.
                        if write!(
                            writer,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}"
                        )
                        .is_err()
                        {
                            return;
                        }
                        continue;
                    };
                    let receipt = json!({
                        "protocolVersion": 1,
                        "batchId": batch["batch_id"],
                        "acceptedRevisionIds": records.iter()
                            .map(|record| record["revision_id"].clone()).collect::<Vec<_>>(),
                        "unsupportedRevisionIds": [],
                        "acceptanceLevel": "durable",
                    })
                    .to_string();
                    if write!(
                        writer,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{receipt}",
                        receipt.len()
                    )
                    .is_err()
                    {
                        return;
                    }
                    seen.lock().unwrap().push((Instant::now(), body));
                }
            });
        }
    });
    (base, received)
}

fn command(home: &Path) -> Command {
    let binary = std::env::var_os("LIVE_CAPTURE_BINARY")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_agent-relay-probe").into());
    let mut cmd = Command::new(binary);
    cmd.env("HOME", home)
        .env("CLAUDE_CONFIG_DIR", home.join(".claude"))
        .env("CODEX_HOME", home.join(".codex"))
        .env("GROK_HOME", home.join(".grok"))
        // Where OpenCode keeps it, so its watch root is not the home itself.
        .env(
            "OPENCODE_DB",
            home.join(".local/share/opencode/opencode.db"),
        )
        .env_remove("CLOUD_API_ACCESS_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

fn line(session: &str, marker: &str) -> String {
    format!(
        "{}\n",
        json!({"sessionId":session,"uuid":marker,"type":"user","cwd":"/tmp/project",
            "message":{"role":"user","content":format!("synthetic {marker}")},
            "timestamp":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)})
    )
}

/// When the receiver first acknowledged a batch carrying `marker`.
fn acknowledged(received: &Received, marker: &str) -> Option<Instant> {
    received
        .lock()
        .unwrap()
        .iter()
        .find(|(_, body)| body.contains(marker))
        .map(|(at, _)| *at)
}

fn wait_for(
    received: &Received,
    marker: &str,
    timeout: Duration,
    diagnose: &dyn Fn() -> String,
) -> Instant {
    let start = Instant::now();
    loop {
        if let Some(at) = acknowledged(received, marker) {
            return at;
        }
        assert!(
            start.elapsed() < timeout,
            "{marker} was not acknowledged within {timeout:?}\n{}",
            diagnose()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// CPU time `pid` has used, in seconds, as `ps` reports it. Only the opt-in
/// measuring runs ask, and they need a Unix `ps`.
fn cpu_seconds(pid: u32) -> f64 {
    let out = Command::new("ps")
        .args(["-o", "time=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    // [[hh:]mm:]ss.cc
    text.trim().split(':').fold(0.0, |total, part| {
        total * 60.0 + part.parse::<f64>().unwrap()
    })
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

/// A configured install over a synthetic home and a loopback receiver.
struct Install {
    home: tempfile::TempDir,
    directory: std::path::PathBuf,
    received: Received,
}
impl Install {
    fn new() -> Install {
        let (base, received) = receiver();
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join("probe");
        fs::create_dir_all(directory.join("stages")).unwrap();
        // The stage session the probe sends with, as setup stores it.
        let stage = {
            use sha2::{Digest, Sha256};
            format!("{:x}", Sha256::digest(base.as_bytes()))[..16].to_owned()
        };
        fs::write(
            directory.join(format!("stages/{stage}.auth.json")),
            json!({"base_url":base,"access_token":"rth_at_fixture",
                "access_token_expires_at":"2099-01-01T00:00:00Z",
                "org_id":"org","workspace_id":"workspace"})
            .to_string(),
        )
        .unwrap();
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
        fs::write(
            directory.join("config.json"),
            serde_json::to_vec(&json!({
                // A loopback history origin is trusted only beside a loopback site.
                "version":1,"site_url":"http://127.0.0.1:3100","account_id":"account","org_id":"org",
                "workspace_id":"workspace","history_url":base,
                "delivery_account":job.config.account_id,"job_id":job.job_id,"include_existing":true,
                "sharing_mode":null,"acknowledge_uninspected_schedules":true
            }))
            .unwrap(),
        )
        .unwrap();
        Install {
            home,
            directory,
            received,
        }
    }
    fn log(&self) -> std::path::PathBuf {
        self.directory.join("test-stderr.log")
    }
    fn start(&self) -> Running {
        Running(
            command(self.home.path())
                .args(["run", "--directory"])
                .arg(&self.directory)
                .args(["--startup-id", "live-test"])
                .stderr(fs::File::create(self.log()).unwrap())
                .spawn()
                .unwrap(),
        )
    }
    fn diagnose(&self) -> String {
        format!(
            "collector log:\n{}\ncycle: {}",
            fs::read_to_string(self.log()).unwrap_or_default(),
            fs::read_to_string(self.directory.join("cycle.json")).unwrap_or_default()
        )
    }
    /// Stop the run as the desktop does, and require that it ends promptly.
    fn stop(&self, collector: &mut Running) {
        let stopping = Instant::now();
        fs::write(
            self.directory.join("stop.json"),
            serde_json::to_vec(&json!({"startup_id":"live-test"})).unwrap(),
        )
        .unwrap();
        loop {
            if let Some(status) = collector.0.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(
                stopping.elapsed() < Duration::from_secs(5),
                "collector did not stop"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn a_transcript_line_is_acknowledged_within_seconds() {
    let appends: usize = std::env::var("LIVE_CAPTURE_APPENDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1);
    let measuring = std::env::var_os("LIVE_CAPTURE_APPENDS").is_some();
    let install = Install::new();
    let (directory, received) = (&install.directory, &install.received);
    let project = install.home.path().join(".claude/projects/live");
    fs::create_dir_all(&project).unwrap();
    let transcript = project.join("live-session.jsonl");
    fs::write(&transcript, line("live-session", "marker-start")).unwrap();
    let mut collector = install.start();
    let diagnose = || install.diagnose();
    // The first sweep and the first drain deliver what was already there.
    wait_for(received, "marker-start", Duration::from_secs(30), &diagnose);

    // Delivery can acknowledge the startup sweep before the watcher has
    // attached and its catch-up sweep finishes. An append during catch-up is
    // validly captured there, but cannot prove the event-driven tick below.
    // Wait for that distinct precondition instead of inferring it from a
    // receiver acknowledgement or an arbitrary sleep.
    let starting = Instant::now();
    loop {
        let report: Value = fs::read(directory.join("cycle.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let capture = &report["capture_metrics"];
        if capture["sweeps"].as_u64().unwrap_or(0) >= 2
            && capture["driver"] == "fs-events"
            && capture["watching_since_ms"].is_u64()
        {
            break;
        }
        assert!(
            starting.elapsed() < Duration::from_secs(30),
            "capture watcher did not finish startup: {}",
            diagnose()
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    let pid = collector.0.id();
    let cpu_start = measuring.then(|| cpu_seconds(pid));
    let mut latencies = Vec::new();
    let mut drains = Vec::new();
    for n in 0..appends {
        // Leave the collector idle between appends, as a person typing would.
        std::thread::sleep(Duration::from_millis(500));
        let marker = format!("marker-{n}-{}", std::process::id());
        let written = Instant::now();
        fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap()
            .write_all(line("live-session", &marker).as_bytes())
            .unwrap();
        // The former timer captured within 60 s and delivered up to 20 s
        // later; measurements against it need that long.
        let timeout = Duration::from_secs(if measuring { 150 } else { 15 });
        let at = wait_for(received, &marker, timeout, &diagnose);
        let latency = at.saturating_duration_since(written);
        if measuring {
            // The pass that delivered it reports just after its drain.
            std::thread::sleep(Duration::from_millis(100));
            let report: Value = fs::read(directory.join("cycle.json"))
                .ok()
                .and_then(|data| serde_json::from_slice(&data).ok())
                .unwrap_or_default();
            if let Some(drain) = report["delivery_metrics"]["drain_ms"].as_u64() {
                drains.push(Duration::from_millis(drain));
            }
            eprintln!(
                "append {n}: acknowledged after {} ms (capture_lag_ms={} drain_ms={} send_ms_max={})",
                latency.as_millis(),
                report["capture_metrics"]["capture_lag_ms"],
                report["delivery_metrics"]["drain_ms"],
                report["delivery_metrics"]["send_ms_max"],
            );
        } else {
            eprintln!("append {n}: acknowledged after {} ms", latency.as_millis());
        }
        latencies.push(latency);
        assert!(
            collector.0.try_wait().unwrap().is_none(),
            "collector exited"
        );
    }
    latencies.sort();
    eprintln!(
        "appends={} p50_ms={} p95_ms={} max_ms={}",
        latencies.len(),
        percentile(&latencies, 50.0).as_millis(),
        percentile(&latencies, 95.0).as_millis(),
        latencies.last().unwrap().as_millis(),
    );
    if let Some(cpu_start) = cpu_start {
        // Collector CPU over the appends, idle gaps included, and the
        // drains that delivered them.
        let cpu_ms = (cpu_seconds(pid) - cpu_start) * 1000.0;
        drains.sort();
        eprintln!(
            "cpu_ms_per_append={:.1} drain_p50_ms={} drain_p95_ms={}",
            cpu_ms / appends as f64,
            drains.get(drains.len() / 2).map_or(0, Duration::as_millis),
            (!drains.is_empty())
                .then(|| percentile(&drains, 95.0).as_millis())
                .unwrap_or(0),
        );
    }

    if !measuring {
        // The run reports how it captured: by filesystem events, with a tick
        // that changed the session and woke delivery, and the measured lag
        // from the write to that tick, as numbers only. The pass that
        // delivered the line reports after its drain.
        let reported = Instant::now();
        let report = loop {
            let report: Value = fs::read(directory.join("cycle.json"))
                .ok()
                .and_then(|data| serde_json::from_slice(&data).ok())
                .unwrap_or_default();
            if report["capture_metrics"]["capture_lag_ms"].is_u64() {
                break report;
            }
            assert!(
                reported.elapsed() < Duration::from_secs(10),
                "no capture lag reported: {report}"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        let capture = &report["capture_metrics"];
        assert_eq!(capture["mode"], "watch", "{report}");
        assert_eq!(capture["driver"], "fs-events", "{report}");
        assert!(capture["fallback_reason"].is_null(), "{report}");
        assert!(capture["ticks_by_trigger"]["fs-event"].as_u64().unwrap() >= 1);
        assert!(capture["sessions_changed"].as_u64().unwrap() >= 1);
        assert!(capture["ticks_waking_delivery"].as_u64().unwrap() >= 1);
        assert!(!report.to_string().contains("marker"));
        assert!(!report.to_string().contains("live-session"));
    }

    // The stop request ends the watch thread and the run promptly.
    install.stop(&mut collector);
}

/// The cost of an idle collector over a history of a few hundred sessions:
/// CPU time across a quiet window after the first capture, for comparing
/// builds with `LIVE_CAPTURE_BINARY`. Run with `--ignored --nocapture`;
/// `LIVE_CAPTURE_IDLE_SECS` sets the window (default 240). With
/// `LIVE_CAPTURE_WRITE_EVERY_MS` set, one session's transcript gains a line
/// that often through the window, as a live agent's does, and the cost is
/// that of following it.
#[test]
#[ignore]
fn idle_cost() {
    let idle: u64 = std::env::var("LIVE_CAPTURE_IDLE_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(240);
    let install = Install::new();
    for project in 0..10 {
        let directory = install
            .home
            .path()
            .join(format!(".claude/projects/project-{project}"));
        fs::create_dir_all(&directory).unwrap();
        for session in 0..20 {
            let id = format!("idle-{project}-{session}");
            let text: String = (0..50).map(|n| line(&id, &format!("{id}-{n}"))).collect();
            fs::write(directory.join(format!("{id}.jsonl")), text).unwrap();
        }
    }
    let mut collector = install.start();
    let diagnose = || install.diagnose();
    wait_for(
        &install.received,
        "idle-9-19-49",
        Duration::from_secs(300),
        &diagnose,
    );
    // Let the first capture and backlog settle before the window opens.
    std::thread::sleep(Duration::from_secs(30));
    let pid = collector.0.id();
    let cpu = || cpu_seconds(pid);
    let requests = || install.received.lock().unwrap().len();
    let write_every = std::env::var("LIVE_CAPTURE_WRITE_EVERY_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .map(Duration::from_millis);
    let (cpu_start, requests_start) = (cpu(), requests());
    let window = Instant::now() + Duration::from_secs(idle);
    let mut written = 0;
    while let Some(every) = write_every.filter(|_| Instant::now() < window) {
        let transcript = install
            .home
            .path()
            .join(".claude/projects/project-0/idle-0-0.jsonl");
        fs::OpenOptions::new()
            .append(true)
            .open(transcript)
            .unwrap()
            .write_all(line("idle-0-0", &format!("live-{written}")).as_bytes())
            .unwrap();
        written += 1;
        std::thread::sleep(every);
    }
    std::thread::sleep(window.saturating_duration_since(Instant::now()));
    let (cpu_end, requests_end) = (cpu(), requests());
    if write_every.is_some() {
        eprintln!("lines_written={written}");
    }
    eprintln!(
        "idle_secs={idle} cpu_ms={:.0} cpu_ms_per_minute={:.1} batches_during_idle={}",
        (cpu_end - cpu_start) * 1000.0,
        (cpu_end - cpu_start) * 1000.0 * 60.0 / idle as f64,
        requests_end - requests_start
    );
    let report: Value = fs::read(install.directory.join("cycle.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    eprintln!("capture_metrics={}", report["capture_metrics"]);
    install.stop(&mut collector);
}
