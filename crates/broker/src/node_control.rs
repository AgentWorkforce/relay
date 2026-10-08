use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    fs,
    io::Write,
    path::Path,
    sync::OnceLock,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use futures_util::{Sink, SinkExt, StreamExt};
use relaycast::ORIGIN_ACTOR_HEADER;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use uuid::Uuid;

use crate::{
    fleet_wire::{
        ActionResult, ActionResultError, ActionResultPayload, AgentDeregister, AgentRegister,
        BrokerToRelaycast, Deliver, DeliveryAck, FleetCapability, FleetProviderIdentity,
        InventoryAgent, InventorySync, NodeHeartbeat, NodeRegister, RelaycastToBroker,
        FLEET_WIRE_VERSION, LIVE_AGENT_CAPABILITY_NAME,
    },
    protocol::NodeManifest,
    types::RelaycastDeliveryReceipt,
};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(12);
// Relaycast's agent-presence lease expires after five minutes of authenticated
// silence. A node heartbeat renews only the node/provider row, so replay the
// authoritative live-worker inventory well inside that window even when every
// worker is otherwise idle.
const INVENTORY_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// How long `/v1/node/ws` may go without a single inbound frame before the
/// connection is treated as dead.
///
/// Every other disconnect path in this module keys off `send_wire(...)`
/// failing, which only detects a socket the kernel has already torn down. On a
/// blackholed connection the kernel keeps accepting these small frames into the
/// send buffer, so the writes "succeed" indefinitely, no frame ever arrives,
/// and the node silently drops out of the fleet while `/health` still reports
/// `nodeConnected: true`. Each heartbeat tick also sends a WS ping, so a live
/// peer always produces inbound traffic (a pong) even when the engine has
/// nothing to say — making silence past this window unambiguous. Sized at four
/// heartbeat intervals so three consecutive lost pings are tolerated before a
/// reconnect.
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(48);
/// Bound every node-control WebSocket handshake so a half-open TCP/TLS path
/// cannot stall the reconnect loop before it reaches the capped backoff.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Bound each control-plane write. A full send buffer otherwise parks the
/// entire select loop and prevents both transport and application deadlines
/// from being observed.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
const D1_PRESSURE_RETRY_INITIAL_DELAY: Duration = Duration::from_secs(1);
const D1_PRESSURE_RETRY_MAX_DELAY: Duration = Duration::from_secs(8);
const REGISTER_AGENT_PENDING_TTL: Duration = Duration::from_secs(300);
const RELAYCAST_DEFAULT_BASE_URL: &str = "https://cast.agentrelay.com";
const CREATE_NODE_RETRY_BACKOFFS_MS: [u64; 3] = [200, 400, 800];
/// How many consecutive `/v1/node/ws` 401s to tolerate (each triggering a
/// re-mint) before giving up and surfacing a hard error instead of looping.
const MAX_UNAUTHORIZED_BEFORE_GIVING_UP: u32 = 5;

fn d1_pressure_retry_delay(retry_attempts: u32) -> Duration {
    let multiplier = 1u32 << retry_attempts.saturating_sub(1).min(3);
    (D1_PRESSURE_RETRY_INITIAL_DELAY * multiplier).min(D1_PRESSURE_RETRY_MAX_DELAY)
}

/// Whether a fresh re-mint should still be attempted at this consecutive-401
/// count. The count is incremented for the current 401 *before* this is called,
/// so the very first 401 (count 1) is still within budget. Crucially this is
/// independent of whether prior mints succeeded — the loop only resets the count
/// when a connection actually establishes — so N consecutive 401s trip the cap
/// even when every mint succeeds.
fn should_attempt_remint(consecutive_unauthorized: u32) -> bool {
    consecutive_unauthorized <= MAX_UNAUTHORIZED_BEFORE_GIVING_UP
}

#[derive(Clone)]
pub(crate) struct FleetControlConfig {
    pub(crate) ws_url: String,
    pub(crate) node_token: Option<String>,
    pub(crate) node_id: String,
    pub(crate) node_name: String,
    pub(crate) broker_version: String,
    /// Optional facility to re-mint a node token when the engine rejects the
    /// current one with HTTP 401 on the `/v1/node/ws` handshake. Absent in tests
    /// and when no workspace key is available.
    pub(crate) token_minter: Option<NodeTokenMinter>,
    /// Shared handle for the current node token, mirrored to the HTTP session so
    /// providers reading it after a re-mint get the fresh token, not the startup
    /// snapshot. Absent in tests.
    pub(crate) session_token: Option<std::sync::Arc<std::sync::RwLock<Option<String>>>>,
    /// How long the connection may go without an inbound frame before it is
    /// treated as dead. `None` uses [`READ_IDLE_TIMEOUT`]; tests override it so
    /// the blackhole case can be covered without a 48-second wait.
    pub(crate) read_idle_timeout: Option<Duration>,
    /// Introspection sink for the inbound path. Frames are counted here
    /// before deserialization, so a `deliver` the broker cannot parse is
    /// still recorded as having arrived. `None` in tests that do not
    /// assert on the probe.
    pub(crate) probe: Option<std::sync::Arc<crate::node_delivery_probe::NodeDeliveryProbe>>,
    /// Direct terminal-generation publication from the socket reader. This is
    /// deliberately updated before the bounded fleet event queue: readiness on
    /// a replacement terminal lane must fence hints already received from the
    /// wire even when runtime event handling is delayed behind other frames.
    pub(crate) terminal_reconnect_tx: Option<watch::Sender<Option<u64>>>,
}

/// Mints node tokens via `POST /v1/nodes` and maintains the workspace-scoped
/// cache. Held by the node-control client, which uses it both for the initial
/// mint (when no token is cached — see [`NodeTokenMinter::mint`]) and to recover
/// from a stale/rejected cached token (HTTP 401 on the node-control handshake —
/// see [`NodeTokenMinter::remint`]) instead of looping forever on the same token.
#[derive(Clone)]
pub(crate) struct NodeTokenMinter {
    pub(crate) workspace_key: String,
    pub(crate) workspace_id: String,
    pub(crate) base_url: Option<String>,
    pub(crate) node_id: String,
    pub(crate) node_name: String,
    pub(crate) broker_version: String,
    /// Path of the persisted, workspace-scoped token cache (`None` when the data
    /// dir is unavailable; the freshly minted token is still used in memory).
    pub(crate) token_path: Option<std::path::PathBuf>,
    /// Whether a proof conflict may adopt a different token found in the cache.
    /// Disabled when the active token came from `RELAY_NODE_TOKEN`: that override
    /// shadows the cache, whose different value can be arbitrarily old.
    pub(crate) adopt_cached_token_after_conflict: bool,
}

impl NodeTokenMinter {
    /// Mint a fresh node token via `POST /v1/nodes` and persist it to the
    /// workspace-scoped cache. Existing-node rotation sends `current_node_token`
    /// as proof; a genuinely new node is minted with `None`.
    async fn mint(
        &self,
        current_node_token: Option<&str>,
    ) -> std::result::Result<String, CreateNodeMintError> {
        let token = self.mint_with_idempotency(current_node_token, None).await?;
        if let Some(path) = self.token_path.as_deref() {
            if let Err(error) = persist_node_token(
                path,
                &self.node_id,
                &self.workspace_id,
                self.base_url.as_deref(),
                &token,
            ) {
                tracing::warn!(
                    target = "relay_broker::fleet",
                    node_id = %self.node_id,
                    error = %error,
                    "failed to persist minted node token"
                );
            }
        }
        Ok(token)
    }

    async fn mint_with_idempotency(
        &self,
        current_node_token: Option<&str>,
        idempotency_key: Option<&str>,
    ) -> std::result::Result<String, CreateNodeMintError> {
        let request = create_node_request(&self.node_id, &self.node_name, &self.broker_version);
        match mint_node_token(
            &self.workspace_key,
            self.base_url.as_deref(),
            request,
            current_node_token,
            idempotency_key,
            MintNodeTokenLogContext {
                node_id: &self.node_id,
                workspace_id: &self.workspace_id,
            },
        )
        .await
        {
            Ok(token) => {
                tracing::info!(
                    target = "relay_broker::fleet",
                    node_id = %self.node_id,
                    workspace_id = %self.workspace_id,
                    "minted node token via create_node"
                );
                Ok(token)
            }
            Err(error) => {
                log_create_node_mint_error(
                    "relay_broker::fleet",
                    &self.node_id,
                    &self.workspace_id,
                    &error,
                    "failed to mint node token via create_node",
                );
                Err(error)
            }
        }
    }

    /// Prove the cached token and replace it only after Relaycast returns a new
    /// one. On a named proof conflict the caller first checks for a sibling's
    /// newer cached token, then goes terminal if none exists; other failures
    /// fall through to its reconnect backoff. Every failure leaves the last
    /// durable proof on disk so a restart can retry recovery.
    async fn remint(
        &self,
        rejected_token: &str,
    ) -> std::result::Result<String, CreateNodeMintError> {
        let request_digest =
            create_node_request_digest(&self.node_id, &self.node_name, &self.broker_version);
        let preparation = self.token_path.as_deref().map(|path| {
            prepare_node_rotation(
                path,
                &self.node_id,
                &self.workspace_id,
                self.base_url.as_deref(),
                rejected_token,
                &request_digest,
            )
        });
        self.remint_after_preparation(rejected_token, &request_digest, preparation)
            .await
    }

    async fn remint_after_preparation(
        &self,
        rejected_token: &str,
        request_digest: &str,
        preparation: Option<Result<NodeRotationPreparation>>,
    ) -> std::result::Result<String, CreateNodeMintError> {
        let preparation = match preparation {
            Some(Ok(preparation)) => Some(preparation),
            Some(Err(error)) => {
                tracing::warn!(
                    target = "relay_broker::fleet",
                    node_id = %self.node_id,
                    error = %error,
                    "failed to persist node rotation recovery key; retry is process-local and a successful replacement will be persisted best-effort"
                );
                Some(NodeRotationPreparation {
                    idempotency_key: None,
                    expected_cache: self.token_path.as_deref().and_then(|path| {
                        load_scoped_node_token(
                            path,
                            &self.node_id,
                            &self.workspace_id,
                            self.base_url.as_deref(),
                        )
                    }),
                })
            }
            None => None,
        };
        let process_key = preparation
            .as_ref()
            .and_then(|preparation| preparation.idempotency_key.clone())
            .unwrap_or_else(|| {
                process_node_rotation_idempotency_key(
                    &self.node_id,
                    &self.workspace_id,
                    self.base_url.as_deref(),
                    rejected_token,
                    request_digest,
                )
            });
        let minted = self
            .mint_with_idempotency(Some(rejected_token), Some(&process_key))
            .await?;

        let effective = match (self.token_path.as_deref(), preparation.as_ref()) {
            (Some(path), Some(preparation)) => match persist_node_token_after_rotation(
                path,
                &self.node_id,
                &self.workspace_id,
                self.base_url.as_deref(),
                preparation,
                &minted,
            ) {
                Ok(token) => token,
                Err(error) => {
                    tracing::warn!(
                        target = "relay_broker::fleet",
                        node_id = %self.node_id,
                        error = %error,
                        "failed to reconcile minted node token with the durable cache"
                    );
                    minted
                }
            },
            _ => minted,
        };
        clear_process_node_rotation_idempotency_key(
            &self.node_id,
            &self.workspace_id,
            self.base_url.as_deref(),
            rejected_token,
            request_digest,
        );
        Ok(effective)
    }

    /// Re-read the durable cache after a proof conflict. Another broker process
    /// may have won the rotation race while this process's request was in
    /// flight. Only a different token is useful; returning the rejected token
    /// would turn a terminal conflict into an infinite retry loop.
    fn load_different_cached_token(&self, rejected_token: Option<&str>) -> Option<String> {
        if !self.adopt_cached_token_after_conflict {
            return None;
        }
        self.different_cached_token(rejected_token)
    }

    fn env_override_shadows_different_cached_token(&self, rejected_token: Option<&str>) -> bool {
        !self.adopt_cached_token_after_conflict
            && self.different_cached_token(rejected_token).is_some()
    }

    fn different_cached_token(&self, rejected_token: Option<&str>) -> Option<String> {
        let cached = self.token_path.as_deref().and_then(|path| {
            load_node_token(
                path,
                &self.node_id,
                &self.workspace_id,
                self.base_url.as_deref(),
            )
        })?;
        rejected_token
            .is_none_or(|rejected| cached.trim() != rejected.trim())
            .then_some(cached)
    }
}

fn create_node_request_digest(node_id: &str, node_name: &str, broker_version: &str) -> String {
    let request = create_node_request(node_id, node_name, broker_version);
    let body = serde_json::to_vec(&request)
        .expect("CreateNodeRequest contains only infallibly serializable fields");
    format!("sha256:{:x}", Sha256::digest(body))
}

pub(crate) fn create_node_request(
    node_id: &str,
    node_name: &str,
    broker_version: &str,
) -> relaycast::CreateNodeRequest {
    relaycast::CreateNodeRequest {
        node_id: Some(node_id.to_string()),
        name: node_name.to_string(),
        kind: Some("ws".to_string()),
        role: Some("broker".to_string()),
        delivery_adapter: None,
        delivery: None,
        capabilities: None,
        max_agents: None,
        tags: None,
        version: Some(broker_version.to_string()),
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum CreateNodeMintError {
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("create_node returned HTTP {status} ({code}): {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
        body: String,
    },
    #[error("create_node returned invalid HTTP {status} response: {reason}")]
    InvalidResponse {
        status: u16,
        reason: String,
        body: String,
    },
}

impl CreateNodeMintError {
    pub(crate) fn status(&self) -> Option<u16> {
        match self {
            Self::Api { status, .. } | Self::InvalidResponse { status, .. } => Some(*status),
            Self::Http(error) => error.status().map(|status| status.as_u16()),
        }
    }

    pub(crate) fn code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } => Some(code.as_str()),
            _ => None,
        }
    }

    pub(crate) fn response_body(&self) -> Option<&str> {
        match self {
            Self::Api { body, .. } | Self::InvalidResponse { body, .. } => Some(body.as_str()),
            Self::Http(_) => None,
        }
    }
}

fn is_node_token_proof_conflict(error: &CreateNodeMintError) -> bool {
    error.status() == Some(409) && error.code() == Some("node_token_proof_required")
}

pub(crate) struct MintNodeTokenLogContext<'a> {
    pub(crate) node_id: &'a str,
    pub(crate) workspace_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct CreateNodeApiResponse {
    ok: bool,
    data: Option<relaycast::CreateNodeResponse>,
    error: Option<CreateNodeApiError>,
}

#[derive(Debug, Deserialize)]
struct CreateNodeApiError {
    code: String,
    message: String,
}

pub(crate) async fn mint_node_token(
    workspace_key: &str,
    base_url: Option<&str>,
    request: relaycast::CreateNodeRequest,
    current_node_token: Option<&str>,
    idempotency_key: Option<&str>,
    context: MintNodeTokenLogContext<'_>,
) -> std::result::Result<String, CreateNodeMintError> {
    let url = format!(
        "{}/v1/nodes",
        normalized_relaycast_base_url(base_url).trim_end_matches('/')
    );
    let client = reqwest::Client::new();
    let mut last_error: Option<CreateNodeMintError> = None;

    // This loop intentionally runs one more time than there are backoffs: the
    // final iteration returns the last error instead of sleeping again.
    #[allow(clippy::needless_range_loop)]
    for attempt in 0..=CREATE_NODE_RETRY_BACKOFFS_MS.len() {
        let mut builder = client
            .post(&url)
            .bearer_auth(workspace_key)
            .header("X-SDK-Version", crate::util::version::broker_version())
            .header("X-Relaycast-Origin-Client", "agent-relay-broker")
            .header(
                "X-Relaycast-Origin-Version",
                crate::util::version::broker_version(),
            )
            .header(
                "X-Relaycast-Origin-Actor",
                crate::telemetry::BROKER_ORIGIN_ACTOR,
            );
        // Attribute node creation to the signed-in cloud user/org, so relaycast
        // server telemetry can report real users rather than only workspaces.
        for (name, value) in crate::telemetry::cloud_identity_headers() {
            builder = builder.header(name, value);
        }
        if let Some(current_node_token) =
            current_node_token.filter(|token| !token.trim().is_empty())
        {
            builder = builder.header("X-Relaycast-Node-Token", current_node_token);
        }
        if let Some(idempotency_key) = idempotency_key.filter(|key| !key.trim().is_empty()) {
            builder = builder.header("Idempotency-Key", idempotency_key);
        }

        let response = match builder.json(&request).send().await {
            Ok(response) => response,
            Err(error) => {
                let mint_error = CreateNodeMintError::Http(error);
                log_create_node_mint_error(
                    "relay_broker::fleet",
                    context.node_id,
                    context.workspace_id,
                    &mint_error,
                    "create_node mint attempt failed",
                );
                if attempt >= CREATE_NODE_RETRY_BACKOFFS_MS.len() {
                    return Err(mint_error);
                }
                last_error = Some(mint_error);
                tokio::time::sleep(Duration::from_millis(
                    CREATE_NODE_RETRY_BACKOFFS_MS[attempt],
                ))
                .await;
                continue;
            }
        };
        let status = response.status().as_u16();
        let body = match response.text().await {
            Ok(body) => body,
            Err(error) => {
                let mint_error = CreateNodeMintError::Http(error);
                log_create_node_mint_error(
                    "relay_broker::fleet",
                    context.node_id,
                    context.workspace_id,
                    &mint_error,
                    "create_node response body read failed",
                );
                if attempt >= CREATE_NODE_RETRY_BACKOFFS_MS.len() {
                    return Err(mint_error);
                }
                last_error = Some(mint_error);
                tokio::time::sleep(Duration::from_millis(
                    CREATE_NODE_RETRY_BACKOFFS_MS[attempt],
                ))
                .await;
                continue;
            }
        };
        let envelope = serde_json::from_str::<CreateNodeApiResponse>(&body).map_err(|error| {
            CreateNodeMintError::InvalidResponse {
                status,
                reason: format!("failed to parse JSON: {error}"),
                body: body.clone(),
            }
        })?;

        if envelope.ok {
            let token = envelope
                .data
                .ok_or_else(|| CreateNodeMintError::InvalidResponse {
                    status,
                    reason: "response missing data field".to_string(),
                    body: body.clone(),
                })?
                .token
                .trim()
                .to_string();
            if token.is_empty() {
                return Err(CreateNodeMintError::InvalidResponse {
                    status,
                    reason: "response returned an empty token".to_string(),
                    body,
                });
            }
            return Ok(token);
        }

        let error = envelope.error.unwrap_or(CreateNodeApiError {
            code: "unknown_error".to_string(),
            message: "Unknown error".to_string(),
        });
        let mint_error = CreateNodeMintError::Api {
            status,
            code: error.code,
            message: error.message,
            body,
        };
        log_create_node_mint_error(
            "relay_broker::fleet",
            context.node_id,
            context.workspace_id,
            &mint_error,
            "create_node mint attempt failed",
        );

        if !(500..=599).contains(&status) || attempt >= CREATE_NODE_RETRY_BACKOFFS_MS.len() {
            return Err(mint_error);
        }
        last_error = Some(mint_error);
        tokio::time::sleep(Duration::from_millis(
            CREATE_NODE_RETRY_BACKOFFS_MS[attempt],
        ))
        .await;
    }

    Err(
        last_error.unwrap_or_else(|| CreateNodeMintError::InvalidResponse {
            status: 0,
            reason: "create_node retry loop exhausted without a response".to_string(),
            body: String::new(),
        }),
    )
}

pub(crate) fn log_create_node_mint_error(
    target: &'static str,
    node_id: &str,
    workspace_id: &str,
    error: &CreateNodeMintError,
    message: &'static str,
) {
    let status = error.status();
    let code = error.code();
    let response_body = error.response_body().map(redact_relaycast_secrets);
    tracing::warn!(
        target = target,
        node_id = %node_id,
        workspace_id = %workspace_id,
        http_status = ?status,
        error_code = ?code,
        response_body = ?response_body,
        error = %error,
        "{message}"
    );
}

fn normalized_relaycast_base_url(base_url: Option<&str>) -> String {
    base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(RELAYCAST_DEFAULT_BASE_URL)
        .to_string()
}

