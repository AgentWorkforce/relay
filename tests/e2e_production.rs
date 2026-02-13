//! End-to-end integration test running the relay-broker pipeline against production.
//!
//! This test exercises the FULL relay-broker flow against api.relaycast.dev:
//!   1. Register agents via HTTP API
//!   2. Connect WebSocket (RelaycastWsClient)
//!   3. Subscribe to a unique test channel
//!   4. Send a message from another agent via HTTP
//!   5. Receive the event via WS
//!   6. Map through message_bridge (map_ws_event → to_inject_request)
//!   7. Run through dedup → scheduler → queue → injector
//!   8. Verify the final injection string matches relay-broker's format:
//!      channel: "\nRelay message from {agent} in #{channel} [{id}]: {text}\n"
//!      dm:      "\nRelay message from {agent} [{id}]: {text}\n"
//!
//! This covers every relay-broker component except the PTY layer (which is
//! pure I/O passthrough tested separately by portable-pty).
//!
//! Requirements:
//!   RELAY_API_KEY=rk_live_xxx must be set
//!
//! Run with:
//!   RELAY_API_KEY=rk_live_xxx cargo test --test e2e_production -- --ignored --nocapture

use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use relay_broker::{
    dedup::DedupCache,
    events::EventEmitter,
    inject::Injector,
    message_bridge::{map_ws_broker_command, map_ws_event, to_inject_request},
    queue::BoundedPriorityQueue,
    scheduler::Scheduler,
    types::{BrokerCommandPayload, InjectRequest},
};

const BASE_URL: &str = "https://api.relaycast.dev";
const WS_BASE_URL: &str = "wss://api.relaycast.dev";

fn api_key() -> String {
    std::env::var("RELAY_API_KEY").expect("RELAY_API_KEY env var must be set")
}

fn run_id() -> String {
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    )
}

async fn api(
    client: &reqwest::Client,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    token: &str,
) -> (u16, Value) {
    let url = format!("{}{}", BASE_URL, path);
    let mut req = client
        .request(method, &url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.expect("HTTP request failed");
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let json: Value = if text.is_empty() {
        json!(null)
    } else {
        serde_json::from_str(&text).unwrap_or(json!({"raw": text}))
    };
    (status, json)
}

async fn connect_ws(
    token: &str,
) -> (
    futures::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        Message,
    >,
    futures::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    String,
) {
    let url = format!("{}/v1/stream?token={}", WS_BASE_URL, token);
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("WS connect failed");
    let (write, mut read) = ws.split();

    let handshake = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(msg) = read.next().await {
            if let Ok(Message::Text(text)) = msg {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if v.get("type").and_then(Value::as_str) == Some("connected") {
                        return v
                            .get("client_id")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                    }
                }
            }
        }
        panic!("WS stream ended before connected handshake");
    })
    .await
    .expect("Timeout waiting for connected handshake");

    (write, read, handshake)
}

async fn next_ws_message_of_type(
    read: &mut futures::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
    expected_type: &str,
    timeout_secs: u64,
) -> Value {
    let expected = expected_type.to_string();
    tokio::time::timeout(Duration::from_secs(timeout_secs), async {
        while let Some(msg) = read.next().await {
            if let Ok(Message::Text(text)) = msg {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if v.get("type").and_then(Value::as_str) == Some(&expected) {
                        return v;
                    }
                }
            }
        }
        panic!("WS stream ended before receiving {}", expected);
    })
    .await
    .unwrap_or_else(|_| panic!("Timeout waiting for {} event", expected))
}

/// Simulate format_injection from main.rs
fn format_injection(req: &InjectRequest) -> String {
    if req.target.starts_with('#') {
        format!(
            "\nRelay message from {} in {} [{}]: {}\n",
            req.from, req.target, req.id, req.body
        )
    } else {
        format!(
            "\nRelay message from {} [{}]: {}\n",
            req.from, req.id, req.body
        )
    }
}

