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
fn a_delayed_stop_anchor_keeps_the_file_identity_and_observed_length() {
    let (_home, config, path, _) = fixture();
    let original = snapshot(&config, SID).unwrap();
    let mut retries = 0;
    let stamp = snapshot_after_start(&config, SID, 300, || {
        retries += 1;
        append(&path, start(300));
        true
    })
    .unwrap();
    assert_eq!(retries, 1);
    assert_eq!(stamp["identity"], original["identity"]);
    assert_eq!(stamp["length"], std::fs::metadata(&path).unwrap().len());
    assert!(stamp["length"].as_u64().unwrap() > original["length"].as_u64().unwrap());
    assert!(stamp["offset"].is_u64());
    assert!(!cancelled(
        &config,
        SID,
        &json!({"timestamp":300,"relayJournal":stamp})
    ));
}

#[test]
fn queued_model_records_do_not_evict_the_active_stop_anchor() {
    let (_home, config, path, _) = fixture();
    let stamp = snapshot_after_start(&config, SID, 200, || false).unwrap();
    for _ in 0..5 {
        append(
            &path,
            json!({"type":"model.messages_snapshot","data":{"content":"x".repeat(20_000)}}),
        );
    }
    let payload = json!({"timestamp":200,"relayJournal":stamp});
    assert!(!cancelled(&config, SID, &payload));
    append(&path, json!({"type":"abort"}));
    assert!(cancelled(&config, SID, &payload));
}

#[test]
fn startup_finds_its_anchor_beneath_an_already_flushed_model_batch() {
    let (_home, config, path, _) = fixture();
    append(
        &path,
        json!({"type":"model.messages_snapshot","data":"x".repeat(2 * LIMIT as usize)}),
    );
    let stamp = snapshot_after_start(&config, SID, 200, || false).unwrap();
    let payload = json!({"timestamp":200,"relayJournal":stamp});
    assert!(!cancelled(&config, SID, &payload));
    append(&path, json!({"type":"user.message"}));
    assert!(cancelled(&config, SID, &payload));
}

#[test]
fn anchored_scans_remain_bounded_and_reject_invalid_offsets_and_corruption() {
    let (_home, config, path, _) = fixture();
    let stamp = snapshot_after_start(&config, SID, 200, || false).unwrap();
    let mut payload = json!({"timestamp":200,"relayJournal":stamp});
    let mut invalid = payload.clone();
    invalid["relayJournal"]["offset"] = json!(u64::MAX);
    assert!(cancelled(&config, SID, &invalid));
    invalid["relayJournal"]["offset"] = json!("not-an-offset");
    assert!(cancelled(&config, SID, &invalid));
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"invalid\n")
        .unwrap();
    assert!(cancelled(&config, SID, &payload));
    // A sparse oversized append must fail before allocating or reading it.
    let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(payload["relayJournal"]["offset"].as_u64().unwrap() + MAX_SCAN + 1)
        .unwrap();
    assert!(cancelled(&config, SID, &payload));
    payload["relayJournal"]["offset"] = json!(0);
    assert!(cancelled(&config, SID, &payload));
}

#[test]
fn a_cancel_during_delayed_startup_is_not_lost() {
    let (_home, config, path, _) = fixture();
    let stamp = snapshot_after_start(&config, SID, 300, || {
        append(&path, start(300));
        append(&path, json!({"type":"abort"}));
        true
    })
    .unwrap();
    assert!(cancelled(
        &config,
        SID,
        &json!({"timestamp":300,"relayJournal":stamp})
    ));
}

#[test]
fn truncation_cannot_erase_a_cancel_observed_with_a_delayed_anchor() {
    let (_home, config, path, _) = fixture();
    let mut anchor_end = 0;
    let stamp = snapshot_after_start(&config, SID, 300, || {
        append(&path, start(300));
        anchor_end = std::fs::metadata(&path).unwrap().len();
        append(&path, json!({"type":"abort"}));
        true
    })
    .unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(anchor_end)
        .unwrap();
    assert!(cancelled(
        &config,
        SID,
        &json!({"timestamp":300,"relayJournal":stamp})
    ));
}

#[test]
fn delayed_startup_retains_the_length_floor_before_its_anchor_arrives() {
    let (_home, config, path, _) = fixture();
    let original = std::fs::read(&path).unwrap();
    let mut retries = 0;
    let stamp = snapshot_after_start(&config, SID, 300, || {
        retries += 1;
        if retries == 1 {
            append(
                &path,
                json!({"type":"model.messages_snapshot","data":"x".repeat(4096)}),
            );
        } else {
            // Erase an already observed append, while still leaving a file
            // larger than the original snapshot and containing our anchor.
            std::fs::write(&path, &original).unwrap();
            append(&path, start(300));
        }
        true
    });
    assert!(stamp.is_none());
    assert_eq!(retries, 2);
}

