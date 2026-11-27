use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses, OpenedFile, ProcessTable};
use rusqlite::Connection;
use serde_json::json;
use std::path::PathBuf;

const SID_A: &str = "7f657d11-b145-477f-a76b-28408ec8cbb1";
const SID_B: &str = "4f04c545-3849-430c-9e4c-1baea9db8405";

fn setup_fake_antigravity(
    home: &Path,
    held_sids: &[&str],
) -> (AntigravityConfig, FakeProcesses, i32) {
    let config = AntigravityConfig::from_env(&|_| None, home);
    std::fs::create_dir_all(config.conversations()).unwrap();
    let mut open_files = Vec::new();
    for sid in held_sids {
        let db = config.conversations().join(format!("{sid}.db"));
        std::fs::write(&db, b"sqlite").unwrap();
        let birth = crate::relay::process::file_birth_ns(&db);
        open_files.push(OpenedFile {
            path: db,
            birth_ns: birth,
        });
    }
    let app_main = PathBuf::from("/Applications/Antigravity.app/Contents/MacOS/Antigravity");
    let ls_bin =
        PathBuf::from("/Applications/Antigravity.app/Contents/Resources/bin/language_server");
    let table = FakeProcesses::default();
    table
        .trusted_antigravity
        .lock()
        .unwrap()
        .insert(app_main.clone());
    table
        .trusted_antigravity
        .lock()
        .unwrap()
        .insert(ls_bin.clone());
    table
        .trusted_antigravity_bundles
        .lock()
        .unwrap()
        .insert(PathBuf::from("/Applications/Antigravity.app"));
    table.insert(
        100,
        FakeProcess {
            parent: 1,
            uid: 501,
            start: 10,
            executable: Some(app_main),
            arguments: vec!["/Applications/Antigravity.app/Contents/MacOS/Antigravity".into()],
            ..Default::default()
        },
    );
    table.insert(
        101,
        FakeProcess {
            parent: 100,
            uid: 501,
            start: 20,
            executable: Some(ls_bin),
            arguments: vec![
                "language_server".into(),
                "--override_ide_name".into(),
                "antigravity".into(),
            ],
            opened_files: Some(open_files),
            ..Default::default()
        },
    );
    (config, table, 101)
}

#[test]
fn settings_install_and_remove_preserves_other_hooks() {
    let home = tempfile::tempdir().unwrap();
    let config = AntigravityConfig::from_env(&|_| None, home.path());
    std::fs::create_dir_all(&config.config_dir).unwrap();
    std::fs::write(
        config.hooks_file(),
        serde_json::to_vec_pretty(&json!({
            "user-linter": {
                "PostToolUse": [{"matcher": "run_command", "hooks": [{"type": "command", "command": "./lint.sh"}]}]
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let settings = AntigravitySettings::new(&config, PathBuf::from("/opt/agent-relay-probe"));
    if !proof::SUPPORTED {
        assert!(settings.set_enabled(true).is_err());
        return;
    }
    assert!(!settings.enabled());
    settings.set_enabled(true).unwrap();
    assert!(settings.enabled());
    let doc: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config.hooks_file()).unwrap()).unwrap();
    assert!(doc.get("user-linter").is_some());
    assert!(doc.get("agent-relay").is_some());
    settings.set_enabled(false).unwrap();
    assert!(!settings.enabled());
    let doc: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config.hooks_file()).unwrap()).unwrap();
    assert!(doc.get("user-linter").is_some());
    assert!(doc.get("agent-relay").is_none());
}

#[test]
fn single_held_conversation_identifies_caller_and_discovers_title() {
    let home = tempfile::tempdir().unwrap();
    let (config, table, ls_pid) = setup_fake_antigravity(home.path(), &[SID_A]);
    let conn = Connection::open(config.summaries_db()).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', workspace_uris TEXT NOT NULL DEFAULT '[]', parent_conversation_id TEXT NOT NULL DEFAULT '');
         INSERT INTO conversation_summaries VALUES ('{SID_A}', 'Antigravity Relay Chat', '[\"file:///work/relay\"]', '');"
    ))
    .unwrap();
    table.insert(
        102,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 30,
            executable: Some(PathBuf::from("/bin/zsh")),
            arguments: vec!["zsh".into(), "-c".into(), "agent-relay-probe whoami".into()],
            ..Default::default()
        },
    );
    table.insert(
        103,
        FakeProcess {
            parent: 102,
            uid: 501,
            start: 31,
            executable: Some(PathBuf::from("/usr/bin/curl")),
            arguments: vec!["curl".into()],
            ..Default::default()
        },
    );
    let host = table.process(ls_pid).unwrap();
    let child = table.process(102);
    assert_eq!(
        caller::identify(&config, &table, 501, 103, host, child).as_deref(),
        Some(SID_A)
    );
    if proof::SUPPORTED {
        let found = discover(&config, &table, 501).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].target.id, SID_A);
        assert_eq!(found[0].title, "Antigravity Relay Chat");
        assert_eq!(found[0].directory.as_deref(), Some("/work/relay"));
    }
}

