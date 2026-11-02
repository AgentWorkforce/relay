//! Keeps a Codex thread's relay messages in order while one of them waits
//! in the thread's history for its turn.
//!
//! A hidden delivery puts the message's whole text into the history
//! (`thread/inject_items`) and then starts an empty turn for it. When that
//! turn cannot start yet (the thread is busy, or Codex refused it), the
//! message is held: later messages for the thread wait behind it, so none
//! runs first through the queue or through a hidden turn of its own.
//!
//! After a restart the memory is empty, so a hold is taken up again from
//! the rollout (`RolloutSummary::hidden_refs`). Codex history cannot be
//! unwritten, and the rollout records a turn only after it starts, so a
//! message that is done (delivered, cancelled, its turn in doubt, or not
//! offered again within `GRACE`) is remembered and never holds the thread
//! again.
//!
//! The rollout is only a hint. Once the delivery runtime has read every
//! queue that feeds the thread (an agent's own, and its aliases') in full
//! (`note_pending`), only a message still pending in one of them is taken
//! up from the rollout: one already acknowledged, expired or never relayed
//! is not waiting for anything, whatever a misread transcript lists, so a
//! parser miss never holds a later message back. A hold this router took
//! for a message it was offered is never released by a read: that message
//! may be past the page a read returns.

use crate::relay::delivery::policy::MessageRef;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long a held message may go without being offered again before it
/// stops holding later messages back.
pub const GRACE: Duration = Duration::from_secs(2 * 60);
/// How many given-up references are remembered.
const ABANDONED_KEPT: usize = 1024;

/// A message holding its thread's later messages back.
struct Hold {
    reference: String,
    /// When it was last offered (or, if adopted, first seen).
    at: Instant,
    /// Taken up from the rollout after a restart, not held by this router.
    adopted: bool,
    /// For an adopted hold, every other reference the rollout listed when
    /// it was taken up: nothing offers those again either, so when the
    /// hold runs out they are given up on with it, and a backlog of
    /// leftovers holds the thread for one `GRACE`, not one per leftover.
    backlog: Vec<String>,
}

/// The queues feeding one thread (its agent's own and its aliases', by
/// agent id), and per queue read since, the references still pending at
/// its last read; `None` when that read did not return the whole queue.
#[derive(Default)]
struct Queues {
    expected: Vec<String>,
    read: HashMap<String, Option<HashSet<String>>>,
}

/// The holds, per thread (lowercased).
#[derive(Default)]
pub struct HiddenOrder {
    held: Mutex<HashMap<String, Hold>>,
    /// Given up on: cancelled, in doubt, or not offered within `GRACE`.
    abandoned: Mutex<VecDeque<String>>,
    /// Delivered, possibly before the rollout records its turn. Kept apart
    /// so deliveries never push given-up references out.
    delivered: Mutex<VecDeque<String>>,
    /// Per thread, per queue (the agent id read), the references still
    /// pending at its last read; `None` when that read did not return the
    /// whole queue.
    pending: Mutex<HashMap<String, Queues>>,
}

impl HiddenOrder {
    /// The messages (by id) the queue `source`, one of the thread's
    /// `queues`, still holds for `thread`, as just read; `None` when the
    /// read was not the whole queue. A queue no longer among `queues` (a
    /// removed alias) is forgotten.
    pub fn note_pending(
        &self,
        thread: &str,
        source: &str,
        queues: &[String],
        message_ids: Option<&[String]>,
    ) {
        let references = message_ids.map(|ids| ids.iter().map(|id| MessageRef::of(id)).collect());
        let mut pending = self.pending_refs();
        let entry = pending.entry(thread.to_lowercase()).or_default();
        entry.expected = queues.to_vec();
        entry.read.retain(|queue, _| queues.contains(queue));
        // A read of a queue that is no longer one of them (an alias removed
        // while it was read) says nothing.
        if queues.iter().any(|queue| queue == source) {
            entry.read.insert(source.to_string(), references);
        }
    }

    /// Whether `reference` may still be pending for `thread`: always, until
    /// every queue feeding it was read whole.
    fn may_be_pending(&self, thread: &str, reference: &str) -> bool {
        let pending = self.pending_refs();
        let Some(queues) = pending.get(thread) else {
            return true;
        };
        if queues
            .expected
            .iter()
            .any(|queue| !queues.read.contains_key(queue))
        {
            return true;
        }
        queues.read.values().any(|queue| match queue {
            None => true,
            Some(references) => references.contains(reference),
        })
    }

    /// Holds `message_id`, whose whole text is in the thread's history
    /// waiting for its turn, as of `now`.
    pub fn hold(&self, thread: &str, message_id: &str, now: Instant) {
        let hold = Hold {
            reference: MessageRef::of(message_id),
            at: now,
            adopted: false,
            backlog: Vec::new(),
        };
        self.held().insert(thread.to_lowercase(), hold);
    }

    /// The held message is being offered again: it is still wanted.
    pub fn refresh(&self, thread: &str, message_id: &str, now: Instant) {
        if let Some(hold) = self.held().get_mut(&thread.to_lowercase()) {
            if hold.reference == MessageRef::of(message_id) {
                hold.at = now;
            }
        }
    }

