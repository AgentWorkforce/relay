//! Regression: a user chat in the desktop stdio server has no window owner
//! and is absent from the separate managed daemon's loaded-thread list.
use super::*;
use crate::relay::daemon::{Config, Core, Plugins};
use crate::relay::paths::CorePaths;
use crate::relay::process::{codex_runtime_proofs, file_birth_ns, OpenedFile};

#[path = "../../../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;

const OTHER: &str = "550e8400-e29b-41d4-a716-446655440099";
const TURN: &str = "550e8400-e29b-41d4-a716-446655440088";

fn native_user_turn(trigger: &str) -> serde_json::Value {
    serde_json::json!({"type":"event_msg","payload":{
        "type":"task_started","turn_id":TURN,"root_turn_id":TURN,
        "turn_attribution":{"turn_id":TURN,"root_turn_id":TURN,
            "turn_trigger":trigger,"parent_turn_id":null,"initiating_agent_path":null}}})
}

fn append_record(w: &World, id: &str, value: &serde_json::Value) {
    use std::io::Write;
    let path = w
        .sessions
        .config
        .codex
        .home
        .join(format!("rollout-test-{id}.jsonl"));
    writeln!(
        std::fs::OpenOptions::new().append(true).open(path).unwrap(),
        "{value}"
    )
    .unwrap();
}

fn seed(w: &World, ids: &[&str]) -> rusqlite::Connection {
    let home = &w.sessions.config.codex.home;
    std::fs::create_dir_all(home).unwrap();
    let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute_batch("create table threads (id text primary key, title text, cwd text,
        archived integer, source text, updated_at integer, has_user_event integer, thread_source text)").unwrap();
    let mut files = Vec::new();
    let locks = home.join("thread-writer-locks");
    std::fs::create_dir_all(&locks).unwrap();
    for id in ids {
        db.execute("insert into threads values (?1, 'User work', '/code/relay', 0, 'vscode', 1, 1, 'user')", [id]).unwrap();
        let lock = locks.join(format!("{id}.lock"));
        std::fs::write(&lock, "").unwrap();
        let path = home.join(format!("rollout-test-{id}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::json!({"type":"session_meta",
            "payload":{"id":id,"thread_source":"user"}})
            ),
        )
        .unwrap();
        files.extend([lock, path]);
    }
    w.table.insert(
        500,
        FakeProcess {
            executable: Some(codex_exe()),
            arguments: vec!["codex".into(), "app-server".into()],
            open_files: files,
            ..process(1, 52)
        },
    );
    db
}

#[test]
fn runtime_candidates_are_independent_of_deliverability_and_recent_history() {
    let w = world();
    let db = seed(&w, &[THREAD, OTHER]);
    for n in 0..45 {
        let id = format!("550e8400-e29b-41d4-a716-{n:012}");
        db.execute(
            "insert into threads values (?1, 'History', '/code/relay', 0, 'vscode', 99, 1, 'user')",
            [&id],
        )
        .unwrap();
    }
    assert!(w.sessions.auto_activation_sessions().is_empty());
    let candidates = w.sessions.automatic_candidates();
    assert_eq!(candidates.len(), 2);
    assert!(candidates.iter().all(|c| !c.session.live
        && c.runtime.is_some()
        && w.sessions.automatic_candidate_current(c)));
    let rows = w.sessions.sessions();
    assert!(rows.iter().any(|s| s.target.id == THREAD && !s.live));
    // More than five minutes of idle is not absence: fresh kernel proof,
    // rather than a hook timestamp, keeps both targets present.
    assert!(w
        .sessions
        .present_targets(&rows)
        .contains(&Target::new(SessionKind::Codex, THREAD)));
    w.table.remove(500);
    assert!(candidates
        .iter()
        .all(|c| !w.sessions.automatic_candidate_current(c)));
    assert!(w.sessions.automatic_candidates().is_empty());
}

#[test]
fn internal_archived_exec_and_subagent_rows_cannot_join() {
    for sql in [
        "has_user_event=0",
        "thread_source='internal'",
        "source='exec'",
        "archived=1",
        "source='unknown'",
    ] {
        let w = world();
        let db = seed(&w, &[THREAD]);
        db.execute(&format!("update threads set {sql}"), [])
            .unwrap();
        assert!(w.sessions.automatic_candidates().is_empty(), "{sql}");
    }
    let w = world();
    let _db = seed(&w, &[THREAD]);
    let path = w
        .sessions
        .config
        .codex
        .home
        .join(format!("rollout-test-{THREAD}.jsonl"));
    std::fs::write(
        path,
        format!(
            "{}\n",
            serde_json::json!({"type":"session_meta","payload":{
        "id":THREAD,"thread_source":"subagent","parent_thread_id":OTHER,
        "source":{"subagent":{"thread_spawn":{"parent_thread_id":OTHER}}}}})
        ),
    )
    .unwrap();
    assert!(w.sessions.automatic_candidates().is_empty());
}

