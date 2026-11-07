//! Real Oh My Pi TUI and extension, with a deterministic loopback model
//! replacing only the paid model API. Run explicitly; RELAY_OMP_CLI names the
//! `omp` executable (default: `omp` on PATH).
// The extension checks file owners with `process.getuid`; not on Windows.
#![cfg(unix)]
use agent_relay_node::relay::codex::{CodexRouter, SystemCodexRoutes};
use agent_relay_node::relay::delivery::policy::MessageRef;
use agent_relay_node::relay::inject::{InjectOutcome, Injector};
use agent_relay_node::relay::local::{LocalConfig, LocalInjector, LocalSessions};
use agent_relay_node::relay::outbound::ServingPath;
use agent_relay_node::relay::peer::current_uid;
use agent_relay_node::relay::pi::{self, PiConfig};
use agent_relay_node::relay::process::SystemProcesses;
use agent_relay_node::relay::sessions::SessionDirectory;
use agent_relay_node::relay::store::{Registration, SessionKind};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Omp {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    input: Box<dyn Write + Send>,
    output: Arc<Mutex<String>>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
}

impl Drop for Omp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Omp {
    fn launch(home: &Path, args: &[&str]) -> Omp {
        let cli = std::env::var("RELAY_OMP_CLI").unwrap_or_else(|_| "omp".into());
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 36,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(cli);
        command.args([
            "--model",
            "relay-test/test",
            "--no-tools",
            "--no-skills",
            "--no-lsp",
            "--no-title",
        ]);
        command.args(args);
        command.cwd(home.join("project"));
        command.env_clear();
        command.env("HOME", home);
        command.env("PATH", std::env::var("PATH").unwrap());
        command.env("OMP_SKIP_SETUP", "1");
        command.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let output = Arc::new(Mutex::new(String::new()));
        let captured = output.clone();
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                let mut output = captured.lock().unwrap();
                output.push_str(&String::from_utf8_lossy(&bytes[..count]));
                if output.len() > 65536 {
                    let keep = output.len() - 32768;
                    *output = String::from_utf8_lossy(&output.as_bytes()[keep..]).into_owned();
                }
            }
        });
        let input = pair.master.take_writer().unwrap();
        Omp {
            child,
            input,
            output,
            _master: pair.master,
        }
    }

    fn type_line(&mut self, line: &str) {
        self.input.write_all(line.as_bytes()).unwrap();
        self.input.write_all(b"\r").unwrap();
        self.input.flush().unwrap();
    }
}

