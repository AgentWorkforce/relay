//! An in-process fake of the relay core's bridge socket
//! (`docs/relay-core.md`), for the Linux app's tests.
//!
//! Tests start a [`FakeCore`] on a temporary socket, answer the methods they
//! need with [`FakeCore::answer`] and push events with [`FakeCore::emit`].
//! `agent-relay-fake-core` (`src/bin`) runs one in place of
//! `agent-relay-probe relay serve`, serving a signed-out core until its stdin
//! closes, so a test can host it as the app hosts the real core.

use crate::relay::protocol::{ErrorKind, RpcError, BRIDGE_VERSION, EVENT_METHOD};
use crate::relay::transport::{CoreListener, CoreStream, CoreWriteHalf};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

/// A signed-out core's status snapshot, with `account` fields replaced by
/// `account`'s.
pub fn snapshot(account: Value) -> Value {
    let mut state = json!({
        "revision": 1,
        "daemon": {"version": "0.0.0-fake", "bridge_version": BRIDGE_VERSION,
                   "pid": std::process::id(), "started_at_ms": 0, "socket": ""},
        "machine": {"host_name": "test.local", "machine_prefix": "test"},
        "workspace": {"state": "missing", "source": null, "base_url": null, "workspace_id": null,
                      "workspace_name": null, "verification": "pending", "checked_at_ms": null},
        "push": {},
        "agents": {"store_error": null, "delivery_error": null},
        "account": {"state": "signed_out", "phase": null, "error": null, "action": null,
                    "reused_login": null, "site_url": "https://agentrelay.com", "workspace_id": null,
                    "workspace_name": null, "person": null,
                    "progress": null},
    });
    if let (Some(base), Value::Object(changes)) = (state["account"].as_object_mut(), account) {
        base.extend(changes);
    }
    state
}

/// A signed-in core's status snapshot.
pub fn signed_in() -> Value {
    snapshot(json!({
        "state": "signed_in",
        "workspace_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
        "workspace_name": "Acme",
        "person": {"id": "user_1", "name": "Ada", "email": "ada@example.com", "avatar_url": null},
    }))
}

type Reply = Pin<Box<dyn Future<Output = Result<Value, RpcError>> + Send>>;

/// How the fake answers one method.
#[derive(Clone)]
pub enum Answer {
    Value(Value),
    Fail(RpcError),
    With(Arc<dyn Fn(Value) -> Reply + Send + Sync>),
}

impl Answer {
    /// An answer computed from the parameters, possibly slowly.
    pub fn with<F, Fut>(handler: F) -> Answer
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, RpcError>> + Send + 'static,
    {
        Answer::With(Arc::new(move |params| Box::pin(handler(params))))
    }

    pub fn fail(kind: ErrorKind, message: &str) -> Answer {
        Answer::Fail(RpcError::new(kind, message))
    }
}

impl From<Value> for Answer {
    fn from(value: Value) -> Answer {
        Answer::Value(value)
    }
}

struct Subscriber {
    connection: u64,
    writer: Arc<tokio::sync::Mutex<CoreWriteHalf>>,
    topics: BTreeSet<String>,
}

struct Shared {
    state: Value,
    answers: HashMap<String, Answer>,
    topics: Vec<String>,
    calls: Vec<(String, Value)>,
    subscribers: Vec<Subscriber>,
    seq: u64,
    /// The bridge version `hello` accepts.
    bridge_version: u32,
    /// The bridge version an accepted `hello` reports, when not the one it
    /// accepts.
    reported_bridge_version: Option<u32>,
    /// Events written to the next subscriber ahead of its `subscribe` answer.
    before_subscribed: Vec<(String, Value)>,
    /// A file each recorded call's method is appended to.
    log: Option<PathBuf>,
}

/// The fake core. Dropping it does not stop it; [`FakeCore::stop`] does.
#[derive(Clone)]
pub struct FakeCore {
    path: PathBuf,
    shared: Arc<Mutex<Shared>>,
    stopped: watch::Sender<bool>,
}

impl FakeCore {
    /// Serves at `path` on the current tokio runtime.
    pub fn start(path: &Path) -> std::io::Result<FakeCore> {
        FakeCore::with_state(path, snapshot(json!({})))
    }

