use super::*;
use crate::live::tests::{append, isolated_home, transcript_line};

fn baseline(home: &Path, ids: &[&str]) {
    crate::save_json(
        &home.join(".agentworkforce/session-reset-baseline.json"),
        &ids.iter()
            .map(|id| agent_relay_probe::delivery::SessionIdentity {
                source: "claude".into(),
                session_id: (*id).into(),
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
}
fn rows(db: &Path) -> Vec<String> {
    rusqlite::Connection::open(db)
        .unwrap()
        .prepare("SELECT session_id FROM sessions ORDER BY session_id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
fn assert_shallow(db: &Path, expected: &[&str]) {
    assert_eq!(rows(db), expected);
    let conn = agent_relay_probe::delivery::open_db(db).unwrap();
    assert_eq!(
        agent_relay_probe::delivery::selectable_session_identities(&conn)
            .unwrap()
            .len(),
        expected.len()
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM session_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
fn files(home: &Path) -> Vec<PathBuf> {
    let root = home.join(".claude/projects/one");
    std::fs::create_dir_all(&root).unwrap();
    ["old", "fresh"]
        .map(|id| {
            let p = root.join(format!("{id}.jsonl"));
            append(&p, &transcript_line(id, id));
            p
        })
        .into()
}

#[test]
fn cold_inventory_never_restores_reset_metadata_or_counts() {
    let Some(home) = isolated_home(
        "history::incremental::reset_tests::cold_inventory_never_restores_reset_metadata_or_counts",
    ) else {
        return;
    };
    files(&home);
    baseline(&home, &["old"]);
    let db = home.join("probe/history.db");
    let mut store = open(&db).unwrap();
    let mut settings = RootSettings::default();
    settings.refresh(&mut store).unwrap();
    let mut rounds = reconciliation(&store, &settings).unwrap();
    for _ in 0..100 {
        let Some(mut round) = rounds.pop_front() else {
            break;
        };
        let step = inventory_step(&mut round, || false).unwrap();
        assert!(
            rows(&db).iter().all(|id| id != "old"),
            "every discovery-bearing slice prunes old metadata before publication"
        );
        if step.complete {
            rounds.completed(round)
        } else {
            rounds.push_back(round)
        }
    }
    assert!(rounds.is_empty());
    assert_shallow(&db, &["fresh"]);
}

#[test]
fn hot_inventory_prunes_after_base_and_all_extra_roots() {
    let Some(home) = isolated_home(
        "history::incremental::reset_tests::hot_inventory_prunes_after_base_and_all_extra_roots",
    ) else {
        return;
    };
    let mut paths = files(&home);
    baseline(&home, &["old", "extra-old"]);
    let extra = home.join(".claude-extra/projects/one");
    std::fs::create_dir_all(&extra).unwrap();
    for id in ["extra-old", "extra-fresh"] {
        let p = extra.join(format!("{id}.jsonl"));
        append(&p, &transcript_line(id, id));
        paths.push(p);
    }
    let db = home.join("probe/history.db");
    let store = open(&db).unwrap();
    let mut roots = store.roots().clone();
    roots.claude = home.join(".claude-extra");
    discover_paths_with_roots(&store, vec![Source::Claude], paths, vec![roots], || false).unwrap();
    assert_shallow(&db, &["extra-fresh", "fresh"]);
}

#[test]
fn incremental_partial_error_still_prunes_and_preserves_original_error() {
    let Some(home)=isolated_home("history::incremental::reset_tests::incremental_partial_error_still_prunes_and_preserves_original_error") else{return};
    files(&home);
    baseline(&home, &["old"]);
    let db = home.join("probe/history.db");
    let store = open(&db).unwrap();
    store
        .discover(DiscoveryOptions::default().sources([Source::Claude]))
        .unwrap();
    assert!(rows(&db).contains(&"old".into()));
    let result = prune_inventory_result(&db, Err(anyhow::anyhow!("partial incremental failure")));
    assert_eq!(
        result.unwrap_err().to_string(),
        "partial incremental failure"
    );
    assert_shallow(&db, &["fresh"]);
}

#[test]
fn enumeration_only_cold_step_never_reads_reset_baseline() {
    let Some(home) = isolated_home(
        "history::incremental::reset_tests::enumeration_only_cold_step_never_reads_reset_baseline",
    ) else {
        return;
    };
    let db = home.join("probe/history.db");
    let mut store = open(&db).unwrap();
    let mut settings = RootSettings::default();
    settings.refresh(&mut store).unwrap();
    baseline(&home, &[]);
    std::fs::write(
        home.join(".agentworkforce/session-reset-baseline.json"),
        "invalid baseline must not be parsed",
    )
    .unwrap();
    let mut rounds = reconciliation(&store, &settings).unwrap();
    let mut round = rounds.pop_front().unwrap();
    let step = inventory_step(&mut round, || false).unwrap();
    assert!(step.discovery.is_none());
}

#[test]
fn empty_baseline_cleanup_never_opens_a_missing_database() {
    let Some(home) = isolated_home(
        "history::incremental::reset_tests::empty_baseline_cleanup_never_opens_a_missing_database",
    ) else {
        return;
    };
    baseline(&home, &[]);
    let db = home.join("missing-parent/history.db");
    let mut step = ai_hist::ReconciliationStep::default();
    step.discovery = Some(Default::default());
    assert!(prune_inventory_result(&db, Ok(step)).is_ok());
    assert!(!db.exists());
    assert_eq!(
        prune_inventory_result(&db, Err(anyhow::anyhow!("unchanged error")))
            .unwrap_err()
            .to_string(),
        "unchanged error"
    );
    assert!(!db.exists());
}
