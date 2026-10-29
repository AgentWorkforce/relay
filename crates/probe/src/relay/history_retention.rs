//! How long this computer keeps local session history
//! (`history_retention_days`): 7, 30 or 90 days, or forever (`0`). 30
//! unless changed.
//!
//! RelayHistory owns the policy: it is saved in the signed-in install's own
//! store (`history.retention_days` in its `history.db`), where the collector's
//! maintenance reads it and evicts older history once it has uploaded
//! (`probe::retention`). This setting is the app's side of it, through
//! [`HistoryRetention`]: a choice is written to the store, and the store's
//! value is read back, so a choice another client made there shows here. The
//! choice is also kept in memory, so `settings.get` reads no file and no
//! database, and both directions run on threads of their own, so neither
//! `settings.set` nor the session read path waits on SQLite.

use crate::relay::agents::SettingsExtension;
use crate::relay::settings_watch::SettingsChanged;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

pub const SETTING: &str = "history_retention_days";

/// Days kept unless the person changes it.
pub const DEFAULT_DAYS: u32 = 30;

/// The setting's value for keeping history forever.
pub const FOREVER: u32 = 0;

/// Every value the setting takes, in the order Settings offers them.
pub const CHOICES: [u32; 4] = [7, 30, 90, FOREVER];

const FILE: &str = "history-retention.json";

/// How often the store's policy is read back, which also notices a newly
/// signed-in workspace's store.
#[cfg(feature = "history")]
const RECONCILE_EVERY: Duration = Duration::from_secs(30);

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

/// One store, as retention sees it: where it is and which database it is.
/// A store recreated at the same path (a session reset) gets a new change
/// feed epoch, so it is a different store with RelayHistory's default, not
/// one already in step with this choice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreId {
    pub path: PathBuf,
    pub epoch: u64,
}

/// RelayHistory's side of the setting: the one place that knows how the
/// policy is stored, called only off the read path and never twice at once.
pub trait HistoryRetention: Send + Sync + 'static {
    /// The signed-in install's store and the days saved in it (`0` for
    /// forever, RelayHistory's default when none is), or `None` while there
    /// is no store or it cannot be read.
    fn saved(&self) -> Option<(StoreId, u32)>;
    /// Saves `retention` in the signed-in install's store; returns that
    /// store, or `None` while there is none.
    fn apply(&self, retention: Retention) -> Result<Option<StoreId>, String>;
}

/// The signed-in install's `history.db`, from the directory the uploader
/// last reported, or `None` while signed out or before it has been created.
pub type ActiveStore = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;

/// [`HistoryRetention`] over RelayHistory's store-level policy
/// (`ai_hist::retention`).
#[cfg(feature = "history")]
pub struct InStore {
    active: ActiveStore,
    uploader: Option<Weak<crate::relay::uploader::Uploader>>,
    #[cfg(test)]
    after_open: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[cfg(feature = "history")]
impl InStore {
    fn store(&self) -> Option<(PathBuf, Option<crate::relay::uploader::HistoryReader>)> {
        // Acquire before even checking the path; reset may replace it. The
        // owned reader outlives every handle opened by this operation.
        let reader = match &self.uploader {
            Some(uploader) => Some(uploader.upgrade()?.try_history_reader().ok()?),
            None => None, // Isolated setting_at stores have no uploader.
        };
        let db = (self.active)().filter(|db| db.is_file())?;
        Some((db, reader))
    }

    /// The store at `db`, read-only, and its identity. Opened afresh each
    /// time: a handle kept open would go on reading a store a reset removed.
    fn open(db: &Path) -> Result<(ai_hist::SessionStore, StoreId), ai_hist::Error> {
        let mut options = ai_hist::StoreOptions::default().db_path(db);
        options.read_only = true;
        let store = ai_hist::SessionStore::open(options)?;
        let epoch = store.head_revision()?.epoch;
        let id = StoreId {
            path: db.to_path_buf(),
            epoch,
        };
        Ok((store, id))
    }
}

#[cfg(feature = "history")]
impl HistoryRetention for InStore {
    fn saved(&self) -> Option<(StoreId, u32)> {
        let (db, _reader) = self.store()?;
        let (store, id) = Self::open(&db).ok()?;
        #[cfg(test)]
        if let Some(after_open) = &self.after_open {
            after_open();
        }
        let policy = store.retention_policy().ok()?;
        Some((id, policy.days.map_or(FOREVER, NonZeroU32::get)))
    }

