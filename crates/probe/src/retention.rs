//! Local history retention for this install's store, run by the collector
//! between delivery passes, never beside one and never on a session read.
//!
//! Each run publishes the upload floor ([`upload_floor`]) as this
//! install's RelayHistory retention consumer, then lets RelayHistory evict a
//! few bounded batches of expired history (`SessionStore::prune_expired`).
//! RelayHistory keeps every session with history above the lowest floor of
//! all its consumers, so nothing is evicted before it uploads; it reads the
//! retention policy the app saved in the store itself.
//!
//! An acknowledgement only moves forward. When the floor has to fall (a new
//! job, a member backfilling), a fresh consumer name is registered at zero,
//! acknowledged, and only then the previous ones removed, so the history is
//! protected throughout. That removal never relinquishes protection (the
//! replacement's floor is lower); no destination is ever retired here, and
//! eviction never sets `allow_unuploaded`.
//!
//! `retention-consumer.json` is written ahead of the store: it names every
//! consumer that may exist there, with an upper bound on the floor it may
//! have been acknowledged at, and the next generation, which is never
//! reused. A process that stops between any two steps leaves either more
//! than one name or a bound above the floor, and the next run rotates to a
//! fresh name again, so a name acknowledged at a higher floor is never
//! re-registered for a lower one (#680).
use crate::delivery;
use crate::relay::history_retention::applied_to;
use ai_hist::retention::RetentionOptions;
use ai_hist::{SessionStore, StoreOptions, Watermark};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The consumer names this install publishes as: `<prefix>-<generation>`.
const CONSUMER: &str = "relay-desktop-uploads";
/// The record of the consumer last published, beside `history.db`.
const STATE_FILE: &str = "retention-consumer.json";
/// The longest one run evicts for, so a delivery pass is never held back for
/// long; a run that ends early resumes at the next pass.
const BUDGET: Duration = Duration::from_secs(1);
/// After a full sweep of the store, the wait before the next one.
const SWEEP_EVERY: Duration = Duration::from_secs(10 * 60);
/// After the store was busy, or uploads have not been acknowledged.
const RETRY_EVERY: Duration = Duration::from_secs(30);

/// One consumer this install may have registered: its name's generation,
/// the store epoch, an upper bound on the floor it was acknowledged at, and
/// whether the store has taken that floor (until it has, the store may hold
/// a lower one).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Published {
    generation: u64,
    epoch: u64,
    floor: u64,
    #[serde(default)]
    acknowledged: bool,
}

impl Published {
    fn name(&self) -> String {
        format!("{CONSUMER}-{}", self.generation)
    }
}

/// The write-ahead record of this install's consumers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Consumers {
    /// The next generation to name. Advanced and saved before a name is
    /// registered, so no name is ever registered twice.
    next: u64,
    /// Every name that may exist in the store.
    live: Vec<Published>,
}

impl Consumers {
    /// The one consumer in step, when there is exactly one.
    fn only(&self) -> Option<&Published> {
        match self.live.as_slice() {
            [only] => Some(only),
            _ => None,
        }
    }
}

/// The record as #648 wrote it: the consumer last published, saved only
/// after its rotation finished.
#[derive(Deserialize)]
struct Legacy {
    generation: u64,
    epoch: u64,
    floor: u64,
}

/// What a run did, for the collector log and tests.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Run {
    /// The floor acknowledged this run, when it changed.
    pub acknowledged: Option<u64>,
    /// Sessions and rows evicted.
    pub sessions: u64,
    pub rows: u64,
}

/// The open store and when eviction is next due, kept across passes.
struct Maintenance {
    db: PathBuf,
    store: SessionStore,
    due: Instant,
}

static MAINTENANCE: Mutex<Option<Maintenance>> = Mutex::new(None);

/// Publishes the floor and, when due, evicts expired history in this
/// install's store. Failures are logged, never raised: retention must not
/// stop delivery.
pub fn maintain(directory: &Path, cancelled: &AtomicBool) {
    match run(directory, &app_data_dir(), cancelled, Instant::now()) {
        Ok(run) if run.acknowledged.is_some() || run.rows > 0 => eprintln!(
            "retention: acknowledged uploads through {:?}; evicted {} rows of {} expired sessions",
            run.acknowledged, run.rows, run.sessions
        ),
        Ok(_) => {}
        Err(error) => eprintln!("retention: {error:#}"),
    }
}

