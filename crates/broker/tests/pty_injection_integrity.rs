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
  if mode == 'middle_lost': body=body[:body.index(b'Relay message from ')+300]+body[-300:]
  if mode == 'paste_tail': body=b'[Pasted text #1 +3 lines]'+body[-40:]
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
        // Whole-payload evidence, which is the only verdict a verified fleet
        // spawn accepts as receipt of its task.
        assert!(
            ["echo", "echo_normalized"]
                .contains(&verified["payload"]["verification"].as_str().unwrap()),
            "{verified}"
        );
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
fn tail_only_echo_fails_without_replay() {
    let mut f = Fixture::new("tail");
    f.deliver("init_tail", &format!("HEAD{}TAIL", "abc xyz".repeat(1500)));
    assert_eq!(
        f.wait("delivery_failed")["payload"]["reason"],
        "echo_head_missing"
    );
    assert_eq!(f.wait("worker_error")["payload"]["retryable"], false);
    let before = f.transcript();
    f.deliver("init_tail", &format!("HEAD{}TAIL", "abc xyz".repeat(1500)));
    let deadline = Instant::now() + Duration::from_millis(300);
    while let Ok(line) =
        f.rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
    {
        if let Ok(frame) = serde_json::from_str::<Value>(&line) {
            assert_ne!(
                frame["type"], "delivery_verified",
                "failed replay must never become success"
            );
            assert_ne!(frame["type"], "delivery_ack");
        }
    }
    assert_eq!(f.transcript(), before, "failed body must never be replayed");
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
/// relay#1893 review, P1 x2: a tail-preserving echo was certified by matching
/// endpoints, and a collapsed-paste marker was certified by its mere presence.
/// Neither observes the payload, so neither may report a confirmed delivery.
#[test]
fn partial_echoes_are_acked_without_claiming_verification() {
    for (mode, expected) in [
        // Head and tail echoed, ~10 KB of the middle gone.
        ("middle_lost", "echo_incomplete"),
        // A partial paste's marker plus the body's last 40 bytes.
        ("paste_tail", "paste_summary"),
    ] {
        let mut f = Fixture::new(mode);
        f.deliver(
            "init_partial",
            &format!("HEAD{}TAIL", "important task content ".repeat(450)),
        );
        let verified = f.wait("delivery_verified");
        assert_eq!(
            verified["payload"]["verification"], expected,
            "{mode} must report what was actually observed"
        );
        // The labels a verified fleet spawn accepts as receipt.
        for confirming in ["echo", "echo_normalized"] {
            assert_ne!(
                verified["payload"]["verification"], confirming,
                "{mode} must never confirm full receipt"
            );
        }
        assert!(verified["payload"]["reason"].is_string(), "{mode}");
    }
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
