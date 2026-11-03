//! What `openclaw.json` and OpenClaw's CLI say of the hosted Agent Relay
//! MCP: which `mcp.servers` entry is it, is it on and signed in, and can
//! this OpenClaw sign in at all.

use super::SERVER_NAME;
use crate::relay::openclaw::OpenClawConfig;
use serde_json::Value;

/// The server in `openclaw.json` Connect signs in to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    /// A server already at the hosted MCP's URL, by its name, and whether
    /// it is on (`enabled` is not `false`).
    Existing { name: String, enabled: bool },
    /// None yet; Connect adds `agent_relay`.
    Absent,
    /// `agent_relay` is there with another address.
    Conflict,
}

/// Finds the hosted MCP among `openclaw.json`'s `mcp.servers` (JSON5).
pub fn entry(config: &OpenClawConfig, url: &str) -> Result<Entry, String> {
    let unreadable = || crate::relay::openclaw::Unavailable::UnreadableConfig.reason();
    let text = std::fs::read_to_string(&config.config_path).map_err(|_| unreadable())?;
    let file: Value = json5::from_str(&text).map_err(|_| unreadable())?;
    Ok(entry_in(&file["mcp"]["servers"], url))
}

pub fn entry_in(servers: &Value, url: &str) -> Entry {
    let Some(servers) = servers.as_object() else {
        return Entry::Absent;
    };
    let wanted = url.trim_end_matches('/');
    let at = |server: &Value| {
        server["url"]
            .as_str()
            .is_some_and(|found| found.trim().trim_end_matches('/') == wanted)
    };
    let existing = |name: &str, server: &Value| Entry::Existing {
        name: name.to_string(),
        enabled: server["enabled"].as_bool() != Some(false),
    };
    if let Some(server) = servers.get(SERVER_NAME).filter(|server| at(server)) {
        return existing(SERVER_NAME, server);
    }
    if let Some((name, server)) = servers.iter().find(|(_, server)| at(server)) {
        return existing(name, server);
    }
    if servers.contains_key(SERVER_NAME) {
        Entry::Conflict
    } else {
        Entry::Absent
    }
}

/// What `openclaw mcp status --json` says of the server called `name`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authorization {
    Authorized,
    NotAuthorized,
    /// Saved with `enabled: false`: OpenClaw leaves it out of every session,
    /// signed in or not.
    Disabled,
    /// The server is not listed.
    Missing,
    /// The output is not a status listing, or has no `authStatus`: an
    /// OpenClaw without MCP sign-in.
    Unsupported,
}

/// Reads `mcp status --json`: `{"servers": [...]}`, or a bare array.
/// Only `name`, `enabled` and `authStatus.state` are read; token fields
/// never are.
pub fn authorization(stdout: &str, name: &str) -> Authorization {
    // Plugins may log a line first; the JSON is the rest of the output.
    let parsed = stdout
        .match_indices(['{', '['])
        .find_map(|(at, _)| serde_json::from_str::<Value>(stdout[at..].trim()).ok());
    let Some(parsed) = parsed else {
        return Authorization::Unsupported;
    };
    let Some(servers) = parsed["servers"].as_array().or(parsed.as_array()) else {
        return Authorization::Unsupported;
    };
    let Some(server) = servers
        .iter()
        .find(|server| server["name"].as_str() == Some(name))
    else {
        return Authorization::Missing;
    };
    if server["enabled"].as_bool() == Some(false) {
        return Authorization::Disabled;
    }
    match server["authStatus"]["state"].as_str() {
        None => Authorization::Unsupported,
        Some("authorized") => Authorization::Authorized,
        Some(_) => Authorization::NotAuthorized,
    }
}

/// Whether `openclaw mcp login --help` describes OpenClaw's MCP sign-in
/// (its `--code` option); an OpenClaw without it prints the `mcp` (or
/// top-level) help, or fails.
pub fn supports_login(help: &str) -> bool {
    help.contains("--code")
}

/// Whether OpenClaw refused a command because its running Gateway owns
/// the state (OpenClaw after 2026.10.4: `login` and saved-server changes
/// need the Gateway stopped).
pub fn gateway_owns(output: &str) -> bool {
    output.contains("No local mutation was attempted")
        || output.contains("requires exclusive offline state ownership")
        || output.contains("Cannot admit mcp.")
}
