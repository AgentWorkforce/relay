use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};

const NOW: i64 = 1_790_000_000_000;
const THREAD: &str = "12345678-1234-1234-1234-123456789012";

/// `(method, url, bearer, body, idempotency key)`.
type Request = (String, String, String, Option<Vec<u8>>, Option<String>);

type Handler =
    Box<dyn Fn(&str, &str, Option<&[u8]>) -> Result<Vec<u8>, MailboxError> + Send + Sync>;

/// Records requests and answers them from a handler; sockets are queued.
struct FakeNetwork {
    requests: Mutex<Vec<Request>>,
    handler: Mutex<Handler>,
    sockets: Mutex<VecDeque<Result<FakeSocket, MailboxError>>>,
    connects: Mutex<Vec<String>>,
}

impl FakeNetwork {
    fn new(
        handler: impl Fn(&str, &str, Option<&[u8]>) -> Result<Vec<u8>, MailboxError>
            + Send
            + Sync
            + 'static,
    ) -> Arc<FakeNetwork> {
        Arc::new(FakeNetwork {
            requests: Mutex::default(),
            handler: Mutex::new(Box::new(handler)),
            sockets: Mutex::default(),
            connects: Mutex::default(),
        })
    }

    fn answer(
        &self,
        handler: impl Fn(&str, &str, Option<&[u8]>) -> Result<Vec<u8>, MailboxError>
            + Send
            + Sync
            + 'static,
    ) {
        *self.handler.lock().unwrap() = Box::new(handler);
    }

    fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

impl MailboxNetwork for FakeNetwork {
    fn request(
        &self,
        method: &'static str,
        url: String,
        bearer: Secret,
        body: Option<Vec<u8>>,
        key: Option<String>,
    ) -> BoxFuture<'_, Result<Vec<u8>, MailboxError>> {
        self.requests.lock().unwrap().push((
            method.into(),
            url.clone(),
            bearer.expose().into(),
            body.clone(),
            key,
        ));
        let answer = (self.handler.lock().unwrap())(method, &url, body.as_deref());
        Box::pin(async move { answer })
    }

    fn connect(
        &self,
        url: String,
        bearer: Secret,
    ) -> BoxFuture<'_, Result<Box<dyn MailboxSocket>, MailboxError>> {
        assert_eq!(bearer.expose(), "desktop-session");
        self.connects.lock().unwrap().push(url);
        let next = self.sockets.lock().unwrap().pop_front();
        Box::pin(async move {
            match next {
                Some(Ok(socket)) => Ok(Box::new(socket) as Box<dyn MailboxSocket>),
                Some(Err(error)) => Err(error),
                None => std::future::pending().await,
            }
        })
    }
}

struct FakeSocket {
    frames: VecDeque<Vec<u8>>,
    closed: Arc<AtomicU32>,
}

impl MailboxSocket for FakeSocket {
    fn receive(&mut self) -> BoxFuture<'_, Result<Vec<u8>, MailboxError>> {
        let next = self.frames.pop_front();
        Box::pin(async move { next.ok_or(MailboxError::Unreachable) })
    }

    fn close(&mut self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
    }
}

/// An outbox in memory: messages, a cursor, and an ack journal.
#[derive(Default)]
struct FakeStore {
    cursor: Mutex<Option<String>>,
    acks: Mutex<Vec<(i64, Value)>>,
}

impl MailboxStore for FakeStore {
    fn cursor(&self) -> Result<Option<String>, String> {
        Ok(self.cursor.lock().unwrap().clone())
    }
    fn reset_cursor_if_matching(&self, since: &str) -> Result<(), String> {
        let mut cursor = self.cursor.lock().unwrap();
        if cursor.as_deref() == Some(since) {
            *cursor = None;
        }
        Ok(())
    }
    fn checkpoint(&self, id: &str) -> Result<(), String> {
        *self.cursor.lock().unwrap() = Some(id.into());
        Ok(())
    }
    fn pending_acks(&self) -> Result<Vec<(i64, Value)>, String> {
        Ok(self
            .acks
            .lock()
            .unwrap()
            .iter()
            .take(100)
            .cloned()
            .collect())
    }
    fn acknowledge_through(&self, sequence: i64) -> Result<(), String> {
        self.acks.lock().unwrap().retain(|(s, _)| *s > sequence);
        Ok(())
    }
}

