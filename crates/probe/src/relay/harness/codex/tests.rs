use super::*;
use crate::relay::codex::app_server::tests::{server_frame, FakeAppServer};
use crate::relay::codex::runner::tests::FakeRunner;
use crate::relay::process::FakeProcesses;

const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bdb7b";

fn adapter(codex: CodexConfig, runner: Arc<dyn CodexRunner>) -> CodexAdapter {
    CodexAdapter {
        codex,
        table: Arc::new(FakeProcesses::default()),
        uid: 501,
        runner,
        systemd_run: None,
    }
}

fn config(home: &Path) -> CodexConfig {
    let env = |key: &str| (key == "PATH").then(|| "/usr/bin".to_string());
    CodexConfig::from_env(&env, home)
}

fn launch(home: &Path) -> Launch {
    Launch {
        harness: ID,
        name: "w1".into(),
        text: "hi".into(),
        directory: home.to_path_buf(),
        full_access: true,
        message_id: "m1".into(),
        session_id: "s1".into(),
    }
}

#[test]
fn codex_is_offered_only_where_its_daemon_can_run() {
    let home = tempfile::tempdir().unwrap();
    let mut codex = config(home.path());
    let system = |codex: CodexConfig| adapter(codex, Arc::new(SystemRunner));
    codex.executable = None;
    assert_eq!(system(codex.clone()).detect(), Installed::No);
    // Installed through npm or a version manager only: no daemon.
    codex.executable = Some(PathBuf::from("/usr/bin/true"));
    assert_eq!(
        system(codex.clone()).detect(),
        Installed::Unusable(CODEX_NO_DAEMON.into())
    );
    let refused = system(codex.clone()).launch(&launch(home.path()), &|_, _| {});
    assert!(matches!(&refused, Err(LaunchError::Unavailable(reason)) if reason == CODEX_NO_DAEMON));
    for layout in [
        "app-server-control/app-server-control.sock",
        "packages/app-server-daemon/current/bin/codex",
        "packages/standalone/current/codex",
    ] {
        let codex_home = tempfile::tempdir().unwrap();
        let file = codex_home.path().join(layout);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "").unwrap();
        let mut codex = codex.clone();
        codex.home = codex_home.path().to_path_buf();
        assert_eq!(system(codex).detect(), Installed::Yes, "{layout}");
    }
}

#[test]
fn a_codex_thread_whose_first_turn_is_refused_is_archived() {
    let home = tempfile::tempdir().unwrap();
    let mut codex = config(home.path());
    codex.executable = Some(PathBuf::from("/usr/bin/true"));
    let socket = codex
        .home
        .join("app-server-control/app-server-control.sock");
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    std::fs::write(&socket, "").unwrap();
    let answer = |request: &serde_json::Value, result: serde_json::Value| {
        Some(server_frame(
            &serde_json::json!({"id": request["id"], "result": result}),
        ))
    };
    let starting = FakeAppServer::new(move |request| match request["method"].as_str() {
        Some("thread/start") => answer(request, serde_json::json!({"thread": {"id": "T-1"}})),
        Some("turn/start") => Some(server_frame(&serde_json::json!({
            "id": request["id"], "error": {"code": -32600, "message": "model unavailable"}
        }))),
        _ => None,
    });
    let archiving = FakeAppServer::new(move |request| {
        (request["method"] == "thread/archive").then(|| answer(request, serde_json::json!({})))?
    });
    let archived = archiving.seen.clone();
    let runner = FakeRunner::default();
    runner.streams.lock().unwrap().push_back(Box::new(starting));
    runner
        .streams
        .lock()
        .unwrap()
        .push_back(Box::new(archiving));
    let launched = adapter(codex, Arc::new(runner)).launch(&launch(home.path()), &|_, _| {});
    assert!(
        matches!(&launched, Err(LaunchError::Failed(reason)) if reason.contains("refused the first turn")),
        "{:?}",
        launched.err()
    );
    let archived = archived.lock().unwrap();
    let archive = archived
        .iter()
        .find(|r| r["method"] == "thread/archive")
        .expect("the refused thread is archived");
    assert_eq!(archive["params"]["threadId"], "T-1");
}

