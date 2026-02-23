//! HTTP API types and handlers for the broker's `--api-port` mode.
//!
//! This module contains the axum router, request types, and endpoint handlers
//! that power the dashboard's REST API for spawning/releasing agents and
//! sending messages.

use std::time::Duration;

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
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn listen_api_router(
    tx: mpsc::Sender<ListenApiRequest>,
    events_tx: broadcast::Sender<String>,
) -> axum::Router {
    use axum::{routing, Router};

    let state = ListenApiState { tx, events_tx };

    Router::new()
        .route("/api/spawn", routing::post(listen_api_spawn))
        .route("/api/spawned", routing::get(listen_api_list))
        .route("/api/spawned/{name}", routing::delete(listen_api_release))
        .route("/api/send", routing::post(listen_api_send))
        .route("/health", routing::get(listen_api_health))
        .route("/ws", routing::get(listen_api_ws))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

async fn listen_api_health() -> axum::Json<Value> {
    axum::Json(json!({
        "status": "ok",
        "service": "agent-relay-listen",
    }))
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
) -> impl axum::response::IntoResponse {
    ws.on_upgrade(move |socket| handle_dashboard_ws(socket, state.events_tx.subscribe()))
}

async fn handle_dashboard_ws(
    mut socket: axum::extract::ws::WebSocket,
    mut rx: broadcast::Receiver<String>,
) {
    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            result = rx.recv() => {
                match result {
                    Ok(msg) => {
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
}

// ---------------------------------------------------------------------------
// Dashboard event broadcasting
// ---------------------------------------------------------------------------

/// Broadcast an event payload to dashboard WS clients if the event kind is
/// relevant for real-time UI updates. This is called alongside `send_event`
/// and does not affect the SDK stdout protocol.
pub fn broadcast_if_relevant(events_tx: &broadcast::Sender<String>, payload: &Value) {
    if let Some(kind) = payload.get("kind").and_then(Value::as_str) {
        match kind {
            "relay_inbound"
            | "agent_spawned"
            | "agent_exited"
            | "agent_released"
            | "worker_ready"
            | "agent_idle"
            | "agent_restarting"
            | "agent_restarted"
            | "agent_permanently_dead"
            | "delivery_verified"
            | "delivery_failed"
            | "worker_error" => {
                if let Ok(json) = serde_json::to_string(payload) {
                    let _ = events_tx.send(json);
                }
            }
            _ => {}
        }
    }
}
