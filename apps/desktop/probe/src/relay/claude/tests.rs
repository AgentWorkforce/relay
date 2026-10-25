use super::*;
use crate::relay::process::{claude_start_seconds, FakeProcess, FakeProcesses, StartClock};
use std::fs::File;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::UnixListener;

const SESSION: &str = "727cce8d-8074-4ea3-94a0-dea144bf8747";
const CLOUD: &str = "session_01AbCdEfGhIjKlMnOpQrStUv";
const LINUX_START: &str = "7037566";
const REF: &str = "123456abcdef";
const TRANSCRIPT: &str = include_str!("../../../tests/fixtures/injectable_replies/claude.jsonl");

fn config(dir: &Path) -> ClaudeConfig {
    ClaudeConfig {
        home: dir.join("claude"),
        executable: Some(dir.join("bin/claude")),
        app_sessions: Some(dir.join("app")),
        dirs: Default::default(),
    }
}

/// Writes `<pid>.json` into the registry, as Claude Code does on Linux.
fn record(config: &ClaudeConfig, pid: i32, extra: Value) -> PathBuf {
    let mut value = json!({
        "pid": pid, "sessionId": SESSION,
        "messagingSocketPath": format!("/run/user/1000/cc-socks/{pid}.sock"),
        "peerProtocol": 1, "procStart": LINUX_START, "cwd": "/p/relay-desktop",
        "name": "relay-desktop-f7",
    });
    for (key, field) in extra.as_object().unwrap() {
        value[key] = field.clone();
    }
    let path = config.registry().join(format!("{pid}.json"));
    std::fs::create_dir_all(config.registry()).unwrap();
    std::fs::write(&path, value.to_string()).unwrap();
    path
}

fn key(config: &ClaudeConfig, name: &str, value: Value) {
    std::fs::create_dir_all(config.registry()).unwrap();
    std::fs::write(config.registry().join(name), value.to_string()).unwrap();
}

fn table(processes: &[(i32, u64)]) -> FakeProcesses {
    let table = FakeProcesses::default();
    for (pid, start) in processes {
        table.insert(
            *pid,
            FakeProcess {
                parent: 1,
                uid: 501,
                start: *start,
                ..Default::default()
            },
        );
    }
    table
}

fn ticks() -> u64 {
    LINUX_START.parse().unwrap()
}

// MARK: Configuration

// ClaudeTerminalBridge.registryDirectory, ClaudeBridge.locateClaude and
// test_injectable.claude_home: CLAUDE_CONFIG_DIR, the override, the
// install locations in order.
#[test]
#[cfg(unix)]
fn configuration_reads_the_environment_and_the_install_locations() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let none = |_: &str| None;
    let plain = ClaudeConfig::resolve(&none, &home, &[]);
    assert_eq!(plain.home, home.join(".claude"));
    assert_eq!(plain.executable, None);
    assert_eq!(plain.registry(), home.join(".claude/sessions"));
    assert_eq!(plain.projects(), home.join(".claude/projects"));
    assert_eq!(plain.app_sessions.is_some(), cfg!(target_os = "macos"));

    let custom = |key: &str| (key == "CLAUDE_CONFIG_DIR").then(|| " ~/claude-alt ".to_string());
    assert_eq!(
        ClaudeConfig::resolve(&custom, &home, &[]).home,
        home.join("claude-alt")
    );
    let blank = |key: &str| (key == "CLAUDE_CONFIG_DIR").then(String::new);
    assert_eq!(
        ClaudeConfig::resolve(&blank, &home, &[]).home,
        home.join(".claude")
    );

    let executable = |path: &Path| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    let system = dir.path().join("usr/local/bin/claude");
    executable(&system);
    assert_eq!(
        ClaudeConfig::resolve(&none, &home, std::slice::from_ref(&system)).executable,
        Some(system.clone())
    );
    let local = home.join(".local/bin/claude");
    executable(&local);
    assert_eq!(
        ClaudeConfig::resolve(&none, &home, std::slice::from_ref(&system)).executable,
        Some(local.clone()),
        "the user's own install comes first"
    );

    let not_executable = dir.path().join("plain-file");
    std::fs::write(&not_executable, "").unwrap();
    let path = not_executable.display().to_string();
    let override_to = |key: &str| (key == "RELAY_DESKTOP_CLAUDE").then(|| path.clone());
    assert_eq!(
        ClaudeConfig::resolve(&override_to, &home, std::slice::from_ref(&system)).executable,
        None,
        "an override that cannot run finds nothing rather than another claude"
    );
    let chosen = system.display().to_string();
    let override_ok = |key: &str| (key == "RELAY_DESKTOP_CLAUDE").then(|| chosen.clone());
    assert_eq!(
        ClaudeConfig::resolve(&override_ok, &home, &[]).executable,
        Some(system)
    );
}

// MARK: Registry and liveness

