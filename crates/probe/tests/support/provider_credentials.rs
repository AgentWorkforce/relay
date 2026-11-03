use super::*;

#[tokio::test]
async fn native_provider_uses_scoped_app_grant_and_disconnect_revokes_it() {
    let harness = Harness::start_with(|cloud, _| {
        cloud.state.lock().unwrap().relaycast_url = Some(cloud.site_url.clone());
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"new","flow":"device"}))
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    let report = client
        .ok("tools.select", json!({"tool_ids":["grok","hermes"]}))
        .await;
    assert!(report["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| matches!(p["id"].as_str(), Some("grok" | "hermes")))
        .all(|p| p["selected"] == true));
    let grants = harness.cloud.state.lock().unwrap().provider_grants.clone();
    assert_eq!(grants.len(), 2);
    let token = grants["grant-grok"]["accessToken"].as_str().unwrap();
    assert!(token.starts_with("cld_at_"));
    assert!(!report.to_string().contains(token));
    let config = std::fs::read_to_string(harness.home.join(".grok/config.toml")).unwrap();
    let parsed: toml_edit::DocumentMut = config.parse().unwrap();
    let token_path = parsed["mcp_servers"]["agent-relay"]["bearer_token_file"]
        .as_str()
        .unwrap();
    assert_eq!(std::fs::read_to_string(token_path).unwrap(), token);
    assert!(!config.contains(token));
    assert!(!config.contains("access-1"));
    assert!(!config.contains("refresh-"));
    client
        .ok("tools.manage", json!({"tool_id":"grok","action":"repair"}))
        .await;
    assert_eq!(
        harness.cloud.state.lock().unwrap().provider_grants["grant-grok"]["accessToken"],
        token
    );
    client
        .ok("tools.select", json!({"tool_ids":["hermes"]}))
        .await;
    assert!(!harness
        .cloud
        .state
        .lock()
        .unwrap()
        .provider_grants
        .contains_key("grant-grok"));
    assert!(
        !std::fs::read_to_string(harness.home.join(".grok/config.toml"))
            .unwrap()
            .contains(token)
    );
    client.ok("account.sign_out", json!({})).await;
    assert!(harness
        .cloud
        .state
        .lock()
        .unwrap()
        .provider_grants
        .is_empty());
    assert!(!harness
        .home
        .join("app-data/mcp-provider-credentials.json")
        .exists());
    harness.stop().await;
}

#[tokio::test]
async fn failed_provider_issuance_retries_same_saved_secret_without_exporting_app_token() {
    let harness = Harness::start_with(|cloud, _| {
        let mut state = cloud.state.lock().unwrap();
        state.relaycast_url = Some(cloud.site_url.clone());
        state.provider_grant_status = 503;
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"new","flow":"device"}))
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    client
        .ok("tools.select", json!({"tool_ids":["grok"]}))
        .await;
    assert!(!harness.home.join(".grok/config.toml").exists());
    let path = harness.home.join("app-data/mcp-provider-credentials.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let token = saved["grants"]["grok"]["token"].clone();
    harness.cloud.state.lock().unwrap().provider_grant_status = 200;
    client
        .ok("tools.manage", json!({"tool_id":"grok","action":"repair"}))
        .await;
    assert_eq!(
        harness.cloud.state.lock().unwrap().provider_grants["grant-grok"]["accessToken"],
        token
    );
    let config: toml_edit::DocumentMut =
        std::fs::read_to_string(harness.home.join(".grok/config.toml"))
            .unwrap()
            .parse()
            .unwrap();
    let token_path = config["mcp_servers"]["agent-relay"]["bearer_token_file"]
        .as_str()
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(token_path).unwrap(),
        token.as_str().unwrap()
    );
    harness.stop().await;
}

#[tokio::test]
async fn offline_disconnect_preserves_retry_material_and_reinstall_recovers() {
    let harness = Harness::start_with(|cloud, _| {
        cloud.state.lock().unwrap().relaycast_url = Some(cloud.site_url.clone());
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"new","flow":"device"}))
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    client
        .ok("tools.select", json!({"tool_ids":["grok"]}))
        .await;
    let original =
        harness.cloud.state.lock().unwrap().provider_grants["grant-grok"]["accessToken"].clone();
    harness.cloud.state.lock().unwrap().provider_grant_status = 503;
    client
        .ok(
            "tools.manage",
            json!({"tool_id":"grok","action":"uninstall"}),
        )
        .await;
    let path = harness.home.join("app-data/mcp-provider-credentials.json");
    let pending: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(pending["grants"]["grok"]["token"], original);
    assert!(
        !std::fs::read_to_string(harness.home.join(".grok/config.toml"))
            .unwrap()
            .contains(original.as_str().unwrap())
    );
    harness.cloud.state.lock().unwrap().provider_grant_status = 200;
    client
        .ok("tools.manage", json!({"tool_id":"grok","action":"install"}))
        .await;
    assert_eq!(
        harness.cloud.state.lock().unwrap().provider_grants["grant-grok"]["accessToken"],
        original
    );
    // Simulate a crash after successful issuance but before persisting its ID.
    // Removal must recover the same server grant before deleting it.
    let mut lost_reply: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    lost_reply["grants"]["grok"]["id"] = Value::Null;
    std::fs::write(&path, serde_json::to_vec(&lost_reply).unwrap()).unwrap();
    client
        .ok(
            "tools.manage",
            json!({"tool_id":"grok","action":"uninstall"}),
        )
        .await;
    assert!(harness
        .cloud
        .state
        .lock()
        .unwrap()
        .provider_grants
        .is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn older_hosted_server_never_receives_provider_credential_issuance() {
    let harness = Harness::start_with(|cloud, _| {
        let mut state = cloud.state.lock().unwrap();
        state.relaycast_url = Some(cloud.site_url.clone());
        state.mcp_native_identity = false;
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"new","flow":"device"}))
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    client
        .ok("tools.select", json!({"tool_ids":["grok"]}))
        .await;
    assert!(harness
        .cloud
        .requests(&format!(
            "/cloud/api/v1/workspaces/{WORKSPACE}/mcp/shared-sessions-tokens"
        ))
        .is_empty());
    assert!(!harness.home.join(".grok/config.toml").exists());
    harness.stop().await;
}

#[tokio::test]
async fn legacy_app_login_gets_an_app_signin_action_not_a_per_provider_login() {
    let harness = Harness::start_with(|cloud, _| {
        let mut state = cloud.state.lock().unwrap();
        state.relaycast_url = Some(cloud.site_url.clone());
        state.provider_grant_status = 403;
    })
    .await;
    let mut client = harness.client().await;
    client
        .ok("account.sign_in", json!({"sharing":"new","flow":"device"}))
        .await;
    eventually("signed in", || harness.account_state() == "signed_in").await;
    let report = client
        .ok("tools.select", json!({"tool_ids":["grok"]}))
        .await;
    let grok = report["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "grok")
        .unwrap();
    assert_eq!(grok["state"], "signed_out");
    assert!(grok["detail"]
        .as_str()
        .unwrap()
        .contains("Sign in to Agent Relay again"));
    assert!(!harness.home.join(".grok/config.toml").exists());
    harness.cloud.state.lock().unwrap().provider_grant_status = 200;
    let report = client
        .ok("tools.manage", json!({"tool_id":"grok","action":"repair"}))
        .await;
    let grok = report["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "grok")
        .unwrap();
    assert_eq!(grok["state"], "installed");
    harness.stop().await;
}
