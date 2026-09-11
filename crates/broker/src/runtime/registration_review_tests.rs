// Regression cases derived from Finn independent review; use the actual runtime.
fn review_request(
    name: &str,
    reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
) -> crate::listen_api::ListenApiRequest {
    crate::listen_api::ListenApiRequest::Spawn {
        name: name.into(),
        cli: "cat".into(),
        transport: Some("pty".into()),
        model: None,
        args: vec![],
        task: None,
        registration_metadata: Default::default(),
        channels: Some(vec![]),
        cwd: None,
        team: None,
        shadow_of: None,
        shadow_mode: None,
        continue_from: None,
        idle_threshold_secs: None,
        exit_after_task: false,
        skip_relay_prompt: true,
        restart_policy: Box::new(None),
        harness_config: None,
        agent_token: None,
        agent_result_schema: None,
        replay_buffer: crate::replay_buffer::ReplayBuffer::new(16),
        reply,
    }
}
fn review_fixture() -> (tempfile::TempDir, WorkerEventRuntimeFixture) {
    let dir = tempfile::tempdir().unwrap();
    let (tx, _rx) = mpsc::channel(16);
    let workers = WorkerRegistry::new(tx, vec![], dir.path().join("logs"), Instant::now());
    (dir, worker_event_runtime_fixture(workers, HashMap::new()))
}
fn review_success(c: &crate::spawn_registration::SpawnRegistration) -> crate::fleet_wire::Reply {
    crate::fleet_wire::Reply {
        v: FLEET_WIRE_VERSION,
        id: c.request_id(),
        ok: true,
        data: json!({"name":c.name(),"agent_id":"original-id","token":"test-only-original"}),
    }
}
#[tokio::test]
async fn review_cancelled_api_request_must_not_dispatch() {
    let (_dir, mut fixture) = review_fixture();
    let (reply, result) = tokio::sync::oneshot::channel();
    drop(result); // request was already cancelled while queued
    fixture
        .runtime
        .dispatch_api_request(review_request("cancelled", reply))
        .await;
    assert!(fixture.fleet_control_rx.try_recv().is_err());
    assert!(!fixture
        .runtime
        .workers
        .spawn_registrations
        .blocked("cancelled"));
}
#[tokio::test]
async fn review_cancellation_after_success_must_retain_cleanup_eligibility() {
    use httpmock::{Method::GET, MockServer};
    let (_dir, mut fixture) = review_fixture();
    let server = MockServer::start();
    let scope = server.mock(|when, then| {
        when.method(GET).path("/v1/agents/cancel-after-success");
        then.status(200)
            .delay(Duration::from_secs(10))
            .json_body(json!({"ok":true,"data":{"channels":[]}}));
    });
    fixture.runtime.relaycast_http =
        RelaycastHttpClient::new(Some(server.base_url()), "workspace-test", "broker", "codex");
    let (reply, _result) = tokio::sync::oneshot::channel();
    let custody;
    {
        let call = fixture
            .runtime
            .handle_api_request(review_request("cancel-after-success", reply));
        tokio::pin!(call);
        let control = async {
            match fixture.fleet_control_rx.recv().await.unwrap() {
                FleetControlCommand::RegisterFreshAgent { custody, .. } => {
                    assert!(custody.begin_send(
                        "node",
                        "instance",
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
                    ));
                    custody.record_reply(&review_success(&custody));
                    custody
                }
                other => panic!("unexpected {other:?}"),
            }
        };
        custody = tokio::select! { c=control=>c, _=&mut call=>panic!("returned before control") };
        tokio::select! {
            _=&mut call=>panic!("returned while scope verification held"),
            _=async {while scope.hits()==0 {tokio::time::sleep(Duration::from_millis(5)).await;}}=>{}
        }
        // Drop the full API future after its success notification, before admission.
    }
    assert!(!fixture.runtime.workers.has_worker("cancel-after-success"));
    assert!(fixture
        .runtime
        .workers
        .spawn_registrations
        .blocked("cancel-after-success"));
    assert!(custody.needs_cleanup(),"dropped post-success API future leaves Owned, abandoned=false; maintenance never cleans it");
}
#[tokio::test(start_paused = true)]
async fn review_disconnect_must_wake_waiter_promptly() {
    let (_dir, mut fixture) = review_fixture();
    let custody = fixture
        .runtime
        .workers
        .spawn_registrations
        .reserve("disconnect".into(), fixture.runtime.relaycast_http.clone())
        .unwrap();
    let ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    assert!(custody.begin_send("node", "instance", ready.clone()));
    // Exact operation performed by node_control::Readiness::drop on every disconnect.
    ready.store(false, std::sync::atomic::Ordering::Release);
    custody.connection_lost();
    let result = tokio::time::timeout(Duration::from_millis(100), custody.wait()).await;
    assert!(
        result.is_ok(),
        "disconnection does not wake the registration waiter; only its 30-second deadline does"
    );
}
#[tokio::test]
async fn review_conflict_during_cleanup_must_not_retire_quarantine() {
    use httpmock::{Method::POST, MockServer};
    for during_delete in [false, true] {
        let (_dir, mut fixture) = review_fixture();
        let server = MockServer::start();
        let release = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/release");
            then.status(200)
                .delay(Duration::from_millis(150))
                .json_body(json!({"ok":true,"data":{"status":"completed"}}));
        });
        let http =
            RelaycastHttpClient::new(Some(server.base_url()), "workspace-test", "broker", "codex");
        let name: WorkerName = "late-conflict".into();
        let custody = fixture
            .runtime
            .workers
            .spawn_registrations
            .reserve(name.clone(), http.clone())
            .unwrap();
        assert!(custody.begin_send(
            "node",
            "instance",
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
        ));
        custody.record_reply(&review_success(&custody));
        custody.abandon();
        super::identity_cleanup::schedule_identity_cleanup(
            &mut fixture.runtime.workers,
            &fixture.runtime.fleet_control_tx,
            &fixture.runtime.fleet_delivery_book,
            &mut fixture.runtime.fleet_inventory,
            &http,
            &name,
            true,
            None,
        );
        let ack = loop {
            if let FleetControlCommand::DeregisterAgent { reply, .. } =
                fixture.fleet_control_rx.recv().await.unwrap()
            {
                break reply;
            }
        };
        let mut ack = Some(ack);
        if during_delete {
            ack.take().unwrap().send(Ok(())).unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                while release.hits() == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
        }
        let mut conflict = review_success(&custody);
        conflict.data["agent_id"] = json!("conflicting-id");
        custody.record_reply(&conflict);
        assert!(
            custody.cleanup_identity().is_none(),
            "conflict explicitly revokes automatic cleanup authority"
        );
        if let Some(ack) = ack {
            ack.send(Ok(())).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                fixture.runtime.reconcile_identity_cleanups().await;
                if fixture.runtime.workers.identity_cleanups[&name].retry_at > Instant::now() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        release.assert_hits(usize::from(during_delete));
        assert!(fixture.runtime.workers.spawn_registrations.blocked(&name),
       "late conflicting identity was forgotten: cleanup still sent {} guarded release(s) and retired the quarantine",release.hits());
    }
}
#[tokio::test]
async fn review_runtime_must_answer_unrelated_list_after_registration_disconnect() {
    let (_dir, mut fixture) = review_fixture();
    let (api_tx, api_rx) = mpsc::channel(8);
    fixture.runtime.api_rx = api_rx;
    let (reply, _spawn_result) = tokio::sync::oneshot::channel();
    api_tx
        .send(review_request("stalled-registration", reply))
        .await
        .unwrap();
    let actor = tokio::spawn(fixture.runtime.run());
    let custody = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let FleetControlCommand::RegisterFreshAgent { custody, .. } =
                fixture.fleet_control_rx.recv().await.unwrap()
            {
                break custody;
            }
        }
    })
    .await
    .unwrap();
    let ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    assert!(custody.begin_send("node", "instance", ready.clone()));
    ready.store(false, std::sync::atomic::Ordering::Release);
    custody.connection_lost();
    let (reply, list_result) = tokio::sync::oneshot::channel();
    api_tx
        .send(crate::listen_api::ListenApiRequest::List { reply })
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_millis(200), list_result).await;
    actor.abort();
    let _ = actor.await;
    assert!(result.is_ok(),"actual BrokerRuntime event loop cannot answer unrelated List while disconnected registration waits");
}
#[tokio::test]
async fn review_full_command_queue_fails_promptly_without_reservation_leak() {
    let (_dir, mut fixture) = review_fixture();
    let (tx, _rx) = mpsc::channel(1);
    tx.try_send(FleetControlCommand::HeartbeatNow).unwrap();
    let name: WorkerName = "full-queue".into();
    let result = tokio::time::timeout(
        Duration::from_millis(100),
        super::fleet::register_owned_node_agent_token(
            &mut fixture.runtime.workers,
            &fixture.runtime.relaycast_http,
            &tx,
            &mut fixture.runtime.fleet_delivery_book,
            &name,
            &[],
            None,
            None,
            None,
        ),
    )
    .await
    .expect("enqueue must be bounded");
    assert!(result.unwrap_err().contains("fleet_control_unavailable"));
    assert!(!fixture.runtime.workers.spawn_registrations.blocked(&name));
}
#[tokio::test]
async fn review_captured_cleanup_preserves_replacement_cache_and_book() {
    use httpmock::{Method::POST, MockServer};
    use sha2::{Digest, Sha256};
    let (_dir, mut fixture) = review_fixture();
    let server = MockServer::start();
    let original_hash = format!("{:x}", Sha256::digest(b"test-only-original"));
    let release=server.mock(|when,then|{
       when.method(POST).path("/v1/agents/release")
          .json_body_partial(json!({"expected_token_hash":original_hash,"name":"captured-cleanup","delete_agent":true}).to_string());
       then.status(200).json_body(json!({"ok":true,"data":{"status":"completed"}}));
    });
    let http =
        RelaycastHttpClient::new(Some(server.base_url()), "workspace-test", "broker", "codex");
    let name: WorkerName = "captured-cleanup".into();
    let custody = fixture
        .runtime
        .workers
        .spawn_registrations
        .reserve(name.clone(), http.clone())
        .unwrap();
    assert!(custody.begin_send(
        "node",
        "instance",
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
    ));
    custody.record_reply(&review_success(&custody));
    custody.abandon();
    http.seed_agent_token(&name, "test-only-original");
    super::identity_cleanup::schedule_identity_cleanup(
        &mut fixture.runtime.workers,
        &fixture.runtime.fleet_control_tx,
        &fixture.runtime.fleet_delivery_book,
        &mut fixture.runtime.fleet_inventory,
        &http,
        &name,
        true,
        None,
    );
    let ack = loop {
        if let FleetControlCommand::DeregisterAgent { request, reply } =
            fixture.fleet_control_rx.recv().await.unwrap()
        {
            assert_eq!(request.agent_id, "original-id");
            break reply;
        }
    };
    http.seed_agent_token(&name, "test-only-replacement");
    fixture
        .runtime
        .fleet_delivery_book
        .bind_authoritative_identity(name.to_string(), "replacement-id".to_string());
    ack.send(Ok(())).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while fixture
            .runtime
            .workers
            .identity_cleanups
            .contains_key(&name)
        {
            fixture.runtime.reconcile_identity_cleanups().await;
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    release.assert_hits(1);
    assert_eq!(
        http.owned_identity_token_hash(&name).unwrap(),
        format!("{:x}", Sha256::digest(b"test-only-replacement"))
    );
    assert_eq!(
        fixture.runtime.fleet_delivery_book.active_agent_id(&name),
        Some("replacement-id")
    );
}
#[tokio::test]
async fn review_shutdown_retains_unconfirmed_cleanup_durably() {
    let (dir, mut fixture) = review_fixture();
    let name: WorkerName = "shutdown-custody".into();
    let http = RelaycastHttpClient::new(
        Some("http://127.0.0.1:1".into()),
        "workspace-test",
        "broker",
        "codex",
    );
    let custody = fixture
        .runtime
        .workers
        .spawn_registrations
        .reserve(name.clone(), http.clone())
        .unwrap();
    assert!(custody.begin_send(
        "node",
        "instance",
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
    ));
    custody.record_reply(&review_success(&custody));
    custody.abandon();
    super::identity_cleanup::schedule_identity_cleanup(
        &mut fixture.runtime.workers,
        &fixture.runtime.fleet_control_tx,
        &fixture.runtime.fleet_delivery_book,
        &mut fixture.runtime.fleet_inventory,
        &http,
        &name,
        true,
        None,
    );
    fixture.runtime.drain_identity_cleanups_on_shutdown().await;
    let restored = crate::spawn_registration::SpawnRegistrations::load(
        dir.path().join("logs/registration-custody"),
    );
    assert!(restored.blocked(&name));
    assert!(fixture
        .runtime
        .workers
        .identity_cleanups
        .contains_key(&name));
}
#[tokio::test]
async fn review_workspace_control_tokenless_spawn_uses_retained_generation() {
    use httpmock::{
        Method::{GET, POST},
        MockServer,
    };
    let (_dir, mut fixture) = review_fixture();
    let server = MockServer::start();
    let create = server.mock(|when, then| {
        when.method(POST).path("/v1/agents");
        then.status(500);
    });
    let scope = server.mock(|when, then| {
        when.method(GET).path("/v1/agents/workspace-proof");
        then.status(200)
            .json_body(json!({"ok":true,"data":{"channels":[]}}));
    });
    let mut workspace = fixture.runtime.default_workspace.clone();
    workspace.http_client =
        RelaycastHttpClient::new(Some(server.base_url()), "workspace-test", "broker", "codex");
    let name: WorkerName = "workspace-proof".into();
    let value = json!({"channels":[],"harnessConfig":{"runtime":"native","command":"cat","args":[],"sessionId":"workspace-proof-session"}});
    let runtime = &mut fixture.runtime;
    let call = super::relaycast_events::spawn_worker_from_request(
        name.clone(),
        "codex".into(),
        None,
        None,
        None,
        false,
        &value,
        &workspace.workspace_id,
        None,
        &workspace,
        &mut runtime.workers,
        &mut runtime.state,
        &runtime.paths,
        &runtime.telemetry,
        &runtime.sdk_out_tx,
        &mut runtime.dedup,
        &mut runtime.agent_spawn_count,
        &runtime.fleet_control_tx,
        &mut runtime.fleet_delivery_book,
        &mut runtime.fleet_inventory,
        "test-node",
        None,
        Some("workspace-proof-session".into()),
        &runtime.hosted_agent_event_tx,
        &mut runtime.pty_observability,
        None,
    );
    let control = async {
        match fixture.fleet_control_rx.recv().await.unwrap() {
            FleetControlCommand::RegisterFreshAgent { request, custody } => {
                assert_eq!(request.auto_join_general, Some(false));
                assert_eq!(
                    request.session_ref.as_deref(),
                    Some("workspace-proof-session")
                );
                assert_eq!(request.resumable, Some(true));
                assert_eq!(request.id.as_deref(), Some(custody.request_id().as_str()));
                assert!(custody.begin_send(
                    "node",
                    "instance",
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
                ));
                custody.record_reply(&review_success(&custody));
                custody
            }
            other => panic!("unexpected {other:?}"),
        }
    };
    let (result, custody) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(call, control)
    })
    .await
    .unwrap();
    let generation = fixture
        .runtime
        .workers
        .workers
        .get(&name)
        .map(|w| w.generation);
    fixture.runtime.workers.shutdown_all().await.unwrap();
    result.unwrap();
    assert_eq!(generation, Some(custody.generation()));
    assert_eq!(
        fixture.runtime.fleet_delivery_book.active_agent_id(&name),
        Some("original-id")
    );
    assert_eq!(
        fixture.runtime.fleet_inventory[&name].agent_id,
        "original-id"
    );
    create.assert_hits(0);
    scope.assert_hits(1);
}