/// Full end-to-end test: WS event → message_bridge → dedup → scheduler → queue → injector → format
#[tokio::test]
#[ignore]
async fn full_relay_broker_pipeline_against_production() {
    let key = api_key();
    let id = run_id();
    let http = reqwest::Client::new();
    let channel_name = format!("rb-e2e-{}", id);

    println!("\n=== Relay-Broker Full E2E Pipeline Test ===");
    println!("  Run ID: {}", id);
    println!("  Channel: {}", channel_name);

    // ---- Step 1: Register broker agent ----
    let broker_name = format!("rb-broker-{}", id);
    let (status, body) = api(
        &http,
        reqwest::Method::POST,
        "/v1/agents",
        Some(json!({
            "name": broker_name,
            "type": "agent",
            "persona": "E2E relay-broker test"
        })),
        &key,
    )
    .await;
    assert_eq!(status, 201, "Broker agent registration failed: {}", body);
    let broker_token = body["data"]["token"].as_str().unwrap().to_string();
    println!("  1. Registered broker agent: {}", broker_name);

    // ---- Step 2: Register sender agent ----
    let sender_name = format!("rb-sender-{}", id);
    let (status, body) = api(
        &http,
        reqwest::Method::POST,
        "/v1/agents",
        Some(json!({
            "name": sender_name,
            "type": "agent",
            "persona": "E2E message sender"
        })),
        &key,
    )
    .await;
    assert_eq!(status, 201, "Sender agent registration failed: {}", body);
    let sender_token = body["data"]["token"].as_str().unwrap().to_string();
    println!("  2. Registered sender agent: {}", sender_name);

    // ---- Step 3: Create test channel ----
    let (status, _) = api(
        &http,
        reqwest::Method::POST,
        "/v1/channels",
        Some(json!({"name": channel_name, "topic": "E2E test"})),
        &broker_token,
    )
    .await;
    assert_eq!(status, 201, "Channel creation failed");
    println!("  3. Created channel: {}", channel_name);

    // ---- Step 4: Connect WebSocket (like RelaycastWsClient.run()) ----
    let (mut write, mut read, client_id) = connect_ws(&broker_token).await;
    println!("  4. WebSocket connected (client_id: {})", client_id);

    // ---- Step 5: Subscribe to channel ----
    write
        .send(Message::Text(
            json!({"type": "subscribe", "channels": [channel_name]}).to_string(),
        ))
        .await
        .unwrap();
    let sub_ack = next_ws_message_of_type(&mut read, "subscribed", 10).await;
    assert!(sub_ack["channels"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c.as_str() == Some(&channel_name)),);
    println!("  5. Subscribed to channel: {}", channel_name);

    // ---- Step 6: Send message from sender agent ----
    let msg_text = format!("Hello from sender! Test run {}", id);
    let (status, post_body) = api(
        &http,
        reqwest::Method::POST,
        &format!("/v1/channels/{}/messages", channel_name),
        Some(json!({"text": msg_text})),
        &sender_token,
    )
    .await;
    assert_eq!(status, 201, "Post message failed: {}", post_body);
    println!("  6. Sent message via HTTP: \"{}\"", msg_text);

    // ---- Step 7: Receive via WS ----
    let ws_event = next_ws_message_of_type(&mut read, "message.created", 10).await;
    println!(
        "  7. Received WS event: type={}, channel={}",
        ws_event["type"], ws_event["channel"]
    );

    // ---- Step 8: message_bridge → map_ws_event ----
    let mapped = map_ws_event(&ws_event).expect("map_ws_event should succeed");
    assert_eq!(mapped.from, sender_name);
    assert_eq!(mapped.target, format!("#{}", channel_name));
    assert_eq!(mapped.text, msg_text);
    println!(
        "  8. message_bridge mapped: kind={:?}, from={}, target={}, priority={:?}",
        mapped.kind, mapped.from, mapped.target, mapped.priority
    );

    // ---- Step 9: Dedup check ----
    let mut dedup = DedupCache::new(Duration::from_secs(300), 1000);
    let is_new = dedup.insert_if_new(&mapped.event_id, Instant::now());
    assert!(is_new, "Event should be new (not a duplicate)");

    // Second time should be blocked
    let is_dup = !dedup.insert_if_new(&mapped.event_id, Instant::now());
    assert!(is_dup, "Same event_id should be deduplicated");
    println!(
        "  9. Dedup check: passed (new={}, dup_blocked={})",
        is_new, is_dup
    );

    // ---- Step 10: to_inject_request ----
    let inject_req = to_inject_request(mapped).expect("to_inject_request should succeed");
    assert_eq!(inject_req.body, msg_text);
    assert_eq!(inject_req.from, sender_name);
    println!(
        "  10. to_inject_request: id={}, from={}",
        inject_req.id, inject_req.from
    );

    // ---- Step 11: Scheduler → Queue ----
    let mut scheduler = Scheduler::new(0, 100); // 0ms cooldown for test, 100ms coalesce
    let now = Instant::now();
    let flushed = scheduler.push(inject_req, now);
    assert!(flushed.is_none(), "First push should not flush immediately");

    // Drain after coalesce window
    let ready = scheduler.drain_ready(now + Duration::from_millis(200));
    assert_eq!(ready.len(), 1, "Should drain exactly 1 request");
    println!("  11. Scheduler drained {} ready request(s)", ready.len());

    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(200);
    queue.push(ready.into_iter().next().unwrap()).unwrap();
    assert_eq!(queue.len(), 1);
    let queued = queue.pop().unwrap();
    println!("  12. Queue pop: priority={:?}", queued.priority);

    // ---- Step 12: Injector ----
    let events = EventEmitter::new(false);
    let injector = Injector::new(3, 300, events);

    // Capture the injection output
    let mut injection_output = String::new();
    let result = injector
        .deliver_with(queued, |req| {
            injection_output = format_injection(req);
            Ok(())
        })
        .await;
    assert!(result.delivered, "Injection should succeed");
    println!("  13. Injector delivered successfully");

    // ---- Step 13: Verify final injection format ----
    println!("\n  === INJECTION OUTPUT ===");
    println!("  {:?}", injection_output);
    println!("  ========================\n");

    // Verify the format matches what relay-broker writes to PTY
    assert!(
        injection_output.starts_with("\nRelay message from "),
        "Should start with newline + 'Relay message from '"
    );
    assert!(
        injection_output.contains(&sender_name),
        "Should contain sender name '{}'",
        sender_name
    );
    assert!(
        injection_output.contains(&msg_text),
        "Should contain message text '{}'",
        msg_text
    );
    assert!(injection_output.ends_with('\n'), "Should end with newline");

    // Parse and verify structure: "\nRelay message from {from} in #{channel} [{id}]: {body}\n"
    let trimmed = injection_output.trim();
    assert!(
        trimmed.starts_with("Relay message from "),
        "Trimmed should start with 'Relay message from '"
    );
    let after_from = trimmed.strip_prefix("Relay message from ").unwrap();
    assert!(
        after_from.starts_with(&sender_name),
        "Should have sender name after 'from '"
    );
    let after_name = after_from.strip_prefix(&sender_name).unwrap();
    assert!(
        after_name.starts_with(&format!(" in #{} [", channel_name)),
        "Should include channel segment after sender name"
    );
    assert!(
        after_name.contains("]: "),
        "Should have ']: ' separating id from body"
    );
    let body_start = after_name.find("]: ").unwrap() + 3;
    let extracted_body = &after_name[body_start..];
    assert_eq!(
        extracted_body, msg_text,
        "Extracted body should match original message"
    );

    println!("  ALL CHECKS PASSED");
    println!("  Full pipeline: WS event → map → dedup → schedule → queue → inject → format");

    // ---- DM test: verify DM pipeline ----
    println!("\n  --- DM Pipeline Test ---");

    let dm_text = format!("DM via broker pipeline {}", id);
    let (status, _) = api(
        &http,
        reqwest::Method::POST,
        "/v1/dm",
        Some(json!({"to": broker_name, "text": dm_text})),
        &sender_token,
    )
    .await;
    assert_eq!(status, 201, "DM send failed");

    let dm_event = next_ws_message_of_type(&mut read, "dm.received", 10).await;
    let dm_mapped = map_ws_event(&dm_event).expect("DM map should work");
    assert_eq!(dm_mapped.from, sender_name);
    assert_eq!(dm_mapped.text, dm_text);

    let dm_req = to_inject_request(dm_mapped).unwrap();
    let dm_injection = format_injection(&dm_req);
    assert!(
        !dm_injection.contains(" in #"),
        "DM injection should not include channel segment"
    );
    assert!(dm_injection.contains(&sender_name));
    assert!(dm_injection.contains(&dm_text));
    println!("  DM injection: {:?}", dm_injection);
    println!("  DM pipeline: PASSED\n");

    // ---- Cleanup ----
    let _ = write.close().await;
    let _ = api(
        &http,
        reqwest::Method::DELETE,
        &format!("/v1/channels/{}", channel_name),
        None,
        &key,
    )
    .await;
    println!("  Cleaned up. Done!");
}

