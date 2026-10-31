//! Recovery runs while the node's connection is serviced.
use super::*;
use crate::relay::harness::codex;
use crate::relay::spawn::wire::{Configured, Live};
use crate::relay::spawn::{lifecycle, resources};
use futures_util::StreamExt;
use serde_json::json;

/// A host whose recovery lasts until the test lets it go.
struct Recovering {
    release: Mutex<Option<oneshot::Receiver<()>>>,
    delivered: Arc<Mutex<Vec<String>>>,
    changed: Arc<Notify>,
    /// In order: `claim <node> <token>` and `advertise`.
    events: Arc<Mutex<Vec<String>>>,
}

impl NodeHost for Recovering {
    fn invoke(&self, _link: NodeLink, _invoke: Invoke) -> BoxFuture<'static, Value> {
        Box::pin(async { Value::Null })
    }
    fn inventory(&self, _node: &NodeInfo) -> Vec<InventoryAgent> {
        Vec::new()
    }
    fn deliver(&self, agent: &str, _frame: Value) {
        self.delivered.lock().unwrap().push(agent.to_string());
    }
    fn state(&self, _status: SpawnStatus) {}
    fn advertisement(&self, _harnesses: &[HarnessId], repositories: &[String]) -> Advertisement {
        self.events.lock().unwrap().push("advertise".into());
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
    fn claim(&self, node: &NodeInfo, token: &Secret) {
        let event = format!("claim {} {}", node.node_id, token.expose());
        self.events.lock().unwrap().push(event);
    }
    fn changed(&self) -> Arc<Notify> {
        self.changed.clone()
    }
    fn connected(&self, _link: NodeLink) -> BoxFuture<'static, ()> {
        let release = self.release.lock().unwrap().take();
        Box::pin(async move {
            if let Some(release) = release {
                let _ = release.await;
            }
        })
    }
}

async fn next_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("a frame in time")
            .expect("the socket is open")
            .unwrap();
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

#[tokio::test]
async fn heartbeats_go_on_while_recovery_runs_and_the_inventory_follows_it() {
    let folder = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = NodeConfig {
        base_url: format!("http://{}", listener.local_addr().unwrap()),
        workspace_key: Secret::new("rk_live_one".to_string()),
        node_name: "mac-desktop".into(),
        version: "1.0.0".into(),
        app_data_dir: folder.path().to_path_buf(),
        harnesses: vec![codex::ID],
        repositories: Vec::new(),
    };
    // Already enrolled: no HTTP, only the socket.
    let enrollment = Enrollment {
        node_id: "node_desktop_1".into(),
        node_name: config.node_name.clone(),
        token: Secret::new("nt_live_x".to_string()),
        base_url: config.base_url.clone(),
        workspace: fingerprint(&config.workspace_key),
        rotation_key: None,
    };
    save(&node_file(&config), &enrollment).unwrap();
    let (release, released) = oneshot::channel();
    let delivered = Arc::new(Mutex::new(Vec::new()));
    let host = Arc::new(Recovering {
        release: Mutex::new(Some(released)),
        delivered: delivered.clone(),
        changed: Arc::default(),
        events: Arc::default(),
    });
    let node = SpawnNode::start(config, host.clone());
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
    let register = next_frame(&mut socket).await;
    assert_eq!(register["type"], "node.register");
    // The claim is checked before anything is advertised: a node another
    // account owns never offers spawns, even at register.
    let events = host.events.lock().unwrap().clone();
    assert_eq!(events[..2], ["claim node_desktop_1 nt_live_x", "advertise"]);
    socket
        .send(Message::Text(
            json!({"v": 1, "id": register["id"], "type": "reply", "ok": true}).to_string(),
        ))
        .await
        .unwrap();
    // Recovery has not finished: the node still beats, and holds the
    // delivery Relaycast sends meanwhile.
    let beat = next_frame(&mut socket).await;
    assert_eq!(beat["type"], "node.heartbeat");
    socket
        .send(Message::Text(
            json!({"v": 1, "type": "deliver", "agent": "w1"}).to_string(),
        ))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(delivered.lock().unwrap().is_empty());
    release.send(()).unwrap();
    let inventory = next_frame(&mut socket).await;
    assert_eq!(inventory["type"], "inventory.sync");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while delivered.lock().unwrap().is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "the delivery was lost"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(*delivered.lock().unwrap(), ["w1"]);
    node.stop().await;
}
