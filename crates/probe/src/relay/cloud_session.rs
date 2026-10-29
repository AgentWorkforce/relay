//! Access to Agent Relay Cloud with the signed-in person's own session.
//!
//! Messaging, people and integrations only name the API route they need,
//! through a `CloudAccess`; `relay::account` is the daemon's, `SignedOut`
//! answers `not_signed_in` everywhere. This module holds the Cloud calls the
//! session itself is made of: refresh, the browser handoff exchange, revoke,
//! `whoami`, the workspace resolve, and where the session is kept.
//!
//! The session is kept in the agent store's `cloudSession`, on both
//! platforms; the probe's own RelayHistory renewal reads it there too
//! (`crate::cloud`). The official `agent-relay` CLI's session is read,
//! never written: refreshing it would rotate that CLI's tokens out from
//! under it.

use crate::relay::cloud_http::{self, Answer};
use crate::relay::store::{CloudSession, CloudWorkspace};
use crate::relay::workspace::{is_workspace_key, validated_base_url, Secret, DEFAULT_BASE_URL};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The signed-in account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudAccount {
    /// The Agent Relay site, e.g. `https://agentrelay.com`.
    pub site_url: String,
    /// The Agent Relay (Cloud) workspace this computer is connected to.
    pub workspace_id: String,
    /// The signed-in person's Cloud user id.
    pub user_id: Option<String>,
}

/// The attached install's person and workspace, whom session agents are
/// registered for. Relaycast credits an agent's messages to
/// `cloud_user_id`; `owner_hash` groups agents under people on the roster.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentOwner {
    pub user_id: String,
    pub workspace_id: Option<String>,
}

impl AgentOwner {
    /// The registration metadata naming this owner. An unknown workspace is
    /// `null`, so Relaycast's merging update replaces a previous owner's.
    pub fn metadata(&self) -> serde_json::Map<String, Value> {
        let mut metadata = serde_json::Map::new();
        metadata.insert("cloud_user_id".into(), json!(self.user_id));
        metadata.insert("cloud_workspace_id".into(), json!(self.workspace_id));
        metadata.insert(
            "owner_hash".into(),
            json!(crate::relay::people::identity_hash(&self.user_id)),
        );
        metadata
    }
}

/// Why a Cloud request failed. Messages are safe to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloudError {
    /// No sign-in to act with.
    SignedOut,
    /// Cloud refused the session even after a refresh.
    Rejected,
    /// Cloud answered with an error status; `message` is Cloud's own text,
    /// when it sent one and it is not an internal error.
    Status {
        status: u16,
        message: Option<String>,
    },
    /// Cloud could not be reached, or answered with something unreadable.
    Unreachable,
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudError::SignedOut => f.write_str("Sign in to Agent Relay first."),
            CloudError::Rejected => f.write_str("Agent Relay needs you to sign in again."),
            CloudError::Status {
                message: Some(message),
                ..
            } => f.write_str(message),
            CloudError::Status { status, .. } => {
                write!(
                    f,
                    "Agent Relay could not complete the request (HTTP {status})."
                )
            }
            CloudError::Unreachable => f.write_str("Agent Relay could not be reached."),
        }
    }
}

impl std::error::Error for CloudError {}

pub trait CloudAccess: Send + Sync + 'static {
    /// The signed-in account, or `None`.
    fn account(&self) -> Option<CloudAccount>;

    /// Whom session agents are registered for: the attached install's
    /// person, or `None` while no install is attached.
    fn agent_owner(&self) -> Option<AgentOwner>;

    /// Whether the desktop identity sync may hand this computer's agent
    /// tokens to Cloud with the session `request` would use now: not when
    /// that session may be another person's.
    fn may_sync_identities(&self) -> bool {
        true
    }

    /// Changes when a new sign-in may supply different authorization for
    /// desktop identity sync. It is deliberately opaque and contains no
    /// credential material.
    fn identity_sync_generation(&self) -> u64 {
        0
    }

    /// `method path` against `<site>/cloud/api/v1` (so `path` is e.g.
    /// `/members`), with the account's bearer, refreshed once if Cloud
    /// refuses it. Resolves to the JSON body of a 2xx answer (`Null` when
    /// empty). Never follows a redirect.
    fn request(
        &self,
        method: &'static str,
        path: String,
        body: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>>;

    /// The site and bearer `request` would go out with now, held so several
    /// requests are made with one credential: `api` with them is never
    /// retried with another. With `refused`, a bearer Cloud refused, the
    /// session renewed as `request` would renew it. `None` when signed out.
    fn credential(&self, _refused: Option<Secret>) -> BoxFuture<'_, Option<(String, Secret)>> {
        Box::pin(async { None })
    }
}