    pub fn with_state(path: &Path, state: Value) -> std::io::Result<FakeCore> {
        let listener = CoreListener::bind(path)?;
        let core = FakeCore {
            path: path.to_path_buf(),
            shared: Arc::new(Mutex::new(Shared {
                state,
                answers: HashMap::new(),
                topics: [
                    "status",
                    "activity",
                    "shutdown",
                    "invalidated",
                    "notify",
                    "sign_in",
                ]
                .map(String::from)
                .to_vec(),
                calls: Vec::new(),
                subscribers: Vec::new(),
                seq: 0,
                log: None,
                bridge_version: BRIDGE_VERSION,
                reported_bridge_version: None,
                before_subscribed: Vec::new(),
            })),
            stopped: watch::channel(false).0,
        };
        tokio::spawn(core.clone().accept(listener));
        Ok(core)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Answers `method` from now on.
    pub fn answer(&self, method: &str, answer: impl Into<Answer>) {
        self.shared
            .lock()
            .unwrap()
            .answers
            .insert(method.to_string(), answer.into());
    }

    /// Appends each recorded call's method to `path`, one per line.
    pub fn log_calls_to(&self, path: PathBuf) {
        self.shared.lock().unwrap().log = Some(path);
    }

    /// Speaks `version` from now on, as a core of another release would.
    pub fn speak_bridge_version(&self, version: u32) {
        self.shared.lock().unwrap().bridge_version = version;
    }

    /// Accepts any `hello` and reports `version`, as a core that disagrees
    /// with itself would.
    pub fn report_bridge_version(&self, version: u32) {
        self.shared.lock().unwrap().reported_bridge_version = Some(version);
    }

    /// Writes an event on `topic` to the next subscriber before answering
    /// its `subscribe`, as the core may once the subscription is in place.
    pub fn emit_before_subscribed(&self, topic: &str, data: Value) {
        self.shared
            .lock()
            .unwrap()
            .before_subscribed
            .push((topic.to_string(), data));
    }

    /// Adds a topic `hello` advertises.
    pub fn advertise_topic(&self, topic: &str) {
        self.shared.lock().unwrap().topics.push(topic.to_string());
    }

    /// Replaces the snapshot without telling subscribers.
    pub fn replace_state(&self, state: Value) {
        self.shared.lock().unwrap().state = state;
    }

    pub fn state(&self) -> Value {
        self.shared.lock().unwrap().state.clone()
    }

    /// Replaces the snapshot with a newer revision and publishes it.
    pub async fn set_state(&self, mut state: Value) {
        {
            let mut shared = self.shared.lock().unwrap();
            state["revision"] = json!(shared.state["revision"].as_u64().unwrap_or(0) + 1);
            shared.state = state.clone();
        }
        self.emit("status", state).await;
    }

    /// Sends an event to every connection subscribed to `topic`
    /// (`shutdown` reaches every subscriber).
    pub async fn emit(&self, topic: &str, data: Value) {
        let (line, targets) = {
            let mut shared = self.shared.lock().unwrap();
            shared.seq += 1;
            let line = json!({"jsonrpc": "2.0", "method": EVENT_METHOD,
                              "params": {"topic": topic, "seq": shared.seq, "data": data}});
            let targets: Vec<_> = shared
                .subscribers
                .iter()
                .filter(|s| topic == "shutdown" || s.topics.contains(topic))
                .map(|s| s.writer.clone())
                .collect();
            (format!("{line}\n"), targets)
        };
        for target in targets {
            let _ = target.lock().await.write_all(line.as_bytes()).await;
        }
    }

    /// Every call's parameters to `method`, in order (`hello` and
    /// `daemon.shutdown` are not recorded).
    pub fn called(&self, method: &str) -> Vec<Value> {
        self.shared
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|(name, _)| name == method)
            .map(|(_, params)| params.clone())
            .collect()
    }

    pub fn is_stopped(&self) -> bool {
        *self.stopped.borrow()
    }

    /// Resolves once the fake stops.
    pub async fn stopped(&self) {
        let mut stopped = self.stopped.subscribe();
        let _ = stopped.wait_for(|stopped| *stopped).await;
    }

    /// Sends `shutdown`, closes every connection and removes the socket.
    pub async fn stop(&self) {
        if self.stopped.send_replace(true) {
            return;
        }
        self.emit("shutdown", json!({})).await;
        let subscribers = std::mem::take(&mut self.shared.lock().unwrap().subscribers);
        for subscriber in subscribers {
            let _ = subscriber.writer.lock().await.shutdown().await;
        }
        let _ = std::fs::remove_file(&self.path);
    }

    fn methods(&self) -> Vec<String> {
        let shared = self.shared.lock().unwrap();
        let mut methods: BTreeSet<String> = shared.answers.keys().cloned().collect();
        methods.extend(
            ["status.get", "subscribe", "unsubscribe", "daemon.shutdown"].map(String::from),
        );
        methods.into_iter().collect()
    }

