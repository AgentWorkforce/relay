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

const PI_SESSION: &str = "12345678-1234-4234-8234-123456789abc";

/// A live Pi session in `world`'s Pi runtime, as Agent Relay's extension
/// records it: a private registry its process (pid 600) holds open.
fn live_pi_session(world: &mut World) -> Target {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let uid = crate::relay::peer::current_uid();
    world.sessions.config.uid = uid;
    let runtime = world.sessions.config.pi.runtime.clone();
    let instance = runtime.join("123456789012345678901234567890ab");
    std::fs::create_dir_all(&instance).unwrap();
    for dir in [&runtime, &instance] {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let registry = instance.join("session.json");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&registry)
        .unwrap();
    std::io::Write::write_all(
        &mut file,
        serde_json::json!({"version": 1, "pid": 600, "sessionId": PI_SESSION,
            "instance": "123456789012345678901234567890ab", "cwd": "/code/pi-project",
            "title": "Pi task"})
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    world.table.insert(
        600,
        FakeProcess {
            uid,
            executable: Some("/usr/local/bin/pi".into()),
            open_files: vec![registry.canonicalize().unwrap()],
            has_terminal: true,
            ..process(1, 60)
        },
    );
    Target::new(SessionKind::Pi, PI_SESSION)
}

/// A core over `sessions`, signed in to `fake`'s workspace.
fn core_over(
    home: &std::path::Path,
    fake: &fake_relaycast::FakeRelaycast,
    sessions: Arc<LocalSessions>,
) -> (
    Arc<Core>,
    tokio::sync::mpsc::UnboundedReceiver<crate::relay::push::PushSignal>,
) {
    let data = home.join("app-data");
    fake_relaycast::sign_in_store(&data, fake_relaycast::WORKSPACE_KEY, &fake.base_url);
    let (core, signals) = Core::with_plugins(
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
            sessions,
            ..Default::default()
        },
    );
    core.rediscover_workspace();
    (core, signals)
}

// `auto_activate` on alone (the desktop's Auto-activate switch) leaves an
// open Pi session joining only when added; `pi_auto_activate`, which
// `relay init` turns on for a person who chose Pi, puts it on the relay by
// itself, pinned to the live extension that holds it.
#[tokio::test]
async fn a_pi_session_auto_activates_only_with_its_own_opt_in() {
    let mut world = world();
    let target = live_pi_session(&mut world);
    let home = world._temp.path().to_path_buf();
    let fake = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let sessions = Arc::new(world.sessions);
    assert!(
        sessions
            .auto_activation_sessions()
            .iter()
            .any(|row| row.target == target),
        "a live Pi session is eligible like a Codex thread"
    );
    let (core, _signals) = core_over(&home, &fake, sessions);
    core.store
        .update(|store| store.auto_activate = Some(true))
        .unwrap();
    assert!(core.activate_new_sessions().await.is_empty());
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 0);
    assert!(core.store.read(|store| store.registrations.is_empty()));

    // OpenCode's opt-in does not widen Pi.
    core.store
        .update(|store| store.extras.opencode_auto_activate = Some(true))
        .unwrap();
    assert!(core.activate_new_sessions().await.is_empty());
    assert!(core.store.read(|store| store.registrations.is_empty()));

    core.store
        .update(|store| store.extras.pi_auto_activate = Some(true))
        .unwrap();
    assert!(core.activate_new_sessions().await.is_empty());
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 1);
    let registration = core
        .store
        .read(|store| store.registration_for(&target).cloned())
        .expect("the Pi session joined by itself");
    assert!(
        registration
            .route_binding
            .as_deref()
            .is_some_and(|binding| binding.starts_with("pi:600:")),
        "{:?}",
        registration.route_binding
    );
}

// An explicit Auto-activate off, or none, is honored over the Pi opt-in.
#[tokio::test]
async fn the_pi_opt_in_needs_auto_activate_on() {
    let mut world = world();
    live_pi_session(&mut world);
    let home = world._temp.path().to_path_buf();
    let fake = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let (core, _signals) = core_over(&home, &fake, Arc::new(world.sessions));
    for auto_activate in [Some(false), None] {
        core.store
            .update(|store| {
                store.auto_activate = auto_activate;
                store.extras.pi_auto_activate = Some(true);
            })
            .unwrap();
        assert!(core.activate_new_sessions().await.is_empty());
        assert_eq!(
            fake.calls("POST", "/v1/agents").len(),
            0,
            "{auto_activate:?}"
        );
    }
}

