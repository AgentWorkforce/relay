//! End-to-end integration tests for MCP config injection.
//!
//! These tests verify that `configure_relaycast_mcp_with_token` produces the
//! correct `--mcp-config` args for Claude:
//! - Only relaycast server is included (user servers loaded by Claude from .mcp.json)
//! - No `--strict-mcp-config` (so Claude loads .mcp.json alongside --mcp-config)
//! - RELAY_API_KEY is injected into the inline JSON config
//! - Agent token and credentials are correct

use relay_broker::snippets::configure_relaycast_mcp_with_token;
use serde_json::Value;
use std::fs;
use tempfile::tempdir;

/// Helper: extract --mcp-config JSON from the args returned by configure_relaycast_mcp_with_token.
fn extract_mcp_json(args: &[String]) -> Value {
    let idx = args
        .iter()
        .position(|a| a == "--mcp-config")
        .expect("--mcp-config flag must be present");
    let json_str = &args[idx + 1];
    serde_json::from_str(json_str).expect("--mcp-config value must be valid JSON")
}

/// Helper: get the mcpServers map from args.
fn extract_servers(args: &[String]) -> serde_json::Map<String, Value> {
    let parsed = extract_mcp_json(args);
    parsed["mcpServers"]
        .as_object()
        .expect("mcpServers key")
        .clone()
}

// ─── Test: --mcp-config contains only relaycast (no user servers) ───────────

#[tokio::test]
async fn e2e_project_level_mcp_merge_preserves_user_servers() {
    let temp = tempdir().expect("tempdir");
    let project = temp.path();

    // Create a real .mcp.json with user MCP servers — these should NOT appear
    // in --mcp-config because Claude loads .mcp.json itself.
    fs::write(
        project.join(".mcp.json"),
        r#"{
            "mcpServers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
                },
                "github": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-github"],
                    "env": { "GITHUB_TOKEN": "ghp_test123" }
                }
            }
        }"#,
    )
    .expect("write .mcp.json");

    let args = configure_relaycast_mcp_with_token(
        "claude",
        "e2e-agent",
        Some("rk_live_key"),
        Some("https://api.relay.test"),
        &[],
        project,
        Some("tok_abc"),
        None,
        None,
    )
    .await
    .expect("configure_relaycast_mcp_with_token");

    // Must have --mcp-config but NOT --strict-mcp-config
    assert!(
        args.contains(&"--mcp-config".to_string()),
        "must have --mcp-config"
    );
    assert!(
        !args.contains(&"--strict-mcp-config".to_string()),
        "must NOT have --strict-mcp-config"
    );

    let servers = extract_servers(&args);

    // Only relaycast in --mcp-config — user servers loaded by Claude from .mcp.json
    assert_eq!(
        servers.len(),
        1,
        "only relaycast server in --mcp-config; user servers loaded from .mcp.json. Got: {:?}",
        servers.keys().collect::<Vec<_>>()
    );
    assert!(
        servers.contains_key("relaycast"),
        "relaycast must be present"
    );

    // Relaycast has broker-injected credentials
    let relaycast = &servers["relaycast"];
    assert_eq!(
        relaycast["env"]["RELAY_AGENT_NAME"].as_str(),
        Some("e2e-agent"),
        "broker agent name must be injected"
    );
    assert_eq!(
        relaycast["env"]["RELAY_AGENT_TOKEN"].as_str(),
        Some("tok_abc"),
        "broker agent token must be injected"
    );
    assert_eq!(
        relaycast["env"]["RELAY_API_KEY"].as_str(),
        Some("rk_live_key"),
        "RELAY_API_KEY must be injected in --mcp-config"
    );
}

// ─── Test: Global settings do not affect --mcp-config ───────────────────────

