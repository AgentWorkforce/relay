use super::*;
use crate::live::tests::{
    append, config, eventually, isolated_home, job_config, options, transcript_line,
};
use crate::remote_sources::test_host::{credentials, FakeKeychain};
use crate::remote_sources::tests::EnvGuard;
mod api;
use api::Api;

fn due(db: &Path) {
    std::fs::OpenOptions::new()
        .write(true)
        .open(db.with_extension("remote-enumerated"))
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(600))
        .unwrap();
}
fn armed_after(
    clock: &crate::remote_sources::test_host::VirtualClock,
    previous: u64,
) -> (u64, Instant) {
    eventually(
        "remote worker arms its next deadline",
        Duration::from_secs(5),
        || {
            clock
                .armed()
                .is_some_and(|(sequence, _)| sequence > previous)
        },
    );
    clock.armed().unwrap()
}

fn selected(home: &Path, source: &str, id: &str) -> (PathBuf, PathBuf, delivery::DeliveryStatus) {
    let directory = home.join("probe");
    std::fs::create_dir_all(&directory).unwrap();
    let db = directory.join("history.db");
    history::open(&db).unwrap();
    let conn = delivery::open_db(&db).unwrap();
    let job = delivery::create_session_job(&conn, &job_config(), 0).unwrap();
    delivery::set_job_session(
        &conn,
        &job.job_id,
        &delivery::SessionIdentity {
            source: source.into(),
            session_id: id.into(),
        },
        true,
    )
    .unwrap();
    (directory, db, job)
}
fn text(db: &Path, id: &str, value: &str) -> bool {
    delivery::open_db_readonly(db)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM session_events WHERE session_id=? AND text LIKE ?",
            rusqlite::params![id, format!("%{value}%")],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
        > 0
}
fn count(db: &Path, id: &str) -> i64 {
    delivery::open_db_readonly(db)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM session_events WHERE session_id=?",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}
fn sharing(home: &Path) {
    let env = |key: &str| std::env::var(key).ok();
    let relay = agent_relay_probe::relay::workspace::relay_home(&env, home);
    std::fs::create_dir_all(&relay).unwrap();
    agent_relay_probe::relay::claude_dirs::ClaudeDirs::from_env(&env, home, &relay)
        .set_cloud_sessions(true)
        .unwrap();
}
fn short() -> LiveOptions {
    LiveOptions {
        backstop: Duration::from_millis(20),
        member_poll: Duration::from_millis(20),
        member_backstop: Duration::from_secs(3600),
        use_fs_events: false,
        ..options()
    }
}

fn remote_changes(claude: bool, name: &str) {
    let Some(home) = isolated_home(name) else {
        return;
    };
    let api = Api::start(claude);
    let source = if claude { "claude" } else { "devin" };
    let id = if claude { api::CLAUDE } else { api::DEVIN };
    let _claude = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", api.url());
    let _devin = (!claude).then(|| {
        [
            EnvGuard::set("RELAYHISTORY_DEVIN_API_KEY", "test-key"),
            EnvGuard::set("RELAYHISTORY_DEVIN_ORG_ID", "org-test"),
            EnvGuard::set("RELAYHISTORY_DEVIN_API_BASE_URL", api.url()),
        ]
    });
    sharing(&home);
    let (directory, db, job) = selected(&home, source, id);
    let fake = FakeKeychain::holding(
        claude
            .then(|| credentials(chrono::Utc::now().timestamp_millis() + 3_600_000))
            .as_deref(),
    );
    let host = crate::remote_sources::test_host::install(&home, &db, fake);
    let clock = host.clock().unwrap();
    let shared = Arc::new(Shared::default());
    let stopped = Arc::new(AtomicBool::new(false));
    let capture = crate::live::start(
        &directory,
        &config(&job, true),
        stopped.clone(),
        shared.clone(),
        short(),
    );
    eventually(
        "actual selected worker lists and actual member loop hydrates",
        Duration::from_secs(8),
        || text(&db, id, "version-1"),
    );
    let unselected = if claude {
        "session_02unselected"
    } else {
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    };
    assert_eq!(count(&db, unselected), 0);
    let store = history::open_read(&db).unwrap();
    assert!(crate::remote_sources::observed(&store, source, unselected).unwrap());
    // Many real member turns before the provider's 300-second marker is due
    // perform neither another listing nor an evidence acquisition.
    let lists = api.lists();
    let fetches = api.fetches();
    for _ in 0..5 {
        assert!(enumerate(&db, &home, || false).unwrap().is_none());
    }
    assert_eq!((api.lists(), api.fetches()), (lists, fetches));
    eventually(
        "initial selected hydration completes",
        Duration::from_secs(5),
        || shared.report().unwrap()["hydrations"].as_u64().unwrap() > 0,
    );
    let hydrated = shared.report().unwrap()["hydrations"].as_u64().unwrap();
    let (sequence, deadline) = armed_after(&clock, 0);
    // Provider due time is wall-clock based; the independent worker's paced
    // wait is monotonic. Control both without shortening either production gate.
    due(&db);
    let before_due = deadline - Duration::from_nanos(1);
    assert!(clock.advance(sequence, before_due));
    eventually(
        "worker observes the instant before its armed deadline",
        Duration::from_secs(5),
        || clock.last_read() == Some(before_due),
    );
    assert_eq!((api.lists(), api.fetches()), (lists, fetches));
    assert!(clock.advance(sequence, deadline));
    let next = armed_after(&clock, sequence);
    assert!(api.lists() > lists);
    let lists = api.lists();
    eventually(
        "actual member loop completes the unchanged observation check",
        Duration::from_secs(5),
        || shared.report().unwrap()["hydrations"].as_u64().unwrap() > hydrated,
    );
    assert_eq!(
        api.fetches(),
        fetches,
        "unchanged remote observations never download again"
    );
    api.version.store(2, Ordering::SeqCst);
    due(&db);
    assert!(clock.advance(next.0, next.1));
    eventually(
        "changed remote File(None)/Catalog member refreshes before its one-hour backstop",
        Duration::from_secs(8),
        || text(&db, id, "version-2"),
    );
    assert!(api.lists() > lists);
    assert!(api.fetches() > fetches);
    assert_eq!(count(&db, unselected), 0);
    assert!(!api.lines().iter().any(|l| (l.contains("/messages")
        || l.contains("teleport-events"))
        && l.contains(unselected)));
    drop(capture);
    let after = api.lists();
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(api.lists(), after);
}

#[test]
fn selected_devin_worker_refreshes_shallow_catalog_and_selected_evidence() {
    remote_changes(false,"live::selected_remote::tests::selected_devin_worker_refreshes_shallow_catalog_and_selected_evidence")
}
#[test]
fn selected_claude_worker_refreshes_shallow_catalog_and_selected_evidence() {
    remote_changes(true,"live::selected_remote::tests::selected_claude_worker_refreshes_shallow_catalog_and_selected_evidence")
}

#[test]
fn held_remote_listing_does_not_hold_local_selected_capture() {
    let Some(home) = isolated_home(
        "live::selected_remote::tests::held_remote_listing_does_not_hold_local_selected_capture",
    ) else {
        return;
    };
    let api = Api::start(false);
    api.held.store(true, Ordering::SeqCst);
    let _env = [
        EnvGuard::set("RELAYHISTORY_DEVIN_API_KEY", "test-key"),
        EnvGuard::set("RELAYHISTORY_DEVIN_ORG_ID", "org-test"),
        EnvGuard::set("RELAYHISTORY_DEVIN_API_BASE_URL", api.url()),
    ];
    let path = home.join(".claude/projects/local/local.jsonl");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    append(&path, &transcript_line("local", "one"));
    let (directory, db, job) = selected(&home, "claude", "local");
    history::open(&db)
        .unwrap()
        .discover(ai_hist::DiscoveryOptions::default().sources([Source::Claude]))
        .unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Shared::default());
    let capture = crate::live::start(
        &directory,
        &config(&job, true),
        stopped,
        shared.clone(),
        short(),
    );
    struct Release(Arc<AtomicBool>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release(api.held.clone());
    eventually("remote request is held", Duration::from_secs(5), || {
        api.lists() == 1
    });
    eventually(
        "local member capture continues while remote is held",
        Duration::from_secs(5),
        || count(&db, "local") == 1,
    );
    append(&path, &transcript_line("local", "two"));
    eventually(
        "a second local turn is captured while remote remains held",
        Duration::from_secs(5),
        || count(&db, "local") == 2,
    );
    assert!(api.held.load(Ordering::SeqCst));
    assert_eq!(api.lists(), 1);
    api.held.store(false, Ordering::SeqCst);
    drop(capture);
}

#[test]
fn failed_remote_listing_keeps_provider_interval_pacing() {
    let Some(home) = isolated_home(
        "live::selected_remote::tests::failed_remote_listing_keeps_provider_interval_pacing",
    ) else {
        return;
    };
    let api = Api::start(false);
    api.fail.store(true, Ordering::SeqCst);
    let _env = [
        EnvGuard::set("RELAYHISTORY_DEVIN_API_KEY", "test-key"),
        EnvGuard::set("RELAYHISTORY_DEVIN_ORG_ID", "org-test"),
        EnvGuard::set("RELAYHISTORY_DEVIN_API_BASE_URL", api.url()),
    ];
    let (directory, db, _) = selected(&home, "devin", api::DEVIN);
    let stopped = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Shared::default());
    let options = LiveOptions {
        backstop: Duration::from_millis(5),
        ..short()
    };
    let worker = start(&directory, &stopped, &shared, &options);
    eventually(
        "failed listing marker written",
        Duration::from_secs(5),
        || db.with_extension("remote-enumerated").exists(),
    );
    for _ in 0..5 {
        assert!(enumerate(&db, &home, || false).unwrap().is_none());
    }
    assert_eq!(api.lists(), 1);
    assert_eq!(api.fetches(), 0);
    stopped.store(true, Ordering::Relaxed);
    drop(worker);
}

