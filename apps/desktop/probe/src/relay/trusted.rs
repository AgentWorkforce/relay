//! The relay senders the person trusts like themselves.
//!
//! **Settings › Trusted senders** (`trusted_relay_senders`) lists relay
//! names or exact addresses. A message from one of them reaches the person's
//! own agent rather than an answer-only stand-in: OpenClaw's main session,
//! and the person's own Hermes instead of its `relay` profile. Everyone else
//! keeps an answer-only session of their own.

use crate::relay::inject::DeliveryRoute;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The `settings.set` key.
pub const SETTING: &str = "trusted_relay_senders";

/// At most this many trusted senders, each at most 256 characters.
const MAX: usize = 50;

/// The saved list, under the app's data directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedSenders {
    path: PathBuf,
}

impl TrustedSenders {
    pub fn new(app_data_dir: &Path) -> Self {
        TrustedSenders {
            path: app_data_dir.join("trusted-relay-senders.json"),
        }
    }

    /// The names and addresses as Settings saved them.
    pub fn list(&self) -> Vec<String> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<String>>(&bytes).ok())
            .unwrap_or_default()
    }

    /// Whether `route`'s sender is trusted.
    pub fn trusts(&self, route: &DeliveryRoute<'_>) -> bool {
        matches(&self.list(), route)
    }

    /// Saves `value`, a list of names or addresses: trimmed, empty and
    /// repeated entries dropped.
    pub fn set(&self, value: &Value) -> Result<(), String> {
        let invalid =
            || format!("{SETTING} must be a list of at most {MAX} relay names or addresses.");
        let list = value.as_array().ok_or_else(invalid)?;
        let mut senders: Vec<String> = Vec::new();
        for entry in list {
            let entry = entry.as_str().ok_or_else(invalid)?.trim();
            if entry.is_empty() {
                continue;
            }
            if entry.chars().count() > 256 || entry.chars().any(char::is_control) {
                return Err(invalid());
            }
            if !senders
                .iter()
                .any(|known| known.eq_ignore_ascii_case(entry))
            {
                senders.push(entry.to_string());
            }
        }
        if senders.len() > MAX {
            return Err(invalid());
        }
        let bytes = serde_json::to_vec(&senders).map_err(|e| e.to_string())?;
        crate::relay::mailbox::write_private(&self.path, &bytes)
            .map_err(|e| format!("Could not save the trusted senders: {e}"))
    }
}

/// Whether `route`'s sender is in `trusted`: its exact address, or, for an
/// entry without `@`, its name; both without case.
pub fn matches(trusted: &[String], route: &DeliveryRoute<'_>) -> bool {
    trusted.iter().any(|entry| {
        let entry = entry.trim();
        !entry.is_empty()
            && (route
                .sender_address
                .is_some_and(|address| address.eq_ignore_ascii_case(entry))
                || (!entry.contains('@')
                    && route
                        .sender
                        .is_some_and(|name| name.eq_ignore_ascii_case(entry))))
    })
}

/// `trusted_relay_senders`: present while an agent it applies to (OpenClaw,
/// Hermes) is set up on this computer.
pub struct TrustedSettings {
    senders: TrustedSenders,
    applies: Box<dyn Fn() -> bool + Send + Sync>,
}

impl TrustedSettings {
    pub fn new(
        senders: TrustedSenders,
        applies: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        TrustedSettings {
            senders,
            applies: Box::new(applies),
        }
    }
}

impl crate::relay::agents::SettingsExtension for TrustedSettings {
    fn get(&self) -> serde_json::Map<String, Value> {
        let mut settings = serde_json::Map::new();
        if (self.applies)() {
            settings.insert(SETTING.into(), json!(self.senders.list()));
        }
        settings
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        (key == SETTING).then(|| self.senders.set(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::agents::SettingsExtension;

    fn dm<'a>(sender: &'a str, address: &'a str) -> DeliveryRoute<'a> {
        DeliveryRoute {
            delivery_id: "del_1",
            message_id: "m-1",
            reason: Some("dm"),
            channel_id: None,
            sender: Some(sender),
            sender_address: Some(address),
            native: false,
        }
    }

    #[test]
    fn senders_match_by_address_or_name() {
        let trusted = vec!["ada-lovelace".to_string(), "Bot@Node-9".to_string()];
        assert!(matches(&trusted, &dm("Ada-Lovelace", "ada-lovelace@test-mini")));
        assert!(matches(&trusted, &dm("someone", "bot@node-9")));
        // An address entry never matches a name, and strangers stay out.
        assert!(!matches(&trusted, &dm("bot", "bot@node-1")));
        assert!(!matches(&trusted, &dm("alice", "alice@node-1")));
        assert!(!matches(&[], &dm("ada-lovelace", "ada-lovelace@sf-mini")));
    }

    #[test]
    fn the_list_is_saved_from_settings_while_an_agent_applies() {
        let dir = tempfile::tempdir().unwrap();
        let senders = TrustedSenders::new(dir.path());
        let applies = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let shown = applies.clone();
        let settings = TrustedSettings::new(senders.clone(), move || {
            shown.load(std::sync::atomic::Ordering::SeqCst)
        });
        assert!(settings.get().is_empty());
        applies.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(settings.get()[SETTING], json!([]));
        settings
            .set(
                SETTING,
                &json!([" ada-lovelace ", "ADA-LOVELACE", "", "bot@node-9"]),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            settings.get()[SETTING],
            json!(["ada-lovelace", "bot@node-9"])
        );
        assert!(settings
            .set(SETTING, &json!("ada-lovelace"))
            .unwrap()
            .is_err());
        assert!(settings.set(SETTING, &json!(["a\nb"])).unwrap().is_err());
        assert!(settings.set("other", &json!([])).is_none());
        assert!(senders.trusts(&dm("ada-lovelace", "ada-lovelace@sf-mini")));
        #[cfg(unix)]
        {
            let mode = std::os::unix::fs::PermissionsExt::mode(
                &std::fs::metadata(dir.path().join("trusted-relay-senders.json"))
                    .unwrap()
                    .permissions(),
            ) & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
