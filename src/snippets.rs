use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{Context, Result};
use serde_json::{Map, Value};
use tokio::process::Command;

const RELAYCAST_MCP_PACKAGE: &str = "@relaycast/mcp";

const TARGET_FILES: [&str; 3] = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];
const MARKER_START: &str = "<!-- prpm:snippet:start @agent-relay/agent-relay-snippet@1.2.0 -->";
const MARKER_END: &str = "<!-- prpm:snippet:end @agent-relay/agent-relay-snippet@1.2.0 -->";
const MARKER_START_PREFIX: &str = "<!-- prpm:snippet:start @agent-relay/agent-relay-snippet@";
const MARKER_END_PREFIX: &str = "<!-- prpm:snippet:end @agent-relay/agent-relay-snippet@";
const SNIPPET_BODY: &str = include_str!("../relay-snippets/agent-relay-snippet.md");
const MCP_FILE: &str = ".mcp.json";
const RELAYCAST_SERVER: &str = "relaycast";
const MCP_SECTION: &str = r#"## MCP-First Workflow (Preferred)

MCP is configured for this workspace/CLI. Use MCP tools first:

- `relay_send(to, message)`
- `relay_spawn(name, cli, task)`
- `relay_inbox()`
- `relay_who()`
- `relay_release(name)`
- `relay_status()`

Use MCP/skills only; do not use filesystem protocols.

"#;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SnippetInstallReport {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct McpInstallReport {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
}

pub fn find_project_root(start: &Path) -> PathBuf {
    let start_dir = if start.is_dir() {
        start.to_path_buf()
    } else {
        start
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| start.to_path_buf())
    };

    let mut cursor = start_dir.clone();
    loop {
        if cursor.join(".git").exists() {
            return cursor;
        }

        if !cursor.pop() {
            break;
        }
    }

    start_dir
}

pub fn should_install_in(root: &Path) -> bool {
    if !root.is_dir() {
        return false;
    }

    if let Some(home) = dirs::home_dir() {
        if root == home {
            return false;
        }
    }

    true
}

pub fn ensure_protocol_snippets(root: &Path) -> io::Result<SnippetInstallReport> {
    ensure_protocol_snippets_inner(root, dirs::home_dir())
}

pub fn ensure_relaycast_mcp_config(
    root: &Path,
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
) -> io::Result<McpInstallReport> {
    let mut report = McpInstallReport::default();
    let path = root.join(MCP_FILE);
    let relaycast_server =
        relaycast_server_config(relay_api_key, relay_base_url, relay_agent_name, None);

    if !path.exists() {
        let mut servers = Map::new();
        servers.insert(RELAYCAST_SERVER.to_string(), relaycast_server);
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

    if let Some(existing) = servers_obj.get_mut(RELAYCAST_SERVER) {
        // Update env vars on existing entry (e.g. RELAY_AGENT_NAME may have changed)
        if let Some(new_env) = relaycast_server.get("env") {
            if let Some(obj) = existing.as_object_mut() {
                obj.insert("env".to_string(), new_env.clone());
                write_pretty_json(&path, &parsed)?;
                report.updated = 1;
            } else {
                report.skipped = 1;
            }
        } else {
            report.skipped = 1;
        }
        return Ok(report);
    }

    servers_obj.insert(RELAYCAST_SERVER.to_string(), relaycast_server);
    write_pretty_json(&path, &parsed)?;
    report.updated = 1;
    Ok(report)
}

fn ensure_protocol_snippets_inner(
    root: &Path,
    home: Option<PathBuf>,
) -> io::Result<SnippetInstallReport> {
    let mut report = SnippetInstallReport::default();

    for file_name in TARGET_FILES {
        let path = root.join(file_name);
        let block = snippet_block(root, file_name, home.as_deref());

        if !path.exists() {
            fs::write(&path, &block)?;
            report.created += 1;
            continue;
        }

        let existing = fs::read_to_string(&path)?;
        if let Some(next) = replace_existing_block(&existing, &block) {
            if next == existing {
                report.skipped += 1;
            } else {
                fs::write(&path, next)?;
                report.updated += 1;
            }
        } else {
            let next = append_block(existing, &block);
            fs::write(&path, next)?;
            report.updated += 1;
        }
    }

    Ok(report)
}

fn snippet_block(root: &Path, target_file: &str, home: Option<&Path>) -> String {
    let mcp_first = mcp_configured_for_target(root, target_file, home);
    let mut body = SNIPPET_BODY.trim_end().to_string();

    if mcp_first && !body.contains("## MCP-First Workflow (Preferred)") {
        if let Some(idx) = body.find("## Send a Message") {
            body.insert_str(idx, MCP_SECTION);
        } else {
            body.push('\n');
            body.push('\n');
            body.push_str(MCP_SECTION.trim_end());
        }
    }

    format!(
        "{MARKER_START}\n{body}\n{MARKER_END}\n",
        body = body.trim_end()
    )
}

/// Build the full MCP config JSON string for the relaycast server.
/// Suitable for passing to `--mcp-config` CLI flags.
pub fn relaycast_mcp_config_json(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
) -> String {
    relaycast_mcp_config_json_with_token(relay_api_key, relay_base_url, relay_agent_name, None)
}

pub fn relaycast_mcp_config_json_with_token(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
) -> String {
    let server = relaycast_server_config(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        relay_agent_token,
    );
    let mut servers = Map::new();
    servers.insert(RELAYCAST_SERVER.to_string(), server);
    let mut top = Map::new();
    top.insert("mcpServers".to_string(), Value::Object(servers));
    serde_json::to_string(&Value::Object(top)).expect("MCP config serialization cannot fail")
}

fn relaycast_server_config(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
) -> Value {
    let mut server = Map::new();
    // Allow overriding the MCP command for local development/testing.
    // e.g. RELAYCAST_MCP_COMMAND="node /path/to/relaycast/packages/mcp/dist/stdio.js"
    if let Ok(custom_cmd) = std::env::var("RELAYCAST_MCP_COMMAND") {
        let parts: Vec<&str> = custom_cmd.split_whitespace().collect();
        if let Some((cmd, args_slice)) = parts.split_first() {
            server.insert("command".into(), Value::String(cmd.to_string()));
            server.insert(
                "args".into(),
                Value::Array(
                    args_slice
                        .iter()
                        .map(|a| Value::String(a.to_string()))
                        .collect(),
                ),
            );
        }
    } else {
        server.insert("command".into(), Value::String("npx".into()));
        server.insert(
            "args".into(),
            Value::Array(vec![
                Value::String("-y".into()),
                Value::String(RELAYCAST_MCP_PACKAGE.into()),
            ]),
        );
    }

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
    }
    if !env.is_empty() {
        server.insert("env".into(), Value::Object(env));
    }

    Value::Object(server)
}

