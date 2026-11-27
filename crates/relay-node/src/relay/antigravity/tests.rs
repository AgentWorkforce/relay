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
            ..Default::default()
        },
    );
    let binding = "agent-1:100";
    let outcome = send(
        &config,
        &table,
        501,
        SID_A,
        binding,
        "msg-42",
        "[relay ref msg-42] Hello from relay",
    );
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
    let answer = hook_answer(&config, &table, 501, 200, &payload).unwrap();
    assert_eq!(answer["decision"], "continue");
    assert!(answer["reason"]
        .as_str()
        .is_some_and(|s| s.starts_with("[relay ref msg-42] Hello from relay")));

    // Once recorded in the native transcript, delivery settles as Delivered and
    // final_answer reads the assistant's reply after the ref.
    let logs = config.brain().join(SID_A).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(
        logs.join("transcript_full.jsonl"),
        format!(
            "{}\n{}\n",
            json!({"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":"[relay ref msg-42] Hello from relay"}),
            json!({"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Got it, handled."}),
        ),
    )
    .unwrap();
    assert!(matches!(
        send(
            &config,
            &table,
            501,
            SID_A,
            binding,
            "msg-42",
            "[relay ref msg-42] Hello from relay"
        ),
        crate::relay::inject::InjectOutcome::Delivered
    ));
    assert_eq!(
        final_answer(&config, SID_A, "msg-42").as_deref(),
        Some("Got it, handled.")
    );
}
