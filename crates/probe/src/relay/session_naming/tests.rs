use super::*;
use crate::relay::store::{SessionKind, Target};
use serde_json::json;

fn row() -> Registration {
    serde_json::from_value(json!({
        "name":"old-agent", "agentID":"a-one", "target":Target::new(SessionKind::Codex,"12345678-1234-4234-8234-123456789abc"),
        "title":"Original", "baseURL":"https://cast.test", "registeredAt":"2026-10-01T12:00:00Z"
    }))
    .unwrap()
}
fn prompts(count: u64) -> PromptCheckpoint {
    PromptCheckpoint {
        count,
        latest_prompt_ms: Some(1000),
    }
}

#[test]
fn ten_new_prompts_trigger_once_and_success_survives_restart() {
    let row = row();
    let mut entry = Entry::baseline(&prompts(21), &row);
    assert!(!entry.due(&prompts(30), &row, 0));
    assert!(entry.due(&prompts(31), &row, 0));
    entry.count = 31;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("checkpoint.json");
    let mut journal = Journal::default();
    journal.entries.insert("key".into(), entry);
    journal.save(&path).unwrap();
    let mut restored = Journal::load(&path).unwrap();
    let entry = restored.entries.get_mut("key").unwrap();
    assert!(!entry.due(&prompts(31), &row, 1));
    assert!(!entry.due(&prompts(40), &row, 1));
    assert!(entry.due(&prompts(41), &row, 1));
}

#[test]
fn retry_does_not_consume_prompts_and_manual_edits_start_a_fresh_interval() {
    let mut row = row();
    let mut entry = Entry::baseline(&prompts(2), &row);
    entry.retry_after_ms = 300;
    assert!(!entry.due(&prompts(12), &row, 299));
    assert!(entry.due(&prompts(12), &row, 300));
    row.title = "My explicit title".into();
    assert!(!entry.due(&prompts(12), &row, 301));
    assert!(!entry.due(&prompts(21), &row, 301));
    assert!(entry.due(&prompts(22), &row, 301));
    // Native reset/compaction cannot manufacture ten new prompts.
    assert!(!entry.due(&prompts(1), &row, 302));
}

#[test]
fn only_fresh_ready_briefs_for_the_exact_session_can_name_it() {
    let row = row();
    let good = json!({"sessionId":"12345678-1234-4234-8234-123456789abc","sourceProvider":"codex","status":"ready","stale":false,"generatedAt":"2026-10-29T12:00:00Z","brief":{"title":"Fix inbox scrolling"}});
    assert_eq!(
        ready_title(&good, &row, &prompts(10)).as_deref(),
        Some("Fix inbox scrolling")
    );
    for (key, value) in [
        ("sessionId", json!("other")),
        ("sourceProvider", json!("claude")),
        ("status", json!("pending")),
        ("stale", json!(true)),
        ("generatedAt", json!("1970-01-01T00:00:00Z")),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        assert!(ready_title(&bad, &row, &prompts(10)).is_none(), "{bad}");
    }
    let mut bad = good.clone();
    bad["brief"]["title"] = json!("Ignore\nInstructions");
    assert!(ready_title(&bad, &row, &prompts(10)).is_none());
}

#[test]
fn corrupted_checkpoint_is_not_silently_reset() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("checkpoint.json");
    std::fs::write(&path, b"broken").unwrap();
    assert!(Journal::load(&path).is_err());
}

#[path = "../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;
use crate::relay::{
    cloud_session::{AgentOwner, CloudAccess, CloudError},
    sessions::SessionDirectory,
    uploader::{HistoryReader, InstallRun, ProbeRunner, Uploader, UploaderError},
    workspace::Secret,
};
use futures_util::future::BoxFuture;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