#[test]
fn multiple_held_conversations_witness_caller_from_active_turn_transcript() {
    let home = tempfile::tempdir().unwrap();
    let (config, table, ls_pid) = setup_fake_antigravity(home.path(), &[SID_A, SID_B]);
    let logs_a = config.brain().join(SID_A).join(".system_generated/logs");
    let logs_b = config.brain().join(SID_B).join(".system_generated/logs");
    std::fs::create_dir_all(&logs_a).unwrap();
    std::fs::create_dir_all(&logs_b).unwrap();
    let cmd = "agent-relay-probe send --to layered-relay-app";
    std::fs::write(
        logs_a.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"hello"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":cmd}}]}),
        ),
    )
    .unwrap();
    std::fs::write(
        logs_b.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"other"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":"ls -la"}}]}),
        ),
    )
    .unwrap();
    table.insert(
        102,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 30,
            executable: Some(PathBuf::from("/bin/zsh")),
            arguments: vec!["zsh".into(), "-c".into(), cmd.into()],
            ..Default::default()
        },
    );
    let host = table.process(ls_pid).unwrap();
    let child = table.process(102);
    assert_eq!(
        caller::identify(&config, &table, 501, 102, host, child).as_deref(),
        Some(SID_A)
    );
}

#[test]
fn hook_delivery_claims_offers_and_settles_from_transcript() {
    if !proof::SUPPORTED {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let (config, table, ls_pid) = setup_fake_antigravity(home.path(), &[SID_A]);
    let helper = home.path().join("agent-relay-probe");
    std::fs::write(&helper, b"bin").unwrap();
    let settings = AntigravitySettings::new(&config, helper.clone());
    settings.set_enabled(true).unwrap();
    table
        .trusted_relay_helpers
        .lock()
        .unwrap()
        .insert(helper.clone());
    table.insert(
        200,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 40,
            executable: Some(helper),
            arguments: vec![
                "agent-relay-probe".into(),
                "antigravity-hook".into(),
                "--event".into(),
                "stop".into(),
            ],
            cwd: Some(config.config_dir.clone()),
            ..Default::default()
        },
    );
    let binding = "agent-1:100";
    let msg_ref = crate::relay::delivery::policy::MessageRef::of("msg-42");
    let text = format!("[via Agent Relay ref {msg_ref}]\nHello from relay");
    let outcome = send(&config, &table, 501, SID_A, binding, "msg-42", &text);
    assert!(matches!(
        outcome,
        crate::relay::inject::InjectOutcome::Waiting(_)
    ));
    let payload = json!({
        "conversationId": SID_A,
        "relayEvent": "stop",
        "terminationReason": "NO_TOOL_CALL",
        "relayBinding": binding,
        "cwd": "/work/relay",
    });
    let answer = hook_answer(&config, &table, 501, 200, &payload, &|| true).unwrap();
    assert_eq!(answer["decision"], "continue");
    let reason = answer["reason"].as_str().unwrap();
    assert_eq!(
        crate::relay::delivery::policy::MessageRef::in_text(reason).as_deref(),
        Some(msg_ref.as_str())
    );
    assert!(reason.contains("Hello from relay"));

    // Once recorded in the native transcript, delivery settles as Delivered and
    // final_answer reads the assistant's reply after the ref.
    let logs = config.brain().join(SID_A).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(
        logs.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":text}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Got it, handled."}),
        ),
    )
    .unwrap();
    assert!(matches!(
        send(&config, &table, 501, SID_A, binding, "msg-42", &text),
        crate::relay::inject::InjectOutcome::Delivered
    ));
    assert_eq!(
        final_answer(&config, SID_A, &msg_ref).as_deref(),
        Some("Got it, handled.")
    );
}

