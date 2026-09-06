use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use relaycast::{
    CreateAgentRequest, RelayCast, RelayCastOptions, RelayError, TakeOverAgentRequest,
    WorkspaceProvenance,
};
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
            ..
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

        // Rotation is authenticated as the agent itself (relaycast 7.0.0): it
        // needs this agent's current token, not the workspace key. Without a
        // cached token there is nothing to roll over, and silently falling back
        // to the workspace key is what used to fail as an opaque 401.
        let agent_token = cached.agent_token.as_deref().context(
            "cannot rotate token without the agent's current token; re-register or recover the identity",
        )?;
        let relay = build_relay_client(&api_key, self.base_url.as_deref())?;
        let result = relay
            .rotate_agent_token(agent_name, agent_token)
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
        match RelayCast::create_workspace(
            name,
            self.base_url.as_deref(),
            WorkspaceProvenance::sdk(),
        )
        .await
        {
            Ok(result) => Ok((result.workspace_id, result.api_key)),
            Err(error) if is_workspace_name_conflict(&error) => {
                let suffix = Uuid::new_v4().simple().to_string();
                let fallback_name = format!("{name}-{}", &suffix[..8]);
                tracing::warn!(
                    workspace_name = %name,
                    fallback_name = %fallback_name,
                    "workspace already exists; retrying with a fresh fallback name"
                );
                let result = RelayCast::create_workspace(
                    &fallback_name,
                    self.base_url.as_deref(),
                    WorkspaceProvenance::sdk(),
                )
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

        admit_agent_registration(&relay, workspace_key, &name, agent_type, identity_key).await
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

const DEFAULT_RELAYCAST_BASE_URL: &str = "https://cast.agentrelay.com";
const RELAYCAST_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

async fn relay_request_with_timeout<T>(
    timeout_window: std::time::Duration,
    operation: &str,
    request: impl std::future::Future<Output = std::result::Result<T, RelayError>>,
) -> Result<T> {
    tokio::time::timeout(timeout_window, request)
        .await
        .with_context(|| format!("{operation} timed out after {timeout_window:?}"))?
        .map_err(relay_error_to_anyhow)
}

fn resolve_relaycast_base_url(base_url: Option<&str>) -> &str {
    base_url.unwrap_or(DEFAULT_RELAYCAST_BASE_URL)
}

/// Build a `RelayCast` workspace client from an API key and optional base URL.
/// Resolve the hosted default here so broker-owned HTTP calls can share the
/// exact same destination instead of duplicating the SDK's implicit choice.
fn build_relay_client(api_key: &str, base_url: Option<&str>) -> Result<RelayCast> {
    let mut opts = RelayCastOptions::new(api_key)
        .with_base_url(resolve_relaycast_base_url(base_url))
        .with_origin_actor(crate::telemetry::BROKER_ORIGIN_ACTOR);
    if let Some(distinct_id) = crate::telemetry::agent_relay_distinct_id() {
        opts = opts.with_agent_relay_distinct_id(distinct_id);
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
            ..
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

/// Non-secret diagnostic handle for an identity proof.
///
/// The raw proof is replayable and must never be printed. The stored verifier
/// is already a SHA-256 hash, so a short prefix of that verifier is sufficient
/// to correlate operator logs without disclosing credential material.
pub(crate) fn identity_key_fingerprint(raw: &str) -> String {
    hash_identity_key(raw).chars().take(12).collect()
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
    // Needed only for the pre-8.2.0 rotate fallback below, where the workspace
    // key is still an accepted credential for reclaiming an agent's token.
    workspace_key: &str,
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
                    request_id: None,
                    attempts: 1,
                }));
            }

            let identity_hash = hash_identity_key(
                identity_key.expect("matching identity proof was established above"),
            );

            // Reclaiming a crashed work unit's identity. We have proved the
            // work-unit key locally against the protected verifier on the
            // incumbent record, but Relaycast's `/recover` route cannot accept
            // that proof: it authorizes only a current agent token, the origin
            // node token, or a server-issued recovery credential. Sending the
            // workspace key there is rejected with
            // `agent_recovery_not_authorized` even when the verifier matches.
            //
            // A workspace owner replacing an identity whose current token was
            // lost uses `/takeover`, the explicit audited escape hatch added
            // alongside create-only registration. The local identity check
            // above remains the broker's fail-closed admission gate; takeover
            // is reached only after that proof matches.
            let token_response = relay
                .take_over_agent(
                    &existing.name,
                    TakeOverAgentRequest {
                        expected_agent_id: existing.id.clone(),
                        actor: format!("broker:{}", existing.name),
                        reason: "work-unit identity key proved ownership after a crash".to_string(),
                        // Hashed, never raw: the identity key is replayable and
                        // the audit record is workspace-readable.
                        session_ref: identity_hash,
                        node_id: std::env::var("RELAY_NODE_ID")
                            .ok()
                            .map(|value| value.trim().to_string())
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| existing.name.clone()),
                    },
                )
                .await;
            // Engines before 8.2.0 have no `/takeover` route — the identity
            // recovery surface arrived with it — and answer "Route not found".
            // Those engines still let the workspace key rotate an agent's
            // token, which is what this path did before, so fall back rather
            // than failing every node restart against an older engine. The
            // agent-specific 404 (`agent_not_found`) is a real failure and is
            // deliberately excluded.
            let token_response = match token_response {
                Ok(response) => response.token,
                Err(RelayError::Api {
                    status: 404,
                    ref code,
                    ..
                }) if code != "agent_not_found" => relay
                    .rotate_agent_token(&existing.name, workspace_key)
                    .await
                    .map_err(relay_error_to_anyhow)
                    .context(
                        "takeover unavailable on this engine and the legacy rotate fallback failed",
                    )?
                    .token,
                Err(error) => return Err(relay_error_to_anyhow(error)),
            };
            if token_response.trim().is_empty() {
                anyhow::bail!(
                    "audited takeover returned a blank token for agent '{}'",
                    existing.name
                );
            }
            Ok((
                existing.id,
                existing.name,
                token_response,
                existing.workspace_id,
            ))
        }
        Err(RelayError::Api {
            code,
            status,
            message,
            ..
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
                request_id: None,
                attempts: 1,
            }))
        }
        Err(error) => Err(relay_error_to_anyhow(error)),
    }
}