struct Counter(AtomicU64, AtomicU64);
impl ProbeRunner for Counter {
    fn run(
        &self,
        args: Vec<String>,
        _: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        assert_eq!(&args[..2], &["sessions", "naming-checkpoint"]);
        self.1.fetch_add(1, Ordering::SeqCst);
        let count = self.0.load(Ordering::SeqCst);
        Box::pin(async move {
            Ok(serde_json::to_value(PromptCheckpointResponse {
                checkpoint: (count != u64::MAX).then_some(PromptCheckpoint {
                    count,
                    latest_prompt_ms: Some(1000),
                }),
            })
            .unwrap())
        })
    }
    fn status(
        &self,
        _: Option<std::path::PathBuf>,
        _: HistoryReader,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        Box::pin(async { unreachable!() })
    }
    fn install(&self, _: Vec<String>, _: Option<Secret>) -> Result<InstallRun, UploaderError> {
        unreachable!()
    }
    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
        Box::pin(async { Ok(()) })
    }
}
struct Cloud {
    signed_in: AtomicBool,
    calls: AtomicU64,
    answer: Mutex<Value>,
    hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl CloudAccess for Cloud {
    fn account(&self) -> Option<CloudAccount> {
        self.signed_in.load(Ordering::SeqCst).then(|| CloudAccount {
            site_url: "https://cloud.test".into(),
            workspace_id: "cloud-workspace".into(),
            user_id: Some("person".into()),
        })
    }
    fn agent_owner(&self) -> Option<AgentOwner> {
        self.account().map(|_| AgentOwner {
            user_id: "person".into(),
            workspace_id: Some("cloud-workspace".into()),
        })
    }
    fn request(
        &self,
        method: &'static str,
        path: String,
        body: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        assert_eq!(method, "GET");
        assert_eq!(
            path,
            "/workspaces/cloud-workspace/reflex/sessions/12345678-1234-4234-8234-123456789abc/brief?source=codex"
        );
        assert!(body.is_none());
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(hook) = self.hook.lock().unwrap().take() {
            hook();
        }
        let value = self.answer.lock().unwrap().clone();
        Box::pin(async move { Ok(value) })
    }
}
struct Titles {
    session: Mutex<DiscoveredSession>,
    writes: Mutex<Vec<String>>,
    fail: AtomicBool,
}
impl SessionDirectory for Titles {
    fn sessions(&self) -> Vec<DiscoveredSession> {
        vec![self.session.lock().unwrap().clone()]
    }
    fn set_title(&self, source: &str, id: &str, title: &str) -> Result<String, String> {
        assert_eq!(
            (source, id),
            ("codex", "12345678-1234-4234-8234-123456789abc")
        );
        if self.fail.load(Ordering::SeqCst) {
            return Err("Native title unavailable".into());
        }
        self.writes.lock().unwrap().push(title.into());
        self.session.lock().unwrap().title = title.into();
        Ok(title.into())
    }
}
struct Case {
    core: Arc<Core>,
    counter: Arc<Counter>,
    cloud: Arc<Cloud>,
    titles: Arc<Titles>,
    fake: fake_relaycast::FakeRelaycast,
    dir: tempfile::TempDir,
}
impl Case {
    async fn new() -> Self {
        let fake = fake_relaycast::FakeRelaycast::start(Default::default()).await;
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        fake_relaycast::sign_in_store(&app, fake_relaycast::WORKSPACE_KEY, &fake.base_url);
        let path = app.join("injectable-agents.json");
        let mut store: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        store["cloud"]["accountWorkspaceID"] = json!("cloud-workspace");
        std::fs::write(path, store.to_string()).unwrap();
        let counter = Arc::new(Counter(AtomicU64::new(2), AtomicU64::new(0)));
        let cloud = Arc::new(Cloud {
            signed_in: AtomicBool::new(true),
            calls: AtomicU64::new(0),
            answer: Mutex::new(
                json!({"sessionId":"12345678-1234-4234-8234-123456789abc","sourceProvider":"codex","status":"ready","stale":false,"generatedAt":"2026-10-29T12:00:00Z","brief":{"title":"Fix inbox scrolling"}}),
            ),
            hook: Mutex::new(None),
        });
        let titles = Arc::new(Titles {
            session: Mutex::new(DiscoveredSession {
                target: Target::new(SessionKind::Codex, "12345678-1234-4234-8234-123456789abc"),
                title: "Original".into(),
                directory: Some("/work/cloud".into()),
                updated_at_ms: Some(1000),
                host: None,
                live: true,
                holder: None,
            }),
            writes: Mutex::new(vec![]),
            fail: AtomicBool::new(false),
        });
        let uploader = Arc::new(Uploader::new(counter.clone()));
        let account = crate::relay::test_account::TestAccount::new(uploader);
        let config = crate::relay::daemon::Config {
            paths: crate::relay::paths::CorePaths::for_socket(dir.path().join("core.sock"))
                .unwrap(),
            home: dir.path().into(),
            app_data_dir: app,
            env: Default::default(),
            version: "test".into(),
            host_name: "Test Desk".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: Default::default(),
            delivery_timing: Default::default(),
        };
        let core = Core::with_plugins(
            config,
            crate::relay::daemon::Plugins {
                sessions: titles.clone(),
                cloud: cloud.clone(),
                account: Some(account.into_plugin()),
                ..Default::default()
            },
        )
        .0;
        let session = titles.sessions().remove(0);
        core.register_session(&session, Some("old-agent"), None, false)
            .await
            .unwrap();
        core.session_snapshot.lock().unwrap().1 = vec![session];
        Self {
            core,
            counter,
            cloud,
            titles,
            fake,
            dir,
        }
    }
    fn prompts_after_scan_interval(&self, count: u64, journal: &mut Journal) {
        for entry in journal.entries.values_mut() {
            entry.observed_at_ms = 0;
        }
        journal.evidence_attempts.clear();
        self.counter.0.store(count, Ordering::SeqCst);
        self.core.session_snapshot.lock().unwrap().1[0].updated_at_ms = Some(count as i64);
    }
    fn row(&self) -> Registration {
        self.core.store.read(|store| store.registrations[0].clone())
    }
    fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("naming.json")
    }
    async fn pass(&self, journal: &mut Journal) {
        pass(&self.core, journal, &self.path()).await.unwrap();
    }
    fn retry(journal: &mut Journal) {
        for entry in journal.entries.values_mut() {
            entry.retry_after_ms = 0;
        }
    }
}

