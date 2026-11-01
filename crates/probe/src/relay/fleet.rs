//! Fleet workers: the agents this computer's Agent Relay brokers spawned, and
//! their release. See "Fleet workers" in `docs/injectable-agents.md`.
//!
//! The contract is the files and HTTP surface the `agent-relay` CLI itself
//! uses, never process lists or terminals:
//!
//! ```text
//! <relay home>/node-claims/<node>.<generation>.json ─▶ node id + state_dir
//! <state_dir>/connection.json {url, api_key}        ─▶ broker endpoint
//! GET    {url}/api/spawned          (X-API-Key)     ─▶ live workers
//! DELETE {url}/api/spawned/{name}   {expected_generation} ─▶ release
//! ```
//!
//! The relay home is `$AGENT_RELAY_HOME`, else `~/.agentworkforce/relay`
//! (`workspace::relay_home`); nothing here writes to it. A broker API key is
//! only ever sent to a bare loopback origin, redirects are never followed,
//! and a broker that cannot be read reports an error — never "no workers".
//! The core reports what brokers say; a row the UI released stays "ended"
//! in the UI until a listing no longer carries it.

use crate::relay::contract::{answer, method, Done};
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::store::{is_uuid, SessionKind, Target};
use crate::relay::workspace::Secret;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Per-broker request deadline. The API is loopback; anything slower means
/// the broker is wedged, and a wedged broker must not stall a listing.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

/// The `reason` a release carries into the broker's log.
pub const RELEASE_REASON: &str = "released from the Agent Relay desktop app";

const CLAIMS_DIRECTORY: &str = "node-claims";
const CONNECTION_FILE: &str = "connection.json";
const ENROLLMENTS_FILE: &str = "fleet-enrollments.json";
/// The largest broker answer read; a worker list is a few kilobytes.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

// MARK: Discovery

/// One node-claims record. The supervising CLI writes the claim before the
/// broker exists, and a released generation leaves a tombstone so generation
/// numbers are never reused; only the newest generation per node counts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeClaim {
    pub node_id: String,
    pub generation: i64,
    /// A tombstone (`released: true`) ends the node's claim sequence.
    pub released: bool,
    pub state_dir: Option<String>,
    pub broker_name: Option<String>,
}

impl NodeClaim {
    /// The claim in `bytes`, or `None` for anything that is not a version 1
    /// claim record with a node id.
    pub fn decode(bytes: &[u8]) -> Option<NodeClaim> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        if value.get("version").and_then(Value::as_i64) != Some(1) {
            return None;
        }
        Some(NodeClaim {
            node_id: non_empty(&value, "node_id")?,
            generation: value.get("generation").and_then(Value::as_i64).unwrap_or(0),
            released: value.get("released").and_then(Value::as_bool) == Some(true),
            state_dir: non_empty(&value, "state_dir"),
            broker_name: non_empty(&value, "broker_name"),
        })
    }
}

/// `raw` as a bare loopback `http(s)` origin — the only place a broker API
/// key may be sent — or `None`: a remote host, user info, a path, a query or
/// a fragment is refused, so a hand-edited or stale connection file cannot
/// carry the key anywhere else.
pub fn loopback_origin(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(raw.trim()).ok()?;
    let loopback = match url.host()? {
        url::Host::Domain(name) => {
            name.eq_ignore_ascii_case("localhost") || name.eq_ignore_ascii_case("ip6-localhost")
        }
        url::Host::Ipv4(address) => address == std::net::Ipv4Addr::LOCALHOST,
        url::Host::Ipv6(address) => address == std::net::Ipv6Addr::LOCALHOST,
    };
    let bare = url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.path().is_empty() || url.path() == "/");
    (matches!(url.scheme(), "http" | "https") && loopback && bare).then_some(url)
}

/// One broker endpoint on this computer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrokerSource {
    /// Stable scope for worker identity and `fleet.release`: the claim's node
    /// id, else the state directory that produced the endpoint.
    pub scope: String,
    pub state_dir: PathBuf,
    /// The loopback origin, path `/`.
    pub origin: url::Url,
    /// The broker's own API key, from its connection file.
    pub api_key: Option<Secret>,
    /// The enrolled node (`node_…`), when a claim names one.
    pub node_id: Option<String>,
    /// The claim's `broker_name`, else the enrollment's node name.
    pub node_name: Option<String>,
    /// The workspace (`rw_…`) the node is enrolled in, when known.
    pub workspace_id: Option<String>,
}

impl BrokerSource {
    /// What listings and errors call this broker.
    pub fn display_name(&self) -> &str {
        self.node_name.as_deref().unwrap_or("local broker")
    }
}

/// The scoping fields of one `fleet-enrollments.json` node. The record's
/// `nodeToken` is a credential: the decoder skips it unread.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Enrollment {
    node_id: Option<String>,
    node_name: Option<String>,
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct EnrollmentStore {
    #[serde(default)]
    nodes: HashMap<String, Enrollment>,
}

impl<'de> Deserialize<'de> for Enrollment {
    /// Reads only `nodeId`, `nodeName` and `relayWorkspaceId`; any other key
    /// is skipped as `IgnoredAny`, and an entry that is not an object, or a
    /// field of the wrong type, reads as absent rather than failing the store.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Enrollment, D::Error> {
        struct EntryVisitor;

        impl<'de> Visitor<'de> for EntryVisitor {
            type Value = Enrollment;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("an enrollment record")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Enrollment, A::Error> {
                let mut entry = Enrollment::default();
                while let Some(key) = map.next_key::<String>()? {
                    let slot = match key.as_str() {
                        "nodeId" => &mut entry.node_id,
                        "nodeName" => &mut entry.node_name,
                        "relayWorkspaceId" => &mut entry.workspace_id,
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                            continue;
                        }
                    };
                    *slot = match map.next_value::<Value>()? {
                        Value::String(value) if !value.is_empty() => Some(value),
                        _ => None,
                    };
                }
                Ok(entry)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Enrollment, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Enrollment::default())
            }

            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Enrollment, E> {
                Ok(Enrollment::default())
            }

            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Enrollment, E> {
                Ok(Enrollment::default())
            }

            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Enrollment, E> {
                Ok(Enrollment::default())
            }

            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Enrollment, E> {
                Ok(Enrollment::default())
            }

            fn visit_str<E: de::Error>(self, _: &str) -> Result<Enrollment, E> {
                Ok(Enrollment::default())
            }

            fn visit_unit<E: de::Error>(self) -> Result<Enrollment, E> {
                Ok(Enrollment::default())
            }
        }

        deserializer.deserialize_any(EntryVisitor)
    }
}

/// `fleet-enrollments.json` as node id → enrollment.
fn enrollments(relay_home: &Path) -> HashMap<String, Enrollment> {
    let Some(bytes) = read(&relay_home.join(ENROLLMENTS_FILE)) else {
        return HashMap::new();
    };
    let Ok(store) = serde_json::from_slice::<EnrollmentStore>(&bytes) else {
        return HashMap::new();
    };
    store
        .nodes
        .into_values()
        .filter_map(|entry| Some((entry.node_id.clone()?, entry)))
        .collect()
}

/// A connection file's loopback origin and API key.
fn connection(state_dir: &Path) -> Option<(url::Url, Option<Secret>)> {
    let value: Value = serde_json::from_slice(&read(&state_dir.join(CONNECTION_FILE))?).ok()?;
    let origin = loopback_origin(value.get("url")?.as_str()?)?;
    Some((origin, non_empty(&value, "api_key").map(Secret::new)))
}

