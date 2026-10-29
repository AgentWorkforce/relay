//! Every retained history reader shares this lifecycle with reset/recovery.
use super::*;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

type Cleanup = Arc<dyn Fn() + Send + Sync>;

/// An operation retains both barriers, even if attachment/cache ownership ends.
pub struct HistoryReader {
    pub(super) _local: OwnedRwLockReadGuard<()>,
    pub(super) _access: Option<Arc<crate::history_access::Access>>,
}

#[derive(Default)]
pub(crate) struct State {
    pub(super) monitor: Arc<Mutex<Background>>,
    pub(super) status: tokio::sync::Mutex<()>,
    pub(super) sessions: tokio::sync::Mutex<()>,
    pub(super) lifecycle: Arc<RwLock<()>>,
    pub(super) access: Arc<Mutex<Option<Arc<crate::history_access::Access>>>>,
    cleanups: Mutex<HashMap<&'static str, Cleanup>>,
}

impl Uploader {
    pub fn new(runner: Arc<dyn ProbeRunner>) -> Uploader {
        Uploader {
            runner,
            install: Mutex::new(None),
            revision: AtomicU64::new(0),
            starting: tokio::sync::Mutex::new(()),
            status_read: Mutex::new(None),
            status_snapshot: Mutex::new(None),
            sessions_snapshot: Mutex::new(None),
            sessions_read: Mutex::new(None),
            sessions_refresh: tokio::sync::Mutex::new(()),
            sessions_limit: Mutex::new(SESSION_LIST_LIMIT),
            query_index: Arc::default(),
            query_refresh: tokio::sync::Mutex::new(()),
            changes: AtomicU64::new(0),
            background: State::default(),
            sessions_demand: Mutex::new(None),
        }
    }

    /// Other persistent catalog readers must hold this across every operation
    /// that opens/reuses their handles, after acquiring their own query gate.
    pub async fn history_reader(&self) -> Result<HistoryReader, RpcError> {
        let guard = self.background.lifecycle.clone().read_owned().await;
        self.admit_history_reader(guard)
    }

    /// Short synchronous store operations refuse reset rather than waiting
    /// while holding an unrelated settings or SQLite lock.
    pub(crate) fn try_history_reader(&self) -> Result<HistoryReader, RpcError> {
        let guard = self
            .background
            .lifecycle
            .clone()
            .try_read_owned()
            .map_err(|_| RpcError::new(ErrorKind::Busy, "History is busy with a session reset."))?;
        self.admit_history_reader(guard)
    }

    fn admit_history_reader(
        &self,
        guard: OwnedRwLockReadGuard<()>,
    ) -> Result<HistoryReader, RpcError> {
        let access = self.retain_history_access()?;
        if self
            .install()
            .and_then(|i| i.directory)
            .is_some_and(|d| Path::new(&d).join("session-reset-pending.json").exists())
        {
            self.invalidate_history_readers();
            return Err(RpcError::new(
                ErrorKind::Busy,
                "A session reset is pending. Finish the reset before reading history.",
            ));
        }
        Ok(HistoryReader {
            _local: guard,
            _access: access,
        })
    }

