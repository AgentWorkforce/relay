//! The person's always-on agents behind a local gateway, OpenClaw and
//! Hermes: their listing, caller identity, delivery and answers.
use super::*;

impl LocalSessions {
    /// The agents of the person's OpenClaw Gateway, one relay agent each,
    /// and the person's Hermes while its API answers.
    pub(super) fn gateway_sessions(&self) -> Vec<DiscoveredSession> {
        let mut found = Vec::new();
        if let Some(openclaw) = self.config.openclaw.as_ref().filter(|c| c.enabled()) {
            found.extend(self.openclaw.sessions(openclaw));
        }
        if let Some(hermes) = self.config.hermes.as_ref().filter(|c| c.enabled()) {
            found.extend(self.hermes.sessions(hermes));
        }
        found
    }

    /// Whether automatic activation admits a gateway agent: listed only
    /// while its gateway answers this user's loopback credentials, which is
    /// its proof, with no working tree to exclude. `None` for other kinds.
    pub(super) fn gateway_admits(&self, kind: SessionKind) -> Option<bool> {
        match kind {
            SessionKind::OpenClaw => Some(self.config.openclaw.is_some()),
            SessionKind::Hermes => Some(self.config.hermes.is_some()),
            _ => None,
        }
    }

    /// `Some` when an ancestor of `pid` of this user's is an OpenClaw
    /// Gateway: its one agent, or nobody when it has several or none.
    pub(super) fn openclaw_caller(&self, pid: i32) -> Option<Result<Target, CallerMiss>> {
        let openclaw = self.config.openclaw.as_ref().filter(|c| c.enabled())?;
        let table = &*self.table;
        let mut current = pid;
        for _ in 0..crate::relay::process::MAX_ANCESTRY {
            if current <= 1 {
                return None;
            }
            let process = table.process(current)?;
            if process.uid == self.config.uid
                && crate::relay::openclaw::is_gateway_process(&table.arguments(current))
            {
                let listed = self.openclaw.sessions(openclaw);
                return Some(
                    crate::relay::openclaw::caller_agent(&listed).ok_or(CallerMiss::NotASession),
                );
            }
            current = process.parent;
        }
        None
    }
}

impl LocalInjector {
    /// A delivery to a gateway agent, in the session its sender gets;
    /// `None` for any other kind.
    pub(super) fn inject_gateway(
        &self,
        registration: &crate::relay::store::Registration,
        route: &crate::relay::inject::DeliveryRoute<'_>,
        text: &str,
    ) -> Option<InjectOutcome> {
        // The registration names the conversation's workspace for good: a
        // rotated workspace key keeps every sender's session.
        let scope = format!("{}\0{}", registration.base_url, registration.agent_id);
        Some(match registration.target.kind {
            SessionKind::Hermes => match self.config.hermes.as_ref().filter(|c| c.enabled()) {
                Some(hermes) => crate::relay::hermes::send(hermes, &scope, route, text),
                None => {
                    InjectOutcome::Waiting("Hermes is turned off in Agent Relay's settings.".into())
                }
            },
            SessionKind::OpenClaw => match self.config.openclaw.as_ref().filter(|c| c.enabled()) {
                Some(openclaw) => crate::relay::openclaw::send(
                    openclaw,
                    &registration.target.id,
                    &scope,
                    route,
                    text,
                ),
                None => InjectOutcome::Waiting(
                    "OpenClaw is turned off in Agent Relay's settings.".into(),
                ),
            },
            _ => return None,
        })
    }

    /// A gateway agent's answer to the delivery carrying `message_ref`.
    pub(super) fn gateway_answer(&self, target: &Target, message_ref: &str) -> Option<String> {
        match target.kind {
            SessionKind::OpenClaw => crate::relay::openclaw::final_answer(
                self.config.openclaw.as_ref()?,
                &target.id,
                message_ref,
            ),
            SessionKind::Hermes => {
                crate::relay::hermes::final_answer(self.config.hermes.as_ref()?, message_ref)
            }
            _ => None,
        }
    }
}
