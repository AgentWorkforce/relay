//! Codex's own record of its threads, `state_5.sqlite` under Codex home.
//!
//! The database is Codex's, read-only to the relay, and its schema moves
//! with Codex releases: the columns the relay needs are required, the rest
//! are used when present.

use super::CodexConfig;
use rusqlite::{Connection, OpenFlags};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// A thread Codex knows about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexThread {
    pub id: String,
    pub title: String,
    /// The thread's working directory, when recorded.
    pub directory: Option<String>,
    pub created_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
}

impl CodexThread {
    /// The directory's last component.
    pub fn project(&self) -> Option<String> {
        let directory = self.directory.as_deref()?.trim_end_matches('/');
        let name = directory.rsplit('/').next()?;
        (!name.is_empty()).then(|| name.to_string())
    }
}

fn database(config: &CodexConfig) -> PathBuf {
    config.sqlite_home.join("state_5.sqlite")
}

/// Codex's database, kept open between reads so a discovery pass reuses the
/// connection's page cache and parsed statements instead of reopening the
/// file and parsing its schema again. A file replaced at the path (another
/// inode) is opened anew; one idle for `KEPT_IDLE`, or whose file is gone,
/// is closed.
struct Kept {
    file: (u64, u64),
    connection: Connection,
    idle_since: std::time::Instant,
}

/// How long an unused connection stays open: a database no longer read is
/// closed.
const KEPT_IDLE: Duration = Duration::from_secs(5 * 60);

/// Idle connections by database. A read takes its connection out for the
/// read's length, so concurrent reads (a discovery pass waiting out Codex's
/// write lock, a caller check with a short timeout) never wait for each
/// other: a read that finds none idle opens its own.
static KEPT: std::sync::LazyLock<Mutex<HashMap<PathBuf, Kept>>> =
    std::sync::LazyLock::new(Mutex::default);

#[cfg(unix)]
fn file_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.dev(), metadata.ino()))
}

/// Without a stable file identity every read opens the file.
#[cfg(not(unix))]
fn file_identity(_: &Path) -> Option<(u64, u64)> {
    None
}

fn kept() -> MutexGuard<'static, HashMap<PathBuf, Kept>> {
    let mut kept = KEPT.lock().unwrap_or_else(|error| error.into_inner());
    sweep(&mut kept, KEPT_IDLE);
    kept
}

/// Closes connections idle for `idle` and those whose file is gone or
/// replaced.
fn sweep(kept: &mut HashMap<PathBuf, Kept>, idle: Duration) {
    kept.retain(|path, kept| {
        kept.idle_since.elapsed() < idle && file_identity(path) == Some(kept.file)
    });
}

/// `read` over Codex's database, waiting out a write for up to `busy`.
fn with_connection<T>(
    config: &CodexConfig,
    busy: Duration,
    read: impl FnOnce(&Connection) -> Option<T>,
) -> Option<T> {
    let path = database(config);
    let file = file_identity(&path);
    let idle = kept()
        .remove(&path)
        .filter(|kept| Some(kept.file) == file)
        .map(|kept| kept.connection);
    let connection = match idle {
        Some(connection) => connection,
        None => Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()?,
    };
    // Codex writes this database while it runs; a write is waited out
    // rather than read as "no threads".
    connection.busy_timeout(busy).ok()?;
    let found = read(&connection);
    if let Some(file) = file {
        let idle_since = std::time::Instant::now();
        kept().insert(
            path,
            Kept {
                file,
                connection,
                idle_since,
            },
        );
    }
    found
}

fn columns(connection: &Connection) -> Option<HashSet<String>> {
    let mut statement = connection
        .prepare_cached("pragma table_info(threads)")
        .ok()?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .ok()?
        .collect::<Result<HashSet<_>, _>>()
        .ok()?;
    (!names.is_empty()).then_some(names)
}

