//! What this computer's agents are doing (`relay::activity`): derived every
//! `DERIVE_EVERY` for the registered sessions shared with the workspace,
//! and published to Relaycast as the `activity` roster metadata only when
//! it changes, at most once per `AGENT_EVERY` for an agent and
//! `PER_WINDOW` times per `WINDOW` for the whole computer. A publication
//! rides the name marker (`aliases::publish_marker`), so it is retried,
//! paused and serialized as titles and renames are.

use super::{AgentActivity, AgentTurn};
use crate::relay::daemon::Core;
use crate::relay::people::{decode_roster, Liveness, RosterAgent, RosterWhere};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::state::WorkState;
use crate::relay::store::{Registration, Target};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

const DERIVE_EVERY: Duration = Duration::from_secs(15);
const AGENT_EVERY: Duration = Duration::from_secs(120);
const WINDOW: Duration = Duration::from_secs(60);
const PER_WINDOW: usize = 6;

/// Each core's state, by its data folder, as the spawn ledger is kept.
static STATES: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<ActivityState>>>>> =
    LazyLock::new(Default::default);

#[derive(Default)]
pub(crate) struct ActivityState {
    derived_at: Option<Instant>,
    /// What each running, shared agent is doing now, by its shown name.
    current: HashMap<String, AgentActivity>,
    /// What Relaycast was last told, untimed, by name.
    published: HashMap<String, Option<AgentActivity>>,
    /// When a publication was last queued for each name.
    queued: HashMap<String, Instant>,
    /// Names `due` approved whose publication has not succeeded yet: only
    /// these carry `activity` on a marker write, so a title change or a
    /// startup backfill never sends it outside the limits.
    approved: HashSet<String>,
    /// When the computer's recent publications were queued.
    recent: VecDeque<Instant>,
}

impl ActivityState {
    /// Records what `names` are doing now, keeping the time of what has
    /// not changed, and forgets every other name.
    fn set(&mut self, found: HashMap<String, AgentActivity>, now_ms: i64) {
        let previous = std::mem::take(&mut self.current);
        for (name, mut activity) in found {
            activity.updated_ms = previous
                .get(&name)
                .filter(|old| old.untimed() == activity.untimed())
                .and_then(|old| old.updated_ms)
                .or(Some(now_ms));
            self.current.insert(name, activity);
        }
    }

    /// The names whose activity Relaycast should be told now, at most
    /// `PER_WINDOW` per `WINDOW` and once per `AGENT_EVERY` for a name.
    /// `names` are the running agents' shown names, oldest first; one not
    /// running is never published: rosters show activity only while live.
    pub(crate) fn due(&mut self, names: &[String], now: Instant) -> Vec<String> {
        while self
            .recent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= WINDOW)
        {
            self.recent.pop_front();
        }
        self.queued
            .retain(|name, at| names.contains(name) || now.duration_since(*at) < AGENT_EVERY);
        let mut due = Vec::new();
        for name in names {
            if self.recent.len() >= PER_WINDOW {
                break;
            }
            let wanted = self.current.get(name).map(AgentActivity::untimed);
            let changed = match self.published.get(name) {
                Some(told) => *told != wanted,
                // Not told since this core started: Relaycast may hold what
                // an earlier run published, so even nothing is said once.
                None => true,
            };
            let recently = self
                .queued
                .get(name)
                .is_some_and(|at| now.duration_since(*at) < AGENT_EVERY);
            if changed && !recently {
                self.queued.insert(name.clone(), now);
                self.recent.push_back(now);
                self.approved.insert(name.clone());
                due.push(name.clone());
            }
        }
        due
    }
}

/// The roster `items` Relaycast listed, decoded (`people::decode_roster`)
/// with what each live agent is doing (`fill_roster`).
pub(crate) fn roster_rows(
    core: &Core,
    items: &[Value],
    local: &HashMap<String, bool>,
    own_hash: Option<&str>,
) -> Vec<RosterAgent> {
    let mut agents = decode_roster(items, local, own_hash, crate::relay::state::now_ms());
    super::fill_roster(&mut agents, items, &core.local_activity());
    agents
}

/// A turn from what a spawned agent's harness reports.
fn spawned_turn(work: WorkState) -> Option<AgentTurn> {
    match work {
        WorkState::Working | WorkState::Waiting => Some(AgentTurn::Working),
        WorkState::Idle | WorkState::Completed => Some(AgentTurn::Idle),
        WorkState::Unknown => None,
    }
}

