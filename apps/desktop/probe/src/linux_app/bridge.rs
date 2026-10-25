//! The app's one client of the relay core (`agent-relay-probe relay serve`).
//!
//! JSON-RPC 2.0, one JSON object per line, on the core's per-user Unix
//! socket, or on Windows its named pipe (`relay::transport`,
//! `docs/relay-core.md`). One connection subscribes and carries
//! events; calls use a small pool of other connections, so a slow call never
//! holds up events or another call. When no core answers, the bridge starts
//! the `agent-relay.service` systemd user unit if the person enabled it,
//! which keeps agents connected after the app quits, as the Mac's
//! LaunchAgent does; otherwise it hosts the core as its child
//! ([`super::host`]), started again with backoff whenever it goes away.
//!
//! Events reach the UI through a bounded channel ([`BridgeEvent`]). A UI
//! that falls behind stops the event connection being read; the core then
//! lets it lag and resyncs it with a fresh snapshot.

use super::host::{HostOptions, Hosted};
use super::service::{ServiceStart, UserService};
use crate::relay::contract::account::SignInReport;
use crate::relay::contract::connection::{
    ActivityLine, CoreNotification, HelloResult, Invalidation, Subscribed, TopicsParams,
};
use crate::relay::contract::{connection::HelloParams, method, reader, Method};
use crate::relay::paths::CorePaths;
use crate::relay::peer::current_uid;
use crate::relay::protocol::{ErrorKind, Topic, BRIDGE_VERSION, EVENT_METHOD, MAX_FRAME_BYTES};
use crate::relay::state::Status;
use crate::relay::transport::{CoreReadHalf, CoreStream, CoreWriteHalf};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, watch, Notify};
use tokio::task::JoinHandle;
use tokio::time::Instant;

mod lifecycle;
mod recovery;
#[cfg(test)]
use recovery::{call_timeout, is_read};

/// The topics the app follows.
pub const SUBSCRIBED_TOPICS: [Topic; 5] = [
    Topic::Status,
    Topic::Activity,
    Topic::Invalidated,
    Topic::Notify,
    Topic::SignIn,
];

/// Calls answer within the core's own deadlines; the longest is the
/// uploader's `start` (10.5 minutes).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(11 * 60);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Greeted connections kept for calls.
const POOL: usize = 4;
/// Events the UI may fall behind by before the event connection stops
/// being read.
pub const EVENT_BUFFER: usize = 64;
const FIRST_BACKOFF: Duration = Duration::from_millis(500);
const LAST_BACKOFF: Duration = Duration::from_secs(30);

/// Why a call failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The core answered with this contract error.
    Core(ErrorKind),
    /// No core answered.
    Unavailable,
    /// The core's answer does not fit this build's contract.
    Unreadable,
}

/// A failed call: `message` is a sentence safe to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreError {
    pub failure: Failure,
    pub message: String,
    /// Whether repeating the same call later can succeed.
    pub retryable: bool,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CoreError {}

impl CoreError {
    pub fn unavailable() -> CoreError {
        CoreError {
            failure: Failure::Unavailable,
            message: "Agent Relay is starting. Try again in a moment.".into(),
            retryable: true,
        }
    }

    pub(super) fn unavailable_because(message: &str) -> CoreError {
        CoreError {
            failure: Failure::Unavailable,
            message: message.into(),
            retryable: false,
        }
    }

    fn reconnecting() -> CoreError {
        CoreError {
            failure: Failure::Unavailable,
            message:
                "Agent Relay is reconnecting to its background service. Try again in a moment."
                    .into(),
            retryable: true,
        }
    }

    pub(crate) fn interrupted() -> CoreError {
        CoreError {
            failure: Failure::Unavailable,
            message: "Connection to Agent Relay was interrupted. Check whether the action completed before trying again.".into(),
            retryable: false,
        }
    }

    fn core(kind: ErrorKind, message: &str) -> CoreError {
        CoreError {
            failure: Failure::Core(kind),
            message: message.into(),
            retryable: kind.retryable(),
        }
    }

    pub fn kind(&self) -> Option<ErrorKind> {
        match self.failure {
            Failure::Core(kind) => Some(kind),
            _ => None,
        }
    }

    /// A JSON-RPC error object as the core sends it. A kind this build does
    /// not know reads as `internal`, the contract's fallback.
    fn from_wire(error: &Value) -> CoreError {
        let data = &error["data"];
        CoreError {
            failure: Failure::Core(
                serde_json::from_value(data["kind"].clone()).unwrap_or(ErrorKind::Internal),
            ),
            message: error["message"]
                .as_str()
                .unwrap_or("Agent Relay hit a problem.")
                .to_string(),
            retryable: data["retryable"].as_bool().unwrap_or(false),
        }
    }
}

/// What can end a request: the connection (silently reconnected), or the
/// core's own answer.
#[derive(Debug)]
pub enum ConnectionError {
    Transport(io::Error),
    Core(CoreError),
}

impl From<io::Error> for ConnectionError {
    fn from(error: io::Error) -> ConnectionError {
        ConnectionError::Transport(error)
    }
}

