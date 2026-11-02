//! Relay Connect handoffs into a Codex thread: queued through the Codex
//! router, and once accepted only observed, never written to the queue again.

use super::*;

impl LocalInjector {
    pub(super) fn connect_inject(
        &self,
        target: &Target,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        match target.kind {
            SessionKind::Codex => match self.fleet_codex_router(target) {
                FleetCodexResolutionRouter::NotManaged => {
                    self.codex.inject(&target.id, message_id, text)
                }
                FleetCodexResolutionRouter::Bound(router) => {
                    router.inject(&target.id, message_id, text)
                }
                FleetCodexResolutionRouter::Unavailable(reason) => InjectOutcome::Retry(reason),
                FleetCodexResolutionRouter::Refused(reason) => InjectOutcome::Refused(reason),
            },
            _ => self.inject(target, message_id, text),
        }
    }

    pub(super) fn connect_observe(
        &self,
        target: &Target,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        match target.kind {
            SessionKind::Codex => match self.fleet_codex_router(target) {
                FleetCodexResolutionRouter::Bound(router) => router.observe(&target.id, message_id),
                FleetCodexResolutionRouter::NotManaged => {
                    // This may be an ordinary Codex handoff, or a fleet
                    // handoff after restart with no live process from which
                    // to recover the isolated SQLite home. Either way only
                    // observe the shared rollout/default queue; never resend.
                    self.codex.observe(&target.id, message_id)
                }
                FleetCodexResolutionRouter::Unavailable(reason) => {
                    // The router is cloned so the lock is not held through
                    // its queue and rollout reads.
                    let cached = self
                        .fleet_codex
                        .lock()
                        .unwrap()
                        .get(&target.key())
                        .map(|cached| cached.router.clone());
                    if let Some(router) = cached {
                        router.observe(&target.id, message_id)
                    } else {
                        InjectOutcome::Accepted(reason)
                    }
                }
                FleetCodexResolutionRouter::Refused(reason) => {
                    let cached = self
                        .fleet_codex
                        .lock()
                        .unwrap()
                        .get(&target.key())
                        .map(|cached| cached.router.clone());
                    if cached.as_ref().is_some_and(|router| {
                        router.observe(&target.id, message_id) == InjectOutcome::Delivered
                    }) {
                        InjectOutcome::Delivered
                    } else {
                        InjectOutcome::InDoubt(format!(
                            "Codex accepted this handoff before its fleet binding was lost — {reason}"
                        ))
                    }
                }
            },
            _ => self.inject_connect(target, message_id, text),
        }
    }

    pub(super) fn connect_cancel(&self, target: &Target, message_id: &str) {
        if target.kind == SessionKind::Codex {
            match self.fleet_codex_router(target) {
                FleetCodexResolutionRouter::Bound(router) => router.cancel(&target.id, message_id),
                FleetCodexResolutionRouter::NotManaged => {
                    self.codex.cancel(&target.id, message_id);
                }
                FleetCodexResolutionRouter::Unavailable(_)
                | FleetCodexResolutionRouter::Refused(_) => {
                    if let Some(cached) = self.fleet_codex.lock().unwrap().get(&target.key()) {
                        cached.router.cancel(&target.id, message_id);
                    }
                }
            }
        } else {
            self.cancel(target, message_id);
        }
    }
}
