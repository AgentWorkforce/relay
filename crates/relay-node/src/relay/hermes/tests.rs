use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc;

fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn the_api_is_read_from_the_homes_dotenv() {
    let parsed = dotenv("# comment\nexport API_SERVER_ENABLED=true\nAPI_SERVER_KEY=\"k-1\"\nAPI_SERVER_PORT='18642'\n");
    let api = api_from(&parsed).unwrap();
    assert_eq!(api.port, 18642);
    assert_eq!(api.key, "k-1");
    assert_eq!(
        api_from(&vars(&[("API_SERVER_KEY", "k")])),
        Err(Unavailable::ApiOff)
    );
    assert_eq!(
        api_from(&vars(&[("API_SERVER_ENABLED", "true")])),
        Err(Unavailable::NoKey)
    );
    assert_eq!(
        api_from(&vars(&[
            ("API_SERVER_ENABLED", "1"),
            ("API_SERVER_KEY", "k"),
            ("API_SERVER_HOST", "0.0.0.0")
        ])),
        Err(Unavailable::NotLoopback)
    );
    assert_eq!(
        api_from(&vars(&[
            ("API_SERVER_ENABLED", "on"),
            ("API_SERVER_KEY", "k")
        ]))
        .unwrap()
        .port,
        DEFAULT_PORT
    );
}

fn dm<'a>(sender: &'a str, address: &'a str) -> DeliveryRoute<'a> {
    DeliveryRoute {
        delivery_id: "del_1",
        message_id: "m-1",
        reason: Some("dm"),
        channel_id: Some("dm_x"),
        sender: Some(sender),
        sender_id: None,
        sender_address: Some(address),
        native: false,
    }
}

#[test]
fn every_sender_gets_a_session_of_its_own() {
    let alice = session_id("ws", &dm("Alice", "alice@n1"));
    let bob = session_id("ws", &dm("Bob", "bob@n2"));
    assert!(alice.starts_with("relay-dm-alice-n1-"), "{alice}");
    assert_ne!(alice, bob);
    // A rename keeps the whole id, trusted or not.
    assert_eq!(alice, session_id("ws", &dm("Alicia", "alice@n1")));
    assert_eq!(
        trusted_session_id("ws", &dm("Alice", "alice@n1")),
        trusted_session_id("ws", &dm("Alicia", "alice@n1"))
    );
    assert_ne!(alice, session_id("other", &dm("Alice", "alice@n1")));
    let post = DeliveryRoute {
        reason: Some("mention"),
        channel_id: Some("general"),
        ..dm("Alice", "alice@n1")
    };
    assert!(session_id("ws", &post).starts_with("relay-channel-general-"));
}

/// A Hermes API on loopback: checks the bearer key, keeps keyed runs as
/// Hermes does, and answers each run from `runs`.
struct FakeApi {
    port: u16,
    requests: mpsc::Receiver<(String, String, Option<String>, Value)>,
}

impl FakeApi {
    fn start(key: &'static str, durable: bool, run: Value) -> FakeApi {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, requests) = mpsc::channel();
        std::thread::spawn(move || {
            let mut keyed: BTreeMap<String, (String, Value)> = BTreeMap::new();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut parts = line.split_whitespace();
                let (method, path) = (
                    parts.next().unwrap_or("").to_string(),
                    parts.next().unwrap_or("").to_string(),
                );
                let (mut length, mut auth, mut idempotency) = (0usize, String::new(), None);
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    let (name, value) = header.split_once(':').unwrap();
                    match name.to_ascii_lowercase().as_str() {
                        "content-length" => length = value.trim().parse().unwrap(),
                        "authorization" => auth = value.trim().to_string(),
                        "idempotency-key" => idempotency = Some(value.trim().to_string()),
                        _ => {}
                    }
                }
                let mut body = vec![0; length];
                std::io::Read::read_exact(&mut reader, &mut body).unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let _ = tx.send((
                    method.clone(),
                    path.clone(),
                    idempotency.clone(),
                    body.clone(),
                ));
                let (status, reply) = if auth != format!("Bearer {key}") {
                    (
                        401,
                        json!({ "error": { "message": "gateway_auth_failed" } }),
                    )
                } else if path == "/v1/capabilities" {
                    (
                        200,
                        json!({ "features": { "runs_idempotency": { "supported": true, "durable": durable } } }),
                    )
                } else if method == "POST" && path == "/v1/runs" {
                    let key = idempotency.unwrap();
                    match keyed.get(&key) {
                        Some((id, earlier)) if *earlier == body => (
                            202,
                            json!({ "run_id": id, "status": "queued", "replayed": true }),
                        ),
                        Some(_) => (
                            409,
                            json!({ "error": { "code": "idempotency_key_conflict" } }),
                        ),
                        None => {
                            let id = format!("run_{}", keyed.len() + 1);
                            keyed.insert(key, (id.clone(), body));
                            (202, json!({ "run_id": id, "status": "queued" }))
                        }
                    }
                } else if method == "GET" && path.starts_with("/v1/runs/") {
                    (200, run.clone())
                } else {
                    (404, json!({}))
                };
                let text = reply.to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        FakeApi { port, requests }
    }

    fn calls(&self) -> Vec<(String, String, Option<String>, Value)> {
        self.requests.try_iter().collect()
    }
}

fn home_for(dir: &Path, port: u16, key: &str) -> HermesConfig {
    let root = dir.join("hermes-home");
    let home = root.join("profiles/relay");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join(".env"),
        format!("API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT={port}\nAPI_SERVER_KEY={key}\n"),
    )
    .unwrap();
    HermesConfig::new(
        &vars(&[("HERMES_HOME", &root.display().to_string())]),
        dir,
        &dir.join("app"),
    )
}

