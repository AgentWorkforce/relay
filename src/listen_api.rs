//! HTTP API types and handlers for the broker's `--api-port` mode.
//!
//! This module contains the axum router, request types, and endpoint handlers
//! that power the dashboard's REST API for spawning/releasing agents and
//! sending messages.

use std::time::{Duration, Instant};

use relay_broker::{
    multi_workspace::WorkspaceMembershipSummary,
    protocol::MessageInjectionMode,
    replay_buffer::ReplayBuffer,
    types::{InboundDeliveryMode, PendingRelayMessage},
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};
use tokio::time::timeout;
use uuid::Uuid;

use crate::worker_request::{RequestWorkerError, DEFAULT_REQUEST_TIMEOUT};

const LISTEN_API_SEND_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Request / State types
// ---------------------------------------------------------------------------

pub enum ListenApiRequest {
    Spawn {
        name: String,
        cli: String,
        transport: Option<String>,
        model: Option<String>,
        args: Vec<String>,
        task: Option<String>,
        channels: Vec<String>,
        cwd: Option<String>,
        team: Option<String>,
        shadow_of: Option<String>,
        shadow_mode: Option<String>,
        continue_from: Option<String>,
        idle_threshold_secs: Option<u64>,
        skip_relay_prompt: bool,
        restart_policy: Box<Option<Value>>,
        agent_token: Option<String>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    SetModel {
        name: String,
        model: String,
        timeout_ms: Option<u64>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Release {
        name: String,
        reason: Option<String>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    List {
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Threads {
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Send {
        to: String,
        text: String,
        from: Option<String>,
        thread_id: Option<String>,
        workspace_id: Option<String>,
        workspace_alias: Option<String>,
        mode: MessageInjectionMode,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    SendInput {
        name: String,
        data: String,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    ResizePty {
        name: String,
        rows: u16,
        cols: u16,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    /// Generic worker request/response RPC: park a oneshot in the
    /// broker's `pending_requests` map keyed by a fresh `request_id`,
    /// frame the request, and ship it to the named worker over its
    /// stdin pipe. The reply fires when the worker echoes a matching
    /// `*_response` frame or the deadline elapses (whichever first).
    ///
    /// Used by request/response routes like `GET /api/spawned/{name}/snapshot`.
    /// Fire-and-forget routes (`send_input`, `resize_pty`) keep their
    /// existing single-arm channel pattern.
    WorkerRequest {
        name: String,
        /// Outbound frame `type`, e.g. `"snapshot_pty"`. The worker is
        /// expected to reply with `"{kind}_response"`.
        kind: String,
        /// Worker stdin frame payload — must match the worker-side
        /// schema for `kind`.
        payload: Value,
        /// Max wall-clock duration the broker will wait for the worker's
        /// response before sending [`RequestWorkerError::Timeout`].
        timeout: Duration,
        reply: tokio::sync::oneshot::Sender<Result<Value, RequestWorkerError>>,
    },
    GetMetrics {
        agent: Option<String>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    GetStatus {
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    GetCrashInsights {
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Preflight {
        agents: Vec<PreflightEntry>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    SubscribeChannels {
        name: String,
        channels: Vec<String>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    UnsubscribeChannels {
        name: String,
        channels: Vec<String>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Shutdown {
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    RenewLease {
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    /// `GET /api/spawned/{name}/delivery-mode` — read the current inbound
    /// delivery mode.
    GetInboundDeliveryMode {
        name: String,
        reply: tokio::sync::oneshot::Sender<Result<InboundDeliveryMode, DeliveryRouteError>>,
    },
    /// `PUT /api/spawned/{name}/delivery-mode` — set the inbound delivery mode.
    /// On a `manual_flush → auto_inject` transition the broker drains the pending
    /// queue into the worker (via the existing inject path) before
    /// replying; `flushed` reports how many messages were injected.
    SetInboundDeliveryMode {
        name: String,
        mode: InboundDeliveryMode,
        reply: tokio::sync::oneshot::Sender<Result<SetInboundDeliveryModeOk, DeliveryRouteError>>,
    },
    /// `GET /api/spawned/{name}/pending` — snapshot the per-worker
    /// pending-message queue (FIFO, head first).
    GetPending {
        name: String,
        reply: tokio::sync::oneshot::Sender<Result<Vec<PendingRelayMessage>, DeliveryRouteError>>,
    },
    /// `POST /api/spawned/{name}/flush` — drain the pending queue and
    /// inject every message into the worker via the existing
    /// fire-and-forget inject path. Does *not* change the mode.
    FlushPending {
        name: String,
        reply: tokio::sync::oneshot::Sender<Result<usize, DeliveryRouteError>>,
    },
}

/// Typed errors for the inbound-delivery-mode HTTP routes. Keeps the broker arm's
/// reply payload structured so the HTTP handler can map cleanly to 404
/// without parsing strings. The "broker channel closed" / "reply dropped"
/// failure modes are handled at the HTTP boundary via [`internal_error`],
/// so they don't need a variant here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryRouteError {
    /// No worker with that name is currently registered with the broker.
    WorkerNotFound(String),
}

impl std::fmt::Display for DeliveryRouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeliveryRouteError::WorkerNotFound(name) => {
                write!(f, "agent_not_found: no worker named '{name}'")
            }
        }
    }
}

impl std::error::Error for DeliveryRouteError {}

/// Reply payload for [`ListenApiRequest::SetInboundDeliveryMode`]. `flushed`
/// is the number of pending messages drained during the transition
/// (always `0` unless we transitioned `manual_flush → auto_inject`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetInboundDeliveryModeOk {
    pub mode: InboundDeliveryMode,
    pub flushed: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreflightEntry {
    pub name: String,
    pub cli: String,
}

/// Format requested by `GET /api/spawned/{name}/snapshot?format=…`. Parsed
/// in the route handler so the broker loop receives a typed value instead of
/// re-validating a string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotFormat {
    Plain,
    Ansi,
}

impl SnapshotFormat {
    pub fn as_wire_str(&self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Ansi => "ansi",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "plain" | "text" => Some(Self::Plain),
            "ansi" => Some(Self::Ansi),
            _ => None,
        }
    }
}

#[derive(Clone)]
struct ListenApiState {
    tx: mpsc::Sender<ListenApiRequest>,
    events_tx: broadcast::Sender<String>,
    broker_api_key: Option<String>,
    replay_buffer: ReplayBuffer,
    /// Relaycast workspace API key — returned by the authenticated /api/config
    /// endpoint so the dashboard can bootstrap Relaycast calls without a
    /// relaycast.json or env var.
    workspace_key: Option<String>,
    memberships: Vec<WorkspaceMembershipSummary>,
    default_workspace_id: Option<String>,
    /// Broker version string (from Cargo.toml)
    broker_version: String,
    /// Whether the broker is in persist mode
    persist: bool,
    /// When the broker started
    started_at: std::time::Instant,
}

#[derive(Debug, Deserialize, Default)]
struct ListenReplayQuery {
    #[serde(rename = "sinceSeq")]
    since_seq_camel: Option<u64>,
    #[serde(rename = "since_seq")]
    since_seq_snake: Option<u64>,
}

impl ListenReplayQuery {
    fn since_seq(&self) -> u64 {
        self.since_seq_camel.or(self.since_seq_snake).unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub struct ListenApiConfig {
    pub tx: mpsc::Sender<ListenApiRequest>,
    pub events_tx: broadcast::Sender<String>,
    pub replay_buffer: ReplayBuffer,
    pub workspace_key: Option<String>,
    pub memberships: Vec<WorkspaceMembershipSummary>,
    pub default_workspace_id: Option<String>,
    pub persist: bool,
}

pub fn listen_api_router(config: ListenApiConfig) -> axum::Router {
    listen_api_router_with_auth(config, configured_broker_api_key())
}

fn configured_broker_api_key() -> Option<String> {
    std::env::var("RELAY_BROKER_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn listen_api_router_with_auth(
    config: ListenApiConfig,
    broker_api_key: Option<String>,
) -> axum::Router {
    use axum::{middleware, routing, Router};

    let state = ListenApiState {
        tx: config.tx,
        events_tx: config.events_tx,
        broker_api_key: broker_api_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        replay_buffer: config.replay_buffer,
        workspace_key: config
            .workspace_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        memberships: config.memberships,
        default_workspace_id: config.default_workspace_id,
        broker_version: env!("CARGO_PKG_VERSION").to_string(),
        persist: config.persist,
        started_at: std::time::Instant::now(),
    };

    let protected = Router::new()
        .route("/api/session", routing::get(listen_api_session))
        .route("/api/session/renew", routing::post(listen_api_renew_lease))
        .route("/api/spawn", routing::post(listen_api_spawn))
        .route("/api/spawned", routing::get(listen_api_list))
        .route(
            "/api/spawned/{name}/model",
            routing::post(listen_api_set_model),
        )
        .route("/api/threads", routing::get(listen_api_threads))
        .route("/api/events/replay", routing::get(listen_api_replay))
        .route("/api/spawned/{name}", routing::delete(listen_api_release))
        .route(
            "/api/agents/by-name/{name}/interrupt",
            routing::post(listen_api_interrupt),
        )
        .route("/api/send", routing::post(listen_api_send))
        .route("/api/input/{name}", routing::post(listen_api_send_input))
        .route("/api/resize/{name}", routing::post(listen_api_resize_pty))
        .route(
            "/api/spawned/{name}/snapshot",
            routing::get(listen_api_snapshot),
        )
        .route(
            "/api/spawned/{name}/delivery-mode",
            routing::get(listen_api_get_inbound_delivery_mode)
                .put(listen_api_set_inbound_delivery_mode),
        )
        .route(
            "/api/spawned/{name}/pending",
            routing::get(listen_api_get_pending),
        )
        .route(
            "/api/spawned/{name}/flush",
            routing::post(listen_api_flush_pending),
        )
        .route("/api/metrics", routing::get(listen_api_metrics))
        .route("/api/status", routing::get(listen_api_status))
        .route(
            "/api/crash-insights",
            routing::get(listen_api_crash_insights),
        )
        .route("/api/preflight", routing::post(listen_api_preflight))
        .route("/api/shutdown", routing::post(listen_api_shutdown))
        .route(
            "/api/spawned/{name}/subscribe",
            routing::post(listen_api_subscribe_channels),
        )
        .route(
            "/api/spawned/{name}/unsubscribe",
            routing::post(listen_api_unsubscribe_channels),
        )
        .route("/api/history/stats", routing::get(listen_api_history_stats))
        .route("/api/config", routing::get(listen_api_config))
        .route("/ws", routing::get(listen_api_ws))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            listen_api_auth_middleware,
        ));

    Router::new()
        .route("/health", routing::get(listen_api_health))
        .merge(protected)
        .with_state(state.clone())
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

pub(crate) fn listen_api_health_payload(
    default_workspace_id: Option<String>,
    memberships: Vec<WorkspaceMembershipSummary>,
) -> Value {
    let startup_error_code = std::env::var("AGENT_RELAY_STARTUP_ERROR_CODE").ok();
    let status = startup_health_status(startup_error_code.as_deref());
    let workspace_id = default_workspace_id
        .clone()
        .or_else(|| {
            memberships
                .first()
                .map(|membership| membership.workspace_id.clone())
        })
        .unwrap_or_else(|| "ws_unknown".to_string());

    json!({
        "status": status,
        "service": "agent-relay-listen",
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeMs": 0,
        "workspaceId": workspace_id,
        "defaultWorkspaceId": default_workspace_id,
        "memberships": memberships,
        "agentCount": 0,
        "pendingDeliveryCount": 0,
        "wsConnections": 0,
        "memoryMb": 0,
        "relaycastConnected": startup_error_code.is_none(),
    })
}

async fn listen_api_health(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> axum::Json<Value> {
    axum::Json(listen_api_health_payload(
        state.default_workspace_id,
        state.memberships,
    ))
}

/// Authenticated endpoint that returns broker configuration, including the
/// Relaycast workspace API key.  Unlike /health this endpoint sits behind the
/// auth middleware so the key is not exposed to unauthenticated callers.
async fn listen_api_session(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> axum::Json<Value> {
    axum::Json(json!({
        "broker_version": state.broker_version,
        "protocol_version": 1,
        "workspace_key": state.workspace_key,
        "default_workspace_id": state.default_workspace_id,
        "mode": if state.persist { "persist" } else { "ephemeral" },
        "uptime_secs": state.started_at.elapsed().as_secs(),
    }))
}

async fn listen_api_config(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> axum::Json<Value> {
    axum::Json(json!({
        "workspaceKey": state.workspace_key,
        "defaultWorkspaceId": state.default_workspace_id,
        "memberships": state.memberships,
    }))
}

fn startup_health_status(startup_error_code: Option<&str>) -> &'static str {
    let Some(code) = startup_error_code.map(str::trim) else {
        return "ok";
    };
    if code.eq_ignore_ascii_case("rate_limit_exceeded") {
        "degraded"
    } else {
        "ok"
    }
}

async fn listen_api_replay(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Query(query): axum::extract::Query<ListenReplayQuery>,
) -> axum::Json<Value> {
    let since_seq = query.since_seq();
    let (entries, gap_oldest) = state.replay_buffer.replay_since(since_seq).await;
    let events: Vec<Value> = entries.into_iter().map(|entry| entry.event).collect();
    axum::Json(json!({
        "events": events,
        "gap": gap_oldest.is_some(),
        "oldestAvailable": gap_oldest.unwrap_or(since_seq),
    }))
}

fn unauthorized_error_envelope() -> Value {
    json!({
        "error": {
            "code": "unauthorized",
            "message": "Missing or invalid API key",
            "retryable": false,
            "statusCode": 401,
        }
    })
}

async fn listen_api_auth_middleware(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    request: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, (axum::http::StatusCode, axum::Json<Value>)> {
    let Some(expected) = state.broker_api_key.as_deref() else {
        return Ok(next.run(request).await);
    };

    // Accept token from X-API-Key header or Authorization: Bearer <token>
    let provided = request
        .headers()
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });

    if provided != Some(expected) {
        return Err((
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(unauthorized_error_envelope()),
        ));
    }

    Ok(next.run(request).await)
}

async fn listen_api_spawn(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::Json(body): axum::Json<Value>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let cli = body
        .get("cli")
        .and_then(Value::as_str)
        .unwrap_or("claude")
        .to_string();
    let model = body.get("model").and_then(Value::as_str).map(String::from);
    let transport = body
        .get("transport")
        .or_else(|| body.get("runtime"))
        .and_then(Value::as_str)
        .map(String::from);
    let args: Vec<String> = body
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let task = body.get("task").and_then(Value::as_str).map(String::from);
    let channels: Vec<String> = body
        .get("channels")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let cwd = body.get("cwd").and_then(Value::as_str).map(String::from);
    let team = body.get("team").and_then(Value::as_str).map(String::from);
    let shadow_of = body
        .get("shadow_of")
        .or_else(|| body.get("shadowOf"))
        .and_then(Value::as_str)
        .map(String::from);
    let shadow_mode = body
        .get("shadow_mode")
        .or_else(|| body.get("shadowMode"))
        .and_then(Value::as_str)
        .map(String::from);
    let continue_from = body
        .get("continue_from")
        .or_else(|| body.get("continueFrom"))
        .and_then(Value::as_str)
        .map(String::from);
    let idle_threshold_secs = body
        .get("idle_threshold_secs")
        .or_else(|| body.get("idleThresholdSecs"))
        .and_then(Value::as_u64);
    let skip_relay_prompt = body
        .get("skip_relay_prompt")
        .or_else(|| body.get("skipRelayPrompt"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let restart_policy = Box::new(
        body.get("restart_policy")
            .or_else(|| body.get("restartPolicy"))
            .cloned(),
    );
    let agent_token = body
        .get("agent_token")
        .or_else(|| body.get("agentToken"))
        .and_then(Value::as_str)
        .map(String::from);

    if name.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(json!({ "success": false, "error": "Missing required field: name" })),
        );
    }

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Spawn {
            name: name.clone(),
            cli,
            transport,
            model,
            args,
            task,
            channels,
            cwd,
            team,
            shadow_of,
            shadow_mode,
            continue_from,
            idle_threshold_secs,
            skip_relay_prompt,
            restart_policy,
            agent_token,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal channel closed" })),
        );
    }

    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "name": name, "error": err })),
        ),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal reply dropped" })),
        ),
    }
}

async fn listen_api_list(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> axum::Json<Value> {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::List { reply: reply_tx })
        .await
        .is_err()
    {
        return axum::Json(json!({ "success": false, "agents": [] }));
    }
    match reply_rx.await {
        Ok(Ok(val)) => axum::Json(val),
        _ => axum::Json(json!({ "success": false, "agents": [] })),
    }
}

#[derive(Debug, Deserialize)]
struct ListenApiSetModelPayload {
    model: String,
    #[serde(default, alias = "timeoutMs")]
    timeout_ms: Option<u64>,
}

async fn listen_api_set_model(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    axum::Json(body): axum::Json<ListenApiSetModelPayload>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let model = body.model.trim().to_string();
    if model.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(json!({ "success": false, "error": "Missing required field: model" })),
        );
    }

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::SetModel {
            name: name.clone(),
            model: model.clone(),
            timeout_ms: body.timeout_ms,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal channel closed" })),
        );
    }

    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "name": name, "error": err })),
        ),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal reply dropped" })),
        ),
    }
}

