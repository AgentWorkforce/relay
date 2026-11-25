use super::*;

const A: &str = "01a21142-16fe-7e80-b155-63c55d494a65";
const B: &str = "01a21131-493f-7f80-a01b-d9e5a4779f64";
const CALL: &str = "exec-3825de52-905d-4ec1-b9bd-8e3b0af585a9";
const STARTED: i64 = 1_795_589_784_817;
const LINE: &str = "/bin/zsh -lc 'agent-relay-probe whoami --socket /tmp/relay.sock'";

fn status(thread: &str, kind: &str) -> Value {
    json!({"method": "thread/status/changed",
        "params": {"threadId": thread, "status": {"type": kind}}})
}

fn command(method: &str, thread: &str, call: &str, state: &str) -> Value {
    json!({"method": method, "params": {"threadId": thread, "turnId": "t",
        "item": {"type": "commandExecution", "id": call, "status": state,
            "command": LINE, "startedAtMs": STARTED}}})
}

fn ok(id: i64) -> Value {
    json!({"id": id, "result": {}})
}

fn method(request: &Value) -> &str {
    request["method"].as_str().unwrap()
}

/// The shell the app-server started for `LINE`, as the kernel shows it.
fn shell(pid: i32) -> Spawned {
    Spawned {
        pid,
        start: 7,
        start_ms: STARTED + 40,
        argv: vec![
            "/bin/zsh".into(),
            "-c".into(),
            "agent-relay-probe whoami --socket /tmp/relay.sock".into(),
        ],
    }
}

/// A watch subscribed to `thread`, as after an `active` status and the
/// resume's success.
fn subscribed(thread: &str) -> Watch {
    let mut watch = Watch::new();
    let now = Instant::now();
    let sent = watch.on_message(&status(thread, "active"), now);
    assert_eq!(sent.len(), 1);
    assert_eq!(method(&sent[0]), "thread/resume");
    assert_eq!(sent[0]["params"]["threadId"], thread);
    assert_eq!(sent[0]["params"]["excludeTurns"], true);
    let id = sent[0]["id"].as_i64().unwrap();
    assert!(watch.on_message(&ok(id), now).is_empty());
    watch
}

#[test]
fn a_command_vouches_for_the_process_its_chat_started_while_it_runs() {
    let mut watch = subscribed(A);
    let now = Instant::now();
    assert!(!watch.vouch(A, CALL, &shell(500)));
    watch.on_message(&command("item/started", A, CALL, "inProgress"), now);
    // Another chat on the same app-server cannot claim it.
    assert!(!watch.vouch(B, CALL, &shell(500)));
    assert!(watch.vouch(A, CALL, &shell(500)));
    assert!(watch.vouch(&A.to_uppercase(), CALL, &shell(500)));
    watch.on_message(&command("item/completed", A, CALL, "completed"), now);
    assert!(!watch.vouch(A, CALL, &shell(500)));
}

// A process that copied another chat's tags is not the process the
// app-server started for that command.
#[test]
fn copied_tags_do_not_make_another_process_the_command() {
    let mut watch = subscribed(A);
    watch.on_message(
        &command("item/started", A, CALL, "inProgress"),
        Instant::now(),
    );
    // A different command line (the impostor's own shell).
    let mut other = shell(600);
    other.argv[2] = "agent-relay-probe send --to x".into();
    assert!(!watch.vouch(A, CALL, &other));
    // Started well after the command was announced.
    let mut late = shell(600);
    late.start_ms = STARTED + START_SKEW_MS + 1;
    assert!(!watch.vouch(A, CALL, &late));
    // Once the real process has been vouched for, no other process can be,
    // even one with the same command line.
    assert!(watch.vouch(A, CALL, &shell(500)));
    assert!(!watch.vouch(A, CALL, &shell(600)));
    let mut reused = shell(500);
    reused.start = 8;
    assert!(!watch.vouch(A, CALL, &reused));
    assert!(watch.vouch(A, CALL, &shell(500)));
}

#[test]
fn the_process_is_the_shell_or_the_command_it_became() {
    let announced = shell_words::split(LINE).unwrap();
    let words = |line: &str| shell_words::split(line).unwrap();
    // The shell itself, which shows -c for -lc.
    assert!(runs_command(
        &announced,
        &words("/bin/zsh -c 'agent-relay-probe whoami --socket /tmp/relay.sock'")
    ));
    assert!(runs_command(&announced, &announced));
    // A shell that replaced itself with the lone command.
    assert!(runs_command(
        &announced,
        &words("agent-relay-probe whoami --socket /tmp/relay.sock")
    ));
    // Anything else.
    assert!(!runs_command(
        &announced,
        &words("/bin/bash -c 'agent-relay-probe whoami --socket /tmp/relay.sock'")
    ));
    assert!(!runs_command(
        &announced,
        &words("agent-relay-probe whoami")
    ));
    assert!(!runs_command(&announced, &[]));
    assert!(!runs_command(
        &words("/bin/zsh -x script"),
        &words("/bin/zsh -x script2")
    ));
}