/// Every broker endpoint the relay home's files describe, deduplicated by
/// state directory, in a stable order.
///
/// - The newest claim generation per node names a state dir; when that
///   generation is a tombstone the node was released and contributes
///   nothing. At equal generations the tombstone wins: it ends the sequence.
/// - A state dir without a readable loopback connection file yields nothing:
///   the broker never finished starting, or points somewhere the key must
///   not go. A relative state dir is not an endpoint either.
/// - `<relay home>/connection.json` covers a broker that uses the relay home
///   itself as its state dir.
/// - Without `relay-cli` there are no brokers, so nothing routes through one.
pub fn broker_sources(relay_home: &Path) -> Vec<BrokerSource> {
    if cfg!(not(feature = "relay-cli")) {
        return Vec::new();
    }
    let enrolled = enrollments(relay_home);

    let mut names: Vec<String> = std::fs::read_dir(relay_home.join(CLAIMS_DIRECTORY))
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .filter(|name| name.ends_with(".json"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let mut latest: BTreeMap<String, NodeClaim> = BTreeMap::new();
    for name in names {
        let Some(claim) = read(&relay_home.join(CLAIMS_DIRECTORY).join(&name))
            .and_then(|bytes| NodeClaim::decode(&bytes))
        else {
            continue;
        };
        let newer = match latest.get(&claim.node_id) {
            None => true,
            Some(current) => {
                claim.generation > current.generation
                    || (claim.generation == current.generation && claim.released)
            }
        };
        if newer {
            latest.insert(claim.node_id.clone(), claim);
        }
    }

    let mut claimed: BTreeMap<PathBuf, NodeClaim> = BTreeMap::new();
    for claim in latest.into_values().filter(|claim| !claim.released) {
        let Some(dir) = claim.state_dir.as_deref().map(PathBuf::from) else {
            continue;
        };
        if dir.is_absolute() {
            claimed.entry(dir).or_insert(claim);
        }
    }

    let mut sources = Vec::new();
    for (dir, claim) in &claimed {
        let Some((origin, api_key)) = connection(dir) else {
            continue;
        };
        let enrollment = enrolled.get(&claim.node_id);
        sources.push(BrokerSource {
            scope: claim.node_id.clone(),
            state_dir: dir.clone(),
            origin,
            api_key,
            node_id: Some(claim.node_id.clone()),
            node_name: claim
                .broker_name
                .clone()
                .or_else(|| enrollment.and_then(|entry| entry.node_name.clone())),
            workspace_id: enrollment.and_then(|entry| entry.workspace_id.clone()),
        });
    }

    if !claimed.contains_key(relay_home) {
        if let Some((origin, api_key)) = connection(relay_home) {
            sources.push(BrokerSource {
                scope: relay_home.to_string_lossy().into_owned(),
                state_dir: relay_home.to_path_buf(),
                origin,
                api_key,
                node_id: None,
                node_name: None,
                workspace_id: None,
            });
        }
    }
    sources
}

// MARK: Workers

/// One worker as the broker reports it on `GET /api/spawned`. Every field but
/// `name` is optional, and a field of an unexpected type reads as absent:
/// older and newer brokers add or change keys, and a worker this core cannot
/// fully describe still lists.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Worker {
    pub name: String,
    /// The provider CLI the broker launched: `codex`, `claude`, `devin`, …
    pub cli: Option<String>,
    pub model: Option<String>,
    /// The headless provider name, where the runtime uses one.
    pub provider: Option<String>,
    pub runtime: Option<String>,
    /// `pty` | `headless` | `native`.
    pub runtime_kind: Option<String>,
    /// The provider session the worker runs (a Codex thread, a Claude Code
    /// session); absent for providers without one.
    pub session_id: Option<String>,
    /// The provider process reported by a PTY harness. This is only a hint
    /// until the kernel proves its uid, executable, start and session.
    pub pid: Option<u32>,
    /// The broker-owned wrapper process. Kept for diagnostics; delivery
    /// never treats it as provider authority.
    pub worker_pid: Option<u32>,
    pub channels: Vec<String>,
    /// True only after the broker observed the worker ready.
    pub ready: Option<bool>,
    /// Immutable identity for the generation-checked release.
    pub generation: Option<String>,
    /// `last_activity_at` (RFC 3339) as epoch milliseconds.
    pub last_activity_at_ms: Option<i64>,
    /// Milliseconds since the worker last acted, by the broker's clock.
    pub idle_ms: Option<u64>,
    /// `working` | `idle` | `blocked_on_send`.
    pub current_state: Option<String>,
    /// Messages queued for the worker but not yet delivered to it.
    pub pending_messages: Option<u64>,
}

/// What a worker is doing, as the broker last saw it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "unknown"))]
pub enum WorkerState {
    /// Spawned, not yet seen ready.
    Starting,
    Working,
    Idle,
    /// `blocked_on_send`: alive and held up mid-turn.
    Waiting,
    /// The broker did not say; the worker still lists.
    Unknown,
}

impl Worker {
    /// The broker's `{"agents": [...]}` envelope. A missing `agents` is an
    /// empty list; anything else that is not the contract — including a
    /// worker without a name, which could be neither shown nor released — is
    /// `BadResponse`.
    pub fn decode_list(bytes: &[u8]) -> Result<Vec<Worker>, BrokerError> {
        let envelope: Value =
            serde_json::from_slice(bytes).map_err(|_| BrokerError::BadResponse)?;
        let agents = match envelope
            .as_object()
            .ok_or(BrokerError::BadResponse)?
            .get("agents")
        {
            None | Some(Value::Null) => return Ok(Vec::new()),
            Some(Value::Array(agents)) => agents,
            Some(_) => return Err(BrokerError::BadResponse),
        };
        agents
            .iter()
            .map(|entry| Worker::from_json(entry).ok_or(BrokerError::BadResponse))
            .collect()
    }

    fn from_json(value: &Value) -> Option<Worker> {
        let text = |key: &str| non_empty(value, key);
        Some(Worker {
            name: text("name")?,
            cli: text("cli"),
            model: text("model"),
            provider: text("provider"),
            runtime: text("runtime"),
            runtime_kind: text("runtime_kind"),
            session_id: text("sessionId"),
            pid: value
                .get("pid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid != 0),
            worker_pid: value
                .get("workerPid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid != 0),
            channels: value
                .get("channels")
                .and_then(Value::as_array)
                .map(|channels| {
                    channels
                        .iter()
                        .filter_map(|channel| channel.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            ready: value.get("ready").and_then(Value::as_bool),
            generation: text("generation"),
            last_activity_at_ms: text("last_activity_at").and_then(|raw| parse_timestamp(&raw)),
            idle_ms: value.get("last_activity_ms").and_then(Value::as_u64),
            current_state: text("current_state"),
            pending_messages: value.get("pending_messages").and_then(Value::as_u64),
        })
    }

    /// The provider key: the launched CLI, then the headless provider, then
    /// the runtime — never a made-up name.
    pub fn provider_key(&self) -> String {
        self.cli
            .as_deref()
            .or(self.provider.as_deref())
            .or(self.runtime.as_deref())
            .unwrap_or("agent")
            .to_lowercase()
    }

    /// The provider's display name; an unknown provider is capitalized
    /// rather than left blank.
    pub fn provider_label(&self) -> String {
        let key = self.provider_key();
        let known = match key.as_str() {
            "codex" => "Codex",
            "claude" | "claude-code" | "claudecode" => "Claude",
            "devin" => "Devin",
            "cursor" | "cursor-agent" => "Cursor",
            "opencode" => "OpenCode",
            "grok" => "Grok",
            "gemini" => "Gemini",
            "copilot" => "Copilot",
            "amp" => "Amp",
            "droid" => "Droid",
            _ => {
                let mut chars = key.chars();
                return match chars.next() {
                    Some(first) => first.to_uppercase().chain(chars).collect(),
                    None => key,
                };
            }
        };
        known.to_string()
    }

    pub fn activity(&self) -> WorkerState {
        if self.ready == Some(false) {
            return WorkerState::Starting;
        }
        match self.current_state.as_deref() {
            Some("working") => WorkerState::Working,
            Some("idle") => WorkerState::Idle,
            Some("blocked_on_send") => WorkerState::Waiting,
            _ if self.ready == Some(true) => WorkerState::Idle,
            _ => WorkerState::Unknown,
        }
    }

    /// The local session this worker *is*, when its provider runs a session
    /// kind this computer also discovers on its own. A fleet Codex worker is
    /// its Codex thread; its fleet name is the canonical address, so the
    /// session must not also be offered as an injectable agent.
    pub fn managed_target(&self) -> Option<Target> {
        let session = self.session_id.as_deref().filter(|id| is_uuid(id))?;
        let kind = match self.provider_key().as_str() {
            "codex" => SessionKind::Codex,
            "claude" | "claude-code" | "claudecode" => SessionKind::ClaudeTerminal,
            "grok" => SessionKind::Grok,
            _ => return None,
        };
        // Codex threads have one spelling in targets: lowercase, as
        // discovery and caller identification write them.
        let id = match kind {
            SessionKind::Codex | SessionKind::Grok => session.to_lowercase(),
            _ => session.to_string(),
        };
        Some(Target::new(kind, id))
    }

    /// When the worker last acted, as epoch milliseconds: the broker's
    /// absolute timestamp, else its relative clock against `now_ms`.
    pub fn last_activity_ms(&self, now_ms: i64) -> Option<i64> {
        self.last_activity_at_ms.or_else(|| {
            self.idle_ms
                .map(|idle| now_ms.saturating_sub(i64::try_from(idle).unwrap_or(i64::MAX)))
        })
    }
}

/// RFC 3339, with or without a fraction (the broker writes nanoseconds), as
/// epoch milliseconds.
fn parse_timestamp(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|time| time.timestamp_millis())
}

// MARK: Broker HTTP

/// Why one broker request failed. The messages are fixed sentences: a
/// broker's own response body never reaches them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrokerError {
    /// The broker API is not where its connection file says — usually the
    /// process exited — or it missed the deadline.
    Unreachable,
    /// The broker answered with a non-success status (a refused redirect
    /// included).
    Api(u16),
    /// The broker answered, but not with the spawned-agent contract.
    BadResponse,
    /// A release without the worker's generation would be an unchecked
    /// delete; it is refused before any request goes out.
    NoGeneration,
}

impl fmt::Display for BrokerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BrokerError::Unreachable => f.write_str("The broker is not reachable."),
            BrokerError::Api(status) => write!(f, "The broker answered HTTP {status}."),
            BrokerError::BadResponse => {
                f.write_str("The broker answered with something this app does not understand.")
            }
            BrokerError::NoGeneration => {
                f.write_str("This worker's generation is unknown, so it can't be released safely.")
            }
        }
    }
}

impl std::error::Error for BrokerError {}

/// The HTTP side of one broker: `GET /api/spawned` and the
/// generation-checked `DELETE /api/spawned/{name}`.
pub struct BrokerClient<'a> {
    source: &'a BrokerSource,
    agent: ureq::Agent,
}

