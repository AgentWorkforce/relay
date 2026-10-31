//! Probe-owned upload tables, and the one-time rebuild of an install whose
//! uploads ran on `ai-hist`'s export journal.
use super::*;
use ai_hist::SessionStore;

/// Create any missing upload table. Safe beside a collector of another build:
/// it only adds tables and columns that build ignores.
pub(super) fn init(conn: &Connection) -> Result<()> {
    // Builds before pipelined delivery kept one unresolved batch per job and
    // enforced it with this index as UNIQUE. A pipelined job holds several,
    // so the index is replaced by a plain one under the same name: an older
    // build's `CREATE UNIQUE INDEX IF NOT EXISTS` then finds it and does not
    // fail on a job that holds several.
    let unique_pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='delivery_one_pending_batch' AND sql LIKE 'CREATE UNIQUE%')",
        [],
        |r| r.get(0),
    )?;
    if unique_pending {
        conn.execute_batch("DROP INDEX delivery_one_pending_batch;")?;
    }
    conn.execute_batch(
        r#"CREATE TABLE IF NOT EXISTS delivery_jobs (
    id TEXT PRIMARY KEY, destination_id TEXT NOT NULL, instance_id TEXT NOT NULL, account_id TEXT NOT NULL,
    generation INTEGER NOT NULL, config_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','paused','blocked','cancelled')),
    created_ms INTEGER NOT NULL, journal_cursor INTEGER NOT NULL DEFAULT 0,
    bootstrap_done INTEGER NOT NULL DEFAULT 0, acknowledged_cursor INTEGER NOT NULL DEFAULT 0,
    fence INTEGER NOT NULL DEFAULT 0, worker_id TEXT, lease_until_ms INTEGER,
    next_attempt_ms INTEGER NOT NULL DEFAULT 0, receiver_retry_after_ms INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_ms INTEGER, last_acknowledged_ms INTEGER, acceptance_level TEXT, failure TEXT, retry_build TEXT,
    suppressed_records INTEGER NOT NULL DEFAULT 0, skipped_records INTEGER NOT NULL DEFAULT 0,
    acknowledged_records INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_active_instance ON delivery_jobs(destination_id,instance_id,account_id) WHERE state <> 'cancelled';
CREATE TABLE IF NOT EXISTS delivery_job_builds (
    job_id TEXT NOT NULL, build TEXT NOT NULL, PRIMARY KEY(job_id,build)
);
CREATE TABLE IF NOT EXISTS delivery_batches (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','leased','retry_wait','blocked','acknowledged','suppressed','cancelled')),
    payload TEXT, prepared TEXT, records INTEGER NOT NULL, bytes INTEGER NOT NULL,
    journal_end INTEGER NOT NULL, created_ms INTEGER NOT NULL, accepted_records INTEGER NOT NULL DEFAULT 0,
    accepted_revision_ids TEXT NOT NULL DEFAULT '[]', suppressed_revision_ids TEXT NOT NULL DEFAULT '[]',
    rejected_revision_ids TEXT NOT NULL DEFAULT '[]', isolation_frontier TEXT NOT NULL DEFAULT '[]',
    claim_seq INTEGER
);
CREATE INDEX IF NOT EXISTS delivery_one_pending_batch ON delivery_batches(job_id,journal_end) WHERE state IN ('pending','leased','retry_wait','blocked');
CREATE INDEX IF NOT EXISTS delivery_batch_job ON delivery_batches(job_id, seq);
CREATE TABLE IF NOT EXISTS delivery_conflict_attempts (
    parent_batch_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, child_batch_id TEXT,
    kind TEXT NOT NULL, submitted_digest TEXT NOT NULL,
    payload TEXT NOT NULL, prepared TEXT NOT NULL, created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_quarantine (
    job_id TEXT NOT NULL, parent_batch_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    record_id TEXT NOT NULL, record_json TEXT NOT NULL,
    submitted_digest TEXT NOT NULL, current_digest TEXT NOT NULL,
    created_ms INTEGER NOT NULL, PRIMARY KEY(parent_batch_id,revision_id)
);
CREATE TABLE IF NOT EXISTS delivery_session_jobs (job_id TEXT PRIMARY KEY, last_member TEXT NOT NULL DEFAULT '', membership_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS delivery_session_members (
 id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT NOT NULL,
 cutoff INTEGER NOT NULL, cursor INTEGER NOT NULL, bootstrap_done INTEGER NOT NULL DEFAULT 0,
 phase INTEGER NOT NULL DEFAULT 0, delegated INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(job_id,source,session_id)
);
CREATE INDEX IF NOT EXISTS delivery_member_snapshot ON delivery_session_members(job_id,bootstrap_done);
CREATE INDEX IF NOT EXISTS delivery_member_identity ON delivery_session_members(source,session_id);
CREATE TABLE IF NOT EXISTS delivery_exclusions (
    source TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(source,session_id)
);
CREATE TABLE IF NOT EXISTS delivery_origin (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), origin_id TEXT NOT NULL,
    revision_base INTEGER NOT NULL, feed_epoch INTEGER NOT NULL DEFAULT 0,
    max_revision INTEGER NOT NULL DEFAULT 0
);
"#,
    )?;
    if !column_exists(conn, "delivery_jobs", "retry_build")? {
        conn.execute_batch("ALTER TABLE delivery_jobs ADD COLUMN retry_build TEXT;")?;
    }
    if !column_exists(conn, "delivery_jobs", "skipped_records")? {
        conn.execute_batch(
            "ALTER TABLE delivery_jobs ADD COLUMN skipped_records INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    // An older build never persisted Retry-After, so its existing deadline
    // is client-generated and safe to clamp once.
    add_column_if_missing(
        conn,
        "delivery_jobs",
        "receiver_retry_after_ms",
        "ALTER TABLE delivery_jobs ADD COLUMN receiver_retry_after_ms INTEGER NOT NULL DEFAULT 0;",
    )?;
    conn.execute_batch("INSERT OR IGNORE INTO delivery_job_builds(job_id,build) SELECT id,retry_build FROM delivery_jobs WHERE retry_build IS NOT NULL;")?;
    if !column_exists(conn, "delivery_session_members", "phase")? {
        conn.execute_batch(
            "ALTER TABLE delivery_session_members ADD COLUMN phase INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !column_exists(conn, "delivery_session_members", "delegated")? {
        conn.execute_batch(
            "ALTER TABLE delivery_session_members ADD COLUMN delegated INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !column_exists(conn, "delivery_session_jobs", "last_member")? {
        conn.execute_batch(
            "ALTER TABLE delivery_session_jobs ADD COLUMN last_member TEXT NOT NULL DEFAULT '';",
        )?;
    }
    if !column_exists(conn, "delivery_session_jobs", "membership_seq")? {
        // Nothing records when an older build changed a job's membership, so
        // the batches it holds now are treated as prepared before a change.
        conn.execute_batch(
            "ALTER TABLE delivery_session_jobs ADD COLUMN membership_seq INTEGER NOT NULL DEFAULT 0;
             UPDATE delivery_session_jobs SET membership_seq=(SELECT COALESCE(MAX(seq),0) FROM delivery_batches b WHERE b.job_id=delivery_session_jobs.job_id);",
        )?;
    }
    if !column_exists(conn, "delivery_batches", "claim_seq")? {
        conn.execute_batch("ALTER TABLE delivery_batches ADD COLUMN claim_seq INTEGER;")?;
    }
    if !column_exists(conn, "delivery_batches", "accepted_revision_ids")? {
        conn.execute_batch(
            "ALTER TABLE delivery_batches ADD COLUMN accepted_revision_ids TEXT NOT NULL DEFAULT '[]';",
        )?;
    }
    if !column_exists(conn, "delivery_batches", "suppressed_revision_ids")? {
        conn.execute_batch(
            "ALTER TABLE delivery_batches ADD COLUMN suppressed_revision_ids TEXT NOT NULL DEFAULT '[]';",
        )?;
    }
    if !column_exists(conn, "delivery_batches", "rejected_revision_ids")? {
        conn.execute_batch(
            "ALTER TABLE delivery_batches ADD COLUMN rejected_revision_ids TEXT NOT NULL DEFAULT '[]';",
        )?;
    }
    if !column_exists(conn, "delivery_batches", "isolation_frontier")? {
        conn.execute_batch(
            "ALTER TABLE delivery_batches ADD COLUMN isolation_frontier TEXT NOT NULL DEFAULT '[]';",
        )?;
    }
    Ok(())
}

pub(super) fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        params![table, column],
        |r| r.get(0),
    )?)
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, sql: &str) -> Result<()> {
    if !column_exists(conn, table, column)? {
        conn.execute_batch(sql)?;
    }
    Ok(())
}

pub(super) fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [table],
        |r| r.get(0),
    )?)
}

