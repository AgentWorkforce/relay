// The editor route shares the inbox's file modes; it is not available on
// Windows (`windows_tests`).
#![cfg(unix)]

use super::editor::*;
use super::inbox::*;
use super::*;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::{FakeProcess, FakeProcesses};
use serde_json::json;

// The waiting hook's tests (`wait::tests`) run in this world too.
pub(super) const SESSION: &str = "9daab59d-0f1f-4c29-9f5d-717d3ecca68f";
const OTHER: &str = "97d763c9-121c-4438-a6c8-596ba4288c37";
pub(super) const HOST_PID: i32 = 650;

pub(super) fn uid() -> u32 {
    crate::relay::peer::current_uid()
}

fn helper() -> PathBuf {
    PathBuf::from(
        "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)",
    )
}

/// A Cursor window's extension host, as `ps` shows its title.
pub(super) fn host(start: u64) -> FakeProcess {
    FakeProcess {
        parent: 600,
        uid: uid(),
        start,
        executable: Some(helper()),
        arguments: vec!["Cursor Helper (Plugin): extension-host api [1-2]".into()],
        ..FakeProcess::default()
    }
}

pub(super) fn shell(parent: i32, environment: &[(&str, &str)]) -> FakeProcess {
    FakeProcess {
        parent,
        uid: uid(),
        start: 100,
        executable: Some(PathBuf::from("/bin/zsh")),
        arguments: vec!["/bin/zsh".into()],
        environment: environment
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
        cwd: Some(PathBuf::from("/work/api")),
        ..FakeProcess::default()
    }
}

pub(super) fn world() -> (tempfile::TempDir, CursorConfig, FakeProcesses) {
    let temp = tempfile::tempdir().unwrap();
    let config = CursorConfig::from_env(&|_| None, temp.path());
    let table = FakeProcesses::default();
    table.insert(
        600,
        FakeProcess {
            parent: 1,
            uid: uid(),
            start: 10,
            executable: Some(PathBuf::from(
                "/Applications/Cursor.app/Contents/MacOS/Cursor",
            )),
            arguments: vec!["/Applications/Cursor.app/Contents/MacOS/Cursor".into()],
            ..FakeProcess::default()
        },
    );
    table.insert(
        601,
        FakeProcess {
            parent: 1,
            uid: uid(),
            start: 10,
            executable: Some(PathBuf::from("/usr/share/cursor/cursor")),
            arguments: vec!["/usr/share/cursor/cursor".into()],
            ..FakeProcess::default()
        },
    );
    table.insert(HOST_PID, host(20));
    table.trust_cursor(helper());
    table.trust_cursor("/Applications/Cursor.app/Contents/MacOS/Cursor");
    table.trust_cursor("/usr/share/cursor/cursor");
    for session in [SESSION, OTHER] {
        std::fs::create_dir_all(own_transcript(&config, session).parent().unwrap()).unwrap();
        std::fs::write(own_transcript(&config, session), b"").unwrap();
    }
    (temp, config, table)
}

/// Where Cursor keeps a conversation's own transcript; `world` writes one
/// for each conversation, so both read as running now.
fn own_transcript(config: &CursorConfig, session: &str) -> PathBuf {
    config
        .data_dir
        .join("projects/work-api/agent-transcripts")
        .join(session)
        .join(format!("{session}.jsonl"))
}

pub(super) fn hook_payload(event: &str, session: &str) -> Value {
    json!({
        "hook_event_name": event,
        "conversation_id": session,
        "session_id": session,
        "status": "completed",
        "workspace_roots": ["/work/api"],
    })
}

