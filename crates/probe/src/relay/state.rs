//! The daemon's observable state and the event stream built on it.
//!
//! UIs render from one snapshot, `Status`. Every change bumps `revision` and
//! publishes the whole snapshot on the `status` topic, so a client never
//! merges deltas: it replaces what it shows. `activity` lines are the only
//! append-only events.

use crate::relay::contract::account::SignInReport;
use crate::relay::contract::connection::{
    ActivityLine, CoreNotification, Invalidation, ShutdownNotice,
};
use crate::relay::contract::EventData;
use crate::relay::protocol::{Event, Topic};
use crate::relay::push::PushState;
use crate::relay::workspace::Workspace;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use tokio::sync::broadcast;

/// The one snapshot the UI renders: `status.get`, `subscribe`, and the
/// `status` topic.
#[derive(Clone, Debug, Serialize, PartialEq, JsonSchema, Deserialize)]
pub struct Status {
    pub revision: u64,
    pub daemon: DaemonInfo,
    pub machine: MachineInfo,
    pub workspace: WorkspaceStatus,
    /// Push channel per registered agent name.
    pub push: BTreeMap<String, PushState>,
    pub agents: AgentsStatus,
    /// The Agent Relay sign-in and the uploader's connection.
    pub account: AccountStatus,
    /// This computer's spawn node: whether Agent Relay can start agents
    /// here. Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn: Option<SpawnStatus>,
}

/// Where this computer's spawn node stands.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "off"))]
pub enum SpawnState {
    /// Spawning is turned off, or this computer cannot spawn.
    #[default]
    Off,
    Connecting,
    /// Agent Relay offers this computer as a spawn target.
    Live,
    /// Disconnected; trying again.
    Waiting,
}

/// This computer's spawn node.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct SpawnStatus {
    pub state: SpawnState,
    /// The name Agent Relay lists as the spawn target; spawned agents are
    /// addressed `name@<node name>`.
    pub node_name: Option<String>,
    /// The harnesses it offers, such as `codex` and `claude`.
    pub harnesses: Vec<String>,
    /// Why it is not live.
    pub error: Option<String>,
    /// How many spawned agents it takes and how many places are taken.
    /// Absent in older cores and while spawning is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<SpawnSlots>,
    /// Every harness this core knows, in order: what Settings shows for
    /// each one it offers (`harnesses`). Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_descriptors: Option<Vec<HarnessDescriptor>>,
    /// Whether Agent Relay records the node as the signed-in person's.
    /// Absent in older cores and while spawning is off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<SpawnClaim>,
}

/// The node's owner in Agent Relay, recorded from its token and the
/// signed-in person's session (`relay::spawn::claim`).
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct SpawnClaim {
    pub state: SpawnClaimState,
    /// Why it is not claimed, when that is worth saying.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "pending"))]
pub enum SpawnClaimState {
    /// Not asked yet.
    #[default]
    Pending,
    /// Recorded as the signed-in person's node.
    Claimed,
    /// Another account owns it: the node takes no spawns until that owner,
    /// or a workspace owner, releases it.
    OwnedByOther,
    /// No Agent Relay sign-in to claim it with; asked again after a
    /// sign-in.
    SignedOut,
    /// Agent Relay did not record it; asked again after a backoff.
    Failed,
}

/// A harness this core knows, as the apps show its spawn settings
/// (`relay::harness::Descriptor`).
#[derive(Clone, Debug, Serialize, PartialEq, Eq, JsonSchema, Deserialize)]
pub struct HarnessDescriptor {
    /// Its id, as in `spawn:<id>` and `spawn_harnesses`.
    pub id: String,
    /// Its product name, such as `Codex`.
    pub label: String,
    /// Its full-access setting (`spawn_harnesses.<id>.full_access`);
    /// absent when it has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_access: Option<FullAccessDescriptor>,
    /// Whether how it is paid for may be stated
    /// (`spawn_harnesses.<id>.billing`).
    pub billing: bool,
}

/// A harness's full-access setting, shown as "<label>: full access".
#[derive(Clone, Debug, Serialize, PartialEq, Eq, JsonSchema, Deserialize)]
pub struct FullAccessDescriptor {
    /// What on and off mean for this harness.
    pub detail: String,
    /// Its value until the person chooses.
    pub default_on: bool,
}

/// The spawn node's places. A place is held from the spawn until the agent
/// is released or its session is seen to have ended; an idle agent keeps
/// its place.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct SpawnSlots {
    /// The most spawned agents this computer runs at once; 0 means no limit.
    pub max: u32,
    /// Places held by spawned agents, idle ones included.
    pub held: u32,
    /// Spawns starting now.
    pub reserved: u32,
}

