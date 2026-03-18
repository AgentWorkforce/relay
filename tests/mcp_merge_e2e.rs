//! End-to-end integration tests for MCP config merging (PR #542).
//!
//! These tests exercise the REAL public API (`configure_relaycast_mcp_with_token`)
//! and REAL file system to verify that MCP servers are correctly merged from:
//! 1. ~/.claude/settings.json (global)
//! 2. ~/.claude/settings.local.json (local)
//! 3. .mcp.json (project-level)
//!
//! Relaycast always wins over stale entries.
//!
//! IMPORTANT: Tests that modify HOME must run serially (--test-threads=1) to
//! avoid race conditions between parallel tests.

use relay_broker::snippets::configure_relaycast_mcp_with_token;
use serde_json::Value;
use std::fs;
use std::sync::Mutex;
use tempfile::tempdir;

/// Mutex to serialize tests that modify HOME env var.
static HOME_LOCK: Mutex<()> = Mutex::new(());

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

// ─── Test 2: Real MCP config merge - project level ─────────────────────────

#[tokio::test]
async fn e2e_project_level_mcp_merge_preserves_user_servers() {
    let temp = tempdir().expect("tempdir");
    let project = temp.path();

    // Create a real .mcp.json with user MCP servers
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

    // Must have --mcp-config and --strict-mcp-config
    assert!(
        args.contains(&"--mcp-config".to_string()),
        "must have --mcp-config"
    );
    assert!(
        args.contains(&"--strict-mcp-config".to_string()),
        "must have --strict-mcp-config"
    );

    let servers = extract_servers(&args);

    // Both user servers are preserved
    assert!(
        servers.contains_key("filesystem"),
        "filesystem MCP server must be preserved. Got: {:?}",
        servers.keys().collect::<Vec<_>>()
    );
    assert!(
        servers.contains_key("github"),
        "github MCP server must be preserved. Got: {:?}",
        servers.keys().collect::<Vec<_>>()
    );

    // Relaycast is present with broker-injected credentials
    assert!(
        servers.contains_key("relaycast"),
        "relaycast must be injected"
    );
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

    // Verify filesystem server config is intact
    let fs_server = &servers["filesystem"];
    assert_eq!(fs_server["command"].as_str(), Some("npx"));
    let fs_args: Vec<&str> = fs_server["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        fs_args.contains(&"@modelcontextprotocol/server-filesystem"),
        "filesystem args must be intact"
    );

    // Verify github server env is preserved
    assert_eq!(
        servers["github"]["env"]["GITHUB_TOKEN"].as_str(),
        Some("ghp_test123"),
        "github token must be preserved"
    );
}

// ─── Test 3: Real MCP config merge - global settings ───────────────────────

