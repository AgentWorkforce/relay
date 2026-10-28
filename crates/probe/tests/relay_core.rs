//! The relay core end to end: the bridge over its real socket (a named pipe
//! on Windows), workspace discovery and verification, and push channels, all
//! against an in-process fake Relaycast. No broker, PTY runtime or agent
//! harness is ever started.

mod support {
    pub mod fake_relaycast;
}

use agent_relay_probe::relay::backoff::RelaycastBackoff;
use agent_relay_probe::relay::daemon::{self, BoundSocket, Config, Core, InstanceLock};
use agent_relay_probe::relay::delivery::DeliveryTiming;
use agent_relay_probe::relay::paths::{self, CorePaths};
use agent_relay_probe::relay::protocol::{BRIDGE_VERSION, MAX_FRAME_BYTES};
use agent_relay_probe::relay::push::{
    PushChannel, PushContext, PushManager, PushSignal, PushState, PushTarget, PushTiming,
};
use agent_relay_probe::relay::transport::{CoreReadHalf, CoreStream, CoreWriteHalf};
use agent_relay_probe::relay::workspace::Secret;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use support::fake_relaycast::{Behaviour, FakeRelaycast};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(10);

fn fast_timing() -> PushTiming {
    PushTiming {
        heartbeat: Duration::from_millis(50),
        backoff_unit: Duration::from_millis(10),
        jitter: || 1.0,
        mint_gap: Duration::ZERO,
    }
}

fn fast_delivery() -> DeliveryTiming {
    DeliveryTiming {
        safety_poll: Duration::from_millis(200),
        fast_poll: Duration::from_millis(100),
        heartbeat: Duration::from_secs(3600),
        retry_unit: Duration::from_millis(20),
        replies: Duration::from_millis(50),
        ..DeliveryTiming::default()
    }
}

/// A home signed in to an account whose workspace is at `relaycast`.
fn signed_in_home(home: &Path, relaycast: &str) {
    support::fake_relaycast::sign_in_store(&home.join("app-data"), "rk_live_node0000", relaycast);
}

fn config(home: &Path, socket: PathBuf, relaycast: &str) -> Config {
    let mut env = BTreeMap::new();
    env.insert("RELAYCAST_URL".to_string(), relaycast.to_string());
    Config {
        paths: CorePaths::for_socket(socket).unwrap(),
        home: home.to_path_buf(),
        app_data_dir: home.join("app-data"),
        env,
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: fast_timing(),
        delivery_timing: fast_delivery(),
    }
}

struct Client {
    reader: BufReader<CoreReadHalf>,
    writer: CoreWriteHalf,
    next_id: u64,
    events: Vec<Value>,
}

impl Client {
    async fn connect(socket: &Path) -> Client {
        let stream = CoreStream::connect(socket).await.unwrap();
        let (read, writer) = stream.into_split();
        Client {
            reader: BufReader::new(read),
            writer,
            next_id: 0,
            events: Vec::new(),
        }
    }

    async fn send_line(&mut self, line: &str) {
        self.writer
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    /// The next line, `None` once the daemon closed the connection.
    async fn line(&mut self) -> Option<Value> {
        let mut line = String::new();
        let read = tokio::time::timeout(WAIT, self.reader.read_line(&mut line))
            .await
            .expect("the daemon answers")
            .unwrap();
        (read > 0).then(|| serde_json::from_str(&line).unwrap())
    }

    /// Sends a request and returns its response, keeping events aside.
    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.send_line(&request.to_string()).await;
        loop {
            let line = self.line().await.expect("a response before close");
            if line.get("id") == Some(&json!(id)) {
                return line;
            }
            self.events.push(line);
        }
    }

    async fn hello(&mut self) -> Value {
        self.call(
            "hello",
            json!({"bridge_version": BRIDGE_VERSION, "client": "test"}),
        )
        .await
    }

