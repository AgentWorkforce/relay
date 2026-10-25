//! A private local reading cache, isolated from every upload journal.
use agent_relay_probe::relay::contract::transcript::{
    LocalTranscriptCursor, LocalTranscriptEntry, LocalTranscriptPage,
};
use ai_hist::{HydrateOptions, SessionRef, Source};
use anyhow::{ensure, Context, Result};
use clap::Args;
use rusqlite::Connection;

#[derive(Args)]
pub struct ReadSession {
    #[arg(long)]
    source: String,
    #[arg(long)]
    session_id: String,
    #[arg(long, requires = "after_id", allow_hyphen_values = true)]
    after_ts: Option<i64>,
    #[arg(long, requires = "after_ts")]
    after_id: Option<i64>,
}

pub fn read(options: ReadSession) -> Result<()> {
    ensure!(
        !super::session_reset::baseline()?.contains(
            &agent_relay_probe::delivery::SessionIdentity {
                source: options.source.clone(),
                session_id: options.session_id.clone(),
            }
        ),
        super::user_error("This session was removed from Relay by Reset all sessions. Its original transcript is unchanged; open it in the source app to read it.")
    );
    let source = Source::parse(&options.source)
        .context("This harness does not support local transcripts.")?;
    ensure!(
        !options.session_id.is_empty() && options.session_id.len() <= 512,
        "Invalid session identity."
    );
    let directory = super::home()?.join(".agentworkforce/session-reader");
    super::private_directory(&directory)?;
    let db = directory.join("history.db");
    let store = super::history::open(&db)?;
    let cursor = options
        .after_ts
        .zip(options.after_id)
        .map(|(ts_ms, id)| LocalTranscriptCursor { ts_ms, id });
    let page = read_from(&store, &db, source, &options.session_id, cursor)?;
    super::bridge::emit(serde_json::to_value(page)?);
    Ok(())
}

/// One page from `cursor`. A read from the start refreshes the cache from
/// the session's transcript first; a read that reaches the end of what the
/// cache holds refreshes it and reads again, so a transcript still being
/// written (a spawned agent followed live) shows what was written since,
/// however many pages it spans. That refresh is best effort: the page
/// already read stands if it fails.
fn read_from(
    store: &ai_hist::SessionStore,
    db: &std::path::Path,
    source: Source,
    session_id: &str,
    cursor: Option<LocalTranscriptCursor>,
) -> Result<LocalTranscriptPage> {
    if cursor.is_none() {
        hydrate(store, source, session_id)?;
    }
    let conn = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let page = read_page(&conn, source.as_str(), session_id, cursor.clone())?;
    if cursor.is_none() || page.next_cursor.is_some() {
        return Ok(page);
    }
    match hydrate(store, source, session_id) {
        Ok(()) => read_page(&conn, source.as_str(), session_id, cursor),
        Err(_) => Ok(page),
    }
}

fn hydrate(store: &ai_hist::SessionStore, source: Source, session_id: &str) -> Result<()> {
    // A fresh reader cache has no provider locators yet. Discover only
    // this harness's metadata, then hydrate just the requested session.
    let mut query = ai_hist::SessionQuery::default();
    query.kinds = Some(Vec::new());
    let reference = SessionRef::id(source, session_id);
    if store.session(&reference, query.clone())?.is_none() {
        // Local discovery runs before the connector: a session a local
        // provider can see hydrates locally — remote intake is for rows no
        // local provider can reach, and a connector error must not mask a
        // readable local session.
        let mut discovery = ai_hist::DiscoveryOptions::default();
        discovery.sources = Some(vec![source]);
        store.discover(discovery)?;
    }
    // A row the reader already holds remote-only — from an earlier open —
    // refreshes through the connector again; local hydrate cannot reach it.
    if super::remote_sources::remote_only(store, source, session_id)? {
        return match super::remote_sources::hydrate_reader(
            store,
            source.as_str(),
            session_id,
            || false,
        )? {
            Some(_) => Ok(()),
            None => Err(ai_hist::Error::ConnectorNotConfigured(format!(
                "no remote source connector can hydrate {session_id}; its provider is not signed in"
            ))
            .into()),
        };
    }
    if store.session(&reference, query)?.is_none() {
        // A cloud-only session has no local row to discover; its connector
        // lands the placeholder observation plus the evidence itself.
        if super::remote_sources::hydrate_reader(store, source.as_str(), session_id, || false)?
            .is_some()
        {
            return Ok(());
        }
    }
    let mut hydration = HydrateOptions::default();
    hydration.include_related = false;
    store.hydrate(&reference, hydration)?;
    Ok(())
}

