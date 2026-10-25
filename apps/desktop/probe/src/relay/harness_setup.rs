//! Credential-independent guidance and checks for spawned harnesses.
//!
//! This module deliberately contains no MCP server configuration or bearer.
//! The local socket works with the session's verified process identity. A
//! future authorized MCP connection can be checked here after launch, but
//! tool discovery alone never proves permission to call a tool.

use serde_json::{json, Value};

pub const RELAY_MCP_SERVER: &str = "agent-relay-sessions";
pub const CODEX_MCP_STATUS_METHOD: &str = "mcpServerStatus/list";

const REQUIRED_RELAY_TOOLS: [&str; 6] = [
    "list_relay_agents",
    "send_relay_message",
    "list_relay_spawn_targets",
    "spawn_relay_agent",
    "get_relay_spawn_status",
    "release_relay_agent",
];

/// Instructions for a registration whose name and exact address the core
/// verified. The local socket derives the caller from the process, not from
/// these words. Fleet placement stays conditional on separately authorized
/// hosted MCP tools.
pub fn local_socket_instructions(name: &str, address: &str) -> String {
    format!(
        "You are Agent Relay agent @{name}, address {address}. Confirm your identity with GET /whoami on this computer's Agent Relay session socket. Its path is published at ~/.agentworkforce/desktop/relay-socket (relay-socket.dev for Agent Relay Dev). Use GET /agents to discover agents in your workspace and their exact addresses. Use POST /send with exactly one destination, `to` for an agent name or `address` for an exact address, and your message text as the body. The desktop identifies your session from the connecting process; never supply a sender or an agent token. The local roster does not list spawn-capable nodes or available capacity. Do not infer capacity from an agent's address or presence. If you have no authorized fleet tools, ask a coordinator to delegate or report fleet placement unavailable. If an authorized hosted Relay MCP connection is present and its tools are loaded, call list_relay_spawn_targets, choose an exact returned node, then call spawn_relay_agent with a stable idempotency key. Keep the spawn_id and check get_relay_spawn_status until ready, failed, or unknown. Accepted does not mean ready. The codes spawn_capacity_exceeded, spawn_target_unavailable, spawn_target_offline, spawn_harness_unavailable, and capacity_changed end that attempt. Keep the task, read fresh targets, and decide whether to try another node, wait, or report blocked. For an uncertain result, keep the same spawn_id and idempotency key; do not launch a duplicate."
    )
}

/// Params for the installed Codex app-server's `mcpServerStatus/list` request.
/// Its generated JSON schema names `threadId`, `serverName`, and the
/// `toolsAndAuthOnly` detail level. Always query the newly started thread.
pub fn codex_relay_status_params(thread_id: &str) -> Value {
    json!({
        "threadId": thread_id,
        "serverName": RELAY_MCP_SERVER,
        "detail": "toolsAndAuthOnly",
    })
}

/// A `thread/start` (and cold `thread/resume`) `config` override that disables
/// the named inherited MCP servers. Codex recursively merges config tables, so
/// an empty `mcp_servers` object does not clear the person's server entries.
/// The caller must obtain every effective server name and verify the resulting
/// thread status; this helper never reads or contains headers or credentials.
pub fn codex_disable_mcp_config(names: &[String]) -> Value {
    let servers: serde_json::Map<String, Value> = names
        .iter()
        .map(|name| (name.clone(), json!({"enabled": false})))
        .collect();
    json!({"mcp_servers": servers})
}