/// Outcome of a successful [`reclaim_legacy_identity`] call, returned as a
/// value (not just formatted text) so CLI output and tests can assert on it
/// precisely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LegacyIdentityClaim {
    pub(crate) agent_id: String,
    pub(crate) agent_name: String,
}

#[derive(Debug, Deserialize)]
struct LegacyIdentityClaimData {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct LegacyIdentityClaimError {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct LegacyIdentityClaimEnvelope {
    data: Option<LegacyIdentityClaimData>,
    error: Option<LegacyIdentityClaimError>,
}

/// Operator-invoked recovery for an agent record created before 5c2ad8ee3
/// ("reclaim a node's own registration across restart, hash the identity
/// proof") shipped. That commit's fail-closed match — `(Some(ours),
/// Some(theirs))` only — has no way to ever match for a record whose
/// `identity_key` was never stamped, because it predates the concept. Such a
/// record can never again reclaim its name via the ordinary
/// `admit_agent_registration` collision path: `existing_identity` reads
/// `None` forever, and `None` always falls through to rejection there.
///
/// This is deliberately NOT wired into the automatic reconnect path
/// (`admit_agent_registration` / `connect_relay`) — an automatic grandfather
/// clause there ("no identity stamped yet, so allow anyone in") would let
/// any workspace-key holder win a race to claim a legacy name the moment
/// this ships, permanently locking out the record's true owner and
/// reopening exactly the AR-448 hijack window 5c2ad8ee3 closed. Instead this
/// requires a deliberate, explicit operator action naming one specific
/// agent, so the exposure window is "an operator runs this once, promptly,
/// per legacy node" rather than "open to anyone, indefinitely, on every
/// future reconnect attempt."
///
/// Refuses (fails closed) when:
/// - the record already has a stamped `identity_key` — this path only
///   applies to a record that predates the gate; it must never be usable to
///   overwrite (and thereby silently reassign) an already-protected record.
/// - the record's `status` is anything other than `"offline"` — a fail-closed
///   defense against stamping an identity onto a record that may still be a
///   live, connected session or carries a future status unknown to this
///   broker.
///
/// On success, asks Relaycast's dedicated legacy-identity endpoint to stamp
/// `hash_identity_key(our_identity_key)`. The endpoint performs the
/// identity-absent check, offline-status check, and metadata mutation in one
/// atomic database UPDATE. There is deliberately no fallback to the generic
/// agent PATCH: older servers fail closed instead of reintroducing a
/// read-then-write race. Every success logs a distinct, greppable audit line.
pub(crate) async fn reclaim_legacy_identity(
    base_url: Option<&str>,
    workspace_key: &str,
    name: &str,
    our_identity_key: &str,
) -> Result<LegacyIdentityClaim> {
    let relaycast_base_url = resolve_relaycast_base_url(base_url);
    let relay = build_relay_client(workspace_key, Some(relaycast_base_url))?;
    let existing = relay_request_with_timeout(
        RELAYCAST_HTTP_TIMEOUT,
        &format!("fetching legacy agent '{name}' before identity recovery"),
        relay.get_agent(name),
    )
    .await?;

    if existing.metadata.contains_key(IDENTITY_METADATA_KEY) {
        anyhow::bail!(
            "agent '{name}' already has a stamped identity_key; this legacy-recovery path only \
             applies to a record that predates the identity-reclaim gate and must never \
             overwrite an already-protected record. If this node's own restarts are being \
             rejected, its identity no longer matches what's stamped on the record — \
             investigate that mismatch instead of forcing a new one over it."
        );
    }

    if !existing.status.eq_ignore_ascii_case("offline") {
        anyhow::bail!(
            "agent '{name}' does not report status 'offline' (reports '{}'); refusing to stamp \
             an identity \
             onto a record that may still be a live, connected session. Confirm it is actually \
             offline (or wait for it to go offline) before backfilling its identity.",
            existing.status
        );
    }

    let identity_key_hash = hash_identity_key(our_identity_key);
    let claim_url = format!(
        "{}/v1/agents/{}/legacy-identity",
        relaycast_base_url.trim_end_matches('/'),
        urlencoding::encode(name)
    );
    let response = reqwest::Client::builder()
        .timeout(RELAYCAST_HTTP_TIMEOUT)
        .build()
        .context("failed to build Relaycast legacy identity client")?
        .patch(&claim_url)
        .bearer_auth(workspace_key)
        .header(
            "X-Relaycast-Origin-Actor",
            crate::telemetry::BROKER_ORIGIN_ACTOR,
        )
        .json(&serde_json::json!({ "identity_key_hash": identity_key_hash }))
        .send()
        .await
        .context("failed to call Relaycast's atomic legacy identity endpoint")?;
    let status = response.status();
    let response_body = response
        .text()
        .await
        .context("failed to read Relaycast's atomic legacy identity response")?;
    let envelope = serde_json::from_str::<LegacyIdentityClaimEnvelope>(&response_body).ok();
    if !status.is_success() {
        let server_error = envelope.and_then(|body| body.error);
        let message = if status == StatusCode::NOT_FOUND {
            format!(
                "Relaycast did not accept the atomic legacy identity endpoint for agent \
                 '{name}'; refusing an unsafe generic PATCH fallback (deploy a Relaycast \
                 version with PATCH /v1/agents/:name/legacy-identity first)"
            )
        } else {
            server_error
                .as_ref()
                .map(|error| error.message.clone())
                .unwrap_or_else(|| {
                    format!("atomic legacy identity claim failed with HTTP {status}")
                })
        };
        return Err(anyhow::Error::new(AuthHttpError {
            status,
            message,
            code: server_error.map(|error| error.code),
        }));
    }
    let updated = envelope
        .and_then(|body| body.data)
        .context("Relaycast atomic legacy identity response did not include agent data")?;

    tracing::warn!(
        agent_name = %updated.name,
        agent_id = %updated.id,
        "legacy identity backfill: stamped a caller-derived identity onto a pre-gate agent \
         record that had no prior identity_key; if this was not an expected, operator-initiated \
         recovery, investigate immediately for a possible name hijack"
    );

    Ok(LegacyIdentityClaim {
        agent_id: updated.id,
        agent_name: updated.name,
    })
}

fn is_workspace_name_conflict(error: &RelayError) -> bool {
    match error {
        RelayError::Api {
            code,
            message,
            status,
            ..
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

    use httpmock::Method::{GET, PATCH, POST};
    use httpmock::MockServer;
    use serde_json::{json, Value};

    use super::{
        hash_identity_key, is_agent_token_invalid, is_agent_token_invalid_anyhow,
        is_agent_token_invalid_code, reclaim_legacy_identity, relay_error_to_anyhow,
        relay_request_with_timeout, resolve_relaycast_base_url, stable_node_identity_key,
        AuthClient, CredentialCache, AGENT_TOKEN_INVALID_CODE, DEFAULT_RELAYCAST_BASE_URL,
    };
    use relaycast::RelayError;

    static RELAY_ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn relaycast_base_url_resolver_preserves_overrides_and_owns_one_default() {
        assert_eq!(resolve_relaycast_base_url(None), DEFAULT_RELAYCAST_BASE_URL);
        assert_eq!(
            resolve_relaycast_base_url(Some("http://127.0.0.1:8787")),
            "http://127.0.0.1:8787"
        );
    }

    #[tokio::test]
    async fn relay_request_timeout_bounds_stalled_sdk_calls() {
        let error = relay_request_with_timeout(
            std::time::Duration::from_millis(1),
            "fetching a test agent",
            std::future::pending::<std::result::Result<(), RelayError>>(),
        )
        .await
        .expect_err("a request that never completes must time out");

        let message = format!("{error:#}");
        assert!(
            message.contains("fetching a test agent timed out"),
            "{message}"
        );
    }

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
            request_id: None,
            attempts: 1,
        });
        assert!(is_agent_token_invalid_anyhow(&err));
    }

