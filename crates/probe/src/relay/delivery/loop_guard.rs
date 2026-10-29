//! The loop guard: two agents cannot keep messaging each other without a
//! person.
//!
//! Every direct message, @mention and thread reply between one of this
//! computer's agents and another agent counts toward their pair, in both
//! directions: a loop is two agents taking turns, so it is stopped at the
//! cap however the turns are split, and whichever side has no guard of its
//! own. This core sees both directions of each pair it holds one end of:
//! what its agent sends (the socket's `/send` and automatic final answers)
//! and what is delivered to it. A message seen both ways, between two of
//! this computer's agents, counts once, by its Relaycast message id.
//!
//! Past [`LIMIT`] messages in [`WINDOW_MS`] with no person in between, the
//! sending core refuses its agent's next message to that peer and the
//! receiving core refuses the next delivery from it, so an agent elsewhere
//! (another desktop, an SDK or cloud agent) is held to the cap too. The
//! count resets when the person signed in on this computer messages one of
//! the pair's agents here, and each message stops counting once it is
//! [`WINDOW_MS`] old.
//!
//! Only identities the core has verified key a pair: the session the
//! kernel names as the sender for its own messages, and Relaycast's agent
//! id of the sender for a delivery (of the recipient, as Relaycast resolves
//! the name, for a send). Nothing in a message decides who sent it or
//! whether a person did: a person is the signed-in owner's Relaycast
//! identity, matched by its immutable id.
//!
//! The counts are kept in `agent-loops.json` beside the other delivery
//! journals, so a restart does not reset a pair.

use super::channel::pins::save_atomically;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

mod routes;
pub(crate) use routes::LoopRefusal;

/// The journal's file name in the app data directory.
pub const FILE_NAME: &str = "agent-loops.json";
/// The prefix of a place reserved for a message not yet sent.
const RESERVED: &str = "reserved-";
/// Messages a pair may exchange in [`WINDOW_MS`] with no person in between.
/// An agent loop takes seconds a turn and reaches it within minutes; a
/// person trading messages with an agent rarely sends ten in ten minutes.
pub const LIMIT: usize = 20;
/// How long a message counts toward its pair.
pub const WINDOW_MS: i64 = 10 * 60 * 1000;
/// How long a message is remembered for the replies to it, and how many.
const KEPT_MS: i64 = 24 * 60 * 60 * 1000;
const KEPT: usize = 2000;
/// How long a recipient's resolved id is trusted before it is looked up
/// again.
const RESOLVED_FOR: Duration = Duration::from_secs(10 * 60);

/// One agent-to-agent message: between `agent`, on this computer, and
/// `peer`, by Relaycast agent ids.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Counted {
    agent: String,
    peer: String,
    message_id: String,
    at_ms: i64,
}

impl Counted {
    fn between(&self, a: &str, b: &str) -> bool {
        (self.agent == a && self.peer == b) || (self.agent == b && self.peer == a)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Journal {
    #[serde(default)]
    messages: Vec<Counted>,
    /// When a person last messaged each of this computer's agents.
    #[serde(default)]
    people: BTreeMap<String, i64>,
    /// The person's messages that reset a pair already, so one seen again
    /// (held for approval, or retried) does not reset it again.
    #[serde(default)]
    person_messages: Vec<(String, i64)>,
    /// Deliveries between two of this computer's agents let through at the
    /// cap because their sender's send had reserved a place and not yet
    /// answered: each is counted by that place until its send says which
    /// message it was. Kept, like counted messages, for the replies to it.
    #[serde(default)]
    waiting: Vec<Counted>,
}

/// A message's place in its pair's count, reserved before it is sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    id: String,
    agent: String,
    peer: String,
}

/// Whether a delivery may go on.
#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    /// Counted now, or already counted (a redelivery, or a message between
    /// two of this computer's agents its sender's send counted).
    Admitted,
    /// The pair is at the cap.
    Refused,
}

