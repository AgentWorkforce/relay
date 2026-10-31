//! Independent presentation discovery, with an unrelated provider held until
//! assertions finish. No installed provider or service is used.
use agent_relay_probe::relay::{
    daemon::{Config, Core, Plugins},
    delivery::DeliveryTiming,
    local_methods,
    paths::CorePaths,
    push::PushTiming,
    sessions::{DiscoveredSession, SessionDirectory, SessionPartition},
    store::{SessionKind, Target},
};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::Duration;

#[derive(Default)]
struct Directory {
    release: (Mutex<bool>, Condvar),
    calls: [AtomicUsize; 2],
    rows: Mutex<Vec<DiscoveredSession>>,
    lookups: Mutex<Vec<Target>>,
    blocked: Mutex<Option<SessionPartition>>,
}
impl Directory {
    fn unblock(&self) {
        *self.release.0.lock().unwrap() = true;
        self.release.1.notify_all();
    }
    fn blocked(&self) -> SessionPartition {
        self.blocked
            .lock()
            .unwrap()
            .unwrap_or(SessionPartition::Codex)
    }
    fn add(&self, id: &str) {
        self.rows.lock().unwrap().push(DiscoveredSession {
            target: Target::new(
                if self.blocked() == SessionPartition::Codex {
                    SessionKind::ClaudeTerminal
                } else {
                    SessionKind::Codex
                },
                id,
            ),
            title: id.into(),
            directory: None,
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        });
    }
}
impl SessionDirectory for Directory {
    fn sessions(&self) -> Vec<DiscoveredSession> {
        self.discover_partition(SessionPartition::Codex);
        self.discover_partition(SessionPartition::Claude).unwrap()
    }
    fn find_session(&self, target: &Target) -> Option<DiscoveredSession> {
        self.lookups.lock().unwrap().push(target.clone());
        self.rows
            .lock()
            .unwrap()
            .iter()
            .find(|row| &row.target == target)
            .cloned()
    }
    fn presentation_partitions(&self) -> Vec<SessionPartition> {
        vec![SessionPartition::Codex, SessionPartition::Claude]
    }
    fn discover_partition(&self, partition: SessionPartition) -> Option<Vec<DiscoveredSession>> {
        if partition == self.blocked() {
            self.calls[0].fetch_add(1, Ordering::SeqCst);
            let mut released = self.release.0.lock().unwrap();
            while !*released {
                released = self.release.1.wait(released).unwrap();
            }
            Some(vec![])
        } else {
            self.calls[1].fetch_add(1, Ordering::SeqCst);
            Some(self.rows.lock().unwrap().clone())
        }
    }
}
fn core(home: &std::path::Path, sessions: Arc<Directory>) -> Arc<Core> {
    Core::with_plugins(
        Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: home.join("app"),
            env: Default::default(),
            version: "test".into(),
            host_name: "test".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        },
        Plugins {
            sessions,
            ..Plugins::default()
        },
    )
    .0
}
async fn visible(core: &Arc<Core>, id: &str) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if local_methods::sessions_list(core)
                .await
                .sessions
                .iter()
                .any(|r| r.target.id == id)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("unrelated held provider must not hold back this row");
}
#[tokio::test]
async fn blocked_codex_cannot_delay_initial_or_subsequent_claude_publication() {
    exercise_blocked(SessionPartition::Codex).await;
}
#[tokio::test]
async fn blocked_claude_cannot_delay_initial_or_subsequent_codex_publication() {
    exercise_blocked(SessionPartition::Claude).await;
}
async fn exercise_blocked(blocked: SessionPartition) {
    let home = tempfile::tempdir().unwrap();
    let directory = Arc::new(Directory::default());
    *directory.blocked.lock().unwrap() = Some(blocked);
    directory.add("first");
    let core = core(home.path(), directory.clone());
    let watcher = tokio::spawn(local_methods::watch(core.clone()));
    // Unblock even if an assertion panics: the test runtime must shut down.
    struct Release(Arc<Directory>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.unblock();
        }
    }
    let _release = Release(directory.clone());
    visible(&core, "first").await;
    for _ in 0..100 {
        local_methods::sessions_list(&core).await;
    }
    assert_eq!(
        directory.calls[1].load(Ordering::SeqCst),
        1,
        "reads coalesce without increasing idle discovery"
    );
    directory.add("second");
    tokio::time::sleep(Duration::from_millis(5100)).await;
    visible(&core, "second").await;
    assert_eq!(
        directory.calls[0].load(Ordering::SeqCst),
        1,
        "held provider has one in-flight task"
    );
    assert_eq!(
        directory.calls[1].load(Ordering::SeqCst),
        2,
        "healthy provider keeps its existing cadence"
    );
    core.request_shutdown();
    tokio::time::timeout(Duration::from_secs(1), watcher)
        .await
        .expect("watch stops with provider still held")
        .unwrap();
    assert!(
        !*directory.release.0.lock().unwrap(),
        "provider remains held through shutdown"
    );
}

#[tokio::test]
async fn explicit_registration_uses_fresh_exact_lookup_without_waiting_for_other_providers() {
    let home = tempfile::tempdir().unwrap();
    let directory = Arc::new(Directory::default());
    let id = "019a0b1c-0000-7000-8000-00000000a556";
    directory.add(id);
    let core = core(home.path(), directory.clone());
    let target = Target::new(SessionKind::ClaudeTerminal, id);
    // No presentation pass has run, so success reaching the workspace check
    // can only come from the fresh target lookup, never a cached UI row.
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        core.register_target(&target, Some("fresh"), None),
    )
    .await;
    directory.unblock();
    let error = result
        .expect("unrelated full discovery must not block registration")
        .unwrap_err();
    assert_eq!(
        error.data.kind,
        agent_relay_probe::relay::protocol::ErrorKind::NotSignedIn
    );
    assert_eq!(*directory.lookups.lock().unwrap(), vec![target]);
    assert_eq!(directory.calls[0].load(Ordering::SeqCst), 0);
}
