//! Access to Agent Relay Cloud with the signed-in person's own session.
//!
//! Messaging, people and integrations only name the API route they need,
//! through a `CloudAccess`; a build's account implements it, and `SignedOut`
//! answers `not_signed_in` everywhere. This module holds what the core itself
//! calls: session refresh and `whoami`.

use crate::relay::cloud_http::{self, Answer};
use crate::relay::contract::plan::{parse_workspace_plan, WorkspacePlan};
use crate::relay::store::CloudSession;
use crate::relay::workspace::{validated_base_url, Secret};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
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

pub fn status_error(answer: &Answer) -> CloudError {
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
    /// The workspace's Agent Relay plan; `None` when the organization has
    /// none, and on a Cloud that does not report one.
    pub current_workspace_plan: Option<WorkspacePlan>,
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
    identity_from_whoami(answer.body)
}

/// A whoami body as an identity; `data` may wrap it.
pub fn identity_from_whoami(value: Value) -> Result<Identity, CloudError> {
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
        current_workspace_plan: parse_workspace_plan(&current["plan"]),
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn whoami_reads_the_workspace_plan_and_tolerates_a_cloud_without_one() {
        // Cloud's route keys the workspace `currentWorkspace` (camelCase) with
        // snake_case fields inside; the plan hangs off that same object.
        let plan_value = json!({
            "key": "intro", "name": "Intro",
            "limits": {"devices": 5, "agents": 15, "humans": 2, "session_retention_days": 7},
            "upgrade_url": "https://agentrelay.com/cloud/dashboard/settings#billing"
        });
        let identity = identity_from_whoami(json!({
            "user": {"id": "user_1", "email": "ada@example.com"},
            "currentWorkspace": {
                "id": "0f8fad5b-d9cb-469f-a165-70867728950e", "name": "Acme",
                "plan": plan_value
            }
        }))
        .unwrap();
        let plan = identity.current_workspace_plan.unwrap();
        assert_eq!(plan.key, "intro");
        assert_eq!(plan.limits.agents, Some(15));
        assert_eq!(plan.limits.session_retention_days, Some(7));
        assert_eq!(
            plan.upgrade_url.as_deref(),
            Some("https://agentrelay.com/cloud/dashboard/settings#billing")
        );
        assert_eq!(identity.current_workspace_name.as_deref(), Some("Acme"));
        // The snake_case spelling reads the same.
        let snake = identity_from_whoami(json!({
            "user": {"id": "user_1"},
            "current_workspace": {"id": "ws", "name": "Acme", "plan": plan_value}
        }))
        .unwrap();
        assert_eq!(snake.current_workspace_plan.as_ref(), Some(&plan));

        // `plan: null` (no active plan) and an older Cloud without the field,
        // under either key.
        for (key, current) in [
            (
                "currentWorkspace",
                json!({"id": "ws", "name": "Acme", "plan": null}),
            ),
            ("currentWorkspace", json!({"id": "ws", "name": "Acme"})),
            (
                "current_workspace",
                json!({"id": "ws", "name": "Acme", "plan": null}),
            ),
        ] {
            let identity =
                identity_from_whoami(json!({"user": {"id": "user_1"}, key: current})).unwrap();
            assert_eq!(identity.current_workspace_plan, None);
            assert_eq!(identity.current_workspace_id.as_deref(), Some("ws"));
        }
        // Wrapped in `data`, and without a current workspace at all.
        let identity = identity_from_whoami(json!({"data": {"user": {"id": "user_1"}}})).unwrap();
        assert_eq!(identity.current_workspace_plan, None);
        assert_eq!(identity.current_workspace_id, None);
        assert!(matches!(
            identity_from_whoami(json!({"user": {}})),
            Err(CloudError::Status { status: 200, .. })
        ));
    }

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
}
