//! Selected members whose provider is not ready yet: a Claude cloud session
//! while macOS has not answered the prompt to read Claude Code's sign-in
//! from the Keychain. Such a member is neither captured nor failed; it is
//! hydrated again shortly, whatever its stamp shows, until a hydration
//! captures it or fails.
use super::{Members, Stamp};
use agent_relay_probe::delivery::SessionIdentity;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// How often a member that was not ready is tried again. A try costs no
/// wait once the Keychain read has been waited on, and its answer is kept
/// for minutes, so this only bounds how soon a granted prompt is used.
pub(super) const RETRY: Duration = Duration::from_secs(15);

/// The members not ready when last hydrated, and when they are tried again.
#[derive(Default)]
pub(super) struct NotReady {
    members: HashSet<SessionIdentity>,
    retry: Option<Instant>,
}

impl NotReady {
    fn release(
        &mut self,
        seen: &mut HashMap<SessionIdentity, Stamp>,
        current: &HashSet<&SessionIdentity>,
        now: Instant,
    ) {
        seen.retain(|member, _| current.contains(member));
        self.members.retain(|member| current.contains(member));
        if self.retry.is_some_and(|at| now >= at) {
            for member in &self.members {
                seen.remove(member);
            }
        }
    }

    /// Record what a round's hydrations found: a member not ready is tried
    /// again after [`RETRY`]; one captured or failed is done with.
    pub(super) fn settle(&mut self, hydrated: &[SessionIdentity], tally: &Tally, now: Instant) {
        let not_ready = tally.not_ready.borrow();
        for member in hydrated {
            if not_ready.contains(member) {
                self.members.insert(member.clone());
                self.retry = Some(now + RETRY);
            } else {
                self.members.remove(member);
            }
        }
        if self.members.is_empty() {
            self.retry = None;
        }
    }
}

/// Keep a round's members to those still selected, and once the retry is
/// due, forget the stamps of the members not ready, so this round hydrates
/// them as if never seen.
pub(super) fn release(state: &mut Members, current: &HashSet<&SessionIdentity>, now: Instant) {
    state.not_ready.release(&mut state.seen, current, now);
}

/// One round's hydrations: how many captured, and which were not ready.
#[derive(Default)]
pub(super) struct Tally {
    hydrated: Cell<u64>,
    not_ready: RefCell<HashSet<SessionIdentity>>,
}

impl Tally {
    pub(super) fn note(&self, member: &SessionIdentity, result: &anyhow::Result<()>) {
        match result {
            Ok(()) => self.hydrated.set(self.hydrated.get() + 1),
            Err(error) if super::super::remote_sources::keychain_not_ready(error) => {
                self.not_ready.borrow_mut().insert(member.clone());
            }
            Err(_) => {}
        }
    }

    /// Captured, and not ready.
    pub(super) fn counts(&self) -> (u64, u64) {
        (self.hydrated.get(), self.not_ready.borrow().len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str) -> SessionIdentity {
        SessionIdentity {
            source: "claude".into(),
            session_id: id.into(),
        }
    }

    /// A member not ready is hydrated again after the retry, whatever its
    /// stamp, until a hydration captures it; a failed one keeps its stamp
    /// and waits for its next change.
    #[test]
    fn a_member_not_ready_is_tried_again_until_captured() {
        let (cloud, failed) = (member("cloud"), member("failed"));
        let selected = [cloud.clone(), failed.clone()];
        let current: HashSet<&SessionIdentity> = selected.iter().collect();
        let mut seen: HashMap<_, _> = selected
            .iter()
            .map(|member| (member.clone(), Stamp::Unknown))
            .collect();
        let mut state = NotReady::default();
        let now = Instant::now();
        let tally = Tally::default();
        let waiting = Err(super::super::super::remote_sources::keychain_waiting_error());
        tally.note(&cloud, &waiting);
        tally.note(&failed, &Err(anyhow::anyhow!("failed")));
        assert_eq!(tally.counts(), (0, 1));
        state.settle(&selected, &tally, now);
        // Not yet due: both keep their stamps.
        state.release(&mut seen, &current, now);
        assert_eq!(seen.len(), 2);
        // Due: the member not ready is hydrated as if never seen.
        let later = now + RETRY;
        state.release(&mut seen, &current, later);
        assert!(!seen.contains_key(&cloud));
        assert!(seen.contains_key(&failed));
        // Captured once the prompt was answered: done with.
        seen.insert(cloud.clone(), Stamp::Unknown);
        let tally = Tally::default();
        tally.note(&cloud, &Ok(()));
        assert_eq!(tally.counts(), (1, 0));
        state.settle(std::slice::from_ref(&cloud), &tally, later);
        assert!(state.retry.is_none());
        state.release(&mut seen, &current, later + RETRY);
        assert!(seen.contains_key(&cloud));
        // A member no longer selected is forgotten.
        let tally = Tally::default();
        tally.note(&cloud, &waiting);
        state.settle(std::slice::from_ref(&cloud), &tally, later);
        state.release(&mut seen, &HashSet::new(), later);
        assert!(state.members.is_empty() && seen.is_empty());
    }
}
