// These tests use file births, modes and symlinks; the route is not
// available on Windows (`windows_tests`).
#![cfg(unix)]

use super::inbox::*;
use super::settings::*;
use super::*;
use crate::relay::agents::SettingsExtension;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::{FakeProcess, FakeProcesses, OpenedFile};
use serde_json::json;
use std::time::SystemTime;

const SESSION: &str = "6e0af963-e21c-4fb8-a8e8-7f34765b6d64";
const OTHER: &str = "97d763c9-121c-4438-a6c8-596ba4288c37";

fn uid() -> u32 {
    crate::relay::peer::current_uid()
}

fn config(home: &Path) -> CursorConfig {
    CursorConfig::from_env(&|_| None, home)
}

/// `<chats>/<workspace>/<id>/store.db`, created, as a holder keeps it open.
fn store(config: &CursorConfig, id: &str) -> PathBuf {
    let dir = config
        .chats()
        .join("87460ce610ea3b92e1e9d04e6e66eac4")
        .join(id);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("store.db");
    std::fs::write(&path, b"").unwrap();
    path
}

fn cursor_process(parent: i32, open_files: Vec<PathBuf>) -> FakeProcess {
    FakeProcess {
        parent,
        uid: uid(),
        start: 100,
        executable: Some(PathBuf::from(
            "/home/u/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/node",
        )),
        arguments: vec![
            "/home/u/.local/bin/cursor-agent".into(),
            "--use-system-ca".into(),
            "/home/u/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/index.js".into(),
        ],
        open_files,
        cwd: Some(PathBuf::from("/work/api")),
        ..FakeProcess::default()
    }
}

fn shell(parent: i32) -> FakeProcess {
    FakeProcess {
        parent,
        uid: uid(),
        start: 100,
        executable: Some(PathBuf::from("/bin/zsh")),
        arguments: vec!["/bin/zsh".into(), "-c".into(), "hook".into()],
        ..FakeProcess::default()
    }
}

fn claude(parent: i32) -> FakeProcess {
    FakeProcess {
        parent,
        uid: uid(),
        start: 100,
        executable: Some(PathBuf::from(
            "/home/u/.local/share/claude/versions/2.1.308",
        )),
        arguments: vec!["claude".into()],
        ..FakeProcess::default()
    }
}

/// A live `cursor-agent` (pid 400) holding `SESSION`, with Cursor CLI's
/// own config file so the route is offered.
fn world() -> (tempfile::TempDir, CursorConfig, FakeProcesses) {
    let temp = tempfile::tempdir().unwrap();
    let config = config(temp.path());
    std::fs::create_dir_all(&config.config_dir).unwrap();
    std::fs::write(config.config_dir.join("cli-config.json"), "{}").unwrap();
    let held = store(&config, SESSION);
    let table = FakeProcesses::default();
    table.insert(400, cursor_process(1, vec![held]));
    (temp, config, table)
}

fn place(config: &CursorConfig, name: &str, text: &str) {
    std::fs::create_dir_all(config.inbox()).unwrap();
    std::fs::write(config.inbox().join(name), text).unwrap();
}

fn age(path: &Path, seconds: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(seconds))
        .unwrap();
}

#[test]
fn only_cursors_own_agent_is_a_cursor_process() {
    let table = FakeProcesses::default();
    table.insert(400, cursor_process(1, Vec::new()));
    assert!(is_cursor_process(&table, 400));
    // Its worker holds no conversation.
    let mut worker = cursor_process(400, Vec::new());
    worker.arguments.push("worker-server".into());
    table.insert(401, worker);
    assert!(!is_cursor_process(&table, 401));
    // Any other node, or a script that names Cursor in its arguments, is not.
    table.insert(
        402,
        FakeProcess {
            executable: Some(PathBuf::from("/usr/local/bin/node")),
            arguments: vec!["node".into(), "cursor-agent".into()],
            ..cursor_process(1, Vec::new())
        },
    );
    assert!(!is_cursor_process(&table, 402));
    table.insert(
        403,
        FakeProcess {
            executable: Some(PathBuf::from("/opt/cursor/bin/cursor-agent")),
            ..cursor_process(1, Vec::new())
        },
    );
    assert!(is_cursor_process(&table, 403));
}

