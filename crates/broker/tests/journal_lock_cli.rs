//! Pipe-boundary integration tests for the hidden `journal-lock` helper:
//! spawn the REAL binary and prove that a parent dying mid-frame (partial
//! payload + clean EOF) can never replace good journal contents. These run
//! in the mandatory Rust Tests job — direct `replace_journal` unit tests do
//! not exercise the stdin pipe boundary.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};

const FRAME_MAGIC: &[u8] = b"ARJL1\n";

struct Setup {
    _dir: tempdir::TempDirGuard,
    lock: std::path::PathBuf,
    journal: std::path::PathBuf,
}

mod tempdir {
    pub struct TempDirGuard(pub std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn setup(name: &str, seed: &[u8]) -> Setup {
    let dir = std::env::temp_dir().join(format!(
        "journal-lock-cli-{name}-{}-{}",
        std::process::id(),
        name.len()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let journal = dir.join("pending-cleanups.json");
    std::fs::write(&journal, seed).unwrap();
    Setup {
        lock: dir.join("pending-cleanups.json.lock"),
        journal,
        _dir: tempdir::TempDirGuard(dir),
    }
}

fn spawn_helper(setup: &Setup) -> std::process::Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_agent-relay-broker"))
        .args([
            "journal-lock",
            "--file",
            setup.lock.to_str().unwrap(),
            "--journal-file",
            setup.journal.to_str().unwrap(),
            "--timeout-ms",
            "5000",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper");
    let stdout = child.stdout.take().expect("helper stdout");
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .expect("read handshake");
    assert_eq!(line, "locked\n", "exact framed handshake");
    child
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let digest = format!("{:x}", Sha256::digest(payload));
    let mut frame = Vec::new();
    frame.extend_from_slice(FRAME_MAGIC);
    frame.extend_from_slice(format!("{}\n{}\n", payload.len(), digest).as_bytes());
    frame.extend_from_slice(payload);
    frame
}

#[test]
fn commits_a_complete_valid_frame() {
    let setup = setup("commit", b"[]\n");
    let mut child = spawn_helper(&setup);
    let payload = b"[{\"kind\":\"relay-webhook\",\"scope\":\"s\",\"id\":\"x\"}]\n";
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&frame(payload))
        .unwrap();
    let status = child.wait().unwrap();
    assert!(status.success());
    assert_eq!(std::fs::read(&setup.journal).unwrap(), payload);
}

#[test]
fn partial_frame_then_eof_leaves_journal_untouched() {
    let seed = b"[{\"kind\":\"relay-webhook\",\"scope\":\"s\",\"id\":\"original\"}]\n";
    let setup = setup("truncated", seed);
    let mut child = spawn_helper(&setup);
    // A proper frame prefix with only part of the declared body — exactly
    // what a parent dying mid-`stdin.end(payload)` produces.
    let full = frame(b"[{\"kind\":\"relay-webhook\",\"scope\":\"s\",\"id\":\"replacement\"}]\n");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&full[..full.len() - 10])
        .unwrap(); // drop into EOF via take() scope end
    let status = child.wait().unwrap();
    assert!(!status.success(), "truncated frame must not commit");
    assert_eq!(status.code(), Some(5));
    assert_eq!(
        std::fs::read(&setup.journal).unwrap(),
        seed,
        "journal must be byte-for-byte untouched"
    );
}

#[test]
fn empty_eof_aborts_without_writing() {
    let seed = b"[]\n";
    let setup = setup("abort", seed);
    let mut child = spawn_helper(&setup);
    drop(child.stdin.take());
    let status = child.wait().unwrap();
    assert!(status.success());
    assert_eq!(std::fs::read(&setup.journal).unwrap(), seed);
}
