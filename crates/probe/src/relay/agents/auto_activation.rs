//! Which sessions join the relay without the auto-activate opt-in.

use crate::relay::store::{SessionKind, Store};

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

/// The store settings automatic activation reads: `auto_activate`, and the
/// per-provider opt-ins that widen it to open Pi and OpenCode sessions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ActivationSettings {
    pub auto_activate: Option<bool>,
    pub pi: bool,
    pub opencode: bool,
}

impl ActivationSettings {
    pub(crate) fn of(store: &Store) -> Self {
        Self {
            auto_activate: store.auto_activate,
            pi: store.pi_auto_activates(),
            opencode: store.opencode_auto_activates(),
        }
    }
}

/// Kinds that join only with their own opt-in on top of `auto_activate`: an
/// open Pi or OpenCode session is reached through an extension or plugin
/// the desktop installs by default, so turning `auto_activate` on alone
/// never puts one on the relay; `pi_auto_activate` / `opencode_auto_activate`
/// (which `relay init` turns on for a person who chose that tool) do.
fn own_opt_in(settings: &ActivationSettings, kind: SessionKind) -> Option<bool> {
    match kind {
        SessionKind::Pi => Some(settings.pi),
        SessionKind::OpenCodeOpen => Some(settings.opencode),
        _ => None,
    }
}

/// Whether automatic activation applies to sessions of `kind` under the
/// `auto_activate` setting: on, every kind (Pi and open OpenCode only with
/// their own opt-in too); off, none; unset, only the kinds that join by
/// default. The one policy for activation itself and for `/setup/status`'s
/// `auto_activates`.
pub(crate) fn activation_applies(settings: &ActivationSettings, kind: SessionKind) -> bool {
    match settings.auto_activate {
        Some(true) => own_opt_in(settings, kind).unwrap_or(true),
        Some(false) => false,
        None => auto_activates_by_default(kind),
    }
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

    fn setting(auto_activate: Option<bool>) -> ActivationSettings {
        ActivationSettings {
            auto_activate,
            ..ActivationSettings::default()
        }
    }

    #[test]
    fn the_setting_decides_and_unset_keeps_the_default_kinds() {
        for kind in [
            SessionKind::Devin,
            SessionKind::MuseOpen,
            SessionKind::Codex,
        ] {
            assert!(activation_applies(&setting(Some(true)), kind));
            assert!(!activation_applies(&setting(Some(false)), kind));
            assert_eq!(
                activation_applies(&setting(None), kind),
                auto_activates_by_default(kind)
            );
        }
        assert!(activation_applies(&setting(None), SessionKind::Devin));
        assert!(activation_applies(&setting(None), SessionKind::MuseOpen));
        assert!(!activation_applies(
            &setting(None),
            SessionKind::ClaudeTerminal
        ));
    }

    // `auto_activate` on alone (a desktop person who turned it on) keeps
    // Pi and open OpenCode sessions joining only when added; each joins by
    // itself once its own opt-in is on too, and neither opt-in widens the
    // other kind or overrides `auto_activate` off or unset.
    #[test]
    fn pi_and_opencode_need_their_own_opt_in_on_top_of_auto_activate() {
        for kind in [SessionKind::Pi, SessionKind::OpenCodeOpen] {
            assert!(!activation_applies(&setting(Some(true)), kind), "{kind:?}");
            assert!(!activation_applies(&setting(None), kind), "{kind:?}");
        }
        let both = ActivationSettings {
            auto_activate: Some(true),
            pi: true,
            opencode: true,
        };
        assert!(activation_applies(&both, SessionKind::Pi));
        assert!(activation_applies(&both, SessionKind::OpenCodeOpen));
        let pi_only = ActivationSettings {
            opencode: false,
            ..both
        };
        assert!(activation_applies(&pi_only, SessionKind::Pi));
        assert!(!activation_applies(&pi_only, SessionKind::OpenCodeOpen));
        for auto_activate in [Some(false), None] {
            let opted_in = ActivationSettings {
                auto_activate,
                ..both
            };
            assert!(!activation_applies(&opted_in, SessionKind::Pi));
            assert!(!activation_applies(&opted_in, SessionKind::OpenCodeOpen));
        }
        // The opt-ins never change another kind.
        assert!(activation_applies(&both, SessionKind::Codex));
        assert!(!activation_applies(
            &ActivationSettings {
                auto_activate: Some(false),
                ..both
            },
            SessionKind::Codex
        ));
    }

    #[test]
    fn the_settings_are_read_from_the_store() {
        let mut store = Store::default();
        assert_eq!(ActivationSettings::of(&store), setting(None));
        store.auto_activate = Some(true);
        store.extras.pi_auto_activate = Some(true);
        store.extras.opencode_auto_activate = Some(false);
        assert_eq!(
            ActivationSettings::of(&store),
            ActivationSettings {
                auto_activate: Some(true),
                pi: true,
                opencode: false,
            }
        );
    }
}
