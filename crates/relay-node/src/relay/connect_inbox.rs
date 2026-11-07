//! How often a Relay Connect inbox is read.
//!
//! While any Connect is joined, the delivery loop runs a pass every fast
//! poll, and every inbox read is a Relaycast request on a shared database.
//! An inbox that keeps coming back empty, or failing, is read less and less
//! often, up to a bound. A pending delivery, or the local session using the
//! Connect, puts it back on the fast poll. Server pacing (429,
//! `database_overloaded`, Retry-After) stays with the workspace gate in
//! `backoff`, which every read still passes.

use crate::relay::backoff::WorkspaceScope;
use crate::relay::client;
use crate::relay::connect::ConnectSession;
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use std::collections::{HashMap, HashSet};
use std::sync::PoisonError;
use std::time::{Duration, Instant};

/// An idle inbox is read at most this many fast polls apart.
const IDLE_READ_FACTOR: u32 = 10;

/// How long an inbox waits after `empty_reads` reads in a row found nothing
/// or failed: 3, 6, 12, 24, then 30 s at production timings.
fn read_interval(fast_poll: Duration, empty_reads: u32) -> Duration {
    fast_poll
        .saturating_mul(1 << empty_reads.min(16))
        .min(fast_poll.saturating_mul(IDLE_READ_FACTOR))
}

/// Agent id to its empty inbox reads in a row and when the last began.
#[derive(Debug, Default)]
pub(crate) struct InboxReads(HashMap<String, (u32, Instant)>);

impl InboxReads {
    /// An inbox with something pending is read every pass, as before.
    /// Passes start every `fast_poll`; half a pass of slack keeps a read
    /// from slipping to the pass after the one it is due on.
    fn due(&self, agent_id: &str, fast_poll: Duration, now: Instant) -> bool {
        self.0.get(agent_id).is_none_or(|(empty, at)| {
            *empty == 0
                || now.saturating_duration_since(*at) + fast_poll / 2
                    >= read_interval(fast_poll, *empty)
        })
    }

    /// Records a read that began `at`. A wake that came while it was in
    /// flight wins: the reply it expects may not have been in that read.
    fn record(&mut self, agent_id: &str, pending: bool, at: Instant) {
        let previous = self.0.get(agent_id).copied();
        let woken_since = previous.is_some_and(|(empty, since)| empty == 0 && since >= at);
        let empty = if pending || woken_since {
            0
        } else {
            previous.map_or(0, |(empty, _)| empty).saturating_add(1)
        };
        self.0.insert(agent_id.into(), (empty, at));
    }

    /// Reads the inbox at the next pass.
    fn wake(&mut self, agent_id: &str, now: Instant) {
        self.0.insert(agent_id.into(), (0, now));
    }

    /// Drops the records of seats that left or were replaced.
    fn retain_seats<'a>(&mut self, seats: impl IntoIterator<Item = &'a str>) {
        let seats: HashSet<&str> = seats.into_iter().collect();
        self.0
            .retain(|agent_id, _| seats.contains(agent_id.as_str()));
    }
}

impl Core {
    /// Reads a Connect inbox if it is due and the workspace gate admits it;
    /// `None` when this pass skips it.
    pub(crate) async fn read_connect_inbox(
        &self,
        session: &ConnectSession,
        workspace: &WorkspaceScope,
    ) -> Option<relaycast::Result<Vec<Delivery>>> {
        let fast_poll = self.config.delivery_timing.fast_poll;
        let started = Instant::now();
        let due =
            self.connect_inbox_reads(|reads| reads.due(&session.agent_id, fast_poll, started));
        if !due || !self.relaycast_poll_allowed(workspace) {
            return None;
        }
        let result = client::deliveries(&session.base_url, &session.token).await;
        self.observe_relaycast_result(workspace, &result);
        let pending = result
            .as_ref()
            .is_ok_and(|items| items.iter().any(Delivery::is_pending));
        let state = &mut *self.connect.lock().unwrap_or_else(PoisonError::into_inner);
        state
            .inbox_reads
            .record(&session.agent_id, pending, started);
        state
            .inbox_reads
            .retain_seats(state.sessions.values().map(|seat| seat.agent_id.as_str()));
        Some(result)
    }

    /// The local session is using this Connect (a send or a status read), so
    /// a reply may follow: its inbox is read at the next pass.
    pub(crate) fn wake_connect_inbox(&self, session: &ConnectSession) {
        let now = Instant::now();
        self.connect_inbox_reads(|reads| reads.wake(&session.agent_id, now));
    }

    fn connect_inbox_reads<T>(&self, f: impl FnOnce(&mut InboxReads) -> T) -> T {
        f(&mut self
            .connect
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .inbox_reads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_idle_connect_inbox_is_read_less_often_up_to_a_bound() {
        let fast = Duration::from_secs(3);
        let delays: Vec<_> = (0..7)
            .map(|empty| read_interval(fast, empty).as_secs())
            .collect();
        assert_eq!(delays, vec![3, 6, 12, 24, 30, 30, 30]);
        assert_eq!(read_interval(fast, u32::MAX), Duration::from_secs(30));
    }

    #[test]
    fn a_pending_delivery_or_a_wake_puts_the_inbox_back_on_the_fast_poll() {
        let fast = Duration::from_secs(3);
        let mut reads = InboxReads::default();
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        assert!(reads.due("guest", fast, start), "a new seat reads at once");
        reads.record("guest", true, start);
        assert!(
            reads.due("guest", fast, start),
            "a pending inbox is read every pass"
        );
        // Passes start every 3 s, each a little early or late.
        reads.record("guest", false, at(3));
        assert!(!reads.due("guest", fast, at(6)));
        assert!(reads.due("guest", fast, at(9) - Duration::from_millis(10)));
        reads.record("guest", false, at(9));
        assert!(!reads.due("guest", fast, at(18)));
        assert!(reads.due("guest", fast, at(21)));
        reads.record("guest", true, at(21));
        assert!(reads.due("guest", fast, at(21)), "a delivery resets it");
        reads.record("guest", false, at(24));
        assert!(!reads.due("guest", fast, at(27)));
        reads.wake("guest", at(27));
        assert!(reads.due("guest", fast, at(27)), "a local send wakes it");
        reads.record("host", false, at(27));
        reads.retain_seats(["host"]);
        assert!(
            !reads.0.contains_key("guest"),
            "a departed seat leaves no record"
        );
    }

    #[test]
    fn a_wake_during_an_empty_read_keeps_the_inbox_on_the_fast_poll() {
        let fast = Duration::from_secs(3);
        let mut reads = InboxReads::default();
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        reads.record("guest", false, at(0));
        reads.record("guest", false, at(6));
        // A read begins at 18 s, the session sends at 19 s, and the read
        // comes back empty at 20 s.
        reads.wake("guest", at(19));
        reads.record("guest", false, at(18));
        assert!(
            reads.due("guest", fast, at(21)),
            "a wake during a read is not lost"
        );
        // The next empty read backs off again from the start.
        reads.record("guest", false, at(21));
        assert!(!reads.due("guest", fast, at(24)));
        assert!(reads.due("guest", fast, at(27)));
    }
}
