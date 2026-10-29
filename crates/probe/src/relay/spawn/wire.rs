//! The Relaycast node frames a spawn node sends and reads. Relaycast's
//! fleet wire (`packages/types/src/fleet-wire.ts`) is strict about what a
//! node sends, so every outgoing frame here is built whole; incoming frames
//! are read leniently, since Relaycast may add fields.
//!
//! ```text
//! POST /v1/nodes (workspace key) {node_id, name, machine_id, kind:"ws", role:"broker"} ─▶ nt_live_…
//! wss://…/v1/node/ws (Authorization: Bearer nt_live_…)
//!   → node.register {provider:{name:"broker"}, capabilities:[spawn:codex, spawn:claude, release],
//!                    max_agents, repo_keys}
//!   ← reply ok
//!   → inventory.sync {agents:[…]}                     on connect, every 60 s, and when places change
//!   → node.heartbeat {handlers_live:true, active_agents, load, capabilities, …}
//!                                                     every 12 s, and when places change
//!   ← action.invoke {action:"spawn:codex", input:{name, cli, task, worker_cwd?}}
//!   → agent.register {name, invocation_id}  ← reply {agent_id, token}
//!   → action.result {output:{spawned:true, ready:true, name}} | {error}
//!   ← deliver {agent, …}                              read and acked over HTTP
//! ```
//!
//! Each `spawn:<harness>` capability carries `metadata.configured` (what the
//! person or an agent set: billing, full access, maximum agents,
//! repositories, whether teammates may spawn here; and what the node is:
//! `node_kind` `desktop` on `machine`) and `metadata.live` (measured for this frame: places and
//! resources, stamped `observed_at`). `release` carries the agents it can
//! release with their lifecycle, and the places reclaimed from agents that
//! ended unreleased. Relaycast's heartbeat and inventory frames are strict,
//! so capability metadata is the one place for these.

use super::lifecycle::WorkCounts;
use super::resources::Resources;
use crate::relay::state::{ProcessEvidence, SpawnSlots, UnfinishedWork, WorkEvidence};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

mod action;
pub use action::*;

/// The capacity this node offers. A bare `spawn` must never be advertised:
/// Relaycast would pin every spawn in the workspace to this node.
pub const RELEASE: &str = "release";
/// What kind of node this is, in each `spawn:<harness>` capability's
/// `metadata.configured.node_kind`: a person's desktop.
pub const NODE_KIND: &str = "desktop";

/// Relaycast's frame version.
pub const WIRE_VERSION: u64 = 1;

/// A harness a spawn node offers, by the id Relaycast routes it by
/// (`spawn:<id>`): one of the harnesses this core knows (`relay::harness`).
pub use crate::relay::harness::HarnessId;

/// `POST /v1/nodes`: enrolls (or re-enrolls) this computer's spawn node.
/// No `machine_id`: Relaycast could match it to a broker node this computer
/// also runs, and an agent here is addressed by the node's name.
pub fn enroll_body(node_id: &str, name: &str, version: &str) -> Value {
    json!({
        "node_id": node_id,
        "name": name,
        "kind": "ws",
        "role": "broker",
        "version": format!("relay-desktop/{version}"),
    })
}

/// How a harness's use is paid for, as the person states it. Agent Relay
/// does not check it; a requester may weigh it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Billing {
    #[default]
    Unspecified,
    /// A plan's seat, such as ChatGPT or Claude Max: its limits are shared
    /// with the person's own use.
    Subscription,
    /// Metered API usage.
    Api,
}

impl Billing {
    pub const ALL: [Billing; 3] = [Billing::Unspecified, Billing::Subscription, Billing::Api];

    pub fn name(self) -> &'static str {
        match self {
            Billing::Unspecified => "unspecified",
            Billing::Subscription => "subscription",
            Billing::Api => "api",
        }
    }

    pub fn from_name(name: &str) -> Option<Billing> {
        Billing::ALL
            .into_iter()
            .find(|billing| billing.name() == name)
    }
}

/// One offered harness, as configured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HarnessConfigured {
    pub harness: HarnessId,
    pub billing: Billing,
    pub full_access: bool,
}

/// What the person or an agent set: stable between edits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Configured {
    pub max_agents: u32,
    /// This computer's name, as agent metadata shows it.
    pub machine: String,
    /// Whether workspace owners and admins may spawn here, not only the
    /// node's owner. Cloud enforces it.
    pub teammates: bool,
    /// Owner/name keys of the repositories this computer offers to work in.
    pub repositories: Vec<String>,
    /// The harnesses offered, in order.
    pub harnesses: Vec<HarnessConfigured>,
}

