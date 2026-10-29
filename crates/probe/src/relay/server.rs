//! The bridge server: accepts same-user connections on the core socket and
//! answers JSON-RPC requests line by line, forwarding subscribed events on
//! the same connection.
//!
//! A connection's requests are answered in the order they arrive; a client
//! that wants a slow call (`workspace.verify`) not to delay others opens a
//! second connection. Every connection must `hello` first.

use crate::relay::contract::connection::{HelloResult, Stopping, Subscribed, Unsubscribed};
use crate::relay::contract::{self, answer, method};
use crate::relay::daemon::Core;
use crate::relay::peer::current_uid;
use crate::relay::protocol::{
    ErrorKind, Event, Request, Response, RpcError, Topic, BRIDGE_VERSION, MAX_FRAME_BYTES,
};
use crate::relay::transport::{CoreListener, CoreStream};
use crate::relay::{account_methods, local_methods, methods};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, mpsc, watch};

/// Accepts connections until shutdown. Another user's connection is closed
/// without a reply.
pub async fn accept_loop(
    mut listener: CoreListener,
    core: Arc<Core>,
    mut stop: watch::Receiver<bool>,
) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            // Ended connections are reaped as they end, not at shutdown.
            Some(_) = connections.join_next(), if !connections.is_empty() => continue,
            _ = stop.wait_for(|stop| *stop) => break,
        };
        let Ok(stream) = accepted else {
            // Out of descriptors, typically: the listener stays readable, so
            // pause rather than spin.
            tokio::time::sleep(ACCEPT_RETRY).await;
            continue;
        };
        match stream.peer_credentials() {
            Ok(peer) if peer.uid == current_uid() => {
                connections.spawn(connection(stream, core.clone(), core.shutdown_requested()));
            }
            _ => drop(stream),
        }
    }
    drop(listener);
    while connections.join_next().await.is_some() {}
}

/// The pause after a failed `accept`.
const ACCEPT_RETRY: Duration = Duration::from_millis(100);

/// Lines queued for one client before the connection stops reading
/// requests and its events lag (then resync with a fresh snapshot).
const OUTGOING_LINES: usize = 32;

/// How long a stopping daemon gives a connection to flush the shutdown event.
const SHUTDOWN_FLUSH: Duration = Duration::from_millis(500);

struct Session {
    greeted: bool,
    topics: Arc<Mutex<HashSet<Topic>>>,
}

async fn connection(stream: CoreStream, core: Arc<Core>, mut stop: watch::Receiver<bool>) {
    let (read, mut write) = stream.into_split();
    let (lines, mut outgoing) = mpsc::channel::<String>(OUTGOING_LINES);
    let writer = tokio::spawn(async move {
        while let Some(mut line) = outgoing.recv().await {
            line.push('\n');
            if write.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
        let _ = write.shutdown().await;
    });

    let session = Session {
        greeted: false,
        topics: Arc::new(Mutex::new(HashSet::new())),
    };
    // Subscribed from the start so nothing published after a `subscribe`
    // reply can be missed; the topic set filters what is forwarded.
    let events = core.hub().subscribe();
    let (greeted_tx, greeted_rx) = watch::channel(false);
    let forwarder = tokio::spawn(forward_events(
        core.clone(),
        events,
        session.topics.clone(),
        greeted_rx,
        lines.clone(),
    ));

    let mut reader = BufReader::new(read);
    let mut session = session;
    loop {
        let mut line = Vec::new();
        let mut limited = (&mut reader).take(MAX_FRAME_BYTES as u64 + 1);
        let read = tokio::select! {
            read = limited.read_until(b'\n', &mut line) => read,
            _ = stop.wait_for(|stop| *stop) => break,
        };
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) if line.strip_suffix(b"\n").unwrap_or(&line).len() > MAX_FRAME_BYTES => {
                let error = RpcError::new(ErrorKind::InvalidRequest, "The request is too large.");
                let _ = lines.try_send(to_line(&Response::err(Value::Null, error)));
                break;
            }
            Ok(_) => {}
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let response = handle_line(&core, &mut session, &line).await;
        if session.greeted {
            let _ = greeted_tx.send(true);
        }
        if let Some(response) = response {
            // A client that does not read its responses stops being read.
            let sent = tokio::select! {
                // The reply to `daemon.shutdown` itself still goes out.
                biased;
                sent = lines.send(to_line(&response)) => sent.is_ok(),
                _ = stop.wait_for(|stop| *stop) => false,
            };
            if !sent {
                break;
            }
        }
    }
    let stopping = *stop.borrow();
    // After shutdown, the forwarder delivers the shutdown event and ends; a
    // client that is not reading gets no longer than the flush allows.
    let mut forwarder = forwarder;
    if !stopping
        || tokio::time::timeout(SHUTDOWN_FLUSH, &mut forwarder)
            .await
            .is_err()
    {
        forwarder.abort();
    }
    drop(lines);
    let mut writer = writer;
    if stopping {
        if tokio::time::timeout(SHUTDOWN_FLUSH, &mut writer)
            .await
            .is_err()
        {
            writer.abort();
        }
    } else {
        let _ = writer.await;
    }
}

