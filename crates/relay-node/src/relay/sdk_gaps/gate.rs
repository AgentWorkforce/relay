//! The relaygate calls a gate-only install makes besides the Relaycast paths
//! the gate serves: enrolment with the desktop's device token
//! (`POST /v1/register`) or with a launch's one-time credential, and an
//! agent changing, refreshing or removing itself with its own `rg_` token
//! (`PATCH`/`DELETE /v1/agent`, `POST /v1/token/refresh`).
//!
//! They go through the same guarded transport as the SDK (no redirects, the
//! platform's trust, a 30 s timeout) and the same request log, but are read
//! here: the answer may be Relaycast's `{ok,data}` envelope or a bare body
//! ([`crate::relay::node_credential::broker_data`]), and `Retry-After` is
//! read in both its forms ([`retry_after_seconds`]), which the SDK cannot do.
//! Errors are Relaycast-shaped (`{ok:false,error:{code:"relaygate_*",…}}`)
//! and are classified by [`GateError`]. No credential is ever logged: the
//! device token, the `rg_` token and the recovery proof are held in
//! [`Secret`]s or left out of the logged request.

use crate::relay::integrations::retry_after_seconds;
use crate::relay::workspace::{validated_base_url, Secret};
use relaycast::{ClientOptions, RelayError};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fmt;
use std::time::Duration;

/// relaygate's code for a missing, expired or revoked credential: an `rg_`
/// token on any gate call (the cue to register again), or the device token
/// on `POST /v1/register`.
pub const GATE_UNAUTHENTICATED: &str = "relaygate_unauthenticated";
/// No policy rule admits the person, or the device token lacks `cli:auth`.
pub const GATE_DENIED: &str = "relaygate_denied";
/// The name is outside the person's allowed name prefix (or reserved `ctl:`).
pub const GATE_NAME_SCOPE: &str = "relaygate_name_scope";
/// Another person owns the name, or the recovery proof is wrong.
pub const GATE_NAME_TAKEN: &str = "relaygate_name_taken";
/// relaygate cannot reach what it needs to answer; try again later.
pub const GATE_UNAVAILABLE: &str = "relaygate_unavailable";

/// The shortest and longest recovery proof relaygate accepts.
const RECOVERY_CHARS: std::ops::RangeInclusive<usize> = 16..=512;

/// An agent enrolled through relaygate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateRegistration {
    pub agent_id: String,
    /// The policy group the person was mapped to. relaygate answers it as a
    /// JSON number; a numeric string is read too.
    pub gid: u64,
    /// The agent token (`rg_…`) for the gate's Relaycast paths.
    pub token: Secret,
    /// When `token` stops working: fixed when it was issued (the earlier of
    /// the device token's expiry and 24 h after registration).
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub user_id: String,
}

/// `PATCH /v1/agent`: what an agent changes about itself. Absent fields are
/// left as they are (and are not sent). relaygate drops
/// `metadata.relaygate`.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct GateSelfPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<Value>>,
}

