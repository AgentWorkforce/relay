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
            assert!(tokio::time::timeout(Duration::from_millis(30), ws.next())
                .await
                .is_err());
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
            ws.close(None).await.unwrap();
            return;
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
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        run_connected_once(
            &FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".into()),
                node_id: "node-test".into(),
                node_name: "test-node".into(),
                broker_version: "test".into(),
                token_minter: None,
                session_token: None,
                read_idle_timeout: Some(Duration::from_millis(150)),
                probe: None,
            },
            &mut command_rx,
            &event_tx,
            &mut registration,
            &mut inventory,
            &mut load,
            Duration::from_millis(50),
        ),
    )
    .await
    .expect("registration rejection/timeout must terminate the session");
    assert_eq!(result, ControlRunResult::Disconnected);
    if accepted {
        assert!(matches!(
            event_rx.try_recv(),
            Ok(FleetControlEvent::Connected)
        ));
        for expected in if reconfigure {
            vec![]
        } else {
            vec!["old-worker", "fresh-worker"]
        } {
            let Ok(FleetControlEvent::Message(RelaycastToBroker::Deliver(deliver))) =
                event_rx.try_recv()
            else {
                panic!("accepted provider must forward the paired deliveries")
            };
            assert_eq!(deliver.agent, expected);
            assert_eq!(deliver.msg_id, format!("message-{expected}"));
        }
        assert!(event_rx.try_recv().is_err(), "no duplicate deliveries");
    } else {
        assert!(
            !matches!(event_rx.try_recv(), Ok(FleetControlEvent::Connected)),
            "transport acceptance must not report an unregistered provider connected"
        );
    }
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
