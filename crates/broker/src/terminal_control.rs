//! Dedicated Relaycast terminal transport.
//!
//! This deliberately does not share `node_control`: terminal output can be
//! continuous and subject to backpressure, whereas node registration,
//! heartbeats, and action delivery need a small independent control lane.

use std::{
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use futures_util::{SinkExt, StreamExt};
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
        let (mut sink, mut stream) = socket.split();
        let mut connected = true;
        let mut last_inbound = Instant::now();
        let read_idle_timeout = config.read_idle_timeout.unwrap_or(READ_IDLE_TIMEOUT);
        let mut ping_interval = tokio::time::interval(PING_INTERVAL.min(read_idle_timeout / 4));
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        while connected {
            tokio::select! {
                command = command_rx.recv() => match command {
                    Some(TerminalControlCommand::Send(message)) => {
                        match serde_json::to_string(&message) {
                            Ok(encoded) => {
                                if sink.send(Message::Text(encoded)).await.is_err() {
                                    connected = false;
                                }
                            }
                            Err(_) => connected = false,
                        }
                    }
                    Some(TerminalControlCommand::Shutdown) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        return;
                    }
                },
                _ = ping_interval.tick() => {
                    // Checked before the write, because the write is exactly
                    // what cannot be trusted here: it keeps succeeding on a
                    // blackholed socket. Silence past the window is the only
                    // local evidence that the cloud side stopped hearing us.
                    let idle = last_inbound.elapsed();
                    if idle >= read_idle_timeout {
                        tracing::warn!(
                            target = "relay_broker::terminal",
                            idle_secs = idle.as_secs(),
                            "no inbound fleet terminal frame within the read-idle window; reconnecting"
                        );
                        connected = false;
                    } else if sink.send(Message::Ping(Vec::new())).await.is_err() {
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
                                Ok(message) => { if event_tx.send(TerminalControlEvent::Message(message)).await.is_err() { return; } }
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
        let _ = event_tx.send(TerminalControlEvent::Disconnected).await;
        tokio::time::sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, RwLock};
    use std::time::Duration;

    use futures_util::StreamExt;
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use tokio_tungstenite::accept_async;

    use super::{
        run_terminal_control_client, InboundDeliveryMode, TerminalControlCommand,
        TerminalControlConfig, TerminalControlEvent, TerminalFromCloud, TerminalMode,
        TerminalToCloud,
    };

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
        let ws_url = format!("ws://{}/v1/node/terminal/ws", listener.local_addr().unwrap());
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
        let ws_url = format!("ws://{}/v1/node/terminal/ws", listener.local_addr().unwrap());
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
}