#[test]
fn only_a_window_extension_host_is_the_editor() {
    let (_temp, _config, table) = world();
    assert!(is_editor_host(&table, HOST_PID));
    // The main process, a renderer and a language server are Cursor too,
    // but none runs the agent's hooks.
    assert!(!is_editor_host(&table, 600));
    table.insert(
        651,
        FakeProcess {
            arguments: vec!["Cursor Helper (Renderer)".into()],
            ..host(20)
        },
    );
    assert!(!is_editor_host(&table, 651));
    table.insert(
        652,
        FakeProcess {
            arguments: vec![
                helper().to_string_lossy().into_owned(),
                "--type=utility".into(),
            ],
            ..host(20)
        },
    );
    assert!(!is_editor_host(&table, 652));
    // A binary that merely names itself after the helper is not.
    table.insert(
        653,
        FakeProcess {
            executable: Some(PathBuf::from("/tmp/Cursor Helper (Plugin)")),
            ..host(20)
        },
    );
    assert!(!is_editor_host(&table, 653));
    // Linux runs the extension host as Cursor's own binary, untitled: a
    // Node utility process Cursor marks as the extension host in its
    // environment, or the older forked `--type=extensionHost`.
    let linux = |arguments: &[&str], kind: &str| FakeProcess {
        executable: Some(PathBuf::from("/usr/share/cursor/cursor")),
        arguments: arguments
            .iter()
            .map(|argument| argument.to_string())
            .collect(),
        environment: [(
            "VSCODE_CRASH_REPORTER_PROCESS_TYPE".to_string(),
            kind.to_string(),
        )]
        .into_iter()
        .collect(),
        parent: 601,
        ..host(20)
    };
    let utility = [
        "/usr/share/cursor/cursor",
        "--type=utility",
        "--utility-sub-type=node.mojom.NodeService",
    ];
    table.insert(654, linux(&utility, "extensionHost"));
    assert!(is_editor_host(&table, 654));
    table.insert(
        655,
        linux(&["/usr/share/cursor/cursor", "--type=extensionHost"], ""),
    );
    assert!(is_editor_host(&table, 655));
    // Its pty host and file watcher are the same kind of process.
    table.insert(656, linux(&utility, "ptyHost"));
    assert!(!is_editor_host(&table, 656));
    // Only Cursor's own binaries, under Cursor's main process: not one
    // merely named `cursor`, nor Cursor run by a shell with the host's
    // environment.
    table.insert(
        657,
        FakeProcess {
            executable: Some(PathBuf::from("/tmp/cursor")),
            ..linux(&["/tmp/cursor", "--type=extensionHost"], "extensionHost")
        },
    );
    assert!(!is_editor_host(&table, 657));
    table.insert(700, shell(600, &[]));
    table.insert(
        658,
        FakeProcess {
            parent: 700,
            ..linux(&["/usr/share/cursor/cursor", "--version"], "extensionHost")
        },
    );
    assert!(!is_editor_host(&table, 658));
    // Nor Cursor's binary the extension host runs itself, which inherits
    // the host's environment.
    table.insert(
        659,
        FakeProcess {
            parent: 654,
            ..linux(&["/usr/share/cursor/cursor", "--version"], "extensionHost")
        },
    );
    assert!(!is_editor_host(&table, 659));
    // Nor a Linux host whose parent is another binary than its own.
    table.insert(
        660,
        FakeProcess {
            parent: 600,
            ..linux(&utility, "extensionHost")
        },
    );
    assert!(!is_editor_host(&table, 660));
}

