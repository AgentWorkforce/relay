use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};

const SESSION: &str = "5f7c1f64-8f53-4c33-9d2f-7c1d2f1f0a11";

fn adapter(home: &Path, table: Arc<FakeProcesses>) -> ClaudeAdapter {
    let env =
        |key: &str| (key == "CLAUDE_CONFIG_DIR").then(|| home.join("claude").display().to_string());
    ClaudeAdapter {
        claude: ClaudeConfig::resolve(&env, home, &[]),
        table,
        environment: None,
        logs: home
            .join("app-data")
            .join(crate::relay::spawn::launch::SPAWN_LOGS),
        systemd_run: None,
    }
}

fn watched(alive: bool) -> Watched {
    Watched {
        name: "c1".into(),
        target: Target::new(SessionKind::ClaudeTerminal, SESSION),
        process: Some(SpawnedProcess {
            pid: 4242,
            start: 7,
        }),
        alive,
    }
}

fn write_log(home: &Path, lines: &str) {
    let logs = home
        .join("app-data")
        .join(crate::relay::spawn::launch::SPAWN_LOGS);
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join(format!("{SESSION}.jsonl")), lines).unwrap();
}

#[test]
fn claude_runs_headless_with_the_session_named_and_access_as_chosen() {
    let full = arguments("s1", true);
    assert_eq!(
        &full[..9],
        [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            // Its input in its output: what it was asked is in its transcript.
            "--replay-user-messages",
            "--session-id",
            "s1"
        ]
    );
    assert!(full.contains(&"--dangerously-skip-permissions".to_string()));
    // The person's own MCP servers, as with the broker's workers.
    assert!(!full.iter().any(|argument| argument.contains("mcp-config")));
    let confined = arguments("s1", false);
    assert!(!confined.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(confined.ends_with(&["--permission-mode".into(), "acceptEdits".into()]));
    // Either way, what would ask comes to the core on its output.
    for arguments in [full, confined] {
        let at = arguments
            .iter()
            .position(|argument| argument == "--permission-prompt-tool")
            .unwrap();
        assert_eq!(arguments[at + 1], "stdio");
    }
}

#[test]
fn the_first_message_is_one_stream_json_user_line() {
    let line = first_message("fix \"CI\"\nplease");
    assert!(!line.contains('\n'));
    let value: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["type"], "user");
    assert_eq!(value["message"]["content"], "fix \"CI\"\nplease");
}

#[test]
fn it_is_offered_where_claude_code_is_installed_and_owns_its_sessions() {
    let home = tempfile::tempdir().unwrap();
    let mut claude = adapter(home.path(), Arc::new(FakeProcesses::default()));
    assert_eq!(claude.detect(), Installed::No);
    let refused = claude.launch(
        &Launch {
            harness: ID,
            name: "c1".into(),
            text: "hi".into(),
            directory: home.path().to_path_buf(),
            full_access: true,
            message_id: "m1".into(),
            session_id: SESSION.into(),
        },
        &|_, _| {},
    );
    assert!(matches!(refused, Err(LaunchError::Unavailable(_))));
    claude.claude.executable = Some(PathBuf::from("/usr/bin/true"));
    assert_eq!(claude.detect(), Installed::Yes);
    assert!(claude.owns(&Target::new(SessionKind::ClaudeTerminal, SESSION)));
    assert!(!claude.owns(&Target::new(SessionKind::ClaudeCloud, SESSION)));
    assert!(!claude.owns(&Target::new(SessionKind::Codex, SESSION)));
}

#[test]
fn a_spawned_claude_that_exited_unreaped_is_not_alive() {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    table.insert(
        700,
        FakeProcess {
            start: 42,
            ..FakeProcess::default()
        },
    );
    let claude = adapter(home.path(), table.clone());
    let target = Target::new(
        SessionKind::ClaudeTerminal,
        "11111111-2222-3333-4444-555555555555",
    );
    let process = SpawnedProcess {
        pid: 700,
        start: 42,
    };
    assert!(claude.alive(&target, Some(&process)));
    assert!(!claude.alive(&target, None));
    // A container whose init never reaps leaves a zombie with the same
    // pid and start time; it has exited all the same.
    table.insert(
        700,
        FakeProcess {
            start: 42,
            zombie: true,
            ..FakeProcess::default()
        },
    );
    assert!(!claude.alive(&target, Some(&process)));
}