impl Core {
    fn activity(&self) -> Arc<Mutex<ActivityState>> {
        STATES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(self.config.app_data_dir.clone())
            .or_default()
            .clone()
    }

    /// Derives what the running, shared agents are doing, when due, and
    /// queues the changed ones for publication.
    pub(crate) async fn refresh_activity(&self, discovered: &[DiscoveredSession]) {
        let now = Instant::now();
        {
            let state = self.activity();
            let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
            if state
                .derived_at
                .is_some_and(|at| now.duration_since(at) < DERIVE_EVERY)
            {
                return;
            }
            state.derived_at = Some(now);
        }
        // Gated on session sharing: only a session shared with the
        // workspace says what it is doing.
        let shared = self
            .plugins
            .account
            .as_ref()
            .map(|account| account.relay_uploads.shared())
            .unwrap_or_default();
        let spawned_live = self.spawned_live();
        let live: HashSet<&Target> = discovered
            .iter()
            .filter(|s| s.live)
            .map(|s| &s.target)
            .chain(spawned_live.iter())
            .collect();
        let registrations: Vec<Registration> = self.store.read(|store| {
            let mut running: Vec<Registration> = store
                .registrations
                .iter()
                .filter(|r| r.archived_at.is_none() && live.contains(&r.target))
                .cloned()
                .collect();
            running.sort_by(|a, b| a.registered_at.cmp(&b.registered_at));
            running
        });
        let names: Vec<String> = registrations
            .iter()
            .map(|r| r.display_name().to_owned())
            .collect();
        let sharing: Vec<&Registration> = registrations
            .iter()
            .filter(|r| {
                r.target
                    .upload_key()
                    .is_some_and(|key| shared.contains(&key))
            })
            .collect();
        let inputs: Vec<(Target, Option<String>)> = sharing
            .iter()
            .map(|r| {
                let directory = discovered
                    .iter()
                    .find(|s| s.target == r.target)
                    .and_then(|s| s.directory.clone());
                (r.target.clone(), directory)
            })
            .collect();
        let sessions = self.plugins.sessions.clone();
        let mut seen = if inputs.is_empty() {
            HashMap::new()
        } else {
            tokio::task::spawn_blocking(move || sessions.activity(&inputs))
                .await
                .unwrap_or_default()
        };
        let work = self.spawned_work();
        let found: HashMap<String, AgentActivity> = sharing
            .iter()
            .filter_map(|r| {
                let mut session = seen.remove(&r.target).unwrap_or_default();
                if r.spawn.is_some() {
                    if let Some(turn) = work.get(&r.name).copied().and_then(spawned_turn) {
                        session.turn = Some(turn);
                    }
                }
                Some((r.display_name().to_owned(), session.with_title(&r.title)?))
            })
            .collect();
        let due = {
            let state = self.activity();
            let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
            state.set(found, crate::relay::state::now_ms());
            state.due(&names, now)
        };
        if due.is_empty() {
            return;
        }
        let _ = self.store.remember(|s| {
            let pending = s.pending_name_markers.get_or_insert_with(Vec::new);
            for name in due {
                if !pending.contains(&name) {
                    pending.push(name);
                }
            }
        });
    }

    /// What this computer's running, shared agents are doing, by shown name.
    pub(crate) fn local_activity(&self) -> HashMap<String, AgentActivity> {
        let shared = self.activity();
        let state = shared.lock().unwrap_or_else(|e| e.into_inner());
        state.current.clone()
    }

    /// The roster row of `registration`, a session on this computer asking
    /// for the roster before Relaycast lists it.
    pub(crate) fn own_roster_row(&self, registration: &Registration) -> RosterAgent {
        let name = registration.display_name();
        RosterAgent {
            name: name.to_owned(),
            address: Some(registration.current_address(&self.machine_prefix)),
            kind: "agent".into(),
            where_runs: RosterWhere::ThisComputer,
            status: "active".into(),
            liveness: Liveness::Live,
            last_seen_ms: None,
            description: registration
                .title
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            host: None,
            owner_hash: None,
            session_id: Some(registration.target.id.clone()),
            is_self: true,
            provider: Some(registration.target.kind.source().to_string()),
            activity: self.local_activity().remove(name),
        }
    }