/// The app's data directory, where its retention choice is saved: the one
/// the relay core started this collector with, else the default.
fn app_data_dir() -> PathBuf {
    let env = |key: &str| std::env::var(key).ok();
    std::env::var_os(crate::cloud::APP_DATA_DIR_VARIABLE)
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| {
            let home = crate::platform::home_dir().unwrap_or_default();
            crate::relay::app_store::default_data_dir(&env, &home)
        })
}

fn run(directory: &Path, app_data: &Path, cancelled: &AtomicBool, now: Instant) -> Result<Run> {
    let db = directory.join("history.db");
    let mut held = MAINTENANCE.lock().unwrap_or_else(|p| p.into_inner());
    if held.as_ref().is_none_or(|held| held.db != db) {
        let store = SessionStore::open(StoreOptions::default().db_path(&db))
            .context("opening the history store")?;
        *held = Some(Maintenance {
            db,
            store,
            due: now,
        });
    }
    let maintenance = held.as_mut().context("history store unavailable")?;
    let mut run = Run {
        acknowledged: publish(directory, &maintenance.store)?,
        ..Run::default()
    };
    // Nothing is evicted by a policy the app has not yet saved in this store.
    let epoch = maintenance.store.head_revision()?.epoch;
    if now >= maintenance.due && !applied_to(app_data, &maintenance.db, epoch) {
        maintenance.due = now + RETRY_EVERY;
    }
    if now >= maintenance.due {
        // Re-registering keeps progress, and restores a consumer another
        // client removed.
        if let Some(only) = load(directory).only() {
            maintenance
                .store
                .register_retention_consumer(&only.name())?;
        }
        maintenance.due = evict(&maintenance.store, cancelled, &mut run)?;
    }
    Ok(run)
}

/// Acknowledges the current upload floor; returns it when it changed.
fn publish(directory: &Path, store: &SessionStore) -> Result<Option<u64>> {
    let conn = delivery::open_db_readonly(&directory.join("history.db"))?;
    let Some(floor) = upload_floor(&conn)? else {
        return Ok(None);
    };
    drop(conn);
    let head = store.head_revision()?;
    if floor > head.revision {
        // RelayHistory refuses a position past its head; trying would leave
        // a fresh name behind on every pass.
        return Ok(None);
    }
    let mut consumers = load(directory);
    match consumers.only() {
        // Unchanged and acknowledged: nothing is written, so a pass does not
        // wait on a capture that holds the store's writer.
        Some(only) if only.epoch == head.epoch && floor == only.floor && only.acknowledged => {
            return Ok(None)
        }
        // Raised, or a raise a stopped run recorded but did not acknowledge:
        // the bound is recorded first, then acknowledged, then marked so.
        Some(only) if only.epoch == head.epoch && floor >= only.floor => {
            let name = only.name();
            consumers.live[0].floor = floor;
            consumers.live[0].acknowledged = false;
            save(directory, &consumers)?;
            store.register_retention_consumer(&name)?;
            acknowledge(store, &name, floor, head.epoch)?;
            consumers.live[0].acknowledged = true;
            save(directory, &consumers)?;
            return Ok(Some(floor));
        }
        _ => {}
    }
    // A fresh name, recorded before it exists, then the old ones removed.
    // Whatever this install has in the store is retired too, and the fresh
    // generation is past all of it, should the record and the store ever
    // disagree (a record restored from a backup).
    let mut retired = std::mem::take(&mut consumers.live);
    for found in recovered(directory).live {
        if !retired
            .iter()
            .any(|known| known.generation == found.generation)
        {
            retired.push(found);
        }
    }
    let past = retired
        .iter()
        .map(|old| old.generation + 1)
        .max()
        .unwrap_or(1);
    let mut fresh = Published {
        generation: consumers.next.max(past),
        epoch: head.epoch,
        floor,
        acknowledged: false,
    };
    consumers.next = fresh.generation + 1;
    consumers.live = retired.iter().cloned().chain([fresh.clone()]).collect();
    save(directory, &consumers)?;
    store.register_retention_consumer(&fresh.name())?;
    acknowledge(store, &fresh.name(), floor, head.epoch)?;
    for old in &retired {
        store.remove_retention_consumer(&old.name())?;
    }
    fresh.acknowledged = true;
    consumers.live = vec![fresh];
    save(directory, &consumers)?;
    Ok(Some(floor))
}

