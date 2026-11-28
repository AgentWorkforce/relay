//! Validate an authenticated Cloud voice lookup against one relay delivery.
//! This does not turn sender-supplied metadata into authority. The caller
//! must obtain the response through the authorized Cloud route and derive the
//! expected fields from the delivered message and current registration.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};

const LOOKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// All identifiers that one Fast turn must match. In particular, the Relay
/// message ID exists only after Relaycast stores the DM.
pub(crate) struct Binding<'a> {
    pub workspace_id: &'a str,
    /// Relaycast's immutable `message.agent_id`, as delivered to this node.
    pub sender_agent_id: &'a str,
    pub recipient_agent_id: &'a str,
    pub recipient_session_id: &'a str,
    pub message_id: &'a str,
    pub request_id: &'a str,
}

/// Accept only a fresh, exact match from Cloud. Error responses, absent
/// fields, and sender-asserted hints all fail closed to ordinary service.
pub(crate) fn authorized(response: &Value, binding: &Binding<'_>, now: DateTime<Utc>) -> bool {
    if response["authorized"].as_bool() != Some(true) {
        return false;
    }
    for (field, expected) in [
        ("workspaceId", binding.workspace_id),
        ("senderAgentId", binding.sender_agent_id),
        ("recipientAgentId", binding.recipient_agent_id),
        ("recipientSessionId", binding.recipient_session_id),
        ("messageId", binding.message_id),
        ("requestId", binding.request_id),
    ] {
        if expected.is_empty() || response[field].as_str() != Some(expected) {
            return false;
        }
    }
    // Cloud alone resolves this Relaycast identity to a current person.
    // The node cannot assert or compare the person's internal user ID.
    if response["senderUserId"].as_str().is_none_or(str::is_empty) {
        return false;
    }
    let Some(expires) = response["expiresAt"]
        .as_str()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
    else {
        return false;
    };
    expires > now && expires <= now + Duration::seconds(60)
}

