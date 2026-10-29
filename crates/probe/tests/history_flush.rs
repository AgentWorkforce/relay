//! `history flush`: the hosted sandbox's teardown upload with a push-only
//! `rth_*` session Cloud already exchanged. The real binary, a synthetic
//! provider tree and a loopback receiver; no Agent Relay Cloud exists here.
mod support {
    pub mod fake_history;
}

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};
use support::fake_history::{Behaviour, FakeHistory};

const TOKEN: &str = "rth_at_flushsecret0123456789abcdef";
const REFRESH: &str = "rth_rt_refreshsecret0123456789";

/// A sandbox: provider roots, a state directory and nothing else.
struct Sandbox {
    root: tempfile::TempDir,
}
impl Sandbox {
    fn new() -> Sandbox {
        Sandbox {
            root: tempfile::tempdir().unwrap(),
        }
    }
    fn path(&self) -> &Path {
        self.root.path()
    }
    fn state(&self) -> PathBuf {
        self.path().join("state")
    }
    fn claude(&self) -> PathBuf {
        self.path().join("claude-config")
    }
    fn codex(&self) -> PathBuf {
        self.path().join("codex-home")
    }
    /// One Claude Code transcript of `lines` user turns, each carrying a
    /// marker `{session}-{n}`.
    fn claude_session(&self, session: &str, lines: usize) {
        let project = self.claude().join("projects/flush");
        fs::create_dir_all(&project).unwrap();
        let text: String = (0..lines)
            .map(|n| {
                format!(
                    "{}\n",
                    json!({"sessionId":session,"uuid":format!("{session}-{n}"),"type":"user",
                        "cwd":"/work/flush",
                        "message":{"role":"user","content":format!("synthetic {session}-{n}")},
                        "timestamp":format!("2026-09-01T10:{:02}:{:02}.000Z", n / 60, n % 60)})
                )
            })
            .collect();
        fs::write(project.join(format!("{session}.jsonl")), text).unwrap();
    }
    fn codex_session(&self, id: &str, marker: &str) {
        let directory = self.codex().join("sessions/2026/09/01");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(format!("rollout-{id}.jsonl")),
            format!(
                "{}\n{}\n",
                json!({"timestamp":"2026-09-01T11:00:00.000Z","type":"session_meta",
                    "payload":{"id":id,"cwd":"/work/flush"}}),
                json!({"timestamp":"2026-09-01T11:00:03.000Z","type":"event_msg",
                    "payload":{"type":"user_message","message":format!("codex {marker}")}}),
            ),
        )
        .unwrap();
    }
    /// The flush command, with an environment that holds no credential and
    /// a home that holds no history.
    fn command(&self, deadline_secs: u64) -> Command {
        self.command_with_state(deadline_secs, &self.state())
    }
    fn command_with_state(&self, deadline_secs: u64, state: &Path) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_agent-relay-probe"));
        command
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", self.path().join("home"))
            .env("CLAUDE_CONFIG_DIR", self.claude())
            .env("CODEX_HOME", self.codex())
            .env("GROK_HOME", self.path().join("grok"))
            .env("XDG_DATA_HOME", self.path().join("xdg"))
            .env("OPENCODE_DB", self.path().join("opencode/opencode.db"))
            .current_dir(self.path())
            // Exercise the pre-clap credential scan with a global option
            // preceding the hidden subcommand.
            .args(["--json", "history", "flush", "--state-dir"])
            .arg(state)
            .args(["--deadline-secs", &deadline_secs.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}

fn session(base_url: &str) -> Value {
    json!({"baseUrl": base_url, "accessToken": TOKEN,
        "accessTokenExpiresAt": "2099-01-01T00:00:00Z",
        "orgId": "org_flush", "workspaceId": "ws_flush", "scopes": ["rth:sync"]})
}

/// Run with the session on stdin.
fn run_stdin(mut command: Command, session: &Value) -> Output {
    command.arg("--session-stdin");
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(session.to_string().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn wait_for_exit(mut child: Child, within: Duration) -> Output {
    let deadline = Instant::now() + within;
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!("child did not exit in time: {}", diagnose(&output));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_until(within: Duration, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !ready() {
        assert!(Instant::now() < deadline, "condition did not become ready");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The one JSON summary line, with its fields checked.
fn summary(output: &Output) -> Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 1, "one summary line: {stdout:?}");
    let value: Value = serde_json::from_str(lines[0]).unwrap();
    let mut keys: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "acknowledged_records",
            "elapsed_ms",
            "exit_reason",
            "ok",
            "pending_records",
            "sessions_captured"
        ]
    );
    value
}

fn diagnose(output: &Output) -> String {
    format!(
        "status={:?}\nstdout={}\nstderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Every file under `dir`, recursively.
fn files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return found;
    };
    for entry in entries {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(files(&path));
        } else {
            found.push(path);
        }
    }
    found
}

/// (a) A backlog that outlasts one delivery pass, in many small batches, is
/// drained completely before the command returns.
#[test]
fn a_backlog_bigger_than_one_pass_is_drained_to_empty() {
    let receiver = FakeHistory::start(Behaviour {
        max_records: Some(20),
        delay: Duration::from_millis(100),
        ..Default::default()
    });
    let sandbox = Sandbox::new();
    for session in 0..8 {
        sandbox.claude_session(&format!("backlog-{session}"), 60);
    }
    let mut command = sandbox.command(120);
    // Debug builds only: one pass is 300 ms instead of 15 s, so the backlog
    // spans several passes without a 15 s test.
    command.env("AGENT_RELAY_PROBE_FLUSH_PASS_MS", "300");
    let output = run_stdin(command, &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(0), "{}", diagnose(&output));
    let summary = summary(&output);
    assert_eq!(summary["ok"], true);
    assert_eq!(summary["exit_reason"], "drained");
    assert_eq!(summary["pending_records"], 0);
    assert!(summary["acknowledged_records"].as_i64().unwrap() >= 480);
    assert!(summary["sessions_captured"].as_i64().unwrap() >= 8);
    // More than one pass's worth of delivery: the drain went on after it.
    assert!(
        summary["elapsed_ms"].as_u64().unwrap() > 2 * 300,
        "{summary}"
    );
    // Batches start at the protocol's 100 records until a receipt publishes
    // the receiver's 20.
    assert!(receiver.batches().len() >= 20, "several batches");
    for session in 0..8 {
        for n in [0, 59] {
            assert!(receiver.received(&format!("backlog-{session}-{n}")));
        }
    }
    // Every batch carried the pushed session, and nothing else was asked for.
    assert!(receiver
        .batches()
        .iter()
        .all(|batch| batch.authorization.as_deref() == Some(&format!("Bearer {TOKEN}"))));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&sandbox.state()), 0o700);
        let stored = files(&sandbox.state());
        assert!(!stored.is_empty());
        for file in stored {
            assert_eq!(mode(&file), 0o600, "{}", file.display());
        }
    }
}

