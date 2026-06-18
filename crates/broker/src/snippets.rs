use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use tokio::process::Command;

use crate::types::AgentResultMcpConfig;

const AGENT_RELAY_MCP_PACKAGE: &str = "agent-relay";
const AGENT_RELAY_MCP_SUBCOMMAND: &str = "mcp";

const MCP_FILE: &str = ".mcp.json";
const AGENT_RELAY_MCP_SERVER: &str = "agent-relay";
const LEGACY_RELAYCAST_SERVER: &str = "relaycast";

fn is_agent_relay_mcp_server_name(name: &str) -> bool {
    name == AGENT_RELAY_MCP_SERVER || name == LEGACY_RELAYCAST_SERVER
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentRelayMcpCommand {
    command: String,
    args: Vec<String>,
}

fn parse_agent_relay_mcp_command(custom_cmd: Option<&str>) -> AgentRelayMcpCommand {
    if let Some(custom_cmd) = custom_cmd {
        let parts: Vec<String> = custom_cmd
            .split_whitespace()
            .map(ToString::to_string)
            .collect();
        if let Some((command, args)) = parts.split_first() {
            return AgentRelayMcpCommand {
                command: command.clone(),
                args: args.to_vec(),
            };
        }
    }

    AgentRelayMcpCommand {
        command: "npx".to_string(),
        args: vec![
            "-y".to_string(),
            AGENT_RELAY_MCP_PACKAGE.to_string(),
            AGENT_RELAY_MCP_SUBCOMMAND.to_string(),
        ],
    }
}

fn agent_relay_mcp_command() -> AgentRelayMcpCommand {
    // Allow overriding the Agent Relay MCP command for local development/testing.
    // e.g. AGENT_RELAY_MCP_COMMAND="node /path/to/agent-relay/dist/cli/agent-relay-mcp.js"
    let custom_cmd = std::env::var("AGENT_RELAY_MCP_COMMAND").ok();
    parse_agent_relay_mcp_command(custom_cmd.as_deref())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct McpInstallReport {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
}

pub fn ensure_agent_relay_mcp_config(
    root: &Path,
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
) -> io::Result<McpInstallReport> {
    let mut report = McpInstallReport::default();
    let path = root.join(MCP_FILE);
    let agent_relay_server = agent_relay_mcp_server_config(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        None,
        None,
        None,
        None,
    );

    if !path.exists() {
        let mut servers = Map::new();
        servers.insert(AGENT_RELAY_MCP_SERVER.to_string(), agent_relay_server);
        let mut top = Map::new();
        top.insert("mcpServers".to_string(), Value::Object(servers));
        write_pretty_json(&path, &Value::Object(top))?;
        report.created = 1;
        return Ok(report);
    }

    let existing = fs::read_to_string(&path)?;
    let mut parsed: Value = serde_json::from_str(&existing).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to parse {}: {error}", path.display()),
        )
    })?;

    let top = parsed.as_object_mut().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} must contain a top-level JSON object", path.display()),
        )
    })?;

    let servers = top
        .entry("mcpServers".to_string())
        .or_insert_with(|| Value::Object(Map::new()));

    let servers_obj = servers.as_object_mut().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} field mcpServers must be an object", path.display()),
        )
    })?;

    servers_obj.remove(LEGACY_RELAYCAST_SERVER);
    servers_obj.insert(AGENT_RELAY_MCP_SERVER.to_string(), agent_relay_server);
    write_pretty_json(&path, &parsed)?;
    report.updated = 1;
    Ok(report)
}

/// Build the full MCP config JSON string for the Agent Relay MCP server.
/// Suitable for passing to `--mcp-config` CLI flags.
pub fn agent_relay_mcp_config_json(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
) -> String {
    agent_relay_mcp_config_json_with_token(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        None,
        None,
        None,
    )
}

pub fn agent_relay_mcp_config_json_with_token(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
) -> String {
    agent_relay_mcp_config_json_with_result(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        relay_agent_token,
        workspaces_json,
        default_workspace,
        None,
    )
}

pub fn agent_relay_mcp_config_json_with_result(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    agent_result: Option<&AgentResultMcpConfig>,
) -> String {
    let server = agent_relay_mcp_server_config(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        relay_agent_token,
        workspaces_json,
        default_workspace,
        agent_result,
    );
    let mut servers = Map::new();
    servers.insert(AGENT_RELAY_MCP_SERVER.to_string(), server);
    let mut top = Map::new();
    top.insert("mcpServers".to_string(), Value::Object(servers));
    serde_json::to_string(&Value::Object(top)).expect("MCP config serialization cannot fail")
}

/// Merge the broker's Agent Relay MCP config with the user's MCP servers from all
/// Claude config sources:
///   1. `~/.claude/settings.json`       (global user settings)
///   2. `~/.claude/settings.local.json`  (local user settings, gitignored)
///   3. `.mcp.json`                      (project-level)
///
/// Later sources override earlier ones (matching Claude's own precedence).
/// The Agent Relay entry always wins (prevents stale entries from overriding broker creds).
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
fn merge_agent_relay_with_project_mcp(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
    cwd: &Path,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    agent_result: Option<&AgentResultMcpConfig>,
) -> String {
    merge_agent_relay_with_project_mcp_inner(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        relay_agent_token,
        cwd,
        dirs::home_dir(),
        workspaces_json,
        default_workspace,
        agent_result,
    )
}

/// Inner implementation that accepts an explicit home directory for testability.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
fn merge_agent_relay_with_project_mcp_inner(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
    cwd: &Path,
    home: Option<PathBuf>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    agent_result: Option<&AgentResultMcpConfig>,
) -> String {
    let agent_relay_server = agent_relay_mcp_server_config(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        relay_agent_token,
        workspaces_json,
        default_workspace,
        agent_result,
    );

    let mut servers = Map::new();

    // Collect MCP config paths in precedence order (lowest first).
    // Later entries override earlier ones, matching Claude's own loading order:
    //   1. ~/.claude/settings.json        (user-global)
    //   2. ~/.claude/settings.local.json  (user-global local)
    //   3. <cwd>/.mcp.json                (project legacy)
    //   4. <cwd>/.claude/settings.json    (project)
    //   5. <cwd>/.claude/settings.local.json (project local)
    let mut config_paths: Vec<std::path::PathBuf> = Vec::new();
    if let Some(home) = home {
        config_paths.push(home.join(".claude").join("settings.json"));
        config_paths.push(home.join(".claude").join("settings.local.json"));
    }
    config_paths.push(cwd.join(MCP_FILE));
    config_paths.push(cwd.join(".claude").join("settings.json"));
    config_paths.push(cwd.join(".claude").join("settings.local.json"));

    for path in &config_paths {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&content) {
                if let Some(existing_servers) = parsed.get("mcpServers").and_then(Value::as_object)
                {
                    for (name, config) in existing_servers {
                        if !is_agent_relay_mcp_server_name(name) {
                            servers.insert(name.clone(), config.clone());
                        }
                    }
                }
            }
        }
    }

    // Insert Agent Relay with broker-injected credentials (always wins).
    servers.insert(AGENT_RELAY_MCP_SERVER.to_string(), agent_relay_server);

    let mut top = Map::new();
    top.insert("mcpServers".to_string(), Value::Object(servers));
    serde_json::to_string(&Value::Object(top)).expect("MCP config serialization cannot fail")
}

fn agent_relay_mcp_server_config(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    agent_result: Option<&AgentResultMcpConfig>,
) -> Value {
    let mut server = Map::new();
    let mcp_command = agent_relay_mcp_command();
    server.insert("command".into(), Value::String(mcp_command.command));
    server.insert(
        "args".into(),
        Value::Array(mcp_command.args.into_iter().map(Value::String).collect()),
    );

    let mut env = Map::new();
    // NOTE: RELAY_API_KEY is intentionally omitted from .mcp.json — the broker
    // injects it directly into the child process environment. Some CLI tools
    // (e.g. codex) strip API keys from .mcp.json env vars, so env injection
    // is the only reliable path.
    let _ = relay_api_key; // suppress unused warning
    if let Some(base_url) = relay_base_url.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_BASE_URL".into(), Value::String(base_url.to_string()));
    }
    if let Some(name) = relay_agent_name.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_AGENT_NAME".into(), Value::String(name.to_string()));
        env.insert(
            "RELAY_AGENT_TYPE".into(),
            Value::String("agent".to_string()),
        );
        env.insert(
            "RELAY_STRICT_AGENT_NAME".into(),
            Value::String("1".to_string()),
        );
    }
    if let Some(token) = relay_agent_token.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_AGENT_TOKEN".into(), Value::String(token.to_string()));
        // Skip bootstrap when the broker has already pre-registered the agent —
        // prevents blocking HTTP calls during MCP initialize handshake.
        env.insert(
            "RELAY_SKIP_BOOTSTRAP".into(),
            Value::String("1".to_string()),
        );
    }
    // Forward multi-workspace context so spawned child agents can connect to
    // the correct workspaces via their MCP configuration.
    if let Some(wj) = workspaces_json.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert(
            "RELAY_WORKSPACES_JSON".into(),
            Value::String(wj.to_string()),
        );
    }
    if let Some(dw) = default_workspace.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert(
            "RELAY_DEFAULT_WORKSPACE".into(),
            Value::String(dw.to_string()),
        );
    }
    apply_agent_result_env(&mut env, agent_result);
    if !env.is_empty() {
        server.insert("env".into(), Value::Object(env));
    }

    Value::Object(server)
}

fn apply_agent_result_env(
    env: &mut Map<String, Value>,
    agent_result: Option<&AgentResultMcpConfig>,
) {
    if let Some(config) = agent_result {
        for (key, value) in config.env_pairs() {
            env.insert(key.into(), Value::String(value));
        }
    }
}

fn escape_toml_basic_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn toml_basic_string(value: &str) -> String {
    format!("\"{}\"", escape_toml_basic_string(value))
}

fn toml_basic_string_array(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| toml_basic_string(value))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn push_codex_mcp_command_config_args(args: &mut Vec<String>, mcp_command: &AgentRelayMcpCommand) {
    args.extend([
        "--config".to_string(),
        format!(
            "mcp_servers.agent-relay.command={}",
            toml_basic_string(&mcp_command.command)
        ),
        "--config".to_string(),
        format!(
            "mcp_servers.agent-relay.args={}",
            toml_basic_string_array(&mcp_command.args)
        ),
    ]);
}

/// Inject RELAY_API_KEY into the Agent Relay server's env block within a merged
/// MCP config JSON string.  The shared `agent_relay_mcp_server_config()` omits it
/// (codex strips API keys from .mcp.json env), but for Claude's inline
/// `--mcp-config` arg this is safe and necessary — Claude Code does not
/// reliably inherit parent process env vars into MCP server subprocesses.
fn inject_api_key_into_mcp_json(mcp_json: &str, api_key: Option<&str>) -> String {
    let api_key = match api_key.map(str::trim).filter(|s| !s.is_empty()) {
        Some(key) => key,
        None => return mcp_json.to_string(),
    };
    let mut parsed: Value = match serde_json::from_str(mcp_json) {
        Ok(v) => v,
        Err(_) => return mcp_json.to_string(),
    };
    if let Some(env_obj) = parsed
        .pointer_mut("/mcpServers/agent-relay/env")
        .and_then(Value::as_object_mut)
    {
        env_obj.insert("RELAY_API_KEY".into(), Value::String(api_key.to_string()));
    } else if let Some(server) = parsed
        .pointer_mut("/mcpServers/agent-relay")
        .and_then(Value::as_object_mut)
    {
        let mut env_map = Map::new();
        env_map.insert("RELAY_API_KEY".into(), Value::String(api_key.to_string()));
        server.insert("env".into(), Value::Object(env_map));
    }
    serde_json::to_string(&parsed).unwrap_or_else(|_| mcp_json.to_string())
}

const OPENCODE_CONFIG: &str = "opencode.json";
const OPENCODE_AGENT_NAME: &str = AGENT_RELAY_MCP_SERVER;
// Key name taken from https://opencode.ai/config.json §permission.
// Update here (and the unit tests) if opencode renames this field.
const OPENCODE_PERMISSION_KEY: &str = "permission";

