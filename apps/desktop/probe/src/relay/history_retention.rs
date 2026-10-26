//! How long this computer keeps local session history
//! (`history_retention_days`): 7, 30 or 90 days, or forever (`0`). 30
//! unless changed.
//!
//! relayhistory owns `history.db` and removes what is older; this setting
//! only records the person's choice and hands it to relayhistory through
//! [`HistoryRetention`], a thin adapter over relayhistory's retention
//! interface. The choice is kept in memory, so `settings.get` reads no file
//! and no database, and it is handed over on a thread of its own, so neither
//! `settings.set` nor the session read path waits on SQLite.

use crate::relay::agents::SettingsExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

pub const SETTING: &str = "history_retention_days";

/// Days kept unless the person changes it.
pub const DEFAULT_DAYS: u32 = 30;

/// The setting's value for keeping history forever.
pub const FOREVER: u32 = 0;

/// Every value the setting takes, in the order Settings offers them.
pub const CHOICES: [u32; 4] = [7, 30, 90, FOREVER];

const FILE: &str = "history-retention.json";

/// How long relayhistory keeps a session's local history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retention {
    Days(NonZeroU32),
    Forever,
}

impl Retention {
    /// [`DEFAULT_DAYS`].
    pub const DEFAULT: Retention =
        Retention::Days(NonZeroU32::MIN.saturating_add(DEFAULT_DAYS - 1));

    /// The retention a setting's value stands for, when it is one of
    /// [`CHOICES`].
    pub fn from_setting(days: u32) -> Option<Retention> {
        if !CHOICES.contains(&days) {
            return None;
        }
        Some(NonZeroU32::new(days).map_or(Retention::Forever, Retention::Days))
    }

    pub fn setting(self) -> u32 {
        match self {
            Retention::Days(days) => days.get(),
            Retention::Forever => FOREVER,
        }
    }
}

/// relayhistory's side of the setting. The one place that knows how
/// relayhistory is told, so the rest of the app is unchanged when its
/// interface changes.
pub trait HistoryRetention: Send + Sync + 'static {
    /// Tells relayhistory to keep `retention` from now on. Called off the
    /// read path, never twice at once, and again at each start.
    fn apply(&self, retention: Retention) -> Result<(), String>;
}

/// The adapter until relayhistory ships its retention interface (W1 of the
/// sessions pipeline): the choice is saved and shown but nothing removes
/// history yet. Replace with a call into `ai_hist` once it lands.
pub struct NotYetInRelayhistory;

impl HistoryRetention for NotYetInRelayhistory {
    fn apply(&self, _retention: Retention) -> Result<(), String> {
        Ok(())
    }
}

/// The settings file.
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    days: Option<u32>,
}

/// The setting as the core serves it, saved under `app_data_dir` and
/// handed to relayhistory through [`NotYetInRelayhistory`] for now.
pub fn setting(app_data_dir: &Path) -> Arc<dyn SettingsExtension> {
    Arc::new(HistoryRetentionSetting::new(
        app_data_dir,
        Arc::new(NotYetInRelayhistory),
    ))
}

/// `history_retention_days` in `settings.get` and `settings.set`.
pub struct HistoryRetentionSetting {
    file: PathBuf,
    days: Arc<AtomicU32>,
    relayhistory: Arc<dyn HistoryRetention>,
    /// Held while relayhistory is told, so a later choice is never
    /// overtaken by an earlier one.
    applying: Arc<Mutex<()>>,
}

impl HistoryRetentionSetting {
    pub fn new(
        app_data_dir: &Path,
        relayhistory: Arc<dyn HistoryRetention>,
    ) -> HistoryRetentionSetting {
        let file = app_data_dir.join(FILE);
        let days = load(&file);
        HistoryRetentionSetting {
            file,
            days: Arc::new(AtomicU32::new(days)),
            relayhistory,
            applying: Arc::new(Mutex::new(())),
        }
    }

    pub fn retention(&self) -> Retention {
        Retention::from_setting(self.days.load(Ordering::Acquire)).unwrap_or(Retention::DEFAULT)
    }

    /// Hands the current choice to relayhistory on a thread of its own. The
    /// thread reads the choice once it holds `applying`, so the last
    /// choice made is the last one handed over.
    fn apply_later(&self) {
        let days = self.days.clone();
        let relayhistory = self.relayhistory.clone();
        let applying = self.applying.clone();
        let spawned = std::thread::Builder::new()
            .name("history-retention".into())
            .spawn(move || {
                let _applying = applying.lock().unwrap_or_else(|p| p.into_inner());
                let retention = Retention::from_setting(days.load(Ordering::Acquire))
                    .unwrap_or(Retention::DEFAULT);
                if let Err(error) = relayhistory.apply(retention) {
                    crate::relay::diagnostics::write(format_args!(
                        "relay: could not apply history retention: {error}"
                    ));
                }
            });
        if let Err(error) = spawned {
            crate::relay::diagnostics::write(format_args!(
                "relay: could not start applying history retention: {error}"
            ));
        }
    }

    fn save(&self, days: u32) -> Result<(), String> {
        let saved = serde_json::to_vec_pretty(&Saved { days: Some(days) }).is_ok_and(|bytes| {
            self.file
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .is_ok()
                && atomicwrites::AtomicFile::new(&self.file, atomicwrites::AllowOverwrite)
                    .write(|f| std::io::Write::write_all(f, &bytes))
                    .is_ok()
        });
        if saved {
            Ok(())
        } else {
            Err("The session history setting could not be saved.".into())
        }
    }
}

