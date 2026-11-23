//! `messages.inbox` and `messages.mark_read` against a scripted Relaycast,
//! read sync (a `message.read` from another device re-reads messages), and
//! reading a conversation acknowledging (on Relaycast: reading) only that
//! conversation's deliveries.

use super::*;
use crate::relay::cloud_session::{AgentOwner, CloudAccess};
use crate::relay::daemon::{Config, Plugins};
use crate::relay::delivery::DeliveryTiming;
use crate::relay::paths::CorePaths;
use crate::relay::protocol::{Event, Topic};
use crate::relay::push::PushTiming;
use futures_util::future::BoxFuture;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A Relaycast that answers `GET /v1/inbox` with `inbox` and marks any
/// message read but `msg_gone`, a path's queued failure statuses first.
/// With `inbox` null the inbox is counted as Relaycast counts it: the
/// messages after your read position, which an ack or a read moves.
#[derive(Default)]
struct Script {
    inbox: Value,
    failures: HashMap<String, VecDeque<u16>>,
    /// `(method, path, bearer token)` of every request.
    requests: Vec<(String, String, String)>,
    /// 1:1 conversations with `peer-<id>`, on channel `ch_<id>`, and their
    /// messages from the peer, oldest first.
    conversations: Vec<(String, Vec<String>)>,
    /// Pending deliveries, oldest first: `(delivery id, message id, channel)`.
    deliveries: Vec<(String, String, String)>,
    acked: Vec<String>,
    /// Message ids marked read, in order.
    read: Vec<String>,
    /// How many of the next `GET /v1/deliveries` answer an empty queue, as
    /// one listed before a delivery arrived does.
    hidden_lists: usize,
}

/// Relaycast's message ids are increasing integers in decimal.
fn id_key(id: &str) -> (usize, &str) {
    (id.len(), id)
}

impl Script {
    fn count(&self, method: &str, path: &str) -> usize {
        self.requests
            .iter()
            .filter(|(m, p, _)| m == method && p == path)
            .count()
    }

    /// The tokens requests to `path` were sent with.
    fn tokens(&self, path: &str) -> Vec<&str> {
        self.requests
            .iter()
            .filter(|(_, p, _)| p == path)
            .map(|(_, _, t)| t.as_str())
            .collect()
    }

    fn pending(&self) -> impl Iterator<Item = &(String, String, String)> {
        self.deliveries
            .iter()
            .filter(|(id, _, _)| !self.acked.contains(id))
    }

    /// Your read position in conversation `id`: the newest message read
    /// or acked in it.
    fn position(&self, id: &str, messages: &[String]) -> Option<String> {
        let channel = format!("ch_{id}");
        let acked = self
            .deliveries
            .iter()
            .filter(|(d, _, c)| *c == channel && self.acked.contains(d))
            .map(|(_, m, _)| m);
        let read = self.read.iter().filter(|m| messages.contains(m));
        acked
            .chain(read)
            .max_by(|a, b| id_key(a).cmp(&id_key(b)))
            .cloned()
    }

    fn counted_inbox(&self) -> Value {
        let unread: Vec<Value> = self
            .conversations
            .iter()
            .filter_map(|(id, messages)| {
                let position = self.position(id, messages);
                let n = messages
                    .iter()
                    .filter(|m| position.as_deref().is_none_or(|p| id_key(m) > id_key(p)))
                    .count();
                (n > 0).then(|| {
                    json!({"conversation_id": id, "from": format!("peer-{id}"),
                        "unread_count": n, "last_message": null})
                })
            })
            .collect();
        json!({"unread_channels": [], "mentions": [], "unread_dms": unread})
    }

