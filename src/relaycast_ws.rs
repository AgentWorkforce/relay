use std::{collections::HashSet, sync::Arc, time::Duration};

use anyhow::Result;
use parking_lot::Mutex;
use relaycast::{
    format_registration_error, retry_agent_registration as sdk_retry_agent_registration,
    AgentClient, AgentRegistrationClient, AgentRegistrationError, AgentRegistrationRetryOutcome,
    MessageListQuery, RelayCast, RelayCastOptions, RelayError, ReleaseAgentRequest, WsClient,
    WsClientOptions, WsLifecycleEvent,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::events::EventEmitter;

#[derive(Debug, Clone)]
pub enum WsControl {
    Shutdown,
    Publish(Value),
    /// Re-subscribe to a list of channels (e.g. after creating/joining a new
    /// channel that didn't exist when the WS connection was first established).
    Subscribe(Vec<String>),
}

#[derive(Clone)]
pub struct RelaycastWsClient {
    ws_base_url: String,
    workspace_http: RelaycastHttpClient,
    subscriptions: Arc<Mutex<HashSet<String>>>,
}

impl RelaycastWsClient {
    pub fn new(
        ws_base_url: impl Into<String>,
        workspace_http: RelaycastHttpClient,
        channels: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            ws_base_url: ws_base_url.into(),
            workspace_http,
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
        let mut has_connected = false;

        loop {
            if let Err(error) = self.workspace_http.ensure_workspace_stream_enabled().await {
                tracing::warn!(
                    target = "relay_broker::ws",
                    error = %error,
                    "failed to enable workspace stream before websocket connect"
                );
            }

            let mut ws = WsClient::new(
                WsClientOptions::new(self.workspace_http.api_key.clone())
                    .with_base_url(self.ws_base_url.clone()),
            );

            match ws.connect().await {
                Ok(()) => {
                    let status = if has_connected {
                        "reconnected"
                    } else {
                        "connected"
                    };
                    has_connected = true;
                    tracing::info!(
                        target = "broker::ws",
                        base_url = %self.ws_base_url,
                        status = %status,
                        "WebSocket {status}"
                    );
                    events.emit("connection", json!({"status":status}));
                    let _ = inbound_tx
                        .send(json!({
                            "type":"broker.connection",
                            "payload":{"status":status}
                        }))
                        .await;

                    // The workspace stream delivers DMs automatically, but channel
                    // messages still require explicit WS subscriptions. Keep local
                    // broker channel join events so existing UI/state consumers see
                    // the same join notifications.
                    let active_subscriptions = self.active_subscriptions();
                    if !active_subscriptions.is_empty() {
                        if let Err(error) = ws.subscribe(active_subscriptions.clone()).await {
                            tracing::warn!(
                                target = "relay_broker::ws",
                                channels = ?active_subscriptions,
                                error = %error,
                                "failed to subscribe websocket to broker channels after connect"
                            );
                        } else {
                            tracing::info!(
                                target = "broker::ws",
                                channels = ?active_subscriptions,
                                "subscribed websocket to broker channels after connect"
                            );
                        }

                        for channel in &active_subscriptions {
                            let _ = inbound_tx
                                .send(json!({
                                    "type":"broker.channel_join",
                                    "payload":{"channel":channel}
                                }))
                                .await;
                        }
                    }

                    // Get event and lifecycle receivers
                    let mut event_rx = ws.subscribe_events();
                    let mut lifecycle_rx = ws.subscribe_lifecycle();

                    let mut shutdown = false;
                    while !shutdown {
                        tokio::select! {
                            ctrl = control_rx.recv() => {
                                match ctrl {
                                    Some(WsControl::Shutdown) | None => {
                                        ws.disconnect().await;
                                        shutdown = true;
                                    }
                                    Some(WsControl::Publish(payload)) => {
                                        // SDK doesn't support raw WS publish; loop back locally
                                        let _ = inbound_tx.send(payload).await;
                                    }
                                    Some(WsControl::Subscribe(channels)) => {
                                        let mut joined_now = Vec::new();
                                        {
                                            let mut subs = self.subscriptions.lock();
                                            for ch in &channels {
                                                if subs.insert(ch.clone()) {
                                                    joined_now.push(ch.clone());
                                                }
                                            }
                                        }
                                        if !joined_now.is_empty() {
                                            if let Err(error) = ws.subscribe(joined_now.clone()).await {
                                                tracing::warn!(
                                                    target = "relay_broker::ws",
                                                    channels = ?joined_now,
                                                    error = %error,
                                                    "failed to subscribe websocket to newly joined broker channels"
                                                );
                                            } else {
                                                tracing::info!(
                                                    target = "broker::ws",
                                                    channels = ?joined_now,
                                                    "subscribed websocket to newly joined broker channels"
                                                );
                                            }
                                        }

                                        for channel in &joined_now {
                                            let _ = inbound_tx
                                                .send(json!({
                                                    "type":"broker.channel_join",
                                                    "payload":{"channel":channel}
                                                }))
                                                .await;
                                        }
                                    }
                                }
                            }
                            event = event_rx.recv() => {
                                match event {
                                    Ok(ws_event) => {
                                        // Serialize SDK WsEvent back to JSON Value for the broker
                                        match serde_json::to_value(&ws_event) {
                                            Ok(value) => {
                                                let _ = inbound_tx.send(value).await;
                                            }
                                            Err(error) => {
                                                tracing::debug!(
                                                    target = "relay_broker::ws",
                                                    error = %error,
                                                    "failed to serialize SDK event to JSON"
                                                );
                                            }
                                        }
                                    }
                                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                        tracing::warn!(
                                            target = "relay_broker::ws",
                                            skipped = n,
                                            "event receiver lagged, skipped events"
                                        );
                                    }
                                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                        tracing::info!(target = "broker::ws", "SDK event channel closed");
                                        break;
                                    }
                                }
                            }
                            lifecycle = lifecycle_rx.recv() => {
                                match lifecycle {
                                    Ok(WsLifecycleEvent::Close) => {
                                        tracing::info!(target = "broker::ws", "WebSocket closed by SDK");
                                        break;
                                    }
                                    Ok(WsLifecycleEvent::Error(msg)) => {
                                        tracing::warn!(target = "relay_broker::ws", error = %msg, "SDK lifecycle error");
                                    }
                                    Ok(WsLifecycleEvent::Reconnecting { attempt }) => {
                                        tracing::info!(target = "broker::ws", attempt, "SDK reconnecting");
                                        events.emit("connection", json!({"status":"reconnecting","attempt":attempt}));
                                    }
                                    Ok(WsLifecycleEvent::Open) => {
                                        tracing::info!(target = "broker::ws", "SDK WebSocket re-opened");
                                        events.emit("connection", json!({"status":"reconnected"}));
                                        let _ = inbound_tx
                                            .send(json!({
                                                "type":"broker.connection",
                                                "payload":{"status":"reconnected"}
                                            }))
                                            .await;
                                    }
                                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                        tracing::info!(target = "broker::ws", "SDK lifecycle channel closed");
                                        break;
                                    }
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
                        base_url = %self.ws_base_url,
                        error = %error,
                        "SDK ws connect failed"
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
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }
}

/// HTTP client for publishing messages to the Relaycast REST API.
///
/// Used by the broker to asynchronously forward messages to Relaycast when the
/// target is not a local worker.
#[derive(Clone)]
pub struct RelaycastHttpClient {
    pub base_url: String,
    pub api_key: String,
    relay: Arc<Option<RelayCast>>,
    registration: Arc<Option<AgentRegistrationClient>>,
    pub agent_name: String,
    pub default_cli: String,
}

pub type RelaycastRegistrationError = AgentRegistrationError;
pub type RegRetryOutcome = AgentRegistrationRetryOutcome;
pub use relaycast::{registration_is_retryable, registration_retry_after_secs};

impl RelaycastHttpClient {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        agent_name: impl Into<String>,
        default_cli: impl Into<String>,
    ) -> Self {
        let base_url = base_url.into();
        let api_key = api_key.into();
        let default_cli = default_cli.into();
        let relay = Arc::new(build_relay_client(&api_key, &base_url));
        let registration = Arc::new(
            relay
                .as_ref()
                .as_ref()
                .map(|client| AgentRegistrationClient::new(client.clone(), default_cli.clone())),
        );
        Self {
            base_url,
            api_key,
            relay,
            registration,
            agent_name: agent_name.into(),
            default_cli,
        }
    }

    /// Pre-populate the token cache for an agent so that `ensure_token()` skips
    /// the spawn registration call entirely. Used to seed the broker's own
    /// session token obtained during auth startup.
    pub fn seed_agent_token(&self, agent_name: &str, token: &str) {
        if let Some(registration) = self.registration.as_ref() {
            registration.seed_agent_token(agent_name, token);
        }
    }

    pub fn registration_block_remaining(&self, agent_name: &str) -> Option<Duration> {
        self.registration
            .as_ref()
            .as_ref()
            .and_then(|registration| registration.registration_block_remaining(agent_name))
    }

    fn invalidate_cached_registration(&self, agent_name: &str) {
        if let Some(registration) = self.registration.as_ref() {
            registration.invalidate_cached_registration(agent_name);
        }
    }

    pub fn forget_agent_registration(&self, agent_name: &str) {
        self.invalidate_cached_registration(agent_name);
    }

    /// Register an agent via Relaycast spawn endpoint and cache its token.
    ///
    /// This is used for both broker self-registration and worker pre-registration.
    pub async fn register_agent_token(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
    ) -> std::result::Result<String, RelaycastRegistrationError> {
        let trimmed_name = agent_name.trim();
        let registration = self.registration.as_ref().as_ref().ok_or_else(|| {
            RelaycastRegistrationError::Transport {
                agent_name: trimmed_name.to_string(),
                detail: "SDK relay client not initialized".to_string(),
            }
        })?;
        registration
            .register_agent_token(trimmed_name, cli_hint)
            .await
    }

    /// Register the broker agent via the spawn endpoint (which rotates the token
    /// if the agent already exists, avoiding ghost duplicates).
    async fn ensure_token(&self) -> Result<String> {
        // Check if we already have a cached/pre-seeded token
        if let Some(token) = self
            .registration
            .as_ref()
            .as_ref()
            .and_then(|registration| registration.cached_agent_token(&self.agent_name))
        {
            let prefix = &token[..token.len().min(16)];
            tracing::info!(agent = %self.agent_name, token_prefix = %prefix, "ensure_token: using cached/pre-seeded token (no spawn)");
            return Ok(token);
        }
        tracing::info!(agent = %self.agent_name, "ensure_token: no cached token, will register via spawn");
        self.register_agent_token(&self.agent_name, Some(&self.default_cli))
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    /// Mark a specific agent offline via the release endpoint.
    pub async fn mark_agent_offline(&self, agent_name: &str) -> Result<()> {
        if let Some(relay) = (*self.relay).as_ref() {
            let request = ReleaseAgentRequest {
                name: agent_name.to_string(),
                reason: None,
                delete_agent: None,
            };
            match relay.release_agent(request).await {
                Ok(_) => {
                    tracing::info!(agent = %agent_name, "marked agent offline");
                }
                Err(error) => {
                    tracing::warn!(agent = %agent_name, error = %error, "failed to mark agent offline");
                }
            }
        } else {
            tracing::warn!(agent = %agent_name, "SDK relay client not initialized; cannot mark agent offline");
        }
        // Always invalidate local cache so a future spawn uses a fresh registration.
        self.invalidate_cached_registration(agent_name);
        Ok(())
    }

    /// Mark the broker agent as offline via the release endpoint.
    /// Called during graceful shutdown to prevent ghost agents in the dashboard.
    pub async fn mark_offline(&self) -> Result<()> {
        self.mark_agent_offline(&self.agent_name).await
    }

    /// Send a direct message to a named agent via the Relaycast REST API.
    pub async fn send_dm(&self, to: &str, text: &str) -> Result<()> {
        let token = self.ensure_token().await?;
        let agent_client = AgentClient::new(&token, Some(self.base_url.clone()))
            .map_err(|e| anyhow::anyhow!("failed to create agent client: {e}"))?;
        agent_client
            .dm(to, text, None)
            .await
            .map_err(|e| anyhow::anyhow!("relaycast send_dm failed: {e}"))?;
        Ok(())
    }

    /// Post a message to a channel via the Relaycast REST API.
    pub async fn send_to_channel(&self, channel: &str, text: &str) -> Result<()> {
        let token = self.ensure_token().await?;
        let agent_client = AgentClient::new(&token, Some(self.base_url.clone()))
            .map_err(|e| anyhow::anyhow!("failed to create agent client: {e}"))?;
        agent_client
            .send(channel, text, None, None, None)
            .await
            .map_err(|e| anyhow::anyhow!("relaycast send_to_channel failed: {e}"))?;
        Ok(())
    }

    /// Ensure workspace-wide WebSocket fanout is enabled for this workspace.
    pub async fn ensure_workspace_stream_enabled(&self) -> Result<()> {
        let Some(relay) = (*self.relay).as_ref() else {
            tracing::warn!("SDK relay client not initialized; cannot enable workspace stream");
            return Ok(());
        };

        let config = relay
            .workspace_stream_set(true)
            .await
            .map_err(|error| anyhow::anyhow!("relaycast workspace_stream_set failed: {error}"))?;
        tracing::debug!(
            enabled = config.enabled,
            default_enabled = config.default_enabled,
            override = ?config.override_value,
            "ensured workspace stream enabled"
        );
        Ok(())
    }

    /// Ensure default workspace channels (general, engineering) exist.
    ///
    /// Creates the channels if they don't already exist, ignoring 409 Conflict errors.
    pub async fn ensure_default_channels(&self) -> Result<()> {
        let Some(_relay) = (*self.relay).as_ref() else {
            tracing::warn!("SDK relay client not initialized; cannot ensure default channels");
            return Ok(());
        };
        let defaults = [
            ("general", "General discussion"),
            ("engineering", "Engineering discussion"),
        ];
        for (name, topic) in &defaults {
            let request = relaycast::CreateChannelRequest {
                name: name.to_string(),
                topic: Some(topic.to_string()),
                metadata: None,
            };
            // Use the workspace-level agent client (from relay) to create channels
            // The RelayCast workspace client doesn't have create_channel, so use an agent client
            let token = match self.ensure_token().await {
                Ok(token) => token,
                Err(error) => {
                    tracing::warn!(error = %error, "failed to get agent token for channel creation");
                    return Ok(());
                }
            };
            let agent_client = match AgentClient::new(&token, Some(self.base_url.clone())) {
                Ok(client) => client,
                Err(error) => {
                    tracing::warn!(error = %error, "failed to create agent client for channel creation");
                    return Ok(());
                }
            };
            match agent_client.create_channel(request).await {
                Ok(_) => {
                    tracing::info!(channel = %name, "created default channel");
                }
                Err(RelayError::Api { status: 409, .. }) => {
                    tracing::debug!(channel = %name, "default channel already exists");
                }
                Err(error) => {
                    tracing::warn!(channel = %name, error = %error, "failed to create default channel");
                    continue;
                }
            }
            // Join so the broker receives message.created WS events for this channel.
            match agent_client.join_channel(name).await {
                Ok(_) => {
                    tracing::info!(channel = %name, "broker joined default channel");
                }
                Err(RelayError::Api { status: 409, .. }) => {
                    tracing::debug!(channel = %name, "broker already joined default channel");
                }
                Err(error) => {
                    tracing::warn!(channel = %name, error = %error, "failed to join default channel");
                }
            }
        }
        Ok(())
    }

    /// Ensure a list of additional channels exist and that the broker is a
    /// member of each (e.g. user-specified broker channels that aren't in the
    /// hardcoded defaults).  Channels that already exist are silently skipped
    /// (409 → no-op).  The broker must be a channel member to receive
    /// `message.created` WebSocket events for that channel.
    pub async fn ensure_extra_channels(&self, channels: &[String]) -> Result<()> {
        let defaults = ["general", "engineering"];
        let extras: Vec<&String> = channels
            .iter()
            .filter(|c| !defaults.contains(&c.as_str()))
            .collect();
        if extras.is_empty() {
            return Ok(());
        }
        let token = match self.ensure_token().await {
            Ok(token) => token,
            Err(error) => {
                tracing::warn!(error = %error, "failed to get agent token for extra channel creation");
                return Ok(());
            }
        };
        let agent_client = match AgentClient::new(&token, Some(self.base_url.clone())) {
            Ok(client) => client,
            Err(error) => {
                tracing::warn!(error = %error, "failed to create agent client for extra channel creation");
                return Ok(());
            }
        };
        for name in extras {
            // Create the channel (idempotent — 409 means already exists).
            let request = relaycast::CreateChannelRequest {
                name: name.clone(),
                topic: None,
                metadata: None,
            };
            match agent_client.create_channel(request).await {
                Ok(_) => tracing::info!(channel = %name, "created extra channel"),
                Err(RelayError::Api { status: 409, .. }) => {
                    tracing::debug!(channel = %name, "extra channel already exists");
                }
                Err(error) => {
                    tracing::warn!(channel = %name, error = %error, "failed to create extra channel");
                    continue;
                }
            }
            // Join the channel so the broker receives message.created WS events.
            match agent_client.join_channel(name).await {
                Ok(_) => tracing::info!(channel = %name, "broker joined extra channel"),
                Err(RelayError::Api { status: 409, .. }) => {
                    tracing::debug!(channel = %name, "broker already joined extra channel");
                }
                Err(error) => {
                    tracing::warn!(channel = %name, error = %error, "failed to join extra channel");
                }
            }
        }
        Ok(())
    }

    /// Fetch recent DM history for an agent via the Relaycast REST API.
    pub async fn get_dms(&self, agent: &str, limit: usize) -> Result<Vec<Value>> {
        let token = self.ensure_token().await?;
        let agent_client = AgentClient::new(&token, Some(self.base_url.clone()))
            .map_err(|e| anyhow::anyhow!("failed to create agent client: {e}"))?;
        let opts = MessageListQuery {
            limit: Some(limit as i32),
            ..Default::default()
        };
        match agent_client.dm_messages_with_agent(agent, Some(opts)).await {
            Ok(messages) => Ok(messages
                .into_iter()
                .filter_map(|msg| serde_json::to_value(msg).ok())
                .collect()),
            Err(error) => {
                tracing::warn!(error = %error, "relaycast get_dms failed");
                Ok(vec![])
            }
        }
    }

    /// Fetch ALL DM messages across all conversations in the workspace.
    /// Uses the workspace-level relay client to see all DM conversations,
    /// not just those involving the broker agent.
    pub async fn get_all_dms(&self, limit_per_conversation: usize) -> Result<Vec<Value>> {
        let relay = match (*self.relay).as_ref() {
            Some(relay) => relay,
            None => {
                tracing::debug!("no relay client available, falling back to agent-level get_dms");
                return self.get_dms(&self.agent_name, limit_per_conversation).await;
            }
        };

        let conversations = match relay.all_dm_conversations().await {
            Ok(convos) => convos,
            Err(error) => {
                tracing::warn!(error = %error, "failed to fetch all DM conversations");
                return Ok(vec![]);
            }
        };

        let mut all_messages = Vec::new();
        let opts = MessageListQuery {
            limit: Some(limit_per_conversation as i32),
            ..Default::default()
        };

        for convo in conversations {
            match relay.dm_messages(&convo.id, Some(opts.clone())).await {
                Ok(messages) => {
                    for msg in messages {
                        // Add conversation_id so build_thread_infos can group them
                        let mut val = match serde_json::to_value(&msg) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if let Some(obj) = val.as_object_mut() {
                            obj.insert(
                                "conversation_id".to_string(),
                                serde_json::Value::String(convo.id.clone()),
                            );
                            // Include participants so thread names can be derived
                            obj.insert(
                                "participants".to_string(),
                                serde_json::to_value(&convo.participants).unwrap_or_default(),
                            );
                        }
                        all_messages.push(val);
                    }
                }
                Err(error) => {
                    tracing::debug!(
                        conversation_id = %convo.id,
                        error = %error,
                        "failed to fetch DM messages for conversation"
                    );
                }
            }
        }

        Ok(all_messages)
    }

    /// Resolve participant names for a DM conversation ID.
    pub async fn get_dm_participants(&self, conversation_id: &str) -> Result<Vec<String>> {
        let participants = if let Some(relay) = (*self.relay).as_ref() {
            match relay.dm_conversation_participants(conversation_id).await {
                Ok(participants) => participants,
                Err(error) => {
                    tracing::warn!(
                        conversation_id = %conversation_id,
                        error = %error,
                        "relaycast get_dm_participants failed"
                    );
                    vec![]
                }
            }
        } else {
            tracing::warn!(
                conversation_id = %conversation_id,
                "SDK relay client not initialized; cannot resolve dm participants"
            );
            vec![]
        };
        if participants.is_empty() {
            tracing::warn!(
                conversation_id = %conversation_id,
                "no participants found for DM conversation — message delivery will fail"
            );
        }
        Ok(participants)
    }

    /// Fetch recent message history from a channel via the Relaycast REST API.
    pub async fn get_channel_messages(&self, channel: &str, limit: usize) -> Result<Vec<Value>> {
        let token = self.ensure_token().await?;
        let agent_client = AgentClient::new(&token, Some(self.base_url.clone()))
            .map_err(|e| anyhow::anyhow!("failed to create agent client: {e}"))?;
        let opts = MessageListQuery {
            limit: Some(limit as i32),
            ..Default::default()
        };
        match agent_client.messages(channel, Some(opts)).await {
            Ok(messages) => {
                // Convert SDK typed messages to serde_json::Value for compatibility
                let values: Vec<Value> = messages
                    .into_iter()
                    .filter_map(|msg| serde_json::to_value(msg).ok())
                    .collect();
                Ok(values)
            }
            Err(error) => {
                tracing::warn!(error = %error, "relaycast get_channel_messages failed");
                Ok(vec![])
            }
        }
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

/// Build a `RelayCast` workspace client from an API key and base URL.
fn build_relay_client(api_key: &str, base_url: &str) -> Option<RelayCast> {
    let opts = RelayCastOptions::new(api_key).with_base_url(base_url);
    RelayCast::new(opts).ok()
}

pub fn format_worker_preregistration_error(
    name: &str,
    error: &RelaycastRegistrationError,
) -> String {
    format_registration_error(name, error).replace("register agent", "pre-register worker")
}

/// Attempt to register an agent token with up to 3 retries for transient errors.
pub async fn retry_agent_registration(
    http: &RelaycastHttpClient,
    name: &str,
    cli: Option<&str>,
) -> Result<String, RegRetryOutcome> {
    let registration = http.registration.as_ref().as_ref().ok_or_else(|| {
        RegRetryOutcome::Fatal(RelaycastRegistrationError::Transport {
            agent_name: name.to_string(),
            detail: "SDK relay client not initialized".to_string(),
        })
    })?;
    sdk_retry_agent_registration(registration, name, cli).await
}

#[cfg(test)]
mod tests {
    use relaycast::AgentRegistrationError;

    use super::{
        format_worker_preregistration_error, registration_is_retryable,
        registration_retry_after_secs,
    };

    #[test]
    fn registration_retryable_for_rate_limited() {
        let error = AgentRegistrationError::RateLimited {
            agent_name: "worker-a".to_string(),
            retry_after_secs: 60,
            detail: "rate limited".to_string(),
        };
        assert!(registration_is_retryable(&error));
        assert_eq!(registration_retry_after_secs(&error), Some(60));
    }

    #[test]
    fn format_registration_error_includes_worker_name() {
        let error = AgentRegistrationError::Transport {
            agent_name: "worker-a".to_string(),
            detail: "network failure".to_string(),
        };
        let message = format_worker_preregistration_error("worker-a", &error);
        assert!(message.contains("worker-a"));
        assert!(message.contains("pre-register"));
    }
}
