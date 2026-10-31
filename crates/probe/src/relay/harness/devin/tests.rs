use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};

#[test]
fn descriptor_is_shared_and_unknown_or_other_sessions_are_not_owned() {
    let home = tempfile::tempdir().unwrap();
    let cx = HarnessContext::local(&BTreeMap::new(), home.path(), &home.path().join("data"));
    let adapter = DevinAdapter::new(&cx);
    assert_eq!(HarnessId::from_name("devin"), Some(ID));
    assert_eq!(ID.descriptor().label, "Devin");
    assert!(!ID.descriptor().full_access.unwrap().default);
    assert!(adapter.owns(&Target::new(SessionKind::Devin, "true-session")));
    assert!(!adapter.owns(&Target::new(SessionKind::Codex, "true-session")));
    assert!(!adapter.owns(&Target::new(SessionKind::Devin, "../bad")));
}

#[test]
fn process_identity_requires_host_child_marker_start_and_executable() {
    let home = tempfile::tempdir().unwrap();
    let cli = home.path().join("devin");
    std::fs::write(&cli, "").unwrap();
    let table = FakeProcesses::default();
    let env = std::collections::HashMap::from([(MARKER.into(), "spawn-one".into())]);
    table.insert(
        40,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            start: 1,
            environment: env.clone(),
            ..Default::default()
        },
    );
    let child = FakeProcess {
        uid: crate::relay::peer::current_uid(),
        parent: 40,
        start: 2,
        environment: env,
        executable: Some(cli.clone()),
        ..Default::default()
    };
    table.insert(41, child.clone());
    let record = Record {
        launch_id: "spawn-one".into(),
        session_id: "real-session".into(),
        host: SpawnedProcess { pid: 40, start: 1 },
        child: SpawnedProcess { pid: 41, start: 2 },
        socket: home.path().join("host.sock"),
        executable: cli,
    };
    assert!(verified(&record, &table));
    table.insert(
        41,
        FakeProcess {
            start: 3,
            ..child.clone()
        },
    );
    assert!(!verified(&record, &table));
    table.insert(
        41,
        FakeProcess {
            environment: Default::default(),
            ..child.clone()
        },
    );
    assert!(!verified(&record, &table));
    table.insert(
        41,
        FakeProcess {
            parent: 9,
            ..child.clone()
        },
    );
    assert!(!verified(&record, &table));
    table.insert(
        41,
        FakeProcess {
            zombie: true,
            ..child
        },
    );
    assert!(!verified(&record, &table));
}

#[test]
fn unreadable_spawn_record_fails_closed_instead_of_using_legacy_inbox() {
    let home = tempfile::tempdir().unwrap();
    let config = DevinConfig::from_env(&|_| None, home.path());
    let dir = runtime(&config);
    crate::relay::paths::socket_directory(&dir).unwrap();
    std::fs::write(dir.join("real-session.json"), "{}").unwrap();
    assert!(matches!(
        deliver(
            &config,
            &FakeProcesses::default(),
            "real-session",
            "m1",
            "hello"
        ),
        Some(InjectOutcome::Refused(_))
    ));
    assert_eq!(
        deliver(
            &config,
            &FakeProcesses::default(),
            "unowned-session",
            "m1",
            "hello"
        ),
        None
    );
}

#[test]
fn restart_finds_only_its_live_host_and_never_adopts_a_reused_pid() {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let cx = HarnessContext::system(
        &BTreeMap::new(),
        home.path(),
        &home.path().join("app.dev"),
        table.clone(),
    );
    let adapter = DevinAdapter::new(&cx);
    let dir = runtime(&adapter.config);
    crate::relay::paths::socket_directory(&dir).unwrap();
    let cli = home.path().join("devin");
    std::fs::write(&cli, "").unwrap();
    let intent = Intent {
        invocation_id: "test-invocation".into(),
        name: "worker".into(),
        harness: ID,
        node_id: "test-node".into(),
        node_name: "test-desktop".into(),
        title: "Test".into(),
        base_url: "https://cast.example".into(),
        workspace_key: crate::relay::workspace::Secret::new("rk_test_synthetic"),
        workspace_id: None,
        machine_prefix: "test".into(),
        message_id: "test-initial".into(),
        session_id: crate::relay::store::random_uuid(),
        created_ms: 0,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: None,
        token: None,
        requester: None,
        target: None,
        process: None,
    };
    let env = std::collections::HashMap::from([(MARKER.into(), intent.session_id.clone())]);
    table.insert(
        40,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            start: 1,
            environment: env.clone(),
            ..Default::default()
        },
    );
    let child = FakeProcess {
        uid: crate::relay::peer::current_uid(),
        parent: 40,
        start: 2,
        environment: env,
        executable: Some(cli.clone()),
        ..Default::default()
    };
    table.insert(41, child.clone());
    let record = Record {
        launch_id: intent.session_id.clone(),
        session_id: "real-session".into(),
        host: SpawnedProcess { pid: 40, start: 1 },
        child: SpawnedProcess { pid: 41, start: 2 },
        socket: home.path().join("host.sock"),
        executable: cli,
    };
    write_record(
        &dir.join(format!("{}.ready.json", intent.session_id)),
        &record,
    )
    .unwrap();
    write_record(&dir.join("real-session.json"), &record).unwrap();
    let target = Target::new(SessionKind::Devin, "real-session");
    assert_eq!(
        adapter.find(&intent),
        Some((target.clone(), Some(record.host)))
    );
    assert!(adapter.alive(&target, Some(&record.host)));
    table.insert(
        41,
        FakeProcess {
            start: 999,
            ..child
        },
    );
    assert!(adapter.find(&intent).is_none());
    assert!(!adapter.alive(&target, Some(&record.host)));
}

