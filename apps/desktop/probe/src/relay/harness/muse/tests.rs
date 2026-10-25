use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};
use crate::relay::workspace::Secret;

const MARKER: &str = "11111111-2222-3333-4444-555555555555";
const SESSION: &str = "11111111-2222-3333-4444-666666666666";
const PID: i32 = 872341;

fn adapter(root: &Path, table: Arc<FakeProcesses>) -> MuseAdapter {
    let cx = HarnessContext::system(&BTreeMap::new(), root, &root.join("app"), table);
    MuseAdapter {
        config: MuseConfig {
            data_dir: root.join("muse"),
        },
        cx,
        executable: None,
        ready_timeout: Duration::ZERO,
    }
}

fn process(uid: u32, marker: Option<&str>) -> FakeProcess {
    let mut env = std::collections::HashMap::new();
    if let Some(marker) = marker {
        env.insert(SPAWN_MARKER.into(), marker.into());
    }
    FakeProcess {
        uid,
        start: 71,
        executable: Some(PathBuf::from("/opt/muse-bin-1.4.9")),
        environment: env,
        ..FakeProcess::default()
    }
}

fn registry(adapter: &MuseAdapter, capable: bool) {
    std::fs::create_dir_all(adapter.config.registry_dir()).unwrap();
    std::fs::write(
        adapter
            .config
            .registry_dir()
            .join(format!("{SESSION}.json")),
        serde_json::json!({
            "session_id": SESSION, "process_generation_hint": format!("pid={PID}"),
            "target_eligibility": if capable { "message_capable" } else { "unavailable" },
        })
        .to_string(),
    )
    .unwrap();
}

fn intent() -> Intent {
    Intent {
        invocation_id: "inv_muse".into(),
        name: "muse-test".into(),
        harness: ID,
        node_id: "node-test".into(),
        node_name: "test-desktop".into(),
        title: "test".into(),
        base_url: "https://cast.example".into(),
        workspace_key: Secret::new("test-only"),
        workspace_id: None,
        machine_prefix: "test".into(),
        message_id: "message-test".into(),
        session_id: MARKER.into(),
        created_ms: 0,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: None,
        token: None,
        requester: None,
        target: None,
        process: None,
    }
}

#[test]
fn muse_access_is_confined_until_explicitly_enabled_and_uses_startup_prompt() {
    let args = arguments("a \"quoted\" task\nnext line", false);
    assert_eq!(
        args,
        [
            "--trust-workspace",
            "--approval-mode",
            "never",
            "--",
            "a \"quoted\" task\nnext line"
        ]
    );
    assert!(arguments("task", true).contains(&"--yolo".into()));
    assert!(!DESCRIPTOR.full_access.unwrap().default);
}

#[test]
fn installed_muse_is_advertised_for_relay_owned_spawns() {
    let root = tempfile::tempdir().unwrap();
    let mut adapter = adapter(root.path(), Arc::new(FakeProcesses::default()));
    assert_eq!(adapter.detect(), Installed::No);
    adapter.executable = Some(PathBuf::from("/opt/muse"));
    assert_eq!(adapter.detect(), Installed::Yes);
    assert!(adapter.owns(&Target::new(SessionKind::MuseOpen, SESSION)));
    assert!(!adapter.owns(&Target::new(SessionKind::Codex, SESSION)));
}

#[test]
fn courier_mirrors_access_only_for_the_exact_live_native_spawn() {
    let root = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let adapter = adapter(root.path(), table.clone());
    registry(&adapter, true);
    let mut native = process(adapter.cx.uid, Some(MARKER));
    native
        .environment
        .insert(SPAWN_ACCESS.into(), "workspace".into());
    table.insert(PID, native.clone());
    assert_eq!(
        courier_access(&adapter.config, table.as_ref(), adapter.cx.uid, SESSION),
        Some(false)
    );
    assert_eq!(
        courier_access(&adapter.config, table.as_ref(), adapter.cx.uid, MARKER),
        None
    );
    native
        .environment
        .insert(SPAWN_ACCESS.into(), "full".into());
    table.insert(PID, native.clone());
    assert_eq!(
        courier_access(&adapter.config, table.as_ref(), adapter.cx.uid, SESSION),
        Some(true)
    );
    native.environment.remove(SPAWN_MARKER);
    table.insert(PID, native);
    assert_eq!(
        courier_access(&adapter.config, table.as_ref(), adapter.cx.uid, SESSION),
        None
    );
}

