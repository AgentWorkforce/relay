//! The rules of a spawned agent's lifecycle, apart from where the evidence
//! comes from (`observe`) and where it is kept (`spawn`'s ledger).
//!
//! Three pieces of evidence are tracked independently, each with the time it
//! was seen: whether the node reaches Agent Relay, whether the agent's
//! process runs, and what its harness is doing. Evidence older than its time
//! to live reads as unknown, never as its last value.
//!
//! A place (slot) is held from the spawn until the agent is released or its
//! process is positively seen to have ended. Idle and unknown agents keep
//! theirs. See `docs/node-lifecycle.md`.

use crate::relay::state::{
    NodeEvidence, NodeReach, ProcessEvidence, ProcessLiveness, SpawnSlots, UnfinishedWork,
    WorkEvidence, WorkState,
};
use chrono::{DateTime, Duration, Utc};

/// Relaycast calls a node live within 45 s of its last heartbeat; so does
/// the node of itself.
pub const NODE_TTL: Duration = Duration::seconds(45);
/// How long an observation of a process or a harness stands.
pub const EVIDENCE_TTL: Duration = Duration::seconds(60);
/// How often spawned agents are observed.
pub const OBSERVE_EVERY: std::time::Duration = std::time::Duration::from_secs(15);

/// The most spawned agents a computer may be set to run.
pub const MAX_AGENTS_LIMIT: u32 = 32;
/// Without a setting.
pub const DEFAULT_MAX_AGENTS: u32 = 0;

pub fn iso(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// One observation and when it was made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seen<T> {
    pub state: T,
    pub at: DateTime<Utc>,
}

impl<T: Copy> Seen<T> {
    pub fn new(state: T, at: DateTime<Utc>) -> Seen<T> {
        Seen { state, at }
    }

    /// The state while it is fresh: `None` once it is older than `ttl`. A
    /// time in the future (a clock set back) counts as fresh.
    pub fn current(&self, now: DateTime<Utc>, ttl: Duration) -> Option<T> {
        (now - self.at <= ttl).then_some(self.state)
    }
}

/// The node's connection, as the ledger keeps it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeSeen {
    /// A heartbeat was written at this time.
    Reached(DateTime<Utc>),
    /// The connection dropped at this time and is not back.
    Down(DateTime<Utc>),
}

pub fn node_evidence(seen: Option<NodeSeen>, now: DateTime<Utc>) -> NodeEvidence {
    match seen {
        None => NodeEvidence::default(),
        Some(NodeSeen::Reached(at)) => NodeEvidence {
            state: Seen::new(NodeReach::Reachable, at)
                .current(now, NODE_TTL)
                .unwrap_or(NodeReach::Unknown),
            at: Some(iso(at)),
        },
        // The connection is known to be down until it is back.
        Some(NodeSeen::Down(since)) => NodeEvidence {
            state: NodeReach::Unreachable,
            at: Some(iso(since)),
        },
    }
}

/// What one look at a spawned agent found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    pub process: ProcessLiveness,
    pub work: WorkState,
    /// A turn was running: for an ended agent, the work it left unfinished.
    pub turn_in_progress: bool,
}

/// Everything known of one spawned agent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentRecord {
    pub process: Option<Seen<ProcessLiveness>>,
    pub work: Option<Seen<WorkState>>,
    pub unfinished: Option<UnfinishedWork>,
}

/// How an observation changed an agent's place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    Unchanged,
    /// Its process was seen to end: its place is reclaimed.
    Ended {
        turn_in_progress: bool,
    },
    /// It runs again after it was seen to end: it holds a place again.
    Revived,
}

impl AgentRecord {
    /// Whether it holds a place. Only a positive sighting of its end frees
    /// one; that sighting stands even once it is old, until a newer one
    /// says it runs.
    pub fn holds_slot(&self) -> bool {
        self.process.map(|seen| seen.state) != Some(ProcessLiveness::Exited)
    }

