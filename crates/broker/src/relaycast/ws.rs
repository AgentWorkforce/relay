use std::{collections::BTreeSet, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use relaycast::{
    agent::DmOptions, format_registration_error,
    retry_agent_registration as sdk_retry_agent_registration, ActionDefinition, ActionInvocation,
    AgentClient, AgentRegistrationClient, AgentRegistrationError, AgentRegistrationRetryOutcome,
    CompleteInvocationRequest, CreateObserverTokenRequest, EmitSessionEventRequest,
    MessageListQuery, ObserverToken, RegisterActionRequest, RelayCast, RelayCastOptions,
    RelayError, ReleaseAgentRequest, UpdateAgentRequest,
};
use serde_json::Value;

use crate::{fleet_wire::AgentRegistrationMetadata, protocol::MessageInjectionMode};

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

/// HTTP client for publishing messages to the Relaycast REST API.
///
/// Used by the broker to asynchronously forward messages to Relaycast when the
/// target is not a local worker.
#[derive(Clone)]
pub struct RelaycastHttpClient {
    pub base_url: Option<String>,
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
        base_url: Option<String>,
        api_key: impl Into<String>,
        agent_name: impl Into<String>,
        default_cli: impl Into<String>,
    ) -> Self {
        let api_key = api_key.into();
        let default_cli = default_cli.into();
        let relay = Arc::new(build_relay_client(&api_key, base_url.as_deref()));
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

    /// Record a canonical harness event in Relaycast's durable per-agent log.
    pub async fn emit_agent_event(
        &self,
        agent_name: &str,
        event_type: impl Into<String>,
        payload: serde_json::Map<String, Value>,
    ) -> Result<()> {
        let relay = self
            .relay_client()
            .context("Relaycast client is unavailable")?;
        relay
            .emit_agent_event(
                agent_name,
                EmitSessionEventRequest {
                    event_type: event_type.into(),
                    payload: Some(payload),
                },
            )
            .await
            .context("failed to publish agent session event")?;
        Ok(())
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

    /// Publish caller-declared workforce metadata onto an already-registered
    /// agent. The engine merges it over whatever it already holds.
    ///
    /// This is how declared metadata reaches the engine on the node
    /// registration path. It deliberately does NOT ride the `agent.register`
    /// frame: that frame is parsed by a `.strict()` schema which rejects unknown
    /// keys, and the rejection stalls the registration waiter for 30s (see the
    /// note on `fleet_wire::AgentRegister`). The REST agent API has no such
    /// restriction and already accepts a metadata bag, so the observable
    /// outcome is the same over a transport every engine accepts.
    ///
    /// Callers treat this as best-effort: the agent is registered and running
    /// either way, so a failure here must be logged, not fatal.
    pub async fn publish_declared_metadata(
        &self,
        agent_name: &str,
        declared: &AgentRegistrationMetadata,
    ) -> std::result::Result<(), RelaycastRegistrationError> {
        let name = agent_name.trim();
        if name.is_empty() {
            return Err(RelaycastRegistrationError::InvalidAgentName);
        }
        let declared_metadata = declared_metadata_map(declared);
        if declared_metadata.is_empty() {
            return Ok(());
        }
        let relay = self
            .relay_client()
            .ok_or_else(|| RelaycastRegistrationError::Transport {
                agent_name: name.to_string(),
                detail: "SDK relay client not initialized".to_string(),
            })?;
        // Send ONLY the declared keys. `PATCH /v1/agents/:name` merges them over
        // the record's existing metadata server-side — verified in the engine at
        // both the ref fleet-e2e pins (v7.0.0, eb7563ff) and relaycast `main`
        // (`packages/engine/src/routes/agent.ts`:
        // `nextMetadata = { ...existing.metadata, ...body.metadata }`) — so the
        // engine-owned keys, the `fleet` placement record among them, are
        // preserved without us resending them.
        //
        // Reading the record first and writing the merge back from here would be
        // worse than redundant: this call is detached from the spawn, so a write
        // that lands between our read and our write (the node bind, the engine's
        // own placement record) would be clobbered by our stale snapshot.
        relay
            .update_agent(
                name,
                UpdateAgentRequest {
                    metadata: Some(declared_metadata),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| registration_metadata_error(name, error))?;
        Ok(())
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

    /// Authenticate as `agent_name` rather than this broker's own identity.
    ///
    /// **Callers must only pass a name this broker has custodial
    /// responsibility for** (a worker it spawned, or its own identity) —
    /// this is not a safe way to relay an arbitrary, caller-supplied sender
    /// label. Underneath, `AgentRegistrationClient::register_agent_token`
    /// either registers a brand-new Relaycast agent under `agent_name` if
    /// none exists, or — if one already does (409) — ROTATES its token,
    /// invalidating whatever token that agent was already using. Passing an
    /// unvalidated `agent_name` therefore risks silently disconnecting an
    /// unrelated, already-registered agent that happens to share the name.
    /// Validate against known-local names first; fall back to this
    /// broker's own identity (`registered_agent_client`) for anything else.
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

    /// Mint a scoped, read-only observer token for this workspace. Used by
    /// the local HTTP API so callers (e.g. Pear's "Join as observer" link)
    /// can hand out a narrow `ot_live_...` credential instead of the raw
    /// `rk_live_...` workspace key, which grants full read/write/spawn
    /// access. The raw token material is only present on this response (and
    /// on `rotate_observer_token`'s), never on subsequent reads.
    ///
    /// Uses `anyhow::Error::from` (rather than formatting the SDK error into
    /// a fresh string-only error) so callers can `downcast_ref::<RelayError>`
    /// on the returned error to branch on the structured API error code
    /// (e.g. `observer_token_name_conflict`) instead of string-matching the
    /// `Display` output.
    pub async fn create_observer_token(
        &self,
        request: CreateObserverTokenRequest,
    ) -> Result<ObserverToken> {
        let relay = self
            .relay_client()
            .context("SDK relay client not initialized")?;
        relay
            .create_observer_token(request)
            .await
            .map_err(anyhow::Error::from)
    }

    /// List observer tokens for this workspace. Metadata only — no raw token
    /// material is ever included, per the SDK's own doc comment on this
    /// method. Used to recover the id of an existing token by name when
    /// `create_observer_token` fails with `observer_token_name_conflict`.
    pub async fn list_observer_tokens(&self) -> Result<Vec<ObserverToken>> {
        let relay = self
            .relay_client()
            .context("SDK relay client not initialized")?;
        relay
            .list_observer_tokens()
            .await
            .map_err(anyhow::Error::from)
    }

    /// Rotate an observer token, returning fresh raw token material. Used as
    /// a fallback when `create_observer_token` fails with
    /// `observer_token_name_conflict`: since the original raw token was
    /// never persisted anywhere, rotating the existing token under that name
    /// is the only way to hand the caller a usable `ot_live_...` value.
    pub async fn rotate_observer_token(&self, id: &str) -> Result<ObserverToken> {
        let relay = self
            .relay_client()
            .context("SDK relay client not initialized")?;
        relay
            .rotate_observer_token(id)
            .await
            .map_err(anyhow::Error::from)
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
        self.send_dm_with_mode(to, text, MessageInjectionMode::Wait, &self.agent_name)
            .await
    }

    /// Send a direct message with explicit injection mode via the Relaycast REST API.
    ///
    /// `from` is authenticated via [`registered_agent_client_as`] rather than
    /// always posting as this broker's own registered identity, so a DM
    /// forwarded from a locally-attached worker is attributed to that
    /// worker's own Relaycast identity instead of losing sender identity at
    /// the relay boundary. **The caller must validate `from` first** —
    /// see [`registered_agent_client_as`]'s doc comment for why passing an
    /// arbitrary, unvalidated sender label here is unsafe.
    pub async fn send_dm_with_mode(
        &self,
        to: &str,
        text: &str,
        mode: MessageInjectionMode,
        from: &str,
    ) -> Result<()> {
        let agent_client = self.registered_agent_client_as(from, None).await?;
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
                Ok(outcome) => {
                    tracing::info!(
                        channel = %outcome.name,
                        created = outcome.created,
                        joined = outcome.joined,
                        "ensured default channel membership"
                    );
                    mute_self_channel(&agent_client, &outcome.name).await;
                }
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
                Ok(outcome) => {
                    tracing::info!(
                        channel = %outcome.name,
                        created = outcome.created,
                        joined = outcome.joined,
                        "ensured extra channel membership"
                    );
                    mute_self_channel(&agent_client, &outcome.name).await;
                }
                Err(error) => {
                    tracing::warn!(channel = %name, error = %error, "failed to ensure extra channel membership");
                }
            }
        }
        Ok(())
    }

    /// Ensure a spawned worker is a Relaycast member of every channel in its
    /// broker spec. The worker token must already be seeded in the registration
    /// cache; otherwise creating a client for an existing name can rotate that
    /// agent's token (see [`Self::registered_agent_client_as`]).
    pub(crate) async fn ensure_agent_channels(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
        channels: &[crate::ids::ChannelName],
    ) -> Result<()> {
        if channels.is_empty() {
            return Ok(());
        }
        let agent_client = self
            .registered_agent_client_as(agent_name, cli_hint)
            .await
            .with_context(|| {
                format!("failed to authenticate worker '{agent_name}' for channel membership")
            })?;
        let mut seen = BTreeSet::new();
        let mut failures = Vec::new();
        for channel in channels {
            let name = channel.as_str();
            if !seen.insert(name.to_ascii_lowercase()) {
                continue;
            }
            match agent_client
                .ensure_joined_channel(relaycast::CreateChannelRequest {
                    name: name.to_string(),
                    topic: None,
                    metadata: None,
                })
                .await
            {
                Ok(outcome) => {
                    tracing::info!(
                        worker = %agent_name,
                        channel = %outcome.name,
                        created = outcome.created,
                        joined = outcome.joined,
                        "ensured worker channel membership"
                    );
                }
                Err(error) => {
                    tracing::error!(
                        worker = %agent_name,
                        channel = %name,
                        error = %error,
                        "failed to ensure worker channel membership"
                    );
                    failures.push(format!("{name}: {error}"));
                }
            }
        }
        if !failures.is_empty() {
            anyhow::bail!(
                "failed to join worker '{agent_name}' to channels: {}",
                failures.join("; ")
            );
        }
        Ok(())
    }

    /// Reconcile worker-side Relaycast membership when the broker removes
    /// channels from a running worker's spec. Missing memberships are already
    /// in the desired state and are treated as success.
    pub(crate) async fn leave_agent_channels(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
        channels: &[crate::ids::ChannelName],
    ) -> Result<()> {
        if channels.is_empty() {
            return Ok(());
        }
        let agent_client = self
            .registered_agent_client_as(agent_name, cli_hint)
            .await
            .with_context(|| {
                format!("failed to authenticate worker '{agent_name}' for channel membership")
            })?;
        let mut seen = BTreeSet::new();
        let mut failures = Vec::new();
        for channel in channels {
            let name = channel.as_str();
            if !seen.insert(name.to_ascii_lowercase()) {
                continue;
            }
            match agent_client.leave_channel(name).await {
                Ok(())
                | Err(RelayError::Api {
                    status: 404 | 409, ..
                }) => {
                    tracing::info!(
                        worker = %agent_name,
                        channel = %name,
                        "reconciled worker channel removal"
                    );
                }
                Err(error) => {
                    tracing::error!(
                        worker = %agent_name,
                        channel = %name,
                        error = %error,
                        "failed to remove worker channel membership"
                    );
                    failures.push(format!("{name}: {error}"));
                }
            }
        }
        if !failures.is_empty() {
            anyhow::bail!(
                "failed to remove worker '{agent_name}' from channels: {}",
                failures.join("; ")
            );
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
        self.send_with_mode(to, text, MessageInjectionMode::Wait, &self.agent_name, None)
            .await
    }

    /// Smart send with explicit injection mode.
    ///
    /// `from` is authenticated via [`registered_agent_client_as`] (see
    /// [`send_dm_with_mode`]) so the Relaycast-recorded sender matches the
    /// original request's `from` rather than always this broker's own
    /// identity. **The caller must validate `from` first** (a locally-known
    /// worker name or this broker's own identity) — see
    /// [`registered_agent_client_as`]'s doc comment for why an arbitrary,
    /// unvalidated sender label is unsafe to pass here. This is the only
    /// delivery path now (no local-injection bypass), so every send's
    /// sender attribution flows through here.
    ///
    /// `thread_id`, when present, is a Relaycast message id to reply to
    /// (channel targets only — Relaycast DMs have no thread concept): posting
    /// via [`AgentClient::reply`] instead of a plain channel post is what
    /// actually creates real thread/conversation grouping on the Relaycast
    /// side, as opposed to passing an opaque value the server doesn't
    /// interpret as a reply. `reply` takes no injection mode, so a threaded
    /// reply is always delivered with Wait semantics — a `Steer` request with
    /// a `thread_id` is downgraded to a normal reply (logged, not dropped).
    pub async fn send_with_mode(
        &self,
        to: &str,
        text: &str,
        mode: MessageInjectionMode,
        from: &str,
        thread_id: Option<&str>,
    ) -> Result<()> {
        if to.starts_with('#') {
            let agent_client = self.registered_agent_client_as(from, None).await?;
            let relay_mode = match mode {
                MessageInjectionMode::Wait => relaycast::MessageInjectionMode::Wait,
                MessageInjectionMode::Steer => relaycast::MessageInjectionMode::Steer,
            };
            if let Some(thread_id) = thread_id {
                // `AgentClient::reply` has no injection-mode parameter, so a
                // threaded reply is always delivered with Wait semantics.
                // `Steer` can't be honored on a reply; downgrade rather than
                // drop the message, but log it so the loss of steer is visible
                // instead of silent.
                if matches!(mode, MessageInjectionMode::Steer) {
                    tracing::warn!(
                        target = "relay_broker::relaycast",
                        thread_id = %thread_id,
                        "steer injection mode is not supported on threaded replies; delivering as a normal reply"
                    );
                }
                agent_client
                    .reply(thread_id, text, None, None)
                    .await
                    .map_err(|e| anyhow::anyhow!("relaycast thread reply failed: {e}"))?;
            } else {
                agent_client
                    .send_with_mode(to, text, None, None, relay_mode, None)
                    .await
                    .map_err(|e| anyhow::anyhow!("relaycast send_to_channel failed: {e}"))?;
            }
            return Ok(());
        }

        self.send_dm_with_mode(to, text, mode, from).await
    }
}

/// Mute a channel for the broker-self agent, best-effort.
///
/// The broker-self identity lives on an implicit direct node that never
/// connects, so every channel message fanned out to it writes a delivery row
/// that queues forever and churns through TTL expiry. The engine's channel
/// delivery fan-out skips muted members (mentions still deliver), so muting
/// the broker-self membership stops those dead-letter rows at the source.
/// Failures only log a warning — muting is an optimization and must never
/// fail startup.
async fn mute_self_channel(agent_client: &AgentClient, channel: &str) {
    if let Err(error) = agent_client.mute_channel(channel).await {
        tracing::warn!(
            channel = %channel,
            error = %error,
            "failed to mute channel for broker-self agent; channel deliveries will queue for its offline node"
        );
    }
}

/// Build a `RelayCast` workspace client from an API key and optional base URL.
/// When `base_url` is `None`, the SDK applies its own default.
fn build_relay_client(api_key: &str, base_url: Option<&str>) -> Option<RelayCast> {
    let mut opts =
        RelayCastOptions::new(api_key).with_origin_actor(crate::telemetry::BROKER_ORIGIN_ACTOR);
    if let Some(distinct_id) = crate::telemetry::agent_relay_distinct_id() {
        opts = opts.with_agent_relay_distinct_id(distinct_id);
    }
    if let Some(base_url) = base_url {
        opts = opts.with_base_url(base_url);
    }
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

/// The declared fields alone, trimmed, with blanks omitted.
///
/// Omitting rather than sending `""` matters because both callers merge this
/// over metadata the engine already holds: an empty value would overwrite an
/// engine-owned field with nothing.
fn declared_metadata_map(declared: &AgentRegistrationMetadata) -> serde_json::Map<String, Value> {
    let mut metadata = serde_json::Map::new();
    let declared_fields = [
        ("organization", declared.organization.as_deref()),
        ("project", declared.project.as_deref()),
        ("workstream", declared.workstream.as_deref()),
        ("role", declared.role.as_deref()),
        ("objective", declared.objective.as_deref()),
    ];
    for (key, value) in declared_fields {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        metadata.insert(key.to_string(), Value::String(value.to_string()));
    }
    metadata
}

fn registration_metadata_error(agent_name: &str, error: RelayError) -> RelaycastRegistrationError {
    match error {
        RelayError::Api {
            status: 429,
            message,
            code,
        } => RelaycastRegistrationError::RateLimited {
            agent_name: agent_name.to_string(),
            retry_after_secs: 60,
            detail: format!("{message} (code: {code})"),
        },
        RelayError::Api {
            status,
            message,
            code,
        } => RelaycastRegistrationError::Api {
            agent_name: agent_name.to_string(),
            status,
            detail: format!("{message} (code: {code})"),
        },
        error => RelaycastRegistrationError::Transport {
            agent_name: agent_name.to_string(),
            detail: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use httpmock::{
        Method::{GET, PATCH, POST},
        MockServer,
    };
    use relaycast::AgentRegistrationError;
    use serde_json::json;

    use crate::{fleet_wire::AgentRegistrationMetadata, ids::ChannelName};

    use super::{
        format_worker_preregistration_error, registration_is_retryable,
        registration_retry_after_secs, MessageInjectionMode, RelaycastHttpClient,
    };

    fn seeded_http_client(base_url: &str) -> RelaycastHttpClient {
        let client = RelaycastHttpClient::new(
            Some(base_url.to_string()),
            "rk_live_test",
            "broker",
            "codex",
        );
        client.seed_agent_token("broker", "at_live_test");
        client
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

    /// A single PATCH carrying ONLY the declared keys. The engine merges them
    /// over the record's existing metadata, so resending engine-owned keys from
    /// here would be redundant and would risk clobbering a concurrent write with
    /// a stale snapshot. The body is matched exactly, so a stray key — or a
    /// re-introduced read-merge-write — fails here.
    #[tokio::test]
    async fn publish_declared_metadata_sends_only_the_declared_keys() {
        let server = MockServer::start();
        let read = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(500);
        });
        let update = server.mock(|when, then| {
            when.method(PATCH)
                .path("/v1/agents/worker-a")
                .json_body(json!({
                    "metadata": {
                        "organization": "Agent Workforce",
                        "project": "Relay",
                        "objective": "Publish registration metadata"
                    }
                }));
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_worker_a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "online",
                    "persona": null,
                    "metadata": {}
                }
            }));
        });

        let client = seeded_http_client(&server.base_url());
        client
            .publish_declared_metadata(
                "worker-a",
                &AgentRegistrationMetadata {
                    organization: Some("Agent Workforce".to_string()),
                    project: Some("  Relay  ".to_string()),
                    workstream: Some("   ".to_string()),
                    role: None,
                    objective: Some("Publish registration metadata".to_string()),
                },
            )
            .await
            .expect("publishing declared metadata should succeed");

        // No read at all: the merge is the engine's job.
        read.assert_hits(0);
        update.assert_hits(1);
    }

    /// Must-not-fire: nothing declared means no request at all. A spawn that
    /// declares nothing should not pay for a read-modify-write, and must not
    /// rewrite the agent's metadata with what it happens to already hold.
    #[tokio::test]
    async fn publish_declared_metadata_makes_no_request_when_nothing_is_declared() {
        let server = MockServer::start();
        let any_read = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(500);
        });
        let any_write = server.mock(|when, then| {
            when.method(PATCH).path("/v1/agents/worker-a");
            then.status(500);
        });

        let client = seeded_http_client(&server.base_url());
        client
            .publish_declared_metadata(
                "worker-a",
                &AgentRegistrationMetadata {
                    organization: Some(String::new()),
                    project: Some("   ".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("an empty declaration is a no-op, not an error");

        any_read.assert_hits(0);
        any_write.assert_hits(0);
    }

    #[tokio::test]
    async fn emit_agent_event_records_canonical_payload() {
        let server = MockServer::start();
        let publish = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/Worker/events")
                .header("authorization", "Bearer rk_live_test")
                .json_body(json!({
                    "type": "activity.changed",
                    "payload": { "activity": "thinking", "sequence": 7 }
                }));
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "evt_1",
                    "agent_id": "agent_1",
                    "type": "activity.changed",
                    "payload": { "activity": "thinking", "sequence": 7 },
                    "sequence": 7,
                    "created_at": "2026-07-16T00:00:00Z"
                }
            }));
        });
        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
        client
            .emit_agent_event(
                "Worker",
                "activity.changed",
                serde_json::from_value(json!({ "activity": "thinking", "sequence": 7 }))
                    .expect("object payload"),
            )
            .await
            .expect("event should publish");
        publish.assert_hits(1);
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
            when.method(POST).path("/v1/agents");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_fresh_wrong",
                    "workspace_id": "ws_fresh_wrong",
                    "name": "recipient",
                    "status": "online",
                    "created_at": "2026-06-08T10:00:00.000Z",
                    "token": "at_live_fresh_wrong"
                }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
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
    async fn worker_channel_membership_is_reconciled_for_mention_fanout() {
        let server = MockServer::start();
        let create_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/channels")
                .header("authorization", "Bearer at_live_lead")
                .body_contains("\"name\":\"pa-fixes-hardening\"");
            then.status(409).json_body(json!({
                "ok": false,
                "error": {
                    "code": "channel_already_exists",
                    "message": "Channel exists"
                }
            }));
        });
        let join_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/channels/pa-fixes-hardening/join")
                .header("authorization", "Bearer at_live_lead");
            then.status(409).json_body(json!({
                "ok": false,
                "error": {
                    "code": "already_member",
                    "message": "Already joined"
                }
            }));
        });
        let spawn_mock = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(500).json_body(json!({
                "ok": false,
                "error": { "code": "wrong_identity", "message": "must not respawn" }
            }));
        });
        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
        client.seed_agent_token("lead", "at_live_lead");

        client
            .ensure_agent_channels(
                "lead",
                Some("claude"),
                &[ChannelName::from("pa-fixes-hardening")],
            )
            .await
            .expect("worker channel membership should be idempotently reconciled");

        create_mock.assert_hits(1);
        join_mock.assert_hits(1);
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
            .send_with_mode(
                "worker-a",
                "interrupt",
                MessageInjectionMode::Steer,
                "broker",
                None,
            )
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
