use super::*;
use std::io::Write;
const SID: &str = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";

fn start(timestamp: u64) -> Value {
    json!({"type":"hook.start","data":{"hookInvocationId":format!("stop-{timestamp}"),
        "hookType":"agentStop","input":{"sessionId":SID,"timestamp":timestamp,"stopReason":"end_turn"}}})
}
fn append(path: &std::path::Path, value: Value) {
    writeln!(
        std::fs::OpenOptions::new().append(true).open(path).unwrap(),
        "{value}"
    )
    .unwrap();
}
fn fixture() -> (tempfile::TempDir, CopilotConfig, PathBuf, Value) {
    let home = tempfile::tempdir().unwrap();
    let config = CopilotConfig::from_env(&|_| None, home.path());
    let path = path(&config, SID).unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        format!(
            "{}\n{}\n{}\n",
            start(100),
            json!({"type":"abort"}),
            start(200)
        ),
    )
    .unwrap();
    let payload = json!({"timestamp":200,"relayJournal":snapshot(&config,SID).unwrap()});
    (home, config, path, payload)
}

#[test]
fn an_abort_after_this_stop_releases_the_wait_but_old_aborts_do_not() {
    let (_home, config, path, payload) = fixture();
    assert!(!cancelled(&config, SID, &payload));
    append(&path, json!({"type":"abort"}));
    assert!(cancelled(&config, SID, &payload));
    append(&path, start(300));
    let next = json!({"timestamp":300,"relayJournal":snapshot(&config,SID).unwrap()});
    assert!(!cancelled(&config, SID, &next));
    assert!(cancelled(&config, SID, &payload));
}

#[test]
fn a_human_turn_or_native_error_also_releases_the_wait() {
    for kind in ["user.message", "session.error"] {
        let (_home, config, path, payload) = fixture();
        append(&path, json!({"type":kind,"data":{}}));
        assert!(cancelled(&config, SID, &payload));
    }
}

#[test]
fn partial_appends_wait_for_the_complete_record_and_corruption_releases() {
    let (_home, config, path, payload) = fixture();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap();
    file.write_all(b"{\"type\":\"abor").unwrap();
    assert!(!cancelled(&config, SID, &payload));
    file.write_all(b"t\"}\n").unwrap();
    assert!(cancelled(&config, SID, &payload));
    let (_home, config, path, payload) = fixture();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"invalid\n")
        .unwrap();
    assert!(cancelled(&config, SID, &payload));
}

#[test]
fn replacement_truncation_and_missing_anchors_never_claim_a_delivery() {
    let (_home, config, path, payload) = fixture();
    let copy = path.with_extension("replacement");
    std::fs::copy(&path, &copy).unwrap();
    std::fs::rename(copy, &path).unwrap();
    assert!(cancelled(&config, SID, &payload));
    let (_home, config, path, payload) = fixture();
    std::fs::write(&path, format!("{}\n", start(200))).unwrap();
    assert!(cancelled(&config, SID, &payload));
    let (_home, config, _path, mut payload) = fixture();
    payload["timestamp"] = json!(999);
    assert!(cancelled(&config, SID, &payload));
    assert!(cancelled(&config, "../../outside", &payload));
}

#[test]
fn read_is_bounded_and_does_not_reuse_an_unreachable_anchor() {
    let (_home, config, path, payload) = fixture();
    append(
        &path,
        json!({"type":"fixture","data":"x".repeat(LIMIT as usize)}),
    );
    assert!(cancelled(&config, SID, &payload));
}

#[cfg(unix)]
#[test]
fn a_symlink_or_named_pipe_is_unavailable_without_waiting_for_io() {
    use std::os::unix::fs::symlink;
    let (_home, config, path, payload) = fixture();
    let moved = path.with_extension("original");
    std::fs::rename(&path, &moved).unwrap();
    symlink(&moved, &path).unwrap();
    assert!(snapshot(&config, SID).is_none());
    assert!(cancelled(&config, SID, &payload));
    std::fs::remove_file(&path).unwrap();
    nix::unistd::mkfifo(
        &path,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    assert!(snapshot(&config, SID).is_none());
    assert!(cancelled(&config, SID, &payload));
}

#[cfg(target_os = "macos")]
#[test]
fn cancellation_exits_idle_wait_and_leaves_an_offered_message_for_the_next_hook() {
    use crate::relay::codex::turn_hook::Claimed;
    use crate::relay::copilot::{hook_answer, proof, CopilotSettings};
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    {
        let mut processes = table.processes.lock().unwrap();
        let hook = processes.get_mut(&103).unwrap();
        hook.executable = Some("/opt/agent-relay-desktop-probe".into());
        hook.arguments = [
            "/opt/agent-relay-desktop-probe",
            "copilot-hook",
            "--event",
            "start",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
    }
    let mut payload = json!({"sessionId":SID,"relayEvent":"start","relayBinding":"binding"});
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload),
        Some(json!({}))
    );
    *table
        .processes
        .lock()
        .unwrap()
        .get_mut(&103)
        .unwrap()
        .arguments
        .last_mut()
        .unwrap() = "stop".into();
    let path = path(&config, SID).unwrap();
    std::fs::write(&path, format!("{}\n", start(200))).unwrap();
    payload["relayEvent"] = json!("stop");
    payload["stopReason"] = json!("end_turn");
    payload["timestamp"] = json!(200);
    payload["relayJournal"] = snapshot(&config, SID).unwrap();
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload),
        Some(json!({}))
    );
    append(&path, json!({"type":"abort"}));
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
    let thread = format!("{SID}:binding");
    config
        .inbox
        .offer(&thread, "cancelled-wait-message", "A real offered message")
        .unwrap();
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
    assert!(config.inbox.has_offered(&thread));
    assert!(matches!(
        config.inbox.claimed("cancelled-wait-message"),
        Claimed::Offered
    ));
    append(&path, start(300));
    payload["timestamp"] = json!(300);
    payload["relayJournal"] = snapshot(&config, SID).unwrap();
    let answer = hook_answer(&config, &table, 501, 103, &payload).unwrap();
    assert_eq!(answer["decision"], "block");
    assert!(answer["reason"]
        .as_str()
        .unwrap()
        .contains("A real offered message"));
}