async fn listen_api_threads(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> axum::Json<Value> {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Threads { reply: reply_tx })
        .await
        .is_err()
    {
        return axum::Json(json!({ "threads": [] }));
    }
    match reply_rx.await {
        Ok(Ok(val)) => axum::Json(val),
        _ => axum::Json(json!({ "threads": [] })),
    }
}

async fn listen_api_release(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    body: Option<axum::Json<Value>>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let reason = body.and_then(|b| b.get("reason").and_then(|v| v.as_str()).map(String::from));
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Release {
            name: name.clone(),
            reason,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal channel closed" })),
        );
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "name": name, "error": err })),
        ),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal reply dropped" })),
        ),
    }
}

async fn listen_api_interrupt(
    axum::extract::Path(name): axum::extract::Path<String>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        axum::Json(json!({
            "success": false,
            "error": "Agent interrupt is not yet supported by the broker HTTP API.",
            "name": name,
        })),
    )
}

async fn listen_api_send(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::Json(body): axum::Json<Value>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let request_id = Uuid::new_v4().to_string();
    let to = body
        .get("to")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let text = body
        .get("message")
        .or_else(|| body.get("text"))
        .or_else(|| body.get("body"))
        .or_else(|| body.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let from = body.get("from").and_then(Value::as_str).map(String::from);
    let thread_id = body
        .get("thread")
        .or_else(|| body.get("thread_id"))
        .or_else(|| body.get("threadId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let workspace_id = body
        .get("workspaceId")
        .or_else(|| body.get("workspace_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let workspace_alias = body
        .get("workspaceAlias")
        .or_else(|| body.get("workspace_alias"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mode_input = body
        .get("mode")
        .or_else(|| body.get("injectionMode"))
        .or_else(|| body.get("injection_mode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());
    let mode = match mode_input.as_deref() {
        Some("wait") | None => MessageInjectionMode::Wait,
        Some("steer") => MessageInjectionMode::Steer,
        Some(other) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                axum::Json(json!({
                    "success": false,
                    "error": format!("invalid mode '{other}'. expected 'wait' or 'steer'"),
                })),
            );
        }
    };
    tracing::info!(
        target = "relay_broker::http_api",
        request_id = %request_id,
        to = %to,
        from = ?from,
        thread_id = ?thread_id,
        workspace_id = ?workspace_id,
        workspace_alias = ?workspace_alias,
        "received HTTP API send request"
    );

    if to.is_empty() || text.is_empty() {
        tracing::warn!(
            target = "relay_broker::http_api",
            request_id = %request_id,
            "HTTP API send request rejected: missing required fields"
        );
        return (
            axum::http::StatusCode::BAD_REQUEST,
            axum::Json(json!({
                "success": false,
                "error": "Missing required fields: to, message",
            })),
        );
    }

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Send {
            to: to.clone(),
            text,
            from,
            thread_id,
            workspace_id,
            workspace_alias,
            mode,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        tracing::warn!(
            target = "relay_broker::http_api",
            request_id = %request_id,
            "HTTP API send request dropped before broker consumed it"
        );
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal channel closed" })),
        );
    }

    let started_at = Instant::now();
    match timeout(LISTEN_API_SEND_TIMEOUT, reply_rx).await {
        Ok(Ok(Ok(val))) => {
            tracing::info!(
                target = "relay_broker::http_api",
                request_id = %request_id,
                to = %to,
                duration_ms = %started_at.elapsed().as_millis(),
                "HTTP API send request completed successfully"
            );
            (axum::http::StatusCode::OK, axum::Json(val))
        }
        Ok(Ok(Err(err))) => {
            let raw_error = err.to_string();
            let status = if raw_error.starts_with("ambiguous_workspace:")
                || raw_error.starts_with("workspace_not_found:")
            {
                axum::http::StatusCode::BAD_REQUEST
            } else if raw_error.contains("Agent \"") && raw_error.contains("not found") {
                axum::http::StatusCode::NOT_FOUND
            } else {
                axum::http::StatusCode::BAD_GATEWAY
            };
            let error = raw_error
                .strip_prefix("ambiguous_workspace:")
                .or_else(|| raw_error.strip_prefix("workspace_not_found:"))
                .unwrap_or(&raw_error)
                .to_string();
            tracing::warn!(
                target = "relay_broker::http_api",
                request_id = %request_id,
                to = %to,
                status = status.as_u16(),
                error = %err,
                duration_ms = %started_at.elapsed().as_millis(),
                "HTTP API send request completed with broker error"
            );
            (
                status,
                axum::Json(json!({
                    "success": false,
                    "to": to,
                    "error": error,
                })),
            )
        }
        Ok(Err(_)) => {
            tracing::warn!(
                target = "relay_broker::http_api",
                request_id = %request_id,
                to = %to,
                "HTTP API send request reply channel closed"
            );
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "success": false, "error": "internal reply dropped" })),
            )
        }
        Err(_) => {
            tracing::warn!(
                target = "relay_broker::http_api",
                request_id = %request_id,
                to = %to,
                duration_ms = %started_at.elapsed().as_millis(),
                "HTTP API send request timed out waiting for broker"
            );
            (
                axum::http::StatusCode::GATEWAY_TIMEOUT,
                axum::Json(json!({
                    "success": false,
                    "error": "broker request timed out",
                })),
            )
        }
    }
}

async fn listen_api_history_stats() -> axum::Json<Value> {
    axum::Json(json!({
        "messageCount": 0,
        "sessionCount": 0,
        "activeSessions": 0,
        "uniqueAgents": 0,
        "oldestMessageDate": null,
    }))
}

// ---------------------------------------------------------------------------
// Structured error helper
// ---------------------------------------------------------------------------

fn api_error(
    status: axum::http::StatusCode,
    code: &str,
    message: impl Into<String>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    (
        status,
        axum::Json(json!({ "code": code, "message": message.into() })),
    )
}

/// Parse an error string like "agent_not_found: worker-a" into a
/// (code, status) pair.
///
/// Used by routes that still surface stringly-typed errors (e.g.
/// `send_input`, `resize_pty`). Routes built on `WorkerRequest` go
/// through [`worker_request_error_to_response`] instead, which
/// preserves typed-error code/status mappings but falls back here for
/// the structured `RequestWorkerError::WorkerError` envelope so worker-
/// side codes like `invalid_format` keep producing 400s.
fn classify_error(err: &str) -> (axum::http::StatusCode, &str) {
    if err.starts_with("agent_not_found") {
        (axum::http::StatusCode::NOT_FOUND, "agent_not_found")
    } else if err.starts_with("unsupported_operation") {
        (axum::http::StatusCode::BAD_REQUEST, "unsupported_operation")
    } else if err.starts_with("unsupported_runtime") {
        // Caller asked for an operation that this worker's runtime
        // doesn't support (e.g. snapshot_pty against a headless worker).
        // 409 Conflict — the request itself is well-formed; the conflict
        // is with the resource's current capabilities.
        (axum::http::StatusCode::CONFLICT, "unsupported_runtime")
    } else if err.starts_with("worker_timeout") {
        // Worker died or stalled between accepting the frame and
        // replying. This is a server-side fault, not a bad request.
        (axum::http::StatusCode::GATEWAY_TIMEOUT, "worker_timeout")
    } else if err.starts_with("invalid_") {
        (axum::http::StatusCode::BAD_REQUEST, "invalid_request")
    } else {
        (axum::http::StatusCode::BAD_REQUEST, "request_failed")
    }
}

fn internal_error() -> (axum::http::StatusCode, axum::Json<Value>) {
    api_error(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "internal channel closed",
    )
}

// ---------------------------------------------------------------------------
// PTY input / resize
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SendInputBody {
    data: String,
}

async fn listen_api_send_input(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    axum::Json(body): axum::Json<SendInputBody>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::SendInput {
            name: name.clone(),
            data: body.data,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => api_error(axum::http::StatusCode::BAD_REQUEST, "agent_not_found", err),
        Err(_) => internal_error(),
    }
}

#[derive(Deserialize)]
struct ResizePtyBody {
    rows: u16,
    cols: u16,
}

async fn listen_api_resize_pty(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    axum::Json(body): axum::Json<ResizePtyBody>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::ResizePty {
            name: name.clone(),
            rows: body.rows,
            cols: body.cols,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(ref err)) => {
            let (status, code) = classify_error(err);
            api_error(status, code, err.clone())
        }
        Err(_) => internal_error(),
    }
}

// ---------------------------------------------------------------------------
// PTY snapshot
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct SnapshotQuery {
    format: Option<String>,
}

/// Capture the current visible screen of a PTY worker.
///
/// Defaults to `format=plain`. Returns the rendered screen plus the cursor
/// position and dimensions so callers can lay it out without re-querying
/// the worker. The `ansi` variant base64-encodes the bytes because the
/// reproduction stream is binary (contains control characters).
async fn listen_api_snapshot(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<SnapshotQuery>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let format_raw = query.format.as_deref().unwrap_or("plain");
    let Some(format) = SnapshotFormat::parse(format_raw) else {
        return api_error(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_format",
            format!("unsupported snapshot format '{format_raw}' (expected 'plain' or 'ansi')"),
        );
    };

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::WorkerRequest {
            name: name.clone(),
            kind: "snapshot_pty".to_string(),
            payload: json!({ "format": format.as_wire_str() }),
            timeout: DEFAULT_REQUEST_TIMEOUT,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => worker_request_error_to_response(&err),
        Err(_) => internal_error(),
    }
}

// ---------------------------------------------------------------------------
// Inbound delivery mode (per-agent inject vs. queue, plus pending-queue inspection)
//
// The broker keeps an `InboundDeliveryMode` per worker; `manual_flush`
// mode parks inbound relay messages in a FIFO `pending` queue instead
// of injecting them.
// These four routes are the server-side surface the `agent-relay drive`
// client calls to flip modes, inspect the queue, and drain it.
// ---------------------------------------------------------------------------

/// `GET /api/spawned/{name}/delivery-mode` → `{ "mode": "auto_inject" | "manual_flush" }`.
async fn listen_api_get_inbound_delivery_mode(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::GetInboundDeliveryMode {
            name: name.clone(),
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(mode)) => (
            axum::http::StatusCode::OK,
            axum::Json(json!({ "mode": mode.as_wire_str() })),
        ),
        Ok(Err(err)) => delivery_route_error_to_response(&err),
        Err(_) => internal_error(),
    }
}