#[test]
fn the_session_is_the_store_the_process_holds_open() {
    let (_temp, config, table) = world();
    assert_eq!(held_session(&config, &table, 400).as_deref(), Some(SESSION));
    // A fresh TUI before its first prompt holds no store: nobody.
    table.insert(410, cursor_process(1, Vec::new()));
    assert_eq!(held_session(&config, &table, 410), None);
    // Two stores at once: nobody, never the first.
    let other = store(&config, OTHER);
    let first = config
        .chats()
        .join("87460ce610ea3b92e1e9d04e6e66eac4")
        .join(SESSION)
        .join("store.db");
    table.insert(411, cursor_process(1, vec![first, other]));
    assert_eq!(held_session(&config, &table, 411), None);
    // A store.db outside the chats layout names nothing.
    let stray = config.data_dir.join("elsewhere").join(OTHER);
    std::fs::create_dir_all(&stray).unwrap();
    std::fs::write(stray.join("store.db"), b"").unwrap();
    table.insert(412, cursor_process(1, vec![stray.join("store.db")]));
    assert_eq!(held_session(&config, &table, 412), None);
}

#[test]
fn a_replaced_store_names_no_session() {
    let (_temp, config, table) = world();
    let path = store(&config, OTHER);
    let stale = OpenedFile {
        birth_ns: crate::relay::process::file_birth_ns(&path).map(|born| born + 1),
        path: path.clone(),
    };
    table.insert(
        420,
        FakeProcess {
            opened_files: Some(vec![stale]),
            ..cursor_process(1, vec![path])
        },
    );
    assert_eq!(held_session(&config, &table, 420), None);
}

#[test]
fn discovery_lists_held_conversations_of_this_user_once() {
    let (_temp, config, table) = world();
    // Another user's Cursor, and two holders of one conversation: neither.
    let foreign = store(&config, OTHER);
    table.insert(
        430,
        FakeProcess {
            uid: uid() + 1,
            ..cursor_process(1, vec![foreign])
        },
    );
    let listed = held_sessions(&config, &table, uid());
    assert_eq!(
        listed,
        vec![HeldSession {
            session_id: SESSION.into(),
            pid: 400
        }]
    );
    let again = config
        .chats()
        .join("87460ce610ea3b92e1e9d04e6e66eac4")
        .join(SESSION)
        .join("store.db");
    table.insert(431, cursor_process(1, vec![again]));
    assert!(held_sessions(&config, &table, uid()).is_empty());
}

#[test]
fn a_row_is_named_from_the_store_and_placed_by_the_process() {
    let (_temp, config, table) = world();
    let path = config
        .chats()
        .join("87460ce610ea3b92e1e9d04e6e66eac4")
        .join(SESSION)
        .join("store.db");
    std::fs::remove_file(&path).unwrap();
    let database = rusqlite::Connection::open(&path).unwrap();
    database
        .execute_batch("create table meta (key text primary key, value text)")
        .unwrap();
    let meta =
        serde_json::to_vec(&json!({"agentId": SESSION, "name": "Shell Command Echo"})).unwrap();
    let hex: String = meta.iter().map(|byte| format!("{byte:02x}")).collect();
    database
        .execute("insert into meta values ('0', ?1)", [hex])
        .unwrap();
    drop(database);
    // The new inode is the one held now.
    table.insert(400, cursor_process(1, vec![path]));
    let rows = discover(&config, &table, uid());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].target, Target::new(SessionKind::CursorCli, SESSION));
    assert_eq!(rows[0].title, "Shell Command Echo");
    assert_eq!(rows[0].directory.as_deref(), Some("/work/api"));
    assert!(rows[0].live);
}

