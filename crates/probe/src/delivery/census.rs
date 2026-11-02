//! The session census: every session a person can select, kept as the store
//! changes, with its counts maintained by triggers. Status reads the counts
//! in constant time instead of walking every session identity the store
//! holds; only the collector, which owns the store, writes the census.
//!
//! The census follows `ai-hist`'s change feed from the position it last
//! reached. A change names the session it belongs to, and that session is
//! judged again by the same rule [`selectable_session_identities`] lists
//! with: the store holds evidence for it, no other session delegated work to
//! it, and it is not a Grok subagent. A relationship names its child too,
//! which delegation may have just made part of its parent. A delete that
//! names no session (a prompt's) or no child (a relationship's) cannot be
//! judged one session at a time, and neither can a replaced store or local
//! retention's eviction, which writes no deletes to the feed: the census is
//! then taken again from the identity walk, by the collector.
use super::*;
use ai_hist::{ChangeKind, ChangeOp, ChangeQuery, EvidenceRow, Watermark};
use std::collections::BTreeSet;

/// Changes one refresh reads at most; the next pass continues from there.
const REFRESH_CHANGES: usize = 20_000;

/// The census tables and the triggers that keep its counts. `excluded`
/// counts census sessions under a persistent user deny, so it follows writes
/// to `delivery_exclusions` by any build, as the census follows its own.
pub(super) fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS delivery_session_census (
            source TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(source,session_id)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS delivery_session_census_state (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL,
            revision INTEGER NOT NULL, retention_generation INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0
        );
        CREATE TRIGGER IF NOT EXISTS delivery_session_census_added AFTER INSERT ON delivery_session_census BEGIN
            UPDATE delivery_session_census_state SET total=total+1,
                excluded=excluded+EXISTS(SELECT 1 FROM delivery_exclusions e WHERE e.source=NEW.source AND e.session_id=NEW.session_id);
        END;
        CREATE TRIGGER IF NOT EXISTS delivery_session_census_removed AFTER DELETE ON delivery_session_census BEGIN
            UPDATE delivery_session_census_state SET total=total-1,
                excluded=excluded-EXISTS(SELECT 1 FROM delivery_exclusions e WHERE e.source=OLD.source AND e.session_id=OLD.session_id);
        END;
        CREATE TRIGGER IF NOT EXISTS delivery_session_census_excluded AFTER INSERT ON delivery_exclusions BEGIN
            UPDATE delivery_session_census_state SET
                excluded=excluded+EXISTS(SELECT 1 FROM delivery_session_census c WHERE c.source=NEW.source AND c.session_id=NEW.session_id);
        END;
        CREATE TRIGGER IF NOT EXISTS delivery_session_census_included AFTER DELETE ON delivery_exclusions BEGIN
            UPDATE delivery_session_census_state SET
                excluded=excluded-EXISTS(SELECT 1 FROM delivery_session_census c WHERE c.source=OLD.source AND c.session_id=OLD.session_id);
        END;",
    )?;
    Ok(())
}

/// What a refresh did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CensusRefresh {
    /// Nothing changed since the census's position.
    Current,
    /// Changes were read and the sessions they name judged again.
    Followed { changes: usize, judged: usize },
    /// The census was taken again from the identity walk.
    Taken { sessions: usize },
}

/// Brings the census up to the store's change feed. Only the collector, which
/// holds the store, calls this; a reader never walks identities.
pub fn refresh(conn: &Connection) -> Result<CensusRefresh> {
    init(conn)?;
    let store = feed::store(conn)?;
    let head = store.head_revision()?;
    // Local retention evicts history without writing deletes to the feed:
    // a new generation is followed by counting again.
    let retention = store.retention_generation()?;
    let Some((position, counted)) = position(conn)? else {
        return take(conn, head, retention);
    };
    if position.epoch != head.epoch || position.revision > head.revision || counted != retention {
        return take(conn, head, retention);
    }
    if position == head {
        return Ok(CensusRefresh::Current);
    }
    let Some(followed) = follow(&store, position)? else {
        return take(conn, head, retention);
    };
    let judged = followed
        .touched
        .into_iter()
        .map(|(source, session_id)| {
            let identity = SessionIdentity { source, session_id };
            let selectable = selectable(conn, &identity)?;
            Ok((identity, selectable))
        })
        .collect::<Result<Vec<_>>>()?;
    record(conn, &judged, followed.reached)?;
    Ok(CensusRefresh::Followed {
        changes: followed.changes,
        judged: judged.len(),
    })
}

