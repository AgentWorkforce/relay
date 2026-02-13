use std::{collections::HashSet, sync::Arc, time::Duration};

use anyhow::Result;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rand::Rng;
use reqwest::Url;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::{
    auth::{AuthClient, CredentialCache},
    events::EventEmitter,
};

#[derive(Debug, Clone)]
pub enum WsControl {
    Shutdown,
}

#[derive(Clone)]
pub struct RelaycastWsClient {
    base_url: String,
    auth: AuthClient,
    token: Arc<Mutex<String>>,
    creds: Arc<Mutex<CredentialCache>>,
    subscriptions: Arc<Mutex<HashSet<String>>>,
}

impl RelaycastWsClient {
    pub fn new(
        base_url: impl Into<String>,
        auth: AuthClient,
        token: String,
        creds: CredentialCache,
        channels: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            auth,
            token: Arc::new(Mutex::new(token)),
            creds: Arc::new(Mutex::new(creds)),
            subscriptions: Arc::new(Mutex::new(channels.into_iter().collect())),
        }
    }

    pub fn active_subscriptions(&self) -> Vec<String> {
        self.subscriptions.lock().iter().cloned().collect()
    }

    pub async fn run(
        &self,
        inbound_tx: mpsc::Sender<Value>,
        mut control_rx: mpsc::Receiver<WsControl>,
        events: EventEmitter,
    ) {
        let mut attempt = 0u32;
        let mut has_connected = false;

        loop {
            let token = self.token.lock().clone();
            let ws_url = match build_ws_stream_url(&self.base_url, &token) {
                Ok(url) => url,
                Err(error) => {
                    tracing::warn!(
                        target = "relay_broker::ws",
                        base_url = %self.base_url,
                        error = %error,
                        "invalid websocket base url"
                    );
                    attempt += 1;
                    tokio::time::sleep(reconnect_delay(attempt)).await;
                    continue;
                }
            };
            let ws_endpoint = ws_url
                .split_once('?')
                .map(|(prefix, _)| prefix)
                .unwrap_or(&ws_url);

            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((ws, _)) => {
                    let status = if has_connected {
                        "reconnected"
                    } else {
                        "connected"
                    };
                    has_connected = true;
                    events.emit("connection", json!({"status":status}));
                    let _ = inbound_tx
                        .send(json!({
                            "type":"broker.connection",
                            "payload":{"status":status}
                        }))
                        .await;
                    attempt = 0;
                    let (mut write, mut read) = ws.split();

                    let channels = self.active_subscriptions();
                    if !channels.is_empty() {
                        match write
                            .send(Message::Text(
                                json!({"type":"subscribe","channels":channels}).to_string(),
                            ))
                            .await
                        {
                            Ok(()) => {
                                for channel in &channels {
                                    let _ = inbound_tx
                                        .send(json!({
                                            "type":"broker.channel_join",
                                            "payload":{"channel":channel}
                                        }))
                                        .await;
                                }
                            }
                            Err(error) => {
                                tracing::warn!(
                                    target = "relay_broker::ws",
                                    error = %error,
                                    "batched channel subscribe failed; falling back to per-channel subscribe"
                                );
                                for channel in &channels {
                                    match write
                                        .send(Message::Text(
                                            json!({"type":"subscribe","channel":channel})
                                                .to_string(),
                                        ))
                                        .await
                                    {
                                        Ok(()) => {
                                            let _ = inbound_tx
                                                .send(json!({
                                                    "type":"broker.channel_join",
                                                    "payload":{"channel":channel}
                                                }))
                                                .await;
                                        }
                                        Err(error) => {
                                            tracing::warn!(target = "relay_broker::ws", channel = %channel, error = %error, "failed to subscribe channel");
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let mut shutdown = false;
                    while !shutdown {
                        tokio::select! {
                            ctrl = control_rx.recv() => {
                                match ctrl {
                                    Some(WsControl::Shutdown) | None => {
                                        let _ = write.close().await;
                                        shutdown = true;
                                    }
                                }
                            }
                            frame = read.next() => {
                                match frame {
                                    Some(Ok(Message::Text(text))) => {
                                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                            let _ = inbound_tx.send(value).await;
                                        } else {
                                            tracing::debug!(
                                                target = "relay_broker::ws",
                                                raw = %text,
                                                "ignoring non-json text frame"
                                            );
                                        }
                                    }
                                    Some(Ok(Message::Binary(_))) => {}
                                    Some(Ok(Message::Close(_))) | None => {
                                        break;
                                    }
                                    Some(Err(error)) => {
                                        tracing::warn!(target = "relay_broker::ws", error = %error, "ws read error");
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }

                    if shutdown {
                        break;
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        target = "relay_broker::ws",
                        endpoint = %ws_endpoint,
                        error = %error,
                        "ws connect failed"
                    );
                }
            }

            events.emit("connection", json!({"status":"disconnected"}));
            let _ = inbound_tx
                .send(json!({
                    "type":"broker.connection",
                    "payload":{"status":"disconnected"}
                }))
                .await;
            attempt += 1;
            if let Err(error) = self.refresh_token().await {
                tracing::warn!(target = "relay_broker::ws", error = %error, "token refresh failed");
            }
            tokio::time::sleep(reconnect_delay(attempt)).await;
        }
    }

    async fn refresh_token(&self) -> Result<()> {
        let creds = self.creds.lock().clone();
        let refreshed = self.auth.refresh_session(&creds).await?;
        *self.token.lock() = refreshed.token;
        *self.creds.lock() = refreshed.credentials;
        Ok(())
    }
}

pub fn build_ws_stream_url(base_url: &str, token: &str) -> Result<String> {
    let raw = base_url.trim();
    let normalized = if raw.starts_with("wss://") || raw.starts_with("ws://") {
        raw.to_string()
    } else if let Some(rest) = raw.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = raw.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("wss://{raw}")
    };

    let mut url = Url::parse(&normalized)?;
    let path = url.path().trim_end_matches('/').to_string();

    let final_path = if path.is_empty() {
        "/v1/stream".to_string()
    } else if path.ends_with("/v1/stream") {
        path
    } else if path.ends_with("/v1") {
        format!("{path}/stream")
    } else {
        format!("{path}/v1/stream")
    };
    url.set_path(&final_path);

    let mut preserved: Vec<(String, String)> = Vec::new();
    for (k, v) in url.query_pairs() {
        if k != "token" {
            preserved.push((k.into_owned(), v.into_owned()));
        }
    }
    {
        let mut pairs = url.query_pairs_mut();
        pairs.clear();
        for (k, v) in preserved {
            pairs.append_pair(&k, &v);
        }
        pairs.append_pair("token", token);
    }

    Ok(url.to_string())
}

pub fn reconnect_delay(attempt: u32) -> Duration {
    let base_ms = (1_000u64).saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)));
    let bounded = base_ms.min(30_000);
    let jitter = rand::thread_rng().gen_range(0..=250);
    Duration::from_millis(bounded + jitter)
}

#[cfg(test)]
mod tests {
    use super::{build_ws_stream_url, reconnect_delay};

    #[test]
    fn backoff_with_jitter_stays_bounded() {
        let d1 = reconnect_delay(1);
        let d10 = reconnect_delay(10);
        assert!(d1.as_millis() >= 1000);
        assert!(d1.as_millis() <= 1250);
        assert!(d10.as_millis() >= 30_000);
        assert!(d10.as_millis() <= 30_250);
    }

    #[test]
    fn builds_stream_url_from_host_base() {
        let url = build_ws_stream_url("https://api.relaycast.dev", "tok_1").unwrap();
        assert_eq!(url, "wss://api.relaycast.dev/v1/stream?token=tok_1");
    }

    #[test]
    fn avoids_duplicate_v1_when_base_already_has_v1() {
        let url = build_ws_stream_url("https://api.relaycast.dev/v1", "tok_2").unwrap();
        assert_eq!(url, "wss://api.relaycast.dev/v1/stream?token=tok_2");
    }

    #[test]
    fn preserves_custom_stream_path_and_query() {
        let url =
            build_ws_stream_url("wss://rt.relaycast.dev/stream?client=broker", "tok_3").unwrap();
        assert_eq!(
            url,
            "wss://rt.relaycast.dev/stream/v1/stream?client=broker&token=tok_3"
        );
    }

    #[test]
    fn keeps_existing_stream_endpoint_and_replaces_token() {
        let url = build_ws_stream_url(
            "wss://api.relaycast.dev/v1/stream?token=old&mode=fast",
            "new_tok",
        )
        .unwrap();
        assert_eq!(
            url,
            "wss://api.relaycast.dev/v1/stream?mode=fast&token=new_tok"
        );
    }
}
