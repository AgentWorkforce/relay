//! Codex's own per-thread queue: `codex queue` hands it a message, and
//! `queue_1.sqlite` under Codex home holds it until a terminal Codex that
//! has the thread open runs it as a user turn.
//!
//! ```text
//! codex queue --thread <thread id> --message=<text>
//! ```
//!
//! Only a live terminal TUI drains the queue, so an item there is a handoff,
//! never a delivery: delivery is observed in the thread's rollout. The
//! relay's items carry the attribution line with the message reference;
//! that pair is what scopes every read and deletion to the relay's own.

use super::CodexConfig;
use crate::relay::delivery::policy::MessageRef;
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Arguments for queueing `text` on `thread`. The text is attached with `=`
/// so a message starting with a dash is never read as a flag.
pub fn arguments(thread: &str, text: &str) -> Vec<String> {
    vec![
        "queue".into(),
        "--thread".into(),
        thread.into(),
        format!("--message={text}"),
    ]
}

/// Whether `value` is a thread id. `codex queue` also accepts a session
/// name; an id from the network must never be matched that way, or a
/// crafted value could land in whichever thread bears it.
pub fn is_thread_id(value: &str) -> bool {
    crate::relay::store::is_uuid(value)
}

/// What one run of `codex queue` amounted to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Codex stored the message; `item` is its id in Codex's queue.
    Queued { item: Option<String> },
    /// Codex ran and refused. Nothing was queued.
    Failed(String),
}

/// Only exit code zero and Codex's own confirmation count as queued.
pub fn outcome(exit_code: i32, stdout: &str, stderr: &str) -> Outcome {
    const CONFIRMATION: &str = "Queued message ";
    if exit_code == 0 {
        if let Some(at) = stdout.find(CONFIRMATION) {
            let item: String = stdout[at + CONFIRMATION.len()..]
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect();
            return Outcome::Queued {
                item: (!item.is_empty()).then_some(item),
            };
        }
    }
    let source = if stderr.is_empty() { stdout } else { stderr };
    let line = source
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if line.is_empty() {
        Outcome::Failed(format!("codex exited with code {exit_code}"))
    } else {
        Outcome::Failed(line.chars().take(300).collect())
    }
}

fn queue_path(config: &CodexConfig) -> PathBuf {
    config.sqlite_home.join("queue_1.sqlite")
}

fn is_message_ref(value: &str) -> bool {
    value.len() == 12
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether a relay message carrying `message_ref` is still in Codex's queue
/// for `thread`: handed over, not yet picked up. No queue database means
/// nothing is queued; `None` when it exists but cannot be read, so callers
/// fail closed.
pub fn is_waiting(config: &CodexConfig, thread: &str, message_ref: &str) -> Option<bool> {
    is_waiting_at(&queue_path(config), thread, message_ref)
}

fn is_waiting_at(path: &Path, thread: &str, message_ref: &str) -> Option<bool> {
    let Some(connection) = read_only(path)? else {
        return Some(false);
    };
    let items = owned_items(
        &connection,
        "select id, payload_json from queued_items where thread_id = ?1 collate nocase and instr(payload_json, ?2) > 0",
        (thread, format!("ref {message_ref}]")),
    )?;
    Some(items.iter().any(|(_, owned)| owned == message_ref))
}

/// Whether any relay message is still in Codex's queue for `thread`, from
/// this probe or another one sharing the queue; `None` when the queue
/// cannot be read.
pub fn relay_waiting(config: &CodexConfig, thread: &str) -> Option<bool> {
    relay_waiting_at(&queue_path(config), thread)
}

fn relay_waiting_at(path: &Path, thread: &str) -> Option<bool> {
    let Some(connection) = read_only(path)? else {
        return Some(false);
    };
    let items = owned_items(
        &connection,
        "select id, payload_json from queued_items where thread_id = ?1 collate nocase",
        [thread],
    )?;
    Some(!items.is_empty())
}

/// The queue opened for reading: `Some(None)` when there is no queue
/// database (nothing is queued), `None` when it cannot be read.
fn read_only(path: &Path) -> Option<Option<Connection>> {
    match std::fs::metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(None),
        Err(_) => return None,
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    connection.busy_timeout(Duration::from_secs(2)).ok()?;
    Some(Some(connection))
}

/// The reference of a relay-created queue item: one whose text opens with
/// the relay's attribution line. A prompt of the person's that merely
/// quotes such a line elsewhere is not the relay's.
pub fn owned_ref(payload_json: &str) -> Option<String> {
    fn find(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::String(text) => MessageRef::in_text(text),
            serde_json::Value::Array(values) => values.iter().find_map(find),
            serde_json::Value::Object(fields) => fields.values().find_map(find),
            _ => None,
        }
    }
    match serde_json::from_str::<serde_json::Value>(payload_json) {
        Ok(value) => find(&value),
        Err(_) => MessageRef::in_text(payload_json),
    }
}