/// Where the census stands in the change feed, and the retention generation
/// it counted, once taken.
fn position(conn: &Connection) -> Result<Option<(Watermark, u64)>> {
    Ok(conn
        .query_row(
            "SELECT epoch,revision,retention_generation FROM delivery_session_census_state WHERE singleton=1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
        )
        .optional()?
        .map(|(epoch, revision, generation)| {
            let position = Watermark {
                revision: revision as u64,
                epoch: epoch as u64,
            };
            (position, generation as u64)
        }))
}

/// The changes after a position: the sessions they name and how far they
/// reach.
struct Followed {
    touched: BTreeSet<(String, String)>,
    reached: u64,
    changes: usize,
}

/// The sessions the changes after `position` name, or `None` when one of
/// them cannot be judged a session at a time, or the feed cannot resume from
/// `position` (an epoch it retired, a kind it no longer names).
fn follow(store: &ai_hist::SessionStore, position: Watermark) -> Result<Option<Followed>> {
    let Ok(drained) = store.changes_since(position, ChangeQuery::default().batch(1_000)) else {
        return Ok(None);
    };
    let mut followed = Followed {
        touched: BTreeSet::new(),
        reached: position.revision,
        changes: 0,
    };
    for change in drained.take(REFRESH_CHANGES) {
        let change = change?;
        let Some(named) = named(&change) else {
            return Ok(None);
        };
        followed.changes += 1;
        followed.reached = followed.reached.max(change.revision);
        followed.touched.extend(named);
    }
    Ok(Some(followed))
}

/// The sessions one change names: its own, and a relationship's child.
/// `None` for a delete that names no session or child (a prompt's, a
/// relationship's), or an operation this build does not know.
fn named(change: &ai_hist::Change) -> Option<Vec<(String, String)>> {
    let source = &change.source_name;
    let mut named = Vec::new();
    match &change.op {
        ChangeOp::Upsert(row) => {
            if let EvidenceRow::Relationship(relationship) = row.as_ref() {
                named.extend(
                    relationship
                        .child_session_id
                        .iter()
                        .filter(|child| !child.is_empty())
                        .map(|child| (source.clone(), child.clone())),
                );
            }
        }
        ChangeOp::Delete
            if change.kind != ChangeKind::Relationship && !change.session_id.is_empty() => {}
        _ => return None,
    }
    if !source.is_empty() && !change.session_id.is_empty() {
        named.push((source.clone(), change.session_id.clone()));
    }
    Some(named)
}

/// Writes what was judged and the position it reaches, in one transaction.
fn record(conn: &Connection, judged: &[(SessionIdentity, bool)], reached: u64) -> Result<()> {
    let tx = write_transaction(conn)?;
    for (identity, selectable) in judged {
        let sql = if *selectable {
            "INSERT OR IGNORE INTO delivery_session_census(source,session_id) VALUES (?,?)"
        } else {
            "DELETE FROM delivery_session_census WHERE source=? AND session_id=?"
        };
        tx.execute(sql, params![identity.source, identity.session_id])?;
    }
    tx.execute(
        "UPDATE delivery_session_census_state SET revision=? WHERE singleton=1",
        [feed::revision(reached)?],
    )?;
    tx.commit()?;
    Ok(())
}

/// The sessions a person can select: [`session_identities`] without the
/// subagents and child threads that are part of another session.
pub fn selectable_session_identities(conn: &Connection) -> Result<Vec<SessionIdentity>> {
    let store = feed::store(conn)?;
    let mut identities = Vec::new();
    let mut query = ai_hist::IdentityQuery::default()
        .limit(10_000)
        .exclude_delegated();
    loop {
        let page = store.session_identities(query.clone())?;
        let Some(last) = page.last().cloned() else {
            break;
        };
        identities.extend(page.into_iter().map(|identity| SessionIdentity {
            source: identity.source_name,
            session_id: identity.session_id,
        }));
        query = query.after(last);
    }
    Ok(identities)
}
/// Whether a person can select `identity`, by the rule the identity walk
/// lists with.
pub fn selectable(conn: &Connection, identity: &SessionIdentity) -> Result<bool> {
    Ok(has_session(conn, identity)?
        && delegating_session(conn, identity)?.is_none()
        && !native_grok_subagent(conn, identity)?)
}