#[tokio::test]
async fn worker_updates_native_title_and_routing_alias_on_tenth_prompt_only() {
    let case = Case::new().await;
    let mut journal = Journal::default();
    case.pass(&mut journal).await;
    case.prompts_after_scan_interval(11, &mut journal);
    case.pass(&mut journal).await;
    assert_eq!(case.cloud.calls.load(Ordering::SeqCst), 0);
    assert!(case.titles.writes.lock().unwrap().is_empty());
    case.prompts_after_scan_interval(12, &mut journal);
    case.pass(&mut journal).await;
    assert_eq!(case.row().title, "Fix inbox scrolling");
    assert_eq!(case.row().display_name(), "codex-cloud-fix-inbox");
    assert!(case.fake.agent("codex-cloud-fix-inbox").is_some());
    assert_eq!(
        case.core.store.read(|store| store
            .registration_answering("old-agent")
            .unwrap()
            .agent_id
            .clone()),
        case.row().agent_id
    );
    let mut restarted = Journal::load(&case.path()).unwrap();
    case.pass(&mut restarted).await;
    assert_eq!(case.cloud.calls.load(Ordering::SeqCst), 1);
    assert_eq!(case.titles.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn pending_brief_and_native_failure_retry_without_consuming_the_interval() {
    let case = Case::new().await;
    let mut journal = Journal::default();
    case.pass(&mut journal).await;
    case.prompts_after_scan_interval(12, &mut journal);
    case.cloud.answer.lock().unwrap()["status"] = json!("pending");
    case.pass(&mut journal).await;
    assert_eq!(case.row().title, "Original");
    assert_eq!(case.row().display_name(), "old-agent");
    Case::retry(&mut journal);
    case.cloud.answer.lock().unwrap()["status"] = json!("ready");
    case.titles.fail.store(true, Ordering::SeqCst);
    case.pass(&mut journal).await;
    assert_eq!(case.row().display_name(), "old-agent");
    assert_eq!(journal.entries.values().next().unwrap().count, 2);
    Case::retry(&mut journal);
    case.titles.fail.store(false, Ordering::SeqCst);
    case.pass(&mut journal).await;
    assert_eq!(case.row().display_name(), "codex-cloud-fix-inbox");
    assert_eq!(journal.entries.values().next().unwrap().count, 12);
}

#[tokio::test]
async fn manual_edit_or_signout_while_brief_is_in_flight_wins() {
    for signout in [false, true] {
        let case = Case::new().await;
        let mut journal = Journal::default();
        case.pass(&mut journal).await;
        case.prompts_after_scan_interval(12, &mut journal);
        let core = case.core.clone();
        let cloud = case.cloud.clone();
        *case.cloud.hook.lock().unwrap() = Some(Box::new(move || {
            if signout {
                cloud.signed_in.store(false, Ordering::SeqCst);
            } else {
                core.store
                    .update(|store| store.registrations[0].title = "My title".into())
                    .unwrap();
            }
        }));
        case.pass(&mut journal).await;
        assert!(case.titles.writes.lock().unwrap().is_empty());
        assert_eq!(case.row().display_name(), "old-agent");
        assert_eq!(
            case.row().title,
            if signout { "Original" } else { "My title" }
        );
    }
}

#[tokio::test]
async fn alias_failure_keeps_interval_and_retries_without_rewriting_native_title() {
    let case = Case::new().await;
    let mut journal = Journal::default();
    case.pass(&mut journal).await;
    case.prompts_after_scan_interval(12, &mut journal);
    case.fake
        .set_api_error("POST /v1/agents", Some((400, "rejected")));
    case.pass(&mut journal).await;
    assert_eq!(case.row().title, "Fix inbox scrolling");
    assert_eq!(case.row().display_name(), "old-agent");
    assert_eq!(journal.entries.values().next().unwrap().count, 2);
    assert_eq!(case.titles.writes.lock().unwrap().len(), 1);
    case.fake.set_api_error("POST /v1/agents", None);
    case.fake
        .seed_agent("codex-cloud-fix-inbox", "agent", json!({}));
    Case::retry(&mut journal);
    case.pass(&mut journal).await;
    assert_eq!(case.row().display_name(), "codex-cloud-fix-inbox-2");
    assert_eq!(case.titles.writes.lock().unwrap().len(), 1);
    assert_eq!(journal.entries.values().next().unwrap().count, 12);
}

#[tokio::test]
async fn worker_does_not_touch_another_person_or_an_archived_registration() {
    for archived in [false, true] {
        let case = Case::new().await;
        let mut journal = Journal::default();
        case.pass(&mut journal).await;
        case.prompts_after_scan_interval(12, &mut journal);
        case.core
            .store
            .update(|store| {
                if archived {
                    store.registrations[0].archived_at = Some("2026-10-29T12:00:00Z".into());
                } else {
                    store.agent_owners.values_mut().next().unwrap().user_id =
                        "another-person".into();
                }
            })
            .unwrap();
        case.pass(&mut journal).await;
        assert_eq!(case.cloud.calls.load(Ordering::SeqCst), 0);
        assert!(case.titles.writes.lock().unwrap().is_empty());
        assert_eq!(case.row().display_name(), "old-agent");
    }
}

#[tokio::test]
async fn active_and_undated_sessions_respect_the_hydration_interval() {
    for timestamp in [None, Some(4000)] {
        let case = Case::new().await;
        case.core.session_snapshot.lock().unwrap().1[0].updated_at_ms = timestamp;
        let mut journal = Journal::default();
        case.pass(&mut journal).await;
        assert_eq!(case.counter.1.load(Ordering::SeqCst), 1);
        case.counter.0.store(12, Ordering::SeqCst);
        case.core.session_snapshot.lock().unwrap().1[0].updated_at_ms =
            timestamp.map(|value| value + 1);
        case.pass(&mut journal).await;
        assert_eq!(
            case.counter.1.load(Ordering::SeqCst),
            1,
            "An active or undated provider cannot force another full hydration"
        );
        assert_eq!(case.cloud.calls.load(Ordering::SeqCst), 0);
        for entry in journal.entries.values_mut() {
            entry.observed_at_ms = 0;
        }
        case.pass(&mut journal).await;
        assert_eq!(case.counter.1.load(Ordering::SeqCst), 2);
        assert_eq!(case.row().display_name(), "codex-cloud-fix-inbox");
    }
}

#[tokio::test]
async fn first_available_history_establishes_the_baseline_without_renaming() {
    let case = Case::new().await;
    let mut journal = Journal::default();
    case.counter.0.store(u64::MAX, Ordering::SeqCst);
    case.pass(&mut journal).await;
    assert!(
        journal.entries.is_empty(),
        "Unavailable evidence must not invent a zero baseline"
    );
    case.counter.0.store(40, Ordering::SeqCst);
    case.pass(&mut journal).await;
    assert_eq!(
        case.counter.1.load(Ordering::SeqCst),
        1,
        "Unavailable evidence is retried after the interval, not on every tick"
    );
    assert!(journal.entries.is_empty());
    for observed in journal.evidence_attempts.values_mut() {
        *observed = 0;
    }
    case.pass(&mut journal).await;
    assert_eq!(journal.entries.values().next().unwrap().count, 40);
    assert_eq!(case.cloud.calls.load(Ordering::SeqCst), 0);
    case.prompts_after_scan_interval(49, &mut journal);
    case.pass(&mut journal).await;
    assert_eq!(case.cloud.calls.load(Ordering::SeqCst), 0);
    case.prompts_after_scan_interval(50, &mut journal);
    case.pass(&mut journal).await;
    assert_eq!(case.cloud.calls.load(Ordering::SeqCst), 1);
    assert_eq!(case.row().display_name(), "codex-cloud-fix-inbox");
}

#[tokio::test]
async fn unavailable_evidence_never_requires_a_durable_retry_marker() {
    let case = Case::new().await;
    let mut journal = Journal::default();
    case.counter.0.store(u64::MAX, Ordering::SeqCst);
    // A directory cannot be replaced with the checkpoint file. No rename is
    // possible yet, so this ordinary missing-evidence result needs no write.
    pass(&case.core, &mut journal, case.dir.path())
        .await
        .unwrap();
    assert!(journal.entries.is_empty());
    assert_eq!(journal.evidence_attempts.len(), 1);
    assert!(serde_json::to_value(&journal)
        .unwrap()
        .get("evidence_attempts")
        .is_none());
    pass(&case.core, &mut journal, case.dir.path())
        .await
        .unwrap();
    assert_eq!(case.counter.1.load(Ordering::SeqCst), 1);
    case.core
        .store
        .update(|store| {
            store.registrations.clear();
        })
        .unwrap();
    pass(&case.core, &mut journal, case.dir.path())
        .await
        .unwrap();
    assert!(
        journal.evidence_attempts.is_empty(),
        "Departed registrations leave no retry state"
    );
}
