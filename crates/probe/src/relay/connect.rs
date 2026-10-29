//! Accountless, session-scoped Relay Connect credentials and delivery.
//!
//! These credentials deliberately never enter `Store::registrations` or its
//! name-keyed token map: an existing team agent may have the same name, and
//! Cloud identity reconciliation and workspace-key removal only see team
//! registrations.

use crate::relay::client;
use crate::relay::cloud_http;
use crate::relay::codex::processes::needs_probe_reply_client;
use crate::relay::connect_presence::{read_cloud_roster, RosterEntry};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::{self, Decision, MessageRef};
use crate::relay::delivery::{preview, DeliveryActivity, DeliveryOutcome, DeliverySettlement};
use crate::relay::inject::InjectOutcome;
use crate::relay::outbound::{
    probe_client, probe_socket_command_with_body, query_encode, shell_quote, OutboundError,
};
use crate::relay::outbox::{create_private_dir, write_atomic};
use crate::relay::peer::current_uid;
use crate::relay::process::SystemProcesses;
use crate::relay::store::random_uuid;
use crate::relay::store::{SessionKind, Target};
use crate::relay::workspace::Secret;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub const CONNECT_STORE_FILE: &str = "connect-sessions.json";
const CONNECT_JOIN_TIMEOUT: Duration = Duration::from_secs(45);
const CONNECT_JOIN_ATTEMPT_TTL_MS: i64 = 15 * 60 * 1_000;
const CONNECT_OUTCOMES_KEPT: usize = 64;
const CONNECT_HANDOFF_TTL_MS: i64 = 60 * 60 * 1_000;
const CONNECT_HANDOFF_TTL_ENV: &str = "AGENT_RELAY_CONNECT_HANDOFF_TIMEOUT_SECONDS";
const CONNECT_RETRY_MIN_MS: i64 = 5_000;
const CONNECT_RETRY_MAX_MS: i64 = 30_000;

