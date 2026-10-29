use super::*;
use crate::relay::session_query::test_catalog::{fixture, Fixture};

fn observe(f: &mut Fixture, values: &[(usize, &str, Option<&str>)]) {
    let query = request("");
    let version = f.catalog.version(&query, 1).unwrap();
    let initial = f.catalog.index.candidates(&query).unwrap();
    let observations: Vec<_> = values
        .iter()
        .map(|(id, model, effort)| f.observation(*id, model, *effort))
        .collect();
    f.catalog
        .observed_snapshot(&query, initial, &observations, version)
        .unwrap();
}

fn model_page(f: &Fixture, query: &SessionQueryParams) -> SessionQueryPage {
    f.catalog
        .index
        .candidates(query)
        .unwrap()
        .finish(query, vec![], None)
        .unwrap()
}

fn collect(f: &Fixture, mut query: SessionQueryParams) -> Vec<(String, String)> {
    let mut result = vec![];
    loop {
        let page = model_page(f, &query);
        result.extend(
            page.sessions
                .into_iter()
                .map(|row| (row.session_id, row.models.unwrap().join(", "))),
        );
        query.cursor = page.next_cursor;
        if query.cursor.is_none() {
            break;
        }
        assert!(
            result.len() < 4,
            "a retained cursor must not duplicate identities"
        );
    }
    result
}

#[test]
fn fresh_model_snapshot_updates_the_index_and_matching_effort_together() {
    let mut f = fixture();
    observe(&mut f, &[(0, "z-current", Some("low"))]);
    let row = f
        .catalog
        .index
        .get("codex:rw_000000")
        .unwrap()
        .unwrap()
        .upload
        .unwrap();
    assert_eq!(row.models.unwrap(), ["z-current"]);
    assert_eq!(row.reasoning_effort.as_deref(), Some("low"));
    let returned = model_page(&f, &request("id:rw_000000"));
    assert_eq!(
        returned.sessions[0].models.as_ref().unwrap(),
        &["z-current"]
    );
    assert_eq!(
        returned.sessions[0].reasoning_effort.as_deref(),
        Some("low")
    );
    let revision = f.catalog.index.revision;
    observe(&mut f, &[(0, "z-current", Some("low"))]);
    assert_eq!(
        f.catalog.index.revision, revision,
        "identical pairs must not revise the index"
    );
    observe(&mut f, &[(0, "z-current", None)]);
    assert_eq!(
        model_page(&f, &request("id:rw_000000")).sessions[0].reasoning_effort,
        None
    );
}