    fn apply(&self, retention: Retention) -> Result<Option<StoreId>, String> {
        let Some((db, _reader)) = self.store() else {
            return Ok(None);
        };
        let policy = ai_hist::retention::RetentionPolicy::from_days(retention.setting());
        ai_hist::retention::write_retention_policy(&db, policy).map_err(|e| e.to_string())?;
        Ok(Some(Self::open(&db).map_err(|e| e.to_string())?.1))
    }
}

/// The settings file: the choice, the store last in step with it, and
/// whether a choice is still waiting to be saved in a store.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    store: Option<StoreId>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pending: bool,
}

/// The setting as the core serves it, saved under `app_data_dir` and in the
/// store of the install `uploader` last reported.
#[cfg(feature = "history")]
pub fn setting(
    app_data_dir: &Path,
    uploader: &Arc<crate::relay::uploader::Uploader>,
) -> Arc<dyn SettingsExtension> {
    let weak = Arc::downgrade(uploader);
    let active = Arc::new(move || {
        let directory = weak.upgrade()?.install()?.directory?;
        Some(PathBuf::from(directory).join("history.db"))
    });
    Arc::new(HistoryRetentionSetting::new(
        app_data_dir,
        Arc::new(InStore {
            active,
            uploader: Some(Arc::downgrade(uploader)),
            #[cfg(test)]
            after_open: None,
        }),
        RECONCILE_EVERY,
    ))
}

/// The setting in a core built without session history: there is no
/// history to keep, so it reads [`DEFAULT_DAYS`] and refuses a change with
/// `history_unavailable`. The key stays, so `settings.get` has one shape in
/// every build.
#[cfg(not(feature = "history"))]
pub fn setting(
    _app_data_dir: &Path,
    _uploader: &Arc<crate::relay::uploader::Uploader>,
) -> Arc<dyn SettingsExtension> {
    Arc::new(Unavailable)
}

/// [`setting`] without the `history` feature.
pub struct Unavailable;

impl SettingsExtension for Unavailable {
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        settings.insert(SETTING.into(), json!(Retention::DEFAULT.setting()));
        settings
    }

    fn set(&self, key: &str, _value: &Value) -> Option<Result<(), String>> {
        (key == SETTING).then(|| Err(crate::relay::protocol::HISTORY_UNAVAILABLE.into()))
    }
}

/// [`setting`] with the store at `active`.
#[cfg(feature = "history")]
pub fn setting_at(app_data_dir: &Path, active: ActiveStore) -> Arc<dyn SettingsExtension> {
    Arc::new(HistoryRetentionSetting::new(
        app_data_dir,
        Arc::new(InStore {
            active,
            uploader: None,
            #[cfg(test)]
            after_open: None,
        }),
        RECONCILE_EVERY,
    ))
}

/// `history_retention_days` in `settings.get` and `settings.set`.
pub struct HistoryRetentionSetting {
    inner: Arc<Inner>,
}

struct Inner {
    file: PathBuf,
    days: AtomicU32,
    relayhistory: Arc<dyn HistoryRetention>,
    /// What the settings file holds besides the days. Held only briefly,
    /// never across a store read or write, so `settings.set` never waits on
    /// SQLite.
    state: Mutex<Saved>,
    /// Held across each store read or write, so they run one at a time and
    /// a later choice is never overtaken by an earlier one.
    working: Mutex<()>,
    changed: Mutex<Option<SettingsChanged>>,
    every: Duration,
    #[cfg(test)]
    before_reconcile_publish: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl HistoryRetentionSetting {
    pub fn new(
        app_data_dir: &Path,
        relayhistory: Arc<dyn HistoryRetention>,
        every: Duration,
    ) -> HistoryRetentionSetting {
        let file = app_data_dir.join(FILE);
        let saved = load(&file);
        HistoryRetentionSetting {
            inner: Arc::new(Inner {
                days: AtomicU32::new(saved.days.unwrap_or(DEFAULT_DAYS)),
                state: Mutex::new(saved),
                file,
                relayhistory,
                working: Mutex::new(()),
                changed: Mutex::new(None),
                every,
                #[cfg(test)]
                before_reconcile_publish: Mutex::new(None),
            }),
        }
    }

    pub fn retention(&self) -> Retention {
        self.inner.retention()
    }
}

impl Inner {
    fn retention(&self) -> Retention {
        Retention::from_setting(self.days.load(Ordering::Acquire)).unwrap_or(Retention::DEFAULT)
    }