fn until<T>(label: &str, omp: &Omp, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        if let Some(value) = check() {
            return value;
        }
        if Instant::now() >= deadline {
            let captured = omp.output.lock().unwrap().clone();
            let tail: String = captured.chars().rev().take(4000).collect();
            panic!(
                "Timed out: {label}\n{}",
                tail.chars().rev().collect::<String>()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// An OpenAI-compatible streaming model. The first answer waits for
/// `release`, so a second delivery arrives while Oh My Pi is busy.
fn model_server() -> (String, Arc<AtomicUsize>, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}/v1", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(AtomicBool::new(false));
    let (count, released) = (calls.clone(), release.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let (count, released) = (count.clone(), released.clone());
            std::thread::spawn(move || {
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    return;
                }
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                if request_line.starts_with("GET ") {
                    let body = json!({"object":"list","data":[{"id":"test","object":"model"}]})
                        .to_string();
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    return;
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(request["model"], "test");
                let index = count.fetch_add(1, Ordering::SeqCst) + 1;
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
                )
                .unwrap();
                let chunk = |delta: Value, finish: Value| {
                    json!({"id":"test","object":"chat.completion.chunk","created":1,"model":"test",
                        "choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
                };
                writeln!(
                    stream,
                    "data: {}\n",
                    chunk(json!({"role":"assistant"}), Value::Null)
                )
                .unwrap();
                stream.flush().unwrap();
                if index == 1 {
                    let deadline = Instant::now() + Duration::from_secs(30);
                    while !released.load(Ordering::SeqCst) && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
                let reply = json!({"content":format!("omp-test-reply-{index}")});
                writeln!(stream, "data: {}\n", chunk(reply, Value::Null)).unwrap();
                writeln!(stream, "data: {}\n", chunk(json!({}), json!("stop"))).unwrap();
                writeln!(stream, "data: [DONE]\n").unwrap();
                stream.flush().unwrap();
            });
        }
    });
    (address, calls, release)
}

fn registration(id: &str, binding: &str) -> Registration {
    serde_json::from_value(json!({"name":"omp-e2e", "agentID":"test-agent",
        "target":{"kind":"omp","id":id}, "baseURL":"https://cast.agentrelay.com",
        "registeredAt":"2026-10-26T00:00:00Z", "routeBinding":binding}))
    .unwrap()
}

fn transcript(home: &Path, id: &str) -> Option<PathBuf> {
    let sessions = home.join(".omp/agent/sessions");
    fs::read_dir(sessions)
        .ok()?
        .flatten()
        .flat_map(|project| fs::read_dir(project.path()).into_iter().flatten().flatten())
        .map(|entry| entry.path())
        .find(|path| path.to_string_lossy().ends_with(&format!("_{id}.jsonl")))
}

fn user_turns(path: &Path) -> usize {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| entry["type"] == "message" && entry["message"]["role"] == "user")
        .count()
}

#[test]
#[ignore = "requires Oh My Pi (bun install -g @oh-my-pi/pi-coding-agent); cargo test --test omp_live_session -- --ignored"]
fn an_oh_my_pi_tui_receives_idle_and_busy_messages_once_and_reconnects_on_resume() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir_all(home.join("project")).unwrap();
    let config = PiConfig::omp_from_env(&|_| None, &home);
    fs::create_dir_all(&config.agent_dir).unwrap();
    let (endpoint, calls, release) = model_server();
    fs::write(
        config.agent_dir.join("models.yml"),
        format!(
            "providers:\n  relay-test:\n    baseUrl: {endpoint}\n    api: openai-completions\n    auth: none\n    models:\n      - id: test\n"
        ),
    )
    .unwrap();
    // Oh My Pi loads extensions only when a session starts.
    config.install().unwrap();
    let table = Arc::new(SystemProcesses::default());
    let uid = current_uid();
    let local = LocalConfig::from_env(&|_| None, &home);
    let sessions = LocalSessions::new(local.clone(), table.clone());
    let codex = CodexRouter::new(Arc::new(SystemCodexRoutes::new(
        local.codex.clone(),
        table.clone(),
        uid,
    )));
    let injector = LocalInjector::new(local, table.clone(), codex, ServingPath::default());
    let mut omp = Omp::launch(&home, &[]);
    let row = until("Oh My Pi discovery", &omp, || {
        sessions.sessions().into_iter().next()
    });
    assert_eq!(row.target.kind, SessionKind::Omp);
    assert!(row.target.is_valid(), "omp session ids are UUIDv7");
    let binding = pi::binding(&config, &*table, uid, &row.target.id).unwrap();
    assert!(binding.reference.starts_with("omp:"));
    assert_eq!(
        sessions.route_binding(&row.target),
        Some(binding.reference.clone())
    );
    let agent = registration(&row.target.id, &binding.reference);
    let send = |id, text| injector.inject_registered(&agent, id, id, text);
    assert!(matches!(
        send("message-1", "[via Agent Relay] First test"),
        InjectOutcome::Accepted(_)
    ));
    until("first model request", &omp, || {
        (calls.load(Ordering::SeqCst) == 1).then_some(())
    });
    assert!(matches!(
        send("message-2", "[via Agent Relay] Busy test"),
        InjectOutcome::Accepted(_)
    ));
    std::thread::sleep(Duration::from_millis(700));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a busy session must not be interrupted"
    );
    assert!(injector
        .final_answer_registered(&agent, &MessageRef::of("message-1"))
        .is_none());
    release.store(true, Ordering::SeqCst);
    until("second completed answer", &omp, || {
        injector.final_answer_registered(&agent, &MessageRef::of("message-2"))
    });
    assert_eq!(
        injector.final_answer_registered(&agent, &MessageRef::of("message-1")),
        Some("omp-test-reply-1".into())
    );
    assert_eq!(
        injector.final_answer_registered(&agent, &MessageRef::of("message-2")),
        Some("omp-test-reply-2".into())
    );
    assert_eq!(
        send("message-1", "[via Agent Relay] First test"),
        InjectOutcome::Delivered
    );
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(calls.load(Ordering::SeqCst), 2, "a retry is never resent");
    let saved = transcript(&home, &row.target.id).expect("omp saved the conversation");
    assert_eq!(user_turns(&saved), 2);

    omp.type_line("/new");
    let switched = until("/new publishes a new target", &omp, || {
        sessions
            .sessions()
            .into_iter()
            .find(|candidate| candidate.target.id != agent.target.id)
    });
    assert_eq!(
        sessions.sessions().len(),
        1,
        "the old session is no longer live"
    );
    assert!(matches!(
        send("old-session", "Must not follow /new"),
        InjectOutcome::Waiting(_)
    ));
    let switched_agent = registration(
        &switched.target.id,
        &sessions.route_binding(&switched.target).unwrap(),
    );
    assert!(matches!(
        injector.inject_registered(
            &switched_agent,
            "message-3",
            "message-3",
            "[via Agent Relay] New session"
        ),
        InjectOutcome::Accepted(_)
    ));
    until("answer in the new session", &omp, || {
        injector.final_answer_registered(&switched_agent, &MessageRef::of("message-3"))
    });
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    drop(omp);
    assert!(sessions.sessions().is_empty());
    assert_eq!(
        send("message-2", "[via Agent Relay] Busy test"),
        InjectOutcome::Delivered,
        "confirmed deliveries settle after Oh My Pi exits"
    );
    assert!(matches!(
        send("message-4", "Waits for omp"),
        InjectOutcome::Waiting(_)
    ));

    // Reopening the first session is a new runtime: the old pin is refused.
    let omp = Omp::launch(&home, &["--resume", &agent.target.id]);
    let resumed = until("resumed session rebinds", &omp, || {
        pi::binding(&config, &*table, uid, &agent.target.id)
            .filter(|b| b.reference != binding.reference)
    });
    assert!(matches!(
        send("message-4", "Must not send"),
        InjectOutcome::Refused(_)
    ));
    let resumed_agent = registration(&agent.target.id, &resumed.reference);
    assert!(matches!(
        injector.inject_registered(
            &resumed_agent,
            "message-5",
            "message-5",
            "[via Agent Relay] After resume"
        ),
        InjectOutcome::Accepted(_)
    ));
    assert_eq!(
        until("answer after resume", &omp, || {
            injector.final_answer_registered(&resumed_agent, &MessageRef::of("message-5"))
        }),
        "omp-test-reply-4"
    );
    assert_eq!(user_turns(&saved), 3);
}
