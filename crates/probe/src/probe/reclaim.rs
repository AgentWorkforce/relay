//! Reclaiming decommissioned installs, off the desktop's launch path.
//!
//! A decommissioned install is a directory under `~/.agentworkforce/probe/`
//! with neither `config.json` nor `signed-out.json`: older disconnects removed
//! their configuration and cancelled every job, but
//! kept `history.db`, whose `origin_id` keys every record the Cloud holds, so
//! reconnecting the same account resumes incrementally. `installs` never opens
//! such a directory; this command is the only one that does.
//!
//! Without a marker every call would open every decommissioned database
//! forever, a cost that grows by one per cloud uninstall or account switch. A
//! pass that finds nothing left to reclaim therefore writes a marker beside the
//! lock files recording what it observed of `history.db` and its WAL, and later
//! calls skip the directory on a `stat` while those still match.
//!
//! The marker's one allowed failure is a wasted open, never a skipped reclaim.
//! A decommissioned install is not terminal: a reconnect resumes from it, and a
//! later disconnect leaves it with a fresh generation to reclaim. Both write to
//! the database (setup creates a job, disconnect cancels it), which changes the
//! observed size or modification time of the database or its WAL, so the marker
//! invalidates itself without setup or disconnect knowing it exists. Anything
//! else that touches the files, such as a checkpoint, costs one more open.
//!
//! The marker's name is versioned: when reclamation learns to release
//! something an earlier build did not, bump [`MARKER`] and every directory an
//! older marker skipped is examined again.
use super::{bridge, lock, save_json};
use agent_relay_probe::delivery;
use anyhow::Result;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs, io,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Written when a pass finds nothing left to reclaim. Lives beside the lock
/// files, never among what a reclaim may delete.
pub const MARKER: &str = "reclaimed_v1.json";

/// Bounds one call's work in each directory it opens.
pub struct Policy {
    /// Settled receipts released per directory per call.
    pub receipt_page: usize,
    /// A store written this recently is not trusted to a marker: on a file
    /// system with coarse timestamps, a write in the same tick as the one the
    /// marker records would be indistinguishable from it.
    pub settle: Duration,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            receipt_page: 10_000,
            settle: Duration::from_secs(2),
        }
    }
}

/// What a `stat` observes of one file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Stamp {
    size: u64,
    modified_secs: u64,
    modified_nanos: u32,
    #[serde(default)]
    inode: u64,
}
/// What a pass observed of the store: the database and its WAL, where a
/// write lands first and may stay until a checkpoint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Observed {
    history_db: Stamp,
    wal: Option<Stamp>,
}

fn stamp(path: &Path) -> io::Result<Option<Stamp>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(&metadata);
    #[cfg(not(unix))]
    let inode = 0;
    Ok(Some(Stamp {
        size: metadata.len(),
        modified_secs: modified.as_secs(),
        modified_nanos: modified.subsec_nanos(),
        inode,
    }))
}
/// `None` when there is no database, and so nothing to reclaim.
fn observe(directory: &Path) -> io::Result<Option<Observed>> {
    let Some(history_db) = stamp(&directory.join("history.db"))? else {
        return Ok(None);
    };
    Ok(Some(Observed {
        history_db,
        wal: stamp(&directory.join("history.db-wal"))?,
    }))
}
/// Trusted only while it matches exactly; anything unreadable is dirty.
fn marked(directory: &Path, observed: &Observed) -> bool {
    fs::read(directory.join(MARKER))
        .ok()
        .and_then(|data| serde_json::from_slice::<Observed>(&data).ok())
        .is_some_and(|marker| &marker == observed)
}
fn settled(observed: &Observed, settle: Duration) -> bool {
    let newest = [Some(&observed.history_db), observed.wal.as_ref()]
        .into_iter()
        .flatten()
        .map(|s| Duration::new(s.modified_secs, s.modified_nanos))
        .max()
        .unwrap_or_default();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    newest + settle <= now
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    /// `config.json` exists: a live install, never touched here.
    Connected,
    /// No `history.db`: nothing to reclaim.
    Empty,
    /// The marker still matches the store.
    Marked,
    /// Another command holds the install's locks; try on a later call.
    Busy,
    /// A pass ran. `marked` says whether it found nothing left and wrote the
    /// marker; otherwise a later call continues.
    Reclaimed { records: usize, marked: bool },
}

