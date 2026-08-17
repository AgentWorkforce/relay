//! Dedicated Relaycast terminal transport.
//!
//! This deliberately does not share `node_control`: terminal output can be
//! continuous and subject to backpressure, whereas node registration,
//! heartbeats, and action delivery need a small independent control lane.

use std::{
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use futures_util::{Sink, SinkExt, StreamExt};
use relaycast::ORIGIN_ACTOR_HEADER;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use crate::types::InboundDeliveryMode;

const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
const TOKEN_WAIT_DELAY: Duration = Duration::from_secs(1);
// Mirrors node_control's heartbeat/read-idle pair (12s / 48s): a Cloudflare
// Durable Object hibernatable WebSocket (or any intermediate proxy) can drop
// an idle connection without ever delivering a close frame to this client, so
// a terminal lane with no active session can sit "connected" forever while
// actually dead. Without a periodic ping and an idle-read cutoff, nothing
// here would ever notice — `connect_async` only runs once per (re)connect,
// and this loop otherwise reacts only to genuine inbound frames or local
// commands, neither of which a blackholed socket will ever produce.
const PING_INTERVAL: Duration = Duration::from_secs(12);
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(48);
// Floor for the derived ping-tick period (`PING_INTERVAL.min(read_idle_timeout
// / 4)`). `read_idle_timeout` is caller-configurable (tests shrink it well
// below production's 48s); `tokio::time::interval` panics on a zero period,
// and integer division of a sub-4ns value would truncate to zero. No caller
// gets remotely close to that today, but the floor makes the config robust
// rather than relying on every future caller staying away from the edge.
const MIN_PING_INTERVAL: Duration = Duration::from_millis(50);
// A blackholed peer's full TCP send buffer must not be able to wedge this
// module's read/ping watchdog: `run_terminal_writer` is a dedicated task that
// owns the socket's write half, so a stalled `Sink::send` can only ever block
// that task, never the `run_terminal_control_client` select loop that has to
// keep observing `last_inbound` on schedule regardless of what the write side
// is doing. This is deliberately well under READ_IDLE_TIMEOUT so a wedged
// write is treated as dead before the read-idle window would have caught it
// anyway.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
// Bounded so a stuck writer can't let this module accumulate unbounded
// queued frames. A *full* queue just means this loop is enqueueing faster
// than real socket writes complete (expected under a legitimate burst) and
// is handled by dropping the newest frame; only a *closed* queue (the writer
// task has exited) means the connection is actually dead — see the
// `try_send` call sites below.
const WRITER_QUEUE_CAPACITY: usize = 64;
// Small: this queue only ever holds a ping or a shutdown close frame, never
// bulk terminal output (see `run_terminal_writer`'s priority read).
const PRIORITY_QUEUE_CAPACITY: usize = 8;
// Relaycast currently limits a node to 32 live terminal sessions. Final
// session frames get a distinct lane of that size so a full bulk-output queue
// cannot shed the only signal that tells a client its target is gone.
pub(crate) const TERMINAL_CLOSE_RESERVE: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalFrameEnqueue {
    Queued,
    Shed,
    Disconnected,
}

async fn enqueue_terminal_frame(
    writer_tx: &mpsc::Sender<Message>,
    final_tx: &mpsc::Sender<Message>,
    message: &TerminalToCloud,
) -> TerminalFrameEnqueue {
    let Ok(encoded) = serde_json::to_string(message) else {
        return TerminalFrameEnqueue::Disconnected;
    };
    let frame = Message::Text(encoded);
    if matches!(message, TerminalToCloud::Closed { .. }) {
        // Unlike bulk output, a final session frame must never be shed just
        // because the socket writer is draining a burst. Awaiting this bounded
        // lane is safe: the writer owns a timeout and drops the receiver if the
        // connection is genuinely wedged.
        return if final_tx.send(frame).await.is_ok() {
            TerminalFrameEnqueue::Queued
        } else {
            TerminalFrameEnqueue::Disconnected
        };
    }
    match writer_tx.try_send(frame) {
        Ok(()) => TerminalFrameEnqueue::Queued,
        Err(mpsc::error::TrySendError::Full(_)) => TerminalFrameEnqueue::Shed,
        Err(mpsc::error::TrySendError::Closed(_)) => TerminalFrameEnqueue::Disconnected,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TerminalMode {
    View,
    Drive,
    Passthrough,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum TerminalFromCloud {
    #[serde(rename = "terminal.open")]
    Open {
        session_id: String,
        agent: String,
        mode: TerminalMode,
    },
    #[serde(rename = "terminal.input")]
    Input {
        session_id: String,
        data_base64: String,
    },
    #[serde(rename = "terminal.resize")]
    Resize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    /// Request a fresh authoritative ANSI snapshot for an existing session.
    /// The request id is echoed in the reply so clients can coalesce repaint
    /// repairs without confusing a late response for a newer capture.
    #[serde(rename = "terminal.snapshot")]
    Snapshot {
        session_id: String,
        request_id: String,
    },
    #[serde(rename = "terminal.close")]
    Close { session_id: String },
    /// Request the broker flip the inbound delivery mode for the session's
    /// agent. The broker replies with `TerminalToCloud::DeliveryMode` on
    /// success or `TerminalToCloud::Error` on failure.
    #[serde(rename = "terminal.set_delivery_mode")]
    SetDeliveryMode {
        session_id: String,
        mode: InboundDeliveryMode,
        /// Caller-assigned correlation token echoed in the reply so that a
        /// delayed response cannot be mis-applied to a subsequent request.
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        /// Deserialized as a raw string so an unknown value returns
        /// `terminal.error` rather than silently dropping the whole frame.
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_mode: Option<String>,
        /// Broker revision as a decimal string (matches the existing HTTP wire format).
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_revision: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum TerminalToCloud {
    #[serde(rename = "terminal.ready")]
    Ready {
        session_id: String,
        screen: String,
        rows: u16,
        cols: u16,
        offset: u64,
        /// The worker's actual inbound delivery mode at the moment the session
        /// was ready. Absent when the broker did not track mode at snapshot
        /// time (older broker or headless worker).
        #[serde(skip_serializing_if = "Option::is_none")]
        delivery_mode: Option<InboundDeliveryMode>,
        /// Monotonic broker revision paired with `delivery_mode` for
        /// compare-and-set restoration during structured close.
        #[serde(skip_serializing_if = "Option::is_none")]
        delivery_revision: Option<String>,
    },
    #[serde(rename = "terminal.snapshot")]
    Snapshot {
        session_id: String,
        request_id: String,
        screen: String,
        rows: u16,
        cols: u16,
        offset: u64,
    },
    #[serde(rename = "terminal.output")]
    Output {
        session_id: String,
        chunk: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        offset: Option<u64>,
    },
    #[serde(rename = "terminal.input_ack")]
    InputAck {
        session_id: String,
        bytes_written: usize,
    },
    #[serde(rename = "terminal.error")]
    Error {
        session_id: String,
        code: String,
        message: String,
        /// Echo of the caller-supplied `request_id` from `SetDeliveryMode`.
        /// Present only for operation-scoped errors; absent for session-level
        /// errors so the client can distinguish the two without ambiguity.
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename = "terminal.closed")]
    Closed {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// Reply to `TerminalFromCloud::SetDeliveryMode`. `matched` is `true` when
    /// the compare-and-set guard passed and the mode was applied; `false` means
    /// a concurrent change was detected and the current broker state is reported
    /// with no mutation. `revision` is a decimal-string u64 matching the HTTP
    /// wire format.
    #[serde(rename = "terminal.delivery_mode")]
    DeliveryMode {
        session_id: String,
        /// Echo of the caller-supplied `request_id` so that a delayed reply
        /// cannot satisfy a later in-flight PUT.
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        mode: InboundDeliveryMode,
        flushed: usize,
        matched: bool,
        revision: String,
    },
}

#[derive(Debug)]
pub(crate) enum TerminalControlCommand {
    Send(TerminalToCloud),
    Shutdown,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TerminalControlEvent {
    Connected,
    Disconnected,
    Message(TerminalFromCloud),
}

#[derive(Clone)]
pub(crate) struct TerminalControlConfig {
    pub(crate) ws_url: String,
    /// Written through by node-control when it mints or rotates the node
    /// credential. This transport never mints itself, avoiding duplicate
    /// credential flows while still reconnecting with a fresh token.
    pub(crate) session_token: Arc<RwLock<Option<String>>>,
    /// Overrides [`READ_IDLE_TIMEOUT`]. `None` (production) uses the default;
    /// tests shrink this so a blackholed-peer reconnect is covered in well
    /// under a second instead of 48s.
    pub(crate) read_idle_timeout: Option<Duration>,
}

pub(crate) async fn run_terminal_control_client(
    config: TerminalControlConfig,
    mut command_rx: mpsc::Receiver<TerminalControlCommand>,
    event_tx: mpsc::Sender<TerminalControlEvent>,
) {
    let mut reconnect_delay = INITIAL_RECONNECT_DELAY;
    loop {
        let token = config
            .session_token
            .read()
            .ok()
            .and_then(|token| token.clone());
        let Some(token) = token.filter(|token| !token.trim().is_empty()) else {
            tokio::select! {
                command = command_rx.recv() => {
                    if matches!(command, Some(TerminalControlCommand::Shutdown) | None) { return; }
                    // Preserve bounded backpressure by dropping commands only
                    // when the caller itself chose a non-blocking try_send.
                }
                _ = tokio::time::sleep(TOKEN_WAIT_DELAY) => {}
            }
            continue;
        };

        let mut request = match config.ws_url.as_str().into_client_request() {
            Ok(request) => request,
            Err(error) => {
                tracing::warn!(target = "relay_broker::terminal", error = %error, "invalid fleet terminal ws url");
                tokio::time::sleep(reconnect_delay).await;
                reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
                continue;
            }
        };
        let header = format!("Bearer {}", token.trim());
        let Ok(header) = header.parse() else {
            tracing::warn!(
                target = "relay_broker::terminal",
                "invalid fleet terminal token header"
            );
            reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
            tokio::time::sleep(reconnect_delay).await;
            continue;
        };
        request.headers_mut().insert("authorization", header);
        if let Ok(value) = crate::telemetry::BROKER_ORIGIN_ACTOR.parse() {
            request.headers_mut().insert(ORIGIN_ACTOR_HEADER, value);
        }
        for (name, value) in crate::telemetry::cloud_identity_headers() {
            let Ok(header_name) = name.parse::<reqwest::header::HeaderName>() else {
                continue;
            };
            if let Ok(header_value) = value.parse() {
                request.headers_mut().insert(header_name, header_value);
            }
        }

        let (socket, _) = match connect_async(request).await {
            Ok(socket) => socket,
            Err(error) => {
                tracing::warn!(target = "relay_broker::terminal", url = %config.ws_url, error = %error, "fleet terminal ws connect failed");
                tokio::time::sleep(reconnect_delay).await;
                reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
                continue;
            }
        };
        reconnect_delay = INITIAL_RECONNECT_DELAY;
        let _ = event_tx.send(TerminalControlEvent::Connected).await;
        let (sink, mut stream) = socket.split();
        let (writer_tx, writer_rx) = mpsc::channel::<Message>(WRITER_QUEUE_CAPACITY);
        let (final_tx, final_rx) = mpsc::channel::<Message>(TERMINAL_CLOSE_RESERVE);
        // Pings (and the shutdown close frame) get their own small queue,
        // checked ahead of `writer_rx` on every write. Without this, a large
        // legitimate output burst can bury a ping behind everything already
        // queued in the shared channel — the liveness probe then arrives too
        // late for `read_idle_timeout` to see it as "the peer is still
        // there," and a peer that is genuinely draining data gets disconnected
        // anyway. A ping is O(bytes) cheap and time-sensitive; bulk output is
        // not, so it must never be able to make a ping wait behind it.
        let (priority_tx, priority_rx) = mpsc::channel::<Message>(PRIORITY_QUEUE_CAPACITY);
        // Give the writer exclusive ownership of the write half so a
        // blackholed peer's full send buffer can only ever stall this task —
        // never the select loop below, which must keep observing
        // `last_inbound` on schedule regardless of what the write side is
        // doing.
        let writer = tokio::spawn(run_terminal_writer(sink, writer_rx, final_rx, priority_rx));
        // Shedding is per-connection state, not per-frame. Under sustained
        // backpressure the queue stays full, so warning on every dropped frame
        // would produce a log storm in exactly the situation an operator most
        // needs to read the log. One line when shedding begins, one when it
        // ends carrying the total lost, is the whole story.
        let mut shedding = false;
        let mut shed_frames: u64 = 0;
        let mut connected = true;
        let mut last_inbound = Instant::now();
        let read_idle_timeout = config.read_idle_timeout.unwrap_or(READ_IDLE_TIMEOUT);
        let ping_period = PING_INTERVAL
            .min(read_idle_timeout / 4)
            .max(MIN_PING_INTERVAL);
        let mut ping_interval = tokio::time::interval(ping_period);
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        while connected {
            tokio::select! {
                command = command_rx.recv() => match command {
                    Some(TerminalControlCommand::Send(message)) => {
                        // A momentarily full bulk queue means the writer hasn't
                        // caught up to a burst yet; final session frames use a
                        // distinct reliable lane and are never shed with output.
                        match enqueue_terminal_frame(&writer_tx, &final_tx, &message).await {
                            TerminalFrameEnqueue::Queued => {
                                // One accepted frame is not a recovery. While
                                // output outruns the writer, each dequeue frees
                                // exactly one slot and the next send refills it,
                                // so require a genuine drain before clearing the
                                // episode.
                                if shedding && writer_tx.capacity() >= WRITER_QUEUE_CAPACITY / 2 {
                                    tracing::warn!(
                                        target = "relay_broker::terminal",
                                        dropped_frames = shed_frames,
                                        "fleet terminal writer drained; resuming output"
                                    );
                                    shedding = false;
                                    shed_frames = 0;
                                }
                            }
                            // Shedding is deliberate, but it must not be silent:
                            // log the episode, not each frame.
                            TerminalFrameEnqueue::Shed => {
                                shed_frames = shed_frames.saturating_add(1);
                                if !shedding {
                                    shedding = true;
                                    tracing::warn!(
                                        target = "relay_broker::terminal",
                                        capacity = WRITER_QUEUE_CAPACITY,
                                        "fleet terminal writer queue full; shedding output frames under backpressure"
                                    );
                                }
                            }
                            TerminalFrameEnqueue::Disconnected => connected = false,
                        }
                    }
                    Some(TerminalControlCommand::Shutdown) | None => {
                        // Priority queue: jumps ahead of anything still
                        // queued in `writer_tx`, so shutdown stays prompt
                        // even mid-burst.
                        let _ = priority_tx.try_send(Message::Close(None));
                        drop(priority_tx);
                        drop(writer_tx);
                        // Bounded by WRITE_TIMEOUT inside the writer itself,
                        // so this can't hang shutdown indefinitely even if
                        // the peer never reads the close frame.
                        let _ = writer.await;
                        return;
                    }
                },
                _ = ping_interval.tick() => {
                    // Checked before enqueueing the ping, because a queued
                    // send is exactly what cannot be trusted here: the
                    // writer task keeps accepting frames into its queue on a
                    // blackholed socket right up until its own write timeout
                    // fires. Silence past the window is the only local
                    // evidence that the cloud side stopped hearing us — and
                    // this check never awaits IO, so a wedged writer can
                    // never stop it from running on schedule.
                    let idle = last_inbound.elapsed();
                    if idle >= read_idle_timeout {
                        tracing::warn!(
                            target = "relay_broker::terminal",
                            idle_secs = idle.as_secs(),
                            "no inbound fleet terminal frame within the read-idle window; reconnecting"
                        );
                        connected = false;
                    } else if let Err(mpsc::error::TrySendError::Closed(_)) =
                        priority_tx.try_send(Message::Ping(Vec::new()))
                    {
                        // Only a closed queue (the writer task has exited)
                        // means the connection is dead; a momentarily full
                        // one just means this tick's ping is skipped — the
                        // next tick tries again, and read-idle detection
                        // above is unaffected either way.
                        connected = false;
                    }
                }
                inbound = stream.next() => match inbound {
                    Some(Ok(message)) => {
                        // Any frame proves the peer is still there — including
                        // the pong answering our ping, which is the only
                        // traffic a healthy but session-idle cloud side is
                        // guaranteed to send.
                        last_inbound = Instant::now();
                        match message {
                            Message::Text(text) => match serde_json::from_str::<TerminalFromCloud>(&text) {
                                Ok(message) => {
                                    if event_tx
                                        .send(TerminalControlEvent::Message(message))
                                        .await
                                        .is_err()
                                    {
                                        // The consumer is gone, so this client is
                                        // finished. Dropping `writer_tx`/`final_tx`/
                                        // `priority_tx` on the way out ends the writer —
                                        // its `recv()` yields `None` — so this is
                                        // not a leak fix. Aborting makes the
                                        // teardown immediate and explicit rather
                                        // than dependent on the drop order of two
                                        // locals a future edit could easily move.
                                        writer.abort();
                                        return;
                                    }
                                }
                                Err(error) => tracing::warn!(target = "relay_broker::terminal", error = %error, "invalid fleet terminal frame"),
                            },
                            Message::Close(_) => connected = false,
                            _ => {}
                        }
                    }
                    Some(Err(_)) | None => connected = false,
                },
            }
        }
        // Shedding is usually the symptom of the very failure that ends the
        // connection — a blackholed peer that stopped reading. Report the total
        // here or the operator never learns how much output was lost, because
        // the "drained" path above only runs when a send succeeds.
        if shedding {
            tracing::warn!(
                target = "relay_broker::terminal",
                dropped_frames = shed_frames,
                "fleet terminal connection ended while shedding output"
            );
        }
        // Don't await the writer here: it may be the very thing that is
        // stuck (a wedged write mid-timeout). Aborting is instant and safe —
        // the writer holds no state that needs a clean unwind.
        writer.abort();
        let _ = event_tx.send(TerminalControlEvent::Disconnected).await;
        tokio::time::sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
    }
}

/// Owns a terminal websocket's write half exclusively, so a peer that stops
/// reading can only ever stall this task — never the read/ping watchdog in
/// [`run_terminal_control_client`]. Every write is bounded by
/// [`WRITE_TIMEOUT`]: a wedged send (full TCP buffer because the blackholed
/// peer never drains it) is treated as connection death rather than left to
/// block forever, and this task simply exits, which closes both queues and
/// makes the next `try_send` from the select loop fail immediately.
///
/// `final_rx` (session-final frames) is read ahead of `priority_rx` (pings and
/// the shutdown close frame), and both are read ahead of `data_rx` (bulk
/// terminal output). A large legitimate output burst must never bury either a
/// teardown signal or a time-sensitive liveness ping behind bulk output.
async fn run_terminal_writer<S>(
    mut sink: S,
    mut data_rx: mpsc::Receiver<Message>,
    mut final_rx: mpsc::Receiver<Message>,
    mut priority_rx: mpsc::Receiver<Message>,
) where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    loop {
        let message = tokio::select! {
            biased;
            message = final_rx.recv() => message,
            message = priority_rx.recv() => message,
            message = data_rx.recv() => message,
        };
        let Some(message) = message else { return };
        let is_close = matches!(message, Message::Close(_));
        match tokio::time::timeout(WRITE_TIMEOUT, sink.send(message)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(target = "relay_broker::terminal", error = %error, "fleet terminal websocket write failed");
                return;
            }
            Err(_) => {
                tracing::warn!(
                    target = "relay_broker::terminal",
                    timeout_secs = WRITE_TIMEOUT.as_secs(),
                    "fleet terminal websocket write timed out; treating connection as dead"
                );
                return;
            }
        }
        if is_close {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::SinkExt as _;
    use std::sync::{Arc, RwLock};
    use std::time::Duration;

    use futures_util::StreamExt;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::accept_async;
    use tokio_tungstenite::tungstenite::Message;

    use super::{
        enqueue_terminal_frame, run_terminal_control_client, InboundDeliveryMode,
        TerminalControlCommand, TerminalControlConfig, TerminalControlEvent, TerminalFrameEnqueue,
        TerminalFromCloud, TerminalMode, TerminalToCloud,
    };

    #[tokio::test]
    async fn terminal_close_uses_reserved_writer_lane_when_bulk_output_is_full() {
        let (writer_tx, mut writer_rx) = mpsc::channel(1);
        let (final_tx, mut final_rx) = mpsc::channel(1);
        writer_tx
            .try_send(Message::Text("already queued output".into()))
            .unwrap();

        let shed = enqueue_terminal_frame(
            &writer_tx,
            &final_tx,
            &TerminalToCloud::Output {
                session_id: "session-a".into(),
                chunk: "new output".into(),
                offset: None,
            },
        )
        .await;
        assert_eq!(shed, TerminalFrameEnqueue::Shed);

        let queued = enqueue_terminal_frame(
            &writer_tx,
            &final_tx,
            &TerminalToCloud::Closed {
                session_id: "session-a".into(),
                code: Some("agent_released".into()),
                message: Some("terminal worker was released".into()),
            },
        )
        .await;
        assert_eq!(queued, TerminalFrameEnqueue::Queued);
        assert!(matches!(
            final_rx.try_recv(),
            Ok(Message::Text(frame))
                if serde_json::from_str::<serde_json::Value>(&frame)
                    .is_ok_and(|value| value["type"] == "terminal.closed"
                        && value["code"] == "agent_released")
        ));
        assert!(matches!(
            writer_rx.try_recv(),
            Ok(Message::Text(frame)) if frame == "already queued output"
        ));
    }

    #[tokio::test]
    async fn shutdown_sends_websocket_close_with_an_empty_final_lane() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!(
            "ws://{}/v1/node/terminal/ws",
            listener.local_addr().unwrap()
        );
        let (command_tx, command_rx) = mpsc::channel(8);
        let (event_tx, mut event_rx) = mpsc::channel(8);
        let session_token = Arc::new(RwLock::new(Some("nt_test".to_string())));
        let client = tokio::spawn(run_terminal_control_client(
            TerminalControlConfig {
                ws_url,
                session_token,
                read_idle_timeout: Some(Duration::from_secs(30)),
            },
            command_rx,
            event_tx,
        ));
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            ws.next().await
        });

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(5), event_rx.recv())
                .await
                .unwrap(),
            Some(TerminalControlEvent::Connected)
        ));
        command_tx
            .send(TerminalControlCommand::Shutdown)
            .await
            .unwrap();
        let received = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server never observed terminal client shutdown")
            .unwrap();
        assert!(matches!(received, Some(Ok(Message::Close(_)))));
        tokio::time::timeout(Duration::from_secs(5), client)
            .await
            .expect("terminal client did not finish shutdown")
            .unwrap();
    }

    #[test]
    fn terminal_wire_round_trips_without_control_frames() {
        let open: TerminalFromCloud = serde_json::from_str(
            r#"{"type":"terminal.open","session_id":"s","agent":"Ada","mode":"view"}"#,
        )
        .unwrap();
        assert_eq!(
            open,
            TerminalFromCloud::Open {
                session_id: "s".into(),
                agent: "Ada".into(),
                mode: TerminalMode::View
            }
        );
        let output = serde_json::to_value(TerminalToCloud::Output {
            session_id: "s".into(),
            chunk: "x".into(),
            offset: Some(2),
        })
        .unwrap();
        assert_eq!(output["type"], "terminal.output");
        assert_eq!(output["offset"], 2);

        let output_without_offset = serde_json::to_value(TerminalToCloud::Output {
            session_id: "s".into(),
            chunk: "x".into(),
            offset: None,
        })
        .unwrap();
        assert!(output_without_offset.get("offset").is_none());

        for (wire, expected) in [
            (
                r#"{"type":"terminal.input","session_id":"s","data_base64":"eA=="}"#,
                TerminalFromCloud::Input {
                    session_id: "s".into(),
                    data_base64: "eA==".into(),
                },
            ),
            (
                r#"{"type":"terminal.resize","session_id":"s","rows":24,"cols":80}"#,
                TerminalFromCloud::Resize {
                    session_id: "s".into(),
                    rows: 24,
                    cols: 80,
                },
            ),
            (
                r#"{"type":"terminal.close","session_id":"s"}"#,
                TerminalFromCloud::Close {
                    session_id: "s".into(),
                },
            ),
        ] {
            assert_eq!(
                serde_json::from_str::<TerminalFromCloud>(wire).unwrap(),
                expected
            );
        }

        let ready = serde_json::to_value(TerminalToCloud::Ready {
            session_id: "s".into(),
            screen: "screen".into(),
            rows: 24,
            cols: 80,
            offset: 3,
            delivery_mode: None,
            delivery_revision: None,
        })
        .unwrap();
        assert_eq!(ready["type"], "terminal.ready");
        assert_eq!(ready["offset"], 3);
        assert!(ready.get("delivery_mode").is_none());
        let ready_with_mode = serde_json::to_value(TerminalToCloud::Ready {
            session_id: "s".into(),
            screen: "screen".into(),
            rows: 24,
            cols: 80,
            offset: 3,
            delivery_mode: Some(InboundDeliveryMode::ManualFlush),
            delivery_revision: Some("7".into()),
        })
        .unwrap();
        assert_eq!(ready_with_mode["delivery_mode"], "manual_flush");
        assert_eq!(ready_with_mode["delivery_revision"], "7");
        let snapshot = serde_json::to_value(TerminalToCloud::Snapshot {
            session_id: "s".into(),
            request_id: "snapshot-1".into(),
            screen: "screen".into(),
            rows: 24,
            cols: 80,
            offset: 4,
        })
        .unwrap();
        assert_eq!(snapshot["type"], "terminal.snapshot");
        assert_eq!(snapshot["request_id"], "snapshot-1");
        assert_eq!(snapshot["offset"], 4);
        let ack = serde_json::to_value(TerminalToCloud::InputAck {
            session_id: "s".into(),
            bytes_written: 1,
        })
        .unwrap();
        assert_eq!(ack["type"], "terminal.input_ack");
        let error = serde_json::to_value(TerminalToCloud::Error {
            session_id: "s".into(),
            code: "bad".into(),
            message: "nope".into(),
            request_id: None,
        })
        .unwrap();
        assert_eq!(error["type"], "terminal.error");
        assert_eq!(error["code"], "bad");
        assert!(error.get("request_id").is_none());
        let closed = serde_json::to_value(TerminalToCloud::Closed {
            session_id: "s".into(),
            code: None,
            message: None,
        })
        .unwrap();
        assert_eq!(closed["type"], "terminal.closed");
        assert!(closed.get("code").is_none());
        assert!(closed.get("message").is_none());
        let closed_with_error = serde_json::to_value(TerminalToCloud::Closed {
            session_id: "s".into(),
            code: Some("closed".into()),
            message: Some("done".into()),
        })
        .unwrap();
        assert_eq!(closed_with_error["code"], "closed");
        assert_eq!(closed_with_error["message"], "done");
    }

    #[test]
    fn delivery_mode_frames_round_trip() {
        use super::{InboundDeliveryMode, TerminalFromCloud, TerminalToCloud};

        // client→node: minimal (no optional fields)
        let set_mode: TerminalFromCloud = serde_json::from_str(
            r#"{"type":"terminal.set_delivery_mode","session_id":"s","mode":"auto_inject"}"#,
        )
        .unwrap();
        assert_eq!(
            set_mode,
            TerminalFromCloud::SetDeliveryMode {
                session_id: "s".into(),
                mode: InboundDeliveryMode::AutoInject,
                request_id: None,
                expected_mode: None,
                expected_revision: None,
            }
        );

        // client→node: with compare-and-set guards and request_id
        let set_mode_cas: TerminalFromCloud = serde_json::from_str(
            r#"{"type":"terminal.set_delivery_mode","session_id":"s","mode":"manual_flush","request_id":"rid1","expected_mode":"auto_inject","expected_revision":"7"}"#,
        )
        .unwrap();
        assert_eq!(
            set_mode_cas,
            TerminalFromCloud::SetDeliveryMode {
                session_id: "s".into(),
                mode: InboundDeliveryMode::ManualFlush,
                request_id: Some("rid1".into()),
                expected_mode: Some("auto_inject".into()),
                expected_revision: Some("7".into()),
            }
        );

        // An unknown expected_mode is accepted as a raw string (validated in fleet.rs,
        // not discarded by serde so the broker can reply with terminal.error).
        let set_mode_bad_guard: TerminalFromCloud = serde_json::from_str(
            r#"{"type":"terminal.set_delivery_mode","session_id":"s","mode":"auto_inject","expected_mode":"turbo"}"#,
        )
        .unwrap();
        assert_eq!(
            set_mode_bad_guard,
            TerminalFromCloud::SetDeliveryMode {
                session_id: "s".into(),
                mode: InboundDeliveryMode::AutoInject,
                request_id: None,
                expected_mode: Some("turbo".into()),
                expected_revision: None,
            }
        );

        // Serialising SetDeliveryMode omits None optional fields.
        let set_mode_json = serde_json::to_value(TerminalFromCloud::SetDeliveryMode {
            session_id: "s".into(),
            mode: InboundDeliveryMode::AutoInject,
            request_id: None,
            expected_mode: None,
            expected_revision: None,
        })
        .unwrap();
        assert_eq!(set_mode_json["type"], "terminal.set_delivery_mode");
        assert_eq!(set_mode_json["mode"], "auto_inject");
        assert!(set_mode_json.get("request_id").is_none());
        assert!(set_mode_json.get("expected_mode").is_none());
        assert!(set_mode_json.get("expected_revision").is_none());

        // node→client: success response (with echoed request_id)
        let reply = serde_json::to_value(TerminalToCloud::DeliveryMode {
            session_id: "s".into(),
            request_id: Some("rid1".into()),
            mode: InboundDeliveryMode::AutoInject,
            flushed: 3,
            matched: true,
            revision: "2".into(),
        })
        .unwrap();
        assert_eq!(reply["type"], "terminal.delivery_mode");
        assert_eq!(reply["request_id"], "rid1");
        assert_eq!(reply["mode"], "auto_inject");
        assert_eq!(reply["flushed"], 3);
        assert_eq!(reply["matched"], true);
        assert_eq!(reply["revision"], "2");

        // node→client: reply without request_id omits the field
        let reply_no_rid = serde_json::to_value(TerminalToCloud::DeliveryMode {
            session_id: "s".into(),
            request_id: None,
            mode: InboundDeliveryMode::AutoInject,
            flushed: 0,
            matched: true,
            revision: "1".into(),
        })
        .unwrap();
        assert!(reply_no_rid.get("request_id").is_none());

        // node→client: CAS miss (matched: false)
        let cas_miss = serde_json::to_value(TerminalToCloud::DeliveryMode {
            session_id: "s".into(),
            request_id: None,
            mode: InboundDeliveryMode::ManualFlush,
            flushed: 0,
            matched: false,
            revision: "1".into(),
        })
        .unwrap();
        assert_eq!(cas_miss["matched"], false);
        assert_eq!(cas_miss["mode"], "manual_flush");

        // node→client: op-scoped error echoes request_id
        let op_error = serde_json::to_value(TerminalToCloud::Error {
            session_id: "s".into(),
            code: "invalid_revision".into(),
            message: "bad revision".into(),
            request_id: Some("rid1".into()),
        })
        .unwrap();
        assert_eq!(op_error["request_id"], "rid1");

        // node→client: session-level error omits request_id
        let sess_error = serde_json::to_value(TerminalToCloud::Error {
            session_id: "s".into(),
            code: "session_not_found".into(),
            message: "not found".into(),
            request_id: None,
        })
        .unwrap();
        assert!(sess_error.get("request_id").is_none());
    }

    /// A blackholed `/v1/node/terminal/ws` — the socket sits open with
    /// nothing on the other end reading or writing — must be detected and
    /// reconnected. This is the fleet terminal-attach outage: node_control
    /// got this exact fix (ping + read-idle timeout) after the 2026-08-07
    /// finn-mini control-lane outage, but terminal_control never did. A
    /// long-lived node's terminal socket can die at the network level (a
    /// Cloudflare Durable Object's hibernatable WebSocket dropped without a
    /// close frame reaching the client, an idle proxy timeout, etc.) while
    /// this client's `select!` never leaves the connected state — so
    /// `agent-relay node agent attach` fails with "has no terminal
    /// transport" even though the broker itself believes it is still
    /// connected. Without [`READ_IDLE_TIMEOUT`] the second `accept()` below
    /// never happens and this test fails on the outer timeout.
    #[tokio::test]
    async fn terminal_control_reconnects_when_peer_goes_silent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!(
            "ws://{}/v1/node/terminal/ws",
            listener.local_addr().unwrap()
        );
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let session_token = Arc::new(RwLock::new(Some("nt_test".to_string())));

        tokio::spawn(run_terminal_control_client(
            TerminalControlConfig {
                ws_url,
                session_token,
                // Short window so the blackhole is covered in well under a
                // second; production uses READ_IDLE_TIMEOUT (48s).
                read_idle_timeout: Some(Duration::from_millis(400)),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws = accept_async(stream).await.unwrap();
            // Go silent: hold the socket open but never poll it again. Not
            // draining is the point — an unpolled socket still looks open to
            // the client, which is the blackhole this guards against.
            let hold = tokio::spawn(async move {
                let _ws = ws;
                std::future::pending::<()>().await;
            });

            // The client must give up on the silent connection and dial again.
            let (stream, _) = listener.accept().await.unwrap();
            let _ws2 = accept_async(stream).await.unwrap();
            hold.abort();
        });

        // Comfortably above the 400ms window plus reconnect backoff. Without
        // the read-idle check the reconnect never comes at all, so this
        // bound is what turns the hang into a failure.
        tokio::time::timeout(Duration::from_secs(20), server)
            .await
            .expect("client never reconnected after the peer went silent")
            .unwrap();

        // Both connect attempts must surface as `Connected` events — that is
        // what flips the cloud-side `terminal_connected` flag an attach
        // depends on.
        let mut connected_events = 0;
        while let Ok(Some(event)) =
            tokio::time::timeout(Duration::from_millis(50), event_rx.recv()).await
        {
            if matches!(event, TerminalControlEvent::Connected) {
                connected_events += 1;
            }
        }
        assert!(
            connected_events >= 2,
            "expected at least 2 Connected events (initial + reconnect), got {connected_events}"
        );

        let _ = command_tx.send(TerminalControlCommand::Shutdown).await;
    }

    /// The must-not-fire control arm for the blackhole test above, under the
    /// SAME clock. The negative test proves the detector CAN fire; on its own
    /// that is also what a detector that disconnects unconditionally after
    /// the window would do. This proves it does not fire when the peer is
    /// merely idle at the application layer but still servicing the socket
    /// (so pings get answered) — the actual claim this mechanism makes.
    #[tokio::test]
    async fn terminal_control_stays_connected_when_peer_is_idle_but_polling() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!(
            "ws://{}/v1/node/terminal/ws",
            listener.local_addr().unwrap()
        );
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, _event_rx) = mpsc::channel(32);
        let session_token = Arc::new(RwLock::new(Some("nt_test".to_string())));

        tokio::spawn(run_terminal_control_client(
            TerminalControlConfig {
                ws_url,
                session_token,
                // Same window as the blackhole test, so this is a genuine
                // control arm under identical time pressure rather than a
                // separate, looser test.
                read_idle_timeout: Some(Duration::from_millis(400)),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            // Stay live: keep polling the socket so tungstenite answers every
            // ping with a pong, the only traffic an idle-but-healthy cloud
            // side is guaranteed to produce. This is the opposite of the
            // blackhole test's `hold` task, which never polls again.
            let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
            let drain = tokio::spawn(async move {
                loop {
                    tokio::select! {
                        msg = ws.next() => {
                            if msg.is_none() {
                                break;
                            }
                        }
                        _ = &mut stop_rx => break,
                    }
                }
            });

            // Comfortably longer than the 400ms window — several ping
            // intervals' worth of silence at the application layer, serviced
            // only by ping/pong.
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let _ = stop_tx.send(());
            drain.abort();

            // If the client had disconnected and reconnected, a second
            // connection attempt would already be waiting here. None should
            // exist: the accept must still be empty.
            let second_connection =
                tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
            assert!(
                second_connection.is_err(),
                "client reconnected even though the peer stayed live and kept polling"
            );
        });

        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server task did not complete")
            .unwrap();
        let _ = command_tx.send(TerminalControlCommand::Shutdown).await;
    }

    const WEDGE_CHUNK_BYTES: usize = 256 * 1024;
    const WEDGE_CHUNK_COUNT: usize = 128; // 32MB total: comfortably past any real OS send-buffer default.

    /// The P1 case: a peer that accepts the connection and then stops
    /// reading, with terminal output queued against it, must not be able to
    /// wedge the read/ping watchdog. Before `run_terminal_writer` was split
    /// into its own task, `TerminalControlCommand::Send`'s `sink.send(...)
    /// .await` ran directly inside this module's `select!` — once the
    /// client's real TCP send buffer filled (a receiver that never reads
    /// never grows its advertised window), that await would block
    /// indefinitely and `ping_interval.tick()` would never fire again,
    /// so `read_idle_timeout` was never checked either. A watchdog the
    /// thing it watches can starve is not a watchdog. This test fails
    /// (times out) against that shape and passes once writes are moved off
    /// the watchdog's loop.

    #[tokio::test]
    async fn terminal_control_watchdog_survives_a_wedged_writer() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!(
            "ws://{}/v1/node/terminal/ws",
            listener.local_addr().unwrap()
        );
        let (command_tx, command_rx) = mpsc::channel(WEDGE_CHUNK_COUNT + 16);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let session_token = Arc::new(RwLock::new(Some("nt_test".to_string())));

        tokio::spawn(run_terminal_control_client(
            TerminalControlConfig {
                ws_url,
                session_token,
                read_idle_timeout: Some(Duration::from_millis(500)),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws = accept_async(stream).await.unwrap();
            // Accept, then never read again — not even the handshake's
            // follow-on frames. This is what lets the client's kernel send
            // buffer actually fill instead of merely queuing in userspace.
            let hold = tokio::spawn(async move {
                let _ws = ws;
                std::future::pending::<()>().await;
            });

            // The watchdog must still give up on this connection and dial
            // again, despite the queued output below.
            let (stream, _) = listener.accept().await.unwrap();
            let _ws2 = accept_async(stream).await.unwrap();
            hold.abort();
        });

        let chunk = "x".repeat(WEDGE_CHUNK_BYTES);
        for _ in 0..WEDGE_CHUNK_COUNT {
            command_tx
                .send(TerminalControlCommand::Send(TerminalToCloud::Output {
                    session_id: "s".into(),
                    chunk: chunk.clone(),
                    offset: None,
                }))
                .await
                .unwrap();
        }

        // Comfortably above the 500ms read-idle window plus reconnect
        // backoff. Without an independent watchdog, the wedged write hangs
        // this forever, so this bound is what turns the hang into a
        // failure.
        tokio::time::timeout(Duration::from_secs(20), server)
            .await
            .expect("watchdog never reconnected despite a wedged write")
            .unwrap();

        let mut connected_events = 0;
        while let Ok(Some(event)) =
            tokio::time::timeout(Duration::from_millis(50), event_rx.recv()).await
        {
            if matches!(event, TerminalControlEvent::Connected) {
                connected_events += 1;
            }
        }
        assert!(
            connected_events >= 2,
            "expected at least 2 Connected events (initial + reconnect), got {connected_events}"
        );

        let _ = command_tx.send(TerminalControlCommand::Shutdown).await;
    }

    /// Pins the teardown contract: when the event consumer goes away, the
    /// connection closes rather than lingering.
    ///
    /// Read the pass carefully — this test passes with AND without the explicit
    /// `writer.abort()`, because dropping `writer_tx`/`priority_tx` on the way
    /// out already ends the writer via `recv() -> None`. It is therefore NOT
    /// regression coverage for the abort, and should not be cited as such. It
    /// guards the contract against a future edit that keeps a sender alive past
    /// the return, which is the shape that would turn this into a real leak.
    #[tokio::test]
    async fn dropping_the_event_consumer_takes_the_writer_down() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!(
            "ws://{}/v1/node/terminal/ws",
            listener.local_addr().unwrap()
        );
        let (_command_tx, command_rx) = mpsc::channel(8);
        // Capacity 1 and an immediately-dropped receiver: the first inbound
        // frame the client tries to hand upward fails to send.
        let (event_tx, event_rx) = mpsc::channel(1);
        let session_token = Arc::new(RwLock::new(Some("nt_test".to_string())));

        tokio::spawn(run_terminal_control_client(
            TerminalControlConfig {
                ws_url,
                session_token,
                read_idle_timeout: Some(Duration::from_secs(30)),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            // Drop the consumer only after the client is connected, so the
            // failure happens on the inbound path rather than at startup.
            drop(event_rx);
            let frame =
                serde_json::json!({"type":"terminal.input","session_id":"s1","data_base64":"aGk="})
                    .to_string();
            let _ = ws.send(Message::Text(frame)).await;
            // With the writer aborted the connection tears down; without it the
            // writer keeps the write half alive and this never resolves.
            loop {
                match ws.next().await {
                    Some(Ok(_)) => continue,
                    Some(Err(_)) | None => break,
                }
            }
        });

        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("writer outlived the dropped consumer; the connection never closed")
            .unwrap();
    }

    /// The must-not-fire control arm for the wedged-writer test above, under
    /// the same payload and the same read-idle window. A peer that actually
    /// drains a large but legitimate output burst must not be disconnected —
    /// proving the watchdog reacts to a stalled write, not merely to a large
    /// one.
    #[tokio::test]
    async fn terminal_control_large_output_does_not_disconnect_a_draining_peer() {
        // Deliberately modest, unlike the wedge test's 32MB: this arm's job
        // is only to prove ordinary queued output doesn't itself trip the
        // watchdog when the peer keeps reading. Relying on genuine multi-MB
        // TCP backpressure timing here — a negative assertion racing a fixed
        // drain window under real OS scheduling — is exactly the kind of
        // thing that reads as flaky and shouldn't need to be.
        const CHUNK_BYTES: usize = 4 * 1024;
        const CHUNK_COUNT: usize = 20;
        let expected_bytes = CHUNK_BYTES * CHUNK_COUNT;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!(
            "ws://{}/v1/node/terminal/ws",
            listener.local_addr().unwrap()
        );
        let (command_tx, command_rx) = mpsc::channel(CHUNK_COUNT + 16);
        let (event_tx, _event_rx) = mpsc::channel(32);
        let session_token = Arc::new(RwLock::new(Some("nt_test".to_string())));

        tokio::spawn(run_terminal_control_client(
            TerminalControlConfig {
                ws_url,
                session_token,
                // Same window as the wedged-writer test, so this is a
                // genuine control arm under identical time pressure rather
                // than a separate, looser test.
                read_idle_timeout: Some(Duration::from_millis(500)),
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let drain = tokio::spawn(async move {
                let mut received = 0usize;
                while let Some(Ok(msg)) = ws.next().await {
                    if let Message::Text(text) = msg {
                        received += text.len();
                        if received >= expected_bytes {
                            break;
                        }
                    }
                }
                received
            });
            let received = tokio::time::timeout(Duration::from_secs(5), drain)
                .await
                .expect("server never finished draining the client's output")
                .unwrap();
            assert!(
                received >= expected_bytes,
                "did not receive the full payload: {received} < {expected_bytes}"
            );

            // If the client had disconnected and reconnected, a second
            // connection attempt would already be waiting here. None
            // should exist: sending legitimate output must not spuriously
            // trip the watchdog.
            let second_connection =
                tokio::time::timeout(Duration::from_millis(700), listener.accept()).await;
            assert!(
                second_connection.is_err(),
                "client reconnected even though the peer kept draining legitimate output"
            );
        });

        let chunk = "x".repeat(CHUNK_BYTES);
        for _ in 0..CHUNK_COUNT {
            command_tx
                .send(TerminalControlCommand::Send(TerminalToCloud::Output {
                    session_id: "s".into(),
                    chunk: chunk.clone(),
                    offset: None,
                }))
                .await
                .unwrap();
        }

        tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect("server task did not complete")
            .unwrap();
        let _ = command_tx.send(TerminalControlCommand::Shutdown).await;
    }
}