#[test]
fn recovery_requires_exact_invocation_and_live_message_capable_muse() {
    let root = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let adapter = adapter(root.path(), table.clone());
    table.insert(PID, process(adapter.cx.uid, Some(MARKER)));
    registry(&adapter, true);
    let recovered = adapter.find(&intent()).unwrap();
    assert_eq!(recovered.0, Target::new(SessionKind::MuseOpen, SESSION));
    assert_eq!(
        recovered.1,
        Some(SpawnedProcess {
            pid: PID,
            start: 71
        })
    );
    table.insert(PID, process(adapter.cx.uid, Some(SESSION)));
    assert!(adapter.find(&intent()).is_none());
    table.insert(PID, process(adapter.cx.uid + 1, Some(MARKER)));
    assert!(adapter.find(&intent()).is_none());
    table.insert(PID, process(adapter.cx.uid, Some(MARKER)));
    registry(&adapter, false);
    assert!(adapter.find(&intent()).is_none());
    registry(&adapter, true);
    table.remove(PID);
    assert!(adapter.find(&intent()).is_none());
}

#[test]
fn liveness_and_release_refuse_reused_foreign_or_unowned_processes() {
    let root = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let adapter = adapter(root.path(), table.clone());
    let target = Target::new(SessionKind::MuseOpen, SESSION);
    let saved = SpawnedProcess {
        pid: PID,
        start: 71,
    };
    table.insert(PID, process(adapter.cx.uid, Some(MARKER)));
    registry(&adapter, true);
    assert!(adapter.alive(&target, Some(&saved)));
    let wrong_target = Target::new(SessionKind::MuseOpen, MARKER);
    assert!(!adapter.alive(&wrong_target, Some(&saved)));
    adapter.stop(&wrong_target, Some(&saved));
    for changed in [
        FakeProcess {
            start: 72,
            ..process(adapter.cx.uid, Some(MARKER))
        },
        FakeProcess {
            zombie: true,
            ..process(adapter.cx.uid, Some(MARKER))
        },
        FakeProcess {
            executable: Some(PathBuf::from("/opt/unrelated")),
            ..process(adapter.cx.uid, Some(MARKER))
        },
        process(adapter.cx.uid + 1, Some(MARKER)),
        process(adapter.cx.uid, None),
    ] {
        table.insert(PID, changed);
        assert!(!adapter.alive(&target, Some(&saved)));
    }
    assert!(!adapter.alive(&target, None));
    // No signal is sent to an arbitrary process even when a saved pid exists.
    adapter.stop(&target, Some(&saved));
    adapter.stop(&target, None);
}