/// The `(id, reference)` of each relay-created item `sql` selects as
/// `(id, payload_json)`; `None` when the queue cannot be read.
fn owned_items(
    connection: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Option<Vec<(String, String)>> {
    let mut statement = connection.prepare(sql).ok()?;
    let rows = statement
        .query_map(params, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    Some(
        rows.into_iter()
            .filter_map(|(id, payload)| owned_ref(&payload).map(|owned| (id, owned)))
            .collect(),
    )
}

/// Deletes the relay-created items `sql` selects whose reference `keep`
/// accepts.
fn remove(path: &Path, sql: &str, params: impl rusqlite::Params, keep: impl Fn(&str) -> bool) {
    let Ok(connection) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return;
    };
    if connection.busy_timeout(Duration::from_secs(2)).is_err() {
        return;
    }
    // A failed cleanup leaves an item a later pass removes; the rollout,
    // not the queue, decides delivery.
    let Some(items) = owned_items(&connection, sql, params) else {
        return;
    };
    for (id, owned) in items {
        if keep(&owned) {
            let _ = connection.execute("delete from queued_items where id = ?1", [id]);
        }
    }
}

/// Removes the relay's queue copy of a message Codex recorded through
/// another host, scoped to the exact thread and reference.
pub fn remove_owned(config: &CodexConfig, thread: &str, message_ref: &str) {
    if !is_thread_id(thread) || !is_message_ref(message_ref) {
        return;
    }
    remove(
        &queue_path(config),
        "select id, payload_json from queued_items where thread_id = ?1 collate nocase and instr(payload_json, ?2) > 0",
        (thread, format!("ref {message_ref}]")),
        |owned| owned == message_ref,
    );
}

/// How long a relay queue item can still be a useful handoff: Relaycast's
/// delivery lifetime.
pub const OWNED_LIFETIME_MS: i64 = 24 * 60 * 60 * 1_000;

/// Removes relay-created items older than `OWNED_LIFETIME_MS` at `now_ms`;
/// the person's own queue items are never touched.
pub fn cleanup_expired_owned(config: &CodexConfig, now_ms: i64) {
    cleanup_expired_at(&queue_path(config), now_ms);
}

fn cleanup_expired_at(path: &Path, now_ms: i64) {
    remove(
        path,
        "select id, payload_json from queued_items where created_at_ms < ?1 and (instr(payload_json, '[via Agent Relay ') > 0 or instr(payload_json, '[Relay Connect ') > 0)",
        [now_ms - OWNED_LIFETIME_MS],
        |_| true,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::codex::threads::tests::config;

    const THREAD: &str = "01a0bcd4-0b35-7d42-8d7d-6375f7732587";
    const REF: &str = "abcdef123456";

    // CodexQueueCommandTests.testTheTextIsAttachedSoALeadingDashIsNeverAFlag
    // and test_codex_queue_validates_thread_and_uses_message_as_one_argument.
    #[test]
    fn the_text_is_attached_so_a_leading_dash_is_never_a_flag() {
        assert_eq!(
            arguments(THREAD, "--dangerously-bypass-approvals-and-sandbox"),
            [
                "queue",
                "--thread",
                THREAD,
                "--message=--dangerously-bypass-approvals-and-sandbox"
            ]
        );
    }

    // CodexQueueCommandTests.testOnlyUUIDsAreThreadIDs.
    #[test]
    fn only_uuids_are_thread_ids() {
        assert!(is_thread_id(THREAD));
        for value in [
            "",
            "my session name",
            "--remote",
            &format!("{THREAD} "),
            "01a0bcd4",
        ] {
            assert!(!is_thread_id(value), "accepted {value:?}");
        }
    }

    // CodexQueueCommandTests.testReadsCodexsConfirmation.
    #[test]
    fn reads_codexs_confirmation() {
        let output =
            format!("Queued message 01a0bd9b-5bf2-7d03-880c-8e608ff88827 for thread {THREAD}.\n");
        assert_eq!(
            outcome(0, &output, ""),
            Outcome::Queued {
                item: Some("01a0bd9b-5bf2-7d03-880c-8e608ff88827".into())
            }
        );
    }

    // CodexQueueCommandTests.testAnythingElseIsAFailure.
    #[test]
    fn anything_else_is_a_failure() {
        assert_eq!(
            outcome(0, "", ""),
            Outcome::Failed("codex exited with code 0".into())
        );
        assert_eq!(
            outcome(1, "Queued message x", "\nerror: no session found\nmore"),
            Outcome::Failed("error: no session found".into())
        );
        // test_injectable: a successful exit without the confirmation is not queued.
        assert_eq!(outcome(0, "queued", ""), Outcome::Failed("queued".into()));
        assert_eq!(
            outcome(2, "", &"x".repeat(400)),
            Outcome::Failed("x".repeat(300))
        );
    }

    fn queue(home: &Path) -> Connection {
        let db = Connection::open(home.join("queue_1.sqlite")).unwrap();
        db.execute_batch(
            "create table queued_items (id text, thread_id text, payload_json text, created_at_ms integer)",
        )
        .unwrap();
        db
    }

    fn insert(db: &Connection, id: &str, thread: &str, payload: &str, created: i64) {
        db.execute(
            "insert into queued_items values (?1, ?2, ?3, ?4)",
            (id, thread, payload, created),
        )
        .unwrap();
    }

    fn ids(db: &Connection) -> Vec<String> {
        let mut statement = db
            .prepare("select id from queued_items order by id")
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    // CodexQueueCleanupTests.testExpiredCleanupOnlyDeletesRelayAttributedItems
    // and test_expired_cleanup_preserves_user_queue_items.
    #[test]
    fn expired_cleanup_only_deletes_relay_attributed_items() {
        let home = tempfile::tempdir().unwrap();
        let db = queue(home.path());
        let relay = "[via Agent Relay — from @alice · ref abcdef123456]";
        let connect = "[Relay Connect — from @alice · ref 111111222222]";
        insert(&db, "old-relay", THREAD, relay, 1);
        insert(&db, "old-connect", THREAD, connect, 1);
        insert(&db, "old-user", THREAD, "my own queued prompt", 1);
        insert(&db, "fresh-relay", THREAD, relay, 2_000_000_000_000);
        cleanup_expired_owned(&config(home.path()), 2_000_000_000_000);
        assert_eq!(ids(&db), ["fresh-relay", "old-user"]);
    }

    // CodexQueueBridge.isWaiting / removeOwned and _codex_queue_waiting /
    // _remove_owned_codex_queue_item.
    #[test]
    fn waiting_and_removal_are_scoped_to_the_thread_and_ref() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        // No queue database: nothing is queued.
        assert_eq!(is_waiting(&config, THREAD, REF), Some(false));
        let db = queue(home.path());
        let other = "11111111-2222-3333-4444-555555555555";
        insert(
            &db,
            "a",
            THREAD,
            &format!("[via Agent Relay — ref {REF}]\n\nhi"),
            1,
        );
        insert(
            &db,
            "b",
            other,
            &format!("[via Agent Relay — ref {REF}]\n\nhi"),
            1,
        );
        insert(&db, "c", THREAD, &format!("my note about ref {REF}]"), 1);
        assert_eq!(is_waiting(&config, THREAD, REF), Some(true));
        assert_eq!(is_waiting(&config, THREAD, "000000000000"), Some(false));
        remove_owned(&config, THREAD, "ABCDEF123456");
        remove_owned(&config, "not-a-thread", REF);
        assert_eq!(ids(&db), ["a", "b", "c"]);
        remove_owned(&config, THREAD, REF);
        assert_eq!(ids(&db), ["b", "c"]);
        assert_eq!(is_waiting(&config, THREAD, REF), Some(false));
        // A queue that exists but cannot be read is unknown, not empty.
        drop(db);
        std::fs::write(
            home.path().join("queue_1.sqlite"),
            b"not a database at all, not at all",
        )
        .unwrap();
        assert_eq!(is_waiting(&config, THREAD, REF), None);
    }

    #[test]
    fn queue_observation_uses_the_isolated_sqlite_home() {
        let home = tempfile::tempdir().unwrap();
        let sqlite_home = tempfile::tempdir().unwrap();
        let mut config = config(home.path());
        config.sqlite_home = sqlite_home.path().to_path_buf();
        let db = queue(sqlite_home.path());
        insert(
            &db,
            "fleet-item",
            THREAD,
            &format!("[Relay Connect — from host · ref {REF}]\n\nhello"),
            1,
        );

        assert_eq!(is_waiting(&config, THREAD, REF), Some(true));
        assert!(!home.path().join("queue_1.sqlite").exists());
        remove_owned(&config, THREAD, REF);
        assert!(ids(&db).is_empty());
    }

    // Review: a prompt of the person's that quotes a relay header is never
    // the relay's, for waiting, removal or cleanup.
    #[test]
    fn only_an_item_opening_with_the_attribution_is_the_relays() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let db = queue(home.path());
        let header = format!("[via Agent Relay — from @alice · ref {REF}]");
        let quoted = format!("Why did I get this?\n{header}\n\nhi");
        insert(
            &db,
            "quoted",
            THREAD,
            &serde_json::json!({"text": quoted}).to_string(),
            1,
        );
        let owned =
            serde_json::json!({"input": [{"type": "text", "text": format!("{header}\n\nhi")}]});
        insert(&db, "relay", THREAD, &owned.to_string(), 1);
        assert_eq!(owned_ref(&owned.to_string()).as_deref(), Some(REF));
        assert_eq!(
            owned_ref(&serde_json::json!({"text": quoted}).to_string()),
            None
        );
        assert_eq!(is_waiting(&config, THREAD, REF), Some(true));
        cleanup_expired_owned(&config, 2_000_000_000_000);
        assert_eq!(ids(&db), ["quoted"]);
        assert_eq!(is_waiting(&config, THREAD, REF), Some(false));
        remove_owned(&config, THREAD, REF);
        assert_eq!(ids(&db), ["quoted"]);
    }

    #[test]
    fn connect_queue_items_are_recognized_and_cancellable() {
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        let db = queue(home.path());
        let connect = format!("[Relay Connect — from host · ref {REF}]\n\nhello");
        insert(
            &db,
            "connect",
            THREAD,
            &serde_json::json!({"text": connect}).to_string(),
            1,
        );
        assert_eq!(is_waiting(&config, THREAD, REF), Some(true));
        remove_owned(&config, THREAD, REF);
        assert!(ids(&db).is_empty());
    }

    // Review: a queue whose metadata cannot be read is unknown, not absent.
    // Windows has no mode bits to lock a folder with.
    #[cfg(unix)]
    #[test]
    fn an_uninspectable_queue_is_unknown() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        drop(queue(home.path()));
        let locked = std::fs::Permissions::from_mode(0o000);
        std::fs::set_permissions(home.path(), locked).unwrap();
        let readable = std::fs::metadata(home.path().join("queue_1.sqlite")).is_ok();
        let waiting = is_waiting(&config, THREAD, REF);
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        if !readable {
            assert_eq!(waiting, None);
        }
    }
}
