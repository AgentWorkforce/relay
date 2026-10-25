//! Upload records from `ai-hist`'s change feed, and the origin state that
//! numbers them.
use super::*;
use ai_hist::{Change, ChangeKind, ChangeOp, ChangeQuery, SessionStore, StoreOptions, Watermark};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A read-only store over the database `conn` has open. A database written
/// before the shape this `ai-hist` reads is [`UpgradePending`], never migrated
/// here: the collector's [`open_db`] migrates it first.
pub(super) fn store(conn: &Connection) -> Result<SessionStore> {
    let path = conn
        .path()
        .filter(|path| !path.is_empty())
        .context("delivery needs a database file")?;
    let path = Path::new(path);
    if let Some(store) = READ_STORES.get(path, conn)? {
        return Ok(store);
    }
    let store = read_store(path)?;
    READ_STORES.insert(path, conn, store.clone())?;
    Ok(store)
}

/// A store handle holds only its path and options, but opening one read-only
/// checks the schema on a connection of its own, which costs a parse of the
/// whole schema, and delivery opened one for every status and every drain,
/// several a pass. Only a store that passed the check is kept, and a store
/// that is current stays current: migrations only move forward. A file
/// replaced at the path, or a schema changed since, is checked again.
static READ_STORES: SchemaCache<SessionStore> = SchemaCache::new();

/// Something learned about a database file's schema, kept for the process.
/// An entry holds while the file at that path is the same file, by its
/// identity on disk, and its schema is unchanged, by SQLite's schema cookie,
/// which every schema change moves; otherwise it is learned again. Where the
/// file's identity cannot be read, nothing is kept.
struct SchemaCache<T>(std::sync::Mutex<Vec<(PathBuf, SchemaStamp, T)>>);
/// A database file's identity on disk and its schema cookie.
type SchemaStamp = ((u64, u64), i64);
impl<T: Clone> SchemaCache<T> {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(Vec::new()))
    }
    /// What is kept for `path`, while `conn`, open on it, sees the file and
    /// schema it was kept for.
    fn get(&self, path: &Path, conn: &Connection) -> Result<Option<T>> {
        let Some(stamp) = schema_stamp(path, conn)? else {
            return Ok(None);
        };
        let entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Ok(entries
            .iter()
            .find(|(seen, at, _)| seen == path && *at == stamp)
            .map(|(_, _, value)| value.clone()))
    }
    fn insert(&self, path: &Path, conn: &Connection, value: T) -> Result<()> {
        let Some(stamp) = schema_stamp(path, conn)? else {
            return Ok(());
        };
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|(seen, _, _)| seen != path);
        entries.push((path.to_path_buf(), stamp, value));
        Ok(())
    }
}
fn schema_stamp(path: &Path, conn: &Connection) -> Result<Option<SchemaStamp>> {
    let Some(identity) = file_identity(path) else {
        return Ok(None);
    };
    let cookie: i64 = conn.query_row("PRAGMA schema_version", [], |row| row.get(0))?;
    Ok(Some((identity, cookie)))
}
#[cfg(unix)]
fn file_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.dev(), metadata.ino()))
}
#[cfg(not(unix))]
fn file_identity(_: &Path) -> Option<(u64, u64)> {
    None
}

fn read_store(path: &Path) -> Result<SessionStore> {
    let mut options = StoreOptions::default();
    options.db_path = Some(path.into());
    options.read_only = true;
    match SessionStore::open(options) {
        Err(error) if error.is_stale_schema() => Err(UpgradePending.into()),
        opened => Ok(opened?),
    }
}

/// Refuse a store an older build wrote, rather than migrate it. The store has
/// no public check for a pending migration, so this asks the reads uploads
/// depend on, which each refuse a store the upgrade has not reached: the
/// open, the identity listing and the feed, whose refusal is untyped and
/// recognized by the wording it names the remedy with.
pub(super) fn ensure_current(path: &Path) -> Result<()> {
    let store = read_store(path)?;
    match store.session_identities(ai_hist::IdentityQuery::default().limit(1)) {
        Err(error) if error.is_stale_schema() => return Err(UpgradePending.into()),
        listed => {
            listed?;
        }
    }
    match store.changes_since(Watermark::START, ChangeQuery::default().batch(1)) {
        Err(error) if error.message().contains("predates the change-feed schema") => {
            Err(UpgradePending.into())
        }
        drained => drained.map(drop).map_err(Into::into),
    }
}

/// The feed's head in the database `conn` has open.
pub(super) fn head(conn: &Connection) -> Result<Watermark> {
    Ok(store(conn)?.head_revision()?)
}