/// Ensure an `opencode.json` config exists with the Agent Relay MCP server and
/// a custom `agent-relay` agent that has those tools enabled.
/// Returns `true` if the config was created or updated.
pub fn ensure_opencode_config(
    root: &Path,
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
) -> io::Result<bool> {
    ensure_opencode_config_with_result(
        root,
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        relay_agent_token,
        workspaces_json,
        default_workspace,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn ensure_opencode_config_with_result(
    root: &Path,
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    _agent_result: Option<&AgentResultMcpConfig>,
) -> io::Result<bool> {
    let path = root.join(OPENCODE_CONFIG);

    // Build the Agent Relay MCP entry in opencode format.
    let mut mcp_server = Map::new();
    mcp_server.insert("type".into(), Value::String("local".into()));
    mcp_server.insert(
        "command".into(),
        Value::Array(vec![
            Value::String("npx".into()),
            Value::String("-y".into()),
            Value::String(AGENT_RELAY_MCP_PACKAGE.into()),
            Value::String(AGENT_RELAY_MCP_SUBCOMMAND.into()),
        ]),
    );
    let mut env = Map::new();
    if let Some(v) = relay_api_key.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_API_KEY".into(), Value::String(v.to_string()));
    }
    if let Some(v) = relay_base_url.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_BASE_URL".into(), Value::String(v.to_string()));
    }
    if let Some(v) = relay_agent_name.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_AGENT_NAME".into(), Value::String(v.to_string()));
        env.insert(
            "RELAY_AGENT_TYPE".into(),
            Value::String("agent".to_string()),
        );
        env.insert(
            "RELAY_STRICT_AGENT_NAME".into(),
            Value::String("1".to_string()),
        );
    }
    if let Some(v) = relay_agent_token.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_AGENT_TOKEN".into(), Value::String(v.to_string()));
        // Skip bootstrap when the broker has already pre-registered the agent —
        // prevents blocking HTTP calls during MCP initialize handshake.
        env.insert(
            "RELAY_SKIP_BOOTSTRAP".into(),
            Value::String("1".to_string()),
        );
    }
    // Forward multi-workspace context to opencode child agents.
    if let Some(wj) = workspaces_json.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert(
            "RELAY_WORKSPACES_JSON".into(),
            Value::String(wj.to_string()),
        );
    }
    if let Some(dw) = default_workspace.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert(
            "RELAY_DEFAULT_WORKSPACE".into(),
            Value::String(dw.to_string()),
        );
    }
    if !env.is_empty() {
        mcp_server.insert("environment".into(), Value::Object(env));
    }

    // Build the custom agent entry.
    let mut agent = Map::new();
    agent.insert(
        "description".into(),
        Value::String("Agent with Agent Relay MCP enabled".into()),
    );
    let mut tools = Map::new();
    tools.insert("agent-relay_*".into(), Value::Bool(true));
    agent.insert("tools".into(), Value::Object(tools));

    // Build the wildcard permission block that suppresses all interactive
    // approval prompts. opencode.json in the repo takes priority over the
    // global config, so writing this here is the reliable way to bypass them.
    let permission_block = json!({ "*": { "*": "allow" } });

    // Atomically claim the file to avoid the TOCTOU between a separate
    // exists()-check and a subsequent write. If another process created the
    // file between our check and this open, AlreadyExists is returned and we
    // fall through to the merge path below instead of silently overwriting.
    let file_is_new = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => true,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(e),
    };

    if file_is_new {
        let mut top = Map::new();
        let mut mcp = Map::new();
        mcp.insert(OPENCODE_AGENT_NAME.into(), Value::Object(mcp_server));
        top.insert("mcp".into(), Value::Object(mcp));
        let mut agents = Map::new();
        agents.insert(OPENCODE_AGENT_NAME.into(), Value::Object(agent));
        top.insert("agent".into(), Value::Object(agents));
        top.insert(OPENCODE_PERMISSION_KEY.into(), permission_block.clone());
        write_pretty_json(&path, &Value::Object(top))?;
        return Ok(true);
    }

    let existing = fs::read_to_string(&path)?;
    let mut parsed: Value = serde_json::from_str(&existing).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("failed to parse {}: {e}", path.display()),
        )
    })?;

    let top = parsed.as_object_mut().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "opencode.json must be an object",
        )
    })?;

    let mut changed = false;

    // Upsert mcp.agent-relay — also replace any non-object value (e.g. null)
    // that would cause as_object_mut() to silently return None.
    let mcp_entry = top
        .entry("mcp")
        .or_insert_with(|| Value::Object(Map::new()));
    if !mcp_entry.is_object() {
        *mcp_entry = Value::Object(Map::new());
    }
    if let Some(mcp_obj) = mcp_entry.as_object_mut() {
        mcp_obj.remove(LEGACY_RELAYCAST_SERVER);
        mcp_obj.insert(OPENCODE_AGENT_NAME.into(), Value::Object(mcp_server));
        changed = true;
    }

    // Upsert agent.agent-relay — same non-object guard.
    let agents_entry = top
        .entry("agent")
        .or_insert_with(|| Value::Object(Map::new()));
    if !agents_entry.is_object() {
        *agents_entry = Value::Object(Map::new());
    }
    if let Some(agents_obj) = agents_entry.as_object_mut() {
        if agents_obj.remove(LEGACY_RELAYCAST_SERVER).is_some() {
            changed = true;
        }
        if !agents_obj.contains_key(OPENCODE_AGENT_NAME) {
            agents_obj.insert(OPENCODE_AGENT_NAME.into(), Value::Object(agent));
            changed = true;
        }
    }

    // Ensure the wildcard permission block is present.
    // - Missing or non-object value (null, string, …) → replace with the full wildcard block.
    // - Existing object that lacks a "*" catch-all → inject the wildcard entry inside it so
    //   tool categories not covered by custom rules are also auto-approved.
    // - Existing object already containing "*" → leave it alone (user controls their config).
    match top.get(OPENCODE_PERMISSION_KEY) {
        Some(Value::Object(_)) => {
            if let Some(Value::Object(perm_obj)) = top.get_mut(OPENCODE_PERMISSION_KEY) {
                if !perm_obj.contains_key("*") {
                    perm_obj.insert("*".into(), json!({ "*": "allow" }));
                    changed = true;
                }
            }
        }
        _ => {
            // Missing, null, or non-object — replace entirely.
            top.insert(OPENCODE_PERMISSION_KEY.into(), permission_block);
            changed = true;
        }
    }

    if changed {
        write_pretty_json(&path, &parsed)?;
    }
    Ok(changed)
}

/// Configure the Agent Relay MCP server for any supported CLI tool.
///
/// Returns extra CLI arguments to append when spawning the agent.
/// For Gemini/Droid this runs a pre-spawn `mcp add` command (removing first
/// for idempotency). For Opencode this writes `opencode.json` on disk.
///
/// # Parameters
/// Write `.cursor/mcp.json` in the given directory with the Agent Relay MCP server
/// configured with per-agent credentials (name + token).
/// Returns `true` if the config was created or updated.
#[allow(clippy::too_many_arguments)]
pub fn ensure_cursor_mcp_config(
    root: &Path,
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    _agent_result: Option<&AgentResultMcpConfig>,
) -> io::Result<bool> {
    let cursor_dir = root.join(".cursor");
    fs::create_dir_all(&cursor_dir)?;
    let path = cursor_dir.join("mcp.json");

    let mcp_json = agent_relay_mcp_config_json_with_result(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        relay_agent_token,
        workspaces_json,
        default_workspace,
        None,
    );
    let mut new_value: Value = serde_json::from_str(&mcp_json).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("MCP config serialization error: {e}"),
        )
    })?;
    // Cursor does not pass parent process env vars to MCP server subprocesses,
    // so RELAY_API_KEY must be in the .cursor/mcp.json env block explicitly.
    // (The shared agent_relay_mcp_server_config omits it because codex strips API keys.)
    if let Some(key) = relay_api_key.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(env_obj) = new_value
            .pointer_mut("/mcpServers/agent-relay/env")
            .and_then(Value::as_object_mut)
        {
            env_obj.insert("RELAY_API_KEY".into(), Value::String(key.to_string()));
        } else if let Some(server) = new_value
            .pointer_mut("/mcpServers/agent-relay")
            .and_then(Value::as_object_mut)
        {
            let mut env_map = Map::new();
            env_map.insert("RELAY_API_KEY".into(), Value::String(key.to_string()));
            server.insert("env".into(), Value::Object(env_map));
        }
    }

    if !path.exists() {
        write_pretty_json(&path, &new_value)?;
        return Ok(true);
    }

    let existing = fs::read_to_string(&path)?;
    let mut parsed: Value = serde_json::from_str(&existing).unwrap_or(Value::Object(Map::new()));

    let changed = if let (Some(existing_servers), Some(new_servers)) = (
        parsed
            .as_object_mut()
            .and_then(|o| o.get_mut("mcpServers"))
            .and_then(|v| v.as_object_mut()),
        new_value
            .as_object()
            .and_then(|o| o.get("mcpServers"))
            .and_then(|v| v.as_object()),
    ) {
        existing_servers.remove(LEGACY_RELAYCAST_SERVER);
        for (k, v) in new_servers {
            existing_servers.insert(k.clone(), v.clone());
        }
        true
    } else {
        parsed = new_value;
        true
    };

    if changed {
        write_pretty_json(&path, &parsed)?;
    }
    Ok(changed)
}

