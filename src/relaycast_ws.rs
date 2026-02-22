use std::{collections::HashSet, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use relaycast::{
    AgentClient, MessageListQuery, RelayCast, RelayCastOptions, ReleaseAgentRequest,
    SpawnAgentRequest, WsLifecycleEvent,
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
        const INITIAL_RETRY_DELAY: Duration = Duration::from_secs(2);
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
                    tokio::select! {
                        _ = tokio::time::sleep(INITIAL_RETRY_DELAY) => {}
                        ctrl = control_rx.recv() => {
                            if matches!(ctrl, Some(WsControl::Shutdown) | None) {
                                return;
                            }
                        }
                    }
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
                    emit_connection_status(&events, &inbound_tx, status).await;

                    let mut connected = true;
                    let channels = self.active_subscriptions();
                    if !channels.is_empty() {
                        if let Err(error) = agent.subscribe_channels(channels.clone()).await {
                            tracing::warn!(
                                target = "relay_broker::ws",
                                error = %error,
                                "failed to subscribe channels"
                            );
                        } else {
                            for channel in &channels {
                                let _ = inbound_tx
                                    .send(json!({
                                        "type":"broker.channel_join",
                                        "payload":{"channel":channel}
                                    }))
                                    .await;
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
                            if let Err(error) = self.refresh_token().await {
                                tracing::warn!(
                                    target = "relay_broker::ws",
                                    error = %error,
                                    "token refresh failed"
                                );
                            }
                            tokio::select! {
                                _ = tokio::time::sleep(INITIAL_RETRY_DELAY) => {}
                                ctrl = control_rx.recv() => {
                                    if matches!(ctrl, Some(WsControl::Shutdown) | None) {
                                        return;
                                    }
                                }
                            }
                            continue;
                        }
                    };
                    let mut lifecycle_rx = match agent.subscribe_lifecycle() {
                        Ok(rx) => rx,
                        Err(error) => {
                            tracing::warn!(
                                target = "relay_broker::ws",
                                error = %error,
                                "failed to subscribe to relaycast lifecycle events"
                            );
                            agent.disconnect().await;
                            tokio::select! {
                                _ = tokio::time::sleep(INITIAL_RETRY_DELAY) => {}
                                ctrl = control_rx.recv() => {
                                    if matches!(ctrl, Some(WsControl::Shutdown) | None) {
                                        return;
                                    }
                                }
                            }
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
                            lifecycle_event = lifecycle_rx.recv() => {
                                match lifecycle_event {
                                    Ok(WsLifecycleEvent::Open) => {
                                        if !connected {
                                            connected = true;
                                            has_connected = true;
                                            emit_connection_status(&events, &inbound_tx, "reconnected").await;
                                        }
                                    }
                                    Ok(WsLifecycleEvent::Close) => {
                                        if connected {
                                            connected = false;
                                            emit_connection_status(&events, &inbound_tx, "disconnected").await;
                                        }
                                    }
                                    Ok(WsLifecycleEvent::Reconnecting { attempt }) => {
                                        tracing::debug!(
                                            target = "relay_broker::ws",
                                            attempt,
                                            "relaycast websocket reconnecting"
                                        );
                                    }
                                    Ok(WsLifecycleEvent::Error(error)) => {
                                        tracing::warn!(
                                            target = "relay_broker::ws",
                                            error = %error,
                                            "relaycast websocket lifecycle error"
                                        );
                                        match self.refresh_token().await {
                                            Ok(()) => {
                                                let token = self.token.lock().clone();
                                                if let Err(error) = agent.set_token(token).await {
                                                    tracing::warn!(
                                                        target = "relay_broker::ws",
                                                        error = %error,
                                                        "failed to update websocket token after refresh"
                                                    );
                                                }
                                            }
                                            Err(error) => {
                                                tracing::warn!(
                                                    target = "relay_broker::ws",
                                                    error = %error,
                                                    "token refresh failed"
                                                );
                                            }
                                        }
                                    }
                                    Err(RecvError::Lagged(skipped)) => {
                                        tracing::warn!(
                                            target = "relay_broker::ws",
                                            skipped,
                                            "dropped lagged lifecycle events"
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

            if let Err(error) = self.refresh_token().await {
                tracing::warn!(target = "relay_broker::ws", error = %error, "token refresh failed");
            }
            emit_connection_status(&events, &inbound_tx, "disconnected").await;
            tokio::select! {
                _ = tokio::time::sleep(INITIAL_RETRY_DELAY) => {}
                ctrl = control_rx.recv() => {
                    if matches!(ctrl, Some(WsControl::Shutdown) | None) {
                        return;
                    }
                }
            }
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

async fn emit_connection_status(
    events: &EventEmitter,
    inbound_tx: &mpsc::Sender<Value>,
    status: &str,
) {
    events.emit("connection", json!({ "status": status }));
    let _ = inbound_tx
        .send(json!({
            "type":"broker.connection",
            "payload":{"status": status}
        }))
        .await;
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

#[cfg(test)]
mod tests {
    use super::RelaycastHttpClient;

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
