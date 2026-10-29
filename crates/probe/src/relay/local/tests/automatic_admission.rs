//! Retained UI rows do not authorize a new automatic registration.
use super::*;
use crate::relay::daemon::{Config, Core, Plugins};
use crate::relay::delivery::DeliveryTiming;
use crate::relay::paths::CorePaths;
use crate::relay::push::PushTiming;

#[path = "../../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;

fn writer() -> FakeProcess {
    FakeProcess {
        executable: Some(codex_exe()),
        arguments: vec!["codex".into(), "resume".into(), THREAD.into()],
        has_terminal: true,
        ..process(1, 52)
    }
}

#[tokio::test]
async fn a_retained_closed_codex_row_cannot_create_an_automatic_registration() {
    let world = world();
    let home = world._temp.path();
    let codex_home = &world.sessions.config.codex.home;
    std::fs::create_dir_all(codex_home).unwrap();
    let path = codex_home.join("state_5.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(&format!(
        "create table threads (id text, title text, cwd text, archived integer, source text, updated_at integer);
         insert into threads values ('{THREAD}', 'Retained title', '/code/relay', 0, 'cli', 1790000000);"
    )).unwrap();
    drop(db);
    let readable = std::fs::read(&path).unwrap();
    world.table.insert(500, writer());
    let target = Target::new(SessionKind::Codex, THREAD);
    let live = world
        .sessions
        .sessions()
        .into_iter()
        .find(|row| row.target == target)
        .unwrap();
    assert!(
        live.live,
        "the cache starts with actual live provider evidence"
    );

    let fake = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let data = home.join("app-data");
    fake_relaycast::sign_in_store(&data, fake_relaycast::WORKSPACE_KEY, &fake.base_url);
    let sessions = Arc::new(world.sessions);
    let (core, _signals) = Core::with_plugins(
        Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: data,
            env: Default::default(),
            version: "test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        },
        Plugins {
            sessions: sessions.clone(),
            ..Default::default()
        },
    );
    core.rediscover_workspace();
    core.store
        .update(|store| store.auto_activate = Some(true))
        .unwrap();
    assert!(core.store.read(|store| store.registrations.is_empty()));

    world.table.remove(500);
    std::fs::write(&path, b"not a database").unwrap();
    let retained = sessions
        .sessions()
        .into_iter()
        .find(|row| row.target == target)
        .unwrap();
    assert_eq!(retained.title, "Retained title");
    assert!(sessions
        .discover_partition(SessionPartition::Codex)
        .is_none());
    assert!(sessions.find_session(&target).is_none());
    assert!(core.activate_new_sessions().await.is_empty());
    assert_eq!(
        fake.calls("POST", "/v1/agents").len(),
        0,
        "retained presentation cannot create a registration"
    );
    assert!(core.store.read(|store| store.registrations.is_empty()));
    assert!(!sessions
        .auto_activation_sessions()
        .iter()
        .any(|row| row.target == target));
    assert_eq!(
        sessions
            .sessions()
            .into_iter()
            .find(|row| row.target == target)
            .unwrap()
            .title,
        "Retained title",
        "failed automatic proof keeps presentation"
    );

    std::fs::write(&path, readable).unwrap();
    world.table.insert(500, writer());
    assert!(sessions
        .auto_activation_sessions()
        .iter()
        .any(|row| row.target == target));
    assert!(core.activate_new_sessions().await.is_empty());
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 1);
    assert!(core
        .store
        .read(|store| store.registrations.iter().any(|row| row.target == target)));
}

#[cfg(feature = "history")]
/// `cloud_catalog` with each row's originator (`automation` for a
/// Devin review).
pub(super) fn cloud_catalog_from(world: &mut World, rows: &[(&str, &str, Option<&str>)]) {
    let install = world
        .sessions
        .config
        .devin
        .home
        .join("probe")
        .join("install-a");
    std::fs::create_dir_all(&install).unwrap();
    std::fs::write(install.join("config.json"), "{}").unwrap();
    let store = ai_hist::SessionStore::open(
        ai_hist::StoreOptions::default().db_path(install.join("history.db")),
    )
    .unwrap();
    store
        .apply_source_observations(ai_hist::SourceObservationBatch::new(
            "devin-cloud",
            "default",
            ai_hist::SessionLocation::Remote,
            rows.iter()
                .map(|(id, title, originator)| ai_hist::SourceObservation {
                    session: ai_hist::ShallowSession {
                        source: "devin".into(),
                        session_id: (*id).into(),
                        title: Some((*title).into()),
                        originator: originator.map(str::to_string),
                        source_stamp: Some(format!("cloud:100:active:{id}")),
                        ..Default::default()
                    },
                    raw_locator: Some(format!("v3:sessions/{id}")),
                })
                .collect(),
        ))
        .unwrap();
    drop(store);
    world.sessions.config.probe_root = Some(world.sessions.config.devin.home.join("probe"));
}

// A Devin review (a session an automation started) has nobody in it to
// talk to, so it never auto-activates; one a person started still does.
#[cfg(feature = "history")]
#[test]
fn a_devin_review_session_never_auto_activates() {
    let _lock = crate::relay::devin_cloud::tests::ENV_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let mut world = world();
    let review = "7b26a9f9201f4d3380a655e33b20e887";
    let person = "d4005cc839f84411aa3df250a51ce5fa";
    cloud_catalog_from(
        &mut world,
        &[
            (
                review,
                "Review delivery projection changes",
                Some("automation"),
            ),
            (person, "Setting up Devin's laptop", Some("webapp")),
        ],
    );
    let _unsigned = crate::relay::devin_cloud::tests::unsigned_env();
    let _env = crate::relay::devin_cloud::tests::signed_in_env();
    let activated: Vec<String> = world
        .sessions
        .auto_activation_sessions()
        .into_iter()
        .map(|session| session.target.id)
        .collect();
    assert_eq!(activated, [person]);
    assert!(
        world
            .sessions
            .sessions()
            .iter()
            .any(|s| s.target.id == review),
        "still listed, and can be registered by hand"
    );
}
