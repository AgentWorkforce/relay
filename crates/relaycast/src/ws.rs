//! WebSocket client for real-time events.

use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::time::{Duration, MissedTickBehavior};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, warn};
use url::Url;

use crate::error::{RelayError, Result};
use crate::types::WsEvent;

const DEFAULT_BASE_URL: &str = "https://api.relaycast.dev";
const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_ORIGIN_SURFACE: &str = "sdk";
const DEFAULT_ORIGIN_CLIENT: &str = "@relaycast/sdk-rust";
const PING_INTERVAL_SECS: u64 = 30;
const DEFAULT_MAX_RECONNECT_ATTEMPTS: u32 = 10;
const DEFAULT_MAX_RECONNECT_DELAY_MS: u64 = 30_000;

/// Options for creating a WebSocket client.
#[derive(Debug, Clone)]
pub struct WsClientOptions {
    /// The agent token for authentication.
    pub token: String,
    /// The base URL for the API (defaults to https://api.relaycast.dev).
    pub base_url: Option<String>,
    /// Enable debug logging for dropped/malformed messages.
    pub debug: bool,
    /// SDK origin surface metadata.
    pub origin_surface: Option<String>,
    /// SDK origin client metadata.
    pub origin_client: Option<String>,
    /// SDK origin version metadata.
    pub origin_version: Option<String>,
    /// Maximum reconnect attempts before giving up (default: 10).
    pub max_reconnect_attempts: Option<u32>,
    /// Maximum reconnect delay in milliseconds (default: 30000).
    pub max_reconnect_delay_ms: Option<u64>,
}

impl WsClientOptions {
    /// Create new WebSocket client options with the given token.
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            base_url: None,
            debug: false,
            origin_surface: None,
            origin_client: None,
            origin_version: None,
            max_reconnect_attempts: None,
            max_reconnect_delay_ms: None,
        }
    }

    /// Set a custom base URL.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Enable debug logging.
    pub fn with_debug(mut self, debug: bool) -> Self {
        self.debug = debug;
        self
    }

    /// Set origin metadata query params for WebSocket handshake.
    pub fn with_origin(
        mut self,
        origin_surface: impl Into<String>,
        origin_client: impl Into<String>,
        origin_version: impl Into<String>,
    ) -> Self {
        self.origin_surface = Some(origin_surface.into());
        self.origin_client = Some(origin_client.into());
        self.origin_version = Some(origin_version.into());
        self
    }

    /// Set max reconnect attempts.
    pub fn with_max_reconnect_attempts(mut self, attempts: u32) -> Self {
        self.max_reconnect_attempts = Some(attempts);
        self
    }

    /// Set max reconnect delay in milliseconds.
    pub fn with_max_reconnect_delay_ms(mut self, delay_ms: u64) -> Self {
        self.max_reconnect_delay_ms = Some(delay_ms);
        self
    }
}

/// A handle for subscribing to WebSocket events.
pub type EventReceiver = broadcast::Receiver<WsEvent>;
/// A handle for subscribing to WebSocket lifecycle events.
pub type LifecycleReceiver = broadcast::Receiver<WsLifecycleEvent>;

/// Lifecycle events emitted by the WebSocket client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsLifecycleEvent {
    Open,
    Close,
    Error(String),
    Reconnecting { attempt: u32 },
}

/// WebSocket client for receiving real-time events.
pub struct WsClient {
    token: Arc<Mutex<String>>,
    base_url: String,
    debug: bool,
    origin_surface: String,
    origin_client: String,
    origin_version: String,
    max_reconnect_attempts: u32,
    max_reconnect_delay_ms: u64,
    event_tx: broadcast::Sender<WsEvent>,
    lifecycle_tx: broadcast::Sender<WsLifecycleEvent>,
    command_tx: Option<mpsc::Sender<WsCommand>>,
    is_connected: Arc<Mutex<bool>>,
}

enum WsCommand {
    Subscribe(Vec<String>),
    Unsubscribe(Vec<String>),
    Disconnect,
}

impl WsClient {
    /// Create a new WebSocket client with the given options.
    pub fn new(options: WsClientOptions) -> Self {
        let base_url = options
            .base_url
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
            .replace("https://", "wss://")
            .replace("http://", "ws://");

        let (event_tx, _) = broadcast::channel(1024);
        let (lifecycle_tx, _) = broadcast::channel(128);

        Self {
            token: Arc::new(Mutex::new(options.token)),
            base_url: base_url.trim_end_matches('/').to_string(),
            debug: options.debug,
            origin_surface: options
                .origin_surface
                .unwrap_or_else(|| DEFAULT_ORIGIN_SURFACE.to_string()),
            origin_client: options
                .origin_client
                .unwrap_or_else(|| DEFAULT_ORIGIN_CLIENT.to_string()),
            origin_version: options
                .origin_version
                .unwrap_or_else(|| SDK_VERSION.to_string()),
            max_reconnect_attempts: options
                .max_reconnect_attempts
                .unwrap_or(DEFAULT_MAX_RECONNECT_ATTEMPTS),
            max_reconnect_delay_ms: options
                .max_reconnect_delay_ms
                .unwrap_or(DEFAULT_MAX_RECONNECT_DELAY_MS),
            event_tx,
            lifecycle_tx,
            command_tx: None,
            is_connected: Arc::new(Mutex::new(false)),
        }
    }

