use crate::{
    config::{random_secret, AgentCredential, Config, ConfigStore},
    relaycast_client::{self, DeliveryStatus, InboxMessage, SendReceipt},
};
use anyhow::{Context, Result};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    net::{Ipv4Addr, SocketAddrV4},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, Notify, RwLock};

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    store: ConfigStore,
    config: RwLock<Config>,
    pollers: Mutex<HashSet<String>>,
    inbox_write: Mutex<()>,
    shutdown: Notify,
}

impl AppState {
    pub fn new(store: ConfigStore, config: Config) -> Self {
        Self(Arc::new(Inner {
            store,
            config: RwLock::new(config),
            pollers: Mutex::new(HashSet::new()),
            inbox_write: Mutex::new(()),
            shutdown: Notify::new(),
        }))
    }

    pub async fn start_pollers(&self) {
        let config = self.0.config.read().await;
        if config.engine.is_some() {
            return;
        }
        let names = config.agents.keys().cloned().collect::<Vec<_>>();
        drop(config);
        for name in names {
            self.ensure_poller(name).await;
        }
    }

    async fn ensure_poller(&self, name: String) {
        if !self.0.pollers.lock().await.insert(name.clone()) {
            return;
        }
        let state = self.clone();
        tokio::spawn(async move {
            loop {
                let config = state.0.config.read().await.clone();
                if !config.agents.contains_key(&name) {
                    state.0.pollers.lock().await.remove(&name);
                    return;
                }
                if let Ok(messages) = relaycast_client::take_deliveries(&config, &name).await {
                    if !messages.is_empty() {
                        match state.append_inbox(&name, &messages).await {
                            Ok(()) => {
                                for message in messages {
                                    if let Err(error) = relaycast_client::ack_delivery(
                                        &config,
                                        &name,
                                        &message.delivery_id,
                                    )
                                    .await
                                    {
                                        eprintln!(
                                            "Could not acknowledge delivery {} for {name}: {error}",
                                            message.delivery_id
                                        );
                                    }
                                }
                            }
                            Err(error) => {
                                eprintln!(
                                    "Could not persist deliveries for {name}; leaving them pending: {error}"
                                );
                            }
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(350)) => {}
                    _ = state.0.shutdown.notified() => return,
                }
            }
        });
    }

    async fn update_agent(&self, name: String, credential: AgentCredential) -> Result<()> {
        let mut config = self.0.config.write().await;
        config.agents.insert(name.clone(), credential);
        self.0.store.write(&config)?;
        let local = config.engine.is_some();
        drop(config);
        if !local {
            self.ensure_poller(name).await;
        }
        Ok(())
    }

    async fn append_inbox(&self, name: &str, messages: &[InboxMessage]) -> Result<()> {
        let _guard = self.0.inbox_write.lock().await;
        let workspace_id = self.0.config.read().await.workspace_id.clone();
        let path = self.0.store.inbox_path(&workspace_id, name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            set_private_dir(parent)?;
        }
        let mut seen = read_inbox_path(&path)?
            .into_iter()
            .map(|message| message.delivery_id)
            .collect::<HashSet<_>>();
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        set_private_file(&path)?;
        for message in messages {
            if seen.contains(&message.delivery_id) {
                continue;
            }
            serde_json::to_writer(&mut file, message)?;
            file.write_all(b"\n")?;
            seen.insert(message.delivery_id.clone());
        }
        file.sync_all()?;
        Ok(())
    }

    async fn inbox(&self, name: &str) -> Result<Vec<InboxMessage>> {
        let _guard = self.0.inbox_write.lock().await;
        let workspace_id = self.0.config.read().await.workspace_id.clone();
        read_inbox_path(&self.0.store.inbox_path(&workspace_id, name))
    }
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/status", get(status))
        .route("/v1/agents", get(list_agents).post(register_agent))
        .route("/v1/agents/{name}/rotate", post(rotate_agent))
        .route("/v1/send", post(send))
        .route("/v1/inbox/{name}", get(inbox))
        .route("/v1/shutdown", post(shutdown))
        .with_state(state)
}

pub async fn serve(store: ConfigStore) -> Result<()> {
    let mut config = store.read()?;
    config.api.pid = Some(std::process::id());
    store.write(&config)?;
    let port = config.api.port;
    let state = AppState::new(store, config);
    state.start_pollers().await;
    let listener = tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
        .await
        .with_context(|| format!("Could not bind the Relay probe API on 127.0.0.1:{port}."))?;
    let shutdown_state = state.clone();
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = shutdown_state.0.shutdown.notified() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
        })
        .await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(json!({"ok": true, "service": "relay-probe", "version": env!("CARGO_PKG_VERSION")}))
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    let config = state.0.config.read().await;
    Ok(Json(json!({
        "ok": true,
        "origin": config.origin,
        "workspaceId": config.workspace_id,
        "workspaceName": config.workspace_name,
        "agents": config.agents.keys().collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
struct RegisterRequest {
    name: String,
}

async fn register_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RegisterRequest>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    let config = state.0.config.read().await.clone();
    relaycast_client::valid_name(&request.name)?;
    let credential = if config.engine.is_some() {
        AgentCredential {
            id: config
                .agents
                .get(request.name.trim())
                .map(|credential| credential.id.clone())
                .unwrap_or_else(|| random_secret("ra_")),
            token: random_secret("at_"),
        }
    } else {
        relaycast_client::register(&config, &request.name).await?
    };
    let name = request.name.trim().to_string();
    state.update_agent(name.clone(), credential.clone()).await?;
    Ok(Json(
        json!({"name": name, "id": credential.id, "stored": true}),
    ))
}

async fn rotate_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    let config = state.0.config.read().await.clone();
    relaycast_client::valid_name(&name)?;
    let credential = if config.engine.is_some() {
        let existing = config.agents.get(name.trim()).ok_or_else(|| {
            ApiError::bad_request(format!(
                "Agent `{}` is not stored on this machine.",
                name.trim()
            ))
        })?;
        AgentCredential {
            id: existing.id.clone(),
            token: random_secret("at_"),
        }
    } else {
        relaycast_client::rotate(&config, &name).await?
    };
    let name = name.trim().to_string();
    state.update_agent(name.clone(), credential.clone()).await?;
    Ok(Json(
        json!({"name": name, "id": credential.id, "rotated": true}),
    ))
}

async fn list_agents(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    let config = state.0.config.read().await;
    let agents = config
        .agents
        .iter()
        .map(|(name, credential)| json!({"name": name, "id": credential.id}))
        .collect::<Vec<_>>();
    Ok(Json(json!({"agents": agents})))
}

#[derive(Deserialize)]
struct SendRequest {
    from: String,
    to: String,
    text: String,
}

async fn send(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SendRequest>,
) -> Result<Json<SendReceipt>, ApiError> {
    authorize(&state, &headers).await?;
    let config = state.0.config.read().await.clone();
    let receipt = if config.engine.is_some() {
        local_send(&state, &config, &request).await?
    } else {
        relaycast_client::send(&config, &request.from, &request.to, &request.text).await?
    };
    Ok(Json(receipt))
}

async fn local_send(
    state: &AppState,
    config: &Config,
    request: &SendRequest,
) -> Result<SendReceipt, ApiError> {
    let from = relaycast_client::valid_name(&request.from)?;
    let to = relaycast_client::valid_name(&request.to)?;
    let text = request.text.trim();
    if text.is_empty() {
        return Err(ApiError::bad_request(
            "Message text cannot be empty.".into(),
        ));
    }
    if !config.agents.contains_key(from) {
        return Err(ApiError::bad_request(format!(
            "Agent `{from}` is not stored on this machine."
        )));
    }
    if !config.agents.contains_key(to) {
        return Err(ApiError::bad_request(format!(
            "Agent `{to}` does not exist."
        )));
    }
    let message_id = random_secret("msg_");
    let delivery_id = random_secret("del_");
    let conversation_id = local_conversation_id(&config.workspace_id, from, to);
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    state
        .append_inbox(
            to,
            &[InboxMessage {
                delivery_id,
                message_id: message_id.clone(),
                from: from.to_string(),
                text: text.to_string(),
                created_at,
            }],
        )
        .await?;
    Ok(SendReceipt {
        message_id,
        conversation_id,
        to: to.to_string(),
        status: DeliveryStatus::Delivered,
    })
}

fn local_conversation_id(workspace_id: &str, from: &str, to: &str) -> String {
    use sha2::{Digest, Sha256};

    let (first, second) = if from <= to { (from, to) } else { (to, from) };
    let mut digest = Sha256::new();
    for part in [workspace_id, first, second] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part.as_bytes());
    }
    format!("dm_{:x}", digest.finalize())
}