fn heartbeat_due(last_ms: Option<i64>, now_ms: i64, interval: Duration) -> bool {
    last_ms.is_none_or(|last| {
        now_ms.saturating_sub(last) >= i64::try_from(interval.as_millis()).unwrap_or(i64::MAX)
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConnectHost {
    pub person: String,
    pub agent_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Participant {
    pub agent_name: String,
    pub role: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct JoinedParticipant {
    pub agent_name: String,
    pub agent_id: String,
    pub role: String,
    pub token: Secret,
    pub relay_base_url: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct JoinResponse {
    pub connect_id: String,
    pub task: String,
    pub expires_at: String,
    pub host: ConnectHost,
    pub participant: JoinedParticipant,
    pub participants: Vec<Participant>,
}

/// A small seam for fake join servers in route tests.
pub trait ConnectJoinClient: Send + Sync + 'static {
    fn join(
        &self,
        link: &str,
        name: Option<&str>,
        host_claim: Option<&str>,
        idempotency_key: &str,
    ) -> Result<JoinResponse, OutboundError>;

    /// Reads the public invite after Relaycast rejects this Connect's token,
    /// distinguishing a destroyed workspace from a transient auth failure.
    fn availability(&self, connect_id: &str) -> Result<ConnectAvailability, OutboundError>;

    /// Reads Cloud's participant-authenticated roster, the one source of
    /// presence a participant token may read.
    fn roster(&self, connect_id: &str, token: &Secret) -> Result<Vec<RosterEntry>, OutboundError>;
}

pub struct CloudJoinClient;

/// Writes why a Relay Connect call failed to stderr and the core's rotating
/// diagnostic log. The Connect is named by a hash; tokens, host claims and
/// message text are never written.
pub(crate) fn log_connect_failure(operation: &str, connect_id: &str, code: &str, cause: &str) {
    crate::relay::diagnostics::write(format_args!(
        "relay connect {operation} failed code={} connect_ref={} cause={}",
        log_safe(code),
        MessageRef::of(connect_id),
        log_safe(cause)
    ));
}

/// Codes and request ids can come from a server response. Keep only a
/// bounded, single-line token so a crafted value cannot forge log lines.
fn log_safe(value: &str) -> String {
    value
        .chars()
        .take(200)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '=' | ' ') {
                c
            } else {
                '?'
            }
        })
        .collect()
}

/// A local task that should have answered stopped instead.
pub(crate) fn connect_internal_error(operation: &str, connect_id: &str) -> OutboundError {
    log_connect_failure(
        operation,
        connect_id,
        "connect_internal_error",
        "task_stopped",
    );
    OutboundError::new(
        500,
        "connect_internal_error",
        "Agent Relay stopped handling this Relay Connect request. Retry once.",
    )
}

fn join_transport_error(error: cloud_http::RawError) -> OutboundError {
    match error {
        cloud_http::RawError::TimedOut => OutboundError::new(
            504,
            "connect_join_timeout",
            "Relay Connect join timed out. Retry the same join; it is safe to retry.",
        ),
        _ => OutboundError::new(
            503,
            "connect_unreachable",
            "Relay Connect could not be reached. Retry the same join; it is safe to retry.",
        ),
    }
}

#[cfg(debug_assertions)]
const CONNECT_JOIN_OVERRIDE: &str = "AGENT_RELAY_CONNECT_JOIN_BASE_URL";
/// Tells Cloud this desktop stops using a Connect credential while its
/// session is not running, so the credential's presence follows the session
/// and Cloud may report a recipient online as reachable.
pub(crate) const CONNECT_PRESENCE_HEADER: (&str, &str) =
    ("X-Agent-Relay-Connect-Presence", "session");

pub(crate) fn connect_id(link: &str) -> Option<String> {
    let id = if link.contains("://") {
        let url = url::Url::parse(link).ok()?;
        if url.scheme() != "https" || url.host_str() != Some("agentrelay.com") {
            return None;
        }
        let parts: Vec<_> = url
            .path_segments()?
            .filter(|part| !part.is_empty())
            .collect();
        if parts.last() == Some(&"join") {
            parts.get(parts.len().checked_sub(2)?)?.to_string()
        } else {
            parts.last()?.to_string()
        }
    } else {
        link.trim().to_string()
    };
    (!id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(id)
}

fn cloud_join_url(id: &str, debug_override: Option<&str>) -> String {
    if let Some(base) = debug_override.and_then(|base| {
        let url = url::Url::parse(base).ok()?;
        let loopback = match url.host()? {
            url::Host::Domain(host) => host == "localhost",
            url::Host::Ipv4(host) => host.is_loopback(),
            url::Host::Ipv6(host) => host.is_loopback(),
        };
        (url.scheme() == "http"
            && loopback
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none())
        .then(|| base.trim_end_matches('/'))
    }) {
        return format!("{base}/cloud/connect/{id}/join");
    }
    format!("https://agentrelay.com/cloud/connect/{id}/join")
}

fn cloud_roster_url(id: &str, debug_override: Option<&str>) -> String {
    let join = cloud_join_url(id, debug_override);
    format!("{}/participants", join.trim_end_matches("/join"))
}

fn cloud_invite_url(id: &str, debug_override: Option<&str>) -> String {
    if let Some(join) = cloud_join_url(id, debug_override).strip_suffix("/join") {
        return join.replace("/cloud/connect/", "/connect/");
    }
    format!("https://agentrelay.com/connect/{id}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectAvailability {
    Active,
    Gone { code: String, message: String },
}

/// Posts a join to `url`, declaring that this desktop's Connect presence
/// follows its session.
fn join_at(
    url: &str,
    id: &str,
    body: &Value,
    idempotency_key: &str,
) -> Result<JoinResponse, OutboundError> {
    let answer = cloud_http::send_blocking_with_headers(
        "POST",
        url,
        None,
        &[
            ("Idempotency-Key", idempotency_key),
            CONNECT_PRESENCE_HEADER,
        ],
        Some(body),
        CONNECT_JOIN_TIMEOUT,
    )
    .map_err(|error| {
        let mapped = join_transport_error(error);
        log_connect_failure("join", id, &mapped.code, error.cause());
        mapped
    })?;
    if !answer.ok() {
        let code = answer.body["error"]["code"]
            .as_str()
            .unwrap_or("connect_join_failed");
        return Err(OutboundError::new(
            answer.status,
            code,
            answer
                .message()
                .unwrap_or_else(|| "Could not join this Connect.".into()),
        ));
    }
    serde_json::from_value(answer.inner().clone()).map_err(|_| {
        OutboundError::new(
            502,
            "invalid_join_response",
            "Relay Connect returned an incomplete join response.",
        )
    })
}

impl ConnectJoinClient for CloudJoinClient {
    fn join(
        &self,
        link: &str,
        name: Option<&str>,
        host_claim: Option<&str>,
        idempotency_key: &str,
    ) -> Result<JoinResponse, OutboundError> {
        let id = connect_id(link).ok_or_else(|| {
            OutboundError::new(400, "invalid_link", "Use a Relay Connect link or id.")
        })?;
        // Shipped release builds have exactly one destination. Debug builds
        // may point at a loopback join handler for an accountless end-to-end
        // against real Relaycast without waiting for a Cloud deployment.
        #[cfg(debug_assertions)]
        let debug_override = std::env::var(CONNECT_JOIN_OVERRIDE).ok();
        #[cfg(not(debug_assertions))]
        let debug_override: Option<String> = None;
        let url = cloud_join_url(&id, debug_override.as_deref());
        let mut body = json!({});
        if let Some(name) = name {
            body["agent_name"] = json!(name);
        }
        if let Some(claim) = host_claim {
            body["host_claim"] = json!(claim);
        }
        join_at(&url, &id, &body, idempotency_key)
    }

    fn roster(&self, connect_id: &str, token: &Secret) -> Result<Vec<RosterEntry>, OutboundError> {
        #[cfg(debug_assertions)]
        let debug_override = std::env::var(CONNECT_JOIN_OVERRIDE).ok();
        #[cfg(not(debug_assertions))]
        let debug_override: Option<String> = None;
        let url = cloud_roster_url(connect_id, debug_override.as_deref());
        read_cloud_roster(&url, connect_id, token)
    }

    fn availability(&self, connect_id: &str) -> Result<ConnectAvailability, OutboundError> {
        #[cfg(debug_assertions)]
        let debug_override = std::env::var(CONNECT_JOIN_OVERRIDE).ok();
        #[cfg(not(debug_assertions))]
        let debug_override: Option<String> = None;
        let url = cloud_invite_url(connect_id, debug_override.as_deref());
        let answer = cloud_http::send_blocking_with_headers(
            "GET",
            &url,
            None,
            &[],
            None,
            Duration::from_secs(12),
        )
        .map_err(|error| {
            log_connect_failure("availability", connect_id, "connect_unreachable", error.cause());
            OutboundError::new(
                503,
                "connect_unreachable",
                "Relay Connect could not be reached to check whether this Connect is still open. Retry once.",
            )
        })?;
        if answer.ok() {
            return Ok(ConnectAvailability::Active);
        }
        let code = answer.body["error"]["code"]
            .as_str()
            .unwrap_or(match answer.status {
                404 => "connect_not_found",
                410 => "connect_ended",
                _ => "",
            });
        if matches!(answer.status, 404 | 410)
            && matches!(
                code,
                "connect_not_found" | "connect_ended" | "connect_expired"
            )
        {
            let fallback = match code {
                "connect_expired" => "This Connect has expired.",
                "connect_not_found" => "This Connect was not found.",
                _ => "This Connect has ended.",
            };
            return Ok(ConnectAvailability::Gone {
                code: code.into(),
                message: answer.message().unwrap_or_else(|| fallback.into()),
            });
        }
        if answer.status == 429 {
            log_connect_failure("availability", connect_id, "rate_limited", "http_429");
            return Err(OutboundError::new(
                429,
                "rate_limited",
                "Relay Connect is rate-limiting checks on this Connect; wait before retrying.",
            ));
        }
        let cause = if code.is_empty() {
            format!("http_{}", answer.status)
        } else {
            format!("http_{}:{code}", answer.status)
        };
        log_connect_failure("availability", connect_id, "connect_upstream_error", &cause);
        Err(OutboundError::new(
            502,
            "connect_upstream_error",
            format!(
                "Relay Connect answered HTTP {} when checking whether this Connect is still open. Retry once.",
                answer.status
            ),
        ))
    }
}

/// Stable across a repeat of the same local join, while keeping the session
/// identity and host claim out of the public request header.
pub(crate) fn join_request_hash(
    connect_id: &str,
    name: Option<&str>,
    host_claim: Option<&str>,
) -> String {
    let request = serde_json::to_vec(&("relay-connect-join:v1", connect_id, name, host_claim))
        .unwrap_or_default();
    let digest = Sha256::digest(request);
    format!("{digest:x}")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConnectSession {
    pub target: Target,
    pub connect_id: String,
    pub task: String,
    pub expires_at: String,
    pub host: ConnectHost,
    pub agent_name: String,
    pub agent_id: String,
    pub role: String,
    pub token: Secret,
    pub base_url: String,
    pub participants: Vec<Participant>,
    /// Authenticated workspace senders learned after this session joined.
    /// Their role remains unknown until Cloud includes it in a join response.
    #[serde(default)]
    pub observed_participants: Vec<String>,
}

impl ConnectSession {
    pub fn from_join(target: Target, join: JoinResponse) -> Result<Self, OutboundError> {
        if DateTime::parse_from_rfc3339(&join.expires_at).is_err()
            || !cloud_http::sendable(&join.participant.relay_base_url)
            || join.participant.token.expose().is_empty()
            || join.participant.agent_id.is_empty()
            || !join
                .participants
                .iter()
                .any(|p| p.agent_name == join.participant.agent_name)
        {
            return Err(OutboundError::new(
                502,
                "invalid_join_response",
                "Relay Connect returned an incomplete join response.",
            ));
        }
        Ok(Self {
            target,
            connect_id: join.connect_id,
            task: join.task,
            expires_at: join.expires_at,
            host: join.host,
            agent_name: join.participant.agent_name,
            agent_id: join.participant.agent_id,
            role: join.participant.role,
            token: join.participant.token,
            base_url: join.participant.relay_base_url,
            participants: join.participants,
            observed_participants: Vec::new(),
        })
    }

    pub fn expired(&self) -> bool {
        DateTime::parse_from_rfc3339(&self.expires_at)
            .is_ok_and(|at| at.with_timezone(&Utc) <= Utc::now())
    }

    fn valid(&self) -> bool {
        self.target.is_valid()
            && connect_id(&self.connect_id).as_deref() == Some(self.connect_id.as_str())
            && DateTime::parse_from_rfc3339(&self.expires_at).is_ok()
            && cloud_http::sendable(&self.base_url)
            && !self.agent_name.is_empty()
            && !self.agent_id.is_empty()
            && !self.token.expose().is_empty()
            && self
                .participants
                .iter()
                .any(|participant| participant.agent_name == self.agent_name)
    }

    pub fn join_public(&self) -> Value {
        json!({
            "connect_id": self.connect_id,
            "agent_name": self.agent_name,
            "role": self.role,
            "task": self.task,
            "expires_at": self.expires_at,
            "host": self.host,
            "participants": self.participants.iter().map(|p| json!({
                "agent_name": p.agent_name,
                "role": p.role,
            })).collect::<Vec<_>>()
        })
    }

    /// Cloud's participant-authenticated roster supplies presence and the
    /// role of a participant who joined later; without it presence is
    /// unknown (null), and so is a role this session never learned.
    pub fn status_public(&self, roster: Option<&[RosterEntry]>) -> Value {
        // Cloud's current role wins over the one saved at join.
        let mut roles: HashMap<&str, &str> = self
            .participants
            .iter()
            .map(|participant| (participant.agent_name.as_str(), participant.role.as_str()))
            .collect();
        roles.extend(
            roster
                .unwrap_or_default()
                .iter()
                .filter(|entry| entry.available)
                .filter_map(|entry| Some((entry.agent_name.as_str(), entry.role.as_deref()?))),
        );
        let participants: Vec<Value> = self
            .participant_names(roster)
            .into_iter()
            .map(|name| {
                json!({
                    "agent_name": name,
                    "role": roles.get(name.as_str()).copied(),
                    "online": crate::relay::connect_presence::recipient_online(roster, &name),
                })
            })
            .collect();
        json!({
            "connect_id": self.connect_id,
            "agent_name": self.agent_name,
            "role": self.role,
            "task": self.task,
            "expires_at": self.expires_at,
            "participants": participants,
        })
    }

    pub(crate) fn participant_names(&self, roster: Option<&[RosterEntry]>) -> Vec<String> {
        let mut names: Vec<String> = self
            .participants
            .iter()
            .map(|participant| participant.agent_name.clone())
            .chain(self.observed_participants.iter().cloned())
            .collect();
        if let Some(roster) = roster {
            for name in roster
                .iter()
                .filter(|entry| entry.available)
                .map(|entry| entry.agent_name.as_str())
                .filter(|name| !name.is_empty())
            {
                if !names.iter().any(|known| known == name) {
                    names.push(name.to_string());
                }
            }
        }
        names
    }
}

#[derive(Deserialize, Serialize)]
struct PersistedConnectState {
    version: u8,
    sessions: Vec<ConnectSession>,
    #[serde(default)]
    handled: HashMap<String, PersistedHandledOutcome>,
    /// Refusals are additive for one release so the released probe, whose
    /// handled enum knows only delivered/in_doubt, can still load every
    /// Connect session and credential from this file on downgrade.
    #[serde(default)]
    failures: HashMap<String, FailedOutcome>,
    #[serde(default)]
    pending: HashMap<String, String>,
    #[serde(default)]
    pending_delivery: HashMap<String, PendingDelivery>,
    #[serde(default)]
    outcomes: Vec<ConnectDeliveryRecord>,
    #[serde(default)]
    join_attempts: HashMap<String, JoinAttempt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct JoinAttempt {
    request_hash: String,
    idempotency_key: String,
    expires_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum HandledOutcome {
    Delivered,
    InDoubt,
}

/// Reads short-lived pre-release state written while refusal was temporarily
/// stored in `handled`, but current writes emit only the two released values.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PersistedHandledOutcome {
    Delivered,
    InDoubt,
    Refused,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum FailedOutcome {
    Refused,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SettledOutcome {
    Handled(HandledOutcome),
    Failed(FailedOutcome),
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ConnectDeliveryOutcome {
    Injected,
    InDoubt,
    #[serde(alias = "unavailable")]
    Refused,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PendingDeliveryKind {
    Waiting,
    Retry,
    Accepted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PendingDelivery {
    kind: PendingDeliveryKind,
    detail: String,
    first_seen_ms: i64,
    last_attempt_ms: i64,
    next_attempt_ms: i64,
    attempts: u32,
    #[serde(default)]
    accepted: bool,
    /// The accepted message waits for the turn the session is running.
    #[serde(default, skip_serializing_if = "is_false")]
    behind_turn: bool,
}

impl PendingDelivery {
    fn settlement(&self) -> Option<DeliverySettlement> {
        match (self.accepted, self.behind_turn) {
            (false, _) => None,
            (true, false) => Some(DeliverySettlement::HandedOff),
            (true, true) => Some(DeliverySettlement::WaitingForTurn),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PendingAction {
    Attempt { final_attempt: bool },
    Wait,
}

fn connect_handoff_ttl_ms(value: Option<&str>) -> i64 {
    value
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|seconds| (60..=24 * 60 * 60).contains(seconds))
        .and_then(|seconds| seconds.checked_mul(1_000))
        .unwrap_or(CONNECT_HANDOFF_TTL_MS)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ConnectDeliveryRecord {
    ledger: String,
    message_id: String,
    outcome: ConnectDeliveryOutcome,
    /// Distinguishes a target that never accepted the handoff from a permanent
    /// refusal. Released probes ignore the entire additive outcomes field.
    #[serde(default, skip_serializing_if = "is_false")]
    unavailable: bool,
    detail: String,
    at_ms: i64,
}

fn is_false(value: &bool) -> bool {
    !*value
}

pub struct ConnectState {
    path: PathBuf,
    pub sessions: HashMap<String, ConnectSession>,
    handled: HashMap<String, HandledOutcome>,
    failures: HashMap<String, FailedOutcome>,
    /// Delivery ledger key to message id for a session-side handoff that
    /// has not yet been observed in the transcript.
    pending: HashMap<String, String>,
    /// Durable timing and reason for a local handoff that is still busy.
    /// This keeps ordinary Waiting/Retry results pending without retrying in
    /// a tight loop or resetting their age across a probe restart.
    pending_delivery: HashMap<String, PendingDelivery>,
    /// Bounded, non-secret delivery results exposed through Connect status.
    outcomes: Vec<ConnectDeliveryRecord>,
    /// Target key to an ambiguous Cloud join operation. It is persisted so a
    /// process restart cannot turn a timed-out request into a second guest.
    join_attempts: HashMap<String, JoinAttempt>,
    /// Connect inboxes poll quickly, but their presence heartbeat keeps the
    /// ordinary delivery heartbeat cadence.
    last_heartbeat_ms: HashMap<String, i64>,
    /// Target keys of the sessions the latest discovery pass found running;
    /// `None` until a pass completes. Only a running session's credential
    /// is used, so Relaycast presence follows the session.
    live_targets: Option<HashSet<String>>,
}

impl ConnectState {
    pub fn load(path: PathBuf) -> ConnectState {
        let persisted = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistedConnectState>(&bytes).ok())
            .filter(|state| state.version == 1);
        let mut sessions = HashMap::new();
        let mut handled = HashMap::new();
        let mut failures = HashMap::new();
        let mut pending = HashMap::new();
        let mut pending_delivery = HashMap::new();
        let mut outcomes = Vec::new();
        let mut join_attempts = HashMap::new();
        if let Some(persisted) = persisted {
            failures = persisted.failures;
            for (ledger, outcome) in persisted.handled {
                match outcome {
                    PersistedHandledOutcome::Delivered => {
                        handled.insert(ledger, HandledOutcome::Delivered);
                    }
                    PersistedHandledOutcome::InDoubt => {
                        handled.insert(ledger, HandledOutcome::InDoubt);
                    }
                    PersistedHandledOutcome::Refused => {
                        failures.entry(ledger).or_insert(FailedOutcome::Refused);
                    }
                    PersistedHandledOutcome::Unavailable => {
                        failures.entry(ledger).or_insert(FailedOutcome::Unavailable);
                    }
                }
            }
            pending = persisted.pending;
            pending_delivery = persisted.pending_delivery;
            outcomes = persisted.outcomes;
            if outcomes.len() > CONNECT_OUTCOMES_KEPT {
                outcomes.drain(..outcomes.len() - CONNECT_OUTCOMES_KEPT);
            }
            let now = Utc::now().timestamp_millis();
            join_attempts = persisted
                .join_attempts
                .into_iter()
                .filter(|(_, attempt)| {
                    attempt.expires_at_ms > now
                        && attempt.request_hash.len() == 64
                        && attempt.idempotency_key.starts_with("probe-v1-")
                })
                .collect();
            for session in persisted.sessions.into_iter().filter(ConnectSession::valid) {
                crate::relay::request_log::mark_connect_credential(session.token.expose());
                sessions.insert(session.target.key(), session);
            }
        }
        let now = Utc::now().timestamp_millis();
        pending_delivery.retain(|ledger, _| pending.contains_key(ledger));
        for ledger in pending.keys() {
            pending_delivery
                .entry(ledger.clone())
                .or_insert_with(|| PendingDelivery {
                    kind: PendingDeliveryKind::Waiting,
                    detail: "Waiting for the local session.".into(),
                    first_seen_ms: now,
                    last_attempt_ms: 0,
                    next_attempt_ms: 0,
                    attempts: 0,
                    accepted: false,
                    behind_turn: false,
                });
        }
        ConnectState {
            path,
            sessions,
            handled,
            failures,
            pending,
            pending_delivery,
            outcomes,
            join_attempts,
            last_heartbeat_ms: HashMap::new(),
            live_targets: None,
        }
    }

    /// Records the sessions a discovery pass found running.
    pub(crate) fn observe_live_targets(&mut self, live: &HashSet<Target>) {
        self.live_targets = Some(live.iter().map(Target::key).collect());
    }

    /// Whether the latest discovery pass found `target` running; `None`
    /// before the first pass.
    pub(crate) fn discovered_live(&self, target: &Target) -> Option<bool> {
        self.live_targets
            .as_ref()
            .map(|live| live.contains(&target.key()))
    }

    /// Forgets the heartbeat of a credential whose session stopped, so it
    /// is heartbeated at once when the session runs again.
    pub(crate) fn forget_heartbeat(&mut self, agent_id: &str) {
        self.last_heartbeat_ms.remove(agent_id);
    }

    fn persist(&self) -> std::io::Result<()> {
        let directory = self.path.parent().unwrap_or_else(|| Path::new("."));
        create_private_dir(directory)?;
        let snapshot = PersistedConnectState {
            version: 1,
            sessions: self.sessions.values().cloned().collect(),
            handled: self
                .handled
                .iter()
                .map(|(ledger, outcome)| {
                    let outcome = match outcome {
                        HandledOutcome::Delivered => PersistedHandledOutcome::Delivered,
                        HandledOutcome::InDoubt => PersistedHandledOutcome::InDoubt,
                    };
                    (ledger.clone(), outcome)
                })
                .collect(),
            failures: self.failures.clone(),
            pending: self.pending.clone(),
            pending_delivery: self.pending_delivery.clone(),
            outcomes: self.outcomes.clone(),
            join_attempts: self.join_attempts.clone(),
        };
        let bytes = serde_json::to_vec(&snapshot)?;
        write_atomic(&self.path, &bytes)
    }

    pub fn insert(&mut self, session: ConnectSession) -> std::io::Result<()> {
        crate::relay::request_log::mark_connect_credential(session.token.expose());
        let key = session.target.key();
        let previous = self.sessions.insert(key.clone(), session);
        let previous_attempt = self.join_attempts.remove(&key);
        if let Err(error) = self.persist() {
            match previous {
                Some(previous) => self.sessions.insert(key.clone(), previous),
                None => self.sessions.remove(&key),
            };
            if let Some(previous_attempt) = previous_attempt {
                self.join_attempts.insert(key, previous_attempt);
            }
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn begin_join_attempt(
        &mut self,
        target: &Target,
        request_hash: &str,
    ) -> std::io::Result<Option<String>> {
        let now = Utc::now().timestamp_millis();
        self.join_attempts
            .retain(|_, attempt| attempt.expires_at_ms > now);
        let key = target.key();
        if let Some(attempt) = self.join_attempts.get(&key) {
            return Ok(
                (attempt.request_hash == request_hash).then(|| attempt.idempotency_key.clone())
            );
        }
        let attempt = JoinAttempt {
            request_hash: request_hash.to_string(),
            idempotency_key: format!("probe-v1-{}", random_uuid()),
            expires_at_ms: now.saturating_add(CONNECT_JOIN_ATTEMPT_TTL_MS),
        };
        let idempotency_key = attempt.idempotency_key.clone();
        self.join_attempts.insert(key.clone(), attempt);
        if let Err(error) = self.persist() {
            self.join_attempts.remove(&key);
            return Err(error);
        }
        Ok(Some(idempotency_key))
    }

    pub(crate) fn clear_join_attempt(&mut self, target: &Target, idempotency_key: &str) {
        let key = target.key();
        if self
            .join_attempts
            .get(&key)
            .is_none_or(|attempt| attempt.idempotency_key != idempotency_key)
        {
            return;
        }
        let previous = self.join_attempts.remove(&key);
        if self.persist().is_err() {
            if let Some(previous) = previous {
                self.join_attempts.insert(key, previous);
            }
        }
    }

    fn remove(
        &mut self,
        target: &Target,
        agent_id: Option<&str>,
    ) -> std::io::Result<Option<ConnectSession>> {
        let key = target.key();
        if agent_id.is_some_and(|agent_id| {
            self.sessions
                .get(&key)
                .is_none_or(|session| session.agent_id != agent_id)
        }) {
            return Ok(None);
        }
        let Some(removed) = self.sessions.remove(&key) else {
            return Ok(None);
        };
        let ledger_prefix = format!("{}:", removed.agent_id);
        let old_handled = self.handled.clone();
        let old_failures = self.failures.clone();
        let old_pending = self.pending.clone();
        let old_pending_delivery = self.pending_delivery.clone();
        let old_outcomes = self.outcomes.clone();
        self.handled
            .retain(|ledger, _| !ledger.starts_with(&ledger_prefix));
        self.failures
            .retain(|ledger, _| !ledger.starts_with(&ledger_prefix));
        self.pending
            .retain(|ledger, _| !ledger.starts_with(&ledger_prefix));
        self.pending_delivery
            .retain(|ledger, _| !ledger.starts_with(&ledger_prefix));
        self.outcomes
            .retain(|record| !record.ledger.starts_with(&ledger_prefix));
        if let Err(error) = self.persist() {
            self.sessions.insert(key, removed);
            self.handled = old_handled;
            self.failures = old_failures;
            self.pending = old_pending;
            self.pending_delivery = old_pending_delivery;
            self.outcomes = old_outcomes;
            return Err(error);
        }
        Ok(Some(removed))
    }

    fn remember_pending(&mut self, ledger: String, message_id: String) -> std::io::Result<()> {
        let now = Utc::now().timestamp_millis();
        self.pending.entry(ledger.clone()).or_insert(message_id);
        self.pending_delivery
            .entry(ledger)
            .or_insert_with(|| PendingDelivery {
                kind: PendingDeliveryKind::Waiting,
                detail: "Queued for local delivery.".into(),
                first_seen_ms: now,
                last_attempt_ms: 0,
                next_attempt_ms: 0,
                attempts: 0,
                accepted: false,
                behind_turn: false,
            });
        self.persist()
    }

    fn pending_action(&self, ledger: &str, now: i64, ttl_ms: i64) -> PendingAction {
        let Some(pending) = self.pending_delivery.get(ledger) else {
            return PendingAction::Attempt {
                final_attempt: false,
            };
        };
        if !pending.accepted && now.saturating_sub(pending.first_seen_ms) >= ttl_ms {
            return PendingAction::Attempt {
                final_attempt: true,
            };
        }
        if pending.next_attempt_ms > now {
            PendingAction::Wait
        } else {
            PendingAction::Attempt {
                final_attempt: false,
            }
        }
    }

    fn pending_was_accepted(&self, ledger: &str) -> bool {
        self.pending_delivery
            .get(ledger)
            .is_some_and(|pending| pending.accepted)
    }

    fn remember_waiting(
        &mut self,
        ledger: &str,
        kind: PendingDeliveryKind,
        detail: String,
    ) -> std::io::Result<()> {
        let now = Utc::now().timestamp_millis();
        let Some(pending) = self.pending_delivery.get_mut(ledger) else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "pending delivery disappeared before its outcome was recorded",
            ));
        };
        pending.kind = kind;
        pending.accepted |= kind == PendingDeliveryKind::Accepted;
        pending.detail = detail;
        pending.last_attempt_ms = now;
        pending.attempts = pending.attempts.saturating_add(1);
        // Observing an accepted handoff only reads Codex's queue and
        // rollout, so it never backs off: its settlement stays current.
        let shift = if pending.accepted {
            0
        } else {
            pending.attempts.saturating_sub(1).min(3)
        };
        let delay = CONNECT_RETRY_MIN_MS
            .saturating_mul(1_i64 << shift)
            .min(CONNECT_RETRY_MAX_MS);
        pending.next_attempt_ms = now.saturating_add(delay);
        self.persist()
    }

    /// Records that the provider's queue holds the exact message, and
    /// whether it waits behind the session's running turn. Returns whether
    /// that settlement changed.
    fn remember_accepted(
        &mut self,
        ledger: &str,
        behind_turn: bool,
        reason: &str,
    ) -> std::io::Result<bool> {
        let before = self
            .pending_delivery
            .get(ledger)
            .and_then(PendingDelivery::settlement);
        if let Some(pending) = self.pending_delivery.get_mut(ledger) {
            pending.behind_turn = behind_turn;
        }
        self.remember_waiting(
            ledger,
            PendingDeliveryKind::Accepted,
            format!("Accepted by the local session queue — {reason}"),
        )?;
        let after = self
            .pending_delivery
            .get(ledger)
            .and_then(PendingDelivery::settlement);
        Ok(before != after)
    }

    /// Records a retryable local result. Once the configured unaccepted
    /// lifetime has elapsed, this *attempt's* result becomes the durable
    /// unavailable outcome; the caller never expires an item before making
    /// that final attempt.
    fn remember_unaccepted_attempt(
        &mut self,
        ledger: &str,
        message_id: String,
        kind: PendingDeliveryKind,
        reason: &str,
        final_attempt: bool,
    ) -> std::io::Result<Option<String>> {
        if final_attempt {
            let detail = format!(
                "The local session remained unavailable without accepting the handoff — {reason}"
            );
            self.remember_failed(
                ledger.to_string(),
                message_id,
                FailedOutcome::Unavailable,
                detail.clone(),
            )?;
            return Ok(Some(detail));
        }
        let detail = match kind {
            PendingDeliveryKind::Retry => format!("Local delivery will retry — {reason}"),
            PendingDeliveryKind::Waiting => format!("Waiting for the local session — {reason}"),
            PendingDeliveryKind::Accepted => {
                format!("Accepted by the local session queue — {reason}")
            }
        };
        self.remember_waiting(ledger, kind, detail)?;
        Ok(None)
    }

    fn remember_handled(
        &mut self,
        ledger: String,
        message_id: String,
        outcome: HandledOutcome,
        detail: String,
    ) -> std::io::Result<()> {
        self.pending.remove(&ledger);
        self.pending_delivery.remove(&ledger);
        if !self.failures.contains_key(&ledger) {
            self.handled.entry(ledger.clone()).or_insert(outcome);
        }
        if !self.outcomes.iter().any(|record| record.ledger == ledger) {
            let outcome = match self.settled(&ledger).unwrap() {
                SettledOutcome::Handled(HandledOutcome::Delivered) => {
                    ConnectDeliveryOutcome::Injected
                }
                SettledOutcome::Handled(HandledOutcome::InDoubt) => ConnectDeliveryOutcome::InDoubt,
                SettledOutcome::Failed(_) => ConnectDeliveryOutcome::Refused,
            };
            self.record_outcome(ledger, message_id, outcome, false, detail);
        }
        self.persist()
    }

    fn remember_failed(
        &mut self,
        ledger: String,
        message_id: String,
        outcome: FailedOutcome,
        detail: String,
    ) -> std::io::Result<()> {
        self.pending.remove(&ledger);
        self.pending_delivery.remove(&ledger);
        if !self.handled.contains_key(&ledger) {
            self.failures.entry(ledger.clone()).or_insert(outcome);
        }
        if !self.outcomes.iter().any(|record| record.ledger == ledger) {
            let settled = self.settled(&ledger).unwrap();
            let (public, unavailable) = match settled {
                SettledOutcome::Handled(HandledOutcome::Delivered) => {
                    (ConnectDeliveryOutcome::Injected, false)
                }
                SettledOutcome::Handled(HandledOutcome::InDoubt) => {
                    (ConnectDeliveryOutcome::InDoubt, false)
                }
                SettledOutcome::Failed(FailedOutcome::Refused) => {
                    (ConnectDeliveryOutcome::Refused, false)
                }
                SettledOutcome::Failed(FailedOutcome::Unavailable) => {
                    (ConnectDeliveryOutcome::Refused, true)
                }
            };
            self.record_outcome(ledger, message_id, public, unavailable, detail);
        }
        self.persist()
    }

    fn settled(&self, ledger: &str) -> Option<SettledOutcome> {
        self.handled
            .get(ledger)
            .copied()
            .map(SettledOutcome::Handled)
            .or_else(|| {
                self.failures
                    .get(ledger)
                    .copied()
                    .map(SettledOutcome::Failed)
            })
    }

    fn record_outcome(
        &mut self,
        ledger: String,
        message_id: String,
        outcome: ConnectDeliveryOutcome,
        unavailable: bool,
        detail: String,
    ) {
        if let Some(existing) = self
            .outcomes
            .iter_mut()
            .find(|record| record.ledger == ledger)
        {
            existing.outcome = outcome;
            existing.unavailable = unavailable;
            existing.detail = detail;
            existing.at_ms = Utc::now().timestamp_millis();
            return;
        }
        self.outcomes.push(ConnectDeliveryRecord {
            ledger,
            message_id,
            outcome,
            unavailable,
            detail,
            at_ms: Utc::now().timestamp_millis(),
        });
        if self.outcomes.len() > CONNECT_OUTCOMES_KEPT {
            self.outcomes
                .drain(..self.outcomes.len() - CONNECT_OUTCOMES_KEPT);
        }
    }

    fn handled_detail(&self, ledger: &str) -> Option<&str> {
        self.outcomes
            .iter()
            .rev()
            .find(|record| record.ledger == ledger)
            .map(|record| record.detail.as_str())
    }

    fn delivery_public(&self, agent_id: &str) -> Option<Value> {
        let prefix = format!("{agent_id}:");
        let mut pending: Vec<_> = self
            .pending
            .iter()
            .filter(|(ledger, _)| ledger.starts_with(&prefix))
            .filter_map(|(ledger, message_id)| {
                self.pending_delivery.get(ledger).map(|attempt| {
                    json!({
                        "message_id": message_id,
                        "outcome": attempt.kind,
                        "detail": attempt.detail,
                        "since_ms": attempt.first_seen_ms,
                        "last_attempt_ms": attempt.last_attempt_ms,
                        "next_attempt_ms": attempt.next_attempt_ms,
                        "attempts": attempt.attempts,
                        "accepted": attempt.accepted,
                        "settlement": attempt.settlement(),
                    })
                })
            })
            .collect();
        pending.sort_by(|left, right| {
            left["since_ms"]
                .as_i64()
                .cmp(&right["since_ms"].as_i64())
                .then_with(|| {
                    left["message_id"]
                        .as_str()
                        .cmp(&right["message_id"].as_str())
                })
        });
        let recent: Vec<_> = self
            .outcomes
            .iter()
            .filter(|record| record.ledger.starts_with(&prefix))
            .map(|record| {
                let outcome = if record.unavailable {
                    json!("unavailable")
                } else {
                    json!(record.outcome)
                };
                let settlement = (record.outcome == ConnectDeliveryOutcome::Injected
                    && !record.unavailable)
                    .then_some(DeliverySettlement::Visible);
                json!({
                    "message_id": record.message_id,
                    "outcome": outcome,
                    "detail": record.detail,
                    "at_ms": record.at_ms,
                    "settlement": settlement,
                })
            })
            .collect();
        (!pending.is_empty() || !recent.is_empty())
            .then(|| json!({"pending": pending, "recent": recent}))
    }

    #[cfg(test)]
    fn pending_for(&self, agent_id: &str) -> Vec<String> {
        let prefix = format!("{agent_id}:");
        self.pending
            .iter()
            .filter(|(ledger, _)| ledger.starts_with(&prefix))
            .map(|(_, message_id)| message_id.clone())
            .collect()
    }

    /// Queue handoffs the provider has not accepted yet. Ending a Connect
    /// stops polling every pending delivery, but an accepted Codex queue item
    /// must be left in place so the working agent can consume it after its
    /// current turn.
    fn cancellable_pending_for(&self, agent_id: &str) -> Vec<String> {
        let prefix = format!("{agent_id}:");
        self.pending
            .iter()
            .filter(|(ledger, _)| {
                ledger.starts_with(&prefix)
                    && !self
                        .pending_delivery
                        .get(*ledger)
                        .is_some_and(|attempt| attempt.accepted)
            })
            .map(|(_, message_id)| message_id.clone())
            .collect()
    }

    /// Cancels terminal-queue handoffs before exposing a restarted core.
    /// Expired sessions are deliberately loaded above so their target and
    /// pending message ids remain available for this startup reconciliation.
    pub(crate) fn reconcile_expired(&mut self, injector: &dyn crate::relay::inject::Injector) {
        let expired: Vec<_> = self
            .sessions
            .values()
            .filter(|session| session.expired())
            .cloned()
            .collect();
        for session in expired {
            let pending = self.cancellable_pending_for(&session.agent_id);
            if self
                .remove(&session.target, Some(&session.agent_id))
                .ok()
                .flatten()
                .is_none()
            {
                continue;
            }
            for message_id in pending {
                injector.cancel_connect(&session.target, &message_id);
            }
            let (message_id, text) = connect_notice(&session, "connect_expired");
            let _ = injector.inject_connect(&session.target, &message_id, text);
        }
    }

    fn observe_participant(&mut self, session: &ConnectSession, name: &str) {
        let Some(current) = self
            .sessions
            .get_mut(&session.target.key())
            .filter(|current| current.agent_id == session.agent_id)
        else {
            return;
        };
        if name.is_empty()
            || current.agent_name == name
            || current
                .participants
                .iter()
                .any(|participant| participant.agent_name == name)
            || current
                .observed_participants
                .iter()
                .any(|participant| participant == name)
        {
            return;
        }
        current.observed_participants.push(name.to_string());
        // For an injected delivery the handled-ledger write below persists
        // this same snapshot before ack. Keeping the observation in memory
        // lets an immediate reply work even if this advisory write fails.
        let _ = self.persist();
    }
}

impl Core {
    pub(crate) fn connect_for(&self, target: &Target) -> Option<ConnectSession> {
        self.connect
            .lock()
            .unwrap()
            .sessions
            .get(&target.key())
            .cloned()
    }

    pub(crate) fn connect_delivery_public(&self, session: &ConnectSession) -> Option<Value> {
        self.connect
            .lock()
            .unwrap()
            .delivery_public(&session.agent_id)
    }

    pub(crate) fn remove_connect(&self, target: &Target, agent_id: &str) -> bool {
        let (removed, pending) = {
            let mut state = self.connect.lock().unwrap();
            let pending = state.cancellable_pending_for(agent_id);
            let removed = state
                .remove(target, Some(agent_id))
                .ok()
                .flatten()
                .is_some();
            (removed, pending)
        };
        if removed {
            for message_id in pending {
                self.plugins.injector.cancel_connect(target, &message_id);
            }
        }
        removed
    }

    pub(crate) fn leave_connect(
        &self,
        target: &Target,
        agent_id: &str,
    ) -> std::io::Result<Option<ConnectSession>> {
        let (removed, pending) = {
            let mut state = self.connect.lock().unwrap();
            let pending = state.cancellable_pending_for(agent_id);
            let removed = state.remove(target, Some(agent_id))?;
            (removed, pending)
        };
        if removed.is_some() {
            for message_id in pending {
                self.plugins.injector.cancel_connect(target, &message_id);
            }
        }
        Ok(removed)
    }

    pub(crate) fn connect_notice(&self, session: &ConnectSession, code: &str) {
        let injector = self.plugins.injector.clone();
        let target = session.target.clone();
        let (id, text) = connect_notice(session, code);
        tokio::task::spawn_blocking(move || injector.inject_connect(&target, &id, text));
    }

    /// Checks the public invite without an account credential. Relaycast
    /// deletes a Connect workspace by invalidating its participant tokens,
    /// so its 401 alone cannot distinguish an ended Connect from a bad token.
    pub(crate) async fn connect_availability(
        &self,
        session: &ConnectSession,
    ) -> Result<ConnectAvailability, OutboundError> {
        let client = self.plugins.connect_cloud.clone();
        let connect_id = session.connect_id.clone();
        let id = connect_id.clone();
        tokio::task::spawn_blocking(move || client.availability(&id))
            .await
            .unwrap_or_else(|_| Err(connect_internal_error("availability", &connect_id)))
    }

    pub(crate) fn close_connect(&self, session: &ConnectSession, code: &str) -> bool {
        let removed = self.remove_connect(&session.target, &session.agent_id);
        if removed {
            self.connect_notice(session, code);
        }
        removed
    }

    /// Puts a Connect delivery's settlement on the activity list, beside
    /// the deliveries of this computer's registered agents.
    fn record_connect_activity(
        &self,
        session: &ConnectSession,
        delivery: &policy::Delivery,
        outcome: DeliveryOutcome,
        detail: Option<String>,
        settlement: Option<DeliverySettlement>,
    ) {
        self.record_activity(DeliveryActivity {
            at_ms: Utc::now().timestamp_millis(),
            agent: session.agent_name.clone(),
            sender: delivery.sender.clone(),
            preview: preview(delivery),
            outcome,
            detail,
            settlement,
        });
    }

    pub(crate) async fn poll_connects(self: &Arc<Self>) {
        let sessions: Vec<_> = self
            .connect
            .lock()
            .unwrap()
            .sessions
            .values()
            .cloned()
            .collect();
        for session in sessions {
            let workspace = self.relaycast_workspace_id_scope(
                &session.base_url,
                &session.connect_id,
                format!("Relay Connect {}", session.connect_id),
            );
            // A join-triggered poll and the periodic supervisor can overlap.
            // Serialize the complete read/inject/settle pass for this Connect
            // credential so one delivery cannot reach a session twice.
            let lock = self
                .agent_locks
                .get(&format!("connect:{}", session.agent_id));
            let _polling = lock.lock().await;
            if self
                .connect_for(&session.target)
                .is_none_or(|current| current.agent_id != session.agent_id)
            {
                continue;
            }
            if session.expired() {
                self.close_connect(&session, "connect_expired");
                continue;
            }
            // Every request with this credential refreshes its Relaycast
            // presence, so a session that is gone is neither heartbeated nor
            // read: its participants see it offline and its messages wait on
            // Relaycast for the session to run again, as a registration's do.
            if !self.connect_target_reachable(&session.target).await {
                self.connect
                    .lock()
                    .unwrap()
                    .forget_heartbeat(&session.agent_id);
                continue;
            }
            let heartbeat_due = {
                let now = crate::relay::state::now_ms();
                let state = self.connect.lock().unwrap();
                heartbeat_due(
                    state.last_heartbeat_ms.get(&session.agent_id).copied(),
                    now,
                    self.config.delivery_timing.heartbeat,
                )
            };
            if heartbeat_due && self.relaycast_write_allowed(&workspace) {
                self.connect
                    .lock()
                    .unwrap()
                    .last_heartbeat_ms
                    .insert(session.agent_id.clone(), crate::relay::state::now_ms());
                let result = client::heartbeat(&session.base_url, &session.token).await;
                self.observe_relaycast_write_result(&workspace, &result);
                if let Err(error) = result {
                    if matches!(
                        error,
                        relaycast::RelayError::Api {
                            status: 404 | 410,
                            ..
                        }
                    ) {
                        self.close_connect(&session, "connect_ended");
                        continue;
                    }
                    if error.is_auth_rejection() {
                        if let Ok(ConnectAvailability::Gone { code, .. }) =
                            self.connect_availability(&session).await
                        {
                            self.close_connect(&session, &code);
                            continue;
                        }
                    }
                }
            }
            if !self.relaycast_poll_allowed(&workspace) {
                continue;
            }
            let result = client::deliveries(&session.base_url, &session.token).await;
            self.observe_relaycast_result(&workspace, &result);
            let deliveries = match result {
                Ok(items) => items,
                Err(relaycast::RelayError::Api {
                    status: 404 | 410, ..
                }) => {
                    self.close_connect(&session, "connect_ended");
                    continue;
                }
                Err(error) => {
                    if error.is_auth_rejection() {
                        if let Ok(ConnectAvailability::Gone { code, .. }) =
                            self.connect_availability(&session).await
                        {
                            self.close_connect(&session, &code);
                        }
                    }
                    continue;
                }
            };
            // Whether reply hints use the probe client: one process-table
            // scan per pass, taken off the async workers, not one per message.
            let mut needs_probe: Option<bool> = None;
            for delivery in deliveries.into_iter().filter(|d| d.is_pending()) {
                if self
                    .connect_for(&session.target)
                    .is_none_or(|s| s.agent_id != session.agent_id)
                {
                    break;
                }
                let ledger = format!("{}:{}", session.agent_id, delivery.id);
                let settled = {
                    let state = &mut *self.connect.lock().unwrap();
                    state.settled(&ledger).map(|outcome| {
                        let detail = state
                            .handled_detail(&ledger)
                            .unwrap_or_default()
                            .to_string();
                        (outcome, detail, state.persist().is_ok())
                    })
                };
                if let Some((outcome, detail, durable)) = settled {
                    if durable {
                        match outcome {
                            SettledOutcome::Handled(HandledOutcome::Delivered) => {
                                let _ = self
                                    .relaycast_ack(
                                        &workspace,
                                        &session.base_url,
                                        &session.token,
                                        &delivery.id,
                                    )
                                    .await;
                            }
                            SettledOutcome::Handled(HandledOutcome::InDoubt) => {
                                let _ = self
                                    .relaycast_fail(
                                        &workspace,
                                        &session.base_url,
                                        &session.token,
                                        &delivery.id,
                                        if detail.is_empty() {
                                            "in doubt, not resent"
                                        } else {
                                            &detail
                                        },
                                        false,
                                    )
                                    .await;
                            }
                            SettledOutcome::Failed(_) => {
                                let _ = self
                                    .relaycast_fail(
                                        &workspace,
                                        &session.base_url,
                                        &session.token,
                                        &delivery.id,
                                        if detail.is_empty() {
                                            "refused by the session"
                                        } else {
                                            &detail
                                        },
                                        false,
                                    )
                                    .await;
                            }
                        }
                    }
                    continue;
                }
                let sender = delivery.sender.as_deref();
                if sender == Some(session.agent_name.as_str()) {
                    let _ = self
                        .relaycast_ack(&workspace, &session.base_url, &session.token, &delivery.id)
                        .await;
                    continue;
                }
                if let Some(sender) = sender {
                    self.connect
                        .lock()
                        .unwrap()
                        .observe_participant(&session, sender);
                }
                if let Decision::Skip(_) = policy::decide(&delivery, None, None) {
                    let _ = self
                        .relaycast_ack(&workspace, &session.base_url, &session.token, &delivery.id)
                        .await;
                    continue;
                }
                if self
                    .connect
                    .lock()
                    .unwrap()
                    .remember_pending(ledger.clone(), delivery.message_id.clone())
                    .is_err()
                {
                    break;
                }
                let (pending_action, already_accepted) = {
                    let state = self.connect.lock().unwrap();
                    let ttl_ms = connect_handoff_ttl_ms(
                        self.config
                            .env
                            .get(CONNECT_HANDOFF_TTL_ENV)
                            .map(String::as_str),
                    );
                    (
                        state.pending_action(&ledger, Utc::now().timestamp_millis(), ttl_ms),
                        state.pending_was_accepted(&ledger),
                    )
                };
                let final_attempt = match pending_action {
                    // One target is an ordered stream. A backing-off head
                    // keeps every later item behind it, unless the
                    // provider's first-in, first-out queue already holds it:
                    // later items then join that queue behind it at once.
                    PendingAction::Wait if already_accepted => continue,
                    PendingAction::Wait => break,
                    PendingAction::Attempt { final_attempt } => final_attempt,
                };
                // Observing an accepted handoff sends no text, so it needs
                // no reply hint.
                let serving = self
                    .plugins
                    .relay_send
                    .as_ref()
                    .filter(|_| !already_accepted)
                    .and_then(|relay| relay.serving.get());
                let hint = match (serving, sender) {
                    (Some(socket), Some(sender)) => {
                        let probe = match needs_probe {
                            Some(known) => known,
                            None => {
                                let known = session.target.kind == SessionKind::Codex && {
                                    let thread = session.target.id.clone();
                                    tokio::task::spawn_blocking(move || {
                                        needs_probe_reply_client(
                                            &SystemProcesses::default(),
                                            current_uid(),
                                            &thread,
                                        )
                                    })
                                    .await
                                    .unwrap_or(false)
                                };
                                *needs_probe.insert(known)
                            }
                        };
                        connect_reply_hint(&socket, sender, session.target.kind, probe)
                            .unwrap_or_default()
                    }
                    _ => String::new(),
                };
                let sender = policy::one_line(sender.unwrap_or("participant"));
                let message_ref = MessageRef::of(&delivery.message_id);
                let mut saved = self
                    .with_saved_attachments(&delivery, &session.base_url, &session.token)
                    .await;
                if let Some(saved) = saved.as_mut() {
                    self.add_fetch_hints(&session.target, &mut saved.attachments)
                        .await;
                }
                let text = crate::relay::delivery::policy::frame::closed(
                    &format!("[Relay Connect — from {sender} · ref {message_ref}]\n{hint}"),
                    delivery.text.as_deref().unwrap_or_default(),
                    &message_ref,
                    &saved.as_ref().unwrap_or(&delivery).attachments,
                );
                let injector = self.plugins.injector.clone();
                let target = session.target.clone();
                let message_id = delivery.message_id.clone();
                let recorded_message_id = message_id.clone();
                let outcome = tokio::task::spawn_blocking(move || {
                    if already_accepted {
                        injector.observe_connect(&target, &message_id, &text)
                    } else {
                        injector.inject_connect(&target, &message_id, &text)
                    }
                })
                .await;
                match outcome {
                    Ok(InjectOutcome::Delivered) => {
                        if self
                            .connect
                            .lock()
                            .unwrap()
                            .remember_handled(
                                ledger,
                                recorded_message_id,
                                HandledOutcome::Delivered,
                                "Injected into the session.".into(),
                            )
                            .is_ok()
                        {
                            self.record_connect_activity(
                                &session,
                                &delivery,
                                DeliveryOutcome::Injected,
                                None,
                                Some(DeliverySettlement::Visible),
                            );
                            let _ = self
                                .relaycast_ack(
                                    &workspace,
                                    &session.base_url,
                                    &session.token,
                                    &delivery.id,
                                )
                                .await;
                        }
                    }
                    Ok(InjectOutcome::InDoubt(reason)) => {
                        let detail = format!("In doubt; not resent — {reason}");
                        if self
                            .connect
                            .lock()
                            .unwrap()
                            .remember_handled(
                                ledger,
                                recorded_message_id,
                                HandledOutcome::InDoubt,
                                detail.clone(),
                            )
                            .is_ok()
                        {
                            let _ = self
                                .relaycast_fail(
                                    &workspace,
                                    &session.base_url,
                                    &session.token,
                                    &delivery.id,
                                    &detail,
                                    false,
                                )
                                .await;
                        }
                    }
                    Ok(InjectOutcome::Refused(reason)) => {
                        let detail = format!("Refused by the session — {reason}");
                        let injector = self.plugins.injector.clone();
                        let target = session.target.clone();
                        let cancel_id = recorded_message_id.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            injector.cancel_connect(&target, &cancel_id)
                        })
                        .await;
                        if self
                            .connect
                            .lock()
                            .unwrap()
                            .remember_failed(
                                ledger,
                                recorded_message_id,
                                FailedOutcome::Refused,
                                detail.clone(),
                            )
                            .is_ok()
                        {
                            let _ = self
                                .relaycast_fail(
                                    &workspace,
                                    &session.base_url,
                                    &session.token,
                                    &delivery.id,
                                    &detail,
                                    false,
                                )
                                .await;
                        }
                    }
                    Ok(InjectOutcome::Retry(reason)) => {
                        let remembered = self.connect.lock().unwrap().remember_unaccepted_attempt(
                            &ledger,
                            recorded_message_id,
                            PendingDeliveryKind::Retry,
                            &reason,
                            final_attempt,
                        );
                        match remembered {
                            Ok(Some(detail)) => {
                                let _ = self
                                    .relaycast_fail(
                                        &workspace,
                                        &session.base_url,
                                        &session.token,
                                        &delivery.id,
                                        &detail,
                                        false,
                                    )
                                    .await;
                            }
                            Ok(None) | Err(_) => break,
                        }
                    }
                    Ok(InjectOutcome::Waiting(reason)) => {
                        let remembered = self.connect.lock().unwrap().remember_unaccepted_attempt(
                            &ledger,
                            recorded_message_id,
                            PendingDeliveryKind::Waiting,
                            &reason,
                            final_attempt,
                        );
                        match remembered {
                            Ok(Some(detail)) => {
                                let _ = self
                                    .relaycast_fail(
                                        &workspace,
                                        &session.base_url,
                                        &session.token,
                                        &delivery.id,
                                        &detail,
                                        false,
                                    )
                                    .await;
                            }
                            Ok(None) | Err(_) => break,
                        }
                    }
                    Ok(InjectOutcome::Accepted(ref reason))
                    | Ok(InjectOutcome::WaitingForTurn(ref reason)) => {
                        let behind_turn = matches!(outcome, Ok(InjectOutcome::WaitingForTurn(_)));
                        let changed = self.connect.lock().unwrap().remember_accepted(
                            &ledger,
                            behind_turn,
                            reason,
                        );
                        match changed {
                            Ok(changed) => {
                                if changed {
                                    let settlement =
                                        outcome.as_ref().ok().and_then(DeliverySettlement::of);
                                    self.record_connect_activity(
                                        &session,
                                        &delivery,
                                        DeliveryOutcome::Waiting,
                                        Some(reason.clone()),
                                        settlement,
                                    );
                                }
                            }
                            // Unrecorded, the next pass observes this head
                            // again before anything behind it.
                            Err(_) => break,
                        }
                    }
                    Err(_) => {
                        let detail = "In doubt; the local session handoff stopped unexpectedly and was not resent.".to_string();
                        if self
                            .connect
                            .lock()
                            .unwrap()
                            .remember_handled(
                                ledger,
                                recorded_message_id,
                                HandledOutcome::InDoubt,
                                detail.clone(),
                            )
                            .is_ok()
                        {
                            let _ = self
                                .relaycast_fail(
                                    &workspace,
                                    &session.base_url,
                                    &session.token,
                                    &delivery.id,
                                    &detail,
                                    false,
                                )
                                .await;
                        }
                    }
                }
            }
        }
    }
}

fn connect_notice(session: &ConnectSession, code: &str) -> (String, &'static str) {
    let ended = code != "connect_expired";
    (
        format!(
            "connect-{}-{}",
            if ended { "ended" } else { "expired" },
            session.connect_id
        ),
        if ended {
            "[Relay Connect] This Connect ended. Its local credential was removed."
        } else {
            "[Relay Connect] This Connect expired. Its local credential was removed."
        },
    )
}

fn connect_reply_hint(
    socket: &Path,
    sender: &str,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    let socket = socket.to_str()?;
    let request_path = format!("/connect/send?to={}", query_encode(sender));
    // macOS hides the environment of /usr/bin/curl from KERN_PROCARGS2.
    // Use the probe executable so an app-server command keeps its thread ID.
    // On Windows the socket is a named pipe curl cannot reach, so every
    // session gets the probe client.
    if cfg!(windows) || (kind == SessionKind::Codex && probe_client(needs_probe)) {
        let command =
            probe_socket_command_with_body(Path::new(socket), "POST", &request_path, "your reply")?;
        return Some(format!("[reply: {command}]"));
    }
    let url = format!("http://relay{request_path}");
    let parts = [
        "curl",
        "-s",
        "--unix-socket",
        socket,
        &url,
        "--data-binary",
        "@-",
    ];
    Some(format!(
        "[reply: {}]",
        parts
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_safe_keeps_server_values_on_one_line() {
        assert_eq!(
            log_safe("http_500:bad\nrelay connect send failed"),
            "http_500:bad?relay connect send failed"
        );
        assert_eq!(
            log_safe("http_401:unauthorized request_id=abc-1"),
            "http_401:unauthorized request_id=abc-1"
        );
        assert_eq!(log_safe(&"x".repeat(500)).len(), 200);
    }

    #[test]
    fn fast_connect_inbox_poll_does_not_speed_up_heartbeat() {
        let interval = Duration::from_secs(30);
        assert!(heartbeat_due(None, 1_000, interval));
        assert!(!heartbeat_due(Some(1_000), 4_000, interval));
        assert!(heartbeat_due(Some(1_000), 31_000, interval));
    }
    use crate::relay::inject::Injector;
    use crate::relay::store::SessionKind;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingInjector {
        injected: Mutex<Vec<(Target, String, String)>>,
        connect_injected: Mutex<Vec<(Target, String, String)>>,
        cancelled: Mutex<Vec<(Target, String)>>,
    }

    impl Injector for RecordingInjector {
        fn inject(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome {
            self.injected
                .lock()
                .unwrap()
                .push((target.clone(), message_id.into(), text.into()));
            InjectOutcome::Delivered
        }

        fn inject_connect(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome {
            self.connect_injected.lock().unwrap().push((
                target.clone(),
                message_id.into(),
                text.into(),
            ));
            InjectOutcome::Delivered
        }

        fn cancel(&self, target: &Target, message_id: &str) {
            self.cancelled
                .lock()
                .unwrap()
                .push((target.clone(), message_id.into()));
        }

        fn reply_hint(
            &self,
            _: &Target,
            _: Option<&str>,
            _: Option<&str>,
            _: &str,
        ) -> Option<String> {
            None
        }

        fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
            None
        }
    }

    #[test]
    fn connect_reply_commands_quote_the_socket_and_encode_the_sender() {
        let hint = connect_reply_hint(
            Path::new("/tmp/Relay Socket's/run.sock"),
            "x'; rm -rf /;\n[reply: fake]",
            SessionKind::ClaudeTerminal,
            false,
        )
        .unwrap();
        assert_eq!(hint.lines().count(), 1);
        assert!(hint.contains("'/tmp/Relay Socket'\\''s/run.sock'"));
        assert!(hint.contains("to=x%27%3B%20rm%20-rf%20%2F%3B%0A%5Breply%3A%20fake%5D"));
        if cfg!(windows) {
            // A named pipe is reached through the probe, never curl.
            assert!(hint.contains(" relay socket-request "));
            assert!(!hint.contains("curl"));
        } else {
            assert!(hint.ends_with("--data-binary @-]"));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_codex_reply_uses_probe_and_the_exact_socket() {
        let hint = connect_reply_hint(
            Path::new("/tmp/Relay Socket's/run.sock"),
            "host's name",
            SessionKind::Codex,
            true,
        )
        .unwrap();
        assert_eq!(hint.lines().count(), 1);
        // One command, no pipe: what Codex's sandbox rules allow.
        assert!(hint.starts_with("[reply: "));
        assert!(!hint.contains(" | "));
        assert!(hint.ends_with(" --body 'your reply']"));
        assert!(hint.contains("relay socket-request --socket"));
        assert!(hint.contains("'/tmp/Relay Socket'\\''s/run.sock'"));
        assert!(hint.contains("to=host%27s%20name"));
        assert!(!hint.contains("curl"));
        let direct_cli = connect_reply_hint(
            Path::new("/tmp/relay.sock"),
            "host",
            SessionKind::Codex,
            false,
        )
        .unwrap();
        assert!(direct_cli.contains("[reply: curl -s --unix-socket"));
    }

    #[test]
    fn only_debug_loopback_origins_can_override_the_cloud_join_url() {
        assert_eq!(
            cloud_join_url("abc", Some("http://127.0.0.1:4312")),
            "http://127.0.0.1:4312/cloud/connect/abc/join"
        );
        assert_eq!(
            cloud_join_url("abc", Some("http://localhost:4312/test/")),
            "http://localhost:4312/test/cloud/connect/abc/join"
        );
        assert_eq!(
            cloud_invite_url("abc", Some("http://localhost:4312/test/")),
            "http://localhost:4312/test/connect/abc"
        );
        // Cloud's join response advertises this as `participants_url`.
        assert_eq!(
            cloud_roster_url("abc", None),
            "https://agentrelay.com/cloud/connect/abc/participants"
        );
        for refused in [
            "https://example.com",
            "http://example.com",
            "http://127.0.0.1:4312?token=x",
            "not a url",
        ] {
            assert_eq!(
                cloud_join_url("abc", Some(refused)),
                "https://agentrelay.com/cloud/connect/abc/join"
            );
        }
    }

    #[test]
    fn join_request_fingerprints_keep_secrets_out_of_persisted_state() {
        let first = join_request_hash("connect-1", Some("guest"), Some("do-not-leak-this-claim"));
        assert_eq!(
            first,
            join_request_hash("connect-1", Some("guest"), Some("do-not-leak-this-claim"),)
        );
        assert_ne!(
            first,
            join_request_hash(
                "connect-2",
                Some("different-guest"),
                Some("do-not-leak-this-claim"),
            )
        );
        assert!(!first.contains("do-not-leak-this-claim"));
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn a_join_declares_that_connect_presence_follows_the_session() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/cloud/connect/abc/join",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n{") {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let body = r#"{"error":{"code":"connect_ended","message":"ended"}}"#;
            write!(
                stream,
                "HTTP/1.1 410 Gone\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8_lossy(&request).to_lowercase()
        });
        let error = join_at(&url, "abc", &json!({}), "probe-v1-key").unwrap_err();
        assert_eq!(error.code, "connect_ended");
        let request = server.join().unwrap();
        assert!(
            request.contains("\r\nx-agent-relay-connect-presence: session\r\n"),
            "{request}"
        );
    }

    #[test]
    fn join_timeouts_are_explicitly_safe_to_retry() {
        assert_eq!(CONNECT_JOIN_TIMEOUT, Duration::from_secs(45));
        let error = join_transport_error(cloud_http::RawError::TimedOut);
        assert_eq!(error.status, 504);
        assert_eq!(error.code, "connect_join_timeout");
        assert!(error.message.contains("safe to retry"));
    }

    #[test]
    fn an_ambiguous_join_attempt_survives_restart_without_its_claim() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app/connect-sessions.json");
        let target = Target::new(SessionKind::Codex, "01a0c221-6806-7210-af25-97e104b15049");
        let request_hash = join_request_hash(
            "connect-1",
            Some("retrying-guest"),
            Some("private-host-claim"),
        );
        let first = ConnectState::load(path.clone())
            .begin_join_attempt(&target, &request_hash)
            .unwrap()
            .unwrap();
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("private-host-claim"));

        let mut restarted = ConnectState::load(path);
        assert_eq!(
            restarted
                .begin_join_attempt(&target, &request_hash)
                .unwrap(),
            Some(first)
        );
        assert_eq!(
            restarted
                .begin_join_attempt(&target, &"f".repeat(64))
                .unwrap(),
            None
        );
    }

    #[test]
    fn status_shows_clouds_current_role_over_the_one_saved_at_join() {
        let session = ConnectSession {
            target: Target::new(SessionKind::Codex, "01a0c221-6806-7210-af25-97e104b15049"),
            connect_id: "connect-1".into(),
            task: "Review".into(),
            expires_at: "2099-10-01T12:00:00Z".into(),
            host: ConnectHost {
                person: "Alice".into(),
                agent_name: "host".into(),
            },
            agent_name: "me".into(),
            agent_id: "agent-me".into(),
            role: "guest".into(),
            token: Secret::new("at_live_connect"),
            base_url: "https://cast.agentrelay.com".into(),
            participants: vec![
                Participant {
                    agent_name: "me".into(),
                    role: "guest".into(),
                },
                Participant {
                    agent_name: "promoted".into(),
                    role: "guest".into(),
                },
            ],
            observed_participants: Vec::new(),
        };
        let entry = |name: &str, role: Option<&str>| RosterEntry {
            agent_name: name.into(),
            role: role.map(str::to_string),
            available: true,
            online: true,
        };
        let roster = [entry("promoted", Some("host")), entry("me", None)];
        let status = session.status_public(Some(&roster));
        assert_eq!(
            status["participants"],
            json!([
                {"agent_name": "me", "role": "guest", "online": true},
                {"agent_name": "promoted", "role": "host", "online": true},
            ])
        );
    }

    #[test]
    fn connect_credentials_survive_a_core_restart_in_a_private_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app/connect-sessions.json");
        let target = Target::new(SessionKind::Codex, "01a0c221-6806-7210-af25-97e104b15049");
        let mut state = ConnectState::load(path.clone());
        state
            .insert(ConnectSession {
                target: target.clone(),
                connect_id: "connect-1".into(),
                task: "Review".into(),
                expires_at: "2099-10-01T12:00:00Z".into(),
                host: ConnectHost {
                    person: "Alice".into(),
                    agent_name: "host".into(),
                },
                agent_name: "guest".into(),
                agent_id: "agent-guest".into(),
                role: "guest".into(),
                token: Secret::new("at_live_connect"),
                base_url: "https://cast.agentrelay.com".into(),
                participants: vec![Participant {
                    agent_name: "guest".into(),
                    role: "guest".into(),
                }],
                observed_participants: Vec::new(),
            })
            .unwrap();
        let saved = state.sessions.get(&target.key()).unwrap().clone();
        state.observe_participant(&saved, "later-guest");

        let loaded = ConnectState::load(path.clone());
        let restored = loaded.sessions.get(&target.key()).unwrap();
        assert_eq!(restored.connect_id, "connect-1");
        assert_eq!(restored.token.expose(), "at_live_connect");
        assert_eq!(restored.observed_participants, ["later-guest"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn a_failed_ledger_write_keeps_the_outcome_for_a_later_retry() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("not-a-directory");
        fs::write(&blocker, b"block").unwrap();
        let path = blocker.join("connect-sessions.json");
        let mut state = ConnectState::load(path.clone());
        assert!(state
            .remember_handled(
                "agent-1:delivery-1".into(),
                "message-1".into(),
                HandledOutcome::InDoubt,
                "original uncertainty".into(),
            )
            .is_err());
        assert_eq!(
            state.handled.get("agent-1:delivery-1"),
            Some(&HandledOutcome::InDoubt)
        );

        fs::remove_file(&blocker).unwrap();
        fs::create_dir(&blocker).unwrap();
        state
            .remember_handled(
                "agent-1:delivery-1".into(),
                "message-1".into(),
                HandledOutcome::Delivered,
                "later delivery".into(),
            )
            .unwrap();
        assert_eq!(
            ConnectState::load(path).handled.get("agent-1:delivery-1"),
            Some(&HandledOutcome::InDoubt),
            "the original settlement outcome is durable and cannot flip"
        );
    }

    #[test]
    fn a_delivered_connect_handoff_survives_restart_without_pending_replay() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app/connect-sessions.json");
        let mut state = ConnectState::load(path.clone());
        state
            .remember_pending("agent-1:delivery-1".into(), "message-1".into())
            .unwrap();
        state
            .remember_handled(
                "agent-1:delivery-1".into(),
                "message-1".into(),
                HandledOutcome::Delivered,
                "Injected into the session.".into(),
            )
            .unwrap();

        let restarted = ConnectState::load(path);
        assert_eq!(
            restarted.handled.get("agent-1:delivery-1"),
            Some(&HandledOutcome::Delivered)
        );
        assert!(restarted.pending_for("agent-1").is_empty());
    }

    #[test]
    fn a_busy_connect_handoff_keeps_its_age_and_backoff_across_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app/connect-sessions.json");
        let ledger = "agent-1:delivery-1";
        let mut state = ConnectState::load(path.clone());
        state
            .remember_pending(ledger.into(), "message-1".into())
            .unwrap();
        state
            .remember_waiting(
                ledger,
                PendingDeliveryKind::Waiting,
                "Waiting for a busy Codex turn.".into(),
            )
            .unwrap();
        assert_eq!(
            state.pending_action(
                ledger,
                Utc::now().timestamp_millis(),
                CONNECT_HANDOFF_TTL_MS,
            ),
            PendingAction::Wait
        );

        let restarted = ConnectState::load(path);
        let attempt = restarted.pending_delivery.get(ledger).unwrap();
        assert_eq!(attempt.attempts, 1);
        assert!(!attempt.accepted);
        assert_eq!(
            restarted.pending_action(
                ledger,
                Utc::now().timestamp_millis(),
                CONNECT_HANDOFF_TTL_MS,
            ),
            PendingAction::Wait,
            "restart must not reset the local retry backoff"
        );
    }

    #[test]
    fn an_unaccepted_handoff_gets_one_final_attempt_before_unavailable() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app/connect-sessions.json");
        let now = Utc::now().timestamp_millis();
        let mut state = ConnectState::load(path.clone());
        for (ledger, kind) in [
            ("agent-1:waiting", PendingDeliveryKind::Waiting),
            ("agent-1:accepted", PendingDeliveryKind::Accepted),
        ] {
            state
                .remember_pending(ledger.into(), format!("message-{ledger}"))
                .unwrap();
            state
                .remember_waiting(ledger, kind, "still unavailable".into())
                .unwrap();
            state
                .pending_delivery
                .get_mut(ledger)
                .unwrap()
                .first_seen_ms = now.saturating_sub(CONNECT_HANDOFF_TTL_MS);
        }

        assert_eq!(
            state.pending_action("agent-1:waiting", now, CONNECT_HANDOFF_TTL_MS),
            PendingAction::Attempt {
                final_attempt: true,
            }
        );
        assert_eq!(
            state.pending_action("agent-1:accepted", now, CONNECT_HANDOFF_TTL_MS),
            PendingAction::Wait,
            "an accepted Codex queue item remains live until the Connect ends"
        );
        let detail = state
            .remember_unaccepted_attempt(
                "agent-1:waiting",
                "message-final".into(),
                PendingDeliveryKind::Waiting,
                "still unavailable on the final attempt",
                true,
            )
            .unwrap()
            .unwrap();
        assert!(detail.contains("still unavailable on the final attempt"));
        assert_eq!(
            state.failures.get("agent-1:waiting"),
            Some(&FailedOutcome::Unavailable)
        );
        assert!(state.delivery_public("agent-1").unwrap()["recent"]
            .as_array()
            .unwrap()
            .iter()
            .any(|record| record["outcome"] == "unavailable"));
        let bytes = std::fs::read(&path).unwrap();
        let saved: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(saved["handled"].get("agent-1:waiting").is_none());
        assert_eq!(saved["failures"]["agent-1:waiting"], "unavailable");
        let saved_outcome = saved["outcomes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record["ledger"] == "agent-1:waiting")
            .unwrap();
        assert_eq!(saved_outcome["outcome"], "refused");
        assert_eq!(saved_outcome["unavailable"], true);
        assert!(!state.pending.contains_key("agent-1:waiting"));

        #[derive(Deserialize)]
        #[allow(dead_code)]
        struct ReleasedState {
            version: u8,
            sessions: Vec<Value>,
            handled: HashMap<String, ReleasedHandled>,
            pending: HashMap<String, String>,
            join_attempts: HashMap<String, Value>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case")]
        enum ReleasedHandled {
            Delivered,
            InDoubt,
        }
        let released: ReleasedState = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(released.version, 1);
        assert!(released.handled.is_empty());
    }

    #[test]
    fn a_pre_release_refusal_is_migrated_out_of_the_released_handled_enum() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app/connect-sessions.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "version": 1,
                "sessions": [],
                "handled": {"agent-1:delivery-1": "refused"},
                "pending": {},
                "pending_delivery": {},
                "outcomes": [],
                "join_attempts": {}
            }))
            .unwrap(),
        )
        .unwrap();

        let state = ConnectState::load(path.clone());
        assert_eq!(
            state.failures.get("agent-1:delivery-1"),
            Some(&FailedOutcome::Refused)
        );
        state.persist().unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(saved["handled"].get("agent-1:delivery-1").is_none());
        assert_eq!(saved["failures"]["agent-1:delivery-1"], "refused");
    }

    #[test]
    fn the_unaccepted_handoff_bound_defaults_to_an_hour_and_is_configurable() {
        assert_eq!(connect_handoff_ttl_ms(None), 60 * 60 * 1_000);
        assert_eq!(connect_handoff_ttl_ms(Some("7200")), 2 * 60 * 60 * 1_000);
        assert_eq!(connect_handoff_ttl_ms(Some("59")), 60 * 60 * 1_000);
        assert_eq!(connect_handoff_ttl_ms(Some("invalid")), 60 * 60 * 1_000);
    }

    #[test]
    fn restart_cancels_only_unaccepted_handoffs_from_an_expired_connect() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app/connect-sessions.json");
        let target = Target::new(SessionKind::Codex, "01a0c221-6806-7210-af25-97e104b15049");
        let mut state = ConnectState::load(path.clone());
        state
            .insert(ConnectSession {
                target: target.clone(),
                connect_id: "expired-connect".into(),
                task: "Review".into(),
                expires_at: "2020-01-01T00:00:00Z".into(),
                host: ConnectHost {
                    person: "Alice".into(),
                    agent_name: "host".into(),
                },
                agent_name: "guest".into(),
                agent_id: "agent-guest".into(),
                role: "guest".into(),
                token: Secret::new("at_live_connect"),
                base_url: "https://cast.agentrelay.com".into(),
                participants: vec![Participant {
                    agent_name: "guest".into(),
                    role: "guest".into(),
                }],
                observed_participants: Vec::new(),
            })
            .unwrap();
        state
            .remember_pending("agent-guest:delivery-1".into(), "message-1".into())
            .unwrap();
        state
            .remember_pending("agent-guest:delivery-2".into(), "message-2".into())
            .unwrap();
        state
            .remember_waiting(
                "agent-guest:delivery-2",
                PendingDeliveryKind::Accepted,
                "accepted into the Codex queue".into(),
            )
            .unwrap();

        let injector = RecordingInjector::default();
        let mut restarted = ConnectState::load(path.clone());
        assert!(restarted.sessions.contains_key(&target.key()));
        restarted.reconcile_expired(&injector);

        assert!(restarted.sessions.is_empty());
        assert!(restarted.pending_for("agent-guest").is_empty());
        assert_eq!(
            *injector.cancelled.lock().unwrap(),
            [(target.clone(), "message-1".into())]
        );
        assert!(injector.injected.lock().unwrap().is_empty());
        assert_eq!(injector.connect_injected.lock().unwrap().len(), 1);
        assert!(injector.connect_injected.lock().unwrap()[0]
            .2
            .contains("This Connect expired."));
        assert!(ConnectState::load(path).sessions.is_empty());
    }
}