#[tokio::test]
async fn review_caller_cancellation_is_observed_by_unpolled_command_and_at_admission() {
    use futures_util::StreamExt;
    for before_send in [true, false] {
        let (_dir, mut fixture) = review_fixture();
        let (reply, result) = tokio::sync::oneshot::channel();
        fixture
            .runtime
            .dispatch_api_request(review_request("cancel-boundary", reply))
            .await;
        let FleetControlCommand::RegisterFreshAgent { custody, .. } =
            fixture.fleet_control_rx.recv().await.unwrap()
        else {
            panic!("expected registration")
        };
        if before_send {
            drop(result);
            assert!(!custody.begin_send(
                "node",
                "instance",
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
            ));
            assert!(!fixture
                .runtime
                .workers
                .spawn_registrations
                .blocked("cancel-boundary"));
        } else {
            assert!(custody.begin_send(
                "node",
                "instance",
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
            ));
            custody.record_reply(&review_success(&custody));
            drop(result);
            assert!(
                custody.admit("test-only-original").is_err(),
                "actual admission consults the original caller, including after preparation"
            );
        }
        let prepared = tokio::time::timeout(
            Duration::from_millis(200),
            fixture.runtime.pending_spawns.next(),
        )
        .await
        .unwrap()
        .unwrap();
        fixture.runtime.finish_prepared_spawn(prepared).await;
        assert_eq!(custody.needs_cleanup(), !before_send);
        assert!(!fixture.runtime.workers.has_worker("cancel-boundary"));
    }
}