#[test]
fn ambiguous_caller_fails_closed_even_when_env_var_is_set() {
    let home = tempfile::tempdir().unwrap();
    let (config, table, ls_pid) = setup_fake_antigravity(home.path(), &[SID_A, SID_B]);
    let cmd = "agent-relay-probe agents";
    for sid in [SID_A, SID_B] {
        let logs = config.brain().join(sid).join(".system_generated/logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("transcript_full.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"check"}),
                json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":cmd}}]}),
            ),
        )
        .unwrap();
    }
    let mut env = std::collections::HashMap::new();
    env.insert("ANTIGRAVITY_CONVERSATION_ID".into(), SID_B.into());
    table.insert(
        102,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 30,
            executable: Some(PathBuf::from("/bin/zsh")),
            arguments: vec!["zsh".into(), "-c".into(), cmd.into()],
            environment: env.clone(),
            ..Default::default()
        },
    );
    table.insert(
        103,
        FakeProcess {
            parent: 102,
            uid: 501,
            start: 31,
            executable: Some(PathBuf::from("/opt/agent-relay-probe")),
            arguments: vec!["agent-relay-probe".into(), "agents".into()],
            environment: env,
            ..Default::default()
        },
    );
    let host = table.process(ls_pid).unwrap();
    let child = table.process(102);
    assert!(caller::identify(&config, &table, 501, 103, host, child).is_none());
}