/// The journal, loaded once and saved on every change, and the recipients
/// resolved recently, in memory only.
#[derive(Debug, Default)]
pub struct LoopGuard {
    path: PathBuf,
    journal: Journal,
    resolved: HashMap<String, (String, Instant)>,
    /// When each pair was last reported stopped, so the activity log says
    /// it once a window rather than once a message.
    reported: HashMap<(String, String), i64>,
}

impl LoopGuard {
    /// The journal at `path`; empty when it is missing or unreadable.
    pub fn load(path: PathBuf) -> LoopGuard {
        let journal = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        LoopGuard {
            path,
            journal,
            ..LoopGuard::default()
        }
    }

    /// The messages between `a` and `b` that count at `now_ms`: in the
    /// window, and after a person last messaged either.
    pub fn count(&self, a: &str, b: &str, now_ms: i64) -> usize {
        self.journal
            .messages
            .iter()
            .filter(|m| self.counts(m, a, b, now_ms))
            .count()
    }

    /// Whether `m` counts toward the pair of `a` and `b` at `now_ms`: in
    /// the window, and after a person last messaged either.
    fn counts(&self, m: &Counted, a: &str, b: &str, now_ms: i64) -> bool {
        let since = [a, b]
            .iter()
            .filter_map(|agent| self.journal.people.get(*agent))
            .copied()
            .fold(now_ms - WINDOW_MS, i64::max);
        m.between(a, b) && m.at_ms > since && m.at_ms <= now_ms
    }

    /// Whether the pair is at the cap.
    pub fn is_over(&self, a: &str, b: &str, now_ms: i64) -> bool {
        self.count(a, b, now_ms) >= LIMIT
    }

    /// The other agent of the counted message `message_id` that `agent`
    /// took part in, counted or waiting on its send: who a reply to it goes
    /// to.
    pub fn peer_of(&self, agent: &str, message_id: &str) -> Option<String> {
        // A delivery still waiting on its send's answer is one too: a reply
        // to it counts toward the same pair.
        self.journal
            .messages
            .iter()
            .chain(&self.journal.waiting)
            .find(|m| m.message_id == message_id && (m.agent == agent || m.peer == agent))
            .map(|m| {
                if m.agent == agent {
                    m.peer.clone()
                } else {
                    m.agent.clone()
                }
            })
    }

    /// Counts a message unless the pair is at the cap. A message already
    /// counted is admitted again without counting twice.
    pub fn admit(
        &mut self,
        agent: &str,
        peer: &str,
        message_id: &str,
        now_ms: i64,
    ) -> Result<Admission, String> {
        let known = |m: &Counted| m.message_id == message_id && m.between(agent, peer);
        if self.journal.messages.iter().any(known) || self.journal.waiting.iter().any(known) {
            return Ok(Admission::Admitted);
        }
        if !self.is_over(agent, peer, now_ms) {
            self.record(agent, peer, message_id, now_ms)?;
            return Ok(Admission::Admitted);
        }
        // From an agent on this computer whose sends have not answered
        // yet: while it holds more places toward this agent, still
        // counting, than deliveries already wait on, this is one of those
        // messages. It counts by its send's place, which every send keeps
        // until its own answer.
        let reserved = self
            .journal
            .messages
            .iter()
            .filter(|m| {
                m.message_id.starts_with(RESERVED)
                    && m.agent == peer
                    && m.peer == agent
                    && self.counts(m, agent, peer, now_ms)
            })
            .count();
        let waiting = self
            .journal
            .waiting
            .iter()
            .filter(|m| m.agent == agent && m.peer == peer && self.counts(m, agent, peer, now_ms))
            .count();
        if waiting >= reserved {
            return Ok(Admission::Refused);
        }
        // Saved before it is admitted, so a reply to it after a restart
        // still finds its pair.
        self.journal.waiting.push(Counted {
            agent: agent.into(),
            peer: peer.into(),
            message_id: message_id.into(),
            at_ms: now_ms,
        });
        self.save()
            .inspect_err(|_| drop(self.journal.waiting.pop()))?;
        Ok(Admission::Admitted)
    }