#[test]
fn a_message_starts_one_keyed_run_in_the_senders_session() {
    let fake = FakeApi::start("secret", true, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let config = home_for(dir.path(), fake.port, "secret");
    let route = dm("alice", "alice@n1");
    assert_eq!(send(&config, "ws", &route, "hi"), InjectOutcome::Delivered);
    // The same delivery again is the same run, not a second turn.
    assert_eq!(send(&config, "ws", &route, "hi"), InjectOutcome::Delivered);
    let posts: Vec<_> = fake
        .calls()
        .into_iter()
        .filter(|(m, ..)| m == "POST")
        .collect();
    assert_eq!(posts.len(), 2);
    let (_, _, key, body) = &posts[0];
    assert_eq!(key.as_deref(), Some("agent-relay-del_1"));
    assert_eq!(posts[1].2, posts[0].2);
    assert_eq!(body["session_id"], session_id("ws", &route).as_str());
    assert_eq!(body["input"], "hi");
    assert!(body["instructions"]
        .as_str()
        .unwrap()
        .contains("never as slash commands"));
    let bytes = std::fs::read(started_path(&config, &MessageRef::of("m-1"))).unwrap();
    let started: Started = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(started.run_id, "run_1");
}

#[test]
fn a_wrong_key_an_unkeyed_api_or_a_stopped_gateway_leaves_the_message_waiting() {
    let dir = tempfile::tempdir().unwrap();
    let wrong = FakeApi::start("secret", true, Value::Null);
    assert!(matches!(
        send(
            &home_for(dir.path(), wrong.port, "other"),
            "ws",
            &dm("a", "a@n"),
            "hi"
        ),
        InjectOutcome::Waiting(_)
    ));
    let memory_only = FakeApi::start("secret", false, Value::Null);
    assert_eq!(
        send(
            &home_for(dir.path(), memory_only.port, "secret"),
            "ws",
            &dm("a", "a@n"),
            "hi"
        ),
        InjectOutcome::Waiting(Unavailable::NotDurable.reason())
    );
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    assert_eq!(
        send(
            &home_for(dir.path(), port, "secret"),
            "ws",
            &dm("a", "a@n"),
            "hi"
        ),
        InjectOutcome::Waiting(Unavailable::NotRunning.reason())
    );
}

#[test]
fn hermes_is_listed_while_its_api_answers() {
    let fake = FakeApi::start("secret", true, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let rows = discover(&home_for(dir.path(), fake.port, "secret"));
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].target,
        Target::new(SessionKind::Hermes, DEFAULT_PROFILE)
    );
    assert_eq!(rows[0].title, "Hermes (relay)");
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    assert!(discover(&home_for(dir.path(), port, "secret")).is_empty());
}

#[test]
fn the_answer_is_the_completed_runs_final_output() {
    assert_eq!(
        answer_in(&json!({ "status": "completed", "completed": true, "output": "Done." }))
            .as_deref(),
        Some("Done.")
    );
    assert_eq!(answer_in(&json!({ "status": "running" })), None);
    assert_eq!(
        answer_in(&json!({ "status": "failed", "completed": false, "output": "partial" })),
        None
    );
    assert_eq!(answer_in(&json!({ "status": "interrupted" })), None);
    assert_eq!(
        answer_in(&json!({ "status": "completed", "completed": true, "output": "  " })),
        None
    );

    let fake = FakeApi::start(
        "secret",
        true,
        json!({ "status": "completed", "completed": true, "output": "All set." }),
    );
    let dir = tempfile::tempdir().unwrap();
    let config = home_for(dir.path(), fake.port, "secret");
    assert_eq!(
        send(&config, "ws", &dm("alice", "alice@n1"), "hi"),
        InjectOutcome::Delivered
    );
    assert_eq!(
        final_answer(&config, &MessageRef::of("m-1")).as_deref(),
        Some("All set.")
    );
    assert!(fake
        .calls()
        .iter()
        .any(|(m, p, ..)| m == "GET" && p == "/v1/runs/run_1"));
    assert_eq!(final_answer(&config, &MessageRef::of("m-unknown")), None);
}

