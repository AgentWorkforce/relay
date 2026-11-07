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