/// The evidence tables the export journal captured, each carrying the
/// journal's `delivery_<table>_{insert,update,delete}` triggers.
const EVIDENCE_TABLES: &[&str] = &[
    "history",
    "session_events",
    "tool_calls",
    "file_edits",
    "sessions",
    "session_presences",
    "session_relationships",
    "session_commit_links",
    "trajectories",
    "session_observations",
    "observation_evidence",
    "session_markers",
];
/// The export journal's own tables: its rows, preimages, snapshot bounds,
/// subscriptions and file exports.
const JOURNAL_TABLES: &[&str] = &[
    "delivery_journal",
    "delivery_shadow",
    "delivery_bootstrap_bounds",
    "history_subscriptions",
    "history_compaction",
    "history_exports",
    "history_export_pages",
];
/// Upload-table columns and indexes only the export journal used.
const JOURNAL_COLUMNS: &[(&str, &str)] = &[
    ("delivery_jobs", "cutoff"),
    ("delivery_jobs", "bootstrap_kind"),
    ("delivery_jobs", "bootstrap_rowid"),
    ("delivery_session_members", "bootstrap_kind"),
    ("delivery_session_members", "bootstrap_rowid"),
    ("delivery_session_members", "ready"),
];
const JOURNAL_INDEXES: &[&str] = &["delivery_member_ready", "delivery_member_cursor"];