// test_injectable.RegistryTests.test_decodes_a_linux_registry_record.
#[test]
fn decodes_a_linux_registry_record() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let path = record(&config, 42, json!({}));
    let session = TerminalSession::decode(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(
        (
            session.pid,
            session.proc_start.as_deref(),
            session.peer_protocol
        ),
        (42, Some(LINUX_START), 1)
    );
    assert_eq!(session.cwd.as_deref(), Some("/p/relay-desktop"));
    assert_eq!(session.display_name(), "relay-desktop-f7");
    assert!(TerminalSession::decode(
        br#"{"pid": 1, "sessionId": "not-a-uuid", "messagingSocketPath": "/s"}"#
    )
    .is_none());
    assert!(TerminalSession::decode(b"not json").is_none());
    assert!(TerminalSession::decode(
        format!(r#"{{"pid": 0, "sessionId": "{SESSION}", "messagingSocketPath": "/s"}}"#)
            .as_bytes()
    )
    .is_none());
    assert!(TerminalSession::decode(
        format!(r#"{{"pid": 1, "sessionId": "{SESSION}", "messagingSocketPath": ""}}"#).as_bytes()
    )
    .is_none());
    // A numeric start, an absent protocol, and unknown fields.
    let numeric = TerminalSession::decode(
        format!(
            r#"{{"pid": 7, "sessionId": "{SESSION}", "messagingSocketPath": "/s", "procStart": 7037566, "new": true}}"#
        )
        .as_bytes(),
    )
    .unwrap();
    assert_eq!(numeric.proc_start.as_deref(), Some(LINUX_START));
    assert_eq!(numeric.peer_protocol, 0);
    assert!(!numeric.speaks_known_protocol());
    assert_eq!(numeric.display_name(), SESSION);
}

// test_injectable.RegistryTests.test_a_recycled_pid_is_not_alive.
#[test]
fn a_recycled_pid_is_not_alive() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    record(&config, 42, json!({}));
    assert!(terminal_sessions(&config, &table(&[(42, 1)])).is_empty());
    assert!(terminal_sessions(&config, &table(&[])).is_empty());
    let own = terminal_sessions(&config, &table(&[(42, ticks())]));
    assert_eq!(own.len(), 1);
    assert!(own[0].can_reply());
}

// OutboundProcessDiscoveryTests.testClaudeDiscoveryRequiresRegistryAndKernelStartTimesToMatch,
// as far as discovery goes: macOS records whole seconds of a microsecond
// kernel clock; a session without a recorded start is found but can never
// be replied from.
#[test]
fn claude_discovery_requires_registry_and_kernel_start_times_to_match() {
    let recorded = "Sun Sep 27 16:00:00 2026";
    let seconds = claude_start_seconds(recorded).unwrap();
    let table = FakeProcesses {
        clock: Some(StartClock::Micros),
        ..Default::default()
    };
    table.insert(
        500,
        FakeProcess {
            parent: 1,
            uid: 501,
            start: seconds * 1_000_000 + 321_000,
            ..Default::default()
        },
    );
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());

    record(&config, 500, json!({"procStart": recorded}));
    let matching = terminal_sessions(&config, &table);
    assert_eq!(matching.len(), 1);
    assert_eq!(matching[0].pid, 500);
    assert!(matching[0].can_reply());

    record(
        &config,
        500,
        json!({"procStart": "Sun Sep 27 16:00:01 2026"}),
    );
    assert!(terminal_sessions(&config, &table).is_empty());

    record(&config, 500, json!({"procStart": null}));
    let missing = terminal_sessions(&config, &table);
    assert_eq!(missing.len(), 1);
    assert!(!missing[0].can_reply());
}

// test_injectable.RegistryTests.test_lists_live_sessions_and_reads_the_matching_key.
#[test]
fn lists_live_sessions_newest_first_and_reads_the_matching_key() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let older = record(
        &config,
        43,
        json!({"sessionId": "11111111-2222-3333-4444-555555555555", "procStart": "1"}),
    );
    let newer = record(&config, 42, json!({}));
    let at = |seconds| SystemTime::UNIX_EPOCH + Duration::from_secs(seconds);
    File::options()
        .write(true)
        .open(&older)
        .unwrap()
        .set_modified(at(1_000))
        .unwrap();
    File::options()
        .write(true)
        .open(&newer)
        .unwrap()
        .set_modified(at(2_000))
        .unwrap();
    std::fs::write(config.registry().join("notes.txt"), "{}").unwrap();
    key(
        &config,
        "42.aa.key",
        json!({"peerToken": "old", "procStart": "1"}),
    );
    key(
        &config,
        "42.bb.key",
        json!({"peerToken": "tok", "procStart": LINUX_START}),
    );
    key(&config, "420.cc.key", json!({"peerToken": "other-pid"}));

    let table = table(&[(42, ticks()), (43, 1)]);
    let sessions = terminal_sessions(&config, &table);
    assert_eq!(
        sessions.iter().map(|s| s.pid).collect::<Vec<_>>(),
        vec![42, 43]
    );
    assert_eq!(sessions[0].updated_at_ms, Some(2_000_000));
    assert_eq!(peer_token(&config, &sessions[0]).as_deref(), Some("tok"));
    assert_eq!(peer_token(&config, &sessions[1]), None);
    assert_eq!(
        terminal_session(&config, &table, SESSION).map(|s| s.pid),
        Some(42)
    );
    // A key without a recorded start is accepted when it is the pid's only
    // key.
    key(&config, "43.dd.key", json!({"peerToken": "any"}));
    assert_eq!(peer_token(&config, &sessions[1]).as_deref(), Some("any"));
    // Review: a leftover start-less key never wins over the matching one,
    // however the files sort.
    key(&config, "42.00.key", json!({"peerToken": "stale"}));
    assert_eq!(peer_token(&config, &sessions[0]).as_deref(), Some("tok"));
    // With no matching key, two candidates are ambiguous: none is used.
    key(&config, "43.ee.key", json!({"peerToken": "also"}));
    assert_eq!(peer_token(&config, &sessions[1]), None);
    // No registry at all.
    let empty = ClaudeConfig {
        home: dir.path().join("missing"),
        ..config.clone()
    };
    assert!(terminal_sessions(&empty, &table).is_empty());
}

// A registry file left as a complete record followed by stray bytes (an
// interrupted in-place rewrite) still names its session.
#[test]
fn a_record_with_trailing_bytes_is_still_discovered() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let path = record(&config, 42, json!({}));
    let mut data = std::fs::read(&path).unwrap();
    data.extend_from_slice(b"}");
    std::fs::write(&path, &data).unwrap();
    assert!(serde_json::from_slice::<Value>(&data).is_err());
    key(
        &config,
        "42.k.key",
        json!({"peerToken": "tok", "procStart": LINUX_START}),
    );
    let mut corrupt_key = json!({"peerToken": "tok", "procStart": LINUX_START}).to_string();
    corrupt_key.push_str("}\n");
    std::fs::write(config.registry().join("42.k.key"), corrupt_key).unwrap();

    let table = table(&[(42, ticks())]);
    let found = registry(&config, &table);
    assert_eq!(
        found
            .sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        vec![SESSION]
    );
    assert!(found.unreadable.is_empty());
    assert_eq!(
        peer_token(&config, &found.sessions[0]).as_deref(),
        Some("tok")
    );
    assert_eq!(
        discover(&config, &table)
            .iter()
            .map(|s| s.target.id.as_str())
            .collect::<Vec<_>>(),
        vec![SESSION]
    );
}

