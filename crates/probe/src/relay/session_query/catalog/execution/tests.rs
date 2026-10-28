use super::*;
use crate::relay::session_query::test_catalog::{fixture, Fixture};

fn observe(f: &mut Fixture) {
    let query = SessionQueryParams::default();
    let version = f.catalog.version(&query, 1).unwrap();
    let initial = f.catalog.index.candidates(&query).unwrap();
    let value = f.observation(0, "positive", Some("low"));
    f.catalog
        .observed_snapshot(&query, initial, &[value], version)
        .unwrap();
}

fn pair(f: &Fixture) -> (Vec<String>, Option<String>) {
    let row = f
        .catalog
        .index
        .get("codex:rw_000000")
        .unwrap()
        .unwrap()
        .upload
        .unwrap();
    (row.models.unwrap(), row.reasoning_effort)
}

#[test]
fn deleted_and_delegated_identities_drop_both_cache_maps() {
    for delegated in [false, true] {
        let mut f = fixture();
        observe(&mut f);
        assert_eq!(f.catalog.execution.sources.len(), 3);
        assert_eq!(f.catalog.execution.overlays.len(), 1);
        if delegated {
            f.db.execute("INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,relationship,identity_status,evidence_kind,created_ms,updated_ms) VALUES('codex','rw_000001','edge','rw_000000','delegated','observed','fixture',0,0)", []).unwrap();
        } else {
            f.db.execute(
                "DELETE FROM sessions WHERE source='codex' AND session_id='rw_000000'",
                [],
            )
            .unwrap();
        }
        f.catalog.refresh().unwrap();
        assert!(f.catalog.index.get("codex:rw_000000").unwrap().is_none());
        assert_eq!(f.catalog.execution.sources.len(), 2);
        assert!(f.catalog.execution.overlays.is_empty());
    }
}

#[test]
fn ignored_reset_and_restore_do_not_resurrect_a_positive_pair() {
    let mut f = fixture();
    observe(&mut f);
    let baseline = f
        .home
        .path()
        .join(".agentworkforce/session-reset-baseline.json");
    std::fs::create_dir_all(baseline.parent().unwrap()).unwrap();
    std::fs::write(
        &baseline,
        r#"[{"source":"codex","session_id":"rw_000000"}]"#,
    )
    .unwrap();
    f.catalog.refresh().unwrap();
    assert!(f.catalog.index.get("codex:rw_000000").unwrap().is_none());
    assert!(!f.catalog.execution.sources.contains_key("codex:rw_000000"));
    assert!(f.catalog.execution.overlays.is_empty());
    std::fs::remove_file(baseline).unwrap();
    f.catalog.refresh().unwrap();
    assert_eq!(pair(&f), (vec!["a-old".into()], None));
}

#[test]
fn path_replacement_during_the_helper_rejects_its_new_source_against_the_old_snapshot() {
    let mut f = fixture();
    observe(&mut f);
    let query = SessionQueryParams::default();
    let version = f.catalog.version(&query, 1).unwrap();
    let initial = f.catalog.index.candidates(&query).unwrap();
    let new_path = f.home.path().join("replacement.jsonl");
    f.db.execute(
        "UPDATE sessions SET raw_path=?1 WHERE source='codex' AND session_id='rw_000000'",
        [new_path.to_string_lossy().as_ref()],
    )
    .unwrap();
    let mut value = f.observation(0, "new-source", Some("high"));
    value.1.source_fingerprint = super::super::super::observation::source_fingerprint(&new_path);
    f.catalog
        .observed_snapshot(&query, initial, &[value], version)
        .unwrap();
    assert_eq!(pair(&f), (vec!["positive".into()], Some("low".into())));
    f.catalog.refresh().unwrap();
    assert_eq!(pair(&f), (vec!["a-old".into()], None));
    assert!(f.catalog.execution.overlays.is_empty());
}

#[test]
fn a_same_path_rewrite_without_a_positive_context_has_the_declared_last_observed_freshness() {
    let mut f = fixture();
    observe(&mut f);
    std::fs::write(
        &f.source_paths[0],
        "{\"type\":\"turn_context\",\"payload\":{\"effort\":\"high\"}}\n",
    )
    .unwrap();
    // A stamp-only SDK update supplies no different base model evidence.
    f.db.execute("UPDATE sessions SET source_stamp='same-path-rewrite' WHERE source='codex' AND session_id='rw_000000'", []).unwrap();
    f.catalog.refresh().unwrap();
    assert_eq!(pair(&f), (vec!["positive".into()], Some("low".into())));
    assert!(f.store.head_revision().unwrap().revision > 0);
}

#[test]
fn rebuilding_the_disposable_index_drops_observations_and_rejects_its_old_fence() {
    let mut f = fixture();
    let query = SessionQueryParams::default();
    let version = f.catalog.version(&query, 1).unwrap();
    let old = f.catalog.index.candidates(&query).unwrap();
    observe(&mut f);
    f.catalog = CatalogIndex::open(&f.path, f.home.path(), &f.relay_home).unwrap();
    assert_eq!(pair(&f), (vec!["a-old".into()], None));
    let value = f.observation(0, "stale", Some("high"));
    assert!(f
        .catalog
        .observed_snapshot(&query, old, &[value], version)
        .is_err());
    assert!(f.catalog.execution.overlays.is_empty());
}
