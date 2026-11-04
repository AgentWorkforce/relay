use super::*;
use std::net::TcpListener;

mod fake;
mod relay_tools;
mod review;
mod versions;
use fake::*;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn no_env(_: &str) -> Option<String> {
    None
}

fn configured(dir: &Path, gateway: Value) -> OpenClawConfig {
    let state = dir.join("state");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(
        state.join("openclaw.json"),
        format!("// written by OpenClaw\n{{ gateway: {gateway}, }}\n"),
    )
    .unwrap();
    let env = BTreeMap::from([(
        "OPENCLAW_STATE_DIR".to_string(),
        state.display().to_string(),
    )]);
    OpenClawConfig::new(&env, dir, &dir.join("app"))
}

#[test]
fn title_history_root_matches_importer_default_and_custom_namespaces() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let app = dir.path().join("app");
    let default_root = home.join(".openclaw");
    let default_config = OpenClawConfig::new(&BTreeMap::new(), &home, &app);
    assert_eq!(
        default_config.title_history_root(&home),
        Some((default_root.clone(), false))
    );

    // An explicit default path still uses the importer's custom-root namespace.
    // Root bytes must come from the database ancestor, without a trailing slash.
    for root in [default_root, dir.path().join("custom-state")] {
        for value in [root.display().to_string(), format!("{}/", root.display())] {
            let env = BTreeMap::from([("OPENCLAW_STATE_DIR".to_string(), value)]);
            let config = OpenClawConfig::new(&env, &home, &app);
            let database = root.join("agents/main/agent/openclaw-agent.sqlite");
            let importer_root = database.ancestors().nth(4).unwrap().to_path_buf();
            let (actual_root, custom_namespace) = config.title_history_root(&home).unwrap();
            // Compare raw bytes: Path equality itself ignores trailing separators.
            assert_eq!(actual_root.as_os_str(), importer_root.as_os_str());
            assert!(custom_namespace);
        }
    }
}

#[test]
fn agent_ids_are_openclaw_normalized_ids() {
    assert!(is_agent_id("main"));
    assert!(is_agent_id("work-2_b"));
    assert!(!is_agent_id(""));
    assert!(!is_agent_id("Main"));
    assert!(!is_agent_id("-main"));
    assert!(!is_agent_id("a/b"));
    assert!(!is_agent_id(&"a".repeat(65)));
}

#[test]
fn the_gateway_is_read_from_json5_config() {
    let read = gateway_from(
        &json!({ "port": 19001, "auth": { "mode": "token", "token": "t-1" } }),
        &no_env,
    )
    .unwrap();
    assert_eq!(read.port, 19001);
    assert_eq!(read.secret, Some(Secret::Token("t-1".into())));

    // Defaults: port 18789, token mode, no token.
    let read = gateway_from(&Value::Null, &no_env).unwrap();
    assert_eq!(
        read,
        Gateway {
            port: DEFAULT_PORT,
            secret: None
        }
    );

    // `${VAR}` and the CLI's env override.
    let env = |key: &str| match key {
        "MY_TOKEN" => Some("from-var".to_string()),
        "OPENCLAW_GATEWAY_PASSWORD" => Some("pw".to_string()),
        _ => None,
    };
    let read = gateway_from(&json!({ "auth": { "token": "${MY_TOKEN}" } }), &env).unwrap();
    assert_eq!(read.secret, Some(Secret::Token("from-var".into())));
    let read = gateway_from(&json!({ "auth": { "mode": "password" } }), &env).unwrap();
    assert_eq!(read.secret, Some(Secret::Password("pw".into())));
    let read = gateway_from(
        &json!({ "auth": { "mode": "none", "token": "ignored" } }),
        &env,
    )
    .unwrap();
    assert_eq!(read.secret, None);

    assert_eq!(
        gateway_from(&json!({ "mode": "remote" }), &no_env),
        Err(Unavailable::RemoteGateway)
    );
    assert_eq!(
        gateway_from(
            &json!({ "auth": { "token": { "source": "keychain" } } }),
            &no_env
        ),
        Err(Unavailable::UnsupportedSecret)
    );

    let dir = tempfile::tempdir().unwrap();
    let config = configured(
        dir.path(),
        json!({ "port": 19002, "auth": { "token": "abc" } }),
    );
    assert_eq!(gateway(&config).unwrap().port, 19002);
    let missing = OpenClawConfig::new(&BTreeMap::new(), &dir.path().join("nobody"), dir.path());
    assert_eq!(gateway(&missing), Err(Unavailable::NotInstalled));
}