// A registry file whose record itself does not parse is reported, but only
// when a key of that pid records the running process's start: a leftover
// file of an exited session, or of an earlier process with a recycled pid,
// is not.
#[test]
fn an_unparseable_record_of_a_running_session_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let path = record(&config, 42, json!({}));
    let data = std::fs::read(&path).unwrap();
    std::fs::write(&path, &data[..data.len() / 2]).unwrap();
    let table = table(&[(42, ticks())]);

    // No key: nothing ties the file to the running process.
    assert_eq!(registry(&config, &table), Registry::default());
    // A key of an earlier process with this pid.
    key(
        &config,
        "42.old.key",
        json!({"peerToken": "old", "procStart": "1"}),
    );
    assert_eq!(registry(&config, &table), Registry::default());

    key(
        &config,
        "42.k.key",
        json!({"peerToken": "tok", "procStart": LINUX_START}),
    );
    let found = registry(&config, &table);
    assert!(found.sessions.is_empty());
    assert_eq!(found.unreadable.len(), 1);
    assert_eq!(found.unreadable[0].path, path);
    assert_eq!(found.unreadable[0].pid, 42);
    assert!(
        found.unreadable[0].error.contains("EOF"),
        "{}",
        found.unreadable[0].error
    );
    assert!(discover(&config, &table).is_empty());

    // The process has exited.
    assert_eq!(registry(&config, &self::table(&[])), Registry::default());
}

// MARK: Inbox delivery

// test_injectable.RegistryTests.test_frames_are_the_auth_line_then_the_message.
#[test]
fn frames_are_the_auth_line_then_the_message() {
    let frames = peer_frames("tok", "m1", "hello").unwrap();
    let lines: Vec<&[u8]> = frames.bytes.split(|b| *b == b'\n').collect();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[2], b"");
    assert_eq!(frames.auth_len, lines[0].len() + 1);
    let auth: Value = serde_json::from_slice(lines[0]).unwrap();
    assert_eq!(auth, json!({"type": "auth", "token": "tok"}));
    let body: Value = serde_json::from_slice(lines[1]).unwrap();
    assert_eq!(
        (
            &body["type"],
            &body["msg_id"],
            &body["priority"],
            &body["message"]
        ),
        (
            &json!("user"),
            &json!("m1"),
            &json!("next"),
            &json!({"role": "user", "content": "hello"})
        )
    );
    let uuid = body["uuid"].as_str().unwrap();
    assert!(is_uuid(uuid) && uuid == uuid.to_uppercase());
    assert!(peer_frames("tok", "m1", &"x".repeat(1_000_001)).is_err());
}

/// An in-process inbox: accepts one connection and returns what it read.
#[cfg(unix)]
fn inbox(path: &Path) -> std::thread::JoinHandle<Vec<u8>> {
    let listener = UnixListener::bind(path).unwrap();
    std::thread::spawn(move || {
        let (mut connection, _) = listener.accept().unwrap();
        let mut data = Vec::new();
        connection.read_to_end(&mut data).unwrap();
        data
    })
}

// test_injectable.RegistryTests.test_sends_to_the_session_inbox_socket.
#[test]
#[cfg(unix)]
fn sends_to_the_session_inbox_socket() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let socket = dir.path().join("s.sock");
    let received = inbox(&socket);
    record(&config, 42, json!({"messagingSocketPath": socket}));
    key(&config, "42.k.key", json!({"peerToken": "tok"}));
    let outcome = send_to_terminal(&config, &table(&[(42, ticks())]), SESSION, "m1", "hello");
    assert_eq!(outcome, InjectOutcome::Delivered);
    let data = received.join().unwrap();
    let lines: Vec<Value> = data
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap())
        .collect();
    assert_eq!(lines[0]["token"], "tok");
    assert_eq!(lines[1]["message"]["content"], "hello");
    assert_eq!(lines[1]["msg_id"], "m1");
}

// test_injectable.RegistryTests.test_a_session_that_is_gone_is_retryable:
// a session that is not running leaves the message waiting.
#[test]
fn a_session_that_is_gone_waits() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let table = table(&[]);
    assert!(matches!(
        send_to_terminal(&config, &table, SESSION, "m1", "hello"),
        InjectOutcome::Waiting(_)
    ));
    record(&config, 42, json!({}));
    assert!(matches!(
        send_to_terminal(&config, &table, SESSION, "m1", "hello"),
        InjectOutcome::Waiting(_)
    ));
    assert_eq!(
        send_to_terminal(&config, &table, "--print", "m1", "hello"),
        InjectOutcome::Refused("invalid session id".into())
    );
}

// ClaudeTerminalBridge.send: an unknown protocol, a missing key, an inbox
// that cannot be reached and an oversized message send nothing, so are
// retried; the token never appears in a reason.
#[test]
fn nothing_sent_is_retried() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let table = table(&[(42, ticks())]);
    let socket = dir.path().join("absent.sock");
    record(
        &config,
        42,
        json!({"peerProtocol": 2, "messagingSocketPath": socket}),
    );
    let unknown = send_to_terminal(&config, &table, SESSION, "m1", "hi");
    assert!(matches!(&unknown, InjectOutcome::Retry(r) if r.contains("peer protocol 2")));

    record(&config, 42, json!({"messagingSocketPath": socket}));
    let no_key = send_to_terminal(&config, &table, SESSION, "m1", "hi");
    assert!(matches!(&no_key, InjectOutcome::Retry(r) if r.contains("inbox key")));

    key(&config, "42.k.key", json!({"peerToken": "secret-token"}));
    let unreachable = send_to_terminal(&config, &table, SESSION, "m1", "hi");
    assert!(
        matches!(&unreachable, InjectOutcome::Retry(r) if r.contains("could not reach") && !r.contains("secret-token"))
    );

    let too_long = send_to_terminal(&config, &table, SESSION, "m1", &"x".repeat(1_000_001));
    assert!(matches!(&too_long, InjectOutcome::Retry(r) if r.contains("past the")));
}