impl<'a> BrokerClient<'a> {
    /// A client whose every request finishes within `timeout` and never
    /// follows a redirect, so `X-API-Key` cannot be carried to a target that
    /// was never validated. Proxies from the environment are not used.
    pub fn new(source: &'a BrokerSource, timeout: Duration) -> BrokerClient<'a> {
        BrokerClient {
            source,
            agent: ureq::AgentBuilder::new()
                .redirects(0)
                .timeout(timeout)
                .build(),
        }
    }

    /// The workers this broker is running.
    pub fn workers(&self) -> Result<Vec<Worker>, BrokerError> {
        let (status, body) = self.send("GET", &["api", "spawned"], None)?;
        if status != 200 {
            return Err(BrokerError::Api(status));
        }
        Worker::decode_list(&body)
    }

    /// Releases `name` only while it is still `generation`, so a same-named
    /// replacement is never stopped by accident.
    pub fn release(&self, name: &str, generation: Option<&str>) -> Result<(), BrokerError> {
        let generation = generation
            .filter(|generation| !generation.is_empty())
            .ok_or(BrokerError::NoGeneration)?;
        let body = json!({"reason": RELEASE_REASON, "expected_generation": generation});
        let (status, _) = self.send("DELETE", &["api", "spawned", name], Some(body))?;
        match status {
            200 | 204 => Ok(()),
            status => Err(BrokerError::Api(status)),
        }
    }

    /// `segments` are percent-encoded one by one, so a worker name can never
    /// change the request's path.
    fn send(
        &self,
        method: &str,
        segments: &[&str],
        body: Option<Value>,
    ) -> Result<(u16, Vec<u8>), BrokerError> {
        let mut url = self.source.origin.clone();
        url.path_segments_mut()
            .map_err(|_| BrokerError::Unreachable)?
            .clear()
            .extend(segments);
        let mut request = self
            .agent
            .request_url(method, &url)
            .set("Accept", "application/json");
        if let Some(key) = &self.source.api_key {
            request = request.set("X-API-Key", key.expose());
        }
        let response = match body {
            Some(body) => request.send_json(body),
            None => request.call(),
        };
        let response = match response {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(_)) => return Err(BrokerError::Unreachable),
        };
        let status = response.status();
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(MAX_RESPONSE_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|_| BrokerError::Unreachable)?;
        Ok((status, bytes))
    }
}

// MARK: The fleet

/// One worker row of `fleet.list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct WorkerRow {
    /// `<node>|<name>`: stable across listings, so a restart is not a rename.
    pub id: String,
    pub name: String,
    /// The provider key (`codex`, `claude`, `devin`, …).
    pub provider: String,
    pub provider_label: String,
    pub model: Option<String>,
    pub runtime_kind: Option<String>,
    pub session_id: Option<String>,
    pub channels: Vec<String>,
    /// What `fleet.release` must send back; `null` cannot be released.
    pub generation: Option<String>,
    pub state: WorkerState,
    pub pending_messages: Option<u64>,
    /// When the worker last acted, epoch milliseconds.
    pub last_activity_ms: Option<i64>,
    /// The local session the worker owns, which is not offered as an
    /// injectable agent.
    pub target: Option<Target>,
}

/// One broker of `fleet.list`: its workers, or why they could not be read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct BrokerListing {
    /// The broker's scope: its node id, else its state directory.
    pub node_id: String,
    /// The node's display name.
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace_id: Option<String>,
    /// Set when the broker could not be read; `workers` is then empty and
    /// means nothing.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
    /// Most recently active first.
    pub workers: Vec<WorkerRow>,
}

/// `fleet.list`'s result.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct FleetListing {
    pub brokers: Vec<BrokerListing>,
}

/// This computer's fleet, discovered afresh on every call: brokers start and
/// stop independently of the core.
#[derive(Clone, Debug)]
pub struct Fleet {
    relay_home: PathBuf,
    timeout: Duration,
}

impl Fleet {
    pub fn new(relay_home: PathBuf) -> Fleet {
        Fleet {
            relay_home,
            timeout: REQUEST_TIMEOUT,
        }
    }

    /// The per-broker request deadline.
    pub fn with_timeout(mut self, timeout: Duration) -> Fleet {
        self.timeout = timeout;
        self
    }

    pub fn sources(&self) -> Vec<BrokerSource> {
        broker_sources(&self.relay_home)
    }

    /// Every broker's workers, fetched concurrently, in discovery order.
    pub fn read_blocking(&self) -> Vec<(BrokerSource, Result<Vec<Worker>, BrokerError>)> {
        let sources = self.sources();
        let results: Vec<Result<Vec<Worker>, BrokerError>> = std::thread::scope(|scope| {
            let handles: Vec<_> = sources
                .iter()
                .map(|source| scope.spawn(|| BrokerClient::new(source, self.timeout).workers()))
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap_or(Err(BrokerError::Unreachable)))
                .collect()
        });
        sources.into_iter().zip(results).collect()
    }

    pub fn list_blocking(&self) -> FleetListing {
        listing(self.read_blocking(), now_ms())
    }

    /// `fleet.list`. A broker that cannot be read carries an `error` rather
    /// than an empty worker list.
    pub async fn list(&self) -> FleetListing {
        let fleet = self.clone();
        blocking(move || fleet.list_blocking()).await
    }

    /// `fleet.release`: the broker serving `node_id` releases `name` if it
    /// is still `generation`.
    pub fn release_blocking(
        &self,
        node_id: &str,
        name: &str,
        generation: &str,
    ) -> Result<(), RpcError> {
        if name.is_empty() || generation.is_empty() {
            return Err(RpcError::invalid_params(
                "A release needs the worker's name and generation.",
            ));
        }
        let source = self
            .sources()
            .into_iter()
            .find(|source| source.scope == node_id)
            .ok_or_else(|| {
                RpcError::new(
                    ErrorKind::NotFound,
                    "No broker on this computer serves that node.",
                )
            })?;
        BrokerClient::new(&source, self.timeout)
            .release(name, Some(generation))
            .map_err(|error| release_error(&error))
    }

    pub async fn release(
        &self,
        node_id: &str,
        name: &str,
        generation: &str,
    ) -> Result<(), RpcError> {
        let fleet = self.clone();
        let (node_id, name, generation) = (
            node_id.to_string(),
            name.to_string(),
            generation.to_string(),
        );
        blocking(move || fleet.release_blocking(&node_id, &name, &generation)).await
    }

    /// The local sessions fleet workers own now, read fresh from every
    /// broker. Fails closed: when any broker cannot be read, ownership is
    /// unknown, and admitting a session could give a fleet worker's session a
    /// second name.
    pub fn managed_targets_blocking(&self) -> Result<HashSet<Target>, RpcError> {
        if !claims_readable(&self.relay_home) {
            return Err(fleet_unavailable());
        }
        managed_targets(self.read_blocking().into_iter().map(|(_, result)| result))
    }

    /// The one local worker that owns `target`, read from every broker.
    /// Duplicate ownership is refused: a thread UUID cannot choose between
    /// two provider processes merely because discovery order changed.
    pub fn managed_worker_blocking(&self, target: &Target) -> Result<Option<Worker>, RpcError> {
        let mut found = None;
        for worker in self.workers_blocking()? {
            if worker.managed_target().as_ref() != Some(target) {
                continue;
            }
            if found.is_some() {
                return Err(RpcError::new(
                    ErrorKind::Conflict,
                    "More than one fleet worker claims this provider session.",
                ));
            }
            found = Some(worker);
        }
        Ok(found)
    }

    /// Every worker reported by every local broker. This is deliberately
    /// separate from `managed_worker_blocking`: a starting broker-PTY Codex
    /// may not have published `sessionId` yet, while its kernel process and
    /// single writer lock already identify the exact thread.
    pub fn workers_blocking(&self) -> Result<Vec<Worker>, RpcError> {
        if !claims_readable(&self.relay_home) {
            return Err(fleet_unavailable());
        }
        let mut workers = Vec::new();
        for (_, result) in self.read_blocking() {
            workers.extend(result.map_err(|_| fleet_unavailable())?);
        }
        Ok(workers)
    }

    pub async fn managed_targets(&self) -> Result<HashSet<Target>, RpcError> {
        let fleet = self.clone();
        blocking(move || fleet.managed_targets_blocking()).await
    }
}

