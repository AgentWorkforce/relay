//! Local, memory-only request diagnostics. Never sent to telemetry or written to disk.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const CAPACITY: usize = 250;
const BODY_LIMIT: usize = 8192;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RequestEntry {
    pub id: String,
    pub started_at_ms: u64,
    pub service: String,
    pub method: String,
    pub endpoint: String,
    pub request: String,
    pub response: String,
    pub status: Option<u16>,
    pub duration_ms: Option<u64>,
    pub failed: bool,
    /// Made with a Relay Connect room's credential: that room's workspace,
    /// not the team's, so its limits are not the team's to upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect: Option<bool>,
}

impl RequestEntry {
    /// A Relay Connect room's calls are named for the room, so its
    /// workspace's limits are not read as the team's.
    pub fn service_name(&self) -> &str {
        match self.service.as_str() {
            "Relaycast" if self.connect == Some(true) => "Relay Connect",
            "Relaycast" => "Agent Relay",
            other => other,
        }
    }

    /// The short status-bar sentence for this failed request. Identity-sync
    /// refusals are permanent for an unchanged snapshot, so name the feature
    /// instead of presenting them as a generic Cloud outage.
    pub fn failure_summary(&self) -> String {
        if self.service == "Cloud"
            && self.status == Some(403)
            && self.endpoint.contains("/messaging/desktop-identities")
        {
            "Agents couldn't link to Cloud".into()
        } else {
            format!("{} request failed", self.service_name())
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct RequestLog {
    pub entries: Vec<RequestEntry>,
}

#[derive(Default)]
struct Log {
    sequence: u64,
    entries: VecDeque<RequestEntry>,
}
fn log() -> &'static Mutex<Log> {
    static LOG: OnceLock<Mutex<Log>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(Log::default()))
}
pub fn snapshot() -> RequestLog {
    // The bridge has a 1 MiB line limit. Budget serialized bytes, including escaping.
    let log = log().lock().unwrap_or_else(|e| e.into_inner());
    let mut bytes = 0;
    RequestLog {
        entries: log
            .entries
            .iter()
            .rev()
            .take_while(|entry| {
                bytes += serde_json::to_vec(entry).map_or(0, |data| data.len());
                bytes < 512 * 1024
            })
            .cloned()
            .collect(),
    }
}

fn bounded(value: &str, limit: usize) -> String {
    let mut result: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        result.push_str("… [truncated]");
    }
    result
}
fn scrub_text(value: &str, secret: &str) -> String {
    let value = if secret.is_empty() {
        value.to_owned()
    } else {
        value.replace(secret, "[redacted]")
    };
    // Also redact credentials echoed by a service in otherwise unstructured errors.
    value
        .split_inclusive(char::is_whitespace)
        .scan(false, |bearer, word| {
            let lower = word.to_ascii_lowercase();
            let hide = *bearer
                || ["rk_", "at_", "sk_", "eyj"]
                    .iter()
                    .any(|prefix| lower.trim_start_matches(['\"', '\'']).starts_with(prefix));
            *bearer = lower.trim() == "bearer";
            Some(if hide {
                "[redacted] ".to_owned()
            } else {
                word.to_owned()
            })
        })
        .collect()
}
fn scrub(value: &Value, secret: &str, depth: usize) -> Value {
    if depth > 8 {
        return json!("[truncated]");
    }
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .take(100)
                .map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    let private = [
                        "token",
                        "secret",
                        "password",
                        "authorization",
                        "cookie",
                        "credential",
                        "api_key",
                        "apikey",
                        "key_hash",
                    ]
                    .iter()
                    .any(|word| lower.contains(word))
                        || matches!(
                            lower.as_str(),
                            "text"
                                | "content"
                                | "body"
                                | "metadata"
                                | "code"
                                | "url"
                                | "download_url"
                        );
                    (
                        key.clone(),
                        if private {
                            json!("[redacted]")
                        } else {
                            scrub(value, secret, depth + 1)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(50)
                .map(|v| scrub(v, secret, depth + 1))
                .collect(),
        ),
        Value::String(value) => json!(bounded(&scrub_text(value, secret), 2000)),
        other => other.clone(),
    }
}
fn body(value: &Value, secret: &str) -> String {
    bounded(
        &serde_json::to_string_pretty(&scrub(value, secret, 0)).unwrap_or_default(),
        BODY_LIMIT,
    )
}
fn endpoint(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            bounded(url.as_str(), 500)
        }
        Err(_) => bounded(url.split(['?', '#']).next().unwrap_or(""), 500),
    }
}