/// (b) A receiver that fails until the deadline leaves records queued and
/// says so, rather than reporting success.
#[test]
fn a_failing_receiver_ends_at_the_deadline_with_records_pending() {
    let receiver = FakeHistory::start(Behaviour {
        status: Some(503),
        ..Default::default()
    });
    let sandbox = Sandbox::new();
    sandbox.claude_session("unavailable", 5);
    let started = Instant::now();
    let output = run_stdin(sandbox.command(4), &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(3), "{}", diagnose(&output));
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "the deadline bounds the run"
    );
    let summary = summary(&output);
    assert!(summary["elapsed_ms"].as_u64().unwrap() < 4_750);
    assert_eq!(summary["ok"], false);
    assert_eq!(summary["exit_reason"], "deadline");
    assert!(summary["pending_records"].as_i64().unwrap() > 0);
    assert_eq!(summary["acknowledged_records"], 0);
    assert!(!receiver.batches().is_empty(), "delivery was attempted");
}

/// The process watchdog owns the same one-line contract when a dependency
/// ignores its request timeout (notably DNS in the pinned HTTP stack).
#[test]
fn a_stalled_dependency_cannot_outlive_the_deadline_grace() {
    let sandbox = Sandbox::new();
    let mut command = sandbox.command(1);
    command.env("AGENT_RELAY_PROBE_FLUSH_STALL_AFTER_WATCHDOG_MS", "20000");
    command.arg("--session-stdin");
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(session("http://127.0.0.1:1").to_string().as_bytes())
        .unwrap();
    let output = wait_for_exit(child, Duration::from_secs(3));
    assert_eq!(output.status.code(), Some(3), "{}", diagnose(&output));
    let summary = summary(&output);
    assert_eq!(summary["exit_reason"], "deadline");
    assert!(summary["elapsed_ms"].as_u64().unwrap() < 1_750);
}

