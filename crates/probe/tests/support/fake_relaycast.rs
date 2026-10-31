//! An in-process fake of the Relaycast surface the core uses: HTTP routes and
//! the direct node socket on one loopback port, as the real origin serves
//! both, plus the relayfile-cloud routes integrations use. Nothing leaves the
//! machine.
//!
//! It keeps a small world: agents (registered with the workspace key), each
//! agent's delivery queue, channels, webhooks, subscriptions, and DMs with
//! their conversations. Answers have the shapes the SDK decodes.

#![allow(dead_code)]

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

pub const WORKSPACE_KEY: &str = "rk_live_node0000";

/// Records `key` at `base_url` as the signed-in account's workspace in the
/// agent store under `data_dir`, keeping whatever else the store holds.
pub fn sign_in_store(data_dir: &std::path::Path, key: &str, base_url: &str) {
    std::fs::create_dir_all(data_dir).unwrap();
    let path = data_dir.join("injectable-agents.json");
    let mut store: Value = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    if store.get("cloud").is_none_or(Value::is_null) {
        store["cloud"] = json!({"key": key, "baseURL": base_url, "workspaceID": "rw_fake"});
    }
    std::fs::write(path, store.to_string()).unwrap();
}
pub const CREATED_AT: &str = "2026-09-29T12:00:00Z";

#[derive(Clone, Debug)]
pub struct Recorded {
    pub received_at: std::time::Instant,
    pub method: String,
    pub path: String,
    pub query: String,
    pub authorization: Option<String>,
    pub idempotency_key: Option<String>,
    /// `X-Relaycast-Origin-Client` and `X-Relaycast-Origin-Version`.
    pub origin: (Option<String>, Option<String>),
    pub body: Value,
}

pub struct Behaviour {
    /// Status for `GET /v1/workspace` (200 answers with a workspace).
    pub workspace_status: u16,
    /// Status for `POST /v1/agent/node-token`.
    pub node_token_status: u16,
    /// Whether `node.register` gets an accepting reply.
    pub reply_to_register: bool,
    pub acknowledge_presence: bool,
    /// The minted node's name, which every register and heartbeat frame
    /// carries.
    pub node_name: String,
    /// After replying to `node.register`, the socket stays open but is never
    /// read again: a wedged peer.
    pub stall_after_register: bool,
    /// Status for the node socket's upgrade: 101 accepts it, anything else
    /// refuses it with that status (401: the node token is not current).
    pub socket_status: u16,
}

impl Default for Behaviour {
    fn default() -> Behaviour {
        Behaviour {
            workspace_status: 200,
            node_token_status: 200,
            reply_to_register: true,
            acknowledge_presence: false,
            node_name: "desk".into(),
            stall_after_register: false,
            socket_status: 101,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub token: String,
    pub address: String,
    pub metadata: Value,
    pub kind: String,
    /// Relaycast's derived status: `active` unless a test sets it.
    pub status: String,
    pub last_seen: String,
    /// Whether `address` names a node; `false` is an agent registered
    /// without one (SDK, MCP), listed with a null address.
    pub hosted: bool,
}

impl Agent {
    /// The agent as `GET /v1/agents` lists it.
    fn record(&self) -> Value {
        json!({"id": self.id, "name": self.name, "type": self.kind, "status": self.status,
            "address": if self.hosted { json!(self.address) } else { Value::Null },
            "metadata": self.metadata, "last_seen": self.last_seen})
    }

    /// The agent as `GET /v1/agents/{name}` details it: with the deliveries
    /// Relaycast still holds for it.
    fn detail(&self, world: &World) -> Value {
        let mut record = self.record();
        record["pending_deliveries"] = world
            .deliveries
            .get(&self.name)
            .into_iter()
            .flatten()
            .filter(|d| d.state == "queued" || d.state == "delivered")
            .map(|d| json!({"id": d.item["id"], "message_id": d.item["message_id"], "status": d.state}))
            .collect();
        record
    }
}

#[derive(Clone, Debug)]
pub struct QueuedDelivery {
    pub item: Value,
    /// `queued`, `acked` or `failed`.
    pub state: String,
    pub retryable: Option<bool>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct StoredMessage {
    pub id: String,
    pub conversation: String,
    pub sender: String,
    pub recipient: String,
    pub text: String,
    pub thread_id: Option<String>,
    pub created_at: String,
    /// `{file_id, filename, content_type, size_bytes}` for each file sent.
    pub attachments: Vec<Value>,
}

/// A file uploaded to (or seeded in) the fake.
#[derive(Clone, Debug)]
pub struct FakeFile {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: u64,
    /// `pending` until completed.
    pub status: String,
    pub bytes: Option<Vec<u8>>,
    /// The `Content-Type` the bytes were `PUT` with.
    pub put_content_type: Option<String>,
}

#[derive(Default)]
struct World {
    agents: BTreeMap<String, Agent>,
    next: u32,
    /// Queue items by agent name.
    deliveries: BTreeMap<String, Vec<QueuedDelivery>>,
    /// Channel name → (id, member names).
    channels: BTreeMap<String, (String, Vec<String>)>,
    webhooks: BTreeMap<String, Value>,
    subscriptions: BTreeMap<String, Value>,
    messages: Vec<StoredMessage>,
    /// relayfile-cloud subscriptions by id.
    relayfile: BTreeMap<String, Value>,
    files: BTreeMap<String, FakeFile>,
    /// Agent names whose deletion fails with 503.
    undeletable: Vec<String>,
    /// Deliveries whose ack and fail answer 503.
    unsettleable: Vec<String>,
    /// `METHOD /path` requests that answer 503; a trailing `*` matches any
    /// rest of the path.
    failing: Vec<String>,
}

#[derive(Default)]
struct Shared {
    behaviour: Behaviour,
    base_url: String,
    requests: Vec<Recorded>,
    frames: Vec<Value>,
    sockets: Vec<mpsc::UnboundedSender<SocketCommand>>,
    socket_queries: Vec<String>,
    minted: u32,
    world: World,
    /// `METHOD /path` requests that wait for `true` before they are
    /// answered.
    holds: BTreeMap<String, watch::Receiver<bool>>,
    /// How many requests each hold has parked.
    held: BTreeMap<String, u32>,
    /// Explicit API errors for pacing tests; healthy routes are unchanged.
    api_errors: BTreeMap<String, (u16, String)>,
}

enum SocketCommand {
    Send(Value),
    Close,
}

pub struct FakeRelaycast {
    pub base_url: String,
    shared: Arc<Mutex<Shared>>,
    task: JoinHandle<()>,
}

impl Drop for FakeRelaycast {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeRelaycast {
    pub async fn start(behaviour: Behaviour) -> FakeRelaycast {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let shared = Arc::new(Mutex::new(Shared {
            behaviour,
            base_url: base_url.clone(),
            ..Shared::default()
        }));
        let accept_shared = shared.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(serve(stream, accept_shared.clone()));
            }
        });
        FakeRelaycast {
            base_url,
            shared,
            task,
        }
    }

    pub fn set_node_token_status(&self, status: u16) {
        self.shared.lock().unwrap().behaviour.node_token_status = status;
    }

    pub fn set_socket_status(&self, status: u16) {
        self.shared.lock().unwrap().behaviour.socket_status = status;
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.shared.lock().unwrap().requests.clone()
    }

    /// Requests to `method path`.
    pub fn calls(&self, method: &str, path: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|r| r.method == method && r.path == path)
            .collect()
    }

