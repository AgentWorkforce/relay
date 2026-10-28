//! A live run against a real Codex in an isolated `CODEX_HOME`, by hand:
//!
//! ```text
//! RELAY_LIVE_CODEX_HOME=/tmp/live/home cargo test --lib live_turn_hook -- --ignored --nocapture
//! ```
//!
//! The home needs Codex's sign-in (`auth.json`) and nothing else; never
//! point it at a real one. Agent Relay's hook is installed and trusted there
//! by the real settings, through Codex's own app-server; its command hands
//! each hook run to this test, which answers as the session socket would.
//! The router, rollout, process table and settlement are the real ones.

use super::*;
use crate::relay::agents::SettingsExtension;
use crate::relay::codex::stop_hook::CodexStopHookSettings;
use crate::relay::codex::turn_hook::{self, HookEvent, TurnInbox};
use crate::relay::process::SystemProcesses;
use std::time::Duration;

/// The hook command: writes Codex's input to `<dir>/<n>.in`, waits for the
/// test's `<dir>/<n>.out`, and prints it.
const HOOK: &str = r#"
import json, os, sys, time
box = sys.argv[1]
data = sys.stdin.read()
n = str(time.time_ns())
open(os.path.join(box, n + ".tmp"), "w").write(data)
os.rename(os.path.join(box, n + ".tmp"), os.path.join(box, n + ".in"))
out = os.path.join(box, n + ".out")
for _ in range(160):
    if os.path.exists(out):
        print(open(out).read())
        sys.exit(0)
    time.sleep(0.05)
print("{}")
"#;

fn newest_rollout(home: &Path) -> Option<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![home.join("sessions")];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(directory).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                found.push(path);
            }
        }
    }
    found.sort();
    found.pop()
}

#[test]
#[ignore = "runs a real Codex; set RELAY_LIVE_CODEX_HOME to an isolated home"]
fn a_live_codex_turn_takes_a_message_at_its_next_tool_call() {
    let Some(home) = std::env::var_os("RELAY_LIVE_CODEX_HOME").map(PathBuf::from) else {
        return;
    };
    let scratch = tempfile::tempdir().unwrap();
    let (hook, mailbox, work) = (
        scratch.path().join("hook.py"),
        scratch.path().join("box"),
        scratch.path().join("work"),
    );
    std::fs::write(&hook, HOOK).unwrap();
    std::fs::create_dir_all(&mailbox).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    let command = format!("python3 -I '{}' '{}'", hook.display(), mailbox.display());

    let inbox = Arc::new(StopHookInbox::with_turns(TurnInbox::open(
        scratch.path().join(turn_hook::RECORD),
    )));
    let settings = CodexStopHookSettings::new(home.clone(), command, None, inbox.clone());
    assert_eq!(settings.set(stop_hook::SETTING, &json!(true)), Some(Ok(())));
    assert!(inbox.is_ready(), "installed and trusted through Codex");

    // Answers each hook run as the session socket would.
    let done = Arc::new(AtomicBool::new(false));
    let events = Arc::new(Mutex::new(Vec::<String>::new()));
    let answering = {
        let (inbox, mailbox, done, events) =
            (inbox.clone(), mailbox.clone(), done.clone(), events.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                for entry in std::fs::read_dir(&mailbox).unwrap().flatten() {
                    let path = entry.path();
                    if path.extension().is_none_or(|e| e != "in") {
                        continue;
                    }
                    let input: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                    let event = input["hook_event_name"].as_str().unwrap_or("").to_string();
                    let thread = input["session_id"].as_str().unwrap_or("").to_string();
                    let answer = HookEvent::named(Some(&event))
                        .map(|event| inbox.turns().answer(&thread, event))
                        .unwrap_or_else(|| json!({}));
                    events.lock().unwrap().push(format!("{event} -> {answer}"));
                    std::fs::write(path.with_extension("out"), answer.to_string()).unwrap();
                    std::fs::remove_file(&path).unwrap();
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
    };

    let codex = std::env::var_os("RELAY_LIVE_CODEX")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/opt/homebrew/bin/codex"));
    let run = std::process::Command::new(&codex)
        .args([
            "exec",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "Run the shell command `sleep 25`, then the shell command `echo second`, as two \
             separate tool calls. Then answer in one short sentence. If a message reached you \
             through Agent Relay meanwhile, end your answer with its last word.",
        ])
        .env("CODEX_HOME", &home)
        .current_dir(&work)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    let config = CodexConfig {
        home: home.clone(),
        sqlite_home: home.clone(),
        executable: Some(codex.clone()),
        ipc_socket: scratch.path().join("ipc.sock"),
    };
    let routes = Arc::new(SystemCodexRoutes::new(
        config.clone(),
        Arc::new(SystemProcesses::default()),
        nix::unistd::getuid().as_raw(),
    ));
    let router = CodexRouter::new(routes.clone()).with_stop_hook(inbox.clone());

    // The turn is under way once its rollout says so.
    let mut thread = None;
    for _ in 0..600 {
        if let Some(path) = newest_rollout(&home) {
            let id = path.file_stem().unwrap().to_string_lossy();
            let id = id[id.len() - 36..].to_string();
            if !routes.idle(&id) {
                thread = Some(id);
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let thread = thread.expect("a running turn");
    assert!(
        routes.thread_live(&thread),
        "the exec process holds the thread"
    );
    let id = format!("live-{}", std::process::id());
    let text = format!(
        "[via Agent Relay — from @live-test · ref {}]\n\nPlease end your answer with the word PAPAYA.",
        MessageRef::of(&id)
    );
    let offered = router.inject_with(&thread, &id, &text, &|| None);
    println!("while the turn runs: {offered:?}");
    assert_eq!(
        offered,
        InjectOutcome::WaitingForTurn(turn_hook::WAITING.into())
    );

    let output = run.wait_with_output().unwrap();
    done.store(true, Ordering::SeqCst);
    answering.join().unwrap();
    let answer = String::from_utf8_lossy(&output.stdout).to_string();
    println!("hooks: {:#?}\nanswer: {answer}", events.lock().unwrap());

    let settled = router.inject_with(&thread, &id, &text, &|| None);
    println!("after the turn: {settled:?}");
    assert_eq!(settled, InjectOutcome::Delivered);
    assert!(rollout::recorded(&config, &thread, &MessageRef::of(&id)));
    assert!(answer.contains("PAPAYA"), "{answer}");
    assert_eq!(routes.relay_waiting(&thread), Some(false), "never queued");
    assert_eq!(
        settings.set(stop_hook::SETTING, &json!(false)),
        Some(Ok(()))
    );
}