#[tokio::test]
async fn review_stalled_api_and_fleet_registration_allow_runtime_shutdown() {
    for fleet in [false, true] {
        let (_dir, mut fixture) = review_fixture();
        let (api_tx, api_rx) = mpsc::channel(8);
        fixture.runtime.api_rx = api_rx;
        let (reply, _result) = tokio::sync::oneshot::channel();
        if fleet {
            fixture
                .runtime
                .handle_fleet_action_invoke(crate::fleet_wire::ActionInvoke {
                    v: FLEET_WIRE_VERSION,
                    invocation_id: "stalled-fleet".into(),
                    action: "spawn".into(),
                    input: json!({"name":"stalled", "cli":"codex", "channels":[]}),
                    agent_name: Some("stalled".into()),
                    agent_id: None,
                })
                .await;
        } else {
            fixture
                .runtime
                .dispatch_api_request(review_request("stalled", reply))
                .await;
        }
        let custody = loop {
            if let FleetControlCommand::RegisterFreshAgent { custody, .. } =
                fixture.fleet_control_rx.recv().await.unwrap()
            {
                break custody;
            }
        };
        assert!(custody.begin_send(
            "node",
            "instance",
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true))
        ));
        // Keep registration connected but unanswered: responsiveness cannot
        // depend on the disconnect shortcut or on reaching the 30s deadline.
        let actor = tokio::spawn(fixture.runtime.run());
        let (reply, listed) = tokio::sync::oneshot::channel();
        api_tx
            .send(crate::listen_api::ListenApiRequest::List { reply })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_millis(200), listed)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let (reply, stopped) = tokio::sync::oneshot::channel();
        api_tx
            .send(crate::listen_api::ListenApiRequest::Shutdown { reply })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_millis(200), stopped)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(4), actor)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            !custody.retired(),
            "possibly sent identity stays quarantined on shutdown"
        );
        assert!(custody.admit("test-only-original").is_err());
    }
}