/// The select list for a thread row: id, title, cwd, created ms, updated
/// ms. Every name comes from this file, never from input.
fn select_list(columns: &HashSet<String>) -> Option<String> {
    if !["id", "title", "archived", "source"]
        .iter()
        .all(|column| columns.contains(*column))
    {
        return None;
    }
    let has = |column: &str| columns.contains(column);
    let title = if has("name") {
        "coalesce(nullif(name, ''), title)"
    } else {
        "title"
    };
    let cwd = if has("cwd") { "cwd" } else { "null" };
    let seconds_or = |ms: &str, seconds: &str| match (has(ms), has(seconds)) {
        (true, true) => format!("coalesce({ms}, {seconds} * 1000)"),
        (true, false) => ms.to_string(),
        (false, true) => format!("{seconds} * 1000"),
        (false, false) => "null".to_string(),
    };
    Some(format!(
        "id, {title}, {cwd}, {}, {}",
        seconds_or("created_at_ms", "created_at"),
        seconds_or("updated_at_ms", "updated_at"),
    ))
}

/// Newest first by the same updated time the row reports (the fifth
/// selected column), rows without one last.
const ORDER: &str = "order by 5 desc";

/// A thread id matched through the primary key's index. `collate nocase`
/// cannot use that index, so every lookup read the whole table — titles
/// and all, hundreds of megabytes on a computer with thousands of `codex
/// exec` threads, many times per delivery. Codex writes ids in lowercase;
/// the uppercase spelling and the caller's own keep a differently cased
/// caller matching. Other conditions beside it are written `+column`: the
/// unary plus keeps SQLite from answering through that column's index
/// (`archived` would walk every unarchived thread) instead of the key's.
const ID_MATCHES: &str = "id in (?1, lower(?1), upper(?1))";

/// [`read_one`]'s statement.
fn read_one_sql(columns: &HashSet<String>) -> Option<String> {
    Some(format!(
        "select {} from threads where {ID_MATCHES} and +archived = 0 and +source in ('cli', 'vscode', 'exec') limit 1",
        select_list(columns)?
    ))
}

/// Whether the thread `?1` exists with its archived flag set (`archived`)
/// or not.
fn exists_sql(archived: bool) -> String {
    let flag = if archived {
        "+archived != 0"
    } else {
        "+archived = 0"
    };
    format!("select exists(select 1 from threads where {ID_MATCHES} and {flag})")
}

/// [`rollout_column`]'s statement.
fn rollout_sql() -> String {
    format!("select rollout_path from threads where {ID_MATCHES} limit 1")
}

/// [`read_recent`]'s statement: the newest `?1` of the person's threads.
fn recent_sql(columns: &HashSet<String>) -> Option<String> {
    Some(format!(
        "select {} from threads where rowid in ({}) {}",
        select_list(columns)?,
        newest_rowids(columns, "archived = 0 and source in ('cli', 'vscode')"),
        ORDER
    ))
}

/// The rowids of the newest `?1` threads matching `filter`, ordered by the
/// same updated time the row reports. Only the rowid and that time are
/// sorted to choose the page, so the sort over every thread never carries
/// a thread's title — which is its first prompt and can run to a megabyte.
/// The outer select reads, and orders, the full rows of that page alone (at
/// most `?1` of them).
fn newest_rowids(columns: &HashSet<String>, filter: &str) -> String {
    let has = |column: &str| columns.contains(column);
    let updated = match (has("updated_at_ms"), has("updated_at")) {
        (true, true) => "coalesce(updated_at_ms, updated_at * 1000)",
        (true, false) => "updated_at_ms",
        (false, true) => "updated_at * 1000",
        (false, false) => "null",
    };
    format!("select rowid from threads where {filter} order by {updated} desc limit ?1")
}

type Row = (
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
);

fn row(row: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok((
        row.get::<_, String>(0)?,
        row.get::<_, Option<String>>(1).unwrap_or(None),
        row.get::<_, Option<String>>(2).unwrap_or(None),
        row.get::<_, Option<i64>>(3).unwrap_or(None),
        row.get::<_, Option<i64>>(4).unwrap_or(None),
    ))
}

fn thread((id, title, cwd, created, updated): Row) -> CodexThread {
    CodexThread {
        id,
        title: display_title(title.as_deref().unwrap_or_default()),
        directory: cwd.filter(|cwd| !cwd.is_empty()),
        created_at_ms: created.filter(|ms| *ms > 0),
        updated_at_ms: updated.filter(|ms| *ms > 0),
    }
}