/// One agent on this node, as the live advertisement lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveAgent {
    pub name: String,
    pub agent_id: String,
    pub harness: String,
    pub holds_slot: bool,
    pub process: ProcessEvidence,
    pub work: WorkEvidence,
}

/// A place taken back from an agent that ended without being released.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reclaimed {
    pub name: String,
    pub agent_id: String,
    pub unfinished: UnfinishedWork,
}

/// Measured for one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Live {
    /// ISO-8601, when it was measured.
    pub observed_at: String,
    pub slots: SpawnSlots,
    /// Agents holding places, by what their harness is doing.
    pub work: WorkCounts,
    pub resources: Resources,
    pub agents: Vec<LiveAgent>,
    pub reclaimed: Vec<Reclaimed>,
    /// Each harness's quota, where a quota source reports one
    /// (`relay::quota`, not wired yet): sent as `metadata.live.quota` on its
    /// `spawn:<harness>` capability, `null` until then.
    pub quota: Vec<(HarnessId, QuotaSignal)>,
}

/// A harness's normalized quota, in the shape of `relay::quota`'s
/// `QuotaReading` (lanes `CodexOAuth`/`CodexRpc` are Codex, `ClaudeOAuth` is
/// Claude). Every failure, stale reading or unidentified source is
/// `unknown`; with no lane turned on, nothing is reported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuotaSignal {
    /// `available`, `approaching_limit`, `blocked` or `unknown`.
    pub state: String,
    pub reason: Option<String>,
    /// ISO-8601, when it was read.
    pub observed_at: String,
    /// Read recently enough to stand; a stale reading's state is `unknown`.
    pub fresh: bool,
    /// ISO-8601, when the nearest limit window resets, if known.
    pub resets_at: Option<String>,
}

/// Everything the node says about itself in one frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Advertisement {
    pub configured: Configured,
    pub live: Live,
}

fn evidence(state: &impl serde::Serialize, at: &Option<String>) -> Value {
    json!({"state": state, "at": at})
}

impl Advertisement {
    fn configured_for(&self, harness: &HarnessConfigured) -> Value {
        json!({
            "harness": harness.harness.name(),
            "billing": harness.billing.name(),
            "full_access": harness.full_access,
            "max_agents": self.configured.max_agents,
            "repositories": self.configured.repositories,
            "node_kind": NODE_KIND,
            "machine": self.configured.machine,
            "teammates": self.configured.teammates,
        })
    }

    fn live_node(&self, harness: HarnessId) -> Value {
        let (slots, work) = (&self.live.slots, &self.live.work);
        let quota = self
            .live
            .quota
            .iter()
            .find(|(of, _)| *of == harness)
            .map(|(_, quota)| {
                json!({
                    "state": if quota.fresh { quota.state.as_str() } else { "unknown" },
                    "reason": quota.reason,
                    "observed_at": quota.observed_at,
                    "fresh": quota.fresh,
                    "resets_at": quota.resets_at,
                })
            });
        json!({
            "observed_at": self.live.observed_at,
            "slots": {
                "max": slots.max,
                "held": slots.held,
                "reserved": slots.reserved,
                "free": slots.free(),
                "working": work.working,
                "idle": work.idle,
                "waiting": work.waiting,
                "unknown": work.unknown,
            },
            "resources": self.live.resources.to_json(),
            "quota": quota,
        })
    }

    fn live_agents(&self) -> Value {
        json!({
            "observed_at": self.live.observed_at,
            "agents": self.live.agents.iter().map(|agent| json!({
                "name": agent.name,
                "agent_id": agent.agent_id,
                "harness": agent.harness,
                "holds_slot": agent.holds_slot,
                "process": evidence(&agent.process.state, &agent.process.at),
                "work": evidence(&agent.work.state, &agent.work.at),
            })).collect::<Vec<_>>(),
            "reclaimed": self.live.reclaimed.iter().map(|reclaimed| json!({
                "name": reclaimed.name,
                "agent_id": reclaimed.agent_id,
                "ended_at": reclaimed.unfinished.ended_at,
                "turn_in_progress": reclaimed.unfinished.turn_in_progress,
                "pending_deliveries": reclaimed.unfinished.pending_deliveries,
            })).collect::<Vec<_>>(),
        })
    }