fn read_page(
    conn: &Connection,
    source: &str,
    session_id: &str,
    cursor: Option<LocalTranscriptCursor>,
) -> Result<LocalTranscriptPage> {
    // SessionStore exposes whole-session reads. This bounded projection uses
    // the public SessionEvent fields and the store's (timestamp, id) ordering
    // so a large tool result is never fully materialized just to show a page.
    //
    // Devin's `message_nodes` is a tree: each new context branch re-records
    // the conversation's earlier messages under their original `message_id`,
    // so one logical event lands as one row per copy — `n9:text`, `n16:text`
    // and `n24:text` for a message first written as `n2:text`. Every copy of a
    // node writes the same event parts (`:text`, `:thinking`, `:tool:<id>`,
    // `:result:<id>`), so the event_uid past its node prefix is the part key:
    // the first copy of each part in (ts_ms, id) order survives, every later
    // replay drops. Nodes with no provider `message_id` hold `n<node>` there
    // instead, which never groups with another node — they stay. Picking the
    // winner is a session-wide aggregate, so only Devin runs it; every other
    // source keeps the plain keyset scan below.
    let page_sql = "SELECT id, ts_ms, event_uid, role, kind, substr(text,1,CASE WHEN raw_kind='input_image' THEN 1400000 ELSE 65536 END), control_kind, length(CAST(text AS BLOB)) FROM session_events WHERE source = ?1 AND session_id = ?2 AND (?3 IS NULL OR ts_ms > ?3 OR (ts_ms = ?3 AND id > ?4)) ORDER BY ts_ms, id LIMIT 101";
    let devin_sql = "SELECT id, ts_ms, event_uid, role, kind, substr(text,1,CASE WHEN raw_kind='input_image' THEN 1400000 ELSE 65536 END), control_kind, length(CAST(text AS BLOB)) FROM session_events WHERE source = ?1 AND session_id = ?2 AND (?3 IS NULL OR ts_ms > ?3 OR (ts_ms = ?3 AND id > ?4)) AND id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY CASE WHEN event_uid GLOB 'n[0-9]*:*' THEN COALESCE(message_id, event_uid) || substr(event_uid, instr(event_uid, ':')) ELSE event_uid END ORDER BY ts_ms, id) AS position FROM session_events WHERE source = ?1 AND session_id = ?2) WHERE position = 1) ORDER BY ts_ms, id LIMIT 101";
    let mut query = conn.prepare(if source == "devin" {
        devin_sql
    } else {
        page_sql
    })?;
    let events = query.query_map(
        rusqlite::params![
            source,
            session_id,
            cursor.as_ref().map(|c| c.ts_ms),
            cursor.as_ref().map(|c| c.id)
        ],
        TranscriptEvent::from_row,
    )?;
    let mut result = LocalTranscriptPage {
        entries: Vec::new(),
        next_cursor: None,
        follow_cursor: None,
    };
    // Leave room for JSON escaping and envelope fields below the bridge's 1 MiB frame limit.
    let mut bytes = 0;
    let mut last = None;
    let mut scanned = 0;
    for event in events {
        let event = event?;
        if scanned == 100 {
            result.next_cursor = last;
            return Ok(result);
        }
        scanned += 1;
        let position = LocalTranscriptCursor {
            ts_ms: event.ts_ms,
            id: event.id,
        };
        let Some(entry) = event.display_entry(conn)? else {
            last = Some(position);
            continue;
        };
        let size = serde_json::to_vec(&entry)?.len();
        if !result.entries.is_empty() && bytes + size > 512 * 1024 {
            result.next_cursor = last;
            return Ok(result);
        }
        bytes += size;
        last = Some(position);
        result.entries.push(entry);
    }
    Ok(result)
}

