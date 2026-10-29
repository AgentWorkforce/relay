//! Real Pi TUI and extension, with a deterministic loopback model replacing only
//! the paid model API. Run explicitly with RELAY_PI_CLI pointing to dist/cli.js.
// Pi's extension reaches the core over a Unix socket; not on Windows.
#![cfg(unix)]
use agent_relay_probe::relay::codex::{CodexRouter, SystemCodexRoutes};
use agent_relay_probe::relay::delivery::policy::MessageRef;
use agent_relay_probe::relay::inject::{InjectOutcome, Injector};
use agent_relay_probe::relay::local::{LocalConfig, LocalInjector, LocalSessions};
use agent_relay_probe::relay::outbound::ServingPath;
use agent_relay_probe::relay::peer::current_uid;
use agent_relay_probe::relay::pi::{self, PiConfig};
use agent_relay_probe::relay::process::SystemProcesses;
use agent_relay_probe::relay::sessions::SessionDirectory;
use agent_relay_probe::relay::store::Registration;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct PiProcess(Box<dyn portable_pty::Child + Send + Sync>);
impl Drop for PiProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn until<T>(label: &str, output: &Mutex<String>, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if let Some(value) = check() {
            return value;
        }
        if Instant::now() >= deadline {
            let captured = output.lock().unwrap().clone();
            let tail: String = captured
                .chars()
                .rev()
                .take(4000)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            panic!("Timed out: {label}\n{tail}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Both supported Pi releases publish their initial OSC title after managed
/// tools and extension binding finish, with the real command handler installed.
/// An editor/prompt can already be visible while /reload is still rejected.
fn startup_complete(output: &str, home: &Path) -> bool {
    let suffix = format!(" - {}", home.file_name().unwrap().to_string_lossy());
    output.split("\x1b]0;").skip(1).any(|frame| {
        frame
            .find('\x07')
            .into_iter()
            .chain(frame.find("\x1b\\"))
            .min()
            .is_some_and(|end| frame[..end].ends_with(&suffix))
    })
}

#[test]
fn startup_readiness_requires_the_completed_title_of_this_isolated_tui() {
    let home = Path::new("/tmp/pi-current");
    assert!(!startup_complete("Startup is still in progress", home));
    assert!(!startup_complete("\x1b]0;π - pi-other\x07", home));
    assert!(!startup_complete("\x1b]0;π - pi-current", home));
    assert!(startup_complete("\x1b]0;π - pi-current\x07", home));
    assert!(!startup_complete("\x1b]0;π - pi-current\x1b", home));
    assert!(startup_complete("\x1b]0;π - pi-current\x1b\\", home));
}

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
                let mut chunked = false;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    chunked |= line
                        .to_lowercase()
                        .starts_with("transfer-encoding: chunked");
                }
                if request_line.starts_with("GET ") {
                    let body = json!({"object":"list","data":[{"id":"test","object":"model"}]})
                        .to_string();
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    return;
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                if chunked {
                    loop {
                        let mut size = String::new();
                        reader.read_line(&mut size).unwrap();
                        let length = usize::from_str_radix(size.trim(), 16).unwrap();
                        if length == 0 {
                            break;
                        }
                        let mut chunk = vec![0; length];
                        reader.read_exact(&mut chunk).unwrap();
                        body.extend(chunk);
                        reader.read_exact(&mut [0; 2]).unwrap();
                    }
                }
                let request: Value = serde_json::from_slice(&body)
                    .unwrap_or_else(|error| panic!("{request_line}: {error}"));
                assert_eq!(request["model"], "test");
                let index = count.fetch_add(1, Ordering::SeqCst) + 1;
                write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n"
            )
                .unwrap();
                let chunk = |delta: Value, finish: Value| {
                    json!({"id":"test", "object":"chat.completion.chunk",
                "created":1,"model":"test","choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
                };
                writeln!(
                    stream,
                    "data: {}\n",
                    chunk(json!({"role":"assistant"}), Value::Null)
                )
                .unwrap();
                stream.flush().unwrap();
                if index == 1 {
                    let deadline = Instant::now() + Duration::from_secs(20);
                    while !released.load(Ordering::SeqCst) && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
                writeln!(
                    stream,
                    "data: {}\n",
                    chunk(
                        json!({"content":format!("pi-test-reply-{index}")}),
                        Value::Null
                    )
                )
                .unwrap();
                writeln!(stream, "data: {}\n", chunk(json!({}), json!("stop"))).unwrap();
                writeln!(stream, "data: [DONE]\n").unwrap();
                stream.flush().unwrap();
            });
        }
    });
    (address, calls, release)
}

