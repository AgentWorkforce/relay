//! Portable runtime-hook regression: no Unix sockets, processes or shell scripts.
use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};
use crate::relay::sessions::SessionDirectory;

const THREAD: &str = "550e8400-e29b-41d4-a716-446655440001";
const OTHER: &str = "550e8400-e29b-41d4-a716-446655440002";
const UID: u32 = 501;
const PID: i32 = 500;

struct Fixture {
    _temp: tempfile::TempDir,
    sessions: LocalSessions,
    table: Arc<FakeProcesses>,
    hook: Arc<codex::stop_hook::StopHookInbox>,
    db: rusqlite::Connection,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut config = LocalConfig::from_env(&|_| None, temp.path());
        config.uid = UID;
        config.auto_activate_excluded_dirs.clear();
        let home = &config.codex.home;
        std::fs::create_dir_all(home.join("thread-writer-locks")).unwrap();
        let db = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
        db.execute_batch("create table threads (id text primary key, title text, cwd text,
            archived integer, source text, updated_at integer, has_user_event integer, thread_source text)").unwrap();
        let mut files = Vec::new();
        for id in [THREAD, OTHER] {
            db.execute(
                "insert into threads values (?1, 'User work', ?2, 0, 'vscode', 1, 1, 'user')",
                [id, temp.path().to_str().unwrap()],
            )
            .unwrap();
            let lock = home.join("thread-writer-locks").join(format!("{id}.lock"));
            let rollout = home.join(format!("rollout-test-{id}.jsonl"));
            std::fs::write(&lock, "").unwrap();
            std::fs::write(
                &rollout,
                format!(
                    "{}\n",
                    serde_json::json!({
                        "type":"session_meta", "payload":{"id":id,"thread_source":"user"}
                    })
                ),
            )
            .unwrap();
            files.extend([lock, rollout]);
        }
        let table = Arc::new(FakeProcesses::default());
        let executable = temp.path().join(if cfg!(windows) { "codex.exe" } else { "codex" });
        table.trust(&executable);
        table.insert(
            PID,
            FakeProcess {
                parent: 1,
                uid: UID,
                start: 52,
                executable: Some(executable),
                arguments: vec!["codex".into(), "app-server".into()],
                open_files: files,
                ..Default::default()
            },
        );
        let hook = Arc::new(codex::stop_hook::StopHookInbox::default());
        let sessions = LocalSessions::new(config, table.clone()).with_codex_hook(hook.clone());
        Self {
            _temp: temp,
            sessions,
            table,
            hook,
            db,
        }
    }

    fn rows(&self) -> Vec<DiscoveredSession> {
        self.sessions.codex_sessions().unwrap()
    }

    fn host(&self) -> FakeProcess {
        self.table.processes.lock().unwrap()[&PID].clone()
    }
}

#[test]
fn codex_hook_runtime_live_rows_keep_admission_proof_and_require_ready_hook() {
    let f = Fixture::new();
    let rows = f.rows();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| !row.live));
    f.hook.set_ready(true);
    assert!(f.rows().iter().all(|row| row.live));
    let candidates = f.sessions.automatic_candidates();
    assert_eq!(candidates.len(), 2);
    assert!(candidates.iter().all(|candidate| candidate.session.live
        && candidate.runtime.is_some()
        && f.sessions.automatic_candidate_current(candidate)));
    let host = f.host();
    f.table.insert(
        PID,
        FakeProcess {
            start: host.start + 1,
            ..host.clone()
        },
    );
    assert!(candidates
        .iter()
        .all(|candidate| !f.sessions.automatic_candidate_current(candidate)));
    f.table.remove(PID);
    assert!(f.rows().iter().all(|row| !row.live));
    f.table.insert(PID, host);
    assert!(f.rows().iter().all(|row| row.live));
    f.hook.set_ready(false);
    assert!(f.rows().iter().all(|row| !row.live));
}

#[test]
fn codex_hook_runtime_rejects_wrong_owner_untrusted_archived_and_subagent_chats() {
    let f = Fixture::new();
    f.hook.set_ready(true);
    let host = f.host();
    f.table.insert(
        PID,
        FakeProcess {
            uid: UID + 1,
            ..host.clone()
        },
    );
    assert!(f.rows().iter().all(|row| !row.live));
    f.table.insert(PID, host.clone());
    f.table.trusted_codex.lock().unwrap().clear();
    assert!(f.rows().iter().all(|row| !row.live));
    f.table.trust(host.executable.unwrap());
    assert!(f.rows().iter().all(|row| row.live));
    f.db.execute("update threads set archived=1 where id=?1", [OTHER])
        .unwrap();
    assert!(!f
        .rows()
        .iter()
        .any(|row| row.target.id == OTHER && row.live));
    let rollout = f
        .sessions
        .config
        .codex
        .home
        .join(format!("rollout-test-{THREAD}.jsonl"));
    std::fs::write(rollout, format!("{}\n", serde_json::json!({
        "type":"session_meta", "payload":{"id":THREAD,"thread_source":"subagent",
            "parent_thread_id":OTHER,"source":{"subagent":{"thread_spawn":{"parent_thread_id":OTHER}}}}
    }))).unwrap();
    assert!(!f
        .rows()
        .iter()
        .any(|row| row.target.id == THREAD && row.live));
}