/// The bounded database projection, before display filtering or image caching.
struct TranscriptEvent {
    id: i64,
    ts_ms: i64,
    event_uid: String,
    role: String,
    kind: String,
    text: Option<String>,
    control_kind: Option<String>,
    text_bytes: Option<usize>,
}

impl TranscriptEvent {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            ts_ms: row.get(1)?,
            event_uid: row.get(2)?,
            role: row.get(3)?,
            kind: row.get(4)?,
            text: row.get(5)?,
            control_kind: row.get(6)?,
            text_bytes: row.get(7)?,
        })
    }

    /// None means the user-facing display filtered out a context wrapper;
    /// its database position must still count toward the next page cursor.
    fn display_entry(self, conn: &Connection) -> Result<Option<LocalTranscriptEntry>> {
        let Self {
            ts_ms,
            event_uid,
            role,
            kind,
            text,
            control_kind,
            text_bytes,
            ..
        } = self;
        let text = text.as_deref().unwrap_or("");
        let display = if role == "user" && kind == "text" {
            super::transcript_display::user_text(text)
        } else {
            text.to_string()
        };
        if display.is_empty() && !text.is_empty() {
            return Ok(None);
        }
        let image_path = match conn.path().and_then(|p| std::path::Path::new(p).parent()) {
            Some(directory) => super::transcript_display::cache_image(&display, directory)?,
            None => None,
        };
        let text = if image_path.is_some() {
            ""
        } else {
            display.as_str()
        };
        let mut end = text.len().min(64 * 1024);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(Some(LocalTranscriptEntry {
            id: event_uid,
            role,
            kind: if control_kind.is_some() {
                "context".into()
            } else {
                kind
            },
            text: text[..end].into(),
            image_path: image_path.clone(),
            timestamp_ms: ts_ms,
            truncated: image_path.is_none() && text_bytes.unwrap_or(0) > 64 * 1024,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_session_reports_safe_reason_without_recreating_reader_cache() {
        let Some(home) = crate::live::tests::isolated_home(
            "transcript::tests::reset_session_reports_safe_reason_without_recreating_reader_cache",
        ) else {
            return;
        };
        let root = home.join(".agentworkforce");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("session-reset-baseline.json"),
            r#"[{"source":"codex","session_id":"reset-session"}]"#,
        )
        .unwrap();
        let error = read(ReadSession {
            source: "codex".into(),
            session_id: "reset-session".into(),
            after_ts: None,
            after_id: None,
        })
        .unwrap_err();
        let safe = error
            .downcast_ref::<super::super::UserError>()
            .expect("reset refusal must reach the UI instead of the generic probe error");
        assert_eq!(safe.to_string(), "This session was removed from Relay by Reset all sessions. Its original transcript is unchanged; open it in the source app to read it.");
        assert!(!root.join("session-reader").exists());
    }

    #[test]
    fn context_only_pages_advance_and_images_are_copied_outside_the_frame() {
        use base64::Engine;
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("history.db");
        super::super::history::open(&db).unwrap();
        let conn = Connection::open(db).unwrap();
        let xml =
            "<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>";
        for i in 0..101 {
            conn.execute("INSERT INTO session_events(source,session_id,ts_ms,event_uid,role,kind,text) VALUES('codex','s',1,?1,'user','text',?2)", rusqlite::params![format!("context-{i}"),xml]).unwrap();
        }
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend(vec![0; 100_000]);
        let markdown = format!(
            "![Attached image](data:image/png;base64,{})",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        );
        conn.execute("INSERT INTO session_events(source,session_id,ts_ms,event_uid,role,kind,raw_kind,text) VALUES('codex','s',2,'image','user','text','input_image',?1)", [&markdown]).unwrap();
        let first = read_page(&conn, "codex", "s", None).unwrap();
        assert!(first.entries.is_empty());
        assert!(first.next_cursor.is_some());
        let second = read_page(&conn, "codex", "s", first.next_cursor).unwrap();
        assert_eq!(second.entries.len(), 1);
        let entry = &second.entries[0];
        assert_eq!(
            std::fs::read(entry.image_path.as_ref().unwrap()).unwrap(),
            bytes
        );
        assert!(entry.text.is_empty());
        assert!(!entry.truncated);
        assert!(serde_json::to_vec(&second).unwrap().len() < 1024);
    }

    /// With a configured connector, a session the local Devin CLI store
    /// holds must still hydrate through the local adapter: discovery runs
    /// first, so the remote path never sees the row — zero API calls.
    #[test]
    fn a_local_devin_session_hydrates_locally_not_through_the_connector() {
        use super::super::remote_sources::tests::{signed_in_home, StubApi, ENV_LOCK};
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = StubApi::start();
        let (home, _env) = signed_in_home(&api.url());
        let cli = home.path().join(".local/share/devin/cli");
        std::fs::create_dir_all(&cli).unwrap();
        rusqlite::Connection::open(cli.join("sessions.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, last_activity_at INTEGER);\
                 CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, created_at INTEGER, chat_message TEXT, metadata TEXT, row_id INTEGER);\
                 INSERT INTO sessions VALUES('local-sess','local work',1700000000,1700000060);\
                 INSERT INTO message_nodes VALUES('local-sess',1,NULL,1700000000,'{\"role\":\"user\",\"content\":\"hi\"}','{}',1);",
            )
            .unwrap();
        let db = home.path().join("reader.db");
        let mut options = ai_hist::StoreOptions::default();
        options.db_path = Some(db);
        options.roots = Some(ai_hist::ProviderRoots::from_home(
            home.path().to_path_buf(),
            home.path().join("opencode.db"),
        ));
        let store = ai_hist::SessionStore::open(options).unwrap();
        let source = Source::parse("devin").unwrap();
        hydrate(&store, source, "local-sess").unwrap();
        assert_eq!(api.requests(), 0, "a local session hit the remote API");
        assert!(!super::super::remote_sources::remote_only(&store, source, "local-sess").unwrap());
        assert!(store
            .session(
                &SessionRef::id(source, "local-sess"),
                ai_hist::SessionQuery::default()
            )
            .unwrap()
            .is_some());
    }

    #[test]
    fn discovers_and_hydrates_an_unuploaded_codex_transcript() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let logs = root.join(".codex/sessions/2026/10/09");
        std::fs::create_dir_all(&logs).unwrap();
        let id = "019c8d5c-a4f2-7777-aaaa-123456789abc";
        let rows = [
            serde_json::json!({"timestamp":"2026-10-09T00:00:00Z","type":"session_meta","payload":{"id":id,"cwd":"/work/project","timestamp":"2026-10-09T00:00:00Z"}}),
            serde_json::json!({"timestamp":"2026-10-09T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Please fix the tests"}]}}),
            serde_json::json!({"timestamp":"2026-10-09T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Fixed** the tests."}]}}),
        ];
        std::fs::write(
            logs.join(format!("rollout-2026-10-09T00-00-00-{id}.jsonl")),
            rows.iter()
                .map(|r| r.to_string())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let db = root.join("reader.db");
        let mut options = ai_hist::StoreOptions::default();
        options.db_path = Some(db.clone());
        options.roots = Some(ai_hist::ProviderRoots::from_home(
            root.to_path_buf(),
            root.join("opencode.db"),
        ));
        let store = ai_hist::SessionStore::open(options).unwrap();
        hydrate(&store, Source::Codex, id).unwrap();
        let conn = Connection::open(db).unwrap();
        let page = read_page(&conn, "codex", id, None).unwrap();
        assert!(page
            .entries
            .iter()
            .any(|entry| entry.role == "user" && entry.text == "Please fix the tests"));
        assert!(page
            .entries
            .iter()
            .any(|entry| entry.role == "assistant" && entry.text == "**Fixed** the tests."));
        // No install, collector, or upload journal is created by reading.
        assert!(!root.join(".agentworkforce").exists());
    }

    /// A transcript still being written is followed past its first page:
    /// a read that reaches the end refreshes the cache, so what was written
    /// since appears even when the read is from a cursor.
    #[test]
    fn a_read_from_a_cursor_at_the_end_shows_what_was_written_since() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let logs = root.join(".codex/sessions/2026/10/09");
        std::fs::create_dir_all(&logs).unwrap();
        let id = "019c8d5c-a4f2-7777-aaaa-123456789abd";
        let line = |second: u32, role: &str, kind: &str, text: &str| {
            serde_json::json!({"timestamp": format!("2026-10-09T00:00:{second:02}Z"), "type": "response_item",
                "payload": {"type": "message", "role": role, "content": [{"type": kind, "text": text}]}})
            .to_string()
                + "\n"
        };
        let file = logs.join(format!("rollout-2026-10-09T00-00-00-{id}.jsonl"));
        let meta = serde_json::json!({"timestamp":"2026-10-09T00:00:00Z","type":"session_meta","payload":{"id":id,"cwd":"/work/project","timestamp":"2026-10-09T00:00:00Z"}});
        std::fs::write(
            &file,
            meta.to_string() + "\n" + &line(1, "user", "input_text", "Please fix the tests"),
        )
        .unwrap();
        let db = root.join("reader.db");
        let mut options = ai_hist::StoreOptions::default();
        options.db_path = Some(db.clone());
        options.roots = Some(ai_hist::ProviderRoots::from_home(
            root.to_path_buf(),
            root.join("opencode.db"),
        ));
        let store = ai_hist::SessionStore::open(options).unwrap();
        let first = read_from(&store, &db, Source::Codex, id, None).unwrap();
        assert!(first
            .entries
            .iter()
            .any(|e| e.text == "Please fix the tests"));
        // Where a later page of the transcript would start.
        let at = Connection::open(&db)
            .unwrap()
            .query_row(
                "SELECT ts_ms, id FROM session_events WHERE session_id = ?1 ORDER BY ts_ms DESC, id DESC LIMIT 1",
                [id],
                |row| Ok(LocalTranscriptCursor { ts_ms: row.get(0)?, id: row.get(1)? }),
            )
            .unwrap();
        let mut more = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        std::io::Write::write_all(
            &mut more,
            line(2, "assistant", "output_text", "**Fixed** the tests.").as_bytes(),
        )
        .unwrap();
        let next = read_from(&store, &db, Source::Codex, id, Some(at)).unwrap();
        assert!(next.next_cursor.is_none());
        assert!(next
            .entries
            .iter()
            .any(|e| e.text == "**Fixed** the tests."));
        assert!(!next
            .entries
            .iter()
            .any(|e| e.text == "Please fix the tests"));
    }

    #[test]
    fn pages_are_source_scoped_ordered_and_preserve_context_and_code() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history.db");
        super::super::history::open(&path).unwrap();
        let conn = Connection::open(path).unwrap();
        for i in 0..103 {
            conn.execute("INSERT INTO session_events (source,session_id,ts_ms,role,kind,text,event_uid,control_kind) VALUES ('codex','same',1,'user','text',?1,?2,?3)", rusqlite::params![if i == 0 { "```swift\nlet x = 1\n```" } else { "Hello" }, format!("e{i}"), if i == 1 { Some("codex_context_wrapper") } else { None }]).unwrap();
        }
        conn.execute("INSERT INTO session_events (source,session_id,ts_ms,role,kind,text,event_uid) VALUES ('claude','same',1,'user','text','Other harness','other')", []).unwrap();
        let first = read_page(&conn, "codex", "same", None).unwrap();
        assert_eq!(first.entries.len(), 100);
        assert_eq!(first.entries[0].text, "```swift\nlet x = 1\n```");
        assert_eq!(first.entries[1].kind, "context");
        let second = read_page(&conn, "codex", "same", first.next_cursor).unwrap();
        assert_eq!(second.entries.len(), 3);
        assert_eq!(second.entries[0].id, "e100");
        assert!(second.next_cursor.is_none());
        assert!(read_page(&conn, "codex", "missing", None)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn devin_context_replays_collapse_to_one_entry_per_message_part() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history.db");
        super::super::history::open(&path).unwrap();
        let conn = Connection::open(path).unwrap();
        let insert = |uid: &str,
                      ts: i64,
                      role: &str,
                      kind: &str,
                      text: &str,
                      message_id: Option<&str>| {
            conn.execute(
                "INSERT INTO session_events(source,session_id,ts_ms,event_uid,role,kind,text,message_id) \
                 VALUES('devin','s',?1,?2,?3,?4,?5,?6)",
                rusqlite::params![ts, uid, role, kind, text, message_id],
            )
            .unwrap();
        };
        // The CLI re-records the running context on each new branch: the
        // same user prompt lands under four nodes, the reply under two.
        for node in [2, 9, 16, 24] {
            insert(
                &format!("n{node}:text"),
                node,
                "user",
                "text",
                "ping test",
                Some("m-user"),
            );
        }
        for node in [26, 27] {
            insert(
                &format!("n{node}:text"),
                node,
                "assistant",
                "text",
                "Pong.",
                Some("m-reply"),
            );
            insert(
                &format!("n{node}:tool:call-a"),
                node,
                "assistant",
                "tool_use",
                "read a.rs",
                Some("m-reply"),
            );
        }
        // A node without a provider message_id is never a proven copy.
        insert("n30:text", 30, "user", "text", "kept", None);
        // Two different calls from one recorded message stay separate.
        insert(
            "n31:tool:call-a",
            31,
            "assistant",
            "tool_use",
            "read a.rs",
            Some("m-other"),
        );
        insert(
            "n31:tool:call-b",
            31,
            "assistant",
            "tool_use",
            "read b.rs",
            Some("m-other"),
        );
        // The winner is the first copy in (ts_ms, id) order, not the first
        // inserted: this replay was written after n40 but carries an earlier
        // timestamp, so it survives and the message renders at 50.
        insert(
            "n40:text",
            200,
            "user",
            "text",
            "out of order",
            Some("m-late"),
        );
        insert(
            "n41:text",
            50,
            "user",
            "text",
            "out of order",
            Some("m-late"),
        );
        let page = read_page(&conn, "devin", "s", None).unwrap();
        let ids: Vec<&str> = page.entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "n2:text",
                "n26:text",
                "n26:tool:call-a",
                "n30:text",
                "n31:tool:call-a",
                "n31:tool:call-b",
                "n41:text"
            ]
        );
    }

    #[test]
    fn non_devin_rows_keep_every_event_uid() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history.db");
        super::super::history::open(&path).unwrap();
        let conn = Connection::open(path).unwrap();
        // A source whose uids happen to share the devin node shape is not
        // deduped by (message_id, part): only devin rows group that way.
        for (uid, message_id) in [("n2:text", "m"), ("n9:text", "m")] {
            conn.execute(
                "INSERT INTO session_events(source,session_id,ts_ms,event_uid,role,kind,text,message_id) \
                 VALUES('codex','s',1,?1,'user','text','hi',?2)",
                rusqlite::params![uid, message_id],
            )
            .unwrap();
        }
        let page = read_page(&conn, "codex", "s", None).unwrap();
        assert_eq!(page.entries.len(), 2);
    }

    #[test]
    fn large_unicode_output_stays_within_frame_and_keeps_continuation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history.db");
        super::super::history::open(&path).unwrap();
        let conn = Connection::open(path).unwrap();
        for i in 0..30 {
            conn.execute("INSERT INTO session_events (source,session_id,ts_ms,role,kind,text,event_uid) VALUES ('codex','large',1,'assistant','tool_result',?1,?2)", rusqlite::params!["🦀\n".repeat(30000), format!("e{i}")]).unwrap();
        }
        let page = read_page(&conn, "codex", "large", None).unwrap();
        assert!(page.entries[0].truncated);
        assert!(serde_json::to_vec(&page).unwrap().len() < 1024 * 1024);
        let next = read_page(&conn, "codex", "large", page.next_cursor).unwrap();
        assert_ne!(next.entries[0].id, page.entries[0].id);
    }
}