fn registration(id: &str, binding: &str) -> Registration {
    serde_json::from_value(json!({"name":"pi-e2e", "agentID":"test-agent", "target":{"kind":"pi","id":id},
        "baseURL":"https://cast.agentrelay.com", "registeredAt":"2026-10-20T00:00:00Z", "routeBinding":binding})).unwrap()
}

#[test]
#[ignore = "requires an isolated Pi npm installation; RELAY_PI_CLI=... cargo test --test pi_live_session -- --ignored"]
fn an_existing_pi_tui_loads_relay_and_receives_idle_and_busy_messages_once() {
    let cli = std::env::var("RELAY_PI_CLI").expect("set RELAY_PI_CLI to Pi's dist/cli.js");
    let node = std::env::var("RELAY_PI_NODE").unwrap_or_else(|_| "node".into());
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let config = PiConfig::from_env(&|_| None, &home);
    fs::create_dir_all(&config.agent_dir).unwrap();
    let (endpoint, calls, release) = model_server();
    fs::write(
        config.agent_dir.join("models.json"),
        json!({"providers":{"relay-test":{
        "baseUrl":endpoint,"api":"openai-completions","apiKey":"synthetic-test-key",
        "models":[{"id":"test", "contextWindow":128000,"maxTokens":1024}]}}})
        .to_string(),
    )
    .unwrap();
    fs::write(
        config.agent_dir.join("settings.json"),
        json!({"quietStartup":true,
        "lastChangelogVersion":"999.0.0","defaultProvider":"relay-test","defaultModel":"test"})
        .to_string(),
    )
    .unwrap();
    let session = home.join("conversation.jsonl");
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 36,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new(node);
    command.args([
        cli.as_str(),
        "--provider",
        "relay-test",
        "--model",
        "test",
        "--no-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--session",
    ]);
    command.arg(&session);
    command.cwd(&home);
    command.env_clear();
    command.env("HOME", &home);
    command.env("PATH", std::env::var("PATH").unwrap());
    command.env("PI_CODING_AGENT_DIR", &config.agent_dir);
    command.env("PI_SKIP_VERSION_CHECK", "1");
    command.env("TERM", "xterm-256color");
    let mut process = PiProcess(pair.slave.spawn_command(command).unwrap());
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
                *output = String::from_utf8_lossy(&output.as_bytes()[output.len() - 32768..])
                    .into_owned();
            }
        }
    });
    let mut input = pair.master.take_writer().unwrap();
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
    // The process is already running before the extension is installed.
    until("Pi startup completes", &output, || {
        startup_complete(&output.lock().unwrap(), &home).then_some(())
    });
    assert!(
        process.0.try_wait().unwrap().is_none(),
        "{}",
        output.lock().unwrap()
    );
    assert!(sessions.sessions().is_empty());
    config.install().unwrap();
    input.write_all(b"/reload\r").unwrap();
    input.flush().unwrap();
    let row = until("hot-loaded Pi discovery", &output, || {
        sessions.sessions().into_iter().next()
    });
    let binding = pi::binding(&config, &*table, uid, &row.target.id).unwrap();
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
    until("first model request", &output, || {
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
        "busy Pi must not be interrupted"
    );
    match send("message-1", "[via Agent Relay] First test") {
        InjectOutcome::Delivered => {
            let saved =
                fs::read_to_string(&session).expect("acknowledgement requires a saved transcript");
            assert!(
                saved
                    .lines()
                    .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                    .any(|entry| entry["type"] == "message" && entry["message"]["role"] == "user"),
                "in-memory history is not sufficient to acknowledge a delivery"
            );
        }
        InjectOutcome::Accepted(_) => {} // Legacy Pi has not saved its first user entry yet.
        other => panic!("Unexpected first-message outcome: {other:?}"),
    }
    let pending: Value = fs::read_dir(&binding.directory)
        .unwrap()
        .flatten()
        .filter_map(|e| fs::read(e.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .find(|record| record["messageId"] == "message-2")
        .unwrap();
    assert_eq!(
        pending["state"], "pending",
        "busy Pi must not claim the next message"
    );
    assert!(injector
        .final_answer_registered(&agent, &MessageRef::of("message-1"))
        .is_none());
    release.store(true, Ordering::SeqCst);
    until("second completed answer", &output, || {
        injector.final_answer_registered(&agent, &MessageRef::of("message-2"))
    });
    assert_eq!(
        injector.final_answer_registered(&agent, &MessageRef::of("message-1")),
        Some("pi-test-reply-1".into())
    );
    assert_eq!(
        injector.final_answer_registered(&agent, &MessageRef::of("message-2")),
        Some("pi-test-reply-2".into())
    );
    assert_eq!(
        send("message-2", "[via Agent Relay] Busy test"),
        InjectOutcome::Delivered
    );
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let transcript = fs::read_to_string(&session).unwrap();
    let entries: Vec<Value> = transcript
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    assert_eq!(
        entries
            .iter()
            .filter(|e| e["type"] == "message" && e["message"]["role"] == "user")
            .count(),
        2
    );
    input.write_all(b"/reload\r").unwrap();
    input.flush().unwrap();
    let replacement = until("reload changes runtime identity", &output, || {
        pi::binding(&config, &*table, uid, &agent.target.id)
            .filter(|b| b.reference != binding.reference)
    });
    assert_eq!(
        send("message-2", "[via Agent Relay] Busy test"),
        InjectOutcome::Delivered,
        "confirmed deliveries must settle after their old runtime reloads"
    );
    assert!(matches!(
        send("message-3", "Must not send"),
        InjectOutcome::Refused(_)
    ));
    let new_agent = registration(&agent.target.id, &replacement.reference);
    assert!(matches!(
        injector.inject_registered(
            &new_agent,
            "message-3",
            "message-3",
            "[via Agent Relay] After reload"
        ),
        InjectOutcome::Accepted(_)
    ));
    until("answer after reload", &output, || {
        injector.final_answer_registered(&new_agent, &MessageRef::of("message-3"))
    });
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    input.write_all(b"/new\r").unwrap();
    input.flush().unwrap();
    let switched = until("session switch publishes a new target", &output, || {
        sessions
            .sessions()
            .into_iter()
            .find(|row| row.target.id != agent.target.id)
    });
    assert!(matches!(
        send("old-session", "Must not follow /new"),
        InjectOutcome::Waiting(_)
    ));
    let switched_binding = sessions.route_binding(&switched.target).unwrap();
    let switched_agent = registration(&switched.target.id, &switched_binding);
    assert!(matches!(
        injector.inject_registered(
            &switched_agent,
            "message-4",
            "message-4",
            "[via Agent Relay] New session"
        ),
        InjectOutcome::Accepted(_)
    ));
    until("answer in the new session", &output, || {
        injector.final_answer_registered(&switched_agent, &MessageRef::of("message-4"))
    });
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    process.0.kill().unwrap();
    process.0.wait().unwrap();
    assert!(sessions.sessions().is_empty());
    assert_eq!(
        injector.inject_registered(
            &new_agent,
            "message-3",
            "message-3",
            "[via Agent Relay] After reload"
        ),
        InjectOutcome::Delivered,
        "confirmed deliveries must settle after Pi exits"
    );
    assert_eq!(
        injector.final_answer_registered(&new_agent, &MessageRef::of("message-3")),
        Some("pi-test-reply-3".into())
    );
}