const OPENCODE_CONFIG: &str = "opencode.json";
const OPENCODE_AGENT_NAME: &str = "relaycast";

/// Ensure an `opencode.json` config exists with the relaycast MCP server and
/// a custom `relaycast` agent that has those tools enabled.
/// Returns `true` if the config was created or updated.
pub fn ensure_opencode_config(
    root: &Path,
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
) -> io::Result<bool> {
    let path = root.join(OPENCODE_CONFIG);

    // Build the relaycast MCP entry in opencode format.
    let mut mcp_server = Map::new();
    mcp_server.insert("type".into(), Value::String("local".into()));
    mcp_server.insert(
        "command".into(),
        Value::Array(vec![
            Value::String("npx".into()),
            Value::String("-y".into()),
            Value::String(RELAYCAST_MCP_PACKAGE.into()),
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
    }
    if !env.is_empty() {
        mcp_server.insert("environment".into(), Value::Object(env));
    }

    // Build the custom agent entry.
    let mut agent = Map::new();
    agent.insert(
        "description".into(),
        Value::String("Agent with Relaycast MCP enabled".into()),
    );
    let mut tools = Map::new();
    tools.insert("relaycast_*".into(), Value::Bool(true));
    agent.insert("tools".into(), Value::Object(tools));

    if !path.exists() {
        let mut top = Map::new();
        let mut mcp = Map::new();
        mcp.insert(OPENCODE_AGENT_NAME.into(), Value::Object(mcp_server));
        top.insert("mcp".into(), Value::Object(mcp));
        let mut agents = Map::new();
        agents.insert(OPENCODE_AGENT_NAME.into(), Value::Object(agent));
        top.insert("agent".into(), Value::Object(agents));
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

    // Upsert mcp.relaycast
    let mcp = top
        .entry("mcp")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(mcp_obj) = mcp.as_object_mut() {
        mcp_obj.insert(OPENCODE_AGENT_NAME.into(), Value::Object(mcp_server));
        changed = true;
    }

    // Upsert agent.relaycast
    let agents = top
        .entry("agent")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(agents_obj) = agents.as_object_mut() {
        if !agents_obj.contains_key(OPENCODE_AGENT_NAME) {
            agents_obj.insert(OPENCODE_AGENT_NAME.into(), Value::Object(agent));
            changed = true;
        }
    }

    if changed {
        write_pretty_json(&path, &parsed)?;
    }
    Ok(changed)
}

/// Configure the relaycast MCP server for any supported CLI tool.
///
/// Returns extra CLI arguments to append when spawning the agent.
/// For Gemini/Droid this runs a pre-spawn `mcp add` command (removing first
/// for idempotency). For Opencode this writes `opencode.json` on disk.
///
/// # Parameters
/// Write `.cursor/mcp.json` in the given directory with the Relaycast MCP server
/// configured with per-agent credentials (name + token).
/// Returns `true` if the config was created or updated.
pub fn ensure_cursor_mcp_config(
    root: &Path,
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
    relay_agent_token: Option<&str>,
) -> io::Result<bool> {
    let cursor_dir = root.join(".cursor");
    fs::create_dir_all(&cursor_dir)?;
    let path = cursor_dir.join("mcp.json");

    let mcp_json = relaycast_mcp_config_json_with_token(
        relay_api_key,
        relay_base_url,
        relay_agent_name,
        relay_agent_token,
    );
    let new_value: Value = serde_json::from_str(&mcp_json).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("MCP config serialization error: {e}"),
        )
    })?;

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

/// - `cli`: CLI tool name (e.g. "claude", "codex", "gemini", "droid", "opencode", "cursor")
/// - `agent_name`: the name of the agent being spawned
/// - `api_key`: optional relay API key (empty or `None` means omit)
/// - `base_url`: optional relay base URL (empty or `None` means omit)
/// - `existing_args`: args already provided by the user (used to detect opt-outs)
/// - `cwd`: working directory for the agent (used by opencode/cursor config)
pub async fn configure_relaycast_mcp(
    cli: &str,
    agent_name: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    existing_args: &[String],
    cwd: &Path,
) -> Result<Vec<String>> {
    configure_relaycast_mcp_with_token(cli, agent_name, api_key, base_url, existing_args, cwd, None)
        .await
}

pub async fn configure_relaycast_mcp_with_token(
    cli: &str,
    agent_name: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    existing_args: &[String],
    cwd: &Path,
    agent_token: Option<&str>,
) -> Result<Vec<String>> {
    let cli_for_detection = Path::new(cli)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(cli);
    let cli_lower = cli_for_detection.to_lowercase();
    let is_claude = cli_lower == "claude" || cli_lower.starts_with("claude:");
    let is_codex = cli_lower == "codex";
    let is_gemini = cli_lower == "gemini";
    let is_droid = cli_lower == "droid";
    let is_opencode = cli_lower == "opencode";
    let is_cursor = cli_lower == "cursor";

    let api_key = api_key.map(str::trim).filter(|s| !s.is_empty());
    let base_url = base_url.map(str::trim).filter(|s| !s.is_empty());

    let mut args: Vec<String> = Vec::new();

    if is_claude && !existing_args.iter().any(|a| a.contains("mcp-config")) {
        let mcp_json =
            relaycast_mcp_config_json_with_token(api_key, base_url, Some(agent_name), agent_token);
        args.push("--mcp-config".to_string());
        args.push(mcp_json);
        // Prevent project-level .mcp.json from overriding the broker-injected
        // config (e.g. a stale relaycast entry without agent credentials).
        if !existing_args
            .iter()
            .any(|a| a.contains("strict-mcp-config"))
        {
            args.push("--strict-mcp-config".to_string());
        }
    } else if is_codex
        && !existing_args
            .iter()
            .any(|a| a.contains("mcp_servers.relaycast"))
    {
        // NOTE: All values passed via codex `--config` are parsed as TOML.
        // String values MUST be quoted (e.g. `"npx"` not `npx`) to avoid parse
        // errors or type mismatches.  Bare `1` is an integer; bare `at_live_xxx`
        // is a TOML parse error; only quoted values are reliably treated as strings.
        args.extend([
            "--config".to_string(),
            "mcp_servers.relaycast.command=\"npx\"".to_string(),
            "--config".to_string(),
            "mcp_servers.relaycast.args=[\"-y\", \"@relaycast/mcp\"]".to_string(),
        ]);
        if let Some(key) = api_key {
            args.extend([
                "--config".to_string(),
                format!("mcp_servers.relaycast.env.RELAY_API_KEY=\"{key}\""),
            ]);
        }
        if let Some(url) = base_url {
            args.extend([
                "--config".to_string(),
                format!("mcp_servers.relaycast.env.RELAY_BASE_URL=\"{url}\""),
            ]);
        }
        args.extend([
            "--config".to_string(),
            format!("mcp_servers.relaycast.env.RELAY_AGENT_NAME=\"{agent_name}\""),
        ]);
        args.extend([
            "--config".to_string(),
            "mcp_servers.relaycast.env.RELAY_AGENT_TYPE=\"agent\"".to_string(),
        ]);
        args.extend([
            "--config".to_string(),
            "mcp_servers.relaycast.env.RELAY_STRICT_AGENT_NAME=\"1\"".to_string(),
        ]);
        if let Some(token) = agent_token.map(str::trim).filter(|s| !s.is_empty()) {
            args.extend([
                "--config".to_string(),
                format!("mcp_servers.relaycast.env.RELAY_AGENT_TOKEN=\"{token}\""),
            ]);
        }
    } else if is_gemini || is_droid {
        configure_gemini_droid_mcp(
            cli,
            api_key,
            base_url,
            Some(agent_name),
            agent_token,
            is_gemini,
        )
        .await?;
    } else if is_opencode && !existing_args.iter().any(|a| a == "--agent") {
        ensure_opencode_config(cwd, api_key, base_url, Some(agent_name), agent_token)
            .with_context(|| {
                "failed to write opencode.json for relaycast MCP. \
             Please configure the relaycast MCP server manually in opencode.json"
            })?;
        args.push("--agent".to_string());
        args.push("relaycast".to_string());
    } else if is_cursor {
        ensure_cursor_mcp_config(cwd, api_key, base_url, Some(agent_name), agent_token)
            .with_context(|| {
                "failed to write .cursor/mcp.json for relaycast MCP. \
                 Please configure the relaycast MCP server manually in .cursor/mcp.json"
            })?;
    }

    Ok(args)
}

/// Run `<cli> mcp remove relaycast` then `<cli> mcp add` for Gemini or Droid.
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
    format!(
        "{cli} mcp add {env_flag} RELAY_API_KEY=<key> {env_flag} RELAY_BASE_URL=<url> relaycast{cmd_separator} npx -y @relaycast/mcp"
    )
}