/// Not signed in.
pub struct SignedOut;

impl CloudAccess for SignedOut {
    fn account(&self) -> Option<CloudAccount> {
        None
    }

    fn agent_owner(&self) -> Option<AgentOwner> {
        None
    }

    fn request(
        &self,
        _: &'static str,
        _: String,
        _: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        Box::pin(async { Err(CloudError::SignedOut) })
    }
}

/// `value` as one URL path segment.
pub fn segment(value: &str) -> String {
    crate::relay::sdk_gaps::segment(value)
}

/// How long a Cloud call may take.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Skip's routes wait on a model call that takes up to a minute.
pub const SKIP_TIMEOUT: Duration = Duration::from_secs(120);

/// How long `path` (relative to the API base) may take.
pub fn timeout_for(path: &str) -> Duration {
    if path.contains("/skip/") {
        SKIP_TIMEOUT
    } else {
        REQUEST_TIMEOUT
    }
}

/// `<site>/cloud/api/v1`.
pub fn api_base(site_url: &str) -> String {
    format!("{site_url}/cloud/api/v1")
}

fn expiry_ms(value: Option<&str>) -> Option<i64> {
    value.and_then(crate::parse_iso_ms)
}

/// An ISO-8601 time, to the second, in UTC.
pub fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Whether the access token has at least `margin` left. A token without an
/// expiry is trusted until Cloud refuses it.
pub fn access_is_fresh(session: &CloudSession, margin: Duration, now: i64) -> bool {
    expiry_ms(session.access_token_expires_at.as_deref())
        .is_none_or(|expires| expires - now > margin.as_millis() as i64)
}

/// Whether the session has a refresh token that has not expired.
pub fn can_refresh(session: &CloudSession, now: i64) -> bool {
    session
        .refresh_token
        .as_ref()
        .is_some_and(|token| !token.expose().is_empty())
        && expiry_ms(session.refresh_token_expires_at.as_deref()).is_none_or(|e| e > now)
}