#[test]
fn partitioned_discovery_keeps_cursor_rows_available_for_registration() {
    use crate::relay::local::{LocalConfig, LocalSessions};
    use crate::relay::sessions::{SessionDirectory, SessionPartition};
    use std::sync::Arc;

    let (home, cursor, table) = world();
    let mut config = LocalConfig::from_env(&|_| None, home.path());
    config.cursor = cursor;
    let sessions = LocalSessions::new(config, Arc::new(table));
    let target = Target::new(SessionKind::CursorCli, SESSION);
    assert_eq!(
        SessionPartition::for_target(&target),
        SessionPartition::CursorCli
    );
    assert!(sessions
        .presentation_partitions()
        .contains(&SessionPartition::CursorCli));
    let rows = sessions
        .discover_partition(SessionPartition::CursorCli)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].target, target);
    assert_eq!(sessions.find_session(&target), Some(rows[0].clone()));
    assert!(sessions.sessions().iter().any(|row| row.target == target));
    assert!(sessions
        .auto_activation_sessions()
        .iter()
        .any(|row| row.target == target));
}

#[test]
fn a_send_stages_one_private_file_and_waits_for_nobody() {
    let (_temp, config, table) = world();
    assert!(matches!(
        send(&config, &table, uid(), OTHER, "m-1", "hello"),
        InjectOutcome::Waiting(_)
    ));
    assert!(matches!(
        send(&config, &table, uid(), "not-a-session", "m-1", "hello"),
        InjectOutcome::Refused(_)
    ));
    assert!(matches!(
        send(&config, &table, uid(), SESSION, "m-1", "hello"),
        InjectOutcome::Accepted(_)
    ));
    let placed = config.inbox().join(format!("{SESSION}.m-1.msg"));
    assert_eq!(std::fs::read_to_string(&placed).unwrap(), "hello");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&placed).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // The same delivery again is the same handoff, not a second message.
    assert!(matches!(
        send(&config, &table, uid(), SESSION, "m-1", "hello"),
        InjectOutcome::Accepted(_)
    ));
    let messages = std::fs::read_dir(config.inbox())
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".msg"))
        .count();
    assert_eq!(messages, 1);
}

#[test]
fn a_tool_call_hands_over_context_and_settles_once() {
    let (_temp, config, table) = world();
    send(
        &config,
        &table,
        uid(),
        SESSION,
        "m-1",
        "[via Agent Relay — from @a · ref 1]\nfirst",
    );
    place(&config, &format!("{OTHER}.m-9.msg"), "not yours");
    let payload = json!({
        "hook_event_name": "postToolUse",
        "conversation_id": SESSION,
        "session_id": SESSION,
    });
    let answer = hook_answer(&config, &payload).unwrap();
    assert!(answer.output["additional_context"]
        .as_str()
        .unwrap()
        .contains("first"));
    // Claimed before it is printed: a retried send waits for the hook.
    assert!(matches!(
        send(&config, &table, uid(), SESSION, "m-1", "first"),
        InjectOutcome::Accepted(_)
    ));
    drain(&answer.claimed);
    assert_eq!(
        send(&config, &table, uid(), SESSION, "m-1", "first"),
        InjectOutcome::Delivered
    );
    // Nothing is left to say, and the other session's file stayed.
    assert!(hook_answer(&config, &payload).is_none());
    assert!(config.inbox().join(format!("{OTHER}.m-9.msg")).exists());
}

#[test]
fn a_completed_turn_gets_a_follow_up_and_a_stopped_one_does_not() {
    let (_temp, config, table) = world();
    send(&config, &table, uid(), SESSION, "m-1", "ping");
    let stop = |status: &str| json!({"hook_event_name": "stop", "conversation_id": SESSION, "status": status});
    // The person stopped the turn, or it failed: no new turn is started.
    assert!(hook_answer(&config, &stop("aborted")).is_none());
    assert!(hook_answer(&config, &stop("error")).is_none());
    let answer = hook_answer(&config, &stop("completed")).unwrap();
    assert_eq!(answer.output, json!({"followup_message": "ping"}));
    // Events Agent Relay does not inject at say nothing.
    for event in ["beforeSubmitPrompt", "sessionStart", "afterAgentResponse"] {
        assert!(hook_answer(
            &config,
            &json!({"hook_event_name": event, "conversation_id": SESSION})
        )
        .is_none());
    }
}