/// A desktop-configured core (an account whose default is on) treats an
/// unset `auto_activate` as on and keeps an explicit Off, while a core
/// without one (the CLI's) leaves it unset. Either way an open Pi, Oh My Pi
/// or OpenCode session never joins by itself without its own opt-in.
#[tokio::test]
async fn the_desktop_account_turns_automatic_activation_on_unless_turned_off() {
    use crate::relay::agents::auto_activation::{activation_applies, ActivationSettings};
    use crate::relay::test_account::TestAccount;
    let start = |home: &Path, default_on: Option<bool>, saved: Option<bool>| {
        let data = home.join("app-data");
        std::fs::create_dir_all(&data).unwrap();
        if let Some(saved) = saved {
            let store = crate::relay::store::StoreHandle::open_agent_store(
                data.join(crate::relay::app_store::STORE_FILE),
                "test-desk",
            );
            store
                .update(|store| store.auto_activate = Some(saved))
                .unwrap();
        }
        let account = default_on.map(|on| {
            let mut account = TestAccount::new();
            account.auto_activate_by_default = on;
            account.into_plugin()
        });
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
                account,
                ..Default::default()
            },
        );
        core.store.read(|store| store.auto_activate)
    };
    let home = tempfile::tempdir().unwrap();
    assert_eq!(start(&home.path().join("cli"), None, None), None);
    assert_eq!(start(&home.path().join("plain"), Some(false), None), None);
    assert_eq!(
        start(&home.path().join("desktop"), Some(true), None),
        Some(true)
    );
    assert_eq!(
        start(&home.path().join("off"), Some(true), Some(false)),
        Some(false),
        "an explicit Off is kept"
    );
    let on = ActivationSettings {
        auto_activate: Some(true),
        ..ActivationSettings::default()
    };
    for kind in [SessionKind::Pi, SessionKind::Omp, SessionKind::OpenCodeOpen] {
        assert!(
            !activation_applies(&on, kind),
            "{kind:?} needs its own opt-in"
        );
    }
    assert!(activation_applies(&on, SessionKind::Codex));
}

// A session a remote source hides (a Devin review: an automation started
// it, so nobody is in it to talk to) is neither listed nor auto-activated;
// one a person started still is.
#[test]
fn a_hidden_remote_session_is_never_listed_or_auto_activated() {
    let mut world = world();
    let review = "7b26a9f9201f4d3380a655e33b20e887";
    let person = "d4005cc839f84411aa3df250a51ce5fa";
    let mut remote = FakeRemote::new(&[
        (review, "Review delivery projection changes"),
        (person, "Setting up Devin's laptop"),
    ]);
    remote.hidden = vec![review];
    with_remote(&mut world, Arc::new(remote));
    let activated: Vec<String> = world
        .sessions
        .auto_activation_sessions()
        .into_iter()
        .map(|session| session.target.id)
        .collect();
    assert_eq!(activated, [person]);
    let listed: Vec<String> = world
        .sessions
        .sessions()
        .into_iter()
        .map(|session| session.target.id)
        .collect();
    assert!(listed.iter().any(|id| id == person));
    assert!(!listed.iter().any(|id| id == review));
}

#[tokio::test]
async fn a_registered_hidden_session_is_not_recreated_as_an_offline_session() {
    let mut world = world();
    let review = "7b26a9f9201f4d3380a655e33b20e887";
    let person = "d4005cc839f84411aa3df250a51ce5fa";
    let mut remote = FakeRemote::new(&[(review, "Review")]);
    remote.hidden = vec![review];
    with_remote(&mut world, Arc::new(remote));
    let home = world._temp.path();
    let (core, _signals) = Core::with_plugins(
        Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: home.join("app-data"),
            env: Default::default(),
            version: "test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        },
        Plugins {
            sessions: Arc::new(world.sessions),
            ..Default::default()
        },
    );
    core.store
        .update(|store| {
            for id in [review, person] {
                store.registrations.push(
                    serde_json::from_value(serde_json::json!({
                        "name": id, "agentID": id,
                        "target": Target::new(SessionKind::Devin, id),
                        "title": id, "baseURL": "https://example.invalid",
                        "registeredAt": "2026-10-28T00:00:00Z"
                    }))
                    .unwrap(),
                );
            }
        })
        .unwrap();
    let listed = crate::relay::local_methods::sessions_list(&core).await;
    assert_eq!(listed.sessions.len(), 1);
    assert_eq!(listed.sessions[0].target.id, person);
    assert_eq!(listed.sessions[0].running, Some(false));
    // Keep registration removal available independently of session presentation.
    assert_eq!(core.store.snapshot().registrations.len(), 2);
}