fn string(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn status_error(answer: &Answer) -> CloudError {
    if answer.status == 401 {
        return CloudError::Rejected;
    }
    CloudError::Status {
        status: answer.status,
        message: (answer.status < 500).then(|| answer.message()).flatten(),
    }
}

/// `method <site>/cloud/api/v1<path>` with `bearer`; the JSON of a 2xx
/// answer (`Null` when empty), else why not.
pub async fn api(
    site_url: &str,
    bearer: &Secret,
    method: &'static str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, CloudError> {
    let answer = cloud_http::send(
        method,
        format!("{}{path}", api_base(site_url)),
        Some(bearer.expose().to_string()),
        body,
        timeout_for(path),
    )
    .await
    .map_err(|_| CloudError::Unreachable)?;
    if answer.ok() {
        Ok(answer.body)
    } else {
        Err(status_error(&answer))
    }
}

/// Trades the refresh token for a new session. Cloud rotates the refresh
/// token on every use, so the result replaces the old session.
pub async fn refresh(session: &CloudSession) -> Result<CloudSession, CloudError> {
    let (Some(refresh), Some(site)) = (
        session.refresh_token.clone(),
        validated_base_url(&session.site_url),
    ) else {
        return Err(CloudError::Rejected);
    };
    let answer = cloud_http::send(
        "POST",
        format!("{}/auth/token/refresh", api_base(&site)),
        None,
        Some(json!({ "refreshToken": refresh.expose() })),
        REQUEST_TIMEOUT,
    )
    .await
    .map_err(|_| CloudError::Unreachable)?;
    if !answer.ok() {
        // Only a refused refresh token ends the session; a rate limit, a
        // timeout or an outage leaves it for a later try.
        return Err(match answer.status {
            400 | 401 | 403 => CloudError::Rejected,
            _ => status_error(&answer),
        });
    }
    let body = answer.inner();
    let Some(access) = string(body, "accessToken") else {
        return Err(CloudError::Unreachable);
    };
    Ok(CloudSession {
        access_token: Secret::new(access),
        access_token_expires_at: string(body, "accessTokenExpiresAt"),
        refresh_token: string(body, "refreshToken")
            .map(Secret::new)
            .or(Some(refresh)),
        refresh_token_expires_at: string(body, "refreshTokenExpiresAt")
            .or(session.refresh_token_expires_at.clone()),
        site_url: site,
    })
}

/// Trades the browser sign-in's short-lived handoff token for a renewable
/// session. The handoff arrives on a loopback redirect, so Cloud keeps the
/// refresh token out of it; `code_verifier` proves this core opened that
/// sign-in (it matches the challenge on the login URL). Single use.
pub async fn exchange_handoff(
    handoff: &CloudSession,
    code_verifier: &Secret,
) -> Result<CloudSession, CloudError> {
    let site = validated_base_url(&handoff.site_url).ok_or(CloudError::Rejected)?;
    let answer = cloud_http::send(
        "POST",
        format!("{}/auth/desktop/session", api_base(&site)),
        Some(handoff.access_token.expose().to_string()),
        Some(json!({ "codeVerifier": code_verifier.expose() })),
        Duration::from_secs(10),
    )
    .await
    .map_err(|_| CloudError::Unreachable)?;
    if !answer.ok() {
        return Err(status_error(&answer));
    }
    let body = answer.inner();
    let (Some(access), Some(refresh)) = (string(body, "accessToken"), string(body, "refreshToken"))
    else {
        return Err(CloudError::Status {
            status: answer.status,
            message: Some("Agent Relay did not return a renewable session.".into()),
        });
    };
    Ok(CloudSession {
        access_token: Secret::new(access),
        access_token_expires_at: string(body, "accessTokenExpiresAt"),
        refresh_token: Some(Secret::new(refresh)),
        refresh_token_expires_at: string(body, "refreshTokenExpiresAt"),
        site_url: site,
    })
}

/// Revokes a refresh token so it cannot be used again. Best effort.
pub async fn revoke(session: &CloudSession) {
    let (Some(refresh), Some(site)) = (
        session.refresh_token.as_ref(),
        validated_base_url(&session.site_url),
    ) else {
        return;
    };
    let _ = cloud_http::send(
        "POST",
        format!("{}/auth/token/revoke", api_base(&site)),
        None,
        Some(json!({ "token": refresh.expose() })),
        Duration::from_secs(10),
    )
    .await;
}

/// Who a Cloud bearer belongs to. `current_workspace_id` is Cloud's current
/// workspace: a default, never an authorization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub user_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub current_workspace_id: Option<String>,
    pub current_workspace_name: Option<String>,
    pub workspace_count: Option<u64>,
    pub current_workspace_avatar_url: Option<String>,
}

/// `GET /auth/whoami`.
pub async fn whoami(site_url: &str, bearer: &Secret) -> Result<Identity, CloudError> {
    whoami_with_analytics(site_url, bearer, false).await
}

/// Authenticated bootstrap may request Cloud-owned profile repair. This opt-in
/// carries no claimed user or profile properties; Cloud resolves the bearer.
/// Ordinary authorization lookups do not implicitly request analytics.
pub async fn whoami_with_analytics(
    site_url: &str,
    bearer: &Secret,
    analytics_enabled: bool,
) -> Result<Identity, CloudError> {
    let url = format!("{}/auth/whoami", api_base(site_url));
    let bearer = bearer.clone();
    let answer = tokio::task::spawn_blocking(move || {
        let headers = if analytics_enabled {
            vec![("X-Agent-Relay-Analytics", "enabled")]
        } else {
            Vec::new()
        };
        cloud_http::send_blocking_with_headers(
            "GET",
            &url,
            Some(bearer.expose()),
            &headers,
            None,
            REQUEST_TIMEOUT,
        )
    })
    .await
    .map_err(|_| CloudError::Unreachable)?
    .map_err(|_| CloudError::Unreachable)?;
    if !answer.ok() {
        return Err(status_error(&answer));
    }
    let value = answer.body;
    let value = match value.get("data") {
        Some(data) if data.is_object() => data.clone(),
        _ => value,
    };
    let user = &value["user"];
    let current = if value["current_workspace"].is_object() {
        &value["current_workspace"]
    } else {
        &value["currentWorkspace"]
    };
    let user_id = string(user, "id").ok_or(CloudError::Status {
        status: 200,
        message: Some("Agent Relay did not say who is signed in.".into()),
    })?;
    Ok(Identity {
        user_id,
        email: string(user, "email"),
        name: string(user, "name"),
        avatar_url: string(user, "avatarUrl").or(string(user, "avatar_url")),
        current_workspace_id: string(current, "id"),
        current_workspace_name: string(current, "name"),
        workspace_count: value["workspaceCount"].as_u64(),
        current_workspace_avatar_url: string(&value["currentOrganization"], "avatarUrl").or_else(
            || {
                let domain = string(&value["currentOrganization"], "avatarDomain")?;
                if domain.is_empty()
                    || !domain
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
                {
                    return None;
                }
                Some(format!("https://{domain}/favicon.ico"))
            },
        ),
    })
}

