use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use relaycast::{
    agent::DmOptions, format_registration_error,
    retry_agent_registration as sdk_retry_agent_registration, ActionDefinition, ActionInvocation,
    AgentClient, AgentRegistrationClient, AgentRegistrationError, AgentRegistrationRetryOutcome,
    CompleteInvocationRequest, MessageListQuery, RegisterActionRequest, RelayCast,
    RelayCastOptions, ReleaseAgentRequest, WsClient, WsClientOptions, WsLifecycleEvent,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::{events::EventEmitter, protocol::MessageInjectionMode};

#[derive(Debug, Clone)]
pub enum WsControl {
    Shutdown,
    Publish(Value),
    /// Re-subscribe to a list of channels (e.g. after creating/joining a new
    /// channel that didn't exist when the WS connection was first established).
    Subscribe(Vec<crate::ids::ChannelName>),
    /// Unsubscribe from channels that an agent has left.
    Unsubscribe(Vec<crate::ids::ChannelName>),
}

/// Maximum messages fetched per channel / DM conversation during reconnect backfill.
const BACKFILL_FETCH_LIMIT: usize = 50;

#[derive(Clone)]
pub struct RelaycastWsClient {
    ws_base_url: String,
    workspace_http: RelaycastHttpClient,
    /// Reference-counted channel subscriptions: channel_name -> number of agents subscribed.
    /// The WS only unsubscribes when the count drops to zero.
    subscriptions: Arc<Mutex<HashMap<crate::ids::ChannelName, usize>>>,
    /// Newest server-side `created_at` observed on message-bearing frames;
    /// bounds the reconnect backfill window.
    cursor: Arc<BackfillCursor>,
}

impl RelaycastWsClient {
    pub fn new(
        ws_base_url: impl Into<String>,
        workspace_http: RelaycastHttpClient,
        channels: impl IntoIterator<Item = String>,
    ) -> Self {
        let mut subs = HashMap::new();
        for ch in channels {
            *subs.entry(crate::ids::ChannelName::from(ch)).or_insert(0) += 1;
        }
        Self {
            ws_base_url: ws_base_url.into(),
            workspace_http,
            subscriptions: Arc::new(Mutex::new(subs)),
            cursor: Arc::new(BackfillCursor::default()),
        }
    }

    pub fn active_subscriptions(&self) -> Vec<crate::ids::ChannelName> {
        self.subscriptions.lock().keys().cloned().collect()
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

            // Attribute the broker's own relaycast traffic (the workspace
            // stream) to the agent-relay CLI as the origin actor — forwarded as
            // the `origin_actor` query param (WS upgrades can't set headers).
            let ws_opts = WsClientOptions::new(self.workspace_http.api_key.clone())
                .with_base_url(self.ws_base_url.clone())
                .with_origin_actor(crate::telemetry::BROKER_ORIGIN_ACTOR);
            let mut ws = WsClient::new(ws_opts);

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
                        let active_strs: Vec<String> = active_subscriptions
                            .iter()
                            .map(|c| c.as_str().to_string())
                            .collect();
                        if let Err(error) = ws.subscribe(active_strs.clone()).await {
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

                    // Seed the cursor at connect time so the first backfill
                    // window starts at "now" instead of replaying history.
                    self.cursor.initialize(Utc::now());
                    if status == "reconnected" {
                        // The workspace stream has no server-side resync, so
                        // recover the disconnect window from message history.
                        self.replay_missed_messages(&inbound_tx, &events).await;
                    }

                    // Raw events keep Relay's broker bridge on the exact wire
                    // payload while the SDK owns websocket transport details.
                    let mut raw_event_rx = ws.subscribe_raw_events();
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
                                                let count = subs.entry(ch.clone()).or_insert(0);
                                                if *count == 0 {
                                                    joined_now.push(ch.clone());
                                                }
                                                *count += 1;
                                            }
                                        }
                                        if !joined_now.is_empty() {
                                            let joined_strs: Vec<String> = joined_now
                                                .iter()
                                                .map(|c| c.as_str().to_string())
                                                .collect();
                                            if let Err(error) = ws.subscribe(joined_strs).await {
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
                                    Some(WsControl::Unsubscribe(channels)) => {
                                        let mut left_now = Vec::new();
                                        {
                                            let mut subs = self.subscriptions.lock();
                                            for ch in &channels {
                                                if let Some(count) = subs.get_mut(ch) {
                                                    *count = count.saturating_sub(1);
                                                    if *count == 0 {
                                                        subs.remove(ch);
                                                        left_now.push(ch.clone());
                                                    }
                                                }
                                            }
                                        }
                                        if !left_now.is_empty() {
                                            let left_strs: Vec<String> = left_now
                                                .iter()
                                                .map(|c| c.as_str().to_string())
                                                .collect();
                                            if let Err(error) = ws.unsubscribe(left_strs).await {
                                                tracing::warn!(
                                                    target = "relay_broker::ws",
                                                    channels = ?left_now,
                                                    error = %error,
                                                    "failed to unsubscribe websocket from broker channels"
                                                );
                                            } else {
                                                tracing::info!(
                                                    target = "broker::ws",
                                                    channels = ?left_now,
                                                    "unsubscribed websocket from broker channels"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                            event = raw_event_rx.recv() => {
                                match event {
                                    Ok(value) => {
                                        self.cursor.observe_event(&value);
                                        let _ = inbound_tx.send(value).await;
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
                                        // The SDK reconnected internally and
                                        // re-subscribed channels; recover the
                                        // disconnect window from history. If
                                        // this is the initial open, the cursor
                                        // was just seeded and nothing replays.
                                        self.replay_missed_messages(&inbound_tx, &events).await;
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

    /// Replay messages created after the backfill cursor through the normal
    /// inbound delivery path (bridge -> routing -> pending delivery). The
    /// runtime dedup cache (keyed `{workspace_id}:{event_id}`) suppresses
    /// events that were already delivered before the disconnect.
    async fn replay_missed_messages(
        &self,
        inbound_tx: &mpsc::Sender<Value>,
        events: &EventEmitter,
    ) {
        let Some(cursor) = self.cursor.snapshot() else {
            return;
        };
        let backfill = self.collect_backfill_events(cursor).await;
        let replayed = backfill.len();
        let gap_detected = replayed > 0;
        for event in backfill {
            // Advance the cursor past replayed messages so a subsequent
            // reconnect does not replay the same window again.
            self.cursor.observe_event(&event);
            let _ = inbound_tx.send(event).await;
        }
        tracing::info!(
            target = "broker::ws",
            replayed,
            gap_detected,
            cursor = %cursor.to_rfc3339(),
            "websocket reconnect backfill complete"
        );
        events.emit(
            "resync",
            json!({"replayed": replayed, "gap_detected": gap_detected}),
        );
        let _ = inbound_tx
            .send(json!({
                "type": "broker.resync",
                "payload": {"replayed": replayed, "gap_detected": gap_detected}
            }))
            .await;
    }

    /// Fetch channel and DM history and convert messages created strictly
    /// after `cursor` into synthetic `message.created` events, oldest-first.
    async fn collect_backfill_events(&self, cursor: DateTime<Utc>) -> Vec<Value> {
        let mut backfill = Vec::new();

        for channel in self.active_subscriptions() {
            match self
                .workspace_http
                .get_channel_messages(channel.as_str(), BACKFILL_FETCH_LIMIT)
                .await
            {
                Ok(messages) => {
                    for message in messages {
                        if message_created_after(&message, cursor) {
                            backfill.push(synthetic_channel_event(channel.as_str(), message));
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        target = "relay_broker::ws",
                        channel = %channel,
                        error = %error,
                        "failed to fetch channel history for reconnect backfill"
                    );
                }
            }
        }

        match self.workspace_http.get_all_dms(BACKFILL_FETCH_LIMIT).await {
            Ok(messages) => {
                for message in messages {
                    if message_created_after(&message, cursor) {
                        if let Some(event) = synthetic_dm_event(message) {
                            backfill.push(event);
                        }
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    target = "relay_broker::ws",
                    error = %error,
                    "failed to fetch DM history for reconnect backfill"
                );
            }
        }

        backfill.sort_by_key(|event| {
            event
                .get("message")
                .and_then(message_created_at)
                .unwrap_or(cursor)
        });
        backfill
    }
}

/// Tracks the newest server-side `created_at` seen on message-bearing
/// websocket frames so the reconnect backfill can bound its replay window.
#[derive(Debug, Default)]
pub(crate) struct BackfillCursor {
    inner: Mutex<Option<DateTime<Utc>>>,
}

impl BackfillCursor {
    /// Advance the cursor from a raw websocket frame. Frames without a
    /// parseable timestamp are ignored; older timestamps never regress it.
    pub(crate) fn observe_event(&self, value: &Value) {
        if let Some(ts) = event_created_at(value) {
            let mut guard = self.inner.lock();
            if guard.is_none_or(|current| ts > current) {
                *guard = Some(ts);
            }
        }
    }

    /// Seed the cursor when unset so a backfill before any traffic replays
    /// nothing.
    pub(crate) fn initialize(&self, ts: DateTime<Utc>) {
        let mut guard = self.inner.lock();
        if guard.is_none() {
            *guard = Some(ts);
        }
    }

    pub(crate) fn snapshot(&self) -> Option<DateTime<Utc>> {
        *self.inner.lock()
    }
}

/// Extract the server `created_at` from a raw websocket frame, tolerating
/// top-level and payload-wrapped shapes.
fn event_created_at(value: &Value) -> Option<DateTime<Utc>> {
    const CANDIDATES: [&str; 4] = [
        "/message/created_at",
        "/payload/message/created_at",
        "/created_at",
        "/payload/created_at",
    ];
    CANDIDATES.iter().find_map(|pointer| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .and_then(parse_rfc3339)
    })
}

fn parse_rfc3339(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|ts| ts.with_timezone(&Utc))
}

fn message_created_at(message: &Value) -> Option<DateTime<Utc>> {
    message
        .get("created_at")
        .and_then(Value::as_str)
        .and_then(parse_rfc3339)
}

/// True when the message carries a parseable `created_at` strictly newer
/// than the cursor. Messages without a timestamp are excluded so a reconnect
/// never replays unbounded history.
fn message_created_after(message: &Value, cursor: DateTime<Utc>) -> bool {
    message_created_at(message).is_some_and(|ts| ts > cursor)
}

/// Wrap a fetched channel message in the wire shape the inbound bridge maps.
fn synthetic_channel_event(channel: &str, message: Value) -> Value {
    json!({
        "type": "message.created",
        "channel": channel,
        "replayed": true,
        "message": message,
    })
}

/// Wrap a fetched DM message (tagged with `conversation_id` by
/// `get_all_dms`) in the conversation-shaped wire event the bridge maps to a
/// DM. Returns `None` when the conversation id is missing.
fn synthetic_dm_event(message: Value) -> Option<Value> {
    let conversation_id = message
        .get("conversation_id")
        .and_then(Value::as_str)?
        .to_string();
    Some(json!({
        "type": "message.created",
        "conversation_id": conversation_id,
        "replayed": true,
        "message": message,
    }))
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
#[cfg(test)]
pub(crate) use relaycast::registration_is_retryable;
pub(crate) use relaycast::registration_retry_after_secs;

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

    /// Pre-populate the SDK token cache so registered-agent client creation
    /// skips the spawn registration call entirely. Used to seed the broker's
    /// own session token obtained during auth startup.
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

    pub(crate) fn relay_client(&self) -> Option<&RelayCast> {
        self.relay.as_ref().as_ref()
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

    async fn registered_agent_client(&self) -> Result<AgentClient> {
        let registration = self
            .registration
            .as_ref()
            .as_ref()
            .context("SDK relay client not initialized")?;
        registration
            .registered_agent_client(&self.agent_name, Some(&self.default_cli))
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    async fn registered_agent_client_as(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
    ) -> Result<AgentClient> {
        let registration = self
            .registration
            .as_ref()
            .as_ref()
            .context("SDK relay client not initialized")?;
        registration
            .registered_agent_client(agent_name, cli_hint.or(Some(self.default_cli.as_str())))
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    /// Impersonation by design: delivery read-acks must be attributed to the
    /// recipient worker's agent identity, not the broker identity.
    pub async fn mark_read_as_agent(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
        message_id: &str,
    ) -> Result<serde_json::Value> {
        self.registered_agent_client_as(agent_name, cli_hint)
            .await?
            .mark_read(message_id)
            .await
            .map_err(|error| anyhow::anyhow!("relaycast mark_read failed: {error}"))
    }

    /// Register an action whose handler is this broker's agent. Spawn/release
    /// are exposed as relaycast actions so other agents can invoke them as
    /// structured agent-to-agent RPC.
    pub async fn register_action(
        &self,
        request: RegisterActionRequest,
    ) -> Result<ActionDefinition> {
        let relay = self
            .relay_client()
            .context("SDK relay client not initialized")?;
        relay
            .register_action(request)
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    /// Fetch a single action invocation, including its `input`. The
    /// `action.invoked` WebSocket event omits the input payload, so the handler
    /// must read it back here before executing.
    pub async fn get_action_invocation(
        &self,
        name: &str,
        invocation_id: &str,
    ) -> Result<ActionInvocation> {
        self.registered_agent_client()
            .await?
            .get_action_invocation(name, invocation_id)
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    /// Report the result (or error) of an action invocation as the handler.
    pub async fn complete_action_invocation(
        &self,
        name: &str,
        invocation_id: &str,
        request: CompleteInvocationRequest,
    ) -> Result<ActionInvocation> {
        self.registered_agent_client()
            .await?
            .complete_action_invocation(name, invocation_id, request)
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
        self.send_dm_with_mode(to, text, MessageInjectionMode::Wait)
            .await
    }

    /// Send a direct message with explicit injection mode via the Relaycast REST API.
    pub async fn send_dm_with_mode(
        &self,
        to: &str,
        text: &str,
        mode: MessageInjectionMode,
    ) -> Result<()> {
        let agent_client = self.registered_agent_client().await?;
        let relay_mode = match mode {
            MessageInjectionMode::Wait => relaycast::MessageInjectionMode::Wait,
            MessageInjectionMode::Steer => relaycast::MessageInjectionMode::Steer,
        };
        agent_client
            .dm(
                to,
                text,
                Some(DmOptions {
                    mode: relay_mode,
                    attachments: None,
                    idempotency_key: None,
                }),
            )
            .await
            .map_err(|e| anyhow::anyhow!("relaycast send_dm failed: {e}"))?;
        Ok(())
    }

    /// Post a message to a channel via the Relaycast REST API.
    pub async fn send_to_channel(&self, channel: &str, text: &str) -> Result<()> {
        let agent_client = self.registered_agent_client().await?;
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
        let defaults = [
            ("general", "General discussion"),
            ("engineering", "Engineering discussion"),
        ];
        let agent_client = match self.registered_agent_client().await {
            Ok(client) => client,
            Err(error) => {
                tracing::warn!(error = %error, "failed to create registered agent client for channel startup");
                return Ok(());
            }
        };
        for (name, topic) in &defaults {
            let request = relaycast::CreateChannelRequest {
                name: name.to_string(),
                topic: Some(topic.to_string()),
                metadata: None,
            };
            match agent_client.ensure_joined_channel(request).await {
                Ok(outcome) => tracing::info!(
                    channel = %outcome.name,
                    created = outcome.created,
                    joined = outcome.joined,
                    "ensured default channel membership"
                ),
                Err(error) => {
                    tracing::warn!(channel = %name, error = %error, "failed to ensure default channel membership");
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
    pub async fn ensure_extra_channels(&self, channels: &[crate::ids::ChannelName]) -> Result<()> {
        let defaults = ["general", "engineering"];
        let extras: Vec<&crate::ids::ChannelName> = channels
            .iter()
            .filter(|c| !defaults.contains(&c.as_str()))
            .collect();
        if extras.is_empty() {
            return Ok(());
        }
        let agent_client = match self.registered_agent_client().await {
            Ok(client) => client,
            Err(error) => {
                tracing::warn!(error = %error, "failed to create registered agent client for extra channel startup");
                return Ok(());
            }
        };
        for name in extras {
            let request = relaycast::CreateChannelRequest {
                name: name.as_str().to_string(),
                topic: None,
                metadata: None,
            };
            match agent_client.ensure_joined_channel(request).await {
                Ok(outcome) => tracing::info!(
                    channel = %outcome.name,
                    created = outcome.created,
                    joined = outcome.joined,
                    "ensured extra channel membership"
                ),
                Err(error) => {
                    tracing::warn!(channel = %name, error = %error, "failed to ensure extra channel membership");
                }
            }
        }
        Ok(())
    }

    /// Fetch recent DM history for an agent via the Relaycast REST API.
    pub async fn get_dms(&self, agent: &str, limit: usize) -> Result<Vec<Value>> {
        let agent_client = self.registered_agent_client().await?;
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

    /// Fetch recent message history from a channel via the Relaycast REST API.
    pub async fn get_channel_messages(&self, channel: &str, limit: usize) -> Result<Vec<Value>> {
        let agent_client = self.registered_agent_client().await?;
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
        self.send_with_mode(to, text, MessageInjectionMode::Wait)
            .await
    }

    /// Smart send with explicit injection mode.
    pub async fn send_with_mode(
        &self,
        to: &str,
        text: &str,
        mode: MessageInjectionMode,
    ) -> Result<()> {
        if to.starts_with('#') {
            let agent_client = self.registered_agent_client().await?;
            let relay_mode = match mode {
                MessageInjectionMode::Wait => relaycast::MessageInjectionMode::Wait,
                MessageInjectionMode::Steer => relaycast::MessageInjectionMode::Steer,
            };
            agent_client
                .send_with_mode(to, text, None, None, relay_mode, None)
                .await
                .map_err(|e| anyhow::anyhow!("relaycast send_to_channel failed: {e}"))?;
            return Ok(());
        }

        self.send_dm_with_mode(to, text, mode).await
    }
}

/// Build a `RelayCast` workspace client from an API key and base URL.
fn build_relay_client(api_key: &str, base_url: &str) -> Option<RelayCast> {
    let opts = RelayCastOptions::new(api_key)
        .with_base_url(base_url)
        .with_origin_actor(crate::telemetry::BROKER_ORIGIN_ACTOR);
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
    use chrono::{DateTime, Utc};
    use httpmock::{
        Method::{GET, POST},
        MockServer,
    };
    use relaycast::AgentRegistrationError;
    use serde_json::json;

    use crate::events::EventEmitter;

    use super::{
        format_worker_preregistration_error, registration_is_retryable,
        registration_retry_after_secs, synthetic_channel_event, BackfillCursor,
        MessageInjectionMode, RelaycastHttpClient, RelaycastWsClient,
    };

    fn seeded_http_client(base_url: &str) -> RelaycastHttpClient {
        let client =
            RelaycastHttpClient::new(base_url.to_string(), "rk_live_test", "broker", "codex");
        client.seed_agent_token("broker", "at_live_test");
        client
    }

    fn ts(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .expect("test timestamp should parse")
            .with_timezone(&Utc)
    }

    #[test]
    fn backfill_cursor_tracks_newest_timestamp_tolerantly() {
        let cursor = BackfillCursor::default();
        assert!(cursor.snapshot().is_none());

        // Absent or malformed timestamps are ignored without breaking.
        cursor.observe_event(&json!({"type":"message.created","message":{"id":"m1"}}));
        cursor.observe_event(&json!({
            "type":"message.created",
            "message":{"id":"m1","created_at":"not-a-date"}
        }));
        assert!(cursor.snapshot().is_none());

        cursor.observe_event(&json!({
            "type":"message.created",
            "channel":"general",
            "message":{"id":"m2","created_at":"2026-06-09T10:00:00Z"}
        }));
        assert_eq!(cursor.snapshot(), Some(ts("2026-06-09T10:00:00Z")));

        // Payload-wrapped shapes also advance the cursor.
        cursor.observe_event(&json!({
            "type":"dm.received",
            "payload":{"message":{"id":"m3","created_at":"2026-06-09T10:05:00Z"}}
        }));
        assert_eq!(cursor.snapshot(), Some(ts("2026-06-09T10:05:00Z")));

        // Older frames never regress the cursor.
        cursor.observe_event(&json!({"created_at":"2026-06-09T09:00:00Z"}));
        assert_eq!(cursor.snapshot(), Some(ts("2026-06-09T10:05:00Z")));

        // Initialize only seeds an unset cursor.
        cursor.initialize(ts("2026-06-09T00:00:00Z"));
        assert_eq!(cursor.snapshot(), Some(ts("2026-06-09T10:05:00Z")));
    }

    #[test]
    fn replayed_backfill_event_dedupes_against_live_delivery() {
        use std::time::{Duration, Instant};

        let live = json!({
            "type": "message.created",
            "channel": "general",
            "message": {
                "id": "msg_7",
                "agent_name": "alice",
                "text": "hello",
                "created_at": "2026-06-09T10:00:00.000Z"
            }
        });
        let replayed = synthetic_channel_event(
            "general",
            json!({
                "id": "msg_7",
                "agent_id": "a1",
                "agent_name": "alice",
                "text": "hello",
                "created_at": "2026-06-09T10:00:00.000Z"
            }),
        );

        let live_mapped = crate::relaycast::bridge::map_ws_event(&live, "ws_1", None)
            .expect("live event should map");
        let replay_mapped = crate::relaycast::bridge::map_ws_event(&replayed, "ws_1", None)
            .expect("replayed event should map");
        assert_eq!(live_mapped.event_id, replay_mapped.event_id);

        let mut dedup = crate::dedup::DedupCache::new(Duration::from_secs(300), 128);
        let live_key = format!("{}:{}", live_mapped.workspace_id, live_mapped.event_id);
        assert!(dedup.insert_if_new(&live_key, Instant::now()));
        let replay_key = format!("{}:{}", replay_mapped.workspace_id, replay_mapped.event_id);
        assert!(
            !dedup.insert_if_new(&replay_key, Instant::now()),
            "replayed event must be suppressed by the runtime dedup cache"
        );
    }

    #[tokio::test]
    async fn collect_backfill_events_filters_by_cursor_and_orders_oldest_first() {
        let server = MockServer::start();
        let _channel_mock = server.mock(|when, then| {
            when.method(GET).path("/v1/channels/general/messages");
            then.status(200).json_body(json!({
                "ok": true,
                "data": [
                    {
                        "id": "msg_new",
                        "agent_id": "a2",
                        "agent_name": "alice",
                        "text": "after gap",
                        "created_at": "2026-06-09T10:01:00.000Z"
                    },
                    {
                        "id": "msg_old",
                        "agent_id": "a1",
                        "agent_name": "alice",
                        "text": "before gap",
                        "created_at": "2026-06-09T09:00:00.000Z"
                    }
                ]
            }));
        });
        let _conversations_mock = server.mock(|when, then| {
            when.method(GET).path("/v1/dm/conversations/all");
            then.status(200).json_body(json!({
                "ok": true,
                "data": [{
                    "id": "conv_1",
                    "type": "dm",
                    "participants": ["broker", "worker-a"],
                    "last_message": null,
                    "message_count": 2
                }]
            }));
        });
        let _dm_messages_mock = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/dm/conversations/conv_1/messages");
            then.status(200).json_body(json!({
                "ok": true,
                "data": [
                    {
                        "id": "dm_new",
                        "agent_id": "a3",
                        "agent_name": "bob",
                        "text": "dm after gap",
                        "created_at": "2026-06-09T10:00:30.000Z"
                    },
                    {
                        "id": "dm_old",
                        "agent_id": "a3",
                        "agent_name": "bob",
                        "text": "dm before gap",
                        "created_at": "2026-06-09T08:00:00.000Z"
                    }
                ]
            }));
        });

        let http = seeded_http_client(&server.base_url());
        let ws = RelaycastWsClient::new(server.base_url(), http, vec!["general".to_string()]);

        let events = ws.collect_backfill_events(ts("2026-06-09T10:00:00Z")).await;

        assert_eq!(events.len(), 2, "only messages after the cursor replay");
        // Oldest-first: the DM at 10:00:30 precedes the channel msg at 10:01:00.
        assert_eq!(events[0]["type"], "message.created");
        assert_eq!(events[0]["conversation_id"], "conv_1");
        assert_eq!(events[0]["replayed"], true);
        assert_eq!(events[0]["message"]["id"], "dm_new");
        assert_eq!(events[1]["channel"], "general");
        assert_eq!(events[1]["replayed"], true);
        assert_eq!(events[1]["message"]["id"], "msg_new");
    }

    #[tokio::test]
    async fn replay_missed_messages_replays_gap_and_emits_resync_frame() {
        let server = MockServer::start();
        let _channel_mock = server.mock(|when, then| {
            when.method(GET).path("/v1/channels/general/messages");
            then.status(200).json_body(json!({
                "ok": true,
                "data": [{
                    "id": "msg_gap",
                    "agent_id": "a2",
                    "agent_name": "alice",
                    "text": "missed during disconnect",
                    "created_at": "2026-06-09T10:02:00.000Z"
                }]
            }));
        });
        let _conversations_mock = server.mock(|when, then| {
            when.method(GET).path("/v1/dm/conversations/all");
            then.status(200).json_body(json!({"ok": true, "data": []}));
        });

        let http = seeded_http_client(&server.base_url());
        let ws = RelaycastWsClient::new(server.base_url(), http, vec!["general".to_string()]);
        // Simulate pre-disconnect traffic that positioned the cursor.
        ws.cursor.observe_event(&json!({
            "type": "message.created",
            "channel": "general",
            "message": {"id": "msg_seen", "created_at": "2026-06-09T10:00:00.000Z"}
        }));

        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        ws.replay_missed_messages(&tx, &EventEmitter::new(false))
            .await;

        let first = rx.recv().await.expect("replayed event should arrive");
        assert_eq!(first["type"], "message.created");
        assert_eq!(first["message"]["id"], "msg_gap");
        let resync = rx.recv().await.expect("resync frame should follow");
        assert_eq!(resync["type"], "broker.resync");
        assert_eq!(resync["payload"]["replayed"], 1);
        assert_eq!(resync["payload"]["gap_detected"], true);

        // Cursor advanced past the replayed message so the next reconnect
        // does not replay the same window again.
        assert_eq!(ws.cursor.snapshot(), Some(ts("2026-06-09T10:02:00Z")));
    }

    #[tokio::test]
    async fn replay_missed_messages_is_noop_without_cursor() {
        let server = MockServer::start();
        let http = seeded_http_client(&server.base_url());
        let ws = RelaycastWsClient::new(server.base_url(), http, vec!["general".to_string()]);

        let (tx, mut rx) = tokio::sync::mpsc::channel(16);
        ws.replay_missed_messages(&tx, &EventEmitter::new(false))
            .await;

        assert!(
            rx.try_recv().is_err(),
            "no frames should be sent before the cursor is seeded"
        );
    }

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

    #[tokio::test]
    async fn mark_read_as_agent_uses_seeded_recipient_token_without_respawn() {
        let server = MockServer::start();
        let read_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/messages/msg_1/read")
                .header("authorization", "Bearer at_live_existing_recipient");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "message_id": "msg_1",
                    "agent_id": "agent_existing_recipient",
                    "read_at": "2026-06-08T10:00:00.000Z"
                }
            }));
        });
        let spawn_mock = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/spawn");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "agent": {
                        "id": "agent_fresh_wrong",
                        "name": "recipient",
                        "type": "agent",
                        "status": "online",
                        "created_at": "2026-06-08T10:00:00.000Z",
                        "last_seen": "2026-06-08T10:00:00.000Z",
                        "metadata": {}
                    },
                    "token": "at_live_fresh_wrong"
                }
            }));
        });

        let client = RelaycastHttpClient::new(server.base_url(), "rk_live_test", "broker", "codex");
        client.seed_agent_token("recipient", "at_live_existing_recipient");

        let result = client
            .mark_read_as_agent("recipient", Some("codex"), "msg_1")
            .await
            .expect("seeded recipient should mark read");

        assert_eq!(result["agent_id"], "agent_existing_recipient");
        read_mock.assert_hits(1);
        spawn_mock.assert_hits(0);
    }

    #[tokio::test]
    #[ignore = "relaycast API response fixture mismatch - needs investigation"]
    async fn send_with_mode_forwards_steer_for_relaycast_dm_targets() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/dm")
                .body_contains("\"to\":\"worker-a\"")
                .body_contains("\"text\":\"interrupt\"")
                .body_contains("\"mode\":\"steer\"");
            then.status(200).json_body(json!({
                "conversation_id": "dm_1",
                "message": {
                    "id": "msg_1",
                    "agent_id": "agent_1",
                    "agent_name": "broker",
                    "text": "interrupt",
                    "injection_mode": "steer"
                },
                "created_at": "2026-03-23T00:00:00Z"
            }));
        });

        let client = seeded_http_client(&server.base_url());
        client
            .send_with_mode("worker-a", "interrupt", MessageInjectionMode::Steer)
            .await
            .expect("relaycast DM steer send should succeed");
    }

    #[tokio::test]
    #[ignore = "relaycast API response fixture mismatch - needs investigation"]
    async fn send_dm_defaults_to_wait_mode_for_relaycast_dm_targets() {
        let server = MockServer::start();
        let _mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/dm")
                .body_contains("\"to\":\"worker-a\"")
                .body_contains("\"text\":\"hello\"")
                .body_contains("\"mode\":\"wait\"");
            then.status(200).json_body(json!({
                "conversation_id": "dm_1",
                "message": {
                    "id": "msg_1",
                    "agent_id": "agent_1",
                    "agent_name": "broker",
                    "text": "hello",
                    "injection_mode": "wait"
                },
                "created_at": "2026-03-23T00:00:00Z"
            }));
        });

        let client = seeded_http_client(&server.base_url());
        client
            .send_dm("worker-a", "hello")
            .await
            .expect("relaycast DM wait send should succeed");
    }
}