#[test]
fn a_helper_started_by_cursor_run_as_node_is_not_the_editor() {
    let (_temp, _config, table) = world();
    let main = |environment: &[(&str, &str)], arguments: &[&str], executable: &str| FakeProcess {
        parent: 1,
        uid: uid(),
        start: 10,
        executable: Some(PathBuf::from(executable)),
        arguments: arguments
            .iter()
            .map(|argument| argument.to_string())
            .collect(),
        environment: environment
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
        ..FakeProcess::default()
    };
    let app = "/Applications/Cursor.app/Contents/MacOS/Cursor";
    let under = |parent: i32| FakeProcess { parent, ..host(20) };
    // `ELECTRON_RUN_AS_NODE=1 Cursor parent.js` spawning the signed helper
    // with a host's title.
    table.insert(
        610,
        main(&[("ELECTRON_RUN_AS_NODE", "1")], &[app, "parent.js"], app),
    );
    table.insert(611, under(610));
    assert!(!is_editor_host(&table, 611));
    // A main process whose environment cannot be read proves nothing.
    table.insert(612, main(&[], &[app], app));
    table.insert(613, under(612));
    table.unreadable_environment.lock().unwrap().insert(612);
    assert!(!is_editor_host(&table, 613));
    // Nor one being debugged.
    table.insert(614, main(&[], &[app, "--inspect=9229"], app));
    table.insert(615, under(614));
    assert!(!is_editor_host(&table, 615));
    table.insert(630, main(&[], &[app, "--remote-debugging-port=9222"], app));
    table.insert(631, under(630));
    assert!(!is_editor_host(&table, 631));
    // Nor a helper whose parent is the same helper binary.
    table.insert(632, host(20));
    table.insert(633, under(632));
    assert!(!is_editor_host(&table, 633));
    // Nor another install's main process, even a trusted one.
    let other = "/Applications/Cursor 2.app/Contents/MacOS/Cursor";
    table.trust_cursor(other);
    table.insert(616, main(&[], &[other], other));
    table.insert(617, under(616));
    assert!(!is_editor_host(&table, 617));
    // A trusted, titled helper outside Cursor's bundle is not either.
    let copied = "/Users/someone/tmp/Cursor Helper (Plugin)";
    table.trust_cursor(copied);
    table.insert(
        618,
        FakeProcess {
            executable: Some(PathBuf::from(copied)),
            ..host(20)
        },
    );
    assert!(!is_editor_host(&table, 618));
}

#[test]
fn a_conversation_a_cursor_agent_holds_elsewhere_is_never_the_editors() {
    let (temp, config, table) = world();
    // The CLI session keeps its chats under another data folder than the
    // one the hook's environment names.
    let store = temp
        .path()
        .join("elsewhere/chats/ws")
        .join(SESSION)
        .join("store.db");
    std::fs::create_dir_all(store.parent().unwrap()).unwrap();
    std::fs::write(&store, b"").unwrap();
    table.insert(
        690,
        FakeProcess {
            parent: 1,
            uid: uid(),
            start: 100,
            executable: Some(PathBuf::from("/opt/cursor/bin/cursor-agent")),
            open_files: vec![store],
            ..FakeProcess::default()
        },
    );
    table.insert(700, shell(HOST_PID, &[]));
    assert_eq!(hook_caller(&config, &table, 700, SESSION), None);
    assert_eq!(
        hook_caller(&config, &table, 700, OTHER),
        Some(HookCaller::Editor { host: HOST_PID })
    );
}

#[test]
fn only_what_cursor_starts_for_a_hook_may_claim_without_naming_the_conversation() {
    let (_temp, config, table) = world();
    // A process two levels below the host that names no conversation
    // descends from a tool or an extension, not from Cursor's hook launch.
    table.insert(700, shell(HOST_PID, &[]));
    table.insert(701, shell(700, &[]));
    table.insert(702, shell(701, &[]));
    assert_eq!(hook_caller(&config, &table, 702, SESSION), None);
    // Under the host's `sh -c`, Cursor's hook is.
    table.insert(
        710,
        FakeProcess {
            executable: Some(PathBuf::from("/bin/sh")),
            arguments: vec![
                "/bin/sh".into(),
                "-c".into(),
                "probe relay cursor-hook".into(),
            ],
            ..shell(HOST_PID, &[])
        },
    );
    table.insert(711, shell(710, &[]));
    assert_eq!(
        hook_caller(&config, &table, 711, SESSION),
        Some(HookCaller::Editor { host: HOST_PID })
    );
    // A process whose environment cannot be read may be hiding the
    // conversation its tool runs.
    table.insert(720, shell(HOST_PID, &[(CONVERSATION_VAR, OTHER)]));
    table.insert(721, shell(720, &[(CONVERSATION_VAR, SESSION)]));
    table.unreadable_environment.lock().unwrap().insert(720);
    assert_eq!(hook_caller(&config, &table, 721, SESSION), None);
    table.unreadable_environment.lock().unwrap().insert(700);
    assert_eq!(hook_caller(&config, &table, 700, SESSION), None);
}