#[test]
fn the_device_payload_is_openclaws_v3_layout() {
    let payload = device_payload("dev", 1737264000000, "tok", "n-1");
    assert_eq!(
        payload,
        format!("v3|dev|cli|cli|operator|operator.read,operator.write,operator.admin|1737264000000|tok|n-1|{}|", platform())
    );
}

#[test]
fn the_device_key_is_created_once_and_kept_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("openclaw/device.json");
    let first = Device::load_or_create(&path).unwrap();
    let second = Device::load_or_create(&path).unwrap();
    assert_eq!(first.id(), second.id());
    assert_eq!(first.id().len(), 64);
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

fn dm<'a>(sender: &'a str, address: &'a str) -> DeliveryRoute<'a> {
    DeliveryRoute {
        delivery_id: "del_1",
        message_id: "m-1",
        reason: Some("dm"),
        channel_id: Some("dm_abc"),
        sender: Some(sender),
        sender_id: None,
        sender_address: Some(address),
        native: false,
    }
}

#[test]
fn every_sender_gets_a_session_of_its_own() {
    let alice = session_key("main", "ws", &dm("Alice Agent", "alice@node-1"));
    let bob = session_key("main", "ws", &dm("bob", "bob@node-2"));
    assert!(
        alice.starts_with("agent:main:relay:dm:alice-node-1-"),
        "{alice}"
    );
    assert_ne!(alice, bob);
    assert_ne!(alice, "agent:main:main");
    // A rename keeps the whole key: it is built from the address alone.
    assert_eq!(
        alice,
        session_key("main", "ws", &dm("alice", "alice@node-1"))
    );
    // Another relay registration is another session.
    assert_ne!(
        alice,
        session_key("main", "other", &dm("Alice Agent", "alice@node-1"))
    );
    // A channel post goes to the channel's session.
    let post = |channel: &'static str| DeliveryRoute {
        reason: Some("mention"),
        channel_id: Some(channel),
        ..dm("alice", "alice@node-1")
    };
    let general = session_key("main", "ws", &post("General Chat"));
    assert!(
        general.starts_with("agent:main:relay:channel:general-chat-"),
        "{general}"
    );
    // Channel ids that read alike, or the same channel of another
    // registration, never share a session.
    assert_ne!(general, session_key("main", "ws", &post("general/chat")));
    assert_ne!(general, session_key("main", "other", &post("General Chat")));
    // A sender whose address names a channel is still not that channel.
    assert_ne!(general, session_key("main", "ws", &dm("x", "General Chat")));
}

fn against(fake: &FakeGateway, dir: &Path) -> OpenClawConfig {
    configured(
        dir,
        json!({ "port": fake.port, "auth": { "mode": "token", "token": "secret-token" } }),
    )
}

