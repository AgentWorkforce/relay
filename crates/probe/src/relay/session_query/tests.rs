use super::*;
use crate::relay::contract::account::UploadShareStatus;
use rusqlite::StatementStatus;

fn row(id: usize, title: &str) -> LocalSessionRow {
    LocalSessionRow {
        upload: Some(UploadSession {
            avatar: None,
            source: "codex".into(),
            session_id: format!("rw_{id:06}"),
            title: title.into(),
            cwd: Some("/work/relay".into()),
            project: Some("relay".into()),
            git_branch: None,
            first_activity_ms: Some(id as i64),
            last_activity_ms: Some(id as i64),
            is_agent: false,
            host: None,
            models: Some(vec!["model-realistic".into()]),
            reasoning_effort: Some("high".into()),
            included: true,
            status: UploadShareStatus::Uploaded,
        }),
        relay: None,
    }
}
fn request(query: &str) -> SessionQueryParams {
    SessionQueryParams {
        query: query.into(),
        sort: "updated".into(),
        ..Default::default()
    }
}
fn page(index: &Index, request: &SessionQueryParams) -> SessionQueryPage {
    index
        .candidates(request)
        .unwrap()
        .finish(request, vec![], None)
        .unwrap()
}

#[test]
fn large_catalog_sparse_search_and_keyset_pages_are_bounded() {
    let mut index = Index::new().unwrap();
    index.db.execute_batch("BEGIN").unwrap();
    for id in 0..47_000 {
        index
            .put(row(
                id,
                if id == 17 {
                    "Investigate CPU regression"
                } else {
                    "Archived coding conversation"
                },
            ))
            .unwrap();
    }
    index.db.execute_batch("COMMIT").unwrap();
    let found = page(&index, &request("CPU"));
    assert_eq!(found.sessions.len(), 1);
    assert_eq!(found.sessions[0].session_id, "rw_000017");
    assert_eq!(
        found.candidates_scanned, 1,
        "Sparse search must not deserialize unrelated historical rows"
    );
    assert!(serde_json::to_vec(&found).unwrap().len() < PAGE_BYTES);
    let sql = page_sql(
        "updated",
        "desc",
        r#"rowid IN (SELECT rowid FROM search WHERE search MATCH '"cpu"') AND valid_to IS NULL"#,
        201,
    );
    let mut stmt = index.db.prepare(&sql).unwrap();
    assert_eq!(stmt.query_map([], |_| Ok(())).unwrap().count(), 1);
    assert!(
        stmt.get_status(StatementStatus::VmStep) < 6000,
        "Sparse indexed substring must not walk the 47k order index"
    );
    for ascending in [true, false] {
        let direction = if ascending { "asc" } else { "desc" };
        for cursor in [false, true] {
            let boundary = order_key(Some("09223372036854799308"), "codex:rw_023500", ascending);
            let predicate = if cursor {
                format!("order_updated_{direction}>'{boundary}'")
            } else {
                "1".into()
            };
            let sql = page_sql("updated", direction, &predicate, 201);
            let plan: Vec<String> = index
                .db
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap()
                .query_map([], |r| r.get(3))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            assert!(
                plan.iter()
                    .any(|p| p.contains(&format!("sort_updated_{direction}"))),
                "{plan:?}"
            );
            assert!(!plan.iter().any(|p| p.contains("TEMP B-TREE")), "{plan:?}");
            let mut stmt = index.db.prepare(&sql).unwrap();
            let count = stmt.query_map([], |_| Ok(())).unwrap().count();
            assert_eq!(count, 201);
            assert!(
                stmt.get_status(StatementStatus::VmStep) < 6000,
                "Page seek work grew with 47k catalog: {}",
                stmt.get_status(StatementStatus::VmStep)
            );
        }
    }
    let first = page(&index, &request(""));
    assert_eq!(first.sessions.len(), PAGE_ROWS);
    assert!(first.next_cursor.is_some());
    let mut next = request("");
    next.cursor = first.next_cursor;
    let second = page(&index, &next);
    assert_eq!(second.sessions.len(), PAGE_ROWS);
    let first_ids: HashSet<_> = first.sessions.iter().map(|s| &s.session_id).collect();
    assert!(second
        .sessions
        .iter()
        .all(|s| !first_ids.contains(&s.session_id)));
}