    /// Check if the WebSocket is connected.
    pub async fn is_connected(&self) -> bool {
        *self.is_connected.lock().await
    }

    /// Subscribe to receive events.
    pub fn subscribe_events(&self) -> EventReceiver {
        self.event_tx.subscribe()
    }

    /// Subscribe to lifecycle events.
    pub fn subscribe_lifecycle(&self) -> LifecycleReceiver {
        self.lifecycle_tx.subscribe()
    }

    /// Update the token used for subsequent reconnect attempts.
    pub async fn set_token(&self, token: impl Into<String>) {
        *self.token.lock().await = token.into();
    }

    /// Connect to the WebSocket server.
    pub async fn connect(&mut self) -> Result<()> {
        if *self.is_connected.lock().await {
            return Ok(());
        }

        let mut url = Url::parse(&format!("{}/v1/ws", self.base_url))?;
        {
            let token = self.token.lock().await.clone();
            let mut query = url.query_pairs_mut();
            query.append_pair("token", &token);
            query.append_pair("origin_surface", &self.origin_surface);
            query.append_pair("origin_client", &self.origin_client);
            query.append_pair("origin_version", &self.origin_version);
        }

        let (ws_stream, _) = connect_async(url.as_str()).await?;

        let (command_tx, mut command_rx) = mpsc::channel::<WsCommand>(32);
        self.command_tx = Some(command_tx);

        let token = self.token.clone();
        let event_tx = self.event_tx.clone();
        let lifecycle_tx = self.lifecycle_tx.clone();
        let is_connected = self.is_connected.clone();
        let debug = self.debug;
        let base_url = self.base_url.clone();
        let origin_surface = self.origin_surface.clone();
        let origin_client = self.origin_client.clone();
        let origin_version = self.origin_version.clone();
        let max_reconnect_attempts = self.max_reconnect_attempts;
        let max_reconnect_delay_ms = self.max_reconnect_delay_ms;

        *is_connected.lock().await = true;

        // Spawn the WebSocket handler task
        tokio::spawn(async move {
            let mut subscribed_channels: HashSet<String> = HashSet::new();
            let mut current_stream = Some(ws_stream);
            let mut reconnect_attempt = 0u32;
            let mut should_stop = false;

            'outer: while !should_stop {
                let stream = if let Some(stream) = current_stream.take() {
                    stream
                } else {
                    let mut reconnect_url = match Url::parse(&format!("{}/v1/ws", base_url)) {
                        Ok(url) => url,
                        Err(err) => {
                            let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                            break 'outer;
                        }
                    };

                    let current_token = token.lock().await.clone();
                    {
                        let mut query = reconnect_url.query_pairs_mut();
                        query.append_pair("token", &current_token);
                        query.append_pair("origin_surface", &origin_surface);
                        query.append_pair("origin_client", &origin_client);
                        query.append_pair("origin_version", &origin_version);
                    }

                    match connect_async(reconnect_url.as_str()).await {
                        Ok((stream, _)) => stream,
                        Err(err) => {
                            let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));

                            if reconnect_attempt >= max_reconnect_attempts {
                                break 'outer;
                            }
                            reconnect_attempt += 1;
                            let _ = lifecycle_tx.send(WsLifecycleEvent::Reconnecting {
                                attempt: reconnect_attempt,
                            });
                            let delay_ms =
                                reconnect_delay_ms(reconnect_attempt, max_reconnect_delay_ms);
                            let reconnect_sleep =
                                tokio::time::sleep(Duration::from_millis(delay_ms));
                            tokio::pin!(reconnect_sleep);

                            loop {
                                tokio::select! {
                                    _ = &mut reconnect_sleep => break,
                                    cmd = command_rx.recv() => {
                                        match cmd {
                                            Some(WsCommand::Subscribe(channels)) => {
                                                for ch in channels {
                                                    subscribed_channels.insert(ch);
                                                }
                                            }
                                            Some(WsCommand::Unsubscribe(channels)) => {
                                                for ch in channels {
                                                    subscribed_channels.remove(&ch);
                                                }
                                            }
                                            Some(WsCommand::Disconnect) | None => {
                                                should_stop = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            continue;
                        }
                    }
                };

                let (mut write, mut read) = stream.split();
                reconnect_attempt = 0;
                *is_connected.lock().await = true;
                let _ = lifecycle_tx.send(WsLifecycleEvent::Open);

                // Re-subscribe all known channels on every new socket.
                if !subscribed_channels.is_empty() {
                    let msg = serde_json::json!({
                        "type": "subscribe",
                        "channels": subscribed_channels.iter().cloned().collect::<Vec<_>>()
                    });
                    if let Err(err) = write.send(Message::Text(msg.to_string())).await {
                        let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                        *is_connected.lock().await = false;
                        continue;
                    }
                }

                let mut ping_interval =
                    tokio::time::interval(Duration::from_secs(PING_INTERVAL_SECS));
                ping_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

                loop {
                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    match serde_json::from_str::<WsEvent>(&text) {
                                        Ok(event) => {
                                            let _ = event_tx.send(event);
                                        }
                                        Err(err) => {
                                            if debug {
                                                warn!("[relaycast] Dropped WebSocket message: {}: {}", err, &text[..text.len().min(200)]);
                                            }
                                        }
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => {
                                    debug!("WebSocket connection closed");
                                    break;
                                }
                                Some(Err(err)) => {
                                    let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                    break;
                                }
                                _ => {}
                            }
                        }
                        cmd = command_rx.recv() => {
                            match cmd {
                                Some(WsCommand::Subscribe(channels)) => {
                                    for ch in &channels {
                                        subscribed_channels.insert(ch.clone());
                                    }
                                    let msg = serde_json::json!({
                                        "type": "subscribe",
                                        "channels": channels
                                    });
                                    if let Err(err) = write.send(Message::Text(msg.to_string())).await {
                                        let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                        break;
                                    }
                                }
                                Some(WsCommand::Unsubscribe(channels)) => {
                                    for ch in &channels {
                                        subscribed_channels.remove(ch);
                                    }
                                    let msg = serde_json::json!({
                                        "type": "unsubscribe",
                                        "channels": channels
                                    });
                                    if let Err(err) = write.send(Message::Text(msg.to_string())).await {
                                        let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                        break;
                                    }
                                }
                                Some(WsCommand::Disconnect) | None => {
                                    should_stop = true;
                                    let _ = write.send(Message::Close(None)).await;
                                    break;
                                }
                            }
                        }
                        _ = ping_interval.tick() => {
                            let ping = serde_json::json!({"type": "ping"});
                            if let Err(err) = write.send(Message::Text(ping.to_string())).await {
                                let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                break;
                            }
                        }
                    }
                }

                *is_connected.lock().await = false;
                let _ = lifecycle_tx.send(WsLifecycleEvent::Close);

                if should_stop {
                    break 'outer;
                }

                if reconnect_attempt >= max_reconnect_attempts {
                    break 'outer;
                }
                reconnect_attempt += 1;
                let _ = lifecycle_tx.send(WsLifecycleEvent::Reconnecting {
                    attempt: reconnect_attempt,
                });
                let delay_ms = reconnect_delay_ms(reconnect_attempt, max_reconnect_delay_ms);
                let reconnect_sleep = tokio::time::sleep(Duration::from_millis(delay_ms));
                tokio::pin!(reconnect_sleep);

                loop {
                    tokio::select! {
                        _ = &mut reconnect_sleep => break,
                        cmd = command_rx.recv() => {
                            match cmd {
                                Some(WsCommand::Subscribe(channels)) => {
                                    for ch in channels {
                                        subscribed_channels.insert(ch);
                                    }
                                }
                                Some(WsCommand::Unsubscribe(channels)) => {
                                    for ch in channels {
                                        subscribed_channels.remove(&ch);
                                    }
                                }
                                Some(WsCommand::Disconnect) | None => {
                                    should_stop = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            *is_connected.lock().await = false;
        });

        Ok(())
    }

    /// Disconnect from the WebSocket server.
    pub async fn disconnect(&mut self) {
        if let Some(tx) = self.command_tx.take() {
            let _ = tx.send(WsCommand::Disconnect).await;
        }
        *self.is_connected.lock().await = false;
    }

    /// Subscribe to channels.
    pub async fn subscribe(&self, channels: Vec<String>) -> Result<()> {
        if let Some(ref tx) = self.command_tx {
            tx.send(WsCommand::Subscribe(channels))
                .await
                .map_err(|_| RelayError::NotConnected)?;
            Ok(())
        } else {
            Err(RelayError::NotConnected)
        }
    }

    /// Unsubscribe from channels.
    pub async fn unsubscribe(&self, channels: Vec<String>) -> Result<()> {
        if let Some(ref tx) = self.command_tx {
            tx.send(WsCommand::Unsubscribe(channels))
                .await
                .map_err(|_| RelayError::NotConnected)?;
            Ok(())
        } else {
            Err(RelayError::NotConnected)
        }
    }
}

impl Drop for WsClient {
    fn drop(&mut self) {
        // Note: We can't call async disconnect here, but the task will
        // eventually clean up when the channels are dropped
    }
}

fn reconnect_delay_ms(attempt: u32, max_delay_ms: u64) -> u64 {
    let exp = attempt.saturating_sub(1);
    let delay = 1_000u64.saturating_mul(2u64.saturating_pow(exp));
    delay.min(max_delay_ms.max(1_000))
}