#[test]
fn only_command_items_with_a_line_and_start_count() {
    let mut watch = subscribed(A);
    let mut message = command("item/started", A, CALL, "inProgress");
    message["params"]["item"]["type"] = json!("agentMessage");
    watch.on_message(&message, Instant::now());
    assert!(!watch.knows(CALL));
    let mut unstarted = command("item/started", A, CALL, "inProgress");
    unstarted["params"]["item"]["startedAtMs"] = Value::Null;
    watch.on_message(&unstarted, Instant::now());
    assert!(!watch.knows(CALL));
    // Nor an id no Codex tool call would have.
    watch.on_message(
        &command("item/started", A, "exec-1; rm -rf /", "inProgress"),
        Instant::now(),
    );
    assert!(watch.running.is_empty());
}

// The first command of a chat's next turn must be heard, so an idle chat
// stays followed; only an unloaded one is unsubscribed.
#[test]
fn an_idle_chat_stays_followed_until_it_unloads() {
    let mut watch = subscribed(A);
    let now = Instant::now();
    watch.on_message(&command("item/started", A, CALL, "inProgress"), now);
    assert!(watch.on_message(&status(A, "idle"), now).is_empty());
    assert!(!watch.knows(CALL));
    assert!(watch.subscribed.contains(A));
    // Active again: already subscribed, nothing to ask.
    assert!(watch.on_message(&status(A, "active"), now).is_empty());
    let sent = watch.on_message(&status(A, "notLoaded"), now);
    assert_eq!(sent.len(), 1);
    assert_eq!(method(&sent[0]), "thread/unsubscribe");
    assert_eq!(sent[0]["params"]["threadId"], A);
    assert!(watch.on_message(&status(A, "notLoaded"), now).is_empty());
}

#[test]
fn every_loaded_and_every_new_chat_is_followed() {
    let mut watch = Watch::new();
    let now = Instant::now();
    let sent = watch.on_loaded(&[A.to_string(), B.to_string(), "not-a-thread".to_string()]);
    assert_eq!(sent.len(), 2);
    assert!(sent.iter().all(|r| method(r) == "thread/resume"));
    // A resume already on its way is not asked again.
    assert!(watch.on_message(&status(A, "active"), now).is_empty());
    let new = "01a21160-39a0-73a1-af03-6e1abbb0ed22";
    let started = json!({"method": "thread/started", "params": {"thread": {"id": new}}});
    let sent = watch.on_message(&started, now);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["params"]["threadId"], new);
}

#[test]
fn a_resume_before_the_rollout_exists_is_tried_again() {
    let mut watch = Watch::new();
    let start = Instant::now();
    let sent = watch.on_message(&status(A, "active"), start);
    let id = sent[0]["id"].as_i64().unwrap();
    let refused = json!({"id": id, "error": {"code": -32600, "message": "no rollout found"}});
    assert!(watch.on_message(&refused, start).is_empty());
    assert!(watch.due(start).is_empty());
    let retried = watch.due(start + RESUME_RETRY[0]);
    assert_eq!(retried.len(), 1);
    assert_eq!(method(&retried[0]), "thread/resume");
    // Each failure waits longer; past the last wait it gives up.
    let mut at = start + RESUME_RETRY[0];
    let mut pending = retried;
    for wait in &RESUME_RETRY[1..] {
        let id = pending[0]["id"].as_i64().unwrap();
        let refused = json!({"id": id, "error": {"message": "no rollout found"}});
        watch.on_message(&refused, at);
        at += *wait;
        pending = watch.due(at);
        assert_eq!(pending.len(), 1);
    }
    let id = pending[0]["id"].as_i64().unwrap();
    watch.on_message(&json!({"id": id, "error": {"message": "no"}}), at);
    assert!(watch.due(at + Duration::from_secs(60)).is_empty());
    // A later activation subscribes.
    let sent = watch.on_message(&status(A, "active"), at);
    let id = sent[0]["id"].as_i64().unwrap();
    watch.on_message(&ok(id), at);
    assert!(watch.subscribed.contains(A));
}

#[test]
fn the_table_of_running_commands_is_bounded() {
    let mut watch = subscribed(A);
    let start = Instant::now();
    for n in 0..=MAX_RUNNING {
        watch.on_message(
            &command("item/started", A, &format!("exec-{n}"), "inProgress"),
            start + Duration::from_millis(n as u64),
        );
    }
    assert_eq!(watch.running.len(), MAX_RUNNING);
    assert!(!watch.knows("exec-0"));
    assert!(watch.knows(&format!("exec-{MAX_RUNNING}")));
}

#[test]
fn call_ids_are_short_plain_tokens() {
    assert!(is_call_id(CALL));
    assert!(is_call_id("call_abc123"));
    assert!(!is_call_id(""));
    assert!(!is_call_id("exec 1"));
    assert!(!is_call_id(&"x".repeat(129)));
}