async fn inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    let config = state.0.config.read().await;
    if !config.agents.contains_key(name.trim()) {
        return Err(ApiError::bad_request(format!(
            "Agent `{}` is not stored on this machine.",
            name.trim()
        )));
    }
    drop(config);
    let messages = state.inbox(name.trim()).await?;
    Ok(Json(json!({"agent": name.trim(), "messages": messages})))
}

async fn shutdown(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    authorize(&state, &headers).await?;
    state.0.shutdown.notify_waiters();
    Ok(Json(json!({"ok": true})))
}

async fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let expected = state.0.config.read().await.api.token.clone();
    let supplied = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if supplied != Some(expected.as_str()) {
        return Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            message: "Invalid local Relay API token.".into(),
        });
    }
    Ok(())
}

fn read_inbox_path(path: &std::path::Path) -> Result<Vec<InboxMessage>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut messages = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        messages.push(serde_json::from_str(&line).context("Stored Relay inbox is unreadable.")?);
    }
    Ok(messages)
}

fn set_private_dir(path: &std::path::Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file(path: &std::path::Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: String) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }
}

impl<E> From<E> for ApiError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self::bad_request(error.into().to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"ok": false, "error": {"message": self.message}})),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, LocalEngine};
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    fn state() -> AppState {
        let root = tempfile::tempdir().unwrap().keep();
        let store = ConfigStore::new(root);
        let config = Config::new(
            "http://127.0.0.1:8787".into(),
            "rw_test".into(),
            "test".into(),
            "rk_live_test".into(),
            32123,
            None,
        );
        store.write(&config).unwrap();
        AppState::new(store, config)
    }

    fn local_state() -> AppState {
        let root = tempfile::tempdir().unwrap().keep();
        let store = ConfigStore::new(root.clone());
        let config = Config::new(
            "http://127.0.0.1:32123".into(),
            "rw_test".into(),
            "test".into(),
            "rk_live_test".into(),
            32123,
            Some(LocalEngine {
                port: 32123,
                pid: None,
                database: root.join("local-messages.jsonl"),
            }),
        );
        store.write(&config).unwrap();
        AppState::new(store, config)
    }

    #[tokio::test]
    async fn health_is_public_but_status_requires_the_local_token() {
        let state = state();
        let router = app(state.clone());
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn status_never_returns_workspace_or_agent_credentials() {
        let state = state();
        let token = state.0.config.read().await.api.token.clone();
        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(!text.contains("rk_live_test"));
        assert!(!text.contains(&token));
    }

    #[tokio::test]
    async fn embedded_engine_delivers_between_two_registered_agents() {
        let state = local_state();
        let token = state.0.config.read().await.api.token.clone();
        let router = app(state);
        for name in ["a", "b"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/v1/agents")
                        .header("authorization", format!("Bearer {token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(format!(r#"{{"name":"{name}"}}"#)))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/send")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"from":"a","to":"b","text":"hi"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let receipt: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(receipt["status"], "delivered");
        let conversation_id = receipt["conversation_id"].as_str().unwrap().to_string();

        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/send")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"from":"b","to":"a","text":"reply"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let reply: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(reply["conversation_id"], conversation_id);

        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/inbox/b")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let inbox: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(inbox["messages"][0]["from"], "a");
        assert_eq!(inbox["messages"][0]["text"], "hi");
    }
}