#[derive(Debug, Deserialize)]
struct SetInboundDeliveryModePayload {
    mode: String,
}

/// `PUT /api/spawned/{name}/delivery-mode` — body
/// `{ "mode": "auto_inject" | "manual_flush" }`.
///
/// On a `manual_flush → auto_inject` transition the broker drains the pending
/// queue into the worker via the existing inject path *before* replying,
/// so a caller flipping back to auto-inject never strands messages. The
/// response reports `flushed` (always `0` unless we drained).
async fn listen_api_set_inbound_delivery_mode(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    axum::Json(body): axum::Json<SetInboundDeliveryModePayload>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let Some(mode) = InboundDeliveryMode::parse(&body.mode) else {
        return api_error(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_mode",
            format!(
                "unsupported inbound delivery mode '{}' (expected 'auto_inject' or 'manual_flush')",
                body.mode
            ),
        );
    };

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::SetInboundDeliveryMode {
            name: name.clone(),
            mode,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(ok)) => (
            axum::http::StatusCode::OK,
            axum::Json(json!({
                "mode": ok.mode.as_wire_str(),
                "flushed": ok.flushed,
            })),
        ),
        Ok(Err(err)) => delivery_route_error_to_response(&err),
        Err(_) => internal_error(),
    }
}

/// `GET /api/spawned/{name}/pending` → `{ "pending": [ ... ] }`, FIFO
/// (head of queue first). Empty array when the worker is not in
/// `manual_flush` delivery mode or simply has no pending messages.
async fn listen_api_get_pending(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::GetPending {
            name: name.clone(),
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(messages)) => {
            let pending: Vec<Value> = messages
                .into_iter()
                .map(|m| {
                    let mut payload = json!({
                        "from": m.from,
                        "body": m.body,
                        "target": m.target,
                        "priority": m.priority,
                        "mode": m.mode,
                        "queued_at_ms": m.queued_at_ms,
                    });
                    let obj = payload.as_object_mut().expect("payload object built above");
                    if let Some(thread_id) = m.thread_id {
                        obj.insert("thread_id".to_string(), Value::String(thread_id));
                    }
                    if let Some(workspace_id) = m.workspace_id {
                        obj.insert("workspace_id".to_string(), Value::String(workspace_id));
                    }
                    if let Some(workspace_alias) = m.workspace_alias {
                        obj.insert(
                            "workspace_alias".to_string(),
                            Value::String(workspace_alias),
                        );
                    }
                    if let Some(event_id) = m.event_id {
                        obj.insert("event_id".to_string(), Value::String(event_id));
                    }
                    payload
                })
                .collect();
            (
                axum::http::StatusCode::OK,
                axum::Json(json!({ "pending": pending })),
            )
        }
        Ok(Err(err)) => delivery_route_error_to_response(&err),
        Err(_) => internal_error(),
    }
}

