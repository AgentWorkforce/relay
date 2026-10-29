//! A name another node holds: the node takes an alternate of it, keeps it,
//! and never retries the conflict forever.
use super::enrollment::named_for;
use super::*;
use crate::relay::harness::codex;
use crate::relay::spawn::wire::{Configured, Live};
use crate::relay::spawn::{lifecycle, resources};
use futures_util::StreamExt;
use serde_json::json;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CONFLICT: (&str, &str) = (
    "409 Conflict",
    r#"{"ok":false,"error":{"code":"node_name_conflict","message":"Node name \"mac-desktop\" is already enrolled by another node"}}"#,
);
const ENROLLED: (&str, &str) = (
    "201 Created",
    r#"{"ok":true,"data":{"id":"node_desktop_new","token":"nt_live_new"}}"#,
);

/// A Relaycast that answers each HTTP request in turn from `answers`, then
/// accepts the node's socket on the same port; returns the requests (lower
/// case, with their bodies).
struct Scripted {
    base_url: String,
    listener: tokio::net::TcpListener,
}

impl Scripted {
    async fn new() -> Scripted {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        Scripted { base_url, listener }
    }

    /// Answers one request with `(status, body)`.
    async fn answer(&self, (status, body): (&str, &str)) -> String {
        let (mut stream, _) = self.listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let text = String::from_utf8_lossy(&request).to_lowercase();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
        }
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(reply.as_bytes()).await.unwrap();
        stream.shutdown().await.ok();
        String::from_utf8_lossy(&request).to_lowercase()
    }
}

fn config(base_url: &str, directory: &Path) -> NodeConfig {
    NodeConfig {
        base_url: base_url.into(),
        workspace_key: Secret::new("rk_live_one".to_string()),
        node_name: "mac-desktop".into(),
        version: "1.0.0".into(),
        app_data_dir: directory.to_path_buf(),
        harnesses: vec![codex::ID],
        repositories: Vec::new(),
    }
}

fn enrollment(config: &NodeConfig, id: &str, name: &str, key: &str) -> Enrollment {
    Enrollment {
        node_id: id.into(),
        node_name: name.into(),
        token: Secret::new("nt_live_x".to_string()),
        base_url: config.base_url.clone(),
        workspace: fingerprint(&Secret::new(key.to_string())),
        rotation_key: None,
    }
}

/// The JSON body of a request.
fn body(request: &str) -> Value {
    serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..]).unwrap()
}

fn idempotency_key(request: &str) -> Option<String> {
    request
        .lines()
        .find_map(|line| line.strip_prefix("idempotency-key: "))
        .map(|key| key.trim().to_string())
}

#[test]
fn an_alternate_is_the_name_and_four_hex_digits() {
    let name = alternate("mac-desktop");
    assert!(named_for(&name, "mac-desktop"), "{name}");
    assert!(named_for("mac-desktop", "mac-desktop"));
    assert!(named_for("mac-desktop-3f9a", "mac-desktop"));
    for other in [
        "mac-desktop-3F9A",
        "mac-desktop-3f9",
        "mac-desktop-3f9a1",
        "mac-desktop-zzzz",
        "mac-desktop-extra-3f9a",
        "mac-desktop3f9a",
        "other-desktop",
    ] {
        assert!(!named_for(other, "mac-desktop"), "{other}");
    }
}

#[test]
fn a_saved_alternate_is_this_computers_node() {
    let folder = tempfile::tempdir().unwrap();
    let config = config("https://cast.example", folder.path());
    let saved = enrollment(&config, "node_desktop_1", "mac-desktop-3f9a", "rk_live_one");
    save(&node_file(&config), &saved).unwrap();
    assert_eq!(load(&config), Some(saved));
    assert_eq!(
        enrolled_name(folder.path(), &config.base_url, "mac-desktop"),
        "mac-desktop-3f9a"
    );
    // Not another machine's name, nor another origin's node.
    assert_eq!(
        enrolled_name(folder.path(), &config.base_url, "pc-desktop"),
        "pc-desktop"
    );
    assert_eq!(
        enrolled_name(folder.path(), "https://other.example", "mac-desktop"),
        "mac-desktop"
    );
}

/// (a) another computer of the same name in this workspace, and (b) this
/// computer's own node from an install whose `spawn-node.json` is gone:
/// either way nothing here can prove the node holding the name, so this
/// one takes an alternate, and every restart reuses it.
#[tokio::test]
async fn a_name_another_node_holds_enrolls_an_alternate_kept_across_restarts() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let (enrolled, requests) = tokio::join!(enroll_named(&config, None), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast.answer(ENROLLED).await,
        ]
    });
    let enrolled = enrolled.expect("enrolled under another name");
    assert_eq!(body(&requests[0])["name"], "mac-desktop");
    let alternate = body(&requests[1])["name"].as_str().unwrap().to_string();
    assert!(alternate.starts_with("mac-desktop-"), "{alternate}");
    assert!(named_for(&alternate, "mac-desktop"));
    // A new node: no proof of a node it does not have.
    assert!(!requests[1].contains("x-relaycast-node-token"));
    assert_eq!(enrolled.node_name, alternate);
    assert_eq!(enrolled.node_id, "node_desktop_new");
    // A restart takes the saved node as it is, asking Relaycast nothing.
    assert_eq!(saved(&config).await, Ok(Some(enrolled.clone())));
    assert_eq!(load(&config), Some(enrolled));
}