#[test]
fn a_partial_start_record_waits_for_its_newline() {
    let (_home, config, path, _) = fixture();
    let mut retries = 0;
    let stamp = snapshot_after_start(&config, SID, 300, || {
        retries += 1;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        if retries == 1 {
            write!(file, "{}", start(300)).unwrap();
        } else {
            writeln!(file).unwrap();
        }
        true
    })
    .unwrap();
    assert_eq!(retries, 2);
    assert!(!cancelled(
        &config,
        SID,
        &json!({"timestamp":300,"relayJournal":stamp})
    ));
}

#[test]
fn a_missing_anchor_times_out_and_a_replaced_or_truncated_journal_is_not_rebased() {
    let (_home, config, _, _) = fixture();
    assert!(snapshot_after_start(&config, SID, 300, || false).is_none());
    for replace in [true, false] {
        let (_home, config, path, _) = fixture();
        let mut retries = 0;
        assert!(snapshot_after_start(&config, SID, 300, || {
            retries += 1;
            if replace {
                let replacement = path.with_extension("replacement");
                std::fs::write(&replacement, format!("{}\n", start(300))).unwrap();
                std::fs::rename(replacement, &path).unwrap();
            } else {
                std::fs::write(&path, format!("{}\n", start(300))).unwrap();
            }
            true
        })
        .is_none());
        assert_eq!(retries, 1);
    }
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
fn non_object_or_untyped_complete_records_are_unverifiable_after_the_anchor() {
    for value in [
        json!(null),
        json!([]),
        json!(["fixture"]),
        json!(true),
        json!(42),
        json!("bad"),
        json!({}),
        json!({"type":7}),
    ] {
        let (_home, config, path, payload) = fixture();
        append(&path, value);
        assert!(cancelled(&config, SID, &payload));
    }
}

#[test]
fn an_append_after_the_read_snapshot_is_not_a_cancellation() {
    let (_home, config, path, _payload) = fixture();
    let history = format!("{}\n", json!({"type":"fixture","data":"x".repeat(4096)}));
    std::fs::write(&path, format!("{}{}\n", history.repeat(20), start(200))).unwrap();
    let payload = json!({"timestamp":200,"relayJournal":snapshot(&config,SID).unwrap()});
    let mut file = open(&path).unwrap();
    let length = file.metadata().unwrap().len();
    assert!(length > LIMIT);
    append(&path, json!({"type":"session.usage_record","data":{}}));
    let bytes = read_tail_at(&mut file, length).unwrap();
    assert!(bytes.len() as u64 <= LIMIT);
    assert_eq!(scan(&bytes, SID, 200), Some(false));
    assert!(!cancelled(&config, SID, &payload));
    append(&path, json!({"type":"abort"}));
    assert!(cancelled(&config, SID, &payload));
}

#[test]
fn a_complete_anchor_at_the_tail_boundary_is_preserved() {
    let (_home, config, path, _payload) = fixture();
    let anchor = format!("{}\n", start(200));
    let overhead = format!("{}\n", json!({"type":"fixture","data":""})).len();
    let filler = format!(
        "{}\n",
        json!({"type":"fixture","data":"x".repeat(LIMIT as usize-anchor.len()-overhead)})
    );
    let tail = format!("{anchor}{filler}");
    assert_eq!(tail.len() as u64, LIMIT);
    let prefix = format!("{}\n", json!({"type":"fixture"}));
    std::fs::write(&path, format!("{prefix}{tail}")).unwrap();
    let payload = json!({"timestamp":200,"relayJournal":snapshot(&config,SID).unwrap()});
    assert!(!cancelled(&config, SID, &payload));
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
    // Older native stop inputs still wait for a later offer. They cannot use
    // timestamp-based cancellation, but must not lose the existing idle route.
    payload.as_object_mut().unwrap().remove("timestamp");
    payload.as_object_mut().unwrap().remove("relayJournal");
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload),
        Some(json!({}))
    );
    config
        .inbox
        .offer(&thread, "legacy-stop-message", "A later legacy offer")
        .unwrap();
    let legacy = hook_answer(&config, &table, 501, 103, &payload).unwrap();
    assert_eq!(legacy["decision"], "block");
    assert!(legacy["reason"]
        .as_str()
        .unwrap()
        .contains("A later legacy offer"));
}
