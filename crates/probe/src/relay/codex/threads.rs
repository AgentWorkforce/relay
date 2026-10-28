//! Codex's own record of its threads, `state_5.sqlite` under Codex home.
//!
//! The database is Codex's, read-only to the relay, and its schema moves
//! with Codex releases: the columns the relay needs are required, the rest
//! are used when present.

use super::CodexConfig;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashSet;
use std::path::PathBuf;
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

fn open(config: &CodexConfig, busy: Duration) -> Option<Connection> {
    let connection = Connection::open_with_flags(
        database(config),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    // Codex writes this database while it runs; a write is waited out
    // rather than read as "no threads".
    connection.busy_timeout(busy).ok()?;
    Some(connection)
}

fn columns(connection: &Connection) -> Option<HashSet<String>> {
    let mut statement = connection.prepare("pragma table_info(threads)").ok()?;
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
    let connection = open(config, Duration::from_secs(8))?;
    let columns = columns(&connection)?;
    let sql = format!(
        "select {} from threads where archived = 0 and source in ('cli', 'vscode') {} limit ?1",
        select_list(&columns)?,
        ORDER
    );
    let mut statement = connection.prepare(&sql).ok()?;
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
}

/// The ids of Codex's unarchived threads of any source created at or after
/// `since_ms`, among the newest `scan` by update, or `None` when the
/// database cannot be read: where a thread Agent Relay started is looked
/// for when only its first message is known.
pub fn created_since(config: &CodexConfig, since_ms: i64, scan: usize) -> Option<Vec<String>> {
    let connection = open(config, Duration::from_secs(8))?;
    let columns = columns(&connection)?;
    let sql = format!(
        "select {} from threads where archived = 0 {} limit ?1",
        select_list(&columns)?,
        ORDER
    );
    let mut statement = connection.prepare(&sql).ok()?;
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
}

/// One thread by id, for a session that identified itself, outside the
/// bounded recent list: missing, archived and sub-agent threads are not
/// found. `codex exec` threads count here.
pub fn read_one(config: &CodexConfig, id: &str) -> Option<CodexThread> {
    if !crate::relay::store::is_uuid(id) {
        return None;
    }
    let connection = open(config, Duration::from_secs(2))?;
    let columns = columns(&connection)?;
    let sql = format!(
        "select {} from threads where id = ?1 collate nocase and archived = 0 and source in ('cli', 'vscode', 'exec') limit 1",
        select_list(&columns)?
    );
    let found = connection.query_row(&sql, [id], row).ok()?;
    Some(thread(found))
}

/// Whether this exact thread has a live catalog row, regardless of Codex's
/// source label. Used for isolated fleet bindings and before resuming a
/// registered native spawn; it must not broaden the
/// person's injectable-session catalog exposed by [`read_one`].
pub fn contains_unarchived(config: &CodexConfig, id: &str) -> Option<bool> {
    if !crate::relay::store::is_uuid(id) {
        return Some(false);
    }
    let connection = open(config, Duration::from_secs(2))?;
    let columns = columns(&connection)?;
    if !["id", "archived"]
        .iter()
        .all(|column| columns.contains(*column))
    {
        return None;
    }
    connection
        .query_row(
            "select exists(select 1 from threads where id = ?1 collate nocase and archived = 0)",
            [id],
            |row| row.get(0),
        )
        .ok()
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
    let Some(connection) = open(config, Duration::from_secs(2)) else {
        return HashSet::new();
    };
    let has_columns = columns(&connection).is_some_and(|columns| {
        ["id", "archived"]
            .iter()
            .all(|column| columns.contains(*column))
    });
    if !has_columns {
        return HashSet::new();
    }
    let Ok(mut statement) = connection.prepare(
        "select exists(select 1 from threads where id = ?1 collate nocase and archived != 0)",
    ) else {
        return HashSet::new();
    };
    ids.into_iter()
        .filter(|id| statement.query_row([id], |row| row.get(0)).unwrap_or(false))
        .map(str::to_string)
        .collect()
}

/// The thread's recorded rollout path.
pub fn rollout_column(config: &CodexConfig, id: &str) -> Option<String> {
    let connection = open(config, Duration::from_secs(2))?;
    connection
        .query_row(
            "select rollout_path from threads where id = ?1 collate nocase",
            [id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
        .filter(|path| !path.is_empty())
}

/// Threads a relay-spawned worker runs open with the injected relay
/// reminder; they belong in fleet views, not the person's session list.
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
            "fleet binding recognizes an exact unarchived row with any source"
        );
        assert_eq!(
            contains_unarchived(&config, "10000000-0000-0000-0000-000000000002"),
            Some(false),
            "archived rows are never live fleet evidence"
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
}
