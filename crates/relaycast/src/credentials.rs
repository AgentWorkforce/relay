//! Credential storage and session bootstrapping for persistent agent identity.
//!
//! Provides file-based credential caching so agents can persist their identity
//! across restarts without re-registering each time.
//!
//! # Example
//!
//! ```rust,no_run
//! use relaycast::credentials::{CredentialStore, BootstrapConfig};
//! use relaycast::RelayCast;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let store = CredentialStore::new("/tmp/relaycast.json");
//!     let config = BootstrapConfig {
//!         preferred_name: Some("my-agent".into()),
//!         ..Default::default()
//!     };
//!
//!     let session = relaycast::credentials::bootstrap_session(
//!         &store,
//!         config,
//!     ).await?;
//!
//!     println!("Agent token: {}", session.token);
//!     Ok(())
//! }
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{RelayError, Result};
use crate::{CreateAgentRequest, RelayCast, RelayCastOptions};

/// Cached agent credentials persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCredentials {
    /// The workspace ID this agent belongs to.
    pub workspace_id: String,
    /// The agent's unique ID.
    pub agent_id: String,
    /// The workspace API key (rk_live_...).
    pub api_key: String,
    /// The agent's registered name.
    pub agent_name: Option<String>,
    /// The agent's bearer token for API calls.
    pub agent_token: Option<String>,
    /// ISO 8601 timestamp of when credentials were last updated.
    pub updated_at: String,
}

/// A successfully bootstrapped agent session.
#[derive(Debug, Clone)]
pub struct AgentSession {
    /// The persisted credentials.
    pub credentials: AgentCredentials,
    /// The active bearer token for this session.
    pub token: String,
}

/// Configuration for session bootstrapping.
#[derive(Debug, Clone, Default)]
pub struct BootstrapConfig {
    /// Preferred agent name. If not set, the server assigns one.
    pub preferred_name: Option<String>,
    /// Agent type (e.g. "agent", "human"). Defaults to "agent".
    pub agent_type: Option<String>,
    /// Custom base URL. Defaults to https://api.relaycast.dev.
    pub base_url: Option<String>,
    /// Workspace API key from environment or config.
    /// If not set, a new workspace is created.
    pub api_key: Option<String>,
}

/// File-based credential store with atomic writes and Unix permissions.
pub struct CredentialStore {
    path: PathBuf,
}

impl CredentialStore {
    /// Create a new credential store at the given path.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Get the file path for this store.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Load cached credentials from disk.
    /// Returns `None` if the file doesn't exist or can't be parsed.
    pub fn load(&self) -> Option<AgentCredentials> {
        let data = fs::read(&self.path).ok()?;
        serde_json::from_slice(&data).ok()
    }

    /// Save credentials to disk atomically.
    /// Creates parent directories if needed. Sets 0600 permissions on Unix.
    pub fn save(&self, creds: &AgentCredentials) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                RelayError::InvalidResponse(format!("failed to create credential directory: {e}"))
            })?;
        }

        let data = serde_json::to_vec_pretty(creds)?;
        fs::write(&self.path, &data).map_err(|e| {
            RelayError::InvalidResponse(format!("failed to write credentials: {e}"))
        })?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            let _ = fs::set_permissions(&self.path, perms);
        }

        Ok(())
    }
}

