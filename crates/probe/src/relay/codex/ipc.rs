//! The Codex desktop app's window-to-window IPC router, at
//! `<Codex home>/ipc/ipc.sock` while the app runs (macOS only today; the
//! socket is simply absent elsewhere).
//!
//! Wire framing: a 4-byte little-endian length, then that many bytes of
//! UTF-8 JSON. A client registers with `initialize`, asks which window owns
//! a thread (`thread-owner-discovery`), then asks that window to start a
//! turn (`thread-follower-start-turn`). Every request carries a per-method
//! `version` the app checks exactly; the numbers match Codex app build 153.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::path::Path;

/// The router connection: the app's Unix socket. On Windows the Codex app
/// would expose a named pipe whose name is not documented, so no connection
/// is attempted there (`Session::connect` reports the app not running, and
/// every route falls through to the app-server and queue routes); a
/// loopback TCP stream stands in so the framing and its tests still build.
#[cfg(unix)]
pub type IpcStream = std::os::unix::net::UnixStream;
#[cfg(windows)]
pub type IpcStream = std::net::TcpStream;
use std::time::{Duration, Instant};

/// The Codex app refuses frames larger than this.
pub const MAX_FRAME_BYTES: usize = 268_435_456;

const CLIENT_TYPE: &str = "agent-relay-desktop";
/// The router gives up on owner discovery after 12 seconds.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(12);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(5);
const START_TURN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IpcError {
    /// No Codex app is listening.
    NotRunning,
    TimedOut,
    /// The app answered and refused.
    Rejected(String),
    Io(String),
    InvalidFrameLength(usize),
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::NotRunning => write!(f, "The Codex app is not running."),
            IpcError::TimedOut => write!(f, "The Codex app did not answer in time."),
            IpcError::Rejected(reason) => write!(f, "The Codex app refused the message: {reason}"),
            IpcError::Io(reason) => write!(f, "Could not talk to the Codex app: {reason}"),
            IpcError::InvalidFrameLength(length) => {
                write!(f, "Could not talk to the Codex app: a {length}-byte frame")
            }
        }
    }
}

/// Frames a payload, refusing one the Codex app would reject.
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, IpcError> {
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(IpcError::InvalidFrameLength(payload.len()));
    }
    let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Accumulates socket bytes and hands back whole frame payloads.
#[derive(Default)]
pub struct FrameBuffer {
    pending: Vec<u8>,
}

impl FrameBuffer {
    /// Appends raw bytes and returns every payload they completed; a partial
    /// trailing frame is kept for the next call.
    pub fn append(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>, IpcError> {
        self.pending.extend_from_slice(data);
        let mut payloads = Vec::new();
        while let [a, b, c, d, ..] = self.pending.as_slice() {
            let length = u32::from_le_bytes([*a, *b, *c, *d]) as usize;
            if length == 0 || length > MAX_FRAME_BYTES {
                return Err(IpcError::InvalidFrameLength(length));
            }
            if self.pending.len() < 4 + length {
                break;
            }
            payloads.push(self.pending[4..4 + length].to_vec());
            self.pending.drain(..4 + length);
        }
        Ok(payloads)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Initialize,
    ThreadOwnerDiscovery,
    ThreadFollowerStartTurn,
}

impl Method {
    pub fn name(self) -> &'static str {
        match self {
            Method::Initialize => "initialize",
            Method::ThreadOwnerDiscovery => "thread-owner-discovery",
            Method::ThreadFollowerStartTurn => "thread-follower-start-turn",
        }
    }

    pub fn version(self) -> u32 {
        match self {
            Method::Initialize => 0,
            Method::ThreadOwnerDiscovery => 1,
            Method::ThreadFollowerStartTurn => 2,
        }
    }
}

/// One request envelope.
pub fn request(
    method: Method,
    params: Value,
    source_client: &str,
    request_id: &str,
    target_client: Option<&str>,
    timeout_ms: Option<u64>,
) -> Value {
    let mut request = json!({
        "type": "request",
        "requestId": request_id,
        "sourceClientId": source_client,
        "version": method.version(),
        "method": method.name(),
        "params": params,
    });
    if let Some(target) = target_client {
        request["targetClientId"] = json!(target);
    }
    if let Some(timeout) = timeout_ms {
        request["timeoutMs"] = json!(timeout);
    }
    request
}

pub fn owner_discovery_params(thread: &str) -> Value {
    json!({"hostId": "local", "conversationId": thread})
}

/// `hidden`, when given, goes into the model's history before the turn as
/// `compact::hidden_items` (`context.responseItems`), without showing in the
/// chat.
pub fn start_turn_params(
    thread: &str,
    text: &str,
    client_message_id: &str,
    hidden: Option<&str>,
) -> Value {
    // An empty `text` starts the turn with no visible input.
    let input = match text {
        "" => json!([]),
        text => json!([{"type": "text", "text": text, "text_elements": []}]),
    };
    let context = match hidden {
        Some(hidden) => json!({"responseItems": super::compact::hidden_items(hidden)}),
        None => json!({}),
    };
    json!({
        "conversationId": thread,
        "turnStart": {
            "request": {
                "threadId": thread,
                "clientUserMessageId": client_message_id,
                "input": input,
            },
            "context": context,
        },
    })
}

/// The reply to a client-discovery request: this client handles nothing.
pub fn discovery_decline(request_id: &str) -> Value {
    json!({
        "type": "client-discovery-response",
        "requestId": request_id,
        "response": {"canHandle": false},
    })
}

/// Anything the router sends, read leniently: only the fields the bridge
/// reads are named.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Incoming {
    pub kind: String,
    pub request_id: Option<String>,
    pub method: Option<String>,
    pub result_type: Option<String>,
    pub error: Option<String>,
    pub handled_by_client: Option<String>,
    /// `initialize` answers with the id the router gave this client.
    pub client_id: Option<String>,
    /// `thread-follower-start-turn` answers with the turn it started.
    pub turn_id: Option<String>,
    /// `thread-owner-discovery`: the owner takes `context.responseItems`.
    pub hidden_input: bool,
    pub turn_status: Option<String>,
}