    /// The `activity` metadata to publish for `name` now (`null` when it
    /// says nothing), with what it says; `None` unless `due` approved a
    /// publication for it.
    pub(crate) fn activity_metadata(&self, name: &str) -> Option<(Option<AgentActivity>, Value)> {
        let shared = self.activity();
        let state = shared.lock().unwrap_or_else(|e| e.into_inner());
        if !state.approved.contains(name) {
            return None;
        }
        let activity = state.current.get(name).cloned();
        let value = activity.as_ref().map_or(Value::Null, |a| {
            serde_json::to_value(a).unwrap_or(Value::Null)
        });
        Some((activity, value))
    }

    /// Relaycast holds `activity` for `name` now.
    pub(crate) fn activity_published(&self, name: &str, activity: Option<AgentActivity>) {
        let state = self.activity();
        let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
        state.approved.remove(name);
        state
            .published
            .insert(name.to_owned(), activity.map(|a| a.untimed()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doing(text: &str) -> AgentActivity {
        AgentActivity {
            turn: Some(AgentTurn::Working),
            doing: Some(text.into()),
            ..Default::default()
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn unchanged_activity_keeps_its_time() {
        let mut state = ActivityState::default();
        state.set(HashMap::from([("a".into(), doing("x"))]), 10);
        state.set(HashMap::from([("a".into(), doing("x"))]), 20);
        assert_eq!(state.current["a"].updated_ms, Some(10));
        state.set(HashMap::from([("a".into(), doing("y"))]), 30);
        assert_eq!(state.current["a"].updated_ms, Some(30));
        state.set(HashMap::new(), 40);
        assert!(state.current.is_empty());
    }

    #[test]
    fn only_changes_are_published_at_most_every_two_minutes_per_agent() {
        let start = Instant::now();
        let mut state = ActivityState::default();
        let a = names(&["a"]);
        // Never told since start: even nothing is said once, clearing what
        // an earlier run left.
        assert_eq!(state.due(&a, start), a);
        state.published.insert("a".into(), None);
        assert!(state.due(&a, start + AGENT_EVERY).is_empty());
        let start = start + AGENT_EVERY;
        state.approved.clear();
        state.set(HashMap::from([("a".into(), doing("x"))]), 1);
        assert!(state.approved.is_empty());
        assert_eq!(state.due(&a, start), a);
        // Only an approved name carries activity on its next marker write.
        assert!(state.approved.contains("a"));
        state.published.insert("a".into(), Some(doing("x")));
        // Told already; only its time changed.
        state.set(HashMap::from([("a".into(), doing("x"))]), 2);
        assert!(state.due(&a, start + AGENT_EVERY).is_empty());
        // A change waits out the agent's interval, then the latest goes.
        state.set(HashMap::from([("a".into(), doing("y"))]), 3);
        assert!(state.due(&a, start + Duration::from_secs(30)).is_empty());
        state.set(HashMap::from([("a".into(), doing("z"))]), 4);
        assert_eq!(state.due(&a, start + AGENT_EVERY), a);
        // Going quiet is published too, as a clear.
        state.published.insert("a".into(), Some(doing("z")));
        state.set(HashMap::new(), 5);
        assert_eq!(state.due(&a, start + AGENT_EVERY * 2), a);
    }

    #[test]
    fn a_busy_computer_publishes_at_most_six_a_minute() {
        let start = Instant::now();
        let mut state = ActivityState::default();
        let all: Vec<String> = (0..20).map(|n| format!("agent-{n}")).collect();
        state.set(all.iter().map(|n| (n.clone(), doing(n))).collect(), 1);
        assert_eq!(state.due(&all, start).len(), PER_WINDOW);
        assert!(state.due(&all, start + Duration::from_secs(30)).is_empty());
        // The next window takes the next six, oldest registration first.
        assert_eq!(
            state.due(&all, start + WINDOW),
            all[PER_WINDOW..PER_WINDOW * 2].to_vec()
        );
    }

    #[test]
    fn spawned_harness_turns_map_to_working_or_idle() {
        assert_eq!(spawned_turn(WorkState::Waiting), Some(AgentTurn::Working));
        assert_eq!(spawned_turn(WorkState::Completed), Some(AgentTurn::Idle));
        assert_eq!(spawned_turn(WorkState::Unknown), None);
    }
}
