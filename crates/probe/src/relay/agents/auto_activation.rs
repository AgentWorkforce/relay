//! Which sessions join the relay without the auto-activate opt-in.

use crate::relay::store::SessionKind;

/// Kinds joining without the auto-activate opt-in: Devin's lock proof and
/// a Muse session's live registry record are already caller proof, and an
/// OpenClaw agent is listed only while its Gateway answers this user's
/// loopback handshake, as Hermes is while its API answers its own key.
pub(crate) fn auto_activates_by_default(kind: SessionKind) -> bool {
    matches!(
        kind,
        SessionKind::Devin | SessionKind::MuseOpen | SessionKind::OpenClaw | SessionKind::Hermes
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // MuseOpen joins like Devin; OpenClaw and Hermes prove the caller too.
    #[test]
    fn muse_and_devin_activate_without_opt_in() {
        assert!(auto_activates_by_default(SessionKind::Devin));
        assert!(auto_activates_by_default(SessionKind::MuseOpen));
        assert!(auto_activates_by_default(SessionKind::OpenClaw));
        assert!(auto_activates_by_default(SessionKind::Hermes));
        assert!(!auto_activates_by_default(SessionKind::Codex));
        assert!(!auto_activates_by_default(SessionKind::ClaudeTerminal));
        assert!(!auto_activates_by_default(SessionKind::OpenCodeOpen));
    }
}
