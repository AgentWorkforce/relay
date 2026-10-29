//! This computer's spawn node: one Relaycast node socket, enrolled with the
//! workspace key as a broker-role node, that offers `spawn:<harness>` and
//! `release` capacity and hosts the agents it starts.
//!
//! The node is enrolled once and its id and token are kept in the app data
//! directory (`spawn-node.json`, 0600), so it is the same node across
//! restarts. A token Relaycast stops accepting is rotated with the current
//! one as proof, always under the same id, so the agents spawned on the
//! node stay bound to it (`rotate`). A name another node holds (another
//! computer of the same name in the workspace, or this computer's own node
//! from an install whose `spawn-node.json` is gone) is never retried: the
//! node is enrolled as `<name>-<4 hex>` instead, saved with it so every
//! restart uses that name (`enroll_named`).
//!
//! Requests the core makes on the socket (`agent.register`) are answered by
//! id. Actions run as their own tasks, so a slow launch never holds up the
//! heartbeat, and their results are kept until Relaycast took them, across
//! connections and restarts (`control_retry::Results`). A `deliver` frame
//! only wakes the agent's delivery: messages are read and acknowledged over
//! HTTP with the agent's own token, as every other agent's are.

mod control_retry;
mod enroll;
mod enrollment;
pub(crate) use control_retry::Asked;
pub(crate) use control_retry::Results;
pub(crate) use control_retry::KEEP as RESULT_KEEP;
#[cfg(test)]
use enroll::ALTERNATES;
use enroll::{enroll_named, rotate, saved, Refused};
pub(crate) use enrollment::enrolled_name;
#[cfg(test)]
use enrollment::{alternate, fingerprint, node_file, read, save};
use enrollment::{load, Enrollment};

use super::wire::{self, Advertisement, HarnessId, InventoryAgent, Invoke, NodeIdentity};
use crate::relay::push::{backoff, random_jitter};
use crate::relay::sdk_gaps;
use crate::relay::state::{SpawnState, SpawnStatus};
use crate::relay::store::random_uuid;
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use futures_util::SinkExt;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch, Notify};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};

pub const NODE_FILE: &str = "spawn-node.json";

/// Relaycast calls a node live within 45 s of its last heartbeat.
const HEARTBEAT: Duration = Duration::from_secs(12);
/// An agent missing from an inventory is marked offline.
const INVENTORY: Duration = Duration::from_secs(60);
const REGISTER_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// How often the node's claim is checked (`NodeHost::claim`).
const CLAIM_CHECK: Duration = Duration::from_secs(60);

/// What a node is started with; a change starts a new one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeConfig {
    pub base_url: String,
    pub workspace_key: Secret,
    /// The name Cloud lists as the spawn target, and the machine half of
    /// every spawned agent's address, unless another node held it when this
    /// one enrolled: the node then has an alternate of it (`NodeInfo`).
    pub node_name: String,
    pub version: String,
    pub app_data_dir: PathBuf,
    pub harnesses: Vec<HarnessId>,
    /// Owner/name keys sent as `repo_keys`, which Relaycast reads only at
    /// `node.register`: a change reconnects the node. Everything else the
    /// node advertises is read again for each heartbeat.
    pub repositories: Vec<String>,
}

/// The node as Relaycast enrolled it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeInfo {
    pub node_id: String,
    pub node_name: String,
}