    fn answer(&mut self, method: &str, target: &str, token: &str) -> (u16, Value) {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let limit: usize = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("limit="))
            .and_then(|n| n.parse().ok())
            .unwrap_or(100);
        let before: Option<String> = query
            .split('&')
            .find_map(|pair| pair.strip_prefix("before="))
            .map(str::to_string);
        self.requests
            .push((method.to_string(), path.to_string(), token.to_string()));
        if let Some(status) = self.failures.get_mut(path).and_then(VecDeque::pop_front) {
            let code = if status == 401 {
                "unauthorized"
            } else {
                "failed"
            };
            return (
                status,
                json!({"ok": false, "error": {"code": code, "message": code}}),
            );
        }
        let read = path
            .strip_prefix("/v1/messages/")
            .and_then(|p| p.strip_suffix("/read"));
        let history = path
            .strip_prefix("/v1/dm/")
            .and_then(|p| p.strip_suffix("/messages"));
        let ack = path
            .strip_prefix("/v1/deliveries/")
            .and_then(|p| p.strip_suffix("/ack"));
        let ok = |data: Value| (200, json!({"ok": true, "data": data}));
        match (method, path, read) {
            ("GET", "/v1/inbox", _) if self.inbox.is_null() => ok(self.counted_inbox()),
            ("GET", "/v1/inbox", _) => ok(self.inbox.clone()),
            ("GET", "/v1/deliveries", _) if self.hidden_lists > 0 => {
                self.hidden_lists -= 1;
                ok(json!([]))
            }
            ("GET", "/v1/deliveries", _) => ok(self
                .pending()
                .take(limit)
                .map(|(id, message, channel)| {
                    json!({"id": id, "message_id": message, "status": "queued",
                        "reason": "dm", "channel_id": channel,
                        "message": {"id": message, "channel_id": channel, "text": "hi"}})
                })
                .collect()),
            ("POST", _, _) if ack.is_some() => {
                let id = ack.unwrap().to_string();
                self.acked.push(id.clone());
                ok(json!({"id": id, "status": "acked"}))
            }
            ("GET", "/v1/dm/conversations", _) => ok(self
                .conversations
                .iter()
                .map(|(id, _)| {
                    json!({"id": id, "type": "1:1", "name": null, "participants": [
                        {"agent_id": "ag_owner", "agent_name": "owner"},
                        {"agent_id": format!("ag_{id}"), "agent_name": format!("peer-{id}")},
                    ], "last_message": null})
                })
                .collect()),
            ("GET", _, _) if history.is_some() => {
                let id = history.unwrap();
                let messages = self
                    .conversations
                    .iter()
                    .find(|(c, _)| c == id)
                    .map(|(_, m)| m.clone())
                    .unwrap_or_default();
                ok(messages
                    .iter()
                    .rev()
                    .filter(|m| {
                        before
                            .as_deref()
                            .is_none_or(|before| id_key(m) < id_key(before))
                    })
                    .take(HISTORY_LIMIT as usize)
                    .map(|m| {
                        json!({"id": m, "agent_id": format!("ag_{id}"),
                            "agent_name": format!("peer-{id}"),
                            "agent_address": format!("peer-{id}@elsewhere"),
                            "thread_id": null, "text": "hi",
                            "created_at": "2026-11-22T00:00:00Z"})
                    })
                    .collect())
            }
            ("GET", _, None) if path.starts_with("/v1/messages/") => {
                let id = &path["/v1/messages/".len()..];
                match self
                    .conversations
                    .iter()
                    .find(|(_, m)| m.iter().any(|m| m == id))
                {
                    Some((conversation, _)) => ok(json!({"id": id, "thread_id": null,
                        "channel_id": format!("ch_{conversation}"), "text": "hi"})),
                    None => (
                        404,
                        json!({"ok": false,
                        "error": {"code": "message_not_found", "message": id}}),
                    ),
                }
            }
            ("POST", _, Some(id)) if id != "msg_gone" => {
                self.read.push(id.to_string());
                (
                    200,
                    json!({"ok": true, "data": {"message_id": id, "agent_id": "ag_owner",
                    "read_at": "2026-11-22T00:00:00Z"}}),
                )
            }
            _ => (
                404,
                json!({"ok": false, "error": {"code": "message_not_found", "message": path}}),
            ),
        }
    }
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
                let head = String::from_utf8_lossy(&request).to_string();
                let mut words = head.split_whitespace();
                let method = words.next().unwrap_or("GET").to_string();
                let target = words.next().unwrap_or("/").to_string();
                let token = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("authorization")
                            .then(|| value.trim().trim_start_matches("Bearer ").to_string())
                    })
                    .unwrap_or_default();
                let (status, body) = script.lock().unwrap().answer(&method, &target, &token);
                let body = body.to_string();
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n\
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

/// Signed in as `owner`; each identity Cloud hands out has a new token
/// (`at_1`, `at_2`, …), as a recovered identity does.
struct SignedIn {
    base: String,
    issued: AtomicUsize,
}

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
        Box::pin(async move {
            Ok(if path.ends_with("/messaging/identity/credential") {
                let n = self.issued.fetch_add(1, Ordering::SeqCst) + 1;
                json!({"identity": {"name": "owner", "agentId": "ag_owner",
                    "token": format!("at_{n}"), "relaycastUrl": self.base}})
            } else {
                Value::Null
            })
        })
    }
}

