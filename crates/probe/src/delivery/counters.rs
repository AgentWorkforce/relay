//! Exact, payload-free status accounting, including writes by older collectors.
use super::*;

pub(super) fn init(conn: &Connection) -> Result<()> {
    // Serialize the initial rebuild with writers and other initializers. A crash
    // commits both the baseline and triggers, or neither. Ordinary opens never
    // recount history. Triggers also cover legacy writers and transaction rollback.
    let tx = write_transaction(conn)?;
    tx.execute_batch("CREATE INDEX IF NOT EXISTS delivery_quarantine_job ON delivery_quarantine(job_id);
        CREATE INDEX IF NOT EXISTS delivery_oldest_pending ON delivery_batches(job_id,created_ms) WHERE state IN ('pending','leased','retry_wait','blocked');")?;
    let initialized: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_status_counters')", [], |r| r.get(0))?;
    if !initialized {
        tx.execute_batch("CREATE TABLE delivery_status_counters (
            job_id TEXT PRIMARY KEY, pending_records INTEGER NOT NULL DEFAULT 0,
            pending_bytes INTEGER NOT NULL DEFAULT 0, quarantined_records INTEGER NOT NULL DEFAULT 0);
            INSERT INTO delivery_status_counters(job_id,pending_records,pending_bytes)
            SELECT job_id,SUM(records),SUM(bytes+COALESCE(length(CAST(prepared AS BLOB)),0)) FROM delivery_batches
            WHERE state IN ('pending','leased','retry_wait','blocked') GROUP BY job_id;
            INSERT INTO delivery_status_counters(job_id,quarantined_records)
            SELECT job_id,COUNT(*) FROM delivery_quarantine GROUP BY job_id
            ON CONFLICT(job_id) DO UPDATE SET quarantined_records=excluded.quarantined_records;")?;
        for (table, fields, new) in [
            (
                "delivery_batches",
                "pending_records,pending_bytes",
                "NEW.records,NEW.bytes+COALESCE(length(CAST(NEW.prepared AS BLOB)),0)",
            ),
            ("delivery_quarantine", "quarantined_records", "1"),
        ] {
            let delta = |prefix: &str, values: &str, sign: &str| {
                let assignments = fields
                    .split(',')
                    .map(|field| format!("{field}={field}{sign}excluded.{field}"))
                    .collect::<Vec<_>>()
                    .join(",");
                let condition = if table == "delivery_batches" {
                    format!(" WHERE {prefix}.state IN ('pending','leased','retry_wait','blocked')")
                } else {
                    String::new()
                };
                // WHERE true disambiguates SELECT's ON from UPSERT's ON.
                format!("INSERT INTO delivery_status_counters(job_id,{fields}) SELECT {prefix}.job_id,{values}{} ON CONFLICT(job_id) DO UPDATE SET {assignments};", if condition.is_empty() { " WHERE true".into() } else {condition})
            };
            // An outer INSERT OR REPLACE overrides a trigger's OR IGNORE
            // policy. Use UPDATE for subtraction so replacing a quarantined
            // identity cannot replace/reset the aggregate row itself.
            let subtract = if table == "delivery_batches" {
                "UPDATE delivery_status_counters SET pending_records=pending_records-OLD.records,pending_bytes=pending_bytes-(OLD.bytes+COALESCE(length(CAST(OLD.prepared AS BLOB)),0)) WHERE job_id=OLD.job_id AND OLD.state IN ('pending','leased','retry_wait','blocked');".to_string()
            } else {
                "UPDATE delivery_status_counters SET quarantined_records=quarantined_records-1 WHERE job_id=OLD.job_id;".to_string()
            };
            let add = delta("NEW", new, "+");
            tx.execute_batch(&format!("CREATE TRIGGER {table}_status_insert AFTER INSERT ON {table} BEGIN {add} END;
                CREATE TRIGGER {table}_status_delete AFTER DELETE ON {table} BEGIN {subtract} END;
                CREATE TRIGGER {table}_status_update AFTER UPDATE ON {table} BEGIN {subtract} {add} END;"))?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn read(conn: &Connection, job_id: &str) -> Result<(i64, i64, i64)> {
    let initialized: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_status_counters')", [], |r| r.get(0))?;
    if initialized {
        return Ok(conn.query_row("SELECT pending_records,pending_bytes,quarantined_records FROM delivery_status_counters WHERE job_id=?", [job_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.unwrap_or_default());
    }
    // Read-only presentation can run beside an older collector before this
    // build acquires ownership and installs the counters.
    let (records, bytes) = conn.query_row("SELECT COALESCE(SUM(records),0),COALESCE(SUM(bytes+COALESCE(length(CAST(prepared AS BLOB)),0)),0) FROM delivery_batches WHERE job_id=? AND state IN ('pending','leased','retry_wait','blocked')", [job_id], |r| Ok((r.get(0)?,r.get(1)?)))?;
    let quarantine: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_quarantine')", [], |r| r.get(0))?;
    let quarantined = if quarantine {
        conn.query_row(
            "SELECT COUNT(*) FROM delivery_quarantine WHERE job_id=?",
            [job_id],
            |r| r.get(0),
        )?
    } else {
        0
    };
    Ok((records, bytes, quarantined))
}

/// Explicit maintenance/recovery only; never on the status/drain hot path.
pub fn reconcile(conn: &Connection) -> Result<()> {
    // Compact remains usable before this build's collector owns/migrates a
    // legacy store. A control helper must not initialize derived baselines.
    let initialized: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_status_counters')", [], |r| r.get(0))?;
    if !initialized {
        return Ok(());
    }
    let tx = write_transaction(conn)?;
    tx.execute_batch("UPDATE delivery_status_counters SET pending_records=0,pending_bytes=0,quarantined_records=0;
        INSERT INTO delivery_status_counters(job_id,pending_records,pending_bytes)
        SELECT job_id,SUM(records),SUM(bytes+COALESCE(length(CAST(prepared AS BLOB)),0)) FROM delivery_batches
        WHERE state IN ('pending','leased','retry_wait','blocked') GROUP BY job_id
        ON CONFLICT(job_id) DO UPDATE SET pending_records=excluded.pending_records,pending_bytes=excluded.pending_bytes;
        INSERT INTO delivery_status_counters(job_id,quarantined_records)
        SELECT job_id,COUNT(*) FROM delivery_quarantine GROUP BY job_id
        ON CONFLICT(job_id) DO UPDATE SET quarantined_records=excluded.quarantined_records;")?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA recursive_triggers=ON;
            CREATE TABLE delivery_batches(seq INTEGER PRIMARY KEY, job_id TEXT, state TEXT, records INTEGER, bytes INTEGER, prepared TEXT, created_ms INTEGER);
            CREATE TABLE delivery_quarantine(job_id TEXT, parent_batch_id TEXT, revision_id TEXT, record_json TEXT, PRIMARY KEY(parent_batch_id,revision_id));").unwrap();
        conn
    }
    fn exact(conn: &Connection, job: &str) -> (i64, i64, i64) {
        let (records, bytes) = conn.query_row("SELECT COALESCE(SUM(records),0),COALESCE(SUM(bytes+COALESCE(length(CAST(prepared AS BLOB)),0)),0) FROM delivery_batches WHERE job_id=? AND state IN ('pending','leased','retry_wait','blocked')", [job], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
        let quarantine = conn
            .query_row(
                "SELECT COUNT(*) FROM delivery_quarantine WHERE job_id=?",
                [job],
                |r| r.get(0),
            )
            .unwrap();
        (records, bytes, quarantine)
    }

    #[test]
    fn upgrade_and_legacy_mutations_keep_exact_counters_and_rollback() {
        let conn = raw();
        conn.execute_batch("INSERT INTO delivery_batches VALUES(1,'a','pending',3,80,'é',10),(2,'a','acknowledged',10,50,NULL,5);
            INSERT INTO delivery_quarantine VALUES('a','parent','r1','large payload');").unwrap();
        assert_eq!(
            read(&conn, "a").unwrap(),
            (3, 82, 1),
            "legacy read before owner migration"
        );
        init(&conn).unwrap();
        assert_eq!(read(&conn, "a").unwrap(), exact(&conn, "a"));
        conn.execute_batch(
            "INSERT INTO delivery_batches VALUES(3,'a','leased',7,100,'body',15);
            UPDATE delivery_batches SET prepared='longer é body',state='retry_wait' WHERE seq=3;
            UPDATE delivery_batches SET job_id='b' WHERE seq=1;
            UPDATE delivery_quarantine SET job_id='b';
            INSERT OR REPLACE INTO delivery_quarantine VALUES('b','parent','r1','replacement');",
        )
        .unwrap();
        for job in ["a", "b", "empty"] {
            assert_eq!(read(&conn, job).unwrap(), exact(&conn, job));
        }
        conn.execute_batch("UPDATE delivery_status_counters SET quarantined_records=999;")
            .unwrap();
        reconcile(&conn).unwrap();
        for job in ["a", "b"] {
            assert_eq!(read(&conn, job).unwrap(), exact(&conn, job));
        }
        let before = read(&conn, "a").unwrap();
        conn.execute_batch(
            "BEGIN; DELETE FROM delivery_batches; DELETE FROM delivery_quarantine; ROLLBACK;",
        )
        .unwrap();
        assert_eq!(read(&conn, "a").unwrap(), before);
        conn.execute_batch(
            "UPDATE delivery_batches SET state='acknowledged'; DELETE FROM delivery_quarantine;",
        )
        .unwrap();
        assert_eq!(read(&conn, "a").unwrap(), (0, 0, 0));
        assert_eq!(read(&conn, "b").unwrap(), (0, 0, 0));
        init(&conn).unwrap();
        assert_eq!(read(&conn, "a").unwrap(), (0, 0, 0), "reopen is idempotent");
    }

    #[test]
    fn large_quarantine_has_covering_lookup_and_constant_status_work() {
        let conn = raw();
        conn.execute_batch("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<27705)
            INSERT INTO delivery_quarantine SELECT 'a','parent',CAST(x AS TEXT),printf('%08192d',x) FROM n;").unwrap();
        init(&conn).unwrap();
        assert_eq!(read(&conn, "a").unwrap(), (0, 0, 27_705));
        let plan = |sql: &str| {
            conn.prepare(sql)
                .unwrap()
                .query_map(["a"], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
                .join(" ")
        };
        assert!(
            plan("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM delivery_quarantine WHERE job_id=?")
                .contains("COVERING INDEX delivery_quarantine_job")
        );
        let mut query = conn.prepare("SELECT pending_records,pending_bytes,quarantined_records FROM delivery_status_counters WHERE job_id=?").unwrap();
        query.query_row(["a"], |r| r.get::<_, i64>(2)).unwrap();
        assert!(
            query.get_status(rusqlite::StatementStatus::VmStep) < 30,
            "counter lookup stays constant regardless of historical payloads"
        );
        conn.execute_batch("DROP INDEX delivery_quarantine_job;")
            .unwrap();
        assert!(
            plan("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM delivery_quarantine WHERE job_id=?")
                .contains("SCAN delivery_quarantine")
        );
        init(&conn).unwrap();
        assert!(
            plan("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM delivery_quarantine WHERE job_id=?")
                .contains("COVERING INDEX delivery_quarantine_job")
        );
    }
}