#[test]
fn durable_events_distinguish_completed_failed_and_new_turns() {
    let line = |event: Value| serde_json::json!({"payload": {"event": event}}).to_string();
    let completed = line(serde_json::json!({"kind": "terminal", "terminal": "completed"}));
    let failed = line(serde_json::json!({"kind": "terminal", "terminal": "failed"}));
    let next = line(serde_json::json!({"kind": "inbox_item_drained"}));
    assert_eq!(log_state(completed.as_bytes()), Some(WorkState::Idle));
    assert_eq!(log_state(failed.as_bytes()), Some(WorkState::Unknown));
    assert_eq!(
        log_state(format!("{completed}\n{next}\npartial{{").as_bytes()),
        Some(WorkState::Working)
    );
    assert_eq!(log_state(b"invalid json"), None);

    let root = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let adapter = adapter(root.path(), table.clone());
    table.insert(PID, process(adapter.cx.uid, Some(MARKER)));
    registry(&adapter, true);
    let log = adapter
        .config
        .data_dir
        .join("sessions/2026/10/15")
        .join(SESSION)
        .join("session.jsonl");
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(&log, &completed).unwrap();
    let mut watched = Watched {
        name: "muse-test".into(),
        target: Target::new(SessionKind::MuseOpen, SESSION),
        process: Some(SpawnedProcess {
            pid: PID,
            start: 71,
        }),
        alive: true,
    };
    assert_eq!(adapter.observe(&[watched.clone()])[0].work, WorkState::Idle);
    watched.alive = false;
    let mut replacement = process(adapter.cx.uid, None);
    replacement.start = 72;
    table.insert(PID, replacement);
    assert_eq!(
        adapter.observe(&[watched.clone()])[0].work,
        WorkState::Completed
    );
    std::fs::write(&log, &next).unwrap();
    let observed = adapter.observe(&[watched])[0];
    assert_eq!(observed.work, WorkState::Unknown);
    assert!(observed.turn_in_progress);
}

#[test]
fn detached_host_drains_output_exits_and_keeps_logs_private() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let log = root.path().join("host.log");
    host::run(
        Path::new("/bin/sh"),
        &log,
        &["-c".into(), "printf 'RELAY_PTY_HOST_OK'; test -t 0".into()],
    )
    .unwrap();
    assert!(std::fs::read_to_string(&log)
        .unwrap()
        .contains("RELAY_PTY_HOST_OK"));
    assert_eq!(
        std::fs::metadata(&log).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(host::run(Path::new("/bin/true"), &log, &[]).is_err());
    assert!(host::run(
        Path::new("/bin/false"),
        &root.path().join("failed.log"),
        &[]
    )
    .is_err());
}

#[test]
fn missing_registry_does_not_report_a_known_running_process_as_exited() {
    let root = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let adapter = adapter(root.path(), table.clone());
    table.insert(PID, process(adapter.cx.uid, Some(MARKER)));
    let watched = Watched {
        name: "muse-test".into(),
        target: Target::new(SessionKind::MuseOpen, SESSION),
        process: Some(SpawnedProcess {
            pid: PID,
            start: 71,
        }),
        alive: false,
    };
    assert_eq!(
        adapter.observe(&[watched.clone()])[0].process,
        ProcessLiveness::Unknown
    );
    table.remove(PID);
    assert_eq!(
        adapter.observe(&[watched.clone()])[0].process,
        ProcessLiveness::Unknown
    );
    let mut replacement = process(adapter.cx.uid, None);
    replacement.start = 72;
    table.insert(PID, replacement);
    assert_eq!(
        adapter.observe(&[watched])[0].process,
        ProcessLiveness::Exited
    );
}