    pub fn apply(&mut self, observation: Observation, now: DateTime<Utc>) -> Transition {
        let was_exited = !self.holds_slot();
        self.work = Some(Seen::new(observation.work, now));
        match observation.process {
            // Not knowing never undoes a seen end.
            ProcessLiveness::Unknown if was_exited => Transition::Unchanged,
            ProcessLiveness::Exited if !was_exited => {
                self.process = Some(Seen::new(ProcessLiveness::Exited, now));
                self.unfinished = Some(UnfinishedWork {
                    ended_at: iso(now),
                    turn_in_progress: observation.turn_in_progress,
                    pending_deliveries: None,
                });
                Transition::Ended {
                    turn_in_progress: observation.turn_in_progress,
                }
            }
            ProcessLiveness::Running if was_exited => {
                self.process = Some(Seen::new(ProcessLiveness::Running, now));
                self.unfinished = None;
                Transition::Revived
            }
            state => {
                self.process = Some(Seen::new(state, now));
                Transition::Unchanged
            }
        }
    }

    pub fn process_evidence(&self, now: DateTime<Utc>) -> ProcessEvidence {
        match self.process {
            None => ProcessEvidence::default(),
            Some(seen) => ProcessEvidence {
                state: seen
                    .current(now, EVIDENCE_TTL)
                    .unwrap_or(ProcessLiveness::Unknown),
                at: Some(iso(seen.at)),
            },
        }
    }

    pub fn work_evidence(&self, now: DateTime<Utc>) -> WorkEvidence {
        match self.work {
            None => WorkEvidence::default(),
            Some(seen) => WorkEvidence {
                state: seen
                    .current(now, EVIDENCE_TTL)
                    .unwrap_or(WorkState::Unknown),
                at: Some(iso(seen.at)),
            },
        }
    }
}

/// Why a spawn was refused for want of a place. Never queued, never sent
/// elsewhere: the requester chooses again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapacityRefusal {
    /// Every place is held.
    Exceeded(SpawnSlots),
    /// The last heartbeat advertised free places; they are gone now.
    Changed {
        slots: SpawnSlots,
        advertised_free: u32,
    },
}

impl CapacityRefusal {
    pub fn slots(&self) -> SpawnSlots {
        match self {
            CapacityRefusal::Exceeded(slots) | CapacityRefusal::Changed { slots, .. } => *slots,
        }
    }

    /// The agreed failure code (`wire::CAPACITY_*`).
    pub fn code(&self) -> &'static str {
        match self {
            CapacityRefusal::Exceeded(_) => super::wire::CAPACITY_EXCEEDED,
            CapacityRefusal::Changed { .. } => super::wire::CAPACITY_CHANGED,
        }
    }

    pub fn message(&self) -> String {
        match self {
            CapacityRefusal::Exceeded(slots) => format!(
                "this computer runs {} of at most {} spawned agents{}; release one or choose \
                 another node",
                slots.held,
                slots.max,
                starting(slots.reserved)
            ),
            CapacityRefusal::Changed {
                slots,
                advertised_free,
            } => format!(
                "this computer advertised {advertised_free} free place{} but has none now \
                 ({} of at most {} held{}); read the node roster again",
                if *advertised_free == 1 { "" } else { "s" },
                slots.held,
                slots.max,
                starting(slots.reserved)
            ),
        }
    }
}

fn starting(reserved: u32) -> String {
    if reserved == 0 {
        String::new()
    } else {
        format!(", {reserved} starting")
    }
}

/// Admits one more spawn while a place is free.
pub fn admit(slots: SpawnSlots, advertised_free: Option<u32>) -> Result<(), CapacityRefusal> {
    if slots.free().is_none_or(|free| free > 0) {
        return Ok(());
    }
    match advertised_free {
        Some(advertised_free) if advertised_free > 0 => Err(CapacityRefusal::Changed {
            slots,
            advertised_free,
        }),
        _ => Err(CapacityRefusal::Exceeded(slots)),
    }
}

/// The maximum a setting asks for, kept to what a computer may run.
pub fn max_agents(setting: Option<u32>) -> u32 {
    setting.unwrap_or(DEFAULT_MAX_AGENTS).min(MAX_AGENTS_LIMIT)
}

