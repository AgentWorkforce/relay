use std::{collections::HashSet, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rand::Rng;
use relaycast::{
    AgentClient, MessageListQuery, RelayCast, RelayCastOptions, ReleaseAgentRequest,
    SpawnAgentRequest,
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast::error::RecvError, mpsc};

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
            let mut agent = match AgentClient::new(token, Some(self.base_url.clone())) {
                Ok(agent) => agent,
                Err(error) => {
                    tracing::warn!(
                        target = "relay_broker::ws",
                        base_url = %self.base_url,
                        error = %error,
                        "failed to construct relaycast ws client"
                    );
                    attempt += 1;
                    tokio::time::sleep(reconnect_delay(attempt)).await;
                    continue;
                }
            };

            match agent.connect().await {
                Ok(()) => {
                    let status = if has_connected {
                        "reconnected"
                    } else {
                        "connected"
                    };
                    has_connected = true;
                    events.emit("connection", json!({"status": status}));
                    let _ = inbound_tx
                        .send(json!({
                            "type":"broker.connection",
                            "payload":{"status": status}
                        }))
                        .await;
                    attempt = 0;

                    let channels = self.active_subscriptions();
                    if !channels.is_empty() {
                        match agent.subscribe_channels(channels.clone()).await {
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
                                    match agent.subscribe_channels(vec![channel.clone()]).await {
                                        Ok(()) => {
                                            let _ = inbound_tx
                                                .send(json!({
                                                    "type":"broker.channel_join",
                                                    "payload":{"channel":channel}
                                                }))
                                                .await;
                                        }
                                        Err(error) => {
                                            tracing::warn!(
                                                target = "relay_broker::ws",
                                                channel = %channel,
                                                error = %error,
                                                "failed to subscribe channel"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let mut event_rx = match agent.subscribe_events() {
                        Ok(rx) => rx,
                        Err(error) => {
                            tracing::warn!(
                                target = "relay_broker::ws",
                                error = %error,
                                "failed to subscribe to relaycast events"
                            );
                            agent.disconnect().await;
                            attempt += 1;
                            if let Err(error) = self.refresh_token().await {
                                tracing::warn!(
                                    target = "relay_broker::ws",
                                    error = %error,
                                    "token refresh failed"
                                );
                            }
                            tokio::time::sleep(reconnect_delay(attempt)).await;
                            continue;
                        }
                    };

                    let mut shutdown = false;
                    while !shutdown {
                        tokio::select! {
                            ctrl = control_rx.recv() => {
                                match ctrl {
                                    Some(WsControl::Shutdown) | None => {
                                        agent.disconnect().await;
                                        shutdown = true;
                                    }
                                }
                            }
                            ws_event = event_rx.recv() => {
                                match ws_event {
                                    Ok(event) => {
                                        match serde_json::to_value(event) {
                                            Ok(value) => {
                                                let _ = inbound_tx.send(value).await;
                                            }
                                            Err(error) => {
                                                tracing::warn!(
                                                    target = "relay_broker::ws",
                                                    error = %error,
                                                    "failed to serialize relaycast ws event"
                                                );
                                            }
                                        }
                                    }
                                    Err(RecvError::Lagged(skipped)) => {
                                        tracing::warn!(
                                            target = "relay_broker::ws",
                                            skipped,
                                            "dropped lagged ws events"
                                        );
                                    }
                                    Err(RecvError::Closed) => {
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    if shutdown {
                        break;
                    }

                    agent.disconnect().await;
                }
                Err(error) => {
                    tracing::warn!(
                        target = "relay_broker::ws",
                        base_url = %self.base_url,
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
        let refreshed = self.auth.rotate_token(&creds).await?;
        *self.token.lock() = refreshed.token;
        *self.creds.lock() = refreshed.credentials;
        Ok(())
    }
}

/// HTTP client for publishing messages to the Relaycast REST API.
///
/// Used by the broker to asynchronously forward messages to Relaycast when the
/// target is not a local worker.
#[derive(Clone)]
pub struct RelaycastHttpClient {
    base_url: String,
    api_key: String,
    agent_token: Arc<Mutex<Option<String>>>,
    agent_name: String,
}

impl RelaycastHttpClient {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        agent_name: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            agent_token: Arc::new(Mutex::new(None)),
            agent_name: agent_name.into(),
        }
    }

    fn relay_client(&self) -> Result<RelayCast> {
        RelayCast::new(
            RelayCastOptions::new(self.api_key.clone()).with_base_url(self.base_url.clone()),
        )
        .context("failed to initialize relaycast workspace client")
    }

    /// Register the broker agent via the spawn endpoint (which rotates the token
    /// if the agent already exists, avoiding ghost duplicates).
    async fn ensure_token(&self) -> Result<String> {
        {
            let guard = self.agent_token.lock();
            if let Some(ref tok) = *guard {
                return Ok(tok.clone());
            }
        }

        let relay = self.relay_client()?;
        let response = relay
            .spawn_agent(SpawnAgentRequest {
                name: self.agent_name.clone(),
                cli: "broker".to_string(),
                task: "relay broker engine".to_string(),
                channel: None,
                persona: None,
                metadata: None,
            })
            .await
            .context("relaycast spawn/register failed")?;

        let token = response.token;
        *self.agent_token.lock() = Some(token.clone());
        Ok(token)
    }

    fn build_agent_client(&self, token: String) -> Result<AgentClient> {
        AgentClient::new(token, Some(self.base_url.clone()))
            .context("failed to initialize relaycast agent client")
    }

    async fn with_agent_client(&self) -> Result<AgentClient> {
        let token = self.ensure_token().await?;
        self.build_agent_client(token)
    }

    /// Mark the broker agent as offline via the release endpoint.
    /// Called during graceful shutdown to prevent ghost agents in the dashboard.
    pub async fn mark_offline(&self) -> Result<()> {
        let relay = self.relay_client()?;
        let result = relay
            .release_agent(ReleaseAgentRequest {
                name: self.agent_name.clone(),
                reason: Some("broker_shutdown".to_string()),
                delete_agent: Some(false),
            })
            .await;

        match result {
            Ok(_) => {
                tracing::info!(agent = %self.agent_name, "marked broker agent offline");
            }
            Err(error) => {
                tracing::warn!(error = %error, "failed to mark broker offline");
            }
        }

        *self.agent_token.lock() = None;
        Ok(())
    }

    /// Send a direct message to a named agent via the Relaycast REST API.
    pub async fn send_dm(&self, to: &str, text: &str) -> Result<()> {
        let agent = self.with_agent_client().await?;
        agent
            .dm(to, text, None)
            .await
            .context("relaycast send_dm failed")?;
        Ok(())
    }

    /// Post a message to a channel via the Relaycast REST API.
    pub async fn send_to_channel(&self, channel: &str, text: &str) -> Result<()> {
        let agent = self.with_agent_client().await?;
        let ch = channel.strip_prefix('#').unwrap_or(channel);
        agent
            .send(ch, text, None, None, None)
            .await
            .context("relaycast send_to_channel failed")?;
        Ok(())
    }

    /// Fetch recent DM history for an agent via the Relaycast REST API.
    pub async fn get_dms(&self, agent: &str, limit: usize) -> Result<Vec<Value>> {
        let agent_client = self.with_agent_client().await?;
        let conversations = match agent_client.dm_conversations().await {
            Ok(conversations) => conversations,
            Err(error) => {
                tracing::warn!(error = %error, "relaycast get_dms failed to list conversations");
                return Ok(vec![]);
            }
        };

        let Some(conversation) = conversations.into_iter().find(|conv| {
            conv.participants
                .iter()
                .any(|participant| participant == agent)
        }) else {
            return Ok(vec![]);
        };

        let messages = match agent_client
            .dm_messages(
                &conversation.id,
                Some(MessageListQuery {
                    limit: Some(clamp_limit(limit)),
                    ..Default::default()
                }),
            )
            .await
        {
            Ok(messages) => messages,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    conversation_id = %conversation.id,
                    "relaycast get_dms failed to fetch messages"
                );
                return Ok(vec![]);
            }
        };

        to_json_values(messages)
    }

    /// Fetch recent message history from a channel via the Relaycast REST API.
    pub async fn get_channel_messages(&self, channel: &str, limit: usize) -> Result<Vec<Value>> {
        let agent = self.with_agent_client().await?;
        let ch = channel.strip_prefix('#').unwrap_or(channel);
        let messages = match agent
            .messages(
                ch,
                Some(MessageListQuery {
                    limit: Some(clamp_limit(limit)),
                    ..Default::default()
                }),
            )
            .await
        {
            Ok(messages) => messages,
            Err(error) => {
                tracing::warn!(error = %error, channel = %ch, "relaycast get_channel_messages failed");
                return Ok(vec![]);
            }
        };

        to_json_values(messages)
    }

    /// Smart send: routes to channel or DM based on `#` prefix.
    pub async fn send(&self, to: &str, text: &str) -> Result<()> {
        if to.starts_with('#') {
            self.send_to_channel(to, text).await
        } else {
            self.send_dm(to, text).await
        }
    }
}

fn clamp_limit(limit: usize) -> i32 {
    std::cmp::min(limit, i32::MAX as usize) as i32
}

fn to_json_values<T>(items: Vec<T>) -> Result<Vec<Value>>
where
    T: Serialize,
{
    items
        .into_iter()
        .map(|item| serde_json::to_value(item).context("failed to serialize relaycast response"))
        .collect()
}

pub fn reconnect_delay(attempt: u32) -> Duration {
    let base_ms = (1_000u64).saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)));
    let bounded = base_ms.min(30_000);
    let jitter = rand::thread_rng().gen_range(0..=250);
    Duration::from_millis(bounded + jitter)
}

#[cfg(test)]
mod tests {
    use super::{reconnect_delay, RelaycastHttpClient};

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
    fn http_client_constructs_with_correct_fields() {
        let client =
            RelaycastHttpClient::new("https://api.relaycast.dev", "rk_live_test", "my-broker");
        assert_eq!(client.base_url, "https://api.relaycast.dev");
        assert_eq!(client.api_key, "rk_live_test");
        assert_eq!(client.agent_name, "my-broker");
        assert!(client.agent_token.lock().is_none());
    }

    #[test]
    fn http_client_clone_shares_token() {
        let client = RelaycastHttpClient::new("https://api.relaycast.dev", "key", "agent");
        let clone = client.clone();
        *client.agent_token.lock() = Some("tok_123".to_string());
        assert_eq!(clone.agent_token.lock().as_deref(), Some("tok_123"));
    }
}
