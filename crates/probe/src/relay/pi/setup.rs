//! Pi extension installation, the `pi_extension` setting, and the failure
//! the desktop must keep visible.
use super::PiConfig;
use crate::relay::agents::SettingsExtension;
use serde_json::{Map, Value};
use std::sync::Mutex;

/// The setting that installs (`true`) or removes (`false`) the extension.
pub(crate) const SETTING: &str = "pi_extension";

pub(crate) struct PiSetup {
    config: PiConfig,
    error: Mutex<Option<String>>,
}

fn install_failure(error: String) -> String {
    format!(
        "Pi extension could not be installed: {error} Resolve the extension conflict or file permissions. Restart Agent Relay, then run /reload in Pi."
    )
}

impl PiSetup {
    /// `install_at_start`: the desktop's core installs the extension when it
    /// starts, unless it was turned off; a core `relay init` manages
    /// (`--cli-managed`) writes nothing into Pi's folder until `pi_extension`
    /// is turned on.
    pub(crate) fn new(config: &PiConfig, install_at_start: bool) -> Self {
        let error = (install_at_start && !config.off_marker().exists())
            .then(|| config.install().err())
            .flatten()
            .map(install_failure);
        Self {
            config: config.clone(),
            error: Mutex::new(error),
        }
    }

    fn set_extension(&self, enabled: bool) -> Result<(), String> {
        if !self.config.enabled {
            return Err(if cfg!(windows) {
                "Pi is not available on Windows.".to_string()
            } else {
                "Pi sessions are turned off (AGENT_RELAY_ENABLE_PI=0).".to_string()
            });
        }
        if !self.config.agent_dir.is_dir() {
            return Err(format!(
                "Pi has not run on this computer ({} does not exist).",
                self.config.agent_dir.display()
            ));
        }
        let marker = self.config.off_marker();
        if enabled {
            self.config.install().map_err(install_failure)?;
            *self.error.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return match std::fs::remove_file(&marker) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                    Err(format!("Could not clear the Pi opt-out marker: {e}"))
                }
                _ => Ok(()),
            };
        }
        self.config.remove()?;
        // Off is kept in the core's own data, not Pi's folder, so the
        // desktop's start does not install it again.
        if let Some(parent) = marker.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not record that the Pi extension is off: {e}"))?;
        }
        std::fs::write(
            &marker,
            "Agent Relay's Pi extension was turned off (pi_extension). Delete this file, or turn \
             Pi sessions on in Agent Relay, to allow it again.\n",
        )
        .map_err(|e| format!("Could not record that the Pi extension is off: {e}"))
    }
}

impl SettingsExtension for PiSetup {
    /// Present only where Pi has run (its agent folder exists) and Pi
    /// sessions are on.
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        if self.config.installed() {
            settings.insert(
                SETTING.into(),
                Value::Bool(self.config.extension_installed()),
            );
        }
        settings
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        Some(self.set_extension(enabled))
    }

    fn startup_error(&self) -> Option<String> {
        self.error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;

    fn pi(home: &std::path::Path) -> PiConfig {
        let config = PiConfig::from_env(&|_| None, home);
        fs::create_dir_all(&config.agent_dir).unwrap();
        config
    }

    #[test]
    fn a_cli_managed_core_writes_nothing_into_pis_folder_at_start() {
        let home = tempfile::tempdir().unwrap();
        let config = pi(home.path());
        let setup = PiSetup::new(&config, false);
        assert!(!config.extension_file().exists());
        assert!(!config.agent_dir.join("extensions").exists());
        assert!(setup.startup_error().is_none());
        assert_eq!(setup.get().get(SETTING), Some(&Value::Bool(false)));
    }

    #[test]
    fn the_desktop_core_installs_at_start_unless_turned_off() {
        let home = tempfile::tempdir().unwrap();
        let config = pi(home.path());
        PiSetup::new(&config, true);
        assert!(config.extension_installed());

        let setup = PiSetup::new(&config, true);
        assert_eq!(setup.set(SETTING, &Value::Bool(false)), Some(Ok(())));
        assert!(!config.extension_file().exists());
        assert!(config.off_marker().exists());
        // Off sticks across starts, and nothing of it is left in Pi's folder.
        PiSetup::new(&config, true);
        assert!(!config.extension_file().exists());
        assert!(!config.off_marker().starts_with(&config.agent_dir));
    }

    #[test]
    fn the_setting_installs_then_removes_only_our_extension() {
        let home = tempfile::tempdir().unwrap();
        let config = pi(home.path());
        let setup = PiSetup::new(&config, false);
        assert_eq!(setup.set(SETTING, &Value::Bool(true)), Some(Ok(())));
        assert!(config.extension_installed());
        assert_eq!(setup.get().get(SETTING), Some(&Value::Bool(true)));
        assert!(!config.off_marker().exists());

        assert_eq!(setup.set(SETTING, &Value::Bool(false)), Some(Ok(())));
        assert!(!config.extension_file().exists());
        assert_eq!(setup.get().get(SETTING), Some(&Value::Bool(false)));

        // A person's own file at that name is never replaced or removed.
        fs::write(config.extension_file(), "// personal extension").unwrap();
        assert!(matches!(
            setup.set(SETTING, &Value::Bool(true)),
            Some(Err(_))
        ));
        assert_eq!(setup.set(SETTING, &Value::Bool(false)), Some(Ok(())));
        assert_eq!(
            fs::read_to_string(config.extension_file()).unwrap(),
            "// personal extension"
        );
        assert!(setup.set("other", &Value::Bool(true)).is_none());
        assert!(matches!(setup.set(SETTING, &Value::from(1)), Some(Err(_))));
    }

    #[test]
    fn the_setting_is_refused_and_absent_where_pi_has_not_run() {
        let home = tempfile::tempdir().unwrap();
        let config = PiConfig::from_env(&|_| None, home.path());
        let setup = PiSetup::new(&config, true);
        assert!(setup.get().is_empty());
        let refused = setup.set(SETTING, &Value::Bool(true)).unwrap().unwrap_err();
        assert!(refused.contains("Pi has not run"), "{refused}");
        assert!(!config.agent_dir.exists());
        let off = PiSetup::new(
            &PiConfig {
                enabled: false,
                ..pi(home.path())
            },
            true,
        );
        assert!(off.get().is_empty());
        assert!(matches!(off.set(SETTING, &Value::Bool(true)), Some(Err(_))));
    }
}