fn acknowledge(store: &SessionStore, name: &str, floor: u64, epoch: u64) -> Result<()> {
    if floor > 0 {
        let position = Watermark {
            revision: floor,
            epoch,
        };
        store.acknowledge_retention(name, position)?;
    }
    Ok(())
}

/// Evicts bounded batches until the store is swept, busy, waiting on an
/// upload acknowledgement, stopped, or the run's budget is spent; returns
/// when eviction is next due.
fn evict(store: &SessionStore, cancelled: &AtomicBool, run: &mut Run) -> Result<Instant> {
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) || started.elapsed() >= BUDGET {
            return Ok(Instant::now());
        }
        let report = store.prune_expired(RetentionOptions::default())?;
        run.sessions += report.sessions;
        run.rows += report.rows;
        if report.cycle_complete {
            return Ok(Instant::now() + SWEEP_EVERY);
        }
        if report.busy || report.awaiting_upload_ack {
            return Ok(Instant::now() + RETRY_EVERY);
        }
        if report.deferred {
            // RelayHistory's cooldown between batches: this is the
            // collector's own thread, not a session read or write.
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// The record, or none yet. A record #648 wrote is read as its consumer
/// plus the next generation, which a rotation it did not finish may have
/// registered: that name's floor is unknown, so it is retired too.
fn load(directory: &Path) -> Consumers {
    let Ok(bytes) = std::fs::read(directory.join(STATE_FILE)) else {
        return recovered(directory);
    };
    if let Ok(consumers) = serde_json::from_slice::<Consumers>(&bytes) {
        return consumers;
    }
    let Ok(legacy) = serde_json::from_slice::<Legacy>(&bytes) else {
        return recovered(directory);
    };
    let published = |generation, floor| Published {
        generation,
        epoch: legacy.epoch,
        floor,
        acknowledged: false,
    };
    Consumers {
        next: legacy.generation + 2,
        live: vec![
            published(legacy.generation, legacy.floor),
            published(legacy.generation + 1, u64::MAX),
        ],
    }
}

/// With no record to go by (#648 stopped before writing its first one, or
/// the record cannot be read), every consumer of this install's in the store
/// is taken as live with an unknown floor, so the next run rotates past all
/// of them.
fn recovered(directory: &Path) -> Consumers {
    let generations = rusqlite::Connection::open_with_flags(
        directory.join("history.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .and_then(|conn| {
        let mut names = conn.prepare("SELECT name FROM retention_consumers")?;
        let names = names
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(names)
    })
    .unwrap_or_default()
    .into_iter()
    .filter_map(|name| {
        name.strip_prefix(&format!("{CONSUMER}-"))?
            .parse::<u64>()
            .ok()
    })
    .collect::<std::collections::BTreeSet<_>>();
    Consumers {
        next: generations.last().map_or(1, |last| last + 1),
        live: generations
            .into_iter()
            .map(|generation| Published {
                generation,
                epoch: 0,
                floor: u64::MAX,
                acknowledged: false,
            })
            .collect(),
    }
}

fn save(directory: &Path, consumers: &Consumers) -> Result<()> {
    let bytes = serde_json::to_vec(consumers)?;
    atomicwrites::AtomicFile::new(directory.join(STATE_FILE), atomicwrites::AllowOverwrite)
        .write(|file| std::io::Write::write_all(file, &bytes))
        .context("saving the retention consumers")
}

// The upload floor RelayHistory's local retention may evict below
// (`SessionStore::acknowledge_retention`): the highest feed revision through
// which every record any delivery job still has to send has been durably
// acknowledged. A floor that is too low only keeps history longer; one that
// is too high would let retention evict history before it uploads, so every
// doubt resolves downwards.

/// The upload floor across every job that is not cancelled, or `None` when
/// there is none: no job means nothing has promised an upload yet, so no
/// floor is published.
///
/// An all-sessions job sends the feed in order, so its contiguous
/// acknowledged position (`acknowledged_cursor`) is its floor. A
/// selected-sessions job also backfills each member it adds from the feed's
/// start, in batches labelled with its feed cursor rather than the oldest
/// revision they hold: while any member is still backfilling, or any of its
/// batches is unresolved, its floor is 0.
/// Paused and blocked jobs count: their history waits for them.
pub fn upload_floor(conn: &Connection) -> Result<Option<u64>> {
    let mut jobs = conn.prepare(
        "SELECT id,acknowledged_cursor FROM delivery_jobs WHERE state<>'cancelled' ORDER BY id",
    )?;
    let jobs = jobs
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut floor: Option<u64> = None;
    for (job, acknowledged) in jobs {
        let acknowledged = u64::try_from(acknowledged).unwrap_or(0);
        let job_floor = if delivery::is_session_job(conn, &job)? && backfilling(conn, &job)? {
            0
        } else {
            acknowledged
        };
        floor = Some(floor.map_or(job_floor, |floor| floor.min(job_floor)));
    }
    Ok(floor)
}

/// Whether a selected-sessions job may still owe history below its
/// acknowledged position: a member whose backfill has not reached its
/// cutoff, or any unresolved batch. A backfill batch is labelled with the
/// job's feed cursor, not the oldest revision it holds, so an unresolved
/// batch says nothing about how old its records are.
fn backfilling(conn: &Connection, job: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_session_members WHERE job_id=?1 AND bootstrap_done=0)
          OR EXISTS(SELECT 1 FROM delivery_batches WHERE job_id=?1 AND state IN ('pending','leased','retry_wait','blocked'))",
        params![job],
        |row| row.get(0),
    )?)
}

