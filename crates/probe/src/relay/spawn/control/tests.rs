use super::*;

fn registered() -> Registration {
    serde_json::from_value(json!({"name":"test-caller","agentID":"agent_caller","target":{"kind":"codex","id":"thread-test"},"title":"Test","baseURL":"https://cast.example","registeredAt":"2026-10-15T00:00:00Z","workspaceKey":"test-workspace-secret"})).unwrap()
}
fn selected_workspace() -> Workspace {
    Workspace {
        key: Secret::new("test-workspace-secret"),
        base_url: "https://cast.example".into(),
        workspace_id: None,
    }
}
#[test]
fn only_an_active_exact_workspace_registration_can_act() {
    let mut store = Store::default();
    store.registrations.push(registered());
    let workspace = selected_workspace();
    assert!(caller_token(&store, &workspace, "test-caller").is_err());
    store
        .tokens
        .insert("test-caller".into(), Secret::new("test-agent-secret"));
    assert_eq!(
        caller_token(&store, &workspace, "test-caller").unwrap(),
        Secret::new("test-agent-secret")
    );
    assert!(caller_token(&store, &workspace, "other-caller").is_err());
    let wrong_key = Workspace {
        key: Secret::new("other-secret"),
        ..workspace.clone()
    };
    assert!(caller_token(&store, &wrong_key, "test-caller").is_err());
    let wrong_origin = Workspace {
        base_url: "https://other.example".into(),
        ..workspace.clone()
    };
    assert!(caller_token(&store, &wrong_origin, "test-caller").is_err());
    store.registrations[0].archived_at = Some("2026-10-15T01:00:00Z".into());
    assert!(caller_token(&store, &workspace, "test-caller").is_err());
}
#[test]
fn path_and_idempotency_inputs_refuse_injection_and_weak_keys() {
    for bad in [
        "",
        "../spawn",
        "name?token=secret",
        "grok:other",
        "white space",
        "a\r\nb",
    ] {
        assert!(segment(bad).is_err());
    }
    assert!(key("short").is_err());
    assert!(key("spawn-test-20261015-0001").is_ok());
    assert!(
        serde_json::from_value::<SpawnInvokeParams>(json!({"url":"https://attacker.example"}))
            .is_err()
    );
    assert!(serde_json::from_value::<SpawnInvocationParams>(
        json!({"caller_name":"test-caller","action":"other","invocation_id":"i1"})
    )
    .is_err());
}
#[test]
fn receipt_exposes_only_typed_safe_fields() {
    let data = json!({"id":"invocation_1","status":"completed","dispatched_node_id":"node_1","token":"never-return-token","input":{"task":"private task"},"output":{"name":"test-agent","spawned":true,"ready":true,"token":"nested-secret","config":{"api_key":"nested-key"}},"error":"raw secret string"});
    let result = serde_json::to_value(receipt(&data).unwrap()).unwrap();
    let encoded = result.to_string();
    for secret in [
        "never-return-token",
        "private task",
        "nested-secret",
        "nested-key",
        "raw secret string",
    ] {
        assert!(!encoded.contains(secret));
    }
    assert_eq!(result["name"], "test-agent");
    assert_eq!(result["error_code"], Value::Null);
    assert!(receipt(&json!({"id":"../leak","status":"completed"})).is_err());
    assert!(receipt(&json!({"id":"i1","status":"anything"})).is_err());
}
#[test]
fn target_projection_drops_delivery_credentials_and_fails_closed_on_bad_counts() {
    let data = json!({"id":"node_1","name":"test-desktop","live":true,"handlers_live":true,"active_agents":0,"reserved_agents":"unknown","max_agents":12,"capabilities":["spawn:codex","arbitrary",{"name":"spawn:claude"}],"delivery":{"token":"do-not-return"}});
    let result = target(&data).unwrap();
    assert!(result.stale);
    assert_eq!(result.capabilities, ["spawn:codex", "spawn:claude"]);
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("do-not-return"));
}

