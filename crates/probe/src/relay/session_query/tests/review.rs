use super::*;
use crate::relay::contract::account::{SessionFacetParams, SessionQueryPresentation};

#[test]
fn unchanged_archive_snapshots_skip_historical_keys_and_one_change_reindexes_one_row() {
    use std::{collections::BTreeSet, sync::Arc};
    let mut index = Index::new().unwrap();
    index.put(row(0, "first")).unwrap();
    index.put(row(1, "second")).unwrap();
    let mut archives: Arc<BTreeSet<String>> = Arc::new(
        (0..47_000)
            .map(|n| format!("codex:old-archive-{n}"))
            .collect(),
    );
    index
        .live(vec![], archives.clone(), Default::default())
        .unwrap();
    let examined = index.archive_inputs_examined;
    for _ in 0..30 {
        index
            .live(vec![], archives.clone(), Default::default())
            .unwrap();
    }
    assert_eq!(
        index.archive_inputs_examined, examined,
        "Unchanged pages must not iterate or rebuild the complete archive set"
    );
    let mut retained = request("");
    retained.sort = "session".into();
    retained.ascending = true;
    retained.limit = Some(1);
    retained.cursor = page(&index, &retained).next_cursor;
    let before = index.revision;
    Arc::make_mut(&mut archives).insert("codex:rw_000001".into());
    index.live(vec![], archives, Default::default()).unwrap();
    assert_eq!(index.revision, before + 1);
    assert!(page(&index, &retained).archived_keys.unwrap().is_empty(), "Retained cursor labels must use the same historical archive classification as its sort keys");
    let mut query = request("");
    query.sort = "status".into();
    query.ascending = true;
    assert_eq!(
        page(&index, &query).archived_keys.unwrap(),
        ["codex:rw_000001"]
    );
    assert_eq!(
        page(&index, &query)
            .sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        ["rw_000001", "rw_000000"]
    );
}

#[test]
fn terminal_large_row_does_not_reserve_an_unused_cursor_and_preparing_changes_fence_cursors() {
    let mut index = Index::new().unwrap();
    let mut large = row(1, "large final row");
    large.upload.as_mut().unwrap().cwd = Some("d".repeat(PAGE_BYTES - 2048));
    index.put(large).unwrap();
    let mut query = request("");
    query.sort = "directory".into();
    let result = page(&index, &query);
    assert_eq!(result.sessions.len(), 1);
    assert!(result.next_cursor.is_none());
    assert!(serde_json::to_vec(&result).unwrap().len() <= PAGE_BYTES);

    let mut index = Index::new().unwrap();
    index.put(row(1, "first")).unwrap();
    index.put(row(2, "second")).unwrap();
    let mut query = request("upload:preparing");
    query.limit = Some(1);
    query.presentation = Some(SessionQueryPresentation {
        preparing: vec!["codex:rw_000002".into()],
        ..Default::default()
    });
    query.cursor = page(&index, &query).next_cursor;
    assert!(query.cursor.is_some());
    query.presentation.as_mut().unwrap().preparing.clear();
    assert!(
        index.candidates(&query).is_err(),
        "Continuation must not reuse a different preparing filter basis"
    );
}

#[test]
fn serialized_page_budget_counts_escaped_cursor_and_long_paths() {
    let mut index = Index::new().unwrap();
    for id in 0..200 {
        let mut row = row(id, "A \"quoted\" title\\with escapes");
        row.upload.as_mut().unwrap().cwd =
            Some(format!("/work/{}/rw_{id:06}", "long\\path\"".repeat(500)));
        index.put(row).unwrap();
    }
    let mut query = request("");
    query.sort = "directory".into();
    let mut total = 0;
    loop {
        let result = page(&index, &query);
        assert!(serde_json::to_vec(&result).unwrap().len() <= PAGE_BYTES);
        assert!(!result.sessions.is_empty());
        total += result.sessions.len();
        query.cursor = result.next_cursor;
        if query.cursor.is_none() {
            break;
        }
    }
    assert_eq!(total, 200);
}

