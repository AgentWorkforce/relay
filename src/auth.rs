use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialCache {
    pub workspace_id: String,
    pub agent_id: String,
    pub api_key: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct AuthSession {
    pub credentials: CredentialCache,
    pub token: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("cache missing")]
    Missing,
    #[error("cache corrupt")]
    Corrupt,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct CredentialStore {
    path: PathBuf,
}

impl CredentialStore {
    /// Returns the per-project credential cache path based on CWD.
    /// Each project gets its own credentials so concurrent workflows from
    /// different repos never conflict.
    pub fn default_path() -> Result<PathBuf> {
        let cwd = std::env::current_dir().context("failed to determine current directory")?;
        Ok(cwd.join(".agent-relay").join("relaycast.json"))
    }

    /// Returns the legacy global credential cache path (~/.agent-relay/relaycast.json).
    pub fn global_path() -> Result<PathBuf> {
        let home = dirs::home_dir().context("failed to determine home directory")?;
        Ok(home.join(".agent-relay").join("relaycast.json"))
    }

    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> std::result::Result<CredentialCache, CacheError> {
        let text = fs::read_to_string(&self.path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CacheError::Missing
            } else {
                CacheError::Io(e)
            }
        })?;

        serde_json::from_str(&text).map_err(|_| CacheError::Corrupt)
    }

    pub fn save(&self, creds: &CredentialCache) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create directory {}", parent.display()))?;
        }

        let tmp_path = self.path.with_extension("json.tmp");
        let body = serde_json::to_vec_pretty(creds)?;
        fs::write(&tmp_path, body)?;

        set_owner_only_permissions(&tmp_path)?;

        fs::rename(&tmp_path, &self.path).with_context(|| {
            format!(
                "failed to move cache file into place: {} -> {}",
                tmp_path.display(),
                self.path.display()
            )
        })?;

        set_owner_only_permissions(&self.path)?;
        Ok(())
    }
}

#[cfg(unix)]
fn set_owner_only_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[derive(Clone)]
pub struct AuthClient {
    http: reqwest::Client,
    base_url: String,
    store: CredentialStore,
}