// ClaudeTerminalError.writeFailed / ClaudeTerminalInDoubt: the connection
// broke after part of the message was written, so it may have arrived.
#[test]
#[cfg(unix)]
fn a_connection_broken_mid_message_is_in_doubt() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let socket = dir.path().join("s.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let reader = std::thread::spawn(move || {
        let (mut connection, _) = listener.accept().unwrap();
        let mut seen = Vec::new();
        let mut buffer = [0u8; 4096];
        while !seen.contains(&b'\n') {
            let count = connection.read(&mut buffer).unwrap();
            assert!(count > 0);
            seen.extend_from_slice(&buffer[..count]);
        }
        // Drops the connection after the auth line.
    });
    record(&config, 42, json!({"messagingSocketPath": socket}));
    key(&config, "42.k.key", json!({"peerToken": "tok"}));
    let outcome = send_to_terminal(
        &config,
        &table(&[(42, ticks())]),
        SESSION,
        "m1",
        &"x".repeat(900_000),
    );
    reader.join().unwrap();
    assert!(
        matches!(&outcome, InjectOutcome::InDoubt(r) if r.contains("broke while sending")),
        "{outcome:?}"
    );
}

// MARK: Claude app sessions

// ClaudeCloudSessionTests.testAcceptsTaggedSessionIDs and
// testRefusesAnythingThatIsNotATaggedID: only a tagged id ever reaches
// `claude --cloud`.
#[test]
fn only_a_tagged_session_id_reaches_the_command_line() {
    let refused = [
        "".to_string(),
        "session_".into(),
        "session_short".into(),
        "fix the login bug".into(),
        "--dangerously-skip-permissions".into(),
        "session_01AbCdEfGh --model x".into(),
        "session_01AbCdEfGh\n--print".into(),
        "session_01AbCdEfGh/../x".into(),
        "https://claude.ai/code/session_01AbCdEfGhIjKlMn".into(),
        "thread_01AbCdEfGhIjKlMn".into(),
        format!("session_{}", "a".repeat(65)),
        "session_01AbCdEfGhé".into(),
    ];
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let runner = FakeRunner::new(help_ok(), sent_json());
    for value in &refused {
        assert_eq!(
            send_to_cloud_with(&config, &runner, value, "hi"),
            InjectOutcome::Refused("invalid session id".into()),
            "accepted {value:?}"
        );
    }
    assert!(runner.calls().is_empty());
    for accepted in [CLOUD, "cse_01AbCdEfGhIjKlMnOpQrStUv"] {
        assert_eq!(
            send_to_cloud_with(&config, &runner, accepted, "hi"),
            InjectOutcome::Delivered
        );
    }
}

// ClaudeCloudSessionTests.testDecodesTheDesktopAppsSpacesFile.
#[test]
fn decodes_the_desktop_apps_spaces_file() {
    let json = br#"{"entries": [
      {"sessionId": "session_01AbCdEfGhIjKlMnOpQrStUv", "folders": ["/Users/me/Projects/pear"], "memoryEnabled": true, "somethingNew": 1},
      {"sessionId": "cse_01AbCdEfGhIjKlMnOpQrStUv"}
    ]}"#;
    let sessions = decode_spaces(json).unwrap();
    assert_eq!(
        sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "session_01AbCdEfGhIjKlMnOpQrStUv",
            "cse_01AbCdEfGhIjKlMnOpQrStUv"
        ]
    );
    assert_eq!(sessions[0].folders, vec!["/Users/me/Projects/pear"]);
    assert_eq!(sessions[0].display_name(), "pear");
    assert!(sessions[1].folders.is_empty());
    assert_eq!(sessions[1].display_name(), "cse_01AbCdEfGhIjKlMnOpQrStUv");
}

// ClaudeCloudSessionTests.testSkipsEntriesWithoutAValidID.
#[test]
fn skips_entries_without_a_valid_id() {
    let json = br#"{"entries": [{"sessionId": "not an id", "folders": []}, {"folders": ["/x"]}, {"sessionId": "session_01AbCdEfGhIjKlMn"}]}"#;
    let sessions = decode_spaces(json).unwrap();
    assert_eq!(
        sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["session_01AbCdEfGhIjKlMn"]
    );
}

// ClaudeCloudSessionTests.testAFileOfAnotherShapeThrows.
#[test]
fn a_file_of_another_shape_is_an_error() {
    assert!(decode_spaces(b"[]").is_err());
    assert!(decode_spaces(b"not json").is_err());
}

// ClaudeBridge.sessions: every account and organization, deduplicated,
// hidden folders and unreadable files skipped.
#[test]
fn cloud_sessions_are_read_across_accounts() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let app = config.app_sessions.clone().unwrap();
    let spaces = |relative: &str, body: &str| {
        let folder = app.join(relative);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("remote-session-spaces.json"), body).unwrap();
    };
    spaces(
        "acct-a/org-1",
        &format!(r#"{{"entries": [{{"sessionId": "{CLOUD}", "folders": ["/w/pear"]}}]}}"#),
    );
    spaces(
        "acct-b/org-2",
        &format!(
            r#"{{"entries": [{{"sessionId": "{CLOUD}"}}, {{"sessionId": "cse_01AbCdEfGhIjKlMn"}}]}}"#
        ),
    );
    spaces("acct-b/org-3", "{broken");
    spaces(
        ".hidden/org",
        r#"{"entries": [{"sessionId": "session_HiddenHiddenHidden"}]}"#,
    );
    let sessions = cloud_sessions(&config);
    assert_eq!(
        sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        vec![CLOUD, "cse_01AbCdEfGhIjKlMn"]
    );
    assert_eq!(sessions[0].folders, vec!["/w/pear"]);
    let without_app = ClaudeConfig {
        app_sessions: None,
        ..config
    };
    assert!(cloud_sessions(&without_app).is_empty());
}