/// What the node needs from the core.
pub trait NodeHost: Send + Sync + 'static {
    /// Answers one action with its `action.result` frame.
    fn invoke(&self, link: NodeLink, invoke: Invoke) -> BoxFuture<'static, Value>;
    /// The agents this node hosts that run now.
    fn inventory(&self, node: &NodeInfo) -> Vec<InventoryAgent>;
    /// A `deliver` frame for one of them.
    fn deliver(&self, agent: &str, frame: Value);
    fn state(&self, status: SpawnStatus);
    /// What to advertise in the next frame: the configured facts and the
    /// live ones measured now.
    fn advertisement(&self, harnesses: &[HarnessId], repositories: &[String]) -> Advertisement;
    /// A heartbeat was written: evidence the node reaches Agent Relay.
    fn heartbeat_sent(&self);
    /// Notified when places change, for an inventory and a heartbeat at
    /// once rather than at the next tick.
    fn changed(&self) -> Arc<Notify>;
    /// The node is registered on `link`. The connection is serviced while
    /// this runs (heartbeats, replies to requests sent on `link`); actions
    /// and deliveries wait for it, and its first inventory follows it.
    fn connected(&self, _link: NodeLink) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
    /// The node is about to register with `token`: claim it for the
    /// signed-in person if it is not yet. Also called every minute while
    /// connected.
    fn claim(&self, _node: &NodeInfo, _token: &Secret) {}
    /// Notified when the claim should be checked at once (a sign-in).
    fn claim_now(&self) -> Arc<Notify> {
        Arc::default()
    }
    /// Relaycast refused something the node sent; `message` says what.
    fn refused(&self, _message: String) {}
    /// `frame` was written to Relaycast. An agent kept listed until its
    /// release result is sent stops being listed after it.
    fn sent(&self, _frame: &Value) {}
}

/// The live socket, as an action sees it: frames to send, and requests
/// answered by id.
#[derive(Clone)]
pub struct NodeLink {
    pub node: NodeInfo,
    /// This connection's Relaycast takes `error_details` on `action.result`
    /// (its register reply named `wire::ERROR_DETAILS_CAPABILITY` as the
    /// contract); learned again on every connection.
    pub error_details: bool,
    outgoing: mpsc::UnboundedSender<Value>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    results: Arc<Mutex<Results>>,
}

/// Ends the requests still waiting on a connection once it closes: their
/// answers could only come on its socket, so each waiter learns at once
/// (`Asked::Closed`) instead of waiting out its time while the actions
/// holding the link keep its waits alive.
struct EndsWaits(Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>);

impl Drop for EndsWaits {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

impl NodeLink {
    /// The requests waiting for their answer. A lock poisoned by a panic
    /// elsewhere still gives them: each change to them is whole.
    fn pending(&self) -> MutexGuard<'_, HashMap<String, oneshot::Sender<Value>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A link to no socket, and the frames sent on it.
    #[cfg(test)]
    pub(crate) fn detached(node: NodeInfo) -> (NodeLink, mpsc::UnboundedReceiver<Value>) {
        let (outgoing, sent) = mpsc::unbounded_channel();
        let link = NodeLink {
            node,
            error_details: false,
            outgoing,
            pending: Arc::default(),
            results: Arc::default(),
        };
        (link, sent)
    }