/// Sends subscribed events, a fresh snapshot after lagging, and the shutdown
/// event to every greeted client. Sending waits for room in the client's
/// queue, so a client that stops reading lags instead of buffering events.
async fn forward_events(
    core: Arc<Core>,
    mut events: broadcast::Receiver<Event>,
    topics: Arc<Mutex<HashSet<Topic>>>,
    greeted: watch::Receiver<bool>,
    lines: mpsc::Sender<String>,
) {
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // Skip the stale backlog: the snapshot replaces all of it,
                // and the new receiver resumes right after it.
                let (resumed, snapshot) = core.hub().resync();
                events = resumed;
                if !topics.lock().unwrap().contains(&Topic::Status) {
                    continue;
                }
                snapshot
            }
            Err(broadcast::error::RecvError::Closed) => return,
        };
        let shutdown = event.topic == Topic::Shutdown;
        let wanted = if shutdown {
            *greeted.borrow()
        } else {
            topics.lock().unwrap().contains(&event.topic)
        };
        if wanted && lines.send(event.notification().to_string()).await.is_err() {
            return;
        }
        if shutdown {
            return;
        }
    }
}

async fn handle_line(core: &Arc<Core>, session: &mut Session, line: &[u8]) -> Option<Response> {
    let value: Value = match serde_json::from_slice(line) {
        Ok(value) => value,
        Err(_) => {
            return Some(Response::err(
                Value::Null,
                RpcError::new(ErrorKind::ParseError, "The request is not JSON."),
            ))
        }
    };
    let id_of = |value: &Value| value.get("id").cloned().unwrap_or(Value::Null);
    // A present `id`, `null` included, asks for a response; only an absent
    // one makes a notification.
    let id = value.get("id").cloned();
    let request: Request = match serde_json::from_value(value.clone()) {
        Ok(request) => request,
        Err(_) => {
            return Some(Response::err(
                id_of(&value),
                RpcError::new(
                    ErrorKind::InvalidRequest,
                    "The request is not a JSON-RPC 2.0 request.",
                ),
            ))
        }
    };
    if request.jsonrpc != "2.0" {
        return Some(Response::err(
            id_of(&value),
            RpcError::new(
                ErrorKind::InvalidRequest,
                "Only JSON-RPC 2.0 is spoken here.",
            ),
        ));
    }
    let result = dispatch(core, session, &request.method, request.params).await;
    // A request without an id is a notification: executed, never answered.
    let id = id?;
    Some(match result {
        Ok(result) => Response::ok(id, result),
        Err(error) => Response::err(id, error),
    })
}

