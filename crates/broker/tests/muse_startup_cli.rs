//! Real-binary PTY proof for broker-managed Muse startup.
//!
//! The fixture behaves like Muse's approval boundary: it refuses to run its
//! harmless `pwd` tool unless `--yolo` is present exactly once. It also only
//! exposes the ready marker after the argv prompt has been received and the
//! tool completed. This keeps the test deterministic without requiring Muse
//! credentials in CI while exercising the broker's actual PTY subprocess.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

#[test]
fn muse_argv_prompt_runs_tool_unattended_then_becomes_ready() {
    let directory = tempfile::tempdir().expect("Muse PTY fixture directory");
    let fake_muse = directory.path().join("muse");
    let prompt_marker = directory.path().join("prompt.txt");
    let tool_marker = directory.path().join("tool.txt");
    let task = "Run the harmless pwd tool, then become ready.\nDo not ask for approval.";

    std::fs::write(
        &fake_muse,
        r#"#!/bin/sh
set -eu
yolo_count=0
last_arg=''
for arg in "$@"; do
  if [ "$arg" = '--yolo' ]; then
    yolo_count=$((yolo_count + 1))
  fi
  last_arg=$arg
done
printf '%s' "$last_arg" > "$MUSE_PROMPT_MARKER"
if [ "$yolo_count" -ne 1 ]; then
  printf '%s\n' 'approval required'
  sleep 30
  exit 2
fi
if [ "$last_arg" != "$EXPECTED_MUSE_TASK" ]; then
  printf '%s\n' 'startup prompt missing'
  exit 3
fi
/bin/pwd > "$MUSE_TOOL_MARKER"
printf '%s\n' '->pty:ready'
sleep 30
"#,
    )
    .expect("write fake Muse executable");
    let mut permissions = std::fs::metadata(&fake_muse)
        .expect("fake Muse metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_muse, permissions).expect("chmod fake Muse executable");

    let mut child = Command::new(env!("CARGO_BIN_EXE_agent-relay-broker"))
        .args([
            "pty",
            "--agent-name",
            "muse-startup-cli-proof",
            fake_muse.to_str().expect("UTF-8 fake Muse path"),
            "--",
            "--yolo",
            task,
        ])
        .current_dir(directory.path())
        .env("EXPECTED_MUSE_TASK", task)
        .env("MUSE_PROMPT_MARKER", &prompt_marker)
        .env("MUSE_TOOL_MARKER", &tool_marker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn real broker PTY wrapper");

    let stdout = child.stdout.take().expect("broker stdout");
    let (line_tx, line_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });

    let init = serde_json::json!({
        "v": 2,
        "type": "init_worker",
        "payload": {"agent": {"name": "muse-startup-cli-proof"}}
    });
    writeln!(
        child.stdin.as_mut().expect("broker stdin"),
        "{}",
        serde_json::to_string(&init).expect("serialize init frame")
    )
    .expect("send init frame");

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut ready = None;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = match line_rx.recv_timeout(remaining) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => panic!("broker stdout error: {error}"),
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("broker stdout closed before worker_ready")
            }
        };
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if frame.get("type").and_then(Value::as_str) == Some("worker_ready") {
            ready = Some(frame);
            break;
        }
    }

    child.kill().expect("stop broker PTY wrapper");
    child.wait().expect("reap broker PTY wrapper");

    let ready = ready.expect("worker_ready frame");
    assert_eq!(ready["payload"]["readiness_proven"], true);
    assert_eq!(
        std::fs::read_to_string(&prompt_marker).expect("startup prompt marker"),
        task,
        "Muse must receive the assigned task in argv before readiness"
    );
    let tool_cwd = std::fs::canonicalize(
        std::fs::read_to_string(&tool_marker)
            .expect("harmless tool marker")
            .trim(),
    )
    .expect("canonical harmless tool cwd");
    assert_eq!(
        tool_cwd,
        directory
            .path()
            .canonicalize()
            .expect("canonical fixture cwd"),
        "the harmless tool must run without an approval stop before ready"
    );
}

