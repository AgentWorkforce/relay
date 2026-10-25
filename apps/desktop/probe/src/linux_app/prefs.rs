//! The app's own preferences: what only the UI uses, like the Mac's
//! `UserDefaults`. Settings the core owns stay in the core.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::models::{CapySpawnOperation, CAPY_THREAD_SPAWN_KEY};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionOpenPreference {
    #[default]
    Automatic,
    Terminal,
}

impl SessionOpenPreference {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Terminal => "terminal",
        }
    }
}

/// How the app's windows are drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Appearance {
    /// Follows the desktop's light or dark style.
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    pub const ALL: [Appearance; 3] = [Appearance::System, Appearance::Light, Appearance::Dark];

    /// The stored name.
    pub fn as_str(self) -> &'static str {
        match self {
            Appearance::System => "system",
            Appearance::Light => "light",
            Appearance::Dark => "dark",
        }
    }

    /// The appearance a stored name means; anything unknown follows the system.
    pub fn from_name(name: &str) -> Appearance {
        Appearance::ALL
            .into_iter()
            .find(|appearance| appearance.as_str() == name)
            .unwrap_or_default()
    }
}

/// The Mac's `UserDefaults` key for the same choice.
pub const CAPY_SETUP_DISMISSED: &str = "capySetupDismissed";
/// The Mac's `UserDefaults` key for Not now on the Devin card.
pub const DEVIN_SETUP_DISMISSED: &str = "devinSetupDismissed";
/// The Mac's `UserDefaults` key for Keep agents connected after quitting.
pub const KEEP_AGENTS_CONNECTED: &str = "keepAgentsConnectedAfterQuit";

/// `$XDG_CONFIG_HOME/agent-relay/desktop.json`, else under `~/.config`.
#[cfg(not(windows))]
pub fn default_path() -> io::Result<PathBuf> {
    let home = crate::relay::paths::home().map_err(io::Error::other)?;
    Ok(path_in(std::env::var_os("XDG_CONFIG_HOME"), &home))
}

/// `%APPDATA%\agent-relay\desktop.json`, Windows' place for a person's
/// settings (`XDG_CONFIG_HOME`'s counterpart); without `APPDATA`, under the
/// home's `AppData\Roaming`.
#[cfg(windows)]
pub fn default_path() -> io::Result<PathBuf> {
    let app_data = std::env::var_os("APPDATA").filter(|value| Path::new(value).is_absolute());
    let config = match app_data {
        Some(app_data) => app_data,
        None => crate::relay::paths::home()
            .map_err(io::Error::other)?
            .join(r"AppData\Roaming")
            .into_os_string(),
    };
    Ok(path_in(Some(config), Path::new("")))
}