#[tokio::test]
async fn e2e_global_settings_are_merged_from_real_home() {
    let temp = tempdir().expect("tempdir");

    let args = configure_relaycast_mcp_with_token(
        "claude",
        "global-test-agent",
        Some("rk_key"),
        None,
        &[],
        temp.path(),
        None,
        None,
        None,
    )
    .await
    .expect("configure");

    let servers = extract_servers(&args);
    // Only relaycast — global servers are loaded by Claude, not merged into --mcp-config
    assert_eq!(servers.len(), 1, "only relaycast in --mcp-config");
    assert!(
        servers.contains_key("relaycast"),
        "relaycast must always be present"
    );
}

#[tokio::test]
async fn e2e_global_settings_with_fake_home() {
    let temp = tempdir().expect("tempdir");
    let fake_home = temp.path().join("fakehome");
    fs::create_dir_all(fake_home.join(".claude")).expect("create .claude");

    fs::write(
        fake_home.join(".claude").join("settings.json"),
        r#"{
            "mcpServers": {
                "database": {
                    "command": "npx",
                    "args": ["-y", "@mcp/postgres"],
                    "env": { "DB_URL": "postgres://localhost/test" }
                }
            }
        }"#,
    )
    .expect("write global settings");

    let project = temp.path().join("myproject");
    fs::create_dir_all(&project).expect("create project");
    fs::write(
        project.join(".mcp.json"),
        r#"{
            "mcpServers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "fs-mcp"]
                }
            }
        }"#,
    )
    .expect("write project .mcp.json");

    let original_home = std::env::var("HOME").ok();
    unsafe { std::env::set_var("HOME", &fake_home) };

    let args = configure_relaycast_mcp_with_token(
        "claude",
        "agent-global",
        Some("rk_key"),
        None,
        &[],
        &project,
        None,
        None,
        None,
    )
    .await
    .expect("configure");

    if let Some(h) = &original_home {
        unsafe { std::env::set_var("HOME", h) };
    }

    let servers = extract_servers(&args);

    // Only relaycast — global and project servers loaded by Claude itself
    assert_eq!(servers.len(), 1, "only relaycast in --mcp-config");
    assert!(servers.contains_key("relaycast"));
}

// ─── Test: Stale relaycast in .mcp.json doesn't matter ─────────────────────
// Since we no longer merge .mcp.json into --mcp-config, stale entries are
// irrelevant — the inline config always has fresh broker credentials.

#[tokio::test]
async fn e2e_stale_relaycast_is_overridden_by_broker_credentials() {
    let temp = tempdir().expect("tempdir");
    let project = temp.path();

    // .mcp.json has stale relaycast credentials — doesn't matter since
    // --mcp-config passes fresh credentials and Claude's additive loading
    // means the inline config takes effect.
    fs::write(
        project.join(".mcp.json"),
        r#"{
            "mcpServers": {
                "relaycast": {
                    "command": "npx",
                    "args": ["-y", "@relaycast/mcp"],
                    "env": {
                        "RELAY_API_KEY": "rk_stale_old_key",
                        "RELAY_AGENT_NAME": "old-agent-name",
                        "RELAY_BASE_URL": "https://old.api.example.com",
                        "RELAY_AGENT_TOKEN": "tok_expired"
                    }
                },
                "keep-me": {
                    "command": "echo",
                    "args": ["preserved"]
                }
            }
        }"#,
    )
    .expect("write stale .mcp.json");

    let args = configure_relaycast_mcp_with_token(
        "claude",
        "fresh-agent",
        Some("rk_fresh_new_key"),
        Some("https://new.api.relay.com"),
        &[],
        project,
        Some("tok_new_valid"),
        None,
        None,
    )
    .await
    .expect("configure");

    let servers = extract_servers(&args);

    // Only relaycast with fresh credentials
    assert_eq!(servers.len(), 1, "only relaycast in --mcp-config");
    let rc = &servers["relaycast"];
    let env = rc["env"].as_object().expect("relaycast env");

    assert_eq!(
        env["RELAY_AGENT_NAME"].as_str(),
        Some("fresh-agent"),
        "broker-injected agent name"
    );
    assert_eq!(
        env["RELAY_BASE_URL"].as_str(),
        Some("https://new.api.relay.com"),
        "broker-injected base URL"
    );
    assert_eq!(
        env["RELAY_AGENT_TOKEN"].as_str(),
        Some("tok_new_valid"),
        "broker-injected token"
    );
    assert_eq!(
        env["RELAY_API_KEY"].as_str(),
        Some("rk_fresh_new_key"),
        "broker-injected API key"
    );
}