/// The `cursor-agent` worker a Cursor window's agent extension starts.
fn worker(parent: i32) -> FakeProcess {
    FakeProcess {
        parent,
        uid: uid(),
        start: 100,
        executable: Some(PathBuf::from("/opt/cursor/bin/cursor-agent")),
        arguments: [
            "cursor-agent",
            "--endpoint",
            "https://api2.cursor.sh",
            "worker",
            "start",
        ]
        .iter()
        .map(|argument| argument.to_string())
        .collect(),
        ..FakeProcess::default()
    }
}

#[test]
fn a_hook_under_the_editors_worker_is_the_editors() {
    let (_temp, config, table) = world();
    table.insert(720, worker(HOST_PID));
    table.insert(721, shell(720, &[]));
    assert_eq!(
        hook_caller(&config, &table, 721, SESSION),
        Some(HookCaller::Editor { host: HOST_PID })
    );
    // A worker under anything but an extension host ends the walk.
    table.insert(730, shell(600, &[]));
    table.insert(731, worker(730));
    table.insert(732, shell(731, &[]));
    assert_eq!(hook_caller(&config, &table, 732, SESSION), None);
}

#[test]
fn a_conversation_another_window_runs_is_not_this_windows() {
    let (_temp, config, table) = world();
    record_editor_hook(
        &config,
        &table,
        HOST_PID,
        HOST_PID,
        &hook_payload("postToolUse", SESSION),
    );
    table.insert(660, host(30));
    table.insert(661, shell(660, &[]));
    assert_eq!(hook_caller(&config, &table, 661, SESSION), None);
    // Its own window's next hook still is.
    table.insert(700, shell(HOST_PID, &[]));
    assert_eq!(
        hook_caller(&config, &table, 700, SESSION),
        Some(HookCaller::Editor { host: HOST_PID })
    );
    // Once that window is gone, another may take the conversation up.
    table.remove(HOST_PID);
    assert_eq!(
        hook_caller(&config, &table, 661, SESSION),
        Some(HookCaller::Editor { host: 660 })
    );
}

#[test]
fn a_tool_of_one_conversation_cannot_hook_as_another() {
    let (_temp, config, table) = world();
    // `echo '{…OTHER…}' | probe relay cursor-hook` from SESSION's shell.
    table.insert(701, shell(HOST_PID, &[(CONVERSATION_VAR, SESSION)]));
    table.insert(702, shell(701, &[]));
    assert_eq!(hook_caller(&config, &table, 702, OTHER), None);
    assert_eq!(
        hook_caller(&config, &table, 702, SESSION),
        Some(HookCaller::Editor { host: HOST_PID })
    );
    // Overriding the variable on the hook does not hide the shell's.
    table.insert(703, shell(701, &[(CONVERSATION_VAR, OTHER)]));
    assert_eq!(hook_caller(&config, &table, 703, OTHER), None);
}

#[test]
fn a_hook_the_extension_host_runs_is_the_editors() {
    let (_temp, config, table) = world();
    assert_eq!(
        hook_caller(&config, &table, HOST_PID, SESSION),
        Some(HookCaller::Editor { host: HOST_PID })
    );
    // Through a shell that did not exec the hook, too.
    table.insert(700, shell(HOST_PID, &[]));
    assert_eq!(
        hook_caller(&config, &table, 700, SESSION),
        Some(HookCaller::Editor { host: HOST_PID })
    );
    // A Cursor CLI the editor's agent started is its own session, and a
    // hook under it is the CLI's, never the editor's.
    table.insert(
        710,
        FakeProcess {
            parent: 700,
            uid: uid(),
            start: 100,
            executable: Some(PathBuf::from("/opt/cursor/bin/cursor-agent")),
            ..FakeProcess::default()
        },
    );
    table.insert(711, shell(710, &[]));
    assert_eq!(hook_caller(&config, &table, 711, SESSION), None);
    // Nor is another user's extension host.
    table.insert(
        655,
        FakeProcess {
            uid: uid() + 1,
            ..host(20)
        },
    );
    assert_eq!(hook_caller(&config, &table, 655, SESSION), None);
}