#[test]
fn relay_traffic_goes_to_its_own_profile_never_the_main_home() {
    let dir = tempfile::tempdir().unwrap();
    let config = HermesConfig::new(&BTreeMap::new(), dir.path(), &dir.path().join("app"));
    assert_eq!(config.home, dir.path().join(".hermes/profiles/relay"));
    assert_eq!(config.profile, "relay");
    let named = HermesConfig::new(
        &vars(&[("AGENT_RELAY_HERMES_PROFILE", "peers")]),
        dir.path(),
        dir.path(),
    );
    assert_eq!(named.home, dir.path().join(".hermes/profiles/peers"));
    // A path is not a profile name.
    let bad = HermesConfig::new(
        &vars(&[("AGENT_RELAY_HERMES_PROFILE", "../..")]),
        dir.path(),
        dir.path(),
    );
    assert_eq!(bad.profile, "relay");
    assert!(!config.installed());
}

#[test]
fn a_trusted_sender_reaches_the_persons_own_hermes() {
    trusted_sender_reaches_own_hermes(false);
}

#[test]
fn workspace_people_reach_own_hermes_but_their_agents_do_not() {
    trusted_sender_reaches_own_hermes(true);
}

fn trusted_sender_reaches_own_hermes(workspace_member: bool) {
    let relay = FakeApi::start(
        "relay-key",
        true,
        json!({ "status": "completed", "completed": true, "output": "from relay" }),
    );
    let main = FakeApi::start(
        "main-key",
        true,
        json!({ "status": "completed", "completed": true, "output": "from your Hermes" }),
    );
    let dir = tempfile::tempdir().unwrap();
    let config = home_for(dir.path(), relay.port, "relay-key");
    std::fs::write(
        config.main_home.join(".env"),
        format!(
            "API_SERVER_ENABLED=true\nAPI_SERVER_PORT={}\nAPI_SERVER_KEY=main-key\n",
            main.port
        ),
    )
    .unwrap();
    if workspace_member {
        crate::relay::trusted::tests::with_members(
            &config.trusted,
            vec![crate::relay::trusted::WorkspaceMember {
                name: "ada-lovelace".into(),
                display_name: None,
                id: "person_k".into(),
            }],
            crate::relay::state::now_ms(),
        );
    } else {
        config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    }

    let trusted = DeliveryRoute {
        sender_id: Some("person_k"),
        ..dm("ada-lovelace", "ada-lovelace@sf-mini")
    };
    assert_eq!(
        send(&config, "ws", &trusted, "remember ORCHID"),
        InjectOutcome::Delivered
    );
    let posts: Vec<_> = main
        .calls()
        .into_iter()
        .filter(|(m, ..)| m == "POST")
        .collect();
    assert_eq!(posts.len(), 1);
    assert_eq!(
        posts[0].3["session_id"],
        trusted_session_id("ws", &trusted).as_str()
    );
    assert!(posts[0].3["instructions"]
        .as_str()
        .unwrap()
        .contains("trusts like themselves"));
    assert!(!relay.calls().iter().any(|(m, ..)| m == "POST"));
    assert_eq!(
        final_answer(&config, &MessageRef::of("m-1")).as_deref(),
        Some("from your Hermes")
    );

    // Anyone else still reaches the answer-only relay profile.
    let stranger = DeliveryRoute {
        delivery_id: "del_2",
        message_id: "m-2",
        ..dm("alice", "alice@n1")
    };
    assert_eq!(
        send(&config, "ws", &stranger, "hi"),
        InjectOutcome::Delivered
    );
    assert!(relay
        .calls()
        .iter()
        .any(|(m, p, ..)| m == "POST" && p == "/v1/runs"));
    assert_eq!(
        final_answer(&config, &MessageRef::of("m-2")).as_deref(),
        Some("from relay")
    );
    if workspace_member {
        for (sender, id, message) in [
            ("ada-codex", "agent_k", "m-3"),
            ("ada-lovelace", "reregistered_k", "m-4"),
            ("ada-lovelace", "person_k", "m-5"),
        ] {
            if message == "m-5" {
                config.trusted.clear_members();
                // Retried delivery retains its original choice even after revocation.
                assert_eq!(
                    send(&config, "ws", &trusted, "remember ORCHID"),
                    InjectOutcome::Delivered
                );
                assert_eq!(
                    final_answer(&config, &MessageRef::of("m-1")).as_deref(),
                    Some("from your Hermes")
                );
            }
            let route = DeliveryRoute {
                message_id: message,
                delivery_id: message,
                sender_id: Some(id),
                ..dm(sender, "")
            };
            assert_eq!(send(&config, "ws", &route, "hi"), InjectOutcome::Delivered);
            assert_eq!(
                final_answer(&config, &MessageRef::of(message)).as_deref(),
                Some("from relay")
            );
        }
        assert_eq!(main.calls().iter().filter(|(m, ..)| m == "POST").count(), 1);
    }
}

