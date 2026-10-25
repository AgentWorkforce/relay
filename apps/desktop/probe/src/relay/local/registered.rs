//! Delivery under the current agent registration, including native-spawn authority.

use super::*;

impl LocalInjector {
    pub(super) fn deliver_registered(
        &self,
        registration: &crate::relay::store::Registration,
        delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        match registration.target.kind {
            SessionKind::Pi => crate::relay::pi::send(
                &self.config.pi,
                &*self.table,
                self.config.uid,
                registration,
                message_id,
                text,
            ),
            SessionKind::Codex if registration.spawn.as_ref().is_some_and(|spawn| {
                spawn.harness == "codex" && spawn.taken_over_at.is_none()
            }) => self.codex.inject_spawned(&registration.target.id, message_id, text),
            SessionKind::Grok => {
                self.inject_grok(&registration.target, delivery_id, message_id, text, None)
            }
            SessionKind::GrokOpen => match registration.route_binding.as_deref() {
                Some(pinned) => self.inject_grok(
                    &registration.target,
                    delivery_id,
                    message_id,
                    text,
                    Some(pinned),
                ),
                None => InjectOutcome::Refused(
                    "This agent is not pinned to a Grok binding; turn this agent off, then add the session again."
                        .into(),
                ),
            },
            SessionKind::OpenCode => {
                self.inject_managed(&registration.target, delivery_id, message_id, text)
            }
            SessionKind::MuseOpen => {
                let relay_owned = registration.spawn.as_ref().is_some_and(|spawn| {
                    spawn.harness == "muse"
                        && spawn.taken_over_at.is_none()
                        && spawn.process.is_some()
                });
                match registration.route_binding.as_deref() {
                    Some(pinned)
                        if relay_owned && courier::is_courier_reference(pinned) =>
                    {
                        self.inject_muse_spawn(registration, delivery_id, message_id, text)
                    }
                    _ => InjectOutcome::Refused(
                        "Only a Muse session started and owned by Agent Relay can receive messages."
                            .into(),
                    ),
                }
            }
            SessionKind::OpenCodeOpen => match registration.route_binding.as_deref() {
                Some(pinned)
                    if crate::relay::opencode::is_route_reference(
                        pinned,
                        &registration.target.id,
                    ) =>
                {
                    self.inject_opencode_open(registration, delivery_id, message_id, text)
                }
                _ => InjectOutcome::Refused(
                    "This agent is not pinned to an OpenCode session; turn this agent off, then add the session again."
                        .into(),
                ),
            },
            _ => self.inject(&registration.target, message_id, text),
        }
    }
}