impl Incoming {
    pub fn decode(payload: &[u8]) -> Option<Incoming> {
        let value: Value = serde_json::from_slice(payload).ok()?;
        let text = |v: &Value| v.as_str().map(str::to_string);
        let result = &value["result"];
        Some(Incoming {
            kind: value["type"].as_str()?.to_string(),
            request_id: text(&value["requestId"]),
            method: text(&value["method"]),
            result_type: text(&value["resultType"]),
            error: text(&value["error"]),
            handled_by_client: text(&value["handledByClientId"]),
            client_id: text(&result["clientId"]),
            turn_id: text(&result["result"]["turn"]["id"]),
            turn_status: text(&result["result"]["turn"]["status"]),
            hidden_input: result["supportsUntrustedAppInput"] == true,
        })
    }

    pub fn is_response(&self) -> bool {
        self.kind == "response"
    }

    pub fn is_client_discovery_request(&self) -> bool {
        self.kind == "client-discovery-request"
    }

    pub fn is_success(&self) -> bool {
        self.result_type.as_deref() == Some("success")
    }
}

fn io(error: std::io::Error) -> IpcError {
    IpcError::Io(error.to_string())
}

/// One blocking, registered connection to the router.
pub struct Session {
    stream: IpcStream,
    buffer: FrameBuffer,
    queued: VecDeque<Vec<u8>>,
    client_id: String,
    /// Owners whose discovery answer said they take hidden input.
    hidden_input: HashSet<String>,
}

impl Session {
    /// Connects to the router at `socket` and registers.
    #[cfg(unix)]
    pub fn connect(socket: &Path) -> Result<Session, IpcError> {
        let stream = IpcStream::connect(socket).map_err(|error| match error.kind() {
            ErrorKind::NotFound | ErrorKind::ConnectionRefused => IpcError::NotRunning,
            _ => io(error),
        })?;
        Session::register(stream)
    }

    /// No router is reachable on Windows (see `IpcStream`): the app counts
    /// as not running, which every caller already treats as "try the next
    /// route".
    #[cfg(windows)]
    pub fn connect(socket: &Path) -> Result<Session, IpcError> {
        let _ = socket;
        Err(IpcError::NotRunning)
    }

