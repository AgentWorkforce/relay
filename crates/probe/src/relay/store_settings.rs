//! The settings the agent store keeps, served through `settings.get` and
//! `settings.set` beside the extensions' (`agents::SettingsExtension`).

use crate::relay::client::Joining;
use crate::relay::daemon::Core;
use crate::relay::store::{Store, StoreHandle};
use serde_json::{json, Map, Value};
use std::path::PathBuf;

/// Whether relay messages show in agent chats. Off unless turned on: the
/// agent reads each message from its hidden history (`codex::compact`) and
/// the chat shows none of it.
pub const SHOW_RELAY_MESSAGES: &str = "show_relay_messages";

/// Whether agents registered from now on join #general. Off unless turned
/// on; agents already registered keep the channels they are in.
pub const AUTO_JOIN_GENERAL: &str = "auto_join_general";

/// The store's settings, in `store_settings` order; `spawn::settings` saves
/// them with spawning's in one write (`Core::set_store_settings`).
pub(crate) const STORE_SETTINGS: [&str; 9] = [
    "allow_self_registration",
    "auto_activate",
    SHOW_RELAY_MESSAGES,
    AUTO_JOIN_GENERAL,
    "mobile_claude_handoff",
    "mobile_native_continuation",
    TEAMMATE_NATIVE_INPUT,
    PI_AUTO_ACTIVATE,
    OPENCODE_AUTO_ACTIVATE,
];

/// Whether an open Pi session joins the relay by itself while
/// `auto_activate` is on. Off unless turned on (`relay init` turns it on for
/// a person who chose Pi), so turning `auto_activate` on alone keeps Pi
/// sessions joining only when added.
pub const PI_AUTO_ACTIVATE: &str = "pi_auto_activate";

/// As [`PI_AUTO_ACTIVATE`], for an open OpenCode session.
pub const OPENCODE_AUTO_ACTIVATE: &str = "opencode_auto_activate";

/// Whether a teammate's direct message to a Claude Code session with Agent
/// Relay's plugin starts a user turn, labelled with the sender. On unless
/// turned off; channel posts and mentions stay peer messages either way.
pub const TEAMMATE_NATIVE_INPUT: &str = "teammate_native_input";

impl Store {
    pub fn allows_self_registration(&self) -> bool {
        self.allow_self_registration != Some(false)
    }

    pub fn auto_activates(&self) -> bool {
        self.auto_activate == Some(true)
    }

    /// Whether agents registered from now on join #general.
    pub fn auto_joins_general(&self) -> bool {
        self.extras.auto_join_general == Some(true)
    }

    pub fn shows_relay_messages(&self) -> bool {
        self.show_relay_messages == Some(true)
    }

    /// Your messages from the phone continue Claude Code sessions as your
    /// own turns unless turned off. Whether that can happen on this computer
    /// is decided where the turn is admitted (the owner claim and the
    /// session's plugin), not here.
    pub fn mobile_claude_handoff_on(&self) -> bool {
        self.mobile_claude_handoff != Some(false)
    }

    /// As `mobile_claude_handoff_on`, for the other native adapters.
    pub fn mobile_native_continuation_on(&self) -> bool {
        self.mobile_native_continuation != Some(false)
    }

    /// Whether a teammate's direct message starts a user turn
    /// (`TEAMMATE_NATIVE_INPUT`).
    pub fn teammate_native_input_on(&self) -> bool {
        self.extras.teammate_native_input != Some(false)
    }

    /// Whether open Pi sessions join by themselves (`PI_AUTO_ACTIVATE`).
    pub fn pi_auto_activates(&self) -> bool {
        self.extras.pi_auto_activate == Some(true)
    }

    /// Whether open OpenCode sessions join by themselves
    /// (`OPENCODE_AUTO_ACTIVATE`).
    pub fn opencode_auto_activates(&self) -> bool {
        self.extras.opencode_auto_activate == Some(true)
    }

    pub fn hides_relay_messages(&self) -> bool {
        !self.shows_relay_messages()
    }
}

impl StoreHandle {
    /// Opens the core's agent store; delivery reads `show_relay_messages`
    /// without it, so the flag is set from what was loaded.
    pub fn open_agent_store(path: PathBuf, machine_prefix: &str) -> StoreHandle {
        let store = StoreHandle::open(path, machine_prefix);
        crate::relay::codex::compact::set_enabled(store.read(Store::hides_relay_messages));
        store
    }
}

impl Core {
    /// The store's settings and their values.
    pub(crate) fn store_settings(&self) -> Map<String, Value> {
        // The mobile settings read as on only where they can take effect:
        // on by default, once this computer's ownership is verified for the
        // signed-in account. Until then the row shows off, and turning it
        // on explains what is missing.
        let claimed = self.require_mobile_claude_owner_claim().is_ok();
        let (values, changes) = self.store.read(|s| {
            let show = s.shows_relay_messages();
            let values = [
                s.allows_self_registration(),
                s.auto_activates(),
                show,
                s.auto_joins_general(),
                crate::relay::claude_mobile_plugin::supported()
                    && claimed
                    && s.mobile_claude_handoff_on(),
                crate::relay::native_continuation::supported()
                    && claimed
                    && s.mobile_native_continuation_on(),
                s.teammate_native_input_on(),
                s.pi_auto_activates(),
                s.opencode_auto_activates(),
            ];
            (values, s.extras.agent_changes.clone())
        });
        let mut settings: Map<String, Value> = STORE_SETTINGS
            .into_iter()
            .zip(values)
            .map(|(key, value)| (key.to_string(), json!(value)))
            .collect();
        settings.insert(
            "mobile_claude_handoff_supported".into(),
            json!(crate::relay::claude_mobile_plugin::supported()),
        );
        settings.insert("agent_changes".into(), json!(changes));
        settings.insert(
            "mobile_native_continuation_supported".into(),
            json!(crate::relay::native_continuation::supported()),
        );
        settings
    }

    /// The machine prefix a session registers under, and whether it joins
    /// #general (`auto_join_general`).
    pub(crate) fn joining(&self) -> Joining<'_> {
        Joining {
            machine_prefix: &self.machine_prefix,
            general: self.store.read(Store::auto_joins_general),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::relay::codex::compact;
    use crate::relay::store::StoreHandle;

    // Bugbot #510: another process's change reaches delivery when a later
    // save here adopts the merged store.
    #[test]
    fn another_processs_change_reaches_delivery_on_the_next_save() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.json");
        let here = StoreHandle::open(path.clone(), "desk");
        let other = StoreHandle::open(path, "desk");
        other
            .update(|store| store.show_relay_messages = Some(true))
            .unwrap();
        compact::set_enabled(true);
        here.update(|store| store.auto_activate = Some(true))
            .unwrap();
        assert_eq!(here.read(|s| s.show_relay_messages), Some(true));
        assert!(!compact::enabled(), "showing turns hiding off");
        other
            .update(|store| store.show_relay_messages = None)
            .unwrap();
        assert!(compact::enabled(), "hidden is the default");
    }
}
