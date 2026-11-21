//! Read-only receipts for local coordination notices
//! (`Core::observe_local_notice`). Only a route whose existing receipt read
//! provably never submits is observed; every other route stays unsupported.

use super::*;
use crate::relay::local_notices::NoticeObservation;
use crate::relay::store::Registration;

impl LocalInjector {
    pub(super) fn observe_notice(
        &self,
        registration: &Registration,
        message_id: &str,
    ) -> NoticeObservation {
        match registration.target.kind {
            // `deliver_registered` hands a notice for a Codex that is not
            // relay-spawned (or was taken over) to `inject_terminal`, which
            // always uses this injector's own router, fleet-bound or not.
            // Observe that same router's queue and rollout.
            SessionKind::Codex if notice_uses_codex_router(registration) => {
                observe_codex_notice(&self.codex, &registration.target.id, message_id)
            }
            // A relay-spawned Codex is first offered to its harness, whose
            // app-server turn leaves no queue item; the router cannot tell a
            // handoff that harness never made from one Codex consumed.
            // Copilot, Pi/Omp and the other routes keep their receipts inside
            // their send paths (Pi's matches on the notice text), with no
            // separate read that provably never submits.
            _ => NoticeObservation::Unsupported,
        }
    }
}

/// Whether a notice for this Codex registration went to the injector's own
/// Codex router rather than to a spawner's harness: the same choice
/// `Injector::inject_spawned` and `deliver_registered` make.
fn notice_uses_codex_router(registration: &Registration) -> bool {
    registration
        .spawn
        .as_ref()
        .is_none_or(|spawn| spawn.harness == "codex" && spawn.taken_over_at.is_some())
}

/// `CodexRouter::observe`, which never writes Codex's queue, as a notice
/// observation.
pub(crate) fn observe_codex_notice(
    router: &CodexRouter,
    thread: &str,
    message_id: &str,
) -> NoticeObservation {
    match router.observe(thread, message_id) {
        InjectOutcome::Delivered => NoticeObservation::Delivered,
        InjectOutcome::Accepted(reason)
        | InjectOutcome::WaitingForTurn(reason)
        | InjectOutcome::Waiting(reason)
        | InjectOutcome::Retry(reason) => NoticeObservation::Pending(reason),
        InjectOutcome::InDoubt(reason) => NoticeObservation::InDoubt(reason),
        // The router refuses a target that is not a Codex thread id before
        // reading anything, exactly as the handoff would have: no notice was
        // ever submitted there, and no later read can change that.
        InjectOutcome::Refused(reason) => NoticeObservation::Fenced(reason),
    }
}