    /// Counts a message that was sent, whatever the count.
    pub fn record(
        &mut self,
        agent: &str,
        peer: &str,
        message_id: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        if self
            .journal
            .messages
            .iter()
            .any(|m| m.message_id == message_id && m.between(agent, peer))
        {
            return Ok(());
        }
        let before = self.journal.messages.clone();
        self.journal.messages.push(Counted {
            agent: agent.into(),
            peer: peer.into(),
            message_id: message_id.into(),
            at_ms: now_ms,
        });
        self.prune(now_ms);
        self.save().inspect_err(|_| self.journal.messages = before)
    }

    /// Holds a place in the pair's count for a message about to be sent,
    /// on disk before it is sent: two sends at once cannot both take the
    /// last place, and a send is refused when its place cannot be saved.
    /// `None` at the cap.
    pub fn reserve(
        &mut self,
        agent: &str,
        peer: &str,
        now_ms: i64,
    ) -> Result<Option<Place>, String> {
        if self.is_over(agent, peer, now_ms) {
            return Ok(None);
        }
        let place = Place {
            id: format!("{RESERVED}{}", crate::relay::store::random_uuid()),
            agent: agent.into(),
            peer: peer.into(),
        };
        self.record(agent, peer, &place.id, now_ms)?;
        Ok(Some(place))
    }

    /// The reserved `place` was sent as `message_id`, so its delivery to an
    /// agent on this computer counts it once. A place whose message id is
    /// unknown, or whose send failed, keeps counting.
    pub fn sent(&mut self, place: &Place, message_id: &str, now_ms: i64) {
        let pair = |m: &Counted| m.message_id == message_id && m.between(&place.agent, &place.peer);
        // A delivery let through on its place now has its message.
        self.journal.waiting.retain(|m| !pair(m));
        let messages = &mut self.journal.messages;
        let counted = messages.iter().any(pair);
        match messages.iter().position(|m| m.message_id == place.id) {
            // Its delivery here counted it first.
            Some(index) if counted => drop(messages.remove(index)),
            Some(index) => messages[index].message_id = message_id.into(),
            // The place itself is gone (pruned): the message counts as
            // itself.
            None if !counted => {
                let _ = self.record(&place.agent, &place.peer, message_id, now_ms);
                return;
            }
            None => {}
        }
        // Unsaved, the place still counts on disk; the id is kept in memory
        // until the next save.
        let _ = self.save();
    }

    /// Whether `message_id` was a person's message, which a reply to does
    /// not count toward any pair.
    pub fn from_person(&self, message_id: &str) -> bool {
        self.journal
            .person_messages
            .iter()
            .any(|(id, _)| id == message_id)
    }

    /// A person's message `message_id` to `agent`: every pair it is in
    /// starts again, once for each message.
    pub fn person_messaged(
        &mut self,
        agent: &str,
        message_id: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        if self
            .journal
            .person_messages
            .iter()
            .any(|(id, _)| id == message_id)
        {
            return Ok(());
        }
        let before = (
            self.journal.people.clone(),
            self.journal.person_messages.clone(),
        );
        self.reported.retain(|(a, b), _| a != agent && b != agent);
        self.journal.people.insert(agent.into(), now_ms);
        self.journal
            .person_messages
            .push((message_id.into(), now_ms));
        self.prune(now_ms);
        self.save().inspect_err(|_| {
            (self.journal.people, self.journal.person_messages) = before;
        })
    }

    /// The Relaycast id `key` (a workspace and an endpoint) resolved to
    /// recently.
    pub fn resolved(&self, key: &str) -> Option<String> {
        self.resolved
            .get(key)
            .filter(|(_, at)| at.elapsed() < RESOLVED_FOR)
            .map(|(id, _)| id.clone())
    }

