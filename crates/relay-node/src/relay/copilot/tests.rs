#![cfg(target_os = "macos")]
use super::*;
use crate::relay::inject::InjectOutcome;
use serde_json::json;

#[test]
fn exact_hook_claim_survives_reopen_and_requires_native_acceptance() {
    let (_home, config, table, _) = proof::tests::fixture();
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    table
        .processes
        .lock()
        .unwrap()
        .get_mut(&103)
        .unwrap()
        .executable = Some("/opt/agent-relay-desktop-probe".into());
    table
        .processes
        .lock()
        .unwrap()
        .get_mut(&103)
        .unwrap()
        .arguments = [
        "/opt/agent-relay-desktop-probe",
        "copilot-hook",
        "--event",
        "start",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let mut payload = json!({"sessionId":sid,"relayEvent":"start","relayBinding":"fixture-binding","cwd":"/fixture/copilot-vscode","initialPrompt":"A Copilot chat"});
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload),
        Some(json!({}))
    );
    assert!(session(&config, &table, 501, sid).is_some());
    let message = "copilot-message-one";
    let reference = crate::relay::delivery::policy::MessageRef::of(message);
    let text = format!("[via Agent Relay ref {reference}]\nHello Copilot");
    assert!(matches!(
        send(&config, &table, 501, sid, "fixture-binding", message, &text),
        InjectOutcome::Waiting(_)
    ));
    payload["relayEvent"] = json!("stop");
    *table
        .processes
        .lock()
        .unwrap()
        .get_mut(&103)
        .unwrap()
        .arguments
        .last_mut()
        .unwrap() = "stop".into();
    payload["stopReason"] = json!("end_turn");
    let answer = hook_answer(&config, &table, 501, 103, &payload).unwrap();
    assert_eq!(answer["decision"], "block");
    assert!(answer["reason"].as_str().unwrap().contains("Hello Copilot"));
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload),
        Some(json!({})),
        "a second hook cannot take the same claim"
    );
    let reopened = CopilotConfig::from_env(&|_| None, &config.home);
    reopened.set_helper("/opt/agent-relay-desktop-probe".into());
    assert!(
        matches!(
            send(
                &reopened,
                &table,
                501,
                sid,
                "fixture-binding",
                message,
                &text
            ),
            InjectOutcome::Accepted(_)
        ),
        "reopening cannot restage a claimed delivery"
    );
    let native = config.sessions().join(sid).join("events.jsonl");
    std::fs::write(&native, format!("{}\n", json!({"type":"hook.end","data":{"hookType":"agentStop","success":true,"output":answer}}))).unwrap();
    assert!(
        matches!(
            send(
                &reopened,
                &table,
                501,
                sid,
                "fixture-binding",
                message,
                &text
            ),
            InjectOutcome::Accepted(_)
        ),
        "a hook decision is not a queued follow-up"
    );
    std::fs::write(
        &native,
        format!(
            "{}\n",
            json!({"type":"user.message","data":{"content":answer["reason"]}})
        ),
    )
    .unwrap();
    assert_eq!(
        send(
            &reopened,
            &table,
            501,
            sid,
            "fixture-binding",
            message,
            &text
        ),
        InjectOutcome::Delivered
    );
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(false)
        .unwrap();
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
}

#[test]
fn wrong_hook_identity_never_creates_a_discoverable_session() {
    let (_home, config, table, _) = proof::tests::fixture();
    named_hook(&table, "start");
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    let payload = json!({"sessionId":"69e50b90-b873-4de0-a36d-c9152a45e772","relayEvent":"start"});
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
    assert!(discover(&config, &table, 501).unwrap().is_empty());
}

#[test]
fn hooks_preserve_user_files_and_refuse_an_unrecognized_owned_path() {
    let home = tempfile::tempdir().unwrap();
    let config = CopilotConfig::from_env(&|_| None, home.path());
    let other = config.data_dir.join("hooks/custom.json");
    std::fs::create_dir_all(other.parent().unwrap()).unwrap();
    std::fs::write(&other, "user hooks").unwrap();
    let settings = CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into());
    settings.set_enabled(true).unwrap();
    settings.set_enabled(false).unwrap();
    assert_eq!(std::fs::read_to_string(other).unwrap(), "user hooks");
    std::fs::write(config.hooks_file(), r#"{"hooks":{"agentStop":[]}}"#).unwrap();
    assert!(settings.set_enabled(true).is_err());
    assert!(settings.set_enabled(false).is_err());
}