    /// Registers over an already-connected stream.
    pub fn register(stream: IpcStream) -> Result<Session, IpcError> {
        // A router that stops reading cannot hold a write past the longest
        // wait a request has.
        stream
            .set_write_timeout(Some(START_TURN_TIMEOUT))
            .map_err(io)?;
        let mut session = Session {
            stream,
            buffer: FrameBuffer::default(),
            queued: VecDeque::new(),
            client_id: String::new(),
            hidden_input: HashSet::new(),
        };
        let response = session.request(
            Method::Initialize,
            json!({"clientType": CLIENT_TYPE}),
            "initializing-client",
            None,
            None,
            INITIALIZE_TIMEOUT,
        )?;
        match response.client_id {
            Some(client) if response.is_success() => session.client_id = client,
            _ => {
                return Err(IpcError::Rejected(
                    response.error.unwrap_or_else(|| "initialize failed".into()),
                ))
            }
        }
        Ok(session)
    }

    fn send(&mut self, message: &Value) -> Result<(), IpcError> {
        let frame =
            encode_frame(&serde_json::to_vec(message).map_err(|e| IpcError::Io(e.to_string()))?)?;
        self.stream.write_all(&frame).map_err(io)
    }

    /// Sends a request and waits for the response carrying its id.
    fn request(
        &mut self,
        method: Method,
        params: Value,
        source: &str,
        target: Option<&str>,
        timeout_ms: Option<u64>,
        timeout: Duration,
    ) -> Result<Incoming, IpcError> {
        let id = crate::relay::store::random_uuid();
        self.send(&request(method, params, source, &id, target, timeout_ms))?;
        let deadline = Instant::now() + timeout;
        while let Some(message) = self.next_message(deadline)? {
            if message.is_response() && message.request_id.as_deref() == Some(id.as_str()) {
                return Ok(message);
            }
        }
        Err(IpcError::TimedOut)
    }

    /// The window that owns each of `threads`; a thread no window has open
    /// is left out.
    /// Whether `owner` said in discovery that it takes hidden input.
    pub fn takes_hidden_input(&self, owner: &str) -> bool {
        self.hidden_input.contains(owner)
    }

    pub fn owners(&mut self, threads: &[String]) -> Result<BTreeMap<String, String>, IpcError> {
        let mut by_request: HashMap<String, String> = HashMap::new();
        for thread in threads {
            let id = crate::relay::store::random_uuid();
            let message = request(
                Method::ThreadOwnerDiscovery,
                owner_discovery_params(thread),
                &self.client_id.clone(),
                &id,
                None,
                None,
            );
            self.send(&message)?;
            by_request.insert(id, thread.clone());
        }
        let mut owners = BTreeMap::new();
        let deadline = Instant::now() + DISCOVERY_TIMEOUT;
        while !by_request.is_empty() {
            let Some(message) = self.next_message(deadline)? else {
                break;
            };
            if !message.is_response() {
                continue;
            }
            let Some(thread) = message
                .request_id
                .as_deref()
                .and_then(|id| by_request.remove(id))
            else {
                continue;
            };
            if let (true, Some(owner)) = (message.is_success(), message.handled_by_client) {
                if message.hidden_input {
                    self.hidden_input.insert(owner.clone());
                }
                owners.insert(thread, owner);
            }
        }
        Ok(owners)
    }

    /// Asks `owner` to start a turn with `text` (and `hidden` model-only
    /// history); Codex records `message_id` with the message in the
    /// thread's rollout. Returns the turn id when the app reports one.
    pub fn start_turn(
        &mut self,
        thread: &str,
        text: &str,
        message_id: &str,
        owner: &str,
        hidden: Option<&str>,
    ) -> Result<Option<String>, IpcError> {
        let source = self.client_id.clone();
        let started = self.request(
            Method::ThreadFollowerStartTurn,
            start_turn_params(thread, text, message_id, hidden),
            &source,
            Some(owner),
            Some(START_TURN_TIMEOUT.as_millis() as u64),
            START_TURN_TIMEOUT + Duration::from_secs(2),
        )?;
        if !started.is_success() {
            return Err(IpcError::Rejected(
                started.error.unwrap_or_else(|| "unknown error".into()),
            ));
        }
        Ok(started.turn_id)
    }

