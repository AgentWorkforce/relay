//! One invalidation check serves all presentation subscribers. data_version
//! observes commits from legacy writers too, without reopening or validating
//! history. The bounded reconciliation covers non-database inputs (provider
//! login, native sharing configuration) and writers outside this protocol.
use super::*;
use rusqlite::Connection;
use std::path::Path;
use std::time::Instant;

/// Marks a change command: bumps `changes` when it ends, however it ends.
pub(super) struct Changing<'a>(pub(super) &'a AtomicU64);

impl Drop for Changing<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

pub(super) fn session_page(value: &Value, limit: usize) -> Value {
    json!({
        "sharing_mode": value["sharing_mode"].as_str().unwrap_or("selected"),
        "sessions": value["sessions"].as_array().map(|rows| rows.iter().take(limit).cloned().collect::<Vec<_>>()).unwrap_or_default(),
    })
}

mod lifecycle;
pub(super) use lifecycle::history_access_root;
pub use lifecycle::HistoryReader;
pub(super) use lifecycle::State;

const RECONCILE: Duration = Duration::from_secs(60);
const DEMAND_LIFETIME: Duration = Duration::from_secs(35);

/// `status` with the derived fields merged in.
pub fn with_derived(mut status: Value) -> Value {
    let derived = derive(&status);
    if let (Value::Object(object), Value::Object(derived)) = (&mut status, derived) {
        object.extend(derived);
    }
    status
}

#[derive(Default)]
pub(super) struct Background {
    database: Option<Database>,
    attachment: u64,
    #[cfg(test)]
    after_open: Option<Arc<dyn Fn() + Send + Sync>>,
    status: Option<(Token, Instant)>,
    sessions: Option<(Token, usize, Instant)>,
}
struct Database {
    path: PathBuf,
    identity: crate::delivery::DatabaseIdentity,
    conn: Connection,
}

#[derive(Clone, PartialEq, Eq)]
struct Token {
    generation: u64,
    database: i64,
    files: Vec<Value>,
    running: bool,
}

