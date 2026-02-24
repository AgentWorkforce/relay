//! HTTP API types and handlers for the broker's `--api-port` mode.
//!
//! This module contains the axum router, request types, and endpoint handlers
//! that power the dashboard's REST API for spawning/releasing agents and
//! sending messages.

use std::time::Duration;

use relay_broker::replay_buffer::ReplayBuffer;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

// ---------------------------------------------------------------------------
// Request / State types
// ---------------------------------------------------------------------------

pub enum ListenApiRequest {
    Spawn {
        name: String,
        cli: String,
        model: Option<String>,
        args: Vec<String>,
        task: Option<String>,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Release {
        name: String,
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
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
}

#[derive(Clone)]
struct ListenApiState {
    tx: mpsc::Sender<ListenApiRequest>,
    events_tx: broadcast::Sender<String>,
    broker_api_key: Option<String>,
    replay_buffer: ReplayBuffer,
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

pub fn listen_api_router(
    tx: mpsc::Sender<ListenApiRequest>,
    events_tx: broadcast::Sender<String>,
    replay_buffer: ReplayBuffer,
) -> axum::Router {
    listen_api_router_with_auth(tx, events_tx, configured_broker_api_key(), replay_buffer)
}

fn configured_broker_api_key() -> Option<String> {
    std::env::var("RELAY_BROKER_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn listen_api_router_with_auth(
    tx: mpsc::Sender<ListenApiRequest>,
    events_tx: broadcast::Sender<String>,
    broker_api_key: Option<String>,
    replay_buffer: ReplayBuffer,
) -> axum::Router {
    use axum::{middleware, routing, Router};

    let state = ListenApiState {
        tx,
        events_tx,
        broker_api_key: broker_api_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        replay_buffer,
    };

    let protected = Router::new()
        .route("/api/spawn", routing::post(listen_api_spawn))
        .route("/api/spawned", routing::get(listen_api_list))
        .route("/api/threads", routing::get(listen_api_threads))
        .route("/api/events/replay", routing::get(listen_api_replay))
        .route("/api/spawned/{name}", routing::delete(listen_api_release))
        .route(
            "/api/agents/by-name/{name}/interrupt",
            routing::post(listen_api_interrupt),
        )
        .route("/api/send", routing::post(listen_api_send))
        .route("/ws", routing::get(listen_api_ws))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            listen_api_auth_middleware,
        ));

    Router::new()
        .route("/health", routing::get(listen_api_health))
        .merge(protected)
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

pub(crate) async fn listen_api_health() -> axum::Json<Value> {
    let startup_error_code = std::env::var("AGENT_RELAY_STARTUP_ERROR_CODE").ok();
    let status = startup_health_status(startup_error_code.as_deref());

    axum::Json(json!({
        "status": status,
        "service": "agent-relay-listen",
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeMs": 0,
        "workspaceId": std::env::var("RELAY_WORKSPACE_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .filter(|value| value.starts_with("ws_"))
            .unwrap_or_else(|| "ws_unknown".to_string()),
        "agentCount": 0,
        "pendingDeliveryCount": 0,
        "wsConnections": 0,
        "memoryMb": 0,
        "relaycastConnected": startup_error_code.is_none(),
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
            model,
            args,
            task,
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
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if state
        .tx
        .send(ListenApiRequest::Release {
            name: name.clone(),
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

    if to.is_empty() || text.is_empty() {
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
        Ok(Err(err)) => {
            let status = if err.contains("Agent \"") && err.contains("not found") {
                axum::http::StatusCode::NOT_FOUND
            } else {
                axum::http::StatusCode::BAD_GATEWAY
            };
            (
                status,
                axum::Json(json!({
                    "success": false,
                    "to": to,
                    "error": err,
                })),
            )
        }
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(json!({ "success": false, "error": "internal reply dropped" })),
        ),
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

/// Broadcast an event payload to dashboard WS clients if the event kind is
/// relevant for real-time UI updates. This is called alongside `send_event`
/// and does not affect the SDK stdout protocol.
pub async fn broadcast_if_relevant(
    events_tx: &broadcast::Sender<String>,
    replay_buffer: &ReplayBuffer,
    payload: &Value,
) {
    if let Some(kind) = payload.get("kind").and_then(Value::as_str) {
        match kind {
            // High-frequency ephemeral events: broadcast without replay buffer storage
            "worker_stream" | "delivery_active" => {
                if let Ok(json) = serde_json::to_string(payload) {
                    let _ = events_tx.send(json);
                }
            }
            // Durable events: store in replay buffer and broadcast
            "relay_inbound"
            | "agent_spawned"
            | "agent_exited"
            | "agent_released"
            | "worker_ready"
            | "agent_idle"
            | "agent_restarting"
            | "agent_restarted"
            | "agent_permanently_dead"
            | "delivery_ack"
            | "delivery_verified"
            | "delivery_failed"
            | "worker_error" => match replay_buffer.push(payload.clone()).await {
                Ok((_seq, event_with_seq)) => {
                    if let Ok(json) = serde_json::to_string(&event_with_seq) {
                        match events_tx.send(json) {
                            Ok(receivers) => {
                                tracing::debug!(
                                    kind = kind,
                                    receivers = receivers,
                                    "broadcast event to dashboard WS clients"
                                );
                            }
                            Err(_) => {
                                tracing::warn!(
                                    kind = kind,
                                    "broadcast event dropped — no dashboard WS clients connected"
                                );
                            }
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(kind = kind, error = %error, "failed to push event to replay buffer");
                }
            },
            _ => {}
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
    async fn broadcast_if_relevant_ignores_unknown_kind() {
        let (tx, mut rx) = broadcast::channel::<String>(8);
        let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);
        let payload = json!({
            "kind": "totally_unknown_kind",
            "name": "Worker",
        });

        broadcast_if_relevant(&tx, &replay_buffer, &payload).await;

        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
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

    use super::{listen_api_router_with_auth, ListenApiRequest};

    fn test_router(
        broker_api_key: Option<&str>,
    ) -> (axum::Router, mpsc::Receiver<ListenApiRequest>) {
        let (tx, rx) = mpsc::channel(8);
        let (events_tx, _events_rx) = broadcast::channel(8);
        let replay_buffer = ReplayBuffer::new(DEFAULT_REPLAY_CAPACITY);
        (
            listen_api_router_with_auth(
                tx,
                events_tx,
                broker_api_key.map(ToString::to_string),
                replay_buffer,
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
}