#[cfg(test)]
#[path = "retention/tests/verification/mod.rs"]
mod verification;

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Connection) {
        let directory = tempfile::tempdir().unwrap();
        let conn = delivery::open_db(&directory.path().join("history.db")).unwrap();
        (directory, conn)
    }

    fn floor_job(conn: &Connection, id: &str, state: &str, acknowledged: i64) {
        conn.execute(
            "INSERT INTO delivery_jobs(id,destination_id,instance_id,account_id,generation,config_json,state,created_ms,acknowledged_cursor)
             VALUES (?1,'relayhistory',?1,'acct',1,'{}',?2,0,?3)",
            params![id, state, acknowledged],
        )
        .unwrap();
    }

    fn session_job(conn: &Connection, id: &str, acknowledged: i64, member_done: bool) {
        floor_job(conn, id, "active", acknowledged);
        conn.execute(
            "INSERT INTO delivery_session_jobs(job_id) VALUES (?1)",
            [id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO delivery_session_members(id,job_id,source,session_id,cutoff,cursor,bootstrap_done)
             VALUES (?1||'-m',?1,'claude','s',40,40,?2)",
            params![id, member_done],
        )
        .unwrap();
    }

    #[test]
    fn no_job_has_no_floor() {
        let (_dir, conn) = store();
        assert_eq!(upload_floor(&conn).unwrap(), None);
        floor_job(&conn, "gone", "cancelled", 90);
        assert_eq!(
            upload_floor(&conn).unwrap(),
            None,
            "cancelled jobs owe nothing"
        );
    }

    #[test]
    fn the_floor_is_the_lowest_job_and_paused_jobs_count() {
        let (_dir, conn) = store();
        floor_job(&conn, "a", "active", 70);
        assert_eq!(upload_floor(&conn).unwrap(), Some(70));
        floor_job(&conn, "b", "paused", 30);
        assert_eq!(upload_floor(&conn).unwrap(), Some(30));
    }

    #[test]
    fn a_backfilling_member_or_any_unresolved_batch_holds_the_floor_at_zero() {
        let (_dir, conn) = store();
        session_job(&conn, "s", 50, false);
        assert_eq!(
            upload_floor(&conn).unwrap(),
            Some(0),
            "member still backfilling"
        );

        let (_dir, conn) = store();
        session_job(&conn, "s", 50, true);
        assert_eq!(upload_floor(&conn).unwrap(), Some(50));
        conn.execute(
            "INSERT INTO delivery_batches(id,job_id,state,records,bytes,journal_end,created_ms) VALUES ('b1','s','pending',1,1,40,0)",
            [],
        )
        .unwrap();
        assert_eq!(
            upload_floor(&conn).unwrap(),
            Some(0),
            "unresolved backfill batch"
        );
        conn.execute("UPDATE delivery_batches SET state='acknowledged'", [])
            .unwrap();
        assert_eq!(upload_floor(&conn).unwrap(), Some(50));
        // A backfill batch is labelled with the job's cursor, so one labelled
        // above the acknowledged position can still hold old records.
        conn.execute(
            "INSERT INTO delivery_batches(id,job_id,state,records,bytes,journal_end,created_ms) VALUES ('b2','s','pending',1,1,90,0)",
            [],
        )
        .unwrap();
        assert_eq!(
            upload_floor(&conn).unwrap(),
            Some(0),
            "unresolved batch above it"
        );
    }

    fn consumers(db: &Path) -> Vec<(String, i64)> {
        let conn = rusqlite::Connection::open(db).unwrap();
        let mut query = conn
            .prepare("SELECT name,revision FROM retention_consumers ORDER BY name")
            .unwrap();
        query
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn job(db: &Path, id: &str, acknowledged: i64) {
        let conn = delivery::open_db(db).unwrap();
        conn.execute(
            "INSERT INTO delivery_jobs(id,destination_id,instance_id,account_id,generation,config_json,state,created_ms,acknowledged_cursor)
             VALUES (?1,'relayhistory',?1,'acct',1,'{}','active',0,?2)
             ON CONFLICT(id) DO UPDATE SET acknowledged_cursor=excluded.acknowledged_cursor",
            rusqlite::params![id, acknowledged],
        )
        .unwrap();
    }

    /// A store with `changes` feed revisions, so acknowledgements up to it
    /// are within its head.
    fn store_with_history(directory: &Path, changes: usize) -> SessionStore {
        let db = directory.join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        for n in 0..changes {
            conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude','session',?1,42,'user','text','kept')", [format!("event-{n}")]).unwrap();
        }
        drop(conn);
        SessionStore::open(StoreOptions::default().db_path(&db)).unwrap()
    }

    #[test]
    fn no_job_publishes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_history(dir.path(), 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), None);
        assert!(consumers(&dir.path().join("history.db")).is_empty());
    }

    #[test]
    fn the_floor_moves_forward_and_a_lower_one_replaces_the_consumer() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_history(dir.path(), 4);
        let head = store.head_revision().unwrap().revision;
        assert!(head >= 2, "the fixture has feed history: {head}");
        let db = dir.path().join("history.db");

        job(&db, "a", 1);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(1));
        assert_eq!(consumers(&db), [("relay-desktop-uploads-1".to_string(), 1)]);
        // Unchanged: nothing new is acknowledged.
        assert_eq!(publish(dir.path(), &store).unwrap(), None);

        job(&db, "a", head as i64);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(head));
        assert_eq!(
            consumers(&db),
            [("relay-desktop-uploads-1".to_string(), head as i64)]
        );

        // A second job starting from zero lowers the floor: a new consumer
        // at zero replaces the old one, which would have kept its higher ack.
        job(&db, "b", 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(0));
        assert_eq!(consumers(&db), [("relay-desktop-uploads-2".to_string(), 0)]);
    }

    fn lowest(db: &Path) -> i64 {
        rusqlite::Connection::open(db)
            .unwrap()
            .query_row("SELECT MIN(revision) FROM retention_consumers", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    /// A store with a job acknowledged through revision 2, published once.
    fn published_at_two(dir: &Path) -> (SessionStore, PathBuf, u64) {
        let store = store_with_history(dir, 3);
        let db = dir.join("history.db");
        let epoch = store.head_revision().unwrap().epoch;
        job(&db, "a", 2);
        assert_eq!(publish(dir, &store).unwrap(), Some(2));
        (store, db, epoch)
    }

    /// #680: a #648 rotation stopped after generation 2 was registered and
    /// acknowledged and generation 1 removed, but before the record was
    /// saved. A later floor of 0 must not reuse generation 2, which would
    /// keep its acknowledgement and leave revisions up to 2 evictable.
    #[test]
    fn an_interrupted_rotation_from_before_is_not_reused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_history(dir.path(), 3);
        let db = dir.path().join("history.db");
        let epoch = store.head_revision().unwrap().epoch;
        // The durable state #648 could leave: the record still names
        // generation 1 at floor 1; the store holds generation 2 at 2.
        std::fs::write(
            dir.path().join(STATE_FILE),
            serde_json::to_vec(&serde_json::json!({"generation": 1, "epoch": epoch, "floor": 1}))
                .unwrap(),
        )
        .unwrap();
        store
            .register_retention_consumer("relay-desktop-uploads-2")
            .unwrap();
        store
            .acknowledge_retention("relay-desktop-uploads-2", Watermark { revision: 2, epoch })
            .unwrap();
        assert_eq!(lowest(&db), 2);

        // A new job lowers the floor to 0.
        job(&db, "a", 2);
        job(&db, "b", 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(0));
        assert_eq!(lowest(&db), 0, "the new backlog is protected");
        assert_eq!(consumers(&db), [("relay-desktop-uploads-3".to_string(), 0)]);
    }

    // The W1-V regression for #680, verbatim from relay-desktop#682
    // (sp/w1v-retention-verification 5e5c20d7, probe/src/retention/tests/
    // verification/mod.rs) apart from its job helpers' names and the
    // #[ignore] it carried while the bug stood.
    fn verified_config(instance: &str) -> delivery::DeliveryJobConfig {
        delivery::DeliveryJobConfig {
            destination_id: "w1v-synthetic".into(),
            instance_id: instance.into(),
            account_id: "synthetic-account".into(),
            mapping_version: "1".into(),
            selection: delivery::ExportSelection {
                all_sources: true,
                kinds: ai_hist::ChangeKind::ALL
                    .iter()
                    .map(|k| k.as_str().into())
                    .collect(),
                ..delivery::ExportSelection::default()
            },
            limits: delivery::DeliveryLimits {
                max_batch_records: 64,
                ..delivery::DeliveryLimits::default()
            },
        }
    }

    fn verified_job(conn: &Connection, id: &str, floor: u64) {
        let job = delivery::create_job(conn, &verified_config(id), 0).unwrap();
        if floor > 0 {
            // Seed the durable position an already delivered prefix would hold;
            // every destination's config and identity come from the real job API.
            conn.execute("UPDATE delivery_jobs SET acknowledged_cursor=?1,journal_cursor=?1,bootstrap_done=1 WHERE id=?2", params![floor, job.job_id]).unwrap();
        }
    }

    #[test]
    fn interrupted_consumer_rotation_must_not_reuse_a_higher_acknowledgement() {
        let directory = tempfile::tempdir().unwrap();
        let db = directory.path().join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        for n in 0..3 {
            conn.execute("INSERT INTO session_events(source,session_id,event_uid,ts_ms,role,kind,text) VALUES ('claude',?1,?1,42,'user','text','synthetic')", [format!("synthetic-old-{n}")]).unwrap();
        }
        let store = SessionStore::open(StoreOptions::default().db_path(&db)).unwrap();
        let head = store.head_revision().unwrap();
        assert!(head.revision >= 3);
        verified_job(&conn, "first", head.revision);
        // Freeze the actual #648 on-disk contract rather than depending on the
        // publisher's current in-memory structs. The same test can check a fix
        // which replaces that representation while still upgrading old stores.
        let before = serde_json::json!({"generation":1,"epoch":head.epoch,"floor":head.revision});
        let state = directory.path().join("retention-consumer.json");
        std::fs::write(&state, serde_json::to_vec(&before).unwrap()).unwrap();
        let original = "relay-desktop-uploads-1";
        let interrupted = "relay-desktop-uploads-2";
        store.register_retention_consumer(original).unwrap();
        store
            .acknowledge_retention(
                original,
                Watermark {
                    epoch: head.epoch,
                    revision: head.revision,
                },
            )
            .unwrap();

        verified_job(&conn, "second", head.revision - 1);
        assert_eq!(upload_floor(&conn).unwrap(), Some(head.revision - 1));

        // Exact durable state after rotation's register/ack/remove but before
        // retention-consumer.json is replaced (e.g. process death at that point).
        store.register_retention_consumer(interrupted).unwrap();
        store
            .acknowledge_retention(
                interrupted,
                Watermark {
                    epoch: head.epoch,
                    revision: head.revision - 1,
                },
            )
            .unwrap();
        store.remove_retention_consumer(original).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(state).unwrap()).unwrap();
        assert_eq!(saved, before);

        // A newly added destination/backfill now needs all historic evidence.
        // Reopening must publish a genuinely zero floor, not reuse the orphan's
        // monotone acknowledgement while only recording zero in the JSON file.
        verified_job(&conn, "new-backfill", 0);
        assert_eq!(upload_floor(&conn).unwrap(), Some(0));
        publish(directory.path(), &store).unwrap();
        let actual: u64 = conn
            .query_row("SELECT MIN(revision) FROM retention_consumers", [], |r| {
                r.get(0)
            })
            .unwrap();
        // Demonstrate the consequence using the real pruner, not just the
        // contradictory bookkeeping: the new destination has uploaded none of
        // these three sessions, so all three must survive.
        let options = RetentionOptions {
            min_interval_ms: 0,
            ..Default::default()
        };
        for _ in 0..20 {
            if store.prune_expired(options.clone()).unwrap().cycle_complete {
                break;
            }
        }
        let retained: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            (actual, retained),
            (0, 3),
            "recovered rotation must protect every session still owed to the new job"
        );
    }

    /// #648 could register and acknowledge its first consumer, then stop
    /// before writing any record: with no record, the store's own consumers
    /// are recovered so that name is not registered again for a lower floor.
    #[test]
    fn a_first_publish_that_left_no_record_is_not_reused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_with_history(dir.path(), 3);
        let db = dir.path().join("history.db");
        let epoch = store.head_revision().unwrap().epoch;
        store
            .register_retention_consumer("relay-desktop-uploads-1")
            .unwrap();
        store
            .acknowledge_retention("relay-desktop-uploads-1", Watermark { revision: 2, epoch })
            .unwrap();
        assert!(!dir.path().join(STATE_FILE).exists());

        job(&db, "b", 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(0));
        assert_eq!(lowest(&db), 0);
        assert_eq!(consumers(&db), [("relay-desktop-uploads-2".to_string(), 0)]);

        // An unreadable record is recovered the same way.
        std::fs::write(dir.path().join(STATE_FILE), b"not json").unwrap();
        job(&db, "b", 2);
        job(&db, "c", 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(0));
        assert_eq!(consumers(&db), [("relay-desktop-uploads-3".to_string(), 0)]);
    }

    /// A record that disagrees with the store (one restored from a backup
    /// names generation 1 while the store holds generation 2) still rotates
    /// to a generation the store has never had.
    #[test]
    fn a_rotation_never_picks_a_generation_already_in_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let (store, db, epoch) = published_at_two(dir.path());
        store
            .register_retention_consumer("relay-desktop-uploads-2")
            .unwrap();
        store
            .acknowledge_retention("relay-desktop-uploads-2", Watermark { revision: 2, epoch })
            .unwrap();
        store
            .remove_retention_consumer("relay-desktop-uploads-1")
            .unwrap();
        assert_eq!(load(dir.path()).next, 2, "the record still expects 2 next");
        job(&db, "b", 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(0));
        assert_eq!(lowest(&db), 0);
        assert_eq!(consumers(&db), [("relay-desktop-uploads-3".to_string(), 0)]);
    }

    /// Stopping between any two steps of a rotation leaves protection at or
    /// below the floor once the next run has published.
    #[test]
    fn a_rotation_stopped_at_any_step_recovers() {
        // Stopped after the fresh name was recorded, before it was
        // registered: it does not exist yet.
        let dir = tempfile::tempdir().unwrap();
        let (store, db, epoch) = published_at_two(dir.path());
        let mut record = load(dir.path());
        record.live.push(Published {
            generation: 2,
            epoch,
            floor: 0,
            acknowledged: false,
        });
        record.next = 3;
        save(dir.path(), &record).unwrap();
        job(&db, "b", 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(0));
        assert_eq!(consumers(&db), [("relay-desktop-uploads-3".to_string(), 0)]);

        // Stopped after the fresh name was registered and acknowledged,
        // before the old one was removed: both exist.
        let dir = tempfile::tempdir().unwrap();
        let (store, db, epoch) = published_at_two(dir.path());
        let mut record = load(dir.path());
        record.live.push(Published {
            generation: 2,
            epoch,
            floor: 2,
            acknowledged: false,
        });
        record.next = 3;
        save(dir.path(), &record).unwrap();
        store
            .register_retention_consumer("relay-desktop-uploads-2")
            .unwrap();
        store
            .acknowledge_retention("relay-desktop-uploads-2", Watermark { revision: 2, epoch })
            .unwrap();
        job(&db, "b", 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(0));
        assert_eq!(consumers(&db), [("relay-desktop-uploads-3".to_string(), 0)]);
        assert_eq!(lowest(&db), 0);

        // Stopped after a raised bound was recorded, before the
        // acknowledgement: the store lags, which only protects more, and the
        // next run with the same floor acknowledges it after all.
        let dir = tempfile::tempdir().unwrap();
        let (store, db, _) = published_at_two(dir.path());
        let mut record = load(dir.path());
        record.live[0].floor = 3;
        record.live[0].acknowledged = false;
        save(dir.path(), &record).unwrap();
        assert_eq!(lowest(&db), 2);
        job(&db, "a", 3);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(3));
        assert_eq!(lowest(&db), 3, "the interrupted raise is retried");
        assert!(load(dir.path()).only().unwrap().acknowledged);
        assert_eq!(
            publish(dir.path(), &store).unwrap(),
            None,
            "then nothing to write"
        );
        job(&db, "b", 0);
        assert_eq!(publish(dir.path(), &store).unwrap(), Some(0));
        assert_eq!(lowest(&db), 0);
    }

    /// The record names every consumer before it exists and only one once a
    /// rotation finishes.
    #[test]
    fn the_record_is_written_ahead_of_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let (store, db, epoch) = published_at_two(dir.path());
        assert_eq!(
            load(dir.path()),
            Consumers {
                next: 2,
                live: vec![Published {
                    generation: 1,
                    epoch,
                    floor: 2,
                    acknowledged: true,
                }],
            }
        );
        job(&db, "b", 0);
        publish(dir.path(), &store).unwrap();
        assert_eq!(
            load(dir.path()),
            Consumers {
                next: 3,
                live: vec![Published {
                    generation: 2,
                    epoch,
                    floor: 0,
                    acknowledged: true,
                }],
            }
        );
    }

    fn events(db: &Path) -> i64 {
        rusqlite::Connection::open(db)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM session_events", [], |row| row.get(0))
            .unwrap()
    }

    /// Expired history stays until the app's choice is in the store and
    /// uploads are acknowledged past it, then goes; RelayHistory reads the
    /// policy the app saved in the store.
    #[test]
    fn expired_history_is_evicted_only_once_it_has_uploaded() {
        let dir = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let store = store_with_history(dir.path(), 3);
        let db = dir.path().join("history.db");
        let head = store.head_revision().unwrap();
        drop(store);
        ai_hist::retention::write_retention_policy(
            &db,
            ai_hist::retention::RetentionPolicy::from_days(7),
        )
        .unwrap();
        let stop = AtomicBool::new(false);
        let mut now = Instant::now();
        let mut next = || {
            now += RETRY_EVERY + Duration::from_secs(1);
            now
        };

        job(&db, "a", 0);
        let held = run(dir.path(), app.path(), &stop, next()).unwrap();
        assert_eq!((held.rows, events(&db)), (0, 3), "nothing uploaded yet");

        // Uploaded, but the app has not saved its choice in this store yet
        // (a store first seen, or recreated): its default must not evict.
        job(&db, "a", head.revision as i64);
        let waiting = run(dir.path(), app.path(), &stop, next()).unwrap();
        assert_eq!(waiting.acknowledged, Some(head.revision));
        assert_eq!(
            (waiting.rows, events(&db)),
            (0, 3),
            "choice not applied yet"
        );

        std::fs::write(
            app.path().join("history-retention.json"),
            serde_json::to_vec(&serde_json::json!({
                "days": 7, "store": {"path": db, "epoch": head.epoch}
            }))
            .unwrap(),
        )
        .unwrap();
        let evicted = run(dir.path(), app.path(), &stop, next()).unwrap();
        assert!(evicted.rows > 0, "{evicted:?}");
        assert_eq!(events(&db), 0);
    }
}
