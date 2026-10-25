//! Provider route identity and reply transport selection.
use super::*;

impl LocalSessions {
    pub(super) fn live_route_binding(&self, target: &Target) -> Option<String> {
        if target.kind == SessionKind::Pi {
            return crate::relay::pi::binding(
                &self.config.pi,
                &*self.table,
                self.config.uid,
                &target.id,
            )
            .map(|binding| binding.reference);
        }
        if target.kind != SessionKind::GrokOpen {
            return None;
        }
        match existing_grok_claim(
            &self.config,
            &self.table,
            self.managed.as_deref(),
            &target.id,
        ) {
            Ok(ExistingClaim::Free(binding)) => Some(binding.credential_reference),
            _ => None,
        }
    }
}

impl LocalInjector {
    /// Whether the session's process can be identified on the relay-send
    /// socket now, so a reply command it is given can work.
    /// Whether socket commands for this session must go through the probe
    /// rather than curl (see [`outbound::reply_hint`]).
    pub(super) fn needs_probe_client(&self, target: &Target) -> bool {
        match target.kind {
            SessionKind::Codex => codex::processes::needs_probe_reply_client(
                &*self.table,
                self.config.uid,
                &target.id,
            ),
            // OpenCode's shells are named by their session tag, and Grok's
            // tools by `GROK_SESSION_ID`; macOS hides both in Apple's curl but
            // shows them in the probe.
            SessionKind::OpenCode
            | SessionKind::OpenCodeOpen
            | SessionKind::GrokOpen
            | SessionKind::Grok => true,
            _ => false,
        }
    }
}
