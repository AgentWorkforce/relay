use super::*;
use serde_json::json;

const A: &str = "01a21541-df2b-7810-8794-0d01d9b98df9";
const B: &str = "01a2161e-8be1-7700-b7b9-a35c751fd80d";
const SCRIPT: &str = "/opt/relay/agent-relay-probe send --socket '/tmp/relay sock' --to lead --body \"hi \\\"there\\\"\"";
/// When the command's shell started, in milliseconds since the epoch.
const STARTED: i64 = 1_795_652_993_993;

fn at(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn event(ms: i64, kind: &str) -> String {
    json!({"timestamp": at(ms), "type": "event_msg", "payload": {"type": kind}}).to_string()
}

/// A code-mode `exec` call whose script runs `script`, as Codex records it.
fn exec(ms: i64, call: &str, script: &str) -> String {
    let input = format!(
        "const r=await tools.exec_command({{cmd:{}}}); text(r.output)",
        serde_json::to_string(script).unwrap()
    );
    json!({"timestamp": at(ms), "type": "response_item", "payload": {
        "type": "custom_tool_call", "status": "completed", "call_id": call,
        "name": "exec", "input": input}})
    .to_string()
}

fn function(ms: i64, call: &str, script: &str) -> String {
    let arguments = json!({"cmd": script, "yield_time_ms": 1000}).to_string();
    json!({"timestamp": at(ms), "type": "response_item", "payload": {
        "type": "function_call", "name": "exec_command", "call_id": call,
        "arguments": arguments}})
    .to_string()
}

fn output(ms: i64, kind: &str, call: &str) -> String {
    json!({"timestamp": at(ms), "type": "response_item", "payload": {
        "type": kind, "call_id": call, "output": "done"}})
    .to_string()
}

fn rollout(dir: &Path, thread: &str, lines: &[String]) -> PathBuf {
    let path = dir.join(format!("rollout-2026-11-25T16-29-28-{thread}.jsonl"));
    let mut text = json!({"timestamp": at(STARTED - 600_000), "type": "session_meta",
        "payload": {"id": thread}})
    .to_string();
    text.push('\n');
    for line in lines {
        text.push_str(line);
        text.push('\n');
    }
    std::fs::write(&path, text).unwrap();
    path
}

/// The shell Codex started for `script`, as the kernel shows it.
fn shell(pid: i32, script: &str) -> Spawned {
    Spawned {
        pid,
        start: pid as u64 * 1_000,
        start_ms: STARTED,
        argv: vec!["/bin/zsh".into(), "-c".into(), script.into()],
    }
}

fn rollouts(paths: &[(&str, &PathBuf)]) -> BTreeMap<String, PathBuf> {
    paths
        .iter()
        .map(|(thread, path)| (thread.to_string(), (*path).clone()))
        .collect()
}

#[test]
fn a_js_string_literal_is_read_as_the_script_it_spells() {
    let source = r#"// "not this"
const a = "say \"hi\"\n\ttab \x41\u0042\u{43}"; /* 'nor this' */
const b = 'it\'s'; const c = `plain`; const d = `with ${"x" + `y${1}`} sub`;
const e = "\ud83d\ude00";"#;
    assert_eq!(
        js_string_literals(source),
        vec![
            "say \"hi\"\n\ttab ABC".to_string(),
            "it's".into(),
            "plain".into(),
            "😀".into()
        ]
    );
}

#[test]
fn a_script_runs_as_the_shell_or_as_its_lone_command() {
    let argv = |words: &[&str]| words.iter().map(|w| w.to_string()).collect::<Vec<_>>();
    assert!(script_runs(
        "echo hi && true",
        &argv(&["/bin/zsh", "-lc", "echo hi && true"])
    ));
    assert!(script_runs(
        "echo hi && true",
        &argv(&["bash", "-c", "echo hi && true"])
    ));
    assert!(script_runs(
        "kubectl get 'a b'",
        &argv(&["kubectl", "get", "a b"])
    ));
    assert!(script_runs(
        "Get-Item x",
        &argv(&["C:\\pwsh.exe", "-NoProfile", "-Command", "Get-Item x"])
    ));
    // Not a shell, or not the same script.
    assert!(!script_runs(
        "echo hi",
        &argv(&["/usr/bin/env", "-c", "echo hi"])
    ));
    assert!(!script_runs(
        "echo hi",
        &argv(&["/bin/zsh", "-lc", "echo hi; id"])
    ));
    assert!(!script_runs("", &argv(&["/bin/zsh", "-lc", ""])));
}

#[test]
fn only_calls_without_output_in_the_current_turn_are_pending() {
    let dir = tempfile::tempdir().unwrap();
    let path = rollout(
        dir.path(),
        A,
        &[
            event(STARTED - 9_000, "task_started"),
            exec(STARTED - 8_000, "call_old", SCRIPT),
            event(STARTED - 7_000, "task_complete"),
            event(STARTED - 5_000, "task_started"),
            exec(STARTED - 4_000, "call_done", "ls"),
            output(STARTED - 3_000, "custom_tool_call_output", "call_done"),
            function(STARTED - 100, "call_fn", "pwd"),
            exec(STARTED - 40, "call_now", SCRIPT),
        ],
    );
    let pending = pending_calls(&path).unwrap();
    let calls: Vec<&str> = pending.iter().map(|p| p.call.as_str()).collect();
    assert_eq!(calls, vec!["call_fn", "call_now"]);
    assert_eq!(pending[1].recorded_ms, STARTED - 40);
    assert!(pending[1].requested(&shell(1, SCRIPT).argv));
    assert!(pending[0].requested(&["/bin/bash".into(), "-lc".into(), "pwd".into()]));
    // A finished turn leaves nothing pending.
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            std::io::Write::write_all(
                &mut file,
                (event(STARTED + 10, "turn_aborted") + "\n").as_bytes(),
            )
        })
        .unwrap();
    assert_eq!(pending_calls(&path), Some(Vec::new()));
}

