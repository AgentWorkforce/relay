use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};
use std::os::unix::fs::{symlink, PermissionsExt};

#[test]
fn executable_discovery_canonicalizes_relative_paths_and_development_matches_plugins() {
    let directory = tempfile::tempdir_in(".").unwrap();
    let binary = directory.path().join("droid");
    std::fs::write(&binary, "").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let env = BTreeMap::from([("RELAY_DESKTOP_DROID".into(), binary.display().to_string())]);
    let data = std::ffi::OsString::from_vec(b"invalid-\xff.dev".to_vec());
    let cx = HarnessContext::local(&env, directory.path(), &directory.path().join(data));
    let adapter = DroidAdapter::new(&cx);
    assert_eq!(
        adapter.executable,
        Some(std::fs::canonicalize(binary).unwrap())
    );
    assert!(!adapter.config.development);
}

#[test]
fn executable_identity_survives_a_retargeted_installation_symlink() {
    let directory = tempfile::tempdir().unwrap();
    let old = directory.path().join("droid-1.6.0");
    let next = directory.path().join("droid-1.7.0");
    let link = directory.path().join("droid");
    std::fs::write(&old, "old").unwrap();
    std::fs::write(&next, "new").unwrap();
    symlink(&old, &link).unwrap();
    let table = FakeProcesses::default();
    let env = std::collections::HashMap::from([(MARKER.into(), "launch".into())]);
    table.insert(
        40,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            start: 1,
            environment: env.clone(),
            ..Default::default()
        },
    );
    table.insert(
        41,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            parent: 40,
            start: 2,
            environment: env,
            executable: Some(old.clone()),
            ..Default::default()
        },
    );
    let record = Record {
        launch_id: "launch".into(),
        session_id: "11111111-2222-4333-8444-555555555555".into(),
        host: SpawnedProcess { pid: 40, start: 1 },
        child: SpawnedProcess { pid: 41, start: 2 },
        socket: directory.path().join("socket"),
        executable: std::fs::canonicalize(&link).unwrap(),
        directory: directory.path().into(),
        initial_message_id: None,
    };
    assert!(verified(&record, &table));
    std::fs::remove_file(&link).unwrap();
    symlink(next, &link).unwrap();
    assert!(verified(&record, &table));
    assert!(crate::relay::droid::is_droid_process(&table, 41));
}

use std::os::unix::ffi::OsStringExt;

#[test]
fn a_failed_initial_file_create_never_deletes_another_launch_handoff() {
    let home = tempfile::tempdir().unwrap();
    let binary = home.path().join("droid");
    std::fs::write(&binary, "").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let env = BTreeMap::from([("RELAY_DESKTOP_DROID".into(), binary.display().to_string())]);
    let cx = HarnessContext::local(&env, home.path(), &home.path().join("data"));
    let adapter = DroidAdapter::new(&cx);
    let dir = runtime(&adapter.config);
    crate::relay::paths::socket_directory(&dir).unwrap();
    let launch = Launch {
        harness: ID,
        name: "worker".into(),
        text: "new task".into(),
        directory: home.path().into(),
        full_access: false,
        message_id: "new".into(),
        session_id: crate::relay::store::random_uuid(),
    };
    registry::write_initial(&dir, &launch.session_id, "original", "original task").unwrap();
    assert!(adapter
        .launch(&launch, &|_, _| panic!(
            "a host must not start for an existing handoff"
        ))
        .is_err());
    let retained = registry::initial(&dir, &launch.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(retained.id, "original");
    assert_eq!(retained.text, "original task");
}

#[test]
fn caller_uses_only_its_marked_ready_record_and_rejects_a_nested_renamed_worker() {
    let home = tempfile::tempdir().unwrap();
    let config = DroidConfig::from_env(&|_| None, home.path());
    let dir = runtime(&config);
    crate::relay::paths::socket_directory(&dir).unwrap();
    let executable = home.path().join("renamed-worker");
    std::fs::write(&executable, "").unwrap();
    let launch = crate::relay::store::random_uuid();
    let environment = std::collections::HashMap::from([(MARKER.into(), launch.clone())]);
    let table = FakeProcesses::default();
    table.insert(
        40,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            start: 1,
            environment: environment.clone(),
            ..Default::default()
        },
    );
    table.insert(
        41,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            parent: 40,
            start: 2,
            environment: environment.clone(),
            executable: Some(executable.clone()),
            ..Default::default()
        },
    );
    let record = Record {
        launch_id: launch.clone(),
        session_id: crate::relay::store::random_uuid(),
        host: SpawnedProcess { pid: 40, start: 1 },
        child: SpawnedProcess { pid: 41, start: 2 },
        socket: home.path().join("socket"),
        executable: executable.clone(),
        directory: home.path().into(),
        initial_message_id: None,
    };
    write_record(&dir.join(format!("{launch}.ready.json")), &record).unwrap();
    // No session record exists: the marked ready record proves this exact worker.
    assert_eq!(
        crate::relay::droid::caller(&config, &table, 41)
            .unwrap()
            .unwrap(),
        record.session_id
    );
    table.insert(
        42,
        FakeProcess {
            uid: crate::relay::peer::current_uid(),
            parent: 41,
            start: 3,
            environment,
            executable: Some(executable),
            ..Default::default()
        },
    );
    assert!(crate::relay::droid::caller(&config, &table, 42)
        .unwrap()
        .is_err());
}

#[test]
fn unverified_mcp_isolation_refuses_before_any_host_or_provider_side_effect() {
    let home = tempfile::tempdir().unwrap();
    let binary = home.path().join("droid");
    std::fs::write(&binary, "not an executable image").unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let env = BTreeMap::from([("RELAY_DESKTOP_DROID".into(), binary.display().to_string())]);
    let cx = HarnessContext::local(&env, home.path(), &home.path().join("data"));
    let adapter = DroidAdapter::new(&cx);
    assert!(
        matches!(adapter.detect(), Installed::Unusable(reason) if reason == STARTUP_ISOLATION_GUIDANCE)
    );
    let launch = Launch {
        harness: ID,
        name: "worker".into(),
        text: "owned synthetic task".into(),
        directory: home.path().into(),
        full_access: false,
        message_id: "one".into(),
        session_id: crate::relay::store::random_uuid(),
    };
    assert!(matches!(
        adapter.launch(&launch, &|_, _| panic!("a held host must not start")),
        Err(LaunchError::Unavailable(reason)) if reason == STARTUP_ISOLATION_GUIDANCE
    ));
    let runtime = runtime(&adapter.config);
    assert!(!runtime.exists());
    let error = host::run(&binary, home.path(), &runtime, &launch.session_id).unwrap_err();
    assert_eq!(error.to_string(), STARTUP_ISOLATION_GUIDANCE);
    assert!(!runtime.exists());
}