#[test]
fn unprepared_notification_restores_and_concurrent_publication_survives() {
    let Some(home)=isolated_home("live::selected_remote::tests::unprepared_notification_restores_and_concurrent_publication_survives")else{return};
    let store = history::open(&home.join("probe/history.db")).unwrap();
    let shared = Shared::default();
    shared.remote_catalogued.store(true, Ordering::Relaxed);
    let notice = members(&store, &[], &HashMap::new(), &shared).unwrap();
    assert!(!shared.remote_catalogued.load(Ordering::Relaxed));
    drop(notice);
    assert!(shared.remote_catalogued.load(Ordering::Relaxed));
    let mut notice = members(&store, &[], &HashMap::new(), &shared).unwrap();
    shared.remote_catalogued.store(true, Ordering::Relaxed);
    notice.prepared();
    drop(notice);
    assert!(shared.remote_catalogued.load(Ordering::Relaxed));
}

#[test]
fn remote_cost_and_retry_deadlines_use_elapsed_work_without_a_timer_cap() {
    let start = Instant::now();
    assert_eq!(
        deadline(
            start,
            start + Duration::from_secs(10),
            Duration::from_secs(60)
        ),
        start + Duration::from_secs(110)
    );
    assert_eq!(
        deadline(
            start,
            start + Duration::from_millis(1),
            Duration::from_secs(60)
        ),
        start + Duration::from_secs(60) + Duration::from_millis(1)
    );
}
#[test]
fn unconfigured_and_consent_disabled_enumeration_are_inert() {
    let Some(home) = isolated_home(
        "live::selected_remote::tests::unconfigured_and_consent_disabled_enumeration_are_inert",
    ) else {
        return;
    };
    let api = Api::start(true);
    let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", api.url());
    let (_directory, db, _job) = selected(&home, "claude", api::CLAUDE);
    assert!(enumerate(&db, &home, || false).unwrap().is_none());
    assert_eq!(api.lists(), 0);
    sharing(&home);
    let secret = credentials(chrono::Utc::now().timestamp_millis() + 3_600_000);
    let fake = FakeKeychain::holding(Some(&secret));
    let _host = crate::remote_sources::test_host::install(&home, &db, fake);
    let env = |key: &str| std::env::var(key).ok();
    let relay = agent_relay_probe::relay::workspace::relay_home(&env, &home);
    agent_relay_probe::relay::claude_dirs::ClaudeDirs::from_env(&env, &home, &relay)
        .set_cloud_sessions(false)
        .unwrap();
    for _ in 0..5 {
        assert!(enumerate(&db, &home, || false).unwrap().is_none());
    }
    assert_eq!((api.lists(), api.fetches()), (0, 0));
    assert!(!db.with_extension("remote-enumerated").exists());
}
#[test]
fn paused_member_loop_keeps_remote_notification_pending() {
    let Some(home) = isolated_home(
        "live::selected_remote::tests::paused_member_loop_keeps_remote_notification_pending",
    ) else {
        return;
    };
    let (directory, db, job) = selected(&home, "devin", api::DEVIN);
    let conn = delivery::open_db(&db).unwrap();
    delivery::pause_job(&conn, &job.job_id).unwrap();
    let readers = Readers::open(&db).unwrap();
    let shared = Shared::default();
    shared.remote_catalogued.store(true, Ordering::Relaxed);
    assert!(!poll_members(
        &directory,
        &readers,
        &job.job_id,
        &Arc::new(AtomicBool::new(false)),
        &shared,
        &mut Members::default(),
        &short()
    )
    .unwrap());
    assert!(shared.remote_catalogued.load(Ordering::Relaxed));
}
