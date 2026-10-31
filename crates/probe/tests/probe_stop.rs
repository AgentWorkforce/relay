//! Exercise the real stop command while the collector is writing a large source.
use agent_relay_probe::delivery::{self, DeliveryJobConfig, ExportSelection};
use agent_relay_probe::destination;
use fs2::FileExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn wait(child: &mut Running, timeout: Duration) -> ExitStatus {
    let start = Instant::now();
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            return status;
        }
        assert!(
            start.elapsed() < timeout,
            "probe did not stop within {timeout:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn command(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_agent-relay-probe"));
    cmd.env("HOME", home)
        .env("CLAUDE_CONFIG_DIR", home.join(".claude"))
        .env("CODEX_HOME", home.join(".codex"))
        .env("GROK_HOME", home.join(".grok"))
        .env("OPENCODE_DB", home.join("opencode.db"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

#[test]
fn stop_command_interrupts_active_capture_and_preserves_committed_history() {
    let home = tempfile::tempdir().unwrap();
    let site = "https://agentrelay.com";
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(site, "account", "workspace")).unwrap())
    );
    let directory = home.path().join(".agentworkforce/probe").join(key);
    fs::create_dir_all(&directory).unwrap();
    let db = directory.join("history.db");
    let conn = delivery::open_db(&db).unwrap();
    let job = delivery::create_job(
        &conn,
        &DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "teams-probe".into(),
            account_id: destination::account_id("org", Some("workspace")),
            mapping_version: destination::MAPPING_VERSION.into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["history".into(), "session_event".into(), "session".into()],
                ..Default::default()
            },
            limits: Default::default(),
        },
        0,
    )
    .unwrap();
    // Pausing uploads leaves capture active, with no network or credentials.
    delivery::pause_job(&conn, &job.job_id).unwrap();
    fs::write(
        directory.join("config.json"),
        serde_json::to_vec(&json!({
            "version":1,"site_url":site,"account_id":"account","org_id":"org",
            "workspace_id":"workspace","history_url":"https://history.agentrelay.com",
            "delivery_account":job.config.account_id,"job_id":job.job_id,"include_existing":true,
            "sharing_mode":null,"acknowledge_uninspected_schedules":false
        }))
        .unwrap(),
    )
    .unwrap();
    fs::create_dir_all(home.path().join(".claude")).unwrap();
    let mut source = std::io::BufWriter::new(
        fs::File::create(home.path().join(".claude/history.jsonl")).unwrap(),
    );
    const RECORDS: usize = 200_000;
    for i in 0..RECORDS {
        writeln!(source, "{}", json!({"display":format!("prompt {i}"),"timestamp":1700000000000_i64+i as i64,"project":"/tmp/project","sessionId":"session"})).unwrap();
    }
    source.flush().unwrap();
    let mut collector = Running(
        command(home.path())
            .args(["run", "--directory"])
            .arg(&directory)
            .args(["--startup-id", "stop-test"])
            .spawn()
            .unwrap(),
    );
    let count = || {
        conn.query_row("SELECT COUNT(*) FROM history", [], |row| {
            row.get::<_, usize>(0)
        })
        .unwrap()
    };
    let start = Instant::now();
    while count() == 0 {
        assert!(
            collector.0.try_wait().unwrap().is_none(),
            "collector exited before capturing"
        );
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "capture never started"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(count() < RECORDS, "fixture must still be capturing");
    let stopping = Instant::now();
    let mut stop = Running(
        command(home.path())
            .args([
                "stop",
                "--site-url",
                site,
                "--account",
                "account",
                "--workspace",
                "workspace",
            ])
            .spawn()
            .unwrap(),
    );
    assert!(wait(&mut stop, Duration::from_secs(3)).success());
    assert!(wait(&mut collector, Duration::from_secs(1)).success());
    eprintln!("busy collector stopped in {:?}", stopping.elapsed());
    assert!(
        (1..RECORDS).contains(&count()),
        "capture should stop partway through the source"
    );
    let runtime: Value =
        serde_json::from_slice(&fs::read(directory.join("runtime.json")).unwrap()).unwrap();
    assert_eq!(runtime["ready"], false);
    // The run's first, delivery-only pass reported; the capture pass the stop
    // cancelled did not, since cancellation is not an offline cycle.
    let cycle: Value =
        serde_json::from_slice(&fs::read(directory.join("cycle.json")).unwrap()).unwrap();
    assert_eq!(cycle["startup_id"], "stop-test");
    assert_eq!(cycle["ok"], true, "cancellation is not an offline cycle");
    assert!(cycle["capture"]["error_class"].is_null());
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("collector.lock"))
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    let checkpoint: Value =
        serde_json::from_slice(&fs::read(directory.join(".sync-state.json")).unwrap()).unwrap();
    assert!(checkpoint["claude"]["offset"].as_u64().unwrap() > 0);
}