    /// Hands a frame to the request waiting for it; false when none is.
    pub(crate) fn answer(&self, frame: &Value) -> bool {
        let Some(id) = frame["id"].as_str() else {
            return false;
        };
        let waiting = self.pending().remove(id);
        match waiting {
            Some(sender) => {
                let _ = sender.send(frame.clone());
                true
            }
            None => false,
        }
    }
}

/// A running node; stopping it closes the socket.
pub struct SpawnNode {
    config: NodeConfig,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl SpawnNode {
    pub fn start(config: NodeConfig, host: Arc<dyn NodeHost>) -> SpawnNode {
        SpawnNode::start_with(config, host, Arc::default())
    }

    /// Starts the node; `results` holds the results still owed, kept across
    /// nodes so a restarted one sends them too.
    pub(crate) fn start_with(
        config: NodeConfig,
        host: Arc<dyn NodeHost>,
        results: Arc<Mutex<Results>>,
    ) -> SpawnNode {
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(run(config.clone(), host, stopped, results));
        SpawnNode { config, stop, task }
    }

    pub fn config(&self) -> &NodeConfig {
        &self.config
    }

    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let _ = self.task.await;
    }
}

enum Ended {
    Stopped,
    Closed(String),
    /// Trying again cannot help: the node stops and says why.
    GaveUp(String),
}

async fn run(
    config: NodeConfig,
    host: Arc<dyn NodeHost>,
    mut stopped: watch::Receiver<bool>,
    results: Arc<Mutex<Results>>,
) {
    // The name the node is enrolled under, once it is: an alternate of the
    // configured one when another node holds that.
    let status = |state: SpawnState, error: Option<String>| SpawnStatus {
        state,
        node_name: Some(load(&config).map_or_else(|| config.node_name.clone(), |e| e.node_name)),
        harnesses: config
            .harnesses
            .iter()
            .map(|h| h.name().to_string())
            .collect(),
        error,
        slots: None,
        // The host adds what it knows of every harness.
        harness_descriptors: None,
        claim: None,
    };
    let mut attempt = 0u32;
    loop {
        host.state(status(SpawnState::Connecting, None));
        let reason = match connect_once(
            &config,
            host.as_ref(),
            &mut stopped,
            &mut attempt,
            results.clone(),
        )
        .await
        {
            Ended::Stopped => break,
            Ended::Closed(reason) => reason,
            Ended::GaveUp(reason) => {
                host.state(status(SpawnState::Off, Some(reason)));
                let _ = stopped.changed().await;
                break;
            }
        };
        if *stopped.borrow() {
            break;
        }
        attempt += 1;
        let delay = Duration::from_secs_f64(backoff(attempt, random_jitter()));
        host.state(status(SpawnState::Waiting, Some(reason)));
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = stopped.changed() => break,
        }
    }
    host.state(SpawnStatus::default());
}

async fn open(
    config: &NodeConfig,
    enrollment: &Enrollment,
) -> Result<sdk_gaps::NodeSocket, tungstenite::Error> {
    let url = sdk_gaps::broker_node_socket_url(&config.base_url, &config.version);
    let mut request = url.into_client_request()?;
    let bearer = format!("Bearer {}", enrollment.token.expose())
        .parse()
        .map_err(|_| tungstenite::Error::Url(tungstenite::error::UrlError::NoHostName))?;
    request.headers_mut().insert("Authorization", bearer);
    match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request)).await {
        Ok(connected) => connected.map(|(socket, _)| socket),
        Err(_) => Err(tungstenite::Error::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "no answer in time",
        ))),
    }
}

fn rejected(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Http(response)
        if matches!(response.status().as_u16(), 401 | 403))
}