#[tokio::test]
async fn review_full_result_queue_keeps_actual_actor_responsive_and_outcomes_retained() {
    for capacity in [1, 256] {
        for deferred in [false, true] {
            let (_dir, mut fixture) = review_fixture();
            let (commands, mut command_rx) = mpsc::channel(capacity);
            fixture.runtime.fleet_control_tx = commands.clone();
            let (api_tx, api_rx) = mpsc::channel(8); fixture.runtime.api_rx = api_rx;
            let responses = fixture.runtime.fleet_responses.clone();
            let invoke = crate::fleet_wire::ActionInvoke {
                v: FLEET_WIRE_VERSION, invocation_id: "backpressure-original".into(), action: "spawn".into(),
                input: if deferred { json!({"name":"refused", "cli":"cat", "channels":[]}) } else { json!({}) },
                agent_name: None, agent_id: None,
            };
            if deferred {
                fixture.runtime.handle_fleet_action_invoke(invoke).await;
                let custody = loop {
                    if let FleetControlCommand::RegisterFreshAgent { custody, .. } = command_rx.recv().await.unwrap() { break custody; }
                };
                custody.reject_unsent("diagnostic_refusal");
            } else {
                for _ in 0..capacity { commands.try_send(FleetControlCommand::HeartbeatNow).unwrap(); }
                tokio::time::timeout(Duration::from_millis(200), fixture.runtime.handle_fleet_action_invoke(invoke)).await.unwrap();
            }
            if deferred { for _ in 0..capacity { commands.try_send(FleetControlCommand::HeartbeatNow).unwrap(); } }
            assert_eq!(commands.capacity(), 0);
            let actor = tokio::spawn(fixture.runtime.run());
            let (reply, listed) = tokio::sync::oneshot::channel(); api_tx.send(crate::listen_api::ListenApiRequest::List { reply }).await.unwrap();
            tokio::time::timeout(Duration::from_millis(200), listed).await.unwrap().unwrap().unwrap();
            tokio::time::timeout(Duration::from_millis(200), async { while responses.front().is_none() { tokio::task::yield_now().await; } }).await.unwrap();
            let response = responses.front().unwrap(); assert_eq!(response.invocation_id, "backpressure-original");
            let (reply, stopped) = tokio::sync::oneshot::channel(); api_tx.send(crate::listen_api::ListenApiRequest::Shutdown { reply }).await.unwrap();
            tokio::time::timeout(Duration::from_millis(200), stopped).await.unwrap().unwrap().unwrap();
            tokio::time::timeout(Duration::from_secs(5), actor).await.unwrap().unwrap().unwrap();
            assert_eq!(responses.unresolved().len(), 1, "shutdown preserves accepted terminal result");
            assert_eq!(responses.front().unwrap().invocation_id, response.invocation_id);
        }
    }
}

