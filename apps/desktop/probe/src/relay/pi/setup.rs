//! Pi extension installation and the failure the desktop must keep visible.
use super::PiConfig;
use crate::relay::agents::SettingsExtension;
use serde_json::{Map, Value};

pub(crate) struct PiSetup {
    error: Option<String>,
}

impl PiSetup {
    pub(crate) fn new(config: &PiConfig) -> Self {
        Self {
            error: config.install().err().map(|error| format!(
                "Pi extension could not be installed: {error} Resolve the extension conflict or file permissions. Restart Agent Relay, then run /reload in Pi."
            )),
        }
    }
}

impl SettingsExtension for PiSetup {
    fn get(&self) -> Map<String, Value> {
        Map::new()
    }
    fn set(&self, _key: &str, _value: &Value) -> Option<Result<(), String>> {
        None
    }
    fn startup_error(&self) -> Option<String> {
        self.error.clone()
    }
}