/// Whether the install still carries the export journal: its table, or a
/// trigger that writes into it.
pub(super) fn has_journal(conn: &Connection) -> Result<bool> {
    Ok(table_exists(conn, "delivery_journal")? || !journal_triggers(conn)?.is_empty())
}

/// Every trigger the export journal installed: the capture triggers on the
/// evidence tables, and the retention cap, reserve and byte-count triggers on
/// its own tables and on `delivery_batches`.
fn journal_triggers(conn: &Connection) -> Result<Vec<String>> {
    let mut statement =
        conn.prepare("SELECT name,tbl_name FROM sqlite_master WHERE type='trigger'")?;
    let triggers = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(triggers
        .into_iter()
        .filter(|(name, table)| {
            let capture = EVIDENCE_TABLES.contains(&table.as_str())
                && ["insert", "update", "delete"]
                    .iter()
                    .any(|operation| *name == format!("delivery_{table}_{operation}"));
            let accounting = (table == "delivery_batches"
                || JOURNAL_TABLES.contains(&table.as_str()))
                && (name.contains("_cap_")
                    || name.contains("_count_")
                    || name.contains("_reserve_")
                    || name == "delivery_session_ready");
            capture || accounting
        })
        .map(|(name, _)| name)
        .collect())
}

/// Rebuild an install whose uploads ran on the export journal, and give a new
/// install its origin. The caller holds the collector lock. Idempotent: once
/// the journal is gone and the origin recorded, this does nothing.
///
/// In one transaction it keeps `origin_id` (from `delivery_state`) and records
/// `revision_base`, the journal's AUTOINCREMENT high-water mark: the highest
/// revision the journal issued, including ones compaction has since removed,
/// so records numbered from the feed stay above everything this origin sent.
/// It drops the capture triggers, which would otherwise keep writing the
/// journal and abort ingest at its cap; the journal's tables, triggers,
/// columns and indexes; and every unsent batch. Each live job restarts from
/// the feed's start and each member's backfill from the start, keeping the
/// job's sharing mode, pause state, members and exclusions. The receiver then
/// replaces every record, since each new revision is higher than the one it
/// holds.
///
/// `store` opens the feed only when there is something to rebuild: on every
/// other open it is never called.
pub(super) fn rebuild(
    conn: &Connection,
    store: impl FnOnce() -> Result<SessionStore>,
) -> Result<()> {
    let journal = has_journal(conn)?;
    let origin_recorded: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_origin WHERE singleton=1)",
        [],
        |r| r.get(0),
    )?;
    if !journal && origin_recorded {
        return Ok(());
    }
    let head = store()?.head_revision()?;
    let tx = write_transaction(conn)?;
    let kept: Option<String> = if table_exists(&tx, "delivery_state")? {
        tx.query_row(
            "SELECT origin_id FROM delivery_state WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    let origin_id: String = match kept {
        Some(origin_id) => origin_id,
        None => tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?,
    };
    let issued: i64 = if table_exists(&tx, "sqlite_sequence")? {
        tx.query_row(
            "SELECT seq FROM sqlite_sequence WHERE name='delivery_journal'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0)
    } else {
        0
    };
    // An origin already recorded keeps its identity, and its base never
    // falls: a journal written again after a rebuild restarts its sequence.
    tx.execute(
        "INSERT INTO delivery_origin(singleton,origin_id,revision_base,max_revision,feed_epoch) VALUES (1,?1,?2,?2,?3)
         ON CONFLICT(singleton) DO UPDATE SET
           revision_base=MAX(revision_base,max_revision,excluded.revision_base),
           max_revision=MAX(max_revision,excluded.revision_base),
           feed_epoch=excluded.feed_epoch",
        params![origin_id, issued, head.epoch as i64],
    )?;
    if journal {
        for trigger in journal_triggers(&tx)? {
            tx.execute_batch(&format!("DROP TRIGGER IF EXISTS \"{trigger}\";"))?;
        }
        for table in JOURNAL_TABLES {
            tx.execute_batch(&format!("DROP TABLE IF EXISTS {table};"))?;
        }
        for table in EVIDENCE_TABLES {
            tx.execute_batch(&format!("DROP INDEX IF EXISTS delivery_identity_{table};"))?;
        }
        for index in JOURNAL_INDEXES {
            tx.execute_batch(&format!("DROP INDEX IF EXISTS {index};"))?;
        }
        for (table, column) in JOURNAL_COLUMNS {
            if column_exists(&tx, table, column)? {
                tx.execute_batch(&format!("ALTER TABLE {table} DROP COLUMN {column};"))?;
            }
        }
        tx.execute(
            "DELETE FROM schema_migrations WHERE name IN ('delivery_v1','history_export_storage_v1','delivery_capture_filter_v1')",
            [],
        )?;
        feed::restart_jobs(&tx, head.revision)?;
        adopt_every_kind(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

/// Move each live job's stored selection to every evidence kind. A job that
/// shared prompts, which only sharing everything did, keeps sharing prompts
/// that name no session. Consent — exclusions and membership — is unchanged,
/// and a job whose configuration differed from the probe's would otherwise be
/// refused as a changed generation at the next setup.
fn adopt_every_kind(conn: &Connection) -> Result<()> {
    let jobs = conn
        .prepare("SELECT id,config_json,EXISTS(SELECT 1 FROM delivery_session_jobs s WHERE s.job_id=delivery_jobs.id) FROM delivery_jobs WHERE state<>'cancelled'")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, config, scoped) in jobs {
        let mut config: DeliveryJobConfig = serde_json::from_str(&config)?;
        let selection = &mut config.selection;
        selection.sessionless = !scoped && selection.kinds.iter().any(|kind| kind == "history");
        selection.kinds = SUPPORTED_KINDS.iter().map(|kind| (*kind).into()).collect();
        conn.execute(
            "UPDATE delivery_jobs SET config_json=? WHERE id=?",
            params![serde_json::to_string(&config)?, id],
        )?;
    }
    Ok(())
}
