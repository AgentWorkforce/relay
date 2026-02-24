use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Result;
use parking_lot::Mutex;
use relaycast::{
    AgentClient, RelayCast, RelayCastOptions, RelayError, ReleaseAgentRequest, SpawnAgentRequest,
    WsLifecycleEvent,
};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::mpsc;

use crate::{
    auth::{AuthClient, CredentialCache},
    events::EventEmitter,
};

#[derive(Debug, Clone)]
pub enum WsControl {
    Shutdown,
    Publish(Value),
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
        let mut has_connected = false;

        loop {
            let token = self.token.lock().clone();
            let base_url = Some(self.base_url.clone());

            let mut agent = match AgentClient::new(&token, base_url) {
                Ok(agent) => agent,
                Err(error) => {
                    tracing::warn!(
                        target = "relay_broker::ws",
                        error = %error,
                        "failed to create SDK agent client"
                    );
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    if let Err(error) = self.refresh_token().await {
                        tracing::warn!(target = "relay_broker::ws", error = %error, "token refresh failed");
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
                    tracing::info!(
                        target = "broker::ws",
                        base_url = %self.base_url,
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

                    // Subscribe to channels
                    let channels = self.active_subscriptions();
                    if !channels.is_empty() {
                        tracing::debug!(
                            target = "broker::ws",
                            channels = ?channels,
                            "subscribing to channels"
                        );
                        match agent.subscribe_channels(channels.clone()).await {
                            Ok(()) => {
                                tracing::info!(
                                    target = "broker::ws",
                                    count = channels.len(),
                                    channels = ?channels,
                                    "subscribed to channels"
                                );
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
                                    "channel subscribe failed"
                                );
                            }
                        }
                    }

                    // Get event and lifecycle receivers
                    let mut event_rx = match agent.subscribe_events() {
                        Ok(rx) => rx,
                        Err(error) => {
                            tracing::warn!(
                                target = "relay_broker::ws",
                                error = %error,
                                "failed to subscribe to SDK events"
                            );
                            continue;
                        }
                    };
                    let mut lifecycle_rx = match agent.subscribe_lifecycle() {
                        Ok(rx) => rx,
                        Err(error) => {
                            tracing::warn!(
                                target = "relay_broker::ws",
                                error = %error,
                                "failed to subscribe to SDK lifecycle events"
                            );
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
                                    Some(WsControl::Publish(payload)) => {
                                        // SDK doesn't support raw WS publish; loop back locally
                                        let _ = inbound_tx.send(payload).await;
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
                        base_url = %self.base_url,
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
            if let Err(error) = self.refresh_token().await {
                tracing::warn!(target = "relay_broker::ws", error = %error, "token refresh failed");
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
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
    http: reqwest::Client,
    pub base_url: String,
    pub api_key: String,
    relay: Arc<Option<RelayCast>>,
    agent_tokens: Arc<Mutex<HashMap<String, String>>>,
    registration_cooldowns: Arc<Mutex<HashMap<String, Instant>>>,
    pub agent_name: String,
    pub default_cli: String,
}

#[derive(Debug, Clone, Error)]
pub enum RelaycastRegistrationError {
    #[error("invalid agent name for relaycast registration")]
    InvalidAgentName,
    #[error(
        "relaycast registration for '{agent_name}' is blocked for {retry_after_secs}s due to previous rate limiting"
    )]
    Blocked {
        agent_name: String,
        retry_after_secs: u64,
    },
    #[error(
        "relaycast registration for '{agent_name}' was rate-limited; retry after {retry_after_secs}s: {detail}"
    )]
    RateLimited {
        agent_name: String,
        retry_after_secs: u64,
        detail: String,
    },
    #[error("relaycast registration failed for '{agent_name}' ({status}): {detail}")]
    Api {
        agent_name: String,
        status: u16,
        detail: String,
    },
    #[error("relaycast registration transport error for '{agent_name}': {detail}")]
    Transport { agent_name: String, detail: String },
    #[error("relaycast registration response missing token for '{agent_name}'")]
    MissingToken { agent_name: String },
}

impl RelaycastHttpClient {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        agent_name: impl Into<String>,
        default_cli: impl Into<String>,
    ) -> Self {
        let base_url = base_url.into();
        let api_key = api_key.into();
        let relay = Arc::new(build_relay_client(&api_key, &base_url));
        Self {
            http: reqwest::Client::new(),
            base_url,
            api_key,
            relay,
            agent_tokens: Arc::new(Mutex::new(HashMap::new())),
            registration_cooldowns: Arc::new(Mutex::new(HashMap::new())),
            agent_name: agent_name.into(),
            default_cli: default_cli.into(),
        }
    }

    /// Pre-populate the token cache for an agent so that `ensure_token()` skips
    /// the spawn registration call entirely. Used to seed the broker's own
    /// session token obtained during auth startup.
    pub fn seed_agent_token(&self, agent_name: &str, token: &str) {
        self.agent_tokens
            .lock()
            .insert(agent_name.to_string(), token.to_string());
    }

    pub fn registration_block_remaining(&self, agent_name: &str) -> Option<Duration> {
        let trimmed = agent_name.trim();
        if trimmed.is_empty() {
            return None;
        }

        let mut guard = self.registration_cooldowns.lock();
        let blocked_until = guard.get(trimmed).copied()?;
        let now = Instant::now();
        if blocked_until <= now {
            guard.remove(trimmed);
            return None;
        }
        Some(blocked_until - now)
    }

    fn invalidate_cached_registration(&self, agent_name: &str) {
        let trimmed = agent_name.trim();
        if trimmed.is_empty() {
            return;
        }
        self.agent_tokens.lock().remove(trimmed);
        self.registration_cooldowns.lock().remove(trimmed);
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
        if trimmed_name.is_empty() {
            return Err(RelaycastRegistrationError::InvalidAgentName);
        }

        if let Some(token) = self.agent_tokens.lock().get(trimmed_name).cloned() {
            return Ok(token);
        }

        if let Some(remaining) = self.registration_block_remaining(trimmed_name) {
            return Err(RelaycastRegistrationError::Blocked {
                agent_name: trimmed_name.to_string(),
                retry_after_secs: remaining.as_secs().max(1),
            });
        }

        let relay =
            (*self.relay)
                .as_ref()
                .ok_or_else(|| RelaycastRegistrationError::Transport {
                    agent_name: trimmed_name.to_string(),
                    detail: "SDK relay client not initialized".to_string(),
                })?;

        let registration_cli = registration_cli_from_hint(cli_hint, &self.default_cli);
        let request = SpawnAgentRequest {
            name: trimmed_name.to_string(),
            cli: registration_cli,
            task: format!("relay worker session for {}", trimmed_name),
            channel: None,
            persona: None,
            metadata: None,
        };

        match relay.spawn_agent(request).await {
            Ok(result) => {
                self.agent_tokens
                    .lock()
                    .insert(trimmed_name.to_string(), result.token.clone());
                self.registration_cooldowns.lock().remove(trimmed_name);
                Ok(result.token)
            }
            Err(RelayError::Api {
                status: 429,
                message,
                code,
            }) => {
                let retry_after_secs = 60u64; // default
                let blocked_until = Instant::now() + Duration::from_secs(retry_after_secs);
                self.registration_cooldowns
                    .lock()
                    .insert(trimmed_name.to_string(), blocked_until);
                Err(RelaycastRegistrationError::RateLimited {
                    agent_name: trimmed_name.to_string(),
                    retry_after_secs,
                    detail: format!("{message} (code: {code})"),
                })
            }
            Err(RelayError::Api {
                status,
                message,
                code,
            }) => Err(RelaycastRegistrationError::Api {
                agent_name: trimmed_name.to_string(),
                status,
                detail: format!("{message} (code: {code})"),
            }),
            Err(error) => Err(RelaycastRegistrationError::Transport {
                agent_name: trimmed_name.to_string(),
                detail: error.to_string(),
            }),
        }
    }

    /// Register the broker agent via the spawn endpoint (which rotates the token
    /// if the agent already exists, avoiding ghost duplicates).
    async fn ensure_token(&self) -> Result<String> {
        // Check if we already have a cached/pre-seeded token
        if let Some(token) = self.agent_tokens.lock().get(&self.agent_name).cloned() {
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
                }
            }
        }
        Ok(())
    }

    /// Fetch recent DM history for an agent via the Relaycast REST API.
    pub async fn get_dms(&self, agent: &str, limit: usize) -> Result<Vec<Value>> {
        let token = self.ensure_token().await?;
        let url = format!("{}/v1/dm/{}?limit={}", self.base_url, agent, limit);
        let res = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            tracing::warn!(status = %status, "relaycast get_dms failed: {}", body);
            return Ok(vec![]);
        }
        let body: Value = res.json().await?;
        // Try common response shapes: { data: { messages: [...] } } or { messages: [...] } or [...]
        let messages = body
            .pointer("/data/messages")
            .or_else(|| body.get("messages"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                if body.is_array() {
                    body.as_array().cloned().unwrap_or_default()
                } else {
                    vec![]
                }
            });
        Ok(messages)
    }