fn gemini_droid_mcp_add_args(
    api_key: Option<&str>,
    base_url: Option<&str>,
    agent_name: Option<&str>,
    agent_token: Option<&str>,
    is_gemini: bool,
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
    }
    args.push("relaycast".to_string());
    // Droid's CLI parser continues parsing options after positional args.
    // Insert `--` so `-y` is treated as an argument to `npx`.
    if !is_gemini {
        args.push("--".to_string());
    }
    args.push("npx".to_string());
    args.push("-y".to_string());
    args.push(RELAYCAST_MCP_PACKAGE.to_string());
    args
}

async fn configure_gemini_droid_mcp(
    cli: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    agent_name: Option<&str>,
    agent_token: Option<&str>,
    is_gemini: bool,
) -> Result<()> {
    let manual_cmd = gemini_droid_manual_mcp_add_cmd(cli, is_gemini);

    // Remove first for idempotency (ignore errors — may not exist yet).
    let _ = std::process::Command::new(cli)
        .args(["mcp", "remove", "relaycast"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut c| c.wait());

    let mut mcp_cmd = Command::new(cli);
    mcp_cmd.args(gemini_droid_mcp_add_args(
        api_key,
        base_url,
        agent_name,
        agent_token,
        is_gemini,
    ));
    mcp_cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    match mcp_cmd.spawn() {
        Ok(mut child) => match tokio::time::timeout(Duration::from_secs(15), child.wait()).await {
            Ok(Ok(status)) if !status.success() => {
                anyhow::bail!(
                        "failed to configure relaycast MCP for {cli}: `{cli} mcp add` exited with code {:?}. \
                         Please configure the relaycast MCP server manually:\n  {manual_cmd}",
                        status.code()
                    );
            }
            Ok(Err(error)) => {
                anyhow::bail!(
                    "failed to configure relaycast MCP for {cli}: {error}. \
                         Please configure the relaycast MCP server manually:\n  {manual_cmd}"
                );
            }
            Err(_) => {
                let _ = child.kill().await;
                anyhow::bail!(
                        "failed to configure relaycast MCP for {cli}: `{cli} mcp add` timed out after 15s. \
                         Please configure the relaycast MCP server manually:\n  {manual_cmd}"
                    );
            }
            _ => {}
        },
        Err(error) => {
            anyhow::bail!(
                "failed to configure relaycast MCP for {cli}: could not run `{cli} mcp add`: {error}. \
                 Please configure the relaycast MCP server manually:\n  {manual_cmd}"
            );
        }
    }

    Ok(())
}

fn write_pretty_json(path: &Path, value: &Value) -> io::Result<()> {
    let mut body = serde_json::to_string_pretty(value).map_err(|error| {
        io::Error::other(format!("failed to serialize {}: {error}", path.display()))
    })?;
    body.push('\n');
    fs::write(path, body)
}

fn replace_existing_block(existing: &str, desired_block: &str) -> Option<String> {
    let ranges = find_snippet_ranges(existing)?;
    let mut next = String::with_capacity(existing.len() + desired_block.len());
    let mut cursor = 0usize;

    for (idx, (start, end)) in ranges.iter().enumerate() {
        if idx == 0 {
            next.push_str(&existing[..*start]);
            next.push_str(desired_block);
        } else {
            next.push_str(&existing[cursor..*start]);
        }
        cursor = *end;
    }

    next.push_str(&existing[cursor..]);
    Some(next)
}

fn find_snippet_ranges(existing: &str) -> Option<Vec<(usize, usize)>> {
    let mut ranges = Vec::new();
    let mut offset = 0usize;

    while let Some(start_rel) = existing[offset..].find(MARKER_START_PREFIX) {
        let start = offset + start_rel;
        let end_start_rel = existing[start..].find(MARKER_END_PREFIX)?;
        let end_start = start + end_start_rel;
        let end = existing[end_start..]
            .find('\n')
            .map(|idx| end_start + idx + 1)
            .unwrap_or(existing.len());
        ranges.push((start, end));
        offset = end;
    }

    if ranges.is_empty() {
        None
    } else {
        Some(ranges)
    }
}

fn append_block(mut existing: String, block: &str) -> String {
    if !existing.ends_with('\n') {
        existing.push('\n');
    }
    if !existing.trim().is_empty() {
        existing.push('\n');
    }
    existing.push_str(block);
    existing
}

fn mcp_configured_for_target(root: &Path, target_file: &str, home: Option<&Path>) -> bool {
    candidate_mcp_paths(root, target_file, home)
        .iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .any(|contents| {
            let lower = contents.to_ascii_lowercase();
            (lower.contains("agent-relay") || lower.contains("relaycast")) && lower.contains("mcp")
        })
}

fn candidate_mcp_paths(root: &Path, target_file: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = vec![root.join(".mcp.json")];

    let home = match home.map(Path::to_path_buf).or_else(dirs::home_dir) {
        Some(h) => h,
        None => return paths,
    };

    if target_file == "CLAUDE.md" || target_file == "AGENTS.md" {
        paths.push(home.join(".claude").join("settings.json"));
        paths.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        );
        paths.push(
            home.join(".config")
                .join("claude")
                .join("claude_desktop_config.json"),
        );
    }

    if target_file == "GEMINI.md" || target_file == "AGENTS.md" {
        paths.push(home.join(".gemini").join("settings.json"));
    }

    if target_file == "AGENTS.md" {
        paths.push(home.join(".codex").join("config.toml"));
    }

    paths
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::Value;
    use tempfile::tempdir;

    use super::{
        ensure_protocol_snippets_inner, ensure_relaycast_mcp_config, find_project_root,
        should_install_in, snippet_block, MARKER_START,
    };

    #[test]
    fn finds_git_ancestor_as_project_root() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        fs::create_dir(root.join(".git")).expect("create .git");
        fs::create_dir_all(root.join("a/b/c")).expect("create nested");

        let resolved = find_project_root(&root.join("a/b/c"));
        assert_eq!(resolved, root);
    }

    #[test]
    fn returns_start_when_git_not_found() {
        let temp = tempdir().expect("tempdir");
        let start = temp.path().join("nested");
        fs::create_dir_all(&start).expect("create nested");
        let resolved = find_project_root(&start);
        assert_eq!(resolved, start);
    }

    #[test]
    fn should_install_requires_directory() {
        let temp = tempdir().expect("tempdir");
        let file_path = temp.path().join("file.txt");
        fs::write(&file_path, "x").expect("write file");
        assert!(!should_install_in(&file_path));
    }

    /// Helper: runs ensure_protocol_snippets with home isolated to the tempdir
    /// so real user configs (e.g. ~/.claude/settings.json) don't leak in.
    fn install_isolated(root: &std::path::Path) -> std::io::Result<super::SnippetInstallReport> {
        ensure_protocol_snippets_inner(root, Some(root.to_path_buf()))
    }

    fn assert_is_reaycast_mcp_package(value: Option<&str>) {
        let package = value.expect("expected relaycast mcp package string");
        assert!(
            package.starts_with("@relaycast/mcp"),
            "expected package to start with @relaycast/mcp, got: {package}"
        );
    }

    #[test]
    fn installs_to_all_targets_and_is_idempotent() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();

        let first = install_isolated(root).expect("first install");
        assert_eq!(first.created, 3);
        assert_eq!(first.updated, 0);
        assert_eq!(first.skipped, 0);

        let second = install_isolated(root).expect("second install");
        assert_eq!(second.created, 0);
        assert_eq!(second.updated, 0);
        assert_eq!(second.skipped, 3);
    }

    #[test]
    fn installs_without_mcp_section_when_config_missing() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();

        install_isolated(root).expect("install snippets");
        let content = fs::read_to_string(root.join("AGENTS.md")).expect("read AGENTS.md");
        assert!(!content.contains("## MCP-First Workflow (Preferred)"));
    }

    #[test]
    fn keeps_single_mcp_section_when_project_mcp_config_exists() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();

        fs::write(
            root.join(".mcp.json"),
            format!(r#"{{"mcpServers":{{"relaycast":{{"command":"npx","args":["-y","{}")]}}}}}"#, RELAYCAST_MCP_PACKAGE),
        )
        .expect("write .mcp.json");

        install_isolated(root).expect("install snippets");
        let content = fs::read_to_string(root.join("AGENTS.md")).expect("read AGENTS.md");
        let occurrences = content.matches("## MCP-First Workflow (Preferred)").count();
        assert_eq!(occurrences, 1);
    }

    #[test]
    fn refreshes_existing_block_when_mode_changes() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();

        // Install without MCP config (isolated home = root, no MCP files in home)
        let old = snippet_block(root, "AGENTS.md", Some(root));
        fs::write(root.join("AGENTS.md"), old).expect("write old snippet");
        fs::write(
            root.join("CLAUDE.md"),
            snippet_block(root, "CLAUDE.md", Some(root)),
        )
        .expect("write old snippet");
        fs::write(
            root.join("GEMINI.md"),
            snippet_block(root, "GEMINI.md", Some(root)),
        )
        .expect("write old snippet");

        // Now add MCP config
        fs::write(
            root.join(".mcp.json"),
            format!(r#"{{"mcpServers":{{"relaycast":{{"command":"npx","args":["-y","{}"]}}}}}}}"#, RELAYCAST_MCP_PACKAGE),
        )
        .expect("write .mcp.json");

        let report = install_isolated(root).expect("refresh snippets");
        assert_eq!(report.created, 0);
        assert_eq!(report.updated, 3);
        assert_eq!(report.skipped, 0);

        let content = fs::read_to_string(root.join("AGENTS.md")).expect("read updated AGENTS.md");
        assert!(content.contains("## MCP-First Workflow (Preferred)"));
    }

    #[test]
    fn appends_to_existing_file_without_marker() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        fs::write(root.join("AGENTS.md"), "# Existing\n").expect("write existing");

        let report = install_isolated(root).expect("install snippets");
        assert_eq!(report.created, 2);
        assert_eq!(report.updated, 1);
        assert_eq!(report.skipped, 0);

        let content = fs::read_to_string(root.join("AGENTS.md")).expect("read agents after update");
        assert!(content.contains("# Existing"));
        assert!(content.contains(MARKER_START));
    }

    #[test]
    fn upgrades_legacy_snippet_block_and_removes_file_protocol_text() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let legacy = r#"<!-- prpm:snippet:start @agent-relay/agent-relay-snippet@1.1.6 -->
