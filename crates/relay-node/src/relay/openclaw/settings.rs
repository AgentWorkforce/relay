//! The `openclaw_gateway` setting, and what Settings says about the
//! connected Gateway.
use super::*;

/// The `settings.set` key that turns the OpenClaw route on and off.
pub const SETTING: &str = "openclaw_gateway";

/// The read-only `settings.get` key naming the connected Gateway's version
/// when it cannot limit relay sessions (older than [`LIMITS_FROM`]).
pub const UNLIMITED_SETTING: &str = "openclaw_unlimited_version";

/// `openclaw_gateway`: present wherever OpenClaw is set up. It also serves
/// Agent Relay's tools for OpenClaw's agents (`relay_tools`).
pub struct OpenClawSettings {
    config: OpenClawConfig,
    tools: Option<Arc<relay_tools::RelayTools>>,
}

impl OpenClawSettings {
    pub fn new(config: &OpenClawConfig) -> Self {
        OpenClawSettings {
            config: config.clone(),
            tools: None,
        }
    }

    /// Serves `tools` as `openclaw.relay_tools.*`.
    pub fn with_tools(self, tools: Option<Arc<relay_tools::RelayTools>>) -> Self {
        OpenClawSettings { tools, ..self }
    }
}

impl crate::relay::agents::SettingsExtension for OpenClawSettings {
    fn default_on(&self) -> Vec<&'static str> {
        if self.config.enabled() {
            vec![SETTING]
        } else {
            Vec::new()
        }
    }

    fn get(&self) -> serde_json::Map<String, Value> {
        let mut settings = serde_json::Map::new();
        if self.config.installed() {
            settings.insert(SETTING.into(), Value::Bool(self.config.enabled()));
        }
        if let Some(version) = self.config.unlimited_version() {
            settings.insert(UNLIMITED_SETTING.into(), Value::String(version));
        }
        settings
    }

    fn attach(&self, changed: crate::relay::settings_watch::SettingsChanged) {
        if let Some(tools) = &self.tools {
            tools.on_change(changed.clone());
        }
        self.config.seen.on_change(changed);
    }

    fn openclaw_tools(&self) -> Option<Arc<relay_tools::RelayTools>> {
        self.tools.clone()
    }

    fn refuse(&self, key: &str, _value: &Value) -> Option<String> {
        (key == SETTING)
            .then(|| platform::unsupported("OpenClaw"))
            .flatten()
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        if let Some(reason) = self.refuse(key, value) {
            return Some(Err(reason));
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        let marker = self.config.off_marker();
        Some(if enabled {
            match std::fs::remove_file(&marker) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    Err(format!("Could not turn OpenClaw on: {e}"))
                }
                _ => Ok(()),
            }
        } else {
            crate::relay::mailbox::write_private(
                &marker,
                b"OpenClaw was turned off in Agent Relay's settings.\n",
            )
            .map_err(|e| format!("Could not turn OpenClaw off: {e}"))
        })
    }
}