#[test]
fn a_running_claude_is_working_until_its_turn_has_a_result() {
    let home = tempfile::tempdir().unwrap();
    let observer = adapter(home.path(), Arc::new(FakeProcesses::default()));
    assert_eq!(
        observer.observe(&[watched(true)]),
        vec![Observation {
            process: ProcessLiveness::Running,
            work: WorkState::Unknown,
            turn_in_progress: false
        }]
    );
    write_log(
        home.path(),
        "{\"type\":\"system\"}\n{\"type\":\"assistant\"}\n",
    );
    let [working] = observer.observe(&[watched(true)])[..] else {
        panic!()
    };
    assert_eq!(working.work, WorkState::Working);
    write_log(
        home.path(),
        "{\"type\":\"system\"}\n{\"type\":\"assistant\"}\n{\"type\":\"result\"}\n",
    );
    assert_eq!(observer.observe(&[watched(true)])[0].work, WorkState::Idle);
}

#[test]
fn an_ended_claude_is_completed_after_a_result_and_unfinished_mid_turn() {
    let home = tempfile::tempdir().unwrap();
    let observer = adapter(home.path(), Arc::new(FakeProcesses::default()));
    write_log(home.path(), "{\"type\":\"result\"}\n");
    assert_eq!(
        observer.observe(&[watched(false)]),
        vec![Observation {
            process: ProcessLiveness::Exited,
            work: WorkState::Completed,
            turn_in_progress: false
        }]
    );
    write_log(home.path(), "{\"type\":\"result\"}\n{\"type\":\"user\"}\n");
    assert_eq!(
        observer.observe(&[watched(false)]),
        vec![Observation {
            process: ProcessLiveness::Exited,
            work: WorkState::Unknown,
            turn_in_progress: true
        }]
    );
    // No process recorded: nothing to say.
    let without = Watched {
        process: None,
        ..watched(false)
    };
    assert_eq!(
        observer.observe(&[without])[0].process,
        ProcessLiveness::Unknown
    );
}

#[test]
fn harness_signals_map_to_work_states() {
    assert_eq!(registry_status("busy"), WorkState::Working);
    assert_eq!(registry_status("idle"), WorkState::Idle);
    assert_eq!(
        registry_status("waiting_for_permission"),
        WorkState::Waiting
    );
    assert_eq!(registry_status("something new"), WorkState::Unknown);
    let log = b"{\"type\":\"system\"}\n{\"type\":\"assistant\"}\n{\"type\":\"result\"}\n";
    assert_eq!(log_state(log), Some(WorkState::Idle));
    let running = b"{\"type\":\"result\"}\n{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n{\"ty";
    assert_eq!(log_state(running), Some(WorkState::Working));
    assert_eq!(log_state(b"not json\n"), None);
}