/// A failed status write must leave the real background loop alive to recover on its next retry.
#[test]
fn cycle_status_write_failure_retries_and_recovers_without_restart() {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("probe");
    fs::create_dir(&directory).unwrap();
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
                kinds: vec!["session".into()],
                ..Default::default()
            },
            limits: Default::default(),
        },
        0,
    )
    .unwrap();
    delivery::pause_job(&conn, &job.job_id).unwrap();
    fs::write(
        directory.join("config.json"),
        serde_json::to_vec(&json!({
            "version":1,"site_url":"https://agentrelay.com","account_id":"account","org_id":"org",
            "workspace_id":"workspace","history_url":"https://history.agentrelay.com",
            "delivery_account":job.config.account_id,"job_id":job.job_id,"include_existing":true,
            "sharing_mode":null,"acknowledge_uninspected_schedules":false
        }))
        .unwrap(),
    )
    .unwrap();
    // Replacing a directory with the atomic status file fails deterministically
    // on every platform without filling the host disk or depending on chmod.
    let cycle = directory.join("cycle.json");
    fs::create_dir(&cycle).unwrap();
    let log = directory.join("test-stderr.log");
    let mut collector = Running(
        command(home.path())
            .args(["run", "--directory"])
            .arg(&directory)
            .args(["--startup-id", "status-retry-test"])
            .stderr(fs::File::create(&log).unwrap())
            .spawn()
            .unwrap(),
    );
    let start = Instant::now();
    loop {
        assert!(
            collector.0.try_wait().unwrap().is_none(),
            "status write failure stopped collector"
        );
        if fs::read_to_string(&log)
            .unwrap()
            .contains("Sync status could not be saved")
        {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "first cycle never completed"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    fs::remove_dir(&cycle).unwrap();
    let retry = Instant::now();
    while !cycle.is_file() {
        assert!(
            collector.0.try_wait().unwrap().is_none(),
            "collector exited instead of retrying"
        );
        assert!(
            retry.elapsed() < Duration::from_secs(30),
            "status was not retried"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let report: Value = serde_json::from_slice(&fs::read(&cycle).unwrap()).unwrap();
    assert_eq!(report["ok"], true);
    assert_eq!(
        delivery::status(&conn, &job.job_id).unwrap().state,
        "paused"
    );
    fs::write(
        directory.join("stop.json"),
        serde_json::to_vec(&json!({"startup_id":"status-retry-test"})).unwrap(),
    )
    .unwrap();
    assert!(wait(&mut collector, Duration::from_secs(3)).success());
}

/// Opening the store migrates it after readiness is announced, so a failed
/// open must not end the run: it reports the classified cause as this run's
/// and retries, and a stop still ends it cleanly.
#[test]
fn a_store_that_cannot_open_is_reported_and_retried_while_running() {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("probe");
    fs::create_dir(&directory).unwrap();
    fs::write(
        directory.join("config.json"),
        serde_json::to_vec(&json!({
            "version":1,"site_url":"https://agentrelay.com","account_id":"account","org_id":"org",
            "workspace_id":"workspace","history_url":"https://history.agentrelay.com",
            "delivery_account":destination::account_id("org", Some("workspace")),
            "job_id":"job","include_existing":true,
            "sharing_mode":null,"acknowledge_uninspected_schedules":false
        }))
        .unwrap(),
    )
    .unwrap();
    // A directory where the store belongs cannot be opened, on every platform.
    fs::create_dir(directory.join("history.db")).unwrap();
    let mut collector = Running(
        command(home.path())
            .args(["run", "--directory"])
            .arg(&directory)
            .args(["--startup-id", "open-failure-test"])
            .spawn()
            .unwrap(),
    );
    let cycle = directory.join("cycle.json");
    let start = Instant::now();
    while !cycle.is_file() {
        assert!(
            collector.0.try_wait().unwrap().is_none(),
            "a store that cannot open ended the run"
        );
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "the failure was never reported"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let report: Value = serde_json::from_slice(&fs::read(&cycle).unwrap()).unwrap();
    assert_eq!(report["startup_id"], "open-failure-test");
    assert_eq!(report["ok"], false);
    assert_eq!(report["error_class"], "database_unavailable");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        collector.0.try_wait().unwrap().is_none(),
        "the run must keep retrying"
    );

    // Once the store opens, the run withdraws the failure it reported.
    fs::remove_dir(directory.join("history.db")).unwrap();
    let recovering = Instant::now();
    loop {
        let report: Value = serde_json::from_slice(&fs::read(&cycle).unwrap()).unwrap();
        if report["error_class"] != "database_unavailable" {
            break;
        }
        assert!(
            collector.0.try_wait().unwrap().is_none(),
            "the run ended while retrying"
        );
        assert!(
            recovering.elapsed() < Duration::from_secs(30),
            "the recovered store still reports the open failure"
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    fs::write(
        directory.join("stop.json"),
        serde_json::to_vec(&json!({"startup_id":"open-failure-test"})).unwrap(),
    )
    .unwrap();
    assert!(wait(&mut collector, Duration::from_secs(3)).success());
    let runtime: Value =
        serde_json::from_slice(&fs::read(directory.join("runtime.json")).unwrap()).unwrap();
    assert_eq!(runtime["ready"], false);
}