pub struct Capture {
    id: String,
    start: Instant,
    secret: String,
    finished: bool,
}
impl Capture {
    pub fn start(service: &str, method: &str, url: &str, request: &Value, secret: &str) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut log = log().lock().unwrap_or_else(|e| e.into_inner());
        log.sequence += 1;
        let id = format!("{now}-{}", log.sequence);
        let entry = RequestEntry {
            id: id.clone(),
            started_at_ms: now,
            service: service.into(),
            method: method.into(),
            endpoint: scrub_text(&endpoint(url), secret),
            request: body(request, secret),
            response: "Pending…".into(),
            status: None,
            duration_ms: None,
            failed: false,
            connect: connect_credentials()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains(&fingerprint(secret))
                .then_some(true),
        };
        if log.entries.len() == CAPACITY {
            log.entries.pop_front();
        }
        log.entries.push_back(entry);
        Self {
            id,
            start: Instant::now(),
            secret: secret.into(),
            finished: false,
        }
    }
    pub fn finish(&mut self, status: Option<u16>, failed: bool, response: &Value) {
        let response = body(response, &self.secret);
        if let Some(entry) = log()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .iter_mut()
            .find(|e| e.id == self.id)
        {
            entry.status = status;
            entry.failed = failed;
            entry.response = response;
            entry.duration_ms = Some(self.start.elapsed().as_millis() as u64);
        }
        self.finished = true;
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        if !self.finished {
            self.finish(
                None,
                false,
                &json!({"result": "Cancelled before completion"}),
            );
        }
    }
}

/// One-way fingerprints of the Relay Connect credentials in use. Only the
/// fingerprint is kept, never the credential.
fn connect_credentials() -> &'static Mutex<std::collections::HashSet<String>> {
    static CREDENTIALS: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    CREDENTIALS.get_or_init(Default::default)
}