#[test]
fn release_replay_keeps_immutable_identity_after_the_local_agent_is_removed() {
    let folder = tempfile::tempdir().unwrap();
    let workspace = selected_workspace();
    let params = SpawnReleaseParams {
        caller_name: "test-caller".into(),
        node_id: "node_1".into(),
        node_name: "test-desktop".into(),
        name: "test-agent".into(),
        expected_agent_id: "agent_1".into(),
        idempotency_key: "release-test-20261015-0001".into(),
    };
    assert!(claims::release(folder.path(), &workspace, "caller_id", &params, false).is_err());
    claims::release(folder.path(), &workspace, "caller_id", &params, true).unwrap();
    claims::release(folder.path(), &workspace, "caller_id", &params, false).unwrap();
    let replacement = SpawnReleaseParams {
        expected_agent_id: "agent_2".into(),
        ..params.clone()
    };
    assert!(claims::release(folder.path(), &workspace, "caller_id", &replacement, true).is_err());
    assert!(claims::release(folder.path(), &workspace, "other_caller", &params, false).is_err());
    let other_workspace = Workspace {
        key: Secret::new("other-secret"),
        ..workspace
    };
    assert!(claims::release(folder.path(), &other_workspace, "caller_id", &params, false).is_err());
    for entry in std::fs::read_dir(folder.path().join("spawn-control-releases")).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        assert!(!text.contains("test-workspace-secret"));
        assert!(!text.contains("test-agent-secret"));
    }
}

#[tokio::test]
async fn targets_uses_only_the_fixed_sdk_route_and_projects_away_credentials() {
    use std::io::{Read, Write};
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        let mut request = [0; 4096];
        let count = stream.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..count]);
        assert!(request.starts_with("GET /v1/nodes?status=online&limit=100 "));
        let body = json!({"ok":true,"data":[{"id":"node_1","name":"test-desktop","live":true,"handlers_live":true,"active_agents":0,"max_agents":12,"capabilities":["spawn:codex"],"token":"remote-secret"}]}).to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    let http = sdk_gaps::http(&base, &Secret::new("local-test-credential")).unwrap();
    let result = targets(&http).await.unwrap();
    assert_eq!(result.targets.len(), 1);
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("remote-secret"));
    worker.join().unwrap();
}

#[test]
fn immutable_agent_identity_comes_only_from_one_exact_local_spawn_invocation() {
    let workspace = selected_workspace();
    let mut registration = registered();
    registration.spawn = Some(serde_json::from_value(json!({"nodeID":"node_local","nodeName":"test-desktop","invocationID":"invocation_1","harness":"claude"})).unwrap());
    let mut store = Store::default();
    store.registrations.push(registration.clone());
    // An upstream field that looks like an ID is never trusted or returned.
    let data = json!({"id":"invocation_1","status":"running","agent_id":"untrusted_remote_id","output":{"agent_id":"nested_untrusted_id"}});
    let projected = receipt(&data).unwrap();
    assert!(projected.agent_id.is_none());
    let bound = local_spawn_identity(projected, &store, &workspace).unwrap();
    assert_eq!(bound.agent_id.as_deref(), Some("agent_caller"));
    assert_eq!(bound.name.as_deref(), Some("test-caller"));
    assert_eq!(bound.node_id.as_deref(), Some("node_local"));
    let other_invocation = receipt(&json!({"id":"invocation_other","status":"running"})).unwrap();
    assert!(local_spawn_identity(other_invocation, &store, &workspace)
        .unwrap()
        .agent_id
        .is_none());
    let other_workspace = Workspace {
        key: Secret::new("another-workspace"),
        ..workspace.clone()
    };
    assert!(
        local_spawn_identity(receipt(&data).unwrap(), &store, &other_workspace)
            .unwrap()
            .agent_id
            .is_none()
    );
    // A worker that crashed or ended keeps its exact identity until it is
    // released: release needs the agent id status reports.
    store.registrations[0].archived_at = Some("2026-10-15T01:00:00Z".into());
    store.registrations[0].missing_since = Some("2026-10-15T01:00:00Z".into());
    assert_eq!(
        local_spawn_identity(receipt(&data).unwrap(), &store, &workspace)
            .unwrap()
            .agent_id
            .as_deref(),
        Some("agent_caller")
    );
    store.registrations[0].archived_at = None;
    store.registrations[0].missing_since = None;
    store.registrations.push(registration);
    assert!(local_spawn_identity(receipt(&data).unwrap(), &store, &workspace).is_err());
}