#[test]
fn native_remote_and_composer_turns_admit_an_unset_database_user_flag() {
    for trigger in ["remote_android", "composer"] {
        for missing_column in [false, true] {
            let w = world();
            let db = seed(&w, &[THREAD]);
            if missing_column {
                db.execute("alter table threads drop column has_user_event", [])
                    .unwrap();
            } else {
                db.execute("update threads set has_user_event=0", [])
                    .unwrap();
            }
            assert!(w.sessions.automatic_candidates().is_empty());
            append_record(&w, THREAD, &native_user_turn(trigger));
            let candidate = w.sessions.automatic_candidates().pop().unwrap();
            assert!(!candidate.session.live);
            assert!(w.sessions.automatic_candidate_current(&candidate));
            db.execute("update threads set archived=1", []).unwrap();
            assert!(!w.sessions.automatic_candidate_current(&candidate));
        }
    }
}

#[test]
fn fallback_user_evidence_rejects_internal_turns_and_prompt_text() {
    for change in [
        "agent",
        "unknown",
        "parent",
        "initiator",
        "root",
        "turn",
        "missing",
        "prompt",
        "partial",
    ] {
        let w = world();
        let db = seed(&w, &[THREAD]);
        db.execute("update threads set has_user_event=0", [])
            .unwrap();
        let mut event = native_user_turn("remote_android");
        match change {
            "agent" => {
                event["payload"]["turn_attribution"]["turn_trigger"] =
                    "app_tool_create_thread".into()
            }
            "unknown" => event["payload"]["turn_attribution"]["turn_trigger"] = "unknown".into(),
            "parent" => event["payload"]["turn_attribution"]["parent_turn_id"] = OTHER.into(),
            "initiator" => {
                event["payload"]["turn_attribution"]["initiating_agent_path"] = "/agent".into()
            }
            "root" => event["payload"]["turn_attribution"]["root_turn_id"] = OTHER.into(),
            "turn" => event["payload"]["turn_attribution"]["turn_id"] = OTHER.into(),
            "missing" => {
                event["payload"]["turn_attribution"]
                    .as_object_mut()
                    .unwrap()
                    .remove("parent_turn_id");
            }
            "prompt" => {
                event = serde_json::json!({"type":"response_item","payload":{
                "type":"message","role":"user","content":[{"type":"input_text","text":event.to_string()}]}})
            }
            "partial" => {
                use std::io::Write;
                let path = w
                    .sessions
                    .config
                    .codex
                    .home
                    .join(format!("rollout-test-{THREAD}.jsonl"));
                write!(
                    std::fs::OpenOptions::new().append(true).open(path).unwrap(),
                    "{event}"
                )
                .unwrap();
                assert!(w.sessions.automatic_candidates().is_empty());
                continue;
            }
            _ => unreachable!(),
        }
        append_record(&w, THREAD, &event);
        assert!(w.sessions.automatic_candidates().is_empty(), "{change}");
    }
}

#[test]
fn proofs_reject_replaced_inodes_wrong_owner_and_process_reuse() {
    for change in [
        "pid",
        "uid",
        "untrusted",
        "rollout",
        "lock",
        "lock_replaced",
        "held_birth",
    ] {
        let w = world();
        let _db = seed(&w, &[THREAD]);
        let c = w.sessions.automatic_candidates().pop().unwrap();
        let mut host = w.table.processes.lock().unwrap()[&500].clone();
        match change {
            "pid" => host.start += 1,
            "uid" => host.uid += 1,
            "untrusted" => host.executable = Some("/tmp/fake-codex".into()),
            "lock" => host
                .open_files
                .retain(|p| p.extension().and_then(|s| s.to_str()) != Some("lock")),
            "held_birth" => {
                host.opened_files = Some(
                    host.open_files
                        .iter()
                        .map(|p| OpenedFile {
                            path: p.clone(),
                            birth_ns: file_birth_ns(p).map(|n| n + 1),
                        })
                        .collect(),
                );
            }
            _ => {
                let path = host
                    .open_files
                    .iter()
                    .find(|p| {
                        p.extension().and_then(|s| s.to_str())
                            == Some(if change == "lock_replaced" {
                                "lock"
                            } else {
                                "jsonl"
                            })
                    })
                    .unwrap();
                let replacement = path.with_extension("new");
                std::fs::write(&replacement, std::fs::read(path).unwrap()).unwrap();
                std::fs::rename(replacement, path).unwrap();
            }
        }
        w.table.insert(500, host);
        assert!(!w.sessions.automatic_candidate_current(&c), "{change}");
    }
}

#[test]
fn ambiguous_runtime_owners_and_directory_policy_deny_admission() {
    let w = world();
    let db = seed(&w, &[THREAD]);
    let host = w.table.processes.lock().unwrap()[&500].clone();
    w.table.insert(501, FakeProcess { start: 53, ..host });
    assert!(codex_runtime_proofs(&*w.table, UID).is_empty());
    w.table.remove(501);
    db.execute("update threads set cwd='/tmp/private'", [])
        .unwrap();
    assert!(w.sessions.automatic_candidates().is_empty());
}