#[test]
fn an_unwritten_answer_puts_its_messages_back() {
    let (_temp, config, table) = world();
    send(&config, &table, uid(), SESSION, "m-1", "ping");
    let payload = json!({"hook_event_name": "postToolUse", "conversation_id": SESSION});
    let answer = hook_answer(&config, &payload).unwrap();
    unclaim(&config, &answer.claimed);
    assert!(config.inbox().join(format!("{SESSION}.m-1.msg")).exists());
    assert!(hook_answer(&config, &payload).is_some());
}

#[test]
fn an_unfinished_claim_is_settled_by_the_transcript_or_left_in_doubt() {
    let (_temp, config, table) = world();
    let line = "[via Agent Relay — from @a to @b · ref 1a2b3c4d5e6f]";
    send(
        &config,
        &table,
        uid(),
        SESSION,
        "m-1",
        &format!("{line}\nhello"),
    );
    send(
        &config,
        &table,
        uid(),
        SESSION,
        "m-2",
        "[via Agent Relay — ref 999]\nlost",
    );
    let payload =
        json!({"hook_event_name": "stop", "conversation_id": SESSION, "status": "completed"});
    // The hook claims both and dies before the tombstone.
    let answer = hook_answer(&config, &payload).unwrap();
    assert_eq!(answer.claimed.len(), 2);
    for path in &answer.claimed {
        age(path, 60);
    }
    // Cursor recorded the first as a user turn.
    let transcript = config
        .data_dir
        .join("projects/work-api/agent-transcripts")
        .join(SESSION);
    std::fs::create_dir_all(&transcript).unwrap();
    let entry = json!({"role": "user", "message": {"content": [{"type": "text",
        "text": format!("<user_query>\n{line}\nhello\n</user_query>")}]}});
    std::fs::write(
        transcript.join(format!("{SESSION}.jsonl")),
        format!("{entry}\n"),
    )
    .unwrap();
    assert_eq!(
        send(&config, &table, uid(), SESSION, "m-1", "hello"),
        InjectOutcome::Delivered
    );
    assert!(matches!(
        send(&config, &table, uid(), SESSION, "m-2", "lost"),
        InjectOutcome::InDoubt(_)
    ));
    // Neither is handed over again.
    assert!(hook_answer(&config, &payload).is_none());
}

#[test]
fn only_a_hook_under_the_holding_cursor_drains_its_inbox() {
    let (_temp, config, table) = world();
    // hook (502) → shell (501) → cursor-agent (400) → zsh (300) → claude (200)
    table.insert(200, claude(1));
    table.insert(300, shell(200));
    table.insert(400, {
        let held = config
            .chats()
            .join("87460ce610ea3b92e1e9d04e6e66eac4")
            .join(SESSION)
            .join("store.db");
        cursor_process(300, vec![held])
    });
    table.insert(501, shell(400));
    assert!(hook_caller_holds(&config, &table, 501, SESSION));
    assert!(!hook_caller_holds(&config, &table, 501, OTHER));
    // A hook Claude Code runs is never Cursor's.
    table.insert(601, shell(200));
    assert!(!hook_caller_holds(&config, &table, 601, SESSION));
    // A second Cursor that resumed the same conversation makes neither the
    // one holder, so neither drains it.
    let again = config
        .chats()
        .join("87460ce610ea3b92e1e9d04e6e66eac4")
        .join(SESSION)
        .join("store.db");
    table.insert(410, cursor_process(1, vec![again]));
    assert!(!hook_caller_holds(&config, &table, 501, SESSION));
}