fn redact_relaycast_secrets(input: &str) -> String {
    static BEARER_SECRET_RE: OnceLock<regex::Regex> = OnceLock::new();
    static TOKEN_FIELD_RE: OnceLock<regex::Regex> = OnceLock::new();

    let mut redacted = input.to_string();
    let bearer_re = BEARER_SECRET_RE.get_or_init(|| {
        regex::Regex::new(r#"(rk_live_|at_live_|nt_live_|br_|Bearer\s+)[A-Za-z0-9._-]+"#)
            .expect("bearer secret redaction regex must compile")
    });
    redacted = bearer_re
        .replace_all(&redacted, "${1}[REDACTED]")
        .into_owned();

    let token_field_re = TOKEN_FIELD_RE.get_or_init(|| {
        regex::Regex::new(r#""token"\s*:\s*"[^"]+""#)
            .expect("token field redaction regex must compile")
    });
    redacted = token_field_re
        .replace_all(&redacted, r#""token":"[REDACTED]""#)
        .into_owned();
    redacted
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FleetLoadSnapshot {
    pub(crate) active_agents: u32,
    pub(crate) max_agents: u32,
    pub(crate) handlers_live: bool,
    pub(crate) active_agent_names: Vec<String>,
}

impl FleetLoadSnapshot {
    /// Build a heartbeat carrying the live load/liveness, the broker-owned
    /// WorkerName set, AND the node roster snapshot
    /// (name/node_id/capabilities/version) so the relaycast engine can
    /// keep this node's descriptor fresh from the steady-state heartbeat without
    /// a fresh `node.register`.
    ///
    /// `max_agents` is sourced from `self` (the FleetLoadSnapshot), which is the
    /// single authoritative live capacity: it is the same denominator used for
    /// the `load` ratio, and it is kept in lockstep with `node.register` because
    /// `RegisterNode`/`UpdateLoad` commands set `load.max_agents` from the same
    /// manifest the register frame is built from (see `run_connected_once`). The
    /// remaining roster fields are immutable identity/descriptor data carried on
    /// the active `NodeRegister`. This guarantees load and max_agents in one
    /// heartbeat never diverge.
    ///
    /// `last_heartbeat_at` is intentionally NOT set — the engine stamps receipt
    /// time server-side as the single source of truth for liveness.
    fn heartbeat(&self, node: &NodeRegister) -> NodeHeartbeat {
        let load = if self.max_agents == 0 {
            // Relaycast releases before relaycast#307 require a numeric load.
            // Keep emitting the legacy value until the engine accepts an
            // omitted/null load; otherwise it rejects the whole heartbeat and
            // loses the authoritative active_agents and liveness updates too.
            Some(0.0)
        } else {
            Some((self.active_agents as f64 / self.max_agents as f64).clamp(0.0, 1.0))
        };
        let mut capabilities: Vec<_> = node
            .capabilities
            .iter()
            .filter(|capability| capability.name != LIVE_AGENT_CAPABILITY_NAME)
            .cloned()
            .collect();
        let mut active_agent_names = self.active_agent_names.clone();
        active_agent_names.sort();
        active_agent_names.dedup();
        capabilities.push(FleetCapability {
            execution_mode: None,
            name: LIVE_AGENT_CAPABILITY_NAME.to_string(),
            kind: Some("capacity".to_string()),
            global: None,
            queue: None,
            metadata: Some(BTreeMap::from([(
                "names".to_string(),
                serde_json::Value::Array(
                    active_agent_names
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect(),
                ),
            )])),
        });
        NodeHeartbeat {
            v: FLEET_WIRE_VERSION,
            id: None,
            provider: node.provider.clone(),
            name: node.name.clone(),
            node_id: node.node_id.clone(),
            capabilities,
            max_agents: self.max_agents,
            version: node.version.clone(),
            load,
            active_agents: self.active_agents,
            handlers_live: self.handlers_live,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentRegistrationToken {
    pub(crate) name: String,
    pub(crate) agent_id: String,
    pub(crate) token: String,
    pub(crate) delivery_ack_seq: Option<u64>,
}

#[derive(Debug)]
struct PendingAgentRegistration {
    isolates_channels: bool,
    name: String,
    reply: oneshot::Sender<Result<AgentRegistrationToken, String>>,
    created_at: Instant,
}

#[derive(Debug)]
pub(crate) enum FleetControlCommand {
    RegisterNode {
        manifest: NodeManifest,
        resume_cursor: Option<String>,
    },
    UpdateInventory(Vec<InventoryAgent>),
    UpdateLoad(FleetLoadSnapshot),
    HeartbeatNow,
    Send(BrokerToRelaycast),
    RetainedSend(RetainedFleetCompletion),
    DeregisterAgent {
        request: AgentDeregister,
        reply: oneshot::Sender<Result<(), String>>,
    },
    RegisterAgent {
        request: AgentRegister,
        reply: oneshot::Sender<Result<AgentRegistrationToken, String>>,
    },
    Shutdown,
}

#[derive(Debug)]
pub(crate) struct RetainedFleetCompletion {
    pub(crate) message: BrokerToRelaycast,
    pub(crate) delivered: oneshot::Sender<()>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum FleetControlEvent {
    Connected,
    Disconnected,
    Message(RelaycastToBroker),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeliveryDecision {
    Deliver { up_to_seq: u64 },
    Duplicate { up_to_seq: u64 },
    ReplayConflict,
    Stale { up_to_seq: u64 },
    Gap { up_to_seq: u64 },
    IdentityReject,
}

/// Per-agent set of recently-seen `msg_id`s, capped at a fixed size with FIFO
/// eviction. Bounds memory: without this, the dedup set grows unbounded for the
/// lifetime of a long-lived agent. `seq:0` fan-out frames (reactions, read
/// receipts, action results) all share seq 0, so `msg_id`-based dedup is the
/// only duplicate-suppression mechanism available for them; the cap is generous
/// enough that legitimate same-frame retries are still recognized.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct SeenMsgIds {
    deliveries: HashMap<String, (String, u64)>,
    order: VecDeque<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeenMsgIdMatch {
    Unseen,
    Exact,
    Conflict,
}

impl SeenMsgIds {
    const CAPACITY: usize = 512;

    fn classify(&self, msg_id: &str, delivery_id: &str, seq: u64) -> SeenMsgIdMatch {
        match self.deliveries.get(msg_id) {
            None => SeenMsgIdMatch::Unseen,
            Some((seen_delivery_id, seen_seq))
                if seen_delivery_id == delivery_id && *seen_seq == seq =>
            {
                SeenMsgIdMatch::Exact
            }
            Some(_) => SeenMsgIdMatch::Conflict,
        }
    }

    fn insert(&mut self, msg_id: &str, delivery_id: &str, seq: u64) {
        if self.deliveries.contains_key(msg_id) {
            return;
        }
        if self.order.len() >= Self::CAPACITY {
            if let Some(evicted) = self.order.pop_front() {
                self.deliveries.remove(&evicted);
            }
        }
        self.deliveries
            .insert(msg_id.to_string(), (delivery_id.to_string(), seq));
        self.order.push_back(msg_id.to_string());
    }
}

/// Why a parked receipt can never advance the cumulative ACK cursor.
/// Carried through so the flush can log which of the two seams orphaned it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OrphanedReceiptReason {
    /// The `agent_id` the receipt was stamped with has been retired by a
    /// later authoritative binding for the same name.
    IdentityRetired,
    /// The cursor for that identity has already moved at or past this
    /// sequence (typically a resume handshake's `seed_cursor`).
    CursorMovedPast,
}

impl OrphanedReceiptReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            OrphanedReceiptReason::IdentityRetired => "identity_retired",
            OrphanedReceiptReason::CursorMovedPast => "cursor_moved_past",
        }
    }
}

/// What a parked delivery's receipt can still do to the ACK cursor.
/// See [`FleetDeliveryBook::receipt_ackability`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReceiptAckability {
    /// This receipt is the next ACKable sequence: inject it, then ACK it.
    Ready,
    /// A lower sequence is still outstanding, or this one is ahead of the
    /// received frontier. Holding the queue is correct — a later ACK clears it.
    Blocked,
    /// No ACK can ever be committed for this receipt. The message must still
    /// be delivered, but it carries no ACK, so Relaycast keeps ownership of
    /// the frame and its own redelivery policy is untouched.
    Orphaned { reason: OrphanedReceiptReason },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct AgentDeliveryCursor {
    agent_name: String,
    acked_up_to_seq: u64,
    received_up_to_seq: u64,
    seen_msg_ids: SeenMsgIds,
    /// Worker-confirmed sequenced deliveries that cannot advance the
    /// cumulative ACK yet because a lower sequence is still unconfirmed.
    /// Kept on the per-agent cursor so confirmations can be released in order
    /// without letting one agent block another.
    confirmed_delivery_seqs: BTreeMap<u64, ()>,
    /// Whether a sequenced (`seq >= 1`) position has been established for this
    /// identity, either by a resume handshake seeding the cursor or by adopting
    /// the first sequenced delivery. Tracked separately from the cursor's
    /// existence because `seq:0` fan-out (reactions, receipts, action results)
    /// creates a cursor at zero without establishing any position — without
    /// this flag a single seq-0 frame would make the following resumed frame
    /// look like a gap and leave a respawned agent deaf.
    has_sequenced_position: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveAgentBinding {
    agent_id: String,
    authoritative: bool,
}

/// Bookkeeping flag that never participates in equality.
///
/// The book derives `PartialEq` and tests assert things like "identity
/// rejection must not mutate state" by comparing a book against a snapshot.
/// Whether a cursor publish is still pending is not part of the book's
/// identity, so it must not make those assertions pass or fail.
#[derive(Debug, Default, Clone, Eq)]
pub(crate) struct CursorDirtyFlag(bool);

impl PartialEq for CursorDirtyFlag {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct FleetDeliveryBook {
    /// Set by every mutator, cleared by the runtime once it has republished
    /// the cursor snapshot. See [`FleetDeliveryBook::take_cursor_dirty`].
    dirty: CursorDirtyFlag,
    agents: HashMap<String, AgentDeliveryCursor>,
    active_agent_bindings_by_name: HashMap<String, ActiveAgentBinding>,
    active_agent_names_by_id: HashMap<String, String>,
    retired_agent_names_by_id: HashMap<String, String>,
    retired_agent_id_order: VecDeque<String>,
}

impl FleetDeliveryBook {
    const RETIRED_AGENT_ID_CAPACITY: usize = 512;

    fn forget_retired_identity(&mut self, agent_id: &str) {
        self.mark_cursors_dirty();
        if self.retired_agent_names_by_id.remove(agent_id).is_some() {
            self.retired_agent_id_order
                .retain(|retired_id| retired_id != agent_id);
        }
    }

    fn retire_identity(&mut self, agent_id: String, agent_name: String) {
        self.mark_cursors_dirty();
        self.forget_retired_identity(&agent_id);
        while self.retired_agent_id_order.len() >= Self::RETIRED_AGENT_ID_CAPACITY {
            if let Some(evicted) = self.retired_agent_id_order.pop_front() {
                self.retired_agent_names_by_id.remove(&evicted);
            }
        }
        self.retired_agent_names_by_id
            .insert(agent_id.clone(), agent_name);
        self.retired_agent_id_order.push_back(agent_id);
    }

    fn nonauthoritative_binding_conflicts(&self, agent: &str, agent_id: &str) -> bool {
        self.active_agent_bindings_by_name
            .get(agent)
            .is_some_and(|binding| binding.authoritative && binding.agent_id != agent_id)
            || self
                .active_agent_names_by_id
                .get(agent_id)
                .is_some_and(|active_name| active_name != agent)
            || self.retired_agent_names_by_id.contains_key(agent_id)
    }

    fn bind_identity(&mut self, agent: &str, agent_id: &str, authoritative: bool) -> bool {
        self.mark_cursors_dirty();
        if !authoritative && self.nonauthoritative_binding_conflicts(agent, agent_id) {
            return false;
        }

        self.forget_retired_identity(agent_id);

        if let Some(previous_name) = self
            .active_agent_names_by_id
            .get(agent_id)
            .filter(|previous_name| previous_name.as_str() != agent)
            .cloned()
        {
            if self
                .active_agent_bindings_by_name
                .get(&previous_name)
                .is_some_and(|binding| binding.agent_id == agent_id)
            {
                self.active_agent_bindings_by_name.remove(&previous_name);
            }
            self.active_agent_names_by_id.remove(agent_id);
            if let Some(cursor) = self.agents.get_mut(agent_id) {
                cursor.agent_name = agent.to_string();
            }
        }

        if let Some(existing) = self.active_agent_bindings_by_name.get_mut(agent) {
            if existing.agent_id == agent_id {
                existing.authoritative |= authoritative;
                self.active_agent_names_by_id
                    .insert(agent_id.to_string(), agent.to_string());
                return true;
            }
        }

        if let Some(previous) = self.active_agent_bindings_by_name.remove(agent) {
            self.active_agent_names_by_id.remove(&previous.agent_id);
            self.agents.remove(&previous.agent_id);
            self.retire_identity(previous.agent_id, agent.to_string());
        }

        self.active_agent_bindings_by_name.insert(
            agent.to_string(),
            ActiveAgentBinding {
                agent_id: agent_id.to_string(),
                authoritative,
            },
        );
        self.active_agent_names_by_id
            .insert(agent_id.to_string(), agent.to_string());
        true
    }

    /// Bind a name to the immutable identity confirmed by `agent.register`.
    pub(crate) fn bind_authoritative_identity(
        &mut self,
        agent: impl Into<String>,
        agent_id: impl Into<String>,
    ) {
        self.mark_cursors_dirty();
        let agent = agent.into();
        let agent_id = agent_id.into();
        self.bind_identity(&agent, &agent_id, true);
    }

    /// Return the immutable identity currently bound to an agent name.
    ///
    /// Release paths need this before pruning the delivery book so they can
    /// send an ordered `agent.deregister` frame to the fleet control plane.
    pub(crate) fn active_agent_id(&self, agent: &str) -> Option<&str> {
        self.active_agent_bindings_by_name
            .get(agent)
            .filter(|binding| binding.authoritative)
            .map(|binding| binding.agent_id.as_str())
    }

    /// Seed Relaycast's cumulative cursor after identity authority is bound.
    ///
    /// The immutable `agent_id` is the key: a later agent reusing the same name
    /// must not inherit the old identity's cumulative ACK position. The seeded
    /// cursor initializes `received == acked` at Relaycast's authoritative
    /// position.
    pub(crate) fn seed_cursor(
        &mut self,
        agent: impl Into<String>,
        agent_id: impl Into<String>,
        up_to_seq: u64,
    ) {
        self.mark_cursors_dirty();
        let agent = agent.into();
        let agent_id = agent_id.into();
        debug_assert!(self
            .active_agent_bindings_by_name
            .get(&agent)
            .is_some_and(|binding| binding.agent_id == agent_id));
        self.agents.insert(
            agent_id,
            AgentDeliveryCursor {
                agent_name: agent,
                acked_up_to_seq: up_to_seq,
                received_up_to_seq: up_to_seq,
                seen_msg_ids: SeenMsgIds::default(),
                confirmed_delivery_seqs: BTreeMap::new(),
                has_sequenced_position: true,
            },
        );
    }

    /// Reconstruct the received cursor for a post-restart agent from the
    /// withheld fleet deliveries that survived in the pending snapshot.
    ///
    /// The persisted ACK floor establishes the first still-required sequence,
    /// even when that lower delivery has already left the pending map after a
    /// terminal failure. Replaying the remaining snapshot in sequence order
    /// then restores as much of the received frontier as is contiguous. A live
    /// cursor learned from normal delivery or a resume handshake is never
    /// rewound; pending siblings can only extend its received frontier.
    pub(crate) fn restore_pending_agent(
        &mut self,
        deliveries: &[&Deliver],
        ack_floor: Option<u64>,
    ) {
        self.mark_cursors_dirty();
        let mut sequenced = deliveries
            .iter()
            .copied()
            .filter(|deliver| deliver.seq > 0)
            .collect::<Vec<_>>();
        sequenced.sort_by_key(|deliver| deliver.seq);
        let Some(first) = sequenced.first().copied() else {
            return;
        };
        let has_sequenced_position = self
            .agents
            .get(first.agent_id.as_str())
            .is_some_and(|cursor| cursor.has_sequenced_position);
        if !has_sequenced_position {
            if !self.bind_identity(&first.agent, &first.agent_id, false) {
                return;
            }
            let first_required_seq = ack_floor.unwrap_or(first.seq).min(first.seq);
            self.seed_cursor(
                first.agent.clone(),
                first.agent_id.clone(),
                first_required_seq.saturating_sub(1),
            );
        }
        for deliver in sequenced {
            self.commit_received(deliver);
        }
    }

    fn active_up_to_seq(&self, agent: &str) -> u64 {
        self.active_agent_bindings_by_name
            .get(agent)
            .and_then(|binding| self.agents.get(&binding.agent_id))
            .map_or(0, |cursor| cursor.acked_up_to_seq)
    }

    pub(crate) fn observe(&self, deliver: &Deliver) -> DeliveryDecision {
        if self
            .active_agent_names_by_id
            .get(&deliver.agent_id)
            .is_some_and(|active_name| active_name != &deliver.agent)
        {
            return DeliveryDecision::IdentityReject;
        }

        if let Some(retired_name) = self.retired_agent_names_by_id.get(&deliver.agent_id) {
            if retired_name != &deliver.agent {
                return DeliveryDecision::IdentityReject;
            }
            return DeliveryDecision::Stale {
                up_to_seq: self.active_up_to_seq(&deliver.agent),
            };
        }

        if self
            .active_agent_bindings_by_name
            .get(&deliver.agent)
            .is_some_and(|binding| binding.authoritative && binding.agent_id != deliver.agent_id)
        {
            return DeliveryDecision::IdentityReject;
        }

        let cursor = self.agents.get(&deliver.agent_id);
        if cursor.is_some_and(|cursor| cursor.agent_name != deliver.agent) {
            return DeliveryDecision::IdentityReject;
        }

        // `seq:0` is the engine's fan-out family (reactions, read receipts, and
        // action.completed/action.failed/action.denied results delivered to the
        // caller). These share seq 0, so they bypass the monotonic-sequence gate
        // and are always surfaced-and-acked, with `msg_id` as the only duplicate
        // suppression. The cumulative ack reports the current cursor (the engine
        // ack is monotonic, so re-acking up_to_seq for a seq-0 frame is a no-op).
        if deliver.seq == 0 {
            if let Some(cursor) = cursor {
                match cursor.seen_msg_ids.classify(
                    &deliver.msg_id,
                    &deliver.delivery_id,
                    deliver.seq,
                ) {
                    SeenMsgIdMatch::Exact => {
                        return DeliveryDecision::Duplicate {
                            up_to_seq: cursor.acked_up_to_seq,
                        };
                    }
                    SeenMsgIdMatch::Conflict => return DeliveryDecision::ReplayConflict,
                    SeenMsgIdMatch::Unseen => {}
                }
                return DeliveryDecision::Deliver {
                    up_to_seq: cursor.acked_up_to_seq,
                };
            }
            return DeliveryDecision::Deliver { up_to_seq: 0 };
        }
        // No sequenced position for this identity yet — either no cursor at all,
        // or one created by `seq:0` fan-out, which never establishes a position.
        // For an identity `agent.register` confirmed, that is the absence of a
        // position rather than evidence of a gap: a release drops the cursor,
        // and a respawn rebinds the same agent record, whose engine-side
        // sequence keeps counting from where it left off (the engine reuses
        // agent ids, and only seeds a cursor when it negotiates
        // `relay:delivery-cursor-v1`). Treating that as a gap withholds the ack
        // and surfaces nothing — see `plan_fleet_delivery` — leaving the broker
        // waiting for a predecessor frame that was never sent, so this identity
        // would gap every subsequent delivery and the agent would stay deaf.
        // Adopt this delivery as the starting position; `commit_received` seeds
        // the cursor to match. A provisional binding gets no such benefit of the
        // doubt: a second, unconfirmed identity claiming a live name must not be
        // able to jump in mid-sequence.
        let cursor = match cursor {
            Some(cursor) if cursor.has_sequenced_position => cursor,
            awaiting => {
                let acked_up_to_seq = awaiting.map_or(0, |cursor| cursor.acked_up_to_seq);
                if let Some(cursor) = awaiting {
                    match cursor.seen_msg_ids.classify(
                        &deliver.msg_id,
                        &deliver.delivery_id,
                        deliver.seq,
                    ) {
                        SeenMsgIdMatch::Exact => {
                            return DeliveryDecision::Duplicate {
                                up_to_seq: acked_up_to_seq,
                            };
                        }
                        SeenMsgIdMatch::Conflict => return DeliveryDecision::ReplayConflict,
                        SeenMsgIdMatch::Unseen => {}
                    }
                }
                let authoritative = self
                    .active_agent_bindings_by_name
                    .get(&deliver.agent)
                    .is_some_and(|binding| binding.authoritative);
                return if deliver.seq == 1 || authoritative {
                    DeliveryDecision::Deliver {
                        up_to_seq: deliver.seq,
                    }
                } else {
                    DeliveryDecision::Gap {
                        up_to_seq: acked_up_to_seq,
                    }
                };
            }
        };
        match cursor
            .seen_msg_ids
            .classify(&deliver.msg_id, &deliver.delivery_id, deliver.seq)
        {
            SeenMsgIdMatch::Exact => {
                return DeliveryDecision::Duplicate {
                    up_to_seq: cursor.acked_up_to_seq,
                };
            }
            SeenMsgIdMatch::Conflict => return DeliveryDecision::ReplayConflict,
            SeenMsgIdMatch::Unseen => {}
        }

        if deliver.seq <= cursor.received_up_to_seq {
            return DeliveryDecision::Stale {
                up_to_seq: cursor.acked_up_to_seq,
            };
        }

        if deliver.seq != cursor.received_up_to_seq.saturating_add(1) {
            // A forward hole. Report it and let the caller withhold the ACK
            // (see `plan_fleet_delivery`): the cursor deliberately stays put,
            // so when the engine redelivers the frame that actually went
            // missing it is accepted and the sequence becomes contiguous
            // again. ACKing here would report progress this broker has not
            // made for a message the agent never saw.
            return DeliveryDecision::Gap {
                up_to_seq: cursor.acked_up_to_seq,
            };
        }

        DeliveryDecision::Deliver {
            up_to_seq: deliver.seq,
        }
    }

    /// Export the per-identity cursors for introspection.
    ///
    /// Until this existed the delivery book was entirely opaque at runtime:
    /// nothing in the broker could say what sequence an agent was acked to, so
    /// a silent agent could not be told apart from one whose cursor had been
    /// retired underneath it. Ordered by name to keep the endpoint's output
    /// stable between reads.
    /// Mark the cursor snapshot stale. Called by every mutator; the runtime
    /// drains this once per event-loop turn.
    fn mark_cursors_dirty(&mut self) {
        self.dirty.0 = true;
    }

    /// Consume the pending-publish flag.
    ///
    /// Mirrors the `take_dirty()` used by the persisted stores so cursor
    /// publication happens in exactly one place in the event loop rather than
    /// at each mutation site. Publishing only from the deliver path left the
    /// endpoint reporting obsolete acknowledgements and retired agents
    /// whenever a worker confirmation, manual flush, registration, identity
    /// rebind, or release moved the book without a later frame arriving.
    pub(crate) fn take_cursor_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty.0)
    }

    pub(crate) fn cursor_views(&self) -> Vec<crate::node_delivery_probe::AgentCursorView> {
        let mut views: Vec<_> = self
            .agents
            .iter()
            .map(
                |(agent_id, cursor)| crate::node_delivery_probe::AgentCursorView {
                    agent_id: agent_id.clone(),
                    agent_name: cursor.agent_name.clone(),
                    acked_up_to_seq: cursor.acked_up_to_seq,
                    received_up_to_seq: cursor.received_up_to_seq,
                    has_sequenced_position: cursor.has_sequenced_position,
                },
            )
            .collect();
        views.sort_by(|a, b| {
            a.agent_name
                .cmp(&b.agent_name)
                .then_with(|| a.agent_id.cmp(&b.agent_id))
        });
        views
    }

    pub(crate) fn commit_received(&mut self, deliver: &Deliver) -> u64 {
        self.mark_cursors_dirty();
        if !self.bind_identity(&deliver.agent, &deliver.agent_id, false) {
            return self.active_up_to_seq(&deliver.agent);
        }
        let cursor = self
            .agents
            .entry(deliver.agent_id.clone())
            .or_insert_with(|| AgentDeliveryCursor {
                agent_name: deliver.agent.clone(),
                ..AgentDeliveryCursor::default()
            });
        cursor.agent_name.clone_from(&deliver.agent);
        // seq:0 fan-out frames never advance either sequence cursor; they are
        // deduped purely by msg_id. They also leave the identity without a
        // sequenced position, so the next sequenced frame is still adopted.
        if deliver.seq == 0 {
            cursor
                .seen_msg_ids
                .insert(&deliver.msg_id, &deliver.delivery_id, deliver.seq);
            return cursor.received_up_to_seq;
        }
        if !cursor.has_sequenced_position {
            // First sequenced delivery for this identity (`observe` adopted it):
            // take the engine's position by starting one below it, so the
            // advance below accepts this frame and every later one stays
            // contiguous. Staying at zero instead would leave a respawned agent
            // — whose engine sequence resumes mid-stream — permanently short of
            // its own cursor, and every message would read as a gap.
            cursor.acked_up_to_seq = deliver.seq.saturating_sub(1);
            cursor.received_up_to_seq = deliver.seq.saturating_sub(1);
            cursor.has_sequenced_position = true;
        }
        if deliver.seq == cursor.received_up_to_seq.saturating_add(1) {
            cursor
                .seen_msg_ids
                .insert(&deliver.msg_id, &deliver.delivery_id, deliver.seq);
            cursor.received_up_to_seq = deliver.seq;
        }
        cursor.received_up_to_seq
    }

    pub(crate) fn commit_acked_receipt(
        &mut self,
        receipt: &RelaycastDeliveryReceipt,
    ) -> Option<u64> {
        self.mark_cursors_dirty();
        let cursor = self.agents.get_mut(receipt.agent_id.as_str())?;
        cursor.agent_name = receipt.agent.to_string();
        if receipt.seq == 0 {
            cursor.seen_msg_ids.insert(
                receipt.msg_id.as_str(),
                receipt.delivery_id.as_str(),
                receipt.seq,
            );
            return Some(cursor.acked_up_to_seq);
        }
        if receipt.seq != cursor.acked_up_to_seq.saturating_add(1)
            || receipt.seq > cursor.received_up_to_seq
        {
            return None;
        }
        cursor.acked_up_to_seq = receipt.seq;
        cursor.confirmed_delivery_seqs.remove(&receipt.seq);
        Some(cursor.acked_up_to_seq)
    }

    /// Record worker confirmation of a surfaced fleet delivery, advancing the
    /// cumulative ACK only across a contiguous confirmed prefix. An
    /// out-of-order confirmation stays held on this agent's cursor until every
    /// lower received sequence has also confirmed.
    pub(crate) fn commit_confirmed_delivery(&mut self, deliver: &Deliver) -> Option<u64> {
        self.mark_cursors_dirty();
        self.commit_received(deliver);
        let cursor = self.agents.get_mut(deliver.agent_id.as_str())?;
        if deliver.seq == 0 {
            cursor
                .seen_msg_ids
                .insert(&deliver.msg_id, &deliver.delivery_id, deliver.seq);
            return Some(cursor.acked_up_to_seq);
        }
        if deliver.seq <= cursor.acked_up_to_seq {
            return None;
        }
        cursor.confirmed_delivery_seqs.insert(deliver.seq, ());
        if deliver.seq > cursor.received_up_to_seq {
            return None;
        }
        let before = cursor.acked_up_to_seq;
        loop {
            let next = cursor.acked_up_to_seq.saturating_add(1);
            if next > cursor.received_up_to_seq
                || cursor.confirmed_delivery_seqs.remove(&next).is_none()
            {
                break;
            }
            cursor.acked_up_to_seq = next;
        }
        (cursor.acked_up_to_seq > before).then_some(cursor.acked_up_to_seq)
    }

    pub(crate) fn is_delivery_confirmation_held(&self, deliver: &Deliver) -> bool {
        deliver.seq > 0
            && self
                .agents
                .get(deliver.agent_id.as_str())
                .is_some_and(|cursor| cursor.confirmed_delivery_seqs.contains_key(&deliver.seq))
    }

    /// Classify what a parked delivery's receipt can still do to this broker's
    /// cumulative ACK cursor.
    ///
    /// A `manual_flush` queue stamps each held message with the `agent_id` that
    /// was live when it was queued. That identity is not permanent: a
    /// re-registration, a token identity resolve, or an inventory repair calls
    /// `bind_authoritative_identity`, which retires the previous `agent_id` and
    /// drops its cursor; and a node-control resume handshake calls
    /// `seed_cursor`, which moves the cumulative position to Relaycast's own.
    /// Either event leaves already-parked receipts pointing at a cursor that
    /// can never accept them.
    ///
    /// Treating that as "not ACKable yet" jams the queue permanently — the
    /// flush stops at the head message forever and the agent goes deaf while
    /// sends keep reporting success (relay#1593, relay#1559). So the
    /// un-ACKable-for-now case ([`ReceiptAckability::Blocked`], a genuine
    /// ordering gap that a later ACK will clear) is kept distinct from the
    /// never-ACKable case ([`ReceiptAckability::Orphaned`]), which the flush
    /// delivers and drops without ever touching the cursor.
    pub(crate) fn receipt_ackability(
        &self,
        receipt: &RelaycastDeliveryReceipt,
    ) -> ReceiptAckability {
        let Some(cursor) = self.agents.get(receipt.agent_id.as_str()) else {
            // The identity this receipt was stamped with is gone. A later
            // `bind_authoritative_identity` for the same `agent_id` can clear
            // its retired marker and re-adopt it, but that rebuilds the cursor
            // from Relaycast's own position — it never restores this receipt's
            // place in the old sequence, so the receipt stays un-ACKable either
            // way.
            return ReceiptAckability::Orphaned {
                reason: OrphanedReceiptReason::IdentityRetired,
            };
        };
        if cursor.agent_name != receipt.agent {
            // The `agent_id` is live but now answers to a different name: the
            // identity moved and `bind_identity` carried its cursor across
            // (`cursor.agent_name = agent`). This receipt belongs to the old
            // name binding. Committing it would rewrite `cursor.agent_name`
            // back through `commit_acked_receipt` and ACK against the wrong
            // name, after which `observe` would reject every delivery for the
            // identity's *current* name as an identity conflict.
            return ReceiptAckability::Orphaned {
                reason: OrphanedReceiptReason::IdentityRetired,
            };
        }
        if receipt.seq == 0 {
            return ReceiptAckability::Ready;
        }
        if receipt.seq <= cursor.acked_up_to_seq {
            // The cumulative cursor has already moved past this frame — a
            // resume handshake seeded it forward, or it was ACKed elsewhere.
            return ReceiptAckability::Orphaned {
                reason: OrphanedReceiptReason::CursorMovedPast,
            };
        }
        if receipt.seq == cursor.acked_up_to_seq.saturating_add(1)
            && receipt.seq <= cursor.received_up_to_seq
        {
            ReceiptAckability::Ready
        } else {
            ReceiptAckability::Blocked
        }
    }

    pub(crate) fn commit_delivered(&mut self, deliver: &Deliver) -> u64 {
        self.mark_cursors_dirty();
        self.commit_received(deliver);
        let receipt = RelaycastDeliveryReceipt {
            agent: deliver.agent.clone().into(),
            agent_id: deliver.agent_id.clone().into(),
            delivery_id: deliver.delivery_id.clone().into(),
            msg_id: deliver.msg_id.clone().into(),
            seq: deliver.seq,
        };
        self.commit_acked_receipt(&receipt)
            .unwrap_or_else(|| self.acked_up_to_seq(&deliver.agent_id))
    }

    pub(crate) fn acked_up_to_seq(&self, agent_id: &str) -> u64 {
        self.agents
            .get(agent_id)
            .map_or(0, |cursor| cursor.acked_up_to_seq)
    }

    pub(crate) fn next_ack_seq(&self, agent_id: &str) -> Option<u64> {
        self.agents
            .get(agent_id)
            .filter(|cursor| cursor.has_sequenced_position)
            .map(|cursor| cursor.acked_up_to_seq.saturating_add(1))
    }

    pub(crate) fn received_up_to_seq(&self, agent_id: &str) -> u64 {
        self.agents
            .get(agent_id)
            .map_or(0, |cursor| cursor.received_up_to_seq)
    }

    pub(crate) fn remove_agent(&mut self, agent: &str) {
        self.mark_cursors_dirty();
        if let Some(binding) = self.active_agent_bindings_by_name.remove(agent) {
            self.active_agent_names_by_id.remove(&binding.agent_id);
            self.agents.remove(&binding.agent_id);
            self.retire_identity(binding.agent_id, agent.to_string());
        }
        let orphaned_ids = self
            .agents
            .iter()
            .filter(|(_, cursor)| cursor.agent_name == agent)
            .map(|(agent_id, _)| agent_id.clone())
            .collect::<Vec<_>>();
        for agent_id in orphaned_ids {
            self.agents.remove(&agent_id);
            self.active_agent_names_by_id.remove(&agent_id);
            self.retire_identity(agent_id, agent.to_string());
        }
    }
}

pub(crate) fn handler_unavailable_result(invocation_id: &str) -> ActionResult {
    ActionResult {
        task: None,
        v: FLEET_WIRE_VERSION,
        id: None,
        invocation_id: invocation_id.to_string(),
        result: ActionResultPayload::Error(ActionResultError {
            error: "handler_unavailable".to_string(),
        }),
    }
}

pub(crate) fn build_node_register(
    manifest: &NodeManifest,
    default_node_id: &str,
    default_node_name: &str,
    default_version: &str,
    resume_cursor: Option<String>,
) -> NodeRegister {
    let mut capabilities = manifest
        .capabilities
        .iter()
        .filter(|capability| capability.name != crate::fleet_wire::DELIVERY_CURSOR_CAPABILITY)
        .map(|capability| FleetCapability {
            execution_mode: (capability.name == "task.run").then(|| "task".to_owned()),
            name: capability.name.clone(),
            kind: capability.kind.clone(),
            global: (capability.name == "task.run").then_some(true),
            queue: None,
            metadata: capability.metadata.as_ref().map(|metadata| {
                metadata
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<BTreeMap<_, _>>()
            }),
        })
        .collect::<Vec<_>>();
    capabilities.push(FleetCapability {
        execution_mode: None,
        name: crate::fleet_wire::DELIVERY_CURSOR_CAPABILITY.to_string(),
        kind: Some("capacity".to_string()),
        global: None,
        queue: None,
        metadata: None,
    });

    NodeRegister {
        v: FLEET_WIRE_VERSION,
        id: None,
        name: non_empty(&manifest.name)
            .unwrap_or(default_node_name)
            .to_string(),
        node_id: manifest
            .node_id
            .as_deref()
            .and_then(non_empty)
            .unwrap_or(default_node_id)
            .to_string(),
        provider: None,
        capabilities,
        max_agents: manifest.max_agents.unwrap_or(0),
        tags: manifest.tags.clone().unwrap_or_default(),
        // Treat the Fleet wire as a privacy boundary: even an unvalidated
        // manifest must never serialize a path-shaped or malformed value.
        // Preserve Some([]) so an updated node can authoritatively clear stale
        // repository advertisements on the control plane.
        repo_keys: manifest.repo_keys.as_ref().map(|repo_keys| {
            let mut seen = HashSet::new();
            repo_keys
                .iter()
                .filter(|repo_key| is_placement_repo_key(repo_key))
                .filter(|repo_key| seen.insert((*repo_key).clone()))
                .cloned()
                .collect()
        }),
        version: manifest
            .version
            .as_deref()
            .and_then(non_empty)
            .unwrap_or(default_version)
            .to_string(),
        machine_id: None,
        resume_cursor,
    }
}

fn is_placement_repo_key(value: &str) -> bool {
    let mut segments = value.split('/');
    let Some(owner) = segments.next() else {
        return false;
    };
    let Some(repo) = segments.next() else {
        return false;
    };
    segments.next().is_none()
        && [owner, repo].into_iter().all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

/// The broker's stable provider name. The broker attaches to its node as one
/// provider among several, registering `spawn:<harness>` / `release` capacity
/// under this name; each connection uses a fresh `instance_id` so a reconnect
/// replaces the prior attachment.
pub(crate) const BROKER_PROVIDER_NAME: &str = "broker";

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub(crate) fn default_node_name(cli_name: Option<&str>) -> String {
    if let Some(name) = cli_name.and_then(non_empty) {
        return name.to_string();
    }
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .and_then(|name| non_empty(&name).map(ToOwned::to_owned))
        .unwrap_or_else(|| "relay-node".to_string())
}

/// Load (or create) the stable per-machine seed persisted at `path`.
///
/// The seed file (`machine-id`) is a stable identifier for the host. It is
/// reused across runs and across every broker on the machine; the per-broker
/// node id is then derived from this seed plus the broker's working directory
/// via [`derive_node_id`].
pub(crate) fn load_or_create_machine_seed(path: &Path) -> Result<String> {
    if let Ok(existing) = fs::read_to_string(path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return Ok(existing.to_string());
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create node id dir {}", parent.display()))?;
    }
    let seed = format!("node_{}", Uuid::new_v4().simple());
    fs::write(path, format!("{seed}\n"))
        .with_context(|| format!("failed to write node id file {}", path.display()))?;
    Ok(seed)
}

/// Derive a node id from a stable machine `seed`, the broker's working
/// directory `cwd`, and the relaycast `workspace_id`.
///
/// The engine scopes nodes globally, so a single host that runs brokers for
/// two different workspaces (each in its own per-project working directory)
/// must present a distinct node id per broker — otherwise the second
/// `create_node` collides with the first. The same conflict can happen when
/// `agent-relay up` creates a fresh workspace for the same project directory:
/// `(seed, cwd)` stays identical while the workspace changes, so the global
/// `node_id` would still collide. Deriving the id from
/// `(seed, cwd, workspace_id)` keeps it:
///
/// - **stable across restarts** in the same working directory and workspace,
/// - **distinct across different working directories** on the same machine,
///   and
/// - **distinct across different workspaces** in the same working directory.
///
/// The result has the same `node_<32 hex>` shape as a freshly minted id.
pub(crate) fn derive_node_id(seed: &str, cwd: &str, workspace_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hasher.update([0u8]);
    hasher.update(cwd.as_bytes());
    hasher.update([0u8]);
    hasher.update(workspace_id.as_bytes());
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .fold(String::with_capacity(64), |mut acc, byte| {
            acc.push_str(&format!("{byte:02x}"));
            acc
        });
    format!("node_{}", &hex[..32])
}

/// Resolve the node id for this broker: load (or create) the machine seed at
/// `seed_path`, then derive a per-working-directory, per-workspace node id
/// from it.
///
/// The working directory is read from [`std::env::current_dir`] and
/// canonicalized when possible so equivalent paths resolve to the same id. If
/// the cwd cannot be read, the id is derived from the seed plus workspace
/// rather than panicking.
pub(crate) fn load_or_create_node_id(seed_path: &Path, workspace_id: &str) -> Result<String> {
    let seed = load_or_create_machine_seed(seed_path)?;
    let cwd = std::env::current_dir()
        .map(|path| {
            std::fs::canonicalize(&path)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_default();
    Ok(derive_node_id(&seed, &cwd, workspace_id))
}

pub(crate) fn default_node_id_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join("agent-relay").join("machine-id"))
}

/// Path to the persisted node token for a given `node_id`. The cache is scoped
/// per node id (which is itself derived per machine + working directory) so two
/// brokers on the same host never overwrite each other's cached token. The id is
/// `node_<32hex>` and thus already filename-safe, but it is sanitized defensively
/// so an unexpected value can never escape the cache directory.
pub(crate) fn default_node_token_path(node_id: &str) -> Option<std::path::PathBuf> {
    let file = format!("{}.json", sanitize_node_id_for_filename(node_id));
    dirs::data_local_dir().map(|dir| dir.join("agent-relay").join("node-tokens").join(file))
}

/// Map a `node_id` to a filename-safe stem: keep ASCII alphanumerics, `-` and
/// `_`; replace anything else (including path separators) with `_`. Empty input
/// falls back to `node` so the path always has a stem.
fn sanitize_node_id_for_filename(node_id: &str) -> String {
    let sanitized: String = node_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "node".to_string()
    } else {
        sanitized
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct PersistedNodeToken {
    node_id: String,
    /// Workspace this token was minted for. A node token is only valid against
    /// the workspace (and engine) that issued it, so a token cached for
    /// workspace A must never be reused against workspace B.
    workspace_id: String,
    /// Engine base URL the token was minted against (when known). Switching
    /// `RELAYCAST_BASE_URL`/`with_base_url` re-mints. Optional for forward and
    /// backward compatibility with caches written before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    token: String,
    /// CSPRNG capability for replaying the exact in-flight rotation after a
    /// lost response or process restart. Cleared only when the replacement
    /// token has been atomically persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_rotation_idempotency_key: Option<String>,
    /// Digest of the exact create-node request body associated with the pending
    /// key. Reusing a key for a changed name/version could replay stale data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_rotation_request_digest: Option<String>,
}

#[derive(Debug, Clone)]
struct NodeRotationPreparation {
    idempotency_key: Option<String>,
    expected_cache: Option<PersistedNodeToken>,
}

#[derive(Debug, Clone, Copy)]
enum PendingNodeRotation<'a> {
    None,
    Bound {
        key: &'a str,
        request_digest: &'a str,
    },
    LegacyKey(&'a str),
}

static PROCESS_NODE_ROTATION_KEYS: OnceLock<std::sync::Mutex<HashMap<String, String>>> =
    OnceLock::new();

fn process_node_rotation_fingerprint(
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
    token: &str,
    request_digest: &str,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        node_id,
        workspace_id,
        base_url.unwrap_or_default(),
        token,
        request_digest,
    ] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn process_node_rotation_idempotency_key(
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
    token: &str,
    request_digest: &str,
) -> String {
    let fingerprint =
        process_node_rotation_fingerprint(node_id, workspace_id, base_url, token, request_digest);
    let keys = PROCESS_NODE_ROTATION_KEYS.get_or_init(Default::default);
    let Ok(mut keys) = keys.lock() else {
        return format!("node-rotation:{}", Uuid::new_v4());
    };
    keys.entry(fingerprint)
        .or_insert_with(|| format!("node-rotation:{}", Uuid::new_v4()))
        .clone()
}

fn clear_process_node_rotation_idempotency_key(
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
    token: &str,
    request_digest: &str,
) {
    let Some(keys) = PROCESS_NODE_ROTATION_KEYS.get() else {
        return;
    };
    let Ok(mut keys) = keys.lock() else {
        return;
    };
    keys.remove(&process_node_rotation_fingerprint(
        node_id,
        workspace_id,
        base_url,
        token,
        request_digest,
    ));
}

fn load_scoped_node_token(
    path: &Path,
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
) -> Option<PersistedNodeToken> {
    let raw = fs::read_to_string(path).ok()?;
    let persisted: PersistedNodeToken = serde_json::from_str(&raw).ok()?;
    if persisted.node_id != node_id || persisted.workspace_id != workspace_id {
        return None;
    }
    // Only enforce the base URL when both the cache and the current run carry
    // one; a cache written before base_url existed (None) stays usable so long
    // as the workspace matches.
    if let (Some(cached), Some(current)) = (persisted.base_url.as_deref(), base_url) {
        if cached != current {
            return None;
        }
    }
    (!persisted.token.trim().is_empty()).then_some(persisted)
}

/// Load a previously minted node token, but only if it was minted for the same
/// `node_id` AND the same `workspace_id` (and, when both sides know it, the same
/// engine `base_url`). A `node_id` mismatch means the machine id rotated; a
/// `workspace_id`/`base_url` mismatch means the cached token was minted for a
/// different workspace or engine and would be rejected with HTTP 401. In every
/// mismatch case the cache is ignored and the caller mints a fresh token.
pub(crate) fn load_node_token(
    path: &Path,
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
) -> Option<String> {
    load_scoped_node_token(path, node_id, workspace_id, base_url)
        .map(|persisted| persisted.token.trim().to_string())
}

/// Reuse a durable rotation capability if one is already pending; otherwise
/// create and atomically persist it alongside the retained token before the
/// request can commit. This closes both the lost-response and process-crash
/// windows without deleting the only credential that can prove node ownership.
fn prepare_node_rotation(
    path: &Path,
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
    token: &str,
    request_digest: &str,
) -> Result<NodeRotationPreparation> {
    let _lock = lock_node_token_cache(path)?;
    if let Some(persisted) = load_scoped_node_token(path, node_id, workspace_id, base_url) {
        if persisted.token.trim() != token.trim() {
            // The active credential came from a non-cache source (most notably
            // RELAY_NODE_TOKEN, whose contract is "never persisted") or the
            // cache was rotated by a sibling process. Never overwrite that
            // durable credential with the token the server just rejected.
            return Ok(NodeRotationPreparation {
                idempotency_key: None,
                expected_cache: Some(persisted),
            });
        }
        if let Some(key) = persisted
            .pending_rotation_idempotency_key
            .as_deref()
            .filter(|key| {
                !key.trim().is_empty()
                    && persisted.pending_rotation_request_digest.as_deref() == Some(request_digest)
            })
        {
            return Ok(NodeRotationPreparation {
                idempotency_key: Some(key.to_string()),
                expected_cache: Some(persisted),
            });
        }
    } else {
        // Without a matching durable token, the rejected credential may be an
        // environment override. Keep it process-local and omit the recovery
        // key rather than materializing either value on disk.
        return Ok(NodeRotationPreparation {
            idempotency_key: None,
            expected_cache: None,
        });
    }

    let key = format!("node-rotation:{}", Uuid::new_v4());
    persist_node_token_state(
        path,
        node_id,
        workspace_id,
        base_url,
        token,
        PendingNodeRotation::Bound {
            key: &key,
            request_digest,
        },
    )?;
    Ok(NodeRotationPreparation {
        idempotency_key: Some(key.clone()),
        expected_cache: Some(PersistedNodeToken {
            node_id: node_id.to_string(),
            workspace_id: workspace_id.to_string(),
            base_url: base_url.map(ToOwned::to_owned),
            token: token.to_string(),
            pending_rotation_idempotency_key: Some(key),
            pending_rotation_request_digest: Some(request_digest.to_string()),
        }),
    })
}

fn lock_node_token_cache(path: &Path) -> Result<fs::File> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .with_context(|| format!("failed to create node token dir {}", parent.display()))?;
    let lock_path = path.with_extension("lock");
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options
        .open(&lock_path)
        .with_context(|| format!("failed to open node token lock {}", lock_path.display()))?;
    lock.lock()
        .with_context(|| format!("failed to lock node token cache {}", path.display()))?;
    Ok(lock)
}

fn persist_node_token_after_rotation(
    path: &Path,
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
    preparation: &NodeRotationPreparation,
    minted_token: &str,
) -> Result<String> {
    let _lock = lock_node_token_cache(path)?;
    let current = load_scoped_node_token(path, node_id, workspace_id, base_url);
    if current.as_ref() != preparation.expected_cache.as_ref() {
        if matches!(
            (&preparation.expected_cache, &current),
            (Some(expected), Some(current))
                if current.token.trim() == expected.token.trim()
        ) {
            // A sibling may have replaced only the pending rotation metadata.
            // Relaycast accepted this proof, so the minted credential is newer
            // than the token both cache versions still hold.
            let current = current.as_ref().expect("same-token match requires cache");
            let concurrent_pending = match (
                current.pending_rotation_idempotency_key.as_deref(),
                current.pending_rotation_request_digest.as_deref(),
            ) {
                (Some(key), Some(request_digest)) => PendingNodeRotation::Bound {
                    key,
                    request_digest,
                },
                (Some(key), None) => PendingNodeRotation::LegacyKey(key),
                (None, _) => PendingNodeRotation::None,
            };
            persist_node_token_state(
                path,
                node_id,
                workspace_id,
                base_url,
                minted_token,
                concurrent_pending,
            )?;
            return Ok(minted_token.to_string());
        }
        let cache_advanced = match (&preparation.expected_cache, &current) {
            (Some(expected), Some(current)) => current.token.trim() != expected.token.trim(),
            (None, Some(_)) => true,
            _ => false,
        };
        if cache_advanced {
            let current = current.expect("cache_advanced requires a current cache");
            tracing::info!(
                target = "relay_broker::fleet",
                node_id,
                workspace_id,
                "node token cache advanced during rotation; retaining the newer cached credential"
            );
            return Ok(current.token.trim().to_string());
        }
        // A concurrent removal must not be overwritten. The minted token is
        // still valid for this process.
        return Ok(minted_token.to_string());
    }

    persist_node_token_state(
        path,
        node_id,
        workspace_id,
        base_url,
        minted_token,
        PendingNodeRotation::None,
    )?;
    Ok(minted_token.to_string())
}

/// Atomically persist a minted node token next to the node id, scoped to `node_id`,
/// `workspace_id` and the engine `base_url` so an id rotation, a different
/// workspace, or a different engine all invalidate it. Failures are surfaced as
/// `Err` but are non-fatal to startup — the caller logs and continues with the
/// in-memory token.
pub(crate) fn persist_node_token(
    path: &Path,
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
    token: &str,
) -> Result<()> {
    let _lock = lock_node_token_cache(path)?;
    persist_node_token_state(
        path,
        node_id,
        workspace_id,
        base_url,
        token,
        PendingNodeRotation::None,
    )
}

fn persist_node_token_state(
    path: &Path,
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
    token: &str,
    pending_rotation: PendingNodeRotation<'_>,
) -> Result<()> {
    persist_node_token_state_with_sync(
        path,
        node_id,
        workspace_id,
        base_url,
        token,
        pending_rotation,
        sync_parent_directory,
    )
}

fn persist_node_token_state_with_sync<F>(
    path: &Path,
    node_id: &str,
    workspace_id: &str,
    base_url: Option<&str>,
    token: &str,
    pending_rotation: PendingNodeRotation<'_>,
    sync_directory: F,
) -> Result<()>
where
    F: FnOnce(&Path) -> Result<()>,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create node token dir {}", parent.display()))?;
    }
    let (pending_rotation_idempotency_key, pending_rotation_request_digest) = match pending_rotation
    {
        PendingNodeRotation::None => (None, None),
        PendingNodeRotation::Bound {
            key,
            request_digest,
        } => (Some(key.to_string()), Some(request_digest.to_string())),
        PendingNodeRotation::LegacyKey(key) => (Some(key.to_string()), None),
    };
    let body = serde_json::to_string(&PersistedNodeToken {
        node_id: node_id.to_string(),
        workspace_id: workspace_id.to_string(),
        base_url: base_url.map(ToOwned::to_owned),
        token: token.to_string(),
        pending_rotation_idempotency_key,
        pending_rotation_request_digest,
    })
    .context("failed to serialize node token")?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent).with_context(|| {
        format!(
            "failed to create node token temp file in {}",
            parent.display()
        )
    })?;
    temporary.write_all(body.as_bytes()).with_context(|| {
        format!(
            "failed to write node token temp file for {}",
            path.display()
        )
    })?;
    temporary
        .as_file()
        .sync_all()
        .with_context(|| format!("failed to sync node token temp file for {}", path.display()))?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("failed to replace node token file {}", path.display()))?;
    // The rename has committed at this point. A directory-sync failure means
    // crash durability is uncertain, but returning Err would be worse: remint
    // would generate a different process-local key from the one now visible on
    // disk. Keep using the committed key and report the durability degradation.
    if let Err(error) = sync_directory(parent) {
        tracing::warn!(
            target = "relay_broker::fleet",
            path = %path.display(),
            error = %error,
            "node token replacement is visible but parent-directory sync failed"
        );
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<()> {
    let directory = fs::File::open(parent)
        .with_context(|| format!("failed to open node token directory {}", parent.display()))?;
    directory
        .sync_all()
        .with_context(|| format!("failed to sync node token directory {}", parent.display()))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<()> {
    // Directory handles are not portably fsyncable outside Unix. The file
    // content is still flushed before the atomic replacement above.
    Ok(())
}

/// Outcome of handling a control command received while the node is not yet
/// connected to `/v1/node/ws`. `Shutdown` means the command channel closed or a
/// `Shutdown` command arrived and the caller should return.
enum DisconnectedCommandOutcome {
    Handled,
    Shutdown,
}

/// Apply a control command received while the node is disconnected, shared by the
/// three not-yet-connected wait points (pre-registration, mint backoff, and the
/// no-minter idle wait) so a new `FleetControlCommand` variant or state update
/// stays consistent across them. `register_agent_error` is the reason replied to
/// a `RegisterAgent` that can't be served yet: `node_not_registered` before the
/// node is registered, `node_token_missing` once registered but tokenless.
fn handle_disconnected_command(
    command: Option<FleetControlCommand>,
    config: &FleetControlConfig,
    registration: &mut Option<NodeRegister>,
    load: &mut FleetLoadSnapshot,
    inventory: &mut Vec<InventoryAgent>,
    retained_completion: &mut Option<RetainedFleetCompletion>,
    register_agent_error: &str,
) -> DisconnectedCommandOutcome {
    match command {
        Some(FleetControlCommand::RegisterNode {
            manifest,
            resume_cursor,
        }) => {
            load.max_agents = manifest.max_agents.unwrap_or(load.max_agents);
            // This control client is the broker provider, which owns the
            // node's spawn/release capacity as soon as its socket connects.
            // A fresh node has no workers yet, so no load transition would
            // otherwise publish the first `handlers_live=true` snapshot and
            // the engine would queue the very first spawn indefinitely.
            load.handlers_live = true;
            *registration = Some(build_node_register(
                &manifest,
                &config.node_id,
                &config.node_name,
                &config.broker_version,
                resume_cursor,
            ));
        }
        Some(FleetControlCommand::UpdateLoad(next)) => *load = next,
        Some(FleetControlCommand::UpdateInventory(next)) => *inventory = next,
        Some(FleetControlCommand::DeregisterAgent { reply, .. }) => {
            let _ = reply.send(Err(register_agent_error.to_string()));
        }
        Some(FleetControlCommand::RegisterAgent { reply, .. }) => {
            let _ = reply.send(Err(register_agent_error.to_string()));
        }
        Some(FleetControlCommand::Send(message)) => {
            if let BrokerToRelaycast::ActionResult(result) = &message {
                tracing::warn!(invocation_id = %result.invocation_id, frame_kind = "action.result",
                    "dropping fleet frame while disconnected");
            }
        }
        Some(FleetControlCommand::RetainedSend(completion)) => {
            *retained_completion = Some(completion);
        }
        Some(FleetControlCommand::HeartbeatNow) => {}
        Some(FleetControlCommand::Shutdown) | None => return DisconnectedCommandOutcome::Shutdown,
    }
    DisconnectedCommandOutcome::Handled
}

async fn recv_control_command(
    command_rx: &mut mpsc::Receiver<FleetControlCommand>,
    completion_rx: &mut mpsc::UnboundedReceiver<RetainedFleetCompletion>,
    retained_completion: &mut Option<RetainedFleetCompletion>,
) -> Option<FleetControlCommand> {
    if let Some(completion) = retained_completion.take() {
        return Some(FleetControlCommand::RetainedSend(completion));
    }
    tokio::select! {
        // Retained action results are terminal caller outcomes. Prefer them to
        // ordinary bounded control traffic once they become ready, especially
        // during broker shutdown when the normal queue may already be full.
        biased;
        completion = completion_rx.recv(), if !(completion_rx.is_closed() && completion_rx.is_empty()) => {
            completion.map(FleetControlCommand::RetainedSend)
        }
        command = command_rx.recv() => command,
    }
}

#[cfg(test)]
pub(crate) async fn run_node_control_client(
    config: FleetControlConfig,
    command_rx: mpsc::Receiver<FleetControlCommand>,
    event_tx: mpsc::Sender<FleetControlEvent>,
) {
    // Most callers, including focused node-control tests, do not need the
    // retained-completion lane. Keep the ordinary entry point while production
    // supplies the dedicated receiver below.
    let (_completion_tx, completion_rx) = mpsc::unbounded_channel();
    run_node_control_client_with_completions(config, command_rx, completion_rx, event_tx).await;
}

pub(crate) async fn run_node_control_client_with_completions(
    mut config: FleetControlConfig,
    mut command_rx: mpsc::Receiver<FleetControlCommand>,
    mut completion_rx: mpsc::UnboundedReceiver<RetainedFleetCompletion>,
    event_tx: mpsc::Sender<FleetControlEvent>,
) {
    let mut registration: Option<NodeRegister> = None;
    let mut inventory: Vec<InventoryAgent> = Vec::new();
    let mut load = FleetLoadSnapshot::default();
    let mut reconnect_delay = INITIAL_RECONNECT_DELAY;
    // Bound re-minting so a persistently-rejecting engine can't spin a tight
    // mint loop. This counter increments on every consecutive `/v1/node/ws` 401
    // and only resets once a correlated inventory acknowledgement proves the
    // application processed this connection — NOT on a successful re-mint. So repeated 401s accumulate
    // toward [`MAX_UNAUTHORIZED_BEFORE_GIVING_UP`] even when each mint succeeds,
    // and each retry honors the backoff sleep at the bottom of the loop.
    let mut consecutive_unauthorized: u32 = 0;
    // A proof conflict can be the benign race where another broker process
    // rotated the shared cache while our request was in flight. Adopt that
    // token once, but never follow an unbounded chain of cache changes.
    let mut proof_conflict_cache_retry_used = false;
    let mut retained_completion: Option<RetainedFleetCompletion> = None;

    loop {
        // Retained completion frames stay in their unbounded lane until a
        // node session is registered. Treating them like ordinary commands
        // here would drop them in `handle_disconnected_command`.
        while registration.is_none() {
            if matches!(
                handle_disconnected_command(
                    command_rx.recv().await,
                    &config,
                    &mut registration,
                    &mut load,
                    &mut inventory,
                    &mut retained_completion,
                    "node_not_registered",
                ),
                DisconnectedCommandOutcome::Shutdown
            ) {
                return;
            }
        }

        if let Some(probe) = &config.probe {
            probe.record_node_control_connecting();
        }

        if config
            .node_token
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            // No pre-supplied or cached token. Broker startup deliberately skips
            // the network mint (it must not gate `/api/session` readiness), so the
            // initial mint happens here, in the background. On success, publish the
            // token to the shared HTTP session so `/api/session` starts reporting
            // it, then fall through to connect. On failure, back off and retry
            // rather than idling forever — realtime delivery self-heals once the
            // engine is reachable.
            if let Some(minter) = config.token_minter.as_ref() {
                match minter.mint(None).await {
                    Ok(fresh) => {
                        config.node_token = Some(fresh);
                        if let Some(shared) = &config.session_token {
                            if let Ok(mut guard) = shared.write() {
                                guard.clone_from(&config.node_token);
                            }
                        }
                        // A successful mint proves the engine is reachable, so reset
                        // the backoff any earlier mint failures grew — the first
                        // `/v1/node/ws` connect should start from the minimum delay,
                        // not inherit a bloated one.
                        reconnect_delay = INITIAL_RECONNECT_DELAY;
                    }
                    Err(error) => {
                        if is_node_token_proof_conflict(&error) {
                            let cached = (!proof_conflict_cache_retry_used)
                                .then(|| minter.load_different_cached_token(None))
                                .flatten();
                            if let Some(cached) = cached {
                                config.node_token = Some(cached);
                                if let Some(shared) = &config.session_token {
                                    if let Ok(mut guard) = shared.write() {
                                        guard.clone_from(&config.node_token);
                                    }
                                }
                                proof_conflict_cache_retry_used = true;
                                tracing::warn!(
                                    target = "relay_broker::fleet",
                                    node_id = %config.node_id,
                                    "node token cache changed during enrollment; adopting the cached credential and retrying once"
                                );
                                continue;
                            }
                            let env_override_rejected =
                                minter.env_override_shadows_different_cached_token(None);
                            if let Some(probe) = &config.probe {
                                if env_override_rejected {
                                    probe.record_env_node_token_rejected_terminal();
                                } else {
                                    probe.record_node_token_proof_conflict_terminal();
                                }
                            }
                            if env_override_rejected {
                                tracing::error!(
                                    target = "relay_broker::fleet",
                                    node_id = %config.node_id,
                                    "NODE TOKEN ENROLLMENT TERMINAL: RELAY_NODE_TOKEN override was rejected; the scoped cache holds a different credential that cannot be used while the override is set. Re-enroll this Cloud node or unset RELAY_NODE_TOKEN; realtime delivery stopped"
                                );
                            } else {
                                tracing::error!(
                                    target = "relay_broker::fleet",
                                    node_id = %config.node_id,
                                    "NODE TOKEN ENROLLMENT TERMINAL: node_token_proof_required and no newer cached credential is available; realtime delivery stopped"
                                );
                            }
                            let _ = event_tx.send(FleetControlEvent::Disconnected).await;
                            return;
                        }
                        tracing::warn!(
                            target = "relay_broker::fleet",
                            node_id = %config.node_id,
                            "node token mint failed; retrying after backoff (realtime delivery pending)"
                        );
                        if let Some(probe) = &config.probe {
                            probe.record_node_control_backoff();
                        }
                        // Stay responsive during the backoff instead of a blind
                        // sleep: a spawn's `RegisterAgent` must get an immediate
                        // `node_token_missing` (so the caller falls back to HTTP
                        // register) rather than blocking on the 30s register timeout,
                        // and load/inventory updates must keep draining so the bounded
                        // control channel can't fill during a Relaycast outage.
                        let backoff = tokio::time::sleep(reconnect_delay);
                        tokio::pin!(backoff);
                        loop {
                            tokio::select! {
                                _ = &mut backoff => break,
                                command = command_rx.recv() => {
                                    if matches!(
                                        handle_disconnected_command(
                                            command,
                                            &config,
                                            &mut registration,
                                            &mut load,
                                            &mut inventory,
                                            &mut retained_completion,
                                            "node_token_missing",
                                        ),
                                        DisconnectedCommandOutcome::Shutdown
                                    ) {
                                        return;
                                    }
                                }
                            }
                        }
                        reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
                        continue;
                    }
                }
            } else {
                // No minter available (e.g. no workspace RelayCast client). Can't
                // self-recover; wait for a token to arrive via command.
                if matches!(
                    handle_disconnected_command(
                        command_rx.recv().await,
                        &config,
                        &mut registration,
                        &mut load,
                        &mut inventory,
                        &mut retained_completion,
                        "node_token_missing",
                    ),
                    DisconnectedCommandOutcome::Shutdown
                ) {
                    return;
                }
                continue;
            }
        }

        let result = run_connected_once_with_completions(
            &config,
            &mut command_rx,
            &mut completion_rx,
            &mut retained_completion,
            &event_tx,
            &mut registration,
            &mut inventory,
            &mut load,
            INVENTORY_REFRESH_INTERVAL,
        )
        .await;
        if matches!(result, ControlRunResult::Shutdown) {
            return;
        }
        let application_ready = matches!(
            result,
            ControlRunResult::Disconnected {
                application_ready: true
            }
        );
        if application_ready {
            // A correlated inventory.sync acknowledgement proves the engine's
            // application processed this session. Reset outage state only after
            // that proof — a transport handshake followed by a pre-ready drop
            // must preserve both the 401 history and exponential backoff.
            consecutive_unauthorized = 0;
            reconnect_delay = INITIAL_RECONNECT_DELAY;
            proof_conflict_cache_retry_used = false;
        }
        if matches!(result, ControlRunResult::Unauthorized) {
            // The engine rejected our current node token. Re-mint a fresh one
            // (bounded) rather than reconnecting forever on the rejected token.
            consecutive_unauthorized = consecutive_unauthorized.saturating_add(1);
            if let Some(minter) = config.token_minter.as_ref() {
                if should_attempt_remint(consecutive_unauthorized) {
                    let rejected_token = config.node_token.as_deref().unwrap_or_default();
                    match minter.remint(rejected_token).await {
                        Ok(fresh) => {
                            // Install the fresh token and retry, but fall through to
                            // the shared backoff sleep at the bottom of the loop
                            // rather than `continue`-ing past it. The delay throttles
                            // the next connect attempt so a server that 401s every
                            // freshly minted token can't be hammered. The counter is
                            // intentionally NOT reset here; it only resets once a
                            // correlated inventory reply establishes application readiness
                            // (the `Disconnected` arm above), so repeated 401s still accumulate toward the cap
                            // even when each mint succeeds.
                            config.node_token = Some(fresh);
                            // Mirror the fresh token to the HTTP session so a provider
                            // reading it after this re-mint gets the valid token.
                            if let Some(shared) = &config.session_token {
                                if let Ok(mut guard) = shared.write() {
                                    guard.clone_from(&config.node_token);
                                }
                            }
                        }
                        Err(error) if is_node_token_proof_conflict(&error) => {
                            let cached = (!proof_conflict_cache_retry_used)
                                .then(|| minter.load_different_cached_token(Some(rejected_token)))
                                .flatten();
                            if let Some(cached) = cached {
                                config.node_token = Some(cached);
                                if let Some(shared) = &config.session_token {
                                    if let Ok(mut guard) = shared.write() {
                                        guard.clone_from(&config.node_token);
                                    }
                                }
                                proof_conflict_cache_retry_used = true;
                                tracing::warn!(
                                    target = "relay_broker::fleet",
                                    node_id = %config.node_id,
                                    "node token cache changed during recovery; adopting the cached credential and retrying once"
                                );
                            } else {
                                let env_override_rejected = minter
                                    .env_override_shadows_different_cached_token(Some(
                                        rejected_token,
                                    ));
                                if let Some(probe) = &config.probe {
                                    if env_override_rejected {
                                        probe.record_env_node_token_rejected_terminal();
                                    } else {
                                        probe.record_node_token_proof_conflict_terminal();
                                    }
                                }
                                if env_override_rejected {
                                    tracing::error!(
                                        target = "relay_broker::fleet",
                                        node_id = %config.node_id,
                                        "NODE TOKEN RECOVERY TERMINAL: RELAY_NODE_TOKEN override was rejected; the scoped cache holds a different credential that cannot be used while the override is set. Re-enroll this Cloud node or unset RELAY_NODE_TOKEN; realtime delivery stopped"
                                    );
                                } else {
                                    tracing::error!(
                                        target = "relay_broker::fleet",
                                        node_id = %config.node_id,
                                        "NODE TOKEN RECOVERY TERMINAL: node_token_proof_required and no newer cached credential is available; realtime delivery stopped"
                                    );
                                }
                                let _ = event_tx.send(FleetControlEvent::Disconnected).await;
                                return;
                            }
                        }
                        Err(_) => {}
                    }
                } else {
                    tracing::error!(
                        target = "relay_broker::fleet",
                        node_id = %config.node_id,
                        attempts = consecutive_unauthorized,
                        "NODE TOKEN REJECTED: re-mint kept failing after repeated node-control 401s; \
                         realtime delivery is DISABLED. Check workspace key / engine connectivity."
                    );
                }
            } else {
                tracing::error!(
                    target = "relay_broker::fleet",
                    node_id = %config.node_id,
                    "NODE TOKEN REJECTED (401) on node-control and no minter is available to recover; \
                     realtime delivery is DISABLED until a valid RELAY_NODE_TOKEN is supplied."
                );
            }
        }
        let transition = match result {
            ControlRunResult::ConnectFailed => "connect_failed",
            ControlRunResult::Disconnected { .. } => "disconnected",
            ControlRunResult::Unauthorized => "unauthorized",
            ControlRunResult::Shutdown => unreachable!("shutdown returned above"),
        };
        tracing::warn!(
            target = "relay_broker::fleet",
            node_id = %config.node_id,
            transition,
            reconnect_delay_ms = reconnect_delay.as_millis(),
            "node-control transition: unhealthy; reconnect scheduled"
        );
        if let Some(probe) = &config.probe {
            probe.record_node_control_backoff();
        }
        let _ = event_tx.send(FleetControlEvent::Disconnected).await;
        tokio::time::sleep(reconnect_delay).await;
        if !application_ready {
            reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_DELAY);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ControlRunResult {
    /// The WebSocket session never completed its transport handshake.
    ConnectFailed,
    Disconnected {
        /// True only after a correlated inventory.sync acknowledgement proved
        /// that the engine application processed this connection.
        application_ready: bool,
    },
    /// The `/v1/node/ws` handshake was rejected with HTTP 401/Unauthorized,
    /// i.e. the current node token is stale or scoped to a different
    /// workspace/engine and must be re-minted before retrying.
    Unauthorized,
    Shutdown,
}

/// True when a `connect_async` failure is an HTTP 401/Unauthorized handshake
/// rejection — i.e. the node token was refused by the engine. Other transport
/// errors (DNS, TCP, TLS, 5xx) are treated as ordinary disconnects.
fn connect_error_is_unauthorized(error: &tokio_tungstenite::tungstenite::Error) -> bool {
    matches!(
        error,
        tokio_tungstenite::tungstenite::Error::Http(response)
            if response.status() == tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED
    )
}

/// Application-level liveness is proven by an engine reply to the correlated
/// `inventory.sync` request the broker already sends periodically. WebSocket
/// pong traffic is deliberately excluded: an intermediary or a socket task can
/// keep answering pings even after the node-control application stops applying
/// heartbeats and inventory.
struct PendingInventorySync {
    frame: InventorySync,
    retry_attempts: u32,
    retry_at: Option<Instant>,
    superseded: bool,
}

struct ApplicationLiveness {
    deadline: Duration,
    last_acknowledged: Instant,
    pending_inventory_syncs: VecDeque<PendingInventorySync>,
    ready: bool,
}

impl ApplicationLiveness {
    fn new(deadline: Duration) -> Self {
        Self {
            deadline,
            last_acknowledged: Instant::now(),
            pending_inventory_syncs: VecDeque::new(),
            ready: false,
        }
    }

    fn track_inventory_sync(&mut self, frame: InventorySync) {
        // A newer authoritative snapshot supersedes every older retry payload.
        // Keep the probes for correlation/liveness, but never let an old frame
        // apply after a later inventory update removed or changed an agent.
        for pending in &mut self.pending_inventory_syncs {
            pending.retry_at = None;
            pending.superseded = true;
        }
        self.pending_inventory_syncs
            .push_back(PendingInventorySync {
                frame,
                retry_attempts: 0,
                retry_at: None,
                superseded: false,
            });
    }

    /// Returns `Some(true)` for the first successful application acknowledgement,
    /// `Some(false)` for later ones, and `None` for unrelated replies.
    fn acknowledge(&mut self, id: &str) -> Option<bool> {
        let acknowledged_index = self
            .pending_inventory_syncs
            .iter()
            .position(|pending| pending.frame.id.as_deref() == Some(id))?;
        self.pending_inventory_syncs.drain(..=acknowledged_index);
        let became_ready = !self.ready;
        self.ready = true;
        self.last_acknowledged = Instant::now();
        // Relaycast serializes control work for a node, so this reply proves all
        // older probes were processed. Preserve newer probes: their later error
        // replies must still replace an unhealthy control session.
        Some(became_ready)
    }

    fn reject(&mut self, id: &str) -> bool {
        let Some(index) = self
            .pending_inventory_syncs
            .iter()
            .position(|pending| pending.frame.id.as_deref() == Some(id))
        else {
            return false;
        };
        self.pending_inventory_syncs.remove(index);
        true
    }

    fn discard_superseded(&mut self, id: &str) -> bool {
        let Some(index) = self
            .pending_inventory_syncs
            .iter()
            .position(|pending| pending.superseded && pending.frame.id.as_deref() == Some(id))
        else {
            return false;
        };
        self.pending_inventory_syncs.remove(index);
        true
    }

    fn schedule_d1_pressure_retry(&mut self, id: &str, now: Instant) -> Option<Duration> {
        let pending = self
            .pending_inventory_syncs
            .iter_mut()
            .find(|pending| !pending.superseded && pending.frame.id.as_deref() == Some(id))?;
        pending.retry_attempts = pending.retry_attempts.saturating_add(1);
        let delay = d1_pressure_retry_delay(pending.retry_attempts);
        pending.retry_at = Some(now + delay);
        Some(delay)
    }

    fn next_retry_delay(&self, now: Instant) -> Option<Duration> {
        self.pending_inventory_syncs
            .iter()
            .filter_map(|pending| pending.retry_at)
            .min()
            .map(|retry_at| retry_at.saturating_duration_since(now))
    }

    fn take_due_retry(&mut self, now: Instant) -> Option<InventorySync> {
        let pending = self
            .pending_inventory_syncs
            .iter_mut()
            .filter(|pending| pending.retry_at.is_some_and(|retry_at| retry_at <= now))
            .min_by_key(|pending| pending.retry_at)?;
        pending.retry_at = None;
        Some(pending.frame.clone())
    }

    fn idle(&self) -> Duration {
        self.last_acknowledged.elapsed()
    }
}

/// Records a node-control session's connect on creation and its matching
/// disconnect on drop.
///
/// `run_connected_once` has twenty-odd `return ControlRunResult::*` paths —
/// send failures, read failures, idle timeout, shutdown, unauthorized. Asking
/// each of them to remember a `record_disconnected` guarantees one eventually
/// will not. More importantly this state must be owned by the socket task, not
/// the runtime: reporting it from `handle_fleet_control_event` means a wedged
/// event loop never processes `Disconnected`, so the endpoint keeps claiming
/// `connected: true` for a dead socket — the exact failure it exists to
/// diagnose. Drop runs on every exit path, including a panic unwind.
struct ProbeSessionGuard<'a> {
    probe: Option<&'a std::sync::Arc<crate::node_delivery_probe::NodeDeliveryProbe>>,
}

impl<'a> ProbeSessionGuard<'a> {
    fn enter(
        probe: Option<&'a std::sync::Arc<crate::node_delivery_probe::NodeDeliveryProbe>>,
    ) -> Self {
        if let Some(probe) = probe {
            probe.record_connected();
        }
        Self { probe }
    }
}

impl Drop for ProbeSessionGuard<'_> {
    fn drop(&mut self) {
        if let Some(probe) = self.probe {
            probe.record_disconnected();
        }
    }
}

/// An authenticated socket is not yet the authoritative broker provider. The
/// engine can reject node.register while leaving the socket open; sending
/// inventory or heartbeats then updates a fallback provider and masks the loss.
/// Only this request's successful reply opens the application delivery path.
///
/// Also races `command_rx` so a `Shutdown` (or a closed command channel) can
/// interrupt the wait. Without this, a `Shutdown` sent while a connection is
/// mid-registration is stranded: the main command loop below only starts once
/// registration resolves, so on a peer that never replies the caller would
/// retry this gate forever and never observe the request to stop. Every other
/// command received during the wait is queued in the returned `Vec` rather
/// than applied here, so the caller can replay it through the exact same path
/// the main loop uses once this gate opens — preserving the ordering an
/// `UpdateInventory`/`RegisterAgent`/etc. would have had if it had simply
/// arrived a moment later, after the registration reply.
/// Retained completion frames deliberately remain queued in their dedicated
/// receiver during this gate and are consumed only after registration succeeds.
async fn register_node_session<S, R>(
    sink: &mut S,
    stream: &mut R,
    registration: &mut NodeRegister,
    config: &FleetControlConfig,
    command_rx: &mut mpsc::Receiver<FleetControlCommand>,
) -> (Option<bool>, Vec<FleetControlCommand>)
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
    R: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let id = format!("node_register_{}", Uuid::new_v4().simple());
    registration.id = Some(id.clone());
    // Bound both the write and the response, including peers which keep sending
    // pongs or unrelated replies. Tests may use their shorter transport budget.
    let deadline = config
        .read_idle_timeout
        .unwrap_or(Duration::from_secs(10))
        .min(Duration::from_secs(10));
    let mut deferred_commands: Vec<FleetControlCommand> = Vec::new();
    let outcome = tokio::time::timeout(deadline, async {
        if send_wire(sink, &BrokerToRelaycast::NodeRegister(registration.clone())).await.is_err() {
            return Some(false);
        }
        let mut d1_pressure_retry_attempts = 0u32;
        let mut d1_pressure_retry_at: Option<Instant> = None;
        loop {
            let registration_retry_delay = d1_pressure_retry_at
                .map(|retry_at| retry_at.saturating_duration_since(Instant::now()));
            let d1_pressure_retry =
                tokio::time::sleep(registration_retry_delay.unwrap_or(deadline));
            tokio::pin!(d1_pressure_retry);
            tokio::select! {
                _ = &mut d1_pressure_retry, if registration_retry_delay.is_some() => {
                    d1_pressure_retry_at = None;
                    if send_wire(sink, &BrokerToRelaycast::NodeRegister(registration.clone())).await.is_err() {
                        return Some(false);
                    }
                }
                message = stream.next() => {
                    let Some(Ok(message)) = message else { return Some(false); };
                    match message {
                        Message::Text(text) => {
                            if let Some(probe) = config.probe.as_ref() { probe.record_text_frame(); }
                            match serde_json::from_str::<RelaycastToBroker>(&text) {
                                Ok(frame) => {
                                    if let Some(probe) = config.probe.as_ref() { probe.record_frame(&frame); }
                                    match frame {
                                        RelaycastToBroker::Reply(reply) if reply.id == id => return Some(reply.ok),
                                        RelaycastToBroker::Error(error)
                                            if error.id == id && error.code == "d1_pressure" =>
                                        {
                                            d1_pressure_retry_attempts = d1_pressure_retry_attempts.saturating_add(1);
                                            let delay = d1_pressure_retry_delay(d1_pressure_retry_attempts);
                                            tracing::warn!(
                                                target = "relay_broker::fleet",
                                                node_id = %registration.node_id,
                                                id = %error.id,
                                                retry_delay_ms = delay.as_millis(),
                                                "retryable d1_pressure on node registration; retrying on the live control socket"
                                            );
                                            d1_pressure_retry_at = Some(Instant::now() + delay);
                                        }
                                        RelaycastToBroker::Error(error) => {
                                            tracing::error!(code = %error.code, "node registration rejected; reconnecting without advertising delivery readiness");
                                            return Some(false);
                                        }
                                        // The engine replies before replaying deliveries. Never
                                        // acknowledge or inject a frame on an unaccepted provider.
                                        RelaycastToBroker::Deliver(_) | RelaycastToBroker::ActionInvoke(_) => return Some(false),
                                        _ => {},
                                    }
                                }
                                Err(error) => {
                                    if let Some(probe) = config.probe.as_ref() { probe.record_parse_failure(&error.to_string(), &text); }
                                }
                            }
                        }
                        Message::Ping(payload) => {
                            if sink.send(Message::Pong(payload)).await.is_err() { return Some(false); }
                        }
                        Message::Close(_) => return Some(false),
                        _ => {},
                    }
                }
                command = command_rx.recv() => {
                    match command {
                        Some(FleetControlCommand::Shutdown) | None => return None,
                        Some(other) => deferred_commands.push(other),
                    }
                }
            }
        }
    }).await;
    let accepted = match outcome {
        Ok(result) => result,
        Err(_) => Some(false),
    };
    if accepted == Some(false) {
        tracing::warn!("node registration was not accepted within its deadline; delivery unavailable, reconnecting");
    }
    (accepted, deferred_commands)
}

/// Handles one `FleetControlCommand` on an already-registered session — shared
/// by the main command loop in `run_connected_once` and the replay of commands
/// deferred while `register_node_session` was still waiting on the wire, so
/// both paths apply a command identically. `ControlFlow::Break` carries the
/// `ControlRunResult` the caller should return immediately (a disconnect or
/// shutdown); `ControlFlow::Continue` means the session stays up.
#[allow(clippy::too_many_arguments)]
async fn handle_connected_command<S>(
    command: Option<FleetControlCommand>,
    sink: &mut S,
    config: &FleetControlConfig,
    provider: &FleetProviderIdentity,
    node_register: &NodeRegister,
    registration: &mut Option<NodeRegister>,
    load: &mut FleetLoadSnapshot,
    inventory: &mut Vec<InventoryAgent>,
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    pending_deregistrations: &mut HashMap<String, oneshot::Sender<Result<(), String>>>,
    application_liveness: &mut ApplicationLiveness,
    retained_completion: &mut Option<RetainedFleetCompletion>,
) -> std::ops::ControlFlow<ControlRunResult>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    use std::ops::ControlFlow::{Break, Continue};
    match command {
        Some(FleetControlCommand::RegisterNode {
            manifest,
            resume_cursor,
        }) => {
            load.max_agents = manifest.max_agents.unwrap_or(load.max_agents);
            load.handlers_live = true;
            let mut next = build_node_register(
                &manifest,
                &config.node_id,
                &config.node_name,
                &config.broker_version,
                resume_cursor,
            );
            next.provider = Some(provider.clone());
            // Reopen the provider session for a new manifest. Running
            // the registration gate inside this active socket would
            // consume replies belonging to in-flight agent requests.
            *registration = Some(next);
            drain_agent_registrations(pending_agent_registrations, "node_control_reconfiguring");
            for (_, pending) in pending_deregistrations.drain() {
                let _ = pending.send(Err("node_control_reconfiguring".to_string()));
            }
            Break(ControlRunResult::Disconnected {
                application_ready: application_liveness.ready,
            })
        }
        Some(FleetControlCommand::UpdateInventory(next)) => {
            *inventory = next;
            if !send_inventory_sync(
                sink,
                inventory,
                pending_agent_registrations,
                application_liveness,
            )
            .await
            {
                return Break(ControlRunResult::Disconnected {
                    application_ready: application_liveness.ready,
                });
            }
            Continue(())
        }
        Some(FleetControlCommand::UpdateLoad(next)) => {
            *load = next;
            Continue(())
        }
        Some(FleetControlCommand::HeartbeatNow) => {
            if send_wire(
                sink,
                &BrokerToRelaycast::NodeHeartbeat(load.heartbeat(node_register)),
            )
            .await
            .is_err()
            {
                return Break(ControlRunResult::Disconnected {
                    application_ready: application_liveness.ready,
                });
            }
            Continue(())
        }
        Some(FleetControlCommand::Send(message)) => {
            // A `delivery_ack` is the engine's only evidence that a
            // frame was consumed. The runtime records the *decision*
            // to ack before handing it here and cannot wait for the
            // wire, so the probe learns the outcome at the one place
            // that knows it. See `NodeDeliveryProbe::record_ack_sent`.
            let is_ack = matches!(message, BrokerToRelaycast::DeliveryAck(_));
            let sent = send_wire(sink, &message).await;
            if let (true, Some(probe)) = (is_ack, config.probe.as_ref()) {
                if sent.is_ok() {
                    probe.record_ack_sent();
                } else {
                    probe.record_ack_send_failed();
                }
            }
            if sent.is_err() {
                if let BrokerToRelaycast::ActionResult(result) = &message {
                    tracing::warn!(invocation_id = %result.invocation_id, frame_kind = "action.result",
                        "dropping fleet frame after wire send failure");
                }
                return Break(ControlRunResult::Disconnected {
                    application_ready: application_liveness.ready,
                });
            }
            Continue(())
        }
        Some(FleetControlCommand::RetainedSend(completion)) => {
            if send_wire(sink, &completion.message).await.is_err() {
                *retained_completion = Some(completion);
                return Break(ControlRunResult::Disconnected {
                    application_ready: application_liveness.ready,
                });
            }
            let _ = completion.delivered.send(());
            Continue(())
        }
        Some(FleetControlCommand::DeregisterAgent { mut request, reply }) => {
            let request_id = format!("agent_deregister_{}", Uuid::new_v4().simple());
            request.id = Some(request_id.clone());
            pending_deregistrations.retain(|_, pending| !pending.is_closed());
            pending_deregistrations.insert(request_id, reply);
            if send_wire(sink, &BrokerToRelaycast::AgentDeregister(request))
                .await
                .is_err()
            {
                return Break(ControlRunResult::Disconnected {
                    application_ready: application_liveness.ready,
                });
            }
            Continue(())
        }
        Some(FleetControlCommand::RegisterAgent { mut request, reply }) => {
            let request_id = request
                .id
                .clone()
                .unwrap_or_else(|| format!("agent_register_{}", Uuid::new_v4().simple()));
            request.id = Some(request_id.clone());
            pending_agent_registrations.insert(
                request_id,
                PendingAgentRegistration {
                    isolates_channels: request.auto_join_general == Some(false),
                    name: request.name.clone(),
                    reply,
                    created_at: Instant::now(),
                },
            );
            if send_wire(sink, &BrokerToRelaycast::AgentRegister(request))
                .await
                .is_err()
            {
                drain_agent_registrations(pending_agent_registrations, "node_control_disconnected");
                return Break(ControlRunResult::Disconnected {
                    application_ready: application_liveness.ready,
                });
            }
            Continue(())
        }
        Some(FleetControlCommand::Shutdown) | None => {
            drain_agent_registrations(pending_agent_registrations, "node_control_shutdown");
            Break(ControlRunResult::Shutdown)
        }
    }
}

#[cfg(test)]
async fn run_connected_once(
    config: &FleetControlConfig,
    command_rx: &mut mpsc::Receiver<FleetControlCommand>,
    event_tx: &mpsc::Sender<FleetControlEvent>,
    registration: &mut Option<NodeRegister>,
    inventory: &mut Vec<InventoryAgent>,
    load: &mut FleetLoadSnapshot,
    inventory_refresh_interval: Duration,
) -> ControlRunResult {
    let (_completion_tx, mut completion_rx) = mpsc::unbounded_channel();
    let mut retained_completion = None;
    run_connected_once_with_completions(
        config,
        command_rx,
        &mut completion_rx,
        &mut retained_completion,
        event_tx,
        registration,
        inventory,
        load,
        inventory_refresh_interval,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_connected_once_with_completions(
    config: &FleetControlConfig,
    command_rx: &mut mpsc::Receiver<FleetControlCommand>,
    completion_rx: &mut mpsc::UnboundedReceiver<RetainedFleetCompletion>,
    retained_completion: &mut Option<RetainedFleetCompletion>,
    event_tx: &mpsc::Sender<FleetControlEvent>,
    registration: &mut Option<NodeRegister>,
    inventory: &mut Vec<InventoryAgent>,
    load: &mut FleetLoadSnapshot,
    inventory_refresh_interval: Duration,
) -> ControlRunResult {
    let Some(mut node_register) = registration.clone() else {
        return ControlRunResult::ConnectFailed;
    };
    let Some(node_token) = config.node_token.as_deref() else {
        return ControlRunResult::ConnectFailed;
    };

    // A fresh provider instance per connection: reconnecting with a new
    // instance_id replaces the previous attachment (the engine's
    // reconnect-vs-duplicate arbitration). The broker attaches as the "broker"
    // provider, distinct from any capability providers on the same node.
    let provider = FleetProviderIdentity {
        name: BROKER_PROVIDER_NAME.to_string(),
        instance_id: format!("broker_{}", Uuid::new_v4().simple()),
    };
    node_register.provider = Some(provider.clone());
    *registration = Some(node_register.clone());

    let mut request = match config.ws_url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => {
            tracing::warn!(target = "relay_broker::fleet", error = %error, "invalid fleet node ws url");
            return ControlRunResult::ConnectFailed;
        }
    };
    let header = format!("Bearer {}", node_token.trim());
    match header.parse() {
        Ok(value) => {
            request.headers_mut().insert("authorization", value);
        }
        Err(error) => {
            tracing::warn!(target = "relay_broker::fleet", error = %error, "invalid fleet node token header");
            return ControlRunResult::ConnectFailed;
        }
    }

    // Telemetry attribution for the node session the gateway opens off this
    // handshake. Both are best-effort: a header that won't parse is skipped, it
    // never fails the connection.
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

    let (ws, _) = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    {
        Ok(Ok(connected)) => connected,
        Ok(Err(error)) => {
            tracing::warn!(target = "relay_broker::fleet", url = %config.ws_url, error = %error, "fleet node ws connect failed");
            if connect_error_is_unauthorized(&error) {
                return ControlRunResult::Unauthorized;
            }
            return ControlRunResult::ConnectFailed;
        }
        Err(_) => {
            tracing::warn!(
                target = "relay_broker::fleet",
                url = %config.ws_url,
                timeout_secs = CONNECT_TIMEOUT.as_secs(),
                "fleet node ws connect attempt timed out"
            );
            return ControlRunResult::ConnectFailed;
        }
    };
    tracing::info!(
        target = "relay_broker::fleet",
        node_id = %config.node_id,
        "node-control transition: transport connected; awaiting application acknowledgement"
    );
    // Socket-owned connectivity: armed here, released by Drop on every exit.
    let _probe_session = ProbeSessionGuard::enter(config.probe.as_ref());
    let (mut sink, mut stream) = ws.split();
    let mut pending_agent_registrations: HashMap<String, PendingAgentRegistration> = HashMap::new();
    let mut pending_deregistrations: HashMap<String, oneshot::Sender<Result<(), String>>> =
        HashMap::new();
    let read_idle_timeout = config.read_idle_timeout.unwrap_or(READ_IDLE_TIMEOUT);
    // inventory.sync is the existing request/reply application probe. Allow two
    // complete refresh periods before declaring it unacknowledged, while never
    // making the application deadline tighter than the transport deadline.
    let application_liveness_timeout = inventory_refresh_interval
        .checked_mul(2)
        .unwrap_or(Duration::MAX)
        .max(read_idle_timeout);
    let mut application_liveness = ApplicationLiveness::new(application_liveness_timeout);

    let deferred_commands = match register_node_session(
        &mut sink,
        &mut stream,
        &mut node_register,
        config,
        command_rx,
    )
    .await
    {
        (None, deferred_commands) => {
            fail_deferred_commands(deferred_commands, "node_control_shutdown", inventory, load);
            return ControlRunResult::Shutdown;
        }
        (Some(false), deferred_commands) => {
            fail_deferred_commands(deferred_commands, "node_not_registered", inventory, load);
            return ControlRunResult::Disconnected {
                application_ready: false,
            };
        }
        (Some(true), deferred_commands) => deferred_commands,
    };
    *registration = Some(node_register.clone());
    let _ = event_tx.send(FleetControlEvent::Connected).await;
    if !send_inventory_sync(
        &mut sink,
        inventory,
        &mut pending_agent_registrations,
        &mut application_liveness,
    )
    .await
    {
        return ControlRunResult::Disconnected {
            application_ready: false,
        };
    }
    if send_wire(
        &mut sink,
        &BrokerToRelaycast::NodeHeartbeat(load.heartbeat(&node_register)),
    )
    .await
    .is_err()
    {
        return ControlRunResult::Disconnected {
            application_ready: false,
        };
    }

    // The idle check runs on the heartbeat tick, so the tick must be shorter
    // than the window it polices; an overridden (test) window keeps that ratio.
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL.min(read_idle_timeout / 4));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut inventory_refresh = tokio::time::interval(inventory_refresh_interval);
    inventory_refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Tokio intervals tick immediately. The initial inventory.sync above has
    // already renewed the lease, so schedule the first refresh one full period
    // from now instead of duplicating it on connection setup.
    inventory_refresh.tick().await;
    let mut last_inbound = Instant::now();

    // Commands that arrived while `register_node_session` was still waiting on
    // the wire are replayed here, in the order received, through the exact
    // same handling the main loop below uses — so an `UpdateInventory` that
    // raced the registration reply still triggers its own `inventory.sync`
    // push (rather than silently folding into the one already sent) and a
    // `RegisterAgent`/`DeregisterAgent` still gets a wire round trip instead
    // of the early rejection `register_node_session` gives commands it can't
    // service pre-connection.
    let mut deferred_commands = deferred_commands.into_iter();
    for deferred in deferred_commands.by_ref() {
        if let std::ops::ControlFlow::Break(result) = handle_connected_command(
            Some(deferred),
            &mut sink,
            config,
            &provider,
            &node_register,
            registration,
            load,
            inventory,
            &mut pending_agent_registrations,
            &mut pending_deregistrations,
            &mut application_liveness,
            retained_completion,
        )
        .await
        {
            // The command that broke out already got its outcome (a wire
            // failure, or a Shutdown handled like any other command here);
            // anything still queued behind it in this replay never got a
            // turn and must not be silently dropped, the same as a rejected
            // registration's leftovers above.
            let reason = if matches!(result, ControlRunResult::Shutdown) {
                "node_control_shutdown"
            } else {
                "node_control_disconnected"
            };
            fail_deferred_commands(deferred_commands.collect(), reason, inventory, load);
            return result;
        }
    }

    loop {
        let inventory_retry_delay = application_liveness.next_retry_delay(Instant::now());
        let inventory_retry =
            tokio::time::sleep(inventory_retry_delay.unwrap_or(application_liveness.deadline));
        tokio::pin!(inventory_retry);
        tokio::select! {
            _ = &mut inventory_retry, if inventory_retry_delay.is_some() => {
                let Some(frame) = application_liveness.take_due_retry(Instant::now()) else {
                    continue;
                };
                if send_wire(&mut sink, &BrokerToRelaycast::InventorySync(frame)).await.is_err() {
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                }
            }
            command = recv_control_command(command_rx, completion_rx, retained_completion) => {
                if let std::ops::ControlFlow::Break(result) = handle_connected_command(
                    command,
                    &mut sink,
                    config,
                    &provider,
                    &node_register,
                    registration,
                    load,
                    inventory,
                    &mut pending_agent_registrations,
                    &mut pending_deregistrations,
                    &mut application_liveness,
                    retained_completion,
                )
                .await
                {
                    return result;
                }
            }
            _ = heartbeat.tick() => {
                expire_agent_registrations(&mut pending_agent_registrations, Instant::now());
                // Checked before the write, because the write is exactly what
                // cannot be trusted here: it keeps succeeding on a blackholed
                // socket. Silence past the window is the only local evidence
                // that the engine stopped hearing us.
                // `>=`, not `>`: the check runs at the top of each tick, so on a
                // blackholed connection `idle` lands exactly on the window at
                // the fourth tick. A strict `>` would miss that boundary and
                // disconnect a whole interval late (60s, five intervals), which
                // is not the four-interval budget documented above.
                let idle = last_inbound.elapsed();
                if idle >= read_idle_timeout {
                    tracing::warn!(
                        target = "relay_broker::fleet",
                        idle_secs = idle.as_secs(),
                        "no inbound node-control frame within the read-idle window; reconnecting"
                    );
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                }
                let application_idle = application_liveness.idle();
                if application_idle >= application_liveness.deadline {
                    tracing::warn!(
                        target = "relay_broker::fleet",
                        node_id = %config.node_id,
                        application_idle_ms = application_idle.as_millis(),
                        application_deadline_ms = application_liveness.deadline.as_millis(),
                        transport_idle_ms = idle.as_millis(),
                        pending_inventory_syncs = application_liveness.pending_inventory_syncs.len(),
                        "node-control application acknowledgement deadline exceeded while transport remained active; reconnecting"
                    );
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                }
                if send_wire(&mut sink, &BrokerToRelaycast::NodeHeartbeat(load.heartbeat(&node_register))).await.is_err() {
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                }
                // Guarantees the peer owes us a frame every interval, so an idle
                // engine is distinguishable from a dead connection.
                if send_ws_frame(&mut sink, Message::Ping(Vec::new())).await.is_err() {
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                }
            }
            _ = inventory_refresh.tick() => {
                if !send_inventory_sync(
                    &mut sink,
                    inventory,
                    &mut pending_agent_registrations,
                    &mut application_liveness,
                )
                .await
                {
                    return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                }
            }
            message = stream.next() => {
                let Some(message) = message else {
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                };
                let message = match message {
                    Ok(message) => message,
                    Err(error) => {
                        tracing::warn!(target = "relay_broker::fleet", error = %error, "fleet node ws read failed");
                        drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                        return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                    }
                };
                // Any frame proves the peer is still there — including the pong
                // answering our ping, which is the only traffic a healthy but
                // idle engine is guaranteed to send.
                last_inbound = Instant::now();
                if !handle_server_message(
                    message,
                    event_tx,
                    &mut pending_agent_registrations,
                    &mut pending_deregistrations,
                    &mut application_liveness,
                    &config.node_id,
                    &mut sink,
                    config.probe.as_ref(),
                    config.terminal_reconnect_tx.as_ref(),
                )
                .await
                {
                    drain_agent_registrations(&mut pending_agent_registrations, "node_control_disconnected");
                    return ControlRunResult::Disconnected { application_ready: application_liveness.ready };
                }
            }
        }
    }
}

async fn send_inventory_sync<S>(
    sink: &mut S,
    inventory: &[InventoryAgent],
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    application_liveness: &mut ApplicationLiveness,
) -> bool
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let request_id = format!("inventory_sync_{}", Uuid::new_v4().simple());
    let frame = InventorySync {
        v: FLEET_WIRE_VERSION,
        id: Some(request_id),
        agents: inventory.to_vec(),
    };
    if send_wire(sink, &BrokerToRelaycast::InventorySync(frame.clone()))
        .await
        .is_err()
    {
        drain_agent_registrations(pending_agent_registrations, "node_control_disconnected");
        return false;
    }
    application_liveness.track_inventory_sync(frame);

    true
}

#[allow(clippy::too_many_arguments)]
async fn handle_server_message<S>(
    message: Message,
    event_tx: &mpsc::Sender<FleetControlEvent>,
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    pending_deregistrations: &mut HashMap<String, oneshot::Sender<Result<(), String>>>,
    application_liveness: &mut ApplicationLiveness,
    node_id: &str,
    sink: &mut S,
    probe: Option<&std::sync::Arc<crate::node_delivery_probe::NodeDeliveryProbe>>,
    terminal_reconnect_tx: Option<&watch::Sender<Option<u64>>>,
) -> bool
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    match message {
        Message::Text(text) => {
            // Counted before `from_str`, deliberately. `ServerToNode` is
            // `#[serde(tag = "type")]`, so a `deliver` carrying a field this
            // build cannot parse fails as a whole and is dropped at the `Err`
            // arm below. Counting only successfully-parsed frames would report
            // "no deliver frames arrived" for a broker that is in fact
            // receiving deliveries and throwing them away.
            if let Some(probe) = probe {
                probe.record_text_frame();
            }
            match serde_json::from_str::<RelaycastToBroker>(&text) {
                Ok(frame) => {
                    // Publish before the bounded FleetControlEvent queue. If
                    // runtime handling is delayed, a terminal dial that becomes
                    // ready in the meantime can still fence this generation as
                    // already repaired; the later runtime event is a coalesced
                    // duplicate rather than a reason to tear down the fresh lane.
                    if let (
                        RelaycastToBroker::TerminalReconnectRequested(request),
                        Some(reconnect_tx),
                    ) = (&frame, terminal_reconnect_tx)
                    {
                        crate::terminal_control::request_terminal_reconnect(
                            reconnect_tx,
                            request.generation,
                        );
                    }
                    if let Some(probe) = probe {
                        probe.record_frame(&frame);
                    }
                    match frame {
                        RelaycastToBroker::Reply(reply) => {
                            if reply.id.starts_with(crate::runtime::task_request_prefix()) {
                                return event_tx
                                    .send(FleetControlEvent::Message(RelaycastToBroker::Reply(
                                        reply,
                                    )))
                                    .await
                                    .is_ok();
                            }
                            if let Some(pending) = pending_deregistrations.remove(&reply.id) {
                                let result = if reply.ok {
                                    Ok(())
                                } else {
                                    Err("agent_deregister_rejected".to_string())
                                };
                                let _ = pending.send(result);
                                return true;
                            }

                            // A correlated reply proves the transport is alive, but only
                            // `ok: true` proves the application processed it. Crediting a
                            // rejection as an acknowledgement would let a relaycast that
                            // keeps refusing inventory.sync still read as "ready" — the
                            // exact failure mode this liveness check exists to catch.
                            let liveness_outcome = if reply.ok {
                                application_liveness.acknowledge(&reply.id)
                            } else {
                                application_liveness.reject(&reply.id).then_some(false)
                            };
                            match liveness_outcome {
                                Some(became_ready) => {
                                    if became_ready {
                                        tracing::info!(
                                            target = "relay_broker::fleet",
                                            node_id,
                                            "node-control transition: application acknowledgement received; control link ready"
                                        );
                                    }
                                    true
                                }
                                None => {
                                    complete_agent_registration(
                                        reply,
                                        pending_agent_registrations,
                                        sink,
                                    )
                                    .await
                                }
                            }
                        }
                        RelaycastToBroker::Error(error) => {
                            if error.id.starts_with(crate::runtime::task_request_prefix()) {
                                return event_tx
                                    .send(FleetControlEvent::Message(RelaycastToBroker::Error(
                                        error,
                                    )))
                                    .await
                                    .is_ok();
                            }
                            if let Some(pending) = pending_deregistrations.remove(&error.id) {
                                let _ =
                                    pending.send(Err(format!("{}: {}", error.code, error.message)));
                                return true;
                            }
                            if error.code == "invalid_message" {
                                fail_unsupported_channel_isolation(
                                    &error.message,
                                    pending_agent_registrations,
                                );
                            }
                            // Surface every engine rejection at error level. A node.register or
                            // heartbeat rejection (e.g. node_name_conflict) matches no pending
                            // agent registration below, so without this it vanishes silently —
                            // leaving the node half-registered with dead heartbeats and no signal.
                            tracing::error!(
                                target = "relay_broker::fleet",
                                code = %error.code,
                                message = %error.message,
                                id = %error.id,
                                "engine rejected a node control frame"
                            );
                            fail_agent_registration(
                                &error.id,
                                format!("{}: {}", error.code, error.message),
                                pending_agent_registrations,
                            );
                            if error.code == "d1_pressure" {
                                if application_liveness.discard_superseded(&error.id) {
                                    tracing::debug!(
                                        target = "relay_broker::fleet",
                                        node_id,
                                        id = %error.id,
                                        "consumed d1_pressure for a superseded inventory sync"
                                    );
                                    return true;
                                }
                                if let Some(delay) = application_liveness
                                    .schedule_d1_pressure_retry(&error.id, Instant::now())
                                {
                                    tracing::warn!(
                                        target = "relay_broker::fleet",
                                        node_id,
                                        id = %error.id,
                                        retry_delay_ms = delay.as_millis(),
                                        "retryable d1_pressure on inventory sync; retry scheduled on the live control socket"
                                    );
                                    return true;
                                }
                            }
                            let rejected_liveness_probe = application_liveness.reject(&error.id);
                            // A reply proves the application is responsive, but rejecting
                            // the authoritative inventory probe means the control session
                            // is not healthy enough to advertise; replace it immediately.
                            !rejected_liveness_probe
                        }
                        other => event_tx
                            .send(FleetControlEvent::Message(other))
                            .await
                            .is_ok(),
                    }
                }
                Err(error) => {
                    // This arm is where an unparseable `deliver` dies. With
                    // `RUST_LOG` unset the warning below goes nowhere, which is
                    // why the probe records the failure as state instead.
                    if let Some(probe) = probe {
                        probe.record_parse_failure(&error.to_string(), &text);
                    }
                    tracing::warn!(target = "relay_broker::fleet", error = %error, "invalid fleet node ws frame");
                    true
                }
            }
        }
        Message::Ping(_) => true,
        Message::Close(_) => false,
        _ => true,
    }
}