    /// Changes the settings file's state and saves it with the current days.
    fn update(&self, change: impl FnOnce(&mut Saved)) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        change(&mut state);
        state.days = Some(self.days.load(Ordering::Acquire));
        save(&self.file, &state)
    }

    fn report(&self, result: Result<(), String>) {
        if let Err(error) = result {
            crate::relay::diagnostics::write(format_args!("relay: {error}"));
        }
    }

    /// Writes the current choice to the store. Only a store that took it is
    /// in step; until one does, the choice stays pending and is written again
    /// at the next reconcile.
    fn apply(&self) {
        let _working = self.working.lock().unwrap_or_else(|p| p.into_inner());
        let days = self.days.load(Ordering::Acquire);
        let retention = Retention::from_setting(days).unwrap_or(Retention::DEFAULT);
        match self.relayhistory.apply(retention) {
            Ok(Some(store)) => self.report(self.update(|state| {
                state.store = Some(store);
                // A choice made while this one was being written is still
                // pending.
                state.pending = days != self.days.load(Ordering::Acquire);
            })),
            Ok(None) => {}
            Err(error) => crate::relay::diagnostics::write(format_args!(
                "relay: could not save history retention: {error}"
            )),
        }
    }

    /// Brings the choice and the store into step. A pending choice, or a
    /// store not yet in step (a workspace signed in to since, a store a
    /// reset recreated), is given this computer's choice; a store in step
    /// may have been changed by another client, so its value is taken. A
    /// value Settings does not offer is left alone.
    fn reconcile(&self) {
        let working = self.working.lock().unwrap_or_else(|p| p.into_inner());
        let Some((store, days)) = self.relayhistory.saved() else {
            return;
        };
        #[cfg(test)]
        if let Some(before_publish) = self
            .before_reconcile_publish
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            before_publish();
        }
        // The readback is only a candidate until it can be published with
        // pending/store under the same lock used by settings.set.
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.pending || state.store.as_ref() != Some(&store) {
            drop(state);
            drop(working);
            return self.apply();
        }
        if !CHOICES.contains(&days) || days == self.days.load(Ordering::Acquire) {
            return;
        }
        self.days.store(days, Ordering::Release);
        state.days = Some(days);
        self.report(save(&self.file, &state));
        drop(state);
        let changed = self
            .changed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(changed) = changed {
            changed();
        }
    }
}

/// Runs `work` on a thread of its own.
fn spawn(name: &str, work: impl FnOnce() + Send + 'static) {
    if let Err(error) = std::thread::Builder::new().name(name.into()).spawn(work) {
        crate::relay::diagnostics::write(format_args!("relay: could not start {name}: {error}"));
    }
}

fn save(file: &Path, saved: &Saved) -> Result<(), String> {
    let written = serde_json::to_vec_pretty(saved).is_ok_and(|bytes| {
        file.parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .is_ok()
            && atomicwrites::AtomicFile::new(file, atomicwrites::AllowOverwrite)
                .write(|f| std::io::Write::write_all(f, &bytes))
                .is_ok()
    });
    if written {
        Ok(())
    } else {
        Err("The session history setting could not be saved.".into())
    }
}

/// Whether this computer's choice, saved under `app_data_dir`, is in the
/// store at `db` whose change feed has `epoch`, with no other choice pending.
/// Until it is, the store may hold RelayHistory's default instead (a store
/// first seen, one a reset recreated, the first run after an upgrade), so
/// the collector evicts nothing by it (`agent_relay_probe::retention`).
pub fn applied_to(app_data_dir: &Path, db: &Path, epoch: u64) -> bool {
    let same = |a: &Path, b: &Path| {
        a == b
            || matches!(
                (std::fs::canonicalize(a), std::fs::canonicalize(b)),
                (Ok(a), Ok(b)) if a == b
            )
    };
    let saved = load(&app_data_dir.join(FILE));
    !saved.pending
        && saved
            .store
            .is_some_and(|store| store.epoch == epoch && same(&store.path, db))
}

