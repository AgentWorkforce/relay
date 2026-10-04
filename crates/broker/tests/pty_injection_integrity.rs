//! Real broker, raw-mode fake Claude TUI, byte-level transcript assertions.
#![cfg(unix)]
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
struct Fixture {
    child: Child,
    rx: mpsc::Receiver<String>,
    dir: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("claude-fixture");
        std::fs::write(
            &script,
            r#"#!/usr/bin/env python3
import os, tty, time, select
# Canonical mode silently discards input after MAX_CANON. Real TUIs use raw mode.
tty.setraw(0)
mode=os.environ['FIXTURE_MODE']
time.sleep(0.2)
os.write(1,b'\x1b[?2004h\x1b[?2004l' if mode != 'typed' else b'')
os.write(1,'Claude Code v2.1.261\r\n❯ '.encode())
data=b''
while True:
 chunk=os.read(0,65536)
 with open(os.environ['TRANSCRIPT'],'ab') as f: f.write(chunk)
 data+=chunk
 if mode == 'hostile' and b'\x1b\x1b' in data:
  os.write(1,b'\x1b[2J\x1b[HTrust prompt, no composer')
  data=b''
 if data.endswith(b'\r'):
  body=data.replace(b'\x1b[200~',b'').replace(b'\x1b[201~',b'').rstrip(b'\r')
  if mode == 'tail': body=body[-200:]
  if mode != 'silent': os.write(1,b'\r\n'+body+b'\r\n')
  os.write(1,'\r\n❯ '.encode())
  data=b''
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_agent-relay-broker"))
            .args(["pty", "--agent-name", "integrity", script.to_str().unwrap()])
            .env("FIXTURE_MODE", mode)
            .env("TRANSCRIPT", dir.path().join("transcript"))
            .env("AGENT_RELAY_LOCAL_ONLY", "1")
            .env(
                "RELAY_INJECT_PASTE",
                if mode == "typed" { "0" } else { "1" },
            )
            .current_dir(dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if tx.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        let mut f = Self { child, rx, dir };
        f.send("init_worker", json!({"agent":{"name":"integrity"}}));
        assert_eq!(f.wait("worker_ready")["payload"]["readiness_proven"], true);
        f
    }
    fn send(&mut self, kind: &str, payload: Value) {
        writeln!(
            self.child.stdin.as_mut().unwrap(),
            "{}",
            json!({"v":2,"type":kind,"payload":payload})
        )
        .unwrap();
    }
    fn wait(&self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            let line = self
                .rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect(kind);
            if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                if frame["type"] == kind {
                    return frame;
                }
            }
        }
    }
    fn deliver(&mut self, id: &str, body: &str) {
        self.send("deliver_relay",json!({"delivery_id":format!("del_{id}"),"event_id":id,"from":"broker","target":"integrity","body":body,"priority":2,"injection_mode":"wait"}));
    }
    fn transcript(&self) -> Vec<u8> {
        std::fs::read(self.dir.path().join("transcript")).unwrap_or_default()
    }
}
fn long_pair() {
    let mut f = Fixture::new("echo");
    for id in ["init_task", "relay_message"] {
        let body = format!("HEAD-{id}\n{}\nTAIL-{id}", "éabc xyz\n".repeat(1100));
        assert!(body.len() > 10_000);
        let before = f.transcript().len();
        f.deliver(id, &body);
        let verified = f.wait("delivery_verified");
        assert_ne!(verified["payload"]["verification"], "timeout_fallback");
        let transcript = f.transcript();
        let bytes = &transcript[before..];
        assert!(bytes.windows(body.len()).any(|w| w == body.as_bytes()));
        assert_eq!(bytes.windows(6).filter(|w| *w == b"\x1b[200~").count(), 1);
        assert_eq!(bytes.windows(6).filter(|w| *w == b"\x1b[201~").count(), 1);
        assert_eq!(bytes.iter().filter(|&&b| b == b'\r').count(), 1);
    }
}
#[test]
fn ten_kib_task_and_relay_message_are_intact() {
    long_pair();
}
#[test]
fn over_limit_and_typed_fallback_reject_before_writing() {
    for mode in ["echo", "typed"] {
        let mut f = Fixture::new(mode);
        f.deliver(
            "init_limit",
            &"x".repeat(if mode == "typed" { 10_000 } else { 17_000 }),
        );
        assert!(f.wait("delivery_failed")["payload"]["reason"]
            .as_str()
            .unwrap()
            .contains("injection_too_large"));
        assert!(f.transcript().is_empty());
    }
}
#[test]
fn absent_echo_preserves_timeout_fallback() {
    let mut f = Fixture::new("silent");
    f.deliver("init_silent", "hello");
    assert_eq!(
        f.wait("delivery_verified")["payload"]["verification"],
        "timeout_fallback"
    );
}
#[test]
#[ignore = "20 cold starts; run separately"]
fn twenty_cold_starts() {
    for _ in 0..20 {
        long_pair();
    }
}

#[test]
fn disappearing_composer_fails_before_body_injection() {
    let mut f = Fixture::new("hostile");
    f.send("deliver_relay", json!({"delivery_id":"del_hostile", "event_id":"init_hostile", "from":"broker", "target":"integrity", "body":"must not type this into a dialog", "priority":2,"injection_mode":"steer"}));
    assert_eq!(
        f.wait("delivery_failed")["payload"]["reason"],
        "prompt_unproven"
    );
    assert!(!String::from_utf8_lossy(&f.transcript()).contains("must not type"));
}