#[test]
fn an_editor_conversation_takes_messages_while_its_window_runs() {
    let (_temp, config, table) = world();
    // Before any hook of it ran, nothing says the conversation is open.
    assert!(matches!(
        send(&config, &table, uid(), SESSION, "m-1", "hello"),
        InjectOutcome::Waiting(_)
    ));
    record_editor_hook(
        &config,
        &table,
        HOST_PID,
        HOST_PID,
        &hook_payload("postToolUse", SESSION),
    );
    assert!(running(&config, &table, uid(), SESSION));
    assert!(!running(&config, &table, uid(), OTHER));
    assert!(matches!(
        send(
            &config,
            &table,
            uid(),
            SESSION,
            "m-1",
            "[via Agent Relay · ref 1]\nhello"
        ),
        InjectOutcome::Accepted(_)
    ));
    let answer = hook_answer(&config, &hook_payload("postToolUse", SESSION)).unwrap();
    assert!(answer.output["additional_context"]
        .as_str()
        .unwrap()
        .contains("hello"));
    drain(&answer.claimed);
    assert_eq!(
        send(&config, &table, uid(), SESSION, "m-1", "hello"),
        InjectOutcome::Delivered
    );
    // A new extension host in the same pid (the window reloaded) is not
    // the one that ran the conversation.
    table.insert(HOST_PID, host(21));
    assert!(!running(&config, &table, uid(), SESSION));
    assert!(matches!(
        send(&config, &table, uid(), SESSION, "m-2", "again"),
        InjectOutcome::Waiting(_)
    ));
}

#[test]
fn a_hook_naming_no_conversation_takes_up_only_one_running_now() {
    let (_temp, config, table) = world();
    table.insert(700, shell(HOST_PID, &[]));
    // No transcript, or one Cursor last wrote over an hour ago: a closed or
    // reloaded window's conversation, which a hook launch cannot take up.
    std::fs::remove_file(own_transcript(&config, OTHER)).unwrap();
    assert!(!record_editor_hook(
        &config,
        &table,
        700,
        HOST_PID,
        &hook_payload("stop", OTHER)
    ));
    assert!(!running(&config, &table, uid(), OTHER));
    let old = std::fs::File::create(own_transcript(&config, OTHER)).unwrap();
    old.set_modified(std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60))
        .unwrap();
    assert!(!record_editor_hook(
        &config,
        &table,
        700,
        HOST_PID,
        &hook_payload("stop", OTHER)
    ));
    // One running now is taken up, and stays its window's while that window
    // runs, however old its transcript gets.
    assert!(record_editor_hook(
        &config,
        &table,
        700,
        HOST_PID,
        &hook_payload("stop", SESSION)
    ));
    std::fs::File::options()
        .write(true)
        .open(own_transcript(&config, SESSION))
        .unwrap()
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60))
        .unwrap();
    assert!(record_editor_hook(
        &config,
        &table,
        700,
        HOST_PID,
        &hook_payload("stop", SESSION)
    ));
    // A second window's first hook then finds it taken.
    table.insert(660, host(30));
    table.insert(661, shell(660, &[]));
    assert!(!record_editor_hook(
        &config,
        &table,
        661,
        660,
        &hook_payload("stop", SESSION)
    ));
    assert_eq!(
        live(&config, &table, uid(), SESSION).map(|row| row.host_pid),
        Some(HOST_PID)
    );
}

