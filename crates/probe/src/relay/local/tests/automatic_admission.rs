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

#[cfg(feature = "history")]
/// `cloud_catalog` with each row's originator (`automation` for a
/// Devin review), each active a minute ago.
pub(super) fn cloud_catalog_from(world: &mut World, rows: &[(&str, &str, Option<&str>)]) {
    cloud_catalog_aged(world, rows, 60_000);
}

/// `cloud_catalog_from` with every row last active `age_ms` ago.
#[cfg(feature = "history")]
fn cloud_catalog_aged(world: &mut World, rows: &[(&str, &str, Option<&str>)], age_ms: i64) {
    let probe_root = world.sessions.config.devin.home.join("probe");
    let rows: Vec<_> = rows
        .iter()
        .map(|(id, title, originator)| (*id, *title, *originator, age_ms))
        .collect();
    write_cloud_catalog(&probe_root, &rows, "100");
    world.sessions.config.probe_root = Some(probe_root);
}

/// Lands `(id, title, originator, age_ms)` rows in the probe root's
/// `install-a` catalog, as the `devin-cloud` connector's listing at
/// `stamp` would. A re-listing only moves a row's activity forward — the
/// catalog keeps the latest — so re-dating a row older means removing the
/// catalog first.
#[cfg(feature = "history")]
fn write_cloud_catalog(
    probe_root: &std::path::Path,
    rows: &[(&str, &str, Option<&str>, i64)],
    stamp: &str,
) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let install = probe_root.join("install-a");
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
                .map(
                    |(id, title, originator, age_ms)| ai_hist::SourceObservation {
                        session: ai_hist::ShallowSession {
                            source: "devin".into(),
                            session_id: (*id).into(),
                            title: Some((*title).into()),
                            originator: originator.map(str::to_string),
                            last_activity_ms: Some(now - age_ms),
                            source_stamp: Some(format!("cloud:{stamp}:active:{id}")),
                            ..Default::default()
                        },
                        raw_locator: Some(format!("v3:sessions/{id}")),
                    },
                )
                .collect(),
        ))
        .unwrap();
}

// A Devin review (a session an automation started) has nobody in it to
// talk to, so it is neither listed nor auto-activated; one a person
// started still is.
#[cfg(feature = "history")]
#[test]
fn a_devin_review_session_is_never_listed_or_auto_activated() {
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
    let _env = crate::relay::devin_cloud::tests::signed_in_env();
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

#[cfg(feature = "history")]
#[tokio::test]
async fn a_registered_devin_review_is_not_recreated_as_an_offline_session() {
    let mut world = world();
    let review = "7b26a9f9201f4d3380a655e33b20e887";
    let person = "d4005cc839f84411aa3df250a51ce5fa";
    cloud_catalog_from(&mut world, &[(review, "Review", Some(" Automation "))]);
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

/// A live session joins the relay by itself only once the upload policy
/// uploads it, and leaves when that stops.
#[cfg(feature = "history")]
#[tokio::test]
async fn a_session_the_upload_policy_keeps_local_does_not_join_by_itself() {
    use crate::relay::test_account::TestAccount;
    use crate::relay::uploader::{Install, ProcessRunner, Uploader};
    let world = world();
    let home = world._temp.path();
    let codex_home = &world.sessions.config.codex.home;
    std::fs::create_dir_all(codex_home).unwrap();
    let db = rusqlite::Connection::open(codex_home.join("state_5.sqlite")).unwrap();
    db.execute_batch(&format!(
        "create table threads (id text, title text, cwd text, archived integer, source text, updated_at integer);
         insert into threads values ('{THREAD}', 'Kept local', '/code/relay', 0, 'cli', 1790000000);"
    )).unwrap();
    drop(db);
    world.table.insert(500, writer());

    // `selected` installs holding the session; `uploads` says whether it
    // is chosen.
    let identity = crate::delivery::SessionIdentity {
        source: "codex".into(),
        session_id: THREAD.into(),
    };
    let selected = |chosen: bool| {
        let install = crate::delivery_status::status_tests::install(&[&format!("codex:{THREAD}")]);
        let config_path = install.path().join("config.json");
        let mut config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        config["sharing_mode"] = "selected".into();
        std::fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        let history = crate::delivery::open_db(&install.path().join("history.db")).unwrap();
        let members: &[crate::delivery::SessionIdentity] = if chosen {
            std::slice::from_ref(&identity)
        } else {
            &[]
        };
        crate::delivery::adopt_session_job(&history, config["job_id"].as_str().unwrap(), members)
            .unwrap();
        install
    };
    let uploader = Arc::new(Uploader::new(Arc::new(
        ProcessRunner::new(home.join("unused-synthetic-probe")).with_env("HOME", home),
    )));
    let attach = |install: &tempfile::TempDir| {
        uploader.attach(Install::from_json(&serde_json::json!({
            "site_url": "https://agentrelay.com",
            "workspace_id": "workspace",
            "directory": install.path().to_str().unwrap(),
        })));
    };
    let kept_local = selected(false);
    attach(&kept_local);

    let fake = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let data = home.join("app-data");
    fake_relaycast::sign_in_store(&data, fake_relaycast::WORKSPACE_KEY, &fake.base_url);
    let mut account = TestAccount::new(uploader.clone());
    account.looked = true;
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
            sessions: Arc::new(world.sessions),
            account: Some(account.into_plugin()),
            ..Default::default()
        },
    );
    core.rediscover_workspace();
    core.store
        .update(|store| {
            store.auto_activate = Some(true);
            store.cloud.as_mut().unwrap().account_workspace_id = Some("workspace".into());
        })
        .unwrap();

    assert!(core.activate_new_sessions().await.is_empty());
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 0, "kept local");
    assert!(core.store.read(|store| store.registrations.is_empty()));

    // The person turns on Upload session: it joins.
    let chosen = selected(true);
    attach(&chosen);
    assert!(core.activate_new_sessions().await.is_empty());
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 1);

    // Turned off again: no longer eligible, so it is marked to leave.
    attach(&kept_local);
    assert!(core.activate_new_sessions().await.is_empty());
    let registrations = core.store.read(|store| store.registrations.clone());
    assert_eq!(registrations.len(), 1);
    assert!(registrations[0].missing_since.is_some(), "marked to leave");
}

