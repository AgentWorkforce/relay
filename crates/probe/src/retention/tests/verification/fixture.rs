use super::super::*;
use crate::delivery::{DeliveryJobConfig, DeliveryLimits, ExportSelection};
use std::process::{Child, Command, Stdio};

pub(super) struct Fixture {
    pub root: tempfile::TempDir,
    pub db: PathBuf,
    pub app: PathBuf,
    pub job: String,
}

pub(super) fn config(instance: &str) -> DeliveryJobConfig {
    DeliveryJobConfig {
        destination_id: "w1v-synthetic".into(),
        instance_id: instance.into(),
        account_id: "synthetic-account".into(),
        mapping_version: "1".into(),
        selection: ExportSelection {
            all_sources: true,
            kinds: ai_hist::ChangeKind::ALL
                .iter()
                .map(|k| k.as_str().into())
                .collect(),
            ..ExportSelection::default()
        },
        limits: DeliveryLimits {
            max_batch_records: 64,
            ..DeliveryLimits::default()
        },
    }
}

impl Fixture {
    pub fn new(expired: usize, recent: usize) -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join(".w1v-synthetic"),
            "synthetic fixture owned by W1-V\n",
        )
        .unwrap();
        let db = root.path().join("history.db");
        let app = root.path().join("app");
        std::fs::create_dir(&app).unwrap();
        let conn = delivery::open_db(&db).unwrap();
        seed(&conn, "expired", expired, Some(42));
        seed(
            &conn,
            "recent",
            recent,
            Some(crate::delivery::worker::system_clock()),
        );
        let job = delivery::create_job(&conn, &config("all"), 0)
            .unwrap()
            .job_id;
        Self { root, db, app, job }
    }

    pub fn conn(&self) -> Connection {
        delivery::open_control_db(&self.db).unwrap()
    }

    pub fn events(&self, session: &str) -> i64 {
        events(&self.db, session)
    }

    pub fn receiver_count(&self) -> i64 {
        scalar(
            &self.root.path().join("receiver.db"),
            "SELECT COUNT(*) FROM copies",
        )
    }

    pub fn actor(&self, mode: &str) {
        let mut child = self.spawn(mode);
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "actor {mode} failed: {}", self.log(mode));
                return;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("actor {mode} timed out: {}", self.log(mode));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn kill_at_checkpoint(&self, mode: &str) {
        let ready = self.root.path().join("checkpoint");
        if ready.exists() {
            std::fs::remove_file(&ready).unwrap();
        }
        let mut child = self.spawn(mode);
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ready.exists() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "actor {mode} exited early: {}",
                self.log(mode)
            );
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("actor {mode} did not reach checkpoint: {}", self.log(mode));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
    }

    fn spawn(&self, mode: &str) -> Child {
        let log = std::fs::File::create(self.root.path().join(format!("{mode}.log"))).unwrap();
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "retention::verification::actor::subprocess",
                "--ignored",
                "--nocapture",
            ])
            .env("W1V_ROOT", self.root.path())
            .env("W1V_MODE", mode)
            .env(crate::cloud::APP_DATA_DIR_VARIABLE, &self.app)
            .env_remove("CODEX_HOME")
            .stdin(Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap()
    }

    fn log(&self, mode: &str) -> String {
        std::fs::read_to_string(self.root.path().join(format!("{mode}.log"))).unwrap()
    }
}

pub(super) fn seed(conn: &Connection, session: &str, count: usize, timestamp: Option<i64>) {
    let tx = conn.unchecked_transaction().unwrap();
    for n in 0..count {
        tx.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?2,?3,'user','text','synthetic W1-V evidence')", params![session,format!("{session}-{n}"),timestamp]).unwrap();
    }
    tx.commit().unwrap();
}

pub(super) fn events(db: &Path, session: &str) -> i64 {
    Connection::open(db)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM session_events WHERE session_id=?1",
            [session],
            |r| r.get(0),
        )
        .unwrap()
}

pub(super) fn scalar(db: &Path, sql: &str) -> i64 {
    Connection::open(db)
        .unwrap()
        .query_row(sql, [], |r| r.get(0))
        .unwrap()
}

pub(super) fn checkpoint(root: &Path) -> ! {
    std::fs::write(root.join("checkpoint"), "ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(
            Instant::now() < deadline,
            "parent did not terminate the checkpoint actor"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