/// `POST /api/spawned/{name}/flush` → `{ "flushed": N }`.
///
/// Drains the queue and injects each message into the worker in order
/// using the existing fire-and-forget inject path. The inbound delivery mode is
/// *not* changed — a caller still in `manual_flush` delivery mode will continue
/// to queue newly-arriving messages.
async fn listen_api_flush_pending(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::FlushPending {
            name: name.clone(),
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(flushed)) => (
            axum::http::StatusCode::OK,
            axum::Json(json!({ "flushed": flushed })),
        ),
        Ok(Err(err)) => delivery_route_error_to_response(&err),
        Err(_) => internal_error(),
    }
}

/// Centralised mapping from [`DeliveryRouteError`] to HTTP responses for
/// the four inbound-delivery-mode routes. Mirrors
/// [`worker_request_error_to_response`] in shape.
fn delivery_route_error_to_response(
    err: &DeliveryRouteError,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    match err {
        DeliveryRouteError::WorkerNotFound(_) => api_error(
            axum::http::StatusCode::NOT_FOUND,
            "agent_not_found",
            err.to_string(),
        ),
    }
}

/// Map a [`RequestWorkerError`] to an HTTP response. Centralised so every
/// route built on `WorkerRequest` produces consistent status codes.
fn worker_request_error_to_response(
    err: &RequestWorkerError,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    use axum::http::StatusCode;
    match err {
        RequestWorkerError::WorkerNotFound(_) => {
            api_error(StatusCode::NOT_FOUND, "agent_not_found", err.to_string())
        }
        RequestWorkerError::UnsupportedRuntime(_) => {
            api_error(StatusCode::CONFLICT, "unsupported_runtime", err.to_string())
        }
        RequestWorkerError::Timeout => api_error(
            StatusCode::GATEWAY_TIMEOUT,
            "worker_timeout",
            err.to_string(),
        ),
        RequestWorkerError::WorkerError { code, message } => {
            // Reuse classify_error so worker-side codes ("invalid_format",
            // "agent_not_found", …) keep producing their canonical HTTP
            // status. Any unknown code falls back to 400.
            let composed = format!("{code}: {message}");
            let (status, mapped_code) = classify_error(&composed);
            let mapped_code = mapped_code.to_string();
            api_error(status, &mapped_code, composed)
        }
        RequestWorkerError::SendFailed(_) => {
            api_error(StatusCode::NOT_FOUND, "agent_not_found", err.to_string())
        }
        RequestWorkerError::WorkerDisappeared(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "worker_disappeared",
            err.to_string(),
        ),
        RequestWorkerError::ChannelClosed => internal_error(),
    }
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct MetricsQuery {
    agent: Option<String>,
}

async fn listen_api_metrics(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Query(query): axum::extract::Query<MetricsQuery>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::GetMetrics {
            agent: query.agent,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => api_error(axum::http::StatusCode::NOT_FOUND, "agent_not_found", err),
        Err(_) => internal_error(),
    }
}

async fn listen_api_status(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::GetStatus { reply: reply_tx })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => api_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "status_error",
            err,
        ),
        Err(_) => internal_error(),
    }
}

