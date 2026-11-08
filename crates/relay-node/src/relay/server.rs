//! The bridge server: accepts same-user connections on the core socket and
//! answers JSON-RPC requests line by line, forwarding subscribed events on
//! the same connection.
//!
//! A connection's requests are answered in the order they arrive; a client
//! that wants a slow call (`workspace.verify`) not to delay others opens a
//! second connection. Every connection must `hello` first. A connection
//! that ends mid-call (the client hangs up, sends too much, or the core
//! stops) has its extensions told at once; no call is ever cancelled, and its
//! answer, and those to requests read ahead, still go to a client that can
//! read them. Extension methods read ahead fail without running once their
//! extensions were told.

use crate::relay::contract::connection::{HelloResult, Stopping, Subscribed, Unsubscribed};
use crate::relay::contract::{self, answer, method};
use crate::relay::daemon::{CallContext, Core};
use crate::relay::peer::current_uid;
use crate::relay::protocol::{
    ErrorKind, Event, Request, Response, RpcError, Topic, BRIDGE_VERSION, MAX_FRAME_BYTES,
};
use crate::relay::transport::{CoreListener, CoreStream};
use crate::relay::{local_methods, methods};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, watch};

mod closed;
mod frames;

use closed::Closed;
use frames::{Frame, Frames, HungUp};

