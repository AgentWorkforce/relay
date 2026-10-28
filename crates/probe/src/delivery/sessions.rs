//! Normalized, incremental session membership. The job follows the feed for
//! its members; each member added is backfilled with a drain of its own
//! session from the feed's start to the head at the time it was added. The
//! destination job still owns batches, fences and leases.
//!
//! A member row's `cutoff` is that head, `cursor` the backfill's position and
//! `bootstrap_done` whether the backfill has reached `cutoff`. A relationship
//! is stored under its parent, so a member's backfill has two phases: its own
//! session, then (when the job selects relationships) the edges that name it
//! as their child, which a parent included earlier could not send. The job's own
//! `journal_cursor` follows the feed for every member above its `cutoff`.
//!
//! Each feed change has at most one path that sends it under one membership:
//! a member's own-changes phase up to its cutoff, the child's incoming-edges
//! phase for an edge [`sender`] gives the child, or the feed above every
//! cutoff it names. Every path's position advances in the same transaction
//! that stores the batch holding what it passed, so a job may hold a window
//! of unresolved batches and none of them repeats a change another holds.
//! A membership change moves those paths while earlier batches are still
//! unresolved; until they resolve, a preparation skips every revision they
//! hold. `membership_seq` is the job's highest batch `seq` at the last such
//! change, and a batch at or before it in claim order holds records prepared
//! under an earlier membership.
use super::*;
use ai_hist::{ChangeKind, ChangeQuery, SessionQuery, SessionRef, SessionStore, Source};