#[test]
fn a_message_goes_to_the_senders_own_session_and_nowhere_else() {
    let fake = FakeGateway::start("secret-token", Behaviour::Answer, json!({ "messages": [] }));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let route = dm("alice", "alice@node-1");
    let outcome = send(
        &config,
        "main",
        "ws",
        &route,
        "[via Agent Relay from @alice] hi",
    );
    assert_eq!(outcome, InjectOutcome::Delivered);

    let frames = fake.methods();
    let methods: Vec<&str> = frames
        .iter()
        .map(|f| f["method"].as_str().unwrap())
        .collect();
    assert_eq!(
        methods,
        [
            "connect",
            "chat.history",
            "sessions.create",
            "sessions.patch",
            "chat.send"
        ]
    );
    let connect = &frames[0]["params"];
    assert_eq!(connect["role"], "operator");
    assert_eq!(connect["client"]["id"], "cli");
    assert_eq!(connect["client"]["mode"], "cli");
    assert!(connect["client"]["version"]
        .as_str()
        .is_some_and(|v| !v.is_empty()));
    assert_eq!(
        connect["scopes"],
        json!(["operator.read", "operator.write", "operator.admin"])
    );
    let key = session_key("main", "ws", &route);
    let create = &frames[2]["params"];
    assert_eq!(create["key"], key.as_str());
    assert_eq!(create["agentId"], "main");
    // A peer can ask, not drive: no command execution, no brain writes.
    assert_eq!(create["permissionMode"], "read-only");
    assert!(create.get("toolOverrides").is_none());
    let patch = &frames[3]["params"];
    assert_eq!(patch["key"], key.as_str());
    // The person's own GBrain is off; only the scoped reader may be used.
    assert_eq!(
        patch["toolOverrides"]["mcpServers"],
        json!({ "gbrain": false })
    );
    let chat = &frames[4]["params"];
    assert_eq!(chat["sessionKey"], key.as_str());
    assert_eq!(chat["idempotencyKey"], "del_1");
    assert_eq!(chat["deliver"], false);
    // A peer's `/status` is text on every line.
    assert_eq!(chat["suppressCommandInterpretation"], true);
    // Followup would answer a busy session's message under another run.
    assert!(chat.get("queueMode").is_none());
    assert_eq!(chat["message"], "[via Agent Relay from @alice] hi");

    // The issued device token is kept with the key, privately.
    let stored: Value =
        serde_json::from_slice(&std::fs::read(config.device_path()).unwrap()).unwrap();
    assert_eq!(stored["device_token"], "issued-token");
    // The session it went to is remembered for the answer.
    let sent = remembered(&config, "main", &MessageRef::of("m-1")).unwrap();
    assert_eq!(sent.session_key, key);
    assert_eq!(sent.run_id, "del_1");
}

