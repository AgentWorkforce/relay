//! Messages that keep waiting to go into their session: tracked per
//! delivery, and reported once in the activity log when one has waited
//! `DeliveryTiming::stuck_after`, with the agent's count and the oldest's
//! age, so a session that takes nothing cannot hide behind `Waiting` rows.

use super::policy::Delivery;
use crate::relay::daemon::Core;
use crate::relay::inject::InjectOutcome;
use crate::relay::state::Level;
use crate::relay::store::Registration;
use std::collections::HashSet;
use std::sync::PoisonError;
use std::time::{Duration, Instant};

/// A delivery that is waiting to go into its session.
pub(super) struct Waited {
    pub(super) agent: String,
    since: Instant,
    reported: bool,
}

impl Core {
    /// A delivery settled (injected, in doubt or refused): neither retried
    /// nor waiting any more.
    pub(super) fn settled(&self, id: &str) {
        let mut state = self.delivery.lock().unwrap_or_else(PoisonError::into_inner);
        state.retries.remove(id);
        state.waiting.remove(id);
    }

    /// After a queue read, forgets `agent`'s deliveries that left its queue
    /// (settled, expired): they are not tried again or reported. A read that
    /// was not the whole queue (`whole` false) cannot say a message left, so
    /// waits are kept then: one past the page keeps its age.
    pub(super) fn keep_queued(&self, agent: &str, queued: &HashSet<&str>, whole: bool) {
        let mut state = self.delivery.lock().unwrap_or_else(PoisonError::into_inner);
        state
            .retries
            .retain(|id, retry| retry.agent != agent || queued.contains(id.as_str()));
        if whole {
            state
                .waiting
                .retain(|id, waited| waited.agent != agent || queued.contains(id.as_str()));
        }
    }

    /// Tracks a delivery that is still `Waiting` to go into its session and,
    /// once it has waited `stuck_after`, says so in the activity log, once,
    /// with how many of the agent's messages wait and the oldest's age: a
    /// session that is not taking messages never hides behind
    /// `Waiting` entries alone. One handed over (`Accepted`,
    /// `WaitingForTurn`) no longer waits for the session to take it.
    pub(super) fn note_waiting(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        outcome: &InjectOutcome,
    ) {
        let InjectOutcome::Waiting(reason) = outcome else {
            let mut state = self.delivery.lock().unwrap_or_else(PoisonError::into_inner);
            state.waiting.remove(&delivery.id);
            return;
        };
        let now = Instant::now();
        let stuck_after = self.config.delivery_timing.stuck_after;
        let report = {
            let mut state = self.delivery.lock().unwrap_or_else(PoisonError::into_inner);
            // One report per agent until its waiting set empties: a message
            // that starts waiting behind a reported one is not reported again.
            let agent_reported = state
                .waiting
                .values()
                .any(|waited| waited.agent == registration.name && waited.reported);
            let waited = state.waiting.entry(delivery.id.clone()).or_insert(Waited {
                agent: registration.name.clone(),
                since: now,
                reported: agent_reported,
            });
            if waited.reported || now.saturating_duration_since(waited.since) < stuck_after {
                None
            } else {
                let mut count = 0;
                let mut oldest = now;
                for waited in state
                    .waiting
                    .values_mut()
                    .filter(|waited| waited.agent == registration.name)
                {
                    waited.reported = true;
                    count += 1;
                    oldest = oldest.min(waited.since);
                }
                Some((count, now.saturating_duration_since(oldest)))
            }
        };
        if let Some((count, oldest)) = report {
            self.hub.activity(
                Level::Warning,
                stuck_message(&registration.name, count, oldest, reason),
            );
        }
    }
}

/// The activity line for messages that have waited too long.
fn stuck_message(agent: &str, count: usize, oldest: Duration, reason: &str) -> String {
    let minutes = oldest.as_secs() / 60;
    let messages = if count == 1 {
        "message has"
    } else {
        "messages have"
    };
    format!(
        "@{agent}: {count} {messages} not gone into the session; the oldest has waited {minutes} min. {reason}"
    )
}