    pub fn minted(&self) -> u32 {
        self.shared.lock().unwrap().minted
    }

    /// Emulate a server that can confirm agent presence on the node socket.
    pub fn acknowledge_presence(&self, enabled: bool) {
        self.shared.lock().unwrap().behaviour.acknowledge_presence = enabled;
    }

    /// Frames every socket has sent the fake, in arrival order.
    pub fn frames(&self) -> Vec<Value> {
        self.shared.lock().unwrap().frames.clone()
    }

    pub fn socket_queries(&self) -> Vec<String> {
        self.shared.lock().unwrap().socket_queries.clone()
    }

    /// Sends `frame` on the newest open socket.
    pub fn push(&self, frame: Value) {
        if let Some(socket) = self.shared.lock().unwrap().sockets.last() {
            let _ = socket.send(SocketCommand::Send(frame));
        }
    }

    /// Closes the newest open socket from the server side.
    pub fn close_socket(&self) {
        if let Some(socket) = self.shared.lock().unwrap().sockets.last() {
            let _ = socket.send(SocketCommand::Close);
        }
    }

    /// Waits until `condition` holds, polling the recorded state.
    pub async fn wait_for(&self, what: &str, condition: impl Fn(&FakeRelaycast) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !condition(self) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    // The world.

    pub fn agent(&self, name: &str) -> Option<Agent> {
        self.shared.lock().unwrap().world.agents.get(name).cloned()
    }

    pub fn agent_names(&self) -> Vec<String> {
        self.shared
            .lock()
            .unwrap()
            .world
            .agents
            .keys()
            .cloned()
            .collect()
    }

    /// Adds an agent registered elsewhere (a teammate, a person).
    pub fn seed_agent(&self, name: &str, kind: &str, metadata: Value) -> Agent {
        let mut shared = self.shared.lock().unwrap();
        create_agent(&mut shared.world, name, "elsewhere", metadata, kind)
    }

    /// Sets the presence Relaycast reports for `name`.
    pub fn set_presence(&self, name: &str, status: &str, last_seen: &str, hosted: bool) {
        let mut shared = self.shared.lock().unwrap();
        let agent = shared.world.agents.get_mut(name).expect("a seeded agent");
        agent.status = status.into();
        agent.last_seen = last_seen.into();
        agent.hosted = hosted;
    }

    /// Marks `name`'s queued deliveries handed to its host, unacknowledged.
    pub fn hand_over(&self, name: &str) {
        let mut shared = self.shared.lock().unwrap();
        for delivery in shared.world.deliveries.get_mut(name).into_iter().flatten() {
            if delivery.state == "queued" {
                delivery.state = "delivered".into();
            }
        }
    }

    /// Settles `name`'s deliveries as its host acknowledging them would.
    pub fn acknowledge_all(&self, name: &str) {
        let mut shared = self.shared.lock().unwrap();
        for delivery in shared.world.deliveries.get_mut(name).into_iter().flatten() {
            delivery.state = "acked".into();
        }
    }

    /// Queues a DM from `sender` to `recipient` as Relaycast would,
    /// returning `(delivery id, message id)`.
    pub fn send_dm(&self, sender: &str, recipient: &str, text: &str) -> (String, String) {
        self.queue(recipient, "dm", None, sender, text)
    }

    /// Queues a delivery for `agent`, returning `(delivery id, message id)`.
    pub fn queue(
        &self,
        agent: &str,
        reason: &str,
        channel_id: Option<&str>,
        sender: &str,
        text: &str,
    ) -> (String, String) {
        let mut shared = self.shared.lock().unwrap();
        let message = store_message(&mut shared.world, sender, agent, text, None);
        let id = queue(&mut shared.world, agent, &message, reason, channel_id);
        (id, message.id)
    }

    /// [`FakeRelaycast::queue`], usable while the harness is borrowed.
    pub fn queuer(&self) -> impl Fn(&str, &str, Option<&str>, &str, &str) -> (String, String) {
        let shared = self.shared.clone();
        move |agent, reason, channel_id, sender, text| {
            let mut shared = shared.lock().unwrap();
            let message = store_message(&mut shared.world, sender, agent, text, None);
            let id = queue(&mut shared.world, agent, &message, reason, channel_id);
            (id, message.id)
        }
    }

    /// Queues a channel post in the thread beneath `thread` for `agent`,
    /// returning `(delivery id, message id)`.
    pub fn queue_in_thread(
        &self,
        agent: &str,
        channel_id: &str,
        sender: &str,
        text: &str,
        thread: &str,
    ) -> (String, String) {
        let mut shared = self.shared.lock().unwrap();
        let message = store_message(&mut shared.world, sender, agent, text, Some(thread.into()));
        let id = queue(
            &mut shared.world,
            agent,
            &message,
            "message",
            Some(channel_id),
        );
        (id, message.id)
    }

    /// A completed file, as if another agent had uploaded it; its id.
    pub fn seed_file(&self, filename: &str, content_type: &str, bytes: &[u8]) -> String {
        let mut shared = self.shared.lock().unwrap();
        shared.world.next += 1;
        let id = format!("file_{}", shared.world.next);
        shared.world.files.insert(
            id.clone(),
            FakeFile {
                id: id.clone(),
                filename: filename.into(),
                content_type: content_type.into(),
                size_bytes: bytes.len() as u64,
                status: "complete".into(),
                bytes: Some(bytes.to_vec()),
                put_content_type: None,
            },
        );
        id
    }

    pub fn file(&self, id: &str) -> Option<FakeFile> {
        self.shared.lock().unwrap().world.files.get(id).cloned()
    }

    /// A channel with the named agents already joined.
    pub fn seed_channel(&self, name: &str, members: &[&str]) {
        self.shared.lock().unwrap().world.channels.insert(
            name.to_string(),
            (
                format!("ch_{name}"),
                members.iter().map(|member| member.to_string()).collect(),
            ),
        );
    }

    /// Queues a DM carrying `files` (ids) as Relaycast would.
    pub fn send_dm_with_files(
        &self,
        sender: &str,
        recipient: &str,
        text: &str,
        files: &[&str],
    ) -> (String, String) {
        let mut shared = self.shared.lock().unwrap();
        let attachments = files
            .iter()
            .filter_map(|id| attachment_json(&shared.world, id))
            .collect();
        let mut message = store_message(&mut shared.world, sender, recipient, text, None);
        message.attachments = attachments;
        if let Some(last) = shared.world.messages.last_mut() {
            last.attachments = message.attachments.clone();
        }
        let id = queue(&mut shared.world, recipient, &message, "dm", None);
        (id, message.id)
    }

    pub fn delivery_state(&self, id: &str) -> Option<QueuedDelivery> {
        let shared = self.shared.lock().unwrap();
        shared
            .world
            .deliveries
            .values()
            .flatten()
            .find(|d| d.item["id"] == id)
            .cloned()
    }

    /// Removes a delivery as Relaycast does after its queue lifetime ends.
    pub fn expire_delivery(&self, id: &str) -> bool {
        let mut shared = self.shared.lock().unwrap();
        let before: usize = shared.world.deliveries.values().map(Vec::len).sum();
        for deliveries in shared.world.deliveries.values_mut() {
            deliveries.retain(|delivery| delivery.item["id"] != id);
        }
        shared
            .world
            .deliveries
            .values()
            .map(Vec::len)
            .sum::<usize>()
            != before
    }

    /// Sets a delivery's state; a delivery not `queued` is left out of
    /// queue reads.
    pub fn set_delivery_state(&self, id: &str, state: &str) {
        let mut shared = self.shared.lock().unwrap();
        for delivery in shared.world.deliveries.values_mut().flatten() {
            if delivery.item["id"] == id {
                delivery.state = state.into();
            }
        }
    }

    /// Make a fixture a one-to-one DM, whose channel id is null in Relaycast.
    pub fn clear_delivery_channel(&self, id: &str) {
        let mut shared = self.shared.lock().unwrap();
        let delivery = shared
            .world
            .deliveries
            .values_mut()
            .flatten()
            .find(|d| d.item["id"] == id)
            .expect("delivery exists");
        delivery.item["channel_id"] = Value::Null;
        delivery.item["message"]["channel_id"] = Value::Null;
    }

    /// Removes Relaycast's authenticated sender attribution from a queued
    /// item, for malformed-delivery coverage.
    pub fn clear_delivery_sender(&self, id: &str) {
        let mut shared = self.shared.lock().unwrap();
        let delivery = shared
            .world
            .deliveries
            .values_mut()
            .flatten()
            .find(|delivery| delivery.item["id"] == id)
            .expect("delivery exists");
        delivery.item["message"]["agent_name"] = Value::Null;
        delivery.item["message"]["agent_address"] = Value::Null;
    }

    pub fn messages(&self) -> Vec<StoredMessage> {
        self.shared.lock().unwrap().world.messages.clone()
    }

    pub fn channels(&self) -> Vec<String> {
        self.shared
            .lock()
            .unwrap()
            .world
            .channels
            .keys()
            .cloned()
            .collect()
    }

    pub fn channel_members(&self, name: &str) -> Vec<String> {
        self.shared
            .lock()
            .unwrap()
            .world
            .channels
            .get(name)
            .map(|(_, members)| members.clone())
            .unwrap_or_default()
    }

    pub fn webhook_ids(&self) -> Vec<String> {
        self.shared
            .lock()
            .unwrap()
            .world
            .webhooks
            .keys()
            .cloned()
            .collect()
    }

    pub fn subscription_ids(&self) -> Vec<String> {
        self.shared
            .lock()
            .unwrap()
            .world
            .subscriptions
            .keys()
            .cloned()
            .collect()
    }

    pub fn relayfile_subscriptions(&self) -> Vec<Value> {
        self.shared
            .lock()
            .unwrap()
            .world
            .relayfile
            .values()
            .cloned()
            .collect()
    }

    /// Makes deleting these agents fail with 503.
    pub fn set_undeletable(&self, names: &[&str]) {
        self.shared.lock().unwrap().world.undeletable =
            names.iter().map(|n| n.to_string()).collect();
    }

    /// Parks every `METHOD /path` request matching `request` until the
    /// returned sender sends `true`; the request is answered only then.
    pub fn hold(&self, request: &str) -> watch::Sender<bool> {
        let (release, hold) = watch::channel(false);
        self.shared
            .lock()
            .unwrap()
            .holds
            .insert(request.into(), hold);
        release
    }

    /// How many requests the hold on `request` has parked.
    pub fn held(&self, request: &str) -> u32 {
        self.shared
            .lock()
            .unwrap()
            .held
            .get(request)
            .copied()
            .unwrap_or_default()
    }

    /// Forgets an agent as if Relaycast had already deleted it.
    pub fn forget_agent(&self, name: &str) {
        self.shared.lock().unwrap().world.agents.remove(name);
    }

    /// Makes these `METHOD /path` requests fail with 503; `METHOD
    /// /path?query` fails only that query.
    pub fn set_failing(&self, requests: &[&str]) {
        self.shared.lock().unwrap().world.failing =
            requests.iter().map(|n| n.to_string()).collect();
    }

    pub fn set_api_error(&self, request: &str, error: Option<(u16, &str)>) {
        let mut shared = self.shared.lock().unwrap();
        if let Some((status, code)) = error {
            shared
                .api_errors
                .insert(request.into(), (status, code.into()));
        } else {
            shared.api_errors.remove(request);
        }
    }

    /// Makes acks and fails of these deliveries fail with 503.
    pub fn set_unsettleable(&self, ids: &[&str]) {
        self.shared.lock().unwrap().world.unsettleable =
            ids.iter().map(|n| n.to_string()).collect();
    }
}

fn create_agent(world: &mut World, name: &str, prefix: &str, metadata: Value, kind: &str) -> Agent {
    world.next += 1;
    let id = format!("agent_{}", world.next);
    let agent = Agent {
        id: id.clone(),
        name: name.into(),
        token: format!("at_live_{prefix}_{name}_{}", world.next),
        address: format!("{name}@{prefix}-{id}"),
        metadata,
        kind: kind.into(),
        status: "active".into(),
        // Seen as it registers, as Relaycast records it.
        last_seen: chrono::Utc::now().to_rfc3339(),
        hosted: true,
    };
    world.agents.insert(name.into(), agent.clone());
    agent
}

fn conversation_id(a: &str, b: &str) -> String {
    let mut pair = [a, b];
    pair.sort();
    format!("dm_{}_{}", pair[0], pair[1])
}

fn store_message(
    world: &mut World,
    sender: &str,
    recipient: &str,
    text: &str,
    thread: Option<String>,
) -> StoredMessage {
    world.next += 1;
    let message = StoredMessage {
        id: format!("m_{}", world.next),
        conversation: conversation_id(sender, recipient),
        sender: sender.into(),
        recipient: recipient.into(),
        text: text.into(),
        thread_id: thread,
        attachments: Vec::new(),
        created_at: format!(
            "2026-09-29T12:{:02}:{:02}Z",
            world.next / 60 % 60,
            world.next % 60
        ),
    };
    world.messages.push(message.clone());
    message
}

fn message_json(world: &World, message: &StoredMessage, with_thread: bool) -> Value {
    let sender = world.agents.get(&message.sender);
    let mut value = json!({
        "id": message.id,
        "agent_id": sender.map(|a| a.id.clone()),
        "agent_name": message.sender,
        "agent_address": sender.map(|a| a.address.clone()),
        "text": message.text,
        "created_at": message.created_at,
        "metadata": {},
    });
    if with_thread {
        value["thread_id"] = json!(message.thread_id);
    }
    if !message.attachments.is_empty() {
        value["attachments"] = json!(message.attachments);
    }
    value
}

fn attachment_json(world: &World, id: &str) -> Option<Value> {
    let file = world.files.get(id)?;
    Some(json!({"file_id": file.id, "filename": file.filename,
        "content_type": file.content_type, "size_bytes": file.size_bytes}))
}

/// The ids in a send's `attachments`, as attachment records; `Err` names an
/// unknown or incomplete file.
fn attachments_of(world: &World, body: &Value) -> Result<Vec<Value>, (u16, Value)> {
    let mut out = Vec::new();
    for id in body["attachments"].as_array().into_iter().flatten() {
        let id = id.as_str().unwrap_or_default();
        match world.files.get(id) {
            Some(file) if file.status == "complete" => {
                out.push(attachment_json(world, id).unwrap())
            }
            _ => return Err(error(400, "attachment_not_ready")),
        }
    }
    Ok(out)
}

/// The signed address bytes move through, as an object store's would be.
fn blob_url(base_url: &str, id: &str) -> String {
    format!("{base_url}/blob/{id}?X-Signature=signed-secret")
}

/// `PUT` and `GET` of file bytes at a signed address: raw, not JSON.
async fn blob(
    mut stream: TcpStream,
    method: String,
    path: String,
    head: String,
    shared: Arc<Mutex<Shared>>,
) {
    let mut consumed = vec![0u8; head.len()];
    if stream.read_exact(&mut consumed).await.is_err() {
        return;
    }
    let length = header(&head, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if stream.read_exact(&mut body).await.is_err() {
        return;
    }
    let id = path.trim_start_matches("/blob/").to_string();
    let (status, bytes) = {
        let mut shared = shared.lock().unwrap();
        shared.requests.push(Recorded {
            received_at: std::time::Instant::now(),
            method: method.clone(),
            path: path.clone(),
            query: String::new(),
            authorization: header(&head, "authorization"),
            idempotency_key: None,
            origin: (None, None),
            body: json!({"content_type": header(&head, "content-type"), "length": length}),
        });
        match (method.as_str(), shared.world.files.get_mut(&id)) {
            ("PUT", Some(file)) => {
                file.bytes = Some(body);
                file.put_content_type = header(&head, "content-type");
                (200, Vec::new())
            }
            (
                "GET",
                Some(FakeFile {
                    bytes: Some(bytes), ..
                }),
            ) => (200, bytes.clone()),
            _ => (404, Vec::new()),
        }
    };
    let mut response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        if status == 200 { "OK" } else { "Not Found" },
        bytes.len()
    )
    .into_bytes();
    response.extend_from_slice(&bytes);
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
}

fn queue(
    world: &mut World,
    recipient: &str,
    message: &StoredMessage,
    reason: &str,
    channel_id: Option<&str>,
) -> String {
    world.next += 1;
    let id = format!("del_{}", world.next);
    let recipient_id = world
        .agents
        .get(recipient)
        .map(|a| a.id.clone())
        .unwrap_or_default();
    let mut payload = message_json(world, message, true);
    payload["channel_id"] = json!(channel_id.unwrap_or("dmch"));
    let item = json!({
        "id": id, "message_id": message.id, "channel_id": channel_id.unwrap_or("dmch"),
        "agent_id": recipient_id, "status": "queued", "reason": reason, "mode": "wait",
        "priority": "normal", "created_at": CREATED_AT, "message": payload,
    });
    world
        .deliveries
        .entry(recipient.into())
        .or_default()
        .push(QueuedDelivery {
            item,
            state: "queued".into(),
            retryable: None,
            error: None,
        });
    id
}

async fn serve(stream: TcpStream, shared: Arc<Mutex<Shared>>) {
    let head = match peek_head(&stream).await {
        Some(head) => head,
        None => return,
    };
    let first = head.lines().next().unwrap_or_default().to_string();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let lower = head.to_ascii_lowercase();
    if target.starts_with("/v1/node/ws") && lower.contains("upgrade: websocket") {
        let status = shared.lock().unwrap().behaviour.socket_status;
        if status == 101 {
            socket(stream, target, shared).await;
        } else {
            refuse_socket(stream, status).await;
        }
    } else if target.starts_with("/blob/") {
        let path = target.split('?').next().unwrap_or_default().to_string();
        blob(stream, method, path, head, shared).await;
    } else {
        http(stream, method, target, head, shared).await;
    }
}

async fn peek_head(stream: &TcpStream) -> Option<String> {
    let mut buffer = vec![0u8; 16 * 1024];
    for _ in 0..500 {
        let read = stream.peek(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        let text = String::from_utf8_lossy(&buffer[..read]).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            return Some(text[..end + 4].to_string());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    None
}

fn header(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name)
            .then(|| value.trim().to_string())
    })
}