/// Parse a complete, unfiltered, thread-scoped `mcpServerStatus/list` response.
/// Only an empty inventory or entries positively reported as disabled with no
/// tools counts as zero active MCP servers. A missing/null/failed runtime,
/// pagination, or malformed response fails closed. The caller must pair this
/// response with its own request ID and `threadId`; the response omits both.
pub fn codex_no_mcp_active(status_line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(status_line) else {
        return false;
    };
    // Codex's app-server answers without `"jsonrpc"` (its generated
    // JSONRPCResponse requires only `id` and `result`); one it does send
    // must still say 2.0.
    if value.get("jsonrpc").is_some_and(|version| version != "2.0")
        || !value
            .get("id")
            .is_some_and(|id| id.is_string() || id.is_number())
        || value.get("error").is_some_and(|error| !error.is_null())
    {
        return false;
    }
    let Some(result) = value.get("result") else {
        return false;
    };
    if !result.get("nextCursor").is_some_and(Value::is_null) {
        return false;
    }
    result
        .get("data")
        .and_then(Value::as_array)
        .is_some_and(|servers| {
            servers.iter().all(|server| {
                server
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| !name.is_empty())
                    && server.get("authStatus").and_then(Value::as_str).is_some()
                    && server.get("runtimeStatus").and_then(Value::as_str) == Some("disabled")
                    && server
                        .get("tools")
                        .and_then(Value::as_object)
                        .is_some_and(serde_json::Map::is_empty)
                    && server.get("toolsError").is_none_or(Value::is_null)
            })
        })
}

fn claude_tool_name_matches(actual: &str, required: &str) -> bool {
    actual == format!("mcp__{RELAY_MCP_SERVER}__{required}")
}

/// Scan Claude `--output-format stream-json` records for `system`/`init`.
/// A preceding `session_state_changed` record is normal. For a server passed
/// through `--mcp-config`, Claude 2.1.299 waits for its connection before init;
/// only the exact dynamic server with all advertised tools is accepted. This
/// does not authorize those tools. Spawned agents currently also load the
/// person's own MCP servers (no `--strict-mcp-config`), as the broker does.
pub fn claude_relay_tools_loaded(stream: &str) -> bool {
    stream
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| {
            value.get("type").and_then(Value::as_str) == Some("system")
                && value.get("subtype").and_then(Value::as_str) == Some("init")
        })
        .is_some_and(|init| claude_init_has_relay_tools(&init))
}

fn claude_init_has_relay_tools(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("system")
        || value.get("subtype").and_then(Value::as_str) != Some("init")
    {
        return false;
    }
    let configured = value
        .get("mcp_servers")
        .and_then(Value::as_array)
        .is_some_and(|servers| {
            let mut matching = servers.iter().filter(|server| {
                server.get("name").and_then(Value::as_str) == Some(RELAY_MCP_SERVER)
            });
            matching.next().is_some_and(|server| {
                server.get("source").and_then(Value::as_str) == Some("dynamic")
                    && server.get("status").and_then(Value::as_str) == Some("connected")
            }) && matching.next().is_none()
        });
    if !configured {
        return false;
    }
    value
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            REQUIRED_RELAY_TOOLS.iter().all(|required| {
                tools
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|tool| claude_tool_name_matches(tool, required))
            })
        })
}