/// A real HTTP request that takes longer than the command's wall budget is
/// bounded by the same absolute deadline, not a fresh timeout per pass.
#[test]
fn a_slow_receiver_cannot_overrun_the_absolute_deadline() {
    let receiver = FakeHistory::start(Behaviour {
        delay: Duration::from_secs(20),
        ..Default::default()
    });
    let sandbox = Sandbox::new();
    sandbox.claude_session("slow-deadline", 3);
    let started = Instant::now();
    let output = run_stdin(sandbox.command(6), &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(3), "{}", diagnose(&output));
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "process setup plus the watchdog grace bounds the real slow request"
    );
    let summary = summary(&output);
    assert_eq!(summary["exit_reason"], "deadline");
    assert!(summary["elapsed_ms"].as_u64().unwrap() < 6_750);
    assert!(!receiver.batches().is_empty(), "delivery was attempted");
}

/// Clap failures for the teardown command preserve stdout's JSON framing and
/// have a reason distinct from a rejected pushed session.
#[test]
fn a_usage_error_emits_one_json_summary() {
    let sandbox = Sandbox::new();
    let output = sandbox.command(30).output().unwrap();
    assert_eq!(output.status.code(), Some(64), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "invalid_arguments");
    assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
}

/// Global flags may appear between the hidden command's subcommands; usage
/// failures still retain the teardown JSON contract and distinct exit code.
#[test]
fn a_usage_error_with_an_interposed_global_option_is_still_json() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_agent-relay-probe"));
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .args(["history", "--json", "flush"]);
    let output = command.output().unwrap();
    assert_eq!(output.status.code(), Some(64), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "invalid_arguments");
}

/// Clap's successful display requests are not teardown attempts and therefore
/// print only their normal help/version output, without an appended summary.
#[test]
fn help_and_version_do_not_append_a_json_summary() {
    let sandbox = Sandbox::new();
    for flag in ["--help", "--version"] {
        let output = sandbox.command(30).arg(flag).output().unwrap();
        assert_eq!(output.status.code(), Some(0), "{}", diagnose(&output));
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(!stdout.contains("\"exit_reason\""), "{stdout}");
        assert!(!stdout.trim().is_empty(), "{flag} printed nothing");
    }
}

/// A host may wait for our summary without closing its writer. One complete
/// JSON object is a frame of its own; EOF is not part of the protocol.
#[test]
fn a_complete_stdin_session_does_not_require_eof() {
    let receiver = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    sandbox.claude_session("open-pipe", 2);
    let mut command = sandbox.command(30);
    command.arg("--session-stdin");
    let mut child = command.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(session(&receiver.base_url).to_string().as_bytes())
        .unwrap();
    input.flush().unwrap();
    let output = wait_for_exit(child, Duration::from_secs(10));
    assert_eq!(output.status.code(), Some(0), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "drained");
    drop(input);
}

/// An incomplete frame cannot pin teardown forever even if the writer stays
/// open: the same wall deadline bounds session input.
#[test]
fn an_incomplete_stdin_session_ends_at_the_deadline() {
    let sandbox = Sandbox::new();
    let mut command = sandbox.command(1);
    command.arg("--session-stdin");
    let mut child = command.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(b"{").unwrap();
    input.flush().unwrap();
    let output = wait_for_exit(child, Duration::from_secs(5));
    assert_eq!(output.status.code(), Some(3), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "deadline");
    drop(input);
}

/// (c) Anything but a push-only `rth_*` session for a trusted stage fails
/// closed before any request is made.
#[test]
fn sessions_that_are_not_push_only_fail_closed_without_a_request() {
    let receiver = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    sandbox.claude_session("refused", 3);
    let base = receiver.base_url.clone();
    let with = |key: &str, value: Value| {
        let mut session = session(&base);
        session[key] = value;
        session
    };
    let refused = [
        with("scopes", json!(["rth:read", "rth:sync"])),
        with("scopes", json!(["rth:read"])),
        with("scopes", json!([])),
        with("scopes", json!(["rth:sync", "rth:sync"])),
        with("accessToken", json!("rth_rt_not_an_access_token")),
        with("accessToken", json!("eyJhbGciOi.relayauth.jwt")),
        with("orgId", json!("")),
        with("workspaceId", json!("")),
        with("accessTokenExpiresAt", json!("2020-01-01T00:00:00Z")),
        with("baseUrl", json!("https://history.example.com")),
        with("baseUrl", json!("http://history.agentrelay.com")),
        with("baseUrl", json!("https://history.agentrelay.com:8443")),
        json!({"baseUrl": base}),
        json!("not a session"),
    ];
    for refused in refused {
        let output = run_stdin(sandbox.command(30), &refused);
        assert_eq!(
            output.status.code(),
            Some(2),
            "{refused}: {}",
            diagnose(&output)
        );
        let summary = summary(&output);
        assert_eq!(summary["ok"], false);
        assert_eq!(summary["exit_reason"], "invalid_session");
    }
    assert!(receiver.requests().is_empty(), "no request was made");
    assert!(
        !sandbox.state().join("history.db").exists(),
        "nothing was captured"
    );
}