// A Devin Cloud session untouched for a day has nobody in it to talk to,
// so a signed-in machine lists it — deliverable, and addable by hand — but
// never auto-activates it, and an automatic agent whose session goes quiet
// for a day is marked to leave the relay, instead of heartbeating
// Relaycast every 15 s for as long as the catalog remembers it.
#[cfg(feature = "history")]
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn a_stale_devin_cloud_session_never_joins_by_itself_and_an_automatic_one_leaves() {
    let _lock = crate::relay::devin_cloud::tests::ENV_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let _env = crate::relay::devin_cloud::tests::signed_in_env();
    const DAY: i64 = 24 * 60 * 60 * 1000;
    let mut world = world();
    let home = world._temp.path().to_path_buf();
    let probe_root = world.sessions.config.devin.home.join("probe");
    let recent = "4b50574f40324da6bd88e9cbd30501cf";
    let stale = "d4005cc839f84411aa3df250a51ce5fa";
    write_cloud_catalog(
        &probe_root,
        &[
            (recent, "Today's task", Some("webapp"), 60_000),
            (stale, "Six-week-old task", Some("webapp"), 42 * DAY),
        ],
        "100",
    );
    world.sessions.config.probe_root = Some(probe_root.clone());
    let activated: Vec<String> = world
        .sessions
        .auto_activation_sessions()
        .into_iter()
        .map(|session| session.target.id)
        .collect();
    assert_eq!(activated, [recent], "only the recent session joins");
    let stale_row = world
        .sessions
        .sessions()
        .into_iter()
        .find(|session| session.target.id == stale)
        .expect("a stale cloud session is still listed");
    assert!(
        stale_row.live,
        "still deliverable, so it can be added by hand"
    );

    let sessions = Arc::new(world.sessions);
    let fake = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let data = home.join("app-data");
    fake_relaycast::sign_in_store(&data, fake_relaycast::WORKSPACE_KEY, &fake.base_url);
    let (core, _signals) = Core::with_plugins(
        Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.clone(),
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
    assert!(core.activate_new_sessions().await.is_empty());
    // A person adds the stale session by hand: it is still deliverable.
    core.register_session(&stale_row, None, None, false)
        .await
        .expect("a stale cloud session can be added by hand");
    assert!(core.activate_new_sessions().await.is_empty());
    let registered = |core: &Core| core.store.read(|store| store.registrations.clone());
    let by_id = |core: &Core, id: &str| {
        registered(core)
            .into_iter()
            .find(|registration| registration.target.id == id)
    };
    assert_eq!(registered(&core).len(), 2);
    let automatic = by_id(&core, recent).expect("the recent session joined by itself");
    assert_eq!(automatic.auto_activated, Some(true));
    assert!(automatic.missing_since.is_none());
    let by_hand = by_id(&core, stale).expect("the hand-added stale session");
    assert_ne!(by_hand.auto_activated, Some(true), "never joined by itself");
    assert!(by_hand.missing_since.is_none(), "kept present on the relay");

    // A day passes with nobody in the session: the catalog dates it a day
    // old (rebuilt, since a catalog never moves activity backwards), so
    // the automatic agent is marked to leave.
    let install = probe_root.join("install-a");
    for entry in std::fs::read_dir(&install).unwrap() {
        let path = entry.unwrap().path();
        if path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("history.db")
        {
            std::fs::remove_file(path).unwrap();
        }
    }
    write_cloud_catalog(
        &probe_root,
        &[
            (recent, "Today's task", Some("webapp"), DAY + 60_000),
            (stale, "Six-week-old task", Some("webapp"), 42 * DAY),
        ],
        "200",
    );
    let aged = sessions
        .sessions()
        .into_iter()
        .find(|session| session.target.id == recent)
        .expect("the quiet session is still listed");
    assert!(aged.live, "and still deliverable");
    assert!(
        !sessions
            .auto_activation_sessions()
            .iter()
            .any(|session| session.target.id == recent),
        "but a day old, so no longer eligible to stay by itself"
    );
    assert!(core.activate_new_sessions().await.is_empty());
    let automatic = by_id(&core, recent).expect("kept through the grace period");
    assert!(automatic.missing_since.is_some(), "marked to leave");
    let by_hand = by_id(&core, stale).expect("the hand-added session stays");
    assert!(
        by_hand.missing_since.is_none(),
        "still present on the relay"
    );
}

/// A desktop-configured core (an account whose default is on) treats an
/// unset `auto_activate` as on and keeps an explicit Off, while a core
/// without one (the CLI's) leaves it unset. Either way an open Pi, Oh My Pi
/// or OpenCode session never joins by itself without its own opt-in.
#[tokio::test]
async fn the_desktop_account_turns_automatic_activation_on_unless_turned_off() {
    use crate::relay::agents::auto_activation::{activation_applies, ActivationSettings};
    use crate::relay::test_account::TestAccount;
    use crate::relay::uploader::{ProcessRunner, Uploader};
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
            let mut account = TestAccount::new(Arc::new(Uploader::new(Arc::new(
                ProcessRunner::new(home.join("unused")),
            ))));
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