async fn connect_once(
    config: &NodeConfig,
    host: &dyn NodeHost,
    stopped: &mut watch::Receiver<bool>,
    attempt: &mut u32,
    results: Arc<Mutex<Results>>,
) -> Ended {
    let enrollment = match saved(config).await {
        Ok(Some(enrollment)) => enrollment,
        Ok(None) => match enroll_named(config, None).await {
            Ok(enrollment) => enrollment,
            Err(Refused::NoName(reason)) => return Ended::GaveUp(reason),
            Err(refused) => return Ended::Closed(refused.reason()),
        },
        Err(reason) => return Ended::Closed(reason),
    };
    let mut socket = match open(config, &enrollment).await {
        Ok(socket) => socket,
        Err(error) if rejected(&error) => {
            let refused = "Agent Relay refused this computer's spawn node.";
            return match rotate(config, &enrollment).await {
                Ok(_) => Ended::Closed(refused.into()),
                Err(Refused::NoName(reason)) => Ended::GaveUp(format!("{refused} {reason}")),
                Err(reason) => Ended::Closed(format!("{refused} {}", reason.reason())),
            };
        }
        Err(error) => return Ended::Closed(format!("Could not reach Agent Relay: {error}")),
    };
    let node = NodeInfo {
        node_id: enrollment.node_id.clone(),
        node_name: enrollment.node_name.clone(),
    };
    // Before the registration's capabilities: a node another account owns
    // never advertises spawns, even for a moment after a restart.
    host.claim(&node, &enrollment.token);
    let identity = NodeIdentity {
        node_id: enrollment.node_id.clone(),
        name: enrollment.node_name.clone(),
        instance_id: format!("broker_{}", random_uuid()),
        version: config.version.clone(),
    };
    let advertise = || host.advertisement(&config.harnesses, &config.repositories);
    let register_id = format!("node_register_{}", random_uuid());
    if sdk_gaps::send_frame(&mut socket, &identity.register(&register_id, &advertise()))
        .await
        .is_err()
    {
        return Ended::Closed("Agent Relay closed the spawn node's connection.".into());
    }
    let registered = tokio::time::timeout(REGISTER_TIMEOUT, async {
        loop {
            match sdk_gaps::next_frame(&mut socket).await {
                Some(Ok(frame)) => {
                    if let Some(answer) = wire::reply_to(&frame, &register_id) {
                        return answer
                            .map(wire::error_details_agreed)
                            .map_err(|refusal| refusal.message);
                    }
                }
                _ => return Err("Agent Relay closed the spawn node's connection.".to_string()),
            }
        }
    });
    let error_details = tokio::select! {
        result = registered => match result {
            Ok(Ok(error_details)) => error_details,
            Ok(Err(reason)) => return Ended::Closed(reason),
            Err(_) => return Ended::Closed("Agent Relay did not accept the spawn node in time.".into()),
        },
        _ = stopped.changed() => return Ended::Stopped,
    };
    *attempt = 0;
    host.state(SpawnStatus {
        state: SpawnState::Live,
        node_name: Some(node.node_name.clone()),
        harnesses: config
            .harnesses
            .iter()
            .map(|h| h.name().to_string())
            .collect(),
        error: None,
        slots: None,
        harness_descriptors: None,
        claim: None,
    });
    let (outgoing, mut queued) = mpsc::unbounded_channel();
    let link = NodeLink {
        node: node.clone(),
        error_details,
        outgoing,
        pending: Arc::default(),
        results,
    };
    let _ends_waits = EndsWaits(link.pending.clone());
    // What the last connection did not see Relaycast take.
    let retained = link.retained_results();
    note_refusals(host, &link);
    for frame in retained {
        if sdk_gaps::send_frame(&mut socket, &frame).await.is_err() {
            return Ended::Closed(
                "Agent Relay closed the spawn node while settling results.".into(),
            );
        }
        link.result_resent(&frame);
        host.sent(&frame);
    }
    // Recovery can take a minute (a Muse or Devin launch it waits for), past
    // the node's liveness window: the connection is serviced meanwhile
    // (heartbeats, replies to its requests), while actions and deliveries
    // wait for it, as they did unread before, and the first inventory
    // follows it, complete.
    let mut recovery = host.connected(link.clone());
    let mut recovered = false;
    let mut held: Vec<Value> = Vec::new();
    let inventory = |host: &dyn NodeHost| {
        wire::inventory_sync(
            &format!("inventory_sync_{}", random_uuid()),
            &host.inventory(&node),
        )
    };
    let mut beats = tokio::time::interval(HEARTBEAT);
    beats.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut inventories = tokio::time::interval(INVENTORY);
    inventories.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    inventories.tick().await;
    let mut claims = tokio::time::interval(CLAIM_CHECK);
    claims.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    claims.tick().await;
    let closed = || Ended::Closed("Agent Relay closed the spawn node's connection.".into());
    let changed = host.changed();
    let mut result_retries = tokio::time::interval(Duration::from_millis(100));
    result_retries.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let claim_now = host.claim_now();
    loop {
        tokio::select! {
            _ = stopped.changed() => {
                let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await;
                return Ended::Stopped;
            }
            _ = beats.tick() => {
                let heartbeat = identity.heartbeat(&advertise());
                if sdk_gaps::send_frame(&mut socket, &heartbeat).await.is_err()
                    || socket.send(Message::Ping(Vec::new())).await.is_err()
                {
                    return closed();
                }
                host.heartbeat_sent();
            }
            _ = &mut recovery, if !recovered => {
                recovered = true;
                if sdk_gaps::send_frame(&mut socket, &inventory(host)).await.is_err() {
                    return closed();
                }
                for frame in held.drain(..) {
                    dispatch(host, &link, frame);
                }
            }
            _ = changed.notified() => {
                // Places changed: Relaycast learns at once, not at the next
                // tick (once recovery has sent the first inventory).
                if (recovered
                    && sdk_gaps::send_frame(&mut socket, &inventory(host)).await.is_err())
                    || sdk_gaps::send_frame(&mut socket, &identity.heartbeat(&advertise()))
                        .await
                        .is_err()
                {
                    return closed();
                }
                host.heartbeat_sent();
            }
            _ = claims.tick() => host.claim(&node, &enrollment.token),
            _ = claim_now.notified() => host.claim(&node, &enrollment.token),
            _ = inventories.tick(), if recovered => {
                if sdk_gaps::send_frame(&mut socket, &inventory(host)).await.is_err() {
                    return closed();
                }
            }
            _ = result_retries.tick() => {
                for frame in link.due_results() {
                    if sdk_gaps::send_frame(&mut socket, &frame).await.is_err() { return closed(); }
                    link.result_resent(&frame);
                    host.sent(&frame);
                }
            }
            Some(frame) = queued.recv() => {
                if sdk_gaps::send_frame(&mut socket, &frame).await.is_err() {
                    return closed();
                }
                host.sent(&frame);
            }
            frame = sdk_gaps::next_frame(&mut socket) => {
                let Some(Ok(frame)) = frame else {
                    return closed();
                };
                if link.answer(&frame) {
                    continue;
                }
                if link.result_reply(&frame) {
                    note_refusals(host, &link);
                    continue;
                }
                if recovered {
                    dispatch(host, &link, frame);
                } else {
                    held.push(frame);
                }
            }
        }
    }
}