#[test]
fn one_reselection_crosses_model_boundaries_and_pages_the_returned_values_in_order() {
    for ascending in [true, false] {
        let mut f = fixture();
        let query = SessionQueryParams {
            sort: "model".into(),
            ascending,
            limit: Some(1),
            ..Default::default()
        };
        let version = f.catalog.version(&query, 1).unwrap();
        let initial = f.catalog.index.candidates(&query).unwrap();
        let (id, model) = if ascending {
            (0, "z-current")
        } else {
            (2, "0-current")
        };
        let observation = f.observation(id, model, Some("low"));
        let proof = initial.proof_cache_key.clone();
        let (selected, _) = f
            .catalog
            .observed_snapshot(&query, initial, &[observation], version)
            .unwrap();
        assert_eq!(
            selected.proof_cache_key, proof,
            "one batch retains its bounded proof progress namespace"
        );
        let result = selected.finish(&query, vec![], None).unwrap();
        assert_eq!(
            result.sessions[0].session_id, "rw_000001",
            "selection must use the updated Model index"
        );
        assert_eq!(result.sessions[0].models.as_ref().unwrap(), &["b-model"]);
        assert_eq!(
            result.sessions[0].reasoning_effort, None,
            "a newly selected identity keeps its indexed pair"
        );
        assert_eq!(
            result.sessions[0].status,
            UploadShareStatus::Checking,
            "an unobserved row is not asserted uploaded"
        );
        let rows = collect(&f, query);
        let expected = if ascending {
            vec![
                ("rw_000001", "b-model"),
                ("rw_000002", "c-model"),
                ("rw_000000", "z-current"),
            ]
        } else {
            vec![
                ("rw_000001", "b-model"),
                ("rw_000000", "a-old"),
                ("rw_000002", "0-current"),
            ]
        };
        assert_eq!(
            rows,
            expected
                .into_iter()
                .map(|(id, m)| (id.into(), m.into()))
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn retained_pages_keep_both_fields_even_for_same_model_new_effort() {
    for new_model in ["b-model", "z-new"] {
        let mut f = fixture();
        observe(&mut f, &[(1, "b-model", Some("high"))]);
        let mut query = SessionQueryParams {
            sort: "model".into(),
            ascending: true,
            limit: Some(1),
            ..Default::default()
        };
        query.cursor = model_page(&f, &query).next_cursor;
        observe(&mut f, &[(1, new_model, Some("low"))]);
        let before = f.catalog.index.revision;
        let candidates = f.catalog.index.candidates(&query).unwrap();
        let observations = [f.observation(1, "should-not-write", Some("ultra"))];
        let version = f.catalog.version(&query, 1).unwrap();
        let rejected = f.catalog.index.candidates(&query).unwrap();
        assert!(f
            .catalog
            .observed_snapshot(&query, rejected, &observations, version)
            .is_err());
        let mut badge = candidates.rows[0].upload.clone().unwrap();
        badge.reasoning_effort = Some("ultra".into());
        badge.models = Some(vec!["helper-new".into()]);
        badge.status = UploadShareStatus::Uploaded;
        let retained = candidates.finish(&query, vec![badge], None).unwrap();
        assert_eq!(retained.sessions[0].models.as_ref().unwrap(), &["b-model"]);
        assert_eq!(
            retained.sessions[0].reasoning_effort.as_deref(),
            Some("high")
        );
        assert_eq!(retained.sessions[0].status, UploadShareStatus::Uploaded);
        assert_eq!(
            f.catalog.index.revision, before,
            "retained requests never write execution metadata"
        );
    }
}

#[test]
fn missing_fallback_unexpected_duplicate_and_bad_path_observations_do_not_replace_a_positive_pair()
{
    let mut f = fixture();
    observe(&mut f, &[(0, "current", Some("low"))]);
    let query = request("");
    let revision = f.catalog.index.revision;
    let mut wrong = f.observation(0, "wrong-path", Some("high"));
    wrong.1.source_fingerprint = "0".repeat(64);
    let duplicate = f.observation(0, "duplicate", Some("high"));
    let mut unexpected = f.observation(1, "unrequested", None);
    unexpected.0 = "codex:missing".into();
    for values in [
        vec![],
        vec![wrong],
        vec![duplicate.clone(), duplicate],
        vec![unexpected],
    ] {
        let version = f.catalog.version(&query, 1).unwrap();
        let initial = f.catalog.index.candidates(&query).unwrap();
        f.catalog
            .observed_snapshot(&query, initial, &values, version)
            .unwrap();
        assert_eq!(f.catalog.index.revision, revision);
    }
    let mut fallback = f
        .catalog
        .index
        .get("codex:rw_000000")
        .unwrap()
        .unwrap()
        .upload
        .unwrap();
    fallback.models = Some(vec!["aggregate-fallback".into()]);
    fallback.reasoning_effort = Some("high".into());
    let retained = f
        .catalog
        .index
        .candidates(&query)
        .unwrap()
        .finish(&query, vec![fallback], None)
        .unwrap();
    let row = retained
        .sessions
        .iter()
        .find(|row| row.session_id == "rw_000000")
        .unwrap();
    assert_eq!(row.models.as_ref().unwrap(), &["current"]);
    assert_eq!(row.reasoning_effort.as_deref(), Some("low"));
}

#[test]
fn stamp_changes_preserve_observations_but_base_models_and_paths_retire_them() {
    let mut f = fixture();
    observe(&mut f, &[(0, "current", Some("low"))]);
    f.db.execute("UPDATE sessions SET source_stamp='new-stamp' WHERE source='codex' AND session_id='rw_000000'", []).unwrap();
    f.catalog.refresh().unwrap();
    assert_eq!(
        model_page(&f, &request("id:rw_000000")).sessions[0]
            .models
            .as_ref()
            .unwrap(),
        &["current"]
    );
    f.db.execute("UPDATE sessions SET models_json='[\"new-base\"]' WHERE source='codex' AND session_id='rw_000000'", []).unwrap();
    f.catalog.refresh().unwrap();
    let row = model_page(&f, &request("id:rw_000000")).sessions.remove(0);
    assert_eq!(row.models.unwrap(), ["new-base"]);
    assert_eq!(row.reasoning_effort, None);
    observe(&mut f, &[(0, "positive", Some("low"))]);
    f.db.execute(
        "UPDATE sessions SET raw_path=NULL WHERE source='codex' AND session_id='rw_000000'",
        [],
    )
    .unwrap();
    f.catalog.refresh().unwrap();
    assert_eq!(
        model_page(&f, &request("id:rw_000000")).sessions[0]
            .models
            .as_ref()
            .unwrap(),
        &["new-base"]
    );
    observe(&mut f, &[(0, "cannot-bind-missing-path", Some("high"))]);
    assert_eq!(
        model_page(&f, &request("id:rw_000000")).sessions[0].reasoning_effort,
        None
    );
}

#[test]
fn settings_epoch_restores_base_before_inclusion_reindexing() {
    let mut f = fixture();
    observe(&mut f, &[(0, "positive", Some("low"))]);
    let config = f.path.parent().unwrap().join("config.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
    value["changed_epoch"] = serde_json::json!(true);
    std::fs::write(config, value.to_string()).unwrap();
    f.catalog.refresh().unwrap();
    let row = model_page(&f, &request("id:rw_000000")).sessions.remove(0);
    assert_eq!(row.models.unwrap(), ["a-old"]);
    assert_eq!(row.reasoning_effort, None);
}

#[test]
fn a_newer_fresh_observation_fences_an_older_detached_continuation() {
    let mut f = fixture();
    let query = request("");
    let version = f.catalog.version(&query, 1).unwrap();
    let old = f.catalog.index.candidates(&query).unwrap();
    observe(&mut f, &[(0, "newer", Some("high"))]);
    let revision = f.catalog.index.revision;
    let stale = f.observation(0, "older", Some("low"));
    assert!(f
        .catalog
        .observed_snapshot(&query, old, &[stale], version)
        .is_err());
    assert_eq!(f.catalog.index.revision, revision);
    assert_eq!(
        model_page(&f, &request("id:rw_000000")).sessions[0]
            .models
            .as_ref()
            .unwrap(),
        &["newer"]
    );
}

#[test]
fn empty_and_identical_observations_reuse_the_fenced_selection_and_recompute_version() {
    let mut f = fixture();
    observe(&mut f, &[(0, "current", Some("high"))]);
    let query = request("id:rw_000000");
    for values in [vec![], vec![f.observation(0, "current", Some("high"))]] {
        let version = f.catalog.version(&query, 43).unwrap();
        let initial = f.catalog.index.candidates(&query).unwrap();
        let proof = initial.proof_cache_key.clone();
        let revision = f.catalog.index.revision;
        let selections = f.catalog.index.candidate_selections.get();
        let expected_version = version.revision;
        let (selected, version) = f
            .catalog
            .observed_snapshot(&query, initial, &values, version)
            .unwrap();
        assert_eq!(f.catalog.index.revision, revision);
        assert_eq!(
            f.catalog.index.candidate_selections.get(),
            selections,
            "an unchanged observation batch must not perform a second SQL selection"
        );
        assert_eq!(version.revision, expected_version);
        assert_eq!(selected.proof_cache_key, proof);
        let page = selected.finish(&query, vec![], None).unwrap();
        assert_eq!(page.sessions[0].models.as_ref().unwrap(), &["current"]);
        assert_eq!(page.sessions[0].reasoning_effort.as_deref(), Some("high"));
    }
}
