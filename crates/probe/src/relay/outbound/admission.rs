//! What a session may send: its share of requests, and, for a message to
//! another agent, its place in their pair's loop guard count
//! (`delivery::loop_guard`).

use super::{Outbound, OutboundError, RATE_LIMIT, RATE_WINDOW};
use crate::relay::delivery::loop_guard::{LoopRefusal, Place};
use crate::relay::links::Endpoint;
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;

impl Outbound {
    /// Counts one request of the session `session_key` against its share.
    pub(super) fn admit(&self, session_key: &str) -> Result<(), OutboundError> {
        let now = (self.clock)();
        let mut sent = self.sent.lock().unwrap();
        let recent = sent.entry(session_key.to_string()).or_default();
        while recent
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= RATE_WINDOW)
        {
            recent.pop_front();
        }
        if recent.len() >= RATE_LIMIT {
            return Err(OutboundError::new(
                429,
                "rate_limited",
                format!(
                    "This session made {RATE_LIMIT} relay requests in the last minute; wait a moment."
                ),
            ));
        }
        recent.push_back(now);
        Ok(())
    }

    /// Admits a message from the session `session_key` as `sender`, to
    /// `endpoint` or in reply to `reply_to`: one request, then its place in
    /// its pair's count, saved before it is sent (`None` when it counts
    /// toward no pair). A send that then fails keeps its place, so the
    /// count errs high, never low. Refused at the cap, when the recipient
    /// cannot be verified, and when the place cannot be saved.
    pub(super) async fn admit_message(
        &self,
        session_key: &str,
        sender: (&Registration, &Secret),
        endpoint: Option<&Endpoint>,
        reply_to: Option<&str>,
    ) -> Result<Option<Place>, OutboundError> {
        self.admit(session_key)?;
        let place = match self.core.loop_peer(sender, endpoint, reply_to).await {
            Ok(None) => return Ok(None),
            Ok(Some((peer_id, peer))) => self.core.loop_reserve(sender.0, (&peer_id, &peer)),
            Err(refusal) => Err(refusal),
        };
        place.map(Some).map_err(refused)
    }
}

/// The socket's answer to a message the loop guard did not let through.
fn refused(refusal: LoopRefusal) -> OutboundError {
    match refusal {
        LoopRefusal::Capped(message) => OutboundError::new(429, "loop_guard", message),
        LoopRefusal::Unverified(message) => {
            OutboundError::new(403, "recipient_unverified", message)
        }
        LoopRefusal::Lookup(error) => OutboundError::relaycast(&error),
        LoopRefusal::Unsaved(error) => OutboundError::new(
            503,
            "save_failed",
            format!("Could not save the loop guard's count, so nothing was sent: {error}"),
        ),
    }
}