/// Parse an app-server JSON-RPC response to `mcpServerStatus/list` for the
/// newly started thread. The installed schema returns `result.data[]` entries
/// with `name`, `runtimeStatus`, `toolsError`, and a `tools` map. A cached tool
/// catalog without a live `connected` runtime is not sufficient.
pub fn codex_relay_tools_loaded(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    if value.get("error").is_some_and(|error| !error.is_null()) {
        return false;
    }
    let Some(data) = value
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    data.iter().any(|server| {
        if server.get("name").and_then(Value::as_str) != Some(RELAY_MCP_SERVER)
            || server.get("runtimeStatus").and_then(Value::as_str) != Some("connected")
            || server
                .get("toolsError")
                .is_some_and(|error| !error.is_null())
        {
            return false;
        }
        let Some(tools) = server.get("tools").and_then(Value::as_object) else {
            return false;
        };
        REQUIRED_RELAY_TOOLS.iter().all(|required| {
            tools
                .get(*required)
                .and_then(|tool| tool.get("name"))
                .and_then(Value::as_str)
                == Some(*required)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_init(status: &str, source: &str, tools: Vec<String>) -> String {
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": "redacted-session",
            "claude_code_version": "2.1.299",
            "mcp_servers": [{"name": RELAY_MCP_SERVER, "status": status, "source": source}],
            "tools": tools,
        })
        .to_string()
    }

    fn claude_tools() -> Vec<String> {
        REQUIRED_RELAY_TOOLS
            .iter()
            .map(|name| format!("mcp__agent-relay-sessions__{name}"))
            .collect()
    }

    fn codex_status(status: Value, tools_error: Value, tools: Value) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": 7,
            "result": {
                "data": [{
                    "name": RELAY_MCP_SERVER,
                    "authStatus": "bearerToken",
                    "runtimeStatus": status,
                    "toolsError": tools_error,
                    "tools": tools,
                    "resources": [],
                    "resourceTemplates": []
                }],
                "nextCursor": null
            }
        })
        .to_string()
    }

    fn codex_tools() -> Value {
        Value::Object(
            REQUIRED_RELAY_TOOLS
                .iter()
                .map(|name| {
                    (
                        (*name).to_string(),
                        json!({"name": name, "inputSchema": {"type": "object"}}),
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn redacted_fixture_records_match_both_parsers() {
        assert!(claude_relay_tools_loaded(include_str!(
            "fixtures/claude-relay-dynamic-connected.jsonl"
        )));
        assert!(!claude_relay_tools_loaded(include_str!(
            "fixtures/claude-relay-pending-unverified.jsonl"
        )));
        assert!(codex_relay_tools_loaded(include_str!(
            "fixtures/codex-relay-status.json"
        )));
    }

    #[test]
    fn local_instructions_do_not_claim_fleet_access() {
        let text = local_socket_instructions("worker", "worker@machine-desktop");
        assert!(text.contains("@worker, address worker@machine-desktop"));
        for route in ["GET /whoami", "GET /agents", "POST /send"] {
            assert!(text.contains(route));
        }
        for code in [
            "spawn_capacity_exceeded",
            "spawn_target_unavailable",
            "spawn_target_offline",
            "spawn_harness_unavailable",
            "capacity_changed",
        ] {
            assert!(text.contains(code));
        }
        assert!(text.contains("If an authorized hosted Relay MCP connection is present"));
    }

    #[test]
    fn claude_requires_connected_init_and_all_own_server_tools() {
        let stream = format!(
            "{}\n{}",
            json!({"type": "system", "subtype": "session_state_changed"}),
            claude_init("connected", "dynamic", claude_tools())
        );
        assert!(claude_relay_tools_loaded(&stream));
        for status in ["pending", "needs-auth", "failed"] {
            assert!(!claude_relay_tools_loaded(&claude_init(
                status,
                "dynamic",
                claude_tools()
            )));
        }
        assert!(!claude_relay_tools_loaded(&claude_init(
            "connected",
            "user",
            claude_tools()
        )));
        let pending_then_connected = format!(
            "{}\n{}",
            claude_init("pending", "dynamic", Vec::new()),
            claude_init("connected", "dynamic", claude_tools())
        );
        assert!(!claude_relay_tools_loaded(&pending_then_connected));
        let duplicate_name = json!({
            "type": "system",
            "subtype": "init",
            "mcp_servers": [
                {"name": RELAY_MCP_SERVER, "status": "connected", "source": "dynamic"},
                {"name": RELAY_MCP_SERVER, "status": "connected", "source": "user"}
            ],
            "tools": claude_tools()
        });
        assert!(!claude_relay_tools_loaded(&duplicate_name.to_string()));
        let mut missing = claude_tools();
        missing.pop();
        assert!(!claude_relay_tools_loaded(&claude_init(
            "connected",
            "dynamic",
            missing
        )));
        let unrelated: Vec<_> = REQUIRED_RELAY_TOOLS
            .iter()
            .map(|name| format!("mcp__other_server__{name}"))
            .collect();
        assert!(!claude_relay_tools_loaded(&claude_init(
            "connected",
            "dynamic",
            unrelated
        )));
    }

    #[test]
    fn claude_ignores_non_init_or_malformed_lines() {
        assert!(!claude_relay_tools_loaded("not json"));
        assert!(!claude_relay_tools_loaded(
            &json!({"type": "assistant", "subtype": "init", "tools": claude_tools(),
                "mcp_servers": [{"name": RELAY_MCP_SERVER, "status": "connected", "source": "dynamic"}]})
            .to_string()
        ));
    }

    #[test]
    fn codex_status_request_is_thread_scoped() {
        assert_eq!(CODEX_MCP_STATUS_METHOD, "mcpServerStatus/list");
        assert_eq!(
            codex_relay_status_params("redacted-thread"),
            json!({"threadId": "redacted-thread", "serverName": RELAY_MCP_SERVER,
                "detail": "toolsAndAuthOnly"})
        );
    }

    #[test]
    fn codex_disable_config_targets_exact_names() {
        assert_eq!(
            codex_disable_mcp_config(&[
                "agent-relay-sessions".to_string(),
                "another-server".to_string()
            ]),
            json!({"mcp_servers": {
                "agent-relay-sessions": {"enabled": false},
                "another-server": {"enabled": false}
            }})
        );
        assert_eq!(codex_disable_mcp_config(&[]), json!({"mcp_servers": {}}));
    }

    #[test]
    fn codex_no_mcp_active_requires_complete_disabled_or_empty_inventory() {
        assert!(codex_no_mcp_active(include_str!(
            "fixtures/codex-no-mcp-active.json"
        )));
        assert!(codex_no_mcp_active(include_str!(
            "fixtures/codex-disabled-mcp.json"
        )));
        let disabled = json!({
            "name": RELAY_MCP_SERVER,
            "runtimeStatus": "disabled",
            "authStatus": "bearerToken",
            "tools": {},
            "toolsError": null,
            "resources": [],
            "resourceTemplates": []
        });
        for status in [
            "connected",
            "notStarted",
            "starting",
            "authenticationRequired",
            "failed",
            "cancelled",
        ] {
            let mut server = disabled.clone();
            server["runtimeStatus"] = json!(status);
            assert!(!codex_no_mcp_active(
                &json!({"jsonrpc": "2.0", "id": 7,
                "result": {"data": [server], "nextCursor": null}})
                .to_string()
            ));
        }
        let mut unknown = disabled.clone();
        unknown["runtimeStatus"] = Value::Null;
        assert!(!codex_no_mcp_active(
            &json!({"jsonrpc": "2.0", "id": 7,
            "result": {"data": [unknown], "nextCursor": null}})
            .to_string()
        ));
        let mut cached_tools = disabled;
        cached_tools["tools"] = json!({"send_relay_message": {"name": "send_relay_message"}});
        assert!(!codex_no_mcp_active(
            &json!({"jsonrpc": "2.0", "id": 7,
            "result": {"data": [cached_tools], "nextCursor": null}})
            .to_string()
        ));
        assert!(!codex_no_mcp_active(
            &json!({"jsonrpc": "2.0", "id": 7,
            "result": {"data": [], "nextCursor": "1"}})
            .to_string()
        ));
        assert!(!codex_no_mcp_active(
            &json!({"jsonrpc": "2.0", "id": 7,
            "result": {"data": []}})
            .to_string()
        ));
        assert!(!codex_no_mcp_active("not json"));
    }

    #[test]
    fn codex_requires_live_connection_and_complete_tool_catalog() {
        assert!(codex_relay_tools_loaded(&codex_status(
            json!("connected"),
            Value::Null,
            codex_tools(),
        )));
        assert!(!codex_relay_tools_loaded(&codex_status(
            json!("failed"),
            Value::Null,
            codex_tools(),
        )));
        assert!(!codex_relay_tools_loaded(&codex_status(
            Value::Null,
            Value::Null,
            codex_tools(),
        )));
        assert!(!codex_relay_tools_loaded(&codex_status(
            json!("connected"),
            json!("discovery failed"),
            codex_tools(),
        )));
        let mut partial = codex_tools();
        partial.as_object_mut().unwrap().remove("spawn_relay_agent");
        assert!(!codex_relay_tools_loaded(&codex_status(
            json!("connected"),
            Value::Null,
            partial,
        )));
    }

    #[test]
    fn codex_rejects_other_server_and_json_rpc_error() {
        let response = codex_status(json!("connected"), Value::Null, codex_tools());
        let different = response.replace(RELAY_MCP_SERVER, "other-server");
        assert!(!codex_relay_tools_loaded(&different));
        assert!(!codex_relay_tools_loaded(
            &json!({"jsonrpc": "2.0", "id": 7, "error": {"code": -32000}}).to_string()
        ));
    }
}