/// [`default_path`] for a given `XDG_CONFIG_HOME` and home directory.
pub fn path_in(config_home: Option<OsString>, home: &Path) -> PathBuf {
    let base = config_home
        .and_then(|value| {
            let trimmed = value.to_string_lossy().trim().to_owned();
            (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
        })
        .unwrap_or_else(|| home.join(".config"));
    base.join("agent-relay").join("desktop.json")
}

/// The preferences file and its values. A missing or unreadable file reads
/// as empty, so every preference has its default.
#[derive(Debug)]
pub struct Preferences {
    path: PathBuf,
    values: Map<String, Value>,
}

impl Preferences {
    pub fn session_opening(&self, source: &str) -> SessionOpenPreference {
        match self
            .get(&format!("sessionOpening.{source}"))
            .and_then(Value::as_str)
        {
            Some("terminal") => SessionOpenPreference::Terminal,
            _ => SessionOpenPreference::Automatic,
        }
    }

    pub fn set_session_opening(
        &mut self,
        source: &str,
        preference: SessionOpenPreference,
    ) -> io::Result<()> {
        self.set(
            &format!("sessionOpening.{source}"),
            Value::from(preference.as_str()),
        )
    }

    pub fn load(path: PathBuf) -> Preferences {
        let values = fs::read(&path)
            .ok()
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok())
            .and_then(|value| match value {
                Value::Object(values) => Some(values),
                _ => None,
            })
            .unwrap_or_default();
        Preferences { path, values }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    /// Stores `value` and writes the file atomically. The value holds for
    /// this run even when the file cannot be written.
    pub fn set(&mut self, key: &str, value: Value) -> io::Result<()> {
        self.values.insert(key.to_owned(), value);
        self.save()
    }

    fn save(&self) -> io::Result<()> {
        if let Some(directory) = self.path.parent() {
            fs::create_dir_all(directory)?;
        }
        let sorted: std::collections::BTreeMap<&String, &Value> = self.values.iter().collect();
        let text = serde_json::to_string_pretty(&sorted).map_err(io::Error::other)?;
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, text)?;
        fs::rename(&temporary, &self.path)
    }

    pub fn appearance(&self) -> Appearance {
        match self.get("appearance") {
            Some(Value::String(name)) => Appearance::from_name(name),
            _ => Appearance::System,
        }
    }

    pub fn set_appearance(&mut self, appearance: Appearance) -> io::Result<()> {
        self.set("appearance", Value::from(appearance.as_str()))
    }

    /// On unless turned off.
    pub fn automatically_checks_for_updates(&self) -> bool {
        self.get("automatically_checks_for_updates")
            .is_none_or(super::truthy)
    }

    pub fn set_automatically_checks_for_updates(&mut self, value: bool) -> io::Result<()> {
        self.set("automatically_checks_for_updates", Value::Bool(value))
    }

    /// Quitting leaves the core running unless turned off.
    pub fn keeps_agents_connected_after_quit(&self) -> bool {
        self.get(KEEP_AGENTS_CONNECTED).is_none_or(super::truthy)
    }

    pub fn set_keeps_agents_connected_after_quit(&mut self, value: bool) -> io::Result<()> {
        self.set(KEEP_AGENTS_CONNECTED, Value::Bool(value))
    }

    /// The person chose Not now on the Capy setup card.
    pub fn capy_setup_dismissed(&self) -> bool {
        self.get(CAPY_SETUP_DISMISSED).is_some_and(super::truthy)
    }

    pub fn dismiss_capy_setup(&mut self) -> io::Result<()> {
        self.set(CAPY_SETUP_DISMISSED, Value::Bool(true))
    }

    /// The person chose Not now on the Devin card.
    pub fn devin_setup_dismissed(&self) -> bool {
        self.get(DEVIN_SETUP_DISMISSED).is_some_and(super::truthy)
    }

    pub fn dismiss_devin_setup(&mut self) -> io::Result<()> {
        self.set(DEVIN_SETUP_DISMISSED, Value::Bool(true))
    }

    pub fn capy_spawn_operation(&self, workspace_id: &str) -> Option<CapySpawnOperation> {
        self.get(CAPY_THREAD_SPAWN_KEY)
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .filter(|operation: &CapySpawnOperation| operation.workspace_id == workspace_id)
    }

    /// Stores the idempotent operation before the Cloud request is made.
    pub fn set_capy_spawn_operation(&mut self, operation: &CapySpawnOperation) -> io::Result<()> {
        let value = serde_json::to_value(operation).map_err(io::Error::other)?;
        self.set(CAPY_THREAD_SPAWN_KEY, value)
    }

    pub fn clear_capy_spawn_operation(&mut self) -> io::Result<()> {
        self.values.remove(CAPY_THREAD_SPAWN_KEY);
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capy_setup_dismissal_persists() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop.json");
        let mut prefs = Preferences::load(path.clone());
        assert!(!prefs.capy_setup_dismissed());
        prefs.dismiss_capy_setup().unwrap();
        assert!(Preferences::load(path).capy_setup_dismissed());
    }

    #[test]
    fn devin_setup_dismissal_persists_apart_from_capy() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop.json");
        let mut prefs = Preferences::load(path.clone());
        assert!(!prefs.devin_setup_dismissed());
        prefs.dismiss_devin_setup().unwrap();
        let again = Preferences::load(path);
        assert!(again.devin_setup_dismissed());
        assert!(!again.capy_setup_dismissed());
    }

    #[test]
    fn capy_spawn_operation_is_durable_and_workspace_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop.json");
        let mut prefs = Preferences::load(path.clone());
        let operation = CapySpawnOperation::new(
            "workspace".into(),
            "relay-desktop-id".into(),
            "project".into(),
            "Review the pull request".into(),
            None,
            Some("capy".into()),
            Some("lead".into()),
        );
        prefs.set_capy_spawn_operation(&operation).unwrap();
        let mut again = Preferences::load(path.clone());
        assert_eq!(again.capy_spawn_operation("workspace"), Some(operation));
        assert_eq!(again.capy_spawn_operation("other"), None);
        again.clear_capy_spawn_operation().unwrap();
        assert_eq!(
            Preferences::load(path).capy_spawn_operation("workspace"),
            None
        );
    }
    #[test]
    fn session_opening_choices_persist_per_provider() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop.json");
        let mut prefs = Preferences::load(path.clone());
        assert_eq!(
            prefs.session_opening("claude"),
            SessionOpenPreference::Automatic
        );
        prefs
            .set_session_opening("claude", SessionOpenPreference::Terminal)
            .unwrap();
        let again = Preferences::load(path);
        assert_eq!(
            again.session_opening("claude"),
            SessionOpenPreference::Terminal
        );
        assert_eq!(
            again.session_opening("codex"),
            SessionOpenPreference::Automatic
        );
    }

    #[test]
    fn choices_persist_and_unknown_values_fall_back() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("desktop.json");
        let mut prefs = Preferences::load(path.clone());
        assert_eq!(prefs.appearance(), Appearance::System);
        assert!(prefs.automatically_checks_for_updates());
        prefs.set_appearance(Appearance::Dark).unwrap();
        prefs.set_automatically_checks_for_updates(false).unwrap();
        let again = Preferences::load(path.clone());
        assert_eq!(
            (again.appearance(), again.automatically_checks_for_updates()),
            (Appearance::Dark, false)
        );
        prefs.set("appearance", Value::from("purple")).unwrap();
        assert_eq!(
            Preferences::load(path.clone()).appearance(),
            Appearance::System
        );
        fs::write(&path, "not json").unwrap();
        assert_eq!(
            Preferences::load(path.clone()).appearance(),
            Appearance::System
        );
        assert!(!directory.path().join("desktop.tmp").exists());
    }

    #[test]
    fn the_file_is_sorted_two_space_json() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/desktop.json");
        let mut prefs = Preferences::load(path.clone());
        prefs.set_automatically_checks_for_updates(true).unwrap();
        prefs.set_appearance(Appearance::Light).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"appearance\": \"light\",\n  \"automatically_checks_for_updates\": true\n}"
        );
    }

    #[test]
    fn the_path_honors_xdg_config_home() {
        let home = Path::new("/home/a");
        assert_eq!(
            path_in(None, home),
            PathBuf::from("/home/a/.config/agent-relay/desktop.json")
        );
        assert_eq!(
            path_in(Some(" ".into()), home),
            PathBuf::from("/home/a/.config/agent-relay/desktop.json")
        );
        assert_eq!(
            path_in(Some("/cfg".into()), home),
            PathBuf::from("/cfg/agent-relay/desktop.json")
        );
    }
}