async fn complete_agent_registration<S>(
    reply: crate::fleet_wire::Reply,
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    sink: &mut S,
) -> bool
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let request_id = reply.id.clone();
    // The engine replies to node-control requests such as `node.register`, but
    // only `agent.register` replies correspond to a pending registration.
    // Correlated `inventory.sync` replies have already been consumed by the
    // application-liveness tracker above. To stay robust we:
    //   1. match on the echoed request id (the happy path), then
    //   2. fall back to matching the validated reply `data.name` against a
    //      pending entry (covers an engine that drops/regenerates the id), and
    //   3. treat a reply that resolves to neither as a non-agent reply and log
    //      it at debug — never a spurious "did not match" warning.
    let data = reply.validate_agent_register_data().ok();
    let resolved = pending_agent_registrations
        .remove(&request_id)
        .map(|pending| (request_id.clone(), pending))
        .or_else(|| {
            let name = data.as_ref()?.name.as_deref()?;
            let key = pending_agent_registrations
                .iter()
                .find(|(_, pending)| pending.name == name)
                .map(|(key, _)| key.clone())?;
            pending_agent_registrations
                .remove(&key)
                .map(|pending| (key, pending))
        });
    let Some((request_id, pending)) = resolved else {
        tracing::debug!(
            target = "relay_broker::fleet",
            id = %request_id,
            "node-control reply did not match a pending agent.register (likely a node.register reply)"
        );
        return true;
    };
    let data = match data {
        Some(data) => data,
        None => {
            let _ = pending
                .reply
                .send(Err("invalid_agent_register_reply_data".to_string()));
            return true;
        }
    };
    let token = AgentRegistrationToken {
        name: data.name.unwrap_or_else(|| pending.name.clone()),
        agent_id: data.agent_id,
        token: data.token,
        delivery_ack_seq: data.delivery_ack_seq,
    };
    match pending.reply.send(Ok(token.clone())) {
        Ok(()) => true,
        Err(Ok(token)) => {
            tracing::warn!(
                target = "relay_broker::fleet",
                id = %request_id,
                name = %pending.name,
                agent_id = %token.agent_id,
                "late agent.register success after caller stopped waiting; sending compensating agent.deregister"
            );
            send_wire(
                sink,
                &BrokerToRelaycast::AgentDeregister(AgentDeregister {
                    v: FLEET_WIRE_VERSION,
                    id: Some(request_id),
                    agent_id: token.agent_id,
                    name: Some(pending.name),
                }),
            )
            .await
            .is_ok()
        }
        Err(Err(_)) => true,
    }
}