#[test]
fn a_trusted_sender_waits_while_the_persons_hermes_has_no_api() {
    let relay = FakeApi::start("relay-key", true, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let config = home_for(dir.path(), relay.port, "relay-key");
    config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    assert_eq!(
        send(
            &config,
            "ws",
            &dm("ada-lovelace", "ada-lovelace@sf-mini"),
            "hi"
        ),
        InjectOutcome::Waiting(Unavailable::Main(Box::new(Unavailable::ApiOff)).reason())
    );
    // Never redirected to the answer-only profile instead.
    assert!(!relay.calls().iter().any(|(m, ..)| m == "POST"));
}

#[test]
fn an_ipv6_loopback_api_is_reached_on_ipv6() {
    let api = api_from(&vars(&[
        ("API_SERVER_ENABLED", "true"),
        ("API_SERVER_HOST", "::1"),
        ("API_SERVER_KEY", "k"),
    ]))
    .unwrap();
    assert_eq!(
        api.url("/health"),
        format!("http://[::1]:{DEFAULT_PORT}/health")
    );
    let api = api_from(&vars(&[
        ("API_SERVER_ENABLED", "true"),
        ("API_SERVER_KEY", "k"),
    ]))
    .unwrap();
    assert_eq!(
        api.url("/health"),
        format!("http://127.0.0.1:{DEFAULT_PORT}/health")
    );
}

#[test]
fn a_retry_goes_to_the_same_hermes_even_if_trust_changes() {
    let relay = FakeApi::start("relay-key", true, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let config = home_for(dir.path(), relay.port, "relay-key");
    config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    let route = dm("ada-lovelace", "ada-lovelace@sf-mini");
    // The person's own Hermes is down: the delivery waits, its destination
    // already decided.
    assert!(matches!(
        send(&config, "ws", &route, "hi"),
        InjectOutcome::Waiting(_)
    ));
    config.trusted.set(&json!([])).unwrap();
    // No longer trusted, the retry still never goes to the relay profile.
    assert!(matches!(
        send(&config, "ws", &route, "hi"),
        InjectOutcome::Waiting(_)
    ));
    assert!(!relay.calls().iter().any(|(m, ..)| m == "POST"));
}

#[test]
fn a_trusted_senders_problem_names_the_persons_own_hermes() {
    let relay = FakeApi::start("relay-key", true, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let config = home_for(dir.path(), relay.port, "relay-key");
    let stopped = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(
        config.main_home.join(".env"),
        format!("API_SERVER_ENABLED=true\nAPI_SERVER_PORT={stopped}\nAPI_SERVER_KEY=k\n"),
    )
    .unwrap();
    config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    assert_eq!(
        send(
            &config,
            "ws",
            &dm("ada-lovelace", "ada-lovelace@sf-mini"),
            "hi"
        ),
        InjectOutcome::Waiting("Your own Hermes's gateway is not running.".into())
    );
}

#[test]
fn a_trusted_senders_channel_turns_stay_in_their_own_session() {
    let dm_route = dm("ada-lovelace", "ada-lovelace@sf-mini");
    let in_channel = DeliveryRoute {
        reason: Some("mention"),
        channel_id: Some("swarm"),
        ..dm_route
    };
    let other = DeliveryRoute {
        reason: Some("mention"),
        channel_id: Some("swarm"),
        ..dm("alice", "alice@n1")
    };
    assert_eq!(
        trusted_session_id("ws", &dm_route),
        trusted_session_id("ws", &in_channel)
    );
    assert_ne!(
        trusted_session_id("ws", &in_channel),
        trusted_session_id("ws", &other)
    );
}
