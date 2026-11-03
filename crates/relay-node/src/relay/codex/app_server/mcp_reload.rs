//! Reload only an already-running daemon, then inspect each exact loaded
//! thread on that same connection. An acknowledgement is never readiness.
use super::*;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct McpReloadReport {
    pub loaded: BTreeSet<String>,
    pub verified: BTreeSet<String>,
    pub absent: BTreeSet<String>,
}

pub fn reload_mcp(
    stream: &mut dyn ProxyStream,
    server: &str,
    timeout: Duration,
) -> io::Result<McpReloadReport> {
    refresh_mcp(stream, server, true, timeout)
}

pub fn refresh_mcp(
    stream: &mut dyn ProxyStream,
    server: &str,
    reload: bool,
    timeout: Duration,
) -> io::Result<McpReloadReport> {
    let deadline = Instant::now() + timeout;
    let mut client = Client::open(stream, deadline)?;
    let loaded = loaded(&mut client, deadline)?;
    if reload {
        client.send(
            &json!({"method":"config/mcpServer/reload", "id":70, "params":{}}),
            deadline,
        )?;
        let response = client.response(70, deadline)?;
        if response.get("error").is_some_and(|error| !error.is_null())
            || !response["result"].is_object()
        {
            return Err(io::Error::other(
                "Codex did not accept the MCP configuration refresh",
            ));
        }
    }
    let mut report = McpReloadReport {
        loaded,
        ..Default::default()
    };
    for (index, thread) in report.loaded.iter().enumerate() {
        let id = 71 + index as i64;
        client.send(
            &json!({"method":"mcpServerStatus/list", "id":id, "params":{
                "threadId":thread, "serverName":server, "detail":"toolsAndAuthOnly",
            }}),
            deadline,
        )?;
        let response = client.response(id, deadline)?;
        if absent_server(&response, server) {
            report.absent.insert(thread.clone());
        }
        if connected_server(&response, server) {
            report.verified.insert(thread.clone());
        }
    }
    Ok(report)
}

fn absent_server(response: &Value, name: &str) -> bool {
    let result = &response["result"];
    response.get("error").is_none_or(Value::is_null)
        && result.get("nextCursor").is_some_and(Value::is_null)
        && result["data"].as_array().is_some_and(|servers| {
            servers
                .iter()
                .all(|server| server["name"].as_str().is_some_and(|server| server != name))
        })
}

pub fn connected_server(response: &Value, name: &str) -> bool {
    let result = &response["result"];
    response.get("error").is_none_or(Value::is_null)
        && result.get("nextCursor").is_some_and(Value::is_null)
        && result["data"].as_array().is_some_and(|servers| {
            servers.len() == 1 && {
                let server = &servers[0];
                server["name"] == name
                    && server["runtimeStatus"] == "connected"
                    // Header-helper auth is deliberately reported as Unknown
                    // by codex-mcp/src/mcp/auth.rs: status never executes the
                    // helper to classify credentials. This proves a connected
                    // tool catalog, not independent bearer or actor authority.
                    && matches!(server["authStatus"].as_str(), Some("bearerToken" | "unknown"))
                    && server.get("toolsError").is_none_or(Value::is_null)
                    && [
                        "list_relay_agents",
                        "send_relay_message",
                        "search_shared_sessions",
                    ]
                    .iter()
                    .all(|name| {
                        server["tools"]
                            .as_object()
                            .is_some_and(|tools| tools.contains_key(*name))
                    })
            }
        })
}