impl Background {
    fn token(
        &mut self,
        directory: &Path,
        generation: u64,
        attachment: u64,
    ) -> anyhow::Result<Token> {
        anyhow::ensure!(attachment == self.attachment, "attachment changed");
        if directory.join("session-reset-pending.json").exists() {
            self.database = None;
            self.status = None;
            self.sessions = None;
            anyhow::bail!("history reset is pending");
        }
        let path = directory.join("history.db");
        let identity = crate::delivery::DatabaseIdentity::read(&path)?;
        if self
            .database
            .as_ref()
            .is_none_or(|db| db.path != path || db.identity != identity)
        {
            // A stale read connection must close before the replacement opens.
            self.database = None;
            self.status = None;
            self.sessions = None;
            let conn = crate::delivery::open_db_readonly(&path)?;
            anyhow::ensure!(
                identity == crate::delivery::DatabaseIdentity::read(&path)?,
                "history changed while opening the monitor"
            );
            #[cfg(test)]
            if let Some(hook) = self.after_open.clone() {
                hook();
            }
            self.database = Some(Database {
                conn,
                path,
                identity,
            });
            // data_version is connection-local, so a new connection invalidates
            // every previous token even if its first version is the same.
            self.status = None;
            self.sessions = None;
        }
        let database = self
            .database
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("history monitor unavailable"))?
            .conn
            .pragma_query_value(None, "data_version", |r| r.get(0))?;
        let mut files: Vec<Value> = [
            "config.json",
            "selected.json",
            "deleted-uploads.json",
            "sharing-change.json",
            "runtime.json",
            "renewal.json",
            "verdict-retry.json",
        ]
        .iter()
        .map(|name| read_small_json(&directory.join(name)))
        .collect();
        let report = read_small_json(&directory.join("cycle.json"));
        // A collector reports elapsed timings and timestamps even when it has
        // done no work. Those are diagnostics, not a catalog/status mutation.
        // Reconciliation still refreshes those diagnostics at most once/minute.
        files.push(json!([
            report["startup_id"],
            report["ok"],
            report["error_class"],
            report["message"],
            report["capture"],
            report["delivery"]
        ]));
        let running = std::fs::read(directory.join("runtime.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value["pid"].as_u64())
            .and_then(|pid| i32::try_from(pid).ok())
            .is_some_and(crate::platform::process::exists);
        Ok(Token {
            generation,
            database,
            files,
            running,
        })
    }
}

fn read_small_json(path: &Path) -> Value {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else {
        return Value::Null;
    };
    let mut bytes = Vec::new();
    if file.take(65_537).read_to_end(&mut bytes).is_err() || bytes.len() > 65_536 {
        return Value::Null;
    }
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn sessions_token(token: &Token) -> Token {
    Token {
        generation: token.generation,
        database: token.database,
        files: token.files.iter().take(4).cloned().collect(),
        running: false,
    }
}

impl Uploader {
    pub async fn refresh_background_snapshots(&self) -> bool {
        self.refresh_background_snapshots_with(&|| {}).await
    }

    /// The quick shared invalidation read does not hold either projection's
    /// helper gate. Each projection coalesces independently while another is slow.
    pub async fn refresh_background_snapshots_with(&self, notify: &(dyn Fn() + Sync)) -> bool {
        if self.external_reset_requested() {
            if let Ok(_reset) = self.background.lifecycle.try_write() {
                self.invalidate_history_readers();
            }
            return false;
        }
        let Ok(local) = self.background.lifecycle.clone().try_read_owned() else {
            return false;
        };
        let attachment = self.revision.load(Ordering::SeqCst);
        let Some(install) = self.install() else {
            self.invalidate_history_readers();
            return false;
        };
        let access = if install
            .directory
            .as_ref()
            .is_some_and(|directory| Path::new(directory).join("history.db").exists())
        {
            match self.retain_history_access() {
                Ok(access) => access,
                Err(_) => return false,
            }
        } else {
            None
        };
        let reader = HistoryReader {
            _local: local,
            _access: access,
        };
        let generation = self.changes.load(Ordering::SeqCst);
        let monitor = self.background.monitor.clone();
        let token = tokio::task::spawn_blocking(move || {
            let token = {
                let mut background = monitor.lock().unwrap_or_else(|e| e.into_inner());
                install.directory.as_ref().and_then(|directory| {
                    background
                        .token(Path::new(directory), generation, attachment)
                        .ok()
                })
            };
            // If the caller was cancelled/dropped, close the last monitor
            // handle before releasing its process-independent access lease.
            drop(monitor);
            (token, reader)
        })
        .await;
        let Ok((token, _reader)) = token else {
            return false;
        };
        // A pending reset must not spawn a helper that reopens history either.
        if self
            .install()
            .and_then(|i| i.directory)
            .is_some_and(|d| Path::new(&d).join("session-reset-pending.json").exists())
        {
            return false;
        }
        let (status, sessions) = tokio::join!(
            self.refresh_background_status(token.clone(), attachment, notify),
            self.refresh_background_sessions(token, attachment, notify),
        );
        status || sessions
    }

    async fn refresh_background_status(
        &self,
        token: Option<Token>,
        attachment: u64,
        notify: &(dyn Fn() + Sync),
    ) -> bool {
        let Ok(_one) = self.background.status.try_lock() else {
            return false;
        };
        let now = Instant::now();
        let due = self
            .background
            .monitor
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status
            .as_ref()
            .is_none_or(|(previous, at)| {
                token.as_ref() != Some(previous) || now.duration_since(*at) >= RECONCILE
            });
        if !due {
            let changed = self.refresh_time_status();
            if changed {
                notify();
            }
            return changed;
        }
        let result = self
            .refresh_status_snapshot()
            .await
            .ok()
            .map(|(changed, _)| changed);
        if let (Some(token), Some(_)) = (token, result) {
            self.acknowledge_background(attachment, |background| {
                background.status = Some((token, now))
            });
        }
        if result == Some(true) {
            notify();
        }
        result.unwrap_or(false)
    }

    /// A stationary queue can cross a retry/stall threshold without a write.
    /// Re-derive those fields on the normal poll without spawning a helper.
    fn refresh_time_status(&self) -> bool {
        let generation = self.changes.load(Ordering::SeqCst);
        let mut slot = self
            .status_snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some((began, previous)) = slot.as_mut() else {
            return false;
        };
        if *began != generation {
            return false;
        }
        let value = with_derived(previous.clone());
        if self.changes.load(Ordering::SeqCst) != generation || *previous == value {
            return false;
        }
        *previous = value;
        true
    }

    async fn refresh_background_sessions(
        &self,
        token: Option<Token>,
        attachment: u64,
        notify: &(dyn Fn() + Sync),
    ) -> bool {
        let Ok(_one) = self.background.sessions.try_lock() else {
            return false;
        };
        let now = Instant::now();
        let demanded = self
            .sessions_demand
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some_and(|at| now.duration_since(at) < DEMAND_LIFETIME);
        if !demanded {
            return false;
        }
        let limit = *self
            .sessions_limit
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let token = token.as_ref().map(sessions_token);
        let due = self
            .background
            .monitor
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .as_ref()
            .is_none_or(|(previous, previous_limit, at)| {
                token.as_ref() != Some(previous)
                    || *previous_limit != limit
                    || now.duration_since(*at) >= RECONCILE
            });
        if !due {
            return false;
        }
        let result = self.refresh_sessions_snapshot().await.ok();
        if let (Some(token), Some(_)) = (token, result) {
            self.acknowledge_background(attachment, |background| {
                background.sessions = Some((token, limit, now))
            });
        }
        if result == Some(true) {
            notify();
        }
        result.unwrap_or(false)
    }

    fn acknowledge_background(&self, attachment: u64, acknowledge: impl FnOnce(&mut Background)) {
        let mut background = self
            .background
            .monitor
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if background.attachment == attachment {
            acknowledge(&mut background);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[derive(Default)]
    struct Probe {
        statuses: AtomicU64,
        sessions: AtomicU64,
        failed: AtomicBool,
        status_value: Mutex<Option<Value>>,
        sessions_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    }
    impl ProbeRunner for Probe {
        fn run(
            &self,
            args: Vec<String>,
            _: Option<Duration>,
        ) -> BoxFuture<'_, Result<Value, UploaderError>> {
            async move {
                if args[0] == "status" {
                    let run = self.statuses.fetch_add(1, Ordering::SeqCst);
                    if self.failed.load(Ordering::SeqCst) { return Err(UploaderError::new("retry")); }
                    if let Some(value) = self.status_value.lock().unwrap().clone() { return Ok(value); }
                    return Ok(json!({"running":true,"run":run}));
                }
                let catalog = args.iter().any(|arg| arg == "--catalog-only");
                if !catalog {
                    self.sessions.fetch_add(1, Ordering::SeqCst);
                    let gate = self.sessions_gate.lock().unwrap().clone();
                    if let Some(gate) = gate {
                        gate.acquire().await.unwrap().forget();
                    }
                }
                Ok(json!({"sessions":[{"source":"codex","session_id":"candidate","status":if catalog {"checking"} else {"uploaded"}}]}))
            }.boxed()
        }
        fn install(&self, _: Vec<String>, _: Option<Secret>) -> Result<InstallRun, UploaderError> {
            Err(UploaderError::new("unused"))
        }
        fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
            async { Ok(()) }.boxed()
        }
    }
    fn fixture() -> (tempfile::TempDir, Uploader, Arc<Probe>, Connection) {
        let directory = tempfile::tempdir().unwrap();
        let conn = Connection::open(directory.path().join("history.db")).unwrap();
        conn.execute_batch("CREATE TABLE catalog(id TEXT);")
            .unwrap();
        let probe = Arc::new(Probe::default());
        let uploader = Uploader::new(probe.clone());
        uploader.attach(Install::from_json(
            &json!({"site_url":"https://example.test", "directory":directory.path()}),
        ));
        (directory, uploader, probe, conn)
    }
    fn counts(probe: &Probe) -> (u64, u64) {
        (
            probe.statuses.load(Ordering::SeqCst),
            probe.sessions.load(Ordering::SeqCst),
        )
    }

    #[tokio::test]
    async fn policy_only_database_swap_republishes_status_without_idle_helper_work() {
        let (directory, uploader, probe, _writer) = fixture();
        let delivery = crate::delivery::open_db(&directory.path().join("history.db")).unwrap();
        let identity = |id: &str| crate::delivery::SessionIdentity {
            source: "codex".into(),
            session_id: id.into(),
        };
        crate::delivery::set_session_excluded(&delivery, &identity("hidden"), true).unwrap();
        let status = || {
            json!({"running":true,"sharing_mode":"all",
            "sessions":{"total":2,"shared":1,"excluded":1},
            "upload_policy_revision":crate::delivery::policy_revision(&delivery).unwrap()})
        };
        *probe.status_value.lock().unwrap() = Some(status());
        let notifications = AtomicU64::new(0);
        let notify = || {
            notifications.fetch_add(1, Ordering::SeqCst);
        };
        assert!(uploader.refresh_background_snapshots_with(&notify).await);
        let before = uploader.cached_status().await.unwrap();
        crate::delivery::set_session_excluded(&delivery, &identity("hidden"), false).unwrap();
        crate::delivery::set_session_excluded(&delivery, &identity("other"), true).unwrap();
        *probe.status_value.lock().unwrap() = Some(status());
        assert!(uploader.refresh_background_snapshots_with(&notify).await);
        let after = uploader.cached_status().await.unwrap();
        assert_eq!(before["sessions"], after["sessions"]);
        assert_eq!(before["sharing_mode"], after["sharing_mode"]);
        assert_ne!(
            before["upload_policy_revision"],
            after["upload_policy_revision"]
        );
        assert_eq!(
            crate::relay::contract::account::UploaderStatus::from_probe(&after)
                .upload_policy_revision,
            Some(crate::delivery::policy_revision(&delivery).unwrap())
        );
        assert_eq!(notifications.load(Ordering::SeqCst), 2);
        for _ in 0..3 {
            assert!(!uploader.refresh_background_snapshots_with(&notify).await);
        }
        assert_eq!(notifications.load(Ordering::SeqCst), 2);
        assert_eq!(
            counts(&probe),
            (2, 0),
            "Unchanged policy must reuse status without querying sessions"
        );
    }

    #[tokio::test]
    async fn unchanged_queue_crosses_stall_threshold_without_another_helper() {
        let (_directory, uploader, probe, _writer) = fixture();
        uploader.refresh_background_snapshots().await;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut value = json!({"running":true,"delivery":{"pending_records":1,
            "bootstrap_complete":true,"last_acknowledged_ms":now-400_000}});
        let old = derive_at(&value, now - 200_000);
        value
            .as_object_mut()
            .unwrap()
            .extend(old.as_object().unwrap().clone());
        assert_eq!(value["stalled"], false);
        let generation = uploader.changes.load(Ordering::SeqCst);
        *uploader.status_snapshot.lock().unwrap() = Some((generation, value));
        assert_eq!(uploader.cached_status().await.unwrap()["stalled"], true);
        let notified = AtomicU64::new(0);
        assert!(
            uploader
                .refresh_background_snapshots_with(&|| {
                    notified.fetch_add(1, Ordering::SeqCst);
                })
                .await
        );
        assert_eq!(notified.load(Ordering::SeqCst), 1);
        assert_eq!(
            counts(&probe),
            (1, 0),
            "time alone must not respawn helpers"
        );
        assert_eq!(
            uploader.status_snapshot.lock().unwrap().as_ref().unwrap().1["stalled"],
            true
        );
    }

    #[tokio::test]
    async fn unchanged_passes_coalesce_and_enrich_only_on_demand() {
        let (directory, uploader, probe, writer) = fixture();
        tokio::join!(
            uploader.refresh_background_snapshots(),
            uploader.refresh_background_snapshots()
        );
        for _ in 0..12 {
            uploader.refresh_background_snapshots().await;
        }
        assert_eq!(
            counts(&probe),
            (1, 0),
            "unchanged idle passes spawn no helper and no catalog enrichment"
        );
        uploader.sessions_list(Some(1)).await.unwrap();
        uploader.refresh_background_snapshots().await;
        assert_eq!(counts(&probe), (1, 1));
        let cycle = directory.path().join("cycle.json");
        std::fs::write(
            &cycle,
            r#"{"at_ms":1,"ok":true,"delivery_metrics":{"drain_ms":10}}"#,
        )
        .unwrap();
        uploader.refresh_background_snapshots().await;
        let before = counts(&probe);
        std::fs::write(
            &cycle,
            r#"{"at_ms":2,"ok":true,"delivery_metrics":{"drain_ms":50}}"#,
        )
        .unwrap();
        for _ in 0..10 {
            uploader.refresh_background_snapshots().await;
        }
        assert_eq!(
            counts(&probe),
            before,
            "cycle timestamps/durations invalidate neither status nor sessions"
        );
        writer
            .execute_batch("BEGIN; INSERT INTO catalog VALUES('rolled back'); ROLLBACK;")
            .unwrap();
        uploader.refresh_background_snapshots().await;
        assert_eq!(counts(&probe), before);
        writer
            .execute("INSERT INTO catalog VALUES('changed candidate')", [])
            .unwrap();
        uploader.refresh_background_snapshots().await;
        assert_eq!(
            counts(&probe),
            (before.0 + 1, before.1 + 1),
            "external writer commit invalidates status and active session subscribers"
        );
        *uploader
            .sessions_demand
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() - DEMAND_LIFETIME);
        writer
            .execute("INSERT INTO catalog VALUES('background capture')", [])
            .unwrap();
        uploader.refresh_background_snapshots().await;
        assert_eq!(
            counts(&probe),
            (before.0 + 2, before.1 + 1),
            "presentation-only enrichment stops when demand expires"
        );
    }

    #[tokio::test]
    async fn failures_retry_and_reconciliation_and_replacement_invalidate() {
        let (directory, uploader, probe, writer) = fixture();
        probe.failed.store(true, Ordering::SeqCst);
        uploader.refresh_background_snapshots().await;
        probe.failed.store(false, Ordering::SeqCst);
        uploader.refresh_background_snapshots().await;
        assert_eq!(counts(&probe), (2, 0));
        uploader.refresh_background_snapshots().await;
        assert_eq!(counts(&probe), (2, 0));
        {
            let mut gate = uploader.background.monitor.lock().unwrap();
            gate.status.as_mut().unwrap().1 = Instant::now() - RECONCILE;
        }
        uploader.refresh_background_snapshots().await;
        assert_eq!(
            counts(&probe),
            (3, 0),
            "bounded reconciliation catches non-database inputs"
        );
        drop(writer);
        let replacement = directory.path().join("replacement.db");
        let conn = Connection::open(&replacement).unwrap();
        conn.execute_batch("CREATE TABLE replacement(id TEXT);")
            .unwrap();
        drop(conn);
        let reset = uploader.suspend_background_readers().await;
        std::fs::rename(replacement, directory.path().join("history.db")).unwrap();
        drop(reset);
        uploader.refresh_background_snapshots().await;
        assert_eq!(
            counts(&probe),
            (4, 0),
            "replacement's initial data_version cannot reuse the old token"
        );
    }

    #[tokio::test]
    async fn status_notifies_subscribers_before_blocked_session_enrichment_completes() {
        let (_directory, uploader, probe, _writer) = fixture();
        uploader.sessions_list(Some(1)).await.unwrap();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *probe.sessions_gate.lock().unwrap() = Some(gate.clone());
        let notifications = AtomicU64::new(0);
        let notify = || {
            notifications.fetch_add(1, Ordering::SeqCst);
        };
        let (_, ()) = tokio::join!(uploader.refresh_background_snapshots_with(&notify), async {
            tokio::time::timeout(Duration::from_secs(3), async {
                while notifications.load(Ordering::SeqCst) == 0
                    || probe.sessions.load(Ordering::SeqCst) == 0
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("status invalidation must not wait for the session helper");
            assert_eq!(notifications.load(Ordering::SeqCst), 1);
            gate.add_permits(1);
        },);
        assert_eq!(notifications.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_second_status_refresh_runs_while_the_first_session_helper_is_still_held() {
        let (_directory, uploader, probe, writer) = fixture();
        uploader.sessions_list(Some(1)).await.unwrap();
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        *probe.sessions_gate.lock().unwrap() = Some(gate.clone());
        let notifications = AtomicU64::new(0);
        let notify = || {
            notifications.fetch_add(1, Ordering::SeqCst);
        };
        tokio::join!(uploader.refresh_background_snapshots_with(&notify), async {
            tokio::time::timeout(Duration::from_secs(3), async {
                while notifications.load(Ordering::SeqCst) < 1
                    || probe.sessions.load(Ordering::SeqCst) < 1
                {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            writer
                .execute("INSERT INTO catalog VALUES('second status mutation')", [])
                .unwrap();
            tokio::time::timeout(
                Duration::from_secs(3),
                uploader.refresh_background_snapshots_with(&notify),
            )
            .await
            .expect("another status must not wait for the held session projection");
            assert_eq!(probe.statuses.load(Ordering::SeqCst), 2);
            assert_eq!(
                probe.sessions.load(Ordering::SeqCst),
                1,
                "no duplicate enrichment is queued"
            );
            assert_eq!(notifications.load(Ordering::SeqCst), 2);
            gate.add_permits(1);
        });
    }
}
