use super::*;
use agent_relay_probe::relay::delivery::policy::MessageRef;

async fn start_pi() -> Harness {
    start_pi_with(|_, _, _| {}).await
}

async fn start_pi_with(prepare: impl FnOnce(&Path, &FakeRelaycast, &str)) -> Harness {
    let h = Harness::start_with_fake(
        |_| None,
        |home, fake| {
            let agent = fake.seed_agent("pi-api", "agent", json!({}));
            let data = home.join("app-data");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::write(
                data.join("injectable-agents.json"),
                json!({
                    "registrations":[{"name":"pi-api","agentID":agent.id,
                        "target":{"kind":"pi","id":CODEX},"title":"Pi",
                        "baseURL":fake.base_url,"registeredAt":1790853200.0,
                        "workspaceKey":WORKSPACE_KEY,"machinePrefix":"test-desk",
                        "routeBinding":"pi:12:34:123456789012345678901234567890ab"}],
                    "tokens":{"pi-api":agent.token}
                })
                .to_string(),
            )
            .unwrap();
            fake.seed_agent("alice", "agent", json!({}));
            fake.seed_channel("swarm", &["pi-api", "alice"]);
            prepare(home, fake, &agent.id);
        },
    )
    .await;
    h.sessions
        .0
        .lock()
        .unwrap()
        .push(session(SessionKind::Pi, CODEX, "/Projects/pi"));
    h
}

#[tokio::test]
async fn a_pi_channel_batch_returns_one_answer_to_its_last_post() {
    let h = start_pi().await;
    let release = h.fake.hold("GET /v1/deliveries");
    let parked = h.fake.held("GET /v1/deliveries");
    h.core.request_drain("pi-api");
    eventually("Pi queue read parked", || {
        h.fake.held("GET /v1/deliveries") > parked
    })
    .await;
    let first = h.fake.queue(
        "pi-api",
        "message",
        Some("ch_swarm"),
        "alice",
        "Make the changes.",
    );
    let last = h.fake.queue(
        "pi-api",
        "message",
        Some("ch_swarm"),
        "alice",
        "Review the changes.",
    );
    release.send(true).unwrap();
    eventually("Pi batch acknowledged", || {
        [first.0.as_str(), last.0.as_str()]
            .iter()
            .all(|id| delivered(&h.fake, id).as_deref() == Some("acked"))
    })
    .await;
    let injected = h.injector.injected();
    assert_eq!(injected.len(), 1);
    assert_eq!(
        injected[0].message_id, last.1,
        "Pi answer lookup must use the last post's ID, not the batch digest"
    );
    let replies = format!("/v1/messages/{}/replies", last.1);
    assert!(
        h.fake.calls("POST", &replies).is_empty(),
        "no answer before the Pi turn completes"
    );
    h.injector
        .answers
        .lock()
        .unwrap()
        .insert(MessageRef::of(&last.1), "Changes reviewed.".into());
    eventually("Pi final answer returned to channel", || {
        !h.fake.calls("POST", &replies).is_empty()
    })
    .await;
    assert_eq!(
        h.fake.calls("POST", &replies)[0].body["text"],
        "Changes reviewed."
    );
    assert!(h
        .fake
        .calls("POST", &format!("/v1/messages/{}/replies", first.1))
        .is_empty());
    h.core.check_replies().await;
    h.core.check_replies().await;
    assert_eq!(
        h.fake.calls("POST", &replies).len(),
        1,
        "completed batch answers only once"
    );
    h.stop().await;
}

#[tokio::test]
async fn a_pi_batch_keeps_its_reply_key_and_target_when_the_last_post_leaves_the_queue() {
    let h = start_pi().await;
    h.injector
        .then(InjectOutcome::Accepted("Pi is busy".into()));
    h.injector.hold.store(true, Ordering::SeqCst);
    let release = h.fake.hold("GET /v1/deliveries");
    let parked = h.fake.held("GET /v1/deliveries");
    h.core.request_drain("pi-api");
    eventually("Pi queue read parked", || {
        h.fake.held("GET /v1/deliveries") > parked
    })
    .await;
    let first = h
        .fake
        .queue("pi-api", "message", Some("ch_swarm"), "alice", "first");
    let last = h
        .fake
        .queue("pi-api", "message", Some("ch_swarm"), "alice", "last");
    release.send(true).unwrap();
    eventually("Pi holds the original batch", || {
        h.injector.holding.load(Ordering::SeqCst)
    })
    .await;
    h.fake.set_delivery_state(&last.0, "delivered");
    h.injector.hold.store(false, Ordering::SeqCst);
    eventually("remaining post acknowledged", || {
        delivered(&h.fake, &first.0).as_deref() == Some("acked")
    })
    .await;
    let calls = h.injector.injected();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].message_id, last.1);
    assert_eq!(
        calls[1].message_id, calls[0].message_id,
        "retry must keep the original Pi receipt key"
    );
    assert_eq!(calls[1].text, calls[0].text);
    h.injector
        .answers
        .lock()
        .unwrap()
        .insert(MessageRef::of(&last.1), "One final answer.".into());
    let replies = format!("/v1/messages/{}/replies", last.1);
    eventually("answer to original last post", || {
        h.fake.calls("POST", &replies).len() == 1
    })
    .await;
    h.fake.set_delivery_state(&last.0, "queued");
    h.core.request_drain("pi-api");
    eventually("returned post settled without another prompt", || {
        delivered(&h.fake, &last.0).as_deref() == Some("acked")
    })
    .await;
    assert_eq!(h.injector.injected().len(), 2);
    h.core.check_replies().await;
    assert_eq!(h.fake.calls("POST", &replies).len(), 1);
    h.stop().await;
}

#[tokio::test]
async fn a_legacy_pi_channel_pin_retries_under_its_original_batch_key() {
    let h = start_pi_with(|home, fake, agent_id| {
        let first = fake.queue("pi-api", "message", Some("ch_swarm"), "alice", "first");
        let last = fake.queue("pi-api", "message", Some("ch_swarm"), "alice", "last");
        std::fs::write(
            home.join("app-data/channel-injections.json"),
            json!([{
                "agent_id":agent_id, "delivery_id":"legacy-delivery", "key":"chb-legacy-pi",
                "members":[first.0,last.0],"text":"Original pre-upgrade Pi prompt", "routes":[]
            }])
            .to_string(),
        )
        .unwrap();
    })
    .await;
    eventually("legacy Pi batch delivered", || {
        !h.injector.injected().is_empty()
    })
    .await;
    assert_eq!(
        h.injector.injected()[0].message_id,
        "chb-legacy-pi",
        "a pre-upgrade Pi batch must not acquire a new receipt key on restart"
    );
    assert_eq!(
        h.injector.injected()[0].text,
        "Original pre-upgrade Pi prompt"
    );
    h.stop().await;
}