/// Whether `id` is an Agent Relay workspace id (a UUID), the only form the
/// resolve route takes.
pub fn is_workspace_uuid(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12])
        && groups
            .iter()
            .all(|g| g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Why the account's workspace could not be resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolveError {
    /// Not an Agent Relay workspace id.
    InvalidWorkspace,
    /// The workspace shares no Relaycast key with this account.
    NoKey,
    Cloud(CloudError),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::InvalidWorkspace => f.write_str("That is not an Agent Relay workspace."),
            ResolveError::NoKey => f.write_str(
                "Your Agent Relay workspace did not share an Agent Relay key with this account. Ask a workspace owner, or paste a key.",
            ),
            ResolveError::Cloud(error) => error.fmt(f),
        }
    }
}

/// The Relaycast workspace behind the account's Agent Relay workspace:
/// `GET /workspaces/{id}/resolve`. Only a workspace key and a validated
/// origin are accepted.
pub async fn resolve_workspace(
    site_url: &str,
    bearer: &Secret,
    workspace_id: &str,
) -> Result<CloudWorkspace, ResolveError> {
    if !is_workspace_uuid(workspace_id) {
        return Err(ResolveError::InvalidWorkspace);
    }
    let id = workspace_id.to_ascii_lowercase();
    let value = api(
        site_url,
        bearer,
        "GET",
        &format!("/workspaces/{id}/resolve"),
        None,
    )
    .await
    .map_err(ResolveError::Cloud)?;
    decode_resolution(&value, &id)
}

mod recovery;
pub use recovery::resolve_workspace_for_recovery;

/// Reads a resolve answer, bare or in a `data` envelope.
pub fn decode_resolution(
    value: &Value,
    workspace_id: &str,
) -> Result<CloudWorkspace, ResolveError> {
    let value = match value.get("data") {
        Some(data) if data.is_object() => data,
        _ => value,
    };
    let key = value["relaycastApiKey"]
        .as_str()
        .map(str::trim)
        .filter(|key| is_workspace_key(key))
        .ok_or(ResolveError::NoKey)?;
    let base_url = value["urls"]["relaycastUrl"]
        .as_str()
        .and_then(validated_base_url)
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    Ok(CloudWorkspace {
        key: Secret::new(key),
        base_url,
        workspace_id: string(value, "relaycastWorkspaceId")
            .or(string(value, "workspaceId"))
            .or(Some(workspace_id.to_string())),
        account_workspace_id: Some(workspace_id.to_string()),
        name: string(value, "name"),
        relayfile_workspace_id: string(value, "relayfileWorkspaceId"),
    })
}

/// The official `agent-relay` CLI's session for `site_url`, while its
/// access token has more than a minute left. Read only.
pub fn cli_session(relay_home: &Path, site_url: &str, now: i64) -> Option<CloudSession> {
    let value: Value =
        serde_json::from_slice(&fs::read(relay_home.join("cloud-auth.json")).ok()?).ok()?;
    let api = value["apiUrl"].as_str()?.trim().trim_end_matches('/');
    if api != format!("{site_url}/cloud") {
        return None;
    }
    let token = string(&value, "accessToken")?;
    let expires = string(&value, "accessTokenExpiresAt");
    let session = CloudSession {
        access_token: Secret::new(token),
        access_token_expires_at: expires.clone(),
        refresh_token: None,
        refresh_token_expires_at: None,
        site_url: site_url.to_string(),
    };
    // Without an expiry the CLI's token is not trusted: it may be long dead.
    (expiry_ms(expires.as_deref()).is_some()
        && access_is_fresh(&session, Duration::from_secs(60), now))
    .then_some(session)
}