#[test]
fn a_message_delivery_stopped_asking_about_is_dropped_not_handed_over() {
    let (_temp, config, table) = world();
    send(&config, &table, uid(), SESSION, "m-1", "kept");
    send(&config, &table, uid(), SESSION, "m-2", "left behind");
    let lease = |id: &str| config.inbox().join(format!("{SESSION}.{id}.msg.lease"));
    let stale = config.inbox().join(format!("{SESSION}.m-2.msg"));
    age(&lease("m-1"), 600);
    age(&lease("m-2"), 600);
    // Delivery is still asking about m-1, which renews it; m-2's agent left
    // the relay, so nothing asks again.
    assert!(matches!(
        send(&config, &table, uid(), SESSION, "m-1", "kept"),
        InjectOutcome::Accepted(_)
    ));
    let payload = json!({"hook_event_name": "postToolUse", "conversation_id": SESSION});
    let answer = hook_answer(&config, &payload).unwrap();
    assert_eq!(answer.output["additional_context"], "kept");
    assert!(!stale.exists());
    assert!(!lease("m-2").exists());
    // A claimed message keeps no lease.
    assert!(!lease("m-1").exists());
}

#[test]
fn tombstones_are_kept_by_age_not_count() {
    let (_temp, config, table) = world();
    let drained = config.inbox().join("drained");
    std::fs::create_dir_all(&drained).unwrap();
    let old = drained.join(format!("{SESSION}.old.msg"));
    std::fs::write(&old, "old").unwrap();
    age(&old, 2 * 24 * 60 * 60);
    for id in 0..1100 {
        std::fs::write(drained.join(format!("{OTHER}.{id}.msg")), "recent").unwrap();
    }
    send(&config, &table, uid(), SESSION, "m-1", "hello");
    let payload = json!({"hook_event_name": "postToolUse", "conversation_id": SESSION});
    drain(&hook_answer(&config, &payload).unwrap().claimed);
    // Only the day-old tombstone goes; every recent one still settles.
    assert!(!old.exists());
    assert_eq!(std::fs::read_dir(&drained).unwrap().count(), 1101);
    assert_eq!(
        send(&config, &table, uid(), OTHER, "0", "recent"),
        InjectOutcome::Delivered
    );
}

#[test]
fn messages_are_handed_over_in_the_order_they_were_staged() {
    let (_temp, config, table) = world();
    send(&config, &table, uid(), SESSION, "z-first", "first");
    send(&config, &table, uid(), SESSION, "a-second", "second");
    // A renewal of the first changes its lease, not its place.
    send(&config, &table, uid(), SESSION, "z-first", "first");
    let payload = json!({"hook_event_name": "postToolUse", "conversation_id": SESSION});
    let answer = hook_answer(&config, &payload).unwrap();
    assert_eq!(answer.output["additional_context"], "first\n\nsecond");
}

#[test]
fn claudes_hooks_inside_cursor_belong_to_cursor() {
    // Cursor CLI runs the hooks in ~/.claude/settings.json, and a Cursor
    // started from a Claude Code terminal has Claude above it.
    let (_temp, _config, table) = world();
    table.insert(200, claude(1));
    table.insert(300, shell(200));
    table.insert(400, cursor_process(300, Vec::new()));
    table.insert(501, shell(400));
    assert_eq!(
        crate::relay::claude::session_hook::claude_ancestor(&table, 501),
        None
    );
    // A hook Claude Code runs itself is still Claude's.
    table.insert(601, shell(200));
    assert_eq!(
        crate::relay::claude::session_hook::claude_ancestor(&table, 601),
        Some(200)
    );
    // So is one under Copilot CLI, which reads Claude-format hooks too.
    table.insert(
        700,
        FakeProcess {
            executable: Some(PathBuf::from(
                "/opt/homebrew/Caskroom/copilot-cli/1.0.7/copilot",
            )),
            arguments: vec!["copilot".into()],
            ..shell(300)
        },
    );
    table.insert(701, shell(700));
    assert_eq!(
        crate::relay::claude::session_hook::claude_ancestor(&table, 701),
        None
    );
}

fn settings(config: &CursorConfig) -> CursorSettings {
    CursorSettings::new(
        config,
        "/opt/relay/agent-relay-probe relay cursor-hook".into(),
    )
}