impl SpawnSlots {
    /// None means unlimited, using Relaycast's documented max=0 sentinel.
    pub fn free(&self) -> Option<u32> {
        (self.max != 0).then(|| {
            self.max
                .saturating_sub(self.held.saturating_add(self.reserved))
        })
    }
}

/// Whether this computer's spawn node reaches Agent Relay.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "unknown"))]
pub enum NodeReach {
    /// A heartbeat went out recently.
    Reachable,
    /// The connection is down.
    Unreachable,
    /// No recent evidence either way.
    #[default]
    Unknown,
}

/// Whether a spawned agent's session runs.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "unknown"))]
pub enum ProcessLiveness {
    Running,
    /// Seen to have ended: crashed, finished, or a Codex thread no longer
    /// loaded anywhere.
    Exited,
    #[default]
    Unknown,
}

/// What a spawned agent's harness is doing.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "unknown"))]
pub enum WorkState {
    /// A turn is running.
    Working,
    /// No turn is running; ready for a message.
    Idle,
    /// Blocked on something other than a message, such as a permission.
    Waiting,
    /// Finished and ended on its own.
    Completed,
    #[default]
    Unknown,
}

/// The node's reachability, as of `at`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct NodeEvidence {
    pub state: NodeReach,
    /// When it was last seen (ISO-8601); kept when the evidence went stale.
    pub at: Option<String>,
}

/// A spawned agent's process liveness, as of `at`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct ProcessEvidence {
    pub state: ProcessLiveness,
    pub at: Option<String>,
}

/// A spawned agent's harness work state, as of `at`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct WorkEvidence {
    pub state: WorkState,
    pub at: Option<String>,
}

/// What a spawned agent left undone when its session ended.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct UnfinishedWork {
    /// When its session was seen to have ended (ISO-8601).
    pub ended_at: String,
    /// A turn was running when it ended.
    pub turn_in_progress: bool,
    /// Messages to it Agent Relay has not seen it take; absent until
    /// counted, or when they could not be.
    pub pending_deliveries: Option<u32>,
}

/// The lifecycle of an agent this computer spawned. Each piece of evidence
/// is timestamped and reads `unknown` once it is too old.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct SpawnedAgentState {
    /// `codex` or `claude`.
    pub harness: String,
    /// It holds one of the node's places.
    pub holds_slot: bool,
    pub node: NodeEvidence,
    pub process: ProcessEvidence,
    pub work: WorkEvidence,
    /// Set once its session ended without being released.
    pub unfinished: Option<UnfinishedWork>,
}

/// Where the Agent Relay sign-in stands.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "error"))]
pub enum SignInState {
    #[default]
    SignedOut,
    /// Waiting for the person to approve in the browser.
    PendingApproval,
    /// Signed in to Cloud; connecting the workspace and preparing uploads.
    Preparing,
    SignedIn,
    /// The person declined the device approval.
    Denied,
    /// The approval (device or browser) ran out of time.
    Expired,
    /// The last attempt failed; `error` says why.
    Error,
}

/// The signed-in person, as the uploader recorded them.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct AccountPerson {
    pub id: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

/// A workspace the authenticated person can choose before setup begins.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, JsonSchema, Deserialize)]
pub struct WorkspaceChoice {
    pub id: String,
    pub name: String,
    pub organization_name: Option<String>,
}

/// `status.account`: typed state for the UI, never the session itself.
#[derive(Clone, Debug, Serialize, PartialEq, Default, JsonSchema, Deserialize)]
pub struct AccountStatus {
    pub state: SignInState,
    /// What the attempt is doing: `checking_existing_login`,
    /// `reusing_existing_login`, `waiting_for_browser`,
    /// `waiting_for_device_approval`, `selecting_workspace`, `connecting_workspace`,
    /// `preparing_local_sessions`.
    pub phase: Option<String>,
    pub error: Option<String>,
    /// What the person can do about `error`.
    pub action: Option<AccountAction>,
    pub reused_login: Option<bool>,
    pub site_url: Option<String>,
    /// The Agent Relay (Cloud) workspace.
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    /// Distinct workspaces available to the signed-in person; absent on older Cloud versions.
    pub workspace_count: Option<u64>,
    pub workspace_choices: Option<Vec<WorkspaceChoice>>,
    pub workspace_avatar_url: Option<String>,
    pub person: Option<AccountPerson>,
    /// Local capture progress while sessions are prepared.
    pub progress: Option<CaptureProgress>,
}

/// What the person can do about a failed sign-in.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountAction {
    /// `account.sign_in` with `acknowledge_uninspected_schedules` retries
    /// past an older uploader's schedules that could not be checked.
    AcknowledgeUninspectedSchedules,
}