/// The targets the workers in `results` own, or the `fleet_unavailable`
/// refusal when any broker could not be read.
pub fn managed_targets(
    results: impl IntoIterator<Item = Result<Vec<Worker>, BrokerError>>,
) -> Result<HashSet<Target>, RpcError> {
    let mut targets = HashSet::new();
    for result in results {
        let workers = result.map_err(|_| fleet_unavailable())?;
        targets.extend(workers.iter().filter_map(Worker::managed_target));
    }
    Ok(targets)
}

/// The fleet's ownership of a session could not be verified. The kind is
/// `internal`: nothing about the request was wrong, and the caller decides
/// when to ask again.
pub fn fleet_unavailable() -> RpcError {
    RpcError::new(
        ErrorKind::FleetUnavailable,
        "Could not verify whether this session is already managed by this computer's relay.",
    )
}

/// A release failure as a bridge error.
fn release_error(error: &BrokerError) -> RpcError {
    match error {
        BrokerError::NoGeneration => RpcError::invalid_params(error.to_string()),
        BrokerError::Api(404) => {
            RpcError::new(ErrorKind::NotFound, "The broker has no such worker.")
        }
        BrokerError::Api(409) => RpcError::new(
            ErrorKind::Conflict,
            "The worker changed since it was listed; it was not released.",
        ),
        BrokerError::Api(401 | 403) => {
            RpcError::new(ErrorKind::Refused, "The broker refused the release.")
        }
        BrokerError::Api(_) | BrokerError::BadResponse | BrokerError::Unreachable => {
            RpcError::new(ErrorKind::Internal, error.to_string())
        }
    }
}

/// The wire listing for `results`, workers most recently active first.
pub fn listing(
    results: Vec<(BrokerSource, Result<Vec<Worker>, BrokerError>)>,
    now_ms: i64,
) -> FleetListing {
    let brokers = results
        .into_iter()
        .map(|(source, result)| {
            let (workers, error) = match result {
                Ok(workers) => (workers, None),
                Err(error) => (Vec::new(), Some(error.to_string())),
            };
            let mut workers: Vec<WorkerRow> = workers
                .iter()
                .map(|worker| WorkerRow {
                    id: format!("{}|{}", source.scope, worker.name),
                    name: worker.name.clone(),
                    provider: worker.provider_key(),
                    provider_label: worker.provider_label(),
                    model: worker.model.clone(),
                    runtime_kind: worker.runtime_kind.clone(),
                    session_id: worker.session_id.clone(),
                    channels: worker.channels.clone(),
                    generation: worker.generation.clone(),
                    state: worker.activity(),
                    pending_messages: worker.pending_messages,
                    last_activity_ms: worker.last_activity_ms(now_ms),
                    target: worker.managed_target(),
                })
                .collect();
            workers.sort_by_key(|row| std::cmp::Reverse(row.last_activity_ms));
            BrokerListing {
                node_id: source.scope.clone(),
                name: source.display_name().to_string(),
                workspace_id: source.workspace_id.clone(),
                error,
                workers,
            }
        })
        .collect();
    FleetListing { brokers }
}

// MARK: Bridge methods

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(fleet: &Fleet, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    if cfg!(not(feature = "relay-cli")) {
        return None;
    }
    Some(match method {
        method::FleetList::NAME => {
            answer::<method::FleetList, _>(raw, |_| async { Ok(fleet.list().await) }).await
        }
        method::FleetRelease::NAME => {
            answer::<method::FleetRelease, _>(raw, |request| async move {
                fleet
                    .release(&request.node_id, &request.name, &request.generation)
                    .await
                    .map(|_| Done {})
            })
            .await
        }
        _ => return None,
    })
}

// MARK: Plumbing

fn non_empty(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Whether the node claims can be read: none at all is a readable answer;
/// a directory or claim this user cannot read is not, so ownership is
/// unknown rather than empty. Without `relay-cli` no claim is read, so none
/// can leave ownership unknown.
fn claims_readable(relay_home: &Path) -> bool {
    if cfg!(not(feature = "relay-cli")) {
        return true;
    }
    let directory = relay_home.join(CLAIMS_DIRECTORY);
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
    };
    entries.into_iter().all(|entry| {
        let Ok(entry) = entry else {
            return false;
        };
        let is_claim = entry.file_name().to_string_lossy().ends_with(".json");
        !is_claim
            || match std::fs::File::open(entry.path()) {
                Ok(_) => true,
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            }
    })
}