#[test]
fn open_cursor_retains_snapshot_during_inserts_updates_and_deletes() {
    let mut index = Index::new().unwrap();
    for id in 0..8 {
        index.put(row(id, "original")).unwrap();
    }
    let mut query = request("original");
    query.limit = Some(2);
    let first = page(&index, &query);
    index.put(row(100, "incoming")).unwrap();
    let mut changed = row(5, "renamed");
    changed.upload.as_mut().unwrap().last_activity_ms = Some(1000);
    index.put(changed).unwrap();
    index.remove("codex:rw_000004").unwrap();
    query.cursor = first.next_cursor;
    let second = page(&index, &query);
    assert_eq!(
        second
            .sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        ["rw_000005", "rw_000004"]
    );
    assert_eq!(second.sessions[0].title, "original");
    let current = page(&index, &request("renamed"));
    assert_eq!(current.sessions.len(), 1);
    query.query = "different".into();
    assert!(
        index.candidates(&query).is_err(),
        "Cursor must be fenced to its query"
    );
    let replacement = Index::new().unwrap();
    query.query = "original".into();
    assert!(
        replacement.candidates(&query).is_err(),
        "Replacement index must reject the old epoch"
    );
}

#[test]
fn sparse_upload_filters_continue_without_autoloading_or_losing_old_matches() {
    let mut index = Index::new().unwrap();
    for id in 0..405 {
        let mut row = row(id, "conversation");
        row.upload.as_mut().unwrap().status = if id == 1 {
            UploadShareStatus::Uploaded
        } else {
            UploadShareStatus::Queued
        };
        index.put(row).unwrap();
    }
    let mut query = request("upload:uploaded");
    let first = page(&index, &query);
    assert!(first.sessions.is_empty());
    assert!(first.next_cursor.is_some());
    assert_eq!(first.candidates_scanned, 200);
    query.cursor = first.next_cursor;
    let second = page(&index, &query);
    assert!(second.sessions.is_empty());
    assert!(second.next_cursor.is_some());
    assert_eq!(second.candidates_scanned, 200);
    query.cursor = second.next_cursor;
    let last = page(&index, &query);
    assert_eq!(last.sessions.len(), 1);
    assert_eq!(last.sessions[0].session_id, "rw_000001");
    assert!(last.next_cursor.is_none());
}

