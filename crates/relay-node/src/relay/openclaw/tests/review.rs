//! Review follow-ups: Settings told when the Gateway changes, a refused
//! send never leaving its session busy, long turns' answers, a raised agent
//! timeout, and the person's own run in the main session.
use super::versions::{release, route, text};
use super::*;
use crate::relay::agents::SettingsExtension;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn settings_are_told_when_the_gateway_changes_what_it_can_do() {
    let fake = FakeGateway::release(release("2026.3.13"));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let told = Arc::new(AtomicUsize::new(0));
    let counter = told.clone();
    OpenClawSettings::new(&config).attach(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    let gateway = gateway(&config).unwrap();
    // The first Gateway seen, then the same one again: told once.
    drop(Connection::open(&config, &gateway).unwrap());
    drop(Connection::open(&config, &gateway).unwrap());
    assert_eq!(told.load(Ordering::SeqCst), 1);
    assert_eq!(config.unlimited_version().as_deref(), Some("2026.3.13"));
    // Upgraded: told again, and the notice goes.
    let upgraded = FakeGateway::release(release("2026.10.4"));
    let config_after = against(&upgraded, dir.path());
    let gateway_after = openclaw_gateway(&config_after);
    config.seen.record(
        &Connection::open(&config_after, &gateway_after)
            .unwrap()
            .features,
    );
    assert_eq!(told.load(Ordering::SeqCst), 2);
    assert_eq!(config.unlimited_version(), None);
}

fn openclaw_gateway(config: &OpenClawConfig) -> Gateway {
    gateway(config).unwrap()
}

#[test]
fn a_refused_send_does_not_leave_its_session_busy() {
    // Before 2026.5.2 only the last run this core started tells whether a
    // session is busy; a send the Gateway refused started none.
    for version in ["2026.3.13", "2026.3.22"] {
        let fake = FakeGateway::release(release(version));
        let dir = tempfile::tempdir().unwrap();
        let config = against(&fake, dir.path());
        fake.state.lock().unwrap().refuse_sends = true;
        let first = route("del_1", "m-1", "alice", "alice@node-1");
        assert!(matches!(
            send(&config, "main", "ws", &first, &text("m-1", "one")),
            InjectOutcome::Refused(_)
        ));
        fake.state.lock().unwrap().refuse_sends = false;
        let second = route("del_2", "m-2", "alice", "alice@node-1");
        assert_eq!(
            send(&config, "main", "ws", &second, &text("m-2", "two")),
            InjectOutcome::Delivered,
            "{version}"
        );
    }
}

#[test]
fn an_unconfirmed_send_still_holds_its_session() {
    // No response: the run may have started, so the next message waits.
    let dir = tempfile::tempdir().unwrap();
    let dropping = FakeGateway::serve_release(release("2026.3.13"), Behaviour::DropAfterSend);
    let config = against(&dropping, dir.path());
    let first = route("del_1", "m-1", "alice", "alice@node-1");
    let outcome = send(&config, "main", "ws", &first, &text("m-1", "one"));
    assert!(
        matches!(
            outcome,
            InjectOutcome::Accepted(_) | InjectOutcome::Retry(_)
        ),
        "{outcome:?}"
    );
    let key = session_key("main", "ws", &first);
    assert_eq!(
        delivery::session_run(&config, &key).map(|run| run.run_id),
        Some("del_1".to_string())
    );
}

#[test]
fn a_long_turns_answer_is_found_past_two_hundred_entries() {
    for version in ["2026.3.13", "2026.5.7", "2026.7.1", "2026.10.4"] {
        let fake = FakeGateway::release(release(version));
        fake.state.lock().unwrap().steps = 300;
        let dir = tempfile::tempdir().unwrap();
        let config = against(&fake, dir.path());
        let first = route("del_1", "m-1", "alice", "alice@node-1");
        assert_eq!(
            send(&config, "main", "ws", &first, &text("m-1", "a long job")),
            InjectOutcome::Delivered
        );
        assert_eq!(
            final_answer(&config, "main", &MessageRef::of("m-1")).as_deref(),
            Some("Answer: a long job"),
            "{version}"
        );
    }
}

#[test]
fn a_raised_agent_timeout_extends_how_long_a_turn_may_run() {
    let dir = tempfile::tempdir().unwrap();
    let config = configured(dir.path(), json!({}));
    let at = |version: &str| features_of(version);
    let cap = |version: &str| answer::run_cap_ms(&config, &at(version));
    // Unset: the release's own default, ten minutes on 3.13 (so the floor),
    // 48 hours from 3.22; plus five minutes' margin.
    assert_eq!(cap("2026.3.13"), Some(answer::RUN_CAP_MS));
    assert_eq!(cap("2026.3.22"), Some((48 * 3600 + 300) * 1000));
    assert_eq!(cap("2026.5.1"), Some((48 * 3600 + 300) * 1000));
    let write = |agents: &str| {
        std::fs::write(
            &config.config_path,
            format!("{{ gateway: {{}}, agents: {agents} }}"),
        )
        .unwrap()
    };
    // Explicit: two hours, plus the margin, on every release.
    write("{ defaults: { timeoutSeconds: 7200 } }");
    assert_eq!(cap("2026.3.13"), Some((7200 + 300) * 1000));
    assert_eq!(cap("2026.3.22"), Some((7200 + 300) * 1000));
    // Shorter than the floor: the floor stands.
    write("{ defaults: { timeoutSeconds: 60 } }");
    assert_eq!(cap("2026.3.22"), Some(answer::RUN_CAP_MS));
    // Zero: no time cap.
    write("{ defaults: { timeoutSeconds: 0 } }");
    assert_eq!(cap("2026.3.13"), None);
    assert_eq!(cap("2026.3.22"), None);
    // Not a number: the release's default.
    write("{ defaults: { timeoutSeconds: 'soon' } }");
    assert_eq!(cap("2026.3.13"), Some(answer::RUN_CAP_MS));

    // A turn sent 40 minutes ago still holds the session under a raised
    // timeout, and not under the default.
    let fake = FakeGateway::release(release("2026.3.13"));
    let config = against(&fake, dir.path());
    fake.hold();
    let first = route("del_1", "m-1", "alice", "alice@node-1");
    let _ = send(&config, "main", "ws", &first, &text("m-1", "slow"));
    let key = session_key("main", "ws", &first);
    let mut run = delivery::session_run(&config, &key).unwrap();
    run.sent_at_ms -= 40 * 60 * 1000;
    delivery::record_session_run(&config, &key, Some(&run)).unwrap();
    fake.state.lock().unwrap().uptime_ms = 60 * 60 * 1000;
    let second = route("del_2", "m-2", "alice", "alice@node-1");
    let text_two = text("m-2", "two");
    let mut file = std::fs::read_to_string(&config.config_path).unwrap();
    file = file.replace(
        "{ gateway:",
        "{ agents: { defaults: { timeoutSeconds: 3600 } }, gateway:",
    );
    std::fs::write(&config.config_path, &file).unwrap();
    assert!(matches!(
        send(&config, "main", "ws", &second, &text_two),
        InjectOutcome::Waiting(_)
    ));
    std::fs::write(
        &config.config_path,
        file.replace("agents: { defaults: { timeoutSeconds: 3600 } }, ", ""),
    )
    .unwrap();
    assert_eq!(
        send(&config, "main", "ws", &second, &text_two),
        InjectOutcome::Delivered
    );
}

#[test]
fn a_trusted_message_waits_for_the_persons_own_run() {
    // From 2026.3.22 the main session's row says it is running, whoever
    // started the run; 2026.3.13 gives no such signal.
    for (version, waits) in [
        ("2026.3.13", false),
        ("2026.3.22", true),
        ("2026.5.7", true),
        ("2026.6.1", true),
    ] {
        let fake = FakeGateway::release(release(version));
        let dir = tempfile::tempdir().unwrap();
        let config = against(&fake, dir.path());
        config.trusted.set(&json!(["ada-lovelace"])).unwrap();
        fake.person_run("agent:main:main", "person_1");
        let owner = route("del_1", "m-1", "ada-lovelace", "ada-lovelace@sf-mini");
        let outcome = send(&config, "main", "ws", &owner, &text("m-1", "hi"));
        assert_eq!(
            matches!(outcome, InjectOutcome::Waiting(_)),
            waits,
            "{version}: {outcome:?}"
        );
        fake.finish("person_1");
        if waits {
            assert_eq!(
                send(&config, "main", "ws", &owner, &text("m-1", "hi")),
                InjectOutcome::Delivered,
                "{version}"
            );
        }
    }
}

#[test]
fn a_running_status_left_by_a_restart_is_not_a_run() {
    let fake = FakeGateway::release(release("2026.3.22"));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    fake.person_run("agent:main:main", "person_1");
    // The run started before the Gateway did: a status the store kept.
    fake.state
        .lock()
        .unwrap()
        .started
        .insert("agent:main:main".into(), now_ms() - 120_000);
    let owner = route("del_1", "m-1", "ada-lovelace", "ada-lovelace@sf-mini");
    assert_eq!(
        send(&config, "main", "ws", &owner, &text("m-1", "hi")),
        InjectOutcome::Delivered
    );
}

#[test]
fn the_core_publishes_a_settings_invalidation_when_the_gateway_changes() {
    use crate::relay::protocol::Topic;
    let fake = FakeGateway::release(release("2026.3.13"));
    let temp = tempfile::tempdir().unwrap();
    let config = against(&fake, temp.path());
    let core_config = crate::relay::daemon::Config {
        paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: BTreeMap::new(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: crate::relay::push::PushTiming::default(),
        delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
    };
    let plugins = crate::relay::daemon::Plugins {
        settings: vec![Arc::new(OpenClawSettings::new(&config))],
        ..crate::relay::daemon::Plugins::default()
    };
    let (core, _signals) = crate::relay::daemon::Core::with_plugins(core_config, plugins);
    let mut events = core.hub().subscribe();
    let _ = discover(&config);
    let invalidated: Vec<Value> = std::iter::from_fn(|| events.try_recv().ok())
        .filter(|event| event.topic == Topic::Invalidated)
        .map(|event| event.data)
        .collect();
    assert_eq!(invalidated, [json!({ "what": "settings" })]);
    assert_eq!(core.settings()[UNLIMITED_SETTING], json!("2026.3.13"));
}

#[test]
fn the_persons_own_run_is_held_for_a_raised_agent_timeout() {
    // 2026.3.22 – 5.1: a trusted message to the main session, where the
    // person started a run 40 minutes ago that this core knows nothing of.
    let fake = FakeGateway::release(release("2026.3.22"));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    fake.person_run("agent:main:main", "person_1");
    {
        let mut state = fake.state.lock().unwrap();
        state.uptime_ms = 60 * 60 * 1000;
        state
            .started
            .insert("agent:main:main".into(), now_ms() - 40 * 60 * 1000);
    }
    let file = std::fs::read_to_string(&config.config_path).unwrap();
    let raised = file.replace(
        "{ gateway:",
        "{ agents: { defaults: { timeoutSeconds: 3600 } }, gateway:",
    );
    let owner = route("del_1", "m-1", "ada-lovelace", "ada-lovelace@sf-mini");
    // Under an hour's timeout the run may still be going: wait.
    std::fs::write(&config.config_path, &raised).unwrap();
    assert!(matches!(
        send(&config, "main", "ws", &owner, &text("m-1", "hi")),
        InjectOutcome::Waiting(_)
    ));
    // Under a one-minute timeout, 40 minutes is past any run: deliver.
    std::fs::write(
        &config.config_path,
        file.replace(
            "{ gateway:",
            "{ agents: { defaults: { timeoutSeconds: 60 } }, gateway:",
        ),
    )
    .unwrap();
    assert_eq!(
        send(&config, "main", "ws", &owner, &text("m-1", "hi")),
        InjectOutcome::Delivered
    );
}

fn features_of(version: &str) -> Features {
    Features::from_hello(&json!({
        "protocol": 3,
        "server": { "version": version },
        "features": { "methods": ["chat.send", "chat.history", "sessions.create", "sessions.list", "agent.wait"] },
    }))
}

#[test]
fn an_uncapped_run_still_ends() {
    // 3.22's own default is 48 hours, and 0 is no cap: a turn sent two
    // days ago ends only on its answer, a restart, or agent.wait.
    for agents in ["", "agents: { defaults: { timeoutSeconds: 0 } }, "] {
        let fake = FakeGateway::release(release("2026.3.22"));
        let dir = tempfile::tempdir().unwrap();
        let config = against(&fake, dir.path());
        let file = std::fs::read_to_string(&config.config_path).unwrap();
        std::fs::write(
            &config.config_path,
            file.replace("{ gateway:", &format!("{{ {agents}gateway:")),
        )
        .unwrap();
        fake.hold();
        let first = route("del_1", "m-1", "alice", "alice@node-1");
        let _ = send(&config, "main", "ws", &first, &text("m-1", "slow"));
        let key = session_key("main", "ws", &first);
        let mut run = delivery::session_run(&config, &key).unwrap();
        run.sent_at_ms -= 50 * 3600 * 1000;
        delivery::record_session_run(&config, &key, Some(&run)).unwrap();
        fake.state
            .lock()
            .unwrap()
            .started
            .insert(key.clone(), now_ms() - 50 * 3600 * 1000);
        fake.state.lock().unwrap().uptime_ms = 60 * 3600 * 1000;
        let second = route("del_2", "m-2", "alice", "alice@node-1");
        let two = text("m-2", "two");
        let busy = matches!(
            send(&config, "main", "ws", &second, &two),
            InjectOutcome::Waiting(_)
        );
        // Unset, 50 hours is past 48: over. No cap: still running.
        assert_eq!(busy, !agents.is_empty(), "{agents:?}");
        if busy {
            // Its answer reaches the history: over.
            fake.finish("del_1");
            assert_eq!(
                send(&config, "main", "ws", &second, &two),
                InjectOutcome::Delivered
            );
        }
    }
    // A restart ends an uncapped run that never answered.
    let fake = FakeGateway::release(release("2026.3.22"));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let file = std::fs::read_to_string(&config.config_path).unwrap();
    std::fs::write(
        &config.config_path,
        file.replace(
            "{ gateway:",
            "{ agents: { defaults: { timeoutSeconds: 0 } }, gateway:",
        ),
    )
    .unwrap();
    fake.hold();
    let first = route("del_1", "m-1", "alice", "alice@node-1");
    let _ = send(&config, "main", "ws", &first, &text("m-1", "slow"));
    let second = route("del_2", "m-2", "alice", "alice@node-1");
    assert!(matches!(
        send(&config, "main", "ws", &second, &text("m-2", "two")),
        InjectOutcome::Waiting(_)
    ));
    // Restarted after the run was sent: the run is gone.
    fake.restart();
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert_eq!(
        send(&config, "main", "ws", &second, &text("m-2", "two")),
        InjectOutcome::Delivered
    );
}