    async fn accept(self, mut listener: CoreListener) {
        let mut stopped = self.stopped.subscribe();
        let mut next = 0;
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok(stream) => {
                        next += 1;
                        tokio::spawn(self.clone().serve(next, stream));
                    }
                    Err(_) => return,
                },
                _ = stopped.wait_for(|stopped| *stopped) => return,
            }
        }
    }

    async fn serve(self, connection: u64, stream: CoreStream) {
        let (read, write) = stream.into_split();
        let writer = Arc::new(tokio::sync::Mutex::new(write));
        let mut lines = BufReader::new(read).lines();
        let mut stopped = self.stopped.subscribe();
        let mut greeted = false;
        loop {
            let line = tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => line,
                    _ => break,
                },
                _ = stopped.wait_for(|stopped| *stopped) => break,
            };
            let Ok(request) = serde_json::from_str::<Map<String, Value>>(&line) else {
                break;
            };
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let params = request.get("params").cloned().unwrap_or(json!({}));
            let (version, reported) = {
                let shared = self.shared.lock().unwrap();
                (shared.bridge_version, shared.reported_bridge_version)
            };
            let answer = match method.as_str() {
                "hello" if reported.is_none() && params["bridge_version"] != json!(version) => Err(
                    RpcError::new(ErrorKind::BridgeVersionMismatch, "Another bridge version."),
                ),
                "hello" => {
                    greeted = true;
                    let topics = self.shared.lock().unwrap().topics.clone();
                    Ok(
                        json!({"bridge_version": reported.unwrap_or(version), "daemon_version": "0.0.0-fake",
                              "pid": std::process::id(), "methods": self.methods(),
                              "topics": topics}),
                    )
                }
                "daemon.shutdown" => {
                    let core = self.clone();
                    tokio::spawn(async move { core.stop().await });
                    Ok(json!({"stopping": true}))
                }
                _ if !greeted => Err(RpcError::new(
                    ErrorKind::HandshakeRequired,
                    "Send hello before any other request.",
                )),
                _ => tokio::select! {
                    answer = self.respond(connection, &writer, &method, params) => answer,
                    _ = stopped.wait_for(|stopped| *stopped) => break,
                },
            };
            let Some(id) = request.get("id") else {
                continue;
            };
            if method == "subscribe" && answer.is_ok() {
                let early: Vec<String> = {
                    let mut shared = self.shared.lock().unwrap();
                    std::mem::take(&mut shared.before_subscribed)
                        .into_iter()
                        .map(|(topic, data)| {
                            shared.seq += 1;
                            let line = json!({"jsonrpc": "2.0", "method": EVENT_METHOD,
                                "params": {"topic": topic, "seq": shared.seq, "data": data}});
                            format!("{line}\n")
                        })
                        .collect()
                };
                for line in early {
                    let _ = writer.lock().await.write_all(line.as_bytes()).await;
                }
            }
            let reply = match answer {
                Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
            };
            if writer
                .lock()
                .await
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
        self.shared
            .lock()
            .unwrap()
            .subscribers
            .retain(|s| s.connection != connection);
    }

    async fn respond(
        &self,
        connection: u64,
        writer: &Arc<tokio::sync::Mutex<CoreWriteHalf>>,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        let topics = |params: &Value| -> BTreeSet<String> {
            params["topics"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        };
        let answer = {
            let mut shared = self.shared.lock().unwrap();
            shared.calls.push((method.to_string(), params.clone()));
            if let Some(log) = &shared.log {
                use std::io::Write;
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log)
                {
                    let _ = writeln!(file, "{method}");
                }
            }
            match method {
                "status.get" => return Ok(shared.state.clone()),
                "subscribe" => {
                    let topics = topics(&params);
                    shared.subscribers.push(Subscriber {
                        connection,
                        writer: writer.clone(),
                        topics: topics.clone(),
                    });
                    return Ok(json!({"topics": topics, "status": shared.state}));
                }
                "unsubscribe" => {
                    let dropped = topics(&params);
                    let mut remaining = BTreeSet::new();
                    for subscriber in &mut shared.subscribers {
                        if subscriber.connection == connection {
                            subscriber.topics.retain(|topic| !dropped.contains(topic));
                            remaining.extend(subscriber.topics.iter().cloned());
                        }
                    }
                    return Ok(json!({"topics": remaining}));
                }
                _ => shared.answers.get(method).cloned(),
            }
        };
        match answer {
            None => Err(RpcError::new(
                ErrorKind::MethodNotFound,
                format!("No method {method}."),
            )),
            Some(Answer::Value(value)) => Ok(value),
            Some(Answer::Fail(error)) => Err(error),
            Some(Answer::With(handler)) => handler(params).await,
        }
    }
}

/// What `agent-relay-fake-core` answers beyond the core's own methods: enough
/// for the app to start signed out.
pub fn serve_answers(core: &FakeCore) {
    core.answer("uploader.sessions.preview", json!({"sessions": []}));
    core.answer("telemetry.record", json!({}));
    core.answer(
        "settings.get",
        json!({"allow_self_registration": false, "auto_activate": false,
               "direct_delivery": false, "analytics_enabled": true}),
    );
    core.answer("login_item.status", json!({"enabled": false}));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::contract::{method, reader};

    #[test]
    fn the_snapshots_are_status_values() {
        for state in [snapshot(json!({})), signed_in()] {
            reader::result::<method::StatusGet>(state).unwrap();
        }
    }
}