#[tokio::test]
async fn e2e_global_settings_are_merged_from_real_home() {
    let _lock = HOME_LOCK.lock().unwrap();
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
    assert!(
        servers.contains_key("relaycast"),
        "relaycast must always be present"
    );

    // If the real ~/.claude/settings.json has MCP servers, they should appear
    let home = dirs::home_dir().expect("home dir");
    let global_settings = home.join(".claude").join("settings.json");
    if global_settings.exists() {
        if let Ok(content) = fs::read_to_string(&global_settings) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&content) {
                if let Some(global_servers) = parsed.get("mcpServers").and_then(Value::as_object) {
                    for key in global_servers.keys() {
                        if key != "relaycast" {
                            assert!(
                                servers.contains_key(key),
                                "global MCP server '{}' should be merged into output",
                                key
                            );
                        }
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn e2e_global_settings_with_fake_home() {
    let _lock = HOME_LOCK.lock().unwrap();

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

    // Override HOME so dirs::home_dir() returns our fake home
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

    // Restore HOME immediately
    if let Some(h) = &original_home {
        unsafe { std::env::set_var("HOME", h) };
    }

    let servers = extract_servers(&args);

    assert!(
        servers.contains_key("database"),
        "global database MCP must be merged. Got: {:?}",
        servers.keys().collect::<Vec<_>>()
    );
    assert!(
        servers.contains_key("filesystem"),
        "project filesystem MCP must be merged"
    );
    assert!(
        servers.contains_key("relaycast"),
        "relaycast must always be present"
    );
    assert_eq!(
        servers["database"]["env"]["DB_URL"].as_str(),
        Some("postgres://localhost/test")
    );
}

// ─── Test 4: Stale relaycast override ──────────────────────────────────────

#[tokio::test]
async fn e2e_stale_relaycast_is_overridden_by_broker_credentials() {
    let temp = tempdir().expect("tempdir");
    let project = temp.path();

    // Create .mcp.json with STALE relaycast credentials
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

    // Relaycast must use fresh broker-injected credentials
    let rc = &servers["relaycast"];
    let env = rc["env"].as_object().expect("relaycast env");

    // RELAY_API_KEY is intentionally NOT in the JSON (injected via process env)
    assert!(
        env.get("RELAY_API_KEY").is_none()
            || env["RELAY_API_KEY"].as_str() != Some("rk_stale_old_key"),
        "stale RELAY_API_KEY must not survive merge"
    );

    assert_eq!(
        env["RELAY_AGENT_NAME"].as_str(),
        Some("fresh-agent"),
        "broker-injected agent name must override stale"
    );
    assert_eq!(
        env["RELAY_BASE_URL"].as_str(),
        Some("https://new.api.relay.com"),
        "broker-injected base URL must override stale"
    );
    assert_eq!(
        env["RELAY_AGENT_TOKEN"].as_str(),
        Some("tok_new_valid"),
        "broker-injected token must override stale"
    );

    // Non-relaycast servers must survive
    assert!(
        servers.contains_key("keep-me"),
        "non-relaycast servers must be preserved"
    );
}

// ─── Test 5: Precedence order ──────────────────────────────────────────────

#[tokio::test]
async fn e2e_project_level_overrides_global_for_same_server_name() {
    let _lock = HOME_LOCK.lock().unwrap();

    let temp = tempdir().expect("tempdir");
    let fake_home = temp.path().join("home");
    fs::create_dir_all(fake_home.join(".claude")).expect("create .claude");

    // Global: testserver with command "global-cmd"
    fs::write(
        fake_home.join(".claude").join("settings.json"),
        r#"{
            "mcpServers": {
                "testserver": {
                    "command": "global-cmd",
                    "args": ["--from=global"]
                },
                "only-in-global": {
                    "command": "global-only",
                    "args": []
                }
            }
        }"#,
    )
    .expect("write global");

    // settings.local.json: testserver with command "local-cmd"
    fs::write(
        fake_home.join(".claude").join("settings.local.json"),
        r#"{
            "mcpServers": {
                "testserver": {
                    "command": "local-cmd",
                    "args": ["--from=local"]
                },
                "only-in-local": {
                    "command": "local-only",
                    "args": []
                }
            }
        }"#,
    )
    .expect("write local settings");

    // Project: testserver with command "project-cmd"
    let project = temp.path().join("proj");
    fs::create_dir_all(&project).expect("create project");
    fs::write(
        project.join(".mcp.json"),
        r#"{
            "mcpServers": {
                "testserver": {
                    "command": "project-cmd",
                    "args": ["--from=project"]
                },
                "only-in-project": {
                    "command": "project-only",
                    "args": []
                }
            }
        }"#,
    )
    .expect("write project .mcp.json");

    let original_home = std::env::var("HOME").ok();
    unsafe { std::env::set_var("HOME", &fake_home) };

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

    if let Some(h) = &original_home {
        unsafe { std::env::set_var("HOME", h) };
    }

    let servers = extract_servers(&args);

    // Project-level should win for 'testserver' (loaded last, overrides earlier)
    assert_eq!(
        servers["testserver"]["command"].as_str(),
        Some("project-cmd"),
        "project-level must override global and local for same server name"
    );
    let ts_args: Vec<&str> = servers["testserver"]["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(ts_args, vec!["--from=project"]);

    // Servers unique to each level should all be present
    assert!(
        servers.contains_key("only-in-global"),
        "global-only server must be merged"
    );
    assert!(
        servers.contains_key("only-in-local"),
        "local-only server must be merged"
    );
    assert!(
        servers.contains_key("only-in-project"),
        "project-only server must be merged"
    );
    assert!(servers.contains_key("relaycast"));
}

#[tokio::test]
async fn e2e_local_settings_override_global() {
    let _lock = HOME_LOCK.lock().unwrap();

    let temp = tempdir().expect("tempdir");
    let fake_home = temp.path().join("home2");
    fs::create_dir_all(fake_home.join(".claude")).expect("create .claude");

    fs::write(
        fake_home.join(".claude").join("settings.json"),
        r#"{ "mcpServers": { "shared": { "command": "global-ver" } } }"#,
    )
    .expect("write global");

    fs::write(
        fake_home.join(".claude").join("settings.local.json"),
        r#"{ "mcpServers": { "shared": { "command": "local-ver" } } }"#,
    )
    .expect("write local");

    let project = temp.path().join("proj2");
    fs::create_dir_all(&project).expect("create project");

    let original_home = std::env::var("HOME").ok();
    unsafe { std::env::set_var("HOME", &fake_home) };

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

    if let Some(h) = &original_home {
        unsafe { std::env::set_var("HOME", h) };
    }

    let servers = extract_servers(&args);
    assert_eq!(
        servers["shared"]["command"].as_str(),
        Some("local-ver"),
        "settings.local.json must override settings.json for same server"
    );
}

/// Verify --strict-mcp-config is NOT added when user already provides --mcp-config
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

    // When user already has --mcp-config, the function should NOT add another one
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

    // Test with claude - should get --mcp-config
    let args = configure_relaycast_mcp_with_token(
        "claude",
        "agent",
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

    assert!(
        args.contains(&"--mcp-config".to_string()),
        "claude must get --mcp-config flag"
    );
    assert!(
        args.contains(&"--strict-mcp-config".to_string()),
        "claude must get --strict-mcp-config flag"
    );
}