// ClaudeSendCommandTests.testArgumentsAskForTheDocumentedJSONResult.
#[test]
fn arguments_ask_for_the_documented_json_result() {
    assert_eq!(
        cloud_arguments(CLOUD, true),
        vec!["--print", "--cloud", CLOUD, "--output-format", "json"]
    );
}

// ClaudeSendCommandTests.testACLIThatCannotParseTheFlagIsNeverAskedForIt.
#[test]
fn a_cli_that_cannot_parse_the_flag_is_never_asked_for_it() {
    assert_eq!(
        cloud_arguments(CLOUD, false),
        vec!["--print", "--cloud", CLOUD]
    );
}

// ClaudeSendCommandTests.testJSONResultIsAskedForOnlyWhenTheCLIAdvertisesBothFlags.
#[test]
fn json_result_is_asked_for_only_when_the_cli_advertises_both_flags() {
    assert!(advertises_json_result(
        "  --cloud [description|session_id|url]  Create a cloud session\n  --output-format <format>              Output format"
    ));
    assert!(!advertises_json_result(
        "  --cloud [description]  Create a cloud session"
    ));
    assert!(!advertises_json_result(
        "  --output-format <format>  Output format"
    ));
    assert!(!advertises_json_result(""));
}

// ClaudeSendCommandTests.testTheJSONResultDecidesASuccessfulSend.
#[test]
fn the_json_result_decides_a_successful_send() {
    let output = r#"{"ok":true,"session_id":"session_01AbCdEfGhIjKlMnOpQrStUv","url":"https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv?from=cli&m=0"}"#;
    assert_eq!(
        send_outcome(0, output, ""),
        SendOutcome::Sent {
            url: Some(
                "https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv?from=cli&m=0".into()
            )
        }
    );
}

// ClaudeSendCommandTests.testAnUnknownFieldDoesNotSpoilASuccessfulSend.
#[test]
fn an_unknown_field_does_not_spoil_a_successful_send() {
    let output = r#"{"ok":true,"session_id":"s","url":"u","added_later":{"x":1}}"#;
    assert_eq!(
        send_outcome(0, output, ""),
        SendOutcome::Sent {
            url: Some("u".into())
        }
    );
}

// ClaudeSendCommandTests.testTheJSONResultDecidesAFailedSendEvenWithTextAlongside.
#[test]
fn the_json_result_decides_a_failed_send_even_with_text_alongside() {
    let output = r#"{"ok":false,"session_id":"session_x","error":"invalid session ID: must be a cse_… or session_… tagged ID"}"#;
    let errors = "Error: failed to send message to cloud session session_x: invalid session ID: must be a cse_… or session_… tagged ID";
    assert_eq!(
        send_outcome(1, output, errors),
        SendOutcome::Refused("invalid session ID: must be a cse_… or session_… tagged ID".into())
    );
}

// ClaudeSendCommandTests.testAConfigurationErrorPrintsNoJSONAndIsStillRead.
#[test]
fn a_configuration_error_prints_no_json_and_is_still_read() {
    let errors = "Error: --cloud \"not-an-id\" is not a cloud session ID or URL.\nWith --print, --cloud sends the prompt to an existing cloud session:";
    assert_eq!(
        send_outcome(1, "", errors),
        SendOutcome::Refused("--cloud \"not-an-id\" is not a cloud session ID or URL.".into())
    );
}

// ClaudeSendCommandTests.testAnOlderCLIsConfirmationLineStillCounts.
#[test]
fn an_older_clis_confirmation_line_still_counts() {
    let output = "Sent to cloud session.\nSession ID: session_01AbCdEfGhIjKlMnOpQrStUv\nView: https://claude.ai/code/x\n";
    assert_eq!(send_outcome(0, output, ""), SendOutcome::Sent { url: None });
}

// ClaudeSendCommandTests.testExitZeroWithNoResultAtAllIsNotSent.
#[test]
fn exit_zero_with_no_result_at_all_is_not_sent() {
    assert_eq!(
        send_outcome(0, "", ""),
        SendOutcome::Failed("claude exited with code 0".into())
    );
}

// ClaudeSendCommandTests.testTheOldConfirmationLineWithAFailingExitIsNotSent.
#[test]
fn the_old_confirmation_line_with_a_failing_exit_is_not_sent() {
    assert_eq!(
        send_outcome(1, "Sent to cloud session.", "Error: boom"),
        SendOutcome::Failed("boom".into())
    );
}

// ClaudeSendCommandTests.testPermanentRefusals.
#[test]
fn permanent_refusals() {
    for message in [
        "Error: failed to send message to cloud session session_x: invalid session ID: must be a cse_… or session_… tagged ID",
        "Error: cloud session session_x is archived and cannot accept new messages",
        "Error: Attaching to an existing cloud session is not enabled for your account.",
        "Error: --cloud nope is not a cloud session ID or URL.",
    ] {
        assert!(
            matches!(send_outcome(1, "", message), SendOutcome::Refused(_)),
            "not refused: {message}"
        );
    }
}

// ClaudeSendCommandTests.testOtherErrorsMayBeRetried.
#[test]
fn other_errors_may_be_retried() {
    assert_eq!(
        send_outcome(
            1,
            "",
            "\nError: failed to send message to cloud session session_x: network timeout\nmore detail\n"
        ),
        SendOutcome::Failed("failed to send message to cloud session session_x: network timeout".into())
    );
    assert_eq!(
        send_outcome(
            1,
            r#"{"ok":false,"session_id":"s","error":"upstream is busy"}"#,
            ""
        ),
        SendOutcome::Failed("upstream is busy".into())
    );
}

