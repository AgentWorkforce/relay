//! Controlled helper protocol boundary over real delivery state. The first
//! response reads a queued badge, then a separate writer leases its batch
//! before returning. No scheduler timing or simulated database counter.
use super::*;
use crate::delivery::{self, SessionIdentity};
use crate::relay::contract::account::UploadShareStatus;
use rusqlite::Connection;

struct DeliveryProbe {
    home: PathBuf,
    path: PathBuf,
    job: String,
    upload: UploadSession,
    observation: Option<ExecutionObservation>,
    calls: AtomicU64,
    commit_versions: Mutex<Option<(u64, u64)>>,
    before_commit: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl ProbeRunner for DeliveryProbe {
    fn history_access_root(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }

    fn run(
        &self,
        args: Vec<String>,
        _: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        async move {
            assert!(args
                .windows(2)
                .any(|pair| pair[0] == "--key" && pair[1] == "codex:rw_000000"));
            let conn = delivery::open_db_readonly(&self.path).unwrap();
            let version = || {
                conn.query_row("PRAGMA data_version", [], |row| row.get::<_, u64>(0))
                    .unwrap()
            };
            let before = version();
            let identity = SessionIdentity {
                source: "codex".into(),
                session_id: "rw_000000".into(),
            };
            let pending =
                delivery::pending_sessions(&conn, &self.job, std::slice::from_ref(&identity))
                    .unwrap();
            let mut upload = self.upload.clone();
            upload.status = if pending[&identity] {
                UploadShareStatus::Uploading
            } else {
                UploadShareStatus::Queued
            };
            let reply = serde_json::to_value(ObservedSession {
                session: upload,
                observation: self.observation.clone(),
            })
            .unwrap();
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.before_commit.lock().unwrap().take().unwrap()();
                let writer = Connection::open(&self.path).unwrap();
                assert_eq!(
                    writer
                        .execute(
                            "UPDATE delivery_batches SET state='leased' WHERE id='badge-race'",
                            []
                        )
                        .unwrap(),
                    1
                );
                let after = version();
                assert_ne!(
                    before, after,
                    "the real external commit must advance data_version"
                );
                *self.commit_versions.lock().unwrap() = Some((before, after));
            }
            Ok(json!({"sessions":[reply]}))
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

async fn delivery_commit_during_enrichment(changed_observation: bool) {
    let f = fixture();
    let job: String =
        f.db.query_row("SELECT id FROM delivery_jobs", [], |row| row.get(0))
            .unwrap();
    f.db.execute(
        "INSERT INTO delivery_batches(id,job_id,state,payload,records,bytes,journal_end,created_ms) VALUES('badge-race',?,'pending',?,1,80,1,10)",
        rusqlite::params![job, r#"{"records":[{"source":"codex","session_id":"rw_000000"}]}"#],
    ).unwrap();
    let request = SessionQueryParams {
        query: "id:rw_000000".into(),
        sort: "model".into(),
        ascending: true,
        ..Default::default()
    };
    let upload = f.catalog.index.candidates(&request).unwrap().rows[0]
        .upload
        .clone()
        .unwrap();
    let probe = Arc::new(DeliveryProbe {
        home: f.home.path().to_owned(),
        path: f.path.clone(),
        job,
        upload,
        observation: changed_observation.then(|| f.observation(0, "z-current", Some("low")).1),
        calls: AtomicU64::new(0),
        commit_versions: Mutex::new(None),
        before_commit: Mutex::new(None),
    });
    let uploader = Uploader::new(probe.clone());
    uploader.attach(Install::from_json(
        &json!({"site_url":"https://fixture.test","directory":f.path.parent().unwrap()}),
    ));
    let initial_revision = Arc::new(AtomicU64::new(0));
    let recorded = initial_revision.clone();
    let index = uploader.query_index.clone();
    *probe.before_commit.lock().unwrap() = Some(Box::new(move || {
        recorded.store(
            index.lock().unwrap().as_ref().unwrap().2.index.revision(),
            Ordering::SeqCst,
        );
    }));
    let head = f.store.head_revision().unwrap();
    let first = query(&uploader, &f, request.clone()).await.unwrap();
    assert_eq!(first.sessions.len(), 1);
    assert_eq!(first.sessions[0].status, UploadShareStatus::Queued);
    assert_ne!(first.revision, 0);
    assert_eq!(
        f.store.head_revision().unwrap(),
        head,
        "delivery-only writes leave the SDK catalog unchanged"
    );
    assert!(probe.commit_versions.lock().unwrap().is_some());
    let after_revision = uploader
        .query_index
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .2
        .index
        .revision();
    assert_eq!(
        after_revision,
        initial_revision.load(Ordering::SeqCst) + u64::from(changed_observation)
    );
    if changed_observation {
        assert_eq!(first.sessions[0].models.as_ref().unwrap(), &["z-current"]);
        assert_eq!(first.sessions[0].reasoning_effort.as_deref(), Some("low"));
    }
    let mut refresh = request;
    refresh.known_revision = Some(first.revision);
    let current = query(&uploader, &f, refresh.clone()).await.unwrap();
    assert!(
        !current.unchanged,
        "a commit after the badge read must invalidate that badge's revision"
    );
    assert_eq!(probe.calls.load(Ordering::SeqCst), 2);
    assert_eq!(current.sessions[0].status, UploadShareStatus::Uploading);
    assert_ne!(current.revision, 0);
    assert_ne!(current.revision, first.revision);
    assert_eq!(
        uploader
            .query_index
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .2
            .index
            .revision(),
        after_revision
    );
    refresh.known_revision = Some(current.revision);
    assert!(query(&uploader, &f, refresh).await.unwrap().unchanged);
    assert_eq!(
        probe.calls.load(Ordering::SeqCst),
        2,
        "the settled revision must still shortcut before the helper"
    );
}

#[tokio::test]
async fn delivery_commit_after_badge_read_cannot_certify_old_badges_without_observations() {
    delivery_commit_during_enrichment(false).await;
}

#[tokio::test]
async fn delivery_commit_after_badge_read_cannot_certify_old_badges_after_model_reselection() {
    delivery_commit_during_enrichment(true).await;
}