/// The person's most recently updated Codex threads (desktop app and
/// terminal), newest first, or `None` when the database cannot be read —
/// which is not the same as having no threads. Archived and sub-agent
/// threads are left out, and so are the threads relay-spawned workers run.
pub fn read_recent(config: &CodexConfig, limit: usize) -> Option<Vec<CodexThread>> {
    with_connection(config, Duration::from_secs(8), |connection| {
        let columns = columns(connection)?;
        let sql = recent_sql(&columns)?;
        let mut statement = connection.prepare_cached(&sql).ok()?;
        // Read past relay-spawned rows so skipping them cannot crowd out the
        // requested number of the person's own threads.
        let scan = i64::try_from(limit.max(1).saturating_mul(4)).unwrap_or(i64::MAX);
        let mut rows = statement.query([scan]).ok()?;
        let mut threads = Vec::new();
        while threads.len() < limit {
            let Some(found) = rows.next().ok()? else {
                break;
            };
            let Ok(found) = row(found) else {
                continue;
            };
            if !crate::relay::store::is_uuid(&found.0)
                || is_relay_spawned_title(found.1.as_deref().unwrap_or_default())
            {
                continue;
            }
            threads.push(thread(found));
        }
        Some(threads)
    })
}

/// The ids of Codex's unarchived threads of any source created at or after
/// `since_ms`, among the newest `scan` by update, or `None` when the
/// database cannot be read: where a thread Agent Relay started is looked
/// for when only its first message is known.
pub fn created_since(config: &CodexConfig, since_ms: i64, scan: usize) -> Option<Vec<String>> {
    with_connection(config, Duration::from_secs(8), |connection| {
        let columns = columns(connection)?;
        let sql = format!(
            "select {} from threads where rowid in ({}) {}",
            select_list(&columns)?,
            newest_rowids(&columns, "archived = 0"),
            ORDER
        );
        let mut statement = connection.prepare_cached(&sql).ok()?;
        let scan = i64::try_from(scan).unwrap_or(i64::MAX);
        let ids = statement
            .query_map([scan], row)
            .ok()?
            .flatten()
            .map(thread)
            // A thread with no recorded creation time is kept: it may be it.
            .filter(|found| found.created_at_ms.is_none_or(|ms| ms >= since_ms))
            .map(|found| found.id)
            .filter(|id| crate::relay::store::is_uuid(id))
            .collect();
        Some(ids)
    })
}

/// One thread by id, for a session that identified itself, outside the
/// bounded recent list: missing, archived and sub-agent threads are not
/// found. `codex exec` threads count here.
pub fn read_one(config: &CodexConfig, id: &str) -> Option<CodexThread> {
    if !crate::relay::store::is_uuid(id) {
        return None;
    }
    with_connection(config, Duration::from_secs(2), |connection| {
        let columns = columns(connection)?;
        let sql = read_one_sql(&columns)?;
        let found = connection.query_row(&sql, [id], row).ok()?;
        Some(thread(found))
    })
}

/// Whether this exact thread has a live catalog row, regardless of Codex's
/// source label. Used before resuming a registered native spawn; it must
/// not broaden the
/// person's injectable-session catalog exposed by [`read_one`].
pub fn contains_unarchived(config: &CodexConfig, id: &str) -> Option<bool> {
    if !crate::relay::store::is_uuid(id) {
        return Some(false);
    }
    with_connection(config, Duration::from_secs(2), |connection| {
        let columns = columns(connection)?;
        if !["id", "archived"]
            .iter()
            .all(|column| columns.contains(*column))
        {
            return None;
        }
        connection
            .query_row(&exists_sql(false), [id], |row| row.get(0))
            .ok()
    })
}