/// The work state of an agent whose process ended: completed when no turn
/// was running, unknown when one was.
pub fn ended_work(turn_in_progress: bool) -> WorkState {
    if turn_in_progress {
        WorkState::Unknown
    } else {
        WorkState::Completed
    }
}

/// Counts of held agents by work state, as the live advertisement carries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WorkCounts {
    pub working: u32,
    pub idle: u32,
    pub waiting: u32,
    pub completed: u32,
    pub unknown: u32,
}

impl WorkCounts {
    pub fn add(&mut self, state: WorkState) {
        match state {
            WorkState::Working => self.working += 1,
            WorkState::Idle => self.idle += 1,
            WorkState::Waiting => self.waiting += 1,
            WorkState::Completed => self.completed += 1,
            WorkState::Unknown => self.unknown += 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
    }

    fn seen(process: ProcessLiveness, work: WorkState, turn: bool) -> Observation {
        Observation {
            process,
            work,
            turn_in_progress: turn,
        }
    }

    #[test]
    fn evidence_reads_unknown_once_stale_never_as_its_last_value() {
        let mut record = AgentRecord::default();
        assert_eq!(
            record.process_evidence(at(0)).state,
            ProcessLiveness::Unknown
        );
        assert_eq!(record.process_evidence(at(0)).at, None);
        record.apply(
            seen(ProcessLiveness::Running, WorkState::Working, true),
            at(0),
        );
        assert_eq!(
            record.process_evidence(at(60)).state,
            ProcessLiveness::Running
        );
        assert_eq!(record.work_evidence(at(60)).state, WorkState::Working);
        let stale = record.work_evidence(at(61));
        assert_eq!(stale.state, WorkState::Unknown);
        assert_eq!(stale.at.as_deref(), Some(iso(at(0)).as_str()));
        assert_eq!(
            record.process_evidence(at(61)).state,
            ProcessLiveness::Unknown
        );
        // A clock set back is not stale.
        assert_eq!(
            record.process_evidence(at(-5)).state,
            ProcessLiveness::Running
        );
    }

    #[test]
    fn node_reachability_goes_unknown_after_45_seconds_and_unreachable_while_down() {
        assert_eq!(node_evidence(None, at(0)).state, NodeReach::Unknown);
        let reached = Some(NodeSeen::Reached(at(0)));
        assert_eq!(node_evidence(reached, at(45)).state, NodeReach::Reachable);
        assert_eq!(node_evidence(reached, at(46)).state, NodeReach::Unknown);
        let down = node_evidence(Some(NodeSeen::Down(at(10))), at(4000));
        assert_eq!(down.state, NodeReach::Unreachable);
        assert_eq!(down.at, Some(iso(at(10))));
    }

    #[test]
    fn work_moves_freely_and_idle_or_unknown_keep_the_place() {
        let mut record = AgentRecord::default();
        assert!(record.holds_slot(), "a new agent holds its place");
        for (work, process) in [
            (WorkState::Working, ProcessLiveness::Running),
            (WorkState::Idle, ProcessLiveness::Running),
            (WorkState::Waiting, ProcessLiveness::Running),
            (WorkState::Unknown, ProcessLiveness::Unknown),
            (WorkState::Idle, ProcessLiveness::Running),
        ] {
            assert_eq!(
                record.apply(seen(process, work, false), at(1)),
                Transition::Unchanged
            );
            assert!(record.holds_slot());
            assert_eq!(record.work_evidence(at(1)).state, work);
        }
    }

    #[test]
    fn a_seen_end_reclaims_the_place_records_unfinished_work_and_sticks() {
        let mut record = AgentRecord::default();
        record.apply(
            seen(ProcessLiveness::Running, WorkState::Working, true),
            at(0),
        );
        assert_eq!(
            record.apply(
                seen(ProcessLiveness::Exited, WorkState::Unknown, true),
                at(15)
            ),
            Transition::Ended {
                turn_in_progress: true
            }
        );
        assert!(!record.holds_slot());
        let unfinished = record.unfinished.clone().unwrap();
        assert!(unfinished.turn_in_progress);
        assert_eq!(unfinished.ended_at, iso(at(15)));
        // Seen again ended, or not seen at all: still ended, recorded once.
        assert_eq!(
            record.apply(
                seen(ProcessLiveness::Exited, WorkState::Unknown, true),
                at(30)
            ),
            Transition::Unchanged
        );
        assert_eq!(
            record.apply(
                seen(ProcessLiveness::Unknown, WorkState::Unknown, false),
                at(45)
            ),
            Transition::Unchanged
        );
        assert!(!record.holds_slot());
        assert_eq!(record.unfinished.as_ref().unwrap().ended_at, iso(at(15)));
        // Old as it gets, a seen end never turns back into a held place.
        assert!(!record.holds_slot());
        assert_eq!(
            record.process_evidence(at(4000)).state,
            ProcessLiveness::Unknown
        );
        // Running again (a Codex thread loaded again) holds a place again.
        assert_eq!(
            record.apply(
                seen(ProcessLiveness::Running, WorkState::Idle, false),
                at(60)
            ),
            Transition::Revived
        );
        assert!(record.holds_slot());
        assert_eq!(record.unfinished, None);
    }

    #[test]
    fn a_clean_end_is_completed_and_one_mid_turn_is_unknown() {
        assert_eq!(ended_work(false), WorkState::Completed);
        assert_eq!(ended_work(true), WorkState::Unknown);
    }

    #[test]
    fn a_spawn_is_admitted_only_with_a_free_place_and_refused_explicitly() {
        let slots = |held, reserved| SpawnSlots {
            max: 2,
            held,
            reserved,
        };
        assert_eq!(admit(slots(1, 0), None), Ok(()));
        assert_eq!(admit(slots(0, 1), Some(0)), Ok(()));
        assert_eq!(
            admit(slots(1, 1), None),
            Err(CapacityRefusal::Exceeded(slots(1, 1)))
        );
        assert_eq!(
            admit(slots(2, 0), Some(0)),
            Err(CapacityRefusal::Exceeded(slots(2, 0)))
        );
        assert_eq!(
            admit(slots(2, 0), Some(1)),
            Err(CapacityRefusal::Changed {
                slots: slots(2, 0),
                advertised_free: 1
            })
        );
        // Held beyond a lowered maximum is still full, never negative.
        assert_eq!(
            SpawnSlots {
                max: 1,
                held: 3,
                reserved: 0
            }
            .free(),
            Some(0)
        );
        let exceeded = CapacityRefusal::Exceeded(slots(1, 1));
        assert_eq!(exceeded.code(), "spawn_capacity_exceeded");
        assert_eq!(
            exceeded.message(),
            "this computer runs 1 of at most 2 spawned agents, 1 starting; release one or \
             choose another node"
        );
        let changed = CapacityRefusal::Changed {
            slots: slots(2, 0),
            advertised_free: 1,
        };
        assert_eq!(changed.code(), "capacity_changed");
        assert_eq!(changed.slots(), slots(2, 0));
        assert_eq!(
            changed.message(),
            "this computer advertised 1 free place but has none now (2 of at most 2 held); \
             read the node roster again"
        );
    }

    #[test]
    fn missing_default_is_unlimited_and_explicit_caps_are_kept() {
        assert_eq!(max_agents(None), 0);
        assert_eq!(max_agents(Some(0)), 0);
        assert_eq!(max_agents(Some(3)), 3);
        assert_eq!(max_agents(Some(12)), 12);
        let unlimited = SpawnSlots {
            max: 0,
            held: 100,
            reserved: 50,
        };
        assert_eq!(unlimited.free(), None);
        assert_eq!(admit(unlimited, Some(0)), Ok(()));
        assert_eq!(max_agents(Some(500)), MAX_AGENTS_LIMIT);
    }

    #[test]
    fn work_states_are_counted() {
        let mut counts = WorkCounts::default();
        for state in [WorkState::Working, WorkState::Idle, WorkState::Idle] {
            counts.add(state);
        }
        assert_eq!((counts.working, counts.idle, counts.unknown), (1, 2, 0));
    }
}