/// A staged, fail-closed lookup against Cloud's recipient-token route. The
/// token is the recipient agent's Relaycast credential, never the person's
/// Cloud session. The request ID is only a lookup key: Cloud must have issued
/// a durable intent for the exact post-send message before authorizing it.
/// No production delivery path calls this until that hosted contract and the
/// native/proxy path on Skip's host have been verified.
pub(crate) async fn lookup(
    account: &crate::relay::cloud_session::CloudAccount,
    recipient_token: &crate::relay::workspace::Secret,
    binding: &Binding<'_>,
) -> bool {
    let Some(site) = crate::relay::workspace::validated_base_url(&account.site_url) else {
        return false;
    };
    if account.workspace_id != binding.workspace_id
        || account.user_id.as_deref().is_none_or(str::is_empty)
        || recipient_token.expose().is_empty()
        || [
            binding.workspace_id,
            binding.sender_agent_id,
            binding.recipient_agent_id,
            binding.recipient_session_id,
            binding.message_id,
            binding.request_id,
        ]
        .iter()
        .any(|value| value.is_empty())
    {
        return false;
    }
    let workspace = crate::relay::cloud_session::segment(binding.workspace_id);
    let url = format!("{site}/api/v1/workspaces/{workspace}/messaging/voice-attestation");
    let request = json!({
        "senderAgentId": binding.sender_agent_id,
        "recipientAgentId": binding.recipient_agent_id,
        "recipientSessionId": binding.recipient_session_id,
        "messageId": binding.message_id,
        "requestId": binding.request_id,
    });
    let Ok(answer) = crate::relay::cloud_http::send(
        "POST",
        url,
        Some(recipient_token.expose().to_string()),
        Some(request),
        LOOKUP_TIMEOUT,
    )
    .await
    else {
        return false;
    };
    answer.status == 200
        && authorized(&answer.body, binding, Utc::now())
        && answer.body["senderUserId"].as_str() == account.user_id.as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    const BINDING: Binding<'static> = Binding {
        workspace_id: "w1",
        sender_agent_id: "person-relay-id",
        recipient_agent_id: "skip-agent",
        recipient_session_id: "skip-session",
        message_id: "m1",
        request_id: "r1",
    };

    fn response() -> Value {
        json!({
            "authorized": true,
            "workspaceId": "w1",
            "senderAgentId": "person-relay-id",
            "senderUserId": "u1",
            "recipientAgentId": "skip-agent",
            "recipientSessionId": "skip-session",
            "messageId": "m1",
            "requestId": "r1",
            "expiresAt": "2026-11-28T00:00:30Z"
        })
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-28T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn live_response() -> Value {
        let mut value = response();
        value["expiresAt"] = json!((Utc::now() + Duration::seconds(30)).to_rfc3339());
        value
    }

    #[test]
    fn exact_fresh_cloud_result_is_accepted() {
        assert!(authorized(&response(), &BINDING, now()));
    }

    #[test]
    fn every_binding_field_is_required_and_exact() {
        for field in [
            "workspaceId",
            "senderAgentId",
            "recipientAgentId",
            "recipientSessionId",
            "messageId",
            "requestId",
        ] {
            let mut wrong = response();
            wrong[field] = json!("other");
            assert!(!authorized(&wrong, &BINDING, now()), "{field}");
            wrong.as_object_mut().unwrap().remove(field);
            assert!(!authorized(&wrong, &BINDING, now()), "missing {field}");
        }
        let mut missing_person = response();
        missing_person
            .as_object_mut()
            .unwrap()
            .remove("senderUserId");
        assert!(!authorized(&missing_person, &BINDING, now()));
    }

    #[test]
    fn denial_expiration_and_overlong_lifetime_fail_closed() {
        let mut wrong = response();
        wrong["authorized"] = json!(false);
        assert!(!authorized(&wrong, &BINDING, now()));
        wrong = response();
        wrong["expiresAt"] = json!("2026-11-28T00:00:00Z");
        assert!(!authorized(&wrong, &BINDING, now()));
        wrong["expiresAt"] = json!("2026-11-28T00:02:00Z");
        assert!(!authorized(&wrong, &BINDING, now()));
        wrong["expiresAt"] = json!("invalid");
        assert!(!authorized(&wrong, &BINDING, now()));
    }

    fn serve(
        status: &'static str,
        body: Value,
    ) -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (send, receive) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut bytes = [0u8; 4096];
            loop {
                let n = stream.read(&mut bytes).unwrap();
                request.extend_from_slice(&bytes[..n]);
                let Some(headers_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers_end = headers_end + 4;
                let headers = String::from_utf8_lossy(&request[..headers_end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap();
                if request.len() >= headers_end + length {
                    break;
                }
            }
            send.send(String::from_utf8(request).unwrap()).unwrap();
            let body = body.to_string();
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        (url, receive, server)
    }

    #[tokio::test]
    async fn lookup_uses_recipient_token_and_exact_cloud_route() {
        let (site_url, request, server) = serve("200 OK", live_response());
        let account = crate::relay::cloud_session::CloudAccount {
            site_url,
            workspace_id: "w1".into(),
            user_id: Some("u1".into()),
        };
        assert!(
            lookup(
                &account,
                &crate::relay::workspace::Secret::new("recipient-token"),
                &BINDING
            )
            .await
        );
        let request = request.recv().unwrap();
        assert!(request
            .starts_with("POST /api/v1/workspaces/w1/messaging/voice-attestation HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer recipient-token\r\n"));
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["senderAgentId"], "person-relay-id");
        assert_eq!(body["recipientSessionId"], "skip-session");
        assert_eq!(body["messageId"], "m1");
        assert_eq!(body["requestId"], "r1");
        assert!(body.get("senderUserId").is_none());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn lookup_denial_and_wrong_binding_fail_closed() {
        let token = crate::relay::workspace::Secret::new("recipient-token");
        let (site_url, request, server) = serve("403 Forbidden", live_response());
        let account = crate::relay::cloud_session::CloudAccount {
            site_url,
            workspace_id: "w1".into(),
            user_id: Some("u1".into()),
        };
        assert!(!lookup(&account, &token, &BINDING).await);
        request.recv().unwrap();
        server.join().unwrap();

        let mut forged = live_response();
        forged["messageId"] = json!("other-message");
        let (site_url, request, server) = serve("200 OK", forged);
        let account = crate::relay::cloud_session::CloudAccount {
            site_url,
            workspace_id: "w1".into(),
            user_id: Some("u1".into()),
        };
        assert!(!lookup(&account, &token, &BINDING).await);
        request.recv().unwrap();
        server.join().unwrap();
        let wrong_workspace = crate::relay::cloud_session::CloudAccount {
            workspace_id: "other".into(),
            ..account
        };
        assert!(!lookup(&wrong_workspace, &token, &BINDING).await);

        let (site_url, request, server) = serve("200 OK", live_response());
        let wrong_person = crate::relay::cloud_session::CloudAccount {
            site_url,
            workspace_id: "w1".into(),
            user_id: Some("other-user".into()),
        };
        assert!(!lookup(&wrong_person, &token, &BINDING).await);
        request.recv().unwrap();
        server.join().unwrap();
    }
}
