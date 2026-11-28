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
        gate_launch: false,
        name: "worker".into(),
        harness: ID,
        approval_profile: None,
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
        worker_cwd: None,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: None,
        token: None,
        requester: None,
        launcher: None,
        target: None,
        process: None,
        control_url: None,
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
        &crate::relay::outbound::Build::Production,
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
            fork: None,
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

#[test]
fn host_arguments_pass_build_flag_explicitly_for_dev_and_profile() {
    let home = tempfile::tempdir().unwrap();
    let launch = Launch {
        harness: ID,
        name: "worker".into(),
        text: "hello".into(),
        directory: home.path().to_path_buf(),
        full_access: false,
        message_id: "m1".into(),
        session_id: "launch-1".into(),
        fork: None,
    };
    let dev_cx = HarnessContext::local(
        &BTreeMap::new(),
        home.path(),
        &home.path().join("com.agentrelay.desktop.dev"),
    );
    let dev_adapter = DevinAdapter::new(&dev_cx);
    let dev_dir = runtime(&dev_adapter.config);
    assert!(dev_dir.ends_with("spawned"));
    let dev_args = dev_adapter.host_arguments(Path::new("/bin/devin"), &dev_dir, &launch);
    assert!(dev_args.iter().any(|arg| arg == "--dev"), "{dev_args:?}");
    assert!(!dev_args.iter().any(|arg| arg.starts_with("--profile")));
    let mcp = crate::relay::harness::relay_mcp::definition(
        Path::new("/bin/helper"),
        "agent_relay",
        &dev_adapter.build,
        crate::relay::harness::relay_mcp::Harness::Devin,
    );
    assert_eq!(mcp["args"], json!(["devin-spawn-mcp", "--dev"]));

    let prod_cx = HarnessContext::local(
        &BTreeMap::new(),
        home.path(),
        &home.path().join("com.agentrelay.desktop"),
    );
    let prod_args =
        DevinAdapter::new(&prod_cx).host_arguments(Path::new("/bin/devin"), &dev_dir, &launch);
    assert!(!prod_args.iter().any(|arg| arg == "--dev"));
    assert!(!prod_args.iter().any(|arg| arg.starts_with("--profile")));

    let profile_cx = HarnessContext::local(
        &BTreeMap::new(),
        home.path(),
        &home.path().join("com.agentrelay.desktop.acme"),
    );
    let profile_args =
        DevinAdapter::new(&profile_cx).host_arguments(Path::new("/bin/devin"), &dev_dir, &launch);
    assert!(!profile_args.iter().any(|arg| arg == "--dev"));
    assert!(profile_args.iter().any(|arg| arg == "--profile=acme"));
}

#[test]
fn dev_upgrade_recovers_delivers_and_stops_legacy_spawned_dev_worker() {
    use std::io::{BufRead, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let dev_cx = HarnessContext::system(
        &BTreeMap::new(),
        home.path(),
        &home.path().join("com.agentrelay.desktop.dev"),
        table.clone(),
    );
    let prod_cx = HarnessContext::system(
        &BTreeMap::new(),
        home.path(),
        &home.path().join("com.agentrelay.desktop"),
        table.clone(),
    );
    let mut dev_adapter = DevinAdapter::new(&dev_cx);
    let terminated = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captures = terminated.clone();
    let processes = table.clone();
    dev_adapter.terminate = Arc::new(move |_, process| {
        captures.lock().unwrap().push(process);
        processes.remove(process.pid);
    });
    let prod_adapter = DevinAdapter::new(&prod_cx);

    let legacy_dir = legacy_dev_runtime(&dev_adapter.config);
    crate::relay::paths::socket_directory(&legacy_dir).unwrap();
    let cli = home.path().join("devin");
    std::fs::write(&cli, "").unwrap();
    let launch_id = crate::relay::store::random_uuid();
    let pid = std::process::id() as i32;
    let child_pid = pid.saturating_add(100_000);
    let env = std::collections::HashMap::from([(MARKER.into(), launch_id.clone())]);
    table.insert(
        pid,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            start: 1,
            environment: env.clone(),
            ..Default::default()
        },
    );
    table.insert(
        child_pid,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            parent: pid,
            start: 2,
            environment: env,
            executable: Some(cli.clone()),
            ..Default::default()
        },
    );
    let sock_dir = tempfile::tempdir_in("/tmp").unwrap();
    let socket = sock_dir.path().join("h.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();

    let record = Record {
        launch_id: launch_id.clone(),
        session_id: "legacy-session".into(),
        host: SpawnedProcess { pid, start: 1 },
        child: SpawnedProcess {
            pid: child_pid,
            start: 2,
        },
        socket: socket.clone(),
        executable: cli,
    };
    write_record(&legacy_dir.join(format!("{launch_id}.ready.json")), &record).unwrap();
    write_record(&legacy_dir.join("legacy-session.json"), &record).unwrap();

    let intent = Intent {
        invocation_id: "upgrade-invocation".into(),
        gate_launch: false,
        name: "worker".into(),
        harness: ID,
        approval_profile: None,
        node_id: "test-node".into(),
        node_name: "test-desktop".into(),
        title: "Test".into(),
        base_url: "https://cast.example".into(),
        workspace_key: crate::relay::workspace::Secret::new("rk_test_synthetic"),
        workspace_id: None,
        machine_prefix: "test".into(),
        message_id: "test-initial".into(),
        session_id: launch_id,
        created_ms: 0,
        worker_cwd: None,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: None,
        token: None,
        requester: None,
        launcher: None,
        target: None,
        process: None,
        control_url: None,
    };
    let target = Target::new(SessionKind::Devin, "legacy-session");

    // Production must not touch Dev's legacy `spawned-dev` runtime.
    assert!(prod_adapter.find(&intent).is_none());
    assert!(!prod_adapter.alive(&target, Some(&record.host)));
    assert_eq!(
        deliver(
            &dev_adapter.config,
            table.as_ref(),
            "legacy-session",
            "m1",
            "hello"
        ),
        None
    );

    // Development recovers the ready record, recognizes liveness, delivers, and stops it.
    assert_eq!(
        dev_adapter.find(&intent),
        Some((target.clone(), Some(record.host)))
    );
    assert!(dev_adapter.alive(&target, Some(&record.host)));

    let server_table = table.clone();
    let server = std::thread::spawn(move || {
        // First request: prompt delivery.
        let (mut stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        std::io::BufReader::new(&stream)
            .read_line(&mut line)
            .unwrap();
        let req: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(req["op"], "prompt");
        writeln!(stream, r#"{{"status":"delivered"}}"#).unwrap();
        drop(stream);

        // Second request: stop.
        let (mut stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        std::io::BufReader::new(&stream)
            .read_line(&mut line)
            .unwrap();
        let req: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(req["op"], "stop");
        server_table.remove(child_pid);
        server_table.remove(pid);
        writeln!(stream, r#"{{"status":"stopped"}}"#).unwrap();
    });

    assert_eq!(
        deliver_with_legacy_dev(
            &dev_adapter.config,
            table.as_ref(),
            "legacy-session",
            "m1",
            "hello",
            true,
        ),
        Some(InjectOutcome::Delivered)
    );
    dev_adapter.stop(&target, Some(&record.host));
    server.join().unwrap();
    assert!(!dev_adapter.alive(&target, Some(&record.host)));
    assert_eq!(*terminated.lock().unwrap(), vec![record.child, record.host]);
}