#[test]
fn its_own_state_events_say_whether_a_turn_runs_past_bookkeeping() {
    let state = |state: &str| {
        format!(r#"{{"type":"system","subtype":"session_state_changed","state":"{state}"}}"#)
    };
    let idle_then_bookkeeping = format!(
        "{}\n{{\"type\":\"result\"}}\n{}\n{{\"type\":\"command_lifecycle\",\"state\":\"completed\"}}\n{{\"type\":\"system\",\"subtype\":\"task_updated\"}}\n",
        state("running"),
        state("idle")
    );
    assert_eq!(
        log_state(idle_then_bookkeeping.as_bytes()),
        Some(WorkState::Idle)
    );
    let asking = format!(
        "{}\n{{\"type\":\"control_request\",\"request_id\":\"r\"}}\n",
        state("requires_action")
    );
    assert_eq!(log_state(asking.as_bytes()), Some(WorkState::Waiting));
    let answered = format!("{asking}{}\n", state("running"));
    assert_eq!(log_state(answered.as_bytes()), Some(WorkState::Working));
    // Without state events, a control request still reads as waiting.
    assert_eq!(
        log_state(b"{\"type\":\"assistant\"}\n{\"type\":\"control_request\"}\n"),
        Some(WorkState::Waiting)
    );
    assert_eq!(
        log_state(b"{\"type\":\"result\"}\n{\"type\":\"command_lifecycle\"}\n"),
        Some(WorkState::Idle)
    );
}

#[test]
fn readiness_gives_up_on_a_recycled_pid_at_once_without_claiming_it() {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    // Beyond any real pid, so nothing could be signalled even by mistake.
    const RECYCLED: i32 = 2_000_000_123;
    table.insert(
        RECYCLED,
        FakeProcess {
            start: 8,
            ..FakeProcess::default()
        },
    );
    let adapter = adapter(home.path(), table);
    let launched = SpawnedProcess {
        pid: RECYCLED,
        start: 7,
    };
    let began = Instant::now();
    let ready = adapter.wait_ready(
        SESSION,
        RECYCLED,
        Some(launched),
        Path::new("c.jsonl"),
        Instant::now() + READY_TIMEOUT,
    );
    assert!(ready.is_err());
    // Not left to the readiness timeout: the launched process is gone.
    assert!(began.elapsed() < Duration::from_secs(5));
}

fn event(kind: &str, subtype: Option<&str>, session: &str) -> String {
    let mut event = serde_json::json!({"type": kind, "session_id": session});
    if let Some(subtype) = subtype {
        event["subtype"] = subtype.into();
    }
    format!("{event}\n")
}

#[test]
fn only_a_turn_of_its_own_session_shows_the_first_message_was_taken() {
    let init = event("system", Some("init"), SESSION);
    assert!(task_taken(init.as_bytes(), SESSION));
    assert!(task_taken(
        event("assistant", None, SESSION).as_bytes(),
        SESSION
    ));
    assert!(task_taken(
        event("result", None, SESSION).as_bytes(),
        SESSION
    ));
    // Another session's turn, or an event without a session, is not ours.
    let other = event(
        "system",
        Some("init"),
        "00000000-0000-4000-8000-000000000000",
    );
    assert!(!task_taken(other.as_bytes(), SESSION));
    assert!(!task_taken(
        b"{\"type\":\"system\",\"subtype\":\"init\"}\n",
        SESSION
    ));
    // What it may write before reading anything is no receipt.
    let before = event("system", Some("hook_started"), SESSION)
        + &event("rate_limit_event", None, SESSION)
        + &event("user", None, SESSION);
    assert!(!task_taken(before.as_bytes(), SESSION));
    // An init still being written, or output that is not stream-json.
    assert!(!task_taken(&init.as_bytes()[..init.len() - 8], SESSION));
    assert!(!task_taken(b"Error: not logged in\n", SESSION));
    assert!(!task_taken(b"", SESSION));
}

fn running(table: &FakeProcesses) -> SpawnedProcess {
    table.insert(
        4242,
        FakeProcess {
            start: 7,
            ..FakeProcess::default()
        },
    );
    SpawnedProcess {
        pid: 4242,
        start: 7,
    }
}

fn log_path(home: &Path) -> PathBuf {
    home.join("app-data")
        .join(crate::relay::spawn::launch::SPAWN_LOGS)
        .join(format!("{SESSION}.jsonl"))
}

#[test]
fn the_first_message_is_confirmed_once_its_turn_starts_in_the_output() {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let process = running(&table);
    let claude = adapter(home.path(), table);
    let log = log_path(home.path());
    // Nothing yet: written while it waits, within the window.
    write_log(home.path(), "");
    let writer = {
        let home = home.path().to_path_buf();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            write_log(
                &home,
                &(event("system", Some("init"), SESSION) + &event("assistant", None, SESSION)),
            );
        })
    };
    let began = Instant::now();
    let task = claude.wait_taken(SESSION, process, &log, began + READY_TIMEOUT);
    writer.join().unwrap();
    assert_eq!(task, TaskHandoff::Confirmed);
    assert!(began.elapsed() < Duration::from_secs(5));
}

#[test]
fn without_a_turn_in_the_window_the_first_message_stays_unconfirmed() {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let process = running(&table);
    let claude = adapter(home.path(), table.clone());
    let log = log_path(home.path());
    write_log(home.path(), &event("system", Some("hook_started"), SESSION));
    let window = Instant::now() + Duration::from_millis(600);
    assert_eq!(
        claude.wait_taken(SESSION, process, &log, window),
        TaskHandoff::Unconfirmed("input")
    );
    assert!(Instant::now() >= window);
    // No log at all is no evidence either.
    std::fs::remove_file(&log).unwrap();
    assert_eq!(
        claude.wait_taken(SESSION, process, &log, Instant::now()),
        TaskHandoff::Unconfirmed("input")
    );
    // The waiting only reads: the log is not written to, nor made again.
    assert!(!log.exists());
}

#[test]
fn a_claude_that_ended_is_judged_at_once_by_what_it_wrote() {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let process = running(&table);
    let claude = adapter(home.path(), table.clone());
    let log = log_path(home.path());
    // Another process took its pid: not waited on to the window's end.
    table.insert(
        4242,
        FakeProcess {
            start: 8,
            ..FakeProcess::default()
        },
    );
    write_log(home.path(), "Error: not logged in\n");
    let began = Instant::now();
    assert_eq!(
        claude.wait_taken(SESSION, process, &log, began + READY_TIMEOUT),
        TaskHandoff::Unconfirmed("input")
    );
    assert!(began.elapsed() < Duration::from_secs(5));
    // A turn it ran before ending was a turn on its first message.
    write_log(
        home.path(),
        &(event("system", Some("init"), SESSION) + &event("result", None, SESSION)),
    );
    assert_eq!(
        claude.wait_taken(SESSION, process, &log, began + READY_TIMEOUT),
        TaskHandoff::Confirmed
    );
}