    #[test]
    fn agent_token_invalid_relay_error_detected_via_code_or_legacy_pair() {
        let typed = RelayError::Api {
            code: AGENT_TOKEN_INVALID_CODE.to_string(),
            status: 401,
            message: "anything".to_string(),
            request_id: None,
            attempts: 1,
        };
        assert!(is_agent_token_invalid(&typed));

        let legacy = RelayError::Api {
            code: "unauthorized".to_string(),
            status: 401,
            message: "Invalid agent token".to_string(),
            request_id: None,
            attempts: 1,
        };
        assert!(is_agent_token_invalid(&legacy));

        let unrelated = RelayError::Api {
            code: "unauthorized".to_string(),
            status: 401,
            message: "bad workspace key".to_string(),
            request_id: None,
            attempts: 1,
        };
        assert!(!is_agent_token_invalid(&unrelated));
    }

    #[test]
    fn anyhow_helper_survives_relay_error_to_anyhow_conversion() {
        let err = relay_error_to_anyhow(RelayError::Api {
            code: AGENT_TOKEN_INVALID_CODE.to_string(),
            status: 401,
            message: "Invalid agent token".to_string(),
            request_id: None,
            attempts: 1,
        });
        assert!(is_agent_token_invalid_anyhow(&err));

        let legacy = relay_error_to_anyhow(RelayError::Api {
            code: String::new(),
            status: 401,
            message: "Invalid agent token".to_string(),
            request_id: None,
            attempts: 1,
        });
        assert!(is_agent_token_invalid_anyhow(&legacy));

        let unrelated = relay_error_to_anyhow(RelayError::Api {
            code: "agent_already_exists".to_string(),
            status: 409,
            message: "name taken".to_string(),
            request_id: None,
            attempts: 1,
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
            std::env::remove_var("RELAY_NODE_ID");
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
        // Identity reclaim would use audited takeover, not rotation. With no
        // matching proof it must never reach that escape hatch.
        let takeover = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/takeover")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(
                    r#"{"ok":true,"data":{"agent_id":"a_existing","name":"lead","token":"at_live_rotated","audit_id":"aud_1"}}"#,
                );
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
        takeover.assert_hits(0);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    /// Engines before 8.2.0 have no `/takeover`. A node restarting against one
    /// must still reclaim its identity via the legacy workspace-key rotate —
    /// this is the exact path the two-node fleet e2e drives, against a pinned
    /// v7.0.0 engine.
    #[tokio::test]
    async fn identity_reclaim_falls_back_to_legacy_rotate_on_older_engines() {
        let _env_guard = clear_relay_env();
        let identity = "work-unit-42";
        let identity_hash = hash_identity_key(identity);
        let server = MockServer::start();
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
            std::env::set_var("RELAY_AGENT_IDENTITY_KEY", identity);
        }
        server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });
        server.mock(|when, then| {
            when.method(GET).path("/v1/agents/lead");
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{identity_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });
        // Older engine: the takeover surface simply is not mounted.
        let takeover = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/lead/takeover");
            then.status(404)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"not_found","message":"Route not found"}}"#);
        });
        let legacy_rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"name":"lead","token":"at_live_legacy_reclaim"}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));
        let session = client
            .startup_session_set_with_identity(Some("lead"), true, None, Some(identity))
            .await
            .expect("an older engine must still let a restarting node reclaim its name")
            .default_session()
            .cloned()
            .expect("a session was registered");

        assert_eq!(session.token, "at_live_legacy_reclaim");
        takeover.assert_hits(1);
        legacy_rotate.assert_hits(1);
    }

    #[tokio::test]
    async fn identity_reclaim_rejects_blank_takeover_tokens() {
        let _env_guard = clear_relay_env();
        let identity = "work-unit-42";
        let identity_hash = hash_identity_key(identity);
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
            std::env::set_var("RELAY_AGENT_IDENTITY_KEY", identity);
        }

        for token in ["", "   ", "\t\r\n"] {
            let server = MockServer::start();
            server.mock(|when, then| {
                when.method(POST).path("/v1/agents");
                then.status(409)
                    .header("content-type", "application/json")
                    .body(
                        r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#,
                    );
            });
            server.mock(|when, then| {
                when.method(GET).path("/v1/agents/lead");
                then.status(200)
                    .header("content-type", "application/json")
                    .body(format!(
                        r#"{{"ok":true,"data":{{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{identity_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                    ));
            });
            let takeover = server.mock(|when, then| {
                when.method(POST).path("/v1/agents/lead/takeover");
                then.status(200)
                    .header("content-type", "application/json")
                    .json_body(json!({
                        "ok": true,
                        "data": {
                            "agent_id": "a_existing",
                            "name": "lead",
                            "token": token,
                            "audit_id": "aud_blank"
                        }
                    }));
            });

            let client = AuthClient::new(Some(server.base_url()));
            let error = client
                .startup_session_with_options(Some("lead"), true, None)
                .await
                .expect_err("blank takeover tokens must fail closed");

            assert!(
                format!("{error:#}").contains("audited takeover returned a blank token"),
                "unexpected error for token {token:?}: {error:#}"
            );
            takeover.assert_hits(1);
        }

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
            std::env::remove_var("RELAY_AGENT_IDENTITY_KEY");
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
        // Identity reclaim uses audited takeover, not self-rollover.
        let takeover = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/takeover")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(json!({
                    "expected_agent_id": "a_existing",
                    "actor": "broker:lead",
                    "reason": "work-unit identity key proved ownership after a crash",
                    "session_ref": identity_hash,
                    "node_id": "lead"
                }));
            then.status(200)
                .header("content-type", "application/json")
                .body(
                    r#"{"ok":true,"data":{"agent_id":"a_existing","name":"lead","token":"at_live_rotated","audit_id":"aud_1"}}"#,
                );
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
        takeover.assert_hits(1);

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
            std::env::set_var("RELAY_NODE_ID", "node_fleet_123");
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
        // Reclaiming a crashed identity goes through audited takeover, not
        // self-rollover: this path has the workspace authority plus a locally
        // verified work-unit proof, but not the agent's current token.
        let takeover = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/node-a/takeover")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(json!({
                    "expected_agent_id": "a_existing",
                    "actor": "broker:node-a",
                    "reason": "work-unit identity key proved ownership after a crash",
                    "session_ref": identity_hash,
                    "node_id": "node_fleet_123"
                }));
            then.status(200)
                .header("content-type", "application/json")
                .body(
                    r#"{"ok":true,"data":{"agent_id":"a_existing","name":"node-a","token":"at_live_rotated","audit_id":"aud_1"}}"#,
                );
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
        takeover.assert_hits(1);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
            std::env::remove_var("RELAY_NODE_ID");
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

    #[tokio::test]
    async fn legacy_identity_reclaim_stamps_identity_on_a_pre_gate_record() {
        // The defect this recovery path exists for: a record created before
        // 5c2ad8ee3 has no `identity_key` in its metadata at all, so the
        // ordinary `admit_agent_registration` collision path can never
        // reclaim it (`existing_identity` reads `None` forever). This
        // operator-invoked path uses Relaycast's atomic legacy-identity
        // mutation, not a registration collision or generic metadata PATCH.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/daytona-fleet-proof-0811")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_legacy","name":"daytona-fleet-proof-0811","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let expected_hash = hash_identity_key("node-legacy-identity");
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/v1/agents/daytona-fleet-proof-0811/legacy-identity")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(json!({ "identity_key_hash": expected_hash }));
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_legacy","name":"daytona-fleet-proof-0811","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{expected_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });

        let claim = reclaim_legacy_identity(
            Some(&server.base_url()),
            "rk_live_shared",
            "daytona-fleet-proof-0811",
            "node-legacy-identity",
        )
        .await
        .expect("a record with no prior identity_key must be claimable");

        assert_eq!(claim.agent_id, "a_legacy");
        assert_eq!(claim.agent_name, "daytona-fleet-proof-0811");
        get_existing.assert_hits(1);
        patch.assert_hits(1);
    }

    #[tokio::test]
    async fn legacy_identity_reclaim_preserves_other_metadata_keys() {
        // Relaycast's atomic json_set must not clobber whatever else was
        // already stamped on the record's metadata.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_legacy","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{"role":"lead-eng"},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let expected_hash = hash_identity_key("node-legacy-identity");
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/v1/agents/lead/legacy-identity")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(json!({ "identity_key_hash": expected_hash }));
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_legacy","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{{"role":"lead-eng","identity_key":"{expected_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });

        reclaim_legacy_identity(
            Some(&server.base_url()),
            "rk_live_shared",
            "lead",
            "node-legacy-identity",
        )
        .await
        .expect("existing metadata keys must survive the backfill");

        get_existing.assert_hits(1);
        patch.assert_hits(1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_legacy_identity_reclaims_cannot_both_succeed() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        use axum::{
            extract::State,
            http::StatusCode as AxumStatusCode,
            routing::{get, patch},
            Json, Router,
        };
        use tokio::sync::Barrier;

        #[derive(Clone)]
        struct ClaimServerState {
            initial_reads: Arc<Barrier>,
            claim_attempts: Arc<AtomicUsize>,
            winning_hash: Arc<Mutex<Option<String>>>,
        }

        async fn get_legacy_agent(State(state): State<ClaimServerState>) -> Json<Value> {
            // Force both callers to observe the same eligible pre-claim row;
            // only the endpoint's atomic mutation may choose the winner.
            state.initial_reads.wait().await;
            Json(json!({
                "ok": true,
                "data": {
                    "id": "a_legacy",
                    "name": "lead",
                    "type": "agent",
                    "status": "offline",
                    "persona": null,
                    "metadata": {},
                    "last_seen": "2025-01-01T00:00:00Z",
                    "channels": []
                }
            }))
        }

        async fn claim_legacy_agent(
            State(state): State<ClaimServerState>,
            Json(body): Json<Value>,
        ) -> (AxumStatusCode, Json<Value>) {
            let attempt = state.claim_attempts.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                let hash = body["identity_key_hash"]
                    .as_str()
                    .expect("client must send a hash, never a raw proof")
                    .to_string();
                *state.winning_hash.lock().unwrap() = Some(hash.clone());
                (
                    AxumStatusCode::OK,
                    Json(json!({
                        "ok": true,
                        "data": {
                            "id": "a_legacy",
                            "name": "lead",
                            "metadata": { "identity_key": hash }
                        }
                    })),
                )
            } else {
                (
                    AxumStatusCode::CONFLICT,
                    Json(json!({
                        "ok": false,
                        "error": {
                            "code": "agent_identity_already_claimed",
                            "message": "identity was claimed by the concurrent winner"
                        }
                    })),
                )
            }
        }

        let _env_guard = clear_relay_env();
        let state = ClaimServerState {
            initial_reads: Arc::new(Barrier::new(2)),
            claim_attempts: Arc::new(AtomicUsize::new(0)),
            winning_hash: Arc::new(Mutex::new(None)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/v1/agents/lead", get(get_legacy_agent))
                    .route("/v1/agents/lead/legacy-identity", patch(claim_legacy_agent))
                    .with_state(server_state),
            )
            .await
        });
        let base_url = format!("http://{address}");

        let (first, second) = tokio::join!(
            reclaim_legacy_identity(
                Some(&base_url),
                "rk_live_shared",
                "lead",
                "first-operator-proof"
            ),
            reclaim_legacy_identity(
                Some(&base_url),
                "rk_live_shared",
                "lead",
                "second-operator-proof"
            )
        );

        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        assert_eq!(
            usize::from(first.is_err()) + usize::from(second.is_err()),
            1
        );
        assert_eq!(state.claim_attempts.load(Ordering::SeqCst), 2);
        let winning_hash = state.winning_hash.lock().unwrap().clone().unwrap();
        assert!([
            hash_identity_key("first-operator-proof"),
            hash_identity_key("second-operator-proof")
        ]
        .contains(&winning_hash));

        server.abort();
    }

    #[tokio::test]
    async fn legacy_identity_reclaim_never_falls_back_to_generic_patch() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_legacy","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let generic_patch = server.mock(|when, then| {
            when.method(PATCH).path("/v1/agents/lead");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_legacy","name":"lead"}}"#);
        });

        let error = reclaim_legacy_identity(
            Some(&server.base_url()),
            "rk_live_shared",
            "lead",
            "operator-proof",
        )
        .await
        .expect_err("a server without atomic claims must fail closed");

        assert!(error
            .to_string()
            .contains("refusing an unsafe generic PATCH"));
        get_existing.assert_hits(1);
        generic_patch.assert_hits(0);
    }

    #[tokio::test]
    async fn legacy_identity_reclaim_refuses_a_record_that_already_has_an_identity() {
        // This path must never be usable to overwrite an already-protected
        // (post-gate) record — that would let a caller strip an existing
        // owner's protection and reassign the name to itself, reopening the
        // exact AR-448 hijack the gate exists to close. It is scoped
        // strictly to records that predate the gate.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let existing_hash = hash_identity_key("original-owner-identity");
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{existing_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/v1/agents/lead/legacy-identity");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });

        let error = reclaim_legacy_identity(
            Some(&server.base_url()),
            "rk_live_shared",
            "lead",
            "attacker-supplied-identity",
        )
        .await
        .expect_err("a record with an existing identity_key must never be re-stamped");

        assert!(
            error
                .to_string()
                .contains("already has a stamped identity_key"),
            "expected an already-protected rejection, got: {error:#}"
        );
        get_existing.assert_hits(1);
        patch.assert_hits(0);
    }

    #[tokio::test]
    async fn legacy_identity_reclaim_refuses_a_non_string_identity_key_value() {
        // Presence is the legacy boundary, not JSON type. A malformed or
        // partially migrated identity_key must fail closed instead of being
        // treated as proof that the record predates the gate.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{"identity_key":null},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/v1/agents/lead/legacy-identity");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });

        let error = reclaim_legacy_identity(
            Some(&server.base_url()),
            "rk_live_shared",
            "lead",
            "attacker-supplied-identity",
        )
        .await
        .expect_err("any present identity_key value must fail closed");

        assert!(
            error
                .to_string()
                .contains("already has a stamped identity_key"),
            "expected a malformed-identity rejection, got: {error:#}"
        );
        get_existing.assert_hits(1);
        patch.assert_hits(0);
    }

    #[tokio::test]
    async fn legacy_identity_reclaim_refuses_a_record_reporting_online() {
        // Best-effort defense against stamping an identity onto a record
        // that may still be a live, connected session — status can lag
        // reality, so this doesn't replace the identity check, but it costs
        // a legitimate offline-node caller nothing and closes an easy race.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let get_existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"lead","type":"agent","status":"online","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/v1/agents/lead/legacy-identity");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"lead","type":"agent","status":"online","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });

        let error = reclaim_legacy_identity(
            Some(&server.base_url()),
            "rk_live_shared",
            "lead",
            "some-identity",
        )
        .await
        .expect_err("a currently-online record must not be reclaimed");

        assert!(
            error
                .to_string()
                .contains("does not report status 'offline'"),
            "expected an online-record rejection, got: {error:#}"
        );
        get_existing.assert_hits(1);
        patch.assert_hits(0);
    }

    #[tokio::test]
    async fn legacy_identity_reclaim_then_ordinary_collision_still_rejects_a_mismatched_identity() {
        // The property that matters most: after a legacy record is
        // backfilled via this recovery path, it must behave EXACTLY like a
        // normal post-gate record from then on — a different caller
        // presenting a different identity on an ordinary registration
        // collision is still rejected. Backfilling must not leave the
        // record permanently open the way an automatic "None always wins"
        // grandfather clause would.
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let true_owner_identity = "node-legacy-identity";
        let true_owner_hash = hash_identity_key(true_owner_identity);

        let mut get_existing_for_backfill = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_legacy","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let mut patch = server.mock(|when, then| {
            when.method(PATCH)
                .path("/v1/agents/lead/legacy-identity")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(json!({ "identity_key_hash": true_owner_hash }));
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_legacy","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{true_owner_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });

        reclaim_legacy_identity(
            Some(&server.base_url()),
            "rk_live_shared",
            "lead",
            true_owner_identity,
        )
        .await
        .expect("backfill onto the still-unprotected legacy record must succeed");
        get_existing_for_backfill.assert_hits(1);
        patch.assert_hits(1);
        // Delete the backfill-phase mocks before registering the
        // collision-phase ones: both phases hit the identical GET route, and
        // an identical still-active mock would silently absorb the second
        // phase's request (serving the pre-backfill body) instead of the
        // route below, which must reflect the record's post-backfill state.
        get_existing_for_backfill.delete();
        patch.delete();

        // Now simulate an attacker's ordinary registration attempt racing
        // in afterward, presenting a DIFFERENT identity than the one just
        // backfilled.
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
            std::env::set_var("RELAY_AGENT_IDENTITY_KEY", "attacker-supplied-identity");
        }
        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_shared");
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });
        let get_existing_for_collision = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(format!(
                    r#"{{"ok":true,"data":{{"id":"a_legacy","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{{"identity_key":"{true_owner_hash}"}},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}}}"#
                ));
        });

        let client = AuthClient::new(Some(server.base_url()));
        let error = client
            .startup_session_with_options(Some("lead"), true, None)
            .await
            .expect_err("an attacker's mismatched identity must still be rejected after backfill");
        assert!(
            error
                .chain()
                .any(|layer| layer.to_string().contains("did not prove ownership")),
            "expected an ownership-mismatch rejection, got: {error:#}"
        );
        conflict.assert_hits(1);
        get_existing_for_collision.assert_hits(1);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
            std::env::remove_var("RELAY_AGENT_IDENTITY_KEY");
        }
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
                // `body_contains` rather than an exact `json_body`: the request
                // now also carries workspace provenance (relaycast 7.0.0), and
                // this mock only cares that the first attempt uses the
                // deterministic name.
                .body_contains(format!("\"name\":\"{workspace_name}\""));
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
                // Self-rollover authenticates as the agent, not the workspace.
                .header("authorization", "Bearer at_live_current");
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
            agent_token: Some("at_live_current".into()),
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
                // Self-rollover authenticates as the agent, not the workspace.
                .header("authorization", "Bearer at_live_current");
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
            agent_token: Some("at_live_current".into()),
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