/// A caller cannot point the flush at an unrelated directory: only a fresh
/// empty directory or a directory previously marked by this command is used.
#[test]
fn an_unmarked_nonempty_state_directory_is_refused_without_modification() {
    let receiver = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    fs::create_dir_all(sandbox.state()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&sandbox.state(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    let sentinel = sandbox.state().join("do-not-touch");
    fs::write(&sentinel, b"kept").unwrap();

    let output = run_stdin(sandbox.command(30), &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(1), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "failed");
    assert_eq!(fs::read(&sentinel).unwrap(), b"kept");
    assert!(receiver.requests().is_empty(), "no request was made");
}

#[cfg(unix)]
#[test]
fn a_symlinked_state_directory_is_refused_without_touching_its_target() {
    use std::os::unix::fs::{symlink, PermissionsExt};

    let receiver = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    let target = sandbox.path().join("state-target");
    fs::create_dir_all(&target).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
    let sentinel = target.join("do-not-touch");
    fs::write(&sentinel, b"kept").unwrap();
    symlink(&target, sandbox.state()).unwrap();

    let output = run_stdin(sandbox.command(30), &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(1), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "failed");
    assert_eq!(fs::read(&sentinel).unwrap(), b"kept");
    assert!(receiver.requests().is_empty(), "no request was made");
}

/// The receiver's 401 is an authentication failure, not a pending queue.
#[test]
fn a_rejected_session_exits_as_unauthorized() {
    let receiver = FakeHistory::start(Behaviour {
        status: Some(401),
        ..Default::default()
    });
    let sandbox = Sandbox::new();
    sandbox.claude_session("revoked", 3);
    let output = run_stdin(sandbox.command(30), &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(2), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "unauthorized");
}

/// A pushed teardown session is fixed to this invocation. A 401 must not load
/// or retry a different user's stage credential from the shared auth layout.
#[test]
fn a_rejected_fixed_session_is_not_reloaded_or_refreshed() {
    let receiver = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    sandbox.claude_session("initial", 1);
    let first = run_stdin(sandbox.command(30), &session(&receiver.base_url));
    assert_eq!(first.status.code(), Some(0), "{}", diagnose(&first));

    let digest = format!("{:x}", Sha256::digest(receiver.base_url.as_bytes()));
    let stages = sandbox.state().join("stages");
    fs::create_dir_all(&stages).unwrap();
    let stored_token = "rth_at_stored_session_must_not_be_used";
    fs::write(
        stages.join(format!("{}.auth.json", &digest[..16])),
        json!({
            "base_url": receiver.base_url,
            "access_token": stored_token,
            "access_token_expires_at": "2099-01-01T00:00:00Z",
            "refresh_token": "rth_rt_stored_session_must_not_be_used",
            "org_id": "org_flush",
            "workspace_id": "ws_flush"
        })
        .to_string(),
    )
    .unwrap();
    sandbox.claude_session("rejected-fixed", 1);
    let before = receiver.batches().len();
    receiver.behaviour.lock().unwrap().status = Some(401);
    let output = run_stdin(sandbox.command(30), &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(2), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "unauthorized");
    let attempts = &receiver.batches()[before..];
    assert_eq!(
        attempts.len(),
        1,
        "fixed session was attempted exactly once"
    );
    let expected = format!("Bearer {TOKEN}");
    assert_eq!(
        attempts[0].authorization.as_deref(),
        Some(expected.as_str())
    );
    assert!(!attempts[0].body.contains(stored_token));
}

/// A receiver conflict blocks the generation: exit 4, not a retry loop.
#[test]
fn a_conflict_exits_as_blocked() {
    let receiver = FakeHistory::start(Behaviour {
        status: Some(409),
        error_code: Some("delivery_conflict"),
        ..Default::default()
    });
    let sandbox = Sandbox::new();
    sandbox.claude_session("conflicted", 3);
    let output = run_stdin(sandbox.command(30), &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(4), "{}", diagnose(&output));
    assert_eq!(summary(&output)["exit_reason"], "blocked");
}

/// A 409 without the receiver's typed conflict code is not its verdict, so
/// it is retried until the deadline instead of blocking the generation.
#[test]
fn an_untyped_conflict_is_retried_until_the_deadline() {
    let receiver = FakeHistory::start(Behaviour {
        status: Some(409),
        ..Default::default()
    });
    let sandbox = Sandbox::new();
    sandbox.claude_session("untyped-conflict", 3);
    let output = run_stdin(sandbox.command(4), &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(3), "{}", diagnose(&output));
    let summary = summary(&output);
    assert_eq!(summary["exit_reason"], "deadline");
    assert!(summary["pending_records"].as_i64().unwrap() > 0);
    assert!(!receiver.batches().is_empty(), "delivery was attempted");
}

/// (d) The flush talks to RelayHistory only: no Cloud identity, bridge or
/// schedule lookup, even with a Cloud API configured.
#[test]
fn a_flush_makes_no_cloud_request() {
    let receiver = FakeHistory::start(Behaviour::default());
    let cloud = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    sandbox.claude_session("no-cloud", 3);
    let mut command = sandbox.command(60);
    command.env("CLOUD_API_URL", format!("{}/cloud", cloud.base_url));
    let output = run_stdin(command, &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(0), "{}", diagnose(&output));
    assert!(cloud.requests().is_empty(), "Cloud was never asked");
    let requests = receiver.requests();
    assert!(!requests.is_empty());
    assert!(requests
        .iter()
        .all(|request| !request.path.starts_with("/cloud")));
    // The push-only session has no refresh token to spend.
    assert!(requests
        .iter()
        .all(|request| request.path != "/v1/auth/token/refresh"));
}

/// (e) The token never reaches argv, stdout, stderr or anything left on
/// disk, the session file is consumed, and a token offered on argv or in the
/// environment is refused.
#[test]
fn the_token_is_never_exposed_and_the_session_file_is_consumed() {
    let receiver = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    sandbox.claude_session("secret", 3);
    let file = sandbox.path().join("session.json");
    let mut pushed = session(&receiver.base_url);
    // Cloud may hand back a refresh token; it is ignored and never stored.
    pushed["refreshToken"] = json!(REFRESH);
    fs::write(&file, pushed.to_string()).unwrap();
    let mut command = sandbox.command(60);
    command.arg("--session-file").arg(&file);
    let output = command.output().unwrap();
    assert_eq!(output.status.code(), Some(0), "{}", diagnose(&output));
    assert!(!file.exists(), "the session file was unlinked");
    for stream in [&output.stdout, &output.stderr] {
        let text = String::from_utf8_lossy(stream);
        assert!(!text.contains(TOKEN) && !text.contains(REFRESH), "{text}");
        assert!(!text.contains("rth_"), "{text}");
    }
    for stored in files(&sandbox.state()) {
        let bytes = fs::read(&stored).unwrap();
        for secret in [TOKEN, REFRESH] {
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes()),
                "{} holds a credential",
                stored.display()
            );
        }
    }

    // A token on argv or in the environment is refused before anything runs.
    let mut on_argv = sandbox.command(30);
    on_argv.args(["--label", TOKEN]);
    let output = run_stdin(on_argv, &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(2), "{}", diagnose(&output));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(TOKEN));
    let mut in_env = sandbox.command(30);
    in_env.env("RELAYHISTORY_ACCESS_TOKEN", TOKEN);
    let output = run_stdin(in_env, &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(2), "{}", diagnose(&output));
    let before = receiver.requests().len();
    let missing = sandbox.path().join("missing.json");
    let mut no_file = sandbox.command(30);
    no_file.arg("--session-file").arg(&missing);
    assert_eq!(no_file.output().unwrap().status.code(), Some(2));
    assert_eq!(receiver.requests().len(), before);
}

