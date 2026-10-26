//! The hidden route into a live terminal Codex that the shared app-server
//! hosts, and the order it keeps (`hidden_order`).

use super::super::compact::Held;
use super::{CodexRouter, BUSY, HIDDEN_TURN_PENDING};
use crate::relay::codex::app_server::TurnError;
use crate::relay::delivery::policy::MessageRef;
use crate::relay::inject::InjectOutcome;

impl CodexRouter {
    /// Once history accepted a channel batch, keep its identity on retry.
    pub(super) fn refused_turn(
        &self,
        thread: &str,
        message_id: &str,
        reason: String,
    ) -> InjectOutcome {
        if super::super::compact::held(thread, message_id) == Some(Held::Injected) {
            self.hidden.hold(thread, message_id, (self.now)());
            InjectOutcome::Waiting(HIDDEN_TURN_PENDING.into())
        } else {
            InjectOutcome::Retry(reason)
        }
    }

    /// Whether another message's copy waits in the thread's history ahead
    /// of this one (`HiddenOrder::behind`).
    pub(super) fn behind_hidden(&self, thread: &str, message_id: &str) -> bool {
        let mine_waits = super::super::compact::held(thread, message_id) == Some(Held::Injected);
        let refs = self.routes.hidden_refs(thread);
        self.hidden
            .behind(thread, message_id, refs, mine_waits, (self.now)())
    }

    /// A live terminal whose thread the shared app-server has loaded (a
    /// plain `codex` TUI runs on it; one started with `-c` runs its own)
    /// takes a hidden message as the app's hidden turn rather than a
    /// pointer, and shows only the agent's answer. Only between turns, and
    /// only with no relay message ahead of it in the queue: mid-turn the
    /// empty turn would be refused after the history already took the
    /// message. A message the history holds waits for the next idle moment
    /// to start its empty turn again. `None` goes on to the queue.
    pub(super) fn hidden_terminal_turn(
        &self,
        thread: &str,
        message_id: &str,
        text: &str,
        queued: Option<bool>,
    ) -> Option<InjectOutcome> {
        use super::super::compact;
        // Only a message with an attribution line can be hidden.
        if !compact::enabled() || queued != Some(false) || compact::visible_line(text).is_none() {
            return None;
        }
        let held = compact::held(thread, message_id);
        if held == Some(Held::Uncertain) {
            return None;
        }
        // Its whole text is in the history: nothing later goes first until
        // its turn starts, whichever route starts it.
        if held == Some(Held::Injected) {
            self.hidden.hold(thread, message_id, (self.now)());
        }
        let routes = &self.routes;
        if !routes.idle(thread) || routes.relay_waiting(thread) != Some(false) {
            return (held == Some(Held::Injected)).then(|| InjectOutcome::Waiting(BUSY.into()));
        }
        match routes.app_server_hidden(thread, text, message_id) {
            Ok(true) => Some(self.delivered(thread, message_id, &MessageRef::of(message_id))),
            // Not hosted (any more): the queue takes it. A held one keeps
            // its place until the queue's copy is recorded, so a failed
            // queue write still holds later messages back.
            Ok(false) => None,
            // Refused once the history took it: its empty turn is tried
            // again under the same message, and nothing later goes first.
            // `Waiting`, not `Retry`: a failed channel batch is dropped and
            // its posts come back under another id.
            Err(TurnError::Refused(_)) => {
                self.hidden.hold(thread, message_id, (self.now)());
                Some(InjectOutcome::Waiting(HIDDEN_TURN_PENDING.into()))
            }
            Err(TurnError::InDoubt(reason)) => {
                self.hidden.abandon(thread, message_id);
                Some(InjectOutcome::InDoubt(reason))
            }
        }
    }
}