    /// Remembers that `key` names the agent `id`, as Relaycast said.
    pub fn resolve(&mut self, key: String, id: String) {
        self.resolved.insert(key, (id, Instant::now()));
    }

    /// Whether the pair's stop is news to the activity log.
    pub fn report_stop(&mut self, a: &str, b: &str, now_ms: i64) -> bool {
        let pair = if a <= b { (a, b) } else { (b, a) };
        let pair = (pair.0.to_string(), pair.1.to_string());
        if self
            .reported
            .get(&pair)
            .is_some_and(|at| *at > now_ms - WINDOW_MS)
        {
            return false;
        }
        self.reported.insert(pair, now_ms);
        true
    }

    /// Forgets what is past keeping. Past [`KEPT`], the oldest messages go
    /// first, but never one still counting toward its pair.
    fn prune(&mut self, now_ms: i64) {
        let journal = &mut self.journal;
        journal.messages.retain(|m| m.at_ms > now_ms - KEPT_MS);
        let mut excess = journal.messages.len().saturating_sub(KEPT);
        journal.messages.retain(|m| {
            let drop = excess > 0 && m.at_ms <= now_ms - WINDOW_MS;
            excess -= usize::from(drop);
            !drop
        });
        journal.people.retain(|_, at| *at > now_ms - KEPT_MS);
        journal.waiting.retain(|m| m.at_ms > now_ms - KEPT_MS);
        journal
            .person_messages
            .retain(|(_, at)| *at > now_ms - KEPT_MS);
        let excess = journal.person_messages.len().saturating_sub(KEPT);
        journal.person_messages.drain(..excess);
    }

    fn save(&self) -> Result<(), String> {
        save_atomically(
            &self.path,
            &serde_json::to_vec(&self.journal).map_err(|e| e.to_string())?,
        )
    }
}

/// What the agent is told when its message is refused.
pub fn refused_send(agent: &str, peer: &str) -> String {
    format!(
        "@{agent} and {peer} have sent each other {LIMIT} messages in the last 10 minutes with no person in between. A person needs to step in: message @{agent} to let it continue, or wait until the 10 minutes pass."
    )
}

/// Why a delivery was refused, as its sender and the activity log see it.
pub fn refused_delivery(sender: &str, agent: &str) -> String {
    format!(
        "{sender} and @{agent} have sent each other {LIMIT} messages in the last 10 minutes with no person in between. A person needs to step in."
    )
}

