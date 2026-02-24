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
pub enum CacheError {
    #[error("cache missing")]
    Missing,
    #[error("cache corrupt")]
    Corrupt,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct AuthHttpError {
    status: StatusCode,
    message: String,
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
        self.startup_session_with_options(requested_name, false, None)
            .await
    }

    pub async fn startup_session_with_options(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
    ) -> Result<AuthSession> {
        let cached = self.store.load().ok();
        self.startup_from_sources(requested_name, cached.as_ref(), strict_name, agent_type)
            .await
    }

    pub async fn refresh_session(&self, cached: &CredentialCache) -> Result<AuthSession> {
        self.startup_from_sources(cached.agent_name.as_deref(), Some(cached), false, None)
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

        let response = self
            .http
            .post(format!(
                "{}/v1/agents/{}/rotate-token",
                self.base_url, agent_name
            ))
            .bearer_auth(&api_key)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(auth_http_error(response, "rotate-token", Some(agent_name)).await);
        }
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
            agent_token: Some(token.clone()),
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
        agent_type: Option<&str>,
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
            let ws_name = format!("relay-{}", &Uuid::new_v4().to_string()[..8]);
            let (workspace_id, api_key) = self.create_workspace(&ws_name).await?;
            workspace_id_hint = Some(workspace_id);
            candidates.push(("fresh", api_key));
            attempted_fresh_workspace = true;
        }

        let preferred_name = requested_name.or(cached.and_then(|c| c.agent_name.as_deref()));
        let mut auth_rejections = Vec::new();

        if !strict_name {
            if let Some(cached_creds) = cached {
                if cached_creds.agent_name.is_some() {
                    if let Some(cached_key) = normalize_workspace_key(&cached_creds.api_key) {
                        if candidates
                            .iter()
                            .any(|(_, existing)| existing == &cached_key)
                        {
                            match self.rotate_token_no_fallback(cached_creds).await {
                                Ok(session) => return Ok(session),
                                Err(error) if is_rate_limited(&error) => {
                                    tracing::warn!(
                                        target = "relay_broker::auth",
                                        error = %error,
                                        agent_name = ?cached_creds.agent_name,
                                        "rotate-token rate-limited; falling through to registration probe"
                                    );
                                }
                                Err(error) if is_not_found(&error) => {
                                    tracing::info!(
                                        target = "relay_broker::auth",
                                        agent_name = ?cached_creds.agent_name,
                                        "cached agent not found during startup rotation; falling back to registration"
                                    );
                                }
                                Err(error) if is_auth_rejection(&error) => {
                                    tracing::warn!(
                                        target = "relay_broker::auth",
                                        error = %error,
                                        "cached token rotation rejected; falling back to registration"
                                    );
                                }
                                Err(error) => {
                                    return Err(error)
                                        .context("failed rotating cached relaycast token");
                                }
                            }
                        }
                    }
                }
            }
        }

        for (source, key) in &candidates {
            match self
                .register_agent_with_workspace_key(key, preferred_name, strict_name, agent_type)
                .await
            {
                Ok(registration) => {
                    return self.finish_session(key.clone(), workspace_id_hint, registration);
                }
                Err(error) if is_auth_rejection(&error) => {
                    auth_rejections.push(format!("{source} key rejected"));
                }
                Err(error) if is_rate_limited(&error) => {
                    if let Some(cached_creds) = cached {
                        if let Some(session) = cached_session_from_token(
                            cached_creds,
                            key,
                            requested_name,
                            strict_name,
                        ) {
                            tracing::warn!(
                                target = "relay_broker::auth",
                                source = %source,
                                agent_name = ?cached_creds.agent_name,
                                "using cached agent token due relaycast registration rate limit"
                            );
                            return Ok(session);
                        }
                    }
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
        agent_type: Option<&str>,
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
                    "type": agent_type.unwrap_or("agent"),
                }))
                .send()
                .await?;

            if response.status() == StatusCode::CONFLICT {
                if strict_name {
                    if let Some((
                        cached_agent_id,
                        cached_agent_name,
                        cached_token,
                        cached_workspace_id,
                    )) = self
                        .cached_registration_from_store(workspace_key, &name)
                        .await?
                    {
                        tracing::info!(
                            target = "relay_broker::auth",
                            agent_name = %name,
                            "strict-name registration conflict; reusing cached relaycast token"
                        );
                        return Ok((
                            cached_agent_id,
                            cached_agent_name,
                            cached_token,
                            cached_workspace_id,
                        ));
                    }
                    anyhow::bail!("agent name '{}' already exists", name);
                }
                if !attempted_retry {
                    attempted_retry = true;
                    let suffix = Uuid::new_v4().simple().to_string();
                    name = format!("{}-{}", name, &suffix[..8]);
                    continue;
                }
            }

            if !response.status().is_success() {
                return Err(auth_http_error(response, "registration", Some(&name)).await);
            }
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

    async fn cached_registration_from_store(
        &self,
        workspace_key: &str,
        requested_name: &str,
    ) -> Result<Option<(String, String, String, Option<String>)>> {
        let cached = match self.store.load() {
            Ok(cached) => cached,
            Err(_) => return Ok(None),
        };
        let cached_session =
            match cached_session_from_token(&cached, workspace_key, Some(requested_name), true) {
                Some(session) => session,
                None => return Ok(None),
            };

        match self
            .rotate_token_no_fallback(&cached_session.credentials)
            .await
        {
            Ok(refreshed) => {
                let workspace_id = if refreshed.credentials.workspace_id.trim().is_empty() {
                    None
                } else {
                    Some(refreshed.credentials.workspace_id)
                };
                Ok(Some((
                    refreshed.credentials.agent_id,
                    requested_name.to_string(),
                    refreshed.token,
                    workspace_id,
                )))
            }
            Err(error) if is_rate_limited(&error) => {
                tracing::warn!(
                    target = "relay_broker::auth",
                    agent_name = %requested_name,
                    "cached token refresh was rate-limited during strict-name conflict; reusing cached token"
                );
                let workspace_id = if cached_session.credentials.workspace_id.trim().is_empty() {
                    None
                } else {
                    Some(cached_session.credentials.workspace_id)
                };
                Ok(Some((
                    cached_session.credentials.agent_id,
                    requested_name.to_string(),
                    cached_session.token,
                    workspace_id,
                )))
            }
            Err(error) if is_auth_rejection(&error) || is_not_found(&error) => {
                Err(error).context(format!(
                    "agent name '{}' already exists but cached credentials could not be refreshed",
                    requested_name
                ))
            }
            Err(error) => Err(error).context(format!(
                "failed to refresh cached credentials for existing agent '{}'",
                requested_name
            )),
        }
    }

    pub async fn workspace_key_is_live(&self, workspace_key: &str) -> Result<bool> {
        let Some(workspace_key) = normalize_workspace_key(workspace_key) else {
            return Ok(false);
        };
        let response = self
            .http
            .get(format!("{}/v1/channels", self.base_url))
            .bearer_auth(workspace_key)
            .send()
            .await?;
        Ok(response.status().is_success())
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

fn cached_session_from_token(
    cached: &CredentialCache,
    workspace_key: &str,
    requested_name: Option<&str>,
    strict_name: bool,
) -> Option<AuthSession> {
    let normalized_cached_key = normalize_workspace_key(&cached.api_key)?;
    if normalized_cached_key != workspace_key {
        return None;
    }

    if strict_name
        && requested_name.is_some_and(|requested| cached.agent_name.as_deref() != Some(requested))
    {
        return None;
    }

    let token = cached.agent_token.clone()?;
    let mut credentials = cached.clone();
    credentials.updated_at = Utc::now();
    Some(AuthSession { credentials, token })
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

async fn auth_http_error(
    response: reqwest::Response,
    operation: &str,
    agent_name: Option<&str>,
) -> anyhow::Error {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body_text = response.text().await.unwrap_or_default();
    let detail = relaycast_error_detail(&body_text);

    let message = if status == StatusCode::TOO_MANY_REQUESTS {
        let retry_text = retry_after
            .map(|value| format!("; retry after {value}s"))
            .unwrap_or_default();
        match (agent_name, detail) {
            (Some(name), Some(detail)) => {
                format!("relaycast {operation} for '{name}' was rate-limited{retry_text}: {detail}")
            }
            (Some(name), None) => {
                format!("relaycast {operation} for '{name}' was rate-limited{retry_text}")
            }
            (None, Some(detail)) => {
                format!("relaycast {operation} was rate-limited{retry_text}: {detail}")
            }
            (None, None) => format!("relaycast {operation} was rate-limited{retry_text}"),
        }
    } else {
        match (agent_name, detail) {
            (Some(name), Some(detail)) => {
                format!("relaycast {operation} failed for '{name}' ({status}): {detail}")
            }
            (Some(name), None) => format!("relaycast {operation} failed for '{name}' ({status})"),
            (None, Some(detail)) => format!("relaycast {operation} failed ({status}): {detail}"),
            (None, None) => format!("relaycast {operation} failed ({status})"),
        }
    };

    anyhow::Error::new(AuthHttpError { status, message })
}

fn relaycast_error_detail(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    parsed
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            parsed
                .pointer("/error/code")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            parsed
                .get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use httpmock::Method::{GET, POST};
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
            agent_token: None,
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
            agent_token: None,
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
            agent_token: None,
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
            agent_token: None,
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let err = client
            .startup_session_with_options(Some("lead"), true, None)
            .await
            .unwrap_err();

        let rendered = format!("{err:#}");
        assert!(rendered.contains("agent name 'lead' already exists"));
        conflict.assert_hits(1);
    }

    #[tokio::test]
    async fn strict_name_conflict_reuses_cached_token_when_name_matches() {
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
            agent_id: "a_cached".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: Some("at_live_cached_token".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let session = client
            .startup_session_with_options(Some("lead"), true, None)
            .await
            .unwrap();

        assert_eq!(session.token, "at_live_cached_token");
        assert_eq!(session.credentials.agent_name.as_deref(), Some("lead"));
        assert_eq!(session.credentials.agent_id, "a_cached");
        conflict.assert_hits(1);
    }

    #[tokio::test]
    async fn strict_name_conflict_refreshes_stale_cached_token_before_reuse() {
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
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"token":"at_live_rotated","name":"lead"}}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_cached".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: Some("at_revoked_old".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let session = client
            .startup_session_with_options(Some("lead"), true, None)
            .await
            .unwrap();

        assert_eq!(session.token, "at_live_rotated");
        assert_eq!(
            session.credentials.agent_token.as_deref(),
            Some("at_live_rotated")
        );
        conflict.assert_hits(1);
        rotate.assert_hits(1);
    }

    #[tokio::test]
    async fn strict_name_conflict_with_unrefreshable_cached_credentials_is_actionable() {
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
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(401)
                .header("content-type", "application/json")
                .body(r#"{"error":{"message":"unauthorized"}}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_cached".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: Some("at_revoked_old".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let err = client
            .startup_session_with_options(Some("lead"), true, None)
            .await
            .unwrap_err();

        let rendered = format!("{err:#}");
        assert!(rendered.contains("cached credentials could not be refreshed"));
        conflict.assert_hits(1);
        rotate.assert_hits(1);
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
            agent_token: None,
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
    async fn startup_prefers_rotate_token_over_register() {
        clear_relay_env();
        let server = MockServer::start();
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"token":"at_live_rotated_startup"}}"#);
        });
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(500)
                .header("content-type", "application/json")
                .body(r#"{"error":"should_not_register"}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: None,
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let session = client.startup_session(Some("lead")).await.unwrap();

        assert_eq!(session.token, "at_live_rotated_startup");
        rotate.assert_hits(1);
        register.assert_hits(0);
    }

    #[tokio::test]
    async fn startup_uses_cached_agent_token_when_rotate_is_rate_limited() {
        clear_relay_env();
        let server = MockServer::start();
        let rate_limit_body =
            include_str!("../tests/fixtures/contracts/wave0/startup-429-rate-limit.json");
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(429)
                .header("content-type", "application/json")
                .body(rate_limit_body);
        });
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(429)
                .header("content-type", "application/json")
                .body(rate_limit_body);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: Some("at_live_cached_token".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let session = client.startup_session(Some("lead")).await.unwrap();

        assert_eq!(session.token, "at_live_cached_token");
        assert_eq!(session.credentials.agent_name.as_deref(), Some("lead"));
        rotate.assert_hits(1);
        // After rotate-token is rate-limited, the registration loop is still
        // probed so telemetry can explicitly mark 429 mode.
        register.assert_hits(1);
    }

    #[tokio::test]
    async fn workspace_key_liveness_probe_returns_true_for_success() {
        clear_relay_env();
        let server = MockServer::start();
        let channels = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/channels")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"[]"#);
        });
        let client = AuthClient::new(
            server.base_url(),
            CredentialStore::new(tempdir().unwrap().path().join("relaycast.json")),
        );

        let live = client
            .workspace_key_is_live("rk_live_cached")
            .await
            .unwrap();
        assert!(live);
        channels.assert_hits(1);
    }

    #[tokio::test]
    async fn workspace_key_liveness_probe_returns_false_for_unauthorized() {
        clear_relay_env();
        let server = MockServer::start();
        let channels = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/channels")
                .header("authorization", "Bearer rk_live_cached");
            then.status(401)
                .header("content-type", "application/json")
                .body(r#"{"error":"unauthorized"}"#);
        });
        let client = AuthClient::new(
            server.base_url(),
            CredentialStore::new(tempdir().unwrap().path().join("relaycast.json")),
        );

        let live = client
            .workspace_key_is_live("rk_live_cached")
            .await
            .unwrap();
        assert!(!live);
        channels.assert_hits(1);
    }

    #[tokio::test]
    async fn startup_429_degraded_contract_requires_registration_probe() {
        clear_relay_env();
        let server = MockServer::start();
        let rate_limit_body =
            include_str!("../tests/fixtures/contracts/wave0/startup-429-rate-limit.json");
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(429)
                .header("content-type", "application/json")
                .header("retry-after", "60")
                .body(rate_limit_body);
        });
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached");
            then.status(429)
                .header("content-type", "application/json")
                .header("retry-after", "60")
                .body(rate_limit_body);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: Some("at_live_cached_token".into()),
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let session = client.startup_session(Some("lead")).await.unwrap();

        assert_eq!(session.token, "at_live_cached_token");
        rotate.assert_hits(1);
        // TODO(contract-wave0-startup-429): degraded startup must still perform one
        // registration-path probe so startup telemetry can explicitly mark 429 mode.
        register.assert_hits(1);
    }

    #[tokio::test]
    async fn startup_rate_limit_error_includes_retry_hint_when_no_cached_token() {
        clear_relay_env();
        let server = MockServer::start();
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(429)
                .header("content-type", "application/json")
                .header("retry-after", "60")
                .body(r#"{"ok":false,"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded. 60 requests per minute allowed for free plan."}}"#);
        });
        let cached_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_cached");
            then.status(429)
                .header("content-type", "application/json")
                .header("retry-after", "60")
                .body(r#"{"ok":false,"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded. 60 requests per minute allowed for free plan."}}"#);
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
            then.status(429)
                .header("content-type", "application/json")
                .header("retry-after", "60")
                .body(r#"{"ok":false,"error":{"code":"rate_limit_exceeded","message":"Rate limit exceeded. 60 requests per minute allowed for free plan."}}"#);
        });

        let dir = tempdir().unwrap();
        let cache_path = dir.path().join("relaycast.json");
        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            agent_id: "a_old".into(),
            api_key: "rk_live_cached".into(),
            agent_name: Some("lead".into()),
            agent_token: None,
            updated_at: chrono::Utc::now(),
        };
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        let client = AuthClient::new(server.base_url(), CredentialStore::new(cache_path));
        let err = client.startup_session(Some("lead")).await.unwrap_err();
        let rendered = format!("{err:#}");

        assert!(rendered.contains("failed registering agent with fresh workspace key"));
        assert!(rendered.contains("rate-limited"));
        assert!(rendered.contains("retry after 60s"));
        rotate.assert_hits(1);
        cached_register.assert_hits(1);
        workspace.assert_hits(1);
        fresh_register.assert_hits(1);
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