fn ok(data: Value) -> (u16, Value) {
    (200, json!({"ok": true, "data": data}))
}

fn error(status: u16, code: &str) -> (u16, Value) {
    (
        status,
        json!({"ok": false, "error": {"code": code, "message": code}}),
    )
}

fn no_content() -> (u16, Value) {
    (204, Value::Null)
}

async fn http(
    mut stream: TcpStream,
    method: String,
    target: String,
    head: String,
    shared: Arc<Mutex<Shared>>,
) {
    let mut consumed = vec![0u8; head.len()];
    if stream.read_exact(&mut consumed).await.is_err() {
        return;
    }
    let length = header(&head, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if stream.read_exact(&mut body).await.is_err() {
        return;
    }
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let authorization = header(&head, "authorization");
    let bearer = authorization
        .as_deref()
        .and_then(|a| a.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.clone(), String::new()),
    };
    let request = format!("{method} {path}");
    let hold = {
        let mut shared = shared.lock().unwrap();
        let hold = shared.holds.get(&request).cloned();
        if hold.is_some() {
            *shared.held.entry(request.clone()).or_default() += 1;
        }
        hold
    };
    if let Some(mut hold) = hold {
        let _ = hold.wait_for(|released| *released).await;
    }
    let (status, payload) = {
        let mut shared = shared.lock().unwrap();
        shared.requests.push(Recorded {
            received_at: std::time::Instant::now(),
            method: method.clone(),
            path: path.clone(),
            query: query.clone(),
            authorization,
            idempotency_key: header(&head, "idempotency-key"),
            origin: (
                header(&head, "x-relaycast-origin-client"),
                header(&head, "x-relaycast-origin-version"),
            ),
            body: body.clone(),
        });
        route(&mut shared, &method, &path, &query, &bearer, &body)
    };
    let body = if status == 204 {
        String::new()
    } else {
        payload.to_string()
    };
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn query_value<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        pair.split_once('=')
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v)
    })
}

