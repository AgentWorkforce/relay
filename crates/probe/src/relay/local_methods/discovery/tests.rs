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