fn hooks(config: &CursorConfig) -> Value {
    serde_json::from_slice(&std::fs::read(config.hooks_file()).unwrap()).unwrap()
}

#[test]
fn the_setting_installs_only_its_own_hooks() {
    let (_temp, config, _table) = world();
    std::fs::create_dir_all(config.hooks_file().parent().unwrap()).unwrap();
    std::fs::write(
        config.hooks_file(),
        r#"{"version":1,"hooks":{"stop":[{"command":"./audit.sh"},{"command":"echo relay cursor-hook"}]},"other":true}"#,
    )
    .unwrap();
    let settings = settings(&config);
    assert_eq!(settings.get()[SETTING], json!(false));
    assert!(settings.default_on().is_empty());
    for _ in 0..2 {
        settings.set(SETTING, &json!(true)).unwrap().unwrap();
    }
    assert_eq!(settings.get()[SETTING], json!(true));
    let written = hooks(&config);
    for event in HOOK_EVENTS {
        let ours: Vec<&Value> = written["hooks"][event]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| {
                entry["command"]
                    .as_str()
                    .unwrap()
                    .contains("agent-relay-probe")
            })
            .collect();
        assert_eq!(ours.len(), 1, "{event}");
        assert_eq!(ours[0]["timeout"], 10);
    }
    assert_eq!(written["other"], true);
    assert!(written["hooks"]["stop"].to_string().contains("audit.sh"));
    // Backed up once, before the first change.
    let backup = std::fs::read_to_string(format!(
        "{}.relay-desktop-backup",
        config.hooks_file().display()
    ))
    .unwrap();
    assert!(!backup.contains("agent-relay-probe"));
    settings.set(SETTING, &json!(false)).unwrap().unwrap();
    let written = hooks(&config);
    assert!(!written.to_string().contains("agent-relay-probe"));
    // The person's own entries stay, including one that only spells ours.
    assert!(written["hooks"]["stop"].to_string().contains("audit.sh"));
    assert!(written["hooks"]["stop"]
        .to_string()
        .contains("echo relay cursor-hook"));
    assert_eq!(settings.get()[SETTING], json!(false));
}