fn named_hook(table: &crate::relay::process::FakeProcesses, event: &str) {
    let mut all = table.processes.lock().unwrap();
    let hook = all.get_mut(&103).unwrap();
    hook.executable = Some("/opt/agent-relay-desktop-probe".into());
    hook.arguments = [
        "/opt/agent-relay-desktop-probe",
        "copilot-hook",
        "--event",
        event,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
}

#[test]
fn a_direct_mcp_child_or_wrong_event_is_not_the_configured_hook() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    let payload = json!({"sessionId":"1069773c-0824-4fad-b7f9-d3dc3c4ed148","relayEvent":"start"});
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
    named_hook(&table, "tool");
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
    named_hook(&table, "start");
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload),
        Some(json!({}))
    );
}

#[test]
fn an_offer_is_scoped_to_its_literal_registration_binding() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    named_hook(&table, "start");
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    let mut payload =
        json!({"sessionId":sid,"relayEvent":"start","relayBinding":"old-registration"});
    hook_answer(&config, &table, 501, 103, &payload).unwrap();
    assert!(matches!(
        send(
            &config,
            &table,
            501,
            sid,
            "old-registration",
            "old-message",
            "Old workspace message"
        ),
        InjectOutcome::Waiting(_)
    ));
    named_hook(&table, "stop");
    payload["relayEvent"] = json!("stop");
    payload["stopReason"] = json!("end_turn");
    payload["relayBinding"] = json!("new-registration");
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload),
        Some(json!({}))
    );
    payload["relayBinding"] = json!("old-registration");
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload).unwrap()["decision"],
        "block"
    );
}

#[test]
fn idle_polls_expose_nothing_and_cannot_take_an_offer_without_native_proof() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    let payload = json!({"sessionId":sid,"relayEvent":"stop","relayBinding":"binding","stopReason":"end_turn"});
    assert!(hook_answer(&config, &table, 501, 9999, &payload).is_none());
    assert!(discover(&config, &table, 501).unwrap().is_empty());
    config.prepare().unwrap();
    config
        .inbox
        .offer(&format!("{sid}:binding"), "offer", "message")
        .unwrap();
    assert!(hook_answer(&config, &table, 501, 9999, &payload).is_none());
    assert!(config.inbox.has_offered(&format!("{sid}:binding")));
}

#[test]
fn modified_owned_hook_settings_are_never_overwritten_or_enabled() {
    for (key, value) in [
        ("unexpected", json!(true)),
        ("hooks", json!({"agentStop":[]})),
    ] {
        let (_home, config, _table, _) = proof::tests::fixture();
        let settings = CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into());
        settings.set_enabled(true).unwrap();
        let mut document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(config.hooks_file()).unwrap()).unwrap();
        document[key] = value;
        let bytes = serde_json::to_vec(&document).unwrap();
        std::fs::write(config.hooks_file(), &bytes).unwrap();
        assert!(!settings.enabled());
        assert!(settings.set_enabled(true).is_err());
        assert!(settings.set_enabled(false).is_err());
        assert_eq!(std::fs::read(config.hooks_file()).unwrap(), bytes);
    }
}

#[test]
fn unreadable_or_corrupt_state_is_unavailable_and_never_replaced() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    named_hook(&table, "start");
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    config.prepare().unwrap();
    let path = config.state().join(format!("{sid}.json"));
    std::fs::write(&path, b"damaged state").unwrap();
    let payload = json!({"sessionId":sid,"relayEvent":"start"});
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
    assert!(discover(&config, &table, 501).is_none());
    assert_eq!(std::fs::read(&path).unwrap(), b"damaged state");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
    assert!(discover(&config, &table, 501).is_none());
}

#[test]
fn an_idle_hook_exits_after_its_observed_runtime_is_gone() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    named_hook(&table, "start");
    let mut payload =
        json!({"sessionId":"1069773c-0824-4fad-b7f9-d3dc3c4ed148","relayEvent":"start"});
    hook_answer(&config, &table, 501, 103, &payload).unwrap();
    named_hook(&table, "stop");
    payload["relayEvent"] = json!("stop");
    assert_eq!(
        hook_answer(&config, &table, 501, 103, &payload),
        Some(json!({}))
    );
    table.processes.lock().unwrap().remove(&102);
    assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
}