#[test]
fn restart_before_muse_publishes_its_registry_stops_the_exact_detached_host() {
    use crate::relay::process::SystemProcesses;
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let cx = HarnessContext::system(
        &BTreeMap::new(),
        root.path(),
        &root.path().join("app"),
        Arc::new(SystemProcesses::default()),
    );
    std::fs::create_dir_all(cx.spawn_logs()).unwrap();
    let logs = cx.spawn_logs();
    let adapter = MuseAdapter {
        config: MuseConfig {
            data_dir: root.path().join("muse"),
        },
        cx,
        executable: None,
        ready_timeout: Duration::ZERO,
    };
    let mut fixture = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "relay::harness::muse::tests::pending_host_fixture",
            "--ignored",
        ])
        .env("AGENT_RELAY_TEST_MUSE_PENDING_ROOT", root.path())
        .env(SPAWN_MARKER, MARKER)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid_file = root.path().join("child.pid");
    let deadline = Instant::now() + Duration::from_secs(10);
    while (!pid_file.exists() || hosts::read(&logs, MARKER).is_none()) && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(25));
    }
    let child: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let child_process = adapter.cx.table.process(child).unwrap();
    // No registry or started callback survived. The host's own private record
    // must let recovery stop it rather than silently orphaning its terminal.
    let found = adapter.find(&intent());
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut status = None;
    while Instant::now() < deadline {
        status = fixture.try_wait().unwrap();
        if status.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let child_gone =
        adapter.cx.table.process(child) != Some(child_process) || adapter.cx.table.zombie(child);
    if status.is_none() {
        let _ = fixture.kill();
        let _ = fixture.wait();
    }
    if !child_gone {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(child),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    assert!(found.is_none());
    assert!(status.is_some(), "recovery left the pending host running");
    assert!(child_gone, "recovery left the pending Muse child running");
}

#[test]
#[ignore]
fn pending_host_fixture() {
    let Some(root) = std::env::var_os("AGENT_RELAY_TEST_MUSE_PENDING_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let args = vec![
        "-c".into(),
        "trap '' TERM HUP; printf '%s\\n' \"$$\" >\"$1\"; while :; do sleep 1; done".into(),
        "relay-muse-pending".into(),
        root.join("child.pid").display().to_string(),
    ];
    let _ = host::run(
        Path::new("/bin/sh"),
        &root
            .join("app/spawned-agents")
            .join(format!("{MARKER}.muse.log")),
        &args,
    );
}

#[test]
fn ending_an_agent_whose_child_died_stops_its_verified_detached_host() {
    use crate::relay::process::SystemProcesses;
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let cx = HarnessContext::system(
        &BTreeMap::new(),
        root.path(),
        &root.path().join("app"),
        Arc::new(SystemProcesses::default()),
    );
    std::fs::create_dir_all(cx.spawn_logs()).unwrap();
    let logs = cx.spawn_logs();
    let adapter = MuseAdapter {
        config: MuseConfig {
            data_dir: root.path().join("muse"),
        },
        cx,
        executable: None,
        ready_timeout: Duration::ZERO,
    };
    let mut fixture = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "relay::harness::muse::tests::orphaned_host_fixture",
            "--ignored",
        ])
        .env("AGENT_RELAY_TEST_MUSE_ORPHAN_ROOT", root.path())
        .env(SPAWN_MARKER, MARKER)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let ready = root.path().join("ready");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    let child = hosts::read(&logs, MARKER).and_then(|record| record.child);
    let target = Target::new(SessionKind::MuseOpen, SESSION);
    let foreign = Target::new(SessionKind::MuseOpen, MARKER);
    if let Some(child) = child.as_ref() {
        assert!(!adapter.alive(&target, Some(child)));
        // A record for another session proves nothing about this host.
        adapter.stop(&foreign, Some(child));
        std::thread::sleep(Duration::from_millis(200));
        assert!(fixture.try_wait().unwrap().is_none());
        adapter.stop(&target, Some(child));
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut status = None;
    while Instant::now() < deadline {
        status = fixture.try_wait().unwrap();
        if status.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if status.is_none() {
        let _ = fixture.kill();
        let _ = fixture.wait();
    }
    assert!(child.is_some(), "the fixture never bound its child");
    assert!(status.is_some(), "ending the agent left its host running");
}

/// A host that bound its Muse child, which then died, while it still runs.
#[test]
#[ignore]
fn orphaned_host_fixture() {
    use crate::relay::process::{ProcessTable, SystemProcesses};
    use std::process::Command;
    let Some(root) = std::env::var_os("AGENT_RELAY_TEST_MUSE_ORPHAN_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let logs = root.join("app/spawned-agents");
    hosts::begin(&logs.join(format!("{MARKER}.muse.log"))).unwrap();
    let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let table = SystemProcesses::default();
    let process = table.process(child.id() as i32).map(SpawnedProcess::of);
    let target = Target::new(SessionKind::MuseOpen, SESSION);
    assert!(hosts::bind(&logs, MARKER, &target, process, &table));
    let _ = child.kill();
    let _ = child.wait();
    std::fs::write(root.join("ready"), b"").unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
}
