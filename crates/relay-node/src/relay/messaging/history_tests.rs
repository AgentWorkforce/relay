//! `messages.history` for an exact address against a scripted Relaycast,
//! counting the requests that reach it.

use super::*;
use crate::relay::cloud_session::{AgentOwner, CloudAccess};
use crate::relay::daemon::{Config, Plugins};
use crate::relay::delivery::DeliveryTiming;
use crate::relay::paths::CorePaths;
use crate::relay::push::PushTiming;
use futures_util::future::BoxFuture;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// An address none of the conversations proves.
const PEER: &str = "reviewer@sf-machine-999";

type Failure = (u16, &'static str, Option<u64>);

/// A Relaycast that lists `conversations`, each holding one message from
/// its peer, and answers a path with its queued failures first.
#[derive(Default)]
struct Script {
    conversations: Vec<Value>,
    failures: HashMap<String, VecDeque<Failure>>,
    requests: Vec<String>,
    /// Messages in each conversation's page; one when zero.
    page: usize,
}

impl Script {
    fn count(&self, path: &str) -> usize {
        self.requests.iter().filter(|p| *p == path).count()
    }

    fn message_reads(&self) -> usize {
        self.requests
            .iter()
            .filter(|p| p.starts_with("/v1/dm/") && p.ends_with("/messages"))
            .count()
    }

    fn answer(&mut self, path: &str) -> (u16, Option<u64>, Value) {
        self.requests.push(path.to_string());
        if let Some((status, code, retry_after)) =
            self.failures.get_mut(path).and_then(VecDeque::pop_front)
        {
            let body = json!({"ok": false, "error": {"code": code, "message": code}});
            return (status, retry_after, body);
        }
        let messages = path
            .strip_prefix("/v1/dm/")
            .and_then(|p| p.strip_suffix("/messages"));
        let data = match (path, messages) {
            ("/v1/deliveries", _) => json!([]),
            ("/v1/dm/conversations", _) => Value::Array(self.conversations.clone()),
            (_, Some(id)) => (0..self.page.max(1))
                .map(|n| {
                    let message = if n == 0 {
                        format!("msg_{id}")
                    } else {
                        format!("msg_{id}_{n}")
                    };
                    json!({
                        "id": message, "agent_id": format!("ag_{id}"),
                        "agent_name": format!("peer-{id}"),
                        "agent_address": format!("peer-{id}@elsewhere"),
                        "thread_id": null, "text": "hello",
                        "created_at": "2026-11-15T00:00:00Z",
                    })
                })
                .collect(),
            _ if path.starts_with("/v1/messages/") => {
                let id = &path["/v1/messages/".len()..];
                json!({"id": id, "thread_id": null, "text": "hello"})
            }
            _ => {
                let body = json!({"ok": false, "error": {"code": "not_found", "message": path}});
                return (404, None, body);
            }
        };
        (200, None, json!({"ok": true, "data": data}))
    }
}

/// A 1:1 conversation with `peer-<id>` as Relaycast lists it, its last
/// message `last`.
fn conversation(id: &str, last: &str) -> Value {
    json!({
        "id": id, "type": "1:1", "name": null,
        "participants": [
            {"agent_id": "ag_owner", "agent_name": "owner"},
            {"agent_id": format!("ag_{id}"), "agent_name": format!("peer-{id}")},
        ],
        "last_message": {"id": last, "text": "hello", "agent_id": format!("ag_{id}"),
            "created_at": "2026-11-15T00:00:00Z"},
        "unread_count": 1, "created_at": "2026-11-01T00:00:00Z",
    })
}

async fn serve(script: Arc<Mutex<Script>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let script = script.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&request);
                let target = head.split_whitespace().nth(1).unwrap_or("/");
                let path = target.split('?').next().unwrap_or(target).to_string();
                let (status, retry_after, body) = script.lock().unwrap().answer(&path);
                let body = body.to_string();
                let retry_after = retry_after
                    .map(|secs| format!("Retry-After: {secs}\r\n"))
                    .unwrap_or_default();
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{retry_after}\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    base
}

