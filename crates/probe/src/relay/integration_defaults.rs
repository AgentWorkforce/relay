//! Integration defaults: the settings that connect an installed agent tool
//! to the relay (Claude Code direct delivery, Grok leader mode, the OpenCode
//! plugin, the Codex Stop hook), turned on once each after sign-in unless the
//! person declined at sign-in (`connect_detected_tools`).

use crate::relay::daemon::Core;
use crate::relay::state::{Level, Listing};
use crate::relay::store::Store;
use serde_json::Value;

/// The tool an integration default connects, as the sign-in screen names it.
fn tool_name(key: &str) -> Option<&'static str> {
    Some(match key {
        "direct_delivery" | "claude_session_hook" => "Claude Code",
        "grok_leader" => "Grok",
        "opencode_plugin" => "OpenCode",
        "codex_stop_hook" => "Codex",
        "openclaw_gateway" => "OpenClaw",
        "hermes_agent" => "Hermes",
        _ => return None,
    })
}

impl Core {
    /// Runs a default pass off the async runtime, as the person signs in,
    /// unless the relay CLI manages this core and chose the tools itself.
    pub(crate) fn connect_detected_tools_soon(&self) {
        if !self
            .integration_defaults
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        if let (Some(core), Ok(runtime)) = (self.arc(), tokio::runtime::Handle::try_current()) {
            runtime.spawn_blocking(move || core.apply_integration_defaults());
        }
    }

    /// The tools a default pass would connect now, by name, for the sign-in
    /// screen (`detected_tools`).
    pub(crate) fn detected_tools(&self) -> Vec<&'static str> {
        let mut detected = Vec::new();
        for name in self
            .pending_integration_defaults()
            .into_iter()
            .filter_map(tool_name)
        {
            if !detected.contains(&name) {
                detected.push(name);
            }
        }
        detected
    }

    /// Each integration key a default pass would turn on now: its tool is
    /// installed, it is not on, and this computer has not turned it on
    /// before nor has the person set it.
    fn pending_integration_defaults(&self) -> Vec<&'static str> {
        let applied = self
            .store
            .read(|s| s.integration_defaults_applied.clone().unwrap_or_default());
        let mut pending = Vec::new();
        for extension in &self.plugins.settings {
            for key in extension.default_on() {
                if applied.iter().any(|done| done == key)
                    || pending.contains(&key)
                    || extension.get().get(key) == Some(&Value::Bool(true))
                {
                    continue;
                }
                pending.push(key);
            }
        }
        pending
    }

    /// Turns on, once each, the integration settings whose tools are
    /// installed and that this computer has not turned on before or the
    /// person has not set: Claude Code direct delivery, Grok leader mode and
    /// the like. It writes to the tools only while the person is signed in
    /// and `connect_detected_tools` is on, so a computer that never signs in,
    /// or a person who unticked it at sign-in, keeps every tool's config as
    /// it was. A key is remembered once it is on or set, so one the person
    /// turned off stays off, while a tool installed later gets its default
    /// on the next pass. One that cannot be changed now is tried again later.
    ///
    /// The pass holds `integration_settings`, under which `set_settings`
    /// also saves `connect_detected_tools`, and reads that choice only once
    /// it holds it: a pass waiting behind an opt-out sees it, so nothing is
    /// connected after the person said no. A pass that turned on or
    /// recorded a key publishes a Settings update, so the apps show those
    /// tools on and drop them from `detected_tools`.
    pub fn apply_integration_defaults(&self) {
        let _changing = self.integration_settings.lock().unwrap();
        if self.workspace().is_none() || !self.store.read(Store::connects_detected_tools) {
            return;
        }
        let applied = self
            .store
            .read(|s| s.integration_defaults_applied.clone().unwrap_or_default());
        let mut newly = Vec::new();
        for extension in &self.plugins.settings {
            for key in extension.default_on() {
                if applied.iter().any(|done| done == key) || newly.contains(&key) {
                    continue;
                }
                if extension.get().get(key) == Some(&Value::Bool(true)) {
                    newly.push(key);
                    continue;
                }
                match extension.set(key, &Value::Bool(true)) {
                    Some(Ok(())) => {
                        self.hub.activity(
                            Level::Info,
                            format!("Turned on {key} by default; turn it off in Settings."),
                        );
                        newly.push(key);
                    }
                    Some(Err(message)) => self.hub.activity(
                        Level::Warning,
                        format!("Could not turn on {key} by default: {message}"),
                    ),
                    None => {}
                }
            }
        }
        if !newly.is_empty() {
            // A default left unrecorded is already on, so a later pass only
            // records it.
            let _ = self.remember_integration_choices(&newly);
            self.hub.invalidated(Listing::Settings);
        }
    }

    /// Runs `change` to the tool behind `key` and, once it succeeds, records
    /// `key` as the person's choice, so no default reverses it. Callers hold
    /// `integration_settings`, which also serializes the default pass, so
    /// recording after the change leaves no window for a default; nothing is
    /// recorded for a change that fails, so a later default still applies.
    /// A choice that cannot be recorded is reported as a failure.
    pub(crate) fn with_integration_choice<T, E>(
        &self,
        key: &str,
        change: impl FnOnce() -> Result<T, E>,
        stored: impl FnOnce(crate::relay::store::StoreError) -> E,
    ) -> Result<T, E> {
        let value = change()?;
        self.remember_integration_choices(&[key]).map_err(stored)?;
        Ok(value)
    }

    /// Records integration keys as applied or chosen, so no default changes
    /// them again.
    pub(crate) fn remember_integration_choices(
        &self,
        keys: &[&str],
    ) -> Result<(), crate::relay::store::StoreError> {
        self.store
            .update(|store| {
                let list = store
                    .integration_defaults_applied
                    .get_or_insert_with(Vec::new);
                for key in keys {
                    if !list.iter().any(|done| done == key) {
                        list.push((*key).to_string());
                    }
                }
            })
            .map(|_| ())
    }
}