    /// Resolve participant names for a DM conversation ID.
    pub async fn get_dm_participants(&self, conversation_id: &str) -> Result<Vec<String>> {
        let url = format!("{}/v1/dm/conversations/all", self.base_url);
        let res = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            tracing::warn!(
                status = %status,
                conversation_id = %conversation_id,
                "relaycast get_dm_participants failed: {}",
                body
            );
            return Ok(vec![]);
        }
        let body: Value = res.json().await?;
        Ok(parse_dm_participants_from_conversations(
            &body,
            conversation_id,
        ))
    }

    /// Fetch recent message history from a channel via the Relaycast REST API.
    pub async fn get_channel_messages(&self, channel: &str, limit: usize) -> Result<Vec<Value>> {
        let token = self.ensure_token().await?;
        let agent_client = AgentClient::new(&token, Some(self.base_url.clone()))
            .map_err(|e| anyhow::anyhow!("failed to create agent client: {e}"))?;
        let opts = relaycast::MessageListQuery {
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

fn parse_dm_participants_from_conversations(body: &Value, conversation_id: &str) -> Vec<String> {
    let conversations = body
        .pointer("/data/conversations")
        .or_else(|| body.get("conversations"))
        .and_then(Value::as_array)
        .or_else(|| body.get("data").and_then(Value::as_array))
        .or_else(|| body.as_array());

    let Some(conversations) = conversations else {
        return vec![];
    };

    let Some(conversation) = conversations.iter().find(|entry| {
        entry
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id == conversation_id)
    }) else {
        return vec![];
    };

    conversation
        .get("participants")
        .and_then(Value::as_array)
        .map(|participants| {
            participants
                .iter()
                .filter_map(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[allow(dead_code)]
pub fn build_ws_stream_url(base_url: &str, token: &str) -> Result<String> {
    use reqwest::Url;
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
        "/v1/ws".to_string()
    } else if path.ends_with("/v1/ws") || path.ends_with("/ws") {
        path
    } else if path.ends_with("/v1/stream") {
        path.trim_end_matches("/stream").to_string() + "/ws"
    } else if path.ends_with("/stream") {
        format!("{}/ws", path.trim_end_matches("/stream"))
    } else if path.ends_with("/v1") {
        format!("{path}/ws")
    } else {
        format!("{path}/v1/ws")
    };
    url.set_path(&final_path);

    let mut preserved: Vec<(String, String)> = Vec::new();
    for (k, v) in url.query_pairs() {
        if k != "token" {
            preserved.push((k.to_string(), v.to_string()));
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

fn normalize_relaycast_cli(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = shlex::split(trimmed)
        .and_then(|parts| parts.into_iter().next())
        .unwrap_or_else(|| trimmed.to_string());

    let executable = Path::new(&candidate)
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or(candidate.as_str());

    let cli = executable
        .split(':')
        .next()
        .unwrap_or(executable)
        .trim()
        .to_ascii_lowercase();

    let normalized = match cli.as_str() {
        "claude" | "claudecode" | "claude-code" | "claude_code" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        "aider" => "aider",
        "goose" => "goose",
        _ => return None,
    };

    Some(normalized.to_string())
}

fn registration_cli_from_hint(cli_hint: Option<&str>, default_cli: &str) -> String {
    cli_hint
        .and_then(normalize_relaycast_cli)
        .or_else(|| normalize_relaycast_cli(default_cli))
        .unwrap_or_else(|| "claude".to_string())
}

#[allow(dead_code)]
pub fn reconnect_delay(attempt: u32) -> Duration {
    use rand::Rng;
    let base_ms = (1_000u64).saturating_mul(2u64.saturating_pow(attempt.saturating_sub(1)));
    let bounded = base_ms.min(30_000);
    let jitter = rand::thread_rng().gen_range(0..=250);
    Duration::from_millis(bounded + jitter)
}

#[allow(dead_code)]
pub(crate) fn parse_retry_after_seconds(
    headers: Option<&HashMap<String, String>>,
    body: Option<&Value>,
) -> u64 {
    let from_header = headers
        .and_then(|map| map.get("retry-after"))
        .and_then(|value| value.trim().parse::<u64>().ok());

    let from_body = body.and_then(|payload| {
        payload
            .pointer("/error/retry_after_seconds")
            .and_then(Value::as_u64)
            .or_else(|| {
                payload
                    .pointer("/retry_after_seconds")
                    .and_then(Value::as_u64)
            })
            .or_else(|| {
                payload
                    .pointer("/error/retry_after")
                    .and_then(Value::as_u64)
            })
            .or_else(|| payload.pointer("/retry_after").and_then(Value::as_u64))
            .or_else(|| {
                payload
                    .pointer("/error/retry_after_seconds")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<u64>().ok())
            })
    });

    from_header.or(from_body).unwrap_or(60).clamp(1, 600)
}

#[allow(dead_code)]
fn relaycast_error_detail(body: &Value) -> String {
    let message = body
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| body.pointer("/message").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let code = body
        .pointer("/error/code")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match (message, code) {
        (Some(message), Some(code)) => format!("{message} (code: {code})"),
        (Some(message), None) => message.to_string(),
        (None, Some(code)) => format!("Relaycast API error (code: {code})"),
        (None, None) => {
            serde_json::to_string(body).unwrap_or_else(|_| "<invalid-json>".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Agent event parsing (from WS events)
// ---------------------------------------------------------------------------

/// Parsed result from a relaycast `agent.spawn_requested` or `agent.release_requested` WS event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelaycastAgentEvent {
    Spawn {
        name: String,
        cli: String,
        task: Option<String>,
        channel: Option<String>,
    },
    Release {
        name: String,
    },
}

/// Parse a raw WS JSON value into a `RelaycastAgentEvent` if it matches
/// `agent.spawn_requested` or `agent.release_requested`.
pub fn parse_relaycast_agent_event(value: &serde_json::Value) -> Option<RelaycastAgentEvent> {
    let event_type = value.get("type")?.as_str()?;
    let agent = value.get("agent")?;

    match event_type {
        "agent.spawn_requested" => {
            let name = agent.get("name")?.as_str().filter(|s| !s.is_empty())?;
            let cli = agent.get("cli")?.as_str().filter(|s| !s.is_empty())?;
            let task = agent
                .get("task")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
            let channel = agent
                .get("channel")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
            Some(RelaycastAgentEvent::Spawn {
                name: name.to_string(),
                cli: cli.to_string(),
                task,
                channel,
            })
        }
        "agent.release_requested" => {
            let name = agent.get("name")?.as_str().filter(|s| !s.is_empty())?;
            Some(RelaycastAgentEvent::Release {
                name: name.to_string(),
            })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Registration retry helpers
// ---------------------------------------------------------------------------

pub fn registration_retry_after_secs(error: &RelaycastRegistrationError) -> Option<u64> {
    match error {
        RelaycastRegistrationError::Blocked {
            retry_after_secs, ..
        } => Some(*retry_after_secs),
        RelaycastRegistrationError::RateLimited {
            retry_after_secs, ..
        } => Some(*retry_after_secs),
        _ => None,
    }
}

pub fn registration_is_retryable(error: &RelaycastRegistrationError) -> bool {
    matches!(
        error,
        RelaycastRegistrationError::Blocked { .. }
            | RelaycastRegistrationError::RateLimited { .. }
            | RelaycastRegistrationError::Transport { .. }
    )
}

pub fn format_worker_preregistration_error(
    name: &str,
    error: &RelaycastRegistrationError,
) -> String {
    let mut message = format!(
        "failed to pre-register worker '{}' with relaycast: {}",
        name, error
    );
    if let Some(retry_after_secs) = registration_retry_after_secs(error) {
        if !message.to_ascii_lowercase().contains("retry after") {
            message.push_str(&format!(" (retry after {}s)", retry_after_secs));
        }
    }
    message
}

/// Outcome when agent pre-registration retries are exhausted or fail fatally.
pub enum RegRetryOutcome {
    /// All retries exhausted for a retryable error — spawn can proceed without token.
    RetryableExhausted(RelaycastRegistrationError),
    /// Non-retryable error — spawn should be aborted.
    Fatal(RelaycastRegistrationError),
}

/// Attempt to register an agent token with up to 3 retries for transient errors.
pub async fn retry_agent_registration(
    http: &RelaycastHttpClient,
    name: &str,
    cli: Option<&str>,
) -> Result<String, RegRetryOutcome> {
    const MAX_ATTEMPTS: u32 = 3;
    for attempt in 0..MAX_ATTEMPTS {
        match http.register_agent_token(name, cli).await {
            Ok(token) => return Ok(token),
            Err(error) if registration_is_retryable(&error) && attempt < MAX_ATTEMPTS - 1 => {
                tracing::warn!(
                    worker = %name,
                    attempt,
                    error = %error,
                    "pre-registration failed, retrying..."
                );
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(error) if registration_is_retryable(&error) => {
                return Err(RegRetryOutcome::RetryableExhausted(error));
            }
            Err(error) => {
                return Err(RegRetryOutcome::Fatal(error));
            }
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };

    use super::{
        build_ws_stream_url, parse_dm_participants_from_conversations, parse_relaycast_agent_event,
        parse_retry_after_seconds, reconnect_delay, registration_cli_from_hint,
        registration_is_retryable, registration_retry_after_secs, relaycast_error_detail,
        RelaycastAgentEvent, RelaycastHttpClient, RelaycastRegistrationError,
    };

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
        assert_eq!(url, "wss://api.relaycast.dev/v1/ws?token=tok_1");
    }

    #[test]
    fn avoids_duplicate_v1_when_base_already_has_v1() {
        let url = build_ws_stream_url("https://api.relaycast.dev/v1", "tok_2").unwrap();
        assert_eq!(url, "wss://api.relaycast.dev/v1/ws?token=tok_2");
    }

    #[test]
    fn preserves_custom_stream_path_and_query() {
        let url =
            build_ws_stream_url("wss://rt.relaycast.dev/stream?client=broker", "tok_3").unwrap();
        assert_eq!(url, "wss://rt.relaycast.dev/ws?client=broker&token=tok_3");
    }

    #[test]
    fn http_client_constructs_with_correct_fields() {
        let client = RelaycastHttpClient::new(
            "https://api.relaycast.dev",
            "rk_live_test",
            "my-broker",
            "codex",
        );
        assert_eq!(client.base_url, "https://api.relaycast.dev");
        assert_eq!(client.api_key, "rk_live_test");
        assert_eq!(client.agent_name, "my-broker");
        assert_eq!(client.default_cli, "codex");
        assert!(client.agent_tokens.lock().is_empty());
    }

    #[test]
    fn http_client_clone_shares_token() {
        let client =
            RelaycastHttpClient::new("https://api.relaycast.dev", "key", "agent", "claude");
        let clone = client.clone();
        client
            .agent_tokens
            .lock()
            .insert("agent".to_string(), "tok_123".to_string());
        assert_eq!(
            clone.agent_tokens.lock().get("agent").map(String::as_str),
            Some("tok_123")
        );
    }

    #[test]
    fn registration_block_remaining_returns_none_when_not_blocked() {
        let client =
            RelaycastHttpClient::new("https://api.relaycast.dev", "key", "agent", "claude");
        assert!(client.registration_block_remaining("agent").is_none());
    }

    #[test]
    fn registration_block_remaining_reports_positive_duration() {
        let client =
            RelaycastHttpClient::new("https://api.relaycast.dev", "key", "agent", "claude");
        client
            .registration_cooldowns
            .lock()
            .insert("agent".to_string(), Instant::now() + Duration::from_secs(2));
        let remaining = client.registration_block_remaining("agent");
        assert!(remaining.is_some());
        assert!(remaining.unwrap() <= Duration::from_secs(2));
    }

    #[test]
    fn registration_block_remaining_clears_expired_blocks() {
        let client =
            RelaycastHttpClient::new("https://api.relaycast.dev", "key", "agent", "claude");
        client
            .registration_cooldowns
            .lock()
            .insert("agent".to_string(), Instant::now() - Duration::from_secs(1));
        assert!(client.registration_block_remaining("agent").is_none());
        assert!(!client.registration_cooldowns.lock().contains_key("agent"));
    }

    #[test]
    fn invalidate_cached_registration_removes_token_and_cooldown() {
        let client =
            RelaycastHttpClient::new("https://api.relaycast.dev", "key", "agent", "claude");
        client
            .agent_tokens
            .lock()
            .insert("worker-a".to_string(), "tok_abc".to_string());
        client.registration_cooldowns.lock().insert(
            "worker-a".to_string(),
            Instant::now() + Duration::from_secs(30),
        );

        client.invalidate_cached_registration("worker-a");

        assert!(!client.agent_tokens.lock().contains_key("worker-a"));
        assert!(!client
            .registration_cooldowns
            .lock()
            .contains_key("worker-a"));
    }

    #[test]
    fn parse_retry_after_seconds_prefers_header_then_body_then_default() {
        let mut headers = HashMap::new();
        headers.insert("retry-after".to_string(), "12".to_string());
        let body = json!({"error":{"retry_after_seconds": 34}});
        assert_eq!(parse_retry_after_seconds(Some(&headers), Some(&body)), 12);

        let headers: HashMap<String, String> = HashMap::new();
        assert_eq!(parse_retry_after_seconds(Some(&headers), Some(&body)), 34);

        let body = json!({"error":{"message":"rate limited"}});
        assert_eq!(parse_retry_after_seconds(Some(&headers), Some(&body)), 60);
    }

    #[test]
    fn relaycast_error_detail_prefers_structured_message_and_code() {
        let body = json!({
            "ok": false,
            "error": {
                "code": "rate_limit_exceeded",
                "message": "Rate limit exceeded. 60 requests per minute allowed for free plan."
            }
        });
        let detail = relaycast_error_detail(&body);
        assert_eq!(
            detail,
            "Rate limit exceeded. 60 requests per minute allowed for free plan. (code: rate_limit_exceeded)"
        );
    }

    #[test]
    fn relaycast_error_detail_falls_back_to_json_when_unstructured() {
        let body = json!({"unexpected":"payload"});
        let detail = relaycast_error_detail(&body);
        assert_eq!(detail, "{\"unexpected\":\"payload\"}");
    }

    #[test]
    fn registration_cli_from_hint_prefers_valid_hint() {
        assert_eq!(
            registration_cli_from_hint(Some("/usr/local/bin/gemini --model pro"), "claude"),
            "gemini"
        );
        assert_eq!(
            registration_cli_from_hint(Some("claude:latest"), "codex"),
            "claude"
        );
    }

    #[test]
    fn registration_cli_from_hint_falls_back_when_hint_invalid() {
        assert_eq!(registration_cli_from_hint(Some("cat"), "codex"), "codex");
        assert_eq!(
            registration_cli_from_hint(Some("cat"), "unknown-cli"),
            "claude"
        );
    }

    #[test]
    fn register_agent_token_honors_agent_scoped_registration_block() {
        let client =
            RelaycastHttpClient::new("https://api.relaycast.dev", "key", "agent", "claude");
        client.registration_cooldowns.lock().insert(
            "worker-a".to_string(),
            Instant::now() + Duration::from_secs(2),
        );

        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let result = runtime.block_on(client.register_agent_token("worker-a", Some("claude")));
        match result {
            Err(RelaycastRegistrationError::Blocked {
                retry_after_secs, ..
            }) => {
                assert!(retry_after_secs >= 1);
            }
            other => panic!("expected blocked error, got {other:?}"),
        }
    }

    #[test]
    fn keeps_existing_stream_endpoint_and_replaces_token() {
        let url = build_ws_stream_url(
            "wss://api.relaycast.dev/v1/ws?token=old&mode=fast",
            "new_tok",
        )
        .unwrap();
        assert_eq!(url, "wss://api.relaycast.dev/v1/ws?mode=fast&token=new_tok");
    }

    #[test]
    fn parses_dm_participants_from_data_array() {
        let body = json!({
            "ok": true,
            "data": [
                { "id": "conv_1", "participants": ["Dashboard", "Lead"] },
                { "id": "conv_2", "participants": ["A", "B"] }
            ]
        });

        let participants = parse_dm_participants_from_conversations(&body, "conv_1");
        assert_eq!(
            participants,
            vec!["Dashboard".to_string(), "Lead".to_string()]
        );
    }

    #[test]
    fn parses_dm_participants_from_nested_conversations_shape() {
        let body = json!({
            "ok": true,
            "data": {
                "conversations": [
                    { "id": "conv_3", "participants": ["Ops", "Worker"] }
                ]
            }
        });

        let participants = parse_dm_participants_from_conversations(&body, "conv_3");
        assert_eq!(participants, vec!["Ops".to_string(), "Worker".to_string()]);
    }

    // --- parse_relaycast_agent_event tests ---

    #[test]
    fn parses_agent_spawn_requested() {
        let event = parse_relaycast_agent_event(&json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "Worker1",
                "cli": "claude",
                "task": "Do some work",
                "channel": "general",
                "already_existed": false
            }
        }));
        assert_eq!(
            event,
            Some(RelaycastAgentEvent::Spawn {
                name: "Worker1".into(),
                cli: "claude".into(),
                task: Some("Do some work".into()),
                channel: Some("general".into()),
            })
        );
    }

    #[test]
    fn parses_agent_spawn_requested_null_channel() {
        let event = parse_relaycast_agent_event(&json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "Worker2",
                "cli": "codex",
                "task": "Task text",
                "channel": null,
                "already_existed": true
            }
        }));
        assert_eq!(
            event,
            Some(RelaycastAgentEvent::Spawn {
                name: "Worker2".into(),
                cli: "codex".into(),
                task: Some("Task text".into()),
                channel: None,
            })
        );
    }

    #[test]
    fn parses_agent_release_requested() {
        let event = parse_relaycast_agent_event(&json!({
            "type": "agent.release_requested",
            "agent": { "name": "Worker1" },
            "reason": "task complete",
            "deleted": false
        }));
        assert_eq!(
            event,
            Some(RelaycastAgentEvent::Release {
                name: "Worker1".into(),
            })
        );
    }

    #[test]
    fn spawn_requested_missing_name_returns_none() {
        assert!(parse_relaycast_agent_event(&json!({
            "type": "agent.spawn_requested",
            "agent": { "cli": "claude", "task": "work" }
        }))
        .is_none());
    }

    #[test]
    fn spawn_requested_missing_cli_returns_none() {
        assert!(parse_relaycast_agent_event(&json!({
            "type": "agent.spawn_requested",
            "agent": { "name": "Worker1", "task": "work" }
        }))
        .is_none());
    }

    #[test]
    fn spawn_requested_empty_name_returns_none() {
        assert!(parse_relaycast_agent_event(&json!({
            "type": "agent.spawn_requested",
            "agent": { "name": "", "cli": "claude", "task": "work" }
        }))
        .is_none());
    }

    #[test]
    fn release_requested_empty_name_returns_none() {
        assert!(parse_relaycast_agent_event(&json!({
            "type": "agent.release_requested",
            "agent": { "name": "" },
            "reason": null,
            "deleted": false
        }))
        .is_none());
    }

    #[test]
    fn release_requested_missing_agent_returns_none() {
        assert!(parse_relaycast_agent_event(&json!({
            "type": "agent.release_requested",
            "reason": "done",
            "deleted": true
        }))
        .is_none());
    }

    #[test]
    fn unrelated_event_type_returns_none() {
        assert!(parse_relaycast_agent_event(&json!({
            "type": "message.created",
            "agent": { "name": "Worker1", "cli": "claude" }
        }))
        .is_none());
    }

    #[test]
    fn command_invoked_not_matched_by_relaycast_parser() {
        assert!(parse_relaycast_agent_event(&json!({
            "type": "command.invoked",
            "command": "/spawn",
            "channel": "general",
            "invoked_by": "123",
            "parameters": { "name": "x", "cli": "y" }
        }))
        .is_none());
    }

    #[test]
    fn registration_retryable_for_rate_limited() {
        let error = RelaycastRegistrationError::RateLimited {
            agent_name: "test".into(),
            retry_after_secs: 60,
            detail: "too many requests".into(),
        };
        assert!(registration_is_retryable(&error));
        assert_eq!(registration_retry_after_secs(&error), Some(60));
    }

    #[test]
    fn registration_not_retryable_for_api_error() {
        let error = RelaycastRegistrationError::Api {
            agent_name: "test".into(),
            status: 401,
            detail: "unauthorized".into(),
        };
        assert!(!registration_is_retryable(&error));
        assert_eq!(registration_retry_after_secs(&error), None);
    }
}