#[test]
fn the_activity_gate_reads_the_windows_data_folder_never_the_hooks() {
    let (temp, config, table) = world();
    // The window's Cursor keeps its data in another folder; its main
    // process's environment says so.
    let custom = temp.path().join("custom-cursor");
    let mut main = table.processes.lock().unwrap()[&600].clone();
    main.environment.insert(
        "CURSOR_DATA_DIR".into(),
        custom.to_string_lossy().into_owned(),
    );
    table.insert(600, main);
    let mut window = config.clone();
    window.data_dir = custom;
    std::fs::remove_file(own_transcript(&config, SESSION)).unwrap();
    std::fs::create_dir_all(own_transcript(&window, SESSION).parent().unwrap()).unwrap();
    std::fs::write(own_transcript(&window, SESSION), b"").unwrap();
    table.insert(700, shell(HOST_PID, &[]));
    // A hook whose own environment names an empty folder changes nothing.
    let mut hook = config.clone();
    hook.data_dir = temp.path().join("empty");
    assert!(record_editor_hook(
        &hook,
        &table,
        700,
        HOST_PID,
        &hook_payload("stop", SESSION)
    ));
    // A fresh transcript in a folder this window does not use is not its
    // conversation running now, whatever the hook's environment names.
    let mut fake = config.clone();
    fake.data_dir = temp.path().join(".cursor");
    assert!(!record_editor_hook(
        &fake,
        &table,
        700,
        HOST_PID,
        &hook_payload("stop", OTHER)
    ));
}

#[test]
fn a_record_whose_host_pid_was_reused_is_removed() {
    let (_temp, config, table) = world();
    record_editor_hook(
        &config,
        &table,
        HOST_PID,
        HOST_PID,
        &hook_payload("postToolUse", SESSION),
    );
    let path = config
        .home
        .join(".agentworkforce/desktop/cursor/editor")
        .join(format!("{SESSION}.json"));
    assert!(path.is_file());
    table.insert(HOST_PID, shell(1, &[]));
    assert!(sessions(&config, &table, uid()).is_empty());
    assert!(!path.exists());
}

#[test]
fn removing_a_stale_record_keeps_a_window_that_claimed_the_conversation_since() {
    let (_temp, config, table) = world();
    let payload = hook_payload("postToolUse", SESSION);
    record_editor_hook(&config, &table, HOST_PID, HOST_PID, &payload);
    let path = config
        .home
        .join(".agentworkforce/desktop/cursor/editor")
        .join(format!("{SESSION}.json"));
    let newer = read(&path).unwrap();
    let stale = Record {
        host_pid: newer.host_pid + 1,
        ..newer.clone()
    };
    remove_stale(&config, SESSION, &stale);
    assert_eq!(read(&path), Some(newer.clone()));
    remove_stale(&config, SESSION, &newer);
    assert!(!path.exists());
}

#[test]
fn removing_a_stale_record_never_waits_for_a_claim_holding_the_lock() {
    let (_temp, config, table) = world();
    let payload = hook_payload("postToolUse", SESSION);
    record_editor_hook(&config, &table, HOST_PID, HOST_PID, &payload);
    let path = config
        .home
        .join(".agentworkforce/desktop/cursor/editor")
        .join(format!("{SESSION}.json"));
    let stale = read(&path).unwrap();
    let held = lock_file(&config, SESSION).unwrap();
    fs2::FileExt::lock_exclusive(&held).unwrap();
    remove_stale(&config, SESSION, &stale);
    assert_eq!(read(&path), Some(stale.clone()));
    fs2::FileExt::unlock(&held).unwrap();
    remove_stale(&config, SESSION, &stale);
    assert!(!path.exists());
}

#[test]
fn a_blank_first_workspace_root_is_skipped() {
    assert_eq!(
        payload_workspace(&json!({"workspace_roots": ["", " ", "/work/api"]})),
        Some("/work/api")
    );
    assert_eq!(payload_workspace(&json!({"workspace_roots": [""]})), None);
}

