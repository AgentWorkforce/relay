use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use relaycast::{
    AgentRegistrationAuthority, CreateAgentRequest, RelayCast, RelayCastOptions, RelayError,
    WorkspaceRegistrationAuthority,
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const INCUMBENT_CREDENTIAL_CACHE_VERSION: u8 = 1;

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

/// Owner-only local proof that this broker possessed an agent credential
/// before sponsor enforcement was enabled on the registration authority.
///
/// The workspace key itself is intentionally not duplicated here. A digest is
/// sufficient to select the incumbent token for the exact configured
/// workspace, while the agent name prevents a token cached for one identity
/// from being offered while reclaiming another.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IncumbentCredentialCache {
    version: u8,
    #[serde(default)]
    memberships: Vec<IncumbentCredential>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IncumbentCredential {
    workspace_key_sha256: String,
    workspace_id: String,
    agent_id: String,
    agent_name: String,
    agent_token: String,
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
    #[serde(default)]
    agent_name: Option<String>,
    #[serde(default)]
    agent_token: Option<String>,
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
                    agent_name: source.agent_name,
                    agent_token: source.agent_token,
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

impl IncumbentCredentialCache {
    fn empty() -> Self {
        Self {
            version: INCUMBENT_CREDENTIAL_CACHE_VERSION,
            memberships: Vec::new(),
        }
    }

    fn from_credential_set(credentials: &CredentialSet) -> Result<Self> {
        let memberships = credentials
            .memberships
            .iter()
            .map(|credential| {
                let workspace_key = normalize_workspace_key(&credential.api_key)
                    .context("cannot cache an invalid workspace key fingerprint")?;
                let agent_name = credential
                    .agent_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .context("cannot cache an incumbent credential without an agent name")?;
                let agent_token = credential
                    .agent_token
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .context("cannot cache an incumbent credential without an agent token")?;
                Ok(IncumbentCredential {
                    workspace_key_sha256: workspace_key_fingerprint(&workspace_key),
                    workspace_id: credential.workspace_id.clone(),
                    agent_id: credential.agent_id.clone(),
                    agent_name: agent_name.to_string(),
                    agent_token: agent_token.to_string(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            version: INCUMBENT_CREDENTIAL_CACHE_VERSION,
            memberships,
        })
    }

    fn merge_credential_set(&mut self, credentials: &CredentialSet) -> Result<()> {
        let updates = Self::from_credential_set(credentials)?;
        for update in updates.memberships {
            if let Some(existing) = self.memberships.iter_mut().find(|existing| {
                existing.workspace_key_sha256 == update.workspace_key_sha256
                    && existing.agent_name.eq_ignore_ascii_case(&update.agent_name)
            }) {
                *existing = update;
            } else {
                self.memberships.push(update);
            }
        }
        Ok(())
    }

    fn incumbent_token_for(&self, workspace_key: &str, agent_name: Option<&str>) -> Option<&str> {
        let agent_name = agent_name?.trim();
        if agent_name.is_empty() {
            return None;
        }
        let fingerprint = workspace_key_fingerprint(workspace_key);
        self.memberships
            .iter()
            .find(|credential| {
                credential.workspace_key_sha256 == fingerprint
                    && credential.agent_name.eq_ignore_ascii_case(agent_name)
            })
            .map(|credential| credential.agent_token.as_str())
    }

    fn validate(&self) -> Result<()> {
        if self.version != INCUMBENT_CREDENTIAL_CACHE_VERSION {
            anyhow::bail!(
                "unsupported incumbent credential cache version {}",
                self.version
            );
        }
        for credential in &self.memberships {
            if credential.workspace_key_sha256.len() != 64
                || !credential
                    .workspace_key_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || credential.workspace_id.trim().is_empty()
                || credential.agent_id.trim().is_empty()
                || credential.agent_name.trim().is_empty()
                || credential.agent_token.trim().is_empty()
            {
                anyhow::bail!("incumbent credential cache contains an invalid membership");
            }
        }
        Ok(())
    }
}

fn workspace_key_fingerprint(workspace_key: &str) -> String {
    format!("{:x}", Sha256::digest(workspace_key.as_bytes()))
}

#[cfg(not(windows))]
fn protect_local_secret(body: Vec<u8>) -> Result<Vec<u8>> {
    Ok(body)
}

#[cfg(not(windows))]
fn unprotect_local_secret(body: Vec<u8>) -> Result<Vec<u8>> {
    Ok(body)
}

/// Windows has no POSIX owner-only mode bit. Protect broker-local secrets with
/// DPAPI's current-user scope so copying a file to another local account does
/// not disclose an incumbent agent token or work-unit ownership key.
#[cfg(windows)]
fn protect_local_secret(mut body: Vec<u8>) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let body_len = u32::try_from(body.len()).context("incumbent credential cache is too large")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: body_len,
        pbData: body.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` borrows `body` for the duration of the call; Windows
    // allocates `output.pbData`, which we copy before releasing via LocalFree.
    if unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("failed to protect incumbent credential cache with Windows DPAPI");
    }
    // SAFETY: CryptProtectData returned a valid allocation of `cbData` bytes.
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    // SAFETY: DPAPI documents that callers release this allocation with
    // LocalFree. The copied `protected` bytes no longer borrow it.
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(protected)
}

#[cfg(windows)]
fn unprotect_local_secret(mut body: Vec<u8>) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let body_len = u32::try_from(body.len()).context("incumbent credential cache is too large")?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: body_len,
        pbData: body.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: same lifetime/allocation contract as `protect_incumbent_cache`.
    if unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("failed to unprotect incumbent credential cache with Windows DPAPI");
    }
    // SAFETY: CryptUnprotectData returned a valid allocation of `cbData`
    // bytes, copied before LocalFree.
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    // SAFETY: release the Windows-owned output after copying it.
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(plaintext)
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
    sponsor: Option<AuthenticatedSponsor>,
}

impl AuthClient {
    pub fn new(base_url: Option<String>) -> Self {
        Self {
            base_url,
            sponsor: AuthenticatedSponsor::from_env(),
        }
    }

    #[cfg(test)]
    fn new_for_test(base_url: Option<String>) -> Self {
        Self {
            base_url,
            sponsor: Some(AuthenticatedSponsor::fixture()),
        }
    }

    fn require_authenticated_sponsor(&self) -> Result<&AuthenticatedSponsor> {
        let sponsor = self.sponsor.as_ref().context(
            "agent registration requires an SSO-authenticated human sponsor; Chief must provide RELAYAUTH_SPONSOR_ID and RELAYAUTH_SPONSOR_PROOF, and a workspace key alone is insufficient",
        )?;
        if sponsor.expires_at <= Utc::now().timestamp() {
            anyhow::bail!(
                "agent registration requires a current SSO sponsor proof; Chief must refresh the expired RELAYAUTH_SPONSOR_PROOF"
            );
        }
        Ok(sponsor)
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
        self.startup_session_set_with_identity_and_incumbents(
            requested_name,
            strict_name,
            agent_type,
            identity_key,
            &IncumbentCredentialCache::empty(),
        )
        .await
    }

    /// Broker-only startup variant that can prove possession of a credential
    /// cached before server-side sponsor enforcement was enabled. Cached
    /// tokens are considered solely for the exact workspace-key fingerprint
    /// and requested agent name; they never activate token-only bootstrap or
    /// authorize a different identity merely because both share a workspace.
    pub(crate) async fn startup_session_set_with_identity_and_incumbents(
        &self,
        requested_name: Option<&str>,
        strict_name: bool,
        agent_type: Option<&str>,
        identity_key: Option<&str>,
        incumbent_cache: &IncumbentCredentialCache,
    ) -> Result<AuthSessionSet> {
        let incumbent_agent_token = env_agent_token();
        if self.sponsor.is_none() {
            if let Some(agent_token) = incumbent_agent_token.as_deref() {
                return self
                    .startup_session_set_from_agent_token(requested_name, agent_token)
                    .await;
            }
        }
        if let Some((sources, default_hint)) = self.load_workspace_sources_from_env()? {
            let preferred_name = requested_name;
            let mut memberships = Vec::with_capacity(sources.len());
            let mut auth_rejections = Vec::new();

            for source in sources {
                let Some(api_key) = normalize_workspace_key(&source.api_key) else {
                    anyhow::bail!("RELAY_WORKSPACES_JSON contained an invalid workspace key");
                };
                let cached_incumbent_token =
                    incumbent_cache.incumbent_token_for(&api_key, preferred_name);
                if let Some(incumbent_token) = cached_incumbent_token {
                    if let Some(mut session) = self
                        .try_startup_session_from_incumbent(
                            &api_key,
                            source.workspace_id.as_deref(),
                            preferred_name,
                            incumbent_token,
                            identity_key,
                        )
                        .await?
                    {
                        session.credentials.workspace_alias = source.workspace_alias.clone();
                        memberships.push(session);
                        continue;
                    }
                }
                let incumbent_token = source.agent_token.as_deref().or(cached_incumbent_token);
                match self
                    .register_agent_with_workspace_key(
                        &api_key,
                        preferred_name,
                        strict_name,
                        agent_type,
                        identity_key,
                        incumbent_token,
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
            incumbent_agent_token.as_deref(),
            incumbent_cache,
        )
        .await
    }

    /// Bootstrap an already pre-registered worker without exercising the
    /// workspace-key registration authority at all. Parent brokers use this
    /// path for transport wrappers: the scoped agent token proves exactly one
    /// identity and therefore does not require exposing a sponsor grant or the
    /// broker's root work-unit secret to the child process.
    async fn startup_session_set_from_agent_token(
        &self,
        requested_name: Option<&str>,
        agent_token: &str,
    ) -> Result<AuthSessionSet> {
        let agent = relaycast::AgentClient::new(agent_token, self.base_url.clone())
            .context("invalid pre-registered RELAY_AGENT_TOKEN client")?
            .me()
            .await
            .map_err(relay_error_to_anyhow)
            .context("pre-registered RELAY_AGENT_TOKEN was rejected")?;
        if let Some(requested_name) = requested_name {
            if !requested_name.trim().eq_ignore_ascii_case(&agent.name) {
                anyhow::bail!(
                    "pre-registered RELAY_AGENT_TOKEN belongs to '{}' rather than requested agent '{}'",
                    agent.name,
                    requested_name
                );
            }
        }
        let workspace_id = agent
            .workspace_id
            .context("pre-registered agent response omitted workspace_id")?;
        let workspace_key = workspace_key_for_id_from_env(&workspace_id)?.context(
            "pre-registered agent workspace is missing from the configured workspace keys",
        )?;
        let session = AuthSession {
            credentials: WorkspaceCredential {
                workspace_id: workspace_id.clone(),
                workspace_alias: None,
                agent_id: agent.id,
                api_key: workspace_key,
                agent_name: Some(agent.name),
                agent_token: Some(agent_token.to_string()),
                updated_at: Utc::now(),
            },
            token: agent_token.to_string(),
        };
        Ok(AuthSessionSet {
            memberships: vec![session],
            default_workspace_id: Some(workspace_id),
        })
    }

    /// Pre-stage or perform a legacy authority binding without rotating the
    /// only known incumbent token. Old servers return 404 for the binding
    /// endpoint; in that case a successful `/me` proves the cached token is
    /// still current and lets the client retain it until enforcement ships.
    /// New servers bind it idempotently before the session starts.
    async fn try_startup_session_from_incumbent(
        &self,
        workspace_key: &str,
        workspace_id_hint: Option<&str>,
        requested_name: Option<&str>,
        incumbent_token: &str,
        identity_key: Option<&str>,
    ) -> Result<Option<AuthSession>> {
        // Validate the sponsor before even making the token-authenticated
        // identity lookup. In particular, an absent or expired proof must
        // stop startup before any Relaycast request is sent.
        let sponsor = self.require_authenticated_sponsor()?;
        let authority = registration_authority(sponsor, identity_key)?;
        let agent = match relaycast::AgentClient::new(incumbent_token, self.base_url.clone())
            .context("invalid cached incumbent agent token client")?
            .me()
            .await
        {
            Ok(agent) => agent,
            Err(error) if is_agent_token_invalid(&error) => return Ok(None),
            Err(error) => {
                return Err(relay_error_to_anyhow(error))
                    .context("cached incumbent agent token was rejected");
            }
        };
        if let Some(requested_name) = requested_name {
            if !requested_name.trim().eq_ignore_ascii_case(&agent.name) {
                anyhow::bail!(
                    "cached incumbent agent token belongs to '{}' rather than requested agent '{}'",
                    agent.name,
                    requested_name
                );
            }
        }
        let workspace_id = agent
            .workspace_id
            .context("cached incumbent agent response omitted workspace_id")?;
        if let Some(expected_workspace_id) = workspace_id_hint {
            if expected_workspace_id != workspace_id {
                anyhow::bail!(
                    "cached incumbent agent token belongs to workspace '{}' rather than configured workspace '{}'",
                    workspace_id,
                    expected_workspace_id
                );
            }
        }
        let relay = build_relay_client(workspace_key, self.base_url.as_deref())?;
        match relay
            .bind_agent_credential_authority(incumbent_token, authority)
            .await
        {
            Ok(_) | Err(RelayError::Api { status: 404, .. }) => {}
            Err(error) if is_agent_token_invalid(&error) => return Ok(None),
            Err(error) => {
                return Err(relay_error_to_anyhow(error))
                    .context("incumbent agent credential authority was rejected");
            }
        }
        Ok(Some(AuthSession {
            credentials: WorkspaceCredential {
                workspace_id,
                workspace_alias: None,
                agent_id: agent.id,
                api_key: workspace_key.to_string(),
                agent_name: Some(agent.name),
                agent_token: Some(incumbent_token.to_string()),
                updated_at: Utc::now(),
            },
            token: incumbent_token.to_string(),
        }))
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
                        cached.agent_token.as_deref(),
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
        let sponsor = self.require_authenticated_sponsor()?;

        let relay = build_relay_client(&api_key, self.base_url.as_deref())?;
        let identity_key =
            agent_identity_key().context("cannot rotate token without RELAY_AGENT_IDENTITY_KEY")?;
        let authority = registration_authority(sponsor, Some(&identity_key))?;
        let token = match relay
            .rotate_agent_token_with_authority(agent_name, authority.clone())
            .await
        {
            Ok(result) => result.token,
            Err(RelayError::Api {
                code, status: 409, ..
            }) if code == "agent_sponsor_migration_required" => {
                let incumbent_token = cached.agent_token.as_deref().context(
                    "legacy agent sponsor migration requires its cached incumbent agent token; refusing workspace-key-only reclaim",
                )?;
                relay
                    .bind_agent_credential_authority(incumbent_token, authority.clone())
                    .await
                    .map_err(relay_error_to_anyhow)?;
                incumbent_token.to_string()
            }
            Err(error) => return Err(relay_error_to_anyhow(error)),
        };
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
        incumbent_agent_token: Option<&str>,
        incumbent_cache: &IncumbentCredentialCache,
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
            let cached_incumbent_token =
                incumbent_cache.incumbent_token_for(&candidate.key, preferred_name);
            if let Some(incumbent_token) = cached_incumbent_token {
                if let Some(session) = self
                    .try_startup_session_from_incumbent(
                        &candidate.key,
                        workspace_id_hint.as_deref(),
                        preferred_name,
                        incumbent_token,
                        identity_key,
                    )
                    .await?
                {
                    return Ok(AuthSessionSet {
                        default_workspace_id: Some(session.credentials.workspace_id.clone()),
                        memberships: vec![session],
                    });
                }
            }
            let incumbent_token = incumbent_agent_token.or(cached_incumbent_token);
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
                    incumbent_token,
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
                    None,
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
                    agent_name: credential.agent_name,
                    agent_token: credential.agent_token,
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
        let sponsor = self.require_authenticated_sponsor()?;
        let authority = Some(WorkspaceRegistrationAuthority {
            sponsor_proof: sponsor.sponsor_proof.clone(),
        });
        match RelayCast::create_workspace_with_authority(
            name,
            self.base_url.as_deref(),
            authority.clone(),
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
                let result = RelayCast::create_workspace_with_authority(
                    &fallback_name,
                    self.base_url.as_deref(),
                    authority,
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
        incumbent_agent_token: Option<&str>,
    ) -> Result<(String, String, String, Option<String>)> {
        let sponsor = self.require_authenticated_sponsor()?;
        let relay = build_relay_client(workspace_key, self.base_url.as_deref())?;
        let name = requested_name
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("agent-{}", Uuid::new_v4().simple()));

        admit_agent_registration(
            &relay,
            &name,
            agent_type,
            identity_key,
            incumbent_agent_token,
            sponsor,
        )
        .await
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

fn env_agent_token() -> Option<String> {
    std::env::var("RELAY_AGENT_TOKEN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn workspace_key_for_id_from_env(workspace_id: &str) -> Result<Option<String>> {
    if let Ok(raw) = std::env::var("RELAY_WORKSPACES_JSON") {
        let value: Value =
            serde_json::from_str(raw.trim()).context("RELAY_WORKSPACES_JSON must be valid JSON")?;
        let memberships = if let Some(values) = value.as_array() {
            values.clone()
        } else if let Some(values) = value.get("memberships").and_then(Value::as_array) {
            values.clone()
        } else {
            vec![value]
        };
        for membership in memberships {
            let id = membership
                .get("workspace_id")
                .or_else(|| membership.get("workspaceId"))
                .and_then(Value::as_str);
            let key = membership.get("api_key").and_then(Value::as_str);
            if id == Some(workspace_id) {
                return Ok(key.and_then(normalize_workspace_key));
            }
        }

        // A token proves membership in exactly one server-reported workspace.
        // If an explicit membership set was supplied but does not contain that
        // workspace, do not silently pair the token with an unrelated fallback
        // key from RELAY_WORKSPACE_KEY.
        return Ok(None);
    }

    env_workspace_key().map(|source| source.map(|source| source.key))
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

const RELAYAUTH_SPONSOR_ID_ENV: &str = "RELAYAUTH_SPONSOR_ID";
const RELAYAUTH_SPONSOR_PROOF_ENV: &str = "RELAYAUTH_SPONSOR_PROOF";
const RELAYAUTH_SPONSOR_ORG_ENV: &str = "RELAYAUTH_SPONSOR_ORG_ID";
const RELAYAUTH_ISSUER_ENV: &str = "RELAYAUTH_ISSUER";
const RELAYAUTH_PUBLIC_KEY_ENV: &str = "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC";
const SPONSOR_GRANT_AUDIENCE: &str = "relayauth:sponsor-binding";
const SPONSOR_GRANT_INTENT: &str = "identity.create";
const SPONSOR_GRANT_TOKEN_TYPE: &str = "sponsor_grant";
const SPONSOR_GRANT_MAX_TTL_SECONDS: i64 = 15 * 60;

#[derive(Debug, Deserialize)]
struct SponsorGrantClaims {
    iss: String,
    sub: String,
    org: String,
    iat: i64,
    exp: i64,
    intent: String,
    token_type: String,
    oidc: SponsorOidcClaims,
}

#[derive(Debug, Deserialize)]
struct SponsorOidcClaims {
    issuer: String,
    subject: String,
    iat: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AuthenticatedSponsor {
    sponsor_id: String,
    sponsor_proof: String,
    expires_at: i64,
}

impl AuthenticatedSponsor {
    fn from_env() -> Option<Self> {
        let sponsor_id = std::env::var(RELAYAUTH_SPONSOR_ID_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| is_human_sponsor_id(value))?;
        let sponsor_proof = std::env::var(RELAYAUTH_SPONSOR_PROOF_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| is_compact_jws(value))?;
        let org_id = required_env(RELAYAUTH_SPONSOR_ORG_ENV)?;
        let issuer = required_env(RELAYAUTH_ISSUER_ENV)?;
        let public_key = required_env(RELAYAUTH_PUBLIC_KEY_ENV)?;
        let expires_at =
            verify_sponsor_proof(&sponsor_proof, &public_key, &issuer, &org_id, &sponsor_id)?;
        Some(Self {
            sponsor_id,
            sponsor_proof,
            expires_at,
        })
    }

    #[cfg(test)]
    fn fixture() -> Self {
        Self {
            sponsor_id: "user_test_owner".to_string(),
            sponsor_proof: "header.payload.signature".to_string(),
            expires_at: i64::MAX,
        }
    }
}

fn required_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn verify_sponsor_proof(
    proof: &str,
    public_key_pem: &str,
    expected_issuer: &str,
    expected_org: &str,
    expected_sponsor_id: &str,
) -> Option<i64> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[SPONSOR_GRANT_AUDIENCE]);
    validation.set_issuer(&[expected_issuer]);
    validation.set_required_spec_claims(&["exp", "iat", "iss", "aud", "sub"]);
    validation.leeway = 60;
    let token = decode::<SponsorGrantClaims>(
        proof,
        &DecodingKey::from_rsa_pem(public_key_pem.as_bytes()).ok()?,
        &validation,
    )
    .ok()?;
    let claims = token.claims;
    let now = Utc::now().timestamp();
    (claims.iss == expected_issuer
        && claims.sub == expected_sponsor_id
        && claims.org == expected_org
        && claims.intent == SPONSOR_GRANT_INTENT
        && claims.token_type == SPONSOR_GRANT_TOKEN_TYPE
        && claims.iat <= now + 60
        && claims.exp > claims.iat
        && claims.exp - claims.iat <= SPONSOR_GRANT_MAX_TTL_SECONDS
        && !claims.oidc.issuer.trim().is_empty()
        && !claims.oidc.subject.trim().is_empty()
        && claims.oidc.iat > 0)
        .then_some(claims.exp)
}

fn is_human_sponsor_id(value: &str) -> bool {
    value.strip_prefix("user_").is_some_and(|suffix| {
        !suffix.is_empty()
            && value.len() <= 256
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

fn is_compact_jws(value: &str) -> bool {
    value.len() <= 16 * 1024
        && value.split('.').count() == 3
        && value.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
}

/// Caller-supplied proof of work-unit identity for spawn-admission reclaim.
///
/// A crashed (or resumed) work unit that needs to re-register under its
/// prior name sets this to a value stable across that work unit's restarts.
/// Relaycast hashes this into its immutable, server-controlled credential
/// binding at creation. A later collision under the same name is only treated
/// as a reclaim of that SAME work unit if the presented value matches the
/// server binding — never by the name string or caller-editable metadata.
/// Absent, registration cannot reclaim on collision.
pub(crate) fn agent_identity_key() -> Option<String> {
    std::env::var("RELAY_AGENT_IDENTITY_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Read or atomically create the broker's local work-unit secret.
///
/// The previous implementation hashed the state path, which any workspace-key
/// holder could predict and replay. Credential ownership requires possession
/// of an actual secret, so the broker persists 32 random bytes beside its state
/// file with owner-only permissions and reuses them across restarts.
pub(crate) fn stable_node_identity_key(state_path: &std::path::Path) -> Result<String> {
    use rand::RngCore;
    use std::fs::OpenOptions;
    use std::io::{Read, Write};

    let parent = state_path
        .parent()
        .context("broker state path has no parent directory")?;
    std::fs::create_dir_all(parent).with_context(|| {
        format!(
            "failed to create broker state directory {}",
            parent.display()
        )
    })?;
    let key_path = parent.join(format!(
        "{}.work-unit-key",
        state_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state")
    ));

    loop {
        let mut read_options = OpenOptions::new();
        read_options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            read_options.custom_flags(nix::libc::O_NOFOLLOW);
        }
        match read_options.open(&key_path) {
            Ok(mut file) => {
                let metadata = file.metadata().with_context(|| {
                    format!("failed to inspect work-unit key {}", key_path.display())
                })?;
                if !metadata.is_file() {
                    anyhow::bail!(
                        "persisted work-unit key is not a regular file: {}",
                        key_path.display()
                    );
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if metadata.permissions().mode() & 0o077 != 0 {
                        anyhow::bail!(
                            "persisted work-unit key must not be accessible by group or other users: {}",
                            key_path.display()
                        );
                    }
                }
                let mut stored = Vec::new();
                file.read_to_end(&mut stored).with_context(|| {
                    format!("failed to read work-unit key {}", key_path.display())
                })?;
                let key = String::from_utf8(unprotect_local_secret(stored)?)
                    .context("persisted work-unit key is not UTF-8")?;
                let key = key.trim();
                if key.len() < 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    anyhow::bail!("invalid persisted work-unit key at {}", key_path.display());
                }
                return Ok(key.to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to open work-unit key {}", key_path.display())
                });
            }
        }

        let mut bytes = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let key = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
        }
        match options.open(&key_path) {
            Ok(mut file) => {
                let stored = protect_local_secret(key.as_bytes().to_vec())?;
                file.write_all(&stored).with_context(|| {
                    format!("failed to persist work-unit key {}", key_path.display())
                })?;
                file.sync_all().with_context(|| {
                    format!("failed to sync work-unit key {}", key_path.display())
                })?;
                #[cfg(unix)]
                std::fs::File::open(parent)
                    .and_then(|directory| directory.sync_all())
                    .with_context(|| {
                        format!(
                            "failed to durably sync work-unit key directory {}",
                            parent.display()
                        )
                    })?;
                return Ok(key);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to create work-unit key {}", key_path.display())
                });
            }
        }
    }
}

fn incumbent_credential_cache_path(state_path: &std::path::Path) -> Result<std::path::PathBuf> {
    let parent = state_path
        .parent()
        .context("broker state path has no parent directory")?;
    let state_name = state_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state");
    Ok(parent.join(format!("{state_name}.agent-credentials.json")))
}

/// Load incumbent agent credentials without following a caller-controlled
/// symlink or accepting a file readable by another local user. Missing is a
/// valid pre-staging state; malformed or insecure existing state fails closed.
pub(crate) fn load_incumbent_credential_cache(
    state_path: &std::path::Path,
) -> Result<IncumbentCredentialCache> {
    use std::fs::OpenOptions;
    use std::io::Read;

    let path = incumbent_credential_cache_path(state_path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    let mut file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(IncumbentCredentialCache::empty());
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "failed to open incumbent credential cache {}",
                    path.display()
                )
            });
        }
    };
    let metadata = file.metadata().with_context(|| {
        format!(
            "failed to inspect incumbent credential cache {}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        anyhow::bail!(
            "incumbent credential cache is not a regular file: {}",
            path.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            anyhow::bail!(
                "incumbent credential cache must not be accessible by group or other users: {}",
                path.display()
            );
        }
    }
    let mut body = Vec::new();
    file.read_to_end(&mut body).with_context(|| {
        format!(
            "failed to read incumbent credential cache {}",
            path.display()
        )
    })?;
    let body = unprotect_local_secret(body)?;
    let cache: IncumbentCredentialCache = serde_json::from_slice(&body).with_context(|| {
        format!(
            "failed to parse incumbent credential cache {}",
            path.display()
        )
    })?;
    cache.validate()?;
    Ok(cache)
}

/// Atomically replace the incumbent credential cache after a successful
/// registration. Startup fails if this durability step fails: proceeding
/// without retaining the only migration proof could strand the identity once
/// hosted sponsor enforcement is enabled.
pub(crate) fn persist_incumbent_credential_cache(
    state_path: &std::path::Path,
    credentials: &CredentialSet,
) -> Result<()> {
    use std::io::Write;

    let path = incumbent_credential_cache_path(state_path)?;
    let parent = path
        .parent()
        .context("incumbent credential cache path has no parent directory")?;
    std::fs::create_dir_all(parent).with_context(|| {
        format!(
            "failed to create incumbent credential cache directory {}",
            parent.display()
        )
    })?;
    // Multi-workspace startup intentionally tolerates an unavailable
    // membership when at least one other membership succeeds. Preserve its
    // last known incumbent token instead of replacing the entire cache and
    // accidentally destroying the proof needed on its next healthy restart.
    let mut cache = load_incumbent_credential_cache(state_path)?;
    cache.merge_credential_set(credentials)?;
    let body = protect_local_secret(
        serde_json::to_vec_pretty(&cache)
            .context("failed to serialize incumbent credential cache")?,
    )?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).with_context(|| {
        format!(
            "failed to create temporary incumbent credential cache in {}",
            parent.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .with_context(|| {
                format!(
                    "failed to restrict temporary incumbent credential cache in {}",
                    parent.display()
                )
            })?;
    }
    temporary
        .write_all(&body)
        .context("failed to write incumbent credential cache")?;
    temporary
        .as_file()
        .sync_all()
        .context("failed to sync incumbent credential cache")?;
    temporary.persist(&path).with_context(|| {
        format!(
            "failed to atomically persist incumbent credential cache {}",
            path.display()
        )
    })?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .with_context(|| {
            format!(
                "failed to durably sync incumbent credential cache directory {}",
                parent.display()
            )
        })?;
    Ok(())
}

fn registration_authority(
    sponsor: &AuthenticatedSponsor,
    identity_key: Option<&str>,
) -> Result<AgentRegistrationAuthority> {
    let work_unit_key = identity_key
        .map(str::trim)
        .filter(|value| value.len() >= 32)
        .context(
            "agent registration requires a stable secret work-unit key of at least 32 bytes; set RELAY_AGENT_IDENTITY_KEY or use the broker's persisted node identity",
        )?;
    Ok(AgentRegistrationAuthority {
        sponsor_proof: sponsor.sponsor_proof.clone(),
        work_unit_key: work_unit_key.to_string(),
    })
}

pub(crate) fn registration_authority_from_env(
    work_unit_key: &str,
) -> Result<AgentRegistrationAuthority> {
    #[cfg(test)]
    if std::env::var_os("RELAYAUTH_TEST_SPONSOR_FIXTURE").is_some() {
        return registration_authority(&AuthenticatedSponsor::fixture(), Some(work_unit_key));
    }
    let sponsor = AuthenticatedSponsor::from_env()
        .context("agent registration requires Chief's valid RelayAuth sponsor proof environment")?;
    if sponsor.expires_at <= Utc::now().timestamp() {
        anyhow::bail!("agent registration requires a current RELAYAUTH_SPONSOR_PROOF");
    }
    registration_authority(&sponsor, Some(work_unit_key))
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
/// token, so a crashed broker's resume path keeps working) is decided by
/// Relaycast's immutable sponsor/work-unit binding. Legacy agents without a
/// binding may be migrated only by presenting their incumbent agent token;
/// a workspace key plus sponsor grant is deliberately insufficient.
async fn admit_agent_registration(
    relay: &RelayCast,
    name: &str,
    agent_type: Option<&str>,
    identity_key: Option<&str>,
    incumbent_agent_token: Option<&str>,
    sponsor: &AuthenticatedSponsor,
) -> Result<(String, String, String, Option<String>)> {
    let authority = registration_authority(sponsor, identity_key)?;

    let request = CreateAgentRequest {
        name: name.to_string(),
        agent_type: Some(agent_type.unwrap_or("agent").to_string()),
        persona: None,
        metadata: None,
    };

    match relay
        .register_agent_with_authority(request, authority.clone())
        .await
    {
        Ok(result) => Ok((result.id, result.name, result.token, result.workspace_id)),
        Err(RelayError::Api { code, status, .. }) if is_conflict_code(&code) || status == 409 => {
            let existing = relay.get_agent(name).await.map_err(relay_error_to_anyhow)?;
            let token = match relay
                .rotate_agent_token_with_authority(&existing.name, authority.clone())
                .await
            {
                Ok(response) => response.token,
                Err(RelayError::Api {
                    code, status: 409, ..
                }) if code == "agent_sponsor_migration_required" => {
                    let incumbent_token = incumbent_agent_token.context(
                        "legacy agent sponsor migration requires its incumbent RELAY_AGENT_TOKEN (or agent_token in RELAY_WORKSPACES_JSON); refusing workspace-key-only reclaim",
                    )?;
                    relay
                        .bind_agent_credential_authority(incumbent_token, authority.clone())
                        .await
                        .map_err(relay_error_to_anyhow)?;
                    incumbent_token.to_string()
                }
                Err(error) => return Err(relay_error_to_anyhow(error)),
            };
            Ok((existing.id, existing.name, token, existing.workspace_id))
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
        is_agent_token_invalid, is_agent_token_invalid_anyhow, is_agent_token_invalid_code,
        load_incumbent_credential_cache, persist_incumbent_credential_cache, relay_error_to_anyhow,
        stable_node_identity_key, AuthClient, CredentialCache, CredentialSet,
        AGENT_TOKEN_INVALID_CODE, INCUMBENT_CREDENTIAL_CACHE_VERSION,
    };
    use relaycast::RelayError;

    static RELAY_ENV_MUTEX: Mutex<()> = Mutex::new(());
    const TEST_WORK_UNIT_KEY: &str =
        "test-work-unit-key-000000000000000000000000000000000000000000000001";

    fn test_registration_body(
        name: &str,
        agent_type: &str,
        work_unit_key: &str,
    ) -> serde_json::Value {
        let sponsor = super::AuthenticatedSponsor::fixture();
        json!({
            "name": name,
            "type": agent_type,
            "registration_authority": {
                "sponsor_proof": sponsor.sponsor_proof,
                "work_unit_key": work_unit_key,
            }
        })
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

    #[tokio::test]
    async fn workspace_key_alone_cannot_register_an_agent() {
        let client = AuthClient {
            base_url: Some("http://127.0.0.1:9".to_string()),
            sponsor: None,
        };
        let error = client
            .register_agent_with_workspace_key(
                "rk_live_shared",
                Some("forged-agent"),
                true,
                Some("agent"),
                Some("forged-work-unit"),
                None,
            )
            .await
            .expect_err("a workspace key without Chief's SSO sponsor proof must fail closed");
        assert!(error
            .to_string()
            .contains("SSO-authenticated human sponsor"));
    }

    #[tokio::test]
    async fn expired_sponsor_proof_cannot_register_an_agent() {
        let client = AuthClient {
            base_url: Some("http://127.0.0.1:9".to_string()),
            sponsor: Some(super::AuthenticatedSponsor {
                expires_at: chrono::Utc::now().timestamp() - 1,
                ..super::AuthenticatedSponsor::fixture()
            }),
        };
        let error = client
            .register_agent_with_workspace_key(
                "rk_live_shared",
                Some("expired-sponsor-agent"),
                true,
                Some("agent"),
                Some("expired-sponsor-work-unit"),
                None,
            )
            .await
            .expect_err("an expired SSO sponsor proof must fail before registration");
        assert!(error
            .to_string()
            .contains("expired RELAYAUTH_SPONSOR_PROOF"));
    }

    #[tokio::test]
    async fn missing_sponsor_proof_fails_before_workspace_creation() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(
                    r#"{"ok":true,"data":{"workspace_id":"ws_orphan","api_key":"rk_live_orphan"}}"#,
                );
        });

        let client = AuthClient::new(Some(server.base_url()));
        let error = client
            .startup_session(Some("lead"))
            .await
            .expect_err("missing sponsor authority must fail before any startup write");

        assert!(error
            .to_string()
            .contains("SSO-authenticated human sponsor"));
        workspace.assert_hits(0);
    }

    #[tokio::test]
    async fn expired_sponsor_proof_fails_before_workspace_creation() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let workspace = server.mock(|when, then| {
            when.method(POST).path("/v1/workspaces");
            then.status(200)
                .header("content-type", "application/json")
                .body(
                    r#"{"ok":true,"data":{"workspace_id":"ws_orphan","api_key":"rk_live_orphan"}}"#,
                );
        });
        let client = AuthClient {
            base_url: Some(server.base_url()),
            sponsor: Some(super::AuthenticatedSponsor {
                expires_at: chrono::Utc::now().timestamp() - 1,
                ..super::AuthenticatedSponsor::fixture()
            }),
        };

        let error = client
            .startup_session(Some("lead"))
            .await
            .expect_err("expired sponsor authority must fail before any startup write");

        assert!(error
            .to_string()
            .contains("expired RELAYAUTH_SPONSOR_PROOF"));
        workspace.assert_hits(0);
    }

    /// Remove RELAY_API_KEY from the environment so it doesn't interfere with
    /// mock-server tests. Tests use httpmock and only set up specific auth
    /// headers — the real env key causes 404s against the mock.
    fn clear_relay_env() -> MutexGuard<'static, ()> {
        let guard = RELAY_ENV_MUTEX
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // SAFETY: test-only; Rust warns about remove_var in multi-threaded
        // contexts but we accept the risk in test code.
        unsafe {
            std::env::remove_var("AGENT_RELAY_WORKSPACE_KEY");
            std::env::remove_var("RELAY_WORKSPACE_KEY");
            std::env::remove_var("RELAY_API_KEY");
            std::env::remove_var("RELAY_WORKSPACES_JSON");
            std::env::remove_var("RELAY_DEFAULT_WORKSPACE");
            std::env::remove_var("RELAY_AGENT_TOKEN");
            std::env::set_var("RELAY_AGENT_IDENTITY_KEY", TEST_WORK_UNIT_KEY);
        }
        guard
    }

    #[test]
    fn pre_registered_token_does_not_pair_with_an_unrelated_fallback_workspace_key() {
        let _env_guard = clear_relay_env();
        unsafe {
            std::env::set_var(
                "RELAY_WORKSPACES_JSON",
                r#"[{"workspace_id":"ws_other","api_key":"rk_live_other"}]"#,
            );
            std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", "rk_live_fallback");
        }

        let key = super::workspace_key_for_id_from_env("ws_token")
            .expect("membership configuration should parse");
        assert_eq!(key, None);

        unsafe {
            std::env::remove_var("RELAY_WORKSPACES_JSON");
            std::env::remove_var("AGENT_RELAY_WORKSPACE_KEY");
        }
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

        let client = AuthClient::new_for_test(Some(server.base_url()));

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

        let client = AuthClient::new_for_test(Some(server.base_url()));

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
    async fn pre_registered_agent_token_bootstraps_without_sponsor_or_registration() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", "rk_live_env");
            std::env::set_var("RELAY_AGENT_TOKEN", "at_live_existing");
        }
        let me = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agent")
                .header("authorization", "Bearer at_live_existing");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","workspace_id":"ws_env","name":"lead","type":"agent","status":"online","persona":null,"metadata":{}}}"#);
        });
        let register = server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(500);
        });

        // Deliberately no sponsor fixture: the incumbent token is the only
        // authority this bootstrap path may exercise.
        let client = AuthClient::new(Some(server.base_url()));
        let session = client.startup_session(Some("lead")).await.unwrap();

        assert_eq!(session.token, "at_live_existing");
        assert_eq!(session.credentials.workspace_id, "ws_env");
        assert_eq!(session.credentials.api_key, "rk_live_env");
        assert_eq!(session.credentials.agent_id, "a_existing");
        me.assert_hits(1);
        register.assert_hits(0);
    }

    #[tokio::test]
    async fn pre_registered_agent_token_cannot_claim_a_different_name() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", "rk_live_env");
            std::env::set_var("RELAY_AGENT_TOKEN", "at_live_existing");
        }
        server.mock(|when, then| {
            when.method(GET).path("/v1/agent");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_existing","workspace_id":"ws_env","name":"incumbent","type":"agent","status":"online","persona":null,"metadata":{}}}"#);
        });

        let client = AuthClient::new(Some(server.base_url()));
        let error = client
            .startup_session(Some("attacker-selected-name"))
            .await
            .expect_err("an agent token must remain bound to its server identity");
        assert!(error.to_string().contains("belongs to 'incumbent'"));
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

        let client = AuthClient::new_for_test(Some(server.base_url()));
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

        let client = AuthClient::new_for_test(Some(server.base_url()));
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

        let client = AuthClient::new_for_test(Some(server.base_url()));

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

        let client = AuthClient::new_for_test(Some(server.base_url()));
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
                .json_body(test_registration_body("lead", "agent", TEST_WORK_UNIT_KEY));
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
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_sponsor_migration_required","message":"legacy agent requires incumbent-token migration"}}"#);
        });

        let client = AuthClient::new_for_test(Some(server.base_url()));
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
        rotate.assert_hits(1);

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
        }
        let work_unit_key = "work-unit-42-000000000000000000000000000000000000";
        unsafe {
            std::env::set_var("RELAY_AGENT_IDENTITY_KEY", work_unit_key);
        }
        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(test_registration_body("lead", "agent", work_unit_key));
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

        let client = AuthClient::new_for_test(Some(server.base_url()));
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

    #[tokio::test]
    async fn legacy_agent_migration_requires_and_uses_incumbent_agent_token() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
            std::env::set_var("RELAY_AGENT_TOKEN", "at_live_incumbent");
        }

        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(test_registration_body("lead", "agent", TEST_WORK_UNIT_KEY));
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
                .body(r#"{"ok":true,"data":{"id":"a_legacy","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_shared");
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_sponsor_migration_required","message":"legacy agent requires incumbent-token migration"}}"#);
        });
        let bind = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agent/credential-authority")
                .header("authorization", "Bearer at_live_incumbent")
                .json_body(json!({
                    "registration_authority": {
                        "sponsor_proof": "header.payload.signature",
                        "work_unit_key": TEST_WORK_UNIT_KEY,
                    }
                }));
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"bound":true}}"#);
        });

        let client = AuthClient::new_for_test(Some(server.base_url()));
        let session = client
            .startup_session(Some("lead"))
            .await
            .expect("the incumbent token should authorize the one-time legacy binding");

        assert_eq!(session.credentials.agent_id, "a_legacy");
        assert_eq!(session.token, "at_live_incumbent");
        conflict.assert_hits(1);
        get_existing.assert_hits(1);
        rotate.assert_hits(1);
        bind.assert_hits(1);
    }

    #[tokio::test]
    async fn staged_restart_migrates_legacy_agent_with_persisted_incumbent_token() {
        let _env_guard = clear_relay_env();
        let state_dir = tempfile::tempdir().unwrap();
        let state_path = state_dir.path().join("state.json");
        unsafe {
            std::env::set_var("RELAY_API_KEY", "rk_live_shared");
        }

        // Stage 1: deploy this client while the old authority still allows the
        // legacy rotation. The resulting scoped token is persisted before the
        // server-side enforcement rollout.
        let old_server = MockServer::start();
        let old_conflict = old_server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_already_exists","message":"name_taken"}}"#);
        });
        let old_get = old_server.mock(|when, then| {
            when.method(GET).path("/v1/agents/lead");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_legacy","workspace_id":"ws_legacy","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let old_rotate = old_server.mock(|when, then| {
            when.method(POST).path("/v1/agents/lead/rotate-token");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"name":"lead","token":"at_live_incumbent"}}"#);
        });
        let staged = AuthClient::new_for_test(Some(old_server.base_url()))
            .startup_session_set_with_identity(Some("lead"), true, None, Some(TEST_WORK_UNIT_KEY))
            .await
            .expect("the client-first stage should capture the incumbent token");
        persist_incumbent_credential_cache(&state_path, &staged.credential_set()).unwrap();
        old_conflict.assert_hits(1);
        old_get.assert_hits(1);
        old_rotate.assert_hits(1);

        // Stage 2: after enforcement, the next restart proves possession with
        // that exact agent token and binds the immutable sponsor/work-unit
        // authority. It never asks the workspace-key endpoint to rotate.
        let enforced_server = MockServer::start();
        let me = enforced_server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agent")
                .header("authorization", "Bearer at_live_incumbent");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_legacy","workspace_id":"ws_legacy","name":"lead","type":"agent","status":"online","persona":null,"metadata":{}}}"#);
        });
        let bind = enforced_server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agent/credential-authority")
                .header("authorization", "Bearer at_live_incumbent")
                .json_body(json!({
                    "registration_authority": {
                        "sponsor_proof": "header.payload.signature",
                        "work_unit_key": TEST_WORK_UNIT_KEY,
                    }
                }));
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"bound":true}}"#);
        });
        let workspace_key_registration = enforced_server.mock(|when, then| {
            when.method(POST).path("/v1/agents");
            then.status(500);
        });
        let cache = load_incumbent_credential_cache(&state_path).unwrap();
        let migrated = AuthClient::new_for_test(Some(enforced_server.base_url()))
            .startup_session_set_with_identity_and_incumbents(
                Some("lead"),
                true,
                None,
                Some(TEST_WORK_UNIT_KEY),
                &cache,
            )
            .await
            .expect("the staged token should authorize the one-time migration");

        assert_eq!(
            migrated.default_session().unwrap().token,
            "at_live_incumbent"
        );
        me.assert_hits(1);
        bind.assert_hits(1);
        workspace_key_registration.assert_hits(0);

        unsafe {
            std::env::remove_var("RELAY_API_KEY");
        }
    }

    #[test]
    fn incumbent_cache_is_name_and_workspace_bound_without_storing_workspace_key() {
        let cache =
            super::IncumbentCredentialCache::from_credential_set(&CredentialSet::from_memberships(
                vec![CredentialCache {
                    workspace_id: "ws_1".into(),
                    workspace_alias: None,
                    agent_id: "a_1".into(),
                    api_key: "rk_live_secret_workspace_key".into(),
                    agent_name: Some("lead".into()),
                    agent_token: Some("at_live_incumbent".into()),
                    updated_at: chrono::Utc::now(),
                }],
                None,
            ))
            .unwrap();

        assert_eq!(
            cache.incumbent_token_for("rk_live_secret_workspace_key", Some("LEAD")),
            Some("at_live_incumbent")
        );
        assert_eq!(
            cache.incumbent_token_for("rk_live_other_workspace_key", Some("lead")),
            None
        );
        assert_eq!(
            cache.incumbent_token_for("rk_live_secret_workspace_key", Some("victim")),
            None
        );
        let serialized = serde_json::to_string(&cache).unwrap();
        assert!(!serialized.contains("rk_live_secret_workspace_key"));
        assert_eq!(cache.version, INCUMBENT_CREDENTIAL_CACHE_VERSION);
    }

    #[test]
    fn incumbent_cache_persistence_preserves_an_unavailable_workspace_membership() {
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join("state.json");
        let membership = |workspace_id: &str,
                          agent_id: &str,
                          workspace_key: &str,
                          agent_name: &str,
                          agent_token: &str| CredentialCache {
            workspace_id: workspace_id.into(),
            workspace_alias: None,
            agent_id: agent_id.into(),
            api_key: workspace_key.into(),
            agent_name: Some(agent_name.into()),
            agent_token: Some(agent_token.into()),
            updated_at: chrono::Utc::now(),
        };
        persist_incumbent_credential_cache(
            &state_path,
            &CredentialSet::from_memberships(
                vec![
                    membership("ws_1", "a_1", "rk_live_one", "lead", "at_live_old_one"),
                    membership("ws_2", "a_2", "rk_live_two", "lead", "at_live_old_two"),
                ],
                None,
            ),
        )
        .unwrap();
        persist_incumbent_credential_cache(
            &state_path,
            &CredentialSet::from_memberships(
                vec![membership(
                    "ws_1",
                    "a_1",
                    "rk_live_one",
                    "lead",
                    "at_live_new_one",
                )],
                None,
            ),
        )
        .unwrap();

        let cache = load_incumbent_credential_cache(&state_path).unwrap();
        assert_eq!(
            cache.incumbent_token_for("rk_live_one", Some("lead")),
            Some("at_live_new_one")
        );
        assert_eq!(
            cache.incumbent_token_for("rk_live_two", Some("lead")),
            Some("at_live_old_two")
        );
    }

    #[cfg(unix)]
    #[test]
    fn incumbent_cache_is_owner_only_and_rejects_insecure_existing_state() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join("state.json");
        let credentials = CredentialSet::from_memberships(
            vec![CredentialCache {
                workspace_id: "ws_1".into(),
                workspace_alias: None,
                agent_id: "a_1".into(),
                api_key: "rk_live_workspace".into(),
                agent_name: Some("lead".into()),
                agent_token: Some("at_live_incumbent".into()),
                updated_at: chrono::Utc::now(),
            }],
            None,
        );
        persist_incumbent_credential_cache(&state_path, &credentials).unwrap();
        let path = super::incumbent_credential_cache_path(&state_path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
            0
        );
        assert_eq!(
            load_incumbent_credential_cache(&state_path)
                .unwrap()
                .memberships
                .len(),
            1
        );

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let error = load_incumbent_credential_cache(&state_path)
            .expect_err("a group/world-readable token cache must fail closed");
        assert!(error.to_string().contains("group or other users"));
    }

    #[test]
    fn stable_node_identity_key_is_stable_per_state_path() {
        let node_a = tempfile::tempdir().unwrap();
        let node_b = tempfile::tempdir().unwrap();
        // Same project/state directory (the "same work unit" across a kill +
        // restart, per the fleet node harness) must hash identically every
        // time, or the broker could never reclaim its own name after a crash.
        let a_path = node_a.path().join("state.json");
        let a = stable_node_identity_key(&a_path).unwrap();
        let a_again = stable_node_identity_key(&a_path).unwrap();
        assert_eq!(a, a_again);

        // A different project/state directory (a genuinely different node)
        // must hash to something else, or two unrelated nodes could reclaim
        // each other's registrations.
        let b = stable_node_identity_key(&node_b.path().join("state.json")).unwrap();
        assert_ne!(a, b);
    }

    #[cfg(unix)]
    #[test]
    fn stable_node_identity_key_rejects_insecure_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let node = tempfile::tempdir().unwrap();
        let state_path = node.path().join("state.json");
        stable_node_identity_key(&state_path).unwrap();
        let key_path = node.path().join("state.json.work-unit-key");
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let error = stable_node_identity_key(&state_path)
            .expect_err("a group/world-readable ownership root must fail closed");
        assert!(error.to_string().contains("group or other users"));
    }

    #[cfg(unix)]
    #[test]
    fn stable_node_identity_key_refuses_symlinks() {
        let node = tempfile::tempdir().unwrap();
        let target = node.path().join("attacker-controlled");
        std::fs::write(&target, "0".repeat(64)).unwrap();
        let key_path = node.path().join("state.json.work-unit-key");
        std::os::unix::fs::symlink(&target, &key_path).unwrap();

        stable_node_identity_key(&node.path().join("state.json"))
            .expect_err("the ownership root path must never follow a symlink");
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
        ))
        .unwrap();
        let conflict = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents")
                .header("authorization", "Bearer rk_live_shared")
                .json_body(test_registration_body("node-a", "agent", &stable_identity));
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
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"node-a","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/node-a/rotate-token")
                .header("authorization", "Bearer rk_live_shared");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"name":"node-a","token":"at_live_rotated"}}"#);
        });

        let client = AuthClient::new_for_test(Some(server.base_url()));
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
        ))
        .unwrap();
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
                .body(r#"{"ok":true,"data":{"id":"a_existing","name":"node-a","type":"agent","status":"offline","persona":null,"metadata":{},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/node-a/rotate-token")
                .header("authorization", "Bearer rk_live_shared");
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_credential_binding_mismatch","message":"work unit does not own credential"}}"#);
        });

        let client = AuthClient::new_for_test(Some(server.base_url()));
        let error = client
            .startup_session_set_with_identity(Some("node-a"), true, None, Some(&our_identity))
            .await
            .expect_err("a mismatched identity on collision must be rejected, not reclaimed");

        // `to_string()` on an anyhow::Error only shows the outermost context
        // layer; walk the full chain for the admission-gate's own message.
        assert!(
            error
                .chain()
                .any(|layer| layer.to_string().contains("does not own credential")),
            "expected an ownership-mismatch rejection, got: {error:#}"
        );
        conflict.assert_hits(1);
        get_existing.assert_hits(1);
        rotate.assert_hits(1);

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
                .json_body(test_registration_body("lead", "agent", TEST_WORK_UNIT_KEY));
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
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(409)
                .header("content-type", "application/json")
                .body(r#"{"ok":false,"error":{"code":"agent_sponsor_migration_required","message":"legacy agent requires incumbent-token migration"}}"#);
        });

        let client = AuthClient::new_for_test(Some(server.base_url()));
        let result = client.startup_session(Some("lead")).await;

        assert!(
            result.is_err(),
            "non-strict registration must also reject an unproven name collision, not mint a silent -suffix sibling"
        );
        workspace.assert_hits(1);
        conflict.assert_hits(1);
        get_existing.assert_hits(1);
        rotate.assert_hits(1);
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
                .json_body(json!({
                    "name": workspace_name,
                    "registration_authority": {
                        "sponsor_proof": "header.payload.signature"
                    }
                }));
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

        let client = AuthClient::new_for_test(Some(server.base_url()));
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
        let existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_old","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{"relayauth_sponsor_id":"user_test_owner","relayauth_sponsor_binding":"oidc"},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
        let rotate = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/lead/rotate-token")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"token":"at_live_rotated","name":"lead"}}"#);
        });

        let client = AuthClient::new_for_test(Some(server.base_url()));

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
        existing.assert_hits(0);
        rotate.assert_hits(1);
    }

    #[tokio::test]
    async fn rotate_token_falls_back_to_reregister_on_404() {
        let _env_guard = clear_relay_env();
        let server = MockServer::start();
        let existing = server.mock(|when, then| {
            when.method(GET)
                .path("/v1/agents/lead")
                .header("authorization", "Bearer rk_live_cached");
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"ok":true,"data":{"id":"a_old","name":"lead","type":"agent","status":"offline","persona":null,"metadata":{"relayauth_sponsor_id":"user_test_owner","relayauth_sponsor_binding":"oidc"},"last_seen":"2025-01-01T00:00:00Z","channels":[]}}"#);
        });
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

        let client = AuthClient::new_for_test(Some(server.base_url()));

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
        existing.assert_hits(0);
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
        let client = AuthClient::new_for_test(Some(server.base_url()));

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
        let client = AuthClient::new_for_test(Some(server.base_url()));

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

        let client = AuthClient::new_for_test(Some(server.base_url()));
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

        let client = AuthClient::new_for_test(Some(server.base_url()));
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