fn decode(segment: &str) -> String {
    url::form_urlencoded::parse(format!("x={segment}").as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}

fn route(
    shared: &mut Shared,
    method: &str,
    path: &str,
    query: &str,
    bearer: &str,
    body: &Value,
) -> (u16, Value) {
    let segments: Vec<String> = path
        .trim_start_matches('/')
        .split('/')
        .map(decode)
        .collect();
    let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
    let workspace_key = bearer == WORKSPACE_KEY;
    if let Some((status, code)) = shared.api_errors.get(&format!("{method} {path}")) {
        return error(*status, code);
    }
    // A DM can fail for one recipient only: "POST /v1/dm to=<name>".
    if let Some(to) = body["to"].as_str() {
        if let Some((status, code)) = shared.api_errors.get(&format!("{method} {path} to={to}")) {
            return error(*status, code);
        }
    }
    if shared.world.failing.iter().any(|f| {
        let request = if f.contains('?') {
            format!("{method} {path}?{query}")
        } else {
            format!("{method} {path}")
        };
        match f.strip_suffix('*') {
            Some(prefix) => request.starts_with(prefix),
            None => *f == request,
        }
    }) {
        return error(503, "unavailable");
    }
    let world = &mut shared.world;
    let caller = world.agents.values().find(|a| a.token == bearer).cloned();
    match (method, segments.as_slice()) {
        ("GET", ["v1", "workspace"]) if !bearer.starts_with("rk_") => error(401, "unauthorized"),
        ("GET", ["v1", "workspace"]) => match shared.behaviour.workspace_status {
            200 => ok(json!({
                // As the deployed server answers today: no `api_key_hash`.
                "id": "rw_fake", "name": "Fake Workspace",
                "system_prompt": null, "plan": "free", "created_at": "2026-09-01T00:00:00Z",
                "metadata": {}, "effective_retention": {}, "usage_classification": "unknown"
            })),
            status => (
                status,
                json!({"ok": false, "error": {"code": "unauthorized",
                    "message": "key rk_live_secret0000 is revoked"}}),
            ),
        },
        ("POST", ["v1", "agent", "node-token"]) if !bearer.starts_with("at_") => {
            error(401, "unauthorized")
        }
        ("POST", ["v1", "agent", "node-token"]) => match shared.behaviour.node_token_status {
            200 => {
                shared.minted += 1;
                let id = caller
                    .as_ref()
                    .map(|a| a.id.clone())
                    .unwrap_or_else(|| "agent-1".into());
                ok(json!({
                    "node_id": format!("node_direct_{id}"),
                    "node_name": shared.behaviour.node_name,
                    "token": format!("nt_live_{}", shared.minted)
                }))
            }
            status => error(status, "unauthorized"),
        },
        ("POST", ["v1", "agents"]) if workspace_key => {
            let name = body["name"].as_str().unwrap_or_default();
            if world.agents.contains_key(name) {
                return error(409, "agent_already_exists");
            }
            let prefix = body["direct_machine_prefix"].as_str().unwrap_or("direct");
            let agent = create_agent(world, name, prefix, body["metadata"].clone(), "agent");
            ok(
                json!({"id": agent.id, "name": agent.name, "token": agent.token,
                "status": "online", "created_at": CREATED_AT}),
            )
        }
        ("GET", ["v1", "agents"]) if workspace_key || caller.is_some() => {
            let wanted = query_value(query, "status").unwrap_or("all");
            let list: Vec<Value> = world
                .agents
                .values()
                .filter(|a| wanted == "all" || a.status == wanted)
                .map(Agent::record)
                .collect();
            ok(json!(list))
        }
        ("GET", ["v1", "agents", name]) if workspace_key => match world.agents.get(*name) {
            Some(agent) => ok(agent.detail(world)),
            None => error(404, "agent_not_found"),
        },
        ("GET", ["v1", "agents"]) => error(401, "agent_token_invalid"),
        ("PATCH", ["v1", "agents", name]) if workspace_key => {
            let Some(agent) = world.agents.get_mut(*name) else {
                return error(404, "agent_not_found");
            };
            // Match Relaycast: omission is an activation, not a no-op.
            agent.status = body["status"].as_str().unwrap_or("active").to_owned();
            if let (Value::Object(metadata), Value::Object(update)) =
                (&mut agent.metadata, &body["metadata"])
            {
                metadata.extend(update.clone());
            }
            ok(
                json!({"id": agent.id, "name": agent.name, "type": agent.kind,
                "status": "online", "persona": null, "metadata": agent.metadata}),
            )
        }
        ("DELETE", ["v1", "agents", name]) if workspace_key => {
            if world.undeletable.iter().any(|n| n == name) {
                return error(503, "unavailable");
            }
            match world.agents.remove(*name) {
                Some(_) => no_content(),
                None => error(404, "agent_not_found"),
            }
        }
        ("POST", ["v1", "agents", "heartbeat"]) if caller.is_some() => ok(json!({})),
        ("POST", ["v1", "agents", "heartbeat"]) => error(401, "agent_token_invalid"),
        ("POST", ["v1", "agents", name, "subscription-channel"]) if workspace_key => {
            let Some(agent) = world.agents.get(*name).cloned() else {
                return error(404, "agent_not_found");
            };
            let channel = format!("agent-events-{}", agent.id);
            let id = format!("ch_{channel}");
            world
                .channels
                .insert(channel.clone(), (id.clone(), vec![agent.name.clone()]));
            ok(json!({"id": id, "name": channel, "members": [{"agent_name": agent.name}]}))
        }
        ("POST", ["v1", "integrations", "relayfile", "inbound-target"]) if workspace_key => {
            ok(json!({
                "url": format!("https://inbound.example/inbound/rw_fake/ch_{}?path_glob=x", body["channel"].as_str().unwrap_or_default()),
                "secret": "inbound-secret",
            }))
        }
        ("GET", ["v1", "deliveries"]) => {
            let Some(agent) = caller else {
                return error(401, "unauthorized");
            };
            let items: Vec<Value> = world
                .deliveries
                .get(&agent.name)
                .into_iter()
                .flatten()
                .filter(|d| d.state == "queued")
                .map(|d| d.item.clone())
                .collect();
            ok(json!(items))
        }
        ("POST", ["v1", "deliveries", id, action]) if *action == "ack" || *action == "fail" => {
            if caller.is_none() {
                return error(401, "unauthorized");
            }
            if world.unsettleable.iter().any(|u| u == id) {
                return error(503, "unavailable");
            }
            let Some(delivery) = world
                .deliveries
                .values_mut()
                .flatten()
                .find(|d| d.item["id"] == *id)
            else {
                return error(404, "delivery_not_found");
            };
            if *action == "ack" {
                delivery.state = "acked".into();
            } else {
                delivery.state = "failed".into();
                delivery.retryable = body["retryable"].as_bool();
                delivery.error = body["error"].as_str().map(str::to_string);
            }
            delivery.item["status"] = json!(delivery.state);
            let mut item = delivery.item.clone();
            item.as_object_mut().unwrap().remove("message");
            ok(item)
        }
        ("GET", ["v1", "channels"]) => ok(json!(world
            .channels
            .iter()
            .map(|(name, (id, _))| json!({"id": id, "name": name, "created_at": CREATED_AT, "metadata": {}}))
            .collect::<Vec<_>>())),
        ("POST", ["v1", "channels"]) if caller.is_some() => {
            let name = body["name"].as_str().unwrap_or_default().to_string();
            if world.channels.contains_key(&name) {
                return error(409, "channel_exists");
            }
            let id = format!("ch_{name}");
            world
                .channels
                .insert(name.clone(), (id.clone(), vec![caller.unwrap().name]));
            ok(json!({"id": id, "name": name, "created_at": CREATED_AT, "metadata": {}}))
        }
        ("POST", ["v1", "channels", name, "join"]) if caller.is_some() => {
            let Some((_, members)) = world.channels.get_mut(*name) else {
                return error(404, "channel_not_found");
            };
            let me = caller.unwrap().name;
            if !members.contains(&me) {
                members.push(me);
            }
            ok(json!({}))
        }
        ("POST", ["v1", "channels", name, "leave"]) if caller.is_some() => {
            let Some((_, members)) = world.channels.get_mut(*name) else {
                return error(404, "channel_not_found");
            };
            let me = caller.unwrap().name;
            members.retain(|m| m != &me);
            no_content()
        }
        ("GET", ["v1", "channels", name]) => match world.channels.get(*name) {
            Some((id, members)) => ok(json!({
                "id": id, "name": name, "created_at": CREATED_AT, "metadata": {},
                "members": members.iter().map(|m| json!({"agent_id": m, "agent_name": m, "role": "member", "joined_at": CREATED_AT})).collect::<Vec<_>>(),
            })),
            None => error(404, "channel_not_found"),
        },
        ("POST", ["v1", "channels", name, "messages"]) => {
            let Some(sender) = caller else {
                return error(401, "unauthorized");
            };
            let Some((channel_id, members)) = world.channels.get(*name).cloned() else {
                return error(404, "channel_not_found");
            };
            if !members.contains(&sender.name) {
                return error(403, "not_channel_member");
            }
            let attachments = match attachments_of(world, body) {
                Ok(attachments) => attachments,
                Err(refused) => return refused,
            };
            let text = body["text"].as_str().unwrap_or_default().to_string();
            let mut message = store_message(world, &sender.name, name, &text, None);
            message.attachments = attachments;
            world.messages.last_mut().unwrap().attachments = message.attachments.clone();
            for member in members.iter().filter(|member| **member != sender.name) {
                queue(
                    world,
                    member,
                    &message,
                    "channel-message",
                    Some(&channel_id),
                );
            }
            ok(json!({
                "id": message.id,
                "agent_name": sender.name,
                "agent_id": sender.id,
                "text": text,
                "blocks": null,
                "metadata": {},
                "attachments": message.attachments,
                "created_at": message.created_at,
                "reply_count": 0,
                "reactions": [],
                "read_by_count": 0,
                "injection_mode": "wait"
            }))
        }
        ("DELETE", ["v1", "channels", name]) if workspace_key => {
            match world.channels.remove(*name) {
                Some(_) => no_content(),
                None => error(404, "channel_not_found"),
            }
        }
        ("POST", ["v1", "webhooks"]) if workspace_key => {
            world.next += 1;
            let id = format!("wh_{}", world.next);
            let channel = body["channel"].as_str().unwrap_or_default().to_string();
            let channel_id = world
                .channels
                .get(&channel)
                .map(|c| c.0.clone())
                .unwrap_or_default();
            let hook = json!({"id": id, "workspace_id": "rw_fake", "name": body["name"], "channel_id": channel_id,
                "channel_name": channel, "url": format!("https://cast.example/v1/hooks/{id}"),
                "created_at": CREATED_AT, "is_active": true});
            world.webhooks.insert(id.clone(), hook.clone());
            ok(
                json!({"webhook_id": id, "name": body["name"], "channel": channel, "url": hook["url"],
                "token": format!("wh_live_{id}"), "is_active": true, "created_at": CREATED_AT}),
            )
        }
        ("GET", ["v1", "webhooks"]) if workspace_key => {
            ok(json!(world.webhooks.values().cloned().collect::<Vec<_>>()))
        }
        ("DELETE", ["v1", "webhooks", id]) if workspace_key => match world.webhooks.remove(*id) {
            Some(_) => no_content(),
            None => error(404, "webhook_not_found"),
        },
        ("POST", ["v1", "subscriptions"]) if workspace_key => {
            if body["filter"].get("mentions").is_some_and(Value::is_null) {
                return error(400, "invalid_subscription_body");
            }
            world.next += 1;
            let id = format!("sub_{}", world.next);
            let subscription = json!({"id": id, "workspace_id": "rw_fake", "events": body["events"],
                "filter": body["filter"], "url": body["url"], "is_active": true, "created_at": CREATED_AT});
            world.subscriptions.insert(id, subscription.clone());
            ok(subscription)
        }
        ("GET", ["v1", "subscriptions"]) if workspace_key => ok(json!(world
            .subscriptions
            .values()
            .cloned()
            .collect::<Vec<_>>())),
        ("DELETE", ["v1", "subscriptions", id]) if workspace_key => {
            match world.subscriptions.remove(*id) {
                Some(_) => no_content(),
                None => error(404, "subscription_not_found"),
            }
        }
        ("POST", ["v1", "dm"]) => {
            let Some(sender) = caller else {
                return error(401, "unauthorized");
            };
            let recipient = if let Some(address) = body["address"].as_str() {
                match world
                    .agents
                    .values()
                    .find(|a| a.hosted && a.address == address)
                {
                    Some(agent) => agent.name.clone(),
                    None => return error(404, "address_not_found"),
                }
            } else {
                let to = body["to"].as_str().unwrap_or_default();
                if !world.agents.contains_key(to) {
                    return error(404, "agent_not_found");
                }
                to.to_string()
            };
            let attachments = match attachments_of(world, body) {
                Ok(attachments) => attachments,
                Err(refused) => return refused,
            };
            let text = body["text"].as_str().unwrap_or_default().to_string();
            let mut message = store_message(world, &sender.name, &recipient, &text, None);
            message.attachments = attachments;
            world.messages.last_mut().unwrap().attachments = message.attachments.clone();
            queue(world, &recipient, &message, "dm", None);
            ok(
                json!({"conversation_id": message.conversation, "to": recipient,
                "message": {"id": message.id}, "created_at": message.created_at}),
            )
        }
        ("POST", ["v1", "messages", parent, "replies"]) => {
            let Some(sender) = caller else {
                return error(401, "unauthorized");
            };
            let Some(root) = world.messages.iter().find(|m| m.id == *parent).cloned() else {
                return error(404, "message_not_found");
            };
            let recipient = if root.sender == sender.name {
                root.recipient.clone()
            } else {
                root.sender.clone()
            };
            let attachments = match attachments_of(world, body) {
                Ok(attachments) => attachments,
                Err(refused) => return refused,
            };
            let text = body["text"].as_str().unwrap_or_default().to_string();
            let mut message = store_message(
                world,
                &sender.name,
                &recipient,
                &text,
                Some(root.id.clone()),
            );
            message.attachments = attachments;
            world.messages.last_mut().unwrap().attachments = message.attachments.clone();
            queue(world, &recipient, &message, "thread-reply", None);
            ok(
                json!({"id": message.id, "agent_name": sender.name, "agent_id": sender.id,
                "text": text, "created_at": message.created_at, "metadata": {}}),
            )
        }
        ("GET", ["v1", "dm", "conversations"]) => {
            let Some(me) = caller else {
                return error(401, "unauthorized");
            };
            let mut peers: Vec<String> = world
                .messages
                .iter()
                .filter(|m| m.sender == me.name || m.recipient == me.name)
                .map(|m| {
                    if m.sender == me.name {
                        m.recipient.clone()
                    } else {
                        m.sender.clone()
                    }
                })
                .collect();
            peers.sort();
            peers.dedup();
            let list: Vec<Value> = peers
                .iter()
                .map(|peer| {
                    let peer_id = world.agents.get(peer).map(|a| a.id.clone());
                    json!({"id": conversation_id(&me.name, peer), "type": "1:1", "unread_count": 0,
                        "participants": [{"agent_id": me.id, "agent_name": me.name},
                                         {"agent_id": peer_id, "agent_name": peer}]})
                })
                .collect();
            ok(json!(list))
        }
        ("GET", ["v1", "dm", conversation, "messages"]) => {
            if caller.is_none() {
                return error(401, "unauthorized");
            }
            let limit: usize = query_value(query, "limit")
                .and_then(|l| l.parse().ok())
                .unwrap_or(50);
            let mut items: Vec<&StoredMessage> = world
                .messages
                .iter()
                .filter(|m| m.conversation == *conversation)
                .collect();
            items.reverse();
            if let Some(before) = query_value(query, "before") {
                if let Some(index) = items.iter().position(|m| m.id == before) {
                    items = items.split_off(index + 1);
                }
            }
            // The deployed DM endpoint omits thread_id.
            let list: Vec<Value> = items
                .iter()
                .take(limit)
                .map(|m| message_json(world, m, false))
                .collect();
            ok(json!(list))
        }
        ("POST", ["v1", "files", "upload"]) => {
            if caller.is_none() {
                return error(401, "unauthorized");
            }
            let (Some(filename), Some(content_type), Some(size)) = (
                body["filename"].as_str(),
                body["content_type"].as_str(),
                body["size_bytes"].as_u64(),
            ) else {
                return error(400, "invalid_upload");
            };
            world.next += 1;
            let id = format!("file_{}", world.next);
            world.files.insert(
                id.clone(),
                FakeFile {
                    id: id.clone(),
                    filename: filename.into(),
                    content_type: content_type.into(),
                    size_bytes: size,
                    status: "pending".into(),
                    bytes: None,
                    put_content_type: None,
                },
            );
            ok(
                json!({"file_id": id, "upload_url": blob_url(&shared.base_url, &id),
                "expires_at": CREATED_AT}),
            )
        }
        ("POST", ["v1", "files", id, "complete"]) => {
            if caller.is_none() {
                return error(401, "unauthorized");
            }
            match world.files.get_mut(*id) {
                Some(file)
                    if file.bytes.as_ref().map(|b| b.len() as u64) == Some(file.size_bytes) =>
                {
                    file.status = "complete".into();
                    ok(json!({"file_id": file.id, "status": "complete"}))
                }
                Some(_) => error(409, "upload_incomplete"),
                None => error(404, "file_not_found"),
            }
        }
        ("GET", ["v1", "files", id]) => {
            if caller.is_none() && !workspace_key {
                return error(401, "unauthorized");
            }
            match world.files.get(*id) {
                Some(file) => ok(json!({"file_id": file.id, "filename": file.filename,
                    "content_type": file.content_type, "size_bytes": file.size_bytes,
                    "status": file.status, "download_url": blob_url(&shared.base_url, &file.id)})),
                None => error(404, "file_not_found"),
            }
        }
        ("GET", ["v1", "messages", id]) => match world.messages.iter().find(|m| m.id == *id) {
            Some(message) => ok(message_json(world, message, true)),
            None => error(404, "message_not_found"),
        },
        // relayfile-cloud, for integrations.
        ("GET", ["v1", "workspaces", _, "integrations", "relay", "writeback-secret"]) => (
            200,
            json!({"url": "https://relayfile.example/writeback?channel=x", "secret": "writeback-secret"}),
        ),
        ("POST", ["v1", "workspaces", _, "webhooks"]) => {
            world.next += 1;
            let id = format!("rf_{}", world.next);
            let row = json!({"id": id, "url": body["url"], "pathGlobs": body["pathGlobs"]});
            world.relayfile.insert(id.clone(), row);
            (200, json!({"subscriptionId": id}))
        }
        ("GET", ["v1", "workspaces", _, "webhooks"]) => (
            200,
            json!({"subscriptions": world.relayfile.values().cloned().collect::<Vec<_>>()}),
        ),
        ("DELETE", ["v1", "workspaces", _, "webhooks", id]) => match world.relayfile.remove(*id) {
            Some(_) => (200, json!({})),
            None => (404, json!({"error": "not found"})),
        },
        _ => error(404, "not_found"),
    }
}

async fn refuse_socket(mut stream: TcpStream, status: u16) {
    let response =
        format!("HTTP/1.1 {status} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn socket(stream: TcpStream, target: String, shared: Arc<Mutex<Shared>>) {
    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (commands, mut command_rx) = mpsc::unbounded_channel();
    {
        let mut shared = shared.lock().unwrap();
        shared.sockets.push(commands);
        shared.socket_queries.push(target);
    }
    loop {
        tokio::select! {
            command = command_rx.recv() => match command {
                Some(SocketCommand::Send(frame)) => {
                    if socket.send(Message::Text(frame.to_string())).await.is_err() {
                        return;
                    }
                }
                Some(SocketCommand::Close) | None => {
                    let _ = socket.close(None).await;
                    return;
                }
            },
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    let (reply, stall) = {
                        let mut shared = shared.lock().unwrap();
                        shared.frames.push(frame.clone());
                        let register = frame["type"] == "node.register";
                        (
                            if register && shared.behaviour.reply_to_register {
                                Some(json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true}))
                            } else if frame["type"] == "node.heartbeat" && shared.behaviour.acknowledge_presence {
                                Some(json!({"v": 1, "id": frame["id"], "type": "reply", "ok": true,
                                    "data": {"agent_presence": true, "agent_id": frame["node_id"].as_str().unwrap().trim_start_matches("node_direct_")}}))
                            } else { None },
                            register && shared.behaviour.stall_after_register,
                        )
                    };
                    if let Some(reply) = reply {
                        if socket.send(Message::Text(reply.to_string())).await.is_err() {
                            return;
                        }
                    }
                    if stall {
                        // Holds the socket open without ever reading it.
                        std::future::pending::<()>().await;
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
        }
    }
}
