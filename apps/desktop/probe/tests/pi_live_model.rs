//! Opt-in paid-model test: real Pi TUI, OpenAI, built-in tools, and Relay injection.
//! Requires RELAY_PI_CLI and credentials. Never runs in ordinary CI.
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
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
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
    let deadline = Instant::now() + Duration::from_secs(180);
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

fn registration(id: &str, binding: &str) -> Registration {
    serde_json::from_value(json!({"name":"pi-e2e", "agentID":"test-agent", "target":{"kind":"pi","id":id},
        "baseURL":"https://cast.agentrelay.com", "registeredAt":"2026-10-20T00:00:00Z", "routeBinding":binding})).unwrap()
}

fn entries(session: &std::path::Path) -> Vec<Value> {
    fs::read_to_string(session)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[test]
#[ignore = "live model: requires RELAY_PI_CLI and credentials"]
fn live_model_uses_tools_and_answers_relay_in_an_existing_pi() {
    let cli = std::env::var("RELAY_PI_CLI").expect("set RELAY_PI_CLI");
    let api_key = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|key| !key.is_empty());
    let auth_file = std::env::var("RELAY_PI_AUTH_FILE").ok();
    assert!(
        api_key.is_some() || auth_file.is_some(),
        "set OPENAI_API_KEY or RELAY_PI_AUTH_FILE"
    );
    let provider = std::env::var("RELAY_PI_PROVIDER").unwrap_or_else(|_| "openai".into());
    let model = std::env::var("RELAY_PI_MODEL").unwrap_or_else(|_| "gpt-4.1-mini".into());
    let node = std::env::var("RELAY_PI_NODE").unwrap_or_else(|_| "node".into());
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
    let config = PiConfig::from_env(&|_| None, &home);
    fs::create_dir_all(&config.agent_dir).unwrap();
    if let Ok(path) = std::env::var("RELAY_PI_MODELS_FILE") {
        fs::copy(path, config.agent_dir.join("models.json")).expect("copy test model catalog");
    }
    if let Some(path) = auth_file {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(config.agent_dir.join("auth.json"))
            .unwrap();
        file.write_all(&fs::read(path).expect("read isolated Pi auth source"))
            .unwrap();
    }
    fs::write(
        config.agent_dir.join("settings.json"),
        json!({"quietStartup":true,"lastChangelogVersion":"999.0.0"}).to_string(),
    )
    .unwrap();
    let challenge = format!(
        "pi-live-{}",
        temp.path().file_name().unwrap().to_string_lossy()
    );
    fs::write(home.join("challenge.txt"), &challenge).unwrap();
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
        &provider,
        "--model",
        &model,
        "--tools",
        "read,bash,write",
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
    if let Some(key) = api_key {
        command.env("OPENAI_API_KEY", key);
    }
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
    let local = LocalConfig::from_env(&|_| None, &home);
    let sessions = LocalSessions::new(local.clone(), table.clone());
    let codex = CodexRouter::new(Arc::new(SystemCodexRoutes::new(
        local.codex.clone(),
        table.clone(),
        current_uid(),
    )));
    let injector = LocalInjector::new(local, table.clone(), codex, ServingPath::default());
    std::thread::sleep(Duration::from_secs(3));
    assert!(
        process.0.try_wait().unwrap().is_none(),
        "Pi exited before hot-load"
    );
    assert!(sessions.sessions().is_empty());
    config.install().unwrap();
    input.write_all(b"/reload\r").unwrap();
    input.flush().unwrap();
    let row = until("hot-loaded live Pi discovery", &output, || {
        sessions.sessions().into_iter().next()
    });
    let binding = pi::binding(&config, &*table, current_uid(), &row.target.id).unwrap();
    let agent = registration(&row.target.id, &binding.reference);
    let first = "[via Agent Relay] This is an integration test in a temporary workspace. Use the read tool to read challenge.txt. Then use the bash tool to run exactly `sleep 5; cat challenge.txt` (do not background it). Then use the write tool to create result.txt containing exactly the challenge text followed by |verified, without a newline. Do not access any other files or credentials. Finally answer with only LIVE_PI_OK: followed by the challenge text. All three tools must actually be called.";
    let second = "[via Agent Relay] Follow-up integration test: use the read tool to read result.txt, then use the write tool to create confirmation.txt with exactly the same contents, no newline. Do not access other files. Finally answer with only LIVE_PI_FOLLOWUP_OK.";
    let third = "[via Agent Relay] Final integration test: use the read tool to read confirmation.txt written by the previous follow-up, then use write to create final-confirmation.txt with exactly the same contents, no newline. Do not access other files. Finally answer with only LIVE_PI_THIRD_OK.";
    assert!(matches!(
        injector.inject_registered(&agent, "live-1", "live-1", first),
        InjectOutcome::Accepted(_)
    ));
    until("live model calls bash", &output, || {
        let saved = entries(&session);
        assert!(
            !saved.iter().any(|e| e["message"]["stopReason"] == "error"),
            "Live provider request failed; check provider credentials and model access"
        );
        saved
            .iter()
            .any(|entry| {
                entry["message"]["content"].as_array().is_some_and(|parts| {
                    parts
                        .iter()
                        .any(|p| p["type"] == "toolCall" && p["name"] == "bash")
                })
            })
            .then_some(())
    });
    assert!(
        injector
            .final_answer_registered(&agent, &MessageRef::of("live-1"))
            .is_none(),
        "tool progress must not become a final reply"
    );
    assert!(matches!(
        injector.inject_registered(&agent, "live-2", "live-2", second),
        InjectOutcome::Accepted(_)
    ));
    assert!(matches!(
        injector.inject_registered(&agent, "live-3", "live-3", third),
        InjectOutcome::Accepted(_)
    ));
    std::thread::sleep(Duration::from_millis(700));
    let pending = fs::read_dir(&binding.directory)
        .unwrap()
        .flatten()
        .filter_map(|e| fs::read(e.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .find(|r| r["messageId"] == "live-2")
        .unwrap();
    assert_eq!(
        pending["state"], "pending",
        "follow-up must wait while a tool is running"
    );
    let first_answer = until("first live final answer", &output, || {
        injector.final_answer_registered(&agent, &MessageRef::of("live-1"))
    });
    let second_answer = until("follow-up live final answer", &output, || {
        injector.final_answer_registered(&agent, &MessageRef::of("live-2"))
    });
    let third_answer = until("third live final answer in arrival order", &output, || {
        injector.final_answer_registered(&agent, &MessageRef::of("live-3"))
    });
    assert_eq!(third_answer.trim(), "LIVE_PI_THIRD_OK");
    assert_eq!(first_answer.trim(), format!("LIVE_PI_OK:{challenge}"));
    assert_eq!(second_answer.trim(), "LIVE_PI_FOLLOWUP_OK");
    let expected = format!("{challenge}|verified");
    assert_eq!(
        fs::read_to_string(home.join("result.txt")).unwrap(),
        expected
    );
    assert_eq!(
        fs::read_to_string(home.join("confirmation.txt")).unwrap(),
        expected
    );
    assert_eq!(
        fs::read_to_string(home.join("final-confirmation.txt")).unwrap(),
        expected
    );
    for (id, text) in [("live-1", first), ("live-2", second), ("live-3", third)] {
        assert_eq!(
            injector.inject_registered(&agent, id, id, text),
            InjectOutcome::Delivered
        );
    }
    std::thread::sleep(Duration::from_millis(500));
    let saved = entries(&session);
    assert_eq!(
        saved
            .iter()
            .filter(|e| e["type"] == "message" && e["message"]["role"] == "user")
            .count(),
        3,
        "delivery retry must not cause another model turn"
    );
    let prompts: Vec<String> = saved
        .iter()
        .filter(|e| e["message"]["role"] == "user")
        .map(|e| {
            e["message"]["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    assert!(prompts[0].contains(first) && prompts[1].contains(second) && prompts[2].contains(third),
        "two follow-ups queued while busy must preserve arrival order despite opposite digest order");
    let tools: Vec<String> = saved
        .iter()
        .filter(|e| e["message"]["role"] == "toolResult")
        .map(|e| {
            assert_ne!(e["message"]["isError"], true, "tool failed");
            e["message"]["toolName"].as_str().unwrap().to_owned()
        })
        .collect();
    for name in ["read", "bash", "write"] {
        assert!(tools.iter().any(|t| t == name), "missing {name} execution");
    }
    let assistant: Vec<&Value> = saved
        .iter()
        .filter(|e| e["message"]["role"] == "assistant")
        .map(|e| &e["message"])
        .collect();
    assert!(!assistant.is_empty());
    for message in &assistant {
        assert_eq!(message["provider"], provider);
        assert_eq!(message["model"], model);
    }
    let output_tokens: u64 = assistant
        .iter()
        .filter_map(|m| m["usage"]["output"].as_u64())
        .sum();
    assert!(output_tokens > 0, "live model must report generated tokens");
    let summary = json!({"provider":provider,"model":model,"cli":cli,
        "modelResponses":assistant.len(),"outputTokens":output_tokens,
        "tools":tools,"userTurns":3,"queuedOrderVerified":true,"thirdAnswer":third_answer,"firstAnswer":first_answer,"followUpAnswer":second_answer,
        "hotLoaded":true,"busyFollowUpWaited":true,"duplicateSuppressed":true,
        "resultVerified":true,"confirmationVerified":true});
    if let Ok(dir) = std::env::var("RELAY_PI_EVIDENCE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        fs::copy(&session, dir.join("conversation.jsonl")).unwrap();
        fs::write(
            dir.join("summary.json"),
            serde_json::to_vec_pretty(&summary).unwrap(),
        )
        .unwrap();
    }
    println!("Live Pi evidence: {summary}");
    process.0.kill().unwrap();
    process.0.wait().unwrap();
    assert_eq!(
        injector.inject_registered(&agent, "live-1", "live-1", first),
        InjectOutcome::Delivered
    );
    assert_eq!(
        injector.final_answer_registered(&agent, &MessageRef::of("live-1")),
        Some(first_answer)
    );
}