async fn listen_api_crash_insights(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::GetCrashInsights { reply: reply_tx })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Err(_) => internal_error(),
        Ok(Err(err)) => api_error(axum::http::StatusCode::INTERNAL_SERVER_ERROR, "error", err),
    }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PreflightBody {
    agents: Vec<PreflightEntry>,
}

async fn listen_api_preflight(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::Json(body): axum::Json<PreflightBody>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Preflight {
            agents: body.agents,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => api_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "preflight_error",
            err,
        ),
        Err(_) => internal_error(),
    }
}

async fn listen_api_renew_lease(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::RenewLease { reply: reply_tx })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => api_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "lease_error",
            err,
        ),
        Err(_) => internal_error(),
    }
}

async fn listen_api_shutdown(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Shutdown { reply: reply_tx })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => api_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "shutdown_error",
            err,
        ),
        Err(_) => internal_error(),
    }
}

// ---------------------------------------------------------------------------
// Channel subscription
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChannelSubBody {
    channels: Vec<String>,
}

async fn listen_api_subscribe_channels(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    axum::Json(body): axum::Json<ChannelSubBody>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::SubscribeChannels {
            name: name.clone(),
            channels: body.channels,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => api_error(axum::http::StatusCode::NOT_FOUND, "agent_not_found", err),
        Err(_) => internal_error(),
    }
}

async fn listen_api_unsubscribe_channels(
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    axum::Json(body): axum::Json<ChannelSubBody>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::UnsubscribeChannels {
            name: name.clone(),
            channels: body.channels,
            reply: reply_tx,
        })
        .await
        .is_err()
    {
        return internal_error();
    }
    match reply_rx.await {
        Ok(Ok(val)) => (axum::http::StatusCode::OK, axum::Json(val)),
        Ok(Err(err)) => api_error(axum::http::StatusCode::NOT_FOUND, "agent_not_found", err),
        Err(_) => internal_error(),
    }
}

async fn listen_api_ws(
    ws: axum::extract::WebSocketUpgrade,
    axum::extract::State(state): axum::extract::State<ListenApiState>,
    axum::extract::Query(query): axum::extract::Query<ListenReplayQuery>,
) -> impl axum::response::IntoResponse {
    let since_seq = query.since_seq();
    let replay_buffer = state.replay_buffer.clone();
    ws.on_upgrade(move |socket| {
        handle_dashboard_ws(
            socket,
            state.events_tx.subscribe(),
            replay_buffer,
            since_seq,
        )
    })
}

