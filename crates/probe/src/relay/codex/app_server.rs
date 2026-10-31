//! The shared Codex app-server (used by the Codex app and VS Code), reached
//! through `codex app-server proxy`: WebSocket over the proxy's stdio, then
//! JSON-RPC. Its loaded-thread list (`thread/loaded/list`) is the host
//! ownership check: a thread it has loaded can take a turn (`turn/start`)
//! now. Only a registered native spawn may resume an unloaded thread.

mod delivery;
pub mod recovery;
mod websocket;
pub use delivery::{send_if_loaded, send_spawned, send_to_spawned};
use websocket::control_frame;
pub use websocket::{frame, upgrade_request, Decoder, Malformed};

use super::runner::ProxyStream;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{self, ErrorKind};
use std::time::{Duration, Instant};

pub mod drive;

/// The JSON-RPC ids of the requests this client sends.
const LOADED_ID: i64 = 2;
const TURN_ID: i64 = 3;
const INJECT_ID: i64 = 4;
const THREAD_ID: i64 = 5;
const MCP_THREAD_ID: i64 = 6;
const ARCHIVE_ID: i64 = 7;
const RESUME_ID: i64 = 8;
/// Ids for the pages of the configured MCP server list.
const MCP_LIST_ID: i64 = 10;
/// The most pages of MCP servers read before giving up.
const MCP_LIST_PAGES: i64 = 20;

/// How long a liveness check waits for the loaded-thread list.
pub const LOADED_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a send waits for the list, and then for the turn to start.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(12);

/// The threads a `thread/loaded/list` response (id 2) names.
pub fn decode_loaded(payload: &[u8]) -> Option<BTreeSet<String>> {
    let value: Value = serde_json::from_slice(payload).ok()?;
    if value["id"].as_i64() != Some(LOADED_ID) {
        return None;
    }
    let data = value["result"]["data"].as_array()?;
    Some(
        data.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    )
}

fn random<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).map_err(|_| io::Error::other("no random source"))?;
    Ok(bytes)
}

/// A JSON-RPC client over the proxy stream.
struct Client<'a> {
    stream: &'a mut dyn ProxyStream,
    decoder: Decoder,
    responses: Vec<Value>,
    requests: Vec<Value>,
    notifications: Vec<Value>,
}

#[derive(Default)]
struct ClientState {
    decoder: Decoder,
    responses: Vec<Value>,
    requests: Vec<Value>,
    notifications: Vec<Value>,
}

impl<'a> Client<'a> {
    /// Upgrades the proxy to WebSocket and initializes, by `deadline`.
    fn open(stream: &'a mut dyn ProxyStream, deadline: Instant) -> io::Result<Client<'a>> {
        stream.write_all(&upgrade_request(&random()?), deadline)?;
        let mut client = Client {
            stream,
            decoder: Decoder::default(),
            responses: Vec::new(),
            requests: Vec::new(),
            notifications: Vec::new(),
        };
        while !client.decoder.is_upgraded() {
            client.read(deadline)?;
        }
        client.send(
            &json!({"method": "initialize", "id": 1, "params": {"clientInfo": {
                "name": "agent-relay-desktop", "title": "Agent Relay", "version": crate::VERSION,
            }}}),
            deadline,
        )?;
        client.send(&json!({"method": "initialized", "params": {}}), deadline)?;
        Ok(client)
    }

    fn send(&mut self, message: &Value, deadline: Instant) -> io::Result<()> {
        let payload = serde_json::to_vec(message).map_err(io::Error::other)?;
        self.stream.write_all(&frame(&payload, random()?), deadline)
    }

    fn read(&mut self, deadline: Instant) -> io::Result<()> {
        if self.decoder.is_closed() {
            return Err(io::Error::new(
                ErrorKind::UnexpectedEof,
                "Codex app-server closed the proxy",
            ));
        }
        let chunk = self.stream.read(deadline)?;
        if chunk.is_empty() {
            return Err(io::Error::new(
                ErrorKind::UnexpectedEof,
                "Codex app-server closed the proxy",
            ));
        }
        let payloads = self.decoder.consume(&chunk).map_err(|_| {
            io::Error::new(
                ErrorKind::InvalidData,
                "Codex sent a malformed WebSocket frame",
            )
        })?;
        for ping in self.decoder.take_pings() {
            self.stream.write_all(
                &control_frame(0x0A, &ping, random()?),
                Instant::now() + Duration::from_secs(1),
            )?;
        }
        for value in payloads
            .iter()
            .filter_map(|payload| serde_json::from_slice::<Value>(payload).ok())
        {
            if value.get("id").is_some() && value.get("method").and_then(Value::as_str).is_some() {
                self.requests.push(value);
            } else if value["id"].is_i64() {
                self.responses.push(value);
            } else if value.get("method").and_then(Value::as_str).is_some() {
                self.notifications.push(value);
            }
        }
        Ok(())
    }

    fn into_state(self) -> ClientState {
        ClientState {
            decoder: self.decoder,
            responses: self.responses,
            requests: self.requests,
            notifications: self.notifications,
        }
    }

    /// The response to request `id`, by `deadline`.
    fn response(&mut self, id: i64, deadline: Instant) -> io::Result<Value> {
        loop {
            if let Some(at) = self
                .responses
                .iter()
                .position(|r| r["id"].as_i64() == Some(id))
            {
                return Ok(self.responses.remove(at));
            }
            self.read(deadline)?;
        }
    }

    fn loaded(&mut self, deadline: Instant) -> io::Result<BTreeSet<String>> {
        self.send(
            &json!({"method": "thread/loaded/list", "id": LOADED_ID, "params": {"limit": 1_000}}),
            deadline,
        )?;
        let response = self.response(LOADED_ID, deadline)?;
        decode_loaded(&serde_json::to_vec(&response).map_err(io::Error::other)?).ok_or_else(|| {
            io::Error::new(ErrorKind::InvalidData, "an unreadable loaded-thread list")
        })
    }
}

/// The threads the app-server has loaded; none when it cannot say by
/// `timeout` (no daemon, an older one, a slow one).
pub fn loaded_threads(stream: &mut dyn ProxyStream, timeout: Duration) -> BTreeSet<String> {
    let deadline = Instant::now() + timeout;
    Client::open(stream, deadline)
        .and_then(|mut client| client.loaded(deadline))
        .unwrap_or_default()
}

/// Change provider metadata for a stored or loaded thread without resuming it
/// or starting a turn. A timeout is ambiguous and is never retried here.
pub fn set_thread_name(stream: &mut dyn ProxyStream, thread_id: &str, title: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut client = Client::open(stream, deadline)
        .map_err(|_| "Could not connect to Codex. Open Codex and try again.".to_string())?;
    client.send(&json!({"method":"thread/name/set", "id":31,
        "params":{"threadId":thread_id,"name":title}}), deadline)
        .map_err(|_| "Codex did not confirm the title update. Refresh the session before retrying.".to_string())?;
    let response = client.response(31, deadline)
        .map_err(|_| "Codex did not confirm the title update. Refresh the session before retrying.".to_string())?;
    if response.get("error").is_some_and(|error| !error.is_null()) {
        return Err("Codex refused the title update. Check that the thread still exists and your Codex version supports renaming.".into());
    }
    if !response.get("result").is_some_and(Value::is_object) {
        return Err("Codex returned an invalid title update.".into());
    }
    Ok(())
}

/// Why a turn did not certainly start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnError {
    /// The host answered and refused the turn: it did not start.
    Refused(String),
    /// The turn request may have reached the host: never send it again.
    InDoubt(String),
}

