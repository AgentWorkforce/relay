//! Actual acquisition must use the validated choices even inside the refresh gap.
use super::*;
use crate::live::tests::{append, isolated_home, transcript_line};

struct Fixture {
    store: SessionStore,
    settings: RootSettings,
    dirs: ClaudeDirs,
    valid: Vec<u8>,
    private: PathBuf,
    allowed: PathBuf,
}
impl Fixture {
    fn new(home: &Path) -> Self {
        let private = home.join(".claude-work/projects/private/private.jsonl");
        let allowed = home.join(".claude-personal/projects/allowed/allowed.jsonl");
        for (path, id) in [(&private, "private"), (&allowed, "allowed")] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            append(path, &transcript_line(id, "one"));
        }
        let env = |key: &str| std::env::var(key).ok();
        let dirs = ClaudeDirs::from_env(&env, home, &relay_home(&env, home));
        // Keep process discovery synthetic too: this isolated child must not
        // import config paths from unrelated live Claude processes.
        dirs.remember_running(&agent_relay_probe::relay::process::FakeProcesses::default());
        dirs.set_shared(
            home.join(".claude-work").to_str().unwrap(),
            false,
            &home.join(".claude"),
        )
        .unwrap();
        let valid = std::fs::read(dirs.file.as_ref().unwrap()).unwrap();
        let mut store = open(&home.join("probe/history.db")).unwrap();
        let mut settings = RootSettings::default();
        assert!(settings.refresh(&mut store).unwrap());
        std::fs::write(dirs.file.as_ref().unwrap(), b"{").unwrap();
        assert!(
            !settings.refresh(&mut store).unwrap(),
            "exercise the cached validated snapshot, without a second disk refresh"
        );
        Self {
            store,
            settings,
            dirs,
            valid,
            private,
            allowed,
        }
    }

    fn rounds(&self, shallow: bool) {
        let mut rounds = reconciliation(&self.store, &self.settings).unwrap();
        for _ in 0..1000 {
            let Some(mut round) = rounds.pop_front() else {
                return;
            };
            let step = if shallow {
                inventory_step(&mut round, || false).unwrap()
            } else {
                reconcile_step(&mut round, || false).unwrap()
            };
            if !step.complete {
                rounds.push_back(round);
            }
        }
        panic!("synthetic snapshot round did not finish");
    }

    fn events(&self, session: &str) -> i64 {
        rusqlite::Connection::open(self.store.db_path())
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id=?",
                [session],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn catalogued(&self, session: &str) -> bool {
        self.store
            .sessions(CatalogQuery::default())
            .any(|row| row.unwrap().session_id == session)
    }
}

#[test]
fn cached_extra_root_denial_fences_actual_cold_and_hot_acquisition() {
    let Some(home) = isolated_home("history::roots::snapshot_tests::cached_extra_root_denial_fences_actual_cold_and_hot_acquisition") else { return; };
    let mut f = Fixture::new(&home);
    // Construct the actual SDK rounds AFTER the settings file became malformed.
    f.rounds(false);
    assert_eq!(
        (f.catalogued("private"), f.events("private")),
        (false, 0),
        "denied transcript must not enter the catalog or acquire evidence"
    );
    assert!(f.catalogued("allowed"));
    assert_eq!(
        f.events("allowed"),
        1,
        "a shared sibling must still acquire"
    );
    let extra = f.settings.extra_claude_roots(&f.store).unwrap();
    let watch =
        crate::inventory::Watch::start_paths(watched_paths_for(&f.store, extra.clone()), |_| {})
            .unwrap();
    assert!(!watch.covers(&f.private));
    assert!(watch
        .sources(&f.allowed)
        .any(|source| source == Source::Claude));
    for (path, id) in [(&f.private, "private"), (&f.allowed, "allowed")] {
        append(path, &transcript_line(id, "two"));
    }
    sweep_paths_with_roots(
        &f.store,
        true,
        Some(vec![Source::Claude]),
        Some(vec![f.private.clone(), f.allowed.clone()]),
        extra,
        || false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        f.events("private"),
        0,
        "an exact denied hot path must not acquire"
    );
    assert_eq!(f.events("allowed"), 2);
    // A denied catalog row left from an earlier sharing choice must also be
    // excluded from fallback admission, independent of cold discovery.
    let mut private_roots = f.store.roots().clone();
    private_roots.claude = home.join(".claude-work");
    open_with(f.store.db_path(), private_roots)
        .unwrap()
        .discover(DiscoveryOptions::default().sources([Source::Claude]))
        .unwrap();
    assert!(f.catalogued("private"));
    let recent = RecentPaths::default()
        .poll_with_roots(&f.store, f.settings.extra_claude_roots(&f.store).unwrap())
        .unwrap();
    assert!(recent.iter().any(|(_, path)| *path == f.allowed));
    assert!(!recent.iter().any(|(_, path)| *path == f.private));
    // Dynamic sibling discovery stays available without changing snapshot choices.
    std::fs::create_dir_all(home.join(".claude-new/projects/new")).unwrap();
    assert!(f
        .settings
        .extra_claude_roots(&f.store)
        .unwrap()
        .iter()
        .any(|root| root.claude == home.join(".claude-new")));
    f.settings.invalidate();
    assert!(f.settings.refresh(&mut f.store).is_err());
    assert!(f.settings.extra_claude_roots(&f.store).is_err());
    std::fs::write(f.dirs.file.as_ref().unwrap(), &f.valid).unwrap();
    f.dirs
        .set_shared(
            home.join(".claude-work").to_str().unwrap(),
            true,
            &home.join(".claude"),
        )
        .unwrap();
    f.settings.invalidate();
    assert!(f.settings.refresh(&mut f.store).unwrap());
    f.rounds(false);
    assert_eq!(
        f.events("private"),
        2,
        "restored valid consent must allow acquisition again"
    );
}

#[test]
fn cached_extra_root_denial_fences_shallow_inventory_and_hot_discovery() {
    let Some(home) = isolated_home("history::roots::snapshot_tests::cached_extra_root_denial_fences_shallow_inventory_and_hot_discovery") else { return; };
    let f = Fixture::new(&home);
    f.rounds(true);
    assert!(
        !f.catalogued("private"),
        "shallow rounds must not inventory denied siblings"
    );
    assert!(f.catalogued("allowed"));
    discover_paths_with_roots(
        &f.store,
        vec![Source::Claude],
        vec![f.private.clone(), f.allowed.clone()],
        f.settings.extra_claude_roots(&f.store).unwrap(),
        || false,
    )
    .unwrap();
    assert!(
        !f.catalogued("private"),
        "hot discovery must keep the same denial"
    );
    assert_eq!(f.events("private"), 0);
    assert_eq!(
        f.events("allowed"),
        0,
        "selected-only inventory must stay shallow"
    );
}
