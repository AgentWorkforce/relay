use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use anyhow::{Context, Result};
use relaycast::{
    agent::DmOptions, format_registration_error,
    retry_agent_registration as sdk_retry_agent_registration, ActionDefinition, ActionInvocation,
    AgentClient, AgentIdentityRecoveryResponse, AgentRegistrationClient, AgentRegistrationError,
    AgentRegistrationRetryOutcome, CompleteInvocationRequest, CreateObserverTokenRequest,
    EmitSessionEventRequest, MessageListQuery, ObserverToken, RegisterActionRequest, RelayCast,
    RelayCastOptions, RelayError, ReleaseAgentRequest, TakeOverAgentRequest, UpdateAgentRequest,
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
    /// One lock per agent name, guarding collision recovery. Takeover keeps the
    /// same agent id, so `expected_agent_id` cannot stop two concurrent
    /// cache-miss registrations from both taking the name over — the second
    /// response would invalidate the token handed to the first caller.
    takeover_locks: Arc<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    pub agent_name: String,
    pub default_cli: String,
}

pub type RelaycastRegistrationError = AgentRegistrationError;
pub type RegRetryOutcome = AgentRegistrationRetryOutcome;
#[cfg(test)]
pub(crate) use relaycast::registration_is_retryable;
pub(crate) use relaycast::registration_retry_after_secs;

/// Why the broker is asking `register_agent_token` for a token.
///
/// The two intents diverge on how a name-collision-with-a-live-agent is
/// handled: `SpawnNew` rotates (the caller is replacing the process),
/// `ImpersonateExisting` refuses (the caller is not entitled to reclaim an
/// identity whose token it does not hold — rotating would strand the running
/// worker with a dead credential). relay#1545.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterIntent {
    /// Legitimate spawn or restart of a worker process. If the name already
    /// exists, rotate its token — the previous holder is being replaced.
    SpawnNew,
    /// Broker wants to act *as* an existing agent (delivery read-acks,
    /// mark-read on behalf of a worker, background token warm-up). It does
    /// NOT hold the target's token today. If the target is currently live,
    /// rotating would silently invalidate the worker's credential — refuse
    /// rather than reclaim.
    ImpersonateExisting,
}

/// Result of `register_agent_token_with_intent`. Extends the SDK's registration
/// error surface with the `ImpersonateExisting` outcomes: a live target the
/// broker is not entitled to reclaim, an unknown target it cannot impersonate,
/// and a probe that could not decide. Kept separate from
/// `RelaycastRegistrationError` (the retry-loop consumers below reason about
/// the SDK's rate-limit shape and should not have to spell out the new
/// impersonation variants).
#[derive(Debug, thiserror::Error)]
pub enum ImpersonationAwareRegistrationError {
    #[error(transparent)]
    Sdk(#[from] RelaycastRegistrationError),
    #[error(
        "refusing to impersonate live agent '{agent_name}': its own token was not \
         supplied and rotating it would strand the running worker (relay#1545)"
    )]
    LiveAgentImpersonation { agent_name: String },
    #[error("cannot impersonate agent '{agent_name}': no such agent in the workspace")]
    AgentNotFound { agent_name: String },
    #[error("presence probe failed for '{agent_name}': {detail}")]
    ProbeFailed { agent_name: String, detail: String },
    #[error("SDK relay client not initialized")]
    ClientUnavailable,
}

/// A relaycast agent record is "live" if the engine reports its effective
/// status as `active` (equivalently `online` on databases still on the
/// pre-0013 default). Any other status — `offline`, `released`, `inactive` —
/// means no worker is currently authenticating as this name and rotating its
/// token invalidates nothing.
///
/// The engine's `effectiveAgentStatus` derivation folds `AGENT_LIVENESS_TTL_MS`
/// silence into `offline` for us server-side, so a client-side "stale enough"
/// heuristic would double-count and refuse rotations the server would allow.
fn agent_is_live(agent: &relaycast::Agent) -> bool {
    matches!(agent.status.as_str(), "active" | "online")
}

/// The converse of [`agent_is_live`], but deliberately not `!agent_is_live`:
/// only the statuses the engine is known to report for a worker with no live
/// credential are safe to rotate. An unrecognized status is exactly the
/// uncertainty `RegisterIntent::ImpersonateExisting` exists to refuse on, so
/// it must fall through to the fail-closed path rather than being treated as
/// implicitly offline.
fn agent_is_known_offline(agent: &relaycast::Agent) -> bool {
    matches!(agent.status.as_str(), "offline" | "released" | "inactive")
}