#[test]
fn a_conversation_idle_past_the_window_is_not_live() {
    let (_temp, config, table) = world();
    record_editor_hook(
        &config,
        &table,
        HOST_PID,
        HOST_PID,
        &hook_payload("stop", SESSION),
    );
    let path = config
        .home
        .join(".agentworkforce/desktop/cursor/editor")
        .join(format!("{SESSION}.json"));
    let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["seen_ms"] = json!(record["seen_ms"].as_i64().unwrap() - IDLE.as_millis() as i64 - 1);
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert!(live(&config, &table, uid(), SESSION).is_none());
    assert!(discover(&config, &table, uid()).is_empty());
    // Its window still runs it: another window cannot take it over.
    table.insert(660, host(30));
    table.insert(661, shell(660, &[]));
    assert_eq!(hook_caller(&config, &table, 661, SESSION), None);
    table.insert(700, shell(HOST_PID, &[]));
    assert_eq!(
        hook_caller(&config, &table, 700, SESSION),
        Some(HookCaller::Editor { host: HOST_PID })
    );
}

#[test]
fn the_session_list_shows_editor_conversations_named_by_their_first_prompt() {
    let (_temp, config, table) = world();
    std::fs::remove_dir_all(own_transcript(&config, SESSION).parent().unwrap()).unwrap();
    let transcripts = config.data_dir.join("projects/work-api/agent-transcripts");
    let parent = "2a1b9a8e-0d0e-4f3c-9d55-8a7b9f1d2c3e";
    std::fs::create_dir_all(transcripts.join(parent).join("subagents")).unwrap();
    std::fs::write(
        transcripts.join(parent).join("subagents").join(format!("{SESSION}.jsonl")),
        concat!(
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>now</timestamp>\n<user_query>\nFix the flaky login test\nand more\n</user_query>"}]}}"#,
            "\n"
        ),
    )
    .unwrap();
    record_editor_hook(
        &config,
        &table,
        HOST_PID,
        HOST_PID,
        &hook_payload("postToolUse", SESSION),
    );
    let rows = discover(&config, &table, uid());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].target, Target::new(SessionKind::CursorCli, SESSION));
    assert_eq!(rows[0].title, "Fix the flaky login test");
    assert_eq!(rows[0].directory.as_deref(), Some("/work/api"));
    assert_eq!(rows[0].host.as_deref(), Some(HOST));
    assert!(rows[0].live);
    assert_eq!(
        session(&config, &table, uid(), SESSION).map(|row| row.target.id),
        Some(SESSION.to_string())
    );
    // A subagent's transcript settles its claims like a CLI session's.
    assert_eq!(transcripts_for(&config, SESSION).len(), 1);
}

fn transcripts_for(config: &CursorConfig, session: &str) -> Vec<PathBuf> {
    super::inbox::transcripts(config, session)
}

/// A real Cursor editor conversation, `RELAY_CURSOR_EDITOR_SESSION`, whose
/// window runs this checkout's hook with the inbox in the disposable home
/// `RELAY_CURSOR_LIVE_HOME`: once a hook of it has run, one message is
/// staged and must be handed over at one of its next tool calls.
#[test]
#[ignore = "needs a Cursor editor conversation running this checkout's hook"]
fn live_editor_conversation_gets_its_message_once() {
    let home = PathBuf::from(std::env::var("RELAY_CURSOR_LIVE_HOME").unwrap());
    let session = std::env::var("RELAY_CURSOR_EDITOR_SESSION").unwrap();
    let config = CursorConfig::from_env(&|key| std::env::var(key).ok(), &home);
    let table = crate::relay::process::SystemProcesses::default();
    let wait = |what: &str, check: &dyn Fn() -> bool| {
        let deadline = std::time::Instant::now() + Duration::from_secs(300);
        while !check() {
            assert!(std::time::Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(250));
        }
    };
    wait("the conversation is live", &|| {
        live(&config, &table, uid(), &session).is_some()
    });
    let row = session_row(&config, &table, &session);
    eprintln!("listed as {row:?}");
    let text = "[via Agent Relay — from @relay-live-test-nobody to @cursor-editor-live · ref liveeditor01]\nA note from a peer, for a test: the word for this test is PAPAYA-7. No action is needed.\n[end of Agent Relay message · ref liveeditor01]";
    assert!(matches!(
        send(&config, &table, uid(), &session, "live-editor-1", text),
        InjectOutcome::Accepted(_)
    ));
    wait("the message is handed over", &|| {
        send(&config, &table, uid(), &session, "live-editor-1", text) == InjectOutcome::Delivered
    });
    assert!(pending(&config, &session).is_empty());
}