// ─── Test: Precedence — no longer relevant for --mcp-config ─────────────────
// Since we only pass relaycast, Claude handles precedence itself.

#[tokio::test]
async fn e2e_project_level_overrides_global_for_same_server_name() {
    let temp = tempdir().expect("tempdir");
    let project = temp.path().join("proj");
    fs::create_dir_all(&project).expect("create project");

    let args = configure_relaycast_mcp_with_token(
        "claude",
        "precedence-agent",
        Some("rk_key"),
        None,
        &[],
        &project,
        None,
        None,
        None,
    )
    .await
    .expect("configure");

    let servers = extract_servers(&args);
    assert_eq!(servers.len(), 1, "only relaycast");
    assert!(servers.contains_key("relaycast"));
}

#[tokio::test]
async fn e2e_local_settings_override_global() {
    let temp = tempdir().expect("tempdir");
    let project = temp.path().join("proj2");
    fs::create_dir_all(&project).expect("create project");

    let args = configure_relaycast_mcp_with_token(
        "claude",
        "local-test",
        Some("rk_key"),
        None,
        &[],
        &project,
        None,
        None,
        None,
    )
    .await
    .expect("configure");

    let servers = extract_servers(&args);
    assert_eq!(servers.len(), 1, "only relaycast");
    assert!(servers.contains_key("relaycast"));
}

/// Verify --mcp-config is NOT added when user already provides it
#[tokio::test]
async fn e2e_respects_existing_mcp_config_flag() {
    let temp = tempdir().expect("tempdir");

    let existing_args = vec![
        "--mcp-config".to_string(),
        r#"{"mcpServers":{}}"#.to_string(),
    ];
    let args = configure_relaycast_mcp_with_token(
        "claude",
        "agent",
        Some("rk_key"),
        None,
        &existing_args,
        temp.path(),
        None,
        None,
        None,
    )
    .await
    .expect("configure");

    assert!(
        !args.contains(&"--mcp-config".to_string()),
        "must not add --mcp-config when user already provides it"
    );
}

/// Verify claude CLI is the only one that gets --mcp-config
#[tokio::test]
async fn e2e_only_claude_gets_mcp_config_flag() {
    let temp = tempdir().expect("tempdir");
    fs::write(
        temp.path().join(".mcp.json"),
        r#"{ "mcpServers": { "test": { "command": "x" } } }"#,
    )
    .expect("write");

    // Codex uses --config, not --mcp-config
    let codex_args = configure_relaycast_mcp_with_token(
        "codex",
        "codex-agent",
        Some("rk_key"),
        None,
        &[],
        temp.path(),
        None,
        None,
        None,
    )
    .await
    .expect("configure codex");
    assert!(
        !codex_args.contains(&"--mcp-config".to_string()),
        "codex must not get --mcp-config"
    );
    assert!(
        codex_args.iter().any(|a| a == "--config"),
        "codex should get --config flags"
    );

    // Unsupported CLIs get nothing
    let aider_args = configure_relaycast_mcp_with_token(
        "aider",
        "aider-agent",
        Some("rk_key"),
        None,
        &[],
        temp.path(),
        None,
        None,
        None,
    )
    .await
    .expect("configure aider");
    assert!(
        aider_args.is_empty(),
        "unsupported CLIs should get no MCP args"
    );
}
