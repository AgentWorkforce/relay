use super::DatabaseIdentity;
use nix::libc;
use rusqlite::{Connection, OpenFlags};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::Path;
use std::process::Command;

const LOCK_PATH: &str = "RELAY_DATABASE_IDENTITY_LOCK_PATH";
const LOCK_OWNER: &str = "RELAY_DATABASE_IDENTITY_LOCK_OWNER";

#[test]
fn identity_lock_probe_child() {
    let Some(path) = std::env::var_os(LOCK_PATH) else {
        return;
    };
    let owner: libc::pid_t = std::env::var(LOCK_OWNER).unwrap().parse().unwrap();
    let file = std::fs::File::open(path).unwrap();
    // Query the parent's main-file shared lock, never acquire one ourselves.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as _;
    lock.l_whence = libc::SEEK_SET as _;
    lock.l_start = 0x4000_0000;
    lock.l_len = 512;
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) };
    assert_eq!(rc, 0, "{}", std::io::Error::last_os_error());
    assert_eq!(
        lock.l_type,
        libc::F_RDLCK as libc::c_short,
        "SQLite shared lock vanished"
    );
    assert_eq!(lock.l_pid, owner, "wrong SQLite lock owner");
    println!("IDENTITY_LOCK_PROBE_VERIFIED");
}

fn assert_sqlite_locked(path: &Path) {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "delivery::database::tests::identity_lock_probe_child",
            "--nocapture",
        ])
        .env(LOCK_PATH, path)
        .env(LOCK_OWNER, std::process::id().to_string())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("IDENTITY_LOCK_PROBE_VERIFIED"),
        "child must execute the real F_GETLK probe"
    );
}

fn reader(path: &Path) -> Connection {
    let writer = Connection::open(path).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS identity_fixture (id INTEGER); INSERT INTO identity_fixture VALUES (1);").unwrap();
    drop(writer);
    let reader = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    let _: i64 = reader
        .query_row("SELECT COUNT(*) FROM identity_fixture", [], |r| r.get(0))
        .unwrap();
    reader
}

#[test]
fn identity_read_preserves_actual_sqlite_process_locks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let _reader = reader(&path);
    assert_sqlite_locked(&path);
    drop(DatabaseIdentity::read(&path).unwrap());
    assert_sqlite_locked(&path);
}

#[test]
fn identity_existing_open_or_create_preserves_actual_sqlite_process_locks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let _reader = reader(&path);
    assert_sqlite_locked(&path);
    drop(DatabaseIdentity::open_or_create(&path).unwrap());
    assert_sqlite_locked(&path);
}

#[test]
fn identity_tracks_writes_aliases_and_path_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    std::fs::write(&path, b"original").unwrap();
    let identity = DatabaseIdentity::read(&path).unwrap();
    std::fs::write(&path, b"ordinary longer write").unwrap();
    assert_eq!(identity, DatabaseIdentity::read(&path).unwrap());
    let hard = directory.path().join("hard.db");
    std::fs::hard_link(&path, &hard).unwrap();
    let link = directory.path().join("symlink.db");
    symlink("history.db", &link).unwrap();
    assert_eq!(identity, DatabaseIdentity::read(&hard).unwrap());
    assert_eq!(identity, DatabaseIdentity::read(&link).unwrap());
    let replacement = directory.path().join("replacement.db");
    std::fs::write(&replacement, b"new generation").unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    assert_ne!(identity, DatabaseIdentity::read(&path).unwrap());
    assert_eq!(
        DatabaseIdentity::read(&path).unwrap(),
        DatabaseIdentity::read(&link).unwrap()
    );
    assert_eq!(identity, DatabaseIdentity::read(&hard).unwrap());
}

#[test]
fn identity_creation_is_private_and_never_truncates() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let identity = DatabaseIdentity::open_or_create(&path).unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    std::fs::write(&path, b"keep all existing bytes").unwrap();
    assert_eq!(identity, DatabaseIdentity::open_or_create(&path).unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), b"keep all existing bytes");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn identity_creates_dangling_symlink_target_without_replacing_link() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("link.db");
    let target = directory.path().join("history.db");
    symlink("history.db", &path).unwrap();
    let identity = DatabaseIdentity::open_or_create(&path).unwrap();
    assert_eq!(identity, DatabaseIdentity::read(&target).unwrap());
    assert!(std::fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn identity_concurrent_creators_observe_one_private_inode() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let barrier = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        let handles = (0..8)
            .map(|_| {
                let path = &path;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    DatabaseIdentity::open_or_create(path).unwrap()
                })
            })
            .collect::<Vec<_>>();
        let identities = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        assert!(identities.iter().all(|i| *i == identities[0]));
    });
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

type CreationHook = (&'static str, Box<dyn FnOnce()>);

thread_local! {
    static CREATION_HOOK: std::cell::RefCell<Option<CreationHook>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn creation_hook(stage: &str) {
    let hook = CREATION_HOOK.with(|hook| {
        let mut hook = hook.borrow_mut();
        if hook
            .as_ref()
            .is_some_and(|(expected, _)| *expected == stage)
        {
            hook.take()
        } else {
            None
        }
    });
    if let Some((_, hook)) = hook {
        hook();
    }
}

fn install_reader_at_creation(
    stage: &'static str,
    path: &Path,
) -> std::rc::Rc<std::cell::RefCell<Option<Connection>>> {
    let held = std::rc::Rc::new(std::cell::RefCell::new(None));
    let result = held.clone();
    let path = path.to_owned();
    CREATION_HOOK.with(|hook| {
        *hook.borrow_mut() = Some((
            stage,
            Box::new(move || {
                *held.borrow_mut() = Some(reader(&path));
                assert_sqlite_locked(&path);
            }),
        ))
    });
    result
}

#[test]
fn identity_first_creation_keeps_reader_opened_after_publication_locked() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let held = install_reader_at_creation("published", &path);
    let identity = DatabaseIdentity::open_or_create(&path).unwrap();
    assert!(held.borrow().is_some());
    assert_eq!(identity, DatabaseIdentity::read(&path).unwrap());
    assert_sqlite_locked(&path);
    drop(identity);
    assert_sqlite_locked(&path);
}

#[test]
fn identity_losing_creation_race_preserves_winner_bytes_and_sqlite_locks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.db");
    let held = install_reader_at_creation("missing", &path);
    let identity = DatabaseIdentity::open_or_create(&path).unwrap();
    assert!(held.borrow().is_some());
    let count: i64 = held
        .borrow()
        .as_ref()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM identity_fixture", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "losing creator must not truncate the winner");
    assert_eq!(identity, DatabaseIdentity::read(&path).unwrap());
    drop(identity);
    assert_sqlite_locked(&path);
    assert_eq!(
        std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(".tmp"))
            .count(),
        0
    );
}