#[test]
fn legacy_reason_suffixes_and_structured_errors_return_only_allowlisted_codes() {
    let first = json!({"id":"inv_failed","status":"failed","error":"spawn_failed: provider detail carrying secret-do-not-return"});
    let result = receipt(&first).unwrap();
    assert_eq!(result.error_code.as_deref(), Some("spawn_failed"));
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("secret-do-not-return"));
    let structured = json!({"id":"inv_failed","status":"failed","error":"unrecognized provider reason","error_details":{"code":"spawn_harness_unavailable","message":"provider-token-must-not-return"}});
    let result = receipt(&structured).unwrap();
    assert_eq!(
        result.error_code.as_deref(),
        Some("spawn_harness_unavailable")
    );
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("provider-token-must-not-return"));
    assert_eq!(
        error_code(&json!({"error":"provider-secret","error_details":{"code":"secret_in_code"}})),
        None
    );
    assert_eq!(
        error_code(&json!({"error":"spawn_failed_secret: hidden"})),
        None
    );
    assert_eq!(
        error_code(&json!({"error":"release_failed: stopped"})).as_deref(),
        Some("release_failed")
    );
}

#[test]
fn a_crashed_worker_is_releasable_by_its_exact_saved_identity() {
    let workspace = selected_workspace();
    let mut worker = registered();
    worker.name = "test-worker".into();
    worker.agent_id = "agent_worker".into();
    worker.spawn = Some(serde_json::from_value(json!({"nodeID":"node_local","nodeName":"test-desktop","invocationID":"invocation_1","harness":"claude"})).unwrap());
    // The session check marked it missing after its process exited.
    worker.missing_since = Some("2026-10-15T01:00:00Z".into());
    let mut store = Store::default();
    store.registrations.push(worker);
    let params = |name: &str, agent: &str, node: &str| SpawnReleaseParams {
        caller_name: "test-caller".into(),
        node_id: node.into(),
        node_name: "test-desktop".into(),
        name: name.into(),
        expected_agent_id: agent.into(),
        idempotency_key: "release-test-20261015-0001".into(),
    };
    assert!(release_target(
        &store,
        &workspace,
        &params("test-worker", "agent_worker", "node_local")
    ));
    for wrong in [
        params("test-worker", "agent_other", "node_local"),
        params("test-other", "agent_worker", "node_local"),
        params("test-worker", "agent_worker", "node_remote"),
    ] {
        assert!(!release_target(&store, &workspace, &wrong));
    }
    let other_workspace = Workspace {
        key: Secret::new("another-workspace"),
        ..workspace
    };
    assert!(!release_target(
        &store,
        &other_workspace,
        &params("test-worker", "agent_worker", "node_local")
    ));
}

#[test]
fn capacity_refusals_keep_their_retry_codes() {
    for code in ["capacity_changed", "spawn_target_offline"] {
        assert_eq!(
            error_code(&json!({"error": format!("{code}: taken since the last heartbeat")}))
                .as_deref(),
            Some(code)
        );
        assert_eq!(
            error_code(&json!({"error":"refused","error_details":{"code": code}})).as_deref(),
            Some(code)
        );
    }
}