#[test]
fn a_matching_helper_path_without_our_program_identity_is_rejected() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    named_hook(&table, "start");
    table.trusted_relay_helpers.lock().unwrap().clear();
    assert!(hook_answer(
        &config,
        &table,
        501,
        103,
        &json!({"sessionId":"1069773c-0824-4fad-b7f9-d3dc3c4ed148","relayEvent":"start"})
    )
    .is_none());
}

#[test]
fn registration_replacement_cannot_replay_a_claimed_message() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    named_hook(&table, "start");
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    let mut payload = json!({"sessionId":sid,"relayEvent":"start","relayBinding":"old"});
    hook_answer(&config, &table, 501, 103, &payload).unwrap();
    let message = "stable-message";
    let text = format!(
        "[via Agent Relay ref {}]\nMessage",
        crate::relay::delivery::policy::MessageRef::of(message)
    );
    assert!(matches!(
        send(&config, &table, 501, sid, "old", message, &text),
        InjectOutcome::Waiting(_)
    ));
    named_hook(&table, "stop");
    payload["relayEvent"] = json!("stop");
    payload["stopReason"] = json!("end_turn");
    let answer = hook_answer(&config, &table, 501, 103, &payload).unwrap();
    assert_eq!(answer["decision"], "block");
    assert!(matches!(
        send(&config, &table, 501, sid, "replacement", message, &text),
        InjectOutcome::Accepted(_)
    ));
    assert!(!config.inbox.has_offered(&format!("{sid}:replacement")));
    std::fs::write(
        config.sessions().join(sid).join("events.jsonl"),
        format!(
            "{}\n",
            json!({"type":"user.message","data":{"content":answer["reason"]}})
        ),
    )
    .unwrap();
    assert_eq!(
        send(&config, &table, 501, sid, "replacement", message, &text),
        InjectOutcome::Delivered
    );
}

#[test]
fn hook_metadata_errors_are_not_reported_as_absence() {
    let (_home, config, _table, _) = proof::tests::fixture();
    let settings = CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into());
    std::fs::create_dir_all(&config.data_dir).unwrap();
    std::os::unix::fs::symlink("hooks", config.data_dir.join("hooks")).unwrap();
    assert!(settings.set_enabled(false).is_err());
    assert!(settings.set_enabled(true).is_err());
}

#[test]
fn missed_start_is_recovered_by_a_verified_idle_stop() {
    let (_home, config, table, _) = proof::tests::fixture();
    let settings = CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into());
    settings.set_enabled(true).unwrap();
    named_hook(&table, "stop");
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    assert_eq!(
        hook_answer(
            &config,
            &table,
            501,
            103,
            &json!({"sessionId":sid,"relayEvent":"stop","stopReason":"end_turn"})
        ),
        Some(json!({}))
    );
    assert!(session(&config, &table, 501, sid).is_some());
}

#[test]
fn a_stale_runtime_record_is_recovered_only_with_full_native_proof() {
    for old_pid in [102, 999] {
        let (_home, config, table, _) = proof::tests::fixture();
        CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
            .set_enabled(true)
            .unwrap();
        named_hook(&table, "stop");
        let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
        config.prepare().unwrap();
        let path = config.state().join(format!("{sid}.json"));
        let stale = json!({"pid":old_pid,"start":1,"title":"Earlier runtime","cwd":null});
        std::fs::write(&path, serde_json::to_vec(&stale).unwrap()).unwrap();
        let payload = json!({"sessionId":sid,"relayEvent":"stop","stopReason":"end_turn"});
        assert!(session(&config, &table, 501, sid).is_none());

        let trusted = table.trusted_vscode.lock().unwrap().clone();
        table.trusted_vscode.lock().unwrap().clear();
        assert!(hook_answer(&config, &table, 501, 103, &payload).is_none());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&path).unwrap()).unwrap(),
            stale,
            "unverified recovery must not replace the previous record"
        );
        *table.trusted_vscode.lock().unwrap() = trusted;
        assert_eq!(
            hook_answer(&config, &table, 501, 103, &payload),
            Some(json!({}))
        );
        assert!(session(&config, &table, 501, sid).is_some());
    }
}

