use super::*;
use crate::relay::{
    daemon::{Config, Plugins},
    delivery::DeliveryTiming,
    paths::CorePaths,
    push::PushTiming,
    store::SessionKind,
};

fn core(home: &std::path::Path) -> Arc<Core> {
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
        Plugins::default(),
    )
    .0
}
fn row(kind: SessionKind, id: &str) -> DiscoveredSession {
    DiscoveredSession {
        target: Target::new(kind, id),
        title: id.into(),
        directory: None,
        updated_at_ms: None,
        host: None,
        live: true,
        holder: None,
    }
}
fn complete(core: &Arc<Core>, generation: u64, found: Option<Vec<DiscoveredSession>>) {
    publish(
        core,
        Some(SessionPartition::Claude),
        Completed {
            slot: 0,
            generation,
            found,
        },
    );
}

#[test]
fn unavailable_retains_rows_but_authoritative_empty_removes_only_its_domain() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path());
    let codex = row(SessionKind::Codex, "other");
    let claude = row(SessionKind::ClaudeTerminal, "retained");
    core.session_snapshot.lock().unwrap().1 = vec![codex.clone(), claude.clone()];
    complete(&core, 0, None);
    assert_eq!(
        core.session_snapshot.lock().unwrap().1,
        vec![codex.clone(), claude]
    );
    complete(&core, 0, Some(vec![]));
    assert_eq!(core.session_snapshot.lock().unwrap().1, vec![codex]);
}

#[test]
fn a_launch_or_registration_generation_rejects_an_older_partition_result() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path());
    let launched = row(SessionKind::ClaudeTerminal, "just-launched");
    *core.session_snapshot.lock().unwrap() = (1, vec![launched.clone()]);
    complete(&core, 0, Some(vec![]));
    assert_eq!(core.session_snapshot.lock().unwrap().1, vec![launched]);
    complete(&core, 1, Some(vec![]));
    assert!(core.session_snapshot.lock().unwrap().1.is_empty());
}

#[test]
fn a_partition_cannot_publish_or_erase_another_providers_target() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path());
    let codex = row(SessionKind::Codex, "other");
    core.session_snapshot.lock().unwrap().1 = vec![codex.clone()];
    let claude = row(SessionKind::ClaudeTerminal, "new");
    complete(
        &core,
        0,
        Some(vec![row(SessionKind::Codex, "foreign"), claude.clone()]),
    );
    assert_eq!(core.session_snapshot.lock().unwrap().1, vec![codex, claude]);
}

#[test]
fn timestamp_only_updates_keep_the_current_presentation_and_order() {
    let home = tempfile::tempdir().unwrap();
    let core = core(home.path());
    let codex = row(SessionKind::Codex, "other");
    let mut claude = row(SessionKind::ClaudeTerminal, "same");
    core.session_snapshot.lock().unwrap().1 = vec![claude.clone(), codex.clone()];
    claude.updated_at_ms = Some(42);
    complete(&core, 0, Some(vec![claude.clone()]));
    assert_eq!(core.session_snapshot.lock().unwrap().1, vec![claude, codex]);
}

#[tokio::test(start_paused = true)]
async fn stale_read_demand_coalesces_without_a_polling_loop() {
    let demand = PresentationDemand::default();
    demand.request();
    demand.notify.notified().await;
    for _ in 0..100 {
        demand.request();
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(1), demand.notify.notified())
            .await
            .is_err()
    );
    tokio::time::advance(WATCH_EVERY).await;
    demand.request();
    tokio::time::timeout(Duration::from_millis(1), demand.notify.notified())
        .await
        .unwrap();
}

#[tokio::test(start_paused = true)]
async fn stale_demand_queues_only_one_followup_and_leaves_fresh_or_busy_slots_bounded() {
    let now = Deadline::now();
    let slot = |busy, age| Slot {
        partition: Some(SessionPartition::Claude),
        due: now + WATCH_EVERY,
        busy,
        started: now - age,
        requested: false,
    };
    let mut slots = vec![
        slot(false, WATCH_EVERY),
        slot(false, Duration::from_secs(1)),
        slot(true, WATCH_EVERY),
        slot(true, Duration::from_secs(1)),
    ];
    for _ in 0..100 {
        wake_stale(&mut slots);
    }
    assert_eq!(slots[0].due, now);
    assert_eq!(slots[1].due, now + WATCH_EVERY);
    assert!(
        slots[2].requested && slots[2].busy,
        "one pending bit, no duplicate task"
    );
    assert!(!slots[3].requested && slots[3].busy);
}