/// Those of `ids` whose catalog row says the thread is archived, read over
/// one connection. A missing row is not archived, and an unreadable
/// catalog archives nothing, so neither ever retires an agent.
pub fn archived_ids<'a>(
    config: &CodexConfig,
    ids: impl IntoIterator<Item = &'a str>,
) -> HashSet<String> {
    let ids: Vec<&str> = ids
        .into_iter()
        .filter(|id| crate::relay::store::is_uuid(id))
        .collect();
    if ids.is_empty() {
        return HashSet::new();
    }
    with_connection(config, Duration::from_secs(2), |connection| {
        let columns = columns(connection)?;
        if !["id", "archived"]
            .iter()
            .all(|column| columns.contains(*column))
        {
            return None;
        }
        let mut statement = connection.prepare_cached(&exists_sql(true)).ok()?;
        Some(
            ids.into_iter()
                .filter(|id| statement.query_row([id], |row| row.get(0)).unwrap_or(false))
                .map(str::to_string)
                .collect(),
        )
    })
    .unwrap_or_default()
}

/// The thread's recorded rollout path.
pub fn rollout_column(config: &CodexConfig, id: &str) -> Option<String> {
    with_connection(config, Duration::from_secs(2), |connection| {
        connection
            .query_row(&rollout_sql(), [id], |row| row.get::<_, Option<String>>(0))
            .ok()
            .flatten()
            .filter(|path| !path.is_empty())
    })
}

/// Threads a relay-spawned worker runs open with the injected relay
/// reminder; they belong to their spawn, not the person's session list.
pub fn is_relay_spawned_title(title: &str) -> bool {
    title.trim().starts_with("<system-reminder>")
}

const TITLE_CHARACTERS: usize = 70;

