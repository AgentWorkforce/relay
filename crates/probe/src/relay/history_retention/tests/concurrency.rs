use super::*;
use crate::relay::uploader::{Install, InstallRun, ProbeRunner, Uploader, UploaderError};
use crate::relay::workspace::Secret;
use futures_util::future::{BoxFuture, FutureExt};
use std::sync::mpsc::{self, Receiver, Sender};

struct Gate {
    entered: Sender<()>,
    release: Mutex<Receiver<()>>,
}

impl Gate {
    fn new() -> (Arc<Self>, Receiver<()>, Sender<()>) {
        let (entered, arrived) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        (
            Arc::new(Self {
                entered,
                release: Mutex::new(resume),
            }),
            arrived,
            release,
        )
    }

    fn pause(&self) {
        self.entered.send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
    }
}

#[test]
fn stale_readback_never_overwrites_keep_forever() {
    let dir = tempfile::tempdir().unwrap();
    let (setting, store) = setting(dir.path());
    store.open("/probe/race/history.db", 1, 30);
    setting.inner.reconcile();
    store.open("/probe/race/history.db", 1, 7);
    let (gate, entered, release) = Gate::new();
    *setting.inner.before_reconcile_publish.lock().unwrap() = Some(Arc::new(move || gate.pause()));
    let inner = setting.inner.clone();
    let readback = std::thread::spawn(move || inner.reconcile());
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(setting.set(SETTING, &json!(0)), Some(Ok(())));
    assert_eq!(setting.get()[SETTING], 0);
    release.send(()).unwrap();
    readback.join().unwrap();
    assert_eq!(
        setting.get()[SETTING],
        0,
        "a stale readback cannot replace forever"
    );
    eventually("forever reaches the store", || {
        let saved = load(&dir.path().join(FILE));
        store.days() == Some(0) && saved.days == Some(0) && !saved.pending
    });
}

struct PausingStore {
    store: Arc<Store>,
    before_apply: Mutex<Option<Arc<Gate>>>,
}

impl HistoryRetention for PausingStore {
    fn saved(&self) -> Option<(StoreId, u32)> {
        self.store.saved()
    }
    fn apply(&self, retention: Retention) -> Result<Option<StoreId>, String> {
        let pause = self.before_apply.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.pause();
        }
        self.store.apply(retention)
    }
}

#[test]
fn a_choice_during_an_older_write_stays_pending_until_written() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::default());
    store.open("/probe/write/history.db", 1, 30);
    let backend = Arc::new(PausingStore {
        store: store.clone(),
        before_apply: Mutex::new(None),
    });
    let setting =
        HistoryRetentionSetting::new(dir.path(), backend.clone(), Duration::from_secs(60));
    setting.inner.reconcile();
    let (gate, entered, release) = Gate::new();
    *backend.before_apply.lock().unwrap() = Some(gate);
    setting.set(SETTING, &json!(90)).unwrap().unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    setting.set(SETTING, &json!(0)).unwrap().unwrap();
    assert_eq!(setting.get()[SETTING], 0);
    let saved = load(&dir.path().join(FILE));
    assert_eq!(saved.days, Some(0));
    assert!(
        saved.pending,
        "the newer choice has not reached the held store"
    );
    release.send(()).unwrap();
    eventually("the newer choice is saved", || {
        store.days() == Some(0) && !load(&dir.path().join(FILE)).pending
    });
}

/// A runner which cannot launch a helper or touch an installed account.
struct NoProbe {
    root: PathBuf,
}
impl ProbeRunner for NoProbe {
    fn history_access_root(&self) -> Option<PathBuf> {
        Some(self.root.clone())
    }
    fn run(
        &self,
        _: Vec<String>,
        _: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        async {
            Err(UploaderError::new(
                "synthetic retention fixture forbids probe execution",
            ))
        }
        .boxed()
    }
    fn install(&self, _: Vec<String>, _: Option<Secret>) -> Result<InstallRun, UploaderError> {
        Err(UploaderError::new(
            "synthetic retention fixture forbids install",
        ))
    }
    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
        async { Ok(()) }.boxed()
    }
}

fn leased_store(dir: &Path) -> (Arc<Uploader>, InStore) {
    let db = dir.join("history.db");
    ai_hist::SessionStore::open(ai_hist::StoreOptions::default().db_path(&db)).unwrap();
    let uploader = Arc::new(Uploader::new(Arc::new(NoProbe { root: dir.into() })));
    uploader.attach(Install::from_json(
        &json!({"site_url":"https://fixture.invalid", "directory":dir}),
    ));
    let weak = Arc::downgrade(&uploader);
    let active = Arc::new(move || {
        Some(PathBuf::from(weak.upgrade()?.install()?.directory?).join("history.db"))
    });
    let store = InStore {
        active,
        uploader: Some(Arc::downgrade(&uploader)),
        after_open: None,
    };
    (uploader, store)
}

#[tokio::test]
async fn retention_operation_holds_reset_lease_until_its_handle_closes() {
    let dir = tempfile::tempdir().unwrap();
    let (uploader, mut store) = leased_store(dir.path());
    let (gate, entered, release) = Gate::new();
    store.after_open = Some(Arc::new(move || gate.pause()));
    let worker = std::thread::spawn(move || store.saved());
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let reset = uploader.suspend_background_readers();
    tokio::pin!(reset);
    assert!(
        reset.as_mut().now_or_never().is_none(),
        "reset must wait for the opened retention handle"
    );
    release.send(()).unwrap();
    assert!(worker.join().unwrap().is_some());
    let _reset = reset.await;
    let _external = crate::history_access::writer(dir.path()).unwrap();
}

#[tokio::test]
async fn reset_denies_retention_before_any_database_open_or_write() {
    let dir = tempfile::tempdir().unwrap();
    let (uploader, store) = leased_store(dir.path());
    let reset = uploader.suspend_background_readers().await;
    assert_eq!(store.saved(), None);
    assert_eq!(store.apply(Retention::Forever).unwrap(), None);
    std::fs::remove_file(dir.path().join("history.db")).unwrap();
    assert_eq!(store.apply(Retention::Forever).unwrap(), None);
    assert!(
        !dir.path().join("history.db").exists(),
        "a denied operation cannot recreate a reset database"
    );
    drop(reset);
    ai_hist::SessionStore::open(
        ai_hist::StoreOptions::default().db_path(dir.path().join("history.db")),
    )
    .unwrap();
    std::fs::write(dir.path().join("session-reset-pending.json"), "pending").unwrap();
    assert_eq!(store.saved(), None);
    assert_eq!(store.apply(Retention::Forever).unwrap(), None);
    std::fs::remove_file(dir.path().join("session-reset-pending.json")).unwrap();
    assert!(store.apply(Retention::Forever).unwrap().is_some());
    assert_eq!(store.saved().unwrap().1, 0);
}

#[test]
fn external_reset_intent_denies_retention_and_a_later_attempt_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let (_uploader, store) = leased_store(dir.path());
    let reset = crate::history_access::writer(dir.path()).unwrap();
    assert_eq!(store.saved(), None);
    assert_eq!(store.apply(Retention::Forever).unwrap(), None);
    drop(reset);
    assert_eq!(
        store.saved().unwrap().1,
        30,
        "denied writes leave the policy untouched"
    );
    assert!(store.apply(Retention::Forever).unwrap().is_some());
    assert_eq!(store.saved().unwrap().1, 0);
}