#[test]
fn a_turn_longer_than_the_tail_leaves_its_chat_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let filler = "x".repeat(64 * 1024);
    let mut lines = vec![
        event(STARTED - 9_000, "task_started"),
        exec(STARTED - 40, "call_big", SCRIPT),
    ];
    let records = (MAX_TAIL / filler.len() as u64) as usize + 2;
    lines.extend((0..records).map(|n| {
        json!({"timestamp": at(STARTED), "type": "event_msg", "payload": {
            "type": "item_completed", "n": n, "text": filler}})
        .to_string()
    }));
    let path = rollout(dir.path(), A, &lines);
    assert_eq!(pending_calls(&path), None);
    // A broken record inside the current turn does the same.
    let path = rollout(
        dir.path(),
        B,
        &[
            event(STARTED - 9_000, "task_started"),
            "{not json".into(),
            exec(STARTED - 40, "c", SCRIPT),
        ],
    );
    assert_eq!(pending_calls(&path), None);
}

#[test]
fn the_one_chat_whose_pending_call_asked_for_the_command_is_named() {
    let dir = tempfile::tempdir().unwrap();
    let a = rollout(
        dir.path(),
        A,
        &[
            event(STARTED - 5_000, "task_started"),
            exec(STARTED - 40, "call_a", SCRIPT),
        ],
    );
    let b = rollout(
        dir.path(),
        B,
        &[
            event(STARTED - 5_000, "task_started"),
            exec(STARTED - 900, "call_b", "sleep 60"),
        ],
    );
    let held = rollouts(&[(A, &a), (B, &b)]);
    let wait = Duration::from_millis(0);
    assert_eq!(vouch(&held, A, &shell(7_001, SCRIPT), 50, wait), Ok(()));
    // The same process asks again: still that chat.
    assert_eq!(vouch(&held, A, &shell(7_001, SCRIPT), 50, wait), Ok(()));
    // Another process running the same command line: the call is bound.
    assert_eq!(
        vouch(&held, A, &shell(7_002, SCRIPT), 50, wait),
        Err(Refusal::AlreadyBound)
    );
    // The other chat claiming this command: it did not ask for it.
    assert_eq!(
        vouch(&held, B, &shell(7_003, SCRIPT), 50, wait),
        Err(Refusal::OtherChats(vec![A.to_string()]))
    );
    // A command no chat asked for: nobody.
    assert_eq!(
        vouch(
            &held,
            A,
            &shell(7_004, "agent-relay-probe whoami"),
            50,
            wait
        ),
        Err(Refusal::NotSeen)
    );
}