fn session_row(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    id: &str,
) -> Option<crate::relay::sessions::DiscoveredSession> {
    session(config, table, uid(), id)
}

#[test]
fn a_tool_of_the_editors_agent_is_the_conversation_its_environment_names() {
    let (_temp, config, table) = world();
    // probe (702) → zsh (701) → extension host
    table.insert(701, shell(HOST_PID, &[]));
    table.insert(702, shell(701, &[(CONVERSATION_VAR, SESSION)]));
    // The variable alone puts no conversation on this window.
    assert_eq!(editor_caller(&config, &table, 702, HOST_PID), None);
    assert!(!running(&config, &table, uid(), SESSION));
    // Once a hook of the conversation ran here, its tools are it.
    record_editor_hook(
        &config,
        &table,
        HOST_PID,
        HOST_PID,
        &json!({
            "hook_event_name": "postToolUse",
            "conversation_id": SESSION,
        }),
    );
    assert_eq!(
        editor_caller(&config, &table, 702, HOST_PID).as_deref(),
        Some(SESSION)
    );
    // A payload without folders left none; the tool's directory fills in.
    assert_eq!(
        live(&config, &table, uid(), SESSION).and_then(|row| row.workspace),
        Some("/work/api".to_string())
    );
    // A payload without folders keeps it; the window's folder replaces it;
    // a later tool's directory does not.
    record_editor_hook(
        &config,
        &table,
        HOST_PID,
        HOST_PID,
        &json!({
            "hook_event_name": "stop",
            "conversation_id": SESSION,
        }),
    );
    assert_eq!(
        live(&config, &table, uid(), SESSION).and_then(|row| row.workspace),
        Some("/work/api".to_string())
    );
    record_editor_hook(
        &config,
        &table,
        HOST_PID,
        HOST_PID,
        &json!({
            "hook_event_name": "postToolUse",
            "conversation_id": SESSION,
            "workspace_roots": ["/work/web"],
        }),
    );
    editor_caller(&config, &table, 702, HOST_PID);
    assert_eq!(
        live(&config, &table, uid(), SESSION).and_then(|row| row.workspace),
        Some("/work/web".to_string())
    );
    // Another window's tool naming it is nobody.
    table.insert(660, host(30));
    table.insert(661, shell(660, &[(CONVERSATION_VAR, SESSION)]));
    assert_eq!(editor_caller(&config, &table, 661, 660), None);
    // Nor is a tool whose ancestors name another conversation.
    table.insert(705, shell(HOST_PID, &[(CONVERSATION_VAR, OTHER)]));
    table.insert(706, shell(705, &[(CONVERSATION_VAR, SESSION)]));
    assert_eq!(editor_caller(&config, &table, 706, HOST_PID), None);
    // Without the variable, or with one that is no conversation id, nobody.
    table.insert(703, shell(HOST_PID, &[]));
    assert_eq!(editor_caller(&config, &table, 703, HOST_PID), None);
    table.insert(704, shell(HOST_PID, &[(CONVERSATION_VAR, "../etc")]));
    assert_eq!(editor_caller(&config, &table, 704, HOST_PID), None);
    // And never under anything but an extension host.
    assert_eq!(editor_caller(&config, &table, 702, 701), None);
}