/// A feed revision as the probe stores it.
pub(super) fn revision(value: u64) -> Result<i64> {
    i64::try_from(value).context("feed revision out of range")
}

/// The drain for `selection`'s kinds, less any retired kind, which the store
/// may no longer name.
pub(super) fn query(selection: &ExportSelection) -> Result<ChangeQuery> {
    let kinds = selection
        .kinds
        .iter()
        .filter(|name| !RETIRED_KINDS.contains(&name.as_str()))
        .map(|name| {
            ChangeKind::ALL
                .iter()
                .copied()
                .find(|kind| kind.as_str() == name)
                .with_context(|| format!("unsupported evidence kind {name}"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ChangeQuery::default().kinds(kinds))
}

/// What names and numbers this install's records: its `origin_id`, and the
/// base added to every feed revision so each record's revision stays above
/// every revision this origin has issued.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Origin {
    pub origin_id: String,
    pub revision_base: i64,
    /// The feed epoch record revisions are numbered in; zero before the
    /// first batch is prepared.
    pub feed_epoch: u64,
    /// The highest revision any prepared batch holds.
    pub max_revision: i64,
}
impl Origin {
    pub(super) fn read(conn: &Connection) -> Result<Self> {
        conn.query_row(
            "SELECT origin_id,revision_base,feed_epoch,max_revision FROM delivery_origin WHERE singleton=1",
            [],
            |row| {
                Ok(Self {
                    origin_id: row.get(0)?,
                    revision_base: row.get(1)?,
                    feed_epoch: row.get::<_, i64>(2)? as u64,
                    max_revision: row.get(3)?,
                })
            },
        )
        .optional()?
        .context("delivery origin missing; open the store as its collector first")
    }

    /// Where a job at `cursor` resumes the feed.
    pub(super) fn position(&self, cursor: i64) -> Watermark {
        if cursor <= 0 {
            return Watermark::START;
        }
        Watermark {
            revision: cursor as u64,
            epoch: self.feed_epoch,
        }
    }

    /// Record that a batch holds revisions up to `revision`.
    pub(super) fn issued(conn: &Connection, revision: i64) -> Result<()> {
        conn.execute(
            "UPDATE delivery_origin SET max_revision=MAX(max_revision,?) WHERE singleton=1",
            [revision],
        )?;
        Ok(())
    }

    /// The origin as it numbers records against `store`'s feed, inside the
    /// caller's write transaction.
    ///
    /// Job positions and member cutoffs are revisions of the epoch the origin
    /// records. A new epoch of the same feed (`ai-hist` retiring a kind
    /// renumbers nothing) keeps them: the origin adopts it. Any other epoch —
    /// the first one adopted, or a replaced database whose revisions restart
    /// below ones already issued — makes them meaningless, so the base moves
    /// above the highest revision issued and every job restarts from the
    /// feed's start: the replacement's records supersede what the receiver
    /// holds rather than being ignored as stale.
    pub(super) fn align(conn: &Connection, store: &SessionStore) -> Result<Self> {
        let mut origin = Self::read(conn)?;
        let head = store.head_revision()?;
        if head.epoch == 0 || origin.feed_epoch == head.epoch {
            return Ok(origin);
        }
        if origin.feed_epoch != 0 && positions_continue(conn, store, origin.feed_epoch)? {
            origin.feed_epoch = head.epoch;
            conn.execute(
                "UPDATE delivery_origin SET feed_epoch=? WHERE singleton=1",
                [origin.feed_epoch as i64],
            )?;
            return Ok(origin);
        }
        origin.revision_base = origin.max_revision.max(origin.revision_base);
        restart_jobs(conn, head.revision)?;
        origin.feed_epoch = head.epoch;
        conn.execute(
            "UPDATE delivery_origin SET revision_base=?,feed_epoch=? WHERE singleton=1",
            params![origin.revision_base, origin.feed_epoch as i64],
        )?;
        Ok(origin)
    }
}

/// Whether every position the upload tables hold in `epoch` still names the
/// same revision of `store`'s feed, whose epoch has since changed: `ai-hist`
/// links the old epoch to the store's and nothing was renumbered or replaced
/// past the highest of them.
///
/// Asked of each kind's stream on its own. `ai-hist` resyncs a drain over
/// every kind across a retired kind, for a consumer that may hold the retired
/// kind's rows and relies on the replay to drop them. The probe stops draining
/// a retired kind itself ([`RETIRED_KINDS`](super::RETIRED_KINDS)), and a
/// replay would not remove what an older build sent of it from the receiver,
/// so for it only the numbering matters.
pub(super) fn positions_continue(
    conn: &Connection,
    store: &SessionStore,
    epoch: u64,
) -> Result<bool> {
    let highest: Option<i64> = conn.query_row(
        "SELECT MAX(p) FROM (
           SELECT MAX(journal_cursor,acknowledged_cursor) AS p FROM delivery_jobs WHERE state<>'cancelled'
           UNION ALL SELECT MAX(cursor,cutoff) FROM delivery_session_members
           UNION ALL SELECT journal_end FROM delivery_batches)",
        [],
        |row| row.get(0),
    )?;
    let from = Watermark {
        revision: highest.unwrap_or(0).max(0) as u64,
        epoch,
    };
    for kind in ChangeKind::ALL {
        if !store.resumes_from(from, &ChangeQuery::default().kinds([*kind]))? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Whether positions read in `feed_epoch` are positions in `store`'s feed at
/// `head`: the same epoch, none adopted yet, or [`positions_continue`].
fn same_feed(
    conn: &Connection,
    store: &SessionStore,
    feed_epoch: u64,
    head: Watermark,
) -> Result<bool> {
    Ok(feed_epoch == 0 || feed_epoch == head.epoch || positions_continue(conn, store, feed_epoch)?)
}

/// How many changes after a job's position `unqueued` examines, so status
/// stays cheap: callers only need to know whether work is waiting.
const UNQUEUED_SCAN: usize = 256;

/// Changes after a job's position that it will send: of its kinds and, for a
/// session job, a member's above that member's backfill cutoff. Counted
/// within the first `UNQUEUED_SCAN` changes; when more remain beyond them the
/// answer is at least one, since the job has yet to examine them. Zero for an
/// install whose uploads have not been rebuilt onto the feed yet.
pub(super) fn unqueued(
    conn: &Connection,
    selection: &ExportSelection,
    job_id: &str,
    cursor: i64,
    scoped: bool,
) -> Result<i64> {
    let Ok(origin) = Origin::read(conn) else {
        return Ok(0);
    };
    let store = store(conn)?;
    let head = store.head_revision()?;
    let from = if !same_feed(conn, &store, origin.feed_epoch, head)? {
        // A replaced database: the next preparation restarts the job.
        Watermark::START
    } else if cursor <= 0 {
        Watermark::START
    } else {
        Watermark {
            revision: cursor as u64,
            epoch: head.epoch,
        }
    };
    if from.revision > head.revision {
        return Ok(0);
    }
    let mut unqueued = 0;
    let mut examined = 0;
    for change in store
        .changes_since(from, query(selection)?.batch(UNQUEUED_SCAN))?
        .take(UNQUEUED_SCAN + 1)
    {
        let change = change?;
        examined += 1;
        if examined > UNQUEUED_SCAN {
            return Ok(unqueued.max(1));
        }
        let sent = !scoped
            || conn
                .query_row(
                    "SELECT cutoff FROM delivery_session_members WHERE job_id=? AND source=? AND session_id=?",
                    params![job_id, change.source_name, change.session_id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .is_some_and(|cutoff| revision(change.revision).is_ok_and(|rev| rev > cutoff));
        if sent {
            unqueued += 1;
        }
    }
    Ok(unqueued)
}

/// Where a job stood when a session listing began: its position, each
/// member's cutoff and backfill state, and the feed epoch its positions are
/// numbered in. Read in one transaction before the listing reads pending
/// batches, so a batch prepared in between is either among those batches or
/// still ahead of these positions, never neither.
pub struct UploadPositions {
    selection: ExportSelection,
    cursor: i64,
    scoped: bool,
    /// Every member, with its cutoff, whether its backfill finished, and the
    /// row order that, with its cutoff, says which backfill owns an edge.
    members: HashMap<SessionIdentity, Member>,
    /// The origin's feed epoch, or `None` before uploads were rebuilt onto the
    /// feed.
    feed_epoch: Option<u64>,
    /// What a cached answer was proven against: the job, its generation, its
    /// selection, its members and the stored exclusions, read in the same
    /// transaction. Any change to one of them can change what the job sends.
    basis: String,
}

#[derive(Clone, Copy)]
struct Member {
    cutoff: i64,
    backfilled: bool,
    rowid: i64,
}

impl UploadPositions {
    /// Whether the job shares only its members.
    pub fn scoped(&self) -> bool {
        self.scoped
    }
    /// Whether `session` was a member when the positions were read.
    pub fn member(&self, session: &SessionIdentity) -> bool {
        self.members.contains_key(session)
    }
}

pub(super) fn upload_positions(conn: &Connection, job_id: &str) -> Result<UploadPositions> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    let job = job(&tx, job_id)?;
    let scoped = is_session_job(&tx, job_id)?;
    let mut members = HashMap::new();
    if scoped {
        let mut rows = tx.prepare(
            "SELECT source,session_id,cutoff,bootstrap_done,rowid FROM delivery_session_members WHERE job_id=?",
        )?;
        for row in rows.query_map([job_id], |r| {
            Ok((
                SessionIdentity {
                    source: r.get(0)?,
                    session_id: r.get(1)?,
                },
                Member {
                    cutoff: r.get(2)?,
                    backfilled: r.get(3)?,
                    rowid: r.get(4)?,
                },
            ))
        })? {
            let (identity, member) = row?;
            members.insert(identity, member);
        }
    }
    let feed_epoch = Origin::read(&tx).ok().map(|origin| origin.feed_epoch);
    let basis = basis(&tx, job_id, &job, &members)?;
    tx.commit()?;
    Ok(UploadPositions {
        selection: job.config.selection,
        cursor: job.cursor,
        scoped,
        members,
        feed_epoch,
        basis,
    })
}

/// A digest of everything besides the feed that decides what `job` sends:
/// its identity, generation and selection, each member's cutoff, backfill
/// state and row, and every stored exclusion.
fn basis(
    tx: &Transaction,
    job_id: &str,
    job: &Job,
    members: &HashMap<SessionIdentity, Member>,
) -> Result<String> {
    let mut digest = Sha256::new();
    digest.update(job_id.as_bytes());
    digest.update(job.generation.to_le_bytes());
    digest.update(serde_json::to_vec(&job.config.selection)?);
    let mut sorted: Vec<_> = members.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    for (identity, member) in sorted {
        digest.update(serde_json::to_vec(&(
            identity,
            member.cutoff,
            member.backfilled,
            member.rowid,
        ))?);
    }
    let mut rows =
        tx.prepare("SELECT source,session_id FROM delivery_exclusions ORDER BY source,session_id")?;
    let mut rows = rows.query([])?;
    while let Some(row) = rows.next()? {
        digest.update(serde_json::to_vec(&(
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
        ))?);
    }
    Ok(format!("{:x}", digest.finalize()))
}

/// How long a session listing reads the feed before counting the sessions it
/// has not reached as waiting, so a session listing stays well inside the
/// desktop's timeout on a large store.
pub(super) const UNSENT_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

/// Which of `sessions` the job may still send something for, as of
/// `positions`: for an all-sources job, a change of its kinds past its
/// position; for a session job, a member still backfilling, one of its changes
/// past both the job's position and its cutoff, or a relationship it parents
/// that a member still backfilling owns, since that child's backfill sends the
/// edge. When the job sends relationships, one the session is the child of,
/// changed past its position, counts too: it is stored under its parent. Each
/// session is one indexed read of its own changes, and of the edges naming
/// it. A
/// session not reached within `UNSENT_BUDGET`, and every session when the
/// feed cannot be read, counts as waiting: nothing proves it sent.
pub(super) fn unsent_sessions(
    conn: &Connection,
    positions: &UploadPositions,
    sessions: &[SessionIdentity],
) -> Result<HashSet<SessionIdentity>> {
    let everything = || sessions.iter().cloned().collect();
    let Some(feed_epoch) = positions.feed_epoch else {
        return Ok(everything());
    };
    let store = store(conn)?;
    let head = store.head_revision()?;
    if !same_feed(conn, &store, feed_epoch, head)? {
        // A replaced database: the next preparation restarts the job.
        return Ok(everything());
    }
    let deadline = std::time::Instant::now() + UNSENT_BUDGET;
    let (mut waiting, unreached) = check_each(conn, &store, head, positions, sessions, deadline)?;
    waiting.extend(unreached);
    Ok(waiting)
}

/// One session at a time, each one indexed read of its own changes and of the
/// edges naming it, until `deadline`: the sessions the job may still send
/// something for, and the sessions not reached in time.
fn check_each(
    conn: &Connection,
    store: &SessionStore,
    head: Watermark,
    positions: &UploadPositions,
    sessions: &[SessionIdentity],
    deadline: std::time::Instant,
) -> Result<(HashSet<SessionIdentity>, HashSet<SessionIdentity>)> {
    let edges = sends_edges(positions);
    let mut waiting = HashSet::new();
    let mut unreached = HashSet::new();
    for session in sessions {
        if std::time::Instant::now() >= deadline {
            unreached.insert(session.clone());
            continue;
        }
        let mut from = positions.cursor;
        if positions.scoped {
            match positions.members.get(session) {
                // Not a member when the positions were read: nothing proves
                // the job has sent a session it may have just started to.
                None => {
                    waiting.insert(session.clone());
                    continue;
                }
                Some(member) if !member.backfilled => {
                    waiting.insert(session.clone());
                    continue;
                }
                Some(member) => from = from.max(member.cutoff),
            }
            if edges && owes_an_edge_to_a_backfill(conn, positions, session)? {
                waiting.insert(session.clone());
                continue;
            }
        }
        let from = if from <= 0 {
            Watermark::START
        } else {
            Watermark {
                revision: from as u64,
                epoch: head.epoch,
            }
        };
        if from.revision >= head.revision {
            continue;
        }
        let query = query(&positions.selection)?
            .session(session.source.clone(), session.session_id.clone())
            .batch(DRAIN_PAGE);
        match drain_sends(
            conn,
            store.changes_since(from, query)?,
            positions,
            session,
            deadline,
        )? {
            Drain::Sends => {
                waiting.insert(session.clone());
            }
            Drain::OutOfTime => {
                unreached.insert(session.clone());
            }
            Drain::Settled => {
                if edges && names_as_child_since(conn, positions, session, from.revision)? {
                    waiting.insert(session.clone());
                }
            }
        }
    }
    Ok((waiting, unreached))
}

fn sends_edges(positions: &UploadPositions) -> bool {
    positions
        .selection
        .kinds
        .iter()
        .any(|kind| kind == ChangeKind::Relationship.as_str())
}

/// Sessions a listing has proven uploaded, each with the feed head through
/// which nothing was left for the job to send, and the basis that proof holds
/// for. Kept beside the store so the next listing checks only what changed
/// since; a proof is dropped when its basis changes or the job's position
/// moves back.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StatusCache {
    #[serde(default)]
    basis: String,
    #[serde(default)]
    feed_epoch: u64,
    #[serde(default)]
    cursor: i64,
    /// `source` and session id joined by a NUL, which neither contains.
    #[serde(default)]
    uploaded: HashMap<String, u64>,
}

/// How many proofs a cache keeps: enough for every session a desktop lists.
const CACHE_LIMIT: usize = 20_000;

fn cache_key(session: &SessionIdentity) -> String {
    format!("{}\0{}", session.source, session.session_id)
}

/// What a session listing may say about each settled session.
pub struct SessionStates {
    /// The job may still send something for these.
    pub waiting: HashSet<SessionIdentity>,
    /// Not decided before the listing's budget ran out.
    pub unknown: HashSet<SessionIdentity>,
    /// Proofs to keep for the next listing.
    pub cache: StatusCache,
}

/// How far behind the feed head a single scan of every session's changes may
/// start and still be cheaper than one indexed read per session.
const SCAN_LIMIT: u64 = 100_000;

/// The upload state of `sessions`, none of them in a batch pending since
/// `positions` was read, deciding as many as the budget allows. A session
/// `cache` proved uploaded through a head nothing of it has changed since
/// stays uploaded without being read again. The rest are decided by one scan
/// of the feed from the job's position when that is short, or one indexed
/// read each. A session left undecided is unknown, never uploaded.
pub(super) fn session_states(
    conn: &Connection,
    positions: &UploadPositions,
    sessions: &[SessionIdentity],
    cache: StatusCache,
) -> Result<SessionStates> {
    session_states_within(conn, positions, sessions, cache, UNSENT_BUDGET)
}

/// [`session_states`] within `budget`.
pub(super) fn session_states_within(
    conn: &Connection,
    positions: &UploadPositions,
    sessions: &[SessionIdentity],
    mut cache: StatusCache,
    budget: std::time::Duration,
) -> Result<SessionStates> {
    let all_waiting = || SessionStates {
        waiting: sessions.iter().cloned().collect(),
        unknown: HashSet::new(),
        cache: StatusCache::default(),
    };
    let Some(feed_epoch) = positions.feed_epoch else {
        return Ok(all_waiting());
    };
    let store = store(conn)?;
    let head = store.head_revision()?;
    if !same_feed(conn, &store, feed_epoch, head)? {
        // A replaced database: the next preparation restarts the job.
        return Ok(all_waiting());
    }
    let deadline = std::time::Instant::now() + budget;
    if cache.basis != positions.basis
        || cache.feed_epoch != head.epoch
        || cache.cursor > positions.cursor
    {
        cache = StatusCache::default();
    }
    cache.basis = positions.basis.clone();
    cache.feed_epoch = head.epoch;
    cache.cursor = positions.cursor;

    let mut uploaded = Vec::new();
    let mut waiting = HashSet::new();
    let mut unknown = HashSet::new();
    let mut rest = Vec::new();
    let mut proven = Vec::new();
    for session in sessions {
        match cache.uploaded.get(&cache_key(session)) {
            Some(&through) => proven.push((session, through)),
            None => rest.push(session.clone()),
        }
    }
    // Proofs first: one scan from the oldest proof finds every session that
    // changed since its own.
    if let Some(oldest) = proven.iter().map(|(_, through)| *through).min() {
        let scan = if oldest >= head.revision {
            Some(HashMap::new())
        } else if head.revision - oldest <= SCAN_LIMIT {
            touched_since(
                conn,
                &store,
                head,
                positions,
                oldest as i64,
                half_left(deadline),
            )?
        } else {
            None
        };
        for (session, through) in proven {
            let changed = scan
                .as_ref()
                .map(|touched| touched.get(session).is_some_and(|&last| last > through));
            match changed {
                // Unchanged since its proof, which still holds.
                Some(false) => uploaded.push(session.clone()),
                // A change the job may not have sent yet: read it again.
                Some(true) | None => rest.push(session.clone()),
            }
        }
    }
    // An all-sources job: one scan from its position decides every session.
    if !positions.scoped && !rest.is_empty() {
        let from = positions.cursor.max(0) as u64;
        let scan = if from >= head.revision {
            Some(HashMap::new())
        } else if head.revision - from <= SCAN_LIMIT {
            touched_since(
                conn,
                &store,
                head,
                positions,
                from as i64,
                half_left(deadline),
            )?
        } else {
            None
        };
        if let Some(touched) = scan {
            for session in std::mem::take(&mut rest) {
                if touched.contains_key(&session) {
                    waiting.insert(session);
                } else {
                    uploaded.push(session);
                }
            }
        }
    }
    let (sends, unreached) = check_each(conn, &store, head, positions, &rest, deadline)?;
    for session in rest {
        if unreached.contains(&session) {
            unknown.insert(session);
        } else if !sends.contains(&session) {
            uploaded.push(session);
        }
    }
    waiting.extend(sends);
    for session in &waiting {
        cache.uploaded.remove(&cache_key(session));
    }
    if cache.uploaded.len() + uploaded.len() > CACHE_LIMIT {
        cache.uploaded.clear();
    }
    for session in &uploaded {
        cache.uploaded.insert(cache_key(session), head.revision);
    }
    Ok(SessionStates {
        waiting,
        unknown,
        cache,
    })
}

/// Half of what is left before `deadline`, so a scan that runs out of time
/// still leaves room to read sessions one at a time.
fn half_left(deadline: std::time::Instant) -> std::time::Instant {
    let now = std::time::Instant::now();
    now + deadline.saturating_duration_since(now) / 2
}

/// Every session with a change of the job's kinds after `from`, up to `head`,
/// with its latest such revision, or `None` if `deadline` passed first. For an
/// all-sources job this is exactly what the job still sends past its position:
/// an edge is withheld when consent withholds either session it names, and
/// otherwise counts for its parent and its child. A session job's rules for
/// edges depend on each member's backfill, so there every edge counts for both
/// sessions and each is read again on its own.
fn touched_since(
    conn: &Connection,
    store: &SessionStore,
    head: Watermark,
    positions: &UploadPositions,
    from: i64,
    deadline: std::time::Instant,
) -> Result<Option<HashMap<SessionIdentity, u64>>> {
    let from = if from <= 0 {
        Watermark::START
    } else {
        Watermark {
            revision: from as u64,
            epoch: head.epoch,
        }
    };
    let query = query(&positions.selection)?.batch(ai_hist::MAX_CHANGE_BATCH);
    let mut touched: HashMap<SessionIdentity, u64> = HashMap::new();
    let mut consent: HashMap<SessionIdentity, bool> = HashMap::new();
    let mut withheld = |source: &str, session: &str| -> Result<bool> {
        let identity = SessionIdentity {
            source: source.to_owned(),
            session_id: session.to_owned(),
        };
        if let Some(&value) = consent.get(&identity) {
            return Ok(value);
        }
        let value = excluded(conn, &positions.selection, source, Some(session))?;
        consent.insert(identity, value);
        Ok(value)
    };
    let mut touch = |source: &str, session: &str, revision: u64| {
        let entry = touched
            .entry(SessionIdentity {
                source: source.to_owned(),
                session_id: session.to_owned(),
            })
            .or_insert(0);
        *entry = (*entry).max(revision);
    };
    for change in store.changes_since(from, query)? {
        if std::time::Instant::now() >= deadline {
            return Ok(None);
        }
        let change = change?;
        if change.revision > head.revision {
            break;
        }
        if change.session_id.is_empty() {
            continue;
        }
        let source = change.source_name.as_str();
        let child = (change.kind == ChangeKind::Relationship)
            .then(|| {
                change
                    .columns
                    .as_ref()
                    .and_then(|row| row.get("child_session_id"))
                    .and_then(Value::as_str)
            })
            .flatten();
        if let Some(child) = child {
            if !positions.scoped
                && (withheld(source, child)? || withheld(source, &change.session_id)?)
            {
                continue;
            }
            touch(source, child, change.revision);
        }
        touch(source, &change.session_id, change.revision);
    }
    Ok(Some(touched))
}

/// How many of a session's changes one page of its drain reads. The drain
/// pages on while it steps over relationships the job does not send from it,
/// until the listing's deadline.
const DRAIN_PAGE: usize = 16;

/// What a drain of one session's changes found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Drain {
    /// A change the job will still send.
    Sends,
    /// Nothing the job still sends.
    Settled,
    /// The deadline passed before either was proven.
    OutOfTime,
}

/// Whether `changes`, a drain of one session's changes past the job's
/// position, holds one the job will still send. A session job steps over a
/// relationship that path does not send: one a finished backfill owns (by
/// `sessions::sender`'s rule) and so already sent, and one naming a linked
/// child that is not a member. Any job steps over an edge naming an excluded
/// child, which consent withholds.
fn drain_sends(
    conn: &Connection,
    changes: ai_hist::Changes,
    positions: &UploadPositions,
    session: &SessionIdentity,
    deadline: std::time::Instant,
) -> Result<Drain> {
    for change in changes {
        // Out of time before proving the rest withheld: undecided.
        if std::time::Instant::now() >= deadline {
            return Ok(Drain::OutOfTime);
        }
        let change = change?;
        if change.kind != ChangeKind::Relationship {
            return Ok(Drain::Sends);
        }
        let child = change
            .columns
            .as_ref()
            .and_then(|row| row.get("child_session_id"))
            .and_then(Value::as_str);
        let Some(child) = child else {
            // A delete, or an edge with no child: the parent sends it.
            return Ok(Drain::Sends);
        };
        // Consent withholds an edge that discloses an excluded child.
        if excluded(conn, &positions.selection, &session.source, Some(child))? {
            continue;
        }
        if !positions.scoped {
            return Ok(Drain::Sends);
        }
        let child = positions.members.get(&SessionIdentity {
            source: session.source.clone(),
            session_id: child.to_owned(),
        });
        let Some(child) = child else {
            continue;
        };
        let Some(parent) = positions.members.get(session) else {
            return Ok(Drain::Sends);
        };
        // The parent's own backfill is finished here, so an edge it owns was
        // sent too; only a feed-owned edge is still to come.
        if !sent_by_finished_backfill(parent, child, revision(change.revision)?) {
            return Ok(Drain::Sends);
        }
    }
    Ok(Drain::Settled)
}

/// Whether a relationship naming `child`, one the job can still send, changed
/// after `revision`. It is stored under its parent, so the child's own drain
/// does not see it, yet it discloses the child and marks it pending once it
/// is in a batch. A session job sends an edge only between two members, and
/// one written no later than both members' cutoffs belongs to the later-added
/// member's backfill: once that backfill finished, the edge has been sent.
fn names_as_child_since(
    conn: &Connection,
    positions: &UploadPositions,
    child: &SessionIdentity,
    revision: u64,
) -> Result<bool> {
    let mut edges = conn.prepare_cached(
        "SELECT parent_session_id,revision FROM session_relationships WHERE source=? AND child_session_id=? AND revision>?",
    )?;
    let mut rows = edges.query(params![child.source, child.session_id, revision as i64])?;
    while let Some(row) = rows.next()? {
        let parent: String = row.get(0)?;
        // Consent withholds an edge stored under an excluded parent.
        if excluded(conn, &positions.selection, &child.source, Some(&parent))? {
            continue;
        }
        if !positions.scoped {
            return Ok(true);
        }
        let parent = positions.members.get(&SessionIdentity {
            source: child.source.clone(),
            session_id: parent,
        });
        let (Some(parent), Some(child)) = (parent, positions.members.get(child)) else {
            continue;
        };
        if !sent_by_finished_backfill(parent, child, row.get(1)?) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether the backfill that owns an edge between `parent` and `child`, by
/// `sessions::sender`'s rule, has finished: an edge written no later than both
/// members' cutoffs is the later-added member's to send.
fn sent_by_finished_backfill(parent: &Member, child: &Member, revision: i64) -> bool {
    if revision > parent.cutoff.max(child.cutoff) {
        return false;
    }
    let owner = if (child.cutoff, child.rowid) > (parent.cutoff, parent.rowid) {
        child
    } else {
        parent
    };
    owner.backfilled
}

/// Whether a relationship `parent` stores is one a member still backfilling
/// will send: by `sessions::sender`'s rule, an edge written no later than both
/// members' cutoffs belongs to the later-added member's backfill, and the
/// later-added one is here the child. That edge can leave after the parent's
/// own changes are all acknowledged.
fn owes_an_edge_to_a_backfill(
    conn: &Connection,
    positions: &UploadPositions,
    parent: &SessionIdentity,
) -> Result<bool> {
    let Some(owner) = positions.members.get(parent) else {
        return Ok(false);
    };
    // Filtering in the query would steer the planner off the parent index.
    let mut edges = conn.prepare_cached(
        "SELECT child_session_id,revision FROM session_relationships WHERE source=? AND parent_session_id=?",
    )?;
    let mut rows = edges.query(params![parent.source, parent.session_id])?;
    while let Some(row) = rows.next()? {
        let Some(child) = row.get::<_, Option<String>>(0)? else {
            continue;
        };
        let revision: i64 = row.get(1)?;
        let child = positions.members.get(&SessionIdentity {
            source: parent.source.clone(),
            session_id: child,
        });
        let Some(child) = child.filter(|child| !child.backfilled) else {
            continue;
        };
        let added_later = (child.cutoff, child.rowid) > (owner.cutoff, owner.rowid);
        if added_later && revision <= owner.cutoff.max(child.cutoff) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Restart every live job from the feed's start: an all-sources job drains
/// it again, and a session job backfills each member again from the start
/// while following the feed from `head`. Unsent batches, which hold the
/// records of the positions being discarded, go with them, settled receipts
/// no longer mark a position, and every claim is fenced.
pub(super) fn restart_jobs(conn: &Connection, head: u64) -> Result<()> {
    let head = revision(head)?;
    conn.execute(
        "DELETE FROM delivery_batches WHERE state IN ('pending','leased','retry_wait','blocked')",
        [],
    )?;
    // Settled receipts stay, but the feed positions they end at belong to
    // the numbering being discarded: the acknowledged position, which moves
    // through receipts' ends, must not pick one up again.
    conn.execute(
        "UPDATE delivery_batches SET journal_end=0 WHERE state IN ('acknowledged','suppressed','cancelled')",
        [],
    )?;
    conn.execute(
        "UPDATE delivery_jobs SET acknowledged_cursor=0,fence=fence+1,worker_id=NULL,lease_until_ms=NULL,attempts=0,next_attempt_ms=0 WHERE state<>'cancelled'",
        [],
    )?;
    conn.execute("UPDATE delivery_session_jobs SET last_member=''", [])?;
    conn.execute(
        "UPDATE delivery_jobs SET journal_cursor=0,bootstrap_done=0 WHERE state<>'cancelled' AND id NOT IN (SELECT job_id FROM delivery_session_jobs)",
        [],
    )?;
    conn.execute(
        "UPDATE delivery_jobs SET journal_cursor=?1,bootstrap_done=1 WHERE state<>'cancelled' AND id IN (SELECT job_id FROM delivery_session_jobs)",
        [head],
    )?;
    conn.execute(
        "UPDATE delivery_session_members SET cutoff=?1,cursor=0,phase=0,bootstrap_done=0",
        [head],
    )?;
    Ok(())
}

/// The upload record for one feed change.
///
/// `record_id` is the SHA-256 of the change's key — its kind, then the stored
/// value of each column of its table's identity — as compact JSON: the same
/// text SQLite's `json_array` gives the export journal's key, so a record
/// keeps its identity at the receiver. `payload` is the row as stored,
/// `null` for a delete.
pub(super) fn record_from_change(origin: &Origin, change: &Change) -> Result<HistoryExportRecord> {
    let record_id = hash(serde_json::to_string(&change.key)?);
    let revision = origin
        .revision_base
        .checked_add(revision(change.revision)?)
        .context("record revision out of range")?;
    let (operation, payload) = match &change.op {
        ChangeOp::Delete => ("delete", Value::Null),
        _ => (
            "upsert",
            Value::Object(
                change
                    .columns
                    .as_ref()
                    .context("feed upsert without its stored row")?
                    .iter()
                    .map(|(name, value)| (name.to_owned(), value.clone()))
                    .collect(),
            ),
        ),
    };
    Ok(HistoryExportRecord {
        schema_version: EXPORT_SCHEMA_VERSION,
        origin_id: origin.origin_id.clone(),
        revision_id: hash(format!("{}:{record_id}:{revision}", origin.origin_id)),
        record_id,
        revision,
        kind: change.kind.as_str().into(),
        source: change.source_name.clone(),
        session_id: (!change.session_id.is_empty()).then(|| change.session_id.clone()),
        operation: operation.into(),
        payload,
    })
}
