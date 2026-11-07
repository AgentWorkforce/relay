use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};
use crate::relay::store::SessionKind;
use serde_json::json;
use std::path::Path;

const SESSION: &str = "727cce8d-8074-4ea3-94a0-dea144bf8747";

fn config(root: &Path, other: &Path) -> ClaudeConfig {
    ClaudeConfig {
        home: root.into(),
        executable: None,
        app_sessions: None,
        dirs: crate::relay::claude_dirs::ClaudeDirs {
            private_root: None,
            environment: vec![other.into()],
            file: None,
        },
    }
}

fn record(root: &Path, pid: i32, start: u64) {
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    std::fs::write(
        root.join("sessions").join(format!("{pid}.json")),
        json!({"pid":pid,"sessionId":SESSION,"procStart":start,
            "messagingSocketPath":"/synthetic/claude.sock","kind":"interactive"})
        .to_string(),
    )
    .unwrap();
}

fn processes(pids: &[i32]) -> FakeProcesses {
    let table = FakeProcesses::default();
    for pid in pids {
        table.insert(
            *pid,
            FakeProcess {
                start: 123,
                arguments: vec!["claude".into()],
                has_terminal: true,
                ..Default::default()
            },
        );
    }
    table
}

#[test]
fn native_roots_reject_same_process_in_two_logins_before_pid_deduplication() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("login-a");
    let b = dir.path().join("login-b");
    record(&a, 42, 123);
    record(&b, 42, 123);
    let table = processes(&[42]);
    for (default, extra) in [(&a, &b), (&b, &a)] {
        let config = config(default, extra);
        assert_eq!(claude::registry(&config, &table).sessions.len(), 1);
        assert!(read(&config, &table).is_empty());
    }
}

#[test]
fn native_roots_require_unique_session_ids_and_matching_live_incarnations() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("login-a");
    let b = dir.path().join("login-b");
    record(&a, 42, 123);
    record(&b, 43, 123);
    let config = config(&a, &b);
    let table = processes(&[42, 43]);
    assert!(read(&config, &table).is_empty());
    record(&b, 43, 122);
    assert_eq!(
        read(&config, &table),
        [(Target::new(SessionKind::ClaudeTerminal, SESSION), a)].into()
    );
}

#[test]
fn partial_duplicate_record_cannot_certify_another_root_for_the_same_pid() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("login-a");
    let b = dir.path().join("login-b");
    record(&a, 42, 123);
    record(&b, 42, 123);
    std::fs::write(b.join("sessions/42.json"), "{partial").unwrap();
    assert!(read(&config(&a, &b), &processes(&[42])).is_empty());
}

#[test]
fn unreadable_live_record_suspends_attribution_but_dead_record_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("login-a");
    let b = dir.path().join("login-b");
    record(&a, 42, 123);
    record(&b, 43, 123);
    std::fs::write(b.join("sessions/43.json"), "{partial").unwrap();
    let config = config(&a, &b);
    assert!(read(&config, &processes(&[42, 43])).is_empty());
    assert_eq!(
        read(&config, &processes(&[42])),
        [(Target::new(SessionKind::ClaudeTerminal, SESSION), a)].into()
    );
}

#[test]
fn sdk_host_keeps_its_inbox_but_never_advertises_native_mobile_input() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("login");
    let b = dir.path().join("unused");
    record(&a, 42, 123);
    let config = config(&a, &b);
    let table = processes(&[42]);
    assert_eq!(read(&config, &table).len(), 1);
    for arguments in [
        vec!["claude", "--input-format", "stream-json"],
        vec!["claude", "--input-format=stream-json"],
        vec!["claude", "--output-format", "stream-json"],
        vec!["claude", "--output-format=stream-json"],
        vec!["claude", "-p", "hello"],
        vec!["claude", "--print"],
        vec![],
    ] {
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&42)
            .unwrap()
            .arguments = arguments.iter().map(|arg| (*arg).into()).collect();
        assert!(read(&config, &table).is_empty(), "{arguments:?}");
        assert_eq!(
            claude::registry(&config, &table).sessions.len(),
            1,
            "excluding native capability must not remove the peer inbox"
        );
    }
    table
        .processes
        .lock()
        .unwrap()
        .get_mut(&42)
        .unwrap()
        .arguments = vec!["claude".into()];
    table
        .processes
        .lock()
        .unwrap()
        .get_mut(&42)
        .unwrap()
        .has_terminal = false;
    assert!(
        read(&config, &table).is_empty(),
        "a pipe without SDK flags is not native terminal input"
    );
    assert_eq!(claude::registry(&config, &table).sessions.len(), 1);
    table
        .processes
        .lock()
        .unwrap()
        .get_mut(&42)
        .unwrap()
        .has_terminal = true;
    let path = a.join("sessions/42.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for entrypoint in ["sdk-cli", "sdk-ts", "sdk"] {
        value["entrypoint"] = json!(entrypoint);
        std::fs::write(&path, value.to_string()).unwrap();
        assert!(read(&config, &table).is_empty(), "{entrypoint}");
    }
    value["entrypoint"] = json!("cli");
    std::fs::write(&path, value.to_string()).unwrap();
    assert_eq!(read(&config, &table).len(), 1);
    for name in ["sdk-task", "SDK-task", "Sdk-task"] {
        value["name"] = json!(name);
        std::fs::write(&path, value.to_string()).unwrap();
        assert!(read(&config, &table).is_empty(), "{name}");
        assert_eq!(claude::registry(&config, &table).sessions.len(), 1);
    }
}
