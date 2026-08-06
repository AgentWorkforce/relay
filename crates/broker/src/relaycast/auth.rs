use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use relaycast::{CreateAgentRequest, RelayCast, RelayCastOptions, RelayError};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceCredential {
    pub workspace_id: String,
    #[serde(
        default,
        alias = "workspaceAlias",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_alias: Option<String>,
    pub agent_id: String,
    pub api_key: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub agent_token: Option<String>,
    pub updated_at: DateTime<Utc>,
}

pub type CredentialCache = WorkspaceCredential;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CredentialSet {
    #[serde(default)]
    pub memberships: Vec<WorkspaceCredential>,
    #[serde(
        default,
        alias = "defaultWorkspaceId",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_workspace_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthSessionSet {
    pub memberships: Vec<AuthSession>,
    pub default_workspace_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuthSession {
    pub credentials: CredentialCache,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkspaceSource {
    #[serde(default, alias = "workspaceId")]
    workspace_id: Option<String>,
    #[serde(default, alias = "workspaceAlias")]
    workspace_alias: Option<String>,
    api_key: String,
}

struct EnvWorkspaceKey {
    source: &'static str,
    key: String,
    explicit_join: bool,
}

impl CredentialSet {
    pub fn from_json(raw: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(raw).context("invalid credential set JSON")?;
        Self::from_value(value)
    }

    pub fn from_value(value: Value) -> Result<Self> {
        if let Ok(set) = serde_json::from_value::<CredentialSet>(value.clone()) {
            if !set.memberships.is_empty() {
                return Ok(Self::normalize(set));
            }
        }

        if let Ok(legacy) = serde_json::from_value::<WorkspaceCredential>(value.clone()) {
            return Ok(Self::from_legacy(legacy));
        }

        if let Ok(legacy) = serde_json::from_value::<Vec<WorkspaceCredential>>(value.clone()) {
            return Ok(Self::from_memberships(legacy, None));
        }

        if let Ok(source) = serde_json::from_value::<WorkspaceSource>(value.clone()) {
            return Ok(Self::from_memberships(
                vec![WorkspaceCredential {
                    workspace_id: source
                        .workspace_id
                        .unwrap_or_else(|| "ws_unknown".to_string()),
                    workspace_alias: source.workspace_alias,
                    agent_id: String::new(),
                    api_key: source.api_key,
                    agent_name: None,
                    agent_token: None,
                    updated_at: Utc::now(),
                }],
                None,
            ));
        }

        anyhow::bail!("credential JSON was neither a credential set nor a legacy cache entry")
    }

    pub fn from_legacy(legacy: WorkspaceCredential) -> Self {
        let default_workspace_id = Some(legacy.workspace_id.clone());
        Self {
            memberships: vec![legacy],
            default_workspace_id,
        }
    }

    pub fn from_memberships(
        memberships: Vec<WorkspaceCredential>,
        default_workspace_id: Option<String>,
    ) -> Self {
        Self::normalize(Self {
            memberships,
            default_workspace_id,
        })
    }

    pub fn default_membership(&self) -> Option<&WorkspaceCredential> {
        if let Some(default_workspace_id) = self.default_workspace_id.as_deref() {
            self.membership_by_selector(default_workspace_id)
                .or_else(|| {
                    self.memberships
                        .iter()
                        .find(|membership| membership.workspace_id == default_workspace_id)
                })
        } else if self.memberships.len() == 1 {
            self.memberships.first()
        } else {
            None
        }
    }

    pub fn membership_by_selector(&self, selector: &str) -> Option<&WorkspaceCredential> {
        let trimmed = selector.trim();
        self.memberships.iter().find(|membership| {
            membership.workspace_id == trimmed
                || membership
                    .workspace_alias
                    .as_deref()
                    .is_some_and(|alias| alias.eq_ignore_ascii_case(trimmed))
        })
    }

    fn normalize(mut set: Self) -> Self {
        set.memberships
            .retain(|membership| !membership.api_key.trim().is_empty());
        if set.default_workspace_id.is_none() && set.memberships.len() == 1 {
            set.default_workspace_id = set
                .memberships
                .first()
                .map(|membership| membership.workspace_id.clone());
        }
        set
    }
}

impl AuthSessionSet {
    pub fn credential_set(&self) -> CredentialSet {
        CredentialSet::from_memberships(
            self.memberships
                .iter()
                .map(|session| session.credentials.clone())
                .collect(),
            self.default_workspace_id.clone(),
        )
    }

    pub fn default_session(&self) -> Option<&AuthSession> {
        if let Some(default_workspace_id) = self.default_workspace_id.as_deref() {
            self.memberships.iter().find(|session| {
                session.credentials.workspace_id == default_workspace_id
                    || session
                        .credentials
                        .workspace_alias
                        .as_deref()
                        .is_some_and(|alias| alias.eq_ignore_ascii_case(default_workspace_id))
            })
        } else if self.memberships.len() == 1 {
            self.memberships.first()
        } else {
            None
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct AuthHttpError {
    status: StatusCode,
    message: String,
    /// Server-supplied error code (e.g. `agent_token_invalid`) when the
    /// upstream `RelayError::Api` carried one. Kept here so that downstream
    /// callers can distinguish a stale agent token from a generic 401.
    code: Option<String>,
}

/// Error code returned by Relaycast when a previously-issued agent token has
/// been revoked or expired. Mirrors the contract in relaycast PR #137: any
/// 401 carrying this code (or the canonical `Invalid agent token` message)
/// must be treated as recoverable via re-registration.
pub const AGENT_TOKEN_INVALID_CODE: &str = "agent_token_invalid";
const AGENT_TOKEN_INVALID_MESSAGE: &str = "Invalid agent token";

/// True when `code` matches the relaycast `agent_token_invalid` contract.
/// Comparison is case-insensitive and ignores surrounding whitespace so
/// `" agent_token_invalid "` matches — kept consistent with the TypeScript
/// detector's `normalizeCode`.
pub fn is_agent_token_invalid_code(code: &str) -> bool {
    code.trim().eq_ignore_ascii_case(AGENT_TOKEN_INVALID_CODE)
}

/// True when the relaycast error indicates the agent token must be
/// re-issued. Recognises both the typed `agent_token_invalid` code and the
/// legacy 401 + `Invalid agent token` message pair so the helper works
/// against both pre- and post-PR-#137 servers.
pub fn is_agent_token_invalid(err: &RelayError) -> bool {
    match err {
        RelayError::Api {
            code,
            status,
            message,
        } => {
            is_agent_token_invalid_code(code)
                || (*status == 401 && message.trim() == AGENT_TOKEN_INVALID_MESSAGE)
        }
        _ => false,
    }
}

/// `anyhow::Error`-flavored counterpart to `is_agent_token_invalid` — works
/// against the `AuthHttpError` wrappers produced by `relay_error_to_anyhow`.
pub fn is_agent_token_invalid_anyhow(err: &anyhow::Error) -> bool {
    if let Some(auth_err) = err.downcast_ref::<AuthHttpError>() {
        if let Some(code) = &auth_err.code {
            if is_agent_token_invalid_code(code) {
                return true;
            }
        }
        return auth_err.status == StatusCode::UNAUTHORIZED
            && auth_err.message.trim() == AGENT_TOKEN_INVALID_MESSAGE;
    }
    false
}

/// Generate a deterministic workspace name based on the current user and working
/// directory so that the same user in the same project gets the same workspace
/// across sessions (enabling message continuity and resume).
fn deterministic_workspace_name() -> String {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string());
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    let mut hasher = Sha256::new();
    hasher.update(format!("{user}:{cwd}"));
    let hash = format!("{:x}", hasher.finalize());
    format!("relay-{}", &hash[..8])
}

#[derive(Clone)]
pub struct AuthClient {
    base_url: Option<String>,
}

impl AuthClient {
    pub fn new(base_url: Option<String>) -> Self {
        Self { base_url }
    }

    pub async fn startup_session(&self, requested_name: Option<&str>) -> Result<AuthSession> {
        self.startup_session_with_options(requested_name, false, None)
            .await
    }

    pub async fn startup_session_set(
        &self,
        requested_name: Option<&str>,
    ) -> Result<AuthSessionSet> {
        self.startup_session_set_with_options(requested_name, false, None)
            .await
    }

    pub async fn startup_session_with_options(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
    ) -> Result<AuthSession> {
        let sessions = self
            .startup_session_set_with_options(requested_name, strict_name, agent_type)
            .await?;
        sessions
            .default_session()
            .cloned()
            .context("no default workspace session was available")
    }

    /// See [`Self::startup_session_set_with_identity`]. Uses
    /// `RELAY_AGENT_IDENTITY_KEY` (see `agent_identity_key`) as the identity
    /// proof, preserving prior behavior for every existing caller.
    pub async fn startup_session_set_with_options(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
    ) -> Result<AuthSessionSet> {
        self.startup_session_set_with_identity(
            requested_name,
            strict_name,
            agent_type,
            agent_identity_key().as_deref(),
        )
        .await
    }

    /// Same as [`Self::startup_session_set_with_options`], but with an
    /// explicit identity proof rather than reading `RELAY_AGENT_IDENTITY_KEY`
    /// from the environment. The broker's own startup registration
    /// (`connect_relay`) uses this to pass a value stable across its own
    /// restarts (see `stable_node_identity_key`) without mutating process
    /// env — an env mutation here would leak into every worker this broker
    /// later spawns, since child processes inherit the full parent
    /// environment.
    pub async fn startup_session_set_with_identity(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
        identity_key: Option<&str>,
    ) -> Result<AuthSessionSet> {
        if let Some((sources, default_hint)) = self.load_workspace_sources_from_env()? {
            let preferred_name = requested_name;
            let mut memberships = Vec::with_capacity(sources.len());
            let mut auth_rejections = Vec::new();

            for source in sources {
                let Some(api_key) = normalize_workspace_key(&source.api_key) else {
                    anyhow::bail!("RELAY_WORKSPACES_JSON contained an invalid workspace key");
                };
                match self
                    .register_agent_with_workspace_key(
                        &api_key,
                        preferred_name,
                        strict_name,
                        agent_type,
                        identity_key,
                    )
                    .await
                {
                    Ok(registration) => {
                        let mut session = self.finish_session(
                            api_key,
                            source.workspace_id.clone(),
                            registration,
                        )?;
                        session.credentials.workspace_alias = source.workspace_alias.clone();
                        memberships.push(session);
                    }
                    Err(error) if is_auth_rejection(&error) => {
                        auth_rejections
                            .push(source.workspace_id.unwrap_or_else(|| "env".to_string()));
                    }
                    Err(error) if is_rate_limited(&error) => {
                        auth_rejections.push(
                            source
                                .workspace_id
                                .unwrap_or_else(|| "env_rate_limited".to_string()),
                        );
                    }
                    Err(error) => {
                        return Err(error)
                            .context("failed registering agent for configured workspace");
                    }
                }
            }

            if memberships.is_empty() {
                anyhow::bail!(
                    "all configured multi-workspace memberships were rejected ({})",
                    auth_rejections.join(", ")
                );
            }

            return Ok(AuthSessionSet {
                default_workspace_id: resolve_default_workspace_id(
                    default_hint.as_deref(),
                    &memberships,
                ),
                memberships,
            });
        }

        self.startup_single_session_set_from_sources(
            requested_name,
            strict_name,
            agent_type,
            identity_key,
        )
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
                    .register_agent_with_workspace_key(
                        &api_key,
                        Some(agent_name),
                        false,
                        None,
                        agent_identity_key().as_deref(),
                    )
                    .await
                    .context("failed to re-register after rotate-token 404")?;
                let mut session =
                    self.finish_session(api_key, Some(cached.workspace_id.clone()), registration)?;
                session.credentials.workspace_alias = cached.workspace_alias.clone();
                Ok(session)
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

        let relay = build_relay_client(&api_key, self.base_url.as_deref())?;
        let result = relay
            .rotate_agent_token(agent_name)
            .await
            .map_err(relay_error_to_anyhow)?;
        let token = result.token;

        let creds = CredentialCache {
            workspace_id: cached.workspace_id.clone(),
            workspace_alias: cached.workspace_alias.clone(),
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

    async fn startup_single_session_set_from_sources(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
        identity_key: Option<&str>,
    ) -> Result<AuthSessionSet> {
        let env_workspace_key = env_workspace_key()?;

        let mut workspace_id_hint: Option<String> = None;

        let mut candidates: Vec<EnvWorkspaceKey> = Vec::new();
        if let Some(key) = env_workspace_key {
            candidates.push(key);
        }

        let mut attempted_fresh_workspace = false;
        if candidates.is_empty() {
            let ws_name = deterministic_workspace_name();
            let (workspace_id, api_key) = self.create_workspace(&ws_name).await?;
            workspace_id_hint = Some(workspace_id);
            candidates.push(EnvWorkspaceKey {
                source: "fresh",
                key: api_key,
                explicit_join: false,
            });
            attempted_fresh_workspace = true;
        }

        let preferred_name = requested_name;
        let mut auth_rejections = Vec::new();

        for candidate in &candidates {
            tracing::info!(
                target = "relay_broker::auth",
                source = %candidate.source,
                preferred_name = ?preferred_name,
                strict_name = %strict_name,
                agent_type = ?agent_type,
                "attempting registration with workspace key"
            );
            match self
                .register_agent_with_workspace_key(
                    &candidate.key,
                    preferred_name,
                    strict_name,
                    agent_type,
                    identity_key,
                )
                .await
            {
                Ok(registration) => {
                    tracing::info!(
                        target = "relay_broker::auth",
                        agent_id = %registration.0,
                        returned_name = %registration.1,
                        "registration succeeded"
                    );
                    let session = self.finish_session(
                        candidate.key.clone(),
                        workspace_id_hint.clone(),
                        registration,
                    )?;
                    return Ok(AuthSessionSet {
                        default_workspace_id: Some(session.credentials.workspace_id.clone()),
                        memberships: vec![session],
                    });
                }
                Err(error) if is_auth_rejection(&error) => {
                    if candidate.explicit_join {
                        return Err(error).context(format!(
                            "explicit workspace key from {} was rejected",
                            candidate.source
                        ));
                    }
                    auth_rejections.push(format!("{} key rejected", candidate.source));
                }
                Err(error) if is_rate_limited(&error) => {
                    if candidate.explicit_join {
                        return Err(error).context(format!(
                            "explicit workspace key from {} was rate-limited",
                            candidate.source
                        ));
                    }
                    auth_rejections.push(format!("{} key rate-limited", candidate.source));
                }
                Err(error) => {
                    return Err(error).context(format!(
                        "failed registering agent with {} workspace key",
                        candidate.source
                    ));
                }
            }
        }

        if !attempted_fresh_workspace {
            let ws_name = deterministic_workspace_name();
            let (workspace_id, api_key) = self.create_workspace(&ws_name).await?;
            workspace_id_hint = Some(workspace_id);
            match self
                .register_agent_with_workspace_key(
                    &api_key,
                    preferred_name,
                    strict_name,
                    agent_type,
                    identity_key,
                )
                .await
            {
                Ok(registration) => {
                    let session = self.finish_session(api_key, workspace_id_hint, registration)?;
                    return Ok(AuthSessionSet {
                        default_workspace_id: Some(session.credentials.workspace_id.clone()),
                        memberships: vec![session],
                    });
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

    fn load_workspace_sources_from_env(
        &self,
    ) -> Result<Option<(Vec<WorkspaceSource>, Option<String>)>> {
        let Ok(raw) = std::env::var("RELAY_WORKSPACES_JSON") else {
            return Ok(None);
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        let value: Value =
            serde_json::from_str(trimmed).context("RELAY_WORKSPACES_JSON must be valid JSON")?;
        let default_hint = std::env::var("RELAY_DEFAULT_WORKSPACE")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                value
                    .get("default_workspace_id")
                    .or_else(|| value.get("defaultWorkspaceId"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            });

        let membership_values = if let Some(arr) = value.as_array() {
            arr.clone()
        } else if let Some(arr) = value.get("memberships").and_then(Value::as_array).cloned() {
            arr
        } else {
            vec![value]
        };

        let mut sources = Vec::with_capacity(membership_values.len());
        for membership in membership_values {
            if let Ok(source) = serde_json::from_value::<WorkspaceSource>(membership.clone()) {
                sources.push(source);
                continue;
            }
            if let Ok(credential) = serde_json::from_value::<WorkspaceCredential>(membership) {
                sources.push(WorkspaceSource {
                    workspace_id: Some(credential.workspace_id),
                    workspace_alias: credential.workspace_alias,
                    api_key: credential.api_key,
                });
                continue;
            }
            anyhow::bail!("RELAY_WORKSPACES_JSON contains an invalid membership entry");
        }

        if sources.is_empty() {
            anyhow::bail!("RELAY_WORKSPACES_JSON must contain at least one membership");
        }

        Ok(Some((sources, default_hint)))
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
            workspace_alias: None,
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
        match RelayCast::create_workspace(name, self.base_url.as_deref()).await {
            Ok(result) => Ok((result.workspace_id, result.api_key)),
            Err(error) if is_workspace_name_conflict(&error) => {
                let suffix = Uuid::new_v4().simple().to_string();
                let fallback_name = format!("{name}-{}", &suffix[..8]);
                tracing::warn!(
                    workspace_name = %name,
                    fallback_name = %fallback_name,
                    "workspace already exists; retrying with a fresh fallback name"
                );
                let result = RelayCast::create_workspace(&fallback_name, self.base_url.as_deref())
                    .await
                    .map_err(relay_error_to_anyhow)?;
                Ok((result.workspace_id, result.api_key))
            }
            Err(error) => Err(relay_error_to_anyhow(error)),
        }
    }

    /// `strict_name` is retained purely for API/logging compatibility with
    /// callers (`crates/broker/src/runtime/session.rs` chooses it based on
    /// `RELAY_STRICT_AGENT_NAME`) and no longer selects a different collision
    /// strategy: both modes route through `admit_agent_registration`. Their
    /// prior divergence — strict silently handed over the incumbent's token,
    /// non-strict silently minted a `-suffix` sibling — was itself the
    /// spawn-admission defect (see `admit_agent_registration`).
    async fn register_agent_with_workspace_key(
        &self,
        workspace_key: &str,
        requested_name: Option<&str>,
        _strict_name: bool,
        agent_type: Option<&str>,
        identity_key: Option<&str>,
    ) -> Result<(String, String, String, Option<String>)> {
        let relay = build_relay_client(workspace_key, self.base_url.as_deref())?;
        let name = requested_name
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("agent-{}", Uuid::new_v4().simple()));

        admit_agent_registration(&relay, &name, agent_type, identity_key).await
    }

    pub async fn workspace_key_is_live(&self, workspace_key: &str) -> Result<bool> {
        let Some(workspace_key) = normalize_workspace_key(workspace_key) else {
            return Ok(false);
        };
        let relay = match build_relay_client(&workspace_key, self.base_url.as_deref()) {
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

fn resolve_default_workspace_id(
    selector: Option<&str>,
    memberships: &[AuthSession],
) -> Option<String> {
    if let Some(selector) = selector.map(str::trim).filter(|value| !value.is_empty()) {
        return memberships.iter().find_map(|session| {
            if session.credentials.workspace_id == selector
                || session
                    .credentials
                    .workspace_alias
                    .as_deref()
                    .is_some_and(|alias| alias.eq_ignore_ascii_case(selector))
            {
                Some(session.credentials.workspace_id.clone())
            } else {
                None
            }
        });
    }

    if memberships.len() == 1 {
        memberships
            .first()
            .map(|session| session.credentials.workspace_id.clone())
    } else {
        None
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

fn env_workspace_key() -> Result<Option<EnvWorkspaceKey>> {
    for name in ["AGENT_RELAY_WORKSPACE_KEY", "RELAY_WORKSPACE_KEY"] {
        if let Ok(raw) = std::env::var(name) {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let key = normalize_workspace_key(trimmed)
                .with_context(|| format!("{name} is not a valid workspace key"))?;
            return Ok(Some(EnvWorkspaceKey {
                source: name,
                key,
                explicit_join: true,
            }));
        }
    }

    Ok(std::env::var("RELAY_API_KEY")
        .ok()
        .and_then(|value| normalize_workspace_key(&value))
        .map(|key| EnvWorkspaceKey {
            source: "RELAY_API_KEY",
            key,
            explicit_join: false,
        }))
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

/// Build a `RelayCast` workspace client from an API key and optional base URL.
/// When `base_url` is `None`, the SDK applies its own default.
fn build_relay_client(api_key: &str, base_url: Option<&str>) -> Result<RelayCast> {
    let mut opts =
        RelayCastOptions::new(api_key).with_origin_actor(crate::telemetry::BROKER_ORIGIN_ACTOR);
    if let Some(distinct_id) = crate::telemetry::agent_relay_distinct_id() {
        opts = opts.with_agent_relay_distinct_id(distinct_id);
    }
    if let Some(base_url) = base_url {
        opts = opts.with_base_url(base_url);
    }
    RelayCast::new(opts).map_err(|e| anyhow::anyhow!("{e}"))
}

/// Convert a `RelayError` into an `anyhow::Error`, preserving the HTTP status
/// and server-supplied error code so that `is_auth_rejection`, `is_not_found`,
/// `is_rate_limited`, and `is_agent_token_invalid_anyhow` still work.
fn relay_error_to_anyhow(error: RelayError) -> anyhow::Error {
    match &error {
        RelayError::Api {
            status,
            message,
            code,
        } => anyhow::Error::new(AuthHttpError {
            status: StatusCode::from_u16(*status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message: message.clone(),
            code: {
                let trimmed = code.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            },
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

/// Metadata key an agent's identity proof is stamped under at registration,
/// so a later collision can check it back. See `admit_agent_registration`.
const IDENTITY_METADATA_KEY: &str = "identity_key";

/// Caller-supplied proof of work-unit identity for spawn-admission reclaim.
///
/// A crashed (or resumed) work unit that needs to re-register under its
/// prior name sets this to a value stable across that work unit's restarts.
/// It gets stamped onto the agent's metadata at creation; a later collision
/// under the same name is only treated as a reclaim of that SAME work unit
/// if the value presented then matches what's stored — never by the name
/// string alone. Absent, registration cannot reclaim on collision.
pub(crate) fn agent_identity_key() -> Option<String> {
    std::env::var("RELAY_AGENT_IDENTITY_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Stable per-node identity proof derived from the broker's own persisted
/// state directory, for the ONE caller (the broker's own startup
/// registration) that needs restart-reclaim without an operator having to
/// set `RELAY_AGENT_IDENTITY_KEY` by hand. The same project/state directory
/// always hashes to the same value across a kill + restart, while a
/// different project (or a different, unrelated agent) hashes to something
/// else — so it participates in the same fail-closed identity check as any
/// other identity key, never bypassing it.
pub(crate) fn stable_node_identity_key(state_path: &std::path::Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(state_path.to_string_lossy().as_bytes());
    format!("node-{:x}", hasher.finalize())
}

/// One-way verifier stored in place of a caller's raw identity key.
///
/// `admit_agent_registration` stamps this (never the raw key) onto the
/// agent's metadata. Metadata is readable by any caller holding the same
/// workspace key (`get_agent` returns it), so storing the raw key there
/// would let any workspace member replay it verbatim to reclaim another
/// work unit's credentials — the identity check would authenticate nothing.
/// Hashing keeps the credential-bearing capability confined to whoever
/// starts with the original key.
fn hash_identity_key(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Single spawn-admission decision shared by every registration path
/// (formerly split between a strict branch that always reclaimed a
/// name-collision via `register_or_get_agent` — handing the caller the
/// incumbent's id, name, AND bearer token — and a non-strict branch that
/// silently minted a `-{uuid8}` sibling name once before failing). Both
/// were the same defect: a spawn-admission gate that doesn't verify who is
/// asking. This repo's doctrine is a dispatch gate fails closed, so a name
/// collision is REJECTED by default. A silent suffix would have produced a
/// second agent doing duplicate work under a near-identical name — exactly
/// the AR-448 duplicate-agent class this gate exists to stop — so it is not
/// an acceptable alternative to rejection either.
///
/// Reclaim (return the existing agent's identity with a freshly rotated
/// token, so a crashed broker's resume path keeps working) is permitted
/// ONLY when the registration request proves it is the same work unit: the
/// caller-supplied `identity_key` (see `agent_identity_key` and
/// `stable_node_identity_key`) must match the identity key stamped on the
/// existing agent's metadata at its own creation — compared by hash
/// (`hash_identity_key`), never by raw value, since metadata is readable by
/// any caller with the workspace key. Absent or mismatched identity on a
/// collision is rejected.
async fn admit_agent_registration(
    relay: &RelayCast,
    name: &str,
    agent_type: Option<&str>,
    identity_key: Option<&str>,
) -> Result<(String, String, String, Option<String>)> {
    let metadata = identity_key.map(|key| {
        let mut map = serde_json::Map::new();
        map.insert(
            IDENTITY_METADATA_KEY.to_string(),
            Value::String(hash_identity_key(key)),
        );
        map
    });

    let request = CreateAgentRequest {
        name: name.to_string(),
        agent_type: Some(agent_type.unwrap_or("agent").to_string()),
        persona: None,
        metadata,
    };

    match relay.register_agent(request).await {
        Ok(result) => Ok((result.id, result.name, result.token, result.workspace_id)),
        Err(RelayError::Api { code, status, .. }) if is_conflict_code(&code) || status == 409 => {
            let existing = relay.get_agent(name).await.map_err(relay_error_to_anyhow)?;
            let existing_identity = existing
                .metadata
                .get(IDENTITY_METADATA_KEY)
                .and_then(Value::as_str);

            let reclaims_same_work_unit = matches!(
                (identity_key, existing_identity),
                (Some(ours), Some(theirs)) if hash_identity_key(ours) == theirs
            );

            if !reclaims_same_work_unit {
                return Err(relay_error_to_anyhow(RelayError::Api {
                    code: "agent_identity_mismatch".to_string(),
                    status: 409,
                    message: format!(
                        "agent name '{name}' is already registered and this registration did \
                         not prove ownership of that identity; refusing to hand over its \
                         credentials (set RELAY_AGENT_IDENTITY_KEY to the original work unit's \
                         identity to reclaim it after a crash)"
                    ),
                }));
            }

            let token_response = relay
                .rotate_agent_token(&existing.name)
                .await
                .map_err(relay_error_to_anyhow)?;
            Ok((
                existing.id,
                existing.name,
                token_response.token,
                existing.workspace_id,
            ))
        }
        Err(RelayError::Api {
            code,
            status,
            message,
        }) if is_agent_token_invalid_code(&code)
            || (status == 401 && message.trim() == AGENT_TOKEN_INVALID_MESSAGE) =>
        {
            // Surface the typed code even when only the legacy status+message
            // pair is present, so downstream callers can react with
            // `is_agent_token_invalid_anyhow`.
            Err(relay_error_to_anyhow(RelayError::Api {
                code: AGENT_TOKEN_INVALID_CODE.to_string(),
                status,
                message,
            }))
        }
        Err(error) => Err(relay_error_to_anyhow(error)),
    }
}

fn is_workspace_name_conflict(error: &RelayError) -> bool {
    match error {
        RelayError::Api {
            code,
            message,
            status,
        } => {
            *status == 409
                || is_conflict_code(code)
                || message.to_ascii_lowercase().contains("already exists")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    // These tests intentionally hold the process-env mutex across awaits so
    // concurrent async tests cannot mutate RELAY_* variables underneath each
    // other.
    #![allow(clippy::await_holding_lock)]

    use std::sync::{Mutex, MutexGuard};

    use httpmock::Method::{GET, POST};
    use httpmock::MockServer;
    use serde_json::json;

    use super::{
        hash_identity_key, is_agent_token_invalid, is_agent_token_invalid_anyhow,
        is_agent_token_invalid_code, relay_error_to_anyhow, stable_node_identity_key, AuthClient,
        CredentialCache, AGENT_TOKEN_INVALID_CODE,
    };
    use relaycast::RelayError;

    static RELAY_ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn agent_token_invalid_code_matches_canonical_string_case_insensitively() {
        assert!(is_agent_token_invalid_code(AGENT_TOKEN_INVALID_CODE));
        assert!(is_agent_token_invalid_code("AGENT_TOKEN_INVALID"));
        assert!(!is_agent_token_invalid_code("unauthorized"));
    }

    #[test]
    fn agent_token_invalid_code_tolerates_surrounding_whitespace() {
        assert!(is_agent_token_invalid_code("  agent_token_invalid  "));
        assert!(is_agent_token_invalid_code("\tagent_token_invalid\n"));
    }

    #[test]
    fn anyhow_helper_normalizes_codes_with_surrounding_whitespace() {
        let err = relay_error_to_anyhow(RelayError::Api {
            code: "  agent_token_invalid  ".to_string(),
            status: 401,
            message: "Invalid agent token".to_string(),
        });
        assert!(is_agent_token_invalid_anyhow(&err));
    }

    #[test]
    fn agent_token_invalid_relay_error_detected_via_code_or_legacy_pair() {
        let typed = RelayError::Api {
            code: AGENT_TOKEN_INVALID_CODE.to_string(),
            status: 401,
            message: "anything".to_string(),
        };
        assert!(is_agent_token_invalid(&typed));

        let legacy = RelayError::Api {
            code: "unauthorized".to_string(),
            status: 401,
            message: "Invalid agent token".to_string(),
        };
        assert!(is_agent_token_invalid(&legacy));

        let unrelated = RelayError::Api {
            code: "unauthorized".to_string(),
            status: 401,
            message: "bad workspace key".to_string(),
        };
        assert!(!is_agent_token_invalid(&unrelated));
    }

    #[test]
    fn anyhow_helper_survives_relay_error_to_anyhow_conversion() {
        let err = relay_error_to_anyhow(RelayError::Api {
            code: AGENT_TOKEN_INVALID_CODE.to_string(),
            status: 401,
            message: "Invalid agent token".to_string(),
        });
        assert!(is_agent_token_invalid_anyhow(&err));

        let legacy = relay_error_to_anyhow(RelayError::Api {
            code: String::new(),
            status: 401,
            message: "Invalid agent token".to_string(),
        });
        assert!(is_agent_token_invalid_anyhow(&legacy));

        let unrelated = relay_error_to_anyhow(RelayError::Api {
            code: "agent_already_exists".to_string(),
            status: 409,
            message: "name taken".to_string(),
        });
        assert!(!is_agent_token_invalid_anyhow(&unrelated));
    }

    /// Remove RELAY_API_KEY from the environment so it doesn't interfere with
    /// mock-server tests. Tests use httpmock and only set up specific auth
    /// headers — the real env key causes 404s against the mock.
    fn clear_relay_env() -> MutexGuard<'static, ()> {
        let guard = RELAY_ENV_MUTEX.lock().unwrap();
        // SAFETY: test-only; Rust warns about remove_var in multi-threaded
        // contexts but we accept the risk in test code.
        unsafe {
            std::env::remove_var("AGENT_RELAY_WORKSPACE_KEY");
            std::env::remove_var("RELAY_WORKSPACE_KEY");
            std::env::remove_var("RELAY_API_KEY");
            std::env::remove_var("RELAY_WORKSPACES_JSON");
            std::env::remove_var("RELAY_DEFAULT_WORKSPACE");
            std::env::remove_var("RELAY_AGENT_IDENTITY_KEY");
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

        let client = AuthClient::new(Some(server.base_url()));

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
            std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", "rk_live_env");
        }
        // The register response now carries workspace_id, so a join-by-key
        // session records the real workspace instead of the "ws_unknown"
        // fallback — no extra lookup required.
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_env");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a2","workspace_id":"ws_env","name":"lead","token":"at_live_2","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));

        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.token, "at_live_2");
        assert_eq!(session.credentials.api_key, "rk_live_env");
        assert_eq!(session.credentials.workspace_id, "ws_env");
        register.assert_hits(1);

        unsafe {
            std::env::remove_var("AGENT_RELAY_WORKSPACE_KEY");
        }
    }

    #[tokio::test]
    async fn rejected_explicit_workspace_key_does_not_create_workspace() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", "rk_live_rejected");
        }
        let rejected_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_rejected");
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

        let client = AuthClient::new(Some(server.base_url()));
        let error = client.startup_session(Some("lead")).await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("explicit workspace key from AGENT_RELAY_WORKSPACE_KEY was rejected"),
            "unexpected error: {error:#}"
        );
        rejected_register.assert_hits(1);
        workspace.assert_hits(0);

        unsafe {
            std::env::remove_var("AGENT_RELAY_WORKSPACE_KEY");
        }
    }

    #[tokio::test]
    async fn canonical_workspace_key_takes_precedence_over_legacy_api_key() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", "rk_live_canonical");
            std::env::set_var("RELAY_API_KEY", "rk_live_legacy");
        }
        let canonical_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_canonical");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a2","name":"lead","token":"at_live_2","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });
        let legacy_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_legacy");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a3","name":"lead","token":"at_live_3","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));
        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.credentials.api_key, "rk_live_canonical");
        canonical_register.assert_hits(1);
        legacy_register.assert_hits(0);

        unsafe {
            std::env::remove_var("AGENT_RELAY_WORKSPACE_KEY");
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    #[tokio::test]
    async fn legacy_relay_api_key_still_joins_existing_workspace() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_legacy");
        }
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_legacy");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a2","name":"lead","token":"at_live_2","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));

        let session = client.startup_session(Some("lead")).await.unwrap();
        assert_eq!(session.credentials.api_key, "rk_live_legacy");
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

        let client = AuthClient::new(Some(server.base_url()));
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
    async fn strict_name_conflict_without_identity_proof_is_rejected_not_handed_incumbent_token() {
        // Spawn-admission gate regression test: a bare name collision must
        // never hand the caller the incumbent agent's token. Reclaim is only
        // permitted when the caller proves the same work-unit identity (see
        // `admit_agent_registration`); presenting the same name string alone
        // must be rejected, not silently reclaimed.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
        }
        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(json!({
                    "name": "lead",
                    "type": "agent"
                }));
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"name":"lead","token":"at_live_rotated"}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));
        let result = client
            .startup_session_with_options(Some("lead"), true, None)
            .await;

        assert!(
            result.is_err(),
            "a name collision with no proof of matching identity must be rejected, not reclaimed"
        );
        let message = result.unwrap_err().to_string();
        assert!(
            !message.contains("at_live_rotated"),
            "rejection must not leak the incumbent's rotated token: {message}"
        );
        conflict.assert_hits(1);
        get_existing.assert_hits(1);
        rotate.assert_hits(0);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    #[tokio::test]
    async fn strict_name_conflict_with_matching_identity_reclaims_existing_agent() {
        // Crash-recovery resume: the SAME work unit re-registers under the
        // same name and proves it via RELAY_AGENT_IDENTITY_KEY matching what
        // was stamped on the agent at its original creation. This must still
        // reclaim the agent (and rotate its token) rather than being rejected.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
            std::env::set_var("RELAY_AGENT_IDENTITY_KEY", "work-unit-42");
        }
        // The identity proof is stored (and matched) as a one-way hash, never
        // the raw value: metadata is readable by any caller with the same
        // workspace key, so a raw value there would let a co-tenant replay it.
        let identity_hash = hash_identity_key("work-unit-42");
        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(json!({
                    "name": "lead",
                    "type": "agent",
                    "metadata": { "identity_key": identity_hash }
                }));
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{identity_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"name":"lead","token":"at_live_rotated"}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));
        let session = client
            .startup_session_with_options(Some("lead"), true, None)
            .await
            .expect("matching identity proof should reclaim the existing agent");

        assert_eq!(session.token, "at_live_rotated");
        assert_eq!(session.credentials.agent_id, "a_existing");
        conflict.assert_hits(1);
        get_existing.assert_hits(1);
        rotate.assert_hits(1);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
            std::env::remove_var("RELAY_AGENT_IDENTITY_KEY");
        }
    }

    #[test]
    fn stable_node_identity_key_is_stable_per_state_path() {
        use std::path::Path;
        // Same project/state directory (the "same work unit" across a kill +
        // restart, per the fleet node harness) must hash identically every
        // time, or the broker could never reclaim its own name after a crash.
        let a = stable_node_identity_key(Path::new("/tmp/node-a/.agentworkforce/relay/state.json"));
        let a_again =
            stable_node_identity_key(Path::new("/tmp/node-a/.agentworkforce/relay/state.json"));
        assert_eq!(a, a_again);

        // A different project/state directory (a genuinely different node)
        // must hash to something else, or two unrelated nodes could reclaim
        // each other's registrations.
        let b = stable_node_identity_key(Path::new("/tmp/node-b/.agentworkforce/relay/state.json"));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn node_restart_reclaims_its_own_prior_registration_via_stable_identity() {
        // Regression test for the fleet-matrix restart flake this PR's
        // fail-closed change introduced: `agent-relay node up` on a restart
        // reuses the same `--broker-name`, and nothing sets
        // RELAY_AGENT_IDENTITY_KEY for it — so before `connect_relay` passed
        // a stable, path-derived identity, a restart before the stale
        // registration was reaped collided on name and was rejected outright,
        // and the node never came back online. This exercises the exact
        // entry point `connect_relay` calls (`startup_session_set_with_identity`)
        // with no env var set, proving the derived identity alone is enough
        // to reclaim.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
        }
        let stable_identity = stable_node_identity_key(std::path::Path::new(
            "/tmp/node-a/.agentworkforce/relay/state.json",
        ));
        let identity_hash = hash_identity_key(&stable_identity);
        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(json!({
                    "name": "node-a",
                    "type": "agent",
                    "metadata": { "identity_key": identity_hash }
                }));
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/node-a")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_existing","name":"node-a","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{identity_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/node-a/rotate-token")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"name":"node-a","token":"at_live_rotated"}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));
        let session = client
            .startup_session_set_with_identity(Some("node-a"), true, None, Some(&stable_identity))
            .await
            .expect("a node restarting under its own stable identity must reclaim, not be rejected")
            .default_session()
            .cloned()
            .expect("a session was registered");

        assert_eq!(session.token, "at_live_rotated");
        assert_eq!(session.credentials.agent_id, "a_existing");
        conflict.assert_hits(1);
        get_existing.assert_hits(1);
        rotate.assert_hits(1);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    #[tokio::test]
    async fn different_stable_identity_does_not_reclaim_a_same_named_agent() {
        // The flip side of the restart-reclaim fix: a DIFFERENT node (a
        // different state directory, hence a different derived identity)
        // that happens to collide on name must still be rejected — the
        // fail-closed gate this PR added must not be silently defeated by
        // handing every node an automatic pass on collision.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
        }
        let our_identity = stable_node_identity_key(std::path::Path::new(
            "/tmp/node-a/.agentworkforce/relay/state.json",
        ));
        let their_identity_hash = hash_identity_key(&stable_node_identity_key(
            std::path::Path::new("/tmp/node-a-impostor/.agentworkforce/relay/state.json"),
        ));
        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_shared");
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/node-a")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_existing","name":"node-a","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{their_identity_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });

        let client = AuthClient::new(Some(server.base_url()));
        let error = client
            .startup_session_set_with_identity(Some("node-a"), true, None, Some(&our_identity))
            .await
            .expect_err("a mismatched identity on collision must be rejected, not reclaimed");

        // `to_string()` on an anyhow::Error only shows the outermost context
        // layer; walk the full chain for the admission-gate's own message.
        assert!(
            error
                .chain()
                .any(|layer| layer.to_string().contains("did not prove ownership")),
            "expected an ownership-mismatch rejection, got: {error:#}"
        );
        conflict.assert_hits(1);
        get_existing.assert_hits(1);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    #[tokio::test]
    async fn non_strict_name_conflict_without_identity_proof_is_rejected() {
        // Strict and non-strict registration must agree: the divergence
        // between an always-reclaiming strict path and a silently-suffixing
        // non-strict path WAS the defect (a silent suffix mints a duplicate
        // agent under a near-identical name, the same AR-448 class a bare
        // handover produces). Both now route through the same fail-closed
        // admission decision.
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
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));
        let result = client.startup_session(Some("lead")).await;

        assert!(
            result.is_err(),
            "non-strict registration must also reject an unproven name collision, not mint a silent -suffix sibling"
        );
        workspace.assert_hits(1);
        conflict.assert_hits(1);
        get_existing.assert_hits(1);
    }

    // `strict_name_conflict_reclaims_via_sdk_register_or_get_agent` (issue
    // #797) and `default_name_conflict_retries_with_suffix_once` used to live
    // here. Both encoded the spawn-admission defect as intended behavior —
    // an unconditional reclaim-on-collision, and a silent `-{uuid8}`
    // suffix-on-collision, respectively. They're superseded by
    // `strict_name_conflict_without_identity_proof_is_rejected_not_handed_incumbent_token`,
    // `strict_name_conflict_with_matching_identity_reclaims_existing_agent`,
    // and `non_strict_name_conflict_without_identity_proof_is_rejected` above,
    // which assert the fixed fail-closed contract instead.

    #[tokio::test]
    async fn workspace_name_conflict_retries_with_fresh_suffix() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let workspace_name = super::deterministic_workspace_name();
        let first_conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/workspaces")
                .json_body(json!({ "name": workspace_name }));
            then.status(409)
                .header("content-type", "application/json")
                .body(
                    r#"{"ok":false,"error":{"code":"workspace_already_exists","message":"Workspace already exists"}}"#,
                );
        });
        let second_workspace = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/workspaces")
                .body_contains(format!("\"name\":\"{workspace_name}-"));
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_fallback","api_key":"rk_live_fallback","created_at":"2025-01-01T00:00:00Z"}}"#);
        });
        let register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_fallback");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_fallback","name":"lead","token":"at_live_fallback","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));
        let session = client.startup_session(Some("lead")).await.unwrap();

        assert_eq!(session.token, "at_live_fallback");
        assert_eq!(session.credentials.api_key, "rk_live_fallback");
        assert_eq!(session.credentials.workspace_id, "ws_fallback");
        first_conflict.assert_hits(1);
        second_workspace.assert_hits(1);
        register.assert_hits(1);
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

        let client = AuthClient::new(Some(server.base_url()));

        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            workspace_alias: None,
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

        let client = AuthClient::new(Some(server.base_url()));

        let cached = CredentialCache {
            workspace_id: "ws_cached".into(),
            workspace_alias: None,
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
        let client = AuthClient::new(Some(server.base_url()));

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
        let client = AuthClient::new(Some(server.base_url()));

        let live = client
            .workspace_key_is_live("rk_live_cached")
            .await
            .unwrap();
        assert!(!live);
        channels.assert_hits(1);
    }

    #[test]
    fn deterministic_workspace_name_is_stable() {
        let a = super::deterministic_workspace_name();
        let b = super::deterministic_workspace_name();
        assert_eq!(a, b);
        assert!(a.starts_with("relay-"));
        assert_eq!(a.len(), "relay-".len() + 8);
    }

    #[test]
    fn workspace_key_normalization_accepts_rk_prefixes() {
        assert_eq!(
            super::normalize_workspace_key(" rk_test_123 "),
            Some("rk_test_123".to_string())
        );
        assert_eq!(super::normalize_workspace_key("at_live_1"), None);
    }

    /// 403 Forbidden behaves identically to 401 Unauthorized — the env key
    /// should be soft-rejected and a fresh workspace created.
    #[tokio::test]
    async fn forbidden_env_key_falls_back_to_fresh_workspace() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let _forbidden_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_forbidden");
            then.status(403)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"forbidden","message":"forbidden"}}"#);
        });
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_fresh","api_key":"rk_live_fresh","created_at":"2025-01-01T00:00:00Z"}}"#);
        });
        let fresh_register = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_fresh");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a10","name":"broker","token":"at_live_10","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_forbidden");
        }

        let client = AuthClient::new(Some(server.base_url()));
        let session = client.startup_session(Some("broker")).await.unwrap();

        // Must return the FRESH workspace key, not the forbidden env key.
        assert_eq!(session.credentials.api_key, "rk_live_fresh");
        assert_eq!(session.credentials.workspace_id, "ws_fresh");
        assert_eq!(session.token, "at_live_10");
        workspace.assert_hits(1);
        fresh_register.assert_hits(1);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    /// When the env key is rejected and the broker falls back to a fresh
    /// workspace, the session's api_key MUST be the fresh key — not the stale
    /// env key. This is the exact scenario that caused workers to receive an
    /// incorrect RELAY_API_KEY and fail MCP authentication.
    #[tokio::test]
    async fn session_api_key_is_never_the_rejected_env_key() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let stale_key = "rk_live_stale_must_not_appear_in_session";
        server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", format!("Bearer {stale_key}"));
            then.status(401)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"unauthorized","message":"unauthorized"}}"#);
        });
        server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"workspace_id":"ws_ok","api_key":"rk_live_correct","created_at":"2025-01-01T00:00:00Z"}}"#);
        });
        server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_correct");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a11","name":"broker","token":"at_live_11","status":"online","created_at":"2025-01-01T00:00:00Z"}}"#);
        });

        unsafe {
            std::env::set_var("RELAY_API_KEY", stale_key);
        }

        let client = AuthClient::new(Some(server.base_url()));
        let session = client.startup_session(Some("broker")).await.unwrap();

        // The stale env key must NEVER appear in the returned session.
        assert_ne!(
            session.credentials.api_key, stale_key,
            "session must not use the rejected env key — workers would get wrong RELAY_API_KEY"
        );
        assert_eq!(session.credentials.api_key, "rk_live_correct");

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }
}
