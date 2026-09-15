//! Real loopback WS regression for an authenticated but unregistered provider.
use super::*;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;

async fn registration_gate_case(response: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
    let (command_tx, mut command_rx) = mpsc::channel(8);
    let (event_tx, mut event_rx) = mpsc::channel(8);
    let mut registration = Some(NodeRegister {
        v: FLEET_WIRE_VERSION,
        id: None,
        name: "test-node".into(),
        node_id: "node-test".into(),
        provider: None,
        capabilities: vec![],
        max_agents: 8,
        tags: vec![],
        repo_keys: None,
        version: "test".into(),
        machine_id: None,
        resume_cursor: None,
    });
    let mut inventory = vec![InventoryAgent {
        name: "old-worker".into(),
        agent_id: "old-worker-id".into(),
        invocation_id: None,
        session_ref: Some("old-session".into()),
    }];
    let mut load = FleetLoadSnapshot {
        active_agents: 1,
        max_agents: 8,
        handlers_live: true,
        active_agent_names: vec!["old-worker".into()],
    };
    let accepted = response == "accept" || response == "reconfigure";
    let reconfigure = response == "reconfigure";
    let server_command_tx = command_tx.clone();
    let (forwarded_tx, mut forwarded_rx) = oneshot::channel();
    let response = response.to_owned();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(tcp).await.unwrap();
        let Message::Text(raw) = ws.next().await.unwrap().unwrap() else {
            panic!("node.register expected")
        };
        let frame: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(frame["type"], "node.register");
        let id = frame["id"].as_str().unwrap_or("uncorrelated-base-request");
        if accepted {
            // Keep the socket live without accepting the provider. Neither an
            // unrelated success nor transport traffic may open the gate.
            ws.send(Message::Text(
                json!({"v":1,"type":"reply","ok":true,"id":"unrelated","data":{}}).to_string(),
            ))
            .await
            .unwrap();
            // A pong proves the client processed the preceding unrelated reply.
            // No dependent text frame may precede this transport-only barrier.
            ws.send(Message::Ping(b"registration-barrier".to_vec()))
                .await
                .unwrap();
            assert!(
                matches!(ws.next().await, Some(Ok(Message::Pong(payload))) if payload == b"registration-barrier")
            );
            ws.send(Message::Text(
                json!({"v":1,"type":"reply","ok":true,"id":id,"data":{}}).to_string(),
            ))
            .await
            .unwrap();
            for expected in ["inventory.sync", "node.heartbeat"] {
                let Message::Text(raw) = ws.next().await.unwrap().unwrap() else {
                    panic!("text frame expected");
                };
                assert_eq!(
                    serde_json::from_str::<Value>(&raw).unwrap()["type"],
                    expected
                );
            }
            if reconfigure {
                let (register_reply, register_result) = oneshot::channel();
                let (deregister_reply, deregister_result) = oneshot::channel();
                server_command_tx
                    .send(FleetControlCommand::RegisterAgent {
                        request: serde_json::from_value(json!({"v":1,"name":"pending-worker"}))
                            .unwrap(),
                        reply: register_reply,
                    })
                    .await
                    .unwrap();
                server_command_tx
                    .send(FleetControlCommand::DeregisterAgent {
                        request: serde_json::from_value(
                            json!({"v":1,"agent_id":"retiring-worker-id","name":"retiring-worker"}),
                        )
                        .unwrap(),
                        reply: deregister_reply,
                    })
                    .await
                    .unwrap();
                for expected in ["agent.register", "agent.deregister"] {
                    loop {
                        let Message::Text(raw) = ws.next().await.unwrap().unwrap() else {
                            continue;
                        };
                        let frame: Value = serde_json::from_str(&raw).unwrap();
                        if frame["type"] == "node.heartbeat" {
                            continue;
                        }
                        assert_eq!(frame["type"], expected);
                        break;
                    }
                }
                server_command_tx
                    .send(FleetControlCommand::RegisterNode {
                        manifest: NodeManifest {
                            name: "updated-node".into(),
                            node_id: None,
                            capabilities: vec![],
                            max_agents: None,
                            tags: None,
                            repo_keys: None,
                            version: None,
                        },
                        resume_cursor: None,
                    })
                    .await
                    .unwrap();
                assert_eq!(
                    register_result.await.unwrap().unwrap_err(),
                    "node_control_reconfiguring"
                );
                assert_eq!(
                    deregister_result.await.unwrap().unwrap_err(),
                    "node_control_reconfiguring"
                );
                return;
            }
            for name in ["old-worker", "fresh-worker"] {
                ws.send(Message::Text(json!({"v":1,"type":"deliver","agent":name,"agent_id":format!("{name}-id"),"delivery_id":format!("delivery-{name}"),"msg_id":format!("message-{name}"),"seq":1,"mode":"wait","payload":{"type":"dm.received","text":"local probe"}}).to_string())).await.unwrap();
            }
            // Keep the peer polling (and answering pings) until the runtime
            // has forwarded both events. Closing immediately after send races
            // the client's heartbeat write against draining buffered deliveries.
            loop {
                tokio::select! {
                    result = &mut forwarded_rx => {
                        result.expect("paired runtime observations completed");
                        ws.close(None).await.unwrap();
                        return;
                    }
                    message = ws.next() => {
                        assert!(matches!(message, Some(Ok(_))), "accepted client disconnected before forwarding paired events: {message:?}");
                    }
                }
            }
        }
        if response != "timeout" {
            let reply = match response.as_str() {
                "error" => {
                    json!({"v":1,"type":"error","ok":false,"id":id,"code":"provider_instance_conflict","message":"incumbent provider still live"})
                }
                "false" => json!({"v":1,"type":"reply","ok":false,"id":id,"data":{}}),
                "uncorrelated" => {
                    json!({"v":1,"type":"reply","ok":true,"id":"some-other-request","data":{}})
                }
                _ => panic!("unknown arm"),
            };
            ws.send(Message::Text(reply.to_string())).await.unwrap();
        }
        // A failed registration must never be followed by inventory, heartbeat,
        // agent registration or an ACK on the unauthoritative socket.
        while let Ok(Some(Ok(frame))) =
            tokio::time::timeout(Duration::from_secs(1), ws.next()).await
        {
            match frame {
                Message::Text(raw) => panic!(
                    "registration-dependent frame escaped gate: {}",
                    serde_json::from_str::<Value>(&raw).unwrap()["type"]
                ),
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    let config = FleetControlConfig {
        ws_url,
        node_token: Some("nt_test".into()),
        node_id: "node-test".into(),
        node_name: "test-node".into(),
        broker_version: "test".into(),
        token_minter: None,
        session_token: None,
        // Only the rejection/timeout arms test the short registration deadline.
        // Positive delivery completion is event-coordinated and bounded below.
        read_idle_timeout: if accepted {
            None
        } else {
            Some(Duration::from_millis(150))
        },
        probe: None,
    };
    let observe = async {
        if accepted {
            let connected = event_rx.recv().await;
            assert!(
                matches!(connected, Some(FleetControlEvent::Connected)),
                "accepted registration must connect: {connected:?}"
            );
            if !reconfigure {
                for expected in ["old-worker", "fresh-worker"] {
                    let event = event_rx.recv().await;
                    let Some(FleetControlEvent::Message(RelaycastToBroker::Deliver(deliver))) =
                        event
                    else {
                        panic!("accepted provider must forward {expected}; observed {event:?}");
                    };
                    assert_eq!(deliver.agent, expected);
                    assert_eq!(deliver.msg_id, format!("message-{expected}"));
                }
                forwarded_tx
                    .send(())
                    .expect("accepted peer remains open until observations complete");
            }
        }
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            run_connected_once(
                &config,
                &mut command_rx,
                &event_tx,
                &mut registration,
                &mut inventory,
                &mut load,
                if accepted {
                    Duration::from_secs(60)
                } else {
                    Duration::from_millis(50)
                },
            ),
            observe,
        )
    })
    .await
    .expect("registration case must terminate after its bounded protocol exchange");
    // Only a correlated `inventory.sync` reply proves application liveness,
    // and this fixture never sends one (accepted or not) — it exercises the
    // registration gate, not the inventory-ack liveness deadline.
    assert_eq!(
        result,
        ControlRunResult::Disconnected {
            application_ready: false,
        }
    );
    assert!(
        event_rx.try_recv().is_err(),
        "no unexpected or duplicate runtime events"
    );
    server
        .await
        .expect("the rejected socket emitted no dependent frames");
}

#[tokio::test]
async fn rejected_registration_never_advertises_or_syncs() {
    registration_gate_case("error").await;
}
#[tokio::test]
async fn unsuccessful_registration_reply_never_advertises_or_syncs() {
    registration_gate_case("false").await;
}
#[tokio::test]
async fn silent_registration_never_advertises_or_syncs() {
    registration_gate_case("timeout").await;
}
#[tokio::test]
async fn unrelated_reply_cannot_open_registration_gate() {
    registration_gate_case("uncorrelated").await;
}

#[tokio::test]
async fn accepted_registration_forwards_paired_deliveries_once() {
    registration_gate_case("accept").await;
}

#[tokio::test]
async fn manifest_change_fails_pending_requests_before_reconnect() {
    registration_gate_case("reconfigure").await;
}