/// (c) the saved node, enrolled with another key, is not the one holding
/// its name in this workspace: a new node is enrolled, under an alternate.
#[tokio::test]
async fn a_saved_node_whose_name_another_node_holds_is_replaced_by_an_alternate() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let current = config(&relaycast.base_url, folder.path());
    let kept = enrollment(&current, "node_desktop_1", "mac-desktop", "rk_live_old");
    save(&node_file(&current), &kept).unwrap();
    let (found, asked) = tokio::join!(
        saved(&current),
        relaycast.answer((
            "200 OK",
            r#"{"ok":true,"data":{"id":"node_desktop_2","name":"mac-desktop"}}"#,
        ))
    );
    assert!(asked.starts_with("get /v1/nodes/mac-desktop "), "{asked}");
    assert_eq!(found, Ok(None));
    let (enrolled, requests) = tokio::join!(enroll_named(&current, None), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast.answer(ENROLLED).await,
        ]
    });
    let enrolled = enrolled.unwrap();
    assert!(named_for(&enrolled.node_name, "mac-desktop"));
    assert_ne!(enrolled.node_name, "mac-desktop");
    assert_eq!(body(&requests[1])["name"], enrolled.node_name.as_str());
    assert_eq!(load(&current), Some(enrolled));
}

/// #671: a new key for the same workspace keeps the node Relaycast lists
/// under its name, the alternate one included, before anything is enrolled.
#[tokio::test]
async fn a_new_key_keeps_the_node_under_its_alternate_name() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let current = config(&relaycast.base_url, folder.path());
    let kept = enrollment(
        &current,
        "node_desktop_1",
        "mac-desktop-3f9a",
        "rk_live_old",
    );
    save(&node_file(&current), &kept).unwrap();
    let (found, asked) = tokio::join!(
        saved(&current),
        relaycast.answer((
            "200 OK",
            r#"{"ok":true,"data":{"id":"node_desktop_1","name":"mac-desktop-3f9a"}}"#,
        ))
    );
    assert!(
        asked.starts_with("get /v1/nodes/mac-desktop-3f9a "),
        "{asked}"
    );
    let adopted = found.unwrap().expect("adopted");
    assert_eq!(adopted.node_id, "node_desktop_1");
    assert_eq!(adopted.node_name, "mac-desktop-3f9a");
    assert_eq!(adopted.token, kept.token);
    assert_eq!(load(&current), Some(adopted));
}

/// A rotation whose node Relaycast no longer has under its name, now
/// another node's: renamed under its own id, so its agents stay bound to it.
#[tokio::test]
async fn a_rotation_whose_name_another_node_took_renames_the_same_node() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_one");
    save(&node_file(&config), &current).unwrap();
    let (rotated, requests) = tokio::join!(rotate(&config, &current), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast
                .answer((
                    "201 Created",
                    r#"{"ok":true,"data":{"id":"node_desktop_1","token":"nt_live_y"}}"#,
                ))
                .await,
        ]
    });
    let rotated = rotated.unwrap();
    assert_eq!(rotated.node_id, "node_desktop_1");
    assert!(named_for(&rotated.node_name, "mac-desktop"));
    assert_ne!(rotated.node_name, "mac-desktop");
    for request in &requests {
        assert_eq!(body(request)["node_id"], "node_desktop_1");
        assert!(request.contains("x-relaycast-node-token: nt_live_x"));
    }
    assert_eq!(body(&requests[1])["name"], rotated.node_name.as_str());
    // Another body under another key: not a replay of the refused one.
    let keys: Vec<_> = requests.iter().map(|r| idempotency_key(r)).collect();
    assert!(keys.iter().all(Option::is_some));
    assert_ne!(keys[0], keys[1]);
    assert_eq!(load(&config), Some(rotated));
}

/// A rename whose answer was lost is replayed as it was sent: the same
/// name under the same key, so Relaycast recognizes it.
#[tokio::test]
async fn a_rename_whose_answer_was_lost_is_replayed_with_its_name_and_key() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_one");
    save(&node_file(&config), &current).unwrap();
    let (first, requests) = tokio::join!(rotate(&config, &current), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast
                .answer((
                    "400 Bad Request",
                    r#"{"ok":false,"error":{"code":"invalid_request","message":"lost"}}"#,
                ))
                .await,
        ]
    });
    assert!(first.is_err());
    let pending = read(&config).expect("the node is kept");
    assert_eq!(pending.node_id, "node_desktop_1");
    assert_eq!(body(&requests[1])["name"], pending.node_name.as_str());
    let (second, replayed) = tokio::join!(
        rotate(&config, &pending),
        relaycast.answer((
            "201 Created",
            r#"{"ok":true,"data":{"id":"node_desktop_1","token":"nt_live_y"}}"#,
        ))
    );
    assert_eq!(body(&replayed)["name"], body(&requests[1])["name"]);
    assert_eq!(idempotency_key(&replayed), idempotency_key(&requests[1]));
    assert_eq!(second.unwrap().node_name, pending.node_name);
}