#[test]
fn hook_rejects_shell_parent_tool_env_wrong_cwd_and_sibling_hook_command() {
    if !proof::SUPPORTED {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let (config, table, ls_pid) = setup_fake_antigravity(home.path(), &[SID_A, SID_B]);
    let helper = home.path().join("agent-relay-probe");
    std::fs::write(&helper, b"bin").unwrap();
    AntigravitySettings::new(&config, helper.clone())
        .set_enabled(true)
        .unwrap();
    table
        .trusted_relay_helpers
        .lock()
        .unwrap()
        .insert(helper.clone());

    let args = vec![
        "agent-relay-probe".into(),
        "antigravity-hook".into(),
        "--event".into(),
        "stop".into(),
    ];
    let payload = json!({
        "conversationId": SID_B,
        "relayEvent": "stop",
        "terminationReason": "NO_TOOL_CALL",
        "relayBinding": "agent-b:1",
    });

    // 1) Shell parent between language_server and helper must be rejected.
    table.insert(
        150,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 35,
            executable: Some(PathBuf::from("/bin/zsh")),
            arguments: vec!["zsh".into(), "-c".into(), "echo {} | helper".into()],
            ..Default::default()
        },
    );
    table.insert(
        151,
        FakeProcess {
            parent: 150,
            uid: 501,
            start: 36,
            executable: Some(helper.clone()),
            arguments: args.clone(),
            cwd: Some(config.config_dir.clone()),
            ..Default::default()
        },
    );
    assert!(hook_answer(&config, &table, 501, 151, &payload, &|| true).is_none());

    // 2) ANTIGRAVITY_SOURCE_METADATA (run_command tool env) must be rejected.
    let mut tool_env = std::collections::HashMap::new();
    tool_env.insert("ANTIGRAVITY_SOURCE_METADATA".into(), "tool".into());
    table.insert(
        152,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 37,
            executable: Some(helper.clone()),
            arguments: args.clone(),
            cwd: Some(config.config_dir.clone()),
            environment: tool_env,
            ..Default::default()
        },
    );
    assert!(hook_answer(&config, &table, 501, 152, &payload, &|| true).is_none());

    // 3) Mismatched ANTIGRAVITY_CONVERSATION_ID must be rejected.
    let mut wrong_sid_env = std::collections::HashMap::new();
    wrong_sid_env.insert("ANTIGRAVITY_CONVERSATION_ID".into(), SID_A.into());
    table.insert(
        153,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 38,
            executable: Some(helper.clone()),
            arguments: args.clone(),
            cwd: Some(config.config_dir.clone()),
            environment: wrong_sid_env,
            ..Default::default()
        },
    );
    assert!(hook_answer(&config, &table, 501, 153, &payload, &|| true).is_none());

    // 4) Wrong working directory (workspace instead of ~/.gemini/config) must be rejected.
    table.insert(
        154,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 39,
            executable: Some(helper.clone()),
            arguments: args.clone(),
            cwd: Some(home.path().to_path_buf()),
            ..Default::default()
        },
    );
    assert!(hook_answer(&config, &table, 501, 154, &payload, &|| true).is_none());

    // 5) Unreadable hook environment must be rejected.
    table.insert(
        155,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 40,
            executable: Some(helper.clone()),
            arguments: args.clone(),
            cwd: Some(config.config_dir.clone()),
            ..Default::default()
        },
    );
    table.unreadable_environment.lock().unwrap().insert(155);
    assert!(hook_answer(&config, &table, 501, 155, &payload, &|| true).is_none());

    // 6) Genuine hook succeeds even if a sibling ran `rg antigravity-hook` or completed an earlier command,
    //    but is rejected while a sibling has an in-flight `run_command` invoking the hook helper.
    table.insert(
        156,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 41,
            executable: Some(helper.clone()),
            arguments: args,
            cwd: Some(config.config_dir.clone()),
            ..Default::default()
        },
    );
    let logs_a = config.brain().join(SID_A).join(".system_generated/logs");
    std::fs::create_dir_all(&logs_a).unwrap();
    // Harmless search or quoted separator mentioning `antigravity-hook` must NEVER block another conversation's hook.
    std::fs::write(
        logs_a.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"search"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":"rg antigravity-hook ."}}]}),
        ),
    )
    .unwrap();
    assert!(hook_answer(&config, &table, 501, 156, &payload, &|| true).is_some());

    std::fs::write(
        logs_a.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"echo"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":"echo 'antigravity-hook;test'; sleep 30"}}]}),
        ),
    )
    .unwrap();
    assert!(hook_answer(&config, &table, 501, 156, &payload, &|| true).is_some());

    // An in-flight sibling command invoking the helper for `--event stop` IS blocked.
    std::fs::write(
        logs_a.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"steal"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":format!("exec {} antigravity-hook --event stop", helper.display())}}]}),
        ),
    )
    .unwrap();
    assert!(hook_answer(&config, &table, 501, 156, &payload, &|| true).is_none());

    // Once that sibling command has completed (RUN_COMMAND DONE), genuine hooks work again.
    std::fs::write(
        logs_a.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n{}\n",
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"steal"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":format!("exec {} antigravity-hook --event stop", helper.display())}}]}),
            json!({"step_index":2,"source":"SYSTEM","type":"RUN_COMMAND","status":"DONE"}),
        ),
    )
    .unwrap();
    assert!(hook_answer(&config, &table, 501, 156, &payload, &|| true).is_some());

    // An in-flight sibling `exec` or `eval` wrapper (even without literal `antigravity-hook`) is blocked.
    for cmd in [
        "cd ~/.gemini/config && exec /tmp/wrapper.sh",
        "eval \"cd ~/.gemini/config && exec /tmp/wrapper.sh\"",
    ] {
        std::fs::write(
            logs_a.join("transcript_full.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"wrap"}),
                json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":cmd}}]}),
            ),
        )
        .unwrap();
        assert!(
            hook_answer(&config, &table, 501, 156, &payload, &|| true).is_none(),
            "should block in-flight sibling command: {cmd}"
        );
    }

    // A corrupt/unparseable sibling transcript fails closed.
    std::fs::write(logs_a.join("transcript_full.jsonl"), "not-json\n").unwrap();
    assert!(hook_answer(&config, &table, 501, 156, &payload, &|| true).is_none());
    std::fs::remove_file(logs_a.join("transcript_full.jsonl")).unwrap();

    // 7) A hook process attached to a terminal (either stdin PTY or an open /dev/tty* descriptor) must be rejected.
    table.insert(
        157,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 42,
            executable: Some(helper.clone()),
            arguments: vec![
                "agent-relay-probe".into(),
                "antigravity-hook".into(),
                "--event".into(),
                "stop".into(),
            ],
            cwd: Some(config.config_dir.clone()),
            has_terminal: true,
            ..Default::default()
        },
    );
    assert!(hook_answer(&config, &table, 501, 157, &payload, &|| true).is_none());

    table.insert(
        158,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 43,
            executable: Some(helper),
            arguments: vec![
                "agent-relay-probe".into(),
                "antigravity-hook".into(),
                "--event".into(),
                "stop".into(),
            ],
            cwd: Some(config.config_dir.clone()),
            has_terminal: false,
            open_files: vec![PathBuf::from("/dev/ttys004")],
            ..Default::default()
        },
    );
    assert!(hook_answer(&config, &table, 501, 158, &payload, &|| true).is_none());

    // 8) A payload naming a transcriptPath outside the target conversation's brain dir is rejected.
    let bad_transcript = json!({
        "conversationId": SID_B,
        "relayEvent": "stop",
        "terminationReason": "NO_TOOL_CALL",
        "relayBinding": "agent-b:1",
        "transcriptPath": config.brain().join(SID_A).join(".system_generated/logs/transcript_full.jsonl").to_string_lossy(),
    });
    assert!(hook_answer(&config, &table, 501, 156, &bad_transcript, &|| true).is_none());
}