/// Takes the census again from the identity walk, positioned at `head` and
/// the `retention` generation, both read before the walk: a change written
/// during it is judged again by the next refresh.
fn take(conn: &Connection, head: Watermark, retention: u64) -> Result<CensusRefresh> {
    let sessions = selectable_session_identities(conn)?;
    let tx = write_transaction(conn)?;
    // The state row goes first, so clearing the census moves no count; the
    // inserts then count every session afresh.
    tx.execute_batch(
        "DELETE FROM delivery_session_census_state; DELETE FROM delivery_session_census;",
    )?;
    tx.execute(
        "INSERT INTO delivery_session_census_state(singleton,epoch,revision,retention_generation,total,excluded) VALUES (1,?,?,?,0,0)",
        // The epoch is a random 64-bit identity, kept bit for bit.
        params![head.epoch as i64, feed::revision(head.revision)?, retention as i64],
    )?;
    {
        let mut insert = tx.prepare(
            "INSERT OR IGNORE INTO delivery_session_census(source,session_id) VALUES (?,?)",
        )?;
        for identity in &sessions {
            insert.execute(params![identity.source, identity.session_id])?;
        }
    }
    tx.commit()?;
    Ok(CensusRefresh::Taken {
        sessions: sessions.len(),
    })
}

/// Whether what a session list shows of the catalog (its rows, presences
/// and relationships) changed after `seen`, and the feed position now. A
/// first look, with nothing seen, is no change. One indexed seek per kind:
/// the changes themselves are not read.
pub fn catalog_changed(conn: &Connection, seen: Option<Watermark>) -> Result<(bool, Watermark)> {
    let store = feed::store(conn)?;
    let head = store.head_revision()?;
    let Some(seen) = seen.filter(|seen| seen.epoch == head.epoch && seen.revision <= head.revision)
    else {
        return Ok((seen.is_some(), head));
    };
    if seen == head {
        return Ok((false, head));
    }
    let changed = store
        .changes_since(
            seen,
            ChangeQuery::default()
                .kinds([
                    ChangeKind::Session,
                    ChangeKind::Presence,
                    ChangeKind::Relationship,
                ])
                .batch(1),
        )?
        .next()
        .transpose()?
        .is_some_and(|change| change.revision <= head.revision);
    Ok((changed, head))
}

/// The sessions a person can select, and how many of them `job_id` shares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SessionCounts {
    pub total: i64,
    pub shared: i64,
    pub excluded: i64,
}