/// Test message coalescing: multiple messages from same sender batch into one injection
#[tokio::test]
#[ignore]
async fn coalescing_with_production_events() {
    let key = api_key();
    let id = run_id();
    let http = reqwest::Client::new();
    let channel_name = format!("rb-coal-{}", id);

    println!("\n=== Coalescing Test ===");

    // Register agents
    let broker_name = format!("rb-coal-broker-{}", id);
    let (_, body) = api(
        &http,
        reqwest::Method::POST,
        "/v1/agents",
        Some(json!({"name": broker_name, "type": "agent"})),
        &key,
    )
    .await;
    let broker_token = body["data"]["token"].as_str().unwrap().to_string();

    let sender_name = format!("rb-coal-sender-{}", id);
    let (_, body) = api(
        &http,
        reqwest::Method::POST,
        "/v1/agents",
        Some(json!({"name": sender_name, "type": "agent"})),
        &key,
    )
    .await;
    let sender_token = body["data"]["token"].as_str().unwrap().to_string();

    // Create channel
    let _ = api(
        &http,
        reqwest::Method::POST,
        "/v1/channels",
        Some(json!({"name": channel_name})),
        &broker_token,
    )
    .await;

    // Connect WS
    let (mut write, mut read, _) = connect_ws(&broker_token).await;
    write
        .send(Message::Text(
            json!({"type": "subscribe", "channels": [channel_name]}).to_string(),
        ))
        .await
        .unwrap();
    let _ = next_ws_message_of_type(&mut read, "subscribed", 10).await;

    // Send 3 rapid messages
    for i in 1..=3 {
        let _ = api(
            &http,
            reqwest::Method::POST,
            &format!("/v1/channels/{}/messages", channel_name),
            Some(json!({"text": format!("burst-{}", i)})),
            &sender_token,
        )
        .await;
    }

    // Receive all 3 via WS
    let mut scheduler = Scheduler::new(0, 500); // 500ms coalesce window
    let mut dedup = DedupCache::new(Duration::from_secs(300), 1000);
    let start = Instant::now();

    for _ in 0..3 {
        let event = next_ws_message_of_type(&mut read, "message.created", 10).await;
        let mapped = map_ws_event(&event).unwrap();
        if dedup.insert_if_new(&mapped.event_id, Instant::now()) {
            if let Some(req) = to_inject_request(mapped) {
                scheduler.push(req, start);
            }
        }
    }

    // Drain after coalesce window
    let ready = scheduler.drain_ready(start + Duration::from_millis(600));
    assert_eq!(
        ready.len(),
        1,
        "3 rapid messages from same sender should coalesce into 1"
    );

    let coalesced = &ready[0];
    assert!(coalesced.body.contains("burst-1"), "Should contain burst-1");
    assert!(coalesced.body.contains("burst-2"), "Should contain burst-2");
    assert!(coalesced.body.contains("burst-3"), "Should contain burst-3");

    let injection = format_injection(coalesced);
    println!("  Coalesced injection: {:?}", injection);
    println!("  3 messages → 1 injection: PASSED\n");

    // Cleanup
    let _ = write.close().await;
    let _ = api(
        &http,
        reqwest::Method::DELETE,
        &format!("/v1/channels/{}", channel_name),
        None,
        &key,
    )
    .await;
}