/// Notes in the activity log what Relaycast refused.
fn note_refusals(host: &dyn NodeHost, link: &NodeLink) {
    for note in link.result_notes() {
        host.refused(note);
    }
}

/// Hands one frame Relaycast sent to the core: a delivery to its agent, an
/// action to answer on the link.
fn dispatch(host: &dyn NodeHost, link: &NodeLink, frame: Value) {
    if let Some(agent) = wire::delivery_agent(&frame) {
        host.deliver(agent, frame.clone());
        return;
    }
    match wire::invoke(&frame) {
        Some(Ok(Invoke::Other { invocation_id })) => {
            link.send(wire::action_error(&invocation_id, "handler_unavailable"));
        }
        Some(Ok(invoke)) => {
            let answer = host.invoke(link.clone(), invoke);
            let link = link.clone();
            tokio::spawn(async move {
                link.send(answer.await);
            });
        }
        Some(Err((invocation_id, error))) => {
            link.send(wire::action_error(&invocation_id, &error));
        }
        None => {}
    }
}

#[cfg(test)]
mod name_tests;
#[cfg(test)]
mod recovery_tests;
#[cfg(test)]
mod results_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::harness::codex;
    use std::path::Path;

    fn config(directory: &Path) -> NodeConfig {
        NodeConfig {
            base_url: "https://cast.example".into(),
            workspace_key: Secret::new("rk_live_one".to_string()),
            node_name: "mac-desktop".into(),
            version: "1.0.0".into(),
            app_data_dir: directory.to_path_buf(),
            harnesses: vec![codex::ID],
            repositories: Vec::new(),
        }
    }

    #[test]
    fn an_enrollment_is_reused_only_for_the_same_workspace_origin_and_name() {
        let folder = tempfile::tempdir().unwrap();
        let config = config(folder.path());
        let enrollment = Enrollment {
            node_id: "node_desktop_1".into(),
            node_name: "mac-desktop".into(),
            token: Secret::new("nt_live_x".to_string()),
            base_url: config.base_url.clone(),
            workspace: fingerprint(&config.workspace_key),
            rotation_key: None,
        };
        save(&node_file(&config), &enrollment).unwrap();
        assert_eq!(load(&config), Some(enrollment));
        // Windows has no mode bits; the private folder's access list applies.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(node_file(&config))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let other_key = NodeConfig {
            workspace_key: Secret::new("rk_live_two".to_string()),
            ..config.clone()
        };
        assert_eq!(load(&other_key), None);
        let other_name = NodeConfig {
            node_name: "other".into(),
            ..config
        };
        assert_eq!(load(&other_name), None);
    }

    /// Answers one `GET` with `status` and `body`; returns the request.
    fn answering_relaycast(
        status: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n") {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (base_url, server)
    }

    /// `mac-desktop` saved with `rk_live_one`, read with `rk_live_two`.
    fn saved_under_an_old_key(base_url: String, folder: &Path) -> (NodeConfig, Enrollment) {
        let old = NodeConfig {
            base_url,
            ..config(folder)
        };
        let enrollment = Enrollment {
            node_id: "node_desktop_1".into(),
            node_name: "mac-desktop".into(),
            token: Secret::new("nt_live_x".to_string()),
            base_url: old.base_url.clone(),
            workspace: fingerprint(&old.workspace_key),
            rotation_key: None,
        };
        save(&node_file(&old), &enrollment).unwrap();
        let current = NodeConfig {
            workspace_key: Secret::new("rk_live_two".to_string()),
            ..old
        };
        (current, enrollment)
    }

    #[tokio::test]
    async fn a_new_workspace_key_keeps_the_node_relaycast_lists_under_its_name() {
        let folder = tempfile::tempdir().unwrap();
        let (base_url, server) = answering_relaycast(
            "200 OK",
            r#"{"ok":true,"data":{"id":"node_desktop_1","name":"mac-desktop"}}"#,
        );
        let (config, enrollment) = saved_under_an_old_key(base_url, folder.path());
        let kept = saved(&config).await.unwrap().expect("the node is kept");
        assert_eq!(kept.node_id, enrollment.node_id);
        assert_eq!(kept.token, enrollment.token);
        // Recorded under the new key, so the next start asks nothing.
        assert_eq!(load(&config), Some(kept));
        let request = server.join().unwrap();
        assert!(
            request.starts_with("GET /v1/nodes/mac-desktop "),
            "{request}"
        );
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer rk_live_two"));
    }

    #[tokio::test]
    async fn a_name_held_by_another_node_is_not_this_computers_node() {
        let folder = tempfile::tempdir().unwrap();
        let (base_url, server) = answering_relaycast(
            "200 OK",
            r#"{"ok":true,"data":{"id":"node_desktop_2","name":"mac-desktop"}}"#,
        );
        let (config, _) = saved_under_an_old_key(base_url, folder.path());
        assert_eq!(saved(&config).await, Ok(None));
        assert_eq!(load(&config), None);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn a_name_no_node_holds_enrolls_a_new_node() {
        let folder = tempfile::tempdir().unwrap();
        let (base_url, server) = answering_relaycast(
            "404 Not Found",
            r#"{"ok":false,"error":{"code":"node_not_found","message":"Node not found"}}"#,
        );
        let (config, _) = saved_under_an_old_key(base_url, folder.path());
        assert_eq!(saved(&config).await, Ok(None));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn an_unanswered_check_keeps_the_saved_node_for_the_next_attempt() {
        let folder = tempfile::tempdir().unwrap();
        let (base_url, server) = answering_relaycast(
            "503 Service Unavailable",
            r#"{"ok":false,"error":{"code":"unavailable","message":"try later"}}"#,
        );
        let (config, enrollment) = saved_under_an_old_key(base_url, folder.path());
        assert!(saved(&config).await.is_err());
        assert_eq!(read(&config), Some(enrollment));
        server.join().unwrap();
    }

    /// Answers `count` requests with Relaycast's refusal of a rotation whose
    /// token proof is not the node's current one; returns each request.
    fn refusing_relaycast(count: usize) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            (0..count)
                .map(|_| {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = Vec::new();
                    let mut buffer = [0_u8; 4096];
                    while !String::from_utf8_lossy(&request).contains("\r\n\r\n{") {
                        let read = stream.read(&mut buffer).unwrap();
                        if read == 0 {
                            break;
                        }
                        request.extend_from_slice(&buffer[..read]);
                    }
                    let body = r#"{"ok":false,"error":{"code":"node_token_proof_required","message":"Node token changed before enrollment completed; retry with the current node token"}}"#;
                    write!(
                        stream,
                        "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                    String::from_utf8_lossy(&request).to_lowercase()
                })
                .collect()
        });
        (base_url, server)
    }

    fn idempotency_key(request: &str) -> Option<String> {
        request
            .lines()
            .find_map(|line| line.strip_prefix("idempotency-key: "))
            .map(|key| key.trim().to_string())
    }

    #[tokio::test]
    async fn a_refused_rotation_keeps_the_node_and_retries_with_the_same_key() {
        let folder = tempfile::tempdir().unwrap();
        let (base_url, server) = refusing_relaycast(2);
        let config = NodeConfig {
            base_url,
            ..config(folder.path())
        };
        let enrollment = Enrollment {
            node_id: "node_desktop_1".into(),
            node_name: "mac-desktop".into(),
            token: Secret::new("nt_live_x".to_string()),
            base_url: config.base_url.clone(),
            workspace: fingerprint(&config.workspace_key),
            rotation_key: None,
        };
        save(&node_file(&config), &enrollment).unwrap();
        assert!(rotate(&config, &enrollment).await.is_err());
        // Still this computer's node: its agents stay on it.
        let kept = load(&config).expect("the node is kept");
        assert_eq!(kept.node_id, enrollment.node_id);
        assert_eq!(kept.token, enrollment.token);
        assert!(rotate(&config, &kept).await.is_err());
        let requests = server.join().unwrap();
        let keys: Vec<Option<String>> = requests.iter().map(|r| idempotency_key(r)).collect();
        // The same key both times, so a rotation whose answer was lost is
        // recovered by Relaycast's replay rather than refused.
        assert!(
            keys[0].as_ref().is_some_and(|key| key.len() >= 32),
            "{keys:?}"
        );
        assert_eq!(keys[0], keys[1]);
        assert!(requests[0].contains("x-relaycast-node-token: nt_live_x"));
        assert!(requests[0].contains("\"node_id\":\"node_desktop_1\""));
        assert_eq!(load(&config).unwrap().node_id, "node_desktop_1");
    }

    #[tokio::test]
    async fn a_request_is_answered_by_the_frame_with_its_id() {
        let (outgoing, mut sent) = mpsc::unbounded_channel();
        let link = NodeLink {
            node: NodeInfo {
                node_id: "n".into(),
                node_name: "mac".into(),
            },
            error_details: false,
            outgoing,
            pending: Arc::default(),
            results: Arc::default(),
        };
        let answering = link.clone();
        let waiter = tokio::spawn(async move {
            answering
                .request(
                    "r1",
                    serde_json::json!({"id": "r1"}),
                    Duration::from_secs(5),
                )
                .await
        });
        assert_eq!(sent.recv().await.unwrap()["id"], "r1");
        assert!(!link.answer(&serde_json::json!({"id": "other"})));
        assert!(link.answer(&serde_json::json!({"id": "r1", "type": "reply", "ok": true})));
        assert_eq!(waiter.await.unwrap().unwrap()["ok"], true);
    }
}