fn now_iso8601() -> String {
    // Simple UTC timestamp without chrono dependency.
    // Uses SystemTime which is always available.
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    // Format as simplified ISO 8601
    let days_since_epoch = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Approximate date calculation (good enough for a timestamp)
    let mut year = 1970i64;
    let mut remaining_days = days_since_epoch as i64;
    loop {
        let days_in_year = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) {
            366
        } else {
            365
        };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }
    let is_leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_months: [i64; 12] = [
        31,
        if is_leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    for &dim in &days_in_months {
        if remaining_days < dim {
            break;
        }
        remaining_days -= dim;
        month += 1;
    }
    let day = remaining_days + 1;

    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

/// Bootstrap an agent session using cached credentials or fresh registration.
///
/// Tries these strategies in order:
/// 1. If cached credentials exist with matching name → rotate token
/// 2. If an API key is available (config or cache) → register a new agent
/// 3. If no API key → create a new workspace, then register
///
/// Saves credentials to the store on success.
pub async fn bootstrap_session(
    store: &CredentialStore,
    config: BootstrapConfig,
) -> Result<AgentSession> {
    let cached = store.load();
    let base_url = config.base_url.as_deref();

    // Strategy 1: rotate existing token if we have matching cached creds
    if let Some(ref creds) = cached {
        if let Some(ref cached_name) = creds.agent_name {
            let preferred = config.preferred_name.as_deref().unwrap_or(cached_name);
            if cached_name == preferred {
                let relay = build_relay(&creds.api_key, base_url)?;
                match relay.rotate_agent_token(cached_name).await {
                    Ok(result) => {
                        let session = finish_session(
                            store,
                            creds.workspace_id.clone(),
                            creds.agent_id.clone(),
                            creds.api_key.clone(),
                            Some(cached_name.clone()),
                            result.token,
                        )?;
                        return Ok(session);
                    }
                    Err(e) if e.is_not_found() || e.is_auth_rejection() => {
                        // Fall through to registration
                    }
                    Err(e) if e.is_rate_limited() => {
                        // If we have a cached token, use it
                        if let Some(ref token) = creds.agent_token {
                            return Ok(AgentSession {
                                credentials: creds.clone(),
                                token: token.clone(),
                            });
                        }
                        return Err(e);
                    }
                    Err(e) => return Err(e),
                }
            }
        }
    }

    // Determine API key: config > cached > create workspace
    let (api_key, workspace_id) = if let Some(ref key) = config.api_key {
        (key.clone(), cached.as_ref().map(|c| c.workspace_id.clone()))
    } else if let Some(ref creds) = cached {
        if creds.api_key.starts_with("rk_") {
            (creds.api_key.clone(), Some(creds.workspace_id.clone()))
        } else {
            create_fresh_workspace(base_url).await?
        }
    } else {
        create_fresh_workspace(base_url).await?
    };

    // Strategy 2: register agent with the API key
    let relay = build_relay(&api_key, base_url)?;
    let cached_name = cached.as_ref().and_then(|c| c.agent_name.clone());
    let cached_agent_id = cached
        .as_ref()
        .map(|c| c.agent_id.clone())
        .unwrap_or_default();

    let name = config
        .preferred_name
        .or(cached_name)
        .unwrap_or_else(|| format!("agent-{}", &uuid_v4_short()));

    let agent_type = config.agent_type.unwrap_or_else(|| "agent".into());

    match relay
        .register_agent(CreateAgentRequest {
            name: name.clone(),
            agent_type: Some(agent_type),
            persona: None,
            metadata: None,
        })
        .await
    {
        Ok(result) => {
            let ws_id = workspace_id.unwrap_or_default();
            finish_session(
                store,
                ws_id,
                result.id,
                api_key,
                Some(result.name),
                result.token,
            )
        }
        Err(e) if e.is_conflict() => {
            // Agent name taken — try rotating the existing one
            let rotate_result = relay.rotate_agent_token(&name).await?;
            let ws_id = workspace_id.unwrap_or_default();
            finish_session(
                store,
                ws_id,
                cached_agent_id,
                api_key,
                Some(name),
                rotate_result.token,
            )
        }
        Err(e) if e.is_auth_rejection() => {
            // Cached key is stale — create fresh workspace
            let (fresh_key, fresh_ws_id) = create_fresh_workspace(base_url).await?;
            let fresh_relay = build_relay(&fresh_key, base_url)?;
            let result = fresh_relay
                .register_agent(CreateAgentRequest {
                    name: name.clone(),
                    agent_type: Some("agent".into()),
                    persona: None,
                    metadata: None,
                })
                .await?;
            let ws_id = fresh_ws_id.unwrap_or_default();
            finish_session(
                store,
                ws_id,
                result.id,
                fresh_key,
                Some(result.name),
                result.token,
            )
        }
        Err(e) => Err(e),
    }
}

async fn create_fresh_workspace(base_url: Option<&str>) -> Result<(String, Option<String>)> {
    let ws_name = format!("relay-{}", &uuid_v4_short());
    let result = RelayCast::create_workspace(&ws_name, base_url).await?;
    Ok((result.api_key, Some(result.workspace_id)))
}

fn build_relay(api_key: &str, base_url: Option<&str>) -> Result<RelayCast> {
    let mut opts = RelayCastOptions::new(api_key);
    if let Some(url) = base_url {
        opts = opts.with_base_url(url);
    }
    RelayCast::new(opts)
}

fn finish_session(
    store: &CredentialStore,
    workspace_id: String,
    agent_id: String,
    api_key: String,
    agent_name: Option<String>,
    token: String,
) -> Result<AgentSession> {
    let creds = AgentCredentials {
        workspace_id,
        agent_id,
        api_key,
        agent_name,
        agent_token: Some(token.clone()),
        updated_at: now_iso8601(),
    };
    store.save(&creds)?;
    Ok(AgentSession {
        credentials: creds,
        token,
    })
}

/// Generate a short random hex string (8 chars) for unique naming.
fn uuid_v4_short() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    format!("{:016x}", hasher.finish())[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_store_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("creds.json"));

        let creds = AgentCredentials {
            workspace_id: "ws_123".into(),
            agent_id: "a_456".into(),
            api_key: "rk_live_test".into(),
            agent_name: Some("test-agent".into()),
            agent_token: Some("at_live_token".into()),
            updated_at: "2025-01-01T00:00:00Z".into(),
        };

        store.save(&creds).unwrap();
        let loaded = store.load().unwrap();

        assert_eq!(loaded.workspace_id, "ws_123");
        assert_eq!(loaded.agent_id, "a_456");
        assert_eq!(loaded.api_key, "rk_live_test");
        assert_eq!(loaded.agent_name.as_deref(), Some("test-agent"));
        assert_eq!(loaded.agent_token.as_deref(), Some("at_live_token"));
    }

    #[test]
    fn load_missing_file_returns_none() {
        let store = CredentialStore::new("/tmp/nonexistent-relaycast-test.json");
        assert!(store.load().is_none());
    }

    #[test]
    fn load_corrupt_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.json");
        fs::write(&path, "not-json").unwrap();

        let store = CredentialStore::new(path);
        assert!(store.load().is_none());
    }

    #[test]
    fn now_iso8601_produces_valid_format() {
        let ts = now_iso8601();
        assert!(ts.contains('T'));
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.len(), 20); // "2025-01-01T00:00:00Z"
    }

    #[cfg(unix)]
    #[test]
    fn saved_file_has_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let store = CredentialStore::new(dir.path().join("creds.json"));

        let creds = AgentCredentials {
            workspace_id: "ws".into(),
            agent_id: "a".into(),
            api_key: "rk".into(),
            agent_name: None,
            agent_token: None,
            updated_at: "2025-01-01T00:00:00Z".into(),
        };
        store.save(&creds).unwrap();

        let perms = fs::metadata(store.path()).unwrap().permissions();
        assert_eq!(perms.mode() & 0o777, 0o600);
    }
}