impl AuthClient {
    pub fn new(base_url: impl Into<String>, store: CredentialStore) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.into(),
            store,
        }
    }

    pub async fn startup_session(&self, requested_name: Option<&str>) -> Result<AuthSession> {
        self.startup_session_with_options(requested_name, false)
            .await
    }

    pub async fn startup_session_with_options(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
    ) -> Result<AuthSession> {
        let cached = self.store.load().ok();
        self.startup_from_sources(requested_name, cached.as_ref(), strict_name)
            .await
    }

    pub async fn refresh_session(&self, cached: &CredentialCache) -> Result<AuthSession> {
        self.startup_from_sources(cached.agent_name.as_deref(), Some(cached), false)
            .await
    }

    /// Rotate the token for an existing agent without re-registering.
    ///
    /// Calls `POST /v1/agents/:name/rotate-token` which generates a new bearer
    /// token while keeping the same agent identity and name. Falls back to full
    /// `refresh_session` if the agent no longer exists (404).
    pub async fn rotate_token(&self, cached: &CredentialCache) -> Result<AuthSession> {
        let agent_name = cached
            .agent_name
            .as_deref()
            .context("cannot rotate token without agent name")?;
        let api_key = normalize_workspace_key(&cached.api_key)
            .context("cached api_key is not a valid workspace key")?;

        let response = self
            .http
            .post(format!(
                "{}/v1/agents/{}/rotate-token",
                self.base_url, agent_name
            ))
            .bearer_auth(&api_key)
            .send()
            .await?;

        if response.status() == StatusCode::NOT_FOUND {
            tracing::info!(
                target = "relay_broker::auth",
                agent_name = %agent_name,
                "agent not found during token rotation, falling back to re-registration"
            );
            return self.refresh_session(cached).await;
        }

        let response = response.error_for_status()?;
        let body: Value = response.json().await?;
        let data = body.get("data").unwrap_or(&body);
        let token = data
            .get("token")
            .and_then(Value::as_str)
            .context("rotate-token response missing token")?
            .to_string();

        let creds = CredentialCache {
            workspace_id: cached.workspace_id.clone(),
            agent_id: cached.agent_id.clone(),
            api_key: cached.api_key.clone(),
            agent_name: Some(agent_name.to_string()),
            updated_at: Utc::now(),
        };
        self.store.save(&creds)?;

        Ok(AuthSession {
            credentials: creds,
            token,
        })
    }

    async fn startup_from_sources(
        &self,
        requested_name: Option<&str>,
        cached: Option<&CredentialCache>,
        strict_name: bool,
    ) -> Result<AuthSession> {
        let env_workspace_key = std::env::var("RELAY_API_KEY")
            .ok()
            .and_then(|s| normalize_workspace_key(&s));
        let cached_workspace_key = cached.and_then(|c| normalize_workspace_key(&c.api_key));

        let mut workspace_id_hint = cached
            .map(|c| c.workspace_id.clone())
            .filter(|id| id.starts_with("ws_"));

        let mut candidates: Vec<(&str, String)> = Vec::new();
        if let Some(key) = env_workspace_key {
            candidates.push(("env", key));
        }
        if let Some(key) = cached_workspace_key {
            if !candidates.iter().any(|(_, existing)| existing == &key) {
                candidates.push(("cache", key));
            }
        }

        let mut attempted_fresh_workspace = false;
        if candidates.is_empty() {
            let ws_name = requested_name.unwrap_or("agent-relay");
            let (workspace_id, api_key) = self.create_workspace(ws_name).await?;
            workspace_id_hint = Some(workspace_id);
            candidates.push(("fresh", api_key));
            attempted_fresh_workspace = true;
        }

        let preferred_name = requested_name.or(cached.and_then(|c| c.agent_name.as_deref()));
        let mut auth_rejections = Vec::new();

        for (source, key) in &candidates {
            match self
                .register_agent_with_workspace_key(key, preferred_name, strict_name)
                .await
            {
                Ok(registration) => {
                    return self.finish_session(key.clone(), workspace_id_hint, registration);
                }
                Err(error) if is_auth_rejection(&error) => {
                    auth_rejections.push(format!("{source} key rejected"));
                }
                Err(error) => {
                    return Err(error).context(format!(
                        "failed registering agent with {source} workspace key"
                    ));
                }
            }
        }

        if !attempted_fresh_workspace {
            let ws_name = requested_name.unwrap_or("agent-relay");
            let (workspace_id, api_key) = self.create_workspace(ws_name).await?;
            workspace_id_hint = Some(workspace_id);
            match self
                .register_agent_with_workspace_key(&api_key, preferred_name, strict_name)
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
            updated_at: Utc::now(),
        };
        self.store.save(&creds)?;

        Ok(AuthSession {
            credentials: creds,
            token,
        })
    }

    async fn create_workspace(&self, name: &str) -> Result<(String, String)> {
        let response = self
            .http
            .post(format!("{}/v1/workspaces", self.base_url))
            .json(&json!({ "name": name }))
            .send()
            .await?
            .error_for_status()?;

        let body: Value = response.json().await?;
        let data = body.get("data").unwrap_or(&body);
        let workspace_id = data
            .get("workspace_id")
            .and_then(Value::as_str)
            .or_else(|| data.get("id").and_then(Value::as_str))
            .context("workspace create response missing workspace id")?
            .to_string();
        let api_key = data
            .get("api_key")
            .and_then(Value::as_str)
            .context("workspace create response missing api_key")?
            .to_string();
        Ok((workspace_id, api_key))
    }

    async fn register_agent_with_workspace_key(
        &self,
        workspace_key: &str,
        requested_name: Option<&str>,
        strict_name: bool,
    ) -> Result<(String, String, String, Option<String>)> {
        let mut attempted_retry = false;
        let mut name = requested_name
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("agent-{}", Uuid::new_v4().simple()));

        loop {
            let response = self
                .http
                .post(format!("{}/v1/agents", self.base_url))
                .bearer_auth(workspace_key)
                .json(&json!({
                    "name": name,
                    "type": "agent",
                }))
                .send()
                .await?;

            if response.status() == StatusCode::CONFLICT {
                if strict_name {
                    anyhow::bail!("agent name '{}' already exists", name);
                }
                if !attempted_retry {
                    attempted_retry = true;
                    let suffix = Uuid::new_v4().simple().to_string();
                    name = format!("{}-{}", name, &suffix[..8]);
                    continue;
                }
            }

            let response = response.error_for_status()?;
            let body: Value = response.json().await?;
            let data = body.get("data").unwrap_or(&body);
            let token = data
                .get("token")
                .and_then(Value::as_str)
                .context("agent register response missing token")?
                .to_string();
            let agent_id = data
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| data.get("agent_id").and_then(Value::as_str))
                .unwrap_or(&name)
                .to_string();
            let returned_name = data
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&name)
                .to_string();
            let workspace_id = data
                .get("workspace_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);

            return Ok((agent_id, returned_name, token, workspace_id));
        }
    }

    pub fn store(&self) -> &CredentialStore {
        &self.store
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
    err.downcast_ref::<reqwest::Error>()
        .and_then(reqwest::Error::status)
        .is_some_and(|status| status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use httpmock::Method::POST;
    use httpmock::MockServer;
    use serde_json::json;
    use tempfile::tempdir;

    use super::{AuthClient, CredentialCache, CredentialStore};

    /// Remove RELAY_API_KEY from the environment so it doesn't interfere with
    /// mock-server tests. Tests use httpmock and only set up specific auth
    /// headers — the real env key causes 404s against the mock.
    fn clear_relay_env() {
        // SAFETY: test-only; Rust warns about remove_var in multi-threaded
        // contexts but we accept the risk in test code.
        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    #[tokio::test]
    async fn first_run_creates_workspace_and_agent_session() {
        clear_relay_env();
        let server = MockServer::start();
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_new","api_key":"rk_live_new"}}"#);
        });
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_new");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a1","name":"lead","token":"at_live_1","workspace_id":"ws_new"}}"#);
        });

        let dir = tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("relaycast.json"));
        let client = AuthClient::new(server.base_url(), store.clone());

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
    async fn uses_cached_workspace_key_without_creating_workspace() {
        clear_relay_env();
        let server = MockServer::start();
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a2","name":"lead","token":"at_live_2","workspace_id":"ws_cached"}}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let store = CredentialStore::new(cache_path);
        let client = AuthClient::new(server.base_url(), store);

        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.token, "at_live_2");
        assert_eq!(session.credentials.workspace_id, "ws_cached");
        assert_eq!(session.credentials.api_key, "rk_live_cached");
        register.assert_hits(1);
    }

    #[tokio::test]
    async fn corrupt_cache_bootstraps_new_workspace() {
        clear_relay_env();
        let server = MockServer::start();
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_boot","api_key":"rk_live_boot"}}"#);
        });
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_boot");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a3","name":"lead","token":"at_live_3"}}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        fs::write(&cache_path, "not-json").unwrap();

        let store = CredentialStore::new(cache_path);
        let client = AuthClient::new(server.base_url(), store);

        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.token, "at_live_3");
        assert_eq!(session.credentials.api_key, "rk_live_boot");

        workspace.assert_hits(1);
        register.assert_hits(1);
    }

    #[tokio::test]
    async fn refresh_session_uses_cached_workspace_key() {
        clear_relay_env();
        let server = MockServer::start();
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a4","name":"lead","token":"at_live_4","workspace_id":"ws_cached"}}"#);
        });

        let dir = tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("relaycast.json"));
        let client = AuthClient::new(server.base_url(), store);

        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            updated_at: chrono::Utc::now(),
        };

        let session = client.refresh_session(&cached).await.unwrap();
        assert_eq!(session.token, "at_live_4");
        assert_eq!(session.credentials.workspace_id, "ws_cached");
        register.assert_hits(1);
    }

    #[tokio::test]
    async fn unauthorized_cached_key_bootstraps_fresh_workspace() {
        clear_relay_env();
        let server = MockServer::start();
        let stale_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_stale");
            then.status(401)
                .header("content-type", "application/json")
                .body(r#"{"error":"unauthorized"}"#);
        });
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_new","api_key":"rk_live_new"}}"#);
        });
        let fresh_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_new");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a9","name":"lead","token":"at_live_9","workspace_id":"ws_new"}}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_old".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_stale".into(),
            agent_name: Some("lead".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let store = CredentialStore::new(cache_path);
        let client = AuthClient::new(server.base_url(), store);

        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.token, "at_live_9");
        assert_eq!(session.credentials.api_key, "rk_live_new");
        assert_eq!(session.credentials.workspace_id, "ws_new");
        stale_register.assert_hits(1);
        workspace.assert_hits(1);
        fresh_register.assert_hits(1);
    }

    #[tokio::test]
    async fn strict_name_returns_conflict_without_suffix_retry() {
        clear_relay_env();
        let server = MockServer::start();
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
                .body(r#"{"error":"name_taken"}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let err = client
            .startup_session_with_options(Some("lead"), true)
            .await
            .unwrap_err();

        let rendered = format!("{err:#}");
        assert!(rendered.contains("agent name 'lead' already exists"));
        conflict.assert_hits(1);
    }

    #[tokio::test]
    async fn default_name_conflict_retries_with_suffix_once() {
        clear_relay_env();
        let server = MockServer::start();
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
                .body(r#"{"error":"name_taken"}"#);
        });
        let second_success = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached")
                .body_contains("\"name\":\"lead-");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a10","name":"lead-suffixed","token":"at_live_10","workspace_id":"ws_cached"}}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let session = client.startup_session(Some("lead")).await.unwrap();

        assert_eq!(session.token, "at_live_10");
        assert_eq!(
            session.credentials.agent_name.as_deref(),
            Some("lead-suffixed")
        );
        first_conflict.assert_hits(1);
        second_success.assert_hits(1);
    }

    #[tokio::test]
    async fn rotate_token_calls_rotate_endpoint_and_preserves_name() {
        clear_relay_env();
        let server = MockServer::start();
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"token":"at_live_rotated"}}"#);
        });

        let dir = tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("relaycast.json"));
        let client = AuthClient::new(server.base_url(), store);

        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
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
        clear_relay_env();
        let server = MockServer::start();
        let rotate_404 = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(404)
                .header("content-type", "application/json")
                .body(r#"{"error":"not_found"}"#);
        });
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_new","name":"lead","token":"at_live_reregistered","workspace_id":"ws_cached"}}"#);
        });

        let dir = tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("relaycast.json"));
        let client = AuthClient::new(server.base_url(), store);

        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            updated_at: chrono::Utc::now(),
        };

        let session = client.rotate_token(&cached).await.unwrap();
        assert_eq!(session.token, "at_live_reregistered");
        assert_eq!(session.credentials.agent_name.as_deref(), Some("lead"));
        rotate_404.assert_hits(1);
        register.assert_hits(1);
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