#[test]
fn uncertain_kernel_or_registry_reads_keep_a_place_until_exit_is_proven() {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    table.insert(
        40,
        FakeProcess {
            start: 1,
            ..Default::default()
        },
    );
    let cx = HarnessContext::system(&BTreeMap::new(), home.path(), home.path(), table.clone());
    let adapter = DevinAdapter::new(&cx);
    let agent = Watched {
        name: "worker".into(),
        target: Target::new(SessionKind::Devin, "real-session"),
        process: Some(SpawnedProcess { pid: 40, start: 1 }),
        alive: false,
    };
    assert_eq!(adapter.process_state(&agent), ProcessLiveness::Unknown);
    table.insert(
        40,
        FakeProcess {
            start: 2,
            ..Default::default()
        },
    );
    assert_eq!(adapter.process_state(&agent), ProcessLiveness::Exited);
}

const TIMEOUT_RUNTIME: &str = "AGENT_RELAY_TEST_DEVIN_RUNTIME";
const TIMEOUT_DIRECTORY: &str = "AGENT_RELAY_TEST_DEVIN_DIRECTORY";
const TIMEOUT_PROVIDER: &str = "AGENT_RELAY_TEST_DEVIN_PROVIDER";
const TIMEOUT_PID: &str = "AGENT_RELAY_TEST_DEVIN_PID";

// Native test processes keep environment inspection available on macOS;
// Apple's shell binaries deliberately hide theirs from other processes.
#[test]
#[ignore = "subprocess fixture for the owned timeout cleanup regression"]
fn timeout_host_fixture() {
    let runtime = std::env::var_os(TIMEOUT_RUNTIME).expect("fixture runtime");
    let directory = std::env::var_os(TIMEOUT_DIRECTORY).expect("fixture directory");
    let provider = std::env::var_os(TIMEOUT_PROVIDER).expect("fixture provider");
    let marker = std::env::var(MARKER).expect("fixture launch identity");
    let _ = host::run(
        Path::new(&provider),
        Path::new(&directory),
        Path::new(&runtime),
        &marker,
        false,
    );
}

#[test]
#[ignore = "subprocess provider that never reads stdin or answers ACP"]
fn timeout_provider_fixture() {
    let pid = std::env::var_os(TIMEOUT_PID).expect("fixture pid path");
    std::fs::write(pid, std::process::id().to_string()).unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

#[test]
fn startup_timeout_stops_owned_acp_child_even_when_it_ignores_stdin_eof() {
    use crate::relay::process::SystemProcesses;
    use std::os::unix::fs::PermissionsExt;
    struct Cleanup(Vec<SpawnedProcess>, PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let table = SystemProcesses::default();
            for process in &self.0 {
                stop_process(&table, process.pid, Some(process.start));
            }
            let _ = std::fs::remove_file(&self.1);
        }
    }
    let home = tempfile::tempdir().unwrap();
    let runtime = home.path().join("runtime");
    let provider_pid = home.path().join("provider.pid");
    let test_binary =
        crate::relay::outbound::shell_quote(&std::env::current_exe().unwrap().to_string_lossy());
    let wrapper = |name: &str, fixture: &str| {
        let path = home.path().join(name);
        std::fs::write(&path, format!("#!/bin/sh\nexec {test_binary} --exact relay::harness::devin::tests::{fixture} --ignored --nocapture\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    };
    let provider = wrapper("devin", "timeout_provider_fixture");
    let helper = wrapper("helper", "timeout_host_fixture");
    let environment = BTreeMap::from([
        (TIMEOUT_RUNTIME.into(), runtime.display().to_string()),
        (TIMEOUT_DIRECTORY.into(), home.path().display().to_string()),
        (TIMEOUT_PROVIDER.into(), provider.display().to_string()),
        (TIMEOUT_PID.into(), provider_pid.display().to_string()),
        ("RELAY_DESKTOP_DEVIN".into(), provider.display().to_string()),
    ]);
    let table = Arc::new(SystemProcesses::default());
    let cx = HarnessContext::system(
        &environment,
        home.path(),
        &home.path().join("app"),
        table.clone(),
    );
    let mut adapter = DevinAdapter::new(&cx);
    adapter.helper = Some(helper);
    adapter.ready_timeout = Duration::from_secs(2);
    let started = std::sync::Mutex::new(None);
    let launch_id = crate::relay::store::random_uuid();
    let error = adapter.launch(
        &Launch {
            harness: ID,
            name: "timeout-test".into(),
            text: "no task is ever submitted".into(),
            directory: home.path().to_path_buf(),
            full_access: false,
            message_id: "timeout-initial".into(),
            session_id: launch_id.clone(),
        },
        &|_, process| *started.lock().unwrap() = process,
    );
    let host = started.lock().unwrap().expect("host process was recorded");
    let socket = PathBuf::from("/tmp")
        .join(format!(
            "agent-relay-devin-{}",
            crate::relay::peer::current_uid()
        ))
        .join(format!("{launch_id}.sock"));
    let mut cleanup = Cleanup(vec![host], socket);
    let pid: i32 = std::fs::read_to_string(provider_pid)
        .expect("the provider started and then stalled")
        .trim()
        .parse()
        .unwrap();
    if let Some(process) = table.process(pid) {
        cleanup.0.push(SpawnedProcess::of(process));
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && (!table.process_gone(host.pid) || !table.process_gone(pid)) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(matches!(error, Err(LaunchError::Failed(_))));
    assert!(
        table.process_gone(host.pid) || table.zombie(host.pid),
        "timed-out host survived"
    );
    assert!(
        table.process_gone(pid) || table.zombie(pid),
        "owned ACP child survived the host timeout"
    );
}