    /// `spawn:<harness>` for each offered harness, and `release`. A bare
    /// `spawn` is never advertised: Relaycast would pin every spawn in the
    /// workspace to this node.
    pub fn capabilities(&self) -> Vec<Value> {
        self.configured
            .harnesses
            .iter()
            .map(|harness| {
                json!({
                    "name": harness.harness.capability(),
                    "kind": "capacity",
                    "metadata": {
                        "configured": self.configured_for(harness),
                        "live": self.live_node(harness.harness),
                    },
                })
            })
            .chain([
                json!({
                    "name": RELEASE,
                    "kind": "capacity",
                    "metadata": {"live": self.live_agents()},
                }),
                json!({"name": ERROR_DETAILS_CAPABILITY, "kind": ERROR_DETAILS_KIND}),
            ])
            .collect()
    }

    /// Slot utilization is unknown without a finite cap, never fabricated as zero.
    fn load(&self) -> Option<f64> {
        let max = self.configured.max_agents;
        (max != 0).then(|| (self.live.slots.held as f64 / max as f64).min(1.0))
    }
}

/// Everything that names this node on every frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeIdentity {
    pub node_id: String,
    pub name: String,
    /// New for every connection; Relaycast refuses a second live instance.
    pub instance_id: String,
    pub version: String,
}

impl NodeIdentity {
    fn provider(&self) -> Value {
        json!({"name": "broker", "instance_id": self.instance_id})
    }

    fn version(&self) -> String {
        format!("relay-desktop/{}", self.version)
    }

    /// The first frame on the socket. Tags and repositories are only read
    /// here, so changing them reconnects the node.
    pub fn register(&self, id: &str, advertisement: &Advertisement) -> Value {
        json!({
            "v": WIRE_VERSION,
            "type": "node.register",
            "id": id,
            "name": self.name,
            "node_id": self.node_id,
            "provider": self.provider(),
            "capabilities": advertisement.capabilities(),
            "max_agents": advertisement.configured.max_agents,
            "tags": [],
            "repo_keys": advertisement.configured.repositories,
            "version": self.version(),
            "resume_cursor": null,
        })
    }

    /// The keepalive, carrying the whole advertisement again: Relaycast
    /// replaces the capabilities, their metadata and the maximum with each
    /// one. `handlers_live` is what makes Cloud offer this node as a spawn
    /// target; `active_agents` counts held places, idle agents included.
    pub fn heartbeat(&self, advertisement: &Advertisement) -> Value {
        json!({
            "v": WIRE_VERSION,
            "type": "node.heartbeat",
            "provider": self.provider(),
            "name": self.name,
            "node_id": self.node_id,
            "capabilities": advertisement.capabilities(),
            "max_agents": advertisement.configured.max_agents,
            "version": self.version(),
            "load": advertisement.load(),
            "load_reported": advertisement.load().is_some(),
            "active_agents": advertisement.live.slots.held,
            "handlers_live": true,
        })
    }
}

/// Whether `key` is a repository key Relaycast accepts: `owner/name`, no
/// path or URL.
pub fn valid_repo_key(key: &str) -> bool {
    let part = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    };
    (3..=201).contains(&key.len())
        && matches!(key.split_once('/'), Some((owner, name)) if part(owner) && part(name))
}

/// One agent this node hosts, as `inventory.sync` lists it. An agent left
/// out is marked offline by Relaycast.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InventoryAgent {
    pub agent_id: String,
    pub name: String,
    pub invocation_id: String,
    pub session_ref: String,
}

pub fn inventory_sync(id: &str, agents: &[InventoryAgent]) -> Value {
    json!({
        "v": WIRE_VERSION,
        "type": "inventory.sync",
        "id": id,
        "agents": agents.iter().map(|agent| json!({
            "agent_id": agent.agent_id,
            "name": agent.name,
            "invocation_id": agent.invocation_id,
            "session_ref": agent.session_ref,
        })).collect::<Vec<_>>(),
    })
}

/// Creates the spawned agent on this node. Relaycast stamps
/// `metadata.fleet = {node_id, invocation_id}` from the socket, which is
/// what Cloud checks before it calls the spawn ready. It joins #general
/// when `general` (the `auto_join_general` setting).
pub fn agent_register(
    id: &str,
    name: &str,
    invocation_id: &str,
    session_ref: &str,
    general: bool,
) -> Value {
    json!({
        "v": WIRE_VERSION,
        "type": "agent.register",
        "id": id,
        "name": name,
        "invocation_id": invocation_id,
        "session_ref": session_ref,
        "resumable": true,
        "auto_join_general": general,
    })
}