/// A missing, unreadable or unknown value is the default: nothing here is
/// worth failing a start over.
fn load(file: &Path) -> u32 {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
        .and_then(|saved| saved.days)
        .filter(|days| CHOICES.contains(days))
        .unwrap_or(DEFAULT_DAYS)
}

impl SettingsExtension for HistoryRetentionSetting {
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        settings.insert(SETTING.into(), json!(self.retention().setting()));
        settings
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        let Some(retention) = value
            .as_u64()
            .and_then(|days| u32::try_from(days).ok())
            .and_then(Retention::from_setting)
        else {
            return Some(Err(
                "history_retention_days must be 7, 30 or 90, or 0 to keep history forever.".into(),
            ));
        };
        let days = retention.setting();
        if let Err(error) = self.save(days) {
            return Some(Err(error));
        }
        self.days.store(days, Ordering::Release);
        self.apply_later();
        Some(Ok(()))
    }

    /// relayhistory is told the saved choice at each start, so a choice made
    /// while it could not be told still reaches it.
    fn attach(&self, _changed: crate::relay::settings_watch::SettingsChanged) {
        self.apply_later();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Records what relayhistory was told.
    struct Recording(Mutex<mpsc::Sender<Retention>>);

    impl HistoryRetention for Recording {
        fn apply(&self, retention: Retention) -> Result<(), String> {
            self.0.lock().unwrap().send(retention).unwrap();
            Ok(())
        }
    }

    fn setting(dir: &Path) -> (HistoryRetentionSetting, mpsc::Receiver<Retention>) {
        let (sent, told) = mpsc::channel();
        let setting = HistoryRetentionSetting::new(dir, Arc::new(Recording(Mutex::new(sent))));
        (setting, told)
    }

    fn told(told: &mpsc::Receiver<Retention>) -> Retention {
        told.recv_timeout(Duration::from_secs(5)).unwrap()
    }

    #[test]
    fn thirty_days_unless_changed() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, _) = setting(dir.path());
        assert_eq!(setting.get()[SETTING], 30);
        assert_eq!(setting.retention(), Retention::DEFAULT);
        assert_eq!(Retention::DEFAULT.setting(), DEFAULT_DAYS);
    }

    #[test]
    fn a_choice_is_saved_and_handed_to_relayhistory() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, relayhistory) = setting(dir.path());
        assert_eq!(setting.set(SETTING, &json!(90)), Some(Ok(())));
        assert_eq!(setting.get()[SETTING], 90);
        assert_eq!(
            told(&relayhistory),
            Retention::Days(NonZeroU32::new(90).unwrap())
        );
        assert_eq!(setting.set(SETTING, &json!(0)), Some(Ok(())));
        assert_eq!(told(&relayhistory), Retention::Forever);

        let (reopened, relayhistory) = self::setting(dir.path());
        assert_eq!(reopened.get()[SETTING], 0);
        reopened.attach(Arc::new(|| {}));
        assert_eq!(
            told(&relayhistory),
            Retention::Forever,
            "told again at start"
        );
    }

    /// The apps and agents change it through `settings.set`, which checks
    /// a value's type before any extension sees it.
    #[tokio::test]
    async fn the_core_saves_a_choice_made_in_settings() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock"))
                .unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: std::collections::BTreeMap::new(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: crate::relay::push::PushTiming::default(),
            delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
        };
        let plugins = crate::relay::daemon::Plugins {
            settings: vec![super::setting(&config.app_data_dir)],
            ..crate::relay::daemon::Plugins::default()
        };
        let (core, _signals) = crate::relay::daemon::Core::with_plugins(config, plugins);
        assert_eq!(core.settings()[SETTING], 30);
        for days in [7, 0, 90, 30] {
            let mut change = Map::new();
            change.insert(SETTING.into(), json!(days));
            let settings = core.set_settings(&change).unwrap();
            assert_eq!(settings[SETTING], days);
        }
        let mut wrong = Map::new();
        wrong.insert(SETTING.into(), json!(45));
        let refused = core.set_settings(&wrong).unwrap_err();
        assert!(
            refused.message.contains("7, 30 or 90"),
            "{}",
            refused.message
        );
        wrong.insert(SETTING.into(), json!(true));
        assert!(core.set_settings(&wrong).is_err());
        assert_eq!(core.settings()[SETTING], 30);
        assert_eq!(load(&temp.path().join("app-data").join(FILE)), 30);
    }

    #[test]
    fn only_the_offered_choices_are_taken() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, relayhistory) = setting(dir.path());
        for wrong in [json!(1), json!(31), json!(-7), json!("30"), json!(true)] {
            let refused = setting.set(SETTING, &wrong).unwrap().unwrap_err();
            assert!(refused.contains("7, 30 or 90"), "{refused}");
        }
        assert_eq!(setting.get()[SETTING], 30);
        assert!(relayhistory.try_recv().is_err(), "nothing handed over");
        assert_eq!(setting.set("analytics_enabled", &json!(true)), None);
    }

    #[test]
    fn an_unreadable_file_is_the_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), b"{\"days\": 45}").unwrap();
        assert_eq!(setting(dir.path()).0.get()[SETTING], 30);
        std::fs::write(dir.path().join(FILE), b"not json").unwrap();
        assert_eq!(setting(dir.path()).0.get()[SETTING], 30);
    }

    /// Reading the setting is an atomic load: no file, no database.
    #[test]
    fn reading_touches_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, _) = setting(dir.path());
        setting.set(SETTING, &json!(7)).unwrap().unwrap();
        std::fs::remove_file(dir.path().join(FILE)).unwrap();
        assert_eq!(setting.get()[SETTING], 7);
    }
}