/// A missing or unreadable file, or an unknown value, is the default:
/// nothing here is worth failing a start over.
fn load(file: &Path) -> Saved {
    let saved: Saved = std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    Saved {
        days: saved.days.filter(|days| CHOICES.contains(days)),
        ..saved
    }
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
        // Publish the choice and pending flag together; a concurrent store
        // readback must never overwrite a newer local choice.
        let mut state = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        let previous = state.clone();
        let previous_days = self.inner.days.load(Ordering::Acquire);
        self.inner
            .days
            .store(retention.setting(), Ordering::Release);
        state.days = Some(retention.setting());
        state.pending = true;
        if let Err(error) = save(&self.inner.file, &state) {
            *state = previous;
            self.inner.days.store(previous_days, Ordering::Release);
            return Some(Err(error));
        }
        drop(state);
        let inner = self.inner.clone();
        spawn("history-retention", move || inner.apply());
        Some(Ok(()))
    }

    /// Reads the store's policy back now and then: at start, a store in step
    /// with this choice gives its value, and a store not yet in step (a
    /// workspace signed in to since) is given this choice.
    fn attach(&self, changed: SettingsChanged) {
        *self.inner.changed.lock().unwrap_or_else(|p| p.into_inner()) = Some(changed);
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        spawn("history-retention", move || {
            while let Some(inner) = weak.upgrade() {
                inner.reconcile();
                let every = inner.every;
                drop(inner);
                std::thread::sleep(every);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[cfg(feature = "history")]
    mod concurrency;

    /// A store in memory: which one is signed in to (once one is), its days,
    /// and whether writes fail.
    #[derive(Default)]
    struct Store {
        open: Mutex<Option<(StoreId, u32)>>,
        failing: std::sync::atomic::AtomicBool,
    }

    impl Store {
        fn open(&self, path: &str, epoch: u64, days: u32) {
            let id = StoreId {
                path: PathBuf::from(path),
                epoch,
            };
            *self.open.lock().unwrap() = Some((id, days));
        }
        fn close(&self) {
            *self.open.lock().unwrap() = None;
        }
        fn days(&self) -> Option<u32> {
            self.open.lock().unwrap().as_ref().map(|(_, days)| *days)
        }
    }

    impl HistoryRetention for Store {
        fn saved(&self) -> Option<(StoreId, u32)> {
            self.open.lock().unwrap().clone()
        }
        fn apply(&self, retention: Retention) -> Result<Option<StoreId>, String> {
            if self.failing.load(Ordering::SeqCst) {
                return Err("database is locked".into());
            }
            let mut open = self.open.lock().unwrap();
            Ok(open.as_mut().map(|(id, days)| {
                *days = retention.setting();
                id.clone()
            }))
        }
    }

    fn setting(dir: &Path) -> (HistoryRetentionSetting, Arc<Store>) {
        let store = Arc::new(Store::default());
        let setting = HistoryRetentionSetting::new(dir, store.clone(), Duration::from_millis(20));
        (setting, store)
    }

    fn eventually(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Waits for the write `set` started to finish.
    fn settled(setting: &HistoryRetentionSetting) {
        eventually("the write settled", || {
            !setting.inner.state.lock().unwrap().pending || setting.inner.working.try_lock().is_ok()
        });
        drop(setting.inner.working.lock().unwrap());
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
    fn a_choice_is_written_to_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        assert_eq!(setting.set(SETTING, &json!(90)), Some(Ok(())));
        assert_eq!(setting.get()[SETTING], 90, "shown at once");
        eventually("90 days saved in the store", || store.days() == Some(90));
        assert_eq!(setting.set(SETTING, &json!(0)), Some(Ok(())));
        eventually("forever saved in the store", || store.days() == Some(0));
        eventually("in step, nothing pending", || {
            let saved = load(&dir.path().join(FILE));
            !saved.pending && saved.store.is_some_and(|id| id.epoch == 1)
        });
    }

    /// A value another client saved in a store already in step shows here,
    /// and the apps are told to read the settings again.
    #[test]
    fn the_stores_own_value_is_taken_back() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        setting.inner.reconcile();
        assert_eq!(store.days(), Some(30), "first seen: given this choice");
        store.open("/probe/a/history.db", 1, 7);
        let told = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = told.clone();
        setting.attach(Arc::new(move || seen.store(true, Ordering::SeqCst)));
        eventually("7 days read back", || setting.get()[SETTING] == 7);
        eventually("the apps told", || told.load(Ordering::SeqCst));
        assert_eq!(load(&dir.path().join(FILE)).days, Some(7));
    }

    /// A workspace signed in to after the choice was made gets it, rather
    /// than RelayHistory's default.
    #[test]
    fn a_store_first_seen_is_given_this_choice() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), br#"{"days": 90}"#).unwrap();
        let (setting, store) = setting(dir.path());
        setting.inner.reconcile();
        assert_eq!(store.days(), None, "no store yet: nothing to write");
        store.open("/probe/b/history.db", 1, 30);
        setting.inner.reconcile();
        assert_eq!(store.days(), Some(90));
        assert_eq!(setting.get()[SETTING], 90);
        // Restarted with the choice already in step: the store's value wins.
        store.open("/probe/b/history.db", 1, 7);
        let reopened =
            HistoryRetentionSetting::new(dir.path(), store.clone(), Duration::from_secs(60));
        reopened.inner.reconcile();
        assert_eq!(reopened.get()[SETTING], 7);
    }

    /// A reset recreates the store at the same path with RelayHistory's
    /// default; it is a new store, so it is given the choice, not taken from.
    #[test]
    fn a_store_recreated_at_the_same_path_keeps_the_choice() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        setting.set(SETTING, &json!(0)).unwrap().unwrap();
        settled(&setting);
        eventually("forever saved", || store.days() == Some(0));
        store.open("/probe/a/history.db", 2, 30);
        setting.inner.reconcile();
        assert_eq!(store.days(), Some(0), "the new store gets forever");
        assert_eq!(setting.get()[SETTING], 0);
    }

    /// A choice made while signed out waits for the store, rather than being
    /// replaced by the store's older value on signing back in.
    #[test]
    fn a_choice_made_while_signed_out_reaches_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        setting.inner.reconcile();
        store.close();
        setting.set(SETTING, &json!(0)).unwrap().unwrap();
        settled(&setting);
        assert!(load(&dir.path().join(FILE)).pending);
        store.open("/probe/a/history.db", 1, 30);
        // Restarted before signing back in: the pending choice survives.
        let reopened =
            HistoryRetentionSetting::new(dir.path(), store.clone(), Duration::from_secs(60));
        reopened.inner.reconcile();
        assert_eq!(store.days(), Some(0));
        assert_eq!(reopened.get()[SETTING], 0);
        assert!(!load(&dir.path().join(FILE)).pending);
    }

    /// A write the store refused is tried again, not undone by the store's
    /// older value.
    #[test]
    fn a_failed_write_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        setting.inner.reconcile();
        store.failing.store(true, Ordering::SeqCst);
        setting.set(SETTING, &json!(90)).unwrap().unwrap();
        settled(&setting);
        setting.inner.reconcile();
        assert_eq!(
            (store.days(), setting.get()[SETTING].clone()),
            (Some(30), json!(90))
        );
        store.failing.store(false, Ordering::SeqCst);
        setting.inner.reconcile();
        assert_eq!(store.days(), Some(90));
    }

    /// `settings.set` never waits for a store read or write in progress.
    #[test]
    fn a_choice_never_waits_on_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        let working = setting.inner.working.lock().unwrap();
        let started = Instant::now();
        assert_eq!(setting.set(SETTING, &json!(7)), Some(Ok(())));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(setting.get()[SETTING], 7);
        drop(working);
        eventually("written once the store is free", || store.days() == Some(7));
    }

    /// The collector evicts only once the choice is in this very store.
    #[test]
    fn the_collector_waits_for_the_choice_to_reach_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let db = Path::new("/probe/a/history.db");
        assert!(!applied_to(dir.path(), db, 1), "nothing saved yet");
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        setting.inner.reconcile();
        assert!(applied_to(dir.path(), db, 1));
        assert!(!applied_to(dir.path(), db, 2), "a recreated store");
        assert!(!applied_to(dir.path(), Path::new("/probe/b/history.db"), 1));
        store.close();
        setting.set(SETTING, &json!(90)).unwrap().unwrap();
        settled(&setting);
        assert!(!applied_to(dir.path(), db, 1), "a choice still pending");
    }

    #[test]
    fn a_value_settings_does_not_offer_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        setting.inner.reconcile();
        store.open("/probe/a/history.db", 1, 14);
        setting.inner.reconcile();
        assert_eq!(store.days(), Some(14), "another client's choice stays");
        assert_eq!(setting.get()[SETTING], 30);
    }

    #[cfg(feature = "history")]
    /// The policy round-trips through RelayHistory's own store.
    #[test]
    fn the_policy_is_saved_in_relayhistorys_store() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let active: ActiveStore = {
            let db = db.clone();
            Arc::new(move || Some(db.clone()))
        };
        let in_store = InStore {
            active,
            uploader: None,
            after_open: None,
        };
        assert_eq!(in_store.saved(), None, "no store yet");
        assert_eq!(in_store.apply(Retention::Forever).unwrap(), None);
        ai_hist::SessionStore::open(ai_hist::StoreOptions::default().db_path(&db)).unwrap();
        let (id, days) = in_store.saved().unwrap();
        assert_eq!(
            (id.path.clone(), days),
            (db.clone(), 30),
            "RelayHistory's default"
        );
        let written = in_store
            .apply(Retention::Days(NonZeroU32::new(7).unwrap()))
            .unwrap();
        assert_eq!(written.as_ref(), Some(&id), "the same store");
        assert_eq!(in_store.saved(), Some((id.clone(), 7)));
        in_store.apply(Retention::Forever).unwrap();
        assert_eq!(in_store.saved(), Some((id.clone(), 0)));
        // Recreated at the same path: another store, with the default.
        for file in ["history.db", "history.db-wal", "history.db-shm"] {
            let _ = std::fs::remove_file(dir.path().join(file));
        }
        ai_hist::SessionStore::open(ai_hist::StoreOptions::default().db_path(&db)).unwrap();
        let (recreated, days) = in_store.saved().unwrap();
        assert_eq!(days, 30);
        assert_ne!(recreated, id);
    }

    /// The apps and agents change it through `settings.set`, which checks
    /// a value's type before any extension sees it.
    #[cfg(feature = "history")]
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
            settings: vec![super::setting_at(&config.app_data_dir, Arc::new(|| None))],
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
        assert_eq!(
            load(&temp.path().join("app-data").join(FILE)).days,
            Some(30)
        );
    }

    /// Without session history the setting keeps its key and default, and
    /// `settings.set` refuses a change with `history_unavailable`.
    #[cfg(not(feature = "history"))]
    #[test]
    fn a_core_without_history_reads_the_default_and_refuses_a_change() {
        let setting = Unavailable;
        assert_eq!(setting.get()[SETTING], DEFAULT_DAYS);
        let refused = setting.set(SETTING, &json!(7)).unwrap().unwrap_err();
        let error = crate::relay::protocol::RpcError::setting_refused(refused);
        assert_eq!(
            error.data.kind,
            crate::relay::protocol::ErrorKind::HistoryUnavailable
        );
        assert_eq!(setting.set("analytics_enabled", &json!(true)), None);
    }

    #[test]
    fn only_the_offered_choices_are_taken() {
        let dir = tempfile::tempdir().unwrap();
        let (setting, store) = setting(dir.path());
        store.open("/probe/a/history.db", 1, 30);
        for wrong in [json!(1), json!(31), json!(-7), json!("30"), json!(true)] {
            let refused = setting.set(SETTING, &wrong).unwrap().unwrap_err();
            assert!(refused.contains("7, 30 or 90"), "{refused}");
        }
        assert_eq!(setting.get()[SETTING], 30);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(store.days(), Some(30), "nothing saved in the store");
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
        let (setting, store) = setting(dir.path());
        store.open("/probe/no-file/history.db", 1, 30);
        setting.set(SETTING, &json!(7)).unwrap().unwrap();
        std::fs::remove_file(dir.path().join(FILE)).unwrap();
        assert_eq!(setting.get()[SETTING], 7);
        eventually("the write completed", || {
            store.days() == Some(7) && !setting.inner.state.lock().unwrap().pending
        });
    }
}