#[test]
fn alternative_fields_and_negative_terms_preserve_shared_query_semantics() {
    let mut index = Index::new().unwrap();
    let mut a = row(1, "hello there");
    a.upload.as_mut().unwrap().project = Some("other".into());
    index.put(a).unwrap();
    index.put(row(2, "hello world")).unwrap();
    assert_eq!(
        page(
            &index,
            &request("project:other project:relay hello -title:world")
        )
        .sessions
        .len(),
        1
    );
    assert_eq!(
        page(&index, &request("harness:claude harness:codex hello"))
            .sessions
            .len(),
        2
    );
    let mut query = request("");
    query.hidden = vec!["codex:rw_000001".into()];
    assert_eq!(page(&index, &query).sessions.len(), 1);
    let mut keys = ["a", "aa", "b", "é"].map(|s| (s, order_key(Some(s), s, false)));
    keys.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(keys.map(|x| x.0), ["é", "b", "aa", "a"]);
}
#[test]
fn sdk_catalog_changes_repair_one_identity_and_reset_settings_invalidate_without_feed_change() {
    use crate::delivery::{self, DeliveryJobConfig, DeliveryLimits, ExportSelection};
    use ai_hist::{DiscoveryOptions, ProviderRoots, SessionStore, Source, StoreOptions};
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("install");
    std::fs::create_dir_all(&directory).unwrap();
    let folder = root.path().join(".claude/projects/fixture");
    std::fs::create_dir_all(&folder).unwrap();
    let transcript = folder.join("rw_fixture.jsonl");
    let line = |title: &str| {
        format!(
            "{}\n{}\n",
            serde_json::json!({"sessionId":"rw_fixture","uuid":"message-1","type":"user","cwd":"/work/relay","timestamp":"2026-10-01T00:00:00Z","message":{"role":"user","content":"Investigate CPU"}}),
            serde_json::json!({"sessionId":"rw_fixture","type":"custom-title","customTitle":title})
        )
    };
    std::fs::write(&transcript, line("Original CPU title")).unwrap();
    let path = directory.join("history.db");
    let mut options = StoreOptions::default();
    options.db_path = Some(path.clone());
    options.roots = Some(ProviderRoots::from_home(
        root.path().to_owned(),
        root.path().join("opencode.db"),
    ));
    let store = SessionStore::open(options).unwrap();
    let discover = || {
        let mut options = DiscoveryOptions::default();
        options.sources = Some(vec![Source::Claude]);
        options.skip_protected_folder_identity = true;
        store.discover(options).unwrap();
    };
    discover();
    let conn = delivery::open_db(&path).unwrap();
    let config = DeliveryJobConfig {
        destination_id: "fixture".into(),
        instance_id: "fixture".into(),
        account_id: "fixture".into(),
        mapping_version: "1".into(),
        selection: ExportSelection {
            all_sources: true,
            kinds: vec!["session".into()],
            ..Default::default()
        },
        limits: DeliveryLimits::default(),
    };
    let job = delivery::create_job(&conn, &config, 0).unwrap().job_id;
    std::fs::write(
        directory.join("config.json"),
        serde_json::to_vec(&serde_json::json!({"job_id":job})).unwrap(),
    )
    .unwrap();
    let mut catalog = CatalogIndex::open(&path, root.path(), root.path()).unwrap();
    let needed = catalog.needed_projects();
    assert_eq!(needed, ["/work/relay"]);
    catalog
        .resolve_projects(HashMap::from([(
            "/work/relay".into(),
            Some("relay".into()),
        )]))
        .unwrap();
    let before_project_expiry = catalog.index.revision;
    let now = std::time::Instant::now();
    let expired = now - std::time::Duration::from_secs(301);
    for id in 0..100 {
        let cwd = format!("/work/project-{id}");
        catalog.project_resolved_at.insert(cwd.clone(), expired);
        catalog.project_expiry.push(std::cmp::Reverse((
            expired + std::time::Duration::from_secs(300),
            cwd,
        )));
    }
    let repairs = catalog.needed_projects_at(now);
    assert_eq!(
        repairs.len(),
        32,
        "TTL expiry must repair a bounded batch, not walk every project"
    );
    catalog
        .resolve_projects(repairs.into_iter().map(|cwd| (cwd, None)).collect())
        .unwrap();
    assert_eq!(
        catalog.index.revision, before_project_expiry,
        "Unchanged resolved names do not invalidate open page snapshots"
    );
    let before = catalog.index.revision;
    assert_eq!(
        page(&catalog.index, &request("Original CPU"))
            .sessions
            .len(),
        1
    );
    std::fs::write(&transcript, line("Renamed CPU title")).unwrap();
    discover();
    catalog.refresh().unwrap();
    assert_eq!(
        page(&catalog.index, &request("Renamed CPU")).sessions.len(),
        1
    );
    assert!(
        catalog.index.revision <= before + 2,
        "One catalog write must not rebuild historical rows"
    );
    let unchanged = catalog.index.revision;
    catalog.refresh().unwrap();
    assert_eq!(catalog.index.revision, unchanged);
    let head = store.head_revision().unwrap();
    delivery::adopt_session_job(&conn, &job, &[]).unwrap();
    catalog.refresh().unwrap();
    assert!(
        !catalog
            .index
            .get("claude:rw_fixture")
            .unwrap()
            .unwrap()
            .upload
            .unwrap()
            .included
    );
    let member = delivery::SessionIdentity {
        source: "claude".into(),
        session_id: "rw_fixture".into(),
    };
    delivery::set_job_session(&conn, &job, &member, true).unwrap();
    catalog.refresh().unwrap();
    assert!(
        catalog
            .index
            .get("claude:rw_fixture")
            .unwrap()
            .unwrap()
            .upload
            .unwrap()
            .included
    );
    assert_eq!(
        store.head_revision().unwrap(),
        head,
        "Delivery membership changes have no SDK catalog change"
    );
    let policy = delivery::policy_revision(&conn).unwrap();
    conn.execute(
        "UPDATE delivery_session_members SET cursor=cursor+1 WHERE job_id=?",
        [&job],
    )
    .unwrap();
    assert_eq!(
        delivery::policy_revision(&conn).unwrap(),
        policy,
        "Ordinary delivery progress must not invalidate inclusion or rebuild historical rows"
    );
    let baseline = root
        .path()
        .join(".agentworkforce/session-reset-baseline.json");
    std::fs::create_dir_all(baseline.parent().unwrap()).unwrap();
    std::fs::write(
        &baseline,
        serde_json::to_vec(&vec![delivery::SessionIdentity {
            source: "claude".into(),
            session_id: "rw_fixture".into(),
        }])
        .unwrap(),
    )
    .unwrap();
    catalog.refresh().unwrap();
    assert!(page(&catalog.index, &request("CPU")).sessions.is_empty());
}