/// Signed in as `owner`, whose Relaycast is at the given base URL.
struct SignedIn(String);
impl CloudAccess for SignedIn {
    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: "https://agentrelay.example".into(),
            workspace_id: "cloud-workspace".into(),
            user_id: Some("owner".into()),
        })
    }
    fn agent_owner(&self) -> Option<AgentOwner> {
        None
    }
    fn request(
        &self,
        _: &'static str,
        path: String,
        _: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        let base = self.0.clone();
        Box::pin(async move {
            Ok(if path.ends_with("/messaging/identity/credential") {
                json!({"identity": {"name": "owner", "agentId": "ag_owner",
                    "token": "at_test", "relaycastUrl": base}})
            } else {
                Value::Null
            })
        })
    }
}

async fn core_with(
    conversations: Vec<Value>,
) -> (tempfile::TempDir, Arc<Core>, Arc<Mutex<Script>>) {
    let script = Arc::new(Mutex::new(Script {
        conversations,
        ..Script::default()
    }));
    let base = serve(script.clone()).await;
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let config = Config {
        paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "history-test".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    let plugins = Plugins {
        cloud: Arc::new(SignedIn(base)),
        ..Plugins::default()
    };
    let core = Core::with_plugins(config, plugins).0;
    (temp, core, script)
}

fn peer() -> Endpoint {
    Endpoint::Address(PEER.into())
}

/// Whether the history with [`PEER`] is empty, as it is without proof.
async fn found_nothing(core: &Core) -> bool {
    core.history(&peer(), None)
        .await
        .unwrap()
        .messages
        .is_empty()
}

/// Runs `test` again in a child without file-selected TLS roots, which the
/// SDK transport refuses, when this process has them; true if it did.
fn ran_without_file_roots(test: &str) -> bool {
    let names = ["SSL_CERT_FILE", "SSL_CERT_DIR"];
    if !names
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
    {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("relay::messaging::history_tests::{test}"),
        ])
        .env_remove(names[0])
        .env_remove(names[1])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

#[tokio::test]
async fn an_overloaded_relaycast_pauses_history_without_another_request() {
    if ran_without_file_roots("an_overloaded_relaycast_pauses_history_without_another_request") {
        return;
    }
    let (_home, core, script) = core_with(vec![conversation("c1", "m1")]).await;
    // The SDK retries a GET twice; the answer it gives up on names 30 s.
    script
        .lock()
        .unwrap()
        .failures
        .insert("/v1/dm/conversations".into(), overloaded());
    assert!(core.history(&peer(), None).await.is_err());
    let before = script.lock().unwrap().requests.len();

    let error = core.history(&peer(), None).await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::RateLimited);
    assert!(
        error
            .retry_after_secs
            .is_some_and(|secs| (25..=30).contains(&secs)),
        "{:?}",
        error.retry_after_secs
    );
    let error = core.conversations().await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::RateLimited);
    assert_eq!(script.lock().unwrap().requests.len(), before);
}

#[tokio::test]
async fn a_second_lookup_without_proof_reads_only_changed_conversations() {
    if ran_without_file_roots("a_second_lookup_without_proof_reads_only_changed_conversations") {
        return;
    }
    let (_home, core, script) = core_with(vec![
        conversation("c1", "m1"),
        conversation("c2", "m2"),
        conversation("c3", "m3"),
    ])
    .await;
    assert!(found_nothing(&core).await);
    assert_eq!(script.lock().unwrap().message_reads(), 3);

    // The miss is forgotten (a reply arrived): the lookup runs again, but
    // nothing it read has changed.
    core.person_woke();
    assert!(found_nothing(&core).await);
    {
        let script = script.lock().unwrap();
        assert_eq!(script.message_reads(), 3);
        assert_eq!(script.count("/v1/dm/conversations"), 2);
    }

    // A conversation with a new last message is read again; only it.
    script.lock().unwrap().conversations[1] = conversation("c2", "m2-next");
    core.person_woke();
    assert!(found_nothing(&core).await);
    let script = script.lock().unwrap();
    assert_eq!(script.message_reads(), 4);
    assert_eq!(script.count("/v1/dm/c2/messages"), 2);
}