/// Bound on the `ImpersonateExisting` presence probe (`relay.get_agent`).
/// Matches the existing `RELAYCAST_HTTP_TIMEOUT` convention for this same
/// call in `auth.rs`'s legacy-identity reclaim path — not chosen for snappy
/// UX, chosen so the call is *guaranteed to return*.
///
/// Without this bound, an engine that hangs the request rather than erroring
/// stalls the caller forever: `send_dm_with_mode`, `send_with_mode`,
/// `ensure_agent_channels`, and `leave_agent_channels` all await
/// `registered_agent_client_as` inline on the request path with no outer
/// timeout of their own. Only `mark_read_as_agent`'s caller
/// (`runtime/delivery.rs`) wraps the whole call in `tokio::spawn` + a 2s
/// `timeout`; this bound is what protects every other call site.
const PRESENCE_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

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
            takeover_locks: Arc::new(StdMutex::new(HashMap::new())),
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
    ///
    /// **Behaviour is `RegisterIntent::SpawnNew`**: a name collision falls
    /// through to a token rotation, which is correct for spawn-time flows
    /// (the previous holder is being replaced). Callers that want to *act as*
    /// an existing agent — impersonation, warm-up preflight — must use
    /// [`Self::register_agent_token_with_intent`] with
    /// [`RegisterIntent::ImpersonateExisting`] instead, or they will
    /// silently invalidate the running worker's credential (relay#1545).
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
        match registration
            .register_agent_token(trimmed_name, cli_hint)
            .await
        {
            Ok(token) => Ok(token),
            // Registration is create-only as of relaycast 8.2.0 / SDK 7.0.0, so
            // a name the broker already owns can no longer be re-registered and
            // rotation is self-rollover the broker cannot perform. The broker
            // holds the workspace key, which makes reclaiming one of its own
            // agents a `takeover` — the explicit, audited operation #349 built
            // for exactly this — rather than the silent identity replacement it
            // removed. Callers that must not seize a live agent go through
            // `register_agent_token_with_intent`, whose presence probe runs
            // first.
            Err(AgentRegistrationError::AlreadyExists { .. }) => {
                self.take_over_agent_identity(trimmed_name, None).await
            }
            Err(other) => Err(other),
        }
    }

    /// Reclaim an agent name this workspace already owns, leaving an audit
    /// record. Used when create-only registration reports the name is taken.
    async fn take_over_agent_identity(
        &self,
        agent_name: &str,
        known_agent_id: Option<&str>,
    ) -> std::result::Result<String, RelaycastRegistrationError> {
        // Singleflight per agent name. Two concurrent cache misses would
        // otherwise both take the name over, and the second response would
        // invalidate the token already returned to the first caller —
        // `expected_agent_id` cannot catch that, because takeover preserves the
        // agent id.
        let lock = {
            let mut locks = self
                .takeover_locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            Arc::clone(
                locks
                    .entry(agent_name.to_string())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        let _guard = lock.lock().await;

        // Re-check after acquiring: a concurrent caller may have completed the
        // takeover while we waited, in which case its token is the live one and
        // taking over again would invalidate it.
        if let Some(registration) = self.registration.as_ref().as_ref() {
            if let Some(cached) = registration.cached_agent_token(agent_name) {
                return Ok(cached);
            }
        }

        let relay =
            (*self.relay)
                .as_ref()
                .ok_or_else(|| RelaycastRegistrationError::Transport {
                    agent_name: agent_name.to_string(),
                    detail: "SDK relay client not initialized".to_string(),
                })?;

        // Callers that already resolved the incumbent (the impersonation
        // presence probe does) pass its id through rather than paying a second
        // lookup on every registration.
        let existing_id = match known_agent_id {
            Some(id) => id.to_string(),
            None => {
                relay
                    .get_agent(agent_name)
                    .await
                    .map_err(|error| RelaycastRegistrationError::Transport {
                        agent_name: agent_name.to_string(),
                        detail: format!("failed to resolve existing agent for takeover: {error}"),
                    })?
                    .id
            }
        };

        let response = match relay
            .take_over_agent(
                agent_name,
                TakeOverAgentRequest {
                    expected_agent_id: existing_id.clone(),
                    actor: self.agent_name.clone(),
                    reason: "broker reclaimed an agent name it owns after create-only registration reported a collision".to_string(),
                    session_ref: existing_id.clone(),
                    node_id: self.agent_name.clone(),
                },
            )
            .await
        {
            Ok(response) => response,
            // Engines before 8.2.0 have no `/takeover` route — the whole
            // identity-recovery surface arrived with it. Those engines still
            // allow the workspace key to rotate an agent's token, which is what
            // this path did before, so fall back rather than stranding every
            // self-hosted deployment that has not upgraded yet.
            //
            // The code, not just the status, decides. 8.2.0 also answers 404
            // with `agent_not_found` when the agent itself is gone (it looks the
            // target up before taking over), and a vanished agent is a real
            // failure that must surface as one — falling back there would send a
            // workspace key at a `requireAgentToken` route and report the 401 as
            // "takeover unavailable on this engine", which is exactly the kind
            // of misdirecting error this whole change exists to remove.
            Err(RelayError::Api { status: 404, ref code, .. })
                if code != "agent_not_found" =>
            {
                let rotated = relay
                    .rotate_agent_token(agent_name, self.api_key.clone())
                    .await
                    .map_err(|error| RelaycastRegistrationError::Transport {
                        agent_name: agent_name.to_string(),
                        detail: format!(
                            "takeover unavailable on this engine and the legacy rotate fallback failed: {error}"
                        ),
                    })?;
                AgentIdentityRecoveryResponse {
                    agent_id: existing_id,
                    name: agent_name.to_string(),
                    token: rotated.token,
                    audit_id: String::new(),
                }
            }
            Err(error) => {
                return Err(RelaycastRegistrationError::Transport {
                    agent_name: agent_name.to_string(),
                    detail: format!("takeover failed: {error}"),
                })
            }
        };

        if response.token.trim().is_empty() {
            return Err(RelaycastRegistrationError::MissingToken {
                agent_name: agent_name.to_string(),
            });
        }

        // Seed the credential the SDK cache would have held had registration
        // succeeded. Without this, the next call re-registers, collides, takes
        // over again and invalidates the token just handed out — and eventually
        // meets the agent this broker itself brought online and refuses to
        // impersonate it.
        self.seed_agent_token(agent_name, &response.token);

        Ok(response.token)
    }

    /// Intent-aware token acquisition. `SpawnNew` preserves the existing
    /// register-or-rotate behaviour; `ImpersonateExisting` first probes the
    /// engine for the target's presence and refuses to rotate when a live
    /// worker is holding the credential. See [`RegisterIntent`] and
    /// [`ImpersonationAwareRegistrationError`] for the semantics this closes
    /// (relay#1545).
    ///
    /// **`SpawnNew` here is not identical to the standalone
    /// [`Self::register_agent_token`] wrapper**: both intents share the cache
    /// fast path below, so `SpawnNew` short-circuits on a cache hit instead
    /// of always consulting the SDK's register-or-rotate. That is
    /// deliberate — a cached token means this broker already holds a valid
    /// credential for the name, so re-registering is wasted network work —
    /// but it means a caller that needs `SpawnNew`'s collision-rotate to run
    /// unconditionally (ignoring whatever this broker has cached) must call
    /// [`Self::forget_agent_registration`] first, or use the standalone
    /// [`Self::register_agent_token`], which never consults the cache. No
    /// caller invokes this method with `SpawnNew` today (`maintenance.rs:569`
    /// and the WS-spawn HTTP fallback both use the standalone wrapper); this
    /// is the contract for the first one that does.
    pub async fn register_agent_token_with_intent(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
        intent: RegisterIntent,
    ) -> std::result::Result<String, ImpersonationAwareRegistrationError> {
        self.register_agent_token_with_intent_and_timeout(
            agent_name,
            cli_hint,
            intent,
            PRESENCE_PROBE_TIMEOUT,
        )
        .await
    }

    /// Test seam for [`Self::register_agent_token_with_intent`]: takes the
    /// presence-probe bound explicitly so tests can exercise the timeout arm
    /// in milliseconds instead of waiting out the real
    /// `PRESENCE_PROBE_TIMEOUT`.
    async fn register_agent_token_with_intent_and_timeout(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
        intent: RegisterIntent,
        probe_timeout: Duration,
    ) -> std::result::Result<String, ImpersonationAwareRegistrationError> {
        let trimmed_name = agent_name.trim();
        let registration = self
            .registration
            .as_ref()
            .as_ref()
            .ok_or(ImpersonationAwareRegistrationError::ClientUnavailable)?;

        // Fast path shared by both intents: an existing cached token is the
        // credential we already handed the worker; hand it back unchanged and
        // avoid a probe entirely. This preserves throughput for warm sessions.
        if let Some(cached) = registration.cached_agent_token(trimmed_name) {
            return Ok(cached);
        }

        match intent {
            // `self.register_agent_token` rather than the SDK directly: it adds
            // the audited takeover fallback that create-only registration now
            // requires when the broker is reclaiming a name it owns.
            RegisterIntent::SpawnNew => self
                .register_agent_token(trimmed_name, cli_hint)
                .await
                .map_err(ImpersonationAwareRegistrationError::Sdk),
            RegisterIntent::ImpersonateExisting => {
                let relay = self
                    .relay_client()
                    .ok_or(ImpersonationAwareRegistrationError::ClientUnavailable)?;
                // Bounded: an engine that hangs this call rather than
                // returning an error must not hang the caller. See
                // `PRESENCE_PROBE_TIMEOUT` for why refusal (not a fallback
                // rotate) is the defined behaviour on expiry.
                match tokio::time::timeout(probe_timeout, relay.get_agent(trimmed_name)).await {
                    Ok(Ok(agent)) if agent_is_live(&agent) => {
                        // The target is holding a working token this broker
                        // does not possess. Silently rotating it would strand
                        // the worker; refuse and let the caller decide.
                        //
                        // This check-then-rotate is not atomic with the
                        // engine: a target that goes live in the gap between
                        // this probe and `register_agent_token` below can
                        // still be rotated. Closing that fully needs a
                        // server-side CAS (probed-status precondition on the
                        // rotate call); today's version is single-round-trip
                        // best-effort, same as the presence probe on the
                        // 404/error arms below. It still closes the actual
                        // relay#1545 defect: a broker with an empty cache
                        // rotating a worker that has been live and idle for
                        // any observable period, which is the case that
                        // stranded workers in practice.
                        Err(
                            ImpersonationAwareRegistrationError::LiveAgentImpersonation {
                                agent_name: trimmed_name.to_string(),
                            },
                        )
                    }
                    Ok(Ok(agent)) if agent_is_known_offline(&agent) => {
                        // Agent exists and is in a status the engine only
                        // uses for a worker with no live credential — no
                        // live token to invalidate, so the SDK's
                        // register-or-rotate path is safe to run.
                        // The probe has established there is no live credential
                        // to strand, which is exactly the condition that makes
                        // an audited takeover safe here. Reuse the agent the
                        // probe already fetched instead of looking it up again.
                        match registration
                            .register_agent_token(trimmed_name, cli_hint)
                            .await
                        {
                            Ok(token) => Ok(token),
                            Err(AgentRegistrationError::AlreadyExists { .. }) => self
                                .take_over_agent_identity(trimmed_name, Some(&agent.id))
                                .await
                                .map_err(ImpersonationAwareRegistrationError::Sdk),
                            Err(other) => Err(ImpersonationAwareRegistrationError::Sdk(other)),
                        }
                    }
                    Ok(Ok(agent)) => {
                        // Neither a known-live nor a known-offline status —
                        // fail closed. Rotating here would fail open on
                        // exactly the uncertainty this intent exists to
                        // refuse on (see the `Err(error)` arm below).
                        Err(ImpersonationAwareRegistrationError::ProbeFailed {
                            agent_name: trimmed_name.to_string(),
                            detail: format!("unrecognized agent status '{}'", agent.status),
                        })
                    }
                    Ok(Err(RelayError::Api { status: 404, .. })) => {
                        // No such agent — impersonation of a non-existent
                        // identity is nonsensical; do not shim it into a
                        // spawn by minting a fresh row.
                        Err(ImpersonationAwareRegistrationError::AgentNotFound {
                            agent_name: trimmed_name.to_string(),
                        })
                    }
                    Ok(Err(error)) => {
                        // We could not decide whether the target is live.
                        // Fail closed: the whole point of this intent is that
                        // we do not rotate on uncertainty.
                        Err(ImpersonationAwareRegistrationError::ProbeFailed {
                            agent_name: trimmed_name.to_string(),
                            detail: error.to_string(),
                        })
                    }
                    Err(_elapsed) => {
                        // The probe never resolved. Fail closed identically
                        // to the `Ok(Err(error))` arm above rather than
                        // proceeding to rotate: an unresolved probe is
                        // uncertainty, and refusing on uncertainty is this
                        // intent's whole contract. What makes this safe
                        // rather than a repeat of relay#1541 (recipient
                        // resolution hanging workspace-wide with every node
                        // healthy) is that the bound above guarantees this
                        // refusal always arrives — a fast, local failure for
                        // one impersonation attempt, not an indefinite hang
                        // that takes the caller hostage.
                        Err(ImpersonationAwareRegistrationError::ProbeFailed {
                            agent_name: trimmed_name.to_string(),
                            detail: format!("presence probe timed out after {probe_timeout:?}"),
                        })
                    }
                }
            }
        }
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
        // Build the client from `register_agent_token` rather than the SDK's
        // `registered_agent_client`, so this path inherits the audited takeover
        // fallback create-only registration now requires. The SDK helper is
        // exactly `register_agent_token` + `as_agent`, so this is the same
        // composition with the collision case handled.
        let token = self
            .register_agent_token(&self.agent_name.clone(), Some(&self.default_cli.clone()))
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        AgentClient::new(token, self.base_url.clone()).map_err(|error| anyhow::anyhow!("{error}"))
    }

    /// Authenticate as `agent_name` rather than this broker's own identity.
    ///
    /// **Callers must only pass a name this broker has custodial
    /// responsibility for** (a worker it spawned, or its own identity).
    ///
    /// Historically this path called `AgentRegistrationClient::register_agent_token`
    /// unconditionally, which registered on a fresh name and — critically —
    /// ROTATED on a name collision, invalidating whatever token that agent
    /// was already using. That silently stranded live workers whose
    /// env-seeded token the broker no longer had cached (broker restart,
    /// process handoff): the next impersonation-side call would rotate them
    /// off (relay#1545).
    ///
    /// This wrapper now routes through
    /// [`Self::register_agent_token_with_intent`] with
    /// [`RegisterIntent::ImpersonateExisting`], which fast-paths on a cache
    /// hit and otherwise refuses to rotate a live agent. Callers see an
    /// error on refusal and are expected to fail closed — the correct
    /// degradation for delivery read-acks and similar side-effects.
    ///
    /// The broker's own identity is exempt from that refusal: `send_dm` and
    /// `send` call this with `from = &self.agent_name` for the broker's own
    /// sends, and the broker holds that credential by definition — it is not
    /// impersonating itself. If the broker's own token fell out of cache
    /// (auth-startup seed failure, a `forget_agent_registration` call), the
    /// presence probe would see the broker as live and refuse, breaking the
    /// broker's own ability to send. Delegate to [`Self::registered_agent_client`]
    /// (`SpawnNew` semantics) instead, exactly as if this were the
    /// unqualified `from`-less send.
    async fn registered_agent_client_as(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
    ) -> Result<AgentClient> {
        if agent_name.trim() == self.agent_name.trim() {
            return self.registered_agent_client().await;
        }
        let relay = self
            .relay_client()
            .context("SDK relay client not initialized")?;
        let token = self
            .register_agent_token_with_intent(
                agent_name,
                cli_hint.or(Some(self.default_cli.as_str())),
                RegisterIntent::ImpersonateExisting,
            )
            .await
            .map_err(anyhow::Error::from)?;
        relay
            .as_agent(token)
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

    /// Mark a specific agent offline without releasing its identity.
    ///
    /// Presence transitions must not use the release endpoint: release rotates
    /// or invalidates the agent credential and records a lifecycle tombstone.
    /// Broker shutdown, worker exit, and maintenance reaping only need to make
    /// the roster honest; the process holding the identity may still be alive
    /// or may restart with the same token.
    pub async fn mark_agent_offline(&self, agent_name: &str) -> Result<()> {
        if let Some(relay) = (*self.relay).as_ref() {
            match relay
                .update_agent(
                    agent_name,
                    UpdateAgentRequest {
                        status: Some("offline".to_string()),
                        ..Default::default()
                    },
                )
                .await
            {
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
        // Deliberately do NOT invalidate the cached registration here: this is
        // a presence-only transition and the process holding the identity may
        // still be alive or may restart with the same token. Invalidating the
        // cache would force a token rotation on next use, disconnecting a
        // still-valid identity. Only an explicit release should do that.
        Ok(())
    }

    /// Release an agent identity through the lifecycle endpoint.
    ///
    /// Unlike a presence transition, an explicit broker release intentionally
    /// invalidates the current credential. Relaycast's wire shape has one audit
    /// string rather than separate reason/actor fields, so preserve both facts
    /// in that durable value and never emit a null-reason release.
    pub async fn release_agent_identity(
        &self,
        agent_name: &str,
        reason: Option<&str>,
    ) -> Result<()> {
        if let Some(relay) = (*self.relay).as_ref() {
            let reason = reason
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .unwrap_or("agent explicitly released through broker API");
            let attributed_reason =
                format!("{reason} (actor: Agent Relay broker {})", self.agent_name);
            let request = ReleaseAgentRequest {
                name: agent_name.to_string(),
                reason: Some(attributed_reason),
                delete_agent: None,
            };
            // Invalidate the cached token before the call so an ambiguous
            // response (e.g. a timeout after Relaycast committed the release)
            // can never leave a dead token cached for reuse. Worst case on
            // failure is a redundant re-registration on next use, which is
            // safe; the alternative — a stale cache reusing a released token
            // — is the bug this fixes.
            self.invalidate_cached_registration(agent_name);
            match relay.release_agent(request).await {
                Ok(_) => {
                    tracing::info!(agent = %agent_name, "released agent identity");
                }
                Err(error) => {
                    tracing::warn!(agent = %agent_name, error = %error, "failed to release agent identity");
                    return Err(anyhow::anyhow!(
                        "failed to release agent '{agent_name}': {error}"
                    ));
                }
            }
        }
        Ok(())
    }

    /// Mark the broker agent offline without invalidating its identity.
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
    use std::time::Duration;

    use crate::{fleet_wire::AgentRegistrationMetadata, ids::ChannelName};

    use super::{
        format_worker_preregistration_error, registration_is_retryable,
        registration_retry_after_secs, ImpersonationAwareRegistrationError, MessageInjectionMode,
        RegisterIntent, RelaycastHttpClient,
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

    /// A presence update used to call POST /v1/agents/release with no reason.
    /// That invalidated the credential of a participant that could still be
    /// running, and left an unattributable `release.reason = null` record. The
    /// exact wire assertion matters here: a successful helper return alone
    /// would not prove the destructive endpoint was avoided.
    #[tokio::test]
    async fn mark_agent_offline_updates_presence_without_releasing_the_identity() {
        let server = MockServer::start();
        let update = server.mock(|when, then| {
            when.method(PATCH)
                .path("/v1/agents/worker-a")
                .header("authorization", "Bearer rk_live_test")
                .json_body(json!({ "status": "offline" }));
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_worker_a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {}
                }
            }));
        });
        let release = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/release");
            then.status(500).json_body(json!({
                "ok": false,
                "error": { "code": "must_not_release", "message": "must not release" }
            }));
        });

        let client = seeded_http_client(&server.base_url());
        client
            .mark_agent_offline("worker-a")
            .await
            .expect("offline presence update should succeed");

        update.assert_hits(1);
        release.assert_hits(0);
    }

    #[tokio::test]
    async fn explicit_agent_release_records_a_reason_and_actor() {
        let server = MockServer::start();
        let release = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/release")
                .header("authorization", "Bearer rk_live_test")
                .json_body(json!({
                    "name": "worker-a",
                    "reason": "agent explicitly released through broker API (actor: Agent Relay broker broker)"
                }));
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "invocation_id": "inv_release_1",
                    "action_name": "release",
                    "handler_agent_id": null,
                    "handler_node_id": "node_1",
                    "dispatched_node_id": "node_1",
                    "input": {
                        "name": "worker-a",
                        "reason": "agent explicitly released through broker API (actor: Agent Relay broker broker)"
                    },
                    "status": "dispatched",
                    "created_at": "2026-08-15T00:00:00.000Z"
                }
            }));
        });

        let client = seeded_http_client(&server.base_url());
        client
            .release_agent_identity("worker-a", None)
            .await
            .expect("explicit release should succeed");

        release.assert_hits(1);
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

    // ---- relay#1545: broker must not rotate a live worker on impersonation --

    /// A cache-empty broker that reaches `register_agent_token_with_intent`
    /// with `ImpersonateExisting` for a live agent MUST NOT rotate the
    /// worker's token. It must refuse with `LiveAgentImpersonation` so the
    /// caller fails closed. This is the exact defect that stranded
    /// broker-seeded worker tokens on any impersonation-side call after a
    /// broker restart.
    ///
    /// **Must-fire**: without the fix, this test hits
    /// `POST /v1/agents/worker-a/takeover` (mounted below with a
    /// deliberate 500 so a rotation would obviously fail the test) and
    /// invalidates the running worker. With the fix, the rotate mock is
    /// never called.
    #[tokio::test]
    async fn impersonate_existing_refuses_to_rotate_a_live_agent() {
        let server = MockServer::start();
        // Presence probe: the worker is currently online.
        let presence = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/worker-a")
                .header("authorization", "Bearer rk_live_test");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_worker_a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "active",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T22:00:00.000Z"
                }
            }));
        });
        // Any rotate attempt fails the test: the fix must not reach here.
        // Wired to 500 so a regression that DOES rotate loudly errors as
        // well, instead of quietly returning a token that the test would
        // then have to explicitly assert against.
        let rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(500).json_body(json!({
                "ok": false,
                "error": { "code": "must_not_rotate", "message": "must not rotate a live agent" }
            }));
        });
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(500).json_body(json!({
                "ok": false,
                "error": { "code": "must_not_register", "message": "must not register" }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
        // No seed for "worker-a" — the broker has no cached token for it,
        // which is exactly the post-restart condition.

        let outcome = client
            .register_agent_token_with_intent(
                "worker-a",
                Some("codex"),
                RegisterIntent::ImpersonateExisting,
            )
            .await;
        assert!(
            matches!(
                outcome,
                Err(ImpersonationAwareRegistrationError::LiveAgentImpersonation { ref agent_name })
                if agent_name == "worker-a"
            ),
            "expected LiveAgentImpersonation refusal, got {:?}",
            outcome,
        );
        presence.assert_hits(1);
        rotate.assert_hits(0);
        register.assert_hits(0);
    }

    /// Must-not-fire: a cached token short-circuits before the presence
    /// probe. This is the throughput path for warm brokers and it must not
    /// pay a round trip on every impersonation.
    #[tokio::test]
    async fn impersonate_existing_returns_cached_token_without_probing() {
        let server = MockServer::start();
        let presence = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(500);
        });
        let rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(500);
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
        client.seed_agent_token("worker-a", "at_live_seeded");

        let token = client
            .register_agent_token_with_intent(
                "worker-a",
                Some("codex"),
                RegisterIntent::ImpersonateExisting,
            )
            .await
            .expect("cache hit must skip the probe and return the cached token");
        assert_eq!(token, "at_live_seeded");
        presence.assert_hits(0);
        rotate.assert_hits(0);
    }

    /// Must-not-fire: an offline agent is safe to rotate — no live worker to
    /// strand. Confirms the fix does not overshoot into blocking the legit
    /// recovery-after-death case (a worker crashed, was marked offline via
    /// `mark_agent_offline`, and the broker is now minting a token so the
    /// restart flow can seed the replacement process).
    #[tokio::test]
    async fn impersonate_existing_rotates_when_target_is_offline() {
        let server = MockServer::start();
        let presence = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_worker_a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T20:00:00.000Z"
                }
            }));
        });
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409).json_body(json!({
                "ok": false,
                "error": { "code": "agent_already_exists", "message": "exists" }
            }));
        });
        let rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(200).json_body(json!({
                "ok": true,
                "data": { "agent_id": "a_worker-a", "name": "worker-a", "token": "at_live_rotated_ok", "audit_id": "aud_1" }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

        let token = client
            .register_agent_token_with_intent(
                "worker-a",
                Some("codex"),
                RegisterIntent::ImpersonateExisting,
            )
            .await
            .expect("offline agent should be safe to rotate");
        assert_eq!(token, "at_live_rotated_ok");
        presence.assert_hits(1);
        register.assert_hits(1);
        rotate.assert_hits(1);
    }

    /// Drive the create-only 409 -> audited takeover path against an engine
    /// whose takeover answers 200 with `token`, then register again. Returns
    /// the first outcome and the number of takeover round trips: a second trip
    /// proves the unusable token was never seeded into the credential cache.
    async fn takeover_returning_token(
        token: serde_json::Value,
    ) -> (std::result::Result<String, AgentRegistrationError>, usize) {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409).json_body(json!({
                "ok": false,
                "error": { "code": "agent_already_exists", "message": "exists" }
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_worker_a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T20:00:00.000Z"
                }
            }));
        });
        let takeover = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "agent_id": "agent_worker_a",
                    "name": "worker-a",
                    "token": token,
                    "audit_id": "aud_blank"
                }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
        let outcome = client.register_agent_token("worker-a", Some("codex")).await;
        let _ = client.register_agent_token("worker-a", Some("codex")).await;
        (outcome, takeover.hits())
    }

    /// **Must-fire**: without the `trim().is_empty()` guard the broker seeds
    /// `response.token` verbatim, so an empty token is worse than an error —
    /// every later call authenticates as `Bearer ` and the engine's 401 points
    /// at auth rather than at the takeover that produced it.
    #[tokio::test]
    async fn takeover_rejects_an_empty_token() {
        let (outcome, takeover_hits) = takeover_returning_token(json!("")).await;
        assert!(
            matches!(
                outcome,
                Err(AgentRegistrationError::MissingToken { ref agent_name })
                if agent_name == "worker-a"
            ),
            "expected MissingToken for an empty takeover token, got {:?}",
            outcome,
        );
        assert_eq!(
            takeover_hits, 2,
            "an empty token must not be seeded into the credential cache"
        );
    }

    /// Spaces are the case a bare `is_empty()` check would wave through.
    #[tokio::test]
    async fn takeover_rejects_a_whitespace_only_token() {
        let (outcome, takeover_hits) = takeover_returning_token(json!("   ")).await;
        assert!(
            matches!(
                outcome,
                Err(AgentRegistrationError::MissingToken { ref agent_name })
                if agent_name == "worker-a"
            ),
            "expected MissingToken for a whitespace-only takeover token, got {:?}",
            outcome,
        );
        assert_eq!(
            takeover_hits, 2,
            "a whitespace-only token must not be seeded into the credential cache"
        );
    }

    /// Tabs and newlines survive JSON round trips that collapse spaces, so
    /// they get their own pin rather than riding on the spaces case.
    #[tokio::test]
    async fn takeover_rejects_a_tab_and_newline_only_token() {
        let (outcome, takeover_hits) = takeover_returning_token(json!("\t\r\n  \n")).await;
        assert!(
            matches!(
                outcome,
                Err(AgentRegistrationError::MissingToken { ref agent_name })
                if agent_name == "worker-a"
            ),
            "expected MissingToken for a tab/newline-only takeover token, got {:?}",
            outcome,
        );
        assert_eq!(
            takeover_hits, 2,
            "a tab/newline-only token must not be seeded into the credential cache"
        );
    }

    /// A `null` token cannot deserialize into the recovery response's
    /// non-optional `token`, so it fails one layer before the blank guard.
    /// Pin that it still fails closed instead of degrading into an empty
    /// credential, and that nothing is cached either.
    #[tokio::test]
    async fn takeover_rejects_a_null_token() {
        let (outcome, takeover_hits) = takeover_returning_token(json!(null)).await;
        assert!(
            outcome.is_err(),
            "a null takeover token must not yield a credential, got {:?}",
            outcome,
        );
        assert_eq!(
            takeover_hits, 2,
            "a null token must not be seeded into the credential cache"
        );
    }

    /// End-to-end must-fire on the actual impersonation entry point: an
    /// impersonating call (e.g. `mark_read_as_agent`) with an empty cache
    /// against a live worker MUST return an error rather than rotate. The
    /// pre-fix behaviour was to silently rotate through
    /// `AgentRegistrationClient::registered_agent_client`, which is what
    /// stranded worker `RELAY_AGENT_TOKEN` values after broker restart.
    ///
    /// Wired at `mark_read_as_agent` — the specific caller chief called out
    /// as the "delivery read-ack" surface. A regression that reintroduces
    /// the rotate would hit the 500 mocked below and fail loudly.
    #[tokio::test]
    async fn mark_read_as_agent_refuses_to_rotate_a_live_worker() {
        let server = MockServer::start();
        // Live-agent presence probe.
        server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_worker_a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "active",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T22:00:00.000Z"
                }
            }));
        });
        // Any rotate is a regression. 500 makes it obvious.
        let rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(500).json_body(json!({
                "ok": false,
                "error": { "code": "must_not_rotate", "message": "must not rotate a live worker" }
            }));
        });
        let mark_read = server.mock(|when, then| {
            // A regression would try to authenticate the mark_read with the
            // freshly rotated at_live_regressed token. Wire a 500 so we can
            // spot it if the flow ever gets past the refusal.
            when.method(POST)
                .path("/v1/messages/msg_1/read")
                .header("authorization", "Bearer at_live_regressed");
            then.status(500);
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
        // No seed for worker-a — the exact post-broker-restart condition.

        let err = client
            .mark_read_as_agent("worker-a", Some("codex"), "msg_1")
            .await
            .expect_err("impersonation of a live worker must not silently succeed");
        assert!(
            err.to_string().contains("worker-a"),
            "error should identify the target worker; got: {err}"
        );
        assert!(
            err.to_string().contains("live") || err.to_string().contains("impersonate"),
            "error should name the refusal reason; got: {err}"
        );
        rotate.assert_hits(0);
        mark_read.assert_hits(0);
    }

    /// Engines before 8.2.0 have no `/takeover`. The broker must fall back to
    /// the legacy workspace-key rotate rather than stranding the agent — this
    /// is the path the fleet e2e exercises, and every self-hosted deployment
    /// that has not upgraded.
    #[tokio::test]
    async fn takeover_falls_back_to_legacy_rotate_on_older_engines() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409).json_body(json!({
                "ok": false,
                "error": { "code": "agent_already_exists", "message": "exists" }
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "a_worker-a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T20:00:00.000Z"
                }
            }));
        });
        // Older engine: the route simply is not there.
        let takeover = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(404).json_body(json!({
                "ok": false,
                "error": { "code": "not_found", "message": "no such route" }
            }));
        });
        // ...and rotate still accepts the workspace key there.
        let legacy_rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/worker-a/rotate-token")
                .header("authorization", "Bearer rk_live_test");
            then.status(200).json_body(json!({
                "ok": true,
                "data": { "name": "worker-a", "token": "at_live_legacy" }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

        let token = client
            .register_agent_token("worker-a", Some("codex"))
            .await
            .expect("an older engine must still be able to reclaim the name");
        assert_eq!(token, "at_live_legacy");
        takeover.assert_hits(1);
        legacy_rotate.assert_hits(1);
    }

    /// A 404 that means "this agent is gone" must NOT be treated as "this
    /// engine is old". Falling back there would send a workspace key at a
    /// `requireAgentToken` route and report the resulting 401 as an engine
    /// capability problem — the misdirecting error this change exists to remove.
    #[tokio::test]
    async fn agent_not_found_does_not_trigger_the_legacy_fallback() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409).json_body(json!({
                "ok": false,
                "error": { "code": "agent_already_exists", "message": "exists" }
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "a_worker-a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T20:00:00.000Z"
                }
            }));
        });
        // Modern engine, but the agent vanished between the lookup and the
        // takeover — 404 with the agent-specific code.
        server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(404).json_body(json!({
                "ok": false,
                "error": { "code": "agent_not_found", "message": "Agent \"worker-a\" not found" }
            }));
        });
        // Must never be reached.
        let legacy_rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/rotate-token");
            then.status(200).json_body(json!({
                "ok": true,
                "data": { "name": "worker-a", "token": "at_live_should_not_be_used" }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

        let error = client
            .register_agent_token("worker-a", Some("codex"))
            .await
            .expect_err("a vanished agent is a real failure, not an old engine");
        let rendered = error.to_string();
        assert!(
            rendered.contains("agent_not_found") || rendered.contains("not found"),
            "the error must name the real cause; got: {rendered}"
        );
        assert!(
            !rendered.contains("takeover unavailable on this engine"),
            "must not be misreported as an engine capability problem; got: {rendered}"
        );
        legacy_rotate.assert_hits(0);
    }

    /// Two concurrent cache-miss registrations for the same name must produce
    /// exactly ONE takeover. Without singleflight both fire, and the second
    /// response invalidates the token already returned to the first caller —
    /// `expected_agent_id` cannot catch it, because takeover preserves the id.
    #[tokio::test]
    async fn concurrent_collisions_take_over_once() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409).json_body(json!({
                "ok": false,
                "error": { "code": "agent_already_exists", "message": "exists" }
            }));
        });
        server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "a_worker-a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T20:00:00.000Z"
                }
            }));
        });
        let takeover = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(200)
                // A slow response widens the window both callers would race in.
                .delay(std::time::Duration::from_millis(150))
                .json_body(json!({
                    "ok": true,
                    "data": { "agent_id": "a_worker-a", "name": "worker-a", "token": "at_live_taken", "audit_id": "aud_1" }
                }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

        let a = client.clone();
        let b = client.clone();
        let (first, second) = tokio::join!(
            async move { a.register_agent_token("worker-a", Some("codex")).await },
            async move { b.register_agent_token("worker-a", Some("codex")).await },
        );

        let first = first.expect("first concurrent caller succeeds");
        let second = second.expect("second concurrent caller succeeds");
        assert_eq!(first, "at_live_taken");
        assert_eq!(
            second, first,
            "both callers must hold the same live token, not one invalidated by the other"
        );
        takeover.assert_hits(1);
    }

    /// A takeover token must land in the registration cache. Without it the
    /// next call re-registers, collides, takes over again, and invalidates the
    /// token just handed out.
    #[tokio::test]
    async fn takeover_seeds_the_registration_cache() {
        let server = MockServer::start();
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409).json_body(json!({
                "ok": false,
                "error": { "code": "agent_already_exists", "message": "exists" }
            }));
        });
        let lookup = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "a_worker-a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T20:00:00.000Z"
                }
            }));
        });
        let takeover = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(200).json_body(json!({
                "ok": true,
                "data": { "agent_id": "a_worker-a", "name": "worker-a", "token": "at_live_taken", "audit_id": "aud_1" }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

        let first = client
            .register_agent_token("worker-a", Some("codex"))
            .await
            .expect("first call takes the name over");
        assert_eq!(first, "at_live_taken");

        let second = client
            .register_agent_token("worker-a", Some("codex"))
            .await
            .expect("second call is served from cache");
        assert_eq!(
            second, "at_live_taken",
            "the token must not be rotated out from under the caller"
        );

        register.assert_hits(1);
        lookup.assert_hits(1);
        takeover.assert_hits(1);
    }

    /// Must-not-fire: the existing `register_agent_token` API keeps its
    /// spawn-time behaviour (register or rotate on collision) so
    /// supervisor-driven worker restart at maintenance.rs:569 continues to
    /// mint a fresh credential the replacement process can use.
    #[tokio::test]
    async fn register_agent_token_still_rotates_on_spawn_intent() {
        let server = MockServer::start();
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409).json_body(json!({
                "ok": false,
                "error": { "code": "agent_already_exists", "message": "exists" }
            }));
        });
        // Takeover resolves the incumbent first so it can pin expected_agent_id.
        let lookup = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "a_worker-a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T20:00:00.000Z"
                }
            }));
        });
        let rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(200).json_body(json!({
                "ok": true,
                "data": { "agent_id": "a_worker-a", "name": "worker-a", "token": "at_live_spawned", "audit_id": "aud_1" }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
        let token = client
            .register_agent_token("worker-a", Some("codex"))
            .await
            .expect("spawn intent must rotate on collision");
        assert_eq!(token, "at_live_spawned");
        register.assert_hits(1);
        lookup.assert_hits(1);
        rotate.assert_hits(1);
    }

    /// Must-not-fire: a presence probe that never resolves must not hang the
    /// caller. The mocked probe delays past the injected bound; the whole
    /// call is wrapped in a much more generous outer timeout so a regression
    /// that drops the inner `tokio::time::timeout` fails this assertion
    /// instead of hanging the test suite. Motivated by chief's review on
    /// relay#1546: `ws.rs`'s `relay.get_agent` had no timeout at all, a
    /// distinct failure mode from `ProbeFailed` (which requires the call to
    /// *return*).
    #[tokio::test]
    async fn impersonate_existing_probe_timeout_does_not_hang_caller() {
        let server = MockServer::start();
        let presence = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200)
                .delay(Duration::from_millis(300))
                .json_body(json!({
                    "ok": true,
                    "data": {
                        "id": "agent_worker_a",
                        "name": "worker-a",
                        "type": "agent",
                        "status": "active",
                        "persona": null,
                        "metadata": {},
                        "last_seen": "2026-08-16T22:00:00.000Z"
                    }
                }));
        });
        let rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(500);
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            client.register_agent_token_with_intent_and_timeout(
                "worker-a",
                Some("codex"),
                RegisterIntent::ImpersonateExisting,
                Duration::from_millis(30),
            ),
        )
        .await
        .expect(
            "a 30ms probe bound against a 300ms-delayed probe must return well within a 5s \
             outer guard; a hang here means the inner timeout regressed",
        );

        assert!(
            matches!(
                outcome,
                Err(ImpersonationAwareRegistrationError::ProbeFailed { ref agent_name, ref detail })
                if agent_name == "worker-a" && detail.contains("timed out")
            ),
            "expected a timed-out ProbeFailed refusal, got {:?}",
            outcome,
        );
        presence.assert_hits(1);
        rotate.assert_hits(0);
    }

    /// Must-fire: an agent status the engine has never been observed to
    /// report (neither the known-live set nor the known-offline set) must
    /// refuse, not rotate. The pre-fix `Ok(_)` arm matched everything that
    /// wasn't live, so an unrecognized status fell through to the
    /// register-or-rotate path — fail-open on exactly the uncertainty this
    /// intent exists to fail closed on.
    #[tokio::test]
    async fn impersonate_existing_refuses_on_unrecognized_status() {
        let server = MockServer::start();
        let presence = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/worker-a");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_worker_a",
                    "name": "worker-a",
                    "type": "agent",
                    "status": "connecting",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T22:00:00.000Z"
                }
            }));
        });
        let rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/worker-a/takeover");
            then.status(500);
        });
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(500);
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");

        let outcome = client
            .register_agent_token_with_intent(
                "worker-a",
                Some("codex"),
                RegisterIntent::ImpersonateExisting,
            )
            .await;
        assert!(
            matches!(
                outcome,
                Err(ImpersonationAwareRegistrationError::ProbeFailed { ref agent_name, ref detail })
                if agent_name == "worker-a" && detail.contains("connecting")
            ),
            "expected a fail-closed ProbeFailed refusal for an unrecognized status, got {:?}",
            outcome,
        );
        presence.assert_hits(1);
        rotate.assert_hits(0);
        register.assert_hits(0);
    }

    /// Must-fire: the broker's own identity is not impersonation. With an
    /// empty cache and the broker itself reporting as live, the old
    /// unconditional `ImpersonateExisting` routing would refuse the broker's
    /// own send; this must instead bypass the presence probe entirely and
    /// go through the same register-or-rotate path as before this PR.
    #[tokio::test]
    async fn registered_agent_client_as_bypasses_impersonation_for_broker_own_identity() {
        let server = MockServer::start();
        // This endpoint now serves two different purposes: the presence probe
        // (which the self-identity bypass must skip) and pinning
        // `expected_agent_id` for an audited takeover (which is legitimate).
        // A hit count alone can no longer tell them apart, so the guarantee is
        // asserted by the call succeeding below: were the bypass to regress,
        // the broker would refuse its own identity as a live-agent
        // impersonation and the `expect` would fail.
        let presence = server.mock(|when, then| {
            when.method(GET).path("/v1/agents/broker");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "a_broker",
                    "name": "broker",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2026-08-16T20:00:00.000Z"
                }
            }));
        });
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409).json_body(json!({
                "ok": false,
                "error": { "code": "agent_already_exists", "message": "exists" }
            }));
        });
        let rotate = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/broker/takeover");
            then.status(200).json_body(json!({
                "ok": true,
                "data": { "agent_id": "a_broker", "name": "broker", "token": "at_live_broker_self", "audit_id": "aud_1" }
            }));
        });

        let client =
            RelaycastHttpClient::new(Some(server.base_url()), "rk_live_test", "broker", "codex");
        // No seed for "broker" — the exact cache-miss condition the finding
        // described (auth-startup seed failure, or a `forget_agent_registration`
        // call against the broker's own name).

        client
            .registered_agent_client_as("broker", None)
            .await
            .expect("broker's own identity must not be refused as a live-agent impersonation");
        // One lookup, for the takeover's expected_agent_id — not a presence
        // probe loop.
        presence.assert_hits(1);
        register.assert_hits(1);
        rotate.assert_hits(1);
    }
}