impl std::fmt::Display for TurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TurnError::Refused(reason) | TurnError::InDoubt(reason) => f.write_str(reason),
        }
    }
}

/// The turn's visible input, and whether the thread's history already holds
/// the whole message. A hidden relay message (`compact::enabled`, with an
/// attribution line) goes into that history first (`compact::hidden_items`)
/// and its turn starts with no visible input, so the chat shows nothing of
/// it; one injected before, whose turn failed, starts empty again without
/// being injected twice. `None` drops the connection: an injection frame not
/// wholly written, or one Codex never answers, leaves it unusable or the
/// injection in doubt, so no turn frame may follow on it. An unanswered
/// injection is remembered as uncertain and never sent again: every later
/// try sends the message whole. Only an explicit refusal (an older Codex)
/// sends the whole text here.
fn turn_input(
    client: &mut Client,
    thread: &str,
    text: &str,
    message_id: &str,
    hide: bool,
) -> Option<(Value, bool)> {
    use super::compact::Held;
    let whole = || json!([{"type": "text", "text": text}]);
    match super::compact::held(thread, message_id) {
        Some(Held::Injected) => return Some((json!([]), true)),
        Some(Held::Uncertain) => return Some((whole(), false)),
        None => {}
    }
    if !hide || super::compact::visible_line(text).is_none() {
        return Some((whole(), false));
    }
    let inject = json!({"method": "thread/inject_items", "id": INJECT_ID, "params": {
        "threadId": thread,
        "items": super::compact::hidden_items(text),
    }});
    let deadline = Instant::now() + LOADED_TIMEOUT;
    // A frame not wholly written never reached the thread: the host acts on
    // whole frames only.
    client.send(&inject, deadline).ok()?;
    let Ok(response) = client.response(INJECT_ID, deadline) else {
        super::compact::remember(thread, message_id, Held::Uncertain);
        return None;
    };
    if response.get("error").is_some_and(|error| !error.is_null()) {
        return Some((whole(), false));
    }
    super::compact::remember(thread, message_id, Held::Injected);
    Some((json!([]), true))
}

/// How `send_if_loaded` treats a relay message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hide {
    /// Sent whole and visible.
    Never,
    /// Hidden when Codex takes the injection, otherwise sent whole.
    IfAble,
    /// Hidden or not at all: one that would go whole (an older Codex
    /// refused the injection, or it has no attribution line) gets
    /// `Ok(false)` before any turn starts, so the caller can go elsewhere.
    Only,
}

/// Sends `turn/start` with `input` and waits for the host's answer:
/// `Ok(false)` when the request could not be written whole (a frame whose
/// write failed or ran out of time is incomplete, and the host acts on whole
/// frames only; the proxy is stopped with it) and the message was not
/// `injected` into the history first; after that, anything but a confirmed
/// turn is an error.
fn start_turn(
    client: &mut Client,
    thread: &str,
    input: Value,
    injected: bool,
    message_id: &str,
    timeout: Duration,
) -> Result<bool, TurnError> {
    let turn = json!({"method": "turn/start", "id": TURN_ID, "params": {
        "threadId": thread, "clientUserMessageId": message_id, "input": input,
    }});
    let turn_deadline = Instant::now() + timeout;
    if client.send(&turn, turn_deadline).is_err() {
        // Once the history holds the message, no other route may send it
        // whole: only this turn is tried again, still empty.
        return match injected {
            true => Err(TurnError::Refused(
                "Codex took the message but its turn did not start".into(),
            )),
            false => Ok(false),
        };
    }
    let response = client
        .response(TURN_ID, turn_deadline)
        .map_err(|error| match error.kind() {
            ErrorKind::TimedOut => TurnError::InDoubt("Codex did not confirm the turn".into()),
            _ => TurnError::InDoubt(error.to_string()),
        })?;
    // Only an error the host spelled out is a refusal; anything else
    // (`"error": null`, an unknown shape) does not say the turn did not start.
    if let Some(error) = response
        .get("error")
        .filter(|error| error.is_object() || error.is_string())
    {
        return Err(TurnError::Refused(refusal(error, "Codex refused the turn")));
    }
    if !response["result"].is_object() {
        return Err(TurnError::InDoubt(
            "Codex returned an unreadable turn response".into(),
        ));
    }
    Ok(true)
}

fn refusal(error: &Value, fallback: &str) -> String {
    error["message"]
        .as_str()
        .map(str::to_string)
        .or_else(|| error.as_str().map(str::to_string))
        .unwrap_or_else(|| fallback.into())
}

/// How a spawned thread may act. Its approval requests are routed over Relay;
/// full access also lifts the sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Workspace,
    Full,
}

/// A thread [`start_thread`] created, and how its first turn went.
#[derive(Debug)]
pub struct StartedThread {
    pub thread_id: String,
    pub turn: Result<(), TurnError>,
}

/// The names of the MCP servers the app-server's own configuration has,
/// all pages (`mcpServerStatus/list` with no thread). Only names are kept;
/// the answer carries no headers or other credentials.
fn mcp_server_names(client: &mut Client, deadline: Instant) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..MCP_LIST_PAGES {
        let id = MCP_LIST_ID + page;
        client.send(
            &json!({"method": "mcpServerStatus/list", "id": id, "params": {
                "detail": "toolsAndAuthOnly", "cursor": cursor,
            }}),
            deadline,
        )?;
        let response = client.response(id, deadline)?;
        let unreadable = || io::Error::new(ErrorKind::InvalidData, "an unreadable MCP server list");
        let result = response
            .get("result")
            .filter(|r| r.is_object())
            .ok_or_else(unreadable)?;
        for server in result["data"].as_array().ok_or_else(unreadable)? {
            names.push(server["name"].as_str().ok_or_else(unreadable)?.to_string());
        }
        match result["nextCursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => return Ok(names),
        }
    }
    Err(io::Error::other("too many MCP servers to list"))
}

/// How a spawned thread is kept from the person's own MCP servers: every
/// server their Codex configuration names is turned off for the thread, and
/// the thread must then report none running before it gets a turn.
pub struct McpIsolation<'a> {
    /// The thread `config` override that turns the named servers off.
    pub disable: &'a dyn Fn(&[String]) -> Value,
    /// Whether a `mcpServerStatus/list` answer for the thread shows no
    /// server running; false whenever it cannot tell.
    pub none_active: &'a dyn Fn(&str) -> bool,
}