/// The census's counts for `job_id`, or `None` before the collector first
/// took it. Constant time for an all-sources job; a selected-sessions job
/// reads its own members.
pub fn counts(conn: &Connection, job_id: &str) -> Result<Option<SessionCounts>> {
    let taken: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_session_census_state')",
        [],
        |r| r.get(0),
    )?;
    if !taken {
        return Ok(None);
    }
    let Some((total, excluded)) = conn
        .query_row(
            "SELECT total,excluded FROM delivery_session_census_state WHERE singleton=1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let shared = if is_session_job(conn, job_id)? {
        conn.query_row(
            "SELECT COUNT(*) FROM delivery_session_members m
             JOIN delivery_session_census c ON c.source=m.source AND c.session_id=m.session_id
             WHERE m.job_id=? AND NOT EXISTS(
                SELECT 1 FROM delivery_exclusions e WHERE e.source=m.source AND e.session_id=m.session_id)",
            [job_id],
            |r| r.get(0),
        )?
    } else {
        total - excluded
    };
    Ok(Some(SessionCounts {
        total,
        shared,
        excluded: total - shared,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Connection) {
        let directory = tempfile::tempdir().unwrap();
        let conn = open_db(&directory.path().join("history.db")).unwrap();
        (directory, conn)
    }

    fn identity(key: &str) -> SessionIdentity {
        let (source, session_id) = key.split_once(':').unwrap();
        SessionIdentity {
            source: source.into(),
            session_id: session_id.into(),
        }
    }

    fn capture(conn: &Connection, key: &str) {
        let identity = identity(key);
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES (?,?)",
            params![identity.source, identity.session_id],
        )
        .unwrap();
    }

    fn delegate(conn: &Connection, parent: &str, child: &str) {
        conn.execute(
            "INSERT INTO session_relationships(source,parent_session_id,relationship_uid,child_session_id,
                relationship,identity_status,evidence_kind,created_ms,updated_ms)
             VALUES ('codex',?,?,?,'delegated','observed','test',1,1)",
            params![parent, format!("{parent}->{child}"), child],
        )
        .unwrap();
    }

    fn job(conn: &Connection) -> String {
        create_job(conn, &job_config(), 1).unwrap().job_id
    }

    fn job_config() -> DeliveryJobConfig {
        DeliveryJobConfig {
            destination_id: "fixture".into(),
            instance_id: "census".into(),
            account_id: "fixture-account".into(),
            mapping_version: "1".into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["session".into()],
                ..ExportSelection::default()
            },
            limits: DeliveryLimits::default(),
        }
    }

    /// The counts the identity walk gives: what status reported before the
    /// census, and what the census must keep agreeing with.
    fn walked(conn: &Connection, job_id: &str) -> SessionCounts {
        let rows = selectable_session_identities(conn).unwrap();
        let scoped = is_session_job(conn, job_id).unwrap();
        let members: HashSet<_> = job_sessions(conn, job_id).unwrap().into_iter().collect();
        let shared = rows
            .iter()
            .filter(|row| {
                !is_explicitly_excluded(conn, row).unwrap() && (!scoped || members.contains(*row))
            })
            .count() as i64;
        SessionCounts {
            total: rows.len() as i64,
            shared,
            excluded: rows.len() as i64 - shared,
        }
    }

    fn agrees(conn: &Connection, job_id: &str) {
        assert_eq!(
            counts(conn, job_id).unwrap(),
            Some(walked(conn, job_id)),
            "the census disagrees with the identity walk"
        );
    }

    #[test]
    fn nothing_is_counted_before_the_collector_takes_the_census() {
        let (_directory, conn) = store();
        let job_id = job(&conn);
        capture(&conn, "codex:a");
        assert_eq!(counts(&conn, &job_id).unwrap(), None);
        assert_eq!(
            refresh(&conn).unwrap(),
            CensusRefresh::Taken { sessions: 1 }
        );
        agrees(&conn, &job_id);
        assert_eq!(refresh(&conn).unwrap(), CensusRefresh::Current);
    }

    #[test]
    fn captures_and_exclusions_keep_the_counts_without_a_walk() {
        let (_directory, conn) = store();
        let job_id = job(&conn);
        capture(&conn, "codex:a");
        capture(&conn, "claude:b");
        refresh(&conn).unwrap();
        capture(&conn, "codex:c");
        conn.execute(
            "INSERT INTO history(source,session_id,prompt,timestamp_ms) VALUES ('claude','prompt-only','hello',5)",
            [],
        )
        .unwrap();
        assert!(matches!(
            refresh(&conn).unwrap(),
            CensusRefresh::Followed { judged: 2, .. }
        ));
        agrees(&conn, &job_id);
        assert_eq!(counts(&conn, &job_id).unwrap().unwrap().total, 4);
        // Exclusions move the counts through their triggers alone, whoever
        // writes them, including a session the census does not hold.
        set_session_excluded(&conn, &identity("codex:a"), true).unwrap();
        set_session_excluded(&conn, &identity("codex:unknown"), true).unwrap();
        agrees(&conn, &job_id);
        assert_eq!(
            counts(&conn, &job_id).unwrap(),
            Some(SessionCounts {
                total: 4,
                shared: 3,
                excluded: 1
            })
        );
        conn.execute(
            "DELETE FROM delivery_exclusions WHERE source='codex' AND session_id='a'",
            [],
        )
        .unwrap();
        agrees(&conn, &job_id);
        // A session excluded before it is captured counts as excluded once
        // it is.
        capture(&conn, "codex:unknown");
        refresh(&conn).unwrap();
        agrees(&conn, &job_id);
        assert_eq!(counts(&conn, &job_id).unwrap().unwrap().excluded, 1);
    }

    #[test]
    fn delegation_and_deletes_are_judged_again() {
        let (_directory, conn) = store();
        let job_id = job(&conn);
        capture(&conn, "codex:parent");
        capture(&conn, "codex:child");
        capture(&conn, "codex:gone");
        refresh(&conn).unwrap();
        assert_eq!(counts(&conn, &job_id).unwrap().unwrap().total, 3);
        // A relationship names its child: delegation makes it part of the
        // parent.
        delegate(&conn, "parent", "child");
        conn.execute(
            "DELETE FROM sessions WHERE source='codex' AND session_id='gone'",
            [],
        )
        .unwrap();
        assert!(matches!(
            refresh(&conn).unwrap(),
            CensusRefresh::Followed { .. }
        ));
        agrees(&conn, &job_id);
        assert_eq!(counts(&conn, &job_id).unwrap().unwrap().total, 1);
        // A relationship's delete no longer names its child: the census is
        // taken again, and the child counts once more.
        conn.execute("DELETE FROM session_relationships", [])
            .unwrap();
        assert_eq!(
            refresh(&conn).unwrap(),
            CensusRefresh::Taken { sessions: 2 }
        );
        agrees(&conn, &job_id);
    }

    #[test]
    fn a_prompt_delete_names_no_session_so_the_census_is_taken_again() {
        let (_directory, conn) = store();
        let job_id = job(&conn);
        conn.execute(
            "INSERT INTO history(source,session_id,prompt,timestamp_ms) VALUES ('claude','prompt-only','hello',5)",
            [],
        )
        .unwrap();
        refresh(&conn).unwrap();
        assert_eq!(counts(&conn, &job_id).unwrap().unwrap().total, 1);
        conn.execute("DELETE FROM history", []).unwrap();
        assert_eq!(
            refresh(&conn).unwrap(),
            CensusRefresh::Taken { sessions: 0 }
        );
        agrees(&conn, &job_id);
    }

    #[test]
    fn a_selected_sessions_job_shares_its_members_alone() {
        let (_directory, conn) = store();
        let config = job_config();
        let job_id = create_session_job(&conn, &config, 1).unwrap().job_id;
        capture(&conn, "codex:picked");
        capture(&conn, "codex:other");
        capture(&conn, "codex:withheld");
        refresh(&conn).unwrap();
        set_job_session(&conn, &job_id, &identity("codex:picked"), true).unwrap();
        set_job_session(&conn, &job_id, &identity("codex:withheld"), true).unwrap();
        // A member the store does not hold is not a session to count.
        set_job_session(&conn, &job_id, &identity("codex:not-captured"), true).unwrap();
        set_session_excluded(&conn, &identity("codex:withheld"), true).unwrap();
        agrees(&conn, &job_id);
        assert_eq!(
            counts(&conn, &job_id).unwrap(),
            Some(SessionCounts {
                total: 3,
                shared: 1,
                excluded: 2
            })
        );
    }

    #[test]
    fn sessions_retention_evicts_leave_the_counts() {
        use ai_hist::retention::{RetentionOptions, RetentionPolicy};
        let (directory, conn) = store();
        let job_id = job(&conn);
        let fresh = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        conn.execute(
            "INSERT INTO sessions(source,session_id,last_activity_ms,discovery_state) VALUES ('codex','expired',1,'full'),('codex','recent',?,'full')",
            [fresh],
        )
        .unwrap();
        refresh(&conn).unwrap();
        assert_eq!(counts(&conn, &job_id).unwrap().unwrap().total, 2);
        let mut options = ai_hist::StoreOptions::default();
        options.db_path = Some(directory.path().join("history.db"));
        let history = ai_hist::SessionStore::open(options).unwrap();
        history
            .set_retention_policy(RetentionPolicy::from_days(7))
            .unwrap();
        history.register_retention_consumer("census-test").unwrap();
        history
            .acknowledge_retention("census-test", history.head_revision().unwrap())
            .unwrap();
        let evict = RetentionOptions {
            max_rows: 1024,
            min_interval_ms: 0,
            allow_unuploaded: false,
        };
        while !history.prune_expired(evict.clone()).unwrap().cycle_complete {}
        assert_eq!(
            refresh(&conn).unwrap(),
            CensusRefresh::Taken { sessions: 1 },
            "an eviction the feed does not record is counted again"
        );
        agrees(&conn, &job_id);
        assert_eq!(refresh(&conn).unwrap(), CensusRefresh::Current);
    }

    #[test]
    fn a_replaced_store_is_counted_afresh() {
        let (_directory, conn) = store();
        let job_id = job(&conn);
        capture(&conn, "codex:a");
        refresh(&conn).unwrap();
        // A position ahead of the store's head is another store's.
        conn.execute(
            "UPDATE delivery_session_census_state SET revision=revision+1000",
            [],
        )
        .unwrap();
        assert_eq!(
            refresh(&conn).unwrap(),
            CensusRefresh::Taken { sessions: 1 }
        );
        agrees(&conn, &job_id);
    }
}
