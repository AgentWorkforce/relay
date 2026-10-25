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
pub(crate) const STORE_SETTINGS: [&str; 4] = [
    "allow_self_registration",
    "auto_activate",
    SHOW_RELAY_MESSAGES,
    AUTO_JOIN_GENERAL,
];

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
        let (values, changes) = self.store.read(|s| {
            let show = s.shows_relay_messages();
            let values = [
                s.allows_self_registration(),
                s.auto_activates(),
                show,
                s.auto_joins_general(),
            ];
            (values, s.extras.agent_changes.clone())
        });
        let mut settings: Map<String, Value> = STORE_SETTINGS
            .into_iter()
            .zip(values)
            .map(|(key, value)| (key.to_string(), json!(value)))
            .collect();
        settings.insert("agent_changes".into(), json!(changes));
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