// ClaudeSendCommandTests.testErrorDetailIsCapped.
#[test]
fn error_detail_is_capped() {
    let long = "x".repeat(5_000);
    let SendOutcome::Failed(from_json) =
        send_outcome(1, &format!(r#"{{"ok":false,"error":"{long}"}}"#), "")
    else {
        panic!("expected a failure");
    };
    assert_eq!(from_json.chars().count(), 300);
    let SendOutcome::Failed(detail) = send_outcome(1, "", &long) else {
        panic!("expected a failure");
    };
    assert_eq!(detail.chars().count(), 300);
}

/// One recorded run: arguments, standard input, timeout.
type Call = (Vec<String>, Vec<u8>, Duration);

/// A command runner that answers from a script and records every call.
struct FakeRunner {
    help: RunOutcome,
    send: RunOutcome,
    calls: Mutex<Vec<Call>>,
}

impl FakeRunner {
    fn new(help: RunOutcome, send: RunOutcome) -> FakeRunner {
        FakeRunner {
            help,
            send,
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

impl CommandRunner for FakeRunner {
    fn run(&self, _: &Path, arguments: &[String], input: &[u8], timeout: Duration) -> RunOutcome {
        self.calls
            .lock()
            .unwrap()
            .push((arguments.to_vec(), input.to_vec(), timeout));
        if arguments == ["--help"] {
            self.help.clone()
        } else {
            self.send.clone()
        }
    }
}

fn exited(code: i32, stdout: &str, stderr: &str) -> RunOutcome {
    RunOutcome::Exited {
        code,
        stdout: stdout.into(),
        stderr: stderr.into(),
    }
}

fn help_ok() -> RunOutcome {
    exited(0, "  --cloud <id>\n  --output-format <format>\n", "")
}

fn sent_json() -> RunOutcome {
    exited(
        0,
        &format!(r#"{{"ok":true,"session_id":"{CLOUD}","url":"u"}}"#),
        "",
    )
}

// ClaudeBridge.send and supportsJSONResult: the CLI's --help is read once
// per build, the text goes on standard input, and a confirmed send is
// delivered.
#[test]
fn a_cloud_send_puts_the_text_on_standard_input() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let runner = FakeRunner::new(help_ok(), sent_json());
    assert_eq!(
        send_to_cloud_with(&config, &runner, CLOUD, "--flag-looking text"),
        InjectOutcome::Delivered
    );
    assert_eq!(
        send_to_cloud_with(&config, &runner, CLOUD, "again"),
        InjectOutcome::Delivered
    );
    let calls = runner.calls();
    assert_eq!(calls.len(), 3, "--help is asked once");
    assert_eq!(calls[0].0, vec!["--help"]);
    assert_eq!(
        calls[1].0,
        vec!["--print", "--cloud", CLOUD, "--output-format", "json"]
    );
    assert_eq!(calls[1].1, b"--flag-looking text");
    assert_eq!(calls[1].2, SEND_TIMEOUT);
    assert_eq!(calls[2].1, b"again");
}

// ClaudeBridge.supportsJSONResult: a probe that fails is not remembered and
// the send falls back to the confirmation line.
#[test]
fn a_cli_whose_help_fails_is_sent_to_without_the_json_result() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let runner = FakeRunner::new(
        exited(1, "", "boom"),
        exited(0, "Sent to cloud session.\n", ""),
    );
    assert_eq!(
        send_to_cloud_with(&config, &runner, CLOUD, "hi"),
        InjectOutcome::Delivered
    );
    assert_eq!(
        send_to_cloud_with(&config, &runner, CLOUD, "hi"),
        InjectOutcome::Delivered
    );
    let calls = runner.calls();
    let arguments: Vec<&Vec<String>> = calls.iter().map(|c| &c.0).collect();
    assert_eq!(
        arguments,
        vec![
            &vec!["--help".to_string()],
            &cloud_arguments(CLOUD, false),
            &vec!["--help".to_string()],
            &cloud_arguments(CLOUD, false),
        ]
    );
}

// InjectableAgents.inject for .claudeCloud: a timeout is in doubt; a
// refusal, a failure, or a CLI that is missing or will not start sent
// nothing.
#[test]
fn cloud_send_outcomes() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let outcome = |send: RunOutcome| {
        send_to_cloud_with(&config, &FakeRunner::new(help_ok(), send), CLOUD, "hi")
    };
    assert_eq!(
        outcome(RunOutcome::TimedOut),
        InjectOutcome::InDoubt("claude did not answer in time".into())
    );
    assert_eq!(
        outcome(exited(1, "", "Error: cloud session x is archived")),
        InjectOutcome::Refused("cloud session x is archived".into())
    );
    assert_eq!(
        outcome(exited(1, "", "Error: network timeout")),
        InjectOutcome::Retry("network timeout".into())
    );
    assert_eq!(
        outcome(RunOutcome::NotStarted("No such file".into())),
        InjectOutcome::Retry("the claude command line is not installed".into())
    );
    let runner = FakeRunner::new(help_ok(), sent_json());
    let without = ClaudeConfig {
        executable: None,
        ..config.clone()
    };
    assert_eq!(
        send_to_cloud_with(&without, &runner, CLOUD, "hi"),
        InjectOutcome::Retry("the claude command line is not installed".into())
    );
    assert!(runner.calls().is_empty());
}

// MARK: Discovery and final answers

// InjectableAgents.discover (Claude parts): terminal sessions are live now
// under their own name; app sessions are titled by their first folder.
#[test]
fn discovers_terminal_and_app_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    record(&config, 42, json!({"name": ""}));
    let folder = config.app_sessions.clone().unwrap().join("acct/org");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("remote-session-spaces.json"),
        format!(r#"{{"entries": [{{"sessionId": "{CLOUD}", "folders": ["/w/pear"]}}]}}"#),
    )
    .unwrap();
    let sessions = discover(&config, &table(&[(42, ticks())]));
    assert_eq!(sessions.len(), 2);
    assert_eq!(
        sessions[0].target,
        Target::new(SessionKind::ClaudeTerminal, SESSION)
    );
    assert_eq!(sessions[0].title, "relay-desktop");
    assert_eq!(sessions[0].directory.as_deref(), Some("/p/relay-desktop"));
    assert!(sessions[0].live && sessions[0].updated_at_ms.is_some());
    assert_eq!(
        sessions[1].target,
        Target::new(SessionKind::ClaudeCloud, CLOUD)
    );
    assert_eq!(sessions[1].title, "pear");
    assert_eq!(sessions[1].holder, None);
    assert_eq!(sessions[1].directory.as_deref(), Some("/w/pear"));
    assert!(sessions[1].live && sessions[1].updated_at_ms.is_none());
}

// SessionOpeningTests.testHeldSessionIsNotOfferedTheDesktopHandoff: what
// holds a discovered session, from the entry's own kind — the field
// Claude Code's handoff reads — and not from the process's command, which
// a hosted chat's structured pipe would answer wrongly.
#[test]
fn discovery_names_what_holds_a_terminal_session() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let holder_of = |kind: Value, arguments: &[&str]| {
        record(&config, 42, json!({"kind": kind, "name": "sdk-pipeline"}));
        let table = FakeProcesses::default();
        table.insert(
            42,
            FakeProcess {
                parent: 1,
                uid: 501,
                start: ticks(),
                arguments: arguments.iter().map(|a| a.to_string()).collect(),
                has_terminal: false,
                ..Default::default()
            },
        );
        discover(&config, &table)[0].holder
    };
    // A chat hosted in another app runs a structured pipe, has no
    // terminal of its own and may be named `sdk-…`; it is still a session
    // a person types in, and its entry says so.
    assert_eq!(
        holder_of(
            json!("interactive"),
            &["claude", "--output-format", "stream-json"]
        ),
        Some(SessionHolder::Interactive)
    );
    // An entry too old to record a kind keeps what works.
    for unsaid in [json!(null), json!("")] {
        assert_eq!(
            holder_of(unsaid, &["claude"]),
            Some(SessionHolder::Interactive)
        );
    }
    // Only an entry that calls itself something else is headless, however
    // ordinary the command it runs looks.
    assert_eq!(
        holder_of(json!("agent"), &["claude", "--model", "sonnet"]),
        Some(SessionHolder::Background)
    );
}

// InjectableAgents.finalAnswer (.claudeTerminal): Claude Code's folder for
// a working directory.
#[test]
fn project_folders_replace_everything_but_ascii_letters_and_digits() {
    assert_eq!(project_folder("/p/relay-desktop"), "-p-relay-desktop");
    assert_eq!(
        project_folder("/Users/me/My Repo_2.0/é"),
        "-Users-me-My-Repo-2-0--"
    );
}

fn transcript(config: &ClaudeConfig, folder: &str, body: &str) {
    let folder = config.projects().join(folder);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join(format!("{SESSION}.jsonl")), body).unwrap();
}

