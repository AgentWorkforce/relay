use super::*;
use crate::relay::contract::account::{SessionFacetParams, SessionQueryParams};
use crate::relay::session_query::test_catalog::fixture;
use ai_hist::retention::{RetentionOptions, RetentionPolicy};

struct NoProbe {
    root: PathBuf,
}
impl ProbeRunner for NoProbe {
    fn history_access_root(&self) -> Option<PathBuf> {
        Some(self.root.clone())
    }
    fn run(
        &self,
        _: Vec<String>,
        _: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        async {
            Err(UploaderError::new(
                "retention query fixture forbids helper execution",
            ))
        }
        .boxed()
    }
    fn install(&self, _: Vec<String>, _: Option<Secret>) -> Result<InstallRun, UploaderError> {
        Err(UploaderError::new(
            "retention query fixture forbids install",
        ))
    }
    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
        async { Ok(()) }.boxed()
    }
}

#[tokio::test]
async fn retention_refreshes_warm_queries_and_facet_only_requests_once() {
    let mut f = fixture();
    let fresh = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    f.db.execute(
        "UPDATE sessions SET last_activity_ms=1,cwd='/work/expired'",
        [],
    )
    .unwrap();
    f.db.execute(
        "UPDATE sessions SET last_activity_ms=?,cwd='/work/recent' WHERE session_id='rw_000002'",
        [fresh],
    )
    .unwrap();
    f.db.execute("INSERT INTO sessions(source,session_id,last_activity_ms,raw_path,discovery_state,cwd,first_prompt) VALUES('claude','expired-claude',1,'/synthetic/expired','full','/work/expired','Expired session')", []).unwrap();
    f.catalog.refresh().unwrap();
    f.catalog
        .resolve_projects(
            [
                ("/work/expired".into(), Some("Expired project".into())),
                ("/work/recent".into(), Some("Recent project".into())),
            ]
            .into_iter()
            .collect(),
        )
        .unwrap();
    let relay_only = serde_json::from_value(json!({
        "target":{"kind":"codex","id":"relay-only"},"title":"Relay only",
        "project":"Relay project","directory":"/work/relay","live":true,"running":true,
        "registration":null,"suggested_name":"relay-only"
    }))
    .unwrap();
    f.catalog
        .index
        .live(vec![relay_only], Default::default(), Default::default())
        .unwrap();
    let query = SessionQueryParams {
        sort: "sessionID".into(),
        ascending: true,
        limit: Some(1),
        ..Default::default()
    };
    let old_query = f
        .catalog
        .index
        .candidates(&query)
        .unwrap()
        .finish(&query, vec![], None)
        .unwrap()
        .next_cursor
        .unwrap();
    let facets = f
        .catalog
        .index
        .facets(&SessionFacetParams {
            cursor: None,
            limit: None,
        })
        .unwrap();
    assert!(facets.harnesses.iter().any(|v| v == "claude"));
    assert!(facets.projects.iter().any(|v| v == "Expired project"));
    let old_facet = f
        .catalog
        .index
        .facets(&SessionFacetParams {
            cursor: None,
            limit: Some(1),
        })
        .unwrap()
        .next_cursor
        .unwrap();
    let old_epoch = f.catalog.index.epoch();
    f.store
        .set_retention_policy(RetentionPolicy::from_days(7))
        .unwrap();
    f.store.register_retention_consumer("desktop-test").unwrap();
    f.store
        .acknowledge_retention("desktop-test", f.store.head_revision().unwrap())
        .unwrap();
    let before = f.store.retention_generation().unwrap();
    let options = RetentionOptions {
        max_rows: 1024,
        min_interval_ms: 0,
        allow_unuploaded: false,
    };
    let mut complete = false;
    let mut removed = 0;
    for _ in 0..32 {
        let batch = f.store.prune_expired(options.clone()).unwrap();
        assert!(!batch.busy && !batch.deferred && !batch.awaiting_upload_ack);
        removed += batch.sessions;
        if batch.cycle_complete {
            complete = true;
            break;
        }
    }
    assert!(
        complete && removed >= 3,
        "the SDK actually evicts the expired sessions"
    );
    assert!(f.store.retention_generation().unwrap() > before);
    let old_projection_certified = f.catalog.settings_current();
    let old_version_rejected = f.catalog.version(&query, 0).is_err();
    let uploader = Uploader::new(Arc::new(NoProbe {
        root: f.home.path().into(),
    }));
    uploader.attach(Install::from_json(
        &json!({"site_url":"https://fixture.invalid","directory":f.path.parent().unwrap()}),
    ));
    *uploader.query_index.lock().unwrap() = Some((f.path.clone(), 0, f.catalog));
    // No session query runs between the SDK prune and this filters-only call.
    let facets = uploader
        .sessions_facets(SessionFacetParams {
            cursor: None,
            limit: None,
        })
        .await
        .unwrap();
    assert!(!facets.harnesses.iter().any(|v| v == "claude"));
    assert!(!facets.projects.iter().any(|v| v == "Expired project"));
    assert!(facets.projects.iter().any(|v| v == "Recent project"));
    assert!(facets.projects.iter().any(|v| v == "Relay project"));
    assert!(
        !old_projection_certified,
        "an answer cannot certify the pre-eviction projection"
    );
    assert!(old_version_rejected);
    let (epoch, revision) = {
        let slot = uploader.query_index.lock().unwrap();
        let catalog = &slot.as_ref().unwrap().2;
        assert_ne!(catalog.index.epoch(), old_epoch);
        assert!(catalog.settings_current());
        let all = catalog
            .index
            .candidates(&SessionQueryParams::default())
            .unwrap();
        assert_eq!(all.rows.len(), 2);
        assert!(all.rows.iter().any(|row| row
            .upload
            .as_ref()
            .is_some_and(|u| u.session_id == "rw_000002")));
        assert!(all.rows.iter().any(|row| row.upload.is_none()
            && row
                .relay
                .as_ref()
                .is_some_and(|r| r.suggested_name == "relay-only")));
        assert!(catalog
            .index
            .candidates(&SessionQueryParams {
                cursor: Some(old_query),
                ..query
            })
            .is_err());
        (catalog.index.epoch(), catalog.index.revision())
    };
    let unchanged = uploader
        .sessions_facets(SessionFacetParams {
            cursor: None,
            limit: None,
        })
        .await
        .unwrap();
    assert_eq!(unchanged, facets);
    {
        let slot = uploader.query_index.lock().unwrap();
        let catalog = &slot.as_ref().unwrap().2;
        assert_eq!(
            (catalog.index.epoch(), catalog.index.revision()),
            (epoch, revision),
            "unchanged polling reuses the projection"
        );
    }
    {
        let mut slot = uploader.query_index.lock().unwrap();
        let catalog = &mut slot.as_mut().unwrap().2;
        let due =
            catalog.due_projects_for_test(std::time::Instant::now() + Duration::from_secs(301));
        assert!(
            !due.iter().any(|cwd| cwd == "/work/expired"),
            "pruned-only directories must not schedule recurring project work"
        );
        assert!(
            due.iter().any(|cwd| cwd == "/work/recent"),
            "surviving cached projects retain their original expiry"
        );
    }
    assert!(uploader
        .sessions_facets(SessionFacetParams {
            cursor: Some(old_facet),
            limit: Some(1)
        })
        .await
        .is_err());
}
