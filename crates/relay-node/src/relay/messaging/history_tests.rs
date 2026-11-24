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
    /// Messages in each conversation, newest first (`msg_<id>`, then
    /// `msg_<id>_1`, ...); one when zero. A page is up to `limit` of them,
    /// those older than `before` when it is given.
    page: usize,
    /// A message, by conversation id and position, that names another
    /// address for its sender than `peer-<id>@elsewhere`.
    addressed: HashMap<(String, usize), String>,
    /// Holds the next listing answer, read when the request arrives:
    /// `reached` is notified then, and the answer is sent once `release` is.
    hold: Option<Hold>,
    /// Queued deliveries, by id and the id of their message, until
    /// acknowledged.
    deliveries: Vec<(String, String)>,
    /// How long each answer takes, as a round trip to a distant Relaycast would.
    delay: Duration,
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

    fn answer(&mut self, path: &str, query: &str) -> (u16, Option<u64>, Value) {
        let param = |name: &str| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
                .map(str::to_string)
        };
        let limit: usize = param("limit").and_then(|n| n.parse().ok()).unwrap_or(100);
        let before = param("before");
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
        if path == "/v1/dm" {
            let data = json!({"id": "m_sent", "conversation_id": "c2"});
            return (200, None, json!({"ok": true, "data": data}));
        }
        if let Some(id) = path
            .strip_prefix("/v1/deliveries/")
            .and_then(|p| p.strip_suffix("/ack"))
        {
            self.deliveries.retain(|(queued, _)| queued != id);
            let data = json!({"id": id, "message_id": format!("msg_{id}"),
                "channel_id": "ch_dm", "agent_id": "ag_owner", "status": "acked",
                "mode": "durable", "priority": "normal", "created_at": "2026-11-15T00:00:00Z"});
            return (200, None, json!({"ok": true, "data": data}));
        }
        let data = match (path, messages) {
            ("/v1/deliveries", _) => self
                .deliveries
                .iter()
                .map(|(id, message)| {
                    json!({"id": id, "message_id": message, "status": "pending",
                        "reason": "dm", "channel_id": "ch_dm",
                        "message": {"agent_name": "peer-c1", "text": "hello"}})
                })
                .collect(),
            ("/v1/dm/conversations", _) => Value::Array(self.conversations.clone()),
            (_, Some(id)) => {
                let position = |message: &str| match message.strip_prefix(&format!("msg_{id}")) {
                    Some("") => Some(0),
                    Some(rest) => rest.strip_prefix('_')?.parse::<usize>().ok(),
                    None => None,
                };
                // Older than `before`; a cursor from elsewhere matches nothing.
                let from = match before.as_deref() {
                    None => 0,
                    Some(before) => position(before).map_or(usize::MAX, |n| n + 1),
                };
                (from..self.page.max(1))
                    .take(limit)
                    .map(|n| {
                        let message = if n == 0 {
                            format!("msg_{id}")
                        } else {
                            format!("msg_{id}_{n}")
                        };
                        let address = self
                            .addressed
                            .get(&(id.to_string(), n))
                            .cloned()
                            .unwrap_or_else(|| format!("peer-{id}@elsewhere"));
                        json!({
                            "id": message, "agent_id": format!("ag_{id}"),
                            "agent_name": format!("peer-{id}"),
                            "agent_address": address,
                            "thread_id": null, "text": "hello",
                            "created_at": "2026-11-15T00:00:00Z",
                        })
                    })
                    .collect()
            }
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

/// A held listing answer ([`Script::hold`]).
struct Hold {
    reached: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
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

/// [`conversation`] with its peer going by [`PEER`]'s name: one that may
/// prove [`PEER`], and is read for the proof, which it does not hold.
fn named_like_peer(id: &str, last: &str) -> Value {
    let mut listed = conversation(id, last);
    listed["participants"][1]["agent_name"] = json!(PEER.split('@').next().unwrap());
    listed
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
                let (path, query) = target.split_once('?').unwrap_or((target, ""));
                let (path, query) = (path.to_string(), query.to_string());
                let delay = script.lock().unwrap().delay;
                tokio::time::sleep(delay).await;
                let (status, retry_after, body) = script.lock().unwrap().answer(&path, &query);
                let hold = match path.as_str() {
                    "/v1/dm/conversations" => script.lock().unwrap().hold.take(),
                    _ => None,
                };
                if let Some(hold) = hold {
                    hold.reached.notify_one();
                    hold.release.notified().await;
                }
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

/// Signed in as `user` (`owner` at first; `None` when signed out), whose
/// Relaycast is at the given base URL. Every user is issued the same
/// identity name and token.
struct SignedIn {
    base: String,
    user: User,
}

type User = Arc<Mutex<Option<String>>>;

impl CloudAccess for SignedIn {
    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: "https://agentrelay.example".into(),
            workspace_id: "cloud-workspace".into(),
            user_id: Some(self.user.lock().unwrap().clone()?),
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
        let base = self.base.clone();
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
    let (temp, core) = core_at(base);
    (temp, core, script)
}

/// A core signed in to the Relaycast at `base`.
fn core_at(base: String) -> (tempfile::TempDir, Arc<Core>) {
    let (temp, core, _) = core_as(base);
    (temp, core)
}

/// A core signed in to the Relaycast at `base`, and who is signed in.
fn core_as(base: String) -> (tempfile::TempDir, Arc<Core>, User) {
    let user: User = Arc::new(Mutex::new(Some("owner".into())));
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
        cloud: Arc::new(SignedIn {
            base,
            user: user.clone(),
        }),
        ..Plugins::default()
    };
    let core = Core::with_plugins(config, plugins).0;
    (temp, core, user)
}

fn peer() -> Endpoint {
    Endpoint::Address(PEER.into())
}

/// Whether the history with [`PEER`] is empty, as it is without proof.
async fn found_nothing(core: &Arc<Core>) -> bool {
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
        named_like_peer("c1", "m1"),
        named_like_peer("c2", "m2"),
        named_like_peer("c3", "m3"),
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
    script.lock().unwrap().conversations[1] = named_like_peer("c2", "m2-next");
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
        named_like_peer("c1", "m1"),
        named_like_peer("c2", "m2"),
        named_like_peer("c3", "m3"),
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
    let mut listed = named_like_peer("c1", "m1");
    listed["last_message"] = Value::Null;
    let (_home, core, script) = core_with(vec![listed]).await;
    assert!(found_nothing(&core).await);
    core.person_woke();
    assert!(found_nothing(&core).await);
    assert_eq!(script.lock().unwrap().count("/v1/dm/c1/messages"), 2);
}

/// The Relaycast requests one history call makes, by kind.
#[derive(Debug, Default, PartialEq, Eq)]
struct Calls {
    deliveries: usize,
    acks: usize,
    /// `POST /v1/messages/{id}/read`.
    marks: usize,
    listings: usize,
    pages: usize,
    details: usize,
}

impl Calls {
    fn of(requests: &[String]) -> Calls {
        let mut calls = Calls::default();
        for path in requests {
            match path.as_str() {
                "/v1/deliveries" => calls.deliveries += 1,
                "/v1/dm/conversations" => calls.listings += 1,
                p if p.ends_with("/ack") => calls.acks += 1,
                p if p.starts_with("/v1/messages/") && p.ends_with("/read") => calls.marks += 1,
                p if p.starts_with("/v1/dm/") => calls.pages += 1,
                p if p.starts_with("/v1/messages/") => calls.details += 1,
                // Agent sync after the identity is fetched: not history's.
                _ => {}
            }
        }
        calls
    }

    fn total(&self) -> usize {
        self.deliveries + self.acks + self.marks + self.listings + self.pages + self.details
    }
}

/// One history call: the requests made before it answered, those made
/// after (the conversation read settled on Relaycast), and how long it
/// took to answer.
async fn call(
    core: &Arc<Core>,
    script: &Mutex<Script>,
    endpoint: &Endpoint,
) -> (Calls, Calls, Duration) {
    core.reads_settled().await;
    let before = script.lock().unwrap().requests.len();
    let started = Instant::now();
    core.history(endpoint, None).await.unwrap();
    let took = started.elapsed();
    let answered = script.lock().unwrap().requests.len();
    core.reads_settled().await;
    let requests = script.lock().unwrap().requests.clone();
    (
        Calls::of(&requests[before..answered]),
        Calls::of(&requests[answered..]),
        took,
    )
}

fn three() -> Vec<Value> {
    vec![
        conversation("c1", "m1"),
        conversation("c2", "m2"),
        conversation("c3", "m3"),
    ]
}

/// The requests before the answer: deliveries, listings, pages, details.
fn read(deliveries: usize, listings: usize, pages: usize, details: usize) -> Calls {
    Calls {
        deliveries,
        listings,
        pages,
        details,
        ..Calls::default()
    }
}

/// The requests after the answer: deliveries, acks, marks.
fn settled(deliveries: usize, acks: usize, marks: usize) -> Calls {
    Calls {
        deliveries,
        acks,
        marks,
        ..Calls::default()
    }
}

/// A queued delivery of the message `message`.
fn queued(id: &str, message: &str) -> (String, String) {
    (id.into(), message.into())
}

/// Makes the kept listing `by` older, as the time between two calls would.
fn age(core: &Core, by: Duration) {
    if let Some(kept) = core.messaging.lock().unwrap().listing.as_mut() {
        kept.at = kept.at.checked_sub(by).unwrap();
    }
}

/// How often the apps re-read an open conversation.
const FOLLOW: Duration = Duration::from_secs(9);

/// The Relaycast requests each kind of history call makes, before its
/// answer and after it. A change that adds a round trip fails here.
#[tokio::test]
async fn request_counts_per_history_call() {
    if ran_without_file_roots("request_counts_per_history_call") {
        return;
    }
    let named = Endpoint::Name("peer-c2".into());
    let address = Endpoint::Address("peer-c2@elsewhere".into());
    // A distant Relaycast: the times printed show the serial waits.
    let rtt = Duration::from_millis(40);
    let mut rows = Vec::new();
    let mut row = |case: &'static str,
                   (before, after, took): (Calls, Calls, Duration),
                   want: (Calls, Calls)| {
        rows.push((case, before.total(), after.total(), took));
        assert_eq!((before, after), want, "{case}");
    };

    let (_home, core, script) = core_with(three()).await;
    script.lock().unwrap().delay = rtt;
    row(
        "name, first",
        call(&core, &script, &named).await,
        (read(1, 1, 1, 1), settled(1, 0, 1)),
    );
    row(
        "name, following",
        call(&core, &script, &named).await,
        (read(1, 0, 1, 0), settled(1, 0, 0)),
    );
    age(&core, FOLLOW);
    row(
        "name, following at 9 s",
        call(&core, &script, &named).await,
        (read(1, 0, 1, 0), settled(1, 0, 0)),
    );
    age(&core, LISTING_TTL);
    row(
        "name, after the kept time",
        call(&core, &script, &named).await,
        (read(1, 1, 1, 0), settled(1, 0, 0)),
    );
    // An empty answer does not rest on the kept listing: it is read again,
    // one listing more than a found conversation costs.
    let absent = Endpoint::Name("peer-c9".into());
    row(
        "name, absent",
        call(&core, &script, &absent).await,
        (read(1, 1, 0, 0), Calls::default()),
    );

    let (_home, core, script) = core_with(three()).await;
    script.lock().unwrap().delay = rtt;
    // c2, whose peer goes by the address's name, is read first: its newest
    // page is the proof and the page shown, and c1 is never read.
    row(
        "address, first",
        call(&core, &script, &address).await,
        (read(1, 1, 1, 1), settled(1, 0, 1)),
    );
    row(
        "address, remembered",
        call(&core, &script, &address).await,
        (read(1, 0, 1, 0), settled(1, 0, 0)),
    );
    age(&core, FOLLOW);
    row(
        "address, following at 9 s",
        call(&core, &script, &address).await,
        (read(1, 0, 1, 0), settled(1, 0, 0)),
    );
    // Read again, the listing shows c2 first (remembered): its newest page
    // is the proof and the answer, and c1 is not read.
    age(&core, LISTING_TTL);
    row(
        "address, after the kept time",
        call(&core, &script, &address).await,
        (read(1, 1, 1, 0), settled(1, 0, 0)),
    );
    // After the listing is read again, c1 is not: it did not change.
    core.person_woke();
    row(
        "address, after a wake",
        call(&core, &script, &address).await,
        (read(1, 1, 1, 0), settled(1, 0, 0)),
    );
    // No conversation lists an agent by its name: none is read, the kept
    // listing is read again, and the miss is cached off that one.
    let absent = Endpoint::Address("peer-c9@elsewhere".into());
    row(
        "address, absent",
        call(&core, &script, &absent).await,
        (read(1, 1, 0, 0), Calls::default()),
    );
    row(
        "address, absent, missed",
        call(&core, &script, &absent).await,
        (read(1, 0, 0, 0), Calls::default()),
    );

    let (_home, core, script) = core_with(three()).await;
    script.lock().unwrap().delay = rtt;
    call(&core, &script, &named).await;
    // One for the conversation read, four for others.
    script.lock().unwrap().deliveries = vec![
        queued("del_1", "msg_c2"),
        queued("del_2", "msg_c1"),
        queued("del_3", "msg_c1"),
        queued("del_4", "msg_c3"),
        queued("del_5", "msg_c3"),
    ];
    // New deliveries read the listing again; after the answer, only the
    // read conversation's delivery is acknowledged.
    row(
        "name, 5 queued",
        call(&core, &script, &named).await,
        (read(1, 1, 1, 0), settled(1, 1, 0)),
    );
    row(
        "name, after queued",
        call(&core, &script, &named).await,
        (read(1, 0, 1, 0), settled(1, 0, 0)),
    );

    let (_home, core, script) = core_with(three()).await;
    {
        let mut script = script.lock().unwrap();
        script.delay = rtt;
        script.page = 50;
    }
    row(
        "name, 50 incomplete",
        call(&core, &script, &named).await,
        (read(1, 1, 1, 50), settled(1, 0, 1)),
    );
    row(
        "name, 50 following",
        call(&core, &script, &named).await,
        (read(1, 0, 1, 0), settled(1, 0, 0)),
    );

    for (case, before, after, took) in &rows {
        println!("| {case} | {before} | {after} | {} ms |", took.as_millis());
    }
}

#[tokio::test]
async fn reading_a_conversation_acknowledges_its_deliveries_after_the_answer() {
    if ran_without_file_roots("reading_a_conversation_acknowledges_its_deliveries_after_the_answer")
    {
        return;
    }
    let (_home, core, script) = core_with(three()).await;
    let named = Endpoint::Name("peer-c2".into());
    let queue = || {
        let script = script.lock().unwrap();
        let queued: Vec<String> = script.deliveries.iter().map(|(id, _)| id.clone()).collect();
        (Calls::of(&script.requests).acks, queued)
    };
    script.lock().unwrap().deliveries = vec![queued("del_1", "msg_c2"), queued("del_2", "msg_c1")];
    core.history(&named, None).await.unwrap();
    core.reads_settled().await;
    // This conversation's, once; another conversation's stays queued.
    assert_eq!(queue(), (1, vec!["del_2".to_string()]));
    core.history(&named, None).await.unwrap();
    core.reads_settled().await;
    assert_eq!(queue(), (1, vec!["del_2".to_string()]));
    script
        .lock()
        .unwrap()
        .deliveries
        .push(queued("del_3", "msg_c2"));
    core.history(&named, None).await.unwrap();
    core.reads_settled().await;
    assert_eq!(queue(), (2, vec!["del_2".to_string()]));
}

#[tokio::test]
async fn a_reply_lets_a_missed_address_find_its_proof_on_the_same_call() {
    if ran_without_file_roots("a_reply_lets_a_missed_address_find_its_proof_on_the_same_call") {
        return;
    }
    let (_home, core, script) = core_with(vec![conversation("c1", "m1")]).await;
    let address = Endpoint::Address("peer-c9@elsewhere".into());
    assert!(core
        .history(&address, None)
        .await
        .unwrap()
        .messages
        .is_empty());

    // The conversation that proves the address appears; without a reply
    // the miss still holds.
    script
        .lock()
        .unwrap()
        .conversations
        .push(conversation("c9", "m9"));
    assert!(core
        .history(&address, None)
        .await
        .unwrap()
        .messages
        .is_empty());

    // A reply is queued: the call that sees it forgets the miss
    // and the kept listing, and finds the proof.
    script.lock().unwrap().deliveries = vec![queued("del_9", "msg_c9")];
    let found = core.history(&address, None).await.unwrap();
    assert_eq!(found.messages.len(), 1);
    assert_eq!(found.messages[0].id, "msg_c9");
}

#[tokio::test]
async fn a_refused_token_reads_the_listing_again() {
    if ran_without_file_roots("a_refused_token_reads_the_listing_again") {
        return;
    }
    let (_home, core, script) = core_with(three()).await;
    let named = Endpoint::Name("peer-c2".into());
    core.history(&named, None).await.unwrap();
    script.lock().unwrap().failures.insert(
        "/v1/dm/c2/messages".into(),
        [(401, "unauthorized", None)].into(),
    );
    let history = core.history(&named, None).await.unwrap();
    assert_eq!(history.messages.len(), 1);
    // Read once, then again with the fresh identity after the refusal.
    assert_eq!(script.lock().unwrap().count("/v1/dm/conversations"), 2);
}

#[tokio::test]
async fn a_send_or_a_wake_reads_the_listing_again() {
    if ran_without_file_roots("a_send_or_a_wake_reads_the_listing_again") {
        return;
    }
    let (_home, core, script) = core_with(three()).await;
    let address = Endpoint::Address("peer-c2@elsewhere".into());
    let listings = || script.lock().unwrap().count("/v1/dm/conversations");
    core.history(&address, None).await.unwrap();
    core.history(&address, None).await.unwrap();
    assert_eq!(listings(), 1);

    core.send_as_person(&address, "hello", None).await.unwrap();
    core.history(&address, None).await.unwrap();
    assert_eq!(listings(), 2);

    // A conversation the listing no longer shows is not shown once the
    // listing is read again.
    script.lock().unwrap().conversations.remove(1);
    core.person_woke();
    assert!(core
        .history(&address, None)
        .await
        .unwrap()
        .messages
        .is_empty());
    assert_eq!(listings(), 3);
}

/// A 1:1 conversation of `owner` with `peers` (agent id, name).
fn listed_with(id: &str, peers: &[(&str, &str)]) -> Value {
    let mut participants = vec![json!({"agent_id": "ag_owner", "agent_name": "owner"})];
    participants.extend(
        peers
            .iter()
            .map(|(agent_id, name)| json!({"agent_id": agent_id, "agent_name": name})),
    );
    json!({"id": id, "type": "1:1", "participants": participants,
        "last_message": {"id": "m7", "text": "hello"}})
}

#[tokio::test]
async fn an_address_with_the_peers_agent_id_is_proved_without_reading_a_page() {
    if ran_without_file_roots("an_address_with_the_peers_agent_id_is_proved_without_reading_a_page")
    {
        return;
    }
    let (_home, core, script) = core_with(vec![listed_with("c7", &[("4242", "peer-c7")])]).await;
    let address = Endpoint::Address("peer-c7@host-4242".into());
    let history = core.history(&address, None).await.unwrap();
    assert_eq!(history.messages.len(), 1);
    // The one page read is the answer.
    assert_eq!(script.lock().unwrap().count("/v1/dm/c7/messages"), 1);
    // Paging back reads only the older page: no page for the proof.
    core.history(&address, Some("msg_c7")).await.unwrap();
    assert_eq!(script.lock().unwrap().count("/v1/dm/c7/messages"), 2);
}

/// What a case is, the peers its conversation lists, and the address.
type Case = (
    &'static str,
    &'static [(&'static str, &'static str)],
    &'static str,
);

#[tokio::test]
async fn participants_that_do_not_prove_the_address_fall_back_to_the_messages() {
    if ran_without_file_roots(
        "participants_that_do_not_prove_the_address_fall_back_to_the_messages",
    ) {
        return;
    }
    let cases: [Case; 4] = [
        ("another id", &[("4242", "peer-c7")], "peer-c7@host-9999"),
        (
            "another name",
            &[("4242", "someone-else")],
            "peer-c7@host-4242",
        ),
        (
            "three participants",
            &[("4242", "peer-c7"), ("ag_third", "third")],
            "peer-c7@host-4242",
        ),
        ("your own name", &[("4242", "owner")], "owner@host-4242"),
    ];
    for (case, peers, address) in cases {
        let (_home, core, script) = core_with(vec![listed_with("c7", peers)]).await;
        let history = core
            .history(&Endpoint::Address(address.into()), None)
            .await
            .unwrap();
        // Not selected: the page is read for a message proof, which the
        // address does not have.
        assert!(history.messages.is_empty(), "{case}");
        assert_eq!(
            script.lock().unwrap().count("/v1/dm/c7/messages"),
            1,
            "{case}"
        );
    }
}

#[tokio::test]
async fn a_sign_out_or_another_account_reads_the_listing_again() {
    if ran_without_file_roots("a_sign_out_or_another_account_reads_the_listing_again") {
        return;
    }
    let script = Arc::new(Mutex::new(Script {
        conversations: three(),
        ..Script::default()
    }));
    let (_home, core, user) = core_as(serve(script.clone()).await);
    let named = Endpoint::Name("peer-c2".into());
    let listings = || script.lock().unwrap().count("/v1/dm/conversations");
    core.history(&named, None).await.unwrap();
    core.history(&named, None).await.unwrap();
    assert_eq!(listings(), 1);

    // Another account, issued the same identity name and token.
    *user.lock().unwrap() = Some("second".into());
    core.history(&named, None).await.unwrap();
    assert_eq!(listings(), 2);
    core.history(&named, None).await.unwrap();
    assert_eq!(listings(), 2);

    // Signed out, then in again as the same account.
    *user.lock().unwrap() = None;
    assert!(core.history(&named, None).await.is_err());
    assert!(core.messaging.lock().unwrap().listing.is_none());
    *user.lock().unwrap() = Some("second".into());
    core.history(&named, None).await.unwrap();
    assert_eq!(listings(), 3);
}

#[tokio::test]
async fn a_listing_kept_for_another_identity_or_token_is_not_served() {
    if ran_without_file_roots("a_listing_kept_for_another_identity_or_token_is_not_served") {
        return;
    }
    let (_home, core, script) = core_with(three()).await;
    let named = Endpoint::Name("peer-c2".into());
    let listings = || script.lock().unwrap().count("/v1/dm/conversations");
    core.history(&named, None).await.unwrap();
    for (n, kept_for) in ["another identity", "another token"]
        .into_iter()
        .enumerate()
    {
        {
            // A listing that shows nothing, kept for someone else.
            let mut state = core.messaging.lock().unwrap();
            let kept = state.listing.as_mut().unwrap();
            match n {
                0 => kept.key.1 = "someone-else".into(),
                _ => kept.key.3 = Secret::new("at_other"),
            }
            kept.conversations.clear();
        }
        let history = core.history(&named, None).await.unwrap();
        assert_eq!(history.messages.len(), 1, "{kept_for}");
        assert_eq!(listings(), 2 + n, "{kept_for}");
    }
}

#[tokio::test]
async fn a_conversation_missing_from_the_kept_listing_is_found_at_once() {
    if ran_without_file_roots("a_conversation_missing_from_the_kept_listing_is_found_at_once") {
        return;
    }
    let (_home, core, script) = core_with(vec![conversation("c1", "m1")]).await;
    let listings = || script.lock().unwrap().count("/v1/dm/conversations");
    core.history(&Endpoint::Name("peer-c1".into()), None)
        .await
        .unwrap();
    assert_eq!(listings(), 1);

    // Started elsewhere after the listing was kept, with no delivery seen
    // here: found by name and by address on the next read.
    script
        .lock()
        .unwrap()
        .conversations
        .push(conversation("c8", "m8"));
    let named = core
        .history(&Endpoint::Name("peer-c8".into()), None)
        .await
        .unwrap();
    assert_eq!(named.messages.len(), 1);
    assert_eq!(listings(), 2);
    script
        .lock()
        .unwrap()
        .conversations
        .push(conversation("c9", "m9"));
    let address = Endpoint::Address("peer-c9@elsewhere".into());
    let found = core.history(&address, None).await.unwrap();
    assert_eq!(found.messages[0].id, "msg_c9");
    assert_eq!(listings(), 3);
}

#[tokio::test]
async fn a_miss_is_cached_only_off_a_listing_read_by_the_call() {
    if ran_without_file_roots("a_miss_is_cached_only_off_a_listing_read_by_the_call") {
        return;
    }
    let (_home, core, script) = core_with(vec![conversation("c1", "m1")]).await;
    let listings = || script.lock().unwrap().count("/v1/dm/conversations");
    let address = Endpoint::Address("peer-c9@elsewhere".into());
    core.history(&Endpoint::Name("peer-c1".into()), None)
        .await
        .unwrap();
    // The kept listing does not show the conversation, and neither does
    // the one read for this call: that one, and only it, caches the miss.
    assert!(core
        .history(&address, None)
        .await
        .unwrap()
        .messages
        .is_empty());
    assert_eq!(listings(), 2);
    let workspace = "cloud-workspace".to_string();
    let miss = (workspace, "owner".to_string(), address.key());
    assert!(core.messaging.lock().unwrap().misses.contains_key(&miss));
    // The listing read for the miss is the one kept.
    assert!(core.messaging.lock().unwrap().listing.is_some());
}

#[tokio::test]
async fn a_listing_read_before_a_send_is_not_kept_after_it() {
    if ran_without_file_roots("a_listing_read_before_a_send_is_not_kept_after_it") {
        return;
    }
    let (_home, core, script) = core_with(three()).await;
    let named = Endpoint::Name("peer-c2".into());
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    script.lock().unwrap().hold = Some(Hold {
        reached: reached.clone(),
        release: release.clone(),
    });
    let reading = tokio::spawn({
        let core = core.clone();
        let named = named.clone();
        async move { core.history(&named, None).await }
    });
    // The listing is read; before its answer arrives, a send drops the
    // kept listing.
    reached.notified().await;
    core.send_as_person(&named, "hello", None).await.unwrap();
    release.notify_one();
    // The answer is still returned to its caller, but not kept.
    let history = reading.await.unwrap().unwrap();
    assert_eq!(history.messages.len(), 1);
    assert!(core.messaging.lock().unwrap().listing.is_none());
    core.history(&named, None).await.unwrap();
    assert_eq!(script.lock().unwrap().count("/v1/dm/conversations"), 2);
}

#[tokio::test]
async fn a_paused_delivery_poll_is_not_answered_from_the_kept_listing() {
    if ran_without_file_roots("a_paused_delivery_poll_is_not_answered_from_the_kept_listing") {
        return;
    }
    let (_home, core, script) = core_with(three()).await;
    core.history(&Endpoint::Name("peer-c2".into()), None)
        .await
        .unwrap();
    core.reads_settled().await;
    script
        .lock()
        .unwrap()
        .failures
        .insert("/v1/deliveries".into(), overloaded());
    // A name the kept listing does not show: the pause, not an empty list.
    let error = core
        .history(&Endpoint::Name("peer-c9".into()), None)
        .await
        .unwrap_err();
    assert_paused(&error);
    let script = script.lock().unwrap();
    assert_eq!(script.count("/v1/dm/conversations"), 1);
    assert_eq!(script.message_reads(), 1);
}

#[tokio::test]
async fn a_refused_delivery_poll_reads_the_listing_with_the_refused_token() {
    if ran_without_file_roots("a_refused_delivery_poll_reads_the_listing_with_the_refused_token") {
        return;
    }
    let (_home, core, script) = core_with(three()).await;
    let named = Endpoint::Name("peer-c2".into());
    core.history(&named, None).await.unwrap();
    core.reads_settled().await;
    {
        let mut script = script.lock().unwrap();
        script.requests.clear();
        // The token is refused by the next poll and listing.
        for path in ["/v1/deliveries", "/v1/dm/conversations"] {
            script
                .failures
                .insert(path.into(), [(401, "unauthorized", None)].into());
        }
    }
    // The listing request follows the refused poll, as it did before the
    // listing was kept; the refusal fetches the token again and the read
    // is made with it.
    let history = core.history(&named, None).await.unwrap();
    assert_eq!(history.messages[0].id, "msg_c2");
    let script = script.lock().unwrap();
    let reads: Vec<&str> = script
        .requests
        .iter()
        .map(String::as_str)
        .filter(|p| p.starts_with("/v1/d"))
        .take(3)
        .collect();
    assert_eq!(
        reads,
        ["/v1/deliveries", "/v1/dm/conversations", "/v1/deliveries"]
    );
    assert_eq!(script.count("/v1/dm/conversations"), 2);
    assert_eq!(script.count("/v1/dm/c2/messages"), 1);
}

#[tokio::test]
async fn an_older_page_holds_the_proof_and_each_page_is_the_one_asked_for() {
    if ran_without_file_roots("an_older_page_holds_the_proof_and_each_page_is_the_one_asked_for") {
        return;
    }
    let (_home, core, script) = core_with(vec![conversation("c1", "m1")]).await;
    let total = HISTORY_LIMIT as usize + 10;
    let address = Endpoint::Address("peer-c1@older-machine".into());
    {
        let mut script = script.lock().unwrap();
        script.page = total;
        // Only a message on the older page names this address.
        script
            .addressed
            .insert(("c1".into(), total - 5), "peer-c1@older-machine".into());
    }
    let ids = |messages: &[DirectMessage]| {
        let mut ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
        ids.sort();
        ids
    };
    let page = |range: std::ops::Range<usize>| {
        let mut ids: Vec<String> = range
            .map(|n| match n {
                0 => "msg_c1".to_string(),
                n => format!("msg_c1_{n}"),
            })
            .collect();
        ids.sort();
        ids
    };
    let limit = HISTORY_LIMIT as usize;

    // The latest read walks back for the proof and answers with the newest
    // page as it was read.
    let latest = core.history(&address, None).await.unwrap();
    assert_eq!(ids(&latest.messages), page(0..limit));
    {
        let script = script.lock().unwrap();
        assert_eq!(script.count("/v1/dm/c1/messages"), 2);
    }

    // Paging back from the oldest message shown returns the older page.
    let cursor = format!("msg_c1_{}", limit - 1);
    let older = core.history(&address, Some(&cursor)).await.unwrap();
    assert_eq!(ids(&older.messages), page(limit..total));
    let proof = older
        .messages
        .iter()
        .find(|m| m.sender_address.as_deref() == Some("peer-c1@older-machine"))
        .map(|m| m.id.clone());
    assert_eq!(proof, Some(format!("msg_c1_{}", total - 5)));
}

/// A long conversation whose proof is many pages back is walked once: the
/// next read of the same address trusts it and reads only the page shown,
/// and other agents' conversations listed before it are not walked at all.
#[tokio::test]
async fn a_proof_far_back_is_walked_once() {
    if ran_without_file_roots("a_proof_far_back_is_walked_once") {
        return;
    }
    let address = Endpoint::Address("peer-c3@elsewhere".into());
    let (_home, core, script) = core_with(three()).await;
    let pages = (HISTORY_LIMIT as usize) * 4;
    {
        let mut script = script.lock().unwrap();
        script.page = pages;
        // Only c3's oldest message carries the address.
        for conversation in ["c1", "c2", "c3"] {
            for n in 0..pages - 1 {
                script
                    .addressed
                    .insert((conversation.into(), n), "someone@else".into());
            }
        }
    }
    core.history(&address, None).await.unwrap();
    core.reads_settled().await;
    {
        let script = script.lock().unwrap();
        assert_eq!(script.count("/v1/dm/c1/messages"), 0, "c1 is never walked");
        assert_eq!(script.count("/v1/dm/c2/messages"), 0, "c2 is never walked");
        assert_eq!(
            script.count("/v1/dm/c3/messages"),
            4,
            "c3 is walked to its end"
        );
    }
    let before = script.lock().unwrap().message_reads();
    core.history(&address, None).await.unwrap();
    core.reads_settled().await;
    assert_eq!(
        script.lock().unwrap().message_reads() - before,
        1,
        "the second read is the page shown only"
    );

    // After PROOF_TTL the proof is read again.
    for proven in core.messaging.lock().unwrap().proven.values_mut() {
        proven.at = proven.at.checked_sub(PROOF_TTL).unwrap();
    }
    let before = script.lock().unwrap().message_reads();
    core.history(&address, None).await.unwrap();
    core.reads_settled().await;
    assert_eq!(
        script.lock().unwrap().message_reads() - before,
        4,
        "an expired proof is walked for again"
    );

    // A conversation whose peer is no longer the agent proved is not
    // trusted: here nothing proves the address any more.
    script.lock().unwrap().conversations[2]["participants"][1]["agent_id"] = json!("ag_other");
    core.person_woke();
    assert!(core
        .history(&address, None)
        .await
        .unwrap()
        .messages
        .is_empty());

    // Sign-out or another account forgets every proof.
    core.messaging.lock().unwrap().reset();
    assert!(core.messaging.lock().unwrap().proven.is_empty());
}

#[tokio::test]
async fn an_agent_never_written_to_is_answered_without_reading_a_conversation() {
    if ran_without_file_roots(
        "an_agent_never_written_to_is_answered_without_reading_a_conversation",
    ) {
        return;
    }
    // Many long conversations, none with an agent by the address's name or
    // the id it carries: none is read, however far back it goes.
    let listed: Vec<Value> = (0..40)
        .map(|n| conversation(&format!("c{n}"), &format!("m{n}")))
        .collect();
    let (_home, core, script) = core_with(listed).await;
    script.lock().unwrap().page = 500;
    let never = Endpoint::Address("claude-infra@laptop-250851484399009792".into());
    let history = core.history(&never, None).await.unwrap();
    assert!(history.messages.is_empty());
    assert_eq!(script.lock().unwrap().message_reads(), 0);
}