// InjectableAgents.finalAnswer (.claudeTerminal): the live session's
// transcript under its working directory; a busy session's turn without
// `end_turn` is not over.
#[test]
fn a_live_sessions_final_answer_comes_from_its_project_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let no_stop = TRANSCRIPT.replace("end_turn", "unknown");
    transcript(&config, "-p-relay-desktop", &no_stop);
    transcript(&config, "-other", "");
    let table = table(&[(42, ticks())]);
    record(&config, 42, json!({"status": "busy"}));
    assert_eq!(final_answer(&config, &table, SESSION, REF), None);
    record(&config, 42, json!({"status": "idle"}));
    assert_eq!(
        final_answer(&config, &table, SESSION, REF).as_deref(),
        Some("Claude answer")
    );
    transcript(&config, "-p-relay-desktop", TRANSCRIPT);
    record(&config, 42, json!({"status": "busy"}));
    assert_eq!(
        final_answer(&config, &table, SESSION, REF).as_deref(),
        Some("Claude answer")
    );
    assert_eq!(final_answer(&config, &table, SESSION, "000000000000"), None);
}

// InjectableAgents.finalAnswer (.claudeTerminal): a session that exited
// after answering is out of the registry; its transcript is found under its
// own id and its turn is over.
#[test]
fn an_exited_sessions_transcript_is_found_by_its_id() {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    let no_stop = TRANSCRIPT.replace("end_turn", "unknown");
    transcript(&config, "-somewhere-else", &no_stop);
    assert_eq!(
        final_answer(&config, &table(&[]), SESSION, REF).as_deref(),
        Some("Claude answer")
    );
    assert_eq!(final_answer(&config, &table(&[]), "../../etc", REF), None);
    let empty = ClaudeConfig {
        home: dir.path().join("missing"),
        ..config
    };
    assert_eq!(final_answer(&empty, &table(&[]), SESSION, REF), None);
}

// Review on #426: a login that joins the watched folders after the core
// started (a running session's `CLAUDE_CONFIG_DIR`) follows direct delivery
// at the next registry read, rather than holding messages until a restart.
#[test]
fn a_login_seen_later_follows_direct_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = ClaudeConfig {
        home: dir.path().join(".claude"),
        executable: None,
        app_sessions: None,
        dirs: crate::relay::claude_dirs::ClaudeDirs {
            environment: Vec::new(),
            file: Some(dir.path().join("relay/claude-config-dirs.json")),
        },
    };
    std::fs::create_dir_all(&config.home).unwrap();
    std::fs::write(
        config.home.join("settings.json"),
        r#"{"crossSessionInbound":"accept"}"#,
    )
    .unwrap();
    let later = dir.path().join(".seclaude");
    std::fs::create_dir_all(&later).unwrap();
    std::fs::write(later.join(".claude.json"), "{}").unwrap();
    let table = table(&[]);
    // Known from the first look (a scan just recorded it): followed at once.
    let first = dir.path().join(".claude-first");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::write(first.join(".claude.json"), "{}").unwrap();
    registry(&config, &table);
    assert_eq!(
        crate::relay::claude_settings::inbound_value(
            std::fs::read(first.join("settings.json")).ok().as_deref()
        )
        .as_deref(),
        Some("accept")
    );
    config.dirs.environment = vec![later.clone()];
    registry(&config, &table);
    assert_eq!(
        crate::relay::claude_settings::inbound_value(
            std::fs::read(later.join("settings.json")).ok().as_deref()
        )
        .as_deref(),
        Some("accept")
    );
}

