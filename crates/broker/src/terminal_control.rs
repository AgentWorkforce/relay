//! Dedicated Relaycast terminal transport.
//!
//! This deliberately does not share `node_control`: terminal output can be
//! continuous and subject to backpressure, whereas node registration,
//! heartbeats, and action delivery need a small independent control lane.

use std::{
    sync::{Arc, RwLock},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use relaycast::ORIGIN_ACTOR_HEADER;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
const TOKEN_WAIT_DELAY: Duration = Duration::from_secs(1);

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
    #[serde(rename = "terminal.close")]
    Close { session_id: String },
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
    },
    #[serde(rename = "terminal.closed")]
    Closed {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
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
                inbound = stream.next() => match inbound {
                    Some(Ok(Message::Text(text))) => match serde_json::from_str::<TerminalFromCloud>(&text) {
                        Ok(message) => { if event_tx.send(TerminalControlEvent::Message(message)).await.is_err() { return; } }
                        Err(error) => tracing::warn!(target = "relay_broker::terminal", error = %error, "invalid fleet terminal frame"),
                    },
                    Some(Ok(Message::Ping(_))) => {}
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => connected = false,
                    Some(Ok(_)) => {},
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
    use super::{TerminalFromCloud, TerminalMode, TerminalToCloud};

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
        })
        .unwrap();
        assert_eq!(ready["type"], "terminal.ready");
        assert_eq!(ready["offset"], 3);
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
        })
        .unwrap();
        assert_eq!(error["type"], "terminal.error");
        assert_eq!(error["code"], "bad");
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
}
