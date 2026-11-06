//! Normalize caller event names before any subscription side effect.
use crate::relay::protocol::RpcError;
use serde_json::Value;

/// Make the core refuse filtered creation unless the server advertises support.
pub(super) fn require_event_filter_support(value: &Value) -> Result<(), RpcError> {
    if value.get("eventTypes") == Some(&Value::Bool(true)) {
        return Ok(());
    }
    Err(super::failed("Relayfile cannot enforce exact event filters. Upgrade Relayfile before subscribing to exact events."))
}

/// Require the creation response to echo the complete canonical filter.
pub(super) fn require_confirmed_filter(value: &Value, expected: &[String]) -> Result<(), RpcError> {
    if expected.is_empty() || value.get("eventTypes") == Some(&serde_json::json!(expected)) {
        return Ok(());
    }
    Err(super::failed("Relayfile did not confirm the requested event filter. Upgrade Relayfile before subscribing to exact events."))
}

/// Validate exact event names and map only Jira aliases supported by its relay.
pub(crate) fn normalize_event_types(
    provider: &str,
    values: &[String],
) -> Result<Vec<String>, RpcError> {
    if values.len() > 32 {
        return Err(RpcError::invalid_params("Use at most 32 event_types."));
    }
    let mut normalized = Vec::new();
    for value in values {
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
            || !value.as_bytes()[0].is_ascii_alphanumeric()
        {
            return Err(RpcError::invalid_params(
                "event_types must contain non-empty exact provider event names.",
            ));
        }
        let value = if provider == "jira" {
            let lowercase = value.to_ascii_lowercase();
            let native = lowercase.strip_prefix("jira:").unwrap_or(&lowercase);
            let aliases = [
                ("issue_created", "issue.created"),
                ("issue_updated", "issue.updated"),
                ("issue_deleted", "issue.deleted"),
                ("comment_created", "comment.created"),
                ("comment_updated", "comment.updated"),
                ("comment_deleted", "comment.deleted"),
                ("sprint_created", "sprint.created"),
                ("sprint_updated", "sprint.updated"),
                ("sprint_started", "sprint.started"),
                ("sprint_closed", "sprint.closed"),
                ("sprint_deleted", "sprint.deleted"),
            ];
            aliases
                .iter()
                .find(|(alias, canonical)| native == *alias || native == *canonical)
                .map(|(_, canonical)| canonical.to_string())
                .ok_or_else(|| {
                    RpcError::invalid_params(
                        "Unsupported Jira event_types. Choose a registered issue, comment or sprint lifecycle event.",
                    )
                })?
        } else {
            value.clone()
        };
        if value.is_empty() || !value.as_bytes()[0].is_ascii_alphanumeric() {
            return Err(RpcError::invalid_params(
                "event_types must contain non-empty exact provider event names.",
            ));
        }
        normalized.push(value);
    }
    normalized.sort();
    normalized.dedup();
    Ok(normalized)
}