/// Linux's former `cloud-session.json`, in the format `cloud_auth.py` wrote:
/// `{"apiUrl", "accessToken", "accessTokenExpiresAt", "refreshToken",
/// "refreshTokenExpiresAt"}`. Read once, to import it into the store.
pub struct SessionFile {
    pub path: PathBuf,
}

impl SessionFile {
    pub fn new(app_data_dir: &Path) -> SessionFile {
        SessionFile {
            path: app_data_dir.join("cloud-session.json"),
        }
    }

    pub fn load(&self) -> Option<CloudSession> {
        let value: Value = serde_json::from_slice(&fs::read(&self.path).ok()?).ok()?;
        let api = value["apiUrl"].as_str()?.trim().trim_end_matches('/');
        let site = validated_base_url(api.strip_suffix("/cloud")?)?;
        Some(CloudSession {
            access_token: Secret::new(string(&value, "accessToken")?),
            access_token_expires_at: string(&value, "accessTokenExpiresAt"),
            refresh_token: string(&value, "refreshToken").map(Secret::new),
            refresh_token_expires_at: string(&value, "refreshTokenExpiresAt"),
            site_url: site,
        })
    }

    pub fn remove(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_owner_without_a_workspace_clears_the_previous_one() {
        let owner = AgentOwner {
            user_id: "user-1".into(),
            workspace_id: None,
        };
        let metadata = owner.metadata();
        assert_eq!(metadata["cloud_user_id"], "user-1");
        assert_eq!(metadata["cloud_workspace_id"], Value::Null);
        assert_eq!(
            metadata["owner_hash"],
            json!(crate::relay::people::identity_hash("user-1"))
        );
    }

    fn session(
        expires: Option<&str>,
        refresh: Option<&str>,
        refresh_expires: Option<&str>,
    ) -> CloudSession {
        CloudSession {
            access_token: Secret::new("access"),
            access_token_expires_at: expires.map(str::to_string),
            refresh_token: refresh.map(Secret::new),
            refresh_token_expires_at: refresh_expires.map(str::to_string),
            site_url: "https://agentrelay.com".into(),
        }
    }

    #[test]
    fn freshness_follows_the_expiry_and_trusts_a_token_without_one() {
        let now = crate::parse_iso_ms("2026-09-30T10:00:00Z").unwrap();
        let margin = Duration::from_secs(300);
        assert!(access_is_fresh(&session(None, None, None), margin, now));
        assert!(access_is_fresh(
            &session(Some("2026-09-30T10:10:00Z"), None, None),
            margin,
            now
        ));
        assert!(!access_is_fresh(
            &session(Some("2026-09-30T10:04:00Z"), None, None),
            margin,
            now
        ));
        assert!(!access_is_fresh(
            &session(Some("2026-09-30T09:00:00.000Z"), None, None),
            margin,
            now
        ));
    }

    #[test]
    fn only_a_live_refresh_token_can_refresh() {
        let now = crate::parse_iso_ms("2026-09-30T10:00:00Z").unwrap();
        assert!(!can_refresh(&session(None, None, None), now));
        assert!(!can_refresh(&session(None, Some(""), None), now));
        assert!(can_refresh(&session(None, Some("r"), None), now));
        assert!(can_refresh(
            &session(None, Some("r"), Some("2026-12-01T00:00:00Z")),
            now
        ));
        assert!(!can_refresh(
            &session(None, Some("r"), Some("2026-09-01T00:00:00Z")),
            now
        ));
    }

    #[test]
    fn a_resolution_takes_only_a_workspace_key_and_a_valid_origin() {
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        let resolved = decode_resolution(
            &json!({"data": {"relaycastApiKey": "rk_live_abcdefgh1234", "name": "Acme",
                "relaycastWorkspaceId": "rw_1", "relayfileWorkspaceId": "rf_1",
                "urls": {"relaycastUrl": "https://cast.agentrelay.com/"}}}),
            id,
        )
        .unwrap();
        assert_eq!(resolved.key.expose(), "rk_live_abcdefgh1234");
        assert_eq!(resolved.base_url, "https://cast.agentrelay.com");
        assert_eq!(resolved.workspace_id.as_deref(), Some("rw_1"));
        assert_eq!(resolved.account_workspace_id.as_deref(), Some(id));
        assert_eq!(resolved.relayfile_workspace_id.as_deref(), Some("rf_1"));
        assert_eq!(resolved.name.as_deref(), Some("Acme"));

        let untrusted = decode_resolution(
            &json!({"relaycastApiKey": "rk_live_abcdefgh1234", "urls": {"relaycastUrl": "http://evil.example"}}),
            id,
        )
        .unwrap();
        assert_eq!(untrusted.base_url, DEFAULT_BASE_URL);
        assert_eq!(untrusted.workspace_id.as_deref(), Some(id));
        assert_eq!(
            decode_resolution(&json!({"relaycastApiKey": "at_live_agenttoken"}), id),
            Err(ResolveError::NoKey)
        );
        assert_eq!(decode_resolution(&json!({}), id), Err(ResolveError::NoKey));
    }

    #[test]
    fn only_uuids_are_workspace_ids() {
        assert!(is_workspace_uuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(is_workspace_uuid("0F8FAD5B-D9CB-469F-A165-70867728950E"));
        assert!(!is_workspace_uuid("acme"));
        assert!(!is_workspace_uuid("../../members"));
        assert!(!is_workspace_uuid("0f8fad5b-d9cb-469f-a165-70867728950"));
    }

    #[test]
    fn the_cli_session_is_used_only_for_the_same_site_with_life_left() {
        let home = tempfile::tempdir().unwrap();
        let now = crate::parse_iso_ms("2026-09-30T10:00:00Z").unwrap();
        let write = |api: &str, expires: Option<&str>| {
            let mut value = json!({"apiUrl": api, "accessToken": "cli-token"});
            if let Some(expires) = expires {
                value["accessTokenExpiresAt"] = json!(expires);
            }
            fs::write(home.path().join("cloud-auth.json"), value.to_string()).unwrap();
        };
        write(
            "https://agentrelay.com/cloud/",
            Some("2026-09-30T11:00:00Z"),
        );
        let found = cli_session(home.path(), "https://agentrelay.com", now).unwrap();
        assert_eq!(found.access_token.expose(), "cli-token");
        assert!(found.refresh_token.is_none());
        assert!(cli_session(home.path(), "https://other.example", now).is_none());
        write("https://agentrelay.com/cloud", Some("2026-09-30T10:00:30Z"));
        assert!(cli_session(home.path(), "https://agentrelay.com", now).is_none());
        write("https://agentrelay.com/cloud", None);
        assert!(cli_session(home.path(), "https://agentrelay.com", now).is_none());
    }

    #[test]
    fn the_former_linux_session_file_is_read_in_cloud_auth_s_format() {
        let dir = tempfile::tempdir().unwrap();
        let file = SessionFile::new(dir.path());
        assert!(file.load().is_none());
        fs::write(
            &file.path,
            json!({"apiUrl": "https://agentrelay.com/cloud/", "accessToken": "access",
                   "accessTokenExpiresAt": "2026-09-30T11:00:00Z", "refreshToken": "refresh"})
            .to_string(),
        )
        .unwrap();
        let kept = file.load().unwrap();
        assert_eq!(kept.site_url, "https://agentrelay.com");
        assert_eq!(kept.refresh_token.unwrap().expose(), "refresh");
        file.remove();
        assert!(!file.path.exists());
    }
}

/// Membership choices for the native welcome screen, before any setup runs.
pub async fn desktop_workspaces(
    site: &str,
    bearer: &Secret,
) -> Result<Vec<crate::relay::state::WorkspaceChoice>, CloudError> {
    let value = api(site, bearer, "GET", "/auth/desktop/workspaces", None).await?;
    serde_json::from_value(value["workspaces"].clone()).map_err(|_| CloudError::Unreachable)
}

pub async fn select_desktop_workspace(
    site: &str,
    bearer: &Secret,
    workspace: &str,
) -> Result<CloudSession, CloudError> {
    let value = api(
        site,
        bearer,
        "POST",
        "/auth/desktop/workspaces",
        Some(json!({"workspaceId": workspace})),
    )
    .await?;
    Ok(CloudSession {
        access_token: Secret::new(string(&value, "accessToken").ok_or(CloudError::Unreachable)?),
        access_token_expires_at: string(&value, "accessTokenExpiresAt"),
        refresh_token: Some(Secret::new(
            string(&value, "refreshToken").ok_or(CloudError::Unreachable)?,
        )),
        refresh_token_expires_at: string(&value, "refreshTokenExpiresAt"),
        site_url: site.to_string(),
    })
}