/// The activity line the apps show when a pair is stopped.
pub fn stopped_line(agent: &str, peer: &str) -> String {
    format!(
        "Stopped messages between @{agent} and {peer}: {LIMIT} in 10 minutes with no person in between. Message @{agent} to let them continue."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: i64 = 60 * 1000;

    fn guard() -> (tempfile::TempDir, LoopGuard) {
        let dir = tempfile::tempdir().unwrap();
        let guard = LoopGuard::load(dir.path().join("app").join(FILE_NAME));
        (dir, guard)
    }

    fn fill(guard: &mut LoopGuard, at: i64) {
        for n in 0..LIMIT {
            // Both directions count toward the one pair.
            let (agent, peer) = if n % 2 == 0 { ("a", "b") } else { ("b", "a") };
            assert_eq!(
                guard.admit(agent, peer, &format!("m{at}-{n}"), at).unwrap(),
                Admission::Admitted
            );
        }
    }

    #[test]
    fn a_pair_is_refused_at_the_cap_in_either_direction() {
        let (_dir, mut guard) = guard();
        fill(&mut guard, 1_000 * MINUTE);
        let now = 1_000 * MINUTE + 1;
        assert_eq!(guard.count("a", "b", now), LIMIT);
        assert_eq!(
            guard.admit("a", "b", "next", now).unwrap(),
            Admission::Refused
        );
        assert_eq!(
            guard.admit("b", "a", "next", now).unwrap(),
            Admission::Refused
        );
        // Another pair of the same agent is its own count.
        assert_eq!(
            guard.admit("a", "c", "other", now).unwrap(),
            Admission::Admitted
        );
        // A message already counted (its send counted it, or Relaycast
        // delivers it again) is not refused or counted twice.
        let counted = format!("m{}-3", 1_000 * MINUTE);
        assert_eq!(
            guard.admit("a", "b", &counted, now).unwrap(),
            Admission::Admitted
        );
        assert_eq!(guard.count("a", "b", now), LIMIT);
    }

    #[test]
    fn the_count_survives_a_restart_and_ends_with_its_window() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app").join(FILE_NAME);
        let start = 1_000 * MINUTE;
        fill(&mut LoopGuard::load(path.clone()), start);

        let reloaded = LoopGuard::load(path.clone());
        assert!(reloaded.is_over("b", "a", start + MINUTE));
        assert!(reloaded.is_over("a", "b", start + WINDOW_MS - 1));
        assert!(!reloaded.is_over("a", "b", start + WINDOW_MS));
        assert_eq!(
            reloaded.peer_of("b", &format!("m{start}-0")).as_deref(),
            Some("a")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn a_person_messaging_either_agent_starts_the_pair_again() {
        let (dir, mut guard) = guard();
        let start = 1_000 * MINUTE;
        fill(&mut guard, start);
        guard.person_messaged("b", "p1", start + MINUTE).unwrap();
        assert_eq!(guard.count("a", "b", start + MINUTE), 0);
        assert_eq!(
            guard.admit("a", "b", "after", start + 2 * MINUTE).unwrap(),
            Admission::Admitted
        );
        // The same message seen again (held for approval, or retried) does
        // not reset the pair again, also after a restart.
        let mut reloaded = LoopGuard::load(dir.path().join("app").join(FILE_NAME));
        assert_eq!(reloaded.count("a", "b", start + 2 * MINUTE), 1);
        reloaded
            .person_messaged("b", "p1", start + 3 * MINUTE)
            .unwrap();
        assert_eq!(reloaded.count("a", "b", start + 3 * MINUTE), 1);
    }

    #[test]
    fn a_send_takes_its_place_before_it_is_sent() {
        let (dir, mut guard) = guard();
        let mut places = Vec::new();
        for _ in 0..LIMIT {
            places.push(guard.reserve("a", "b", 10).unwrap().unwrap());
        }
        // Two sends at once cannot both take the last place.
        assert_eq!(guard.reserve("a", "b", 10).unwrap(), None);
        // Reserved places are on disk before anything is sent.
        let reloaded = LoopGuard::load(dir.path().join("app").join(FILE_NAME));
        assert_eq!(reloaded.count("a", "b", 10), LIMIT);

        // A sent place takes its message id, so the delivery to the other
        // agent here is not counted again.
        guard.sent(&places[0], "m1", 11);
        assert_eq!(guard.peer_of("b", "m1").as_deref(), Some("a"));
        assert_eq!(
            guard.admit("b", "a", "m1", 11).unwrap(),
            Admission::Admitted
        );
        // When the delivery counted it first, the place is given back.
        guard.record("a", "b", "m2", 11).unwrap();
        guard.sent(&places[1], "m2", 11);
        assert_eq!(guard.count("a", "b", 11), LIMIT);
    }

    #[test]
    fn a_local_delivery_that_outruns_its_send_counts_by_its_place() {
        let (_dir, mut guard) = guard();
        for n in 0..LIMIT - 2 {
            guard.record("a", "b", &format!("m{n}"), 10).unwrap();
        }
        // Two sends from a to b, both reserved and neither answered yet.
        let first = guard.reserve("a", "b", 10).unwrap().unwrap();
        let second = guard.reserve("a", "b", 10).unwrap().unwrap();
        // The first send's delivery to b arrives first, at the cap: it is
        // one of the messages a reserved a place for, not one past it.
        assert_eq!(
            guard.admit("b", "a", "d1", 11).unwrap(),
            Admission::Admitted
        );
        assert_eq!(
            guard.admit("b", "a", "d1", 11).unwrap(),
            Admission::Admitted
        );
        // The first send answers. The second is still in flight and keeps
        // its place, so a third send between the answers is refused.
        guard.sent(&first, "d1", 12);
        assert_eq!(guard.count("a", "b", 12), LIMIT);
        assert_eq!(guard.reserve("a", "b", 12).unwrap(), None);
        // Another pair has its own count.
        assert_eq!(guard.admit("b", "c", "x", 12).unwrap(), Admission::Admitted);
        // The second answers before its delivery arrives; the delivery is
        // then counted once.
        guard.sent(&second, "d2", 13);
        assert_eq!(
            guard.admit("b", "a", "d2", 13).unwrap(),
            Admission::Admitted
        );
        assert_eq!(guard.count("a", "b", 13), LIMIT);
        assert_eq!(guard.admit("b", "a", "d3", 13).unwrap(), Admission::Refused);
    }

    #[test]
    fn a_reply_to_a_delivery_still_waiting_on_its_send_counts_toward_the_pair() {
        let (_dir, mut guard) = guard();
        for n in 0..LIMIT - 1 {
            guard.record("a", "b", &format!("m{n}"), 10).unwrap();
        }
        guard.reserve("a", "b", 10).unwrap().unwrap();
        assert_eq!(
            guard.admit("b", "a", "d1", 11).unwrap(),
            Admission::Admitted
        );
        // b answers before a's send has: the reply is to a, at the cap.
        assert_eq!(guard.peer_of("b", "d1").as_deref(), Some("a"));
        assert_eq!(guard.reserve("b", "a", 12).unwrap(), None);
    }

    #[test]
    fn a_waiting_delivery_keeps_its_pair_across_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app").join(FILE_NAME);
        let mut guard = LoopGuard::load(path.clone());
        for n in 0..LIMIT - 1 {
            guard.record("a", "b", &format!("m{n}"), 10).unwrap();
        }
        guard.reserve("a", "b", 10).unwrap().unwrap();
        assert_eq!(
            guard.admit("b", "a", "d1", 11).unwrap(),
            Admission::Admitted
        );
        // The core restarts before a's send answers.
        let mut reloaded = LoopGuard::load(path);
        assert_eq!(reloaded.peer_of("b", "d1").as_deref(), Some("a"));
        assert_eq!(reloaded.count("a", "b", 12), LIMIT);
        assert_eq!(reloaded.reserve("b", "a", 12).unwrap(), None);
        // Delivered again, it is not let through on the place a second time.
        assert_eq!(
            reloaded.admit("b", "a", "d1", 12).unwrap(),
            Admission::Admitted
        );
        assert_eq!(
            reloaded.admit("b", "a", "d2", 12).unwrap(),
            Admission::Refused
        );
    }

    #[test]
    fn no_more_deliveries_get_through_than_sends_are_in_flight() {
        let (_dir, mut guard) = guard();
        for n in 0..LIMIT - 1 {
            guard.record("a", "b", &format!("m{n}"), 10).unwrap();
        }
        let place = guard.reserve("a", "b", 10).unwrap().unwrap();
        assert_eq!(
            guard.admit("b", "a", "d1", 11).unwrap(),
            Admission::Admitted
        );
        // One place, so a second delivery cannot also be let through on it.
        assert_eq!(guard.admit("b", "a", "d2", 11).unwrap(), Admission::Refused);
        guard.sent(&place, "d1", 12);
        assert_eq!(guard.count("a", "b", 12), LIMIT);
    }

    #[test]
    fn a_delivery_is_never_let_through_on_a_place_that_no_longer_counts() {
        let (_dir, mut guard) = guard();
        // A send that failed long ago left its place behind.
        guard.reserve("a", "b", 0).unwrap().unwrap();
        let now = WINDOW_MS + 10;
        for n in 0..LIMIT {
            guard.record("a", "b", &format!("m{n}"), now).unwrap();
        }
        assert_eq!(
            guard.admit("b", "a", "d1", now).unwrap(),
            Admission::Refused
        );
    }

    #[test]
    fn a_delivery_is_never_let_through_on_a_place_from_before_a_reset() {
        let (_dir, mut guard) = guard();
        guard.reserve("a", "b", 10).unwrap().unwrap();
        guard.person_messaged("a", "p1", 11).unwrap();
        for n in 0..LIMIT {
            guard.record("a", "b", &format!("m{n}"), 12).unwrap();
        }
        assert_eq!(guard.admit("b", "a", "d1", 12).unwrap(), Admission::Refused);
    }

    #[test]
    fn a_remote_sender_cannot_take_a_local_agents_place() {
        let (_dir, mut guard) = guard();
        for n in 0..LIMIT - 1 {
            guard.record("a", "b", &format!("m{n}"), 10).unwrap();
        }
        guard.reserve("a", "b", 10).unwrap().unwrap();
        // c's delivery to a is not the message a reserved a place for.
        for n in 0..LIMIT {
            guard.record("a", "c", &format!("c{n}"), 10).unwrap();
        }
        assert_eq!(
            guard.admit("a", "c", "more", 11).unwrap(),
            Admission::Refused
        );
        // Nor is b's own message to a: a reserved toward b, not from it.
        assert_eq!(
            guard.admit("a", "b", "from-b", 11).unwrap(),
            Admission::Refused
        );
    }

    #[test]
    fn a_reply_to_the_person_counts_toward_no_pair() {
        let (_dir, mut guard) = guard();
        guard.person_messaged("a", "p1", 5).unwrap();
        assert!(guard.from_person("p1"));
        assert!(!guard.from_person("m1"));
    }

    #[test]
    fn a_place_that_cannot_be_saved_refuses_the_send() {
        let dir = tempfile::tempdir().unwrap();
        // A file where the journal's directory should be.
        let blocked = dir.path().join("app");
        fs::write(&blocked, b"").unwrap();
        let mut guard = LoopGuard::load(blocked.join(FILE_NAME));
        assert!(guard.reserve("a", "b", 10).is_err());
        assert_eq!(guard.count("a", "b", 10), 0, "nothing is kept unsaved");
    }

    #[test]
    fn a_reply_goes_to_the_other_agent_of_a_counted_message() {
        let (_dir, mut guard) = guard();
        guard.record("a", "b", "m1", 5).unwrap();
        assert_eq!(guard.peer_of("a", "m1").as_deref(), Some("b"));
        assert_eq!(guard.peer_of("b", "m1").as_deref(), Some("a"));
        assert_eq!(guard.peer_of("c", "m1"), None);
        assert_eq!(guard.peer_of("a", "m2"), None);
    }

    #[test]
    fn old_messages_are_forgotten_and_the_journal_stays_bounded() {
        let (_dir, mut guard) = guard();
        guard.record("a", "b", "old", 0).unwrap();
        let earlier = KEPT_MS + 1;
        for n in 0..KEPT {
            guard.record("x", "y", &format!("m{n}"), earlier).unwrap();
        }
        assert_eq!(guard.peer_of("a", "old"), None, "a day old");
        // Past the bound the oldest go first, but never a message still
        // counting toward its pair.
        let later = earlier + WINDOW_MS;
        fill(&mut guard, later);
        assert_eq!(guard.journal.messages.len(), KEPT);
        assert!(guard.is_over("a", "b", later));
        assert_eq!(guard.peer_of("x", "m0"), None);
    }
}