struct Harness {
    _home: tempfile::TempDir,
    core: Arc<Core>,
    script: Arc<Mutex<Script>>,
    cloud: Arc<SignedIn>,
}

async fn harness(inbox: Value) -> Harness {
    let script = Arc::new(Mutex::new(Script {
        inbox,
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
        host_name: "inbox-test".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    let cloud = Arc::new(SignedIn {
        base,
        issued: AtomicUsize::new(0),
    });
    let plugins = Plugins {
        cloud: cloud.clone(),
        ..Plugins::default()
    };
    let core = Core::with_plugins(config, plugins).0;
    Harness {
        _home: temp,
        core,
        script,
        cloud,
    }
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
        .args(["--exact", &format!("relay::messaging::inbox_tests::{test}")])
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

fn invalidated_messages(events: &mut tokio::sync::broadcast::Receiver<Event>) -> usize {
    let mut found = 0;
    while let Ok(event) = events.try_recv() {
        if event.topic == Topic::Invalidated && event.data == json!({"what": "messages"}) {
            found += 1;
        }
    }
    found
}

fn relaycast_inbox() -> Value {
    json!({
        "unread_channels": [
            {"channel_name": "general", "unread_count": 4},
            {"channel_name": "quiet", "unread_count": 0},
        ],
        "mentions": [],
        "unread_dms": [
            {"conversation_id": "conv_1", "from": "reviewer", "unread_count": 2,
             "last_message": {"id": "msg_9", "text": "Two findings.",
                "created_at": "2026-11-22T10:00:00.000Z"}},
            // Some databases answer a count as a string.
            {"conversation_id": "conv_2", "from": "builder", "unread_count": "1",
             "last_message": null},
            {"conversation_id": "conv_3", "from": "idle", "unread_count": 0,
             "last_message": null},
        ],
        "recent_reactions": [],
    })
}

#[tokio::test]
async fn the_inbox_lists_what_relaycast_counts_as_unread() {
    if ran_without_file_roots("the_inbox_lists_what_relaycast_counts_as_unread") {
        return;
    }
    let h = harness(relaycast_inbox()).await;
    let inbox = h.core.inbox().await.unwrap();
    assert_eq!(
        serde_json::to_value(&inbox).unwrap(),
        json!({
            "identity": "owner",
            "unread": [
                {"conversation_id": "conv_1", "peer": "reviewer", "unread_count": 2,
                 "last_message": {"id": "msg_9", "text": "Two findings.",
                    "created_at": "2026-11-22T10:00:00.000Z"}},
                {"conversation_id": "conv_2", "peer": "builder", "unread_count": 1,
                 "last_message": null},
            ],
            "unread_channels": [{"channel": "general", "unread_count": 4}],
        })
    );
    let script = h.script.lock().unwrap();
    assert_eq!(script.count("GET", "/v1/inbox"), 1);
    // Read as you, with your identity's token.
    assert_eq!(script.tokens("/v1/inbox"), ["at_1"]);
}

#[tokio::test]
async fn a_refused_token_is_recovered_once_for_the_inbox() {
    if ran_without_file_roots("a_refused_token_is_recovered_once_for_the_inbox") {
        return;
    }
    let h = harness(relaycast_inbox()).await;
    h.script
        .lock()
        .unwrap()
        .failures
        .insert("/v1/inbox".into(), VecDeque::from([401]));
    let inbox = h.core.inbox().await.unwrap();
    assert_eq!(inbox.unread.len(), 2);
    assert_eq!(h.cloud.issued.load(Ordering::SeqCst), 2);
    let script = h.script.lock().unwrap();
    assert_eq!(script.tokens("/v1/inbox"), ["at_1", "at_2"]);
}

#[tokio::test]
async fn marking_read_posts_as_you_and_re_reads_messages() {
    if ran_without_file_roots("marking_read_posts_as_you_and_re_reads_messages") {
        return;
    }
    let h = harness(relaycast_inbox()).await;
    let mut events = h.core.hub.subscribe();
    h.core.mark_read("msg_9").await.unwrap();
    assert_eq!(
        h.script
            .lock()
            .unwrap()
            .count("POST", "/v1/messages/msg_9/read"),
        1
    );
    assert_eq!(invalidated_messages(&mut events), 1);
}

#[tokio::test]
async fn marking_an_unknown_message_read_is_not_found() {
    if ran_without_file_roots("marking_an_unknown_message_read_is_not_found") {
        return;
    }
    let h = harness(relaycast_inbox()).await;
    let mut events = h.core.hub.subscribe();
    let error = h.core.mark_read("msg_gone").await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::NotFound);
    assert_eq!(invalidated_messages(&mut events), 0);
}

#[tokio::test]
async fn a_refused_token_is_recovered_once_for_marking_read() {
    if ran_without_file_roots("a_refused_token_is_recovered_once_for_marking_read") {
        return;
    }
    let h = harness(relaycast_inbox()).await;
    h.script
        .lock()
        .unwrap()
        .failures
        .insert("/v1/messages/msg_9/read".into(), VecDeque::from([401, 401]));
    // Refused again after the one recovery: an error, not a loop.
    let error = h.core.mark_read("msg_9").await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Unauthorized);
    assert_eq!(h.cloud.issued.load(Ordering::SeqCst), 2);
    // The next try uses the recovered token and succeeds.
    h.core.mark_read("msg_9").await.unwrap();
    let script = h.script.lock().unwrap();
    assert_eq!(
        script.tokens("/v1/messages/msg_9/read"),
        ["at_1", "at_2", "at_2"]
    );
}

#[tokio::test]
async fn marking_nothing_read_sends_nothing() {
    let h = harness(relaycast_inbox()).await;
    let error = h.core.mark_read("  ").await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::InvalidParams);
    assert!(h.script.lock().unwrap().requests.is_empty());
    assert_eq!(h.cloud.issued.load(Ordering::SeqCst), 0);
}

/// Relaycast fans `message.read` out to the conversation on the `deliver`
/// frame, your own identity included, when you read on another device.
#[tokio::test]
async fn a_read_on_another_device_re_reads_messages() {
    let h = harness(relaycast_inbox()).await;
    h.core.person_identity(false).await.unwrap();
    let mut events = h.core.hub.subscribe();
    let frame = json!({
        "v": 1, "type": "deliver",
        "delivery_id": "evt_message_read_msg_9_ag_owner_2026_ag_owner",
        "agent_id": "ag_owner", "agent": "owner", "msg_id": "msg_9", "seq": 0,
        "mode": "wait",
        "payload": {"type": "message.read", "data": {
            "message_id": "msg_9", "agent_id": "ag_owner", "agent_name": "owner",
            "read_at": "2026-11-22T10:01:00.000Z", "conversation_id": "conv_1",
        }},
    });
    h.core.wake("@owner".into(), Some(frame));
    assert_eq!(invalidated_messages(&mut events), 1);
    // A receipt is not read back or marked again.
    let script = h.script.lock().unwrap();
    assert_eq!(script.count("POST", "/v1/messages/msg_9/read"), 0);
}

/// Message ids `from..from + n`, oldest first.
fn ids(from: u64, n: u64) -> Vec<String> {
    (from..from + n).map(|id| id.to_string()).collect()
}

/// A delivery to you for each of `messages`, in conversation `id`.
fn queued(id: &str, messages: &[String]) -> Vec<(String, String, String)> {
    messages
        .iter()
        .map(|m| (format!("del_{m}"), m.clone(), format!("ch_{id}")))
        .collect()
}

/// Conversations `a` and `b`, with `a_messages` and `b_messages` from the
/// peer and a delivery for each of them queued, `b`'s first.
async fn two_conversations(a_messages: Vec<String>, b_messages: Vec<String>) -> Harness {
    let h = harness(Value::Null).await;
    {
        let mut script = h.script.lock().unwrap();
        script.deliveries = queued("b", &b_messages);
        script.deliveries.extend(queued("a", &a_messages));
        script.conversations = vec![("a".into(), a_messages), ("b".into(), b_messages)];
    }
    h
}

fn acked_in(script: &Script, conversation: &str) -> usize {
    let channel = format!("ch_{conversation}");
    script
        .deliveries
        .iter()
        .filter(|(id, _, c)| *c == channel && script.acked.contains(id))
        .count()
}

fn peer(id: &str) -> Endpoint {
    Endpoint::Name(format!("peer-{id}"))
}

#[tokio::test]
async fn reading_one_conversation_leaves_the_others_unread() {
    if ran_without_file_roots("reading_one_conversation_leaves_the_others_unread") {
        return;
    }
    let h = two_conversations(ids(500, 2), ids(100, 3)).await;
    let history = h.core.history(&peer("a"), None).await.unwrap();
    assert_eq!(history.messages.len(), 2);
    h.core.reads_settled().await;
    {
        let script = h.script.lock().unwrap();
        assert_eq!(acked_in(&script, "b"), 0);
    }
    let inbox = h.core.inbox().await.unwrap();
    let unread: Vec<(&str, u64)> = inbox
        .unread
        .iter()
        .map(|c| (c.conversation_id.as_str(), c.unread_count))
        .collect();
    assert_eq!(unread, [("b", 3)]);
}

#[tokio::test]
async fn reading_a_conversation_acknowledges_its_own_deliveries() {
    if ran_without_file_roots("reading_a_conversation_acknowledges_its_own_deliveries") {
        return;
    }
    // 60 messages: the page holds the newest 50, and the 10 before it are
    // the same conversation's too.
    let h = two_conversations(ids(500, 60), ids(100, 1)).await;
    // One that arrives after the page is read is not yet seen.
    h.script
        .lock()
        .unwrap()
        .deliveries
        .push(("del_999".into(), "999".into(), "ch_a".into()));
    h.core.history(&peer("a"), None).await.unwrap();
    h.core.reads_settled().await;
    let script = h.script.lock().unwrap();
    assert_eq!(acked_in(&script, "a"), 60);
    assert!(!script.acked.contains(&"del_999".to_string()));
    assert_eq!(acked_in(&script, "b"), 0);
}

#[tokio::test]
async fn a_queue_led_by_other_conversations_is_read_on_past_them() {
    if ran_without_file_roots("a_queue_led_by_other_conversations_is_read_on_past_them") {
        return;
    }
    // 180 of b's come first, so each list of 200 holds only 20 of a's
    // 150: acknowledging those lets the next list reach the next 20.
    let h = two_conversations(ids(5_000, 150), ids(1_000, 180)).await;
    h.core.history(&peer("a"), None).await.unwrap();
    h.core.reads_settled().await;
    let script = h.script.lock().unwrap();
    assert_eq!(acked_in(&script, "a"), 150);
    assert_eq!(acked_in(&script, "b"), 0);
    // One list before the page (for new replies), the rest after it.
    assert!(script.count("GET", "/v1/deliveries") <= 1 + acks::QUEUE_PASSES);
}

#[tokio::test]
async fn a_queue_full_of_other_conversations_is_never_read_away() {
    if ran_without_file_roots("a_queue_full_of_other_conversations_is_never_read_away") {
        return;
    }
    // 200 of b's fill the whole list: a's cannot be reached without
    // reading b, so a's stay queued and b stays unread.
    let h = two_conversations(ids(5_000, 3), ids(1_000, 200)).await;
    h.core.history(&peer("a"), None).await.unwrap();
    h.core.reads_settled().await;
    {
        let script = h.script.lock().unwrap();
        assert!(script.acked.is_empty());
        // Before the page, and once after it.
        assert_eq!(script.count("GET", "/v1/deliveries"), 2);
        // a is read all the same, by its read position.
        assert_eq!(script.read, ["5002"]);
    }
    let inbox = h.core.inbox().await.unwrap();
    let unread: Vec<(&str, u64)> = inbox
        .unread
        .iter()
        .map(|c| (c.conversation_id.as_str(), c.unread_count))
        .collect();
    assert_eq!(unread, [("b", 200)]);
}

fn unread_in(inbox: &crate::relay::contract::directory::MessageInbox) -> Vec<(String, u64)> {
    inbox
        .unread
        .iter()
        .map(|c| (c.conversation_id.clone(), c.unread_count))
        .collect()
}

#[tokio::test]
async fn reading_a_conversation_whose_deliveries_expired_reads_it() {
    if ran_without_file_roots("reading_a_conversation_whose_deliveries_expired_reads_it") {
        return;
    }
    // a's messages are stored, but their deliveries expired: nothing to ack.
    let h = two_conversations(ids(500, 2), ids(100, 1)).await;
    h.script
        .lock()
        .unwrap()
        .deliveries
        .retain(|(_, _, c)| c != "ch_a");
    let before = h.core.inbox().await.unwrap();
    assert_eq!(unread_in(&before), [("a".into(), 2), ("b".into(), 1)]);
    h.core.history(&peer("a"), None).await.unwrap();
    h.core.reads_settled().await;
    let after = h.core.inbox().await.unwrap();
    assert_eq!(unread_in(&after), [("b".to_string(), 1)]);
    // Read once: reading it again with nothing new sends no second read.
    h.core.history(&peer("a"), None).await.unwrap();
    h.core.reads_settled().await;
    let script = h.script.lock().unwrap();
    assert_eq!(script.read, ["501"]);
    assert_eq!(acked_in(&script, "b"), 0);
}

#[tokio::test]
async fn an_older_page_moves_no_read_position() {
    if ran_without_file_roots("an_older_page_moves_no_read_position") {
        return;
    }
    let h = two_conversations(ids(500, 60), ids(100, 1)).await;
    let history = h.core.history(&peer("a"), Some("510")).await.unwrap();
    let mut page: Vec<&str> = history.messages.iter().map(|m| m.id.as_str()).collect();
    page.sort();
    assert_eq!(page, ids(500, 10));
    h.core.reads_settled().await;
    let script = h.script.lock().unwrap();
    assert!(script.read.is_empty());
    // Only the older page's deliveries: none from 510 on.
    let acked: Vec<&str> = script
        .deliveries
        .iter()
        .filter(|(d, _, _)| script.acked.contains(d))
        .map(|(_, m, _)| m.as_str())
        .collect();
    assert_eq!(acked, ids(500, 10));
}

#[tokio::test]
async fn history_returns_before_the_conversation_is_read() {
    if ran_without_file_roots("history_returns_before_the_conversation_is_read") {
        return;
    }
    let h = two_conversations(ids(500, 60), ids(100, 1)).await;
    let history = h.core.history(&peer("a"), None).await.unwrap();
    assert_eq!(history.messages.len(), HISTORY_LIMIT as usize);
    {
        // The page came back with no ack or read sent yet.
        let script = h.script.lock().unwrap();
        assert!(script.acked.is_empty());
        assert!(script.read.is_empty());
    }
    h.core.reads_settled().await;
    let script = h.script.lock().unwrap();
    assert_eq!(acked_in(&script, "a"), 60);
    assert_eq!(script.read, ["559"]);
}

#[tokio::test]
async fn a_delivery_listed_after_the_page_is_acknowledged() {
    if ran_without_file_roots("a_delivery_listed_after_the_page_is_acknowledged") {
        return;
    }
    // The queue is empty when history starts: the delivery arrives while
    // the page is read, and the page shows its message.
    let h = two_conversations(ids(500, 2), Vec::new()).await;
    h.script.lock().unwrap().hidden_lists = 1;
    h.core.history(&peer("a"), None).await.unwrap();
    h.core.reads_settled().await;
    let script = h.script.lock().unwrap();
    assert_eq!(acked_in(&script, "a"), 2);
}

#[tokio::test]
async fn a_pause_stops_the_read_before_any_ack() {
    if ran_without_file_roots("a_pause_stops_the_read_before_any_ack") {
        return;
    }
    let h = two_conversations(ids(500, 3), ids(100, 1)).await;
    h.script
        .lock()
        .unwrap()
        .failures
        .insert("/v1/messages/502/read".into(), VecDeque::from([429]));
    h.core.history(&peer("a"), None).await.unwrap();
    // The 429 pauses the workspace; the read waits it out, sending nothing.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let script = h.script.lock().unwrap();
    assert_eq!(script.count("POST", "/v1/messages/502/read"), 1);
    assert!(script.acked.is_empty());
    // Only the list made before the page: none after it.
    assert_eq!(script.count("GET", "/v1/deliveries"), 1);
}

#[tokio::test]
async fn a_read_left_from_before_sign_out_leaves_the_next_reads_alone() {
    if ran_without_file_roots("a_read_left_from_before_sign_out_leaves_the_next_reads_alone") {
        return;
    }
    let h = two_conversations(ids(500, 2), ids(100, 1)).await;
    h.core.history(&peer("a"), None).await.unwrap();
    // Signed out and in again before the read ran: the identity's reads now
    // belong to a task started since, with one read waiting.
    let key = {
        let mut state = h.core.messaging.lock().unwrap();
        let key = state.settling.keys().next().cloned().unwrap();
        let waiting = state.settling[&key].1.clone();
        state.settling.insert(key.clone(), (u64::MAX, waiting));
        key
    };
    for _ in 0..200 {
        if acked_in(&h.script.lock().unwrap(), "a") == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let state = h.core.messaging.lock().unwrap();
    assert_eq!(
        state.settling.get(&key).map(|(owner, _)| *owner),
        Some(u64::MAX)
    );
}