    /// The next event on `topic`, from those already seen or still to come.
    async fn event(&mut self, topic: &str) -> Value {
        if let Some(index) = self
            .events
            .iter()
            .position(|event| event["params"]["topic"] == topic)
        {
            return self.events.remove(index);
        }
        loop {
            let line = self.line().await.expect("an event before close");
            if line["method"] == "event" && line["params"]["topic"] == topic {
                return line;
            }
        }
    }
}

struct Running {
    core: Arc<Core>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
    socket: PathBuf,
}

async fn start(home: &Path, relaycast: &str) -> Running {
    let socket = home.join("run/core.sock");
    let config = config(home, socket.clone(), relaycast);
    paths::socket_directory(config.paths.directory()).unwrap();
    let bound = BoundSocket::bind(&config.paths).unwrap();
    let (core, signals) = Core::new(config);
    let task = tokio::spawn(daemon::run(core.clone(), bound, signals));
    Running { core, task, socket }
}

#[tokio::test]
async fn a_client_reads_status_follows_changes_and_sees_the_daemon_stop() {
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    let temp = tempfile::tempdir().unwrap();
    let running = start(temp.path(), &fake.base_url).await;

    // Windows has no socket file or mode bits: the pipe's DACL admits.
    #[cfg(unix)]
    {
        use std::os::unix::fs::{FileTypeExt, PermissionsExt};
        let metadata = std::fs::metadata(&running.socket).unwrap();
        assert!(metadata.file_type().is_socket());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let directory = std::fs::metadata(running.socket.parent().unwrap()).unwrap();
        assert_eq!(directory.permissions().mode() & 0o777, 0o700);
    }

    let mut client = Client::connect(&running.socket).await;
    let hello = client.hello().await;
    assert_eq!(hello["result"]["bridge_version"], BRIDGE_VERSION);
    assert_eq!(hello["result"]["daemon_version"], "0.0.0-test");
    assert!(hello["result"]["methods"]
        .as_array()
        .unwrap()
        .contains(&json!("workspace.refresh")));

    let subscribed = client
        .call("subscribe", json!({"topics": ["status", "activity"]}))
        .await;
    let first_revision = subscribed["result"]["status"]["revision"].as_u64().unwrap();
    assert_eq!(
        subscribed["result"]["status"]["machine"]["machine_prefix"],
        "test-desk"
    );

    // The account signs in after the daemon started.
    signed_in_home(temp.path(), &fake.base_url);

    let refreshed = client.call("workspace.refresh", json!({})).await;
    let workspace = &refreshed["result"];
    assert_eq!(workspace["state"], "found");
    assert_eq!(workspace["base_url"], fake.base_url);
    assert_eq!(workspace["verification"], "verified");
    assert_eq!(workspace["workspace_name"], "Fake Workspace");
    assert!(!refreshed.to_string().contains("rk_live_"));

    // The key went to Relaycast, and only as a bearer on /v1/workspace.
    let verify = fake
        .requests()
        .into_iter()
        .find(|request| request.path == "/v1/workspace")
        .expect("the key was verified");
    assert_eq!(verify.method, "GET");
    assert_eq!(
        verify.authorization.as_deref(),
        Some("Bearer rk_live_node0000")
    );

    let diagnostics = client.call("diagnostics.requests", json!({})).await;
    let entries = diagnostics["result"]["entries"].as_array().unwrap();
    let request = entries
        .iter()
        .find(|entry| entry["endpoint"] == format!("{}/v1/workspace", fake.base_url))
        .expect("workspace verification is visible through the diagnostics bridge");
    assert_eq!(request["method"], "GET");
    assert_eq!(request["failed"], false);
    assert!(request["response"]
        .as_str()
        .unwrap()
        .contains("Fake Workspace"));
    assert!(!diagnostics.to_string().contains("rk_live_node0000"));

    let status_event = client.event("status").await;
    assert!(status_event["params"]["data"]["revision"].as_u64().unwrap() > first_revision);
    assert!(status_event["params"]["seq"].as_u64().unwrap() >= 1);
    let activity = client.event("activity").await;
    assert!(activity["params"]["data"]["message"].is_string());

    let status = client.call("status.get", json!({})).await;
    assert_eq!(status["result"]["workspace"]["verification"], "verified");

    let stopping = client.call("daemon.shutdown", json!({})).await;
    assert_eq!(stopping["result"]["stopping"], true);
    client.event("shutdown").await;
    // The connection closes after the shutdown event.
    while client.line().await.is_some() {}
    tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!running.socket.exists(), "the socket is removed on stop");
    drop(running.core);
}

