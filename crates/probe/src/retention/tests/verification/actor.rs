use super::super::*;
use super::{fixture, receiver::Local};
use crate::delivery::worker::{self, DrainOptions};
use crate::relay::history_retention;
use std::sync::Arc;

fn policy(root: &Path, mode: &str) {
    let (action, days) = mode.split_once('-').unwrap();
    let days: u32 = days.parse().unwrap();
    let db = root.join("history.db");
    let app = root.join("app");
    let active = db.clone();
    let setting = history_retention::setting_at(&app, Arc::new(move || Some(active.clone())));
    if action == "save" {
        setting
            .set(history_retention::SETTING, &serde_json::json!(days))
            .unwrap()
            .unwrap();
    } else {
        assert_eq!(setting.get()[history_retention::SETTING], days);
        setting.attach(Arc::new(|| {}));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let store =
            SessionStore::open(StoreOptions::default().db_path(&db).read_only(true)).unwrap();
        let saved = store
            .retention_policy()
            .unwrap()
            .days
            .map_or(0, std::num::NonZeroU32::get);
        if saved == days
            && history_retention::applied_to(&app, &db, store.head_revision().unwrap().epoch)
        {
            break;
        }
        assert!(Instant::now() < deadline, "policy {mode} did not settle");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(setting.get()[history_retention::SETTING], days);
}

pub(super) fn upload(root: &Path, mode: &str) {
    let clock_file = root.join("upload-clock");
    let previous: i64 = std::fs::read_to_string(&clock_file)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(worker::system_clock);
    let now = previous + 60_000;
    std::fs::write(&clock_file, now.to_string()).unwrap();
    let mut options = DrainOptions::new("w1v-child");
    options.lease_ms = 5_000;
    if matches!(mode, "upload-fail" | "upload-partial") {
        options.max_batches = 1;
    }
    let receiver = Local::new(root, mode);
    let report = worker::drain(
        &root.join("history.db"),
        &receiver,
        &options,
        &|| now,
        &|| false,
    )
    .unwrap();
    assert!(report.issues.is_empty(), "{report:?}");
    assert!(!report.statuses.is_empty());
    if mode == "upload" {
        assert!(
            report.statuses.iter().all(|s| s.pending_records == 0),
            "{report:?}"
        );
    }
}

fn prune(root: &Path, mode: &str) {
    let db = root.join("history.db");
    let before = fixture::events(&db, "expired");
    let stop = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        maintain(root, &stop);
        if mode == "prune-pause" {
            let remaining = fixture::events(&db, "expired");
            assert!(
                remaining > 0 && remaining < before,
                "kill must interrupt a partially drained session: {before} -> {remaining}"
            );
            fixture::checkpoint(root);
        }
        if mode == "prune-once" {
            return;
        }
        let pending = fixture::scalar(
            &db,
            "SELECT COUNT(*) FROM retention_pending WHERE source='claude' AND session_id='expired'",
        );
        if fixture::events(&db, "expired") == 0 && pending == 0 {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "maintenance did not drain expired session"
        );
        std::thread::sleep(Duration::from_millis(110));
    }
}

fn schedule(root: &Path) {
    let db = root.join("history.db");
    let app = root.join("app");
    let stop = AtomicBool::new(false);
    run(root, &app, &stop, Instant::now()).unwrap();
    let due = MAINTENANCE.lock().unwrap().as_ref().unwrap().due;
    assert!(due.duration_since(Instant::now()) > Duration::from_secs(500));
    let conn = delivery::open_control_db(&db).unwrap();
    fixture::seed(&conn, "expired", 1, Some(42));
    upload(root, "upload");
    let early = run(root, &app, &stop, due - Duration::from_millis(1)).unwrap();
    assert_eq!(early.rows, 0, "not due yet");
    assert_eq!(fixture::events(&db, "expired"), 1);
    let ready = run(root, &app, &stop, due + Duration::from_millis(1)).unwrap();
    assert!(ready.rows > 0);
    assert_eq!(fixture::events(&db, "expired"), 0);
    assert_eq!(fixture::events(&db, "recent"), 1);
    let again = run(
        root,
        &app,
        &stop,
        due + SWEEP_EVERY + Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(again.rows, 0, "a later scheduled sweep is idempotent");
}

/// A real child process, selected only by the parent scenarios below. It never
/// discovers provider roots, launches the app, or contacts a network receiver.
#[test]
#[ignore = "subprocess helper; invoked by the synthetic end-to-end scenarios"]
fn subprocess() {
    let root =
        PathBuf::from(std::env::var_os("W1V_ROOT").expect("parent must supply a synthetic root"));
    let mode = std::env::var("W1V_MODE").unwrap();
    assert!(root.is_absolute() && root.join("history.db").is_file());
    assert_eq!(
        std::fs::read_to_string(root.join(".w1v-synthetic")).unwrap(),
        "synthetic fixture owned by W1-V\n"
    );
    assert!(root
        .canonicalize()
        .unwrap()
        .starts_with(std::env::temp_dir().canonicalize().unwrap()));
    if mode.starts_with("save-") || mode.starts_with("check-") {
        policy(&root, &mode);
    } else if mode.starts_with("upload") {
        upload(&root, &mode);
    } else if mode.starts_with("prune") {
        prune(&root, &mode);
    } else if mode == "schedule" {
        schedule(&root);
    } else {
        panic!("unknown actor mode {mode}");
    }
}