/// A recording host: each status, and each claim's node.
#[derive(Default)]
struct Recording {
    states: Mutex<Vec<SpawnStatus>>,
    claims: Mutex<Vec<String>>,
    changed: Arc<Notify>,
}

impl NodeHost for Recording {
    fn invoke(&self, _link: NodeLink, _invoke: Invoke) -> BoxFuture<'static, Value> {
        Box::pin(async { Value::Null })
    }
    fn inventory(&self, _node: &NodeInfo) -> Vec<InventoryAgent> {
        Vec::new()
    }
    fn deliver(&self, _agent: &str, _frame: Value) {}
    fn state(&self, status: SpawnStatus) {
        self.states.lock().unwrap().push(status);
    }
    fn advertisement(&self, _harnesses: &[HarnessId], repositories: &[String]) -> Advertisement {
        Advertisement {
            configured: Configured {
                max_agents: lifecycle::DEFAULT_MAX_AGENTS,
                machine: "mac".into(),
                teammates: false,
                repositories: repositories.to_vec(),
                harnesses: Vec::new(),
            },
            live: Live {
                observed_at: lifecycle::iso(chrono::Utc::now()),
                slots: Default::default(),
                work: Default::default(),
                resources: resources::Resources::default(),
                agents: Vec::new(),
                reclaimed: Vec::new(),
                quota: Vec::new(),
            },
        }
    }
    fn heartbeat_sent(&self) {}
    fn claim(&self, node: &NodeInfo, _token: &Secret) {
        self.claims.lock().unwrap().push(node.node_name.clone());
    }
    fn changed(&self) -> Arc<Notify> {
        self.changed.clone()
    }
}

async fn until(host: &Recording, done: impl Fn(&[SpawnStatus]) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !done(&host.states.lock().unwrap()) {
        assert!(std::time::Instant::now() < deadline, "no such status");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn the_node_registers_claims_and_reports_under_the_name_it_enrolled_with() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let host = Arc::new(Recording::default());
    let node = SpawnNode::start(config.clone(), host.clone());
    relaycast.answer(CONFLICT).await;
    let alternate = body(&relaycast.answer(ENROLLED).await)["name"]
        .as_str()
        .unwrap()
        .to_string();
    let (stream, _) = relaycast.listener.accept().await.unwrap();
    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
    let register = loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Message::Text(text) = message {
            break serde_json::from_str::<Value>(&text).unwrap();
        }
    };
    assert_eq!(register["type"], "node.register");
    assert_eq!(register["name"], alternate.as_str());
    assert_eq!(register["node_id"], "node_desktop_new");
    assert_eq!(*host.claims.lock().unwrap(), [alternate.clone()]);
    socket
        .send(Message::Text(
            json!({"v": 1, "id": register["id"], "type": "reply", "ok": true}).to_string(),
        ))
        .await
        .unwrap();
    until(&host, |states| {
        states.iter().any(|s| s.state == SpawnState::Live)
    })
    .await;
    let live = host
        .states
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.state == SpawnState::Live)
        .cloned()
        .unwrap();
    assert_eq!(live.node_name.as_deref(), Some(alternate.as_str()));
    // The configuration still names the machine's own name: the node is
    // not restarted for having another.
    assert_eq!(node.config(), &config);
    node.stop().await;
}

#[tokio::test]
async fn a_name_no_alternate_frees_stops_the_node_and_says_so() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let host = Arc::new(Recording::default());
    let node = SpawnNode::start(config, host.clone());
    for _ in 0..=ALTERNATES {
        relaycast.answer(CONFLICT).await;
    }
    until(&host, |states| {
        states.iter().any(|s| s.state == SpawnState::Off)
    })
    .await;
    // Given up: no further enrollment is tried.
    assert!(
        tokio::time::timeout(Duration::from_millis(300), relaycast.listener.accept())
            .await
            .is_err()
    );
    let states = host.states.lock().unwrap().clone();
    let off = states.last().unwrap();
    assert_eq!(off.state, SpawnState::Off);
    let error = off.error.as_deref().unwrap();
    assert!(
        error.contains("other nodes in this workspace already use \"mac-desktop\""),
        "{error}"
    );
    assert!(error.contains("Turn Accept spawns from Agent Relay off and on"));
    assert!(!states.iter().any(|s| s.state == SpawnState::Waiting));
    assert!(!node_file(&host_config(folder.path())).exists());
    node.stop().await;
}

fn host_config(directory: &Path) -> NodeConfig {
    config("http://unused", directory)
}