#[test]
fn independent_facets_cover_offpage_projects_and_bound_values_and_bytes() {
    let mut index = Index::new().unwrap();
    for id in 0..405 {
        let mut row = row(id, "history");
        row.upload.as_mut().unwrap().project =
            Some(format!("project-{id:03}-{}", "p\\\"".repeat(160)));
        index.put(row).unwrap();
    }
    assert_eq!(page(&index, &request("")).sessions.len(), 200);
    let mut query = SessionFacetParams {
        cursor: None,
        limit: Some(200),
    };
    let mut projects = HashSet::new();
    let revision = index.facet_revision;
    let mut harnesses = vec![];
    loop {
        let result = index.facets(&query).unwrap();
        assert!(result.projects.len() + result.harnesses.len() <= 200);
        assert!(serde_json::to_vec(&result).unwrap().len() <= 64 * 1024);
        projects.extend(result.projects);
        harnesses.extend(result.harnesses);
        query.cursor = result.next_cursor;
        if query.cursor.is_none() {
            break;
        }
    }
    assert_eq!(projects.len(), 405);
    assert_eq!(harnesses, ["codex"]);
    let old_revision = index
        .facets(&SessionFacetParams {
            cursor: None,
            limit: Some(1),
        })
        .unwrap()
        .revision;
    let replacement = Index::new().unwrap();
    assert_ne!(
        replacement
            .facets(&SessionFacetParams {
                cursor: None,
                limit: Some(1)
            })
            .unwrap()
            .revision,
        old_revision,
        "Replacement indexes must invalidate client facet caches"
    );

    let mut changed = index.get("codex:rw_000000").unwrap().unwrap();
    changed.upload.as_mut().unwrap().title = "renamed".into();
    index.put(changed).unwrap();
    assert_eq!(
        index.facet_revision, revision,
        "Metadata writes do not restart facet paging"
    );
    let first = index
        .facets(&SessionFacetParams {
            cursor: None,
            limit: Some(1),
        })
        .unwrap();
    index.remove("codex:rw_000404").unwrap();
    assert!(index
        .facets(&SessionFacetParams {
            cursor: first.next_cursor,
            limit: Some(1)
        })
        .is_err());
}

#[test]
fn retained_page_enrichment_preserves_snapshot_catalog_fields() {
    let mut index = Index::new().unwrap();
    for id in 0..4 {
        index.put(row(id, "snapshot title")).unwrap();
    }
    let mut query = request("title:snapshot project:relay");
    query.limit = Some(1);
    let first = page(&index, &query);
    let mut changed = row(2, "renamed title").upload.unwrap();
    changed.project = Some("other project".into());
    changed.models = Some(vec!["new model".into()]);
    changed.last_activity_ms = Some(999999);
    index
        .put(LocalSessionRow {
            upload: Some(changed.clone()),
            relay: None,
        })
        .unwrap();
    query.cursor = first.next_cursor;
    let result = index
        .candidates(&query)
        .unwrap()
        .finish(&query, vec![changed], None)
        .unwrap();
    assert_eq!(result.sessions.len(), 1);
    let kept = &result.sessions[0];
    assert_eq!(kept.session_id, "rw_000002");
    assert_eq!(kept.title, "snapshot title");
    assert_eq!(kept.project.as_deref(), Some("relay"));
    assert_eq!(kept.models.as_ref().unwrap(), &["model-realistic"]);
    assert_eq!(kept.last_activity_ms, Some(2));
}

fn local(id: usize, name: &str) -> LocalSession {
    serde_json::from_value(serde_json::json!({
        "target":{"kind":"codex","id":format!("rw_{id:06}")},"title":name,"project":"relay","directory":"/work/relay",
        "live":true,"running":true,"updated_at_ms":1,"registration":{"name":name,"address":"fixture","added_by_session":false,"push":null},"suggested_name":name
    })).unwrap()
}
#[test]
fn presentation_changes_reindex_status_and_effective_toggles_once() {
    let mut index = Index::new().unwrap();
    for id in 0..3 {
        index.put(row(id, "history")).unwrap();
    }
    let locals = vec![local(0, "active"), local(1, "idle")];
    index
        .live(
            locals.clone(),
            Default::default(),
            SessionQueryPresentation::default(),
        )
        .unwrap();
    let mut presentation = SessionQueryPresentation::default();
    presentation.idle_names.push("idle".into());
    presentation
        .relay_states
        .insert("codex:rw_000000".into(), false);
    presentation
        .upload_states
        .insert("codex:rw_000001".into(), false);
    index
        .live(
            locals.clone(),
            std::sync::Arc::new(["codex:rw_000000".into()].into_iter().collect()),
            presentation.clone(),
        )
        .unwrap();
    for (sort, expected) in [
        ("status", vec![0, 2, 1]),
        ("relay", vec![0, 1, 2]),
        ("upload", vec![1, 0, 2]),
    ] {
        let mut query = request("");
        query.sort = sort.into();
        query.ascending = true;
        assert_eq!(
            page(&index, &query)
                .sessions
                .into_iter()
                .map(|r| r.session_id)
                .collect::<Vec<_>>(),
            expected
                .into_iter()
                .map(|id| format!("rw_{id:06}"))
                .collect::<Vec<_>>(),
            "{sort}"
        );
    }
    let revision = index.revision;
    index
        .live(
            locals,
            std::sync::Arc::new(["codex:rw_000000".into()].into_iter().collect()),
            presentation,
        )
        .unwrap();
    assert_eq!(
        index.revision, revision,
        "Repeated identical presentation must not rewrite versions"
    );
}