/// What a thread start does beyond starting the thread.
#[derive(Clone, Copy, Default)]
pub struct StartOptions<'a> {
    /// Keeps the thread from the person's MCP servers, or archives it.
    pub isolation: Option<&'a McpIsolation<'a>>,
    /// Told the thread's id once it is usable, before its first turn, so a
    /// caller that stops in between still knows the thread.
    pub created: Option<&'a dyn Fn(&str)>,
}

/// Starts a new thread in `directory` on the app-server and its first turn
/// with `text`. Later turns use [`send_to_spawned`], since the app-server
/// may unload an idle thread after this client goes. An error means
/// no usable thread: none was created, or, with `isolation`, the thread
/// could not be shown free of the person's MCP servers and was archived
/// before any turn.
pub fn start_thread(
    stream: &mut dyn ProxyStream,
    directory: &str,
    access: Access,
    text: &str,
    message_id: &str,
    timeout: Duration,
    options: StartOptions,
) -> io::Result<StartedThread> {
    start_thread_state(
        stream, directory, access, text, message_id, timeout, options,
    )
    .map(|(started, _)| started)
}

fn start_thread_state(
    stream: &mut dyn ProxyStream,
    directory: &str,
    access: Access,
    text: &str,
    message_id: &str,
    timeout: Duration,
    options: StartOptions<'_>,
) -> io::Result<(StartedThread, ClientState)> {
    let isolation = options.isolation;
    let deadline = Instant::now() + timeout;
    let mut client = Client::open(stream, deadline)?;
    let sandbox = match access {
        Access::Workspace => "workspace-write",
        Access::Full => "danger-full-access",
    };
    let config = match isolation {
        Some(isolation) => {
            let names = mcp_server_names(&mut client, deadline)?;
            Some((isolation.disable)(&names))
        }
        None => None,
    };
    client.send(
        &json!({"method": "thread/start", "id": THREAD_ID, "params": {
            "cwd": directory, "approvalPolicy": "on-request", "sandbox": sandbox,
            "serviceName": "agent-relay-desktop", "config": config,
        }}),
        deadline,
    )?;
    let response = client.response(THREAD_ID, deadline)?;
    if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
        return Err(io::Error::other(refusal(
            error,
            "Codex refused to start a thread",
        )));
    }
    let thread_id = response["result"]["thread"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidData, "Codex returned no thread id"))?
        .to_string();
    if let Some(isolation) = isolation {
        let isolated = client
            .send(
                &json!({"method": "mcpServerStatus/list", "id": MCP_THREAD_ID, "params": {
                    "threadId": thread_id, "detail": "toolsAndAuthOnly",
                }}),
                deadline,
            )
            .and_then(|()| client.response(MCP_THREAD_ID, deadline))
            .ok()
            .and_then(|answer| serde_json::to_string(&answer).ok())
            .is_some_and(|answer| (isolation.none_active)(&answer));
        if !isolated {
            // Never left usable: archived before it ever had a turn.
            let _ = client.send(
                &json!({"method": "thread/archive", "id": ARCHIVE_ID,
                    "params": {"threadId": thread_id}}),
                deadline,
            );
            let _ = client.response(ARCHIVE_ID, deadline);
            return Err(io::Error::other(
                "the thread could not be shown free of the person's own MCP servers",
            ));
        }
    }
    if let Some(created) = options.created {
        created(&thread_id);
    }
    let input = json!([{"type": "text", "text": text}]);
    let turn = match start_turn(&mut client, &thread_id, input, false, message_id, timeout) {
        Ok(true) => Ok(()),
        Ok(false) => Err(TurnError::Refused("Codex's app-server stopped".into())),
        Err(error) => Err(error),
    };
    Ok((StartedThread { thread_id, turn }, client.into_state()))
}

pub fn start_spawned_thread(
    mut stream: Box<dyn ProxyStream>,
    directory: &str,
    access: Access,
    text: &str,
    message_id: &str,
    timeout: Duration,
    options: StartOptions<'_>,
) -> io::Result<StartedThread> {
    let (started, state) = start_thread_state(
        stream.as_mut(),
        directory,
        access,
        text,
        message_id,
        timeout,
        options,
    )?;
    if matches!(&started.turn, Ok(()) | Err(TurnError::InDoubt(_))) {
        if let Some(claim) = drive::claim(&started.thread_id) {
            drive::start(stream, state, claim);
        }
    }
    Ok(started)
}