#[test]
fn a_chat_copying_another_chats_thread_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let script = "agent-relay-probe register --name impostor";
    // The impostor chat B runs the command with A's CODEX_THREAD_ID, while A
    // happens to ask for the same command line: both asked for it.
    let a = rollout(
        dir.path(),
        A,
        &[
            event(STARTED - 5_000, "task_started"),
            function(STARTED - 30, "call_a", script),
        ],
    );
    let b = rollout(
        dir.path(),
        B,
        &[
            event(STARTED - 5_000, "task_started"),
            exec(STARTED - 20, "call_b", script),
        ],
    );
    let held = rollouts(&[(A, &a), (B, &b)]);
    let wait = Duration::from_millis(0);
    assert_eq!(
        vouch(&held, A, &shell(8_001, script), 50, wait),
        Err(Refusal::OtherChats(vec![B.to_string()]))
    );
    // Only B asked: B's command claiming A is refused.
    let a = rollout(dir.path(), A, &[event(STARTED - 5_000, "task_started")]);
    let held = rollouts(&[(A, &a), (B, &b)]);
    assert_eq!(
        vouch(&held, A, &shell(8_002, script), 50, wait),
        Err(Refusal::OtherChats(vec![B.to_string()]))
    );
    // A call recorded after the process started did not start it.
    let a = rollout(
        dir.path(),
        A,
        &[
            event(STARTED - 5_000, "task_started"),
            exec(STARTED + 500, "call_late", script),
        ],
    );
    let b = rollout(dir.path(), B, &[event(STARTED - 5_000, "task_started")]);
    let held = rollouts(&[(A, &a), (B, &b)]);
    assert_eq!(
        vouch(&held, A, &shell(8_003, script), 50, wait),
        Err(Refusal::NotSeen)
    );
    // A held chat whose transcript cannot be read leaves every caller
    // refused, so its own pending calls cannot hide.
    let a = rollout(
        dir.path(),
        A,
        &[
            event(STARTED - 5_000, "task_started"),
            exec(STARTED - 40, "call_a2", script),
        ],
    );
    let held = rollouts(&[(A, &a), (B, &dir.path().join("missing.jsonl"))]);
    assert_eq!(
        vouch(&held, A, &shell(8_004, script), 50, wait),
        Err(Refusal::Unknown(B.to_string()))
    );
    // A chat the app-server holds no rollout of.
    assert_eq!(
        vouch(&rollouts(&[(B, &b)]), A, &shell(8_005, script), 50, wait),
        Err(Refusal::NoOpenRollout)
    );
}

#[test]
fn each_held_lock_needs_its_own_open_rollout() {
    let dir = Path::new("/Users/me/.codex/sessions/2026/11/25");
    let a = dir.join(format!("rollout-2026-11-25T16-29-28-{A}.jsonl"));
    let b = dir.join(format!("rollout-2026-11-25T20-30-30-{B}.jsonl"));
    let locks: BTreeSet<String> = [A.to_string(), B.to_string()].into();
    let lock = |t: &str| PathBuf::from(format!("/Users/me/.codex/thread-writer-locks/{t}.lock"));
    let held = held_rollouts(&locks, &[lock(A), a.clone(), lock(B), b.clone()]).unwrap();
    assert_eq!(held.get(A), Some(&a));
    assert_eq!(held.get(B), Some(&b));
    assert_eq!(held_rollouts(&locks, &[lock(A), a.clone(), lock(B)]), None);
    let elsewhere = PathBuf::from(format!("/tmp/rollout-2026-11-25T16-29-28-{A}.jsonl"));
    assert_eq!(held_rollouts(&locks, &[a, elsewhere, b]), None);
}