    /// Keyed registration replaces a previous callback rather than accumulating
    /// one per request. Callbacks only close handles and must not await.
    pub fn register_history_reader_cleanup(&self, key: &'static str, close: Cleanup) {
        self.background
            .cleanups
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, close);
    }

    /// Holding this guard prevents all participating readers from reopening
    /// while the reset/start helper deletes or recovers a pending database.
    pub async fn suspend_background_readers(&self) -> OwnedRwLockWriteGuard<()> {
        let guard = self.background.lifecycle.clone().write_owned().await;
        self.invalidate_history_readers();
        guard
    }

    pub(super) fn external_reset_requested(&self) -> bool {
        self.runner
            .history_access_root()
            .is_some_and(|root| crate::history_access::reset_requested(&root).unwrap_or(true))
    }

    pub(super) fn retain_history_access(
        &self,
    ) -> Result<Option<Arc<crate::history_access::Access>>, RpcError> {
        let Some(root) = self.runner.history_access_root() else {
            return Ok(None);
        };
        let mut access = self
            .background
            .access
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if self.external_reset_requested() {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "A session reset is in progress.",
            ));
        }
        if access.is_none() {
            *access = Some(Arc::new(crate::history_access::try_reader(&root).map_err(
                |_| RpcError::new(ErrorKind::Busy, "History is busy with a session reset."),
            )?));
        }
        Ok(access.clone())
    }

    pub(crate) fn invalidate_history_readers(&self) {
        *self
            .background
            .monitor
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Background {
            attachment: self.revision.load(Ordering::SeqCst),
            ..Background::default()
        };
        let close = self
            .background
            .cleanups
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for close in close {
            close();
        }
        self.background
            .access
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

pub(crate) fn history_access_root(env: &[(String, std::ffi::OsString)]) -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    let home = match env.iter().rev().find(|(name, _)| name == key) {
        Some((_, value)) => (!value.is_empty()).then(|| PathBuf::from(value)),
        None => crate::platform::home_dir(),
    };
    home.map(|home| home.join(".agentworkforce"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicBool, Weak};

    struct ResetProbe {
        root: PathBuf,
        owner: Mutex<Weak<Uploader>>,
        entered: tokio::sync::mpsc::UnboundedSender<String>,
        proceed: tokio::sync::Semaphore,
        fail: AtomicBool,
    }
    impl ProbeRunner for ResetProbe {
        fn history_access_root(&self) -> Option<PathBuf> {
            Some(self.root.clone())
        }
        fn run(
            &self,
            args: Vec<String>,
            _: Option<Duration>,
        ) -> BoxFuture<'_, Result<Value, UploaderError>> {
            async move {
                let reset = args[0] == "sessions" && args[1] == "reset";
                if !reset && args[0] != "start" {
                    return Ok(json!({"running":true,"sessions":[]}));
                }
                let owner = self.owner.lock().unwrap().upgrade().unwrap();
                assert!(
                    owner.background.monitor.lock().unwrap().database.is_none(),
                    "production reset/start must close its monitor before the helper"
                );
                let root = self.root.clone();
                let access = tokio::task::spawn_blocking(move || {
                    crate::history_access::writer(&root).unwrap()
                })
                .await
                .unwrap();
                let db = self.root.join("history.db");
                std::fs::write(self.root.join("session-reset-pending.json"), "pending").unwrap();
                if db.exists() {
                    std::fs::remove_file(&db)
                        .expect("SQLite reader must be closed before Windows deletion");
                }
                self.entered
                    .send(if reset { "reset" } else { "start" }.into())
                    .unwrap();
                self.proceed.acquire().await.unwrap().forget();
                if self.fail.swap(false, Ordering::SeqCst) {
                    return Err(UploaderError::new("saved reset needs recovery"));
                }
                Connection::open(&db)
                    .unwrap()
                    .execute_batch("CREATE TABLE rebuilt(id TEXT);")
                    .unwrap();
                std::fs::remove_file(self.root.join("session-reset-pending.json")).unwrap();
                drop(access);
                Ok(if reset {
                    json!({"reset":true})
                } else {
                    json!({"started":true,"running":true})
                })
            }
            .boxed()
        }
        fn install(&self, _: Vec<String>, _: Option<Secret>) -> Result<InstallRun, UploaderError> {
            Err(UploaderError::new("unused"))
        }
        fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
            async { Ok(()) }.boxed()
        }
    }
    async fn fixture() -> (
        tempfile::TempDir,
        Arc<Uploader>,
        Arc<ResetProbe>,
        tokio::sync::mpsc::UnboundedReceiver<String>,
        Arc<Mutex<Option<Connection>>>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let db = directory.path().join("history.db");
        Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE catalog(id TEXT);")
            .unwrap();
        let (entered, receive) = tokio::sync::mpsc::unbounded_channel();
        let probe = Arc::new(ResetProbe {
            root: directory.path().into(),
            owner: Mutex::new(Weak::new()),
            entered,
            proceed: tokio::sync::Semaphore::new(0),
            fail: AtomicBool::new(false),
        });
        let uploader = Arc::new(Uploader::new(probe.clone()));
        *probe.owner.lock().unwrap() = Arc::downgrade(&uploader);
        uploader.attach(Install::from_json(
            &json!({"site_url":"https://example.test","directory":directory.path()}),
        ));
        uploader.refresh_background_snapshots().await;
        assert!(uploader
            .background
            .monitor
            .lock()
            .unwrap()
            .database
            .is_some());
        let cache = Arc::new(Mutex::new(Some(
            crate::delivery::open_db_readonly(&db).unwrap(),
        )));
        let close = cache.clone();
        uploader.register_history_reader_cleanup(
            "catalog-test",
            Arc::new(move || {
                close.lock().unwrap().take();
            }),
        );
        (directory, uploader, probe, receive, cache)
    }

    #[tokio::test]
    async fn attachment_change_cannot_release_a_cancelled_workers_external_lease() {
        let (directory, uploader, _probe, _entered, _cache) = fixture().await;
        let reader = uploader.history_reader().await.unwrap();
        let db = directory.path().join("history.db");
        let (opened, ready) = tokio::sync::oneshot::channel();
        let (release, hold) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let _reader = reader;
            let _db = crate::delivery::open_db_readonly(&db).unwrap();
            opened.send(()).unwrap();
            let _ = hold.recv();
        });
        let awaiting = tokio::spawn(async move { worker.await.unwrap() });
        ready.await.unwrap();
        awaiting.abort();
        assert!(awaiting.await.unwrap_err().is_cancelled());
        uploader.attach(None);
        let root = directory.path().to_owned();
        let (acquired, waiting) = std::sync::mpsc::channel();
        let reset = std::thread::spawn(move || {
            let _access = crate::history_access::writer(&root).unwrap();
            std::fs::remove_file(root.join("history.db")).unwrap();
            acquired.send(()).unwrap();
        });
        let start = std::time::Instant::now();
        while !crate::history_access::reset_requested(directory.path()).unwrap() {
            assert!(start.elapsed() < Duration::from_secs(5));
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert!(
            matches!(
                waiting.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            ),
            "attach must not release an operation's independent process lease"
        );
        release.send(()).unwrap();
        tokio::task::spawn_blocking(move || waiting.recv_timeout(Duration::from_secs(5)))
            .await
            .unwrap()
            .unwrap();
        tokio::task::spawn_blocking(move || reset.join().unwrap())
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn public_reset_and_start_recovery_close_readers_and_gate_every_reopen() {
        let (_directory, uploader, probe, mut entered, cache) = fixture().await;
        probe.fail.store(true, Ordering::SeqCst);
        let reset = {
            let uploader = uploader.clone();
            tokio::spawn(async move { uploader.sessions_reset("DELETE ALL SESSIONS").await })
        };
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), entered.recv())
                .await
                .unwrap()
                .unwrap(),
            "reset"
        );
        assert!(cache.lock().unwrap().is_none());
        for _ in 0..3 {
            assert!(!uploader.refresh_background_snapshots().await);
        }
        assert!(uploader
            .background
            .monitor
            .lock()
            .unwrap()
            .database
            .is_none());
        assert!(
            uploader.history_reader().now_or_never().is_none(),
            "reset writer gates other retained cache readers"
        );
        probe.proceed.add_permits(1);
        assert!(reset.await.unwrap().is_err());
        assert!(
            uploader.history_reader().await.is_err(),
            "durable failed plan prevents reopening"
        );
        assert!(!uploader.refresh_background_snapshots().await);
        let start = {
            let uploader = uploader.clone();
            tokio::spawn(async move { uploader.start().await })
        };
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), entered.recv())
                .await
                .unwrap()
                .unwrap(),
            "start"
        );
        assert!(!uploader.refresh_background_snapshots().await);
        probe.proceed.add_permits(1);
        start.await.unwrap().unwrap();
        uploader.refresh_background_snapshots().await;
        assert!(uploader
            .background
            .monitor
            .lock()
            .unwrap()
            .database
            .is_some());
        uploader.attach(None);
        assert!(uploader
            .background
            .monitor
            .lock()
            .unwrap()
            .database
            .is_none());
        assert!(uploader.background.access.lock().unwrap().is_none());
    }

    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    async fn wait_file(path: &Path) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    #[test]
    fn external_reset_child() {
        let Some(root) = std::env::var_os("RELAY_TEST_RESET_ROOT").map(PathBuf::from) else {
            return;
        };
        let _reset = crate::history_access::writer(&root).unwrap();
        std::fs::write(root.join("session-reset-pending.json"), "pending").unwrap();
        std::fs::remove_file(root.join("history.db"))
            .expect("external reset must delete actual SQLite file on Windows too");
        Connection::open(root.join("history.db"))
            .unwrap()
            .execute_batch("CREATE TABLE rebuilt(id TEXT);")
            .unwrap();
        std::fs::write(root.join("external-ready"), "ready").unwrap();
        let began = Instant::now();
        while !root.join("external-release").exists() {
            assert!(began.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(10));
        }
        std::fs::remove_file(root.join("session-reset-pending.json")).unwrap();
    }
    #[tokio::test]
    async fn external_process_intent_releases_all_handles_and_blocks_reopen_until_completion() {
        let (directory, uploader, _probe, _entered, cache) = fixture().await;
        let mut child = Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "relay::uploader::refresh::lifecycle::tests::external_reset_child",
                    "--nocapture",
                ])
                .env("RELAY_TEST_RESET_ROOT", directory.path())
                .spawn()
                .unwrap(),
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            while !uploader.external_reset_requested() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!uploader.refresh_background_snapshots().await);
        wait_file(&directory.path().join("external-ready")).await;
        assert!(cache.lock().unwrap().is_none());
        assert!(uploader
            .background
            .monitor
            .lock()
            .unwrap()
            .database
            .is_none());
        assert!(uploader.background.access.lock().unwrap().is_none());
        assert!(uploader.history_reader().await.is_err());
        assert!(!uploader.refresh_background_snapshots().await);
        std::fs::write(directory.path().join("external-release"), "release").unwrap();
        assert!(child.0.wait().unwrap().success());
        uploader.refresh_background_snapshots().await;
        assert!(uploader
            .background
            .monitor
            .lock()
            .unwrap()
            .database
            .is_some());
    }
    struct Release(Arc<(Mutex<bool>, std::sync::Condvar)>);
    impl Drop for Release {
        fn drop(&mut self) {
            let mut ready = self.0 .0.lock().unwrap();
            *ready = true;
            self.0 .1.notify_all();
        }
    }
    fn blocked(release: &(Mutex<bool>, std::sync::Condvar)) {
        let mut ready = release.0.lock().unwrap();
        while !*ready {
            ready = release.1.wait(ready).unwrap();
        }
    }
    async fn barrier_ready(uploader: &Uploader) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(guard) = uploader.background.lifecycle.clone().try_write_owned() {
                    drop(guard);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn cancelled_monitor_keeps_its_owned_barrier_until_blocking_open_finishes() {
        let (directory, uploader, _probe, _entered, _cache) = fixture().await;
        drop(uploader.suspend_background_readers().await);
        let release = Release(Arc::new((Mutex::new(false), std::sync::Condvar::new())));
        let entered = Arc::new(tokio::sync::Notify::new());
        let (ready, hold) = (entered.clone(), release.0.clone());
        uploader.background.monitor.lock().unwrap().after_open = Some(Arc::new(move || {
            ready.notify_one();
            blocked(&hold);
        }));
        let task = {
            let uploader = uploader.clone();
            tokio::spawn(async move { uploader.refresh_background_snapshots().await })
        };
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(
            uploader
                .background
                .lifecycle
                .clone()
                .try_write_owned()
                .is_err(),
            "cancel cannot release the real blocking worker's lease"
        );
        drop(release);
        barrier_ready(&uploader).await;
        let _reset = uploader.suspend_background_readers().await;
        std::fs::remove_file(directory.path().join("history.db")).unwrap();
    }
    #[tokio::test]
    async fn cancelled_query_can_move_the_owned_reader_lease_into_actual_blocking_work() {
        let (directory, uploader, _probe, _entered, _cache) = fixture().await;
        let reader = uploader.history_reader().await.unwrap();
        let release = Release(Arc::new((Mutex::new(false), std::sync::Condvar::new())));
        let entered = Arc::new(tokio::sync::Notify::new());
        let (ready, hold, db) = (
            entered.clone(),
            release.0.clone(),
            directory.path().join("history.db"),
        );
        let job = tokio::task::spawn_blocking(move || {
            let _reader = reader;
            let _database = crate::delivery::open_db_readonly(&db).unwrap();
            ready.notify_one();
            blocked(&hold);
        });
        let query = tokio::spawn(async move { job.await.unwrap() });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        query.abort();
        assert!(query.await.unwrap_err().is_cancelled());
        assert!(uploader
            .background
            .lifecycle
            .clone()
            .try_write_owned()
            .is_err());
        drop(release);
        barrier_ready(&uploader).await;
        let _reset = uploader.suspend_background_readers().await;
        std::fs::remove_file(directory.path().join("history.db")).unwrap();
    }
}
