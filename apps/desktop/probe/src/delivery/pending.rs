//! Session identities in unresolved batches. Payloads are parsed once when a
//! batch is persisted, rather than for every page of upload indicators.
use super::*;

const ACTIVE: &str = "state IN ('pending','leased','retry_wait','blocked')";

fn project(row: &str, predicate: &str) -> String {
    format!("INSERT OR IGNORE INTO delivery_pending_sessions(batch_seq,job_id,source,session_id)
        SELECT {row}.seq,{row}.job_id,json_extract(r.value,'$.source'),json_extract(r.value,'$.session_id')
        FROM json_each({row}.payload,'$.records') r WHERE {predicate} AND json_type(r.value,'$.session_id')='text'
        UNION
        SELECT {row}.seq,{row}.job_id,json_extract(r.value,'$.source'),json_extract(r.value,'$.payload.child_session_id')
        FROM json_each({row}.payload,'$.records') r WHERE {predicate} AND json_extract(r.value,'$.kind')='relationship' AND json_type(r.value,'$.payload.child_session_id')='text';")
}

pub(super) fn init(conn: &Connection) -> Result<()> {
    let tx = write_transaction(conn)?;
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_pending_sessions')", [], |r| r.get(0))?;
    if !exists {
        tx.execute_batch("CREATE TABLE delivery_pending_sessions (
            batch_seq INTEGER NOT NULL, job_id TEXT NOT NULL, source TEXT NOT NULL, session_id TEXT NOT NULL,
            PRIMARY KEY(batch_seq,source,session_id));
            CREATE INDEX delivery_pending_session_lookup ON delivery_pending_sessions(job_id,source,session_id,batch_seq);")?;
        // One atomic baseline handles pending batches retained by older builds.
        let seed = project("b", &format!("b.{ACTIVE}"));
        tx.execute_batch(&seed.replace(
            "FROM json_each(b.payload",
            "FROM delivery_batches b, json_each(b.payload",
        ))?;
        let add = project("NEW", &format!("NEW.{ACTIVE}"));
        tx.execute_batch(&format!("CREATE TRIGGER delivery_pending_sessions_insert AFTER INSERT ON delivery_batches BEGIN {add} END;
            CREATE TRIGGER delivery_pending_sessions_delete AFTER DELETE ON delivery_batches BEGIN DELETE FROM delivery_pending_sessions WHERE batch_seq=OLD.seq; END;
            CREATE TRIGGER delivery_pending_sessions_update AFTER UPDATE OF payload,job_id,state ON delivery_batches
            WHEN OLD.payload IS NOT NEW.payload OR OLD.job_id IS NOT NEW.job_id OR (OLD.{ACTIVE}) <> (NEW.{ACTIVE})
            BEGIN DELETE FROM delivery_pending_sessions WHERE batch_seq=OLD.seq; {add} END;"))?;
    }
    tx.commit()?;
    Ok(())
}

pub fn read(
    conn: &Connection,
    job_id: &str,
    sessions: &[SessionIdentity],
) -> Result<std::collections::HashMap<SessionIdentity, bool>> {
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_pending_sessions')", [], |r| r.get(0))?;
    ensure!(exists, UpgradePending);
    let mut query = conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM delivery_pending_sessions p JOIN delivery_batches b ON b.seq=p.batch_seq WHERE p.job_id=?1 AND p.source=?2 AND p.session_id=?3), EXISTS(SELECT 1 FROM delivery_pending_sessions p JOIN delivery_batches b ON b.seq=p.batch_seq WHERE p.job_id=?1 AND p.source=?2 AND p.session_id=?3 AND b.state='leased')")?;
    let mut pending = std::collections::HashMap::new();
    for identity in sessions {
        let (exists, leased): (bool, bool) = query
            .query_row(params![job_id, identity.source, identity.session_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        if exists {
            pending.insert(identity.clone(), leased);
        }
    }
    Ok(pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_identifiers_require_json_strings_like_record_scope() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE delivery_batches(seq INTEGER PRIMARY KEY,job_id TEXT,state TEXT,payload TEXT);").unwrap();
        init(&conn).unwrap();
        let parent = SessionIdentity {
            source: "codex".into(),
            session_id: "parent".into(),
        };
        for child in [
            serde_json::json!(7),
            serde_json::json!(true),
            serde_json::json!({"id":"child"}),
            serde_json::json!(["child"]),
            serde_json::Value::Null,
        ] {
            let payload = serde_json::json!({"records":[{"source":"codex","session_id":"parent","kind":"relationship","payload":{"child_session_id":child}}]}).to_string();
            conn.execute("INSERT INTO delivery_batches VALUES(1,'job','pending',?) ON CONFLICT(seq) DO UPDATE SET payload=excluded.payload",[payload]).unwrap();
            let candidate = SessionIdentity {
                source: "codex".into(),
                session_id: child.to_string(),
            };
            let pending = read(&conn, "job", &[parent.clone(), candidate]).unwrap();
            assert_eq!(
                pending.len(),
                1,
                "nonstring child {child} must not become an identity"
            );
            assert!(pending.contains_key(&parent));
        }
        conn.execute("UPDATE delivery_batches SET payload=?",[serde_json::json!({"records":[{"source":"codex","session_id":"parent","kind":"relationship","payload":{"child_session_id":"7"}}]}).to_string()]).unwrap();
        let child = SessionIdentity {
            source: "codex".into(),
            session_id: "7".into(),
        };
        assert_eq!(read(&conn, "job", &[parent, child]).unwrap().len(), 2);
    }

    #[test]
    fn pending_projection_tracks_relationships_updates_and_rollback_without_payload_reads() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA recursive_triggers=ON;
            CREATE TABLE delivery_batches(seq INTEGER PRIMARY KEY,job_id TEXT,state TEXT,payload TEXT);
            INSERT INTO delivery_batches VALUES(1,'job','pending','{\"records\":[{\"source\":\"codex\",\"session_id\":\"parent\",\"kind\":\"relationship\",\"payload\":{\"child_session_id\":\"child\"}}]}');").unwrap();
        init(&conn).unwrap();
        let ids: Vec<_> = ["parent", "child", "unrelated"]
            .into_iter()
            .map(|session_id| SessionIdentity {
                source: "codex".into(),
                session_id: session_id.into(),
            })
            .collect();
        let pending = read(&conn, "job", &ids).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[&ids[0]], false);
        assert_eq!(pending[&ids[1]], false);
        conn.execute_batch("BEGIN; UPDATE delivery_batches SET state='acknowledged'; ROLLBACK;")
            .unwrap();
        assert_eq!(read(&conn, "job", &ids).unwrap().len(), 2);
        conn.execute_batch("UPDATE delivery_batches SET state='leased';")
            .unwrap();
        assert!(read(&conn, "job", &ids).unwrap()[&ids[1]]);
        conn.execute_batch("UPDATE delivery_batches SET payload='{\"records\":[{\"source\":\"codex\",\"session_id\":\"unrelated\"}]}';").unwrap();
        assert_eq!(
            read(&conn, "job", &ids)
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec![ids[2].clone()]
        );
        conn.execute_batch("UPDATE delivery_batches SET state='acknowledged';")
            .unwrap();
        assert!(read(&conn, "job", &ids).unwrap().is_empty());
        conn.execute_batch(
            "UPDATE delivery_batches SET state='retry_wait'; DELETE FROM delivery_batches;",
        )
        .unwrap();
        assert!(read(&conn, "job", &ids).unwrap().is_empty());
        // A payload is only needed at persistence/migration. Poisoning a
        // retained payload after that cannot affect indexed status reads.
        conn.execute_batch("INSERT INTO delivery_batches VALUES(2,'job','pending','{\"records\":[{\"source\":\"codex\",\"session_id\":\"parent\"}]}');
            DROP TRIGGER delivery_pending_sessions_update;
            UPDATE delivery_batches SET payload='malformed retained payload';").unwrap();
        for _ in 0..10 {
            assert_eq!(read(&conn, "job", &ids).unwrap().len(), 1);
        }
        let plan = conn.prepare("EXPLAIN QUERY PLAN SELECT batch_seq FROM delivery_pending_sessions WHERE job_id=? AND source=? AND session_id=?").unwrap()
            .query_map(params!["job","codex","parent"], |r| r.get::<_,String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join(" ");
        assert!(plan.contains("COVERING INDEX delivery_pending_session_lookup"));
    }
}