    /// Starts a relay message's turn in `owner`'s window. With relay messages
    /// hidden (`compact::enabled`), an owner that takes hidden input gets
    /// `compact::hidden_items` in the same request and the turn starts with
    /// no visible input. A message the thread's history already holds
    /// (`compact::held`) starts empty without being hidden again; one maybe
    /// there, and anything else, is sent whole.
    pub fn start_relay_turn(
        &mut self,
        thread: &str,
        text: &str,
        message_id: &str,
        owner: &str,
    ) -> Result<Option<String>, IpcError> {
        use super::compact::{self, Held};
        match compact::held(thread, message_id) {
            Some(Held::Injected) => return self.start_turn(thread, "", message_id, owner, None),
            Some(Held::Uncertain) => return self.start_turn(thread, text, message_id, owner, None),
            None => {}
        }
        let hide = compact::enabled()
            && self.takes_hidden_input(owner)
            && compact::visible_line(text).is_some();
        if !hide {
            return self.start_turn(thread, text, message_id, owner, None);
        }
        // Remembered as on the app-server: started means the history holds
        // it; a refusal means it never reached the thread; anything else may
        // have, so it is never hidden again.
        let started = self.start_turn(thread, "", message_id, owner, Some(text));
        match &started {
            Ok(_) => compact::remember(thread, message_id, Held::Injected),
            Err(IpcError::Rejected(_)) => {}
            Err(_) => compact::remember(thread, message_id, Held::Uncertain),
        }
        started
    }

    /// The next message, or `None` once `deadline` passes. Client-discovery
    /// requests are declined here; broadcasts are returned for callers to
    /// skip.
    fn next_message(&mut self, deadline: Instant) -> Result<Option<Incoming>, IpcError> {
        loop {
            while let Some(payload) = self.queued.pop_front() {
                let Some(message) = Incoming::decode(&payload) else {
                    continue;
                };
                if message.is_client_discovery_request() {
                    if let Some(id) = message.request_id.as_deref() {
                        self.send(&discovery_decline(id))?;
                        continue;
                    }
                }
                return Ok(Some(message));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            self.stream.set_read_timeout(Some(remaining)).map_err(io)?;
            let mut chunk = vec![0u8; 65_536];
            let count = match self.stream.read(&mut chunk) {
                Ok(count) => count,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error)
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return Ok(None)
                }
                Err(error) => return Err(io(error)),
            };
            if count == 0 {
                return Err(IpcError::Io("the Codex app closed the connection".into()));
            }
            let payloads = self
                .buffer
                .append(&chunk[..count])
                .map_err(|_| IpcError::Io("received a malformed frame".into()))?;
            self.queued.extend(payloads);
        }
    }
}