/// A failed relaygate call, by what the caller should do about it.
#[derive(Debug)]
pub enum GateError {
    /// 401 `relaygate_unauthenticated`. On any call with an `rg_` token: it
    /// expired or was revoked, so the agent registers again (same name and
    /// recovery). On `POST /v1/register`: the device token was refused.
    Unauthenticated,
    /// 403 `relaygate_denied` or `relaygate_name_scope` (`code` says which):
    /// the person may not enrol this agent; repeating it will not help.
    Refused { code: String },
    /// 409 `relaygate_name_taken`: another person holds the name, or the
    /// recovery proof did not match.
    NameTaken,
    /// 429, Relaycast's rate limit passed through with its `Retry-After`.
    RateLimited { retry_after: Option<Duration> },
    /// 502 or 503 (`relaygate_unavailable`): try again after `retry_after`
    /// when the gate said, else on the caller's own backoff.
    Unavailable { retry_after: Option<Duration> },
    /// A request this client will not send: a gate URL that is not a bare
    /// https origin (http only on loopback), or a recovery proof outside
    /// 16-512 characters.
    Invalid(&'static str),
    /// Anything else, as the SDK would report it.
    Other(Box<RelayError>),
}

impl fmt::Display for GateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GateError::Unauthenticated => write!(f, "relaygate did not accept the credential"),
            GateError::Refused { code } => write!(f, "relaygate refused the agent ({code})"),
            GateError::NameTaken => write!(f, "relaygate: the agent name is taken"),
            GateError::RateLimited { .. } => write!(f, "relaygate is rate limiting requests"),
            GateError::Unavailable { .. } => write!(f, "relaygate is unavailable"),
            GateError::Invalid(what) => write!(f, "{what}"),
            GateError::Other(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for GateError {}

impl From<RelayError> for GateError {
    /// Classifies a Relaycast-shaped failure from the gate, including one
    /// from an SDK call made with an `rg_` token on the gate's Relaycast
    /// paths. Codes are matched only together with their status.
    fn from(error: RelayError) -> GateError {
        let retry_after = || error.retry_after_ms().map(Duration::from_millis);
        match (error.status(), error.code()) {
            _ if is_gate_unauthenticated(&error) => GateError::Unauthenticated,
            (Some(403), Some(code @ (GATE_DENIED | GATE_NAME_SCOPE))) => GateError::Refused {
                code: code.to_string(),
            },
            (Some(409), Some(GATE_NAME_TAKEN)) => GateError::NameTaken,
            (Some(429), _) => GateError::RateLimited {
                retry_after: retry_after(),
            },
            (Some(502 | 503), _) => GateError::Unavailable {
                retry_after: retry_after(),
            },
            _ => GateError::Other(Box::new(error)),
        }
    }
}

/// Whether `error` is relaygate's 401 `relaygate_unauthenticated`. On a
/// call made with an `rg_` token, gate-specific or on the Relaycast paths
/// the gate serves, it means that token expired or was revoked and the agent
/// must register again.
pub(crate) fn is_gate_unauthenticated(error: &RelayError) -> bool {
    error.status() == Some(401) && error.code() == Some(GATE_UNAUTHENTICATED)
}

/// A new recovery proof for an agent's registration: 32 random bytes,
/// base64url without padding (43 characters). relaygate keeps only its
/// SHA-256, for as long as the agent exists, and it cannot be rotated: keep
/// it with the registration and send the same one every time.
pub fn new_recovery() -> Result<Secret, getrandom::Error> {
    use base64::Engine as _;
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)?;
    Ok(Secret::new(
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
    ))
}

/// `POST {gate}/v1/register` with the desktop's device token (`sh_at_…`,
/// with the `cli:auth` scope): enrols `name` and returns its `rg_` token.
///
/// The token's expiry is fixed when it is issued. To renew it, register
/// again before `expires_at` with the same `name` and `recovery`: the agent
/// keeps its `agent_id` and gets a new token, and relaygate revokes the
/// previous `rg_` token and closes that token's sockets, so the caller must
/// switch everything to the new one. A 401 [`GateError::Unauthenticated`] on
/// any later call with the token is the cue to do so.
pub async fn gate_register(
    gate_url: &str,
    device_token: &Secret,
    name: &str,
    recovery: &str,
) -> Result<GateRegistration, GateError> {
    if !RECOVERY_CHARS.contains(&recovery.chars().count()) {
        return Err(GateError::Invalid(
            "A relaygate recovery proof must be 16 to 512 characters.",
        ));
    }
    let body = json!({"name": name, "recovery": recovery});
    // The recovery proof is a secret too: it is never logged.
    let logged = json!({"name": name, "recovery": "[redacted]"});
    let data = call(
        reqwest::Method::POST,
        gate_url,
        "/v1/register",
        device_token,
        Some(body),
        logged,
    )
    .await?;
    registration_of(&data)
}

/// `POST {gate}/v1/register` with a launch's one-time credential
/// (`sh_lt_…`) as the bearer: registers the launched agent `name` and
/// returns its `rg_` token. The body is the name alone, with no recovery
/// proof: the registration is renewed with [`gate_refresh`] and ends with
/// the launch. The credential is spent by this call whatever it answers, so
/// the caller presents it once and never again.
pub async fn gate_register_launch(
    gate_url: &str,
    credential: &Secret,
    name: &str,
) -> Result<GateRegistration, GateError> {
    let body = json!({"name": name});
    let data = call(
        reqwest::Method::POST,
        gate_url,
        "/v1/register",
        credential,
        Some(body.clone()),
        body,
    )
    .await?;
    registration_of(&data)
}

/// A token [`gate_refresh`] issued.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateRefresh {
    /// The new `rg_` token; the one it replaces is revoked at once.
    pub token: Secret,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// `POST {gate}/v1/token/refresh` with an agent's current `rg_` token:
/// relaygate issues a new token for the same agent and revokes this one.
pub async fn gate_refresh(gate_url: &str, token: &Secret) -> Result<GateRefresh, GateError> {
    let data = call(
        reqwest::Method::POST,
        gate_url,
        "/v1/token/refresh",
        token,
        None,
        Value::Null,
    )
    .await?;
    let invalid = |what: &str| GateError::Other(Box::new(RelayError::InvalidResponse(what.into())));
    let field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid(&format!("relaygate refresh without {key}")))
    };
    let token = field("token")?;
    if !token.starts_with("rg_") {
        return Err(invalid("relaygate refresh without an rg_ token"));
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(field("expires_at")?)
        .map_err(|_| invalid("relaygate refresh with an unreadable expires_at"))?
        .with_timezone(&chrono::Utc);
    Ok(GateRefresh {
        token: Secret::new(token.to_string()),
        expires_at,
    })
}