/// The first line of a title that reads as text: harness-started threads
/// open with injected markup or flags, and Conductor's with its
/// `<system_instruction>` block of prose.
pub fn display_title(raw: &str) -> String {
    crate::relay::conductor::without_preamble(raw)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('<') && !line.starts_with('-'))
        .map(|line| {
            if line.chars().count() > TITLE_CHARACTERS {
                format!(
                    "{}…",
                    line.chars().take(TITLE_CHARACTERS).collect::<String>()
                )
            } else {
                line.to_string()
            }
        })
        .unwrap_or_else(|| "Untitled thread".to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::Path;

    pub const THREAD: &str = "01a0e91e-da81-7632-8367-789d27af58bd";

    pub fn config(home: &Path) -> CodexConfig {
        CodexConfig {
            home: home.to_path_buf(),
            sqlite_home: home.to_path_buf(),
            executable: None,
            ipc_socket: home.join("ipc/ipc.sock"),
        }
    }

    pub fn seed(home: &Path, journal: &str) -> Connection {
        let db = Connection::open(home.join("state_5.sqlite")).unwrap();
        db.pragma_update(None, "journal_mode", journal).unwrap();
        db.execute_batch(
            "create table threads (id text, name text, title text, cwd text, updated_at integer, archived integer, source text, rollout_path text)",
        )
        .unwrap();
        db.execute(
            "insert into threads values (?1, '', 'Pull main', '/code/cloud', 1790659486, 0, 'vscode', null)",
            [THREAD],
        )
        .unwrap();
        db
    }

    fn ids(threads: &[CodexThread]) -> Vec<&str> {
        threads.iter().map(|t| t.id.as_str()).collect()
    }

    // CodexDiscoveryTests.testReadsThreads.
    #[test]
    fn reads_threads() {
        let home = tempfile::tempdir().unwrap();
        let _db = seed(home.path(), "wal");
        let threads = read_recent(&config(home.path()), 40).unwrap();
        assert_eq!(ids(&threads), [THREAD]);
        assert_eq!(threads[0].title, "Pull main");
        assert_eq!(threads[0].project().as_deref(), Some("cloud"));
        assert_eq!(threads[0].updated_at_ms, Some(1_790_659_486_000));
    }

    // CodexDiscoveryTests.testMissingDatabaseIsUnreadableNotEmpty.
    #[test]
    fn a_missing_database_is_unreadable_not_empty() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(read_recent(&config(home.path()), 40), None);
    }

    // CodexDiscoveryTests.testUnexpectedSchemaIsUnreadableNotEmpty.
    #[test]
    fn an_unexpected_schema_is_unreadable_not_empty() {
        let home = tempfile::tempdir().unwrap();
        let db = Connection::open(home.path().join("state_5.sqlite")).unwrap();
        db.execute_batch("create table other (id text)").unwrap();
        assert_eq!(read_recent(&config(home.path()), 40), None);
    }

    /// A discovery read waiting out Codex's write lock on one database
    /// delays no read of another.
    #[test]
    fn a_read_waiting_on_a_write_lock_delays_no_other_read() {
        let held = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let db = seed(held.path(), "delete");
        let _other = seed(other.path(), "delete");
        // Both connections are kept before the lock is taken.
        assert!(read_recent(&config(held.path()), 40).is_some());
        assert!(read_one(&config(other.path()), THREAD).is_some());
        db.execute_batch("begin exclusive").unwrap();
        let blocked = config(held.path());
        let waiting = std::thread::spawn(move || read_recent(&blocked, 40));
        std::thread::sleep(Duration::from_millis(200));
        let started = std::time::Instant::now();
        assert!(read_one(&config(other.path()), THREAD).is_some());
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        db.execute_batch("commit").unwrap();
        assert!(waiting.join().unwrap().is_some());
    }

    /// Without a file identity (Windows) nothing is kept between reads.
    #[cfg(not(unix))]
    #[test]
    fn a_database_without_a_file_identity_is_not_kept() {
        let home = tempfile::tempdir().unwrap();
        let _db = seed(home.path(), "delete");
        assert!(read_recent(&config(home.path()), 40).is_some());
        assert!(!kept().contains_key(&database(&config(home.path()))));
    }

    #[cfg(unix)]
    #[test]
    fn idle_and_deleted_databases_are_closed() {
        let gone = tempfile::tempdir().unwrap();
        let idle = tempfile::tempdir().unwrap();
        let _gone = seed(gone.path(), "delete");
        let _idle = seed(idle.path(), "delete");
        assert!(read_recent(&config(gone.path()), 40).is_some());
        assert!(read_recent(&config(idle.path()), 40).is_some());
        let kept_for = |home: &Path| kept().contains_key(&database(&config(home)));
        assert!(kept_for(gone.path()) && kept_for(idle.path()));
        std::fs::remove_file(database(&config(gone.path()))).unwrap();
        assert!(!kept_for(gone.path()), "a deleted database is closed");
        assert!(kept_for(idle.path()));
        sweep(&mut kept(), Duration::ZERO);
        assert!(!kept_for(idle.path()), "an idle connection is closed");
    }

    // CodexDiscoveryTests.testWaitsOutAWriteLock.
    #[test]
    fn waits_out_a_write_lock() {
        let home = tempfile::tempdir().unwrap();
        let db = seed(home.path(), "delete");
        db.execute_batch("begin exclusive").unwrap();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            db.execute_batch("commit").unwrap();
        });
        let threads = read_recent(&config(home.path()), 40).unwrap();
        assert_eq!(ids(&threads), [THREAD]);
        writer.join().unwrap();
    }

    // CodexDiscoveryTests.testSocketLooksUpOnlyThePeerThreadOutsideTheAgentsListWindow
    // and AgentPeopleTests (isRelaySpawnedCodexTitle).
    #[test]
    fn the_recent_list_is_bounded_but_one_thread_is_found_by_id() {
        let home = tempfile::tempdir().unwrap();
        let db = seed(home.path(), "wal");
        for index in 1..=45 {
            db.execute(
                "insert into threads values (?1, '', ?2, '/code', ?3, 0, 'cli', null)",
                (
                    format!("00000000-0000-0000-0000-{index:012}"),
                    format!("Thread {index}"),
                    1_790_659_486 + index,
                ),
            )
            .unwrap();
        }
        let insert = |id: &str, title: &str, archived: i64, source: &str| {
            db.execute(
                "insert into threads values (?1, '', ?2, '/code', 1890659486, ?3, ?4, null)",
                (id, title, archived, source),
            )
            .unwrap();
        };
        insert(
            "10000000-0000-0000-0000-000000000001",
            "<system-reminder>\nAgent Relay",
            0,
            "cli",
        );
        insert("10000000-0000-0000-0000-000000000002", "Archived", 1, "cli");
        insert(
            "10000000-0000-0000-0000-000000000003",
            "Sub-agent",
            0,
            "subagent",
        );
        insert("10000000-0000-0000-0000-000000000004", "Exec", 0, "exec");
        insert("not-a-uuid", "Named", 0, "cli");
        let config = config(home.path());
        let listed = read_recent(&config, 40).unwrap();
        assert_eq!(listed.len(), 40);
        assert_eq!(listed[0].id, "00000000-0000-0000-0000-000000000045");
        assert!(!listed
            .iter()
            .any(|t| t.id == THREAD || t.id.starts_with("10000000")));
        assert_eq!(
            read_one(&config, THREAD).map(|t| t.id).as_deref(),
            Some(THREAD)
        );
        assert!(read_one(&config, "10000000-0000-0000-0000-000000000004").is_some());
        assert_eq!(
            contains_unarchived(&config, "10000000-0000-0000-0000-000000000003"),
            Some(true),
            "an exact unarchived row is recognized with any source"
        );
        assert_eq!(
            contains_unarchived(&config, "10000000-0000-0000-0000-000000000002"),
            Some(false),
            "archived rows are never live"
        );
        assert_eq!(
            archived_ids(
                &config,
                [
                    "10000000-0000-0000-0000-000000000002",
                    THREAD,
                    "10000000-0000-0000-0000-000000000003",
                    "00000000-0000-0000-0000-999999999999",
                    "not-a-uuid",
                ]
            ),
            HashSet::from(["10000000-0000-0000-0000-000000000002".to_string()]),
            "only an existing archived row is archived"
        );
        for missing in [
            "00000000-0000-0000-0000-999999999999",
            "10000000-0000-0000-0000-000000000002",
            "10000000-0000-0000-0000-000000000003",
            "not-a-uuid",
        ] {
            assert_eq!(read_one(&config, missing), None, "{missing}");
        }
    }

    // test_discovers_same_user_codex_resumes_in_tmux_or_ssh_process_trees
    // (an older schema without timestamps or names).
    #[test]
    fn an_older_schema_still_reads() {
        let home = tempfile::tempdir().unwrap();
        let db = Connection::open(home.path().join("state_5.sqlite")).unwrap();
        db.execute_batch(
            "create table threads(id text, title text, cwd text, archived integer, source text)",
        )
        .unwrap();
        db.execute(
            "insert into threads values(?1, 'Fix setup', '/p/relay', 0, 'cli')",
            [THREAD],
        )
        .unwrap();
        let threads = read_recent(&config(home.path()), 40).unwrap();
        assert_eq!(threads[0].title, "Fix setup");
        assert_eq!(threads[0].updated_at_ms, None);
    }

    // InjectableAgents.displayTitle.
    #[test]
    fn titles_read_as_text() {
        assert_eq!(
            display_title("<context>\n- flag\n  Fix the build  \nmore"),
            "Fix the build"
        );
        assert_eq!(display_title(" \n<x>"), "Untitled thread");
        assert_eq!(
            display_title(
                "<system_instruction>\nYou are working inside Conductor.\n</system_instruction>\n\nCheck in"
            ),
            "Check in"
        );
        assert_eq!(
            display_title("<system_instruction>\nYou are working inside Conductor."),
            "You are working inside Conductor."
        );
        let long = display_title(&"é".repeat(80));
        assert_eq!(long.chars().count(), 71);
        assert!(long.ends_with('…'));
        assert!(is_relay_spawned_title("  <system-reminder>\nAgent Relay"));
        assert!(!is_relay_spawned_title("Fix the settings screen"));
    }

    // Review: ordering uses the reported time, so a row with only
    // `updated_at_ms` is not sorted as having none.
    #[test]
    fn rows_sort_by_the_time_they_report() {
        let home = tempfile::tempdir().unwrap();
        let db = Connection::open(home.path().join("state_5.sqlite")).unwrap();
        db.execute_batch(
            "create table threads (id text, title text, updated_at integer, updated_at_ms integer, archived integer, source text)",
        )
        .unwrap();
        let newest = "00000000-0000-0000-0000-000000000002";
        db.execute(
            "insert into threads values (?1, 'Old', 1790000000, null, 0, 'cli')",
            [THREAD],
        )
        .unwrap();
        db.execute(
            "insert into threads values (?1, 'New', null, 1890000000000, 0, 'cli')",
            [newest],
        )
        .unwrap();
        let threads = read_recent(&config(home.path()), 1).unwrap();
        assert_eq!(ids(&threads), [newest]);
        assert_eq!(threads[0].updated_at_ms, Some(1_890_000_000_000));
    }

    /// Codex's own schema: `id` is the primary key and titles are first
    /// prompts. Lookups by id go through that key's index and the recent
    /// page is chosen without sorting titles, so neither reads the whole
    /// table on a computer with thousands of large `codex exec` threads.
    fn seed_codex_schema(home: &Path) -> Connection {
        let db = Connection::open(home.join("state_5.sqlite")).unwrap();
        db.execute_batch(
            "create table threads (id text primary key not null, rollout_path text, created_at integer, updated_at integer, source text, cwd text, title text, archived integer, created_at_ms integer, updated_at_ms integer, name text);
             create index idx_threads_archived on threads(archived);
             create index idx_threads_source on threads(source);",
        )
        .unwrap();
        db
    }

    fn plan(db: &Connection, sql: &str) -> String {
        let mut statement = db.prepare(&format!("explain query plan {sql}")).unwrap();
        let parameters: Vec<&str> = vec!["x"; statement.parameter_count()];
        let details = statement
            .query_map(rusqlite::params_from_iter(parameters), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .flatten()
            .collect::<Vec<_>>();
        details.join("\n")
    }

    #[test]
    fn id_lookups_use_the_primary_key_index() {
        let home = tempfile::tempdir().unwrap();
        let db = seed_codex_schema(home.path());
        let columns = columns(&db).unwrap();
        for sql in [
            rollout_sql(),
            exists_sql(false),
            exists_sql(true),
            read_one_sql(&columns).unwrap(),
        ] {
            let plan = plan(&db, &sql);
            assert!(plan.contains("sqlite_autoindex_threads_1"), "{sql}: {plan}");
            assert!(!plan.contains("SCAN threads"), "{sql}: {plan}");
        }
    }

    #[test]
    fn the_recent_page_is_chosen_without_sorting_titles() {
        let home = tempfile::tempdir().unwrap();
        let db = seed_codex_schema(home.path());
        let columns = columns(&db).unwrap();
        let plan = plan(&db, &recent_sql(&columns).unwrap());
        // The outer read fetches the chosen rows by rowid; only the inner
        // page selection sorts, and it selects rowids alone.
        assert!(
            plan.contains("SEARCH threads USING INTEGER PRIMARY KEY"),
            "{plan}"
        );
    }

    #[test]
    fn a_thread_is_found_by_id_in_any_case() {
        let home = tempfile::tempdir().unwrap();
        let db = seed_codex_schema(home.path());
        let upper = "10000000-0000-0000-0000-00000000ABCD";
        db.execute(
            "insert into threads (id, rollout_path, source, title, archived, updated_at) values (?1, '/r/lower.jsonl', 'cli', 'Lower', 0, 1790000000), (?2, '/r/upper.jsonl', 'cli', 'Upper', 1, 1790000001)",
            [THREAD, upper],
        )
        .unwrap();
        let config = config(home.path());
        for id in [THREAD.to_string(), THREAD.to_uppercase()] {
            assert_eq!(
                rollout_column(&config, &id).as_deref(),
                Some("/r/lower.jsonl"),
                "{id}"
            );
            assert_eq!(
                read_one(&config, &id).map(|t| t.title).as_deref(),
                Some("Lower"),
                "{id}"
            );
            assert_eq!(contains_unarchived(&config, &id), Some(true), "{id}");
        }
        for id in [upper.to_string(), upper.to_lowercase()] {
            assert_eq!(
                rollout_column(&config, &id).as_deref(),
                Some("/r/upper.jsonl"),
                "{id}"
            );
            assert_eq!(contains_unarchived(&config, &id), Some(false), "{id}");
            assert_eq!(
                archived_ids(&config, [id.as_str()]),
                HashSet::from([id.clone()])
            );
        }
    }
}