#[tokio::test]
async fn the_bridge_requires_a_handshake_and_reports_errors_by_kind() {
    let temp = tempfile::tempdir().unwrap();
    let running = start(temp.path(), "http://127.0.0.1:9").await;
    let mut client = Client::connect(&running.socket).await;

    let early = client.call("status.get", json!({})).await;
    assert_eq!(early["error"]["data"]["kind"], "handshake_required");

    let mismatch = client.call("hello", json!({"bridge_version": 99})).await;
    assert_eq!(mismatch["error"]["data"]["kind"], "bridge_version_mismatch");
    assert_eq!(mismatch["error"]["code"], -32000);

    client.hello().await;
    let unknown = client.call("agents.frobnicate", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32601);
    assert_eq!(unknown["error"]["data"]["kind"], "method_not_found");

    let bad_params = client.call("subscribe", json!({"topics": ["nope"]})).await;
    assert_eq!(bad_params["error"]["data"]["kind"], "invalid_params");

    client.send_line("{not json").await;
    let parse = client.line().await.unwrap();
    assert_eq!(parse["error"]["code"], -32700);
    assert_eq!(parse["id"], Value::Null);

    client
        .send_line(r#"{"jsonrpc":"1.0","id":"x","method":"status.get"}"#)
        .await;
    let version = client.line().await.unwrap();
    assert_eq!(version["error"]["data"]["kind"], "invalid_request");
    assert_eq!(version["id"], "x");

    // A notification is executed without a reply: the next line answers id 9.
    client
        .send_line(r#"{"jsonrpc":"2.0","method":"status.get"}"#)
        .await;
    client
        .send_line(r#"{"jsonrpc":"2.0","id":9,"method":"status.get"}"#)
        .await;
    assert_eq!(client.line().await.unwrap()["id"], 9);

    // No workspace: verification says so by kind.
    let verify = client.call("workspace.verify", json!({})).await;
    assert_eq!(verify["error"]["data"]["kind"], "not_signed_in");

    // A client on another bridge version can still retire the daemon.
    let mut stranger = Client::connect(&running.socket).await;
    let retired = stranger.call("daemon.shutdown", Value::Null).await;
    assert_eq!(retired["result"]["stopping"], true);
    tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn an_oversized_line_closes_the_connection() {
    let temp = tempfile::tempdir().unwrap();
    let running = start(temp.path(), "http://127.0.0.1:9").await;
    let mut client = Client::connect(&running.socket).await;
    client.hello().await;
    let huge = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"status.get","params":{{"pad":"{}"}}}}"#,
        "x".repeat(1024 * 1024 + 10)
    );
    client.send_line(&huge).await;
    let refused = client.line().await.unwrap();
    assert_eq!(refused["error"]["data"]["kind"], "invalid_request");
    assert!(client.line().await.is_none());
    running.core.request_shutdown();
    tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_line_of_exactly_the_frame_limit_is_served() {
    let temp = tempfile::tempdir().unwrap();
    let running = start(temp.path(), "http://127.0.0.1:9").await;
    let mut client = Client::connect(&running.socket).await;
    client.hello().await;
    let frame = |pad: usize| {
        format!(
            r#"{{"jsonrpc":"2.0","id":7,"method":"status.get","params":{{"pad":"{}"}}}}"#,
            "x".repeat(pad)
        )
    };
    let pad = MAX_FRAME_BYTES - frame(0).len();
    let line = frame(pad);
    assert_eq!(line.len(), MAX_FRAME_BYTES);
    client.send_line(&line).await;
    let answer = client.line().await.unwrap();
    assert_eq!(answer["id"], 7);
    assert!(answer["result"]["revision"].is_u64(), "{answer}");
    running.core.request_shutdown();
    tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_request_with_a_null_id_is_answered() {
    let temp = tempfile::tempdir().unwrap();
    let running = start(temp.path(), "http://127.0.0.1:9").await;
    let mut client = Client::connect(&running.socket).await;
    client.hello().await;
    client
        .send_line(r#"{"jsonrpc":"2.0","id":null,"method":"status.get"}"#)
        .await;
    client
        .send_line(r#"{"jsonrpc":"2.0","id":2,"method":"status.get"}"#)
        .await;
    let first = client.line().await.unwrap();
    assert_eq!(first["id"], Value::Null);
    assert!(first["result"]["revision"].is_u64(), "{first}");
    running.core.request_shutdown();
    tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

/// A client that stops reading is not queued an unbounded backlog: once it
/// falls behind, the stale events are skipped and one fresh snapshot takes
/// their place.
#[tokio::test]
async fn a_client_that_stops_reading_gets_a_fresh_snapshot_not_a_backlog() {
    const PUBLISHED: usize = 5000;
    let temp = tempfile::tempdir().unwrap();
    let running = start(temp.path(), "http://127.0.0.1:9").await;
    let mut client = Client::connect(&running.socket).await;
    client.hello().await;
    client
        .call("subscribe", json!({"topics": ["status", "activity"]}))
        .await;
    for index in 0..PUBLISHED {
        running.core.hub().activity(
            agent_relay_probe::relay::state::Level::Info,
            format!("line {index} {}", "x".repeat(64)),
        );
        // Let the connection drain what it can, as a live daemon would.
        tokio::task::yield_now().await;
    }
    let mut activity = 0;
    let resync = loop {
        let line = client.line().await.expect("an event");
        match line["params"]["topic"].as_str() {
            Some("activity") => activity += 1,
            Some("status") => break line,
            _ => {}
        }
        assert!(activity < PUBLISHED, "the whole backlog was queued");
    };
    assert!(resync["params"]["data"]["revision"].is_u64());
    running.core.request_shutdown();
    tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_rejected_key_is_reported_without_repeating_it() {
    let fake = FakeRelaycast::start(Behaviour {
        workspace_status: 401,
        ..Behaviour::default()
    })
    .await;
    let temp = tempfile::tempdir().unwrap();
    signed_in_home(temp.path(), &fake.base_url);
    let running = start(temp.path(), &fake.base_url).await;
    let mut client = Client::connect(&running.socket).await;
    client.hello().await;
    client.call("workspace.refresh", json!({})).await;
    let verify = client.call("workspace.verify", json!({})).await;
    assert_eq!(verify["error"]["data"]["kind"], "unauthorized");
    assert!(!verify.to_string().contains("rk_live_"));
    let status = client.call("status.get", json!({})).await;
    assert_eq!(status["result"]["workspace"]["verification"], "rejected");
    running.core.request_shutdown();
    tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[test]
fn the_config_never_prints_the_environment_values() {
    let temp = tempfile::tempdir().unwrap();
    let mut config = config(
        temp.path(),
        temp.path().join("core.sock"),
        "http://127.0.0.1:9",
    );
    config
        .env
        .insert("RELAY_WORKSPACE_KEY".into(), "rk_live_envsecret0".into());
    let printed = format!("{config:?}");
    assert!(printed.contains("RELAY_WORKSPACE_KEY"), "{printed}");
    assert!(!printed.contains("envsecret0"), "{printed}");
}

#[test]
fn one_daemon_per_socket() {
    let temp = tempfile::tempdir().unwrap();
    let paths = CorePaths::for_socket(temp.path().join("core.sock")).unwrap();
    let held = InstanceLock::acquire(&paths).unwrap();
    let second = InstanceLock::acquire(&paths).err().expect("refused");
    assert_eq!(
        second.to_string(),
        "Agent Relay core is already running for this socket."
    );
    drop(held);
    InstanceLock::acquire(&paths).expect("free once released");
}

#[cfg(windows)]
#[tokio::test]
async fn a_pipe_another_server_holds_is_never_joined() {
    let temp = tempfile::tempdir().unwrap();
    let paths = CorePaths::for_socket(temp.path().join("core.sock")).unwrap();
    let bound = BoundSocket::bind(&paths).unwrap();
    assert!(BoundSocket::bind(&paths).is_err());
    drop(bound);
    BoundSocket::bind(&paths).expect("free once the first one closed");
}

#[cfg(unix)]
#[tokio::test]
async fn a_stale_socket_is_replaced_and_a_non_socket_is_left_alone() {
    let temp = tempfile::tempdir().unwrap();
    let paths = CorePaths::for_socket(temp.path().join("core.sock")).unwrap();
    let stale = std::os::unix::net::UnixListener::bind(&paths.socket).unwrap();
    drop(stale);
    let bound = BoundSocket::bind(&paths).expect("a leftover socket is replaced");
    drop(bound);
    assert!(!paths.socket.exists());

    std::fs::write(&paths.socket, b"not a socket").unwrap();
    assert!(BoundSocket::bind(&paths).is_err());
    assert_eq!(std::fs::read(&paths.socket).unwrap(), b"not a socket");
}

fn target(fake: &FakeRelaycast, agent: &str, machine_address: Option<&str>) -> PushTarget {
    let token = Secret::new(format!("at_live_{agent}"));
    PushTarget {
        agent: agent.into(),
        base_url: fake.base_url.clone(),
        workspace: agent_relay_probe::relay::backoff::WorkspaceScope::credential(
            &fake.base_url,
            &token,
            "test workspace",
        ),
        token,
        machine_address: machine_address.map(str::to_string),
    }
}

fn push_context() -> (PushContext, mpsc::UnboundedReceiver<PushSignal>) {
    let (signals, receiver) = mpsc::unbounded_channel();
    (
        PushContext::new(
            "9.9.9".into(),
            "test-desk".into(),
            fast_timing(),
            signals,
            Arc::new(RelaycastBackoff::default()),
        ),
        receiver,
    )
}

async fn next_signal(signals: &mut mpsc::UnboundedReceiver<PushSignal>) -> PushSignal {
    tokio::time::timeout(WAIT, signals.recv())
        .await
        .expect("a push signal")
        .expect("the channel is open")
}

async fn wait_signal(
    signals: &mut mpsc::UnboundedReceiver<PushSignal>,
    wanted: impl Fn(&PushSignal) -> bool,
) -> PushSignal {
    loop {
        let signal = next_signal(signals).await;
        if wanted(&signal) {
            return signal;
        }
    }
}

#[tokio::test]
async fn a_channel_registers_goes_live_and_hands_over_a_pushed_delivery() {
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    let (context, mut signals) = push_context();
    let channel = PushChannel::spawn(target(&fake, "alice", None), context);

    assert_eq!(
        next_signal(&mut signals).await,
        PushSignal::State {
            agent: "alice".into(),
            state: PushState::Connecting
        }
    );
    assert_eq!(
        next_signal(&mut signals).await,
        PushSignal::State {
            agent: "alice".into(),
            state: PushState::Live
        }
    );
    // Going live reads whatever queued while the socket was down.
    assert_eq!(
        next_signal(&mut signals).await,
        PushSignal::Wake {
            agent: "alice".into(),
            frame: None
        }
    );

    let mint = fake
        .requests()
        .into_iter()
        .find(|request| request.path == "/v1/agent/node-token")
        .unwrap();
    assert_eq!(mint.authorization.as_deref(), Some("Bearer at_live_alice"));
    let query = fake.socket_queries().pop().unwrap();
    assert!(query.contains("token=nt_live_1"), "{query}");
    assert!(query.contains("origin_surface=desktop"), "{query}");
    let register = fake.frames().into_iter().next().unwrap();
    assert_eq!(register["type"], "node.register");
    assert_eq!(register["machine_id"], "test-desk-agent-1");
    assert_eq!(register["version"], "relay-desktop/9.9.9");

    let deliver = json!({
        "type": "deliver", "agent": "alice", "seq": 7, "delivery_id": "dlv_1",
        "payload": {"type": "dm.received", "data": {"message": {"agent_name": "bob", "text": "hi"}}}
    });
    fake.push(deliver.clone());
    assert_eq!(
        wait_signal(&mut signals, |signal| matches!(
            signal,
            PushSignal::Wake { frame: Some(_), .. }
        ))
        .await,
        PushSignal::Wake {
            agent: "alice".into(),
            frame: Some(deliver)
        }
    );

    fake.wait_for("heartbeats", |fake| {
        fake.frames()
            .iter()
            .filter(|frame| frame["type"] == "node.heartbeat")
            .count()
            >= 2
    })
    .await;
    // Acknowledgement is the delivery runtime's, over HTTP: never on the socket.
    assert!(fake
        .frames()
        .iter()
        .all(|frame| frame["type"] != "delivery.ack"));

    channel.stop().await;
    assert!(matches!(
        wait_signal(&mut signals, |signal| matches!(
            signal,
            PushSignal::Stopped { .. }
        ))
        .await,
        PushSignal::Stopped { .. }
    ));
}

#[tokio::test]
async fn a_persisted_machine_address_is_registered_as_is() {
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    let (context, mut signals) = push_context();
    let channel = PushChannel::spawn(
        target(&fake, "alice", Some("first-computer-local-123")),
        context,
    );
    wait_signal(&mut signals, |signal| {
        matches!(
            signal,
            PushSignal::State {
                state: PushState::Live,
                ..
            }
        )
    })
    .await;
    assert_eq!(fake.frames()[0]["machine_id"], "first-computer-local-123");
    channel.stop().await;
}

#[tokio::test]
async fn stopping_a_channel_whose_peer_stopped_reading_is_bounded() {
    // Every heartbeat carries the node name: at a megabyte each, a few
    // heartbeat periods fill the loopback socket buffers once the peer stops
    // reading, and the next heartbeat write is wedged.
    let fake = FakeRelaycast::start(Behaviour {
        node_name: "n".repeat(1024 * 1024),
        stall_after_register: true,
        ..Behaviour::default()
    })
    .await;
    let (context, mut signals) = push_context();
    let channel = PushChannel::spawn(target(&fake, "alice", None), context);
    wait_signal(&mut signals, |signal| {
        matches!(
            signal,
            PushSignal::State {
                state: PushState::Live,
                ..
            }
        )
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    tokio::time::timeout(WAIT, channel.stop())
        .await
        .expect("stop returns while the peer is wedged");
    assert!(matches!(
        wait_signal(&mut signals, |signal| matches!(
            signal,
            PushSignal::Stopped { .. }
        ))
        .await,
        PushSignal::Stopped { .. }
    ));
}

#[tokio::test]
async fn a_refused_token_waits_and_retries() {
    let fake = FakeRelaycast::start(Behaviour {
        node_token_status: 401,
        ..Behaviour::default()
    })
    .await;
    let (context, mut signals) = push_context();
    let channel = PushChannel::spawn(target(&fake, "alice", None), context);
    let waiting = wait_signal(&mut signals, |signal| {
        matches!(
            signal,
            PushSignal::State {
                state: PushState::Waiting { .. },
                ..
            }
        )
    })
    .await;
    // First retry: 2 units of 10 ms at jitter 1.0.
    assert_eq!(
        waiting,
        PushSignal::State {
            agent: "alice".into(),
            state: PushState::Waiting { retry_in_ms: 20 }
        }
    );
    fake.wait_for("a second mint", |fake| {
        fake.requests()
            .iter()
            .filter(|request| request.path == "/v1/agent/node-token")
            .count()
            >= 2
    })
    .await;
    fake.set_node_token_status(200);
    wait_signal(&mut signals, |signal| {
        matches!(
            signal,
            PushSignal::State {
                state: PushState::Live,
                ..
            }
        )
    })
    .await;
    channel.stop().await;
}

#[tokio::test]
async fn an_ended_socket_wakes_a_queue_read_and_reconnects_with_the_same_token() {
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    let (context, mut signals) = push_context();
    let channel = PushChannel::spawn(target(&fake, "alice", None), context);
    wait_signal(&mut signals, |signal| {
        matches!(
            signal,
            PushSignal::State {
                state: PushState::Live,
                ..
            }
        )
    })
    .await;
    fake.close_socket();
    let mut woke = false;
    loop {
        match next_signal(&mut signals).await {
            PushSignal::Wake { frame: None, .. } => woke = true,
            PushSignal::State {
                state: PushState::Live,
                ..
            } => break,
            _ => {}
        }
    }
    assert!(woke, "an ended socket wakes a queue read");
    // Each mint rotates the token: a reconnect keeps the one it has.
    assert_eq!(fake.minted(), 1);
    assert!(fake.socket_queries()[1].contains("token=nt_live_1"));
    channel.stop().await;
}

#[tokio::test]
async fn a_token_the_socket_refuses_is_minted_again() {
    let fake = FakeRelaycast::start(Behaviour {
        socket_status: 401,
        ..Behaviour::default()
    })
    .await;
    let (context, mut signals) = push_context();
    let channel = PushChannel::spawn(target(&fake, "alice", None), context);
    fake.wait_for("a second mint", |fake| fake.minted() >= 2)
        .await;
    fake.set_socket_status(101);
    wait_signal(&mut signals, |signal| {
        matches!(
            signal,
            PushSignal::State {
                state: PushState::Live,
                ..
            }
        )
    })
    .await;
    let minted = fake.minted();
    assert!(fake
        .socket_queries()
        .last()
        .unwrap()
        .contains(&format!("token=nt_live_{minted}")));
    channel.stop().await;
}

fn relabelled(target: PushTarget, label: &str) -> PushTarget {
    PushTarget {
        workspace: agent_relay_probe::relay::backoff::WorkspaceScope::credential(
            &target.base_url,
            &target.token,
            label,
        ),
        ..target
    }
}

#[tokio::test]
async fn a_verified_workspace_name_keeps_every_channel_connected() {
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    let (context, mut signals) = push_context();
    let mut manager = PushManager::new(context);
    let targets = || vec![target(&fake, "alice", None), target(&fake, "bob", None)];
    manager.sync(targets()).await;
    let mut live = std::collections::BTreeSet::new();
    while live.len() < 2 {
        if let PushSignal::State {
            agent,
            state: PushState::Live,
        } = next_signal(&mut signals).await
        {
            live.insert(agent);
        }
    }
    // The workspace's label changes once Relaycast names it: the same
    // sockets serve the same agents.
    manager
        .sync(
            targets()
                .into_iter()
                .map(|target| relabelled(target, "rw_7ccfea89"))
                .collect(),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    while let Ok(signal) = signals.try_recv() {
        assert!(
            !matches!(
                signal,
                PushSignal::Stopped { .. }
                    | PushSignal::State {
                        state: PushState::Connecting,
                        ..
                    }
            ),
            "{signal:?}"
        );
    }
    assert_eq!(fake.minted(), 2);
    assert_eq!(fake.socket_queries().len(), 2);
    manager.stop().await;
}

#[tokio::test]
async fn channels_starting_together_mint_one_at_a_time() {
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    let (mut context, _signals) = push_context();
    context.timing.mint_gap = Duration::from_millis(150);
    let mut manager = PushManager::new(context);
    manager
        .sync(vec![
            target(&fake, "alice", None),
            target(&fake, "bob", None),
            target(&fake, "carol", None),
        ])
        .await;
    fake.wait_for("three mints", |fake| fake.minted() >= 3)
        .await;
    let mints: Vec<_> = fake
        .calls("POST", "/v1/agent/node-token")
        .into_iter()
        .map(|request| request.received_at)
        .collect();
    assert_eq!(mints.len(), 3);
    for pair in mints.windows(2) {
        assert!(
            pair[1].duration_since(pair[0]) >= Duration::from_millis(140),
            "mints {:?} apart",
            pair[1].duration_since(pair[0])
        );
    }
    manager.stop().await;
}

#[tokio::test]
async fn queued_mints_honor_a_workspace_429_and_resume_after_the_pause() {
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    let release = fake.hold("POST /v1/agent/node-token");
    fake.set_api_error(
        "POST /v1/agent/node-token",
        Some((429, "rate_limit_exceeded")),
    );
    let (mut context, _signals) = push_context();
    context.timing.mint_gap = Duration::from_millis(50);
    let gate = context.backoff.clone();
    let workspace = agent_relay_probe::relay::backoff::WorkspaceScope::id(
        &fake.base_url,
        "shared-workspace",
        "Team",
    );
    let targets = ["alice", "bob", "carol"].map(|agent| PushTarget {
        workspace: workspace.clone(),
        ..target(&fake, agent, None)
    });
    let mut manager = PushManager::new(context);
    manager.sync(targets.to_vec()).await;
    fake.wait_for("the first mint is held", |fake| {
        fake.held("POST /v1/agent/node-token") == 1
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        fake.held("POST /v1/agent/node-token"),
        1,
        "mints cannot overlap"
    );
    release.send(true).unwrap();
    fake.wait_for("the shared 429 pause", |_| gate.write_paused(&workspace))
        .await;
    fake.set_api_error("POST /v1/agent/node-token", None);
    // Queued mints already passed the channel's gate before the first
    // request returned: they must check it again after acquiring the lock.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(fake.calls("POST", "/v1/agent/node-token").len(), 1);
    assert_eq!(fake.minted(), 0);
    // The gate admits one recheck first; siblings may already be sleeping
    // through its 30-second probe lease when that request succeeds.
    fake.wait_for("a mint resumes after the pause", |fake| fake.minted() > 0)
        .await;
    manager.stop().await;
}

#[tokio::test]
async fn the_core_keeps_one_channel_per_agent_and_reports_it() {
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    let temp = tempfile::tempdir().unwrap();
    let running = start(temp.path(), &fake.base_url).await;
    let mut client = Client::connect(&running.socket).await;
    client.hello().await;
    client
        .call("subscribe", json!({"topics": ["status"]}))
        .await;

    running
        .core
        .sync_push(vec![
            target(&fake, "alice", None),
            target(&fake, "bob", None),
        ])
        .await;
    loop {
        let event = client.event("status").await;
        let push = &event["params"]["data"]["push"];
        if push["alice"]["state"] == "live" && push["bob"]["state"] == "live" {
            break;
        }
    }
    running
        .core
        .sync_push(vec![target(&fake, "alice", None)])
        .await;
    loop {
        let status = client.call("status.get", json!({})).await;
        let push = status["result"]["push"].as_object().unwrap().clone();
        if !push.contains_key("bob") {
            assert_eq!(push["alice"]["state"], "live");
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(fake.minted(), 2, "alice's channel was kept, not restarted");

    running.core.request_shutdown();
    tokio::time::timeout(WAIT, running.task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
