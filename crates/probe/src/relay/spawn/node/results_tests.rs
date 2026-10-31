//! The node against a fake Relaycast socket: a result Relaycast refuses, or
//! never answers because the socket ended or the node restarted, is sent
//! again until it is taken.
use super::control_retry::Timing;
use super::*;
use crate::relay::harness::codex;
use crate::relay::spawn::wire::{Configured, Live};
use crate::relay::spawn::{lifecycle, resources};
use futures_util::StreamExt;
use serde_json::json;
use std::path::Path;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;

/// A host whose every invocation is a release answered at once. As the
/// core does, it lists the agent until the release's result is sent, and
/// tells the node its places changed while it answers.
#[derive(Default)]
struct Host {
    changed: Arc<Notify>,
    refusals: Mutex<Vec<String>>,
    releasing: Arc<Mutex<Option<String>>>,
}

impl NodeHost for Host {
    fn invoke(&self, _link: NodeLink, invoke: Invoke) -> BoxFuture<'static, Value> {
        let Invoke::Release(release) = invoke else {
            panic!("only releases here");
        };
        let result = wire::action_output(&release.invocation_id, wire::released(&release.name));
        *self.releasing.lock().unwrap() = Some(release.invocation_id);
        let changed = self.changed.clone();
        Box::pin(async move {
            // The place is given back before the answer exists.
            changed.notify_one();
            tokio::time::sleep(Duration::from_millis(50)).await;
            result
        })
    }
    fn inventory(&self, _node: &NodeInfo) -> Vec<InventoryAgent> {
        let releasing = self.releasing.lock().unwrap().clone();
        releasing
            .map(|_| InventoryAgent {
                agent_id: "agent_w1".into(),
                name: "w1".into(),
                invocation_id: "inv_spawn_w1".into(),
                session_ref: "session_w1".into(),
            })
            .into_iter()
            .collect()
    }
    fn deliver(&self, _agent: &str, _frame: Value) {}
    fn state(&self, _status: SpawnStatus) {}
    fn advertisement(&self, _harnesses: &[HarnessId], repositories: &[String]) -> Advertisement {
        Advertisement {
            configured: Configured {
                max_agents: lifecycle::DEFAULT_MAX_AGENTS,
                machine: "Test-Desk".into(),
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
    fn changed(&self) -> Arc<Notify> {
        self.changed.clone()
    }
    fn refused(&self, message: String) {
        self.refusals.lock().unwrap().push(message);
    }
    fn sent(&self, frame: &Value) {
        let mut releasing = self.releasing.lock().unwrap();
        if releasing.as_deref() == frame["invocation_id"].as_str() {
            *releasing = None;
            self.changed.notify_one();
        }
    }
}

type Socket = WebSocketStream<TcpStream>;

/// A node already enrolled against `listener`, with short result timing.
fn config(folder: &Path, listener: &TcpListener) -> NodeConfig {
    let config = NodeConfig {
        base_url: format!("http://{}", listener.local_addr().unwrap()),
        workspace_key: Secret::new("rk_live_one".to_string()),
        node_name: "mac-desktop".into(),
        version: "1.0.0".into(),
        app_data_dir: folder.to_path_buf(),
        harnesses: vec![codex::ID],
        repositories: Vec::new(),
    };
    let enrollment = Enrollment {
        node_id: "node_desktop_1".into(),
        node_name: config.node_name.clone(),
        token: Secret::new("nt_live_x".to_string()),
        base_url: config.base_url.clone(),
        workspace: fingerprint(&config.workspace_key),
        rotation_key: None,
    };
    save(&node_file(&config), &enrollment).unwrap();
    config
}

fn results() -> Arc<Mutex<Results>> {
    Arc::new(Mutex::new(Results::new(Timing {
        window: Duration::from_millis(400),
        unit: Duration::from_millis(5),
    })))
}

fn owed(results: &Mutex<Results>) -> Vec<String> {
    results.lock().unwrap().owed()
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("a frame in time")
            .expect("an open socket")
            .unwrap();
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).unwrap();
        }
    }
}

async fn send(socket: &mut Socket, frame: Value) {
    socket.send(Message::Text(frame.to_string())).await.unwrap();
}

/// Accepts the node's connection and its registration, answering both.
async fn accept(listener: &TcpListener) -> Socket {
    let (stream, _) = listener.accept().await.unwrap();
    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
    let register = next(&mut socket).await;
    assert_eq!(register["type"], "node.register");
    send(
        &mut socket,
        json!({"v": 1, "id": register["id"], "type": "reply", "ok": true, "data": {}}),
    )
    .await;
    socket
}

/// The next `action.result` on `socket`, skipping heartbeats and inventory.
async fn result(socket: &mut Socket) -> Value {
    loop {
        let frame = next(socket).await;
        if frame["type"] == "action.result" {
            return frame;
        }
    }
}

fn release(invocation_id: &str) -> Value {
    json!({"v": 1, "type": "action.invoke", "action": "release",
        "invocation_id": invocation_id, "input": {"name": "w1"}})
}

