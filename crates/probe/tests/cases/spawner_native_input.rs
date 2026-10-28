use super::*;

#[derive(Default)]
struct NativeSpawner {
    messages: std::sync::Mutex<Vec<String>>,
    outcome: std::sync::Mutex<Option<InjectOutcome>>,
}

impl agent_relay_probe::relay::spawn::launch::Spawner for NativeSpawner {
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
    fn native_input(&self, _: &Target) -> bool {
        true
    }
    fn deliver(
        &self,
        _: &Target,
        message: &agent_relay_probe::relay::spawn::launch::Message,
    ) -> Option<InjectOutcome> {
        if !message.native {
            return None;
        }
        self.messages.lock().unwrap().push(message.text.into());
        Some(
            self.outcome
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(InjectOutcome::Delivered),
        )
    }
}

#[tokio::test]
async fn native_spawner_input_is_on_by_default_and_other_agents_keep_peer_delivery() {
    let native_spawner = Arc::new(NativeSpawner::default());
    let h = Harness::start_with_plugins(|_| None, |home, fake| {
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
            }], "tokens":{"child":child.token}, "autoActivate":false
        }).to_string()).unwrap();
    }, DeliveryTiming { safety_poll: Duration::from_millis(150), fast_poll: Duration::from_millis(100), retry_unit: Duration::from_millis(20), ..DeliveryTiming::default() }, None, Some(native_spawner.clone())).await;
    let mut client = h.client().await;
    assert_eq!(
        client.ok("settings.get", json!({})).await["spawn_native_input"],
        true
    );
    client
        .ok("settings.set", json!({"spawn_native_input":false}))
        .await;
    let (default_delivery, _) = h.fake.send_dm("parent", "child", "opted-out peer");
    h.fake.clear_delivery_channel(&default_delivery);
    eventually("opted-out peer delivery acked", || {
        delivered(&h.fake, &default_delivery).as_deref() == Some("acked")
    })
    .await;
    assert!(native_spawner.messages.lock().unwrap().is_empty());
    assert!(h.injector.injected()[0]
        .text
        .starts_with("[via Agent Relay"));

    client
        .ok("settings.set", json!({"spawn_native_input":true}))
        .await;
    let png = h.fake.seed_file("shot.png", "image/png", b"image bytes");
    let (native_delivery, message_id) =
        h.fake
            .send_dm_with_files("parent", "child", "native follow-up", &[&png]);
    h.fake.clear_delivery_channel(&native_delivery);
    eventually("native input acked", || {
        delivered(&h.fake, &native_delivery).as_deref() == Some("acked")
    })
    .await;
    let native = native_spawner.messages.lock().unwrap().clone();
    assert_eq!(native.len(), 1);
    assert!(native[0].starts_with("[Agent Relay native input — from @parent"));
    assert!(native[0].contains("native follow-up"));
    assert!(native[0].contains("Attachments:"));
    assert!(native[0].contains("saved to "));
    // Exercise Claude's actual stream-json envelope with the prompt produced
    // by the real delivery loop, including both its UUID and attribution.
    let user =
        agent_relay_probe::relay::harness::claude::channel::user_turn(&native[0], &message_id);
    let answer = json!({"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"Task complete"}]}});
    let transcript = format!("{user}\n{answer}\n");
    assert_eq!(
        agent_relay_probe::relay::delivery::final_answer::claude(
            transcript.as_bytes(),
            &agent_relay_probe::relay::delivery::policy::MessageRef::of(&message_id),
            false,
        )
        .as_deref(),
        Some("Task complete")
    );
    assert_eq!(
        agent_relay_probe::relay::delivery::policy::MessageRef::in_text(&native[0]),
        Some(agent_relay_probe::relay::delivery::policy::MessageRef::of(
            &message_id
        ))
    );
    assert_eq!(
        h.injector.injected().len(),
        1,
        "native input bypasses the peer injector"
    );

    let (peer_delivery, _) = h.fake.send_dm("peer", "child", "still a peer");
    h.fake.clear_delivery_channel(&peer_delivery);
    eventually("other agent acked", || {
        delivered(&h.fake, &peer_delivery).as_deref() == Some("acked")
    })
    .await;
    assert_eq!(native_spawner.messages.lock().unwrap().len(), 1);
    assert_eq!(h.injector.injected().len(), 2);
    client
        .ok("settings.set", json!({"spawn_native_input":false}))
        .await;
    let (off_delivery, _) = h.fake.send_dm("parent", "child", "peer again");
    h.fake.clear_delivery_channel(&off_delivery);
    eventually("disabled native input acked", || {
        delivered(&h.fake, &off_delivery).as_deref() == Some("acked")
    })
    .await;
    assert_eq!(native_spawner.messages.lock().unwrap().len(), 1);
    assert_eq!(h.injector.injected().len(), 3);
    // An uncertain native write must never fall back to peer delivery or resend.
    client
        .ok("settings.set", json!({"spawn_native_input":true}))
        .await;
    *native_spawner.outcome.lock().unwrap() = Some(InjectOutcome::InDoubt("lost receipt".into()));
    let (uncertain, _) = h.fake.send_dm("parent", "child", "do not duplicate");
    h.fake.clear_delivery_channel(&uncertain);
    eventually("uncertain input failed", || {
        delivered(&h.fake, &uncertain).as_deref() == Some("failed")
    })
    .await;
    assert_eq!(native_spawner.messages.lock().unwrap().len(), 2);
    assert_eq!(h.injector.injected().len(), 3);
    h.fake.set_delivery_state(&uncertain, "queued");
    let queued = h.fake.delivery_state(&uncertain).unwrap().item;
    h.core.wake(
        "child".into(),
        Some(json!({
            "type":"deliver", "delivery_id":uncertain, "msg_id":queued["message_id"],
            "payload":{"type":"dm.received", "data":{"message":queued["message"]}}
        })),
    );
    eventually("uncertain redelivery failed without a resend", || {
        delivered(&h.fake, &uncertain).as_deref() == Some("failed")
    })
    .await;
    assert_eq!(native_spawner.messages.lock().unwrap().len(), 2);
    assert_eq!(h.injector.injected().len(), 3);
    h.stop().await;
}
