use super::*;
use crate::delivery::{self, DeliveryJobConfig, DeliveryLimits, ExportSelection};
use ai_hist::{DiscoveryOptions, ProviderRoots, SessionStore, Source, StoreOptions};

#[test]
fn upload_sort_tracks_claude_folder_consent_across_pages() {
    // Delivery reads folder consent from the process environment. Isolate it
    // from parallel tests and the person's own Claude settings.
    const CHILD: &str = "RELAY_CATALOG_FOLDER_CONSENT_TEST_HOME";
    const TEST: &str =
        "relay::session_query::tests::catalog::upload_sort_tracks_claude_folder_consent_across_pages";
    let home = match std::env::var_os(CHILD) {
        Some(home) => std::path::PathBuf::from(home),
        None => {
            let home = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--nocapture"])
                .env(CHILD, home.path())
                .env("HOME", home.path())
                .env("USERPROFILE", home.path())
                .env("AGENT_RELAY_HOME", home.path().join("custom-relay"))
                .env("CLAUDE_CONFIG_DIR", home.path().join(".claude"))
                .env_remove(crate::relay::claude_dirs::DIRS_ENV)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
    };
    let directory = home.join("install");
    let relay_home = home.join("custom-relay");
    let claude_home = home.join(".claude");
    let project = claude_home.join("projects/fixture");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    for id in ["a", "b"] {
        std::fs::write(
            project.join(format!("{id}.jsonl")),
            format!(
                "{}\n",
                serde_json::json!({
                    "sessionId":id,"uuid":format!("message-{id}"),"type":"user",
                    "cwd":"/work/app","timestamp":"2026-10-01T00:00:00Z",
                    "message":{"role":"user","content":format!("Session {id}")}
                })
            ),
        )
        .unwrap();
        let grok = home.join(".grok/sessions/%2Fwork%2Fapp").join(id);
        std::fs::create_dir_all(&grok).unwrap();
        std::fs::write(
            grok.join("summary.json"),
            serde_json::json!({"info":{"id":id,"cwd":"/work/app"},
                "created_at":"2026-10-01T00:00:00.000Z",
                "updated_at":"2026-10-01T00:00:00.000Z"})
            .to_string(),
        )
        .unwrap();
        std::fs::write(grok.join("chat_history.jsonl"), "").unwrap();
    }
    let path = directory.join("history.db");
    let mut options = StoreOptions::default();
    options.db_path = Some(path.clone());
    options.roots = Some(ProviderRoots::from_home(
        home.clone(),
        home.join("opencode.db"),
    ));
    let store = SessionStore::open(options).unwrap();
    let mut discovery = DiscoveryOptions::default();
    discovery.sources = Some(vec![Source::Claude, Source::Grok]);
    discovery.skip_protected_folder_identity = true;
    store.discover(discovery).unwrap();
    let conn = delivery::open_db(&path).unwrap();
    let job = delivery::create_job(
        &conn,
        &DeliveryJobConfig {
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
        },
        0,
    )
    .unwrap();
    for id in ["a", "b"] {
        delivery::set_session_excluded(
            &conn,
            &delivery::SessionIdentity {
                source: "grok".into(),
                session_id: id.into(),
            },
            true,
        )
        .unwrap();
    }
    std::fs::write(
        directory.join("config.json"),
        serde_json::json!({"job_id":job.job_id}).to_string(),
    )
    .unwrap();
    let mut catalog = CatalogIndex::open(&path, &home, &relay_home).unwrap();
    let query = SessionQueryParams {
        sort: "upload".into(),
        ascending: true,
        limit: Some(1),
        ..Default::default()
    };
    let collect = |catalog: &CatalogIndex| {
        let mut request = query.clone();
        let mut rows = vec![];
        loop {
            let page = page(&catalog.index, &request);
            assert_eq!(page.sessions.len(), 1);
            rows.extend(
                page.sessions
                    .into_iter()
                    .map(|row| (format!("{}:{}", row.source, row.session_id), row.included)),
            );
            request.cursor = page.next_cursor;
            if request.cursor.is_none() {
                break;
            }
            assert!(rows.len() < 4);
        }
        rows
    };
    let shared_order = vec![
        ("grok:a".into(), false),
        ("grok:b".into(), false),
        ("claude:a".into(), true),
        ("claude:b".into(), true),
    ];
    assert_eq!(collect(&catalog), shared_order);
    let head = store.head_revision().unwrap();
    let policy = delivery::policy_revision(&conn).unwrap();
    let dirs = crate::relay::claude_dirs::ClaudeDirs {
        environment: vec![],
        file: Some(relay_home.join(crate::relay::claude_dirs::FILE)),
    };
    for shared in [false, true] {
        let first = page(&catalog.index, &query);
        let mut stale = query.clone();
        stale.cursor = first.next_cursor;
        dirs.set_shared(claude_home.to_str().unwrap(), shared, &claude_home)
            .unwrap();
        let invalidated = !catalog.settings_current();
        catalog.refresh().unwrap();
        let expected = if shared {
            shared_order.clone()
        } else {
            vec![
                ("claude:a".into(), false),
                ("claude:b".into(), false),
                ("grok:a".into(), false),
                ("grok:b".into(), false),
            ]
        };
        assert_eq!(
            collect(&catalog),
            expected,
            "folder consent must change the indexed order across pages"
        );
        assert!(
            invalidated,
            "a saved query must notice folder consent changes"
        );
        assert!(
            catalog.index.candidates(&stale).is_err(),
            "old-order cursor must be retired"
        );
        assert_eq!(store.head_revision().unwrap(), head);
        assert_eq!(delivery::policy_revision(&conn).unwrap(), policy);
    }
    std::fs::remove_file(relay_home.join(crate::relay::claude_dirs::FILE)).unwrap();
    assert!(
        !catalog.settings_current(),
        "removing the consent file restores defaults"
    );
    catalog.refresh().unwrap();
    assert_eq!(collect(&catalog), shared_order);
    assert!(catalog.settings_current());
}

#[test]
fn incremental_catalog_keeps_native_grok_subagents_out_of_the_picker() {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join("install");
    std::fs::create_dir_all(&directory).unwrap();
    let write = |id: &str, kind: Option<&str>, minute: u32| {
        let folder = home.path().join(".grok/sessions/%2Fwork%2Fapp").join(id);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("summary.json"),
            serde_json::json!({
                "info": {"id": id, "cwd": "/work/app"},
                "session_kind": kind,
                "created_at": "2026-10-11T09:00:00.000Z",
                "updated_at": format!("2026-10-11T09:{minute:02}:00.000Z")
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(folder.join("chat_history.jsonl"), "").unwrap();
    };
    write("ordinary", None, 1);
    write("already-child", Some("subagent"), 2);
    let path = directory.join("history.db");
    let mut options = StoreOptions::default();
    options.db_path = Some(path.clone());
    options.roots = Some(ProviderRoots::from_home(
        home.path().to_owned(),
        home.path().join("opencode.db"),
    ));
    let store = SessionStore::open(options).unwrap();
    let discover = || {
        let mut options = DiscoveryOptions::default();
        options.sources = Some(vec![Source::Grok]);
        options.skip_protected_folder_identity = true;
        store.discover(options).unwrap();
    };
    discover();
    let conn = delivery::open_db(&path).unwrap();
    let job = delivery::create_job(
        &conn,
        &DeliveryJobConfig {
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
        },
        0,
    )
    .unwrap();
    std::fs::write(
        directory.join("config.json"),
        serde_json::json!({"job_id":job.job_id}).to_string(),
    )
    .unwrap();
    let mut catalog = CatalogIndex::open(&path, home.path(), home.path()).unwrap();
    assert!(catalog.index.get("grok:ordinary").unwrap().is_some());
    assert!(catalog.index.get("grok:already-child").unwrap().is_none());

    // Neither child has a parent relationship. Classification alone must have
    // the same effect during change-feed repair as it does during the seed.
    write("ordinary", Some("subagent"), 3);
    write("already-child", Some("subagent"), 4);
    discover();
    catalog.refresh().unwrap();
    assert!(catalog.index.get("grok:ordinary").unwrap().is_none());
    assert!(catalog.index.get("grok:already-child").unwrap().is_none());

    write("ordinary", Some("main"), 5);
    discover();
    catalog.refresh().unwrap();
    assert!(catalog.index.get("grok:ordinary").unwrap().is_some());
}