/// Archives a spawned agent's thread when it is released: it ends, and stays
/// among the person's archived Codex threads.
pub fn archive_thread(
    stream: &mut dyn ProxyStream,
    thread_id: &str,
    timeout: Duration,
) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    let mut client = Client::open(stream, deadline)?;
    client.send(
        &json!({"method": "thread/archive", "id": ARCHIVE_ID,
            "params": {"threadId": thread_id}}),
        deadline,
    )?;
    let response = client.response(ARCHIVE_ID, deadline)?;
    if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
        return Err(io::Error::other(refusal(
            error,
            "Codex refused to archive the thread",
        )));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    mod spawned;
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    pub const UPGRADED: &[u8] =
        b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";

    /// An unmasked server text frame.
    pub fn server_frame(value: &Value) -> Vec<u8> {
        let payload = serde_json::to_vec(value).unwrap();
        let mut frame = vec![0x81];
        if payload.len() < 126 {
            frame.push(payload.len() as u8);
        } else {
            frame.push(126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        frame.extend(payload);
        frame
    }

    /// How a fake app-server answers one request: the bytes it sends back.
    pub type Answer = Box<dyn Fn(&Value) -> Option<Vec<u8>> + Send>;

    #[test]
    fn title_update_is_metadata_only_and_requires_provider_acknowledgment() {
        for response in [json!({"id":31,"result":{}}), json!({"id":31,"error":{"code":-32601,"message":"secret provider error"}}), json!({"id":31,"result":null})] {
            let success = response["result"].is_object();
            let mut server = FakeAppServer::new(move |request| {
                (request["method"] == "thread/name/set").then(|| server_frame(&response))
            });
            let outcome = set_thread_name(&mut server, "thread-identity", "Fix \"login\"", Duration::from_secs(1));
            assert_eq!(outcome.is_ok(), success);
            if let Err(error) = outcome { assert!(!error.contains("secret")); }
            let seen = server.seen.lock().unwrap();
            let methods: Vec<_> = seen.iter().filter_map(|v| v["method"].as_str()).collect();
            assert_eq!(methods, ["initialize", "initialized", "thread/name/set"]);
            let rename = seen.iter().find(|v| v["method"] == "thread/name/set").unwrap();
            assert_eq!(rename["params"], json!({"threadId":"thread-identity","name":"Fix \"login\""}));
        }
    }

    /// A scripted app-server: answers each request it decodes from the
    /// client's frames with `answer`, and records them.
    pub struct FakeAppServer {
        pub answer: Answer,
        pub upgrade: Vec<u8>,
        pub seen: Arc<Mutex<Vec<Value>>>,
        pending: VecDeque<Vec<u8>>,
        inbound: Vec<u8>,
        /// Whether a write fails (the proxy died).
        pub broken_writes: bool,
    }

    impl FakeAppServer {
        pub fn new(answer: impl Fn(&Value) -> Option<Vec<u8>> + Send + 'static) -> FakeAppServer {
            FakeAppServer {
                answer: Box::new(answer),
                upgrade: UPGRADED.to_vec(),
                seen: Arc::default(),
                pending: VecDeque::new(),
                inbound: Vec::new(),
                broken_writes: false,
            }
        }

        /// One that has `loaded` loaded and answers `turn/start` with `turn`.
        pub fn hosting(loaded: &[&str], turn: Option<Value>) -> FakeAppServer {
            let loaded: Vec<String> = loaded.iter().map(|s| s.to_string()).collect();
            FakeAppServer::new(move |request| match request["method"].as_str() {
                Some("thread/loaded/list") => Some(server_frame(
                    &json!({"id": 2, "result": {"data": loaded, "nextCursor": null}}),
                )),
                Some("turn/start") => turn.as_ref().map(server_frame),
                _ => None,
            })
        }
    }

    impl ProxyStream for FakeAppServer {
        fn write_all(&mut self, bytes: &[u8], _deadline: Instant) -> io::Result<()> {
            if self.broken_writes {
                return Err(io::Error::new(ErrorKind::BrokenPipe, "proxy exited"));
            }
            if bytes.starts_with(b"GET / HTTP/1.1") {
                let upgrade = std::mem::take(&mut self.upgrade);
                self.pending.push_back(upgrade);
                return Ok(());
            }
            self.inbound.extend_from_slice(bytes);
            // Client frames: masked, short or 16-bit lengths in tests.
            while self.inbound.len() >= 2 {
                let mut length = (self.inbound[1] & 0x7F) as usize;
                let mut offset = 2;
                if length == 126 {
                    length = u16::from_be_bytes([self.inbound[2], self.inbound[3]]) as usize;
                    offset = 4;
                }
                assert_ne!(self.inbound[1] & 0x80, 0, "client frames are masked");
                let mask: [u8; 4] = self.inbound[offset..offset + 4].try_into().unwrap();
                let payload: Vec<u8> = self.inbound[offset + 4..offset + 4 + length]
                    .iter()
                    .enumerate()
                    .map(|(i, b)| b ^ mask[i % 4])
                    .collect();
                self.inbound.drain(..offset + 4 + length);
                let request: Value = serde_json::from_slice(&payload).unwrap();
                self.seen.lock().unwrap().push(request.clone());
                if let Some(reply) = (self.answer)(&request) {
                    self.pending.push_back(reply);
                }
            }
            Ok(())
        }

        fn read(&mut self, _deadline: Instant) -> io::Result<Vec<u8>> {
            self.pending
                .pop_front()
                .ok_or_else(|| io::Error::new(ErrorKind::TimedOut, "no answer"))
        }
    }

    // OutboundTests.testDecodesLoadedCodexThreadsResponse and
    // test_decodes_loaded_codex_thread_response.
    #[test]
    fn decodes_the_loaded_threads_response() {
        assert_eq!(
            decode_loaded(br#"{"id":2,"result":{"data":["one","two"],"nextCursor":null}}"#),
            Some(BTreeSet::from(["one".to_string(), "two".to_string()]))
        );
        assert_eq!(
            decode_loaded(br#"{"id":1,"result":{"data":["one"]}}"#),
            None
        );
    }

    // OutboundTests.testCodexAppServerWebSocketHandshakeAndFrames.
    #[test]
    fn the_websocket_handshake_and_frames() {
        let request = String::from_utf8(upgrade_request(&[1; 16])).unwrap();
        assert!(request.starts_with("GET / HTTP/1.1\r\n"));
        assert!(request.contains("Upgrade: websocket\r\n"));
        assert!(request.contains("Sec-WebSocket-Key: AQEBAQEBAQEBAQEBAQEBAQ==\r\n"));
        let payload = br#"{"id":2,"result":{"data":["one","two"]}}"#;
        let client = frame(payload, [1, 2, 3, 4]);
        assert_eq!(client[0], 0x81);
        assert_ne!(client[1] & 0x80, 0);
        let mut decoder = Decoder::default();
        let mut bytes = UPGRADED.to_vec();
        bytes.extend([0x81, payload.len() as u8]);
        bytes.extend_from_slice(payload);
        assert_eq!(decoder.consume(&bytes).unwrap(), [payload.to_vec()]);
        assert!(decoder.is_upgraded());
        assert!(decoder.buffered().is_empty());
        // A masked frame decodes back to its payload.
        let mut decoder = Decoder::default();
        decoder.consume(UPGRADED).unwrap();
        assert_eq!(decoder.consume(&client).unwrap(), [payload.to_vec()]);
    }

    // OutboundTests.testCodexAppServerWebSocketDecoderBuffersPartialFrame and
    // test_websocket_codec_masks_client_frames_and_buffers_server_frames.
    #[test]
    fn the_decoder_buffers_a_partial_frame() {
        let mut decoder = Decoder::default();
        let mut bytes = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n".to_vec();
        bytes.extend([0x81, 5, 0x7B]);
        assert!(decoder.consume(&bytes).unwrap().is_empty());
        assert!(decoder.is_upgraded());
        assert_eq!(decoder.buffered(), [0x81, 5, 0x7B]);
        assert_eq!(decoder.consume(b"\"a\":").unwrap(), [b"{\"a\":".to_vec()]);
        // Longer frames use the 16- and 64-bit lengths.
        let long = vec![b'x'; 70_000];
        let client = frame(&long, [9, 8, 7, 6]);
        assert_eq!(client[1], 127 | 0x80);
        assert_eq!(
            decoder.consume(&client[..100]).unwrap(),
            Vec::<Vec<u8>>::new()
        );
        assert_eq!(decoder.consume(&client[100..]).unwrap(), [long]);
        assert_eq!(frame(&[b'y'; 300], [0; 4])[1], 126 | 0x80);
    }

    #[test]
    fn every_frame_header_boundary_can_arrive_in_a_separate_chunk() {
        for length in [0, 125, 126, 65_535, 65_536] {
            let payload = vec![b'x'; length];
            let client = frame(&payload, [1, 2, 3, 4]);
            let header_length = match length {
                0..=125 => 2,
                126..=65_535 => 4,
                _ => 10,
            };
            let mut server = client[..header_length].to_vec();
            server[1] &= 0x7f;
            server.extend_from_slice(&payload);
            for wire in [&client, &server] {
                let payload_start = wire.len() - length;
                let splits = (0..=payload_start).chain([
                    wire.len() / 2,
                    wire.len().saturating_sub(1),
                    wire.len(),
                ]);
                for split in splits {
                    let mut decoder = Decoder::default();
                    decoder.consume(UPGRADED).unwrap();
                    let mut decoded = decoder.consume(&wire[..split]).unwrap();
                    if split < wire.len() {
                        assert!(decoded.is_empty());
                        assert_eq!(decoder.buffered(), &wire[..split]);
                    }
                    decoded.extend(decoder.consume(&wire[split..]).unwrap());
                    assert_eq!(decoded, [payload.clone()], "length={length}, split={split}");
                    assert!(decoder.buffered().is_empty());
                }
            }
        }
    }

    #[test]
    fn a_long_lived_client_can_answer_websocket_pings() {
        let mut decoder = Decoder::default();
        let mut data = UPGRADED.to_vec();
        data.extend([0x89, 1, b'p']);
        assert!(decoder.consume(&data).unwrap().is_empty());
        assert_eq!(decoder.take_pings(), vec![b"p".to_vec()]);
        let pong = control_frame(0x0A, b"p", [1, 2, 3, 4]);
        assert_eq!(pong[0], 0x8A);
        assert_eq!(pong[1], 0x81);
    }

    #[test]
    fn the_decoder_refuses_what_it_does_not_accept() {
        let refused = b"HTTP/1.1 400 Bad Request\r\n\r\n";
        assert_eq!(Decoder::default().consume(refused), Err(Malformed));
        let no_upgrade = b"HTTP/1.1 101 Switching Protocols\r\nConnection: x\r\n\r\n";
        assert_eq!(Decoder::default().consume(no_upgrade), Err(Malformed));
        let mut fragmented = UPGRADED.to_vec();
        fragmented.extend([0x01, 1, b'x']);
        assert_eq!(Decoder::default().consume(&fragmented), Err(Malformed));
        let mut huge = UPGRADED.to_vec();
        huge.extend([0x81, 127]);
        huge.extend((websocket::MAX_FRAME + 1).to_be_bytes());
        assert_eq!(Decoder::default().consume(&huge), Err(Malformed));
        // A close frame ends the stream; nothing after it is read.
        let mut closed = UPGRADED.to_vec();
        closed.extend([0x88, 0, 0x81, 1, b'x']);
        let mut decoder = Decoder::default();
        assert!(decoder.consume(&closed).unwrap().is_empty());
        assert!(decoder.is_closed());
    }

    #[test]
    fn control_frame_limits_survive_chunked_headers() {
        for opcode in [0x08, 0x09, 0x0a] {
            let oversized = control_frame(opcode, &[b'x'; 126], [1, 2, 3, 4]);
            let mut decoder = Decoder::default();
            decoder.consume(UPGRADED).unwrap();
            assert!(decoder.consume(&oversized[..3]).unwrap().is_empty());
            assert_eq!(decoder.consume(&oversized[3..4]), Err(Malformed));
        }
        let ping = control_frame(0x09, &[b'p'; 125], [1, 2, 3, 4]);
        let mut decoder = Decoder::default();
        decoder.consume(UPGRADED).unwrap();
        for byte in ping {
            assert!(decoder.consume(&[byte]).unwrap().is_empty());
        }
        assert_eq!(decoder.take_pings(), vec![vec![b'p'; 125]]);
    }

    // OutboundCodexThreads.loaded.
    #[test]
    fn loaded_threads_are_read_after_the_handshake() {
        let mut server = FakeAppServer::hosting(&["one", "two"], None);
        let seen = server.seen.clone();
        let loaded = loaded_threads(&mut server, LOADED_TIMEOUT);
        assert_eq!(
            loaded,
            BTreeSet::from(["one".to_string(), "two".to_string()])
        );
        let methods: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| r["method"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(methods, ["initialize", "initialized", "thread/loaded/list"]);
        assert_eq!(seen.lock().unwrap()[2]["params"]["limit"], 1000);
    }

    // test_incomplete_loaded_thread_response_obeys_deadline (the codec half;
    // the deadline itself is runner::tests).
    #[test]
    fn an_incomplete_answer_is_no_threads() {
        let mut server = FakeAppServer::new(|request| {
            (request["method"] == "thread/loaded/list").then(|| vec![0x81, 0x7e, 0x00])
        });
        assert!(loaded_threads(&mut server, LOADED_TIMEOUT).is_empty());
        let mut refused = FakeAppServer::hosting(&["one"], None);
        refused.upgrade = b"HTTP/1.1 403 Forbidden\r\n\r\n".to_vec();
        assert!(loaded_threads(&mut refused, LOADED_TIMEOUT).is_empty());
    }

    const THREAD: &str = "01a0f207-6743-7f12-ac70-f791c2c01c64";

    // CodexAppServerBridge.sendIfLoaded and test_app_server_delivery_does_not_queue.
    #[test]
    fn a_loaded_thread_takes_the_turn() {
        let mut server = FakeAppServer::hosting(
            &[THREAD],
            Some(json!({"id": 3, "result": {"turn": {"id": "t"}}})),
        );
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let turn = seen.lock().unwrap().last().unwrap().clone();
        assert_eq!(turn["method"], "turn/start");
        assert_eq!(turn["params"]["threadId"], THREAD);
        assert_eq!(turn["params"]["clientUserMessageId"], "m1");
        assert_eq!(
            turn["params"]["input"],
            json!([{"type": "text", "text": "hello"}])
        );
    }

    // Review: the loaded list and the thread id are compared without case.
    #[test]
    fn a_hosted_thread_matches_in_any_case() {
        let upper = THREAD.to_uppercase();
        let mut server = FakeAppServer::hosting(
            &[upper.as_str()],
            Some(json!({"id": 3, "result": {"turn": {"id": "t"}}})),
        );
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let turn = seen.lock().unwrap().last().unwrap().clone();
        assert_eq!(turn["params"]["threadId"], upper.as_str());
    }

    // CodexAppServerBridge: a thread it does not host is never loaded.
    #[test]
    fn an_unloaded_thread_is_not_sent() {
        let mut server = FakeAppServer::hosting(&["other"], Some(json!({"id": 3, "result": {}})));
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(false)
        );
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "turn/start"));
        // No daemon behind the proxy: nothing was written, so not loaded.
        let mut silent = FakeAppServer::new(|_| None);
        assert_eq!(
            send_if_loaded(
                &mut silent,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(false)
        );
        let mut broken = FakeAppServer::hosting(&[THREAD], None);
        broken.broken_writes = true;
        assert_eq!(
            send_if_loaded(
                &mut broken,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(false)
        );
    }

    // CodexAppServerBridge: after turn/start is written, only a confirmed
    // turn is delivery and only an explicit error is a refusal.
    #[test]
    fn after_the_turn_is_written_anything_unconfirmed_is_in_doubt() {
        let refusal = json!({"id": 3, "error": {"code": -32600, "message": "thread busy"}});
        let mut refused = FakeAppServer::hosting(&[THREAD], Some(refusal));
        assert_eq!(
            send_if_loaded(
                &mut refused,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Err(TurnError::Refused("thread busy".into()))
        );
        let mut silent = FakeAppServer::hosting(&[THREAD], None);
        assert_eq!(
            send_if_loaded(
                &mut silent,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Err(TurnError::InDoubt("Codex did not confirm the turn".into()))
        );
        let mut unreadable =
            FakeAppServer::hosting(&[THREAD], Some(json!({"id": 3, "result": "ok"})));
        assert_eq!(
            send_if_loaded(
                &mut unreadable,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Err(TurnError::InDoubt(
                "Codex returned an unreadable turn response".into()
            ))
        );
    }

    // Review: `"error": null` is not a refusal.
    #[test]
    fn a_null_error_is_not_a_refusal() {
        let null = json!({"id": 3, "error": null});
        let mut server = FakeAppServer::hosting(&[THREAD], Some(null));
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Err(TurnError::InDoubt(
                "Codex returned an unreadable turn response".into()
            ))
        );
        let text = json!({"id": 3, "error": "thread busy"});
        let mut server = FakeAppServer::hosting(&[THREAD], Some(text));
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                "hello",
                "m1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Err(TurnError::Refused("thread busy".into()))
        );
    }

    /// An app-server whose configuration names `configured` MCP servers and
    /// whose new thread reports `thread_status` for them.
    fn spawning_server(configured: &[&str], thread_status: &'static str) -> FakeAppServer {
        let configured: Vec<String> = configured.iter().map(|s| s.to_string()).collect();
        FakeAppServer::new(move |request| {
            let id = request["id"].clone();
            let answer = |result: Value| Some(server_frame(&json!({"id": id, "result": result})));
            match request["method"].as_str() {
                Some("mcpServerStatus/list") if request["params"]["threadId"].is_null() => {
                    answer(json!({
                        "data": configured.iter().map(|name| json!({
                            "name": name, "authStatus": "bearerToken", "runtimeStatus": "connected",
                            "tools": {"t": {}},
                        })).collect::<Vec<_>>(),
                        "nextCursor": null,
                    }))
                }
                Some("thread/start") => answer(json!({"thread": {"id": THREAD}})),
                Some("mcpServerStatus/list") => answer(json!({
                    "data": configured.iter().map(|name| json!({
                        "name": name, "authStatus": "bearerToken",
                        "runtimeStatus": thread_status, "tools": {},
                    })).collect::<Vec<_>>(),
                    "nextCursor": null,
                })),
                Some("thread/archive") => answer(json!({})),
                Some("turn/start") => answer(json!({"turn": {"id": "t"}})),
                _ => None,
            }
        })
    }

    fn isolation() -> McpIsolation<'static> {
        McpIsolation {
            disable: &crate::relay::harness_setup::codex_disable_mcp_config,
            none_active: &crate::relay::harness_setup::codex_no_mcp_active,
        }
    }

    #[test]
    fn a_spawned_thread_starts_with_every_configured_mcp_server_off() {
        let mut server = spawning_server(&["agent-relay-sessions", "other"], "disabled");
        let seen = server.seen.clone();
        let reported = std::sync::Mutex::new(None);
        let report = |thread: &str| {
            let methods: Vec<String> = seen
                .lock()
                .unwrap()
                .iter()
                .filter_map(|r| r["method"].as_str().map(String::from))
                .collect();
            *reported.lock().unwrap() = Some((thread.to_string(), methods));
        };
        let started = start_thread(
            &mut server,
            "/tmp",
            Access::Workspace,
            "hi",
            "m1",
            SEND_TIMEOUT,
            StartOptions {
                isolation: Some(&isolation()),
                created: Some(&report),
            },
        )
        .unwrap();
        assert_eq!(started.thread_id, THREAD);
        // Reported once usable and before its first turn was asked for.
        let (thread, before) = reported.lock().unwrap().clone().unwrap();
        assert_eq!(thread, THREAD);
        assert!(before.iter().any(|m| m == "mcpServerStatus/list"));
        assert!(!before.iter().any(|m| m == "turn/start"));
        assert!(started.turn.is_ok());
        let seen = seen.lock().unwrap();
        let start = seen.iter().find(|r| r["method"] == "thread/start").unwrap();
        assert_eq!(
            start["params"]["config"],
            json!({"mcp_servers": {
                "agent-relay-sessions": {"enabled": false}, "other": {"enabled": false},
            }})
        );
        let methods: Vec<&str> = seen.iter().filter_map(|r| r["method"].as_str()).collect();
        let check = methods
            .iter()
            .rposition(|m| *m == "mcpServerStatus/list")
            .unwrap();
        let turn = methods.iter().position(|m| *m == "turn/start").unwrap();
        assert!(check < turn, "the thread is checked before its first turn");
    }

    #[test]
    fn a_spawned_thread_with_a_server_still_running_is_archived_without_a_turn() {
        let mut server = spawning_server(&["agent-relay-sessions"], "connected");
        let seen = server.seen.clone();
        assert!(start_thread(
            &mut server,
            "/tmp",
            Access::Full,
            "hi",
            "m1",
            SEND_TIMEOUT,
            StartOptions {
                isolation: Some(&isolation()),
                created: None,
            },
        )
        .is_err());
        let methods: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|r| r["method"].as_str().map(String::from))
            .collect();
        assert!(methods.contains(&"thread/archive".to_string()));
        assert!(!methods.contains(&"turn/start".to_string()));
    }

    #[test]
    fn a_released_thread_is_archived() {
        let mut server = spawning_server(&[], "disabled");
        let seen = server.seen.clone();
        archive_thread(&mut server, THREAD, SEND_TIMEOUT).unwrap();
        let seen = seen.lock().unwrap();
        let archive = seen
            .iter()
            .find(|r| r["method"] == "thread/archive")
            .unwrap();
        assert_eq!(archive["params"]["threadId"], THREAD);
    }

    const RELAYED: &str = "[via Agent Relay — from @alice (alice@host-1) to @codex-a · message 7 · ref 0123456789ab]\n[reply: send_relay_message to=\"alice@host-1\"]\n\nPlease check CI.";
    const SHORT: &str = "[via Agent Relay — from @alice · ref 0123456789ab]";

    /// One that hosts `THREAD`, answers `thread/inject_items` with `inject`
    /// and confirms the turn.
    fn injecting(inject: Option<Value>) -> FakeAppServer {
        FakeAppServer::new(move |request| match request["method"].as_str() {
            Some("thread/loaded/list") => Some(server_frame(
                &json!({"id": 2, "result": {"data": [THREAD], "nextCursor": null}}),
            )),
            Some("thread/inject_items") => inject.as_ref().map(server_frame),
            Some("turn/start") => Some(server_frame(
                &json!({"id": 3, "result": {"turn": {"id": "t"}}}),
            )),
            _ => None,
        })
    }

    fn methods_and_turn_text(seen: &Arc<Mutex<Vec<Value>>>) -> (Vec<String>, Value) {
        let seen = seen.lock().unwrap();
        let methods = seen
            .iter()
            .filter_map(|r| r["method"].as_str().map(str::to_string))
            .filter(|m| m.starts_with("thread/inject") || m == "turn/start")
            .collect();
        let turn = seen.iter().find(|r| r["method"] == "turn/start").unwrap();
        (methods, turn["params"]["input"][0]["text"].clone())
    }

    /// The turn's whole visible input.
    fn turn_input(seen: &Arc<Mutex<Vec<Value>>>) -> Value {
        let seen = seen.lock().unwrap();
        let turn = seen.iter().find(|r| r["method"] == "turn/start").unwrap();
        turn["params"]["input"].clone()
    }

    // A hidden relay message goes into the history whole, then starts its
    // turn with no visible input: the chat shows none of it.
    #[test]
    fn a_hidden_message_is_injected_whole_and_its_turn_shows_nothing() {
        let mut server = injecting(Some(json!({"id": 4, "result": {}})));
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                RELAYED,
                "compact-1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let (methods, _) = methods_and_turn_text(&seen);
        assert_eq!(methods, ["thread/inject_items", "turn/start"]);
        assert_eq!(turn_input(&seen), json!([]));
        let inject = seen
            .lock()
            .unwrap()
            .iter()
            .find(|r| r["method"] == "thread/inject_items")
            .cloned()
            .unwrap();
        assert_eq!(inject["params"]["threadId"], THREAD);
        assert_eq!(
            inject["params"]["items"],
            crate::relay::codex::compact::hidden_items(RELAYED)
        );
        assert_eq!(inject["params"]["items"][0]["role"], "developer");
        // The agent still reads how to reply: the hidden item is the whole
        // message, attribution and reply instructions included.
        let hidden = inject["params"]["items"][1]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(hidden.starts_with("[via Agent Relay — from @alice"));
        assert!(hidden.contains("[reply: send_relay_message to=\"alice@host-1\"]"));
        assert!(hidden.ends_with("Please check CI."));
        let turn = seen.lock().unwrap().last().unwrap().clone();
        assert_eq!(turn["params"]["clientUserMessageId"], "compact-1");
    }

    // Codex refusing the injection (an older Codex) answered on a whole
    // frame, so the whole message starts the turn on the same connection.
    #[test]
    fn an_injection_codex_refuses_sends_the_whole_message() {
        let refusal = json!({"id": 4, "error": {"code": -32601, "message": "Method not found"}});
        let mut server = injecting(Some(refusal));
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                RELAYED,
                "refused-1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let (methods, text) = methods_and_turn_text(&seen);
        assert_eq!(methods, ["thread/inject_items", "turn/start"]);
        assert_eq!(text, RELAYED);
    }

    // A message that must stay hidden (a terminal's, which has the pointer
    // to fall back on) never starts a visible turn: refused, nothing more
    // is sent, and the caller takes another route.
    #[test]
    fn a_hidden_only_send_starts_no_turn_when_the_injection_is_refused() {
        let refusal = json!({"id": 4, "error": {"code": -32601, "message": "Method not found"}});
        let mut server = injecting(Some(refusal));
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                RELAYED,
                "hidden-only-1",
                Hide::Only,
                SEND_TIMEOUT
            ),
            Ok(false)
        );
        let methods: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|r| r["method"].as_str().map(str::to_string))
            .filter(|m| m.starts_with("thread/inject") || m == "turn/start")
            .collect();
        assert_eq!(methods, ["thread/inject_items"], "no turn/start");

        let mut server = injecting(Some(json!({"id": 4, "result": {}})));
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                RELAYED,
                "hidden-only-2",
                Hide::Only,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        assert_eq!(turn_input(&seen), json!([]));
    }

    /// Fails every write from the `fail_from`th on, as a proxy that stopped
    /// taking bytes mid-frame does; the fake never sees those frames.
    struct FailingWrites {
        inner: FakeAppServer,
        writes: usize,
        fail_from: usize,
    }

    impl ProxyStream for FailingWrites {
        fn write_all(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()> {
            self.writes += 1;
            if self.writes >= self.fail_from {
                return Err(io::Error::new(ErrorKind::TimedOut, "proxy backpressure"));
            }
            self.inner.write_all(bytes, deadline)
        }

        fn read(&mut self, deadline: Instant) -> io::Result<Vec<u8>> {
            self.inner.read(deadline)
        }
    }

    // Capy #510: an injection that was not wholly written, or never
    // answered, drops the connection before any turn frame could follow
    // the partial one; another route may then deliver.
    #[test]
    fn an_injection_not_written_or_answered_drops_the_connection() {
        // Writes: upgrade, initialize, initialized, loaded list, injection.
        let mut cut = FailingWrites {
            inner: injecting(Some(json!({"id": 4, "result": {}}))),
            writes: 0,
            fail_from: 5,
        };
        let seen = cut.inner.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut cut,
                THREAD,
                RELAYED,
                "cut-1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(false)
        );
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "turn/start"));
        let mut silent = injecting(None);
        let seen = silent.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut silent,
                THREAD,
                RELAYED,
                "silent-1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(false)
        );
        assert!(!seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "turn/start"));
        use crate::relay::codex::compact::{held, Held};
        assert_eq!(held(THREAD, "cut-1"), None, "a cut frame never arrived");
        assert_eq!(held(THREAD, "silent-1"), Some(Held::Uncertain));
    }

    // Greptile #510: an injection Codex never acknowledged is not injected
    // again; the retry starts the turn with the whole message, visibly.
    #[test]
    fn an_unanswered_injection_is_never_repeated() {
        let mut silent = injecting(None);
        assert_eq!(
            send_if_loaded(
                &mut silent,
                THREAD,
                RELAYED,
                "unanswered-1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(false)
        );
        let mut server = injecting(Some(json!({"id": 4, "result": {}})));
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                RELAYED,
                "unanswered-1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let (methods, text) = methods_and_turn_text(&seen);
        assert_eq!(methods, ["turn/start"]);
        assert_eq!(text, RELAYED);
    }

    // Bugbot #510: once the history holds the message, a turn that could not
    // be written is retried (not handed to another route), and the retry
    // starts the turn empty, without injecting again.
    #[test]
    fn a_turn_failing_after_its_injection_is_retried_empty() {
        let mut cut = FailingWrites {
            inner: injecting(Some(json!({"id": 4, "result": {}}))),
            writes: 0,
            fail_from: 6,
        };
        assert!(matches!(
            send_if_loaded(
                &mut cut,
                THREAD,
                RELAYED,
                "retry-1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Err(TurnError::Refused(_))
        ));
        assert_eq!(
            crate::relay::codex::compact::held(THREAD, "retry-1"),
            Some(crate::relay::codex::compact::Held::Injected)
        );
        let mut server = injecting(Some(json!({"id": 4, "result": {}})));
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                RELAYED,
                "retry-1",
                Hide::IfAble,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let (methods, _) = methods_and_turn_text(&seen);
        assert_eq!(methods, ["turn/start"], "not injected again");
        assert_eq!(turn_input(&seen), json!([]));
        assert_eq!(
            crate::relay::codex::compact::after_injection(THREAD, "retry-1", RELAYED),
            SHORT
        );
    }

    // With the setting off, the message is sent whole and nothing injected.
    #[test]
    fn with_compact_off_the_whole_message_starts_the_turn() {
        let mut server = injecting(Some(json!({"id": 4, "result": {}})));
        let seen = server.seen.clone();
        assert_eq!(
            send_if_loaded(
                &mut server,
                THREAD,
                RELAYED,
                "off-1",
                Hide::Never,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let (methods, text) = methods_and_turn_text(&seen);
        assert_eq!(methods, ["turn/start"]);
        assert_eq!(text, RELAYED);
    }

    fn drive_fake(thread: &'static str, method: &'static str) -> FakeAppServer {
        FakeAppServer::new(move |request| match request["method"].as_str() {
            Some("thread/loaded/list") => Some(server_frame(
                &json!({"id": 2, "result": {"data": [thread]}}),
            )),
            Some("turn/start") => {
                let mut bytes =
                    server_frame(&json!({"id": 3, "result": {"turn": {"id": "turn-1"}}}));
                bytes.extend(server_frame(&json!({"id": 88, "method": method,
                    "params": {"threadId": thread, "turnId": "turn-1", "itemId": "item-1", "command": "cargo test"}})));
                Some(bytes)
            }
            _ if request["id"] == 88 && request.get("result").is_some() => Some(server_frame(
                &json!({"method":"turn/completed", "params":{"threadId":thread}}),
            )),
            _ => None,
        })
    }

    // #547 + #550: a spawned turn the desktop drives resumes the thread
    // Codex unloaded while idle, then keeps the connection for approvals.
    #[test]
    fn a_driven_spawned_turn_resumes_an_unloaded_thread() {
        const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bdb7e";
        let server = FakeAppServer::new(|request| match request["method"].as_str() {
            Some("thread/loaded/list") => Some(server_frame(
                &json!({"id": 2, "result": {"data": [], "nextCursor": null}}),
            )),
            Some("thread/resume") => Some(server_frame(
                &json!({"id": request["id"], "result": {"thread": {"id": THREAD}}}),
            )),
            Some("turn/start") => {
                let mut bytes =
                    server_frame(&json!({"id": 3, "result": {"turn": {"id": "turn-r"}}}));
                bytes.extend(server_frame(
                    &json!({"method": "turn/completed", "params": {"threadId": THREAD}}),
                ));
                Some(bytes)
            }
            _ => None,
        });
        let seen = server.seen.clone();
        assert_eq!(
            send_spawned(
                Box::new(server),
                drive::claim(THREAD).unwrap(),
                ("hello", "m-resume"),
                Hide::Never,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let methods: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|r| r["method"].as_str().map(str::to_string))
            .collect();
        assert_eq!(
            methods,
            [
                "initialize",
                "initialized",
                "thread/loaded/list",
                "thread/resume",
                "turn/start"
            ]
        );
        let until = Instant::now() + Duration::from_secs(5);
        while drive::driving(THREAD) {
            assert!(
                Instant::now() < until,
                "the completed turn's proxy stayed open"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn await_notice(thread: &str) -> drive::Notice {
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(notice) = drive::unforwarded(thread).pop() {
                return notice;
            }
            assert!(
                Instant::now() < until,
                "the fake app-server request was not forwarded"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn spawned_owner_text_is_native_and_only_the_owner_answers_the_fake_app_server() {
        const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bdb7c";
        let server = drive_fake(THREAD, "item/commandExecution/requestApproval");
        let seen = server.seen.clone();
        assert_eq!(
            send_spawned(
                Box::new(server),
                drive::claim(THREAD).unwrap(),
                ("Please check CI", "full-message-id-123"),
                Hide::Never,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let start = seen
            .lock()
            .unwrap()
            .iter()
            .find(|v| v["method"] == "turn/start")
            .unwrap()
            .clone();
        assert_eq!(
            start["params"]["input"],
            json!([{"type":"text", "text":"Please check CI"}])
        );
        assert_eq!(
            start["params"]["clientUserMessageId"],
            "full-message-id-123"
        );
        let notice = await_notice(THREAD);
        assert_eq!(notice.description, "Codex requests permission to run a command. Command text is withheld because it may contain credentials.");
        assert_eq!(
            drive::answer(
                THREAD,
                &notice.reference,
                Some("requester-id"),
                Some("owner-id"),
                true
            ),
            drive::ReplyResult::Unauthorized,
            "the spawn's requester cannot answer"
        );
        assert_eq!(
            drive::answer(
                THREAD,
                &notice.reference,
                Some("owner-id"),
                Some("owner-id"),
                true
            ),
            drive::ReplyResult::Answered
        );
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if seen
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["id"] == 88 && v["result"]["decision"] == "accept")
            {
                break;
            }
            assert!(
                Instant::now() < until,
                "the fake app-server did not receive the answer"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn expired_request_is_denied_over_the_fake_app_server_connection() {
        const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bdb7d";
        let server = drive_fake(THREAD, "item/commandExecution/requestApproval");
        let seen = server.seen.clone();
        assert_eq!(
            send_spawned(
                Box::new(server),
                drive::claim(THREAD).unwrap(),
                ("next", "full-message-id-124"),
                Hide::Never,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let notice = await_notice(THREAD);
        drive::expire(&notice.reference);
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if seen
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["id"] == 88 && v["result"]["decision"] == "decline")
            {
                break;
            }
            assert!(
                Instant::now() < until,
                "expiry did not deny the fake request"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn owner_only_tool_confirmation_rejects_requester_and_accepts_owner_choice() {
        const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3bdb7e";
        let server = FakeAppServer::new(|request| match request["method"].as_str() {
            Some("thread/loaded/list") => {
                Some(server_frame(&json!({"id":2,"result":{"data":[THREAD]}})))
            }
            Some("turn/start") => {
                let mut bytes = server_frame(&json!({"id":3,"result":{"turn":{"id":"t"}}}));
                bytes.extend(server_frame(
                    &json!({"id":89,"method":"item/tool/requestUserInput",
                    "params":{"threadId":THREAD,"turnId":"t","itemId":"i","isBlocking":true,
                        "questions":[{"id":"decision","header":"Confirm","question":"Install?",
                            "isSecret":false,"options":[{"label":"Install","description":"Proceed"},
                                {"label":"Cancel","description":"Stop"}]}]}}),
                ));
                Some(bytes)
            }
            _ if request["id"] == 89 && request.get("result").is_some() => Some(server_frame(
                &json!({"method":"turn/completed","params":{"threadId":THREAD}}),
            )),
            _ => None,
        });
        let seen = server.seen.clone();
        assert_eq!(
            send_spawned(
                Box::new(server),
                drive::claim(THREAD).unwrap(),
                ("task", "m-owner"),
                Hide::Never,
                SEND_TIMEOUT
            ),
            Ok(true)
        );
        let notice = await_notice(THREAD);
        assert_eq!(notice.options, ["1: Install", "2: Cancel"]);
        assert_eq!(
            drive::answer_choice(
                THREAD,
                &notice.reference,
                Some("requester"),
                Some("owner"),
                1
            ),
            drive::ReplyResult::Unauthorized
        );
        assert_eq!(
            drive::answer_choice(THREAD, &notice.reference, Some("owner"), Some("owner"), 1),
            drive::ReplyResult::Answered
        );
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if seen.lock().unwrap().iter().any(|v| {
                v["id"] == 89 && v["result"]["answers"]["decision"]["answers"] == json!(["Install"])
            }) {
                break;
            }
            assert!(
                Instant::now() < until,
                "owner choice did not reach the fake app-server"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