#[tokio::test]
async fn review_response_flood_retains_one_unadmitted_invocation_without_side_effects() {
    let (_dir, mut fixture) = review_fixture();
    for i in 0..258 {
        fixture.runtime.handle_fleet_action_invoke(crate::fleet_wire::ActionInvoke {
            v: FLEET_WIRE_VERSION, invocation_id: format!("flood-{i}"), action: "spawn".into(),
            input: json!({}), agent_name: None, agent_id: None,
        }).await;
    }
    assert_eq!(fixture.runtime.fleet_responses.unresolved().len(), 257);
    assert_eq!(fixture.runtime.held_fleet_invoke.as_ref().unwrap().invocation_id, "flood-257");
    assert!(fixture.runtime.workers.workers.is_empty());
    assert!(fixture.runtime.workers.spawn_registrations.entries.is_empty());
    fixture.runtime.fleet_responses.flushed("flood-0");
    let held = fixture.runtime.held_fleet_invoke.take().unwrap();
    fixture.runtime.handle_fleet_action_invoke(held).await;
    assert_eq!(fixture.runtime.fleet_responses.unresolved().last().unwrap().invocation_id, "flood-257");
}

#[tokio::test]
async fn v3_cleanup_publication_fingerprint_tracks_actual_enqueue() {
    let (_dir,mut f)=review_fixture();let(tx,mut rx)=mpsc::channel(2);f.runtime.fleet_control_tx=tx.clone();
    let name=WorkerName::new("cleanup-aba");
    f.runtime.fleet_delivery_book.bind_authoritative_identity(name.as_str(),"id-a");
    f.runtime.fleet_inventory.insert(name.clone(),crate::fleet_wire::InventoryAgent{agent_id:"id-a".into(),name:name.to_string(),invocation_id:None,session_ref:None});
    super::fleet::publish_fleet_inventory_snapshot(&tx,&f.runtime.fleet_inventory).await;rx.recv().await.unwrap();

    super::identity_cleanup::schedule_identity_cleanup(&mut f.runtime.workers,&tx,&f.runtime.fleet_delivery_book,&mut f.runtime.fleet_inventory,&f.runtime.relaycast_http,&name,false,None);
    assert!(matches!(rx.recv().await,Some(FleetControlCommand::UpdateInventory(rows)) if rows.is_empty()));
    let Some(FleetControlCommand::DeregisterAgent{reply,..})=rx.recv().await else {panic!("cleanup deregistration")};
    reply.send(Ok(())).unwrap();
    tokio::time::timeout(Duration::from_millis(200),async {while f.runtime.workers.identity_cleanups.contains_key(&name) {f.runtime.reconcile_identity_cleanups().await;tokio::task::yield_now().await;}}).await.unwrap();
    // A supplied identity can be attached again after confirmed non-deleting cleanup.
    for _ in 0..2 {tx.try_send(FleetControlCommand::HeartbeatNow).unwrap();}
    let token=crate::node_control::AgentRegistrationToken{name:name.to_string(),agent_id:"id-a".into(),token:"local-supplied-token".into(),delivery_ack_seq:None};
    super::fleet::record_fleet_inventory_agent(&tx,&mut f.runtime.fleet_inventory,&token,None,None).await;
    let dirty=f.runtime.fleet_inventory.needs_publication();
    eprintln!("V3 cleanup ABA latest_actual=[] desired=[id-a] failed_restoration_dirty={dirty}");
    assert!(dirty,"cleanup enqueued B but never recorded that publication; failed restored A is falsely clean");
}