#[test]
fn a_released_codex_agent_has_its_thread_archived() {
    let home = tempfile::tempdir().unwrap();
    let mut codex = config(home.path());
    codex.executable = Some(PathBuf::from("/usr/bin/true"));
    let server = FakeAppServer::new(|request| {
        (request["method"] == "thread/archive")
            .then(|| server_frame(&serde_json::json!({"id": request["id"], "result": {}})))
    });
    let seen = server.seen.clone();
    let runner = FakeRunner::default();
    runner.streams.lock().unwrap().push_back(Box::new(server));
    adapter(codex, Arc::new(runner)).stop(&Target::new(SessionKind::Codex, "t-1"), None);
    let seen = seen.lock().unwrap();
    let archive = seen
        .iter()
        .find(|r| r["method"] == "thread/archive")
        .unwrap();
    assert_eq!(archive["params"]["threadId"], "t-1");
}

#[test]
fn a_release_succeeds_only_once_codex_archived_the_thread() {
    let home = tempfile::tempdir().unwrap();
    let mut codex = config(home.path());
    codex.executable = Some(PathBuf::from("/usr/bin/true"));
    let target = Target::new(SessionKind::Codex, "t-1");
    let archiving = |error: bool| {
        FakeAppServer::new(move |request| {
            (request["method"] == "thread/archive").then(|| {
                server_frame(&match error {
                    false => serde_json::json!({"id": request["id"], "result": {}}),
                    true => serde_json::json!({"id": request["id"],
                        "error": {"code": -32600, "message": "thread is busy"}}),
                })
            })
        })
    };
    let runner = Arc::new(FakeRunner::default());
    let released = adapter(codex.clone(), runner.clone());
    runner
        .streams
        .lock()
        .unwrap()
        .push_back(Box::new(archiving(false)));
    assert_eq!(released.release(&target, None), Ok(()));
    // Codex refused, or no app-server could be reached: the thread may
    // still run, so the release says so instead of forgetting it.
    runner
        .streams
        .lock()
        .unwrap()
        .push_back(Box::new(archiving(true)));
    let refused = released.release(&target, None).unwrap_err();
    assert!(
        refused.starts_with("Codex did not archive its thread"),
        "{refused}"
    );
    let unreachable = released.release(&target, None).unwrap_err();
    assert!(
        unreachable.starts_with("could not reach Codex's app-server"),
        "{unreachable}"
    );
}

#[test]
fn it_owns_codex_threads_only() {
    let home = tempfile::tempdir().unwrap();
    let codex = adapter(config(home.path()), Arc::new(SystemRunner));
    assert!(codex.owns(&Target::new(SessionKind::Codex, THREAD)));
    assert!(!codex.owns(&Target::new(SessionKind::ClaudeTerminal, THREAD)));
    // A thread recorded on the intent is found as it is.
    let intent = Intent {
        invocation_id: "inv_w1".into(),
        name: "w1".into(),
        harness: ID,
        node_id: "node_desktop_1".into(),
        node_name: "mac-desktop".into(),
        title: "Fix CI".into(),
        base_url: "https://cast.example".into(),
        workspace_key: crate::relay::workspace::Secret::new("rk_live_test0000".to_string()),
        workspace_id: None,
        machine_prefix: "mac".into(),
        message_id: "m1".into(),
        session_id: "s1".into(),
        created_ms: 0,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: None,
        token: None,
        requester: None,
        target: Some(Target::new(SessionKind::Codex, THREAD)),
        process: None,
    };
    assert_eq!(
        codex.find(&intent),
        Some((Target::new(SessionKind::Codex, THREAD), None))
    );
}