async fn dispatch(
    core: &Arc<Core>,
    session: &mut Session,
    name: &str,
    raw: Value,
) -> Result<Value, RpcError> {
    if name == method::Hello::NAME {
        return answer::<method::Hello, _>(raw, |hello| async move {
            if hello.bridge_version != BRIDGE_VERSION {
                return Err(RpcError::new(
                    ErrorKind::BridgeVersionMismatch,
                    format!(
                        "This Agent Relay core speaks bridge version {BRIDGE_VERSION}; update the app or the core so they match."
                    ),
                ));
            }
            core.connect_lifetime.adopt();
            session.greeted = true;
            let status = core.status();
            Ok(HelloResult {
                bridge_version: BRIDGE_VERSION,
                daemon_version: status.daemon.version,
                pid: status.daemon.pid,
                methods: contract::method_names(core.plugins.account.is_some())
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                topics: contract::topics(),
            })
        })
        .await;
    }
    // A client that cannot speak this daemon's bridge version may still
    // retire it, so an upgraded app can replace a daemon left running.
    if name == method::DaemonShutdown::NAME {
        return answer::<method::DaemonShutdown, _>(raw, |_| async {
            core.request_shutdown();
            Ok(Stopping { stopping: true })
        })
        .await;
    }
    if !session.greeted {
        return Err(RpcError::new(
            ErrorKind::HandshakeRequired,
            "Send hello before any other request.",
        ));
    }
    if *core.shutdown_requested().borrow() {
        return Err(RpcError::new(
            ErrorKind::ShuttingDown,
            "Agent Relay core is stopping.",
        ));
    }
    match name {
        method::Subscribe::NAME => {
            answer::<method::Subscribe, _>(raw, |request| async move {
                let mut topics = session.topics.lock().unwrap();
                topics.extend(request.topics);
                Ok(Subscribed {
                    topics: sorted(&topics),
                    status: core.status(),
                })
            })
            .await
        }
        method::Unsubscribe::NAME => {
            answer::<method::Unsubscribe, _>(raw, |request| async move {
                let mut topics = session.topics.lock().unwrap();
                for topic in request.topics {
                    topics.remove(&topic);
                }
                Ok(Unsubscribed {
                    topics: sorted(&topics),
                })
            })
            .await
        }
        _ => call(core, name, raw).await,
    }
}

fn sorted(topics: &HashSet<Topic>) -> Vec<Topic> {
    let mut subscribed: Vec<Topic> = topics.iter().copied().collect();
    subscribed.sort_by_key(|topic| format!("{topic:?}"));
    subscribed
}

/// Answers a method that needs no connection state: everything but
/// `hello`, `subscribe`, `unsubscribe` and `daemon.shutdown`. The core's own
/// modules (the relay-send socket's setup routes) call methods through this
/// too, so they act exactly as a client's request would.
pub async fn call(core: &Arc<Core>, name: &str, raw: Value) -> Result<Value, RpcError> {
    if *core.shutdown_requested().borrow() {
        return Err(RpcError::new(
            ErrorKind::ShuttingDown,
            "Agent Relay core is stopping.",
        ));
    }
    // The contract is the same in every build; a core built without session
    // history refuses the methods it serves.
    #[cfg(not(feature = "history"))]
    if crate::relay::contract::needs_history(name) {
        return Err(RpcError::history_unavailable());
    }
    match name {
        method::DiagnosticsRequests::NAME => {
            answer::<method::DiagnosticsRequests, _>(raw, |_| async {
                Ok(crate::relay::request_log::snapshot())
            })
            .await
        }
        method::StatusGet::NAME => {
            answer::<method::StatusGet, _>(raw, |_| async { Ok(core.status()) }).await
        }
        method::WorkspaceRefresh::NAME => {
            answer::<method::WorkspaceRefresh, _>(raw, |_| async {
                Ok(core.refresh_workspace().await)
            })
            .await
        }
        method::WorkspaceVerify::NAME => {
            answer::<method::WorkspaceVerify, _>(raw, |_| core.verify_workspace()).await
        }
        _ => {
            let answer = match methods::call(core, name, raw.clone()).await {
                Some(answer) => Some(answer),
                None => match local_methods::call(core, name, raw.clone()).await {
                    Some(answer) => Some(answer),
                    None => account_methods::call(core, name, raw).await,
                },
            };
            answer.unwrap_or_else(|| {
                Err(RpcError::new(
                    ErrorKind::MethodNotFound,
                    "This Agent Relay core has no such method.",
                ))
            })
        }
    }
}

fn to_line(response: &Response) -> String {
    serde_json::to_string(response).unwrap()
}