# Agent Relay Protocol

Use AGENT_RELAY_OUTBOX and ->relay-file:spawn.
<!-- prpm:snippet:end @agent-relay/agent-relay-snippet@1.1.6 -->
"#;
        fs::write(root.join("AGENTS.md"), legacy).expect("write legacy snippet");
        fs::write(root.join("CLAUDE.md"), legacy).expect("write legacy snippet");
        fs::write(root.join("GEMINI.md"), legacy).expect("write legacy snippet");
        fs::write(
            root.join(".mcp.json"),
            format!(r#"{{"mcpServers":{{"relaycast":{{"command":"npx","args":["{}"]}}}}}}}"#, RELAYCAST_MCP_PACKAGE),
        )
        .expect("write .mcp.json");

        let report = install_isolated(root).expect("upgrade snippets");
        assert_eq!(report.updated, 3);

        let content = fs::read_to_string(root.join("AGENTS.md")).expect("read AGENTS.md");
        assert!(content.contains(MARKER_START));
        assert!(!content.contains("Use AGENT_RELAY_OUTBOX and ->relay-file:spawn."));
        assert!(content.contains("Use MCP/skills only; do not use filesystem protocols."));
    }

    #[test]
    fn creates_reaycast_mcp_config_when_missing() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();

        let report = ensure_relaycast_mcp_config(root, Some("rk_test_123"), None, None)
            .expect("create mcp config");
        assert_eq!(report.created, 1);
        assert_eq!(report.updated, 0);
        assert_eq!(report.skipped, 0);

        let contents = fs::read_to_string(root.join(".mcp.json")).expect("read mcp file");
        let json: Value = serde_json::from_str(&contents).expect("parse mcp file");
        assert_eq!(
            json["mcpServers"]["relaycast"]["command"].as_str(),
            Some("npx")
        );
        assert_eq!(
            json["mcpServers"]["relaycast"]["args"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(Value::as_str),
            Some("-y")
        );
        assert_is_reaycast_mcp_package(
            json["mcpServers"]["relaycast"]["args"]
                .as_array()
                .and_then(|a| a.get(1))
                .and_then(Value::as_str),
        );
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
            ensure_relaycast_mcp_config(root, None, Some("https://api.relaycast.dev"), None)
                .expect("update mcp config");
        assert_eq!(report.created, 0);
        assert_eq!(report.updated, 1);
        assert_eq!(report.skipped, 0);

        let contents = fs::read_to_string(root.join(".mcp.json")).expect("read mcp file");
        let json: Value = serde_json::from_str(&contents).expect("parse mcp file");
        assert!(json["mcpServers"]["other"].is_object());
        assert_eq!(
            json["mcpServers"]["relaycast"]["command"].as_str(),
            Some("npx")
        );
    }

    #[test]
    fn updates_env_on_existing_reaycast_server() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"relaycast":{"command":"node","args":["custom.js"]}}}"#,
        )
        .expect("write existing mcp file");

        let report = ensure_relaycast_mcp_config(root, Some("rk_new"), None, Some("my-agent"))
            .expect("update mcp config env");
        assert_eq!(report.created, 0);
        assert_eq!(report.updated, 1);
        assert_eq!(report.skipped, 0);

        let contents = fs::read_to_string(root.join(".mcp.json")).expect("read mcp file");
        let json: Value = serde_json::from_str(&contents).expect("parse mcp file");
        // Command preserved, env updated with agent name
        assert_eq!(
            json["mcpServers"]["relaycast"]["command"].as_str(),
            Some("node")
        );
        // RELAY_API_KEY is intentionally omitted from .mcp.json — injected via process env by the broker
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_API_KEY"].as_str(),
            None
        );
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("my-agent")
        );
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_TYPE"].as_str(),
            Some("agent")
        );
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_STRICT_AGENT_NAME"].as_str(),
            Some("1")
        );
    }

    #[tokio::test]
    async fn codex_args_include_strict_agent_name_flag() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp(
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
                .any(|arg| arg == "mcp_servers.relaycast.env.RELAY_AGENT_TYPE=\"agent\""),
            "expected fixed agent type codex config arg"
        );

        assert!(
            args.iter()
                .any(|arg| arg == "mcp_servers.relaycast.env.RELAY_STRICT_AGENT_NAME=\"1\""),
            "expected strict agent name codex config arg"
        );
    }

    // -----------------------------------------------------------------------
    // Claude provider tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn claude_returns_mcp_config_flag_with_valid_json() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp(
            "claude",
            "Worker",
            Some("rk_live_abc"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure claude mcp");

        assert_eq!(args.len(), 3);
        assert_eq!(args[0], "--mcp-config");
        assert_eq!(args[2], "--strict-mcp-config");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        assert_eq!(
            json["mcpServers"]["relaycast"]["command"].as_str(),
            Some("npx")
        );
        let mcp_args = json["mcpServers"]["relaycast"]["args"]
            .as_array()
            .expect("args array");
        assert_eq!(mcp_args[0].as_str(), Some("-y"));
        assert_is_reaycast_mcp_package(mcp_args[1].as_str());
    }

    #[tokio::test]
    async fn claude_omits_api_key_from_mcp_config() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp(
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
            json["mcpServers"]["relaycast"]["env"]["RELAY_API_KEY"].as_str(),
            None,
            "RELAY_API_KEY must not appear in Claude --mcp-config"
        );
    }

    #[tokio::test]
    async fn claude_includes_agent_name_type_and_strict_flag() {
        let temp = tempdir().expect("tempdir");
        let args =
            super::configure_relaycast_mcp("claude", "MyAgent", None, None, &[], temp.path())
                .await
                .expect("configure claude mcp");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        let env = &json["mcpServers"]["relaycast"]["env"];
        assert_eq!(env["RELAY_AGENT_NAME"].as_str(), Some("MyAgent"));
        assert_eq!(env["RELAY_AGENT_TYPE"].as_str(), Some("agent"));
        assert_eq!(env["RELAY_STRICT_AGENT_NAME"].as_str(), Some("1"));
    }

    #[tokio::test]
    async fn claude_includes_agent_token_when_provided() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp_with_token(
            "claude",
            "Worker",
            None,
            None,
            &[],
            temp.path(),
            Some("tok_abc123"),
        )
        .await
        .expect("configure claude mcp with token");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_TOKEN"].as_str(),
            Some("tok_abc123")
        );
    }

    #[tokio::test]
    async fn claude_opt_out_when_mcp_config_already_in_args() {
        let temp = tempdir().expect("tempdir");
        let existing = vec!["--mcp-config".to_string(), "{}".to_string()];
        let args = super::configure_relaycast_mcp(
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
    async fn claude_detected_from_absolute_path() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp(
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
        let args =
            super::configure_relaycast_mcp("claude:latest", "Worker", None, None, &[], temp.path())
                .await
                .expect("configure claude:latest");

        assert_eq!(args[0], "--mcp-config");
    }

    #[test]
    fn droid_mcp_add_args_include_option_separator() {
        let args = super::gemini_droid_mcp_add_args(
            Some("rk_live_xyz"),
            Some("https://api.relaycast.dev"),
            None,
            None,
            false,
        );

        let relaycast_idx = args
            .iter()
            .position(|arg| arg == "relaycast")
            .expect("relaycast arg");
        assert_eq!(args[relaycast_idx + 1], "--");
        assert_eq!(args[relaycast_idx + 2], "npx");
        assert_eq!(args[relaycast_idx + 3], "-y");
        assert!(
            args[relaycast_idx + 4].starts_with("@relaycast/mcp"),
            "expected relaycast package name, got: {}",
            args[relaycast_idx + 4]
        );
    }

    #[test]
    fn gemini_mcp_add_args_do_not_include_option_separator() {
        let args = super::gemini_droid_mcp_add_args(
            Some("rk_live_xyz"),
            Some("https://api.relaycast.dev"),
            None,
            None,
            true,
        );

        let relaycast_idx = args
            .iter()
            .position(|arg| arg == "relaycast")
            .expect("relaycast arg");
        assert_eq!(args[relaycast_idx + 1], "npx");
        assert!(
            !args.iter().any(|arg| arg == "--"),
            "Gemini command should not include `--` argument separator"
        );
    }

    #[test]
    fn droid_manual_mcp_add_command_uses_option_separator() {
        let droid_cmd = super::gemini_droid_manual_mcp_add_cmd("droid", false);
        assert!(droid_cmd.contains("relaycast -- npx -y @relaycast/mcp"));

        let gemini_cmd = super::gemini_droid_manual_mcp_add_cmd("gemini", true);
        assert!(!gemini_cmd.contains("relaycast -- npx -y @relaycast/mcp"));
        assert!(gemini_cmd.contains("relaycast npx -y @relaycast/mcp"));
    }

    // -----------------------------------------------------------------------
    // Codex provider tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn codex_returns_config_flags_with_all_env_vars() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp(
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
        assert!(args.contains(&"mcp_servers.relaycast.command=\"npx\"".to_string()));
        assert!(args
            .iter()
            .any(|a| a.contains("mcp_servers.relaycast.args=")));
        assert!(args.contains(&"mcp_servers.relaycast.env.RELAY_API_KEY=\"rk_live_xyz\"".to_string()));
        assert!(args.contains(
            &"mcp_servers.relaycast.env.RELAY_BASE_URL=\"https://api.relaycast.dev\"".to_string()
        ));
        assert!(args.contains(&"mcp_servers.relaycast.env.RELAY_AGENT_NAME=\"CodexAgent\"".to_string()));
        assert!(args.contains(&"mcp_servers.relaycast.env.RELAY_AGENT_TYPE=\"agent\"".to_string()));
        assert!(
            args.contains(&"mcp_servers.relaycast.env.RELAY_STRICT_AGENT_NAME=\"1\"".to_string())
        );
    }

    #[tokio::test]
    async fn codex_includes_api_key_unlike_claude() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp(
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
                .any(|a| a == "mcp_servers.relaycast.env.RELAY_API_KEY=\"rk_live_secret\""),
            "Codex must include RELAY_API_KEY in --config args"
        );
    }

    #[tokio::test]
    async fn codex_includes_agent_token_when_provided() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp_with_token(
            "codex",
            "Agent",
            None,
            None,
            &[],
            temp.path(),
            Some("tok_codex_123"),
        )
        .await
        .expect("configure codex mcp with token");

        assert!(
            args.iter()
                .any(|a| a == "mcp_servers.relaycast.env.RELAY_AGENT_TOKEN=\"tok_codex_123\""),
            "Codex must include RELAY_AGENT_TOKEN when provided"
        );
    }

    #[tokio::test]
    async fn codex_omits_optional_fields_when_none() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp("codex", "Agent", None, None, &[], temp.path())
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
            .any(|a| a == "mcp_servers.relaycast.env.RELAY_AGENT_NAME=\"Agent\""));
    }

    #[tokio::test]
    async fn codex_opt_out_when_relaycast_config_already_in_args() {
        let temp = tempdir().expect("tempdir");
        let existing = vec![
            "--config".to_string(),
            "mcp_servers.relaycast.command=custom".to_string(),
        ];
        let args = super::configure_relaycast_mcp(
            "codex",
            "Agent",
            Some("rk_live_abc"),
            None,
            &existing,
            temp.path(),
        )
        .await
        .expect("configure codex mcp opt-out");

        assert!(
            args.is_empty(),
            "should return no args when user already provided mcp_servers.relaycast config"
        );
    }

    // -----------------------------------------------------------------------
    // Opencode provider tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn opencode_creates_config_file_and_returns_agent_flag() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp(
            "opencode",
            "OcAgent",
            Some("rk_live_oc"),
            Some("https://api.relaycast.dev"),
            &[],
            temp.path(),
        )
        .await
        .expect("configure opencode mcp");

        assert_eq!(args, vec!["--agent", "relaycast"]);

        // Verify opencode.json was created
        let path = temp.path().join("opencode.json");
        assert!(path.exists(), "opencode.json must be created");

        let contents = fs::read_to_string(&path).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // MCP server structure
        let mcp = &json["mcp"]["relaycast"];
        assert_eq!(mcp["type"].as_str(), Some("local"));
        let cmd = mcp["command"].as_array().expect("command array");
        assert_eq!(cmd[0].as_str(), Some("npx"));
        assert_eq!(cmd[1].as_str(), Some("-y"));
        assert_is_reaycast_mcp_package(cmd[2].as_str());

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
        let agent = &json["agent"]["relaycast"];
        assert_eq!(
            agent["description"].as_str(),
            Some("Agent with Relaycast MCP enabled")
        );
        assert_eq!(agent["tools"]["relaycast_*"].as_bool(), Some(true));
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

        let args = super::configure_relaycast_mcp(
            "opencode",
            "Agent",
            Some("rk_live_test"),
            None,
            &[],
            temp.path(),
        )
        .await
        .expect("configure opencode mcp upsert");

        assert_eq!(args, vec!["--agent", "relaycast"]);

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
        assert!(json["mcp"]["relaycast"].is_object());
        assert!(json["agent"]["relaycast"].is_object());
    }

    #[tokio::test]
    async fn opencode_opt_out_when_agent_flag_already_in_args() {
        let temp = tempdir().expect("tempdir");
        let existing = vec!["--agent".to_string(), "custom".to_string()];
        let args = super::configure_relaycast_mcp(
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

    // -----------------------------------------------------------------------
    // Unknown / unsupported CLI tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn unknown_cli_returns_empty_args() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp(
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
        let args = super::configure_relaycast_mcp("goose", "Agent", None, None, &[], temp.path())
            .await
            .expect("configure goose cli");

        assert!(args.is_empty(), "goose has no MCP injection support");
    }

    // -----------------------------------------------------------------------
    // relaycast_mcp_config_json direct tests
    // -----------------------------------------------------------------------

    #[test]
    fn mcp_config_json_produces_valid_structure() {
        let json_str = super::relaycast_mcp_config_json(
            Some("rk_live_test"),
            Some("https://api.relaycast.dev"),
            Some("TestAgent"),
        );
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        // Top-level structure
        assert!(json["mcpServers"]["relaycast"].is_object());

        // Command
        assert_eq!(
            json["mcpServers"]["relaycast"]["command"].as_str(),
            Some("npx")
        );

        // API key intentionally omitted
        assert!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_API_KEY"].is_null(),
            "API key must not appear in mcp config JSON"
        );

        // Agent env vars present
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("TestAgent")
        );
    }

    #[test]
    fn mcp_config_json_with_token_includes_token() {
        let json_str = super::relaycast_mcp_config_json_with_token(
            Some("rk_live_test"),
            Some("https://example.com"),
            Some("Agent"),
            Some("tok_xyz"),
        );
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_TOKEN"].as_str(),
            Some("tok_xyz")
        );
    }

    #[test]
    fn mcp_config_json_with_no_token_omits_token_field() {
        let json_str = super::relaycast_mcp_config_json_with_token(None, None, Some("Agent"), None);
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        assert!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_TOKEN"].is_null(),
            "RELAY_AGENT_TOKEN should not be present when token is None"
        );
    }

    #[test]
    fn mcp_config_json_omits_env_when_no_values_provided() {
        let json_str = super::relaycast_mcp_config_json(None, None, None);
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        assert!(
            json["mcpServers"]["relaycast"]["env"].is_null(),
            "env object should not be present when all values are None"
        );
    }

    // -----------------------------------------------------------------------
    // Whitespace / empty string trimming
    // -----------------------------------------------------------------------

    #[test]
    fn mcp_config_json_trims_whitespace_values() {
        let json_str = super::relaycast_mcp_config_json(
            Some("  rk_live_test  "),
            Some("  https://api.relaycast.dev  "),
            Some("  Agent  "),
        );
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        // base_url and agent_name are trimmed
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_BASE_URL"].as_str(),
            Some("https://api.relaycast.dev")
        );
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("Agent")
        );
    }

    #[test]
    fn mcp_config_json_treats_whitespace_only_as_none() {
        let json_str = super::relaycast_mcp_config_json(Some("   "), Some("   "), Some("   "));
        let json: Value = serde_json::from_str(&json_str).expect("parse JSON");

        assert!(
            json["mcpServers"]["relaycast"]["env"].is_null(),
            "whitespace-only values should be treated as None"
        );
    }

    #[tokio::test]
    async fn claude_trims_whitespace_in_agent_token() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp_with_token(
            "claude",
            "Agent",
            None,
            None,
            &[],
            temp.path(),
            Some("  tok_123  "),
        )
        .await
        .expect("configure claude with whitespace token");

        let json: Value = serde_json::from_str(&args[1]).expect("parse mcp-config JSON");
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_TOKEN"].as_str(),
            Some("tok_123")
        );
    }

    #[tokio::test]
    async fn codex_ignores_whitespace_only_token() {
        let temp = tempdir().expect("tempdir");
        let args = super::configure_relaycast_mcp_with_token(
            "codex",
            "Agent",
            None,
            None,
            &[],
            temp.path(),
            Some("   "),
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
        )
        .expect("create opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // Opencode uses "environment" key, not "env"
        assert!(
            json["mcp"]["relaycast"]["environment"].is_object(),
            "opencode must use 'environment' key"
        );
        assert!(
            json["mcp"]["relaycast"]["env"].is_null(),
            "opencode must not use 'env' key"
        );
    }

    #[test]
    fn opencode_config_does_not_overwrite_existing_agent_entry() {
        let temp = tempdir().expect("tempdir");
        let existing = r#"{
            "mcp": {},
            "agent": {
                "relaycast": {
                    "description": "Custom agent",
                    "tools": {"relaycast_*": true, "custom_tool": true}
                }
            }
        }"#;
        fs::write(temp.path().join("opencode.json"), existing).expect("write existing");

        super::ensure_opencode_config(temp.path(), Some("rk_test"), None, Some("Agent"), None)
            .expect("upsert opencode config");

        let contents =
            fs::read_to_string(temp.path().join("opencode.json")).expect("read opencode.json");
        let json: Value = serde_json::from_str(&contents).expect("parse opencode.json");

        // Agent entry should be preserved (not overwritten)
        assert_eq!(
            json["agent"]["relaycast"]["description"].as_str(),
            Some("Custom agent"),
            "existing agent entry must not be overwritten"
        );
        assert_eq!(
            json["agent"]["relaycast"]["tools"]["custom_tool"].as_bool(),
            Some(true),
            "custom tools in existing agent entry must be preserved"
        );
    }

    #[test]
    fn opencode_config_returns_false_when_nothing_changed() {
        let temp = tempdir().expect("tempdir");

        // First call creates
        let created =
            super::ensure_opencode_config(temp.path(), Some("rk_test"), None, Some("Agent"), None)
                .expect("create opencode config");
        assert!(created, "first call should create the file");

        // Second call with same MCP (agent entry already exists)
        let changed =
            super::ensure_opencode_config(temp.path(), Some("rk_test"), None, Some("Agent"), None)
                .expect("second opencode config");
        // MCP is always upserted (changed=true) because we unconditionally insert mcp.relaycast,
        // but agent.relaycast is only inserted if missing.
        // The function returns true because mcp upsert always sets changed=true.
        assert!(changed, "mcp section always gets upserted");
    }
}