fn fail_agent_registration(
    id: &str,
    reason: String,
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
) {
    if let Some(pending) = pending_agent_registrations.remove(id) {
        let _ = pending.reply.send(Err(reason));
    }
}

/// Older strict schemas cannot echo the request id when parsing fails. Only
/// reject registrations using the specifically rejected extension; unrelated
/// schema errors and legacy registrations keep their normal correlation.
fn fail_unsupported_channel_isolation(
    message: &str,
    pending: &mut HashMap<String, PendingAgentRegistration>,
) {
    let Ok(serde_json::Value::Array(issues)) = serde_json::from_str::<serde_json::Value>(message)
    else {
        return;
    };
    let rejected = issues.iter().any(|issue| {
        issue["code"] == "unrecognized_keys"
            && issue["path"].as_array().is_some_and(Vec::is_empty)
            && issue["keys"]
                .as_array()
                .is_some_and(|keys| keys.iter().any(|key| key == "auto_join_general"))
    });
    if !rejected {
        return;
    }
    let incompatible: Vec<_> = pending
        .iter()
        .filter(|(_, entry)| entry.isolates_channels)
        .map(|(id, _)| id.clone())
        .collect();
    for id in incompatible {
        fail_agent_registration(
            &id,
            "agent_register_unsupported_channel_isolation: engine upgrade required".to_string(),
            pending,
        );
    }
}

fn expire_agent_registrations(
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    now: Instant,
) {
    let expired: Vec<String> = pending_agent_registrations
        .iter()
        .filter_map(|(id, pending)| {
            (now.saturating_duration_since(pending.created_at) >= REGISTER_AGENT_PENDING_TTL)
                .then_some(id.clone())
        })
        .collect();

    for id in expired {
        if let Some(pending) = pending_agent_registrations.remove(&id) {
            tracing::warn!(
                target = "relay_broker::fleet",
                id = %id,
                name = %pending.name,
                "agent.register pending reply expired without engine response"
            );
            let _ = pending
                .reply
                .send(Err("agent_register_pending_expired".to_string()));
        }
    }
}

fn drain_agent_registrations(
    pending_agent_registrations: &mut HashMap<String, PendingAgentRegistration>,
    reason: &str,
) {
    for (_, pending) in pending_agent_registrations.drain() {
        let _ = pending.reply.send(Err(reason.to_string()));
    }
}

/// Finalizes commands `register_node_session` deferred but that this
/// connection attempt cannot service — either the wire gate rejected/timed
/// out, or a `Shutdown` cut the wait short. Silently dropping these would
/// strand `RegisterAgent`/`DeregisterAgent` callers until their own reply
/// timeout and lose an `UpdateInventory`/`UpdateLoad` update entirely, since
/// (unlike a command still sitting in `command_rx`) they were already taken
/// out of the channel. `RegisterNode`/`Send`/`HeartbeatNow` are dropped, the
/// same as `handle_disconnected_command` does before the first connection.
fn fail_deferred_commands(
    commands: Vec<FleetControlCommand>,
    reason: &str,
    inventory: &mut Vec<InventoryAgent>,
    load: &mut FleetLoadSnapshot,
) {
    for command in commands {
        match command {
            FleetControlCommand::RegisterAgent { reply, .. } => {
                let _ = reply.send(Err(reason.to_string()));
            }
            FleetControlCommand::DeregisterAgent { reply, .. } => {
                let _ = reply.send(Err(reason.to_string()));
            }
            // Preserved for the next connection attempt rather than lost:
            // these only update local state, so there is no wire round trip
            // to retry, just a value to carry forward.
            FleetControlCommand::UpdateInventory(next) => *inventory = next,
            FleetControlCommand::UpdateLoad(next) => *load = next,
            FleetControlCommand::RegisterNode { .. }
            | FleetControlCommand::Send(_)
            | FleetControlCommand::RetainedSend(_)
            | FleetControlCommand::HeartbeatNow => {}
            FleetControlCommand::Shutdown => {}
        }
    }
}

async fn send_wire<S>(sink: &mut S, message: &BrokerToRelaycast) -> Result<()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let text = serde_json::to_string(message)?;
    send_ws_frame(sink, Message::Text(text)).await
}

async fn send_ws_frame<S>(sink: &mut S, message: Message) -> Result<()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    match tokio::time::timeout(WRITE_TIMEOUT, sink.send(message)).await {
        Ok(result) => {
            result?;
            Ok(())
        }
        Err(_) => {
            tracing::warn!(
                target = "relay_broker::fleet",
                timeout_secs = WRITE_TIMEOUT.as_secs(),
                "fleet node websocket write timed out; treating control link as unhealthy"
            );
            Err(anyhow::anyhow!("fleet node websocket write timed out"))
        }
    }
}