#[tokio::test]
async fn v3_checkpoint_failure_still_tears_down_owned_workers() {
    let mut workers=make_worker_registry_with_worker("evidence-failure").await;
    let worker=workers.workers.get_mut(&WorkerName::new("evidence-failure")).unwrap();
    worker.child.kill().await.unwrap();worker.child.wait().await.unwrap();
    // Fixture child ignores stdin EOF, so only actual worker teardown can stop it.
    worker.child=tokio::process::Command::new("sleep").arg("60").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let pid=worker.child.id().unwrap();
    let mut f=worker_event_runtime_fixture(workers,HashMap::new());
    let blocker=f._temp_dir.path().join("not-a-directory");std::fs::write(&blocker,b"evidence fault fixture").unwrap();
    f.runtime.paths.state=blocker.join("state.json");
    let invoke = crate::fleet_wire::ActionInvoke { v: FLEET_WIRE_VERSION, invocation_id: "evidence-terminal".into(), action: "unknown".into(), input: json!({}), agent_name: None, agent_id: None };
    f.runtime.handle_fleet_action_invoke(invoke).await;
    let(api,api_rx)=mpsc::channel(1);f.runtime.api_rx=api_rx;let actor=tokio::spawn(f.runtime.run());
    let(reply,got)=tokio::sync::oneshot::channel();api.send(crate::listen_api::ListenApiRequest::Shutdown{reply}).await.unwrap();got.await.unwrap().unwrap();
    let ended=tokio::time::timeout(Duration::from_secs(5),actor).await.unwrap().unwrap();
    assert!(ended.is_err());
    tokio::time::sleep(Duration::from_millis(50)).await;
    let survives=unsafe{libc::kill(pid as i32,0)}==0;
    // Always clean only the child created above, including on a failing assertion.
    if survives {unsafe{libc::kill(pid as i32,libc::SIGKILL);}}
    eprintln!("V3 checkpoint failure runtime_returned_error=true owned_child_survives={survives} fixture_pid={pid}");
    assert!(!survives,"checkpoint error returned before workers.shutdown_all(), leaving owned child alive");
}