    pub fn release(&self, thread: &str, message_id: &str) {
        let mut held = self.held();
        let thread = thread.to_lowercase();
        if held
            .get(&thread)
            .is_some_and(|hold| hold.reference == MessageRef::of(message_id))
        {
            held.remove(&thread);
        }
    }

    /// Releases a delivered message. The rollout can list its copy until
    /// its turn is recorded, so it is never taken up again.
    pub fn delivered(&self, thread: &str, message_id: &str) {
        self.release(thread, message_id);
        let mut delivered = self
            .delivered
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        abandon(&mut delivered, MessageRef::of(message_id));
    }

    /// Releases a message no turn will be started for (cancelled, or its
    /// turn in doubt). Its copy stays in the history, so it is never taken
    /// up again.
    pub fn abandon(&self, thread: &str, message_id: &str) {
        self.release(thread, message_id);
        abandon(&mut self.abandoned(), MessageRef::of(message_id));
    }

    /// Whether another message waits in the thread's history ahead of
    /// `message_id`: one held here, or one the rollout lists (`hidden_refs`)
    /// when nothing is. A message whose own copy waits there (`mine_waits`)
    /// is never held back by one only the rollout shows: that may be a
    /// leftover whose abandonment a restart forgot, and this one is wanted.
    /// One taken up from the rollout holds until it is delivered, given up
    /// on, or not offered within `GRACE`, never by what the rollout shows
    /// meanwhile: a turn the person starts unlists and ties it only for a
    /// while.
    pub fn behind(
        &self,
        thread: &str,
        message_id: &str,
        hidden_refs: Vec<String>,
        mine_waits: bool,
        now: Instant,
    ) -> bool {
        let mine = MessageRef::of(message_id);
        let key = thread.to_lowercase();
        let is_pending = |reference: &String| self.may_be_pending(&key, reference);
        let mut held = self.held();
        let mut abandoned = self.abandoned();
        // Taken up from the rollout, and no longer in any queue: it holds
        // nothing back.
        if held
            .get(&key)
            .is_some_and(|hold| hold.adopted && !is_pending(&hold.reference))
        {
            held.remove(&key);
        }
        held.retain(|_, hold| {
            let live = now.saturating_duration_since(hold.at) < GRACE;
            if !live {
                abandon(&mut abandoned, hold.reference.clone());
                for reference in &hold.backlog {
                    abandon(&mut abandoned, reference.clone());
                }
            }
            live
        });
        let mine_waits = mine_waits || hidden_refs.contains(&mine);
        let delivered = self
            .delivered
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if mine_waits {
            if held.get(&key).is_some_and(|hold| hold.adopted) {
                held.remove(&key);
            }
        } else if !held.contains_key(&key) {
            let mut waiting = hidden_refs.into_iter().filter(|reference| {
                *reference != mine
                    && is_pending(reference)
                    && !abandoned.contains(reference)
                    && !delivered.contains(reference)
            });
            if let Some(reference) = waiting.next() {
                let hold = Hold {
                    reference,
                    at: now,
                    adopted: true,
                    backlog: waiting.collect(),
                };
                held.insert(key.clone(), hold);
            }
        }
        held.get(&key).is_some_and(|hold| hold.reference != mine)
    }