impl From<CoreError> for ConnectionError {
    fn from(error: CoreError) -> ConnectionError {
        ConnectionError::Core(error)
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// One socket to the core. Requests on it are answered in order, one at a
/// time.
pub struct Connection {
    reader: BufReader<CoreReadHalf>,
    writer: CoreWriteHalf,
    next_id: u64,
    /// The core's handshake, once [`Connection::greet`] has it.
    pub hello: Option<HelloResult>,
}

impl Connection {
    /// Connects to the core at `path`, served by this user only: the same
    /// trust boundary as the core's own admission.
    pub async fn open(path: &Path) -> io::Result<Connection> {
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, CoreStream::connect(path))
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
        if stream.peer_credentials()?.uid != current_uid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the socket is not served by this user's core",
            ));
        }
        Ok(Connection::over(stream))
    }

    fn over(stream: CoreStream) -> Connection {
        let (read, writer) = stream.into_split();
        Connection {
            reader: BufReader::new(read),
            writer,
            next_id: 0,
            hello: None,
        }
    }

    /// `hello`: the handshake every request but `daemon.shutdown` needs.
    pub async fn greet(&mut self) -> Result<HelloResult, ConnectionError> {
        let params = to_params(&HelloParams {
            bridge_version: BRIDGE_VERSION,
        })?;
        let value = self
            .request(method::Hello::NAME, params, CONNECT_TIMEOUT)
            .await?;
        let hello = reader::result::<method::Hello>(value)
            .map_err(|_| CoreError::unreadable(method::Hello::NAME))?;
        if hello.bridge_version != BRIDGE_VERSION {
            return Err(CoreError::core(
                ErrorKind::BridgeVersionMismatch,
                "Agent Relay's background service is a different version.",
            )
            .into());
        }
        self.hello = Some(hello.clone());
        Ok(hello)
    }

    /// Sends one request; one longer than the contract allows is refused
    /// before it is sent.
    async fn send(&mut self, method: &str, params: Value) -> Result<u64, ConnectionError> {
        self.next_id += 1;
        let line =
            json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
                .to_string();
        if line.len() > MAX_FRAME_BYTES {
            return Err(CoreError::core(
                ErrorKind::InvalidParams,
                "The request is larger than Agent Relay accepts.",
            )
            .into());
        }
        self.writer
            .write_all(format!("{line}\n").as_bytes())
            .await?;
        Ok(self.next_id)
    }

    /// The next message; a line longer than the contract allows ends the
    /// connection.
    async fn read(&mut self) -> io::Result<Value> {
        let mut line = Vec::new();
        (&mut self.reader)
            .take(MAX_FRAME_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .await?;
        if line.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the core closed the connection",
            ));
        }
        if line.last() != Some(&b'\n') {
            return Err(invalid(
                "the core sent a line longer than the contract allows",
            ));
        }
        match serde_json::from_slice(&line) {
            Ok(value @ Value::Object(_)) => Ok(value),
            _ => Err(invalid("the core sent something that is not a message")),
        }
    }

    /// Sends one request and waits for its answer. Events in between are
    /// skipped; `shutdown` among them fails the request.
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ConnectionError> {
        self.exchange(method, params, timeout, None).await
    }

    /// [`Connection::request`], keeping the events that arrive before the
    /// answer in `events` when given.
    async fn exchange(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
        mut events: Option<&mut Vec<Value>>,
    ) -> Result<Value, ConnectionError> {
        let deadline = Instant::now() + timeout;
        let id = tokio::time::timeout_at(deadline, self.send(method, params))
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
        loop {
            let message = tokio::time::timeout_at(deadline, self.read())
                .await
                .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
            if message["method"] == EVENT_METHOD {
                // Only `shutdown` reaches a connection that never subscribed.
                if message["params"]["topic"] == "shutdown" {
                    return Err(CoreError::core(
                        ErrorKind::ShuttingDown,
                        "Agent Relay core is stopping.",
                    )
                    .into());
                }
                if let Some(events) = events.as_deref_mut() {
                    events.push(message);
                }
                continue;
            }
            if message["id"] != json!(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(CoreError::from_wire(error).into());
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

impl CoreError {
    fn unreadable(method: &str) -> CoreError {
        CoreError {
            failure: Failure::Unreadable,
            message: format!("Agent Relay could not read the answer to {method}."),
            retryable: false,
        }
    }
}

fn to_params(params: &impl Serialize) -> Result<Value, CoreError> {
    serde_json::to_value(params).map_err(|_| {
        CoreError::core(
            ErrorKind::InvalidParams,
            "The request could not be encoded.",
        )
    })
}

/// What the bridge tells the UI, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum BridgeEvent {
    /// The event connection came up; a `Status` follows.
    Connected,
    /// The event connection went down; `error` is a sentence when the core
    /// could not be reached for a reason worth showing.
    Disconnected {
        error: Option<String>,
    },
    /// A snapshot newer than any before on this connection.
    Status(Box<Status>),
    Activity(ActivityLine),
    Invalidated(Invalidation),
    Notify(CoreNotification),
    SignIn(Box<SignInReport>),
}

/// Where the bridge finds the core and what it may start.
pub struct BridgeOptions {
    pub socket: PathBuf,
    /// `None`: only attach to a core someone else runs.
    pub host: Option<HostOptions>,
    /// Started, when enabled, before a core is hosted.
    pub service: Option<Arc<dyn UserService>>,
}

impl BridgeOptions {
    /// `AGENT_RELAY_CORE_SOCKET` or `~/.agentworkforce/desktop/core.sock`,
    /// hosting the bundled core and starting the systemd unit.
    pub fn standard(
        home: &Path,
        env: impl Fn(&str) -> Option<String>,
        probe: Option<PathBuf>,
        service: Arc<dyn UserService>,
    ) -> anyhow::Result<BridgeOptions> {
        Ok(BridgeOptions {
            socket: CorePaths::resolve(None, env, home)?.socket,
            host: Some(HostOptions {
                probe,
                version: Some(crate::VERSION.to_string()),
                ..HostOptions::default()
            }),
            service: Some(service),
        })
    }
}

#[derive(Default)]
struct Shared {
    methods: BTreeSet<String>,
    daemon_version: Option<String>,
    idle: Vec<Connection>,
    /// Bumped whenever the pool is emptied because its core went away; a
    /// connection opened under an older generation never rejoins it.
    generation: u64,
}

struct Inner {
    options: BridgeOptions,
    shared: Mutex<Shared>,
    hosted: Hosted,
    /// Set by [`Bridge::release_hosted`]: no core is hosted until one answers
    /// or [`Bridge::restart`], so the systemd unit can take the socket.
    released: AtomicBool,
    /// Set while a core an earlier run left running is stopped for the unit.
    retiring: AtomicBool,
    stopping: watch::Sender<bool>,
    restart: Notify,
    events: Mutex<Option<JoinHandle<()>>>,
}

/// The app's client of the relay core. Cheap to clone; every clone is the
/// same bridge.
#[derive(Clone)]
pub struct Bridge {
    inner: Arc<Inner>,
}

impl Bridge {
    /// Starts following the core on `runtime`; events arrive on the
    /// returned receiver until [`Bridge::stop`].
    pub fn start(
        options: BridgeOptions,
        runtime: &tokio::runtime::Handle,
    ) -> (Bridge, mpsc::Receiver<BridgeEvent>) {
        let bridge = Bridge {
            inner: Arc::new(Inner {
                options,
                shared: Mutex::default(),
                hosted: Hosted::default(),
                released: AtomicBool::new(false),
                retiring: AtomicBool::new(false),
                stopping: watch::channel(false).0,
                restart: Notify::new(),
                events: Mutex::new(None),
            }),
        };
        let (sender, receiver) = mpsc::channel(EVENT_BUFFER);
        let task = runtime.spawn(bridge.clone().follow(sender));
        *bridge.inner.events.lock().unwrap() = Some(task);
        (bridge, receiver)
    }

    fn stopping(&self) -> bool {
        *self.inner.stopping.borrow()
    }

    /// Whether the running core answers `method` (from `hello`).
    pub fn offers(&self, method: &str) -> bool {
        self.inner.shared.lock().unwrap().methods.contains(method)
    }

    pub fn daemon_version(&self) -> Option<String> {
        self.inner.shared.lock().unwrap().daemon_version.clone()
    }

    /// Whether this app hosts the running core.
    pub fn hosting(&self) -> bool {
        self.inner.hosted.running()
    }

    /// The hosted core's process id, while one runs.
    pub fn hosted_pid(&self) -> Option<u32> {
        self.inner.hosted.pid()
    }

    /// Stops a core this app hosts or an earlier run left running, so the
    /// systemd unit can take the socket. The event connection reconnects to whichever core answers,
    /// and hosts none meanwhile, until one does or [`Bridge::restart`].
    pub async fn release_hosted(&self) {
        self.inner.released.store(true, Ordering::SeqCst);
        self.stop_hosted().await;
        self.stop_left_behind().await;
    }

    /// Drops the event connection, if one is up, so it connects again; a
    /// core released with [`Bridge::release_hosted`] may be hosted again.
    pub fn restart(&self) {
        self.inner.released.store(false, Ordering::SeqCst);
        self.inner.restart.notify_waiters();
    }

    /// Closes the pooled and event connections and, when this app hosts the
    /// core, stops it.
    pub async fn stop(&self) {
        self.close().await;
        self.stop_hosted().await;
    }

    /// Calls method `M` on a pooled connection.
    pub async fn call<M: Method>(&self, params: M::Params) -> Result<M::Result, CoreError> {
        let value = self.call_value(M::NAME, to_params(&params)?).await?;
        reader::result::<M>(value).map_err(|_| CoreError::unreadable(M::NAME))
    }

    /// Returns `connection` to the pool, unless the pool has been emptied
    /// since it was checked out (its core went away).
    fn release(&self, connection: Connection, generation: u64) {
        let mut shared = self.inner.shared.lock().unwrap();
        if !self.stopping() && shared.generation == generation && shared.idle.len() < POOL {
            shared.idle.push(connection);
        }
    }

    /// Empties the pool: its connections are to a core that went away.
    fn drop_pool(&self) {
        let idle = {
            let mut shared = self.inner.shared.lock().unwrap();
            shared.generation += 1;
            std::mem::take(&mut shared.idle)
        };
        drop(idle);
    }

    async fn greeted(&self) -> Result<Connection, ConnectionError> {
        let mut connection = Connection::open(&self.inner.options.socket).await?;
        let hello = connection.greet().await?;
        let mut shared = self.inner.shared.lock().unwrap();
        shared.methods = hello.methods.into_iter().collect();
        shared.daemon_version = Some(hello.daemon_version);
        Ok(connection)
    }

    /// A greeted connection, starting a core first when none answers.
    async fn connect(&self) -> Result<Connection, ConnectionError> {
        match self.greeted().await {
            Ok(connection) => {
                if self.unusable_core().await {
                    return Err(CoreError::unavailable_because(
                        "Agent Relay is restarting its helper program.",
                    )
                    .into());
                }
                self.inner.released.store(false, Ordering::SeqCst);
                return Ok(connection);
            }
            Err(ConnectionError::Core(error))
                if error.kind() == Some(ErrorKind::BridgeVersionMismatch) =>
            {
                // A core on another bridge version is a stale one: asked to
                // stop, its host or systemd starts the installed one.
                let _ = self.ask_core_to_stop().await;
                return Err(error.into());
            }
            Err(ConnectionError::Transport(error))
                if self.inner.options.host.is_some()
                    && !self.inner.released.load(Ordering::SeqCst)
                    && matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                    ) => {}
            Err(error) => return Err(error),
        }
        let socket = &self.inner.options.socket;
        let stopping = || self.stopping();
        if !self.hosting() {
            if let Some(service) = self.inner.options.service.clone() {
                let started = tokio::task::spawn_blocking(move || service.start())
                    .await
                    .unwrap_or(ServiceStart::Unconfirmed);
                if started != ServiceStart::NotEnabled {
                    // The enabled service owns the socket: one slow to come
                    // up, or whose start systemctl could not confirm, is
                    // waited for on the next attempt, never doubled by a
                    // hosted core.
                    let waited = self.inner.hosted.wait_for_socket(socket, stopping).await;
                    if started == ServiceStart::Unconfirmed && waited.is_err() && !self.stopping() {
                        return Err(CoreError::unavailable_because(
                            "Agent Relay's background service did not start.",
                        )
                        .into());
                    }
                    waited?;
                    return self.greeted().await;
                }
            }
        }
        if !self.hosting() {
            if self.stopping() || self.inner.released.load(Ordering::SeqCst) {
                return Err(CoreError::unavailable().into());
            }
            let host = self.inner.options.host.as_ref().expect("checked above");
            self.inner.hosted.spawn(host, socket)?;
        }
        self.inner.hosted.wait_for_socket(socket, stopping).await?;
        let connection = self.greeted().await?;
        self.inner.released.store(false, Ordering::SeqCst);
        Ok(connection)
    }

    async fn follow(self, sender: mpsc::Sender<BridgeEvent>) {
        let mut stopping = self.inner.stopping.subscribe();
        let mut backoff = FIRST_BACKOFF;
        let mut connected = false;
        while !self.stopping() && !sender.is_closed() {
            let mut revision = None;
            let outcome = tokio::select! {
                outcome = self.session(&sender, &mut connected, &mut revision, &mut backoff) => outcome,
                _ = stopping.wait_for(|stopping| *stopping) => return,
            };
            // The core went away: pooled call connections are to it too.
            self.drop_pool();
            if self.stopping() {
                return;
            }
            let error = match outcome {
                Err(ConnectionError::Core(error)) => Some(error.message),
                _ => None,
            };
            if connected || error.is_some() {
                connected = false;
                if !self
                    .deliver(&sender, BridgeEvent::Disconnected { error })
                    .await
                {
                    return;
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = stopping.wait_for(|stopping| *stopping) => return,
            }
            backoff = (backoff * 2).min(LAST_BACKOFF);
        }
    }

    /// Sends one event, waiting while the UI is behind; false once nobody
    /// listens or the bridge stops.
    async fn deliver(&self, sender: &mpsc::Sender<BridgeEvent>, event: BridgeEvent) -> bool {
        let mut stopping = self.inner.stopping.subscribe();
        tokio::select! {
            sent = sender.send(event) => sent.is_ok(),
            _ = stopping.wait_for(|stopping| *stopping) => false,
        }
    }

    /// One event connection, from connecting until it ends or
    /// [`Bridge::restart`] drops it. A restart while connecting leaves the
    /// attempt alone.
    async fn session(
        &self,
        sender: &mpsc::Sender<BridgeEvent>,
        connected: &mut bool,
        revision: &mut Option<u64>,
        backoff: &mut Duration,
    ) -> Result<(), ConnectionError> {
        let mut connection = self.connect().await?;
        let topics = to_params(&TopicsParams {
            topics: SUBSCRIBED_TOPICS.to_vec(),
        })?;
        // Events can arrive ahead of the answer once the subscription is in
        // place; they follow the snapshot it carries.
        let mut early = Vec::new();
        let value = connection
            .exchange(
                method::Subscribe::NAME,
                topics,
                CONNECT_TIMEOUT,
                Some(&mut early),
            )
            .await?;
        let subscribed: Subscribed = reader::result::<method::Subscribe>(value)
            .map_err(|_| CoreError::unreadable(method::Subscribe::NAME))?;
        *backoff = FIRST_BACKOFF;
        *connected = true;
        let restart = self.inner.restart.notified();
        tokio::pin!(restart);
        restart.as_mut().enable();
        if !self.deliver(sender, BridgeEvent::Connected).await
            || !self.status(sender, revision, subscribed.status).await
        {
            return Ok(());
        }
        for message in early {
            if !self.dispatch(sender, revision, message).await {
                return Ok(());
            }
        }
        loop {
            let message = tokio::select! {
                message = connection.read() => message?,
                _ = &mut restart => return Ok(()),
            };
            if !self.dispatch(sender, revision, message).await {
                return Ok(());
            }
        }
    }

    /// Hands one message from the event connection to the UI; false when
    /// the session ends (the core is stopping, or nobody listens).
    async fn dispatch(
        &self,
        sender: &mpsc::Sender<BridgeEvent>,
        revision: &mut Option<u64>,
        message: Value,
    ) -> bool {
        if message["method"] != EVENT_METHOD {
            return true;
        }
        let params = &message["params"];
        let data = params["data"].clone();
        let event = match params["topic"].as_str().unwrap_or_default() {
            "shutdown" => return false,
            "status" => {
                return match reader::event::<Status>(data) {
                    Ok(status) => self.status(sender, revision, status).await,
                    Err(_) => true,
                };
            }
            "activity" => reader::event::<ActivityLine>(data).map(BridgeEvent::Activity),
            "invalidated" => reader::event::<Invalidation>(data).map(BridgeEvent::Invalidated),
            "notify" => reader::event::<CoreNotification>(data).map(BridgeEvent::Notify),
            "sign_in" => reader::event::<SignInReport>(data)
                .map(|report| BridgeEvent::SignIn(Box::new(report))),
            _ => return true,
        };
        // An event this build cannot read is one it cannot act on.
        match event {
            Ok(event) => self.deliver(sender, event).await,
            Err(_) => true,
        }
    }

    /// Delivers `status` when it is newer than the last one delivered; false
    /// once nobody listens.
    async fn status(
        &self,
        sender: &mpsc::Sender<BridgeEvent>,
        revision: &mut Option<u64>,
        status: Status,
    ) -> bool {
        if revision.is_some_and(|last| status.revision <= last) {
            return true;
        }
        *revision = Some(status.revision);
        self.deliver(sender, BridgeEvent::Status(Box::new(status)))
            .await
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::linux_app::fake_core::{signed_in, snapshot, Answer, FakeCore};
    use crate::relay::contract::agents::RegisterParams;
    use crate::relay::state::{AccountAction, Listing, SignInState};
    use tempfile::TempDir;

    /// A directory short enough for a socket path on macOS; any temporary
    /// directory on Windows, where the path only names a pipe.
    pub fn socket_directory() -> (TempDir, PathBuf) {
        let mut builder = tempfile::Builder::new();
        builder.prefix("br-");
        let directory = if cfg!(unix) {
            builder.tempdir_in("/tmp")
        } else {
            builder.tempdir()
        }
        .unwrap();
        let path = directory.path().join("core.sock");
        (directory, path)
    }

    /// Receives the bridge's events in order.
    pub struct Recorder(pub mpsc::Receiver<BridgeEvent>);

    impl Recorder {
        /// The next event `pick` accepts, skipping others.
        pub async fn next<T>(&mut self, pick: impl Fn(BridgeEvent) -> Option<T>) -> T {
            self.within(Duration::from_secs(10), pick).await
        }

        pub async fn within<T>(
            &mut self,
            wait: Duration,
            pick: impl Fn(BridgeEvent) -> Option<T>,
        ) -> T {
            tokio::time::timeout(wait, async {
                loop {
                    let event = self.0.recv().await.expect("the bridge stopped");
                    if let Some(value) = pick(event) {
                        return value;
                    }
                }
            })
            .await
            .expect("no such event in time")
        }

        pub async fn status(&mut self) -> Status {
            self.next(|event| match event {
                BridgeEvent::Status(status) => Some(*status),
                _ => None,
            })
            .await
        }

        pub async fn connected(&mut self) {
            self.next(|event| (event == BridgeEvent::Connected).then_some(()))
                .await
        }

        pub async fn disconnected(&mut self) -> Option<String> {
            self.next(|event| match event {
                BridgeEvent::Disconnected { error } => Some(error),
                _ => None,
            })
            .await
        }
    }

    fn attach(path: &Path) -> (Bridge, Recorder) {
        let options = BridgeOptions {
            socket: path.to_path_buf(),
            host: None,
            service: None,
        };
        let (bridge, events) = Bridge::start(options, &tokio::runtime::Handle::current());
        (bridge, Recorder(events))
    }

    #[test]
    fn reads_have_short_deadlines_without_shortening_long_commands() {
        assert_eq!(call_timeout("sessions.list"), Duration::from_secs(30));
        assert_eq!(call_timeout("settings.get"), Duration::from_secs(30));
        assert_eq!(call_timeout("chat.conversation"), Duration::from_secs(30));
        assert_eq!(
            call_timeout("diagnostics.requests"),
            Duration::from_secs(30)
        );
        assert_eq!(call_timeout("uploader.start"), Duration::from_secs(660));
        assert!(is_read("settings.get"));
        assert!(is_read("cursor_cloud.agents.get"));
        assert!(is_read("cursor_cloud.environments.list"));
        assert!(is_read("cursor_cloud.runs.list"));
        assert!(is_read("replicas.spawn.get"));
        assert!(!is_read("cursor_cloud.runs.create"));
        assert!(!is_read("cursor_cloud.runs.cancel"));
        assert!(!is_read("agents.test_message"));
        assert!(!is_read("future.status"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stalled_read_times_out_while_status_remains_available() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.answer(
            "sessions.list",
            Answer::with(|_| async { std::future::pending().await }),
        );
        let (bridge, mut events) = attach(&path);
        events.connected().await;
        assert_eq!(events.status().await.account.state, SignInState::SignedOut);
        let mut connection = Connection::open(&path).await.unwrap();
        connection.greet().await.unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            connection.request("sessions.list", json!({}), Duration::from_millis(50)),
        )
        .await
        .expect("the request must honor its deadline");
        assert!(
            matches!(result, Err(ConnectionError::Transport(error)) if error.kind() == io::ErrorKind::TimedOut)
        );
        drop(connection);
        let status = bridge
            .call::<method::StatusGet>(crate::relay::contract::NoParams {})
            .await
            .unwrap();
        assert_eq!(status.account.state, SignInState::SignedOut);
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn subscribes_and_delivers_status_and_events() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let (bridge, mut events) = attach(&path);
        events.connected().await;
        assert_eq!(events.status().await.account.state, SignInState::SignedOut);
        let subscribed: BTreeSet<String> = core.called("subscribe")[0]["topics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|topic| topic.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            subscribed,
            ["activity", "invalidated", "notify", "sign_in", "status"]
                .map(String::from)
                .into()
        );

        core.set_state(signed_in()).await;
        assert_eq!(events.status().await.account.state, SignInState::SignedIn);
        core.emit("invalidated", json!({"what": "sessions"})).await;
        let what = events
            .next(|event| match event {
                BridgeEvent::Invalidated(invalidation) => Some(invalidation.what),
                _ => None,
            })
            .await;
        assert_eq!(what, Listing::Sessions);
        core.emit(
            "notify",
            json!({"title": "Message", "body": "Hi", "link": null}),
        )
        .await;
        let title = events
            .next(|event| match event {
                BridgeEvent::Notify(notification) => Some(notification.title),
                _ => None,
            })
            .await;
        assert_eq!(title, "Message");
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_status_that_is_not_newer_is_ignored() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let (bridge, mut events) = attach(&path);
        events.status().await;
        let mut stale = core.state();
        stale["revision"] = json!(0);
        core.emit("status", stale).await;
        core.set_state(signed_in()).await;
        assert_eq!(events.status().await.account.state, SignInState::SignedIn);
        assert!(events.0.try_recv().is_err());
        bridge.stop().await;
        core.stop().await;
    }

    /// A core of another version than the app (normal mid-update) can
    /// advertise and send values this build does not know.
    #[tokio::test(flavor = "multi_thread")]
    async fn another_cores_unknown_topics_methods_and_actions_pass_through() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::with_state(
            &path,
            snapshot(json!({"state": "error", "action": "reinstall_the_core"})),
        )
        .unwrap();
        core.advertise_topic("telepathy.changed");
        core.answer("telepathy.read", json!({"ok": true}));
        let (bridge, mut events) = attach(&path);
        events.connected().await;
        let status = events.status().await;
        assert_eq!(status.account.state, SignInState::Error);
        // A Rust enum has no case for an action this build does not know.
        assert_eq!(status.account.action, None::<AccountAction>);
        assert!(bridge.offers("telepathy.read"));
        assert_eq!(
            bridge.call_value("telepathy.read", json!({})).await,
            Ok(json!({"ok": true}))
        );
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_connection_has_no_handshake_until_it_greets() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let mut connection = Connection::open(&path).await.unwrap();
        assert!(connection.hello.is_none());
        let hello = connection.greet().await.unwrap();
        assert_eq!(hello.daemon_version, "0.0.0-fake");
        assert_eq!(connection.hello.unwrap().pid, hello.pid);
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn calls_answer_typed_results_and_errors() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.answer("agents.list", json!({"agents": []}));
        core.answer(
            "agents.register",
            Answer::fail(ErrorKind::Conflict, "That name is taken."),
        );
        let (bridge, _events) = attach(&path);
        let agents = bridge.call::<method::AgentsList>(Default::default()).await;
        assert!(agents.unwrap().agents.is_empty());
        let params: RegisterParams =
            serde_json::from_value(json!({"target": {"kind": "codex", "id": "x"}})).unwrap();
        let error = bridge
            .call::<method::AgentsRegister>(params)
            .await
            .unwrap_err();
        assert_eq!(
            (error.failure, error.message.as_str(), error.retryable),
            (
                Failure::Core(ErrorKind::Conflict),
                "That name is taken.",
                false
            )
        );
        assert_eq!(core.called("agents.register")[0]["target"]["id"], "x");
        assert_eq!(bridge.daemon_version().as_deref(), Some("0.0.0-fake"));
        assert!(bridge.offers("agents.list"));
        assert!(!bridge.offers("chat.send"));
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_answer_that_does_not_fit_the_contract_is_unreadable() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.answer("agents.list", json!({"agents": "none"}));
        let (bridge, _events) = attach(&path);
        let error = bridge
            .call::<method::AgentsList>(Default::default())
            .await
            .unwrap_err();
        assert_eq!(error.failure, Failure::Unreadable);
        assert_eq!(
            error.message,
            "Agent Relay could not read the answer to agents.list."
        );
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_slow_call_does_not_hold_up_another() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let release = Arc::new(Notify::new());
        let waiting = release.clone();
        core.answer(
            "uploader.start",
            Answer::with(move |_| {
                let waiting = waiting.clone();
                async move {
                    waiting.notified().await;
                    Ok(json!({"running": true}))
                }
            }),
        );
        core.answer("status.ping", json!({"ok": true}));
        let (bridge, _events) = attach(&path);
        let slow = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.call_value("uploader.start", json!({})).await }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            bridge.call_value("status.ping", json!({})).await,
            Ok(json!({"ok": true}))
        );
        assert!(!slow.is_finished());
        release.notify_one();
        assert_eq!(slow.await.unwrap(), Ok(json!({"running": true})));
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_missing_method_is_reported() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let (bridge, _events) = attach(&path);
        let error = bridge
            .call_value("missing.method", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), Some(ErrorKind::MethodNotFound));
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_core_that_stops_is_reported_and_reconnected() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let (bridge, mut events) = attach(&path);
        events.status().await;
        core.stop().await;
        assert_eq!(events.disconnected().await, None);
        let replacement = FakeCore::start(&path).unwrap();
        replacement.set_state(signed_in()).await;
        events.connected().await;
        assert_eq!(events.status().await.account.state, SignInState::SignedIn);
        bridge.stop().await;
        replacement.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_interrupted_read_retries_on_the_replacement_core() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.answer(
            "settings.get",
            Answer::with(|_| async { std::future::pending().await }),
        );
        let (bridge, mut events) = attach(&path);
        events.status().await;
        let read_bridge = bridge.clone();
        let read =
            tokio::spawn(async move { read_bridge.call_value("settings.get", json!({})).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while core.called("settings.get").is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        core.stop().await;
        let replacement = FakeCore::start(&path).unwrap();
        replacement.answer("settings.get", json!({"recovered": true}));
        assert_eq!(read.await.unwrap(), Ok(json!({"recovered": true})));
        assert_eq!(replacement.called("settings.get").len(), 1);
        bridge.stop().await;
        replacement.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_interrupted_command_is_not_replayed() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.answer(
            "settings.set",
            Answer::with(|_| async { std::future::pending().await }),
        );
        let (bridge, mut events) = attach(&path);
        events.status().await;
        let write_bridge = bridge.clone();
        let write =
            tokio::spawn(async move { write_bridge.call_value("settings.set", json!({})).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while core.called("settings.set").is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        core.stop().await;
        let replacement = FakeCore::start(&path).unwrap();
        replacement.answer("settings.set", json!({"saved": true}));
        let error = write.await.unwrap().unwrap_err();
        assert_eq!(error.message, CoreError::interrupted().message);
        assert!(!error.retryable);
        assert!(replacement.called("settings.set").is_empty());
        bridge.stop().await;
        replacement.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shutdown_reply_does_not_invite_repeating_a_command() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.answer(
            "settings.set",
            Answer::fail(ErrorKind::ShuttingDown, "The service is shutting down."),
        );
        let (bridge, mut events) = attach(&path);
        events.status().await;
        let error = bridge
            .call_value("settings.set", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.message, CoreError::interrupted().message);
        assert!(!error.retryable);
        assert_eq!(core.called("settings.set").len(), 1);
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_restart_connects_the_events_again() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let (bridge, mut events) = attach(&path);
        events.status().await;
        bridge.restart();
        assert_eq!(events.disconnected().await, None);
        events.connected().await;
        events.status().await;
        assert_eq!(core.called("subscribe").len(), 2);
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pooled_calls_follow_a_restarted_core() {
        let (_directory, path) = socket_directory();
        let first = FakeCore::start(&path).unwrap();
        first.answer("ping", json!({"core": 1}));
        let (bridge, mut events) = attach(&path);
        events.status().await;
        assert_eq!(
            bridge.call_value("ping", json!({})).await,
            Ok(json!({"core": 1}))
        );
        first.stop().await;
        events.disconnected().await;
        let second = FakeCore::start(&path).unwrap();
        second.answer("ping", json!({"core": 2}));
        events.connected().await;
        assert_eq!(
            bridge.call_value("ping", json!({})).await,
            Ok(json!({"core": 2}))
        );
        bridge.stop().await;
        second.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_call_answered_after_its_core_went_away_never_rejoins_the_pool() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let release = Arc::new(Notify::new());
        let waiting = release.clone();
        core.answer(
            "uploader.start",
            Answer::with(move |_| {
                let waiting = waiting.clone();
                async move {
                    waiting.notified().await;
                    Ok(json!({"running": true}))
                }
            }),
        );
        let (bridge, mut events) = attach(&path);
        events.status().await;
        let slow = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.call_value("uploader.start", json!({})).await }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        // The event connection drops, which empties the pool.
        bridge.restart();
        events.disconnected().await;
        release.notify_one();
        assert_eq!(slow.await.unwrap(), Ok(json!({"running": true})));
        assert_eq!(bridge.inner.shared.lock().unwrap().idle.len(), 0);
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_request_longer_than_the_contract_allows_is_refused_unsent() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.answer("ping", json!({"ok": true}));
        let (bridge, mut events) = attach(&path);
        events.status().await;
        let error = bridge
            .call_value("ping", json!({"text": "x".repeat(MAX_FRAME_BYTES)}))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), Some(ErrorKind::InvalidParams));
        assert!(core.called("ping").is_empty());
        assert_eq!(
            bridge.call_value("ping", json!({})).await,
            Ok(json!({"ok": true}))
        );
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_core_that_reports_another_bridge_version_is_refused() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.report_bridge_version(BRIDGE_VERSION + 1);
        let mut connection = Connection::open(&path).await.unwrap();
        match connection.greet().await {
            Err(ConnectionError::Core(error)) => {
                assert_eq!(error.kind(), Some(ErrorKind::BridgeVersionMismatch));
                assert_eq!(
                    error.message,
                    "Agent Relay's background service is a different version."
                );
            }
            other => panic!("greeted: {other:?}"),
        }
        assert!(connection.hello.is_none());
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn events_ahead_of_the_subscribe_answer_follow_its_snapshot() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.emit_before_subscribed(
            "activity",
            json!({"level": "info", "message": "early", "at_ms": 0}),
        );
        let (bridge, mut events) = attach(&path);
        let mut order = Vec::new();
        for _ in 0..3 {
            let event = events.within(Duration::from_secs(10), Some).await;
            order.push(match event {
                BridgeEvent::Connected => "connected".to_string(),
                BridgeEvent::Status(_) => "status".to_string(),
                BridgeEvent::Activity(line) => line.message,
                other => format!("{other:?}"),
            });
        }
        assert_eq!(order, ["connected", "status", "early"]);
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_ui_that_stops_listening_ends_the_event_connection() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let (bridge, mut events) = attach(&path);
        events.status().await;
        drop(events);
        core.set_state(snapshot(json!({}))).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !bridge
                .inner
                .events
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .is_finished()
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the event task ended");
        bridge.stop().await;
        core.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_call_with_no_core_is_unavailable() {
        let (_directory, path) = socket_directory();
        let (bridge, _events) = attach(&path);
        let error = bridge
            .call_value("status.get", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error, CoreError::unavailable());
        bridge.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_core_on_another_bridge_version_is_asked_to_stop() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        core.speak_bridge_version(BRIDGE_VERSION + 1);
        let mut connection = Connection::open(&path).await.unwrap();
        match connection.greet().await {
            Err(ConnectionError::Core(error)) => {
                assert_eq!(error.kind(), Some(ErrorKind::BridgeVersionMismatch))
            }
            other => panic!("greeted: {other:?}"),
        }
        let (bridge, mut events) = attach(&path);
        assert_eq!(
            events.disconnected().await.as_deref(),
            Some("Another bridge version.")
        );
        tokio::time::timeout(Duration::from_secs(5), core.stopped())
            .await
            .unwrap();
        bridge.stop().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn events_between_a_request_and_its_answer_are_skipped() {
        let (server, client) = CoreStream::pair().await.unwrap();
        let mut connection = Connection::over(client);
        let (_, mut server) = server.into_split();
        server
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"method\":\"event\",\"params\":{\"topic\":\"activity\"}}\n\
                  {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n",
            )
            .await
            .unwrap();
        let answer = connection.request("x", json!({}), CONNECT_TIMEOUT).await;
        assert_eq!(answer.unwrap(), json!({"ok": true}));
        server
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"method\":\"event\",\"params\":{\"topic\":\"shutdown\"}}\n",
            )
            .await
            .unwrap();
        match connection.request("y", json!({}), CONNECT_TIMEOUT).await {
            Err(ConnectionError::Core(error)) => {
                assert_eq!(error.kind(), Some(ErrorKind::ShuttingDown));
                assert!(error.retryable);
            }
            other => panic!("answered: {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_line_longer_than_the_contract_allows_ends_the_connection() {
        let (server, client) = CoreStream::pair().await.unwrap();
        let mut connection = Connection::over(client);
        let (_, mut server) = server.into_split();
        tokio::spawn(async move {
            let padding = "x".repeat(MAX_FRAME_BYTES);
            let line = format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"{padding}\"}}\n");
            let _ = server.write_all(line.as_bytes()).await;
        });
        match connection.request("x", json!({}), CONNECT_TIMEOUT).await {
            Err(ConnectionError::Transport(error)) => {
                assert_eq!(error.kind(), io::ErrorKind::InvalidData)
            }
            other => panic!("answered: {other:?}"),
        }
    }

    #[test]
    fn an_error_kind_this_build_does_not_know_reads_as_internal() {
        let error = CoreError::from_wire(&json!({
            "code": -32000, "message": "Out of ink.",
            "data": {"kind": "out_of_ink", "retryable": true},
        }));
        assert_eq!(error.failure, Failure::Core(ErrorKind::Internal));
        assert_eq!(error.message, "Out of ink.");
        assert!(error.retryable);
    }

    /// A UI that stops reading holds the event connection; the bridge
    /// neither drops nor buffers events beyond the channel.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_slow_ui_holds_events_in_the_channel() {
        let (_directory, path) = socket_directory();
        let core = FakeCore::start(&path).unwrap();
        let (bridge, mut events) = attach(&path);
        events.status().await;
        for index in 0..(EVENT_BUFFER * 2) {
            core.emit(
                "activity",
                json!({"level": "info", "message": index.to_string(), "at_ms": 0}),
            )
            .await;
        }
        let mut received = Vec::new();
        while received.len() < EVENT_BUFFER * 2 {
            if let BridgeEvent::Activity(line) = events.0.recv().await.unwrap() {
                received.push(line.message.parse::<usize>().unwrap());
            }
        }
        assert_eq!(received, (0..EVENT_BUFFER * 2).collect::<Vec<_>>());
        bridge.stop().await;
        core.stop().await;
    }
}