// A login kept apart from `~/.claude` under any name
// (`CLAUDE_CONFIG_DIR=~/.seclaude`) is read when it is named in
// `AGENT_RELAY_CLAUDE_CONFIG_DIRS`, added in Settings, or seen on a running
// Claude Code session, and its transcripts are found for final answers.
#[test]
fn a_config_folder_under_any_name_is_read_once_it_is_watched() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = ClaudeConfig {
        home: dir.path().join(".claude"),
        executable: None,
        app_sessions: None,
        dirs: crate::relay::claude_dirs::ClaudeDirs {
            environment: Vec::new(),
            file: Some(dir.path().join("relay/claude-config-dirs.json")),
        },
    };
    let seclaude = ClaudeConfig {
        home: dir.path().join(".seclaude"),
        ..config.clone()
    };
    let other = "11111111-2222-4333-8444-555555555555";
    record(&seclaude, 43, json!({"sessionId": other}));
    assert_eq!(config.registries(), [config.registry()]);

    config.dirs.environment = vec![seclaude.home.clone()];
    assert_eq!(
        config.registries(),
        [config.registry(), seclaude.registry()]
    );

    config.dirs.environment.clear();
    config
        .dirs
        .set_added(&[seclaude.home.display().to_string()], dir.path())
        .unwrap();
    assert_eq!(
        config.registries(),
        [config.registry(), seclaude.registry()]
    );

    config.dirs.set_added(&[], dir.path()).unwrap();
    config
        .dirs
        .record_running(std::slice::from_ref(&seclaude.home));
    assert_eq!(
        config.registries(),
        [config.registry(), seclaude.registry()]
    );
    let sessions = terminal_sessions(&config, &table(&[(43, ticks())]));
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        sessions[0].registry.as_deref(),
        Some(seclaude.registry().as_path())
    );
}

// A second Claude login (`CLAUDE_CONFIG_DIR=~/.claude-work`, as account
// switchers for Conductor keep) records its sessions in its own registry:
// they are found, with their keys there, and a login whose `sessions/`
// links to the default's is read once.
#[test]
#[cfg(unix)]
fn every_logins_registry_is_read_with_its_own_keys() {
    let dir = tempfile::tempdir().unwrap();
    let config = ClaudeConfig {
        home: dir.path().join(".claude"),
        executable: None,
        app_sessions: None,
        dirs: Default::default(),
    };
    let work = ClaudeConfig {
        home: dir.path().join(".claude-work"),
        executable: None,
        app_sessions: None,
        dirs: Default::default(),
    };
    record(&config, 42, json!({}));
    key(
        &config,
        "42.aa.key",
        json!({"peerToken": "default-tok", "procStart": LINUX_START}),
    );
    let other = "11111111-2222-4333-8444-555555555555";
    record(
        &work,
        43,
        json!({"sessionId": other, "cwd": "/Users/me/conductor/workspaces/app/ankara"}),
    );
    key(
        &work,
        "43.bb.key",
        json!({"peerToken": "work-tok", "procStart": LINUX_START}),
    );
    // Linked to the default's, as the shared-registry setup does.
    std::fs::create_dir_all(dir.path().join(".claude-linked")).unwrap();
    std::os::unix::fs::symlink(
        config.registry(),
        dir.path().join(".claude-linked/sessions"),
    )
    .unwrap();
    // Not a Claude login.
    std::fs::create_dir_all(dir.path().join(".claudex/sessions")).unwrap();

    assert_eq!(
        config.registries(),
        [config.registry(), work.registry()],
        "each registry once, by its real path"
    );
    let table = table(&[(42, ticks()), (43, ticks())]);
    let mut sessions = terminal_sessions(&config, &table);
    sessions.sort_by_key(|s| s.pid);
    assert_eq!(sessions.iter().map(|s| s.pid).collect::<Vec<_>>(), [42, 43]);
    assert_eq!(sessions[0].registry, None);
    assert_eq!(
        sessions[1].registry.as_deref(),
        Some(work.registry().as_path())
    );
    assert_eq!(
        peer_token(&config, &sessions[0]).as_deref(),
        Some("default-tok")
    );
    assert_eq!(
        peer_token(&config, &sessions[1]).as_deref(),
        Some("work-tok")
    );
    assert_eq!(
        terminal_session(&config, &table, other).map(|s| s.pid),
        Some(43)
    );
}

// Review on #388: a stale default-login entry without a start time does not
// hide the live session on another login that reuses its pid, and a login
// with its own `projects/` has its answers found there.
#[test]
fn another_logins_live_session_wins_and_its_transcripts_are_read() {
    let dir = tempfile::tempdir().unwrap();
    let config = ClaudeConfig {
        home: dir.path().join(".claude"),
        executable: None,
        app_sessions: None,
        dirs: Default::default(),
    };
    let work = ClaudeConfig {
        home: dir.path().join(".claude-work"),
        executable: None,
        app_sessions: None,
        dirs: Default::default(),
    };
    let stale = "99999999-2222-4333-8444-555555555555";
    // The stale entry has no start time, so is_alive accepts it by pid.
    let path = record(&config, 42, json!({"sessionId": stale}));
    let mut value: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("procStart");
    std::fs::write(&path, value.to_string()).unwrap();
    record(&work, 42, json!({"status": "idle"}));
    let table = table(&[(42, ticks())]);
    let sessions = terminal_sessions(&config, &table);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, SESSION, "the start-verified entry");
    assert_eq!(
        sessions[0].registry.as_deref(),
        Some(work.registry().as_path())
    );
    transcript(&work, "-p-relay-desktop", TRANSCRIPT);
    assert_eq!(
        final_answer(&config, &table, SESSION, REF).as_deref(),
        Some("Claude answer")
    );
}
