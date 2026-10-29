use super::*;

/// A spawner whose agent is alive and takes no native input: every message
/// goes through the peer injector.
struct LiveSpawner;

impl agent_relay_probe::relay::spawn::launch::Spawner for LiveSpawner {
    fn available(&self) -> Vec<agent_relay_probe::relay::harness::HarnessId> {
        vec![]
    }
    fn launch(
        &self,
        _: &agent_relay_probe::relay::spawn::launch::Launch,
        _: agent_relay_probe::relay::spawn::launch::Started,
    ) -> Result<
        agent_relay_probe::relay::spawn::launch::Launched,
        agent_relay_probe::relay::spawn::launch::LaunchError,
    > {
        panic!("no real agent is launched")
    }
    fn alive(
        &self,
        _: &Target,
        _: Option<&agent_relay_probe::relay::spawn::launch::SpawnedProcess>,
    ) -> bool {
        true
    }
    fn stop(
        &self,
        _: &Target,
        _: Option<&agent_relay_probe::relay::spawn::launch::SpawnedProcess>,
    ) {
    }
}

/// A spawned Codex told how to reply that ends a turn without replying:
/// its answer to each DM from the agent that spawned it reaches that agent,
/// as its first message promised; a peer's DM gets no automatic answer, and
/// a reply the session sends itself is never doubled.
#[tokio::test]
async fn every_requester_turn_is_answered_when_the_spawned_session_sends_nothing() {
    let h = spawned_child().await;
    let mut client = h.client().await;
    assert_eq!(
        client.ok("settings.get", json!({})).await["spawn_native_input"],
        false
    );
    // The session is shown how to reply, which alone would turn the
    // automatic answer off.
    *h.injector.hint.lock().unwrap() = Some("[reply: curl relay]".into());
    let answer = |message: &str, text: &str| {
        let reference = agent_relay_probe::relay::delivery::policy::MessageRef::of(message);
        h.injector
            .answers
            .lock()
            .unwrap()
            .insert(reference, text.into());
    };

    for (n, follow_up) in ["first follow-up", "second follow-up"]
        .into_iter()
        .enumerate()
    {
        let (delivery, message) = h.fake.send_dm("parent", "child", follow_up);
        h.fake.clear_delivery_channel(&delivery);
        eventually("requester DM acked", || {
            delivered(&h.fake, &delivery).as_deref() == Some("acked")
        })
        .await;
        answer(&message, &format!("answer {n}"));
        let replies = format!("/v1/messages/{message}/replies");
        eventually("requester answered", || {
            !h.fake.calls("POST", &replies).is_empty()
        })
        .await;
        assert_eq!(
            h.fake.calls("POST", &replies)[0].body["text"],
            format!("answer {n}")
        );
    }

    let (delivery, message) = h.fake.send_dm("peer", "child", "a peer asks");
    h.fake.clear_delivery_channel(&delivery);
    eventually("peer DM acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    answer(&message, "not for the peer");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        h.fake
            .calls("POST", &format!("/v1/messages/{message}/replies"))
            .is_empty(),
        "a peer that was shown how to reply gets no automatic answer"
    );

    let (delivery, message) = h.fake.send_dm("parent", "child", "answered by hand");
    h.fake.clear_delivery_channel(&delivery);
    eventually("third requester DM acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    h.core
        .claim_socket_reply(
            "child",
            &agent_relay_probe::relay::links::Endpoint::Name("parent".into()),
            Some(&message),
        )
        .unwrap();
    answer(&message, "would be a second answer");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        h.fake
            .calls("POST", &format!("/v1/messages/{message}/replies"))
            .is_empty(),
        "a reply the session sent itself is not doubled"
    );
    h.stop().await;
}

/// A spawned Codex whose requester is @parent, with native input off.
async fn spawned_child() -> Harness {
    Harness::start_with_plugins(|_| None, |home, fake| {
        let child = fake.seed_agent("child", "agent", json!({}));
        let parent = fake.seed_agent("parent", "agent", json!({}));
        fake.seed_agent("peer", "agent", json!({}));
        let data = home.join("app-data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("injectable-agents.json"), json!({
            "registrations":[{
                "name":child.name, "agentID":child.id, "target":{"kind":"codex","id":CODEX},
                "title":"Spawned worker", "baseURL":fake.base_url, "registeredAt":"2026-10-01T00:00:00Z",
                "workspaceKey":WORKSPACE_KEY, "machinePrefix":"test-desk",
                "spawn":{"nodeID":"node", "nodeName":"test-desk-desktop", "invocationID":"spawn-child", "harness":"codex", "requester":{"name":parent.name,"agentID":parent.id}}
            }], "tokens":{"child":child.token}, "autoActivate":false, "spawnNativeInput":false
        }).to_string()).unwrap();
    }, DeliveryTiming { safety_poll: Duration::from_millis(150), fast_poll: Duration::from_millis(100), retry_unit: Duration::from_millis(20), ..DeliveryTiming::default() }, None, Some(Arc::new(LiveSpawner))).await
}

/// A plain socket DM to the requester sent while the prompt is still being
/// handed over claims that turn's automatic answer, which is queued before
/// injection; the requester gets one answer, not two.
#[tokio::test]
async fn a_socket_dm_sent_during_injection_claims_the_requesters_answer() {
    let h = spawned_child().await;
    let mut client = h.client().await;
    client.ok("settings.get", json!({})).await;
    *h.injector.hint.lock().unwrap() = Some("[reply: curl relay]".into());
    h.injector
        .hold
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (delivery, message) = h.fake.send_dm("parent", "child", "quick question");
    h.fake.clear_delivery_channel(&delivery);
    eventually("injection held", || {
        h.injector.holding.load(std::sync::atomic::Ordering::SeqCst)
    })
    .await;
    h.core
        .claim_socket_reply(
            "child",
            &agent_relay_probe::relay::links::Endpoint::Name("parent".into()),
            None,
        )
        .unwrap();
    h.injector
        .hold
        .store(false, std::sync::atomic::Ordering::SeqCst);
    eventually("requester DM acked", || {
        delivered(&h.fake, &delivery).as_deref() == Some("acked")
    })
    .await;
    let reference = agent_relay_probe::relay::delivery::policy::MessageRef::of(&message);
    h.injector
        .answers
        .lock()
        .unwrap()
        .insert(reference, "a second answer".into());
    // Pending answers are checked on the delivery loop's slower cadence:
    // without the early claim this one goes out within this wait.
    tokio::time::sleep(Duration::from_millis(8000)).await;
    assert!(
        h.fake
            .calls("POST", &format!("/v1/messages/{message}/replies"))
            .is_empty(),
        "the DM sent during injection already answered this turn"
    );
    h.stop().await;
}