fn try_lock(directory: &Path, name: &str) -> Result<Option<fs::File>> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join(name))?;
    Ok(file.try_lock_exclusive().ok().map(|_| file))
}

/// One bounded step of releasing what a decommissioned install no longer
/// needs; the caller holds both locks. Returns how much it released, so zero
/// means nothing was left. Anything this learns to release that an earlier
/// build did not must come with a bump of [`MARKER`].
fn release(directory: &Path, policy: &Policy) -> Result<usize> {
    // As the collector lock's holder: opening rebuilds a store still on the
    // export journal, which drops the journal tables nothing can consume.
    let conn = delivery::open_db(&directory.join("history.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let records = delivery::compact_receipts(&conn, policy.receipt_page)?;
    // Close before the caller observes the store: the last connection's
    // checkpoint moves the files, and a marker must record them as a later
    // call will see them.
    drop(conn);
    Ok(records)
}

fn reclaim_install(directory: &Path, policy: &Policy) -> Result<Outcome> {
    if directory.join("config.json").exists() || directory.join("signed-out.json").exists() {
        return Ok(Outcome::Connected);
    }
    let Some(observed) = observe(directory)? else {
        return Ok(Outcome::Empty);
    };
    if marked(directory, &observed) {
        return Ok(Outcome::Marked);
    }
    // Setup and every control action take these two in this order.
    let Some(_control) = try_lock(directory, "desktop.lock")? else {
        return Ok(Outcome::Busy);
    };
    let Ok(_collector) = lock(directory) else {
        return Ok(Outcome::Busy);
    };
    // Setup may have reconnected the directory before the locks were taken.
    if directory.join("config.json").exists() || directory.join("signed-out.json").exists() {
        return Ok(Outcome::Connected);
    }
    let records = release(directory, policy)?;
    // Only a pass that found nothing is trusted to a marker, so a pass that
    // released anything is always followed by one that confirms it is done.
    let mut wrote_marker = false;
    if records == 0 {
        if let Some(after) = observe(directory)? {
            if settled(&after, policy.settle) {
                save_json(&directory.join(MARKER), &after)?;
                wrote_marker = true;
            }
        }
    }
    Ok(Outcome::Reclaimed {
        records,
        marked: wrote_marker,
    })
}

/// One bounded pass over every decommissioned install under `root`.
fn reclaim_in(root: &Path, policy: &Policy) -> Result<Value> {
    let (mut examined, mut skipped, mut remaining, mut reclaimed_records) = (0, 0, 0, 0);
    if root.exists() {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            // One install that cannot be read must not stop the others.
            match reclaim_install(&entry.path(), policy) {
                Ok(Outcome::Connected | Outcome::Empty) => {}
                Ok(Outcome::Marked) => {
                    examined += 1;
                    skipped += 1;
                }
                Ok(Outcome::Busy) | Err(_) => {
                    examined += 1;
                    remaining += 1;
                }
                Ok(Outcome::Reclaimed { records, marked }) => {
                    examined += 1;
                    reclaimed_records += records;
                    if !marked {
                        remaining += 1;
                    }
                }
            }
        }
    }
    Ok(json!({"examined":examined, "skipped":skipped,
        "reclaimed_records":reclaimed_records, "remaining":remaining}))
}

/// `reclaim --json`: release what decommissioned installs no longer need.
pub fn reclaim() -> Result<()> {
    let root = super::home()?.join(".agentworkforce/probe");
    bridge::emit(reclaim_in(&root, &Policy::default())?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_relay_probe::delivery::{DeliveryJobConfig, ExportSelection};
    use rusqlite::Connection;

    fn policy(receipt_page: usize) -> Policy {
        Policy {
            receipt_page,
            settle: Duration::ZERO,
        }
    }
    fn job_config() -> DeliveryJobConfig {
        DeliveryJobConfig {
            destination_id: "relayhistory".into(),
            instance_id: "teams-probe".into(),
            account_id: agent_relay_probe::destination::account_id("org", Some("workspace")),
            mapping_version: agent_relay_probe::destination::MAPPING_VERSION.into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["session".into()],
                ..Default::default()
            },
            limits: Default::default(),
        }
    }
    fn open(directory: &Path) -> Connection {
        delivery::open_db(&directory.join("history.db")).unwrap()
    }
    /// A connected install's store with `receipts` settled receipts.
    fn connect(directory: &Path, receipts: usize) {
        fs::create_dir_all(directory).unwrap();
        let conn = open(directory);
        let job = delivery::create_job(&conn, &job_config(), 0).unwrap();
        for n in 0..receipts {
            conn.execute(
                "INSERT INTO delivery_batches(id,job_id,state,records,bytes,journal_end,created_ms) \
                 VALUES(?1,?2,'acknowledged',1,1,0,0)",
                rusqlite::params![format!("{}-batch-{n}", job.job_id), job.job_id],
            )
            .unwrap();
        }
        fs::write(directory.join("config.json"), "{}").unwrap();
    }
    /// What older disconnects left: every job cancelled, no saved configuration.
    fn decommission(directory: &Path) {
        let conn = open(directory);
        for job in delivery::list_jobs(&conn).unwrap() {
            if job.state != "cancelled" {
                delivery::cancel_job(&conn, &job.job_id).unwrap();
            }
        }
        drop(conn);
        fs::remove_file(directory.join("config.json")).unwrap();
    }
    fn receipts(directory: &Path) -> i64 {
        open(directory)
            .query_row("SELECT COUNT(*) FROM delivery_batches", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_signed_out_workspace_keeps_its_delivery_progress_untouched() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("saved");
        connect(&install, 3);
        fs::rename(install.join("config.json"), install.join("signed-out.json")).unwrap();
        let result = reclaim_in(root.path(), &policy(10)).unwrap();
        assert_eq!(result["examined"], 0);
        assert_eq!(receipts(&install), 3);
        assert!(!install.join(MARKER).exists());
    }

    #[test]
    fn a_connected_install_is_never_opened_or_marked() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("live");
        connect(&install, 3);
        let result = reclaim_in(root.path(), &policy(10)).unwrap();
        assert_eq!(result["examined"], 0);
        assert_eq!(receipts(&install), 3);
        assert!(!install.join(MARKER).exists());
    }

    #[test]
    fn reclaim_is_bounded_and_marks_only_once_a_pass_finds_nothing() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("old");
        connect(&install, 5);
        decommission(&install);

        let first = reclaim_in(root.path(), &policy(3)).unwrap();
        assert_eq!(first["reclaimed_records"], 3);
        assert_eq!(first["remaining"], 1);
        assert!(!install.join(MARKER).exists());

        let second = reclaim_in(root.path(), &policy(3)).unwrap();
        assert_eq!(second["reclaimed_records"], 2);
        assert_eq!(
            second["remaining"], 1,
            "a pass that released rows is confirmed by another"
        );
        assert!(!install.join(MARKER).exists());

        let third = reclaim_in(root.path(), &policy(3)).unwrap();
        assert_eq!(third["reclaimed_records"], 0);
        assert_eq!(third["remaining"], 0);
        assert!(install.join(MARKER).exists());

        let fourth = reclaim_in(root.path(), &policy(3)).unwrap();
        assert_eq!(fourth["examined"], 1);
        assert_eq!(fourth["skipped"], 1);
        assert_eq!(fourth["remaining"], 0);
    }

    /// `decommission → marker → reconnect → decommission` must not leave a
    /// stale marker on a directory with a fresh generation to reclaim.
    #[test]
    fn a_reconnect_invalidates_the_marker_without_clearing_it() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("old");
        connect(&install, 0);
        decommission(&install);
        reclaim_in(root.path(), &policy(10)).unwrap();
        assert!(install.join(MARKER).exists());

        // Setup knows nothing of the marker and leaves it in place.
        connect(&install, 4);
        decommission(&install);
        assert!(install.join(MARKER).exists());

        let result = reclaim_in(root.path(), &policy(10)).unwrap();
        assert_eq!(result["skipped"], 0);
        assert_eq!(result["reclaimed_records"], 4);
        assert_eq!(receipts(&install), 0);
    }

    /// A write that stays in the WAL, never checkpointed into the database,
    /// still invalidates the marker.
    #[test]
    fn a_write_still_in_the_wal_invalidates_the_marker() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("old");
        connect(&install, 0);
        decommission(&install);
        reclaim_in(root.path(), &policy(10)).unwrap();
        let before = observe(&install).unwrap().unwrap();
        assert!(marked(&install, &before));

        let conn = open(&install);
        conn.execute_batch("PRAGMA wal_autocheckpoint=0").unwrap();
        conn.execute(
            "INSERT INTO sessions(source,session_id,last_activity_ms) VALUES('claude','new',1)",
            [],
        )
        .unwrap();
        let after = observe(&install).unwrap().unwrap();
        assert!(!marked(&install, &after));
        std::mem::forget(conn); // keep the WAL as a crash would leave it
    }

    #[test]
    fn an_unreadable_or_foreign_marker_is_dirty() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("old");
        connect(&install, 0);
        decommission(&install);
        let observed = observe(&install).unwrap().unwrap();
        fs::write(install.join(MARKER), "not json").unwrap();
        assert!(!marked(&install, &observed));
        let mut other = observed.clone();
        other.history_db.size += 1;
        save_json(&install.join(MARKER), &other).unwrap();
        assert!(!marked(&install, &observed));
        save_json(&install.join(MARKER), &observed).unwrap();
        assert!(marked(&install, &observed));
    }

    #[test]
    fn a_recently_written_store_is_not_marked() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("old");
        connect(&install, 0);
        decommission(&install);
        let patient = Policy {
            receipt_page: 10,
            settle: Duration::from_secs(3600),
        };
        let result = reclaim_in(root.path(), &patient).unwrap();
        assert_eq!(result["remaining"], 1);
        assert!(!install.join(MARKER).exists());
    }

    #[test]
    fn a_busy_install_is_left_for_a_later_call() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("old");
        connect(&install, 2);
        decommission(&install);
        let held = try_lock(&install, "desktop.lock").unwrap().unwrap();
        let result = reclaim_in(root.path(), &policy(10)).unwrap();
        assert_eq!(result["remaining"], 1);
        assert_eq!(receipts(&install), 2);
        drop(held);
        assert_eq!(
            reclaim_in(root.path(), &policy(10)).unwrap()["reclaimed_records"],
            2
        );
    }

    /// A reconnect that starts while a pass holds the locks waits it out
    /// rather than failing, as it waits out a live install's control action.
    #[test]
    fn setup_waits_out_a_reclaim_pass_on_a_decommissioned_directory() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("old");
        connect(&install, 0);
        decommission(&install);
        let control = try_lock(&install, "desktop.lock").unwrap().unwrap();
        let collector = lock(&install).unwrap();
        let (taken, waiting) = std::sync::mpsc::channel();
        let path = install.clone();
        let setup = std::thread::spawn(move || {
            taken.send(()).unwrap();
            let control = bridge::setup_lock(&path, Duration::from_secs(10))?;
            let collector = lock(&path)?;
            anyhow::Ok((control, collector))
        });
        waiting.recv().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(!setup.is_finished(), "setup waits while the pass runs");
        // A pass releases the collector lock before the control lock.
        drop(collector);
        drop(control);
        setup.join().unwrap().unwrap();

        let live = root.path().join("live");
        connect(&live, 0);
        let held = try_lock(&live, "desktop.lock").unwrap().unwrap();
        let path = live.clone();
        let setup = std::thread::spawn(move || bridge::setup_lock(&path, Duration::from_secs(10)));
        std::thread::sleep(Duration::from_millis(300));
        assert!(!setup.is_finished(), "setup waits while the action runs");
        drop(held);
        setup.join().unwrap().unwrap();

        let _held = try_lock(&live, "desktop.lock").unwrap().unwrap();
        assert!(bridge::setup_lock(&live, Duration::from_millis(200)).is_err());
    }

    #[test]
    fn a_directory_without_a_store_is_ignored() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("empty")).unwrap();
        let result = reclaim_in(root.path(), &policy(10)).unwrap();
        assert_eq!(result["examined"], 0);
        assert!(!root.path().join("empty").join(MARKER).exists());
    }
}
