use super::*;
use crate::relay::session_query::test_catalog::{fixture, Fixture};

mod upload_revision;

struct Probe {
    home: PathBuf,
    calls: AtomicU64,
    reply: Mutex<Value>,
}

impl ProbeRunner for Probe {
    fn history_access_root(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
    fn run(
        &self,
        args: Vec<String>,
        _: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        async move {
            assert!(args.iter().any(|arg| arg == "--key"));
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.reply.lock().unwrap().clone())
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

fn probe(f: &Fixture, observations: &[(usize, &str, Option<&str>)]) -> Arc<Probe> {
    let request = SessionQueryParams::default();
    let initial = f.catalog.index.candidates(&request).unwrap();
    let sessions: Vec<_> = initial
        .rows
        .iter()
        .filter_map(|row| row.upload.clone())
        .map(|mut upload| {
            upload.status = crate::relay::contract::account::UploadShareStatus::Uploaded;
            let observation = observations
                .iter()
                .find(|(id, _, _)| upload.session_id == format!("rw_{id:06}"))
                .map(|(id, m, e)| f.observation(*id, m, *e).1);
            serde_json::to_value(ObservedSession {
                session: upload,
                observation,
            })
            .unwrap()
        })
        .collect();
    Arc::new(Probe {
        home: f.home.path().to_owned(),
        calls: AtomicU64::new(0),
        reply: Mutex::new(json!({"sessions":sessions})),
    })
}

fn attached(f: &Fixture, probe: Arc<Probe>) -> Uploader {
    let uploader = Uploader::new(probe);
    uploader.attach(Install::from_json(
        &json!({"site_url":"https://fixture.test","directory":f.path.parent().unwrap()}),
    ));
    uploader
}

async fn query(
    uploader: &Uploader,
    f: &Fixture,
    request: SessionQueryParams,
) -> Result<crate::relay::contract::account::SessionQueryPage, RpcError> {
    let names = crate::relay::project::Names::new(f.relay_home.clone());
    uploader
        .sessions_query(
            request,
            vec![],
            Arc::default(),
            f.home.path().to_owned(),
            f.relay_home.clone(),
            &names,
        )
        .await
}

#[tokio::test]
async fn production_query_uses_one_batch_reselects_once_and_keeps_unobserved_rows_conservative() {
    let f = fixture();
    let probe = probe(&f, &[(0, "z-current", Some("low"))]);
    // The exact-key helper returns only the initial candidate, even if this
    // fixture's stored response has rows for every catalog identity.
    let first = probe.reply.lock().unwrap()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["session_id"] == "rw_000000")
        .unwrap()
        .clone();
    *probe.reply.lock().unwrap() = json!({"sessions":[first]});
    let uploader = attached(&f, probe.clone());
    let result = query(
        &uploader,
        &f,
        SessionQueryParams {
            sort: "model".into(),
            ascending: true,
            limit: Some(1),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
    assert_eq!(result.sessions[0].session_id, "rw_000001");
    assert_eq!(result.sessions[0].models.as_ref().unwrap(), &["b-model"]);
    assert_eq!(result.sessions[0].reasoning_effort, None);
    assert_eq!(
        result.sessions[0].status,
        crate::relay::contract::account::UploadShareStatus::Checking
    );
    assert_eq!(result.revision, 0);
    let public = serde_json::to_string(&result).unwrap();
    assert!(!public.contains("_query_execution"));
    assert!(!public.contains("source_fingerprint"));
}

#[tokio::test]
async fn known_revision_skips_the_helper_after_the_observed_pair_is_indexed() {
    let f = fixture();
    let probe = probe(&f, &[(0, "z-current", Some("low"))]);
    let uploader = attached(&f, probe.clone());
    let mut request = SessionQueryParams {
        sort: "model".into(),
        ascending: true,
        ..Default::default()
    };
    let first = query(&uploader, &f, request.clone()).await.unwrap();
    assert_ne!(first.revision, 0);
    let current = first
        .sessions
        .iter()
        .find(|row| row.session_id == "rw_000000")
        .unwrap();
    assert_eq!(current.models.as_ref().unwrap(), &["z-current"]);
    assert_eq!(current.reasoning_effort.as_deref(), Some("low"));
    request.known_revision = Some(first.revision);
    let same = query(&uploader, &f, request).await.unwrap();
    assert!(same.unchanged);
    assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retained_query_discards_the_entire_execution_batch_without_writing_or_reselecting() {
    let f = fixture();
    let probe = probe(
        &f,
        &[(0, "a-old", Some("high")), (1, "b-model", Some("high"))],
    );
    let uploader = attached(&f, probe.clone());
    // Warm both pairs through the actual fresh-query path.
    query(&uploader, &f, SessionQueryParams::default())
        .await
        .unwrap();
    let mut request = SessionQueryParams {
        sort: "model".into(),
        ascending: true,
        limit: Some(1),
        ..Default::default()
    };
    let first = query(&uploader, &f, request.clone()).await.unwrap();
    request.cursor = first.next_cursor;
    let revision = uploader
        .query_index
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .2
        .index
        .revision();
    {
        let mut reply = probe.reply.lock().unwrap();
        let row = reply["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["session_id"] == "rw_000001")
            .unwrap()
            .clone();
        let mut observed: ObservedSession<UploadSession> = serde_json::from_value(row).unwrap();
        observed.observation.as_mut().unwrap().model = "z-later".into();
        observed.observation.as_mut().unwrap().reasoning_effort = Some("low".into());
        observed.session.models = Some(vec!["z-later".into()]);
        observed.session.reasoning_effort = Some("low".into());
        *reply = json!({"sessions":[serde_json::to_value(observed).unwrap()]});
    }
    let retained = query(&uploader, &f, request).await.unwrap();
    assert_eq!(retained.sessions[0].session_id, "rw_000001");
    assert_eq!(retained.sessions[0].models.as_ref().unwrap(), &["b-model"]);
    assert_eq!(
        retained.sessions[0].reasoning_effort.as_deref(),
        Some("high")
    );
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
        revision
    );
    assert_eq!(probe.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn failed_second_pair_discards_the_index_instead_of_reusing_a_partially_applied_batch() {
    let f = fixture();
    f.fail_second_observation();
    let probe = probe(&f, &[]);
    let uploader = attached(&f, probe);
    let request = SessionQueryParams::default();
    let version = f.catalog.version(&request, 1).unwrap();
    let initial = f.catalog.index.candidates(&request).unwrap();
    let observations = vec![
        f.observation(0, "z-first", Some("low")),
        f.observation(1, "y-second", Some("high")),
    ];
    let path = f.path.clone();
    *uploader.query_index.lock().unwrap() = Some((path.clone(), 0, f.catalog));
    let reader = uploader.query_reader().await.unwrap();
    assert!(uploader
        .observed_snapshot(&request, initial, observations, path, version, reader)
        .await
        .is_err());
    assert!(uploader.query_index.lock().unwrap().is_none());
}

#[test]
fn private_decoder_rejects_fallback_and_duplicate_or_unexpected_identities() {
    let f = fixture();
    let probe = probe(&f, &[(0, "positive", Some("low"))]);
    let answer = probe.reply.lock().unwrap().clone();
    let rows = answer["sessions"].as_array().unwrap();
    let positive = rows
        .iter()
        .find(|row| row["session_id"] == "rw_000000")
        .unwrap()
        .clone();
    let mut fallback = positive.clone();
    fallback.as_object_mut().unwrap().remove("_query_execution");
    fallback["reasoning_effort"] = json!("high");
    let allowed = ["codex:rw_000000".to_owned()];
    assert!(decode(json!({"sessions":[fallback]}), &allowed)
        .unwrap()
        .observations
        .is_empty());
    assert!(
        decode(json!({"sessions":[positive.clone(),positive]}), &allowed)
            .unwrap()
            .uploads
            .is_empty()
    );
    assert!(decode(answer, &["codex:unrequested".into()])
        .unwrap()
        .uploads
        .is_empty());
}

#[tokio::test]
async fn a_stale_async_snapshot_preserves_the_newer_index_instead_of_discarding_it() {
    let mut f = fixture();
    let probe = probe(&f, &[]);
    let uploader = attached(&f, probe);
    let request = SessionQueryParams::default();
    let old_version = f.catalog.version(&request, 1).unwrap();
    let old = f.catalog.index.candidates(&request).unwrap();
    let newer = f.observation(0, "newer", Some("high"));
    let version = f.catalog.version(&request, 1).unwrap();
    let initial = f.catalog.index.candidates(&request).unwrap();
    f.catalog
        .observed_snapshot(&request, initial, &[newer], version)
        .unwrap();
    let stale = f.observation(0, "older", Some("low"));
    let path = f.path.clone();
    *uploader.query_index.lock().unwrap() = Some((path.clone(), 0, f.catalog));
    let reader = uploader.query_reader().await.unwrap();
    assert!(uploader
        .observed_snapshot(&request, old, vec![stale], path, old_version, reader)
        .await
        .is_err());
    let slot = uploader.query_index.lock().unwrap();
    let current = &slot
        .as_ref()
        .expect("a stale continuation must not discard a newer cache")
        .2;
    let row = current
        .index
        .candidates(&request)
        .unwrap()
        .rows
        .into_iter()
        .find(|row| row.key() == "codex:rw_000000")
        .unwrap()
        .upload
        .unwrap();
    assert_eq!(row.models.unwrap(), ["newer"]);
    assert_eq!(row.reasoning_effort.as_deref(), Some("high"));
}

#[tokio::test]
async fn a_cancelled_observation_continuation_holds_the_reader_until_real_index_work_exits() {
    use std::future::Future;
    let f = fixture();
    let probe = probe(&f, &[]);
    let uploader = Arc::new(attached(&f, probe));
    let request = SessionQueryParams::default();
    let version = f.catalog.version(&request, 1).unwrap();
    let initial = f.catalog.index.candidates(&request).unwrap();
    let observations = vec![f.observation(0, "current", Some("low"))];
    let path = f.path.clone();
    *uploader.query_index.lock().unwrap() = Some((path.clone(), 0, f.catalog));
    // Isolate the real lifecycle barrier from the query reader's additional
    // synchronous cache cleanup, which intentionally takes this held mutex.
    let reader = Arc::new(uploader.history_reader().await.unwrap());
    let locked_slot = uploader.query_index.clone();
    let (locked, lock_ready) = tokio::sync::oneshot::channel();
    let (release, hold) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _held = locked_slot.lock().unwrap();
        let _ = locked.send(());
        let _ = hold.recv();
    });
    lock_ready.await.unwrap();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let running = uploader.clone();
    let awaiting = tokio::spawn(async move {
        let mut future = Box::pin(running.observed_snapshot(
            &request,
            initial,
            observations,
            path,
            version,
            reader,
        ));
        let mut entered = Some(entered);
        futures_util::future::poll_fn(move |cx| {
            let result = future.as_mut().poll(cx);
            if let Some(entered) = entered.take() {
                let _ = entered.send(result.is_pending());
            }
            result
        })
        .await
    });
    assert!(
        waiting.await.unwrap(),
        "the production blocking continuation must have been queued behind the held index"
    );
    awaiting.abort();
    assert!(matches!(awaiting.await, Err(error) if error.is_cancelled()));
    let (attempted, attempt) = tokio::sync::oneshot::channel();
    let resetting = uploader.clone();
    let reset = tokio::spawn(async move {
        let mut future = Box::pin(resetting.suspend_background_readers());
        let mut attempted = Some(attempted);
        futures_util::future::poll_fn(move |cx| {
            let result = future.as_mut().poll(cx);
            if let Some(attempted) = attempted.take() {
                let _ = attempted.send(result.is_pending());
            }
            result
        })
        .await
    });
    assert!(attempt.await.unwrap());
    assert!(tokio::time::timeout(Duration::from_millis(25), async {
        while !reset.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_err());
    release.send(()).unwrap();
    holder.join().unwrap();
    let _writer = tokio::time::timeout(Duration::from_secs(5), reset)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_settled_retry_snapshot_does_not_strand_a_later_first_page_model_observation() {
    for carry_retained_revision in [false, true] {
        let f = fixture();
        let probe = probe(
            &f,
            &[
                (0, "z-current", Some("low")),
                (1, "s-current", Some("high")),
            ],
        );
        let rows = probe.reply.lock().unwrap()["sessions"]
            .as_array()
            .unwrap()
            .clone();
        let row = |id: &str| {
            rows.iter()
                .find(|row| row["session_id"] == id)
                .unwrap()
                .clone()
        };
        *probe.reply.lock().unwrap() = json!({"sessions":[row("rw_000000")]});
        let uploader = attached(&f, probe.clone());
        let mut request = SessionQueryParams {
            query: "upload:uploaded".into(),
            sort: "model".into(),
            ascending: true,
            limit: Some(1),
            ..Default::default()
        };
        let first = query(&uploader, &f, request.clone()).await.unwrap();
        assert!(first.verification_pending);
        assert!(first.sessions.is_empty());
        assert_eq!(first.revision, 0);
        // Both clients' Retry page action installs this cursor and clears
        // known_revision. Its returned model/effort remain the pinned pair.
        request.cursor = first.next_cursor;
        request.known_revision = None;
        *probe.reply.lock().unwrap() = json!({"sessions":[row("rw_000001")]});
        let settled = query(&uploader, &f, request.clone()).await.unwrap();
        assert!(!settled.verification_pending);
        assert_ne!(settled.revision, 0);
        assert_eq!(settled.sessions[0].models.as_ref().unwrap(), &["b-model"]);
        assert_eq!(settled.sessions[0].reasoning_effort, None);
        request.known_revision = Some(settled.revision);
        assert!(
            query(&uploader, &f, request.clone())
                .await
                .unwrap()
                .unchanged
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 2);
        // First page clears both values in current clients. Even a caller
        // carrying the retained revision cannot match a no-cursor version.
        request.cursor = None;
        request.known_revision = carry_retained_revision.then_some(settled.revision);
        assert!(!query(&uploader, &f, request).await.unwrap().unchanged);
        assert_eq!(probe.calls.load(Ordering::SeqCst), 3);
        let slot = uploader.query_index.lock().unwrap();
        let current = slot
            .as_ref()
            .unwrap()
            .2
            .index
            .candidates(&SessionQueryParams::default())
            .unwrap();
        let b = current
            .rows
            .iter()
            .find(|row| row.key() == "codex:rw_000001")
            .unwrap()
            .upload
            .as_ref()
            .unwrap();
        assert_eq!(b.models.as_ref().unwrap(), &["s-current"]);
        assert_eq!(b.reasoning_effort.as_deref(), Some("high"));
    }
}
