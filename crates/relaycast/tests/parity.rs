use relaycast::{
    AgentClient, DmConversationSummary, MessageListQuery, RelayCast, RelayCastOptions,
    ReleaseAgentRequest, SpawnAgentRequest, WsEvent,
};
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn local_options_builder_sets_expected_defaults() {
    let options = RelayCastOptions::local("rk_live_local");
    assert!(options.local);
    assert_eq!(options.api_key, "rk_live_local");
    assert_eq!(options.base_url.as_deref(), Some("http://127.0.0.1:7528"));
}

fn ok(data: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "data": data }))
}

#[tokio::test]
async fn workspace_stream_methods_use_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("GET"))
        .and(path("/v1/workspace/stream"))
        .respond_with(ok(json!({
            "enabled": true,
            "default_enabled": true,
            "override": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let current = relay
        .workspace_stream_get()
        .await
        .expect("workspace_stream_get failed");
    assert!(current.enabled);
    assert!(current.default_enabled);
    assert_eq!(current.override_value, None);

    Mock::given(method("PUT"))
        .and(path("/v1/workspace/stream"))
        .and(body_json(json!({ "enabled": false })))
        .respond_with(ok(json!({
            "enabled": false,
            "default_enabled": true,
            "override": false
        })))
        .expect(1)
        .mount(&server)
        .await;

    let updated = relay
        .workspace_stream_set(false)
        .await
        .expect("workspace_stream_set failed");
    assert!(!updated.enabled);
    assert_eq!(updated.override_value, Some(false));

    Mock::given(method("PUT"))
        .and(path("/v1/workspace/stream"))
        .and(body_json(json!({ "mode": "inherit" })))
        .respond_with(ok(json!({
            "enabled": true,
            "default_enabled": true,
            "override": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let inherited = relay
        .workspace_stream_inherit()
        .await
        .expect("workspace_stream_inherit failed");
    assert_eq!(inherited.override_value, None);
}

#[tokio::test]
async fn spawn_and_release_methods_use_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/agents/spawn"))
        .and(body_json(json!({
            "name": "WorkerOne",
            "cli": "codex",
            "task": "Run parity check",
            "channel": "general",
            "persona": "SDK verifier",
            "metadata": {"ticket": "SDK-101"}
        })))
        .respond_with(ok(json!({
            "id": "a_1",
            "name": "WorkerOne",
            "token": "at_live_worker",
            "cli": "codex",
            "task": "Run parity check",
            "channel": "general",
            "status": "online",
            "created_at": "2026-01-01T00:00:00.000Z",
            "already_existed": false
        })))
        .expect(1)
        .mount(&server)
        .await;

    let spawned = relay
        .spawn_agent(SpawnAgentRequest {
            name: "WorkerOne".to_string(),
            cli: "codex".to_string(),
            task: "Run parity check".to_string(),
            channel: Some("general".to_string()),
            persona: Some("SDK verifier".to_string()),
            metadata: Some(json!({"ticket": "SDK-101"})),
        })
        .await
        .expect("spawn_agent failed");
    assert_eq!(spawned.name, "WorkerOne");
    assert!(!spawned.already_existed);

    Mock::given(method("POST"))
        .and(path("/v1/agents/release"))
        .and(body_json(json!({
            "name": "WorkerOne",
            "reason": "task completed",
            "delete_agent": true
        })))
        .respond_with(ok(json!({
            "name": "WorkerOne",
            "released": true,
            "deleted": true,
            "reason": "task completed"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let released = relay
        .release_agent(ReleaseAgentRequest {
            name: "WorkerOne".to_string(),
            reason: Some("task completed".to_string()),
            delete_agent: Some(true),
        })
        .await
        .expect("release_agent failed");
    assert!(released.released);
    assert!(released.deleted);
}

#[tokio::test]
async fn list_messages_strips_hash_and_passes_pagination_query() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("GET"))
        .and(path("/v1/channels/general/messages"))
        .and(query_param("limit", "25"))
        .and(query_param("before", "m_99"))
        .and(query_param("after", "m_12"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    relay
        .list_messages(
            "#general",
            Some(MessageListQuery {
                limit: Some(25),
                before: Some("m_99".to_string()),
                after: Some("m_12".to_string()),
            }),
        )
        .await
        .expect("list_messages failed");
}

#[tokio::test]
async fn create_workspace_sends_origin_headers() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/workspaces"))
        .and(header("content-type", "application/json"))
        .and(header("x-sdk-version", env!("CARGO_PKG_VERSION")))
        .and(header("x-relaycast-origin-surface", "sdk"))
        .and(header("x-relaycast-origin-client", "@relaycast/sdk-rust"))
        .respond_with(ok(json!({
            "workspace_id": "ws_123",
            "api_key": "rk_live_new",
            "created_at": "2026-01-01T00:00:00.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let created = RelayCast::create_workspace("Parity Test", Some(&server.uri()))
        .await
        .expect("create_workspace failed");

    assert_eq!(created.workspace_id, "ws_123");
}

#[tokio::test]
async fn agent_heartbeat_uses_presence_endpoint() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/agents/heartbeat"))
        .respond_with(ok(json!({})))
        .expect(1)
        .mount(&server)
        .await;

    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");
    agent.heartbeat().await.expect("heartbeat failed");
}

#[test]
fn ws_message_created_deserializes_optional_agent_id() {
    let event = serde_json::from_value::<WsEvent>(json!({
        "type": "message.created",
        "channel": "general",
        "message": {
            "id": "m_1",
            "agent_id": "a_123",
            "agent_name": "alice",
            "text": "hello",
            "attachments": []
        }
    }))
    .expect("failed to parse ws message.created");

    match event {
        WsEvent::MessageCreated(msg) => {
            assert_eq!(msg.message.agent_id.as_deref(), Some("a_123"));
            assert_eq!(msg.message.agent_name, "alice");
        }
        other => panic!("unexpected event variant: {other:?}"),
    }
}

#[test]
fn ws_command_invoked_deserializes_handler_agent_id() {
    let event = serde_json::from_value::<WsEvent>(json!({
        "type": "command.invoked",
        "command": "/spawn",
        "channel": "general",
        "invoked_by": "lead",
        "handler_agent_id": "a_handler_1",
        "parameters": {
            "name": "worker-1",
            "cli": "codex"
        }
    }))
    .expect("failed to parse ws command.invoked");

    match event {
        WsEvent::CommandInvoked(cmd) => {
            assert_eq!(cmd.handler_agent_id, "a_handler_1");
            assert_eq!(cmd.command, "/spawn");
        }
        other => panic!("unexpected event variant: {other:?}"),
    }
}

#[test]
fn ws_command_invoked_requires_handler_agent_id() {
    let err = serde_json::from_value::<WsEvent>(json!({
        "type": "command.invoked",
        "command": "/spawn",
        "channel": "general",
        "invoked_by": "lead",
        "parameters": {
            "name": "worker-1"
        }
    }))
    .expect_err("expected missing handler_agent_id to fail");

    assert!(err.to_string().contains("handler_agent_id"));
}

#[test]
fn dm_conversation_summary_supports_object_shapes() {
    let summary = serde_json::from_value::<DmConversationSummary>(json!({
        "id": "dm_1",
        "channel_id": "c_1",
        "type": "group",
        "name": "ops-room",
        "participants": [
            { "agent_name": "alice", "agent_id": "a_1" },
            { "agent_id": "a_2" },
            "carol"
        ],
        "last_message": { "text": "latest update" },
        "unread_count": 3
    }))
    .expect("failed to parse dm conversation summary");

    assert_eq!(summary.participants, vec!["alice", "a_2", "carol"]);
    assert_eq!(summary.last_message.as_deref(), Some("latest update"));
}

#[tokio::test]
async fn add_dm_participant_uses_agent_name_payload_and_typed_response() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("POST"))
        .and(path("/v1/dm/dm_123/participants"))
        .and(body_json(json!({ "agent_name": "worker-1" })))
        .respond_with(ok(json!({
            "conversation_id": "dm_123",
            "agent": "worker-1",
            "already_member": false
        })))
        .expect(2)
        .mount(&server)
        .await;

    let untyped = agent
        .add_dm_participant("dm_123", "worker-1")
        .await
        .expect("add_dm_participant failed");
    assert_eq!(untyped["agent"], "worker-1");

    let typed = agent
        .add_dm_participant_typed("dm_123", "worker-1")
        .await
        .expect("add_dm_participant_typed failed");
    assert_eq!(typed.agent, "worker-1");
    assert!(!typed.already_member);
}
