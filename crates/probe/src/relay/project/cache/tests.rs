use super::*;
use crate::relay::daemon::{Config, Core};
use crate::relay::paths::CorePaths;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{SessionKind, Target};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Condvar;

fn names(resolver: impl Fn(&str, &Path) -> Option<String> + Send + Sync + 'static) -> Names {
    let mut names = Names::new("/relay".into());
    names.resolver = Arc::new(resolver);
    names.deadline = Duration::from_millis(100);
    names
}

/// Simulates a syscall that never returns until the test explicitly releases
/// it. Drop also releases it if an assertion fails; no test leaks a thread.
#[derive(Default)]
struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    fn resolver(&self, calls: Arc<AtomicUsize>) -> impl Fn(&str, &Path) -> Option<String> {
        let gate = self.0.clone();
        move |_, _| {
            calls.fetch_add(1, Ordering::SeqCst);
            let (lock, wake) = &*gate;
            let _guard = wake
                .wait_while(lock.lock().unwrap(), |released| !*released)
                .unwrap();
            Some("late-repository".into())
        }
    }
}

impl Drop for Gate {
    fn drop(&mut self) {
        *self.0 .0.lock().unwrap() = true;
        self.0 .1.notify_all();
    }
}

#[tokio::test]
async fn caches_positive_and_absent_names_and_coalesces_overlapping_lists() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let names = names(move |cwd, _| {
        count.fetch_add(1, Ordering::SeqCst);
        (cwd != "/controller").then(|| "repository".into())
    });
    let directories = ["/checkout", "/controller", "/checkout"];
    let (first, second) = tokio::join!(
        names.list(directories.into_iter()),
        names.list(directories.into_iter()),
    );
    assert_eq!(first, second);
    assert_eq!(first["/checkout"].as_deref(), Some("repository"));
    assert_eq!(first["/controller"], None);
    assert_eq!(names.list(directories.into_iter()).await, first);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn cache_has_a_capacity_and_expires_both_positive_and_negative_results() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let mut names = names(move |cwd, _| {
        count.fetch_add(1, Ordering::SeqCst);
        (cwd == "/positive").then(|| "repository".into())
    });
    names.capacity = 2;
    names.ttl = Duration::from_millis(40);
    names.get("/positive").await;
    names.get("/negative").await;
    names.get("/third").await;
    {
        let cache = names.cache.lock().unwrap();
        assert_eq!(cache.entries.len(), 2);
        assert_eq!(cache.order.len(), 2);
        assert!(!cache.entries.contains_key("/positive"));
    }
    names.get("/positive").await;
    names.get("/negative").await;
    assert_eq!(calls.load(Ordering::SeqCst), 5);
    tokio::time::sleep(names.ttl).await;
    names.get("/positive").await;
    names.get("/negative").await;
    assert_eq!(calls.load(Ordering::SeqCst), 7);
}