pub(crate) fn delivery_ack(agent: impl Into<String>, up_to_seq: u64) -> BrokerToRelaycast {
    BrokerToRelaycast::DeliveryAck(DeliveryAck {
        v: FLEET_WIRE_VERSION,
        id: None,
        agent: agent.into(),
        up_to_seq,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use httpmock::{Method::POST, MockServer};
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
    use tokio_tungstenite::{accept_async, accept_hdr_async};

    use super::*;
    use crate::fleet_wire::{
        ActionInvoke, ActionResult, ActionResultError, ActionResultOutput, ActionResultPayload,
        DeliveryMode, TerminalReconnectRequested,
    };

    #[tokio::test]
    async fn retained_completion_lane_preempts_a_full_control_queue() {
        let (command_tx, mut command_rx) = mpsc::channel(1);
        command_tx
            .try_send(FleetControlCommand::UpdateInventory(Vec::new()))
            .unwrap();
        let (completion_tx, mut completion_rx) = mpsc::unbounded_channel();
        let (delivered, _delivered_rx) = oneshot::channel();
        completion_tx
            .send(RetainedFleetCompletion {
                message: BrokerToRelaycast::ActionResult(ActionResult {
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    invocation_id: "inv-retained".to_string(),
                    result: ActionResultPayload::Error(ActionResultError {
                        error: "cleanup unconfirmed".to_string(),
                    }),
                    task: None,
                }),
                delivered,
            })
            .unwrap();

        let mut retained_completion = None;
        let command = recv_control_command(
            &mut command_rx,
            &mut completion_rx,
            &mut retained_completion,
        )
        .await
        .expect("the dedicated completion lane should stay readable");
        assert!(matches!(
            command,
            FleetControlCommand::RetainedSend(RetainedFleetCompletion {
                message: BrokerToRelaycast::ActionResult(ActionResult { invocation_id, .. }),
                ..
            }) if invocation_id == "inv-retained"
        ));
        assert!(matches!(
            command_rx.try_recv(),
            Ok(FleetControlCommand::UpdateInventory(inventory)) if inventory.is_empty()
        ));
    }

    #[tokio::test]
    async fn retained_completion_lane_drains_buffer_after_sender_closes() {
        let (_command_tx, mut command_rx) = mpsc::channel(1);
        let (completion_tx, mut completion_rx) = mpsc::unbounded_channel();
        let (delivered, _delivered_rx) = oneshot::channel();
        completion_tx
            .send(RetainedFleetCompletion {
                message: BrokerToRelaycast::ActionResult(ActionResult {
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    invocation_id: "inv-buffered-before-close".to_string(),
                    result: ActionResultPayload::Error(ActionResultError {
                        error: "cleanup unconfirmed".to_string(),
                    }),
                    task: None,
                }),
                delivered,
            })
            .unwrap();
        drop(completion_tx);

        let mut retained_completion = None;
        let command = recv_control_command(
            &mut command_rx,
            &mut completion_rx,
            &mut retained_completion,
        )
        .await
        .expect("a buffered completion must remain readable after sender close");
        assert!(matches!(
            command,
            FleetControlCommand::RetainedSend(RetainedFleetCompletion {
                message: BrokerToRelaycast::ActionResult(ActionResult { invocation_id, .. }),
                ..
            }) if invocation_id == "inv-buffered-before-close"
        ));
    }

    #[tokio::test]
    async fn retained_completion_requeues_when_the_socket_write_fails() {
        let mut sink = Box::pin(futures_util::sink::unfold((), |(), _: Message| async {
            Err::<(), std::io::Error>(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "fixture socket closed",
            ))
        }));
        let config = FleetControlConfig {
            ws_url: "ws://127.0.0.1:1/v1/node/ws".to_string(),
            node_token: Some("nt_test".to_string()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_minter: None,
            session_token: None,
            read_idle_timeout: None,
            probe: None,
            terminal_reconnect_tx: None,
        };
        let provider = FleetProviderIdentity {
            name: BROKER_PROVIDER_NAME.to_string(),
            instance_id: "broker-fixture".to_string(),
        };
        let node_register = build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        );
        let mut registration = Some(node_register.clone());
        let mut load = FleetLoadSnapshot::default();
        let mut inventory = Vec::new();
        let mut pending_agent_registrations = HashMap::new();
        let mut pending_deregistrations = HashMap::new();
        let mut application_liveness = ApplicationLiveness::new(Duration::from_secs(1));
        let (delivered, mut delivery_ack) = oneshot::channel();
        let mut retained_completion = None;

        let result = handle_connected_command(
            Some(FleetControlCommand::RetainedSend(RetainedFleetCompletion {
                message: BrokerToRelaycast::ActionResult(ActionResult {
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    invocation_id: "inv-retry-after-write".to_string(),
                    result: ActionResultPayload::Error(ActionResultError {
                        error: "cleanup unconfirmed".to_string(),
                    }),
                    task: None,
                }),
                delivered,
            })),
            &mut sink,
            &config,
            &provider,
            &node_register,
            &mut registration,
            &mut load,
            &mut inventory,
            &mut pending_agent_registrations,
            &mut pending_deregistrations,
            &mut application_liveness,
            &mut retained_completion,
        )
        .await;

        assert!(matches!(
            result,
            std::ops::ControlFlow::Break(ControlRunResult::Disconnected { .. })
        ));
        assert!(matches!(
            delivery_ack.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            retained_completion,
            Some(RetainedFleetCompletion {
                message: BrokerToRelaycast::ActionResult(ActionResult { invocation_id, .. }),
                ..
            }) if invocation_id == "inv-retry-after-write"
        ));
    }

    fn seed_authoritative_cursor(
        book: &mut FleetDeliveryBook,
        agent: &str,
        agent_id: &str,
        up_to_seq: u64,
    ) {
        book.bind_authoritative_identity(agent, agent_id);
        book.seed_cursor(agent, agent_id, up_to_seq);
    }

    fn test_delivery(agent: &str, agent_id: &str, seq: u64) -> Deliver {
        Deliver {
            v: FLEET_WIRE_VERSION,
            agent: agent.to_string(),
            agent_id: agent_id.to_string(),
            delivery_id: format!("delivery-{agent_id}-{seq}"),
            msg_id: format!("message-{agent_id}-{seq}"),
            seq,
            mode: DeliveryMode::Wait,
            payload: json!({"type": "message.created", "text": "test"}),
        }
    }

    fn test_inventory_sync(id: &str) -> InventorySync {
        InventorySync {
            v: FLEET_WIRE_VERSION,
            id: Some(id.to_string()),
            agents: Vec::new(),
        }
    }

    async fn read_http_request(socket: &mut TcpStream) -> String {
        let mut buffer = [0_u8; 8192];
        let read = socket.read(&mut buffer).await.unwrap();
        String::from_utf8_lossy(&buffer[..read]).into_owned()
    }

    fn http_request_header(request: &str, name: &str) -> Option<String> {
        request.lines().find_map(|line| {
            let (found_name, value) = line.split_once(':')?;
            found_name
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
    }

    async fn write_create_node_success(socket: &mut TcpStream, token: &str) {
        let body = json!({
            "ok": true,
            "data": {
                "id": "node-test",
                "name": "host-test",
                "kind": "ws",
                "role": "broker",
                "version": "broker/test",
                "status": "online",
                "live": true,
                "handlers_live": true,
                "load": 0.0,
                "active_agents": 0,
                "max_agents": 0,
                "created_at": "2026-10-04T00:00:00Z",
                "token": token
            }
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    #[test]
    fn derive_node_id_is_stable_for_same_seed_and_cwd() {
        let a = derive_node_id("node_seed123", "/Users/will/Projects/relay", "workspace-a");
        let b = derive_node_id("node_seed123", "/Users/will/Projects/relay", "workspace-a");
        assert_eq!(
            a, b,
            "same (seed, cwd, workspace) must derive an identical node id"
        );
    }

    #[test]
    fn derive_node_id_differs_across_working_directories() {
        let seed = "node_seed123";
        let workspace_id = "workspace-a";
        let a = derive_node_id(seed, "/Users/will/Projects/workspace-a", workspace_id);
        let b = derive_node_id(seed, "/Users/will/Projects/workspace-b", workspace_id);
        assert_ne!(
            a, b,
            "different cwd on the same machine must derive distinct node ids"
        );
    }

    #[test]
    fn derive_node_id_differs_across_workspaces() {
        let seed = "node_seed123";
        let cwd = "/Users/will/Projects/relay";
        let a = derive_node_id(seed, cwd, "workspace-a");
        let b = derive_node_id(seed, cwd, "workspace-b");
        assert_ne!(
            a, b,
            "same seed and cwd under different workspaces must derive distinct node ids"
        );
    }

    #[test]
    fn derive_node_id_differs_across_seeds() {
        let cwd = "/Users/will/Projects/relay";
        let workspace_id = "workspace-a";
        let a = derive_node_id("seed-a", cwd, workspace_id);
        let b = derive_node_id("seed-b", cwd, workspace_id);
        assert_ne!(
            a, b,
            "different machine seeds must derive distinct node ids"
        );
    }

    #[test]
    fn derive_node_id_has_node_prefix_and_32_hex_suffix() {
        let id = derive_node_id("node_seed123", "/Users/will/Projects/relay", "workspace-a");
        let suffix = id
            .strip_prefix("node_")
            .expect("derived node id must start with node_");
        assert_eq!(suffix.len(), 32, "suffix must be 32 hex chars");
        assert!(
            suffix.chars().all(|c| c.is_ascii_hexdigit()),
            "suffix must be lowercase hex: {suffix}"
        );
        assert!(
            suffix.chars().all(|c| !c.is_ascii_uppercase()),
            "suffix must be lowercase hex: {suffix}"
        );
    }

    #[tokio::test]
    async fn mint_node_token_does_not_retry_non_retryable_4xx() {
        let server = MockServer::start();
        let create_node = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/nodes")
                .header("authorization", "Bearer rk_live_test");
            then.status(403).json_body(json!({
                "ok": false,
                "error": {
                    "code": "forbidden",
                    "message": "node creation is not allowed"
                }
            }));
        });

        let error = mint_node_token(
            "rk_live_test",
            Some(&server.base_url()),
            create_node_request("node_abc", "local-node", "relay-broker/test"),
            None,
            None,
            MintNodeTokenLogContext {
                node_id: "node_abc",
                workspace_id: "ws_test",
            },
        )
        .await
        .expect_err("403 create_node response should fail");

        create_node.assert_hits(1);
        assert_eq!(error.status(), Some(403));
        assert_eq!(error.code(), Some("forbidden"));
        assert!(
            error
                .response_body()
                .is_some_and(|body| body.contains("node creation is not allowed")),
            "error should preserve response body: {error:?}"
        );
    }

    #[tokio::test]
    async fn mint_node_token_sends_current_node_token_as_header_proof() {
        let server = MockServer::start();
        let create_node = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/nodes")
                .header("authorization", "Bearer rk_live_test")
                .header("x-relaycast-node-token", "nt_live_current")
                .header(
                    "idempotency-key",
                    "node-rotation:00000000-0000-4000-8000-000000000001",
                );
            then.status(201).json_body(json!({
                "ok": true,
                "data": {
                    "id": "node_abc",
                    "name": "local-node",
                    "kind": "ws",
                    "role": "broker",
                    "version": "relay-broker/test",
                    "status": "offline",
                    "live": false,
                    "handlers_live": false,
                    "load": null,
                    "active_agents": 0,
                    "max_agents": 0,
                    "created_at": "2026-10-04T00:00:00Z",
                    "token": "nt_live_rotated"
                }
            }));
        });

        let token = mint_node_token(
            "rk_live_test",
            Some(&server.base_url()),
            create_node_request("node_abc", "local-node", "relay-broker/test"),
            Some("nt_live_current"),
            Some("node-rotation:00000000-0000-4000-8000-000000000001"),
            MintNodeTokenLogContext {
                node_id: "node_abc",
                workspace_id: "ws_test",
            },
        )
        .await
        .expect("current node token should be sent as rotation proof");

        create_node.assert_hits(1);
        assert_eq!(token, "nt_live_rotated");
    }

    #[test]
    fn node_token_proof_conflict_is_terminal_only_for_the_named_server_error() {
        let proof_conflict = CreateNodeMintError::Api {
            status: 409,
            code: "node_token_proof_required".to_string(),
            message: "current token required".to_string(),
            body: String::new(),
        };
        assert!(is_node_token_proof_conflict(&proof_conflict));

        for (status, code) in [
            (403, "node_token_proof_required"),
            (409, "node_name_conflict"),
        ] {
            assert!(!is_node_token_proof_conflict(&CreateNodeMintError::Api {
                status,
                code: code.to_string(),
                message: "not the terminal proof conflict".to_string(),
                body: String::new(),
            }));
        }
    }

    #[tokio::test]
    async fn mint_node_token_preserves_5xx_status_and_body_after_retries() {
        let server = MockServer::start();
        let create_node = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/nodes")
                .header("authorization", "Bearer rk_live_test");
            then.status(500).json_body(json!({
                "ok": false,
                "error": {
                    "code": "internal_error",
                    "message": "Failed query: insert into \"nodes\" ..."
                }
            }));
        });

        let error = mint_node_token(
            "rk_live_test",
            Some(&server.base_url()),
            create_node_request("node_abc", "local-node", "relay-broker/test"),
            None,
            None,
            MintNodeTokenLogContext {
                node_id: "node_abc",
                workspace_id: "ws_test",
            },
        )
        .await
        .expect_err("500 create_node response should fail");

        create_node.assert_hits(CREATE_NODE_RETRY_BACKOFFS_MS.len() + 1);
        assert_eq!(error.status(), Some(500));
        assert_eq!(error.code(), Some("internal_error"));
        assert!(
            error
                .response_body()
                .is_some_and(|body| body.contains("insert into")),
            "error should preserve response body: {error:?}"
        );
    }

    #[tokio::test]
    async fn mint_node_token_retries_transient_send_error_then_succeeds() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server should bind");
        let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let server_attempts = Arc::clone(&attempts);
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.expect("accept request");
                let attempt = server_attempts.fetch_add(1, Ordering::SeqCst) + 1;
                if attempt == 1 {
                    drop(socket);
                    continue;
                }

                let mut buffer = [0_u8; 4096];
                let _ = socket.read(&mut buffer).await.expect("read request");
                let body = r#"{"ok":true,"data":{"id":"node_abc","name":"local-node","kind":"ws","role":"broker","version":"relay-broker/test","status":"online","live":true,"handlers_live":true,"load":0.0,"active_agents":0,"max_agents":0,"created_at":"2026-06-30T00:00:00Z","token":"nt_live_retry_success"}}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("write response");
                break;
            }
        });

        let token = mint_node_token(
            "rk_live_test",
            Some(&base_url),
            create_node_request("node_abc", "local-node", "relay-broker/test"),
            None,
            None,
            MintNodeTokenLogContext {
                node_id: "node_abc",
                workspace_id: "ws_test",
            },
        )
        .await
        .expect("transient send failure should be retried");

        server.await.expect("test server should finish");
        assert_eq!(token, "nt_live_retry_success");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn delivery_book_dedups_and_tracks_cumulative_ack() {
        let mut book = FleetDeliveryBook::default();
        let first = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-1".to_string(),
            msg_id: "msg-1".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "one"}),
        };

        assert_eq!(
            book.observe(&first),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
        assert_eq!(book.commit_delivered(&first), 1);
        assert_eq!(
            book.observe(&first),
            DeliveryDecision::Duplicate { up_to_seq: 1 }
        );

        let stale = Deliver {
            msg_id: "msg-stale".to_string(),
            seq: 1,
            ..first.clone()
        };
        assert_eq!(
            book.observe(&stale),
            DeliveryDecision::Stale { up_to_seq: 1 }
        );

        let gap = Deliver {
            msg_id: "msg-gap".to_string(),
            seq: 3,
            ..first
        };
        assert_eq!(book.observe(&gap), DeliveryDecision::Gap { up_to_seq: 1 });
    }

    /// A gap must leave the stream able to heal itself.
    ///
    /// Written while investigating the P0 of 2026-09-05, where agents stopped
    /// receiving inbound dispatch permanently while staying alive, able to
    /// send, and reporting `nodeConnected: true`. That outage was NOT traced to
    /// this path, and this test does not claim it was — it pins the invariant
    /// the path has to hold either way: a gap must not move the cursor, so that
    /// the engine's redelivery of the genuinely missing frame is still
    /// accepted.
    ///
    /// The assertion that matters is the last one — that delivery RESUMES.
    #[test]
    fn delivery_book_gap_leaves_the_cursor_ready_for_the_engine_to_heal_it() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 10);

        // Frame 11 is delayed or dropped; the engine's frame 12 arrives first.
        let after_hole = test_delivery("agent-a", "agent-a-id", 12);
        assert_eq!(
            book.observe(&after_hole),
            DeliveryDecision::Gap { up_to_seq: 10 },
            "a frame past a hole is a gap"
        );

        // Critical: observing a gap must not disturb the cursor, or the
        // redelivery below can never be accepted.
        assert_eq!(book.received_up_to_seq("agent-a-id"), 10);
        assert_eq!(book.acked_up_to_seq("agent-a-id"), 10);

        // The engine still holds seq 11 outstanding, because the gap was never
        // ACKed, and redelivers it. The stream heals.
        let missing = test_delivery("agent-a", "agent-a-id", 11);
        assert_eq!(
            book.observe(&missing),
            DeliveryDecision::Deliver { up_to_seq: 11 },
            "the redelivered missing frame must be accepted"
        );
        assert_eq!(book.commit_delivered(&missing), 11);

        assert_eq!(
            book.observe(&after_hole),
            DeliveryDecision::Deliver { up_to_seq: 12 },
            "and the frame that was gapped must now be deliverable — this is \
             the agent waking back up"
        );
        assert_eq!(book.commit_delivered(&after_hole), 12);
        assert_eq!(book.acked_up_to_seq("agent-a-id"), 12);
    }

    /// The floor a gap reports must never claim progress the broker has not
    /// made. Reporting anything above the true floor would tell Relaycast the
    /// missing frame was handled, and it would stop being redelivered.
    #[test]
    fn delivery_book_gap_reports_only_the_true_ack_floor() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 5);

        for seq in [7_u64, 8, 9] {
            assert_eq!(
                book.observe(&test_delivery("agent-a", "agent-a-id", seq)),
                DeliveryDecision::Gap { up_to_seq: 5 },
                "seq {seq} must report the unchanged floor 5, never its own seq"
            );
        }
        assert_eq!(book.received_up_to_seq("agent-a-id"), 5);
        assert_eq!(book.acked_up_to_seq("agent-a-id"), 5);
    }

    #[test]
    fn delivery_book_allows_seeded_resume_cursor() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 42);
        let deliver = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-43".to_string(),
            msg_id: "msg-43".to_string(),
            seq: 43,
            mode: DeliveryMode::Steer,
            payload: json!({"text": "resume"}),
        };

        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Deliver { up_to_seq: 43 }
        );
        assert_eq!(book.commit_delivered(&deliver), 43);
    }

    #[test]
    fn delivery_book_scopes_authoritative_cursors_to_agent_identity() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "shared-name", "agent-old", 42);
        seed_authoritative_cursor(&mut book, "other", "agent-other", 7);

        let resumed = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "shared-name".to_string(),
            agent_id: "agent-old".to_string(),
            delivery_id: "delivery-43".to_string(),
            msg_id: "msg-43".to_string(),
            seq: 43,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "resumed"}),
        };
        assert_eq!(
            book.observe(&resumed),
            DeliveryDecision::Deliver { up_to_seq: 43 }
        );

        let reused_name = Deliver {
            agent_id: "agent-new".to_string(),
            ..resumed.clone()
        };
        assert_eq!(
            book.observe(&reused_name),
            DeliveryDecision::IdentityReject,
            "an authoritative identity must reject an unregistered replacement"
        );

        seed_authoritative_cursor(&mut book, "shared-name", "agent-new", 0);
        let replacement_first = Deliver {
            delivery_id: "delivery-1".to_string(),
            msg_id: "msg-1".to_string(),
            seq: 1,
            ..reused_name
        };
        assert_eq!(
            book.observe(&replacement_first),
            DeliveryDecision::Deliver { up_to_seq: 1 },
            "the authoritative replacement starts from its own cursor"
        );

        let other = Deliver {
            agent: "other".to_string(),
            agent_id: "agent-other".to_string(),
            delivery_id: "delivery-8".to_string(),
            msg_id: "msg-8".to_string(),
            seq: 8,
            ..resumed
        };
        assert_eq!(
            book.observe(&other),
            DeliveryDecision::Deliver { up_to_seq: 8 },
            "resumed agents recover independently"
        );
    }

    #[test]
    fn delivery_book_rejects_seq_one_from_replaced_identity() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "shared-name", "agent-old", 42);
        book.remove_agent("shared-name");
        seed_authoritative_cursor(&mut book, "shared-name", "agent-new", 0);

        let stale = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "shared-name".to_string(),
            agent_id: "agent-old".to_string(),
            delivery_id: "delivery-old-1".to_string(),
            msg_id: "msg-old-1".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "buffered for the old identity"}),
        };
        assert_eq!(
            book.observe(&stale),
            DeliveryDecision::Stale { up_to_seq: 0 },
            "a buffered seq-1 frame must not reach the replacement worker"
        );

        let current = Deliver {
            agent_id: "agent-new".to_string(),
            delivery_id: "delivery-new-1".to_string(),
            msg_id: "msg-new-1".to_string(),
            ..stale
        };
        assert_eq!(
            book.observe(&current),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
    }

    #[test]
    fn delivery_book_rejects_seq_zero_from_replaced_identity() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "shared-name", "agent-old", 42);
        book.remove_agent("shared-name");
        seed_authoritative_cursor(&mut book, "shared-name", "agent-new", 7);

        let stale = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "shared-name".to_string(),
            agent_id: "agent-old".to_string(),
            delivery_id: "action-old".to_string(),
            msg_id: "invocation-old".to_string(),
            seq: 0,
            mode: DeliveryMode::Wait,
            payload: json!({"type": "action.completed"}),
        };
        assert_eq!(
            book.observe(&stale),
            DeliveryDecision::Stale { up_to_seq: 7 },
            "a buffered seq-0 frame must not reach the replacement worker"
        );

        let current = Deliver {
            agent_id: "agent-new".to_string(),
            delivery_id: "action-new".to_string(),
            msg_id: "invocation-new".to_string(),
            ..stale
        };
        assert_eq!(
            book.observe(&current),
            DeliveryDecision::Deliver { up_to_seq: 7 }
        );
    }

    #[test]
    fn delivery_book_preserves_legacy_first_sequence_compatibility() {
        let mut book = FleetDeliveryBook::default();
        let original = test_delivery("shared-name", "legacy-old", 1);
        assert_eq!(
            book.observe(&original),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
        assert_eq!(book.commit_delivered(&original), 1);
        assert!(!book.active_agent_bindings_by_name["shared-name"].authoritative);

        let high_sequence = test_delivery("shared-name", "legacy-new", 43);
        assert_eq!(
            book.observe(&high_sequence),
            DeliveryDecision::Gap { up_to_seq: 0 },
            "a provisional binding must preserve the legacy gap response"
        );

        let replacement_first = test_delivery("shared-name", "legacy-new", 1);
        assert_eq!(
            book.observe(&replacement_first),
            DeliveryDecision::Deliver { up_to_seq: 1 },
            "a provisional binding must allow a legacy replacement's first frame"
        );
    }

    #[test]
    fn delivery_book_authoritative_binding_survives_retirement_eviction() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "shared-name", "agent-old", 42);
        book.remove_agent("shared-name");
        seed_authoritative_cursor(&mut book, "shared-name", "agent-current", 7);

        for i in 0..=FleetDeliveryBook::RETIRED_AGENT_ID_CAPACITY {
            let name = format!("churn-{i}");
            let agent_id = format!("churn-id-{i}");
            seed_authoritative_cursor(&mut book, &name, &agent_id, 0);
            book.remove_agent(&name);
        }
        assert!(!book.retired_agent_names_by_id.contains_key("agent-old"));

        let snapshot = book.clone();
        for seq in [0, 1] {
            assert_eq!(
                book.observe(&test_delivery("shared-name", "agent-old", seq)),
                DeliveryDecision::IdentityReject
            );
            assert_eq!(book, snapshot, "identity rejection must not mutate state");
        }
    }

    #[test]
    fn delivery_book_rejects_known_ids_under_a_different_name() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "right-name", "known-id", 5);

        let active_snapshot = book.clone();
        assert_eq!(
            book.observe(&test_delivery("wrong-name", "known-id", 0)),
            DeliveryDecision::IdentityReject
        );
        assert_eq!(book, active_snapshot);

        book.remove_agent("right-name");
        let retired_snapshot = book.clone();
        assert_eq!(
            book.observe(&test_delivery("wrong-name", "known-id", 1)),
            DeliveryDecision::IdentityReject
        );
        assert_eq!(book, retired_snapshot);
    }

    #[test]
    fn delivery_book_nonauthoritative_commit_preserves_authority() {
        let mut book = FleetDeliveryBook::default();
        book.bind_authoritative_identity("agent-a", "agent-a-id");
        let first = test_delivery("agent-a", "agent-a-id", 1);
        assert_eq!(
            book.observe(&first),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
        assert_eq!(book.commit_delivered(&first), 1);
        assert!(book.active_agent_bindings_by_name["agent-a"].authoritative);
        assert_eq!(
            book.observe(&test_delivery("agent-a", "impostor-id", 1)),
            DeliveryDecision::IdentityReject
        );
    }

    #[test]
    fn delivery_book_same_id_reactivation_clears_retirement() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 42);
        book.remove_agent("agent-a");
        assert!(book.retired_agent_names_by_id.contains_key("agent-a-id"));

        book.bind_authoritative_identity("agent-a", "agent-a-id");
        assert!(!book.retired_agent_names_by_id.contains_key("agent-a-id"));
        assert!(book.active_agent_bindings_by_name["agent-a"].authoritative);
        assert_eq!(
            book.observe(&test_delivery("agent-a", "agent-a-id", 1)),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
    }

    #[test]
    fn delivery_book_respawn_keeps_delivering_when_the_engine_seq_continues() {
        // Release drops the cursor; a respawn under the same name rebinds the
        // same agent record, and `agent.register` does not always report a
        // cumulative position, so no cursor is re-seeded. The engine's
        // per-agent sequence keeps counting across the respawn, so the next
        // live message arrives well past seq 1 — the agent must still get it.
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 42);
        book.remove_agent("agent-a");
        book.bind_authoritative_identity("agent-a", "agent-a-id");

        let resumed = test_delivery("agent-a", "agent-a-id", 43);
        assert_eq!(
            book.observe(&resumed),
            DeliveryDecision::Deliver { up_to_seq: 43 }
        );

        // Adopting the position must also advance the cursor, or the next
        // message reads as a gap and the agent goes deaf one frame later.
        assert_eq!(book.commit_delivered(&resumed), 43);
        assert_eq!(
            book.observe(&test_delivery("agent-a", "agent-a-id", 44)),
            DeliveryDecision::Deliver { up_to_seq: 44 }
        );
        // A redelivery of an adopted frame is still recognized, and a real hole
        // in the sequence is still reported as a gap.
        assert_eq!(
            book.observe(&test_delivery("agent-a", "agent-a-id", 43)),
            DeliveryDecision::Duplicate { up_to_seq: 43 }
        );
        assert_eq!(
            book.observe(&test_delivery("agent-a", "agent-a-id", 99)),
            DeliveryDecision::Gap { up_to_seq: 43 }
        );
    }

    #[test]
    fn delivery_book_respawn_adoption_survives_seq_zero_fan_out() {
        // seq:0 fan-out (a reaction, a read receipt, an action result) creates
        // a cursor without establishing any sequenced position. If the cursor's
        // mere existence counted as a position, a single seq-0 frame landing
        // before the respawned agent's next real message would put the cursor
        // at zero, and the resumed frame would read as a gap — acked, never
        // surfaced, and the agent deaf again for the rest of its life.
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 42);
        book.remove_agent("agent-a");
        book.bind_authoritative_identity("agent-a", "agent-a-id");

        let fan_out = test_delivery("agent-a", "agent-a-id", 0);
        assert_eq!(
            book.observe(&fan_out),
            DeliveryDecision::Deliver { up_to_seq: 0 }
        );
        assert_eq!(book.commit_delivered(&fan_out), 0);
        // The fan-out frame is still deduped by msg_id while the identity waits
        // for its first sequenced delivery.
        assert_eq!(
            book.observe(&fan_out),
            DeliveryDecision::Duplicate { up_to_seq: 0 }
        );

        let resumed = test_delivery("agent-a", "agent-a-id", 43);
        assert_eq!(
            book.observe(&resumed),
            DeliveryDecision::Deliver { up_to_seq: 43 }
        );
        assert_eq!(book.commit_delivered(&resumed), 43);
        assert_eq!(
            book.observe(&test_delivery("agent-a", "agent-a-id", 44)),
            DeliveryDecision::Deliver { up_to_seq: 44 }
        );
    }

    #[test]
    fn delivery_book_provisional_binding_still_gaps_after_seq_zero_fan_out() {
        // The seq-0 relaxation must not become a back door for an unconfirmed
        // identity: a provisional binding that has only seen fan-out still
        // cannot claim a live name mid-sequence.
        let mut book = FleetDeliveryBook::default();
        let fan_out = test_delivery("agent-a", "agent-a-id", 0);
        assert_eq!(
            book.observe(&fan_out),
            DeliveryDecision::Deliver { up_to_seq: 0 }
        );
        assert_eq!(book.commit_delivered(&fan_out), 0);
        assert_eq!(
            book.observe(&test_delivery("agent-a", "agent-a-id", 43)),
            DeliveryDecision::Gap { up_to_seq: 0 }
        );
        // seq 1 is still the ordinary cold start and is delivered.
        assert_eq!(
            book.observe(&test_delivery("agent-a", "agent-a-id", 1)),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
    }

    #[test]
    fn delivery_book_retries_until_delivery_is_committed() {
        let mut book = FleetDeliveryBook::default();
        let deliver = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-1".to_string(),
            msg_id: "msg-1".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "retry"}),
        };

        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );

        assert_eq!(book.commit_delivered(&deliver), 1);
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Duplicate { up_to_seq: 1 }
        );
    }

    #[test]
    fn delivery_book_rejects_same_message_replayed_under_a_different_delivery_id() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 88);
        let original = test_delivery("agent-a", "agent-a-id", 89);
        assert_eq!(book.commit_received(&original), 89);
        assert_eq!(book.acked_up_to_seq("agent-a-id"), 88);

        let conflicting = Deliver {
            delivery_id: "different-delivery-89".to_string(),
            ..original.clone()
        };
        assert_eq!(
            book.observe(&conflicting),
            DeliveryDecision::ReplayConflict,
            "the same message/sequence must never recover through a new delivery identity"
        );
        assert_eq!(book.acked_up_to_seq("agent-a-id"), 88);
        assert_eq!(book.received_up_to_seq("agent-a-id"), 89);
    }

    #[test]
    fn delivery_book_receives_multiple_sequences_without_acknowledging_them() {
        let mut book = FleetDeliveryBook::default();
        let first = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-1".to_string(),
            msg_id: "msg-1".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "one"}),
        };
        let second = Deliver {
            delivery_id: "delivery-2".to_string(),
            msg_id: "msg-2".to_string(),
            seq: 2,
            payload: json!({"text": "two"}),
            ..first.clone()
        };

        assert_eq!(book.commit_received(&first), 1);
        assert_eq!(book.acked_up_to_seq("agent-a-id"), 0);
        assert_eq!(
            book.observe(&first),
            DeliveryDecision::Duplicate { up_to_seq: 0 },
            "a replayed held frame must not be queued twice or ACKed"
        );
        assert_eq!(
            book.observe(&second),
            DeliveryDecision::Deliver { up_to_seq: 2 }
        );
        assert_eq!(book.commit_received(&second), 2);
        assert_eq!(book.received_up_to_seq("agent-a-id"), 2);
        assert_eq!(book.acked_up_to_seq("agent-a-id"), 0);

        let second_receipt = RelaycastDeliveryReceipt {
            agent: "agent-a".into(),
            agent_id: "agent-a-id".into(),
            delivery_id: "delivery-2".into(),
            msg_id: "msg-2".into(),
            seq: 2,
        };
        assert_eq!(
            book.commit_acked_receipt(&second_receipt),
            None,
            "cumulative ACK cannot skip the held first sequence"
        );

        let first_receipt = RelaycastDeliveryReceipt {
            agent: "agent-a".into(),
            agent_id: "agent-a-id".into(),
            delivery_id: "delivery-1".into(),
            msg_id: "msg-1".into(),
            seq: 1,
        };
        assert_eq!(book.commit_acked_receipt(&first_receipt), Some(1));
        assert_eq!(book.commit_acked_receipt(&second_receipt), Some(2));
    }

    #[test]
    fn delivery_book_replays_unacked_manual_sequences_after_restart_baseline() {
        let mut before_restart = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut before_restart, "agent-a", "agent-a-id", 42);
        let first = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-43".to_string(),
            msg_id: "msg-43".to_string(),
            seq: 43,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "held before restart"}),
        };
        let second = Deliver {
            delivery_id: "delivery-44".to_string(),
            msg_id: "msg-44".to_string(),
            seq: 44,
            ..first.clone()
        };
        before_restart.commit_received(&first);
        before_restart.commit_received(&second);
        assert_eq!(before_restart.received_up_to_seq("agent-a-id"), 44);
        assert_eq!(before_restart.acked_up_to_seq("agent-a-id"), 42);

        // Issue #1240 supplies this persisted ACK baseline after a real broker
        // restart. Received-only state is intentionally volatile so Relaycast
        // can replay every unacknowledged manual delivery.
        let mut after_restart = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut after_restart, "agent-a", "agent-a-id", 42);
        assert_eq!(
            after_restart.observe(&first),
            DeliveryDecision::Deliver { up_to_seq: 43 }
        );
        after_restart.commit_received(&first);
        assert_eq!(
            after_restart.observe(&second),
            DeliveryDecision::Deliver { up_to_seq: 44 }
        );
        after_restart.commit_received(&second);
        assert_eq!(after_restart.acked_up_to_seq("agent-a-id"), 42);
    }

    #[test]
    fn delivery_book_remove_agent_prunes_cursor_and_msg_ids() {
        let mut book = FleetDeliveryBook::default();
        let deliver = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "delivery-1".to_string(),
            msg_id: "msg-1".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "one"}),
        };
        assert_eq!(book.commit_delivered(&deliver), 1);
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Duplicate { up_to_seq: 1 }
        );

        book.remove_agent("agent-a");
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Stale { up_to_seq: 0 }
        );

        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 0);
        assert_eq!(
            book.observe(&deliver),
            DeliveryDecision::Deliver { up_to_seq: 1 }
        );
    }

    #[test]
    fn delivery_book_bounds_retired_identity_history() {
        let mut book = FleetDeliveryBook::default();
        for i in 0..(FleetDeliveryBook::RETIRED_AGENT_ID_CAPACITY + 10) {
            let name = format!("agent-{i}");
            let agent_id = format!("agent-id-{i}");
            seed_authoritative_cursor(&mut book, &name, &agent_id, 0);
            book.remove_agent(&name);
        }

        assert_eq!(
            book.retired_agent_names_by_id.len(),
            FleetDeliveryBook::RETIRED_AGENT_ID_CAPACITY
        );
        assert_eq!(
            book.retired_agent_id_order.len(),
            FleetDeliveryBook::RETIRED_AGENT_ID_CAPACITY
        );
        assert!(!book.retired_agent_names_by_id.contains_key("agent-id-0"));
        assert!(book.retired_agent_names_by_id.contains_key(&format!(
            "agent-id-{}",
            FleetDeliveryBook::RETIRED_AGENT_ID_CAPACITY + 9
        )));
    }

    #[test]
    fn delivery_book_surfaces_seq_zero_fanout_without_advancing_cursor() {
        let mut book = FleetDeliveryBook::default();
        seed_authoritative_cursor(&mut book, "agent-a", "agent-a-id", 5);

        // A seq:0 fan-out frame (e.g. action.completed) is always surfaced,
        // bypassing the monotonic-sequence gate, and acks the current cursor.
        let fanout = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            agent_id: "agent-a-id".to_string(),
            delivery_id: "evt_action_completed".to_string(),
            msg_id: "inv-1".to_string(),
            seq: 0,
            mode: DeliveryMode::Wait,
            payload: json!({"type": "action.completed"}),
        };
        assert_eq!(
            book.observe(&fanout),
            DeliveryDecision::Deliver { up_to_seq: 5 }
        );
        // Committing a seq:0 frame does not move the cumulative cursor.
        assert_eq!(book.commit_delivered(&fanout), 5);

        // The same msg_id is suppressed as a duplicate (seq stays 0).
        assert_eq!(
            book.observe(&fanout),
            DeliveryDecision::Duplicate { up_to_seq: 5 }
        );

        // A different seq:0 msg_id surfaces again.
        let other = Deliver {
            msg_id: "inv-2".to_string(),
            ..fanout.clone()
        };
        assert_eq!(
            book.observe(&other),
            DeliveryDecision::Deliver { up_to_seq: 5 }
        );

        // Sequenced delivery still works normally after seq:0 traffic.
        let seq6 = Deliver {
            msg_id: "msg-6".to_string(),
            seq: 6,
            ..fanout
        };
        assert_eq!(
            book.observe(&seq6),
            DeliveryDecision::Deliver { up_to_seq: 6 }
        );
        assert_eq!(book.commit_delivered(&seq6), 6);
    }

    #[test]
    fn delivery_book_surfaces_seq_zero_for_unknown_agent() {
        let mut book = FleetDeliveryBook::default();
        // First-ever frame for an agent may be a seq:0 fan-out (no cursor yet).
        let fanout = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-new".to_string(),
            agent_id: "agent-new-id".to_string(),
            delivery_id: "evt_reacted".to_string(),
            msg_id: "react-1".to_string(),
            seq: 0,
            mode: DeliveryMode::Wait,
            payload: json!({"type": "message.reacted"}),
        };
        assert_eq!(
            book.observe(&fanout),
            DeliveryDecision::Deliver { up_to_seq: 0 }
        );
        assert_eq!(book.commit_delivered(&fanout), 0);
        assert_eq!(
            book.observe(&fanout),
            DeliveryDecision::Duplicate { up_to_seq: 0 }
        );
    }

    #[test]
    fn seen_msg_ids_evicts_oldest_when_capacity_exceeded() {
        let mut seen = SeenMsgIds::default();
        for i in 0..(SeenMsgIds::CAPACITY + 10) {
            seen.insert(&format!("msg-{i}"), &format!("delivery-{i}"), i as u64);
        }
        assert!(seen.order.len() <= SeenMsgIds::CAPACITY);
        // The 10 oldest entries were evicted.
        assert_eq!(
            seen.classify("msg-0", "delivery-0", 0),
            SeenMsgIdMatch::Unseen
        );
        assert_eq!(
            seen.classify("msg-9", "delivery-9", 9),
            SeenMsgIdMatch::Unseen
        );
        // The most recent entries are retained.
        let latest = SeenMsgIds::CAPACITY + 9;
        assert_eq!(
            seen.classify(
                &format!("msg-{latest}"),
                &format!("delivery-{latest}"),
                latest as u64,
            ),
            SeenMsgIdMatch::Exact
        );
    }

    #[test]
    fn seen_msg_ids_reinsert_is_idempotent() {
        let mut seen = SeenMsgIds::default();
        seen.insert("dup", "delivery-1", 1);
        seen.insert("dup", "delivery-1", 1);
        assert_eq!(seen.order.len(), 1);
        assert_eq!(seen.classify("dup", "delivery-1", 1), SeenMsgIdMatch::Exact);
        assert_eq!(
            seen.classify("dup", "delivery-2", 1),
            SeenMsgIdMatch::Conflict
        );
    }

    #[tokio::test]
    async fn uncorrelated_strict_schema_error_fails_only_isolated_registration_promptly() {
        let (isolated_tx, mut isolated_rx) = oneshot::channel();
        let (legacy_tx, mut legacy_rx) = oneshot::channel();
        let mut pending = HashMap::from([
            (
                "isolated".to_string(),
                PendingAgentRegistration {
                    isolates_channels: true,
                    name: "isolated".to_string(),
                    reply: isolated_tx,
                    created_at: Instant::now(),
                },
            ),
            (
                "legacy".to_string(),
                PendingAgentRegistration {
                    isolates_channels: false,
                    name: "legacy".to_string(),
                    reply: legacy_tx,
                    created_at: Instant::now(),
                },
            ),
        ]);
        let (events, _) = mpsc::channel(1);
        let mut deregistrations = HashMap::new();
        let mut sink = futures_util::sink::drain();
        for key in ["unrelated_extension", "auto_join_general"] {
            let error = json!({"v":1,"type":"error","ok":false,"id":"fresh-engine-id","code":"invalid_message","message":json!([{"code":"unrecognized_keys","path":[],"keys":[key]}]).to_string()});
            assert!(
                handle_server_message(
                    Message::Text(error.to_string()),
                    &events,
                    &mut pending,
                    &mut deregistrations,
                    &mut ApplicationLiveness::new(Duration::from_secs(1)),
                    "node-test",
                    &mut sink,
                    None,
                    None,
                )
                .await
            );
            assert!(matches!(
                legacy_rx.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            if key == "unrelated_extension" {
                assert!(matches!(
                    isolated_rx.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ));
            }
        }
        assert!(
            matches!(isolated_rx.try_recv(), Ok(Err(reason)) if reason.starts_with("agent_register_unsupported_channel_isolation"))
        );
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn application_readiness_requires_successful_correlated_inventory_reply() {
        let mut liveness = ApplicationLiveness::new(Duration::from_secs(1));
        liveness.track_inventory_sync(test_inventory_sync("inventory-rejected"));
        assert!(liveness.reject("inventory-rejected"));
        assert!(
            !liveness.ready,
            "an error reply must not make the link ready"
        );

        liveness.track_inventory_sync(test_inventory_sync("inventory-acknowledged"));
        assert_eq!(liveness.acknowledge("unrelated"), None);
        assert_eq!(liveness.acknowledge("inventory-acknowledged"), Some(true));
        assert!(liveness.ready);
    }

    #[tokio::test]
    async fn malformed_inventory_reply_does_not_make_application_ready() {
        let mut liveness = ApplicationLiveness::new(Duration::from_secs(1));
        liveness.track_inventory_sync(test_inventory_sync("inventory-rejected"));
        let (events, _receiver) = mpsc::channel(1);
        let healthy = handle_server_message(
            Message::Text(json!({"v": 1, "type": "reply", "id": "inventory-rejected", "ok": false, "data": {}}).to_string()),
            &events,
            &mut HashMap::new(),
            &mut HashMap::new(),
            &mut liveness,
            "node-test",
            &mut futures_util::sink::drain(),
            None,
            None,
        ).await;
        assert!(
            healthy,
            "malformed frames are ignored until the liveness deadline"
        );
        assert!(
            !liveness.ready,
            "a rejection is not an application acknowledgement"
        );
    }

    /// The terminal generation must leave the socket task before this bounded
    /// queue can delay its ordinary runtime event. Otherwise an independent
    /// terminal reconnect can become ready while an older hint is still queued,
    /// and runtime handling would wrongly close that fresh lane.
    #[tokio::test]
    async fn terminal_reconnect_generation_publishes_before_the_fleet_event_queue() {
        let (events, mut event_rx) = mpsc::channel(1);
        events.send(FleetControlEvent::Connected).await.unwrap();
        let (reconnect_tx, mut reconnect_rx) = watch::channel(None);

        let handler = tokio::spawn(async move {
            handle_server_message(
                Message::Text(
                    serde_json::to_string(&RelaycastToBroker::TerminalReconnectRequested(
                        TerminalReconnectRequested {
                            v: FLEET_WIRE_VERSION,
                            generation: 41,
                        },
                    ))
                    .unwrap(),
                ),
                &events,
                &mut HashMap::new(),
                &mut HashMap::new(),
                &mut ApplicationLiveness::new(Duration::from_secs(1)),
                "node-test",
                &mut futures_util::sink::drain(),
                None,
                Some(&reconnect_tx),
            )
            .await
        });

        tokio::time::timeout(Duration::from_millis(250), reconnect_rx.changed())
            .await
            .expect("generation publication waited behind the full fleet event queue")
            .unwrap();
        assert_eq!(*reconnect_rx.borrow_and_update(), Some(41));
        assert!(
            !handler.is_finished(),
            "the control event queue was not actually blocking the forwarding path"
        );

        assert_eq!(event_rx.recv().await, Some(FleetControlEvent::Connected));
        assert!(handler.await.unwrap());
        assert!(matches!(
            event_rx.recv().await,
            Some(FleetControlEvent::Message(
                RelaycastToBroker::TerminalReconnectRequested(TerminalReconnectRequested {
                    generation: 41,
                    ..
                })
            ))
        ));
    }

    #[test]
    fn acknowledged_probe_preserves_newer_probe_for_rejection() {
        let mut liveness = ApplicationLiveness::new(Duration::from_secs(1));
        liveness.track_inventory_sync(test_inventory_sync("inventory-a"));
        liveness.track_inventory_sync(test_inventory_sync("inventory-b"));

        assert_eq!(liveness.acknowledge("inventory-a"), Some(true));
        assert_eq!(
            liveness
                .pending_inventory_syncs
                .iter()
                .filter_map(|pending| pending.frame.id.as_deref())
                .collect::<Vec<_>>(),
            vec!["inventory-b"]
        );
        assert!(liveness.reject("inventory-b"));
    }

    #[test]
    fn d1_pressure_retry_backoff_is_bounded_and_preserves_the_frame() {
        let mut liveness = ApplicationLiveness::new(Duration::from_secs(120));
        let frame = test_inventory_sync("inventory-retry");
        liveness.track_inventory_sync(frame.clone());
        let now = Instant::now();

        assert_eq!(
            (0..5)
                .map(|_| liveness.schedule_d1_pressure_retry("inventory-retry", now))
                .collect::<Vec<_>>(),
            vec![
                Some(Duration::from_secs(1)),
                Some(Duration::from_secs(2)),
                Some(Duration::from_secs(4)),
                Some(Duration::from_secs(8)),
                Some(Duration::from_secs(8)),
            ]
        );
        assert_eq!(
            liveness.take_due_retry(now + Duration::from_secs(8)),
            Some(frame)
        );
        assert!(!liveness.ready);
    }

    #[test]
    fn newer_inventory_snapshot_cancels_an_older_retry_payload() {
        let mut liveness = ApplicationLiveness::new(Duration::from_secs(120));
        let old = test_inventory_sync("inventory-old");
        let new = test_inventory_sync("inventory-new");
        let now = Instant::now();

        liveness.track_inventory_sync(old);
        assert_eq!(
            liveness.schedule_d1_pressure_retry("inventory-old", now),
            Some(Duration::from_secs(1))
        );
        liveness.track_inventory_sync(new.clone());

        assert_eq!(liveness.take_due_retry(now + Duration::from_secs(1)), None);
        assert!(liveness.discard_superseded("inventory-old"));
        assert_eq!(
            liveness.schedule_d1_pressure_retry("inventory-new", now),
            Some(Duration::from_secs(1))
        );
        assert_eq!(
            liveness.take_due_retry(now + Duration::from_secs(1)),
            Some(new)
        );
    }

    #[tokio::test]
    async fn late_d1_pressure_for_superseded_inventory_is_consumed_without_disconnect() {
        let mut liveness = ApplicationLiveness::new(Duration::from_secs(120));
        liveness.track_inventory_sync(test_inventory_sync("inventory-old"));
        liveness.track_inventory_sync(test_inventory_sync("inventory-new"));
        let (events, _receiver) = mpsc::channel(1);

        let healthy = handle_server_message(
            Message::Text(
                json!({
                    "v": 1,
                    "id": "inventory-old",
                    "type": "error",
                    "ok": false,
                    "code": "d1_pressure",
                    "message": "Node liveness retry pending"
                })
                .to_string(),
            ),
            &events,
            &mut HashMap::new(),
            &mut HashMap::new(),
            &mut liveness,
            "node-test",
            &mut futures_util::sink::drain(),
            None,
            None,
        )
        .await;

        assert!(healthy);
        assert_eq!(
            liveness
                .pending_inventory_syncs
                .iter()
                .filter_map(|pending| pending.frame.id.as_deref())
                .collect::<Vec<_>>(),
            vec!["inventory-new"]
        );
        assert_eq!(
            liveness.schedule_d1_pressure_retry("inventory-old", Instant::now()),
            None
        );
        assert_eq!(
            liveness.schedule_d1_pressure_retry("inventory-new", Instant::now()),
            Some(Duration::from_secs(1))
        );
    }

    #[test]
    fn expire_agent_registrations_bounds_pending_map() {
        let created_at = Instant::now();
        let (reply_tx, mut reply_rx) = oneshot::channel();
        let mut pending = HashMap::from([(
            "agent_register_1".to_string(),
            PendingAgentRegistration {
                isolates_channels: false,
                name: "agent-a".to_string(),
                reply: reply_tx,
                created_at,
            },
        )]);

        expire_agent_registrations(
            &mut pending,
            created_at + REGISTER_AGENT_PENDING_TTL - Duration::from_millis(1),
        );
        assert_eq!(pending.len(), 1);

        expire_agent_registrations(&mut pending, created_at + REGISTER_AGENT_PENDING_TTL);
        assert!(pending.is_empty());
        assert!(matches!(
            reply_rx.try_recv(),
            Ok(Err(reason)) if reason == "agent_register_pending_expired"
        ));
    }

    #[tokio::test]
    async fn complete_agent_registration_matches_pending_by_name_when_id_differs() {
        // The engine reply carries a snowflake id that does not echo the
        // broker's request id, but it does carry `data.name`. The broker must
        // still correlate the reply to the pending registration by name rather
        // than emitting a spurious "did not match" warning.
        let (reply_tx, reply_rx) = oneshot::channel();
        let mut pending = HashMap::from([(
            "agent_register_req".to_string(),
            PendingAgentRegistration {
                isolates_channels: false,
                name: "agent-a".to_string(),
                reply: reply_tx,
                created_at: Instant::now(),
            },
        )]);
        let mut sink = futures_util::sink::drain();
        let reply = crate::fleet_wire::Reply {
            v: FLEET_WIRE_VERSION,
            id: "196331520553345024".to_string(),
            ok: true,
            data: json!({
                "name": "agent-a",
                "agent_id": "agt-1",
                "token": "at_test"
            }),
        };

        assert!(complete_agent_registration(reply, &mut pending, &mut sink).await);
        assert!(
            pending.is_empty(),
            "the pending registration must be consumed by the name-based fallback"
        );
        assert_eq!(
            reply_rx.await.unwrap().unwrap(),
            AgentRegistrationToken {
                name: "agent-a".to_string(),
                agent_id: "agt-1".to_string(),
                token: "at_test".to_string(),
                delivery_ack_seq: None,
            }
        );
    }

    #[tokio::test]
    async fn complete_agent_registration_ignores_non_agent_reply() {
        // A `node.register`/`inventory.sync` reply carries a fresh engine
        // snowflake id and no agent-register-shaped data, so it resolves to no
        // pending registration. It must be ignored (debug, not warn) and must
        // not disturb an unrelated in-flight agent registration.
        let (reply_tx, mut reply_rx) = oneshot::channel();
        let mut pending = HashMap::from([(
            "agent_register_req".to_string(),
            PendingAgentRegistration {
                isolates_channels: false,
                name: "agent-a".to_string(),
                reply: reply_tx,
                created_at: Instant::now(),
            },
        )]);
        let mut sink = futures_util::sink::drain();
        let reply = crate::fleet_wire::Reply {
            v: FLEET_WIRE_VERSION,
            id: "196331520553345024".to_string(),
            ok: true,
            data: json!({ "node_id": "node-test", "online": true }),
        };

        assert!(complete_agent_registration(reply, &mut pending, &mut sink).await);
        assert_eq!(
            pending.len(),
            1,
            "an unrelated reply must not consume a pending agent registration"
        );
        assert!(
            matches!(
                reply_rx.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ),
            "the pending registration must remain in flight"
        );
    }
    #[test]
    fn build_node_register_prefers_manifest_identity() {
        let manifest = NodeManifest {
            name: "builder".to_string(),
            node_id: Some("node-manifest".to_string()),
            capabilities: vec![crate::protocol::NodeCapabilityManifest {
                name: "spawn:codex".to_string(),
                kind: Some("spawn".to_string()),
                metadata: Some(HashMap::from([(
                    "cli".to_string(),
                    Value::String("codex".to_string()),
                )])),
            }],
            max_agents: Some(8),
            tags: Some(vec!["local".to_string()]),
            repo_keys: Some(vec!["AgentWorkforce/relay".to_string()]),
            version: Some("sidecar/1".to_string()),
        };

        let register =
            build_node_register(&manifest, "node-default", "host-default", "broker/1", None);
        assert_eq!(register.name, "builder");
        assert_eq!(register.node_id, "node-manifest");
        assert_eq!(register.max_agents, 8);
        assert_eq!(
            register.repo_keys,
            Some(vec!["AgentWorkforce/relay".to_string()])
        );
        assert_eq!(
            register.capabilities[0].metadata,
            Some(BTreeMap::from([(
                "cli".to_string(),
                Value::String("codex".to_string())
            )]))
        );
        assert_eq!(
            register.capabilities.last(),
            Some(&FleetCapability {
                execution_mode: None,
                name: crate::fleet_wire::DELIVERY_CURSOR_CAPABILITY.to_string(),
                kind: Some("capacity".to_string()),
                global: None,
                queue: None,
                metadata: None,
            })
        );
    }

    #[test]
    fn build_node_register_keeps_only_placement_safe_repo_keys() {
        let mut manifest = test_manifest();
        manifest.repo_keys = Some(vec![
            "AgentWorkforce/relay".to_string(),
            "/private/node/relay".to_string(),
            "AgentWorkforce/relay/extra".to_string(),
            "AgentWorkforce/relay".to_string(),
            "../relay".to_string(),
        ]);

        let register =
            build_node_register(&manifest, "node-default", "host-default", "broker/1", None);
        assert_eq!(
            register.repo_keys,
            Some(vec!["AgentWorkforce/relay".to_string()])
        );

        manifest.repo_keys = Some(Vec::new());
        let clear =
            build_node_register(&manifest, "node-default", "host-default", "broker/1", None);
        assert_eq!(clear.repo_keys, Some(Vec::new()));
        assert_eq!(
            serde_json::to_value(clear).unwrap().get("repo_keys"),
            Some(&json!([]))
        );
    }

    #[tokio::test]
    async fn node_control_client_round_trips_mock_engine_ws() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: None,
                session_token: None,
                read_idle_timeout: None,
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();

            let register = next_node_to_server(&mut ws).await;
            assert!(matches!(register, BrokerToRelaycast::NodeRegister(_)));
            match next_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => assert!(sync.agents.is_empty()),
                other => panic!("expected initial empty inventory.sync, got {other:?}"),
            }
            let heartbeat = next_node_to_server(&mut ws).await;
            match heartbeat {
                BrokerToRelaycast::NodeHeartbeat(heartbeat) => {
                    assert!(
                        heartbeat.handlers_live,
                        "the broker provider must advertise capacity before the first spawn"
                    );
                }
                other => panic!("expected initial node heartbeat, got {other:?}"),
            }

            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::Deliver(Deliver {
                    v: FLEET_WIRE_VERSION,
                    agent: "agent-a".to_string(),
                    agent_id: "agent-a-id".to_string(),
                    delivery_id: "delivery-1".to_string(),
                    msg_id: "msg-1".to_string(),
                    seq: 1,
                    mode: DeliveryMode::Wait,
                    payload: json!({"text": "hello"}),
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
            let ack = next_non_heartbeat_node_to_server(&mut ws).await;
            assert_eq!(ack, delivery_ack("agent-a", 1));

            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::ActionInvoke(ActionInvoke {
                    task_execution: None,
                    v: FLEET_WIRE_VERSION,
                    invocation_id: "inv-1".to_string(),
                    action: "run:test".to_string(),
                    input: json!({"suite": "unit"}),
                    agent_id: None,
                    agent_name: None,
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
            let result = next_non_heartbeat_node_to_server(&mut ws).await;
            assert!(matches!(result, BrokerToRelaycast::ActionResult(_)));
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        let event = event_rx.recv().await.unwrap();
        assert_eq!(event, FleetControlEvent::Connected);
        let event = event_rx.recv().await.unwrap();
        assert!(matches!(
            event,
            FleetControlEvent::Message(RelaycastToBroker::Deliver(_))
        ));
        command_tx
            .send(FleetControlCommand::Send(delivery_ack("agent-a", 1)))
            .await
            .unwrap();
        let event = event_rx.recv().await.unwrap();
        assert!(matches!(
            event,
            FleetControlEvent::Message(RelaycastToBroker::ActionInvoke(_))
        ));
        command_tx
            .send(FleetControlCommand::Send(BrokerToRelaycast::ActionResult(
                ActionResult {
                    task: None,
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    invocation_id: "inv-1".to_string(),
                    result: ActionResultPayload::Output(ActionResultOutput {
                        output: json!({"ok": true}),
                    }),
                },
            )))
            .await
            .unwrap();
        command_tx
            .send(FleetControlCommand::Shutdown)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn retryable_d1_pressure_retries_control_frames_on_same_connection_with_backoff() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, mut command_rx) = mpsc::channel(4);
        let (event_tx, mut event_rx) = mpsc::channel(4);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = vec![InventoryAgent {
            agent_id: "agt-1".to_string(),
            name: "agent-a".to_string(),
            invocation_id: Some("inv-1".to_string()),
            session_ref: Some("session-1".to_string()),
        }];
        let mut load = FleetLoadSnapshot {
            active_agents: 1,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: vec!["agent-a".to_string()],
        };
        let (retry_seen_tx, retry_seen_rx) = oneshot::channel();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let initial_register = match ws.next().await.unwrap().unwrap() {
                Message::Text(text) => {
                    match serde_json::from_str::<BrokerToRelaycast>(&text).unwrap() {
                        BrokerToRelaycast::NodeRegister(register) => register,
                        other => panic!("expected node.register, got {other:?}"),
                    }
                }
                other => panic!("expected text node.register, got {other:?}"),
            };
            let register_id = initial_register
                .id
                .clone()
                .expect("node.register request id");
            ws.send(Message::Text(
                json!({
                    "v": 1,
                    "id": register_id,
                    "type": "error",
                    "ok": false,
                    "code": "d1_pressure",
                    "message": "Node liveness retry pending"
                })
                .to_string(),
            ))
            .await
            .unwrap();
            assert!(
                tokio::time::timeout(
                    Duration::from_millis(500),
                    next_non_heartbeat_node_to_server(&mut ws),
                )
                .await
                .is_err(),
                "the registration retry must honor its initial backoff"
            );
            let retried_register = tokio::time::timeout(
                Duration::from_secs(2),
                next_non_heartbeat_node_to_server(&mut ws),
            )
            .await
            .expect("retryable registration d1_pressure should retry on the live socket");
            assert_eq!(
                retried_register,
                BrokerToRelaycast::NodeRegister(initial_register)
            );
            let initial = match next_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => sync,
                other => panic!("expected initial inventory.sync, got {other:?}"),
            };
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));
            let request_id = initial.id.clone().expect("inventory.sync request id");
            ws.send(Message::Text(
                json!({
                    "v": 1,
                    "id": request_id,
                    "type": "error",
                    "ok": false,
                    "code": "d1_pressure",
                    "message": "Node liveness retry pending"
                })
                .to_string(),
            ))
            .await
            .unwrap();

            assert!(
                tokio::time::timeout(
                    Duration::from_millis(500),
                    next_non_heartbeat_node_to_server(&mut ws),
                )
                .await
                .is_err(),
                "the retry must honor its initial backoff"
            );
            let retried = tokio::time::timeout(
                Duration::from_secs(2),
                next_non_heartbeat_node_to_server(&mut ws),
            )
            .await
            .expect("retryable d1_pressure should retry on the live socket");
            assert_eq!(retried, BrokerToRelaycast::InventorySync(initial.clone()));
            ws.send(Message::Text(
                json!({"v": 1, "id": request_id, "type": "reply", "ok": true, "data": {}})
                    .to_string(),
            ))
            .await
            .unwrap();
            retry_seen_tx.send(()).unwrap();
            while ws.next().await.is_some() {}
        });

        let config = FleetControlConfig {
            ws_url,
            node_token: Some("nt_test".to_string()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_minter: None,
            session_token: None,
            read_idle_timeout: None,
            probe: None,
            terminal_reconnect_tx: None,
        };
        let session = run_connected_once(
            &config,
            &mut command_rx,
            &event_tx,
            &mut registration,
            &mut inventory,
            &mut load,
            Duration::from_secs(3_600),
        );
        let driver = async {
            retry_seen_rx.await.unwrap();
            command_tx
                .send(FleetControlCommand::Shutdown)
                .await
                .unwrap();
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(session, driver)
        })
        .await
        .expect("same-socket retry should complete without reconnecting");

        assert_eq!(result, ControlRunResult::Shutdown);
        assert_eq!(event_rx.recv().await, Some(FleetControlEvent::Connected));
        assert!(
            event_rx.try_recv().is_err(),
            "the control link must not disconnect"
        );
        server.abort();
    }

    #[tokio::test]
    async fn registration_d1_pressure_backoff_remains_shutdown_interruptible() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, mut command_rx) = mpsc::channel(1);
        let (event_tx, _event_rx) = mpsc::channel(1);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = Vec::new();
        let mut load = FleetLoadSnapshot {
            active_agents: 0,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: Vec::new(),
        };
        let (pressure_sent_tx, pressure_sent_rx) = oneshot::channel();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let register = match ws.next().await.unwrap().unwrap() {
                Message::Text(text) => {
                    match serde_json::from_str::<BrokerToRelaycast>(&text).unwrap() {
                        BrokerToRelaycast::NodeRegister(register) => register,
                        other => panic!("expected node.register, got {other:?}"),
                    }
                }
                other => panic!("expected text node.register, got {other:?}"),
            };
            ws.send(Message::Text(
                json!({
                    "v": 1,
                    "id": register.id,
                    "type": "error",
                    "ok": false,
                    "code": "d1_pressure",
                    "message": "Node liveness retry pending"
                })
                .to_string(),
            ))
            .await
            .unwrap();
            pressure_sent_tx.send(()).unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });

        let config = FleetControlConfig {
            ws_url,
            node_token: Some("nt_test".to_string()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_minter: None,
            session_token: None,
            read_idle_timeout: None,
            probe: None,
            terminal_reconnect_tx: None,
        };
        let session = run_connected_once(
            &config,
            &mut command_rx,
            &event_tx,
            &mut registration,
            &mut inventory,
            &mut load,
            Duration::from_secs(3_600),
        );
        let driver = async {
            pressure_sent_rx.await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            command_tx
                .send(FleetControlCommand::Shutdown)
                .await
                .unwrap();
        };
        let (result, ()) = tokio::time::timeout(Duration::from_millis(500), async {
            tokio::join!(session, driver)
        })
        .await
        .expect("shutdown must interrupt registration d1_pressure backoff");

        assert_eq!(result, ControlRunResult::Shutdown);
        server.abort();
    }

    #[tokio::test]
    async fn node_control_agent_register_round_trips_minted_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: None,
                session_token: None,
                read_idle_timeout: None,
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();

            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            match next_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => assert!(sync.agents.is_empty()),
                other => panic!("expected initial empty inventory.sync, got {other:?}"),
            }
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));
            let register_id = match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::AgentRegister(request) => {
                    let register_id = request.id.clone().expect("agent.register id");
                    assert_eq!(request.name, "agent-a");
                    assert_eq!(request.invocation_id.as_deref(), Some("inv-1"));
                    assert_eq!(request.session_ref.as_deref(), Some("session-1"));
                    register_id
                }
                other => panic!("expected agent.register, got {other:?}"),
            };
            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::Reply(crate::fleet_wire::Reply {
                    v: FLEET_WIRE_VERSION,
                    id: register_id,
                    ok: true,
                    data: json!({
                        "name": "agent-a",
                        "agent_id": "agt-1",
                        "token": "at_test",
                        "delivery_ack_seq": 42
                    }),
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
            match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => {
                    assert_eq!(sync.agents.len(), 1);
                    assert_eq!(sync.agents[0].name, "agent-a");
                    assert_eq!(
                        sync.agents[0].session_ref.as_deref(),
                        Some("session-discovered")
                    );
                }
                other => panic!("expected inventory.sync, got {other:?}"),
            }
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();
        assert_eq!(event_rx.recv().await.unwrap(), FleetControlEvent::Connected);

        let (reply_tx, reply_rx) = oneshot::channel();
        command_tx
            .send(FleetControlCommand::RegisterAgent {
                request: AgentRegister {
                    auto_join_general: Some(false),
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    name: "agent-a".to_string(),
                    invocation_id: Some("inv-1".to_string()),
                    session_ref: Some("session-1".to_string()),
                    resumable: Some(true),
                },
                reply: reply_tx,
            })
            .await
            .unwrap();
        let token = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            token,
            AgentRegistrationToken {
                name: "agent-a".to_string(),
                agent_id: "agt-1".to_string(),
                token: "at_test".to_string(),
                delivery_ack_seq: Some(42),
            }
        );
        command_tx
            .send(FleetControlCommand::UpdateInventory(vec![InventoryAgent {
                agent_id: "agt-1".to_string(),
                name: "agent-a".to_string(),
                invocation_id: Some("inv-1".to_string()),
                session_ref: Some("session-discovered".to_string()),
            }]))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    #[tokio::test]
    async fn node_control_client_mints_initial_token_when_none_supplied() {
        // Broker startup no longer mints the node token on the API-readiness
        // path; the client mints it in the background. Started with no token but
        // a minter, it must mint via create_node, publish the token to the shared
        // HTTP session handle, and connect.
        let mint_server = MockServer::start();
        let create_node = mint_server.mock(|when, then| {
            when.method(POST).path("/v1/nodes");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "node-test",
                    "name": "host-test",
                    "kind": "ws",
                    "role": "broker",
                    "version": "broker/test",
                    "status": "online",
                    "live": true,
                    "handlers_live": true,
                    "load": 0.0,
                    "active_agents": 0,
                    "max_agents": 0,
                    "created_at": "2026-06-30T00:00:00Z",
                    "token": "nt_minted_by_client"
                }
            }));
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let session_token = Arc::new(std::sync::RwLock::new(None));

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: None,
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: Some(NodeTokenMinter {
                    workspace_key: "rk_live_test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    base_url: Some(mint_server.base_url()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_path: None,
                    adopt_cached_token_after_conflict: true,
                }),
                session_token: Some(session_token.clone()),
                read_idle_timeout: None,
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        // Bounded: if the mint or connect path regresses, the client retries
        // without ever emitting `Connected`, so an unbounded recv would hang the
        // whole suite. Fail with an assertion instead.
        let connected = tokio::time::timeout(Duration::from_secs(5), event_rx.recv())
            .await
            .expect("node-control client should emit Connected within 5s")
            .unwrap();
        assert_eq!(connected, FleetControlEvent::Connected);
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();

        create_node.assert_hits(1);
        assert_eq!(
            session_token.read().unwrap().as_deref(),
            Some("nt_minted_by_client"),
            "the background mint must publish the token to the shared HTTP session"
        );
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    #[tokio::test]
    async fn node_control_stops_when_initial_enrollment_requires_existing_node_proof() {
        let mint_server = MockServer::start();
        let create_node = mint_server.mock(|when, then| {
            when.method(POST).path("/v1/nodes");
            then.status(409).json_body(json!({
                "ok": false,
                "error": {
                    "code": "node_token_proof_required",
                    "message": "Node already exists; its current node token is required"
                }
            }));
        });

        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let session_token = Arc::new(std::sync::RwLock::new(None));
        let control = tokio::spawn(run_node_control_client(
            FleetControlConfig {
                // A terminal enrollment conflict returns before any WebSocket
                // connection is attempted, so no listener is required.
                ws_url: "ws://127.0.0.1:9/v1/node/ws".to_string(),
                node_token: None,
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: Some(NodeTokenMinter {
                    workspace_key: "rk_live_test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    base_url: Some(mint_server.base_url()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_path: None,
                    adopt_cached_token_after_conflict: true,
                }),
                session_token: Some(session_token.clone()),
                read_idle_timeout: None,
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(5), control)
            .await
            .expect("terminal initial enrollment conflict must stop the control loop")
            .unwrap();
        create_node.assert_hits(1);
        assert_eq!(event_rx.recv().await, Some(FleetControlEvent::Disconnected));
        assert!(session_token.read().unwrap().is_none());
    }

    #[tokio::test]
    async fn node_control_stops_after_server_rejects_rejected_token_as_rotation_proof() {
        let mint_server = MockServer::start();
        let create_node = mint_server.mock(|when, then| {
            when.method(POST)
                .path("/v1/nodes")
                .header("x-relaycast-node-token", "nt_live_rejected");
            then.status(409).json_body(json!({
                "ok": false,
                "error": {
                    "code": "node_token_proof_required",
                    "message": "Node already exists; its current node token is required"
                }
            }));
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let rejected_handshake = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });

        let token_dir = tempfile::tempdir().unwrap();
        let token_path = token_dir.path().join("node-token.json");
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_server.base_url()),
            "nt_live_rejected",
        )
        .unwrap();

        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let session_token = Arc::new(std::sync::RwLock::new(Some("nt_live_rejected".to_string())));
        let probe = Arc::new(crate::node_delivery_probe::NodeDeliveryProbe::new());
        let control = tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_live_rejected".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: Some(NodeTokenMinter {
                    workspace_key: "rk_live_test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    base_url: Some(mint_server.base_url()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_path: Some(token_path.clone()),
                    adopt_cached_token_after_conflict: true,
                }),
                session_token: Some(session_token.clone()),
                read_idle_timeout: None,
                probe: Some(probe.clone()),
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(5), control)
            .await
            .expect("terminal proof conflict must stop the control loop")
            .unwrap();
        rejected_handshake.await.unwrap();
        create_node.assert_hits(1);
        assert_eq!(event_rx.recv().await, Some(FleetControlEvent::Disconnected));
        assert_eq!(
            session_token.read().unwrap().as_deref(),
            Some("nt_live_rejected"),
            "terminal recovery must retain the last in-memory proof"
        );
        assert_eq!(
            load_node_token(
                &token_path,
                "node-test",
                "ws_test",
                Some(&mint_server.base_url()),
            )
            .as_deref(),
            Some("nt_live_rejected"),
            "terminal recovery must retain the last durable proof"
        );
        assert_eq!(probe.node_control_health()["state"], "terminal");
        assert_eq!(
            probe.node_control_health()["reason"],
            "node_token_proof_required"
        );
    }

    #[tokio::test]
    async fn env_token_proof_conflict_does_not_adopt_shadowed_cache() {
        let mint_server = MockServer::start();
        let create_node = mint_server.mock(|when, then| {
            when.method(POST)
                .path("/v1/nodes")
                .header("x-relaycast-node-token", "nt_live_env_override");
            then.status(409).json_body(json!({
                "ok": false,
                "error": {
                    "code": "node_token_proof_required",
                    "message": "Node already exists; its current node token is required"
                }
            }));
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let rejected_handshake = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = socket.read(&mut buffer).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });

        let token_dir = tempfile::tempdir().unwrap();
        let token_path = token_dir.path().join("node-token.json");
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_server.base_url()),
            "nt_live_older_cache",
        )
        .unwrap();

        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let session_token = Arc::new(std::sync::RwLock::new(Some(
            "nt_live_env_override".to_string(),
        )));
        let probe = Arc::new(crate::node_delivery_probe::NodeDeliveryProbe::new());
        let control = tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_live_env_override".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: Some(NodeTokenMinter {
                    workspace_key: "rk_live_test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    base_url: Some(mint_server.base_url()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_path: Some(token_path.clone()),
                    adopt_cached_token_after_conflict: false,
                }),
                session_token: Some(session_token.clone()),
                read_idle_timeout: None,
                probe: Some(probe.clone()),
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(5), control)
            .await
            .expect("env-token proof conflict must not retry the shadowed cache")
            .unwrap();
        rejected_handshake.await.unwrap();
        create_node.assert_hits(1);
        assert_eq!(event_rx.recv().await, Some(FleetControlEvent::Disconnected));
        assert_eq!(
            session_token.read().unwrap().as_deref(),
            Some("nt_live_env_override")
        );
        assert_eq!(
            load_node_token(
                &token_path,
                "node-test",
                "ws_test",
                Some(&mint_server.base_url()),
            )
            .as_deref(),
            Some("nt_live_older_cache")
        );
        assert_eq!(probe.node_control_health()["state"], "terminal");
        assert_eq!(
            probe.node_control_health()["reason"],
            "env_override_rejected"
        );
    }

    #[tokio::test]
    async fn node_control_adopts_sibling_rotated_cache_after_proof_conflict() {
        let mint_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mint_base_url = format!("http://{}", mint_listener.local_addr().unwrap());
        let (mint_seen_tx, mint_seen_rx) = oneshot::channel();
        let (cache_replaced_tx, cache_replaced_rx) = oneshot::channel();
        let mint_server = tokio::spawn(async move {
            let (mut socket, _) = mint_listener.accept().await.unwrap();
            let mut buffer = [0_u8; 8192];
            let read = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..read]).to_ascii_lowercase();
            assert!(request.contains("x-relaycast-node-token: nt_live_rejected"));
            mint_seen_tx.send(()).unwrap();
            cache_replaced_rx.await.unwrap();

            let body = json!({
                "ok": false,
                "error": {
                    "code": "node_token_proof_required",
                    "message": "Node token changed before enrollment"
                }
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", ws_listener.local_addr().unwrap());
        let ws_server = tokio::spawn(async move {
            let (mut rejected_socket, _) = ws_listener.accept().await.unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = rejected_socket.read(&mut buffer).await.unwrap();
            rejected_socket
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();

            let (stream, _) = ws_listener.accept().await.unwrap();
            let mut ws = accept_hdr_async(stream, |request: &Request, response: Response| {
                assert_eq!(
                    request
                        .headers()
                        .get("authorization")
                        .and_then(|value| value.to_str().ok()),
                    Some("Bearer nt_live_sibling_rotated")
                );
                Ok(response)
            })
            .await
            .unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            while ws.next().await.is_some() {}
        });

        let token_dir = tempfile::tempdir().unwrap();
        let token_path = token_dir.path().join("node-token.json");
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_base_url),
            "nt_live_rejected",
        )
        .unwrap();

        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let session_token = Arc::new(std::sync::RwLock::new(Some("nt_live_rejected".to_string())));
        let control = tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_live_rejected".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: Some(NodeTokenMinter {
                    workspace_key: "rk_live_test".to_string(),
                    workspace_id: "ws_test".to_string(),
                    base_url: Some(mint_base_url.clone()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_path: Some(token_path.clone()),
                    adopt_cached_token_after_conflict: true,
                }),
                session_token: Some(session_token.clone()),
                read_idle_timeout: None,
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(5), mint_seen_rx)
            .await
            .expect("rotation request should reach the server")
            .unwrap();
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_base_url),
            "nt_live_sibling_rotated",
        )
        .unwrap();
        cache_replaced_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match event_rx.recv().await {
                    Some(FleetControlEvent::Connected) => break,
                    Some(FleetControlEvent::Disconnected) => {}
                    None => panic!("control task stopped instead of adopting the cached token"),
                    Some(other) => panic!("unexpected control event: {other:?}"),
                }
            }
        })
        .await
        .expect("the sibling-rotated token should reconnect");

        assert_eq!(
            session_token.read().unwrap().as_deref(),
            Some("nt_live_sibling_rotated")
        );
        assert_eq!(
            load_node_token(&token_path, "node-test", "ws_test", Some(&mint_base_url)).as_deref(),
            Some("nt_live_sibling_rotated")
        );

        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
        tokio::time::timeout(Duration::from_secs(5), control)
            .await
            .expect("control task should shut down")
            .unwrap();
        mint_server.await.unwrap();
        ws_server.await.unwrap();
    }

    #[tokio::test]
    async fn late_rotation_response_does_not_overwrite_newer_cached_token() {
        let mint_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mint_base_url = format!("http://{}", mint_listener.local_addr().unwrap());
        let (first_request_tx, first_request_rx) = oneshot::channel();
        let (release_first_tx, release_first_rx) = oneshot::channel();
        let mint_server = tokio::spawn(async move {
            let (mut first_socket, _) = mint_listener.accept().await.unwrap();
            let first_request = read_http_request(&mut first_socket).await;
            let first_key = http_request_header(&first_request, "idempotency-key")
                .expect("cache-backed rotation must send a durable key");
            first_request_tx.send(first_key.clone()).unwrap();

            let (mut replay_socket, _) = mint_listener.accept().await.unwrap();
            let replay_request = read_http_request(&mut replay_socket).await;
            assert_eq!(
                http_request_header(&replay_request, "idempotency-key").as_deref(),
                Some(first_key.as_str())
            );
            write_create_node_success(&mut replay_socket, "nt_live_rotated_once").await;

            let (mut newer_socket, _) = mint_listener.accept().await.unwrap();
            let newer_request = read_http_request(&mut newer_socket).await;
            assert_ne!(
                http_request_header(&newer_request, "idempotency-key").as_deref(),
                Some(first_key.as_str())
            );
            write_create_node_success(&mut newer_socket, "nt_live_rotated_twice").await;

            release_first_rx.await.unwrap();
            write_create_node_success(&mut first_socket, "nt_live_rotated_once").await;
        });

        let token_dir = tempfile::tempdir().unwrap();
        let token_path = token_dir.path().join("node-token.json");
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_base_url),
            "nt_live_original",
        )
        .unwrap();
        let minter = NodeTokenMinter {
            workspace_key: "rk_live_test".to_string(),
            workspace_id: "ws_test".to_string(),
            base_url: Some(mint_base_url.clone()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_path: Some(token_path.clone()),
            adopt_cached_token_after_conflict: true,
        };

        let first_minter = minter.clone();
        let first_rotation =
            tokio::spawn(async move { first_minter.remint("nt_live_original").await });
        first_request_rx.await.unwrap();

        assert_eq!(
            minter.remint("nt_live_original").await.unwrap(),
            "nt_live_rotated_once"
        );
        assert_eq!(
            minter.remint("nt_live_rotated_once").await.unwrap(),
            "nt_live_rotated_twice"
        );
        release_first_tx.send(()).unwrap();

        assert_eq!(
            first_rotation.await.unwrap().unwrap(),
            "nt_live_rotated_twice",
            "the late caller must reconcile to the cache that advanced while its response was in flight"
        );
        assert_eq!(
            load_node_token(&token_path, "node-test", "ws_test", Some(&mint_base_url)).as_deref(),
            Some("nt_live_rotated_twice")
        );
        mint_server.await.unwrap();
    }

    #[tokio::test]
    async fn env_token_rotation_reuses_process_key_after_lost_responses() {
        let mint_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mint_base_url = format!("http://{}", mint_listener.local_addr().unwrap());
        let seen_keys = Arc::new(std::sync::Mutex::new(Vec::new()));
        let server_keys = seen_keys.clone();
        let mint_server = tokio::spawn(async move {
            for attempt in 0..5 {
                let (mut socket, _) = mint_listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                server_keys
                    .lock()
                    .unwrap()
                    .push(http_request_header(&request, "idempotency-key"));
                if attempt == 4 {
                    write_create_node_success(&mut socket, "nt_live_recovered").await;
                }
            }
        });

        let token_dir = tempfile::tempdir().unwrap();
        let token_path = token_dir.path().join("node-token.json");
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_base_url),
            "nt_live_cached_other",
        )
        .unwrap();
        let minter = NodeTokenMinter {
            workspace_key: "rk_live_test".to_string(),
            workspace_id: "ws_test".to_string(),
            base_url: Some(mint_base_url.clone()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_path: Some(token_path.clone()),
            adopt_cached_token_after_conflict: true,
        };

        minter
            .remint("nt_live_env")
            .await
            .expect_err("four lost responses should exhaust the request retry loop");
        assert_eq!(
            minter.remint("nt_live_env").await.unwrap(),
            "nt_live_recovered"
        );
        mint_server.await.unwrap();

        let keys = seen_keys.lock().unwrap();
        let first = keys[0]
            .as_deref()
            .expect("environment-token rotation must use a process-local key");
        assert!(
            keys.iter().all(|key| key.as_deref() == Some(first)),
            "all retries, including the later outer retry, must replay the same rotation"
        );
        assert_eq!(
            load_node_token(&token_path, "node-test", "ws_test", Some(&mint_base_url)).as_deref(),
            Some("nt_live_recovered")
        );
    }

    #[tokio::test]
    async fn successful_rotation_is_persisted_after_preparation_failure() {
        let mint_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mint_base_url = format!("http://{}", mint_listener.local_addr().unwrap());
        let mint_server = tokio::spawn(async move {
            let (mut socket, _) = mint_listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            assert_eq!(
                http_request_header(&request, "x-relaycast-node-token").as_deref(),
                Some("nt_live_original")
            );
            assert!(http_request_header(&request, "idempotency-key").is_some());
            write_create_node_success(&mut socket, "nt_live_recovered").await;
        });

        let token_dir = tempfile::tempdir().unwrap();
        let token_path = token_dir.path().join("node-token.json");
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_base_url),
            "nt_live_original",
        )
        .unwrap();
        let minter = NodeTokenMinter {
            workspace_key: "rk_live_test".to_string(),
            workspace_id: "ws_test".to_string(),
            base_url: Some(mint_base_url.clone()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_path: Some(token_path.clone()),
            adopt_cached_token_after_conflict: true,
        };
        let request_digest =
            create_node_request_digest(&minter.node_id, &minter.node_name, &minter.broker_version);

        assert_eq!(
            minter
                .remint_after_preparation(
                    "nt_live_original",
                    &request_digest,
                    Some(Err(anyhow::anyhow!("simulated preparation failure"))),
                )
                .await
                .unwrap(),
            "nt_live_recovered"
        );
        mint_server.await.unwrap();
        assert_eq!(
            load_node_token(&token_path, "node-test", "ws_test", Some(&mint_base_url)).as_deref(),
            Some("nt_live_recovered"),
            "a successful rotation must repair the cache even when pending-key preparation failed"
        );
    }

    #[tokio::test]
    async fn preparation_failure_does_not_overwrite_advanced_cache() {
        let mint_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mint_base_url = format!("http://{}", mint_listener.local_addr().unwrap());
        let (request_seen_tx, request_seen_rx) = oneshot::channel();
        let (release_response_tx, release_response_rx) = oneshot::channel();
        let mint_server = tokio::spawn(async move {
            let (mut socket, _) = mint_listener.accept().await.unwrap();
            let _request = read_http_request(&mut socket).await;
            request_seen_tx.send(()).unwrap();
            release_response_rx.await.unwrap();
            write_create_node_success(&mut socket, "nt_live_late").await;
        });

        let token_dir = tempfile::tempdir().unwrap();
        let token_path = token_dir.path().join("node-token.json");
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_base_url),
            "nt_live_original",
        )
        .unwrap();
        let minter = NodeTokenMinter {
            workspace_key: "rk_live_test".to_string(),
            workspace_id: "ws_test".to_string(),
            base_url: Some(mint_base_url.clone()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_path: Some(token_path.clone()),
            adopt_cached_token_after_conflict: true,
        };
        let request_digest =
            create_node_request_digest(&minter.node_id, &minter.node_name, &minter.broker_version);
        let rotating_minter = minter.clone();
        let rotation = tokio::spawn(async move {
            rotating_minter
                .remint_after_preparation(
                    "nt_live_original",
                    &request_digest,
                    Some(Err(anyhow::anyhow!("simulated preparation failure"))),
                )
                .await
        });

        request_seen_rx.await.unwrap();
        persist_node_token(
            &token_path,
            "node-test",
            "ws_test",
            Some(&mint_base_url),
            "nt_live_sibling",
        )
        .unwrap();
        release_response_tx.send(()).unwrap();

        assert_eq!(
            rotation.await.unwrap().unwrap(),
            "nt_live_sibling",
            "the late caller must reconcile to the cache that advanced during its mint"
        );
        mint_server.await.unwrap();
        assert_eq!(
            load_node_token(&token_path, "node-test", "ws_test", Some(&mint_base_url)).as_deref(),
            Some("nt_live_sibling")
        );
    }

    #[tokio::test]
    async fn node_control_agent_register_timeout_late_success_deregisters() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, mut event_rx) = mpsc::channel(32);
        let (register_seen_tx, register_seen_rx) = oneshot::channel();
        let (send_late_reply_tx, send_late_reply_rx) = oneshot::channel();

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: None,
                session_token: None,
                read_idle_timeout: None,
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();

            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            match next_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => assert!(sync.agents.is_empty()),
                other => panic!("expected initial empty inventory.sync, got {other:?}"),
            }
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));
            let register_id = match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::AgentRegister(request) => {
                    let register_id = request.id.clone().expect("agent.register id");
                    assert_eq!(request.name, "agent-a");
                    register_seen_tx.send(register_id.clone()).unwrap();
                    register_id
                }
                other => panic!("expected agent.register, got {other:?}"),
            };

            send_late_reply_rx.await.unwrap();
            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::Reply(crate::fleet_wire::Reply {
                    v: FLEET_WIRE_VERSION,
                    id: register_id.clone(),
                    ok: true,
                    data: json!({
                        "name": "agent-a",
                        "agent_id": "agt-late",
                        "token": "at_late"
                    }),
                }))
                .unwrap(),
            ))
            .await
            .unwrap();

            match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::AgentDeregister(deregister) => {
                    assert_eq!(deregister.id.as_deref(), Some(register_id.as_str()));
                    assert_eq!(deregister.agent_id, "agt-late");
                    assert_eq!(deregister.name.as_deref(), Some("agent-a"));
                }
                other => panic!("expected compensating agent.deregister, got {other:?}"),
            }
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();
        assert_eq!(event_rx.recv().await.unwrap(), FleetControlEvent::Connected);

        let (reply_tx, reply_rx) = oneshot::channel();
        command_tx
            .send(FleetControlCommand::RegisterAgent {
                request: AgentRegister {
                    auto_join_general: Some(false),
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    name: "agent-a".to_string(),
                    invocation_id: Some("inv-1".to_string()),
                    session_ref: None,
                    resumable: None,
                },
                reply: reply_tx,
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), register_seen_rx)
            .await
            .unwrap()
            .unwrap();
        drop(reply_rx);
        send_late_reply_tx.send(()).unwrap();

        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    /// Poll the probe until `ready` holds, so tests observe state transitions
    /// without sleeping on a machine whose load they do not control.
    async fn wait_for_probe(
        probe: &std::sync::Arc<crate::node_delivery_probe::NodeDeliveryProbe>,
        ready: impl Fn(&serde_json::Value) -> bool,
    ) {
        for _ in 0..1_000 {
            if ready(&probe.snapshot_with_token(true)) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "probe never reached the expected state: {}",
            probe.snapshot_with_token(true)
        );
    }

    /// relay#1680 review (coderabbitai, fleet.rs:857) MUST-FIRE.
    ///
    /// The runtime stamps `surfaced_and_acked` / `acked_without_surfacing` when
    /// it DECIDES to acknowledge, then hands the ack to this task over a
    /// channel. It cannot await the wire, so the disposition alone reports an
    /// ack the engine may never have received. This task is the only place that
    /// knows, so `acks.sent` must be recorded here — and only for acks, or the
    /// tally would be satisfied by unrelated traffic and could not report the
    /// negative.
    #[tokio::test]
    async fn the_socket_task_records_which_acks_reached_the_wire() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, mut command_rx) = mpsc::channel(4);
        let (event_tx, _event_rx) = mpsc::channel(8);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = Vec::new();
        let mut load = FleetLoadSnapshot {
            active_agents: 0,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: Vec::new(),
        };
        let probe = std::sync::Arc::new(crate::node_delivery_probe::NodeDeliveryProbe::new());

        // Drain whatever the client writes and never close from this side, so
        // the session ends on the `Shutdown` the driver sends.
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let _ = next_node_to_server(&mut ws).await;
            while ws.next().await.is_some() {}
        });

        let config = FleetControlConfig {
            ws_url,
            node_token: Some("nt_test".to_string()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_minter: None,
            session_token: None,
            read_idle_timeout: None,
            probe: Some(probe.clone()),
            terminal_reconnect_tx: None,
        };
        let session = run_connected_once(
            &config,
            &mut command_rx,
            &event_tx,
            &mut registration,
            &mut inventory,
            &mut load,
            Duration::from_secs(3_600),
        );
        let driver = async {
            wait_for_probe(&probe, |snapshot| snapshot["socket"]["connects"] == 1).await;
            command_tx
                .send(FleetControlCommand::Send(delivery_ack("agent-a", 7)))
                .await
                .expect("ack should be accepted");
            wait_for_probe(&probe, |snapshot| snapshot["acks"]["sent"] == 1).await;

            // Traffic that is not an ack must not move the ack tally, or
            // `acks.sent` could not distinguish "the engine was told" from
            // "the socket was busy".
            command_tx
                .send(FleetControlCommand::Send(BrokerToRelaycast::ActionResult(
                    ActionResult {
                        v: FLEET_WIRE_VERSION,
                        id: None,
                        invocation_id: "inv-not-an-ack".to_string(),
                        result: ActionResultPayload::Output(ActionResultOutput {
                            output: json!({"ok": true}),
                        }),
                        task: None,
                    },
                )))
                .await
                .expect("action result should be accepted");
            command_tx
                .send(FleetControlCommand::Shutdown)
                .await
                .expect("shutdown should be accepted");
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(session, driver)
        })
        .await
        .expect("mock node-control session should finish");
        assert_eq!(result, ControlRunResult::Shutdown);
        server.abort();

        let snapshot = probe.snapshot_with_token(true);
        assert_eq!(
            snapshot["acks"]["sent"], 1,
            "the ack reached the wire, so the probe must be able to say so"
        );
        assert_eq!(
            snapshot["acks"]["send_failed"], 0,
            "the write succeeded; nothing should be tallied as failed"
        );
        assert!(
            snapshot["acks"]["last_sent_at_ms"].is_u64(),
            "an ack on the wire must stamp a last-sent time"
        );
    }

    /// relay#1680 review (P2), raised independently by three reviewers.
    ///
    /// Connectivity must be owned by the socket task, not by the runtime. When
    /// it was recorded from `handle_fleet_control_event`, a wedged event loop
    /// never processed `Disconnected`, so the endpoint kept reporting
    /// `connected: true` for a dead socket — the exact failure it exists to
    /// diagnose. The receiver is DROPPED here to stand in for a runtime that
    /// will never consume another event; the probe must still track the
    /// session, and must show disconnected once the session ends.
    #[tokio::test]
    async fn socket_owns_connectivity_when_the_runtime_never_consumes_events() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, mut command_rx) = mpsc::channel(4);
        // A runtime that is gone/wedged: nothing will ever read these.
        let (event_tx, event_rx) = mpsc::channel(1);
        drop(event_rx);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = Vec::new();
        let mut load = FleetLoadSnapshot {
            active_agents: 0,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: Vec::new(),
        };
        let probe = std::sync::Arc::new(crate::node_delivery_probe::NodeDeliveryProbe::new());
        let observed = probe.clone();

        // The server holds the connection open and never closes it. Letting the
        // peer close would race the client's own timer branches: a periodic
        // write to an already-closed socket returns `Disconnected` before the
        // read branch has drained anything. The test ends the session itself,
        // via `Shutdown`, so the exit path is chosen rather than raced.
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            // The session is established; the guard must have armed by now.
            let _ = next_node_to_server(&mut ws).await;
            assert_eq!(
                observed.snapshot_with_token(true)["connected"],
                serde_json::json!(true),
                "connect must be recorded by the socket task, not the runtime"
            );
            // Park until the client hangs up, without closing from this side.
            while ws.next().await.is_some() {}
        });

        let config = FleetControlConfig {
            ws_url,
            node_token: Some("nt_test".to_string()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_minter: None,
            session_token: None,
            read_idle_timeout: None,
            probe: Some(probe.clone()),
            terminal_reconnect_tx: None,
        };
        let session = run_connected_once(
            &config,
            &mut command_rx,
            &event_tx,
            &mut registration,
            &mut inventory,
            &mut load,
            // Far beyond the test's lifetime: the periodic refresh must never
            // fire here, or it becomes another way to exit the session.
            Duration::from_secs(3_600),
        );
        let driver = async {
            wait_for_probe(&probe, |snapshot| snapshot["socket"]["connects"] == 1).await;
            command_tx
                .send(FleetControlCommand::Shutdown)
                .await
                .expect("shutdown should be accepted");
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(session, driver)
        })
        .await
        .expect("mock node-control session should finish");
        // Exiting via Shutdown rather than a peer close also proves the guard
        // releases on a non-`Disconnected` return.
        assert_eq!(result, ControlRunResult::Shutdown);
        server.abort();

        let snapshot = probe.snapshot_with_token(true);
        // Exactly one connect, exactly one matching disconnect, released by the
        // guard's Drop on whichever return path fired.
        assert_eq!(snapshot["socket"]["connects"], 1);
        assert_eq!(snapshot["socket"]["disconnects"], 1);
        assert_eq!(
            snapshot["connected"],
            serde_json::json!(false),
            "a closed socket must not keep reading as connected"
        );
    }

    /// relay#1680 review (P2). Publishing cursors only from the deliver path
    /// left the endpoint serving an obsolete ACK indefinitely: the deferred
    /// (echo-confirmed) and manual-flush ACKs advance `acked_up_to_seq` well
    /// after the frame was handled. Every mutator must mark the snapshot
    /// stale so the event loop republishes it.
    #[test]
    fn every_delivery_book_mutation_marks_the_cursor_snapshot_stale() {
        fn deliver_frame(agent: &str, agent_id: &str, seq: u64) -> Deliver {
            Deliver {
                v: crate::fleet_wire::FleetWireVersion,
                agent: agent.to_string(),
                agent_id: agent_id.to_string(),
                delivery_id: format!("del_{seq}"),
                msg_id: format!("msg_{seq}"),
                seq,
                mode: DeliveryMode::Wait,
                payload: serde_json::json!({ "type": "dm.received" }),
            }
        }

        // Each case: (name, mutation). All must leave the flag set.
        type Mutation = (&'static str, Box<dyn Fn(&mut FleetDeliveryBook)>);
        let cases: Vec<Mutation> = vec![
            (
                "commit_received",
                Box::new(|book: &mut FleetDeliveryBook| {
                    book.commit_received(&deliver_frame("a", "ag_a", 1));
                }),
            ),
            (
                "commit_delivered",
                Box::new(|book: &mut FleetDeliveryBook| {
                    book.commit_delivered(&deliver_frame("a", "ag_a", 2));
                }),
            ),
            (
                // relay#1680: the deferred-ACK path that previously never
                // republished, so a confirmed delivery left a stale cursor.
                "commit_confirmed_delivery",
                Box::new(|book: &mut FleetDeliveryBook| {
                    book.commit_confirmed_delivery(&deliver_frame("a", "ag_a", 3));
                }),
            ),
            (
                "commit_acked_receipt",
                Box::new(|book: &mut FleetDeliveryBook| {
                    book.commit_acked_receipt(&RelaycastDeliveryReceipt {
                        agent: crate::ids::WorkerName::from("a"),
                        agent_id: crate::ids::AgentId::from("ag_a"),
                        delivery_id: crate::ids::DeliveryId::from("del_9"),
                        msg_id: crate::ids::EventId::from("msg_9"),
                        seq: 9,
                    });
                }),
            ),
            (
                "bind_authoritative_identity",
                Box::new(|book: &mut FleetDeliveryBook| {
                    book.bind_authoritative_identity("a", "ag_a");
                }),
            ),
            (
                // `seed_cursor` asserts the name is already bound, so bind
                // first and re-clear the flag to isolate the seed itself.
                "seed_cursor",
                Box::new(|book: &mut FleetDeliveryBook| {
                    book.bind_authoritative_identity("a", "ag_a");
                    book.take_cursor_dirty();
                    book.seed_cursor("a", "ag_a", 4);
                }),
            ),
            (
                "restore_pending_agent",
                Box::new(|book: &mut FleetDeliveryBook| {
                    let frame = deliver_frame("a", "ag_a", 5);
                    book.restore_pending_agent(&[&frame], Some(4));
                }),
            ),
            (
                "remove_agent",
                Box::new(|book: &mut FleetDeliveryBook| {
                    book.remove_agent("a");
                }),
            ),
        ];

        for (name, mutate) in cases {
            let mut book = FleetDeliveryBook::default();
            // Clear whatever setup left behind, then mutate.
            book.take_cursor_dirty();
            mutate(&mut book);
            assert!(
                book.take_cursor_dirty(),
                "{name} must mark the cursor snapshot stale so the event loop republishes it"
            );
            // Draining is one-shot: a second take must report clean.
            assert!(!book.take_cursor_dirty(), "{name} left the flag set twice");
        }
    }

    /// The instrument's headline claim: a `deliver` frame the broker cannot
    /// deserialize is still reported as having ARRIVED. That property lives in
    /// the ORDER of two statements in `handle_server_message` — count, then
    /// parse — so it cannot be locked by calling the probe's methods directly.
    /// This drives a real node-control session and asserts it at the call site.
    #[tokio::test]
    async fn probe_counts_an_unparseable_deliver_as_arrived() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, mut command_rx) = mpsc::channel(4);
        let (event_tx, mut event_rx) = mpsc::channel(8);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = Vec::new();
        let mut load = FleetLoadSnapshot {
            active_agents: 0,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: Vec::new(),
        };
        let probe = std::sync::Arc::new(crate::node_delivery_probe::NodeDeliveryProbe::new());

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));

            // A frame whose `type` this build does not know. `ServerToNode` is
            // `#[serde(tag = "type")]`, so this fails `from_str` as a whole.
            ws.send(Message::Text(
                r#"{"type":"deliver.v2","agent":"worker-a","seq":9}"#.into(),
            ))
            .await
            .unwrap();

            // And one the broker does understand, so the test distinguishes
            // "counted everything" from "counted nothing but the failure".
            ws.send(Message::Text(
                serde_json::to_string(&RelaycastToBroker::Deliver(Deliver {
                    v: crate::fleet_wire::FleetWireVersion,
                    agent: "worker-a".to_string(),
                    agent_id: "ag_1".to_string(),
                    delivery_id: "del_1".to_string(),
                    msg_id: "msg_1".to_string(),
                    seq: 1,
                    mode: DeliveryMode::Wait,
                    payload: serde_json::json!({ "type": "dm.received" }),
                }))
                .unwrap(),
            ))
            .await
            .unwrap();

            // Park without closing: a peer close races the client's timer
            // branches, which can exit the session before the frames above are
            // drained. The test ends it deterministically via `Shutdown`.
            while ws.next().await.is_some() {}
        });

        let config = FleetControlConfig {
            ws_url,
            node_token: Some("nt_test".to_string()),
            node_id: "node-test".to_string(),
            node_name: "host-test".to_string(),
            broker_version: "broker/test".to_string(),
            token_minter: None,
            session_token: None,
            read_idle_timeout: None,
            probe: Some(probe.clone()),
            terminal_reconnect_tx: None,
        };
        let session = run_connected_once(
            &config,
            &mut command_rx,
            &event_tx,
            &mut registration,
            &mut inventory,
            &mut load,
            Duration::from_secs(3_600),
        );
        let driver = async {
            // Both frames counted -> the client has drained the read side.
            wait_for_probe(&probe, |snapshot| snapshot["socket"]["text_frames"] == 3).await;
            command_tx
                .send(FleetControlCommand::Shutdown)
                .await
                .expect("shutdown should be accepted");
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(session, driver)
        })
        .await
        .expect("mock node-control session should finish");
        assert_eq!(result, ControlRunResult::Shutdown);
        server.abort();

        let snapshot = probe.snapshot_with_token(true);
        // Registration reply plus BOTH test frames count as arrived, including
        // the unparseable one. Counting after parse would incorrectly read 2.
        assert_eq!(
            snapshot["socket"]["text_frames"], 3,
            "an unparseable frame must still count as having arrived: {snapshot}"
        );
        assert_eq!(snapshot["socket"]["parse_failures"], 1);
        assert_eq!(snapshot["unparsed_frame_types"]["deliver.v2"], 1);
        // Only the parseable one reaches the deliver counter and the runtime.
        assert_eq!(snapshot["frames"]["deliver"], 1);
        // The session also emits `Connected`, so drain rather than assuming the
        // deliver is first in the queue.
        let mut forwarded = Vec::new();
        while let Ok(event) = event_rx.try_recv() {
            forwarded.push(event);
        }
        assert_eq!(
            forwarded
                .iter()
                .filter(|event| matches!(
                    event,
                    FleetControlEvent::Message(RelaycastToBroker::Deliver(_))
                ))
                .count(),
            1,
            "exactly the parseable deliver should reach the runtime: {forwarded:?}"
        );
    }

    #[tokio::test]
    async fn connected_node_refreshes_idle_agent_inventory_before_presence_expires() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (_command_tx, mut command_rx) = mpsc::channel(4);
        let (event_tx, _event_rx) = mpsc::channel(4);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = vec![InventoryAgent {
            agent_id: "agt-1".to_string(),
            name: "agent-a".to_string(),
            invocation_id: Some("inv-1".to_string()),
            session_ref: Some("session-1".to_string()),
        }];
        let mut load = FleetLoadSnapshot {
            active_agents: 1,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: vec!["agent-a".to_string()],
        };

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::InventorySync(_)
            ));
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));

            let refreshed = tokio::time::timeout(
                Duration::from_millis(500),
                next_non_heartbeat_node_to_server(&mut ws),
            )
            .await
            .expect("a live but idle agent must renew its Relaycast presence lease");
            match refreshed {
                BrokerToRelaycast::InventorySync(sync) => {
                    assert_eq!(sync.agents.len(), 1);
                    assert_eq!(sync.agents[0].name, "agent-a");
                }
                other => panic!("expected periodic inventory.sync, got {other:?}"),
            }
            ws.close(None).await.unwrap();
        });

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run_connected_once(
                &FleetControlConfig {
                    ws_url,
                    node_token: Some("nt_test".to_string()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_minter: None,
                    session_token: None,
                    read_idle_timeout: None,
                    probe: None,
                    terminal_reconnect_tx: None,
                },
                &mut command_rx,
                &event_tx,
                &mut registration,
                &mut inventory,
                &mut load,
                Duration::from_millis(25),
            ),
        )
        .await
        .expect("mock node-control session should finish");

        assert_eq!(
            result,
            ControlRunResult::Disconnected {
                application_ready: false
            }
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn connected_node_replays_empty_inventory_to_clear_stale_presence() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (_command_tx, mut command_rx) = mpsc::channel(4);
        let (event_tx, _event_rx) = mpsc::channel(4);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = Vec::new();
        let mut load = FleetLoadSnapshot {
            active_agents: 0,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: Vec::new(),
        };

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            match next_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => assert!(sync.agents.is_empty()),
                other => panic!("expected initial empty inventory.sync, got {other:?}"),
            }
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));

            let refreshed = tokio::time::timeout(
                Duration::from_millis(500),
                next_non_heartbeat_node_to_server(&mut ws),
            )
            .await
            .expect("an empty authoritative inventory must be periodically replayed");
            match refreshed {
                BrokerToRelaycast::InventorySync(sync) => assert!(sync.agents.is_empty()),
                other => panic!("expected periodic empty inventory.sync, got {other:?}"),
            }
            ws.close(None).await.unwrap();
        });

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run_connected_once(
                &FleetControlConfig {
                    ws_url,
                    node_token: Some("nt_test".to_string()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_minter: None,
                    session_token: None,
                    read_idle_timeout: None,
                    probe: None,
                    terminal_reconnect_tx: None,
                },
                &mut command_rx,
                &event_tx,
                &mut registration,
                &mut inventory,
                &mut load,
                Duration::from_millis(25),
            ),
        )
        .await
        .expect("mock node-control session should finish");

        assert_eq!(
            result,
            ControlRunResult::Disconnected {
                application_ready: false
            }
        );
        server.await.unwrap();
    }

    /// Regression for relay#1591: transport traffic must not mask an application
    /// control-plane failure. The peer keeps the TCP/WebSocket connection open,
    /// continuously polls it (so tungstenite answers every WebSocket ping with a
    /// pong), and drains every node frame, acknowledges the initial inventory, then stops acknowledging later
    /// application requests. The node-control session must still declare the link dead.
    #[tokio::test]
    async fn node_control_disconnects_when_application_acks_stop_but_socket_stays_live() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (_command_tx, mut command_rx) = mpsc::channel(4);
        let (event_tx, _event_rx) = mpsc::channel(4);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = Vec::new();
        let mut load = FleetLoadSnapshot {
            active_agents: 3,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: vec![
                "agent-a".to_string(),
                "agent-b".to_string(),
                "agent-c".to_string(),
            ],
        };

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let mut saw_inventory = false;
            let mut saw_heartbeat = false;

            while let Some(frame) = ws.next().await {
                let Ok(frame) = frame else { break };
                match frame {
                    Message::Text(text) => match serde_json::from_str::<BrokerToRelaycast>(&text)
                        .expect("valid node-control frame")
                    {
                        BrokerToRelaycast::NodeRegister(register) => {
                            ws.send(Message::Text(
                                json!({
                                    "v": 1, "type": "reply", "id": register.id.unwrap(),
                                    "ok": true, "data": {}
                                })
                                .to_string(),
                            ))
                            .await
                            .unwrap();
                        }
                        BrokerToRelaycast::InventorySync(sync) => {
                            if !saw_inventory {
                                ws.send(Message::Text(
                                    json!({
                                        "v": 1, "type": "reply", "id": sync.id.unwrap(),
                                        "ok": true, "data": {"reconciled": 0}
                                    })
                                    .to_string(),
                                ))
                                .await
                                .unwrap();
                            }
                            saw_inventory = true;
                        }
                        BrokerToRelaycast::NodeHeartbeat(heartbeat) => {
                            saw_heartbeat = true;
                            assert_eq!(heartbeat.active_agents, 3);
                        }
                        _ => {}
                    },
                    Message::Close(_) => break,
                    _ => {}
                }
            }

            assert!(saw_inventory, "client must send an application request");
            assert!(saw_heartbeat, "client process must keep heartbeating");
        });

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run_connected_once(
                &FleetControlConfig {
                    ws_url,
                    node_token: Some("nt_test".to_string()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_minter: None,
                    session_token: None,
                    read_idle_timeout: Some(Duration::from_millis(400)),
                    probe: None,
                    terminal_reconnect_tx: None,
                },
                &mut command_rx,
                &event_tx,
                &mut registration,
                &mut inventory,
                &mut load,
                Duration::from_millis(100),
            ),
        )
        .await
        .expect("application-level liveness deadline did not fire");

        assert_eq!(
            result,
            ControlRunResult::Disconnected {
                application_ready: true
            }
        );
        server.await.unwrap();
    }

    /// Must-not-fire control arm for the application deadline above. Under the
    /// same 400ms deadline and 100ms probe cadence, correlated inventory replies
    /// keep the session healthy for several complete deadline windows.
    #[tokio::test]
    async fn node_control_stays_connected_while_application_acks_continue() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, mut command_rx) = mpsc::channel(4);
        let (event_tx, _event_rx) = mpsc::channel(4);
        let mut registration = Some(build_node_register(
            &test_manifest(),
            "node-test",
            "host-test",
            "broker/test",
            None,
        ));
        let mut inventory = Vec::new();
        let mut load = FleetLoadSnapshot {
            active_agents: 3,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: vec![
                "agent-a".to_string(),
                "agent-b".to_string(),
                "agent-c".to_string(),
            ],
        };

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            while let Some(frame) = ws.next().await {
                let Ok(frame) = frame else { break };
                let Message::Text(text) = frame else { continue };
                match serde_json::from_str::<BrokerToRelaycast>(&text)
                    .expect("valid node-control frame")
                {
                    BrokerToRelaycast::NodeRegister(register) => {
                        if ws
                            .send(Message::Text(
                                json!({
                                    "v": 1, "type": "reply", "id": register.id.unwrap(),
                                    "ok": true, "data": {}
                                })
                                .to_string(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    BrokerToRelaycast::InventorySync(sync) => {
                        let id = sync.id.expect("inventory liveness probe id");
                        if ws
                            .send(Message::Text(
                                serde_json::to_string(&RelaycastToBroker::Reply(
                                    crate::fleet_wire::Reply {
                                        v: FLEET_WIRE_VERSION,
                                        id,
                                        ok: true,
                                        data: json!({ "reconciled": sync.agents.len() }),
                                    },
                                ))
                                .unwrap(),
                            ))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        });

        let shutdown = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1200)).await;
            command_tx
                .send(FleetControlCommand::Shutdown)
                .await
                .unwrap();
        });
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            run_connected_once(
                &FleetControlConfig {
                    ws_url,
                    node_token: Some("nt_test".to_string()),
                    node_id: "node-test".to_string(),
                    node_name: "host-test".to_string(),
                    broker_version: "broker/test".to_string(),
                    token_minter: None,
                    session_token: None,
                    read_idle_timeout: Some(Duration::from_millis(400)),
                    probe: None,
                    terminal_reconnect_tx: None,
                },
                &mut command_rx,
                &event_tx,
                &mut registration,
                &mut inventory,
                &mut load,
                Duration::from_millis(100),
            ),
        )
        .await
        .expect("acknowledged application link should remain connected");

        assert_eq!(result, ControlRunResult::Shutdown);
        shutdown.await.unwrap();
        server.await.unwrap();
    }

    /// Transport handshakes do not make a control session healthy. If the peer
    /// repeatedly drops each socket before acknowledging inventory.sync, the
    /// reconnect delay must continue growing instead of resetting to one second.
    #[tokio::test]
    async fn pre_ready_disconnects_preserve_exponential_reconnect_backoff() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(8);
        let (event_tx, _event_rx) = mpsc::channel(8);

        let client = tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: None,
                session_token: None,
                read_idle_timeout: Some(Duration::from_millis(400)),
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));
        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        let started = Instant::now();
        let mut accepted_at = Vec::new();
        let mut shutdown_ws = None;
        for attempt in 0..3 {
            let (stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .expect("client did not make the next reconnect attempt")
                .unwrap();
            let ws = accept_async(stream).await.unwrap();
            accepted_at.push(started.elapsed());
            if attempt < 2 {
                drop(ws);
            } else {
                shutdown_ws = Some(ws);
                command_tx
                    .send(FleetControlCommand::Shutdown)
                    .await
                    .unwrap();
            }
        }

        client.await.unwrap();
        drop(shutdown_ws);
        assert!(
            accepted_at[1].saturating_sub(accepted_at[0]) >= Duration::from_millis(900),
            "first pre-ready failure must retain the one-second backoff: {accepted_at:?}"
        );
        assert!(
            accepted_at[2].saturating_sub(accepted_at[1]) >= Duration::from_millis(1800),
            "second pre-ready failure must grow to the two-second backoff: {accepted_at:?}"
        );
    }

    /// A blackholed `/v1/node/ws` — the socket still accepts writes, but the
    /// engine never sends another frame — must be detected and reconnected.
    ///
    /// This is the 2026-08-07 `finn-mini` outage: the node stopped heartbeating
    /// engine-side at 11:52:35Z and stayed `offline` for 80 minutes while the
    /// broker's own `/health` still reported `nodeConnected: true`, because
    /// every disconnect path keyed off `send_wire` failing and the writes kept
    /// succeeding into the send buffer. Without [`READ_IDLE_TIMEOUT`] the
    /// client never leaves its `select!`, so the second `accept()` below never
    /// happens and this test fails on the outer timeout.
    #[tokio::test]
    async fn node_control_reconnects_when_peer_goes_silent_but_writes_still_succeed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, _event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: None,
                session_token: None,
                // Short window so the blackhole is covered in well under a
                // second; production uses READ_IDLE_TIMEOUT (48s).
                read_idle_timeout: Some(Duration::from_millis(400)),
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            // Go silent: hold the socket open but never poll it again. Not
            // draining is the point — tungstenite answers pings automatically
            // while a connection is being read, so a server that keeps calling
            // `next()` still looks alive. An unpolled socket keeps the broker's
            // writes succeeding into the send buffer while nothing ever comes
            // back, which is the blackhole this guards against.
            let hold = tokio::spawn(async move {
                let _ws = ws;
                std::future::pending::<()>().await;
            });

            // The client must give up on the silent connection and dial again.
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws2 = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws2).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            hold.abort();
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        // Comfortably above the 400ms window plus reconnect backoff. Without
        // the read-idle check the reconnect never comes at all, so this bound
        // is what turns the hang into a failure.
        tokio::time::timeout(Duration::from_secs(20), server)
            .await
            .expect("client never reconnected after the peer went silent")
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    /// The must-not-fire control arm for the blackhole test above, under the
    /// SAME clock. The negative test proves the detector CAN fire; on its own
    /// that is also what a detector that disconnects unconditionally after
    /// the window would do. This proves it does not fire when the peer is
    /// merely idle at the application layer but still servicing the socket
    /// (so pings get answered) — the actual claim this mechanism makes.
    #[tokio::test]
    async fn node_control_stays_connected_when_peer_is_idle_but_polling() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, _event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: None,
                session_token: None,
                // Same window as the blackhole test, so this is a genuine
                // control arm under identical time pressure rather than a
                // separate, looser test.
                read_idle_timeout: Some(Duration::from_millis(400)),
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            // Stay live: keep polling the socket so tungstenite answers every
            // ping with a pong, the only traffic an idle-but-healthy engine
            // is guaranteed to produce. This is the opposite of the blackhole
            // test's `hold` task, which never polls again.
            let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
            let drain = tokio::spawn(async move {
                loop {
                    tokio::select! {
                        msg = ws.next() => {
                            if msg.is_none() {
                                break;
                            }
                        }
                        _ = &mut stop_rx => break,
                    }
                }
            });

            // Comfortably longer than the 400ms window — several heartbeat
            // intervals' worth of silence at the application layer, serviced
            // only by ping/pong.
            tokio::time::sleep(Duration::from_millis(1200)).await;
            let _ = stop_tx.send(());
            drain.abort();

            // If the client had disconnected and reconnected, a second
            // connection attempt would already be waiting here. None should
            // exist: the accept must still be empty.
            let second_connection =
                tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
            assert!(
                second_connection.is_err(),
                "client reconnected even though the peer stayed live and kept polling"
            );
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server task did not complete")
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    #[tokio::test]
    async fn node_control_reconnect_sends_inventory_sync() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_url = format!("ws://{}/v1/node/ws", listener.local_addr().unwrap());
        let (command_tx, command_rx) = mpsc::channel(32);
        let (event_tx, _event_rx) = mpsc::channel(32);

        tokio::spawn(run_node_control_client(
            FleetControlConfig {
                ws_url,
                node_token: Some("nt_test".to_string()),
                node_id: "node-test".to_string(),
                node_name: "host-test".to_string(),
                broker_version: "broker/test".to_string(),
                token_minter: None,
                session_token: None,
                read_idle_timeout: None,
                probe: None,
                terminal_reconnect_tx: None,
            },
            command_rx,
            event_tx,
        ));

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            match next_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => assert!(sync.agents.is_empty()),
                other => panic!("expected initial empty inventory.sync, got {other:?}"),
            }
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeHeartbeat(_)
            ));
            match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => {
                    assert_eq!(sync.agents.len(), 1);
                    assert_eq!(sync.agents[0].name, "agent-a");
                }
                other => panic!("expected inventory update before reconnect, got {other:?}"),
            }
            ws.close(None).await.unwrap();

            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            assert!(matches!(
                next_node_to_server(&mut ws).await,
                BrokerToRelaycast::NodeRegister(_)
            ));
            match next_non_heartbeat_node_to_server(&mut ws).await {
                BrokerToRelaycast::InventorySync(sync) => {
                    assert_eq!(sync.agents.len(), 1);
                    assert_eq!(sync.agents[0].name, "agent-a");
                }
                other => panic!("expected inventory.sync, got {other:?}"),
            }
        });

        command_tx
            .send(FleetControlCommand::RegisterNode {
                manifest: test_manifest(),
                resume_cursor: None,
            })
            .await
            .unwrap();
        command_tx
            .send(FleetControlCommand::UpdateInventory(vec![InventoryAgent {
                agent_id: "agt-1".to_string(),
                name: "agent-a".to_string(),
                invocation_id: Some("inv-1".to_string()),
                session_ref: Some("session-1".to_string()),
            }]))
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(8), server)
            .await
            .unwrap()
            .unwrap();
        let _ = command_tx.send(FleetControlCommand::Shutdown).await;
    }

    async fn next_node_to_server<S>(ws: &mut S) -> BrokerToRelaycast
    where
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
            + Unpin,
    {
        loop {
            if let Message::Text(text) = ws.next().await.unwrap().unwrap() {
                let frame = serde_json::from_str(&text).unwrap();
                if let BrokerToRelaycast::NodeRegister(register) = &frame {
                    ws.send(Message::Text(
                        json!({"v":1,"type":"reply","id":register.id,"ok":true,"data":{}})
                            .to_string(),
                    ))
                    .await
                    .unwrap();
                }
                return frame;
            }
        }
    }

    async fn next_non_heartbeat_node_to_server<S>(ws: &mut S) -> BrokerToRelaycast
    where
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
            + Unpin,
    {
        loop {
            let message = next_node_to_server(ws).await;
            if !matches!(message, BrokerToRelaycast::NodeHeartbeat(_)) {
                return message;
            }
        }
    }

    fn test_manifest() -> NodeManifest {
        NodeManifest {
            name: "builder".to_string(),
            node_id: None,
            capabilities: vec![crate::protocol::NodeCapabilityManifest {
                name: "run:test".to_string(),
                kind: Some("action".to_string()),
                metadata: Some(HashMap::from([(
                    "suite".to_string(),
                    Value::String("unit".to_string()),
                )])),
            }],
            max_agents: Some(4),
            tags: Some(vec!["test".to_string()]),
            repo_keys: None,
            version: Some("sidecar/test".to_string()),
        }
    }

    #[test]
    fn heartbeat_keeps_unbounded_load_backward_compatible() {
        let register = build_node_register(
            &test_manifest(),
            "node-default",
            "host-default",
            "broker/test",
            None,
        );

        let measured = FleetLoadSnapshot {
            active_agents: 3,
            max_agents: 4,
            handlers_live: true,
            active_agent_names: vec!["worker-b".to_string(), "worker-a".to_string()],
        }
        .heartbeat(&register);
        assert_eq!(measured.load, Some(0.75));
        let live_agent_capability = measured
            .capabilities
            .iter()
            .find(|capability| capability.name == LIVE_AGENT_CAPABILITY_NAME)
            .expect("heartbeat should publish live WorkerNames");
        assert_eq!(
            live_agent_capability
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("names")),
            Some(&serde_json::json!(["worker-a", "worker-b"]))
        );

        let unbounded = FleetLoadSnapshot {
            active_agents: 25,
            max_agents: 0,
            handlers_live: true,
            active_agent_names: Vec::new(),
        }
        .heartbeat(&register);
        assert_eq!(unbounded.load, Some(0.0));

        let value = serde_json::to_value(BrokerToRelaycast::NodeHeartbeat(unbounded)).unwrap();
        assert_eq!(value["load"], 0.0);
        assert_eq!(value["active_agents"], 25);
    }

    #[test]
    fn load_node_token_round_trips_when_node_and_workspace_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        let request_digest = create_node_request_digest("node-a", "host-a", "broker/test");
        persist_node_token(
            &path,
            "node-a",
            "ws-a",
            Some("https://engine.test"),
            "nt_123",
        )
        .unwrap();

        let loaded = load_node_token(&path, "node-a", "ws-a", Some("https://engine.test"));
        assert_eq!(loaded.as_deref(), Some("nt_123"));

        let pending = prepare_node_rotation(
            &path,
            "node-a",
            "ws-a",
            Some("https://engine.test"),
            "nt_123",
            &request_digest,
        )
        .unwrap()
        .idempotency_key
        .expect("a cached token should get a durable rotation key");
        assert!(pending.starts_with("node-rotation:"));
        assert_eq!(
            prepare_node_rotation(
                &path,
                "node-a",
                "ws-a",
                Some("https://engine.test"),
                "nt_123",
                &request_digest,
            )
            .unwrap()
            .idempotency_key
            .as_deref(),
            Some(pending.as_str()),
            "a restart must reuse the durable in-flight recovery key"
        );
        let with_pending: PersistedNodeToken =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            with_pending.pending_rotation_idempotency_key.as_deref(),
            Some(pending.as_str())
        );
        assert_eq!(
            with_pending.pending_rotation_request_digest.as_deref(),
            Some(request_digest.as_str())
        );

        persist_node_token(
            &path,
            "node-a",
            "ws-a",
            Some("https://engine.test"),
            "nt_456",
        )
        .unwrap();
        let replaced = load_node_token(&path, "node-a", "ws-a", Some("https://engine.test"));
        assert_eq!(replaced.as_deref(), Some("nt_456"));
        let replaced_state: PersistedNodeToken =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(replaced_state.pending_rotation_idempotency_key.is_none());
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            2,
            "only the credential and its stable lock file should remain"
        );
    }

    #[test]
    fn stale_env_token_never_replaces_cached_token_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        let request_digest = create_node_request_digest("node-a", "host-a", "broker/test");
        // First run: the configured token is also the cached token, so an
        // accepted rotation may durably retain its replay key and then replace
        // the cache with the server-issued credential.
        persist_node_token(
            &path,
            "node-a",
            "ws-a",
            Some("https://engine.test"),
            "nt_live_stale_env",
        )
        .unwrap();
        assert!(prepare_node_rotation(
            &path,
            "node-a",
            "ws-a",
            Some("https://engine.test"),
            "nt_live_stale_env",
            &request_digest,
        )
        .unwrap()
        .idempotency_key
        .is_some());
        persist_node_token(
            &path,
            "node-a",
            "ws-a",
            Some("https://engine.test"),
            "nt_live_cached_current",
        )
        .unwrap();

        // Two later starts still prefer the pinned environment value in
        // memory. Neither rejected attempt may write it over the good cache.
        for restart in 1..=2 {
            let key = prepare_node_rotation(
                &path,
                "node-a",
                "ws-a",
                Some("https://engine.test"),
                "nt_live_stale_env",
                &request_digest,
            )
            .unwrap()
            .idempotency_key;
            assert!(
                key.is_none(),
                "restart {restart} must keep env-token recovery process-local"
            );
            let persisted: PersistedNodeToken =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                persisted.token, "nt_live_cached_current",
                "restart {restart} must retain the known-good cached token"
            );
            assert!(
                persisted.pending_rotation_idempotency_key.is_none(),
                "restart {restart} must not persist a rotation key for an env token"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn persist_node_token_atomically_replaces_and_syncs_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        persist_node_token(&path, "node-a", "ws-a", None, "nt_old").unwrap();
        persist_node_token(&path, "node-a", "ws-a", None, "nt_new").unwrap();

        assert_eq!(
            load_node_token(&path, "node-a", "ws-a", None).as_deref(),
            Some("nt_new")
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            2,
            "only the credential and its stable lock file should remain"
        );
        // The production path invokes this immediately after the rename; keep
        // the platform durability primitive covered explicitly as well.
        sync_parent_directory(dir.path()).unwrap();
    }

    #[test]
    fn post_rename_sync_failure_reuses_the_committed_rotation_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        let key = "node-rotation:00000000-0000-4000-8000-000000000006";
        let request_digest = create_node_request_digest("node-a", "host-a", "broker/test");

        persist_node_token_state_with_sync(
            &path,
            "node-a",
            "ws-a",
            None,
            "nt_current",
            PendingNodeRotation::Bound {
                key,
                request_digest: &request_digest,
            },
            |_| anyhow::bail!("simulated directory sync failure"),
        )
        .expect("a post-rename sync failure must not discard committed state");

        assert_eq!(
            prepare_node_rotation(&path, "node-a", "ws-a", None, "nt_current", &request_digest,)
                .unwrap()
                .idempotency_key
                .as_deref(),
            Some(key),
            "remint must reuse the key already visible in the replaced cache"
        );
    }

    #[test]
    fn changed_create_node_body_does_not_reuse_pending_rotation_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        persist_node_token(&path, "node-a", "ws-a", None, "nt_current").unwrap();

        let original_digest = create_node_request_digest("node-a", "host-a", "broker/v1");
        let original_key = prepare_node_rotation(
            &path,
            "node-a",
            "ws-a",
            None,
            "nt_current",
            &original_digest,
        )
        .unwrap()
        .idempotency_key
        .unwrap();
        assert_eq!(
            prepare_node_rotation(
                &path,
                "node-a",
                "ws-a",
                None,
                "nt_current",
                &original_digest,
            )
            .unwrap()
            .idempotency_key
            .as_deref(),
            Some(original_key.as_str())
        );

        let mut previous_key = original_key;
        for changed_digest in [
            create_node_request_digest("node-a", "host-b", "broker/v1"),
            create_node_request_digest("node-a", "host-b", "broker/v2"),
        ] {
            let changed_key =
                prepare_node_rotation(&path, "node-a", "ws-a", None, "nt_current", &changed_digest)
                    .unwrap()
                    .idempotency_key
                    .unwrap();
            assert_ne!(changed_key, previous_key);
            let persisted: PersistedNodeToken =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                persisted.pending_rotation_request_digest.as_deref(),
                Some(changed_digest.as_str())
            );
            previous_key = changed_key;
        }
    }

    #[test]
    fn rotation_persists_minted_token_after_metadata_only_cache_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        persist_node_token(&path, "node-a", "ws-a", None, "nt_current").unwrap();

        let original_digest = create_node_request_digest("node-a", "host-a", "broker/v1");
        let preparation = prepare_node_rotation(
            &path,
            "node-a",
            "ws-a",
            None,
            "nt_current",
            &original_digest,
        )
        .unwrap();
        let sibling_digest = create_node_request_digest("node-a", "host-b", "broker/v2");
        let sibling_key = "node-rotation:00000000-0000-4000-8000-000000000007";
        persist_node_token_state(
            &path,
            "node-a",
            "ws-a",
            None,
            "nt_current",
            PendingNodeRotation::Bound {
                key: sibling_key,
                request_digest: &sibling_digest,
            },
        )
        .unwrap();

        assert_eq!(
            persist_node_token_after_rotation(
                &path,
                "node-a",
                "ws-a",
                None,
                &preparation,
                "nt_rotated",
            )
            .unwrap(),
            "nt_rotated"
        );
        let persisted: PersistedNodeToken =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted.token, "nt_rotated");
        assert_eq!(
            persisted.pending_rotation_idempotency_key.as_deref(),
            Some(sibling_key),
            "the sibling must retain its replay capability"
        );
        assert_eq!(
            persisted.pending_rotation_request_digest.as_deref(),
            Some(sibling_digest.as_str())
        );

        let sibling_replay =
            prepare_node_rotation(&path, "node-a", "ws-a", None, "nt_rotated", &sibling_digest)
                .unwrap();
        assert_eq!(sibling_replay.idempotency_key.as_deref(), Some(sibling_key));
        assert_eq!(
            persist_node_token_after_rotation(
                &path,
                "node-a",
                "ws-a",
                None,
                &sibling_replay,
                "nt_sibling_rotated",
            )
            .unwrap(),
            "nt_sibling_rotated"
        );
        assert_eq!(
            load_node_token(&path, "node-a", "ws-a", None).as_deref(),
            Some("nt_sibling_rotated")
        );
    }

    #[test]
    fn rotation_persists_minted_token_and_preserves_legacy_pending_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        persist_node_token(&path, "node-a", "ws-a", None, "nt_current").unwrap();

        let request_digest = create_node_request_digest("node-a", "host-a", "broker/v2");
        let preparation =
            prepare_node_rotation(&path, "node-a", "ws-a", None, "nt_current", &request_digest)
                .unwrap();
        let legacy_key = "node-rotation:00000000-0000-4000-8000-000000000008";
        persist_node_token_state(
            &path,
            "node-a",
            "ws-a",
            None,
            "nt_current",
            PendingNodeRotation::LegacyKey(legacy_key),
        )
        .unwrap();

        assert_eq!(
            persist_node_token_after_rotation(
                &path,
                "node-a",
                "ws-a",
                None,
                &preparation,
                "nt_rotated",
            )
            .unwrap(),
            "nt_rotated"
        );
        let persisted: PersistedNodeToken =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted.token, "nt_rotated");
        assert_eq!(
            persisted.pending_rotation_idempotency_key.as_deref(),
            Some(legacy_key)
        );
        assert!(persisted.pending_rotation_request_digest.is_none());
    }

    #[test]
    fn load_node_token_returns_none_on_workspace_mismatch_even_when_node_matches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        persist_node_token(&path, "node-a", "ws-a", None, "nt_123").unwrap();

        // Same node id, different workspace: the cached token would be rejected
        // with HTTP 401, so it must not be reused.
        assert_eq!(load_node_token(&path, "node-a", "ws-b", None), None);
        // Same workspace still round-trips.
        assert_eq!(
            load_node_token(&path, "node-a", "ws-a", None).as_deref(),
            Some("nt_123")
        );
    }

    #[test]
    fn load_node_token_returns_none_on_node_id_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        persist_node_token(&path, "node-a", "ws-a", None, "nt_123").unwrap();

        assert_eq!(load_node_token(&path, "node-b", "ws-a", None), None);
    }

    #[test]
    fn load_node_token_returns_none_on_base_url_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        persist_node_token(&path, "node-a", "ws-a", Some("https://engine.a"), "nt_123").unwrap();

        // Switching engine base URL re-mints.
        assert_eq!(
            load_node_token(&path, "node-a", "ws-a", Some("https://engine.b")),
            None
        );
        // A run that no longer knows its base URL still reuses on workspace match.
        assert_eq!(
            load_node_token(&path, "node-a", "ws-a", None).as_deref(),
            Some("nt_123")
        );
    }

    #[test]
    fn load_node_token_reuses_legacy_cache_without_base_url() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("node-token.json");
        // A cache written before base_url existed has no base_url field.
        persist_node_token(&path, "node-a", "ws-a", None, "nt_123").unwrap();

        assert_eq!(
            load_node_token(&path, "node-a", "ws-a", Some("https://engine.test")).as_deref(),
            Some("nt_123")
        );
    }

    #[test]
    fn connect_error_is_unauthorized_detects_401_only() {
        use tokio_tungstenite::tungstenite::http::{Response, StatusCode};
        use tokio_tungstenite::tungstenite::Error as WsError;

        let unauthorized = Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(None)
            .unwrap();
        assert!(connect_error_is_unauthorized(&WsError::Http(unauthorized)));

        let forbidden = Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(None)
            .unwrap();
        assert!(!connect_error_is_unauthorized(&WsError::Http(forbidden)));

        assert!(!connect_error_is_unauthorized(&WsError::ConnectionClosed));
    }

    #[test]
    fn default_node_token_path_is_scoped_per_node_id() {
        // The cache file must carry the node id so two brokers on one host (each
        // with a distinct per-cwd node id) never overwrite each other's token.
        let a = default_node_token_path("node_aaaa");
        let b = default_node_token_path("node_bbbb");
        // When the data dir is unavailable both are None; skip in that case.
        if let (Some(a), Some(b)) = (a.as_ref(), b.as_ref()) {
            assert_ne!(a, b, "distinct node ids must map to distinct cache files");
            assert!(a.ends_with("node_aaaa.json"));
            assert!(b.ends_with("node_bbbb.json"));
            // Same broker (same node id) is stable across calls/restarts.
            assert_eq!(a, &default_node_token_path("node_aaaa").unwrap());
            // Cache lives under a per-node directory, not a single global file.
            assert!(a.parent().unwrap().ends_with("node-tokens"));
        }
    }

    #[test]
    fn sanitize_node_id_keeps_safe_chars_and_replaces_separators() {
        // The canonical id is already filename-safe.
        assert_eq!(
            sanitize_node_id_for_filename("node_0123abcd-XY"),
            "node_0123abcd-XY"
        );
        // Path separators and other unsafe chars are neutralized so the cache
        // path can never escape the node-tokens directory.
        assert_eq!(
            sanitize_node_id_for_filename("../../etc/passwd"),
            "______etc_passwd"
        );
        assert_eq!(sanitize_node_id_for_filename("a/b\\c"), "a_b_c");
        // Empty input still yields a usable stem.
        assert_eq!(sanitize_node_id_for_filename(""), "node");
    }

    #[test]
    fn remint_cap_trips_after_n_consecutive_401s_even_when_mints_succeed() {
        // Models the loop's counter discipline (Bug 3): the consecutive-401
        // counter is incremented per 401 and only reset when a connection
        // actually establishes — NEVER on a successful re-mint. So even if every
        // mint succeeds, N consecutive 401s exhaust the budget and trip the cap.
        let mut consecutive_unauthorized: u32 = 0;
        let mint_always_succeeds = true;
        let mut mints_attempted = 0u32;

        // Simulate an unbroken run of 401s (no intervening `Disconnected`, so the
        // counter is never reset).
        loop {
            consecutive_unauthorized = consecutive_unauthorized.saturating_add(1);
            if should_attempt_remint(consecutive_unauthorized) {
                // A mint is attempted and (per the scenario) succeeds — but the
                // counter is deliberately NOT reset here.
                assert!(mint_always_succeeds);
                mints_attempted += 1;
            } else {
                // Budget exhausted: the loop would surface the loud "giving up"
                // error instead of minting again.
                break;
            }
            // Guard against a regression that loops forever.
            assert!(consecutive_unauthorized <= MAX_UNAUTHORIZED_BEFORE_GIVING_UP + 2);
        }

        // The cap is reachable: minting stops after the budget is spent.
        assert_eq!(mints_attempted, MAX_UNAUTHORIZED_BEFORE_GIVING_UP);
        assert_eq!(
            consecutive_unauthorized,
            MAX_UNAUTHORIZED_BEFORE_GIVING_UP + 1
        );

        // A connection establishing (`Disconnected` arm) resets the budget.
        consecutive_unauthorized = 0;
        assert!(should_attempt_remint(
            consecutive_unauthorized.saturating_add(1)
        ));
    }
    #[tokio::test]
    async fn task_receipts_are_forwarded_without_consuming_agent_registration_waiters() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut registrations = HashMap::new();
        let mut deregistrations = HashMap::new();
        let mut liveness = ApplicationLiveness::new(Duration::from_secs(1));
        let mut sink = futures_util::sink::drain();
        for raw in [
            serde_json::json!({"v":1,"type":"reply","id":"task_receipt_a","ok":true,"data":{"status":"running"}}),
            serde_json::json!({"v":1,"type":"error","id":"task_receipt_b","ok":false,"code":"stale_task_execution","message":"stale"}),
        ] {
            assert!(
                handle_server_message(
                    Message::Text(raw.to_string()),
                    &tx,
                    &mut registrations,
                    &mut deregistrations,
                    &mut liveness,
                    "node-test",
                    &mut sink,
                    None,
                    None,
                )
                .await
            );
            let event = rx.recv().await.unwrap();
            match event {
                FleetControlEvent::Message(RelaycastToBroker::Reply(reply)) => {
                    assert_eq!(reply.id, "task_receipt_a")
                }
                FleetControlEvent::Message(RelaycastToBroker::Error(error)) => {
                    assert_eq!(error.id, "task_receipt_b")
                }
                other => panic!("unexpected event {other:?}"),
            }
        }
    }
}

#[cfg(test)]
mod registration_tests;