#[test]
fn relative_helpers_are_rejected_before_writing_hooks() {
    let (_home, config, _table, _) = proof::tests::fixture();
    assert!(CopilotSettings::new(&config, "agent-relay-probe".into())
        .set_enabled(true)
        .is_err());
    assert!(!config.hooks_file().exists());
}

#[test]
fn a_long_sleep_cannot_expire_a_copilot_submission_claim() {
    use std::sync::atomic::{AtomicI64, Ordering};
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("claims.json");
    let clock = Arc::new(AtomicI64::new(1000));
    let first_clock = clock.clone();
    let first = TurnInbox::open(path.clone())
        .retain_claims()
        .with_clock(move || first_clock.load(Ordering::SeqCst));
    first.offer("chat", "message", "text").unwrap();
    first.answer("chat", crate::relay::codex::turn_hook::HookEvent::Stop);
    clock.store(3 * 24 * 60 * 60 * 1000, Ordering::SeqCst);
    let reopened = TurnInbox::open(path)
        .retain_claims()
        .with_clock(move || clock.load(Ordering::SeqCst));
    assert!(matches!(
        reopened.claimed("message"),
        crate::relay::codex::turn_hook::Claimed::Hook { .. }
    ));
}

#[test]
fn managed_hooks_can_be_repaired_or_removed_after_the_helper_moves() {
    let (_home, config, _table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/old-agent-relay-probe".into())
        .set_enabled(true)
        .unwrap();
    let current = CopilotSettings::new(&config, "/opt/new-agent-relay-probe".into());
    assert!(!current.enabled());
    current.set_enabled(true).unwrap();
    assert!(current.enabled());
    let next = CopilotSettings::new(&config, "/opt/another-agent-relay-probe".into());
    assert!(!next.enabled());
    next.set_enabled(false).unwrap();
    assert!(!config.hooks_file().exists());
}
#[test]
fn an_unclaimed_offer_moves_to_the_replacement_binding_atomically() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    named_hook(&table, "start");
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    hook_answer(
        &config,
        &table,
        501,
        103,
        &json!({"sessionId":sid,"relayEvent":"start"}),
    )
    .unwrap();
    send(
        &config,
        &table,
        501,
        sid,
        "old",
        "pending-message",
        "Message",
    );
    assert!(config.inbox.has_offered(&format!("{sid}:old")));
    send(
        &config,
        &table,
        501,
        sid,
        "new",
        "pending-message",
        "Message",
    );
    assert!(!config.inbox.has_offered(&format!("{sid}:old")));
    assert!(config.inbox.has_offered(&format!("{sid}:new")));
    named_hook(&table, "stop");
    let answer = hook_answer(
        &config,
        &table,
        501,
        103,
        &json!({"sessionId":sid,"relayEvent":"stop","stopReason":"end_turn","relayBinding":"new"}),
    )
    .unwrap();
    assert_eq!(answer["decision"], "block");
}

#[test]
fn legacy_relative_managed_hooks_are_disabled_but_can_be_removed() {
    let (_home, config, _table, _) = proof::tests::fixture();
    let settings = CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into());
    settings.set_enabled(true).unwrap();
    let text = std::fs::read_to_string(config.hooks_file())
        .unwrap()
        .replace("/opt/agent-relay-desktop-probe", "agent-relay-probe");
    std::fs::write(config.hooks_file(), text).unwrap();
    config.set_helper("agent-relay-probe".into());
    assert!(!settings.enabled());
    settings.set_enabled(false).unwrap();
    assert!(!config.hooks_file().exists());
}
#[test]
fn an_unreadable_native_journal_cannot_reset_the_identity_receipt_epoch() {
    let (_home, config, table, _) = proof::tests::fixture();
    CopilotSettings::new(&config, "/opt/agent-relay-desktop-probe".into())
        .set_enabled(true)
        .unwrap();
    named_hook(&table, "start");
    let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    let path = config.sessions().join(sid).join("events.jsonl");
    std::os::unix::fs::symlink("events.jsonl", &path).unwrap();
    assert!(hook_answer(
        &config,
        &table,
        501,
        103,
        &json!({"sessionId":sid,"relayEvent":"start"})
    )
    .is_none());
    assert!(!config.state().join(format!("{sid}.json")).exists());
}