/// The pushed bearer is process memory, not recoverable state. Killing a
/// flush while a request is in flight therefore cannot strand it on disk.
#[test]
fn a_forced_teardown_leaves_no_bearer_on_disk() {
    let receiver = FakeHistory::start(Behaviour {
        delay: Duration::from_secs(10),
        ..Default::default()
    });
    let sandbox = Sandbox::new();
    sandbox.claude_session("forced", 3);
    let mut command = sandbox.command(30);
    command.arg("--session-stdin");
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(session(&receiver.base_url).to_string().as_bytes())
        .unwrap();
    wait_until(Duration::from_secs(10), || !receiver.batches().is_empty());
    child.kill().unwrap();
    child.wait().unwrap();
    for stored in files(&sandbox.state()) {
        let bytes = fs::read(&stored).unwrap();
        assert!(
            !bytes
                .windows(TOKEN.len())
                .any(|window| window == TOKEN.as_bytes()),
            "{} holds the killed process's credential",
            stored.display()
        );
    }
}

/// One state directory is one flush at a time. A contender cannot replace or
/// remove the active process's session while its delivery is in flight.
#[test]
fn concurrent_flushes_do_not_share_or_remove_a_session() {
    let receiver = FakeHistory::start(Behaviour {
        delay: Duration::from_secs(2),
        ..Default::default()
    });
    let sandbox = Sandbox::new();
    sandbox.claude_session("serialized", 3);
    let mut first = sandbox.command(30);
    first.arg("--session-stdin");
    let mut first = first.spawn().unwrap();
    first
        .stdin
        .take()
        .unwrap()
        .write_all(session(&receiver.base_url).to_string().as_bytes())
        .unwrap();
    wait_until(Duration::from_secs(10), || !receiver.batches().is_empty());

    let second = run_stdin(sandbox.command(30), &session(&receiver.base_url));
    assert_eq!(second.status.code(), Some(1), "{}", diagnose(&second));
    assert_eq!(summary(&second)["exit_reason"], "failed");

    let first = wait_for_exit(first, Duration::from_secs(15));
    assert_eq!(first.status.code(), Some(0), "{}", diagnose(&first));
    assert_eq!(summary(&first)["exit_reason"], "drained");
}