/// Local capture progress while sessions are prepared for upload.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
pub struct CaptureProgress {
    /// `scanning`, `capture_paused`, `watching`, …: the probe's phase.
    pub phase: String,
    /// The history source being read (`codex`, `claude`), or empty.
    pub source: String,
    pub processed_files: u64,
    pub total_files: Option<u64>,
    pub sessions_captured: u64,
}

/// Problems with this computer's agents as a whole; per-agent detail is in
/// `agents.list` and `activity.list`.
#[derive(Clone, Debug, Serialize, PartialEq, Default, JsonSchema, Deserialize)]
pub struct AgentsStatus {
    /// Why the agent store could not be read or saved.
    pub store_error: Option<String>,
    /// The first agent whose delivery queue could not be read, and why.
    pub delivery_error: Option<String>,
    /// A local integration could not finish setup; retained for late-connecting apps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, JsonSchema, Deserialize)]
pub struct DaemonInfo {
    /// Git revision of the service build; absent in older cores.
    pub build_revision: Option<String>,
    /// Resolved ai-hist library version compiled into this service.
    pub history_version: Option<String>,
    pub version: String,
    pub bridge_version: u32,
    pub pid: u32,
    pub started_at_ms: i64,
    pub socket: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, JsonSchema, Deserialize)]
pub struct MachineInfo {
    pub host_name: String,
    /// The address prefix new registrations are issued with.
    pub machine_prefix: String,
}

/// The workspace as discovered, without its key.
#[derive(Clone, Debug, Serialize, PartialEq, Default, JsonSchema, Deserialize)]
pub struct WorkspaceStatus {
    /// `missing` (no key found) or `found`.
    pub state: WorkspaceState,
    pub base_url: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    /// The workspace's Relaycast plan (`free`, `pro`, `enterprise`,
    /// `selfhost`), once verification read it.
    pub workspace_plan: Option<String>,
    pub verification: Verification,
    pub checked_at_ms: Option<i64>,
}

/// Whether a workspace key was found.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "missing"))]
pub enum WorkspaceState {
    #[default]
    Missing,
    Found,
}

/// What Relaycast said about the discovered key.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, Default, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "pending"))]
pub enum Verification {
    /// Not asked yet.
    #[default]
    Pending,
    Verified,
    /// Relaycast refused the key.
    Rejected,
    /// Relaycast could not be reached; retried on the next refresh.
    Unreachable,
}

impl WorkspaceStatus {
    pub fn discovered(workspace: Option<&Workspace>) -> WorkspaceStatus {
        match workspace {
            None => WorkspaceStatus::default(),
            Some(workspace) => WorkspaceStatus {
                state: WorkspaceState::Found,
                base_url: Some(workspace.base_url.clone()),
                workspace_id: workspace.workspace_id.clone(),
                workspace_name: None,
                workspace_plan: None,
                verification: Verification::Pending,
                checked_at_ms: None,
            },
        }
    }
}

/// A listing a client re-fetches on `invalidated`.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Listing {
    Agents,
    Roster,
    Messages,
    People,
    Activity,
    Sessions,
    Fleet,
    /// Skip chat's saved conversation.
    Chat,
    /// Skip's saved project view and its push receipts.
    Projects,
    /// The uploader's status or sessions.
    Uploader,
    /// Incoming messages: threads shared, messages held.
    Incoming,
    /// The core's settings, changed from outside the app (an agent's
    /// `PATCH /settings`).
    Settings,
}

/// The level of an activity line.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "info"))]
pub enum Level {
    Info,
    Warning,
    Error,
}

/// Holds the snapshot and fans events out to every subscriber.
///
/// Lock order: `status`, then `seq`. Events are numbered and sent under
/// `seq`, so every receiver sees them in `seq` order.
pub struct Hub {
    status: Mutex<Status>,
    seq: Mutex<u64>,
    events: broadcast::Sender<Event>,
}

/// How many events a slow client may fall behind before it lags and is sent
/// a fresh snapshot.
const EVENT_BUFFER: usize = 256;

impl Hub {
    pub fn new(daemon: DaemonInfo, machine: MachineInfo) -> Hub {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        Hub {
            status: Mutex::new(Status {
                revision: 1,
                daemon,
                machine,
                workspace: WorkspaceStatus::default(),
                push: BTreeMap::new(),
                agents: AgentsStatus::default(),
                account: AccountStatus::default(),
                spawn: None,
            }),
            seq: Mutex::new(0),
            events,
        }
    }