/// Which of `threads` a Codex app window owns now; none when the app is
/// not running or does not answer.
pub fn open_threads(socket: &Path, threads: &[String]) -> BTreeMap<String, String> {
    if threads.is_empty() {
        return BTreeMap::new();
    }
    Session::connect(socket)
        .and_then(|mut session| session.owners(threads))
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A connected pair of router streams: a Unix socket pair, or a
    /// loopback TCP connection on Windows.
    #[cfg(unix)]
    pub fn pair() -> (IpcStream, IpcStream) {
        IpcStream::pair().unwrap()
    }

    #[cfg(windows)]
    pub fn pair() -> (IpcStream, IpcStream) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let ours = IpcStream::connect(listener.local_addr().unwrap()).unwrap();
        let (theirs, _) = listener.accept().unwrap();
        (ours, theirs)
    }

    // CodexIPCTests.testEncodesLittleEndianLengthPrefix.
    #[test]
    fn encodes_a_little_endian_length_prefix() {
        let frame = encode_frame(br#"{"a":1}"#).unwrap();
        assert_eq!(frame[..4], [7, 0, 0, 0]);
        assert_eq!(&frame[4..], br#"{"a":1}"#);
    }

    // CodexIPCTests.testEncodeRejectsEmptyAndOversizedPayloads.
    #[test]
    fn encode_rejects_empty_payloads() {
        assert_eq!(encode_frame(b""), Err(IpcError::InvalidFrameLength(0)));
    }

    // CodexIPCTests.testSplitsFramesThatArriveTogether.
    #[test]
    fn splits_frames_that_arrive_together() {
        let mut bytes = encode_frame(b"one").unwrap();
        bytes.extend(encode_frame(b"two").unwrap());
        assert_eq!(
            FrameBuffer::default().append(&bytes).unwrap(),
            [b"one".to_vec(), b"two".to_vec()]
        );
    }

    // CodexIPCTests.testKeepsPartialFrameUntilItFinishes.
    #[test]
    fn keeps_a_partial_frame_until_it_finishes() {
        let mut buffer = FrameBuffer::default();
        let frame = encode_frame(br#"{"hello":"world"}"#).unwrap();
        assert!(buffer.append(&frame[..2]).unwrap().is_empty());
        assert!(buffer.append(&frame[2..10]).unwrap().is_empty());
        assert_eq!(
            buffer.append(&frame[10..]).unwrap(),
            [br#"{"hello":"world"}"#.to_vec()]
        );
    }

    // CodexIPCTests.testRejectsEmptyAndOversizedFrames.
    #[test]
    fn rejects_empty_and_oversized_frames() {
        assert_eq!(
            FrameBuffer::default().append(&[0, 0, 0, 0]),
            Err(IpcError::InvalidFrameLength(0))
        );
        assert!(FrameBuffer::default()
            .append(&[0xFF, 0xFF, 0xFF, 0x7F])
            .is_err());
    }

    // CodexIPCTests.testStartTurnRequestMatchesTheCodexWireShape.
    #[test]
    fn the_start_turn_request_matches_the_codex_wire_shape() {
        let json = request(
            Method::ThreadFollowerStartTurn,
            start_turn_params("thread-1", "hello", "message-1", None),
            "client-1",
            "request-1",
            Some("owner-1"),
            Some(30_000),
        );
        assert_eq!(json["type"], "request");
        assert_eq!(json["requestId"], "request-1");
        assert_eq!(json["method"], "thread-follower-start-turn");
        assert_eq!(json["version"], 2);
        assert_eq!(json["targetClientId"], "owner-1");
        assert_eq!(json["timeoutMs"], 30_000);
        let params = &json["params"];
        assert_eq!(params["conversationId"], "thread-1");
        assert!(params["turnStart"]["context"].is_object());
        let turn = &params["turnStart"]["request"];
        assert_eq!(turn["threadId"], "thread-1");
        assert_eq!(turn["clientUserMessageId"], "message-1");
        let input = &turn["input"][0];
        assert_eq!(input["type"], "text");
        assert_eq!(input["text"], "hello");
        assert_eq!(input["text_elements"], json!([]));
    }

    // CodexIPCTests.testOwnerDiscoveryTargetsTheLocalHost.
    #[test]
    fn owner_discovery_targets_the_local_host() {
        let json = request(
            Method::ThreadOwnerDiscovery,
            owner_discovery_params("thread-1"),
            "client-1",
            "r",
            None,
            None,
        );
        assert_eq!(json["version"], 1);
        assert!(json.get("targetClientId").is_none());
        assert_eq!(json["params"]["hostId"], "local");
        assert_eq!(json["params"]["conversationId"], "thread-1");
    }

    // CodexIPCTests.testDecodesResponsesFromTheRouter.
    #[test]
    fn decodes_responses_from_the_router() {
        let initialize = Incoming::decode(br#"{"type":"response","requestId":"r1","resultType":"success","method":"initialize","handledByClientId":"c1","result":{"clientId":"c1"}}"#).unwrap();
        assert!(initialize.is_response() && initialize.is_success());
        assert_eq!(initialize.client_id.as_deref(), Some("c1"));
        let started = Incoming::decode(br#"{"type":"response","requestId":"r2","resultType":"success","method":"thread-follower-start-turn","handledByClientId":"o1","result":{"result":{"turn":{"id":"turn-1","items":[],"status":"inProgress","error":null}}}}"#).unwrap();
        assert_eq!(started.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(started.turn_status.as_deref(), Some("inProgress"));
        let missing = Incoming::decode(
            br#"{"type":"response","requestId":"r3","resultType":"error","error":"no-client-found"}"#,
        )
        .unwrap();
        assert!(!missing.is_success());
        assert_eq!(missing.error.as_deref(), Some("no-client-found"));
    }

    // CodexIPCTests.testDecodesDiscoveryRequestsAndBroadcasts.
    #[test]
    fn decodes_discovery_requests_and_broadcasts() {
        let discovery = Incoming::decode(br#"{"type":"client-discovery-request","requestId":"d1","request":{"type":"request","method":"ide-context"}}"#).unwrap();
        assert!(discovery.is_client_discovery_request());
        assert_eq!(discovery.request_id.as_deref(), Some("d1"));
        let broadcast = Incoming::decode(br#"{"type":"broadcast","method":"thread-stream-state-changed","params":{"conversationId":"t1"}}"#).unwrap();
        assert!(!broadcast.is_response());
        assert_eq!(
            broadcast.method.as_deref(),
            Some("thread-stream-state-changed")
        );
        assert_eq!(Incoming::decode(br#"{"requestId":"x"}"#), None);
    }

    /// An in-process stand-in for the Codex app's router: owns `owned`
    /// threads as window `owner-1`, declines nothing, starts turns unless
    /// `refuse` is set, and records the start-turn requests it saw.
    pub struct FakeRouter {
        pub owned: Vec<String>,
        pub refuse: Option<String>,
        pub started: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    }

    impl FakeRouter {
        pub fn serve(self, mut stream: IpcStream) {
            let mut buffer = FrameBuffer::default();
            let mut chunk = [0u8; 65_536];
            let send = |stream: &mut IpcStream, value: Value| {
                let _ =
                    stream.write_all(&encode_frame(&serde_json::to_vec(&value).unwrap()).unwrap());
            };
            loop {
                let Ok(count) = stream.read(&mut chunk) else {
                    return;
                };
                if count == 0 {
                    return;
                }
                for payload in buffer.append(&chunk[..count]).unwrap() {
                    let request: Value = serde_json::from_slice(&payload).unwrap();
                    let id = request["requestId"].clone();
                    match request["method"].as_str() {
                        Some("initialize") => {
                            // A discovery request and a broadcast arrive first.
                            send(
                                &mut stream,
                                json!({"type": "client-discovery-request", "requestId": "d1"}),
                            );
                            send(&mut stream, json!({"type": "broadcast", "method": "x"}));
                            send(
                                &mut stream,
                                json!({"type": "response", "requestId": id, "resultType": "success", "result": {"clientId": "relay-1"}}),
                            );
                        }
                        Some("thread-owner-discovery") => {
                            let thread = request["params"]["conversationId"].as_str().unwrap();
                            let owned = self.owned.iter().any(|t| t == thread);
                            send(
                                &mut stream,
                                if owned {
                                    json!({"type": "response", "requestId": id, "resultType": "success", "handledByClientId": "owner-1", "result": {"supportsUntrustedAppInput": true}})
                                } else {
                                    json!({"type": "response", "requestId": id, "resultType": "error", "error": "no-client-found"})
                                },
                            );
                        }
                        Some("thread-follower-start-turn") => {
                            self.started.lock().unwrap().push(request.clone());
                            send(
                                &mut stream,
                                match &self.refuse {
                                    Some(reason) => {
                                        json!({"type": "response", "requestId": id, "resultType": "error", "error": reason})
                                    }
                                    None => {
                                        json!({"type": "response", "requestId": id, "resultType": "success", "result": {"result": {"turn": {"id": "turn-1"}}}})
                                    }
                                },
                            );
                        }
                        _ => {
                            // The decline for the discovery request.
                            assert_eq!(request["type"], "client-discovery-response");
                            assert_eq!(request["response"]["canHandle"], false);
                        }
                    }
                }
            }
        }
    }

    // Hidden history rides in `context.responseItems`, as Codex.app's own
    // follower turns send it; the visible input is the text alone.
    #[test]
    fn a_start_turn_with_hidden_history_carries_it_as_response_items() {
        let params = start_turn_params("thread-1", "line", "m1", Some("whole message"));
        let turn = &params["turnStart"];
        assert_eq!(turn["request"]["input"][0]["text"], "line");
        assert_eq!(
            turn["context"]["responseItems"],
            crate::relay::codex::compact::hidden_items("whole message")
        );
        assert_eq!(
            start_turn_params("thread-1", "line", "m1", None)["turnStart"]["context"],
            json!({})
        );
    }

    // CodexBridge.Session.owners / startTurn against a router.
    #[test]
    fn a_session_finds_owners_and_starts_turns() {
        let (ours, theirs) = pair();
        let started = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let router = FakeRouter {
            owned: vec!["thread-1".into()],
            refuse: None,
            started: started.clone(),
        };
        let server = std::thread::spawn(move || router.serve(theirs));
        let mut session = Session::register(ours).unwrap();
        let owners = session
            .owners(&["thread-1".to_string(), "thread-2".to_string()])
            .unwrap();
        assert_eq!(
            owners,
            BTreeMap::from([("thread-1".into(), "owner-1".into())])
        );
        assert!(session.takes_hidden_input("owner-1"));
        assert!(!session.takes_hidden_input("owner-2"));
        let turn = session
            .start_turn("thread-1", "hello", "m1", "owner-1", None)
            .unwrap();
        assert_eq!(turn.as_deref(), Some("turn-1"));
        let request = started.lock().unwrap()[0].clone();
        assert_eq!(request["sourceClientId"], "relay-1");
        assert_eq!(request["targetClientId"], "owner-1");
        assert_eq!(
            request["params"]["turnStart"]["request"]["clientUserMessageId"],
            "m1"
        );
        drop(session);
        server.join().unwrap();
    }

    // Bugbot #510: a relay turn in a window hides a fresh message (the mailbox
    // and the relay route share this) behind an empty input, and starts an
    // already injected one empty, without hiding it again.
    #[test]
    fn a_relay_turn_hides_a_fresh_message_and_not_an_injected_one() {
        use crate::relay::codex::compact;
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (ours, theirs) = pair();
        let started = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let router = FakeRouter {
            owned: vec!["thread-1".into()],
            refuse: None,
            started: started.clone(),
        };
        let server = std::thread::spawn(move || router.serve(theirs));
        let mut session = Session::register(ours).unwrap();
        session.owners(&["thread-1".to_string()]).unwrap();
        let relayed = |id: &str| {
            format!(
                "[via Agent Relay — from @alice (alice@host-1) · ref {}]\n\
                 [reply: send_relay_message to=\"alice@host-1\"]\n\nhi",
                crate::relay::delivery::policy::MessageRef::of(id)
            )
        };
        let fresh = relayed("ipc-fresh-1");
        session
            .start_relay_turn("thread-1", &fresh, "ipc-fresh-1", "owner-1")
            .unwrap();
        compact::remember("thread-1", "ipc-injected-1", compact::Held::Injected);
        compact::remember("thread-1", "ipc-uncertain-1", compact::Held::Uncertain);
        let injected = relayed("ipc-injected-1");
        session
            .start_relay_turn("thread-1", &injected, "ipc-injected-1", "owner-1")
            .unwrap();
        session
            .start_relay_turn(
                "thread-1",
                "hello from the person",
                "ipc-plain-1",
                "owner-1",
            )
            .unwrap();
        let uncertain = relayed("ipc-uncertain-1");
        session
            .start_relay_turn("thread-1", &uncertain, "ipc-uncertain-1", "owner-1")
            .unwrap();
        drop(session);
        server.join().unwrap();
        let turns: Vec<Value> = started
            .lock()
            .unwrap()
            .iter()
            .map(|r| r["params"]["turnStart"].clone())
            .collect();
        assert_eq!(turns[0]["request"]["input"], json!([]));
        assert_eq!(
            turns[0]["context"]["responseItems"],
            compact::hidden_items(&fresh)
        );
        assert_eq!(turns[1]["request"]["input"], json!([]));
        assert_eq!(turns[1]["context"], json!({}));
        assert_eq!(
            turns[2]["request"]["input"][0]["text"],
            "hello from the person"
        );
        assert_eq!(turns[2]["context"], json!({}));
        // Maybe injected: whole and visible, never hidden again.
        assert_eq!(turns[3]["request"]["input"][0]["text"], uncertain.as_str());
        assert_eq!(turns[3]["context"], json!({}));
    }

    // Bugbot #510: a window hide is remembered as on the app-server, so a
    // retry never sends the hidden items again; a refusal left nothing.
    #[test]
    fn a_window_hide_is_remembered_and_a_refusal_is_not() {
        use crate::relay::codex::compact;
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let relayed = |id: &str| {
            format!(
                "[via Agent Relay — from @alice · ref {}]\n\nhi",
                crate::relay::delivery::policy::MessageRef::of(id)
            )
        };
        for (refuse, id, held) in [
            (None, "window-remember-1", Some(compact::Held::Injected)),
            (Some("thread is busy".to_string()), "window-refused-1", None),
        ] {
            let (ours, theirs) = pair();
            let router = FakeRouter {
                owned: vec!["thread-r".into()],
                refuse,
                started: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            };
            let server = std::thread::spawn(move || router.serve(theirs));
            let mut session = Session::register(ours).unwrap();
            session.owners(&["thread-r".to_string()]).unwrap();
            let _ = session.start_relay_turn("thread-r", &relayed(id), id, "owner-1");
            drop(session);
            server.join().unwrap();
            assert_eq!(compact::held("thread-r", id), held, "{id}");
        }
    }

    #[test]
    fn an_absent_socket_is_not_running() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            Session::connect(&home.path().join("ipc.sock")).err(),
            Some(IpcError::NotRunning)
        );
        assert!(open_threads(&home.path().join("ipc.sock"), &["t".into()]).is_empty());
    }
}