#[tokio::test]
async fn a_retry_after_an_error_goes_on_from_where_it_stopped() {
    if ran_without_file_roots("a_retry_after_an_error_goes_on_from_where_it_stopped") {
        return;
    }
    let (_home, core, script) = core_with(vec![
        conversation("c1", "m1"),
        conversation("c2", "m2"),
        conversation("c3", "m3"),
    ])
    .await;
    // Every attempt the SDK makes at c2 fails, without pausing Relaycast.
    script.lock().unwrap().failures.insert(
        "/v1/dm/c2/messages".into(),
        std::iter::repeat_n((500, "internal_error", None), 3).collect(),
    );
    assert!(core.history(&peer(), None).await.is_err());
    {
        let script = script.lock().unwrap();
        assert_eq!(script.count("/v1/dm/c1/messages"), 1);
        assert_eq!(script.count("/v1/dm/c3/messages"), 0);
    }

    assert!(found_nothing(&core).await);
    let script = script.lock().unwrap();
    assert_eq!(script.count("/v1/dm/c1/messages"), 1);
    assert_eq!(script.count("/v1/dm/c2/messages"), 4);
    assert_eq!(script.count("/v1/dm/c3/messages"), 1);
}

/// The failures the SDK's three attempts at one GET meet, the last naming
/// a 30 s `Retry-After`.
fn overloaded() -> VecDeque<Failure> {
    [
        (503, "database_overloaded", Some(0)),
        (503, "database_overloaded", Some(0)),
        (503, "database_overloaded", Some(30)),
    ]
    .into()
}

/// Asserts `error` is the paused refusal, with about 30 s left.
fn assert_paused(error: &RpcError) {
    assert_eq!(error.data.kind, ErrorKind::RateLimited);
    assert!(
        error
            .retry_after_secs
            .is_some_and(|secs| (25..=30).contains(&secs)),
        "{:?}",
        error.retry_after_secs
    );
}

#[tokio::test]
async fn an_overloaded_delivery_poll_stops_the_history_pass() {
    if ran_without_file_roots("an_overloaded_delivery_poll_stops_the_history_pass") {
        return;
    }
    let (_home, core, script) =
        core_with(vec![conversation("c1", "m1"), conversation("c2", "m2")]).await;
    script
        .lock()
        .unwrap()
        .failures
        .insert("/v1/deliveries".into(), overloaded());

    let error = core.history(&peer(), None).await.unwrap_err();
    assert_paused(&error);
    let script = script.lock().unwrap();
    assert_eq!(script.count("/v1/dm/conversations"), 0);
    assert_eq!(script.message_reads(), 0);
}

#[tokio::test]
async fn an_overloaded_detail_read_pauses_the_workspace_after_another_failure() {
    if ran_without_file_roots(
        "an_overloaded_detail_read_pauses_the_workspace_after_another_failure",
    ) {
        return;
    }
    let (_home, core, script) = core_with(vec![conversation("c1", "m1")]).await;
    {
        let mut script = script.lock().unwrap();
        script.page = 2;
        // The first detail read fails for another reason; the second is
        // the overload answer that has to reach the workspace pause.
        script.failures.insert(
            "/v1/messages/msg_c1".into(),
            std::iter::repeat_n((500, "internal_error", None), 3).collect(),
        );
        script
            .failures
            .insert("/v1/messages/msg_c1_1".into(), overloaded());
    }
    let named = Endpoint::Name("peer-c1".into());
    assert!(core.history(&named, None).await.is_err());
    let before = script.lock().unwrap().requests.len();

    let error = core.history(&named, None).await.unwrap_err();
    assert_paused(&error);
    assert_eq!(script.lock().unwrap().requests.len(), before);
}

#[tokio::test]
async fn a_conversation_listed_with_a_null_last_message_is_read_again_on_a_reply() {
    if ran_without_file_roots(
        "a_conversation_listed_with_a_null_last_message_is_read_again_on_a_reply",
    ) {
        return;
    }
    let mut listed = conversation("c1", "m1");
    listed["last_message"] = Value::Null;
    let (_home, core, script) = core_with(vec![listed]).await;
    assert!(found_nothing(&core).await);
    core.person_woke();
    assert!(found_nothing(&core).await);
    assert_eq!(script.lock().unwrap().count("/v1/dm/c1/messages"), 2);
}