fn fingerprint(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(secret.as_bytes())[..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Requests made with `secret` from here on are a Relay Connect room's.
pub fn mark_connect_credential(secret: &str) {
    if !secret.is_empty() {
        connect_credentials()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(fingerprint(secret));
    }
}

/// SDK calls expose decoded data and final API errors, not successful HTTP statuses
/// or individual retry responses. Keep those unknown instead of inventing a 200.
pub async fn observe<T: Serialize>(
    method: &str,
    url: &str,
    request: Value,
    secret: &str,
    future: impl std::future::Future<Output = relaycast::Result<T>>,
) -> relaycast::Result<T> {
    let mut capture = Capture::start("Relaycast", method, url, &request, secret);
    let result = future.await;
    match &result {
        Ok(value) => capture.finish(None, false, &json!({"result": if method.starts_with("SDK:") { "Success (SDK operation result)" } else { "Success (SDK decoded response)" }, "data": value})),
        Err(error) => {
            let message = match error {
                relaycast::RelayError::Api { message, .. } => message.clone(),
                relaycast::RelayError::Http(e) if e.is_timeout() => "Request timed out".into(),
                relaycast::RelayError::Http(_) => "Network request failed".into(),
                relaycast::RelayError::Json(error) => format!("Invalid response from Agent Relay: {error}"),
                relaycast::RelayError::InvalidResponse(detail) => format!("Invalid response from Agent Relay: {detail}"),
                _ => "Agent Relay request failed".into(),
            };
            let mut body = json!({"error_code": error.code(), "message": message, "request_id": error.request_id(), "attempts": error.attempts(), "retry_after_ms": error.retry_after_ms()});
            // The apps' capacity notice reads Relaycast's own upgrade answer.
            for key in ["plan", "upgrade_available", "upgrade_url"] {
                if let Some(value) = error.details().and_then(|details| details.get(key)) {
                    body[key] = value.clone();
                }
            }
            capture.finish(error.status(), true, &body);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    #[test]
    fn removes_secrets_and_bounds_bodies() {
        let rendered = body(
            &json!({"access_token":"new-secret", "nested":{"api_key":"key"}, "message":"Bearer abc secret-value", "text":"private conversation", "large":"x".repeat(20000)}),
            "secret-value",
        );
        for private in [
            "new-secret",
            "\"key\"",
            "abc",
            "secret-value",
            "private conversation",
        ] {
            assert!(!rendered.contains(private));
        }
        assert!(rendered.len() < BODY_LIMIT + 100);
        assert_eq!(
            endpoint("https://user:pass@localhost/test?token=secret#secret"),
            "https://localhost/test"
        );
    }
    #[test]
    fn identity_refusals_have_a_specific_status_summary() {
        let entry = RequestEntry {
            id: "one".into(),
            started_at_ms: 0,
            service: "Cloud".into(),
            method: "PUT".into(),
            endpoint:
                "https://agentrelay.com/cloud/api/v1/workspaces/ws/messaging/desktop-identities"
                    .into(),
            request: "{}".into(),
            response: "{}".into(),
            status: Some(403),
            duration_ms: Some(1),
            failed: true,
            connect: None,
        };
        assert_eq!(entry.failure_summary(), "Agents couldn't link to Cloud");
        assert_eq!(
            RequestEntry {
                endpoint: "https://agentrelay.com/cloud/api/v1/workspaces/ws".into(),
                ..entry
            }
            .failure_summary(),
            "Cloud request failed"
        );
    }
    #[test]
    fn connect_requests_are_named_for_the_room() {
        let entry = RequestEntry {
            id: "1".into(),
            started_at_ms: 0,
            service: "Relaycast".into(),
            method: "SDK: heartbeat".into(),
            endpoint: "https://cast.agentrelay.com/".into(),
            request: "{}".into(),
            response: "{}".into(),
            status: Some(429),
            duration_ms: Some(1),
            failed: true,
            connect: Some(true),
        };
        assert_eq!(entry.service_name(), "Relay Connect");
        assert_eq!(entry.failure_summary(), "Relay Connect request failed");
        let team = RequestEntry {
            connect: None,
            ..entry
        };
        assert_eq!(team.service_name(), "Agent Relay");
        assert_eq!(team.failure_summary(), "Agent Relay request failed");
    }
    #[tokio::test]
    async fn preserves_api_failure_and_success_and_records_pending() {
        let _guard = TEST_LOCK.lock().unwrap();
        let response: relaycast::Result<Value> = observe(
            "GET",
            "/diagnostic-test",
            Value::Null,
            "credential",
            async {
                assert!(snapshot()
                    .entries
                    .iter()
                    .any(|e| e.endpoint == "/diagnostic-test" && e.duration_ms.is_none()));
                Err(relaycast::RelayError::Api {
                    code: "unavailable".into(),
                    message: "credential unavailable".into(),
                    status: 503,
                    request_id: Some("req-42".into()),
                    attempts: 3,
                    retry_after_ms: Some(1000),
                    details: None,
                })
            },
        )
        .await;
        assert_eq!(response.unwrap_err().status(), Some(503));
        let entry = snapshot()
            .entries
            .into_iter()
            .find(|e| e.endpoint == "/diagnostic-test")
            .unwrap();
        assert!(entry.failed);
        assert_eq!(entry.status, Some(503));
        assert!(entry.response.contains("req-42"));
        assert!(entry.response.contains("attempts"));
        assert!(!entry.response.contains("credential"));
        let result = observe("GET", "/success-test", Value::Null, "", async {
            Ok(json!({"id":"agent-1"}))
        })
        .await
        .unwrap();
        assert_eq!(result["id"], "agent-1");
        let entry = snapshot()
            .entries
            .into_iter()
            .find(|e| e.endpoint == "/success-test")
            .unwrap();
        assert!(!entry.failed);
        assert_eq!(entry.status, None);
        assert!(entry.response.contains("agent-1"));
    }
    #[tokio::test]
    async fn a_relay_connect_credential_tags_its_requests() {
        let _guard = TEST_LOCK.lock().unwrap();
        mark_connect_credential("at_live_connect_room");
        let _: relaycast::Result<Value> = observe(
            "GET",
            "/connect-tag-test",
            Value::Null,
            "at_live_connect_room",
            async { Ok(Value::Null) },
        )
        .await;
        let _: relaycast::Result<Value> = observe(
            "GET",
            "/team-tag-test",
            Value::Null,
            "at_live_team_agent",
            async { Ok(Value::Null) },
        )
        .await;
        let tag = |path: &str| {
            snapshot()
                .entries
                .iter()
                .rev()
                .find(|e| e.endpoint == path)
                .and_then(|e| e.connect)
        };
        assert_eq!(tag("/connect-tag-test"), Some(true));
        assert_eq!(tag("/team-tag-test"), None);
        // Only a fingerprint is kept.
        let kept = connect_credentials().lock().unwrap().clone();
        assert!(kept.iter().all(|f| !f.contains("connect_room")));
    }

    #[tokio::test]
    async fn malformed_response_keeps_the_parse_reason() {
        let _guard = TEST_LOCK.lock().unwrap();
        let result: relaycast::Result<Value> =
            observe("GET", "/malformed-test", Value::Null, "secret", async {
                Err(relaycast::RelayError::InvalidResponse(
                    "workspace without id".into(),
                ))
            })
            .await;
        assert!(result.is_err());
        let entry = snapshot()
            .entries
            .into_iter()
            .find(|entry| entry.endpoint == "/malformed-test")
            .unwrap();
        assert!(entry.failed);
        assert!(entry.response.contains("workspace without id"));
    }

    #[tokio::test]
    async fn busy_answers_keep_relaycasts_upgrade_fields() {
        let _guard = TEST_LOCK.lock().unwrap();
        let _: relaycast::Result<Value> =
            observe("POST", "/busy-test", Value::Null, "secret", async {
                Err(relaycast::RelayError::Api {
                    code: "workspace_busy".into(),
                    message: "Workspace write capacity is busy".into(),
                    status: 429,
                    request_id: None,
                    attempts: 3,
                    retry_after_ms: Some(2000),
                    details: Some(json!({"ok": false, "error_code": "workspace_busy",
                        "plan": "free", "upgrade_available": true,
                        "upgrade_url": "https://agentrelay.com/cloud/dashboard/settings#billing"})),
                })
            })
            .await;
        let entry = snapshot()
            .entries
            .into_iter()
            .find(|entry| entry.endpoint == "/busy-test")
            .unwrap();
        let body: Value = serde_json::from_str(&entry.response).unwrap();
        assert_eq!(body["error_code"], "workspace_busy");
        assert_eq!(body["plan"], "free");
        assert_eq!(body["upgrade_available"], true);
        assert_eq!(
            body["upgrade_url"],
            "https://agentrelay.com/cloud/dashboard/settings#billing"
        );
    }

    #[tokio::test]
    async fn an_acknowledged_heartbeat_is_a_success() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let _ = stream.read(&mut request).await.unwrap();
            let body = r#"{"ok":true,"data":null}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let token = crate::relay::workspace::Secret::new("at_live_test");
        crate::relay::client::heartbeat(&base, &token)
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[test]
    fn ring_is_bounded_and_cancelled_requests_finish() {
        let _guard = TEST_LOCK.lock().unwrap();
        for _ in 0..CAPACITY + 10 {
            drop(Capture::start(
                "test",
                "GET",
                "/cancel-test",
                &Value::Null,
                "",
            ));
        }
        let entries = snapshot().entries;
        assert_eq!(entries.len(), CAPACITY);
        assert!(entries
            .iter()
            .filter(|e| e.endpoint == "/cancel-test")
            .all(|e| e.duration_ms.is_some() && !e.failed));
    }
    #[test]
    fn snapshot_fits_the_bridge_even_with_large_escaped_unicode_bodies() {
        let _guard = TEST_LOCK.lock().unwrap();
        for _ in 0..CAPACITY {
            let payload = json!(vec!["🦀\n\"".repeat(2000); 4]);
            let mut capture = Capture::start("test", "POST", "/large-test", &payload, "");
            capture.finish(Some(503), true, &payload);
        }
        let snapshot = snapshot();
        assert!(!snapshot.entries.is_empty());
        assert!(snapshot.entries.len() < CAPACITY);
        assert!(serde_json::to_vec(&snapshot).unwrap().len() < 1024 * 1024);
    }
}