/// `PATCH {gate}/v1/agent` with the agent's own `rg_` token: relaygate
/// applies it to that agent only. Returns the agent as the gate answers it.
pub async fn gate_patch_self(
    gate_url: &str,
    token: &Secret,
    patch: &GateSelfPatch,
) -> Result<Value, GateError> {
    let body =
        serde_json::to_value(patch).map_err(|error| GateError::Other(Box::new(error.into())))?;
    call(
        reqwest::Method::PATCH,
        gate_url,
        "/v1/agent",
        token,
        Some(body.clone()),
        body,
    )
    .await
}

/// `DELETE {gate}/v1/agent` with the agent's own `rg_` token: removes the
/// agent upstream, revokes its `rg_` tokens and closes its sockets. The
/// same person can register the name again with the same recovery proof
/// and gets the same `agent_id` back.
pub async fn gate_delete_self(gate_url: &str, token: &Secret) -> Result<(), GateError> {
    call(
        reqwest::Method::DELETE,
        gate_url,
        "/v1/agent",
        token,
        None,
        Value::Null,
    )
    .await
    .map(drop)
}

/// One attempt of `method path` at the gate with `credential`; never
/// retried here (a register is not idempotent until its answer is read, and
/// the caller owns the backoff). `logged` is what the request log records
/// in place of `body`.
async fn call(
    method: reqwest::Method,
    gate_url: &str,
    path: &str,
    credential: &Secret,
    body: Option<Value>,
    logged: Value,
) -> Result<Value, GateError> {
    let gate = validated_base_url(gate_url).ok_or(GateError::Invalid(
        "The relaygate URL must be a bare https origin.",
    ))?;
    let url = format!("{gate}{path}");
    let observed = crate::relay::request_log::observe(
        method.as_str(),
        &url,
        logged,
        credential.expose(),
        async {
            let options = ClientOptions::new(credential.expose()).with_base_url(&gate);
            let transport = crate::relay::sdk_http::guarded_transport(&options)?;
            let mut request = transport
                .request(method.clone(), &url)
                .bearer_auth(credential.expose())
                .header("X-Relaycast-Origin-Client", "relay-desktop")
                .header("X-Relaycast-Origin-Version", crate::VERSION);
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = request.send().await?;
            let status = response.status().as_u16();
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let request_id = header("x-request-id").or_else(|| header("x-correlation-id"));
            let retry_after_ms = header("retry-after")
                .and_then(|value| retry_after_seconds(&value, chrono::Utc::now()))
                .map(|seconds| seconds.saturating_mul(1_000));
            let bytes = response.bytes().await?;
            if (200..300).contains(&status) && bytes.trim_ascii().is_empty() {
                // `DELETE` may answer 200 with no body.
                return Ok(Value::Null);
            }
            crate::relay::node_credential::broker_data(status, &bytes, request_id, retry_after_ms)
        },
    )
    .await;
    observed.map_err(GateError::from)
}

fn registration_of(data: &Value) -> Result<GateRegistration, GateError> {
    let invalid = |what: &str| GateError::Other(Box::new(RelayError::InvalidResponse(what.into())));
    let field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| invalid(&format!("relaygate registration without {key}")))
    };
    let token = field("token")?;
    if !token.starts_with("rg_") {
        return Err(invalid("relaygate registration without an rg_ token"));
    }
    let expires_at = chrono::DateTime::parse_from_rfc3339(&field("expires_at")?)
        .map_err(|_| invalid("relaygate registration with an unreadable expires_at"))?
        .with_timezone(&chrono::Utc);
    let gid = match data.get("gid") {
        Some(Value::Number(number)) => number.as_u64(),
        Some(Value::String(text)) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
    .ok_or_else(|| invalid("relaygate registration without a numeric gid"))?;
    Ok(GateRegistration {
        agent_id: field("agent_id")?,
        gid,
        token: Secret::new(token),
        expires_at,
        user_id: field("user_id")?,
    })
}

#[cfg(test)]
mod tests;
