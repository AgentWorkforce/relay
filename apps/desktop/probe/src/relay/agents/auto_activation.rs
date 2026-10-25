//! Which sessions join the relay without the auto-activate opt-in.

use crate::relay::store::SessionKind;

/// Kinds joining without the auto-activate opt-in: Devin's lock proof and an
/// OpenClaw agent's authenticated loopback handshake are caller proof, as is
/// Hermes's API key. Muse sessions are registered only by Relay's spawner.
pub(crate) fn auto_activates_by_default(kind: SessionKind) -> bool {
    matches!(
        kind,
        SessionKind::Devin | SessionKind::OpenClaw | SessionKind::Hermes
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_authenticated_external_routes_activate_without_opt_in() {
        assert!(auto_activates_by_default(SessionKind::Devin));
        assert!(!auto_activates_by_default(SessionKind::MuseOpen));
        assert!(auto_activates_by_default(SessionKind::OpenClaw));
        assert!(auto_activates_by_default(SessionKind::Hermes));
        assert!(!auto_activates_by_default(SessionKind::Codex));
        assert!(!auto_activates_by_default(SessionKind::ClaudeTerminal));
        assert!(!auto_activates_by_default(SessionKind::OpenCodeOpen));
    }
}