/// Accepts connections until shutdown. Another user's connection is closed
/// without a reply.
pub async fn accept_loop(
    mut listener: CoreListener,
    core: Arc<Core>,
    mut stop: watch::Receiver<bool>,
) {
    let mut connections = tokio::task::JoinSet::new();
    let mut next_connection_id = 1u64;
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
                let context = CallContext {
                    peer_pid: peer.pid,
                    connection_id: Some(next_connection_id),
                };
                next_connection_id = next_connection_id.wrapping_add(1).max(1);
                connections.spawn(connection(
                    stream,
                    core.clone(),
                    core.shutdown_requested(),
                    context,
                ));
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

/// How long a closing connection gives its background tasks to flush. At
/// daemon shutdown this includes the shutdown event; after EOF it includes
/// replies already queued for the client.
const CLOSE_FLUSH: Duration = Duration::from_millis(500);

struct Session {
    greeted: bool,
    topics: Arc<Mutex<HashSet<Topic>>>,
    /// The client, as the kernel reported it at connect.
    context: CallContext,
    /// Extensions were told this connection closed: requests still being
    /// answered must not reach them.
    closed: bool,
}

async fn connection(
    stream: CoreStream,
    core: Arc<Core>,
    mut stop: watch::Receiver<bool>,
    context: CallContext,
) {
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
        context,
        closed: false,
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

    let mut frames = Frames::new(read, MAX_FRAME_BYTES);
    let mut closed = Closed::new(core.clone(), context);
    let mut session = session;
    loop {
        let frame = tokio::select! {
            frame = frames.next() => frame,
            _ = stop.wait_for(|stop| *stop) => break,
            // The writer ends only when a write failed: the client is gone.
            () = lines.closed() => break,
        };
        let line = match frame {
            Frame::Line(line) => line,
            Frame::End => break,
            Frame::TooLarge => {
                let _ = lines.try_send(too_large());
                break;
            }
        };
        // Requests stay one at a time: lines that arrive meanwhile are only
        // read ahead, to see the connection end while the call is in flight.
        let (response, ending) = {
            let mut handling = std::pin::pin!(handle_line(&core, &mut session, &line));
            let ending = tokio::select! {
                biased;
                response = &mut handling => Ok(response),
                reason = frames.hung_up() => Err(Ending::Read(reason)),
                () = lines.closed() => Err(Ending::Gone),
                _ = stop.wait_for(|stop| *stop) => Err(Ending::Stopping),
            };
            match ending {
                Ok(response) => (response, None),
                Err(ending) => {
                    // Extensions hear now rather than when the call returns
                    // (a long poll waits up to its timeout), and may use
                    // that to wake it. The call is never cancelled, so an
                    // effect it admitted is still recorded.
                    closed.fire();
                    (handling.await, Some(ending))
                }
            }
        };
        if session.greeted {
            let _ = greeted_tx.send(true);
        }
        if ending.is_some() {
            session.closed = true;
        }
        // With the writer gone the answer has nowhere to go. A read EOF is
        // not that: a client may close only its sending side and still read.
        if matches!(ending, Some(Ending::Gone)) || lines.is_closed() {
            break;
        }
        if !answer_line(&lines, &mut stop, response).await {
            break;
        }
        let Some(ending) = ending else {
            continue;
        };
        // The connection ends: what was read ahead is still answered, in
        // order, while the client can read; extension methods among it fail
        // without running, as their extension was told the connection closed.
        while let Some(line) = frames.take_queued() {
            let response = {
                let mut handling = std::pin::pin!(handle_line(&core, &mut session, &line));
                tokio::select! {
                    biased;
                    response = &mut handling => Some(response),
                    () = lines.closed() => {
                        let _ = handling.await;
                        None
                    }
                }
            };
            let Some(response) = response else {
                break;
            };
            if !answer_line(&lines, &mut stop, response).await {
                break;
            }
        }
        let error = match ending {
            Ending::Read(HungUp::Overflow) => Some(Response::err(
                Value::Null,
                RpcError::new(
                    ErrorKind::InvalidRequest,
                    "Too many requests were sent before the previous one was answered.",
                ),
            )),
            Ending::Read(HungUp::TooLarge) => Some(Response::err(
                Value::Null,
                RpcError::new(ErrorKind::InvalidRequest, TOO_LARGE),
            )),
            Ending::Read(HungUp::Eof) | Ending::Stopping | Ending::Gone => None,
        };
        let _ = answer_line(&lines, &mut stop, error).await;
        break;
    }
    let stopping = *stop.borrow();
    // After shutdown, the forwarder delivers the shutdown event and ends; a
    // client that is not reading gets no longer than the flush allows.
    let mut forwarder = forwarder;
    if !stopping
        || tokio::time::timeout(CLOSE_FLUSH, &mut forwarder)
            .await
            .is_err()
    {
        forwarder.abort();
    }
    drop(lines);
    finish_writer(writer, CLOSE_FLUSH).await;
    closed.fire();
}

/// What ended a connection while one of its calls was in flight.
enum Ending {
    /// Reading the client ended: it hung up, sent too much, or sent a line
    /// over the limit.
    Read(HungUp),
    /// The core is stopping.
    Stopping,
    /// A write failed: the client is gone and nothing more can reach it.
    Gone,
}

/// The error for a request over [`MAX_FRAME_BYTES`].
const TOO_LARGE: &str = "The request is too large.";

fn too_large() -> String {
    let error = RpcError::new(ErrorKind::InvalidRequest, TOO_LARGE);
    to_line(&Response::err(Value::Null, error))
}

/// Queues `response` for the client, if there is one. A client that does not
/// read its responses stops being read, unless the core is stopping; then
/// what does not fit is dropped. False when the connection should end.
async fn answer_line(
    lines: &mpsc::Sender<String>,
    stop: &mut watch::Receiver<bool>,
    response: Option<Response>,
) -> bool {
    let Some(response) = response else {
        return true;
    };
    tokio::select! {
        // The reply to `daemon.shutdown` itself still goes out.
        biased;
        sent = lines.send(to_line(&response)) => sent.is_ok(),
        _ = stop.wait_for(|stop| *stop) => false,
    }
}

/// Flushes replies already queued for a closing connection without letting a
/// client that stopped reading postpone extension cleanup indefinitely.
async fn finish_writer(mut writer: tokio::task::JoinHandle<()>, limit: Duration) {
    if tokio::time::timeout(limit, &mut writer).await.is_err() {
        writer.abort();
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
                methods: all_method_names(core)
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
    if session.closed && is_extension_method(core, name) {
        return Err(RpcError::new(
            ErrorKind::InvalidRequest,
            "The connection is closing; this request was not run.",
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
        _ => call_from(core, &session.context, name, raw).await,
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
/// too, so they act exactly as a client's request would, from no peer.
pub async fn call(core: &Arc<Core>, name: &str, raw: Value) -> Result<Value, RpcError> {
    call_from(core, &CallContext::default(), name, raw).await
}

/// [`call`] for the client `context` describes.
pub async fn call_from(
    core: &Arc<Core>,
    context: &CallContext,
    name: &str,
    raw: Value,
) -> Result<Value, RpcError> {
    if *core.shutdown_requested().borrow() {
        return Err(RpcError::new(
            ErrorKind::ShuttingDown,
            "Agent Relay core is stopping.",
        ));
    }
    if core.plugins.account.is_none() && needs_account(core, name) {
        return Err(no_such_method());
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
                None => match local_methods::call_from(core, context, name, raw.clone()).await {
                    Some(answer) => Some(answer),
                    None => extension_call(core, context, name, raw).await,
                },
            };
            answer.unwrap_or_else(|| Err(no_such_method()))
        }
    }
}

/// The core's methods and this build's extensions, as `hello` lists them.
pub(crate) fn all_method_names(core: &Core) -> Vec<&'static str> {
    let with_account = core.plugins.account.is_some();
    let mut names = contract::method_names(with_account);
    names.extend(core.plugins.extension_method_names(with_account));
    names
}

fn no_such_method() -> RpcError {
    RpcError::new(
        ErrorKind::MethodNotFound,
        "This Agent Relay core has no such method.",
    )
}

/// Whether `name` is registered as an account method, by the core or by an
/// extension: `hello` leaves those out of a core with no account, and
/// [`call`] answers them as it answers an unknown name.
fn needs_account(core: &Core, name: &str) -> bool {
    let extensions = core
        .plugins
        .extensions
        .iter()
        .flat_map(|extension| extension.specs());
    contract::METHODS
        .iter()
        .filter(|spec| spec.name == name)
        .map(|spec| spec.availability)
        .chain(
            extensions
                .filter(|spec| spec.name == name)
                .map(|spec| spec.availability),
        )
        .any(|availability| availability == contract::Availability::Account)
}

/// Whether an extension registers `name`. Their names never repeat a core
/// method's, so such a call can only be answered by an extension.
fn is_extension_method(core: &Core, name: &str) -> bool {
    core.plugins
        .extensions
        .iter()
        .any(|extension| extension.specs().iter().any(|spec| spec.name == name))
}

/// The first extension that answers `name`.
async fn extension_call(
    core: &Arc<Core>,
    context: &CallContext,
    name: &str,
    raw: Value,
) -> Option<Result<Value, RpcError>> {
    for extension in &core.plugins.extensions {
        if !extension.specs().iter().any(|spec| spec.name == name) {
            continue;
        }
        if let Some(answer) = extension.call(core, context, name, raw.clone()).await {
            return Some(answer);
        }
    }
    None
}

fn to_line(response: &Response) -> String {
    serde_json::to_string(response).unwrap()
}

#[cfg(test)]
mod tests;