#[tokio::test]
async fn blocked_batch_times_out_once_and_negative_cache_ignores_late_results() {
    let gate = Gate::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let names = names(gate.resolver(calls.clone()));
    let directories: Vec<_> = (0..500).map(|i| format!("/missing/folder-{i}")).collect();
    let first = tokio::time::timeout(
        Duration::from_secs(1),
        names.list(directories.iter().map(String::as_str)),
    )
    .await
    .expect("500 paths must share one deadline");
    assert_eq!(first.len(), 500);
    for (path, result) in &first {
        assert_eq!(*result, file_name(Path::new(path)));
    }
    assert_eq!(calls.load(Ordering::SeqCst), WORKERS);
    assert_eq!(names.workers.available_permits(), 0);
    assert_eq!(
        names.list(directories.iter().map(String::as_str)).await,
        first
    );
    // Even cache eviction/expiry cannot spawn replacement workers for hung
    // syscalls. A fresh path gets a bounded fallback too.
    assert_eq!(
        names.get("/another/folder").await.as_deref(),
        Some("folder")
    );
    assert_eq!(calls.load(Ordering::SeqCst), WORKERS);
    drop(gate);
    tokio::time::timeout(Duration::from_secs(1), async {
        while names.workers.available_permits() != WORKERS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        names.list(directories.iter().map(String::as_str)).await,
        first
    );
    assert_eq!(calls.load(Ordering::SeqCst), WORKERS);
}

#[tokio::test]
async fn cancelled_lookup_does_not_start_work_after_its_deadline() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let names = names(move |_, _| {
        count.fetch_add(1, Ordering::SeqCst);
        Some("repository".into())
    });
    let permits = names
        .workers
        .clone()
        .acquire_many_owned(WORKERS as u32)
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), names.get("/folder"))
            .await
            .is_err()
    );
    tokio::time::sleep(names.deadline).await;
    drop(permits);
    assert_eq!(names.get("/folder").await.as_deref(), Some("folder"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancelled_lookup_discards_a_reply_after_its_original_deadline() {
    let gate = Gate::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let names = names(gate.resolver(calls.clone()));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), names.get("/folder"))
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    tokio::time::sleep(names.deadline).await;
    drop(gate);
    tokio::time::timeout(Duration::from_secs(1), async {
        while names.workers.available_permits() != WORKERS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(names.get("/folder").await.as_deref(), Some("folder"));
    assert_eq!(names.get("/folder").await.as_deref(), Some("folder"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

fn core(home: &Path, names: Names) -> Arc<Core> {
    let config = Config {
        paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
        home: home.into(),
        app_data_dir: home.join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "test".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    };
    let (core, _) = Core::new(config);
    // No background services or self-referencing operations run in this
    // method-dispatch fixture. Replace only its project resolver.
    let mut core = Arc::try_unwrap(core).ok().unwrap();
    core.project_names = names;
    Arc::new(core)
}

#[tokio::test(flavor = "current_thread")]
async fn sessions_list_deadline_and_other_rpcs_survive_blocked_filesystem() {
    let temp = tempfile::tempdir().unwrap();
    let gate = Gate::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let core = core(temp.path(), names(gate.resolver(calls.clone())));
    core.session_snapshot.lock().unwrap().1 = (0..500)
        .map(|i| DiscoveredSession {
            target: Target {
                kind: SessionKind::Codex,
                id: format!("session-{i}"),
            },
            title: "Work".into(),
            directory: Some(format!("/missing/folder-{i}")),
            updated_at_ms: None,
            host: None,
            live: false,
            holder: None,
        })
        .collect();
    let listing = {
        let core = core.clone();
        tokio::spawn(
            async move { crate::relay::server::call(&core, "sessions.list", json!({})).await },
        )
    };
    tokio::time::timeout(Duration::from_secs(1), async {
        while calls.load(Ordering::SeqCst) < WORKERS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!listing.is_finished());
    for _ in 0..10 {
        let status = tokio::time::timeout(
            Duration::from_millis(50),
            crate::relay::server::call(&core, "status.get", json!({})),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(status["machine"]["host_name"], "test");
    }
    let result = tokio::time::timeout(Duration::from_secs(1), listing)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result["sessions"].as_array().unwrap().len(), 500);
    assert_eq!(result["sessions"][0]["project"], "folder-0");
    assert_eq!(calls.load(Ordering::SeqCst), WORKERS);
}

#[tokio::test]
async fn cancelled_lookup_does_not_keep_a_freed_worker_slot() {
    let names = names(|_, _| Some("repository".into()));
    let permits = names
        .workers
        .clone()
        .acquire_many_owned(WORKERS as u32)
        .await
        .unwrap();
    // Queued behind the busy workers, then abandoned by its only caller.
    assert!(
        tokio::time::timeout(Duration::from_millis(10), names.get("/abandoned"))
            .await
            .is_err()
    );
    tokio::time::sleep(names.deadline * 2).await;
    drop(permits);
    // The abandoned lookup timed out on its own, so every slot is free again
    // without anyone polling "/abandoned".
    assert_eq!(names.workers.available_permits(), WORKERS);
    assert_eq!(names.get("/other").await.as_deref(), Some("repository"));
}