#[tokio::test]
async fn loaded_stdio_chats_register_once_and_keep_identity_without_an_idle_route() {
    let w = world();
    let db = seed(&w, &[THREAD, OTHER]);
    // Real Remote Control desktop rollouts can record user turns while
    // leaving this catalog flag at zero for the whole conversation.
    db.execute("update threads set has_user_event=0", [])
        .unwrap();
    for id in [THREAD, OTHER] {
        append_record(&w, id, &native_user_turn("remote_android"));
    }
    let home = w._temp.path();
    let fake = fake_relaycast::FakeRelaycast::start(Default::default()).await;
    let data = home.join("app-data");
    fake_relaycast::sign_in_store(&data, fake_relaycast::WORKSPACE_KEY, &fake.base_url);
    let sessions = Arc::new(w.sessions);
    let (core, _) = Core::with_plugins(
        Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: data,
            env: Default::default(),
            version: "test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: Default::default(),
            delivery_timing: Default::default(),
        },
        Plugins {
            sessions: sessions.clone(),
            ..Default::default()
        },
    );
    core.rediscover_workspace();
    core.store
        .update(|s| s.auto_activate = Some(false))
        .unwrap();
    assert!(core.activate_new_sessions().await.is_empty());
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 0);
    core.store.update(|s| s.auto_activate = Some(true)).unwrap();
    let failures = core.activate_new_sessions().await;
    assert!(
        failures.is_empty(),
        "{failures:?}; requests={:?}; log={:?}",
        fake.calls("POST", "/v1/agents"),
        crate::relay::request_log::snapshot()
    );
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 2);
    assert!(core.activate_new_sessions().await.is_empty());
    assert_eq!(fake.calls("POST", "/v1/agents").len(), 2);
    assert!(core.store.read(|s| s
        .registrations
        .iter()
        .all(|r| r.auto_activated == Some(true)
            && r.missing_since.is_none()
            && r.added_by_session != Some(true))));
    assert!(sessions
        .sessions()
        .iter()
        .filter(|s| s.target.kind == SessionKind::Codex)
        .all(|s| !s.live));
    let listed = sessions.sessions();
    *core.session_snapshot.lock().unwrap() = (1, listed);
    let rows = crate::relay::local_methods::sessions_list(&core).await;
    assert!(rows
        .sessions
        .iter()
        .filter(|s| s.target.kind == SessionKind::Codex)
        .all(|s| s.delivery_wait.is_some()));
    // Listing must stay off the provider/SQLite path, even while that
    // provider's database is exclusively locked by its own writer.
    db.execute_batch("begin exclusive").unwrap();
    tokio::time::timeout(
        Duration::from_millis(250),
        crate::relay::local_methods::sessions_list(&core),
    )
    .await
    .expect("cached listing must not wait for the Codex database");
    db.execute_batch("rollback").unwrap();
    core.runtime_presence.lock().unwrap().as_mut().unwrap().0 =
        std::time::Instant::now() - Duration::from_secs(61);
    let rows = crate::relay::local_methods::sessions_list(&core).await;
    assert!(rows.sessions.iter().all(|s| s.delivery_wait.is_none()));
    assert!(core.activate_new_sessions().await.is_empty());
    // Stale proof is denied at the internal registration boundary.
    let c = sessions.automatic_candidates().pop().unwrap();
    db.execute(
        "update threads set archived=1 where id=?1",
        [c.session.target.id.as_str()],
    )
    .unwrap();
    assert!(!sessions.automatic_candidate_current(&c));
    w.table.remove(500);
    core.activate_new_sessions().await;
    let rows = crate::relay::local_methods::sessions_list(&core).await;
    assert!(rows.sessions.iter().all(|s| s.delivery_wait.is_none()));
}

#[test]
fn duplicate_descriptors_do_not_create_a_second_runtime_owner() {
    let w = world();
    let _db = seed(&w, &[THREAD]);
    let mut host = w.table.processes.lock().unwrap()[&500].clone();
    host.open_files
        .push(host.open_files.last().unwrap().clone());
    w.table.insert(500, host);
    assert_eq!(w.sessions.automatic_candidates().len(), 1);
}

#[test]
fn uppercase_catalog_ids_bind_to_the_normalized_runtime_proof() {
    let w = world();
    let db = seed(&w, &[THREAD]);
    db.execute("update threads set id=upper(id)", []).unwrap();
    let candidate = w.sessions.automatic_candidates().pop().unwrap();
    assert_eq!(candidate.session.target.id, THREAD);
    assert!(w.sessions.automatic_candidate_current(&candidate));
}

#[test]
fn runtime_presence_filters_fleet_ownership_but_keeps_manual_excluded_chats() {
    let w = world();
    let db = seed(&w, &[THREAD]);
    db.execute("update threads set cwd='/tmp/private'", [])
        .unwrap();
    let target = Target::new(SessionKind::Codex, THREAD);
    assert!(w.sessions.automatic_candidates().is_empty());
    assert!(w.sessions.present_targets(&[]).contains(&target));
    w.sessions
        .fleet_owned
        .lock()
        .unwrap()
        .insert(target.clone());
    assert!(!w.sessions.present_targets(&[]).contains(&target));
}
