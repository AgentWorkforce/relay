use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};

#[test]
fn descriptor_is_shared_and_unknown_or_other_sessions_are_not_owned() {
    let home = tempfile::tempdir().unwrap();
    let cx = HarnessContext::local(&BTreeMap::new(), home.path(), &home.path().join("data"));
    let adapter = DroidAdapter::new(&cx);
    assert_eq!(HarnessId::from_name("droid"), Some(ID));
    assert_eq!(ID.descriptor().label, "Factory Droid");
    assert!(ID.descriptor().full_access.is_none());
    assert!(adapter.owns(&Target::new(
        SessionKind::Droid,
        "11111111-2222-4333-8444-555555555555"
    )));
    assert!(!adapter.owns(&Target::new(
        SessionKind::Codex,
        "11111111-2222-4333-8444-555555555555"
    )));
    assert!(!adapter.owns(&Target::new(SessionKind::Droid, "../bad")));
}

#[test]
fn process_identity_requires_host_child_marker_start_and_executable() {
    let home = tempfile::tempdir().unwrap();
    let cli = home.path().join("droid");
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
        session_id: "11111111-2222-4333-8444-555555555555".into(),
        host: SpawnedProcess { pid: 40, start: 1 },
        child: SpawnedProcess { pid: 41, start: 2 },
        socket: home.path().join("host.sock"),
        executable: cli,
        directory: home.path().into(),
        initial_message_id: Some("test-initial".into()),
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
    let config = DroidConfig::from_env(&|_| None, home.path());
    let dir = runtime(&config);
    crate::relay::paths::socket_directory(&dir).unwrap();
    std::fs::write(dir.join("11111111-2222-4333-8444-555555555555.json"), "{}").unwrap();
    assert!(matches!(
        deliver(
            &config,
            &FakeProcesses::default(),
            "11111111-2222-4333-8444-555555555555",
            "m1",
            "hello"
        ),
        Some(InjectOutcome::Waiting(_))
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
    let mut adapter = DroidAdapter::new(&cx);
    let terminated = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captures = terminated.clone();
    let processes = table.clone();
    adapter.terminate = Arc::new(move |_, process| {
        captures.lock().unwrap().push(process);
        processes.remove(process.pid);
    });
    let dir = runtime(&adapter.config);
    crate::relay::paths::socket_directory(&dir).unwrap();
    let cli = home.path().join("droid-1.6.0");
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
        worker_cwd: None,
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
        session_id: "11111111-2222-4333-8444-555555555555".into(),
        host: SpawnedProcess { pid: 40, start: 1 },
        child: SpawnedProcess { pid: 41, start: 2 },
        socket: home.path().join("host.sock"),
        executable: cli,
        directory: home.path().into(),
        initial_message_id: Some("test-initial".into()),
    };
    write_record(
        &dir.join(format!("{}.ready.json", intent.session_id)),
        &record,
    )
    .unwrap();
    write_record(
        &dir.join("11111111-2222-4333-8444-555555555555.json"),
        &record,
    )
    .unwrap();
    let target = Target::new(SessionKind::Droid, "11111111-2222-4333-8444-555555555555");
    assert_eq!(
        adapter.find(&intent),
        Some((target.clone(), Some(record.host)))
    );
    assert!(adapter.alive(&target, Some(&record.host)));
    let mut incomplete = record.clone();
    incomplete.initial_message_id = None;
    let _ = std::fs::remove_file(dir.join(format!("{}.ready.json", intent.session_id)));
    write_record(
        &dir.join(format!("{}.ready.json", intent.session_id)),
        &incomplete,
    )
    .unwrap();
    assert!(
        adapter.find(&intent).is_none(),
        "a ready record without the initial handoff cannot be recovered"
    );
    table.insert(
        40,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            start: 1,
            environment: child.environment.clone(),
            ..Default::default()
        },
    );
    table.insert(41, child.clone());
    terminated.lock().unwrap().clear();
    let _ = std::fs::remove_file(dir.join(format!("{}.ready.json", intent.session_id)));
    write_record(
        &dir.join(format!("{}.ready.json", intent.session_id)),
        &record,
    )
    .unwrap();
    write_record(&dir.join(format!("{}.json", record.session_id)), &record).unwrap();
    use crate::relay::sessions::{SessionDirectory, SessionPartition};
    let mut config = crate::relay::local::LocalConfig::from_env(&|_| None, home.path());
    config.devin.development = true;
    let sessions = crate::relay::local::LocalSessions::new(config, table.clone());
    let rows = sessions
        .discover_partition(SessionPartition::Droid)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].target, target);
    assert!(sessions
        .discover_partition(SessionPartition::Devin)
        .unwrap()
        .is_empty());
    table.insert(
        42,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            parent: 41,
            start: 3,
            ..Default::default()
        },
    );
    assert_eq!(sessions.caller(42).unwrap().target, target);
    // A dead host must not free its still-owned child or block cleanup.
    table.remove(40);
    assert!(registry::child_owned(&record, &*table));
    assert!(!verified(&record, &*table));
    assert!(adapter.alive(&target, Some(&record.host)));
    adapter.stop(&target, Some(&record.host));
    assert!(terminated.lock().unwrap().contains(&record.child));
    assert!(!adapter.alive(&target, Some(&record.host)));
    assert!(!dir.join(format!("{}.json", record.session_id)).exists());
    assert!(!dir
        .join(format!("{}.ready.json", record.launch_id))
        .exists());
    write_record(&dir.join(format!("{}.json", record.session_id)), &record).unwrap();
    write_record(
        &dir.join(format!("{}.ready.json", record.launch_id)),
        &record,
    )
    .unwrap();
    table.insert(
        40,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            start: 1,
            environment: child.environment.clone(),
            ..Default::default()
        },
    );
    table.insert(41, child.clone());
    terminated.lock().unwrap().clear();
    table.insert(
        60,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            parent: 41,
            start: 4,
            executable: Some(record.executable.clone()),
            ..Default::default()
        },
    );
    table.insert(
        61,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            parent: 60,
            start: 5,
            ..Default::default()
        },
    );
    // An unmanaged Droid nested inside a managed worker never borrows its
    // parent's Relay identity, even though both have the same executable.
    assert!(sessions.caller(61).is_err());
    table.insert(
        41,
        FakeProcess {
            start: 999,
            ..child
        },
    );
    assert!(adapter.find(&intent).is_none());
    assert!(!adapter.alive(&target, Some(&record.host)));
    assert!(terminated.lock().unwrap().contains(&record.host));
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
    let adapter = DroidAdapter::new(&cx);
    let agent = Watched {
        name: "worker".into(),
        target: Target::new(SessionKind::Droid, "11111111-2222-4333-8444-555555555555"),
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

#[test]
fn transport_distinguishes_no_submission_from_a_lost_acknowledgement() {
    use std::io::BufRead;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    let home = tempfile::tempdir().unwrap();
    let cli = home.path().join("droid");
    std::fs::write(&cli, "").unwrap();
    let table = FakeProcesses::default();
    let pid = std::process::id() as i32;
    let marker = std::collections::HashMap::from([(MARKER.into(), "wire-fixture".into())]);
    table.insert(
        pid,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            start: 1,
            environment: marker.clone(),
            ..Default::default()
        },
    );
    table.insert(
        pid + 1,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            parent: pid,
            start: 2,
            environment: marker,
            executable: Some(cli.clone()),
            ..Default::default()
        },
    );
    let record = Record {
        launch_id: "wire-fixture".into(),
        session_id: "11111111-2222-4333-8444-555555555555".into(),
        host: SpawnedProcess { pid, start: 1 },
        child: SpawnedProcess {
            pid: pid + 1,
            start: 2,
        },
        socket: home.path().join("host.sock"),
        executable: cli,
        directory: home.path().into(),
        initial_message_id: None,
    };
    let request = json!({"op":"prompt","id":"one","text":"synthetic"});
    assert_eq!(
        registry::exchange_result(&record, &table, request.clone()),
        Err(registry::ExchangeFailure::Unavailable)
    );
    let listener = UnixListener::bind(&record.socket).unwrap();
    std::fs::set_permissions(&record.socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        std::io::BufReader::new(stream)
            .read_line(&mut line)
            .unwrap();
        assert!(line.contains("synthetic"));
        // The request arrived but the host closes before acknowledging it.
    });
    assert_eq!(
        registry::exchange_result(&record, &table, request),
        Err(registry::ExchangeFailure::Uncertain)
    );
    server.join().unwrap();
}