fn watched(alive: bool) -> Watched {
    Watched {
        name: "w1".into(),
        target: Target::new(SessionKind::Codex, THREAD),
        process: None,
        alive,
    }
}

fn write_rollout(home: &Path, lines: &str) {
    let day = home.join("codex/sessions/2026/10/14");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(
        day.join(format!("rollout-2026-10-14T10-00-00-{THREAD}.jsonl")),
        lines,
    )
    .unwrap();
}

#[test]
fn codex_liveness_follows_the_app_server_and_work_the_rollout() {
    // Not hosted is paused, not ended: it keeps its place.
    assert_eq!(
        CodexDaemon::NotRunning.hosts(THREAD),
        ProcessLiveness::Unknown
    );
    let loaded = |ids: &[&str]| CodexDaemon::Loaded(ids.iter().map(|s| s.to_string()).collect());
    assert_eq!(
        loaded(&[THREAD]).hosts(&THREAD.to_uppercase()),
        ProcessLiveness::Running
    );
    assert_eq!(loaded(&["other"]).hosts(THREAD), ProcessLiveness::Unknown);
    assert_eq!(loaded(&[]).hosts(THREAD), ProcessLiveness::Unknown);

    let home = tempfile::tempdir().unwrap();
    let env =
        |key: &str| (key == "CODEX_HOME").then(|| home.path().join("codex").display().to_string());
    let observer = adapter(
        CodexConfig::from_env(&env, home.path()),
        Arc::new(SystemRunner),
    );
    // No Codex runs (an empty process table): the thread is paused, so
    // it keeps its place until it is archived.
    let paused = observer.observe(&[watched(true)]);
    assert_eq!(
        paused,
        vec![Observation {
            process: ProcessLiveness::Unknown,
            work: WorkState::Idle,
            turn_in_progress: false
        }]
    );
    let mut record = lifecycle::AgentRecord::default();
    record.apply(paused[0], chrono::Utc::now());
    assert!(record.holds_slot());
    // A turn had started when Codex stopped.
    write_rollout(
        home.path(),
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"t1\"}}\n",
    );
    assert_eq!(
        observer.observe(&[watched(true)]),
        vec![Observation {
            process: ProcessLiveness::Unknown,
            work: WorkState::Working,
            turn_in_progress: true
        }]
    );
    assert_eq!(
        observer.work(THREAD),
        (WorkState::Working, true),
        "while hosted, the same rollout reads as working"
    );
    // Archived: completed.
    assert_eq!(
        observer.observe(&[watched(false)])[0],
        Observation {
            process: ProcessLiveness::Exited,
            work: WorkState::Completed,
            turn_in_progress: false
        }
    );
}

// #550 review: a rollout that cannot be read is not an idle thread, so a
// follow-up waits rather than starting a turn into a busy one.
#[test]
#[cfg(unix)]
fn a_follow_up_waits_while_the_rollout_cannot_be_read() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let mut codex = config(home.path());
    codex.home = home.path().join("codex");
    write_rollout(home.path(), "{}\n");
    let day = home.path().join("codex/sessions/2026/10/14");
    let file = day.join(format!("rollout-2026-10-14T10-00-00-{THREAD}.jsonl"));
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read(&file).is_ok() {
        return; // Running as root: every file is readable.
    }
    let runner = Arc::new(FakeRunner::default());
    let codex = adapter(codex, runner.clone());
    let message = crate::relay::spawn::launch::Message {
        delivery_id: "d1",
        message_id: "m1",
        text: "follow-up",
        native: false,
    };
    assert_eq!(
        codex.deliver(&Target::new(SessionKind::Codex, THREAD), &message),
        Some(InjectOutcome::WaitingForTurn(
            "Codex is finishing its current turn".into()
        ))
    );
    assert!(
        runner.proxies.lock().unwrap().is_empty(),
        "no proxy was opened"
    );
}
