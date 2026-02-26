use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use relaycast::{CreateAgentRequest, RelayCast, RelayCastOptions, RelayError};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialCache {
    pub workspace_id: String,
    pub agent_id: String,
    pub api_key: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub agent_token: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AuthSession {
    pub credentials: CredentialCache,
    pub token: String,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct AuthHttpError {
    status: StatusCode,
    message: String,
}

#[derive(Clone)]
pub struct AuthClient {
    base_url: String,
}

impl AuthClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
        }
    }

    pub async fn startup_session(&self, requested_name: Option<&str>) -> Result<AuthSession> {
        self.startup_session_with_options(requested_name, false, None)
            .await
    }

    pub async fn startup_session_with_options(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
    ) -> Result<AuthSession> {
        self.startup_from_sources(requested_name, strict_name, agent_type)
            .await
    }

    /// Rotate the token for an existing agent without re-registering.
    ///
    /// Calls `POST /v1/agents/:name/rotate-token` which generates a new bearer
    /// token while keeping the same agent identity and name. Falls back to full
    /// `refresh_session` if the agent no longer exists (404).
    pub async fn rotate_token(&self, cached: &CredentialCache) -> Result<AuthSession> {
        match self.rotate_token_no_fallback(cached).await {
            Ok(session) => Ok(session),
            Err(error) if is_not_found(&error) => {
                let agent_name = cached
                    .agent_name
                    .as_deref()
                    .context("cannot rotate token without agent name")?;
                let api_key = normalize_workspace_key(&cached.api_key)
                    .context("cached api_key is not a valid workspace key")?;
                tracing::info!(
                    target = "relay_broker::auth",
                    agent_name = %agent_name,
                    "agent not found during token rotation, falling back to re-registration"
                );
                let registration = self
                    .register_agent_with_workspace_key(&api_key, Some(agent_name), false, None)
                    .await
                    .context("failed to re-register after rotate-token 404")?;
                self.finish_session(api_key, Some(cached.workspace_id.clone()), registration)
            }
            Err(error) => Err(error),
        }
    }

    async fn rotate_token_no_fallback(&self, cached: &CredentialCache) -> Result<AuthSession> {
        let agent_name = cached
            .agent_name
            .as_deref()
            .context("cannot rotate token without agent name")?;
        let api_key = normalize_workspace_key(&cached.api_key)
            .context("cached api_key is not a valid workspace key")?;

        let relay = build_relay_client(&api_key, &self.base_url)?;
        let result = relay
            .rotate_agent_token(agent_name)
            .await
            .map_err(relay_error_to_anyhow)?;
        let token = result.token;

        let creds = CredentialCache {
            workspace_id: cached.workspace_id.clone(),
            agent_id: cached.agent_id.clone(),
            api_key: cached.api_key.clone(),
            agent_name: Some(agent_name.to_string()),
            agent_token: Some(token.clone()),
            updated_at: Utc::now(),
        };

        Ok(AuthSession {
            credentials: creds,
            token,
        })
    }

    async fn startup_from_sources(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
    ) -> Result<AuthSession> {
        let env_workspace_key = std::env::var("RELAY_API_KEY")
            .ok()
            .and_then(|s| normalize_workspace_key(&s));

        let mut workspace_id_hint: Option<String> = None;

        let mut candidates: Vec<(&str, String)> = Vec::new();
        if let Some(key) = env_workspace_key {
            candidates.push(("env", key));
        }

        let mut attempted_fresh_workspace = false;
        if candidates.is_empty() {
            let ws_name = format!("relay-{}", &Uuid::new_v4().to_string()[..8]);
            let (workspace_id, api_key) = self.create_workspace(&ws_name).await?;
            workspace_id_hint = Some(workspace_id);
            candidates.push(("fresh", api_key));
            attempted_fresh_workspace = true;
        }

        let preferred_name = requested_name;
        let mut auth_rejections = Vec::new();

        for (source, key) in &candidates {
            tracing::info!(
                target = "relay_broker::auth",
                source = %source,
                preferred_name = ?preferred_name,
                strict_name = %strict_name,
                agent_type = ?agent_type,
                "attempting registration with workspace key"
            );
            match self
                .register_agent_with_workspace_key(key, preferred_name, strict_name, agent_type)
                .await
            {
                Ok(registration) => {
                    tracing::info!(
                        target = "relay_broker::auth",
                        agent_id = %registration.0,
                        returned_name = %registration.1,
                        "registration succeeded"
                    );
                    return self.finish_session(key.clone(), workspace_id_hint, registration);
                }
                Err(error) if is_auth_rejection(&error) => {
                    auth_rejections.push(format!("{source} key rejected"));
                }
                Err(error) if is_rate_limited(&error) => {
                    auth_rejections.push(format!("{source} key rate-limited"));
                }
                Err(error) => {
                    return Err(error).context(format!(
                        "failed registering agent with {source} workspace key"
                    ));
                }
            }
        }

        if !attempted_fresh_workspace {
            let ws_name = format!("relay-{}", &Uuid::new_v4().to_string()[..8]);
            let (workspace_id, api_key) = self.create_workspace(&ws_name).await?;
            workspace_id_hint = Some(workspace_id);
            match self
                .register_agent_with_workspace_key(
                    &api_key,
                    preferred_name,
                    strict_name,
                    agent_type,
                )
                .await
            {
                Ok(registration) => {
                    return self.finish_session(api_key, workspace_id_hint, registration);
                }
                Err(error) => {
                    return Err(error).context("failed registering agent with fresh workspace key");
                }
            }
        }

        anyhow::bail!(
            "all workspace keys were rejected ({})",
            auth_rejections.join(", ")
        );
    }

    fn finish_session(
        &self,
        workspace_key: String,
        workspace_id_hint: Option<String>,
        registration: (String, String, String, Option<String>),
    ) -> Result<AuthSession> {
        let (agent_id, agent_name, token, workspace_id_from_register) = registration;
        let workspace_id = workspace_id_from_register
            .or(workspace_id_hint)
            .unwrap_or_else(|| "ws_unknown".to_string());

        let creds = CredentialCache {
            workspace_id,
            agent_id,
            api_key: workspace_key,
            agent_name: Some(agent_name),
            agent_token: Some(token.clone()),
            updated_at: Utc::now(),
        };

        Ok(AuthSession {
            credentials: creds,
            token,
        })
    }

    async fn create_workspace(&self, name: &str) -> Result<(String, String)> {
        let result = RelayCast::create_workspace(name, Some(&self.base_url))
            .await
            .map_err(relay_error_to_anyhow)?;
        Ok((result.workspace_id, result.api_key))
    }

    async fn register_agent_with_workspace_key(
        &self,
        workspace_key: &str,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
    ) -> Result<(String, String, String, Option<String>)> {
        let relay = build_relay_client(workspace_key, &self.base_url)?;
        let mut attempted_retry = false;
        let mut name = requested_name
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("agent-{}", Uuid::new_v4().simple()));

        loop {
            let request = CreateAgentRequest {
                name: name.clone(),
                agent_type: Some(agent_type.unwrap_or("agent").to_string()),
                persona: None,
                metadata: None,
            };

            match relay.register_agent(request).await {
                Ok(result) => {
                    return Ok((
                        result.id,
                        result.name,
                        result.token,
                        None, // workspace_id not returned in CreateAgentResponse
                    ));
                }
                Err(RelayError::Api { code, status, .. })
                    if is_conflict_code(&code) || status == 409 =>
                {
                    if strict_name {
                        anyhow::bail!("agent name '{}' already exists", name);
                    }
                    if !attempted_retry {
                        attempted_retry = true;
                        let suffix = Uuid::new_v4().simple().to_string();
                        name = format!("{}-{}", name, &suffix[..8]);
                        continue;
                    }
                    // Second conflict — give up
                    return Err(relay_error_to_anyhow(RelayError::Api {
                        code: "agent_already_exists".to_string(),
                        message: format!("agent name '{}' already exists after retry", name),
                        status: 409,
                    }));
                }
                Err(error) => {
                    return Err(relay_error_to_anyhow(error));
                }
            }
        }
    }

    pub async fn workspace_key_is_live(&self, workspace_key: &str) -> Result<bool> {
        let Some(workspace_key) = normalize_workspace_key(workspace_key) else {
            return Ok(false);
        };
        let relay = match build_relay_client(&workspace_key, &self.base_url) {
            Ok(relay) => relay,
            Err(_) => return Ok(false),
        };
        match relay.list_channels(false).await {
            Ok(_) => Ok(true),
            Err(RelayError::Api { status, .. }) if status == 401 || status == 403 => Ok(false),
            Err(_) => Ok(false),
        }
    }
}

