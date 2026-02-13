use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};

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

pub fn ensure_reaycast_mcp_config(
    root: &Path,
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
) -> io::Result<McpInstallReport> {
    let mut report = McpInstallReport::default();
    let path = root.join(MCP_FILE);
    let relaycast_server = relaycast_server_config(relay_api_key, relay_base_url, relay_agent_name);

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

fn relaycast_server_config(
    relay_api_key: Option<&str>,
    relay_base_url: Option<&str>,
    relay_agent_name: Option<&str>,
) -> Value {
    let mut server = Map::new();
    server.insert("command".into(), Value::String("npx".into()));
    server.insert(
        "args".into(),
        Value::Array(vec![
            Value::String("-y".into()),
            Value::String("@relaycast/mcp".into()),
        ]),
    );

    let mut env = Map::new();
    if let Some(api_key) = relay_api_key.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_API_KEY".into(), Value::String(api_key.to_string()));
    }
    if let Some(base_url) = relay_base_url.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_BASE_URL".into(), Value::String(base_url.to_string()));
    }
    if let Some(name) = relay_agent_name.map(str::trim).filter(|s| !s.is_empty()) {
        env.insert("RELAY_AGENT_NAME".into(), Value::String(name.to_string()));
    }
    if !env.is_empty() {
        server.insert("env".into(), Value::Object(env));
    }

    Value::Object(server)
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
        ensure_protocol_snippets_inner, ensure_reaycast_mcp_config, find_project_root,
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
            r#"{"mcpServers":{"agent-relay":{"command":"npx","args":["@agent-relay/mcp","serve"]}}}"#,
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
            r#"{"mcpServers":{"agent-relay":{"command":"npx","args":["@agent-relay/mcp","serve"]}}}"#,
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
            r#"{"mcpServers":{"relaycast":{"command":"npx","args":["@relaycast/mcp"]}}}"#,
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

        let report = ensure_reaycast_mcp_config(root, Some("rk_test_123"), None, None)
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
        assert_eq!(
            json["mcpServers"]["relaycast"]["args"]
                .as_array()
                .and_then(|a| a.get(1))
                .and_then(Value::as_str),
            Some("@relaycast/mcp")
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
            ensure_reaycast_mcp_config(root, None, Some("https://api.relaycast.dev"), None)
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

        let report = ensure_reaycast_mcp_config(root, Some("rk_new"), None, Some("my-agent"))
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
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_API_KEY"].as_str(),
            Some("rk_new")
        );
        assert_eq!(
            json["mcpServers"]["relaycast"]["env"]["RELAY_AGENT_NAME"].as_str(),
            Some("my-agent")
        );
    }
}