#[tokio::test]
async fn a_result_relaycast_refuses_under_load_is_sent_again() {
    let folder = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (host, results) = (Arc::new(Host::default()), results());
    let node = SpawnNode::start_with(
        config(folder.path(), &listener),
        host.clone(),
        results.clone(),
    );
    let mut socket = accept(&listener).await;
    send(&mut socket, release("inv_1")).await;
    let first = result(&mut socket).await;
    assert_eq!(first["invocation_id"], "inv_1");
    let id = first["id"].as_str().expect("a result names itself");
    // What production Relaycast answered while its database was busy.
    send(
        &mut socket,
        json!({"v": 1, "id": id, "type": "error", "ok": false,
            "code": "d1_pressure", "message": "Node liveness retry pending"}),
    )
    .await;
    // The same frame again, so Relaycast can tell it is one result.
    assert_eq!(result(&mut socket).await, first);
    // Taken this time: nothing comes back, and nothing is owed once the
    // window passes.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(owed(&results).is_empty());
    let refusals = host.refusals.lock().unwrap().clone();
    assert_eq!(refusals.len(), 1, "{refusals:?}");
    assert!(refusals[0].contains("d1_pressure"), "{refusals:?}");
    node.stop().await;
}

#[tokio::test]
async fn a_result_whose_socket_ended_is_sent_on_the_next_connection() {
    let folder = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let results = results();
    let node = SpawnNode::start_with(
        config(folder.path(), &listener),
        Arc::new(Host::default()),
        results.clone(),
    );
    let mut socket = accept(&listener).await;
    send(&mut socket, release("inv_2")).await;
    let first = result(&mut socket).await;
    assert_eq!(first["invocation_id"], "inv_2");
    // The connection ends before Relaycast could have refused it.
    drop(socket);
    let mut socket = accept(&listener).await;
    assert_eq!(result(&mut socket).await, first);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(owed(&results).is_empty());
    node.stop().await;
}

#[tokio::test]
async fn a_result_owed_when_the_node_stopped_is_sent_by_the_next_node() {
    let folder = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = config(folder.path(), &listener);
    let results = results();
    let node = SpawnNode::start_with(config.clone(), Arc::new(Host::default()), results.clone());
    let mut socket = accept(&listener).await;
    send(&mut socket, release("inv_4")).await;
    let first = result(&mut socket).await;
    node.stop().await;
    drop(socket);
    assert_eq!(owed(&results).len(), 1);
    let node = SpawnNode::start_with(config, Arc::new(Host::default()), results.clone());
    let mut socket = accept(&listener).await;
    assert_eq!(result(&mut socket).await, first);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(owed(&results).is_empty());
    node.stop().await;
}

#[tokio::test]
async fn a_final_refusal_is_noted_and_not_sent_again() {
    let folder = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (host, results) = (Arc::new(Host::default()), results());
    let node = SpawnNode::start_with(
        config(folder.path(), &listener),
        host.clone(),
        results.clone(),
    );
    let mut socket = accept(&listener).await;
    send(&mut socket, release("inv_3")).await;
    let first = result(&mut socket).await;
    send(
        &mut socket,
        json!({"v": 1, "id": first["id"], "type": "error", "ok": false,
            "code": "action_result_not_dispatched",
            "message": "the invocation was requeued and is not dispatched to any node"}),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(owed(&results).is_empty());
    let refusals = host.refusals.lock().unwrap().clone();
    assert_eq!(refusals.len(), 1, "{refusals:?}");
    assert!(refusals[0].contains("not sending it again"), "{refusals:?}");
    // An error for a frame no one waits for is noted too, once.
    for _ in 0..2 {
        send(
            &mut socket,
            json!({"v": 1, "id": "error_1", "type": "error", "ok": false,
                "code": "d1_pressure", "message": "Node liveness retry pending"}),
        )
        .await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(host.refusals.lock().unwrap().len(), 2);
    node.stop().await;
}

/// Whether an `inventory.sync` frame lists `w1`.
fn lists_w1(frame: &Value) -> bool {
    frame["agents"]
        .as_array()
        .is_some_and(|agents| agents.iter().any(|a| a["name"] == "w1"))
}

#[tokio::test]
async fn a_released_agent_leaves_the_inventory_only_after_its_result() {
    let folder = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let node = SpawnNode::start_with(
        config(folder.path(), &listener),
        Arc::new(Host::default()),
        results(),
    );
    let mut socket = accept(&listener).await;
    while next(&mut socket).await["type"] != "inventory.sync" {}
    send(&mut socket, release("inv_5")).await;
    // Every inventory before the result still lists the agent, so
    // Relaycast never takes it for missing while its release is open.
    loop {
        let frame = next(&mut socket).await;
        if frame["type"] == "action.result" {
            assert_eq!(frame["invocation_id"], "inv_5");
            break;
        }
        if frame["type"] == "inventory.sync" {
            assert!(
                lists_w1(&frame),
                "an inventory without w1 came first: {frame}"
            );
        }
    }
    // Then Relaycast learns at once that it is gone.
    loop {
        let frame = next(&mut socket).await;
        if frame["type"] == "inventory.sync" {
            assert!(!lists_w1(&frame), "{frame}");
            break;
        }
    }
    node.stop().await;
}
