//! Normalize caller event names before any subscription side effect.
use crate::relay::protocol::RpcError;
use serde_json::Value;

pub(super) fn require_event_filter_support(value: &Value) -> Result<(), RpcError> {
    if value.get("eventTypes") == Some(&Value::Bool(true)) {
        return Ok(());
    }
    Err(super::failed("Relayfile cannot enforce exact event filters. Upgrade Relayfile before subscribing to exact events."))
}

pub(super) fn require_confirmed_filter(value: &Value, expected: &[String]) -> Result<(), RpcError> {
    if expected.is_empty() || value.get("eventTypes") == Some(&serde_json::json!(expected)) {
        return Ok(());
    }
    Err(super::failed("Relayfile did not confirm the requested event filter. Upgrade Relayfile before subscribing to exact events."))
}

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
            let native = value.strip_prefix("jira:").unwrap_or(value);
            match native.rsplit_once('_') {
                Some((object, action))
                    if ["created", "updated", "deleted", "started", "closed"].contains(&action) =>
                {
                    format!("{object}.{action}")
                }
                _ => native.to_string(),
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
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
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
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
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
            requests
        });
        (address, handle)
    }

    #[tokio::test]
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
                    &wanted
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
                &["comment.created".into()]
            )
            .await
            .is_err());
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[tokio::test]
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
                    &[]
                )
                .await
                .unwrap(),
            "wh_legacy"
        );
        assert!(server.join().unwrap()[0]["route"]
            .as_str()
            .unwrap()
            .starts_with("POST "));
    }
}