fn normalize_workspace_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with("rk_") {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn is_auth_rejection(err: &anyhow::Error) -> bool {
    auth_http_status(err)
        .is_some_and(|status| status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN)
}

fn is_not_found(err: &anyhow::Error) -> bool {
    auth_http_status(err).is_some_and(|status| status == StatusCode::NOT_FOUND)
}

fn is_rate_limited(err: &anyhow::Error) -> bool {
    auth_http_status(err).is_some_and(|status| status == StatusCode::TOO_MANY_REQUESTS)
}

fn auth_http_status(err: &anyhow::Error) -> Option<StatusCode> {
    err.downcast_ref::<AuthHttpError>()
        .map(|e| e.status)
        .or_else(|| {
            err.downcast_ref::<reqwest::Error>()
                .and_then(reqwest::Error::status)
        })
}

/// Build a `RelayCast` workspace client from an API key and base URL.
fn build_relay_client(api_key: &str, base_url: &str) -> Result<RelayCast> {
    let opts = RelayCastOptions::new(api_key).with_base_url(base_url);
    RelayCast::new(opts).map_err(|e| anyhow::anyhow!("{e}"))
}

/// Convert a `RelayError` into an `anyhow::Error`, preserving the HTTP status
/// so that `is_auth_rejection`, `is_not_found`, and `is_rate_limited` still work.
fn relay_error_to_anyhow(error: RelayError) -> anyhow::Error {
    match &error {
        RelayError::Api {
            status, message, ..
        } => anyhow::Error::new(AuthHttpError {
            status: StatusCode::from_u16(*status as u16).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message: message.clone(),
        }),
        _ => anyhow::anyhow!("{error}"),
    }
}

fn is_conflict_code(code: &str) -> bool {
    matches!(
        code,
        "agent_already_exists" | "name_taken" | "conflict" | "duplicate"
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, MutexGuard};

    use httpmock::Method::{GET, POST};
    use httpmock::MockServer;
    use serde_json::json;

    use super::{AuthClient, CredentialCache};

    static RELAY_ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// Remove RELAY_API_KEY from the environment so it doesn't interfere with
    /// mock-server tests. Tests use httpmock and only set up specific auth
    /// headers — the real env key causes 404s against the mock.
    fn clear_relay_env() -> MutexGuard<'static, ()> {
        let guard = RELAY_ENV_MUTEX.lock().unwrap();
        // SAFETY: test-only; Rust warns about remove_var in multi-threaded
        // contexts but we accept the risk in test code.
        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
        guard
    }

    #[tokio::test]
    async fn first_run_creates_workspace_and_agent_session() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_new","api_key":"rk_live_new","created_at":"2025-01-01T00:00:00Z"}}"#);
        });
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_new");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a1","name":"lead","token":"at_live_1","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        let client = AuthClient::new(server.base_url());

        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.token, "at_live_1");
        assert_eq!(session.credentials.api_key, "rk_live_new");
        assert_eq!(session.credentials.workspace_id, "ws_new");
        assert_eq!(session.credentials.agent_id, "a1");
        assert_eq!(session.credentials.agent_name.as_deref(), Some("lead"));

        workspace.assert_hits(1);
        register.assert_hits(1);
    }

    #[tokio::test]
    async fn uses_env_workspace_key_without_creating_workspace() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_env");
        }
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_env");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a2","name":"lead","token":"at_live_2","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        let client = AuthClient::new(server.base_url());

        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.token, "at_live_2");
        assert_eq!(session.credentials.api_key, "rk_live_env");
        register.assert_hits(1);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    #[tokio::test]
    async fn unauthorized_env_key_falls_back_to_fresh_workspace() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let _stale_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_stale");
            then.status(401)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"unauthorized","message":"unauthorized"}}"#);
        });
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_new","api_key":"rk_live_new","created_at":"2025-01-01T00:00:00Z"}}"#);
        });
        let fresh_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_new");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a9","name":"lead","token":"at_live_9","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_stale");
        }

        let client = AuthClient::new(server.base_url());
        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.token, "at_live_9");
        assert_eq!(session.credentials.api_key, "rk_live_new");
        assert_eq!(session.credentials.workspace_id, "ws_new");
        workspace.assert_hits(1);
        fresh_register.assert_hits(1);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    #[tokio::test]
    async fn strict_name_returns_conflict_error() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_new","api_key":"rk_live_cached","created_at":"2025-01-01T00:00:00Z"}}"#);
        });
        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached")
                .json_body(json!({
                    "name": "lead",
                    "type": "agent"
                }));
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });

        let client = AuthClient::new(server.base_url());
        let err = client
            .startup_session_with_options(Some("lead"), true, None)
            .await
            .unwrap_err();

        let rendered = format!("{err:#}");
        assert!(rendered.contains("agent name 'lead' already exists"));
        workspace.assert_hits(1);
        conflict.assert_hits(1);
    }

    #[tokio::test]
    async fn default_name_conflict_retries_with_suffix_once() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_new","api_key":"rk_live_cached","created_at":"2025-01-01T00:00:00Z"}}"#);
        });
        let first_conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached")
                .json_body(json!({
                    "name": "lead",
                    "type": "agent"
                }));
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });
        let second_success = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached")
                .body_contains("\"name\":\"lead-");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a10","name":"lead-suffixed","token":"at_live_10","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        let client = AuthClient::new(server.base_url());
        let session = client.startup_session(Some("lead")).await.unwrap();

        assert_eq!(session.token, "at_live_10");
        assert_eq!(
            session.credentials.agent_name.as_deref(),
            Some("lead-suffixed")
        );
        workspace.assert_hits(1);
        first_conflict.assert_hits(1);
        second_success.assert_hits(1);
    }

    #[tokio::test]
    async fn rotate_token_calls_rotate_endpoint_and_preserves_name() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"token":"at_live_rotated","name":"lead"}}"#);
        });

        let client = AuthClient::new(server.base_url());

        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: None,
            updated_at: chrono::Utc::now(),
        };

        let session = client.rotate_token(&cached).await.unwrap();
        assert_eq!(session.token, "at_live_rotated");
        assert_eq!(session.credentials.agent_name.as_deref(), Some("lead"));
        assert_eq!(session.credentials.agent_id, "a_old");
        assert_eq!(session.credentials.workspace_id, "ws_cached");
        rotate.assert_hits(1);
    }

    #[tokio::test]
    async fn rotate_token_falls_back_to_reregister_on_404() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let rotate_404 = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(404)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"not_found","message":"not found"}}"#);
        });
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_new","name":"lead","token":"at_live_reregistered","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        let client = AuthClient::new(server.base_url());

        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: None,
            updated_at: chrono::Utc::now(),
        };

        let session = client.rotate_token(&cached).await.unwrap();
        assert_eq!(session.token, "at_live_reregistered");
        assert_eq!(session.credentials.agent_name.as_deref(), Some("lead"));
        rotate_404.assert_hits(1);
        register.assert_hits(1);
    }

    #[tokio::test]
    async fn workspace_key_liveness_probe_returns_true_for_success() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let channels = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/channels")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":[]}"#);
        });
        let client = AuthClient::new(server.base_url());

        let live = client
            .workspace_key_is_live("rk_live_cached")
            .await
            .unwrap();
        assert!(live);
        channels.assert_hits(1);
    }

    #[tokio::test]
    async fn workspace_key_liveness_probe_returns_false_for_unauthorized() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let channels = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/channels")
                .header("authorization", "Bearer rk_live_cached");
            then.status(401)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"unauthorized","message":"unauthorized"}}"#);
        });
        let client = AuthClient::new(server.base_url());

        let live = client
            .workspace_key_is_live("rk_live_cached")
            .await
            .unwrap();
        assert!(!live);
        channels.assert_hits(1);
    }

    #[test]
    fn workspace_key_normalization_accepts_rk_prefixes() {
        assert_eq!(
            super::normalize_workspace_key(" rk_test_123 "),
            Some("rk_test_123".to_string())
        );
        assert_eq!(super::normalize_workspace_key("at_live_1"), None);
    }
}
