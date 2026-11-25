use super::*;

const A: &str = "01a21142-16fe-7e80-b155-63c55d494a65";
const B: &str = "01a21131-493f-7f80-a01b-d9e5a4779f64";
const CALL: &str = "exec-3825de52-905d-4ec1-b9bd-8e3b0af585a9";

fn status(thread: &str, kind: &str) -> Value {
    json!({"method": "thread/status/changed",
        "params": {"threadId": thread, "status": {"type": kind}}})
}

fn command(method: &str, thread: &str, call: &str, state: &str) -> Value {
    json!({"method": method, "params": {"threadId": thread, "turnId": "t",
        "item": {"type": "commandExecution", "id": call, "status": state}}})
}

fn ok(id: i64) -> Value {
    json!({"id": id, "result": {}})
}

fn method(request: &Value) -> &str {
    request["method"].as_str().unwrap()
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
fn a_command_runs_for_its_own_chat_only_while_it_runs() {
    let mut watch = subscribed(A);
    let now = Instant::now();
    assert!(!watch.runs(A, CALL));
    watch.on_message(&command("item/started", A, CALL, "inProgress"), now);
    assert!(watch.runs(A, CALL));
    assert!(watch.runs(&A.to_uppercase(), CALL));
    // Another chat on the same app-server cannot claim it.
    assert!(!watch.runs(B, CALL));
    watch.on_message(&command("item/completed", A, CALL, "completed"), now);
    assert!(!watch.runs(A, CALL));
}

#[test]
fn only_command_items_count() {
    let mut watch = subscribed(A);
    let mut message = command("item/started", A, CALL, "inProgress");
    message["params"]["item"]["type"] = json!("agentMessage");
    watch.on_message(&message, Instant::now());
    assert!(!watch.runs(A, CALL));
    // Nor an id no Codex tool call would have.
    watch.on_message(
        &command("item/started", A, "exec-1; rm -rf /", "inProgress"),
        Instant::now(),
    );
    assert!(watch.running.is_empty());
}

#[test]
fn an_idle_chat_is_unsubscribed_and_forgets_its_commands() {
    let mut watch = subscribed(A);
    let now = Instant::now();
    watch.on_message(&command("item/started", A, CALL, "inProgress"), now);
    let sent = watch.on_message(&status(A, "idle"), now);
    assert_eq!(sent.len(), 1);
    assert_eq!(method(&sent[0]), "thread/unsubscribe");
    assert_eq!(sent[0]["params"]["threadId"], A);
    assert!(!watch.runs(A, CALL));
    // Idle again (or unloaded) asks nothing more.
    assert!(watch.on_message(&status(A, "notLoaded"), now).is_empty());
}

#[test]
fn a_chat_already_mid_turn_at_connect_is_subscribed() {
    let mut watch = Watch::new();
    let now = Instant::now();
    let reads = watch.on_loaded(&[A.to_string(), B.to_string()]);
    assert_eq!(reads.len(), 2);
    assert!(reads.iter().all(|r| method(r) == "thread/read"));
    let active =
        json!({"id": reads[0]["id"], "result": {"thread": {"status": {"type": "active"}}}});
    let idle = json!({"id": reads[1]["id"], "result": {"thread": {"status": {"type": "idle"}}}});
    let sent = watch.on_message(&active, now);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["params"]["threadId"], A);
    assert!(watch.on_message(&idle, now).is_empty());
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
    // A success subscribes.
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
    assert!(!watch.runs(A, "exec-0"));
    assert!(watch.runs(A, &format!("exec-{MAX_RUNNING}")));
}

#[test]
fn call_ids_are_short_plain_tokens() {
    assert!(is_call_id(CALL));
    assert!(is_call_id("call_abc123"));
    assert!(!is_call_id(""));
    assert!(!is_call_id("exec 1"));
    assert!(!is_call_id(&"x".repeat(129)));
}