/// Create an initially empty, deny-by-default session job. The configuration
/// describes allowed kinds; membership is changed only through `set_job_session`.
/// Its configuration and destination generation remain immutable.
pub fn create_session_job(
    conn: &Connection,
    config: &DeliveryJobConfig,
    now_ms: i64,
) -> Result<DeliveryStatus> {
    ensure!(
        config.selection.all_sources
            && config.selection.sources.is_empty()
            && config.selection.sessions.is_empty(),
        "session jobs require an all-sources kind policy and normalized membership"
    );
    create_job_inner(conn, config, now_ms, true)
}
pub fn is_session_job(conn: &Connection, job_id: &str) -> Result<bool> {
    // A read-only command can be the first to open an install created before
    // session jobs existed; it reads that install's jobs as all-sources jobs.
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='delivery_session_jobs')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(false);
    }
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_session_jobs WHERE job_id=?)",
        [job_id],
        |r| r.get(0),
    )?)
}
/// The sessions a person selected: every member but the delegated children
/// that are members as part of one of them.
pub fn job_selected_sessions(conn: &Connection, job_id: &str) -> Result<Vec<SessionIdentity>> {
    Ok(conn
        .prepare(
            "SELECT source,session_id FROM delivery_session_members \
             WHERE job_id=? AND delegated=0 ORDER BY source,session_id",
        )?
        .query_map([job_id], |r| {
            Ok(SessionIdentity {
                source: r.get(0)?,
                session_id: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// The session `session` is part of, when it is a subagent or child thread
/// another session delegated work to; `None` for a session of its own.
pub fn delegating_session(
    conn: &Connection,
    session: &SessionIdentity,
) -> Result<Option<SessionIdentity>> {
    let parents = feed::store(conn)?.delegated_by(&ai_hist::SessionIdentity::new(
        session.source.as_str(),
        session.session_id.as_str(),
    ))?;
    Ok(parents.into_iter().next().map(|parent| SessionIdentity {
        source: parent.source_name,
        session_id: parent.session_id,
    }))
}

/// Grok records a subagent's kind even when it records no parent edge. Such
/// a session is absent from the desktop catalog and must not remain an
/// independently selected upload member.
pub fn native_grok_subagent(conn: &Connection, session: &SessionIdentity) -> Result<bool> {
    if session.source != "grok" {
        return Ok(false);
    }
    let mut query = SessionQuery::default();
    query.include_text = false;
    query.kinds = Some(Vec::new());
    Ok(feed::store(conn)?
        .session(&SessionRef::id(Source::Grok, &session.session_id), query)?
        .is_some_and(|evidence| evidence.session.session_kind.as_deref() == Some("subagent")))
}

/// A subagent or child thread is part of the session that delegated work to
/// it: it is shared with that session and never selected apart from it.
fn ensure_selectable(conn: &Connection, session: &SessionIdentity) -> Result<()> {
    if let Some(parent) = delegating_session(conn, session)? {
        anyhow::bail!(
            "{}:{} is part of {}:{}; select that session instead",
            session.source,
            session.session_id,
            parent.source,
            parent.session_id
        );
    }
    ensure!(
        !native_grok_subagent(conn, session)?,
        "{}:{} is a Grok subagent and cannot be selected on its own",
        session.source,
        session.session_id
    );
    Ok(())
}

/// What a job's delegated members should be for a selection, read from the
/// store before the write transaction that applies it.
struct Delegation {
    /// The delegated descendants of the selected sessions.
    wanted: HashSet<SessionIdentity>,
    /// Selected sessions that are themselves a subagent of another session:
    /// selected before they were known to be one.
    subagents: HashSet<SessionIdentity>,
}
impl Delegation {
    fn of(conn: &Connection, selected: &[SessionIdentity]) -> Result<Self> {
        if selected.is_empty() {
            return Ok(Self {
                wanted: HashSet::new(),
                subagents: HashSet::new(),
            });
        }
        let store = feed::store(conn)?;
        let descendants = |roots: &[&SessionIdentity]| -> Result<HashSet<SessionIdentity>> {
            let roots: Vec<ai_hist::SessionIdentity> = roots
                .iter()
                .map(|member| {
                    ai_hist::SessionIdentity::new(
                        member.source.as_str(),
                        member.session_id.as_str(),
                    )
                })
                .collect();
            Ok(store
                .delegated_descendants(&roots)?
                .into_iter()
                .map(|identity| SessionIdentity {
                    source: identity.source_name,
                    session_id: identity.session_id,
                })
                .collect())
        };
        let mut subagents = HashSet::new();
        for member in selected {
            if delegating_session(conn, member)?.is_some() || native_grok_subagent(conn, member)? {
                subagents.insert(member.clone());
            }
        }
        // Only sessions of their own are roots. A selected subagent that one
        // of them reaches is in their descendants, with everything below it;
        // one none reaches is leaving the job, so nothing it delegated may
        // come in through it, nor through another such subagent.
        let roots: Vec<&SessionIdentity> = selected
            .iter()
            .filter(|member| !subagents.contains(*member))
            .collect();
        let wanted = descendants(&roots)?;
        Ok(Self { wanted, subagents })
    }

    /// Bring the job's members in line, inside the caller's transaction:
    /// every wanted descendant a member as part of its session (backfilled
    /// from the feed's start, its exclusion lifted as an inclusion lifts
    /// one), and every delegated member no selected session reaches any more
    /// removed and fenced. A subagent selected on its own comes and goes with
    /// its session once known: it becomes delegated while its session is
    /// selected, and is removed while it is not. A session of its own that is
    /// also part of a selected one (the local transcript of a remote session)
    /// keeps its own selection. Returns whether membership changed.
    fn apply(&self, tx: &Connection, job_id: &str, head: u64) -> Result<bool> {
        let members: HashMap<SessionIdentity, bool> = tx
            .prepare(
                "SELECT source,session_id,delegated FROM delivery_session_members WHERE job_id=?",
            )?
            .query_map([job_id], |r| {
                Ok((
                    SessionIdentity {
                        source: r.get(0)?,
                        session_id: r.get(1)?,
                    },
                    r.get::<_, bool>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mark = |identity: &SessionIdentity| -> Result<()> {
            tx.execute(
                "UPDATE delivery_session_members SET delegated=1 WHERE job_id=? AND source=? AND session_id=?",
                params![job_id, identity.source, identity.session_id],
            )?;
            Ok(())
        };
        let mut changed = false;
        for identity in &self.wanted {
            match members.get(identity) {
                Some(true) => {}
                Some(false) if self.subagents.contains(identity) => mark(identity)?,
                Some(false) => {}
                None => {
                    set_session_excluded_in_transaction(tx, identity, false, Some(job_id))?;
                    set_job_session_in_transaction(tx, job_id, identity, true, head)?;
                    mark(identity)?;
                    changed = true;
                }
            }
        }
        for (identity, delegated) in &members {
            let orphaned = if *delegated {
                !self.wanted.contains(identity)
            } else {
                self.subagents.contains(identity) && !self.wanted.contains(identity)
            };
            if orphaned {
                changed |= set_job_session_in_transaction(tx, job_id, identity, false, head)?;
            }
        }
        Ok(changed)
    }
}

/// Bring the job's delegated members in line with its selection: each
/// selected session's subagents and child threads are members as part of it.
/// See [`Delegation::apply`]. Returns whether membership changed.
pub fn sync_delegated_members(conn: &Connection, job_id: &str) -> Result<bool> {
    let delegation = Delegation::of(conn, &job_selected_sessions(conn, job_id)?)?;
    let tx = write_transaction(conn)?;
    let head = feed::head(conn)?.revision;
    let changed = delegation.apply(&tx, job_id, head)?;
    tx.commit()?;
    Ok(changed)
}

/// A session selected explicitly is selected in its own right, even when it
/// is already a member as part of a selected session (the local transcript of
/// a remote one): it stays selected, and is hydrated on its own, whatever its
/// parent's selection does. Returns whether the member changed.
fn select_in_own_right(tx: &Connection, job_id: &str, session: &SessionIdentity) -> Result<bool> {
    Ok(tx.execute(
        "UPDATE delivery_session_members SET delegated=0 WHERE job_id=? AND source=? AND session_id=? AND delegated=1",
        params![job_id, session.source, session.session_id],
    )? > 0)
}

/// The job's selection once `session` is included or removed.
fn selection_after(
    conn: &Connection,
    job_id: &str,
    session: &SessionIdentity,
    include: bool,
) -> Result<Vec<SessionIdentity>> {
    let mut selected = job_selected_sessions(conn, job_id)?;
    selected.retain(|member| member != session);
    if include {
        selected.push(session.clone());
    }
    Ok(selected)
}

/// The members that are in the job as part of a selected session.
pub fn job_delegated_sessions(conn: &Connection, job_id: &str) -> Result<HashSet<SessionIdentity>> {
    Ok(conn
        .prepare(
            "SELECT source,session_id FROM delivery_session_members WHERE job_id=? AND delegated=1",
        )?
        .query_map([job_id], |r| {
            Ok(SessionIdentity {
                source: r.get(0)?,
                session_id: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Read the explicit members; unrelated catalog identities are never visited.
pub fn job_sessions(conn: &Connection, job_id: &str) -> Result<Vec<SessionIdentity>> {
    Ok(conn.prepare("SELECT source,session_id FROM delivery_session_members WHERE job_id=? ORDER BY source,session_id")?.query_map([job_id], |r| Ok(SessionIdentity {source:r.get(0)?, session_id:r.get(1)?}))?.collect::<rusqlite::Result<_>>()?)
}
/// Atomically add/remove one member. Repeated requests perform no writes.
/// Re-inclusion starts a fresh backfill. Global exclusions remain
/// authoritative; this API does not remove them. Membership is
/// account/instance scoped through its owning job.
pub fn set_job_session(
    conn: &Connection,
    job_id: &str,
    session: &SessionIdentity,
    include: bool,
) -> Result<bool> {
    if include {
        ensure_selectable(conn, session)?;
    }
    // A session's subagents follow it in the same transaction, so removing it
    // revokes them before delivery can send another of their records.
    let delegation = Delegation::of(conn, &selection_after(conn, job_id, session, include)?)?;
    let tx = write_transaction(conn)?;
    // The cutoff is read under the write lock, so no preparation can move the
    // job's position between it and the membership it bounds.
    let head = feed::head(conn)?.revision;
    let mut changed = set_job_session_in_transaction(&tx, job_id, session, include, head)?;
    if include {
        changed |= select_in_own_right(&tx, job_id, session)?;
    }
    changed |= delegation.apply(&tx, job_id, head)?;
    tx.commit()?;
    Ok(changed)
}

/// Include a session, lifting a global exclusion that withheld it. Consent,
/// membership and fencing commit together. Other affected jobs still require
/// a new generation before broadening access.
pub fn include_job_session(
    conn: &Connection,
    job_id: &str,
    session: &SessionIdentity,
) -> Result<bool> {
    ensure_selectable(conn, session)?;
    let delegation = Delegation::of(conn, &selection_after(conn, job_id, session, true)?)?;
    let tx = write_transaction(conn)?;
    let head = feed::head(conn)?.revision;
    let excluded: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=? AND session_id=?)",
        params![session.source, session.session_id],
        |r| r.get(0),
    )?;
    if excluded {
        // Validate the scoped job and retire any old membership before lifting
        // its exclusion. A failed guard rolls all of this back.
        set_job_session_in_transaction(&tx, job_id, session, false, head)?;
        set_session_excluded_in_transaction(&tx, session, false, Some(job_id))?;
    }
    let mut changed = set_job_session_in_transaction(&tx, job_id, session, true, head)?;
    changed |= select_in_own_right(&tx, job_id, session)?;
    changed |= delegation.apply(&tx, job_id, head)?;
    tx.commit()?;
    Ok(changed)
}

fn set_job_session_in_transaction(
    conn: &Connection,
    job_id: &str,
    session: &SessionIdentity,
    include: bool,
    head: u64,
) -> Result<bool> {
    ensure!(
        !session.source.is_empty() && !session.session_id.is_empty(),
        "invalid session identity"
    );
    let root = job(conn, job_id)?;
    ensure!(
        root.state != "cancelled" && is_session_job(conn, job_id)?,
        "active session job required"
    );
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM delivery_session_members WHERE job_id=? AND source=? AND session_id=?",
            params![job_id, session.source, session.session_id],
            |r| r.get(0),
        )
        .optional()?;
    if existing.is_some() == include {
        return Ok(false);
    }
    if let Some(id) = existing {
        conn.execute("DELETE FROM delivery_session_members WHERE id=?", [&id])?;
    } else {
        let id: String = conn.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        conn.execute(
            "INSERT INTO delivery_session_members(id,job_id,source,session_id,cutoff,cursor) VALUES (?,?,?,?,?,0)",
            params![id, job_id, session.source, session.session_id, feed::revision(head)?],
        )?;
    }
    // Invalidate dispatch authorization, but keep immutable pending work and
    // retry/failure state. Claim filters removed members' records.
    conn.execute(
        "UPDATE delivery_jobs SET fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE id=?",
        [job_id],
    )?;
    conn.execute(
        "UPDATE delivery_batches SET state='pending' WHERE job_id=? AND state='leased'",
        [job_id],
    )?;
    conn.execute(
        &format!("UPDATE delivery_session_jobs SET membership_seq=(SELECT MAX(seq) FROM delivery_batches WHERE job_id=?1) WHERE job_id=?1 AND EXISTS(SELECT 1 FROM delivery_batches WHERE job_id=?1 AND state IN {UNRESOLVED})"),
        [job_id],
    )?;
    Ok(true)
}

pub(super) fn cancel(conn: &Connection, job_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM delivery_session_members WHERE job_id=?",
        [job_id],
    )?;
    Ok(())
}

/// One member whose backfill has not reached its cutoff.
struct Backfill {
    id: String,
    identity: SessionIdentity,
    cutoff: i64,
    cursor: i64,
    phase: i64,
}
/// A member's backfill phase after its own session's changes (phase 0): the
/// relationships naming it as their child.
const INCOMING_EDGES: i64 = 1;

fn child(record: &HistoryExportRecord) -> Option<&str> {
    record
        .payload
        .get("child_session_id")
        .and_then(|value| value.as_str())
}

/// Which path of a session job sends a relationship.
#[derive(Debug, PartialEq, Eq)]
enum Sender {
    /// The parent's backfill.
    Parent,
    /// The child's backfill, reading the edges that name it.
    Child,
    /// The job following the feed.
    Feed,
}

/// Every member's cutoff and insertion order (its rowid), read once per
/// preparation. The preparation runs in one write transaction, so membership
/// cannot change under it, and the backfill moves only the members' cursors
/// and phases: one read serves every change the preparation examines, where
/// it used to query the member table per change and per edge.
struct Members(HashMap<(String, String), (i64, i64)>);
impl Members {
    fn read(conn: &Connection, job_id: &str) -> Result<Self> {
        let mut statement = conn.prepare(
            "SELECT source,session_id,cutoff,rowid FROM delivery_session_members WHERE job_id=?",
        )?;
        let members = statement
            .query_map([job_id], |r| {
                Ok(((r.get(0)?, r.get(1)?), (r.get(2)?, r.get(3)?)))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Self(members))
    }
    /// The member `session` of `source`, as its cutoff and rowid.
    fn added(&self, source: &str, session: Option<&str>) -> Option<(i64, i64)> {
        self.0
            .get(&(source.to_owned(), session?.to_owned()))
            .copied()
    }
}

/// The one path that sends an edge at feed `revision`, so an edge between two
/// members leaves exactly once. Written before the later of the two members
/// was added, it belongs to that member's backfill — the only reader that
/// examines it while both are members; written after, to the feed. Members
/// order by cutoff, then by when they were added: a member row's rowid
/// exceeds every other present row's when it is inserted. An edge with no
/// member child is the parent's, and consent withholds it when the child is
/// linked.
fn sender(members: &Members, record: &HistoryExportRecord, revision: i64) -> Sender {
    let added = |session: Option<&str>| members.added(&record.source, session);
    let parent = added(record.session_id.as_deref()).unwrap_or((i64::MAX, i64::MAX));
    let Some(child) = child(record).and_then(|child| added(Some(child))) else {
        return if revision > parent.0 {
            Sender::Feed
        } else {
            Sender::Parent
        };
    };
    if revision > parent.0.max(child.0) {
        Sender::Feed
    } else if child > parent {
        Sender::Child
    } else {
        Sender::Parent
    }
}

/// Whether every member's backfill has reached its cutoff.
pub(super) fn backfilled(conn: &Connection, job_id: &str) -> Result<bool> {
    Ok(!conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_session_members WHERE job_id=? AND bootstrap_done=0)",
        [job_id],
        |r| r.get::<_, bool>(0),
    )?)
}

/// The revisions a preparation must not admit again: those held by the
/// job's unresolved batches prepared before its last membership change
/// (`membership_seq`), including the batches that replaced them. Under one
/// membership no path reaches a change another path already passed, so
/// batches prepared since are not read. With none left, the change is
/// forgotten.
fn held_elsewhere(conn: &Connection, job_id: &str) -> Result<HashSet<String>> {
    #[derive(Deserialize)]
    struct Held {
        records: Vec<Revision>,
    }
    #[derive(Deserialize)]
    struct Revision {
        revision_id: String,
    }
    let changed: i64 = conn.query_row(
        "SELECT membership_seq FROM delivery_session_jobs WHERE job_id=?",
        [job_id],
        |r| r.get(0),
    )?;
    let mut held = HashSet::new();
    if changed == 0 {
        return Ok(held);
    }
    let mut statement = conn.prepare(&format!(
        "SELECT payload FROM delivery_batches WHERE job_id=? AND state IN {UNRESOLVED} AND {CLAIM_SEQ}<=?"
    ))?;
    let mut rows = statement.query(params![job_id, changed])?;
    let mut any = false;
    while let Some(row) = rows.next()? {
        any = true;
        let batch: Held = serde_json::from_str(&row.get::<_, String>(0)?)?;
        held.extend(batch.records.into_iter().map(|record| record.revision_id));
    }
    if !any {
        conn.execute(
            "UPDATE delivery_session_jobs SET membership_seq=0 WHERE job_id=?",
            [job_id],
        )?;
    }
    Ok(held)
}

/// Prepare one batch for a session job: backfill members round-robin, then follow the feed for every
/// member, within one scan budget. Member cursors and phases, the job's feed
/// position and the batch commit together in the caller's transaction.
pub(super) fn prepare(
    conn: &Connection,
    store: &SessionStore,
    origin: &feed::Origin,
    root: &Job,
    now_ms: i64,
) -> Result<PrepareResult> {
    let limits = &root.config.limits;
    let selection = &root.config.selection;
    let mut filling = Filling::new(batch_template(conn, root)?)?;
    let mut consent = Consent::new(conn, &root.id, selection)?;
    let members = Members::read(conn, &root.id)?;
    // Revisions an unresolved batch or this one holds.
    let mut held = held_elsewhere(conn, &root.id)?;
    let mut scanned = 0;
    let mut suppressed = 0;
    let mut full = false;
    // Admit one change's record, or report the batch full.
    let selects_relationships = selection.kinds.iter().any(|kind| kind == "relationship");
    let mut admit = |filling: &mut Filling,
                     record: HistoryExportRecord,
                     identity: &[serde_json::Value]|
     -> Result<bool> {
        let eligible = selected(
            selection,
            &record.kind,
            &record.source,
            record.session_id.as_deref(),
        );
        if !eligible {
            return Ok(true);
        }
        if !consent.admits(&RecordScope::of(&record))? {
            suppressed += 1;
            return Ok(true);
        }
        if held.contains(&record.revision_id) {
            return Ok(true);
        }
        let revision_id = record.revision_id.clone();
        match push_record(filling, record, identity, limits)? {
            Admitted::Added => {
                held.insert(revision_id);
                Ok(true)
            }
            Admitted::Full => Ok(false),
            Admitted::Suppressed => {
                suppressed += 1;
                Ok(true)
            }
        }
    };

    let mut last_member: String = conn.query_row(
        "SELECT last_member FROM delivery_session_jobs WHERE job_id=?",
        [&root.id],
        |r| r.get(0),
    )?;
    let next_backfill = |after: &str| -> Result<Option<Backfill>> {
        Ok(conn.query_row("SELECT id,source,session_id,cutoff,cursor,phase FROM delivery_session_members WHERE job_id=? AND bootstrap_done=0 AND id>? ORDER BY id LIMIT 1", params![root.id,after], |r| Ok(Backfill{id:r.get(0)?, identity:SessionIdentity{source:r.get(1)?, session_id:r.get(2)?}, cutoff:r.get(3)?, cursor:r.get(4)?, phase:r.get(5)?})).optional()?)
    };
    while !full
        && scanned < limits.max_scan_records
        && filling.batch.records.len() < limits.max_batch_records
    {
        let member = match next_backfill(&last_member)? {
            Some(member) => Some(member),
            None => next_backfill("")?,
        };
        let Some(mut member) = member else { break };
        let edges = member.phase == INCOMING_EDGES;
        let query = if edges {
            ChangeQuery::default().kinds([ChangeKind::Relationship])
        } else {
            feed::query(selection)?.session(&member.identity.source, &member.identity.session_id)
        };
        let mut changes = store.changes_since(
            origin.position(member.cursor),
            query.batch(limits.max_scan_records - scanned),
        )?;
        let mut done = false;
        while scanned < limits.max_scan_records
            && filling.batch.records.len() < limits.max_batch_records
        {
            let Some(change) = changes.next().transpose()? else {
                done = true;
                break;
            };
            let revision = feed::revision(change.revision)?;
            // Everything above the cutoff reaches the job through the feed.
            if revision > member.cutoff {
                done = true;
                break;
            }
            let record = record_from_change(origin, &change)?;
            let wanted = if edges {
                record.source == member.identity.source
                    && child(&record) == Some(member.identity.session_id.as_str())
                    && sender(&members, &record, revision) == Sender::Child
            } else {
                record.kind != "relationship"
                    || sender(&members, &record, revision) == Sender::Parent
            };
            if wanted && !admit(&mut filling, record, &change.key)? {
                full = true;
                break;
            }
            scanned += 1;
            member.cursor = revision;
        }
        // A finished own-changes phase moves on to the member's incoming
        // edges when the job sends relationships.
        let (phase, cursor, done) = if done && !edges && selects_relationships {
            (INCOMING_EDGES, 0, false)
        } else {
            (member.phase, member.cursor, done)
        };
        conn.execute(
            "UPDATE delivery_session_members SET cursor=?,phase=?,bootstrap_done=? WHERE id=?",
            params![cursor, phase, done, member.id],
        )?;
        last_member = member.id;
    }
    conn.execute(
        "UPDATE delivery_session_jobs SET last_member=? WHERE job_id=?",
        params![last_member, root.id],
    )?;

    // Follow the feed for every member, from the job's own position.
    let mut cursor = root.cursor;
    if !full
        && scanned < limits.max_scan_records
        && filling.batch.records.len() < limits.max_batch_records
    {
        let mut changes = store.changes_since(
            origin.position(cursor),
            feed::query(selection)?.batch(limits.max_scan_records - scanned),
        )?;
        while scanned < limits.max_scan_records
            && filling.batch.records.len() < limits.max_batch_records
        {
            let Some(change) = changes.next().transpose()? else {
                cursor = feed::revision(changes.head().revision)?;
                break;
            };
            let revision = feed::revision(change.revision)?;
            let cutoff = members
                .added(&change.source_name, Some(&change.session_id))
                .map(|(cutoff, _)| cutoff);
            // A member's changes up to its cutoff belong to its backfill, and
            // a session that is not a member is not this job's to send.
            if cutoff.is_some_and(|cutoff| revision > cutoff) {
                let record = record_from_change(origin, &change)?;
                let wanted = record.kind != "relationship"
                    || sender(&members, &record, revision) == Sender::Feed;
                if wanted && !admit(&mut filling, record, &change.key)? {
                    break;
                }
            }
            scanned += 1;
            cursor = revision;
        }
    }
    drop(consent);
    let batch = filling.batch;
    conn.execute("UPDATE delivery_jobs SET journal_cursor=?,suppressed_records=suppressed_records+? WHERE id=?",params![cursor,suppressed,root.id])?;
    let batch_id = if batch.records.is_empty() {
        None
    } else {
        insert_batch(conn, &batch, cursor, now_ms)?;
        Some(batch.batch_id)
    };
    Ok(PrepareResult {
        batch_id,
        scanned_records: scanned,
        bootstrap_complete: backfilled(conn, &root.id)?,
    })
}

/// Convert an all-sources job that shares only selected sessions into a
/// session job whose members are `members`, already authorized by the caller.
/// Pending batches stay and are rechecked at claim. Repeating is a no-op.
pub fn adopt_session_job(
    conn: &Connection,
    job_id: &str,
    members: &[SessionIdentity],
) -> Result<()> {
    let tx = write_transaction(conn)?;
    let head = feed::revision(feed::head(conn)?.revision)?;
    if is_session_job(&tx, job_id)? {
        tx.commit()?;
        return Ok(());
    }
    let root = job(&tx, job_id)?;
    ensure!(root.state != "cancelled", "cannot adopt cancelled job");
    ensure!(
        root.config.selection.all_sources,
        "legacy source policy cannot be adopted"
    );
    // The job's pending batches were prepared without membership.
    tx.execute(
        "INSERT INTO delivery_session_jobs(job_id,membership_seq) VALUES (?1,(SELECT COALESCE(MAX(seq),0) FROM delivery_batches WHERE job_id=?1))",
        [job_id],
    )?;
    for identity in members {
        let id: String = tx.query_row("SELECT lower(hex(randomblob(16)))", [], |r| r.get(0))?;
        tx.execute("INSERT OR IGNORE INTO delivery_session_members(id,job_id,source,session_id,cutoff,cursor) VALUES (?,?,?,?,?,0)",params![id,job_id,identity.source,identity.session_id,head])?;
    }
    tx.execute("UPDATE delivery_jobs SET journal_cursor=?,bootstrap_done=1,fence=fence+1,worker_id=NULL,lease_until_ms=NULL WHERE id=?",params![head,job_id])?;
    tx.execute(
        "UPDATE delivery_batches SET state='pending' WHERE job_id=? AND state='leased'",
        [job_id],
    )?;
    tx.commit()?;
    Ok(())
}

/// Indexed membership lookup for controls and paged UIs.
pub fn job_session_included(
    conn: &Connection,
    job_id: &str,
    session: &SessionIdentity,
) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM delivery_session_members WHERE job_id=? AND source=? AND session_id=?)",params![job_id,session.source,session.session_id],|r|r.get(0))?)
}
