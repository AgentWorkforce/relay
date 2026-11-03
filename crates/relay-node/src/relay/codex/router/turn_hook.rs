//! The route into a running turn through Agent Relay's Codex hook
//! (`codex::turn_hook`), and the claim every other route makes first.

use super::{CodexRouter, HANDOFF_GRACE, RECORDING};
use crate::relay::codex::turn_hook::{self, Claimed, Taken, TurnInbox};
use crate::relay::inject::InjectOutcome;

/// What a message says while its route cannot be recorded.
pub const CLAIM_UNRECORDED: &str =
    "Waiting — Agent Relay cannot record which route takes the message";

impl CodexRouter {
    /// The running-turn inbox, when it keeps its claims on disk.
    fn turns(&self) -> Option<&TurnInbox> {
        self.stop_hook
            .as_deref()
            .map(|inbox| inbox.turns())
            .filter(|turns| turns.configured())
    }

    /// A message the hook handed over is settled by the rollout alone:
    /// recorded within the grace, else in doubt. It is never sent again:
    /// the claim stays until its lifetime ends, so a restart before the
    /// caller records the doubt still finds it.
    fn taken_by_hook(&self, at_ms: i64) -> InjectOutcome {
        if self
            .turns()
            .is_none_or(|turns| turns.since(at_ms) < HANDOFF_GRACE)
        {
            return InjectOutcome::Accepted(RECORDING.into());
        }
        InjectOutcome::InDoubt(
            "Agent Relay's Codex hook handed this over, but Codex did not record it".into(),
        )
    }

    /// The routes through Agent Relay's Codex hook, in order: a message the
    /// running turn's hook handed over goes no other way; with the queue
    /// readable, a Conductor chat's Stop hook (`stop_hook_route`), then a
    /// running turn's (`turn_hook_route`) when `hooks` allows it.
    pub(super) fn hook_routes(
        &self,
        thread: &str,
        message_id: &str,
        text: &str,
        queued: Option<bool>,
        hooks: bool,
    ) -> Option<InjectOutcome> {
        if let Some(outcome) = self.turn_hook_claim(message_id) {
            return Some(outcome);
        }
        queued?;
        self.stop_hook_route(thread, message_id, text)
            .or_else(|| hooks.then(|| self.turn_hook_route(thread, message_id, text))?)
    }

    /// The outcome the hook's claim decides, before any route is looked at.
    pub(super) fn turn_hook_claim(&self, message_id: &str) -> Option<InjectOutcome> {
        match self.turns()?.claimed(message_id) {
            Claimed::Hook { at_ms } => Some(self.taken_by_hook(at_ms)),
            Claimed::Unknown => Some(InjectOutcome::Waiting(CLAIM_UNRECORDED.into())),
            _ => None,
        }
    }

    /// Offers the message to the hook of a turn a live Codex is running,
    /// so it arrives at the turn's next tool call or stop rather than after
    /// the turn, with nothing of the relay's ahead of it in Codex's queue or
    /// the thread's history; one already offered stays while that holds. `None` goes on to the other
    /// routes, which claim it first (`leave_turn_hook`). Conductor's chats
    /// keep their own Stop-hook route (`stop_hook_route`).
    pub(super) fn turn_hook_route(
        &self,
        thread: &str,
        message_id: &str,
        text: &str,
    ) -> Option<InjectOutcome> {
        let turns = self.turns().filter(|turns| turns.keeps_claims())?;
        let ready = self.stop_hook.as_ref()?.is_ready();
        let claimed = turns.claimed(message_id);
        if !ready || !matches!(claimed, Claimed::Free | Claimed::Offered) {
            return None;
        }
        let routes = &self.routes;
        let running =
            !routes.conductor_owned(thread) && !routes.idle(thread) && routes.thread_live(thread);
        if !running {
            return None;
        }
        // Never ahead of a relay message Codex or the history holds, offered
        // already or not: one that must now wait behind them is withdrawn,
        // unless the hook took it meanwhile.
        if routes.relay_waiting(thread) != Some(false)
            || self.behind_hidden(thread, message_id)
            || super::super::compact::held(thread, message_id).is_some()
        {
            if claimed == Claimed::Offered && !turns.withdraw(message_id) {
                return self.turn_hook_claim(message_id);
            }
            return None;
        }
        turns.offer(thread, message_id, text).ok()?;
        Some(InjectOutcome::WaitingForTurn(turn_hook::WAITING.into()))
    }

    /// Claims the message for a route other than the hook, before that
    /// route is given it. `Err` is the outcome when it may not: the hook
    /// has it, or the claim could not be written.
    pub(super) fn leave_turn_hook(&self, message_id: &str) -> Result<(), InjectOutcome> {
        let Some(turns) = self.turns() else {
            return Ok(());
        };
        match turns.leave(message_id) {
            Ok(()) => Ok(()),
            Err(Taken::Hook { at_ms }) => Err(self.taken_by_hook(at_ms)),
            Err(Taken::Unrecorded) => Err(InjectOutcome::Waiting(CLAIM_UNRECORDED.into())),
        }
    }

    /// Whether the hook may have handed the message over, so a native turn
    /// must not. An offer it has not taken is withdrawn, so the native turn
    /// is its only route. A claim for another route proves no handoff: that
    /// route's own evidence (`peer_evidence`) says whether it took it.
    pub(super) fn turn_hook_has(&self, message_id: &str) -> bool {
        let Some(turns) = self.turns() else {
            return false;
        };
        match turns.claimed(message_id) {
            Claimed::Free | Claimed::Elsewhere => false,
            Claimed::Offered => !turns.withdraw(message_id),
            // An unreadable record may hide the hook's handoff.
            Claimed::Hook { .. } | Claimed::Unknown => true,
        }
    }

    /// A wait while the hook's record cannot be read, so a native turn
    /// neither runs nor records the message as a peer's until it can.
    pub(super) fn turn_hook_unknown(&self, message_id: &str) -> Option<InjectOutcome> {
        (self.turns()?.claimed(message_id) == Claimed::Unknown)
            .then(|| InjectOutcome::Waiting(CLAIM_UNRECORDED.into()))
    }

    /// Forgets the hook's claim on a settled message.
    pub(super) fn settle_turn_hook(&self, message_id: &str) {
        if let Some(turns) = self.turns() {
            turns.settle(message_id);
        }
    }
}