/// A device-login screen must fail the spawn closed, not report a ready
/// worker. The fixture renders a provider login — including a prompt glyph
/// and well past the generic byte-count threshold, which is what made the
/// real worker look ready — and never exits.
///
/// The screen's wording follows the phrases
/// `relay_pty::terminal::detect_muse_device_auth_prompt` recognises; no live
/// capture of Muse's own login screen exists. A wording this misses still
/// fails closed, because Muse readiness no longer accepts output volume as
/// proof — it just loses the specific `provider_auth_required` status.
#[test]
fn muse_device_auth_screen_reports_provider_auth_required_without_readiness() {
    let directory = tempfile::tempdir().expect("Muse PTY fixture directory");
    let fake_muse = directory.path().join("muse");

    std::fs::write(
        &fake_muse,
        r#"#!/bin/sh
set -eu
printf '%s\n' '┌ Sign in to Muse ──────────────────────────────────┐'
printf '%s\n' '  To continue, sign in with your Meta account.'
printf '%s\n' '  Open https://www.facebook.com/device in a browser'
printf '%s\n' '  and enter this code: ABCD-1234'
printf '%s\n' '  Waiting for authentication...'
printf '%s\n' '└───────────────────────────────────────────────────┘'
# Pad the raw stream well past the generic 500-byte readiness fallback
# without scrolling the login screen off the grid: an SGR reset adds bytes
# and draws nothing.
i=0
while [ "$i" -lt 200 ]; do
  printf '\033[0m'
  i=$((i + 1))
done
printf '%s' '› '
sleep 30
"#,
    )
    .expect("write fake Muse executable");
    let mut permissions = std::fs::metadata(&fake_muse)
        .expect("fake Muse metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_muse, permissions).expect("chmod fake Muse executable");

    let mut child = Command::new(env!("CARGO_BIN_EXE_agent-relay-broker"))
        .args([
            "pty",
            "--agent-name",
            "muse-device-auth-proof",
            fake_muse.to_str().expect("UTF-8 fake Muse path"),
        ])
        .current_dir(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn real broker PTY wrapper");

    let stdout = child.stdout.take().expect("broker stdout");
    let (line_tx, line_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });

    let init = serde_json::json!({
        "v": 2,
        "type": "init_worker",
        "payload": {"agent": {"name": "muse-device-auth-proof"}}
    });
    writeln!(
        child.stdin.as_mut().expect("broker stdin"),
        "{}",
        serde_json::to_string(&init).expect("serialize init frame")
    )
    .expect("send init frame");

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut auth_error = None;
    let mut ready = None;
    while Instant::now() < deadline && auth_error.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = match line_rx.recv_timeout(remaining) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => panic!("broker stdout error: {error}"),
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("broker stdout closed before provider_auth_required")
            }
        };
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match frame.get("type").and_then(Value::as_str) {
            Some("worker_ready") => ready = Some(frame),
            Some("worker_error") => auth_error = Some(frame),
            _ => {}
        }
    }

    child.kill().expect("stop broker PTY wrapper");
    child.wait().expect("reap broker PTY wrapper");

    assert!(
        ready.is_none(),
        "a device-login screen must not produce a worker_ready frame: {ready:?}"
    );
    let auth_error = auth_error.expect("worker_error frame");
    assert_eq!(auth_error["payload"]["code"], "provider_auth_required");
    assert_eq!(auth_error["payload"]["retryable"], false);
    let message = auth_error["payload"]["message"]
        .as_str()
        .expect("error message");
    assert!(
        message.contains("device login"),
        "the error must name the remediation: {message}"
    );
    assert!(
        !message.contains("ABCD-1234"),
        "the device code must never be copied into a protocol frame: {message}"
    );
}