/// Finite PR subscriptions rely on the terminal event to remove their resources.
/// Refuse incompatible filters before connecting or creating anything; never
/// silently add an event the caller did not request.
pub(super) fn require_terminal_event(
    provider: &str,
    glob: &str,
    event_types: &[String],
) -> Result<(), RpcError> {
    let parts: Vec<_> = glob.split('/').filter(|part| !part.is_empty()).collect();
    let finite = provider == "github"
        && parts.len() == 7
        && parts[4] == "pulls"
        && parts[5].bytes().all(|ch| ch.is_ascii_digit())
        && parts[6] == "**";
    if finite
        && !event_types.is_empty()
        && !event_types.iter().any(|kind| kind == "pull_request.closed")
    {
        return Err(RpcError::invalid_params("Filtered pull-request subscriptions must include pull_request.closed so terminal cleanup can finish."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    /// Pin native aliases to canonical exact types and reject malformed or broad input.
    fn jira_native_names_are_exact_and_canonical() {
        assert_eq!(
            normalize_event_types(
                "jira",
                &[
                    "comment_created".into(),
                    "comment.created".into(),
                    "jira:issue_created".into()
                ]
            )
            .unwrap(),
            vec!["comment.created", "issue.created"]
        );
        for bad in [
            "",
            "comment.*",
            "comment created",
            ".created",
            "jira:",
            "jira:.created",
        ] {
            assert!(normalize_event_types("jira", &[bad.into()]).is_err());
        }
    }
    #[test]
    /// Reject unsupported Jira aliases and require callers to request finite-PR closure explicitly.
    fn jira_aliases_are_explicit_and_filtered_prs_keep_terminal_cleanup() {
        assert_eq!(
            normalize_event_types("jira", &["Comment_Created".into()]).unwrap(),
            vec!["comment.created"]
        );
        for unsupported in [
            "comment__created",
            "project_soft_deleted",
            "version_released",
            "board_configuration_changed",
        ] {
            assert!(normalize_event_types("jira", &[unsupported.into()]).is_err());
        }
        assert!(require_terminal_event(
            "github",
            "/github/repos/acme/api/pulls/42/**",
            &["issue_comment.created".into()]
        )
        .is_err());
        assert!(require_terminal_event(
            "github",
            "/github/repos/acme/api/pulls/42/**",
            &["pull_request.closed".into()]
        )
        .is_ok());
        assert!(
            require_terminal_event("github", "/github/repos/acme/api/pulls/42/**", &[]).is_ok()
        );
        assert!(
            require_terminal_event("github", "/github/repos/acme/api/**", &["push".into()]).is_ok()
        );
    }
    #[test]
    /// Require advertised support and a complete filter echo instead of silently widening scope.
    fn old_servers_cannot_silently_ignore_filters() {
        let wanted = vec!["comment.created".into()];
        assert!(
            require_confirmed_filter(&serde_json::json!({"subscriptionId":"x"}), &wanted).is_err()
        );
        assert!(require_confirmed_filter(
            &serde_json::json!({"eventTypes":["comment.updated"]}),
            &wanted
        )
        .is_err());
        assert!(
            require_confirmed_filter(&serde_json::json!({"eventTypes":wanted}), &wanted).is_ok()
        );
        assert!(require_confirmed_filter(&Value::Null, &[]).is_ok());
        assert!(require_event_filter_support(&serde_json::json!([])).is_err());
        assert!(require_event_filter_support(&serde_json::json!({"eventTypes":false})).is_err());
        assert!(require_event_filter_support(&serde_json::json!({"eventTypes":true})).is_ok());
    }
}

#[cfg(test)]
mod http_tests {
    use super::super::Relayfile;
    use crate::relay::workspace::Secret;
    use serde_json::{json, Value};
    use std::io::{Read, Write};

    fn server(responses: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        server_with_status(
            responses
                .into_iter()
                .map(|response| (200, response))
                .collect(),
        )
    }

    fn server_with_status(
        responses: Vec<(u16, Value)>,
    ) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, response) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut raw = Vec::new();
                let mut buffer = [0; 4096];
                let (head, body) = loop {
                    let bytes = stream.read(&mut buffer).unwrap();
                    assert_ne!(bytes, 0);
                    raw.extend_from_slice(&buffer[..bytes]);
                    let text = String::from_utf8_lossy(&raw);
                    if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                        let size = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|size| size.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if body.len() >= size {
                            break (headers.to_string(), body.to_string());
                        }
                    }
                };
                requests.push(json!({"route":head.lines().next().unwrap(),"body":serde_json::from_str::<Value>(&body).unwrap_or(Value::Null)}));
                let response = response.to_string();
                write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
            requests
        });
        (address, handle)
    }

    #[tokio::test]
    /// Observe the capability request and exact creation payload over loopback HTTP.
    async fn filtered_creation_preflights_support_and_sends_exact_events() {
        let wanted = vec!["comment.created".to_string()];
        let (base_url, server) = server(vec![
            json!({"eventTypes":true}),
            json!({"subscriptionId":"wh_1","eventTypes":wanted}),
        ]);
        let files = Relayfile {
            base_url,
            token: Secret::new("fixture"),
            workspace: "rw_test".into(),
        };
        assert_eq!(
            files
                .create_subscription(
                    "https://hook.test",
                    &["/jira/**".into()],
                    &Secret::new("fixture"),
                    &wanted,
                    |_| Ok(()),
                )
                .await
                .unwrap(),
            "wh_1"
        );
        let requests = server.join().unwrap();
        assert!(requests[0]["route"]
            .as_str()
            .unwrap()
            .starts_with("GET /v1/workspaces/rw_test/webhooks?capabilities=eventTypes "));
        assert_eq!(
            requests[1]["body"]["eventTypes"],
            json!(["comment.created"])
        );
    }

    #[tokio::test]
    /// An unsupported server must receive no creation POST for an exact filter.
    async fn old_server_never_receives_a_filtered_creation_request() {
        let (base_url, server) = server(vec![json!([])]);
        let files = Relayfile {
            base_url,
            token: Secret::new("fixture"),
            workspace: "rw_test".into(),
        };
        assert!(files
            .create_subscription(
                "https://hook.test",
                &["/jira/**".into()],
                &Secret::new("fixture"),
                &["comment.created".into()],
                |_| Ok(()),
            )
            .await
            .is_err());
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[tokio::test]
    /// Legacy path-only creation omits eventTypes and does not require capabilities.
    async fn path_only_creation_remains_compatible_with_old_servers() {
        let (base_url, server) = server(vec![json!({"subscriptionId":"wh_legacy"})]);
        let files = Relayfile {
            base_url,
            token: Secret::new("fixture"),
            workspace: "rw_test".into(),
        };
        assert_eq!(
            files
                .create_subscription(
                    "https://hook.test",
                    &["/jira/**".into()],
                    &Secret::new("fixture"),
                    &[],
                    |_| Ok(()),
                )
                .await
                .unwrap(),
            "wh_legacy"
        );
        let requests = server.join().unwrap();
        assert!(requests[0]["route"].as_str().unwrap().starts_with("POST "));
        assert!(requests[0]["body"].get("eventTypes").is_none());
    }
    #[tokio::test]
    /// A failed DELETE must leave the returned subscription ID available to recovery.
    async fn failed_immediate_cleanup_keeps_the_created_id_for_recovery() {
        let (base_url, server) = server_with_status(vec![
            (200, json!({"eventTypes":true})),
            (
                200,
                json!({"subscriptionId":"wh_retry","eventTypes":["issue.created"]}),
            ),
            (500, json!({"error":"temporary"})),
        ]);
        let files = Relayfile {
            base_url,
            token: Secret::new("fixture"),
            workspace: "rw_test".into(),
        };
        let mut journaled = None;
        assert!(files
            .create_subscription(
                "https://hook.test",
                &["/jira/**".into()],
                &Secret::new("fixture"),
                &["comment.created".into()],
                |id| {
                    journaled = Some(id.to_string());
                    Ok(())
                }
            )
            .await
            .is_err());
        assert_eq!(journaled.as_deref(), Some("wh_retry"));
        assert!(server.join().unwrap()[2]["route"]
            .as_str()
            .unwrap()
            .contains("DELETE /v1/workspaces/rw_test/webhooks/wh_retry "));
    }

    #[tokio::test]
    /// Failure to record an external ID cannot leave the new subscription active.
    async fn a_journal_failure_also_deletes_the_created_subscription() {
        let (base_url, server) = server(vec![
            json!({"subscriptionId":"wh_unsaved"}),
            json!({"deleted":true}),
        ]);
        let files = Relayfile {
            base_url,
            token: Secret::new("fixture"),
            workspace: "rw_test".into(),
        };
        assert!(files
            .create_subscription(
                "https://hook.test",
                &["/jira/**".into()],
                &Secret::new("fixture"),
                &[],
                |_| Err(super::super::failed("fixture journal failure"))
            )
            .await
            .is_err());
        assert!(server.join().unwrap()[1]["route"]
            .as_str()
            .unwrap()
            .starts_with("DELETE "));
    }

    #[tokio::test]
    /// Unconfirmed external resources are recorded before the immediate deletion attempt.
    async fn rejected_confirmation_is_journaled_then_deleted_immediately() {
        let (base_url, server) = server(vec![
            json!({"eventTypes":true}),
            json!({"subscriptionId":"wh_unconfirmed"}),
            json!({"deleted":true}),
        ]);
        let files = Relayfile {
            base_url,
            token: Secret::new("fixture"),
            workspace: "rw_test".into(),
        };
        let mut journaled = None;
        let result = files
            .create_subscription(
                "https://hook.test",
                &["/jira/**".into()],
                &Secret::new("fixture"),
                &["comment.created".into()],
                |id| {
                    journaled = Some(id.to_string());
                    Ok(())
                },
            )
            .await;
        assert!(result.is_err());
        assert_eq!(journaled.as_deref(), Some("wh_unconfirmed"));
        let requests = server.join().unwrap();
        assert!(requests[2]["route"]
            .as_str()
            .unwrap()
            .starts_with("DELETE /v1/workspaces/rw_test/webhooks/wh_unconfirmed "));
    }
}
