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
    assert_eq!(
        std::fs::read_to_string(&tool_marker)
            .expect("harmless tool marker")
            .trim(),
        directory.path().to_string_lossy(),
        "the harmless tool must run without an approval stop before ready"
    );
}