#[test]
fn format_injection_channel_target_includes_channel_segment() {
    let req = InjectRequest {
        id: "evt_1".to_string(),
        from: "alice".to_string(),
        target: "#general".to_string(),
        body: "hello".to_string(),
        priority: relay_broker::types::RelayPriority::P3,
        attempts: 0,
    };
    let rendered = format_injection(&req);
    assert_eq!(
        rendered,
        "\nRelay message from alice in #general [evt_1]: hello\n"
    );
}

#[test]
fn format_injection_direct_target_uses_legacy_shape() {
    let req = InjectRequest {
        id: "evt_dm".to_string(),
        from: "alice".to_string(),
        target: "bob".to_string(),
        body: "hi".to_string(),
        priority: relay_broker::types::RelayPriority::P2,
        attempts: 0,
    };
    let rendered = format_injection(&req);
    assert_eq!(rendered, "\nRelay message from alice [evt_dm]: hi\n");
}

/// End-to-end test: register /spawn command → invoke with parameters → receive WS event →
/// verify `parameters` is present → feed through `map_ws_broker_command` → verify SpawnParams.
///
/// This validates the full Relaycast ↔ relay-broker command pipeline.
#[tokio::test]
#[ignore]
async fn command_invoked_with_parameters_e2e() {
    let key = api_key();
    let id = run_id();
    let http = reqwest::Client::new();

    println!("\n=== Command.Invoked Parameters E2E Test ===");
    println!("  Run ID: {}", id);

    // ---- Step 1: Register handler agent (receives the command events) ----
    let handler_name = format!("rb-handler-{}", id);
    let (status, body) = api(
        &http,
        reqwest::Method::POST,
        "/v1/agents",
        Some(json!({
            "name": handler_name,
            "type": "agent",
            "persona": "E2E command handler"
        })),
        &key,
    )
    .await;
    assert_eq!(status, 201, "Handler agent registration failed: {}", body);
    let handler_token = body["data"]["token"].as_str().unwrap().to_string();
    let handler_id = body["data"]["id"].as_str().unwrap().to_string();
    println!(
        "  1. Registered handler agent: {} (id: {})",
        handler_name, handler_id
    );

    // ---- Step 2: Register invoker agent (invokes the commands) ----
    let invoker_name = format!("rb-invoker-{}", id);
    let (status, body) = api(
        &http,
        reqwest::Method::POST,
        "/v1/agents",
        Some(json!({
            "name": invoker_name,
            "type": "agent",
            "persona": "E2E command invoker"
        })),
        &key,
    )
    .await;
    assert_eq!(status, 201, "Invoker agent registration failed: {}", body);
    let invoker_token = body["data"]["token"].as_str().unwrap().to_string();
    let invoker_id = body["data"]["id"].as_str().unwrap().to_string();
    println!(
        "  2. Registered invoker agent: {} (id: {})",
        invoker_name, invoker_id
    );

    // ---- Step 3: Create test channel ----
    let channel_name = format!("rb-cmd-{}", id);
    let (status, _) = api(
        &http,
        reqwest::Method::POST,
        "/v1/channels",
        Some(json!({"name": channel_name, "topic": "Command E2E test"})),
        &handler_token,
    )
    .await;
    assert_eq!(status, 201, "Channel creation failed");
    println!("  3. Created channel: {}", channel_name);

    // ---- Step 4: Delete stale /spawn and /release commands (idempotent) ----
    let _ = api(
        &http,
        reqwest::Method::DELETE,
        "/v1/commands/spawn",
        None,
        &key,
    )
    .await;
    let _ = api(
        &http,
        reqwest::Method::DELETE,
        "/v1/commands/release",
        None,
        &key,
    )
    .await;

    // ---- Step 5: Register /spawn command with handler ----
    let (status, body) = api(
        &http,
        reqwest::Method::POST,
        "/v1/commands",
        Some(json!({
            "command": "spawn",
            "description": "E2E spawn test",
            "handler_agent": handler_name,
            "parameters": {"name": "string", "cli": "string", "args": "array"}
        })),
        &key,
    )
    .await;
    assert_eq!(status, 201, "Command registration failed: {}", body);
    println!("  4. Registered command: /spawn");

    // ---- Step 6: Register /release command with handler ----
    let (status, body) = api(
        &http,
        reqwest::Method::POST,
        "/v1/commands",
        Some(json!({
            "command": "release",
            "description": "E2E release test",
            "handler_agent": handler_name,
            "parameters": {"name": "string"}
        })),
        &key,
    )
    .await;
    assert_eq!(status, 201, "Release command registration failed: {}", body);
    println!("  5. Registered command: /release");

    // ---- Step 6: Connect handler WS ----
    let (mut write, mut read, client_id) = connect_ws(&handler_token).await;
    println!(
        "  6. Handler WebSocket connected (client_id: {})",
        client_id
    );

    // Subscribe to the channel
    write
        .send(Message::Text(
            json!({"type": "subscribe", "channels": [channel_name]}).to_string(),
        ))
        .await
        .unwrap();
    let _ = next_ws_message_of_type(&mut read, "subscribed", 10).await;
    println!("  7. Handler subscribed to {}", channel_name);

    // ---- Step 7: Invoke /spawn with parameters ----
    let (status, invoke_body) = api(
        &http,
        reqwest::Method::POST,
        &"/v1/commands/spawn/invoke".to_string(),
        Some(json!({
            "channel": channel_name,
            "parameters": {
                "name": "Worker1",
                "cli": "codex",
                "args": ["--full-auto"]
            }
        })),
        &invoker_token,
    )
    .await;
    assert_eq!(status, 201, "Spawn invoke failed: {}", invoke_body);
    println!("  8. Invoked /spawn with parameters: {}", invoke_body);

    // ---- Step 8: Receive command.invoked via WS ----
    let ws_event = next_ws_message_of_type(&mut read, "command.invoked", 15).await;
    println!(
        "  9. Received WS event: {}",
        serde_json::to_string_pretty(&ws_event).unwrap()
    );

    // ---- Step 9: Verify the WS event has parameters ----
    assert_eq!(
        ws_event.get("type").and_then(|v| v.as_str()),
        Some("command.invoked"),
        "Event type should be command.invoked"
    );
    assert!(
        ws_event.get("command").is_some(),
        "Event should have 'command' field"
    );
    assert!(
        ws_event.get("parameters").is_some(),
        "CRITICAL: Event MUST have 'parameters' field — this is the whole point of the Relaycast fix"
    );
    let params = ws_event.get("parameters").unwrap();
    assert!(
        !params.is_null(),
        "parameters should not be null for a spawn invocation"
    );
    assert_eq!(
        params.get("name").and_then(|v| v.as_str()),
        Some("Worker1"),
        "parameters.name should be Worker1"
    );
    assert_eq!(
        params.get("cli").and_then(|v| v.as_str()),
        Some("codex"),
        "parameters.cli should be codex"
    );
    assert_eq!(
        params
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| a.len()),
        Some(1),
        "parameters.args should have 1 element"
    );
    println!("  10. WS event has correct parameters field ✓");

    // ---- Step 10: Feed through map_ws_broker_command ----
    // The WS event command field includes the "/" prefix from Relaycast
    let cmd_event = map_ws_broker_command(&ws_event)
        .expect("map_ws_broker_command should successfully parse the live WS event");
    println!("  11. map_ws_broker_command parsed: {:?}", cmd_event);

    assert_eq!(cmd_event.channel, channel_name);
    assert_eq!(cmd_event.invoked_by, invoker_id);
    match &cmd_event.payload {
        BrokerCommandPayload::Spawn(spawn) => {
            assert_eq!(spawn.name, "Worker1");
            assert_eq!(spawn.cli, "codex");
            assert_eq!(spawn.args, vec!["--full-auto"]);
            println!(
                "  12. SpawnParams verified: name={}, cli={}, args={:?} ✓",
                spawn.name, spawn.cli, spawn.args
            );
        }
        BrokerCommandPayload::Release(_) => panic!("Expected Spawn, got Release"),
    }

    // Verify it is NOT picked up by map_ws_event (command.invoked is not an InboundKind)
    assert!(
        map_ws_event(&ws_event).is_none(),
        "command.invoked should NOT map to InboundRelayEvent"
    );
    println!("  13. Correctly excluded from map_ws_event ✓");

    // ---- Step 11: Invoke /release with parameters ----
    let (status, release_body) = api(
        &http,
        reqwest::Method::POST,
        &"/v1/commands/release/invoke".to_string(),
        Some(json!({
            "channel": channel_name,
            "parameters": {
                "name": "Worker1"
            }
        })),
        &invoker_token,
    )
    .await;
    assert_eq!(status, 201, "Release invoke failed: {}", release_body);
    println!("  14. Invoked /release with parameters");

    // ---- Step 12: Receive release command.invoked via WS ----
    let release_event = next_ws_message_of_type(&mut read, "command.invoked", 15).await;
    println!(
        "  15. Received release WS event: {}",
        serde_json::to_string_pretty(&release_event).unwrap()
    );

    let release_cmd = map_ws_broker_command(&release_event)
        .expect("map_ws_broker_command should parse release event");
    match &release_cmd.payload {
        BrokerCommandPayload::Release(release) => {
            assert_eq!(release.name, "Worker1");
            println!("  16. ReleaseParams verified: name={} ✓", release.name);
        }
        BrokerCommandPayload::Spawn(_) => panic!("Expected Release, got Spawn"),
    }

    // ---- Step 13: Test null parameters (invoke without parameters) ----
    let (status, _) = api(
        &http,
        reqwest::Method::POST,
        &"/v1/commands/spawn/invoke".to_string(),
        Some(json!({
            "channel": channel_name
        })),
        &invoker_token,
    )
    .await;
    // This may succeed (201) or fail depending on Relaycast command validation.
    // If we get the event, map_ws_broker_command should return None (missing parameters).
    if status == 201 {
        let null_event = next_ws_message_of_type(&mut read, "command.invoked", 10).await;
        let null_result = map_ws_broker_command(&null_event);
        assert!(
            null_result.is_none(),
            "Invoke without parameters should return None from map_ws_broker_command"
        );
        println!("  17. Invoke without parameters correctly returns None ✓");
    } else {
        println!(
            "  17. Invoke without parameters rejected by server (status: {}) — OK",
            status
        );
    }

    println!("\n  === ALL COMMAND.INVOKED E2E CHECKS PASSED ===");
    println!("  Pipeline: register → invoke → WS event → map_ws_broker_command → SpawnParams/ReleaseParams");

    // ---- Cleanup ----
    let _ = write.close().await;
    let _ = api(
        &http,
        reqwest::Method::DELETE,
        "/v1/commands/spawn",
        None,
        &key,
    )
    .await;
    let _ = api(
        &http,
        reqwest::Method::DELETE,
        "/v1/commands/release",
        None,
        &key,
    )
    .await;
    let _ = api(
        &http,
        reqwest::Method::DELETE,
        &format!("/v1/channels/{}", channel_name),
        None,
        &key,
    )
    .await;
    println!("  Cleaned up commands and channel. Done!\n");
}