/// Takes over `agent_id`, an agent this node registered (its origin), for
/// the spawn `invocation_id`: Relaycast rebinds it to the node, stamps the
/// invocation and answers as `agent.register` does, with a new token. The
/// only way to use a name an agent of this node still holds.
pub fn agent_recover(
    id: &str,
    name: &str,
    agent_id: &str,
    invocation_id: &str,
    session_ref: &str,
) -> Value {
    json!({
        "v": WIRE_VERSION,
        "type": "agent.recover",
        "id": id,
        "name": name,
        "expected_agent_id": agent_id,
        "invocation_id": invocation_id,
        "session_ref": session_ref,
        "resumable": true,
    })
}

/// Takes an agent off this node when the node itself ends it (not for an
/// engine-dispatched release, which Relaycast completes from the result).
pub fn agent_deregister(id: &str, agent_id: &str, name: &str) -> Value {
    json!({
        "v": WIRE_VERSION,
        "type": "agent.deregister",
        "id": id,
        "agent_id": agent_id,
        "name": name,
    })
}

/// The gate for `error_details`: Relaycast's strict `action.result` schema
/// takes only `error` or `output`. The node advertises this capability at
/// `node.register` and sends details only on a connection whose register
/// reply carries the server-authored `spawn_error_details_contract` naming
/// it. `accepted_capabilities` cannot be the gate: Relaycast marks every
/// capability accepted, unknown names included.
pub const ERROR_DETAILS_CAPABILITY: &str = "relay:spawn-error-details-v1";
/// Its kind: `capacity`, so an engine that does not know it never
/// materializes it as an invokable action.
const ERROR_DETAILS_KIND: &str = "capacity";
/// The register reply field a Relaycast that takes `error_details` sets.
const ERROR_DETAILS_CONTRACT_FIELD: &str = "spawn_error_details_contract";

/// Whether a `node.register` reply's data says Relaycast takes
/// `error_details` on `action.result`.
pub fn error_details_agreed(reply_data: &Value) -> bool {
    reply_data[ERROR_DETAILS_CONTRACT_FIELD] == ERROR_DETAILS_CAPABILITY
}

/// Whether `frame` is Relaycast's answer to the request `id`, and the data
/// or the refusal it carries.
pub fn reply_to<'a>(frame: &'a Value, id: &str) -> Option<Result<&'a Value, Refusal>> {
    if frame["id"].as_str() != Some(id) {
        return None;
    }
    match frame["type"].as_str() {
        Some("reply") if frame["ok"] != false => Some(Ok(&frame["data"])),
        Some("reply") | Some("error") => Some(Err(Refusal {
            code: frame["code"]
                .as_str()
                .or_else(|| frame["error"]["code"].as_str())
                .unwrap_or("refused")
                .to_string(),
            message: frame["message"]
                .as_str()
                .or_else(|| frame["error"]["message"].as_str())
                .unwrap_or("Relaycast refused the request.")
                .to_string(),
        })),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

/// The agent Relaycast created: its id and token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegisteredAgent {
    pub agent_id: String,
    pub token: String,
}

