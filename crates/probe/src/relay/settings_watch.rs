//! Settings another part of the core owns, and the ones whose values change
//! on their own, not through `settings.set` (what the connected OpenClaw
//! Gateway can do): their extension is given a way to publish a Settings
//! invalidation, so the apps read `settings.get` again.
use crate::relay::daemon::Core;
use serde_json::{Map, Value};
use std::sync::Arc;

/// Settings another part of the core owns (Claude's direct delivery,
/// telemetry), served through `settings.get` and `settings.set`.
pub trait SettingsExtension: Send + Sync + 'static {
    /// This extension's settings and their current values.
    fn get(&self) -> Map<String, Value>;
    /// Sets `key` when it is this extension's: `None` when it is not,
    /// otherwise the outcome, with a message safe to show on failure.
    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>>;
    /// A refusal of `key` set to `value` that is known before anything is
    /// written: `settings.set` asks every extension first, so a batch it
    /// refuses saves none of its other settings. The message is the one
    /// [`SettingsExtension::set`] would give.
    fn refuse(&self, _key: &str, _value: &Value) -> Option<String> {
        None
    }
    /// The keys of this extension that connect a tool installed on this
    /// computer to the relay and so are on unless the person turns them off.
    /// Each is turned on once (`Core::apply_integration_defaults`).
    fn default_on(&self) -> Vec<&'static str> {
        Vec::new()
    }

    /// Keys this extension accepts in `settings.set` but does not report
    /// in `get`, such as a one-time default.
    fn write_only(&self) -> &'static [&'static str] {
        &[]
    }

    /// Gives the extension a way to tell the apps its values changed on
    /// their own (not through `settings.set`): `changed` publishes a
    /// Settings invalidation.
    fn attach(&self, _changed: SettingsChanged) {}

    /// A setup failure that must remain visible to clients connecting after startup.
    fn startup_error(&self) -> Option<String> {
        None
    }

    /// Agent Relay's tools for the person's OpenClaw agents, from the
    /// OpenClaw setting that serves them (`openclaw::relay_tools`).
    fn openclaw_tools(&self) -> Option<Arc<crate::relay::openclaw::relay_tools::RelayTools>> {
        None
    }
}

/// Publishes a Settings invalidation.
pub type SettingsChanged = Arc<dyn Fn() + Send + Sync>;

/// Attaches the plugins that report back to `core`: the account, and every
/// settings extension, given its [`SettingsChanged`].
pub(crate) fn attach_plugins(core: &Arc<Core>) {
    watch_store_errors(core);
    core.refresh_mobile_claude_plugin();
    if let Some(account) = &core.plugins.account {
        account.attach(core);
    }
    let watcher = Arc::downgrade(core);
    let changed: SettingsChanged = Arc::new(move || {
        if let Some(core) = watcher.upgrade() {
            core.hub()
                .invalidated(crate::relay::state::Listing::Settings);
        }
    });
    let errors: Vec<_> = core
        .plugins
        .settings
        .iter()
        .filter_map(|s| s.startup_error())
        .collect();
    core.hub().update(|status| {
        status.agents.integration_error = (!errors.is_empty()).then(|| errors.join("\n"));
    });
    for error in errors {
        core.hub()
            .activity(crate::relay::state::Level::Warning, error);
    }
    for extension in &core.plugins.settings {
        extension.attach(changed.clone());
    }
}

/// Keep persistent store errors visible before any settings plugin starts.
fn watch_store_errors(core: &Arc<Core>) {
    core.hub
        .update(|status| status.agents.store_error = core.store.error());
    let watcher = Arc::downgrade(core);
    core.store.watch_errors(move |error| {
        if let Some(core) = watcher.upgrade() {
            core.hub.update(|status| status.agents.store_error = error);
        }
    });
}
