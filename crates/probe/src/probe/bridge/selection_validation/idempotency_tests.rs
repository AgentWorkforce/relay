use super::super::tests::{acknowledge_everything, fixture};
use super::*;

fn batches(conn: &Connection) -> Vec<(String, String, String)> {
    conn.prepare("SELECT id,state,accepted_revision_ids FROM delivery_batches ORDER BY seq")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn accepted_broad_include_replay_preserves_generation_progress_and_receipts() {
    let Some(_home) = crate::probe::live::tests::isolated_home(
        "probe::bridge::selection_validation::idempotency_tests::accepted_broad_include_replay_preserves_generation_progress_and_receipts"
    ) else { return; };
    for mode in [SharingMode::New, SharingMode::All] {
        let (directory, original) = fixture(mode);
        let conn = db(directory.path()).unwrap();
        let key = "codex:recent".to_string();
        assert!(selected(directory.path()).unwrap().is_empty());
        change(directory.path(), None, std::slice::from_ref(&key), true).unwrap();
        let accepted = read_config(directory.path()).unwrap();
        assert_ne!(
            accepted.job_id, original.job_id,
            "first manual include keeps its original semantics"
        );
        acknowledge_everything(&conn, &accepted.job_id);
        assert!(batches(&conn)
            .iter()
            .any(|(_, state, _)| state == "acknowledged"));
        conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES('codex','recent','pending-after-ack',1,'user','text','synthetic update')", []).unwrap();
        assert!(
            delivery::prepare_batch(&conn, &accepted.job_id, collector::now())
                .unwrap()
                .batch_id
                .is_some()
        );
        let jobs_before = delivery::list_jobs(&conn).unwrap();
        let batches_before = batches(&conn);
        let config_before = fs::read(directory.path().join("config.json")).unwrap();
        // No process-local requested set or auxiliary request journal survives.
        // The mutation's own durable acceptance must make its retry a no-op.
        change(directory.path(), None, std::slice::from_ref(&key), true).unwrap();
        assert_eq!(delivery::list_jobs(&conn).unwrap(), jobs_before);
        assert_eq!(batches(&conn), batches_before);
        assert_eq!(
            fs::read(directory.path().join("config.json")).unwrap(),
            config_before
        );
        assert!(!directory.path().join("sharing-change.json").exists());
    }
}

#[test]
fn accepted_broad_include_remains_idempotent_while_folder_consent_withholds_it() {
    let Some(_home) = crate::probe::live::tests::isolated_home(
        "probe::bridge::selection_validation::idempotency_tests::accepted_broad_include_remains_idempotent_while_folder_consent_withholds_it"
    ) else { return; };
    assert!(!crate::relay::claude_dirs::cloud_sessions_shared_here());
    for mode in [SharingMode::New, SharingMode::All] {
        let (directory, _) = fixture(mode);
        let conn = db(directory.path()).unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt) VALUES('claude','cse_withheld_replay','synthetic cloud session')", []).unwrap();
        let key = "claude:cse_withheld_replay".to_string();
        let identity = parse_key(&key).unwrap();
        change(directory.path(), None, std::slice::from_ref(&key), true).unwrap();
        assert!(selected(directory.path()).unwrap().contains(&identity));
        assert!(!delivery::is_shareable(&conn, &identity).unwrap());
        assert!(!delivery::is_explicitly_excluded(&conn, &identity).unwrap());
        let before = delivery::list_jobs(&conn).unwrap();
        change(directory.path(), None, std::slice::from_ref(&key), true).unwrap();
        assert_eq!(delivery::list_jobs(&conn).unwrap(), before);
        assert!(
            !delivery::is_shareable(&conn, &identity).unwrap(),
            "retry never grants folder/login consent"
        );
    }
}

#[test]
fn explicit_deny_and_pending_change_still_take_the_normal_mutation_path() {
    let Some(_home) = crate::probe::live::tests::isolated_home(
        "probe::bridge::selection_validation::idempotency_tests::explicit_deny_and_pending_change_still_take_the_normal_mutation_path"
    ) else { return; };
    for mode in [SharingMode::New, SharingMode::All] {
        let (directory, _) = fixture(mode);
        let conn = db(directory.path()).unwrap();
        let key = "codex:recent".to_string();
        let identity = parse_key(&key).unwrap();
        change(directory.path(), None, std::slice::from_ref(&key), true).unwrap();
        let accepted = read_config(directory.path()).unwrap();
        delivery::set_session_excluded(&conn, &identity, true).unwrap();
        change(directory.path(), None, std::slice::from_ref(&key), true).unwrap();
        let reenabled = read_config(directory.path()).unwrap();
        assert_ne!(reenabled.job_id, accepted.job_id);
        assert!(!delivery::is_explicitly_excluded(&conn, &identity).unwrap());
        let plan = make_plan(
            &conn,
            directory.path(),
            reenabled.clone(),
            None,
            &[identity],
            true,
        )
        .unwrap();
        save_json(&directory.path().join("sharing-change.json"), &plan).unwrap();
        change(directory.path(), None, std::slice::from_ref(&key), true).unwrap();
        assert!(!directory.path().join("sharing-change.json").exists());
        assert_ne!(
            read_config(directory.path()).unwrap().job_id,
            reenabled.job_id,
            "a pending durable change must be recovered rather than skipped"
        );
    }
}