    pub fn snapshot(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// A new receiver plus the `status` event that stands for everything
    /// published before it: the current snapshot under the latest `seq`.
    /// Taken under both locks, so the receiver yields exactly the events
    /// after that snapshot. A lagging client resumes from here.
    pub fn resync(&self) -> (broadcast::Receiver<Event>, Event) {
        let status = self.status.lock().unwrap();
        let seq = self.seq.lock().unwrap();
        let event = Event {
            topic: Topic::Status,
            seq: *seq,
            data: serde_json::to_value(&*status).unwrap(),
        };
        (self.events.subscribe(), event)
    }

    /// Applies `change`; publishes the snapshot when anything differs.
    pub fn update(&self, change: impl FnOnce(&mut Status)) -> Status {
        let mut status = self.status.lock().unwrap();
        let before = status.clone();
        change(&mut status);
        if *status != before {
            status.revision = before.revision + 1;
            let snapshot = status.clone();
            // Published under the lock so snapshot events leave in revision order.
            self.publish(&snapshot);
            snapshot
        } else {
            status.clone()
        }
    }

    pub fn activity(&self, level: Level, message: impl Into<String>) {
        self.publish(&ActivityLine {
            level,
            message: message.into(),
            at_ms: now_ms(),
        });
    }

    pub fn shutting_down(&self) {
        self.publish(&ShutdownNotice {});
    }

    /// Tells subscribers to re-fetch a listing.
    pub fn invalidated(&self, what: Listing) {
        self.publish(&Invalidation { what });
    }

    /// Sign-in progress (`account.sign_in`).
    pub fn sign_in(&self, report: &SignInReport) {
        self.publish(report);
    }

    /// Asks the UI to show a notification; `link` opens on click.
    pub fn notify(&self, title: &str, body: &str, link: Option<&str>) {
        self.publish(&CoreNotification {
            title: title.into(),
            body: body.into(),
            link: link.map(str::to_string),
        });
    }

    /// Sends `data` on its own topic, the only one the registry allows it.
    fn publish<E: EventData>(&self, data: &E) {
        let data = serde_json::to_value(data).expect("event payloads serialize");
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        let _ = self.events.send(Event {
            topic: E::TOPIC,
            seq: *seq,
            data,
        });
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::protocol::BRIDGE_VERSION;

    fn hub() -> Hub {
        Hub::new(
            DaemonInfo {
                build_revision: None,
                history_version: None,
                version: "0.0.0".into(),
                bridge_version: BRIDGE_VERSION,
                pid: 1,
                started_at_ms: 0,
                socket: "/tmp/core.sock".into(),
            },
            MachineInfo {
                host_name: "desk".into(),
                machine_prefix: "desk".into(),
            },
        )
    }

    #[test]
    fn a_change_bumps_the_revision_and_publishes_the_snapshot() {
        let hub = hub();
        let mut events = hub.subscribe();
        let status = hub.update(|status| {
            status.push.insert("alice".into(), PushState::Connecting);
        });
        assert_eq!(status.revision, 2);
        let event = events.try_recv().unwrap();
        assert_eq!(event.topic, Topic::Status);
        assert_eq!(event.seq, 1);
        assert_eq!(event.data["revision"], 2);
        assert_eq!(event.data["push"]["alice"]["state"], "connecting");
    }

    #[test]
    fn no_change_publishes_nothing() {
        let hub = hub();
        let mut events = hub.subscribe();
        hub.update(|_| {});
        assert!(events.try_recv().is_err());
        assert_eq!(hub.snapshot().revision, 1);
    }

    #[test]
    fn a_resync_stands_for_everything_before_its_receiver() {
        let hub = hub();
        hub.activity(Level::Info, "before");
        hub.update(|status| {
            status.push.insert("alice".into(), PushState::Live);
        });
        let (mut events, snapshot) = hub.resync();
        assert_eq!(snapshot.topic, Topic::Status);
        assert_eq!(snapshot.seq, 2);
        assert_eq!(snapshot.data["revision"], 2);
        assert!(events.try_recv().is_err());
        hub.activity(Level::Info, "after");
        assert_eq!(events.try_recv().unwrap().seq, 3);
    }

    #[test]
    fn the_snapshot_never_carries_a_key() {
        let workspace = Workspace {
            key: crate::relay::workspace::Secret::new("rk_live_secret0000"),
            base_url: "https://cast.agentrelay.com".into(),
            workspace_id: Some("rw_1".into()),
            source: Default::default(),
        };
        let hub = hub();
        hub.update(|status| status.workspace = WorkspaceStatus::discovered(Some(&workspace)));
        let text = serde_json::to_string(&hub.snapshot()).unwrap();
        assert!(!text.contains("rk_live_"), "{text}");
    }
}
