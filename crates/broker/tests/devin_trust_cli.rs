//! Real broker PTY tests with a synthetic Devin fixture (python3 required).
//! These are NOT captured Devin menus and do not authorize automatic acceptance.
//! Each test has a fresh HOME/XDG tree; the trusted arm uses a fixture-only trust
//! record scoped to cwd. Cursor placement and raw input model the Devin composer.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run_fixture(mode: &str) {
    let directory = tempfile::tempdir().expect("fixture directory");
    let home = directory.path().join("home");
    let cwd = directory.path().join("worktree");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let trusted = mode == "trusted";
    if trusted {
        std::fs::write(home.join("fixture-trust"), cwd.to_str().unwrap()).unwrap();
    }
    let fake_devin = directory.path().join("devin");
    let input_marker = directory.path().join("input");
    let task_marker = directory.path().join("task");
    std::fs::write(
        &fake_devin,
        r#"#!/usr/bin/env python3
import os, pathlib, sys, tty
tty.setraw(0)
trust = pathlib.Path(os.environ['HOME']) / 'fixture-trust'
trusted = trust.exists() and trust.read_text() == os.getcwd()
if trusted:
    sys.stdout.write('❭ Ask Devin to build features, fix bugs, or work on your code')
else:
    sys.stdout.write('Do you trust the authors of this directory?\r\nprivate-directory-marker\r\n')
    if os.environ['FIXTURE_MODE'] == 'widening':
        sys.stdout.write('❭ 1 Yes, trust the parent directory and all subdirectories\r\n2 No, exit')
    elif os.environ['FIXTURE_MODE'] == 'wrapped':
        sys.stdout.write('❭ 1 Yes, trust\r\n  this workspace\r\n2 No, exit')
    else:
        sys.stdout.write('❭ 1. Yes, I trust the authors\r\n2. No, exit')
sys.stdout.flush()
data = b''
while True:
    part = os.read(0, 4096)
    if not part:
        break
    with open(os.environ['INPUT_MARKER'], 'ab') as log:
        log.write(part)
    data += part
    if trusted and b'\r' in data:
        pathlib.Path(os.environ['TASK_MARKER']).write_bytes(data)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&fake_devin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut worker = Worker(
        Command::new(env!("CARGO_BIN_EXE_agent-relay-broker"))
            .args([
                "pty",
                "--agent-name",
                "devin-trust-proof",
                fake_devin.to_str().unwrap(),
            ])
            .current_dir(&cwd)
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("AGENT_RELAY_LOCAL_ONLY", "1")
            .env("FIXTURE_MODE", mode)
            .env("INPUT_MARKER", &input_marker)
            .env("TASK_MARKER", &task_marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn broker PTY"),
    );
    let stdout = worker.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    for frame in [
        json!({"v":2, "type":"init_worker", "payload":{"agent":{"name":"devin-trust-proof"}}}),
        json!({"v":2, "type":"deliver_relay", "payload":{
            "delivery_id":"fixture-delivery", "event_id":"fixture-event", "from":"operator",
            "target":"devin-trust-proof", "body":"Begin fixture task"
        }}),
    ] {
        writeln!(worker.0.stdin.as_mut().unwrap(), "{frame}").unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(if trusted { 10 } else { 40 });
    let mut ready = false;
    let mut error = None;
    while Instant::now() < deadline {
        if trusted && ready && task_marker.exists() {
            break;
        }
        let line = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            other => panic!("broker stdout closed: {other:?}"),
        };
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match frame["type"].as_str() {
            Some("worker_ready") => {
                assert!(trusted, "trust dialog reported ready: {frame}");
                assert_eq!(frame["payload"]["readiness_proven"], true);
                ready = true;
            }
            Some("worker_error") => {
                error = Some(frame);
                break;
            }
            _ => {}
        }
    }
    if trusted {
        assert!(error.is_none(), "{error:?}");
        assert!(ready, "already-trusted fixture must become ready");
        let task = std::fs::read_to_string(&task_marker).expect("task must be submitted");
        assert!(task.contains("Begin fixture task"), "{task}");
        assert_eq!(
            std::fs::read_to_string(home.join("fixture-trust")).unwrap(),
            cwd.to_str().unwrap()
        );
    } else {
        let error = error.expect("frozen trust prompt must produce worker_error within 40s");
        assert_eq!(error["payload"]["code"], "directory_trust_required");
        assert_eq!(error["payload"]["retryable"], false);
        let message = error["payload"]["message"].as_str().unwrap();
        assert!(message.contains("spawn working directory"));
        assert!(!message.contains("private-directory-marker"));
        assert!(
            !input_marker.exists(),
            "no trust response or task may enter the dialog"
        );
        assert!(!home.join("fixture-trust").exists());
        assert!(!ready);
    }
}

#[test]
fn fresh_home_frozen_trust_prompt_fails_without_readiness() {
    run_fixture("unanswerable");
}

#[test]
fn widening_only_trust_menu_is_never_accepted() {
    run_fixture("widening");
}

#[test]
fn wrapped_workspace_trust_prompt_fails_without_readiness() {
    run_fixture("wrapped");
}

#[test]
fn already_trusted_directory_becomes_ready_and_begins_task() {
    run_fixture("trusted");
}