#[derive(Default)]
struct FakeInbox {
    received: Mutex<Vec<String>>,
    refuse: Mutex<Option<MailboxError>>,
}

impl MailboxInbox for FakeInbox {
    fn receive_durably(&self, message: &Value) -> Result<(), MailboxError> {
        if let Some(error) = self.refuse.lock().unwrap().clone() {
            return Err(error);
        }
        self.received
            .lock()
            .unwrap()
            .push(message["id"].as_str().unwrap().into());
        Ok(())
    }
}

fn config() -> MailboxConfig {
    MailboxConfig::new("https://example.test", "a", "w").unwrap()
}

fn token() -> MailboxCredential {
    MailboxCredential {
        scope: config().scope(),
        token: Secret::new("desktop-session"),
        expires_at_ms: 4_102_444_800_000,
    }
}

fn message(id: &str) -> Value {
    json!({"id": id, "thread_id": THREAD, "text": "check retries",
           "sender": {"id": "alice", "display_name": "Alice"}, "created_at": "2026-09-30T10:00:00Z"})
}

struct Fixture {
    network: Arc<FakeNetwork>,
    store: Arc<FakeStore>,
    inbox: Arc<FakeInbox>,
    auth: Arc<Mutex<Vec<bool>>>,
}

impl Fixture {
    fn new() -> Fixture {
        Fixture {
            network: FakeNetwork::new(|_, _, _| Ok(b"[]".to_vec())),
            store: Arc::default(),
            inbox: Arc::default(),
            auth: Arc::default(),
        }
    }

    fn receiver(&self, catalog: Vec<ThreadReport>) -> Arc<Receiver> {
        self.receiver_with(Arc::new(|| Ok(token())), catalog)
    }

    fn receiver_with(
        &self,
        credential: Arc<dyn Fn() -> Result<MailboxCredential, MailboxError> + Send + Sync>,
        catalog: Vec<ThreadReport>,
    ) -> Arc<Receiver> {
        let auth = self.auth.clone();
        Receiver::new(ReceiverParts {
            config: config(),
            network: self.network.clone(),
            store: self.store.clone(),
            inbox: self.inbox.clone(),
            credential,
            catalog: Arc::new(move || {
                let rows = catalog.clone();
                Box::pin(async move { rows })
            }),
            authenticated: Arc::new(move |ok| auth.lock().unwrap().push(ok)),
            pause: Arc::new(|_| Box::pin(tokio::time::sleep(Duration::from_millis(10)))),
            jitter: || 1.0,
        })
    }
}

fn query(url: &str, name: &str) -> Option<String> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