/// - `cli`: CLI tool name (e.g. "claude", "codex", "gemini", "droid", "grok", "opencode", "cursor")
/// - `agent_name`: the name of the agent being spawned
/// - `api_key`: optional relay API key (empty or `None` means omit)
/// - `base_url`: optional relay base URL (empty or `None` means omit)
/// - `existing_args`: args already provided by the user (used to detect opt-outs)
/// - `cwd`: working directory for the agent (used by opencode/cursor config)
pub async fn configure_agent_relay_mcp(
    cli: &str,
    agent_name: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    existing_args: &[String],
    cwd: &Path,
) -> Result<Vec<String>> {
    // Read from env at the public API boundary so callers without explicit env
    // maps still get the vars if set on the process.
    let workspaces_json = std::env::var("RELAY_WORKSPACES_JSON").ok();
    let default_workspace = std::env::var("RELAY_DEFAULT_WORKSPACE").ok();
    configure_agent_relay_mcp_with_token(
        cli,
        agent_name,
        api_key,
        base_url,
        existing_args,
        cwd,
        None,
        workspaces_json.as_deref(),
        default_workspace.as_deref(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn configure_agent_relay_mcp_with_token(
    cli: &str,
    agent_name: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    existing_args: &[String],
    cwd: &Path,
    agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
) -> Result<Vec<String>> {
    configure_agent_relay_mcp_with_result(
        cli,
        agent_name,
        api_key,
        base_url,
        existing_args,
        cwd,
        agent_token,
        workspaces_json,
        default_workspace,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn configure_agent_relay_mcp_with_result(
    cli: &str,
    agent_name: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    existing_args: &[String],
    cwd: &Path,
    agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    agent_result: Option<&AgentResultMcpConfig>,
) -> Result<Vec<String>> {
    let cli_lower = detect_cli_name(cli).to_lowercase();
    let is_claude = cli_lower == "claude" || cli_lower.starts_with("claude:");
    let is_codex = cli_lower == "codex";
    let is_gemini = cli_lower == "gemini";
    let is_droid = cli_lower == "droid";
    let is_opencode = cli_lower == "opencode";
    let is_grok = cli_lower == "grok";
    let is_cursor = cli_lower == "cursor" || cli_lower == "cursor-agent" || cli_lower == "agent"; // "agent" is cursor-agent's binary name

    let api_key = api_key.map(str::trim).filter(|s| !s.is_empty());
    let base_url = base_url.map(str::trim).filter(|s| !s.is_empty());

    let mut args: Vec<String> = Vec::new();

    if is_claude
        && !existing_args
            .iter()
            .any(|a| a == "--mcp-config" || a.starts_with("--mcp-config="))
    {
        // Build Agent Relay-only MCP config and pass via --mcp-config (additive).
        // Claude will also load .mcp.json normally, preserving user-configured
        // MCP servers (filesystem, database, etc.).
        // We do NOT pass --strict-mcp-config — that would block .mcp.json loading
        // and prevent child agents from inheriting MCP servers.
        let mcp_json = agent_relay_mcp_config_json_with_result(
            api_key,
            base_url,
            Some(agent_name),
            agent_token,
            workspaces_json,
            default_workspace,
            agent_result,
        );
        // Claude Code does not reliably pass parent process env vars to MCP server
        // subprocesses, so RELAY_API_KEY must be injected directly into the config.
        let mcp_json = inject_api_key_into_mcp_json(&mcp_json, api_key);
        args.push("--mcp-config".to_string());
        args.push(mcp_json);
    }

    // Codex: always disable interactive update prompt (independent of Agent Relay config).
    // This must run even when user provides custom Agent Relay MCP config.
    if is_codex
        && !existing_args
            .iter()
            .any(|a| a.contains("check_for_update_on_startup"))
    {
        args.extend([
            "--config".to_string(),
            "check_for_update_on_startup=false".to_string(),
        ]);
    }

    // Codex: auto-configure Agent Relay MCP (only if not already configured).
    if is_codex
        && !existing_args
            .iter()
            .any(|a| a.contains("mcp_servers.agent-relay") || a.contains("mcp_servers.relaycast"))
    {
        let mcp_command = agent_relay_mcp_command();
        // NOTE: All values passed via codex `--config` are parsed as TOML.
        // String values MUST be quoted (e.g. `"npx"` not `npx`) to avoid parse
        // errors or type mismatches.  Bare `1` is an integer; bare `at_live_xxx`
        // is a TOML parse error; only quoted values are reliably treated as strings.
        push_codex_mcp_command_config_args(&mut args, &mcp_command);
        if let Some(key) = api_key {
            args.extend([
                "--config".to_string(),
                format!(
                    "mcp_servers.agent-relay.env.RELAY_API_KEY=\"{}\"",
                    escape_toml_basic_string(key)
                ),
            ]);
        }
        if let Some(url) = base_url {
            args.extend([
                "--config".to_string(),
                format!(
                    "mcp_servers.agent-relay.env.RELAY_BASE_URL=\"{}\"",
                    escape_toml_basic_string(url)
                ),
            ]);
        }
        args.extend([
            "--config".to_string(),
            format!(
                "mcp_servers.agent-relay.env.RELAY_AGENT_NAME=\"{}\"",
                escape_toml_basic_string(agent_name)
            ),
        ]);
        args.extend([
            "--config".to_string(),
            "mcp_servers.agent-relay.env.RELAY_AGENT_TYPE=\"agent\"".to_string(),
        ]);
        args.extend([
            "--config".to_string(),
            "mcp_servers.agent-relay.env.RELAY_STRICT_AGENT_NAME=\"1\"".to_string(),
        ]);
        if let Some(token) = agent_token.map(str::trim).filter(|s| !s.is_empty()) {
            args.extend([
                "--config".to_string(),
                format!(
                    "mcp_servers.agent-relay.env.RELAY_AGENT_TOKEN=\"{}\"",
                    escape_toml_basic_string(token)
                ),
            ]);
            // Skip bootstrap when the broker has already pre-registered the agent.
            args.extend([
                "--config".to_string(),
                "mcp_servers.agent-relay.env.RELAY_SKIP_BOOTSTRAP=\"1\"".to_string(),
            ]);
        }
        // Forward multi-workspace context to codex child agents.
        // JSON values must have inner quotes escaped for TOML basic-string parsing.
        if let Some(wj) = workspaces_json.map(str::trim).filter(|s| !s.is_empty()) {
            args.extend([
                "--config".to_string(),
                format!(
                    "mcp_servers.agent-relay.env.RELAY_WORKSPACES_JSON=\"{}\"",
                    escape_toml_basic_string(wj)
                ),
            ]);
        }
        if let Some(dw) = default_workspace.map(str::trim).filter(|s| !s.is_empty()) {
            args.extend([
                "--config".to_string(),
                format!(
                    "mcp_servers.agent-relay.env.RELAY_DEFAULT_WORKSPACE=\"{}\"",
                    escape_toml_basic_string(dw)
                ),
            ]);
        }
        if let Some(config) = agent_result {
            for (key, value) in config.env_pairs() {
                args.extend([
                    "--config".to_string(),
                    format!(
                        "mcp_servers.agent-relay.env.{key}=\"{}\"",
                        escape_toml_basic_string(&value)
                    ),
                ]);
            }
        }
    } else if is_gemini || is_droid {
        // Result callback tokens are per-spawn secrets. Gemini/Droid, OpenCode,
        // and Cursor write shared config surfaces, so keep result callback env
        // limited to the worker process env instead of persisting it in those files.
        if is_gemini {
            ensure_gemini_folder_trusted(cwd);
        }
        configure_gemini_droid_mcp(
            cli,
            api_key,
            base_url,
            Some(agent_name),
            agent_token,
            is_gemini,
            workspaces_json,
            default_workspace,
            None,
        )
        .await?;
    } else if is_grok {
        configure_grok_mcp(
            cli,
            api_key,
            base_url,
            Some(agent_name),
            agent_token,
            workspaces_json,
            default_workspace,
        )
        .await?;
    } else if is_opencode && !existing_args.iter().any(|a| a == "--agent") {
        ensure_opencode_config_with_result(
            cwd,
            api_key,
            base_url,
            Some(agent_name),
            agent_token,
            workspaces_json,
            default_workspace,
            None,
        )
        .with_context(|| {
            "failed to write opencode.json for Agent Relay MCP. \
             Please configure the Agent Relay MCP server manually in opencode.json"
        })?;
        args.push("--agent".to_string());
        args.push(AGENT_RELAY_MCP_SERVER.to_string());
    } else if is_cursor {
        ensure_cursor_mcp_config(
            cwd,
            api_key,
            base_url,
            Some(agent_name),
            agent_token,
            workspaces_json,
            default_workspace,
            None,
        )
        .with_context(|| {
            "failed to write .cursor/mcp.json for Agent Relay MCP. \
                 Please configure the Agent Relay MCP server manually in .cursor/mcp.json"
        })?;
    }

    Ok(args)
}

fn detect_cli_name(cli: &str) -> String {
    let command = shlex::split(cli)
        .and_then(|parts| parts.first().cloned())
        .unwrap_or_else(|| cli.trim().to_string());

    Path::new(&command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command.as_str())
        .to_string()
}

/// Pre-trust a folder in Gemini's `~/.gemini/trustedFolders.json` so that project
/// settings, MCP servers, and GEMINI.md are applied when Gemini starts.
fn ensure_gemini_folder_trusted(cwd: &Path) {
    let home = match std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
    {
        Some(h) => PathBuf::from(h),
        None => return,
    };

    let trusted_file = home.join(".gemini").join("trustedFolders.json");

    let mut data: Map<String, Value> = if let Ok(contents) = fs::read_to_string(&trusted_file) {
        serde_json::from_str(&contents).unwrap_or_default()
    } else {
        Map::new()
    };

    let folder_key = cwd.to_string_lossy().to_string();

    // Only update if not already trusted
    match data.get(&folder_key).and_then(Value::as_str) {
        Some("TRUST_FOLDER") | Some("TRUST_PARENT") => return,
        _ => {}
    }

    data.insert(folder_key, Value::String("TRUST_FOLDER".to_string()));

    // Ensure parent directory exists
    if let Some(parent) = trusted_file.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(json) = serde_json::to_string_pretty(&data) {
        let _ = fs::write(&trusted_file, json);
        tracing::info!("Pre-trusted folder {:?} in Gemini trustedFolders.json", cwd);
    }
}

/// Run `<cli> mcp remove agent-relay` then `<cli> mcp add` for Gemini or Droid.
fn gemini_droid_mcp_env_flag(is_gemini: bool) -> &'static str {
    if is_gemini {
        "-e"
    } else {
        "--env"
    }
}

fn gemini_droid_manual_mcp_add_cmd(cli: &str, is_gemini: bool) -> String {
    let env_flag = gemini_droid_mcp_env_flag(is_gemini);
    let cmd_separator = if is_gemini { "" } else { " --" };
    let mcp_command = agent_relay_mcp_command();
    let rendered_mcp_command = std::iter::once(mcp_command.command)
        .chain(mcp_command.args)
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{cli} mcp add {env_flag} RELAY_API_KEY=<key> {env_flag} RELAY_BASE_URL=<url> {AGENT_RELAY_MCP_SERVER}{cmd_separator} {rendered_mcp_command}"
    )
}

#[cfg(test)]
fn gemini_droid_mcp_add_args(
    api_key: Option<&str>,
    base_url: Option<&str>,
    agent_name: Option<&str>,
    agent_token: Option<&str>,
    is_gemini: bool,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
) -> Vec<String> {
    gemini_droid_mcp_add_args_with_result(
        api_key,
        base_url,
        agent_name,
        agent_token,
        is_gemini,
        workspaces_json,
        default_workspace,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn gemini_droid_mcp_add_args_with_result(
    api_key: Option<&str>,
    base_url: Option<&str>,
    agent_name: Option<&str>,
    agent_token: Option<&str>,
    is_gemini: bool,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    _agent_result: Option<&AgentResultMcpConfig>,
) -> Vec<String> {
    let env_flag = gemini_droid_mcp_env_flag(is_gemini);
    let mut args = vec!["mcp".to_string(), "add".to_string()];
    if let Some(key) = api_key {
        args.push(env_flag.to_string());
        args.push(format!("RELAY_API_KEY={key}"));
    }
    if let Some(url) = base_url {
        args.push(env_flag.to_string());
        args.push(format!("RELAY_BASE_URL={url}"));
    }
    if let Some(name) = agent_name.map(str::trim).filter(|s| !s.is_empty()) {
        args.push(env_flag.to_string());
        args.push(format!("RELAY_AGENT_NAME={name}"));
        args.push(env_flag.to_string());
        args.push("RELAY_AGENT_TYPE=agent".to_string());
        args.push(env_flag.to_string());
        args.push("RELAY_STRICT_AGENT_NAME=1".to_string());
    }
    if let Some(token) = agent_token.map(str::trim).filter(|s| !s.is_empty()) {
        args.push(env_flag.to_string());
        args.push(format!("RELAY_AGENT_TOKEN={token}"));
        // Skip bootstrap when the broker has already pre-registered the agent.
        args.push(env_flag.to_string());
        args.push("RELAY_SKIP_BOOTSTRAP=1".to_string());
    }
    // Forward multi-workspace context to gemini/droid child agents.
    if let Some(wj) = workspaces_json.map(str::trim).filter(|s| !s.is_empty()) {
        args.push(env_flag.to_string());
        args.push(format!("RELAY_WORKSPACES_JSON={wj}"));
    }
    if let Some(dw) = default_workspace.map(str::trim).filter(|s| !s.is_empty()) {
        args.push(env_flag.to_string());
        args.push(format!("RELAY_DEFAULT_WORKSPACE={dw}"));
    }
    args.push(AGENT_RELAY_MCP_SERVER.to_string());
    // Droid's CLI parser continues parsing options after positional args.
    // Insert `--` so `-y` is treated as an argument to `npx`.
    if !is_gemini {
        args.push("--".to_string());
    }
    let mcp_command = agent_relay_mcp_command();
    args.push(mcp_command.command);
    args.extend(mcp_command.args);
    args
}

fn grok_mcp_add_args(
    api_key: Option<&str>,
    base_url: Option<&str>,
    agent_name: Option<&str>,
    agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
) -> Vec<String> {
    // Grok v0.2.x requires the positional <NAME> argument to come before any
    // options — unlike standard CLI conventions where [OPTIONS] precede NAME.
    // Put NAME immediately after the sub-command.
    let mut args = vec![
        "mcp".to_string(),
        "add".to_string(),
        AGENT_RELAY_MCP_SERVER.to_string(),
    ];
    if let Some(key) = api_key {
        args.push("--env".to_string());
        args.push(format!("RELAY_API_KEY={key}"));
    }
    if let Some(url) = base_url {
        args.push("--env".to_string());
        args.push(format!("RELAY_BASE_URL={url}"));
    }
    if let Some(name) = agent_name.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--env".to_string());
        args.push(format!("RELAY_AGENT_NAME={name}"));
        args.push("--env".to_string());
        args.push("RELAY_AGENT_TYPE=agent".to_string());
        args.push("--env".to_string());
        args.push("RELAY_STRICT_AGENT_NAME=1".to_string());
    }
    if let Some(token) = agent_token.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--env".to_string());
        args.push(format!("RELAY_AGENT_TOKEN={token}"));
        args.push("--env".to_string());
        args.push("RELAY_SKIP_BOOTSTRAP=1".to_string());
    }
    if let Some(wj) = workspaces_json.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--env".to_string());
        args.push(format!("RELAY_WORKSPACES_JSON={wj}"));
    }
    if let Some(dw) = default_workspace.map(str::trim).filter(|s| !s.is_empty()) {
        args.push("--env".to_string());
        args.push(format!("RELAY_DEFAULT_WORKSPACE={dw}"));
    }
    let mcp_command = agent_relay_mcp_command();

    // Grok's CLI parser rejects flag-shaped `--args` values (e.g. `-y`) as
    // unknown options even when they follow a positional arg. Work around this
    // by embedding flag-shaped args directly into the `--command` string so
    // that only plain positional args are passed via `--args`.
    //
    // e.g. `["npx", ["-y", "agent-relay", "mcp"]]`
    //   → `--command "npx -y"  --args agent-relay  --args mcp`
    let (flag_args, positional_args): (Vec<_>, Vec<_>) = mcp_command
        .args
        .into_iter()
        .partition(|a| a.starts_with('-'));
    let command_str = if flag_args.is_empty() {
        mcp_command.command
    } else {
        format!("{} {}", mcp_command.command, flag_args.join(" "))
    };
    args.push("--command".to_string());
    args.push(command_str);
    for arg in positional_args {
        args.push("--args".to_string());
        args.push(arg);
    }
    args
}

fn grok_manual_mcp_add_cmd(cli: &str) -> String {
    let mcp_command = agent_relay_mcp_command();
    let (flag_args, positional_args): (Vec<_>, Vec<_>) =
        mcp_command.args.iter().partition(|a| a.starts_with('-'));
    let command_str = if flag_args.is_empty() {
        mcp_command.command.clone()
    } else {
        let flags: Vec<&str> = flag_args.iter().map(|s| s.as_str()).collect();
        format!("{} {}", mcp_command.command, flags.join(" "))
    };
    let rendered_args = positional_args
        .iter()
        .map(|arg| format!("--args {arg}"))
        .collect::<Vec<_>>()
        .join(" ");
    // Note: NAME must come before options in grok v0.2.x.
    format!(
        "{cli} mcp add {AGENT_RELAY_MCP_SERVER} --env RELAY_API_KEY=<key> --env RELAY_BASE_URL=<url> --command \"{command_str}\" {rendered_args}"
    )
}

async fn remove_grok_mcp_servers(exe: &str) {
    for server_name in [AGENT_RELAY_MCP_SERVER, LEGACY_RELAYCAST_SERVER] {
        let mut cmd = Command::new(exe);
        cmd.args(["mcp", "remove", server_name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Ok(mut child) = cmd.spawn() {
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn configure_grok_mcp(
    cli: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    agent_name: Option<&str>,
    agent_token: Option<&str>,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
) -> Result<()> {
    let exe = shlex::split(cli)
        .and_then(|parts| parts.first().cloned())
        .unwrap_or_else(|| cli.trim().to_string());
    let manual_cmd = grok_manual_mcp_add_cmd(&exe);

    remove_grok_mcp_servers(&exe).await;

    let mut mcp_cmd = Command::new(&exe);
    mcp_cmd.args(grok_mcp_add_args(
        api_key,
        base_url,
        agent_name,
        agent_token,
        workspaces_json,
        default_workspace,
    ));
    mcp_cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match mcp_cmd.spawn() {
        Ok(mut child) => match tokio::time::timeout(Duration::from_secs(15), child.wait()).await {
            Ok(Ok(status)) if !status.success() => {
                anyhow::bail!(
                    "failed to configure Agent Relay MCP for {cli}: `{cli} mcp add` exited with code {:?}. \
                     Please configure the Agent Relay MCP server manually:\n  {manual_cmd}",
                    status.code()
                );
            }
            Ok(Err(error)) => {
                anyhow::bail!(
                    "failed to configure Agent Relay MCP for {cli}: {error}. \
                     Please configure the Agent Relay MCP server manually:\n  {manual_cmd}"
                );
            }
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                anyhow::bail!(
                    "failed to configure Agent Relay MCP for {cli}: `{cli} mcp add` timed out after 15s. \
                     Please configure the Agent Relay MCP server manually:\n  {manual_cmd}"
                );
            }
            _ => {}
        },
        Err(error) => {
            anyhow::bail!(
                "failed to configure Agent Relay MCP for {cli}: {error}. \
                 Please configure the Agent Relay MCP server manually:\n  {manual_cmd}"
            );
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn configure_gemini_droid_mcp(
    cli: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    agent_name: Option<&str>,
    agent_token: Option<&str>,
    is_gemini: bool,
    workspaces_json: Option<&str>,
    default_workspace: Option<&str>,
    agent_result: Option<&AgentResultMcpConfig>,
) -> Result<()> {
    // Extract the executable from cli which may contain inline args
    // (e.g. "gemini --model foo"). Command::new needs just the binary.
    let exe = shlex::split(cli)
        .and_then(|parts| parts.first().cloned())
        .unwrap_or_else(|| cli.trim().to_string());
    let manual_cmd = gemini_droid_manual_mcp_add_cmd(&exe, is_gemini);

    let add_args = gemini_droid_mcp_add_args_with_result(
        api_key,
        base_url,
        agent_name,
        agent_token,
        is_gemini,
        workspaces_json,
        default_workspace,
        agent_result,
    );

    run_gemini_droid_mcp_add(&exe, &add_args, cli, &manual_cmd).await
}

/// Remove all known relay MCP server names from the gemini/droid shared config.
async fn remove_gemini_droid_mcp_servers(exe: &str) {
    for server_name in [AGENT_RELAY_MCP_SERVER, LEGACY_RELAYCAST_SERVER] {
        let mut cmd = Command::new(exe);
        cmd.args(["mcp", "remove", server_name])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Ok(child) = cmd.spawn() {
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await;
        }
    }
}

/// Run `<exe> mcp add <args>`, capturing stderr.
/// Each attempt removes the server first (idempotency). Retries with backoff on "already exists"
/// to handle concurrent eval runs racing on the shared droid/gemini config file.
async fn run_gemini_droid_mcp_add(
    exe: &str,
    add_args: &[String],
    cli: &str,
    manual_cmd: &str,
) -> Result<()> {
    const MAX_ATTEMPTS: u32 = 4;
    let mut last_stderr = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        // Remove first for idempotency — ignore errors (may not exist yet).
        remove_gemini_droid_mcp_servers(exe).await;

        let output = spawn_mcp_add(exe, add_args, cli, manual_cmd).await?;
        if output.status.success() {
            return Ok(());
        }

        last_stderr = String::from_utf8_lossy(&output.stderr).into_owned();

        if last_stderr.contains("already exists") && attempt < MAX_ATTEMPTS - 1 {
            // Race with a concurrent eval run. Back off and retry — the competing
            // process will finish its own remove+add cycle and we can win the next slot.
            let delay = Duration::from_millis(150 * u64::from(attempt + 1));
            tracing::debug!(
                cli,
                attempt,
                ?delay,
                "mcp add saw 'already exists'; backing off before retry"
            );
            tokio::time::sleep(delay).await;
            continue;
        }

        anyhow::bail!(
            "failed to configure Agent Relay MCP for {cli}: `{cli} mcp add` exited with code {:?} \
             (attempt {}/{}). Please configure the Agent Relay MCP server manually:\n  {manual_cmd}\nError: {last_stderr}",
            output.status.code(),
            attempt + 1,
            MAX_ATTEMPTS
        );
    }
    anyhow::bail!(
        "failed to configure Agent Relay MCP for {cli}: `{cli} mcp add` failed after {MAX_ATTEMPTS} attempts \
         due to concurrent access. Please configure the Agent Relay MCP server manually:\n  {manual_cmd}\nError: {last_stderr}"
    )
}

async fn spawn_mcp_add(
    exe: &str,
    add_args: &[String],
    cli: &str,
    manual_cmd: &str,
) -> Result<std::process::Output> {
    let mut mcp_cmd = Command::new(exe);
    mcp_cmd
        .args(add_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    match mcp_cmd.spawn() {
        Ok(child) => {
            match tokio::time::timeout(Duration::from_secs(15), child.wait_with_output()).await {
                Ok(Ok(output)) => Ok(output),
                Ok(Err(error)) => anyhow::bail!(
                    "failed to configure Agent Relay MCP for {cli}: {error}. \
                     Please configure the Agent Relay MCP server manually:\n  {manual_cmd}"
                ),
                Err(_) => anyhow::bail!(
                    "failed to configure Agent Relay MCP for {cli}: `{cli} mcp add` timed out after 15s. \
                     Please configure the Agent Relay MCP server manually:\n  {manual_cmd}"
                ),
            }
        }
        Err(error) => anyhow::bail!(
            "failed to configure Agent Relay MCP for {cli}: could not run `{cli} mcp add`: {error}. \
             Please configure the Agent Relay MCP server manually:\n  {manual_cmd}"
        ),
    }
}

fn write_pretty_json(path: &Path, value: &Value) -> io::Result<()> {
    let mut body = serde_json::to_string_pretty(value).map_err(|error| {
        io::Error::other(format!("failed to serialize {}: {error}", path.display()))
    })?;
    body.push('\n');
    fs::write(path, body)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{json, Map, Value};
    use tempfile::tempdir;

    use super::ensure_agent_relay_mcp_config;

    fn assert_is_agent_relay_mcp_args(args: Option<&Vec<Value>>) {
        let args = args.expect("expected agent-relay mcp args");
        assert_eq!(args.get(0).and_then(Value::as_str), Some("-y"));
        assert_eq!(args.get(1).and_then(Value::as_str), Some("agent-relay"));
        assert_eq!(args.get(2).and_then(Value::as_str), Some("mcp"));
    }

    fn test_agent_result_config() -> crate::types::AgentResultMcpConfig {
        crate::types::AgentResultMcpConfig {
            callback_url: "http://127.0.0.1:3889/api/agent-result".to_string(),
            token: "arr_test".to_string(),
            schema: Some(json!({"type": "object"})),
        }
    }

    #[test]
    fn agent_relay_mcp_command_defaults_to_npx_agent_relay() {
        let command = super::parse_agent_relay_mcp_command(None);

        assert_eq!(command.command, "npx");
        assert_eq!(command.args, vec!["-y", "agent-relay", "mcp"]);
    }

    #[test]
    fn agent_relay_mcp_command_parses_custom_override() {
        let command = super::parse_agent_relay_mcp_command(Some("node /tmp/agent-relay-mcp.js"));

        assert_eq!(command.command, "node");
        assert_eq!(command.args, vec!["/tmp/agent-relay-mcp.js"]);
    }

    #[test]
    fn codex_mcp_command_config_args_use_custom_command() {
        let command = super::parse_agent_relay_mcp_command(Some("node /tmp/agent-relay-mcp.js"));
        let mut args = Vec::new();

        super::push_codex_mcp_command_config_args(&mut args, &command);

        assert_eq!(
            args,
            vec![
                "--config",
                "mcp_servers.agent-relay.command=\"node\"",
                "--config",
                "mcp_servers.agent-relay.args=[\"/tmp/agent-relay-mcp.js\"]",
            ]
        );
    }

    fn assert_agent_result_env_absent(env: &Value) {
        assert!(env["AGENT_RELAY_RESULT_URL"].is_null());
        assert!(env["AGENT_RELAY_RESULT_TOKEN"].is_null());
        assert!(env["AGENT_RELAY_RESULT_SCHEMA"].is_null());
    }

    #[test]
    fn creates_reaycast_mcp_config_when_missing() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();

        let report = ensure_agent_relay_mcp_config(root, Some("rk_test_123"), None, None)
            .expect("create mcp config");
        assert_eq!(report.created, 1);
        assert_eq!(report.updated, 0);
        assert_eq!(report.skipped, 0);

        let contents = fs::read_to_string(root.join(".mcp.json")).expect("read mcp file");
        let json: Value = serde_json::from_str(&contents).expect("parse mcp file");
        assert_eq!(
            json["mcpServers"]["agent-relay"]["command"].as_str(),
            Some("npx")
        );
        assert_is_agent_relay_mcp_args(json["mcpServers"]["agent-relay"]["args"].as_array());
    }

    #[test]
    fn updates_existing_mcp_servers_without_overwriting_other_servers() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"other":{"command":"uvx","args":["other-mcp"]}}}"#,
        )
        .expect("write existing mcp file");

        let report =
            ensure_agent_relay_mcp_config(root, None, Some("https://api.relaycast.dev"), None)
                .expect("update mcp config");
        assert_eq!(report.created, 0);
        assert_eq!(report.updated, 1);
        assert_eq!(report.skipped, 0);

        let contents = fs::read_to_string(root.join(".mcp.json")).expect("read mcp file");
        let json: Value = serde_json::from_str(&contents).expect("parse mcp file");
        assert!(json["mcpServers"]["other"].is_object());
        assert_eq!(
            json["mcpServers"]["agent-relay"]["command"].as_str(),
            Some("npx")
        );
    }

    #[test]
    fn migrates_legacy_server_to_agent_relay() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let legacy = super::LEGACY_RELAYCAST_SERVER;
        fs::write(
            root.join(".mcp.json"),
            format!(r#"{{"mcpServers":{{"{legacy}":{{"command":"node","args":["custom.js"]}}}}}}"#),
        )
        .expect("write existing mcp file");

        let report = ensure_agent_relay_mcp_config(root, Some("rk_new"), None, Some("my-agent"))
            .expect("update mcp config env");
        assert_eq!(report.created, 0);
        assert_eq!(report.updated, 1);
        assert_eq!(report.skipped, 0);

        let contents = fs::read_to_string(root.join(".mcp.json")).expect("read mcp file");
        let json: Value = serde_json::from_str(&contents).expect("parse mcp file");
        assert!(json["mcpServers"][legacy].is_null());
        assert_eq!(
            json["mcpServers"]["agent-relay"]["command"].as_str(),
            Some("npx")
        );
        // RELAY_API_KEY is intentionally omitted from .mcp.json — injected via process env by the broker
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_API_KEY"].as_str(),
            None
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("my-agent")
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_TYPE"].as_str(),
            Some("agent")
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_STRICT_AGENT_NAME"].as_str(),
            Some("1")
        );
    }

    #[tokio::test]
    async fn codex_args_include_strict_agent_name_flag() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "codex",
            "Lead",
            Some("rk_live_test"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure codex mcp args");

        assert!(
            args.iter()
                .any(|arg| arg == "mcp_servers.agent-relay.env.RELAY_AGENT_TYPE=\"agent\""),
            "expected fixed agent type codex config arg"
        );

        assert!(
            args.iter()
                .any(|arg| arg == "mcp_servers.agent-relay.env.RELAY_STRICT_AGENT_NAME=\"1\""),
            "expected strict agent name codex config arg"
        );
    }

    // -----------------------------------------------------------------------
    // Claude provider tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn claude_returns_mcp_config_flag_with_valid_json() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "claude",
            "Worker",
            Some("rk_live_abc"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure claude mcp");

        assert_eq!(
            args.len(),
            2,
            "should be --mcp-config <json> (no --strict-mcp-config)"
        );
        assert_eq!(args[0], "--mcp-config");
        assert!(
            !args.iter().any(|a| a == "--strict-mcp-config"),
            "must not include --strict-mcp-config"
        );

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        assert_eq!(
            json["mcpServers"]["agent-relay"]["command"].as_str(),
            Some("npx")
        );
        let mcp_args = json["mcpServers"]["agent-relay"]["args"]
            .as_array()
            .expect("args array");
        assert_eq!(mcp_args[0].as_str(), Some("-y"));
        assert_eq!(mcp_args[1].as_str(), Some("agent-relay"));
        assert_eq!(mcp_args[2].as_str(), Some("mcp"));
    }

    #[tokio::test]
    async fn claude_includes_api_key_in_mcp_config() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "claude",
            "Worker",
            Some("rk_live_secret"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure claude mcp");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_API_KEY"].as_str(),
            Some("rk_live_secret"),
            "RELAY_API_KEY must appear in Claude --mcp-config (Claude Code does not reliably \
             inherit parent env vars to MCP server subprocesses)"
        );
    }

    #[tokio::test]
    async fn claude_includes_agent_name_type_and_strict_flag() {
        let temp = tempdir().expect("tempdir");
        let args =
            super::configure_agent_relay_mcp("claude", "MyAgent", None, None, &[], temp.path())
                .await
                .expect("configure claude mcp");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        let env = &json["mcpServers"]["agent-relay"]["env"];
        assert_eq!(env["RELAY_AGENT_NAME"].as_str(), Some("MyAgent"));
        assert_eq!(env["RELAY_AGENT_TYPE"].as_str(), Some("agent"));
        assert_eq!(env["RELAY_STRICT_AGENT_NAME"].as_str(), Some("1"));
    }

    #[tokio::test]
    async fn claude_includes_agent_token_when_provided() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp_with_token(
            "claude",
            "Worker",
            None,
            None,
            &[],
            temp.path(),
            Some("tok_abc123"),
            None,
            None,
        )
        .await
        .expect("configure claude mcp with token");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_TOKEN"].as_str(),
            Some("tok_abc123")
        );
    }

    #[tokio::test]
    async fn claude_opt_out_when_mcp_config_already_in_args() {
        let temp = tempdir().expect("tempdir");
        let existing = vec!["--mcp-config".to_string(), "{}".to_string()];
        let args = super::configure_agent_relay_mcp(
            "claude",
            "Worker",
            Some("rk_live_abc"),
            Some("https://api.relaycast.dev"),
            &existing,
            temp.path(),
        )
        .await
        .expect("configure claude mcp opt-out");

        assert!(
            args.is_empty(),
            "should return no args when user already provided --mcp-config"
        );
    }

    #[tokio::test]
    async fn claude_still_injects_mcp_config_when_strict_flag_in_existing_args() {
        let temp = tempdir().expect("tempdir");
        // Regression: --strict-mcp-config in existing_args must NOT prevent
        // broker from injecting --mcp-config (the old substring check matched
        // "mcp-config" inside "--strict-mcp-config").
        let existing = vec!["--strict-mcp-config".to_string()];
        let args = super::configure_agent_relay_mcp(
            "claude",
            "Worker",
            Some("rk_live_abc"),
            Some("https://api.relaycast.dev"),
            &existing,
            temp.path(),
        )
        .await
        .expect("configure claude mcp with strict in existing");

        assert!(
            args.iter().any(|a| a == "--mcp-config"),
            "broker must still inject --mcp-config even when --strict-mcp-config is in existing_args"
        );
        // Should not duplicate --strict-mcp-config since it's already present
        assert!(
            !args.iter().any(|a| a == "--strict-mcp-config"),
            "should not duplicate --strict-mcp-config"
        );
    }

    #[tokio::test]
    async fn claude_detected_from_absolute_path() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "/usr/local/bin/claude",
            "Worker",
            None,
            None,
            &[],
            temp.path(),
        )
        .await
        .expect("configure claude from path");

        assert_eq!(args[0], "--mcp-config");
    }

    #[tokio::test]
    async fn claude_colon_variant_detected() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "claude:latest",
            "Worker",
            None,
            None,
            &[],
            temp.path(),
        )
        .await
        .expect("configure claude:latest");

        assert_eq!(args[0], "--mcp-config");
    }

    #[tokio::test]
    async fn claude_with_inline_args_still_injects_mcp_config() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "claude --model sonnet",
            "Worker",
            None,
            None,
            &[],
            temp.path(),
        )
        .await
        .expect("configure claude with inline args");

        assert_eq!(args[0], "--mcp-config");
    }

    #[test]
    fn grok_mcp_add_args_use_command_and_args_flags() {
        let args = super::grok_mcp_add_args(
            Some("rk_live_xyz"),
            Some("https://api.relaycast.dev"),
            Some("GrokWorker"),
            Some("tok_grok_123"),
            None,
            None,
        );

        // NAME ("agent-relay") must come immediately after "add" — grok v0.2.x
        // requires the positional argument before any options.
        assert_eq!(args[0], "mcp");
        assert_eq!(args[1], "add");
        assert_eq!(args[2], "agent-relay");
        assert!(args.contains(&"--env".to_string()));
        assert!(args.contains(&"RELAY_API_KEY=rk_live_xyz".to_string()));
        assert!(args.contains(&"RELAY_AGENT_NAME=GrokWorker".to_string()));
        assert!(args.contains(&"RELAY_AGENT_TOKEN=tok_grok_123".to_string()));
        // Flag-shaped args (-y) are embedded into the --command value to avoid
        // grok's CLI parser treating them as unknown options.
        let command_idx = args
            .iter()
            .position(|arg| arg == "--command")
            .expect("--command arg");
        assert_eq!(args[command_idx + 1], "npx -y");
        assert_eq!(args[command_idx + 2], "--args");
        assert_eq!(args[command_idx + 3], "agent-relay");
        assert_eq!(args[command_idx + 4], "--args");
        assert_eq!(args[command_idx + 5], "mcp");
    }

    #[test]
    fn droid_mcp_add_args_include_option_separator() {
        let args = super::gemini_droid_mcp_add_args(
            Some("rk_live_xyz"),
            Some("https://api.relaycast.dev"),
            None,
            None,
            false,
            None,
            None,
        );

        let agent_relay_idx = args
            .iter()
            .position(|arg| arg == "agent-relay")
            .expect("agent-relay arg");
        assert_eq!(args[agent_relay_idx + 1], "--");
        assert_eq!(args[agent_relay_idx + 2], "npx");
        assert_eq!(args[agent_relay_idx + 3], "-y");
        assert_eq!(args[agent_relay_idx + 4], "agent-relay");
        assert_eq!(args[agent_relay_idx + 5], "mcp");
    }

    #[test]
    fn gemini_mcp_add_args_do_not_include_option_separator() {
        let args = super::gemini_droid_mcp_add_args(
            Some("rk_live_xyz"),
            Some("https://api.relaycast.dev"),
            Some("GeminiWorker"),
            Some("tok_gem_123"),
            true,
            None,
            None,
        );

        assert!(args.contains(&"-e".to_string()));
        assert!(args.contains(&"RELAY_API_KEY=rk_live_xyz".to_string()));
        assert!(args.contains(&"RELAY_BASE_URL=https://api.relaycast.dev".to_string()));
        assert!(args.contains(&"RELAY_AGENT_NAME=GeminiWorker".to_string()));
        assert!(args.contains(&"RELAY_AGENT_TYPE=agent".to_string()));
        assert!(args.contains(&"RELAY_STRICT_AGENT_NAME=1".to_string()));
        assert!(args.contains(&"RELAY_AGENT_TOKEN=tok_gem_123".to_string()));

        let agent_relay_idx = args
            .iter()
            .position(|arg| arg == "agent-relay")
            .expect("agent-relay arg");
        assert_eq!(args[agent_relay_idx + 1], "npx");
        assert!(
            !args.iter().any(|arg| arg == "--"),
            "Gemini command should not include `--` argument separator"
        );
    }

    #[test]
    fn droid_manual_mcp_add_command_uses_option_separator() {
        let droid_cmd = super::gemini_droid_manual_mcp_add_cmd("droid", false);
        assert!(droid_cmd.contains("agent-relay -- npx -y agent-relay mcp"));

        let gemini_cmd = super::gemini_droid_manual_mcp_add_cmd("gemini", true);
        assert!(!gemini_cmd.contains("agent-relay -- npx -y agent-relay mcp"));
        assert!(gemini_cmd.contains("agent-relay npx -y agent-relay mcp"));
    }

    #[test]
    fn droid_mcp_add_args_include_env_flags_and_token() {
        let args = super::gemini_droid_mcp_add_args(
            Some("rk_live_xyz"),
            Some("https://api.relaycast.dev"),
            Some("DroidWorker"),
            Some("tok_droid_123"),
            false,
            None,
            None,
        );

        assert!(args.contains(&"--env".to_string()));
        assert!(args.contains(&"RELAY_API_KEY=rk_live_xyz".to_string()));
        assert!(args.contains(&"RELAY_BASE_URL=https://api.relaycast.dev".to_string()));
        assert!(args.contains(&"RELAY_AGENT_NAME=DroidWorker".to_string()));
        assert!(args.contains(&"RELAY_AGENT_TYPE=agent".to_string()));
        assert!(args.contains(&"RELAY_STRICT_AGENT_NAME=1".to_string()));
        assert!(args.contains(&"RELAY_AGENT_TOKEN=tok_droid_123".to_string()));
    }

    #[test]
    fn gemini_droid_mcp_add_args_omit_agent_result_env() {
        let config = test_agent_result_config();
        let args = super::gemini_droid_mcp_add_args_with_result(
            Some("rk_live_xyz"),
            Some("https://api.relaycast.dev"),
            Some("GeminiWorker"),
            Some("tok_gem_123"),
            true,
            None,
            None,
            Some(&config),
        );

        assert!(
            !args.iter().any(|arg| arg.contains("AGENT_RELAY_RESULT")),
            "Gemini/Droid mcp add writes shared config and must not persist per-agent result tokens"
        );
    }

    // -----------------------------------------------------------------------
    // Codex provider tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn codex_returns_config_flags_with_all_env_vars() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "codex",
            "CodexAgent",
            Some("rk_live_xyz"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure codex mcp");

        // Should have pairs of [--config, value, --config, value, ...]
        assert!(args.len() >= 2);
        assert!(args.iter().step_by(2).all(|a| a == "--config"));

        // Verify key config values
        assert!(args.contains(&"mcp_servers.agent-relay.command=\"npx\"".to_string()));
        assert!(args
            .iter()
            .any(|a| a.contains("mcp_servers.agent-relay.args=")));
        assert!(
            args.contains(&"mcp_servers.agent-relay.env.RELAY_API_KEY=\"rk_live_xyz\"".to_string())
        );
        assert!(args.contains(
            &"mcp_servers.agent-relay.env.RELAY_BASE_URL=\"https://api.relaycast.dev\"".to_string()
        ));
        assert!(args
            .contains(&"mcp_servers.agent-relay.env.RELAY_AGENT_NAME=\"CodexAgent\"".to_string()));
        assert!(
            args.contains(&"mcp_servers.agent-relay.env.RELAY_AGENT_TYPE=\"agent\"".to_string())
        );
        assert!(
            args.contains(&"mcp_servers.agent-relay.env.RELAY_STRICT_AGENT_NAME=\"1\"".to_string())
        );
        assert!(
            args.contains(&"check_for_update_on_startup=false".to_string()),
            "expected check_for_update_on_startup=false config arg"
        );
    }

    #[tokio::test]
    async fn codex_includes_api_key_unlike_claude() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "codex",
            "Agent",
            Some("rk_live_secret"),
            None,
            &[],
            temp.path(),
        )
        .await
        .expect("configure codex mcp");

        assert!(
            args.iter()
                .any(|a| a == "mcp_servers.agent-relay.env.RELAY_API_KEY=\"rk_live_secret\""),
            "Codex must include RELAY_API_KEY in --config args"
        );
    }

    #[tokio::test]
    async fn codex_includes_agent_token_when_provided() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp_with_token(
            "codex",
            "Agent",
            None,
            None,
            &[],
            temp.path(),
            Some("tok_codex_123"),
            None,
            None,
        )
        .await
        .expect("configure codex mcp with token");

        assert!(
            args.iter()
                .any(|a| a == "mcp_servers.agent-relay.env.RELAY_AGENT_TOKEN=\"tok_codex_123\""),
            "Codex must include RELAY_AGENT_TOKEN when provided"
        );
    }

    #[tokio::test]
    async fn codex_includes_agent_result_env_in_inline_config() {
        let temp = tempdir().expect("tempdir");
        let config = test_agent_result_config();
        let args = super::configure_agent_relay_mcp_with_result(
            "codex",
            "Agent",
            None,
            None,
            &[],
            temp.path(),
            None,
            None,
            None,
            Some(&config),
        )
        .await
        .expect("configure codex mcp with result");

        assert!(
            args.iter()
                .any(|a| a == "mcp_servers.agent-relay.env.AGENT_RELAY_RESULT_TOKEN=\"arr_test\""),
            "Codex inline config can carry per-agent result callback env"
        );
    }

    #[tokio::test]
    async fn codex_omits_optional_fields_when_none() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp("codex", "Agent", None, None, &[], temp.path())
            .await
            .expect("configure codex mcp minimal");

        assert!(
            !args.iter().any(|a| a.contains("RELAY_API_KEY")),
            "should not include RELAY_API_KEY when api_key is None"
        );
        assert!(
            !args.iter().any(|a| a.contains("RELAY_BASE_URL")),
            "should not include RELAY_BASE_URL when base_url is None"
        );
        // Agent name and type are always present
        assert!(args
            .iter()
            .any(|a| a == "mcp_servers.agent-relay.env.RELAY_AGENT_NAME=\"Agent\""));
    }

    #[tokio::test]
    async fn codex_opt_out_when_agent_relay_config_already_in_args() {
        let temp = tempdir().expect("tempdir");
        let existing = vec![
            "--config".to_string(),
            "mcp_servers.agent-relay.command=custom".to_string(),
        ];
        let args = super::configure_agent_relay_mcp(
            "codex",
            "Agent",
            Some("rk_live_abc"),
            None,
            &existing,
            temp.path(),
        )
        .await
        .expect("configure codex mcp opt-out");

        // When user provides custom Agent Relay config, we skip Agent Relay MCP setup
        // but STILL add the update suppression to prevent interactive prompts.
        assert_eq!(
            args,
            vec!["--config", "check_for_update_on_startup=false"],
            "should only return update suppression when user already provided mcp_servers.agent-relay config"
        );
    }

    #[tokio::test]
    async fn codex_opt_out_when_legacy_relaycast_config_already_in_args() {
        let temp = tempdir().expect("tempdir");
        let existing = vec![
            "--config".to_string(),
            "mcp_servers.relaycast.command=custom".to_string(),
        ];
        let args = super::configure_agent_relay_mcp(
            "codex",
            "Agent",
            Some("rk_live_abc"),
            None,
            &existing,
            temp.path(),
        )
        .await
        .expect("configure codex mcp opt-out");

        assert_eq!(args, vec!["--config", "check_for_update_on_startup=false"]);
    }

    // -----------------------------------------------------------------------
    // Opencode provider tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn opencode_creates_config_file_and_returns_agent_flag() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "opencode",
            "OcAgent",
            Some("rk_live_oc"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure opencode mcp");

        assert_eq!(args, vec!["--agent", "agent-relay"]);

        // Verify opencode.json was created
        let path = temp.path().join("opencode.json");
        assert!(path.exists(), "opencode.json must be created");

        let contents = fs::read_to_string(&path).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // MCP server structure
        let mcp = &json["mcp"]["agent-relay"];
        assert_eq!(mcp["type"].as_str(), Some("local"));
        let cmd = mcp["command"].as_array().expect("command array");
        assert_eq!(cmd[0].as_str(), Some("npx"));
        assert_eq!(cmd[1].as_str(), Some("-y"));
        assert_eq!(cmd[2].as_str(), Some("agent-relay"));
        assert_eq!(cmd[3].as_str(), Some("mcp"));

        // Environment (note: opencode uses "environment" not "env")
        let oc_env = &mcp["environment"];
        assert_eq!(
            oc_env["RELAY_API_KEY"].as_str(),
            Some("rk_live_oc"),
            "Opencode includes RELAY_API_KEY in environment"
        );
        assert_eq!(
            oc_env["RELAY_BASE_URL"].as_str(),
            Some("https://api.relaycast.dev")
        );
        assert_eq!(oc_env["RELAY_AGENT_NAME"].as_str(), Some("OcAgent"));
        assert_eq!(oc_env["RELAY_AGENT_TYPE"].as_str(), Some("agent"));
        assert_eq!(oc_env["RELAY_STRICT_AGENT_NAME"].as_str(), Some("1"));

        // Agent entry
        let agent = &json["agent"]["agent-relay"];
        assert_eq!(
            agent["description"].as_str(),
            Some("Agent with Agent Relay MCP enabled")
        );
        assert_eq!(agent["tools"]["agent-relay_*"].as_bool(), Some(true));
    }

    #[tokio::test]
    async fn opencode_result_contract_does_not_persist_callback_env() {
        let temp = tempdir().expect("tempdir");
        let config = test_agent_result_config();
        let args = super::configure_agent_relay_mcp_with_result(
            "opencode",
            "OcAgent",
            Some("rk_live_oc"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
            None,
            None,
            None,
            Some(&config),
        )
        .await
        .expect("configure opencode mcp with result");

        assert_eq!(args, vec!["--agent", "agent-relay"]);
        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");
        assert_agent_result_env_absent(&json["mcp"]["agent-relay"]["environment"]);
    }

    #[tokio::test]
    async fn opencode_upserts_into_existing_config_preserving_other_keys() {
        let temp = tempdir().expect("tempdir");
        let existing = r#"{
            "mcp": {
                "other-server": {"type": "local", "command": ["uvx", "other"]}
            },
            "theme": "dark"
        }"#;
        fs::write(temp.path().join("opencode.json"), existing).expect("write existing");

        let args = super::configure_agent_relay_mcp(
            "opencode",
            "Agent",
            Some("rk_live_test"),
            None,
            &[],
            temp.path(),
        )
        .await
        .expect("configure opencode mcp upsert");

        assert_eq!(args, vec!["--agent", "agent-relay"]);

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // Original keys preserved
        assert_eq!(json["theme"].as_str(), Some("dark"));
        assert!(
            json["mcp"]["other-server"].is_object(),
            "existing MCP servers must be preserved"
        );

        // Relaycast added
        assert!(json["mcp"]["agent-relay"].is_object());
        assert!(json["agent"]["agent-relay"].is_object());
    }

    #[tokio::test]
    async fn opencode_opt_out_when_agent_flag_already_in_args() {
        let temp = tempdir().expect("tempdir");
        let existing = vec!["--agent".to_string(), "custom".to_string()];
        let args = super::configure_agent_relay_mcp(
            "opencode",
            "Agent",
            Some("rk_live_abc"),
            None,
            &existing,
            temp.path(),
        )
        .await
        .expect("configure opencode mcp opt-out");

        assert!(
            args.is_empty(),
            "should return no args when user already provided --agent"
        );
        assert!(
            !temp.path().join("opencode.json").exists(),
            "should not create opencode.json when opted out"
        );
    }

    #[tokio::test]
    async fn cursor_writes_mcp_json_with_agent_relay_server() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "cursor",
            "CursorAgent",
            Some("rk_live_cursor"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure cursor mcp");

        assert!(
            args.is_empty(),
            "cursor should configure MCP via file, not CLI args"
        );

        let path = temp.path().join(".cursor").join("mcp.json");
        assert!(path.exists(), ".cursor/mcp.json must be created");
        let contents = fs::read_to_string(path).expect("read cursor mcp config");
        let json: Value = serde_json::from_str(&contents).expect("parse cursor mcp config");

        assert_eq!(
            json["mcpServers"]["agent-relay"]["command"].as_str(),
            Some("npx")
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_API_KEY"].as_str(),
            Some("rk_live_cursor")
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_BASE_URL"].as_str(),
            Some("https://api.relaycast.dev")
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("CursorAgent")
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_TYPE"].as_str(),
            Some("agent")
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_STRICT_AGENT_NAME"].as_str(),
            Some("1")
        );
    }

    #[tokio::test]
    async fn cursor_result_contract_does_not_persist_callback_env() {
        let temp = tempdir().expect("tempdir");
        let config = test_agent_result_config();
        let args = super::configure_agent_relay_mcp_with_result(
            "cursor",
            "CursorAgent",
            Some("rk_live_cursor"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
            None,
            None,
            None,
            Some(&config),
        )
        .await
        .expect("configure cursor mcp with result");

        assert!(
            args.is_empty(),
            "cursor should configure MCP via file, not CLI args"
        );
        let contents = fs::read_to_string(temp.path().join(".cursor").join("mcp.json"))
            .expect("read cursor mcp config");
        let json: Value = serde_json::from_str(&contents).expect("parse cursor mcp config");
        assert_agent_result_env_absent(&json["mcpServers"]["agent-relay"]["env"]);
    }

    #[tokio::test]
    async fn cursor_agent_alias_writes_mcp_json_with_token() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp_with_token(
            "agent",
            "CursorAlias",
            None,
            None,
            &[],
            temp.path(),
            Some("tok_cursor_123"),
            None,
            None,
        )
        .await
        .expect("configure cursor alias mcp");

        assert!(
            args.is_empty(),
            "cursor alias should configure MCP via file"
        );

        let path = temp.path().join(".cursor").join("mcp.json");
        assert!(path.exists(), ".cursor/mcp.json must be created");
        let contents = fs::read_to_string(path).expect("read cursor alias mcp config");
        let json: Value = serde_json::from_str(&contents).expect("parse cursor alias mcp config");

        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_TOKEN"].as_str(),
            Some("tok_cursor_123")
        );
    }

    // -----------------------------------------------------------------------
    // Unknown / unsupported CLI tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn unknown_cli_returns_empty_args() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp(
            "aider",
            "Agent",
            Some("rk_live_abc"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure unknown cli");

        assert!(
            args.is_empty(),
            "unsupported CLIs should return no injection args"
        );
    }

    #[tokio::test]
    async fn goose_cli_returns_empty_args() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp("goose", "Agent", None, None, &[], temp.path())
            .await
            .expect("configure goose cli");

        assert!(args.is_empty(), "goose has no MCP injection support");
    }

    // -----------------------------------------------------------------------
    // agent_relay_mcp_config_json direct tests
    // -----------------------------------------------------------------------

    #[test]
    fn mcp_config_json_produces_valid_structure() {
        let json_str = super::agent_relay_mcp_config_json(
            Some("rk_live_test"),
            Some("https://api.relaycast.dev"),
            Some("TestAgent"),
        );
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        // Top-level structure
        assert!(json["mcpServers"]["agent-relay"].is_object());

        // Command
        assert_eq!(
            json["mcpServers"]["agent-relay"]["command"].as_str(),
            Some("npx")
        );

        // API key intentionally omitted
        assert!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_API_KEY"].is_null(),
            "API key must not appear in mcp config JSON"
        );

        // Agent env vars present
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("TestAgent")
        );
    }

    #[test]
    fn mcp_config_json_with_token_includes_token() {
        let json_str = super::agent_relay_mcp_config_json_with_token(
            Some("rk_live_test"),
            Some("https://example.com"),
            Some("Agent"),
            Some("tok_xyz"),
            None,
            None,
        );
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_TOKEN"].as_str(),
            Some("tok_xyz")
        );
    }

    #[test]
    fn mcp_config_json_with_no_token_omits_token_field() {
        let json_str = super::agent_relay_mcp_config_json_with_token(
            None,
            None,
            Some("Agent"),
            None,
            None,
            None,
        );
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        assert!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_TOKEN"].is_null(),
            "RELAY_AGENT_TOKEN should not be present when token is None"
        );
    }

    #[test]
    fn mcp_config_json_omits_env_when_no_values_provided() {
        let json_str = super::agent_relay_mcp_config_json(None, None, None);
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        assert!(
            json["mcpServers"]["agent-relay"]["env"].is_null(),
            "env object should not be present when all values are None"
        );
    }

    // -----------------------------------------------------------------------
    // Whitespace / empty string trimming
    // -----------------------------------------------------------------------

    #[test]
    fn mcp_config_json_trims_whitespace_values() {
        let json_str = super::agent_relay_mcp_config_json(
            Some("  rk_live_test  "),
            Some("  https://api.relaycast.dev  "),
            Some("  Agent  "),
        );
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        // base_url and agent_name are trimmed
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_BASE_URL"].as_str(),
            Some("https://api.relaycast.dev")
        );
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("Agent")
        );
    }

    #[test]
    fn mcp_config_json_treats_whitespace_only_as_none() {
        let json_str = super::agent_relay_mcp_config_json(Some("   "), Some("   "), Some("   "));
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        assert!(
            json["mcpServers"]["agent-relay"]["env"].is_null(),
            "whitespace-only values should be treated as None"
        );
    }

    #[tokio::test]
    async fn claude_trims_whitespace_in_agent_token() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp_with_token(
            "claude",
            "Agent",
            None,
            None,
            &[],
            temp.path(),
            Some("  tok_123  "),
            None,
            None,
        )
        .await
        .expect("configure claude with whitespace token");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_AGENT_TOKEN"].as_str(),
            Some("tok_123")
        );
    }

    #[tokio::test]
    async fn codex_ignores_whitespace_only_token() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp_with_token(
            "codex",
            "Agent",
            None,
            None,
            &[],
            temp.path(),
            Some("   "),
            None,
            None,
        )
        .await
        .expect("configure codex with empty token");

        assert!(
            !args.iter().any(|a| a.contains("RELAY_AGENT_TOKEN")),
            "whitespace-only token should be omitted"
        );
    }

    // -----------------------------------------------------------------------
    // ensure_opencode_config direct tests
    // -----------------------------------------------------------------------

    #[test]
    fn opencode_config_uses_environment_not_env() {
        let temp = tempdir().expect("tempdir");
        super::ensure_opencode_config(
            temp.path(),
            Some("rk_live_test"),
            Some("https://api.relaycast.dev"),
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("create opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // Opencode uses "environment" key, not "env"
        assert!(
            json["mcp"]["agent-relay"]["environment"].is_object(),
            "opencode must use 'environment' key"
        );
        assert!(
            json["mcp"]["agent-relay"]["env"].is_null(),
            "opencode must not use 'env' key"
        );
    }

    #[test]
    fn opencode_config_does_not_overwrite_existing_agent_entry() {
        let temp = tempdir().expect("tempdir");
        let existing = r#"{
            "mcp": {},
            "agent": {
                "agent-relay": {
                    "description": "Custom agent",
                    "tools": {"agent-relay_*": true, "custom_tool": true}
                }
            }
        }"#;
        fs::write(temp.path().join("opencode.json"), existing).expect("write existing");

        super::ensure_opencode_config(
            temp.path(),
            Some("rk_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("upsert opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // Agent entry should be preserved (not overwritten)
        assert_eq!(
            json["agent"]["agent-relay"]["description"].as_str(),
            Some("Custom agent"),
            "existing agent entry must not be overwritten"
        );
        assert_eq!(
            json["agent"]["agent-relay"]["tools"]["custom_tool"].as_bool(),
            Some(true),
            "custom tools in existing agent entry must be preserved"
        );
    }

    #[test]
    fn merge_mcp_preserves_user_servers() {
        let temp = tempdir().expect("tempdir");
        let mcp_path = temp.path().join(".mcp.json");
        // User has a filesystem MCP server configured
        fs::write(
            &mcp_path,
            r#"{
                "mcpServers": {
                    "filesystem": {
                        "command": "npx",
                        "args": ["-y", "@modelcontextprotocol/server-filesystem"]
                    },
                    "relaycast": {
                        "command": "npx",
                        "args": ["-y", "agent-relay", "mcp"],
                        "env": { "RELAY_API_KEY": "old_stale_key" }
                    }
                }
            }"#,
        )
        .expect("write .mcp.json");

        let merged = super::merge_agent_relay_with_project_mcp(
            Some("rk_fresh_key"),
            None,
            Some("test-agent"),
            None,
            temp.path(),
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        // User's filesystem server is preserved
        assert!(
            servers.contains_key("filesystem"),
            "user's filesystem MCP should be preserved"
        );

        assert!(
            !servers.contains_key("relaycast"),
            "legacy relaycast server entry must be removed"
        );

        // Agent Relay entry uses broker-injected credentials, not stale ones.
        let agent_relay_env = &servers["agent-relay"]["env"];
        assert_ne!(
            agent_relay_env["RELAY_API_KEY"].as_str(),
            Some("old_stale_key"),
            "stale workspace key must be overridden"
        );
        assert_eq!(
            agent_relay_env["RELAY_AGENT_NAME"].as_str(),
            Some("test-agent"),
            "broker-injected agent name must be present"
        );
    }

    #[test]
    fn merge_mcp_works_without_project_mcp_file() {
        let temp = tempdir().expect("tempdir");
        // No .mcp.json exists

        let merged = super::merge_agent_relay_with_project_mcp(
            Some("rk_key"),
            None,
            Some("agent-1"),
            None,
            temp.path(),
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        assert_eq!(
            servers.len(),
            1,
            "only Agent Relay server when no .mcp.json"
        );
        assert!(servers.contains_key("agent-relay"));
    }

    #[test]
    fn merge_mcp_handles_malformed_project_file() {
        let temp = tempdir().expect("tempdir");
        let mcp_path = temp.path().join(".mcp.json");
        fs::write(&mcp_path, "not valid json {{{").expect("write bad .mcp.json");

        let merged = super::merge_agent_relay_with_project_mcp(
            Some("rk_key"),
            None,
            Some("agent-1"),
            None,
            temp.path(),
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        assert_eq!(
            servers.len(),
            1,
            "malformed .mcp.json should be ignored gracefully"
        );
        assert!(servers.contains_key("agent-relay"));
    }

    #[test]
    fn merge_mcp_reads_global_settings() {
        // Simulate global ~/.claude/settings.json + project .mcp.json
        // Global has "database" MCP, project has "filesystem" MCP
        // Both should appear in merged output
        let temp = tempdir().expect("tempdir");

        // Create fake ~/.claude/settings.json in the temp dir
        let claude_dir = temp.path().join(".claude");
        fs::create_dir_all(&claude_dir).expect("create .claude dir");
        fs::write(
            claude_dir.join("settings.json"),
            r#"{ "mcpServers": { "database": { "command": "npx", "args": ["-y", "db-mcp"] } } }"#,
        )
        .expect("write global settings");

        // Project-level .mcp.json in a subdirectory
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("create project dir");
        fs::write(
            project.join(".mcp.json"),
            r#"{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "fs-mcp"] } } }"#,
        )
        .expect("write project .mcp.json");

        // Note: this test calls merge_agent_relay_with_project_mcp which uses
        // dirs::home_dir() internally, so the global settings from our temp dir
        // won't be found. This test validates that project-level .mcp.json works.
        // The global settings path is tested implicitly by the real system.
        let merged = super::merge_agent_relay_with_project_mcp(
            Some("rk_key"),
            None,
            Some("agent-1"),
            None,
            &project,
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        assert!(servers.contains_key("filesystem"), "project MCP preserved");
        assert!(servers.contains_key("agent-relay"), "Agent Relay injected");
    }

    #[test]
    fn opencode_config_returns_false_when_nothing_changed() {
        let temp = tempdir().expect("tempdir");

        // First call creates
        let created = super::ensure_opencode_config(
            temp.path(),
            Some("rk_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("create opencode config");
        assert!(created, "first call should create the file");

        // Second call with same MCP (agent entry already exists)
        let changed = super::ensure_opencode_config(
            temp.path(),
            Some("rk_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("second opencode config");
        // MCP is always upserted (changed=true) because we unconditionally insert mcp.agent-relay,
        // but agent.agent-relay is only inserted if missing.
        // The function returns true because mcp upsert always sets changed=true.
        assert!(changed, "mcp section always gets upserted");
    }

    #[test]
    fn opencode_config_includes_permission_allow_all() {
        let temp = tempdir().expect("tempdir");
        super::ensure_opencode_config(
            temp.path(),
            Some("rk_live_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("create opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        assert_eq!(
            json["permission"]["*"]["*"].as_str(),
            Some("allow"),
            "opencode.json must include permission[*][*] = allow to suppress prompts"
        );
    }

    #[test]
    fn opencode_config_adds_permission_block_to_existing_file() {
        let temp = tempdir().expect("tempdir");
        // Pre-existing config without a permission block
        let existing = r#"{"mcp": {}, "agent": {}}"#;
        fs::write(temp.path().join("opencode.json"), existing).expect("write existing");

        super::ensure_opencode_config(
            temp.path(),
            Some("rk_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("upsert opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        assert_eq!(
            json["permission"]["*"]["*"].as_str(),
            Some("allow"),
            "permission block must be added to pre-existing opencode.json"
        );
    }

    #[test]
    fn opencode_config_augments_partial_permission_block_with_wildcard() {
        let temp = tempdir().expect("tempdir");
        // Pre-existing config with a partial permission block (no wildcard catch-all)
        let existing = r#"{"mcp": {}, "agent": {}, "permission": {"bash": {"read": "allow"}}}"#;
        fs::write(temp.path().join("opencode.json"), existing).expect("write existing");

        super::ensure_opencode_config(
            temp.path(),
            Some("rk_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("upsert opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // Custom entry preserved AND wildcard catch-all added for uncovered tools
        assert_eq!(
            json["permission"]["bash"]["read"].as_str(),
            Some("allow"),
            "existing custom permission entry must be preserved"
        );
        assert_eq!(
            json["permission"]["*"]["*"].as_str(),
            Some("allow"),
            "wildcard catch-all must be added to cover uncovered tool categories"
        );
    }

    #[test]
    fn opencode_config_does_not_touch_existing_wildcard_permission() {
        let temp = tempdir().expect("tempdir");
        // Pre-existing config that already has a wildcard — leave it entirely alone
        let existing = r#"{"mcp": {}, "agent": {}, "permission": {"*": {"*": "ask"}, "bash": {"read": "allow"}}}"#;
        fs::write(temp.path().join("opencode.json"), existing).expect("write existing");

        super::ensure_opencode_config(
            temp.path(),
            Some("rk_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("upsert opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // User's custom wildcard is preserved, not overwritten to "allow"
        assert_eq!(
            json["permission"]["*"]["*"].as_str(),
            Some("ask"),
            "user's custom wildcard permission must not be overwritten"
        );
    }

    #[test]
    fn opencode_config_replaces_null_permission_with_wildcard() {
        let temp = tempdir().expect("tempdir");
        let existing = r#"{"mcp": {}, "agent": {}, "permission": null}"#;
        fs::write(temp.path().join("opencode.json"), existing).expect("write existing");

        super::ensure_opencode_config(
            temp.path(),
            Some("rk_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("upsert opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        assert_eq!(
            json["permission"]["*"]["*"].as_str(),
            Some("allow"),
            "null permission value must be replaced with wildcard block"
        );
    }

    #[test]
    fn opencode_config_replaces_null_mcp_with_proper_server() {
        let temp = tempdir().expect("tempdir");
        let existing = r#"{"mcp": null, "agent": {}}"#;
        fs::write(temp.path().join("opencode.json"), existing).expect("write existing");

        super::ensure_opencode_config(
            temp.path(),
            Some("rk_test"),
            None,
            Some("Agent"),
            None,
            None,
            None,
        )
        .expect("upsert opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        assert!(
            json["mcp"]["agent-relay"].is_object(),
            "null mcp value must be replaced with a proper object containing the agent-relay server"
        );
    }

    // -----------------------------------------------------------------------
    // Integration tests: MCP config merging end-to-end
    // -----------------------------------------------------------------------

    /// Test A: End-to-end MCP config generation for Claude spawns.
    /// --mcp-config is additive (no --strict-mcp-config) — only Agent Relay is
    /// passed inline; Claude loads the user's .mcp.json servers itself.
    #[tokio::test]
    async fn mcp_e2e_claude_spawn_agent_relay_only() {
        let temp = tempdir().expect("tempdir");
        // User has filesystem and github MCP servers in .mcp.json — Claude
        // will load these independently; we should NOT merge them into --mcp-config.
        fs::write(
            temp.path().join(".mcp.json"),
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

        let args = super::configure_agent_relay_mcp_with_token(
            "claude",
            "TestWorker",
            Some("rk_live_test"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
            Some("tok_abc"),
            None,
            None,
        )
        .await
        .expect("configure claude mcp");

        // Only --mcp-config <json> — no --strict-mcp-config
        assert_eq!(args.len(), 2, "should be --mcp-config <json> only");
        assert_eq!(args[0], "--mcp-config");
        assert!(
            !args.iter().any(|a| a == "--strict-mcp-config"),
            "must not include --strict-mcp-config"
        );

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        let servers = json["mcpServers"].as_object().expect("mcpServers object");

        // Only Agent Relay — user servers loaded separately by Claude from .mcp.json
        assert_eq!(servers.len(), 1, "only Agent Relay server in --mcp-config");
        assert!(
            servers.contains_key("agent-relay"),
            "Agent Relay must be present"
        );

        // Agent Relay has broker-injected credentials
        assert_eq!(
            servers["agent-relay"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("TestWorker")
        );
        assert_eq!(
            servers["agent-relay"]["env"]["RELAY_AGENT_TOKEN"].as_str(),
            Some("tok_abc")
        );
        // RELAY_API_KEY is injected for Claude --mcp-config
        assert_eq!(
            servers["agent-relay"]["env"]["RELAY_API_KEY"].as_str(),
            Some("rk_live_test"),
            "RELAY_API_KEY must be present in Claude --mcp-config"
        );
    }

    /// Test B: Precedence test — project-level .mcp.json overrides global settings.
    /// When the same server name exists at multiple config levels, project wins.
    #[test]
    fn merge_mcp_precedence_project_overrides_global() {
        let temp = tempdir().expect("tempdir");

        // Fake home directory with global settings
        let fake_home = temp.path().join("home");
        let claude_dir = fake_home.join(".claude");
        fs::create_dir_all(&claude_dir).expect("create .claude dir");

        // Global settings.json has "testmcp" with command "global-cmd"
        fs::write(
            claude_dir.join("settings.json"),
            r#"{
                "mcpServers": {
                    "testmcp": { "command": "global-cmd", "args": ["--global"] }
                }
            }"#,
        )
        .expect("write global settings");

        // Local settings.local.json has "testmcp" with command "local-cmd"
        fs::write(
            claude_dir.join("settings.local.json"),
            r#"{
                "mcpServers": {
                    "testmcp": { "command": "local-cmd", "args": ["--local"] }
                }
            }"#,
        )
        .expect("write local settings");

        // Project .mcp.json has "testmcp" with command "project-cmd"
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("create project dir");
        fs::write(
            project.join(".mcp.json"),
            r#"{
                "mcpServers": {
                    "testmcp": { "command": "project-cmd", "args": ["--project"] }
                }
            }"#,
        )
        .expect("write project .mcp.json");

        let merged = super::merge_agent_relay_with_project_mcp_inner(
            Some("rk_key"),
            None,
            Some("agent"),
            None,
            &project,
            Some(fake_home),
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        // Project-level command wins
        assert_eq!(
            servers["testmcp"]["command"].as_str(),
            Some("project-cmd"),
            "project-level config must override global and local"
        );
        let args = servers["testmcp"]["args"].as_array().expect("args array");
        assert_eq!(args[0].as_str(), Some("--project"));
    }

    /// Test B (cont): local settings override global settings.
    #[test]
    fn merge_mcp_precedence_local_overrides_global() {
        let temp = tempdir().expect("tempdir");
        let fake_home = temp.path().join("home");
        let claude_dir = fake_home.join(".claude");
        fs::create_dir_all(&claude_dir).expect("create .claude dir");

        fs::write(
            claude_dir.join("settings.json"),
            r#"{ "mcpServers": { "testmcp": { "command": "global-cmd" } } }"#,
        )
        .expect("write global settings");

        fs::write(
            claude_dir.join("settings.local.json"),
            r#"{ "mcpServers": { "testmcp": { "command": "local-cmd" } } }"#,
        )
        .expect("write local settings");

        // No project .mcp.json
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("create project dir");

        let merged = super::merge_agent_relay_with_project_mcp_inner(
            Some("rk_key"),
            None,
            Some("agent"),
            None,
            &project,
            Some(fake_home),
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        assert_eq!(
            servers["testmcp"]["command"].as_str(),
            Some("local-cmd"),
            "local settings must override global"
        );
    }

    /// Test C: Global-only MCP servers — a server defined only in ~/.claude/settings.json
    /// should still appear in merged output even when no .mcp.json exists.
    #[test]
    fn merge_mcp_global_only_servers_appear_in_output() {
        let temp = tempdir().expect("tempdir");
        let fake_home = temp.path().join("home");
        let claude_dir = fake_home.join(".claude");
        fs::create_dir_all(&claude_dir).expect("create .claude dir");

        fs::write(
            claude_dir.join("settings.json"),
            r#"{
                "mcpServers": {
                    "database": { "command": "npx", "args": ["-y", "db-mcp-server"] },
                    "slack": { "command": "npx", "args": ["-y", "slack-mcp"] }
                }
            }"#,
        )
        .expect("write global settings");

        // No .mcp.json in project
        let project = temp.path().join("project");
        fs::create_dir_all(&project).expect("create project dir");

        let merged = super::merge_agent_relay_with_project_mcp_inner(
            Some("rk_key"),
            None,
            Some("agent"),
            None,
            &project,
            Some(fake_home),
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        assert_eq!(servers.len(), 3, "global servers + Agent Relay");
        assert!(
            servers.contains_key("database"),
            "global database server must appear"
        );
        assert!(
            servers.contains_key("slack"),
            "global slack server must appear"
        );
        assert!(
            servers.contains_key("agent-relay"),
            "Agent Relay must appear"
        );
    }

    /// Test D: Disabled servers — servers with `disabled: true` should be preserved as-is.
    #[test]
    fn merge_mcp_preserves_disabled_servers() {
        let temp = tempdir().expect("tempdir");
        fs::write(
            temp.path().join(".mcp.json"),
            r#"{
                "mcpServers": {
                    "enabled-server": {
                        "command": "npx",
                        "args": ["-y", "enabled-mcp"]
                    },
                    "disabled-server": {
                        "command": "npx",
                        "args": ["-y", "disabled-mcp"],
                        "disabled": true
                    }
                }
            }"#,
        )
        .expect("write .mcp.json");

        let merged = super::merge_agent_relay_with_project_mcp_inner(
            Some("rk_key"),
            None,
            Some("agent"),
            None,
            temp.path(),
            None,
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        // Disabled server is preserved with its disabled flag
        assert!(
            servers.contains_key("disabled-server"),
            "disabled server must be preserved"
        );
        assert_eq!(
            servers["disabled-server"]["disabled"].as_bool(),
            Some(true),
            "disabled flag must be preserved"
        );
        assert_eq!(
            servers["disabled-server"]["command"].as_str(),
            Some("npx"),
            "disabled server config must be intact"
        );

        // Enabled server also present
        assert!(servers.contains_key("enabled-server"));
        assert!(servers.contains_key("agent-relay"));
    }

    /// Test E: Large config — .mcp.json with 10+ servers. All must be preserved plus Agent Relay.
    #[test]
    fn merge_mcp_large_config_preserves_all_servers() {
        let temp = tempdir().expect("tempdir");

        // Build a .mcp.json with 15 servers
        let mut mcp_servers = Map::new();
        for i in 0..15 {
            let name = format!("server-{i}");
            let mut server = Map::new();
            server.insert("command".into(), Value::String(format!("cmd-{i}")));
            server.insert(
                "args".into(),
                Value::Array(vec![Value::String(format!("--port={}", 3000 + i))]),
            );
            let mut env = Map::new();
            env.insert(format!("KEY_{i}"), Value::String(format!("value_{i}")));
            server.insert("env".into(), Value::Object(env));
            mcp_servers.insert(name, Value::Object(server));
        }
        let mut top = Map::new();
        top.insert("mcpServers".into(), Value::Object(mcp_servers));
        let mcp_json = serde_json::to_string_pretty(&Value::Object(top)).expect("serialize");
        fs::write(temp.path().join(".mcp.json"), &mcp_json).expect("write .mcp.json");

        let merged = super::merge_agent_relay_with_project_mcp_inner(
            Some("rk_key"),
            Some("https://api.relaycast.dev"),
            Some("agent"),
            Some("tok_test"),
            temp.path(),
            None,
            None,
            None,
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        let servers = parsed["mcpServers"].as_object().expect("mcpServers");

        // 15 user servers + 1 relaycast = 16
        assert_eq!(
            servers.len(),
            16,
            "all 15 user servers plus relaycast must be present"
        );

        // Verify each user server is present with correct config
        for i in 0..15 {
            let name = format!("server-{i}");
            assert!(
                servers.contains_key(&name),
                "server {name} must be preserved"
            );
            assert_eq!(
                servers[&name]["command"].as_str(),
                Some(format!("cmd-{i}").as_str()),
            );
            assert_eq!(
                servers[&name]["env"][format!("KEY_{i}")].as_str(),
                Some(format!("value_{i}").as_str()),
            );
        }

        // Relaycast is present with broker credentials
        assert!(servers.contains_key("agent-relay"));
        assert_eq!(
            servers["agent-relay"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("agent")
        );
    }

    // -----------------------------------------------------------------------
    // Workspace forwarding tests
    // -----------------------------------------------------------------------

    #[test]
    fn agent_relay_mcp_server_config_includes_workspace_vars() {
        let server = super::agent_relay_mcp_server_config(
            None,
            None,
            None,
            None,
            Some("wj-json"),
            Some("ws-id"),
            None,
        );
        let env = &server["env"];
        assert_eq!(
            env["RELAY_WORKSPACES_JSON"].as_str(),
            Some("wj-json"),
            "RELAY_WORKSPACES_JSON must appear when workspaces_json param is provided"
        );
        assert_eq!(
            env["RELAY_DEFAULT_WORKSPACE"].as_str(),
            Some("ws-id"),
            "RELAY_DEFAULT_WORKSPACE must appear when default_workspace param is provided"
        );
    }

    #[test]
    fn agent_relay_mcp_server_config_includes_agent_result_vars() {
        let schema = json!({
            "type": "object",
            "properties": {
                "ok": { "type": "boolean" }
            },
            "required": ["ok"]
        });
        let schema_json = schema.to_string();
        let config = crate::types::AgentResultMcpConfig {
            callback_url: "http://127.0.0.1:3889/api/agent-result".to_string(),
            token: "arr_test".to_string(),
            schema: Some(schema.clone()),
        };

        let server = super::agent_relay_mcp_server_config(
            None,
            None,
            Some("agent-1"),
            None,
            None,
            None,
            Some(&config),
        );
        let env = &server["env"];

        assert_eq!(
            env["AGENT_RELAY_RESULT_URL"].as_str(),
            Some("http://127.0.0.1:3889/api/agent-result")
        );
        assert_eq!(env["AGENT_RELAY_RESULT_TOKEN"].as_str(), Some("arr_test"));
        assert_eq!(
            env["AGENT_RELAY_RESULT_SCHEMA"].as_str(),
            Some(schema_json.as_str())
        );
    }

    #[test]
    fn agent_relay_mcp_server_config_empty_workspace_vars_omitted() {
        let server = super::agent_relay_mcp_server_config(
            None,
            None,
            None,
            None,
            Some(""),
            Some("  "),
            None,
        );
        // env may be absent (Value::Null) or present but without workspace keys
        let env = &server["env"];
        assert!(
            env["RELAY_WORKSPACES_JSON"].is_null(),
            "empty workspaces_json must be omitted"
        );
        assert!(
            env["RELAY_DEFAULT_WORKSPACE"].is_null(),
            "whitespace-only default_workspace must be omitted"
        );
    }

    #[test]
    fn merge_relaycast_injects_workspace_vars() {
        let temp = tempdir().expect("tempdir");
        let merged = super::merge_agent_relay_with_project_mcp_inner(
            None,
            None,
            None,
            None,
            temp.path(),
            None,
            Some("wj"),
            Some("dw"),
            None,
        );
        let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");
        assert_eq!(
            parsed["mcpServers"]["agent-relay"]["env"]["RELAY_WORKSPACES_JSON"].as_str(),
            Some("wj"),
            "RELAY_WORKSPACES_JSON must be forwarded through merge function"
        );
        assert_eq!(
            parsed["mcpServers"]["agent-relay"]["env"]["RELAY_DEFAULT_WORKSPACE"].as_str(),
            Some("dw"),
            "RELAY_DEFAULT_WORKSPACE must be forwarded through merge function"
        );
    }

    #[tokio::test]
    async fn configure_agent_relay_mcp_with_token_passes_workspace_vars() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp_with_token(
            "claude",
            "worker",
            None,
            None,
            &[],
            temp.path(),
            None,
            Some("wj"),
            Some("dw"),
        )
        .await
        .expect("configure claude mcp with workspace vars");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        let env = &json["mcpServers"]["agent-relay"]["env"];
        assert_eq!(
            env["RELAY_WORKSPACES_JSON"].as_str(),
            Some("wj"),
            "RELAY_WORKSPACES_JSON must appear in --mcp-config env"
        );
        assert_eq!(
            env["RELAY_DEFAULT_WORKSPACE"].as_str(),
            Some("dw"),
            "RELAY_DEFAULT_WORKSPACE must appear in --mcp-config env"
        );
    }

    #[tokio::test]
    async fn configure_agent_relay_mcp_with_token_opencode_headless_call_site() {
        // Mirrors the worker.rs AgentRuntime::Headless call site for opencode:
        // ensures --agent agent-relay is returned and opencode.json is written
        // with the workspace context forwarded through to the MCP environment.
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp_with_token(
            "opencode",
            "headless-worker",
            Some("rk_live_hl"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
            Some("tok_hl_123"),
            Some("[\"ws-a\"]"),
            Some("ws-a"),
        )
        .await
        .expect("configure opencode headless mcp");

        assert_eq!(args, vec!["--agent", "agent-relay"]);

        let path = temp.path().join("opencode.json");
        assert!(path.exists(), "opencode.json must be created");
        let contents = fs::read_to_string(&path).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");
        let env = &json["mcp"]["agent-relay"]["environment"];
        assert_eq!(env["RELAY_API_KEY"].as_str(), Some("rk_live_hl"));
        assert_eq!(env["RELAY_AGENT_TOKEN"].as_str(), Some("tok_hl_123"));
        assert_eq!(env["RELAY_WORKSPACES_JSON"].as_str(), Some("[\"ws-a\"]"));
        assert_eq!(env["RELAY_DEFAULT_WORKSPACE"].as_str(), Some("ws-a"));
    }

    #[tokio::test]
    async fn configure_agent_relay_mcp_with_token_claude_headless_call_site() {
        // Mirrors the worker.rs AgentRuntime::Headless call site for claude:
        // ensures --mcp-config JSON is returned with the workspace context
        // forwarded through to the MCP environment.
        let temp = tempdir().expect("tempdir");
        let args = super::configure_agent_relay_mcp_with_token(
            "claude",
            "headless-worker",
            Some("rk_live_hl"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
            Some("tok_hl_123"),
            Some("[\"ws-a\"]"),
            Some("ws-a"),
        )
        .await
        .expect("configure claude headless mcp");

        assert_eq!(args.len(), 2, "claude should receive flag + JSON payload");
        assert_eq!(args[0], "--mcp-config");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        let env = &json["mcpServers"]["agent-relay"]["env"];
        assert_eq!(env["RELAY_API_KEY"].as_str(), Some("rk_live_hl"));
        assert_eq!(env["RELAY_AGENT_TOKEN"].as_str(), Some("tok_hl_123"));
        assert_eq!(env["RELAY_WORKSPACES_JSON"].as_str(), Some("[\"ws-a\"]"));
        assert_eq!(env["RELAY_DEFAULT_WORKSPACE"].as_str(), Some("ws-a"));
    }

    #[tokio::test]
    async fn configure_agent_relay_mcp_public_reads_env_fallback() {
        // Set env vars before calling the public wrapper
        std::env::set_var("RELAY_WORKSPACES_JSON", "wj-from-env");
        let temp = tempdir().expect("tempdir");
        let args =
            super::configure_agent_relay_mcp("claude", "worker", None, None, &[], temp.path())
                .await
                .expect("configure claude mcp from env");
        std::env::remove_var("RELAY_WORKSPACES_JSON");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        assert_eq!(
            json["mcpServers"]["agent-relay"]["env"]["RELAY_WORKSPACES_JSON"].as_str(),
            Some("wj-from-env"),
            "public configure_agent_relay_mcp must read RELAY_WORKSPACES_JSON from process env"
        );
    }
}