#[test]
fn unsupported_global_reasoning_sort_is_explicit() {
    let index = Index::new().unwrap();
    let mut query = request("");
    query.sort = "reasoning".into();
    let error = match index.candidates(&query) {
        Ok(_) => panic!("unsupported sort accepted"),
        Err(error) => error,
    };
    assert!(error
        .message
        .contains("does not record session reasoning effort"));
}

#[test]
fn both_directions_keep_nulls_last_and_seek_key_ties_without_duplicates() {
    for ascending in [true, false] {
        let mut index = Index::new().unwrap();
        for id in 0..12 {
            let mut row = row(id, "same title");
            row.upload.as_mut().unwrap().project = match id {
                0..=3 => Some(String::new()),
                4..=7 => Some("same".into()),
                8..=9 => Some("aaa".into()),
                _ => Some("zzz".into()),
            };
            index.put(row).unwrap();
        }
        let mut query = request("");
        query.sort = "project".into();
        query.ascending = ascending;
        query.limit = Some(2);
        let mut found = vec![];
        loop {
            let next = page(&index, &query);
            found.extend(next.sessions.into_iter().map(|row| row.session_id));
            query.cursor = next.next_cursor;
            if query.cursor.is_none() {
                break;
            }
        }
        let order = if ascending {
            vec![8, 9, 4, 5, 6, 7, 10, 11, 0, 1, 2, 3]
        } else {
            vec![10, 11, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3]
        };
        assert_eq!(
            found,
            order
                .into_iter()
                .map(|id| format!("rw_{id:06}"))
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn proof_timeout_keeps_retry_cursor_before_unresolved_row_and_skips_proven_prefix() {
    let mut index = Index::new().unwrap();
    for id in 0..8 {
        let mut row = row(id, "conversation");
        if id == 5 {
            row.upload.as_mut().unwrap().status = UploadShareStatus::Checking;
        }
        index.put(row).unwrap();
    }
    let mut query = request("upload:uploaded");
    query.limit = Some(4);
    let original_key = index.candidates(&query).unwrap().proof_cache_key;
    let first = page(&index, &query);
    assert!(first.verification_pending);
    assert_eq!(
        first
            .sessions
            .iter()
            .map(|r| r.session_id.as_str())
            .collect::<Vec<_>>(),
        ["rw_000007", "rw_000006"]
    );
    query.cursor = first.next_cursor;
    let candidates = index.candidates(&query).unwrap();
    assert_eq!(
        candidates.proof_cache_key, original_key,
        "Retry retains a stable bounded page cache even after advancing proven roots"
    );
    assert_eq!(
        candidates.rows[0].upload.as_ref().unwrap().session_id,
        "rw_000005"
    );
    let resolved = row(5, "conversation").upload.unwrap();
    let second = candidates.finish(&query, vec![resolved], None).unwrap();
    assert!(!second.verification_pending);
    assert_eq!(second.sessions[0].session_id, "rw_000005");
    assert!(second
        .sessions
        .iter()
        .all(|r| !["rw_000007", "rw_000006"].contains(&r.session_id.as_str())));
}

mod catalog;
mod model_snapshot;
mod review;

#[test]
fn grok_profile_avatar_enrichment_preserves_search_identity_and_snapshot_fields() {
    use crate::relay::contract::account::SessionAvatar;
    let mut index = Index::new().unwrap();
    let mut snapshot = row(1, "posthogrok");
    let upload = snapshot.upload.as_mut().unwrap();
    upload.source = "grok-bot".into();
    upload.session_id = "native-conversation".into();
    let mut enriched = upload.clone();
    enriched.title = "newer live name".into();
    enriched.models = Some(vec!["different model".into()]);
    enriched.avatar = Some(SessionAvatar {
        shape: Some("house".into()),
        color: Some("blue".into()),
        image_data_url: Some("data:image/png;base64,iVBORw0KGgo=".into()),
    });
    index.put(snapshot).unwrap();
    let query = request("posthogrok");
    let result = index
        .candidates(&query)
        .unwrap()
        .finish(&query, vec![enriched.clone()], None)
        .unwrap();
    assert_eq!(result.sessions.len(), 1);
    let kept = &result.sessions[0];
    assert_eq!(kept.source, "grok-bot");
    assert_eq!(kept.session_id, "native-conversation");
    assert_eq!(kept.title, "posthogrok");
    assert_eq!(kept.models.as_ref().unwrap(), &["model-realistic"]);
    assert_eq!(kept.avatar, enriched.avatar);
}

#[test]
fn oversized_optional_inline_avatar_keeps_the_row_and_shape_color_within_page_cap() {
    use crate::relay::contract::account::SessionAvatar;
    for native_shape in [false, true] {
        let mut index = Index::new().unwrap();
        let snapshot = row(1, "posthogrok");
        let mut enriched = snapshot.upload.as_ref().unwrap().clone();
        enriched.avatar = Some(SessionAvatar {
            shape: native_shape.then(|| "house".into()),
            color: native_shape.then(|| "blue".into()),
            image_data_url: Some(format!(
                "data:image/png;base64,{}",
                "A".repeat(PAGE_BYTES + 1024)
            )),
        });
        index.put(snapshot).unwrap();
        index.put(row(2, "posthogrok")).unwrap();
        let mut query = request("posthogrok");
        query.ascending = true;
        query.limit = Some(1);
        let result = index
            .candidates(&query)
            .unwrap()
            .finish(&query, vec![enriched], None)
            .unwrap();
        assert_eq!(
            result.sessions.len(),
            1,
            "Optional artwork must never hide the session"
        );
        let kept = &result.sessions[0];
        assert_eq!(kept.session_id, "rw_000001");
        assert_eq!(kept.title, "posthogrok");
        if native_shape {
            let avatar = kept.avatar.as_ref().unwrap();
            assert_eq!(avatar.shape.as_deref(), Some("house"));
            assert_eq!(avatar.color.as_deref(), Some("blue"));
            assert!(avatar.image_data_url.is_none());
        } else {
            assert!(kept.avatar.is_none());
        }
        assert!(serde_json::to_vec(&result).unwrap().len() <= PAGE_BYTES);
        let mut next = query.clone();
        next.cursor = result.next_cursor;
        assert!(
            next.cursor.is_some(),
            "The retained row must advance the cursor"
        );
        let following = index
            .candidates(&next)
            .unwrap()
            .finish(&next, vec![], None)
            .unwrap();
        assert_eq!(following.sessions[0].session_id, "rw_000002");
        assert!(following.next_cursor.is_none());
    }
}

#[test]
fn inline_avatar_that_fits_an_empty_page_is_deferred_intact() {
    use crate::relay::contract::account::SessionAvatar;
    let mut index = Index::new().unwrap();
    index.put(row(0, &"a".repeat(PAGE_BYTES / 2))).unwrap();
    let snapshot = row(1, "posthogrok");
    let mut enriched = snapshot.upload.as_ref().unwrap().clone();
    enriched.avatar = Some(SessionAvatar {
        shape: Some("house".into()),
        color: Some("blue".into()),
        image_data_url: Some(format!(
            "data:image/png;base64,{}",
            "A".repeat(PAGE_BYTES / 2)
        )),
    });
    index.put(snapshot).unwrap();
    let mut query = request("");
    query.ascending = true;
    let first = index
        .candidates(&query)
        .unwrap()
        .finish(&query, vec![enriched.clone()], None)
        .unwrap();
    assert_eq!(first.sessions.len(), 1);
    assert_eq!(first.sessions[0].session_id, "rw_000000");
    query.cursor = first.next_cursor;
    assert!(query.cursor.is_some());
    let second = index
        .candidates(&query)
        .unwrap()
        .finish(&query, vec![enriched.clone()], None)
        .unwrap();
    assert_eq!(second.sessions.len(), 1);
    assert_eq!(second.sessions[0].session_id, "rw_000001");
    assert_eq!(second.sessions[0].avatar, enriched.avatar);
    assert!(second.next_cursor.is_none());
    assert!(serde_json::to_vec(&second).unwrap().len() <= PAGE_BYTES);
}