pub fn registered_agent(data: &Value) -> Option<RegisteredAgent> {
    let text = |key: &str| {
        data[key]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Some(RegisteredAgent {
        agent_id: text("agent_id")?,
        token: text("token")?,
    })
}

/// An `action.invoke` this node owns.
#[derive(Clone, Debug, PartialEq)]
pub enum Invoke {
    Spawn(SpawnRequest),
    Release(ReleaseRequest),
    /// Anything else, answered `handler_unavailable`.
    Other {
        invocation_id: String,
    },
}

/// What Cloud asks to start: `spawn_relay_agent`'s input, passed through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    pub invocation_id: String,
    pub harness: HarnessId,
    pub name: String,
    pub task: String,
    /// Absolute; `None` for the person's home folder.
    pub directory: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseRequest {
    pub invocation_id: String,
    pub name: String,
    pub expected_agent_id: Option<String>,
}

/// The longest task accepted, as Cloud's own limit.
pub const MAX_TASK_BYTES: usize = 8192;

/// Reads an `action.invoke`. `Err` carries the invocation id and the error
/// to answer with, for an invoke this node owns but cannot accept.
pub fn invoke(frame: &Value) -> Option<Result<Invoke, (String, String)>> {
    if frame["type"] != "action.invoke" {
        return None;
    }
    let invocation_id = frame["invocation_id"].as_str()?.to_string();
    let action = frame["action"].as_str().unwrap_or_default();
    let input = &frame["input"];
    if action == RELEASE {
        return Some(match valid_name(input["name"].as_str()) {
            Some(name) => Ok(Invoke::Release(ReleaseRequest {
                invocation_id,
                name,
                expected_agent_id: input["expected_agent_id"].as_str().map(str::to_string),
            })),
            None => Err((invocation_id, "release_failed: invalid agent name".into())),
        });
    }
    let Some(harness_name) = action.strip_prefix("spawn:") else {
        return Some(Ok(Invoke::Other { invocation_id }));
    };
    let fail = |error: &str| Some(Err((invocation_id.clone(), error.to_string())));
    let Some(harness) = HarnessId::from_name(harness_name) else {
        return fail(&format!(
            "spawn_harness_unsupported: this computer cannot spawn {harness_name} yet"
        ));
    };
    // The harness the action names wins; a `cli` that disagrees is a
    // request this node will not guess at.
    let cli = input["cli"]
        .as_str()
        .or_else(|| input["provider"].as_str())
        .or_else(|| input["command"].as_str());
    if cli.is_some_and(|cli| cli != harness.name()) {
        return fail("spawn_invalid_input: cli does not match the spawn action");
    }
    let Some(name) = valid_name(input["name"].as_str()) else {
        return fail("spawn_invalid_input: invalid agent name");
    };
    let task = input["task"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string();
    if task.len() > MAX_TASK_BYTES {
        return fail("spawn_invalid_input: task is longer than 8192 bytes");
    }
    let directory = match input["worker_cwd"].as_str().or(input["cwd"].as_str()) {
        None | Some("") => None,
        Some(path) if Path::new(path).is_absolute() => Some(PathBuf::from(path)),
        Some(_) => return fail("spawn_invalid_input: worker_cwd must be an absolute path"),
    };
    Some(Ok(Invoke::Spawn(SpawnRequest {
        invocation_id,
        harness,
        name,
        task,
        directory,
    })))
}

/// Cloud's own rule for a spawned agent's name.
fn valid_name(name: Option<&str>) -> Option<String> {
    let name = name?;
    let bytes = name.as_bytes();
    let valid = (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    valid.then(|| name.to_string())
}

/// The agent a `deliver` frame is for.
pub fn delivery_agent(frame: &Value) -> Option<&str> {
    (frame["type"] == "deliver")
        .then(|| frame["agent"].as_str())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::harness::{self, claude, codex};

    fn identity() -> NodeIdentity {
        NodeIdentity {
            node_id: "node_desktop_1".into(),
            name: "mac-desktop".into(),
            instance_id: "broker_abc".into(),
            version: "1.2.3".into(),
        }
    }

    pub(crate) fn advertisement(harnesses: &[HarnessId], held: u32) -> Advertisement {
        use crate::relay::state::{ProcessLiveness, WorkState};
        Advertisement {
            configured: Configured {
                max_agents: 8,
                machine: "Test-Mac-Mini".into(),
                teammates: false,
                repositories: vec!["AgentWorkforce/relay-desktop".into()],
                harnesses: harnesses
                    .iter()
                    .map(|harness| HarnessConfigured {
                        harness: *harness,
                        billing: Billing::Subscription,
                        full_access: *harness == codex::ID,
                    })
                    .collect(),
            },
            live: Live {
                observed_at: "2026-10-14T10:00:00Z".into(),
                slots: SpawnSlots {
                    max: 8,
                    held,
                    reserved: 1,
                },
                work: WorkCounts {
                    idle: held,
                    ..WorkCounts::default()
                },
                resources: Resources {
                    cpus: 10,
                    load_1m: Some(1.5),
                    memory_total_bytes: Some(64),
                    memory_available_bytes: Some(32),
                },
                agents: vec![LiveAgent {
                    name: "w1".into(),
                    agent_id: "a1".into(),
                    harness: "codex".into(),
                    holds_slot: true,
                    process: ProcessEvidence {
                        state: ProcessLiveness::Running,
                        at: Some("2026-10-14T09:59:55Z".into()),
                    },
                    work: WorkEvidence {
                        state: WorkState::Idle,
                        at: Some("2026-10-14T09:59:55Z".into()),
                    },
                }],
                reclaimed: vec![Reclaimed {
                    name: "w0".into(),
                    agent_id: "a0".into(),
                    unfinished: UnfinishedWork {
                        ended_at: "2026-10-14T09:00:00Z".into(),
                        turn_in_progress: true,
                        pending_deliveries: Some(2),
                    },
                }],
                quota: vec![(
                    codex::ID,
                    QuotaSignal {
                        state: "approaching_limit".into(),
                        reason: None,
                        observed_at: "2026-10-14T09:58:00Z".into(),
                        fresh: true,
                        resets_at: None,
                    },
                )],
            },
        }
    }

    #[test]
    fn registration_advertises_capacity_for_each_harness_and_release_never_bare_spawn() {
        let frame = identity().register("node_register_1", &advertisement(&harness::ids(), 0));
        assert_eq!(frame["type"], "node.register");
        assert_eq!(frame["provider"]["name"], "broker");
        let names: Vec<&str> = frame["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "spawn:codex",
                "spawn:claude",
                "spawn:opencode",
                "spawn:grok",
                "spawn:muse",
                "spawn:devin",
                "release",
                "relay:spawn-error-details-v1"
            ]
        );
        assert!(frame["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["kind"] == "capacity"));
        assert_eq!(frame["max_agents"], 8);
        assert_eq!(frame["tags"], json!([]));
        assert_eq!(frame["repo_keys"], json!(["AgentWorkforce/relay-desktop"]));
    }

    #[test]
    fn configured_and_live_facts_ride_apart_in_capability_metadata() {
        let frame = identity().heartbeat(&advertisement(&harness::ids(), 2));
        let codex = &frame["capabilities"][0]["metadata"];
        assert_eq!(
            codex["configured"],
            json!({"harness": "codex", "billing": "subscription", "full_access": true,
                "max_agents": 8, "repositories": ["AgentWorkforce/relay-desktop"],
                "node_kind": "desktop", "machine": "Test-Mac-Mini", "teammates": false})
        );
        assert_eq!(codex["live"]["observed_at"], "2026-10-14T10:00:00Z");
        assert_eq!(
            codex["live"]["slots"],
            json!({"max": 8, "held": 2, "reserved": 1, "free": 5, "working": 0, "idle": 2,
                "waiting": 0, "unknown": 0})
        );
        assert_eq!(codex["live"]["resources"]["cpus"], 10);
        assert_eq!(codex["live"]["quota"]["state"], "approaching_limit");
        let mut stale = advertisement(&harness::ids(), 2);
        stale.live.quota[0].1.fresh = false;
        let frame_stale = identity().heartbeat(&stale);
        assert_eq!(
            frame_stale["capabilities"][0]["metadata"]["live"]["quota"]["state"], "unknown",
            "a stale quota is never reported as its last state"
        );
        let claude = &frame["capabilities"][1]["metadata"];
        assert_eq!(claude["configured"]["full_access"], false);
        assert_eq!(
            claude["live"]["quota"],
            Value::Null,
            "the quota hook is per harness"
        );
        let release = &frame["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "release")
            .unwrap()["metadata"]["live"];
        assert_eq!(
            release["agents"][0],
            json!({"name": "w1", "agent_id": "a1", "harness": "codex", "holds_slot": true,
                "process": {"state": "running", "at": "2026-10-14T09:59:55Z"},
                "work": {"state": "idle", "at": "2026-10-14T09:59:55Z"}})
        );
        assert_eq!(
            release["reclaimed"][0],
            json!({"name": "w0", "agent_id": "a0", "ended_at": "2026-10-14T09:00:00Z",
                "turn_in_progress": true, "pending_deliveries": 2})
        );
        assert!(frame.get("repo_keys").is_none() && frame.get("tags").is_none());
    }

    #[test]
    fn a_heartbeat_says_handlers_are_live_and_reports_held_places_as_load() {
        let frame = identity().heartbeat(&advertisement(&[claude::ID], 2));
        assert_eq!(frame["handlers_live"], true);
        assert_eq!(frame["active_agents"], 2);
        assert_eq!(frame["max_agents"], 8);
        assert_eq!(frame["load"], 0.25);
        assert_eq!(frame["load_reported"], true);
        assert_eq!(frame["capabilities"][0]["name"], "spawn:claude");
    }

    #[test]
    fn unlimited_capacity_uses_the_documented_sentinel_without_inventing_utilization() {
        let mut ad = advertisement(&[claude::ID], 40);
        ad.configured.max_agents = 0;
        ad.live.slots.max = 0;
        ad.live.slots.reserved = 20;
        assert_eq!(identity().register("r", &ad)["max_agents"], 0);
        let frame = identity().heartbeat(&ad);
        assert_eq!(frame["max_agents"], 0);
        assert_eq!(frame["active_agents"], 40);
        assert_eq!(frame["load"], Value::Null);
        assert_eq!(frame["load_reported"], false);
        let slots = &frame["capabilities"][0]["metadata"]["live"]["slots"];
        assert_eq!(slots["free"], Value::Null);
        assert_eq!(slots["reserved"], 20);
    }

    #[test]
    fn repository_keys_are_owner_and_name_only() {
        for good in ["a/b", "AgentWorkforce/relay-desktop", "o_1/n.2-x"] {
            assert!(valid_repo_key(good), "{good}");
        }
        for bad in [
            "ab",
            "a/b/c",
            "/a/b",
            "../x",
            "a/..",
            "https://x/y",
            "a b/c",
            "a/",
        ] {
            assert!(!valid_repo_key(bad), "{bad}");
        }
        assert_eq!(Billing::from_name("api"), Some(Billing::Api));
        assert_eq!(Billing::from_name("free"), None);
    }

    #[test]
    fn a_detailed_failure_keeps_the_code_as_the_error_and_drops_unknown_counts() {
        let failure = SpawnFailure {
            code: CAPACITY_EXCEEDED,
            message: "full".into(),
            node: "mac-desktop".into(),
            harness: Some(codex::ID),
            active: Some(8),
            reserved: Some(0),
            max: Some(8),
            observed_at: "2026-10-14T10:00:00Z".into(),
            retryable: true,
        };
        assert_eq!(
            action_failure("inv_1", &failure, true),
            json!({"v": 1, "type": "action.result", "invocation_id": "inv_1",
                "error": "spawn_capacity_exceeded",
                "error_details": {"code": "spawn_capacity_exceeded", "message": "full",
                    "node": "mac-desktop", "harness": "codex", "active": 8, "reserved": 0,
                    "max": 8, "observed_at": "2026-10-14T10:00:00Z", "retryable": true}})
        );
        let unknown = SpawnFailure {
            code: TARGET_UNAVAILABLE,
            harness: None,
            active: None,
            reserved: None,
            max: None,
            retryable: true,
            ..failure
        };
        let details = &action_failure("inv_1", &unknown, true)["error_details"];
        assert_eq!(details["code"], "spawn_target_unavailable");
        assert!(details.get("active").is_none() && details.get("harness").is_none());
    }

    #[test]
    fn a_legacy_broker_receives_the_redacted_reason_without_unknown_fields() {
        let failure = SpawnFailure {
            code: HARNESS_UNAVAILABLE,
            message: "Credentials rejected api_key=private-value".into(),
            node: "desktop".into(),
            harness: Some(codex::ID),
            active: None,
            reserved: None,
            max: None,
            observed_at: "2026-10-19T00:00:00Z".into(),
            retryable: false,
        };
        let frame = action_failure("inv_1", &failure, false);
        assert_eq!(
            frame["error"],
            "spawn_harness_unavailable: Credentials rejected [redacted]"
        );
        assert!(frame.get("error_details").is_none());
    }

    #[test]
    fn details_are_sent_only_when_relaycast_names_the_contract() {
        let agreed = json!({"node": {}, "accepted_capabilities": [],
            "spawn_error_details_contract": "relay:spawn-error-details-v1"});
        assert!(error_details_agreed(&agreed));
        // Today's Relaycast: every capability "accepted", no contract field.
        let current = json!({"node": {}, "accepted_capabilities": [
            {"name": "relay:spawn-error-details-v1", "kind": "capacity", "accepted": true}]});
        assert!(!error_details_agreed(&current));
        let other = json!({"spawn_error_details_contract": "relay:spawn-error-details-v2"});
        assert!(!error_details_agreed(&other));
        assert!(!error_details_agreed(
            &json!({"spawn_error_details_contract": true})
        ));
        assert!(!error_details_agreed(&Value::Null));

        let failure = SpawnFailure {
            code: CAPACITY_EXCEEDED,
            message: "full".into(),
            node: "mac-desktop".into(),
            harness: Some(codex::ID),
            active: Some(1),
            reserved: Some(0),
            max: Some(1),
            observed_at: "2026-10-14T10:00:00Z".into(),
            retryable: true,
        };
        assert_eq!(
            action_failure("inv_1", &failure, false),
            json!({"v": 1, "type": "action.result", "invocation_id": "inv_1",
                "error": "spawn_capacity_exceeded: full"})
        );
    }

    #[test]
    fn a_spawn_invoke_is_read_with_the_harness_from_the_action() {
        // An absolute folder on this platform.
        let repo = if cfg!(windows) {
            r"C:\tmp\repo"
        } else {
            "/tmp/repo"
        };
        let frame = json!({"v": 1, "type": "action.invoke", "invocation_id": "inv_1",
            "action": "spawn:codex", "input": {"name": "w1", "cli": "codex", "task": " fix CI ",
            "target_node": "mac-desktop", "worker_cwd": repo, "verify_ready": true}});
        let Some(Ok(Invoke::Spawn(request))) = invoke(&frame) else {
            panic!("not a spawn")
        };
        assert_eq!(request.harness, codex::ID);
        assert_eq!(request.name, "w1");
        assert_eq!(request.task, "fix CI");
        assert_eq!(request.directory, Some(PathBuf::from(repo)));
    }

    #[test]
    fn a_spawn_with_a_relative_folder_a_bad_name_or_a_mismatched_cli_is_refused() {
        let spawn = |input: Value| {
            invoke(&json!({"type": "action.invoke", "invocation_id": "inv_1",
                "action": "spawn:claude", "input": input}))
        };
        for input in [
            json!({"name": "w1", "worker_cwd": "repo"}),
            json!({"name": "-w1"}),
            json!({"name": "w 1"}),
            json!({"name": "w1", "cli": "codex"}),
        ] {
            assert!(matches!(spawn(input), Some(Err((id, _))) if id == "inv_1"));
        }
        assert!(matches!(
            invoke(&json!({"type": "action.invoke", "invocation_id": "inv_2",
                "action": "spawn:gemini", "input": {"name": "w1"}})),
            Some(Err((_, error))) if error.starts_with("spawn_harness_unsupported")
        ));
    }

    #[test]
    fn a_release_and_an_unknown_action_are_told_apart() {
        let release = invoke(&json!({"type": "action.invoke", "invocation_id": "inv_3",
            "action": "release", "input": {"name": "w1", "expected_agent_id": "a1",
            "delete_agent": true}}));
        assert_eq!(
            release,
            Some(Ok(Invoke::Release(ReleaseRequest {
                invocation_id: "inv_3".into(),
                name: "w1".into(),
                expected_agent_id: Some("a1".into()),
            })))
        );
        assert_eq!(
            invoke(&json!({"type": "action.invoke", "invocation_id": "inv_4", "action": "task"})),
            Some(Ok(Invoke::Other {
                invocation_id: "inv_4".into()
            }))
        );
        assert_eq!(invoke(&json!({"type": "deliver"})), None);
    }

    #[test]
    fn replies_are_matched_by_id_and_refusals_carry_the_code() {
        let ok = json!({"v": 1, "id": "agent_register_1", "type": "reply", "ok": true,
            "data": {"agent_id": "a1", "name": "w1", "token": "at_live_x"}});
        let data = reply_to(&ok, "agent_register_1").unwrap().unwrap();
        assert_eq!(
            registered_agent(data),
            Some(RegisteredAgent {
                agent_id: "a1".into(),
                token: "at_live_x".into()
            })
        );
        assert!(reply_to(&ok, "other").is_none());
        let refused = json!({"v": 1, "id": "r", "type": "error", "ok": false,
            "code": "agent_already_exists", "message": "taken"});
        assert_eq!(
            reply_to(&refused, "r").unwrap().unwrap_err().code,
            "agent_already_exists"
        );
    }

    #[test]
    fn results_match_the_broker_shapes_cloud_reads() {
        assert_eq!(
            action_output("inv_1", spawned("w1")),
            json!({"v": 1, "type": "action.result", "invocation_id": "inv_1",
                "output": {"spawned": true, "ready": true, "name": "w1"}})
        );
        let warned = spawned_unconfirmed("w1", "none");
        assert_eq!(warned["warning"]["code"], "spawn_task_unconfirmed");
        assert_eq!(
            action_error("inv_1", "spawn_failed: x")["error"],
            "spawn_failed: x"
        );
        assert!(action_error("inv_1", "x").get("output").is_none());
    }
}