fn read(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Runs blocking file and HTTP work off the async runtime. A panic there is
/// re-raised here rather than turned into an answer; the task is never
/// aborted, so the only other `JoinError` is a runtime shutting down, which
/// panics too.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

#[cfg(test)]
#[cfg_attr(not(feature = "relay-cli"), allow(dead_code, unused_imports))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    const UUID: &str = "01a0c221-6806-7210-af25-97e104b15049";

    // MARK: Fixtures

    /// A relay home in a temp dir.
    struct Home {
        _dir: tempfile::TempDir,
        path: PathBuf,
    }

    impl Home {
        fn new() -> Home {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("relay");
            std::fs::create_dir_all(path.join(CLAIMS_DIRECTORY)).unwrap();
            Home { _dir: dir, path }
        }

        fn write(&self, relative: &str, content: Value) {
            let path = self.path.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content.to_string()).unwrap();
        }

        fn dir(&self, relative: &str) -> String {
            self.path.join(relative).to_string_lossy().into_owned()
        }

        /// A claimed broker at `origin` with API key `test-key`.
        fn claim(&self, node: &str, origin: &str) {
            self.write(
                &format!("node-claims/{node}.1.json"),
                json!({"version":1,"node_id":node,"generation":1,
                       "state_dir":self.dir(&format!("{node}-state")),"broker_name":node}),
            );
            self.write(
                &format!("{node}-state/connection.json"),
                json!({"url":origin,"api_key":"test-key"}),
            );
        }

        fn sources(&self) -> Vec<BrokerSource> {
            broker_sources(&self.path)
        }

        fn fleet(&self) -> Fleet {
            Fleet::new(self.path.clone()).with_timeout(Duration::from_secs(2))
        }
    }

    #[cfg(not(feature = "relay-cli"))]
    #[tokio::test]
    async fn without_relay_cli_there_are_no_brokers_and_no_fleet_methods() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("connection.json"),
            json!({"url": "http://127.0.0.1:1", "api_key": "broker"}).to_string(),
        )
        .unwrap();
        assert!(broker_sources(home.path()).is_empty());
        let fleet = Fleet::new(home.path().to_path_buf());
        assert!(call(&fleet, method::FleetList::NAME, json!({}))
            .await
            .is_none());
        assert!(call(&fleet, method::FleetRelease::NAME, json!({}))
            .await
            .is_none());
    }

    #[cfg(not(feature = "relay-cli"))]
    #[test]
    fn without_relay_cli_unreadable_claims_block_nothing() {
        let home = tempfile::tempdir().unwrap();
        // A file where the directory belongs cannot be read as claims.
        std::fs::write(home.path().join(CLAIMS_DIRECTORY), "not a directory").unwrap();
        let fleet = Fleet::new(home.path().to_path_buf());
        assert!(fleet.managed_targets_blocking().unwrap().is_empty());
        assert!(fleet.workers_blocking().unwrap().is_empty());
    }

    #[derive(Clone, Debug)]
    struct Recorded {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }

    impl Recorded {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_str())
        }

        fn json(&self) -> Value {
            serde_json::from_slice(&self.body).unwrap()
        }
    }

    type Responder = dyn Fn(&Recorded) -> (u16, Vec<(String, String)>, String) + Send + Sync;

    /// An in-process broker on 127.0.0.1 that records every request and
    /// answers with `respond`.
    struct FakeBroker {
        origin: String,
        requests: Arc<Mutex<Vec<Recorded>>>,
    }

    impl FakeBroker {
        fn start(
            respond: impl Fn(&Recorded) -> (u16, Vec<(String, String)>, String) + Send + Sync + 'static,
        ) -> FakeBroker {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = requests.clone();
            let respond: Arc<Responder> = Arc::new(respond);
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let (recorded, respond) = (recorded.clone(), respond.clone());
                    std::thread::spawn(move || serve(stream, &recorded, &*respond));
                }
            });
            FakeBroker { origin, requests }
        }

        /// Answers `GET /api/spawned` with `agents` and anything else with 404.
        fn listing(agents: Value) -> FakeBroker {
            FakeBroker::start(move |request| match request.method.as_str() {
                "GET" if request.path == "/api/spawned" => {
                    (200, vec![], json!({"ok":true,"agents":agents}).to_string())
                }
                "DELETE" if request.json().get("expected_generation").is_some() => {
                    (200, vec![], json!({"ok":true}).to_string())
                }
                _ => (404, vec![], json!({"error":"not found"}).to_string()),
            })
        }

        fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }
    }

    fn serve(stream: TcpStream, recorded: &Mutex<Vec<Recorded>>, respond: &Responder) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default().to_string();
        let mut headers = Vec::new();
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            let (key, value) = header.split_once(':').unwrap();
            headers.push((key.trim().to_string(), value.trim().to_string()));
        }
        let length = headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
            .map(|(_, value)| value.parse::<usize>().unwrap())
            .unwrap_or(0);
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let request = Recorded {
            method,
            path,
            headers,
            body,
        };
        recorded.lock().unwrap().push(request.clone());
        let (status, extra, body) = respond(&request);
        let mut response = format!(
            "HTTP/1.1 {status} Fake\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for (key, value) in extra {
            response.push_str(&format!("{key}: {value}\r\n"));
        }
        response.push_str("\r\n");
        response.push_str(&body);
        let mut stream = stream;
        let _ = stream.write_all(response.as_bytes());
    }

    /// A loopback origin nothing listens on.
    fn dead_origin() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())
    }

    fn source(origin: &str) -> BrokerSource {
        BrokerSource {
            scope: "node_1".into(),
            state_dir: PathBuf::from("/s"),
            origin: loopback_origin(origin).unwrap(),
            api_key: Some(Secret::new("secret-key")),
            node_id: Some("node_1".into()),
            node_name: Some("sf-frame".into()),
            workspace_id: None,
        }
    }

    fn worker(ready: Option<bool>, state: Option<&str>) -> Worker {
        Worker {
            name: "w".into(),
            ready,
            current_state: state.map(str::to_string),
            ..Worker::default()
        }
    }

    fn kind(result: Result<Value, RpcError>) -> ErrorKind {
        result.unwrap_err().data.kind
    }

    // MARK: GET /api/spawned contract

    // FleetAgentsTests.testDecodesSpawnedWorkerList and
    // test_decodes_spawned_list_including_devin.
    #[test]
    fn fleet_decodes_spawned_worker_list() {
        let body = json!({"ok":true,"agents":[
            {"name":"relay-desktop-agents-devin-0923","cli":"devin","model":null,
             "runtime":"pty","runtime_kind":"pty","provider":"devin","sessionId":null,
             "team":null,"channels":["general"],"parent":"sf-frame","pid":8100,
             "ready":true,"generation":"gen_9f2d","last_activity_at":"2026-09-23T06:46:40.651360405Z",
             "last_activity_ms":250,"current_state":"working","pending_messages":14,
             "workerPid":8100,"native_harness_capabilities":{"pushes":["input"]}},
            {"name":"docs-codex-1","cli":"codex","model":"gpt-5","runtime":"pty",
             "provider":null,"sessionId":UUID,
             "channels":[],"pid":8200,"workerPid":8199,"ready":true,"generation":"gen_1",
             "last_activity_at":"2026-09-23T06:40:00Z","current_state":"idle",
             "pending_messages":0}
        ]});
        let workers = Worker::decode_list(body.to_string().as_bytes()).unwrap();
        assert_eq!(workers.len(), 2);

        let devin = &workers[0];
        assert_eq!(devin.name, "relay-desktop-agents-devin-0923");
        assert_eq!(devin.provider_key(), "devin");
        assert_eq!(devin.provider_label(), "Devin");
        assert_eq!(devin.activity(), WorkerState::Working);
        assert_eq!(devin.generation.as_deref(), Some("gen_9f2d"));
        assert_eq!(devin.pending_messages, Some(14));
        assert_eq!(devin.channels, vec!["general"]);
        assert!(devin.last_activity_at_ms.is_some());
        assert_eq!(devin.managed_target(), None);

        let codex = &workers[1];
        assert_eq!(codex.provider_key(), "codex");
        assert_eq!(codex.activity(), WorkerState::Idle);
        assert_eq!(codex.session_id.as_deref(), Some(UUID));
        assert_eq!(codex.pid, Some(8200));
        assert_eq!(codex.worker_pid, Some(8199));
        assert_eq!(
            codex.managed_target(),
            Some(Target::new(SessionKind::Codex, UUID))
        );
    }

    // FleetAgentsTests.testToleratesMissingOptionalFields and
    // test_tolerates_minimal_worker_records.
    #[test]
    fn fleet_tolerates_missing_and_mistyped_optional_fields() {
        let workers = Worker::decode_list(br#"{"agents":[{"name":"w"}]}"#).unwrap();
        assert_eq!(workers[0].name, "w");
        assert_eq!(workers[0].activity(), WorkerState::Unknown);
        assert_eq!(workers[0].generation, None);
        assert_eq!(workers[0].managed_target(), None);
        assert_eq!(workers[0].provider_key(), "agent");

        let mistyped = br#"{"agents":[{"name":"w","generation":7,"ready":"yes","channels":"general","pending_messages":-1}]}"#;
        let worker = &Worker::decode_list(mistyped).unwrap()[0];
        assert_eq!(worker.generation, None);
        assert_eq!(worker.ready, None);
        assert!(worker.channels.is_empty());
        assert_eq!(worker.pending_messages, None);

        assert_eq!(Worker::decode_list(br#"{"ok":true}"#).unwrap(), vec![]);
    }

    // FleetAgentsTests.testActivityMappingCoversTheLifecycle and
    // test_activity_mapping_covers_the_lifecycle.
    #[test]
    fn fleet_activity_mapping_covers_the_lifecycle() {
        assert_eq!(worker(Some(false), None).activity(), WorkerState::Starting);
        assert_eq!(
            worker(Some(true), Some("working")).activity(),
            WorkerState::Working
        );
        assert_eq!(
            worker(Some(true), Some("idle")).activity(),
            WorkerState::Idle
        );
        assert_eq!(
            worker(Some(true), Some("blocked_on_send")).activity(),
            WorkerState::Waiting
        );
        assert_eq!(
            worker(Some(true), Some("sleeping")).activity(),
            WorkerState::Idle
        );
        assert_eq!(worker(None, None).activity(), WorkerState::Unknown);
    }

    // FleetAgentsTests.testParsesTimestampsWithAndWithoutFractions.
    #[test]
    fn fleet_parses_timestamps_with_and_without_fractions() {
        assert_eq!(
            parse_timestamp("2026-09-23T06:46:40.651360405Z"),
            Some(parse_timestamp("2026-09-23T06:46:40Z").unwrap() + 651)
        );
        assert!(parse_timestamp("2026-09-23T06:46:40Z").is_some());
        assert_eq!(parse_timestamp("not a date"), None);
    }

    // FleetAgentsTests.testManagedTargetMapsProviderSessionsOnly.
    #[test]
    fn fleet_managed_target_maps_provider_sessions_only() {
        let with = |cli: &str, session: &str| Worker {
            name: "w".into(),
            cli: Some(cli.into()),
            session_id: Some(session.into()),
            ..Worker::default()
        };
        assert_eq!(
            with("claude", UUID).managed_target(),
            Some(Target::new(SessionKind::ClaudeTerminal, UUID))
        );
        assert_eq!(with("devin", UUID).managed_target(), None);
        // A Codex thread is lowercase in targets, however the broker spells it.
        assert_eq!(
            with("codex", &UUID.to_uppercase()).managed_target(),
            Some(Target::new(SessionKind::Codex, UUID.to_lowercase()))
        );
        assert_eq!(with("codex", "not-a-uuid").managed_target(), None);
    }

    // MARK: Claims and connection files

    // FleetAgentsTests.testDecodesClaimAndTombstone.
    #[test]
    fn fleet_decodes_claim_and_tombstone() {
        let claim = NodeClaim::decode(
            br#"{"version":1,"node_id":"node_abc","generation":3,"state_dir":"/r/sf-frame-node/state",
                 "api_port":28123,"broker_name":"sf-frame","pid":8123,"status":"active"}"#,
        )
        .unwrap();
        assert_eq!(claim.node_id, "node_abc");
        assert_eq!(claim.generation, 3);
        assert_eq!(claim.state_dir.as_deref(), Some("/r/sf-frame-node/state"));
        assert_eq!(claim.broker_name.as_deref(), Some("sf-frame"));
        assert!(!claim.released);

        let tombstone = NodeClaim::decode(
            br#"{"version":1,"node_id":"node_abc","generation":4,"released":true}"#,
        )
        .unwrap();
        assert!(tombstone.released);
        assert_eq!(tombstone.state_dir, None);

        assert_eq!(NodeClaim::decode(br#"{"version":2,"node_id":"x"}"#), None);
        assert_eq!(NodeClaim::decode(b"[]"), None);
    }

    // FleetAgentsTests.testConnectionOnlyTrustsBareLoopbackOrigins.
    #[test]
    fn fleet_connection_only_trusts_bare_loopback_origins() {
        let origin = |raw: &str| loopback_origin(raw).map(|url| url.to_string());
        assert_eq!(
            origin("http://127.0.0.1:28123").as_deref(),
            Some("http://127.0.0.1:28123/")
        );
        assert_eq!(
            origin("http://localhost:9999/").as_deref(),
            Some("http://localhost:9999/")
        );
        assert!(origin("https://[::1]:1").is_some());
        assert!(origin(" http://LOCALHOST:1 ").is_some());
        // Never send the API key off-loopback, to a credential URL, or a path.
        for refused in [
            "http://10.0.0.5:28123",
            "http://localhost.example.com:1",
            "http://user:pass@127.0.0.1:1",
            "http://127.0.0.1:1/api",
            "http://127.0.0.1:1/?q",
            "http://127.0.0.1:1/#f",
            "ftp://127.0.0.1:1",
            "not a url",
        ] {
            assert_eq!(origin(refused), None, "{refused}");
        }
    }

    // MARK: Discovery

    // test_relay_home_env_override.
    #[test]
    fn fleet_relay_home_env_override() {
        use crate::relay::workspace::relay_home;
        let set = |key: &str| (key == "AGENT_RELAY_HOME").then(|| "/x/relay".to_string());
        assert_eq!(relay_home(&set, Path::new("/h")), PathBuf::from("/x/relay"));
        assert_eq!(
            relay_home(&|_| None, Path::new("/h")),
            PathBuf::from("/h/.agentworkforce/relay")
        );
    }

    // FleetAgentsTests.testDiscoversClaimedBrokerWithEnrollmentScoping and
    // test_claimed_broker_with_enrollment_scoping.
    #[cfg(feature = "relay-cli")]
    #[test]
    fn fleet_discovers_claimed_broker_with_enrollment_scoping() {
        let home = Home::new();
        home.write(
            "node-claims/sf-frame.3.json",
            json!({"version":1,"node_id":"node_abc","generation":3,
                   "state_dir":home.dir("sf-frame-node/state"),"broker_name":"sf-frame"}),
        );
        home.write(
            "sf-frame-node/state/connection.json",
            json!({"url":"http://127.0.0.1:28123","api_key":"k","pid":1}),
        );
        home.write(
            "fleet-enrollments.json",
            json!({"nodes":{
                "e1":{"nodeId":"node_abc","nodeName":"sf-frame","nodeToken":"SECRET",
                      "relayWorkspaceId":"rw_123","relaycastUrl":"https://rc.example.com"},
                "junk":"not a record"}}),
        );
        let sources = home.sources();
        assert_eq!(sources.len(), 1);
        let source = &sources[0];
        assert_eq!(source.origin.as_str(), "http://127.0.0.1:28123/");
        assert_eq!(source.api_key.as_ref().map(Secret::expose), Some("k"));
        assert_eq!(source.node_id.as_deref(), Some("node_abc"));
        assert_eq!(source.node_name.as_deref(), Some("sf-frame"));
        assert_eq!(source.display_name(), "sf-frame");
        assert_eq!(source.workspace_id.as_deref(), Some("rw_123"));
        assert_eq!(source.scope, "node_abc");
        // Neither the node token nor the API key prints.
        let printed = format!("{source:?}");
        assert!(!printed.contains("SECRET"));
        assert!(!printed.contains("\"k\""));
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn fleet_enrollment_names_the_node_when_the_claim_does_not() {
        let home = Home::new();
        home.write(
            "node-claims/n.1.json",
            json!({"version":1,"node_id":"n1","generation":1,"state_dir":home.dir("s")}),
        );
        home.write("s/connection.json", json!({"url":"http://127.0.0.1:1"}));
        home.write(
            "fleet-enrollments.json",
            json!({"nodes":{"e1":{"nodeId":"n1","nodeName":"enrolled","nodeToken":"SECRET"}}}),
        );
        let sources = home.sources();
        assert_eq!(sources[0].node_name.as_deref(), Some("enrolled"));
        assert_eq!(sources[0].api_key, None);
    }

    // FleetAgentsTests.testLatestGenerationWinsAndTombstoneReleases and
    // test_tombstoned_latest_generation_is_released.
    #[test]
    fn fleet_latest_generation_wins_and_tombstone_releases() {
        let home = Home::new();
        home.write(
            "node-claims/n.1.json",
            json!({"version":1,"node_id":"n1","generation":1,"state_dir":home.dir("n1-state"),"broker_name":"old"}),
        );
        home.write(
            "node-claims/n.2.json",
            json!({"version":1,"node_id":"n1","generation":2,"released":true}),
        );
        home.write(
            "n1-state/connection.json",
            json!({"url":"http://127.0.0.1:1","api_key":"k"}),
        );
        assert!(home.sources().is_empty());

        // A tombstone at the same generation also ends the sequence.
        home.write(
            "node-claims/n.2.json",
            json!({"version":1,"node_id":"n1","generation":1,"released":true}),
        );
        assert!(home.sources().is_empty());
    }

    // test_newest_claim_wins_over_older_generations.
    #[cfg(feature = "relay-cli")]
    #[test]
    fn fleet_newest_claim_wins_over_older_generations() {
        let home = Home::new();
        for (generation, state) in [(1, "old-state"), (3, "new-state"), (2, "mid-state")] {
            home.write(
                &format!("node-claims/n.{generation}.json"),
                json!({"version":1,"node_id":"n1","generation":generation,
                       "state_dir":home.dir(state),"broker_name":format!("g{generation}")}),
            );
            home.write(
                &format!("{state}/connection.json"),
                json!({"url":"http://127.0.0.1:1"}),
            );
        }
        let sources = home.sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].node_name.as_deref(), Some("g3"));
    }

    // FleetAgentsTests.testStaleClaimWithoutConnectionFileYieldsNothing.
    #[test]
    fn fleet_stale_claim_without_connection_file_yields_nothing() {
        let home = Home::new();
        home.write(
            "node-claims/n.1.json",
            json!({"version":1,"node_id":"n1","generation":1,"state_dir":home.dir("gone-state")}),
        );
        home.write(
            "node-claims/relative.1.json",
            json!({"version":1,"node_id":"n2","generation":1,"state_dir":"relative-state"}),
        );
        home.write(
            "relative-state/connection.json",
            json!({"url":"http://127.0.0.1:1"}),
        );
        assert!(home.sources().is_empty());
    }

    // FleetAgentsTests.testStandaloneHomeConnectionIsFoundAndDeduplicated.
    #[cfg(feature = "relay-cli")]
    #[test]
    fn fleet_home_connection_is_deduplicated_against_its_claim() {
        let home = Home::new();
        home.write(
            "connection.json",
            json!({"url":"http://127.0.0.1:40000","api_key":"k"}),
        );
        home.write(
            "node-claims/n.1.json",
            json!({"version":1,"node_id":"n1","generation":1,
                   "state_dir":format!("{}/", home.dir("")),"broker_name":"self"}),
        );
        // The claim already covers the home state dir; the bare connection
        // file must not produce a second source for the same broker.
        let sources = home.sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].scope, "n1");
    }

    // test_home_connection_covers_unclaimed_broker.
    #[cfg(feature = "relay-cli")]
    #[test]
    fn fleet_home_connection_covers_unclaimed_broker() {
        let home = Home::new();
        home.write(
            "connection.json",
            json!({"url":"http://127.0.0.1:40000","api_key":"k"}),
        );
        let sources = home.sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].display_name(), "local broker");
        assert_eq!(sources[0].scope, home.path.to_string_lossy());
        assert_eq!(sources[0].node_id, None);
    }

    // FleetAgentsTests.testNonLoopbackConnectionIsRefusedNotFollowed and
    // test_non_loopback_connection_is_refused.
    #[test]
    fn fleet_non_loopback_connection_is_refused() {
        let home = Home::new();
        home.write(
            "node-claims/n.1.json",
            json!({"version":1,"node_id":"n1","generation":1,"state_dir":home.dir("s")}),
        );
        home.write(
            "s/connection.json",
            json!({"url":"http://192.168.1.50:9000","api_key":"k"}),
        );
        assert!(home.sources().is_empty());
    }

    // MARK: Rows

    // FleetAgentsTests.testFleetAgentIdentityIsStableAcrossReads.
    #[test]
    fn fleet_row_identity_is_stable_and_activity_falls_back_to_the_relative_clock() {
        let source = source("http://127.0.0.1:1");
        let worker = Worker {
            name: "w-1".into(),
            cli: Some("devin".into()),
            idle_ms: Some(500),
            ..Worker::default()
        };
        let read = || listing(vec![(source.clone(), Ok(vec![worker.clone()]))], 10_000);
        assert_eq!(read(), read());
        let row = &read().brokers[0].workers[0];
        assert_eq!(row.id, "node_1|w-1");
        assert_eq!(row.last_activity_ms, Some(9_500));
        assert_eq!(row.provider_label, "Devin");
    }

    #[test]
    fn fleet_listing_orders_most_recently_active_first() {
        let named = |name: &str, idle: Option<u64>| Worker {
            name: name.into(),
            idle_ms: idle,
            ..Worker::default()
        };
        let workers = vec![
            named("quiet", Some(9_000)),
            named("silent", None),
            named("busy", Some(10)),
        ];
        let listed = listing(vec![(source("http://127.0.0.1:1"), Ok(workers))], 10_000);
        let names: Vec<_> = listed.brokers[0]
            .workers
            .iter()
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(names, ["busy", "quiet", "silent"]);
    }

    // OutboundTests.testRegistrationAdmissionUsesFreshFleetOwnership.
    #[test]
    fn fleet_registration_admission_uses_fresh_fleet_ownership() {
        let fresh = Worker {
            name: "fresh".into(),
            cli: Some("claude".into()),
            session_id: Some("66666666-7777-8888-9999-000000000000".into()),
            ..Worker::default()
        };
        assert_eq!(
            managed_targets([Ok(vec![fresh])]).unwrap(),
            HashSet::from([Target::new(
                SessionKind::ClaudeTerminal,
                "66666666-7777-8888-9999-000000000000"
            )])
        );
    }

    // OutboundTests.testRegistrationAdmissionFailsClosedWhenAnyBrokerCannotBeRead.
    #[test]
    fn fleet_registration_admission_fails_closed_when_any_broker_cannot_be_read() {
        let error = managed_targets([Ok(vec![]), Err(BrokerError::Unreachable)]).unwrap_err();
        assert_eq!(error, fleet_unavailable());
    }

    // MARK: Broker HTTP over a real socket

    // FleetBridgeTests.testWorkersSendsApiKeyToSpawnedAndDecodes and
    // test_discovery_to_listing_over_a_real_socket.
    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_discovery_to_listing_sends_the_api_key_to_spawned() {
        let broker = FakeBroker::listing(json!([
            {"name":"w-devin","cli":"devin","ready":true,"current_state":"working","generation":"gen_7"}
        ]));
        let home = Home::new();
        home.claim("node_sf", &broker.origin);
        home.write(
            "fleet-enrollments.json",
            json!({"nodes":{"e":{"nodeId":"node_sf","relayWorkspaceId":"rw_1"}}}),
        );

        let listed = home.fleet().list().await;
        assert_eq!(listed.brokers.len(), 1);
        let only = &listed.brokers[0];
        assert_eq!(only.node_id, "node_sf");
        assert_eq!(only.error, None);
        assert_eq!(only.workspace_id.as_deref(), Some("rw_1"));
        assert_eq!(only.workers[0].id, "node_sf|w-devin");
        assert_eq!(only.workers[0].state, WorkerState::Working);

        let request = &broker.requests()[0];
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/api/spawned");
        assert_eq!(request.header("X-API-Key"), Some("test-key"));
    }

    // FleetBridgeTests.testReleaseSendsGenerationCheckInBody and
    // test_generation_checked_release_over_a_real_socket.
    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_release_sends_the_generation_check_in_the_body() {
        let broker = FakeBroker::listing(json!([]));
        let home = Home::new();
        home.claim("node_sf", &broker.origin);
        home.fleet()
            .release("node_sf", "w-devin", "gen_7")
            .await
            .unwrap();
        let request = &broker.requests()[0];
        assert_eq!(request.method, "DELETE");
        assert_eq!(request.path, "/api/spawned/w-devin");
        assert_eq!(request.header("X-API-Key"), Some("test-key"));
        assert_eq!(
            request.json(),
            json!({"expected_generation":"gen_7","reason":RELEASE_REASON})
        );
    }

    // FleetBridgeTests.testReleaseWithoutGenerationRefusesBeforeAnyRequest
    // and the unchecked half of test_generation_checked_release_over_a_real_socket.
    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_release_without_generation_refuses_before_any_request() {
        let broker = FakeBroker::listing(json!([]));
        let source = source(&broker.origin);
        let client = BrokerClient::new(&source, REQUEST_TIMEOUT);
        assert_eq!(client.release("w1", None), Err(BrokerError::NoGeneration));
        assert_eq!(
            client.release("w1", Some("")),
            Err(BrokerError::NoGeneration)
        );

        let home = Home::new();
        home.claim("node_sf", &broker.origin);
        let answer = call(
            &home.fleet(),
            "fleet.release",
            json!({"node_id":"node_sf","name":"w1","generation":""}),
        )
        .await
        .unwrap();
        assert_eq!(kind(answer), ErrorKind::InvalidParams);
        let answer = call(
            &home.fleet(),
            "fleet.release",
            json!({"node_id":"node_sf","name":"w1"}),
        )
        .await
        .unwrap();
        assert_eq!(kind(answer), ErrorKind::InvalidParams);
        assert!(
            broker.requests().is_empty(),
            "an unchecked release must never reach the wire"
        );
    }

    // FleetBridgeTests.testApiErrorSurfacesStatusAndBrokerMessage.
    #[test]
    fn fleet_api_error_surfaces_the_status_but_not_the_broker_body() {
        let broker = FakeBroker::start(|_| {
            (
                404,
                vec![],
                json!({"error":"agent not found rk_live_x"}).to_string(),
            )
        });
        let source = source(&broker.origin);
        let error = BrokerClient::new(&source, REQUEST_TIMEOUT)
            .workers()
            .unwrap_err();
        assert_eq!(error, BrokerError::Api(404));
        assert_eq!(error.to_string(), "The broker answered HTTP 404.");
    }

    // FleetBridgeTests.testTransportFailureMapsToUnreachable and
    // test_dead_broker_is_an_error_not_an_empty_list.
    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_dead_broker_is_an_error_not_an_empty_list() {
        let home = Home::new();
        home.claim("node_dead", &dead_origin());
        let listed = home.fleet().list().await;
        assert_eq!(listed.brokers.len(), 1);
        assert_eq!(
            listed.brokers[0].error.as_deref(),
            Some("The broker is not reachable.")
        );
        assert!(listed.brokers[0].workers.is_empty());
        assert_eq!(listed.brokers[0].name, "node_dead");

        let wire = serde_json::to_value(&listed).unwrap();
        assert_eq!(wire["brokers"][0]["error"], "The broker is not reachable.");
    }

    // FleetBridgeTests.testMalformedPayloadMapsToBadResponse.
    #[test]
    fn fleet_malformed_payload_is_a_bad_response() {
        for body in [
            "not json",
            "[]",
            r#"{"agents":{}}"#,
            r#"{"agents":[{"cli":"codex"}]}"#,
        ] {
            let broker = FakeBroker::start(move |_| (200, vec![], body.to_string()));
            let source = source(&broker.origin);
            assert_eq!(
                BrokerClient::new(&source, REQUEST_TIMEOUT).workers(),
                Err(BrokerError::BadResponse),
                "{body}"
            );
        }
    }

    // test_redirect_is_refused_not_followed_with_the_key.
    #[test]
    fn fleet_redirect_is_refused_not_followed_with_the_key() {
        let target = FakeBroker::listing(json!([]));
        let location = format!("{}/api/spawned", target.origin);
        let broker = FakeBroker::start(move |_| {
            (
                302,
                vec![("Location".into(), location.clone())],
                String::new(),
            )
        });
        let source = source(&broker.origin);
        assert_eq!(
            BrokerClient::new(&source, REQUEST_TIMEOUT).workers(),
            Err(BrokerError::Api(302))
        );
        assert_eq!(broker.requests().len(), 1);
        assert!(
            target.requests().is_empty(),
            "the key never reaches the target"
        );
    }

    #[test]
    fn fleet_release_name_is_one_path_segment() {
        let broker = FakeBroker::listing(json!([]));
        let source = source(&broker.origin);
        BrokerClient::new(&source, REQUEST_TIMEOUT)
            .release("../admin w", Some("gen_1"))
            .unwrap();
        assert_eq!(broker.requests()[0].path, "/api/spawned/..%2Fadmin%20w");
    }

    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_wedged_broker_hits_the_deadline_while_the_others_list() {
        let live = FakeBroker::listing(json!([{"name":"w","cli":"codex","sessionId":UUID}]));
        // Accepts and never answers.
        let wedged = TcpListener::bind("127.0.0.1:0").unwrap();
        let wedged_origin = format!("http://127.0.0.1:{}", wedged.local_addr().unwrap().port());
        let home = Home::new();
        home.claim("node_a", &live.origin);
        home.claim("node_b", &wedged_origin);
        let fleet = Fleet::new(home.path.clone()).with_timeout(Duration::from_millis(300));

        let started = Instant::now();
        let listed = fleet.list().await;
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(listed.brokers[0].node_id, "node_a");
        assert_eq!(listed.brokers[0].workers.len(), 1);
        assert_eq!(listed.brokers[1].node_id, "node_b");
        assert!(listed.brokers[1].error.is_some());

        // Ownership is unknown while one broker is wedged: fail closed.
        assert_eq!(
            fleet.managed_targets().await.unwrap_err(),
            fleet_unavailable()
        );
        drop(wedged);
    }

    // InjectableAgents.currentFleetTargetKeys, end to end.
    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_managed_targets_read_every_broker_fresh() {
        let broker = FakeBroker::listing(json!([
            {"name":"c","cli":"codex","sessionId":UUID},
            {"name":"d","cli":"devin","sessionId":UUID}
        ]));
        let home = Home::new();
        home.claim("node_sf", &broker.origin);
        assert_eq!(
            home.fleet().managed_targets().await.unwrap(),
            HashSet::from([Target::new(SessionKind::Codex, UUID)])
        );
        assert!(Fleet::new(Home::new().path)
            .managed_targets()
            .await
            .unwrap()
            .is_empty());
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn fleet_resolves_the_exact_worker_and_its_process_hints() {
        let broker = FakeBroker::listing(json!([
            {"name":"c","cli":"codex","sessionId":UUID,"pid":8200,"workerPid":8199},
            {"name":"other","cli":"codex","sessionId":"11111111-2222-3333-4444-555555555556","pid":8300}
        ]));
        let home = Home::new();
        home.claim("node_sf", &broker.origin);
        let worker = home
            .fleet()
            .managed_worker_blocking(&Target::new(SessionKind::Codex, UUID))
            .unwrap()
            .unwrap();
        assert_eq!(worker.name, "c");
        assert_eq!(worker.pid, Some(8200));
        assert_eq!(worker.worker_pid, Some(8199));
    }

    // MARK: Bridge methods

    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_list_method_reports_the_wire_shape() {
        let broker = FakeBroker::listing(json!([
            {"name":"docs-codex-1","cli":"codex","model":"gpt-5","runtime_kind":"pty",
             "sessionId":UUID,"channels":["general"],"ready":true,"generation":"gen_1",
             "last_activity_at":"2026-09-23T06:40:00Z","current_state":"idle","pending_messages":2}
        ]));
        let home = Home::new();
        home.claim("node_sf", &broker.origin);
        let result = call(&home.fleet(), "fleet.list", Value::Null)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result,
            json!({"brokers":[{"node_id":"node_sf","name":"node_sf","workers":[{
                "id":"node_sf|docs-codex-1","name":"docs-codex-1","provider":"codex",
                "provider_label":"Codex","model":"gpt-5","runtime_kind":"pty",
                "session_id":UUID,"channels":["general"],"generation":"gen_1",
                "state":"idle","pending_messages":2,"last_activity_ms":1_790_145_600_000_i64,
                "target":{"kind":"codex","id":UUID}}]}]})
        );
        assert!(!result.to_string().contains("test-key"));
    }

    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_release_method_maps_broker_answers() {
        let broker = FakeBroker::start(|request| {
            let status = match request.path.as_str() {
                "/api/spawned/gone" => 404,
                "/api/spawned/replaced" => 409,
                "/api/spawned/locked" => 401,
                "/api/spawned/broken" => 500,
                _ => 204,
            };
            (status, vec![], String::new())
        });
        let home = Home::new();
        home.claim("node_sf", &broker.origin);
        let fleet = home.fleet();
        let release = |name: &str, node: &str| {
            let fleet = fleet.clone();
            let params = json!({"node_id":node,"name":name,"generation":"gen_1"});
            async move { call(&fleet, "fleet.release", params).await.unwrap() }
        };
        assert_eq!(release("w", "node_sf").await.unwrap(), json!({}));
        assert_eq!(kind(release("gone", "node_sf").await), ErrorKind::NotFound);
        assert_eq!(
            kind(release("replaced", "node_sf").await),
            ErrorKind::Conflict
        );
        assert_eq!(kind(release("locked", "node_sf").await), ErrorKind::Refused);
        assert_eq!(
            kind(release("broken", "node_sf").await),
            ErrorKind::Internal
        );
        assert_eq!(kind(release("w", "node_other").await), ErrorKind::NotFound);
        assert_eq!(broker.requests().len(), 5);
    }

    #[cfg(feature = "relay-cli")]
    #[tokio::test]
    async fn fleet_call_answers_only_its_own_methods() {
        let fleet = Fleet::new(Home::new().path);
        assert!(call(&fleet, "agents.list", Value::Null).await.is_none());
        assert_eq!(
            call(&fleet, "fleet.list", json!({}))
                .await
                .unwrap()
                .unwrap(),
            json!({"brokers":[]})
        );
        for method in [method::FleetList::NAME, method::FleetRelease::NAME] {
            assert!(call(&fleet, method, json!({})).await.is_some());
        }
    }

    // Review: an unreadable claims directory is unknown ownership, not none.
    // Unix only: Windows has no mode that makes a file unreadable to its owner.
    #[cfg(feature = "relay-cli")]
    #[cfg(unix)]
    #[test]
    fn fleet_unreadable_claims_fail_closed() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let fleet = Fleet::new(home.path().to_path_buf());
        assert_eq!(fleet.managed_targets_blocking().unwrap(), HashSet::new());
        let claims = home.path().join(CLAIMS_DIRECTORY);
        std::fs::create_dir_all(&claims).unwrap();
        std::fs::write(claims.join("node.1.json"), "{}").unwrap();
        std::fs::set_permissions(
            claims.join("node.1.json"),
            std::fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        let unreadable = std::fs::read(claims.join("node.1.json")).is_err();
        let result = fleet.managed_targets_blocking();
        std::fs::set_permissions(
            claims.join("node.1.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        // Root reads anything; the refusal only shows for an ordinary user.
        if unreadable {
            assert!(result.is_err());
        }
    }
}