#[test]
fn the_setting_follows_a_symlinked_hooks_file() {
    let (temp, config, _table) = world();
    let real = temp.path().join("dotfiles").join("cursor-hooks.json");
    std::fs::create_dir_all(real.parent().unwrap()).unwrap();
    std::fs::write(&real, "{}").unwrap();
    std::fs::create_dir_all(config.hooks_file().parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, config.hooks_file()).unwrap();
    settings(&config)
        .set(SETTING, &json!(true))
        .unwrap()
        .unwrap();
    assert!(std::fs::symlink_metadata(config.hooks_file())
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(std::fs::read_to_string(&real)
        .unwrap()
        .contains("relay cursor-hook"));
}

#[test]
fn the_setting_fails_closed_and_is_offered_only_where_cursor_cli_ran() {
    let (_temp, config, _table) = world();
    std::fs::create_dir_all(config.hooks_file().parent().unwrap()).unwrap();
    std::fs::write(config.hooks_file(), "{ // not json").unwrap();
    let settings = settings(&config);
    let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
    assert!(error.contains("left unchanged"), "{error}");
    assert_eq!(
        std::fs::read_to_string(config.hooks_file()).unwrap(),
        "{ // not json"
    );
    assert_eq!(settings.get()[SETTING], json!(false));
    std::fs::remove_file(config.config_dir.join("cli-config.json")).unwrap();
    assert!(settings.get().is_empty());
    assert_eq!(
        settings.set(SETTING, &json!(true)),
        Some(Err("Cursor CLI has never run on this computer.".into()))
    );
}

#[test]
fn hook_commands_are_recognized_per_build() {
    let (_temp, config, _table) = world();
    let settings = settings(&config);
    assert!(settings.is_ours("/opt/relay/agent-relay-probe relay cursor-hook"));
    assert!(settings.is_ours("'/opt/relay dir/agent-relay-probe' relay cursor-hook"));
    assert!(!settings.is_ours("/opt/relay/agent-relay-probe relay cursor-hook --dev"));
    assert!(!settings.is_ours("/opt/relay/agent-relay-probe relay devin-hook"));
    assert!(!settings.is_ours("echo relay cursor-hook"));
    let dev = CursorSettings::new(
        &config,
        "/opt/agent-relay-probe relay cursor-hook --dev".into(),
    );
    assert!(dev.is_ours("/opt/agent-relay-probe relay cursor-hook --dev"));
    assert!(!dev.is_ours("/opt/agent-relay-probe relay cursor-hook"));
}

#[test]
fn agent_relay_dev_keeps_its_own_inbox() {
    let (_temp, config, table) = world();
    let dev = config.clone().development(true);
    send(&config, &table, uid(), SESSION, "m-1", "production");
    send(&dev, &table, uid(), SESSION, "m-2", "development");
    let payload = json!({"hook_event_name": "postToolUse", "conversation_id": SESSION});
    let answer = hook_answer(&dev, &payload).unwrap();
    assert_eq!(answer.output["additional_context"], "development");
    assert!(config.inbox().join(format!("{SESSION}.m-1.msg")).exists());
}

/// A real Cursor CLI session, run by `scripts/test-cursor-live.sh`: stages
/// one message while the session runs a tool and another as its turn ends,
/// and checks each is handed over once, the second recorded in Cursor's
/// transcript. `RELAY_CURSOR_LIVE_HOME` is the disposable home of the inbox
/// and `RELAY_CURSOR_LIVE_DIR` the session's working directory.
#[test]
#[ignore = "needs a running Cursor CLI session; run scripts/test-cursor-live.sh"]
fn live_cursor_session_gets_its_messages_once() {
    let home = PathBuf::from(std::env::var("RELAY_CURSOR_LIVE_HOME").unwrap());
    let directory = PathBuf::from(std::env::var("RELAY_CURSOR_LIVE_DIR").unwrap());
    let config = CursorConfig::from_env(&|key| std::env::var(key).ok(), &home);
    let table = crate::relay::process::SystemProcesses::default();
    let wait = |what: &str, check: &dyn Fn() -> bool| {
        let deadline = std::time::Instant::now() + Duration::from_secs(240);
        while !check() {
            assert!(std::time::Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(250));
        }
    };
    let canonical = std::fs::canonicalize(&directory).unwrap();
    let find = || {
        discover(&config, &table, uid()).into_iter().find(|row| {
            row.directory
                .as_deref()
                .is_some_and(|dir| std::fs::canonicalize(dir).ok().as_ref() == Some(&canonical))
        })
    };
    wait("the session is listed", &|| find().is_some());
    let session = find().unwrap().target.id;
    eprintln!("session {session}");
    let first = "[via Agent Relay — from @relay-live-test-nobody to @cursor-live · ref live000first]\nA note from a peer: the word for this test is KIWI-3. No action is needed.";
    assert!(matches!(
        send(&config, &table, uid(), &session, "live-1", first),
        InjectOutcome::Accepted(_)
    ));
    wait("the first message is handed over", &|| {
        send(&config, &table, uid(), &session, "live-1", first) == InjectOutcome::Delivered
    });
    let second = "[via Agent Relay — from @relay-live-test-nobody to @cursor-live · ref live00second]\nA second note from a peer, for a test: end your answer with the word MANGO-9. Do not send any message.";
    assert!(matches!(
        send(&config, &table, uid(), &session, "live-2", second),
        InjectOutcome::Accepted(_)
    ));
    wait("the second message is handed over", &|| {
        send(&config, &table, uid(), &session, "live-2", second) == InjectOutcome::Delivered
    });
    wait("the second message is in the transcript", &|| {
        transcript_records(&config, &session, second)
    });
    // Each was handed over once, and neither is offered again.
    let drained = config.inbox().join(DRAINED_DIR);
    for id in ["live-1", "live-2"] {
        assert!(drained.join(message_file(&session, id)).exists(), "{id}");
    }
    assert!(pending(&config, &session).is_empty());
}