/// (f) With no usable HOME, the provider roots named by the environment are
/// still captured, existing sessions included.
#[test]
fn provider_roots_from_the_environment_are_captured_with_an_empty_home() {
    let receiver = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    sandbox.claude_session("claude-root", 2);
    sandbox.codex_session("0199a000-0000-7000-8000-00000000c0de", "codex-root-marker");
    let mut command = sandbox.command(60);
    command.env("HOME", "");
    // Windows would otherwise take the runner's own profile as the home.
    #[cfg(windows)]
    command.env_remove("USERPROFILE");
    let output = run_stdin(command, &session(&receiver.base_url));
    assert_eq!(output.status.code(), Some(0), "{}", diagnose(&output));
    let summary = summary(&output);
    assert!(summary["sessions_captured"].as_i64().unwrap() >= 2);
    assert_eq!(summary["pending_records"], 0);
    assert!(receiver.received("claude-root-1"));
    assert!(receiver.received("codex-root-marker"));
}

/// A re-flush into a fresh local store has a new origin and revision id, but
/// preserves the logical record identity, revision and payload that let the
/// downstream projection deduplicate the same history across stored origins.
#[test]
fn a_fresh_state_reflush_preserves_cross_origin_record_identity() {
    let receiver = FakeHistory::start(Behaviour::default());
    let sandbox = Sandbox::new();
    let marker = "cross-origin-dedupe";
    sandbox.claude_session(marker, 1);
    let first_state = sandbox.path().join("first-state");
    let second_state = sandbox.path().join("second-state");

    for state in [&first_state, &second_state] {
        let output = run_stdin(
            sandbox.command_with_state(30, state),
            &session(&receiver.base_url),
        );
        assert_eq!(output.status.code(), Some(0), "{}", diagnose(&output));
    }

    let matching: Vec<_> = receiver
        .batches()
        .into_iter()
        .filter_map(|request| {
            let body: Value = serde_json::from_str(&request.body).unwrap();
            let batch = &body["batch"];
            batch["records"].as_array()?.iter().find_map(|record| {
                record["payload"].to_string().contains(marker).then(|| {
                    (
                        batch["origin_id"].clone(),
                        record["record_id"].clone(),
                        record["revision"].clone(),
                        record["revision_id"].clone(),
                        record["payload"].clone(),
                    )
                })
            })
        })
        .collect();
    assert_eq!(matching.len(), 2, "one copy from each fresh state");
    assert_ne!(matching[0].0, matching[1].0, "origins are state-local");
    assert_eq!(matching[0].1, matching[1].1, "record identity is stable");
    assert_eq!(matching[0].2, matching[1].2, "source revision is stable");
    assert_ne!(matching[0].3, matching[1].3, "revision ids bind origin");
    assert_eq!(matching[0].4, matching[1].4, "payload is stable");
}
