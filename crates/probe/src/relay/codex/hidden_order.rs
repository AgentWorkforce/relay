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

use crate::relay::delivery::policy::MessageRef;
use std::collections::{HashMap, VecDeque};
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
}

impl HiddenOrder {
    /// Holds `message_id`, whose whole text is in the thread's history
    /// waiting for its turn, as of `now`.
    pub fn hold(&self, thread: &str, message_id: &str, now: Instant) {
        let hold = Hold {
            reference: MessageRef::of(message_id),
            at: now,
            adopted: false,
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
        let mut held = self.held();
        let mut abandoned = self.abandoned();
        held.retain(|_, hold| {
            let live = now.saturating_duration_since(hold.at) < GRACE;
            if !live {
                abandon(&mut abandoned, hold.reference.clone());
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
            if let Some(reference) = hidden_refs.into_iter().find(|reference| {
                *reference != mine
                    && !abandoned.contains(reference)
                    && !delivered.contains(reference)
            }) {
                let hold = Hold {
                    reference,
                    at: now,
                    adopted: true,
                };
                held.insert(key.clone(), hold);
            }
        }
        held.get(&key).is_some_and(|hold| hold.reference != mine)
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