#[test]
fn a_turn_already_in_the_session_is_never_sent_again() {
    // After a Gateway restart its idempotency is gone; the history is not.
    let history = json!({ "messages": [
        { "role": "user", "content": "hi", "__openclaw": { "idempotencyKey": "DEL_1:user", "runId": "del_1" } }
    ] });
    let fake = FakeGateway::start("secret-token", Behaviour::Answer, history);
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    assert_eq!(
        send(&config, "main", "ws", &dm("alice", "alice@node-1"), "hi"),
        InjectOutcome::Delivered
    );
    let methods: Vec<String> = fake
        .methods()
        .iter()
        .map(|f| f["method"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(methods, ["connect", "chat.history"]);
}

#[test]
fn a_sender_whose_session_is_still_answering_waits() {
    let history = json!({ "messages": [], "sessionInfo": { "hasActiveRun": true } });
    let fake = FakeGateway::start("secret-token", Behaviour::Answer, history);
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    assert!(matches!(
        send(&config, "main", "ws", &dm("alice", "alice@node-1"), "hi"),
        InjectOutcome::Waiting(_)
    ));
    assert!(!fake.methods().iter().any(|f| f["method"] == "chat.send"));
}

#[test]
fn relay_sessions_reach_only_the_scoped_gbrain_reader() {
    let dir = tempfile::tempdir().unwrap();
    let config = configured(dir.path(), json!({}));
    std::fs::write(
        &config.config_path,
        "{ gateway: {}, mcp: { servers: { gbrain_rw: { url: 'http://127.0.0.1:3131/mcp' }, gbrain_relay: { url: 'http://127.0.0.1:3131/mcp' }, agent_relay: { url: 'https://agentrelay.com/cloud/api/v1/mcp/shared-sessions', auth: 'oauth' }, github: {} } } }",
    )
    .unwrap();
    // Agent Relay's MCP could spawn agents or message others as the person.
    assert_eq!(
        owner_servers(&config),
        ["gbrain", "agent_relay", "gbrain_rw"]
    );
    let params = session_params(&config, "k", "main", &dm("a", "a@n"));
    assert_eq!(
        params["toolOverrides"]["mcpServers"],
        json!({ "gbrain": false, "gbrain_rw": false, "agent_relay": false })
    );
    assert_eq!(params["permissionMode"], "read-only");
}

#[test]
fn agent_relays_mcp_is_off_in_relay_sessions_whatever_its_name() {
    let dir = tempfile::tempdir().unwrap();
    let config = configured(dir.path(), json!({}));
    std::fs::write(
        &config.config_path,
        "{ gateway: {}, mcp: { servers: { relay: { url: 'https://staging.agentrelay.com/cloud/api/v1/mcp/shared-sessions/', auth: 'oauth' }, docs: { url: 'https://docs.example/mcp' } } } }",
    )
    .unwrap();
    assert_eq!(owner_servers(&config), ["gbrain", "relay"]);
}

#[test]
fn a_send_without_a_response_is_settled_by_sending_the_same_key_again() {
    let fake = FakeGateway::start("secret-token", Behaviour::DropAfterSend, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let outcome = send(&config, "main", "ws", &dm("alice", "alice@node-1"), "hi");
    assert!(
        matches!(
            outcome,
            InjectOutcome::Accepted(_) | InjectOutcome::Retry(_)
        ),
        "{outcome:?}"
    );
}

#[test]
fn a_wrong_token_or_a_stopped_gateway_leaves_the_message_waiting() {
    let fake = FakeGateway::start("another-token", Behaviour::Answer, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    assert!(matches!(
        send(&config, "main", "ws", &dm("a", "a@n"), "hi"),
        InjectOutcome::Waiting(_)
    ));

    let starting = FakeGateway::start("secret-token", Behaviour::Starting, Value::Null);
    let config = against(&starting, dir.path());
    assert!(matches!(
        send(&config, "main", "ws", &dm("a", "a@n"), "hi"),
        InjectOutcome::Waiting(_)
    ));

    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let config = configured(
        dir.path(),
        json!({ "port": port, "auth": { "token": "secret-token" } }),
    );
    assert_eq!(
        send(&config, "main", "ws", &dm("a", "a@n"), "hi"),
        InjectOutcome::Waiting(Unavailable::NotRunning.reason())
    );
}

#[test]
fn the_gateways_agents_are_listed_by_name() {
    let fake = FakeGateway::start("secret-token", Behaviour::Answer, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let rows = discover(&config);
    let listed: Vec<(String, String)> = rows
        .iter()
        .map(|r| (r.target.id.clone(), r.title.clone()))
        .collect();
    assert_eq!(
        listed,
        [
            ("main".to_string(), "OpenClaw · Robin".to_string()),
            ("work".to_string(), "OpenClaw · work".to_string())
        ]
    );
    assert!(rows
        .iter()
        .all(|r| r.target.kind == SessionKind::OpenClaw && r.live));
}

fn terminal(run: &str, text: Value) -> Value {
    json!({ "role": "assistant", "content": text, "__openclaw": { "runId": run, "runTerminal": true, "id": format!("ev-{run}") } })
}

fn turn(answer: Value) -> Value {
    json!({ "messages": [
        { "role": "user", "content": "earlier", "__openclaw": { "runId": "del_0", "id": "ev-0" } },
        terminal("del_0", json!("earlier answer")),
        { "role": "user", "content": "hi", "__openclaw": { "runId": "del_1", "id": "ev-u" } },
        { "role": "assistant", "content": [{ "type": "text", "text": "working on it" }], "__openclaw": { "runId": "del_1" } },
        terminal("DEL_1", answer),
        { "role": "user", "content": "next", "__openclaw": { "runId": "del_2" } },
        terminal("del_2", json!("not this one"))
    ] })
}

#[test]
fn the_answer_is_the_runs_terminal_assistant_text() {
    let done = turn(json!([{ "type": "text", "text": "Here you go." }]));
    assert_eq!(answer_in(&done, "del_1").as_deref(), Some("Here you go."));
    // Still running: no terminal entry yet.
    let running = json!({ "messages": [
        { "role": "assistant", "content": "working on it", "__openclaw": { "runId": "del_1" } }
    ] });
    assert_eq!(answer_in(&running, "del_1"), None);
    // Choosing not to answer sends nothing back.
    assert_eq!(answer_in(&turn(json!("NO_REPLY")), "del_1"), None);
    assert_eq!(answer_in(&done, "del_9"), None);
}

#[test]
fn the_answer_is_read_from_the_session_the_message_went_to() {
    let fake = FakeGateway::start("secret-token", Behaviour::Answer, turn(json!("Done.")));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    // A fresh delivery, so the history does not already hold it.
    let route = DeliveryRoute {
        delivery_id: "del_1",
        ..dm("alice", "alice@node-1")
    };
    let _ = send(&config, "main", "ws", &route, "hi");
    let _ = fake.methods();
    assert_eq!(
        final_answer(&config, "main", &MessageRef::of("m-1")).as_deref(),
        Some("Done.")
    );
    let frames = fake.methods();
    let history = frames
        .iter()
        .find(|f| f["method"] == "chat.history")
        .unwrap();
    assert_eq!(
        history["params"]["sessionKey"],
        session_key("main", "ws", &route).as_str()
    );
    // A message this core never sent has no answer here.
    assert_eq!(
        final_answer(&config, "main", &MessageRef::of("m-other")),
        None
    );
}

#[test]
fn a_process_under_the_gateway_is_its_one_agent() {
    let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
    assert!(is_gateway_process(&args(&[
        "/opt/homebrew/opt/node/bin/node",
        "--max-old-space-size=8192",
        "/opt/homebrew/lib/node_modules/openclaw/dist/index.js",
        "gateway",
        "--port",
        "18789",
    ])));
    assert!(is_gateway_process(&args(&["openclaw-gateway"])));
    assert!(is_gateway_process(&args(&[
        "/Users/k/.local/bin/openclaw",
        "gateway",
        "run"
    ])));
    // The CLI doing anything else, or another node program, is not.
    assert!(!is_gateway_process(&args(&[
        "/opt/homebrew/bin/openclaw",
        "doctor"
    ])));
    assert!(!is_gateway_process(&args(&[
        "node",
        "/srv/app/index.js",
        "gateway"
    ])));

    let row = |id: &str| DiscoveredSession {
        target: Target::new(SessionKind::OpenClaw, id),
        title: String::new(),
        directory: None,
        updated_at_ms: None,
        host: None,
        live: true,
        holder: None,
    };
    assert_eq!(
        caller_agent(&[row("main")]),
        Some(Target::new(SessionKind::OpenClaw, "main"))
    );
    // Several agents: no guessing which one ran the tool.
    assert_eq!(caller_agent(&[row("main"), row("work")]), None);
    assert_eq!(caller_agent(&[]), None);
}

#[test]
fn a_trusted_sender_reaches_the_main_session_unlimited() {
    let fake = FakeGateway::start("secret-token", Behaviour::Answer, json!({ "messages": [] }));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    let route = dm("ada-lovelace", "ada-lovelace@sf-mini");
    assert_eq!(
        send(&config, "main", "ws", &route, "remember ABC 667"),
        InjectOutcome::Delivered
    );
    let frames = fake.methods();
    let methods: Vec<&str> = frames
        .iter()
        .map(|f| f["method"].as_str().unwrap())
        .collect();
    // The person's main session is never limited by the relay.
    assert_eq!(methods, ["connect", "chat.history", "chat.send"]);
    assert_eq!(frames[2]["params"]["sessionKey"], "agent:main:main");
    assert_eq!(frames[2]["params"]["deliver"], false);
    assert_eq!(
        remembered(&config, "main", &MessageRef::of("m-1"))
            .unwrap()
            .session_key,
        "agent:main:main"
    );
    // Anyone else still gets a read-only session of their own.
    let stranger = DeliveryRoute {
        delivery_id: "del_2",
        message_id: "m-2",
        ..dm("alice", "alice@node-1")
    };
    assert_eq!(
        send(&config, "main", "ws", &stranger, "hi"),
        InjectOutcome::Delivered
    );
    let frames = fake.methods();
    assert!(frames
        .iter()
        .any(|f| f["method"] == "sessions.create" && f["params"]["permissionMode"] == "read-only"));
}

#[test]
fn a_workspace_member_reaches_the_main_session_but_their_agents_do_not() {
    let fake = FakeGateway::start("secret-token", Behaviour::Answer, json!({ "messages": [] }));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let grace = crate::relay::trusted::WorkspaceMember {
        name: "grace-hopper".into(),
        display_name: None,
        id: "agent_grace".into(),
    };
    crate::relay::trusted::tests::with_members(
        &config.trusted,
        vec![grace],
        crate::relay::state::now_ms(),
    );
    // Grace's person identity, matched by the id Relaycast stamped.
    let member = DeliveryRoute {
        sender_id: Some("agent_grace"),
        ..dm("grace-hopper", "grace-hopper@direct")
    };
    assert_eq!(
        send(&config, "main", "ws", &member, "hi"),
        InjectOutcome::Delivered
    );
    assert_eq!(
        remembered(&config, "main", &MessageRef::of("m-1"))
            .unwrap()
            .session_key,
        "agent:main:main"
    );
    // Grace's agent, and a name registered again under another id, get a
    // read-only session of their own.
    for (sender, id, message) in [
        ("grace-codex", "agent_wc", "m-2"),
        ("grace-hopper", "agent_new", "m-3"),
    ] {
        let route = DeliveryRoute {
            delivery_id: message,
            message_id: message,
            sender_id: Some(id),
            ..dm(sender, "")
        };
        assert_eq!(
            send(&config, "main", "ws", &route, "hi"),
            InjectOutcome::Delivered
        );
        assert_ne!(
            remembered(&config, "main", &MessageRef::of(message))
                .unwrap()
                .session_key,
            "agent:main:main"
        );
    }
}

#[test]
fn a_retry_keeps_the_session_its_first_attempt_chose() {
    // The first attempt reaches the Gateway but loses chat.send's response:
    // its destination is recorded, the message may have arrived.
    let dropping = FakeGateway::start(
        "secret-token",
        Behaviour::DropAfterSend,
        json!({ "messages": [] }),
    );
    let dir = tempfile::tempdir().unwrap();
    let config = against(&dropping, dir.path());
    config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    let route = dm("ada-lovelace", "ada-lovelace@sf-mini");
    let first = send(&config, "main", "ws", &route, "hi");
    assert!(
        matches!(first, InjectOutcome::Accepted(_) | InjectOutcome::Retry(_)),
        "{first:?}"
    );
    // No longer trusted, the retry still goes to the session first chosen.
    config.trusted.set(&json!([])).unwrap();
    let fake = FakeGateway::start("secret-token", Behaviour::Answer, json!({ "messages": [] }));
    let config = against(&fake, dir.path());
    assert_eq!(
        send(&config, "main", "ws", &route, "hi"),
        InjectOutcome::Delivered
    );
    let frames = fake.methods();
    let chat = frames.iter().find(|f| f["method"] == "chat.send").unwrap();
    assert_eq!(chat["params"]["sessionKey"], "agent:main:main");
    assert!(!frames.iter().any(|f| f["method"] == "sessions.create"));
}