    fn pending_refs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Queues>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, Hold>> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn abandoned(&self) -> std::sync::MutexGuard<'_, VecDeque<String>> {
        self.abandoned
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// Remembers `reference` as given up on, forgetting the oldest beyond
/// `ABANDONED_KEPT`: only one far older than any message still offered.
fn abandon(abandoned: &mut VecDeque<String>, reference: String) {
    if abandoned.contains(&reference) {
        return;
    }
    if abandoned.len() >= ABANDONED_KEPT {
        abandoned.pop_front();
    }
    abandoned.push_back(reference);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bugbot on #515: a full list forgets only its oldest reference, so the
    // ones given up on recently never block a thread again.
    #[test]
    fn the_abandoned_list_forgets_only_its_oldest() {
        let mut abandoned = VecDeque::new();
        for n in 0..=ABANDONED_KEPT {
            abandon(&mut abandoned, format!("ref-{n}"));
        }
        assert_eq!(abandoned.len(), ABANDONED_KEPT);
        assert!(!abandoned.contains(&"ref-0".to_string()));
        assert!(abandoned.contains(&"ref-1".to_string()));
        assert!(abandoned.contains(&format!("ref-{ABANDONED_KEPT}")));
        abandon(&mut abandoned, "ref-1".into());
        assert_eq!(abandoned.len(), ABANDONED_KEPT, "no duplicates");
    }

    // Bugbot on #515: one taken up from the rollout holds until it is
    // delivered or the grace runs out, whatever a turn the person starts
    // makes the rollout show meanwhile; deliveries never push leftovers out.
    #[test]
    fn an_adopted_hold_lasts_until_delivered_or_the_grace() {
        let order = HiddenOrder::default();
        let now = Instant::now();
        let earlier = vec![MessageRef::of("earlier")];
        assert!(order.behind("t", "later", earlier.clone(), false, now));
        assert!(
            order.behind("t", "later", Vec::new(), false, now),
            "unlisted or tied by a turn the person started: still held"
        );
        order.delivered("t", "earlier");
        assert!(!order.behind("t", "later", earlier.clone(), false, now));

        let order = HiddenOrder::default();
        assert!(order.behind("t", "later", earlier.clone(), false, now));
        assert!(!order.behind("t", "later", earlier, false, now + GRACE));
    }

    // After a restart, leftovers nobody offers again are taken up one at a
    // time: given up on together, they hold the thread back for one grace,
    // not one grace each.
    #[test]
    fn a_backlog_of_leftovers_holds_the_thread_for_one_grace() {
        let order = HiddenOrder::default();
        let now = Instant::now();
        let leftovers: Vec<String> = (0..112)
            .map(|n| MessageRef::of(&format!("old-{n}")))
            .collect();
        assert!(order.behind("t", "new", leftovers.clone(), false, now));
        assert!(
            !order.behind("t", "new", leftovers, false, now + GRACE),
            "the whole backlog is given up on with the first leftover"
        );
    }

    // A parser miss falls back to the queue's own ids: once the queue was
    // read whole, a listed leftover that is not pending there holds nothing
    // back, while one still pending does until it is delivered.
    #[test]
    fn only_a_message_still_pending_in_the_queue_holds_the_thread() {
        let order = HiddenOrder::default();
        let now = Instant::now();
        let listed = vec![MessageRef::of("phantom"), MessageRef::of("earlier")];
        order.note_pending("t", "agent", &one(), Some(&["later".into()]));
        assert!(!order.behind("t", "later", listed.clone(), false, now));

        order.note_pending(
            "t",
            "agent",
            &one(),
            Some(&["earlier".into(), "later".into()]),
        );
        assert!(order.behind("t", "later", listed.clone(), false, now));
        order.delivered("t", "earlier");
        order.note_pending("t", "agent", &one(), Some(&["later".into()]));
        assert!(!order.behind("t", "later", listed, false, now));
    }

    // Bots on #572: a renamed session's alias has a queue of its own for the
    // same thread, and a read returns one page. Each queue counts, and a
    // read that was not whole leaves every leftover possibly pending.
    #[test]
    fn every_queue_for_the_thread_counts_and_a_partial_read_proves_nothing() {
        let order = HiddenOrder::default();
        let now = Instant::now();
        let listed = vec![MessageRef::of("earlier")];
        order.note_pending("t", "original", &both(), Some(&["earlier".into()]));
        order.note_pending("t", "alias", &both(), Some(&["later".into()]));
        assert!(order.behind("t", "later", listed.clone(), false, now));

        let order = HiddenOrder::default();
        order.note_pending("t", "agent", &one(), None);
        assert!(order.behind("t", "later", listed, false, now));
    }

    fn one() -> Vec<String> {
        vec!["agent".into()]
    }

    fn both() -> Vec<String> {
        vec!["original".into(), "alias".into()]
    }

    // Bots on #572: until every queue feeding the thread was read, one that
    // was not (an alias after a restart) may hold the leftover; a removed
    // alias's last read is forgotten, so it holds nothing.
    #[test]
    fn an_unread_queue_keeps_leftovers_and_a_removed_one_is_forgotten() {
        let order = HiddenOrder::default();
        let now = Instant::now();
        let listed = vec![MessageRef::of("earlier")];
        order.note_pending("t", "alias", &both(), Some(&["later".into()]));
        assert!(order.behind("t", "later", listed.clone(), false, now));

        let order = HiddenOrder::default();
        order.note_pending("t", "alias", &both(), Some(&["earlier".into()]));
        order.note_pending("t", "original", &one_original(), Some(&["later".into()]));
        assert!(!order.behind("t", "later", listed.clone(), false, now));
        // A read of the removed alias that was in flight is not taken back.
        order.note_pending("t", "alias", &one_original(), Some(&["earlier".into()]));
        assert!(!order.behind("t", "later", listed, false, now));
    }

    fn one_original() -> Vec<String> {
        vec!["original".into()]
    }

    // A hold this router took for a message it was offered is never
    // released by a read, which may not reach that message.
    #[test]
    fn a_held_message_holds_whatever_a_read_lists() {
        let order = HiddenOrder::default();
        let now = Instant::now();
        order.hold("t", "pushed", now);
        order.note_pending("t", "agent", &one(), Some(&["next".into()]));
        assert!(order.behind("t", "next", Vec::new(), false, now));
        order.delivered("t", "pushed");
        assert!(!order.behind("t", "next", Vec::new(), false, now));
    }

    #[test]
    fn deliveries_never_push_out_given_up_references() {
        let order = HiddenOrder::default();
        let now = Instant::now();
        order.abandon("t", "leftover");
        for n in 0..=ABANDONED_KEPT {
            order.delivered("t", &format!("delivered-{n}"));
        }
        let leftover = vec![MessageRef::of("leftover")];
        assert!(!order.behind("t", "next", leftover, false, now));
    }
}