fn loaded(client: &mut Client<'_>, deadline: Instant) -> io::Result<BTreeSet<String>> {
    let mut threads = BTreeSet::new();
    let mut cursor = None;
    for page in 0..20 {
        let id = 2000 + page;
        let mut params = json!({"limit":1000});
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        client.send(
            &json!({"method":"thread/loaded/list","id":id,"params":params}),
            deadline,
        )?;
        let response = client.response(id, deadline)?;
        let data = response["result"]["data"]
            .as_array()
            .ok_or_else(|| io::Error::other("Codex returned an unreadable loaded-chat list"))?;
        for thread in data {
            let thread = thread
                .as_str()
                .filter(|thread| !thread.is_empty())
                .ok_or_else(|| {
                    io::Error::other("Codex returned an invalid loaded-chat identity")
                })?;
            threads.insert(thread.to_string());
        }
        match response["result"]["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => return Ok(threads),
        }
    }
    Err(io::Error::other(
        "Codex loaded-chat list exceeded its page limit",
    ))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{server_frame, FakeAppServer};
    use super::*;

    #[test]
    fn reload_verifies_exact_loaded_threads_without_resuming_or_starting_turns() {
        let mut server = FakeAppServer::new(|request| {
            let result = match request["method"].as_str()? {
                "thread/loaded/list" => json!({"data":["existing-a","existing-b"]}),
                "config/mcpServer/reload" => json!({}),
                "mcpServerStatus/list" => json!({"nextCursor":null,"data":[{
                    "name":"agent-relay", "runtimeStatus":if request["params"]["threadId"] == "existing-a" {"connected"} else {"starting"},
                    "authStatus":"bearerToken", "tools":{"list_relay_agents":{},"send_relay_message":{},"search_shared_sessions":{}},
                }]}),
                _ => return None,
            };
            Some(server_frame(&json!({"id":request["id"],"result":result})))
        });
        let report = reload_mcp(&mut server, "agent-relay", Duration::from_secs(1)).unwrap();
        assert_eq!(report.loaded.len(), 2);
        assert_eq!(report.verified, BTreeSet::from(["existing-a".into()]));
        let requests = server.seen.lock().unwrap();
        assert!(!requests.iter().any(|r| matches!(
            r["method"].as_str(),
            Some("thread/start" | "thread/resume" | "turn/start")
        )));
        assert!(requests
            .iter()
            .filter(|r| r["method"] == "mcpServerStatus/list")
            .all(|r| r["params"]["serverName"] == "agent-relay"
                && r["params"]["threadId"].is_string()));
    }

    #[test]
    fn reload_records_absence_but_never_treats_status_errors_as_removal() {
        let mut server = FakeAppServer::new(|request| {
            let response = match request["method"].as_str()? {
                "thread/loaded/list" => json!({"result":{"data":["removed", "unreadable"]}}),
                "config/mcpServer/reload" => json!({"result":{}}),
                "mcpServerStatus/list" if request["params"]["threadId"] == "removed" => {
                    json!({"result":{"nextCursor":null,"data":[]}})
                }
                "mcpServerStatus/list" => json!({"error":{"code":-32603,"message":"unavailable"}}),
                _ => return None,
            };
            let mut response = response;
            response["id"] = request["id"].clone();
            Some(server_frame(&response))
        });
        let report = reload_mcp(&mut server, "agent-relay", Duration::from_secs(1)).unwrap();
        assert_eq!(report.absent, BTreeSet::from(["removed".into()]));
        assert_eq!(report.loaded.len(), 2);
        assert!(report.verified.is_empty());
    }

    #[test]
    fn removed_server_requires_complete_successful_absence_proof() {
        assert!(absent_server(
            &json!({"result":{"nextCursor":null,"data":[]}}),
            "agent-relay"
        ));
        for response in [
            json!({"result":{"nextCursor":null,"data":[{"name":"agent-relay","runtimeStatus":"failed"}]}}),
            json!({"result":{"nextCursor":"more","data":[]}}),
            json!({"error":{"message":"unavailable"}}),
            json!({"result":{}}),
        ] {
            assert!(!absent_server(&response, "agent-relay"));
        }
    }

    #[test]
    fn reload_acknowledgement_alone_does_not_prove_tools_or_auth() {
        for response in [
            json!({"result":{}}),
            json!({"result":{"nextCursor":null,"data":[]}}),
            json!({"error":{"message":"unsupported"}}),
        ] {
            assert!(!connected_server(&response, "agent-relay"));
        }
    }

    #[test]
    fn header_helper_status_uses_source_backed_unknown_auth_classification() {
        // Official codex-mcp/src/mcp/auth.rs compute_auth_status deliberately
        // does not execute http_headers_helper during status inspection and
        // falls back to McpAuthState::Unknown when no static/OAuth auth exists.
        // The successful catalog, not that classification, is the live proof.
        let mut response = json!({"result":{"nextCursor":null,"data":[{
            "name":"agent-relay", "runtimeStatus":"connected", "authStatus":"unknown",
            "tools":{"list_relay_agents":{},"send_relay_message":{},"search_shared_sessions":{}},
        }]}});
        assert!(connected_server(&response, "agent-relay"));
        for auth in ["notLoggedIn", "unsupported", "OAuth", "invalid"] {
            response["result"]["data"][0]["authStatus"] = json!(auth);
            assert!(!connected_server(&response, "agent-relay"));
        }
        response["result"]["data"][0]["authStatus"] = json!("unknown");
        response["result"]["data"][0]["tools"] = json!({"list_relay_agents":{}});
        assert!(!connected_server(&response, "agent-relay"));
    }

    #[test]
    fn loaded_chat_pagination_queries_the_next_page_and_bounds_repeating_cursors() {
        let mut server = FakeAppServer::new(|request| {
            let result = match request["method"].as_str()? {
                "thread/loaded/list" if request["params"]["cursor"].is_null() => {
                    json!({"data":["a"],"nextCursor":"page-two"})
                }
                "thread/loaded/list" => {
                    assert_eq!(request["params"]["cursor"], "page-two");
                    json!({"data":["b"],"nextCursor":null})
                }
                "config/mcpServer/reload" => json!({}),
                "mcpServerStatus/list" => json!({"nextCursor":null,"data":[]}),
                _ => return None,
            };
            Some(server_frame(&json!({"id":request["id"],"result":result})))
        });
        let report = reload_mcp(&mut server, "agent-relay", Duration::from_secs(1)).unwrap();
        assert_eq!(report.loaded, BTreeSet::from(["a".into(), "b".into()]));
        let mut looping = FakeAppServer::new(|request| {
            Some(server_frame(
                &json!({"id":request["id"],"result":{"data":[],"nextCursor":"again"}}),
            ))
        });
        assert!(reload_mcp(&mut looping, "agent-relay", Duration::from_secs(1)).is_err());
        assert_eq!(
            looping
                .seen
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["method"] == "thread/loaded/list")
                .count(),
            20
        );
        assert!(!looping
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "config/mcpServer/reload"));
    }
}
