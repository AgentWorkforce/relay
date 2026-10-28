//! The shipped `relay serve` binary. It lives in its own test process: the
//! children it spawns briefly inherit every descriptor across fork, which
//! would hold another test's instance lock.

use serde_json::Value;
use std::process::{Command, Stdio};
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(10);

/// Whether the daemon listens: its socket file on Unix; on Windows, where
/// no file stands for the pipe, whether the pipe answers.
fn listening(socket: &std::path::Path) -> bool {
    if cfg!(windows) {
        agent_relay_probe::relay::transport::is_served(socket)
    } else {
        socket.exists()
    }
}

/// What a cleared environment still needs: Windows processes cannot start
/// their system libraries without `SystemRoot`.
fn keep_system_environment(command: &mut Command) {
    if cfg!(windows) {
        for key in ["SystemRoot", "SystemDrive", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
}

/// The shipped binary: `relay serve` refuses a second instance, answers
/// `relay call`, and stops when its hosting app closes stdin. The
/// environment is cleared so no real workspace key or Relaycast is reached.
#[test]
fn the_binary_serves_answers_calls_and_stops_with_its_host() {
    let temp = tempfile::tempdir().unwrap();
    let socket = temp.path().join("core.sock");
    let command = |args: &[&str]| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_agent-relay-probe"));
        command
            .env_clear()
            .env("HOME", temp.path())
            .env("PATH", "/usr/bin:/bin")
            .args(args);
        keep_system_environment(&mut command);
        command
    };
    let data_dir = temp.path().join("app-data");
    let serve_args = [
        "relay",
        "serve",
        "--socket",
        socket.to_str().unwrap(),
        "--app-data-dir",
        data_dir.to_str().unwrap(),
        "--exit-on-stdin-eof",
        // A development site: no telemetry, no command-line copy.
        "--site-url",
        "http://127.0.0.1:9",
    ];
    let mut daemon = command(&serve_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + WAIT;
    while !listening(&socket) {
        assert!(std::time::Instant::now() < deadline, "the daemon listens");
        std::thread::sleep(Duration::from_millis(10));
    }

    let second = command(&serve_args[..4]).output().unwrap();
    assert!(!second.status.success());
    assert_eq!(
        String::from_utf8_lossy(&second.stderr).trim(),
        "Agent Relay core is already running for this socket."
    );

    let call = command(&[
        "relay",
        "call",
        "status.get",
        "--socket",
        socket.to_str().unwrap(),
        "--json",
    ])
    .output()
    .unwrap();
    assert!(call.status.success(), "{call:?}");
    let answer: Value = serde_json::from_slice(&call.stdout).unwrap();
    assert_eq!(answer["bridge_version"], 1);
    assert_eq!(answer["result"]["workspace"]["state"], "missing");
    assert_eq!(answer["result"]["account"]["state"], "signed_out");

    // The uploader runs this same binary's commands: nothing is connected
    // in an empty home, and the preview answers.
    let preview = command(&[
        "relay",
        "call",
        "uploader.sessions.preview",
        "--socket",
        socket.to_str().unwrap(),
        "--json",
    ])
    .output()
    .unwrap();
    assert!(preview.status.success(), "{preview:?}");
    let answer: Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(answer["result"]["sessions"], serde_json::json!([]));

    drop(daemon.stdin.take());
    let deadline = std::time::Instant::now() + WAIT;
    let status = loop {
        if let Some(status) = daemon.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() > deadline {
            let _ = daemon.kill();
            panic!("the daemon did not stop when stdin closed");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success());
    assert!(!socket.exists());

    let gone = command(&[
        "relay",
        "call",
        "status.get",
        "--socket",
        socket.to_str().unwrap(),
    ])
    .output()
    .unwrap();
    assert!(!gone.status.success());
    assert!(String::from_utf8_lossy(&gone.stderr).contains("is not running"));
}

/// `relay serve --headless`, as the systemd user unit runs it: it removes
/// the app's own login entry (systemd starts Agent Relay, so the entry
/// would start a second copy), keeps any other file at that path, serves,
/// and stops on SIGTERM. Linux's XDG autostart and signals only.
#[cfg(unix)]
#[test]
fn the_headless_service_removes_the_apps_login_entry_and_stops_on_sigterm() {
    let temp = tempfile::tempdir().unwrap();
    let socket = temp.path().join("core.sock");
    let entry = temp.path().join("config/autostart/agent-relay.desktop");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    let owned = "[Desktop Entry]\nType=Application\nName=Agent Relay\n\
                 Exec=/usr/bin/agent-relay --background\nIcon=agent-relay\n";
    let foreign = "[Desktop Entry]\nType=Application\nName=Agent Relay\n\
                   Exec=/opt/mine --background\nIcon=agent-relay\n";
    for (text, removed) in [(owned, true), (foreign, false)] {
        std::fs::write(&entry, text).unwrap();
        let mut daemon = Command::new(env!("CARGO_BIN_EXE_agent-relay-probe"))
            .env_clear()
            .env("HOME", temp.path())
            .env("PATH", "/usr/bin:/bin")
            .env("XDG_CONFIG_HOME", temp.path().join("config"))
            .env("XDG_RUNTIME_DIR", temp.path().join("run"))
            .args([
                "relay",
                "serve",
                "--headless",
                "--socket",
                socket.to_str().unwrap(),
                "--app-data-dir",
                temp.path().join("app-data").to_str().unwrap(),
                "--site-url",
                "http://127.0.0.1:9",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + WAIT;
        while !listening(&socket) {
            assert!(std::time::Instant::now() < deadline, "the daemon listens");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(!entry.exists(), removed, "{text}");
        unsafe { libc::kill(daemon.id() as i32, libc::SIGTERM) };
        let deadline = std::time::Instant::now() + WAIT;
        let status = loop {
            if let Some(status) = daemon.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() > deadline {
                let _ = daemon.kill();
                panic!("the daemon did not stop on SIGTERM");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        assert!(!socket.exists());
    }
}

#[test]
fn local_model_proxy_command_is_removed() {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-relay-probe"))
        .args(["credential-proxy", "serve"])
        .env("RELAY_DESKTOP_CREDENTIAL_PROXY", "1")
        .env("ANTHROPIC_API_KEY", "test-key-must-not-be-consumed")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("unrecognized subcommand"), "{error}");
    assert!(!error.contains("test-key-must-not-be-consumed"));
}