#[test]
fn near_limit_prefix_continues_before_pending_nonmatching_and_hidden_cursors() {
    for mode in ["pending", "nonmatching", "hidden"] {
        let mut index = Index::new().unwrap();
        for id in 0..100 {
            let mut row = row(id, "matched");
            row.upload.as_mut().unwrap().cwd = Some(if id == 99 && mode != "pending" {
                format!("zzz{}", "long".repeat(800))
            } else {
                "aaa".into()
            });
            if id == 99 {
                row.upload.as_mut().unwrap().status = if mode == "pending" {
                    UploadShareStatus::Checking
                } else {
                    UploadShareStatus::NotShared
                };
            }
            index.put(row).unwrap();
        }
        let mut query = request("upload:uploaded");
        query.sort = "directory".into();
        query.ascending = true;
        if mode == "hidden" {
            query.hidden.push("codex:rw_000099".into());
        }
        let candidates = index.candidates(&query).unwrap();
        let calibration = SessionQueryPage {
            archived_keys: Some(vec![]),
            unchanged: false,
            verification_pending: false,
            sessions: candidates.rows[..99]
                .iter()
                .map(|r| r.upload.clone().unwrap())
                .collect(),
            local_sessions: vec![],
            next_cursor: Some(candidates.cursors[98].clone()),
            revision: candidates.revision,
            candidates_scanned: 100,
        };
        let base = serde_json::to_vec(&calibration).unwrap().len();
        let mut last = row(98, &"x".repeat(PAGE_BYTES - base - 16 + "matched".len()));
        last.upload.as_mut().unwrap().cwd = Some("aaa".into());
        index.put(last).unwrap();
        let mut ids = vec![];
        let mut pending_seen = false;
        loop {
            let candidates = index.candidates(&query).unwrap();
            let enriched = if pending_seen {
                vec![row(99, "matched").upload.unwrap()]
            } else {
                vec![]
            };
            let result=candidates.finish(&query,enriched,None).expect("A fitting prefix must return a continuation instead of losing every row at a later cursor");
            assert!(serde_json::to_vec(&result).unwrap().len() <= PAGE_BYTES);
            ids.extend(result.sessions.into_iter().map(|r| r.session_id));
            pending_seen |= result.verification_pending;
            query.cursor = result.next_cursor;
            if query.cursor.is_none() {
                break;
            }
        }
        let count = if mode == "pending" { 100 } else { 99 };
        assert_eq!(
            ids,
            (0..count)
                .map(|id| format!("rw_{id:06}"))
                .collect::<Vec<_>>(),
            "{mode}"
        );
        assert_eq!(pending_seen, mode == "pending");
    }
}

#[test]
fn archive_snapshot_keys_share_the_exact_serialized_page_budget() {
    let mut index = Index::new().unwrap();
    for n in 0..200 {
        index.put(row(n, &"quoted\"title\\".repeat(300))).unwrap();
    }
    let archives = std::sync::Arc::new((0..200).map(|n| format!("codex:rw_{n:06}")).collect());
    index.live(vec![], archives, Default::default()).unwrap();
    let mut query = request("");
    let mut total = 0;
    loop {
        let result = page(&index, &query);
        assert!(serde_json::to_vec(&result).unwrap().len() <= PAGE_BYTES);
        assert_eq!(
            result.archived_keys.as_ref().unwrap().len(),
            result.sessions.len()
        );
        total += result.sessions.len();
        query.cursor = result.next_cursor;
        if query.cursor.is_none() {
            break;
        }
    }
    assert_eq!(total, 200);
}
