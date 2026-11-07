//! Resolves the isolated Codex router owned by a fleet worker.
use super::*;

impl LocalInjector {
    pub(super) fn fleet_codex_router(&self, target: &Target) -> FleetCodexResolutionRouter {
        match self.fleet_codex_binding(target) {
            FleetCodexResolution::NotManaged => {
                let cached = self
                    .fleet_codex
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&target.key())
                    .map(|cached| cached.binding.clone());
                let Some(binding) = cached else {
                    return FleetCodexResolutionRouter::NotManaged;
                };
                match self.table.process(binding.pid) {
                    Some(process)
                        if process.start == binding.start && process.uid == self.config.uid =>
                    {
                        FleetCodexResolutionRouter::Unavailable(
                            "The fleet worker registration is temporarily unavailable.".into(),
                        )
                    }
                    Some(_) => FleetCodexResolutionRouter::Refused(
                        "The fleet Codex process was replaced.".into(),
                    ),
                    None if self.table.process_gone(binding.pid) => {
                        FleetCodexResolutionRouter::Refused("The fleet Codex process ended.".into())
                    }
                    None => FleetCodexResolutionRouter::Unavailable(
                        "The fleet Codex process could not be verified.".into(),
                    ),
                }
            }
            FleetCodexResolution::Unavailable(reason) => {
                FleetCodexResolutionRouter::Unavailable(reason)
            }
            FleetCodexResolution::Refused(reason) => FleetCodexResolutionRouter::Refused(reason),
            FleetCodexResolution::Bound(binding) => {
                let mut routes = self.fleet_codex.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(cached) = routes.get(&target.key()) {
                    if cached.binding == binding {
                        return FleetCodexResolutionRouter::Bound(cached.router.clone());
                    }
                }
                let router = Arc::new(CodexRouter::new(Arc::new(SystemCodexRoutes::new(
                    binding.config.clone(),
                    self.table.clone(),
                    self.config.uid,
                ))));
                routes.insert(
                    target.key(),
                    FleetCodexRouter {
                        binding,
                        router: router.clone(),
                    },
                );
                FleetCodexResolutionRouter::Bound(router)
            }
        }
    }

    /// A fleet router exists only once a delivery went through it, so a
    /// thread no router is watching needs no fleet lookup: that would scan
    /// processes for every idle Codex registration on every pass.
    pub(super) fn codex_stall(
        &self,
        target: &Target,
    ) -> Option<crate::relay::claude::inbox::InboxStall> {
        let fleet = self
            .fleet_codex
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&target.key())
            .map(|cached| cached.router.clone());
        match fleet {
            None => self.codex.inbox_stall(&target.id),
            Some(router) if !router.watching(&target.id) => None,
            Some(_) => match self.fleet_codex_router(target) {
                FleetCodexResolutionRouter::Bound(router) => router.inbox_stall(&target.id),
                _ => None,
            },
        }
    }
}