async fn handle_dashboard_ws(
    mut socket: axum::extract::ws::WebSocket,
    mut rx: broadcast::Receiver<String>,
    replay_buffer: ReplayBuffer,
    since_seq: u64,
) {
    tracing::info!("dashboard WS client connected");
    let replay_cutoff_seq = replay_buffer.current_seq();
    let (replay_events, gap_oldest) = replay_buffer.replay_since(since_seq).await;
    if let Some(oldest_available) = gap_oldest {
        let replay_gap = json!({
            "kind": "replay_gap",
            "requestedSinceSeq": since_seq,
            "oldestAvailable": oldest_available,
            "seq": replay_cutoff_seq,
        });
        if let Ok(msg) = serde_json::to_string(&replay_gap) {
            let _ = socket
                .send(axum::extract::ws::Message::Text(msg.into()))
                .await;
        }
    }
    for replayed in replay_events {
        if replayed.seq > replay_cutoff_seq {
            continue;
        }
        if let Ok(msg) = serde_json::to_string(&replayed.event) {
            if socket
                .send(axum::extract::ws::Message::Text(msg.into()))
                .await
                .is_err()
            {
                return;
            }
        }
    }
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(msg) => {
                        let is_duplicate = serde_json::from_str::<Value>(&msg)
                            .ok()
                            .and_then(|value| value.get("seq").and_then(Value::as_u64))
                            .is_some_and(|seq| seq <= replay_cutoff_seq);
                        if is_duplicate {
                            continue;
                        }
                        if socket
                            .send(axum::extract::ws::Message::Text(msg.into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(skipped = n, "dashboard WS client lagged, skipped messages");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = ping_interval.tick() => {
                if socket
                    .send(axum::extract::ws::Message::Ping(vec![].into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    tracing::info!("dashboard WS client disconnected");
}

// ---------------------------------------------------------------------------
// Dashboard event broadcasting
// ---------------------------------------------------------------------------

/// Broadcast an event payload to all connected WS clients. Every event kind
/// is forwarded so SDK consumers receive the same stream they would over the
/// stdio protocol.
///
/// Events are classified as:
/// - **Ephemeral**: high-frequency, not stored in replay buffer (`worker_stream`,
///   `delivery_active`). Clients that reconnect will not see missed ephemeral events.
/// - **Durable**: stored in the replay buffer with a sequence number so clients can
///   replay missed events on reconnect via `sinceSeq`.
pub async fn broadcast_if_relevant(
    events_tx: &broadcast::Sender<String>,
    replay_buffer: &ReplayBuffer,
    payload: &Value,
) {
    let Some(kind) = payload.get("kind").and_then(Value::as_str) else {
        return;
    };

    // High-frequency ephemeral events: broadcast without replay buffer storage
    let is_ephemeral = matches!(kind, "worker_stream" | "delivery_active");

    if is_ephemeral {
        if let Ok(json) = serde_json::to_string(payload) {
            let _ = events_tx.send(json);
        }
    } else {
        // Durable events: store in replay buffer (with seq number) and broadcast
        match replay_buffer.push(payload.clone()).await {
            Ok((_seq, event_with_seq)) => {
                if let Ok(json) = serde_json::to_string(&event_with_seq) {
                    let _ = events_tx.send(json);
                }
            }
            Err(error) => {
                tracing::warn!(kind = kind, error = %error, "failed to push event to replay buffer");
            }
        }
    }
}

#[cfg(test)]
mod wave0_contract_tests {
    use relay_broker::replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY};
    use serde_json::{json, Value};
    use tokio::sync::broadcast;

    use super::broadcast_if_relevant;

    fn required_broadcast_kinds() -> Vec<String> {
        let fixture =
            include_str!("../tests/fixtures/contracts/wave0/dashboard-broadcast-whitelist.json");
        let parsed: Value = serde_json::from_str(fixture)
            .expect("dashboard whitelist fixture should be valid JSON");
        parsed
            .get("required_kinds")
            .and_then(Value::as_array)
            .expect("dashboard whitelist fixture must include required_kinds array")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    }

    #[tokio::test]
    async fn broadcast_whitelist_contract_emits_all_required_event_kinds() {
        let (events_tx, mut events_rx) = broadcast::channel::<String>(16);
        let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);
        let required_kinds = required_broadcast_kinds();

        for kind in required_kinds {
            broadcast_if_relevant(
                &events_tx,
                &replay_buffer,
                &json!({
                    "kind": kind,
                    "name": "Wave0",
                    "event_id": "evt_wave0_contract"
                }),
            )
            .await;

            // TODO(contract-wave0-broadcast-whitelist): keep this fixture in sync with
            // dashboard-required events and make sure every listed kind is broadcast.
            assert!(
                events_rx.try_recv().is_ok(),
                "expected `{}` to be broadcast to dashboard listeners",
                kind
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::broadcast_if_relevant;
    use relay_broker::replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY};
    use serde_json::{json, Value};
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn broadcast_if_relevant_sends_relay_inbound() {
        let (tx, mut rx) = broadcast::channel::<String>(8);
        let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);
        let payload = json!({
            "kind": "relay_inbound",
            "to": "Lead",
            "from": "Worker",
            "text": "status",
        });

        broadcast_if_relevant(&tx, &replay_buffer, &payload).await;

        let delivered = rx
            .try_recv()
            .expect("relay_inbound should be broadcast to dashboard listeners");
        let decoded: Value =
            serde_json::from_str(&delivered).expect("broadcast payload should be valid JSON");
        assert_eq!(decoded["kind"], payload["kind"]);
        assert!(decoded.get("seq").and_then(Value::as_u64).is_some());
    }

    #[tokio::test]
    async fn broadcast_if_relevant_sends_agent_spawned() {
        let (tx, mut rx) = broadcast::channel::<String>(8);
        let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);
        let payload = json!({
            "kind": "agent_spawned",
            "name": "Worker",
        });

        broadcast_if_relevant(&tx, &replay_buffer, &payload).await;

        let delivered = rx
            .try_recv()
            .expect("agent_spawned should be broadcast to dashboard listeners");
        let decoded: Value =
            serde_json::from_str(&delivered).expect("broadcast payload should be valid JSON");
        assert_eq!(decoded["kind"], payload["kind"]);
        assert!(decoded.get("seq").and_then(Value::as_u64).is_some());
    }

    #[tokio::test]
    async fn broadcast_if_relevant_broadcasts_all_kinds() {
        let (tx, mut rx) = broadcast::channel::<String>(8);
        let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);
        let payload = json!({
            "kind": "totally_unknown_kind",
            "name": "Worker",
        });

        broadcast_if_relevant(&tx, &replay_buffer, &payload).await;

        // All event kinds are now broadcast (full-fidelity for SDK consumers)
        let delivered = rx.try_recv().expect("all event kinds should be broadcast");
        let decoded: Value =
            serde_json::from_str(&delivered).expect("broadcast payload should be valid JSON");
        assert_eq!(decoded["kind"], "totally_unknown_kind");
        // Non-ephemeral events get a seq number from the replay buffer
        assert!(decoded.get("seq").and_then(Value::as_u64).is_some());
    }

    #[tokio::test]
    async fn broadcast_if_relevant_ignores_missing_kind() {
        let (tx, mut rx) = broadcast::channel::<String>(8);
        let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);
        let payload = json!({
            "name": "Worker",
            "status": "online",
        });

        broadcast_if_relevant(&tx, &replay_buffer, &payload).await;

        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }
}

#[cfg(test)]
mod auth_tests {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use relay_broker::replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY};
    use serde_json::{json, Value};
    use tokio::sync::{broadcast, mpsc};
    use tower::ServiceExt;

    use super::{
        listen_api_router_with_auth, DeliveryRouteError, ListenApiConfig, ListenApiRequest,
        SetInboundDeliveryModeOk,
    };
    use crate::worker_request::RequestWorkerError;
    use relay_broker::protocol::MessageInjectionMode;
    use relay_broker::types::{InboundDeliveryMode, PendingRelayMessage};

    fn test_router(
        broker_api_key: Option<&str>,
    ) -> (axum::Router, mpsc::Receiver<ListenApiRequest>) {
        let (tx, rx) = mpsc::channel(8);
        let (events_tx, _events_rx) = broadcast::channel(8);
        let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);
        (
            listen_api_router_with_auth(
                ListenApiConfig {
                    tx,
                    events_tx,
                    replay_buffer,
                    workspace_key: None,
                    memberships: vec![],
                    default_workspace_id: None,
                    persist: false,
                },
                broker_api_key.map(ToString::to_string),
            ),
            rx,
        )
    }

    async fn response_json(response: axum::response::Response) -> Value {
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body should be readable");
        serde_json::from_slice(&body).expect("response body should be json")
    }

    #[tokio::test]
    async fn health_route_is_public_even_when_auth_enabled() {
        let (router, _rx) = test_router(Some("secret"));
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .method("GET")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn api_route_rejects_missing_api_key_when_auth_enabled() {
        let (router, _rx) = test_router(Some("secret"));
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned")
                    .method("GET")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = response_json(response).await;
        assert_eq!(
            body,
            json!({
                "error": {
                    "code": "unauthorized",
                    "message": "Missing or invalid API key",
                    "retryable": false,
                    "statusCode": 401,
                }
            })
        );
    }

    #[tokio::test]
    async fn api_route_accepts_valid_api_key() {
        let (router, mut rx) = test_router(Some("secret"));
        let list_replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::List { reply }) = rx.recv().await {
                let _ = reply.send(Ok(json!({ "agents": [{ "name": "worker-a" }] })));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["agents"][0]["name"], "worker-a");

        list_replier.await.expect("list replier should complete");
    }

    #[tokio::test]
    async fn spawn_route_forwards_extended_fields() {
        let (router, mut rx) = test_router(Some("secret"));
        let spawn_replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::Spawn {
                    name,
                    cli,
                    transport,
                    model,
                    args,
                    task,
                    channels,
                    cwd,
                    team,
                    shadow_of,
                    shadow_mode,
                    continue_from,
                    idle_threshold_secs: _,
                    skip_relay_prompt: _,
                    restart_policy: _,
                    agent_token: _,
                    reply,
                }) => {
                    assert_eq!(name, "worker-a");
                    assert_eq!(cli, "codex");
                    assert_eq!(transport.as_deref(), Some("headless"));
                    assert_eq!(model.as_deref(), Some("o3"));
                    assert_eq!(args, vec!["--fast".to_string()]);
                    assert_eq!(task.as_deref(), Some("Ship it"));
                    assert_eq!(
                        channels,
                        vec!["general".to_string(), "engineering".to_string()]
                    );
                    assert_eq!(cwd.as_deref(), Some("/tmp/project"));
                    assert_eq!(team.as_deref(), Some("core"));
                    assert_eq!(shadow_of.as_deref(), Some("Lead"));
                    assert_eq!(shadow_mode.as_deref(), Some("subagent"));
                    assert_eq!(continue_from.as_deref(), Some("worker-prev"));
                    let _ = reply.send(Ok(
                        json!({ "success": true, "name": "worker-a", "pid": 42 }),
                    ));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawn")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "name": "worker-a",
                            "cli": "codex",
                            "transport": "headless",
                            "model": "o3",
                            "args": ["--fast"],
                            "task": "Ship it",
                            "channels": ["general", "engineering"],
                            "cwd": "/tmp/project",
                            "team": "core",
                            "shadowOf": "Lead",
                            "shadowMode": "subagent",
                            "continueFrom": "worker-prev",
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["success"], json!(true));

        spawn_replier.await.expect("spawn replier should complete");
    }

    #[tokio::test]
    async fn set_model_route_forwards_request() {
        let (router, mut rx) = test_router(Some("secret"));
        let set_model_replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::SetModel {
                    name,
                    model,
                    timeout_ms,
                    reply,
                }) => {
                    assert_eq!(name, "worker-a");
                    assert_eq!(model, "sonnet");
                    assert_eq!(timeout_ms, Some(4500));
                    let _ = reply.send(Ok(json!({
                        "success": true,
                        "name": "worker-a",
                        "model": "sonnet",
                    })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/model")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "model": "sonnet",
                            "timeoutMs": 4500,
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["success"], json!(true));
        assert_eq!(body["model"], json!("sonnet"));

        set_model_replier
            .await
            .expect("set model replier should complete");
    }

    #[tokio::test]
    async fn send_route_defaults_mode_to_wait() {
        let (router, mut rx) = test_router(Some("secret"));
        let send_replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::Send { mode, reply, .. }) => {
                    assert!(matches!(
                        mode,
                        relay_broker::protocol::MessageInjectionMode::Wait
                    ));
                    let _ = reply.send(Ok(json!({ "success": true, "event_id": "evt_1" })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/send")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "to": "worker-a", "text": "hi" }).to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        send_replier.await.expect("send replier should complete");
    }

    #[tokio::test]
    async fn send_route_forwards_steer_mode() {
        let (router, mut rx) = test_router(Some("secret"));
        let send_replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::Send { mode, reply, .. }) => {
                    assert!(matches!(
                        mode,
                        relay_broker::protocol::MessageInjectionMode::Steer
                    ));
                    let _ = reply.send(Ok(json!({ "success": true, "event_id": "evt_2" })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/send")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "to": "worker-a", "text": "interrupt", "mode": "steer" })
                            .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        send_replier.await.expect("send replier should complete");
    }

    #[tokio::test]
    async fn send_route_rejects_invalid_mode() {
        let (router, mut rx) = test_router(Some("secret"));

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/send")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({ "to": "worker-a", "text": "interrupt", "mode": "steeer" })
                            .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            rx.try_recv().is_err(),
            "invalid mode should not enqueue request"
        );
    }

    #[tokio::test]
    async fn ws_route_rejects_missing_api_key_when_auth_enabled() {
        let (router, _rx) = test_router(Some("secret"));
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/ws")
                    .method("GET")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn api_route_accepts_bearer_token() {
        let (router, mut rx) = test_router(Some("secret"));
        let list_replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::List { reply }) = rx.recv().await {
                let _ = reply.send(Ok(json!({ "agents": [] })));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned")
                    .method("GET")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);

        list_replier.await.expect("list replier should complete");
    }

    #[tokio::test]
    async fn api_route_rejects_invalid_bearer_token() {
        let (router, _rx) = test_router(Some("secret"));
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned")
                    .method("GET")
                    .header("authorization", "Bearer wrong-key")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn ws_route_allows_request_when_auth_disabled() {
        let (router, _rx) = test_router(None);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/ws")
                    .method("GET")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // ----- New endpoint tests (session, lease, status, metrics, crash-insights, preflight, shutdown, input, resize) -----

    #[tokio::test]
    async fn session_route_returns_broker_info() {
        let (router, _rx) = test_router(Some("secret"));
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert!(body["broker_version"].is_string());
        assert_eq!(body["protocol_version"], 1);
        assert_eq!(body["mode"], "ephemeral");
    }

    #[tokio::test]
    async fn renew_lease_route_forwards_request() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::RenewLease { reply }) => {
                    let _ = reply.send(Ok(json!({ "renewed": true })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/session/renew")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["renewed"], json!(true));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn status_route_forwards_request() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::GetStatus { reply }) => {
                    let _ = reply.send(Ok(json!({ "agent_count": 3 })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/status")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["agent_count"], 3);
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn metrics_route_forwards_agent_query() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::GetMetrics { agent, reply }) => {
                    assert_eq!(agent.as_deref(), Some("worker-a"));
                    let _ = reply.send(Ok(json!({ "lines_written": 42 })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/metrics?agent=worker-a")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["lines_written"], 42);
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn crash_insights_route_forwards_request() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::GetCrashInsights { reply }) => {
                    let _ = reply.send(Ok(json!({ "crashes": [] })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/crash-insights")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["crashes"], json!([]));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn preflight_route_forwards_agents() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::Preflight { agents, reply }) => {
                    assert_eq!(agents.len(), 1);
                    let _ = reply.send(Ok(json!({ "ok": true })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/preflight")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "agents": [{ "name": "worker-a", "cli": "claude" }]
                        })
                        .to_string(),
                    ))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["ok"], json!(true));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn shutdown_route_forwards_request() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::Shutdown { reply }) => {
                    let _ = reply.send(Ok(json!({ "shutting_down": true })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/shutdown")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["shutting_down"], json!(true));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn resize_pty_route_forwards_dimensions() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::ResizePty {
                    name,
                    rows,
                    cols,
                    reply,
                }) => {
                    assert_eq!(name, "worker-a");
                    assert_eq!(rows, 40);
                    assert_eq!(cols, 120);
                    let _ = reply.send(Ok(json!({ "resized": true })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/resize/worker-a")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "rows": 40, "cols": 120 }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["resized"], json!(true));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn input_route_forwards_data() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::SendInput { name, data, reply }) => {
                    assert_eq!(name, "worker-a");
                    assert_eq!(data, "hello\n");
                    let _ = reply.send(Ok(json!({ "sent": true })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/input/worker-a")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "data": "hello\n" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["sent"], json!(true));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn interrupt_route_returns_501_when_auth_valid() {
        let (router, _rx) = test_router(Some("secret"));
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/agents/by-name/worker%20a/interrupt")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
        let body = response_json(response).await;
        assert_eq!(
            body,
            json!({
                "success": false,
                "error": "Agent interrupt is not yet supported by the broker HTTP API.",
                "name": "worker a",
            })
        );
    }

    #[tokio::test]
    async fn snapshot_route_defaults_to_plain_and_forwards_format() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::WorkerRequest {
                    name,
                    kind,
                    payload,
                    reply,
                    ..
                }) => {
                    assert_eq!(name, "worker-a");
                    assert_eq!(kind, "snapshot_pty");
                    assert_eq!(payload["format"], json!("plain"));
                    let _ = reply.send(Ok(json!({
                        "format": "plain",
                        "rows": 4,
                        "cols": 20,
                        "cursor": [1, 1],
                        "screen": "hello\n\n\n\n",
                    })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/snapshot")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["format"], json!("plain"));
        assert_eq!(body["rows"], json!(4));
        assert_eq!(body["screen"], json!("hello\n\n\n\n"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn snapshot_route_passes_ansi_format_through() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::WorkerRequest {
                    name,
                    kind,
                    payload,
                    reply,
                    ..
                }) => {
                    assert_eq!(name, "worker-a");
                    assert_eq!(kind, "snapshot_pty");
                    assert_eq!(payload["format"], json!("ansi"));
                    let _ = reply.send(Ok(json!({
                        "format": "ansi",
                        "rows": 2,
                        "cols": 5,
                        "cursor": [1, 3],
                        "screen": "AAAA",
                    })));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/snapshot?format=ansi")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["format"], json!("ansi"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn snapshot_route_rejects_unknown_format_without_calling_broker() {
        let (router, mut rx) = test_router(Some("secret"));

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/snapshot?format=html")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("invalid_format"));

        // The broker channel must not have received a WorkerRequest.
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn snapshot_route_propagates_agent_not_found_as_404() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::WorkerRequest { reply, .. }) = rx.recv().await {
                let _ = reply.send(Err(RequestWorkerError::WorkerNotFound(
                    "no worker named 'ghost'".to_string(),
                )));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/ghost/snapshot")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("agent_not_found"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn snapshot_route_maps_unsupported_runtime_to_409() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::WorkerRequest { reply, .. }) = rx.recv().await {
                let _ = reply.send(Err(RequestWorkerError::UnsupportedRuntime(
                    "worker 'h' is headless; snapshot_pty is only supported on PTY workers"
                        .to_string(),
                )));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/h/snapshot")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("unsupported_runtime"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn snapshot_route_maps_worker_timeout_to_504() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::WorkerRequest { reply, .. }) = rx.recv().await {
                let _ = reply.send(Err(RequestWorkerError::Timeout));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/slow/snapshot")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("worker_timeout"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn snapshot_route_propagates_worker_error_envelope() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::WorkerRequest { reply, .. }) = rx.recv().await {
                let _ = reply.send(Err(RequestWorkerError::WorkerError {
                    code: "invalid_format".to_string(),
                    message: "unsupported format 'qoi'".to_string(),
                }));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/snapshot")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        // classify_error maps "invalid_*" prefixes to 400 / "invalid_request".
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("invalid_request"));
        replier.await.expect("replier should complete");
    }

    // -----------------------------------------------------------------
    // Inbound delivery mode: four routes that back the `agent-relay drive`
    // client. The HTTP layer only forwards typed requests over the
    // broker channel — these tests cover the request shaping and
    // response mapping, not the broker arms (those live in main.rs and
    // are exercised by the broker integration tests).
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn get_inbound_delivery_mode_route_returns_mode_string() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::GetInboundDeliveryMode { name, reply }) => {
                    assert_eq!(name, "worker-a");
                    let _ = reply.send(Ok(InboundDeliveryMode::ManualFlush));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/delivery-mode")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body, json!({ "mode": "manual_flush" }));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn get_inbound_delivery_mode_route_returns_404_when_worker_missing() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::GetInboundDeliveryMode { reply, .. }) = rx.recv().await {
                let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound("ghost".into())));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/ghost/delivery-mode")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("agent_not_found"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn set_inbound_delivery_mode_route_forwards_parsed_mode_and_returns_flushed() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::SetInboundDeliveryMode { name, mode, reply }) => {
                    assert_eq!(name, "worker-a");
                    assert_eq!(mode, InboundDeliveryMode::AutoInject);
                    let _ = reply.send(Ok(SetInboundDeliveryModeOk {
                        mode: InboundDeliveryMode::AutoInject,
                        flushed: 3,
                    }));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/delivery-mode")
                    .method("PUT")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "mode": "auto_inject" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body, json!({ "mode": "auto_inject", "flushed": 3 }));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn set_inbound_delivery_mode_route_rejects_invalid_mode_without_calling_broker() {
        let (router, mut rx) = test_router(Some("secret"));

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/delivery-mode")
                    .method("PUT")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "mode": "drive" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("invalid_mode"));
        assert!(
            rx.try_recv().is_err(),
            "invalid mode should not enqueue request"
        );
    }

    #[tokio::test]
    async fn legacy_mode_route_is_not_registered() {
        let (router, mut rx) = test_router(Some("secret"));

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/mode")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(
            rx.try_recv().is_err(),
            "legacy /mode route should not enqueue request"
        );
    }

    #[tokio::test]
    async fn set_inbound_delivery_mode_route_returns_404_when_worker_missing() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::SetInboundDeliveryMode { reply, .. }) = rx.recv().await {
                let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound("ghost".into())));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/ghost/delivery-mode")
                    .method("PUT")
                    .header("x-api-key", "secret")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "mode": "manual_flush" }).to_string()))
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("agent_not_found"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn get_pending_route_returns_fifo_list_with_event_id() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::GetPending { name, reply }) => {
                    assert_eq!(name, "worker-a");
                    let _ = reply.send(Ok(vec![
                        PendingRelayMessage {
                            from: "Alice".to_string(),
                            body: "one".to_string(),
                            target: "#general".to_string(),
                            thread_id: Some("thr_42".to_string()),
                            workspace_id: Some("ws_demo".to_string()),
                            workspace_alias: Some("Demo".to_string()),
                            priority: 1,
                            mode: MessageInjectionMode::Steer,
                            queued_at_ms: 100,
                            event_id: Some("evt_1".to_string()),
                        },
                        PendingRelayMessage {
                            from: "Bob".to_string(),
                            body: "two".to_string(),
                            target: "worker-a".to_string(),
                            thread_id: None,
                            workspace_id: None,
                            workspace_alias: None,
                            priority: 2,
                            mode: MessageInjectionMode::Wait,
                            queued_at_ms: 200,
                            event_id: None,
                        },
                    ]));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/pending")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["pending"].as_array().expect("array").len(), 2);
        // First entry: channel-targeted, threaded, full workspace
        // context, custom priority + mode — all surface in the JSON
        // and round-trip via the snapshot serializer.
        assert_eq!(body["pending"][0]["from"], json!("Alice"));
        assert_eq!(body["pending"][0]["body"], json!("one"));
        assert_eq!(body["pending"][0]["target"], json!("#general"));
        assert_eq!(body["pending"][0]["thread_id"], json!("thr_42"));
        assert_eq!(body["pending"][0]["workspace_id"], json!("ws_demo"));
        assert_eq!(body["pending"][0]["workspace_alias"], json!("Demo"));
        assert_eq!(body["pending"][0]["priority"], json!(1));
        assert_eq!(body["pending"][0]["mode"], json!("steer"));
        assert_eq!(body["pending"][0]["queued_at_ms"], json!(100));
        assert_eq!(body["pending"][0]["event_id"], json!("evt_1"));
        // Second entry: minimal context — optional fields stay absent
        // from the JSON, defaults surface as concrete numbers/strings.
        assert_eq!(body["pending"][1]["from"], json!("Bob"));
        assert_eq!(body["pending"][1]["target"], json!("worker-a"));
        assert_eq!(body["pending"][1]["priority"], json!(2));
        assert_eq!(body["pending"][1]["mode"], json!("wait"));
        assert_eq!(body["pending"][1].get("thread_id"), None);
        assert_eq!(body["pending"][1].get("workspace_id"), None);
        assert_eq!(body["pending"][1].get("workspace_alias"), None);
        assert_eq!(body["pending"][1].get("event_id"), None);
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn get_pending_route_returns_404_when_worker_missing() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::GetPending { reply, .. }) = rx.recv().await {
                let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound("ghost".into())));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/ghost/pending")
                    .method("GET")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("agent_not_found"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn flush_route_returns_flushed_count() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            match rx.recv().await {
                Some(ListenApiRequest::FlushPending { name, reply }) => {
                    assert_eq!(name, "worker-a");
                    let _ = reply.send(Ok(5));
                }
                other => panic!("unexpected request: {:?}", other.map(|_| "other")),
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/worker-a/flush")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body, json!({ "flushed": 5 }));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn flush_route_returns_404_when_worker_missing() {
        let (router, mut rx) = test_router(Some("secret"));
        let replier = tokio::spawn(async move {
            if let Some(ListenApiRequest::FlushPending { reply, .. }) = rx.recv().await {
                let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound("ghost".into())));
            }
        });

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/spawned/ghost/flush")
                    .method("POST")
                    .header("x-api-key", "secret")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("request should succeed");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = response_json(response).await;
        assert_eq!(body["code"], json!("agent_not_found"));
        replier.await.expect("replier should complete");
    }

    #[tokio::test]
    async fn inbound_delivery_routes_require_auth() {
        let (router, _rx) = test_router(Some("secret"));
        for (method, path) in [
            ("GET", "/api/spawned/worker-a/delivery-mode"),
            ("PUT", "/api/spawned/worker-a/delivery-mode"),
            ("GET", "/api/spawned/worker-a/pending"),
            ("POST", "/api/spawned/worker-a/flush"),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .method(method)
                        .header("content-type", "application/json")
                        .body(Body::from(json!({ "mode": "auto_inject" }).to_string()))
                        .expect("request should build"),
                )
                .await
                .expect("request should succeed");
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {path} should require auth"
            );
        }
    }
}