#[test]
fn unreadable_sibling_transcript_fails_closed_for_caller_attribution() {
    let home = tempfile::tempdir().unwrap();
    let (config, table, ls_pid) = setup_fake_antigravity(home.path(), &[SID_A, SID_B]);
    let cmd = "agent-relay-probe send --to team";
    let logs_a = config.brain().join(SID_A).join(".system_generated/logs");
    let logs_b = config.brain().join(SID_B).join(".system_generated/logs");
    std::fs::create_dir_all(&logs_a).unwrap();
    std::fs::create_dir_all(&logs_b).unwrap();
    std::fs::write(
        logs_a.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"go"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":cmd}}]}),
        ),
    )
    .unwrap();
    // Corrupt/unparseable transcript for sibling SID_B must cause identify() to fail closed.
    std::fs::write(logs_b.join("transcript_full.jsonl"), "not-valid-json\n").unwrap();
    table.insert(
        102,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 30,
            executable: Some(PathBuf::from("/bin/zsh")),
            arguments: vec!["zsh".into(), "-c".into(), cmd.into()],
            ..Default::default()
        },
    );
    let host = table.process(ls_pid).unwrap();
    let child = table.process(102);
    assert!(caller::identify(&config, &table, 501, 102, host, child).is_none());
}

#[test]
fn unregistered_stop_signals_no_wait_and_stale_fence_does_not_strand_offers() {
    if !proof::SUPPORTED {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let (config, table, ls_pid) = setup_fake_antigravity(home.path(), &[SID_A]);
    let helper = home.path().join("agent-relay-probe");
    std::fs::write(&helper, b"bin").unwrap();
    AntigravitySettings::new(&config, helper.clone())
        .set_enabled(true)
        .unwrap();
    table
        .trusted_relay_helpers
        .lock()
        .unwrap()
        .insert(helper.clone());
    table.insert(
        200,
        FakeProcess {
            parent: ls_pid,
            uid: 501,
            start: 40,
            executable: Some(helper),
            arguments: vec![
                "agent-relay-probe".into(),
                "antigravity-hook".into(),
                "--event".into(),
                "stop".into(),
            ],
            cwd: Some(config.config_dir.clone()),
            ..Default::default()
        },
    );

    // Unregistered chat on stop returns relayWait: false instead of stalling.
    let unregistered = json!({
        "conversationId": SID_A,
        "relayEvent": "stop",
        "terminationReason": "NO_TOOL_CALL",
        "relayBinding": null,
    });
    let answer = hook_answer(&config, &table, 501, 200, &unregistered, &|| true).unwrap();
    assert_eq!(answer["relayWait"], json!(false));

    // A stale fence rejects before claiming so the staged offer is not stranded.
    let binding = "agent-1:100";
    let msg_ref = crate::relay::delivery::policy::MessageRef::of("msg-fence");
    let text = format!("[via Agent Relay ref {msg_ref}]\nKeep safe");
    let _ = send(&config, &table, 501, SID_A, binding, "msg-fence", &text);
    let registered = json!({
        "conversationId": SID_A,
        "relayEvent": "stop",
        "terminationReason": "NO_TOOL_CALL",
        "relayBinding": binding,
    });
    assert!(hook_answer(&config, &table, 501, 200, &registered, &|| false).is_none());
    let claimed = hook_answer(&config, &table, 501, 200, &registered, &|| true).unwrap();
    assert_eq!(claimed["decision"], "continue");
    let reason = claimed["reason"].as_str().unwrap();
    assert_eq!(
        crate::relay::delivery::policy::MessageRef::in_text(reason).as_deref(),
        Some(msg_ref.as_str())
    );
    assert!(reason.contains("Keep safe"));
}

#[test]
fn receipts_match_exact_refs_ignore_tool_steps_and_respect_turn_boundaries() {
    let home = tempfile::tempdir().unwrap();
    let config = AntigravityConfig::from_env(&|_| None, home.path());
    let logs = config.brain().join(SID_A).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let path = logs.join("transcript_full.jsonl");

    let batch_key = "chb-0123456789abcdef";
    let batch_ref = crate::relay::delivery::policy::MessageRef::of(batch_key);
    let notice_ref = crate::relay::delivery::policy::MessageRef::of("local-notice-ab");

    let mut rows = vec![
        // Model prose quoting a ref must never count as a delivery receipt.
        json!({"step_index":0,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":format!("[via Agent Relay ref {batch_ref}]\nquoted")}),
        // Actual coalesced channel batch wrapped in <SYSTEM_MESSAGE>.
        json!({"step_index":1,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":format!("<SYSTEM_MESSAGE>\n[via Agent Relay in #general (2 messages) ref {batch_ref}]\nhello\n</SYSTEM_MESSAGE>")}),
        // Tool-bearing PLANNER_RESPONSE with DONE must NOT be returned as final_answer.
        json!({"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Let me check that tool...","tool_calls":[{"name":"run_command","args":{"CommandLine":"ls"}}]}),
    ];
    let write_rows = |rows: &[serde_json::Value]| {
        std::fs::write(
            &path,
            rows.iter().map(|r| format!("{r}\n")).collect::<String>(),
        )
        .unwrap();
    };
    write_rows(&rows);

    assert!(receipts::recorded(&config, SID_A, batch_key));
    assert!(!receipts::recorded(&config, SID_A, "local-notice-a"));
    assert!(!receipts::recorded(&config, SID_A, "local-notice-ab"));
    // Only a tool-bearing planner response exists so far.
    assert!(final_answer(&config, SID_A, &batch_ref).is_none());

    // A subsequent USER_INPUT starts a new turn; its answer cannot answer the earlier turn.
    let mut interrupted = rows.clone();
    interrupted.push(json!({"step_index":3,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"Unrelated follow-up"}));
    interrupted.push(json!({"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Answer to unrelated follow-up"}));
    write_rows(&interrupted);
    assert!(final_answer(&config, SID_A, &batch_ref).is_none());

    // When the turn actually finishes with a non-tool PLANNER_RESPONSE before the next USER_INPUT,
    // final_answer returns THAT turn's answer and never the next turn's.
    rows.push(json!({"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Actual final answer","tool_calls":[]}));
    rows.push(json!({"step_index":4,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"Next question"}));
    rows.push(json!({"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Next answer"}));
    write_rows(&rows);
    assert_eq!(
        final_answer(&config, SID_A, &batch_ref).as_deref(),
        Some("Actual final answer")
    );

    // Streaming fallback past the 1 MiB tail finds an older receipt.
    let padding = "x".repeat(128 * 1024);
    let mut big = String::new();
    big.push_str(&format!(
        "{}\n",
        json!({"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":format!("[Agent Relay automated notice — test ref {notice_ref}]\nNotice")})
    ));
    for idx in 1..12 {
        big.push_str(&format!(
            "{}\n",
            json!({"step_index":idx,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":padding,"tool_calls":[{"name":"read"}]})
        ));
    }
    std::fs::write(&path, big).unwrap();
    assert!(receipts::recorded(&config, SID_A, "local-notice-ab"));
    assert!(!receipts::recorded(&config, SID_A, "local-notice-a"));
}

#[test]
fn subagents_filtered_on_db_error_or_sidecar_and_stale_records_ignored() {
    if !proof::SUPPORTED {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let (config, table, ls_pid) = setup_fake_antigravity(home.path(), &[SID_A, SID_B]);

    // 1) Corrupt summaries DB fails closed (discover returns None so previous rows are kept).
    std::fs::write(config.summaries_db(), b"not-a-sqlite-db").unwrap();
    assert!(discover(&config, &table, 501).is_none());
    assert!(session(&config, &table, 501, SID_A).is_none());
    std::fs::remove_file(config.summaries_db()).unwrap();

    // 2) Subagent sidecar under parent's brain hides child even without summaries DB.
    let subagents_dir = config
        .brain()
        .join(SID_A)
        .join(".system_generated/subagents");
    std::fs::create_dir_all(&subagents_dir).unwrap();
    std::fs::write(
        subagents_dir.join("child.json"),
        serde_json::to_vec(&json!({"conversationId": SID_B})).unwrap(),
    )
    .unwrap();
    let found = discover(&config, &table, 501).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].target.id, SID_A);
    assert!(session(&config, &table, 501, SID_B).is_none());

    // 3) Stale hook record from a prior runtime PID/start must not override summaries DB.
    let conn = Connection::open(config.summaries_db()).unwrap();
    conn.execute_batch(&format!(
        "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', workspace_uris TEXT NOT NULL DEFAULT '[]', parent_conversation_id TEXT NOT NULL DEFAULT '');
         INSERT INTO conversation_summaries VALUES ('{SID_A}', 'Fresh Title', '[\"file:///fresh/dir\"]', '');"
    ))
    .unwrap();
    config.prepare().unwrap();
    std::fs::write(
        config.state().join(format!("{SID_A}.json")),
        serde_json::to_vec(
            &json!({"pid": ls_pid, "start": 999999, "title": "Stale Title", "cwd": "/stale/dir"}),
        )
        .unwrap(),
    )
    .unwrap();
    let found = discover(&config, &table, 501).unwrap();
    assert_eq!(found[0].title, "Fresh Title");
    assert_eq!(found[0].directory.as_deref(), Some("/fresh/dir"));
    let one = session(&config, &table, 501, SID_A).unwrap();
    assert_eq!(one.directory.as_deref(), Some("/fresh/dir"));
}

#[test]
fn settings_extension_refresh_and_dev_isolation() {
    use crate::relay::agents::SettingsExtension;
    let home = tempfile::tempdir().unwrap();
    let prod_cfg = AntigravityConfig::from_env(&|_| None, home.path());
    let dev_cfg = prod_cfg.clone().development(true);
    std::fs::create_dir_all(&prod_cfg.data_dir).unwrap();

    let prod = AntigravitySettings::new(&prod_cfg, PathBuf::from("/opt/old-helper"));
    let dev = AntigravitySettings::new(&dev_cfg, PathBuf::from("/opt/dev-helper"));
    if !proof::SUPPORTED {
        assert!(prod.get().is_empty());
        assert!(prod.refuse(DIRECT_DELIVERY_SETTING, &json!(true)).is_some());
        return;
    }

    assert_eq!(prod.get().get(DIRECT_DELIVERY_SETTING), Some(&json!(false)));
    prod.set(DIRECT_DELIVERY_SETTING, &json!(true))
        .unwrap()
        .unwrap();
    dev.set_enabled(true).unwrap();
    assert!(prod.enabled());
    assert!(dev.enabled());

    // Refresh updates an already-installed entry to a new helper path.
    let updated = AntigravitySettings::new(&prod_cfg, PathBuf::from("/opt/new-helper"));
    assert!(!updated.enabled());
    updated.refresh().unwrap();
    assert!(updated.enabled());
    // Dev hook entry remains intact and separate.
    assert!(dev.enabled());

    // Explicitly turning off is respected by a subsequent refresh.
    updated
        .set(DIRECT_DELIVERY_SETTING, &json!(false))
        .unwrap()
        .unwrap();
    assert!(!updated.enabled());
    updated.refresh().unwrap();
    assert!(!updated.enabled());
    assert!(dev.enabled());
}

#[test]
fn hooks_lock_times_out_cleanly_without_modifying_hooks_json() {
    if !proof::SUPPORTED {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let config = AntigravityConfig::from_env(&|_| None, home.path());
    std::fs::create_dir_all(&config.config_dir).unwrap();
    let initial = serde_json::to_vec_pretty(&json!({"user-hook": {}})).unwrap();
    std::fs::write(config.hooks_file(), &initial).unwrap();

    let lock_dir = home.path().join(".agentworkforce/desktop");
    crate::platform::fs::create_private_dir_all(&lock_dir).unwrap();
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(false);
    let holder = crate::platform::fs::private(&mut opts)
        .open(lock_dir.join(".antigravity-hooks.lock"))
        .unwrap();
    fs2::FileExt::lock_exclusive(&holder).unwrap();

    let settings = AntigravitySettings::new(&config, PathBuf::from("/opt/agent-relay-probe"));
    assert!(settings.set_enabled(true).is_err());
    assert!(settings.refresh().is_err());
    assert_eq!(std::fs::read(config.hooks_file()).unwrap(), initial);

    fs2::FileExt::unlock(&holder).unwrap();
    settings.set_enabled(true).unwrap();
    assert!(settings.enabled());
}