#[test]
fn the_scope_matches_the_macos_app_s_encoding() {
    // sha256 of `["https:\/\/example.test","a","w"]`.
    let expected = format!(
        "{:x}",
        Sha256::digest(br#"["https:\/\/example.test","a","w"]"#)
    );
    assert_eq!(config().scope(), expected);
}

#[test]
fn credentials_round_trip_in_the_macos_format() {
    let credential = MailboxCredential {
        scope: "s".into(),
        token: Secret::new("at_live_x"),
        expires_at_ms: 1_790_000_000_000,
    };
    let encoded: Value = serde_json::from_slice(&credential.encode()).unwrap();
    assert_eq!(encoded["expiresAt"], json!(811_692_800.0));
    assert_eq!(
        MailboxCredential::decode(&credential.encode()).unwrap(),
        credential
    );
}

#[test]
fn scope_expiry_probe_tokens_and_unsafe_origins_fail_closed() {
    assert!(MailboxConfig::new("http://example.test", "a", "w").is_err());
    assert!(MailboxConfig::new("http://10.0.0.1:8080", "a", "w").is_err());
    // A local Cloud, as every Cloud origin the core accepts: loopback only,
    // and its socket is `ws`.
    let local = MailboxConfig::new("http://127.0.0.1:8080", "a", "w").unwrap();
    assert!(local
        .url(MESSAGES_PATH, None, true)
        .unwrap()
        .starts_with("ws://127.0.0.1:8080/"));
    assert!(MailboxConfig::new("http://localhost", "a", "w").is_ok());
    assert!(MailboxConfig::new("https://user@example.test", "a", "w").is_err());
    assert!(MailboxConfig::new("https://example.test/path", "a", "w").is_err());
    assert!(MailboxConfig::new("https://example.test", "", "w").is_err());
    let mut bad_path = config();
    bad_path.messages_path = "//evil.example/x".into();
    assert!(bad_path.validated().is_err());
    let config = config();
    for credential in [
        MailboxCredential {
            scope: "other".into(),
            ..token()
        },
        MailboxCredential {
            token: Secret::new("rth_probe"),
            ..token()
        },
        MailboxCredential {
            token: Secret::new("token\r\nInjected: yes"),
            ..token()
        },
        MailboxCredential {
            expires_at_ms: NOW - 1,
            ..token()
        },
    ] {
        assert_eq!(
            config.bearer(&credential, NOW),
            Err(MailboxError::AuthenticationRequired)
        );
    }
    let url = config.url(MESSAGES_PATH, Some("a&other=x"), true).unwrap();
    assert!(url.starts_with("wss://example.test/cloud/api/v1/desktop/messages?"));
    assert_eq!(query(&url, "since").as_deref(), Some("a&other=x"));
    assert_eq!(query(&url, "account_id").as_deref(), Some("a"));
}

#[test]
fn only_explicit_409_cursor_not_found_enables_recovery() {
    assert_eq!(classify(200, b"[]"), Ok(()));
    for status in [302, 404, 500] {
        assert_eq!(classify(status, b""), Err(MailboxError::InvalidResponse));
    }
    for status in [401, 403] {
        assert_eq!(
            classify(status, b""),
            Err(MailboxError::AuthenticationRequired)
        );
    }
    assert_eq!(
        classify(
            409,
            br#"{"ok":false,"error":{"code":"cursor_not_found","message":"retired"}}"#
        ),
        Err(MailboxError::CursorNotFound)
    );
    assert_eq!(
        classify(409, br#"{"error":{"code":"scope_mismatch"}}"#),
        Err(MailboxError::InvalidResponse)
    );
    assert_eq!(
        classify(500, br#"{"error":{"code":"cursor_not_found"}}"#),
        Err(MailboxError::InvalidResponse)
    );
    assert_eq!(
        classify(409, b"not JSON"),
        Err(MailboxError::InvalidResponse)
    );
}

#[test]
fn backoff_is_jittered_exponential_and_capped() {
    let seconds: Vec<f64> = (1..=7).map(|n| backoff(n, 1.0).as_secs_f64()).collect();
    assert_eq!(seconds, [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0]);
    assert_eq!(backoff(20, 0.0).as_secs_f64(), 15.0);
}

fn room(body: &str) -> Vec<u8> {
    body.as_bytes().to_vec()
}

fn session(site: &str, expiry: &str) -> Vec<u8> {
    json!({"site": site, "account_id": "membership", "workspace_id": "workspace", "expires_at": expiry,
           "messages_path": MESSAGES_PATH, "acks_path": ACKS_PATH, "threads_path": THREADS_PATH})
    .to_string()
    .into_bytes()
}

const ROOM: &str = r#"{"role":"participant","relaycastBaseUrl":"https://mailbox.example","agentToken":"at_live_device"}"#;

#[tokio::test]
async fn activation_uses_separate_credentials_and_the_server_s_mailbox_identity() {
    let network = FakeNetwork::new(|_, url, _| {
        Ok(if url.contains("control.example") {
            room(ROOM)
        } else {
            session("https://mailbox.example", "2099-01-01T00:00:00Z")
        })
    });
    let activated = activate(
        network.as_ref(),
        "https://control.example",
        "workspace",
        &Secret::new("login-secret"),
        "device-1",
        NOW,
    )
    .await
    .unwrap();
    let requests = network.requests();
    assert_eq!(requests.len(), 2);
    let (method, url, bearer, body, _) = &requests[0];
    assert_eq!(method, "POST");
    assert_eq!(
        url,
        "https://control.example/cloud/api/v1/workspaces/workspace/room/session"
    );
    assert_eq!(bearer, "login-secret");
    assert_eq!(
        serde_json::from_slice::<Value>(body.as_ref().unwrap()).unwrap(),
        json!({"deviceId": "device-1"})
    );
    assert_eq!(
        requests[1].1,
        "https://mailbox.example/cloud/api/v1/desktop/session"
    );
    assert_eq!(requests[1].2, "at_live_device");
    assert_eq!(activated.config.account_id, "membership");
    assert_eq!(activated.config.site, "https://mailbox.example");
    assert_eq!(activated.credential.scope, activated.config.scope());
    assert_eq!(activated.credential.token.expose(), "at_live_device");
}

#[tokio::test]
async fn an_armadillo_agent_token_activates_only_with_relay_cli() {
    let network = FakeNetwork::new(|_, _, _| {
        Ok(room(
            r#"{"role":"participant","relaycastBaseUrl":"https://mailbox.example","agentToken":"ar_ag_device"}"#,
        ))
    });
    let result = activate(
        network.as_ref(),
        "https://control.example",
        "workspace",
        &Secret::new("login"),
        "device",
        NOW,
    )
    .await;
    if cfg!(feature = "relay-cli") {
        assert!(!matches!(result, Err(MailboxError::AuthenticationRequired)));
    } else {
        assert!(matches!(result, Err(MailboxError::AuthenticationRequired)));
        assert_eq!(network.requests().len(), 1);
    }
}

#[tokio::test]
async fn activation_refuses_origin_changes_expiry_and_non_participant_tokens() {
    for answer in [
        session("https://other.example", "2099-01-01T00:00:00Z"),
        session("https://mailbox.example", "2000-01-01T00:00:00Z"),
    ] {
        let network = FakeNetwork::new(move |_, url, _| {
            Ok(if url.contains("control.example") {
                room(ROOM)
            } else {
                answer.clone()
            })
        });
        let result = activate(
            network.as_ref(),
            "https://control.example",
            "workspace",
            &Secret::new("login"),
            "device",
            NOW,
        )
        .await;
        assert!(matches!(result, Err(MailboxError::InvalidResponse)));
    }
    for body in [
        r#"{"role":"observer","relaycastBaseUrl":"https://mailbox.example","agentToken":"at_live_device"}"#,
        r#"{"role":"participant","relaycastBaseUrl":"https://mailbox.example","agentToken":"rth_probe"}"#,
        r#"{"role":"participant","relaycastBaseUrl":"http://mailbox.example","agentToken":"at_live_device"}"#,
        r#"{"role":"participant","relaycastBaseUrl":"https://mailbox.example","agentToken":"at_live_device","observerToken":"ot_live_x"}"#,
    ] {
        let network = FakeNetwork::new(move |_, _, _| Ok(room(body)));
        let result = activate(
            network.as_ref(),
            "https://control.example",
            "workspace",
            &Secret::new("login"),
            "device",
            NOW,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(network.requests().len(), 1);
    }
    let network = FakeNetwork::new(|_, _, _| Ok(room(ROOM)));
    assert!(activate(
        network.as_ref(),
        "https://control.example",
        "../x",
        &Secret::new("login"),
        "device",
        NOW
    )
    .await
    .is_err());
    assert!(network.requests().is_empty());
}

#[tokio::test]
async fn a_refused_inbox_neither_checkpoints_nor_acknowledges() {
    let fixture = Fixture::new();
    *fixture.inbox.refuse.lock().unwrap() = Some(MailboxError::AuthenticationRequired);
    fixture
        .network
        .answer(|_, _, _| Ok(serde_json::to_vec(&json!([message("late-auth")])).unwrap()));
    let receiver = fixture.receiver(vec![]);
    assert_eq!(
        receiver.poll().await,
        Err(MailboxError::AuthenticationRequired)
    );
    assert_eq!(fixture.store.cursor().unwrap(), None);
    *fixture.inbox.refuse.lock().unwrap() = None;
    receiver.poll().await.unwrap();
    assert_eq!(
        fixture.store.cursor().unwrap().as_deref(),
        Some("late-auth")
    );
    assert_eq!(*fixture.inbox.received.lock().unwrap(), ["late-auth"]);

    *fixture.inbox.refuse.lock().unwrap() = Some(MailboxError::Storage("disk full".into()));
    fixture
        .network
        .answer(|_, _, _| Ok(serde_json::to_vec(&json!([message("two")])).unwrap()));
    assert!(matches!(
        receiver.poll().await,
        Err(MailboxError::Storage(_))
    ));
    assert_eq!(
        fixture.store.cursor().unwrap().as_deref(),
        Some("late-auth")
    );
}

#[tokio::test]
async fn a_retired_cursor_replays_once_and_a_second_refusal_is_an_error() {
    let fixture = Fixture::new();
    fixture.store.checkpoint("retained").unwrap();
    let calls = Arc::new(AtomicU32::new(0));
    let seen = calls.clone();
    fixture.network.answer(move |_, url, _| {
        let call = seen.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            assert_eq!(query(url, "since").as_deref(), Some("retained"));
            return Err(MailboxError::CursorNotFound);
        }
        assert_eq!(query(url, "since"), None);
        Ok(serde_json::to_vec(&json!([message("retained"), message("new")])).unwrap())
    });
    let receiver = fixture.receiver(vec![]);
    receiver.poll().await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(*fixture.inbox.received.lock().unwrap(), ["retained", "new"]);
    assert_eq!(fixture.store.cursor().unwrap().as_deref(), Some("new"));

    fixture.store.checkpoint("old").unwrap();
    let calls = Arc::new(AtomicU32::new(0));
    let seen = calls.clone();
    fixture.network.answer(move |_, _, _| {
        seen.fetch_add(1, Ordering::SeqCst);
        Err(MailboxError::CursorNotFound)
    });
    assert_eq!(receiver.poll().await, Err(MailboxError::CursorNotFound));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.store.cursor().unwrap(), None);
}

#[tokio::test]
async fn a_malformed_envelope_stops_the_stream_without_skipping_it() {
    let fixture = Fixture::new();
    let mut bad = message("bad");
    bad["sender"]["id"] = json!("");
    let frames = json!([message("one"), bad, message("three")]);
    fixture
        .network
        .answer(move |_, _, _| Ok(serde_json::to_vec(&frames).unwrap()));
    assert_eq!(
        fixture.receiver(vec![]).poll().await,
        Err(MailboxError::InvalidResponse)
    );
    assert_eq!(*fixture.inbox.received.lock().unwrap(), ["one"]);
    assert_eq!(fixture.store.cursor().unwrap().as_deref(), Some("one"));
}

#[tokio::test]
async fn reconnect_polls_in_between_and_resumes_from_the_durable_cursor() {
    let fixture = Fixture::new();
    let closed = Arc::new(AtomicU32::new(0));
    fixture
        .network
        .sockets
        .lock()
        .unwrap()
        .push_back(Ok(FakeSocket {
            frames: VecDeque::from([serde_json::to_vec(&message("first")).unwrap()]),
            closed: closed.clone(),
        }));
    fixture.network.answer(|method, _, _| {
        Ok(if method == "GET" {
            serde_json::to_vec(&json!([message("first"), message("second")])).unwrap()
        } else {
            Vec::new()
        })
    });
    let receiver = fixture.receiver(vec![]);
    let task = receiver.start();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while fixture.network.connects.lock().unwrap().len() < 2 {
        assert!(tokio::time::Instant::now() < deadline, "reconnected");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    task.abort();
    let connects = fixture.network.connects.lock().unwrap().clone();
    assert!(connects[0].starts_with("wss://example.test/"));
    assert_eq!(query(&connects[1], "since").as_deref(), Some("second"));
    assert_eq!(closed.load(Ordering::SeqCst), 1);
    assert_eq!(
        *fixture.inbox.received.lock().unwrap(),
        ["first", "first", "second"]
    );
    assert!(fixture.auth.lock().unwrap().contains(&true));
}

#[tokio::test]
async fn a_lost_ack_answer_resends_the_same_batch_under_the_same_key() {
    let fixture = Fixture::new();
    fixture
        .store
        .acks
        .lock()
        .unwrap()
        .push((1, json!({"id": "one", "status": "queued"})));
    fixture
        .network
        .answer(|_, _, _| Err(MailboxError::Unreachable));
    let receiver = fixture.receiver(vec![]);
    let _ = receiver.flush_acks().await;
    let _ = receiver.flush_acks().await;
    let posts = fixture.network.requests();
    assert_eq!(posts[0].3, posts[1].3);
    assert_eq!(posts[0].4, posts[1].4);
    assert!(posts[0]
        .4
        .as_ref()
        .unwrap()
        .starts_with(&format!("{}-", config().scope())));
    assert!(posts[0]
        .1
        .starts_with("https://example.test/cloud/api/v1/desktop/acks?"));
    assert_eq!(fixture.store.acks.lock().unwrap().len(), 1);
    fixture.network.answer(|_, _, _| Ok(Vec::new()));
    receiver.flush_acks().await.unwrap();
    assert!(fixture.store.acks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ack_batches_are_bounded() {
    let fixture = Fixture::new();
    for i in 0..205 {
        fixture
            .store
            .acks
            .lock()
            .unwrap()
            .push((i, json!({"id": format!("m{i}"), "status": "rejected"})));
    }
    let receiver = fixture.receiver(vec![]);
    for _ in 0..3 {
        receiver.flush_acks().await.unwrap();
    }
    let sizes: Vec<usize> = fixture
        .network
        .requests()
        .iter()
        .map(|r| {
            serde_json::from_slice::<Vec<Value>>(r.3.as_ref().unwrap())
                .unwrap()
                .len()
        })
        .collect();
    assert_eq!(sizes, [100, 100, 5]);
}

#[tokio::test]
async fn the_catalog_reports_only_explicitly_shared_thread_ids() {
    let fixture = Fixture::new();
    let shared = ThreadReport {
        id: THREAD.into(),
        mode: Some("hold".into()),
        open: true,
        project: "project".into(),
        shared: true,
        title: "title".into(),
    };
    let private = ThreadReport {
        id: "87654321-4321-4321-4321-210987654321".into(),
        mode: None,
        shared: false,
        title: "secret".into(),
        ..shared.clone()
    };
    let invalid = ThreadReport {
        id: "session name".into(),
        ..shared.clone()
    };
    fixture
        .receiver(vec![shared.clone(), private, invalid])
        .report_catalog()
        .await
        .unwrap();
    let request = &fixture.network.requests()[0];
    let body = String::from_utf8(request.3.clone().unwrap()).unwrap();
    assert!(!body.contains("secret"));
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!([{"id": THREAD, "mode": "hold", "open": true, "project": "project", "shared": true, "title": "title"}])
    );
    assert!(request.1.contains("/cloud/api/v1/desktop/threads?"));
}

#[tokio::test]
async fn a_missing_credential_never_reaches_the_network() {
    let fixture = Fixture::new();
    fixture
        .network
        .answer(|_, _, _| panic!("unauthenticated request"));
    let receiver = fixture.receiver_with(
        Arc::new(|| Err(MailboxError::AuthenticationRequired)),
        vec![],
    );
    let task = receiver.start();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !fixture.auth.lock().unwrap().contains(&false) {
        assert!(tokio::time::Instant::now() < deadline, "refused");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    task.abort();
    assert!(fixture.network.connects.lock().unwrap().is_empty());
    assert!(fixture.network.requests().is_empty());
    assert_eq!(receiver.state(), ReceiverState::NeedsSignIn);
}

#[tokio::test]
async fn deactivation_ends_the_device_session_at_the_mailbox() {
    let network = FakeNetwork::new(|_, _, _| Ok(Vec::new()));
    Receiver::deactivate(network.as_ref(), &config(), &token()).await;
    let request = &network.requests()[0];
    assert_eq!(request.0, "DELETE");
    assert!(request
        .1
        .starts_with("https://example.test/cloud/api/v1/desktop/session?"));
    let expired = MailboxCredential {
        expires_at_ms: 0,
        ..token()
    };
    Receiver::deactivate(network.as_ref(), &config(), &expired).await;
    assert_eq!(network.requests().len(), 1);
}

#[test]
fn credential_files_are_private_and_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let files = CredentialFiles {
        root: dir.path().join("incoming"),
    };
    assert!(files.load(&token().scope).is_none());
    files.save(&token()).unwrap();
    assert_eq!(files.load(&token().scope).unwrap(), token());
    let path = dir
        .path()
        .join("incoming")
        .join(token().scope)
        .join("credential.json");
    assert!(path.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(files.load("other").is_none());
    files.remove(&token().scope);
    assert!(files.load(&token().scope).is_none());
}
